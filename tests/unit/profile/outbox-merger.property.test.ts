/**
 * Property-based tests for `profile/outbox-merger.ts` (T.6.B, W9).
 *
 * Uses fast-check to verify the CRDT laws of the outbox merger across the
 * complete generator space:
 *
 *  - **Commutativity** — `merge(a, b)` and `merge(b, a)` agree on every
 *    merge-relevant field (status, lamport, counters, sets, error). The
 *    `winner` field of {@link mergeStatus} is symmetry-preserving: `'a'`
 *    becomes `'b'` and vice versa under input swap; `'override'` stays
 *    `'override'`. Because the orchestrator's output does not surface the
 *    `winner` field, we only check the merged-entry fields.
 *  - **Idempotency** — `merge(a, a)` is structurally `a` (modulo
 *    array-sorting / undefined-coalescing). This catches accidental
 *    double-counting of counters or list duplication.
 *  - **Associativity** — `merge(merge(a, b), c) == merge(a, merge(b, c))`.
 *    Required for the N-way fold to be reorder-safe.
 *  - **Monotonic Lamport** — `result.lamport >= max(a.lamport, b.lamport)`.
 *    Guards against accidental decay (Rule 6).
 *  - **G-counter monotonicity** — `result.submitRetryCount >= max(a, b)`,
 *    `result.proofErrorCount >= max(a, b)` (Rule 4).
 *  - **Set-OR for `audit_promoted_from`** — `merge` of two arrays is a
 *    superset of both inputs (W45 helper).
 *  - **Two-set requestId invariant** — `result.outstanding ∩
 *    result.completed === ∅` always holds (the load-bearing two-set
 *    promise of Rule 2-bis).
 *
 * fast-check generators are tuned to keep input arrays small (≤8 items)
 * and Lamports under `100_000` so the W39 bounds defense never trips and
 * runs stay fast (≤2s per property).
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { UxfTransferOutboxEntry, UxfOutboxStatus } from '../../../types/uxf-outbox';
import {
  mergeOutboxEntries,
  mergeStatus,
  mergeAuditPromotedFrom,
} from '../../../extensions/uxf/profile/outbox-merger';

// -----------------------------------------------------------------------------
// fast-check arbitraries
// -----------------------------------------------------------------------------

const STATUSES: ReadonlyArray<UxfOutboxStatus> = [
  'packaging',
  'pinned',
  'sending',
  'delivered',
  'delivered-instant',
  'finalizing',
  'finalized',
  'failed-transient',
  'failed-permanent',
  'expired',
];

const arbStatus = fc.constantFrom(...STATUSES);

const arbReqId = fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s.length > 0);
const arbReqIdSet = fc.array(arbReqId, { minLength: 0, maxLength: 8 });

/**
 * Statuses on which `overrideApplied: true` is reachable per §7.0 / §6.3:
 * the writer sets the flag during `failed-permanent → finalizing` via
 * `importInclusionProof()`. Subsequent transitions are `finalizing →
 * finalized` (flag stays sticky), `finalizing → failed-permanent` (flag
 * stays sticky on a second failure), and `finalized → expired`
 * (retention-window aging keeps the flag set per Rule 2 stickiness).
 * Therefore the reachable `(status, overrideApplied=true)` pairs are
 * exactly these four statuses.
 *
 * `expired` was added in Round 3 — the previous list omitted it, but
 * `finalized → expired` is in the §7.0 table and the merge layer's
 * override-revival arc must remain associative across the full reachable
 * space (including a single-replica `expired+ovr=true` entry).
 *
 * Restricting the arbitrary to reachable shapes keeps the property tests
 * sharp on real-world inputs without exercising states that the writer
 * never produces.
 */
const OVERRIDE_REACHABLE_STATUSES: ReadonlyArray<UxfOutboxStatus> = [
  'finalizing',
  'finalized',
  'failed-permanent',
  'expired',
];

/**
 * Arbitrary `UxfTransferOutboxEntry` with bounded Lamports / counters and
 * a stable `id`. The `id` is fixed across pairs/triples so the
 * orchestrator's id-mismatch guard never trips.
 *
 * `overrideApplied: true` only co-occurs with statuses in
 * {@link OVERRIDE_REACHABLE_STATUSES} per §6.3 / §7.0; other status values
 * may still freely choose `overrideApplied: false`.
 */
function arbEntry(id: string = 'entry-1'): fc.Arbitrary<UxfTransferOutboxEntry> {
  return fc.record({
    status: arbStatus,
    lamport: fc.integer({ min: 0, max: 100_000 }),
    submitRetryCount: fc.integer({ min: 0, max: 1000 }),
    proofErrorCount: fc.integer({ min: 0, max: 1000 }),
    outstandingRequestIds: arbReqIdSet,
    completedRequestIds: arbReqIdSet,
    rawOverride: fc.boolean(),
    error: fc.option(fc.string({ minLength: 1, maxLength: 32 }), { nil: undefined }),
    createdAt: fc.integer({ min: 1, max: 1_000_000_000_000 }),
    updatedAt: fc.integer({ min: 1, max: 1_000_000_000_000 }),
    // Shape fields — vary across replicas so the W3.2 winnerEntry-shape
    // bug is observable. Real-world divergence on these fields would be
    // a writer bug, but the merger MUST still converge deterministically
    // (the active/hard-terminal winner's view is canonical per §7.1).
    bundleCidSuffix: fc.constantFrom('A', 'B', 'C'),
    recipientChoice: fc.constantFrom(
      'DIRECT://alpha',
      'DIRECT://beta',
      'DIRECT://gamma',
    ),
    tokenIdsChoice: fc.constantFrom(
      ['tok-1'] as ReadonlyArray<string>,
      ['tok-2'] as ReadonlyArray<string>,
      ['tok-1', 'tok-2'] as ReadonlyArray<string>,
    ),
  }).map((rec) => {
    // Suppress unreachable (status, override=true) combinations.
    const overrideApplied =
      rec.rawOverride && (OVERRIDE_REACHABLE_STATUSES as ReadonlyArray<string>).includes(rec.status);
    const entry: UxfTransferOutboxEntry = {
      _schemaVersion: 'uxf-1' as const,
      id,
      bundleCid: `bafy-${id}-${rec.bundleCidSuffix}`,
      tokenIds: rec.tokenIdsChoice,
      deliveryMethod: 'car-over-nostr' as const,
      recipient: rec.recipientChoice,
      recipientTransportPubkey: 'pub-test',
      mode: 'instant' as const,
      status: rec.status,
      outstandingRequestIds: rec.outstandingRequestIds,
      completedRequestIds: rec.completedRequestIds,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      lamport: rec.lamport,
      overrideApplied,
      submitRetryCount: rec.submitRetryCount,
      proofErrorCount: rec.proofErrorCount,
      ...(rec.error !== undefined ? { error: rec.error } : {}),
    };
    return entry;
  });
}

// -----------------------------------------------------------------------------
// Helpers — equality on merge-relevant projection
// -----------------------------------------------------------------------------

function projection(e: UxfTransferOutboxEntry): {
  status: UxfOutboxStatus;
  lamport: number;
  submitRetryCount: number;
  proofErrorCount: number;
  outstanding: ReadonlyArray<string>;
  completed: ReadonlyArray<string>;
  error: string | undefined;
  overrideApplied: boolean;
  everFinalizing: boolean;
} {
  return {
    status: e.status,
    lamport: e.lamport,
    submitRetryCount: e.submitRetryCount,
    proofErrorCount: e.proofErrorCount,
    outstanding: [...(e.outstandingRequestIds ?? [])],
    completed: [...(e.completedRequestIds ?? [])],
    error: e.error,
    overrideApplied: e.overrideApplied === true,
    everFinalizing: e.everFinalizing === true,
  };
}

/**
 * Shape-fields projection — bundleCid, tokenIds, recipient — used to
 * verify the W3.2 winnerEntry-shape fix. The orchestrator picks shape
 * fields from the status-merge winner (NOT the side that stamped the
 * override flag). The shape MUST converge under prev/next swap.
 */
function shapeProjection(e: UxfTransferOutboxEntry): {
  bundleCid: string;
  tokenIds: ReadonlyArray<string>;
  recipient: string;
} {
  return {
    bundleCid: e.bundleCid,
    tokenIds: [...e.tokenIds],
    recipient: e.recipient,
  };
}

// -----------------------------------------------------------------------------
// Properties
// -----------------------------------------------------------------------------

describe('outbox-merger property tests (W9)', () => {
  describe('commutativity', () => {
    it('merge(a, b) projection === merge(b, a) projection', () => {
      fc.assert(
        fc.property(arbEntry(), arbEntry(), (a, b) => {
          const ab = mergeOutboxEntries(a, b);
          const ba = mergeOutboxEntries(b, a);
          expect(projection(ab)).toEqual(projection(ba));
        }),
        { numRuns: 200 },
      );
    });

    it('shape (bundleCid, tokenIds, recipient) is commutative under prev/next swap (W3.2)', () => {
      // The W3.2 fix ensures the orchestrator's winnerEntry selection
      // for shape fields is driven by the status-merge winner — and for
      // the override arc, by the `finalizing`-status side regardless of
      // where the `overrideApplied` flag was stamped. Pre-fix, the
      // orchestrator looked for `status === 'finalizing' &&
      // overrideApplied === true` and fell through to `b` whenever the
      // flag lived on the `failed-permanent` side, taking shape fields
      // from the wrong replica and breaking commutativity.
      fc.assert(
        fc.property(arbEntry(), arbEntry(), (a, b) => {
          const ab = mergeOutboxEntries(a, b);
          const ba = mergeOutboxEntries(b, a);
          expect(shapeProjection(ab)).toEqual(shapeProjection(ba));
        }),
        // Round 3: bumped from 300 → 2000 to catch the
        // pickWinnerEntryForShape revival regression and any future
        // similar bugs in the expanded generator space.
        { numRuns: 2000 },
      );
    });

    it('mergeStatus.lamport / status / overrideApplied are commutative', () => {
      fc.assert(
        fc.property(arbEntry(), arbEntry(), (a, b) => {
          const ab = mergeStatus(a, b);
          const ba = mergeStatus(b, a);
          expect(ab.lamport).toBe(ba.lamport);
          expect(ab.status).toBe(ba.status);
          expect(ab.overrideApplied).toBe(ba.overrideApplied);
        }),
        { numRuns: 200 },
      );
    });
  });

  describe('idempotency', () => {
    it('merge(a, a) projection === a projection', () => {
      fc.assert(
        fc.property(arbEntry(), (a) => {
          const aa = mergeOutboxEntries(a, a);
          // Compare projections — outstanding/completed are sorted+deduped on
          // the merged side but the original may not be sorted.
          const before = projection(a);
          const after = projection(aa);
          expect(after.status).toBe(before.status);
          expect(after.lamport).toBe(before.lamport);
          expect(after.submitRetryCount).toBe(before.submitRetryCount);
          expect(after.proofErrorCount).toBe(before.proofErrorCount);
          expect(after.error).toBe(before.error);
          expect(after.overrideApplied).toBe(before.overrideApplied);
          // Sorted-deduped equivalence on the request id sets: outstanding
          // is union(a.out, a.out) - completed = a.out - a.completed
          // (if any items are in both lists, the load-bearing two-set rule
          // strips them from outstanding even on self-merge — that is the
          // canonical idempotent form).
          const aOutSet = new Set(before.outstanding);
          const aCompSet = new Set(before.completed);
          for (const v of aCompSet) aOutSet.delete(v);
          const expectedOutstanding = [...aOutSet].sort();
          const expectedCompleted = [...aCompSet].sort();
          expect(after.outstanding).toEqual(expectedOutstanding);
          expect(after.completed).toEqual(expectedCompleted);
        }),
        { numRuns: 200 },
      );
    });
  });

  describe('shape — override revival arc (Round 3)', () => {
    it('revival arc with neither side finalizing: shape converges via swap-stable tiebreak', () => {
      // Round 2 reproducer for the FIX 2 regression: when the override
      // revival arc fires and NEITHER side has status='finalizing' (both
      // are failed-permanent+overrideApplied+everFinalizing), the
      // pickWinnerEntryForShape fallthrough `a.status === 'finalizing' ?
      // a : b` evaluates to `b` always — position-based, breaking
      // commutativity.
      //
      // Build A and B both as failed-permanent+ovr+ever with DIFFERENT
      // recipients; assert merge(A, B).recipient === merge(B, A).recipient.
      const A: UxfTransferOutboxEntry = {
        _schemaVersion: 'uxf-1' as const,
        id: 'round-3-shape-revival',
        bundleCid: 'bafy-A',
        tokenIds: ['tok-A'],
        deliveryMethod: 'car-over-nostr' as const,
        recipient: 'DIRECT://a',
        recipientTransportPubkey: 'pub-A',
        mode: 'instant' as const,
        status: 'failed-permanent',
        outstandingRequestIds: [],
        completedRequestIds: [],
        createdAt: 1,
        updatedAt: 100,
        lamport: 5,
        overrideApplied: true,
        everFinalizing: true,
        submitRetryCount: 0,
        proofErrorCount: 0,
      };
      const B: UxfTransferOutboxEntry = {
        ...A,
        bundleCid: 'bafy-B',
        recipient: 'DIRECT://b',
        recipientTransportPubkey: 'pub-B',
      };
      const ab = mergeOutboxEntries(A, B);
      const ba = mergeOutboxEntries(B, A);
      // Status revives to `finalizing` via the override revival arc.
      expect(ab.status).toBe('finalizing');
      expect(ba.status).toBe('finalizing');
      // Shape MUST converge under input swap. The swap-stable tiebreak
      // picks lex-min `bundleCid` first, so both fold orders pick A.
      expect(ab.recipient).toBe(ba.recipient);
      expect(ab.bundleCid).toBe(ba.bundleCid);
      expect(ab.recipient).toBe('DIRECT://a');
      expect(ab.bundleCid).toBe('bafy-A');
    });

    it('revival arc with ONE side finalizing: shape comes from the finalizing side', () => {
      // Mixed reproducer: one side `finalizing+ovr+ever`, the other
      // `failed-permanent+ovr+ever`. The override stickiness arc
      // (Rule 2 original — not the revival arc) fires; one side IS
      // `finalizing` so pickWinnerEntryForShape picks that side
      // unambiguously.
      const finalSide: UxfTransferOutboxEntry = {
        _schemaVersion: 'uxf-1' as const,
        id: 'round-3-shape-mixed',
        bundleCid: 'bafy-FIN',
        tokenIds: ['tok-FIN'],
        deliveryMethod: 'car-over-nostr' as const,
        recipient: 'DIRECT://fin',
        recipientTransportPubkey: 'pub-FIN',
        mode: 'instant' as const,
        status: 'finalizing',
        outstandingRequestIds: [],
        completedRequestIds: [],
        createdAt: 1,
        updatedAt: 100,
        lamport: 5,
        overrideApplied: true,
        everFinalizing: true,
        submitRetryCount: 0,
        proofErrorCount: 0,
      };
      const failSide: UxfTransferOutboxEntry = {
        ...finalSide,
        bundleCid: 'bafy-FAIL',
        recipient: 'DIRECT://fail',
        recipientTransportPubkey: 'pub-FAIL',
        status: 'failed-permanent',
      };
      const ab = mergeOutboxEntries(finalSide, failSide);
      const ba = mergeOutboxEntries(failSide, finalSide);
      expect(ab.status).toBe('finalizing');
      expect(ba.status).toBe('finalizing');
      expect(ab.recipient).toBe('DIRECT://fin');
      expect(ba.recipient).toBe('DIRECT://fin');
      expect(ab.bundleCid).toBe('bafy-FIN');
      expect(ba.bundleCid).toBe('bafy-FIN');
    });
  });

  describe('shape — override arc (W3.2)', () => {
    it("override arc with flag on failed-permanent side picks finalizing side's shape", () => {
      // Concrete reproducer for the W3.2 bug: A in `failed-permanent`
      // status carries the override flag (set-OR merged from elsewhere
      // in the gossip graph); B in `finalizing` status without the flag.
      // Per §7.1 Rule 2 (override stickiness), `finalizing` wins. The
      // merged shape MUST come from B (the `finalizing` side), not from
      // A whose flag is the only co-located override marker.
      const a: UxfTransferOutboxEntry = {
        _schemaVersion: 'uxf-1' as const,
        id: 'override-shape-test',
        bundleCid: 'bafy-A-failedpermanent',
        tokenIds: ['tok-from-A'],
        deliveryMethod: 'car-over-nostr' as const,
        recipient: 'DIRECT://A-recipient',
        recipientTransportPubkey: 'pub-A',
        mode: 'instant' as const,
        status: 'failed-permanent',
        outstandingRequestIds: [],
        completedRequestIds: [],
        createdAt: 1,
        updatedAt: 100,
        lamport: 5,
        overrideApplied: true,
        submitRetryCount: 0,
        proofErrorCount: 0,
      };
      const b: UxfTransferOutboxEntry = {
        _schemaVersion: 'uxf-1' as const,
        id: 'override-shape-test',
        bundleCid: 'bafy-B-finalizing',
        tokenIds: ['tok-from-B'],
        deliveryMethod: 'car-over-nostr' as const,
        recipient: 'DIRECT://B-recipient',
        recipientTransportPubkey: 'pub-B',
        mode: 'instant' as const,
        status: 'finalizing',
        outstandingRequestIds: [],
        completedRequestIds: [],
        createdAt: 1,
        updatedAt: 200,
        lamport: 10,
        overrideApplied: false,
        submitRetryCount: 0,
        proofErrorCount: 0,
      };
      const ab = mergeOutboxEntries(a, b);
      const ba = mergeOutboxEntries(b, a);
      // Both orderings must converge on the SAME shape — the
      // `finalizing` side's view (B), not the flag-bearing side's view (A).
      expect(ab.status).toBe('finalizing');
      expect(ba.status).toBe('finalizing');
      expect(ab.bundleCid).toBe('bafy-B-finalizing');
      expect(ba.bundleCid).toBe('bafy-B-finalizing');
      expect(ab.tokenIds).toEqual(['tok-from-B']);
      expect(ba.tokenIds).toEqual(['tok-from-B']);
      expect(ab.recipient).toBe('DIRECT://B-recipient');
      expect(ba.recipient).toBe('DIRECT://B-recipient');
      // Override flag is sticky from A, regardless of which side won shape.
      expect(ab.overrideApplied).toBe(true);
      expect(ba.overrideApplied).toBe(true);
    });
  });

  describe('associativity', () => {
    it('merge(merge(a, b), c) projection === merge(a, merge(b, c)) projection', () => {
      // **Steelman crit #12 fix landed.** The previous "known limitation"
      // multiset {finalizing-no-flag, failed-permanent-no-flag,
      // failed-permanent-w-flag} is now associative thanks to the sticky
      // `everFinalizing` flag carried through intermediate hard-terminal
      // folds. The override revival arc fires whenever the multiset has
      // historically contained `finalizing` AND any side carries the
      // override flag — restoring CRDT associativity in the gossip-fold
      // model.
      //
      // **Round 3 extension** — the revival arc now also covers `expired`
      // (reachable on the override path via `failed-permanent →
      // finalizing[ovr] → finalized → expired`, or via merging an
      // override-bearing replica with one that aged out from
      // `delivered → expired`). The previously-excluded
      // `(hasExpired && hasOverride)` multiset is now associative. The
      // fc.pre() guard for that combination has been removed; the full
      // generator space — including `expired + overrideApplied=true` —
      // is exercised here.
      fc.assert(
        fc.property(arbEntry(), arbEntry(), arbEntry(), (a, b, c) => {
          const left = mergeOutboxEntries(mergeOutboxEntries(a, b), c);
          const right = mergeOutboxEntries(a, mergeOutboxEntries(b, c));
          expect(projection(left)).toEqual(projection(right));
        }),
        // Round 3: bumped from 500 → 2000 after dropping the
        // `(hasExpired && hasOverride)` fc.pre() guard. The expanded
        // generator space needs more runs to exercise the new revival
        // arc combinations.
        { numRuns: 2000 },
      );
    });

    it('formerly-excluded multiset is now associative (steelman crit #12)', () => {
      // The exact reproducer that the previous `fc.pre()` excluded.
      const a: UxfTransferOutboxEntry = {
        _schemaVersion: 'uxf-1' as const,
        id: 'crit-12-test',
        bundleCid: 'bafy-A',
        tokenIds: ['tok-1'],
        deliveryMethod: 'car-over-nostr' as const,
        recipient: 'DIRECT://A',
        recipientTransportPubkey: 'pub-A',
        mode: 'instant' as const,
        status: 'finalizing',
        createdAt: 1,
        updatedAt: 100,
        lamport: 5,
        overrideApplied: false,
        submitRetryCount: 0,
        proofErrorCount: 0,
      };
      const b: UxfTransferOutboxEntry = {
        ...a,
        bundleCid: 'bafy-B',
        recipient: 'DIRECT://B',
        recipientTransportPubkey: 'pub-B',
        status: 'failed-permanent',
        overrideApplied: false,
        lamport: 5,
      };
      const c: UxfTransferOutboxEntry = {
        ...a,
        bundleCid: 'bafy-C',
        recipient: 'DIRECT://C',
        recipientTransportPubkey: 'pub-C',
        status: 'failed-permanent',
        overrideApplied: true,
        lamport: 5,
      };

      const left = mergeOutboxEntries(mergeOutboxEntries(a, b), c);
      const right = mergeOutboxEntries(a, mergeOutboxEntries(b, c));

      // Both fold orders MUST converge on `finalizing` (the override
      // revival arc fires once the multiset contains finalizing +
      // failed-permanent + overrideApplied).
      expect(left.status).toBe('finalizing');
      expect(right.status).toBe('finalizing');
      expect(projection(left)).toEqual(projection(right));
    });
  });

  describe('monotonicity', () => {
    it('Lamport is monotone: result.lamport >= max(a.lamport, b.lamport)', () => {
      fc.assert(
        fc.property(arbEntry(), arbEntry(), (a, b) => {
          const r = mergeOutboxEntries(a, b);
          expect(r.lamport).toBeGreaterThanOrEqual(Math.max(a.lamport, b.lamport));
        }),
        { numRuns: 200 },
      );
    });

    it('submitRetryCount is monotone (G-counter)', () => {
      fc.assert(
        fc.property(arbEntry(), arbEntry(), (a, b) => {
          const r = mergeOutboxEntries(a, b);
          expect(r.submitRetryCount).toBeGreaterThanOrEqual(
            Math.max(a.submitRetryCount, b.submitRetryCount),
          );
        }),
        { numRuns: 200 },
      );
    });

    it('proofErrorCount is monotone (G-counter)', () => {
      fc.assert(
        fc.property(arbEntry(), arbEntry(), (a, b) => {
          const r = mergeOutboxEntries(a, b);
          expect(r.proofErrorCount).toBeGreaterThanOrEqual(
            Math.max(a.proofErrorCount, b.proofErrorCount),
          );
        }),
        { numRuns: 200 },
      );
    });

    it('completed-set never shrinks: result.completed >= a.completed and >= b.completed', () => {
      fc.assert(
        fc.property(arbEntry(), arbEntry(), (a, b) => {
          const r = mergeOutboxEntries(a, b);
          const completedSet = new Set(r.completedRequestIds ?? []);
          for (const v of a.completedRequestIds ?? []) {
            if (typeof v === 'string' && v.length > 0) {
              expect(completedSet.has(v)).toBe(true);
            }
          }
          for (const v of b.completedRequestIds ?? []) {
            if (typeof v === 'string' && v.length > 0) {
              expect(completedSet.has(v)).toBe(true);
            }
          }
        }),
        { numRuns: 200 },
      );
    });

    it('overrideApplied is sticky (set-OR): if either side has it, result has it', () => {
      fc.assert(
        fc.property(arbEntry(), arbEntry(), (a, b) => {
          const r = mergeOutboxEntries(a, b);
          if (a.overrideApplied === true || b.overrideApplied === true) {
            expect(r.overrideApplied).toBe(true);
          }
        }),
        { numRuns: 200 },
      );
    });
  });

  describe('two-set invariant (Rule 2-bis)', () => {
    it('outstanding and completed are always disjoint after merge', () => {
      fc.assert(
        fc.property(arbEntry(), arbEntry(), (a, b) => {
          const r = mergeOutboxEntries(a, b);
          const out = new Set(r.outstandingRequestIds ?? []);
          const comp = new Set(r.completedRequestIds ?? []);
          for (const v of out) {
            expect(comp.has(v)).toBe(false);
          }
        }),
        { numRuns: 200 },
      );
    });

    it('any id in completed on either input is NOT in result.outstanding', () => {
      fc.assert(
        fc.property(arbEntry(), arbEntry(), (a, b) => {
          const r = mergeOutboxEntries(a, b);
          const out = new Set(r.outstandingRequestIds ?? []);
          for (const v of a.completedRequestIds ?? []) {
            if (typeof v === 'string' && v.length > 0) {
              expect(out.has(v)).toBe(false);
            }
          }
          for (const v of b.completedRequestIds ?? []) {
            if (typeof v === 'string' && v.length > 0) {
              expect(out.has(v)).toBe(false);
            }
          }
        }),
        { numRuns: 200 },
      );
    });
  });

  describe('mergeAuditPromotedFrom — set-OR (W9 + W45)', () => {
    const arbStringArr = fc.array(fc.string({ minLength: 1, maxLength: 8 }), {
      minLength: 0,
      maxLength: 6,
    });
    const arbOpt = fc.option(arbStringArr, { nil: undefined });

    it('result is a superset of both non-undefined inputs', () => {
      fc.assert(
        fc.property(arbOpt, arbOpt, (a, b) => {
          const r = mergeAuditPromotedFrom(a, b);
          if (a === undefined && b === undefined) {
            expect(r).toBeUndefined();
            return;
          }
          const set = new Set(r ?? []);
          for (const v of a ?? []) {
            if (typeof v === 'string' && v.length > 0) {
              expect(set.has(v)).toBe(true);
            }
          }
          for (const v of b ?? []) {
            if (typeof v === 'string' && v.length > 0) {
              expect(set.has(v)).toBe(true);
            }
          }
        }),
        { numRuns: 200 },
      );
    });

    it('output is sorted and deduped (byte-stable)', () => {
      fc.assert(
        fc.property(arbStringArr, arbStringArr, (a, b) => {
          const r = mergeAuditPromotedFrom(a, b) ?? [];
          for (let i = 1; i < r.length; i++) {
            expect(r[i - 1]! < r[i]!).toBe(true);
          }
        }),
        { numRuns: 200 },
      );
    });

    it('commutative', () => {
      fc.assert(
        fc.property(arbOpt, arbOpt, (a, b) => {
          const ab = mergeAuditPromotedFrom(a, b);
          const ba = mergeAuditPromotedFrom(b, a);
          expect(ab).toEqual(ba);
        }),
        { numRuns: 200 },
      );
    });

    it('idempotent', () => {
      fc.assert(
        fc.property(arbOpt, (a) => {
          const aa = mergeAuditPromotedFrom(a, a);
          const expected = a === undefined
            ? undefined
            : [...new Set(a.filter((v) => typeof v === 'string' && v.length > 0))].sort();
          expect(aa).toEqual(expected);
        }),
        { numRuns: 200 },
      );
    });

    it('associative', () => {
      const arb = arbStringArr;
      fc.assert(
        fc.property(arb, arb, arb, (a, b, c) => {
          const left = mergeAuditPromotedFrom(mergeAuditPromotedFrom(a, b), c);
          const right = mergeAuditPromotedFrom(a, mergeAuditPromotedFrom(b, c));
          expect(left).toEqual(right);
        }),
        { numRuns: 200 },
      );
    });
  });
});
