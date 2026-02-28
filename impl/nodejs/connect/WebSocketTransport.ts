/**
 * WebSocketTransport — Node.js transport for Sphere Connect.
 *
 * Two modes:
 * - Server: wallet runs a WS server, dApps connect to it
 * - Client: dApp connects to wallet's WS server
 *
 * Uses the existing IWebSocket/WebSocketFactory abstraction from transport/websocket.ts.
 */

import type { ConnectTransport, SphereConnectMessage } from '../../../connect';
import { isSphereConnectMessage } from '../../../connect';
import type { IWebSocket, WebSocketFactory } from '../../../transport/websocket';
import { WebSocketReadyState } from '../../../transport/websocket';
import { logger } from '../../../core/logger';

// =============================================================================
// Configuration
// =============================================================================

export interface WebSocketServerConfig {
  /** Port to listen on */
  port: number;
  /** Host to bind to. Default: '0.0.0.0' */
  host?: string;
}

export interface WebSocketClientConfig {
  /** WebSocket URL to connect to (e.g., 'ws://localhost:8765') */
  url: string;
  /** Factory for creating WebSocket instances */
  createWebSocket: WebSocketFactory;
  /** Reconnect on disconnect. Default: true */
  autoReconnect?: boolean;
  /** Initial reconnect delay in ms. Default: 2000 */
  reconnectDelayMs?: number;
  /** Max reconnect delay in ms. Default: 30000 */
  maxReconnectDelayMs?: number;
  /** Max reconnect attempts. Default: 10. 0 = unlimited */
  maxReconnectAttempts?: number;
}

// =============================================================================
// Server Transport (wallet side)
// =============================================================================

export class WebSocketServerTransport implements ConnectTransport {
  private server: unknown = null; // WebSocketServer from 'ws' package
  private clientSocket: IWebSocket | null = null;
  private handlers: Set<(message: SphereConnectMessage) => void> = new Set();
  private config: WebSocketServerConfig;

  constructor(config: WebSocketServerConfig) {
    this.config = config;
  }

  /** Start the WebSocket server. Must be called before use. */
  async start(): Promise<void> {
    // Dynamic import to avoid bundling ws in browser builds
    const { WebSocketServer } = await import('ws');
    const wss = new WebSocketServer({
      port: this.config.port,
      host: this.config.host ?? '0.0.0.0',
    });

    this.server = wss;

    wss.on('connection', (ws: IWebSocket) => {
      // Accept only one client at a time
      if (this.clientSocket) {
        ws.close(4000, 'Another client is already connected');
        return;
      }

      this.clientSocket = ws;

      ws.onmessage = (event: { data: string }) => {
        try {
          const msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
          if (isSphereConnectMessage(msg)) {
            for (const handler of this.handlers) {
              try {
                handler(msg);
              } catch (err) {
                logger.debug('WebSocket', 'Message handler error', err);
              }
            }
          }
        } catch (err) {
          logger.debug('WebSocket', 'Malformed message received', err);
        }
      };

      ws.onclose = () => {
        if (this.clientSocket === ws) {
          this.clientSocket = null;
        }
      };
    });

    // Wait for server to be listening
    await new Promise<void>((resolve, reject) => {
      wss.on('listening', resolve);
      wss.on('error', reject);
    });
  }

  send(message: SphereConnectMessage): void {
    if (this.clientSocket && this.clientSocket.readyState === WebSocketReadyState.OPEN) {
      this.clientSocket.send(JSON.stringify(message));
    }
  }

  onMessage(handler: (message: SphereConnectMessage) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  destroy(): void {
    if (this.clientSocket) {
      this.clientSocket.close();
      this.clientSocket = null;
    }
    if (this.server) {
      (this.server as { close: () => void }).close();
      this.server = null;
    }
    this.handlers.clear();
  }
}

// =============================================================================
// Client Transport (dApp side)
// =============================================================================

export class WebSocketClientTransport implements ConnectTransport {
  private ws: IWebSocket | null = null;
  private handlers: Set<(message: SphereConnectMessage) => void> = new Set();
  private config: WebSocketClientConfig;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(config: WebSocketClientConfig) {
    this.config = {
      autoReconnect: true,
      reconnectDelayMs: 2000,
      maxReconnectDelayMs: 30000,
      maxReconnectAttempts: 10,
      ...config,
    };
  }

  /** Connect to the WebSocket server. Must be called before use. */
  async connect(): Promise<void> {
    return this.doConnect();
  }

  send(message: SphereConnectMessage): void {
    if (this.ws && this.ws.readyState === WebSocketReadyState.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  onMessage(handler: (message: SphereConnectMessage) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.handlers.clear();
  }

  // ===========================================================================
  // Private
  // ===========================================================================

  private doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        this.ws = this.config.createWebSocket(this.config.url);
      } catch (err) {
        reject(err);
        return;
      }

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        resolve();
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (isSphereConnectMessage(msg)) {
            for (const handler of this.handlers) {
              try {
                handler(msg);
              } catch (err) {
                logger.debug('WebSocket', 'Message handler error', err);
              }
            }
          }
        } catch (err) {
          logger.debug('WebSocket', 'Malformed message received', err);
        }
      };

      this.ws.onerror = (err) => {
        reject(err);
      };

      this.ws.onclose = () => {
        this.ws = null;
        if (!this.destroyed && this.config.autoReconnect) {
          this.scheduleReconnect();
        }
      };
    });
  }

  private scheduleReconnect(): void {
    const maxAttempts = this.config.maxReconnectAttempts!;
    if (maxAttempts > 0 && this.reconnectAttempts >= maxAttempts) {
      return;
    }

    this.reconnectAttempts++;
    const baseDelay = this.config.reconnectDelayMs!;
    const maxDelay = this.config.maxReconnectDelayMs!;
    const delay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempts - 1), maxDelay);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect().catch((err) => logger.debug('WebSocket', 'Reconnect attempt failed', err));
    }, delay);
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

export const WebSocketTransport = {
  /** Create a WebSocket server transport (wallet side) */
  createServer(config: WebSocketServerConfig): WebSocketServerTransport {
    return new WebSocketServerTransport(config);
  },

  /** Create a WebSocket client transport (dApp side) */
  createClient(config: WebSocketClientConfig): WebSocketClientTransport {
    return new WebSocketClientTransport(config);
  },
};
