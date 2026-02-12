/**
 * Browser IPFS Storage Provider
 * @deprecated Import from '@unicitylabs/sphere-sdk/impl/browser/ipfs' instead
 *
 * This file is kept for backward compatibility. The implementation has moved
 * to the shared IPFS module at impl/shared/ipfs/.
 */

// Re-export from new shared implementation
export { IpfsStorageProvider } from '../../shared/ipfs/ipfs-storage-provider';
export type { IpfsStorageConfig as IpfsStorageProviderConfig } from '../../shared/ipfs/ipfs-types';
