/**
 * Sphere Connect Protocol
 * JSON-RPC-like message types for wallet ↔ dApp communication.
 */

// =============================================================================
// Constants
// =============================================================================

export const SPHERE_CONNECT_NAMESPACE = 'sphere-connect';
export const SPHERE_CONNECT_VERSION = '1.0';

export { HOST_READY_TYPE, HOST_READY_TIMEOUT } from '../constants';

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
  L1_GET_BALANCE: 'sphere_l1GetBalance',
  L1_GET_HISTORY: 'sphere_l1GetHistory',
  RESOLVE: 'sphere_resolve',
  SUBSCRIBE: 'sphere_subscribe',
  UNSUBSCRIBE: 'sphere_unsubscribe',
  DISCONNECT: 'sphere_disconnect',
} as const;

export type RpcMethod = (typeof RPC_METHODS)[keyof typeof RPC_METHODS];

// =============================================================================
// Intent Action Names (open wallet UI, require user confirmation)
// =============================================================================

export const INTENT_ACTIONS = {
  SEND: 'send',
  L1_SEND: 'l1_send',
  DM: 'dm',
  PAYMENT_REQUEST: 'payment_request',
  RECEIVE: 'receive',
  SIGN_MESSAGE: 'sign_message',
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
  INSUFFICIENT_BALANCE: 4100,
  INVALID_RECIPIENT: 4101,
  TRANSFER_FAILED: 4102,
  INTENT_CANCELLED: 4200,
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

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
  readonly l1Address: string;
  readonly directAddress?: string;
  readonly nametag?: string;
}

// =============================================================================
// Helpers
// =============================================================================

/** Check if a message belongs to the Sphere Connect protocol */
export function isSphereConnectMessage(msg: unknown): msg is SphereConnectMessage {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as Record<string, unknown>;
  return m.ns === SPHERE_CONNECT_NAMESPACE && m.v === SPHERE_CONNECT_VERSION;
}

/** Create a unique request ID */
export function createRequestId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}
