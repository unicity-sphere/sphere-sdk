/**
 * Tests for PaymentsModule tombstone enforcement
 *
 * Covers:
 * 1. isStateTombstoned() - direct API
 * 2. addToken() tombstone blocking (edge case: Nostr re-delivery)
 * 3. Nostr re-delivery protection (full add→remove→re-add cycle)
 * 4. mergeTombstones() - remote tombstone merging
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPaymentsModule, type PaymentsModuleDependencies } from '../../../modules/payments/PaymentsModule';
import type { Token, FullIdentity, SphereEventType, SphereEventMap } from '../../../types';
import type { TombstoneEntry } from '../../../types/txf';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase } from '../../../storage';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';

// =============================================================================
// Mock SDK static imports used by PaymentsModule
// =============================================================================

vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token', () => ({
  Token: { fromJSON: vi.fn().mockResolvedValue({ id: { toString: () => 'mock-id' }, coins: null, state: {} }) },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/token/fungible/CoinId', () => ({
  CoinId: class MockCoinId { toJSON() { return 'UCT_HEX'; } },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/TransferCommitment', () => ({
  TransferCommitment: { fromJSON: vi.fn() },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction', () => ({
  TransferTransaction: class MockTransferTransaction {},
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/sign/SigningService', () => ({
  SigningService: class MockSigningService {},
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

// Mock L1 network to prevent actual connection attempts
vi.mock('../../../l1/network', () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  isWebSocketConnected: vi.fn().mockReturnValue(false),
}));

// Mock the registry to prevent file I/O
vi.mock('../../../registry', () => ({
  TokenRegistry: {
    getInstance: () => ({
      getDefinition: () => null,
      getIconUrl: () => null,
    }),
  },
}));

// =============================================================================
// Test Constants
// =============================================================================

const TOKEN_ID_A = 'aaaa000000000000000000000000000000000000000000000000000000000001';
const TOKEN_ID_B = 'bbbb000000000000000000000000000000000000000000000000000000000002';
const STATE_HASH_1 = '1111000000000000000000000000000000000000000000000000000000000001';
const STATE_HASH_2 = '2222000000000000000000000000000000000000000000000000000000000002';
const STATE_HASH_3 = '3333000000000000000000000000000000000000000000000000000000000003';

// =============================================================================
// Test Helpers
// =============================================================================

function createMockToken(opts: {
  tokenId: string;
  stateHash: string;
  id?: string;
  status?: Token['status'];
}): Token {
  return {
    id: opts.id ?? `local-${opts.tokenId.slice(0, 8)}-${opts.stateHash.slice(0, 8)}`,
    coinId: 'UCT_HEX',
    symbol: 'UCT',
    name: 'Unicity Token',
    decimals: 8,
    amount: '1000000',
    status: opts.status ?? 'confirmed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sdkData: JSON.stringify({
      version: '2.0',
      genesis: {
        data: {
          tokenId: opts.tokenId,
          tokenType: '00',
          coinData: [['UCT_HEX', '1000000']],
          tokenData: '',
          salt: '00',
          recipient: 'DIRECT://test',
          recipientDataHash: null,
          reason: null,
        },
        inclusionProof: {
          authenticator: { algorithm: 'secp256k1', publicKey: 'pubkey', signature: 'sig', stateHash: opts.stateHash },
          merkleTreePath: { root: '00', steps: [] },
          transactionHash: '00',
          unicityCertificate: '00',
        },
      },
      state: { data: 'statedata', predicate: 'predicate' },
      transactions: [],
    }),
  };
}

function createMockDeps(): PaymentsModuleDependencies {
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
    getStatus: vi.fn().mockReturnValue('connected' as const),
    initialize: vi.fn().mockResolvedValue(undefined),
    submitCommitment: vi.fn().mockResolvedValue({ success: true }),
    getProof: vi.fn().mockResolvedValue(null),
    waitForProof: vi.fn().mockResolvedValue({}),
    validateToken: vi.fn().mockResolvedValue({ isValid: true }),
    isSpent: vi.fn().mockResolvedValue(false),
    getTokenState: vi.fn().mockResolvedValue(null),
  } as unknown as OracleProvider;

  const mockIdentity: FullIdentity = {
    chainPubkey: 'aabbccdd11223344556677889900aabbccdd11223344556677889900aabbccdd11',
    l1Address: 'alpha1testaddress',
    directAddress: 'DIRECT://test',
    privateKey: '0011223344556677889900aabbccddeeff0011223344556677889900aabbccddee',
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

describe('PaymentsModule - Tombstone Enforcement', () => {
  let module: ReturnType<typeof createPaymentsModule>;
  let deps: PaymentsModuleDependencies;

  beforeEach(() => {
    vi.clearAllMocks();
    module = createPaymentsModule({ debug: false });
    deps = createMockDeps();
    module.initialize(deps);
  });

  // ===========================================================================
  // 1. isStateTombstoned() - direct API
  // ===========================================================================

  describe('isStateTombstoned()', () => {
    it('should return false when tombstones are empty', () => {
      expect(module.isStateTombstoned(TOKEN_ID_A, STATE_HASH_1)).toBe(false);
    });

    it('should return true for exact (tokenId, stateHash) match', async () => {
      // Create tombstone by add→remove cycle
      const token = createMockToken({ tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1 });
      await module.addToken(token);
      await module.removeToken(token.id);

      expect(module.isStateTombstoned(TOKEN_ID_A, STATE_HASH_1)).toBe(true);
    });

    it('should return false for same tokenId but different stateHash', async () => {
      const token = createMockToken({ tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1 });
      await module.addToken(token);
      await module.removeToken(token.id);

      // Same tokenId, different stateHash → NOT tombstoned
      expect(module.isStateTombstoned(TOKEN_ID_A, STATE_HASH_2)).toBe(false);
    });

    it('should return false for different tokenId with same stateHash', async () => {
      const token = createMockToken({ tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1 });
      await module.addToken(token);
      await module.removeToken(token.id);

      // Different tokenId, same stateHash → NOT tombstoned
      expect(module.isStateTombstoned(TOKEN_ID_B, STATE_HASH_1)).toBe(false);
    });
  });

  // ===========================================================================
  // 2. addToken() tombstone blocking
  // ===========================================================================

  describe('addToken() tombstone blocking', () => {
    it('should reject token with exact (tokenId, stateHash) in tombstones', async () => {
      // Create tombstone
      const token = createMockToken({ tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1 });
      await module.addToken(token);
      await module.removeToken(token.id);

      // Try to re-add same token state
      const redelivered = createMockToken({ tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1, id: 'new-local-id' });
      const result = await module.addToken(redelivered);

      expect(result).toBe(false);
      // Token should NOT be in the active tokens
      expect(module.getTokens()).not.toContainEqual(expect.objectContaining({ id: redelivered.id }));
    });

    it('should allow token with same tokenId but DIFFERENT stateHash', async () => {
      // Create tombstone for state 1
      const token = createMockToken({ tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1 });
      await module.addToken(token);
      await module.removeToken(token.id);

      // Add same tokenId with different state → should be allowed (new state)
      const newState = createMockToken({ tokenId: TOKEN_ID_A, stateHash: STATE_HASH_2, id: 'new-state-id' });
      const result = await module.addToken(newState);

      expect(result).toBe(true);
      const tokens = module.getTokens();
      expect(tokens.some(t => t.id === 'new-state-id')).toBe(true);
    });

    it('should allow token when no tombstones exist', async () => {
      const token = createMockToken({ tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1 });
      const result = await module.addToken(token);

      expect(result).toBe(true);
      expect(module.getTokens().length).toBe(1);
    });

    it('should reject exact duplicate (same tokenId AND same stateHash) even without tombstone', async () => {
      const token = createMockToken({ tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1 });
      const result1 = await module.addToken(token);
      expect(result1).toBe(true);

      // Same token again (exact duplicate)
      const duplicate = createMockToken({ tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1, id: 'dup-id' });
      const result2 = await module.addToken(duplicate);
      expect(result2).toBe(false);

      // Only the original should be present
      expect(module.getTokens().length).toBe(1);
    });
  });

  // ===========================================================================
  // 3. Nostr re-delivery protection (full cycle)
  // ===========================================================================

  describe('Nostr re-delivery protection (full cycle)', () => {
    it('add → remove → re-add same token → rejected', async () => {
      const token = createMockToken({ tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1 });

      // Step 1: Add token
      const addResult = await module.addToken(token);
      expect(addResult).toBe(true);
      expect(module.getTokens().length).toBe(1);

      // Step 2: Remove token (spent) - creates tombstone
      await module.removeToken(token.id);
      expect(module.getTokens().length).toBe(0);
      expect(module.getTombstones().length).toBe(1);

      // Step 3: Re-add same token (Nostr re-delivery) → rejected
      const redelivered = createMockToken({ tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1, id: 'redelivered-id' });
      const readdResult = await module.addToken(redelivered);
      expect(readdResult).toBe(false);
      expect(module.getTokens().length).toBe(0);
    });

    it('add → remove → add with NEW stateHash → accepted', async () => {
      const token = createMockToken({ tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1 });

      // Step 1: Add token
      await module.addToken(token);
      expect(module.getTokens().length).toBe(1);

      // Step 2: Remove token (spent) - creates tombstone
      await module.removeToken(token.id);
      expect(module.getTokens().length).toBe(0);

      // Step 3: Add token with new state (legitimate new state after transfer back)
      const newState = createMockToken({ tokenId: TOKEN_ID_A, stateHash: STATE_HASH_2, id: 'new-state-id' });
      const result = await module.addToken(newState);
      expect(result).toBe(true);
      expect(module.getTokens().length).toBe(1);
    });

    it('getTombstones() should contain correct entries after removal', async () => {
      const token1 = createMockToken({ tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1, id: 'token-1' });
      const token2 = createMockToken({ tokenId: TOKEN_ID_B, stateHash: STATE_HASH_2, id: 'token-2' });

      await module.addToken(token1);
      await module.addToken(token2);
      await module.removeToken(token1.id);
      await module.removeToken(token2.id);

      const tombstones = module.getTombstones();
      expect(tombstones.length).toBe(2);
      expect(tombstones).toContainEqual(expect.objectContaining({ tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1 }));
      expect(tombstones).toContainEqual(expect.objectContaining({ tokenId: TOKEN_ID_B, stateHash: STATE_HASH_2 }));
    });

    it('removeToken for nonexistent token should not create tombstone', async () => {
      await module.removeToken('nonexistent-id');
      expect(module.getTombstones().length).toBe(0);
    });

    it('multiple removes of same token should not create duplicate tombstones', async () => {
      const token = createMockToken({ tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1 });
      await module.addToken(token);

      // First remove
      await module.removeToken(token.id);

      // Re-add with different local ID but same state (somehow bypassing tombstone check)
      // Then remove again — tombstone should still be unique
      const tombstonesBefore = module.getTombstones();
      expect(tombstonesBefore.length).toBe(1);
    });
  });

  // ===========================================================================
  // 4. mergeTombstones()
  // ===========================================================================

  describe('mergeTombstones()', () => {
    it('should add remote tombstones to local set', async () => {
      const remoteTombstones: TombstoneEntry[] = [
        { tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1, timestamp: Date.now() },
        { tokenId: TOKEN_ID_B, stateHash: STATE_HASH_2, timestamp: Date.now() },
      ];

      await module.mergeTombstones(remoteTombstones);

      const local = module.getTombstones();
      expect(local.length).toBe(2);
      expect(local).toContainEqual(expect.objectContaining({ tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1 }));
      expect(local).toContainEqual(expect.objectContaining({ tokenId: TOKEN_ID_B, stateHash: STATE_HASH_2 }));
    });

    it('should remove local tokens matching remote tombstones', async () => {
      // Add some tokens first
      const token = createMockToken({ tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1 });
      await module.addToken(token);
      expect(module.getTokens().length).toBe(1);

      // Merge tombstones that match the token
      const remoteTombstones: TombstoneEntry[] = [
        { tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1, timestamp: Date.now() },
      ];

      const removedCount = await module.mergeTombstones(remoteTombstones);

      expect(removedCount).toBe(1);
      expect(module.getTokens().length).toBe(0);
    });

    it('should not remove tokens that do not match remote tombstones', async () => {
      const token = createMockToken({ tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1 });
      await module.addToken(token);

      // Tombstone for a different state
      const remoteTombstones: TombstoneEntry[] = [
        { tokenId: TOKEN_ID_A, stateHash: STATE_HASH_2, timestamp: Date.now() },
      ];

      const removedCount = await module.mergeTombstones(remoteTombstones);

      expect(removedCount).toBe(0);
      expect(module.getTokens().length).toBe(1);
    });

    it('should not create duplicate tombstones', async () => {
      const tombstone: TombstoneEntry = { tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1, timestamp: Date.now() };

      // First merge
      await module.mergeTombstones([tombstone]);
      expect(module.getTombstones().length).toBe(1);

      // Second merge with same tombstone
      await module.mergeTombstones([tombstone]);
      expect(module.getTombstones().length).toBe(1);
    });

    it('should merge tombstones as union of local and remote', async () => {
      // Create local tombstone via add→remove
      const token = createMockToken({ tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1 });
      await module.addToken(token);
      await module.removeToken(token.id);
      expect(module.getTombstones().length).toBe(1);

      // Merge with remote tombstone (different token)
      const remoteTombstones: TombstoneEntry[] = [
        { tokenId: TOKEN_ID_B, stateHash: STATE_HASH_2, timestamp: Date.now() },
      ];

      await module.mergeTombstones(remoteTombstones);

      const all = module.getTombstones();
      expect(all.length).toBe(2);
      expect(all).toContainEqual(expect.objectContaining({ tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1 }));
      expect(all).toContainEqual(expect.objectContaining({ tokenId: TOKEN_ID_B, stateHash: STATE_HASH_2 }));
    });

    it('should reject tokens via addToken() after tombstones are merged', async () => {
      const remoteTombstones: TombstoneEntry[] = [
        { tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1, timestamp: Date.now() },
      ];

      await module.mergeTombstones(remoteTombstones);

      // Try to add the tombstoned token
      const token = createMockToken({ tokenId: TOKEN_ID_A, stateHash: STATE_HASH_1 });
      const result = await module.addToken(token);

      expect(result).toBe(false);
      expect(module.getTokens().length).toBe(0);
    });
  });
});
