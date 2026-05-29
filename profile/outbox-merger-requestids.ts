/**
 * UXF Inter-Wallet Transfer — CRDT requestId merge (T.6.B, N3 split).
 *
 * Implements §7.1 conflict-resolution **Rules 2-bis, 3** for the two-set
 * `outstandingRequestIds` / `completedRequestIds` form on
 * `UxfTransferOutboxEntry`.
 *
 *  - **Rule for `completedRequestIds`** (§7.1 row 3): straight set-union.
 *    Once completed, never un-completes — completion is monotonically
 *    growing across replicas.
 *
 *  - **Rule for `outstandingRequestIds`** (§7.1 row 2): two-set form
 *    `outstanding := union(A.outstanding, B.outstanding) -
 *                    union(A.completed, B.completed)`
 *    The subtraction is the load-bearing part: a stale replica may know
 *    nothing about a freshly-completed requestId and would re-introduce it
 *    in `outstanding` under a naive single-set merge. Two-set form ensures
 *    completion strictly removes ids from the outstanding pool, even if
 *    the stale view stays around forever.
 *
 * Determinism. The merger emits sorted arrays so two replicas merging the
 * same logical sets produce byte-identical output regardless of input
 * insertion order. This matters for deep-equality assertions in tests and
 * for byte-stable on-disk encoding.
 *
 * @module profile/outbox-merger-requestids
 * @see profile/outbox-merger.ts — top-level orchestrator.
 * @see docs/uxf/UXF-TRANSFER-PROTOCOL.md §7.1 — canonical rules.
 */

import type { UxfTransferOutboxEntry } from '../types/uxf-outbox';

// =============================================================================
// 1. Result type
// =============================================================================

/**
 * Outcome of {@link mergeRequestIds}.
 *
 * Both arrays are deduped and lex-sorted. Either may be empty. We emit
 * concrete (frozen) `ReadonlyArray<string>` rather than a Set so the
 * orchestrator can persist them to OrbitDB without an additional encoding
 * pass.
 */
export interface RequestIdsMergeResult {
  readonly outstanding: ReadonlyArray<string>;
  readonly completed: ReadonlyArray<string>;
}

// =============================================================================
// 2. Internal helpers
// =============================================================================

/**
 * Build a Set<string> from an optional ReadonlyArray<string>, treating
 * `undefined` as the empty set. Strips `undefined` / non-string entries
 * defensively (the writer should never produce them, but the merger
 * receives untrusted input from disk and from peers).
 */
function asSet(arr: ReadonlyArray<string> | undefined): Set<string> {
  const out = new Set<string>();
  if (arr === undefined) return out;
  for (const v of arr) {
    if (typeof v === 'string' && v.length > 0) out.add(v);
  }
  return out;
}

/**
 * Lex-sort a Set<string> into a frozen ReadonlyArray. Use the default
 * lexicographic comparator (`Array.prototype.sort()` with no callback) for
 * byte-stable output across runtimes.
 */
function sortedFreeze(set: Set<string>): ReadonlyArray<string> {
  const arr = [...set];
  arr.sort();
  return Object.freeze(arr);
}

// =============================================================================
// 3. mergeRequestIds — top-level
// =============================================================================

/**
 * CRDT-merge the two-set requestId form across two replicas of the same
 * `UxfTransferOutboxEntry`.
 *
 * Steps (per §7.1 rows 2 + 3):
 *   1. `completed := union(A.completed, B.completed)` — set-union, never
 *      shrinks.
 *   2. `outstanding := union(A.outstanding, B.outstanding) MINUS completed`
 *      — set-union, then subtract every id already in the merged
 *      completed set.
 *
 * Pure / referentially transparent. Commutative, idempotent, and
 * associative — `mergeRequestIds(a, mergeRequestIds(b, c))` agrees with
 * `mergeRequestIds(mergeRequestIds(a, b), c)` because set-union and
 * set-difference are themselves associative under the chosen ordering.
 *
 * Returned arrays are sorted and frozen for byte-stability.
 */
export function mergeRequestIds(
  a: UxfTransferOutboxEntry,
  b: UxfTransferOutboxEntry,
): RequestIdsMergeResult {
  // Rule 3 — straight set-union for `completedRequestIds`.
  const completedSet = new Set<string>();
  for (const v of asSet(a.completedRequestIds)) completedSet.add(v);
  for (const v of asSet(b.completedRequestIds)) completedSet.add(v);

  // Rule 2-bis — two-set form for `outstandingRequestIds`.
  // outstanding := union(A.out, B.out) - completed
  const outstandingSet = new Set<string>();
  for (const v of asSet(a.outstandingRequestIds)) {
    if (!completedSet.has(v)) outstandingSet.add(v);
  }
  for (const v of asSet(b.outstandingRequestIds)) {
    if (!completedSet.has(v)) outstandingSet.add(v);
  }

  return {
    outstanding: sortedFreeze(outstandingSet),
    completed: sortedFreeze(completedSet),
  };
}
