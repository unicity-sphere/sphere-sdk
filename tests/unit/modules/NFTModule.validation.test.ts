/**
 * NFTModule — Validation tests
 *
 * Tests the validation module directly: validateNFTMetadata,
 * validateCreateCollectionRequest, validateImageUri, validateRoyaltyConfig.
 *
 * @see modules/nft/validation.ts
 * @see docs/NFT-TEST-SPEC.md §12 (related)
 */

import { describe, it, expect } from 'vitest';
import { SphereError, NFT_TOKEN_TYPE_HEX } from './nft-test-helpers.js';
import {
  validateNFTMetadata,
  validateCreateCollectionRequest,
  validateImageUri,
  validateRoyaltyConfig,
} from '../../../modules/nft/validation.js';
import {
  NFT_MAX_NAME_LENGTH,
  NFT_MAX_ATTRIBUTES,
  NFT_MAX_IMAGE_URI_LENGTH,
  NFT_MAX_COLLECTION_NAME_LENGTH,
  COLLECTION_MAX_SUPPLY_LIMIT,
} from '../../../modules/nft/types.js';

// =============================================================================
// validateNFTMetadata
// =============================================================================

describe('validateNFTMetadata', () => {
  it('accepts valid metadata with required fields only', () => {
    expect(() =>
      validateNFTMetadata({ name: 'Art', image: 'ipfs://QmHash' }),
    ).not.toThrow();
  });

  it('accepts valid metadata with all optional fields', () => {
    expect(() =>
      validateNFTMetadata({
        name: 'Full Art',
        image: 'https://example.com/image.png',
        description: 'A description',
        animationUrl: 'ipfs://QmAnimation',
        externalUrl: 'https://example.com',
        backgroundColor: 'ff00aa',
        attributes: [
          { trait_type: 'Color', value: 'Red' },
          { trait_type: 'Level', value: 5 },
          { trait_type: 'Active', value: true },
        ],
        properties: { category: 'art' },
        content: {
          thumbnail: 'ipfs://QmThumb',
          preview: 'https://example.com/preview.png',
          full: 'ipfs://QmFull',
          original: 'ipfs://QmOriginal',
        },
      }),
    ).not.toThrow();
  });

  it('rejects missing name', () => {
    expect(() =>
      validateNFTMetadata({ name: '', image: 'ipfs://QmHash' }),
    ).toThrow(SphereError);

    try {
      validateNFTMetadata({ name: '', image: 'ipfs://QmHash' });
    } catch (err) {
      expect((err as SphereError).code).toBe('NFT_INVALID_METADATA');
      expect((err as SphereError).message.toLowerCase()).toContain('name');
    }
  });

  it('rejects whitespace-only name', () => {
    expect(() =>
      validateNFTMetadata({ name: '   ', image: 'ipfs://QmHash' }),
    ).toThrow(SphereError);
  });

  it('rejects missing image', () => {
    expect(() =>
      validateNFTMetadata({ name: 'Art', image: '' }),
    ).toThrow(SphereError);

    try {
      validateNFTMetadata({ name: 'Art', image: '' });
    } catch (err) {
      expect((err as SphereError).code).toBe('NFT_INVALID_METADATA');
      expect((err as SphereError).message.toLowerCase()).toContain('image');
    }
  });

  it('rejects name too long', () => {
    const longName = 'a'.repeat(NFT_MAX_NAME_LENGTH + 1);
    expect(() =>
      validateNFTMetadata({ name: longName, image: 'ipfs://QmHash' }),
    ).toThrow(SphereError);

    try {
      validateNFTMetadata({ name: longName, image: 'ipfs://QmHash' });
    } catch (err) {
      expect((err as SphereError).code).toBe('NFT_INVALID_METADATA');
    }
  });

  it('accepts name at exact max length', () => {
    const exactName = 'a'.repeat(NFT_MAX_NAME_LENGTH);
    expect(() =>
      validateNFTMetadata({ name: exactName, image: 'ipfs://QmHash' }),
    ).not.toThrow();
  });

  it('rejects too many attributes', () => {
    const tooManyAttrs = Array.from({ length: NFT_MAX_ATTRIBUTES + 1 }, (_, i) => ({
      trait_type: `trait_${i}`,
      value: `val_${i}`,
    }));

    expect(() =>
      validateNFTMetadata({ name: 'Art', image: 'ipfs://QmHash', attributes: tooManyAttrs }),
    ).toThrow(SphereError);

    try {
      validateNFTMetadata({ name: 'Art', image: 'ipfs://QmHash', attributes: tooManyAttrs });
    } catch (err) {
      expect((err as SphereError).code).toBe('NFT_INVALID_METADATA');
    }
  });

  it('accepts exactly max attributes', () => {
    const maxAttrs = Array.from({ length: NFT_MAX_ATTRIBUTES }, (_, i) => ({
      trait_type: `trait_${i}`,
      value: `val_${i}`,
    }));

    expect(() =>
      validateNFTMetadata({ name: 'Art', image: 'ipfs://QmHash', attributes: maxAttrs }),
    ).not.toThrow();
  });

  it('rejects invalid image URI scheme', () => {
    expect(() =>
      validateNFTMetadata({ name: 'Art', image: 'ftp://bad.com/image.png' }),
    ).toThrow(SphereError);
  });

  it('rejects invalid backgroundColor format', () => {
    expect(() =>
      validateNFTMetadata({ name: 'Art', image: 'ipfs://QmHash', backgroundColor: '#ff00aa' }),
    ).toThrow(SphereError);
  });

  it('rejects non-object properties', () => {
    expect(() =>
      validateNFTMetadata({ name: 'Art', image: 'ipfs://QmHash', properties: 'not-object' as any }),
    ).toThrow(SphereError);
  });

  it('rejects invalid attribute value type', () => {
    expect(() =>
      validateNFTMetadata({
        name: 'Art',
        image: 'ipfs://QmHash',
        attributes: [{ trait_type: 'color', value: { nested: true } as any }],
      }),
    ).toThrow(SphereError);
  });
});

// =============================================================================
// validateCreateCollectionRequest
// =============================================================================

describe('validateCreateCollectionRequest', () => {
  it('accepts valid minimal request', () => {
    expect(() =>
      validateCreateCollectionRequest({ name: 'My Col', description: 'Description' }),
    ).not.toThrow();
  });

  it('accepts valid request with all optional fields', () => {
    expect(() =>
      validateCreateCollectionRequest({
        name: 'Full Collection',
        description: 'A detailed description',
        maxSupply: 100,
        image: 'ipfs://QmImage',
        externalUrl: 'https://example.com',
        royalty: { recipient: 'DIRECT://addr', basisPoints: 500 },
        transferable: false,
        deterministicMinting: true,
      }),
    ).not.toThrow();
  });

  it('rejects empty name', () => {
    expect(() =>
      validateCreateCollectionRequest({ name: '', description: 'desc' }),
    ).toThrow(SphereError);

    try {
      validateCreateCollectionRequest({ name: '', description: 'desc' });
    } catch (err) {
      expect((err as SphereError).code).toBe('NFT_INVALID_METADATA');
      expect((err as SphereError).message.toLowerCase()).toContain('name');
    }
  });

  it('rejects name too long', () => {
    expect(() =>
      validateCreateCollectionRequest({
        name: 'x'.repeat(NFT_MAX_COLLECTION_NAME_LENGTH + 1),
        description: 'desc',
      }),
    ).toThrow(SphereError);
  });

  it('rejects empty description', () => {
    expect(() =>
      validateCreateCollectionRequest({ name: 'Col', description: '' }),
    ).toThrow(SphereError);
  });

  it('rejects invalid maxSupply: zero', () => {
    expect(() =>
      validateCreateCollectionRequest({ name: 'Col', description: 'desc', maxSupply: 0 }),
    ).toThrow(SphereError);
  });

  it('rejects invalid maxSupply: negative', () => {
    expect(() =>
      validateCreateCollectionRequest({ name: 'Col', description: 'desc', maxSupply: -1 }),
    ).toThrow(SphereError);
  });

  it('rejects invalid maxSupply: exceeds limit', () => {
    expect(() =>
      validateCreateCollectionRequest({
        name: 'Col',
        description: 'desc',
        maxSupply: COLLECTION_MAX_SUPPLY_LIMIT + 1,
      }),
    ).toThrow(SphereError);
  });

  it('accepts maxSupply at exact limit', () => {
    expect(() =>
      validateCreateCollectionRequest({
        name: 'Col',
        description: 'desc',
        maxSupply: COLLECTION_MAX_SUPPLY_LIMIT,
      }),
    ).not.toThrow();
  });

  it('accepts maxSupply = 1', () => {
    expect(() =>
      validateCreateCollectionRequest({ name: 'Col', description: 'desc', maxSupply: 1 }),
    ).not.toThrow();
  });

  it('rejects non-integer maxSupply', () => {
    expect(() =>
      validateCreateCollectionRequest({ name: 'Col', description: 'desc', maxSupply: 1.5 }),
    ).toThrow(SphereError);
  });

  it('rejects invalid royalty: basisPoints > 10000', () => {
    expect(() =>
      validateCreateCollectionRequest({
        name: 'Col',
        description: 'desc',
        royalty: { recipient: 'DIRECT://addr', basisPoints: 10001 },
      }),
    ).toThrow(SphereError);
  });

  it('rejects invalid royalty: negative basisPoints', () => {
    expect(() =>
      validateCreateCollectionRequest({
        name: 'Col',
        description: 'desc',
        royalty: { recipient: 'DIRECT://addr', basisPoints: -1 },
      }),
    ).toThrow(SphereError);
  });

  it('accepts royalty at boundary values: 0 and 10000', () => {
    expect(() =>
      validateCreateCollectionRequest({
        name: 'Col',
        description: 'desc',
        royalty: { recipient: 'DIRECT://addr', basisPoints: 0 },
      }),
    ).not.toThrow();

    expect(() =>
      validateCreateCollectionRequest({
        name: 'Col',
        description: 'desc',
        royalty: { recipient: 'DIRECT://addr', basisPoints: 10000 },
      }),
    ).not.toThrow();
  });

  it('rejects royalty with empty recipient', () => {
    expect(() =>
      validateCreateCollectionRequest({
        name: 'Col',
        description: 'desc',
        royalty: { recipient: '', basisPoints: 500 },
      }),
    ).toThrow(SphereError);
  });
});

// =============================================================================
// validateImageUri
// =============================================================================

describe('validateImageUri', () => {
  it('accepts ipfs:// URIs', () => {
    expect(validateImageUri('ipfs://QmHash123')).toBe(true);
  });

  it('accepts https:// URIs', () => {
    expect(validateImageUri('https://example.com/image.png')).toBe(true);
  });

  it('accepts http:// URIs', () => {
    expect(validateImageUri('http://example.com/image.png')).toBe(true);
  });

  it('accepts data: URIs', () => {
    expect(validateImageUri('data:image/png;base64,iVBORw0KGgoAAAANSUhEUg')).toBe(true);
  });

  it('rejects ftp:// URIs', () => {
    expect(validateImageUri('ftp://example.com/file.png')).toBe(false);
  });

  it('rejects file:// URIs', () => {
    expect(validateImageUri('file:///tmp/image.png')).toBe(false);
  });

  it('rejects plain strings without scheme', () => {
    expect(validateImageUri('just-a-string')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(validateImageUri('')).toBe(false);
  });

  it('rejects URI too long', () => {
    const longUri = 'https://example.com/' + 'a'.repeat(NFT_MAX_IMAGE_URI_LENGTH);
    expect(validateImageUri(longUri)).toBe(false);
  });

  it('accepts URI at exact max length', () => {
    const prefix = 'https://';
    const exactUri = prefix + 'a'.repeat(NFT_MAX_IMAGE_URI_LENGTH - prefix.length);
    expect(validateImageUri(exactUri)).toBe(true);
  });
});

// =============================================================================
// validateRoyaltyConfig
// =============================================================================

describe('validateRoyaltyConfig', () => {
  it('accepts valid royalty config', () => {
    expect(() =>
      validateRoyaltyConfig({ recipient: 'DIRECT://addr', basisPoints: 500 }),
    ).not.toThrow();
  });

  it('rejects non-integer basisPoints', () => {
    expect(() =>
      validateRoyaltyConfig({ recipient: 'DIRECT://addr', basisPoints: 5.5 }),
    ).toThrow(SphereError);
  });

  it('rejects NaN basisPoints', () => {
    expect(() =>
      validateRoyaltyConfig({ recipient: 'DIRECT://addr', basisPoints: NaN }),
    ).toThrow(SphereError);
  });
});
