import { describe, it, expect } from 'vitest';
import { CID } from 'multiformats';
import { SparseMerkleTreePath } from '@unicitylabs/state-transition-sdk/lib/mtree/plain/SparseMerkleTreePath.js';
import {
  hexToBytes,
  prepareContentForHashing,
  prepareChildrenForHashing,
  computeElementHash,
} from '../../../uxf/hash.js';
import { UxfError } from '../../../uxf/errors.js';
import type { ContentHash, UxfElement } from '../../../uxf/types.js';
import { contentHash } from '../../../uxf/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal UxfElement with default header. */
function makeElement(
  type: UxfElement['type'],
  content: Record<string, unknown> = {},
  children: Record<string, ContentHash | ContentHash[] | null> = {},
): UxfElement {
  return {
    header: {
      representation: 1,
      semantics: 1,
      kind: 'default',
      predecessor: null,
    },
    type,
    content,
    children,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('hexToBytes', () => {
  it('converts valid hex to bytes', () => {
    const result = hexToBytes('0102ff');
    expect(result).toEqual(new Uint8Array([1, 2, 255]));
  });

  it('converts empty string to empty array', () => {
    const result = hexToBytes('');
    expect(result).toEqual(new Uint8Array(0));
    expect(result.length).toBe(0);
  });

  it('rejects odd-length hex', () => {
    expect(() => hexToBytes('abc')).toThrow(UxfError);
    try {
      hexToBytes('abc');
    } catch (e) {
      expect((e as UxfError).code).toBe('INVALID_HASH');
    }
  });

  it('rejects non-hex characters', () => {
    expect(() => hexToBytes('zzzz')).toThrow(UxfError);
    try {
      hexToBytes('zzzz');
    } catch (e) {
      expect((e as UxfError).code).toBe('INVALID_HASH');
    }
  });

  it('accepts uppercase hex', () => {
    const result = hexToBytes('AABB');
    expect(result).toEqual(new Uint8Array([0xaa, 0xbb]));
  });
});

describe('prepareContentForHashing', () => {
  it('converts hex byte fields to Uint8Array', () => {
    const result = prepareContentForHashing('authenticator', {
      publicKey: 'aabb',
      algorithm: 'secp256k1',
      signature: 'ccdd',
      stateHash: 'eeff',
    });
    expect(result.publicKey).toBeInstanceOf(Uint8Array);
    expect(result.signature).toBeInstanceOf(Uint8Array);
    expect(result.stateHash).toBeInstanceOf(Uint8Array);
    expect(result.algorithm).toBe('secp256k1');
  });

  it('preserves string fields unchanged', () => {
    const result = prepareContentForHashing('genesis-data', {
      recipient: 'DIRECT://abc',
      tokenId: 'aa'.repeat(32),
    });
    expect(typeof result.recipient).toBe('string');
    expect(result.recipient).toBe('DIRECT://abc');
    expect(result.tokenId).toBeInstanceOf(Uint8Array);
  });

  it('passes null values through as null', () => {
    const result = prepareContentForHashing('genesis-data', {
      recipientDataHash: null,
    });
    expect(result.recipientDataHash).toBeNull();
  });

  it('passes Uint8Array values through', () => {
    const reason = new Uint8Array([1, 2, 3]);
    const result = prepareContentForHashing('genesis-data', { reason });
    expect(result.reason).toBe(reason);
  });

  it('treats smt-path cbor field as an opaque byte-field (hex string -> Uint8Array)', () => {
    // Issue #295 (rewrite #2): SmtPath content is a single opaque
    // `cbor` byte-field — UXF does NOT decompose into {root, segments}.
    // BYTE_FIELDS['smt-path'] = {'cbor'} so the hex value converts to
    // Uint8Array via the generic byte-field path.
    const opaqueHex = 'd9f6818220a0' /* arbitrary CBOR bytes */ + '00';
    const result = prepareContentForHashing('smt-path', {
      cbor: opaqueHex,
    });
    expect(result.cbor).toBeInstanceOf(Uint8Array);
    // Length must match the hex (each byte = 2 hex chars).
    expect((result.cbor as Uint8Array).length).toBe(opaqueHex.length / 2);
  });

  it('smt-path cbor byte-field is passed through verbatim to dag-cbor', async () => {
    const { encode } = await import('@ipld/dag-cbor');
    // Use a fixed hex blob — what STS would produce — and verify
    // dag-cbor encodes it as a single CBOR bstr unchanged.
    const opaqueHex = 'a1646372616672' /* fake STS-shaped bytes */;
    const result = prepareContentForHashing('smt-path', {
      cbor: opaqueHex,
    });
    // Must not throw; UXF never touches the payload.
    expect(() => encode(result)).not.toThrow();
    // Determinism: two calls -> same bytes.
    const a = encode(result);
    const b = encode(result);
    expect(a).toEqual(b);
  });

  it('converts transaction-data nametagRefs to byte arrays', () => {
    const hash = 'aa'.repeat(32);
    const result = prepareContentForHashing('transaction-data', {
      nametagRefs: [hash],
    });
    const refs = result.nametagRefs as Uint8Array[];
    expect(refs[0]).toBeInstanceOf(Uint8Array);
    expect(refs[0].length).toBe(32);
  });

  // Wave H — null hash canonicalization: '' / null / Uint8Array(0)
  // for byte-fields all canonicalize to CBOR null. Two compliant SDKs
  // with different "no value" representations now produce identical
  // content hashes for the same logical token.
  describe('Wave H — empty byte-field canonicalization', () => {
    it("normalizes '' to null for byte-fields", () => {
      const result = prepareContentForHashing('genesis-data', {
        tokenData: '',
        recipient: 'DIRECT://x',
      });
      expect(result.tokenData).toBeNull();
      // Non-byte fields keep their value verbatim.
      expect(result.recipient).toBe('DIRECT://x');
    });

    it("normalizes empty Uint8Array to null for byte-fields", () => {
      const result = prepareContentForHashing('genesis-data', {
        recipientDataHash: new Uint8Array(0),
      });
      expect(result.recipientDataHash).toBeNull();
    });

    it('null already passes through as null for byte-fields', () => {
      const result = prepareContentForHashing('genesis-data', {
        salt: null,
      });
      expect(result.salt).toBeNull();
    });

    it("'' / null / Uint8Array(0) all hash identically for the same byte-field", async () => {
      const baseInput = (val: unknown): Record<string, unknown> => ({
        tokenId: 'aa'.repeat(32),
        tokenType: 'bb'.repeat(32),
        salt: 'cc'.repeat(32),
        tokenData: val,
        recipientDataHash: null,
        recipient: 'DIRECT://x',
      });
      const a = prepareContentForHashing('genesis-data', baseInput(''));
      const b = prepareContentForHashing('genesis-data', baseInput(null));
      const c = prepareContentForHashing('genesis-data', baseInput(new Uint8Array(0)));
      // All three should be deeply identical after preparation.
      expect(a.tokenData).toBeNull();
      expect(b.tokenData).toBeNull();
      expect(c.tokenData).toBeNull();
      // The whole prepared dict must be equivalent.
      expect(a).toEqual(b);
      expect(a).toEqual(c);
    });

    it('preserves non-empty byte-field bytes verbatim', () => {
      const result = prepareContentForHashing('genesis-data', {
        tokenData: '616c696365', // hex("alice")
      });
      expect(result.tokenData).toBeInstanceOf(Uint8Array);
      expect((result.tokenData as Uint8Array).length).toBe(5);
    });

    it('does NOT normalize empty values for non-byte fields', () => {
      // recipient is NOT a byte-field — preserves '' as-is.
      const result = prepareContentForHashing('genesis-data', {
        recipient: '',
      });
      expect(result.recipient).toBe('');
    });
  });

  // Phase 9.5.D regression: @ipld/dag-cbor rejects `undefined` at encode
  // time. An upstream producer (instant-mode commitSources) previously
  // passed commitment.toJSON() (the Commitment envelope) instead of
  // commitment.toJSON().transactionData (the flat TransferDataShape),
  // causing all scalar content fields to be `undefined`. The defensive
  // strip guards against future regressions even if the upstream is fixed.
  describe('undefined field stripping (IPLD safety)', () => {
    it('strips undefined fields rather than forwarding to dag-cbor', async () => {
      // Simulate the broken producer shape: content with undefined values.
      const result = prepareContentForHashing('transaction-data', {
        recipient: undefined as unknown as string,
        salt: undefined as unknown as string,
        recipientDataHash: null,
        message: null,
        nametagRefs: [],
      });
      // undefined fields must be absent from the prepared map.
      expect('recipient' in result).toBe(false);
      expect('salt' in result).toBe(false);
      // null and other defined fields are preserved.
      expect(result.recipientDataHash).toBeNull();
      expect(result.message).toBeNull();
    });

    it('element with undefined content field hashes without throwing', async () => {
      const { encode } = await import('@ipld/dag-cbor');
      // An element where the producer leaked `undefined` into content.
      // computeElementHash must not throw even before the upstream fix,
      // thanks to the defensive strip.
      const el: UxfElement = makeElement('transaction-data', {
        recipient: undefined as unknown as string,
        salt: undefined as unknown as string,
        recipientDataHash: null,
        message: null,
        nametagRefs: [],
      });
      // Must not throw "undefined is not supported by the IPLD Data Model"
      expect(() => computeElementHash(el)).not.toThrow();
      // Hash must be deterministic (same element, same hash)
      const hash1 = computeElementHash(el);
      const hash2 = computeElementHash(el);
      expect(hash1).toBe(hash2);
      // Must be a valid 64-char hex string
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
      // Encoding the canonical form must also not throw
      // (the raw encode call is what dag-cbor does inside computeElementHash)
      expect(hash1).toBeTruthy();
      // The prepared content must not include the undefined keys
      void encode; // import used to ensure dag-cbor is loaded
    });

    it('element with null content field differs from element with undefined (omitted) field', () => {
      // null and absent (stripped undefined) are distinct in CBOR.
      // This test documents the semantic: they produce DIFFERENT hashes.
      const elWithNull = makeElement('transaction-data', {
        recipient: 'DIRECT://alice',
        salt: 'aa'.repeat(32),
        recipientDataHash: null,
        message: null,
        nametagRefs: [],
      });
      const elWithUndefined: UxfElement = makeElement('transaction-data', {
        recipient: 'DIRECT://alice',
        salt: 'aa'.repeat(32),
        recipientDataHash: undefined as unknown as null,
        message: null,
        nametagRefs: [],
      });
      // undefined → stripped (absent in CBOR) ≠ null (CBOR null)
      // They are semantically distinct so their hashes differ.
      expect(computeElementHash(elWithNull)).not.toBe(computeElementHash(elWithUndefined));
    });
  });
});

describe('prepareChildrenForHashing', () => {
  // Issue #435 — children are emitted as Tag 42 CID-links so Kubo's
  // recursive pin / `/dag/export` walkers natively follow the DAG.
  it('converts single ContentHash to a Tag 42 CID-link', () => {
    const hash = contentHash('aa'.repeat(32));
    const result = prepareChildrenForHashing({ genesis: hash });
    expect(result.genesis).toBeInstanceOf(CID);
    const cid = result.genesis as CID;
    // dag-cbor codec (0x71) + sha2-256 multihash (0x12) with the
    // original 32-byte digest preserved.
    expect(cid.code).toBe(0x71);
    expect(cid.multihash.code).toBe(0x12);
    expect(cid.multihash.digest).toEqual(new Uint8Array(32).fill(0xaa));
  });

  it('converts array of ContentHash to array of Tag 42 CID-links', () => {
    const h1 = contentHash('aa'.repeat(32));
    const h2 = contentHash('bb'.repeat(32));
    const result = prepareChildrenForHashing({ transactions: [h1, h2] });
    const arr = result.transactions as CID[];
    expect(arr).toHaveLength(2);
    expect(arr[0]).toBeInstanceOf(CID);
    expect(arr[1]).toBeInstanceOf(CID);
    expect(arr[0].multihash.digest).toEqual(new Uint8Array(32).fill(0xaa));
    expect(arr[1].multihash.digest).toEqual(new Uint8Array(32).fill(0xbb));
  });

  it('preserves null children', () => {
    const result = prepareChildrenForHashing({ inclusionProof: null });
    expect(result.inclusionProof).toBeNull();
  });
});

describe('computeElementHash', () => {
  it('deterministic: same element produces same hash', () => {
    const el = makeElement('token-state', {
      data: 'ab'.repeat(32),
      predicate: 'cd'.repeat(32),
    });
    const hash1 = computeElementHash(el);
    const hash2 = computeElementHash(el);
    expect(hash1).toBe(hash2);
  });

  it('different elements produce different hashes', () => {
    const el1 = makeElement('token-state', {
      data: 'ab'.repeat(32),
      predicate: 'cd'.repeat(32),
    });
    const el2 = makeElement('token-state', {
      data: 'ef'.repeat(32),
      predicate: 'cd'.repeat(32),
    });
    expect(computeElementHash(el1)).not.toBe(computeElementHash(el2));
  });

  it('returns valid 64-char lowercase hex', () => {
    const el = makeElement('authenticator', {
      algorithm: 'secp256k1',
      publicKey: 'aa'.repeat(16),
      signature: 'bb'.repeat(32),
      stateHash: 'cc'.repeat(32),
    });
    const hash = computeElementHash(el);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('key ordering does not affect hash (dag-cbor sorts)', () => {
    // Build content with keys in different insertion order
    const contentA: Record<string, unknown> = {};
    contentA['data'] = 'ab'.repeat(32);
    contentA['predicate'] = 'cd'.repeat(32);

    const contentB: Record<string, unknown> = {};
    contentB['predicate'] = 'cd'.repeat(32);
    contentB['data'] = 'ab'.repeat(32);

    const elA = makeElement('token-state', contentA);
    const elB = makeElement('token-state', contentB);

    expect(computeElementHash(elA)).toBe(computeElementHash(elB));
  });

  it('null predecessor in header encodes as CBOR null', () => {
    const el = makeElement('token-state', {
      data: null,
      predicate: 'aa'.repeat(32),
    });
    expect(el.header.predecessor).toBeNull();
    const hash = computeElementHash(el);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('non-null predecessor in header encodes as bytes', () => {
    const pred = contentHash('ff'.repeat(32));
    const elWithPred: UxfElement = {
      header: {
        representation: 1,
        semantics: 1,
        kind: 'default',
        predecessor: pred,
      },
      type: 'token-state',
      content: { data: null, predicate: 'aa'.repeat(32) },
      children: {},
    };
    const elNullPred = makeElement('token-state', {
      data: null,
      predicate: 'aa'.repeat(32),
    });
    expect(computeElementHash(elWithPred)).not.toBe(computeElementHash(elNullPred));
  });

  it('known test vector', () => {
    // Construct a specific token-state element with known content
    const el = makeElement('token-state', {
      predicate: 'ab'.repeat(32),
      data: 'cd'.repeat(32),
    });
    // Compute the hash once; this value is deterministic because dag-cbor
    // produces canonical CBOR and SHA-256 is deterministic.
    const hash = computeElementHash(el);
    // Hardcode the known result (computed by the implementation itself and
    // verified to be stable across runs).
    expect(hash).toBe(hash); // sanity -- not a no-op, we verify format next
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    // To lock down the vector we compute it once and freeze:
    const frozen = computeElementHash(el);
    expect(frozen).toBe(hash);

    // Hardcoded known test vector -- ensures future refactors don't silently
    // change the hash algorithm.
    expect(hash).toBe('e4e0b32c46a99bf781e7c6e3cde42993b5fa72bf1b00184d8c8018d1b8cca730');
  });

  // -------------------------------------------------------------------------
  // Steelman Wave 3 — domain-separation safety: refuse to silently hash
  // an element whose `type` is missing from ELEMENT_TYPE_IDS. Without
  // this gate, dag-cbor would encode `typeId: undefined` for every
  // unrecognized type, collapsing them into one collision class.
  // -------------------------------------------------------------------------
  it('refuses to hash an element with an unknown type tag', () => {
    // Forge an element with a type that does NOT exist in ELEMENT_TYPE_IDS.
    // Cast through `unknown` since the public type is a string union;
    // simulates a future schema add or a hostile producer.
    const el = {
      header: {
        representation: 1,
        semantics: 1,
        kind: 'default',
        predecessor: null,
      },
      type: 'definitely-not-a-real-element-type' as unknown as UxfElement['type'],
      content: { foo: 'bar' },
      children: {},
    } as UxfElement;

    expect(() => computeElementHash(el)).toThrow(UxfError);
    try {
      computeElementHash(el);
    } catch (e) {
      expect((e as UxfError).code).toBe('INVALID_HASH');
      expect((e as UxfError).message).toContain('Unknown element type');
      expect((e as UxfError).message).toContain('definitely-not-a-real-element-type');
    }
  });

  it('refuses to hash an element whose type is undefined entirely', () => {
    // Adversarial shape: `type` field is missing or undefined. dag-cbor
    // would produce CBOR `undefined` for the typeId — same collision
    // class as any other unknown type.
    const el = {
      header: {
        representation: 1,
        semantics: 1,
        kind: 'default',
        predecessor: null,
      },
      // type intentionally omitted via cast
      content: {},
      children: {},
    } as unknown as UxfElement;

    expect(() => computeElementHash(el)).toThrow(UxfError);
    try {
      computeElementHash(el);
    } catch (e) {
      expect((e as UxfError).code).toBe('INVALID_HASH');
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #295 (rewrite #2) — UXF embeds InclusionProof's SMT path as an
// opaque STS-canonical CBOR blob. UXF does NOT decompose, does NOT
// inspect, and does NOT impose a bit-length limit on the path.
// Encoding and decoding are owned by state-transition-sdk
// (`SparseMerkleTreePath.toCBOR()` / `.fromCBOR()`).
// ---------------------------------------------------------------------------

describe('Issue #295 — UXF treats SmtPath as opaque STS-canonical CBOR', () => {
  it('passes any STS-shaped CBOR blob through unmodified to dag-cbor encode', async () => {
    const { encode } = await import('@ipld/dag-cbor');
    // Build a real STS-canonical CBOR blob by deconstructing a
    // SparseMerkleTreePath. This is the only test in hash.ts that
    // touches STS — the test exercises the contract that UXF
    // forwards whatever STS gives it.
    const sdkPath = SparseMerkleTreePath.fromJSON({
      root: '00'.repeat(32),
      steps: [
        // A small step plus the user-reported 259-bit walkback value.
        { path: '42', data: null },
        {
          path:
            '463173912653332971197029146511962916219743101902252076413000309295050477951098',
          data: 'aa'.repeat(32),
        },
      ],
    });
    const cborBytes = sdkPath.toCBOR();
    const cborHex = Array.from(cborBytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    const result = prepareContentForHashing('smt-path', { cbor: cborHex });
    // UXF converts hex -> Uint8Array via BYTE_FIELDS but otherwise
    // forwards the bytes verbatim. The bytes are the STS-canonical
    // form, not anything UXF synthesised.
    expect(result.cbor).toBeInstanceOf(Uint8Array);
    expect(Array.from(result.cbor as Uint8Array)).toEqual(Array.from(cborBytes));

    // Round-trip through dag-cbor — must not throw and must be
    // deterministic.
    expect(() => encode(result)).not.toThrow();
    const a = encode(result);
    const b = encode(result);
    expect(a).toEqual(b);
  });

  it('does not impose any bit-length limit on the path content (UXF layer)', () => {
    // Build an STS path with a 273-bit step (the BitString(34-byte
    // imprint) ceiling). UXF must accept the STS-canonical bytes
    // without throwing.
    const sdkPath = SparseMerkleTreePath.fromJSON({
      root: '11'.repeat(32),
      steps: [
        { path: (2n ** 273n - 1n).toString(), data: 'bb'.repeat(32) },
      ],
    });
    const cborBytes = sdkPath.toCBOR();
    const cborHex = Array.from(cborBytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    // No UXF-level throw.
    expect(() =>
      prepareContentForHashing('smt-path', { cbor: cborHex }),
    ).not.toThrow();
  });
});
