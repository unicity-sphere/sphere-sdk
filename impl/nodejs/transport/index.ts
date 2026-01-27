/**
 * Node.js Transport Exports
 * Re-exports shared transport with Node.js WebSocket
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const WebSocket = require('ws');

import {
  NostrTransportProvider,
  type NostrTransportProviderConfig,
} from '../../../transport/NostrTransportProvider';
import type { IWebSocket, WebSocketFactory } from '../../../transport/websocket';

// Re-export shared types
export {
  NostrTransportProvider,
  type NostrTransportProviderConfig,
} from '../../../transport/NostrTransportProvider';

export type { IWebSocket, WebSocketFactory } from '../../../transport/websocket';

// =============================================================================
// Node.js WebSocket Factory
// =============================================================================

/**
 * Create WebSocket factory for Node.js using 'ws' package
 */
export function createNodeWebSocketFactory(): WebSocketFactory {
  return (url: string): IWebSocket => {
    return new WebSocket(url) as IWebSocket;
  };
}

// =============================================================================
// Node.js Factory
// =============================================================================

/**
 * Create NostrTransportProvider with Node.js WebSocket
 */
export function createNostrTransportProvider(
  config: Omit<NostrTransportProviderConfig, 'createWebSocket'>
): NostrTransportProvider {
  return new NostrTransportProvider({
    ...config,
    createWebSocket: createNodeWebSocketFactory(),
  });
}
