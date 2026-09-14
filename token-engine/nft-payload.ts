/**
 * NFT payload codec (#785, normative spec: docs/NFT-METADATA.md). Recognition is
 * display-only and never throws, so no path that can refuse a token may depend on
 * it. One validator set serves the encoder and the decoder alike.
 */
import { sha256 } from '@noble/hashes/sha2.js';

import { SphereError } from '../core/errors';

import {
  CborDeserializer,
  CborReader,
  CborSerializer,
  type DataHash,
  DataHasher,
  HashAlgorithm,
  HexConverter,
  MajorType,
  Signature,
  SigningService,
} from './sdk';

export const NFT_METADATA_TAG = 39052n;
export const NFT_MEDIA_TAG = 39053n;
export const NFT_LINK_TAG = 39054n;
export const NFT_SIGNED_TAG = 39055n;
export const NFT_FORMAT_VERSION = 1n;

/** An inline file. */
export interface NftMedia {
  readonly kind: 'media';
  readonly media_type: string;
  readonly bytes: Uint8Array;
}

/** A hosted file, pinned by the SHA-256 of its bytes (64 hex; decoded lowercase). */
export interface NftLink {
  readonly kind: 'link';
  readonly media_type: string;
  readonly uri: string;
  readonly sha256: string;
}

export type NftMediaRef = NftMedia | NftLink;

export interface NftAttribute {
  readonly trait_type: string;
  /** Text, or an integer within ±(2^53 − 1). Decimals and larger numbers are text. */
  readonly value: string | number;
}

/** ERC-721 field names; an absent optional field is `null`, never `''`. */
export interface NftMetadata {
  readonly kind: 'metadata';
  readonly name: string;
  readonly description: string | null;
  readonly image: NftMediaRef | null;
  readonly animation_url: NftMediaRef | null;
  readonly external_url: string | null;
  readonly attributes: readonly NftAttribute[];
  readonly collection: string | null;
}

export type NftContent = NftMetadata | NftMedia | NftLink;
export type NftSignatureStatus = 'unsigned' | 'valid' | 'invalid';

export interface ParsedNft {
  readonly content: NftContent;
  /** Present iff the top level is NftSigned. */
  readonly signed: {
    readonly creator: Uint8Array;
    readonly payload: Uint8Array;
    readonly signature: Uint8Array;
  } | null;
}

const METADATA_ARITY = 8;
const MEDIA_ARITY = 3;
const LINK_ARITY = 4;
const SIGNED_ARITY = 4;
const CREATOR_BYTES = 33;
const SIGNATURE_BYTES = 65;
const MAX_URI_LENGTH = 2048;
const LINK_SCHEMES = ['https://', 'ipfs://', 'ar://'];
const SIGNED_DOMAIN = 'NftSigned';
const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;
const LONE_SURROGATE = /\p{Cs}/u;
const CBOR_MAJOR_TYPE_MASK = 0b1110_0000;
const ATTRIBUTE_VALUE_RULE =
  'must be non-empty text or an integer within ±(2^53 − 1) — write decimals and larger numbers as text';
// The SDK's text decoder substitutes U+FFFD, which would recognise invalid UTF-8;
// ignoreBOM keeps a leading U+FEFF so a decoded string re-encodes byte-identically.
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// ── shared field rules (encoder and decoder) ────────────────────────────────

function refuse(field: string, rule: string, cause?: unknown): SphereError {
  return new SphereError(`Invalid NFT ${field}: ${rule}`, 'VALIDATION_ERROR', cause);
}

function ensure(ok: boolean, field: string, rule: string): void {
  if (!ok) throw refuse(field, rule);
}

const fieldName = (prefix: string, name: string): string => (prefix === '' ? name : `${prefix}.${name}`);

/** Non-empty and representable as UTF-8 exactly (a lone surrogate is not). */
const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !LONE_SURROGATE.test(value);

const isBytes = (value: unknown, length?: number): value is Uint8Array =>
  value instanceof Uint8Array && (length === undefined ? value.length > 0 : value.length === length);

const isMediaType = (value: unknown): boolean => typeof value === 'string' && MEDIA_TYPE_PATTERN.test(value);

const isAttributeValue = (value: unknown): boolean =>
  typeof value === 'number' ? Number.isSafeInteger(value) : isText(value);

function hasSpaceOrControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isLinkUri(value: unknown): boolean {
  if (!isText(value) || value.length > MAX_URI_LENGTH || hasSpaceOrControl(value)) return false;
  const scheme = LINK_SCHEMES.find((prefix) => value.startsWith(prefix));
  return scheme !== undefined && value.length > scheme.length;
}

function checkText(field: string, value: unknown): void {
  ensure(isText(value), field, 'must be non-empty, well-formed text');
}

function checkOptionalText(field: string, value: unknown): void {
  ensure(value === null || isText(value), field, 'must be null or non-empty, well-formed text');
}

function checkMediaType(field: string, value: unknown): void {
  ensure(isMediaType(value), field, 'must be a lowercase type/subtype media type without parameters');
}

function checkMedia(prefix: string, media: NftMedia): void {
  checkMediaType(fieldName(prefix, 'media_type'), media.media_type);
  ensure(isBytes(media.bytes), fieldName(prefix, 'bytes'), 'must be non-empty bytes');
}

function checkLink(prefix: string, link: NftLink): void {
  checkMediaType(fieldName(prefix, 'media_type'), link.media_type);
  ensure(
    isLinkUri(link.uri),
    fieldName(prefix, 'uri'),
    `must be an https://, ipfs:// or ar:// URI of at most ${MAX_URI_LENGTH} characters with no whitespace or control characters`,
  );
  ensure(
    typeof link.sha256 === 'string' && SHA256_HEX_PATTERN.test(link.sha256),
    fieldName(prefix, 'sha256'),
    'must be the 64-hex SHA-256 of the linked file',
  );
}

function checkMediaRef(field: string, ref: NftMediaRef | null): void {
  if (ref === null) return;
  if (ref?.kind === 'media') return checkMedia(field, ref);
  if (ref?.kind === 'link') return checkLink(field, ref);
  throw refuse(field, 'must be an NftMedia, an NftLink or null');
}

function checkAttributes(attributes: readonly NftAttribute[]): void {
  ensure(Array.isArray(attributes), 'attributes', 'must be an array — [] when there are none');
  // entries(), not forEach: a sparse array's holes must be refused, not skipped.
  for (const [index, attribute] of attributes.entries()) {
    checkText(`attributes[${index}].trait_type`, attribute?.trait_type);
    ensure(isAttributeValue(attribute?.value), `attributes[${index}].value`, ATTRIBUTE_VALUE_RULE);
  }
}

function checkMetadata(metadata: NftMetadata): void {
  checkText('name', metadata.name);
  checkOptionalText('description', metadata.description);
  checkMediaRef('image', metadata.image);
  checkMediaRef('animation_url', metadata.animation_url);
  checkOptionalText('external_url', metadata.external_url);
  checkAttributes(metadata.attributes);
  checkOptionalText('collection', metadata.collection);
}

function checkContent(content: NftContent): void {
  switch (content?.kind) {
    case 'metadata':
      return checkMetadata(content);
    case 'media':
      return checkMedia('', content);
    case 'link':
      return checkLink('', content);
    default:
      throw refuse('content', "kind must be 'metadata', 'media' or 'link'");
  }
}

function checkSignedParts(creator: unknown, signature: unknown): void {
  ensure(isBytes(creator, CREATOR_BYTES), 'creator', 'must be a 33-byte compressed secp256k1 public key');
  ensure(isBytes(signature, SIGNATURE_BYTES), 'signature', 'must be 65 bytes: r(32) ‖ s(32) ‖ recovery(1)');
}

// ── encoder ─────────────────────────────────────────────────────────────────

const text = (value: string): Uint8Array => CborSerializer.encodeTextString(value);

const optionalText = (value: string | null): Uint8Array =>
  CborSerializer.encodeNullable(value, CborSerializer.encodeTextString);

function versioned(tag: bigint, ...fields: Uint8Array[]): Uint8Array {
  return CborSerializer.encodeTag(
    tag,
    CborSerializer.encodeArray(CborSerializer.encodeUnsignedInteger(NFT_FORMAT_VERSION), ...fields),
  );
}

/** Major type 1 shares the unsigned head layout; the SDK serializer has no encoder for it. */
function integerCbor(value: number): Uint8Array {
  if (value >= 0) return CborSerializer.encodeUnsignedInteger(value);
  const head = CborSerializer.encodeUnsignedInteger(-1 - value);
  head[0] |= MajorType.NEGATIVE_INTEGER;
  return head;
}

function mediaCbor(media: NftMedia): Uint8Array {
  return versioned(NFT_MEDIA_TAG, text(media.media_type), CborSerializer.encodeByteString(media.bytes));
}

function linkCbor(link: NftLink): Uint8Array {
  const digest = HexConverter.decode(link.sha256.toLowerCase());
  return versioned(NFT_LINK_TAG, text(link.media_type), text(link.uri), CborSerializer.encodeByteString(digest));
}

function mediaRefCbor(ref: NftMediaRef | null): Uint8Array {
  if (ref === null) return CborSerializer.encodeNull();
  return ref.kind === 'media' ? mediaCbor(ref) : linkCbor(ref);
}

function attributeCbor({ trait_type, value }: NftAttribute): Uint8Array {
  return CborSerializer.encodeArray(text(trait_type), typeof value === 'string' ? text(value) : integerCbor(value));
}

/**
 * The SDK's array head over a list of any length. Spreading the list into
 * `encodeArray` arguments overflows the call stack past ~125k items (fewer in JSC).
 */
function arrayCbor(items: readonly Uint8Array[]): Uint8Array {
  const head = CborSerializer.encodeUnsignedInteger(items.length);
  head[0] |= MajorType.ARRAY;
  const out = new Uint8Array(items.reduce((length, item) => length + item.length, head.length));
  out.set(head);
  let offset = head.length;
  for (const item of items) {
    out.set(item, offset);
    offset += item.length;
  }
  return out;
}

function metadataCbor(metadata: NftMetadata): Uint8Array {
  return versioned(
    NFT_METADATA_TAG,
    text(metadata.name),
    optionalText(metadata.description),
    mediaRefCbor(metadata.image),
    mediaRefCbor(metadata.animation_url),
    optionalText(metadata.external_url),
    arrayCbor(metadata.attributes.map(attributeCbor)),
    optionalText(metadata.collection),
  );
}

/** Encode one unsigned item. Throws SphereError('…', 'VALIDATION_ERROR') naming the offending field. */
export function encodeNftContent(content: NftContent): Uint8Array {
  checkContent(content);
  if (content.kind === 'metadata') return metadataCbor(content);
  return content.kind === 'media' ? mediaCbor(content) : linkCbor(content);
}

/** Wrap an encoded unsigned item; `signature` is `Signature.encode()` over {@link nftSignedDigest}. */
export function encodeNftSigned(creator: Uint8Array, payload: Uint8Array, signature: Uint8Array): Uint8Array {
  checkSignedParts(creator, signature);
  checkContent(signablePayload(payload));
  return versioned(
    NFT_SIGNED_TAG,
    CborSerializer.encodeByteString(creator),
    payload,
    CborSerializer.encodeByteString(signature),
  );
}

function signablePayload(payload: Uint8Array): NftContent {
  try {
    return decodeItem(UNSIGNED_DECODERS, 'payload', payload);
  } catch (error) {
    throw refuse('payload', 'must be exactly one encoded NftMetadata, NftMedia or NftLink item', error);
  }
}

// ── decoder (structure only; value rules are the shared checks above) ──────

type BodyDecoder<T> = (body: Uint8Array) => T;

const majorTypeOf = (item: Uint8Array): MajorType => (item.at(0) ?? 0) & CBOR_MAJOR_TYPE_MASK;

function decodeText(item: Uint8Array): string {
  const reader = new CborReader(item);
  const bytes = reader.read(Number(reader.readLength(MajorType.TEXT_STRING)));
  reader.assertExhausted();
  return UTF8.decode(bytes);
}

const decodeOptionalText = (item: Uint8Array): string | null => CborDeserializer.decodeNullable(item, decodeText);

function decodeAttributeValue(item: Uint8Array): string | number {
  const major = majorTypeOf(item);
  if (major === MajorType.TEXT_STRING) return decodeText(item);
  const isInteger = major === MajorType.UNSIGNED_INTEGER || major === MajorType.NEGATIVE_INTEGER;
  ensure(isInteger, 'attribute value', ATTRIBUTE_VALUE_RULE);
  const reader = new CborReader(item);
  const magnitude = reader.readLength(major);
  reader.assertExhausted();
  return Number(major === MajorType.UNSIGNED_INTEGER ? magnitude : -1n - magnitude);
}

function decodeAttributes(item: Uint8Array): NftAttribute[] {
  return CborDeserializer.decodeArray(item).map((entry) => {
    const [traitType, value] = CborDeserializer.decodeArray(entry, 2);
    return { trait_type: decodeText(traitType), value: decodeAttributeValue(value) };
  });
}

function versionedFields(body: Uint8Array, arity: number): Uint8Array[] {
  const fields = CborDeserializer.decodeArray(body, arity);
  ensure(CborDeserializer.decodeUnsignedInteger(fields[0]) === NFT_FORMAT_VERSION, 'version', 'must be 1');
  return fields;
}

function decodeMedia(body: Uint8Array): NftMedia {
  const [, mediaType, bytes] = versionedFields(body, MEDIA_ARITY);
  return { kind: 'media', media_type: decodeText(mediaType), bytes: CborDeserializer.decodeByteString(bytes) };
}

function decodeLink(body: Uint8Array): NftLink {
  const [, mediaType, uri, digest] = versionedFields(body, LINK_ARITY);
  return {
    kind: 'link',
    media_type: decodeText(mediaType),
    uri: decodeText(uri),
    sha256: HexConverter.encode(CborDeserializer.decodeByteString(digest)),
  };
}

function decodeMetadata(body: Uint8Array): NftMetadata {
  const fields = versionedFields(body, METADATA_ARITY);
  return {
    kind: 'metadata',
    name: decodeText(fields[1]),
    description: decodeOptionalText(fields[2]),
    image: decodeMediaRef('image', fields[3]),
    animation_url: decodeMediaRef('animation_url', fields[4]),
    external_url: decodeOptionalText(fields[5]),
    attributes: decodeAttributes(fields[6]),
    collection: decodeOptionalText(fields[7]),
  };
}

// The nesting rules: a media slot holds NftMedia or NftLink; NftSigned wraps any
// unsigned item and itself appears only at the top level.
const MEDIA_REF_DECODERS: ReadonlyMap<bigint, BodyDecoder<NftMediaRef>> = new Map<bigint, BodyDecoder<NftMediaRef>>([
  [NFT_MEDIA_TAG, decodeMedia],
  [NFT_LINK_TAG, decodeLink],
]);
const UNSIGNED_DECODERS: ReadonlyMap<bigint, BodyDecoder<NftContent>> = new Map<bigint, BodyDecoder<NftContent>>([
  [NFT_METADATA_TAG, decodeMetadata],
  [NFT_MEDIA_TAG, decodeMedia],
  [NFT_LINK_TAG, decodeLink],
]);

function decodeBody<T>(decoders: ReadonlyMap<bigint, BodyDecoder<T>>, field: string, tag: bigint, body: Uint8Array): T {
  const decode = decoders.get(tag);
  if (decode === undefined) throw refuse(field, `tag ${tag} is not allowed here`);
  return decode(body);
}

function decodeItem<T>(decoders: ReadonlyMap<bigint, BodyDecoder<T>>, field: string, item: Uint8Array): T {
  const { tag, data } = CborDeserializer.decodeTag(item);
  return decodeBody(decoders, field, tag, data);
}

function decodeMediaRef(field: string, item: Uint8Array): NftMediaRef | null {
  return CborDeserializer.decodeNullable(item, (ref) => decodeItem(MEDIA_REF_DECODERS, field, ref));
}

function decodeSigned(body: Uint8Array): ParsedNft {
  const [, creatorItem, payload, signatureItem] = versionedFields(body, SIGNED_ARITY);
  const creator = CborDeserializer.decodeByteString(creatorItem);
  const signature = CborDeserializer.decodeByteString(signatureItem);
  checkSignedParts(creator, signature);
  return { content: decodeItem(UNSIGNED_DECODERS, 'payload', payload), signed: { creator, payload, signature } };
}

function decodePayload(data: Uint8Array): ParsedNft {
  const { tag, data: body } = CborDeserializer.decodeTag(data);
  if (tag === NFT_SIGNED_TAG) return decodeSigned(body);
  return { content: decodeBody(UNSIGNED_DECODERS, 'payload', tag, body), signed: null };
}

/** Structural parse of a genesis payload. NEVER throws; null = not a recognised NFT. */
export function parseNftPayload(data: Uint8Array | null): ParsedNft | null {
  if (data === null) return null;
  try {
    const parsed = decodePayload(data);
    checkContent(parsed.content);
    return parsed;
  } catch {
    return null;
  }
}

// ── signature ───────────────────────────────────────────────────────────────

/** SHA-256 of CBOR `["NftSigned", tokenId, genesis recipient predicate, bstr(payload)]`. */
export function nftSignedDigest(
  tokenIdCbor: Uint8Array,
  recipientPredicateCbor: Uint8Array,
  payload: Uint8Array,
): Promise<DataHash> {
  const preimage = CborSerializer.encodeArray(
    CborSerializer.encodeTextString(SIGNED_DOMAIN),
    tokenIdCbor,
    recipientPredicateCbor,
    CborSerializer.encodeByteString(payload),
  );
  return new DataHasher(HashAlgorithm.SHA256).update(preimage).digest();
}

/** Recovering verification: binds the recovery byte and refuses high-s. Never throws. */
export async function verifyNftSignature(
  signed: NonNullable<ParsedNft['signed']>,
  tokenIdCbor: Uint8Array,
  recipientPredicateCbor: Uint8Array,
): Promise<Exclude<NftSignatureStatus, 'unsigned'>> {
  try {
    if (!SigningService.isPublicKeyValid(signed.creator)) return 'invalid';
    const signature = Signature.decode(signed.signature);
    const digest = await nftSignedDigest(tokenIdCbor, recipientPredicateCbor, signed.payload);
    return (await SigningService.verifyWithPublicKey(digest, signature, signed.creator)) ? 'valid' : 'invalid';
  } catch {
    return 'invalid';
  }
}

/** Does `bytes` match the link's sha256? Pure, sync. */
export function verifyNftLinkContent(link: NftLink, bytes: Uint8Array): boolean {
  return HexConverter.encode(sha256(bytes)) === link.sha256.toLowerCase();
}
