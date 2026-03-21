/**
 * NFTModule Collection Management Tests (§2)
 *
 * Tests for createCollection, getCollection, getCollections including
 * happy paths, validation errors, idempotency, persistence, events,
 * filtering, and sorting.
 *
 * @see docs/NFT-TEST-SPEC.md §2
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  createMockNFTConfig,
  createLoadedNFTModule,
  createTestCollectionDef,
  createNFTToken,
  createTestNFTTokenData,
  TEST_IDENTITY,
  TEST_ADDRESS_ID,
  SphereError,
  deriveCollectionId,
  canonicalSerializeCollection,
} from './nft-test-helpers.js';
import type { NFTModuleConfig, CollectionDefinition, CreateCollectionRequest } from './nft-test-helpers.js';
import { NFTModule, createNFTModule } from '../../../modules/nft/index.js';
import { STORAGE_KEYS_ADDRESS, getAddressStorageKey } from '../../../constants.js';

// =============================================================================
// §2: Collection Management Tests
// =============================================================================

describe('NFTModule.collection', () => {
  // ---------------------------------------------------------------------------
  // UT-COL-001: createCollection — basic happy path
  // ---------------------------------------------------------------------------
  describe('UT-COL-001: createCollection — basic happy path', () => {
    it('should create a collection with name and description, returning deterministic ID', async () => {
      const { module, config } = await createLoadedNFTModule();

      const result = await module.createCollection({
        name: 'Test Art',
        description: 'A test collection',
      });

      // collectionId is 64-char hex
      expect(result.collectionId).toHaveLength(64);
      expect(result.collectionId).toMatch(/^[0-9a-f]{64}$/);

      // definition has correct fields
      expect(result.definition.name).toBe('Test Art');
      expect(result.definition.description).toBe('A test collection');
      expect(result.definition.creator).toBe(TEST_IDENTITY.chainPubkey);
      expect(result.definition.createdAt).toBeTypeOf('number');
      expect(result.definition.maxSupply).toBeNull();
      expect(result.definition.transferable).toBe(true);
      expect(result.definition.deterministicMinting).toBe(false);

      // collectionId is deterministic SHA-256 of canonical serialization
      const expectedId = deriveCollectionId(result.definition);
      expect(result.collectionId).toBe(expectedId);
    });
  });

  // ---------------------------------------------------------------------------
  // UT-COL-002: createCollection — with all optional fields
  // ---------------------------------------------------------------------------
  describe('UT-COL-002: createCollection — with all optional fields', () => {
    it('should preserve all optional fields in the returned definition', async () => {
      const { module } = await createLoadedNFTModule();

      const result = await module.createCollection({
        name: 'Full Collection',
        description: 'Collection with all fields',
        maxSupply: 100,
        image: 'ipfs://QmCollectionImage',
        externalUrl: 'https://example.com/collection',
        royalty: { recipient: 'DIRECT://royalty_recipient', basisPoints: 500 },
        transferable: false,
        deterministicMinting: true,
      });

      expect(result.definition.maxSupply).toBe(100);
      expect(result.definition.image).toBe('ipfs://QmCollectionImage');
      expect(result.definition.externalUrl).toBe('https://example.com/collection');
      expect(result.definition.royalty).toEqual({ recipient: 'DIRECT://royalty_recipient', basisPoints: 500 });
      expect(result.definition.transferable).toBe(false);
      expect(result.definition.deterministicMinting).toBe(true);

      // collectionId reflects all fields
      const expectedId = deriveCollectionId(result.definition);
      expect(result.collectionId).toBe(expectedId);
    });
  });

  // ---------------------------------------------------------------------------
  // UT-COL-003: createCollection — idempotent (same definition)
  // ---------------------------------------------------------------------------
  describe('UT-COL-003: createCollection — idempotent (same definition)', () => {
    it('should return same collectionId when called with identical input', async () => {
      const { module } = await createLoadedNFTModule();

      // We need to control createdAt to get the same definition
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const result1 = await module.createCollection({
        name: 'Idempotent',
        description: 'Same definition',
      });

      const result2 = await module.createCollection({
        name: 'Idempotent',
        description: 'Same definition',
      });

      expect(result1.collectionId).toBe(result2.collectionId);

      vi.restoreAllMocks();
    });
  });

  // ---------------------------------------------------------------------------
  // UT-COL-004: createCollection — different definitions yield different IDs
  // ---------------------------------------------------------------------------
  describe('UT-COL-004: createCollection — different definitions yield different IDs', () => {
    it('should produce different IDs for definitions differing only in name', async () => {
      const { module } = await createLoadedNFTModule();

      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const result1 = await module.createCollection({
        name: 'Collection A',
        description: 'Same description',
      });

      const result2 = await module.createCollection({
        name: 'Collection B',
        description: 'Same description',
      });

      expect(result1.collectionId).not.toBe(result2.collectionId);

      vi.restoreAllMocks();
    });
  });

  // ---------------------------------------------------------------------------
  // UT-COL-005: createCollection — persists to storage
  // ---------------------------------------------------------------------------
  describe('UT-COL-005: createCollection — persists to storage', () => {
    it('should write collection to StorageProvider under NFT_COLLECTIONS key', async () => {
      const { module, config } = await createLoadedNFTModule();

      const result = await module.createCollection({
        name: 'Persisted Collection',
        description: 'Should be in storage',
      });

      // Read raw storage
      const storageKey = getAddressStorageKey(TEST_ADDRESS_ID, STORAGE_KEYS_ADDRESS.NFT_COLLECTIONS);
      const raw = await config.storage.get(storageKey);
      expect(raw).not.toBeNull();

      const parsed = JSON.parse(raw!);
      expect(parsed.version).toBe(1);
      expect(parsed.collections).toBeDefined();
      expect(parsed.collections[result.collectionId]).toBeDefined();
      expect(parsed.collections[result.collectionId].name).toBe('Persisted Collection');
    });
  });

  // ---------------------------------------------------------------------------
  // UT-COL-006: createCollection — emits nft:collection_created event
  // ---------------------------------------------------------------------------
  describe('UT-COL-006: createCollection — emits nft:collection_created event', () => {
    it('should call emitEvent with nft:collection_created', async () => {
      const { module, config } = await createLoadedNFTModule();

      const result = await module.createCollection({
        name: 'Event Collection',
        description: 'Should emit event',
      });

      expect(config.emitEvent).toHaveBeenCalledWith('nft:collection_created', {
        collectionId: result.collectionId,
        name: 'Event Collection',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // UT-COL-007: createCollection — validation: empty name
  // ---------------------------------------------------------------------------
  describe('UT-COL-007: createCollection — validation: empty name', () => {
    it('should throw SphereError for empty name', async () => {
      const { module } = await createLoadedNFTModule();

      await expect(
        module.createCollection({ name: '', description: 'Valid description' }),
      ).rejects.toThrow(SphereError);

      await expect(module.createCollection({ name: '', description: 'Valid description' })).rejects.toMatchObject({ code: 'NFT_INVALID_METADATA' });
    });

    it('should throw SphereError for whitespace-only name', async () => {
      const { module } = await createLoadedNFTModule();

      await expect(
        module.createCollection({ name: '   ', description: 'Valid description' }),
      ).rejects.toThrow(SphereError);
    });
  });

  // ---------------------------------------------------------------------------
  // UT-COL-008: createCollection — validation: name too long
  // ---------------------------------------------------------------------------
  describe('UT-COL-008: createCollection — validation: name too long', () => {
    it('should throw SphereError for name exceeding 128 characters', async () => {
      const { module } = await createLoadedNFTModule();

      await expect(
        module.createCollection({ name: 'a'.repeat(129), description: 'Valid description' }),
      ).rejects.toThrow(SphereError);

      try {
        await module.createCollection({ name: 'a'.repeat(129), description: 'Valid description' });
      } catch (err) {
        expect((err as SphereError).code).toBe('NFT_INVALID_METADATA');
      }
    });

    it('should accept name at exactly 128 characters', async () => {
      const { module } = await createLoadedNFTModule();

      const result = await module.createCollection({
        name: 'a'.repeat(128),
        description: 'Valid description',
      });

      expect(result.definition.name).toHaveLength(128);
    });
  });

  // ---------------------------------------------------------------------------
  // UT-COL-009: createCollection — validation: maxSupply zero
  // ---------------------------------------------------------------------------
  describe('UT-COL-009: createCollection — validation: maxSupply zero', () => {
    it('should throw SphereError for maxSupply of 0', async () => {
      const { module } = await createLoadedNFTModule();

      await expect(
        module.createCollection({ name: 'Test', description: 'Desc', maxSupply: 0 }),
      ).rejects.toThrow(SphereError);

      await expect(module.createCollection({ name: 'Test', description: 'Desc', maxSupply: 0 })).rejects.toMatchObject({ code: 'NFT_INVALID_METADATA' });
    });
  });

  // ---------------------------------------------------------------------------
  // UT-COL-010: createCollection — validation: maxSupply exceeds limit
  // ---------------------------------------------------------------------------
  describe('UT-COL-010: createCollection — validation: maxSupply exceeds limit', () => {
    it('should throw SphereError for maxSupply exceeding 1,000,000', async () => {
      const { module } = await createLoadedNFTModule();

      await expect(
        module.createCollection({ name: 'Test', description: 'Desc', maxSupply: 1_000_001 }),
      ).rejects.toThrow(SphereError);

      await expect(module.createCollection({ name: 'Test', description: 'Desc', maxSupply: 1_000_001 })).rejects.toMatchObject({ code: 'NFT_INVALID_METADATA' });
    });

    it('should accept maxSupply at exactly 1,000,000', async () => {
      const { module } = await createLoadedNFTModule();

      const result = await module.createCollection({
        name: 'Max Supply',
        description: 'At the limit',
        maxSupply: 1_000_000,
      });

      expect(result.definition.maxSupply).toBe(1_000_000);
    });
  });

  // ---------------------------------------------------------------------------
  // UT-COL-011: createCollection — validation: invalid royalty basisPoints
  // ---------------------------------------------------------------------------
  describe('UT-COL-011: createCollection — validation: invalid royalty basisPoints', () => {
    it('should throw SphereError for basisPoints exceeding 10000', async () => {
      const { module } = await createLoadedNFTModule();

      await expect(
        module.createCollection({
          name: 'Test',
          description: 'Desc',
          royalty: { recipient: 'DIRECT://addr', basisPoints: 10001 },
        }),
      ).rejects.toThrow(SphereError);

      await expect(module.createCollection({
          name: 'Test',
          description: 'Desc',
          royalty: { recipient: 'DIRECT://addr', basisPoints: 10001 },
        })).rejects.toMatchObject({ code: 'NFT_INVALID_METADATA' });
    });
  });

  // ---------------------------------------------------------------------------
  // UT-COL-012: createCollection — validation: negative royalty basisPoints
  // ---------------------------------------------------------------------------
  describe('UT-COL-012: createCollection — validation: negative royalty basisPoints', () => {
    it('should throw SphereError for negative basisPoints', async () => {
      const { module } = await createLoadedNFTModule();

      await expect(
        module.createCollection({
          name: 'Test',
          description: 'Desc',
          royalty: { recipient: 'DIRECT://addr', basisPoints: -1 },
        }),
      ).rejects.toThrow(SphereError);

      await expect(module.createCollection({
          name: 'Test',
          description: 'Desc',
          royalty: { recipient: 'DIRECT://addr', basisPoints: -1 },
        })).rejects.toMatchObject({ code: 'NFT_INVALID_METADATA' });
    });
  });

  // ---------------------------------------------------------------------------
  // UT-COL-013: getCollection — returns existing collection
  // ---------------------------------------------------------------------------
  describe('UT-COL-013: getCollection — returns existing collection', () => {
    it('should return a CollectionRef with correct fields and isCreator: true', async () => {
      const { module } = await createLoadedNFTModule();

      const created = await module.createCollection({
        name: 'Get Collection Test',
        description: 'A collection to retrieve',
        maxSupply: 50,
        royalty: { recipient: 'DIRECT://royalty', basisPoints: 250 },
      });

      const ref = module.getCollection(created.collectionId);

      expect(ref).not.toBeNull();
      expect(ref!.collectionId).toBe(created.collectionId);
      expect(ref!.name).toBe('Get Collection Test');
      expect(ref!.creator).toBe(TEST_IDENTITY.chainPubkey);
      expect(ref!.isCreator).toBe(true);
      expect(ref!.tokenCount).toBe(0);
      expect(ref!.maxSupply).toBe(50);
      expect(ref!.royalty).toEqual({ recipient: 'DIRECT://royalty', basisPoints: 250 });
      expect(ref!.transferable).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // UT-COL-014: getCollection — returns null for unknown ID
  // ---------------------------------------------------------------------------
  describe('UT-COL-014: getCollection — returns null for unknown ID', () => {
    it('should return null for a non-existent collection ID', async () => {
      const { module } = await createLoadedNFTModule();

      const ref = module.getCollection('f'.repeat(64));
      expect(ref).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // UT-COL-015: getCollections — returns all collections
  // ---------------------------------------------------------------------------
  describe('UT-COL-015: getCollections — returns all collections', () => {
    it('should return array of all created collections', async () => {
      const { module } = await createLoadedNFTModule();

      await module.createCollection({ name: 'Collection 1', description: 'First' });
      await module.createCollection({ name: 'Collection 2', description: 'Second' });
      await module.createCollection({ name: 'Collection 3', description: 'Third' });

      const collections = module.getCollections();
      expect(collections).toHaveLength(3);

      const names = collections.map((c) => c.name);
      expect(names).toContain('Collection 1');
      expect(names).toContain('Collection 2');
      expect(names).toContain('Collection 3');
    });
  });

  // ---------------------------------------------------------------------------
  // UT-COL-016: getCollections — filter createdByMe
  // ---------------------------------------------------------------------------
  describe('UT-COL-016: getCollections — filter createdByMe', () => {
    it('should return only locally created collections when createdByMe is true', async () => {
      const { module, config } = await createLoadedNFTModule();

      // Create a local collection
      await module.createCollection({ name: 'My Collection', description: 'Created by me' });

      // Simulate a collection from another creator by pre-populating storage
      // and reloading. We can achieve this by directly manipulating the storage
      // to add a collection with a different creator.
      const storageKey = getAddressStorageKey(TEST_ADDRESS_ID, STORAGE_KEYS_ADDRESS.NFT_COLLECTIONS);
      const raw = await config.storage.get(storageKey);
      const storageData = JSON.parse(raw!);

      const foreignDef: CollectionDefinition = {
        name: 'Foreign Collection',
        description: 'Created by someone else',
        creator: '03' + 'b'.repeat(64), // different creator
        createdAt: 1700000000000,
        maxSupply: null,
        transferable: true,
        deterministicMinting: false,
      };
      const foreignId = deriveCollectionId(foreignDef);
      storageData.collections[foreignId] = foreignDef;
      await config.storage.set(storageKey, JSON.stringify(storageData));

      // Reload module to pick up the foreign collection
      await module.destroy();
      const reloaded = createNFTModule();
      await reloaded.load(config);

      // Filter createdByMe
      const mine = reloaded.getCollections({ createdByMe: true });
      expect(mine).toHaveLength(1);
      expect(mine[0].name).toBe('My Collection');
      expect(mine[0].isCreator).toBe(true);

      // Without filter should return both
      const all = reloaded.getCollections();
      expect(all).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // UT-COL-017: getCollections — sort by name
  // ---------------------------------------------------------------------------
  describe('UT-COL-017: getCollections — sort by name', () => {
    it('should sort collections by name ascending', async () => {
      const { module } = await createLoadedNFTModule();

      await module.createCollection({ name: 'Zebra', description: 'Z' });
      await module.createCollection({ name: 'Alpha', description: 'A' });
      await module.createCollection({ name: 'Middle', description: 'M' });

      const sorted = module.getCollections({ sortBy: 'name', sortOrder: 'asc' });
      expect(sorted.map((c) => c.name)).toEqual(['Alpha', 'Middle', 'Zebra']);
    });

    it('should sort collections by name descending', async () => {
      const { module } = await createLoadedNFTModule();

      await module.createCollection({ name: 'Zebra', description: 'Z' });
      await module.createCollection({ name: 'Alpha', description: 'A' });
      await module.createCollection({ name: 'Middle', description: 'M' });

      const sorted = module.getCollections({ sortBy: 'name', sortOrder: 'desc' });
      expect(sorted.map((c) => c.name)).toEqual(['Zebra', 'Middle', 'Alpha']);
    });
  });

  // ---------------------------------------------------------------------------
  // UT-COL-018: getCollections — sort by tokenCount
  // ---------------------------------------------------------------------------
  describe('UT-COL-018: getCollections — sort by tokenCount', () => {
    it('should sort collections by tokenCount descending', async () => {
      const { module, config } = await createLoadedNFTModule();

      // Create 3 collections
      const col0 = await module.createCollection({ name: 'Empty', description: '0 tokens' });
      const col5 = await module.createCollection({ name: 'Five', description: '5 tokens' });
      const col2 = await module.createCollection({ name: 'Two', description: '2 tokens' });

      // To test sorting by tokenCount, we need NFTs in the collections.
      // We simulate by destroying, populating storage with NFT tokens, and reloading.
      // However, tokenCount is derived from the in-memory NFT index which is built
      // from payments.getTokens(). So we need to set up mock tokens.

      const payments = config.payments as unknown as { getTokens: ReturnType<typeof vi.fn>; _tokens: unknown[] };

      // Create mock NFT tokens for each collection
      const createMockToken = (collectionId: string, edition: number) => {
        const nftData = createTestNFTTokenData({ collectionId, edition });
        const tokenData = JSON.stringify({
          collectionId: nftData.collectionId,
          edition: nftData.edition,
          metadata: nftData.metadata,
          mintedAt: nftData.mintedAt,
          minter: nftData.minter,
          totalEditions: nftData.totalEditions,
        });
        const tokenId = `token_${collectionId.slice(0, 8)}_${edition}`;
        return {
          id: tokenId,
          coinId: 'NFT',
          symbol: 'NFT',
          name: `NFT #${edition}`,
          decimals: 0,
          amount: '1',
          status: 'confirmed' as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          sdkData: JSON.stringify({
            version: '2.0',
            genesis: {
              data: {
                tokenId,
                tokenType: '8b0136c928f34e13ba73274a71bc3e96cd7f6799e876d89842ed4a541d0b963c',
                coinData: [],
                tokenData: tokenData,
              },
              inclusionProof: {},
            },
            state: { data: '', predicate: '' },
            transactions: [],
          }),
        };
      };

      const mockTokens = [
        ...Array.from({ length: 5 }, (_, i) => createMockToken(col5.collectionId, i + 1)),
        ...Array.from({ length: 2 }, (_, i) => createMockToken(col2.collectionId, i + 1)),
        // col0 gets 0 tokens
      ];

      // Destroy and reload with tokens
      await module.destroy();
      const reloaded = createNFTModule();
      payments.getTokens.mockReturnValue(mockTokens);
      await reloaded.load(config);

      const sorted = reloaded.getCollections({ sortBy: 'tokenCount', sortOrder: 'desc' });
      expect(sorted.map((c) => c.tokenCount)).toEqual([5, 2, 0]);
    });
  });
});
