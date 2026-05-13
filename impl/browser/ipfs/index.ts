/**
 * Browser IPFS Storage Module
 * Factory function for browser-specific IPFS storage provider
 */

import { IpfsStorageProvider, type IpfsStorageConfig } from '../../shared/ipfs';
import { BrowserIpfsStatePersistence } from './browser-ipfs-state-persistence';
import type { IWebSocket } from '../../../transport/websocket';

// Re-export for convenience
export { IpfsStorageProvider } from '../../shared/ipfs';
export { BrowserIpfsStatePersistence } from './browser-ipfs-state-persistence';
export type { IpfsStorageConfig as IpfsStorageProviderConfig } from '../../shared/ipfs';

/**
 * Create a browser WebSocket that conforms to the IWebSocket interface.
 */
function createBrowserWebSocket(url: string): IWebSocket {
  return new WebSocket(url) as unknown as IWebSocket;
}

/**
 * Create a browser IPFS storage provider with localStorage-based state persistence.
 * Automatically injects the browser WebSocket factory for IPNS push subscriptions.
 *
 * @deprecated Use `createBrowserProfileProviders` (Profile + aggregator pointer)
 *   instead. The IPNS-based mutable-pointer flow this factory wires up is
 *   superseded by the aggregator pointer layer, which handles cross-device
 *   pointer resolution over HTTP without IPNS DHT propagation. See
 *   `IpfsStorageProvider` JSDoc for the migration rationale.
 */
export function createBrowserIpfsStorageProvider(config?: IpfsStorageConfig): IpfsStorageProvider {
  return new IpfsStorageProvider(
    { ...config, createWebSocket: config?.createWebSocket ?? createBrowserWebSocket },
    new BrowserIpfsStatePersistence(),
  );
}

/** @deprecated Use createBrowserIpfsStorageProvider instead */
export const createIpfsStorageProvider = createBrowserIpfsStorageProvider;
