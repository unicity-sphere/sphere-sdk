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
import { FakeTokenEngine } from '../token-engine/FakeTokenEngine';
import { encodeTokenBlob } from '../../../token-engine/token-blob';
import { bytesToHex } from '../../../core/crypto';
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
  ) {
    super();
  }

  override transfer(params: TransferParams, options?: EngineOpOptions): Promise<SphereToken> {
    return this.certifications.track(async () => {
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
  }
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
function mockTransport(clock: VirtualClock): TransportProvider {
  return {
    sendTokenTransfer: vi.fn(async () => { await clock.wait(DELIVER_MS); }),
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

function setup(engine: FakeTokenEngine, clock: VirtualClock) {
  const tokenStorageProviders = new Map<string, TokenStorageProvider<TxfStorageDataBase>>();
  tokenStorageProviders.set('local', mockTokenStorage());
  const transport = mockTransport(clock);
  const deps: PaymentsModuleDependencies = {
    identity: mockIdentity(), storage: mockStorage(), tokenStorageProviders,
    transport, oracle: mockOracle(), emitEvent: vi.fn(), tokenEngine: engine,
  };
  const module = createPaymentsModule({ debug: false });
  module.initialize(deps);
  return { module, transport };
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Mint `count` × AMOUNT_EACH tokens and receive them into the wallet (no latency). */
async function seedWallet(module: any, engine: FakeTokenEngine, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const minted = await engine.mint({
      recipientPubkey: engine.getIdentity().chainPubkey,
      value: { assets: [{ coinId: UCT, amount: AMOUNT_EACH }] },
    });
    const payload: V2TransferPayload = {
      type: 'V2_TRANSFER', version: '2.0',
      tokenBlob: bytesToHex(encodeTokenBlob(engine.encodeToken(minted))),
    };
    await module.handleIncomingTransfer({
      id: `seed-${i}`, senderTransportPubkey: SENDER_TRANSPORT_PUBKEY, payload, timestamp: 0,
    });
  }
}

// ── Scenario runner ──────────────────────────────────────────────────────────

interface SendTelemetry {
  result: TransferResult & { deliveryPending?: boolean };
  certifications: ConcurrencyGauge;
  deliveries: number;
  remainingConfirmed: number;
  virtualElapsedMs: number;
}

async function runManyTokenSend(): Promise<SendTelemetry> {
  const clock = new VirtualClock();
  const certifications = new ConcurrencyGauge();
  const engine = new SimulatedNetworkEngine(clock, certifications);
  const { module, transport } = setup(engine, clock);
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
    // CHARACTERIZATION of the batched fan-out: each batch of
    // MAX_SEND_OPERATION_CONCURRENCY ops overlaps fully on the virtual clock
    // (certify + deliver), and batches run back to back. The sequential-era
    // baseline was maxConcurrent=1 at TOKEN_COUNT × 1100 = 110,000 ms.
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
});
