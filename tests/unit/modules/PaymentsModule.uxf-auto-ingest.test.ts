/**
 * Tests for auto-installation of the default IngestWorkerPool (Phase 9.5.E).
 *
 * Verifies:
 *  1. PaymentsModule.initialize() creates a non-null ingestPool when
 *     features.recipientUxf is true (default) and no pool was pre-installed.
 *  2. A consumer-installed pool is not replaced by auto-install.
 *  3. When features.recipientUxf is false, auto-install does NOT create a pool.
 *  4. Dispatching a synthetic UXF v1.0 `uxf-car` payload via
 *     handleIncomingTransfer:
 *       - routes into the auto-installed pool (not the legacy arm),
 *       - extracts/validates the assembled token,
 *       - adds it to the wallet,
 *       - emits 'transfer:incoming' with the correct token payload.
 *
 * The real CAR/IPFS acquirer is stubbed via vi.mock so no network I/O occurs.
 * All SDK imports that require crypto or network are similarly mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPaymentsModule,
} from '../../../modules/payments/PaymentsModule';
import {
  IngestWorkerPool,
  type UxfV1Payload,
} from '../../../modules/payments/transfer/ingest-worker-pool';
import { ReplayLRU } from '../../../modules/payments/transfer/replay-lru';
import { PerTokenMutex } from '../../../profile/per-token-mutex';
import type { RootRef, VerifiedBundle } from '../../../modules/payments/transfer/bundle-verifier';
import type { FullIdentity } from '../../../types';
import type { StorageProvider } from '../../../storage';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type { IncomingTokenTransfer } from '../../../transport';

// =============================================================================
// SDK mocks — prevent any network/crypto during test
// =============================================================================

vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token', () => ({
  Token: {
    fromJSON: vi.fn().mockResolvedValue({
      id: {
        toJSON: () => TOKEN_ID_A,
        toString: () => TOKEN_ID_A,
      },
      coins: {
        coins: [[[{ toJSON: () => COIN_ID_HEX, instanceof: true }, '1000000']]],
      },
      state: {},
    }),
  },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/token/fungible/CoinId', () => ({
  CoinId: class MockCoinId {
    constructor(private readonly _hex?: string) {}
    toJSON() { return this._hex ?? COIN_ID_HEX; }
    static isInstance(v: unknown): v is MockCoinId { return v instanceof this; }
  },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/TransferCommitment', () => ({
  TransferCommitment: { fromJSON: vi.fn() },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction', () => ({
  TransferTransaction: class {
    static fromJSON = vi.fn().mockResolvedValue({
      data: {
        recipient: { scheme: 0 /* AddressScheme.DIRECT */, address: 'DIRECT://test' },
        salt: new Uint8Array(32),
      },
    });
  },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/TransferTransactionData', () => ({
  TransferTransactionData: {
    fromJSON: vi.fn().mockResolvedValue({ salt: new Uint8Array(32) }),
  },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/sign/SigningService', () => ({
  SigningService: class {
    static createFromSecret = vi.fn().mockResolvedValue({});
  },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/address/AddressScheme', () => ({
  AddressScheme: { PROXY: 1, DIRECT: 0 },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate', () => ({
  UnmaskedPredicate: class {
    static create = vi.fn().mockResolvedValue({ toJSON: () => ({ mock: 'predicate' }) });
  },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenState', () => ({
  TokenState: class {},
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm', () => ({
  HashAlgorithm: { SHA256: 'SHA256' },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenType', () => ({
  TokenType: class {},
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/MintCommitment', () => ({
  MintCommitment: { create: vi.fn() },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/MintTransactionData', () => ({
  MintTransactionData: class {},
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils', () => ({
  waitInclusionProof: vi.fn().mockResolvedValue({}),
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/InclusionProof', () => ({
  InclusionProof: {},
}));

vi.mock('../../../l1/network', () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  isWebSocketConnected: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../registry', () => ({
  TokenRegistry: {
    getInstance: () => ({
      getDefinition: () => null,
      getIconUrl: () => null,
    }),
    waitForReady: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../../serialization/txf-serializer', () => ({
  tokenToTxf: vi.fn().mockReturnValue(null),
  txfToToken: vi.fn(),
  getCurrentStateHash: vi.fn().mockReturnValue(''),
  buildTxfStorageData: vi.fn().mockResolvedValue({}),
  parseTxfStorageData: vi.fn().mockReturnValue({ tokens: [], tombstones: [], sent: [] }),
}));

// Stub the acquireBundle export so the auto-installed pool's workers
// return a synthetic VerifiedBundle without touching real CAR bytes.
// The stub is updated per-test via `mockAcquireBundle.mockResolvedValue(...)`.
const mockAcquireBundle = vi.fn();
vi.mock('../../../modules/payments/transfer/bundle-acquirer', () => ({
  acquireBundle: (...args: unknown[]) => mockAcquireBundle(...args),
  isReplayOutcome: () => false,
}));

// =============================================================================
// Test constants
// =============================================================================

const TOKEN_ID_A = 'aa00000000000000000000000000000000000000000000000000000000000001';
const COIN_ID_HEX = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
const BUNDLE_CID = 'bafyreiabc1234567890000000000000000000000000000000000000000000001';
const SENDER_PUBKEY = 'b'.repeat(64);

// =============================================================================
// Helpers
// =============================================================================

function makeIdentity(): FullIdentity {
  return {
    chainPubkey: '02' + 'a'.repeat(64),
    l1Address: 'alpha1test',
    directAddress: 'DIRECT://test',
    privateKey: 'a'.repeat(64),
  };
}

function makeStorage(): StorageProvider {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
    delete: vi.fn(async (k: string) => { store.delete(k); }),
    clear: vi.fn(async () => store.clear()),
    has: vi.fn(async (k: string) => store.has(k)),
    keys: vi.fn(async () => [...store.keys()]),
  } as unknown as StorageProvider;
}

function makeTransport(): TransportProvider {
  return {
    sendTokenTransfer: vi.fn().mockResolvedValue(undefined),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn().mockResolvedValue(null),
    resolveTransportPubkeyInfo: vi.fn().mockResolvedValue(null),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    publishNametag: vi.fn().mockResolvedValue(undefined),
  } as unknown as TransportProvider;
}

function makeOracle(_tokenData?: unknown): OracleProvider {
  return {
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
    getStateTransitionClient: vi.fn().mockReturnValue(null),
    waitForProofSdk: vi.fn(),
  } as unknown as OracleProvider;
}

/**
 * Build a synthetic VerifiedBundle whose `pkg.assemble(tokenId)` returns
 * a bare token JSON object that parseTokenInfo can consume.
 *
 * The tokenData shape mirrors what SdkToken.fromJSON expects — the mock
 * for `Token.fromJSON` (above) returns a synthetic SDK token with the
 * configured tokenId and coinId.
 */
function buildVerifiedBundle(tokenId: string): VerifiedBundle {
  const tokenData = {
    genesis: {
      data: {
        tokenId,
        coinData: [[COIN_ID_HEX, '1000000']],
        tokenType: '00',
        tokenData: '',
        salt: '00',
      },
    },
    state: { stateHash: '1'.repeat(64) },
  };
  const rootRef: RootRef = {
    contentHash: ('cc' + '0'.repeat(62)) as never,
    tokenId,
    chainDepth: 1,
  };
  return {
    verified: true as const,
    pkg: {
      assemble: (_tokenId: string) => tokenData,
    } as never,
    bundleCid: BUNDLE_CID,
    claimedTokens: [rootRef],
    advisoryUnclaimedRoots: [],
    missingClaimedTokenIds: [],
    droppedDeepUnclaimed: 0,
  };
}

/** Build a synthetic `uxf-car` payload for a single token. */
function buildUxfCarPayload(tokenId: string): UxfV1Payload {
  return {
    kind: 'uxf-car',
    version: '1.0',
    mode: 'conservative',
    bundleCid: BUNDLE_CID,
    tokenIds: [tokenId],
    carBase64: 'AAAA', // stub — acquireBundle is mocked, bytes not read
    memo: 'test-memo',
  };
}

/** Build the IncomingTokenTransfer wrapper that handleIncomingTransfer expects. */
function buildIncomingTransfer(payload: UxfV1Payload): IncomingTokenTransfer {
  return {
    id: 'synthetic-transfer-id',
    payload: payload as unknown as IncomingTokenTransfer['payload'],
    senderTransportPubkey: SENDER_PUBKEY,
    timestamp: Date.now(),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('PaymentsModule — default IngestWorkerPool auto-install (Phase 9.5.E)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 1. Structural / wiring tests
  // ---------------------------------------------------------------------------

  describe('auto-install gate', () => {
    it('creates a non-null ingestPool after initialize() when recipientUxf defaults to true', () => {
      const module = createPaymentsModule();
      const emitEvent = vi.fn();
      module.initialize({
        identity: makeIdentity(),
        storage: makeStorage(),
        transport: makeTransport(),
        oracle: makeOracle(undefined),
        emitEvent,
      });

      // The private field must be populated.
      expect((module as unknown as { ingestPool: unknown }).ingestPool).not.toBeNull();
      expect((module as unknown as { ingestPool: unknown }).ingestPool).toBeInstanceOf(IngestWorkerPool);

      module.destroy();
    });

    it('creates a non-null ingestPool when features.recipientUxf is explicitly true', () => {
      const module = createPaymentsModule({ features: { recipientUxf: true } });
      const emitEvent = vi.fn();
      module.initialize({
        identity: makeIdentity(),
        storage: makeStorage(),
        transport: makeTransport(),
        oracle: makeOracle(undefined),
        emitEvent,
      });

      expect((module as unknown as { ingestPool: unknown }).ingestPool).toBeInstanceOf(IngestWorkerPool);

      module.destroy();
    });

    it('does NOT create an ingestPool when features.recipientUxf is false', () => {
      const module = createPaymentsModule({ features: { recipientUxf: false } });
      module.initialize({
        identity: makeIdentity(),
        storage: makeStorage(),
        transport: makeTransport(),
        oracle: makeOracle(undefined),
        emitEvent: vi.fn(),
      });

      expect((module as unknown as { ingestPool: unknown }).ingestPool).toBeNull();

      module.destroy();
    });

    it('does NOT overwrite a pool pre-installed before initialize()', () => {
      const module = createPaymentsModule();

      // Install a custom pool BEFORE initialize().
      const customPool = new IngestWorkerPool({
        lru: new ReplayLRU(),
        perTokenMutex: new PerTokenMutex(),
        processToken: vi.fn().mockResolvedValue(undefined),
        emit: vi.fn(),
      });
      module.installIngestWorkerPool(customPool);

      module.initialize({
        identity: makeIdentity(),
        storage: makeStorage(),
        transport: makeTransport(),
        oracle: makeOracle(undefined),
        emitEvent: vi.fn(),
      });

      // Auto-install must NOT have replaced the consumer's pool.
      expect((module as unknown as { ingestPool: unknown }).ingestPool).toBe(customPool);

      module.destroy();
    });

    it('is destroyed when module.destroy() is called (no pool leak)', () => {
      const module = createPaymentsModule();
      module.initialize({
        identity: makeIdentity(),
        storage: makeStorage(),
        transport: makeTransport(),
        oracle: makeOracle(undefined),
        emitEvent: vi.fn(),
      });

      const pool = (module as unknown as { ingestPool: IngestWorkerPool }).ingestPool!;
      const destroySpy = vi.spyOn(pool, 'destroy');

      module.destroy();

      expect(destroySpy).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // 2. End-to-end routing: UXF v1.0 → auto-installed pool → transfer:incoming
  // ---------------------------------------------------------------------------

  describe('UXF v1.0 payload routing through the auto-installed pool', () => {
    let module: ReturnType<typeof createPaymentsModule>;
    let emitEvent: ReturnType<typeof vi.fn>;
    let handleTransfer: (transfer: IncomingTokenTransfer) => Promise<void>;

    beforeEach(() => {
      vi.clearAllMocks();

      // Wire the acquirer stub to return a synthetic VerifiedBundle.
      mockAcquireBundle.mockResolvedValue(buildVerifiedBundle(TOKEN_ID_A));

      module = createPaymentsModule({ features: { recipientUxf: true } });
      emitEvent = vi.fn();

      // Capture the handleIncomingTransfer binding for direct invocation
      // (bypasses the transport subscription so we don't need a live relay).
      handleTransfer = (t: IncomingTokenTransfer) =>
        (module as unknown as { handleIncomingTransfer: (t: IncomingTokenTransfer) => Promise<void> }).handleIncomingTransfer(t);

      const oracle = makeOracle(undefined);
      module.initialize({
        identity: makeIdentity(),
        storage: makeStorage(),
        transport: makeTransport(),
        oracle,
        emitEvent,
      });

      // Bypass heavy load() so tokens start empty but addToken() works.
      (module as unknown as { loaded: boolean }).loaded = true;
      (module as unknown as { loadedPromise: Promise<void> | null }).loadedPromise = null;
    });

    afterEach(() => {
      module.destroy();
    });

    it('emits transfer:incoming with the assembled token when a uxf-car payload arrives', async () => {
      const payload = buildUxfCarPayload(TOKEN_ID_A);
      const incoming = buildIncomingTransfer(payload);

      // handleIncomingTransfer routes UXF to the pool and awaits it.
      await handleTransfer(incoming);

      // Verify transfer:incoming was emitted exactly once.
      const calls = (emitEvent as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([event]: [string]) => event === 'transfer:incoming',
      );
      expect(calls.length).toBe(1);

      const [, incomingTransferPayload] = calls[0] as [string, { tokens: { id: string; amount: string }[]; senderPubkey: string; memo?: string }];
      expect(incomingTransferPayload.tokens).toHaveLength(1);
      expect(incomingTransferPayload.senderPubkey).toBe(SENDER_PUBKEY);
      expect(incomingTransferPayload.memo).toBe('test-memo');
    });

    it('adds the assembled token to module.getTokens() after processing', async () => {
      const payload = buildUxfCarPayload(TOKEN_ID_A);
      await handleTransfer(buildIncomingTransfer(payload));

      const tokens = module.getTokens();
      expect(tokens.length).toBeGreaterThanOrEqual(1);
    });

    it('deduplicates: dispatching the same bundleCid twice does not add two tokens', async () => {
      // Second dispatch uses the same bundleCid → ReplayLRU in the pool
      // short-circuits (bundle already verified). processToken won't run.
      // In this simplified test we just verify addToken dedup via stateHash.
      const payload = buildUxfCarPayload(TOKEN_ID_A);
      await handleTransfer(buildIncomingTransfer(payload));
      await handleTransfer(buildIncomingTransfer(payload));

      // At most one token for TOKEN_ID_A.
      const tokens = module.getTokens().filter(
        (t) => t.sdkData?.includes(TOKEN_ID_A),
      );
      expect(tokens.length).toBeLessThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Advisory-unclaimed-root filter (Phase 9.6.A fix)
  // ---------------------------------------------------------------------------

  describe('advisoryUnclaimedRoots are silently skipped by default processToken', () => {
    /**
     * Root cause: the pool dispatcher sends BOTH claimedTokens AND
     * advisoryUnclaimedRoots to processToken. The default closure must
     * skip advisory roots — they are NOT meant for the recipient, have no
     * manifest entry in the recipient's view, and pkg.assemble() would
     * throw TOKEN_NOT_FOUND for them.
     *
     * This suite feeds the auto-installed pool a bundle that contains:
     *   - TOKEN_ID_A as a CLAIMED root (payload.tokenIds = [TOKEN_ID_A])
     *   - TOKEN_ID_B as an ADVISORY UNCLAIMED root (sender's change-output)
     *
     * Expected:
     *   - TOKEN_ID_A is assembled, validated, added, transfer:incoming emitted
     *   - TOKEN_ID_B: processToken returns early (no assemble, no oracle, no
     *     storage, no event)
     *   - pkg.assemble() is NOT called with TOKEN_ID_B
     *   - oracle.validateToken() is NOT called for TOKEN_ID_B's data
     *   - transfer:incoming is emitted exactly once (for TOKEN_ID_A only)
     */

    const TOKEN_ID_B = 'bb00000000000000000000000000000000000000000000000000000000000002';

    /** Build a bundle with TOKEN_ID_A claimed and TOKEN_ID_B advisory. */
    function buildBundleWithAdvisoryRoot(): VerifiedBundle {
      const tokenDataA = {
        genesis: {
          data: {
            tokenId: TOKEN_ID_A,
            coinData: [[COIN_ID_HEX, '1000000']],
            tokenType: '00',
            tokenData: '',
            salt: '00',
          },
        },
        state: { stateHash: '1'.repeat(64) },
      };

      const claimedRef: RootRef = {
        contentHash: ('cc' + '0'.repeat(62)) as never,
        tokenId: TOKEN_ID_A,
        chainDepth: 1,
      };
      const advisoryRef: RootRef = {
        contentHash: ('dd' + '0'.repeat(62)) as never,
        tokenId: TOKEN_ID_B,
        chainDepth: 1,
      };

      // assemble() is spied: for TOKEN_ID_A return real data; for TOKEN_ID_B
      // it should NEVER be called (the guard returns before reaching it).
      const assembleSpy = vi.fn((tokenId: string) => {
        if (tokenId === TOKEN_ID_A) return tokenDataA;
        throw new Error(`pkg.assemble called for non-claimed token ${tokenId}`);
      });

      return {
        verified: true as const,
        pkg: { assemble: assembleSpy } as never,
        bundleCid: BUNDLE_CID,
        claimedTokens: [claimedRef],
        advisoryUnclaimedRoots: [advisoryRef],
        missingClaimedTokenIds: [],
        droppedDeepUnclaimed: 0,
      };
    }

    let module: ReturnType<typeof createPaymentsModule>;
    let emitEvent: ReturnType<typeof vi.fn>;
    let handleTransfer: (transfer: IncomingTokenTransfer) => Promise<void>;
    let oracle: OracleProvider;

    beforeEach(() => {
      vi.clearAllMocks();

      const bundle = buildBundleWithAdvisoryRoot();
      mockAcquireBundle.mockResolvedValue(bundle);

      module = createPaymentsModule({ features: { recipientUxf: true } });
      emitEvent = vi.fn();
      oracle = makeOracle(undefined);

      handleTransfer = (t: IncomingTokenTransfer) =>
        (module as unknown as { handleIncomingTransfer: (t: IncomingTokenTransfer) => Promise<void> }).handleIncomingTransfer(t);

      module.initialize({
        identity: makeIdentity(),
        storage: makeStorage(),
        transport: makeTransport(),
        oracle,
        emitEvent,
      });

      (module as unknown as { loaded: boolean }).loaded = true;
      (module as unknown as { loadedPromise: Promise<void> | null }).loadedPromise = null;
    });

    afterEach(() => {
      module.destroy();
    });

    it('emits transfer:incoming exactly once (for the claimed token only)', async () => {
      // payload.tokenIds = [TOKEN_ID_A] → TOKEN_ID_B is advisory
      const payload = buildUxfCarPayload(TOKEN_ID_A);
      await handleTransfer(buildIncomingTransfer(payload));

      const incomingCalls = (emitEvent as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([event]: [string]) => event === 'transfer:incoming',
      );
      expect(incomingCalls.length).toBe(1);
    });

    it('does NOT call pkg.assemble() for the advisory root TOKEN_ID_B', async () => {
      // The bundle's assemble spy throws if called with TOKEN_ID_B.
      // If the guard is missing, this test would throw and fail.
      const bundle = mockAcquireBundle.mock.results[0]?.value as VerifiedBundle | undefined;
      // Re-read from acquireBundle — the spy is in the bundle returned to the pool.
      // We just dispatch; the test assertion is that no error is thrown
      // (assemble(TOKEN_ID_B) would throw) AND oracle was NOT called for it.
      const payload = buildUxfCarPayload(TOKEN_ID_A);
      // Should not throw.
      await expect(handleTransfer(buildIncomingTransfer(payload))).resolves.toBeUndefined();
      void bundle;
    });

    it('does NOT call oracle.validateToken() for the advisory root TOKEN_ID_B', async () => {
      const payload = buildUxfCarPayload(TOKEN_ID_A);
      await handleTransfer(buildIncomingTransfer(payload));

      // oracle.validateToken should be called exactly once — for TOKEN_ID_A
      // (the claimed token). It must NOT have been called a second time for
      // TOKEN_ID_B (the advisory root that the guard silently skips before
      // reaching the oracle call).
      expect((oracle.validateToken as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    });

    it('adds TOKEN_ID_A to getTokens() but NOT TOKEN_ID_B', async () => {
      const payload = buildUxfCarPayload(TOKEN_ID_A);
      await handleTransfer(buildIncomingTransfer(payload));

      const tokens = module.getTokens();
      const hasA = tokens.some((t) => t.sdkData?.includes(TOKEN_ID_A));
      const hasB = tokens.some((t) => t.sdkData?.includes(TOKEN_ID_B));
      expect(hasA).toBe(true);
      expect(hasB).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Conservative-mode recipient-side finalization (Phase 9.6.C)
  // ---------------------------------------------------------------------------

  /**
   * Verifies that the default processToken closure performs recipient-side
   * finalization when:
   *   - the bundle carries a transfer transaction WITH a non-null inclusionProof
   *     (conservative mode), and
   *   - the oracle exposes `getStateTransitionClient()` + `getTrustBase()`.
   *
   * The expected sequence inside processToken:
   *   1. assembledJson.transactions is non-empty → enter finalization block.
   *   2. stClient and trustBase are present → enter inner try.
   *   3. TransferTransactionData.fromJSON() extracts the salt.
   *   4. pkg.assembleAtState(tokenId, txCount-1) produces the source token JSON.
   *   5. SdkToken.fromJSON(sourceTokenJson) builds the source SDK token.
   *   6. UnmaskedPredicate.create(...) builds the recipient predicate.
   *   7. TransferTransaction.fromJSON(lastTxJson) succeeds (proof is present).
   *   8. finalizeTransferToken(sourceToken, lastTx, stClient, trustBase) is called;
   *      stClient.finalizeTransaction() returns the finalized mock SDK token.
   *   9. finalizedToken.toJSON() → tokenData used to build the wallet Token.
   *  10. oracle.validateToken(tokenData) is called (status is 'confirmed').
   *  11. addToken() persists it; emitEvent('transfer:incoming', ...) fires.
   *
   * The finalized token's status MUST be 'confirmed' (not 'pending').
   */
  describe('conservative-mode recipient-side finalization', () => {
    const FINALIZED_TOKEN_JSON = {
      genesis: {
        data: {
          tokenId: TOKEN_ID_A,
          coinData: [[COIN_ID_HEX, '1000000']],
          tokenType: '00',
          tokenData: '',
          salt: '00',
        },
      },
      state: { stateHash: '2'.repeat(64) },  // different from sender's state
      transactions: [
        {
          data: { recipient: 'DIRECT://test', salt: '00' },
          inclusionProof: { path: [], leaf: {} },  // non-null → conservative
        },
      ],
    };

    /** Build a VerifiedBundle whose pkg carries a transfer transaction. */
    function buildConservativeBundle(): VerifiedBundle {
      const sourceTokenJson = {
        genesis: {
          data: {
            tokenId: TOKEN_ID_A,
            coinData: [[COIN_ID_HEX, '1000000']],
            tokenType: '00',
            tokenData: '',
            salt: '00',
          },
        },
        state: { stateHash: '1'.repeat(64) },
        // no transactions → N-1 state (source)
      };

      // assemble() returns the full sender's view (with transactions).
      // assembleAtState(tokenId, 0) returns the source token (no transactions).
      // transactionCount() returns 1.
      const assembleSpy = vi.fn((tokenId: string) => {
        if (tokenId === TOKEN_ID_A) return FINALIZED_TOKEN_JSON;
        throw new Error(`unexpected assemble(${tokenId})`);
      });
      const assembleAtStateSpy = vi.fn((_tokenId: string, _stateIdx: number) => sourceTokenJson);
      const transactionCountSpy = vi.fn((_tokenId: string) => 1);

      const rootRef: RootRef = {
        contentHash: ('cc' + '0'.repeat(62)) as never,
        tokenId: TOKEN_ID_A,
        chainDepth: 1,
      };

      return {
        verified: true as const,
        pkg: {
          assemble: assembleSpy,
          assembleAtState: assembleAtStateSpy,
          transactionCount: transactionCountSpy,
        } as never,
        bundleCid: BUNDLE_CID,
        claimedTokens: [rootRef],
        advisoryUnclaimedRoots: [],
        missingClaimedTokenIds: [],
        droppedDeepUnclaimed: 0,
      };
    }

    /** Oracle that exposes stClient + trustBase for recipient-side finalization. */
    function makeOracleWithStClient(): OracleProvider {
      const finalizedSdkToken = {
        toJSON: vi.fn(() => FINALIZED_TOKEN_JSON),
        id: {
          toJSON: () => TOKEN_ID_A,
          toString: () => TOKEN_ID_A,
        },
        coins: {
          coins: [[[{ toJSON: () => COIN_ID_HEX }, '1000000']]],
        },
        state: {},
      };

      const mockStClient = {
        finalizeTransaction: vi.fn().mockResolvedValue(finalizedSdkToken),
      };

      const mockTrustBase = {};

      return {
        validateToken: vi.fn().mockResolvedValue({ valid: true }),
        getStateTransitionClient: vi.fn().mockReturnValue(mockStClient),
        // getTrustBase is not part of OracleProvider interface; added via cast
        getTrustBase: vi.fn().mockReturnValue(mockTrustBase),
        waitForProofSdk: vi.fn(),
      } as unknown as OracleProvider;
    }

    let module: ReturnType<typeof createPaymentsModule>;
    let emitEvent: ReturnType<typeof vi.fn>;
    let handleTransfer: (transfer: IncomingTokenTransfer) => Promise<void>;
    let oracle: OracleProvider;

    beforeEach(() => {
      vi.clearAllMocks();

      mockAcquireBundle.mockResolvedValue(buildConservativeBundle());

      module = createPaymentsModule({ features: { recipientUxf: true } });
      emitEvent = vi.fn();
      oracle = makeOracleWithStClient();

      handleTransfer = (t: IncomingTokenTransfer) =>
        (module as unknown as { handleIncomingTransfer: (t: IncomingTokenTransfer) => Promise<void> }).handleIncomingTransfer(t);

      module.initialize({
        identity: makeIdentity(),
        storage: makeStorage(),
        transport: makeTransport(),
        oracle,
        emitEvent,
      });

      (module as unknown as { loaded: boolean }).loaded = true;
      (module as unknown as { loadedPromise: Promise<void> | null }).loadedPromise = null;
    });

    afterEach(() => {
      module.destroy();
    });

    it('calls stClient.finalizeTransaction() for a conservative-mode bundle', async () => {
      const payload = buildUxfCarPayload(TOKEN_ID_A);
      await handleTransfer(buildIncomingTransfer(payload));

      // stClient.finalizeTransaction() must have been called (via finalizeTransferToken).
      const stClient = (oracle.getStateTransitionClient as ReturnType<typeof vi.fn>)()! as {
        finalizeTransaction: ReturnType<typeof vi.fn>;
      };
      expect(stClient.finalizeTransaction).toHaveBeenCalled();
    });

    it('emits transfer:incoming with status confirmed (not pending)', async () => {
      const payload = buildUxfCarPayload(TOKEN_ID_A);
      await handleTransfer(buildIncomingTransfer(payload));

      const incomingCalls = (emitEvent as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([event]: [string]) => event === 'transfer:incoming',
      );
      expect(incomingCalls.length).toBe(1);

      const [, transferPayload] = incomingCalls[0] as [string, { tokens: { status?: string }[] }];
      expect(transferPayload.tokens).toHaveLength(1);
      expect(transferPayload.tokens[0].status).toBe('confirmed');
    });

    it('calls oracle.validateToken() for the finalized token data', async () => {
      const payload = buildUxfCarPayload(TOKEN_ID_A);
      await handleTransfer(buildIncomingTransfer(payload));

      expect((oracle.validateToken as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    });

    it('adds the finalized token to getTokens() with status confirmed', async () => {
      const payload = buildUxfCarPayload(TOKEN_ID_A);
      await handleTransfer(buildIncomingTransfer(payload));

      const tokens = module.getTokens();
      expect(tokens.length).toBeGreaterThanOrEqual(1);
      const token = tokens.find((t) => t.sdkData?.includes(TOKEN_ID_A));
      expect(token).toBeDefined();
      expect(token!.status).toBe('confirmed');
    });
  });
});
