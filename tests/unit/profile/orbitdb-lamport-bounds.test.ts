/**
 * W39 — adversarial test that observed remote Lamports `> 2 × max(local, 1)`
 * are rejected with `LAMPORT_BOUND_VIOLATION`.
 *
 * Rationale: a malicious or buggy replica could publish a Lamport like
 * `2^53` to force every honest replica past JS safe-integer range,
 * breaking comparisons. The bounds defense rejects clearly-runaway
 * values while leaving generous slack (factor of 2) for legitimate
 * divergence (e.g. one offline replica with many local writes).
 */

import { describe, it, expect } from 'vitest';
import { Lamport } from '../../../profile/lamport';
import { SphereError } from '../../../core/errors';

describe('Lamport bounds defense (W39)', () => {
  describe('within bound — accepts', () => {
    it('local=100, observed=150 (≤ 200) accepts', () => {
      const l = new Lamport(100);
      // bound = 2 × max(100, 1) = 200; 150 ≤ 200.
      expect(l.bumpFor([150])).toBe(151);
    });

    it('local=100, observed=200 (= bound) accepts', () => {
      const l = new Lamport(100);
      // bound = 200; equal-to-bound is accepted (strict > rejects).
      expect(l.bumpFor([200])).toBe(201);
    });

    it('local=0, observed=1 accepts (boot floor lets first remote in)', () => {
      const l = new Lamport(0);
      // bound = 2 × max(0, 1) = 2; 1 ≤ 2.
      expect(l.bumpFor([1])).toBe(2);
    });

    it('local=0, observed=2 accepts (= bound)', () => {
      const l = new Lamport(0);
      expect(l.bumpFor([2])).toBe(3);
    });

    it('mixed observed array: max within bound accepts', () => {
      const l = new Lamport(50);
      // bound = 100; max([10, 99, 30]) = 99 ≤ 100.
      expect(l.bumpFor([10, 99, 30])).toBe(100);
    });
  });

  describe('outside bound — rejects with LAMPORT_BOUND_VIOLATION', () => {
    it('local=100, observed=250 rejects (250 > 200)', () => {
      const l = new Lamport(100);
      let caught: unknown;
      try {
        l.bumpFor([250]);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(SphereError);
      expect((caught as SphereError).code).toBe('LAMPORT_BOUND_VIOLATION');
      // State NOT mutated on rejection.
      expect(l.getCurrent()).toBe(100);
    });

    it('local=100, observed=1_000_000 rejects', () => {
      const l = new Lamport(100);
      expect(() => l.bumpFor([1_000_000])).toThrow(SphereError);
      try {
        l.bumpFor([1_000_000]);
      } catch (e) {
        expect((e as SphereError).code).toBe('LAMPORT_BOUND_VIOLATION');
      }
    });

    it('local=0, observed=5 rejects (5 > 2 × 1 = 2)', () => {
      const l = new Lamport(0);
      let caught: unknown;
      try {
        l.bumpFor([5]);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(SphereError);
      expect((caught as SphereError).code).toBe('LAMPORT_BOUND_VIOLATION');
    });

    it('Number.MAX_SAFE_INTEGER from untrusted replica rejects (the canonical attack)', () => {
      const l = new Lamport(10);
      expect(() => l.bumpFor([Number.MAX_SAFE_INTEGER])).toThrow(SphereError);
      try {
        l.bumpFor([Number.MAX_SAFE_INTEGER]);
      } catch (e) {
        expect((e as SphereError).code).toBe('LAMPORT_BOUND_VIOLATION');
      }
      expect(l.getCurrent()).toBe(10); // unchanged.
    });

    it('mixed observed array: any single entry over bound rejects', () => {
      const l = new Lamport(50);
      // bound = 100; max([10, 50, 999]) = 999 > 100.
      expect(() => l.bumpFor([10, 50, 999])).toThrow(SphereError);
    });
  });

  describe('bound grows with local Lamport (legitimate divergence allowed)', () => {
    it('after enough local bumps, previously-rejected remote becomes acceptable', () => {
      const l = new Lamport(0);
      // observed=10 from local=0 would reject (10 > 2). Bump local up.
      l.bumpFor([1]); // 2
      l.bumpFor([]); // 3
      l.bumpFor([4]); // 5 — bound was 6, 4 ≤ 6 accepts
      l.bumpFor([8]); // 9 — bound was 10, 8 ≤ 10 accepts
      // Now local = 9; bound = 18. observed=15 accepts.
      expect(l.bumpFor([15])).toBe(16);
    });
  });
});
