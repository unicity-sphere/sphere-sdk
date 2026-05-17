/**
 * UXF Inter-Wallet Transfer — Outbox state-machine validator (T.6.C)
 *
 * Validates every {@link UxfTransferOutboxEntry} `status` transition against
 * the canonical §7.0 transition table. Throws
 * {@link SphereError | INVALID_OUTBOX_TRANSITION} on any disallowed move.
 *
 * Used by {@link OutboxWriter.update} as a gate in front of every persist
 * call so that disallowed transitions never reach disk. The transition
 * table here is the SINGLE source of truth — no ad-hoc checks elsewhere.
 *
 * **§7.0 table** (verbatim from `docs/uxf/UXF-TRANSFER-PROTOCOL.md`):
 *
 * ```
 * Initial: packaging
 *
 *   packaging  ──pin/encode complete──► [pinned]   (UXF cid-mode only)
 *   packaging  ──serialize complete───► sending    (UXF car-mode + TXF)
 *   pinned     ──ipfs pin acknowledged─► sending
 *   pinned     ──publish-dispatch fails─► failed-transient
 *   pinned     ──permanent pin failure ─► failed-permanent  (T.4.A; see arc-level doc)
 *
 *   sending    ──Nostr publish ack ────► delivered          (conservative)
 *   sending    ──Nostr publish ack ────► delivered-instant  (instant)
 *   sending    ──publish error ────────► failed-transient
 *
 *   delivered           ──retention window expires─► expired
 *   delivered-instant   ──worker starts────────────► finalizing
 *   finalizing          ──all proofs attached────► finalized
 *   finalizing          ──any tx hard-fail ────► failed-permanent
 *   finalizing          ──transient budget ────► failed-transient
 *
 *   failed-transient ──manual retry────► sending
 *   failed-transient ──cap ────────────► failed-permanent
 *   failed-permanent ──importInclusionProof ack► finalizing
 *                                                (operator override only)
 *
 *   finalized       ──retention window expires► expired
 *   expired         (terminal)
 *   failed-permanent (terminal except via override)
 * ```
 *
 * **W43 dual-write (§7.B / §7.0)** — formalized arc for the T.6.D legacy
 * migration window. The §7.B paragraph is short on detail, so this module
 * implements the most defensible semantics consistent with the impl plan:
 *
 *   - `legacy ↔ uxf` is a SCHEMA-MODE arc (which on-disk shape is being
 *     written), NOT a per-entry status. The 10 canonical
 *     {@link UxfOutboxStatus} values are the only legal `status` strings.
 *   - The arc is gated by an explicit `dualWriteEnabled: true` flag set by
 *     the caller (typically threaded from `features.outbox === 'dual-write'`
 *     per `Sphere.init`).
 *   - When the flag is false (default), the validator REJECTS any
 *     {@link DualWriteArc} attempt with `INVALID_OUTBOX_TRANSITION` /
 *     `dual-write-disabled` — outside the migration window, the legacy and
 *     uxf shapes do not coexist on disk for the same entry.
 *   - When the flag is true, both arcs (`legacy → uxf` and `uxf → legacy`)
 *     are allowed; the migration writer (T.6.D) ratchets forward, and the
 *     restore tool (T.6.D.2) ratchets backward.
 *
 * If a future spec revision tightens the arc semantics (e.g. allow only
 * forward `legacy → uxf` once the migration is in flight), revisit this
 * module. T.6.D landed both arcs as documented; the post-cutover follow-up
 * may narrow this once the dual-write window closes.
 *
 * @module profile/outbox-state-machine
 *
 * @see docs/uxf/UXF-TRANSFER-PROTOCOL.md   §7.0 (canonical transition table)
 * @see docs/uxf/UXF-TRANSFER-IMPL-PLAN.md  §7.B (W43 dual-write mode)
 * @see profile/outbox-writer.ts            (consumer — `update()` gate)
 * @see types/uxf-outbox.ts                 (status enum + partition)
 */

import { SphereError } from '../core/errors.js';
import {
  isUxfOutboxStatus,
  partitionStatus,
  type UxfOutboxStatus,
} from '../types/uxf-outbox.js';

// =============================================================================
// 1. Public types — transition table rows + validator I/O
// =============================================================================

/**
 * Side-channel condition that gates an otherwise-disallowed arc.
 *
 *  - `'unconditional'` — the arc is ALWAYS allowed when matched by
 *    `(from, to)`; no extra context required.
 *  - `'override'`      — the arc is allowed only when the caller passes
 *    `overrideApplied: true` in the same write. Used for the operator
 *    escape-hatch `failed-permanent → finalizing` per §7.0 (set by
 *    `payments.importInclusionProof()` per §6.3).
 *  - `'dual-write'`    — the arc is allowed only when the caller passes
 *    `dualWriteEnabled: true`. Used for the W43 schema-mode arcs during
 *    the T.6.D migration window. NOT a per-entry status transition;
 *    see {@link DualWriteArc}.
 */
export type TransitionCondition =
  | { readonly kind: 'unconditional' }
  | { readonly kind: 'override' }
  | { readonly kind: 'dual-write' };

/**
 * One row of the §7.0 transition table.
 *
 * @remarks
 * The table is canonical — adding a row here implicitly extends the legal
 * state machine. Reviewers MUST cross-reference `UXF-TRANSFER-PROTOCOL §7.0`
 * for every change. The full table is asserted by
 * `tests/unit/profile/outbox-state-machine.test.ts` (every legal arc) and
 * the dual-write extension by
 * `tests/unit/profile/outbox-state-machine-dual-write.test.ts` (W43).
 */
export interface AllowedTransition {
  readonly from: UxfOutboxStatus;
  readonly to: UxfOutboxStatus;
  readonly condition: TransitionCondition;
}

/**
 * Validation context for a candidate transition.
 *
 * @remarks
 * `overrideApplied` and `dualWriteEnabled` are independent side channels;
 * their truthiness is meaningful only for arcs whose `condition` matches
 * the corresponding kind. Setting `overrideApplied: true` on an
 * unconditional arc is harmless (ignored).
 */
export interface ValidationContext {
  readonly from: UxfOutboxStatus;
  readonly to: UxfOutboxStatus;
  /** Set by the writer when applying the `failed-permanent → finalizing`
   *  override per §7.0 / §6.3. Defaults to `false`. */
  readonly overrideApplied?: boolean;
  /** Set by the writer when running under `features.outbox === 'dual-write'`
   *  during the T.6.D migration window. Defaults to `false`. */
  readonly dualWriteEnabled?: boolean;
}

/**
 * Result of {@link validateTransition}. Failure form carries a forensic
 * `reason` string and a structured `code` so the writer can re-throw with
 * a typed cause without re-parsing the message.
 */
export type ValidationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'no-such-arc' | 'override-required' | 'dual-write-disabled';
      readonly reason: string;
    };

// =============================================================================
// 2. W43 dual-write — schema-mode arc type
// =============================================================================

/**
 * Schema-mode marker for the W43 dual-write arcs.
 *
 *  - `'legacy'` — pre-T.6.A `OutboxEntry` shape (`types/txf.ts`); persisted
 *    in the legacy `_outbox` array.
 *  - `'uxf'`    — `UxfTransferOutboxEntry` shape (T.6.A); persisted at
 *    `${addr}.outbox.${id}` per-entry keys.
 *
 * NOT a per-entry {@link UxfOutboxStatus} — it discriminates which on-disk
 * shape the writer is currently emitting for a given entry id.
 */
export type OutboxSchemaMode = 'legacy' | 'uxf';

/**
 * The two W43 schema-mode arcs (§7.B). Both directions are gated by
 * `dualWriteEnabled: true`.
 *
 *  - `'legacy → uxf'` — forward migration; written by T.6.D.
 *  - `'uxf → legacy'` — backward restore; written by T.6.D.2's restore tool.
 */
export interface DualWriteArc {
  readonly from: OutboxSchemaMode;
  readonly to: OutboxSchemaMode;
}

/** Validation context for a {@link DualWriteArc}. */
export interface DualWriteValidationContext {
  readonly from: OutboxSchemaMode;
  readonly to: OutboxSchemaMode;
  readonly dualWriteEnabled?: boolean;
}

// =============================================================================
// 3. ALLOWED_TRANSITIONS — canonical §7.0 table
// =============================================================================

/**
 * The canonical §7.0 status-transition table.
 *
 * @remarks
 * Adding/removing rows here is a SPEC CHANGE. The accompanying unit test
 * `tests/unit/profile/outbox-state-machine.test.ts` walks every row to
 * gate spec drift.
 *
 * Self-loops (e.g. `delivered → delivered`) are NOT in the table — they
 * have no operational meaning and would mask writer bugs (re-asserting the
 * same status on every poll). Callers that need an idempotent re-write
 * should call the writer's `write()` directly without going through
 * `update()`'s validator hook.
 */
export const ALLOWED_TRANSITIONS: ReadonlyArray<AllowedTransition> = [
  // packaging → ...
  { from: 'packaging', to: 'pinned', condition: { kind: 'unconditional' } },
  { from: 'packaging', to: 'sending', condition: { kind: 'unconditional' } },

  // pinned → ...
  { from: 'pinned', to: 'sending', condition: { kind: 'unconditional' } },
  { from: 'pinned', to: 'failed-transient', condition: { kind: 'unconditional' } },
  // T.4.A — permanent pin failure short-circuit. The orchestrator transitions
  // `packaging → pinned` eagerly (when about to call IPFS pin) so that on a
  // hard pin failure the entry can be moved straight to `failed-permanent`
  // without spuriously claiming success. Spec §3.3.2 paragraph (pin
  // permanently fails → `failed-permanent`); reflected in the impl plan
  // T.4.A acceptance ("pinned → failed-permanent"). Nostr publish MUST NOT
  // happen if pin fails — the orchestrator skips the publish on this arc.
  { from: 'pinned', to: 'failed-permanent', condition: { kind: 'unconditional' } },

  // sending → ...
  { from: 'sending', to: 'delivered', condition: { kind: 'unconditional' } },
  { from: 'sending', to: 'delivered-instant', condition: { kind: 'unconditional' } },
  { from: 'sending', to: 'failed-transient', condition: { kind: 'unconditional' } },

  // delivered → expired (retention window)
  { from: 'delivered', to: 'expired', condition: { kind: 'unconditional' } },
  // delivered → sending (OUTBOX-SEND-FOLLOWUPS item #2 — retention re-publish)
  //
  // The NostrPersistenceVerifier observes that a previously-delivered
  // bundle is no longer retained on the relay. To re-arm the
  // SendingRecoveryWorker for a re-publish without inventing a new
  // status, the verifier transitions the live OUTBOX entry back to
  // `'sending'`. The original SENT-ledger entry remains the durable
  // record of the historical delivery; the recipient's replay-LRU
  // dedupes any extra publish by `bundleCid`.
  { from: 'delivered', to: 'sending', condition: { kind: 'unconditional' } },

  // delivered-instant → finalizing (worker starts)
  { from: 'delivered-instant', to: 'finalizing', condition: { kind: 'unconditional' } },
  // delivered-instant → sending (OUTBOX-SEND-FOLLOWUPS item #2 — retention re-publish)
  //
  // Symmetric to `delivered → sending`, applied when the verifier
  // observes a retention drop on an instant-mode entry that has not
  // yet finalized. The recovery worker republishes; on success the
  // entry returns to `'delivered-instant'` and the finalization flow
  // resumes from there.
  { from: 'delivered-instant', to: 'sending', condition: { kind: 'unconditional' } },

  // finalizing → ...
  { from: 'finalizing', to: 'finalized', condition: { kind: 'unconditional' } },
  { from: 'finalizing', to: 'failed-permanent', condition: { kind: 'unconditional' } },
  { from: 'finalizing', to: 'failed-transient', condition: { kind: 'unconditional' } },

  // failed-transient → ... (retry / cap)
  { from: 'failed-transient', to: 'sending', condition: { kind: 'unconditional' } },
  { from: 'failed-transient', to: 'failed-permanent', condition: { kind: 'unconditional' } },

  // failed-permanent → finalizing (operator escape-hatch override only)
  { from: 'failed-permanent', to: 'finalizing', condition: { kind: 'override' } },

  // finalized → expired (retention window)
  { from: 'finalized', to: 'expired', condition: { kind: 'unconditional' } },

  // expired — TERMINAL (no outgoing arcs)
  // failed-permanent — TERMINAL except via the override row above
];

// =============================================================================
// 4. Public API — validateTransition / assertTransition
// =============================================================================

/**
 * Pure-function validator. Returns the structured result without throwing.
 * Useful for callers that need to inspect failures (UI hints, logging)
 * before deciding whether to surface a typed error.
 *
 * @remarks
 * Defensive on input: rejects unknown status strings up front rather than
 * relying on the table miss — the snapshot test for {@link UXF_OUTBOX_STATUSES}
 * locks the canonical 10, but a caller with a corrupt entry should still
 * see a clear rejection rather than a silent table-miss.
 */
export function validateTransition(ctx: ValidationContext): ValidationResult {
  if (!isUxfOutboxStatus(ctx.from)) {
    return {
      ok: false,
      code: 'no-such-arc',
      reason: `INVALID_OUTBOX_TRANSITION: from-status "${String(ctx.from)}" is not a canonical UxfOutboxStatus`,
    };
  }
  if (!isUxfOutboxStatus(ctx.to)) {
    return {
      ok: false,
      code: 'no-such-arc',
      reason: `INVALID_OUTBOX_TRANSITION: to-status "${String(ctx.to)}" is not a canonical UxfOutboxStatus`,
    };
  }

  // Self-loop rule: the table never contains `from === to`. Surface a clear
  // rejection rather than relying on the empty match.
  if (ctx.from === ctx.to) {
    return {
      ok: false,
      code: 'no-such-arc',
      reason: `INVALID_OUTBOX_TRANSITION: ${ctx.from} → ${ctx.to} (self-loop is not a legal status transition)`,
    };
  }

  const row = ALLOWED_TRANSITIONS.find(
    (r) => r.from === ctx.from && r.to === ctx.to,
  );
  if (!row) {
    return {
      ok: false,
      code: 'no-such-arc',
      reason: `INVALID_OUTBOX_TRANSITION: ${ctx.from} → ${ctx.to} (no such arc in §7.0 table)`,
    };
  }

  switch (row.condition.kind) {
    case 'unconditional':
      return { ok: true };
    case 'override':
      if (ctx.overrideApplied === true) return { ok: true };
      return {
        ok: false,
        code: 'override-required',
        reason: `INVALID_OUTBOX_TRANSITION: ${ctx.from} → ${ctx.to} requires overrideApplied=true (operator escape-hatch per §7.0)`,
      };
    case 'dual-write':
      // No dual-write rows currently exist in the status table — the W43
      // arcs are schema-mode and use validateDualWriteArc(). Kept for
      // forward-compat in case a future spec revision adds a per-status
      // dual-write arc.
      if (ctx.dualWriteEnabled === true) return { ok: true };
      return {
        ok: false,
        code: 'dual-write-disabled',
        reason: `INVALID_OUTBOX_TRANSITION: ${ctx.from} → ${ctx.to} requires dualWriteEnabled=true (§7.B migration window only)`,
      };
  }
}

/**
 * Throwing wrapper around {@link validateTransition}. Used by the writer
 * (`OutboxWriter.update`) so the call site is one-liner-clean.
 *
 * @throws {SphereError} `INVALID_OUTBOX_TRANSITION` with a structured
 *   `cause` carrying `{ from, to, code }` for forensic preservation.
 */
export function assertTransition(ctx: ValidationContext): void {
  const result = validateTransition(ctx);
  if (result.ok) return;
  throw new SphereError(result.reason, 'INVALID_OUTBOX_TRANSITION', {
    from: ctx.from,
    to: ctx.to,
    code: result.code,
  });
}

// =============================================================================
// 5. W43 dual-write — schema-mode arc validators
// =============================================================================

/**
 * The two W43 dual-write arcs. Both gated by `dualWriteEnabled: true`.
 *
 * Self-loops (`legacy → legacy` and `uxf → uxf`) are NOT arcs — they have
 * no operational meaning. Reject as `no-such-arc` so the migration writer
 * surfaces a clear error if it accidentally fires a no-op write under the
 * dual-write API path.
 */
export const ALLOWED_DUAL_WRITE_ARCS: ReadonlyArray<DualWriteArc> = [
  { from: 'legacy', to: 'uxf' },
  { from: 'uxf', to: 'legacy' },
];

/**
 * Validate a W43 schema-mode {@link DualWriteArc}.
 *
 * @remarks
 * Distinct from {@link validateTransition} because the `from`/`to` here are
 * `OutboxSchemaMode` values (`'legacy'` | `'uxf'`), NOT
 * {@link UxfOutboxStatus} values. Trying to overload the status validator
 * for both would force callers to distinguish the kinds at the call site
 * anyway — a separate function is clearer and keeps the two tables
 * orthogonal.
 */
export function validateDualWriteArc(
  ctx: DualWriteValidationContext,
): ValidationResult {
  // Defensive on input — schema-mode literals are tightly typed but a
  // caller threading user-controlled features.outbox could fall through.
  const isMode = (v: unknown): v is OutboxSchemaMode =>
    v === 'legacy' || v === 'uxf';

  if (!isMode(ctx.from)) {
    return {
      ok: false,
      code: 'no-such-arc',
      reason: `INVALID_OUTBOX_TRANSITION: dual-write from "${String(ctx.from)}" is not a recognized schema mode`,
    };
  }
  if (!isMode(ctx.to)) {
    return {
      ok: false,
      code: 'no-such-arc',
      reason: `INVALID_OUTBOX_TRANSITION: dual-write to "${String(ctx.to)}" is not a recognized schema mode`,
    };
  }
  if (ctx.from === ctx.to) {
    return {
      ok: false,
      code: 'no-such-arc',
      reason: `INVALID_OUTBOX_TRANSITION: dual-write self-loop ${ctx.from} → ${ctx.to} is not a legal arc`,
    };
  }

  const exists = ALLOWED_DUAL_WRITE_ARCS.some(
    (a) => a.from === ctx.from && a.to === ctx.to,
  );
  if (!exists) {
    // Unreachable given the defensive checks above, but kept so future
    // additions to OutboxSchemaMode don't bypass the table.
    return {
      ok: false,
      code: 'no-such-arc',
      reason: `INVALID_OUTBOX_TRANSITION: dual-write ${ctx.from} → ${ctx.to} is not a recognized arc`,
    };
  }

  if (ctx.dualWriteEnabled !== true) {
    return {
      ok: false,
      code: 'dual-write-disabled',
      reason: `INVALID_OUTBOX_TRANSITION: dual-write ${ctx.from} → ${ctx.to} requires dualWriteEnabled=true (§7.B migration window only — outside the migration window, schema modes do not coexist for the same entry)`,
    };
  }
  return { ok: true };
}

/**
 * Throwing wrapper around {@link validateDualWriteArc}. Mirrors
 * {@link assertTransition} for symmetric call-site ergonomics.
 */
export function assertDualWriteArc(ctx: DualWriteValidationContext): void {
  const result = validateDualWriteArc(ctx);
  if (result.ok) return;
  throw new SphereError(result.reason, 'INVALID_OUTBOX_TRANSITION', {
    from: ctx.from,
    to: ctx.to,
    code: result.code,
    schemaMode: true,
  });
}

// =============================================================================
// 6. Re-exports for callers — one-import surface
// =============================================================================

export { isUxfOutboxStatus, partitionStatus };
export type { UxfOutboxStatus };
