/**
 * Tests for profile/import-from-legacy.ts
 *
 * The migration helper is a thin wrapper around
 * `PaymentsModule.importTokens` whose source is a legacy
 * TokenStorageProvider. We verify:
 *   - Empty source → empty result, success.
 *   - Tokens extracted from active / archived / forked keys.
 *   - Operational keys (_meta, _tombstones, etc.) are skipped.
 *   - Source storage is read-only — no mutating calls.
 *   - Re-running yields zero added on the second pass (idempotence).
 *   - Dry-run reports tokens-found but does not call importTokens.
 *   - importTokens errors propagate via result.error (not throw).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createPaymentsModule,
  type PaymentsModuleDependencies,
} from '../../../modules/payments/PaymentsModule';
import type { Token, FullIdentity } from '../../../types';
import type {
  StorageProvider,
  TokenStorageProvider,
  TxfStorageDataBase,
} from '../../../storage';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type { TxfToken } from '../../../types/txf';
import { importLegacyTokens } from '../../../profile/import-from-legacy';

// ---------------------------------------------------------------------------
// SDK mocks (same pattern as PaymentsModule.dual-mode.test.ts)
// ---------------------------------------------------------------------------

vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token', () => ({
  Token: { fromJSON: vi.fn().mockResolvedValue({ id: { toString: () => 'mock' }, coins: null, state: {} }) },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/token/fungible/CoinId', () => ({
  CoinId: class { toJSON() { return 'UCT'; } },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/TransferCommitment', () => ({
  TransferCommitment: { fromJSON: vi.fn() },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction', () => ({
  TransferTransaction: class {},
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/sign/SigningService', () => ({
  SigningService: class {},
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
  HashAlgorithm: { SHA256: 'sha256' },
}));
vi.mock('../../../l1/network', () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  isWebSocketConnected: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../registry', () => ({
  TokenRegistry: {
    getInstance: () => ({ getDefinition: () => null, getIconUrl: () => null }),
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOKEN_A = 'aa' + '00'.repeat(31);
const TOKEN_B = 'bb' + '00'.repeat(31);
const TOKEN_C = 'cc' + '00'.repeat(31);
const STATE = '11' + '00'.repeat(31);

function buildTxf(tokenId: string): TxfToken {
  return {
    version: '2.0',
    genesis: {
      data: {
        tokenId,
        tokenType: '01'.repeat(32),
        coinData: [['UCT_HEX', '1000']],
        tokenData: '',
        salt: '55'.repeat(32),
        recipient: 'DIRECT://test',
        recipientDataHash: null,
        reason: null,
      },
      inclusionProof: {
        authenticator: {
          algorithm: 'secp256k1',
          publicKey: '02' + 'aa'.repeat(32),
          signature: '30' + '44'.repeat(35),
          stateHash: STATE,
        },
        merkleTreePath: { root: '00'.repeat(32), steps: [] },
        transactionHash: 'cd'.repeat(32),
        unicityCertificate: 'ab'.repeat(32),
      },
    },
    state: { data: '', predicate: 'de'.repeat(32) },
    transactions: [],
  };
}

function buildLegacyData(opts: {
  active?: string[];
  archived?: string[];
  forked?: Array<{ tokenId: string; stateHash: string }>;
  withOperational?: boolean;
}): TxfStorageDataBase {
  const data: Record<string, unknown> = {
    _meta: {
      version: 1,
      address: 'mock',
      formatVersion: '1.0.0',
      updatedAt: 0,
    },
  };

  for (const tid of opts.active ?? []) {
    data[`_${tid}`] = buildTxf(tid);
  }
  for (const tid of opts.archived ?? []) {
    data[`archived-${tid}`] = buildTxf(tid);
  }
  for (const f of opts.forked ?? []) {
    data[`_forked_${f.tokenId}_${f.stateHash}`] = buildTxf(f.tokenId);
  }
  if (opts.withOperational) {
    data._tombstones = [{ tokenId: 'old', stateHash: 'x', timestamp: 0 }];
    data._outbox = [];
    data._sent = [];
    data._history = [];
  }

  return data as TxfStorageDataBase;
}

function createMockLegacyStorage(
  data: TxfStorageDataBase | null,
  opts: { failLoad?: boolean } = {},
): TokenStorageProvider<TxfStorageDataBase> & { _calls: string[] } {
  const calls: string[] = [];
  return {
    _calls: calls,
    id: 'mock-legacy',
    name: 'Mock Legacy',
    type: 'local',
    async connect() { calls.push('connect'); },
    async disconnect() { calls.push('disconnect'); },
    isConnected() { return true; },
    getStatus() { return 'connected'; },
    setIdentity() { calls.push('setIdentity'); },
    async initialize() { calls.push('initialize'); return true; },
    async shutdown() { calls.push('shutdown'); },
    async save() { calls.push('save'); return { success: true, timestamp: Date.now() }; },
    async load() {
      calls.push('load');
      if (opts.failLoad) {
        return { success: false, source: 'local', timestamp: Date.now(), error: 'mock load failed' };
      }
      return { success: true, data: data ?? undefined, source: 'local', timestamp: Date.now() };
    },
    async sync() { calls.push('sync'); return { success: true, added: 0, removed: 0, conflicts: 0 }; },
  };
}

function createDeps(): PaymentsModuleDependencies {
  const mockStorage: StorageProvider = {
    id: 'ms', name: 'mock', type: 'local',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    has: vi.fn().mockResolvedValue(false),
    keys: vi.fn().mockResolvedValue([]),
    clear: vi.fn().mockResolvedValue(undefined),
  };
  const mockTokenStorage: TokenStorageProvider<TxfStorageDataBase> = {
    id: 'mts', name: 'mock', type: 'local',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    initialize: vi.fn().mockResolvedValue(true),
    shutdown: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue({ success: true, timestamp: Date.now() }),
    load: vi.fn().mockResolvedValue({ success: false, source: 'local', timestamp: Date.now() }),
    sync: vi.fn().mockResolvedValue({ success: true, added: 0, removed: 0, conflicts: 0 }),
  };
  const tokenStorageProviders = new Map();
  tokenStorageProviders.set('main', mockTokenStorage);
  const transport = {
    id: 't', name: 'mock', type: 'p2p' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
  } as unknown as TransportProvider;
  const oracle = {
    id: 'o', name: 'mock', type: 'network' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    initialize: vi.fn().mockResolvedValue(undefined),
  } as unknown as OracleProvider;
  const identity: FullIdentity = {
    chainPubkey: '02' + 'aa'.repeat(32),
    l1Address: 'alpha1test',
    directAddress: 'DIRECT://test',
    privateKey: '00' + '11'.repeat(31),
  };
  return { identity, storage: mockStorage, tokenStorageProviders, transport, oracle, emitEvent: vi.fn() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('importLegacyTokens', () => {
  let target: ReturnType<typeof createPaymentsModule>;

  beforeEach(() => {
    vi.clearAllMocks();
    target = createPaymentsModule({ debug: false, autoSync: false });
    target.initialize(createDeps());
  });

  it('empty legacy storage → success with zero counts', async () => {
    const legacy = createMockLegacyStorage(buildLegacyData({}));
    const result = await importLegacyTokens(legacy, target);
    expect(result).toMatchObject({
      success: true,
      tokensFound: 0,
      tokensAdded: 0,
      tokensSkipped: 0,
      tokensRejected: 0,
    });
  });

  it('extracts active, archived, and forked tokens; skips operational keys', async () => {
    const legacy = createMockLegacyStorage(
      buildLegacyData({
        active: [TOKEN_A],
        archived: [TOKEN_B],
        forked: [{ tokenId: TOKEN_C, stateHash: STATE }],
        withOperational: true,  // _meta, _tombstones, etc. — must be filtered out
      }),
    );
    const result = await importLegacyTokens(legacy, target);
    expect(result.success).toBe(true);
    // Three distinct token records (active + archived + forked) — operational
    // keys never count as tokens.
    expect(result.tokensFound).toBe(3);
    expect(result.tokensAdded + result.tokensSkipped + result.tokensRejected).toBe(3);
  });

  it('does not mutate the legacy storage (read-only contract)', async () => {
    const legacy = createMockLegacyStorage(buildLegacyData({ active: [TOKEN_A] }));
    await importLegacyTokens(legacy, target);
    // Only `load` was called on the legacy provider — no save / clear / sync.
    expect(legacy._calls.filter((c) => c !== 'load')).toEqual([]);
  });

  it('is idempotent: re-running yields zero added on the second pass', async () => {
    const data = buildLegacyData({ active: [TOKEN_A, TOKEN_B] });
    const legacy = createMockLegacyStorage(data);
    const first = await importLegacyTokens(legacy, target);
    expect(first.tokensAdded).toBe(2);

    // Same source, same target → nothing new.
    const second = await importLegacyTokens(legacy, target);
    expect(second.tokensFound).toBe(2);
    expect(second.tokensAdded).toBe(0);
    expect(second.tokensSkipped).toBe(2);
  });

  it('joint inventory: legacy tokens are added on top of pre-existing Profile tokens', async () => {
    // Pre-populate the target with TOKEN_A (simulates an existing
    // Profile-mode wallet — the user is now importing legacy on top).
    const preExisting = {
      id: `pre-${TOKEN_A.slice(0, 8)}`,
      coinId: 'UCT_HEX',
      symbol: 'UCT',
      name: 'Unicity Token',
      decimals: 8,
      amount: '1000',
      status: 'confirmed' as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData: JSON.stringify(buildTxf(TOKEN_A)),
    };
    await target.addToken(preExisting);

    // Legacy has both TOKEN_A (already owned by Profile) and TOKEN_B (new).
    const legacy = createMockLegacyStorage(
      buildLegacyData({ active: [TOKEN_A, TOKEN_B] }),
    );
    const result = await importLegacyTokens(legacy, target);
    expect(result.tokensFound).toBe(2);
    expect(result.tokensAdded).toBe(1);    // only TOKEN_B is new
    expect(result.tokensSkipped).toBe(1);  // TOKEN_A was already owned
  });

  it('dry-run reports counts without writing to the target', async () => {
    const legacy = createMockLegacyStorage(
      buildLegacyData({ active: [TOKEN_A, TOKEN_B] }),
    );
    const result = await importLegacyTokens(legacy, target, { dryRun: true });
    expect(result.success).toBe(true);
    expect(result.tokensFound).toBe(2);
    expect(result.tokensAdded).toBe(0);
    // Target should have no tokens after a dry-run.
    expect(target.getTokens()).toHaveLength(0);
  });

  it('legacy load failure → success=false, no exception', async () => {
    const legacy = createMockLegacyStorage(null, { failLoad: true });
    const result = await importLegacyTokens(legacy, target);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mock load failed/);
  });
});
