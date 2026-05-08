/**
 * Tests for `profile/outbox-merger.ts` and the three split modules
 * (`outbox-merger-status.ts`, `outbox-merger-requestids.ts`,
 * `outbox-merger-error-fields.ts`). T.6.B unit suite.
 *
 * Covers every row of UXF-TRANSFER-PROTOCOL §7.1:
 *   1. Status partition + lattice.
 *   2. outstandingRequestIds two-set form (subtraction by completed).
 *   3. completedRequestIds straight set-union.
 *   4. submitRetryCount / proofErrorCount G-counter max-merge.
 *   5. Error-field rule (more-advanced status wins; tie by earlier-Lamport).
 *   6. Lamport max-merge.
 *
 * Plus the override-stickiness exception from Rule 1 (§7.1):
 *   - `failed-permanent` vs `finalizing` w/ `overrideApplied: true` →
 *     `finalizing` wins regardless of Lamport.
 *
 * Plus C12 race-lost CRDT acceptance: the merger correctly converges two
 * `failed-permanent` race-lost entries WITHOUT firing any cascade
 * (cascade firing is delegated to T.5.B.5).
 */

import { describe, it, expect } from 'vitest';
import { SphereError } from '../../../core/errors';
import type { UxfTransferOutboxEntry, UxfOutboxStatus } from '../../../types/uxf-outbox';
import {
  mergeOutboxEntries,
  mergeOutboxEntriesPair,
  mergeStatus,
  mergeRequestIds,
  mergeErrorFields,
} from '../../../profile/outbox-merger';
import {
  activeLatticeRank,
  hardTerminalRank,
} from '../../../profile/outbox-merger-status';

// -----------------------------------------------------------------------------
// Test fixture helpers
// -----------------------------------------------------------------------------

function makeEntry(overrides: Partial<UxfTransferOutboxEntry> = {}): UxfTransferOutboxEntry {
  return {
    _schemaVersion: 'uxf-1',
    id: 'entry-1',
    bundleCid: 'bafy-bundle-1',
    tokenIds: ['tok-1'],
    deliveryMethod: 'car-over-nostr',
    recipient: 'DIRECT://abc',
    recipientTransportPubkey: 'pub-abc',
    mode: 'instant',
    status: 'sending',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    lamport: 1,
    submitRetryCount: 0,
    proofErrorCount: 0,
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Rule 1 — status partition + lattice
// -----------------------------------------------------------------------------

describe('mergeStatus — Rule 1 (status partition lattice)', () => {
  describe('active vs active', () => {
    it('lattice: packaging < pinned', () => {
      const a = makeEntry({ status: 'packaging', lamport: 5 });
      const b = makeEntry({ status: 'pinned', lamport: 1 });
      const r = mergeStatus(a, b);
      expect(r.status).toBe('pinned');
      expect(r.winner).toBe('b');
    });

    it('lattice: pinned < sending', () => {
      const a = makeEntry({ status: 'sending', lamport: 1 });
      const b = makeEntry({ status: 'pinned', lamport: 99 });
      const r = mergeStatus(a, b);
      expect(r.status).toBe('sending');
      expect(r.winner).toBe('a');
    });

    it('lattice: sending < delivered', () => {
      const a = makeEntry({ status: 'sending', lamport: 99 });
      const b = makeEntry({ status: 'delivered', lamport: 5 });
      const r = mergeStatus(a, b);
      expect(r.status).toBe('delivered');
      expect(r.winner).toBe('b');
    });

    it('lattice: delivered < finalizing', () => {
      const a = makeEntry({ status: 'finalizing', lamport: 3 });
      const b = makeEntry({ status: 'delivered', lamport: 99 });
      const r = mergeStatus(a, b);
      expect(r.status).toBe('finalizing');
      expect(r.winner).toBe('a');
    });

    it('siblings delivered ↔ delivered-instant: lex-min status name wins (associative)', () => {
      // Deterministic, associative tie-break via lex-min of status name —
      // 'delivered' < 'delivered-instant'. Lamport is NOT used for the
      // sibling tie-break (CRDT associativity; see mergeBothActive
      // doc-comment).
      const a = makeEntry({ status: 'delivered-instant', lamport: 9 });
      const b = makeEntry({ status: 'delivered', lamport: 5 });
      const r = mergeStatus(a, b);
      expect(r.status).toBe('delivered'); // lex-min wins
      expect(r.lamport).toBe(9); // Lamport itself still max-merges (Rule 6)
    });

    it('same status, lex-min id wins (deterministic tie-break, ignores Lamport)', () => {
      // Both same status, same id — lex-min path picks 'a'. Note: the
      // active-lattice tie-break is Lamport-INDEPENDENT (W9 associativity).
      const r = mergeStatus(
        makeEntry({ status: 'sending', lamport: 7 }),
        makeEntry({ status: 'sending', lamport: 12 }),
      );
      expect(r.lamport).toBe(12); // Rule 6 max-merge
      expect(r.winner).toBe('a'); // lex-min id wins
    });
  });

  describe('hard-terminal preferences', () => {
    it('finalized > failed-permanent', () => {
      const a = makeEntry({ status: 'failed-permanent', lamport: 99 });
      const b = makeEntry({ status: 'finalized', lamport: 1 });
      const r = mergeStatus(a, b);
      expect(r.status).toBe('finalized');
    });

    it('finalized > expired', () => {
      const a = makeEntry({ status: 'expired', lamport: 99 });
      const b = makeEntry({ status: 'finalized', lamport: 1 });
      const r = mergeStatus(a, b);
      expect(r.status).toBe('finalized');
    });

    it('failed-permanent > expired', () => {
      const a = makeEntry({ status: 'expired', lamport: 5 });
      const b = makeEntry({ status: 'failed-permanent', lamport: 1 });
      const r = mergeStatus(a, b);
      expect(r.status).toBe('failed-permanent');
    });

    it('same hard-terminal: deterministic lex-min id tie-break (Lamport-independent)', () => {
      // Hard-terminal tie-break (when statuses match) reduces to lex-min
      // id for CRDT associativity. Lamport itself max-merges (Rule 6) but
      // does not select the winner.
      const a = makeEntry({ status: 'finalized', lamport: 5 });
      const b = makeEntry({ status: 'finalized', lamport: 17 });
      const r = mergeStatus(a, b);
      expect(r.lamport).toBe(17);
      expect(r.winner).toBe('a'); // lex-min id 'entry-1' on both → 'a'
    });
  });

  describe('cross-partition rules', () => {
    it('hard-terminal beats active', () => {
      const a = makeEntry({ status: 'sending', lamport: 99 });
      const b = makeEntry({ status: 'failed-permanent', lamport: 1 });
      const r = mergeStatus(a, b);
      expect(r.status).toBe('failed-permanent');
    });

    it('hard-terminal beats soft-terminal', () => {
      const a = makeEntry({ status: 'failed-transient', lamport: 99 });
      const b = makeEntry({ status: 'finalized', lamport: 1 });
      const r = mergeStatus(a, b);
      expect(r.status).toBe('finalized');
    });

    it('active beats soft-terminal (replica still progressing)', () => {
      const a = makeEntry({ status: 'failed-transient', lamport: 99 });
      const b = makeEntry({ status: 'sending', lamport: 1 });
      const r = mergeStatus(a, b);
      expect(r.status).toBe('sending');
    });

    it('both soft-terminal: Lamport max-merges; winner via lex-min id', () => {
      // Soft-terminal partition has only one status. Lamport max-merges
      // per Rule 6 but does not select the winner (associativity).
      const a = makeEntry({ status: 'failed-transient', lamport: 5 });
      const b = makeEntry({ status: 'failed-transient', lamport: 11 });
      const r = mergeStatus(a, b);
      expect(r.lamport).toBe(11);
      expect(r.winner).toBe('a');
    });
  });
});

// -----------------------------------------------------------------------------
// Rule 1 EXCEPTION + Rule 2 — override stickiness
// -----------------------------------------------------------------------------

describe('mergeStatus — Rule 2 override stickiness', () => {
  it('failed-permanent vs finalizing+overrideApplied: finalizing wins', () => {
    const a = makeEntry({ status: 'failed-permanent', lamport: 999 });
    const b = makeEntry({ status: 'finalizing', overrideApplied: true, lamport: 1 });
    const r = mergeStatus(a, b);
    expect(r.status).toBe('finalizing');
    expect(r.winner).toBe('override');
    expect(r.overrideApplied).toBe(true);
  });

  it('symmetric: finalizing+override on side a wins against failed-permanent on b', () => {
    const a = makeEntry({ status: 'finalizing', overrideApplied: true, lamport: 1 });
    const b = makeEntry({ status: 'failed-permanent', lamport: 999 });
    const r = mergeStatus(a, b);
    expect(r.status).toBe('finalizing');
    expect(r.winner).toBe('override');
    expect(r.overrideApplied).toBe(true);
  });

  it('overrideApplied is sticky across merges (set-OR even when arc does not fire)', () => {
    // Both replicas active; one has overrideApplied set from earlier history.
    const a = makeEntry({ status: 'finalized', overrideApplied: true, lamport: 5 });
    const b = makeEntry({ status: 'finalized', lamport: 9 });
    const r = mergeStatus(a, b);
    expect(r.overrideApplied).toBe(true);
  });

  it('finalizing without override does NOT beat failed-permanent', () => {
    // The override arc requires overrideApplied: true. Without the flag,
    // hard-terminal beats active per Rule 1.
    const a = makeEntry({ status: 'failed-permanent', lamport: 1 });
    const b = makeEntry({ status: 'finalizing', overrideApplied: false, lamport: 999 });
    const r = mergeStatus(a, b);
    expect(r.status).toBe('failed-permanent');
    expect(r.winner).toBe('a');
  });

  it('dual-override (both finalizing+override): falls through to active-vs-active rule', () => {
    const a = makeEntry({ status: 'finalizing', overrideApplied: true, lamport: 5 });
    const b = makeEntry({ status: 'finalizing', overrideApplied: true, lamport: 11 });
    const r = mergeStatus(a, b);
    expect(r.status).toBe('finalizing');
    expect(r.lamport).toBe(11); // Rule 6 max-merge
    expect(r.overrideApplied).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Rule 2-bis & Rule 3 — requestId merge
// -----------------------------------------------------------------------------

describe('mergeRequestIds — Rules 2-bis (outstanding) and 3 (completed)', () => {
  it('completed: straight set-union', () => {
    const a = makeEntry({ completedRequestIds: ['r1', 'r2'] });
    const b = makeEntry({ completedRequestIds: ['r2', 'r3'] });
    const r = mergeRequestIds(a, b);
    expect([...r.completed]).toEqual(['r1', 'r2', 'r3']);
  });

  it('outstanding: union minus completed', () => {
    const a = makeEntry({
      outstandingRequestIds: ['r1', 'r2'],
      completedRequestIds: ['r4'],
    });
    const b = makeEntry({
      outstandingRequestIds: ['r3'],
      completedRequestIds: ['r2'],
    });
    const r = mergeRequestIds(a, b);
    expect([...r.outstanding]).toEqual(['r1', 'r3']);
    expect([...r.completed]).toEqual(['r2', 'r4']);
  });

  it('adversarial: stale replica re-introduces a completed requestId in outstanding', () => {
    // Replica A: knows r1 is completed.
    // Replica B: stale view; still has r1 in outstanding.
    const a = makeEntry({ outstandingRequestIds: [], completedRequestIds: ['r1'] });
    const b = makeEntry({ outstandingRequestIds: ['r1'] });
    const r = mergeRequestIds(a, b);
    expect([...r.outstanding]).toEqual([]); // r1 must NOT reappear
    expect([...r.completed]).toEqual(['r1']);
  });

  it('completed never un-completes (idempotent on repeated merge)', () => {
    const a = makeEntry({ completedRequestIds: ['r1'] });
    const b = makeEntry({ completedRequestIds: ['r1'] });
    const r1 = mergeRequestIds(a, b);
    const r2 = mergeRequestIds(makeEntry({ completedRequestIds: r1.completed }), b);
    expect([...r2.completed]).toEqual(['r1']);
  });

  it('emits sorted output for byte-stability', () => {
    const a = makeEntry({ completedRequestIds: ['z', 'a', 'm'] });
    const b = makeEntry({ completedRequestIds: ['c', 'b'] });
    const r = mergeRequestIds(a, b);
    expect([...r.completed]).toEqual(['a', 'b', 'c', 'm', 'z']);
  });

  it('strips empty / non-string entries defensively', () => {
    // Casts here exercise the defensive guards inside asSet()
    const a = makeEntry({ outstandingRequestIds: ['r1', '', 'r2'] as unknown as string[] });
    const b = makeEntry({ outstandingRequestIds: ['r3'] });
    const r = mergeRequestIds(a, b);
    expect([...r.outstanding]).toEqual(['r1', 'r2', 'r3']);
  });

  it('undefined inputs treated as empty sets', () => {
    const a = makeEntry({});
    const b = makeEntry({});
    const r = mergeRequestIds(a, b);
    expect([...r.outstanding]).toEqual([]);
    expect([...r.completed]).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Rule 4 — G-counter max-merge
// -----------------------------------------------------------------------------

describe('mergeErrorFields — Rule 4 (G-counter max-merge)', () => {
  it('submitRetryCount: max-merges', () => {
    const a = makeEntry({ submitRetryCount: 3 });
    const b = makeEntry({ submitRetryCount: 5 });
    const sm = mergeStatus(a, b);
    const r = mergeErrorFields(a, b, sm);
    expect(r.submitRetryCount).toBe(5);
  });

  it('proofErrorCount: max-merges', () => {
    const a = makeEntry({ proofErrorCount: 7 });
    const b = makeEntry({ proofErrorCount: 2 });
    const sm = mergeStatus(a, b);
    const r = mergeErrorFields(a, b, sm);
    expect(r.proofErrorCount).toBe(7);
  });

  it('both counters: independently max-merge', () => {
    const a = makeEntry({ submitRetryCount: 9, proofErrorCount: 1 });
    const b = makeEntry({ submitRetryCount: 4, proofErrorCount: 6 });
    const sm = mergeStatus(a, b);
    const r = mergeErrorFields(a, b, sm);
    expect(r.submitRetryCount).toBe(9);
    expect(r.proofErrorCount).toBe(6);
  });
});

// -----------------------------------------------------------------------------
// Rule 5 — error field
// -----------------------------------------------------------------------------

describe('mergeErrorFields — Rule 5 (error field, strictly-associative variant)', () => {
  // The associative variant of Rule 5 (see pickErrorField doc-comment in
  // profile/outbox-merger-error-fields.ts) is a status-independent
  // join: undefined < anything; both defined → lex-min. The §7.1 spec's
  // pairwise wording ("more-advanced status wins; earlier Lamport on
  // tie") is not associative in 3-way merges. We satisfy the spec's
  // intent — "first-decided error is preserved" — via stickiness, while
  // honoring the CRDT associativity invariant required by W9.

  it('error stickiness: defined beats undefined regardless of side', () => {
    const a = makeEntry({ status: 'sending', lamport: 99, error: 'transient bump' });
    const b = makeEntry({ status: 'failed-permanent', lamport: 1, error: undefined });
    const sm = mergeStatus(a, b);
    const r = mergeErrorFields(a, b, sm);
    expect(r.error).toBe('transient bump');
  });

  it('error stickiness: defined wins regardless of Lamport magnitude', () => {
    const a = makeEntry({ status: 'failed-transient', lamport: 5, error: 'first error' });
    const b = makeEntry({ status: 'failed-transient', lamport: 99, error: undefined });
    const sm = mergeStatus(a, b);
    const r = mergeErrorFields(a, b, sm);
    expect(r.error).toBe('first error');
  });

  it('both defined: lex-min wins (associative tie-break)', () => {
    const a = makeEntry({ status: 'failed-transient', lamport: 5, error: 'apple' });
    const b = makeEntry({ status: 'failed-transient', lamport: 12, error: 'banana' });
    const sm = mergeStatus(a, b);
    const r = mergeErrorFields(a, b, sm);
    expect(r.error).toBe('apple');
  });

  it('lex-min is symmetric: swapping inputs preserves chosen error', () => {
    const a = makeEntry({ status: 'failed-transient', lamport: 7, error: 'XYZ' });
    const b = makeEntry({ status: 'failed-transient', lamport: 3, error: 'ABC' });
    const sm1 = mergeStatus(a, b);
    const r1 = mergeErrorFields(a, b, sm1);
    const sm2 = mergeStatus(b, a);
    const r2 = mergeErrorFields(b, a, sm2);
    expect(r1.error).toBe('ABC');
    expect(r2.error).toBe('ABC');
  });

  it('neither side has an error: returns undefined', () => {
    const a = makeEntry({});
    const b = makeEntry({});
    const sm = mergeStatus(a, b);
    const r = mergeErrorFields(a, b, sm);
    expect(r.error).toBeUndefined();
  });

  it('override path: surfaces the failed-permanent side error via stickiness', () => {
    const a = makeEntry({ status: 'failed-permanent', lamport: 5, error: 'oracle-rejected' });
    const b = makeEntry({ status: 'finalizing', overrideApplied: true, lamport: 99, error: undefined });
    const sm = mergeStatus(a, b);
    const r = mergeErrorFields(a, b, sm);
    expect(r.error).toBe('oracle-rejected'); // forensic trail preserved
  });

  it('cross-partition stickiness: hard-terminal error survives even when status-winner is active', () => {
    // Status-winner is `b` (active overrides hard via override arc), but the
    // error survives via stickiness — the hard-terminal side carried it.
    const a = makeEntry({ status: 'failed-permanent', error: 'oracle-rejected' });
    const b = makeEntry({ status: 'sending', error: undefined });
    const sm = mergeStatus(a, b);
    const r = mergeErrorFields(a, b, sm);
    expect(r.error).toBe('oracle-rejected');
  });
});

// -----------------------------------------------------------------------------
// Rule 6 — Lamport max-merge
// -----------------------------------------------------------------------------

describe('mergeStatus — Rule 6 (Lamport max-merge)', () => {
  it('lamport always max-merges, regardless of which side wins status', () => {
    const a = makeEntry({ status: 'sending', lamport: 17 });
    const b = makeEntry({ status: 'pinned', lamport: 4 });
    const r = mergeStatus(a, b);
    // Rule 1 active arc: sending > pinned → a wins. Lamport max = 17.
    expect(r.lamport).toBe(17);
  });

  it('lamport max-merges even when the lower-rank side has the higher Lamport', () => {
    const a = makeEntry({ status: 'pinned', lamport: 99 });
    const b = makeEntry({ status: 'finalizing', lamport: 5 });
    const r = mergeStatus(a, b);
    expect(r.status).toBe('finalizing'); // status wins by lattice
    expect(r.lamport).toBe(99); // Lamport still max
  });
});

// -----------------------------------------------------------------------------
// Lattice helpers
// -----------------------------------------------------------------------------

describe('activeLatticeRank / hardTerminalRank', () => {
  it('activeLatticeRank: monotone over the active lattice', () => {
    expect(activeLatticeRank('packaging')).toBeLessThan(activeLatticeRank('pinned'));
    expect(activeLatticeRank('pinned')).toBeLessThan(activeLatticeRank('sending'));
    expect(activeLatticeRank('sending')).toBeLessThan(activeLatticeRank('delivered'));
    expect(activeLatticeRank('delivered')).toEqual(activeLatticeRank('delivered-instant'));
    expect(activeLatticeRank('delivered-instant')).toBeLessThan(activeLatticeRank('finalizing'));
  });

  it('activeLatticeRank: returns -1 for non-active statuses', () => {
    const nonActive: ReadonlyArray<UxfOutboxStatus> = [
      'failed-transient',
      'failed-permanent',
      'finalized',
      'expired',
    ];
    for (const s of nonActive) {
      expect(activeLatticeRank(s)).toBe(-1);
    }
  });

  it('hardTerminalRank: finalized > failed-permanent > expired', () => {
    expect(hardTerminalRank('finalized')).toBeGreaterThan(hardTerminalRank('failed-permanent'));
    expect(hardTerminalRank('failed-permanent')).toBeGreaterThan(hardTerminalRank('expired'));
  });

  it('hardTerminalRank: returns -1 for non-hard-terminal statuses', () => {
    expect(hardTerminalRank('sending')).toBe(-1);
    expect(hardTerminalRank('failed-transient')).toBe(-1);
  });
});

// -----------------------------------------------------------------------------
// mergeOutboxEntries orchestrator
// -----------------------------------------------------------------------------

describe('mergeOutboxEntries — orchestrator', () => {
  it('rejects merges across distinct ids (defensive)', () => {
    const a = makeEntry({ id: 'A' });
    const b = makeEntry({ id: 'B' });
    expect(() => mergeOutboxEntries(a, b)).toThrowError(SphereError);
  });

  it('full merge: status / requestIds / errors / counters / Lamport', () => {
    const a = makeEntry({
      status: 'sending',
      lamport: 5,
      submitRetryCount: 2,
      proofErrorCount: 0,
      outstandingRequestIds: ['r1'],
      completedRequestIds: [],
      error: 'A error',
    });
    const b = makeEntry({
      status: 'finalizing',
      lamport: 9,
      submitRetryCount: 1,
      proofErrorCount: 3,
      outstandingRequestIds: [],
      completedRequestIds: ['r1'],
      error: undefined,
    });
    const r = mergeOutboxEntries(a, b);

    expect(r.status).toBe('finalizing'); // active lattice: finalizing > sending
    expect(r.lamport).toBe(9);
    expect(r.submitRetryCount).toBe(2);
    expect(r.proofErrorCount).toBe(3);
    expect([...(r.outstandingRequestIds ?? [])]).toEqual([]); // r1 moved to completed
    expect([...(r.completedRequestIds ?? [])]).toEqual(['r1']);
    // Both active partition. Error stickiness: a has 'A error', b is undefined.
    // Defined beats undefined → a's error survives.
    expect(r.error).toBe('A error');
  });

  it('immutable inputs: neither input is mutated', () => {
    const a = makeEntry({ submitRetryCount: 2 });
    const b = makeEntry({ submitRetryCount: 5 });
    const beforeA = { ...a };
    const beforeB = { ...b };
    mergeOutboxEntries(a, b);
    expect(a).toEqual(beforeA);
    expect(b).toEqual(beforeB);
  });

  it('createdAt: min-merges, updatedAt: max-merges', () => {
    const a = makeEntry({ createdAt: 100, updatedAt: 200 });
    const b = makeEntry({ createdAt: 50, updatedAt: 300 });
    const r = mergeOutboxEntries(a, b);
    expect(r.createdAt).toBe(50);
    expect(r.updatedAt).toBe(300);
  });

  it('emits empty arrays as undefined fields (preserves writer canonical form)', () => {
    const a = makeEntry({});
    const b = makeEntry({});
    const r = mergeOutboxEntries(a, b);
    expect(r.outstandingRequestIds).toBeUndefined();
    expect(r.completedRequestIds).toBeUndefined();
  });

  it('preserves _schemaVersion on merged output', () => {
    const a = makeEntry({});
    const b = makeEntry({});
    const r = mergeOutboxEntries(a, b);
    expect(r._schemaVersion).toBe('uxf-1');
  });

  it('carries through recipientNametag if set on either side', () => {
    const a = makeEntry({ recipientNametag: undefined });
    const b = makeEntry({ recipientNametag: 'alice' });
    const r = mergeOutboxEntries(a, b);
    expect(r.recipientNametag).toBe('alice');
  });

  it('carries through deadlines from the winner first, then either side', () => {
    const a = makeEntry({ status: 'sending', retryDeadline: 1_000 });
    const b = makeEntry({ status: 'finalizing', retryDeadline: undefined });
    const r = mergeOutboxEntries(a, b);
    // finalizing wins; lacks retryDeadline; carry-through from a.
    expect(r.retryDeadline).toBe(1_000);
  });
});

// -----------------------------------------------------------------------------
// mergeOutboxEntriesPair (N-way fold)
// -----------------------------------------------------------------------------

describe('mergeOutboxEntriesPair — N-way fold', () => {
  it('throws on empty input', () => {
    expect(() => mergeOutboxEntriesPair([])).toThrowError(SphereError);
  });

  it('single entry: returns that entry', () => {
    const a = makeEntry({});
    const r = mergeOutboxEntriesPair([a]);
    expect(r).toEqual(a);
  });

  it('three replicas: associative left-fold equals expected', () => {
    const a = makeEntry({ status: 'sending', lamport: 5, submitRetryCount: 1 });
    const b = makeEntry({ status: 'finalizing', lamport: 7, submitRetryCount: 3 });
    const c = makeEntry({ status: 'finalized', lamport: 3, submitRetryCount: 0 });
    const r = mergeOutboxEntriesPair([a, b, c]);
    expect(r.status).toBe('finalized'); // hard-terminal beats active
    expect(r.lamport).toBe(7);
    expect(r.submitRetryCount).toBe(3);
  });

  it('rejects mid-fold id mismatch', () => {
    const a = makeEntry({ id: 'X' });
    const b = makeEntry({ id: 'X' });
    const c = makeEntry({ id: 'Y' });
    expect(() => mergeOutboxEntriesPair([a, b, c])).toThrowError(SphereError);
  });
});

// -----------------------------------------------------------------------------
// C12 — race-lost CRDT acceptance (cascade NOT fired by merger)
// -----------------------------------------------------------------------------

describe('C12 race-lost CRDT acceptance', () => {
  it('two race-lost replicas converge to failed-permanent reason="race-lost"', () => {
    const a = makeEntry({
      status: 'failed-permanent',
      lamport: 5,
      error: 'race-lost',
    });
    const b = makeEntry({
      status: 'failed-permanent',
      lamport: 7,
      error: 'race-lost',
    });
    const r = mergeOutboxEntries(a, b);
    expect(r.status).toBe('failed-permanent');
    expect(r.error).toBe('race-lost');
  });

  it('merger does NOT mutate inputs to "fire" any cascade flag (delegated to T.5.B.5)', () => {
    // The merger has no concept of a cascade flag; we verify by snapshotting
    // every key on the merged output and asserting it carries only
    // schema-declared fields. No `cascadeFired` / `triggeredCascade` /
    // similar key may leak from the merger.
    const a = makeEntry({ status: 'failed-permanent', error: 'race-lost' });
    const b = makeEntry({ status: 'failed-permanent', error: 'race-lost' });
    const r = mergeOutboxEntries(a, b);
    const allowedKeys = new Set([
      '_schemaVersion',
      'id',
      'bundleCid',
      'tokenIds',
      'deliveryMethod',
      'recipient',
      'recipientTransportPubkey',
      'recipientNametag',
      'mode',
      'status',
      'outstandingRequestIds',
      'completedRequestIds',
      'memo',
      'createdAt',
      'updatedAt',
      'lamport',
      'overrideApplied',
      'everFinalizing',
      'error',
      'submitRetryCount',
      'proofErrorCount',
      'retryDeadline',
      'pollingDeadline',
      'pollStartedAt',
    ]);
    for (const k of Object.keys(r)) {
      expect(allowedKeys.has(k)).toBe(true);
    }
  });
});

// -----------------------------------------------------------------------------
// Steelman crit #12 — sticky everFinalizing for override revival
// -----------------------------------------------------------------------------

describe('steelman crit #12 — sticky everFinalizing override revival', () => {
  it('mergeStatus stamps everFinalizing when either side has status=finalizing', () => {
    const a = makeEntry({ status: 'finalizing', lamport: 5 });
    const b = makeEntry({ status: 'failed-permanent', lamport: 7 });
    const r = mergeStatus(a, b);
    expect(r.everFinalizing).toBe(true);
  });

  it('mergeStatus carries everFinalizing forward (set-OR) when neither current status is finalizing', () => {
    const a = makeEntry({
      status: 'failed-permanent',
      lamport: 5,
      everFinalizing: true,
    });
    const b = makeEntry({ status: 'failed-permanent', lamport: 7 });
    const r = mergeStatus(a, b);
    expect(r.everFinalizing).toBe(true);
  });

  it('override revival arc fires when everFinalizing=true + failed-permanent + overrideApplied', () => {
    // Inner-fold output: failed-permanent + everFinalizing carried over.
    // Outer fold: failed-permanent + overrideApplied.
    const innerFoldOutput = makeEntry({
      status: 'failed-permanent',
      lamport: 5,
      everFinalizing: true,
      overrideApplied: false,
    });
    const overrideSide = makeEntry({
      status: 'failed-permanent',
      lamport: 5,
      overrideApplied: true,
    });
    const r = mergeStatus(innerFoldOutput, overrideSide);
    expect(r.status).toBe('finalizing'); // revived
    expect(r.winner).toBe('override');
    expect(r.overrideApplied).toBe(true);
    expect(r.everFinalizing).toBe(true);
  });

  it('without everFinalizing, two failed-permanent + override remain failed-permanent', () => {
    // Negative control: revival arc requires the historical `finalizing`
    // observation. Without `everFinalizing: true` the multiset is just
    // {failed-permanent, failed-permanent} and Rule 2 cannot revive.
    const a = makeEntry({
      status: 'failed-permanent',
      lamport: 5,
      overrideApplied: false,
    });
    const b = makeEntry({
      status: 'failed-permanent',
      lamport: 5,
      overrideApplied: true,
    });
    const r = mergeStatus(a, b);
    expect(r.status).toBe('failed-permanent');
  });

  it('formerly-broken multiset: both fold orders converge to finalizing', () => {
    // The exact reproducer from the steelman crit #12 doc-comment.
    //   a = finalizing,        overrideApplied: false
    //   b = failed-permanent,  overrideApplied: false
    //   c = failed-permanent,  overrideApplied: true
    // Pre-fix:
    //   merge(merge(a, b), c) -> failed-permanent (a's finalizing lost)
    //   merge(a, merge(b, c)) -> finalizing       (override arc fires)
    // Post-fix: BOTH converge to `finalizing` thanks to `everFinalizing`.
    const a = makeEntry({
      id: 'crit-12',
      status: 'finalizing',
      lamport: 5,
      overrideApplied: false,
    });
    const b = makeEntry({
      id: 'crit-12',
      status: 'failed-permanent',
      lamport: 5,
      overrideApplied: false,
    });
    const c = makeEntry({
      id: 'crit-12',
      status: 'failed-permanent',
      lamport: 5,
      overrideApplied: true,
    });

    const left = mergeOutboxEntries(mergeOutboxEntries(a, b), c);
    const right = mergeOutboxEntries(a, mergeOutboxEntries(b, c));

    expect(left.status).toBe('finalizing');
    expect(right.status).toBe('finalizing');
    expect(left.status).toBe(right.status);
    expect(left.overrideApplied).toBe(true);
    expect(right.overrideApplied).toBe(true);
    expect(left.everFinalizing).toBe(true);
    expect(right.everFinalizing).toBe(true);
  });

  it('mergeOutboxEntries persists everFinalizing flag in output', () => {
    const a = makeEntry({ status: 'finalizing', lamport: 5 });
    const b = makeEntry({ status: 'sending', lamport: 3 });
    const r = mergeOutboxEntries(a, b);
    expect(r.everFinalizing).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Adversarial / edge cases
// -----------------------------------------------------------------------------

describe('edge cases', () => {
  it('merging a with itself is idempotent (a ⊕ a === a, structurally)', () => {
    const a = makeEntry({
      status: 'sending',
      submitRetryCount: 2,
      proofErrorCount: 1,
      outstandingRequestIds: ['r1'],
      completedRequestIds: ['r0'],
      error: 'X',
      lamport: 5,
    });
    const r = mergeOutboxEntries(a, a);
    expect(r.status).toBe(a.status);
    expect(r.lamport).toBe(a.lamport);
    expect(r.submitRetryCount).toBe(a.submitRetryCount);
    expect(r.proofErrorCount).toBe(a.proofErrorCount);
    expect(r.error).toBe(a.error);
    expect([...(r.outstandingRequestIds ?? [])]).toEqual(['r1']);
    expect([...(r.completedRequestIds ?? [])]).toEqual(['r0']);
  });

  it('merging is commutative on status', () => {
    const a = makeEntry({ status: 'sending', lamport: 3 });
    const b = makeEntry({ status: 'finalizing', lamport: 7 });
    const r1 = mergeOutboxEntries(a, b);
    const r2 = mergeOutboxEntries(b, a);
    expect(r1.status).toBe(r2.status);
    expect(r1.lamport).toBe(r2.lamport);
    expect(r1.submitRetryCount).toBe(r2.submitRetryCount);
  });

  it('merging is commutative on requestIds (sorted output)', () => {
    const a = makeEntry({ outstandingRequestIds: ['r1', 'r2'], completedRequestIds: ['r3'] });
    const b = makeEntry({ outstandingRequestIds: ['r4'], completedRequestIds: ['r2'] });
    const r1 = mergeOutboxEntries(a, b);
    const r2 = mergeOutboxEntries(b, a);
    expect([...(r1.outstandingRequestIds ?? [])]).toEqual([...(r2.outstandingRequestIds ?? [])]);
    expect([...(r1.completedRequestIds ?? [])]).toEqual([...(r2.completedRequestIds ?? [])]);
  });
});
