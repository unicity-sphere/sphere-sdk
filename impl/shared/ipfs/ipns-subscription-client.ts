/**
 * WebSocket client for IPNS subscription updates.
 * Connects to IPFS sidecar and receives push notifications for IPNS changes.
 *
 * Architecture:
 * - Connects to /ws/ipns endpoint on IPFS gateway
 * - Clients subscribe to specific IPNS names
 * - Server pushes updates when IPNS records change
 * - Auto-reconnects on connection loss with exponential backoff
 * - Falls back to polling when WebSocket is unavailable
 *
 * Ported from Sphere webapp's IpnsSubscriptionClient.
 */

import { logger } from '../../../core/logger';
import type { IWebSocket, WebSocketFactory } from '../../../transport/websocket';
import { WebSocketReadyState } from '../../../transport/websocket';
import type { IpnsUpdateEvent } from './ipfs-types';

// =============================================================================
// Types
// =============================================================================

export interface IpnsSubscriptionClientConfig {
  /** WebSocket URL (e.g., wss://host/ws/ipns) */
  wsUrl: string;
  /** Platform-specific WebSocket factory */
  createWebSocket: WebSocketFactory;
  /** Ping interval in ms (default: 30000) */
  pingIntervalMs?: number;
  /** Initial reconnect delay in ms (default: 5000) */
  reconnectDelayMs?: number;
  /** Max reconnect delay in ms (default: 60000) */
  maxReconnectDelayMs?: number;
  /** Enable debug logging (default: false) */
  debug?: boolean;
}

type UpdateCallback = (update: IpnsUpdateEvent) => void;

interface WebSocketMessage {
  type: string;
  name?: string;
  names?: string[];
  sequence?: number;
  cid?: string | null;
  timestamp?: string;
  message?: string;
}

// =============================================================================
// Implementation
// =============================================================================

export class IpnsSubscriptionClient {
  private ws: IWebSocket | null = null;
  private readonly subscriptions: Map<string, Set<UpdateCallback>> = new Map();
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private fallbackPollInterval: ReturnType<typeof setInterval> | null = null;

  private readonly wsUrl: string;
  private readonly createWebSocket: WebSocketFactory;
  private readonly pingIntervalMs: number;
  private readonly initialReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly debugEnabled: boolean;

  private reconnectAttempts = 0;
  private isConnecting = false;
  private connectionOpenedAt = 0;
  private destroyed = false;

  /** Minimum stable connection time before resetting backoff (30 seconds) */
  private readonly minStableConnectionMs = 30000;

  private fallbackPollFn: (() => Promise<void>) | null = null;
  private fallbackPollIntervalMs = 0;

  constructor(config: IpnsSubscriptionClientConfig) {
    this.wsUrl = config.wsUrl;
    this.createWebSocket = config.createWebSocket;
    this.pingIntervalMs = config.pingIntervalMs ?? 30000;
    this.initialReconnectDelayMs = config.reconnectDelayMs ?? 5000;
    this.maxReconnectDelayMs = config.maxReconnectDelayMs ?? 60000;
    this.debugEnabled = config.debug ?? false;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to IPNS updates for a specific name.
   * Automatically connects the WebSocket if not already connected.
   * If WebSocket is connecting, the name will be subscribed once connected.
   */
  subscribe(ipnsName: string, callback: UpdateCallback): () => void {
    if (!ipnsName || typeof ipnsName !== 'string') {
      this.log('Invalid IPNS name for subscription');
      return () => { /* noop */ };
    }

    const isNewSubscription = !this.subscriptions.has(ipnsName);

    if (isNewSubscription) {
      this.subscriptions.set(ipnsName, new Set());
    }

    this.subscriptions.get(ipnsName)!.add(callback);

    // Send subscription to server if already connected and this is a new name
    if (isNewSubscription && this.ws?.readyState === WebSocketReadyState.OPEN) {
      this.sendSubscribe([ipnsName]);
    }

    // Connect if not already connected
    if (!this.ws || this.ws.readyState !== WebSocketReadyState.OPEN) {
      this.connect();
    }

    // Return unsubscribe function
    return () => {
      const callbacks = this.subscriptions.get(ipnsName);
      if (callbacks) {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          this.subscriptions.delete(ipnsName);
          if (this.ws?.readyState === WebSocketReadyState.OPEN) {
            this.sendUnsubscribe([ipnsName]);
          }
          // Disconnect if no more subscriptions
          if (this.subscriptions.size === 0) {
            this.disconnect();
          }
        }
      }
    };
  }

  /**
   * Register a convenience update callback for all subscriptions.
   * Returns an unsubscribe function.
   */
  onUpdate(callback: UpdateCallback): () => void {
    // Store as a special "global" callback keyed by '*'
    if (!this.subscriptions.has('*')) {
      this.subscriptions.set('*', new Set());
    }
    this.subscriptions.get('*')!.add(callback);

    return () => {
      const callbacks = this.subscriptions.get('*');
      if (callbacks) {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          this.subscriptions.delete('*');
        }
      }
    };
  }

  /**
   * Set a fallback poll function to use when WebSocket is disconnected.
   * The poll function will be called at the specified interval while WS is down.
   */
  setFallbackPoll(fn: () => Promise<void>, intervalMs: number): void {
    this.fallbackPollFn = fn;
    this.fallbackPollIntervalMs = intervalMs;
    // Start polling if WS is not connected
    if (!this.isConnected()) {
      this.startFallbackPolling();
    }
  }

  /**
   * Connect to the WebSocket server.
   */
  connect(): void {
    if (this.destroyed) return;
    if (this.ws?.readyState === WebSocketReadyState.OPEN || this.isConnecting) {
      return;
    }

    this.isConnecting = true;

    try {
      this.log(`Connecting to ${this.wsUrl}...`);
      this.ws = this.createWebSocket(this.wsUrl);

      this.ws.onopen = () => {
        this.log('WebSocket connected');
        this.isConnecting = false;
        this.connectionOpenedAt = Date.now();

        // Resubscribe to all IPNS names (excluding '*' global key)
        const names = Array.from(this.subscriptions.keys()).filter(n => n !== '*');
        if (names.length > 0) {
          this.sendSubscribe(names);
        }

        // Start ping interval to keep connection alive
        this.startPingInterval();

        // Stop fallback polling — WS is live
        this.stopFallbackPolling();
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };

      this.ws.onclose = () => {
        const connectionDuration = this.connectionOpenedAt > 0
          ? Date.now() - this.connectionOpenedAt
          : 0;
        const wasStable = connectionDuration >= this.minStableConnectionMs;

        this.log(`WebSocket closed (duration: ${Math.round(connectionDuration / 1000)}s)`);

        this.isConnecting = false;
        this.connectionOpenedAt = 0;
        this.stopPingInterval();

        // Only reset backoff if connection was stable
        if (wasStable) {
          this.reconnectAttempts = 0;
        }

        // Start fallback polling while WS is down
        this.startFallbackPolling();

        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        this.log('WebSocket error');
        this.isConnecting = false;
      };
    } catch (e) {
      this.log(`Failed to connect: ${e}`);
      this.isConnecting = false;
      this.startFallbackPolling();
      this.scheduleReconnect();
    }
  }

  /**
   * Disconnect from the WebSocket server and clean up.
   */
  disconnect(): void {
    this.destroyed = true;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.stopPingInterval();
    this.stopFallbackPolling();

    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
    this.isConnecting = false;
    this.reconnectAttempts = 0;
  }

  /**
   * Check if connected to the WebSocket server.
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocketReadyState.OPEN;
  }

  // ---------------------------------------------------------------------------
  // Internal: Message Handling
  // ---------------------------------------------------------------------------

  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data) as WebSocketMessage;

      switch (message.type) {
        case 'update':
          if (message.name && message.sequence !== undefined) {
            this.notifySubscribers({
              type: 'update',
              name: message.name,
              sequence: message.sequence,
              cid: message.cid ?? '',
              timestamp: message.timestamp || new Date().toISOString(),
            });
          }
          break;

        case 'subscribed':
          this.log(`Subscribed to ${message.names?.length || 0} names`);
          break;

        case 'unsubscribed':
          this.log(`Unsubscribed from ${message.names?.length || 0} names`);
          break;

        case 'pong':
          // Keepalive response received
          break;

        case 'error':
          this.log(`Server error: ${message.message}`);
          break;

        default:
          // Unknown message type — ignore
          break;
      }
    } catch {
      this.log('Failed to parse message');
    }
  }

  private notifySubscribers(update: IpnsUpdateEvent & { type: string }): void {
    // Notify name-specific subscribers
    const callbacks = this.subscriptions.get(update.name);
    if (callbacks) {
      this.log(`Update: ${update.name.slice(0, 16)}... seq=${update.sequence}`);
      for (const callback of callbacks) {
        try {
          callback(update);
        } catch {
          // Don't let callback errors break the client
        }
      }
    }

    // Notify global subscribers
    const globalCallbacks = this.subscriptions.get('*');
    if (globalCallbacks) {
      for (const callback of globalCallbacks) {
        try {
          callback(update);
        } catch {
          // Don't let callback errors break the client
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: WebSocket Send
  // ---------------------------------------------------------------------------

  private sendSubscribe(names: string[]): void {
    if (this.ws?.readyState === WebSocketReadyState.OPEN) {
      this.ws.send(JSON.stringify({ action: 'subscribe', names }));
    }
  }

  private sendUnsubscribe(names: string[]): void {
    if (this.ws?.readyState === WebSocketReadyState.OPEN) {
      this.ws.send(JSON.stringify({ action: 'unsubscribe', names }));
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: Reconnection
  // ---------------------------------------------------------------------------

  /**
   * Schedule reconnection with exponential backoff.
   * Sequence: 5s, 10s, 20s, 40s, 60s (capped)
   */
  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimeout) return;

    // Don't reconnect if no subscriptions (excluding '*')
    const realSubscriptions = Array.from(this.subscriptions.keys()).filter(n => n !== '*');
    if (realSubscriptions.length === 0) return;

    this.reconnectAttempts++;
    const delay = Math.min(
      this.initialReconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelayMs,
    );

    this.log(`Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts})...`);

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
    }, delay);
  }

  // ---------------------------------------------------------------------------
  // Internal: Keepalive
  // ---------------------------------------------------------------------------

  private startPingInterval(): void {
    this.stopPingInterval();
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocketReadyState.OPEN) {
        this.ws.send(JSON.stringify({ action: 'ping' }));
      }
    }, this.pingIntervalMs);
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: Fallback Polling
  // ---------------------------------------------------------------------------

  private startFallbackPolling(): void {
    if (this.fallbackPollInterval || !this.fallbackPollFn || this.destroyed) return;

    this.log(`Starting fallback polling (${this.fallbackPollIntervalMs / 1000}s interval)`);

    // Run poll immediately once
    this.fallbackPollFn().catch((err) => { logger.warn('IPNS-WS', 'Fallback poll error:', err); });

    this.fallbackPollInterval = setInterval(() => {
      this.fallbackPollFn?.().catch((err) => { logger.warn('IPNS-WS', 'Fallback poll error:', err); });
    }, this.fallbackPollIntervalMs);
  }

  private stopFallbackPolling(): void {
    if (this.fallbackPollInterval) {
      clearInterval(this.fallbackPollInterval);
      this.fallbackPollInterval = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: Logging
  // ---------------------------------------------------------------------------

  private log(message: string): void {
    logger.debug('IPNS-WS', message);
  }
}
