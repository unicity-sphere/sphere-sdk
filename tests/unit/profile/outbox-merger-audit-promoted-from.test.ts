/**
 * Targeted tests for `audit_promoted_from` set-OR merge (T.6.B, W45).
 *
 * `audit_promoted_from` is a manifest-entry field (UXF-TRANSFER-PROTOCOL
 * §5.4) used for forensic traceability when an audit-pool entry is
 * promoted into the active manifest. Per §7.1's array-field rule, replica
 * merges union the arrays with dedupe — divergent values across replicas
 * reflect legitimate cross-device audit history (the same `tokenId` may be
 * promoted from different audit entries on different devices) and BOTH
 * keys must be preserved.
 *
 * The {@link mergeAuditPromotedFrom} helper lives in
 * `profile/outbox-merger-error-fields.ts` (and is re-exported through
 * `profile/outbox-merger.ts`) so callers composing manifest + outbox merges
 * have a single import surface. The full integration into a manifest store
 * is delivered later (T.6.D); this test file verifies the helper itself.
 *
 * Acceptance criteria:
 *  - `[a, b] ∪ [b, c] === [a, b, c]` (dedupe).
 *  - Output is sorted lex-min for byte-stability.
 *  - Both `undefined` → `undefined`.
 *  - Empty array preserved (`[] ∪ [] === []`, NOT `undefined`).
 *  - Empty + non-empty → non-empty.
 *  - Commutative, idempotent, associative (broader laws covered by the
 *    property test file W9; this file pins targeted concrete cases).
 */

import { describe, it, expect } from 'vitest';
import { mergeAuditPromotedFrom } from '../../../extensions/uxf/profile/outbox-merger';

describe('§5.4 / W45: mergeAuditPromotedFrom — set-OR with dedupe', () => {
  it('canonical: [a, b] ∪ [b, c] = [a, b, c]', () => {
    const r = mergeAuditPromotedFrom(['a', 'b'], ['b', 'c']);
    expect(r).toEqual(['a', 'b', 'c']);
  });

  it('disjoint inputs: union of both', () => {
    const r = mergeAuditPromotedFrom(['x'], ['y']);
    expect(r).toEqual(['x', 'y']);
  });

  it('identical inputs: dedupe', () => {
    const r = mergeAuditPromotedFrom(['k1', 'k2'], ['k1', 'k2']);
    expect(r).toEqual(['k1', 'k2']);
  });

  it('output is sorted lex-min (byte-stable)', () => {
    const r = mergeAuditPromotedFrom(['z', 'a', 'm'], ['c', 'b']) ?? [];
    expect([...r]).toEqual(['a', 'b', 'c', 'm', 'z']);
  });

  it('output is frozen (read-only)', () => {
    const r = mergeAuditPromotedFrom(['a'], ['b']);
    expect(Object.isFrozen(r)).toBe(true);
  });
});

describe('§5.4 / W45: undefined / empty handling', () => {
  it('both undefined → undefined', () => {
    expect(mergeAuditPromotedFrom(undefined, undefined)).toBeUndefined();
  });

  it('undefined + defined → defined (carry-through)', () => {
    expect(mergeAuditPromotedFrom(undefined, ['a', 'b'])).toEqual(['a', 'b']);
    expect(mergeAuditPromotedFrom(['a', 'b'], undefined)).toEqual(['a', 'b']);
  });

  it('both empty arrays → empty array (NOT undefined)', () => {
    // Distinguishes "no audit history" (undefined) from "writer set field
    // explicitly even though empty" ([]). The helper preserves the
    // "explicitly set" signal.
    const r = mergeAuditPromotedFrom([], []);
    expect(r).toEqual([]);
  });

  it('empty + non-empty → non-empty', () => {
    expect(mergeAuditPromotedFrom([], ['a'])).toEqual(['a']);
    expect(mergeAuditPromotedFrom(['a'], [])).toEqual(['a']);
  });
});

describe('§5.4 / W45: defensive / robustness', () => {
  it('strips empty strings defensively', () => {
    // Cast forces the defensive guard inside the helper.
    const r = mergeAuditPromotedFrom(['a', '', 'b'] as ReadonlyArray<string>, ['c']);
    expect(r).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate inputs', () => {
    const a = ['k1', 'k2'];
    const b = ['k2', 'k3'];
    const beforeA = [...a];
    const beforeB = [...b];
    mergeAuditPromotedFrom(a, b);
    expect(a).toEqual(beforeA);
    expect(b).toEqual(beforeB);
  });
});

describe('§5.4 / W45: forensic traceability scenario', () => {
  // Scenario: tokenId T was promoted from audit key 'audit:T:r1' on
  // device A and from 'audit:T:r2' on device B (independently observed
  // disposition reasons, both legitimate). Merge MUST preserve both keys
  // for the forensic trail.
  it('preserves divergent promotion histories across devices', () => {
    const deviceA = ['audit:T:r1'];
    const deviceB = ['audit:T:r2'];
    const r = mergeAuditPromotedFrom(deviceA, deviceB);
    expect(r).toEqual(['audit:T:r1', 'audit:T:r2']);
  });

  it('subsequent merge with a third device that has both keys is a no-op', () => {
    const deviceA = ['audit:T:r1'];
    const deviceB = ['audit:T:r2'];
    const merged = mergeAuditPromotedFrom(deviceA, deviceB);
    const deviceC = ['audit:T:r1', 'audit:T:r2'];
    const r = mergeAuditPromotedFrom(merged, deviceC);
    expect(r).toEqual(['audit:T:r1', 'audit:T:r2']);
  });

  it('large-fanout promotion: 3+ replicas converge under associative left-fold', () => {
    const a = ['audit:T:r1', 'audit:T:r2'];
    const b = ['audit:T:r3'];
    const c = ['audit:T:r1', 'audit:T:r4'];
    const left = mergeAuditPromotedFrom(mergeAuditPromotedFrom(a, b), c);
    const right = mergeAuditPromotedFrom(a, mergeAuditPromotedFrom(b, c));
    expect(left).toEqual(right);
    expect(left).toEqual(['audit:T:r1', 'audit:T:r2', 'audit:T:r3', 'audit:T:r4']);
  });
});
