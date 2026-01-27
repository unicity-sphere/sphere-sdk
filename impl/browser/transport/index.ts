/**
 * Browser Transport Exports
 * Re-exports shared transport with browser-specific WebSocket factory
 */

import {
  NostrTransportProvider,
  type NostrTransportProviderConfig,
} from '../../../transport/NostrTransportProvider';
import type { IWebSocket } from '../../../transport/websocket';

// Re-export shared types and classes
export {
  NostrTransportProvider,
  type NostrTransportProviderConfig,
} from '../../../transport/NostrTransportProvider';

export {
  type IWebSocket,
  type IMessageEvent,
  type WebSocketFactory,
  type UUIDGenerator,
  WebSocketReadyState,
  defaultUUIDGenerator,
} from '../../../transport/websocket';

// =============================================================================
// Browser WebSocket Factory
// =============================================================================

/**
 * Browser WebSocket factory using native WebSocket
 * Cast to IWebSocket since native WebSocket is a superset
 */
export function createBrowserWebSocket(url: string): IWebSocket {
  return new WebSocket(url) as unknown as IWebSocket;
}

/**
 * Create NostrTransportProvider with browser WebSocket
 * Convenience factory that injects browser-native WebSocket
 */
export function createNostrTransportProvider(
  config?: Omit<NostrTransportProviderConfig, 'createWebSocket'>
): NostrTransportProvider {
  return new NostrTransportProvider({
    ...config,
    createWebSocket: createBrowserWebSocket,
  });
}
