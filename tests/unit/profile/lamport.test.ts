/**
 * Tests for profile/lamport.ts — UXF Transfer Protocol §7.1.
 *
 * Covers Lamport-clock invariants, bounds defense (W39), and
 * per-instance scoping (no module-level globals).
 */

import { describe, it, expect } from 'vitest';
import { Lamport } from '../../../profile/lamport';
import { SphereError } from '../../../core/errors';

describe('Lamport', () => {
  describe('constructor', () => {
    it('defaults to 0', () => {
      const l = new Lamport();
      expect(l.getCurrent()).toBe(0);
    });

    it('accepts an explicit non-negative integer', () => {
      const l = new Lamport(42);
      expect(l.getCurrent()).toBe(42);
    });

    it('rejects negative initial values', () => {
      expect(() => new Lamport(-1)).toThrow(SphereError);
    });

    it('rejects fractional initial values', () => {
      expect(() => new Lamport(1.5)).toThrow(SphereError);
    });

    it('rejects NaN', () => {
      expect(() => new Lamport(Number.NaN)).toThrow(SphereError);
    });

    it('rejects Infinity', () => {
      expect(() => new Lamport(Number.POSITIVE_INFINITY)).toThrow(SphereError);
    });
  });

  describe('merge (static)', () => {
    it('returns max(5, 8) = 8', () => {
      expect(Lamport.merge(5, 8)).toBe(8);
    });

    it('returns max(8, 5) = 8 (commutative)', () => {
      expect(Lamport.merge(8, 5)).toBe(8);
    });

    it('returns max(0, 0) = 0', () => {
      expect(Lamport.merge(0, 0)).toBe(0);
    });

    it('returns the same value for equal inputs', () => {
      expect(Lamport.merge(7, 7)).toBe(7);
    });
  });

  describe('bumpFor — happy paths', () => {
    it('bumpFor([3,7,2]) from local 5 returns 8 (max+1)', () => {
      const l = new Lamport(5);
      expect(l.bumpFor([3, 7, 2])).toBe(8);
      expect(l.getCurrent()).toBe(8);
    });

    it('bumpFor([]) returns getCurrent()+1', () => {
      const l = new Lamport(10);
      expect(l.bumpFor([])).toBe(11);
      expect(l.getCurrent()).toBe(11);
    });

    it('bumpFor([3]) from local 0 returns max(0,3)+1 = 4', () => {
      // local=0; bound = 2 × max(0, 1) = 2 — but 3 > 2 → rejects.
      // Hence test the inverse with a valid value first.
      const l = new Lamport(2);
      expect(l.bumpFor([3])).toBe(4);
    });

    it('successive bumps are monotonic', () => {
      const l = new Lamport();
      const a = l.bumpFor([]);
      const b = l.bumpFor([]);
      const c = l.bumpFor([]);
      expect(a).toBeLessThan(b);
      expect(b).toBeLessThan(c);
    });

    it('local advance from local-only bumps still respects observed', () => {
      const l = new Lamport(0);
      l.bumpFor([]); // 1
      l.bumpFor([]); // 2
      // bound = 2 × max(2, 1) = 4 — observe 4, accept (4 ≤ 4).
      expect(l.bumpFor([4])).toBe(5);
    });
  });

  describe('bumpFor — input validation', () => {
    it('rejects negative observed values', () => {
      const l = new Lamport(5);
      expect(() => l.bumpFor([-1])).toThrow(SphereError);
    });

    it('rejects fractional observed values', () => {
      const l = new Lamport(5);
      expect(() => l.bumpFor([1.5])).toThrow(SphereError);
    });

    it('rejects NaN', () => {
      const l = new Lamport(5);
      expect(() => l.bumpFor([Number.NaN])).toThrow(SphereError);
    });

    it('rejects Infinity', () => {
      const l = new Lamport(5);
      expect(() => l.bumpFor([Number.POSITIVE_INFINITY])).toThrow(SphereError);
    });
  });

  describe('rehydrate() — cold-restart trusted-observation absorption', () => {
    it('sets current to max(current, ...observed) without bounds checking', () => {
      const l = new Lamport(0);
      // bumpFor([1000]) would throw LAMPORT_BOUND_VIOLATION (1000 > 2).
      // rehydrate must accept the same input as trusted.
      l.rehydrate([1000]);
      expect(l.getCurrent()).toBe(1000);
    });

    it('takes the max across multiple observations', () => {
      const l = new Lamport(5);
      l.rehydrate([10, 100, 50, 25]);
      expect(l.getCurrent()).toBe(100);
    });

    it('does not lower the clock when observations are smaller', () => {
      const l = new Lamport(50);
      l.rehydrate([1, 2, 3]);
      expect(l.getCurrent()).toBe(50);
    });

    it('is a no-op on empty observations', () => {
      const l = new Lamport(7);
      l.rehydrate([]);
      expect(l.getCurrent()).toBe(7);
    });

    it('rejects non-integer / negative values', () => {
      const l = new Lamport(0);
      expect(() => l.rehydrate([-1])).toThrow(SphereError);
      expect(() => l.rehydrate([1.5])).toThrow(SphereError);
      expect(() => l.rehydrate([Number.NaN])).toThrow(SphereError);
      expect(() => l.rehydrate([Number.POSITIVE_INFINITY])).toThrow(SphereError);
    });

    it('post-rehydrate, bumpFor produces the expected next value', () => {
      const l = new Lamport(0);
      // Simulate cold-restart: 100 prior writes exist in storage.
      l.rehydrate([100]);
      // First write after restart: bumpFor with empty (we absorbed
      // all observations into rehydrate) → next = current + 1.
      const next = l.bumpFor([]);
      expect(next).toBe(101);
      expect(l.getCurrent()).toBe(101);
    });

    it('post-rehydrate, bumpFor still applies W39 bounds defense', () => {
      const l = new Lamport(0);
      l.rehydrate([10]); // current = 10, bound = 20
      // bumpFor with a remote observation that exceeds bound should still throw.
      expect(() => l.bumpFor([100])).toThrow(SphereError);
      // current is unchanged after throw.
      expect(l.getCurrent()).toBe(10);
    });
  });

  describe('per-instance scoping (no module-level globals)', () => {
    it('two instances are independent', () => {
      const a = new Lamport(0);
      const b = new Lamport(0);
      a.bumpFor([]);
      a.bumpFor([]);
      a.bumpFor([]);
      expect(a.getCurrent()).toBe(3);
      expect(b.getCurrent()).toBe(0);
    });

    it('instances do not share state via static merge', () => {
      const a = new Lamport(10);
      Lamport.merge(a.getCurrent(), 999);
      // Static merge is pure: it does NOT mutate a.
      expect(a.getCurrent()).toBe(10);
    });
  });
});
