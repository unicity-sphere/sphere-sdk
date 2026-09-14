/**
 * #785 — the NFT payload codec (docs/NFT-METADATA.md).
 *
 * Recognition is display-only: a malformed payload reads as "not a recognised
 * NFT" (null) and never throws, because a throw on a receive path refuses a token
 * wallet-api accepted. The encoder and the parser apply the same rules, so what
 * one accepts the other reproduces byte for byte. The signed digest is a
 * cross-SDK contract, so its preimage and hash are pinned.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';

import { SphereError } from '../../../core/errors';
import {
  encodeNftContent,
  encodeNftSigned,
  NFT_FORMAT_VERSION,
  NFT_LINK_TAG,
  NFT_MEDIA_TAG,
  NFT_METADATA_TAG,
  NFT_SIGNED_TAG,
  nftSignedDigest,
  parseNftPayload,
  verifyNftLinkContent,
  verifyNftSignature,
  type NftAttribute,
  type NftContent,
  type NftLink,
  type NftMedia,
  type NftMetadata,
  type ParsedNft,
} from '../../../token-engine/nft-payload';
import {
  CborSerializer,
  EncodedPredicate,
  HashAlgorithm,
  HexConverter,
  SignaturePredicate,
  SigningService,
  TokenId,
} from '../../../token-engine/sdk';
import { SpherePaymentData } from '../../../token-engine/SpherePaymentData';
import { assertMintableData, classifyValueEnvelope } from '../../../token-engine/value-envelope';

type Signed = NonNullable<ParsedNft['signed']>;

const C = CborSerializer;
const hex = (bytes: Uint8Array): string => HexConverter.encode(bytes);
const raw = (value: string): Uint8Array => HexConverter.decode(value);
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const uint = (value: number | bigint): Uint8Array => C.encodeUnsignedInteger(value);
const tstr = (value: string): Uint8Array => C.encodeTextString(value);
const bstr = (value: Uint8Array): Uint8Array => C.encodeByteString(value);
const NULL = C.encodeNull();
const filled = (length: number, byte: number): Uint8Array => new Uint8Array(length).fill(byte);
/** Deliberately ill-typed input, for the refusals a TypeScript caller cannot write. */
const bad = <T>(value: unknown): T => value as T;

const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const withByte = (bytes: Uint8Array, index: number, change: (byte: number) => number): Uint8Array => {
  const out = bytes.slice();
  out[index] = change(out[index]);
  return out;
};

/** A CBOR negative integer, built by hand: the SDK serializer has no encoder for major type 1. */
function nint(value: bigint): Uint8Array {
  const head = C.encodeUnsignedInteger(-1n - value);
  head[0] |= 0x20;
  return head;
}

const tagged = (tag: bigint, fields: readonly Uint8Array[]): Uint8Array => C.encodeTag(tag, C.encodeArray(...fields));

// ── content fixtures ────────────────────────────────────────────────────────

const PNG = raw('89504e470d0a1a0a0000000d49484452');
const LOGO_SHA256 = 'acc52f7f4e3c271cacb6e633ec8c8508ee74e1415384b8bfd889d6cf0251245c';

const media: NftMedia = { kind: 'media', media_type: 'image/png', bytes: PNG };
const link: NftLink = {
  kind: 'link',
  media_type: 'video/mp4',
  uri: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/1.mp4',
  sha256: LOGO_SHA256,
};
const metadata: NftMetadata = {
  kind: 'metadata',
  name: 'Cool Cat #1',
  description: 'A ginger cat',
  image: media,
  animation_url: link,
  external_url: 'https://coolcats.example',
  attributes: [
    { trait_type: 'Fur', value: 'Ginger' },
    { trait_type: 'Lives', value: 9 },
    { trait_type: 'Debt', value: -42 },
  ],
  collection: 'Cool Cats',
};
const minimal: NftMetadata = {
  kind: 'metadata',
  name: 'Cat',
  description: null,
  image: null,
  animation_url: null,
  external_url: null,
  attributes: [],
  collection: null,
};

const FORMS: readonly [name: string, content: NftContent][] = [
  ['NftMetadata with an inline image, a linked animation and text and integer attributes', metadata],
  ['NftMetadata with every optional field null and no attributes', minimal],
  ['a bare NftMedia', media],
  ['a bare NftLink', link],
];

// ── signing fixtures ────────────────────────────────────────────────────────

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
// The public key of private key 1 (the generator point), so the vector is reproducible anywhere.
const RECIPIENT_PUBKEY = raw('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
const OTHER_PUBKEY = new SigningService(filled(32, 0x22)).publicKey;
const CREATOR = new SigningService(filled(32, 0x11));
const TOKEN_ID = raw('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
const TOKEN_ID_CBOR = TokenId.fromCBOR(bstr(TOKEN_ID)).toCBOR();
const recipientCbor = (pubkey: Uint8Array): Uint8Array =>
  EncodedPredicate.fromPredicate(SignaturePredicate.create(pubkey)).toCBOR();
const RECIPIENT_CBOR = recipientCbor(RECIPIENT_PUBKEY);

async function signedPayload(payload: Uint8Array, signer = CREATOR): Promise<Uint8Array> {
  const signature = await signer.sign(await nftSignedDigest(TOKEN_ID_CBOR, RECIPIENT_CBOR, payload));
  return encodeNftSigned(signer.publicKey, payload, signature.encode());
}

// ── hand-built structures: every rejection below changes exactly ONE thing ──

const MEDIA_FIELDS: readonly Uint8Array[] = [uint(1), tstr('image/png'), bstr(PNG)];
const LINK_FIELDS: readonly Uint8Array[] = [
  uint(1),
  tstr('image/png'),
  tstr('https://example.com/cat.png'),
  bstr(filled(32, 7)),
];
const METADATA_FIELDS: readonly Uint8Array[] = [uint(1), tstr('Cat'), NULL, NULL, NULL, NULL, C.encodeArray(), NULL];
const MEDIA_ITEM = tagged(NFT_MEDIA_TAG, MEDIA_FIELDS);
// Structurally complete: a 33-byte creator that is not a curve point is still recognised.
const SIGNED_FIELDS: readonly Uint8Array[] = [uint(1), bstr(filled(33, 2)), MEDIA_ITEM, bstr(filled(65, 1))];
const METADATA_ITEM = tagged(NFT_METADATA_TAG, METADATA_FIELDS);
const SIGNED_ITEM = tagged(NFT_SIGNED_TAG, SIGNED_FIELDS);

const STRUCTURES: readonly [name: string, tag: bigint, fields: readonly Uint8Array[]][] = [
  ['NftMetadata', NFT_METADATA_TAG, METADATA_FIELDS],
  ['NftMedia', NFT_MEDIA_TAG, MEDIA_FIELDS],
  ['NftLink', NFT_LINK_TAG, LINK_FIELDS],
  ['NftSigned', NFT_SIGNED_TAG, SIGNED_FIELDS],
];

const withField = (fields: readonly Uint8Array[], index: number, value: Uint8Array): Uint8Array[] =>
  fields.map((field, i) => (i === index ? value : field));
const metadataWith = (index: number, value: Uint8Array): Uint8Array =>
  tagged(NFT_METADATA_TAG, withField(METADATA_FIELDS, index, value));
const mediaWith = (index: number, value: Uint8Array): Uint8Array =>
  tagged(NFT_MEDIA_TAG, withField(MEDIA_FIELDS, index, value));
const linkWith = (index: number, value: Uint8Array): Uint8Array =>
  tagged(NFT_LINK_TAG, withField(LINK_FIELDS, index, value));
const signedWith = (index: number, value: Uint8Array): Uint8Array =>
  tagged(NFT_SIGNED_TAG, withField(SIGNED_FIELDS, index, value));
const withAttribute = (...items: Uint8Array[]): Uint8Array => metadataWith(6, C.encodeArray(C.encodeArray(...items)));

const VALUE_ENVELOPE = await SpherePaymentData.fromValue({
  assets: [{ coinId: 'aa'.repeat(32), amount: 1000n }],
}).encode();

describe('NFT payload — tags', () => {
  it('uses tags 39052–39055 at format version 1', () => {
    expect([NFT_METADATA_TAG, NFT_MEDIA_TAG, NFT_LINK_TAG, NFT_SIGNED_TAG, NFT_FORMAT_VERSION]).toEqual([
      39052n,
      39053n,
      39054n,
      39055n,
      1n,
    ]);
  });
});

describe('NFT payload — round trip', () => {
  it.each(FORMS)('parses back %s', (_name, content) => {
    expect(parseNftPayload(encodeNftContent(content))).toEqual({ content, signed: null });
  });

  it.each(FORMS)('parses back NftSigned over %s', async (_name, content) => {
    const payload = encodeNftContent(content);
    const parsed = parseNftPayload(await signedPayload(payload));
    expect(parsed?.content).toEqual(content);
    expect(parsed?.signed?.creator).toEqual(CREATOR.publicKey);
    expect(parsed?.signed?.payload).toEqual(payload);
    expect(parsed?.signed?.signature).toHaveLength(65);
  });

  it('encodes deterministically: equal content gives identical bytes', () => {
    expect(hex(encodeNftContent(structuredClone(metadata)))).toBe(hex(encodeNftContent(metadata)));
  });

  it('lays NftMetadata out as tag(39052)[1, name, description, image, animation_url, external_url, attributes, collection]', () => {
    const expected = tagged(NFT_METADATA_TAG, [
      uint(1),
      tstr('Cool Cat #1'),
      tstr('A ginger cat'),
      tagged(NFT_MEDIA_TAG, [uint(1), tstr('image/png'), bstr(PNG)]),
      tagged(NFT_LINK_TAG, [uint(1), tstr('video/mp4'), tstr(link.uri), bstr(raw(LOGO_SHA256))]),
      tstr('https://coolcats.example'),
      C.encodeArray(
        C.encodeArray(tstr('Fur'), tstr('Ginger')),
        C.encodeArray(tstr('Lives'), uint(9)),
        C.encodeArray(tstr('Debt'), nint(-42n)),
      ),
      tstr('Cool Cats'),
    ]);
    expect(hex(encodeNftContent(metadata))).toBe(hex(expected));
  });

  it('pins the bytes of the small examples in docs/NFT-METADATA.md', () => {
    expect(hex(encodeNftContent({ kind: 'media', media_type: 'text/plain', bytes: utf8('hi') }))).toBe(
      'd9988d83016a746578742f706c61696e426869',
    );
    const lives: NftMetadata = {
      ...minimal,
      attributes: [
        { trait_type: 'Lives', value: 9 },
        { trait_type: 'Debt', value: -42 },
      ],
    };
    expect(hex(encodeNftContent(lives))).toBe('d9988c880163436174f6f6f6f68282654c69766573098264446562743829f6');
  });

  it('writes an upper-case link digest as bytes and reads it back in lower case', () => {
    const parsed = parseNftPayload(encodeNftContent({ ...link, sha256: LOGO_SHA256.toUpperCase() }));
    expect(parsed?.content).toEqual(link);
  });

  it('round-trips every integer head width and both safe-integer bounds', () => {
    const values = [
      0, 1, 23, 24, 255, 256, 65535, 65536, 2 ** 32, Number.MAX_SAFE_INTEGER,
      -1, -24, -25, -256, -257, -(2 ** 32) - 1, -Number.MAX_SAFE_INTEGER,
    ];
    const content: NftMetadata = {
      ...minimal,
      attributes: values.map((value, index) => ({ trait_type: `t${index}`, value })),
    };
    expect(parseNftPayload(encodeNftContent(content))?.content).toEqual(content);
  });

  it('writes the attributes array exactly as the SDK array encoder does', () => {
    const entry = C.encodeArray(tstr('t'), uint(1));
    for (const count of [0, 1, 23, 24, 255, 256, 1000]) {
      const expected = tagged(NFT_METADATA_TAG, [
        uint(1), tstr('Cat'), NULL, NULL, NULL, NULL, C.encodeArray(...new Array<Uint8Array>(count).fill(entry)), NULL,
      ]);
      const attributes = Array.from({ length: count }, () => ({ trait_type: 't', value: 1 }));
      expect(hex(encodeNftContent({ ...minimal, attributes }))).toBe(hex(expected));
    }
  });

  // An argument spread overflows the stack past ~125k items in V8 (~65k in JSC), where a
  // hand-built payload the parser recognises would have no encoder.
  it.each([
    [65_535, '99ffff'],
    [65_536, '9a00010000'],
    [200_000, '9a00030d40'],
  ])('encodes %i attributes, and parsing gives back content that re-encodes to the same bytes', (count, head) => {
    const content: NftMetadata = {
      ...minimal,
      attributes: Array.from({ length: count }, (_, index) => ({ trait_type: 't', value: index % 1000 })),
    };

    const bytes = encodeNftContent(content);

    // tag(39052) array(8) 1 "Cat" null null null null = 13 bytes, then the attributes head.
    expect(hex(bytes.subarray(13, 13 + head.length / 2))).toBe(head);
    const parsed = parseNftPayload(bytes);
    expect(parsed?.content.kind === 'metadata' && parsed.content.attributes.length).toBe(count);
    expect(hex(encodeNftContent(parsed!.content))).toBe(hex(bytes));
  }, 30_000);

  it('accepts the boundary form of every text rule', () => {
    const edge: NftMetadata = {
      ...minimal,
      // A leading BOM survives the fatal decoder; a surrogate PAIR is well-formed.
      name: '﻿cat \u{1F408}',
      description: '� is an ordinary character when it is really there',
      image: { kind: 'media', media_type: 'a!#$&^_.+-/b', bytes: new Uint8Array([0]) },
      animation_url: {
        kind: 'link',
        media_type: `${'a'.repeat(127)}/${'b'.repeat(127)}`,
        uri: `ar://${'x'.repeat(2048 - 'ar://'.length)}`,
        sha256: LOGO_SHA256,
      },
      external_url: 'mailto:cat@example.com',
      attributes: [{ trait_type: 'Motto', value: '3.5' }],
    };
    expect(parseNftPayload(encodeNftContent(edge))?.content).toEqual(edge);
    for (const uri of ['https://x', 'ipfs://x', 'ar://x']) {
      expect(parseNftPayload(encodeNftContent({ ...link, uri }))?.content).toEqual({ ...link, uri });
    }
  });
});

describe('NFT payload — the classifier reads it as coinless and the mint pre-flight accepts it', () => {
  it('classifies every valid encoding none_tag and passes assertMintableData', async () => {
    const unsigned = FORMS.map(([, content]) => encodeNftContent(content));
    const payloads = [...unsigned, ...(await Promise.all(unsigned.map((payload) => signedPayload(payload))))];
    for (const payload of payloads) {
      expect(classifyValueEnvelope(payload)).toEqual({ envelope: 'none_tag', value: null });
      expect(() => assertMintableData(payload)).not.toThrow();
    }
  });
});

describe('NFT payload — not recognised', () => {
  it.each(STRUCTURES)('recognises the unmodified %s every case below starts from', (_name, tag, fields) => {
    expect(parseNftPayload(tagged(tag, fields))).not.toBeNull();
  });

  const structural = STRUCTURES.flatMap(([name, tag, fields]): [string, Uint8Array][] => [
    [`${name} at version 0`, tagged(tag, withField(fields, 0, uint(0)))],
    [`${name} at version 2`, tagged(tag, withField(fields, 0, uint(2)))],
    [`${name} with the version as text "1"`, tagged(tag, withField(fields, 0, tstr('1')))],
    [`${name} with a non-canonical version head (18 01)`, tagged(tag, withField(fields, 0, raw('1801')))],
    [`${name} one field short`, tagged(tag, fields.slice(0, -1))],
    [`${name} one field long`, tagged(tag, [...fields, NULL])],
    [`${name} over a text string instead of an array`, C.encodeTag(tag, tstr('x'))],
    [`${name} followed by a trailing byte`, cat(tagged(tag, fields), NULL)],
    [`${name} truncated by one byte`, tagged(tag, fields).slice(0, -1)],
  ]);

  const metadataFields: readonly [string, Uint8Array][] = [
    ['an empty name', metadataWith(1, tstr(''))],
    ['a null name', metadataWith(1, NULL)],
    ['a name as bytes', metadataWith(1, bstr(utf8('Cat')))],
    ['a name that is invalid UTF-8 (ff fe)', metadataWith(1, raw('62fffe'))],
    ['a name holding a UTF-8-encoded lone surrogate (ed a0 80)', metadataWith(1, raw('63eda080'))],
    ['a name with an overlong UTF-8 encoding (c0 80)', metadataWith(1, raw('62c080'))],
    ['an empty description', metadataWith(2, tstr(''))],
    ['a description as bytes', metadataWith(2, bstr(PNG))],
    ['an image as text', metadataWith(3, tstr('https://example.com/cat.png'))],
    ['an image as an integer', metadataWith(3, uint(3))],
    ['NftMetadata as the image', metadataWith(3, METADATA_ITEM)],
    ['NftSigned (over a valid NftMedia) as the image', metadataWith(3, SIGNED_ITEM)],
    ['NftSigned as the animation_url', metadataWith(4, SIGNED_ITEM)],
    ['an image under an unknown tag', metadataWith(3, tagged(39056n, MEDIA_FIELDS))],
    ['an image that is an NftMedia with empty bytes', metadataWith(3, mediaWith(2, bstr(new Uint8Array(0))))],
    ['an empty external_url', metadataWith(5, tstr(''))],
    ['an external_url as bytes', metadataWith(5, bstr(utf8('https://x')))],
    ['null attributes', metadataWith(6, NULL)],
    ['attributes as text', metadataWith(6, tstr('Fur'))],
    ['an attribute that is not an array', metadataWith(6, C.encodeArray(tstr('Fur')))],
    ['an attribute of arity 1', withAttribute(tstr('Fur'))],
    ['an attribute of arity 3', withAttribute(tstr('Fur'), tstr('Ginger'), NULL)],
    ['an empty trait_type', withAttribute(tstr(''), tstr('Ginger'))],
    ['a trait_type as an integer', withAttribute(uint(1), tstr('Ginger'))],
    ['an empty text value', withAttribute(tstr('Fur'), tstr(''))],
    ['a float value (double 1.5)', withAttribute(tstr('Lives'), raw('fb3ff8000000000000'))],
    ['a half-float value', withAttribute(tstr('Lives'), raw('f93e00'))],
    ['a boolean value', withAttribute(tstr('Cute'), raw('f5'))],
    ['a null value', withAttribute(tstr('Cute'), NULL)],
    ['a byte-string value', withAttribute(tstr('Cute'), bstr(PNG))],
    ['the integer value 2^53', withAttribute(tstr('Lives'), uint(2n ** 53n))],
    ['the integer value −2^53', withAttribute(tstr('Lives'), nint(-(2n ** 53n)))],
    ['the integer value 2^64 − 1', withAttribute(tstr('Lives'), uint(2n ** 64n - 1n))],
    ['an empty collection', metadataWith(7, tstr(''))],
    ['a collection as an integer', metadataWith(7, uint(1))],
  ];

  const mediaAndLinkFields: readonly [string, Uint8Array][] = [
    ['a media_type in upper case', mediaWith(1, tstr('Image/PNG'))],
    ['a media_type with a parameter', mediaWith(1, tstr('text/plain;charset=utf-8'))],
    ['a media_type with a spaced parameter', mediaWith(1, tstr('text/plain; charset=utf-8'))],
    ['a media_type without a slash', mediaWith(1, tstr('imagepng'))],
    ['a media_type with an empty subtype', mediaWith(1, tstr('image/'))],
    ['a media_type starting with a symbol', mediaWith(1, tstr('+image/png'))],
    ['a media_type part longer than 127 characters', mediaWith(1, tstr(`${'a'.repeat(128)}/png`))],
    ['a media_type as bytes', mediaWith(1, bstr(utf8('image/png')))],
    ['empty media bytes', mediaWith(2, bstr(new Uint8Array(0)))],
    ['media bytes as text', mediaWith(2, tstr('ffd8'))],
    ['a link media_type in upper case', linkWith(1, tstr('IMAGE/png'))],
    ['a uri over http://', linkWith(2, tstr('http://example.com/cat.png'))],
    ['a uri with an upper-case scheme', linkWith(2, tstr('HTTPS://example.com/cat.png'))],
    ['a uri with a data: scheme', linkWith(2, tstr('data:image/png;base64,iVBORw0KGgo='))],
    ['a uri that is only a scheme', linkWith(2, tstr('https://'))],
    ['a uri with a space', linkWith(2, tstr('https://example.com/a cat.png'))],
    ['a uri with a control character', linkWith(2, tstr('https://example.com/.png'))],
    ['a uri with DEL', linkWith(2, tstr('https://example.com/.png'))],
    ['a uri of 2049 characters', linkWith(2, tstr(`https://${'a'.repeat(2049 - 'https://'.length)}`))],
    ['a uri as bytes', linkWith(2, bstr(utf8('https://example.com/cat.png')))],
    ['a sha256 of 31 bytes', linkWith(3, bstr(filled(31, 7)))],
    ['a sha256 of 33 bytes', linkWith(3, bstr(filled(33, 7)))],
    ['a sha256 as hex text', linkWith(3, tstr(LOGO_SHA256))],
  ];

  const signedFields: readonly [string, Uint8Array][] = [
    ['a creator of 32 bytes', signedWith(1, bstr(filled(32, 2)))],
    ['a creator of 34 bytes', signedWith(1, bstr(filled(34, 2)))],
    ['a creator as text', signedWith(1, tstr('02'))],
    ['a signature of 64 bytes', signedWith(3, bstr(filled(64, 1)))],
    ['a signature of 66 bytes', signedWith(3, bstr(filled(66, 1)))],
    ['a signature as text', signedWith(3, tstr('00'))],
    ['NftSigned inside NftSigned', signedWith(2, SIGNED_ITEM)],
    ['a signed payload of raw bytes', signedWith(2, bstr(MEDIA_ITEM))],
    ['a signed value envelope', signedWith(2, VALUE_ENVELOPE)],
    ['a signed NftMetadata that breaks a field rule (empty name)', signedWith(2, metadataWith(1, tstr('')))],
  ];

  const topLevel: readonly [string, Uint8Array | null][] = [
    ['a null payload', null],
    ['an empty payload', new Uint8Array(0)],
    ['raw JPEG bytes', raw('ffd8ffe000104a46494600010100000100010000')],
    ['a 39050 value envelope', VALUE_ENVELOPE],
    ['valid NftMedia fields under the unknown tag 39056', tagged(39056n, MEDIA_FIELDS)],
    ['valid NftMedia fields under the retired tag 39051', tagged(39051n, MEDIA_FIELDS)],
    ['a valid NftMedia inside the self-describe tag 55799', C.encodeTag(55799n, MEDIA_ITEM)],
    ['an untagged NftMedia field list', C.encodeArray(...MEDIA_FIELDS)],
    ['a text string', tstr('kitty #1')],
    ['CBOR null', NULL],
    ['a non-canonical 4-byte tag head (da 00 00 98 8d)', cat(raw('da0000988d'), C.encodeArray(...MEDIA_FIELDS))],
    ['a non-canonical array head (98 03)', cat(raw('d9988d9803'), ...MEDIA_FIELDS)],
    ['an indefinite-length array', cat(raw('d9988d9f'), ...MEDIA_FIELDS, raw('ff'))],
    ['a tag head with no item', raw('d9988d')],
    ['two concatenated valid items', cat(MEDIA_ITEM, MEDIA_ITEM)],
  ];

  it.each([...structural, ...metadataFields, ...mediaAndLinkFields, ...signedFields, ...topLevel])(
    'does not recognise %s',
    (_name, payload) => {
      expect(parseNftPayload(payload)).toBeNull();
    },
  );
});

/** mulberry32 — a tiny seeded PRNG, so any failure reproduces from the seed. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mutate(random: () => number, input: Uint8Array): Uint8Array {
  const at = Math.floor(random() * (input.length + 1));
  const byte = Math.floor(random() * 256);
  switch (Math.floor(random() * 4)) {
    case 0:
      return at < input.length ? withByte(input, at, (b) => b ^ (1 << (byte % 8))) : input;
    case 1:
      return input.slice(0, at);
    case 2:
      return cat(input.subarray(0, at), new Uint8Array([byte]), input.subarray(at));
    default:
      return cat(input.subarray(0, at), input.subarray(at + 1));
  }
}

function reencode(parsed: ParsedNft): Uint8Array {
  const payload = encodeNftContent(parsed.content);
  return parsed.signed === null ? payload : encodeNftSigned(parsed.signed.creator, payload, parsed.signed.signature);
}

describe('NFT payload — parseNftPayload never throws', () => {
  it('survives random bytes and mutations of valid encodings, and re-encodes whatever it recognises byte for byte', async () => {
    const random = prng(0x785);
    const randomBytes = (): Uint8Array =>
      Uint8Array.from({ length: Math.floor(random() * 64) }, () => Math.floor(random() * 256));
    const unsigned = FORMS.map(([, content]) => encodeNftContent(content));
    const seeds = [
      ...unsigned,
      ...(await Promise.all(unsigned.map((payload) => signedPayload(payload)))),
      METADATA_ITEM,
      MEDIA_ITEM,
      SIGNED_ITEM,
      tagged(NFT_LINK_TAG, LINK_FIELDS),
    ];
    const heads = ['d9988c', 'd9988d', 'd9988e', 'd9988f'].map(raw);
    const failures: string[] = [];
    let recognised = 0;
    const iterations = 6000;

    for (let i = 0; i < iterations; i++) {
      let input: Uint8Array;
      if (i % 5 === 0) input = randomBytes();
      else if (i % 5 === 1) input = cat(heads[i % heads.length], randomBytes());
      else {
        input = seeds[Math.floor(random() * seeds.length)];
        for (let n = 1 + Math.floor(random() * 3); n > 0; n--) input = mutate(random, input);
      }
      try {
        const parsed = parseNftPayload(input);
        if (parsed === null) continue;
        recognised++;
        if (hex(reencode(parsed)) !== hex(input)) failures.push(`recognised but re-encoded differently: ${hex(input)}`);
      } catch (error) {
        failures.push(`threw on ${hex(input)}: ${String(error)}`);
      }
    }

    expect(failures).toEqual([]);
    expect(recognised).toBeGreaterThan(0);
    expect(recognised).toBeLessThan(iterations);
  });
});

describe('NFT payload — the encoder refuses what the parser would not recognise', () => {
  const metadataWithAttribute = (value: unknown): NftMetadata =>
    bad({ ...minimal, attributes: [{ trait_type: 'Lives', value }] });

  const refusals: readonly [name: string, field: string, encode: () => unknown][] = [
    ['an empty name', 'name', () => encodeNftContent({ ...minimal, name: '' })],
    ['a name holding a lone surrogate', 'name', () => encodeNftContent({ ...minimal, name: 'cat\uD800' })],
    ['a name that is not text', 'name', () => encodeNftContent(bad({ ...minimal, name: 7 }))],
    ['an empty description', 'description', () => encodeNftContent({ ...minimal, description: '' })],
    ['an undefined description (absent is null)', 'description', () => encodeNftContent(bad({ ...minimal, description: undefined }))],
    ['an empty external_url', 'external_url', () => encodeNftContent({ ...minimal, external_url: '' })],
    ['an empty collection', 'collection', () => encodeNftContent({ ...minimal, collection: '' })],
    ['NftMetadata as the image', 'image', () => encodeNftContent(bad({ ...minimal, image: minimal }))],
    ['an undefined image', 'image', () => encodeNftContent(bad({ ...minimal, image: undefined }))],
    ['an image media_type in upper case', 'image.media_type', () => encodeNftContent({ ...minimal, image: { ...media, media_type: 'image/PNG' } })],
    ['an image with empty bytes', 'image.bytes', () => encodeNftContent({ ...minimal, image: { ...media, bytes: new Uint8Array(0) } })],
    ['an animation_url over http://', 'animation_url.uri', () => encodeNftContent({ ...minimal, animation_url: { ...link, uri: 'http://example.com/a.mp4' } })],
    ['an animation_url with a 63-hex digest', 'animation_url.sha256', () => encodeNftContent({ ...minimal, animation_url: { ...link, sha256: LOGO_SHA256.slice(1) } })],
    ['null attributes', 'attributes', () => encodeNftContent(bad({ ...minimal, attributes: null }))],
    ['a null attribute', 'attributes[0].trait_type', () => encodeNftContent(bad({ ...minimal, attributes: [null] }))],
    ['a hole in a sparse attributes array', 'attributes[0].trait_type', () => encodeNftContent({ ...minimal, attributes: new Array<NftAttribute>(1) })],
    ['an empty trait_type', 'attributes[0].trait_type', () => encodeNftContent({ ...minimal, attributes: [{ trait_type: '', value: 'x' }] })],
    [
      'an empty text value',
      'attributes[1].value',
      () => encodeNftContent({ ...minimal, attributes: [{ trait_type: 'a', value: 'b' }, { trait_type: 'c', value: '' }] }),
    ],
    ['a decimal value', 'attributes[0].value', () => encodeNftContent(metadataWithAttribute(1.5))],
    ['the integer 2^53', 'attributes[0].value', () => encodeNftContent(metadataWithAttribute(2 ** 53))],
    ['the integer −2^53', 'attributes[0].value', () => encodeNftContent(metadataWithAttribute(-(2 ** 53)))],
    ['NaN', 'attributes[0].value', () => encodeNftContent(metadataWithAttribute(NaN))],
    ['Infinity', 'attributes[0].value', () => encodeNftContent(metadataWithAttribute(Infinity))],
    ['a boolean value', 'attributes[0].value', () => encodeNftContent(metadataWithAttribute(true))],
    ['a bigint value', 'attributes[0].value', () => encodeNftContent(metadataWithAttribute(9n))],
    ['a media_type with a parameter', 'media_type', () => encodeNftContent({ ...media, media_type: 'text/plain;charset=utf-8' })],
    ['media bytes given as a plain array', 'bytes', () => encodeNftContent(bad({ ...media, bytes: [1, 2, 3] }))],
    ['empty media bytes', 'bytes', () => encodeNftContent({ ...media, bytes: new Uint8Array(0) })],
    ['a uri that is only a scheme', 'uri', () => encodeNftContent({ ...link, uri: 'https://' })],
    ['a uri with a space', 'uri', () => encodeNftContent({ ...link, uri: 'https://example.com/a cat.png' })],
    ['a uri of 2049 characters', 'uri', () => encodeNftContent({ ...link, uri: `https://${'a'.repeat(2041)}` })],
    ['a digest that is not hex', 'sha256', () => encodeNftContent({ ...link, sha256: 'zz'.repeat(32) })],
    ['an unknown kind', 'content', () => encodeNftContent(bad({ ...media, kind: 'signed' }))],
    ['no content at all', 'content', () => encodeNftContent(bad(null))],
    ['a 32-byte creator', 'creator', () => encodeNftSigned(filled(32, 2), MEDIA_ITEM, filled(65, 1))],
    ['a 64-byte signature', 'signature', () => encodeNftSigned(filled(33, 2), MEDIA_ITEM, filled(64, 1))],
    ['an NftSigned payload', 'payload', () => encodeNftSigned(filled(33, 2), SIGNED_ITEM, filled(65, 1))],
    ['a raw-bytes payload', 'payload', () => encodeNftSigned(filled(33, 2), PNG, filled(65, 1))],
    ['a payload with a trailing byte', 'payload', () => encodeNftSigned(filled(33, 2), cat(MEDIA_ITEM, NULL), filled(65, 1))],
    ['a payload whose NftMetadata breaks a field rule', 'name', () => encodeNftSigned(filled(33, 2), metadataWith(1, tstr('')), filled(65, 1))],
  ];

  it.each(refusals)('refuses %s with VALIDATION_ERROR naming %s', (_name, field, encode) => {
    let caught: unknown;
    try {
      encode();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SphereError);
    expect((caught as SphereError).code).toBe('VALIDATION_ERROR');
    expect((caught as SphereError).message).toContain(`NFT ${field}:`);
  });

  it('tells the caller to write decimals and large numbers as text', () => {
    expect(() => encodeNftContent(metadataWithAttribute(1.5))).toThrow(/as text/);
  });
});

describe('NFT payload — the NftSigned digest (a cross-SDK vector)', () => {
  const payload = encodeNftContent({ kind: 'media', media_type: 'text/plain', bytes: utf8('hello') });
  const PREIMAGE_HEX =
    '84' +
    '694e66745369676e6564' +
    '5820000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f' +
    'd998788301410158210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' +
    '56d9988d83016a746578742f706c61696e4568656c6c6f';
  const DIGEST_HEX = '0631e26c16a193f12c47ec9998b0f5eb01b3e7a46ee7460c6ba38f67361c3e4f';
  const SIGNED_HEX =
    'd9988f8401' +
    '5821034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa' +
    'd9988d83016a746578742f706c61696e4568656c6c6f' +
    '584100c7a4d708926aae5f87f6b2b7b1ebf85bec6f560902a70a396debffbd868bee50dc85f66dca840592b762c227c92586ec9311ec254f9993c297a8ad8d9aa11b01';

  it("encodes the genesis recipient as tag(39032)[engine 1, code h'01', the 33-byte key]", () => {
    expect(hex(RECIPIENT_CBOR)).toBe(hex(C.encodeTag(39032n, C.encodeArray(uint(1), bstr(raw('01')), bstr(RECIPIENT_PUBKEY)))));
  });

  it('hashes CBOR ["NftSigned", bstr(tokenId), recipient predicate, bstr(payload)]', async () => {
    const preimage = C.encodeArray(tstr('NftSigned'), bstr(TOKEN_ID), RECIPIENT_CBOR, bstr(payload));
    expect(hex(preimage)).toBe(PREIMAGE_HEX);
    const digest = await nftSignedDigest(TOKEN_ID_CBOR, RECIPIENT_CBOR, payload);
    expect(digest.algorithm).toBe(HashAlgorithm.SHA256);
    expect(hex(digest.data)).toBe(hex(sha256(preimage)));
    expect(hex(digest.data)).toBe(DIGEST_HEX);
  });

  it('verifies the published signed vector as valid', async () => {
    const parsed = parseNftPayload(raw(SIGNED_HEX));
    expect(parsed?.content).toEqual({ kind: 'media', media_type: 'text/plain', bytes: utf8('hello') });
    expect(hex(parsed!.signed!.creator)).toBe(hex(CREATOR.publicKey));
    await expect(verifyNftSignature(parsed!.signed!, TOKEN_ID_CBOR, RECIPIENT_CBOR)).resolves.toBe('valid');
  });
});

describe('NFT payload — verifyNftSignature', () => {
  async function signedParts(): Promise<Signed> {
    return parseNftPayload(await signedPayload(encodeNftContent(metadata)))!.signed!;
  }
  const verify = (signed: Signed, tokenIdCbor = TOKEN_ID_CBOR, recipient = RECIPIENT_CBOR) =>
    verifyNftSignature(signed, tokenIdCbor, recipient);

  it('is valid for the token id and genesis recipient it was signed over', async () => {
    await expect(verify(await signedParts())).resolves.toBe('valid');
  });

  it('is invalid when one payload byte is flipped', async () => {
    const signed = await signedParts();
    const payload = withByte(signed.payload, signed.payload.length - 1, (b) => b ^ 1);
    await expect(verify({ ...signed, payload })).resolves.toBe('invalid');
  });

  it('is invalid for another token id (a payload copied onto another token)', async () => {
    await expect(verify(await signedParts(), bstr(filled(32, 9)))).resolves.toBe('invalid');
  });

  it('is invalid for another genesis recipient (a front-run mint)', async () => {
    await expect(verify(await signedParts(), TOKEN_ID_CBOR, recipientCbor(OTHER_PUBKEY))).resolves.toBe('invalid');
  });

  it('binds the recovery byte: the same (r, s) under the other recovery id is invalid', async () => {
    const signed = await signedParts();
    const signature = withByte(signed.signature, 64, (b) => b ^ 1);
    await expect(verify({ ...signed, signature })).resolves.toBe('invalid');
  });

  it('refuses the high-s twin of a valid signature, which plain ECDSA would accept', async () => {
    const signed = await signedParts();
    const r = signed.signature.subarray(0, 32);
    const s = BigInt(`0x${hex(signed.signature.subarray(32, 64))}`);
    const highS = raw((SECP256K1_N - s).toString(16).padStart(64, '0'));
    const digest = await nftSignedDigest(TOKEN_ID_CBOR, RECIPIENT_CBOR, signed.payload);
    expect(secp256k1.verify(cat(r, highS), digest.data, signed.creator, { format: 'compact', prehash: false, lowS: false })).toBe(true);
    const twin = cat(r, highS, new Uint8Array([signed.signature[64] ^ 1]));
    await expect(verify({ ...signed, signature: twin })).resolves.toBe('invalid');
  });

  it('is invalid when the creator is not a curve point', async () => {
    const signed = await signedParts();
    await expect(verify({ ...signed, creator: cat(raw('02'), filled(32, 0xff)) })).resolves.toBe('invalid');
  });

  it('is invalid when a different valid key is named as the creator', async () => {
    const signed = await signedParts();
    await expect(verify({ ...signed, creator: OTHER_PUBKEY })).resolves.toBe('invalid');
  });

  it.each([
    ['65 bytes of garbage', cat(filled(64, 0xab), raw('01'))],
    ['all zeros', filled(65, 0)],
    ['a recovery id of 4', cat(filled(64, 0xab), raw('04'))],
    ['a truncated signature', filled(64, 0xab)],
  ])('is invalid for a signature of %s', async (_name, signature) => {
    const signed = await signedParts();
    await expect(verify({ ...signed, signature })).resolves.toBe('invalid');
  });

  it('never throws, even on inputs the parser never produces', async () => {
    const signed = await signedParts();
    await expect(verifyNftSignature(bad({ creator: {}, payload: null, signature: 'x' }), TOKEN_ID_CBOR, RECIPIENT_CBOR)).resolves.toBe('invalid');
    await expect(verifyNftSignature(signed, bad(undefined), bad(undefined))).resolves.toBe('invalid');
  });
});

describe('NFT payload — verifyNftLinkContent', () => {
  const pinned: NftLink = { ...link, sha256: hex(sha256(PNG)) };

  it('accepts the exact bytes', () => {
    expect(verifyNftLinkContent(pinned, PNG)).toBe(true);
  });

  it('refuses a file with one changed byte', () => {
    expect(verifyNftLinkContent(pinned, withByte(PNG, 0, (b) => b ^ 1))).toBe(false);
  });

  it('refuses a truncated file', () => {
    expect(verifyNftLinkContent(pinned, PNG.subarray(0, -1))).toBe(false);
  });

  it('compares the digest case-insensitively', () => {
    expect(verifyNftLinkContent({ ...pinned, sha256: pinned.sha256.toUpperCase() }, PNG)).toBe(true);
  });
});
