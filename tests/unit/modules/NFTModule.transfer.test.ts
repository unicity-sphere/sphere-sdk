/**
 * NFT Module — Transfer Tests
 *
 * Tests for sendNFT(), covering happy path, validation, atomicity flags,
 * event emission, collection constraints, and token count updates.
 *
 * @see docs/NFT-TEST-SPEC.md §4
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NFTModule } from '../../../modules/nft/NFTModule.js';
import {
  createMockNFTConfig,
  createLoadedNFTModule,
  createTestMetadata,
  createNFTToken,
  createNFTTxfToken,
  TEST_IDENTITY,
  NFT_TOKEN_TYPE_HEX,
  SphereError,
} from './nft-test-helpers.js';
import type { NFTModuleConfig, NFTRef } from '../../../modules/nft/types.js';
import type { MockPaymentsModule } from './nft-test-helpers.js';
import type { Token } from '../../../types/index.js';

describe('NFTModule — Transfer', () => {
  let mod: NFTModule;
  let config: NFTModuleConfig;
  let collectionId: string;
  let nftRef: NFTRef;
  let nftTokenId: string;

  beforeEach(async () => {
    const loaded = await createLoadedNFTModule();
    mod = loaded.module;
    config = loaded.config;

    // Create a collection
    const colResult = await mod.createCollection({
      name: 'Transfer Test Collection',
      description: 'Collection for transfer tests',
    });
    collectionId = colResult.collectionId;

    // Pre-populate an NFT in the index by creating a token and indexing it
    // We simulate having an NFT in the wallet by adding it to payments._tokens
    // and re-loading, but it's simpler to manipulate the index directly.
    // Instead we'll use importNFT to get an NFT into the wallet.
    const nftTxf = createNFTTxfToken({
      collectionId,
      metadata: createTestMetadata({ name: 'Transferable Art' }),
      edition: 1,
    });

    // Create a UI token that has the NFT data
    const uiToken: Token = {
      id: nftTxf.tokenId,
      coinId: NFT_TOKEN_TYPE_HEX,
      symbol: 'NFT',
      name: 'Transferable Art',
      decimals: 0,
      amount: '1',
      status: 'confirmed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData: JSON.stringify(nftTxf),
    };

    // Add to payments mock tokens so the module can find it
    const payments = config.payments as unknown as MockPaymentsModule;
    payments._tokens.push(uiToken);

    // Build the NFT index entry directly via the module's internal method
    // We need to reload the module to pick up the new token
    await mod.destroy();
    mod = new NFTModule();
    await mod.load(config);

    // Re-create collection (needed after reload since registry was cleared)
    await mod.createCollection({
      name: 'Transfer Test Collection',
      description: 'Collection for transfer tests',
    });

    // Verify the NFT was indexed
    const nfts = mod.getNFTs();
    const found = nfts.find((n) => n.tokenId === nftTxf.tokenId);
    if (!found) {
      throw new Error('Test setup failed: NFT not found in index after reload');
    }
    nftRef = found;
    nftTokenId = nftTxf.tokenId;
  });

  afterEach(async () => {
    await mod.destroy();
  });

  // UT-XFER-001: happy path
  it('UT-XFER-001: sendNFT happy path — payments.send called with correct params', async () => {
    const payments = config.payments as unknown as MockPaymentsModule;
    const result = await mod.sendNFT(nftTokenId, '@bob');

    expect(result.status).toBe('completed');
    expect(payments.send).toHaveBeenCalledTimes(1);

    const sendCall = payments.send.mock.calls[0][0];
    expect(sendCall.recipient).toBe('@bob');
    expect(sendCall.coinId).toBe(nftTokenId);
    expect(sendCall._nftTransfer).toBe(true);
    expect(sendCall._tokenIds).toEqual([nftTokenId]);

    // NFT should be removed from index
    const nfts = mod.getNFTs();
    expect(nfts.find((n) => n.tokenId === nftTokenId)).toBeUndefined();
  });

  // UT-XFER-002: emits nft:transferred event
  it('UT-XFER-002: sendNFT emits nft:transferred event', async () => {
    await mod.sendNFT(nftTokenId, '@bob');

    expect(config.emitEvent).toHaveBeenCalledWith('nft:transferred', expect.objectContaining({
      tokenId: nftTokenId,
      collectionId,
      recipientPubkey: '@bob',
    }));
  });

  // UT-XFER-003: NFT not found
  it('UT-XFER-003: sendNFT with unknown tokenId throws NFT_NOT_FOUND', async () => {
    try {
      await mod.sendNFT('nonexistent' + '0'.repeat(55), '@bob');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SphereError);
      expect((err as SphereError).code).toBe('NFT_NOT_FOUND');
    }
  });

  // UT-XFER-004: non-transferable collection
  it('UT-XFER-004: sendNFT on non-transferable collection throws NFT_NOT_TRANSFERABLE', async () => {
    // Create a soulbound collection
    const { collectionId: soulboundId } = await mod.createCollection({
      name: 'Soulbound',
      description: 'Non-transferable',
      transferable: false,
    });

    // Add a soulbound NFT to the index
    const soulTxf = createNFTTxfToken({
      collectionId: soulboundId,
      metadata: createTestMetadata({ name: 'Soulbound NFT' }),
      edition: 1,
    });

    const soulToken: Token = {
      id: soulTxf.tokenId,
      coinId: NFT_TOKEN_TYPE_HEX,
      symbol: 'NFT',
      name: 'Soulbound NFT',
      decimals: 0,
      amount: '1',
      status: 'confirmed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData: JSON.stringify(soulTxf),
    };

    const payments = config.payments as unknown as MockPaymentsModule;
    payments._tokens.push(soulToken);

    // Reload to pick up the new token
    await mod.destroy();
    mod = new NFTModule();
    await mod.load(config);

    // Re-create collections
    await mod.createCollection({
      name: 'Soulbound',
      description: 'Non-transferable',
      transferable: false,
    });

    const nfts = mod.getNFTs();
    const soulNft = nfts.find((n) => n.tokenId === soulTxf.tokenId);
    expect(soulNft).toBeDefined();

    try {
      await mod.sendNFT(soulTxf.tokenId, '@bob');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SphereError);
      expect((err as SphereError).code).toBe('NFT_NOT_TRANSFERABLE');
    }
  });

  // UT-XFER-007: with memo
  it('UT-XFER-007: sendNFT passes memo to payments.send', async () => {
    const payments = config.payments as unknown as MockPaymentsModule;
    await mod.sendNFT(nftTokenId, '@bob', 'Gift for you');

    const sendCall = payments.send.mock.calls[0][0];
    expect(sendCall.memo).toBe('Gift for you');
  });

  // UT-XFER-008: NFT atomicity (no splitting)
  it('UT-XFER-008: sendNFT sets _nftTransfer and _tokenIds for atomic transfer', async () => {
    const payments = config.payments as unknown as MockPaymentsModule;
    await mod.sendNFT(nftTokenId, '@bob');

    const sendCall = payments.send.mock.calls[0][0];
    expect(sendCall._nftTransfer).toBe(true);
    expect(sendCall._tokenIds).toEqual([nftTokenId]);
    expect(sendCall.amount).toBe('1');
  });

  // UT-XFER-010: updates collection tokenCount
  it('UT-XFER-010: sendNFT decrements collection tokenCount', async () => {
    // Check initial count
    const colBefore = mod.getCollection(collectionId);
    const countBefore = colBefore?.tokenCount ?? 0;
    expect(countBefore).toBeGreaterThanOrEqual(1);

    await mod.sendNFT(nftTokenId, '@bob');

    const colAfter = mod.getCollection(collectionId);
    expect(colAfter!.tokenCount).toBe(countBefore - 1);
  });

  // UT-XFER-006: send failure propagated
  it('UT-XFER-006: sendNFT propagates payment send failure', async () => {
    const payments = config.payments as unknown as MockPaymentsModule;
    payments._sendResult = {
      id: 'failed-transfer',
      status: 'failed',
      tokens: [],
      tokenTransfers: [],
      error: 'Network error',
    };

    const result = await mod.sendNFT(nftTokenId, '@bob');
    expect(result.status).toBe('failed');

    // NFT should still be in index since transfer failed
    const nfts = mod.getNFTs();
    expect(nfts.find((n) => n.tokenId === nftTokenId)).toBeDefined();
  });

  // UT-XFER-009: recipient resolution (various formats)
  it('UT-XFER-009: sendNFT passes recipient as-is to payments.send', async () => {
    const payments = config.payments as unknown as MockPaymentsModule;

    // Test with DIRECT:// format
    await mod.sendNFT(nftTokenId, 'DIRECT://some_address');

    const sendCall = payments.send.mock.calls[0][0];
    expect(sendCall.recipient).toBe('DIRECT://some_address');
  });

  // UT-XFER-011: sequential sendNFT — second call fails after first succeeds
  it('UT-XFER-011: sequential sendNFT — second call after successful first fails with NFT_NOT_FOUND', async () => {
    // First transfer succeeds and removes the NFT from the index
    const result1 = await mod.sendNFT(nftTokenId, '@alice');
    expect(result1.status).toBe('completed');

    // Verify NFT was removed from index
    const nfts = mod.getNFTs();
    expect(nfts.find((n) => n.tokenId === nftTokenId)).toBeUndefined();

    // Second transfer for the same tokenId should fail with NFT_NOT_FOUND
    try {
      await mod.sendNFT(nftTokenId, '@charlie');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SphereError);
      expect((err as SphereError).code).toBe('NFT_NOT_FOUND');
    }
  });

  // UT-XFER-012: standalone NFT transfer (collectionId=null)
  it('UT-XFER-012: sendNFT for standalone NFT (collectionId=null) succeeds', async () => {
    // Add a standalone NFT (no collection)
    const standaloneTxf = createNFTTxfToken({
      collectionId: null,
      metadata: createTestMetadata({ name: 'Standalone Art' }),
      edition: 0,
    });

    const standaloneToken: Token = {
      id: standaloneTxf.tokenId,
      coinId: NFT_TOKEN_TYPE_HEX,
      symbol: 'NFT',
      name: 'Standalone Art',
      decimals: 0,
      amount: '1',
      status: 'confirmed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData: JSON.stringify(standaloneTxf),
    };

    const payments = config.payments as unknown as MockPaymentsModule;
    payments._tokens.push(standaloneToken);

    // Reload to pick up the new token
    await mod.destroy();
    mod = new NFTModule();
    await mod.load(config);

    // Verify standalone NFT was indexed
    const nfts = mod.getNFTs();
    const found = nfts.find((n) => n.tokenId === standaloneTxf.tokenId);
    expect(found).toBeDefined();
    expect(found!.collectionId).toBeNull();

    // Transfer should succeed (no collection means transferable by default)
    const result = await mod.sendNFT(standaloneTxf.tokenId, '@bob');
    expect(result.status).toBe('completed');

    // Verify the send call used the tokenId as coinId
    const sendCall = payments.send.mock.calls[0][0];
    expect(sendCall.coinId).toBe(standaloneTxf.tokenId);
    expect(sendCall._nftTransfer).toBe(true);

    // NFT should be removed from index
    const nftsAfter = mod.getNFTs();
    expect(nftsAfter.find((n) => n.tokenId === standaloneTxf.tokenId)).toBeUndefined();
  });
});
