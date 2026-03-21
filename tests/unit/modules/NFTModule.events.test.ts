/**
 * NFTModule — Event Processing tests (§8)
 *
 * Validates the incoming transfer event handler: NFT detection, event emission,
 * error resilience, mixed token handling, and collection auto-registration.
 *
 * @see docs/NFT-TEST-SPEC.md §8
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createMockNFTConfig,
  createTestMetadata,
  createTestNFTTokenData,
  createNFTTxfToken,
  createFullNFTTxfToken,
  createFullFungibleTxfToken,
  TEST_IDENTITY,
  NFT_TOKEN_TYPE_HEX,
  SphereError,
  createNFTModule,
  canonicalSerializeNFT,
} from './nft-test-helpers.js';
import type { NFTModuleConfig } from '../../../modules/nft/types.js';
import type { IncomingTransfer, Token } from '../../../types/index.js';
import { NFTModule } from '../../../modules/nft/NFTModule.js';

// =============================================================================
// Helpers
// =============================================================================

function randomHex(len: number): string {
  return Array.from({ length: len }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

function makeNFTUiToken(nftData?: Partial<import('../../../modules/nft/types.js').NFTTokenData>): Token {
  const data = createTestNFTTokenData(nftData);
  const tokenId = randomHex(64);
  const txf = {
    genesis: {
      data: {
        tokenId,
        tokenType: NFT_TOKEN_TYPE_HEX,
        tokenData: canonicalSerializeNFT(data),
        coinData: [],
      },
    },
  };

  return {
    id: tokenId,
    coinId: NFT_TOKEN_TYPE_HEX,
    symbol: 'NFT',
    name: data.metadata.name,
    decimals: 0,
    amount: '1',
    status: 'confirmed',
    createdAt: Date.now(),
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
        coinData: [['UCT', '100']],
      },
    },
  };

  return {
    id: tokenId,
    coinId: 'UCT',
    symbol: 'UCT',
    name: 'Fungible',
    decimals: 8,
    amount: '100',
    status: 'confirmed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sdkData: JSON.stringify(txf),
  };
}

function makeMalformedNFTUiToken(): Token {
  const tokenId = randomHex(64);
  const txf = {
    genesis: {
      data: {
        tokenId,
        tokenType: NFT_TOKEN_TYPE_HEX,
        tokenData: 'NOT_VALID_JSON{{{{',
        coinData: [],
      },
    },
  };

  return {
    id: tokenId,
    coinId: NFT_TOKEN_TYPE_HEX,
    symbol: 'NFT',
    name: 'Malformed',
    decimals: 0,
    amount: '1',
    status: 'confirmed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sdkData: JSON.stringify(txf),
  };
}

function makeIncomingTransfer(tokens: Token[]): IncomingTransfer {
  return {
    id: 'transfer-' + randomHex(8),
    senderPubkey: '03' + randomHex(64),
    senderNametag: 'sender',
    tokens,
    receivedAt: Date.now(),
  };
}

// =============================================================================
// Shared setup
// =============================================================================

let module: NFTModule;
let config: NFTModuleConfig;

async function setup(overrides?: Partial<NFTModuleConfig>) {
  config = createMockNFTConfig(overrides);
  module = createNFTModule();
  await module.load(config);
}

afterEach(async () => {
  try { await module?.destroy(); } catch { /* ignore */ }
});

// =============================================================================
// §8 Event Processing Tests
// =============================================================================

describe('NFTModule — event processing', () => {
  // UT-EVT-001: incoming transfer with NFT token triggers nft:received
  it('UT-EVT-001: emits nft:received for incoming NFT token', async () => {
    await setup();

    const collectionId = 'aa'.repeat(32);
    const nftToken = makeNFTUiToken({ collectionId, metadata: createTestMetadata({ name: 'Received Art' }) });
    const transfer = makeIncomingTransfer([nftToken]);

    // Simulate the transfer:incoming event
    const payments = config.payments as any;
    const incomingHandlers = payments._handlers?.get?.('transfer:incoming') ??
      (config.on as any).mock?.calls?.filter((c: any[]) => c[0] === 'transfer:incoming')?.map((c: any[]) => c[1]) ?? [];

    // The module subscribes via config.on('transfer:incoming', ...)
    // Find the handler that was registered
    const onCalls = (config.on as any).mock.calls;
    const incomingCall = onCalls.find((c: any[]) => c[0] === 'transfer:incoming');
    expect(incomingCall).toBeDefined();

    // Invoke the handler
    incomingCall[1](transfer);

    // Check nft:received was emitted
    const emitEvent = config.emitEvent as any;
    const receivedCalls = emitEvent.mock.calls.filter((c: any[]) => c[0] === 'nft:received');
    expect(receivedCalls).toHaveLength(1);
    expect(receivedCalls[0][1].tokenId).toBe(nftToken.id);
    expect(receivedCalls[0][1].name).toBe('Received Art');
    expect(receivedCalls[0][1].collectionId).toBe(collectionId);

    // NFT should be in index
    const nfts = module.getNFTs();
    expect(nfts).toHaveLength(1);
  });

  // UT-EVT-002: incoming transfer with mixed tokens — only NFT gets event
  it('UT-EVT-002: emits nft:received only for NFT tokens, ignores fungible', async () => {
    await setup();

    const nftToken = makeNFTUiToken({ metadata: createTestMetadata({ name: 'MixedNFT' }) });
    const fungibleToken = makeFungibleUiToken();
    const transfer = makeIncomingTransfer([nftToken, fungibleToken]);

    const onCalls = (config.on as any).mock.calls;
    const incomingCall = onCalls.find((c: any[]) => c[0] === 'transfer:incoming');
    incomingCall[1](transfer);

    const emitEvent = config.emitEvent as any;
    const receivedCalls = emitEvent.mock.calls.filter((c: any[]) => c[0] === 'nft:received');
    expect(receivedCalls).toHaveLength(1);
    expect(receivedCalls[0][1].name).toBe('MixedNFT');

    // Only 1 NFT in index
    expect(module.getNFTs()).toHaveLength(1);
  });

  // UT-EVT-003: incoming transfer with no NFTs — no event
  it('UT-EVT-003: does not emit nft:received when no NFTs in transfer', async () => {
    await setup();

    const fungible1 = makeFungibleUiToken();
    const fungible2 = makeFungibleUiToken();
    const transfer = makeIncomingTransfer([fungible1, fungible2]);

    const onCalls = (config.on as any).mock.calls;
    const incomingCall = onCalls.find((c: any[]) => c[0] === 'transfer:incoming');
    incomingCall[1](transfer);

    const emitEvent = config.emitEvent as any;
    const receivedCalls = emitEvent.mock.calls.filter((c: any[]) => c[0] === 'nft:received');
    expect(receivedCalls).toHaveLength(0);
    expect(module.getNFTs()).toHaveLength(0);
  });

  // UT-EVT-004: incoming transfer — parse error logged but not thrown
  it('UT-EVT-004: malformed NFT tokenData is logged but does not throw', async () => {
    await setup();

    const malformedToken = makeMalformedNFTUiToken();
    const transfer = makeIncomingTransfer([malformedToken]);

    const onCalls = (config.on as any).mock.calls;
    const incomingCall = onCalls.find((c: any[]) => c[0] === 'transfer:incoming');

    // Should not throw
    expect(() => incomingCall[1](transfer)).not.toThrow();

    // No nft:received emitted
    const emitEvent = config.emitEvent as any;
    const receivedCalls = emitEvent.mock.calls.filter((c: any[]) => c[0] === 'nft:received');
    expect(receivedCalls).toHaveLength(0);
  });

  // UT-EVT-005: incoming transfer — multiple NFTs in one transfer
  it('UT-EVT-005: emits nft:received for each NFT in a multi-NFT transfer', async () => {
    await setup();

    const nft1 = makeNFTUiToken({ metadata: createTestMetadata({ name: 'NFT-A' }) });
    const nft2 = makeNFTUiToken({ metadata: createTestMetadata({ name: 'NFT-B' }) });
    const nft3 = makeNFTUiToken({ metadata: createTestMetadata({ name: 'NFT-C' }) });
    const transfer = makeIncomingTransfer([nft1, nft2, nft3]);

    const onCalls = (config.on as any).mock.calls;
    const incomingCall = onCalls.find((c: any[]) => c[0] === 'transfer:incoming');
    incomingCall[1](transfer);

    const emitEvent = config.emitEvent as any;
    const receivedCalls = emitEvent.mock.calls.filter((c: any[]) => c[0] === 'nft:received');
    expect(receivedCalls).toHaveLength(3);

    const names = receivedCalls.map((c: any[]) => c[1].name).sort();
    expect(names).toEqual(['NFT-A', 'NFT-B', 'NFT-C']);

    expect(module.getNFTs()).toHaveLength(3);
  });

  // UT-EVT-006: incoming transfer — unknown collection auto-registered
  it('UT-EVT-006: auto-registers unknown collection from received NFT', async () => {
    await setup();

    const unknownCollectionId = 'ff'.repeat(32);
    const nftToken = makeNFTUiToken({ collectionId: unknownCollectionId });
    const transfer = makeIncomingTransfer([nftToken]);

    const onCalls = (config.on as any).mock.calls;
    const incomingCall = onCalls.find((c: any[]) => c[0] === 'transfer:incoming');
    incomingCall[1](transfer);

    // Unknown collection should be available
    const collections = module.getCollections();
    const found = collections.find(c => c.collectionId === unknownCollectionId);
    expect(found).toBeDefined();
    expect(found!.isCreator).toBe(false);
    expect(found!.tokenCount).toBe(1);
  });

  // UT-EVT-008: error in one NFT doesn't block processing of others
  it('UT-EVT-008: error in 2nd NFT does not block 1st and 3rd', async () => {
    await setup();

    const nft1 = makeNFTUiToken({ metadata: createTestMetadata({ name: 'Good-1' }) });
    const malformed = makeMalformedNFTUiToken();
    const nft3 = makeNFTUiToken({ metadata: createTestMetadata({ name: 'Good-3' }) });
    const transfer = makeIncomingTransfer([nft1, malformed, nft3]);

    const onCalls = (config.on as any).mock.calls;
    const incomingCall = onCalls.find((c: any[]) => c[0] === 'transfer:incoming');

    // Should not throw
    expect(() => incomingCall[1](transfer)).not.toThrow();

    // 2 valid NFTs in index
    expect(module.getNFTs()).toHaveLength(2);

    // 2 nft:received events (not 3)
    const emitEvent = config.emitEvent as any;
    const receivedCalls = emitEvent.mock.calls.filter((c: any[]) => c[0] === 'nft:received');
    expect(receivedCalls).toHaveLength(2);
  });
});
