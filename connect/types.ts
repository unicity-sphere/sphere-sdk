/**
 * Sphere Connect Types
 * Session, configuration, and callback types.
 */

import type { SphereConnectMessage, DAppMetadata, PublicIdentity } from './protocol';
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
  ) => Promise<{ approved: boolean; grantedPermissions: PermissionScope[] }>;

  /** Called when dApp sends an intent. Wallet opens corresponding UI. */
  onIntent: (
    action: string,
    params: Record<string, unknown>,
    session: ConnectSession,
  ) => Promise<{ result?: unknown; error?: { code: number; message: string } }>;

  /** Called when dApp explicitly disconnects. Wallet can revoke persisted permissions. */
  onDisconnect?: (session: ConnectSession) => void | Promise<void>;

  /** Session time-to-live in ms. Default: 86400000 (24h). 0 = no expiry. */
  sessionTtlMs?: number;

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

export type { DAppMetadata, PublicIdentity, SphereConnectMessage } from './protocol';
