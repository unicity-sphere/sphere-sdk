/**
 * NFTModule Serialization Tests (§10)
 *
 * Tests for canonical serialization of NFT token data and collection definitions,
 * collectionId derivation, round-trip serialize/parse, and unicode handling.
 *
 * @see docs/NFT-TEST-SPEC.md §10
 */

import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
  canonicalSerializeNFT,
  canonicalSerializeCollection,
  deriveCollectionId,
  NFT_TOKEN_TYPE_HEX,
} from '../../../modules/nft/serialization.js';
import { parseNFTTokenData } from '../../../modules/nft/serialization.js';
import {
  createTestMetadata,
  createTestNFTTokenData,
  createTestCollectionDef,
  TEST_IDENTITY,
} from './nft-test-helpers.js';
import type { NFTTokenData, CollectionDefinition, NFTMetadata } from '../../../modules/nft/types.js';

// =============================================================================
// §10: Serialization Tests
// =============================================================================

describe('NFTModule.serialization', () => {
  // ---------------------------------------------------------------------------
  // UT-SER-001: canonicalSerializeNFT — deterministic output
  // ---------------------------------------------------------------------------
  describe('UT-SER-001: canonicalSerializeNFT — deterministic output', () => {
    it('should produce identical strings for the same NFTTokenData', () => {
      const data = createTestNFTTokenData({ mintedAt: 1700000000000 });
      const result1 = canonicalSerializeNFT(data);
      const result2 = canonicalSerializeNFT(data);

      expect(result1).toBe(result2);
    });

    it('should produce identical strings when called with structurally equal objects', () => {
      const fixedCollectionId = 'a'.repeat(64);
      const data1 = createTestNFTTokenData({ collectionId: fixedCollectionId, mintedAt: 1700000000000 });
      const data2 = createTestNFTTokenData({ collectionId: fixedCollectionId, mintedAt: 1700000000000 });

      expect(canonicalSerializeNFT(data1)).toBe(canonicalSerializeNFT(data2));
    });
  });

  // ---------------------------------------------------------------------------
  // UT-SER-002: canonicalSerializeNFT — key ordering
  // ---------------------------------------------------------------------------
  describe('UT-SER-002: canonicalSerializeNFT — key ordering', () => {
    it('should produce keys in strict alphabetical order at every level', () => {
      const data = createTestNFTTokenData({
        collectionId: 'a'.repeat(64),
        metadata: {
          name: 'Test',
          image: 'ipfs://QmTest',
          description: 'desc',
          animationUrl: 'ipfs://QmAnim',
          externalUrl: 'https://example.com',
          backgroundColor: 'ff0000',
          attributes: [{ trait_type: 'Color', value: 'Red' }],
          properties: { custom: 'value' },
          content: { thumbnail: 'ipfs://QmThumb', preview: 'ipfs://QmPrev', full: 'ipfs://QmFull', original: 'ipfs://QmOrig' },
        },
        edition: 1,
        totalEditions: 10,
        minter: '03' + 'b'.repeat(64),
        mintedAt: 1700000000000,
      });

      const json = canonicalSerializeNFT(data);
      const parsed = JSON.parse(json);

      // Top-level keys: collectionId, edition, metadata, mintedAt, minter, totalEditions
      const topKeys = Object.keys(parsed);
      expect(topKeys).toEqual(['collectionId', 'edition', 'metadata', 'mintedAt', 'minter', 'totalEditions']);

      // Metadata keys: animationUrl, attributes, backgroundColor, content, description, externalUrl, image, name, properties
      const metaKeys = Object.keys(parsed.metadata);
      expect(metaKeys).toEqual([
        'animationUrl', 'attributes', 'backgroundColor', 'content',
        'description', 'externalUrl', 'image', 'name', 'properties',
      ]);

      // Attribute keys: display_type, max_value, trait_type, value
      const attrKeys = Object.keys(parsed.metadata.attributes[0]);
      expect(attrKeys).toEqual(['display_type', 'max_value', 'trait_type', 'value']);

      // Content keys: full, original, preview, thumbnail
      const contentKeys = Object.keys(parsed.metadata.content);
      expect(contentKeys).toEqual(['full', 'original', 'preview', 'thumbnail']);
    });
  });

  // ---------------------------------------------------------------------------
  // UT-SER-003: canonicalSerializeNFT — null normalization
  // ---------------------------------------------------------------------------
  describe('UT-SER-003: canonicalSerializeNFT — null normalization', () => {
    it('should normalize absent optional fields to null', () => {
      const data = createTestNFTTokenData({
        collectionId: null,
        metadata: { name: 'Minimal', image: 'ipfs://QmMin' },
        minter: undefined,
        mintedAt: 1700000000000,
      });

      const json = canonicalSerializeNFT(data);
      const parsed = JSON.parse(json);

      // Top-level optionals
      expect(parsed.collectionId).toBeNull();
      expect(parsed.minter).toBeNull();

      // Metadata optionals
      expect(parsed.metadata.animationUrl).toBeNull();
      expect(parsed.metadata.attributes).toBeNull();
      expect(parsed.metadata.backgroundColor).toBeNull();
      expect(parsed.metadata.content).toBeNull();
      expect(parsed.metadata.description).toBeNull();
      expect(parsed.metadata.externalUrl).toBeNull();
      expect(parsed.metadata.properties).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // UT-SER-004: canonicalSerializeNFT — attribute sorting
  // ---------------------------------------------------------------------------
  describe('UT-SER-004: canonicalSerializeNFT — attribute sorting', () => {
    it('should sort attributes by trait_type ascending', () => {
      const data = createTestNFTTokenData({
        metadata: {
          name: 'Sorted',
          image: 'ipfs://QmSorted',
          attributes: [
            { trait_type: 'Zebra', value: 'stripes' },
            { trait_type: 'Apple', value: 'red' },
            { trait_type: 'Middle', value: 'center' },
          ],
        },
        mintedAt: 1700000000000,
      });

      const json = canonicalSerializeNFT(data);
      const parsed = JSON.parse(json);

      expect(parsed.metadata.attributes[0].trait_type).toBe('Apple');
      expect(parsed.metadata.attributes[1].trait_type).toBe('Middle');
      expect(parsed.metadata.attributes[2].trait_type).toBe('Zebra');
    });

    it('should not mutate the original attributes array', () => {
      const attrs = [
        { trait_type: 'Z', value: '1' },
        { trait_type: 'A', value: '2' },
      ];
      const data = createTestNFTTokenData({
        metadata: { name: 'Test', image: 'ipfs://QmTest', attributes: attrs },
        mintedAt: 1700000000000,
      });

      canonicalSerializeNFT(data);

      // Original array should be unchanged
      expect(attrs[0].trait_type).toBe('Z');
      expect(attrs[1].trait_type).toBe('A');
    });
  });

  // ---------------------------------------------------------------------------
  // UT-SER-005: canonicalSerializeNFT — compact JSON (no whitespace)
  // ---------------------------------------------------------------------------
  describe('UT-SER-005: canonicalSerializeNFT — compact JSON (no whitespace)', () => {
    it('should produce JSON with no spaces after : or , and no newlines', () => {
      const data = createTestNFTTokenData({
        metadata: {
          name: 'Compact',
          image: 'ipfs://QmCompact',
          description: 'A compact test',
          attributes: [{ trait_type: 'Color', value: 'Blue' }],
        },
        mintedAt: 1700000000000,
      });

      const json = canonicalSerializeNFT(data);

      // No newlines
      expect(json).not.toContain('\n');
      expect(json).not.toContain('\r');

      // Should not contain ": " (space after colon) — except inside string values
      // The compact JSON.stringify produces "key":value with no space after colon
      // Verify it matches what JSON.stringify with no spacing would produce
      const reparsed = JSON.parse(json);
      const recompacted = JSON.stringify(reparsed);
      expect(json).toBe(recompacted);
    });
  });

  // ---------------------------------------------------------------------------
  // UT-SER-006: canonicalSerializeCollection — deterministic
  // ---------------------------------------------------------------------------
  describe('UT-SER-006: canonicalSerializeCollection — deterministic', () => {
    it('should produce identical strings for the same CollectionDefinition', () => {
      const def = createTestCollectionDef();
      const result1 = canonicalSerializeCollection(def);
      const result2 = canonicalSerializeCollection(def);

      expect(result1).toBe(result2);
    });

    it('should produce identical strings for structurally equal definitions', () => {
      const def1 = createTestCollectionDef({ createdAt: 1700000000000 });
      const def2 = createTestCollectionDef({ createdAt: 1700000000000 });

      expect(canonicalSerializeCollection(def1)).toBe(canonicalSerializeCollection(def2));
    });
  });

  // ---------------------------------------------------------------------------
  // UT-SER-007: canonicalSerializeCollection — key ordering
  // ---------------------------------------------------------------------------
  describe('UT-SER-007: canonicalSerializeCollection — key ordering', () => {
    it('should produce keys in alphabetical order', () => {
      const def = createTestCollectionDef({
        image: 'ipfs://QmCollImg',
        externalUrl: 'https://example.com',
        royalty: { recipient: 'DIRECT://royalty_addr', basisPoints: 500 },
        deterministicMinting: true,
      });

      const json = canonicalSerializeCollection(def);
      const parsed = JSON.parse(json);
      const keys = Object.keys(parsed);

      expect(keys).toEqual([
        'createdAt', 'creator', 'description', 'deterministicMinting',
        'externalUrl', 'image', 'maxSupply', 'name', 'royalty', 'transferable',
      ]);
    });

    it('should order royalty sub-keys alphabetically: basisPoints, recipient', () => {
      const def = createTestCollectionDef({
        royalty: { recipient: 'DIRECT://addr', basisPoints: 250 },
      });

      const json = canonicalSerializeCollection(def);
      const parsed = JSON.parse(json);
      const royaltyKeys = Object.keys(parsed.royalty);

      expect(royaltyKeys).toEqual(['basisPoints', 'recipient']);
    });
  });

  // ---------------------------------------------------------------------------
  // UT-SER-008: canonicalSerializeCollection — null normalization for optionals
  // ---------------------------------------------------------------------------
  describe('UT-SER-008: canonicalSerializeCollection — null normalization for optionals', () => {
    it('should normalize absent optional fields to null or defaults', () => {
      const def = createTestCollectionDef();
      const json = canonicalSerializeCollection(def);
      const parsed = JSON.parse(json);

      expect(parsed.deterministicMinting).toBe(false);
      expect(parsed.externalUrl).toBeNull();
      expect(parsed.image).toBeNull();
      expect(parsed.maxSupply).toBeNull();
      expect(parsed.royalty).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // UT-SER-009: canonicalSerializeCollection — transferable defaults to true
  // ---------------------------------------------------------------------------
  describe('UT-SER-009: canonicalSerializeCollection — transferable defaults to true', () => {
    it('should default transferable to true when not explicitly set', () => {
      // Create a def without explicit transferable (using object spread to remove it)
      const def: CollectionDefinition = {
        name: 'No Transferable',
        description: 'Testing default',
        creator: TEST_IDENTITY.chainPubkey,
        createdAt: 1700000000000,
        maxSupply: null,
      };

      const json = canonicalSerializeCollection(def);
      expect(json).toContain('"transferable":true');
    });

    it('should preserve transferable: false when explicitly set', () => {
      const def = createTestCollectionDef({ transferable: false });
      const json = canonicalSerializeCollection(def);
      expect(json).toContain('"transferable":false');
    });
  });

  // ---------------------------------------------------------------------------
  // UT-SER-010: collectionId derivation — SHA-256 of serialized definition
  // ---------------------------------------------------------------------------
  describe('UT-SER-010: collectionId derivation — SHA-256 of serialized definition', () => {
    it('should produce a 64-char lowercase hex string', () => {
      const def = createTestCollectionDef();
      const collectionId = deriveCollectionId(def);

      expect(collectionId).toHaveLength(64);
      expect(collectionId).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should match SHA-256 of canonical serialization', () => {
      const def = createTestCollectionDef();
      const serialized = canonicalSerializeCollection(def);
      const expectedHash = bytesToHex(sha256(new TextEncoder().encode(serialized)));

      expect(deriveCollectionId(def)).toBe(expectedHash);
    });

    it('should be deterministic — same definition always yields same ID', () => {
      const def = createTestCollectionDef();
      const id1 = deriveCollectionId(def);
      const id2 = deriveCollectionId(def);

      expect(id1).toBe(id2);
    });

    it('should produce different IDs for different definitions', () => {
      const def1 = createTestCollectionDef({ name: 'Collection A' });
      const def2 = createTestCollectionDef({ name: 'Collection B' });

      expect(deriveCollectionId(def1)).not.toBe(deriveCollectionId(def2));
    });
  });

  // ---------------------------------------------------------------------------
  // UT-SER-011: tokenId stability — same metadata + salt = same ID
  // ---------------------------------------------------------------------------
  describe('UT-SER-011: tokenId stability — same metadata + salt = same ID', () => {
    it('should produce identical serialization for identical NFTTokenData', () => {
      const data = createTestNFTTokenData({ mintedAt: 1700000000000 });
      const ser1 = canonicalSerializeNFT(data);
      const ser2 = canonicalSerializeNFT(data);

      // If serialization is identical, SHA-256(serialization) will be identical
      const hash1 = bytesToHex(sha256(new TextEncoder().encode(ser1)));
      const hash2 = bytesToHex(sha256(new TextEncoder().encode(ser2)));
      expect(hash1).toBe(hash2);
    });
  });

  // ---------------------------------------------------------------------------
  // UT-SER-012: tokenId uniqueness — different salt = different ID
  // ---------------------------------------------------------------------------
  describe('UT-SER-012: tokenId uniqueness — different metadata = different hash', () => {
    it('should produce different serializations for different NFTTokenData', () => {
      const data1 = createTestNFTTokenData({ edition: 1, mintedAt: 1700000000000 });
      const data2 = createTestNFTTokenData({ edition: 2, mintedAt: 1700000000000 });

      const ser1 = canonicalSerializeNFT(data1);
      const ser2 = canonicalSerializeNFT(data2);

      expect(ser1).not.toBe(ser2);

      const hash1 = bytesToHex(sha256(new TextEncoder().encode(ser1)));
      const hash2 = bytesToHex(sha256(new TextEncoder().encode(ser2)));
      expect(hash1).not.toBe(hash2);
    });
  });

  // ---------------------------------------------------------------------------
  // UT-SER-013: round-trip — serialize then parse
  // ---------------------------------------------------------------------------
  describe('UT-SER-013: round-trip — serialize then parse', () => {
    it('should round-trip minimal NFTTokenData through serialize/parse', () => {
      const original: NFTTokenData = {
        collectionId: null,
        metadata: { name: 'RoundTrip', image: 'ipfs://QmRoundTrip' },
        edition: 0,
        totalEditions: 0,
        mintedAt: 1700000000000,
      };

      const serialized = canonicalSerializeNFT(original);
      const parsed = parseNFTTokenData(serialized);

      expect(parsed).not.toBeNull();
      expect(parsed!.collectionId).toBeNull();
      expect(parsed!.metadata.name).toBe('RoundTrip');
      expect(parsed!.metadata.image).toBe('ipfs://QmRoundTrip');
      expect(parsed!.edition).toBe(0);
      expect(parsed!.totalEditions).toBe(0);
      expect(parsed!.mintedAt).toBe(1700000000000);
    });

    it('should round-trip full NFTTokenData through serialize/parse', () => {
      const original: NFTTokenData = {
        collectionId: 'a'.repeat(64),
        metadata: {
          name: 'Full NFT',
          image: 'ipfs://QmFull',
          description: 'A fully populated NFT',
          animationUrl: 'ipfs://QmAnim',
          externalUrl: 'https://example.com',
          backgroundColor: 'ff00aa',
          attributes: [
            { trait_type: 'Color', value: 'Red' },
            { trait_type: 'Size', value: 42, display_type: 'number', max_value: 100 },
          ],
          properties: { custom: 'data', nested: { key: 'val' } },
          content: { thumbnail: 'ipfs://QmThumb', full: 'ipfs://QmFull' },
        },
        edition: 5,
        totalEditions: 100,
        minter: '03' + 'b'.repeat(64),
        mintedAt: 1700000000000,
      };

      const serialized = canonicalSerializeNFT(original);
      const parsed = parseNFTTokenData(serialized);

      expect(parsed).not.toBeNull();
      expect(parsed!.collectionId).toBe(original.collectionId);
      expect(parsed!.metadata.name).toBe('Full NFT');
      expect(parsed!.metadata.image).toBe('ipfs://QmFull');
      expect(parsed!.metadata.description).toBe('A fully populated NFT');
      expect(parsed!.metadata.animationUrl).toBe('ipfs://QmAnim');
      expect(parsed!.metadata.externalUrl).toBe('https://example.com');
      expect(parsed!.metadata.backgroundColor).toBe('ff00aa');
      // Attributes are sorted by trait_type in serialization
      expect(parsed!.metadata.attributes).toHaveLength(2);
      expect(parsed!.metadata.attributes![0].trait_type).toBe('Color');
      expect(parsed!.metadata.attributes![1].trait_type).toBe('Size');
      expect(parsed!.metadata.attributes![1].display_type).toBe('number');
      expect(parsed!.metadata.attributes![1].max_value).toBe(100);
      expect(parsed!.metadata.properties).toEqual({ custom: 'data', nested: { key: 'val' } });
      expect(parsed!.metadata.content!.thumbnail).toBe('ipfs://QmThumb');
      expect(parsed!.metadata.content!.full).toBe('ipfs://QmFull');
      expect(parsed!.edition).toBe(5);
      expect(parsed!.totalEditions).toBe(100);
      expect(parsed!.minter).toBe(original.minter);
      expect(parsed!.mintedAt).toBe(1700000000000);
    });

    it('should return null for invalid JSON', () => {
      expect(parseNFTTokenData('not-json')).toBeNull();
    });

    it('should return null for JSON missing required fields', () => {
      expect(parseNFTTokenData('{"metadata":{}}')).toBeNull();
      expect(parseNFTTokenData('{"metadata":{"name":"x"}}')).toBeNull(); // missing image and mintedAt
      expect(parseNFTTokenData('{}')).toBeNull();
      expect(parseNFTTokenData('null')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // UT-SER-013a: real canonicalSerializeNFT produces correct JSON structure
  // ---------------------------------------------------------------------------
  describe('UT-SER-013a: real canonicalSerializeNFT produces correct JSON structure', () => {
    it('should produce alphabetically ordered keys and include required properties', () => {
      const data = createTestNFTTokenData({
        collectionId: 'c'.repeat(64),
        metadata: createTestMetadata({ name: 'Structure Test', description: 'Testing output format' }),
        edition: 3,
        totalEditions: 10,
        minter: TEST_IDENTITY.chainPubkey,
        mintedAt: 1700000000000,
      });

      const result = canonicalSerializeNFT(data);
      const parsed = JSON.parse(result);

      // Verify keys are in alphabetical order at top level
      const keys = Object.keys(parsed);
      expect(keys).toEqual([...keys].sort());

      // Verify required properties are present
      expect(parsed).toHaveProperty('collectionId');
      expect(parsed).toHaveProperty('metadata');
      expect(parsed).toHaveProperty('edition');
      expect(parsed).toHaveProperty('mintedAt');
      expect(parsed).toHaveProperty('minter');
      expect(parsed).toHaveProperty('totalEditions');

      // Verify collectionId value
      expect(parsed.collectionId).toBe('c'.repeat(64));

      // Verify metadata keys are also alphabetically ordered
      const metaKeys = Object.keys(parsed.metadata);
      expect(metaKeys).toEqual([...metaKeys].sort());

      // Verify metadata has image and name
      expect(parsed.metadata.name).toBe('Structure Test');
      expect(parsed.metadata.image).toBe('ipfs://QmTestHash123');
    });

    it('should produce correct structure for standalone NFT (null collectionId)', () => {
      const data = createTestNFTTokenData({
        collectionId: null,
        metadata: createTestMetadata({ name: 'Standalone' }),
        edition: 0,
        totalEditions: 0,
        mintedAt: 1700000000000,
      });

      const result = canonicalSerializeNFT(data);
      const parsed = JSON.parse(result);

      expect(parsed.collectionId).toBeNull();
      expect(parsed.edition).toBe(0);
      expect(parsed.totalEditions).toBe(0);
      expect(parsed.metadata.name).toBe('Standalone');
    });
  });

  // ---------------------------------------------------------------------------
  // UT-SER-014: unicode in metadata — handled correctly
  // ---------------------------------------------------------------------------
  describe('UT-SER-014: unicode in metadata — handled correctly', () => {
    it('should preserve emoji characters through serialize/parse', () => {
      const data = createTestNFTTokenData({
        metadata: { name: 'Art \u{1F3A8}\u{1F525}', image: 'ipfs://QmEmoji', description: 'Fire \u{1F525} and art \u{1F3A8}' },
        mintedAt: 1700000000000,
      });

      const serialized = canonicalSerializeNFT(data);
      const parsed = parseNFTTokenData(serialized);

      expect(parsed).not.toBeNull();
      expect(parsed!.metadata.name).toBe('Art \u{1F3A8}\u{1F525}');
      expect(parsed!.metadata.description).toBe('Fire \u{1F525} and art \u{1F3A8}');
    });

    it('should preserve CJK characters through serialize/parse', () => {
      const data = createTestNFTTokenData({
        metadata: { name: '\u82b8\u8853\u4f5c\u54c1', image: 'ipfs://QmCJK', description: '\u7f8e\u3057\u3044\u30c7\u30b8\u30bf\u30eb\u30a2\u30fc\u30c8' },
        mintedAt: 1700000000000,
      });

      const serialized = canonicalSerializeNFT(data);
      const parsed = parseNFTTokenData(serialized);

      expect(parsed).not.toBeNull();
      expect(parsed!.metadata.name).toBe('\u82b8\u8853\u4f5c\u54c1');
      expect(parsed!.metadata.description).toBe('\u7f8e\u3057\u3044\u30c7\u30b8\u30bf\u30eb\u30a2\u30fc\u30c8');
    });

    it('should preserve RTL text through serialize/parse', () => {
      const data = createTestNFTTokenData({
        metadata: { name: '\u0641\u0646 \u0631\u0642\u0645\u064a', image: 'ipfs://QmRTL' },
        mintedAt: 1700000000000,
      });

      const serialized = canonicalSerializeNFT(data);
      const parsed = parseNFTTokenData(serialized);

      expect(parsed).not.toBeNull();
      expect(parsed!.metadata.name).toBe('\u0641\u0646 \u0631\u0642\u0645\u064a');
    });

    it('should produce deterministic output for unicode strings', () => {
      const data = createTestNFTTokenData({
        metadata: { name: 'Mixed \u{1F3A8}\u82b8\u8853 Art', image: 'ipfs://QmMixed' },
        mintedAt: 1700000000000,
      });

      const ser1 = canonicalSerializeNFT(data);
      const ser2 = canonicalSerializeNFT(data);

      expect(ser1).toBe(ser2);
    });
  });
});
