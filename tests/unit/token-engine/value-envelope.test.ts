/**
 * #778 — a strictness failure must never be indistinguishable from "no value".
 *
 * The predicate this replaces was `try { decodeTag(d).tag === CBOR_TAG } catch
 * { false }`, and both callers read `false` as "data token, no coins". Because
 * `decodeTag` parses the body and asserts exhaustion, a VALID envelope carrying
 * one trailing byte answered `false` — real coins rendered as none, silently,
 * with no error surface anywhere. Every case below is named for the input, and
 * the reject cases are the ones that used to be silently zeroed.
 *
 * Cases mirror ../wallet-api/tests/unit/value-codec.test.ts so the two stacks
 * can be diffed by name.
 */

import { describe, expect, it } from 'vitest';

import { SphereError } from '../../../core/errors';
import { CborSerializer, HexConverter } from '../../../token-engine/sdk';
import { SpherePaymentData } from '../../../token-engine/SpherePaymentData';
import { classifyValueEnvelope } from '../../../token-engine/value-envelope';

const COIN_ID = 'aa'.repeat(32);

const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

const bstr = (hex: string): Uint8Array =>
  CborSerializer.encodeByteString(HexConverter.decode(hex));

/** `Asset.toCBOR()`'s shape: [AssetId, BigInteger], both byte strings. */
const assetCbor = (idHex: string, amountHex: string): Uint8Array =>
  CborSerializer.encodeArray(bstr(idHex), bstr(amountHex));

const validSphere = await SpherePaymentData.fromValue({
  assets: [{ coinId: COIN_ID, amount: 1000n }],
}).encode();

/** The bridged dialect: an untagged array of assets. */
const validCollection = CborSerializer.encodeArray(assetCbor(COIN_ID, '03e8'));

const metadataMap = CborSerializer.encodeTag(
  55799n,
  CborSerializer.encodeTextString('kitty #1'),
);

describe('classifyValueEnvelope — a readable value envelope', () => {
  it('decodes a valid SpherePaymentData', () => {
    const { envelope, value } = classifyValueEnvelope(validSphere);
    expect(envelope).toBe('sphere');
    expect(value).toEqual({ assets: [{ coinId: COIN_ID, amount: 1000n }] });
  });
});

/**
 * THE REGRESSION SET. Every payload here carries real, readable coins and was
 * reported as `value === null` before this change. A throw is the only outcome a
 * user can act on: a balance has no other error surface.
 */
describe('classifyValueEnvelope — a CORRUPT envelope throws instead of reading as coinless', () => {
  const rejects: readonly [name: string, payload: Uint8Array, match: RegExp][] = [
    [
      'a valid SpherePaymentData with one trailing byte (decodeTag asserts exhaustion, so the old predicate called this untagged)',
      cat(validSphere, new Uint8Array([0xf6])),
      /payment data/i,
    ],
    [
      'a SpherePaymentData truncated by one byte',
      validSphere.slice(0, -1),
      /payment data/i,
    ],
    [
      'a NON-CANONICALLY encoded tag-39050 head (da 00 00 98 8a IS 39050, in a 4-byte head where CborReader demands the 2-byte one)',
      cat(new Uint8Array([0xda, 0x00, 0x00, 0x98, 0x8a]), validSphere.slice(3)),
      /tag head/,
    ],
    ['a truncated 2-byte tag head', new Uint8Array([0xd9]), /tag head/],
    ['a tag head missing its second length byte', new Uint8Array([0xd9, 0x98]), /tag head/],
    [
      'raw binary in the tag range that is not canonical CBOR (de ad be ef)',
      new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      /tag head/,
    ],
    [
      'tag 39050 whose body is not a SpherePaymentData at all',
      CborSerializer.encodeTag(SpherePaymentData.CBOR_TAG, CborSerializer.encodeTextString('nope')),
      /payment data/i,
    ],
  ];

  it.each(rejects)('rejects %s', (_name, payload, match) => {
    expect(() => classifyValueEnvelope(payload)).toThrow(match);
  });

  it('throws a typed SphereError, so callers can classify it rather than string-match', () => {
    expect(() => classifyValueEnvelope(validSphere.slice(0, -1))).toThrow(SphereError);
  });
});

/**
 * RFC 8949 §3.4.6 makes tag 55799 semantically TRANSPARENT, so `tag(55799) X`
 * means exactly `X` — but no pinned codec unwraps it. It therefore matters only
 * when it hides real VALUE; wrapped app data is the shape that actually exists,
 * since self-describe is an encoder-wide setting.
 */
describe('classifyValueEnvelope — the self-described CBOR wrapper (matches wallet-api)', () => {
  it('refuses tag 55799 hiding a valid SpherePaymentData — its coins would be invisible', () => {
    expect(() => classifyValueEnvelope(CborSerializer.encodeTag(55799n, validSphere))).toThrow(/55799/);
  });

  it('refuses tag 55799 hiding a bare collection (the bridged-minter case)', () => {
    expect(() => classifyValueEnvelope(CborSerializer.encodeTag(55799n, validCollection))).toThrow(/55799/);
  });

  it('refuses a nested 55799 rather than walking an unbounded chain', () => {
    const nested = CborSerializer.encodeTag(55799n, CborSerializer.encodeTag(55799n, CborSerializer.encodeNull()));
    expect(() => classifyValueEnvelope(nested)).toThrow(/55799/);
  });

  it('accepts tag 55799 wrapping app data as coinless — refusing it would reject the token #140 exists to accept', () => {
    expect(classifyValueEnvelope(metadataMap)).toEqual({ envelope: 'none_tag', value: null });
  });
});

/** A tagged item must frame completely, so the tag and array branches agree. */
describe('classifyValueEnvelope — tag framing', () => {
  it('refuses a tag head with no body at all', () => {
    expect(() => classifyValueEnvelope(new Uint8Array([0xc1]))).toThrow(/malformed or carries trailing bytes/);
  });

  it('refuses a well-formed non-value tag followed by trailing garbage', () => {
    const payload = cat(
      CborSerializer.encodeTag(1n, CborSerializer.encodeUnsignedInteger(5n)),
      new Uint8Array([0xff]),
    );
    expect(() => classifyValueEnvelope(payload)).toThrow(/malformed or carries trailing bytes/);
  });
});

/**
 * The tokens wallet-api#140 exists to accept. Each must stay `value === null`
 * with NO error — an NFT is not a failure.
 */
describe('classifyValueEnvelope — a genuinely coinless token', () => {
  const coinless: readonly [name: string, payload: Uint8Array | null, envelope: string][] = [
    ['null genesis data (the plainest coinless token)', null, 'none_absent'],
    ['a zero-length payload', new Uint8Array(0), 'none_absent'],
    ['an empty CBOR array', new Uint8Array([0x80]), 'none_other'],
    [
      'an array of text strings',
      CborSerializer.encodeArray(CborSerializer.encodeTextString('a'), CborSerializer.encodeTextString('b')),
      'none_other',
    ],
    ['a CBOR text string of app metadata', CborSerializer.encodeTextString('kitty #1'), 'none_other'],
    ['a CBOR byte string of opaque app data', CborSerializer.encodeByteString(new Uint8Array([1, 2, 3])), 'none_other'],
    ['a tag that is not a value envelope', CborSerializer.encodeTag(1n, CborSerializer.encodeUnsignedInteger(5n)), 'none_tag'],
  ];

  it.each(coinless)('reads %s as coinless, with no error', (_name, payload, envelope) => {
    expect(classifyValueEnvelope(payload)).toEqual({ envelope, value: null });
  });
});

/**
 * The ONE deliberate divergence from wallet-api, recorded so it reads as a
 * decision. wallet-api DECODES this dialect and indexes its coins; this SDK does
 * not, so the server can report a balance the wallet cannot see. Classifying it
 * apart from `none_*` is what lets callers say "cannot read" instead of "has
 * none". Decoding it is an acceptance widening, tracked separately.
 */
describe('classifyValueEnvelope — the bridged dialect is classified, not decoded', () => {
  it('labels a bare PaymentAssetCollection `bare_collection`, distinctly from coinless', () => {
    expect(classifyValueEnvelope(validCollection)).toEqual({ envelope: 'bare_collection', value: null });
  });

  it('uses .some, never .every: an integer followed by a valid asset still claims the dialect', () => {
    const payload = CborSerializer.encodeArray(
      CborSerializer.encodeUnsignedInteger(1n),
      assetCbor(COIN_ID, '07'),
    );
    expect(classifyValueEnvelope(payload).envelope).toBe('bare_collection');
  });

  it('refuses an array that does not frame — a truncation could be a corrupt collection', () => {
    expect(() => classifyValueEnvelope(new Uint8Array([0x82]))).toThrow(/PaymentAssetCollection/);
  });

  it('refuses an indefinite-length array', () => {
    expect(() => classifyValueEnvelope(new Uint8Array([0x9f, 0xff]))).toThrow(/PaymentAssetCollection/);
  });

  it('returns promptly on a huge declared element count rather than pre-allocating', () => {
    const payload = new Uint8Array([0x9a, 0x00, 0xff, 0xff, 0xff]);
    expect(() => classifyValueEnvelope(payload)).toThrow(/PaymentAssetCollection/);
  });
});

/**
 * The safety direction. Anything reaching this client over the mailbox already
 * passed wallet-api's §8.2 at deposit, so a sphere-only THROW would refuse a
 * token the server accepted — and `Receive.screen()` makes that terminal.
 */
describe('the #778 funds invariant', () => {
  it('never reports a readable value envelope as coinless', () => {
    const carriesCoins = [validSphere, cat(validSphere, new Uint8Array([0xf6])), validSphere.slice(0, -1)];
    for (const payload of carriesCoins) {
      let zeroed = false;
      try {
        const { envelope, value } = classifyValueEnvelope(payload);
        zeroed = value === null && envelope.startsWith('none_');
      } catch {
        zeroed = false;
      }
      expect(zeroed).toBe(false);
    }
  });
});
