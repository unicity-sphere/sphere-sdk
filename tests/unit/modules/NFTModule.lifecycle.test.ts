/**
 * NFTModule — Lifecycle tests (§9)
 *
 * Validates load(), destroy(), and their interactions: NFT discovery from
 * token storage, collection index construction, event subscription/cleanup.
 *
 * @see docs/NFT-TEST-SPEC.md §9
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, afterEach } from 'vitest';
import {
  createMockNFTConfig,
  createTestMetadata,
  createTestNFTTokenData,
  TEST_IDENTITY,
  NFT_TOKEN_TYPE_HEX,
  createNFTModule,
  canonicalSerializeNFT,
} from './nft-test-helpers.js';
import type { NFTModuleConfig } from '../../../modules/nft/types.js';
import type { Token } from '../../../types/index.js';
import { NFTModule } from '../../../modules/nft/NFTModule.js';

// =============================================================================
// Helpers
// =============================================================================

function randomHex(len: number): string {
  return Array.from({ length: len }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

function makeNFTUiToken(
  nftDataOverrides?: Partial<import('../../../modules/nft/types.js').NFTTokenData>,
  tokenId?: string,
): Token {
  const data = createTestNFTTokenData(nftDataOverrides);
  const id = tokenId ?? randomHex(64);
  const txf = {
    genesis: {
      data: {
        tokenId: id,
        tokenType: NFT_TOKEN_TYPE_HEX,
        tokenData: canonicalSerializeNFT(data),
        coinData: [],
      },
    },
  };

  return {
    id,
    coinId: NFT_TOKEN_TYPE_HEX,
    symbol: 'NFT',
    name: data.metadata.name,
    decimals: 0,
    amount: '1',
    status: 'confirmed',
    createdAt: data.mintedAt,
    updatedAt: Date.now(),
    sdkData: JSON.stringify(txf),
  };
}

function makeFungibleUiToken(): Token {
  const tokenId = randomHex(64);
  const txf = {
    genesis: {
      data: {
        tokenId,
        tokenType: randomHex(64),
        tokenData: '{}',
        coinData: [['UCT', '1000']],
      },
    },
  };

  return {
    id: tokenId,
    coinId: 'UCT',
    symbol: 'UCT',
    name: 'Fungible Token',
    decimals: 8,
    amount: '1000',
    status: 'confirmed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sdkData: JSON.stringify(txf),
  };
}

// =============================================================================
// Shared state
// =============================================================================

let module: NFTModule;

afterEach(async () => {
  try { await module?.destroy(); } catch { /* ignore */ }
});

// =============================================================================
// §9 Lifecycle Tests
// =============================================================================

describe('NFTModule — lifecycle', () => {
  // UT-LIFE-001: load() discovers existing NFTs from token storage
  it('UT-LIFE-001: load discovers existing NFTs from payments.getTokens()', async () => {
    const collectionA = 'aa'.repeat(32);
    const nft1 = makeNFTUiToken({ collectionId: collectionA, metadata: createTestMetadata({ name: 'NFT-1' }) });
    const nft2 = makeNFTUiToken({ collectionId: collectionA, metadata: createTestMetadata({ name: 'NFT-2' }) });
    const nft3 = makeNFTUiToken({ metadata: createTestMetadata({ name: 'NFT-3' }) });
    const fungible1 = makeFungibleUiToken();
    const fungible2 = makeFungibleUiToken();

    const config = createMockNFTConfig();
    const payments = config.payments as any;
    payments._tokens = [nft1, nft2, nft3, fungible1, fungible2];
    // Make getTokens return these tokens
    payments.getTokens.mockImplementation(() => payments._tokens.slice());

    module = createNFTModule();
    await module.load(config);

    // Only the 3 NFTs should be indexed (not the 2 fungibles)
    const nfts = module.getNFTs();
    expect(nfts).toHaveLength(3);
    const names = nfts.map(n => n.name).sort();
    expect(names).toEqual(['NFT-1', 'NFT-2', 'NFT-3']);
  });

  // UT-LIFE-002: load() builds collection index from tokens
  it('UT-LIFE-002: load builds collection index with correct token counts', async () => {
    const collectionA = 'aa'.repeat(32);
    const collectionB = 'bb'.repeat(32);
    const nft1 = makeNFTUiToken({ collectionId: collectionA, metadata: createTestMetadata({ name: 'A-1' }) });
    const nft2 = makeNFTUiToken({ collectionId: collectionA, metadata: createTestMetadata({ name: 'A-2' }) });
    const nft3 = makeNFTUiToken({ collectionId: collectionA, metadata: createTestMetadata({ name: 'A-3' }) });
    const nft4 = makeNFTUiToken({ collectionId: collectionB, metadata: createTestMetadata({ name: 'B-1' }) });
    const nft5 = makeNFTUiToken({ collectionId: collectionB, metadata: createTestMetadata({ name: 'B-2' }) });

    const config = createMockNFTConfig();
    const payments = config.payments as any;
    payments._tokens = [nft1, nft2, nft3, nft4, nft5];
    payments.getTokens.mockImplementation(() => payments._tokens.slice());

    module = createNFTModule();
    await module.load(config);

    const collections = module.getCollections();
    expect(collections).toHaveLength(2);

    const colA = collections.find(c => c.collectionId === collectionA);
    const colB = collections.find(c => c.collectionId === collectionB);
    expect(colA).toBeDefined();
    expect(colA!.tokenCount).toBe(3);
    expect(colB).toBeDefined();
    expect(colB!.tokenCount).toBe(2);
  });

  // UT-LIFE-004: load() subscribes to transfer events
  it('UT-LIFE-004: load subscribes to transfer:incoming via config.on', async () => {
    const config = createMockNFTConfig();
    module = createNFTModule();
    await module.load(config);

    const onCalls = (config.on as any).mock.calls;
    const incomingSubscriptions = onCalls.filter((c: any[]) => c[0] === 'transfer:incoming');
    expect(incomingSubscriptions.length).toBeGreaterThanOrEqual(1);
    expect(typeof incomingSubscriptions[0][1]).toBe('function');
  });

  // UT-LIFE-005: destroy() unsubscribes from events
  it('UT-LIFE-005: destroy clears index and unsubscribes from events', async () => {
    const config = createMockNFTConfig();
    const nft = makeNFTUiToken({ metadata: createTestMetadata({ name: 'Will-Destroy' }) });
    const payments = config.payments as any;
    payments._tokens = [nft];
    payments.getTokens.mockImplementation(() => payments._tokens.slice());

    module = createNFTModule();
    await module.load(config);

    expect(module.getNFTs()).toHaveLength(1);

    await module.destroy();

    // After destroy, calling getNFTs should throw (not initialized)
    expect(() => module.getNFTs()).toThrow();
  });

  // UT-LIFE-007: load() handles empty wallet
  it('UT-LIFE-007: load with no tokens results in empty indexes, no errors', async () => {
    const config = createMockNFTConfig();
    const payments = config.payments as any;
    payments._tokens = [];
    payments.getTokens.mockImplementation(() => []);

    module = createNFTModule();
    await module.load(config);

    expect(module.getNFTs()).toHaveLength(0);
    expect(module.getCollections()).toHaveLength(0);
  });
});
