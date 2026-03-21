/**
 * NFTModule — Import/Export tests (§6)
 *
 * Validates importNFT and exportNFT: token type check, metadata parsing,
 * idempotent import, collection registration, event emission, round-trip.
 *
 * @see docs/NFT-TEST-SPEC.md §6
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createMockNFTConfig,
  createTestMetadata,
  createNFTTxfToken,
  createFullNFTTxfToken,
  createFullFungibleTxfToken,
  createNFTToken,
  createMockPayments,
  createTestNFTTokenData,
  TEST_IDENTITY,
  NFT_TOKEN_TYPE_HEX,
  SphereError,
  createNFTModule,
  canonicalSerializeNFT,
} from './nft-test-helpers.js';
import type { NFTModuleConfig } from '../../../modules/nft/types.js';
import { NFTModule } from '../../../modules/nft/NFTModule.js';

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
// §6 Import / Export Tests
// =============================================================================

describe('NFTModule.importNFT', () => {
  // UT-IMP-001: importNFT — happy path
  it('UT-IMP-001: imports a valid NFT TxfToken, stores it, and adds to index', async () => {
    await setup();

    const collectionId = 'aa'.repeat(32);
    const txf = createFullNFTTxfToken({ collectionId, metadata: createTestMetadata({ name: 'Import Art' }) });
    const tokenId = txf.genesis.data.tokenId;

    const result = await module.importNFT(txf);

    // Verify NFTRef returned
    expect(result).toBeDefined();
    expect(result.tokenId).toBe(tokenId);
    expect(result.name).toBe('Import Art');
    expect(result.collectionId).toBe(collectionId);
    expect(result.confirmed).toBe(true);

    // Verify token is stored (addToken called on payments)
    const payments = config.payments as any;
    expect(payments.addToken).toHaveBeenCalledTimes(1);
    const storedToken = payments.addToken.mock.calls[0][0];
    expect(storedToken.id).toBe(tokenId);
    expect(storedToken.coinId).toBe(NFT_TOKEN_TYPE_HEX);

    // Verify indexed — getNFTs returns it
    const nfts = module.getNFTs();
    expect(nfts).toHaveLength(1);
    expect(nfts[0].tokenId).toBe(tokenId);
  });

  // UT-IMP-002: importNFT — wrong token type
  it('UT-IMP-002: throws NFT_WRONG_TOKEN_TYPE for non-NFT token', async () => {
    await setup();

    const txf = createFullFungibleTxfToken();

    await expect(module.importNFT(txf)).rejects.toThrow(SphereError);
    await expect(module.importNFT(txf)).rejects.toMatchObject({ code: 'NFT_WRONG_TOKEN_TYPE' });
  });

  // UT-IMP-003: importNFT — invalid tokenData (parse error)
  it('UT-IMP-003: throws NFT_PARSE_ERROR for garbage tokenData', async () => {
    await setup();

    const txf = createFullNFTTxfToken();
    // Corrupt the tokenData
    txf.genesis.data.tokenData = 'not-valid-json{{{';

    await expect(module.importNFT(txf)).rejects.toThrow(SphereError);
    await expect(module.importNFT(txf)).rejects.toMatchObject({ code: 'NFT_PARSE_ERROR' });
  });

  // UT-IMP-004: importNFT — idempotent (duplicate token ID)
  it('UT-IMP-004: returns existing NFTRef without error on duplicate import', async () => {
    await setup();

    const txf = createFullNFTTxfToken({ metadata: createTestMetadata({ name: 'DupNFT' }) });

    const result1 = await module.importNFT(txf);
    const result2 = await module.importNFT(txf);

    expect(result1.tokenId).toBe(result2.tokenId);
    expect(result1.name).toBe(result2.name);

    // addToken should only be called once (first import)
    const payments = config.payments as any;
    expect(payments.addToken).toHaveBeenCalledTimes(1);

    // Index still has 1 entry
    expect(module.getNFTs()).toHaveLength(1);
  });

  // UT-IMP-005: importNFT — registers unknown collection
  it('UT-IMP-005: creates synthetic CollectionRef for unknown collection', async () => {
    await setup();

    const unknownCollectionId = 'dd'.repeat(32);
    const txf = createFullNFTTxfToken({ collectionId: unknownCollectionId });

    await module.importNFT(txf);

    // The unknown collection should appear in getCollections
    const collections = module.getCollections();
    const found = collections.find(c => c.collectionId === unknownCollectionId);
    expect(found).toBeDefined();
    expect(found!.isCreator).toBe(false);
    expect(found!.tokenCount).toBe(1);
  });

  // UT-IMP-006: importNFT — emits nft:imported event
  it('UT-IMP-006: emits nft:imported event with correct payload', async () => {
    await setup();

    const collectionId = 'ee'.repeat(32);
    const txf = createFullNFTTxfToken({
      collectionId,
      metadata: createTestMetadata({ name: 'EventNFT' }),
    });
    const tokenId = txf.genesis.data.tokenId;

    await module.importNFT(txf);

    const emitEvent = config.emitEvent as any;
    const importCalls = emitEvent.mock.calls.filter((c: any[]) => c[0] === 'nft:imported');
    expect(importCalls).toHaveLength(1);
    expect(importCalls[0][1]).toEqual({
      tokenId,
      collectionId,
      name: 'EventNFT',
    });
  });
});

describe('NFTModule.exportNFT', () => {
  // UT-EXP-001: exportNFT — happy path
  it('UT-EXP-001: returns complete TxfToken for existing NFT', async () => {
    await setup();

    // First import an NFT so it exists
    const txf = createFullNFTTxfToken({ metadata: createTestMetadata({ name: 'ExportMe' }) });
    const tokenId = txf.genesis.data.tokenId;

    await module.importNFT(txf);

    // Set up payments.getTokens to return the stored token
    const payments = config.payments as any;
    payments._tokens.push({
      id: tokenId,
      coinId: NFT_TOKEN_TYPE_HEX,
      symbol: 'NFT',
      name: 'ExportMe',
      decimals: 0,
      amount: '1',
      status: 'confirmed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData: JSON.stringify(txf),
    });

    const exported = await module.exportNFT(tokenId);
    expect(exported).not.toBeNull();
    expect(exported!.genesis.data.tokenType).toBe(NFT_TOKEN_TYPE_HEX);
    expect(exported!.genesis.data.tokenId).toBe(tokenId);
  });

  // UT-EXP-002: exportNFT — unknown token
  it('UT-EXP-002: returns null for unknown tokenId', async () => {
    await setup();

    const result = await module.exportNFT('ff'.repeat(32));
    expect(result).toBeNull();
  });

  // UT-EXP-004: round-trip import then export
  it('UT-EXP-004: round-trip import→export preserves token data', async () => {
    await setup();

    const nftData = createTestNFTTokenData({
      collectionId: 'cc'.repeat(32),
      metadata: createTestMetadata({ name: 'RoundTrip' }),
    });
    const txf = createFullNFTTxfToken(nftData);
    const tokenId = txf.genesis.data.tokenId;

    await module.importNFT(txf);

    // Set up payments.getTokens to return the stored token
    const payments = config.payments as any;
    payments._tokens.push({
      id: tokenId,
      coinId: NFT_TOKEN_TYPE_HEX,
      symbol: 'NFT',
      name: 'RoundTrip',
      decimals: 0,
      amount: '1',
      status: 'confirmed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData: JSON.stringify(txf),
    });

    const exported = await module.exportNFT(tokenId);
    expect(exported).not.toBeNull();

    // Verify structural match
    expect(exported!.genesis.data.tokenId).toBe(txf.genesis.data.tokenId);
    expect(exported!.genesis.data.tokenType).toBe(txf.genesis.data.tokenType);
    expect(exported!.genesis.data.tokenData).toBe(txf.genesis.data.tokenData);
  });
});
