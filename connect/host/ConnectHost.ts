/**
 * ConnectHost — Wallet side of Sphere Connect.
 *
 * Wraps a Sphere instance and exposes its API through a ConnectTransport.
 * Handles permission checking, rate limiting, session management,
 * and delegates intents to the wallet app via callbacks.
 */

import type { SphereEventType, SphereEventHandler } from '../../types';
import type { ConnectTransport, ConnectSession, ConnectHostConfig } from '../types';
import type {
  SphereConnectMessage,
  SphereRpcRequest,
  SphereIntentRequest,
  SphereHandshake,
  DAppMetadata,
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

  /** Revoke the current session */
  revokeSession(): void {
    if (this.session) {
      this.session.active = false;
      this.cleanupEventSubscriptions();
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
      console.warn('[ConnectHost] Error handling message:', error);
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

    const requestedPermissions = msg.permissions as PermissionScope[];

    const { approved, grantedPermissions } = await this.config.onConnectionRequest(
      dapp,
      requestedPermissions,
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
      this.revokeSession();
      this.sendResult(msg.id, { disconnected: true });
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
          throw new Error('L1 module not available');
        }
        return this.sphere.payments.l1.getBalance();

      case RPC_METHODS.L1_GET_HISTORY:
        if (!this.sphere.payments.l1) {
          throw new Error('L1 module not available');
        }
        return this.sphere.payments.l1.getHistory(params.limit as number | undefined);

      case RPC_METHODS.RESOLVE:
        if (!params.identifier) {
          throw new Error('Missing required parameter: identifier');
        }
        return this.sphere.resolve(params.identifier as string);

      case RPC_METHODS.SUBSCRIBE:
        return this.handleSubscribe(params.event as string);

      case RPC_METHODS.UNSUBSCRIBE:
        return this.handleUnsubscribe(params.event as string);

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  // ===========================================================================
  // Event Subscriptions
  // ===========================================================================

  private handleSubscribe(eventName: string): { subscribed: boolean; event: string } {
    if (!eventName) throw new Error('Missing required parameter: event');

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
    if (!eventName) throw new Error('Missing required parameter: event');

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
      const { sdkData, ...publicFields } = token;
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
