/**
 * Canonical serialization for NFT token data and collection definitions.
 *
 * Produces deterministic JSON strings suitable for SHA-256 hashing when
 * deriving collection IDs and token IDs.
 *
 * Serialization rules (per §2 of NFT-SPEC.md):
 *
 * 1. Strict alphabetical key ordering at every nesting level.
 * 2. Null normalization: absent optional fields → null.
 * 3. Attribute sorting: metadata.attributes sorted by trait_type (ascending).
 * 4. Compact JSON: no whitespace, no pretty-printing.
 * 5. String encoding: UTF-8.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import type { NFTTokenData, NFTMetadata, NFTAttribute, NFTContent, CollectionDefinition } from './types';

export { NFT_TOKEN_TYPE_HEX } from '../../constants.js';

/**
 * Produce a deterministic JSON string from NFTTokenData.
 *
 * Top-level key order: collectionId, edition, metadata, mintedAt, minter, totalEditions
 *
 * @param data - NFT token data to serialize
 * @returns Compact, deterministic JSON string
 */
export function canonicalSerializeNFT(data: NFTTokenData): string {
  const sorted: Record<string, unknown> = {};

  sorted.collectionId = data.collectionId ?? null;
  sorted.edition = data.edition;
  sorted.metadata = serializeMetadata(data.metadata);
  sorted.mintedAt = data.mintedAt;
  sorted.minter = data.minter ?? null;
  sorted.totalEditions = data.totalEditions;

  return JSON.stringify(sorted);
}

/**
 * Serialize NFTMetadata with strict key ordering.
 *
 * Key order: animationUrl, attributes, backgroundColor, content, description,
 *            externalUrl, image, name, properties
 */
function serializeMetadata(m: NFTMetadata): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};

  sorted.animationUrl = m.animationUrl ?? null;
  sorted.attributes = m.attributes
    ? [...m.attributes]
        .sort((a, b) => (a.trait_type < b.trait_type ? -1 : a.trait_type > b.trait_type ? 1 : 0))
        .map(serializeAttribute)
    : null;
  sorted.backgroundColor = m.backgroundColor ?? null;
  sorted.content = m.content ? serializeContent(m.content) : null;
  sorted.description = m.description ?? null;
  sorted.externalUrl = m.externalUrl ?? null;
  sorted.image = m.image;
  sorted.name = m.name;
  sorted.properties = m.properties ?? null;

  return sorted;
}

/**
 * Serialize a single NFTAttribute with strict key ordering.
 *
 * Key order: display_type, max_value, trait_type, value
 */
function serializeAttribute(attr: NFTAttribute): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};

  sorted.display_type = attr.display_type ?? null;
  sorted.max_value = attr.max_value ?? null;
  sorted.trait_type = attr.trait_type;
  sorted.value = attr.value;

  return sorted;
}

/**
 * Serialize NFTContent with strict key ordering.
 *
 * Key order: full, original, preview, thumbnail
 */
function serializeContent(c: NFTContent): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};

  sorted.full = c.full ?? null;
  sorted.original = c.original ?? null;
  sorted.preview = c.preview ?? null;
  sorted.thumbnail = c.thumbnail ?? null;

  return sorted;
}

/**
 * Produce a deterministic JSON string from a CollectionDefinition.
 *
 * Key order: createdAt, creator, description, deterministicMinting, externalUrl,
 *            image, maxSupply, name, royalty, transferable
 *
 * @param def - Collection definition to serialize
 * @returns Compact, deterministic JSON string
 */
export function canonicalSerializeCollection(def: CollectionDefinition): string {
  const sorted: Record<string, unknown> = {};

  sorted.createdAt = def.createdAt;
  sorted.creator = def.creator;
  sorted.description = def.description;
  sorted.deterministicMinting = def.deterministicMinting ?? false;
  sorted.externalUrl = def.externalUrl ?? null;
  sorted.image = def.image ?? null;
  sorted.maxSupply = def.maxSupply ?? null;
  sorted.name = def.name;
  sorted.royalty = def.royalty
    ? { basisPoints: def.royalty.basisPoints, recipient: def.royalty.recipient }
    : null;
  sorted.transferable = def.transferable ?? true;

  return JSON.stringify(sorted);
}

/**
 * Derive a deterministic collection ID from its definition.
 *
 * collectionId = hex(SHA-256(UTF-8(canonicalSerializeCollection(def))))
 *
 * @param def - Collection definition
 * @returns 64-char lowercase hex string
 */
export function deriveCollectionId(def: CollectionDefinition): string {
  const serialized = canonicalSerializeCollection(def);
  const hash = sha256(new TextEncoder().encode(serialized));
  return bytesToHex(hash);
}

/**
 * Parse an NFTTokenData JSON string, validating required fields.
 *
 * @param tokenDataStr - JSON string to parse
 * @returns Parsed NFTTokenData or null on any parse/validation error
 */
export function parseNFTTokenData(tokenDataStr: string): NFTTokenData | null {
  try {
    const parsed = JSON.parse(tokenDataStr);

    // Validate required fields
    if (
      parsed == null ||
      typeof parsed !== 'object' ||
      parsed.metadata == null ||
      typeof parsed.metadata !== 'object' ||
      typeof parsed.metadata.name !== 'string' ||
      typeof parsed.metadata.image !== 'string' ||
      typeof parsed.mintedAt !== 'number'
    ) {
      return null;
    }

    return parsed as NFTTokenData;
  } catch {
    return null;
  }
}
