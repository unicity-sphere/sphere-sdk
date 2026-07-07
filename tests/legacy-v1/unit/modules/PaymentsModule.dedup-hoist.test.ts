/**
 * Issue #275 P2 — tests for the V6/V5 bundle dedup hoist in
 * handleIncomingTransfer.
 *
 * The hoist short-circuits BEFORE calling
 * `processCombinedTransferBundle` / `processInstantSplitBundle` AND
 * BEFORE the trailing `awaitAllProvidersDurable()` when the bundle's
 * transferId / splitGroupId is already in the persistent dedup set.
 *
 * Without the hoist (pre-#275 behavior), every duplicate dispatch
 * paid 2-3s on `awaitAllProvidersDurable()` even when the inner
 * `processCombinedTransferBundle` immediately deduped at line 6783.
 * The OPTIMIZATION-FINDINGS report attributed 71.5% of §C wall-clock
 * to this cost.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPaymentsModule } from '../../../modules/payments/PaymentsModule';
import type { FullIdentity } from '../../../types';
import type { StorageProvider } from '../../../storage';
import type { TransportProvider, IncomingTokenTransfer } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type {
  CombinedTransferBundleV6,
  InstantSplitBundleV5,
} from '../../../types/instant-split';

// =============================================================================
// SDK mocks — prevent network/crypto. We never actually parse a real bundle in
// these tests; the hoist short-circuits before any SDK call happens.
// =============================================================================

vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token', () => ({
  Token: { fromJSON: vi.fn() },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/token/fungible/CoinId', () => ({
  CoinId: class MockCoinId { toJSON() { return 'aa'.repeat(32); } },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/TransferCommitment', () => ({
  TransferCommitment: { fromJSON: vi.fn() },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/MintCommitment', () => ({
  MintCommitment: { create: vi.fn() },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/MintTransactionData', () => ({
  MintTransactionData: { fromJSON: vi.fn() },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction', () => ({
  TransferTransaction: class {},
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/sign/SigningService', () => ({
  SigningService: { fromKeyPair: vi.fn(), createFromSecret: vi.fn() },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/address/AddressScheme', () => ({
  AddressScheme: class {},
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate', () => ({
  UnmaskedPredicate: class {},
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
vi.mock('@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils', () => ({
  waitInclusionProof: vi.fn(),
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
    getInstance: () => ({ getDefinition: () => null, getIconUrl: () => null }),
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

// =============================================================================
// Helpers
// =============================================================================

const SENDER_PUBKEY = 'b'.repeat(64);

function makeIdentity(): FullIdentity {
  return {
    chainPubkey: '02' + 'a'.repeat(64),
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
    sendTokenTransfer: vi.fn(),
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

function makeOracle(): OracleProvider {
  return {
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
    getStateTransitionClient: vi.fn().mockReturnValue(null),
    waitForProofSdk: vi.fn(),
  } as unknown as OracleProvider;
}

function buildV6Bundle(transferId: string): CombinedTransferBundleV6 {
  return {
    version: '6.0',
    type: 'COMBINED_TRANSFER',
    transferId,
    splitBundle: null,
    directTokens: [],
    totalAmount: '0',
    coinId: 'aa'.repeat(32),
    senderPubkey: SENDER_PUBKEY,
  };
}

function buildV5Bundle(splitGroupId: string): InstantSplitBundleV5 {
  // Shape that passes `isInstantSplitBundle` (V5 branch). All required
  // fields are present as strings — the hoist only reads splitGroupId,
  // but the type guard demands the full set.
  return {
    version: '5.0',
    type: 'INSTANT_SPLIT',
    splitGroupId,
    coinId: 'aa'.repeat(32),
    amount: '0',
    senderPubkey: SENDER_PUBKEY,
    recipientMintData: '{}',
    transferCommitment: '{}',
    recipientSaltHex: '00',
    transferSaltHex: '00',
    burnTransaction: '{}',
    mintedTokenStateJson: '{}',
    finalRecipientStateJson: '{}',
    recipientAddressJson: '{}',
  } as unknown as InstantSplitBundleV5;
}

function buildIncomingTransfer(payload: unknown): IncomingTokenTransfer {
  return {
    id: 'synthetic-transfer-id',
    payload: payload as IncomingTokenTransfer['payload'],
    senderTransportPubkey: SENDER_PUBKEY,
    timestamp: Date.now(),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('Issue #275 P2 — V6/V5 bundle dedup hoist', () => {
  let module: ReturnType<typeof createPaymentsModule>;
  let processV6Spy: ReturnType<typeof vi.fn>;
  let processV5Spy: ReturnType<typeof vi.fn>;
  let awaitDurableSpy: ReturnType<typeof vi.fn>;
  let callHandle: (transfer: IncomingTokenTransfer) => Promise<boolean>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Disable UXF / legacy adapter routing so the test exercises only
    // the V6/V5 code path.
    module = createPaymentsModule({
      features: {
        recipientUxf: false,
        recipientLegacyAdapter: false,
      },
    });

    module.initialize({
      identity: makeIdentity(),
      storage: makeStorage(),
      transport: makeTransport(),
      oracle: makeOracle(),
      emitEvent: vi.fn(),
    });

    // Bypass load() so handleIncomingTransfer doesn't block on the
    // loaded promise (tests directly populate the dedup set).
    (module as unknown as { loaded: boolean }).loaded = true;
    (module as unknown as { loadedPromise: Promise<void> | null }).loadedPromise = null;

    // Spy on the bundle-processing entrypoints. Replace with stubs so
    // they don't actually run (would fail because we haven't loaded a
    // real token state).
    processV6Spy = vi.fn().mockResolvedValue(undefined);
    processV5Spy = vi.fn().mockResolvedValue({ success: true, token: null });
    awaitDurableSpy = vi.fn().mockResolvedValue(true);

    const m = module as unknown as {
      processCombinedTransferBundle: typeof processV6Spy;
      processInstantSplitBundle: typeof processV5Spy;
      awaitAllProvidersDurable: typeof awaitDurableSpy;
      handleIncomingTransfer: (t: IncomingTokenTransfer) => Promise<boolean>;
    };
    m.processCombinedTransferBundle = processV6Spy;
    m.processInstantSplitBundle = processV5Spy;
    m.awaitAllProvidersDurable = awaitDurableSpy;
    callHandle = (t) => m.handleIncomingTransfer(t);
  });

  afterEach(() => {
    module.destroy();
  });

  describe('V6 (COMBINED_TRANSFER) hoist', () => {
    it('short-circuits when transferId is already in processedCombinedTransferIds', async () => {
      const transferId = 'v6-dup-' + 'a'.repeat(56);
      const bundle = buildV6Bundle(transferId);

      // Pre-populate the persistent dedup set as if a prior session
      // already finalized this bundle.
      (module as unknown as { processedCombinedTransferIds: Set<string> }).processedCombinedTransferIds.add(transferId);

      const result = await callHandle(buildIncomingTransfer(bundle));

      // Hoist returns true so transport advances lastEventTs past the dup.
      expect(result).toBe(true);
      // Critical: neither the bundle processor NOR the durability wait ran.
      expect(processV6Spy).not.toHaveBeenCalled();
      expect(awaitDurableSpy).not.toHaveBeenCalled();
    });

    it('runs the full V6 pipeline for an unseen transferId', async () => {
      const transferId = 'v6-fresh-' + 'b'.repeat(54);
      const bundle = buildV6Bundle(transferId);

      // dedup set is empty — fresh bundle.
      expect(
        (module as unknown as { processedCombinedTransferIds: Set<string> }).processedCombinedTransferIds.has(transferId),
      ).toBe(false);

      await callHandle(buildIncomingTransfer(bundle));

      // Hoist did NOT short-circuit — both the processor and the
      // durability wait were called.
      expect(processV6Spy).toHaveBeenCalledTimes(1);
      expect(processV6Spy.mock.calls[0][0]).toEqual(bundle);
      expect(awaitDurableSpy).toHaveBeenCalledTimes(1);
    });

    it('does NOT short-circuit when the dedup set contains a different transferId', async () => {
      const bundle = buildV6Bundle('v6-target-' + 'c'.repeat(53));

      (module as unknown as { processedCombinedTransferIds: Set<string> }).processedCombinedTransferIds.add(
        'v6-unrelated-' + 'd'.repeat(51),
      );

      await callHandle(buildIncomingTransfer(bundle));

      expect(processV6Spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('V5 (INSTANT_SPLIT) hoist', () => {
    it('short-circuits when splitGroupId is already in processedSplitGroupIds', async () => {
      const splitGroupId = 'v5-dup-' + 'a'.repeat(56);
      const bundle = buildV5Bundle(splitGroupId);

      (module as unknown as { processedSplitGroupIds: Set<string> }).processedSplitGroupIds.add(splitGroupId);

      const result = await callHandle(buildIncomingTransfer(bundle));

      expect(result).toBe(true);
      expect(processV5Spy).not.toHaveBeenCalled();
      expect(awaitDurableSpy).not.toHaveBeenCalled();
    });

    it('runs the full V5 pipeline for an unseen splitGroupId', async () => {
      const splitGroupId = 'v5-fresh-' + 'b'.repeat(54);
      const bundle = buildV5Bundle(splitGroupId);

      await callHandle(buildIncomingTransfer(bundle));

      expect(processV5Spy).toHaveBeenCalledTimes(1);
      expect(awaitDurableSpy).toHaveBeenCalledTimes(1);
    });

    it('does NOT short-circuit when splitGroupId is an empty string', async () => {
      // Hoist guard is: `typeof v5SplitGroupId === 'string' && length > 0`.
      // Empty-string splitGroupId should bypass the short-circuit and
      // forward to the processor.
      const bundle = buildV5Bundle('') as unknown as InstantSplitBundleV5;

      // Don't add anything to processedSplitGroupIds — empty string in
      // the set would also be unusual. We're testing the early guard.
      await callHandle(buildIncomingTransfer(bundle));

      expect(processV5Spy).toHaveBeenCalledTimes(1);
    });
  });
});
