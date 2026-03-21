/**
 * NFT Module — Query Tests
 *
 * Tests for getNFTs(), getNFT(), getCollectionNFTs() — filtering, sorting,
 * pagination, and edge cases.
 *
 * @see docs/NFT-TEST-SPEC.md §5
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NFTModule } from '../../../modules/nft/NFTModule.js';
import {
  createLoadedNFTModule,
  createTestMetadata,
  createNFTTxfToken,
  NFT_TOKEN_TYPE_HEX,
} from './nft-test-helpers.js';
import type { NFTModuleConfig } from '../../../modules/nft/types.js';
import type { MockPaymentsModule } from './nft-test-helpers.js';
import type { Token } from '../../../types/index.js';

/**
 * Helper: add an NFT token to the payments mock and rebuild the module index
 * by destroying and reloading.
 */
function addNFTTokenToPayments(
  payments: MockPaymentsModule,
  opts: {
    name: string;
    collectionId?: string | null;
    edition?: number;
    mintedAt?: number;
    status?: 'confirmed' | 'pending';
  },
): string {
  const txf = createNFTTxfToken({
    collectionId: opts.collectionId ?? null,
    metadata: createTestMetadata({ name: opts.name }),
    edition: opts.edition ?? 0,
    mintedAt: opts.mintedAt ?? Date.now(),
  });

  const uiToken: Token = {
    id: txf.tokenId,
    coinId: NFT_TOKEN_TYPE_HEX,
    symbol: 'NFT',
    name: opts.name,
    decimals: 0,
    amount: '1',
    status: opts.status ?? 'confirmed',
    createdAt: opts.mintedAt ?? Date.now(),
    updatedAt: Date.now(),
    sdkData: JSON.stringify(txf),
  };

  payments._tokens.push(uiToken);
  return txf.tokenId;
}

describe('NFTModule — Queries', () => {
  let mod: NFTModule;
  let config: NFTModuleConfig;
  let payments: MockPaymentsModule;
  let colA: string;
  let colB: string;

  /**
   * Reload the module to rebuild the NFT index from current payments._tokens.
   */
  async function reloadModule(): Promise<void> {
    if (mod) {
      try { await mod.destroy(); } catch { /* ignore */ }
    }
    mod = new NFTModule();
    await mod.load(config);
  }

  beforeEach(async () => {
    const loaded = await createLoadedNFTModule();
    mod = loaded.module;
    config = loaded.config;
    payments = config.payments as unknown as MockPaymentsModule;

    // Create two collections
    const rA = await mod.createCollection({ name: 'Collection A', description: 'First' });
    colA = rA.collectionId;
    const rB = await mod.createCollection({ name: 'Collection B', description: 'Second' });
    colB = rB.collectionId;
  });

  afterEach(async () => {
    await mod.destroy();
  });

  // UT-QUERY-004: returns all NFTs from index
  it('UT-QUERY-004: getNFTs returns all NFTs', async () => {
    addNFTTokenToPayments(payments, { name: 'NFT 1', collectionId: colA });
    addNFTTokenToPayments(payments, { name: 'NFT 2', collectionId: colA });
    addNFTTokenToPayments(payments, { name: 'NFT 3', collectionId: colB });
    addNFTTokenToPayments(payments, { name: 'NFT 4', collectionId: colB });
    addNFTTokenToPayments(payments, { name: 'NFT 5', collectionId: null });
    await reloadModule();

    // Re-create collections after reload
    await mod.createCollection({ name: 'Collection A', description: 'First' });
    await mod.createCollection({ name: 'Collection B', description: 'Second' });

    const nfts = mod.getNFTs();
    expect(nfts).toHaveLength(5);
  });

  // UT-QUERY-005: filter by collectionId
  it('UT-QUERY-005: getNFTs filters by collectionId', async () => {
    addNFTTokenToPayments(payments, { name: 'A1', collectionId: colA });
    addNFTTokenToPayments(payments, { name: 'A2', collectionId: colA });
    addNFTTokenToPayments(payments, { name: 'A3', collectionId: colA });
    addNFTTokenToPayments(payments, { name: 'B1', collectionId: colB });
    addNFTTokenToPayments(payments, { name: 'B2', collectionId: colB });
    await reloadModule();
    await mod.createCollection({ name: 'Collection A', description: 'First' });
    await mod.createCollection({ name: 'Collection B', description: 'Second' });

    const nftsA = mod.getNFTs({ collectionId: colA });
    expect(nftsA).toHaveLength(3);
    expect(nftsA.every((n) => n.collectionId === colA)).toBe(true);

    const nftsB = mod.getNFTs({ collectionId: colB });
    expect(nftsB).toHaveLength(2);
  });

  // UT-QUERY-006: filter by status
  it('UT-QUERY-006: getNFTs filters by status', async () => {
    addNFTTokenToPayments(payments, { name: 'Confirmed 1', status: 'confirmed' });
    addNFTTokenToPayments(payments, { name: 'Confirmed 2', status: 'confirmed' });
    addNFTTokenToPayments(payments, { name: 'Confirmed 3', status: 'confirmed' });
    addNFTTokenToPayments(payments, { name: 'Pending 1', status: 'pending' });
    await reloadModule();

    const confirmed = mod.getNFTs({ status: 'confirmed' });
    expect(confirmed).toHaveLength(3);

    const pending = mod.getNFTs({ status: 'pending' });
    expect(pending).toHaveLength(1);
  });

  // UT-QUERY-008: sort by name ascending
  it('UT-QUERY-008: getNFTs sorts by name ascending', async () => {
    addNFTTokenToPayments(payments, { name: 'Zebra' });
    addNFTTokenToPayments(payments, { name: 'Alpha' });
    addNFTTokenToPayments(payments, { name: 'Middle' });
    await reloadModule();

    const nfts = mod.getNFTs({ sortBy: 'name', sortOrder: 'asc' });
    expect(nfts.map((n) => n.name)).toEqual(['Alpha', 'Middle', 'Zebra']);
  });

  // Sort by name descending
  it('getNFTs sorts by name descending', async () => {
    addNFTTokenToPayments(payments, { name: 'Zebra' });
    addNFTTokenToPayments(payments, { name: 'Alpha' });
    addNFTTokenToPayments(payments, { name: 'Middle' });
    await reloadModule();

    const nfts = mod.getNFTs({ sortBy: 'name', sortOrder: 'desc' });
    expect(nfts.map((n) => n.name)).toEqual(['Zebra', 'Middle', 'Alpha']);
  });

  // Sort by mintedAt
  it('getNFTs sorts by mintedAt descending', async () => {
    const t1 = 1000000;
    const t2 = 2000000;
    const t3 = 3000000;
    addNFTTokenToPayments(payments, { name: 'First', mintedAt: t1 });
    addNFTTokenToPayments(payments, { name: 'Second', mintedAt: t2 });
    addNFTTokenToPayments(payments, { name: 'Third', mintedAt: t3 });
    await reloadModule();

    const nfts = mod.getNFTs({ sortBy: 'mintedAt', sortOrder: 'desc' });
    expect(nfts.map((n) => n.name)).toEqual(['Third', 'Second', 'First']);
  });

  // UT-QUERY-010: pagination with offset/limit
  it('UT-QUERY-010: getNFTs paginates with offset and limit', async () => {
    for (let i = 0; i < 10; i++) {
      addNFTTokenToPayments(payments, { name: `NFT_${String(i).padStart(2, '0')}` });
    }
    await reloadModule();

    const page = mod.getNFTs({ sortBy: 'name', sortOrder: 'asc', offset: 3, limit: 4 });
    expect(page).toHaveLength(4);
    expect(page[0].name).toBe('NFT_03');
    expect(page[3].name).toBe('NFT_06');
  });

  // UT-QUERY-011: empty wallet
  it('UT-QUERY-011: getNFTs with empty wallet returns []', () => {
    const nfts = mod.getNFTs();
    expect(nfts).toEqual([]);
  });

  // UT-QUERY-012: getCollectionNFTs
  it('UT-QUERY-012: getCollectionNFTs returns only NFTs in the specified collection', async () => {
    addNFTTokenToPayments(payments, { name: 'InCol', collectionId: colA });
    addNFTTokenToPayments(payments, { name: 'InCol2', collectionId: colA });
    addNFTTokenToPayments(payments, { name: 'InCol3', collectionId: colA });
    addNFTTokenToPayments(payments, { name: 'Other', collectionId: colB });
    await reloadModule();
    await mod.createCollection({ name: 'Collection A', description: 'First' });
    await mod.createCollection({ name: 'Collection B', description: 'Second' });

    const colNfts = mod.getCollectionNFTs(colA);
    expect(colNfts).toHaveLength(3);
    expect(colNfts.every((n) => n.collectionId === colA)).toBe(true);
  });

  // getCollectionNFTs with unknown collection returns []
  it('getCollectionNFTs with unknown collection returns empty array', () => {
    const result = mod.getCollectionNFTs('f'.repeat(64));
    expect(result).toEqual([]);
  });
});
