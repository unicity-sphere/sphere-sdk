import { describe, expect, it } from 'vitest';

import { nftContentFromWire as entryFromWire, nftContentToWire as entryToWire } from '../../../connect';
import { nftContentFromWire, nftContentToWire } from '../../../connect/nft-wire';
import type { WireNftContent, WireNftMetadata } from '../../../connect/nft-wire';
import { base64DecodeCanonical, base64Encode } from '../../../core/base64';
import { SphereError } from '../../../core/errors';
import { encodeNftContent } from '../../../token-engine/nft-payload';
import type { NftContent, NftLink, NftMedia, NftMetadata } from '../../../token-engine/nft-payload';

// 10 bytes: the PNG signature plus two more, so the base64 spans all three remainders and '/'.
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
const PNG_BASE64 = 'iVBORw0KGgoA/w==';

const LINK: NftLink = {
  kind: 'link',
  media_type: 'video/mp4',
  uri: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
  sha256: 'ab'.repeat(32),
};

const BARE_MEDIA: NftMedia = { kind: 'media', media_type: 'image/png', bytes: PNG };

const METADATA_INLINE_IMAGE: NftMetadata = {
  kind: 'metadata',
  name: 'Cat',
  description: 'A green-eyed cat',
  image: { kind: 'media', media_type: 'image/png', bytes: PNG },
  animation_url: null,
  external_url: 'https://example.com/cat',
  attributes: [
    { trait_type: 'Eyes', value: 'green' },
    { trait_type: 'Lives', value: 9 },
    { trait_type: 'Debt', value: -3 },
  ],
  collection: 'Cats',
  collection_id: 'c0'.repeat(32),
};

const METADATA_LINK_ANIMATION: NftMetadata = {
  kind: 'metadata',
  name: 'Dancing cat',
  description: null,
  image: { kind: 'link', media_type: 'image/png', uri: 'https://example.com/cat.png', sha256: 'cd'.repeat(32) },
  animation_url: LINK,
  external_url: null,
  attributes: [],
  collection: null,
  collection_id: null,
};

type Wire = Record<string, unknown>;

/** What arrives at the wallet after the params cross a JSON transport. */
const overJson = (wire: WireNftContent): Wire => JSON.parse(JSON.stringify(wire)) as Wire;
const wireMetadata = (): Wire => overJson(nftContentToWire(METADATA_INLINE_IMAGE));
const wireMedia = (): Wire => overJson(nftContentToWire(BARE_MEDIA));

function omit(record: Wire, key: string): Wire {
  const { [key]: _dropped, ...rest } = record;
  return rest;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function expectRefused(wire: unknown, field: string): void {
  expect(() => nftContentFromWire(wire)).toThrow(new RegExp(`^Invalid NFT ${escapeRegExp(field)}: `));
}

describe('nftContentToWire / nftContentFromWire', () => {
  it.each([
    ['metadata with an inline image', METADATA_INLINE_IMAGE],
    ['bare media', BARE_MEDIA],
    ['a link', LINK],
    ['metadata with a link animation', METADATA_LINK_ANIMATION],
  ] as [string, NftContent][])('round-trips %s through JSON to the same content and payload bytes', (_name, content) => {
    const decoded = nftContentFromWire(overJson(nftContentToWire(content)));

    expect(decoded).toEqual(content);
    expect(encodeNftContent(decoded)).toEqual(encodeNftContent(content));
  });

  it('writes inline bytes as standard padded base64 and copies every other field unchanged', () => {
    expect(nftContentToWire(BARE_MEDIA)).toEqual({ kind: 'media', media_type: 'image/png', bytes: PNG_BASE64 });
    expect(nftContentToWire(METADATA_INLINE_IMAGE)).toEqual({
      ...METADATA_INLINE_IMAGE,
      image: { kind: 'media', media_type: 'image/png', bytes: PNG_BASE64 },
    });
  });

  it('passes a link through unchanged, at the top level and in both media slots', () => {
    expect(nftContentToWire(LINK)).toEqual(LINK);
    expect(nftContentFromWire(LINK)).toEqual(LINK);

    const wire = nftContentToWire(METADATA_LINK_ANIMATION) as WireNftMetadata;
    expect(wire.image).toEqual(METADATA_LINK_ANIMATION.image);
    expect(wire.animation_url).toEqual(LINK);
  });

  it('is exported from the connect entry', () => {
    expect(entryToWire).toBe(nftContentToWire);
    expect(entryFromWire).toBe(nftContentFromWire);
  });

  it.each([
    ['content that is a string', () => 'cat', 'content'],
    ['content that is null', () => null, 'content'],
    ['content that is an array', () => [wireMedia()], 'content'],
    ['an unknown kind', () => ({ ...wireMedia(), kind: 'signed' }), 'content.kind'],
    ['a missing kind', () => omit(wireMedia(), 'kind'), 'content.kind'],
    ['media without media_type', () => omit(wireMedia(), 'media_type'), 'content.media_type'],
    ['media with an extra field', () => ({ ...wireMedia(), name: 'Cat' }), 'content.name'],
    ['media bytes as a number array', () => ({ ...wireMedia(), bytes: Array.from(PNG) }), 'content.bytes'],
    ['a link with a numeric sha256', () => ({ ...LINK, sha256: 42 }), 'content.sha256'],
    ['a link without uri', () => omit({ ...LINK }, 'uri'), 'content.uri'],
    ['metadata with a numeric name', () => ({ ...wireMetadata(), name: 7 }), 'content.name'],
    ['metadata without description (undefined is dropped by JSON)', () => omit(wireMetadata(), 'description'), 'content.description'],
    ['a boolean description', () => ({ ...wireMetadata(), description: false }), 'content.description'],
    ['a camelCase field', () => ({ ...wireMetadata(), animationUrl: null }), 'content.animationUrl'],
    ['metadata nested in the image slot', () => ({ ...wireMetadata(), image: wireMetadata() }), 'content.image.kind'],
    ['an image that is a bare URL string', () => ({ ...wireMetadata(), image: 'https://example.com/cat.png' }), 'content.image'],
    ['an image with an extra field', () => ({ ...wireMetadata(), image: { ...wireMedia(), alt: 'cat' } }), 'content.image.alt'],
    ['a link animation without sha256', () => ({ ...wireMetadata(), animation_url: omit({ ...LINK }, 'sha256') }), 'content.animation_url.sha256'],
    ['attributes as an object', () => ({ ...wireMetadata(), attributes: { Eyes: 'green' } }), 'content.attributes'],
    ['metadata without attributes', () => omit(wireMetadata(), 'attributes'), 'content.attributes'],
    ['an attribute that is a string', () => ({ ...wireMetadata(), attributes: [{ trait_type: 'Eyes', value: 'green' }, 'Lives: 9'] }), 'content.attributes[1]'],
    ['an attribute with a boolean value', () => ({ ...wireMetadata(), attributes: [{ trait_type: 'Shiny', value: true }] }), 'content.attributes[0].value'],
    ['an attribute without trait_type', () => ({ ...wireMetadata(), attributes: [{ value: 'green' }] }), 'content.attributes[0].trait_type'],
    ['an attribute with an extra key', () => ({ ...wireMetadata(), attributes: [{ trait_type: 'Level', value: 5, display_type: 'number' }] }), 'content.attributes[0].display_type'],
    ['a numeric external_url', () => ({ ...wireMetadata(), external_url: 1 }), 'content.external_url'],
    ['metadata without collection', () => omit(wireMetadata(), 'collection'), 'content.collection'],
    ['metadata without collection_id', () => omit(wireMetadata(), 'collection_id'), 'content.collection_id'],
    ['a numeric collection_id', () => ({ ...wireMetadata(), collection_id: 7 }), 'content.collection_id'],
  ] as [string, () => unknown, string][])('refuses %s, naming %s', (_label, build, field) => {
    expectRefused(build(), field);
  });

  it.each([
    ['non-zero padding bits before ==', 'QR=='],
    ['non-zero padding bits before =', 'QUJ='],
    ['missing padding', 'QQ'],
    ['a length that is not a multiple of 4', 'QUJDRA='],
    ['padding in the middle', 'QQ==QUJD'],
    ['too much padding', 'Q==='],
    ['whitespace', 'QU D'],
    ['a trailing newline', 'QUJDQUJ\n'],
    ['the URL-safe alphabet', 'a-_b'],
    ['a non-ASCII character', 'QUJé'],
  ])('refuses media bytes with %s', (_label, bytes) => {
    expectRefused({ kind: 'media', media_type: 'image/png', bytes }, 'content.bytes');
    expectRefused({ ...wireMetadata(), image: { kind: 'media', media_type: 'image/png', bytes } }, 'content.image.bytes');
  });

  it('throws a SphereError with code VALIDATION_ERROR', () => {
    const thrown = (() => {
      try {
        return nftContentFromWire({ ...wireMedia(), bytes: 'QR==' });
      } catch (error) {
        return error;
      }
    })();
    expect(thrown).toBeInstanceOf(SphereError);
    expect((thrown as SphereError).code).toBe('VALIDATION_ERROR');
  });

  it('leaves value rules to encodeNftContent: an empty file and a bad media type pass the wire check', () => {
    const content = nftContentFromWire({ kind: 'media', media_type: 'Image/PNG', bytes: '' });

    expect(content).toEqual({ kind: 'media', media_type: 'Image/PNG', bytes: new Uint8Array() });
    expect(() => encodeNftContent(content)).toThrow(/^Invalid NFT media_type: /);
  });

  it('passes collection_id through as given: upper-case hex encodes to the same bytes, odd-length hex is refused by encodeNftContent', () => {
    const upper = nftContentFromWire({ ...wireMetadata(), collection_id: 'C0'.repeat(32) });
    const odd = nftContentFromWire({ ...wireMetadata(), collection_id: 'abc' });

    expect(upper).toMatchObject({ collection_id: 'C0'.repeat(32) });
    expect(encodeNftContent(upper)).toEqual(encodeNftContent(METADATA_INLINE_IMAGE));
    expect(odd).toMatchObject({ collection_id: 'abc' });
    expect(() => encodeNftContent(odd)).toThrow(/^Invalid NFT collection_id: /);
  });

  it('refuses to relabel an unknown kind or to encode bytes that are not a Uint8Array', () => {
    const badKind = { kind: 'signed' } as unknown as NftContent;
    const badBytes = { ...BARE_MEDIA, bytes: Array.from(PNG) } as unknown as NftContent;
    const badSlot = { ...METADATA_LINK_ANIMATION, animation_url: { kind: 'metadata' } } as unknown as NftContent;

    expect(() => nftContentToWire(badKind)).toThrow(/^Invalid NFT content\.kind: /);
    expect(() => nftContentToWire(badBytes)).toThrow(/^Invalid NFT content\.bytes: /);
    expect(() => nftContentToWire(badSlot)).toThrow(/^Invalid NFT content\.animation_url\.kind: /);
  });
});

describe('core/base64', () => {
  it('matches Node base64 both ways for every length remainder and every byte value', () => {
    const inputs = [
      ...Array.from({ length: 16 }, (_, length) => Uint8Array.from({ length }, (__, i) => (i * 37 + length * 11) & 0xff)),
      Uint8Array.from({ length: 256 }, (_, i) => i),
    ];
    for (const bytes of inputs) {
      const expected = Buffer.from(bytes).toString('base64');
      expect(base64Encode(bytes)).toBe(expected);
      expect(base64DecodeCanonical(expected)).toEqual(bytes);
    }
  });

  it('decodes the canonical spelling of each padding case', () => {
    expect(base64DecodeCanonical('')).toEqual(new Uint8Array());
    expect(base64DecodeCanonical('QQ==')).toEqual(Uint8Array.from([0x41]));
    expect(base64DecodeCanonical('QUI=')).toEqual(Uint8Array.from([0x41, 0x42]));
    expect(base64DecodeCanonical('QUJD')).toEqual(Uint8Array.from([0x41, 0x42, 0x43]));
  });
});
