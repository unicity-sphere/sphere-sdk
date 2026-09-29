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

/**
 * Context handed to {@link ConnectHostConfig.onNetworkMismatch}. Unlike
 * {@link ConnectHostConfig.onConnectionRejected}, this one is asked BEFORE the host answers,
 * and the host waits for it.
 */
export interface NetworkMismatchContext {
  /** ConnectHostConfig.origin, when the wallet supplied one. NEVER the dApp-claimed
   *  `dapp.url`. A wallet that cannot name a verified origin should refuse: the prompt
   *  it would draw has nothing trustworthy to name. */
  readonly origin?: string;
  /** The wallet's own network, as the gate compared it. */
  readonly walletNetwork: NetworkInfo;
  /** The network the dApp declared. Never absent: a dApp that declared none is refused
   *  without ever reaching this hook. Take the network's IDENTITY from `id` alone. Any `name`
   *  here is text the dApp typed: the host copies it (at most 64 characters) but never
   *  vouches for it, so it must not be rendered as a label or used to pick a network. */
  readonly clientNetwork: NetworkInfo;
  /** Inline, like onConnectionRequest's clientInfo. There is no named ClientInfo type. */
  readonly clientProtocol: string;
  readonly clientSdkVersion?: string;
  /** Epoch ms after which the host answers on its own, with a refusal. */
  readonly expiresAt: number;
}

/** Answer to {@link ConnectHostConfig.onNetworkMismatch}. */
export type NetworkMismatchDecision =
  | { action: 'refuse' }
  /** The wallet is switching to `to`. `to.id` MUST equal the dApp's declared network id; the
   *  host compares the id and nothing else. */
  | { action: 'switch'; to: NetworkInfo };

// =============================================================================
// ConnectHost Config
// =============================================================================

export interface ConnectHostConfig {
  /** Sphere SDK instance to bridge. MAY be null (or omitted-as-null) when
   *  `initialWalletState` is 'locked' — the host never serves anything from a destroyed
   *  Sphere. A null sphere with initialWalletState 'live' is coerced to 'unavailable' with
   *  a logger.warn rather than throwing, because a throw here breaks the wallet's React
   *  mount. */
  sphere: unknown; // typed as unknown to avoid circular import; cast to Sphere in implementation

  /** Transport layer for communication */
  transport: ConnectTransport;

  /**
   * The origin this host serves, when the wallet knows it (e.g. 'https://app.example.com').
   * OPTIONAL and it stays optional: with the credential prompt gone, NO security decision
   * depends on it — it only labels a passive badge and log lines. Requiring it would break
   * the nodejs/ mock wallet host and any WebSocket host, neither of which has a browser
   * origin. When absent, the wallet's badge says "a connected app" and claims no origin.
   * Never confuse it with `session.dapp.url`, which is dApp-CLAIMED metadata.
   */
  origin?: string;

  /** Called when dApp requests connection. Wallet shows approval UI.
   *  When `silent` is true, the wallet must NOT open any UI — return rejected immediately if origin is unknown. */
  onConnectionRequest: (
    dapp: DAppMetadata,
    requestedPermissions: PermissionScope[],
    silent?: boolean,
    clientInfo?: { protocolVersion: string; network?: NetworkInfo; sdkVersion?: string },
  ) => Promise<{ approved: boolean; grantedPermissions: PermissionScope[] }>;

  /** Called when dApp sends an intent. Wallet opens corresponding UI.
   *  `ctx` (added in Connect 2.1) carries the host-side deadline and an AbortSignal:
   *  the wallet MUST dismiss its modal on abort, otherwise the host's own deadline
   *  manufactures the double-submit it was added to prevent.
   *  `error.data` reaches the dApp as `ConnectError.data`, unless the host downgrades the code. */
  onIntent: (
    action: string,
    params: Record<string, unknown>,
    session: ConnectSession,
    ctx?: IntentContext,
  ) => Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } }>;

  /** Called when dApp explicitly disconnects. Wallet can revoke persisted permissions. */
  onDisconnect?: (session: ConnectSession) => void | Promise<void>;

  /** Notify-only: the compatibility gate rejected a connection. Lets the wallet surface the reason
   *  in its UI. Does NOT affect the decision (the host already decided). `silent` is true when the
   *  dApp asked for a silent handshake (an auto-connect attempt), or the wallet is locked when the
   *  refusal is reported; the wallet should show no UI in either case. The lock is read at that
   *  moment, so one that lifted again before `onNetworkMismatch` resolved reports false. Not
   *  called when `onNetworkMismatch` answered 'switch', nor for the empty refusal the host sends
   *  when the wallet's network changes under that prompt. */
  onConnectionRejected?: (dapp: DAppMetadata | undefined, error: SphereRpcError, silent?: boolean) => void;

  /**
   * The handshake failed the NETWORK check and the wallet may be able to fix it by switching
   * networks. Asked BEFORE the dApp is answered, and awaited — this is the one gate callback
   * that can change what the host does next.
   *
   * It is never called for a protocol or SDK-version refusal, never for a dApp that declared
   * no network, never when the wallet does not know its own network, and never for a silent
   * or locked handshake.
   *
   * Return `{ action: 'switch', to }` only once the user has agreed; `to.id` must equal
   * `ctx.clientNetwork.id`, which is all the host compares. The dApp is answered identically
   * either way — the only difference is that `onConnectionRejected` is NOT called for a switch,
   * so the wallet does not paint an error beside the decision the user just took. Nothing
   * retries the 4008: the dApp, or the user, handshakes again once the wallet has switched.
   *
   * NAME THE NETWORK YOURSELF. The wallet gets the network's identity from
   * `ctx.clientNetwork.id` and looks its own label up for that id. A `name` on
   * `ctx.clientNetwork` is peer-declared text: the dApp chose it, nothing checks it against the
   * id, and rendering it as a label lets a dApp caption a prompt in its own words. It must not
   * be used as a label, in the prompt or anywhere else the user reads.
   *
   * RESOLVE BEFORE YOU RELOAD. A wallet that switches network by reloading the page must
   * resolve this promise first: the host still has to post its answer, and the reload tears
   * down the window that would post it.
   *
   * If the wallet's own network id CHANGES while this promise is pending, the dApp is answered
   * with the errorless empty refusal instead of the 4008, whatever this resolves, and
   * `onConnectionRejected` is skipped: the comparison the host made no longer holds. A change
   * is `updateSphere` rebinding to a Sphere on another network id, `setUnavailable()` or
   * `destroy()`; an `updateSphere` to the same network id is not one. `ConnectClient` does not
   * read that frame as "handshake again": `connect()` rejects with a bare
   * `Error('Connection rejected by wallet')` and never retries. Either the wallet posts
   * `HOST_READY` once it is bound to its new network, or the dApp retries by itself; the retry
   * is then answered against the network the wallet is on now.
   *
   * A throw, a rejection, a timeout, a wallet that is LOCKED when its answer is read, and an
   * answer whose `to.id` is not `ctx.clientNetwork.id` are refusals: the dApp gets the 4008 and
   * `onConnectionRejected` runs. A lock that lifted again to the same network before the answer
   * is read leaves a valid 'switch' standing. The timeout is `handshakeDeadlineMs` (default
   * 120 s).
   *
   * A LATE ANSWER IS IGNORED, YOUR SIDE EFFECTS ARE NOT. The hook gets no abort signal, only
   * `ctx.expiresAt`: after it passes the host has refused and moved on, but the promise the
   * wallet returned keeps running and whatever it does still happens. Nothing serialises
   * handshakes, so a dApp that connects again reaches the hook a second time. Check
   * `ctx.expiresAt` after the user answers and before acting, or make the switch idempotent.
   */
  onNetworkMismatch?: (
    dapp: DAppMetadata,
    ctx: NetworkMismatchContext,
  ) => Promise<NetworkMismatchDecision> | NetworkMismatchDecision;

  /**
   * Notify-only: the host has just answered WALLET_LOCKED (4009) to a query or intent, or
   * accepted a session resume while locked. It is not called for a refused handshake.
   * The host has ALREADY answered and never waits for this callback;
   * throwing from it must not break the host (the host wraps the call in try/catch).
   *
   * THIS MUST NOT RAISE A CREDENTIAL SURFACE. A dApp request may trigger a CONSENT
   * prompt; it may never trigger a password field. The wallet's only permitted reaction
   * is a PASSIVE badge in its PERMANENT chrome ("N requests waiting — Unlock"); the
   * password field appears only after a human clicks it. Volume is already bounded by
   * checkRateLimit(), which now guards all three entry points — there is no second
   * anti-spam mechanism, no coalescing, no cooldown and no cap by design.
   *
   * Also the natural telemetry seam.
   */
  onLockedRequest?: (ctx: LockedRequestContext) => void;

  /** Session time-to-live in ms. Default: 86400000 (24h). 0 = no expiry. */
  sessionTtlMs?: number;

  /**
   * The wallet-binding state the host starts in. Default: 'live'.
   * Pass 'locked' when constructing a host while the wallet is already locked (cold start
   * with an encrypted wallet: initialize() takes the classifyInitFailure === 'locked'
   * branch and returns without setting Sphere) — otherwise the host starts 'live' with
   * `sphere: null` and dereferences null on the first request.
   * 'unavailable' is not constructible: use setUnavailable() after construction.
   */
  initialWalletState?: 'live' | 'locked';

  /** Optional npm-SDK floor for dApps. Replaces the default floor (DEFAULT_MIN_CLIENT_SDK_VERSION,
   *  '0.14.1-0') rather than adding to it, so a lower value admits older dApps again; never set it lower. */
  minSdkVersion?: string;
  /** Optional MINOR floor within the current Connect MAJOR. */
  minMinorVersion?: number;

  /** Max requests per second per session. Default: 20. */
  maxRequestsPerSecond?: number;

  /** Host-side deadline for a query, in ms. Default: 25000. The host answers within it
   *  no matter what the router does. */
  requestDeadlineMs?: number;
  /** Host-side deadline for an intent, in ms. Default: 180000 — deliberately longer than
   *  ConnectClient's own 120 s intentTimeout, so the host is never the first to give up.
   *  Fires INTENT_OUTCOME_UNKNOWN (4201), never INTENT_CANCELLED: the wallet may already
   *  have submitted the transfer. It also aborts ctx.signal — it must cancel, not merely
   *  answer. */
  intentDeadlineMs?: number;
  /** Host-side deadline for onConnectionRequest and for onNetworkMismatch, in ms. Default:
   *  120000. A handshake carries no id, so an onConnectionRequest expiry sends the empty
   *  refusal, while an onNetworkMismatch expiry is a refusal carrying the 4008. */
  handshakeDeadlineMs?: number;
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

  /** Timeout in ms for query requests and for connect(). Default: 30000. The handshake answer waits
   *  for the user's approval, so a non-silent connect() rejects with 'Connection timeout' when the
   *  user takes longer than this. */
  timeout?: number;

  /** Timeout for intent requests in ms (user interaction). Default: 120000. */
  intentTimeout?: number;

  /** Existing session ID to resume. If the host still has an active session
   *  with this ID, the connection is restored without re-showing the approval UI. */
  resumeSessionId?: string;

  /** If true, the connection will silently fail if the origin is not already approved by the wallet.
   *  No approval UI will be shown. Used for auto-connect on page load. */
  silent?: boolean;

  /** The network this dApp is built for. Sent in the handshake; **required at runtime** —
   *  optional in the type only for backward compatibility. A handshake without it, or with a
   *  different network id than the wallet's, is rejected with INCOMPATIBLE_NETWORK (4008)
   *  before any UI appears. Use SPHERE_NETWORKS.mainnet / SPHERE_NETWORKS.testnet2. */
  network?: NetworkInfo;
}

// =============================================================================
// ConnectClient Result Types
// =============================================================================

export interface ConnectResult {
  readonly sessionId: string;
  readonly permissions: PermissionScope[];
  readonly identity: PublicIdentity;
  /** True when the wallet is locked but the session is alive — a resume during a lock,
   *  the most common entry into this feature. Requests answer 4009 until wallet:unlocked. */
  readonly locked?: boolean;
}

// =============================================================================
// Event Handler Type
// =============================================================================

export type ConnectEventHandler = (data: unknown) => void;

// =============================================================================
// Re-exports for convenience
// =============================================================================

export type { DAppMetadata, PublicIdentity, SphereConnectMessage, NetworkInfo, SphereRpcError } from './protocol';
