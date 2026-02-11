/**
 * Shared IPFS Storage Module
 * Cross-platform IPFS/IPNS storage provider (browser + Node.js)
 */

// Types
export type {
  IpnsGatewayResult,
  IpnsProgressiveResult,
  IpnsPublishResult,
  IpfsContentResult,
  IpfsUploadResult,
  GatewayHealthResult,
  IpfsStorageConfig,
  IpfsPersistedState,
  IpfsStatePersistence,
  MergeResult,
} from './ipfs-types';

// Error types
export {
  IpfsError,
  classifyFetchError,
  classifyHttpStatus,
  type IpfsErrorCategory,
} from './ipfs-error-types';

// State persistence
export {
  InMemoryIpfsStatePersistence,
} from './ipfs-state-persistence';

// Key derivation
export {
  IPNS_HKDF_INFO,
  deriveEd25519KeyMaterial,
  deriveIpnsIdentity,
  deriveIpnsName,
} from './ipns-key-derivation';

// Record manager
export {
  createSignedRecord,
  parseRoutingApiResponse,
  verifySequenceProgression,
} from './ipns-record-manager';

// Cache
export { IpfsCache, type IpfsCacheConfig } from './ipfs-cache';

// HTTP client
export { IpfsHttpClient, type IpfsHttpClientConfig } from './ipfs-http-client';

// Merge
export { mergeTxfData } from './txf-merge';

// IPNS subscription client (push-based sync)
export { IpnsSubscriptionClient, type IpnsSubscriptionClientConfig } from './ipns-subscription-client';
export type { IpnsUpdateEvent } from './ipfs-types';

// Main provider
export { IpfsStorageProvider } from './ipfs-storage-provider';
