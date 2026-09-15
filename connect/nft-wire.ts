/**
 * JSON wire form of NFT content for the `mint_nft` Connect intent: `NftContent` with every inline
 * `NftMedia.bytes` as base64, because Connect messages are JSON. Shape only — the value rules
 * (text, media types, URIs, the payload cap) stay in `encodeNftContent`.
 */
import { base64DecodeCanonical, base64Encode } from '../core/base64';
import { SphereError } from '../core/errors';
import type {
  NftAttribute,
  NftContent,
  NftLink,
  NftMedia,
  NftMediaRef,
  NftMetadata,
} from '../token-engine/nft-payload';

/** An inline file; `bytes` is standard base64 (RFC 4648 §4, with padding). */
export interface WireNftMedia {
  readonly kind: 'media';
  readonly media_type: string;
  readonly bytes: string;
}

export interface WireNftMetadata {
  readonly kind: 'metadata';
  readonly name: string;
  readonly description: string | null;
  readonly image: WireNftMedia | NftLink | null;
  readonly animation_url: WireNftMedia | NftLink | null;
  readonly external_url: string | null;
  readonly attributes: readonly NftAttribute[];
  readonly collection: string | null;
  /** Hex, passed through unchanged; `encodeNftContent` judges its value. */
  readonly collection_id: string | null;
}

export type WireNftContent = WireNftMetadata | WireNftMedia | NftLink;

/** A type alias, not an interface, so a typed value passes as `ConnectClient.intent` params. */
export type MintNftIntentParams = {
  readonly content: WireNftContent;
  /** Default `true`: the wallet wraps the payload in NftSigned with its chain key as creator. */
  readonly sign?: boolean;
};

export interface MintNftIntentResult {
  /** 64 lowercase hex. */
  readonly tokenId: string;
}

type WireRecord = Record<string, unknown>;

const METADATA_FIELDS: readonly string[] = [
  'kind', 'name', 'description', 'image', 'animation_url', 'external_url', 'attributes', 'collection', 'collection_id',
];
const MEDIA_FIELDS: readonly string[] = ['kind', 'media_type', 'bytes'];
const LINK_FIELDS: readonly string[] = ['kind', 'media_type', 'uri', 'sha256'];
const ATTRIBUTE_FIELDS: readonly string[] = ['trait_type', 'value'];
const CONTENT_KINDS = "must be 'metadata', 'media' or 'link'";
const MEDIA_REF_KINDS = "must be 'media' or 'link'";

function refuse(field: string, rule: string): SphereError {
  return new SphereError(`Invalid NFT ${field}: ${rule}`, 'VALIDATION_ERROR');
}

// ── to wire ─────────────────────────────────────────────────────────────────

function mediaToWire(media: NftMedia, field: string): WireNftMedia {
  if (!(media.bytes instanceof Uint8Array)) throw refuse(`${field}.bytes`, 'must be a Uint8Array');
  return { kind: 'media', media_type: media.media_type, bytes: base64Encode(media.bytes) };
}

function linkToWire(link: NftLink): NftLink {
  return { kind: 'link', media_type: link.media_type, uri: link.uri, sha256: link.sha256 };
}

function mediaRefToWire(ref: NftMediaRef | null, field: string): WireNftMedia | NftLink | null {
  if (ref === null) return null;
  if (ref?.kind === 'media') return mediaToWire(ref, field);
  if (ref?.kind === 'link') return linkToWire(ref);
  throw refuse(`${field}.kind`, MEDIA_REF_KINDS);
}

function metadataToWire(metadata: NftMetadata): WireNftMetadata {
  return {
    kind: 'metadata',
    name: metadata.name,
    description: metadata.description,
    image: mediaRefToWire(metadata.image, 'content.image'),
    animation_url: mediaRefToWire(metadata.animation_url, 'content.animation_url'),
    external_url: metadata.external_url,
    attributes: metadata.attributes.map(({ trait_type, value }) => ({ trait_type, value })),
    collection: metadata.collection,
    collection_id: metadata.collection_id,
  };
}

/** `NftContent` → its JSON wire form. Inline bytes become base64; every other field is copied unchanged. */
export function nftContentToWire(content: NftContent): WireNftContent {
  switch (content?.kind) {
    case 'metadata':
      return metadataToWire(content);
    case 'media':
      return mediaToWire(content, 'content');
    case 'link':
      return linkToWire(content);
    default:
      throw refuse('content.kind', CONTENT_KINDS);
  }
}

// ── from wire ───────────────────────────────────────────────────────────────

function recordAt(value: unknown, field: string, rule = 'must be an object'): WireRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw refuse(field, rule);
  return value as WireRecord;
}

function requireExactFields(record: WireRecord, field: string, fields: readonly string[]): void {
  const missing = fields.find((name) => !Object.prototype.hasOwnProperty.call(record, name));
  if (missing !== undefined) throw refuse(`${field}.${missing}`, 'is missing — an absent optional field is null');
  const extra = Object.keys(record).find((name) => !fields.includes(name));
  if (extra !== undefined) throw refuse(`${field}.${extra}`, 'is not a field of this item');
}

function stringAt(record: WireRecord, field: string, name: string): string {
  const value = record[name];
  if (typeof value !== 'string') throw refuse(`${field}.${name}`, 'must be a string');
  return value;
}

function optionalStringAt(record: WireRecord, field: string, name: string): string | null {
  const value = record[name];
  if (value === null) return null;
  if (typeof value !== 'string') throw refuse(`${field}.${name}`, 'must be a string or null');
  return value;
}

function mediaFromWire(record: WireRecord, field: string): NftMedia {
  requireExactFields(record, field, MEDIA_FIELDS);
  const mediaType = stringAt(record, field, 'media_type');
  const bytes = base64DecodeCanonical(stringAt(record, field, 'bytes'));
  if (bytes === null) throw refuse(`${field}.bytes`, 'must be canonical standard base64 with padding (RFC 4648 §4)');
  return { kind: 'media', media_type: mediaType, bytes };
}

function linkFromWire(record: WireRecord, field: string): NftLink {
  requireExactFields(record, field, LINK_FIELDS);
  return {
    kind: 'link',
    media_type: stringAt(record, field, 'media_type'),
    uri: stringAt(record, field, 'uri'),
    sha256: stringAt(record, field, 'sha256'),
  };
}

function mediaRefFromWire(value: unknown, field: string): NftMediaRef | null {
  if (value === null) return null;
  const record = recordAt(value, field, 'must be a media or link object, or null');
  if (record.kind === 'media') return mediaFromWire(record, field);
  if (record.kind === 'link') return linkFromWire(record, field);
  throw refuse(`${field}.kind`, MEDIA_REF_KINDS);
}

function attributeFromWire(value: unknown, field: string): NftAttribute {
  const record = recordAt(value, field);
  requireExactFields(record, field, ATTRIBUTE_FIELDS);
  const traitType = stringAt(record, field, 'trait_type');
  const attributeValue = record.value;
  if (typeof attributeValue !== 'string' && typeof attributeValue !== 'number') {
    throw refuse(`${field}.value`, 'must be a string or a number');
  }
  return { trait_type: traitType, value: attributeValue };
}

function attributesFromWire(value: unknown, field: string): NftAttribute[] {
  if (!Array.isArray(value)) throw refuse(field, 'must be an array — [] when there are none');
  return Array.from(value, (entry: unknown, index) => attributeFromWire(entry, `${field}[${index}]`));
}

function metadataFromWire(record: WireRecord): NftMetadata {
  requireExactFields(record, 'content', METADATA_FIELDS);
  return {
    kind: 'metadata',
    name: stringAt(record, 'content', 'name'),
    description: optionalStringAt(record, 'content', 'description'),
    image: mediaRefFromWire(record.image, 'content.image'),
    animation_url: mediaRefFromWire(record.animation_url, 'content.animation_url'),
    external_url: optionalStringAt(record, 'content', 'external_url'),
    attributes: attributesFromWire(record.attributes, 'content.attributes'),
    collection: optionalStringAt(record, 'content', 'collection'),
    collection_id: optionalStringAt(record, 'content', 'collection_id'),
  };
}

/**
 * The wire form → `NftContent`. Checks shape and base64 only, throwing a `SphereError`
 * (`VALIDATION_ERROR`) whose message names the offending field.
 */
export function nftContentFromWire(wire: unknown): NftContent {
  const record = recordAt(wire, 'content');
  switch (record.kind) {
    case 'metadata':
      return metadataFromWire(record);
    case 'media':
      return mediaFromWire(record, 'content');
    case 'link':
      return linkFromWire(record, 'content');
    default:
      throw refuse('content.kind', CONTENT_KINDS);
  }
}
