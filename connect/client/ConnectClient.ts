/**
 * ConnectClient — dApp side of Sphere Connect.
 *
 * Lightweight client that communicates with a wallet's ConnectHost
 * through a ConnectTransport. Provides query and intent methods
 * that mirror the Sphere SDK API.
 *
 * Zero dependencies on the Sphere SDK core.
 */

import { logger } from '../../core/logger';
import { SphereError } from '../../core/errors';
import type { ConnectTransport, ConnectClientConfig, ConnectResult, ConnectEventHandler } from '../types';
import type {
  SphereConnectMessage,
  SphereHandshake,
  DAppMetadata,
  PublicIdentity,
  NetworkInfo,
} from '../protocol';
import {
  SPHERE_CONNECT_NAMESPACE,
  SPHERE_CONNECT_VERSION,
  RPC_METHODS,
  ERROR_CODES,
  WALLET_EVENTS,
  createRequestId,
  isAutoPushedEvent,
} from '../protocol';
import { SDK_VERSION } from '../version';
import { ALL_PERMISSIONS } from '../permissions';
import type { PermissionScope } from '../permissions';

/** Error thrown by ConnectClient carrying the host's structured rejection.
 *  Discriminate on the numeric `.code` (bundle-safe), not `instanceof`. */
export class ConnectError extends Error {
  constructor(message: string, public readonly code: number, public readonly data?: unknown) {
    super(message);
    this.name = 'ConnectError';
  }
}

const DEFAULT_TIMEOUT = 30000;
const DEFAULT_INTENT_TIMEOUT = 120000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /**
   * A QUERY may be failed with anything truthful — it is idempotent and safe to retry. An
   * INTENT may not: once it reached the wallet, the money may already be moving, so no local
   * teardown is allowed to tell the dApp it did not happen.
   */
  kind: 'query' | 'intent';
}

export class ConnectClient {
  private readonly transport: ConnectTransport;
  private readonly dapp: DAppMetadata;
  private readonly requestedPermissions: PermissionScope[];
  private readonly timeout: number;
  private readonly intentTimeout: number;

  private readonly resumeSessionId: string | null;
  private readonly silent: boolean;
  private readonly network: NetworkInfo | undefined;

  private sessionId: string | null = null;
  private grantedPermissions: PermissionScope[] = [];
  private identity: PublicIdentity | null = null;
  private walletNet: NetworkInfo | null = null;
  private walletProto: string | null = null;
  private locked = false;
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
    this.network = config.network;
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
        sdkVersion: SDK_VERSION,
        ...(this.network ? { network: this.network } : {}),
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

  /** Wallet's active network, received during handshake. */
  get walletNetwork(): NetworkInfo | null {
    return this.walletNet;
  }

  /**
   * The wallet's Connect protocol version, captured from the handshake response `v`.
   * Null before the first handshake response and after a disconnect.
   *
   * Feature-detect with it: compare against '2.1' to decide whether the wallet can be
   * trusted to send wallet:unlocked / wallet:disconnected. A Connect 2.0 wallet destroys
   * the session on lock and never emits either, so a dApp waiting for them against one
   * waits forever.
   *
   * CAVEAT: on an ERROR response the host echoes the dApp's own `v` back
   * (ConnectHost.sendHandshakeResponse), so after a refused connection this may be the
   * dApp's version rather than the wallet's. Only trust it after a successful handshake.
   */
  get walletProtocol(): string | null {
    return this.walletProto;
  }

  /**
   * Whether the wallet was locked at the last handshake or lifecycle event.
   * A locked client is still CONNECTED: `isConnected` stays true and `session` stays valid.
   * Requests answer WALLET_LOCKED (4009) until `wallet:unlocked` arrives on the SAME
   * session — do not disconnect, do not clear the session, do not re-handshake.
   */
  get walletLocked(): boolean {
    return this.locked;
  }

  // ===========================================================================
  // Query (read data)
  // ===========================================================================

  /** Send a query request and return the result */
  async query<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.connected) throw new ConnectError('Not connected', ERROR_CODES.NOT_CONNECTED);

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
        kind: 'query',
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
    if (!this.connected) throw new ConnectError('Not connected', ERROR_CODES.NOT_CONNECTED);

    const id = createRequestId();

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        // TYPED, and specifically NOT a cancellation. We stopped waiting; the wallet may have
        // submitted the transfer. A dApp that retries here can pay twice, so the code says
        // "outcome unknown" and the docs forbid a retry (see ERROR_CODES.INTENT_OUTCOME_UNKNOWN).
        reject(
          new ConnectError(
            `Intent outcome unknown — do not retry; reconcile before acting: ${action}`,
            ERROR_CODES.INTENT_OUTCOME_UNKNOWN,
          ),
        );
      }, this.intentTimeout);

      this.pendingRequests.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        kind: 'intent',
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
      // Tell host to forward this event. Auto-pushed wallet events are NEVER routed through
      // sphere_subscribe: the host pushes them unconditionally and refuses the RPC, and
      // Sphere.on() would accept the name and silently never emit.
      if (this.connected && !isAutoPushedEvent(event)) {
        this.query(RPC_METHODS.SUBSCRIBE, { event }).catch((err) => logger.debug('Connect', 'Event subscription failed', err));
      }
    }
    this.eventHandlers.get(event)!.add(handler);

    return () => {
      const handlers = this.eventHandlers.get(event);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this.eventHandlers.delete(event);
          if (this.connected && !isAutoPushedEvent(event)) {
            this.query(RPC_METHODS.UNSUBSCRIBE, { event }).catch((err) => logger.debug('Connect', 'Event unsubscription failed', err));
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
      // 1. Unconditional NON-DESTRUCTIVE state update, BEFORE any handler lookup, so a
      //    dApp that registered no handler still ends up with correct client state. The
      //    client privileged no wallet event before 2.1, so an unhandled
      //    wallet:disconnected was dropped entirely.
      if (msg.event === WALLET_EVENTS.LOCKED) {
        this.locked = true;
      } else if (msg.event === WALLET_EVENTS.UNLOCKED) {
        this.locked = false;
        const identity = (msg.data as { identity?: PublicIdentity } | undefined)?.identity;
        if (identity) this.identity = identity;
      } else if (msg.event === WALLET_EVENTS.DISCONNECTED) {
        // So a handler reading isConnected sees the truth.
        this.connected = false;
      } else if (msg.event === WALLET_EVENTS.IDENTITY_CHANGED) {
        const data = msg.data as PublicIdentity | undefined;
        if (data && typeof data.chainPubkey === 'string') this.identity = data;
      }

      // 2. Dispatch to registered handlers.
      this.dispatchEvent(msg.event, msg.data);

      // 3. Destructive step LAST — cleanup() clears eventHandlers, so running it after
      //    dispatch is what keeps the dApp's own wallet:disconnected callback alive.
      if (msg.event === WALLET_EVENTS.DISCONNECTED) {
        this.cleanup();
      }
    }
  }

  private dispatchEvent(event: string, data: unknown): void {
    const handlers = this.eventHandlers.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(data);
      } catch (err) {
        logger.debug('Connect', 'Event handler error', err);
      }
    }
  }

  private handleHandshakeResponse(msg: SphereConnectMessage & { type: 'handshake' }): void {
    if (!this.handshakeResolver) return;

    clearTimeout(this.handshakeResolver.timer);

    const m = msg as SphereHandshake;

    // Captured even on a refusal, but see the getter's caveat: the host echoes the dApp's
    // own `v` on an error response.
    this.walletProto = (msg as { v?: string }).v ?? null;

    if (m.error) {
      this.handshakeResolver.reject(new ConnectError(m.error.message, m.error.code, m.error.data));
      this.handshakeResolver = null;
      return;
    }

    if (msg.sessionId && msg.identity) {
      this.sessionId = msg.sessionId;
      this.grantedPermissions = msg.permissions as PermissionScope[];
      this.identity = msg.identity;
      this.walletNet = m.network ?? null;
      this.locked = m.locked === true;
      this.connected = true;
      if (m.warning) logger.warn('Connect', 'Wallet deprecation notice', m.warning.message);
      this.handshakeResolver.resolve({
        sessionId: msg.sessionId,
        permissions: this.grantedPermissions,
        identity: msg.identity,
        // A resume DURING a lock succeeds: the dApp is connected on the same session and
        // must not re-handshake. It will get wallet:unlocked when the user unlocks.
        ...(this.locked ? { locked: true } : {}),
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
      pending.reject(new ConnectError(error.message, error.code, error.data));
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

    // Reject all pending requests with a TYPED error. new Error('Disconnected') carried no
    // .code, so a dApp could not tell it from a transport failure.
    //
    // A pending INTENT is rejected with INTENT_OUTCOME_UNKNOWN, never NOT_CONNECTED: the
    // wallet already had it and may have submitted the transfer, so "not connected" would read
    // as "your spend never ran" and invite a retry that pays twice.
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(
        pending.kind === 'intent'
          ? new ConnectError(
              'Intent outcome unknown — do not retry; reconcile before acting',
              ERROR_CODES.INTENT_OUTCOME_UNKNOWN,
            )
          : new ConnectError('Disconnected', ERROR_CODES.NOT_CONNECTED),
      );
    }
    this.pendingRequests.clear();
    this.eventHandlers.clear();

    this.connected = false;
    this.sessionId = null;
    this.grantedPermissions = [];
    this.identity = null;
    this.walletNet = null;
    this.walletProto = null;
    this.locked = false;
  }
}
