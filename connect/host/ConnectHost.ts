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
import type { ConnectTransport, ConnectSession, ConnectHostConfig } from '../types';
import type {
  SphereConnectMessage,
  SphereRpcRequest,
  SphereIntentRequest,
  SphereHandshake,
  PublicIdentity,
} from '../protocol';
import {
  SPHERE_CONNECT_NAMESPACE,
  SPHERE_CONNECT_VERSION,
  RPC_METHODS,
  ERROR_CODES,
  createRequestId,
} from '../protocol';
import {
  DEFAULT_PERMISSIONS,
  hasMethodPermission,
  hasIntentPermission,
} from '../permissions';
import type { PermissionScope } from '../permissions';

// Use a minimal interface for the Sphere dependency to avoid circular imports.
// ConnectHost only needs these public methods from Sphere.
interface SphereInstance {
  readonly identity: { chainPubkey: string; l1Address: string; directAddress?: string; nametag?: string } | null;
  readonly payments: {
    getBalance(coinId?: string): unknown[];
    getAssets(coinId?: string): Promise<unknown[]>;
    getFiatBalance(): Promise<number | null>;
    getTokens(filter?: { coinId?: string }): unknown[];
    getHistory(): unknown[];
    readonly l1?: {
      getBalance(): Promise<unknown>;
      getHistory(limit?: number): Promise<unknown[]>;
    };
  };
  resolve(identifier: string): Promise<unknown>;
  on<T extends SphereEventType>(type: T, handler: SphereEventHandler<T>): () => void;
  readonly communications?: {
    getConversations(): Map<string, ConnectDirectMessage[]>;
    getConversationPage(
      peerPubkey: string,
      options?: { limit?: number; before?: number },
    ): { messages: ConnectDirectMessage[]; hasMore: boolean; oldestTimestamp: number | null };
    getUnreadCount(peerPubkey?: string): number;
    markAsRead(messageIds: string[]): Promise<void>;
    sendDM(recipient: string, content: string): Promise<ConnectDirectMessage>;
    resolvePeerNametag(peerPubkey: string): Promise<string | undefined>;
  };
}

/** Minimal DM type to avoid circular imports with Sphere core types. */
interface ConnectDirectMessage {
  readonly id: string;
  readonly senderPubkey: string;
  readonly senderNametag?: string;
  readonly recipientPubkey: string;
  readonly recipientNametag?: string;
  readonly content: string;
  readonly timestamp: number;
  isRead: boolean;
}

const DEFAULT_SESSION_TTL_MS = 86400000; // 24 hours
const DEFAULT_MAX_RPS = 20;

export class ConnectHost {
  private readonly sphere: SphereInstance;
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
    this.sphere = config.sphere as SphereInstance;
    this.transport = config.transport;
    this.config = config;

    this.unsubscribeTransport = this.transport.onMessage(this.handleMessage.bind(this));
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
    if (!dapp) {
      this.sendHandshakeResponse([], undefined, undefined);
      return;
    }

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

    // Build public identity
    const identity = this.getPublicIdentity();

    this.sendHandshakeResponse(allPermissions, sessionId, identity);
  }

  private sendHandshakeResponse(
    permissions: string[],
    sessionId: string | undefined,
    identity: PublicIdentity | undefined,
  ): void {
    this.transport.send({
      ns: SPHERE_CONNECT_NAMESPACE,
      v: SPHERE_CONNECT_VERSION,
      type: 'handshake',
      direction: 'response',
      permissions,
      sessionId,
      identity,
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
        Promise.resolve(this.config.onDisconnect(disconnectedSession)).catch(console.warn);
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
    switch (method) {
      case RPC_METHODS.GET_IDENTITY:
        return this.getPublicIdentity();

      case RPC_METHODS.GET_BALANCE:
        return this.sphere.payments.getBalance(params.coinId as string | undefined);

      case RPC_METHODS.GET_ASSETS:
        return this.sphere.payments.getAssets(params.coinId as string | undefined);

      case RPC_METHODS.GET_FIAT_BALANCE:
        return { fiatBalance: await this.sphere.payments.getFiatBalance() };

      case RPC_METHODS.GET_TOKENS:
        return this.stripTokenSdkData(
          this.sphere.payments.getTokens(
            params.coinId ? { coinId: params.coinId as string } : undefined,
          ),
        );

      case RPC_METHODS.GET_HISTORY:
        return this.sphere.payments.getHistory();

      case RPC_METHODS.L1_GET_BALANCE:
        if (!this.sphere.payments.l1) {
          throw new SphereError('L1 module not available', 'MODULE_NOT_AVAILABLE');
        }
        return this.sphere.payments.l1.getBalance();

      case RPC_METHODS.L1_GET_HISTORY:
        if (!this.sphere.payments.l1) {
          throw new SphereError('L1 module not available', 'MODULE_NOT_AVAILABLE');
        }
        return this.sphere.payments.l1.getHistory(params.limit as number | undefined);

      case RPC_METHODS.RESOLVE:
        if (!params.identifier) {
          throw new SphereError('Missing required parameter: identifier', 'VALIDATION_ERROR');
        }
        return this.sphere.resolve(params.identifier as string);

      case RPC_METHODS.SUBSCRIBE:
        return this.handleSubscribe(params.event as string);

      case RPC_METHODS.UNSUBSCRIBE:
        return this.handleUnsubscribe(params.event as string);

      case RPC_METHODS.GET_CONVERSATIONS: {
        if (!this.sphere.communications) throw new SphereError('Communications module not available', 'MODULE_NOT_AVAILABLE');
        const convos = this.sphere.communications.getConversations();
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
            unreadCount: this.sphere.communications.getUnreadCount(peer),
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
              this.sphere.communications!.resolvePeerNametag(peerPubkey).catch(() => undefined),
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
        if (!this.sphere.communications) throw new SphereError('Communications module not available', 'MODULE_NOT_AVAILABLE');
        if (!params.peerPubkey) throw new SphereError('Missing required parameter: peerPubkey', 'VALIDATION_ERROR');
        return this.sphere.communications.getConversationPage(
          params.peerPubkey as string,
          {
            limit: params.limit as number | undefined,
            before: params.before as number | undefined,
          },
        );
      }

      case RPC_METHODS.GET_DM_UNREAD_COUNT: {
        if (!this.sphere.communications) throw new SphereError('Communications module not available', 'MODULE_NOT_AVAILABLE');
        return {
          unreadCount: this.sphere.communications.getUnreadCount(
            params.peerPubkey as string | undefined,
          ),
        };
      }

      case RPC_METHODS.MARK_AS_READ: {
        if (!this.sphere.communications) throw new SphereError('Communications module not available', 'MODULE_NOT_AVAILABLE');
        if (!params.messageIds || !Array.isArray(params.messageIds)) {
          throw new SphereError('Missing required parameter: messageIds (string[])', 'VALIDATION_ERROR');
        }
        await this.sphere.communications.markAsRead(params.messageIds as string[]);
        return { marked: true, count: (params.messageIds as string[]).length };
      }

      default:
        throw new SphereError(`Unknown method: ${method}`, 'VALIDATION_ERROR');
    }
  }

  // ===========================================================================
  // Event Subscriptions
  // ===========================================================================

  private handleSubscribe(eventName: string): { subscribed: boolean; event: string } {
    if (!eventName) throw new SphereError('Missing required parameter: event', 'VALIDATION_ERROR');

    if (this.eventSubscriptions.has(eventName)) {
      return { subscribed: true, event: eventName };
    }

    const unsub = this.sphere.on(eventName as SphereEventType, (data: unknown) => {
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

  private getPublicIdentity(): PublicIdentity | undefined {
    const id = this.sphere.identity;
    if (!id) return undefined;
    return {
      chainPubkey: id.chainPubkey,
      l1Address: id.l1Address,
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
