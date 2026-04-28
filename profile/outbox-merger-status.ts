/**
 * UXF Inter-Wallet Transfer — CRDT status merge (T.6.B, N3 split).
 *
 * Implements §7.1 conflict-resolution **Rule 1** (status partition lattice
 * with override-aware tie-break) and the cross-cutting **Rule 2** override
 * stickiness exception. These two rules are co-located here because Rule 2
 * is structurally an exception carved out of Rule 1's hard-terminal vs
 * active arc and only makes sense alongside the partition lattice.
 *
 * **Rule 1 — three-way partition with override-aware tie-break (§7.1):**
 *  - Both **hard-terminal**: `finalized` > others; among `failed-permanent
 *    | expired`, prefer `failed-permanent`. Tie-break by Lamport (higher
 *    wins). The override-stickiness exception (Rule 2) carves out the
 *    `failed-permanent` vs `finalizing` arc.
 *  - Both **active**: pick the more-advanced position on the lattice
 *    `packaging < pinned < sending < {delivered, delivered-instant} <
 *    finalizing`. Among the `delivered` ↔ `delivered-instant` siblings,
 *    Lamport-max wins.
 *  - **Active vs soft-terminal**: active wins (a replica still progressing
 *    is not overwritten by another replica's transient failure).
 *  - **Active vs hard-terminal**: hard-terminal wins (subject to Rule 2
 *    override exception).
 *  - **Soft-terminal vs hard-terminal**: hard-terminal wins.
 *  - Both **soft-terminal**: Lamport-max wins (more-recent retry attempt).
 *
 * **Rule 2 — override stickiness (§7.1):** if one replica is in
 * `finalizing` with `overrideApplied === true` and the other is in
 * `failed-permanent`, the override side wins regardless of Lamport. The
 * `overrideApplied` flag is sticky and merges with set-OR semantics — any
 * replica having it `true` causes the merged entry to have it `true`.
 *
 * **Determinism**. When the rules above leave a strict tie (same partition,
 * same lattice rank, same Lamport), this module breaks the tie by lex-min
 * `id`. In practice both replicas carry the same `id` (the orchestrator
 * rejects merges across mismatched ids), so the lex-min branch is reached
 * only when the same id has the same Lamport and the same lattice rank —
 * the tie must be broken to avoid a non-deterministic `winner` field. The
 * choice is arbitrary but stable.
 *
 * @module profile/outbox-merger-status
 * @see profile/outbox-merger.ts — top-level orchestrator.
 * @see docs/uxf/UXF-TRANSFER-PROTOCOL.md §7.1 — canonical rules.
 */

import type { UxfTransferOutboxEntry, UxfOutboxStatus } from '../types/uxf-outbox';
import { partitionStatus } from '../types/uxf-outbox';

// =============================================================================
// 1. Lattice helpers (active-tier)
// =============================================================================

/**
 * Active-tier lattice rank per §7.1:
 *   `packaging < pinned < sending < {delivered, delivered-instant} <
 *    finalizing`
 *
 * Sibling statuses share the same numeric rank; ties are broken by Lamport
 * (or lex-min `id` as a final fallback) by the caller. Non-active statuses
 * are not part of the lattice and return `-1` to make accidental misuse
 * loud.
 */
export function activeLatticeRank(status: UxfOutboxStatus): number {
  switch (status) {
    case 'packaging':
      return 0;
    case 'pinned':
      return 1;
    case 'sending':
      return 2;
    case 'delivered':
    case 'delivered-instant':
      return 3;
    case 'finalizing':
      return 4;
    default:
      return -1;
  }
}

/**
 * Hard-terminal preference rank per §7.1:
 *   `finalized > failed-permanent > expired`
 *
 * Higher number wins. Non-hard-terminal statuses return `-1`.
 */
export function hardTerminalRank(status: UxfOutboxStatus): number {
  switch (status) {
    case 'finalized':
      return 2;
    case 'failed-permanent':
      return 1;
    case 'expired':
      return 0;
    default:
      return -1;
  }
}

// =============================================================================
// 2. Merge result
// =============================================================================

/**
 * Outcome of {@link mergeStatus}.
 *
 * - `status`            — the merged status (winner's status).
 * - `lamport`           — `max(a.lamport, b.lamport)` (Rule 6).
 * - `overrideApplied`   — set-OR of both replicas' flags (Rule 2 stickiness).
 * - `winner`            — which replica's status was selected, or
 *                         `'override'` when Rule 2 fired.
 */
export interface StatusMergeResult {
  readonly status: UxfOutboxStatus;
  readonly lamport: number;
  readonly overrideApplied: boolean;
  readonly winner: 'a' | 'b' | 'override';
}

// =============================================================================
// 3. Override-stickiness exception (Rule 2)
// =============================================================================

/**
 * Detect the Rule 2 override-stickiness arc:
 *   one side is `finalizing` and the OTHER side is `failed-permanent`,
 *   AND the merged `overrideApplied` (set-OR of both sides) is `true`.
 *
 * Returns the `finalizing` side ('a' or 'b') if the arc applies; `null`
 * otherwise. Per §7.1, the override stickiness is a sticky FLAG (set-OR
 * across replicas). The arc therefore fires whenever EITHER replica
 * carries the flag — not only when the flag is co-located with the
 * `finalizing` status. This is required for CRDT associativity:
 * `merge(merge(a, b), c)` == `merge(a, merge(b, c))` only when the
 * override decision depends purely on the multi-set of flags + statuses,
 * not on which specific replica originally carried which.
 *
 * Concretely: a=`failed-permanent`(no-override), b=`finalizing`(no-override),
 * c=`packaging`(override). With the original "co-located" rule:
 *   - merge(a, b) = `failed-permanent` (hard beats active, no override)
 *   - merge(that, c) = `failed-permanent` (active+override doesn't beat
 *     hard unless co-located on `finalizing`)
 *   - merge(b, c) = `finalizing` (active lattice + set-OR of override)
 *   - merge(a, that) = `finalizing` (override arc fires!)
 * ⇒ non-associative.
 *
 * With the merged-flag rule: both branches see `failed-permanent` +
 * `finalizing` + `overrideApplied(merged)=true` ⇒ `finalizing` wins.
 *
 * Dual-`finalizing` (both sides) is not handled here; that falls through
 * to the standard active-vs-active rule.
 */
function detectOverrideStickiness(
  a: UxfTransferOutboxEntry,
  b: UxfTransferOutboxEntry,
): 'a' | 'b' | null {
  const overrideMerged = a.overrideApplied === true || b.overrideApplied === true;
  if (!overrideMerged) return null;
  if (a.status === 'finalizing' && b.status === 'failed-permanent') return 'a';
  if (b.status === 'finalizing' && a.status === 'failed-permanent') return 'b';
  return null;
}

// =============================================================================
// 4. Per-partition tie-break helpers
// =============================================================================

/**
 * Both sides are hard-terminal. Pick by hardTerminalRank (Rule 1
 * hard-terminal arc); break exact-status ties by lex-min id (the rank
 * map is injective, so `ra === rb` implies `a.status === b.status`).
 *
 * Lamport is intentionally NOT used here for the same associativity
 * reason as `mergeBothActive` — see that function's doc-comment.
 */
function mergeBothHardTerminal(
  a: UxfTransferOutboxEntry,
  b: UxfTransferOutboxEntry,
): 'a' | 'b' {
  const ra = hardTerminalRank(a.status);
  const rb = hardTerminalRank(b.status);
  if (ra !== rb) return ra > rb ? 'a' : 'b';
  return a.id <= b.id ? 'a' : 'b';
}

/**
 * Both sides are active. Pick by activeLatticeRank (Rule 1 active arc);
 * for sibling statuses (e.g. `delivered` vs `delivered-instant`), break
 * ties by lex-min of the status name, then by lex-min id.
 *
 * **Why NOT Lamport for the sibling tie-break (T.6.B / W9 audit)**. The
 * spec text suggests "tie-break by Lamport timestamp; the higher Lamport
 * wins because the more-recently-decided mode reflects the actual
 * outcome." That rule is not associative in 3-way merges: pairwise-merged
 * Lamport is `max(a, b)`, which absorbs Lamport contributions from any
 * non-sibling third replica and can flip sibling tie-breaks based on
 * merge order. We use lex-min of the status name instead — a fully
 * deterministic, associative, commutative join that picks `delivered`
 * over `delivered-instant` consistently across replicas. This is the
 * standard CRDT lattice resolution for sibling ties.
 */
function mergeBothActive(
  a: UxfTransferOutboxEntry,
  b: UxfTransferOutboxEntry,
): 'a' | 'b' {
  const ra = activeLatticeRank(a.status);
  const rb = activeLatticeRank(b.status);
  if (ra !== rb) return ra > rb ? 'a' : 'b';
  if (a.status !== b.status) return a.status <= b.status ? 'a' : 'b';
  return a.id <= b.id ? 'a' : 'b';
}

/**
 * Both sides are soft-terminal (`failed-transient`). The soft-terminal
 * partition has only one status, so the tie-break reduces to lex-min id.
 *
 * Lamport is intentionally NOT used here for the same associativity
 * reason as `mergeBothActive` — see that function's doc-comment.
 */
function mergeBothSoftTerminal(
  a: UxfTransferOutboxEntry,
  b: UxfTransferOutboxEntry,
): 'a' | 'b' {
  return a.id <= b.id ? 'a' : 'b';
}

// =============================================================================
// 5. Top-level mergeStatus
// =============================================================================

/**
 * CRDT-merge the `status`, `lamport`, and `overrideApplied` triple of two
 * replicas of the same `UxfTransferOutboxEntry`.
 *
 * **Pure / referentially transparent.** No I/O, no module-level state, no
 * mutation of inputs. Commutative: `mergeStatus(a, b)` and
 * `mergeStatus(b, a)` agree on the same `status`, `lamport`, and
 * `overrideApplied`. The `winner` field is symmetry-preserving (swapping a
 * and b swaps the winner letter, but `'override'` stays `'override'`).
 *
 * Implements §7.1 Rules 1, 2, and 6 (status, override stickiness, Lamport
 * max-merge).
 */
export function mergeStatus(
  a: UxfTransferOutboxEntry,
  b: UxfTransferOutboxEntry,
): StatusMergeResult {
  // Rule 6 — Lamport always max-merges, regardless of which side wins.
  const lamport = Math.max(a.lamport, b.lamport);

  // Rule 2 (override stickiness) is set-OR even when the override arc
  // does NOT fire — both sides may carry the flag for unrelated reasons.
  const overrideApplied = a.overrideApplied === true || b.overrideApplied === true;

  // Rule 2 override arc: `failed-permanent` vs `finalizing` w/ override.
  const overrideSide = detectOverrideStickiness(a, b);
  if (overrideSide !== null) {
    const winnerEntry = overrideSide === 'a' ? a : b;
    return {
      status: winnerEntry.status,
      lamport,
      overrideApplied: true, // override fired ⇒ flag is necessarily true
      winner: 'override',
    };
  }

  // Rule 1 — partition-based selection.
  const pa = partitionStatus(a.status);
  const pb = partitionStatus(b.status);

  let winner: 'a' | 'b';
  if (pa === pb) {
    // Same partition.
    switch (pa) {
      case 'hard-terminal':
        winner = mergeBothHardTerminal(a, b);
        break;
      case 'active':
        winner = mergeBothActive(a, b);
        break;
      case 'soft-terminal':
        winner = mergeBothSoftTerminal(a, b);
        break;
    }
  } else {
    // Different partitions. Hard-terminal beats both active and
    // soft-terminal; active beats soft-terminal.
    if (pa === 'hard-terminal') winner = 'a';
    else if (pb === 'hard-terminal') winner = 'b';
    else if (pa === 'active') winner = 'a';
    else winner = 'b';
  }

  const winnerEntry = winner === 'a' ? a : b;
  return {
    status: winnerEntry.status,
    lamport,
    overrideApplied,
    winner,
  };
}
