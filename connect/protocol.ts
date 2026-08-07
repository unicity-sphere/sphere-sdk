/**
 * Sphere Connect Protocol
 * JSON-RPC-like message types for wallet ↔ dApp communication.
 */

import { majorOf } from './semver';

// =============================================================================
// Constants
// =============================================================================

export const SPHERE_CONNECT_NAMESPACE = 'sphere-connect';
export const SPHERE_CONNECT_VERSION = '2.1';   // Connect protocol version (semver MAJOR.MINOR)

// Default npm-SDK floor a host enforces at the handshake (0.14.1 = the P11 flip:
// the v1 payments era is gone; pre-flip ConnectClients expect a wallet that no
// longer exists). '-0' admits every 0.14.1 prerelease (compareSemver: release >
// prerelease). Override via ConnectHostConfig.minSdkVersion; the claim is
// compatibility hygiene, not security — a hostile client can lie about it.
export const DEFAULT_MIN_CLIENT_SDK_VERSION = '0.14.1-0';

export { HOST_READY_TYPE, HOST_READY_TIMEOUT, SPHERE_NETWORKS } from '../constants';
// Import for local use (e.g. SphereHandshake.network) AND re-export for connect consumers.
// A bare `export type { NetworkInfo } from '../constants'` would re-export without bringing
// the name into this module's scope, breaking the local references (TS2304).
import type { NetworkInfo } from '../constants';
export type { NetworkInfo };

// =============================================================================
// RPC Method Names (query — return data, no UI)
// =============================================================================

export const RPC_METHODS = {
  GET_IDENTITY: 'sphere_getIdentity',
  GET_BALANCE: 'sphere_getBalance',
  GET_ASSETS: 'sphere_getAssets',
  GET_FIAT_BALANCE: 'sphere_getFiatBalance',
  GET_TOKENS: 'sphere_getTokens',
  GET_HISTORY: 'sphere_getHistory',
  RESOLVE: 'sphere_resolve',
  SUBSCRIBE: 'sphere_subscribe',
  UNSUBSCRIBE: 'sphere_unsubscribe',
  DISCONNECT: 'sphere_disconnect',
  GET_CONVERSATIONS: 'sphere_getConversations',
  GET_MESSAGES: 'sphere_getMessages',
  GET_DM_UNREAD_COUNT: 'sphere_getDMUnreadCount',
  MARK_AS_READ: 'sphere_markAsRead',
} as const;

export type RpcMethod = (typeof RPC_METHODS)[keyof typeof RPC_METHODS];

// =============================================================================
// Intent Action Names (open wallet UI, require user confirmation)
// =============================================================================

export const INTENT_ACTIONS = {
  SEND: 'send',
  DM: 'dm',
  PAYMENT_REQUEST: 'payment_request',
  RECEIVE: 'receive',
  SIGN_MESSAGE: 'sign_message',
  MINT: 'mint',
} as const;

export type IntentAction = (typeof INTENT_ACTIONS)[keyof typeof INTENT_ACTIONS];

// =============================================================================
// Error Codes
// =============================================================================

export const ERROR_CODES = {
  // Standard JSON-RPC
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,

  // Sphere Connect (4xxx)
  NOT_CONNECTED: 4001,
  PERMISSION_DENIED: 4002,
  USER_REJECTED: 4003,
  SESSION_EXPIRED: 4004,
  ORIGIN_BLOCKED: 4005,
  RATE_LIMITED: 4006,
  UNSUPPORTED_PROTOCOL_VERSION: 4007, // Connect MAJOR mismatch (incompatible era)
  INCOMPATIBLE_NETWORK:         4008, // dApp targets a different network than the wallet
  // Wallet locked; THE SESSION IS STILL ALIVE. A QUERY may be retried after wallet:unlocked.
  // An INTENT already delegated to the wallet is NEVER answered with this code — it gets
  // INTENT_OUTCOME_UNKNOWN (4201) instead, because a retry could double-spend.
  WALLET_LOCKED:                4009,
  INSUFFICIENT_BALANCE: 4100,
  INVALID_RECIPIENT: 4101,
  TRANSFER_FAILED: 4102,
  INTENT_CANCELLED: 4200,
  /**
   * The intent was DELEGATED to the wallet and the host lost track of the answer — a host
   * deadline fired, or the wallet locked / logged out mid-flight. **The outcome is UNKNOWN:
   * the money may or may not have moved.**
   *
   * A dApp MUST NOT retry on this code. Reconcile out of band (poll the recipient, the
   * aggregator, or your own backend) and only then decide.
   *
   * This code exists because every other answer would be a lie. `INTENT_CANCELLED` (4200)
   * asserts the user declined and nothing happened; `WALLET_LOCKED` (4009) invites a retry
   * after the unlock. Sending either for an intent the wallet had already submitted is how a
   * paid-but-not-credited order — and then a double spend on retry — happens.
   */
  INTENT_OUTCOME_UNKNOWN:       4201,
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** `data` carried by every WALLET_LOCKED (4009) refusal. */
export interface WalletLockedData {
  /** Discriminator. Always the literal 'locked' — reserved for future refusal reasons. */
  readonly reason: 'locked';
  /**
   * Whether the wallet's own unlock surface is currently on screen.
   * DECLARED in the fail-fast release and always absent there; POPULATED in the resume
   * release from ConnectHostConfig.unlockSurface(), evaluated at refusal time (visibility
   * changes over time, so a static value would lie). Feeds
   * ConnectClientConfig.onWalletAttention.
   */
  readonly unlockSurface?: 'visible' | 'background';
}

// =============================================================================
// Message Types
// =============================================================================

interface SphereMessageBase {
  readonly ns: typeof SPHERE_CONNECT_NAMESPACE;
  readonly v: typeof SPHERE_CONNECT_VERSION;
}

/** Query request: dApp → Wallet */
export interface SphereRpcRequest extends SphereMessageBase {
  readonly type: 'request';
  readonly id: string;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

/** Query response: Wallet → dApp */
export interface SphereRpcResponse extends SphereMessageBase {
  readonly type: 'response';
  readonly id: string;
  readonly result?: unknown;
  readonly error?: SphereRpcError;
}

/** Intent request: dApp → Wallet (opens wallet UI) */
export interface SphereIntentRequest extends SphereMessageBase {
  readonly type: 'intent';
  readonly id: string;
  readonly action: string;
  readonly params: Record<string, unknown>;
}

/** Intent result: Wallet → dApp (after user action) */
export interface SphereIntentResult extends SphereMessageBase {
  readonly type: 'intent_result';
  readonly id: string;
  readonly result?: unknown;
  readonly error?: SphereRpcError;
}

/** Event push: Wallet → dApp (unsolicited) */
export interface SphereEventMessage extends SphereMessageBase {
  readonly type: 'event';
  readonly event: string;
  readonly data: unknown;
}

/** Handshake: bidirectional */
export interface SphereHandshake extends SphereMessageBase {
  readonly type: 'handshake';
  readonly direction: 'request' | 'response';
  readonly permissions: string[];
  readonly dapp?: DAppMetadata;
  readonly sessionId?: string;
  readonly identity?: PublicIdentity;
  /** If true, wallet must NOT open any approval UI. Immediately reject if origin is not already approved. */
  readonly silent?: boolean;
  /** request: dApp target network; response: wallet active network */
  readonly network?: NetworkInfo;
  /** Informational: the dApp's npm SDK version. */
  readonly sdkVersion?: string;
  /** Response: structured rejection reason when the gate refuses the connection. */
  readonly error?: SphereRpcError;
  /** Response: non-fatal deprecation notice (does not block the connection). */
  readonly warning?: SphereRpcError;
  /** Response only: the wallet is LOCKED and the session is ALIVE. The dApp is connected
   *  and must not re-handshake; it will receive `wallet:unlocked` on the same session.
   *  Additive and safe for old clients: handleHandshakeResponse reads only sessionId,
   *  permissions, identity, network, warning and error and ignores unknown fields. */
  readonly locked?: boolean;
}

export interface SphereRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export type SphereConnectMessage =
  | SphereRpcRequest
  | SphereRpcResponse
  | SphereIntentRequest
  | SphereIntentResult
  | SphereEventMessage
  | SphereHandshake;

// =============================================================================
// Shared Types
// =============================================================================

export interface DAppMetadata {
  readonly name: string;
  readonly description?: string;
  readonly icon?: string;
  readonly url: string;
}

export interface PublicIdentity {
  readonly chainPubkey: string;
  readonly directAddress?: string;
  readonly nametag?: string;
}

// =============================================================================
// Wallet-initiated Events (pushed automatically by host, no subscription needed)
// =============================================================================

/**
 * Events that ConnectHost pushes proactively to connected dApps.
 * dApps can listen with client.on(WALLET_EVENTS.LOCKED, handler) etc.
 * No sphere_subscribe call needed — host sends these unconditionally.
 */
export const WALLET_EVENTS = {
  /** Wallet is LOCKED — the session is STILL ALIVE. Requests are answered
   *  WALLET_LOCKED (4009) until `wallet:unlocked`. The dApp must NOT disconnect,
   *  must NOT clear its sessionId, and must NOT re-handshake.
   *  Payload: {@link WalletLockedPayload}. Pushed by ConnectHost.setLocked() and
   *  immediately after a handshake response carrying `locked: true`. */
  LOCKED: 'wallet:locked',
  /** Wallet was unlocked — the SAME session continues: no re-handshake, no re-approval,
   *  no re-subscribe (the host re-arms the dApp's subscriptions before pushing this).
   *  Payload: {@link WalletUnlockedPayload} — carries the CURRENT identity, which may
   *  differ from the one the dApp connected with. Pushed by ConnectHost.updateSphere()
   *  on the locked -> live edge only. */
  UNLOCKED: 'wallet:unlocked',
  /** The session is GONE (logout, wallet deleted, dApp sphere_disconnect, expiry seen at
   *  unlock, a different seed behind the lock screen, host destroy).
   *  The dApp must clear its session and re-handshake to continue. Unlocking does not cure it.
   *  Payload: {@link WalletDisconnectedPayload}. Pushed by ConnectHost.revokeSession(). */
  DISCONNECTED: 'wallet:disconnected',
  /** Active wallet address changed. dApp should update displayed identity.
   *  Pushed automatically by ConnectHost — no sphere_subscribe needed. */
  IDENTITY_CHANGED: 'identity:changed',
} as const;

export type WalletEvent = (typeof WALLET_EVENTS)[keyof typeof WALLET_EVENTS];

/** Payload of {@link WALLET_EVENTS.LOCKED}. Intentionally empty — matches today's push,
 *  so an old dApp sees no shape change. */
export type WalletLockedPayload = Record<string, never>;

/** Payload of {@link WALLET_EVENTS.DISCONNECTED}. Intentionally empty. */
export type WalletDisconnectedPayload = Record<string, never>;

/** Payload of {@link WALLET_EVENTS.UNLOCKED}. */
export interface WalletUnlockedPayload {
  /** The wallet's public identity at unlock time. Absent when the rebound Sphere has no
   *  identity yet (JSON transports drop undefined keys).
   *  Unlock is NOT implicitly the same wallet: the lock screen's "Forgot password ->
   *  restore from recovery phrase" installs a DIFFERENT seed while origin approvals are
   *  keyed by origin alone. The host's own lock-edge guard is authoritative (it revokes
   *  instead of pushing this event on a mismatch); this field is what lets a dApp render
   *  honestly and what the client-side retry queue checks before draining. */
  readonly identity?: PublicIdentity;
}

/** Payload of {@link WALLET_EVENTS.IDENTITY_CHANGED} — unchanged: the host forwards
 *  Sphere's own event data verbatim and pushes a PublicIdentity from updateSphere().
 *  Typed as the union for honesty. */
export type WalletIdentityChangedPayload = PublicIdentity | unknown;

/** Events the host pushes unconditionally. They must NEVER be routed through
 *  `sphere_subscribe`: Sphere.on() accepts any string and would silently never emit,
 *  so the subscribe would succeed and deliver nothing forever. */
export const AUTO_PUSHED_EVENTS: readonly WalletEvent[] = [
  WALLET_EVENTS.LOCKED,
  WALLET_EVENTS.UNLOCKED,
  WALLET_EVENTS.DISCONNECTED,
  WALLET_EVENTS.IDENTITY_CHANGED,
];

/** True for an event the host pushes unconditionally (see {@link AUTO_PUSHED_EVENTS}). */
export function isAutoPushedEvent(event: string): event is WalletEvent {
  return (AUTO_PUSHED_EVENTS as readonly string[]).includes(event);
}

// =============================================================================
// Helpers
// =============================================================================

/** Check if a message belongs to the Sphere Connect protocol.
 *  Handshakes are accepted at ANY version (the version decision happens in the
 *  handshake handler so an incompatible peer gets a clean typed error instead of a
 *  silently-dropped message → timeout). All other (session) traffic must share the
 *  same MAJOR (so MINOR versions interoperate, e.g. 2.0 ↔ 2.1). */
export function isSphereConnectMessage(msg: unknown): msg is SphereConnectMessage {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as Record<string, unknown>;
  if (m.ns !== SPHERE_CONNECT_NAMESPACE) return false;
  if (m.type === 'handshake') return true;
  if (typeof m.v !== 'string') return false;
  return majorOf(m.v) === majorOf(SPHERE_CONNECT_VERSION);
}

/** Create a unique request ID */
export function createRequestId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}
