/**
 * Incremental history hydration (#642): the first hydration for an owner pages
 * the §10 server log to the end; steady-state re-hydrations (the 30s inventory
 * resync) stop at the first non-empty page holding nothing new and MERGE into
 * the cache. Before this, every resync re-paginated from page 0 — on a wallet
 * whose history overflows MAX_HISTORY_HYDRATION_PAGES that was 100 pages of
 * GET /v1/history every 30 seconds, forever (the swap-wallet request storm).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createPaymentsModule, type PaymentsModule, type PaymentsModuleDependencies, type WalletApiHistoryRecord, type PaymentsWalletApiPort } from '../../../modules/payments/PaymentsModule';
import type { FullIdentity } from '../../../types';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase } from '../../../storage';
import { testIdentity } from '../../support/wallet-api-test-helpers';

const UCT = '11'.repeat(32);
const OWNER_A = testIdentity(81);
const OWNER_B = testIdentity(82);

function fullIdentity(id: { privateKey: string; chainPubkey: string }): FullIdentity {
  return {
    chainPubkey: id.chainPubkey,
    privateKey: id.privateKey,
    directAddress: `DIRECT://${id.chainPubkey.slice(0, 12)}`,
    transportPubkey: id.chainPubkey.slice(2),
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

function mockTransport(): TransportProvider {
  return {
    sendTokenTransfer: vi.fn(), onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn().mockResolvedValue(null), resolveTransportPubkeyInfo: vi.fn().mockResolvedValue(null),
    connect: vi.fn(), disconnect: vi.fn(), isConnected: () => true,
  } as unknown as TransportProvider;
}

function mockOracle(): OracleProvider {
  return { validateToken: vi.fn().mockResolvedValue({ valid: true }), isDevMode: () => false } as unknown as OracleProvider;
}

function mockLocalTokenStorage(): TokenStorageProvider<TxfStorageDataBase> {
  return {
    id: 'local', name: 'local', type: 'local',
    connect: vi.fn(), disconnect: vi.fn(), isConnected: () => true,
    getStatus: () => 'connected', setIdentity: vi.fn(),
    initialize: vi.fn().mockResolvedValue(true), shutdown: vi.fn(),
    save: vi.fn(async () => ({ success: true, timestamp: 0 })),
    load: vi.fn(async () => ({ success: false, source: 'local', timestamp: 0 })),
    sync: vi.fn(async () => ({ success: true, added: 0, removed: 0, conflicts: 0 })),
  } as unknown as TokenStorageProvider<TxfStorageDataBase>;
}

function record(n: number): WalletApiHistoryRecord {
  return {
    dedupKey: `dk-${n}`,
    id: `h-${n}`,
    type: 'RECEIVED',
    ts: new Date(1_700_000_000_000 + n * 1000).toISOString(),
    assets: [{ coinId: UCT, amount: String(n) }],
  };
}

/**
 * A §10 log stub paging NEWEST-FIRST over `records[0..]` with an index-based
 * keyset cursor — exactly the listHistory contract the client provides.
 * Prepend new records to the FRONT of `records` (newest first).
 */
function pagedWalletApi(records: WalletApiHistoryRecord[], pageSize: number) {
  const listHistory = vi.fn(async (options?: { before?: string }) => {
    const start = options?.before !== undefined ? Number(options.before) : 0;
    const page = records.slice(start, start + pageSize);
    const more = start + pageSize < records.length;
    return { records: page, more, cursor: more ? String(start + pageSize) : null, syncEpoch: 0n };
  });
  return { listHistory, port: { listHistory } as unknown as PaymentsWalletApiPort };
}

function makeDeps(who: { privateKey: string; chainPubkey: string }, walletApi: PaymentsWalletApiPort): PaymentsModuleDependencies {
  return {
    identity: fullIdentity(who),
    storage: mockStorage(),
    tokenStorageProviders: new Map([['local', mockLocalTokenStorage()]]),
    transport: mockTransport(),
    oracle: mockOracle(),
    emitEvent: vi.fn(),
    walletApi,
  };
}

function makeModule(deps: PaymentsModuleDependencies): PaymentsModule {
  const module = createPaymentsModule({ l1: null });
  module.initialize(deps);
  cleanups.push(() => module.destroy());
  return module;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe('hydrateHistoryFromServer — incremental fast path (#642)', () => {
  it('first hydration pages to the end; a no-change resync stops at page 0', async () => {
    const records = [5, 4, 3, 2, 1].map(record); // newest first
    const { listHistory, port } = pagedWalletApi(records, 2);
    const module = makeModule(makeDeps(OWNER_A, port));

    await module.load();
    expect(listHistory).toHaveBeenCalledTimes(3); // 2+2+1, paged to the end
    expect(module.getHistory()).toHaveLength(5);

    await module.load();
    expect(listHistory).toHaveBeenCalledTimes(4); // ONE page: all known → stop
    expect(module.getHistory()).toHaveLength(5);
  });

  it('a resync after new records pulls only until the first fully-known page and merges', async () => {
    const records = [5, 4, 3, 2, 1].map(record);
    const { listHistory, port } = pagedWalletApi(records, 2);
    const module = makeModule(makeDeps(OWNER_A, port));
    await module.load(); // 3 calls

    records.unshift(record(6)); // one new entry lands server-side
    await module.load();
    // page 0 (dk-6, dk-5) has something new → continue; page 1 (dk-4, dk-3)
    // fully known → stop. NOT a full re-pagination.
    expect(listHistory).toHaveBeenCalledTimes(3 + 2);
    const history = module.getHistory();
    expect(history).toHaveLength(6);
    expect(history[0].dedupKey).toBe('dk-6'); // newest first (getHistory sorts)
  });

  it('merging keeps local-only entries whose §10 POST has not landed server-side', async () => {
    const records = [3, 2, 1].map(record);
    const { port } = pagedWalletApi(records, 2);
    const module = makeModule(makeDeps(OWNER_A, port));
    await module.load();

    // A local entry not (yet) on the server — e.g. its history POST failed.
    (module as unknown as { _historyCache: unknown[] })._historyCache.push({
      id: 'h-local', dedupKey: 'dk-local', type: 'SENT', amount: '9',
      coinId: UCT, symbol: 'UCT', timestamp: 1_700_000_099_000,
    });

    await module.load(); // incremental resync (nothing new server-side)
    const keys = module.getHistory().map((e) => e.dedupKey);
    expect(keys).toContain('dk-local'); // merge preserved it
    expect(keys).toHaveLength(4);
  });

  it('an owner switch re-initializes the fast path — the new owner gets a full hydration', async () => {
    const recordsA = [2, 1].map(record);
    const apiA = pagedWalletApi(recordsA, 2);
    const module = makeModule(makeDeps(OWNER_A, apiA.port));
    await module.load();
    expect(apiA.listHistory).toHaveBeenCalledTimes(1);

    const recordsB = [12, 11, 10].map(record);
    const apiB = pagedWalletApi(recordsB, 1);
    module.initialize(makeDeps(OWNER_B, apiB.port)); // address switch resets per-address state
    await module.load();
    expect(apiB.listHistory).toHaveBeenCalledTimes(3); // FULL pagination for the new owner
    expect(module.getHistory()).toHaveLength(3);
  });

  it('a pull cut off by the page cap replaces (no silent gap), and the next resync is cheap again', async () => {
    // 250 records, page size 1 → the first pull stops at the 100-page cap.
    const records = Array.from({ length: 250 }, (_, i) => record(250 - i));
    const { listHistory, port } = pagedWalletApi(records, 1);
    const module = makeModule(makeDeps(OWNER_A, port));

    await module.load();
    expect(listHistory).toHaveBeenCalledTimes(100); // capped
    expect(module.getHistory()).toHaveLength(100); // newest cap window, like before

    await module.load(); // steady state: page 0 known → stop
    expect(listHistory).toHaveBeenCalledTimes(101);
    expect(module.getHistory()).toHaveLength(100); // merge kept the window intact
  });

  it('every 20th incremental pull is forced back to a FULL re-pull (staleness bound)', async () => {
    const records = [5, 4, 3, 2, 1].map(record);
    const { listHistory, port } = pagedWalletApi(records, 2);
    const module = makeModule(makeDeps(OWNER_A, port));

    await module.load(); // full: 3 pages
    expect(listHistory).toHaveBeenCalledTimes(3);

    for (let i = 0; i < 20; i++) await module.load(); // incremental: 1 page each
    expect(listHistory).toHaveBeenCalledTimes(3 + 20);

    await module.load(); // 21st resync: counter exhausted → FULL re-pagination
    expect(listHistory).toHaveBeenCalledTimes(3 + 20 + 3);

    await module.load(); // ...and the fast path resumes
    expect(listHistory).toHaveBeenCalledTimes(3 + 20 + 3 + 1);
  });

  it('a hydration failure keeps the cache and stays on the full-pull path for the next load', async () => {
    const records = [2, 1].map(record);
    const { listHistory, port } = pagedWalletApi(records, 2);
    const failing = {
      listHistory: vi.fn(async () => { throw new Error('backend down'); }),
    } as unknown as PaymentsWalletApiPort;

    const module = makeModule(makeDeps(OWNER_A, failing));
    await module.load(); // hydration fails, load() itself must not
    expect(module.getHistory()).toHaveLength(0);

    // Swap in a working port (same module/owner) — still a FULL pull, because
    // the failed one never completed.
    module.initialize(makeDeps(OWNER_A, port));
    await module.load();
    expect(listHistory).toHaveBeenCalledTimes(1);
    expect(module.getHistory()).toHaveLength(2);
  });
});
