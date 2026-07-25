/**
 * Sphere Connect Types
 * Session, configuration, and callback types.
 */

import type { SphereConnectMessage, DAppMetadata, PublicIdentity, NetworkInfo, SphereRpcError } from './protocol';
import type { PermissionScope } from './permissions';

// =============================================================================
// Connect Transport (abstract interface)
// =============================================================================

export interface ConnectTransport {
  /** Send a message to the other side */
  send(message: SphereConnectMessage): void;

  /** Subscribe to incoming messages. Returns unsubscribe function. */
  onMessage(handler: (message: SphereConnectMessage) => void): () => void;

  /** Clean up transport resources */
  destroy(): void;
}

// =============================================================================
// Session
// =============================================================================

export interface ConnectSession {
  readonly id: string;
  readonly dapp: DAppMetadata;
  readonly permissions: PermissionScope[];
  readonly createdAt: number;
  readonly expiresAt: number;
  active: boolean;
}

// =============================================================================
// Wallet binding state (orthogonal to the session — see docs/CONNECT.md)
// =============================================================================

/**
 * State of the host's binding to a Sphere instance. ORTHOGONAL to `session`:
 * a locked wallet keeps its session, and a live wallet may have none.
 *
 * - 'live'        — Sphere bound and usable.
 * - 'locked'      — the wallet is locked: the Sphere reference is DROPPED and the
 *                   session is PRESERVED. Requests outside the allow-list answer
 *                   WALLET_LOCKED (4009). Curable by updateSphere().
 * - 'unavailable' — Sphere is gone for a NON-lock reason (a generic init failure leaves
 *                   `sphere === null, isLocked === false`). Entering it revokes the
 *                   session and pushes wallet:disconnected. NOT curable by unlocking.
 */
export type WalletState = 'live' | 'locked' | 'unavailable';

/** Context handed to {@link ConnectHostConfig.onLockedRequest}. Notify-only. */
export interface LockedRequestContext {
  /** ConnectHostConfig.origin, when the wallet supplied one. NEVER the dApp-claimed
   *  `session.dapp.url`. Absent = "a connected app"; make no claim you cannot verify. */
  readonly origin?: string;
  readonly kind: 'query' | 'intent' | 'handshake';
  /** An RPC_METHODS value for 'query', an INTENT_ACTIONS value for 'intent',
   *  the literal 'handshake' for 'handshake'. */
  readonly name: string;
}

/** 4th argument of {@link ConnectHostConfig.onIntent} (Connect 2.1). */
export interface IntentContext {
  readonly origin?: string;
  /** Epoch ms after which the host answers on its own and aborts `signal`. */
  readonly expiresAt: number;
  /** Aborted when the host settles the intent for ANY reason (deadline, lock, revoke,
   *  unavailable, destroy). The wallet MUST dismiss its modal on abort. */
  readonly signal: AbortSignal;
}

// =============================================================================
// ConnectHost Config
// =============================================================================

export interface ConnectHostConfig {
  /** Sphere SDK instance to bridge */
  sphere: unknown; // typed as unknown to avoid circular import; cast to Sphere in implementation

  /** Transport layer for communication */
  transport: ConnectTransport;

  /** Called when dApp requests connection. Wallet shows approval UI.
   *  When `silent` is true, the wallet must NOT open any UI — return rejected immediately if origin is unknown. */
  onConnectionRequest: (
    dapp: DAppMetadata,
    requestedPermissions: PermissionScope[],
    silent?: boolean,
    clientInfo?: { protocolVersion: string; network?: NetworkInfo; sdkVersion?: string },
  ) => Promise<{ approved: boolean; grantedPermissions: PermissionScope[] }>;

  /** Called when dApp sends an intent. Wallet opens corresponding UI. */
  onIntent: (
    action: string,
    params: Record<string, unknown>,
    session: ConnectSession,
  ) => Promise<{ result?: unknown; error?: { code: number; message: string } }>;

  /** Called when dApp explicitly disconnects. Wallet can revoke persisted permissions. */
  onDisconnect?: (session: ConnectSession) => void | Promise<void>;

  /** Notify-only: the compatibility gate rejected a connection. Lets the wallet surface the reason
   *  in its UI. Does NOT affect the decision (the host already decided). `silent` is true for
   *  auto-connect attempts — the wallet should not show UI for those. */
  onConnectionRejected?: (dapp: DAppMetadata | undefined, error: SphereRpcError, silent?: boolean) => void;

  /** Session time-to-live in ms. Default: 86400000 (24h). 0 = no expiry. */
  sessionTtlMs?: number;

  /** Optional secondary npm-SDK floor (rarely needed — the Connect protocol version is the era gate). */
  minSdkVersion?: string;
  /** Optional MINOR floor within the current Connect MAJOR. */
  minMinorVersion?: number;

  /** Max requests per second per session. Default: 20. */
  maxRequestsPerSecond?: number;
}

// =============================================================================
// ConnectClient Config
// =============================================================================

export interface ConnectClientConfig {
  /** Transport layer for communication */
  transport: ConnectTransport;

  /** dApp metadata sent during handshake */
  dapp: DAppMetadata;

  /** Permissions to request. Defaults to all. */
  permissions?: PermissionScope[];

  /** Timeout for query requests in ms. Default: 30000. */
  timeout?: number;

  /** Timeout for intent requests in ms (user interaction). Default: 120000. */
  intentTimeout?: number;

  /** Existing session ID to resume. If the host still has an active session
   *  with this ID, the connection is restored without re-showing the approval UI. */
  resumeSessionId?: string;

  /** If true, the connection will silently fail if the origin is not already approved by the wallet.
   *  No approval UI will be shown. Used for auto-connect on page load. */
  silent?: boolean;

  /** The network this dApp is built for. Sent in the handshake; the wallet rejects a mismatch
   *  with INCOMPATIBLE_NETWORK. */
  network?: NetworkInfo;
}

// =============================================================================
// ConnectClient Result Types
// =============================================================================

export interface ConnectResult {
  readonly sessionId: string;
  readonly permissions: PermissionScope[];
  readonly identity: PublicIdentity;
}

// =============================================================================
// Event Handler Type
// =============================================================================

export type ConnectEventHandler = (data: unknown) => void;

// =============================================================================
// Re-exports for convenience
// =============================================================================

export type { DAppMetadata, PublicIdentity, SphereConnectMessage, NetworkInfo, SphereRpcError } from './protocol';
