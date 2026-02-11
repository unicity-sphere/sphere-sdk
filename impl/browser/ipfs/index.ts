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
 */
export function createBrowserIpfsStorageProvider(config?: IpfsStorageConfig): IpfsStorageProvider {
  return new IpfsStorageProvider(
    { ...config, createWebSocket: config?.createWebSocket ?? createBrowserWebSocket },
    new BrowserIpfsStatePersistence(),
  );
}

/** @deprecated Use createBrowserIpfsStorageProvider instead */
export const createIpfsStorageProvider = createBrowserIpfsStorageProvider;
