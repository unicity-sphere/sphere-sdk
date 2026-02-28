/**
 * ConnectClient — dApp side of Sphere Connect.
 *
 * Lightweight client that communicates with a wallet's ConnectHost
 * through a ConnectTransport. Provides query and intent methods
 * that mirror the Sphere SDK API.
 *
 * Zero dependencies on the Sphere SDK core.
 */

import type { ConnectTransport, ConnectClientConfig, ConnectResult, ConnectEventHandler } from '../types';
import type {
  SphereConnectMessage,
  DAppMetadata,
  PublicIdentity,
} from '../protocol';
import {
  SPHERE_CONNECT_NAMESPACE,
  SPHERE_CONNECT_VERSION,
  RPC_METHODS,
  createRequestId,
} from '../protocol';
import { ALL_PERMISSIONS } from '../permissions';
import type { PermissionScope } from '../permissions';

const DEFAULT_TIMEOUT = 30000;
const DEFAULT_INTENT_TIMEOUT = 120000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ConnectClient {
  private readonly transport: ConnectTransport;
  private readonly dapp: DAppMetadata;
  private readonly requestedPermissions: PermissionScope[];
  private readonly timeout: number;
  private readonly intentTimeout: number;

  private readonly resumeSessionId: string | null;
  private readonly silent: boolean;

  private sessionId: string | null = null;
  private grantedPermissions: PermissionScope[] = [];
  private identity: PublicIdentity | null = null;
  private connected = false;

  private pendingRequests: Map<string, PendingRequest> = new Map();
  private eventHandlers: Map<string, Set<ConnectEventHandler>> = new Map();
  private unsubscribeTransport: (() => void) | null = null;

  // Handshake resolver (one-shot)
  private handshakeResolver: {
    resolve: (value: ConnectResult) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(config: ConnectClientConfig) {
    this.transport = config.transport;
    this.dapp = config.dapp;
    this.requestedPermissions = config.permissions ?? [...ALL_PERMISSIONS];
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.intentTimeout = config.intentTimeout ?? DEFAULT_INTENT_TIMEOUT;
    this.resumeSessionId = config.resumeSessionId ?? null;
    this.silent = config.silent ?? false;
  }

  // ===========================================================================
  // Connection
  // ===========================================================================

  /** Connect to the wallet. Returns session info and public identity. */
  async connect(): Promise<ConnectResult> {
    // Start listening
    this.unsubscribeTransport = this.transport.onMessage(this.handleMessage.bind(this));

    return new Promise<ConnectResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handshakeResolver = null;
        reject(new Error('Connection timeout'));
      }, this.timeout);

      this.handshakeResolver = { resolve, reject, timer };

      // Send handshake request
      this.transport.send({
        ns: SPHERE_CONNECT_NAMESPACE,
        v: SPHERE_CONNECT_VERSION,
        type: 'handshake',
        direction: 'request',
        permissions: this.requestedPermissions,
        dapp: this.dapp,
        ...(this.resumeSessionId ? { sessionId: this.resumeSessionId } : {}),
        ...(this.silent ? { silent: true } : {}),
      });
    });
  }

  /** Disconnect from the wallet */
  async disconnect(): Promise<void> {
    if (this.connected) {
      try {
        await this.query(RPC_METHODS.DISCONNECT);
      } catch {
        // Ignore errors during disconnect
      }
    }
    this.cleanup();
  }

  /** Whether currently connected */
  get isConnected(): boolean {
    return this.connected;
  }

  /** Granted permission scopes */
  get permissions(): readonly PermissionScope[] {
    return this.grantedPermissions;
  }

  /** Current session ID */
  get session(): string | null {
    return this.sessionId;
  }

  /** Public identity received during handshake */
  get walletIdentity(): PublicIdentity | null {
    return this.identity;
  }

  // ===========================================================================
  // Query (read data)
  // ===========================================================================

  /** Send a query request and return the result */
  async query<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.connected) throw new Error('Not connected');

    const id = createRequestId();

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Query timeout: ${method}`));
      }, this.timeout);

      this.pendingRequests.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      this.transport.send({
        ns: SPHERE_CONNECT_NAMESPACE,
        v: SPHERE_CONNECT_VERSION,
        type: 'request',
        id,
        method,
        params,
      });
    });
  }

  // ===========================================================================
  // Intent (trigger wallet UI)
  // ===========================================================================

  /** Send an intent request. The wallet will open its UI for user confirmation. */
  async intent<T = unknown>(action: string, params: Record<string, unknown>): Promise<T> {
    if (!this.connected) throw new Error('Not connected');

    const id = createRequestId();

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Intent timeout: ${action}`));
      }, this.intentTimeout);

      this.pendingRequests.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      this.transport.send({
        ns: SPHERE_CONNECT_NAMESPACE,
        v: SPHERE_CONNECT_VERSION,
        type: 'intent',
        id,
        action,
        params,
      });
    });
  }

  // ===========================================================================
  // Events
  // ===========================================================================

  /** Subscribe to a wallet event. Returns unsubscribe function. */
  on(event: string, handler: ConnectEventHandler): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
      // Tell host to forward this event
      if (this.connected) {
        this.query(RPC_METHODS.SUBSCRIBE, { event }).catch(() => {});
      }
    }
    this.eventHandlers.get(event)!.add(handler);

    return () => {
      const handlers = this.eventHandlers.get(event);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this.eventHandlers.delete(event);
          if (this.connected) {
            this.query(RPC_METHODS.UNSUBSCRIBE, { event }).catch(() => {});
          }
        }
      }
    };
  }

  // ===========================================================================
  // Message Handling
  // ===========================================================================

  private handleMessage(msg: SphereConnectMessage): void {
    // Handshake response
    if (msg.type === 'handshake' && msg.direction === 'response') {
      this.handleHandshakeResponse(msg);
      return;
    }

    // RPC response (query)
    if (msg.type === 'response') {
      this.handlePendingResponse(msg.id, msg.result, msg.error);
      return;
    }

    // Intent result
    if (msg.type === 'intent_result') {
      this.handlePendingResponse(msg.id, msg.result, msg.error);
      return;
    }

    // Event
    if (msg.type === 'event') {
      const handlers = this.eventHandlers.get(msg.event);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(msg.data);
          } catch {
            // Ignore handler errors
          }
        }
      }
    }
  }

  private handleHandshakeResponse(msg: SphereConnectMessage & { type: 'handshake' }): void {
    if (!this.handshakeResolver) return;

    clearTimeout(this.handshakeResolver.timer);

    if (msg.sessionId && msg.identity) {
      this.sessionId = msg.sessionId;
      this.grantedPermissions = msg.permissions as PermissionScope[];
      this.identity = msg.identity;
      this.connected = true;

      this.handshakeResolver.resolve({
        sessionId: msg.sessionId,
        permissions: this.grantedPermissions,
        identity: msg.identity,
      });
    } else {
      this.handshakeResolver.reject(new Error('Connection rejected by wallet'));
    }

    this.handshakeResolver = null;
  }

  private handlePendingResponse(
    id: string,
    result: unknown,
    error?: { code: number; message: string; data?: unknown },
  ): void {
    const pending = this.pendingRequests.get(id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingRequests.delete(id);

    if (error) {
      const err = new Error(error.message);
      (err as Error & { code: number }).code = error.code;
      (err as Error & { data: unknown }).data = error.data;
      pending.reject(err);
    } else {
      pending.resolve(result);
    }
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  private cleanup(): void {
    if (this.unsubscribeTransport) {
      this.unsubscribeTransport();
      this.unsubscribeTransport = null;
    }

    // Reject all pending requests
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Disconnected'));
    }
    this.pendingRequests.clear();
    this.eventHandlers.clear();

    this.connected = false;
    this.sessionId = null;
    this.grantedPermissions = [];
    this.identity = null;
  }
}
