/**
 * UXF Profile Module — Public API
 *
 * The Profile module provides OrbitDB-backed storage providers that are
 * drop-in replacements for the standard IndexedDB / file-based providers.
 * Token inventories are stored as encrypted UXF CAR files on IPFS with
 * multi-bundle CRDT merge semantics via OrbitDB.
 *
 * Entry points:
 * - `@unicitylabs/sphere-sdk/profile` — this barrel (types, classes, shared factory)
 * - `@unicitylabs/sphere-sdk/profile/browser` — browser factory
 * - `@unicitylabs/sphere-sdk/profile/node` — Node.js factory
 *
 * @packageDocumentation
 */

// =============================================================================
// Types (type-only exports)
// =============================================================================

export type {
  OrbitDbConfig,
  ProfileConfig,
  UxfBundleRef,
  ConsolidationPendingState,
  MigrationPhase,
  MigrationResult,
  ProfileEncryptionConfig,
  ProfileStorageProviderOptions,
  ProfileTokenStorageProviderOptions,
  ProfileDatabase,
  ProfileKeyMapEntry,
  ProfileKeyMap,
  SyncEventType,
  SyncEventCallback,
} from './types';

// =============================================================================
// Constants (re-exported for advanced usage)
// =============================================================================

export {
  DEFAULT_ENCRYPTION_CONFIG,
  PROFILE_KEY_MAPPING,
  CACHE_ONLY_KEYS,
  IPFS_STATE_KEYS_PATTERN,
  computeAddressId,
} from './types';

// =============================================================================
// Error Types
// =============================================================================

export { ProfileError } from './errors';
export type { ProfileErrorCode } from './errors';

// =============================================================================
// Encryption (for advanced users who need direct access)
// =============================================================================

export {
  deriveProfileEncryptionKey,
  encryptProfileValue,
  decryptProfileValue,
  encryptString,
  decryptString,
  PROFILE_HKDF_INFO,
} from './encryption';

// =============================================================================
// OrbitDB Adapter
// =============================================================================

export { OrbitDbAdapter } from './orbitdb-adapter';

// =============================================================================
// Nostr Replication Bridge
// =============================================================================

export { NostrReplicationBridge } from './nostr-replication';
export type { NostrReplicationConfig } from './nostr-replication';

// =============================================================================
// Storage Providers
// =============================================================================

export { ProfileStorageProvider } from './profile-storage-provider';
export { ProfileTokenStorageProvider } from './profile-token-storage-provider';

// =============================================================================
// IPFS Client
// =============================================================================

export { pinToIpfs, fetchFromIpfs, verifyCidAccessible } from './ipfs-client';

// =============================================================================
// Consolidation
// =============================================================================

export { ConsolidationEngine } from './consolidation';
export type { ConsolidationResult } from './consolidation';

// =============================================================================
// Migration
// =============================================================================

export { ProfileMigration } from './migration';

// =============================================================================
// Deriver (local-cached structural views)
// =============================================================================

export {
  deriveTombstonesFromArchived,
  deriveSentFromArchived,
  deriveHistoryFromArchived,
} from './deriver';

// =============================================================================
// Token Manifest (structural JOIN result)
// =============================================================================

export {
  deriveStructuralManifest,
  conflictingTokenIds,
} from './token-manifest';
export type {
  TokenManifest,
  TokenManifestEntry,
  TokenManifestStatus,
} from './token-manifest';

// =============================================================================
// Shared Factory
// =============================================================================

export { createProfileProviders } from './factory';
export type { ProfileProviders } from './factory';

// =============================================================================
// Platform-Specific Factories (type-only re-exports)
// =============================================================================
// Runtime imports for platform factories require platform-specific entry points:
//   import { createBrowserProfileProviders } from '@unicitylabs/sphere-sdk/profile/browser';
//   import { createNodeProfileProviders } from '@unicitylabs/sphere-sdk/profile/node';

export type { BrowserProfileProvidersConfig, BrowserProfileProviders } from './browser';
export type { NodeProfileProvidersConfig, NodeProfileProviders } from './node';
