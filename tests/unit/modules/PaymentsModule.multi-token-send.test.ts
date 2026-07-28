/**
 * Multi-token single-send — latency characterization (fully isolated).
 *
 * Scenario: the wallet holds TOKEN_COUNT × 1-unit tokens and sends TOKEN_COUNT
 * units in ONE send(), so the plan is TOKEN_COUNT whole-token direct transfers
 * (no split). Engine certifications and transport deliveries pay simulated
 * network latency on a deterministic VIRTUAL clock: the test runs in real
 * milliseconds but measures virtual wall-clock, so the sequential/parallel
 * shape of the send pipeline is asserted exactly and improvements are
 * measurable.
 *
 * The send pipeline certifies operations CONCURRENTLY in batches of
 * MAX_SEND_OPERATION_CONCURRENCY (the 'parallel' test asserts the exact
 * timing shape). Correctness invariants in the first test are
 * implementation-independent and must always pass unchanged.
 * (Sequential-era baseline, for the record: maxConcurrent=1, 110,000 ms.)
 *
 * The fail-fast scenario pins the between-batch early exit: a failed op stops
 * further batches from launching (in-flight siblings still settle), so an
 * outage surfaces after one batch, not ceil(N/MAX) op-timeouts.
 *
 * Harness mirrors PaymentsModule.v2-send-recovery.test.ts (no SDK vi.mock).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createPaymentsModule, type PaymentsModuleDependencies } from '../../../modules/payments/PaymentsModule';
import { MAX_SEND_OPERATION_CONCURRENCY } from '../../../modules/payments/SendOperations';
import type { FullIdentity, TransferResult } from '../../../types';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase, HistoryRecord } from '../../../storage';
import type { EngineOpOptions, SphereToken, SplitParams, SplitResult, TransferParams } from '../../../token-engine';
import { TransferConflictError } from '../../../token-engine';
import { FakeTokenEngine } from '../token-engine/FakeTokenEngine';
import { decodeTokenBlob, encodeTokenBlob } from '../../../token-engine/token-blob';
import { bytesToHex, hexToBytes } from '../../../core/crypto';
import type { V2TransferPayload } from '../../../types/v2-transfer';

// ── Scenario ─────────────────────────────────────────────────────────────────

const TOKEN_COUNT = 100;
const AMOUNT_EACH = 1n;

/** Simulated network latency (virtual ms). */
const PUBLISH_RTT_MS = 50; // submit-transaction / delivery round trip
const PROOF_WAIT_MS = 1000; // aggregator inclusion-proof wait

const CERTIFY_MS = PUBLISH_RTT_MS + PROOF_WAIT_MS; // one engine.transfer/split
const DELIVER_MS = PUBLISH_RTT_MS; // one transport delivery

const FAKE_PRIVATE_KEY = 'a'.repeat(64);
const FAKE_PUBKEY = '02' + 'b'.repeat(64);
const SENDER_TRANSPORT_PUBKEY = 'cc'.repeat(32);
const UCT = '11'.repeat(32);
const BOB_CHAIN_PUBKEY = '02' + 'ee'.repeat(32);

// ── Simulation domain ────────────────────────────────────────────────────────

/**
 * Deterministic virtual clock. wait(ms) blocks the caller on virtual time;
 * time jumps to the earliest due waiter only once the event loop drains, i.e.
 * when every in-flight operation is blocked on the clock. Concurrent waits
 * therefore overlap in virtual time exactly as real network waits would.
 */
class VirtualClock {
  private nowMs = 0;
  private waiters: { dueMs: number; wake: () => void }[] = [];
  private pumpScheduled = false;

  now(): number {
    return this.nowMs;
  }

  wait(ms: number): Promise<void> {
    return new Promise((wake) => {
      this.waiters.push({ dueMs: this.nowMs + ms, wake });
      this.schedulePump();
    });
  }

  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    setTimeout(() => {
      this.pumpScheduled = false;
      this.advanceToEarliest();
    }, 0);
  }

  private advanceToEarliest(): void {
    if (this.waiters.length === 0) return;
    this.nowMs = Math.max(this.nowMs, Math.min(...this.waiters.map((w) => w.dueMs)));
    const due = this.waiters.filter((w) => w.dueMs <= this.nowMs);
    this.waiters = this.waiters.filter((w) => w.dueMs > this.nowMs);
    for (const w of due) w.wake();
    if (this.waiters.length > 0) this.schedulePump();
  }
}

/** Records how many tracked operations overlap in (virtual) time. */
class ConcurrencyGauge {
  private active = 0;
  count = 0;
  maxConcurrent = 0;

  async track<T>(op: () => Promise<T>): Promise<T> {
    this.count += 1;
    this.active += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.active);
    try {
      return await op();
    } finally {
      this.active -= 1;
    }
  }
}

/**
 * FakeTokenEngine whose on-chain ops pay simulated network latency:
 * a certification = one publish round trip + one inclusion-proof wait.
 */
class SimulatedNetworkEngine extends FakeTokenEngine {
  constructor(
    private readonly clock: VirtualClock,
    private readonly certifications: ConcurrencyGauge,
    /** Op whose submit fails after the publish round trip (never certifies). */
    private readonly failAtOpIndex?: number,
  ) {
    super();
  }

  override transfer(params: TransferParams, options?: EngineOpOptions): Promise<SphereToken> {
    return this.certifications.track(async () => {
      if (this.failAtOpIndex !== undefined && options?.opIndex === this.failAtOpIndex) {
        await this.clock.wait(PUBLISH_RTT_MS);
        throw new Error('simulated submit failure');
      }
      await this.certify();
      return super.transfer(params, options);
    });
  }

  override split(params: SplitParams, options?: EngineOpOptions): Promise<SplitResult> {
    return this.certifications.track(async () => {
      await this.certify();
      return super.split(params, options);
    });
  }

  private async certify(): Promise<void> {
    await this.clock.wait(PUBLISH_RTT_MS);
    await this.clock.wait(PROOF_WAIT_MS);
    this.certifyEndMs.push(this.clock.now());
  }

  /** Virtual-clock completion time of every successful certification (#699 hoisting pin). */
  readonly certifyEndMs: number[] = [];
}

// ── Harness (mirrors PaymentsModule.v2-send-recovery.test.ts) ────────────────

function mockIdentity(): FullIdentity {
  return {
    chainPubkey: FAKE_PUBKEY, directAddress: 'DIRECT://x',
    privateKey: FAKE_PRIVATE_KEY, transportPubkey: 'dd'.repeat(32),
  };
}

function mockStorage(): StorageProvider {
  const s = new Map<string, string>();
  return {
    id: 's', name: 's', type: 'local', connect: vi.fn(), disconnect: vi.fn(),
    isConnected: () => true, getStatus: () => 'connected', setIdentity: vi.fn(),
    get: vi.fn(async (k: string) => s.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { s.set(k, v); }),
    remove: vi.fn(async (k: string) => { s.delete(k); }),
    has: vi.fn(async (k: string) => s.has(k)),
    keys: vi.fn(async () => [...s.keys()]),
    clear: vi.fn(async () => { s.clear(); }),
  } as unknown as StorageProvider;
}

function mockTokenStorage(): TokenStorageProvider<TxfStorageDataBase> {
  let lastSaved: TxfStorageDataBase | null = null;
  const history = new Map<string, HistoryRecord>();
  return {
    id: 'ts', name: 'ts', type: 'local',
    connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: () => true, getStatus: () => 'connected', setIdentity: vi.fn(),
    initialize: vi.fn().mockResolvedValue(true), shutdown: vi.fn().mockResolvedValue(undefined),
    save: vi.fn(async (data: TxfStorageDataBase) => { lastSaved = data; return { success: true, timestamp: 0 }; }),
    load: vi.fn(async () => (lastSaved
      ? { success: true, source: 'local', timestamp: 0, data: lastSaved }
      : { success: false, source: 'local', timestamp: 0 })),
    sync: vi.fn().mockResolvedValue({ success: true, added: 0, removed: 0, conflicts: 0 }),
    addHistoryEntry: vi.fn(async (e: HistoryRecord) => { history.set(e.dedupKey, e); }),
    getHistoryEntries: vi.fn(async () => [...history.values()]),
    hasHistoryEntry: vi.fn(async (k: string) => history.has(k)),
    clearHistory: vi.fn(async () => history.clear()),
    importHistoryEntries: vi.fn(async () => 0),
  } as unknown as TokenStorageProvider<TxfStorageDataBase>;
}

/** Transport whose delivery pays one publish round trip on the virtual clock. */
function mockTransport(clock: VirtualClock, deliveryStartMs: number[] = []): TransportProvider {
  return {
    sendTokenTransfer: vi.fn(async () => { deliveryStartMs.push(clock.now()); await clock.wait(DELIVER_MS); }),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn().mockResolvedValue({
      chainPubkey: BOB_CHAIN_PUBKEY,
      transportPubkey: 'bob-transport-pubkey',
      directAddress: 'DIRECT://bob',
      nametag: 'bob',
    }),
    resolveTransportPubkeyInfo: vi.fn().mockResolvedValue(null),
    connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(), isConnected: () => true,
  } as unknown as TransportProvider;
}

function mockOracle(): OracleProvider {
  return {
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
    isDevMode: () => false,
  } as unknown as OracleProvider;
}

function setup(
  engine: FakeTokenEngine,
  clock: VirtualClock,
  walletApi?: PaymentsModuleDependencies['walletApi'],
  deliveryStartMs: number[] = [],
) {
  const tokenStorageProviders = new Map<string, TokenStorageProvider<TxfStorageDataBase>>();
  tokenStorageProviders.set('local', mockTokenStorage());
  const transport = mockTransport(clock, deliveryStartMs);
  const deps: PaymentsModuleDependencies = {
    identity: mockIdentity(), storage: mockStorage(), tokenStorageProviders,
    transport, oracle: mockOracle(), emitEvent: vi.fn(), tokenEngine: engine,
    ...(walletApi ? { walletApi } : {}),
  };
  const module = createPaymentsModule({ debug: false });
  module.initialize(deps);
  return { module, transport };
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Mint ONE token of `amount` and receive it into the wallet (no latency). */
async function seedToken(module: any, engine: FakeTokenEngine, amount: bigint, id: string): Promise<void> {
  const minted = await engine.mint({
    recipientPubkey: engine.getIdentity().chainPubkey,
    value: { assets: [{ coinId: UCT, amount }] },
  });
  const payload: V2TransferPayload = {
    type: 'V2_TRANSFER', version: '2.0',
    tokenBlob: bytesToHex(encodeTokenBlob(engine.encodeToken(minted))),
  };
  await module.handleIncomingTransfer({
    id, senderTransportPubkey: SENDER_TRANSPORT_PUBKEY, payload, timestamp: 0,
  });
}

/** Mint `count` × AMOUNT_EACH tokens and receive them into the wallet (no latency). */
async function seedWallet(module: any, engine: FakeTokenEngine, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await seedToken(module, engine, AMOUNT_EACH, `seed-${i}`);
  }
}

// ── Scenario runner ──────────────────────────────────────────────────────────

interface SendTelemetry {
  result: TransferResult & { deliveryPending?: boolean };
  certifications: ConcurrencyGauge;
  deliveries: number;
  remainingConfirmed: number;
  virtualElapsedMs: number;
  certifyEndMs: number[];
  deliveryStartMs: number[];
}

async function runManyTokenSend(): Promise<SendTelemetry> {
  const clock = new VirtualClock();
  const certifications = new ConcurrencyGauge();
  const engine = new SimulatedNetworkEngine(clock, certifications);
  const deliveryStartMs: number[] = [];
  const { module, transport } = setup(engine, clock, undefined, deliveryStartMs);
  try {
    await seedWallet(module, engine, TOKEN_COUNT);
    const startMs = clock.now();
    const result = await module.send({
      recipient: '@bob', amount: (AMOUNT_EACH * BigInt(TOKEN_COUNT)).toString(), coinId: UCT,
    });
    return {
      result,
      certifications,
      deliveries: (transport.sendTokenTransfer as any).mock.calls.length,
      remainingConfirmed: module.getTokens().filter((t) => t.status === 'confirmed').length,
      virtualElapsedMs: clock.now() - startMs,
      certifyEndMs: engine.certifyEndMs,
      deliveryStartMs,
    };
  } finally {
    module.destroy();
  }
}

interface FailFastTelemetry {
  error: unknown;
  certifications: ConcurrencyGauge;
  deliveries: number;
  remainingConfirmed: number;
  virtualElapsedMs: number;
}

/** Op 0's submit fails inside the FIRST batch — later batches must never launch. */
async function runFailFastSend(): Promise<FailFastTelemetry> {
  const clock = new VirtualClock();
  const certifications = new ConcurrencyGauge();
  const engine = new SimulatedNetworkEngine(clock, certifications, 0);
  const { module, transport } = setup(engine, clock);
  try {
    await seedWallet(module, engine, TOKEN_COUNT);
    const startMs = clock.now();
    const error = await module
      .send({ recipient: '@bob', amount: (AMOUNT_EACH * BigInt(TOKEN_COUNT)).toString(), coinId: UCT })
      .then(() => undefined, (err: unknown) => err);
    return {
      error,
      certifications,
      deliveries: (transport.sendTokenTransfer as any).mock.calls.length,
      remainingConfirmed: module.getTokens().filter((t) => t.status === 'confirmed').length,
      virtualElapsedMs: clock.now() - startMs,
    };
  } finally {
    module.destroy();
  }
}

/** 110000 → '1m 50s'; 5500 → '5.5s'. */
function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const seconds = (ms % 60_000) / 1000;
  const secondsText = `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
  return minutes > 0 ? `${minutes}m ${secondsText}` : secondsText;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe(`single send() spending ${TOKEN_COUNT} source tokens`, () => {
  let t: SendTelemetry;

  beforeAll(async () => {
    t = await runManyTokenSend();
  }, 30_000);

  it('completes correctly: every source certified as a direct leg, delivered, and consumed', () => {
    expect(t.result.status).not.toBe('failed');
    expect(t.result.deliveryPending).toBeFalsy();

    // One whole-token direct transfer per source — no split leg.
    expect(t.result.tokenTransfers).toHaveLength(TOKEN_COUNT);
    expect(t.result.tokenTransfers.every((x) => x.method === 'direct')).toBe(true);
    expect(t.certifications.count).toBe(TOKEN_COUNT);

    // Every finished blob was handed to the recipient; no spendable token remains.
    expect(t.deliveries).toBe(TOKEN_COUNT);
    expect(t.remainingConfirmed).toBe(0);
  });

  it('parallel: certifications fan out at the send-operation cap', () => {
    // CHARACTERIZATION of the batched fan-out with the hoisted delivery pass
    // (#699): certification batches of MAX_SEND_OPERATION_CONCURRENCY run back
    // to back (batches × CERTIFY_MS), then the delivery pass walks the
    // committed set at the same width (batches × DELIVER_MS on this batch-less
    // transport port). The total is numerically the welded-era figure — the
    // shape changed, the wall clock did not. Sequential-era baseline:
    // maxConcurrent=1 at TOKEN_COUNT × 1100 = 110,000 ms.
    const batches = Math.ceil(TOKEN_COUNT / MAX_SEND_OPERATION_CONCURRENCY);
    const parallelTotalMs = batches * (CERTIFY_MS + DELIVER_MS);

    expect(t.certifications.maxConcurrent).toBe(MAX_SEND_OPERATION_CONCURRENCY);
    expect(t.virtualElapsedMs).toBe(parallelTotalMs);

    console.info(
      `[multi-token-send] operations=${t.certifications.count}` +
        ` maxConcurrent=${t.certifications.maxConcurrent}` +
        ` virtualWallClock=${formatDuration(t.virtualElapsedMs)}` +
        ` (${batches} batches; sequential-era baseline ${formatDuration(TOKEN_COUNT * (CERTIFY_MS + DELIVER_MS))})`,
    );
  });

  it('hoisted delivery (#699): no delivery starts until EVERY certification settled', () => {
    expect(t.certifyEndMs).toHaveLength(TOKEN_COUNT);
    expect(t.deliveryStartMs).toHaveLength(TOKEN_COUNT);
    expect(Math.min(...t.deliveryStartMs)).toBeGreaterThanOrEqual(Math.max(...t.certifyEndMs));
  });
});

describe('fail-fast: a failed operation stops later batches from launching', () => {
  let t: FailFastTelemetry;

  beforeAll(async () => {
    t = await runFailFastSend();
  }, 30_000);

  it('surfaces the failure after ONE batch instead of certifying every remaining batch', () => {
    expect(t.error).toBeInstanceOf(Error);
    expect((t.error as Error).message).toContain('simulated submit failure');
    // Exactly one op failed → nothing was suppressed (the field is only set
    // when a batch fails in more than one way).
    expect((t.error as Error & { suppressedErrors?: unknown[] }).suppressedErrors).toBeUndefined();
    // Only the first batch launched (sequential-era fail-fast, at batch
    // granularity): its siblings settled certified, no further batch started,
    // and the hoisted delivery pass (#699) then delivered the committed
    // siblings — the failure path still hands certified value to the
    // recipient. Without the early exit this would be TOKEN_COUNT attempts
    // over ceil(TOKEN_COUNT/MAX) batch round trips.
    expect(t.certifications.count).toBe(MAX_SEND_OPERATION_CONCURRENCY);
    expect(t.deliveries).toBe(MAX_SEND_OPERATION_CONCURRENCY - 1);
    expect(t.virtualElapsedMs).toBe(CERTIFY_MS + DELIVER_MS);
  });

  it('consumes the committed siblings; the failed and never-launched sources stay spendable', () => {
    // The batch's certified siblings were removed (their value is delivered);
    // the failed op's source and every never-launched source are restored
    // 'confirmed' for the retry/re-plan.
    expect(t.remainingConfirmed).toBe(TOKEN_COUNT - (MAX_SEND_OPERATION_CONCURRENCY - 1));
  });
});

// ── A direct-op conflict settling alongside a FULLY certified split must not
// abort the intent that owns the split. Pre-fix, the disposition aborted on
// ANY TransferConflictError; the certified split's change output — not yet
// uploaded/stored (the throw precedes the apply) — then had no resume seed
// (resume lists 'open' intents only). ───────────────────────────────────────

/** Engine whose FIRST transfer() loses the race; every later op certifies. */
class ConflictFirstTransferEngine extends FakeTokenEngine {
  private conflicted = false;

  override async transfer(params: TransferParams, options?: EngineOpOptions): Promise<SphereToken> {
    if (!this.conflicted) {
      this.conflicted = true;
      throw new TransferConflictError('source state already spent by a foreign transaction');
    }
    return super.transfer(params, options);
  }
}

describe('conflict + certified split keeps the intent open', () => {
  // Neither source covers the amount alone → the plan is one direct transfer
  // + one split, certified concurrently in the same batch.
  const SOURCE_AMOUNTS = [3n, 5n];
  const SEND_AMOUNT = 7n;

  it('never aborts the partial intent; change survives; the remainder re-plan completes the send', async () => {
    const clock = new VirtualClock();
    const engine = new ConflictFirstTransferEngine();
    const walletApi = {
      putIntent: vi.fn().mockResolvedValue(undefined),
      completeIntent: vi.fn().mockResolvedValue(undefined),
      abortIntent: vi.fn().mockResolvedValue(undefined),
      listIntents: vi.fn().mockResolvedValue([]),
      getUploadUrls: vi.fn().mockResolvedValue([]),
      uploadBlob: vi.fn().mockResolvedValue(undefined),
      postHistoryRecords: vi.fn().mockResolvedValue(undefined),
      listHistory: vi.fn().mockResolvedValue({ records: [], more: false, cursor: null, syncEpoch: 0n }),
    };
    const { module, transport } = setup(
      engine, clock, walletApi as unknown as PaymentsModuleDependencies['walletApi'],
    );
    try {
      for (const [i, amount] of SOURCE_AMOUNTS.entries()) {
        await seedToken(module, engine, amount, `conflict-seed-${i}`);
      }
      const result = await module.send({
        recipient: '@bob', amount: SEND_AMOUNT.toString(), coinId: UCT,
      });
      expect(result.status).not.toBe('failed');

      // THE regression pin: the first attempt's intent owns a fully-certified
      // split whose change output only that intent can re-derive — the
      // conflicted direct sibling must NOT soft-abort it.
      expect(walletApi.abortIntent).not.toHaveBeenCalled();

      // Two attempts: the partial first intent stays OPEN (put, never closed);
      // the #677 remainder re-plan runs under a NEW transferId and completes.
      expect(walletApi.putIntent).toHaveBeenCalledTimes(2);
      const firstIntentId = walletApi.putIntent.mock.calls[0][0];
      const secondIntentId = walletApi.putIntent.mock.calls[1][0];
      expect(secondIntentId).not.toBe(firstIntentId);
      expect(walletApi.completeIntent).toHaveBeenCalledTimes(1);
      expect(walletApi.completeIntent).toHaveBeenCalledWith(secondIntentId);

      // The recipient received EXACTLY the full amount across the certified
      // split leg + the re-planned direct leg — no leg paid twice.
      const deliveredAmounts = await Promise.all(
        (transport.sendTokenTransfer as any).mock.calls.map(async (call: any[]) => {
          const token = await engine.decodeToken(decodeTokenBlob(hexToBytes(call[1].tokenBlob)));
          return engine.balanceOf(token, UCT);
        }),
      );
      expect(deliveredAmounts.reduce((a: bigint, b: bigint) => a + b, 0n)).toBe(SEND_AMOUNT);

      // The split's change token survived the failed first attempt (persisted
      // BEFORE the failure surfaced) — total held value = sources − sent.
      const heldAmount = module.getTokens()
        .filter((t: { status: string }) => t.status === 'confirmed')
        .reduce((sum: bigint, t: { amount?: string }) => sum + BigInt(t.amount || '0'), 0n);
      expect(heldAmount).toBe(SOURCE_AMOUNTS.reduce((a, b) => a + b, 0n) - SEND_AMOUNT);
    } finally {
      module.destroy();
    }
  });
});
