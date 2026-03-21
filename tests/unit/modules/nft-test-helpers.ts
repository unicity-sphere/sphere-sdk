/**
 * Test helpers for NFTModule unit tests.
 *
 * Provides mock factories, fixture factories, and utility functions used
 * across all NFT test files.
 *
 * @see docs/NFT-TEST-SPEC.md §1
 */

import { vi } from 'vitest';
import { SphereError } from '../../../core/errors.js';
import { NFT_TOKEN_TYPE_HEX } from '../../../constants.js';
import { NFTModule, createNFTModule } from '../../../modules/nft/index.js';
import { canonicalSerializeNFT, deriveCollectionId, canonicalSerializeCollection } from '../../../modules/nft/serialization.js';

import type {
  NFTModuleConfig,
  NFTMetadata,
  NFTTokenData,
  CollectionDefinition,
  CreateCollectionRequest,
} from '../../../modules/nft/types.js';
import type { FullIdentity, Token, TransferResult } from '../../../types/index.js';
import type { TxfToken, TxfInclusionProof } from '../../../types/txf.js';

// Re-export for convenience in test files
export { SphereError, NFT_TOKEN_TYPE_HEX, deriveCollectionId, canonicalSerializeNFT, canonicalSerializeCollection, createNFTModule };
export type { TxfToken, NFTModuleConfig, NFTMetadata, NFTTokenData, CollectionDefinition, CreateCollectionRequest };

// =============================================================================
// Utility
// =============================================================================

function randomHex(length: number): string {
  return Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

// =============================================================================
// Test Identity
// =============================================================================

export const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'a'.repeat(64),
  l1Address: 'alpha1testaddr',
  directAddress: 'DIRECT://test_address',
  privateKey: 'ff'.repeat(32),
  nametag: 'testuser',
};

export const TEST_ADDRESS_ID = 'DIRECT_test_addr';
export const TEST_ADDRESS_INDEX = 0;

// =============================================================================
// Mock: PaymentsModule
// =============================================================================

export interface MockPaymentsModule {
  getTokens: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  addToken: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  _tokens: Token[];
  _sendResult: TransferResult;
  _handlers: Map<string, Array<(data: unknown) => void>>;
  _emit: (event: string, data: unknown) => void;
}

export function createMockPayments(): MockPaymentsModule {
  const tokens: Token[] = [];
  const handlers = new Map<string, Array<(data: unknown) => void>>();

  const defaultSendResult: TransferResult = {
    id: 'mock-transfer-id',
    status: 'completed',
    tokens: [],
    tokenTransfers: [],
  };

  const getTokens = vi.fn().mockImplementation((_filter?: unknown) => {
    return mock._tokens.slice();
  });

  const send = vi.fn().mockImplementation((_request: unknown): Promise<TransferResult> => {
    return Promise.resolve(mock._sendResult);
  });

  const addToken = vi.fn().mockImplementation(async (token: Token) => {
    mock._tokens.push(token);
  });

  const on = vi.fn().mockImplementation((event: string, handler: (data: unknown) => void): (() => void) => {
    if (!handlers.has(event)) {
      handlers.set(event, []);
    }
    handlers.get(event)!.push(handler);
    return () => {
      const list = handlers.get(event);
      if (list) {
        const idx = list.indexOf(handler);
        if (idx !== -1) list.splice(idx, 1);
      }
    };
  });

  const _emit = (event: string, data: unknown): void => {
    const list = handlers.get(event);
    if (list) {
      for (const h of list) h(data);
    }
  };

  const mock: MockPaymentsModule = {
    getTokens,
    send,
    addToken,
    on,
    _tokens: tokens,
    _sendResult: { ...defaultSendResult },
    _handlers: handlers,
    _emit,
  };

  return mock;
}

// =============================================================================
// Mock: StorageProvider (in-memory)
// =============================================================================

export interface MockStorageProvider {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  _data: Map<string, string>;
}

export function createMockStorage(): MockStorageProvider {
  const data = new Map<string, string>();

  const mock: MockStorageProvider = {
    get: vi.fn().mockImplementation(async (key: string) => data.get(key) ?? null),
    set: vi.fn().mockImplementation(async (key: string, value: string) => { data.set(key, value); }),
    remove: vi.fn().mockImplementation(async (key: string) => { data.delete(key); }),
    clear: vi.fn().mockImplementation(async () => { data.clear(); }),
    _data: data,
  };

  return mock;
}

// =============================================================================
// Mock: OracleProvider
// =============================================================================

export interface MockOracleProvider {
  validateToken: ReturnType<typeof vi.fn>;
  getStateTransitionClient: ReturnType<typeof vi.fn>;
  _stClient: MockStateTransitionClient;
}

export interface MockStateTransitionClient {
  submitMintCommitment: ReturnType<typeof vi.fn>;
}

export function createMockOracle(): MockOracleProvider {
  const stClient: MockStateTransitionClient = {
    submitMintCommitment: vi.fn().mockResolvedValue({ status: 'SUCCESS', requestId: 'req-' + randomHex(8) }),
  };

  const mock: MockOracleProvider = {
    validateToken: vi.fn().mockResolvedValue({ valid: true, spent: false, stateHash: randomHex(64) }),
    getStateTransitionClient: vi.fn().mockReturnValue(stClient),
    _stClient: stClient,
  };

  return mock;
}

// =============================================================================
// Mock: TokenStorageProvider
// =============================================================================

export function createMockTokenStorage() {
  return {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    clear: vi.fn().mockResolvedValue(undefined),
  };
}

// =============================================================================
// Fixture: NFTMetadata
// =============================================================================

export function createTestMetadata(overrides?: Partial<NFTMetadata>): NFTMetadata {
  return {
    name: 'Test NFT',
    image: 'ipfs://QmTestHash123',
    description: 'A test NFT for unit tests',
    ...overrides,
  };
}

// =============================================================================
// Fixture: NFTTokenData
// =============================================================================

export function createTestNFTTokenData(overrides?: Partial<NFTTokenData>): NFTTokenData {
  return {
    collectionId: randomHex(64),
    metadata: createTestMetadata(),
    edition: 1,
    totalEditions: 0,
    minter: TEST_IDENTITY.chainPubkey,
    mintedAt: Date.now(),
    ...overrides,
  };
}

// =============================================================================
// Fixture: TxfToken representing an NFT
// =============================================================================

export function createNFTTxfToken(nftData?: Partial<NFTTokenData>) {
  const data = createTestNFTTokenData(nftData);
  const tokenData = canonicalSerializeNFT(data);
  const tokenId = randomHex(64);

  return {
    tokenId,
    genesis: {
      data: {
        tokenId,
        tokenType: NFT_TOKEN_TYPE_HEX,
        tokenData,
        coinData: [],
      },
    },
    _nftData: data,
  };
}

// =============================================================================
// Fixture: Token (UI-level) representing an NFT
// =============================================================================

export function createNFTToken(nftData?: Partial<NFTTokenData>): Token {
  const txf = createNFTTxfToken(nftData);
  return {
    id: txf.tokenId,
    coinId: NFT_TOKEN_TYPE_HEX,
    symbol: 'NFT',
    name: txf._nftData.metadata.name,
    decimals: 0,
    amount: '1',
    status: 'confirmed',
    createdAt: txf._nftData.mintedAt,
    updatedAt: Date.now(),
    sdkData: JSON.stringify(txf),
  };
}

// =============================================================================
// Config builder
// =============================================================================

export function createMockNFTConfig(overrides?: Partial<NFTModuleConfig>): NFTModuleConfig {
  const payments = createMockPayments();
  const storage = createMockStorage();
  const oracle = createMockOracle();
  const tokenStorage = createMockTokenStorage();
  const events: Array<{ type: string; data: unknown }> = [];

  return {
    payments: payments as unknown as NFTModuleConfig['payments'],
    storage: storage as unknown as NFTModuleConfig['storage'],
    tokenStorage: tokenStorage as unknown as NFTModuleConfig['tokenStorage'],
    oracle: oracle as unknown as NFTModuleConfig['oracle'],
    trustBase: {},
    identity: TEST_IDENTITY,
    addressId: 'DIRECT_test_addr',
    addressIndex: 0,
    emitEvent: vi.fn().mockImplementation((type: string, data: unknown) => {
      events.push({ type, data });
    }),
    on: payments.on as unknown as NFTModuleConfig['on'],
    ...overrides,
  } as NFTModuleConfig;
}

// =============================================================================
// Fixture: CollectionDefinition
// =============================================================================

/**
 * Create a valid CollectionDefinition for testing.
 * Uses stable defaults for deterministic collectionId derivation.
 */
export function createTestCollectionDef(overrides?: Partial<CollectionDefinition>): CollectionDefinition {
  return {
    name: 'Test Collection',
    description: 'A test collection for unit tests',
    creator: TEST_IDENTITY.chainPubkey,
    createdAt: 1700000000000,
    maxSupply: null,
    transferable: true,
    deterministicMinting: false,
    ...overrides,
  };
}

/** Standard test collection definition (stable for deterministic ID). */
export const TEST_COLLECTION_DEF: CollectionDefinition = createTestCollectionDef();

/** Standard test collection ID (deterministic from TEST_COLLECTION_DEF). */
export const TEST_COLLECTION_ID: string = deriveCollectionId(TEST_COLLECTION_DEF);

// =============================================================================
// Fixture: Full TxfToken (with all required fields)
// =============================================================================

/** Create a mock inclusion proof. */
export function createMockInclusionProof(): TxfInclusionProof {
  return {
    authenticator: {
      algorithm: 'secp256k1',
      publicKey: '02' + 'a'.repeat(64),
      signature: randomHex(128),
      stateHash: randomHex(64),
    },
    merkleTreePath: {
      root: randomHex(64),
      steps: [],
    },
    transactionHash: randomHex(64),
    unicityCertificate: randomHex(256),
  };
}

/**
 * Create a full TxfToken representing an NFT (with all required TxfToken fields).
 * Use this when you need a proper TxfToken for import/export tests.
 */
export function createFullNFTTxfToken(nftData?: Partial<NFTTokenData>, tokenId?: string): TxfToken {
  const data = createTestNFTTokenData(nftData);
  const id = tokenId ?? randomHex(64);

  return {
    version: '2.0',
    genesis: {
      data: {
        tokenId: id,
        tokenType: NFT_TOKEN_TYPE_HEX,
        coinData: [],
        tokenData: canonicalSerializeNFT(data),
        salt: randomHex(64),
        recipient: TEST_IDENTITY.directAddress!,
        recipientDataHash: null,
        reason: null,
      },
      inclusionProof: createMockInclusionProof(),
    },
    state: {
      data: '',
      predicate: randomHex(64),
    },
    transactions: [],
  };
}

/**
 * Create a full TxfToken representing a fungible (non-NFT) token.
 */
export function createFullFungibleTxfToken(tokenId?: string): TxfToken {
  const id = tokenId ?? randomHex(64);

  return {
    version: '2.0',
    genesis: {
      data: {
        tokenId: id,
        tokenType: randomHex(64),
        coinData: [['UCT', '1000000']],
        tokenData: '',
        salt: randomHex(64),
        recipient: TEST_IDENTITY.directAddress!,
        recipientDataHash: null,
        reason: null,
      },
      inclusionProof: createMockInclusionProof(),
    },
    state: {
      data: '',
      predicate: randomHex(64),
    },
    transactions: [],
  };
}

// =============================================================================
// Factory: loaded NFTModule
// =============================================================================

/**
 * Create and load an NFTModule with mocked dependencies.
 * Returns both the module and the config for test assertions.
 */
export async function createLoadedNFTModule(
  configOverrides?: Partial<NFTModuleConfig>,
): Promise<{ module: NFTModule; config: NFTModuleConfig }> {
  const config = createMockNFTConfig(configOverrides);
  const module = createNFTModule();
  await module.load(config);
  return { module, config };
}
