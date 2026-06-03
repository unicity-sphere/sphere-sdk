/**
 * Tests for #144 — receiver finalize-on-restart fix.
 *
 * Three layers:
 *  - L1: proof-polling jobs persist to KV on add/tick and restore on load.
 *  - L2: `resolveUnconfirmed` accepts status='pending' and routes V6-direct
 *        legacy receives through `resolveLegacyReceivedToken`.
 *  - L3: `loadFromStorageData` moves tokens whose latest-state predicate
 *        isn't ours AND have no plan to archive. `recoverStrandedReceivedTokens`
 *        registers polling jobs for stranded V6-direct receives.
 *
 * Pre-fix behavior: on CLI usage every `sphere <cmd>` is a fresh Node.js
 * process. `proofPollingJobs` Map dies between process invocations, so
 * V6-direct receives whose proof arrives later never finalize. After
 * save→load, status flips from 'submitted' to 'pending' (per `determineTokenStatus`
 * in txf-serializer.ts) and `resolveUnconfirmed` silently skipped it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createPaymentsModule,
  type PaymentsModuleDependencies,
  type ProofPollingJob,
} from '../../../modules/payments/PaymentsModule';
import { STORAGE_KEYS_ADDRESS } from '../../../constants';
import type { Token, FullIdentity } from '../../../types';
import type {
  StorageProvider,
  TokenStorageProvider,
  TxfStorageDataBase,
} from '../../../storage';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';

// ---------------------------------------------------------------------------
// SDK static-import mocks (match existing PaymentsModule.* test pattern)
// ---------------------------------------------------------------------------

vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token', () => ({
  Token: { fromJSON: vi.fn().mockResolvedValue({ id: { toString: () => 'mock-id' }, coins: null, state: {} }) },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/token/fungible/CoinId', () => ({
  CoinId: class { toJSON() { return 'UCT_HEX'; } },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/TransferCommitment', () => ({
  TransferCommitment: {
    fromJSON: vi.fn().mockResolvedValue({
      requestId: new Uint8Array([1, 2, 3, 4]),
      toJSON() { return { requestId: '01020304' }; },
      toTransaction() { return {}; },
    }),
  },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction', () => ({
  TransferTransaction: { fromJSON: vi.fn().mockResolvedValue({}) },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/TransferTransactionData', () => ({
  TransferTransactionData: {
    fromJSON: vi.fn().mockImplementation(async () => ({
      sourceState: {
        predicate: 'mock-predicate-cbor',
        async calculateHash() {
          return new Uint8Array([0xaa, 0xbb]);
        },
      },
      salt: new Uint8Array([0x33]),
      async calculateHash() {
        return { toJSON: () => '0000mocktxhash' };
      },
    })),
  },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/sign/SigningService', () => ({
  SigningService: {
    createFromSecret: vi.fn().mockResolvedValue({ sign: vi.fn(), publicKey: new Uint8Array([0x02]) }),
  },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/address/AddressScheme', () => ({
  AddressScheme: class { static DIRECT = 'DIRECT'; static PROXY = 'PROXY'; },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate', () => ({
  UnmaskedPredicate: { create: vi.fn().mockResolvedValue({}) },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/predicate/PredicateEngineService', () => ({
  PredicateEngineService: {
    createPredicate: vi.fn().mockResolvedValue({
      publicKey: new Uint8Array([0x02, 0x99, 0x88, 0x77]),
    }),
  },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/api/RequestId', () => ({
  RequestId: {
    create: vi.fn().mockResolvedValue({ toJSON: () => '00deadbeef00recovery00requestid' }),
  },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenState', () => ({
  TokenState: class {},
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm', () => ({
  HashAlgorithm: { SHA256: 'sha256' },
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
      getSymbol: (id: string) => id,
      getName: (id: string) => id,
      getDecimals: () => 8,
    }),
    waitForReady: vi.fn().mockResolvedValue(undefined),
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OUR_PUBKEY = '02' + 'a1'.repeat(32);
const OUR_DIRECT = 'DIRECT://9999ABCDEF';
const SENDER_PUBKEY = '03' + 'b2'.repeat(32);
const GENESIS_TOKEN_ID = '892069aea482d543'.padEnd(64, '0');
const STATE_HASH = '0000beef'.padEnd(64, '0');

/**
 * Build a V6-direct receive shape — a TXF with 2 transactions where the
 * last one has `inclusionProof: null` and `data.recipient.address` is
 * OUR_DIRECT. Mirrors what alice ships to bob in the issue reproduction.
 */
function makeV6DirectReceiveSdkData(opts?: {
  lastTxRecipient?: string;
  predicateContainsOurPubkey?: boolean;
}): string {
  const recipient = opts?.lastTxRecipient ?? OUR_DIRECT;
  // For the state.predicate, encode CBOR-hex containing SENDER's pubkey
  // unless explicitly overridden. The L3 invariant check looks for OUR
  // pubkey as a substring; absence means "not ours".
  const predicate = opts?.predicateContainsOurPubkey
    ? `0000${OUR_PUBKEY.toLowerCase()}0000`
    : `0000${SENDER_PUBKEY.toLowerCase()}0000`;

  return JSON.stringify({
    version: '2.0',
    genesis: {
      data: { tokenId: GENESIS_TOKEN_ID, tokenType: 'coinType', coinData: [['UCT_HEX', '100']] },
      inclusionProof: { authenticator: { stateHash: 'genesisHash' } },
    },
    state: {
      data: '',
      predicate,
    },
    transactions: [
      {
        previousStateHash: 'h0',
        newStateHash: STATE_HASH,
        predicate: 'pred1',
        inclusionProof: { authenticator: { stateHash: STATE_HASH } },
        data: { recipient: { address: 'PROXY://senderProxy', scheme: 'PROXY' } },
      },
      {
        previousStateHash: STATE_HASH,
        predicate: 'pred2',
        inclusionProof: null, // ← unproved alice→bob transition
        data: { recipient: { address: recipient, scheme: 'DIRECT' }, salt: '0x33' },
      },
    ],
    // _integrity.currentStateHash makes getCurrentStateHash deterministic
    // — the last tx has no newStateHash/inclusionProof, so without this
    // helper falls through to genesis.
    _integrity: { genesisDataJSONHash: '0000' + '0'.repeat(60), currentStateHash: STATE_HASH },
  });
}

function createDeps(getReturns?: Record<string, string | null>): {
  deps: PaymentsModuleDependencies;
  storageState: Map<string, string>;
  emittedEvents: Array<{ type: string; payload: unknown }>;
} {
  const storageState = new Map<string, string>();
  for (const [k, v] of Object.entries(getReturns ?? {})) {
    if (v !== null) storageState.set(k, v);
  }

  const mockStorage: StorageProvider = {
    id: 'mock-storage',
    name: 'Mock Storage',
    type: 'local',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    get: vi.fn(async (k: string) => storageState.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { storageState.set(k, v); }),
    remove: vi.fn(async (k: string) => { storageState.delete(k); }),
    has: vi.fn(async (k: string) => storageState.has(k)),
    keys: vi.fn(async () => Array.from(storageState.keys())),
    clear: vi.fn(async () => { storageState.clear(); }),
  };

  const emittedEvents: Array<{ type: string; payload: unknown }> = [];

  const mockTransport = {
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    sendTokenTransfer: vi.fn(),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
  } as unknown as TransportProvider;

  const mockOracle = {
    id: 'mock-oracle',
    name: 'Mock Oracle',
    type: 'network' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    initialize: vi.fn().mockResolvedValue(undefined),
    getProof: vi.fn().mockResolvedValue(null),
    waitForProofSdk: vi.fn().mockResolvedValue(null),
    getStateTransitionClient: vi.fn().mockReturnValue({}),
    getTrustBase: vi.fn().mockReturnValue({}),
  } as unknown as OracleProvider;

  const identity: FullIdentity = {
    chainPubkey: OUR_PUBKEY,
    l1Address: 'alpha1ourtestaddress',
    directAddress: OUR_DIRECT,
    // 64-hex (no 0x prefix) — `createSigningService` calls `hexToBytes`
    // which rejects non-hex inputs.
    privateKey: 'c'.repeat(64),
  };

  return {
    deps: {
      identity,
      storage: mockStorage,
      tokenStorageProviders: new Map<string, TokenStorageProvider<TxfStorageDataBase>>(),
      transport: mockTransport,
      oracle: mockOracle,
      emitEvent: vi.fn((type: string, payload: unknown) => {
        emittedEvents.push({ type, payload });
      }) as unknown as PaymentsModuleDependencies['emitEvent'],
    } as PaymentsModuleDependencies,
    storageState,
    emittedEvents,
  };
}

/** Access PaymentsModule internals (Map + private methods) for assertions. */
interface ModuleInternals {
  tokens: Map<string, Token>;
  archivedTokens: Map<string, unknown>;
  proofPollingJobs: Map<string, ProofPollingJob>;
  addProofPollingJob: (job: ProofPollingJob) => void;
  saveProofPollingJobs: () => Promise<void>;
  restoreProofPollingJobs: () => Promise<void>;
  recoverStrandedReceivedTokens: () => Promise<number>;
  saveCommitmentOnlyToken: (
    sourceTokenInput: unknown,
    commitmentInput: unknown,
    senderPubkey: string,
    deferPersistence?: boolean,
    skipGenesisDedup?: boolean,
  ) => Promise<Token | null>;
  loadFromStorageData: (data: TxfStorageDataBase) => void;
  isReceivedLegacyPending: (token: Token) => boolean;
  hasFinalizationPlan: (token: Token) => boolean;
  latestStatePredicateMatchesWallet: (token: Token) => boolean;
  resolveUnconfirmed: () => Promise<{ resolved: number; stillPending: number; failed: number; details: unknown[] }>;
}
function internals(m: ReturnType<typeof createPaymentsModule>): ModuleInternals {
  return m as unknown as ModuleInternals;
}

// =============================================================================
// L1 — Persistence of proof-polling jobs
// =============================================================================

describe('#144 L1 — proofPollingJobs persist across process restarts', () => {
  let module: ReturnType<typeof createPaymentsModule>;
  let setup: ReturnType<typeof createDeps>;

  beforeEach(() => {
    module = createPaymentsModule();
    setup = createDeps();
    module.initialize(setup.deps);
  });

  afterEach(() => {
    // Tear down setInterval timers (proofPolling, resolveUnconfirmed)
    // that initialize/addProofPollingJob may have started. Without this,
    // intervals leak across files and cause CI flakes (steelman FIX A).
    try { module.destroy(); } catch { /* ignore */ }
  });

  it('persists a job with sourceTokenJson to KV storage', async () => {
    const sdkData = makeV6DirectReceiveSdkData();
    const token: Token = {
      id: 'inmem-uuid-1',
      coinId: 'UCT_HEX',
      symbol: 'UCT',
      amount: '100',
      status: 'submitted',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData,
    };
    internals(module).tokens.set(token.id, token);

    internals(module).addProofPollingJob({
      tokenId: token.id,
      requestIdHex: '00deadbeef',
      commitmentJson: '{"requestId":"01020304","transactionData":{},"authenticator":{}}',
      sourceTokenJson: sdkData,
      startedAt: Date.now(),
      attemptCount: 0,
      lastAttemptAt: 0,
    });

    // saveProofPollingJobs is fire-and-forget from addProofPollingJob;
    // flush the queue.
    await internals(module).saveProofPollingJobs();

    const stored = setup.storageState.get(STORAGE_KEYS_ADDRESS.PROOF_POLLING_JOBS);
    expect(stored).toBeTruthy();
    const persisted = JSON.parse(stored as string);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].genesisTokenId).toBe(GENESIS_TOKEN_ID);
    expect(persisted[0].stateHash).toBe(STATE_HASH);
    expect(persisted[0].requestIdHex).toBe('00deadbeef');
    expect(persisted[0].sourceTokenJson).toBe(sdkData);
  });

  it('does NOT persist jobs that lack sourceTokenJson (legacy callsites)', async () => {
    const sdkData = makeV6DirectReceiveSdkData();
    const token: Token = {
      id: 'inmem-uuid-2',
      coinId: 'UCT_HEX',
      symbol: 'UCT',
      amount: '100',
      status: 'submitted',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData,
    };
    internals(module).tokens.set(token.id, token);

    internals(module).addProofPollingJob({
      tokenId: token.id,
      requestIdHex: '00deadbeef',
      commitmentJson: '{}',
      // ← intentionally no sourceTokenJson
      startedAt: Date.now(),
      attemptCount: 0,
      lastAttemptAt: 0,
    });

    await internals(module).saveProofPollingJobs();

    const stored = setup.storageState.get(STORAGE_KEYS_ADDRESS.PROOF_POLLING_JOBS);
    // saveProofPollingJobs clears the KV entry when no eligible jobs exist.
    expect(stored ?? '').toBe('');
  });

  it('restoreProofPollingJobs rebuilds jobs keyed by current in-memory tokenId', async () => {
    // Simulate a fresh process: persisted KV exists; in-memory tokens are
    // loaded with the GENESIS tokenId as their Map key (per txfToToken).
    const sdkData = makeV6DirectReceiveSdkData();
    setup.storageState.set(
      STORAGE_KEYS_ADDRESS.PROOF_POLLING_JOBS,
      JSON.stringify([
        {
          genesisTokenId: GENESIS_TOKEN_ID,
          stateHash: STATE_HASH,
          requestIdHex: '00restored',
          commitmentJson: '{}',
          sourceTokenJson: sdkData,
          startedAt: Date.now() - 5000,
          attemptCount: 17, // ignored on restore
          lastAttemptAt: Date.now() - 2000,
        },
      ]),
    );

    // Populate in-memory token map as loadFromStorageData would.
    const tokenAfterLoad: Token = {
      id: GENESIS_TOKEN_ID, // ← post-load id is genesis tokenId
      coinId: 'UCT_HEX',
      symbol: 'UCT',
      amount: '100',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData,
    };
    internals(module).tokens.set(tokenAfterLoad.id, tokenAfterLoad);

    await internals(module).restoreProofPollingJobs();

    const job = internals(module).proofPollingJobs.get(GENESIS_TOKEN_ID);
    expect(job).toBeDefined();
    expect(job?.requestIdHex).toBe('00restored');
    expect(job?.sourceTokenJson).toBe(sdkData);
    // Attempt count is reset on restore (prior process's attempts don't count).
    expect(job?.attemptCount).toBe(0);
    expect(job?.onProofReceived).toBeTypeOf('function');
  });

  it('restoreProofPollingJobs skips jobs with no matching in-memory token', async () => {
    setup.storageState.set(
      STORAGE_KEYS_ADDRESS.PROOF_POLLING_JOBS,
      JSON.stringify([
        {
          genesisTokenId: 'nonexistent-token-id',
          stateHash: 'nonexistent-state',
          requestIdHex: '00orphan',
          commitmentJson: '{}',
          sourceTokenJson: makeV6DirectReceiveSdkData(),
          startedAt: Date.now(),
          attemptCount: 0,
          lastAttemptAt: 0,
        },
      ]),
    );

    await internals(module).restoreProofPollingJobs();

    expect(internals(module).proofPollingJobs.size).toBe(0);
  });

  it('gracefully handles malformed persisted-job JSON', async () => {
    setup.storageState.set(STORAGE_KEYS_ADDRESS.PROOF_POLLING_JOBS, '{not-an-array}');
    await expect(internals(module).restoreProofPollingJobs()).resolves.toBeUndefined();
    expect(internals(module).proofPollingJobs.size).toBe(0);
  });
});

// =============================================================================
// L2 — resolveUnconfirmed widened status filter
// =============================================================================

describe('#144 L2 — resolveUnconfirmed accepts status=pending', () => {
  let module: ReturnType<typeof createPaymentsModule>;
  let setup: ReturnType<typeof createDeps>;

  beforeEach(() => {
    module = createPaymentsModule();
    setup = createDeps();
    module.initialize(setup.deps);
  });

  afterEach(() => {
    // Tear down setInterval timers (proofPolling, resolveUnconfirmed)
    // that initialize/addProofPollingJob may have started. Without this,
    // intervals leak across files and cause CI flakes (steelman FIX A).
    try { module.destroy(); } catch { /* ignore */ }
  });

  it('routes a status=pending V6-direct receive through resolveLegacyReceivedToken', async () => {
    const sdkData = makeV6DirectReceiveSdkData();
    const token: Token = {
      id: GENESIS_TOKEN_ID,
      coinId: 'UCT_HEX',
      symbol: 'UCT',
      amount: '100',
      status: 'pending', // ← key: was 'submitted' pre-save→load
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData,
    };
    internals(module).tokens.set(token.id, token);

    // No persisted polling job → resolveLegacyReceivedToken returns
    // 'stillPending' without contacting the oracle.
    const result = await internals(module).resolveUnconfirmed();
    expect(result.stillPending).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.resolved).toBe(0);
    expect(result.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tokenId: GENESIS_TOKEN_ID, stage: 'v6_direct', status: 'pending' }),
      ]),
    );
  });

  it('skips status=pending tokens whose last-tx recipient is NOT us', async () => {
    const sdkData = makeV6DirectReceiveSdkData({ lastTxRecipient: 'DIRECT://someone-else' });
    internals(module).tokens.set('foreign-token', {
      id: 'foreign-token',
      coinId: 'UCT_HEX',
      symbol: 'UCT',
      amount: '100',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData,
    });

    const result = await internals(module).resolveUnconfirmed();
    // Foreign-recipient tokens are not eligible for V6-direct retry; count
    // as still-pending but without a v6_direct detail entry.
    expect(result.stillPending).toBe(1);
    expect(result.details.find((d) => (d as { stage: string }).stage === 'v6_direct')).toBeUndefined();
  });
});

// =============================================================================
// L3 — Load-time invariant + stranded-token migration
// =============================================================================

describe('#144 L3 — balance-model invariant + stranded recovery', () => {
  let module: ReturnType<typeof createPaymentsModule>;
  let setup: ReturnType<typeof createDeps>;

  beforeEach(() => {
    module = createPaymentsModule();
    setup = createDeps();
    module.initialize(setup.deps);
  });

  afterEach(() => {
    // Tear down setInterval timers (proofPolling, resolveUnconfirmed)
    // that initialize/addProofPollingJob may have started. Without this,
    // intervals leak across files and cause CI flakes (steelman FIX A).
    try { module.destroy(); } catch { /* ignore */ }
  });

  it('hasFinalizationPlan returns true for a V6-direct receive even without a polling job', () => {
    const token: Token = {
      id: 'plan-test',
      coinId: 'UCT_HEX',
      symbol: 'UCT',
      amount: '100',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData: makeV6DirectReceiveSdkData(),
    };
    expect(internals(module).isReceivedLegacyPending(token)).toBe(true);
    expect(internals(module).hasFinalizationPlan(token)).toBe(true);
  });

  it('latestStatePredicateMatchesWallet returns false when state.predicate lacks our pubkey', () => {
    const token: Token = {
      id: 'pred-test',
      coinId: 'UCT_HEX',
      symbol: 'UCT',
      amount: '100',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      // state.predicate encodes sender's pubkey, not ours.
      sdkData: makeV6DirectReceiveSdkData({ predicateContainsOurPubkey: false }),
    };
    expect(internals(module).latestStatePredicateMatchesWallet(token)).toBe(false);
  });

  it('latestStatePredicateMatchesWallet returns true when state.predicate contains our pubkey', () => {
    const token: Token = {
      id: 'ownership-test',
      coinId: 'UCT_HEX',
      symbol: 'UCT',
      amount: '100',
      status: 'confirmed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData: makeV6DirectReceiveSdkData({ predicateContainsOurPubkey: true }),
    };
    expect(internals(module).latestStatePredicateMatchesWallet(token)).toBe(true);
  });

  it('loadFromStorageData preserves a stranded V6-direct receive (hasFinalizationPlan=true)', () => {
    // Build minimal TxfStorageData containing the stranded token.
    const sdkData = makeV6DirectReceiveSdkData();
    const data: TxfStorageDataBase = {
      _meta: {
        version: 1,
        address: OUR_PUBKEY,
        formatVersion: '1.0.0',
        updatedAt: Date.now(),
      },
      // Token key is `token-<tokenId>` per `keyFromTokenId`.
      [`_${GENESIS_TOKEN_ID}`]: JSON.parse(sdkData),
    } as TxfStorageDataBase;

    internals(module).loadFromStorageData(data);

    // The stranded receive stays in active because isReceivedLegacyPending
    // makes hasFinalizationPlan return true (bob's scenario).
    expect(internals(module).tokens.has(GENESIS_TOKEN_ID)).toBe(true);
    expect(internals(module).archivedTokens.has(GENESIS_TOKEN_ID)).toBe(false);
  });

  it('loadFromStorageData archive-moves tokens that fail BOTH ownership AND plan checks', () => {
    // Foreign-recipient token with no plan — should be archived.
    const sdkData = makeV6DirectReceiveSdkData({
      lastTxRecipient: 'DIRECT://different-recipient',
      predicateContainsOurPubkey: false,
    });
    const data: TxfStorageDataBase = {
      _meta: {
        version: 1,
        address: OUR_PUBKEY,
        formatVersion: '1.0.0',
        updatedAt: Date.now(),
      },
      [`_${GENESIS_TOKEN_ID}`]: JSON.parse(sdkData),
    } as TxfStorageDataBase;

    internals(module).loadFromStorageData(data);

    expect(internals(module).tokens.has(GENESIS_TOKEN_ID)).toBe(false);
    expect(internals(module).archivedTokens.has(GENESIS_TOKEN_ID)).toBe(true);
  });

  it('recoverStrandedReceivedTokens registers a polling job for a stranded V6-direct receive', async () => {
    const sdkData = makeV6DirectReceiveSdkData();
    const token: Token = {
      id: GENESIS_TOKEN_ID,
      coinId: 'UCT_HEX',
      symbol: 'UCT',
      amount: '100',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData,
    };
    internals(module).tokens.set(token.id, token);

    expect(internals(module).proofPollingJobs.size).toBe(0);

    const recovered = await internals(module).recoverStrandedReceivedTokens();
    expect(recovered).toBe(1);
    const job = internals(module).proofPollingJobs.get(GENESIS_TOKEN_ID);
    expect(job).toBeDefined();
    // Migration jobs have empty commitmentJson — proof fetched via
    // getProof(requestIdHex) path in processProofPollingQueue.
    expect(job?.commitmentJson).toBe('');
    // requestIdHex comes from the mocked RequestId.create.
    expect(job?.requestIdHex).toBe('00deadbeef00recovery00requestid');
    // sourceTokenJson is the source-at-state-N-1 (last tx stripped).
    const sourceParsed = JSON.parse(job?.sourceTokenJson ?? '{}');
    expect(sourceParsed.transactions).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Issue #390 — source-state reconstruction invariant
  //
  // The pre-#390 reconstruction in recoverStrandedReceivedTokens did:
  //     { ...parsed, transactions: txs.slice(0, -1) }
  // which left the top-level `state` field pointing at the RECIPIENT's
  // predicate (written by `saveCommitmentOnlyToken` for instant receives
  // so the on-disk shape advertises us as the owner once finalize
  // completes). Token.update → transaction.verify(trustBase, this) →
  // this.verifyRecipient() reads state.predicate.getReference().toAddress()
  // and compares it to genesis.data.recipient — those don't match for a
  // freshly-minted recipient token (genesis recipient = sender's
  // directAddress; state.predicate.publicKey = recipient's pubkey ⇒
  // recipient's directAddress). The SDK throws
  // `VerificationError('Recipient address mismatch')` and V6-RECOVER
  // stamps the durable permanent-invalid verdict. The fix replaces
  // `state` with the transfer's `sourceState` (= sender's mint state)
  // so verifyRecipient on the source-at-state-N-1 sees consistent
  // (state.predicate ⇒ genesis.recipient).
  // ---------------------------------------------------------------------------
  it('recoverStrandedReceivedTokens rewrites sourceTokenJson.state to the transfer sourceState (#390)', async () => {
    const recipientStatePredicateMarker = '<<RECIPIENT-STATE-MARKER>>';
    const senderSourceStatePredicateMarker = '<<SENDER-SOURCE-STATE-MARKER>>';

    // Build sdkData where:
    //   - top-level state.predicate carries the RECIPIENT marker (the
    //     ingestion-path write that #390 regresses through).
    //   - transactions[-1].data.sourceState.predicate carries the SENDER
    //     marker (the transfer's source state — what verifyRecipient
    //     on the source-at-state-N-1 must see).
    // The mocked TransferTransactionData.fromJSON ignores `lastTxJson.data`
    // contents (returns a stub), so the JSON shape only needs to expose
    // `data.sourceState.predicate` for the reconstruction code to read.
    const sdkData = JSON.stringify({
      version: '2.0',
      genesis: {
        data: { tokenId: GENESIS_TOKEN_ID, tokenType: 'coinType', coinData: [['UCT_HEX', '100']] },
        inclusionProof: { authenticator: { stateHash: 'genesisHash' } },
      },
      state: {
        data: '',
        predicate: recipientStatePredicateMarker,
      },
      transactions: [
        {
          inclusionProof: null,
          data: {
            recipient: { address: OUR_DIRECT, scheme: 'DIRECT' },
            salt: '0x33',
            sourceState: {
              data: null,
              predicate: senderSourceStatePredicateMarker,
            },
          },
        },
      ],
      _integrity: { genesisDataJSONHash: '0000' + '0'.repeat(60), currentStateHash: STATE_HASH },
    });

    const token: Token = {
      id: GENESIS_TOKEN_ID,
      coinId: 'UCT_HEX',
      symbol: 'UCT',
      amount: '100',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData,
    };
    internals(module).tokens.set(token.id, token);

    const recovered = await internals(module).recoverStrandedReceivedTokens();
    expect(recovered).toBe(1);

    const job = internals(module).proofPollingJobs.get(GENESIS_TOKEN_ID);
    expect(job).toBeDefined();
    const sourceParsed = JSON.parse(job?.sourceTokenJson ?? '{}');
    // Source token at state N-1 — last tx stripped.
    expect(sourceParsed.transactions).toHaveLength(0);
    // CRITICAL #390 invariant: the source token's state MUST come from
    // the transfer's sourceState (sender's mint state), NOT the
    // top-level state on the saved sdkData (recipient's predicate).
    expect(sourceParsed.state?.predicate).toBe(senderSourceStatePredicateMarker);
    expect(sourceParsed.state?.predicate).not.toBe(recipientStatePredicateMarker);
  });

  it('recoverStrandedReceivedTokens skips tokens that already have a polling job', async () => {
    const sdkData = makeV6DirectReceiveSdkData();
    const token: Token = {
      id: GENESIS_TOKEN_ID,
      coinId: 'UCT_HEX',
      symbol: 'UCT',
      amount: '100',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData,
    };
    internals(module).tokens.set(token.id, token);

    internals(module).proofPollingJobs.set(GENESIS_TOKEN_ID, {
      tokenId: GENESIS_TOKEN_ID,
      requestIdHex: 'pre-existing',
      commitmentJson: '{}',
      startedAt: Date.now(),
      attemptCount: 0,
      lastAttemptAt: 0,
    });

    const recovered = await internals(module).recoverStrandedReceivedTokens();
    expect(recovered).toBe(0);
    expect(internals(module).proofPollingJobs.get(GENESIS_TOKEN_ID)?.requestIdHex).toBe('pre-existing');
  });

  it('processProofPollingQueue does NOT flip RECEIVE jobs to spent (steelman FIX B)', async () => {
    // Regression for the steelman finding: pre-FIX-B the queue
    // unconditionally set token.status='spent' on proof receipt,
    // including for receive jobs. If the onProofReceived callback
    // then threw, the token was stuck at 'spent' forever.
    const sdkData = makeV6DirectReceiveSdkData();
    const token: Token = {
      id: GENESIS_TOKEN_ID,
      coinId: 'UCT_HEX',
      symbol: 'UCT',
      amount: '100',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData,
    };
    internals(module).tokens.set(token.id, token);

    // Mock oracle to return a (fake) proof on the next poll tick.
    const fakeProof = { toJSON: () => 'fake-proof-json' };
    (setup.deps.oracle as { waitForProofSdk: ReturnType<typeof vi.fn> }).waitForProofSdk =
      vi.fn().mockResolvedValue(fakeProof);

    // The onProofReceived callback will THROW — simulating a finalize
    // failure. After FIX B, the token MUST remain at 'pending' so the
    // queue retries on the next tick.
    let callbackInvoked = false;
    internals(module).proofPollingJobs.set(GENESIS_TOKEN_ID, {
      tokenId: GENESIS_TOKEN_ID,
      requestIdHex: '00deadbeef',
      commitmentJson: '{"requestId":"x","transactionData":{},"authenticator":{}}',
      sourceTokenJson: sdkData, // ← marks this as a RECEIVE job
      startedAt: Date.now(),
      attemptCount: 0,
      lastAttemptAt: 0,
      onProofReceived: async () => {
        callbackInvoked = true;
        throw new Error('Simulated finalize failure');
      },
    });

    // Trigger one polling tick directly.
    await (module as unknown as { processProofPollingQueue: () => Promise<void> }).processProofPollingQueue();

    expect(callbackInvoked).toBe(true);
    // Pre-FIX-B would be 'spent'; post-FIX-B remains 'pending' for retry.
    expect(internals(module).tokens.get(GENESIS_TOKEN_ID)?.status).toBe('pending');
    // Job stays in queue for retry (callbackOk=false → not added to completedJobs).
    expect(internals(module).proofPollingJobs.has(GENESIS_TOKEN_ID)).toBe(true);
  });

  it('processProofPollingQueue marks pending tokens invalid on timeout (steelman FIX C)', async () => {
    // Regression for the steelman finding: pre-FIX-C the timeout
    // branch only marked status='submitted' tokens invalid. Recovery
    // jobs target status='pending' tokens; pre-FIX-C they stayed
    // 'pending' forever, creating a zombie loop on every restart.
    const sdkData = makeV6DirectReceiveSdkData();
    const token: Token = {
      id: GENESIS_TOKEN_ID,
      coinId: 'UCT_HEX',
      symbol: 'UCT',
      amount: '100',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData,
    };
    internals(module).tokens.set(token.id, token);

    // Register a job with attemptCount already at the max — the next
    // tick should hit the timeout branch.
    internals(module).proofPollingJobs.set(GENESIS_TOKEN_ID, {
      tokenId: GENESIS_TOKEN_ID,
      requestIdHex: '00deadbeef',
      commitmentJson: '',
      sourceTokenJson: sdkData,
      startedAt: Date.now() - 60_000,
      attemptCount: 29, // ← bumps to 30 on the tick → hits MAX_ATTEMPTS branch
      lastAttemptAt: Date.now() - 2000,
    });

    await (module as unknown as { processProofPollingQueue: () => Promise<void> }).processProofPollingQueue();

    // Post-FIX-C: pending → invalid on timeout.
    expect(internals(module).tokens.get(GENESIS_TOKEN_ID)?.status).toBe('invalid');
    // Operator alert emitted for visibility.
    const alerts = setup.emittedEvents.filter((e) => e.type === 'transfer:operator-alert');
    expect(alerts.length).toBeGreaterThan(0);
  });

  it('restoreProofPollingJobs honors cumulative-attempts cap (steelman FIX G)', async () => {
    // Regression: if a token has burned through its cumulative budget
    // across prior process lifetimes, restore must mark it invalid
    // instead of granting another fresh 60s polling budget.
    const sdkData = makeV6DirectReceiveSdkData();
    setup.storageState.set(
      STORAGE_KEYS_ADDRESS.PROOF_POLLING_JOBS,
      JSON.stringify([
        {
          genesisTokenId: GENESIS_TOKEN_ID,
          stateHash: STATE_HASH,
          requestIdHex: '00restored',
          commitmentJson: '{}',
          sourceTokenJson: sdkData,
          startedAt: Date.now() - 600_000,
          attemptCount: 30,
          lastAttemptAt: Date.now() - 2000,
          cumulativeAttempts: 200, // > MAX_CUMULATIVE (150)
        },
      ]),
    );
    const tokenAfterLoad: Token = {
      id: GENESIS_TOKEN_ID,
      coinId: 'UCT_HEX',
      symbol: 'UCT',
      amount: '100',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData,
    };
    internals(module).tokens.set(tokenAfterLoad.id, tokenAfterLoad);

    await internals(module).restoreProofPollingJobs();

    // Job NOT restored (skipped due to cap).
    expect(internals(module).proofPollingJobs.has(GENESIS_TOKEN_ID)).toBe(false);
    // Token marked invalid.
    expect(internals(module).tokens.get(GENESIS_TOKEN_ID)?.status).toBe('invalid');
    // Operator alert emitted.
    const alerts = setup.emittedEvents.filter((e) => e.type === 'transfer:operator-alert');
    expect(alerts.length).toBeGreaterThan(0);
  });

  it('recoverStrandedReceivedTokens skips tokens that are not V6-direct receives', async () => {
    // Confirmed token with all proofs present.
    const sdkData = JSON.stringify({
      version: '2.0',
      genesis: { data: { tokenId: 'X', coinData: [['UCT_HEX', '100']] }, inclusionProof: {} },
      state: { predicate: `0000${OUR_PUBKEY.toLowerCase()}0000` },
      transactions: [{ inclusionProof: { authenticator: { stateHash: 'h1' } }, data: {} }],
    });
    internals(module).tokens.set('confirmed-token', {
      id: 'confirmed-token',
      coinId: 'UCT_HEX',
      symbol: 'UCT',
      amount: '100',
      status: 'confirmed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData,
    });

    const recovered = await internals(module).recoverStrandedReceivedTokens();
    expect(recovered).toBe(0);
  });

  // Issue #231 — finalizeStrandedReceivedToken hit InvalidJsonStructureError
  // from TransferTransaction.fromJSON every sync cycle without ever
  // converging or marking the token invalid. Pre-fix the error was caught
  // and swallowed (returned normally), so the resolveUnconfirmed path
  // deleted the job, but the token stayed 'pending' — letting the next
  // load's `recoverStrandedReceivedTokens` re-register the job and produce
  // the same error indefinitely.
  it('finalizeStrandedReceivedToken classifies InvalidJsonStructureError as permanent and stops retrying (issue #231)', async () => {
    // Set up a stranded V6-direct receive in 'pending' status.
    const sdkData = makeV6DirectReceiveSdkData();
    const token: Token = {
      id: GENESIS_TOKEN_ID,
      coinId: 'UCT_HEX',
      symbol: 'UCT',
      amount: '100',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData,
    };
    internals(module).tokens.set(token.id, token);

    // Oracle returns a (malformed-looking) proof — the value itself
    // doesn't matter because the SDK mock throws.
    (setup.deps.oracle as { getProof: ReturnType<typeof vi.fn> }).getProof =
      vi.fn().mockResolvedValue({ toJSON: () => ({ malformed: 'shape' }) });

    // Make TransferTransaction.fromJSON throw the exact SDK error class
    // the bug surfaces. The mock is reset after the test.
    const sdkErrMod = await import(
      '@unicitylabs/state-transition-sdk/lib/InvalidJsonStructureError'
    );
    const InvalidJsonStructureError = sdkErrMod.InvalidJsonStructureError;
    const ttMod = await import(
      '@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction'
    );
    const prior = ttMod.TransferTransaction.fromJSON;
    (ttMod.TransferTransaction.fromJSON as unknown as ReturnType<typeof vi.fn>) = vi
      .fn()
      .mockRejectedValue(new InvalidJsonStructureError());

    try {
      // Register a recovery job and invoke the private finalize directly.
      const lastTxJson = { previousStateHash: STATE_HASH, predicate: 'pred2', data: {} };
      const sourceTokenJson = JSON.stringify({ genesis: { data: { tokenId: GENESIS_TOKEN_ID } } });
      internals(module).proofPollingJobs.set(GENESIS_TOKEN_ID, {
        tokenId: GENESIS_TOKEN_ID,
        requestIdHex: '00deadbeef',
        commitmentJson: '',
        sourceTokenJson,
        startedAt: Date.now(),
        attemptCount: 0,
        lastAttemptAt: 0,
      });

      await (module as unknown as {
        finalizeStrandedReceivedToken: (
          tokenId: string,
          sourceTokenJson: string,
          lastTxJson: Record<string, unknown>,
        ) => Promise<void>;
      }).finalizeStrandedReceivedToken(GENESIS_TOKEN_ID, sourceTokenJson, lastTxJson);

      // 1. Token marked invalid — recoverStrandedReceivedTokens (which
      //    only re-picks tokens at status='pending') will now skip it.
      expect(internals(module).tokens.get(GENESIS_TOKEN_ID)?.status).toBe('invalid');

      // 2. Job removed — no further polling-tick retries.
      expect(internals(module).proofPollingJobs.has(GENESIS_TOKEN_ID)).toBe(false);

      // 3. Operator alert fired with the structural disposition reason.
      const alerts = setup.emittedEvents.filter(
        (e) => e.type === 'transfer:operator-alert',
      );
      expect(alerts.length).toBeGreaterThanOrEqual(1);
      const alert = alerts[alerts.length - 1].payload as {
        code: string;
        tokenId: string;
        message: string;
      };
      expect(alert.code).toBe('structural');
      expect(alert.tokenId).toBe(GENESIS_TOKEN_ID);
      expect(alert.message).toContain('cannot be finalized');
    } finally {
      (ttMod.TransferTransaction.fromJSON as unknown as ReturnType<typeof vi.fn>) = prior as never;
    }
  });

  it('finalizeStrandedReceivedToken keeps non-structural errors transient (existing behaviour)', async () => {
    // A garden-variety throw (network blip, oracle reject) should NOT
    // trip the permanent-fail path: the token must remain at 'pending'
    // and the job stays in the queue for the next poll tick.
    const sdkData = makeV6DirectReceiveSdkData();
    const token: Token = {
      id: GENESIS_TOKEN_ID,
      coinId: 'UCT_HEX',
      symbol: 'UCT',
      amount: '100',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData,
    };
    internals(module).tokens.set(token.id, token);

    (setup.deps.oracle as { getProof: ReturnType<typeof vi.fn> }).getProof =
      vi.fn().mockResolvedValue({ toJSON: () => ({ ok: 'shape' }) });

    const ttMod = await import(
      '@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction'
    );
    const prior = ttMod.TransferTransaction.fromJSON;
    (ttMod.TransferTransaction.fromJSON as unknown as ReturnType<typeof vi.fn>) = vi
      .fn()
      .mockRejectedValue(new Error('Transient network blip'));

    try {
      const lastTxJson = { previousStateHash: STATE_HASH, predicate: 'pred2', data: {} };
      const sourceTokenJson = JSON.stringify({ genesis: { data: { tokenId: GENESIS_TOKEN_ID } } });
      internals(module).proofPollingJobs.set(GENESIS_TOKEN_ID, {
        tokenId: GENESIS_TOKEN_ID,
        requestIdHex: '00deadbeef',
        commitmentJson: '',
        sourceTokenJson,
        startedAt: Date.now(),
        attemptCount: 0,
        lastAttemptAt: 0,
      });

      await (module as unknown as {
        finalizeStrandedReceivedToken: (
          tokenId: string,
          sourceTokenJson: string,
          lastTxJson: Record<string, unknown>,
        ) => Promise<void>;
      }).finalizeStrandedReceivedToken(GENESIS_TOKEN_ID, sourceTokenJson, lastTxJson);

      // Status stays pending — caller's polling tick / cumulative-cap
      // mechanism eventually marks it invalid.
      expect(internals(module).tokens.get(GENESIS_TOKEN_ID)?.status).toBe('pending');
      // Job stays for retry — this code path does NOT delete the job.
      expect(internals(module).proofPollingJobs.has(GENESIS_TOKEN_ID)).toBe(true);
      // No operator alert from the transient path.
      const alerts = setup.emittedEvents.filter(
        (e) => e.type === 'transfer:operator-alert',
      );
      expect(alerts.length).toBe(0);
    } finally {
      (ttMod.TransferTransaction.fromJSON as unknown as ReturnType<typeof vi.fn>) = prior as never;
    }
  });

  // Issue #269 — `finalizeStrandedReceivedToken` previously treated SDK
  // `VerificationError` with `verificationResult.message === 'Recipient
  // address mismatch'` as transient: the catch logged at error level and
  // returned, leaving the token in 'pending'. Each `sync()` then ran
  // `drainPendingFinalizations` for the full timeoutMs window because
  // `hasUnconfirmedOrInflight()` kept seeing the unresolved token. With
  // the at-least-once Nostr replay (PR #240) every replay re-triggered
  // the same drain, stalling §D.1 of `manual-test-full-recovery.sh`.
  //
  // By the time this catch fires, `finalizeTransferToken` has already
  // run `tryRecoverSigningServiceForRecipient` and exhausted every
  // tracked HD address. The mismatch is therefore permanent w.r.t. the
  // wallet's current key inventory — retrying with the same inputs
  // cannot succeed.
  it('finalizeStrandedReceivedToken classifies VerificationError(Recipient address mismatch) as permanent (issue #269)', async () => {
    const sdkData = makeV6DirectReceiveSdkData();
    const token: Token = {
      id: GENESIS_TOKEN_ID,
      coinId: 'UCT_HEX',
      symbol: 'UCT',
      amount: '100',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData,
    };
    internals(module).tokens.set(token.id, token);

    // Oracle returns a structurally-valid proof so the unwrap +
    // `TransferTransaction.fromJSON` path succeeds. The failure must come
    // from `finalizeTransferToken`'s SDK call, not from the proof shape.
    (setup.deps.oracle as { getProof: ReturnType<typeof vi.fn> }).getProof =
      vi.fn().mockResolvedValue({
        merkleTreePath: { steps: [] },
        unicityCertificate: { rootHash: '00' },
        toJSON() { return { merkleTreePath: { steps: [] }, unicityCertificate: { rootHash: '00' } }; },
      });

    // Construct the SDK error shape the bug surfaces. Outer message
    // mirrors the issue's stack trace (`token.update` wraps the
    // `transaction.verify` result).
    const sdkVerifMod = await import(
      '@unicitylabs/state-transition-sdk/lib/verification/VerificationError'
    );
    const verificationError = new sdkVerifMod.VerificationError(
      'Transaction verification failed',
      // Cast: we only need shape fidelity (status + message), not the
      // full SDK class instance for `instanceof` — the classifier also
      // accepts the duck-typed shape.
      { status: 1, message: 'Recipient address mismatch', results: [] } as never,
    );

    // Bypass `finalizeTransferToken`'s internal HD-index recovery and
    // jump straight to the throw — that path is covered by other tests;
    // here we are exercising the catch classifier in
    // `finalizeStrandedReceivedToken`.
    const internalsAny = module as unknown as {
      finalizeTransferToken: (...args: unknown[]) => Promise<unknown>;
    };
    const priorFinalize = internalsAny.finalizeTransferToken;
    internalsAny.finalizeTransferToken = vi
      .fn()
      .mockRejectedValue(verificationError);

    try {
      const lastTxJson = { previousStateHash: STATE_HASH, predicate: 'pred2', data: {} };
      const sourceTokenJson = JSON.stringify({ genesis: { data: { tokenId: GENESIS_TOKEN_ID } } });
      internals(module).proofPollingJobs.set(GENESIS_TOKEN_ID, {
        tokenId: GENESIS_TOKEN_ID,
        requestIdHex: '00deadbeef',
        commitmentJson: '',
        sourceTokenJson,
        startedAt: Date.now(),
        attemptCount: 0,
        lastAttemptAt: 0,
      });

      await (module as unknown as {
        finalizeStrandedReceivedToken: (
          tokenId: string,
          sourceTokenJson: string,
          lastTxJson: Record<string, unknown>,
        ) => Promise<void>;
      }).finalizeStrandedReceivedToken(GENESIS_TOKEN_ID, sourceTokenJson, lastTxJson);

      // 1. Token marked invalid so `hasUnconfirmedOrInflight()` no longer
      //    sees it and the drain loop can return early.
      expect(internals(module).tokens.get(GENESIS_TOKEN_ID)?.status).toBe('invalid');

      // 2. Polling job removed.
      expect(internals(module).proofPollingJobs.has(GENESIS_TOKEN_ID)).toBe(false);

      // 3. Operator alert fired with `not-our-state` (NOT 'structural'
      //    — bytes were well-formed; the address just doesn't bind).
      const alerts = setup.emittedEvents.filter(
        (e) => e.type === 'transfer:operator-alert',
      );
      expect(alerts.length).toBeGreaterThanOrEqual(1);
      const alert = alerts[alerts.length - 1].payload as {
        code: string;
        tokenId: string;
        message: string;
      };
      expect(alert.code).toBe('not-our-state');
      expect(alert.tokenId).toBe(GENESIS_TOKEN_ID);
      expect(alert.message).toContain('cannot be finalized');
      expect(alert.message.toLowerCase()).toContain('mismatch');
    } finally {
      internalsAny.finalizeTransferToken = priorFinalize;
    }
  });

  // Negative: a VerificationError whose inner message isn't a recipient/
  // address mismatch (e.g., predicate-verify failure due to malformed
  // signature bytes) must NOT trip the permanent-fail path — those can
  // be transient (network blip yielding a bad proof, retried).
  it('finalizeStrandedReceivedToken keeps non-mismatch VerificationError transient (issue #269 negative case)', async () => {
    const sdkData = makeV6DirectReceiveSdkData();
    const token: Token = {
      id: GENESIS_TOKEN_ID,
      coinId: 'UCT_HEX',
      symbol: 'UCT',
      amount: '100',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData,
    };
    internals(module).tokens.set(token.id, token);

    (setup.deps.oracle as { getProof: ReturnType<typeof vi.fn> }).getProof =
      vi.fn().mockResolvedValue({
        toJSON() { return { merkleTreePath: { steps: [] }, unicityCertificate: { rootHash: '00' } }; },
      });

    const sdkVerifMod = await import(
      '@unicitylabs/state-transition-sdk/lib/verification/VerificationError'
    );
    const verificationError = new sdkVerifMod.VerificationError(
      'Predicate verification failed',
      { status: 1, message: 'Predicate verification failed', results: [] } as never,
    );

    const internalsAny = module as unknown as {
      finalizeTransferToken: (...args: unknown[]) => Promise<unknown>;
    };
    const priorFinalize = internalsAny.finalizeTransferToken;
    internalsAny.finalizeTransferToken = vi.fn().mockRejectedValue(verificationError);

    try {
      const lastTxJson = { previousStateHash: STATE_HASH, predicate: 'pred2', data: {} };
      const sourceTokenJson = JSON.stringify({ genesis: { data: { tokenId: GENESIS_TOKEN_ID } } });
      internals(module).proofPollingJobs.set(GENESIS_TOKEN_ID, {
        tokenId: GENESIS_TOKEN_ID,
        requestIdHex: '00deadbeef',
        commitmentJson: '',
        sourceTokenJson,
        startedAt: Date.now(),
        attemptCount: 0,
        lastAttemptAt: 0,
      });

      await (module as unknown as {
        finalizeStrandedReceivedToken: (
          tokenId: string,
          sourceTokenJson: string,
          lastTxJson: Record<string, unknown>,
        ) => Promise<void>;
      }).finalizeStrandedReceivedToken(GENESIS_TOKEN_ID, sourceTokenJson, lastTxJson);

      // Stays pending, job retained, no operator alert.
      expect(internals(module).tokens.get(GENESIS_TOKEN_ID)?.status).toBe('pending');
      expect(internals(module).proofPollingJobs.has(GENESIS_TOKEN_ID)).toBe(true);
      const alerts = setup.emittedEvents.filter(
        (e) => e.type === 'transfer:operator-alert',
      );
      expect(alerts.length).toBe(0);
    } finally {
      internalsAny.finalizeTransferToken = priorFinalize;
    }
  });

  // Issue #251 — V6-RECOVER previously passed `oracle.getProof`'s wrapper
  // shape ({requestId, roundNumber, proof, timestamp}) directly as the
  // inclusionProof patched into the synthetic lastTxJson. The wrapper has
  // no top-level `merkleTreePath` / `unicityCertificate`, so the SDK's
  // `InclusionProof.isJSON` rejected it with `InvalidJsonStructureError`
  // — surfacing as the cross-device finalize loop on peer2-alice in
  // manual-test-full-recovery.sh §C.4.
  //
  // The bug never fired for live receives (in-memory job has
  // `commitmentJson` → `finalizeReceivedToken` uses `waitForProofSdk`
  // which returns an SDK instance directly) or same-device restarts
  // (`restoreProofPollingJobs` rehydrates with `commitmentJson`). It is
  // gated to the cross-device-sync scenario where peer2 learns the
  // token via OrbitDB profile-sync without ever holding the commitment
  // — V6-RECOVER is the only path forward and the inner `getProof`
  // call is the only proof source.
  //
  // This regression asserts the fix unwraps `.proof` from the
  // OracleProvider's canonical return shape so the SDK accepts the
  // patched transaction.
  it('finalizeStrandedReceivedToken unwraps OracleProvider wrapper to canonical SDK proof shape (issue #251)', async () => {
    const sdkData = makeV6DirectReceiveSdkData();
    const token: Token = {
      id: GENESIS_TOKEN_ID,
      coinId: 'UCT_HEX',
      symbol: 'UCT',
      amount: '100',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData,
    };
    internals(module).tokens.set(token.id, token);

    // Canonical SDK shape buried under the wrapper's `.proof` field —
    // mirrors UnicityAggregatorProvider.getProof's real return.
    const innerSdkProof = {
      merkleTreePath: { steps: [], rootHash: '00' },
      authenticator: { publicKey: '02', signature: '00', stateHash: '00' },
      transactionHash: '00deadbeef',
      unicityCertificate: { certHash: '00', signers: [] },
    };
    (setup.deps.oracle as { getProof: ReturnType<typeof vi.fn> }).getProof =
      vi.fn().mockResolvedValue({
        requestId: '00deadbeef',
        roundNumber: 42,
        proof: innerSdkProof,
        timestamp: Date.now(),
      });

    // Capture what TransferTransaction.fromJSON sees so we can assert
    // the unwrap happened before the SDK boundary.
    const ttMod = await import(
      '@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction'
    );
    const captured: Array<unknown> = [];
    const prior = ttMod.TransferTransaction.fromJSON;
    (ttMod.TransferTransaction.fromJSON as unknown as ReturnType<typeof vi.fn>) = vi
      .fn()
      .mockImplementation(async (input: unknown) => {
        captured.push(input);
        // Returning {} is enough — finalizeStrandedReceivedToken only
        // needs the value to pass through to finalizeTransferToken,
        // which is mocked higher up.
        return {};
      });

    // Stub the rest of the finalize path so the test isolates the
    // proof-unwrap behavior. `finalizeTransferToken` is the next call
    // after fromJSON succeeds; mocking it to return a minimal SDK
    // token-shaped object lets the code reach the save() boundary.
    (module as unknown as {
      finalizeTransferToken: (...args: unknown[]) => Promise<unknown>;
    }).finalizeTransferToken = vi.fn().mockResolvedValue({
      toJSON: () => ({ genesis: { data: { tokenId: GENESIS_TOKEN_ID } } }),
    });
    // Source-token parse — SdkToken.fromJSON is module-mocked at the top
    // to return a minimal shape, so we don't need to override it.

    try {
      const lastTxJson = {
        previousStateHash: STATE_HASH,
        predicate: 'pred2',
        data: { sourceState: {}, recipient: 'DIRECT://x', salt: '00', recipientDataHash: null, message: null, nametags: [] },
      };
      const sourceTokenJson = JSON.stringify({ genesis: { data: { tokenId: GENESIS_TOKEN_ID } } });
      internals(module).proofPollingJobs.set(GENESIS_TOKEN_ID, {
        tokenId: GENESIS_TOKEN_ID,
        requestIdHex: '00deadbeef',
        commitmentJson: '',
        sourceTokenJson,
        startedAt: Date.now(),
        attemptCount: 0,
        lastAttemptAt: 0,
      });

      await (module as unknown as {
        finalizeStrandedReceivedToken: (
          tokenId: string,
          sourceTokenJson: string,
          lastTxJson: Record<string, unknown>,
        ) => Promise<void>;
      }).finalizeStrandedReceivedToken(GENESIS_TOKEN_ID, sourceTokenJson, lastTxJson);

      // The SDK call must have received the UNWRAPPED canonical shape
      // patched into the lastTxJson's inclusionProof slot — NOT the
      // OracleProvider wrapper.
      expect(captured.length).toBe(1);
      const patched = captured[0] as { inclusionProof?: Record<string, unknown> };
      expect(patched.inclusionProof).toBeDefined();
      expect(patched.inclusionProof).toEqual(innerSdkProof);
      // Pre-fix this would have been the wrapper:
      expect(patched.inclusionProof).not.toHaveProperty('roundNumber');
      expect(patched.inclusionProof).not.toHaveProperty('requestId');
      expect(patched.inclusionProof).toHaveProperty('merkleTreePath');
      expect(patched.inclusionProof).toHaveProperty('unicityCertificate');

      // No structural failure means no operator alert and the token
      // does NOT get marked invalid on the first try.
      const alerts = setup.emittedEvents.filter(
        (e) => e.type === 'transfer:operator-alert',
      );
      expect(alerts.length).toBe(0);
      expect(internals(module).tokens.get(GENESIS_TOKEN_ID)?.status).toBe('confirmed');
    } finally {
      (ttMod.TransferTransaction.fromJSON as unknown as ReturnType<typeof vi.fn>) = prior as never;
    }
  });

  // Steelman finding (PR #252 review): the OracleProvider interface
  // declares `proof: unknown`, so a wrapper whose inner proof is null
  // is structurally permitted even though `UnicityAggregatorProvider`
  // currently short-circuits the null case at the source. Pre-fix the
  // null-wrapper would fall through to `proofJson = proof` (the whole
  // wrapper, a truthy object) and crash `TransferTransaction.fromJSON`
  // exactly the way Issue #251's primary bug fired. The post-fix wrapper
  // branch detects the wrapper shape (roundNumber:number + 'proof' in
  // wrapper) and routes a null proof through the early-return path.
  it('finalizeStrandedReceivedToken treats wrapper with null proof as not-yet-available (PR #252 review)', async () => {
    const sdkData = makeV6DirectReceiveSdkData();
    const token: Token = {
      id: GENESIS_TOKEN_ID,
      coinId: 'UCT_HEX',
      symbol: 'UCT',
      amount: '100',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData,
    };
    internals(module).tokens.set(token.id, token);

    // Wrapper with proof:null — what a future provider implementation
    // might emit if it forgets to filter at the boundary.
    (setup.deps.oracle as { getProof: ReturnType<typeof vi.fn> }).getProof =
      vi.fn().mockResolvedValue({
        requestId: '00deadbeef',
        roundNumber: 42,
        proof: null,
        timestamp: Date.now(),
      });

    const ttMod = await import(
      '@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction'
    );
    const fromJsonMock = vi.fn();
    const prior = ttMod.TransferTransaction.fromJSON;
    (ttMod.TransferTransaction.fromJSON as unknown as ReturnType<typeof vi.fn>) = fromJsonMock;

    try {
      const lastTxJson = {
        previousStateHash: STATE_HASH,
        predicate: 'pred2',
        data: { sourceState: {}, recipient: 'DIRECT://x', salt: '00', recipientDataHash: null, message: null, nametags: [] },
      };
      const sourceTokenJson = JSON.stringify({ genesis: { data: { tokenId: GENESIS_TOKEN_ID } } });
      internals(module).proofPollingJobs.set(GENESIS_TOKEN_ID, {
        tokenId: GENESIS_TOKEN_ID,
        requestIdHex: '00deadbeef',
        commitmentJson: '',
        sourceTokenJson,
        startedAt: Date.now(),
        attemptCount: 0,
        lastAttemptAt: 0,
      });

      await (module as unknown as {
        finalizeStrandedReceivedToken: (
          tokenId: string,
          sourceTokenJson: string,
          lastTxJson: Record<string, unknown>,
        ) => Promise<void>;
      }).finalizeStrandedReceivedToken(GENESIS_TOKEN_ID, sourceTokenJson, lastTxJson);

      // The early-return must fire — fromJSON should NOT have been called.
      expect(fromJsonMock).not.toHaveBeenCalled();
      // Token stays pending — next polling tick may have a real proof.
      expect(internals(module).tokens.get(GENESIS_TOKEN_ID)?.status).toBe('pending');
      // No operator alert (this is a transient "wait for next tick").
      const alerts = setup.emittedEvents.filter(
        (e) => e.type === 'transfer:operator-alert',
      );
      expect(alerts.length).toBe(0);
    } finally {
      (ttMod.TransferTransaction.fromJSON as unknown as ReturnType<typeof vi.fn>) = prior as never;
    }
  });
});

// =============================================================================
// Option B — token-local commitment recovery via embedded authenticator
// =============================================================================
//
// Scenario: Bob sends Alice some UCT. Bob's CLI exits before its
// fire-and-forget background `submitTransferCommitment` completes (or the
// aggregator drops the submit). Alice has the bundle on disk. Alice then
// wipes her profile and re-imports from mnemonic.
//
// Pre-fix: proof-polling jobs (kept in a separate KV map, not in the
// IPFS-published TXF) are lost on profile wipe. `recoverStrandedReceivedTokens`
// can register a recovery job, but with `commitmentJson: ''` the polling
// queue can only call `getProof(requestId)` — which returns null because
// no one ever submitted the commitment. Tokens stuck pending forever.
//
// Fix (Option B): on receive, `saveCommitmentOnlyToken` embeds the sender's
// `authenticator` JSON under a `_wallet` field on the synthetic pending tx.
// `_wallet` rides along through TXF serialization (structuredClone preserves
// unknown fields) and IPFS publishing. On recovery, the embedded
// authenticator lets us reconstruct the full `TransferCommitment` and
// re-submit it. The authenticator is the SENDER's signature; the aggregator
// verifies the signature without caring about the submitter's identity.

describe('Option B — embedded authenticator enables receiver-side commitment re-submit', () => {
  let module: ReturnType<typeof createPaymentsModule>;
  let setup: ReturnType<typeof createDeps>;

  beforeEach(() => {
    module = createPaymentsModule();
    setup = createDeps();
    module.initialize(setup.deps);
  });

  afterEach(() => {
    try { module.destroy(); } catch { /* ignore */ }
  });

  /**
   * Build a V6-direct receive shape with an embedded `_wallet.authenticator`
   * on the last (pending) tx — mirrors what `saveCommitmentOnlyToken` writes
   * after the Option B fix.
   */
  function makeV6DirectReceiveWithEmbeddedAuth(
    authenticator: unknown = {
      publicKey: SENDER_PUBKEY,
      signature: 'd'.repeat(128),
      stateHash: STATE_HASH,
    },
  ): string {
    return JSON.stringify({
      version: '2.0',
      genesis: {
        data: { tokenId: GENESIS_TOKEN_ID, tokenType: 'coinType', coinData: [['UCT_HEX', '100']] },
        inclusionProof: { authenticator: { stateHash: 'genesisHash' } },
      },
      state: { data: '', predicate: `0000${SENDER_PUBKEY.toLowerCase()}0000` },
      transactions: [
        {
          previousStateHash: 'h0',
          newStateHash: STATE_HASH,
          predicate: 'pred1',
          inclusionProof: { authenticator: { stateHash: STATE_HASH } },
          data: { recipient: { address: 'PROXY://senderProxy', scheme: 'PROXY' } },
        },
        {
          previousStateHash: STATE_HASH,
          predicate: 'pred2',
          inclusionProof: null,
          data: { recipient: { address: OUR_DIRECT, scheme: 'DIRECT' }, salt: '0x33' },
          _wallet: { authenticator },
        },
      ],
      _integrity: { genesisDataJSONHash: '0000' + '0'.repeat(60), currentStateHash: STATE_HASH },
    });
  }

  it('recovery extracts embedded authenticator, populates commitmentJson, AND re-submits to aggregator', async () => {
    const sdkData = makeV6DirectReceiveWithEmbeddedAuth();
    const token: Token = {
      id: GENESIS_TOKEN_ID,
      coinId: 'UCT_HEX',
      symbol: 'UCT',
      amount: '100',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData,
    };
    internals(module).tokens.set(token.id, token);

    // Wire up a submitTransferCommitment spy on the mock oracle's
    // StateTransitionClient — this is what Option B's recovery hits.
    const submitSpy = vi.fn().mockResolvedValue({ status: 'SUCCESS' });
    (setup.deps.oracle.getStateTransitionClient as ReturnType<typeof vi.fn>).mockReturnValue({
      submitTransferCommitment: submitSpy,
    });

    const recovered = await internals(module).recoverStrandedReceivedTokens();
    expect(recovered).toBe(1);

    const job = internals(module).proofPollingJobs.get(GENESIS_TOKEN_ID);
    expect(job).toBeDefined();

    // commitmentJson MUST be populated (not the legacy empty-string path).
    expect(job?.commitmentJson).not.toBe('');
    const cmt = JSON.parse(job?.commitmentJson ?? '{}');
    expect(cmt.requestId).toBe('00deadbeef00recovery00requestid');
    expect(cmt.authenticator).toBeDefined();
    expect(cmt.transactionData).toBeDefined();

    // The async fire-and-forget submit may not have completed yet —
    // wait a microtask tick.
    await new Promise((r) => setTimeout(r, 10));

    // submitTransferCommitment must have been called on the sender's
    // behalf. This is the whole point of Option B.
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to empty commitmentJson when embedded authenticator is malformed', async () => {
    // Make TransferCommitment.fromJSON throw on the embedded-auth path
    // but succeed for everything else (the recovery flow validates the
    // reconstructed commitment via fromJSON before storing).
    const { TransferCommitment } = await import(
      '@unicitylabs/state-transition-sdk/lib/transaction/TransferCommitment'
    );
    const fromJsonSpy = TransferCommitment.fromJSON as ReturnType<typeof vi.fn>;
    fromJsonSpy.mockRejectedValueOnce(new Error('Invalid authenticator JSON'));

    const sdkData = makeV6DirectReceiveWithEmbeddedAuth({ totally: 'garbage' });
    const token: Token = {
      id: GENESIS_TOKEN_ID,
      coinId: 'UCT_HEX',
      symbol: 'UCT',
      amount: '100',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData,
    };
    internals(module).tokens.set(token.id, token);

    const submitSpy = vi.fn();
    (setup.deps.oracle.getStateTransitionClient as ReturnType<typeof vi.fn>).mockReturnValue({
      submitTransferCommitment: submitSpy,
    });

    const recovered = await internals(module).recoverStrandedReceivedTokens();
    expect(recovered).toBe(1);

    const job = internals(module).proofPollingJobs.get(GENESIS_TOKEN_ID);
    expect(job).toBeDefined();
    // Falls back to the legacy getProof-only path.
    expect(job?.commitmentJson).toBe('');

    await new Promise((r) => setTimeout(r, 10));
    // No re-submit when commitmentJson is empty.
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('saveCommitmentOnlyToken embeds _wallet.authenticator in synthetic pending tx', async () => {
    // Source token with 1 mint tx (proof set). saveCommitmentOnlyToken
    // should append a synthetic pending tx carrying the commitment's
    // transactionData AND `_wallet.authenticator`.
    const sourceTokenObj = {
      version: '2.0',
      genesis: {
        data: { tokenId: GENESIS_TOKEN_ID, tokenType: 'coinType', coinData: [['UCT_HEX', '100']] },
        inclusionProof: { authenticator: { stateHash: 'genesisHash' } },
      },
      state: { data: '', predicate: `0000${SENDER_PUBKEY.toLowerCase()}0000` },
      transactions: [
        {
          previousStateHash: 'h0',
          newStateHash: STATE_HASH,
          predicate: 'pred1',
          inclusionProof: { authenticator: { stateHash: STATE_HASH } },
          data: { recipient: { address: 'PROXY://intermediate', scheme: 'PROXY' } },
        },
      ],
      _integrity: { genesisDataJSONHash: '0000' + '0'.repeat(60), currentStateHash: STATE_HASH },
    };

    // Commitment input mimicking what V6 receive paths produce — JSON
    // with requestId, transactionData, authenticator.
    const senderSignature = 'e'.repeat(128);
    const commitmentInput = {
      requestId: '00deadbeef00recovery00requestid',
      transactionData: {
        recipient: { address: OUR_DIRECT, scheme: 'DIRECT' },
        salt: '0xff',
        sourceState: { predicate: `0000${SENDER_PUBKEY.toLowerCase()}0000` },
      },
      authenticator: {
        publicKey: SENDER_PUBKEY,
        signature: senderSignature,
        stateHash: STATE_HASH,
      },
    };

    const savedToken = await internals(module).saveCommitmentOnlyToken(
      sourceTokenObj,
      commitmentInput,
      SENDER_PUBKEY,
      true, // deferPersistence
      true, // skipGenesisDedup
    );

    expect(savedToken).not.toBeNull();
    expect(savedToken!.sdkData).toBeTruthy();

    const persisted = JSON.parse(savedToken!.sdkData!);
    // 2 transactions now: original mint + synthetic pending.
    expect(persisted.transactions).toHaveLength(2);
    const pendingTx = persisted.transactions[1];
    expect(pendingTx.inclusionProof).toBeNull();
    expect(pendingTx.data).toEqual(commitmentInput.transactionData);
    // The critical assertion: _wallet.authenticator survives onto disk.
    expect(pendingTx._wallet).toBeDefined();
    expect(pendingTx._wallet.authenticator).toEqual(commitmentInput.authenticator);
  });

  it('uses legacy empty-commitmentJson path when _wallet field is absent (backward compat)', async () => {
    // Plain V6-direct receive WITHOUT _wallet.authenticator — the shape
    // produced by old wallet versions that haven't been re-saved.
    const sdkData = makeV6DirectReceiveSdkData();
    const token: Token = {
      id: GENESIS_TOKEN_ID,
      coinId: 'UCT_HEX',
      symbol: 'UCT',
      amount: '100',
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData,
    };
    internals(module).tokens.set(token.id, token);

    const submitSpy = vi.fn();
    (setup.deps.oracle.getStateTransitionClient as ReturnType<typeof vi.fn>).mockReturnValue({
      submitTransferCommitment: submitSpy,
    });

    const recovered = await internals(module).recoverStrandedReceivedTokens();
    expect(recovered).toBe(1);

    const job = internals(module).proofPollingJobs.get(GENESIS_TOKEN_ID);
    expect(job?.commitmentJson).toBe('');

    await new Promise((r) => setTimeout(r, 10));
    expect(submitSpy).not.toHaveBeenCalled();
  });
});
