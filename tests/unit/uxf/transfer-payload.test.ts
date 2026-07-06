/**
 * Tests for `uxf/transfer-payload.ts` — UXF transfer wire-format
 * encode/decode helpers (T.1.D).
 *
 * Covers:
 *   - Round-trip encode/decode for `uxf-car`, `uxf-cid`, and all four
 *     legacy shapes from §3.4.
 *   - Byte-determinism: same input → same output across calls.
 *   - Decoder rejects every malformed envelope shape with
 *     `BUNDLE_REJECTED_MALFORMED_ENVELOPE`.
 *   - `extractCarRootCid`: single-root happy path; multi-root rejection;
 *     truncated/malformed CAR rejection.
 *   - `decodeNostrEventContent`: thin alias to `decodeTransferPayload`.
 *   - Base64 helpers: round-trip and strict-alphabet rejection.
 *
 * Spec references: §3.1, §3.2, §3.3, §3.4, §5.0, §5.2 #1.
 */

import { describe, it, expect } from 'vitest';
import { CID } from 'multiformats';
import * as raw from 'multiformats/codecs/raw';
import { sha256 } from '@noble/hashes/sha2.js';
import { create as createDigest } from 'multiformats/hashes/digest';
import { CarWriter } from '@ipld/car/writer';

import {
  encodeTransferPayload,
  decodeTransferPayload,
  decodeNostrEventContent,
  extractCarRootCid,
  carBytesToBase64,
  carBase64ToBytes,
} from '../../../extensions/uxf/bundle/transfer-payload';
import type {
  LegacyCombinedTransferPayload,
  LegacyInstantSplitPayload,
  LegacySdkPayload,
  LegacySphereTxfPayload,
  UxfTransferPayload,
  UxfTransferPayloadCar,
  UxfTransferPayloadCid,
} from '../../../types/uxf-transfer';
import { SphereError } from '../../../core/errors';

// =============================================================================
// Fixtures
// =============================================================================

const SAMPLE_CID =
  'bafkreih5fqzwc4cnzifwdksrkvkw26vy7s5g7nctqmqj7gx2byvthq3yxq';
const SAMPLE_CID_2 =
  'bafkreialuwq7p4ohvtm66qufvjtqgcmqcubgkqbqmedyy5kdolcsfd45vy';

const samplePayloadCar: UxfTransferPayloadCar = {
  kind: 'uxf-car',
  version: '1.0',
  mode: 'instant',
  bundleCid: SAMPLE_CID,
  tokenIds: ['00aa', '00bb'],
  memo: 'hello',
  sender: {
    transportPubkey: 'a'.repeat(64),
    nametag: 'alice',
  },
  carBase64: 'AAECAwQ=',
};

const samplePayloadCid: UxfTransferPayloadCid = {
  kind: 'uxf-cid',
  version: '1.0',
  mode: 'conservative',
  bundleCid: SAMPLE_CID,
  tokenIds: ['00aa'],
  memo: 'cid mode',
  sender: {
    transportPubkey: 'b'.repeat(64),
  },
  senderGateways: ['https://gateway.example.com'],
};

const samplePayloadCidNoOptional: UxfTransferPayloadCid = {
  kind: 'uxf-cid',
  version: '1.0',
  mode: 'instant',
  bundleCid: SAMPLE_CID,
  tokenIds: [],
};

const sampleLegacyTxf: LegacySphereTxfPayload = {
  sourceToken: { id: 'tok-1', state: { someField: 42 } },
  transferTx: { type: 'transfer', signature: 'deadbeef' },
  memo: 'legacy txf',
  sender: { transportPubkey: 'c'.repeat(64), nametag: 'bob' },
};

const sampleLegacyV6: LegacyCombinedTransferPayload = {
  type: 'COMBINED_TRANSFER',
  version: '6.0',
  payload: { tokens: ['00aa', '00bb'] },
};

const sampleLegacyV5: LegacyInstantSplitPayload = {
  type: 'INSTANT_SPLIT',
  version: '5.0',
  splitData: { source: 'tok-1' },
};

const sampleLegacySdk: LegacySdkPayload = {
  token: { id: 'tok-x' },
  proof: { kind: 'inclusion', merkleRoot: 'beef' },
};

// =============================================================================
// 1. Round-trip — every supported shape
// =============================================================================

describe('encodeTransferPayload / decodeTransferPayload — round-trip', () => {
  it('round-trips a `uxf-car` payload', () => {
    const json = encodeTransferPayload(samplePayloadCar);
    const parsed = decodeTransferPayload(json);
    expect(parsed).toEqual(samplePayloadCar);
  });

  it('round-trips a `uxf-cid` payload with optional fields', () => {
    const json = encodeTransferPayload(samplePayloadCid);
    const parsed = decodeTransferPayload(json);
    expect(parsed).toEqual(samplePayloadCid);
  });

  it('round-trips a `uxf-cid` payload missing memo/sender/senderGateways', () => {
    const json = encodeTransferPayload(samplePayloadCidNoOptional);
    const parsed = decodeTransferPayload(json);
    expect(parsed).toEqual(samplePayloadCidNoOptional);
  });

  it('round-trips legacy Sphere TXF', () => {
    const json = encodeTransferPayload(sampleLegacyTxf);
    const parsed = decodeTransferPayload(json);
    expect(parsed).toEqual(sampleLegacyTxf);
  });

  it('round-trips legacy V6 COMBINED_TRANSFER', () => {
    const json = encodeTransferPayload(sampleLegacyV6);
    const parsed = decodeTransferPayload(json);
    expect(parsed).toEqual(sampleLegacyV6);
  });

  it('round-trips legacy V5/V4 INSTANT_SPLIT', () => {
    const json = encodeTransferPayload(sampleLegacyV5);
    const parsed = decodeTransferPayload(json);
    expect(parsed).toEqual(sampleLegacyV5);
  });

  it('round-trips legacy SDK `{token, proof}`', () => {
    const json = encodeTransferPayload(sampleLegacySdk);
    const parsed = decodeTransferPayload(json);
    expect(parsed).toEqual(sampleLegacySdk);
  });

  it('round-trips a `uxf-car` payload with no optional fields', () => {
    // Steelman update: structural validation now rejects empty carBase64
    // (T.8.E.* hardening — see types/uxf-transfer.ts isUxfTransferPayloadCar).
    // Use a 1-byte placeholder to satisfy the non-empty constraint while
    // still exercising the "no optional fields" round-trip semantics.
    const minimal: UxfTransferPayloadCar = {
      kind: 'uxf-car',
      version: '1.0',
      mode: 'instant',
      bundleCid: SAMPLE_CID,
      tokenIds: [],
      carBase64: 'AA==',
    };
    expect(decodeTransferPayload(encodeTransferPayload(minimal))).toEqual(minimal);
  });

  it('round-trips a `uxf-car` payload with sender pubkey but no nametag', () => {
    const noNametag: UxfTransferPayloadCar = {
      ...samplePayloadCar,
      sender: { transportPubkey: 'd'.repeat(64) },
    };
    expect(decodeTransferPayload(encodeTransferPayload(noNametag))).toEqual(noNametag);
  });
});

// =============================================================================
// 2. Determinism — encode is byte-stable
// =============================================================================

describe('encodeTransferPayload — byte determinism', () => {
  it('produces byte-equal output across calls for the same `uxf-car` input', () => {
    expect(encodeTransferPayload(samplePayloadCar)).toBe(
      encodeTransferPayload(samplePayloadCar),
    );
  });

  it('produces byte-equal output for the same `uxf-cid` input', () => {
    expect(encodeTransferPayload(samplePayloadCid)).toBe(
      encodeTransferPayload(samplePayloadCid),
    );
  });

  it('canonicalizes legacy payload key order (alphabetical)', () => {
    // Build two structurally-equivalent legacy payloads with different
    // insertion orders. The encoder must produce the same JSON string.
    const a: LegacyCombinedTransferPayload = {
      type: 'COMBINED_TRANSFER',
      version: '6.0',
      payload: { a: 1, b: 2 },
    };
    const b: LegacyCombinedTransferPayload = {
      version: '6.0',
      payload: { b: 2, a: 1 },
      type: 'COMBINED_TRANSFER',
    };
    expect(encodeTransferPayload(a)).toBe(encodeTransferPayload(b));
  });

  it('emits §3.1 envelope keys in canonical order for `uxf-car`', () => {
    const json = encodeTransferPayload(samplePayloadCar);
    const keys = Object.keys(JSON.parse(json) as Record<string, unknown>);
    expect(keys).toEqual([
      'kind',
      'version',
      'mode',
      'bundleCid',
      'tokenIds',
      'memo',
      'sender',
      'carBase64',
    ]);
  });

  it('emits §3.1 envelope keys in canonical order for `uxf-cid`', () => {
    const json = encodeTransferPayload(samplePayloadCid);
    const keys = Object.keys(JSON.parse(json) as Record<string, unknown>);
    expect(keys).toEqual([
      'kind',
      'version',
      'mode',
      'bundleCid',
      'tokenIds',
      'memo',
      'sender',
      'senderGateways',
    ]);
  });

  it('omits absent optional fields rather than emitting `undefined`', () => {
    const json = encodeTransferPayload(samplePayloadCidNoOptional);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      'kind',
      'version',
      'mode',
      'bundleCid',
      'tokenIds',
    ]);
  });

  it('emits sender keys in canonical order (transportPubkey, nametag)', () => {
    const json = encodeTransferPayload(samplePayloadCar);
    const sender = (JSON.parse(json) as { sender: Record<string, unknown> })
      .sender;
    expect(Object.keys(sender)).toEqual(['transportPubkey', 'nametag']);
  });
});

// =============================================================================
// 3. Encoder defense — refuses to emit a structurally-invalid envelope
// =============================================================================

describe('encodeTransferPayload — defense in depth', () => {
  it('throws BUNDLE_REJECTED_MALFORMED_ENVELOPE on unknown shape', () => {
    // Force a payload that fails the structural guard (an object with a
    // bogus `kind` discriminator). We cast through unknown because TS
    // would correctly reject this at compile time.
    const bogus = {
      kind: 'uxf-future',
      version: '1.0',
    } as unknown as UxfTransferPayload;
    try {
      encodeTransferPayload(bogus);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SphereError);
      if (err instanceof SphereError) {
        expect(err.code).toBe('BUNDLE_REJECTED_MALFORMED_ENVELOPE');
      }
    }
  });
});

// =============================================================================
// 4. Decoder — every malformed input rejected with one canonical code
// =============================================================================

describe('decodeTransferPayload — malformed-envelope rejection', () => {
  function expectMalformed(input: string): void {
    try {
      decodeTransferPayload(input);
      expect.fail(`expected SphereError for input: ${input}`);
    } catch (err) {
      expect(err).toBeInstanceOf(SphereError);
      if (err instanceof SphereError) {
        expect(err.code).toBe('BUNDLE_REJECTED_MALFORMED_ENVELOPE');
      }
    }
  }

  it('rejects non-JSON input', () => {
    expectMalformed('not json');
  });

  it('rejects JSON `null`', () => {
    expectMalformed('null');
  });

  it('rejects JSON primitive (number)', () => {
    expectMalformed('42');
  });

  it('rejects JSON primitive (string)', () => {
    expectMalformed('"hello"');
  });

  it('rejects JSON array', () => {
    expectMalformed('[]');
  });

  it('rejects empty object', () => {
    expectMalformed('{}');
  });

  it('rejects unknown `kind` discriminator', () => {
    expectMalformed(
      JSON.stringify({
        kind: 'uxf-future',
        version: '1.0',
        mode: 'instant',
        bundleCid: SAMPLE_CID,
        tokenIds: [],
      }),
    );
  });

  it('rejects wrong `version` literal', () => {
    expectMalformed(
      JSON.stringify({
        kind: 'uxf-car',
        version: '2.0',
        mode: 'instant',
        bundleCid: SAMPLE_CID,
        tokenIds: [],
        carBase64: '',
      }),
    );
  });

  it('rejects unknown `mode` value', () => {
    expectMalformed(
      JSON.stringify({
        kind: 'uxf-car',
        version: '1.0',
        mode: 'turbo',
        bundleCid: SAMPLE_CID,
        tokenIds: [],
        carBase64: '',
      }),
    );
  });

  it('rejects empty bundleCid', () => {
    expectMalformed(
      JSON.stringify({
        kind: 'uxf-car',
        version: '1.0',
        mode: 'instant',
        bundleCid: '',
        tokenIds: [],
        carBase64: '',
      }),
    );
  });

  it('rejects missing tokenIds field', () => {
    expectMalformed(
      JSON.stringify({
        kind: 'uxf-car',
        version: '1.0',
        mode: 'instant',
        bundleCid: SAMPLE_CID,
        carBase64: '',
      }),
    );
  });

  it('rejects `uxf-car` with non-string carBase64', () => {
    expectMalformed(
      JSON.stringify({
        kind: 'uxf-car',
        version: '1.0',
        mode: 'instant',
        bundleCid: SAMPLE_CID,
        tokenIds: [],
        carBase64: 12345,
      }),
    );
  });
});

// =============================================================================
// 5. decodeNostrEventContent — thin alias confirmation
// =============================================================================

describe('decodeNostrEventContent', () => {
  it('is a thin alias for decodeTransferPayload (same input → same output)', () => {
    const json = encodeTransferPayload(samplePayloadCar);
    expect(decodeNostrEventContent(json)).toEqual(decodeTransferPayload(json));
  });

  it('throws on malformed input with the same code as decodeTransferPayload', () => {
    try {
      decodeNostrEventContent('xxx not json');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SphereError);
      if (err instanceof SphereError) {
        expect(err.code).toBe('BUNDLE_REJECTED_MALFORMED_ENVELOPE');
      }
    }
  });
});

// =============================================================================
// 6. extractCarRootCid — happy path, multi-root, malformed
// =============================================================================

/** Build a CIDv1(raw, sha2-256) from arbitrary bytes. */
function buildCid(payload: Uint8Array): CID {
  const hash = sha256(payload);
  return CID.createV1(raw.code, createDigest(0x12, hash));
}

/**
 * Hand-craft a minimal valid CARv1 with the given root CIDs. Each root
 * is paired with a single block whose CID equals the root and whose
 * bytes are the raw-codec payload.
 */
async function buildCar(
  rootPayloads: Uint8Array[],
): Promise<{ bytes: Uint8Array; rootCids: CID[] }> {
  const rootCids = rootPayloads.map((p) => buildCid(p));
  const { writer, out } = CarWriter.create(rootCids);
  const chunks: Uint8Array[] = [];
  const collect = (async () => {
    for await (const c of out) chunks.push(c);
  })();
  for (let i = 0; i < rootCids.length; i++) {
    await writer.put({ cid: rootCids[i], bytes: rootPayloads[i] });
  }
  await writer.close();
  await collect;
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  return { bytes, rootCids };
}

describe('extractCarRootCid', () => {
  it('returns the CIDv1 base32 string for a single-root CAR', async () => {
    const { bytes, rootCids } = await buildCar([new Uint8Array([0x01, 0x02])]);
    const cidStr = await extractCarRootCid(bytes);
    expect(cidStr).toBe(rootCids[0].toString());
    // Sanity: it's actually a CIDv1 base32 string (multibase prefix `b`).
    expect(cidStr.startsWith('b')).toBe(true);
  });

  it('throws BUNDLE_REJECTED_MULTI_ROOT for a multi-root CAR', async () => {
    const { bytes } = await buildCar([
      new Uint8Array([0x01]),
      new Uint8Array([0x02]),
    ]);
    try {
      await extractCarRootCid(bytes);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SphereError);
      if (err instanceof SphereError) {
        expect(err.code).toBe('BUNDLE_REJECTED_MULTI_ROOT');
      }
    }
  });

  it('throws BUNDLE_REJECTED_INVALID_CAR for truncated bytes', async () => {
    try {
      await extractCarRootCid(new Uint8Array([0x00, 0x01, 0x02]));
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SphereError);
      if (err instanceof SphereError) {
        expect(err.code).toBe('BUNDLE_REJECTED_INVALID_CAR');
      }
    }
  });

  it('throws BUNDLE_REJECTED_INVALID_CAR for empty bytes', async () => {
    try {
      await extractCarRootCid(new Uint8Array(0));
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SphereError);
      if (err instanceof SphereError) {
        expect(err.code).toBe('BUNDLE_REJECTED_INVALID_CAR');
      }
    }
  });

  // -------------------------------------------------------------------------
  // Steelman Wave 3 — header-only fast path
  // -------------------------------------------------------------------------
  it('extracts root CID from a large CAR using header-only fast path', async () => {
    // Build a large CAR that contains many additional blocks beyond the
    // root. The fast path reads only the first ~4 KiB so it must succeed
    // regardless of how many trailing blocks are present.
    const rootPayload = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const rootCid = buildCid(rootPayload);
    const { writer, out } = CarWriter.create([rootCid]);
    const chunks: Uint8Array[] = [];
    const collect = (async () => {
      for await (const c of out) chunks.push(c);
    })();
    await writer.put({ cid: rootCid, bytes: rootPayload });
    // Pile on trailing blocks. Each block is small (~512B) so 200 of
    // them push the total CAR size to ~100 KiB — comfortably above the
    // 4 KiB header probe slice. The fast path MUST still return the
    // correct root without scanning every block.
    for (let i = 0; i < 200; i++) {
      const filler = new Uint8Array(512);
      for (let j = 0; j < filler.length; j++) filler[j] = (i + j) & 0xff;
      const fillerCid = buildCid(filler);
      await writer.put({ cid: fillerCid, bytes: filler });
    }
    await writer.close();
    await collect;

    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const carBytes = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      carBytes.set(c, off);
      off += c.byteLength;
    }

    expect(carBytes.byteLength).toBeGreaterThan(4 * 1024);
    const cidStr = await extractCarRootCid(carBytes);
    expect(cidStr).toBe(rootCid.toString());
  });

  it('falls back to full reader when fast-path probe is insufficient', async () => {
    // Standard small valid single-root CAR — the fast path will succeed
    // here too, but this test specifically exercises the size threshold:
    // CARs smaller than the probe size skip the fast path entirely and
    // hit the slow path. We assert behaviour parity (same CID returned).
    const { bytes, rootCids } = await buildCar([new Uint8Array([0x01])]);
    expect(bytes.byteLength).toBeLessThan(4 * 1024);
    const cidStr = await extractCarRootCid(bytes);
    expect(cidStr).toBe(rootCids[0].toString());
  });
});

// =============================================================================
// 7. Base64 helpers — round-trip + strict alphabet
// =============================================================================

describe('carBytesToBase64 / carBase64ToBytes', () => {
  it('round-trips empty bytes', () => {
    expect(carBase64ToBytes(carBytesToBase64(new Uint8Array(0)))).toEqual(
      new Uint8Array(0),
    );
  });

  it('round-trips arbitrary bytes', () => {
    const original = new Uint8Array([0, 1, 2, 3, 0xff, 0xaa, 0x55]);
    expect(carBase64ToBytes(carBytesToBase64(original))).toEqual(original);
  });

  it('round-trips a non-zero subarray of a larger backing buffer', () => {
    // Subarrays share the underlying ArrayBuffer; the encoder must
    // honor the byteOffset/byteLength view.
    const big = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x42, 0x13, 0x37]);
    const view = big.subarray(2, 5); // [0xbe, 0xef, 0x42]
    expect(carBase64ToBytes(carBytesToBase64(view))).toEqual(
      new Uint8Array([0xbe, 0xef, 0x42]),
    );
  });

  it('rejects non-base64 input with BUNDLE_REJECTED_MALFORMED_ENVELOPE', () => {
    try {
      carBase64ToBytes('not!base64@@');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SphereError);
      if (err instanceof SphereError) {
        expect(err.code).toBe('BUNDLE_REJECTED_MALFORMED_ENVELOPE');
      }
    }
  });

  it('accepts properly-padded base64', () => {
    // 'AAA=' decodes to two bytes.
    expect(carBase64ToBytes('AAA=')).toEqual(new Uint8Array([0x00, 0x00]));
  });

  it('accepts unpadded base64 of length-multiple-of-4', () => {
    // 'AAEC' decodes to [0x00, 0x01, 0x02] (no padding because length 4
    // is the full quad).
    expect(carBase64ToBytes('AAEC')).toEqual(new Uint8Array([0x00, 0x01, 0x02]));
  });
});

// =============================================================================
// 8. Integration — encode→decode pairing for CAR-derived bundleCid
// =============================================================================

describe('encode/decode integration with extractCarRootCid', () => {
  it('decoder accepts a payload whose bundleCid matches its CAR root', async () => {
    const { bytes, rootCids } = await buildCar([new Uint8Array([0x99])]);
    const payload: UxfTransferPayloadCar = {
      kind: 'uxf-car',
      version: '1.0',
      mode: 'conservative',
      bundleCid: rootCids[0].toString(),
      tokenIds: ['00ff'],
      carBase64: carBytesToBase64(bytes),
    };
    const json = encodeTransferPayload(payload);
    const parsed = decodeTransferPayload(json);
    if (!('kind' in parsed) || parsed.kind !== 'uxf-car') {
      throw new Error('expected uxf-car');
    }
    expect(parsed.bundleCid).toBe(rootCids[0].toString());
    const recoveredCid = await extractCarRootCid(carBase64ToBytes(parsed.carBase64));
    expect(recoveredCid).toBe(parsed.bundleCid);
  });

  it('decoder does NOT enforce bundleCid===extractCarRootCid (delegated to T.3.A)', async () => {
    // The encoder/decoder is dumb: it preserves whatever the caller
    // passed. Cryptographic verification of CAR-vs-bundleCid is at the
    // pkg.verify() layer (T.3.A). This test pins that contract so a
    // future change to add a check here would surface explicitly.
    const { bytes } = await buildCar([new Uint8Array([0x99])]);
    const payload: UxfTransferPayloadCar = {
      kind: 'uxf-car',
      version: '1.0',
      mode: 'conservative',
      bundleCid: SAMPLE_CID_2, // deliberately wrong
      tokenIds: [],
      carBase64: carBytesToBase64(bytes),
    };
    // Encoder accepts (structural validity passes — `bundleCid` is
    // non-empty and a string; not checked for content).
    const json = encodeTransferPayload(payload);
    const parsed = decodeTransferPayload(json);
    expect(parsed).toEqual(payload);
  });
});
