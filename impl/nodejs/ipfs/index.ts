/**
 * Node.js IPFS Storage Module
 * Factory function for Node.js-specific IPFS storage provider
 */

import { IpfsStorageProvider, type IpfsStorageConfig } from '../../shared/ipfs';
import { NodejsIpfsStatePersistence } from './nodejs-ipfs-state-persistence';
import type { StorageProvider } from '../../../storage';

// Re-export for convenience
export { IpfsStorageProvider } from '../../shared/ipfs';
export { NodejsIpfsStatePersistence } from './nodejs-ipfs-state-persistence';
export type { IpfsStorageConfig as IpfsStorageProviderConfig } from '../../shared/ipfs';

/**
 * Create a Node.js IPFS storage provider with file-based state persistence.
 *
 * @param config - IPFS storage configuration
 * @param storageProvider - StorageProvider for persisting state (e.g., FileStorageProvider)
 */
export function createNodeIpfsStorageProvider(
  config?: IpfsStorageConfig,
  storageProvider?: StorageProvider,
): IpfsStorageProvider {
  const persistence = storageProvider
    ? new NodejsIpfsStatePersistence(storageProvider)
    : undefined;

  return new IpfsStorageProvider(config, persistence);
}
