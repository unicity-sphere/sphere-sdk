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
// CID Reference Store (PROFILE-CID-REFERENCES.md §2)
// =============================================================================
//
// Public primitive for migrating fat OpLog payloads to IPFS-pinned CID
// references. The four in-tree write sites (DM cache,
// `groupChatGroups`/`groupChatMembers`/`groupChatMessages`/
// `groupChatProcessedEvents`, pending V5 tokens, accounting invoice
// ledger) wire this through their module dependencies. External
// consumers (#286 token-storage migration, future per-module migrations)
// instantiate it via `ProfileStorageProvider.buildCidRefStore()`.

export { CidRefStore, CID_REF_SCHEMA_VERSION } from './cid-ref-store';
export type {
  CidRef,
  CidRefStoreOptions,
  PinOptions,
  FetchOptions,
} from './cid-ref-store';

// =============================================================================
// IPFS Client
// =============================================================================

export {
  pinToIpfs,
  pinCarBlocksToIpfs,
  fetchFromIpfs,
  fetchCarFromIpfs,
  verifyCidAccessible,
} from './ipfs-client';

// =============================================================================
// Consolidation
// =============================================================================

export { ConsolidationEngine } from './consolidation';
export type { ConsolidationResult } from './consolidation';

// =============================================================================
// Migration
// =============================================================================

/**
 * @deprecated Prefer the import-based migration via `importLegacyTokens`
 * (re-exported below). The 6-step destructive `ProfileMigration`
 * predates the explicit / non-destructive / re-runnable model the CLI
 * now uses. Kept for backwards compatibility.
 */
export { ProfileMigration } from './migration';

// Import-based migration (current model): non-destructive, idempotent,
// joint-inventory semantics. See profile/import-from-legacy.ts.
export { importLegacyTokens } from './import-from-legacy';
export type {
  LegacyImportOptions,
  LegacyImportResult,
} from './import-from-legacy';

// Bidirectional token-storage migration (Issue #286). Operates at the
// TokenStorageProvider boundary — copies a full TxfStorageDataBase
// snapshot between any two providers (legacy ↔ Profile) with
// idempotency, crash-safety, and optional aggregator-spent gating.
// See profile/token-storage-migration.ts module docstring for the
// consumer integration pattern (sphere.telco SphereProvider.initialize).
export {
  migrateTokenStorage,
  migrateLegacyToProfile,
  migrateProfileToLegacy,
  isTokenStorageMigrationComplete,
  clearTokenStorageMigrationMarker,
  TOKEN_STORAGE_MIGRATION_MARKER_VERSION,
} from './token-storage-migration';
export type {
  MigrationDirection,
  TokenStorageMigrationOptions,
  TokenStorageMigrationProgress,
  TokenStorageMigrationCounts,
  TokenStorageMigrationResult,
  MigrateLegacyToProfileOptions,
  MigrateLegacyToProfileFromSphereOptions,
  MigrateLegacyToProfileFromSphereResult,
} from './token-storage-migration';

// =============================================================================
// SphereCryptographer (Issue #292 foundation — sketched, not fully wired)
// =============================================================================

export { PROFILE_CACHE_PURPOSE } from './cryptographer';
export type {
  SphereCryptographer,
  SphereCryptographerPurpose,
} from './cryptographer';

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
  isConflictingStatus,
} from './token-manifest';
export type {
  TokenManifest,
  TokenManifestEntry,
  TokenManifestStatus,
} from './token-manifest';

// =============================================================================
// CRDT primitives — UXF Transfer Protocol §5.5 step 9 + §7.1 (T.1.F)
// =============================================================================

export { Lamport } from './lamport';
export {
  PerTokenMutex,
  MAX_LOCK_HOLD_MS,
} from './per-token-mutex';
export type {
  PerTokenMutexStrategy,
  PerTokenMutexOptions,
} from './per-token-mutex';
export {
  ManifestCas,
  ManifestCasConcurrentModificationError,
} from './manifest-cas';
export type {
  ManifestCasResult,
  MinimalManifestStorage,
} from './manifest-cas';

// =============================================================================
// Disposition writer + manifest store — UXF Transfer Protocol §5.4 (T.3.C)
// =============================================================================

export {
  ManifestStore,
  CAS_MAX_RETRIES,
  mergeManifestEntry,
} from './manifest-store';
export type { ManifestStoreOptions } from './manifest-store';

export {
  DispositionWriter,
  invalidKeyFor,
  auditKeyFor,
  mergeAuditEntry,
} from './disposition-writer';
export type {
  DispositionWriterOptions,
  DispositionPerEntryStorage,
  DispositionEventEmitter,
} from './disposition-writer';

export {
  DEFAULT_LIST_KEYS_MAX_RESULTS,
  InMemoryDispositionStorageAdapter,
  OrbitDbDispositionStorageAdapter,
} from './disposition-storage-adapters';
export type {
  OrbitDbDispositionStorageAdapterOptions,
} from './disposition-storage-adapters';

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

export type {
  BrowserProfileProvidersConfig,
  BrowserProfileProviders,
  BrowserProfileProvidersFromSphereConfig,
} from './browser';
export type {
  NodeProfileProvidersConfig,
  NodeProfileProviders,
  NodeProfileProvidersFromSphereConfig,
} from './node';
