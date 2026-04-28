/**
 * Tests for `profile/outbox-state-machine.ts` — UXF Transfer Protocol §7.0 (T.6.C).
 *
 * Covers:
 *   1. Every legal arc in the canonical §7.0 transition table → ok.
 *   2. A representative sample of illegal arcs → reject with typed error.
 *   3. Override path `failed-permanent → finalizing` requires
 *      `overrideApplied: true`.
 *   4. Terminal states (`expired`, `finalized`, `failed-permanent` modulo
 *      override) reject every outgoing arc.
 *   5. Self-loops are not legal arcs.
 *   6. Unknown status strings (defensive) reject as `no-such-arc`.
 *   7. Integration: `OutboxWriter.update` rejects an illegal status
 *      transition (gating verified end-to-end).
 *
 * The table size is asserted so spec drift between §7.0 and the validator
 * surfaces immediately at test time.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Lamport } from '../../../profile/lamport.js';
import {
  ALLOWED_TRANSITIONS,
  assertTransition,
  validateTransition,
} from '../../../profile/outbox-state-machine.js';
import {
  OutboxWriter,
  type OutboxWriteInput,
} from '../../../profile/outbox-writer.js';
import { SphereError } from '../../../core/errors.js';
import {
  UXF_OUTBOX_STATUSES,
  type UxfOutboxStatus,
} from '../../../types/uxf-outbox.js';
import type {
  OrbitDbConfig,
  ProfileDatabase,
} from '../../../profile/types.js';

// ---------------------------------------------------------------------------
// 1. Table-size lockdown — spec drift guard
// ---------------------------------------------------------------------------

describe('outbox-state-machine — §7.0 table size', () => {
  it('locks the canonical row count (drift guard)', () => {
    // Counted from the §7.0 transition table:
    //   packaging→pinned, packaging→sending,                          (2)
    //   pinned→sending, pinned→failed-transient,                      (2)
    //   sending→delivered, sending→delivered-instant,
    //     sending→failed-transient,                                   (3)
    //   delivered→expired,                                            (1)
    //   delivered-instant→finalizing,                                 (1)
    //   finalizing→finalized, finalizing→failed-permanent,
    //     finalizing→failed-transient,                                (3)
    //   failed-transient→sending, failed-transient→failed-permanent,  (2)
    //   failed-permanent→finalizing (override),                       (1)
    //   finalized→expired                                             (1)
    //   ────────────────────────────────────────────────────────────
    //   16 rows total
    expect(ALLOWED_TRANSITIONS).toHaveLength(16);
  });

  it('every row uses canonical UxfOutboxStatus values on both ends', () => {
    for (const row of ALLOWED_TRANSITIONS) {
      expect(UXF_OUTBOX_STATUSES).toContain(row.from);
      expect(UXF_OUTBOX_STATUSES).toContain(row.to);
    }
  });

  it('the table contains no self-loops', () => {
    for (const row of ALLOWED_TRANSITIONS) {
      expect(row.from).not.toBe(row.to);
    }
  });

  it('exactly one override-conditioned row exists (the §7.0 escape-hatch)', () => {
    const overrideRows = ALLOWED_TRANSITIONS.filter(
      (r) => r.condition.kind === 'override',
    );
    expect(overrideRows).toHaveLength(1);
    expect(overrideRows[0].from).toBe('failed-permanent');
    expect(overrideRows[0].to).toBe('finalizing');
  });
});

// ---------------------------------------------------------------------------
// 2. Every legal arc → ok
// ---------------------------------------------------------------------------

describe('outbox-state-machine — every legal arc', () => {
  it('validates every row in ALLOWED_TRANSITIONS as ok with appropriate context', () => {
    for (const row of ALLOWED_TRANSITIONS) {
      const ctx = {
        from: row.from,
        to: row.to,
        // For override rows we pass overrideApplied=true; otherwise it's
        // ignored on unconditional rows. No arcs use 'dual-write' kind in
        // the current table.
        overrideApplied: row.condition.kind === 'override' ? true : undefined,
      };
      const result = validateTransition(ctx);
      expect(
        result.ok,
        `${row.from} → ${row.to} (${row.condition.kind}) should validate`,
      ).toBe(true);
    }
  });

  it('every legal arc passes the throwing wrapper too', () => {
    for (const row of ALLOWED_TRANSITIONS) {
      expect(() =>
        assertTransition({
          from: row.from,
          to: row.to,
          overrideApplied: row.condition.kind === 'override' ? true : undefined,
        }),
      ).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Sample of illegal arcs → reject
// ---------------------------------------------------------------------------

describe('outbox-state-machine — illegal arcs', () => {
  const ILLEGAL_SAMPLES: ReadonlyArray<[UxfOutboxStatus, UxfOutboxStatus]> = [
    // Backward (no path back from delivered/finalized/expired)
    ['delivered', 'packaging'],
    ['delivered', 'pinned'],
    ['delivered-instant', 'sending'],
    ['finalized', 'packaging'],
    ['finalized', 'finalizing'],
    ['finalized', 'sending'],
    // Skips ahead (no shortcut from packaging straight to delivered/finalized)
    ['packaging', 'delivered'],
    ['packaging', 'finalized'],
    ['pinned', 'delivered'],
    ['pinned', 'delivered-instant'],
    // Lateral nonsense
    ['packaging', 'failed-transient'],
    ['packaging', 'failed-permanent'],
    ['delivered', 'finalizing'],
    ['delivered', 'finalized'],
    // Cross-mode jumps
    ['delivered', 'delivered-instant'],
    ['delivered-instant', 'delivered'],
    // Out of failed-transient to wrong target
    ['failed-transient', 'finalizing'],
    ['failed-transient', 'finalized'],
    ['failed-transient', 'expired'],
    // Expired is absolute terminal — no outgoing arcs
    ['expired', 'packaging'],
    ['expired', 'sending'],
    ['expired', 'finalized'],
    ['expired', 'finalizing'],
    ['expired', 'failed-transient'],
    ['expired', 'failed-permanent'],
    // Finalized terminal-except-retention
    ['finalized', 'failed-transient'],
    ['finalized', 'failed-permanent'],
    ['finalized', 'delivered-instant'],
  ];

  it.each(ILLEGAL_SAMPLES)('rejects %s → %s', (from, to) => {
    const result = validateTransition({ from, to });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('no-such-arc');
      expect(result.reason).toMatch(/INVALID_OUTBOX_TRANSITION/);
      expect(result.reason).toContain(from);
      expect(result.reason).toContain(to);
    }
  });

  it('the throwing wrapper raises SphereError with code INVALID_OUTBOX_TRANSITION', () => {
    expect(() =>
      assertTransition({ from: 'delivered', to: 'packaging' }),
    ).toThrow(SphereError);

    try {
      assertTransition({ from: 'delivered', to: 'packaging' });
    } catch (e) {
      const err = e as SphereError;
      expect(err.code).toBe('INVALID_OUTBOX_TRANSITION');
      // SphereError's native cause walk preserves the structured cause
      // ({ from, to, code }) per core/errors.ts construction.
      expect(err.cause).toMatchObject({
        from: 'delivered',
        to: 'packaging',
        code: 'no-such-arc',
      });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Override path — failed-permanent → finalizing
// ---------------------------------------------------------------------------

describe('outbox-state-machine — override (failed-permanent → finalizing)', () => {
  it('rejects without overrideApplied', () => {
    const result = validateTransition({
      from: 'failed-permanent',
      to: 'finalizing',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('override-required');
      expect(result.reason).toMatch(/overrideApplied=true/);
    }
  });

  it('rejects with overrideApplied: false', () => {
    const result = validateTransition({
      from: 'failed-permanent',
      to: 'finalizing',
      overrideApplied: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('override-required');
    }
  });

  it('accepts with overrideApplied: true', () => {
    const result = validateTransition({
      from: 'failed-permanent',
      to: 'finalizing',
      overrideApplied: true,
    });
    expect(result.ok).toBe(true);
  });

  it('throwing wrapper raises override-required when flag is missing', () => {
    try {
      assertTransition({ from: 'failed-permanent', to: 'finalizing' });
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as SphereError;
      expect(err.code).toBe('INVALID_OUTBOX_TRANSITION');
      expect(err.cause).toMatchObject({ code: 'override-required' });
    }
  });

  it('overrideApplied does NOT magically open arbitrary arcs', () => {
    const result = validateTransition({
      from: 'expired',
      to: 'sending',
      overrideApplied: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // expired has no override row — the (from, to) miss surfaces first
      expect(result.code).toBe('no-such-arc');
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Terminal-state enforcement
// ---------------------------------------------------------------------------

describe('outbox-state-machine — terminal states', () => {
  it('expired rejects every outgoing arc (including override)', () => {
    for (const target of UXF_OUTBOX_STATUSES) {
      if (target === 'expired') continue; // self-loop covered separately
      const result = validateTransition({
        from: 'expired',
        to: target,
        overrideApplied: true,
      });
      expect(result.ok, `expired → ${target} should reject`).toBe(false);
    }
  });

  it('finalized rejects every outgoing arc except the retention sweep to expired', () => {
    for (const target of UXF_OUTBOX_STATUSES) {
      if (target === 'finalized') continue; // self-loop
      const ctx = {
        from: 'finalized' as UxfOutboxStatus,
        to: target,
        overrideApplied: true,
      };
      const result = validateTransition(ctx);
      if (target === 'expired') {
        expect(result.ok).toBe(true);
      } else {
        expect(
          result.ok,
          `finalized → ${target} should reject (only finalized → expired is legal)`,
        ).toBe(false);
      }
    }
  });

  it('failed-permanent rejects every outgoing arc except the override-gated finalizing', () => {
    for (const target of UXF_OUTBOX_STATUSES) {
      if (target === 'failed-permanent') continue;
      // Without override
      const noOverride = validateTransition({
        from: 'failed-permanent',
        to: target,
      });
      expect(noOverride.ok, `failed-permanent → ${target} (no override)`).toBe(
        false,
      );
      // With override
      const withOverride = validateTransition({
        from: 'failed-permanent',
        to: target,
        overrideApplied: true,
      });
      if (target === 'finalizing') {
        expect(withOverride.ok).toBe(true);
      } else {
        expect(
          withOverride.ok,
          `failed-permanent → ${target} (override) should still reject`,
        ).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Self-loops + defensive input
// ---------------------------------------------------------------------------

describe('outbox-state-machine — self-loops and defensive input', () => {
  it('every self-loop rejects with no-such-arc', () => {
    for (const s of UXF_OUTBOX_STATUSES) {
      const result = validateTransition({ from: s, to: s });
      expect(result.ok, `self-loop ${s} → ${s} should reject`).toBe(false);
      if (!result.ok) expect(result.code).toBe('no-such-arc');
    }
  });

  it('rejects unknown from-status', () => {
    const result = validateTransition({
      from: 'banana' as UxfOutboxStatus,
      to: 'sending',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('no-such-arc');
      expect(result.reason).toMatch(/canonical UxfOutboxStatus/);
    }
  });

  it('rejects unknown to-status', () => {
    const result = validateTransition({
      from: 'packaging',
      to: 'banana' as UxfOutboxStatus,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('no-such-arc');
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Integration with OutboxWriter.update()
// ---------------------------------------------------------------------------

const ADDR = 'DIRECT_aabbcc_ddeeff';

interface MockProfileDb extends ProfileDatabase {
  _store: Map<string, Uint8Array>;
}

function createMockDb(): MockProfileDb {
  const store = new Map<string, Uint8Array>();
  return {
    _store: store,
    async connect(_c: OrbitDbConfig) {},
    async put(k: string, v: Uint8Array) {
      store.set(k, v);
    },
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async del(k: string) {
      store.delete(k);
    },
    async all(prefix?: string) {
      const out = new Map<string, Uint8Array>();
      for (const [k, v] of store)
        if (!prefix || k.startsWith(prefix)) out.set(k, v);
      return out;
    },
    async close() {},
    onReplication() {
      return () => {};
    },
    isConnected() {
      return true;
    },
  } as MockProfileDb;
}

function buildBaseInput(
  id: string,
  overrides: Partial<OutboxWriteInput> = {},
): OutboxWriteInput {
  const now = Date.now();
  return {
    id,
    bundleCid: `bafy-${id}`,
    tokenIds: ['0xtoken1'],
    deliveryMethod: 'car-over-nostr',
    recipient: '@bob',
    recipientTransportPubkey: 'a'.repeat(64),
    mode: 'instant',
    status: 'packaging',
    submitRetryCount: 0,
    proofErrorCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('outbox-state-machine — OutboxWriter.update integration', () => {
  let db: MockProfileDb;
  let writer: OutboxWriter;

  beforeEach(() => {
    db = createMockDb();
    writer = new OutboxWriter({
      db,
      encryptionKey: null,
      addressId: ADDR,
      lamport: new Lamport(),
    });
  });

  it('rejects an illegal status mutation via update()', async () => {
    // Plant a `delivered` entry; then try to mutate back to `packaging`.
    await writer.write(buildBaseInput('idA', { status: 'delivered' }));

    await expect(
      writer.update('idA', (prev) => ({ ...prev, status: 'packaging' })),
    ).rejects.toThrow(SphereError);

    try {
      await writer.update('idA', (prev) => ({ ...prev, status: 'packaging' }));
    } catch (e) {
      const err = e as SphereError;
      expect(err.code).toBe('INVALID_OUTBOX_TRANSITION');
      expect(err.cause).toMatchObject({
        from: 'delivered',
        to: 'packaging',
        code: 'no-such-arc',
      });
    }

    // Sanity: the on-disk entry must be untouched (no half-write).
    const stillThere = await writer.readOne('idA');
    expect(stillThere?.shape).toBe('uxf-1');
    if (stillThere?.shape === 'uxf-1') {
      expect(stillThere.entry.status).toBe('delivered');
    }
  });

  it('allows a legal status mutation via update()', async () => {
    await writer.write(buildBaseInput('idA', { status: 'sending' }));
    const next = await writer.update('idA', (prev) => ({
      ...prev,
      status: 'delivered',
    }));
    expect(next.status).toBe('delivered');
  });

  it('allows the override arc when the writer sets overrideApplied: true in the same write', async () => {
    await writer.write(buildBaseInput('idA', { status: 'failed-permanent' }));
    const next = await writer.update('idA', (prev) => ({
      ...prev,
      status: 'finalizing',
      overrideApplied: true,
    }));
    expect(next.status).toBe('finalizing');
    expect(next.overrideApplied).toBe(true);
  });

  it('rejects the override arc without the flag', async () => {
    await writer.write(buildBaseInput('idA', { status: 'failed-permanent' }));
    await expect(
      writer.update('idA', (prev) => ({ ...prev, status: 'finalizing' })),
    ).rejects.toThrow(SphereError);
  });

  it('allows non-status mutations without invoking the validator (no self-loop reject)', async () => {
    await writer.write(buildBaseInput('idA', { status: 'sending' }));
    const next = await writer.update('idA', (prev) => ({
      ...prev,
      submitRetryCount: prev.submitRetryCount + 1,
      error: 'transient nostr publish failure',
    }));
    expect(next.status).toBe('sending');
    expect(next.submitRetryCount).toBe(1);
    expect(next.error).toBe('transient nostr publish failure');
  });
});
