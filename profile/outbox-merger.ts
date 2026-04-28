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
  const winnerEntry =
    statusMerge.winner === 'a'
      ? a
      : statusMerge.winner === 'b'
        ? b
        : a.status === 'finalizing' && a.overrideApplied === true
          ? a
          : b;

  // recipientNametag may be unset on one side; carry-through if either
  // side has it (informational, UI-only).
  const recipientNametag = winnerEntry.recipientNametag ?? a.recipientNametag ?? b.recipientNametag;
  const memo = winnerEntry.memo ?? a.memo ?? b.memo;

  // Deadlines come from the winner; if missing there but present on the
  // other side, carry-through (deadlines are monotonic — set once by the
  // worker — and either side may legitimately know them first).
  const retryDeadline = winnerEntry.retryDeadline ?? a.retryDeadline ?? b.retryDeadline;
  const pollingDeadline = winnerEntry.pollingDeadline ?? a.pollingDeadline ?? b.pollingDeadline;

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
    ...(errorMerge.error !== undefined ? { error: errorMerge.error } : {}),
    submitRetryCount: errorMerge.submitRetryCount,
    proofErrorCount: errorMerge.proofErrorCount,
    ...(retryDeadline !== undefined ? { retryDeadline } : {}),
    ...(pollingDeadline !== undefined ? { pollingDeadline } : {}),
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

// Re-export the audit_promoted_from helper at the orchestrator's import
// surface for ergonomic use by manifest-store / tests.
void mergeAuditPromotedFrom; // referenced for re-export above; suppress
                             // TS6133 in case strict linting flares.
