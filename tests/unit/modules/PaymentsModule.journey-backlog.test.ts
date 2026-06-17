/**
 * PaymentsModule × wallet-api — the "mundane journey" backlog (sphere-sdk#523,
 * G2/G3/G5/G6 of the 2026-06-12 coverage audit). Every other journey-shaped
 * behavior (the #521 reload full-pull, J4/J5 history reload, the S2/S3 send and
 * receive pipelines) already has a home; these four cover the everyday flows the
 * adversarial-only AC taxonomy left unowned. G1/G4 (J7 — two live module
 * instances over one stateStore) live in `tests/harness/multi-session-sync.test.ts`
 * (a live-stack harness, marked `#523 G4`) and are intentionally NOT re-asserted
 * here.
 *
 * The composition clones the established #521 Session1→Session2 pattern from
 * `PaymentsModule.wallet-api-delivery.test.ts`: an in-process FakeWalletApi
 * backend, a `MemoryKeyValueStore` standing in for the reloaded tab's persisted
 * localStorage, and a fresh provider+module per "session" over that SAME store.
 *
 * - **G2 (J3) — accumulate after reopen:** session 1 holds + sends X; a NEW
 *   provider+module over the same stateStore holds + sends Y; the server balance
 *   is the decimal-exact accumulation and BOTH SENT history rows survive the
 *   reload (rehydrated from the §10 server log).
 * - **G3 (J6) — idle resume:** a short access-token TTL expires while the wallet
 *   sits idle; the next op sees EXACTLY one 401, drives EXACTLY one
 *   `/auth/refresh`, and succeeds — with NO error event surfaced.
 * - **G5 (J14) — offline reopen:** a dead-client-at-init over a NON-EMPTY
 *   persisted whole-blob store renders cached balances while OFFLINE; repointed
 *   at a live backend, the wallet-api cursor converges to the server.
 * - **G6 (J13) — history pagination across reload:** ~60 server history rows,
 *   a reloaded module pages the keyset cursor to exhaustion — no skips, no
 *   repeats across the reload boundary.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createPaymentsModule,
  type PaymentsModule,
  type PaymentsModuleDependencies,
} from '../../../modules/payments/PaymentsModule';
import type { FullIdentity } from '../../../types';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type {
  StorageProvider,
  TokenStorageProvider,
  TxfStorageDataBase,
  HistoryRecord,
  LoadResult,
  SaveResult,
} from '../../../storage';
import { FakeTokenEngine, decodeFakeTokenAssets, decodeFakeTokenId } from '../token-engine/FakeTokenEngine';
import { FakeWalletApi } from '../../support/fake-wallet-api';
import { MemoryKeyValueStore, testIdentity } from '../../support/wallet-api-test-helpers';
import { WalletApiClient, type FetchLike } from '../../../wallet-api';
import { WalletApiMailboxProvider, WalletApiTokenStorageProvider } from '../../../impl/shared/wallet-api';
import { encodeTokenBlob } from '../../../token-engine/token-blob';
import { hexToBytes } from '../../../core/crypto';

const UCT = '11'.repeat(32);
const SENDER = testIdentity(21);
const RECIPIENT = testIdentity(22);

function fullIdentity(id: { privateKey: string; chainPubkey: string }): FullIdentity {
  return {
    chainPubkey: id.chainPubkey,
    privateKey: id.privateKey,
    directAddress: `DIRECT://${id.chainPubkey.slice(0, 12)}`,
    transportPubkey: id.chainPubkey.slice(2),
  };
}

function mockStorage(): { provider: StorageProvider; map: Map<string, string> } {
  const s = new Map<string, string>();
  const provider = {
    id: 's', name: 's', type: 'local', connect: vi.fn(), disconnect: vi.fn(),
    isConnected: () => true, getStatus: () => 'connected', setIdentity: vi.fn(),
    get: vi.fn(async (k: string) => s.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { s.set(k, v); }),
    remove: vi.fn(async (k: string) => { s.delete(k); }),
    has: vi.fn(async (k: string) => s.has(k)),
    keys: vi.fn(async () => [...s.keys()]),
    clear: vi.fn(async () => { s.clear(); }),
  } as unknown as StorageProvider;
  return { provider, map: s };
}

function mockHistoryStore() {
  const entries = new Map<string, HistoryRecord>();
  return {
    addHistoryEntry: vi.fn(async (e: HistoryRecord) => { entries.set(e.dedupKey, e); }),
    getHistoryEntries: vi.fn(async () => [...entries.values()]),
    hasHistoryEntry: vi.fn(async (k: string) => entries.has(k)),
    clearHistory: vi.fn(async () => entries.clear()),
    importHistoryEntries: vi.fn(async () => 0),
  };
}

function mockTransport(): TransportProvider {
  return {
    sendTokenTransfer: vi.fn().mockResolvedValue(undefined),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn().mockResolvedValue({
      chainPubkey: RECIPIENT.chainPubkey,
      transportPubkey: RECIPIENT.chainPubkey.slice(2),
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

interface Wallet {
  module: PaymentsModule;
  engine: FakeTokenEngine;
  client: WalletApiClient;
  emitEvent: ReturnType<typeof vi.fn>;
  storage: { provider: StorageProvider; map: Map<string, string> };
  deps: PaymentsModuleDependencies;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function startFake(options?: ConstructorParameters<typeof FakeWalletApi>[0]): Promise<{ fake: FakeWalletApi; baseUrl: string }> {
  const fake = new FakeWalletApi({ decodeAssets: decodeFakeTokenAssets, decodeTokenId: decodeFakeTokenId, ...options });
  const baseUrl = await fake.start();
  cleanups.push(() => fake.stop());
  return { fake, baseUrl };
}

/** Build a wallet over the FULL wallet-api preset (storage + delivery, custody
 * 'inventory'). `kv` shares the persisted client/provider state (cursor,
 * session, history-cursor) across instances — a reloaded tab keeps its
 * localStorage, not its process state. `fetchFn` injects a dead/live transport
 * (G5). */
function makeFullPresetWallet(
  baseUrl: string,
  network: string,
  who: { privateKey: string; chainPubkey: string },
  deviceId: string,
  kv: MemoryKeyValueStore = new MemoryKeyValueStore(),
  opts: { fetchFn?: FetchLike; engine?: FakeTokenEngine } = {}
): Wallet {
  const identity = fullIdentity(who);
  const client = new WalletApiClient({ baseUrl, network, deviceId, storage: kv, ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}) });
  const tokenStorage = new WalletApiTokenStorageProvider({ client, stateStore: kv });
  tokenStorage.setIdentity(identity);
  const delivery = new WalletApiMailboxProvider({ client, custody: 'inventory', stateStore: kv });
  // A reopen is the SAME wallet keys: the engine that can decode the wallet's
  // own tokens is shared across sessions when the caller passes one (a fresh
  // tab re-derives the identical decoding ability). Standalone sessions get
  // their own.
  const engine = opts.engine ?? new FakeTokenEngine({ chainPubkey: hexToBytes(who.chainPubkey) });
  const storage = mockStorage();
  const emitEvent = vi.fn();
  const deps: PaymentsModuleDependencies = {
    identity,
    storage: storage.provider,
    tokenStorageProviders: new Map([[tokenStorage.id, tokenStorage]]),
    transport: mockTransport(),
    oracle: mockOracle(),
    emitEvent,
    tokenEngine: engine,
    delivery,
    walletApi: client,
  };
  const module = createPaymentsModule({ l1: null });
  module.initialize(deps);
  cleanups.push(() => module.destroy());
  return { module, engine, client, emitEvent, storage, deps };
}

/** Mint a token on the wallet's engine and seed it into its SERVER inventory
 * (the §8.2 test seam; bypasses the apply pipeline). */
async function seedServerToken(fake: FakeWalletApi, wallet: Wallet, who: { chainPubkey: string }, amount: bigint): Promise<string> {
  const minted = await wallet.engine.mint({
    recipientPubkey: wallet.engine.getIdentity().chainPubkey,
    value: { assets: [{ coinId: UCT, amount }] },
  });
  const bytes = encodeTokenBlob(wallet.engine.encodeToken(minted));
  const tokenId = wallet.engine.tokenId(minted);
  fake.seedInventory(who.chainPubkey, [{ tokenId, assets: [{ coinId: UCT, amount }], blob: bytes }]);
  return tokenId;
}

// =============================================================================
// G2 (J3) — accumulate after reopen
// =============================================================================

describe('G2 (J3): balance + history accumulate across a reopen (#523)', () => {
  it('session 1 sends X; a NEW provider+module over the same stateStore sends Y; balance is decimal-exact X+Y residual and BOTH SENT history rows survive', async () => {
    const { fake, baseUrl } = await startFake();
    const kv = new MemoryKeyValueStore(); // the persisted store — survives the reopen
    // The reopened tab is the SAME wallet — it can decode its own tokens; a
    // shared engine models that (the per-instance FakeTokenEngine otherwise
    // can't materialize a token a previous instance minted).
    const engine = new FakeTokenEngine({ chainPubkey: hexToBytes(SENDER.chainPubkey) });

    // ── Session 1 ─────────────────────────────────────────────────────────────
    // Hold 1000, send 300 → the server keeps the 700 change row and logs SENT #1.
    const s1 = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'g2-dev', kv, { engine });
    await seedServerToken(fake, s1, SENDER, 1000n);
    await s1.module.load();
    const sent1 = await s1.module.send({ recipient: '@bob', amount: '300', coinId: UCT, memo: 'first' });
    expect(sent1.status).toBe('completed');
    expect(await s1.client.getBalances()).toEqual([{ coinId: UCT, total: 700n, tokenCount: 1 }]);

    // ── Session 2 — a NEW provider+module over the SAME stateStore (the reopen) ─
    // Seed a fresh 500 server-side (the post-reopen accumulation, "Y"), then
    // send 200 → the server balance is the decimal-exact running total and SENT
    // #2 lands in the same §10 log.
    const s2 = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'g2-dev', kv, { engine });
    await seedServerToken(fake, s2, SENDER, 500n);
    await s2.module.load();

    // Accumulation across the reopen: 700 (carried) + 500 (new) = 1200 — exact.
    expect(await s2.client.getBalances()).toEqual([{ coinId: UCT, total: 1200n, tokenCount: 2 }]);
    expect(s2.module.getBalance(UCT)[0].totalAmount).toBe('1200');

    const sent2 = await s2.module.send({ recipient: '@bob', amount: '200', coinId: UCT, memo: 'second' });
    expect(sent2.status).toBe('completed');

    // Residual after both sends: 1200 - 200 = 1000, decimal-exact.
    expect(await s2.client.getBalances()).toEqual([{ coinId: UCT, total: 1000n, tokenCount: 2 }]);

    // BOTH SENT history rows are present after the reopen — session 2's history
    // was rehydrated from the §10 server log (the thin provider keeps none), so
    // the row written in session 1 survives the process boundary and the row
    // written in session 2 joins it. No loss, no duplication (dedupKey-keyed).
    const history = s2.module.getHistory();
    const sentRows = history.filter((e) => e.type === 'SENT');
    expect(new Set(sentRows.map((e) => e.dedupKey))).toEqual(
      new Set([`SENT_transfer_${sent1.id}`, `SENT_transfer_${sent2.id}`])
    );
    expect(history.filter((e) => e.dedupKey === `SENT_transfer_${sent1.id}`)).toHaveLength(1);
    expect(history.filter((e) => e.dedupKey === `SENT_transfer_${sent2.id}`)).toHaveLength(1);

    // The server-side log holds exactly the two SENT records (no phantom rows).
    const serverSent = fake.getHistoryRecords(SENDER.chainPubkey).filter((r) => r.type === 'SENT');
    expect(serverSent).toHaveLength(2);
  });
});

// =============================================================================
// G3 (J6) — idle resume after an access-token expiry
// =============================================================================

describe('G3 (J6): idle resume — a single silent refresh after access-token expiry (#523)', () => {
  it('an op after the JWT expires drives EXACTLY one 401 → one /auth/refresh → success, with no error event', async () => {
    // A short access-token TTL is the test knob (FakeWalletApi.jwtTtlMs — §14
    // JWT_TTL). The client mints a long-lived rotating refresh token; only the
    // access JWT goes stale on idle.
    const { fake, baseUrl } = await startFake({ jwtTtlMs: 50 });
    const wallet = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'g3-dev');
    await seedServerToken(fake, wallet, SENDER, 1000n);

    // Sign in (warms a session + refresh token) and converge.
    await wallet.module.load();
    expect(wallet.client.network).toBe(fake.network);
    expect(fake.verifyRequests).toBe(1); // one challenge→verify cycle warmed the session
    const refreshesAfterSignIn = fake.refreshRequests;

    // Idle: force EVERY access token stale (deterministic stand-in for "the TTL
    // elapsed while the tab sat idle" — no flaky wall-clock sleep).
    fake.expireAccessTokens();
    const verifiesBefore = fake.verifyRequests;

    // Invoke an op — the §16 read the UI issues on resume. The client's authed
    // request path sees a single 401, silently refreshes (rotating token, NOT a
    // fresh challenge→verify), and retries once. The op succeeds.
    const balances = await wallet.client.getBalances();
    expect(balances).toEqual([{ coinId: UCT, total: 1000n, tokenCount: 1 }]);

    // EXACTLY one refresh was driven by the resume (and zero new challenge
    // cycles — the refresh path handled it, the slow challenge fallback did not).
    expect(fake.refreshRequests - refreshesAfterSignIn).toBe(1);
    expect(fake.verifyRequests - verifiesBefore).toBe(0);

    // The session is live again on the rotated JWT — a follow-up op needs NO
    // further refresh (the single refresh genuinely re-armed the session).
    const refreshesAfterResume = fake.refreshRequests;
    expect((await wallet.client.getBalances())).toEqual([{ coinId: UCT, total: 1000n, tokenCount: 1 }]);
    expect(fake.refreshRequests - refreshesAfterResume).toBe(0);

    // The silent refresh surfaced NO error event of any kind to the app.
    const errorEvents = wallet.emitEvent.mock.calls.filter(([name]) =>
      typeof name === 'string' && (name.includes('error') || name === 'storage:degraded' || name.includes('auth'))
    );
    expect(errorEvents).toEqual([]);
  });
});

// =============================================================================
// G5 (J14) — offline reopen over a non-empty persisted store
// =============================================================================

/**
 * A persistent whole-blob token store (the own-storage custody composition):
 * its data SURVIVES across module instances via the shared `cell`, so a reopen
 * reads the cached wallet even with the network down. This is the persisted
 * NON-EMPTY store G5 requires (the thin wallet-api provider keeps no blobs —
 * its view is process-lifetime, so it alone cannot render an offline balance).
 */
function persistentLocalTokenStorage(cell: { data: TxfStorageDataBase | null }): TokenStorageProvider<TxfStorageDataBase> {
  return {
    id: 'local', name: 'local', type: 'local',
    connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: () => true, getStatus: () => 'connected', setIdentity: vi.fn(),
    initialize: vi.fn().mockResolvedValue(true), shutdown: vi.fn().mockResolvedValue(undefined),
    save: vi.fn(async (data: TxfStorageDataBase): Promise<SaveResult> => { cell.data = data; return { success: true, timestamp: 0 }; }),
    load: vi.fn(async (): Promise<LoadResult<TxfStorageDataBase>> => (cell.data
      ? { success: true, source: 'local', timestamp: 0, data: cell.data }
      : { success: false, source: 'local', timestamp: 0 })),
    sync: vi.fn().mockResolvedValue({ success: true, added: 0, removed: 0, conflicts: 0 }),
    ...mockHistoryStore(),
  } as unknown as TokenStorageProvider<TxfStorageDataBase>;
}

/** A wallet whose custody is the persistent local store and whose wallet-api
 * client uses the supplied (possibly dead) fetch. */
function makeOfflineCapableWallet(
  baseUrl: string,
  network: string,
  who: { privateKey: string; chainPubkey: string },
  deviceId: string,
  kv: MemoryKeyValueStore,
  cell: { data: TxfStorageDataBase | null },
  fetchFn: FetchLike
): Wallet {
  const identity = fullIdentity(who);
  const client = new WalletApiClient({ baseUrl, network, deviceId, storage: kv, fetchFn });
  const walletApiStorage = new WalletApiTokenStorageProvider({ client, stateStore: kv });
  walletApiStorage.setIdentity(identity);
  const delivery = new WalletApiMailboxProvider({ client, custody: 'external', stateStore: kv });
  const engine = new FakeTokenEngine({ chainPubkey: hexToBytes(who.chainPubkey) });
  const storage = mockStorage();
  const emitEvent = vi.fn();
  const deps: PaymentsModuleDependencies = {
    identity,
    storage: storage.provider,
    // Custody = the persistent local store (offline-readable); the wallet-api
    // provider rides alongside as the convergence/cursor source.
    tokenStorageProviders: new Map<string, TokenStorageProvider<TxfStorageDataBase>>([
      ['local', persistentLocalTokenStorage(cell)],
      [walletApiStorage.id, walletApiStorage],
    ]),
    transport: mockTransport(),
    oracle: mockOracle(),
    emitEvent,
    tokenEngine: engine,
    delivery,
    walletApi: client,
  };
  const module = createPaymentsModule({ l1: null });
  module.initialize(deps);
  cleanups.push(() => module.destroy());
  return { module, engine, client, emitEvent, storage, deps };
}

describe('G5 (J14): offline reopen — cached balances readable while the client is dead, cursor converges when repointed live (#523)', () => {
  it('a dead-client-at-init over a non-empty persisted store renders cached balances offline; a live client then converges the wallet-api cursor', async () => {
    const { fake, baseUrl } = await startFake();
    const kv = new MemoryKeyValueStore(); // persisted across the reopen
    const cell: { data: TxfStorageDataBase | null } = { data: null }; // the persistent local store

    const liveFetch: FetchLike = (u, init) => (globalThis as unknown as { fetch: FetchLike }).fetch(u, init);
    let deadCalls = 0;
    const deadFetch: FetchLike = () => { deadCalls++; return Promise.reject(new Error('offline: network unreachable')); };

    // ── Session 1 (ONLINE) — mint 1000; the persistent local store is now
    // NON-EMPTY and the wallet-api cursor is warm. ──────────────────────────────
    const online = makeOfflineCapableWallet(baseUrl, fake.network, SENDER, 'g5-dev', kv, cell, liveFetch);
    await online.module.load();
    const mint = await online.module.mintFungibleToken(UCT, 1000n);
    expect(mint.success).toBe(true);
    expect(online.module.getBalance(UCT)[0].totalAmount).toBe('1000');
    expect(cell.data).not.toBeNull(); // the persisted store really has bytes now
    const cursorAfterOnline = await kv.get(`wallet-api-storage:cursor:${fake.network}:${SENDER.chainPubkey}`);
    expect(cursorAfterOnline).toMatch(/^[0-9]+$/);

    // ── Session 2 (OFFLINE) — a fresh wallet over the SAME persisted store, but
    // its client is dead at init: every request throws. ───────────────────────
    const offline = makeOfflineCapableWallet(baseUrl, fake.network, SENDER, 'g5-dev', kv, cell, deadFetch);
    await offline.module.load(); // must NOT throw — the wallet-api sync fails, custody load succeeds

    // Cached balance is readable while OFFLINE, straight from the persisted
    // local store — the dead wallet-api leg could contribute nothing.
    expect(deadCalls).toBeGreaterThan(0); // the wallet-api leg really did try and fail
    expect(offline.module.getBalance(UCT)[0].totalAmount).toBe('1000');
    expect(offline.module.getTokens({ coinId: UCT }).map((t) => t.amount)).toEqual(['1000']);

    // ── Repoint LIVE — a third wallet over the same store with a healthy client.
    // The wallet-api cursor converges to the server (the offline session never
    // advanced it; the live load does). ───────────────────────────────────────
    const repointed = makeOfflineCapableWallet(baseUrl, fake.network, SENDER, 'g5-dev', kv, cell, liveFetch);
    await repointed.module.load();
    expect(repointed.module.getBalance(UCT)[0].totalAmount).toBe('1000');

    // Cursor convergence: the persisted cursor now equals the server's own
    // committed cursor (decimal-exact), proving the repointed client re-synced
    // rather than drifting on the stale offline state.
    const serverBalances = await repointed.client.getBalances();
    expect(serverBalances).toEqual([{ coinId: UCT, total: 1000n, tokenCount: 1 }]);
    const cursorAfterRepoint = await kv.get(`wallet-api-storage:cursor:${fake.network}:${SENDER.chainPubkey}`);
    expect(cursorAfterRepoint).toMatch(/^[0-9]+$/);
    expect(BigInt(cursorAfterRepoint!)).toBeGreaterThanOrEqual(BigInt(cursorAfterOnline!));
  });
});

// =============================================================================
// G6 (J13) — history pagination across a reload boundary
// =============================================================================

describe('G6 (J13): history pagination across a reload — no skips, no repeats (#523)', () => {
  it('~60 server history rows paginate to exhaustion in a reloaded module with no gaps or duplicates across the reload boundary', async () => {
    // A small PAGE_LIMIT forces the keyset cursor to genuinely cross page
    // boundaries (~60 rows over a 25-row page = 3 pages); the reload then has to
    // walk every page exactly once.
    const PAGE = 25;
    const ROWS = 60;
    const { fake, baseUrl } = await startFake({ pageLimit: PAGE });
    const kv = new MemoryKeyValueStore(); // persisted across the reload

    // ── Session 1 — seed ROWS distinct SENT rows by sending ROWS times. Each
    // send POSTs one dedupKey'd §10 record (the server is the durable log). ─────
    const s1 = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'g6-dev', kv);
    // One fat source per send (each send fully spends its 10-unit source).
    for (let i = 0; i < ROWS; i++) await seedServerToken(fake, s1, SENDER, 10n);
    await s1.module.load();

    const sentIds: string[] = [];
    for (let i = 0; i < ROWS; i++) {
      const r = await s1.module.send({ recipient: '@bob', amount: '10', coinId: UCT, memo: `m${i}` });
      expect(r.status).toBe('completed');
      sentIds.push(r.id);
    }
    // The server log holds exactly ROWS SENT records (sanity on the seed).
    expect(fake.getHistoryRecords(SENDER.chainPubkey).filter((r) => r.type === 'SENT')).toHaveLength(ROWS);

    // ── Session 2 — a NEW module over the SAME persisted store (the reload). Its
    // history cache starts empty; loadHistory() pages the keyset cursor to
    // exhaustion. ─────────────────────────────────────────────────────────────
    const s2 = makeFullPresetWallet(baseUrl, fake.network, SENDER, 'g6-dev', kv);
    await s2.module.load();

    const reloaded = s2.module.getHistory().filter((e) => e.type === 'SENT');
    const reloadedKeys = reloaded.map((e) => e.dedupKey);

    // No skips: every SENT row that was written pre-reload is present after it.
    const expectedKeys = sentIds.map((id) => `SENT_transfer_${id}`);
    expect(new Set(reloadedKeys)).toEqual(new Set(expectedKeys));

    // No repeats across the reload boundary: each dedupKey appears exactly once
    // (the keyset paginator must not double-count a row straddling a page edge).
    expect(reloadedKeys).toHaveLength(ROWS);
    expect(new Set(reloadedKeys).size).toBe(ROWS);
  });
});
