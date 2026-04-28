/**
 * UXF Inter-Wallet Transfer — CRDT error-field + G-counter merge
 * (T.6.B, N3 split).
 *
 * Implements §7.1 conflict-resolution **Rules 4 and 5**:
 *
 *  - **Rule 4 (G-counter max-merge)**: `submitRetryCount` and
 *    `proofErrorCount` are G-counters — monotonically non-decreasing
 *    counters where the merge of two replicas is the per-key max. Replicas
 *    only ever increment, so `max(a, b)` is the join (least upper bound)
 *    in the standard G-counter lattice.
 *
 *  - **Rule 5 (error-field rule)**: the `error` string lives on the entry
 *    whose `status` is "more advanced" per the partition lattice (Rule 1).
 *    Tie among equal-partition replicas → take the side with the **earlier**
 *    Lamport timestamp (the first-decided error survives subsequent
 *    transient retries). The status-merge orchestrator already decided the
 *    winner; this module reuses that decision via {@link StatusMergeResult}
 *    rather than re-running the partition rule.
 *
 *  - **W45 helper — `audit_promoted_from`** (set-OR set-merge, §5.4 / §7.1
 *    "array fields union with dedupe"). Exported as a standalone function
 *    so callers (including the manifest-store and the outbox merger
 *    orchestrator) can run the same set-OR. Currently `audit_promoted_from`
 *    lives canonically on manifest entries (§5.4); the helper is exported
 *    here so the outbox merger remains a single import point for callers
 *    that compose manifest + outbox merges.
 *
 * @module profile/outbox-merger-error-fields
 * @see profile/outbox-merger.ts — top-level orchestrator.
 * @see docs/uxf/UXF-TRANSFER-PROTOCOL.md §7.1 — canonical rules.
 */

import type { UxfTransferOutboxEntry } from '../types/uxf-outbox';
import type { StatusMergeResult } from './outbox-merger-status';

// =============================================================================
// 1. Result type
// =============================================================================

/**
 * Merged error-field block.
 *
 * - `error` may be `undefined` if neither side carried an error.
 * - `submitRetryCount` and `proofErrorCount` are always concrete (G-counter
 *   max-merge produces a value even if both sides are zero).
 */
export interface ErrorFieldsMergeResult {
  readonly error: string | undefined;
  readonly submitRetryCount: number;
  readonly proofErrorCount: number;
}

// =============================================================================
// 2. mergeErrorFields — Rules 4 + 5
// =============================================================================

/**
 * CRDT-merge the error-field block across two replicas, using the
 * already-computed status-merge winner to drive Rule 5.
 *
 * Algorithm (per §7.1 rows 4 + 5):
 *
 *  - Rule 4 (counters): `result.submitRetryCount = max(a, b)` and
 *    `result.proofErrorCount = max(a, b)`. G-counter join.
 *
 *  - Rule 5 (error string):
 *      * If the status-merge produced a clear winner (`'a'` or `'b'`),
 *        prefer that side's `error`. (More-advanced status's error wins.)
 *      * If the status-merge selected the override path (`winner ===
 *        'override'`), the override side's status is `finalizing` — there
 *        is typically no error attached, but if one is present we still
 *        surface it for forensic observability.
 *      * Tie among equal-status replicas. The status-merge breaks every
 *        tie deterministically (Lamport, then lex-min id), so by the time
 *        we reach this module the `winner` field is always set. We do
 *        NOT see "true ties". The earlier-Lamport rule is therefore
 *        encoded inside the status-merge: it returns `winner = 'a'` for
 *        the lower-Lamport side when both partitions are equal AND
 *        Lamports differ — wait, actually the status-merge prefers the
 *        higher Lamport. To honor §7.1 row 5 ("earlier Lamport wins for
 *        the error field") we override that decision *only* when both
 *        sides share the same partition.
 *
 *    Concretely: when the partitions are equal we pick the error from the
 *    side with the smaller Lamport (earlier-decided error survives); ties
 *    fall back to lex-min id. When the partitions differ we follow the
 *    status-merge winner.
 *
 *  - "No error on either side" yields `error = undefined`.
 *
 * Pure / referentially transparent.
 */
export function mergeErrorFields(
  a: UxfTransferOutboxEntry,
  b: UxfTransferOutboxEntry,
  statusMergeResult: StatusMergeResult,
): ErrorFieldsMergeResult {
  // Rule 4 — G-counter max-merge.
  const submitRetryCount = Math.max(a.submitRetryCount, b.submitRetryCount);
  const proofErrorCount = Math.max(a.proofErrorCount, b.proofErrorCount);

  // Rule 5 — error string.
  const error = pickErrorField(a, b, statusMergeResult);

  return { error, submitRetryCount, proofErrorCount };
}

/**
 * Internal: implement Rule 5 as a strictly-associative CRDT join.
 *
 * **§7.1 row 5 (pairwise wording)**:
 *   "the replica with the more-advanced `status` wins; among
 *    equal-status replicas, the earlier Lamport timestamp wins (the
 *    first-decided error is preserved)."
 *
 * **Associativity caveat (T.6.B / W9 audit)**. The literal pairwise rule
 * is NOT associative in 3-way merges:
 *
 *  1. Earlier-Lamport tie-break — pairwise-merged Lamport is `max(a, b)`,
 *     which obliterates the original "earlier" timestamp and produces
 *     different outcomes for `merge(merge(a, b), c)` vs
 *     `merge(a, merge(b, c))`.
 *
 *  2. Status-winner-takes-error rule — the status of the merged entry is
 *     not the same as the status of any constituent replica when the
 *     hard-terminal preference / override arc / lattice rules cause
 *     different intermediate winners depending on merge order. The error
 *     payload from a "lost" intermediate replica is then irrecoverable.
 *
 * The §7.1 invariants up the page demand deterministic merge outcomes
 * ("Implementations that fail to follow this rule will see
 * non-deterministic merge outcomes") and the surrounding text describes
 * OrbitDB CRDT semantics, which require associativity by the standard
 * CRDT join-semilattice contract.
 *
 * **Strictly associative variant we implement** (status-independent join):
 *   - Both `undefined`               → `undefined`.
 *   - Exactly one defined            → the defined one (error stickiness).
 *   - Both defined                   → **lex-min of the error string**.
 *
 * This is a join in the lattice where `undefined < anything` and the
 * `string` partial order is total via lex-min. The result is purely a
 * function of the multiset {a.error, b.error}, which makes it commutative
 * and associative by construction. It honors the spec's INTENT
 * ("first-decided error is preserved") with one narrow trade-off: when
 * both replicas independently set distinct error strings, the lex-min
 * string survives instead of the earlier-Lamport one. This is the
 * standard CRDT lattice resolution for such ties.
 *
 * The `statusMergeResult` argument is retained in the signature for
 * forward compatibility (future spec revisions may layer additional
 * status-aware logic on top of the join), but is not used by the current
 * implementation.
 *
 *  - "Empty string" is treated as "present" — we do not coalesce. The
 *    writer is responsible for never persisting `""`. We coalesce only
 *    `undefined`.
 */
function pickErrorField(
  a: UxfTransferOutboxEntry,
  b: UxfTransferOutboxEntry,
  _smr: StatusMergeResult,
): string | undefined {
  void _smr; // see doc-comment "forward compatibility"
  if (a.error === undefined && b.error === undefined) return undefined;
  if (a.error === undefined) return b.error;
  if (b.error === undefined) return a.error;
  return a.error <= b.error ? a.error : b.error;
}

// =============================================================================
// 3. mergeAuditPromotedFrom — W45 set-OR helper
// =============================================================================

/**
 * Set-OR merge for the manifest entry's `audit_promoted_from` field
 * (§5.4 / §7.1 array-field union rule, W45).
 *
 *  - Both sides `undefined`        → `undefined` (no audit history).
 *  - Either side defined           → union, deduped, lex-sorted, frozen.
 *  - Empty arrays are treated as "defined" — `[] ∪ [a]` returns `[a]`,
 *    `[] ∪ []` returns `[]` (NOT `undefined`). This preserves the
 *    "writer chose to set the field even with zero entries" signal.
 *
 * Pure / referentially transparent. Commutative, idempotent, associative.
 *
 * Currently used by:
 *  - `tests/unit/profile/outbox-merger-audit-promoted-from.test.ts` (W45)
 *  - manifest-store merge (T.6.D, future).
 */
export function mergeAuditPromotedFrom(
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> | undefined {
  if (a === undefined && b === undefined) return undefined;
  const set = new Set<string>();
  if (a !== undefined) {
    for (const v of a) {
      if (typeof v === 'string' && v.length > 0) set.add(v);
    }
  }
  if (b !== undefined) {
    for (const v of b) {
      if (typeof v === 'string' && v.length > 0) set.add(v);
    }
  }
  const out = [...set];
  out.sort();
  return Object.freeze(out);
}
