/**
 * Issue #310 — OpLog epoch-floor walkback primitive unit tests.
 *
 * Pure unit tests for the helpers in `epoch-floor.ts`. The end-to-end
 * walkback behaviour (with `inspectSnapshotEpoch` wired into
 * `findLatestValidVersion`) lives in `discover-algorithm-epoch.test.ts`.
 */

import { describe, it, expect } from 'vitest';

import {
  normalizeEpoch,
  pickEpochFloor,
  shouldSkipForEpochFloor,
  computeEpochFloor,
} from '../../../../profile/aggregator-pointer/epoch-floor.js';

describe('normalizeEpoch', () => {
  it('treats undefined as epoch=0 (backwards-compat)', () => {
    expect(normalizeEpoch(undefined)).toBe(0);
  });

  it('returns the value verbatim for valid non-negative integers', () => {
    expect(normalizeEpoch(0)).toBe(0);
    expect(normalizeEpoch(1)).toBe(1);
    expect(normalizeEpoch(42)).toBe(42);
    expect(normalizeEpoch(1 << 20)).toBe(1 << 20);
  });

  it('throws on negative epochs', () => {
    expect(() => normalizeEpoch(-1)).toThrow(/non-negative integer/);
  });

  it('throws on non-integer values', () => {
    expect(() => normalizeEpoch(1.5)).toThrow(/non-negative integer/);
    expect(() => normalizeEpoch(NaN)).toThrow(/non-negative integer/);
    expect(() => normalizeEpoch(Infinity)).toThrow(/non-negative integer/);
  });

  it('throws on non-numeric values', () => {
    // @ts-expect-error — testing runtime guard
    expect(() => normalizeEpoch('1')).toThrow();
    // @ts-expect-error — testing runtime guard
    expect(() => normalizeEpoch(null)).toThrow();
  });
});

describe('pickEpochFloor', () => {
  it('returns 0 for (0, undefined)', () => {
    expect(pickEpochFloor(0, undefined)).toBe(0);
  });

  it('bumps from 0 to N when candidate.epoch=N>0', () => {
    expect(pickEpochFloor(0, 1)).toBe(1);
    expect(pickEpochFloor(0, 5)).toBe(5);
  });

  it('does not lower an existing floor', () => {
    expect(pickEpochFloor(5, 0)).toBe(5);
    expect(pickEpochFloor(5, 3)).toBe(5);
    expect(pickEpochFloor(5, undefined)).toBe(5);
  });

  it('raises the floor when candidate is higher', () => {
    expect(pickEpochFloor(3, 7)).toBe(7);
  });

  it('is idempotent for equal floor/candidate', () => {
    expect(pickEpochFloor(4, 4)).toBe(4);
  });
});

describe('shouldSkipForEpochFloor', () => {
  it('does not skip when floor=0 and candidate=undefined (pre-#310 chain)', () => {
    expect(shouldSkipForEpochFloor(0, undefined)).toBe(false);
  });

  it('does not skip when floor=0 and candidate=0', () => {
    expect(shouldSkipForEpochFloor(0, 0)).toBe(false);
  });

  it('does not skip when candidate.epoch === floor', () => {
    expect(shouldSkipForEpochFloor(2, 2)).toBe(false);
  });

  it('does not skip when candidate.epoch > floor', () => {
    expect(shouldSkipForEpochFloor(2, 3)).toBe(false);
  });

  it('SKIPS when candidate.epoch < floor', () => {
    expect(shouldSkipForEpochFloor(2, 1)).toBe(true);
    expect(shouldSkipForEpochFloor(2, 0)).toBe(true);
  });

  it('SKIPS pre-#310 candidate (undefined) when floor > 0', () => {
    // This is the load-bearing behavior: once a wallet has published
    // even one post-reset pointer (epoch >= 1), every pre-reset
    // ancestor (epoch missing → 0) is below the floor and walkback
    // refuses to load it.
    expect(shouldSkipForEpochFloor(1, undefined)).toBe(true);
    expect(shouldSkipForEpochFloor(5, undefined)).toBe(true);
  });
});

describe('computeEpochFloor', () => {
  it('returns 0 for an empty observation list', () => {
    expect(computeEpochFloor([])).toBe(0);
  });

  it('returns 0 when every observation is undefined (pre-#310)', () => {
    expect(computeEpochFloor([undefined, undefined, undefined])).toBe(0);
  });

  it('returns 0 when every observation is 0', () => {
    expect(computeEpochFloor([0, 0, 0])).toBe(0);
  });

  it('returns the max of mixed observations', () => {
    expect(computeEpochFloor([0, 1, 2, 3, 0, 1])).toBe(3);
    expect(computeEpochFloor([undefined, 5, undefined, 2])).toBe(5);
  });

  it('is order-independent (commutative)', () => {
    expect(computeEpochFloor([1, 2, 3])).toBe(computeEpochFloor([3, 2, 1]));
    expect(computeEpochFloor([0, undefined, 5])).toBe(
      computeEpochFloor([5, undefined, 0]),
    );
  });
});

describe('walkback simulation (top-down)', () => {
  /**
   * Simulate a Phase-3 walkback. The input is the sequence of
   * candidate-epochs (top-down: v=10 first, v=1 last). The output is
   * the picked version (1-indexed from the top, 0 if no candidate
   * survived).
   */
  function simulate(
    candidates: ReadonlyArray<number | undefined>,
    primeFloor: number = 0,
  ): { pickedIndex: number; floor: number; skipped: number[] } {
    let floor = primeFloor;
    const skipped: number[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (shouldSkipForEpochFloor(floor, c)) {
        skipped.push(i);
        continue;
      }
      floor = pickEpochFloor(floor, c);
      return { pickedIndex: i + 1, floor, skipped };
    }
    return { pickedIndex: 0, floor, skipped };
  }

  it('picks the FIRST candidate in a pre-#310 chain (all undefined)', () => {
    const { pickedIndex, floor } = simulate([undefined, undefined, undefined]);
    expect(pickedIndex).toBe(1);
    expect(floor).toBe(0);
  });

  it('picks epoch=2 over a pre-reset epoch=1 ancestor', () => {
    const { pickedIndex, floor, skipped } = simulate([2, 1, undefined]);
    expect(pickedIndex).toBe(1);
    expect(floor).toBe(2);
    expect(skipped).toEqual([]);
  });

  it('skips pre-reset ancestors when primed with floor=2', () => {
    // Phase 2 includedV is the highest valid v on-chain (epoch=2 there).
    // Phase 3 starts at includedV and walks down. The first candidate
    // (epoch=2) matches the floor and gets picked.
    const { pickedIndex, floor } = simulate([2, 1, undefined], 2);
    expect(pickedIndex).toBe(1);
    expect(floor).toBe(2);
  });

  it('skips ALL pre-reset ancestors when only pre-reset entries remain', () => {
    // E.g. floor primed at 2 (from local persisted state), but
    // aggregator only serves epoch=1 entries (stale state from a
    // device that lost the reset).
    const { pickedIndex, skipped } = simulate([1, undefined, 0], 2);
    expect(pickedIndex).toBe(0);
    expect(skipped).toEqual([0, 1, 2]);
  });

  it('lets a higher candidate raise the floor mid-walkback', () => {
    // includedV has epoch=1 → floor moves to 1 → next candidate epoch=0
    // gets skipped. We end up picking the epoch=1 entry.
    const { pickedIndex, floor, skipped } = simulate([1, 0, 0]);
    expect(pickedIndex).toBe(1);
    expect(floor).toBe(1);
    expect(skipped).toEqual([]);
  });
});
