/**
 * Tests for `profile/outbox-state-machine.ts` — W43 dual-write arcs (T.6.C).
 *
 * The W43 dual-write semantics formalize an explicit arc in the outbox
 * state machine that's distinct from the §7.0 status transitions:
 * `legacy ↔ uxf` is a SCHEMA-MODE transition (which on-disk shape is being
 * written), gated by a `dualWriteEnabled: true` flag.
 *
 * Per the impl plan §7.B, dual-write is active only during the T.6.D
 * migration window (`features.outbox === 'dual-write'`). Outside the
 * window, both directions of the schema-mode arc are forbidden.
 *
 * Covers:
 *   1. Both arcs (`legacy → uxf`, `uxf → legacy`) require
 *      `dualWriteEnabled: true`.
 *   2. Without the flag → reject with `dual-write-disabled`.
 *   3. With `dualWriteEnabled: false` (explicit) → reject.
 *   4. Self-loops (`legacy → legacy`, `uxf → uxf`) reject as `no-such-arc`.
 *   5. Unknown schema-mode strings reject defensively.
 *   6. Throwing wrapper raises typed SphereError.
 *
 * @see docs/uxf/UXF-TRANSFER-IMPL-PLAN.md §7.B (W43 dual-write mode)
 * @see docs/uxf/UXF-TRANSFER-PROTOCOL.md   §7.0 (canonical status table)
 */

import { describe, expect, it } from 'vitest';
import {
  ALLOWED_DUAL_WRITE_ARCS,
  assertDualWriteArc,
  validateDualWriteArc,
  type OutboxSchemaMode,
} from '../../../extensions/uxf/profile/outbox-state-machine.js';
import { SphereError } from '../../../core/errors.js';

// ---------------------------------------------------------------------------
// 1. Table-size lockdown
// ---------------------------------------------------------------------------

describe('outbox-state-machine — W43 dual-write table', () => {
  it('contains exactly two arcs (legacy → uxf, uxf → legacy)', () => {
    expect(ALLOWED_DUAL_WRITE_ARCS).toHaveLength(2);
    const arcs = ALLOWED_DUAL_WRITE_ARCS.map((a) => `${a.from}→${a.to}`).sort();
    expect(arcs).toEqual(['legacy→uxf', 'uxf→legacy']);
  });
});

// ---------------------------------------------------------------------------
// 2. With dualWriteEnabled: true → both arcs accepted
// ---------------------------------------------------------------------------

describe('outbox-state-machine — W43 dual-write arcs (enabled)', () => {
  it('accepts legacy → uxf with dualWriteEnabled: true', () => {
    const result = validateDualWriteArc({
      from: 'legacy',
      to: 'uxf',
      dualWriteEnabled: true,
    });
    expect(result.ok).toBe(true);
  });

  it('accepts uxf → legacy with dualWriteEnabled: true (T.6.D.2 restore)', () => {
    const result = validateDualWriteArc({
      from: 'uxf',
      to: 'legacy',
      dualWriteEnabled: true,
    });
    expect(result.ok).toBe(true);
  });

  it('throwing wrapper does not throw when arc is enabled', () => {
    expect(() =>
      assertDualWriteArc({
        from: 'legacy',
        to: 'uxf',
        dualWriteEnabled: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertDualWriteArc({
        from: 'uxf',
        to: 'legacy',
        dualWriteEnabled: true,
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. Without the flag → reject (forward + backward)
// ---------------------------------------------------------------------------

describe('outbox-state-machine — W43 dual-write arcs (disabled)', () => {
  it('rejects legacy → uxf with no flag', () => {
    const result = validateDualWriteArc({ from: 'legacy', to: 'uxf' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('dual-write-disabled');
      expect(result.reason).toMatch(/§7\.B migration window only/);
    }
  });

  it('rejects uxf → legacy with no flag', () => {
    const result = validateDualWriteArc({ from: 'uxf', to: 'legacy' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('dual-write-disabled');
  });

  it('rejects with explicit dualWriteEnabled: false', () => {
    const result = validateDualWriteArc({
      from: 'legacy',
      to: 'uxf',
      dualWriteEnabled: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('dual-write-disabled');
  });

  it('throwing wrapper raises SphereError(INVALID_OUTBOX_TRANSITION) when disabled', () => {
    try {
      assertDualWriteArc({ from: 'legacy', to: 'uxf' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SphereError);
      const err = e as SphereError;
      expect(err.code).toBe('INVALID_OUTBOX_TRANSITION');
      expect(err.cause).toMatchObject({
        from: 'legacy',
        to: 'uxf',
        code: 'dual-write-disabled',
        schemaMode: true,
      });
    }
  });

  it('throwing wrapper raises with the same code for the reverse arc', () => {
    try {
      assertDualWriteArc({ from: 'uxf', to: 'legacy' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SphereError);
      const err = e as SphereError;
      expect(err.code).toBe('INVALID_OUTBOX_TRANSITION');
      expect(err.cause).toMatchObject({
        from: 'uxf',
        to: 'legacy',
        code: 'dual-write-disabled',
      });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Self-loops + defensive input
// ---------------------------------------------------------------------------

describe('outbox-state-machine — W43 dual-write defensive checks', () => {
  it('rejects legacy → legacy self-loop even with the flag', () => {
    const result = validateDualWriteArc({
      from: 'legacy',
      to: 'legacy',
      dualWriteEnabled: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('no-such-arc');
      expect(result.reason).toMatch(/self-loop/);
    }
  });

  it('rejects uxf → uxf self-loop even with the flag', () => {
    const result = validateDualWriteArc({
      from: 'uxf',
      to: 'uxf',
      dualWriteEnabled: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('no-such-arc');
  });

  it('rejects unknown from-mode', () => {
    const result = validateDualWriteArc({
      from: 'banana' as OutboxSchemaMode,
      to: 'uxf',
      dualWriteEnabled: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('no-such-arc');
      expect(result.reason).toMatch(/recognized schema mode/);
    }
  });

  it('rejects unknown to-mode', () => {
    const result = validateDualWriteArc({
      from: 'legacy',
      to: 'banana' as OutboxSchemaMode,
      dualWriteEnabled: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('no-such-arc');
  });
});
