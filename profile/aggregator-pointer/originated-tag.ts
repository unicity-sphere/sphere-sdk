/**
 * Originated-tag discipline (T-B6, SPEC §10.2.3, §10.2.3.1).
 *
 * Every OpLog write MUST carry an `originated` tag indicating who initiated
 * the write.  The re-validation check runs:
 *   (i)  on every locally-authored write, before durable persistence
 *   (ii) on every replicated write, before the replica is accepted
 *
 * Fail-closed: missing or unrecognised tags are rejected with
 * SECURITY_ORIGIN_MISMATCH.
 */

import { AggregatorPointerError, AggregatorPointerErrorCode } from './errors.js';

// ── User-action types (9 total) ────────────────────────────────────────────
const USER_ACTION_TYPES = [
  'token_send',
  'token_receive',
  'nametag_register',
  'dm_send',
  'invoice_mint',
  'invoice_pay',
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

/** All 12 known entry types, for exhaustiveness checks. */
export const ALL_ENTRY_TYPES: readonly OpLogEntryType[] = [
  ...USER_ACTION_TYPES,
  ...SYSTEM_ACTION_TYPES,
];

const USER_ACTION_SET = new Set<string>(USER_ACTION_TYPES);
const SYSTEM_ACTION_SET = new Set<string>(SYSTEM_ACTION_TYPES);

/**
 * Stamp an originated tag onto an OpLog entry payload.
 * Returns a new object with `originated` set; does not mutate the input.
 */
export function stampOriginated<T extends Record<string, unknown>>(
  entry: T,
  tag: OriginTag,
): T & { originated: OriginTag } {
  return { ...entry, originated: tag };
}

/**
 * Validate the originated tag on an incoming OpLog entry.
 *
 * Rules (SPEC §10.2.3 D5):
 *   - User-action entry types MUST carry `originated = 'user'`
 *   - System entry types MUST carry `originated = 'system'`
 *   - Replicated entries may carry `originated = 'replicated'`
 *     (downgrade applied by the replication entry point per §10.2.3)
 *
 * Fail-closed: missing `originated` field is treated as a mismatch.
 *
 * @throws AggregatorPointerError(SECURITY_ORIGIN_MISMATCH) on any violation.
 */
export function assertOriginTag(entryType: string, originated: unknown): void {
  if (typeof originated !== 'string') {
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH,
      `OpLog entry type "${entryType}" is missing the originated tag (fail-closed; SPEC §10.2.3).`,
      { entryType, originated },
    );
  }

  if (USER_ACTION_SET.has(entryType)) {
    if (originated !== 'user' && originated !== 'replicated') {
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH,
        `User-action entry type "${entryType}" must carry originated='user' or 'replicated', got '${originated}'.`,
        { entryType, originated },
      );
    }
    return;
  }

  if (SYSTEM_ACTION_SET.has(entryType)) {
    if (originated !== 'system' && originated !== 'replicated') {
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.SECURITY_ORIGIN_MISMATCH,
        `System entry type "${entryType}" must carry originated='system' or 'replicated', got '${originated}'.`,
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
 * Downgrade originated tag at replication entry point (SPEC §10.2.3).
 *
 * Any incoming replicated write that arrives with `originated = 'user'`
 * must be downgraded to `'replicated'` before being appended to the
 * local OpLog.  This closes the tag-forgery bypass: a malicious peer
 * cannot make its writes appear as local user actions.
 */
export function downgradeForReplication<T extends { originated?: OriginTag }>(
  entry: T,
): T & { originated: 'replicated' } {
  return { ...entry, originated: 'replicated' as const };
}
