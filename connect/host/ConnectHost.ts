/**
 * ConnectHost — Wallet side of Sphere Connect.
 *
 * Wraps a Sphere instance and exposes its API through a ConnectTransport.
 * Handles permission checking, rate limiting, session management,
 * and delegates intents to the wallet app via callbacks.
 */

import { logger } from '../../core/logger';
import { SphereError } from '../../core/errors';
import type { SphereEventType, SphereEventHandler } from '../../types';
import type {
  ConnectTransport,
  ConnectSession,
  ConnectHostConfig,
  WalletState,
  LockedRequestContext,
  IntentContext,
} from '../types';
import type {
  SphereConnectMessage,
  SphereRpcRequest,
  SphereIntentRequest,
  SphereHandshake,
  PublicIdentity,
  SphereRpcError,
  NetworkInfo,
} from '../protocol';
import {
  SPHERE_CONNECT_NAMESPACE,
  SPHERE_CONNECT_VERSION,
  RPC_METHODS,
  ERROR_CODES,
  WALLET_EVENTS,
  createRequestId,
} from '../protocol';
import { checkCompatibility } from '../compatibility';
import { SDK_VERSION } from '../version';
import {
  DEFAULT_PERMISSIONS,
  hasMethodPermission,
  hasIntentPermission,
} from '../permissions';
import type { PermissionScope } from '../permissions';
import type { SphereInstance, ConnectDirectMessage } from './SphereInstance';
import {
  assertWalletTransition,
  gate,
  WALLET_LOCKED_MESSAGE,
  INTERNAL_ERROR_MESSAGE,
  NOT_CONNECTED_MESSAGE,
} from './host-state';
import type { WalletSnapshot } from './WalletSnapshot';
import { EMPTY_WALLET_SNAPSHOT, buildWalletSnapshot } from './WalletSnapshot';
import { InFlightRegistry } from './InFlightRegistry';
import type { InFlightEntry } from './InFlightRegistry';

const DEFAULT_SESSION_TTL_MS = 86400000; // 24 hours
const DEFAULT_MAX_RPS = 20;
const DEFAULT_REQUEST_DEADLINE_MS = 25000;
const DEFAULT_INTENT_DEADLINE_MS = 90000;
const DEFAULT_HANDSHAKE_DEADLINE_MS = 120000;

export class ConnectHost {
  /** Null whenever _walletState is 'locked' or 'unavailable' (invariant B). */
  private sphere: SphereInstance | null;

  /** The wallet-binding axis. Underscored because `walletState` is the public getter.
   *  ORTHOGONAL to `session` — a locked wallet keeps its session, a live wallet may have
   *  none. Written only by the WALLET (setLocked / setUnavailable / updateSphere / destroy);
   *  `session` is written by the dApp handshake, sphere_disconnect and expiry. */
  private _walletState: WalletState;

  /** Immutable public facts about the current binding. Refreshed on every bind
   *  (constructor, updateSphere); FROZEN by setLocked(); EMPTY after setUnavailable() and
   *  destroy(). Never read from Sphere while locked — that is a property of the types
   *  here, not of code review. */
  private snapshot: WalletSnapshot;

  /** Subscription KEYS captured by setLocked() BEFORE the unsub closures are detached.
   *  Sphere.destroy() kills those closures, so the keys are the only recoverable
   *  information. Excludes 'identity:changed' (autoSubscribeIdentityChanged re-arms it).
   *  A Set, not an array: handleSubscribe may be called twice for the same key while
   *  locked. */
  private suspendedSubscriptions: Set<string> = new Set();

  /** Every accepted id, with its own host-side timer. The single convergence point for
   *  lock / revoke / unavailable / destroy / deadline. */
  private readonly inFlight: InFlightRegistry;

  private readonly transport: ConnectTransport;
  private readonly config: ConnectHostConfig;

  private session: ConnectSession | null = null;
  private grantedPermissions: Set<string> = new Set();

  // Event subscription management
  private eventSubscriptions: Map<string, () => void> = new Map(); // eventName → unsub

  // Intent auto-approve: action → handler that bypasses wallet UI
  private autoApprovedIntents = new Map<
    string,
    (action: string, params: Record<string, unknown>, session: ConnectSession) => Promise<{ result?: unknown; error?: { code: number; message: string } }>
  >();

  // Rate limiting
  private rateLimitCounter = 0;
  private rateLimitResetAt = 0;

  private unsubscribeTransport: (() => void) | null = null;

  constructor(config: ConnectHostConfig) {
    this.transport = config.transport;
    this.config = config;

    this._walletState = config.initialWalletState ?? 'live';
    this.sphere = (config.sphere ?? null) as SphereInstance | null;
    if (this._walletState === 'live' && !this.sphere) {
      // Fail LOUD but soft: a throw here breaks the wallet's React mount.
      logger.warn(
        'ConnectHost',
        'Constructed live with sphere === null; coercing to unavailable. ' +
          'Pass initialWalletState: "locked" when the wallet is locked at construction time.',
      );
      this._walletState = 'unavailable';
    }
    if (this._walletState !== 'live') this.sphere = null; // invariant B, unconditionally
    this.snapshot = buildWalletSnapshot(this.sphere);      // EMPTY_WALLET_SNAPSHOT when null

    this.inFlight = new InFlightRegistry({ onExpire: (e) => this.settleExpired(e) });

    this.unsubscribeTransport = this.transport.onMessage(this.handleMessage.bind(this));
  }

  /** The wallet-binding axis. Orthogonal to {@link getSession}. Read-only —
   *  transitions go through setLocked() / setUnavailable() / updateSphere(). */
  get walletState(): WalletState {
    return this._walletState;
  }

  /** Both axes in one read, for UI that must render "connected AND locked".
   *  Required by the wallet's ConnectPage, which today renders a green pulsing
   *  "Connected to {dapp}" with no regard for lock state. */
  getState(): { readonly walletState: WalletState; readonly session: ConnectSession | null } {
    return { walletState: this._walletState, session: this.session };
  }

  /** Get current active session */
  getSession(): ConnectSession | null {
    return this.session;
  }

  /** Register an auto-approve handler for an intent action (session-scoped). */
  setIntentAutoApprove(
    action: string,
    handler: (
      action: string,
      params: Record<string, unknown>,
      session: ConnectSession,
    ) => Promise<{ result?: unknown; error?: { code: number; message: string } }>,
  ): void {
    this.autoApprovedIntents.set(action, handler);
  }

  /** Remove auto-approve for an intent action. */
  clearIntentAutoApprove(action: string): void {
    this.autoApprovedIntents.delete(action);
  }

  /**
   * Update the Sphere instance (e.g. user switched address — new Sphere created).
   * Re-subscribes auto-push events and notifies connected dApp of the new identity.
   */
  updateSphere(newSphere: unknown): void {
    this.sphere = newSphere as SphereInstance;

    // Re-subscribe identity:changed on the new Sphere instance
    const existing = this.eventSubscriptions.get(WALLET_EVENTS.IDENTITY_CHANGED);
    if (existing) {
      existing();
      this.eventSubscriptions.delete(WALLET_EVENTS.IDENTITY_CHANGED);
    }
    if (this.session?.active) {
      this.autoSubscribeIdentityChanged();
      // Push the new identity immediately so dApp doesn't have to wait for the next event
      const identity = this.getPublicIdentity();
      if (identity) {
        this.pushClientEvent(WALLET_EVENTS.IDENTITY_CHANGED, identity);
      }
    }
  }

  /** Revoke the current session */
  revokeSession(): void {
    if (this.session) {
      this.session.active = false;
      this.cleanupEventSubscriptions();
      this.autoApprovedIntents.clear();
      this.session = null;
      this.grantedPermissions.clear();
    }
  }

  /**
   * Notify connected dApp that wallet is locked/logged out, then revoke session.
   * Call this BEFORE destroy() when the wallet locks so the dApp gets a clean signal
   * instead of receiving NOT_CONNECTED errors on the next request.
   */
  notifyWalletLocked(): void {
    if (this.session?.active) {
      this.pushClientEvent(WALLET_EVENTS.LOCKED, {});
    }
    this.revokeSession();
  }

  /** Destroy the host, clean up all resources */
  destroy(): void {
    this.revokeSession();
    if (this.unsubscribeTransport) {
      this.unsubscribeTransport();
      this.unsubscribeTransport = null;
    }
  }

  // ===========================================================================
  // Message Handling
  // ===========================================================================

  private async handleMessage(msg: SphereConnectMessage): Promise<void> {
    try {
      if (msg.type === 'handshake' && msg.direction === 'request') {
        await this.handleHandshake(msg);
        return;
      }

      if (msg.type === 'request') {
        await this.handleRpcRequest(msg);
        return;
      }

      if (msg.type === 'intent') {
        await this.handleIntentRequest(msg);
        return;
      }
    } catch (error) {
      // Swallow errors from malformed messages
      logger.warn('ConnectHost', 'Error handling message:', error);
    }
  }

  // ===========================================================================
  // Handshake
  // ===========================================================================

  private async handleHandshake(msg: SphereHandshake): Promise<void> {
    const dapp = msg.dapp;
    // A handshake without dapp metadata is malformed — deny silently (no session).
    // The compatibility gate and onConnectionRejected are intentionally not consulted
    // here: there is no app to gate or to surface a rejection reason for.
    if (!dapp) {
      this.sendHandshakeResponse([], undefined, undefined);
      return;
    }

    // Compatibility gate — runs BEFORE resume and BEFORE onConnectionRequest, so an
    // incompatible/old client cannot slip through on a stale sessionId.
    const result = checkCompatibility({
      clientProtocol: msg.v,
      walletProtocol: SPHERE_CONNECT_VERSION,
      clientNetwork: msg.network,
      walletNetworkId: this.snapshot.networkId ?? -1,
      minMinor: this.config.minMinorVersion,
      clientSdkVersion: msg.sdkVersion,
      minSdkVersion: this.config.minSdkVersion,
    });
    if (!result.ok) {
      logger.warn('ConnectHost', 'Rejected handshake', {
        dapp: dapp.name,
        reason: (result.error.data as { reason?: string } | undefined)?.reason,
        clientProtocol: msg.v,
        walletProtocol: SPHERE_CONNECT_VERSION,
        clientNetwork: msg.network ?? null,
        walletNetwork: this.snapshot.networkId ?? null,
      });
      this.config.onConnectionRejected?.(dapp, result.error, !!msg.silent);
      this.sendHandshakeResponse([], undefined, undefined, result.error, msg.v);
      return;
    }

    const clientInfo = { protocolVersion: msg.v, network: msg.network, sdkVersion: msg.sdkVersion };

    // Session resumption: if the client presents a valid existing sessionId,
    // skip the approval popup and restore the session without user interaction.
    if (msg.sessionId && this.session?.active && this.session.id === msg.sessionId) {
      const identity = this.getPublicIdentity();
      this.sendHandshakeResponse([...this.grantedPermissions], this.session.id, identity);
      return;
    }

    const requestedPermissions = msg.permissions as PermissionScope[];

    const { approved, grantedPermissions } = await this.config.onConnectionRequest(
      dapp,
      requestedPermissions,
      msg.silent,
      clientInfo,
    );

    if (!approved) {
      this.sendHandshakeResponse([], undefined, undefined);
      return;
    }

    // Create session
    const sessionId = createRequestId();
    const allPermissions = [...new Set([...DEFAULT_PERMISSIONS, ...grantedPermissions])];
    const ttl = this.config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;

    this.session = {
      id: sessionId,
      dapp,
      permissions: allPermissions,
      createdAt: Date.now(),
      expiresAt: ttl > 0 ? Date.now() + ttl : 0,
      active: true,
    };
    this.grantedPermissions = new Set(allPermissions);

    // Auto-push identity:changed to dApp whenever the wallet switches address.
    // MetaMask pattern: no sphere_subscribe needed — host pushes it unconditionally.
    this.autoSubscribeIdentityChanged();

    // Build public identity
    const identity = this.getPublicIdentity();

    this.sendHandshakeResponse(allPermissions, sessionId, identity);
  }

  // `warning` is a forward-compatible deprecation-notice slot (see SphereHandshake.warning);
  // no call site emits one yet — reserved for the deprecation-window policy.
  private sendHandshakeResponse(
    permissions: string[],
    sessionId: string | undefined,
    identity: PublicIdentity | undefined,
    error?: SphereRpcError,
    echoV?: string,
    warning?: SphereRpcError,
  ): void {
    const network: NetworkInfo | undefined =
      typeof this.snapshot.networkId === 'number' ? { id: this.snapshot.networkId } : undefined;
    this.transport.send({
      ns: SPHERE_CONNECT_NAMESPACE,
      v: (error && echoV ? echoV : SPHERE_CONNECT_VERSION) as typeof SPHERE_CONNECT_VERSION,
      type: 'handshake',
      direction: 'response',
      permissions,
      sessionId,
      identity,
      network,
      sdkVersion: SDK_VERSION,
      error,
      warning,
    });
  }

  // ===========================================================================
  // RPC Requests (query)
  // ===========================================================================

  private async handleRpcRequest(msg: SphereRpcRequest): Promise<void> {
    // Session check
    if (!this.session?.active) {
      this.sendError(msg.id, ERROR_CODES.NOT_CONNECTED, 'Not connected');
      return;
    }

    // Session expiry
    if (this.session.expiresAt > 0 && Date.now() > this.session.expiresAt) {
      this.revokeSession();
      this.sendError(msg.id, ERROR_CODES.SESSION_EXPIRED, 'Session expired');
      return;
    }

    // Rate limit
    if (!this.checkRateLimit()) {
      this.sendError(msg.id, ERROR_CODES.RATE_LIMITED, 'Too many requests');
      return;
    }

    // Handle disconnect
    if (msg.method === RPC_METHODS.DISCONNECT) {
      const disconnectedSession = this.session;
      this.revokeSession();
      this.sendResult(msg.id, { disconnected: true });
      if (disconnectedSession && this.config.onDisconnect) {
        // Fire-and-forget: don't block the response
        Promise.resolve(this.config.onDisconnect(disconnectedSession)).catch((err) => logger.warn('Connect', 'onDisconnect handler error', err));
      }
      return;
    }

    // Permission check
    if (!hasMethodPermission(this.grantedPermissions, msg.method)) {
      this.sendError(msg.id, ERROR_CODES.PERMISSION_DENIED, `Permission denied for ${msg.method}`);
      return;
    }

    try {
      const result = await this.executeMethod(msg.method, msg.params ?? {});
      this.sendResult(msg.id, result);
    } catch (error) {
      this.sendError(msg.id, ERROR_CODES.INTERNAL_ERROR, (error as Error).message);
    }
  }

  // ===========================================================================
  // Intent Requests
  // ===========================================================================

  private async handleIntentRequest(msg: SphereIntentRequest): Promise<void> {
    // Session check
    if (!this.session?.active) {
      this.sendIntentError(msg.id, ERROR_CODES.NOT_CONNECTED, 'Not connected');
      return;
    }

    // Session expiry
    if (this.session.expiresAt > 0 && Date.now() > this.session.expiresAt) {
      this.revokeSession();
      this.sendIntentError(msg.id, ERROR_CODES.SESSION_EXPIRED, 'Session expired');
      return;
    }

    // Permission check
    if (!hasIntentPermission(this.grantedPermissions, msg.action)) {
      this.sendIntentError(msg.id, ERROR_CODES.PERMISSION_DENIED, `Permission denied for intent: ${msg.action}`);
      return;
    }

    // Check auto-approve before delegating to wallet UI
    const autoHandler = this.autoApprovedIntents.get(msg.action);
    if (autoHandler) {
      const autoResponse = await autoHandler(msg.action, msg.params, this.session);
      if (autoResponse.error) {
        this.sendIntentError(msg.id, autoResponse.error.code, autoResponse.error.message);
      } else {
        this.sendIntentResult(msg.id, autoResponse.result);
      }
      return;
    }

    // Delegate to wallet app
    const response = await this.config.onIntent(msg.action, msg.params, this.session);

    if (response.error) {
      this.sendIntentError(msg.id, response.error.code, response.error.message);
    } else {
      this.sendIntentResult(msg.id, response.result);
    }
  }

  // ===========================================================================
  // Method Router
  // ===========================================================================

  private async executeMethod(method: string, params: Record<string, unknown>): Promise<unknown> {
    // ONE dereference for the whole router. The gate has already proven _walletState is
    // 'live' before we get here, so this is defence in depth — and it is what makes the
    // nullable field compile without a single `!`.
    const sphere = this.requireSphere();
    switch (method) {
      case RPC_METHODS.GET_IDENTITY:
        return this.getPublicIdentity();

      case RPC_METHODS.GET_BALANCE:
        return sphere.payments.getBalance(params.coinId as string | undefined);

      case RPC_METHODS.GET_ASSETS:
        return sphere.payments.getAssets(params.coinId as string | undefined);

      case RPC_METHODS.GET_FIAT_BALANCE:
        return { fiatBalance: await sphere.payments.getFiatBalance() };

      case RPC_METHODS.GET_TOKENS:
        return this.stripTokenSdkData(
          sphere.payments.getTokens(
            params.coinId ? { coinId: params.coinId as string } : undefined,
          ),
        );

      case RPC_METHODS.GET_HISTORY:
        return sphere.payments.getHistory();

      case RPC_METHODS.RESOLVE:
        if (!params.identifier) {
          throw new SphereError('Missing required parameter: identifier', 'VALIDATION_ERROR');
        }
        return sphere.resolve(params.identifier as string);

      case RPC_METHODS.SUBSCRIBE:
        return this.handleSubscribe(params.event as string);

      case RPC_METHODS.UNSUBSCRIBE:
        return this.handleUnsubscribe(params.event as string);

      case RPC_METHODS.GET_CONVERSATIONS: {
        const comms = sphere.communications;
        if (!comms) throw new SphereError('Communications module not available', 'MODULE_NOT_AVAILABLE');
        const convos = comms.getConversations();
        const result: Array<{
          peerPubkey: string;
          peerNametag?: string;
          lastMessage: ConnectDirectMessage;
          unreadCount: number;
          messageCount: number;
        }> = [];
        // Collect conversations and track which ones need nametag resolution
        const needsResolve: Array<{ index: number; peerPubkey: string }> = [];
        for (const [peer, messages] of convos) {
          if (messages.length === 0) continue;
          const last = messages[messages.length - 1];
          // Find peer nametag from any message in the conversation
          const peerNametag =
            messages.find(m => m.senderPubkey === peer && m.senderNametag)?.senderNametag
            ?? messages.find(m => m.recipientPubkey === peer && m.recipientNametag)?.recipientNametag;
          const idx = result.length;
          result.push({
            peerPubkey: peer,
            peerNametag,
            lastMessage: last,
            unreadCount: comms.getUnreadCount(peer),
            messageCount: messages.length,
          });
          if (!peerNametag) {
            needsResolve.push({ index: idx, peerPubkey: peer });
          }
        }
        // Resolve missing nametags via transport (parallel, best-effort)
        if (needsResolve.length > 0) {
          const resolved = await Promise.all(
            needsResolve.map(({ peerPubkey }) =>
              comms.resolvePeerNametag(peerPubkey).catch((err) => { logger.debug('Connect', 'Peer Unicity ID resolution failed', err); return undefined; }),
            ),
          );
          for (let i = 0; i < needsResolve.length; i++) {
            if (resolved[i]) {
              result[needsResolve[i].index].peerNametag = resolved[i];
            }
          }
        }
        result.sort((a, b) => b.lastMessage.timestamp - a.lastMessage.timestamp);
        return result;
      }

      case RPC_METHODS.GET_MESSAGES: {
        const comms = sphere.communications;
        if (!comms) throw new SphereError('Communications module not available', 'MODULE_NOT_AVAILABLE');
        if (!params.peerPubkey) throw new SphereError('Missing required parameter: peerPubkey', 'VALIDATION_ERROR');
        return comms.getConversationPage(
          params.peerPubkey as string,
          {
            limit: params.limit as number | undefined,
            before: params.before as number | undefined,
          },
        );
      }

      case RPC_METHODS.GET_DM_UNREAD_COUNT: {
        const comms = sphere.communications;
        if (!comms) throw new SphereError('Communications module not available', 'MODULE_NOT_AVAILABLE');
        return {
          unreadCount: comms.getUnreadCount(
            params.peerPubkey as string | undefined,
          ),
        };
      }

      case RPC_METHODS.MARK_AS_READ: {
        const comms = sphere.communications;
        if (!comms) throw new SphereError('Communications module not available', 'MODULE_NOT_AVAILABLE');
        if (!params.messageIds || !Array.isArray(params.messageIds)) {
          throw new SphereError('Missing required parameter: messageIds (string[])', 'VALIDATION_ERROR');
        }
        await comms.markAsRead(params.messageIds as string[]);
        return { marked: true, count: (params.messageIds as string[]).length };
      }

      case RPC_METHODS.GET_INVOICES: {
        const accounting = sphere.accounting;
        if (!accounting) throw new SphereError('Accounting module not available', 'MODULE_NOT_AVAILABLE');
        // W23-R2 fix: Extract only known fields to prevent unsanitized dApp params
        // from reaching the module (defense-in-depth).
        const invoiceOpts: Record<string, unknown> = {};
        if (params.state !== undefined) invoiceOpts.state = params.state;
        if (params.limit !== undefined) invoiceOpts.limit = params.limit;
        if (params.offset !== undefined) invoiceOpts.offset = params.offset;
        if (params.sortBy !== undefined) invoiceOpts.sortBy = params.sortBy;
        if (params.sortOrder !== undefined) invoiceOpts.sortOrder = params.sortOrder;
        if (params.createdByMe !== undefined) invoiceOpts.createdByMe = params.createdByMe;
        if (params.targetingMe !== undefined) invoiceOpts.targetingMe = params.targetingMe;
        return accounting.getInvoices(invoiceOpts);
      }

      case RPC_METHODS.GET_INVOICE_STATUS: {
        const accounting = sphere.accounting;
        if (!accounting) throw new SphereError('Accounting module not available', 'MODULE_NOT_AVAILABLE');
        if (!params.invoiceId || typeof params.invoiceId !== 'string') {
          throw new SphereError('Missing required parameter: invoiceId', 'VALIDATION_ERROR');
        }
        return accounting.getInvoiceStatus(params.invoiceId as string);
      }

      default:
        throw new SphereError(`Unknown method: ${method}`, 'VALIDATION_ERROR');
    }
  }

  // ===========================================================================
  // Event Subscriptions
  // ===========================================================================

  private autoSubscribeIdentityChanged(): void {
    if (this.eventSubscriptions.has(WALLET_EVENTS.IDENTITY_CHANGED)) return;
    const unsub = this.requireSphere().on('identity:changed' as SphereEventType, (data: unknown) => {
      this.pushClientEvent(WALLET_EVENTS.IDENTITY_CHANGED, data);
    });
    this.eventSubscriptions.set(WALLET_EVENTS.IDENTITY_CHANGED, unsub);
  }

  private handleSubscribe(eventName: string): { subscribed: boolean; event: string } {
    if (!eventName) throw new SphereError('Missing required parameter: event', 'VALIDATION_ERROR');

    if (this.eventSubscriptions.has(eventName)) {
      return { subscribed: true, event: eventName };
    }

    const unsub = this.requireSphere().on(eventName as SphereEventType, (data: unknown) => {
      this.transport.send({
        ns: SPHERE_CONNECT_NAMESPACE,
        v: SPHERE_CONNECT_VERSION,
        type: 'event',
        event: eventName,
        data,
      });
    });

    this.eventSubscriptions.set(eventName, unsub);
    return { subscribed: true, event: eventName };
  }

  private handleUnsubscribe(eventName: string): { unsubscribed: boolean; event: string } {
    if (!eventName) throw new SphereError('Missing required parameter: event', 'VALIDATION_ERROR');

    const unsub = this.eventSubscriptions.get(eventName);
    if (unsub) {
      unsub();
      this.eventSubscriptions.delete(eventName);
    }
    return { unsubscribed: true, event: eventName };
  }

  private cleanupEventSubscriptions(): void {
    for (const [, unsub] of this.eventSubscriptions) {
      unsub();
    }
    this.eventSubscriptions.clear();
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /** Push an event to the dApp without requiring a sphere_subscribe call. */
  private pushClientEvent(event: string, data: unknown): void {
    this.transport.send({
      ns: SPHERE_CONNECT_NAMESPACE,
      v: SPHERE_CONNECT_VERSION,
      type: 'event',
      event,
      data,
    });
  }

  /** The bound Sphere, or a typed refusal. The ONLY way the router may reach Sphere.
   *  Unreachable in practice — the gate guarantees 'live' before the router is entered —
   *  so this is defence in depth, not the primary mechanism. */
  private requireSphere(): SphereInstance {
    if (!this.sphere) {
      throw new SphereError(
        this._walletState === 'locked' ? WALLET_LOCKED_MESSAGE : 'Wallet unavailable',
        'NOT_INITIALIZED',
      );
    }
    return this.sphere;
  }

  /** SNAPSHOT read. `undefined` means "we never saw an identity": callers MUST refuse,
   *  never answer undefined-as-success — a dApp reads that as "the wallet has no
   *  identity". Two explicit methods instead of one dual-mode method, so nobody can serve
   *  a snapshot believing it is live. */
  private snapshotIdentity(): PublicIdentity | undefined {
    return this.snapshot.identity;
  }

  /** InFlightRegistry.onExpire sink. Filled in a later task; declared here so the
   *  constructor can wire it. */
  private settleExpired(entry: InFlightEntry): void {
    logger.warn('ConnectHost', `Request deadline reached: ${entry.kind} ${entry.id}`);
  }

  private getPublicIdentity(): PublicIdentity | undefined {
    const id = this.requireSphere().identity;
    if (!id) return undefined;
    return {
      chainPubkey: id.chainPubkey,
      directAddress: id.directAddress,
      nametag: id.nametag,
    };
  }

  private stripTokenSdkData(tokens: unknown[]): unknown[] {
    return tokens.map((t) => {
      const token = t as Record<string, unknown>;
      // Return all fields except internal sdkData
      const { sdkData: _sdkData, ...publicFields } = token;
      return publicFields;
    });
  }

  private sendResult(id: string, result: unknown): void {
    this.transport.send({
      ns: SPHERE_CONNECT_NAMESPACE,
      v: SPHERE_CONNECT_VERSION,
      type: 'response',
      id,
      result,
    });
  }

  private sendError(id: string, code: number, message: string): void {
    this.transport.send({
      ns: SPHERE_CONNECT_NAMESPACE,
      v: SPHERE_CONNECT_VERSION,
      type: 'response',
      id,
      error: { code, message },
    });
  }

  private sendIntentResult(id: string, result: unknown): void {
    this.transport.send({
      ns: SPHERE_CONNECT_NAMESPACE,
      v: SPHERE_CONNECT_VERSION,
      type: 'intent_result',
      id,
      result,
    });
  }

  private sendIntentError(id: string, code: number, message: string): void {
    this.transport.send({
      ns: SPHERE_CONNECT_NAMESPACE,
      v: SPHERE_CONNECT_VERSION,
      type: 'intent_result',
      id,
      error: { code, message },
    });
  }

  private checkRateLimit(): boolean {
    const maxRps = this.config.maxRequestsPerSecond ?? DEFAULT_MAX_RPS;
    const now = Date.now();
    if (now > this.rateLimitResetAt) {
      this.rateLimitCounter = 0;
      this.rateLimitResetAt = now + 1000;
    }
    this.rateLimitCounter++;
    return this.rateLimitCounter <= maxRps;
  }
}
