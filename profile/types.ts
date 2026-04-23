/**
 * UXF Profile Type Definitions
 *
 * All type definitions for the Profile persistence system.
 * References: PROFILE-ARCHITECTURE.md Sections 2, 2.3, 5.2, 7.6, 9.1
 *
 * This file is types-only with the exception of the key mapping constants
 * (PROFILE_KEY_MAPPING, CACHE_ONLY_KEYS, IPFS_STATE_KEYS_PATTERN).
 */

import type { OracleProvider } from '../oracle';
import type { ProfilePointerLayer } from './aggregator-pointer';

// =============================================================================
// OrbitDB Configuration
// =============================================================================

/**
 * Configuration for connecting to an OrbitDB instance.
 * The database identity is derived from the wallet's secp256k1 key.
 */
export interface OrbitDbConfig {
  /** Wallet private key (hex) for identity derivation */
  readonly privateKey: string;
  /** Local storage directory for OrbitDB data (Node.js only) */
  readonly directory?: string;
  /** libp2p bootstrap peers for peer discovery */
  readonly bootstrapPeers?: string[];
  /** Enable libp2p pubsub for replication (default: true) */
  readonly enablePubSub?: boolean;
}

// =============================================================================
// Profile Configuration
// =============================================================================

/**
 * Configuration for Profile initialization.
 * Mirrors the IpfsStorageConfig pattern from impl/shared/ipfs/ipfs-types.ts.
 */
export interface ProfileConfig {
  /** OrbitDB connection configuration */
  readonly orbitDb: OrbitDbConfig;
  /** Whether to encrypt values stored in OrbitDB (default: true) */
  readonly encrypt?: boolean;
  /** IPFS gateway URLs for CAR file pinning/fetching */
  readonly ipfsGateways?: string[];
  /** Maximum local cache size in bytes (optional, platform-dependent) */
  readonly cacheMaxSizeBytes?: number;
  /** Consolidation retention period in ms before removing superseded bundles (default: 7 days) */
  readonly consolidationRetentionMs?: number;
  /** Minimum consolidation retention period in ms (default: 24 hours) */
  readonly consolidationRetentionMinMs?: number;
  /** Write-behind debounce window in ms (default: 2000) */
  readonly flushDebounceMs?: number;
  /** Custom bootstrap peers for OrbitDB (convenience alias for orbitDb.bootstrapPeers) */
  readonly profileOrbitDbPeers?: string[];
  /**
   * Publish a wallet-keyed IPNS snapshot of active bundle CIDs after
   * every flush, and attempt to resolve it on cold-start when the
   * local OrbitDB has no bundles. Default: true.
   *
   * This is an OrbitDB-layer parity assist — without it, a freshly
   * re-imported wallet on a wiped device cannot discover its own
   * bundles unless another live peer is replicating the OrbitDB
   * OpLog. Publish is best-effort (never fails the flush).
   *
   * Tests and specialised deployments can opt out with `false`.
   */
  readonly ipnsSnapshot?: boolean;
  /** Enable debug logging (default: false) */
  readonly debug?: boolean;
}

// =============================================================================
// UxfBundleRef — Per-Bundle Reference (Section 2.3)
// =============================================================================

/**
 * Reference to a single UXF bundle stored as a CAR file on IPFS.
 * Each bundle is stored as a separate OrbitDB key: `tokens.bundle.{CID}`.
 * Two devices writing different bundles never conflict because they write
 * to different keys.
 *
 * See PROFILE-ARCHITECTURE.md Section 2.3 for the multi-bundle model.
 */
export interface UxfBundleRef {
  /** CID of the UXF CAR file on IPFS */
  readonly cid: string;
  /** Bundle lifecycle status */
  readonly status: 'active' | 'superseded';
  /** Creation timestamp (Unix seconds) */
  readonly createdAt: number;
  /** Optional device identifier that created this bundle */
  readonly device?: string;
  /** CID of the consolidated bundle that includes this one (set when superseded) */
  readonly supersededBy?: string;
  /** Unix seconds -- when to remove this entry from the Profile (after safety period) */
  readonly removeFromProfileAfter?: number;
  /** Number of tokens in this bundle (for quick display without fetching CAR) */
  readonly tokenCount?: number;
}

// =============================================================================
// Consolidation State
// =============================================================================

/**
 * State written to OrbitDB as `consolidation.pending` during a consolidation
 * operation. Used for crash recovery and concurrent consolidation guards.
 *
 * See PROFILE-ARCHITECTURE.md Section 2.3 (Crash recovery for consolidation).
 */
export interface ConsolidationPendingState {
  /** CIDs of the source bundles being consolidated */
  readonly sourceCids: readonly string[];
  /** Timestamp when consolidation started (Unix seconds) */
  readonly startedAt: number;
  /** Device identifier performing the consolidation */
  readonly device: string;
}

// =============================================================================
// Migration Types (Section 7.6)
// =============================================================================

/**
 * Phases of the legacy-to-Profile migration.
 * Migration tracks progress via a local-only `migration.phase` key
 * for crash recovery and resume.
 */
export type MigrationPhase =
  | 'syncing'
  | 'transforming'
  | 'persisting'
  | 'verifying'
  | 'cleaning'
  | 'complete';

/**
 * Result of a completed migration operation.
 */
export interface MigrationResult {
  /** Whether the migration completed successfully */
  readonly success: boolean;
  /** Number of storage keys migrated */
  readonly keysMigrated: number;
  /** Number of tokens migrated */
  readonly tokensMigrated: number;
  /** Number of per-address scopes migrated */
  readonly addressesMigrated: number;
  /** Duration of the migration in ms */
  readonly durationMs: number;
  /** Error message if migration failed */
  readonly error?: string;
  /** Phase at which migration failed (if applicable) */
  readonly failedAtPhase?: MigrationPhase;
}

// =============================================================================
// Encryption Configuration (Section 9.1)
// =============================================================================

/**
 * Encryption configuration for Profile values.
 * All OrbitDB values and CAR files are encrypted with a key derived
 * from the wallet master key via HKDF.
 *
 * profileEncryptionKey = HKDF(masterKey, "uxf-profile-encryption", 32)
 */
export interface ProfileEncryptionConfig {
  /** Whether encryption is enabled (default: true) */
  readonly enabled: boolean;
  /** HKDF info string used for key derivation */
  readonly hkdfInfo: string;
  /** Derived key length in bytes */
  readonly keyLengthBytes: number;
  /** AES-GCM IV length in bytes */
  readonly ivLengthBytes: number;
}

/** Default encryption configuration */
export const DEFAULT_ENCRYPTION_CONFIG: ProfileEncryptionConfig = {
  enabled: true,
  hkdfInfo: 'uxf-profile-encryption',
  keyLengthBytes: 32,
  ivLengthBytes: 12,
} as const;

// =============================================================================
// Provider Options
// =============================================================================

/**
 * Options for constructing a ProfileStorageProvider.
 * The provider wraps a local cache (IndexedDB or file-based) with
 * an OrbitDB-backed persistence layer.
 */
export interface ProfileStorageProviderOptions {
  /** Profile configuration */
  readonly config: ProfileConfig;
  /** Enable encryption of OrbitDB values (default: true) */
  readonly encrypt?: boolean;
  /** Encryption configuration overrides */
  readonly encryptionConfig?: Partial<ProfileEncryptionConfig>;
  /**
   * Oracle provider used by the aggregator pointer layer (Phase D wiring).
   * The pointer layer consumes `getAggregatorClient()` and `getRootTrustBase()`
   * from this instance — the same oracle passed to L4 / `PaymentsModule` so
   * the embedded `RootTrustBase` is shared (SPEC §8.4.2 H6).
   */
  readonly oracle?: OracleProvider;
  /** Enable debug logging */
  readonly debug?: boolean;
}

/**
 * Options for constructing a ProfileTokenStorageProvider.
 * The provider bridges TxfStorageData (PaymentsModule format)
 * and UXF bundles stored as encrypted CAR files on IPFS.
 */
export interface ProfileTokenStorageProviderOptions {
  /** Profile configuration */
  readonly config: ProfileConfig;
  /** Address identifier for per-address scoping */
  readonly addressId: string;
  /** Enable encryption of CAR files (default: true) */
  readonly encrypt?: boolean;
  /** Encryption configuration overrides */
  readonly encryptionConfig?: Partial<ProfileEncryptionConfig>;
  /** Write-behind debounce window in ms (default: 2000) */
  readonly flushDebounceMs?: number;
  /**
   * Oracle provider used by the aggregator pointer layer (Phase D wiring).
   * Forwarded from the Profile factory. See ProfileStorageProviderOptions.
   */
  readonly oracle?: OracleProvider;
  /**
   * Lazy accessor for the aggregator pointer layer owned by the
   * companion `ProfileStorageProvider`. The pointer layer is
   * constructed asynchronously after Phase B OrbitDB attach, so at
   * factory-time it does not exist yet — callers pass a closure that
   * reads `storage.getPointerLayer()` on demand. Returns `null` when
   * the pointer is unavailable (no oracle, BLOCKED state, storage not
   * durable, etc.); consumers fall back to the legacy IPNS path.
   *
   * Optional during rollout. When absent, token storage runs in the
   * pre-pointer mode (IPNS-only cold-start recovery).
   */
  readonly getPointerLayer?: () => ProfilePointerLayer | null;
  /** Enable debug logging */
  readonly debug?: boolean;
}

// =============================================================================
// ProfileDatabase Interface (OrbitDB Wrapper)
// =============================================================================

/**
 * Abstract interface for the OrbitDB key-value database.
 * Implemented by the OrbitDB adapter (WU-P03). The rest of the Profile
 * system never imports @orbitdb/core directly -- it uses this interface.
 *
 * Two write/read APIs coexist during the OpLog-schema migration
 * (PROFILE-OPLOG-SCHEMA.md §7):
 *   - Legacy opaque-bytes: `put(key, Uint8Array)` / `get(key)`
 *   - Structured envelope: `putEntry(key, OpLogEntryEnvelope)` / `getEntry(key)`
 * Callers migrate one module at a time. `getEntry` auto-wraps legacy
 * opaque bytes in a synthetic envelope, so a partial migration reads cleanly.
 */
export interface ProfileDatabase {
  /**
   * Open the database connection.
   * Creates Helia instance, OrbitDB instance, and opens the KV database
   * with a deterministic address derived from the wallet key.
   */
  connect(config: OrbitDbConfig): Promise<void>;

  /** Write a value (encrypted bytes) to the database. */
  put(key: string, value: Uint8Array): Promise<void>;

  /** Read a value by key. Returns null if the key does not exist. */
  get(key: string): Promise<Uint8Array | null>;

  /** Delete a key from the database. */
  del(key: string): Promise<void>;

  /**
   * Return all entries, optionally filtered by key prefix.
   * Used for listing `tokens.bundle.*` keys.
   */
  all(prefix?: string): Promise<Map<string, Uint8Array>>;

  /** Close the database, Helia, and libp2p connections. */
  close(): Promise<void>;

  /**
   * Subscribe to replication events (new data arriving from peers).
   * Returns an unsubscribe function.
   */
  onReplication(callback: () => void): () => void;

  /** Whether `connect()` has been called and `close()` has not. */
  isConnected(): boolean;

  /**
   * Write a structured OpLog entry envelope (PROFILE-OPLOG-SCHEMA.md §5).
   * Type is imported lazily via `import type` elsewhere; declared as
   * `unknown` here to avoid a circular types dependency.
   */
  putEntry?(key: string, entry: unknown): Promise<void>;

  /**
   * Read a structured OpLog entry envelope. Auto-wraps legacy opaque
   * bytes in a synthetic envelope (§7.1). Returns null if key absent.
   *
   * SECURITY DEFAULT: returned envelope's `originated` is forced to
   * `'replicated'` UNLESS caller passes `trustLocalClaim: true` AND the
   * key was written by a local putEntry in this session. Prevents peer-
   * forged `'user'`/`'system'` tags from leaking into local state (§5.2).
   *
   * @param opts.downgradeAsReplicated  — Legacy flag: force downgrade
   *   regardless. Kept for backward compat; new callers use the default.
   * @param opts.trustLocalClaim  — When true, returns the stored tag
   *   verbatim IF the key is known to be locally-authored. Otherwise
   *   still downgrades.
   */
  getEntry?(
    key: string,
    opts?: { downgradeAsReplicated?: boolean; trustLocalClaim?: boolean },
  ): Promise<unknown | null>;
}

// =============================================================================
// Sync Events
// =============================================================================

/** Types of sync events emitted by the Profile system. */
export type SyncEventType =
  | 'sync:started'
  | 'sync:completed'
  | 'sync:failed'
  | 'sync:remote-updated'
  | 'sync:bundle-added'
  | 'sync:bundle-removed';

/** Callback for sync events. */
export type SyncEventCallback = (event: {
  readonly type: SyncEventType;
  readonly timestamp: number;
  readonly detail?: unknown;
}) => void;

// =============================================================================
// Key Mapping Types and Constants (Section 5.2)
// =============================================================================

/**
 * Type-safe mapping entry from legacy storage key to Profile key name.
 * The `dynamic` flag indicates keys that require pattern-based transformation
 * (e.g., per-address keys with address ID substitution).
 */
export interface ProfileKeyMapEntry {
  /** The Profile key name (dot-notation) */
  readonly profileKey: string;
  /** Whether this key requires dynamic address ID substitution */
  readonly dynamic: boolean;
}

/**
 * Type-safe mapping of legacy storage keys to Profile key names.
 */
export type ProfileKeyMap = Readonly<Record<string, ProfileKeyMapEntry>>;

/**
 * Complete key mapping table from Section 5.2.
 * Maps legacy storage key names (without the `sphere_` prefix) to Profile key names.
 *
 * Global keys map directly. Per-address keys use `{addr}` as a placeholder
 * that is replaced at runtime with the actual address ID.
 */
export const PROFILE_KEY_MAPPING: ProfileKeyMap = {
  // --- Global identity keys ---
  'mnemonic': { profileKey: 'identity.mnemonic', dynamic: false },
  'master_key': { profileKey: 'identity.masterKey', dynamic: false },
  'chain_code': { profileKey: 'identity.chainCode', dynamic: false },
  'derivation_path': { profileKey: 'identity.derivationPath', dynamic: false },
  'base_path': { profileKey: 'identity.basePath', dynamic: false },
  'derivation_mode': { profileKey: 'identity.derivationMode', dynamic: false },
  'wallet_source': { profileKey: 'identity.walletSource', dynamic: false },
  'wallet_exists': { profileKey: 'wallet_exists', dynamic: false }, // local-only fast-path flag
  'current_address_index': { profileKey: 'identity.currentAddressIndex', dynamic: false },

  // --- Global address keys ---
  'address_nametags': { profileKey: 'addresses.nametags', dynamic: false },
  'tracked_addresses': { profileKey: 'addresses.tracked', dynamic: false },

  // --- Global transport keys ---
  // Note: last_wallet_event_ts_{pubkey} and last_dm_event_ts_{pubkey} are dynamic
  // and handled by IPFS_STATE_KEYS_PATTERN + dynamic mapping logic, not here.
  'group_chat_relay_url': { profileKey: 'groupchat.relayUrl', dynamic: false },

  // --- Cache-only keys (stored in CACHE_ONLY_KEYS, NOT in OrbitDB) ---
  'token_registry_cache': { profileKey: 'tokens.registryCache', dynamic: false },
  'token_registry_cache_ts': { profileKey: 'tokens.registryCacheTs', dynamic: false },
  'price_cache': { profileKey: 'prices.cache', dynamic: false },
  'price_cache_ts': { profileKey: 'prices.cacheTs', dynamic: false },

  // --- Per-address keys (dynamic: address ID prefix) ---
  'pending_transfers': { profileKey: '{addr}.pendingTransfers', dynamic: true },
  'outbox': { profileKey: '{addr}.outbox', dynamic: true },
  'conversations': { profileKey: '{addr}.conversations', dynamic: true },
  'messages': { profileKey: '{addr}.messages', dynamic: true },
  'transaction_history': { profileKey: '{addr}.transactionHistory', dynamic: true },
  'pending_v5_tokens': { profileKey: '{addr}.pendingV5Tokens', dynamic: true },
  'group_chat_groups': { profileKey: '{addr}.groupchat.groups', dynamic: true },
  'group_chat_messages': { profileKey: '{addr}.groupchat.messages', dynamic: true },
  'group_chat_members': { profileKey: '{addr}.groupchat.members', dynamic: true },
  'group_chat_processed_events': { profileKey: '{addr}.groupchat.processedEvents', dynamic: true },
  'processed_split_group_ids': { profileKey: '{addr}.processedSplitGroupIds', dynamic: true },
  'processed_combined_transfer_ids': { profileKey: '{addr}.processedCombinedTransferIds', dynamic: true },

  // --- Per-address accounting keys ---
  'cancelled_invoices': { profileKey: '{addr}.accounting.cancelledInvoices', dynamic: true },
  'closed_invoices': { profileKey: '{addr}.accounting.closedInvoices', dynamic: true },
  'frozen_balances': { profileKey: '{addr}.accounting.frozenBalances', dynamic: true },
  'auto_return': { profileKey: '{addr}.accounting.autoReturn', dynamic: true },
  'auto_return_ledger': { profileKey: '{addr}.accounting.autoReturnLedger', dynamic: true },
  'inv_ledger_index': { profileKey: '{addr}.accounting.invLedgerIndex', dynamic: true },
  'token_scan_state': { profileKey: '{addr}.accounting.tokenScanState', dynamic: true },

  // --- Per-address swap keys ---
  'swap_index': { profileKey: '{addr}.swap.index', dynamic: true },
  // Note: {addr}_swap:{swapId} is handled by dynamic pattern matching, not a static entry.

  // --- Per-address operational keys (stored in OrbitDB due to criticality) ---
  'mintOutbox': { profileKey: '{addr}.mintOutbox', dynamic: true },
  'invalidTokens': { profileKey: '{addr}.invalidTokens', dynamic: true },
  'invalidatedNametags': { profileKey: '{addr}.invalidatedNametags', dynamic: true },
  'tombstones': { profileKey: '{addr}.tombstones', dynamic: true },
} as const;

/**
 * Keys that are stored ONLY in the local cache, never written to OrbitDB.
 * These are regenerated from external APIs and are not replicated.
 *
 * See PROFILE-ARCHITECTURE.md Section 2.1 "Cache-only keys".
 */
export const CACHE_ONLY_KEYS: ReadonlySet<string> = new Set([
  'token_registry_cache',
  'token_registry_cache_ts',
  'price_cache',
  'price_cache_ts',
]);

/**
 * Regex pattern matching IPFS/IPNS state keys that are obsoleted by OrbitDB.
 * These keys are consumed during migration but NOT carried forward to the Profile.
 *
 * Matches: sphere_ipfs_seq_*, sphere_ipfs_cid_*, sphere_ipfs_ver_*
 * (After prefix stripping: ipfs_seq_*, ipfs_cid_*, ipfs_ver_*)
 */
export const IPFS_STATE_KEYS_PATTERN: RegExp = /^ipfs_(seq|cid|ver)_/;

// =============================================================================
// Address ID Utility
// =============================================================================

/**
 * Compute a short address ID from a DIRECT:// address string.
 * Format: `DIRECT_{first6}_{last6}` (lowercase hex).
 *
 * This matches the address ID format used by sphere-sdk's storage layer
 * for per-address key scoping.
 *
 * @param directAddress - A DIRECT:// address (e.g. `DIRECT://AABBCC...DDEEFF`)
 * @returns Short address ID (e.g. `DIRECT_aabbcc_ddeeff`)
 */
export function computeAddressId(directAddress: string): string {
  // Accept both `DIRECT://` and degenerate `DIRECT:` prefixes. The former is
  // canonical; the latter appears in some legacy/profile code paths.
  let clean: string;
  if (directAddress.startsWith('DIRECT://')) {
    clean = directAddress.slice(9);
  } else if (directAddress.startsWith('DIRECT:')) {
    clean = directAddress.slice(7);
  } else {
    clean = directAddress;
  }
  const first6 = clean.slice(0, 6).toLowerCase();
  const last6 = clean.slice(-6).toLowerCase();
  return `DIRECT_${first6}_${last6}`;
}
