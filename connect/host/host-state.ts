/**
 * Wallet-binding FSM + the single total gate decision.
 *
 * PURE: no I/O, no timers, no Sphere reference, no `await` — a transition
 * table + assertTransition.
 *
 * Nothing here is re-exported from connect/index.ts — it is host-internal.
 */

import { SphereError } from '../../core/errors';
import { ERROR_CODES, RPC_METHODS } from '../protocol';
import type { WalletLockedData } from '../protocol';
import type { WalletState } from '../types';

// ===========================================================================
// Wire text — RECOMMENDATIONS, not contracts
// ===========================================================================

/** Recommended refusal text for WALLET_LOCKED. Discriminate on code 4009 and on
 *  data.reason, NEVER on this string. Deliberately does not match the reference dApp's
 *  teardown regex /not.connected|timeout|transport|closed|session/i. */
export const WALLET_LOCKED_MESSAGE = 'Wallet is locked';

/** Fixed text for a non-SphereError throw. A raw JS message must never cross the trust
 *  boundary into a third-party dApp. */
export const INTERNAL_ERROR_MESSAGE = 'Internal wallet error';
/**
 * Recommended text for INTENT_OUTCOME_UNKNOWN (4201). Like every message on this wire it is
 * NOT a contract — consumers discriminate on the code — but the wording matters here because a
 * developer reading it must not conclude the intent was cancelled.
 */
export const INTENT_UNKNOWN_MESSAGE =
  'Intent outcome unknown — do not retry; reconcile before acting';

/** Today's literal on the host's not-connected refusals — kept byte-identical.
 *  `unavailable` answers this too: unlocking cannot cure it, so promising an unlock
 *  would be a lie. */
export const NOT_CONNECTED_MESSAGE = 'Not connected';

// ===========================================================================
// Transitions
// ===========================================================================

/** Legal edges. NO self-transitions by design: every verb must early-return when it is
 *  already in the target state, so assertWalletTransition() enforces idempotency at the
 *  table level rather than by reviewer diligence. */
export const VALID_WALLET_TRANSITIONS: Record<WalletState, readonly WalletState[]> = {
  live: ['locked', 'unavailable'],
  locked: ['live', 'unavailable'],
  unavailable: ['live', 'locked'],
};

export function isValidWalletTransition(from: WalletState, to: WalletState): boolean {
  return VALID_WALLET_TRANSITIONS[from].includes(to);
}

/** Throws SphereError('Invalid wallet state transition: from -> to', 'VALIDATION_ERROR')
 *  — an EXISTING SphereErrorCode; core/errors.ts is not touched. */
export function assertWalletTransition(from: WalletState, to: WalletState): void {
  if (!isValidWalletTransition(from, to)) {
    throw new SphereError(`Invalid wallet state transition: ${from} -> ${to}`, 'VALIDATION_ERROR');
  }
}

// ===========================================================================
// Locked allow-list
// ===========================================================================

/**
 * The four methods answerable while locked. Everything else gets 4009.
 *
 * - sphere_getIdentity  -> 'serve-from-snapshot'. Those exact bytes were already handed
 *                          to this origin in the handshake response and DEFAULT_PERMISSIONS
 *                          grants identity:read unconditionally, so refusing re-states a
 *                          revealed fact for zero security while making every dApp that
 *                          reads identity once on mount render "disconnected" for the whole
 *                          lock.
 * - sphere_subscribe    -> 'serve'. Refusing it is a BUG, not a policy: ConnectClient.on()
 *                          fires sphere_subscribe fire-and-forget and NEVER retries (the
 *                          error goes to logger.debug), so the event stream would die
 *                          forever after one lock.
 * - sphere_unsubscribe  -> 'serve'. Needs no Sphere at all.
 * - sphere_disconnect   -> 'serve'. Without it a session can never be dropped while
 *                          locked; the client swallows the error and calls cleanup()
 *                          anyway, so the dApp shows "disconnected" while onDisconnect —
 *                          the only hook that revokes the persisted origin approval —
 *                          never fires.
 *
 * WHAT IS BLOCKED — the honest count, because an enumeration of only the money reads reads as
 * if messaging still works. RPC_METHODS has SIXTEEN entries; four are above. The other TWELVE,
 * and EVERY intent, are refused:
 *
 *   sphere_getBalance, sphere_getAssets, sphere_getFiatBalance, sphere_getTokens,
 *   sphere_getHistory      — money state a locked wallet cannot honour. Never cached either: a
 *                            dApp holding a stale balance is a dApp about to offer an
 *                            unpayable spend.
 *   sphere_resolve         — nametag resolution needs the live transport.
 *   sphere_getConversations, sphere_getMessages, sphere_getDMUnreadCount, sphere_markAsRead
 *                          — DMs are decrypted with keys that left memory. Messaging does NOT
 *                            keep working while locked; a dApp must stop polling and wait.
 *   sphere_getInvoices, sphere_getInvoiceStatus
 *                          — invoice state is money state.
 *
 * AND THE CASE WITH NO 4009 AT ALL. Everything above assumes a host that HOLDS a session. A
 * wallet that COLD-STARTS locked (a page reload, a fresh popup — the password is memory-only,
 * so this is the common path) has no session and an EMPTY snapshot, so `handleHandshake`
 * refuses at step 0 with an errorless empty response: the dApp's connect() rejects with a bare
 * "Connection rejected by wallet" carrying NO code. There is nothing to match 4009 against.
 * That silence is deliberate — the refusal must reveal nothing about the wallet to an origin
 * holding no approval — so a dApp cannot distinguish it from a user pressing Reject and must
 * treat it as "not ready yet": keep waiting for HOST_READY, which the wallet emits when a
 * human unlocks it.
 */
export const LOCKED_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  RPC_METHODS.GET_IDENTITY,
  RPC_METHODS.SUBSCRIBE,
  RPC_METHODS.UNSUBSCRIBE,
  RPC_METHODS.DISCONNECT,
]);

// ===========================================================================
// Gate
// ===========================================================================

export type RequestKind = 'query' | 'intent' | 'handshake';

export type GateDecision =
  | { readonly kind: 'serve' }
  /** Answer from WalletSnapshot. If the required snapshot field is absent the caller
   *  REFUSES (4009 for a query, the empty refusal for a handshake) — it never invents a
   *  fact about a wallet we have not seen, and never sends undefined-as-success. */
  | { readonly kind: 'serve-from-snapshot' }
  | {
      readonly kind: 'refuse';
      readonly error: {
        readonly code: number;
        readonly message: string;
        readonly data?: WalletLockedData;
      };
    };

const REFUSE_NOT_CONNECTED: GateDecision = {
  kind: 'refuse',
  error: { code: ERROR_CODES.NOT_CONNECTED, message: NOT_CONNECTED_MESSAGE },
};

const REFUSE_LOCKED: GateDecision = {
  kind: 'refuse',
  error: {
    code: ERROR_CODES.WALLET_LOCKED,
    message: WALLET_LOCKED_MESSAGE,
    data: { reason: 'locked' },
  },
};

/**
 * The single total gate decision. Positional, four required arguments, no I/O.
 * `name` is an RPC method, an intent action, or the literal 'handshake'.
 *
 * Called at step 4 of the ordering contract, AFTER the session check, the expiry check and
 * the rate limit, and BEFORE the permission check — because hasMethodPermission() is false
 * for anything unmapped, so a locked unknown method would otherwise answer
 * PERMISSION_DENIED 4002, an un-retryable code that tells the dApp its permissions are
 * wrong.
 *
 * The resume release merges `unlockSurface` into `error.data` AFTER this returns — the gate
 * stays pure.
 */
export function gate(
  walletState: WalletState,
  hasActiveSession: boolean,
  requestKind: RequestKind,
  name: string,
): GateDecision {
  // 'unavailable' is a dead end: revoke + wallet:disconnected already happened, and
  // unlocking does not cure it. Never 4009 here.
  if (walletState === 'unavailable') return REFUSE_NOT_CONNECTED;

  if (requestKind === 'handshake') {
    // While locked EVERY handshake is answered from the snapshot and forced silent, so an
    // origin without an approval still gets today's empty refusal with no UI.
    return walletState === 'locked' ? { kind: 'serve-from-snapshot' } : { kind: 'serve' };
  }

  // A query or an intent without a session is 4001 in every wallet state: the lock is
  // observable ONLY to an origin that already holds an approval.
  if (!hasActiveSession) return REFUSE_NOT_CONNECTED;

  if (walletState === 'live') return { kind: 'serve' };

  // locked, with an active session.
  if (requestKind === 'query' && LOCKED_ALLOWLIST.has(name)) {
    return name === RPC_METHODS.GET_IDENTITY
      ? { kind: 'serve-from-snapshot' }
      : { kind: 'serve' };
  }
  return REFUSE_LOCKED;
}
