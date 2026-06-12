/**
 * Incident 2026-06-12 regression suite (#515 / #516):
 *
 * - #515 F1 — fail-closed composition invariant: wallet-api CUSTODY artifacts
 *   (thin storage provider, delivery custody 'inventory') without the
 *   wallet-api client refuse to initialize (INVALID_CONFIG) instead of
 *   silently running local-custody semantics. Every composition.ts preset
 *   still initializes.
 * - #515 F2 — unchecked SaveResult: the ACTIVE custody provider returning
 *   `{success:false}` fails user-facing flows (mint), and surfaces
 *   `storage:degraded` on background writes — never a silent success.
 * - #516 — double-pay hazard: a send whose `putIntent` dies on a dead backend
 *   marks the LOCAL intent 'aborted'; after reconnect, `resumeOpenIntents`
 *   executes NOTHING and the resync lands the intent as aborted (no-op
 *   execution-wise).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createPaymentsModule, type PaymentsModuleDependencies } from '../../../modules/payments/PaymentsModule';
import type { FullIdentity, Token } from '../../../types';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase, HistoryRecord } from '../../../storage';
import { FakeTokenEngine, decodeFakeTokenAssets, decodeFakeTokenId } from '../token-engine/FakeTokenEngine';
import { FakeWalletApi } from '../../support/fake-wallet-api';
import { MemoryKeyValueStore, testIdentity } from '../../support/wallet-api-test-helpers';
import { WalletApiClient } from '../../../wallet-api';
import type { FetchLike } from '../../../wallet-api';
import { WalletApiMailboxProvider, WalletApiTokenStorageProvider } from '../../../impl/shared/wallet-api';
import { hexToBytes } from '../../../core/crypto';
import { SphereError } from '../../../core/errors';

const UCT = '11'.repeat(32);
const SENDER = testIdentity(21);
const RECIPIENT = testIdentity(22);

// A dead, never-contacted backend (F1/F2 tests construct clients only).
const DEAD_URL = 'http://127.0.0.1:9';
const NETWORK = 'testnet2';

function fullIdentity(id: { privateKey: string; chainPubkey: string }): FullIdentity {
  return {
    chainPubkey: id.chainPubkey,
    privateKey: id.privateKey,
    l1Address: `alpha1${id.chainPubkey.slice(0, 8)}`,
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

/** Local whole-blob provider mock (the own-storage / fully-local custody). */
function mockLocalTokenStorage(): TokenStorageProvider<TxfStorageDataBase> {
  let lastSaved: TxfStorageDataBase | null = null;
  return {
    id: 'local', name: 'local', type: 'local',
    connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: () => true, getStatus: () => 'connected', setIdentity: vi.fn(),
    initialize: vi.fn().mockResolvedValue(true), shutdown: vi.fn().mockResolvedValue(undefined),
    save: vi.fn(async (data: TxfStorageDataBase) => { lastSaved = data; return { success: true, timestamp: 0 }; }),
    load: vi.fn(async () => (lastSaved
      ? { success: true, source: 'local', timestamp: 0, data: lastSaved }
      : { success: false, source: 'local', timestamp: 0 })),
    sync: vi.fn().mockResolvedValue({ success: true, added: 0, removed: 0, conflicts: 0 }),
    ...mockHistoryStore(),
  } as unknown as TokenStorageProvider<TxfStorageDataBase>;
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

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  vi.restoreAllMocks();
});

interface DepsParts {
  client: WalletApiClient;
  thinStorage: WalletApiTokenStorageProvider;
  localStorage: TokenStorageProvider<TxfStorageDataBase>;
  emitEvent: ReturnType<typeof vi.fn>;
}

/** Base deps + the wallet-api parts, composed per test into a legality case. */
function makeParts(baseUrl = DEAD_URL): DepsParts {
  const kv = new MemoryKeyValueStore();
  const client = new WalletApiClient({ baseUrl, network: NETWORK, deviceId: 'd-fc', storage: kv });
  const thinStorage = new WalletApiTokenStorageProvider({ client, stateStore: kv });
  return { client, thinStorage, localStorage: mockLocalTokenStorage(), emitEvent: vi.fn() };
}

function makeDeps(
  parts: DepsParts,
  opts: {
    storage: TokenStorageProvider<TxfStorageDataBase>;
    custody?: 'inventory' | 'external';
    walletApi?: boolean;
  }
): PaymentsModuleDependencies {
  const kv = new MemoryKeyValueStore();
  const delivery =
    opts.custody !== undefined
      ? new WalletApiMailboxProvider({ client: parts.client, custody: opts.custody, stateStore: kv })
      : undefined;
  return {
    identity: fullIdentity(SENDER),
    storage: mockStorage(),
    tokenStorageProviders: new Map([[opts.storage.id, opts.storage]]),
    transport: mockTransport(),
    oracle: mockOracle(),
    emitEvent: parts.emitEvent,
    tokenEngine: new FakeTokenEngine({ chainPubkey: hexToBytes(SENDER.chainPubkey) }),
    delivery,
    walletApi: opts.walletApi ? parts.client : undefined,
  };
}

function initModule(deps: PaymentsModuleDependencies) {
  const module = createPaymentsModule({ l1: null });
  module.initialize(deps);
  cleanups.push(() => module.destroy());
  return module;
}

describe('#515 F1 — fail-closed composition invariant (S7 legality matrix)', () => {
  it('FULL preset (thin storage + custody inventory + walletApi) initializes', () => {
    const parts = makeParts();
    expect(() => initModule(makeDeps(parts, { storage: parts.thinStorage, custody: 'inventory', walletApi: true }))).not.toThrow();
  });

  it('OWN-STORAGE preset (local storage + custody external + walletApi) initializes', () => {
    const parts = makeParts();
    expect(() => initModule(makeDeps(parts, { storage: parts.localStorage, custody: 'external', walletApi: true }))).not.toThrow();
  });

  it('fully-local composition (no wallet-api artifacts, no client) initializes', () => {
    const parts = makeParts();
    expect(() => initModule(makeDeps(parts, { storage: parts.localStorage }))).not.toThrow();
  });

  it("own storage + custody 'external' WITHOUT walletApi stays legal (no custody artifact)", () => {
    const parts = makeParts();
    expect(() => initModule(makeDeps(parts, { storage: parts.localStorage, custody: 'external' }))).not.toThrow();
  });

  it("delivery custody 'inventory' without walletApi throws INVALID_CONFIG", () => {
    const parts = makeParts();
    const module = createPaymentsModule({ l1: null });
    let thrown: unknown;
    try {
      module.initialize(makeDeps(parts, { storage: parts.localStorage, custody: 'inventory' }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SphereError);
    expect((thrown as SphereError).code).toBe('INVALID_CONFIG');
    expect((thrown as SphereError).message).toMatch(/custody is 'inventory'.*walletApi/s);
  });

  it('an active thin storage provider without walletApi throws INVALID_CONFIG (any delivery)', () => {
    const parts = makeParts();
    const module = createPaymentsModule({ l1: null });
    let thrown: unknown;
    try {
      module.initialize(makeDeps(parts, { storage: parts.thinStorage }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SphereError);
    expect((thrown as SphereError).code).toBe('INVALID_CONFIG');
    expect((thrown as SphereError).message).toMatch(/wallet-api-token-storage.*walletApi/s);
  });

  it('the full degraded incident composition (thin storage + inventory delivery, no client) throws', () => {
    const parts = makeParts();
    const module = createPaymentsModule({ l1: null });
    expect(() =>
      module.initialize(makeDeps(parts, { storage: parts.thinStorage, custody: 'inventory' }))
    ).toThrow(SphereError);
  });
});

describe('#515 F2 — SaveResult.success is checked for the ACTIVE custody provider', () => {
  function failingSaveWallet() {
    const parts = makeParts();
    const deps = makeDeps(parts, { storage: parts.thinStorage, custody: 'inventory', walletApi: true });
    const module = initModule(deps);
    // The thin provider deliberately reports failure via {success:false}
    // (WalletApiTokenStorageProvider.save) instead of throwing.
    vi.spyOn(parts.thinStorage, 'save').mockResolvedValue({
      success: false,
      error: 'wallet-api save failed: backend down',
      timestamp: Date.now(),
    });
    return { parts, module };
  }

  it('mint reports FAILURE, not success, when the active provider cannot persist the blob', async () => {
    const { parts, module } = failingSaveWallet();
    const result = await module.mintFungibleToken(UCT, 100n);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('backend down');
    // The user-facing path THROWS instead of degrading silently.
    expect(parts.emitEvent).not.toHaveBeenCalledWith('storage:degraded', expect.anything());
  });

  it('a background save (public addToken) surfaces storage:degraded instead of silence', async () => {
    const { parts, module } = failingSaveWallet();
    const token: Token = {
      id: 'tok-degraded-1', coinId: UCT, symbol: 'UCT', name: 'UCT', decimals: 0,
      amount: '5', status: 'confirmed', createdAt: Date.now(), updatedAt: Date.now(),
    };
    const added = await module.addToken(token);
    expect(added).toBe(true);
    expect(parts.emitEvent).toHaveBeenCalledWith('storage:degraded', {
      providerId: 'wallet-api-token-storage',
      error: expect.stringContaining('backend down'),
    });
  });
});

describe('#516 — failed putIntent must NOT leave a re-executable open intent', () => {
  it('dead backend at putIntent → send fails cleanly → resume executes NOTHING → resync lands aborted', async () => {
    const fake = new FakeWalletApi({ decodeAssets: decodeFakeTokenAssets, decodeTokenId: decodeFakeTokenId });
    const baseUrl = await fake.start();
    cleanups.push(() => fake.stop());

    // A client whose transport can be killed underneath it — putIntent writes
    // the local backstop first, then the network PUT rejects (the incident
    // shape: client.ts wrote local BEFORE the server PUT).
    let dead = true;
    const fetchFn: FetchLike = (url, init) =>
      dead ? Promise.reject(new TypeError('fetch failed')) : (globalThis.fetch as unknown as FetchLike)(url, init);
    const kv = new MemoryKeyValueStore();
    const client = new WalletApiClient({ baseUrl, network: fake.network, deviceId: 'd-516', storage: kv, fetchFn });
    const delivery = new WalletApiMailboxProvider({ client, custody: 'external', stateStore: kv });
    const engine = new FakeTokenEngine({ chainPubkey: hexToBytes(SENDER.chainPubkey) });
    const emitEvent = vi.fn();
    const deps: PaymentsModuleDependencies = {
      identity: fullIdentity(SENDER),
      storage: mockStorage(),
      tokenStorageProviders: new Map([['local', mockLocalTokenStorage()]]),
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

    await module.load();
    const mint = await module.mintFungibleToken(UCT, 1000n);
    expect(mint.success).toBe(true);

    const transferSpy = vi.spyOn(engine, 'transfer');
    const splitSpy = vi.spyOn(engine, 'split');
    const putIntentSpy = vi.spyOn(client, 'putIntent');

    // Phase 1 — dead backend: the PUT rejects, the send fails CLEANLY with
    // nothing certified; the nothing-certified abort cannot land either.
    await expect(module.send({ recipient: '@bob', amount: '1000', coinId: UCT })).rejects.toThrow();
    expect(transferSpy).not.toHaveBeenCalled(); // E.3: engine never ran
    expect(splitSpy).not.toHaveBeenCalled();
    expect(putIntentSpy).toHaveBeenCalledTimes(1);
    const transferId = putIntentSpy.mock.calls[0][0];
    // The source is restored and spendable; nothing reached the mailbox.
    expect(module.getTokens()[0].status).toBe('confirmed');
    expect(fake.listMailboxEntries(RECIPIENT.chainPubkey)).toHaveLength(0);

    // Phase 2 — reconnect (SAME storage, same client): resume must execute
    // NOTHING — the local intent is 'aborted', the server never saw it.
    dead = false;
    const outcome = await module.resumeOpenIntents();
    expect(outcome).toEqual({ resumed: [], conflicted: [], failed: [] });
    expect(transferSpy).not.toHaveBeenCalled();
    expect(splitSpy).not.toHaveBeenCalled();
    expect(fake.listMailboxEntries(RECIPIENT.chainPubkey)).toHaveLength(0);

    // The resync replays the unlanded abort: the intent lands ABORTED (a
    // no-op execution-wise), never as an open intent resume would re-run.
    await client.resyncOpenIntents();
    expect(fake.getIntent(SENDER.chainPubkey, transferId)).toMatchObject({ status: 'aborted' });
    expect(await client.listIntents('open')).toEqual([]);

    // And a resume AFTER the resync still executes nothing.
    const outcome2 = await module.resumeOpenIntents();
    expect(outcome2).toEqual({ resumed: [], conflicted: [], failed: [] });
    expect(transferSpy).not.toHaveBeenCalled();
    expect(module.getTokens()[0].status).toBe('confirmed'); // no double-spend of the source
  });
});
