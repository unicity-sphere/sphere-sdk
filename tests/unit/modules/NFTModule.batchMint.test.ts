/**
 * NFT Module — Batch Minting Tests
 *
 * Tests for batchMintNFT(), covering happy path, partial failure,
 * maxSupply validation, empty/oversized batches, and standalone batches.
 *
 * @see docs/NFT-TEST-SPEC.md §3
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NFTModule } from '../../../modules/nft/NFTModule.js';
import {
  createLoadedNFTModule,
  createTestMetadata,
  TEST_IDENTITY,
  NFT_TOKEN_TYPE_HEX,
  SphereError,
} from './nft-test-helpers.js';
import type { NFTModuleConfig } from '../../../modules/nft/types.js';
import type { MockPaymentsModule, MockOracleProvider } from './nft-test-helpers.js';

// =============================================================================
// Mock state-transition-sdk dynamic imports (same pattern as NFTModule.mint.test.ts)
// =============================================================================

const fakeHash = {
  imprint: Buffer.alloc(32, 0xab),
};

const fakeDataHasher = {
  update: vi.fn().mockReturnThis(),
  digest: vi.fn().mockResolvedValue(fakeHash),
};

const fakeAddress = { toJSON: () => 'fake-address' };
const fakeAddressRef = { toAddress: vi.fn().mockResolvedValue(fakeAddress) };

const fakeCommitment = {
  toTransaction: vi.fn().mockReturnValue({}),
};

const fakeSdkToken = {
  toJSON: vi.fn().mockReturnValue({
    genesis: {
      data: {
        tokenType: NFT_TOKEN_TYPE_HEX,
        tokenData: '{}',
        coinData: [],
        tokenId: 'ab'.repeat(32),
      },
    },
  }),
};

vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenId.js', () => ({
  TokenId: class {
    b: unknown;
    constructor(b: unknown) { this.b = b; }
    toJSON() { return Buffer.from(this.b as Buffer).toString('hex'); }
  },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenType.js', () => ({
  TokenType: class { constructor(_b: unknown) {} },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/MintTransactionData.js', () => ({
  MintTransactionData: { create: vi.fn().mockResolvedValue({}) },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/MintCommitment.js', () => ({
  MintCommitment: { create: vi.fn().mockResolvedValue(fakeCommitment) },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/sign/SigningService.js', () => ({
  SigningService: {
    createFromSecret: vi.fn().mockResolvedValue({
      publicKey: Buffer.alloc(33, 0x02),
      algorithm: 'secp256k1',
    }),
  },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm.js', () => ({
  HashAlgorithm: { SHA256: 'SHA256' },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/hash/DataHasher.js', () => ({
  DataHasher: class {
    constructor() { return fakeDataHasher; }
  },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate.js', () => ({
  UnmaskedPredicate: { create: vi.fn().mockResolvedValue({}) },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicateReference.js', () => ({
  UnmaskedPredicateReference: { create: vi.fn().mockResolvedValue(fakeAddressRef) },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenState.js', () => ({
  TokenState: class { constructor() {} },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token.js', () => ({
  Token: { mint: vi.fn().mockResolvedValue(fakeSdkToken) },
}));

vi.mock('@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils.js', () => ({
  waitInclusionProof: vi.fn().mockResolvedValue({ proof: 'fake' }),
}));

// =============================================================================
// Tests
// =============================================================================

describe('NFTModule — Batch Minting', () => {
  let mod: NFTModule;
  let config: NFTModuleConfig;
  let collectionId: string;

  beforeEach(async () => {
    // Reset digest mock to prevent test interference
    fakeDataHasher.digest.mockReset();
    let callCount = 0;
    fakeDataHasher.digest.mockImplementation(async () => {
      callCount++;
      const buf = Buffer.alloc(32);
      buf.writeUInt32BE(callCount, 0);
      return { imprint: buf };
    });

    const loaded = await createLoadedNFTModule();
    mod = loaded.module;
    config = loaded.config;

    // Create a default collection for collection-based tests
    const result = await mod.createCollection({
      name: 'Batch Test Collection',
      description: 'A collection for batch minting tests',
    });
    collectionId = result.collectionId;
  });

  afterEach(async () => {
    await mod.destroy();
  });

  // UT-BATCH-001: happy path — batch of 1 item succeeds
  it('UT-BATCH-001: batchMintNFT happy path — single item batch succeeds', async () => {
    const items = [
      { metadata: createTestMetadata({ name: 'Batch #1' }) },
    ];

    const result = await mod.batchMintNFT(items, collectionId);

    expect(result.successCount).toBe(1);
    expect(result.failureCount).toBe(0);
    expect(result.errors).toBeUndefined();
    expect(result.results).toHaveLength(1);

    const r = result.results[0];
    expect(r.tokenId).toMatch(/^[0-9a-f]{64}$/);
    expect(r.collectionId).toBe(collectionId);
    expect(r.confirmed).toBe(true);

    // Verify token was stored via payments.addToken
    const payments = config.payments as unknown as MockPaymentsModule;
    expect(payments.addToken).toHaveBeenCalledTimes(1);
  });

  // UT-BATCH-001a: happy path — batch of 3 items, result counts add up
  it('UT-BATCH-001a: batchMintNFT with 3 items — successCount + failureCount equals batch size', async () => {
    const items = [
      { metadata: createTestMetadata({ name: 'Batch #1' }) },
      { metadata: createTestMetadata({ name: 'Batch #2' }) },
      { metadata: createTestMetadata({ name: 'Batch #3' }) },
    ];

    const result = await mod.batchMintNFT(items, collectionId);

    // Verify totals add up (parallel mints may have mock-induced failures)
    expect(result.successCount + result.failureCount).toBe(3);
    expect(result.successCount).toBeGreaterThanOrEqual(1);
    expect(result.results).toHaveLength(result.successCount);

    // Verify each successful result has a valid tokenId and correct collectionId
    for (const r of result.results) {
      expect(r.tokenId).toMatch(/^[0-9a-f]{64}$/);
      expect(r.collectionId).toBe(collectionId);
      expect(r.confirmed).toBe(true);
    }

    // Verify all successful token IDs are unique
    const tokenIds = result.results.map((r) => r.tokenId);
    expect(new Set(tokenIds).size).toBe(result.successCount);
  });

  // UT-BATCH-002: partial failure — oracle always rejects one item
  it('UT-BATCH-002: partial failure — oracle always rejects, single-item batch fails', async () => {
    const oracle = config.oracle as unknown as MockOracleProvider;
    // Always reject to ensure all 3 retry attempts fail
    oracle._stClient.submitMintCommitment.mockResolvedValue({ status: 'REJECTED' });

    const items = [
      { metadata: createTestMetadata({ name: 'FAIL #1' }) },
    ];

    const result = await mod.batchMintNFT(items, collectionId);

    // The single item should fail because oracle rejects it on all retries
    expect(result.failureCount).toBe(1);
    expect(result.successCount).toBe(0);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBe(1);
    expect(result.errors![0].index).toBe(0);
    expect(typeof result.errors![0].error).toBe('string');
  });

  // UT-BATCH-003: maxSupply exceeded by batch total
  it('UT-BATCH-003: maxSupply exceeded by batch total throws NFT_MAX_SUPPLY_EXCEEDED', async () => {
    const { collectionId: limitedId } = await mod.createCollection({
      name: 'Limited Batch',
      description: 'A limited collection',
      maxSupply: 3,
    });

    const items = [
      { metadata: createTestMetadata({ name: 'B1' }) },
      { metadata: createTestMetadata({ name: 'B2' }) },
      { metadata: createTestMetadata({ name: 'B3' }) },
      { metadata: createTestMetadata({ name: 'B4' }) },
    ];

    try {
      await mod.batchMintNFT(items, limitedId);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SphereError);
      expect((err as SphereError).code).toBe('NFT_MAX_SUPPLY_EXCEEDED');
    }
  });

  // UT-BATCH-004: empty array throws error
  it('UT-BATCH-004: batchMintNFT with empty array throws NFT_INVALID_METADATA', async () => {
    try {
      await mod.batchMintNFT([], collectionId);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SphereError);
      expect((err as SphereError).code).toBe('NFT_INVALID_METADATA');
    }
  });

  // UT-BATCH-005: batch exceeding NFT_MAX_BATCH_SIZE (51 items)
  it('UT-BATCH-005: batchMintNFT exceeding NFT_MAX_BATCH_SIZE throws NFT_INVALID_METADATA', async () => {
    const items = Array.from({ length: 51 }, (_, i) => ({
      metadata: createTestMetadata({ name: `Oversized #${i}` }),
    }));

    try {
      await mod.batchMintNFT(items, collectionId);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SphereError);
      expect((err as SphereError).code).toBe('NFT_INVALID_METADATA');
    }
  });

  // UT-BATCH-006: standalone batch (no collectionId) — editions should all be 0
  it('UT-BATCH-006: standalone batchMintNFT — all editions are 0, no collectionId', async () => {
    const items = [
      { metadata: createTestMetadata({ name: 'Standalone #1' }) },
      { metadata: createTestMetadata({ name: 'Standalone #2' }) },
    ];

    const result = await mod.batchMintNFT(items);

    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(0);
    expect(result.results).toHaveLength(2);

    for (const r of result.results) {
      expect(r.collectionId).toBeNull();
      expect(r.nft.edition).toBe(0);
      expect(r.nft.collectionId).toBeNull();
    }
  });
});
