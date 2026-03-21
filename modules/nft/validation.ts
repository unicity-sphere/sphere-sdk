/**
 * NFT Module Validation
 *
 * Validation functions for NFT metadata, collection requests, and royalty
 * configuration. Each function throws SphereError with code 'NFT_INVALID_METADATA'
 * on failure.
 *
 * @see docs/NFT-SPEC.md §3.1, §4.1.1
 */

import { SphereError } from '../../core/errors.js';
import type { NFTMetadata, CreateCollectionRequest, RoyaltyConfig } from './types.js';
import {
  NFT_MAX_NAME_LENGTH,
  NFT_MAX_DESCRIPTION_LENGTH,
  NFT_MAX_ATTRIBUTES,
  NFT_MAX_IMAGE_URI_LENGTH,
  NFT_MAX_COLLECTION_NAME_LENGTH,
  COLLECTION_MAX_SUPPLY_LIMIT,
} from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Valid URI scheme prefixes for image and media URIs. */
const VALID_URI_PREFIXES = ['ipfs://', 'https://', 'http://', 'data:'] as const;

/**
 * Returns true if `uri` is a valid image/media URI.
 *
 * A valid URI:
 * - starts with one of: `ipfs://`, `https://`, `http://`, `data:`
 * - is at most 2048 characters long
 */
export function validateImageUri(uri: string): boolean {
  if (uri.length > NFT_MAX_IMAGE_URI_LENGTH) return false;
  return VALID_URI_PREFIXES.some((prefix) => uri.startsWith(prefix));
}

/**
 * Throws NFT_INVALID_METADATA if `uri` is not a valid image/media URI.
 */
function assertValidUri(uri: string, fieldName: string): void {
  if (!validateImageUri(uri)) {
    throw new SphereError(
      `Invalid URI for ${fieldName}: must start with ipfs://, https://, http://, or data: and be at most ${NFT_MAX_IMAGE_URI_LENGTH} chars`,
      'NFT_INVALID_METADATA',
    );
  }
}

// ---------------------------------------------------------------------------
// Public validators
// ---------------------------------------------------------------------------

/**
 * Validate an NFTMetadata object.
 *
 * @throws SphereError with code NFT_INVALID_METADATA
 */
export function validateNFTMetadata(metadata: NFTMetadata): void {
  // name — required, 1-256 chars, non-empty after trim
  if (typeof metadata.name !== 'string' || metadata.name.trim().length === 0) {
    throw new SphereError('NFT name is required and must be non-empty', 'NFT_INVALID_METADATA');
  }
  if (metadata.name.length > NFT_MAX_NAME_LENGTH) {
    throw new SphereError(
      `NFT name must be at most ${NFT_MAX_NAME_LENGTH} characters (got ${metadata.name.length})`,
      'NFT_INVALID_METADATA',
    );
  }

  // image — required, valid URI
  if (typeof metadata.image !== 'string' || metadata.image.length === 0) {
    throw new SphereError('NFT image URI is required', 'NFT_INVALID_METADATA');
  }
  assertValidUri(metadata.image, 'image');

  // description — optional, ≤ 4096 chars
  if (metadata.description !== undefined && metadata.description !== null) {
    if (typeof metadata.description !== 'string') {
      throw new SphereError('NFT description must be a string', 'NFT_INVALID_METADATA');
    }
    if (metadata.description.length > NFT_MAX_DESCRIPTION_LENGTH) {
      throw new SphereError(
        `NFT description must be at most ${NFT_MAX_DESCRIPTION_LENGTH} characters (got ${metadata.description.length})`,
        'NFT_INVALID_METADATA',
      );
    }
  }

  // animationUrl — optional, valid URI, ≤ 2048 chars
  if (metadata.animationUrl !== undefined && metadata.animationUrl !== null) {
    if (typeof metadata.animationUrl !== 'string') {
      throw new SphereError('animationUrl must be a string', 'NFT_INVALID_METADATA');
    }
    assertValidUri(metadata.animationUrl, 'animationUrl');
  }

  // externalUrl — optional, valid URL, ≤ 2048 chars
  if (metadata.externalUrl !== undefined && metadata.externalUrl !== null) {
    if (typeof metadata.externalUrl !== 'string') {
      throw new SphereError('externalUrl must be a string', 'NFT_INVALID_METADATA');
    }
    assertValidUri(metadata.externalUrl, 'externalUrl');
  }

  // backgroundColor — optional, 6-char hex (no # prefix)
  if (metadata.backgroundColor !== undefined && metadata.backgroundColor !== null) {
    if (typeof metadata.backgroundColor !== 'string' || !/^[0-9a-fA-F]{6}$/.test(metadata.backgroundColor)) {
      throw new SphereError(
        'backgroundColor must be a 6-character hex string (no # prefix), e.g. "ff00aa"',
        'NFT_INVALID_METADATA',
      );
    }
  }

  // attributes — optional, ≤ 100 elements, each with trait_type (string) and value (string|number|boolean)
  if (metadata.attributes !== undefined && metadata.attributes !== null) {
    if (!Array.isArray(metadata.attributes)) {
      throw new SphereError('attributes must be an array', 'NFT_INVALID_METADATA');
    }
    if (metadata.attributes.length > NFT_MAX_ATTRIBUTES) {
      throw new SphereError(
        `attributes must have at most ${NFT_MAX_ATTRIBUTES} elements (got ${metadata.attributes.length})`,
        'NFT_INVALID_METADATA',
      );
    }
    for (let i = 0; i < metadata.attributes.length; i++) {
      const attr = metadata.attributes[i];
      if (typeof attr.trait_type !== 'string') {
        throw new SphereError(`attributes[${i}].trait_type must be a string`, 'NFT_INVALID_METADATA');
      }
      const vType = typeof attr.value;
      if (vType !== 'string' && vType !== 'number' && vType !== 'boolean') {
        throw new SphereError(
          `attributes[${i}].value must be a string, number, or boolean`,
          'NFT_INVALID_METADATA',
        );
      }
    }
  }

  // properties — optional, must be a plain object
  if (metadata.properties !== undefined && metadata.properties !== null) {
    if (typeof metadata.properties !== 'object' || Array.isArray(metadata.properties)) {
      throw new SphereError('properties must be a plain object', 'NFT_INVALID_METADATA');
    }
  }

  // content — optional, all fields must be valid URIs if present
  if (metadata.content !== undefined && metadata.content !== null) {
    if (typeof metadata.content !== 'object' || Array.isArray(metadata.content)) {
      throw new SphereError('content must be an object', 'NFT_INVALID_METADATA');
    }
    const contentFields = ['thumbnail', 'preview', 'full', 'original'] as const;
    for (const field of contentFields) {
      const val = metadata.content[field];
      if (val !== undefined && val !== null) {
        if (typeof val !== 'string') {
          throw new SphereError(`content.${field} must be a string`, 'NFT_INVALID_METADATA');
        }
        assertValidUri(val, `content.${field}`);
      }
    }
  }
}

/**
 * Validate a RoyaltyConfig object.
 *
 * @throws SphereError with code NFT_INVALID_METADATA
 */
export function validateRoyaltyConfig(royalty: RoyaltyConfig): void {
  // recipient — required, non-empty string
  if (typeof royalty.recipient !== 'string' || royalty.recipient.trim().length === 0) {
    throw new SphereError(
      'Royalty recipient is required and must be a non-empty string (DIRECT:// address or chain pubkey)',
      'NFT_INVALID_METADATA',
    );
  }

  // basisPoints — required, integer, 0 ≤ n ≤ 10000
  if (
    typeof royalty.basisPoints !== 'number' ||
    !Number.isInteger(royalty.basisPoints) ||
    royalty.basisPoints < 0 ||
    royalty.basisPoints > 10000
  ) {
    throw new SphereError(
      'Royalty basisPoints must be an integer between 0 and 10000 (inclusive)',
      'NFT_INVALID_METADATA',
    );
  }
}

/**
 * Validate a CreateCollectionRequest object.
 *
 * @throws SphereError with code NFT_INVALID_METADATA
 */
export function validateCreateCollectionRequest(request: CreateCollectionRequest): void {
  // name — required, 1-128 chars, non-empty after trim
  if (typeof request.name !== 'string' || request.name.trim().length === 0) {
    throw new SphereError('Collection name is required and must be non-empty', 'NFT_INVALID_METADATA');
  }
  if (request.name.length > NFT_MAX_COLLECTION_NAME_LENGTH) {
    throw new SphereError(
      `Collection name must be at most ${NFT_MAX_COLLECTION_NAME_LENGTH} characters (got ${request.name.length})`,
      'NFT_INVALID_METADATA',
    );
  }

  // description — required, 1-4096 chars
  if (typeof request.description !== 'string' || request.description.length === 0) {
    throw new SphereError('Collection description is required and must be non-empty', 'NFT_INVALID_METADATA');
  }
  if (request.description.length > NFT_MAX_DESCRIPTION_LENGTH) {
    throw new SphereError(
      `Collection description must be at most ${NFT_MAX_DESCRIPTION_LENGTH} characters (got ${request.description.length})`,
      'NFT_INVALID_METADATA',
    );
  }

  // maxSupply — optional, if set: integer, 1 ≤ n ≤ 1,000,000
  if (request.maxSupply !== undefined && request.maxSupply !== null) {
    if (
      typeof request.maxSupply !== 'number' ||
      !Number.isInteger(request.maxSupply) ||
      request.maxSupply < 1 ||
      request.maxSupply > COLLECTION_MAX_SUPPLY_LIMIT
    ) {
      throw new SphereError(
        `maxSupply must be an integer between 1 and ${COLLECTION_MAX_SUPPLY_LIMIT} (got ${request.maxSupply})`,
        'NFT_INVALID_METADATA',
      );
    }
  }

  // image — optional, valid URI
  if (request.image !== undefined && request.image !== null) {
    if (typeof request.image !== 'string') {
      throw new SphereError('Collection image must be a string', 'NFT_INVALID_METADATA');
    }
    assertValidUri(request.image, 'image');
  }

  // externalUrl — optional, valid URL
  if (request.externalUrl !== undefined && request.externalUrl !== null) {
    if (typeof request.externalUrl !== 'string') {
      throw new SphereError('Collection externalUrl must be a string', 'NFT_INVALID_METADATA');
    }
    assertValidUri(request.externalUrl, 'externalUrl');
  }

  // royalty — optional, validate via validateRoyaltyConfig
  if (request.royalty !== undefined && request.royalty !== null) {
    validateRoyaltyConfig(request.royalty);
  }
}
