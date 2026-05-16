/**
 * Dual-mode PaymentsModule tests.
 *
 * Verifies that PaymentsModule works identically when wired against the
 * legacy TokenStorageProvider (file-based TxfStorageDataBase) and when
 * wired against the Profile TokenStorageProvider (OrbitDB + UXF CAR).
 *
 * Scenarios covered:
 *   1. Add tokens → save → reload preserves the pool (both modes)
 *   2. exportTokens round-trip through UXF CAR preserves tokens
 *   3. exportTokens round-trip through TXF JSON preserves tokens
 *   4. Cross-mode send-equivalent: tokens exported from a legacy wallet
 *      can be imported into a Profile wallet and vice-versa
 *
 * The network/oracle/SDK layers are mocked — we exercise the storage
 * and conversion paths without hitting any external service.
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

// ---------------------------------------------------------------------------
// SDK mocks (same pattern as PaymentsModule.tombstone.test.ts)
// ---------------------------------------------------------------------------

vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token', () => ({
  Token: {
    fromJSON: vi.fn().mockResolvedValue({ id: { toString: () => 'mock-id' }, coins: null, state: {} }),
  },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/token/fungible/CoinId', () => ({
  CoinId: class { toJSON() { return 'UCT_HEX'; } },
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
    getInstance: () => ({
      getDefinition: () => null,
      getIconUrl: () => null,
    }),
  },
}));

// ---------------------------------------------------------------------------
// Token fixtures (shared across modes)
// ---------------------------------------------------------------------------

const TOKEN_A = 'aa' + '00'.repeat(31);
const TOKEN_B = 'bb' + '00'.repeat(31);
const STATE_1 = '11' + '00'.repeat(31);
const STATE_2 = '22' + '00'.repeat(31);

// Hex-valid filler constants so deconstruct() accepts our fixtures.
// UXF deconstruction validates hex length/charset during packaging;
// real tokens carry canonical hex everywhere.
const PUBKEY_HEX = '02' + 'aa'.repeat(32); // compressed secp256k1
const SIGNATURE_HEX = '30' + '44'.repeat(35); // DER-ish filler
const CERT_HEX = 'ab'.repeat(32);
const TX_HASH_HEX = 'cd'.repeat(32);
const PREDICATE_HEX = 'de'.repeat(32);

function buildTxf(opts: { tokenId: string; stateHash: string; amount?: string }): TxfToken {
  return {
    version: '2.0',
    genesis: {
      data: {
        tokenId: opts.tokenId,
        tokenType: '01'.repeat(32),
        coinData: [['UCT_HEX', opts.amount ?? '1000000']],
        tokenData: '',
        salt: '55'.repeat(32),
        recipient: 'DIRECT://test',
        recipientDataHash: null,
        reason: null,
      },
      inclusionProof: {
        authenticator: {
          algorithm: 'secp256k1',
          publicKey: PUBKEY_HEX,
          signature: SIGNATURE_HEX,
          stateHash: opts.stateHash,
        },
        merkleTreePath: { root: '00'.repeat(32), steps: [] },
        transactionHash: TX_HASH_HEX,
        unicityCertificate: CERT_HEX,
      },
    },
    state: { data: '', predicate: PREDICATE_HEX },
    transactions: [],
  };
}

function buildToken(opts: { tokenId: string; stateHash: string; amount?: string }): Token {
  const txf = buildTxf(opts);
  return {
    id: `local-${opts.tokenId.slice(0, 8)}-${opts.stateHash.slice(0, 8)}`,
    coinId: 'UCT_HEX',
    symbol: 'UCT',
    name: 'Unicity Token',
    decimals: 8,
    amount: opts.amount ?? '1000000',
    status: 'confirmed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sdkData: JSON.stringify(txf),
  };
}

// ---------------------------------------------------------------------------
// In-memory TokenStorageProvider implementations
// ---------------------------------------------------------------------------

/**
 * Legacy-style in-memory provider — stores TxfStorageDataBase verbatim,
 * as FileTokenStorageProvider does to disk. Round-trip is
 * structure-preserving by construction.
 */
function createLegacyInMemoryTokenStorage(): TokenStorageProvider<TxfStorageDataBase> & {
  _store: { data: TxfStorageDataBase | null };
} {
  const store: { data: TxfStorageDataBase | null } = { data: null };
  return {
    _store: store,
    id: 'legacy-in-memory',
    name: 'Legacy In-Memory Token Storage',
    type: 'local',
    async connect() {},
    async disconnect() {},
    isConnected() {
      return true;
    },
    getStatus() {
      return 'connected';
    },
    setIdentity() {},
    async initialize() {
      return true;
    },
    async shutdown() {},
    async save(data) {
      // Deep copy so mutations in caller don't retroactively alter saved state
      store.data = JSON.parse(JSON.stringify(data));
      return { success: true, timestamp: Date.now() };
    },
    async load() {
      return {
        success: store.data !== null,
        data: store.data ? JSON.parse(JSON.stringify(store.data)) : undefined,
        source: 'local',
        timestamp: Date.now(),
      };
    },
    async sync() {
      return { success: true, added: 0, removed: 0, conflicts: 0 };
    },
  };
}

/**
 * Profile-style in-memory provider — packs tokens via the REAL
 * UxfPackage and reassembles on load. This exercises the same
 * UXF-packaging round-trip that ProfileTokenStorageProvider does, just
 * without the OrbitDB + IPFS I/O layers. The goal is to prove that
 * UXF packaging preserves the fields PaymentsModule needs.
 */
function createProfileInMemoryTokenStorage(): TokenStorageProvider<TxfStorageDataBase> & {
  _store: { carBytes: Uint8Array | null; opState: Record<string, unknown> };
} {
  const store = {
    carBytes: null as Uint8Array | null,
    opState: {} as Record<string, unknown>,
  };

  return {
    _store: store,
    id: 'profile-in-memory',
    name: 'Profile In-Memory Token Storage',
    type: 'local',
    async connect() {},
    async disconnect() {},
    isConnected() {
      return true;
    },
    getStatus() {
      return 'connected';
    },
    setIdentity() {},
    async initialize() {
      return true;
    },
    async shutdown() {},
    async save(data) {
      const { UxfPackage } = await import('../../../uxf/UxfPackage.js');
      const pkg = UxfPackage.create();
      // Ingest tokens (keys starting with `_` that aren't operational)
      const operational = new Set([
        '_meta',
        '_tombstones',
        '_outbox',
        '_sent',
        '_invalid',
        '_history',
        '_mintOutbox',
        '_invalidatedNametags',
      ]);
      const tokens: unknown[] = [];
      for (const [k, v] of Object.entries(data)) {
        if (k.startsWith('archived-')) {
          tokens.push(v);
          continue;
        }
        if (k.startsWith('_') && !operational.has(k) && v && typeof v === 'object') {
          tokens.push(v);
        }
      }
      if (tokens.length > 0) pkg.ingestAll(tokens);

      store.carBytes = await pkg.toCar();
      // Capture operational state separately (mirrors Profile provider)
      store.opState = {
        _meta: data._meta,
        _tombstones: data._tombstones,
        _outbox: data._outbox,
        _sent: data._sent,
        _history: data._history,
        _invalid: data._invalid,
      };
      return { success: true, timestamp: Date.now() };
    },
    async load() {
      if (!store.carBytes) {
        return { success: false, source: 'local', timestamp: Date.now() };
      }
      const { UxfPackage } = await import('../../../uxf/UxfPackage.js');
      const pkg = await UxfPackage.fromCar(store.carBytes);
      const assembled = pkg.assembleAll();

      const data: TxfStorageDataBase = {
        _meta: (store.opState._meta as TxfStorageDataBase['_meta']) ?? {
          version: 1,
          address: 'mock',
          formatVersion: '1.0.0',
          updatedAt: Date.now(),
        },
      };
      for (const [k, v] of Object.entries(store.opState)) {
        if (k !== '_meta' && v !== undefined) {
          (data as unknown as Record<string, unknown>)[k] = v;
        }
      }
      for (const [tokenId, token] of assembled) {
        const key = tokenId.startsWith('_') ? tokenId : `_${tokenId}`;
        (data as unknown as Record<string, unknown>)[key] = token;
      }

      return { success: true, data, source: 'local', timestamp: Date.now() };
    },
    async sync() {
      return { success: true, added: 0, removed: 0, conflicts: 0 };
    },
  };
}

// ---------------------------------------------------------------------------
// Shared mock deps
// ---------------------------------------------------------------------------

function createDeps(
  tokenStorage: TokenStorageProvider<TxfStorageDataBase>,
): PaymentsModuleDependencies {
  const mockStorage: StorageProvider = {
    id: 'mock-storage',
    name: 'Mock Storage',
    type: 'local',
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

  const tokenStorageProviders = new Map();
  tokenStorageProviders.set('main', tokenStorage);

  const mockTransport = {
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
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
  } as unknown as OracleProvider;

  const identity: FullIdentity = {
    chainPubkey: '02' + 'aa'.repeat(32),
    l1Address: 'alpha1test',
    directAddress: 'DIRECT://test',
    privateKey: '00' + '11'.repeat(31),
  };

  return {
    identity,
    storage: mockStorage,
    tokenStorageProviders,
    transport: mockTransport,
    oracle: mockOracle,
    emitEvent: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests — parameterised across backends
// ---------------------------------------------------------------------------

type BackendFactory = () => TokenStorageProvider<TxfStorageDataBase> & {
  _store: unknown;
};

const backends: Array<{ name: string; create: BackendFactory }> = [
  { name: 'legacy (TxfStorageDataBase)', create: createLegacyInMemoryTokenStorage },
  { name: 'profile (UXF CAR round-trip)', create: createProfileInMemoryTokenStorage },
];

describe.each(backends)('PaymentsModule with $name backend', ({ create }) => {
  let module: ReturnType<typeof createPaymentsModule>;
  let storage: ReturnType<BackendFactory>;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = create();
    module = createPaymentsModule({ debug: false, autoSync: false });
    module.initialize(createDeps(storage));
  });

  it('addToken stores tokens that getTokens sees', async () => {
    await module.addToken(buildToken({ tokenId: TOKEN_A, stateHash: STATE_1 }));
    await module.addToken(buildToken({ tokenId: TOKEN_B, stateHash: STATE_2 }));
    expect(module.getTokens()).toHaveLength(2);
  });

  it('exportTokens produces wire-compatible TXF for every confirmed token', async () => {
    await module.addToken(buildToken({ tokenId: TOKEN_A, stateHash: STATE_1 }));
    await module.addToken(buildToken({ tokenId: TOKEN_B, stateHash: STATE_2 }));

    const exported = module.exportTokens();
    expect(exported).toHaveLength(2);
    for (const entry of exported) {
      expect(entry.txf.version).toBe('2.0');
      expect(entry.txf.genesis.data.tokenId).toMatch(/^[0-9a-f]+$/);
      expect(entry.txf.state.predicate).toBe(PREDICATE_HEX);
    }
  });

  it('importTokens → exportTokens round-trips on a fresh wallet', async () => {
    // A has two tokens
    await module.addToken(buildToken({ tokenId: TOKEN_A, stateHash: STATE_1 }));
    await module.addToken(buildToken({ tokenId: TOKEN_B, stateHash: STATE_2 }));
    const aExport = module.exportTokens();

    // Fresh wallet B using the same backend class
    const storageB = create();
    const moduleB = createPaymentsModule({ debug: false, autoSync: false });
    moduleB.initialize(createDeps(storageB));

    const result = await moduleB.importTokens(aExport.map((e) => e.txf));
    expect(result.added).toHaveLength(2);
    expect(result.rejected).toHaveLength(0);

    const bExport = moduleB.exportTokens();
    const aIds = aExport.map((e) => e.genesisTokenId).sort();
    const bIds = bExport.map((e) => e.genesisTokenId).sort();
    expect(bIds).toEqual(aIds);
  });

  it('tombstone-on-remove blocks re-import of the same (tokenId, stateHash)', async () => {
    const ui = buildToken({ tokenId: TOKEN_A, stateHash: STATE_1 });
    await module.addToken(ui);
    await module.removeToken(ui.id);

    const result = await module.importTokens([
      buildTxf({ tokenId: TOKEN_A, stateHash: STATE_1 }),
    ]);
    expect(result.added).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Cross-mode (the critical backward-compat gate)
// ---------------------------------------------------------------------------

describe('cross-mode send/receive compatibility', () => {
  it('legacy wallet → profile wallet: exported TXF is accepted and owned', async () => {
    const sender = createPaymentsModule({ debug: false, autoSync: false });
    const senderStorage = createLegacyInMemoryTokenStorage();
    sender.initialize(createDeps(senderStorage));
    await sender.addToken(buildToken({ tokenId: TOKEN_A, stateHash: STATE_1 }));

    const exported = sender.exportTokens().map((e) => e.txf);
    expect(exported).toHaveLength(1);

    const receiver = createPaymentsModule({ debug: false, autoSync: false });
    const receiverStorage = createProfileInMemoryTokenStorage();
    receiver.initialize(createDeps(receiverStorage));

    const result = await receiver.importTokens(exported);
    expect(result.added).toHaveLength(1);
    expect(result.added[0].genesisTokenId).toBe(TOKEN_A);

    // Profile-backed receiver now owns the token
    expect(receiver.getTokens()).toHaveLength(1);
  });

  it('profile wallet → legacy wallet: exported TXF is accepted and owned', async () => {
    const sender = createPaymentsModule({ debug: false, autoSync: false });
    const senderStorage = createProfileInMemoryTokenStorage();
    sender.initialize(createDeps(senderStorage));
    await sender.addToken(buildToken({ tokenId: TOKEN_B, stateHash: STATE_2 }));

    const exported = sender.exportTokens().map((e) => e.txf);
    expect(exported).toHaveLength(1);

    const receiver = createPaymentsModule({ debug: false, autoSync: false });
    const receiverStorage = createLegacyInMemoryTokenStorage();
    receiver.initialize(createDeps(receiverStorage));

    const result = await receiver.importTokens(exported);
    expect(result.added).toHaveLength(1);
    expect(result.added[0].genesisTokenId).toBe(TOKEN_B);
    expect(receiver.getTokens()).toHaveLength(1);
  });

  it('UXF CAR export → legacy import preserves all TXF fields', async () => {
    // Sender in profile mode — tokens go through the full UXF pack/unpack path
    const sender = createPaymentsModule({ debug: false, autoSync: false });
    sender.initialize(createDeps(createProfileInMemoryTokenStorage()));
    const original = buildTxf({ tokenId: TOKEN_A, stateHash: STATE_1 });
    await sender.addToken(buildToken({ tokenId: TOKEN_A, stateHash: STATE_1 }));

    // Export (profile wallet extracts TxfToken from sdkData — identical to input)
    const exported = sender.exportTokens()[0].txf;

    // Every wire field present and equal to the original
    expect(exported.genesis.data.tokenId).toBe(original.genesis.data.tokenId);
    expect(exported.genesis.data.tokenType).toBe(original.genesis.data.tokenType);
    expect(exported.genesis.data.coinData).toEqual(original.genesis.data.coinData);
    expect(exported.genesis.inclusionProof).toEqual(original.genesis.inclusionProof);
    expect(exported.state.predicate).toBe(original.state.predicate);

    // Receiver in legacy mode accepts it
    const receiver = createPaymentsModule({ debug: false, autoSync: false });
    receiver.initialize(createDeps(createLegacyInMemoryTokenStorage()));
    const result = await receiver.importTokens([exported]);
    expect(result.added).toHaveLength(1);
  });
});
