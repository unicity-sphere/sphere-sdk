/**
 * Issue #387 — V6-RECOVER permanent-mismatch must durably mark token invalid.
 *
 * When `finalizeStrandedReceivedToken` classifies a stranded receive as
 * permanent (HD-index recovery exhausted / structural failure), the
 * tokenId is added to the persistent `v6RecoverPermanent` ledger AND
 * the in-memory token is set to `status='invalid'`. The bug: the TXF
 * round-trip through `parseTxfStorageData → txfToToken →
 * determineTokenStatus` only knows `pending`/`confirmed`, so the
 * `'invalid'` status is silently reverted to `'pending'` on every
 * `loadFromStorageData`. The polluted token then surfaces in
 * `getBalance()` as unconfirmed UCT despite being unspendable.
 *
 * This file pins the contract:
 *   1. `applyV6RecoverPermanentInvalidStatus()` patches in-memory
 *      tokens whose canonical id is in the ledger to `'invalid'`.
 *   2. `loadFromStorageData()` re-applies the ledger after every TXF
 *      reload, so the status survives a load() round-trip even though
 *      the underlying TXF can only encode `pending`/`confirmed`.
 *   3. `restoreV6RecoverPermanent()` also applies the ledger after
 *      hydrating it on initial load.
 *   4. `aggregateTokens()` (and therefore `getBalance()`) skips tokens
 *      whose canonical id is in the ledger — defense in depth.
 *   5. `addToken()` from a Nostr at-least-once replay sets the
 *      incoming token's status to `'invalid'` when the canonical id is
 *      in the ledger.
 *   6. Ledger lookup is canonical-id-first: extracts the genesis
 *      tokenId from sdkData so a `crypto.randomUUID`-keyed `addToken`
 *      entry still resolves correctly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPaymentsModule } from '../../../modules/payments/PaymentsModule';
import type { FullIdentity, Token } from '../../../types';
import type { StorageProvider } from '../../../storage';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import { STORAGE_KEYS_ADDRESS } from '../../../constants';

// =============================================================================
// SDK / network mocks — defensive only. The tests poke the internal map
// directly and exercise the pure status / filter logic; no SDK paths are
// actually hit.
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
// Helpers
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

function makeStorage(): InMemoryStorage {
  const store = new Map<string, string>();
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

function setupModule(storage: StorageProvider): ReturnType<typeof createPaymentsModule> {
  const module = createPaymentsModule();
  module.initialize({
    identity: makeIdentity(),
    storage,
    transport: makeTransport(),
    oracle: makeOracle(),
    emitEvent: vi.fn(),
  });
  // Bypass the lazy-load gate so the internal map is directly addressable.
  (module as unknown as { loaded: boolean }).loaded = true;
  (module as unknown as { loadedPromise: Promise<void> | null }).loadedPromise = null;
  return module;
}

/**
 * Build a minimal stranded-V6-receive Token whose sdkData carries the
 * canonical tokenId and at least one transaction without an
 * inclusionProof — the shape that `determineTokenStatus` reads as
 * `'pending'`.
 *
 * The status field on the returned Token is the application-level
 * verdict (e.g. `'invalid'`); independent of what
 * `determineTokenStatus` would derive from the TXF transactions. This
 * matches the production divergence — exactly the surface the fix
 * has to resolve.
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
    // A single transaction with NO inclusionProof and a recipient
    // matching the wallet's directAddress — the stranded V6-direct
    // receive shape. `determineTokenStatus` reads no-proof as
    // `'pending'` on every reload; `isReceivedLegacyPending` reads the
    // directAddress match as "has a finalization plan", which keeps
    // the token in the active map (instead of the archive) per
    // `loadFromStorageData`'s balance-model invariant.
    transactions: [
      {
        data: {
          sourceState: { predicate: { type: 'unmasked', publicKey: '02' + 'c'.repeat(64) } },
          recipient: 'DIRECT://test',
        },
        inclusionProof: null,
      },
    ],
  };
}

function makeStrandedToken(
  tokenId: string,
  status: Token['status'] = 'pending',
  mapId?: string,
): Token {
  return {
    id: mapId ?? tokenId,
    coinId: UCT_COIN_ID,
    symbol: 'UCT',
    name: 'Test',
    decimals: 8,
    amount: '10',
    status,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sdkData: JSON.stringify(makeStrandedTxf(tokenId)),
  };
}

interface ModuleInternals {
  v6RecoverPermanent: Map<string, { reason: string; ts: number }>;
  tokens: Map<string, Token>;
  applyV6RecoverPermanentInvalidStatus: () => number;
  isV6RecoverPermanentToken: (token: Token, mapKey?: string) => boolean;
  restoreV6RecoverPermanent: () => Promise<void>;
  loadFromStorageData: (data: unknown) => void;
}

function asInternals(module: ReturnType<typeof createPaymentsModule>): ModuleInternals {
  return module as unknown as ModuleInternals;
}

// =============================================================================
// Tests
// =============================================================================

describe('Issue #387 — V6-RECOVER permanent-mismatch durable invalid status', () => {
  let storage: InMemoryStorage;
  let module: ReturnType<typeof createPaymentsModule>;
  let internal: ModuleInternals;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = makeStorage();
    module = setupModule(storage);
    internal = asInternals(module);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // applyV6RecoverPermanentInvalidStatus — pure mechanics
  // ---------------------------------------------------------------------------

  describe('applyV6RecoverPermanentInvalidStatus()', () => {
    it('flips matching pending tokens to invalid', () => {
      const t = makeStrandedToken(CANONICAL_TOKEN_ID, 'pending');
      internal.tokens.set(t.id, t);
      internal.v6RecoverPermanent.set(CANONICAL_TOKEN_ID, {
        reason: 'permanent recipient-address mismatch (HD-index recovery exhausted)',
        ts: 1_700_000_000_000,
      });

      const patched = internal.applyV6RecoverPermanentInvalidStatus();
      expect(patched).toBe(1);
      expect(internal.tokens.get(t.id)?.status).toBe('invalid');
    });

    it('is a no-op when the ledger is empty (hot path)', () => {
      const t = makeStrandedToken(CANONICAL_TOKEN_ID, 'pending');
      internal.tokens.set(t.id, t);

      const patched = internal.applyV6RecoverPermanentInvalidStatus();
      expect(patched).toBe(0);
      expect(internal.tokens.get(t.id)?.status).toBe('pending');
    });

    it('leaves confirmed tokens alone (different tokenId, same ledger)', () => {
      const stranded = makeStrandedToken(CANONICAL_TOKEN_ID, 'pending');
      // A wholly unrelated confirmed token — must NOT be touched even
      // though the ledger is non-empty.
      const goodId = 'b'.repeat(64);
      const good = makeStrandedToken(goodId, 'confirmed');
      internal.tokens.set(stranded.id, stranded);
      internal.tokens.set(good.id, good);
      internal.v6RecoverPermanent.set(CANONICAL_TOKEN_ID, {
        reason: 'permanent structural failure',
        ts: 1,
      });

      internal.applyV6RecoverPermanentInvalidStatus();
      expect(internal.tokens.get(stranded.id)?.status).toBe('invalid');
      expect(internal.tokens.get(good.id)?.status).toBe('confirmed');
    });

    it('does not re-touch tokens already marked invalid (idempotent)', () => {
      const t = makeStrandedToken(CANONICAL_TOKEN_ID, 'invalid');
      const originalUpdatedAt = t.updatedAt;
      internal.tokens.set(t.id, t);
      internal.v6RecoverPermanent.set(CANONICAL_TOKEN_ID, { reason: 'x', ts: 1 });

      const patched = internal.applyV6RecoverPermanentInvalidStatus();
      expect(patched).toBe(0);
      expect(internal.tokens.get(t.id)?.updatedAt).toBe(originalUpdatedAt);
    });

    it('skips spent tokens (terminal state)', () => {
      const t = makeStrandedToken(CANONICAL_TOKEN_ID, 'spent');
      internal.tokens.set(t.id, t);
      internal.v6RecoverPermanent.set(CANONICAL_TOKEN_ID, { reason: 'x', ts: 1 });

      const patched = internal.applyV6RecoverPermanentInvalidStatus();
      expect(patched).toBe(0);
      expect(internal.tokens.get(t.id)?.status).toBe('spent');
    });

    it('resolves canonical-id-first when the map key is a UUID', () => {
      // Simulates the Nostr-replay shape: addToken assigned a fresh
      // UUID as `token.id`, but `sdkData` still carries the canonical
      // genesis tokenId. Lookup MUST resolve via sdkData.
      const t = makeStrandedToken(CANONICAL_TOKEN_ID, 'pending', 'uuid-1234-not-canonical');
      internal.tokens.set(t.id, t);
      internal.v6RecoverPermanent.set(CANONICAL_TOKEN_ID, { reason: 'x', ts: 1 });

      const patched = internal.applyV6RecoverPermanentInvalidStatus();
      expect(patched).toBe(1);
      expect(internal.tokens.get('uuid-1234-not-canonical')?.status).toBe('invalid');
    });
  });

  // ---------------------------------------------------------------------------
  // aggregateTokens / getBalance — balance MUST exclude ledgered tokens
  // ---------------------------------------------------------------------------

  describe('getBalance() / aggregateTokens()', () => {
    it('excludes amount of a ledgered token from confirmed AND unconfirmed totals', () => {
      const stranded = makeStrandedToken(CANONICAL_TOKEN_ID, 'pending');
      internal.tokens.set(stranded.id, stranded);
      internal.v6RecoverPermanent.set(CANONICAL_TOKEN_ID, { reason: 'x', ts: 1 });

      // No applyV6RecoverPermanentInvalidStatus() call here — this
      // tests the defense-in-depth filter inside aggregateTokens.
      const balance = module.getBalance();
      const uct = balance.find((a) => a.coinId === UCT_COIN_ID);
      // Either no UCT entry at all (no other UCT tokens) or zero
      // contribution from the ledgered one. The polluted token MUST
      // NOT show up in either confirmed or unconfirmed.
      if (uct) {
        expect(uct.confirmedAmount).toBe('0');
        expect(uct.unconfirmedAmount).toBe('0');
        expect(uct.tokenCount).toBe(0);
      } else {
        expect(uct).toBeUndefined();
      }
    });

    it('still includes a non-ledgered token of the same coin', () => {
      const stranded = makeStrandedToken(CANONICAL_TOKEN_ID, 'pending');
      const goodId = 'd'.repeat(64);
      const good = makeStrandedToken(goodId, 'confirmed');
      internal.tokens.set(stranded.id, stranded);
      internal.tokens.set(good.id, good);
      internal.v6RecoverPermanent.set(CANONICAL_TOKEN_ID, { reason: 'x', ts: 1 });

      const balance = module.getBalance();
      const uct = balance.find((a) => a.coinId === UCT_COIN_ID);
      expect(uct).toBeDefined();
      // The good (10 UCT) is confirmed; the polluted entry is filtered out.
      expect(uct!.confirmedAmount).toBe('10');
      expect(uct!.unconfirmedAmount).toBe('0');
      expect(uct!.tokenCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // restoreV6RecoverPermanent — initial-load ordering: ledger arrives AFTER
  // loadFromStorageData and must still patch the in-memory token map.
  // ---------------------------------------------------------------------------

  describe('restoreV6RecoverPermanent()', () => {
    it('applies invalid status to in-memory tokens after hydration', async () => {
      // Simulate the initial-load order in PaymentsModule.load():
      //   1. loadFromStorageData (re-creates tokens at status='pending')
      //   2. restoreV6RecoverPermanent (hydrates ledger from storage)
      // Step 2 MUST patch tokens placed by step 1.
      const t = makeStrandedToken(CANONICAL_TOKEN_ID, 'pending');
      internal.tokens.set(t.id, t);
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

      await internal.restoreV6RecoverPermanent();
      expect(internal.tokens.get(t.id)?.status).toBe('invalid');
    });
  });

  // ---------------------------------------------------------------------------
  // loadFromStorageData — TXF round-trip must NOT strip the verdict.
  // ---------------------------------------------------------------------------

  describe('loadFromStorageData() preserves the ledger verdict across TXF round-trip', () => {
    it('re-applies invalid status to tokens whose status was reset to pending by determineTokenStatus', () => {
      // Pre-seed: ledger has the verdict already in memory (e.g. after
      // a prior restoreV6RecoverPermanent).
      internal.v6RecoverPermanent.set(CANONICAL_TOKEN_ID, {
        reason: 'permanent recipient-address mismatch (HD-index recovery exhausted)',
        ts: 1_700_000_000_000,
      });

      // Simulate sync() calling loadFromStorageData with a TXF payload
      // that contains the stranded token. parseTxfStorageData →
      // txfToToken → determineTokenStatus will materialize the in-memory
      // token at status='pending' (the TXF can't encode 'invalid'), so
      // the post-load patch MUST flip it back to 'invalid'.
      const txfPayload = {
        _meta: {
          formatVersion: '2.0',
          address: 'alpha1test',
          timestamp: Date.now(),
        },
        [`_${CANONICAL_TOKEN_ID}`]: makeStrandedTxf(CANONICAL_TOKEN_ID),
      };

      internal.loadFromStorageData(txfPayload);

      // After the load, the in-memory token MUST be 'invalid'.
      const loadedToken = internal.tokens.get(CANONICAL_TOKEN_ID);
      expect(loadedToken).toBeDefined();
      expect(loadedToken!.status).toBe('invalid');

      // And the balance MUST exclude it — both the status filter and
      // the belt-and-braces ledger filter agree.
      const balance = module.getBalance();
      const uct = balance.find((a) => a.coinId === UCT_COIN_ID);
      if (uct) {
        expect(uct.confirmedAmount).toBe('0');
        expect(uct.unconfirmedAmount).toBe('0');
      } else {
        expect(uct).toBeUndefined();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // addToken — Nostr at-least-once replay must respect the ledger
  // ---------------------------------------------------------------------------

  describe('addToken() honors the ledger on Nostr at-least-once replay', () => {
    it('marks a replayed token as invalid before insertion', async () => {
      // Stamp the ledger first — simulating a prior session that
      // classified the token as permanently invalid.
      internal.v6RecoverPermanent.set(CANONICAL_TOKEN_ID, {
        reason: 'permanent recipient-address mismatch (HD-index recovery exhausted)',
        ts: 1_700_000_000_000,
      });

      // Build an incoming token shaped exactly as the Nostr replay
      // would deliver it: status='pending', sdkData carries canonical
      // tokenId. addToken sees the ledger match and persists 'invalid'.
      const incoming = makeStrandedToken(CANONICAL_TOKEN_ID, 'pending', 'uuid-fresh-from-nostr');
      const ok = await module.addToken(incoming);
      expect(ok).toBe(true);

      const stored = internal.tokens.get('uuid-fresh-from-nostr');
      expect(stored).toBeDefined();
      expect(stored!.status).toBe('invalid');

      // Balance still correct.
      const balance = module.getBalance();
      const uct = balance.find((a) => a.coinId === UCT_COIN_ID);
      if (uct) {
        expect(uct.unconfirmedAmount).toBe('0');
      } else {
        expect(uct).toBeUndefined();
      }
    });

    it('does NOT reject the addToken (cursor advancement)', async () => {
      // If addToken returned false for a ledger match, handleIncomingTransfer
      // would refuse to advance the Nostr at-least-once cursor, causing
      // perpetual replay. Verify we accept the write while marking invalid.
      internal.v6RecoverPermanent.set(CANONICAL_TOKEN_ID, { reason: 'x', ts: 1 });
      const incoming = makeStrandedToken(CANONICAL_TOKEN_ID, 'pending');
      const ok = await module.addToken(incoming);
      expect(ok).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Full acceptance criteria from issue #387
  // ---------------------------------------------------------------------------

  describe('Acceptance criteria', () => {
    it('AC1: invalid status survives a CLI restart (storage round-trip)', async () => {
      // Session A: stamp the ledger and place the token at 'invalid'.
      const t = makeStrandedToken(CANONICAL_TOKEN_ID, 'invalid');
      internal.tokens.set(t.id, t);
      internal.v6RecoverPermanent.set(CANONICAL_TOKEN_ID, {
        reason: 'permanent recipient-address mismatch (HD-index recovery exhausted)',
        ts: 1_700_000_000_000,
      });
      const saveLedger = internal as unknown as {
        saveV6RecoverPermanent: () => Promise<void>;
      };
      await saveLedger.saveV6RecoverPermanent();

      // Session B: brand-new module instance, same storage.
      const module2 = setupModule(storage);
      const internal2 = asInternals(module2);

      // Simulate the load() ordering: loadFromStorageData first (with
      // the same token shape as the TXF would yield), then
      // restoreV6RecoverPermanent.
      const txfPayload = {
        _meta: { formatVersion: '2.0', address: 'alpha1test', timestamp: Date.now() },
        [`_${CANONICAL_TOKEN_ID}`]: JSON.parse(t.sdkData!),
      };
      internal2.loadFromStorageData(txfPayload);
      // Right after loadFromStorageData (and before
      // restoreV6RecoverPermanent), the in-memory token is BACK to
      // 'pending' because determineTokenStatus only knows
      // pending/confirmed. This is the exact failure mode.
      expect(internal2.tokens.get(CANONICAL_TOKEN_ID)?.status).toBe('pending');

      // restoreV6RecoverPermanent then re-applies the ledger.
      await internal2.restoreV6RecoverPermanent();
      expect(internal2.tokens.get(CANONICAL_TOKEN_ID)?.status).toBe('invalid');
    });

    it('AC2: getBalance() excludes the amount in both confirmed AND unconfirmed', () => {
      const t = makeStrandedToken(CANONICAL_TOKEN_ID, 'pending');
      internal.tokens.set(t.id, t);
      internal.v6RecoverPermanent.set(CANONICAL_TOKEN_ID, { reason: 'x', ts: 1 });

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
    });

    it('AC3: recoverStrandedReceivedTokens does not re-attempt finalization on T', async () => {
      // Stamp the ledger and place a token that would otherwise look
      // like a recoverable stranded receive.
      const t = makeStrandedToken(CANONICAL_TOKEN_ID, 'pending');
      internal.tokens.set(t.id, t);
      internal.v6RecoverPermanent.set(CANONICAL_TOKEN_ID, {
        reason: 'permanent recipient-address mismatch (HD-index recovery exhausted)',
        ts: 1,
      });

      // Call recoverStrandedReceivedTokens — it MUST short-circuit and
      // return 0 (no jobs registered).
      const recoverFn = (
        internal as unknown as { recoverStrandedReceivedTokens: () => Promise<number> }
      ).recoverStrandedReceivedTokens;
      const registered = await recoverFn.call(internal);
      expect(registered).toBe(0);
    });

    // -------------------------------------------------------------------------
    // Issue #389 review-follow-up regressions (PR #388 hardening).
    // -------------------------------------------------------------------------

    it('#389 #1: finalizeReceivedToken skips status write for a ledgered token', async () => {
      // Stamp the ledger BEFORE the in-memory token would otherwise
      // be marked confirmed by a stale proof-polling callback.
      internal.v6RecoverPermanent.set(CANONICAL_TOKEN_ID, {
        reason: 'permanent recipient-address mismatch (HD-index recovery exhausted)',
        ts: 1,
      });
      const t = makeStrandedToken(CANONICAL_TOKEN_ID, 'invalid');
      internal.tokens.set(t.id, t);

      // Pretend a polling job was registered (we manipulate the
      // private map directly so the cleanup branch can be exercised).
      const pollJobs = (internal as unknown as {
        proofPollingJobs: Map<string, unknown>;
      }).proofPollingJobs;
      pollJobs.set(t.id, {} as unknown);

      // Call finalizeReceivedToken directly. Without the #389 #1
      // guard, this method would build `{ ...token, status: 'confirmed' }`
      // and clobber the ledgered 'invalid' verdict. With the guard,
      // it must short-circuit and leave the token at 'invalid'.
      const fin = (internal as unknown as {
        finalizeReceivedToken: (
          tokenId: string,
          src: unknown,
          commit: unknown,
        ) => Promise<void>;
      }).finalizeReceivedToken;
      await fin.call(internal, t.id, {}, {});

      expect(internal.tokens.get(t.id)?.status).toBe('invalid');
      // Polling job cleanup runs (best-effort).
      expect(pollJobs.has(t.id)).toBe(false);
    });

    it('#389 #4: addToken patches caller reference IN PLACE (event payloads see invalid)', async () => {
      internal.v6RecoverPermanent.set(CANONICAL_TOKEN_ID, { reason: 'x', ts: 1 });
      // The caller hangs on to `incoming` and reads its status AFTER
      // addToken returns (mirrors handleIncomingTransfer's pattern).
      const incoming = makeStrandedToken(CANONICAL_TOKEN_ID, 'pending', 'uuid-caller-ref');
      expect(incoming.status).toBe('pending');
      await module.addToken(incoming);
      // The caller's own reference now reflects the patch — not just
      // the entry inside `this.tokens`. Without in-place mutation,
      // `incoming.status` would still read 'pending' here.
      expect(incoming.status).toBe('invalid');
      expect(internal.tokens.get('uuid-caller-ref')?.status).toBe('invalid');
    });

    it('#389 #5: updateToken coerces incoming non-invalid status to invalid when ledgered', async () => {
      internal.v6RecoverPermanent.set(CANONICAL_TOKEN_ID, { reason: 'x', ts: 1 });
      // A pre-existing entry that addToken seeded as 'invalid'.
      const existing = makeStrandedToken(CANONICAL_TOKEN_ID, 'invalid');
      internal.tokens.set(existing.id, existing);

      // A future caller hands updateToken the same token but at
      // 'confirmed' — pretending to finalize. The ledger guard must
      // coerce it back to 'invalid' BEFORE the map.set.
      const incoming = makeStrandedToken(CANONICAL_TOKEN_ID, 'confirmed');
      await module.updateToken(incoming);
      expect(incoming.status).toBe('invalid');
      expect(internal.tokens.get(incoming.id)?.status).toBe('invalid');
    });

    it('#389 #8: scheduleResolveUnconfirmed does NOT arm the timer when only ledgered tokens are pending', () => {
      // Place a ledgered token at 'pending' (still un-patched — the
      // cold-start window). Without the #389 #8 guard, the some()
      // predicate matches and the timer is armed.
      const t = makeStrandedToken(CANONICAL_TOKEN_ID, 'pending');
      internal.tokens.set(t.id, t);
      internal.v6RecoverPermanent.set(CANONICAL_TOKEN_ID, { reason: 'x', ts: 1 });

      const schedule = (internal as unknown as {
        scheduleResolveUnconfirmed: () => void;
      }).scheduleResolveUnconfirmed;
      // Sanity: timer is not running before.
      const timerSlot = internal as unknown as {
        resolveUnconfirmedTimer: unknown;
      };
      timerSlot.resolveUnconfirmedTimer = null;

      schedule.call(internal);
      // With the guard, the predicate finds nothing and returns early.
      expect(timerSlot.resolveUnconfirmedTimer).toBeNull();
    });

    it('#389 #9: getTokens() returns invalid-view for ledgered tokens even pre-patch', () => {
      // Place a ledgered token at 'pending' BEFORE
      // applyV6RecoverPermanentInvalidStatus has been called — the
      // cold-start race window the lazy filter closes.
      const t = makeStrandedToken(CANONICAL_TOKEN_ID, 'pending');
      internal.tokens.set(t.id, t);
      internal.v6RecoverPermanent.set(CANONICAL_TOKEN_ID, { reason: 'x', ts: 1 });

      // The in-memory entry is still 'pending' (we deliberately did
      // NOT call applyV6RecoverPermanentInvalidStatus).
      expect(internal.tokens.get(t.id)?.status).toBe('pending');

      // But getTokens() returns the patched view.
      const all = module.getTokens();
      const observed = all.find((tk) => tk.id === t.id);
      expect(observed).toBeDefined();
      expect(observed!.status).toBe('invalid');
    });

    it('#389 #10: applyV6RecoverPermanentInvalidStatus skips transferring (in-flight send safety)', () => {
      // A token mid-send: status='transferring' indicates an outbound
      // commit is in-flight. The ledger MUST NOT flip it — that would
      // abort the send.
      const t = makeStrandedToken(CANONICAL_TOKEN_ID, 'transferring');
      internal.tokens.set(t.id, t);
      internal.v6RecoverPermanent.set(CANONICAL_TOKEN_ID, { reason: 'x', ts: 1 });

      const patched = internal.applyV6RecoverPermanentInvalidStatus();
      expect(patched).toBe(0);
      expect(internal.tokens.get(t.id)?.status).toBe('transferring');
    });

    it('#389 #13: applyV6RecoverPermanentInvalidStatus does NOT bump updatedAt', () => {
      const ORIGINAL_TS = 1_700_000_000_000;
      const t: Token = {
        ...makeStrandedToken(CANONICAL_TOKEN_ID, 'pending'),
        updatedAt: ORIGINAL_TS,
      };
      internal.tokens.set(t.id, t);
      internal.v6RecoverPermanent.set(CANONICAL_TOKEN_ID, { reason: 'x', ts: 1 });

      internal.applyV6RecoverPermanentInvalidStatus();

      const patched = internal.tokens.get(t.id);
      expect(patched).toBeDefined();
      expect(patched!.status).toBe('invalid');
      // The status flip alone is the signal; updatedAt is reserved
      // for genuine downstream-meaningful changes.
      expect(patched!.updatedAt).toBe(ORIGINAL_TS);
    });

    it('AC4 (regression): full round-trip — load, sync, balance, recover all agree', async () => {
      // End-to-end: stamp the ledger, simulate a sync() that re-runs
      // loadFromStorageData, then verify status, balance, and recover
      // all reflect the verdict consistently.
      internal.v6RecoverPermanent.set(CANONICAL_TOKEN_ID, {
        reason: 'permanent recipient-address mismatch (HD-index recovery exhausted)',
        ts: 1,
      });

      // Pretend a sync flush arrived with the same TXF.
      const txfPayload = {
        _meta: { formatVersion: '2.0', address: 'alpha1test', timestamp: Date.now() },
        [`_${CANONICAL_TOKEN_ID}`]: makeStrandedTxf(CANONICAL_TOKEN_ID),
      };
      internal.loadFromStorageData(txfPayload);

      // (a) Status reflects ledger.
      expect(internal.tokens.get(CANONICAL_TOKEN_ID)?.status).toBe('invalid');

      // (b) Balance excludes the polluted token.
      const balance = module.getBalance();
      const uct = balance.find((a) => a.coinId === UCT_COIN_ID);
      if (uct) {
        expect(uct.confirmedAmount).toBe('0');
        expect(uct.unconfirmedAmount).toBe('0');
      } else {
        expect(uct).toBeUndefined();
      }

      // (c) Recover scan short-circuits.
      const recoverFn = (
        internal as unknown as { recoverStrandedReceivedTokens: () => Promise<number> }
      ).recoverStrandedReceivedTokens;
      const registered = await recoverFn.call(internal);
      expect(registered).toBe(0);
    });
  });
});
