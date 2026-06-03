/**
 * Issue #387 — V6-RECOVER permanent-mismatch durable invalid status (e2e)
 *
 * Integration coverage for the full module lifecycle of the fix:
 *   1. Session A: PaymentsModule classifies a stranded V6 receive as
 *      permanent (HD-index recovery exhausted). The verdict is stamped
 *      in the persistent `v6RecoverPermanent` ledger AND the in-memory
 *      token is set to `'invalid'`.
 *   2. Persistence boundary: the underlying TXF format
 *      (`determineTokenStatus`) only encodes pending/confirmed — the
 *      'invalid' status is LOST on every TXF reload. The ledger is the
 *      authoritative survivor.
 *   3. Session B: fresh PaymentsModule, same storage. `module.load()`
 *      runs `loadFromStorageData` (recreating the token as 'pending')
 *      then `restoreV6RecoverPermanent` (hydrating the ledger and
 *      re-applying 'invalid'). End state: token is 'invalid', balance
 *      excludes it, recover scan returns 0.
 *   4. Sync replay: `loadFromStorageData` called again (simulating a
 *      sync flush) must still leave the token at 'invalid' via the
 *      end-of-load patch.
 *
 * This file exercises the PUBLIC `module.load()` entry point and the
 * end-to-end interaction between `loadFromStorageData`,
 * `restoreV6RecoverPermanent`, `aggregateTokens`, and
 * `recoverStrandedReceivedTokens` — the surface the bug actually
 * spanned per the issue's reproduction recipe.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPaymentsModule,
  type PaymentsModule as PaymentsModuleType,
} from '../../../modules/payments/PaymentsModule';
import type {
  FullIdentity,
  Token,
  TxfStorageDataBase,
} from '../../../types';
import type { StorageProvider } from '../../../storage';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type { TokenStorageProvider } from '../../../storage/storage-provider';
import { STORAGE_KEYS_ADDRESS } from '../../../constants';

// =============================================================================
// SDK / network stubs — defensive only. The tests exercise PaymentsModule's
// own state-management surface (load, save, balance, recover); no SDK paths
// are actually hit since the stranded token's predicate doesn't bind.
// =============================================================================

vi.mock('../../../l1/network', () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  isWebSocketConnected: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../registry', () => ({
  TokenRegistry: {
    getInstance: () => ({
      getDefinition: () => ({ symbol: 'UCT', name: 'Test', decimals: 8 }),
      getIconUrl: () => null,
    }),
    waitForReady: vi.fn().mockResolvedValue(undefined),
  },
}));

// =============================================================================
// Fixtures
// =============================================================================

const CANONICAL_TOKEN_ID = '59af0b9edda59e655a6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e';
const UCT_COIN_ID = '455ad8720656b08e8dbd5bac1f3c73eeea5431565f6c1c3af742b1aa12d41d89';

function makeIdentity(): FullIdentity {
  return {
    chainPubkey: '02' + 'a'.repeat(64),
    l1Address: 'alpha1test',
    directAddress: 'DIRECT://test',
    privateKey: 'a'.repeat(64),
  };
}

interface InMemoryStorage extends StorageProvider {
  _store: Map<string, string>;
}

function makeStorage(initial?: Map<string, string>): InMemoryStorage {
  const store = initial ?? new Map<string, string>();
  return {
    _store: store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
    remove: vi.fn(async (k: string) => { store.delete(k); }),
    delete: vi.fn(async (k: string) => { store.delete(k); }),
    clear: vi.fn(async () => { store.clear(); }),
    has: vi.fn(async (k: string) => store.has(k)),
    keys: vi.fn(async () => [...store.keys()]),
  } as unknown as InMemoryStorage;
}

function makeTransport(): TransportProvider {
  return {
    sendTokenTransfer: vi.fn(),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn().mockResolvedValue(null),
    resolveTransportPubkeyInfo: vi.fn().mockResolvedValue(null),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    fetchPendingEvents: vi.fn().mockResolvedValue(undefined),
    publishNametag: vi.fn().mockResolvedValue(undefined),
  } as unknown as TransportProvider;
}

function makeOracle(): OracleProvider {
  return {
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
    getStateTransitionClient: vi.fn().mockReturnValue(null),
    waitForProofSdk: vi.fn(),
  } as unknown as OracleProvider;
}

/** Build the stranded-V6-receive TXF shape that `parseTxfStorageData`
 * will turn into a Token whose `determineTokenStatus` reads as
 * `'pending'` (no inclusionProof on last tx) and whose
 * `isReceivedLegacyPending` returns true (recipient matches the wallet's
 * directAddress so the balance-model invariant keeps it in the active
 * map rather than archiving).
 */
function makeStrandedTxf(tokenId: string): Record<string, unknown> {
  return {
    genesis: {
      data: {
        tokenId,
        tokenType: 'genesis-type-hex',
        coinData: [[UCT_COIN_ID, '10']],
      },
    },
    state: {
      predicate: { type: 'masked', publicKey: '03' + 'b'.repeat(64) },
    },
    transactions: [
      {
        data: {
          sourceState: {
            predicate: { type: 'unmasked', publicKey: '02' + 'c'.repeat(64) },
          },
          recipient: 'DIRECT://test',
        },
        inclusionProof: null,
      },
    ],
  };
}

function makeTxfStorageData(tokenId: string): TxfStorageDataBase {
  return {
    _meta: {
      formatVersion: '2.0',
      address: 'alpha1test',
      timestamp: Date.now(),
    },
    [`_${tokenId}`]: makeStrandedTxf(tokenId),
  } as unknown as TxfStorageDataBase;
}

interface InMemoryTokenStorageProvider extends TokenStorageProvider<TxfStorageDataBase> {
  setData(data: TxfStorageDataBase): void;
  getData(): TxfStorageDataBase | null;
}

function makeTokenStorageProvider(initial?: TxfStorageDataBase): InMemoryTokenStorageProvider {
  let data: TxfStorageDataBase | null = initial ?? null;
  return {
    id: 'mock-token-storage',
    name: 'Mock TXF Storage',
    type: 'local',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    initialize: vi.fn().mockResolvedValue(true),
    shutdown: vi.fn().mockResolvedValue(undefined),
    save: vi.fn(async (d: TxfStorageDataBase) => {
      data = d;
      return { success: true };
    }),
    load: vi.fn(async () => ({ success: true, data })),
    sync: vi.fn(async (d: TxfStorageDataBase) => ({
      success: true,
      merged: d,
      added: 0,
      removed: 0,
    })),
    setData(d: TxfStorageDataBase) { data = d; },
    getData() { return data; },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

interface ModuleInternals {
  v6RecoverPermanent: Map<string, { reason: string; ts: number }>;
  tokens: Map<string, Token>;
  loadFromStorageData: (data: TxfStorageDataBase) => void;
  recoverStrandedReceivedTokens: () => Promise<number>;
}

function asInternals(m: PaymentsModuleType): ModuleInternals {
  return m as unknown as ModuleInternals;
}

function makeModuleWithProviders(
  storage: StorageProvider,
  tokenStorage: InMemoryTokenStorageProvider,
): PaymentsModuleType {
  const module = createPaymentsModule();
  module.initialize({
    identity: makeIdentity(),
    storage,
    transport: makeTransport(),
    oracle: makeOracle(),
    emitEvent: vi.fn(),
    tokenStorageProviders: new Map([['mock', tokenStorage]]),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  return module;
}

// =============================================================================
// Tests
// =============================================================================

describe('Issue #387 — V6-RECOVER permanent-mismatch e2e (load + balance + recover)', () => {
  let storage: InMemoryStorage;
  let tokenStorage: InMemoryTokenStorageProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = makeStorage();
    tokenStorage = makeTokenStorageProvider();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it('Session B (post-restart): load() restores ledger AND patches in-memory status to invalid', async () => {
    // ARRANGE — pretend Session A: ledger persisted; stranded token
    // saved to TXF with no encoded status (TXF carries only pending/
    // confirmed via transactions/inclusionProofs).
    storage._store.set(
      STORAGE_KEYS_ADDRESS.V6_RECOVER_PERMANENT,
      JSON.stringify([
        {
          tokenId: CANONICAL_TOKEN_ID,
          reason: 'permanent recipient-address mismatch (HD-index recovery exhausted)',
          ts: 1_700_000_000_000,
        },
      ]),
    );
    tokenStorage.setData(makeTxfStorageData(CANONICAL_TOKEN_ID));

    // ACT — Session B: fresh module, same storage, full load().
    const module = makeModuleWithProviders(storage, tokenStorage);
    await module.load();

    // ASSERT — the in-memory token reflects the ledger's permanent verdict.
    const internal = asInternals(module);
    const restored = internal.tokens.get(CANONICAL_TOKEN_ID);
    expect(restored).toBeDefined();
    expect(restored!.status).toBe('invalid');

    // Balance excludes the polluted token (the core user-facing bug).
    const balance = module.getBalance();
    const uct = balance.find((a) => a.coinId === UCT_COIN_ID);
    if (uct) {
      expect(uct.confirmedAmount).toBe('0');
      expect(uct.unconfirmedAmount).toBe('0');
      expect(uct.confirmedTokenCount).toBe(0);
      expect(uct.unconfirmedTokenCount).toBe(0);
    } else {
      expect(uct).toBeUndefined();
    }

    // Recover scan short-circuits.
    const recovered = await internal.recoverStrandedReceivedTokens();
    expect(recovered).toBe(0);
  });

  it('Sync replay: subsequent loadFromStorageData (simulating a sync flush) keeps the token invalid', async () => {
    // ARRANGE — Session B already-loaded state.
    storage._store.set(
      STORAGE_KEYS_ADDRESS.V6_RECOVER_PERMANENT,
      JSON.stringify([
        {
          tokenId: CANONICAL_TOKEN_ID,
          reason: 'permanent structural failure',
          ts: 1,
        },
      ]),
    );
    tokenStorage.setData(makeTxfStorageData(CANONICAL_TOKEN_ID));

    const module = makeModuleWithProviders(storage, tokenStorage);
    await module.load();
    const internal = asInternals(module);
    expect(internal.tokens.get(CANONICAL_TOKEN_ID)?.status).toBe('invalid');

    // ACT — simulate sync() calling loadFromStorageData again with the
    // same TXF (the storage layer has nothing new to report, just a
    // re-parse). Without the end-of-load patch, this would clobber
    // 'invalid' back to 'pending'.
    internal.loadFromStorageData(makeTxfStorageData(CANONICAL_TOKEN_ID));

    // ASSERT — status MUST survive.
    expect(internal.tokens.get(CANONICAL_TOKEN_ID)?.status).toBe('invalid');

    // Balance still correct.
    const balance = module.getBalance();
    const uct = balance.find((a) => a.coinId === UCT_COIN_ID);
    if (uct) {
      expect(uct.confirmedAmount).toBe('0');
      expect(uct.unconfirmedAmount).toBe('0');
    } else {
      expect(uct).toBeUndefined();
    }
  });

  it('AC1 (issue #387): status="invalid" survives load() across multiple sequential restarts', async () => {
    // Boot, then re-boot, then re-boot — three sessions each pulling
    // the same storage state. Every session must report 'invalid'.
    storage._store.set(
      STORAGE_KEYS_ADDRESS.V6_RECOVER_PERMANENT,
      JSON.stringify([
        { tokenId: CANONICAL_TOKEN_ID, reason: 'test', ts: 1 },
      ]),
    );
    tokenStorage.setData(makeTxfStorageData(CANONICAL_TOKEN_ID));

    for (let i = 0; i < 3; i += 1) {
      const module = makeModuleWithProviders(storage, tokenStorage);
      await module.load();
      const internal = asInternals(module);
      expect(internal.tokens.get(CANONICAL_TOKEN_ID)?.status).toBe('invalid');
      const balance = module.getBalance();
      const uct = balance.find((a) => a.coinId === UCT_COIN_ID);
      const unconfirmed = uct ? BigInt(uct.unconfirmedAmount) : 0n;
      expect(unconfirmed).toBe(0n);
    }
  });

  it('Non-ledgered token of the same coin continues to surface in balance', async () => {
    // Sanity: the fix must not over-trigger. A wholly unrelated
    // confirmed UCT token at a different canonical id MUST still
    // contribute to confirmed balance.
    storage._store.set(
      STORAGE_KEYS_ADDRESS.V6_RECOVER_PERMANENT,
      JSON.stringify([
        { tokenId: CANONICAL_TOKEN_ID, reason: 'permanent structural failure', ts: 1 },
      ]),
    );

    // TXF carrying TWO tokens: the polluted one + a healthy unrelated one.
    // The healthy token's state predicate MUST bind to the wallet's
    // chainPubkey — `loadFromStorageData` archives any active token whose
    // latest state predicate doesn't bind AND that has no finalization
    // plan (the balance-model invariant from #144). The wallet identity
    // sets `chainPubkey = '02' + 'a'.repeat(64)`; we use that same value
    // in an unmasked predicate so `latestStatePredicateMatchesWallet`
    // returns true and the token stays in the active map.
    //
    // `determineTokenStatus` returns 'confirmed' for a token with no
    // transactions, so a genesis-only token at a non-ledgered canonical
    // id with a wallet-bound predicate MUST land in `confirmedAmount`.
    const healthyTokenId = 'd'.repeat(64);
    const healthyTxf = {
      genesis: {
        data: {
          tokenId: healthyTokenId,
          tokenType: 'genesis-type-hex',
          coinData: [[UCT_COIN_ID, '7']],
        },
      },
      state: { predicate: { type: 'unmasked', publicKey: '02' + 'a'.repeat(64) } },
      // No transactions → determineTokenStatus returns 'confirmed'.
      transactions: [],
    };
    tokenStorage.setData({
      _meta: { formatVersion: '2.0', address: 'alpha1test', timestamp: Date.now() },
      [`_${CANONICAL_TOKEN_ID}`]: makeStrandedTxf(CANONICAL_TOKEN_ID),
      [`_${healthyTokenId}`]: healthyTxf,
    } as unknown as TxfStorageDataBase);

    const module = makeModuleWithProviders(storage, tokenStorage);
    await module.load();
    const internal = asInternals(module);

    // Polluted side is filtered.
    expect(internal.tokens.get(CANONICAL_TOKEN_ID)?.status).toBe('invalid');
    // Healthy side is preserved as 'confirmed' — `isV6RecoverPermanentToken`
    // matches by canonical id (`healthyTokenId` ≠ `CANONICAL_TOKEN_ID`),
    // so the ledger filter must not touch it.
    expect(internal.tokens.get(healthyTokenId)?.status).toBe('confirmed');

    const balance = module.getBalance();
    const uct = balance.find((a) => a.coinId === UCT_COIN_ID);
    expect(uct).toBeDefined();
    // Issue #389 finding #12 — explicit positive assertion. The pre-#389
    // test only checked `unconfirmedAmount === 0` which would silently
    // pass an over-broad ledger filter regression that ALSO excluded
    // the healthy token. Lock in the 7-UCT confirmed balance so future
    // refactors can't quietly drop the healthy side.
    expect(uct!.confirmedAmount).toBe('7');
    expect(uct!.unconfirmedAmount).toBe('0');
    expect(uct!.confirmedTokenCount).toBe(1);
    expect(uct!.unconfirmedTokenCount).toBe(0);
    expect(uct!.totalAmount).toBe('7');
  });

  // ===========================================================================
  // Issue #389 finding #15 — backward compatibility with #378 ledger payloads.
  // ===========================================================================
  //
  // #378 stamped entries under the map iteration key, which post-
  // `loadFromStorageData` is the canonical genesis tokenId — i.e. for
  // every in-practice path the two coincide. #388 made the canonical-id
  // lookup explicit via `isV6RecoverPermanentToken`. We lock in that a
  // ledger payload produced by the #378 stamping path continues to
  // function correctly when loaded by the #388 + #389 logic:
  //  - tokens at the canonical id are flipped to 'invalid'
  //  - balance excludes them
  //  - the recover scan short-circuits
  // This is the "zero migration risk" check from finding #15.
  it('#389 #15: legacy #378-shaped ledger payload (canonical-id key) drives #388 lookup correctly', async () => {
    // #378 produced ledger entries with the SAME shape as #388/#389
    // (`{ tokenId, reason, ts }`), keyed by the canonical genesis
    // tokenId post-load. We simulate that exact payload here and
    // assert all three #389 lookup paths agree on it.
    const legacyShapedLedger = JSON.stringify([
      {
        tokenId: CANONICAL_TOKEN_ID, // canonical genesis id, as #378 wrote
        reason: 'permanent recipient-address mismatch (HD-index recovery exhausted)',
        ts: 1_700_000_000_000,
      },
    ]);
    storage._store.set(STORAGE_KEYS_ADDRESS.V6_RECOVER_PERMANENT, legacyShapedLedger);
    tokenStorage.setData(makeTxfStorageData(CANONICAL_TOKEN_ID));

    const module = makeModuleWithProviders(storage, tokenStorage);
    await module.load();
    const internal = asInternals(module);

    // 1) Token is correctly classified.
    const restored = internal.tokens.get(CANONICAL_TOKEN_ID);
    expect(restored).toBeDefined();
    expect(restored!.status).toBe('invalid');

    // 2) Balance excludes it (the #388 `aggregateTokens` filter).
    const balance = module.getBalance();
    const uct = balance.find((a) => a.coinId === UCT_COIN_ID);
    if (uct) {
      expect(uct.confirmedAmount).toBe('0');
      expect(uct.unconfirmedAmount).toBe('0');
    } else {
      expect(uct).toBeUndefined();
    }

    // 3) Recover scan short-circuits.
    const recovered = await internal.recoverStrandedReceivedTokens();
    expect(recovered).toBe(0);

    // 4) `getTokens()` returns the token but reports its status as
    //    'invalid' via the #389 #9 lazy filter — important for any
    //    direct API consumer (AccountingModule, SwapModule, CLI).
    const all = module.getTokens();
    const observed = all.find((t) => t.id === CANONICAL_TOKEN_ID);
    expect(observed).toBeDefined();
    expect(observed!.status).toBe('invalid');
  });
});
