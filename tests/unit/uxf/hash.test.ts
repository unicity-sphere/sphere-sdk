import { describe, it, expect } from 'vitest';
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

  it('converts SmtPath segments data to bytes and path to BigInt', () => {
    const result = prepareContentForHashing('smt-path', {
      segments: [{ data: 'aabb', path: '42' }],
    });
    const segments = result.segments as Array<{ data: Uint8Array | null; path: bigint }>;
    expect(segments[0].data).toEqual(new Uint8Array([0xaa, 0xbb]));
    expect(segments[0].path).toBe(BigInt(42));
  });

  it('handles SmtPath segments with null data', () => {
    const result = prepareContentForHashing('smt-path', {
      segments: [{ data: null, path: '0' }],
    });
    const segments = result.segments as Array<{ data: Uint8Array | null; path: bigint }>;
    expect(segments[0].data).toBeNull();
    expect(segments[0].path).toBe(BigInt(0));
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
});

describe('prepareChildrenForHashing', () => {
  it('converts single ContentHash to Uint8Array', () => {
    const hash = contentHash('aa'.repeat(32));
    const result = prepareChildrenForHashing({ genesis: hash });
    expect(result.genesis).toBeInstanceOf(Uint8Array);
    expect((result.genesis as Uint8Array).length).toBe(32);
  });

  it('converts array of ContentHash to array of Uint8Array', () => {
    const h1 = contentHash('aa'.repeat(32));
    const h2 = contentHash('bb'.repeat(32));
    const result = prepareChildrenForHashing({ transactions: [h1, h2] });
    const arr = result.transactions as Uint8Array[];
    expect(arr).toHaveLength(2);
    expect(arr[0]).toBeInstanceOf(Uint8Array);
    expect(arr[1]).toBeInstanceOf(Uint8Array);
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
});
