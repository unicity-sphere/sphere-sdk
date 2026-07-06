/**
 * Tests for V5 outbox persistence via CID references
 * (PROFILE-CID-REFERENCES.md §8.2 — Pattern A).
 *
 * Mirrors the pendingV5Tokens CID-ref tests in v5-finalization.test.ts.
 * Outbox entries wrap TransferResult { tokens: Token[] }, which carries fat
 * sdkData — the fat-data audit flagged this as the second-largest OpLog
 * bloater after pendingV5Tokens.
 *
 * Covers:
 *   1. Write: CID ref envelope stored when cidRefStore is injected
 *   2. Read:  dual-read — CID ref fetched from IPFS
 *   3. Read:  legacy inline JSON still parses (migration window)
 *   4. Fallback: inline JSON retained when cidRefStore is absent
 *   5. Empty outbox clears KV + memoization state
 *   6. Memoization: identical plaintext reuses cached ref (no re-pin)
 *   7. Config error: ref present + no cidRefStore → CID_REF_UNREADABLE
 *   8. OpLog size: ref is constant-small regardless of outbox length
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPaymentsModule, type PaymentsModuleDependencies } from '../../../modules/payments/PaymentsModule';
import type { FullIdentity, Token, TransferResult } from '../../../types';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase } from '../../../storage';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import { STORAGE_KEYS_ADDRESS } from '../../../constants';

// =============================================================================
// Mock SDK static imports used by PaymentsModule (copied from v5-finalization)
// =============================================================================

vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token', () => ({
  Token: {
    fromJSON: vi.fn().mockResolvedValue({
      id: { toString: () => 'mock-id', toJSON: () => 'mock-id' },
      coins: null,
      state: {},
      toJSON: () => ({ genesis: {}, state: {} }),
    }),
  },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/token/fungible/CoinId', () => ({
  CoinId: class MockCoinId { toJSON() { return 'UCT_HEX'; } },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/TransferCommitment', () => ({
  TransferCommitment: { fromJSON: vi.fn() },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/MintCommitment', () => ({
  MintCommitment: { create: vi.fn().mockResolvedValue({ requestId: new Uint8Array([1, 2, 3]) }) },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/MintTransactionData', () => ({
  MintTransactionData: { fromJSON: vi.fn().mockResolvedValue({}) },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction', () => ({
  TransferTransaction: class MockTransferTransaction {},
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/sign/SigningService', () => ({
  SigningService: {
    fromKeyPair: vi.fn().mockResolvedValue({}),
    createFromSecret: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/address/AddressScheme', () => ({
  AddressScheme: class MockAddressScheme {},
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate', () => ({
  UnmaskedPredicate: class MockUnmaskedPredicate {},
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenState', () => ({
  TokenState: class MockTokenState {},
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

// =============================================================================
// Test helpers
// =============================================================================

/** Create a Token with a realistically fat sdkData blob so size assertions
 *  reflect the actual fat-data problem, not trivial test data. */
function createFatToken(id: string): Token {
  return {
    id,
    coinId: 'UCT_HEX',
    symbol: 'UCT',
    name: 'Unicity Token',
    decimals: 8,
    amount: '1000000',
    status: 'submitted',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    // ~3 KB of mock sdkData per token — shape doesn't matter, the bloat does.
    sdkData: JSON.stringify({
      version: '2.0',
      genesis: { data: { tokenId: id, tokenType: '00', coinData: [['UCT_HEX', '1000000']] } },
      state: { data: 'x'.repeat(2048), predicate: 'p'.repeat(512) },
      transactions: [],
    }),
  };
}

function createTransferResult(id: string, tokenCount = 1): TransferResult {
  const tokens = Array.from({ length: tokenCount }, (_, i) => createFatToken(`${id}_tok${i}`));
  return {
    id,
    status: 'submitted',
    tokens,
    tokenTransfers: [],
  };
}

/** Fake CidRefStore backed by an in-memory map. Uses real CIDv1 raw strings
 *  so CidRefStore.tryParseRef's CID.parse validation accepts them. */
function makeFakeCidRefStore() {
  const ipfsStore = new Map<string, unknown>();
  const FAKE_CIDS = [
    'bafkreieyqvmjr6zq5adijx2kzlcfmdvexmy2i6knyj4w2pybmzxmvg6bze',
    'bafkreif4jkpxy2j7hezb2kjfb2mk23wsq5s7vzlqfkwnofkcfxsikiznna',
    'bafkreihjkz4shxhcbw2dsvsplsx5bwjv4uibkivyu3vzmhcuhaibcmxpau',
    'bafkreibnx2xlk3nv6r5tmsdtp3kvo5j2zh5y3qhqnvp7z4z5yblcvchyqu',
    'bafkreigc7s4sqhn7y7qdmkshxswfucacvalvb7r6i57sxa3gngkxm7pwdq',
  ];
  let nextCid = 0;
  const fakeStore = {
    pinJson: vi.fn(async (value: unknown) => {
      const cid = FAKE_CIDS[nextCid % FAKE_CIDS.length]!;
      nextCid += 1;
      ipfsStore.set(cid, value);
      const json = JSON.stringify(value);
      return {
        v: 1 as const,
        cid,
        size: new TextEncoder().encode(json).byteLength + 28, // IV + tag
        ts: Date.now(),
      };
    }),
    fetchJson: vi.fn(async (ref: { cid: string }) => {
      const data = ipfsStore.get(ref.cid);
      if (data === undefined) throw new Error(`CID not found: ${ref.cid}`);
      return data;
    }),
  };
  return { fakeStore, ipfsStore };
}

function createMockDeps(storageData?: Map<string, string>): PaymentsModuleDependencies {
  const store = storageData ?? new Map<string, string>();

  const mockStorage: StorageProvider = {
    id: 'mock-storage',
    name: 'Mock Storage',
    type: 'local',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    get: vi.fn().mockImplementation((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn().mockImplementation((key: string, value: string) => { store.set(key, value); return Promise.resolve(); }),
    remove: vi.fn().mockImplementation((key: string) => { store.delete(key); return Promise.resolve(); }),
    has: vi.fn().mockImplementation((key: string) => Promise.resolve(store.has(key))),
    keys: vi.fn().mockResolvedValue([]),
    clear: vi.fn().mockResolvedValue(undefined),
  };

  const mockTokenStorage: TokenStorageProvider<TxfStorageDataBase> = {
    id: 'mock-token-storage',
    name: 'Mock Token Storage',
    type: 'local',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    initialize: vi.fn().mockResolvedValue(true),
    shutdown: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue({ success: true, timestamp: Date.now() }),
    load: vi.fn().mockResolvedValue({ success: false, source: 'local' as const, timestamp: Date.now() }),
    sync: vi.fn().mockResolvedValue({ success: true, added: 0, removed: 0, conflicts: 0 }),
  };

  const tokenStorageProviders = new Map<string, TokenStorageProvider<TxfStorageDataBase>>();
  tokenStorageProviders.set('mock', mockTokenStorage);

  const mockTransport = {
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as const),
    setIdentity: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue('event-id'),
    onMessage: vi.fn().mockReturnValue(() => {}),
    sendTokenTransfer: vi.fn().mockResolvedValue('event-id'),
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
  } as unknown as OracleProvider;

  const mockIdentity: FullIdentity = {
    chainPubkey: '02' + 'ab'.repeat(32),
    directAddress: 'DIRECT://test',
    privateKey: 'aa'.repeat(32),
  };

  return {
    identity: mockIdentity,
    storage: mockStorage,
    tokenStorageProviders,
    transport: mockTransport,
    oracle: mockOracle,
    emitEvent: vi.fn(),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('PaymentsModule — V5 outbox CID-ref persistence', () => {
  let storageMap: Map<string, string>;
  let deps: PaymentsModuleDependencies;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any;

  beforeEach(() => {
    vi.clearAllMocks();
    storageMap = new Map();
    deps = createMockDeps(storageMap);
    mod = createPaymentsModule({ debug: false });
    mod.initialize(deps);
  });

  afterEach(() => {
    mod.destroy?.();
    vi.restoreAllMocks();
  });

  it('writes CID ref envelope to OpLog when cidRefStore is provided', async () => {
    const { fakeStore } = makeFakeCidRefStore();
    (deps as unknown as { cidRefStore: unknown }).cidRefStore = fakeStore;

    const transfer = createTransferResult('tx1');
    await mod.saveToOutbox(transfer, '02' + 'cd'.repeat(32));

    const kvData = storageMap.get(STORAGE_KEYS_ADDRESS.OUTBOX);
    expect(kvData).toBeDefined();
    // KV must NOT contain the token ID — that's in IPFS now.
    expect(kvData).not.toContain('tx1_tok0');
    // Envelope shape check.
    const parsed = JSON.parse(kvData!);
    expect(parsed.v).toBe(1);
    expect(parsed.cid).toMatch(/^baf/);
    expect(parsed.size).toBeGreaterThan(0);
    expect(parsed.ts).toBeGreaterThan(0);
    expect(fakeStore.pinJson).toHaveBeenCalledTimes(1);
  });

  it('loads CID ref from OpLog and fetches content from IPFS', async () => {
    const { fakeStore, ipfsStore } = makeFakeCidRefStore();
    (deps as unknown as { cidRefStore: unknown }).cidRefStore = fakeStore;

    // Pre-populate: emulate a prior write by seeding both IPFS and KV.
    const transfer = createTransferResult('tx1');
    const pinnedList = [{ transfer, recipient: '02' + 'cd'.repeat(32), createdAt: 1700000000000 }];
    const prePinCid = 'bafkreieyqvmjr6zq5adijx2kzlcfmdvexmy2i6knyj4w2pybmzxmvg6bze';
    ipfsStore.set(prePinCid, pinnedList);
    storageMap.set(
      STORAGE_KEYS_ADDRESS.OUTBOX,
      JSON.stringify({ v: 1, cid: prePinCid, size: 1000, ts: 1700000000000 }),
    );

    const loaded = await mod.loadOutbox();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].transfer.id).toBe('tx1');
    expect(fakeStore.fetchJson).toHaveBeenCalledTimes(1);
  });

  it('legacy inline JSON still reads correctly when cidRefStore is provided (migration)', async () => {
    const { fakeStore } = makeFakeCidRefStore();
    (deps as unknown as { cidRefStore: unknown }).cidRefStore = fakeStore;

    // Seed KV with LEGACY inline JSON (pre-CID-refs wallet format).
    const transfer = createTransferResult('tx_legacy');
    const legacyList = [{ transfer, recipient: '02' + 'cd'.repeat(32), createdAt: 1700000000000 }];
    storageMap.set(STORAGE_KEYS_ADDRESS.OUTBOX, JSON.stringify(legacyList));

    const loaded = await mod.loadOutbox();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].transfer.id).toBe('tx_legacy');
    // tryParseRef returned null — legacy path taken.
    expect(fakeStore.fetchJson).not.toHaveBeenCalled();
  });

  it('inline JSON fallback still works when cidRefStore is absent (backward compat)', async () => {
    // cidRefStore deliberately not set — legacy path on write.
    const transfer = createTransferResult('tx1');
    await mod.saveToOutbox(transfer, '02' + 'cd'.repeat(32));

    const kvData = storageMap.get(STORAGE_KEYS_ADDRESS.OUTBOX);
    expect(kvData).toBeDefined();
    // Without cidRefStore, falls back to inline JSON array.
    const parsed = JSON.parse(kvData!);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].transfer.id).toBe('tx1');
  });

  it('empty outbox after removeFromOutbox clears KV and memoization', async () => {
    const { fakeStore } = makeFakeCidRefStore();
    (deps as unknown as { cidRefStore: unknown }).cidRefStore = fakeStore;

    await mod.saveToOutbox(createTransferResult('tx1'), '02' + 'cd'.repeat(32));
    expect(storageMap.get(STORAGE_KEYS_ADDRESS.OUTBOX)).toBeTruthy();

    await mod.removeFromOutbox('tx1');
    // Empty outbox writes empty string (matches legacy behaviour, loadOutbox
    // returns [] when KV is empty/null).
    expect(storageMap.get(STORAGE_KEYS_ADDRESS.OUTBOX)).toBe('');
    // Memo cleared so next non-empty save pins fresh.
    expect(mod._lastPinnedOutboxJson).toBeNull();
    expect(mod._lastPinnedOutboxRef).toBeNull();
  });

  it('memoizes identical plaintext and skips re-pin', async () => {
    const { fakeStore } = makeFakeCidRefStore();
    (deps as unknown as { cidRefStore: unknown }).cidRefStore = fakeStore;

    const transfer = createTransferResult('tx1');
    const recipient = '02' + 'cd'.repeat(32);

    // First save → pins.
    await mod.saveToOutbox(transfer, recipient);
    expect(fakeStore.pinJson).toHaveBeenCalledTimes(1);
    const firstKv = storageMap.get(STORAGE_KEYS_ADDRESS.OUTBOX);

    // Remove a non-existent entry: list unchanged → memo hit → no re-pin.
    // (The other mutation paths (saveToOutbox / removeFromOutbox existing) all
    // change the list, so the memo path only triggers on structural no-ops.
    // We simulate by invoking the private writeOutbox with the same list.)
    const currentList = await mod.loadOutbox();
    await mod.writeOutbox(currentList);
    expect(fakeStore.pinJson).toHaveBeenCalledTimes(1); // still one — reused memo
    expect(storageMap.get(STORAGE_KEYS_ADDRESS.OUTBOX)).toBe(firstKv);
  });

  it('throws CID_REF_UNREADABLE when ref present but cidRefStore absent', async () => {
    // Seed KV with a CID ref envelope but leave cidRefStore undefined on deps.
    storageMap.set(
      STORAGE_KEYS_ADDRESS.OUTBOX,
      JSON.stringify({
        v: 1,
        cid: 'bafkreieyqvmjr6zq5adijx2kzlcfmdvexmy2i6knyj4w2pybmzxmvg6bze',
        size: 1000,
        ts: 1700000000000,
      }),
    );

    await expect(mod.loadOutbox()).rejects.toThrow(/CID_REF_UNREADABLE/);
  });

  it('OpLog value shrinks dramatically when CidRefStore is used', async () => {
    // Write ten entries via the LEGACY path to measure fat size.
    for (let i = 0; i < 10; i++) {
      await mod.saveToOutbox(createTransferResult(`tx${i}`, 3), '02' + 'cd'.repeat(32));
    }
    const legacySize = storageMap.get(STORAGE_KEYS_ADDRESS.OUTBOX)!.length;
    expect(legacySize).toBeGreaterThan(10_000); // 10 × 3 tokens × ~3 KB sdkData

    // Inject cidRefStore and re-write the current list — ref is now tiny.
    const { fakeStore } = makeFakeCidRefStore();
    (deps as unknown as { cidRefStore: unknown }).cidRefStore = fakeStore;
    await mod.saveToOutbox(createTransferResult('tx_new', 1), '02' + 'cd'.repeat(32));

    const refSize = storageMap.get(STORAGE_KEYS_ADDRESS.OUTBOX)!.length;
    // Envelope is ~100–200 bytes regardless of list length.
    expect(refSize).toBeLessThan(300);
    expect(refSize).toBeLessThan(legacySize);
  });

  it('legacy-JSON SyntaxError returns [] rather than throwing', async () => {
    // A corrupt legacy wallet — KV contains malformed JSON that is NOT a ref.
    storageMap.set(STORAGE_KEYS_ADDRESS.OUTBOX, '{corrupt json without quotes}');
    const loaded = await mod.loadOutbox();
    expect(loaded).toEqual([]);
  });

  it('non-array legacy data logs and returns [] (corruption visibility)', async () => {
    // Legacy JSON that parses but isn't an array (e.g., shape drift, wrong file).
    storageMap.set(STORAGE_KEYS_ADDRESS.OUTBOX, JSON.stringify({ notAnArray: true }));
    const loaded = await mod.loadOutbox();
    expect(loaded).toEqual([]);
    // Note: console/logger assertion omitted — logger is a module-level import,
    // and we don't intercept it here. The non-array early-return itself is the
    // observable behaviour under test (pre-fix, shape corruption caused silent
    // data loss on the next saveToOutbox).
  });

  it('concurrent saveToOutbox calls serialize via outbox-chain (no lost writes)', async () => {
    // Without the chain, two concurrent saveToOutbox calls both read `[]`
    // then write single-entry lists — the second write clobbers the first.
    // With the chain, save B awaits save A and both entries land.
    const { fakeStore } = makeFakeCidRefStore();
    (deps as unknown as { cidRefStore: unknown }).cidRefStore = fakeStore;

    const t1 = createTransferResult('tx1');
    const t2 = createTransferResult('tx2');
    const recipient = '02' + 'cd'.repeat(32);

    // Kick off both in parallel.
    const [, ] = await Promise.all([
      mod.saveToOutbox(t1, recipient),
      mod.saveToOutbox(t2, recipient),
    ]);

    const loaded = await mod.loadOutbox();
    expect(loaded).toHaveLength(2);
    const ids = loaded.map((e: { transfer: { id: string } }) => e.transfer.id).sort();
    expect(ids).toEqual(['tx1', 'tx2']);
  });

  it('concurrent saveToOutbox + removeFromOutbox serialize correctly', async () => {
    const { fakeStore } = makeFakeCidRefStore();
    (deps as unknown as { cidRefStore: unknown }).cidRefStore = fakeStore;

    const t1 = createTransferResult('tx1');
    const t2 = createTransferResult('tx2');
    const recipient = '02' + 'cd'.repeat(32);

    // Seed tx1, then concurrently: add tx2, remove tx1. Expected end state: [tx2].
    await mod.saveToOutbox(t1, recipient);
    await Promise.all([
      mod.saveToOutbox(t2, recipient),
      mod.removeFromOutbox('tx1'),
    ]);

    const loaded = await mod.loadOutbox();
    const ids = loaded.map((e: { transfer: { id: string } }) => e.transfer.id).sort();
    expect(ids).toEqual(['tx2']);
  });
});
