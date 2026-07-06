/**
 * Originated-tag discipline (T-B6, SPEC §10.2.3, §10.2.3.1).
 *
 * Every OpLog write MUST carry an `originated` tag indicating who initiated
 * the write.  Two separate validators enforce context-specific rules:
 *
 *   assertOriginTagLocal       — local writes only ('user' or 'system', NOT 'replicated')
 *   assertOriginTagReplicated  — replicated writes only (MUST be 'replicated')
 *
 * Fail-closed: missing or unrecognised tags are rejected with
 * SECURITY_ORIGIN_MISMATCH.  `assertOriginTag` (the original single-function
 * variant) has been removed — it accepted 'replicated' for all entry types,
 * which created a forgery bypass if callers forgot to call downgradeForReplication.
 */

import { AggregatorPointerError, AggregatorPointerErrorCode } from './errors.js';

// ── User-action types (12 total) ───────────────────────────────────────────
const USER_ACTION_TYPES = [
  'token_send',
  'token_receive',
  'nametag_register',
  'dm_send',
  'dm_receive',
  'invoice_mint',
  'invoice_pay',
  'invoice_close',
  'invoice_cancel',
  'swap_propose',
  'swap_accept',
  'swap_deposit',
] as const;

export type UserActionType = (typeof USER_ACTION_TYPES)[number];

// ── System types (3 total) ─────────────────────────────────────────────────
const SYSTEM_ACTION_TYPES = [
  'session_receipt',
  'cache_index',
  'last_opened_ts',
] as const;

export type SystemActionType = (typeof SYSTEM_ACTION_TYPES)[number];

export type OpLogEntryType = UserActionType | SystemActionType;

// ── Origin values ──────────────────────────────────────────────────────────
export type OriginTag = 'user' | 'system' | 'replicated';

/** All 15 known entry types, frozen to prevent runtime mutation. */
export const ALL_ENTRY_TYPES: readonly OpLogEntryType[] = Object.freeze([
  ...USER_ACTION_TYPES,
  ...SYSTEM_ACTION_TYPES,
]);

const USER_ACTION_SET = new Set<string>(USER_ACTION_TYPES);
const SYSTEM_ACTION_SET = new Set<string>(SYSTEM_ACTION_TYPES);

// Module-load invariant: USER and SYSTEM sets must be disjoint.
for (const t of USER_ACTION_TYPES) {
  if (SYSTEM_ACTION_SET.has(t)) {
    throw new Error(
      `originated-tag: BUG — "${t}" appears in both USER_ACTION_TYPES and SYSTEM_ACTION_TYPES`,
    );
  }
}

/**
 * Derive the canonical `originated` tag for a given entry type. System
 * entry types (`session_receipt`, `cache_index`, `last_opened_ts`) MUST
 * carry `originated='system'`; user action types MUST carry
 * `originated='user'`. Routes through the same SYSTEM_ACTION_SET that
 * `assertOriginTagLocal` validates against, so write-side stamping and
 * read-side validation use a single source of truth.
 *
 * Replaces a local duplicate in profile-storage-provider.ts that
 * silently diverged when new entry types were added — same DRY
 * violation pattern that caused the cross-provider OpLog encoding
 * collision in profile-token-storage-provider.ts.
 */
export function deriveOriginForType(
  entryType: OpLogEntryType,
): 'user' | 'system' {
  return SYSTEM_ACTION_SET.has(entryType) ? 'system' : 'user';
}

/**
 * Stamp an originated tag onto an OpLog entry payload.
 * Returns a new object with `originated` set; does not mutate the input.
 *
 * @throws AggregatorPointerError(SECURITY_ORIGIN_MISMATCH) if the entry
 *   already carries an `originated` field (double-stamp guard).
 */
export function stampOriginated<T extends Record<string, unknown>>(
  entry: T,
  tag: OriginTag,
): T & { originated: OriginTag } {
  if ((entry as Record<string, unknown>).originated !== undefined) {
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH,
      `stampOriginated: entry already carries originated='${String((entry as Record<string, unknown>).originated)}' — double-stamp guard (SPEC §10.2.3).`,
      { existingTag: (entry as Record<string, unknown>).originated },
    );
  }
  return { ...entry, originated: tag };
}

/**
 * Validate the originated tag on a LOCALLY-authored OpLog entry.
 *
 * Rules (SPEC §10.2.3 D5 — local-write path):
 *   - User-action entry types MUST carry `originated = 'user'`
 *   - System entry types MUST carry `originated = 'system'`
 *   - `originated = 'replicated'` is REJECTED here (use assertOriginTagReplicated
 *     at the replication ingress instead)
 *
 * Fail-closed: missing `originated` field is treated as a mismatch.
 *
 * @throws AggregatorPointerError(SECURITY_ORIGIN_MISMATCH) on any violation.
 */
export function assertOriginTagLocal(entryType: string, originated: unknown): void {
  if (typeof originated !== 'string') {
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH,
      `OpLog entry type "${entryType}" is missing the originated tag (fail-closed; SPEC §10.2.3).`,
      { entryType, originated },
    );
  }

  if (USER_ACTION_SET.has(entryType)) {
    if (originated !== 'user') {
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH,
        `Local user-action entry type "${entryType}" must carry originated='user', got '${originated}'.`,
        { entryType, originated },
      );
    }
    return;
  }

  if (SYSTEM_ACTION_SET.has(entryType)) {
    if (originated !== 'system') {
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH,
        `Local system entry type "${entryType}" must carry originated='system', got '${originated}'.`,
        { entryType, originated },
      );
    }
    return;
  }

  throw new AggregatorPointerError(
    AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH,
    `Unknown OpLog entry type "${entryType}" — cannot validate originated tag.`,
    { entryType, originated },
  );
}

/**
 * Validate the originated tag on a REPLICATED OpLog entry.
 *
 * Rules (SPEC §10.2.3 — replication ingress):
 *   - All known entry types MUST carry `originated = 'replicated'`
 *   - Any other value is rejected (prevents a malicious peer from injecting
 *     writes that appear as local user or system actions)
 *
 * Fail-closed: missing `originated` field is treated as a mismatch.
 *
 * @throws AggregatorPointerError(SECURITY_ORIGIN_MISMATCH) on any violation.
 */
export function assertOriginTagReplicated(entryType: string, originated: unknown): void {
  if (typeof originated !== 'string') {
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH,
      `Replicated OpLog entry type "${entryType}" is missing the originated tag (fail-closed; SPEC §10.2.3).`,
      { entryType, originated },
    );
  }

  if (!USER_ACTION_SET.has(entryType) && !SYSTEM_ACTION_SET.has(entryType)) {
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH,
      `Unknown OpLog entry type "${entryType}" — cannot validate originated tag.`,
      { entryType, originated },
    );
  }

  if (originated !== 'replicated') {
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH,
      `Replicated entry type "${entryType}" must carry originated='replicated', got '${originated}' — possible tag-forgery attempt.`,
      { entryType, originated },
    );
  }
}

/**
 * Downgrade originated tag at replication entry point (SPEC §10.2.3).
 *
 * Any incoming replicated write MUST already carry an `originated` field
 * (set by the originating node).  This function stamps it as `'replicated'`
 * to prevent a malicious peer from making writes appear as local user actions.
 *
 * Fail-closed: throws SECURITY_ORIGIN_MISMATCH if the entry has no `originated`
 * field — an entry arriving at the replication edge without a tag is a protocol
 * violation (could indicate a tampered or malformed entry).
 *
 * @throws AggregatorPointerError(SECURITY_ORIGIN_MISMATCH) if `originated` is absent.
 */
export function downgradeForReplication<T extends Record<string, unknown>>(
  entry: T,
): T & { originated: 'replicated' } {
  if ((entry as Record<string, unknown>).originated == null) {
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH,
      `downgradeForReplication: entry has no originated tag — protocol violation at replication edge (SPEC §10.2.3).`,
      { entry },
    );
  }
  return { ...entry, originated: 'replicated' as const };
}
