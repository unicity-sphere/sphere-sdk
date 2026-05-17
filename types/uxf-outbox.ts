/**
 * UXF Inter-Wallet Transfer — UxfTransferOutboxEntry schema (T.6.A)
 *
 * Bundle-grained outbox entry per `docs/uxf/UXF-TRANSFER-PROTOCOL.md` §7.
 * Replaces the per-token legacy `OutboxEntry` (`types/txf.ts:150`) for UXF
 * transfer modes. Legacy per-token entries continue to be supported via the
 * migration path described in §7.2; readers MUST recognize both shapes during
 * the migration window.
 *
 * **Schema discriminator**. New entries carry `_schemaVersion: 'uxf-1'`;
 * legacy entries lack the field. Sniffers route on this to dispatch to the
 * correct decoder. See {@link isUxfTransferOutboxEntry} and
 * {@link isLegacyOutboxEntry}.
 *
 * **State partition** (per §7.1 — used by the CRDT merger T.6.B):
 *   - active           — worker still progressing
 *   - soft-terminal    — no progress, but could resume (loses to active)
 *   - hard-terminal    — no further worker progress without operator action
 *
 * **Lamport clock**. Every local mutation MUST follow §7.1:
 *   `lamport := max(local, observedRemotes) + 1`
 * The {@link Lamport} clock in `profile/lamport.ts` enforces this rule;
 * `OutboxWriter` in `profile/outbox-writer.ts` is the production wrapper.
 *
 * **Override stickiness**. `overrideApplied: true` is set by
 * `payments.importInclusionProof()` (§6.3). The flag is sticky across merges
 * (set-OR semantics) so a wallet that has performed an operator override
 * keeps the override even if a remote replica's Lamport runs ahead for
 * unrelated reasons.
 *
 * Spec references:
 *  - `docs/uxf/UXF-TRANSFER-PROTOCOL.md` §7    — outbox schema (canonical)
 *  - `docs/uxf/UXF-TRANSFER-PROTOCOL.md` §7.0  — state-transition table
 *  - `docs/uxf/UXF-TRANSFER-PROTOCOL.md` §7.1  — CRDT invariants + override
 *  - `docs/uxf/UXF-TRANSFER-PROTOCOL.md` §7.2  — legacy migration
 *  - `docs/uxf/PROFILE-ARCHITECTURE.md`  §10.12 — storage location (per-entry key)
 *
 * @module types/uxf-outbox
 */

import type { OutboxEntry } from './txf.js';
import {
  MAX_TOKEN_IDS_PER_ENTRY,
  MAX_TOKEN_ID_LENGTH,
  MAX_RECIPIENT_LENGTH,
  MAX_NAMETAG_LENGTH,
  MAX_BUNDLE_CID_LENGTH,
  MAX_MEMO_LENGTH,
  MAX_NOSTR_EVENT_ID_LENGTH,
  MAX_TRANSPORT_PUBKEY_LENGTH,
  MAX_ERROR_LENGTH,
  isWithinOptionalStringLength,
} from './uxf-bounds.js';

// =============================================================================
// 1. Status enumeration — §7 lifecycle states
// =============================================================================

/**
 * Lifecycle status of a {@link UxfTransferOutboxEntry}.
 *
 * The exact 10 strings are stable on-disk; see {@link UXF_OUTBOX_STATUSES}
 * for runtime iteration and the snapshot test for the stability contract.
 *
 * - `packaging`          — building UXF bundle (UXF modes only).
 * - `pinned`             — CAR pinned to IPFS (CID-mode only).
 * - `sending`            — Nostr publish in progress.
 * - `delivered`          — Nostr publish acked (conservative + TXF terminal).
 * - `delivered-instant`  — Nostr publish acked; instant mode awaits finalization.
 * - `finalizing`         — finalization worker running.
 * - `finalized`          — proof attached locally; instant mode terminal.
 * - `failed-transient`   — delivery or finalization failed; retry pending.
 * - `failed-permanent`   — unrecoverable (oracle rejection, race-lost, etc.).
 * - `expired`            — retention window elapsed; entry GC'd.
 */
export type UxfOutboxStatus =
  | 'packaging'
  | 'pinned'
  | 'sending'
  | 'delivered'
  | 'delivered-instant'
  | 'finalizing'
  | 'finalized'
  | 'failed-transient'
  | 'failed-permanent'
  | 'expired';

/**
 * Runtime iteration of every {@link UxfOutboxStatus} value.
 *
 * The snapshot test sorts this array and compares against a hard-coded
 * sorted list of the exact 10 strings — additions, deletions, or renames
 * fail the test, forcing an ADR + on-disk migration plan before the change
 * can land (Note N2 contract pattern).
 */
export const UXF_OUTBOX_STATUSES: ReadonlyArray<UxfOutboxStatus> = [
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
] as const;

/**
 * Three-tier partition used by the CRDT merger (per §7.1):
 *  - `active`         — worker is making progress; should win against
 *                       soft-terminal on merge.
 *  - `soft-terminal`  — no progress, but could resume (`failed-transient`).
 *                       Loses to active states on merge.
 *  - `hard-terminal`  — no further worker progress without operator action.
 *                       Wins against active and soft-terminal (subject to
 *                       the `overrideApplied` exception in §7.1).
 */
export type OutboxStatusPartition = 'active' | 'soft-terminal' | 'hard-terminal';

/**
 * Map a {@link UxfOutboxStatus} to its CRDT-merge partition (per §7.1).
 *
 * Active set:        packaging, pinned, sending, delivered, delivered-instant, finalizing
 * Soft-terminal set: failed-transient
 * Hard-terminal set: expired, finalized, failed-permanent
 */
export function partitionStatus(s: UxfOutboxStatus): OutboxStatusPartition {
  switch (s) {
    case 'packaging':
    case 'pinned':
    case 'sending':
    case 'delivered':
    case 'delivered-instant':
    case 'finalizing':
      return 'active';
    case 'failed-transient':
      return 'soft-terminal';
    case 'finalized':
    case 'failed-permanent':
    case 'expired':
      return 'hard-terminal';
  }
}

/**
 * Runtime guard for {@link UxfOutboxStatus}. Returns true iff `value` is
 * one of the 10 canonical strings.
 */
export function isUxfOutboxStatus(value: unknown): value is UxfOutboxStatus {
  return (
    typeof value === 'string' &&
    (UXF_OUTBOX_STATUSES as ReadonlyArray<string>).includes(value)
  );
}

// =============================================================================
// 2. UxfTransferOutboxEntry — §7 canonical bundle-grained record
// =============================================================================

/**
 * Bundle-grained outbox entry persisted under `${addr}.outbox.${id}` keys
 * by the per-entry-key writer (PROFILE-ARCHITECTURE §10.12 / Wave G.7).
 *
 * @see UXF-TRANSFER-PROTOCOL §7 for the canonical field-by-field
 *      specification.
 */
export interface UxfTransferOutboxEntry {
  /**
   * Schema discriminator. Always the literal `'uxf-1'` for entries
   * produced by `OutboxWriter`. Legacy `OutboxEntry` records lack this
   * field — readers sniff on its presence to dispatch to the correct
   * decoder.
   */
  readonly _schemaVersion: 'uxf-1';

  /** UUID for this transfer attempt (primary key under `${addr}.outbox.${id}`). */
  readonly id: string;

  /** Which UXF bundle (CAR root CID). For TXF/legacy migration, may be a
   *  synthetic id of the form `'txf-' + tokenId` or
   *  `'legacy-' + recipientPubkey + '-' + createdAt`. See §7.2. */
  readonly bundleCid: string;

  /** Tokens shipped in this bundle (genesis token ids). Empty array
   *  permitted only for the migration synthetic case. */
  readonly tokenIds: ReadonlyArray<string>;

  /** How the bundle was sent. */
  readonly deliveryMethod: 'car-over-nostr' | 'cid-over-nostr' | 'txf-legacy';

  /** Recipient identifier (@nametag, DIRECT://..., chain pubkey, alpha1...). */
  readonly recipient: string;

  /** Recipient's resolved transport pubkey (used by transport.sendTokenTransfer). */
  readonly recipientTransportPubkey: string;

  /** Recipient's nametag (without `@`) at send time, if known. Preserved
   *  through legacy migration (§7.2 step 4). UI display only — not
   *  authenticated on the wire. */
  readonly recipientNametag?: string;

  /** Transfer mode. */
  readonly mode: 'conservative' | 'instant' | 'txf';

  /** Lifecycle status — see {@link UxfOutboxStatus}. */
  readonly status: UxfOutboxStatus;

  /**
   * Instant-mode commitment requestIds, partitioned into outstanding
   * (still being polled / submitted) and completed (proof attached or
   * hard-failed). Two-set form is required for CRDT merge semantics
   * per §7.1 — set-union on a single merged list would re-add finalized
   * requestIds to the outstanding pool and trigger re-submission.
   *
   * Carried as readonly tuples (not mutable arrays) to preserve set
   * semantics through the writer. Union/exclusion is performed by the
   * merger (T.6.B) over the canonical view; here we just persist them.
   */
  readonly outstandingRequestIds?: ReadonlyArray<string>;
  readonly completedRequestIds?: ReadonlyArray<string>;

  /** Optional sender memo. UNAUTHENTICATED on the wire. */
  readonly memo?: string;

  /** Wall-clock millisecond timestamp when the entry was first created. */
  readonly createdAt: number;

  /** Wall-clock millisecond timestamp of the most recent local mutation. */
  readonly updatedAt: number;

  /**
   * Lamport logical clock for CRDT tie-breaking. MUST follow §7.1 rule:
   *   on local write: lamport = max(local, observedRemotes) + 1
   *   on merge:       lamport = max(replicaA.lamport, replicaB.lamport)
   *
   * The {@link OutboxWriter} in `profile/outbox-writer.ts` enforces the
   * write rule via the {@link Lamport} clock in `profile/lamport.ts`.
   */
  readonly lamport: number;

  /**
   * Operator-override stickiness flag (§7.1). Set to `true` when
   * `payments.importInclusionProof()` transitions
   * `failed-permanent → finalizing`. The flag is sticky across merges
   * (set-OR semantics) — any replica having `overrideApplied === true`
   * causes the merged entry to have it. When `true`, active `finalizing`
   * wins against any replica's `failed-permanent` regardless of Lamport.
   *
   * Optional with `false` semantics on `undefined` to keep existing
   * pre-override entries small and to make the discriminator
   * unambiguous.
   */
  readonly overrideApplied?: boolean;

  /**
   * Sticky "ever observed `finalizing` status" flag (§7.1, steelman crit
   * #12). Set-OR semantics across merges — `true` on any replica whose
   * lifecycle has at one point passed through the `finalizing` status, OR
   * on any replica whose merger absorbed an entry that carried this flag,
   * OR on any merger output whose inputs carried `status === 'finalizing'`.
   *
   * **Why this exists.** Without the flag, `mergeStatus` is non-associative
   * for the multiset {`finalizing` (no override), `failed-permanent` (no
   * override), `failed-permanent` (overrideApplied: true)}: the inner fold
   * may erase `finalizing` (hard-terminal beats active per Rule 1) so the
   * Rule 2 override arc cannot revive it in the outer merge. With this
   * flag, the override arc can fire whenever ANY replica has ever observed
   * `finalizing`, even after it has been hidden by an intermediate
   * hard-terminal fold — restoring associativity for the gossip-fold model.
   *
   * **Sticky CRDT-stable boolean.** Once `true` on any replica, every
   * future merge output is `true`. Persisted on writes (the writer never
   * clears it). Optional with `false` semantics on `undefined`.
   */
  readonly everFinalizing?: boolean;

  /** Last error message, if any. */
  readonly error?: string;

  /**
   * Submit retry counter — G-counter shape (CRDT max-merge per §7.1).
   * Monotonic non-decreasing.
   */
  readonly submitRetryCount: number;

  /**
   * Proof error counter — G-counter shape (CRDT max-merge per §7.1).
   * Monotonic non-decreasing.
   */
  readonly proofErrorCount: number;

  /** Soft deadline (wall-clock ms) for transient retry abandonment. After
   *  this time, the worker stops retrying and transitions the entry to
   *  `failed-permanent`. */
  readonly retryDeadline?: number;

  /** Polling deadline (wall-clock ms) for instant-mode finalization. After
   *  this time, sustained PATH_NOT_INCLUDED transitions the entry to
   *  `failed-permanent` with reason='oracle-rejected'. */
  readonly pollingDeadline?: number;

  /**
   * Wall-clock millisecond timestamp of the FIRST poll-loop entry
   * for this outbox entry. Anchors the {@link isPollingTimedOut}
   * deadline (§5.5 step 6) and the W26 hard safety net
   * (`2 × POLLING_WINDOW_MS` from this stamp).
   *
   * **Steelman post-cutover invariant (W26 cross-restart persistence)**:
   * the finalization worker MUST persist this on first poll iteration
   * and MUST use the persisted value (NOT `now()`) on every subsequent
   * pass — including after crash/restart. Recapturing `now()` per
   * `runRequestPipeline` invocation voids the §5.5 step 6 termination
   * guarantee: a token stuck PENDING across many restarts would poll
   * indefinitely with a fresh 60-min window each time.
   *
   * Optional with `undefined` semantics on the first observation; the
   * worker stamps it via `outbox.update()` BEFORE the first poll.
   * Once set, the field is monotonic — never overwritten on retry.
   * Mirror of {@link FinalizationQueueEntry.submittedAt} on the
   * recipient side.
   */
  readonly pollStartedAt?: number;

  /**
   * Issue #166 P2 #3 — Nostr event id returned by the relay's OK ack
   * after `transport.sendTokenTransfer()` succeeds. Captured at the
   * `sending → delivered{,-instant}` arc and propagated to the SENT
   * ledger via {@link writeSentEntryFromOutbox}.
   *
   * Powers the {@link NostrPersistenceVerifier} worker (default OFF
   * via `features.nostrPersistenceVerifier`), which periodically
   * re-queries the relay by event id to detect retention drops —
   * closing the "relay ack ≠ persistence" gap left by the
   * round-2 steelman fix (PR #97 / `fcf1d53`).
   *
   * Backward-compat: optional; entries written before P2 #3 wiring
   * lacked this field and continue to validate via the type guard
   * (which accepts missing OR non-empty string).
   */
  readonly nostrEventId?: string;
}

// =============================================================================
// 3. Legacy entry shape — re-exported alias for the migration window
// =============================================================================

/**
 * Legacy per-token outbox entry shape produced by pre-T.6.A code paths.
 *
 * Re-exported under the {@link LegacyOutboxEntry} alias so call sites can
 * read both shapes during the §7.2 migration window. The canonical source
 * remains `types/txf.ts:OutboxEntry`.
 *
 * @see types/txf.ts
 */
export type LegacyOutboxEntry = OutboxEntry;

// =============================================================================
// 4. Runtime guards — schema sniffers
// =============================================================================

/**
 * Runtime guard for {@link UxfTransferOutboxEntry}.
 *
 * The discriminator is `_schemaVersion === 'uxf-1'`. The guard performs a
 * shallow shape check sufficient to disambiguate from the legacy shape; it
 * does NOT validate every field deeply (callers that need deep validation
 * should run after this guard against the spec).
 *
 * Negative cases: `null`, `undefined`, non-objects, plain `OutboxEntry`
 * (legacy — lacks `_schemaVersion`), corrupted JSON, tombstones (`{ tombstoned: true }`).
 */
export function isUxfTransferOutboxEntry(
  value: unknown,
): value is UxfTransferOutboxEntry {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (obj._schemaVersion !== 'uxf-1') return false;
  if (typeof obj.id !== 'string' || obj.id.length === 0) return false;
  if (typeof obj.bundleCid !== 'string') return false;
  if (!Array.isArray(obj.tokenIds)) return false;
  if (typeof obj.deliveryMethod !== 'string') return false;
  if (typeof obj.recipient !== 'string') return false;
  if (typeof obj.recipientTransportPubkey !== 'string') return false;
  if (typeof obj.mode !== 'string') return false;
  if (!isUxfOutboxStatus(obj.status)) return false;
  // Issue #166 P4 #2 — range tightening on lamport, createdAt,
  // updatedAt. Lamport is a non-negative integer by construction
  // (Lamport.bumpFor always yields `next > 0` after a write, and an
  // unwritten slot decodes as absent — never as a negative). Epoch-ms
  // timestamps are non-negative. Rejecting these at the schema gate
  // prevents corrupted blobs from poisoning downstream comparisons.
  // submitRetryCount and proofErrorCount keep their pre-#166 checks
  // (typeof === 'number') — they're capped elsewhere by §7.1 G-counter
  // monotonicity invariants.
  if (!Number.isInteger(obj.lamport) || (obj.lamport as number) < 0) return false;
  if (typeof obj.submitRetryCount !== 'number') return false;
  if (typeof obj.proofErrorCount !== 'number') return false;
  if (!Number.isInteger(obj.createdAt) || (obj.createdAt as number) < 0) return false;
  if (!Number.isInteger(obj.updatedAt) || (obj.updatedAt as number) < 0) return false;
  // Issue #166 P2 #3 — when nostrEventId is present (optional field),
  // require a non-empty string. Empty string is invalid because the
  // verifier worker uses it as a query key; an empty key would query
  // every event on the relay.
  if (obj.nostrEventId !== undefined) {
    if (typeof obj.nostrEventId !== 'string' || obj.nostrEventId.length === 0) {
      return false;
    }
  }
  // Issue #166 P1 #3 — DoS bounds. A hostile peer replicating an
  // entry with 1M tokenIds (or a single 100MB tokenId) would cost
  // seconds of CPU + GB of RAM inside readAll()/contains() before
  // the application could reject it. Cap at the type-guard gate so
  // oversized entries are skipped silently — they never enter the
  // result set returned to callers.
  if (obj.tokenIds.length > MAX_TOKEN_IDS_PER_ENTRY) return false;
  for (const t of obj.tokenIds) {
    if (typeof t !== 'string') return false;
    if (t.length === 0 || t.length > MAX_TOKEN_ID_LENGTH) return false;
  }
  if (obj.bundleCid.length > MAX_BUNDLE_CID_LENGTH) return false;
  if (obj.recipient.length > MAX_RECIPIENT_LENGTH) return false;
  if (obj.recipientTransportPubkey.length > MAX_TRANSPORT_PUBKEY_LENGTH) return false;
  if (!isWithinOptionalStringLength(obj.recipientNametag, MAX_NAMETAG_LENGTH)) return false;
  if (!isWithinOptionalStringLength(obj.memo, MAX_MEMO_LENGTH)) return false;
  if (!isWithinOptionalStringLength(obj.error, MAX_ERROR_LENGTH)) return false;
  if (
    obj.nostrEventId !== undefined &&
    typeof obj.nostrEventId === 'string' &&
    obj.nostrEventId.length > MAX_NOSTR_EVENT_ID_LENGTH
  ) {
    return false;
  }
  // outstandingRequestIds / completedRequestIds are also tokenId-shaped
  // hex digests; bound them with the same MAX_TOKEN_ID_LENGTH cap.
  if (obj.outstandingRequestIds !== undefined) {
    if (!Array.isArray(obj.outstandingRequestIds)) return false;
    if (obj.outstandingRequestIds.length > MAX_TOKEN_IDS_PER_ENTRY) return false;
    for (const r of obj.outstandingRequestIds) {
      if (typeof r !== 'string') return false;
      if (r.length === 0 || r.length > MAX_TOKEN_ID_LENGTH) return false;
    }
  }
  if (obj.completedRequestIds !== undefined) {
    if (!Array.isArray(obj.completedRequestIds)) return false;
    if (obj.completedRequestIds.length > MAX_TOKEN_IDS_PER_ENTRY) return false;
    for (const r of obj.completedRequestIds) {
      if (typeof r !== 'string') return false;
      if (r.length === 0 || r.length > MAX_TOKEN_ID_LENGTH) return false;
    }
  }
  return true;
}

/**
 * Runtime guard for {@link LegacyOutboxEntry}.
 *
 * Returns true iff the value looks like the pre-T.6.A `OutboxEntry` shape:
 *  - has `id: string`
 *  - has `status` ∈ {'pending', 'submitted', 'confirmed', 'delivered', 'failed'}
 *  - has `sourceTokenId: string`
 *  - LACKS `_schemaVersion`
 *
 * The guard is intentionally tight on `status` so corrupt / partial entries
 * do not classify as legacy (they classify as `null`/unknown via the
 * sniffer below).
 *
 * Idempotent: applying the guard to a value that is already classified as
 * legacy returns `true` again (no internal state).
 */
export function isLegacyOutboxEntry(value: unknown): value is LegacyOutboxEntry {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  // Discriminator: legacy entries MUST NOT carry `_schemaVersion`.
  if ('_schemaVersion' in obj) return false;
  if (typeof obj.id !== 'string' || obj.id.length === 0) return false;
  if (typeof obj.sourceTokenId !== 'string') return false;
  if (typeof obj.recipientPubkey !== 'string') return false;
  const legacyStatuses = ['pending', 'submitted', 'confirmed', 'delivered', 'failed'];
  if (typeof obj.status !== 'string' || !legacyStatuses.includes(obj.status)) {
    return false;
  }
  return true;
}

/**
 * Schema-sniff classifier. Returns the on-disk shape for a parsed JSON
 * value read from `${addr}.outbox.${id}`.
 *
 *  - `'uxf-1'`   — new {@link UxfTransferOutboxEntry} with schema discriminator.
 *  - `'legacy'`  — pre-T.6.A {@link LegacyOutboxEntry} (no discriminator).
 *  - `'unknown'` — corrupted, partial, tombstoned, or otherwise unrecognized.
 *
 * Idempotent: classifying the same value twice yields the same result.
 */
export function classifyOutboxEntryShape(
  value: unknown,
): 'uxf-1' | 'legacy' | 'unknown' {
  if (isUxfTransferOutboxEntry(value)) return 'uxf-1';
  if (isLegacyOutboxEntry(value)) return 'legacy';
  return 'unknown';
}
