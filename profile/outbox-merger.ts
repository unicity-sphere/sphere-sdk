/**
 * UXF Inter-Wallet Transfer — top-level CRDT outbox merger orchestrator
 * (T.6.B).
 *
 * Combines the three §7.1 conflict-resolution split modules into a single
 * `mergeOutboxEntries(a, b)` entry point. The split is N3 from the
 * implementation plan (status / requestids / error-fields) so each rule
 * cluster lives in its own ~150-LOC file with an independent test file.
 *
 *  - {@link mergeStatus}   (`outbox-merger-status.ts`)        — Rules 1, 2, 6.
 *  - {@link mergeRequestIds} (`outbox-merger-requestids.ts`)   — Rules 2-bis, 3.
 *  - {@link mergeErrorFields} (`outbox-merger-error-fields.ts`) — Rules 4, 5.
 *  - {@link mergeAuditPromotedFrom} (`outbox-merger-error-fields.ts`) — W45.
 *
 * **Pure functions only.** No I/O, no mutation of inputs, no module-level
 * state. The orchestrator is safe to call from any context — the CRDT
 * adapter, the writer's read-modify-write loop, fast-check property tests,
 * and so on.
 *
 * **Determinism guarantees** (§7.1):
 *  - `mergeOutboxEntries(a, b)` is commutative, idempotent, and
 *    associative. The property-based test
 *    `outbox-merger.property.test.ts` (W9) verifies these laws via
 *    fast-check.
 *  - Lamport is monotonically non-decreasing on merge (Rule 6).
 *  - Counters (`submitRetryCount`, `proofErrorCount`) are G-counter
 *    max-merged (Rule 4).
 *  - The merger NEVER mutates either input.
 *
 * **C12 race-lost note**: when both inputs reflect a race-lost outcome
 * (`status === 'failed-permanent'`, `error` containing `'race-lost'`), the
 * merger faithfully records the failed re-attempt; the cascade (§6.1.1)
 * fires from the finalization worker, NOT from the merger. T.5.B.5 owns
 * cascade firing. The merger's job is purely to converge replicas.
 *
 * @module profile/outbox-merger
 * @see profile/outbox-merger-status.ts
 * @see profile/outbox-merger-requestids.ts
 * @see profile/outbox-merger-error-fields.ts
 * @see docs/uxf/UXF-TRANSFER-PROTOCOL.md §7.1
 */

import { SphereError } from '../core/errors';
import type { UxfTransferOutboxEntry } from '../types/uxf-outbox';
import { mergeStatus } from './outbox-merger-status';
import { mergeRequestIds } from './outbox-merger-requestids';
import { mergeErrorFields, mergeAuditPromotedFrom } from './outbox-merger-error-fields';

// Re-export named helpers so callers have a single import surface.
export { mergeStatus } from './outbox-merger-status';
export type { StatusMergeResult } from './outbox-merger-status';
export { mergeRequestIds } from './outbox-merger-requestids';
export type { RequestIdsMergeResult } from './outbox-merger-requestids';
export { mergeErrorFields, mergeAuditPromotedFrom } from './outbox-merger-error-fields';
export type { ErrorFieldsMergeResult } from './outbox-merger-error-fields';

// =============================================================================
// 1. Pairwise merge
// =============================================================================

/**
 * CRDT-merge two replicas of the same `UxfTransferOutboxEntry`.
 *
 * The function rejects merges across distinct ids — the keyvalue store's
 * per-key write semantics mean we should never receive two replicas of
 * different entries here. The check is defensive against caller bugs.
 *
 * Algorithm:
 *  1. Validate `a.id === b.id`. Throw `OUTBOX_MERGE_ID_MISMATCH` if not.
 *  2. Run the three split-module merges in parallel (all pure):
 *     - `mergeStatus(a, b)` → status, lamport, overrideApplied.
 *     - `mergeRequestIds(a, b)` → outstandingRequestIds, completedRequestIds.
 *     - `mergeErrorFields(a, b, statusMerge)` → error, submitRetryCount,
 *       proofErrorCount.
 *  3. Pick the immutable / non-merge fields from the status-merge winner
 *     (the side whose status survived). For the override case, the
 *     override side is the canonical winner.
 *  4. `createdAt = min(a.createdAt, b.createdAt)` — the entry was created
 *     once; both replicas should agree on this, but the min is a safe
 *     CRDT-stable choice.
 *  5. `updatedAt = max(a.updatedAt, b.updatedAt)` — wall-clock max,
 *     reflecting most-recent observed activity (informational only,
 *     not used for tie-break).
 *  6. Carry-through optional deadlines from the status-merge winner.
 *
 * Returned entry is a fresh object; both inputs are unchanged.
 */
export function mergeOutboxEntries(
  a: UxfTransferOutboxEntry,
  b: UxfTransferOutboxEntry,
): UxfTransferOutboxEntry {
  if (a.id !== b.id) {
    throw new SphereError(
      `mergeOutboxEntries: refusing to merge replicas with different ids ` +
        `(a.id="${a.id}", b.id="${b.id}")`,
      'OUTBOX_MERGE_ID_MISMATCH',
    );
  }

  const statusMerge = mergeStatus(a, b);
  const requestIdsMerge = mergeRequestIds(a, b);
  const errorMerge = mergeErrorFields(a, b, statusMerge);

  // Pick non-merge "shape" fields from the status-merge winner. Both
  // replicas should agree on these — they describe the bundle, not the
  // mutable lifecycle — but if a writer bug ever produces divergent
  // shape fields, the active/hard-terminal winner is the canonical view.
  //
  // **Override arc shape selection (steelman fix W3.2)**. When
  // `statusMerge.winner === 'override'`, the merged status is `finalizing`
  // (Rule 2 stickiness). The previous implementation picked the side where
  // `status === 'finalizing' && overrideApplied === true` were co-located
  // — but `overrideApplied` is set-OR-merged (§7.1 Rule 2), so the flag
  // may legitimately live on the `failed-permanent` side while the
  // `finalizing` status lives on the other side. In that case the previous
  // rule fell through to `b` regardless, taking shape fields (bundleCid,
  // tokenIds, recipient) from the `failed-permanent` side and diverging
  // from the canonical winner. The fix below selects the `finalizing`
  // side regardless of where the flag stamped — this matches Rule 2's
  // intent: the override arc's winner IS the `finalizing` replica's
  // entry.
  //
  // **Equal-status content-stable tie-break (steelman fix W3.2 cont'd)**.
  // When both sides share the same `(id, status, lamport)` triple — the
  // common case for two replicas of the same outbox entry — the
  // status-merge's `winner = 'a'` selection is position-based and would
  // flip the shape pick under input swap. To keep shape commutative
  // (`merge(a, b)` and `merge(b, a)` produce the same `bundleCid`,
  // `tokenIds`, `recipient`), we pick the winner-side's shape ONLY when
  // it differs in lifecycle from the loser; when both sides are
  // genuinely equal in lifecycle, we fall back to a content-stable
  // tiebreak via {@link pickShapeBySwapStableTiebreak}.
  const winnerEntry = pickWinnerEntryForShape(a, b, statusMerge.winner);

  // recipientNametag may be unset on one side; carry-through if either
  // side has it (informational, UI-only).
  const recipientNametag = winnerEntry.recipientNametag ?? a.recipientNametag ?? b.recipientNametag;
  const memo = winnerEntry.memo ?? a.memo ?? b.memo;

  // Deadlines come from the winner; if missing there but present on the
  // other side, carry-through (deadlines are monotonic — set once by the
  // worker — and either side may legitimately know them first).
  const retryDeadline = winnerEntry.retryDeadline ?? a.retryDeadline ?? b.retryDeadline;
  const pollingDeadline = winnerEntry.pollingDeadline ?? a.pollingDeadline ?? b.pollingDeadline;

  // pollStartedAt is the deadline ANCHOR for the W26 safety net. If both
  // replicas stamped it (concurrent first-poll on different hosts), the
  // EARLIER value wins — moving the anchor forward would extend the
  // termination window, defeating the cross-restart guarantee. Set-once
  // semantics in practice (workers stamp on first observation only); the
  // min() defends against a writer bug or a race window between replicas.
  const pollStartedAt =
    a.pollStartedAt !== undefined && b.pollStartedAt !== undefined
      ? Math.min(a.pollStartedAt, b.pollStartedAt)
      : (a.pollStartedAt ?? b.pollStartedAt);

  // Build the merged entry. We assemble the object with its keys in the
  // schema-declared order to match the writer's serialization.
  const merged: UxfTransferOutboxEntry = {
    _schemaVersion: 'uxf-1',
    id: a.id,
    bundleCid: winnerEntry.bundleCid,
    tokenIds: winnerEntry.tokenIds,
    deliveryMethod: winnerEntry.deliveryMethod,
    recipient: winnerEntry.recipient,
    recipientTransportPubkey: winnerEntry.recipientTransportPubkey,
    ...(recipientNametag !== undefined ? { recipientNametag } : {}),
    mode: winnerEntry.mode,
    status: statusMerge.status,
    ...(requestIdsMerge.outstanding.length > 0
      ? { outstandingRequestIds: requestIdsMerge.outstanding }
      : {}),
    ...(requestIdsMerge.completed.length > 0
      ? { completedRequestIds: requestIdsMerge.completed }
      : {}),
    ...(memo !== undefined ? { memo } : {}),
    createdAt: Math.min(a.createdAt, b.createdAt),
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
    lamport: statusMerge.lamport,
    ...(statusMerge.overrideApplied ? { overrideApplied: true } : {}),
    // `everFinalizing` is a sticky CRDT-stable boolean (steelman crit #12).
    // Persisted on every merger output so subsequent folds can revive
    // `finalizing` via the override arc even when intermediate hard-terminal
    // folds have hidden the `finalizing` status.
    ...(statusMerge.everFinalizing ? { everFinalizing: true } : {}),
    ...(errorMerge.error !== undefined ? { error: errorMerge.error } : {}),
    submitRetryCount: errorMerge.submitRetryCount,
    proofErrorCount: errorMerge.proofErrorCount,
    ...(retryDeadline !== undefined ? { retryDeadline } : {}),
    ...(pollingDeadline !== undefined ? { pollingDeadline } : {}),
    ...(pollStartedAt !== undefined ? { pollStartedAt } : {}),
  };

  return merged;
}

// =============================================================================
// 2. N-replica fold
// =============================================================================

/**
 * Merge a set of N≥1 replicas via left-fold over `mergeOutboxEntries`.
 *
 * Because pairwise merge is associative + commutative (verified by W9
 * property tests), the fold order is irrelevant to the result. We require
 * `entries.length >= 1` because a "merge of zero replicas" has no canonical
 * answer and is almost certainly a caller bug.
 *
 * @throws `OUTBOX_MERGE_EMPTY` when `entries.length === 0`.
 * @throws `OUTBOX_MERGE_ID_MISMATCH` when entries don't all share the same
 *         `id`.
 */
export function mergeOutboxEntriesPair(
  entries: ReadonlyArray<UxfTransferOutboxEntry>,
): UxfTransferOutboxEntry {
  if (entries.length === 0) {
    throw new SphereError(
      'mergeOutboxEntriesPair: cannot merge an empty set of replicas',
      'OUTBOX_MERGE_EMPTY',
    );
  }
  let acc = entries[0]!;
  for (let i = 1; i < entries.length; i++) {
    acc = mergeOutboxEntries(acc, entries[i]!);
  }
  return acc;
}

// =============================================================================
// 3. Internal helpers — shape selection
// =============================================================================

/**
 * Pick the entry whose shape fields (`bundleCid`, `tokenIds`, `recipient`,
 * `recipientTransportPubkey`, `mode`, `deliveryMethod`) seed the merged
 * record. Shape fields describe the bundle and SHOULD agree across
 * replicas; this helper handles divergence (writer-bug or partial-state
 * propagation) deterministically.
 *
 * Algorithm:
 *
 *   1. If `statusMerge.winner === 'override'`, pick the side whose
 *      status is `'finalizing'` (Rule 2 override stickiness — the
 *      `overrideApplied` flag is set-OR-merged so it may live on the
 *      `failed-permanent` side, but the canonical winner of the arc is
 *      the `finalizing` replica regardless).
 *   2. If the two sides differ in lifecycle (status, lamport, or
 *      override flag), the status-merge winner side carries the
 *      canonical view — return it.
 *   3. Otherwise the two sides are lifecycle-equivalent; fall through
 *      to a content-stable tiebreak that is invariant under input swap:
 *      lex-min `bundleCid`, then lex-min `recipient`, then lex-min over
 *      JSON-stringified `tokenIds`.
 *
 * The content-stable tiebreak is what makes shape fields commutative
 * across `merge(a, b)` vs `merge(b, a)` when both replicas describe the
 * same outbox entry but disagree on shape (a writer bug). Without it,
 * the position-based `winner = 'a'` from the per-partition tie-breakers
 * (e.g., `mergeBothSoftTerminal`) would silently pick whichever side
 * happened to be passed first — non-commutative.
 */
function pickWinnerEntryForShape(
  a: UxfTransferOutboxEntry,
  b: UxfTransferOutboxEntry,
  winner: 'a' | 'b' | 'override',
): UxfTransferOutboxEntry {
  if (winner === 'override') {
    // Two sub-arcs of the override winner now exist (post-Round-3):
    //
    //  1. **Original Rule 2 stickiness arc** —
    //     `(failed-permanent, finalizing)` with set-OR override flag.
    //     Exactly one side is `finalizing`; pick that side. This branch
    //     was the only override case before Round 3.
    //
    //  2. **Revival arc** (steelman crit #12 + Round 3 expired
    //     extension) — neither current side is `finalizing` (both are
    //     `failed-permanent`, both are `expired`, or one of each), but
    //     the multiset has historically contained `finalizing` (sticky
    //     `everFinalizing` flag) AND the override flag is set. The
    //     merged status is revived to `finalizing` even though no input
    //     side carries that status currently.
    //
    // For sub-arc 1, picking the `finalizing` side is canonical and
    // commutative (whichever side is `finalizing` is the same regardless
    // of input order). The original implementation
    // `a.status === 'finalizing' ? a : b` works for that sub-arc.
    //
    // For sub-arc 2, NEITHER side is `finalizing`, so the original
    // `? a : b` fallthrough returns `b` always — a position-based pick
    // that is NOT commutative across input swap. Round 2 reproducer:
    //   merge(A=failed-permanent+ovr+ever, B=failed-permanent+ovr+ever)
    //   .recipient = 'DIRECT://b' but
    //   merge(B, A).recipient = 'DIRECT://a' — non-commutative!
    //
    // Round 3 fix: detect sub-arc 2 explicitly. When the override winner
    // fired but neither current side is `finalizing`, fall back to the
    // swap-stable content tiebreak (the same one used for same-status
    // sibling cases) so the shape pick is invariant under input order.
    if (a.status === 'finalizing' && b.status !== 'finalizing') return a;
    if (b.status === 'finalizing' && a.status !== 'finalizing') return b;
    // Sub-arc 2 OR a hypothetical dual-`finalizing` (which today falls
    // through to the standard active-vs-active rule and would not produce
    // `winner === 'override'`, but the symmetric tiebreak handles it
    // safely if a future spec revision routes it here).
    return pickShapeBySwapStableTiebreak(a, b);
  }
  // For 'a' / 'b' winner: ONLY when the two sides have different statuses
  // is the winner content-determined (the partition lattice and hard-
  // terminal/active rules pick deterministically by status content). In
  // every other case the per-partition tie-breakers
  // (`mergeBothSoftTerminal` / `mergeBothActive` / `mergeBothHardTerminal`)
  // intentionally drop Lamport for associativity (see those functions'
  // doc-comments) and fall through to lex-min `id`. With both replicas
  // sharing the same `id` (the orchestrator rejects mismatched ids),
  // that tie-breaker reduces to "return 'a'" — which IS position-based
  // and would flip shape selection under input swap.
  //
  // To keep shape commutative, we use the position-based winner ONLY
  // when statuses differ; for same-status pairs we apply a content-
  // stable tiebreak (lex-min `bundleCid` → lex-min `recipient` →
  // lex-min `tokenIds`) that is invariant under input order.
  if (a.status !== b.status) {
    return winner === 'a' ? a : b;
  }
  // Same status; position-based winner is non-commutative. Fall back to
  // content-stable tiebreak.
  return pickShapeBySwapStableTiebreak(a, b);
}

/**
 * Content-stable shape tiebreak (steelman crit #14 — full chain extension):
 *
 *   lex-min `bundleCid` → lex-min `recipient` → lex-min canonical-join of
 *   `tokenIds` → lex-min `recipientTransportPubkey` → lex-min
 *   `deliveryMethod` → lex-min `mode`.
 *
 * Returns whichever input — `a` or `b` — is "smaller" by the full chain.
 * The chain is total (every field is required per
 * `UxfTransferOutboxEntry`'s schema) and order-independent (`min(x, y)`
 * is the same function regardless of which arg is first), so the
 * resulting shape is invariant under input swap.
 *
 * **Why the full chain.** The orchestrator (this module) reads `recipient`,
 * `recipientTransportPubkey`, `tokenIds`, `bundleCid`, `deliveryMethod`,
 * AND `mode` from the chosen `winnerEntry`. If the tiebreak chain stopped
 * at `bundleCid → recipient → tokenIds`, two same-status entries that
 * agree on those three fields but disagree on the trailing three would
 * have been picked position-based by the previous implementation —
 * non-commutative. The extension here covers every shape field the
 * orchestrator reads from the winner side, restoring full swap-stability.
 *
 * **Canonical join for tokenIds**: sort then JSON-stringify. The sort makes
 * the comparison invariant under the original list ordering; the JSON
 * encoding is a deterministic stable encoding of the array shape.
 *
 * **"Fully tied"** means every field in the extended chain is identical
 * across both inputs. In that case `a` and `b` project the same content
 * for every shape field the orchestrator reads, so the choice between
 * returning `a` or `b` is observationally irrelevant.
 */
function pickShapeBySwapStableTiebreak(
  a: UxfTransferOutboxEntry,
  b: UxfTransferOutboxEntry,
): UxfTransferOutboxEntry {
  if (a.bundleCid !== b.bundleCid) return a.bundleCid < b.bundleCid ? a : b;
  if (a.recipient !== b.recipient) return a.recipient < b.recipient ? a : b;
  const aTokenIds = JSON.stringify([...a.tokenIds].sort());
  const bTokenIds = JSON.stringify([...b.tokenIds].sort());
  if (aTokenIds !== bTokenIds) return aTokenIds < bTokenIds ? a : b;
  if (a.recipientTransportPubkey !== b.recipientTransportPubkey) {
    return a.recipientTransportPubkey < b.recipientTransportPubkey ? a : b;
  }
  if (a.deliveryMethod !== b.deliveryMethod) {
    return a.deliveryMethod < b.deliveryMethod ? a : b;
  }
  if (a.mode !== b.mode) {
    return a.mode < b.mode ? a : b;
  }
  return a;
}

// Re-export the audit_promoted_from helper at the orchestrator's import
// surface for ergonomic use by manifest-store / tests.
void mergeAuditPromotedFrom; // referenced for re-export above; suppress
                             // TS6133 in case strict linting flares.
