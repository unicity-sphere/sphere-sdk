/**
 * Tests for `modules/payments/transfer/continuity-walker.ts` (T.3.B.1).
 *
 * Spec references: §5.3 [C](2) source-state continuity, Note C8 full-
 * chain walk mandatory.
 */

import { describe, it, expect } from 'vitest';

import {
  walkContinuity,
  type TxLike,
} from '../../../../extensions/uxf/pipeline/continuity-walker';

// =============================================================================
// Helpers
// =============================================================================

function tx(sourceState: string, destinationState: string): TxLike {
  return { sourceState, destinationState };
}

/** Build a contiguous chain of `n` txs:
 *  s0→s1, s1→s2, …, s(n-1)→sn. */
function contiguousChain(n: number): TxLike[] {
  const out: TxLike[] = [];
  for (let i = 0; i < n; i++) {
    out.push(tx(`s${i}`, `s${i + 1}`));
  }
  return out;
}

// =============================================================================
// Test cases
// =============================================================================

describe('walkContinuity — trivially valid', () => {
  it('returns ok:true for an empty chain', () => {
    const result = walkContinuity([]);
    expect(result.ok).toBe(true);
  });

  it('returns ok:true for a single-tx chain (no adjacent pair)', () => {
    const result = walkContinuity([tx('genesis', 'state1')]);
    expect(result.ok).toBe(true);
  });

  it('returns ok:true for a single-tx chain with arbitrary states', () => {
    const result = walkContinuity([tx('xyz', 'abc')]);
    expect(result.ok).toBe(true);
  });
});

describe('walkContinuity — contiguous chains pass', () => {
  it('returns ok:true for a 2-tx contiguous chain', () => {
    const result = walkContinuity(contiguousChain(2));
    expect(result.ok).toBe(true);
  });

  it('returns ok:true for a 5-tx contiguous chain', () => {
    const result = walkContinuity(contiguousChain(5));
    expect(result.ok).toBe(true);
  });

  it('returns ok:true for a 64-tx contiguous chain (MAX_CHAIN_DEPTH)', () => {
    const result = walkContinuity(contiguousChain(64));
    expect(result.ok).toBe(true);
  });

  it('first transaction may have any sourceState (no predecessor check)', () => {
    // Genesis tx's sourceState is the genesis state hash; we never
    // compare it to anything.
    const chain = [tx('any-genesis-thing', 's1'), tx('s1', 's2')];
    const result = walkContinuity(chain);
    expect(result.ok).toBe(true);
  });
});

describe('walkContinuity — broken continuity', () => {
  it('returns ok:false brokenAt:1 reason:continuity-broken on 2-tx splice', () => {
    const chain = [tx('s0', 's1'), tx('not-s1', 's2')];
    const result = walkContinuity(chain);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAt).toBe(1);
      expect(result.reason).toBe('continuity-broken');
    }
  });

  it('returns brokenAt:2 when the third tx has wrong source', () => {
    const chain = [tx('s0', 's1'), tx('s1', 's2'), tx('not-s2', 's3')];
    const result = walkContinuity(chain);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAt).toBe(2);
      expect(result.reason).toBe('continuity-broken');
    }
  });

  it('reports the FIRST broken index when multiple breaks exist', () => {
    const chain = [
      tx('s0', 's1'),
      tx('foreign-1', 'foreign-out'),  // break #1 at i=1
      tx('also-foreign', 'foreign-out2'), // break #2 at i=2 (would never report)
    ];
    const result = walkContinuity(chain);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAt).toBe(1);
    }
  });

  it('handles deep splice at the tail of a long chain', () => {
    // 10-tx chain, last one has wrong source.
    const chain = contiguousChain(9); // 9 txs, s0→s9
    chain.push(tx('foreign', 's10')); // break at i=9
    const result = walkContinuity(chain);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAt).toBe(9);
      expect(result.reason).toBe('continuity-broken');
    }
  });

  it('treats a partial entry (undefined fields) as a broken link', () => {
    // sparse partial (a defective tx parser would surface this)
    const chain: TxLike[] = [
      tx('s0', 's1'),
      { sourceState: undefined as unknown as string, destinationState: 's2' },
    ];
    const result = walkContinuity(chain);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAt).toBe(1);
    }
  });
});

describe('walkContinuity — defensive', () => {
  it('throws TypeError on non-array input', () => {
    expect(() =>
      walkContinuity(null as unknown as TxLike[]),
    ).toThrow(TypeError);
    expect(() =>
      walkContinuity(undefined as unknown as TxLike[]),
    ).toThrow(TypeError);
    expect(() =>
      walkContinuity({} as unknown as TxLike[]),
    ).toThrow(TypeError);
  });
});

describe('walkContinuity — purity / idempotence', () => {
  it('does not mutate the chain array', () => {
    const chain = contiguousChain(3);
    const snapshot = JSON.stringify(chain);
    walkContinuity(chain);
    expect(JSON.stringify(chain)).toBe(snapshot);
  });

  it('repeated calls return identical results', () => {
    const chain = contiguousChain(5);
    const a = walkContinuity(chain);
    const b = walkContinuity(chain);
    expect(a).toEqual(b);
  });

  it('repeated calls on broken chain return identical brokenAt', () => {
    const chain = [tx('s0', 's1'), tx('foreign', 's2')];
    const a = walkContinuity(chain);
    const b = walkContinuity(chain);
    expect(a).toEqual(b);
    if (!a.ok && !b.ok) {
      expect(a.brokenAt).toBe(b.brokenAt);
    }
  });
});
