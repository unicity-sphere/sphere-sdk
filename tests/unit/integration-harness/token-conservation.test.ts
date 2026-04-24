/**
 * Self-tests for the Token Conservation Invariant harness
 * (tests/integration/pointer/token-conservation.ts).
 *
 * The harness is load-bearing for every Phase E integration test
 * that touches the token pool. A bug in the harness would either
 * mask violations (false negatives) or flag innocent reconciles
 * (false positives). These tests exercise both failure modes
 * directly.
 */

import { describe, it, expect } from 'vitest';
import {
  assertTokenConservation,
  captureSnapshot,
  diffSnapshots,
  TokenConservationViolation,
  type ConservationToken,
} from '../../integration/pointer/token-conservation';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tok(tokenId: string, coinId: string, amount: bigint): ConservationToken {
  return { tokenId, coins: [{ coinId, amount }] };
}

function multi(
  tokenId: string,
  coins: Array<[string, bigint]>,
): ConservationToken {
  return { tokenId, coins: coins.map(([coinId, amount]) => ({ coinId, amount })) };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('assertTokenConservation — identity (no-op)', () => {
  it('passes when before == after with no mint/burn', () => {
    const snap = captureSnapshot('before', [tok('t1', 'UCT', 100n), tok('t2', 'UCT', 50n)]);
    expect(() => assertTokenConservation(snap, snap)).not.toThrow();
  });

  it('passes when an empty pool stays empty', () => {
    const empty = captureSnapshot('empty', []);
    expect(() => assertTokenConservation(empty, empty)).not.toThrow();
  });
});

describe('assertTokenConservation — mint + burn accounting', () => {
  it('passes when an explicit mint accounts for the new coin', () => {
    const before = captureSnapshot('before', [tok('t1', 'UCT', 100n)]);
    const after = captureSnapshot('after', [
      tok('t1', 'UCT', 100n),
      tok('t2', 'UCT', 200n),
    ]);
    expect(() =>
      assertTokenConservation(before, after, {
        minted: [tok('t2', 'UCT', 200n)],
      }),
    ).not.toThrow();
  });

  it('passes when an explicit burn accounts for the missing coin', () => {
    const before = captureSnapshot('before', [tok('t1', 'UCT', 100n), tok('t2', 'UCT', 200n)]);
    const after = captureSnapshot('after', [tok('t1', 'UCT', 100n)]);
    expect(() =>
      assertTokenConservation(before, after, {
        burned: [tok('t2', 'UCT', 200n)],
      }),
    ).not.toThrow();
  });

  it('passes with mixed mint and burn in the same op', () => {
    const before = captureSnapshot('before', [tok('t1', 'UCT', 100n)]);
    const after = captureSnapshot('after', [tok('t2', 'UCT', 50n), tok('t3', 'USDU', 30n)]);
    expect(() =>
      assertTokenConservation(before, after, {
        minted: [tok('t2', 'UCT', 50n), tok('t3', 'USDU', 30n)],
        burned: [tok('t1', 'UCT', 100n)],
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Violations — each mode the harness must catch
// ---------------------------------------------------------------------------

describe('assertTokenConservation — violation detection', () => {
  it('throws TokenConservationViolation when a coin disappears unaccounted', () => {
    const before = captureSnapshot('before', [tok('t1', 'UCT', 100n)]);
    const after = captureSnapshot('after', []);
    expect(() => assertTokenConservation(before, after)).toThrow(TokenConservationViolation);
  });

  it('throws when a coin appears unaccounted (unexpected mint)', () => {
    const before = captureSnapshot('before', []);
    const after = captureSnapshot('after', [tok('t1', 'UCT', 100n)]);
    expect(() => assertTokenConservation(before, after)).toThrow(TokenConservationViolation);
  });

  it('throws when declared minted amount does not match observed', () => {
    const before = captureSnapshot('before', []);
    const after = captureSnapshot('after', [tok('t1', 'UCT', 100n)]);
    // Claim we minted 50, but 100 showed up.
    expect(() =>
      assertTokenConservation(before, after, { minted: [tok('t1', 'UCT', 50n)] }),
    ).toThrow(TokenConservationViolation);
  });

  it('throws when declared burned amount does not match observed', () => {
    const before = captureSnapshot('before', [tok('t1', 'UCT', 100n)]);
    const after = captureSnapshot('after', [tok('t1', 'UCT', 100n)]); // nothing actually burned
    expect(() =>
      assertTokenConservation(before, after, { burned: [tok('t1', 'UCT', 50n)] }),
    ).toThrow(TokenConservationViolation);
  });

  it('error surfaces divergent coinIds with expected / observed / delta', () => {
    const before = captureSnapshot('snap-A', [tok('t1', 'UCT', 100n)]);
    const after = captureSnapshot('snap-B', [tok('t1', 'UCT', 90n)]); // 10 UCT vanished

    try {
      assertTokenConservation(before, after);
      throw new Error('expected TokenConservationViolation');
    } catch (err) {
      expect(err).toBeInstanceOf(TokenConservationViolation);
      const e = err as TokenConservationViolation;
      expect(e.message).toContain('snap-A');
      expect(e.message).toContain('snap-B');
      expect(e.message).toContain('UCT');
      const detail = e.byCoin.get('UCT');
      expect(detail).toBeDefined();
      expect(detail!.expected).toBe(100n);
      expect(detail!.observed).toBe(90n);
      expect(detail!.delta).toBe(-10n);
    }
  });

  it('aggregates multiple coin violations into one error (not just the first)', () => {
    const before = captureSnapshot('before', [
      tok('t1', 'UCT', 100n),
      tok('t2', 'USDU', 50n),
    ]);
    const after = captureSnapshot('after', [
      tok('t1', 'UCT', 90n), // -10 UCT
      tok('t2', 'USDU', 30n), // -20 USDU
    ]);
    try {
      assertTokenConservation(before, after);
      throw new Error('expected violation');
    } catch (err) {
      expect(err).toBeInstanceOf(TokenConservationViolation);
      const e = err as TokenConservationViolation;
      expect(e.byCoin.size).toBe(2);
      expect(e.byCoin.get('UCT')?.delta).toBe(-10n);
      expect(e.byCoin.get('USDU')?.delta).toBe(-20n);
    }
  });
});

// ---------------------------------------------------------------------------
// Multi-coin tokens + tolerance
// ---------------------------------------------------------------------------

describe('assertTokenConservation — multi-coin tokens', () => {
  it('sums coin amounts across a multi-asset token', () => {
    const before = captureSnapshot('before', [
      multi('tokA', [
        ['UCT', 100n],
        ['USDU', 50n],
      ]),
    ]);
    const after = captureSnapshot('after', [
      tok('tokA1', 'UCT', 100n),
      tok('tokA2', 'USDU', 50n),
    ]);
    // Total per-coin is preserved; tokenId distribution is allowed
    // to change (e.g., split into two tokens).
    expect(() => assertTokenConservation(before, after)).not.toThrow();
  });
});

describe('assertTokenConservation — tolerance', () => {
  it('accepts a small delta within the per-coin tolerance', () => {
    const before = captureSnapshot('before', [tok('t1', 'UCT', 1000n)]);
    const after = captureSnapshot('after', [tok('t1', 'UCT', 998n)]); // -2 UCT

    expect(() =>
      assertTokenConservation(before, after, {
        tolerance: new Map([['UCT', 2n]]),
      }),
    ).not.toThrow();
  });

  it('rejects a delta just past the tolerance', () => {
    const before = captureSnapshot('before', [tok('t1', 'UCT', 1000n)]);
    const after = captureSnapshot('after', [tok('t1', 'UCT', 997n)]); // -3, tolerance 2
    expect(() =>
      assertTokenConservation(before, after, {
        tolerance: new Map([['UCT', 2n]]),
      }),
    ).toThrow(TokenConservationViolation);
  });
});

// ---------------------------------------------------------------------------
// diffSnapshots
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Input validation — steelman W1/W2/W3
// ---------------------------------------------------------------------------

describe('assertTokenConservation — input validation guards', () => {
  it('rejects a fixture with a negative coin amount (W1 false-negative guard)', () => {
    const bad = captureSnapshot('bad', [tok('t1', 'UCT', -10n)]);
    const empty = captureSnapshot('empty', []);
    expect(() => assertTokenConservation(bad, empty)).toThrow(/negative amount/);
    expect(() => assertTokenConservation(empty, bad)).toThrow(/negative amount/);
  });

  it('rejects a fixture with a duplicate coinId in one token (W3 silent-sum guard)', () => {
    const bad: ConservationToken = {
      tokenId: 't1',
      coins: [
        { coinId: 'UCT', amount: 5n },
        { coinId: 'UCT', amount: 5n },
      ],
    };
    const snap = captureSnapshot('snap', [bad]);
    expect(() =>
      assertTokenConservation(snap, captureSnapshot('empty', [])),
    ).toThrow(/more than once/);
  });

  it('rejects a negative tolerance (W2 false-positive guard)', () => {
    const a = captureSnapshot('a', [tok('t1', 'UCT', 10n)]);
    const b = captureSnapshot('b', [tok('t1', 'UCT', 10n)]);
    expect(() =>
      assertTokenConservation(a, b, {
        tolerance: new Map([['UCT', -1n]]),
      }),
    ).toThrow(/negative/);
  });

  it('byCoin map on the thrown violation is frozen (cannot be mutated by reporters)', () => {
    const before = captureSnapshot('before', [tok('t1', 'UCT', 100n)]);
    const after = captureSnapshot('after', [tok('t1', 'UCT', 50n)]);
    try {
      assertTokenConservation(before, after);
      throw new Error('expected violation');
    } catch (err) {
      const e = err as TokenConservationViolation;
      // Map.set on a frozen map throws in strict mode; in sloppy
      // mode it silently no-ops. Assert the resulting state is
      // unchanged either way.
      const before = e.byCoin.size;
      try {
        (e.byCoin as unknown as Map<string, unknown>).set('hack', {});
      } catch {
        // expected TypeError on frozen map
      }
      expect(e.byCoin.size).toBe(before);
    }
  });
});

describe('diffSnapshots', () => {
  it('returns a per-coin diff sorted by coinId', () => {
    const a = captureSnapshot('a', [
      tok('t1', 'UCT', 100n),
      tok('t2', 'USDU', 50n),
    ]);
    const b = captureSnapshot('b', [
      tok('t1', 'UCT', 150n),
      tok('t2', 'USDU', 50n),
      tok('t3', 'ZZZ', 10n),
    ]);
    const diff = diffSnapshots(a, b);
    expect([...diff.keys()]).toEqual(['UCT', 'USDU', 'ZZZ']);
    expect(diff.get('UCT')).toEqual({ a: 100n, b: 150n, delta: 50n });
    expect(diff.get('USDU')).toEqual({ a: 50n, b: 50n, delta: 0n });
    expect(diff.get('ZZZ')).toEqual({ a: 0n, b: 10n, delta: 10n });
  });
});
