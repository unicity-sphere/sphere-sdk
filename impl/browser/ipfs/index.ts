/**
 * Browser IPFS Storage Module
 * Factory function for browser-specific IPFS storage provider
 */

import { IpfsStorageProvider, type IpfsStorageConfig } from '../../shared/ipfs';
import { BrowserIpfsStatePersistence } from './browser-ipfs-state-persistence';

// Re-export for convenience
export { IpfsStorageProvider } from '../../shared/ipfs';
export { BrowserIpfsStatePersistence } from './browser-ipfs-state-persistence';
export type { IpfsStorageConfig as IpfsStorageProviderConfig } from '../../shared/ipfs';

/**
 * Create a browser IPFS storage provider with localStorage-based state persistence.
 */
export function createBrowserIpfsStorageProvider(config?: IpfsStorageConfig): IpfsStorageProvider {
  return new IpfsStorageProvider(config, new BrowserIpfsStatePersistence());
}

/** @deprecated Use createBrowserIpfsStorageProvider instead */
export const createIpfsStorageProvider = createBrowserIpfsStorageProvider;
