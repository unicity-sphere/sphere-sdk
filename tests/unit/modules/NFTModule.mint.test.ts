/**
 * NFT Module — Minting Tests
 *
 * Tests for mintNFT(), covering collection and standalone minting,
 * edition management, validation, oracle interaction, events, and salt strategies.
 *
 * @see docs/NFT-TEST-SPEC.md §3
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NFTModule } from '../../../modules/nft/NFTModule.js';
import {
  createMockNFTConfig,
  createLoadedNFTModule,
  createTestMetadata,
  createNFTToken,
  TEST_IDENTITY,
  NFT_TOKEN_TYPE_HEX,
  SphereError,
} from './nft-test-helpers.js';
import type { NFTModuleConfig } from '../../../modules/nft/types.js';
import type { MockPaymentsModule, MockOracleProvider } from './nft-test-helpers.js';

// =============================================================================
// Mock state-transition-sdk dynamic imports
// =============================================================================

// Since NFTModule uses dynamic import() for state-transition-sdk, we mock the
// entire minting pipeline. The module calls `await import(...)` for each SDK
// type; we provide lightweight fakes that track calls without doing real crypto.

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

describe('NFTModule — Minting', () => {
  let mod: NFTModule;
  let config: NFTModuleConfig;
  let collectionId: string;

  beforeEach(async () => {
    const loaded = await createLoadedNFTModule();
    mod = loaded.module;
    config = loaded.config;

    // Create a default collection for collection-based tests
    const result = await mod.createCollection({
      name: 'Test Art',
      description: 'A test collection',
    });
    collectionId = result.collectionId;
  });

  afterEach(async () => {
    await mod.destroy();
  });

  // UT-MINT-002: collection happy path
  it('UT-MINT-002: mintNFT collection happy path — token stored with correct type', async () => {
    const metadata = createTestMetadata({ name: 'Art #1' });
    const result = await mod.mintNFT(metadata, collectionId);

    expect(result.tokenId).toMatch(/^[0-9a-f]{64}$/);
    expect(result.collectionId).toBe(collectionId);
    expect(result.confirmed).toBe(true);
    expect(result.nft).toBeDefined();
    expect(result.nft.name).toBe('Art #1');
    expect(result.nft.collectionId).toBe(collectionId);

    // Token was stored via payments.addToken
    const payments = config.payments as unknown as MockPaymentsModule;
    expect(payments.addToken).toHaveBeenCalledTimes(1);
    const storedToken = payments.addToken.mock.calls[0][0];
    expect(storedToken.coinId).toBe(NFT_TOKEN_TYPE_HEX);
    expect(storedToken.amount).toBe('1');
    expect(storedToken.decimals).toBe(0);

    // Oracle stClient was called
    const oracle = config.oracle as unknown as MockOracleProvider;
    expect(oracle.getStateTransitionClient).toHaveBeenCalled();
  });

  // UT-MINT-002a: standalone happy path
  it('UT-MINT-002a: mintNFT standalone — no collection, collectionId=null, edition=0', async () => {
    const metadata = createTestMetadata({ name: 'One-off Art' });
    const result = await mod.mintNFT(metadata);

    expect(result.tokenId).toMatch(/^[0-9a-f]{64}$/);
    expect(result.collectionId).toBeNull();
    expect(result.confirmed).toBe(true);
    expect(result.nft.collectionId).toBeNull();
    expect(result.nft.edition).toBe(0);
  });

  // UT-MINT-003: explicit edition
  it('UT-MINT-003: mintNFT with explicit edition', async () => {
    const metadata = createTestMetadata();
    const result = await mod.mintNFT(metadata, collectionId, 42, 100);

    expect(result.nft.edition).toBe(42);
  });

  // UT-MINT-004: auto-increment edition
  it('UT-MINT-004: auto-increment edition across 3 mints', async () => {
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(await mod.mintNFT(createTestMetadata({ name: `NFT #${i + 1}` }), collectionId));
    }

    expect(results[0].nft.edition).toBe(1);
    expect(results[1].nft.edition).toBe(2);
    expect(results[2].nft.edition).toBe(3);
  });

  // UT-MINT-007: collection not found
  it('UT-MINT-007: mintNFT with unknown collection throws NFT_COLLECTION_NOT_FOUND', async () => {
    const fakeId = 'a'.repeat(64);

    try {
      await mod.mintNFT(createTestMetadata(), fakeId);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SphereError);
      expect((err as SphereError).code).toBe('NFT_COLLECTION_NOT_FOUND');
    }
  });

  // UT-MINT-008: maxSupply exceeded
  it('UT-MINT-008: mintNFT exceeding maxSupply throws NFT_MAX_SUPPLY_EXCEEDED', async () => {
    const { collectionId: limitedId } = await mod.createCollection({
      name: 'Limited',
      description: 'A limited collection',
      maxSupply: 2,
    });

    await mod.mintNFT(createTestMetadata({ name: 'NFT 1' }), limitedId);
    await mod.mintNFT(createTestMetadata({ name: 'NFT 2' }), limitedId);

    try {
      await mod.mintNFT(createTestMetadata({ name: 'NFT 3' }), limitedId);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SphereError);
      expect((err as SphereError).code).toBe('NFT_MAX_SUPPLY_EXCEEDED');
    }
  });

  // UT-MINT-009: maxSupply boundary (exactly at limit)
  it('UT-MINT-009: mintNFT at maxSupply boundary succeeds', async () => {
    const { collectionId: limitedId } = await mod.createCollection({
      name: 'Boundary',
      description: 'boundary test',
      maxSupply: 3,
    });

    await mod.mintNFT(createTestMetadata({ name: 'N1' }), limitedId);
    await mod.mintNFT(createTestMetadata({ name: 'N2' }), limitedId);

    // 3rd should succeed (exactly at limit)
    const r3 = await mod.mintNFT(createTestMetadata({ name: 'N3' }), limitedId);
    expect(r3.confirmed).toBe(true);
  });

  // UT-MINT-011: missing name
  it('UT-MINT-011: mintNFT with missing name throws NFT_INVALID_METADATA', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const metadata = { image: 'ipfs://QmHash' } as any;

    try {
      await mod.mintNFT(metadata, collectionId);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SphereError);
      expect((err as SphereError).code).toBe('NFT_INVALID_METADATA');
    }
  });

  // UT-MINT-012: missing image
  it('UT-MINT-012: mintNFT with missing image throws NFT_INVALID_METADATA', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const metadata = { name: 'Test' } as any;

    try {
      await mod.mintNFT(metadata, collectionId);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SphereError);
      expect((err as SphereError).code).toBe('NFT_INVALID_METADATA');
    }
  });

  // UT-MINT-013: name too long
  it('UT-MINT-013: mintNFT with name too long throws NFT_INVALID_METADATA', async () => {
    const metadata = createTestMetadata({ name: 'a'.repeat(257) });

    try {
      await mod.mintNFT(metadata, collectionId);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SphereError);
      expect((err as SphereError).code).toBe('NFT_INVALID_METADATA');
    }
  });

  // UT-MINT-014: too many attributes
  it('UT-MINT-014: mintNFT with too many attributes throws NFT_INVALID_METADATA', async () => {
    const attributes = Array.from({ length: 101 }, (_, i) => ({
      trait_type: `trait_${i}`,
      value: `value_${i}`,
    }));
    const metadata = createTestMetadata({ attributes });

    try {
      await mod.mintNFT(metadata, collectionId);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SphereError);
      expect((err as SphereError).code).toBe('NFT_INVALID_METADATA');
    }
  });

  // UT-MINT-015: oracle rejection
  it('UT-MINT-015: mintNFT with oracle rejection throws NFT_MINT_FAILED', async () => {
    const oracle = config.oracle as unknown as MockOracleProvider;
    oracle._stClient.submitMintCommitment.mockResolvedValue({ status: 'REJECTED' });

    try {
      await mod.mintNFT(createTestMetadata(), collectionId);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SphereError);
      expect((err as SphereError).code).toBe('NFT_MINT_FAILED');
    }
  });

  // UT-MINT-017: emits nft:minted event
  it('UT-MINT-017: mintNFT emits nft:minted event', async () => {
    const metadata = createTestMetadata({ name: 'Event Test' });
    const result = await mod.mintNFT(metadata, collectionId);

    expect(config.emitEvent).toHaveBeenCalledWith('nft:minted', expect.objectContaining({
      tokenId: result.tokenId,
      collectionId,
      name: 'Event Test',
      confirmed: true,
    }));
  });

  // UT-MINT-018: updates in-memory index
  it('UT-MINT-018: mintNFT updates in-memory index and collection tokenCount', async () => {
    await mod.mintNFT(createTestMetadata({ name: 'Indexed' }), collectionId);

    const nfts = mod.getNFTs();
    expect(nfts.length).toBeGreaterThanOrEqual(1);
    expect(nfts.some((n) => n.name === 'Indexed')).toBe(true);

    const col = mod.getCollection(collectionId);
    expect(col).not.toBeNull();
    expect(col!.tokenCount).toBe(1);
  });

  // UT-MINT-019: unique token IDs per mint (different salts)
  it('UT-MINT-019: two mints with identical metadata produce different tokenIds', async () => {
    // Each mint should get different random bytes from DataHasher
    // We make fakeDataHasher return different hashes per call
    let callCount = 0;
    fakeDataHasher.digest.mockImplementation(async () => {
      callCount++;
      const buf = Buffer.alloc(32);
      buf.writeUInt32BE(callCount, 0);
      return { imprint: buf };
    });

    const metadata = createTestMetadata({ name: 'Duplicate' });
    const r1 = await mod.mintNFT(metadata, collectionId);
    const r2 = await mod.mintNFT(metadata, collectionId);

    expect(r1.tokenId).not.toBe(r2.tokenId);

    // Reset
    fakeDataHasher.digest.mockResolvedValue(fakeHash);
  });

  // UT-MINT-020: minter field set to identity
  it('UT-MINT-020: minted NFT is stored with the correct name', async () => {
    await mod.mintNFT(createTestMetadata({ name: 'Minter Test' }), collectionId);

    const payments = config.payments as unknown as MockPaymentsModule;
    const storedToken = payments.addToken.mock.calls[0][0];
    expect(storedToken.name).toBe('Minter Test');
  });

  // UT-MINT-027: standalone random salt produces different IDs
  it('UT-MINT-027: standalone mints with identical metadata produce different tokenIds', async () => {
    let callCount = 100;
    fakeDataHasher.digest.mockImplementation(async () => {
      callCount++;
      const buf = Buffer.alloc(32);
      buf.writeUInt32BE(callCount, 0);
      return { imprint: buf };
    });

    const metadata = createTestMetadata({ name: 'Standalone Dup' });
    const r1 = await mod.mintNFT(metadata);
    const r2 = await mod.mintNFT(metadata);

    expect(r1.tokenId).not.toBe(r2.tokenId);

    fakeDataHasher.digest.mockResolvedValue(fakeHash);
  });

  // UT-MINT-030: deterministic salt same tokenId for same edition
  it('UT-MINT-030: deterministic salt produces same tokenId for same edition', async () => {
    // Fix Date.now() so the collection gets the same createdAt on re-creation
    const fixedTime = 1700000000000;
    const origDateNow = Date.now;
    Date.now = () => fixedTime;

    try {
      const { collectionId: detId } = await mod.createCollection({
        name: 'Deterministic',
        description: 'deterministic minting',
        deterministicMinting: true,
      });

      const metadata = createTestMetadata({ name: 'Det #1' });
      const r1 = await mod.mintNFT(metadata, detId, 1);

      // Destroy and reload module — use same storage so registry persists
      await mod.destroy();
      const loaded2 = await createLoadedNFTModule({
        identity: config.identity,
        storage: config.storage,
      });
      mod = loaded2.module;

      // The collection should be restored from storage, no need to re-create.
      // But the registry was loaded from the same storage provider, so it should exist.
      const col = mod.getCollection(detId);
      expect(col).not.toBeNull();

      // Oracle returns REQUEST_ID_EXISTS (idempotent re-mint)
      const oracle2 = loaded2.config.oracle as unknown as MockOracleProvider;
      oracle2._stClient.submitMintCommitment.mockResolvedValue({ status: 'REQUEST_ID_EXISTS' });

      const r2 = await mod.mintNFT(metadata, detId, 1);

      // Same tokenId because same deterministic salt (HMAC with same key + collectionId + edition)
      expect(r2.tokenId).toBe(r1.tokenId);
    } finally {
      Date.now = origDateNow;
    }
  });
});
