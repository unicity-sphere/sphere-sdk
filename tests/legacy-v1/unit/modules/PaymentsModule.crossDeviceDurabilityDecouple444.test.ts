/**
 * Issue #444 — fresh-CLI faucet TOKEN_TRANSFER perma-drop fix
 * (Option B: split local-commit and remote-publish phases).
 *
 * Before #444, `PaymentsModule.handleIncomingTransfer` awaited the FULL
 * flush per receive — including the aggregator pointer publish + IPFS
 * HEAD-verify. When the cross-device leg blipped (publish transient,
 * gateway propagation lag), the method returned `false`, the Nostr
 * transport refused to advance `lastEventTs`, and the per-event cooldown
 * ledger armed a 30s+ exponential backoff. Short-lived CLI processes
 * exited before the cooldown could elapse; the relay aged out the
 * TOKEN_TRANSFER event before the next CLI run; the receiver's wallet
 * showed no balance despite local OrbitDB+Helia state already being
 * durable (the bundle ref is written at `flushToIpfs` step 6 BEFORE
 * the publish step 9 that fails).
 *
 * The fix splits `flushToIpfs` into LOCAL-commit and REMOTE-publish
 * phases. `awaitAllProvidersDurable` now calls each provider's new
 * `awaitNextLocalFlush` API (Profile provider) which:
 *   - Pins the bundle CAR + writes the OrbitDB bundle ref synchronously
 *     (local durability invariant);
 *   - Stamps `pendingPublishCid` + calls `notifyProfileDirty()` so the
 *     aggregator publish is deferred to the dirty-flush debouncer, the
 *     periodic pointer-poll's `retryPendingPublishIfAny`, or the
 *     graceful-shutdown `awaitRemoteDurability` gate.
 *
 * Multiple TOKEN_TRANSFER receives in the debounce window coalesce
 * into ONE publish; the Nostr cursor advances on local commit alone,
 * decoupled from cross-device propagation latency.
 *
 * Tests verify:
 *   1. V6 path: local flush succeeds → handler returns true (cursor advances).
 *   2. V6 path: local flush fails (synthetic flusher reject) → handler
 *      returns false (preserves at-least-once for genuine local-loss).
 *   3. V6 path: processCombinedTransferBundle throws → handler returns
 *      false (early failure surface preserved).
 *   4. V5 INSTANT_SPLIT path: same shape.
 *   5. `awaitAllProvidersDurable` is the gate called by every success
 *      path — local-flush semantics gate the cursor.
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
// SDK mocks — same shape as dedup-hoist tests; we don't actually exercise the
// inner SDK at the boundary of `handleIncomingTransfer`.
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
// Helpers — mirror the dedup-hoist test fixture for shape consistency.
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
    id: 'synthetic-issue-444',
    payload: payload as IncomingTokenTransfer['payload'],
    senderTransportPubkey: SENDER_PUBKEY,
    timestamp: Date.now(),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('Issue #444 — split local-commit and remote-publish (Option B)', () => {
  let module: ReturnType<typeof createPaymentsModule>;
  let processV6Spy: ReturnType<typeof vi.fn>;
  let processV5Spy: ReturnType<typeof vi.fn>;
  let awaitDurableSpy: ReturnType<typeof vi.fn>;
  let callHandle: (transfer: IncomingTokenTransfer) => Promise<boolean>;

  beforeEach(() => {
    vi.clearAllMocks();
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

    (module as unknown as { loaded: boolean }).loaded = true;
    (module as unknown as { loadedPromise: Promise<void> | null }).loadedPromise = null;

    processV6Spy = vi.fn().mockResolvedValue(undefined);
    processV5Spy = vi.fn().mockResolvedValue({ success: true, token: null });
    // Default: simulate a successful flush. Individual tests override
    // this to model cross-device durability failure.
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

  describe('V6 path (COMBINED_TRANSFER bundle)', () => {
    it('returns true when local flush succeeds — Nostr cursor advances', async () => {
      // Local flush succeeds → cursor advances. Aggregator publish is
      // deferred (covered by the dirty-flush debouncer + pointer poll
      // + shutdown drain).
      awaitDurableSpy.mockResolvedValue(true);

      const bundle = buildV6Bundle('v6-issue444-happy-' + 'a'.repeat(46));
      const result = await callHandle(buildIncomingTransfer(bundle));

      expect(result).toBe(true);
      expect(processV6Spy).toHaveBeenCalledTimes(1);
      // The local-only flush gate WAS driven so OrbitDB+Helia commit
      // synchronously. After #444 the gate calls awaitNextLocalFlush
      // (which the test stub renames as awaitAllProvidersDurable).
      expect(awaitDurableSpy).toHaveBeenCalledTimes(1);
    });

    it('returns false when LOCAL flush fails — pins cursor for at-least-once replay', async () => {
      // Genuine local-loss case: the LOCAL-only flush rejects because
      // the OrbitDB write threw (synthetic: returns false from the
      // gate). The at-least-once invariant must pin the cursor.
      awaitDurableSpy.mockResolvedValue(false);

      const bundle = buildV6Bundle('v6-issue444-local-loss-' + 'a'.repeat(41));
      const result = await callHandle(buildIncomingTransfer(bundle));

      // Local commit failed → cursor stays pinned → event replays.
      expect(result).toBe(false);
      expect(processV6Spy).toHaveBeenCalledTimes(1);
      expect(awaitDurableSpy).toHaveBeenCalledTimes(1);
    });

    it('returns false when processCombinedTransferBundle THROWS — early failure pins cursor', async () => {
      // Genuine local-loss case: the bundle processor throws before
      // addToken/save runs. The at-least-once invariant must still pin
      // the cursor so the event replays.
      processV6Spy.mockRejectedValue(new Error('aggregator submit failed'));

      const bundle = buildV6Bundle('v6-issue444-throw-' + 'c'.repeat(46));
      const result = await callHandle(buildIncomingTransfer(bundle));

      expect(result).toBe(false);
      expect(processV6Spy).toHaveBeenCalledTimes(1);
      // The durability gate is NOT entered when v6Success is false —
      // there's nothing to flush, and the cursor must stay pinned.
      expect(awaitDurableSpy).not.toHaveBeenCalled();
    });
  });

  describe('V5 path (INSTANT_SPLIT bundle)', () => {
    it('returns true when local flush succeeds — cursor advances', async () => {
      awaitDurableSpy.mockResolvedValue(true);

      const bundle = buildV5Bundle('v5-issue444-' + 'a'.repeat(52));
      const result = await callHandle(buildIncomingTransfer(bundle));

      expect(result).toBe(true);
      expect(processV5Spy).toHaveBeenCalledTimes(1);
      expect(awaitDurableSpy).toHaveBeenCalledTimes(1);
    });

    it('returns false when LOCAL flush fails — pins cursor', async () => {
      awaitDurableSpy.mockResolvedValue(false);

      const bundle = buildV5Bundle('v5-issue444-local-loss-' + 'a'.repeat(41));
      const result = await callHandle(buildIncomingTransfer(bundle));

      expect(result).toBe(false);
      expect(processV5Spy).toHaveBeenCalledTimes(1);
      expect(awaitDurableSpy).toHaveBeenCalledTimes(1);
    });

    it('returns false when processInstantSplitBundle reports failure — local-loss surface preserved', async () => {
      processV5Spy.mockResolvedValue({
        success: false,
        token: null,
        error: 'sdk parse failed',
      });

      const bundle = buildV5Bundle('v5-issue444-fail-' + 'b'.repeat(47));
      const result = await callHandle(buildIncomingTransfer(bundle));

      expect(result).toBe(false);
      expect(processV5Spy).toHaveBeenCalledTimes(1);
      expect(awaitDurableSpy).not.toHaveBeenCalled();
    });
  });
});
