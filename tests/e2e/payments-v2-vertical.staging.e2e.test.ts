/**
 * LIVE staging money e2e for the payments-v2 VERTICAL (docs/PAYMENTS-V2-DESIGN.md
 * §10 transfer-shape matrix + standing rule): PaymentsFacade composed over the
 * REAL impl/wallet-api-v2 ports (storage/mailbox/checkpoints/session) and the
 * REAL token engine against the REAL staging wallet-api + testnet2 gateway.
 * No fakes anywhere — every seam the unit facade suite stubbed is real here.
 *
 * Tests are SEQUENTIAL and share wallets: later tests spend earlier balances.
 *
 * Degraded-staging posture (observed: submits admitted, inclusion proofs late,
 * so the SDK correctly returns keep-open outcomes): a keep-open mint or send is
 * NEVER re-issued (F13 / #631 — a fresh id would double-pay). Convergence is
 * always the RECOVERY machinery: rebuild the vertical on the SAME kv+identity
 * and let start() replay journals / resume the SAME transferId, paced under a
 * generous deadline. Money assertions stay exact — exactly-once, conservation.
 *
 * Gated on STAGING_AGGREGATOR_KEY. Run:
 *   set -a && source .env && set +a && npx vitest run --config vitest.e2e.config.ts \
 *     tests/e2e/payments-v2-vertical.staging.e2e.test.ts
 */
import { afterAll, describe, expect, it } from 'vitest';

import { hexToBytes, signMessage } from '../../core/crypto';
import { isPossiblyCommittedSendOutcome } from '../../core/errors';
import { deriveFieldEncryptionKey } from '../../core/field-encryption';
import { completeSignMessage } from '../../core/wallet-api-protocol';
import {
  authedWireClient,
  requestMemoCodec,
  type PaymentsV2WireClient,
} from '../../core/payments-v2-wiring';
import { createWalletApiHttp } from '../../impl/wallet-api-v2/http';
import { WalletApiV2Client } from '../../impl/wallet-api-v2/client';
import { JwtGenerationCell, WalletApiSession } from '../../impl/wallet-api-v2/session';
import { WalletApiStoragePort } from '../../impl/wallet-api-v2/storage';
import { WalletApiDeliveryPort } from '../../impl/wallet-api-v2/mailbox';
import { WalletApiSplitCheckpointStore } from '../../impl/wallet-api-v2/checkpoints';
import { PaymentsFacade } from '../../modules/payments-v2/PaymentsFacade';
import type { DeliveryPort, InventoryItem } from '../../modules/payments-v2/ports';
import type { ScopedKV } from '../../modules/payments-v2/stores';
import { createMachineStores } from '../../modules/payments-v2/machine/journal';
import { createSphereTokenEngine } from '../../token-engine/factory';
import type { ITokenEngine } from '../../token-engine/engine';
import type { HistoryEntry } from '../../modules/payments-v2/api';
import type { TransferResult } from '../../types';
import { HARNESS_COIN, randomIdentity } from '../harness/support/stack';
import { registryStub } from '../unit/payments-v2/support';
import {
  AGGREGATOR_URL,
  BASE_URL,
  memoryKV,
  NETWORK,
  nodeWsFactory,
  RUN_STAGING as RUN,
  STAGING_API_KEY as API_KEY,
  trustbase,
} from './support/staging';

// Replay-convergence pacing (observed 2026-08-04: the shared staging submit key
// can refuse 9+ paced attempts over 6 min): fast cadence — a cycle is ~30 s —
// under LARGE budgets; every cycle is the same idempotent replay, never a re-issue.
const PACE_MS = 10_000;
const POLL_MS = 3_000;
const CYCLE_WINDOW_MS = 15_000;
const MINT_CONVERGE_MS = 1_200_000;
const SEND_CONVERGE_MS = 900_000;
let aborted = false; // set by afterAll so a loop the vitest timeout abandoned exits

function logStep(step: string): void {
  console.log(`[pv2-vert ${new Date().toISOString()}] ${step}`);
}

// ── shared plumbing ──────────────────────────────────────────────────────────

// Minimal RegistryReader: answers the harness coin; decimals 0 (integer amounts).
const registry = registryStub({
  getSymbol: (coinId: string) => (coinId === HARNESS_COIN ? 'HARN' : coinId.slice(0, 8)),
  getName: (coinId: string) => (coinId === HARNESS_COIN ? 'Harness Coin' : 'Unknown'),
});

// The server /v1/balances endpoint stays a TEST observation surface (serverTotal)
// even though the StoragePort no longer exposes it (assets() aggregates the mirror).
type AuthedClient = PaymentsV2WireClient & Pick<WalletApiV2Client, 'balances'>;

// The PRODUCTION authed wrapper (the suite outlives the 900 s JWT TTL) plus the
// test-only balances observation surface.
function authedClient(session: WalletApiSession, client: WalletApiV2Client): AuthedClient {
  return {
    ...authedWireClient(session, client),
    balances: () => session.withAuth(() => client.balances()),
  };
}

interface VIdentity {
  privateKey: string;
  chainPubkey: string;
}

interface VWallet {
  facade: PaymentsFacade;
  session: WalletApiSession;
  api: AuthedClient;
  kv: ScopedKV;
  identity: VIdentity;
  engine: ITokenEngine;
  events: { event: string; payload: unknown }[];
  tag: string;
}

const openWallets: VWallet[] = [];

interface MakeOptions {
  identity?: VIdentity;
  kv?: ScopedKV;
  wrapDelivery?: (inner: DeliveryPort) => DeliveryPort;
}

/** The whole vertical, composed for real: session → authed client → ports → engine → facade. */
async function makeVerticalWallet(tag: string, options: MakeOptions = {}): Promise<VWallet> {
  const identity = options.identity ?? randomIdentity();
  const kv = options.kv ?? memoryKV();
  const cell = new JwtGenerationCell();
  const http = createWalletApiHttp({
    baseUrl: BASE_URL,
    fetchFn: (url, init) => fetch(url, init as RequestInit) as never,
    getToken: () => cell.token(),
  });
  const client = new WalletApiV2Client(http);
  const session = new WalletApiSession({
    client,
    cell,
    signer: {
      pubkey: identity.chainPubkey,
      network: NETWORK,
      sign: (msg: string) => signMessage(identity.privateKey, msg),
    },
    // Deterministic per (tag, identity): a restarted instance reuses its refresh token.
    deviceId: `e2e-vert-${tag}-${identity.chainPubkey.slice(2, 12)}`,
    kv,
    webSocketFactory: nodeWsFactory,
    emitStatus: () => undefined,
    onEpochChange: async () => undefined,
    timing: { pullIntervalMs: 5_000 },
  });
  const api = authedClient(session, client);
  const fieldKey = deriveFieldEncryptionKey(identity.privateKey);
  const realDelivery = new WalletApiDeliveryPort({
    client: api,
    kv,
    identity: { privateKey: identity.privateKey, chainPubkey: identity.chainPubkey },
    custody: 'inventory',
  });
  const engine = await createSphereTokenEngine({
    aggregatorUrl: AGGREGATOR_URL,
    ...(API_KEY !== undefined && API_KEY !== '' ? { apiKey: API_KEY } : {}),
    privateKey: hexToBytes(identity.privateKey),
    trustBaseJson: await trustbase(),
  });
  const events: { event: string; payload: unknown }[] = [];
  const facade = new PaymentsFacade({
    session,
    client: api,
    storagePort: new WalletApiStoragePort(api),
    deliveryPort: options.wrapDelivery ? options.wrapDelivery(realDelivery) : realDelivery,
    checkpointStore: new WalletApiSplitCheckpointStore({
      client: api,
      kv,
      fieldKey,
      signProgress: (message) => signMessage(identity.privateKey, message),
    }),
    engineRef: () => engine,
    kv,
    registry,
    emit: (event, payload) => {
      events.push({ event, payload });
      // Surface refusal/attention states in the run log (e.g. mint:unresolved).
      if (event === 'transfer:attention') logStep(`[${tag}] attention: ${JSON.stringify(payload)}`);
    },
    // Raw-pubkey identifiers only (this suite never uses nametags); pinned to the session network.
    resolveRecipient: async (identifier) =>
      /^0[23][0-9a-f]{64}$/.test(identifier) ? { chainPubkey: identifier, network: NETWORK } : null,
    signComplete: async (transferId) => signMessage(identity.privateKey, completeSignMessage(transferId)),
    fieldKey,
    network: NETWORK,
    ownPubkey: identity.chainPubkey,
    requestMemo: requestMemoCodec(identity.privateKey),
  });
  await session.ensureAuthenticated();
  await facade.start();
  const wallet: VWallet = { facade, session, api, kv, identity, engine, events, tag };
  openWallets.push(wallet);
  return wallet;
}

afterAll(async () => {
  aborted = true; // stop any convergence loop the vitest timeout abandoned
  for (const w of openWallets.splice(0)) {
    await w.facade.stop().catch(() => undefined);
  }
}, 240_000);

// ── observation helpers (state-based; never trust a single drain's return) ──

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function localTotal(w: VWallet): bigint {
  return w.facade
    .tokens({ coinId: HARNESS_COIN })
    .reduce((sum, token) => sum + BigInt(token.amount), 0n);
}

async function serverTotal(w: VWallet): Promise<bigint> {
  const balances = await w.api.balances();
  const row = balances.find((b) => b.coinId === HARNESS_COIN);
  return row === undefined ? 0n : BigInt(row.total);
}

async function activeRows(w: VWallet): Promise<InventoryItem[]> {
  const rows: InventoryItem[] = [];
  let page = await w.api.listInventory();
  for (;;) {
    rows.push(...page.items.filter((item) => item.status === 'active'));
    if (!page.more) return rows;
    page = await w.api.listInventory(page.cursor);
  }
}

async function historyEntries(w: VWallet): Promise<HistoryEntry[]> {
  return (await w.facade.history({ limit: 100 })).entries;
}

async function receivedLegs(w: VWallet, tokenId: string): Promise<HistoryEntry[]> {
  return (await historyEntries(w)).filter(
    (e) => e.type === 'RECEIVED' && e.tokenId === tokenId.toLowerCase()
  );
}

async function openIntentIds(w: VWallet): Promise<string[]> {
  return (await w.api.listIntents('open')).map((i) => i.transferId);
}

async function diagnose(label: string, w: VWallet): Promise<string> {
  const grab = async (what: () => Promise<unknown>): Promise<unknown> => {
    try {
      return await what();
    } catch (err) {
      return `unavailable: ${String(err)}`;
    }
  };
  return JSON.stringify(
    {
      label,
      localTokens: w.facade.tokens().map((t) => ({ id: t.id, amount: t.amount, status: t.status })),
      serverBalances: await grab(() => w.api.balances()),
      openIntents: await grab(() => openIntentIds(w)),
      mailbox: await grab(async () =>
        (await w.api.listMailbox(0)).entries.map((e) => ({
          tokenId: e.tokenId,
          status: e.status,
          transferId: e.transferId,
        }))
      ),
    },
    null,
    2
  );
}

/** Poll a state predicate. Staging hiccups: retry the CHECK, never a send. */
async function waitFor(
  w: VWallet,
  check: () => Promise<boolean> | boolean,
  timeoutMs: number,
  label: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  for (;;) {
    try {
      if (await check()) return;
      lastError = null;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `waitFor timeout: ${label}${lastError !== null ? ` (last error: ${String(lastError)})` : ''}\n${await diagnose(label, w)}`
      );
    }
    await sleep(2_000);
  }
}

/** Drain the mailbox (retrying failed DRAINS) until the state predicate holds. */
async function drainUntil(
  w: VWallet,
  check: () => Promise<boolean> | boolean,
  timeoutMs: number,
  label: string
): Promise<void> {
  await waitFor(
    w,
    async () => {
      await w.facade.receive().catch(() => undefined);
      return check();
    },
    timeoutMs,
    label
  );
}

// ── keep-open convergence (the ONLY answer to a degraded aggregator) ─────────

/**
 * Rebuild the SAME wallet (kv + identity + tag) so start() replays the mint /
 * delivery journals and resumes open intents under their ORIGINAL transferIds
 * (F13 / #631 — never a re-issued mint() or send()), then poll `settled` until
 * the money state converges. Paced: staging finalization is slow and contended.
 */
async function convergeByReplay(
  wallet: VWallet,
  settled: (w: VWallet) => Promise<boolean> | boolean,
  deadlineMs: number,
  label: string,
  rebuildOptions: Omit<MakeOptions, 'identity' | 'kv'> = {}
): Promise<VWallet> {
  const deadline = Date.now() + deadlineMs;
  let current = wallet;
  for (let cycle = 1; !aborted; cycle++) {
    await sleep(PACE_MS);
    await current.facade.stop().catch(() => undefined);
    current = await makeVerticalWallet(current.tag, {
      ...rebuildOptions,
      identity: current.identity,
      kv: current.kv,
    });
    const windowEnd = Math.min(Date.now() + CYCLE_WINDOW_MS, deadline);
    for (;;) {
      let ok = false;
      try {
        ok = await settled(current);
      } catch {
        // transient observation failure — keep polling
      }
      if (ok) {
        logStep(`${label}: converged via replay on cycle ${String(cycle)}`);
        return current;
      }
      if (Date.now() >= windowEnd || aborted) break;
      await sleep(POLL_MS);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${label}: no convergence within ${String(deadlineMs)} ms\n${await diagnose(label, current)}`
      );
    }
    if (cycle % 5 === 0) logStep(`${label}: still degraded after ${String(cycle)} replay cycles`);
  }
  throw new Error(`${label}: aborted before convergence`);
}

const MINT_VALIDATION_ERROR = 'coinId must be even-length lowercase hex and amount positive';

/**
 * F13 posture: mint() is called exactly ONCE. Any journaled failure (keep-open
 * certification, late finalize) converges by replaying the SAME mintId — a
 * re-call would risk a SECOND token. Only the pre-journal validation reject
 * (nothing submitted, nothing journaled) fails hard.
 */
async function mintConverged(
  wallet: VWallet,
  amount: bigint,
  label: string,
  rebuildOptions: Omit<MakeOptions, 'identity' | 'kv'> = {}
): Promise<{ wallet: VWallet; tokenId: string }> {
  const before = await serverTotal(wallet);
  const result = await wallet.facade.mint(HARNESS_COIN, amount);
  if (result.success) {
    logStep(`${label}: admitted directly (${result.tokenId ?? ''})`);
    return { wallet, tokenId: must(result.tokenId, 'mint tokenId') };
  }
  if (result.error === MINT_VALIDATION_ERROR) throw new Error(`${label}: ${result.error}`);
  logStep(`${label}: keep-open (${(result.error ?? 'unknown').slice(0, 90)}) — converging via journal replay, no re-call`);
  const stores = createMachineStores(wallet.kv);
  const converged = await convergeByReplay(
    wallet,
    async (w) =>
      (await stores.mintJournal.list()).length === 0 && (await serverTotal(w)) === before + amount,
    MINT_CONVERGE_MS,
    label,
    rebuildOptions
  );
  const rows = await activeRows(converged);
  if (rows.length !== 1) {
    throw new Error(`${label}: expected exactly ONE active row after replay convergence, saw ${String(rows.length)}`);
  }
  return { wallet: converged, tokenId: must(rows[0], 'converged mint row').tokenId };
}

/**
 * #631 posture: a keep-open send outcome is NEVER re-issued — the rebuilt
 * instance's start() gate resumes the SAME transferId. A resolved-but-pending
 * delivery converges the same way (journal replay of the SAME certified blob).
 */
async function sendConverged(
  wallet: VWallet,
  request: { recipient: string; amount: string; coinId: string },
  settled: (w: VWallet) => Promise<boolean> | boolean,
  label: string
): Promise<{ wallet: VWallet; result: TransferResult | null; transferId: string }> {
  let result: TransferResult;
  try {
    result = await wallet.facade.send(request);
  } catch (err) {
    if (!isPossiblyCommittedSendOutcome(err)) throw err;
    const transferId = must((err as { transferId?: string }).transferId, 'keep-open transferId');
    logStep(`${label}: keep-open ${transferId} (${(err as Error).message.slice(0, 80)}…) — converging via same-transferId resume`);
    const converged = await convergeByReplay(wallet, settled, SEND_CONVERGE_MS, label);
    return { wallet: converged, result: null, transferId };
  }
  if (result.deliveryPending === true) {
    logStep(`${label}: certified but delivery pending — converging via delivery-journal replay`);
    const converged = await convergeByReplay(wallet, settled, SEND_CONVERGE_MS, label);
    return { wallet: converged, result, transferId: result.id };
  }
  logStep(`${label}: admitted directly (${result.id})`);
  return { wallet, result, transferId: result.id };
}

// ── wallets shared ACROSS tests (sequential; later tests spend earlier balances) ──

let walletA: VWallet | undefined;
let walletB: VWallet | undefined;
let mintedA = ''; // test 1: A's minted 1000-token genesis id
let splitToA = ''; // test 3: the fresh 400 genesis A received from B's split
let legsBeforeRoundtrip = 0; // test 5: A's RECEIVED count for splitToA before the roundtrip

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} missing — a prior test did not complete`);
  return value;
}

describe.runIf(RUN)('LIVE staging: payments-v2 vertical (facade over real ports + engine)', () => {
  it('mint: journal-first self-mint lands on-chain, in server inventory, and in MINT history — exactly once, whatever the attempt count', async () => {
    walletA = await makeVerticalWallet('a');

    const minted = await mintConverged(walletA, 1000n, 'mint A 1000');
    walletA = minted.wallet;
    const a = walletA;
    mintedA = minted.tokenId;
    expect(mintedA).toMatch(/^[0-9a-f]+$/);

    // Journal-first lifecycle: convergence (direct or replayed) drains the journal.
    expect(await createMachineStores(a.kv).mintJournal.list()).toEqual([]);

    await waitFor(a, () => localTotal(a) === 1000n, 60_000, 'A local view shows the 1000 mint');
    const assets = await a.facade.assets(HARNESS_COIN);
    expect(assets).toHaveLength(1);
    expect(assets[0]?.totalAmount).toBe('1000');
    expect(a.facade.tokens().map((t) => t.id)).toEqual([mintedA]);

    const rows = await activeRows(a);
    expect(rows).toHaveLength(1); // exactly ONE token — replay never double-mints
    expect(rows[0]?.tokenId).toBe(mintedA);
    expect(await serverTotal(a)).toBe(1000n);

    await waitFor(
      a,
      async () =>
        (await historyEntries(a)).some((e) => e.type === 'MINT' && e.tokenId === mintedA && e.amount === '1000'),
      30_000,
      'MINT history record'
    );
    // Exactly ONE MINT record, however many replay cycles convergence took.
    const mintRecords = (await historyEntries(a)).filter((e) => e.type === 'MINT');
    expect(mintRecords).toHaveLength(1);
    expect(mintRecords[0]).toMatchObject({ tokenId: mintedA, amount: '1000' });
  }, 1_800_000);

  it('exact single: whole-token A→B; recipient verifies before balance; intent completes', async () => {
    walletB = await makeVerticalWallet('b');
    const b = walletB;

    const bPaid = async (): Promise<boolean> => {
      await b.facade.receive().catch(() => undefined);
      return localTotal(b) === 1000n;
    };
    const sent = await sendConverged(
      must(walletA, 'wallet A'),
      { recipient: b.identity.chainPubkey, amount: '1000', coinId: HARNESS_COIN },
      bPaid,
      'send A→B 1000'
    );
    walletA = sent.wallet;
    const a = walletA;
    if (sent.result !== null) {
      expect(['delivered', 'confirmed']).toContain(sent.result.status);
      expect(sent.result.tokenTransfers).toEqual([{ sourceTokenId: mintedA, method: 'direct' }]);
    }

    // B's acceptance implies the full real trust-base verify + isOwnedBy passed
    // (Receive screens BEFORE store/claim); the claim puts the row in B's inventory.
    await drainUntil(b, () => localTotal(b) === 1000n, 90_000, 'B receives 1000');
    expect((await activeRows(b)).map((r) => r.tokenId)).toEqual([mintedA]);
    expect(await serverTotal(b)).toBe(1000n);

    await waitFor(a, async () => (await serverTotal(a)) === 0n && localTotal(a) === 0n, 60_000, 'A drained to 0');

    await waitFor(
      a,
      async () => (await historyEntries(a)).some((e) => e.type === 'SENT' && e.transferId === sent.transferId),
      30_000,
      'A SENT history record'
    );
    expect(await receivedLegs(b, mintedA)).toHaveLength(1);

    // closeTail is fire-and-forget after send() resolves — poll to empty.
    await waitFor(a, async () => (await openIntentIds(a)).length === 0, 60_000, 'A open intents empty');
    // The certified blob left exactly once: A's delivery journal is drained.
    await waitFor(a, async () => (await createMachineStores(a.kv).deliveryJournal.list()).length === 0, 30_000, 'A delivery journal drained');
  }, 1_500_000);

  it('split: B→A 400 of 1000 — burn+checkpoint+mints; change stays with B', async () => {
    const a = must(walletA, 'wallet A');

    const aPaid = async (): Promise<boolean> => {
      await a.facade.receive().catch(() => undefined);
      return localTotal(a) === 400n;
    };
    const sent = await sendConverged(
      must(walletB, 'wallet B'),
      { recipient: a.identity.chainPubkey, amount: '400', coinId: HARNESS_COIN },
      aPaid,
      'split B→A 400'
    );
    walletB = sent.wallet;
    const b = walletB;
    if (sent.result !== null) {
      expect(['delivered', 'confirmed']).toContain(sent.result.status);
      expect(sent.result.tokenTransfers).toEqual([{ sourceTokenId: mintedA, method: 'split' }]);
    }

    await drainUntil(a, () => localTotal(a) === 400n, 90_000, 'A receives the 400 split output');
    const aTokens = a.facade.tokens();
    expect(aTokens).toHaveLength(1);
    splitToA = must(aTokens[0], 'A split-output token').id;
    expect(splitToA).not.toBe(mintedA); // split mints a FRESH genesis
    legsBeforeRoundtrip = (await receivedLegs(a, splitToA)).length;
    expect(legsBeforeRoundtrip).toBe(1);

    // B keeps exactly the 600 change (fresh genesis), locally and on the server.
    await waitFor(
      b,
      () => {
        const tokens = b.facade.tokens();
        return tokens.length === 1 && tokens[0]?.amount === '600' && tokens[0].id !== mintedA;
      },
      90_000,
      'B local view settles to the 600 change token'
    );
    const changeId = must(b.facade.tokens()[0], 'B change token').id;
    const bRows = await activeRows(b);
    expect(bRows.map((r) => r.tokenId)).toEqual([changeId]);
    expect(await serverTotal(b)).toBe(600n);

    // The split is SENT-recorded under the same transferId, direct or resumed.
    await waitFor(
      b,
      async () => (await historyEntries(b)).some((e) => e.type === 'SENT' && e.transferId === sent.transferId),
      30_000,
      'B SENT history record'
    );

    // requiresSeedClose intent: an empty open list proves the SIGNED seed-close
    // (wallet-api.complete.v1) was accepted by the real server gate.
    await waitFor(b, async () => (await openIntentIds(b)).length === 0, 60_000, 'B open intents empty');
    await waitFor(b, async () => (await createMachineStores(b.kv).deliveryJournal.list()).length === 0, 30_000, 'B delivery journal drained');
  }, 1_500_000);

  it('self-send: spend and claim commute; no phantom, no double', async () => {
    const selfSettled = async (w: VWallet): Promise<boolean> => {
      await w.facade.receive().catch(() => undefined);
      return (
        localTotal(w) === 400n &&
        (await serverTotal(w)) === 400n &&
        (await receivedLegs(w, splitToA)).length === 2
      );
    };
    const sent = await sendConverged(
      must(walletA, 'wallet A'),
      { recipient: must(walletA, 'wallet A').identity.chainPubkey, amount: '400', coinId: HARNESS_COIN },
      selfSettled,
      'self-send A 400'
    );
    walletA = sent.wallet;
    const a = walletA;
    if (sent.result !== null) {
      expect(['delivered', 'confirmed']).toContain(sent.result.status);
      expect(sent.result.tokenTransfers).toEqual([{ sourceTokenId: splitToA, method: 'direct' }]);
    }

    // The self-output rides A's own mailbox; the claim reactivates the row at
    // the NEW state. Settled = same genesis, same value, exactly once.
    await drainUntil(
      a,
      async () =>
        localTotal(a) === 400n &&
        (await serverTotal(a)) === 400n &&
        (await receivedLegs(a, splitToA)).length === 2,
      120_000,
      'A self-send round-trips through the mailbox'
    );

    const rows = await activeRows(a);
    expect(rows.map((r) => r.tokenId)).toEqual([splitToA]); // one active row — no phantom, no double
    expect(a.facade.tokens().map((t) => ({ id: t.id, amount: t.amount }))).toEqual([
      { id: splitToA, amount: '400' },
    ]);
    legsBeforeRoundtrip = 2; // (splitToA@mint-state, splitToA@self-send-state)
    await waitFor(a, async () => (await openIntentIds(a)).length === 0, 60_000, 'A open intents empty');
  }, 1_500_000);

  it('roundtrip A→B→A: the re-acquired genesis at a NEW state is accepted; two RECEIVED legs', async () => {
    const b = must(walletB, 'wallet B');

    const bHolds1000 = async (): Promise<boolean> => {
      await b.facade.receive().catch(() => undefined);
      return localTotal(b) === 1000n;
    };
    const out = await sendConverged(
      must(walletA, 'wallet A'),
      { recipient: b.identity.chainPubkey, amount: '400', coinId: HARNESS_COIN },
      bHolds1000,
      'roundtrip A→B 400'
    );
    walletA = out.wallet;
    const a = walletA;
    if (out.result !== null) {
      expect(out.result.tokenTransfers).toEqual([{ sourceTokenId: splitToA, method: 'direct' }]);
    }
    await drainUntil(b, () => localTotal(b) === 1000n, 90_000, 'B holds 600 change + the 400 roundtrip token');
    expect(await receivedLegs(b, splitToA)).toHaveLength(1);

    // B's pool is {600, 400}: exact-single selection MUST send the SAME genesis back whole.
    const aReacquired = async (): Promise<boolean> => {
      await a.facade.receive().catch(() => undefined);
      return localTotal(a) === 400n && (await receivedLegs(a, splitToA)).length === legsBeforeRoundtrip + 1;
    };
    const back = await sendConverged(
      b,
      { recipient: a.identity.chainPubkey, amount: '400', coinId: HARNESS_COIN },
      aReacquired,
      'roundtrip B→A 400'
    );
    walletB = back.wallet;
    const b2 = walletB;
    if (back.result !== null) {
      expect(back.result.tokenTransfers).toEqual([{ sourceTokenId: splitToA, method: 'direct' }]);
    }

    // Per-state dedup accepts the re-acquired genesis at its NEW state: the
    // roundtrip return is a FRESH leg on top of the two prior states (test 3
    // receipt + test 4 self-send), never deduped away and never doubled.
    await drainUntil(
      a,
      async () =>
        localTotal(a) === 400n && (await receivedLegs(a, splitToA)).length === legsBeforeRoundtrip + 1,
      120_000,
      'A re-acquires the same genesis at a new state'
    );
    expect(await receivedLegs(a, splitToA)).toHaveLength(3);
    expect((await activeRows(a)).map((r) => r.tokenId)).toEqual([splitToA]);
    expect(await serverTotal(a)).toBe(400n);
    await waitFor(b2, async () => (await serverTotal(b2)) === 600n && localTotal(b2) === 600n, 60_000, 'B back to 600');
  }, 2_400_000);

  it('crash-window resume: a deposit that fails once is journaled and a SECOND instance replays it — recipient paid exactly once', async () => {
    // Fail the FIRST deliverBatch call AND the FIRST deliver call, then pass through:
    // the certified blob must survive in the journal across the simulated crash.
    const failOnce = (inner: DeliveryPort): DeliveryPort => {
      let batchFailed = false;
      let deliverFailed = false;
      return {
        bindDeliveryKeys: (derive) => inner.bindDeliveryKeys(derive),
        deliver: async (recipient, blob, options) => {
          if (!deliverFailed) {
            deliverFailed = true;
            throw new Error('synthetic network error: deliver (crash window)');
          }
          return inner.deliver(recipient, blob, options);
        },
        deliverBatch: async (recipient, blobs, options) => {
          if (!batchFailed) {
            batchFailed = true;
            throw new Error('synthetic network error: deliverBatch (crash window)');
          }
          return inner.deliverBatch!(recipient, blobs, options);
        },
        incoming: (since) => inner.incoming(since),
        ack: (id, disposition, reason) => inner.ack(id, disposition, reason),
        ...(inner.onWake !== undefined ? { onWake: inner.onWake.bind(inner) } : {}),
      };
    };

    const cIdentity = randomIdentity();
    const cKv = memoryKV();
    let c1 = await makeVerticalWallet('c', { identity: cIdentity, kv: cKv, wrapDelivery: failOnce });
    const d = await makeVerticalWallet('d');

    const minted = await mintConverged(c1, 500n, 'mint C 500', { wrapDelivery: failOnce });
    c1 = minted.wallet;
    const genesis = minted.tokenId;
    await waitFor(c1, () => localTotal(c1) === 500n, 60_000, 'C local view shows the 500 mint');

    let sendResult: TransferResult | null = null;
    try {
      sendResult = await c1.facade.send({
        recipient: d.identity.chainPubkey,
        amount: '500',
        coinId: HARNESS_COIN,
      });
    } catch (err) {
      // Degraded staging can keep-open the CERTIFICATION leg too; the same
      // second-instance replay covers both windows (#631 — same transferId).
      if (!isPossiblyCommittedSendOutcome(err)) throw err;
      logStep(`crash-window: certification keep-open (${(err as Error).message.slice(0, 80)}…)`);
    }
    if (sendResult !== null) {
      // Certification succeeded, both delivery attempts failed: the send resolves
      // with the blob JOURNALED, never lost and never re-certified.
      expect(sendResult.deliveryPending).toBe(true);
      expect(sendResult.status).toBe('confirmed');
      const journaled = await createMachineStores(cKv).deliveryJournal.list();
      expect(journaled).toHaveLength(1);
      expect(journaled[0]?.transferId).toBe(sendResult.id);
      expect(journaled[0]?.recipientPubkey).toBe(d.identity.chainPubkey);
    }

    // Simulated crash: instance 1 goes away; instance 2 rises on the SAME kv + identity.
    await c1.facade.stop();
    let c2 = await makeVerticalWallet('c', { identity: cIdentity, kv: cKv });

    const dPaid = async (): Promise<boolean> => {
      await d.facade.receive().catch(() => undefined);
      return localTotal(d) === 500n && (await serverTotal(d)) === 500n;
    };
    try {
      await drainUntil(d, async () => localTotal(d) === 500n && (await serverTotal(d)) === 500n, 120_000, 'D paid via journal replay');
    } catch {
      // Still degraded: keep replaying the SAME journals/intents, paced.
      logStep('crash-window: second instance did not converge in one window — paced replay cycles');
      c2 = await convergeByReplay(c2, dPaid, SEND_CONVERGE_MS, 'crash-window replay');
    }
    await waitFor(c2, async () => (await createMachineStores(cKv).deliveryJournal.list()).length === 0, 60_000, 'C journal drained');
    await waitFor(c2, async () => (await openIntentIds(c2)).length === 0, 60_000, 'C open intents empty');
    expect(await serverTotal(c2)).toBe(0n);

    // No double delivery: a further 10 s drain window changes NOTHING for D.
    await sleep(10_000);
    await d.facade.receive().catch(() => undefined);
    expect(localTotal(d)).toBe(500n);
    expect(await serverTotal(d)).toBe(500n);
    expect((await activeRows(d)).map((r) => r.tokenId)).toEqual([genesis]);
    expect(await receivedLegs(d, genesis)).toHaveLength(1);
  }, 3_000_000);
});
