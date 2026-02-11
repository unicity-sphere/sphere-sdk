/**
 * Browser IPFS Storage Provider
 *
 * Separate entry point for IPFS functionality.
 *
 * @example
 * ```ts
 * import { IpfsStorageProvider, createIpfsStorageProvider } from '@unicitylabs/sphere-sdk/impl/browser/ipfs';
 * ```
 */
export {
  IpfsStorageProvider,
  createBrowserIpfsStorageProvider,
  createIpfsStorageProvider,
  BrowserIpfsStatePersistence,
  type IpfsStorageProviderConfig,
} from './ipfs/index';
