/**
 * ProfileMigration — 6-step migration from legacy storage to Profile format.
 *
 * Converts legacy IndexedDB/file + old IPFS data into the OrbitDB + UXF bundle
 * model. The migration is idempotent and crash-recoverable: progress is tracked
 * via a local-only `migration.phase` key in the legacy storage provider. On
 * restart, the migration resumes from the last completed phase.
 *
 * Steps (from PROFILE-ARCHITECTURE.md Section 7.6):
 *   1. SYNC OLD IPFS  -- fetch latest TXF from legacy IPNS (optional, skip on failure)
 *   2. TRANSFORM LOCAL -- map legacy keys to Profile format, extract tokens + operational state
 *   3. PERSIST TO ORBITDB -- write Profile keys + pin UXF CAR + add bundle ref
 *   4. SANITY CHECK -- read back from OrbitDB and verify counts + token existence
 *   5. CLEANUP -- remove legacy data (preserve SphereVestingCacheV5)
 *   6. DONE -- set migration.phase = 'complete'
 *
 * @see PROFILE-ARCHITECTURE.md Section 7.6
 * @module profile/migration
 */

import { logger } from '../core/logger.js';
import type {
  StorageProvider,
  TokenStorageProvider,
  TxfStorageDataBase,
  TxfSentEntry,
  TxfInvalidEntry,
  HistoryRecord,
} from '../storage/storage-provider.js';
import type { ProfileStorageProvider } from './profile-storage-provider.js';
import type { ProfileTokenStorageProvider } from './profile-token-storage-provider.js';
import type { ProfileDatabase, MigrationPhase, MigrationResult } from './types.js';
import { PROFILE_KEY_MAPPING, CACHE_ONLY_KEYS, IPFS_STATE_KEYS_PATTERN } from './types.js';
import { ProfileError } from './errors.js';
import { STORAGE_PREFIX } from '../constants.js';
import {
  encryptProfileValue,
  decryptProfileValue,
} from './encryption.js';

// =============================================================================
// Constants
// =============================================================================

/** Local-only key tracking migration phase for crash recovery. */
const MIGRATION_PHASE_KEY = 'migration.phase';

/** Local-only key tracking migration start timestamp. */
const MIGRATION_STARTED_AT_KEY = 'migration.startedAt';

/**
 * Issue #330 — marker key written into the LEGACY token storage when
 * migration step 5c completes, in lieu of wiping it. Signals that the
 * legacy token DB is post-migration and should be treated as a read-
 * only fallback (not as the live token store). The marker carries the
 * migration completion timestamp for forensics.
 *
 * Pre-#330 step 5c wiped the legacy token DB entirely. Post-#330 we
 * keep the bytes in place so the runtime read fallback
 * (`ProfileTokenStorageProvider.setFallbackTokenStorage`) can recover
 * tokens whose Profile blockstore copies are lost (memory-blockstore
 * eviction + gateway 404 = the failure mode in #330).
 */
const LEGACY_MIGRATED_MARKER_KEY = 'migration.migratedAt';

/**
 * Issue #330 — public re-export of the legacy-migrated marker key.
 *
 * Factories and consumer apps can probe `legacyStorage.get(...)` for
 * this key to auto-wire a `fallbackTokenStorage` when the wallet was
 * migrated from a pre-Profile layout. Returns the migration-completion
 * timestamp (ms since epoch, as a string) when present, null when
 * the wallet either was never migrated or is a fresh Profile wallet.
 *
 * Storage shape: written via `legacyStorage.set(KEY, String(ts))` in
 * `profile/migration.ts` step 5c. The KV provider prefixes with
 * `STORAGE_PREFIX` ('sphere_') so the on-disk key is typically
 * `sphere_migration.migratedAt`. Pass the unprefixed name to
 * `StorageProvider.get` — providers do the prefix translation
 * internally.
 */
export const LEGACY_MIGRATED_MARKER = LEGACY_MIGRATED_MARKER_KEY;

/**
 * Regex pattern matching legacy IPFS sequence keys.
 * These indicate that the wallet has previously synced via IPFS/IPNS.
 */
const IPFS_SEQ_KEY_PATTERN = /^(?:sphere_)?ipfs_seq_/;

/**
 * Regex pattern matching legacy IPFS CID keys.
 * Format: `sphere_ipfs_cid_{ipnsName}` or `ipfs_cid_{ipnsName}`.
 */
const IPFS_CID_KEY_PATTERN = /^(?:sphere_)?ipfs_cid_/;

/**
 * TXF operational keys that are NOT individual token entries.
 * Used to distinguish token keys from operational keys when scanning TXF data.
 */
const TXF_OPERATIONAL_KEYS: ReadonlySet<string> = new Set([
  '_meta',
  '_tombstones',
  '_outbox',
  '_sent',
  '_invalid',
  '_history',
  '_mintOutbox',
  '_invalidatedNametags',
]);

/**
 * Ordered list of migration phases. Used for resume logic:
 * if the stored phase is X, we resume from the step AFTER X.
 */
const PHASE_ORDER: readonly MigrationPhase[] = [
  'syncing',
  'transforming',
  'persisting',
  'verifying',
  'cleaning',
  'complete',
];

/** Default IPFS API endpoint for unpin operations. */
const DEFAULT_IPFS_API_URL = 'https://ipfs.unicity.network';

// =============================================================================
// Internal Types
// =============================================================================

/**
 * Intermediate representation of all data extracted from legacy storage
 * during the TRANSFORM step.
 */
interface TransformedData {
  /** Profile-format key-value pairs (global + per-address). */
  readonly profileKeys: Map<string, string>;
  /** TXF storage data (tokens + operational state) from legacy TokenStorageProvider. */
  readonly txfData: TxfStorageDataBase | null;
  /** Token IDs extracted from TXF data (for sanity check). */
  readonly tokenIds: ReadonlySet<string>;
  /** Number of history entries (including merged _sent). */
  readonly historyCount: number;
  /** Number of conversation entries. */
  readonly conversationCount: number;
  /** Accounting and swap key names for sanity check. */
  readonly accountingAndSwapKeys: ReadonlySet<string>;
  /** Number of pending transfer entries. */
  readonly pendingTransferCount: number;
}

// =============================================================================
// ProfileMigration
// =============================================================================

/**
 * Orchestrates the 6-step migration from legacy storage to Profile format.
 *
 * @deprecated Prefer the import-based migration via `importLegacyTokens`
 * (see profile/import-from-legacy.ts). The 6-step destructive flow this
 * class implements predates the explicit / non-destructive / re-runnable
 * model the CLI now uses. Kept for backwards compatibility with consumers
 * that already wire it. New consumers should use the import path:
 *
 * ```ts
 * import { importLegacyTokens } from '@unicitylabs/sphere-sdk/profile';
 *
 * const result = await importLegacyTokens(
 *   legacyTokenStorage,
 *   profileSphere.payments,
 *   { dryRun: false },
 * );
 * ```
 *
 * Usage (legacy):
 * ```ts
 * const migration = new ProfileMigration();
 * if (await migration.needsMigration(legacyStorage)) {
 *   const result = await migration.migrate(
 *     legacyStorage, legacyTokenStorage,
 *     profileStorage, profileTokenStorage,
 *   );
 *   if (!result.success) {
 *     console.error('Migration failed:', result.error);
 *   }
 * }
 * ```
 */
export class ProfileMigration {
  // Steelman⁴³ warning: deprecated. The 6-step destructive flow merges
  // remote IPFS data via `mergeTxfData` with NO cryptographic
  // verification. Use `importLegacyTokens` (profile/import-from-legacy)
  // for new integrations — it routes through the UXF verifier.
  // This class is kept for backward-compat only.
  private static _deprecationWarned = false;
  constructor() {
    if (!ProfileMigration._deprecationWarned) {
      ProfileMigration._deprecationWarned = true;
      // eslint-disable-next-line no-console
      console.warn(
        '[ProfileMigration] DEPRECATED: this 6-step destructive migration ' +
          'merges remote IPFS data without cryptographic verification. ' +
          'New code should use importLegacyTokens (profile/import-from-legacy) ' +
          'which routes through the UXF integrity verifier.',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Check whether migration is needed.
   *
   * Migration is needed when:
   * 1. Legacy storage contains wallet data (`wallet_exists` key present), AND
   * 2. The migration has not already completed (`migration.phase` !== 'complete')
   *
   * @param legacyStorage - The existing StorageProvider (IndexedDB or file-based)
   * @returns true if migration should run
   */
  async needsMigration(legacyStorage: StorageProvider): Promise<boolean> {
    const phase = await this.getMigrationPhase(legacyStorage);
    if (phase === 'complete') {
      return false;
    }

    const walletExists = await legacyStorage.has('wallet_exists');
    return walletExists;
  }

  /**
   * Get the current migration phase from legacy storage.
   * Returns null if no migration has ever been started.
   *
   * @param legacyStorage - The existing StorageProvider
   * @returns Current phase or null
   */
  async getMigrationPhase(legacyStorage: StorageProvider): Promise<MigrationPhase | null> {
    const phase = await legacyStorage.get(MIGRATION_PHASE_KEY);
    if (phase !== null && isValidPhase(phase)) {
      return phase;
    }
    return null;
  }

  /**
   * Run the full 6-step migration, or resume from a previously interrupted point.
   *
   * The migration is idempotent: if interrupted and restarted, it resumes from
   * the last completed phase. Legacy data is preserved on failure (no data loss).
   *
   * @param legacyStorage       - Existing StorageProvider (IndexedDB or file-based)
   * @param legacyTokenStorage  - Existing TokenStorageProvider with TXF data
   * @param profileStorage      - Target ProfileStorageProvider (OrbitDB-backed)
   * @param profileTokenStorage - Target ProfileTokenStorageProvider (UXF bundles)
   * @returns Result describing success/failure and migration counts
   */
  async migrate(
    legacyStorage: StorageProvider,
    legacyTokenStorage: TokenStorageProvider<TxfStorageDataBase>,
    profileStorage: ProfileStorageProvider,
    profileTokenStorage: ProfileTokenStorageProvider,
  ): Promise<MigrationResult> {
    const startTime = Date.now();

    // Determine resume point
    const existingPhase = await this.getMigrationPhase(legacyStorage);
    const resumeFromIndex = existingPhase !== null
      ? PHASE_ORDER.indexOf(existingPhase) + 1
      : 0;

    // Already complete -- return early
    if (existingPhase === 'complete') {
      return {
        success: true,
        keysMigrated: 0,
        tokensMigrated: 0,
        addressesMigrated: 0,
        durationMs: Date.now() - startTime,
      };
    }

    this.log(
      'Starting migration',
      existingPhase ? `(resuming from after '${existingPhase}')` : '(fresh)',
    );

    // Record start time for diagnostics
    if (existingPhase === null) {
      await legacyStorage.set(MIGRATION_STARTED_AT_KEY, String(Date.now()));
    }

    let transformed: TransformedData | null = null;

    try {
      // Step 1: SYNC OLD IPFS (phase index 0 = 'syncing')
      if (resumeFromIndex <= 0) {
        await this.setPhase(legacyStorage, 'syncing');
        await this.stepSyncOldIpfs(legacyStorage, legacyTokenStorage);
      }

      // Step 2: TRANSFORM LOCAL (phase index 1 = 'transforming')
      // Always re-run transform even on resume to ensure consistent state
      await this.setPhase(legacyStorage, 'transforming');
      transformed = await this.stepTransformLocal(legacyStorage, legacyTokenStorage);

      // Step 3: PERSIST TO ORBITDB (phase index 2 = 'persisting')
      if (resumeFromIndex <= 2) {
        await this.setPhase(legacyStorage, 'persisting');
        await this.stepPersistToOrbitDb(
          profileStorage,
          profileTokenStorage,
          transformed,
        );
      }

      // Step 4: SANITY CHECK (phase index 3 = 'verifying')
      await this.setPhase(legacyStorage, 'verifying');
      await this.stepSanityCheck(
        profileStorage,
        profileTokenStorage,
        transformed,
      );

      // Step 5: CLEANUP (phase index 4 = 'cleaning')
      if (resumeFromIndex <= 4) {
        await this.setPhase(legacyStorage, 'cleaning');
        await this.stepCleanup(legacyStorage, legacyTokenStorage);
      }

      // Step 6: DONE (phase index 5 = 'complete')
      await this.setPhase(legacyStorage, 'complete');

      const result: MigrationResult = {
        success: true,
        keysMigrated: transformed.profileKeys.size,
        tokensMigrated: transformed.tokenIds.size,
        addressesMigrated: countAddresses(transformed),
        durationMs: Date.now() - startTime,
      };

      this.log('Migration completed successfully', JSON.stringify(result));
      return result;
    } catch (err) {
      const currentPhase = await this.getMigrationPhase(legacyStorage);
      const errorMsg = err instanceof Error ? err.message : String(err);

      this.log('Migration failed at phase', currentPhase, ':', errorMsg);

      return {
        success: false,
        keysMigrated: transformed?.profileKeys.size ?? 0,
        tokensMigrated: transformed?.tokenIds.size ?? 0,
        addressesMigrated: transformed !== null ? countAddresses(transformed) : 0,
        durationMs: Date.now() - startTime,
        error: errorMsg,
        failedAtPhase: currentPhase ?? undefined,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Step 1: SYNC OLD IPFS
  // ---------------------------------------------------------------------------

  /**
   * Attempt to sync latest data from old IPFS/IPNS before migration.
   *
   * If no IPFS keys exist in legacy storage, this step is skipped entirely.
   * If IPNS resolution or data fetching fails, the step is skipped with a
   * warning -- the migration proceeds with local-only data.
   */
  private async stepSyncOldIpfs(
    legacyStorage: StorageProvider,
    legacyTokenStorage: TokenStorageProvider<TxfStorageDataBase>,
  ): Promise<void> {
    this.log('Step 1: SYNC OLD IPFS');

    // Check for IPFS sequence keys (indicates previous IPFS sync usage)
    const allKeys = await legacyStorage.keys();
    const ipfsSeqKeys = allKeys.filter((k) => IPFS_SEQ_KEY_PATTERN.test(k));

    if (ipfsSeqKeys.length === 0) {
      this.log('No IPFS keys found -- skipping IPFS sync (local-only wallet)');
      return;
    }

    this.log(`Found ${ipfsSeqKeys.length} IPFS sequence key(s) -- attempting sync`);

    try {
      // Try to sync via the legacy token storage provider.
      // This will attempt to resolve IPNS, fetch the latest TXF data,
      // and merge with local state.
      const localLoadResult = await legacyTokenStorage.load();
      if (localLoadResult.success && localLoadResult.data) {
        const syncResult = await legacyTokenStorage.sync(localLoadResult.data);
        if (syncResult.success) {
          this.log(
            `IPFS sync completed: added=${syncResult.added}, removed=${syncResult.removed}`,
          );
        } else {
          this.log('IPFS sync returned failure:', syncResult.error ?? 'unknown');
          this.log('Proceeding with local data only');
        }
      } else {
        this.log('Could not load local token data for IPFS sync -- proceeding with local data only');
      }
    } catch (err) {
      // IPNS resolution failure or network error -- non-fatal
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`IPFS sync failed (non-fatal): ${msg}`);
      this.log(
        'IPNS resolution failed -- migrating from local data only. ' +
        'Remote IPFS data may not be included.',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Step 2: TRANSFORM LOCAL
  // ---------------------------------------------------------------------------

  /**
   * Read all legacy data and transform it into Profile-format key-value pairs.
   *
   * This step:
   * - Maps legacy StorageProvider keys to Profile key names
   * - Loads TXF token data from TokenStorageProvider
   * - Extracts nametag tokens from `_nametag` entry and `_nametags` array entries
   * - Extracts forked tokens from `_forked_*` entries
   * - Merges `_sent` entries into transactionHistory as type='SENT'
   * - Collects operational state (_tombstones, _outbox, _mintOutbox, etc.)
   * - Excludes IPFS state keys (consumed but NOT carried forward)
   */
  private async stepTransformLocal(
    legacyStorage: StorageProvider,
    legacyTokenStorage: TokenStorageProvider<TxfStorageDataBase>,
  ): Promise<TransformedData> {
    this.log('Step 2: TRANSFORM LOCAL');

    const profileKeys = new Map<string, string>();
    const tokenIds = new Set<string>();
    let historyCount = 0;
    let conversationCount = 0;
    const accountingAndSwapKeys = new Set<string>();
    let pendingTransferCount = 0;

    // --- 2a. Read and map all StorageProvider keys ---
    const allKeys = await legacyStorage.keys();
    this.log(`Found ${allKeys.length} legacy storage keys`);

    for (const rawKey of allKeys) {
      // Strip storage prefix if present
      let stripped = rawKey;
      if (stripped.startsWith(STORAGE_PREFIX)) {
        stripped = stripped.slice(STORAGE_PREFIX.length);
      }

      // Skip IPFS state keys -- consumed but not carried forward
      if (IPFS_STATE_KEYS_PATTERN.test(stripped)) {
        continue;
      }

      // Skip migration tracking keys
      if (stripped === MIGRATION_PHASE_KEY || stripped === MIGRATION_STARTED_AT_KEY) {
        continue;
      }

      // Read the value
      const value = await legacyStorage.get(rawKey);
      if (value === null) continue;

      // Map to Profile key name
      const profileKey = mapLegacyKeyToProfileKey(stripped);
      if (profileKey === null) continue;

      profileKeys.set(profileKey, value);

      // Track counts for sanity check
      if (profileKey.endsWith('.conversations')) {
        try {
          const parsed = JSON.parse(value);
          conversationCount += Array.isArray(parsed) ? parsed.length : 0;
        } catch {
          // best-effort
        }
      }
      if (profileKey.endsWith('.pendingTransfers')) {
        try {
          const parsed = JSON.parse(value);
          pendingTransferCount += Array.isArray(parsed) ? parsed.length : 0;
        } catch {
          // best-effort
        }
      }

      // Track accounting and swap keys
      if (
        profileKey.includes('.accounting.') ||
        profileKey.includes('.swap.') ||
        profileKey.includes('.swap:')
      ) {
        accountingAndSwapKeys.add(profileKey);
      }
    }

    // --- 2b. Read all tokens from TokenStorageProvider ---
    let txfData: TxfStorageDataBase | null = null;

    const loadResult = await legacyTokenStorage.load();
    if (loadResult.success && loadResult.data) {
      txfData = loadResult.data;

      // Extract token IDs (keys starting with _ that are not operational keys)
      for (const key of Object.keys(txfData)) {
        if (key.startsWith('_') && !TXF_OPERATIONAL_KEYS.has(key)) {
          tokenIds.add(key);
        }
      }

      // Extract archived tokens (keys starting with 'archived-')
      for (const key of Object.keys(txfData)) {
        if (key.startsWith('archived-')) {
          tokenIds.add(key);
        }
      }

      // Extract forked tokens (_forked_*)
      for (const key of Object.keys(txfData)) {
        if (key.startsWith('_forked_')) {
          tokenIds.add(key);
        }
      }

      // Extract nametag tokens from _nametag and _nametags entries
      extractNametagTokens(txfData, tokenIds);

      // --- 2c. Merge _sent entries into history as type='SENT' ---
      const existingHistory: HistoryRecord[] = txfData._history ?? [];

      if (txfData._sent && txfData._sent.length > 0) {
        const sentAsHistory = convertSentToHistory(txfData._sent);
        const mergedHistory = mergeHistoryEntries(existingHistory, sentAsHistory);

        // Find the address ID from _meta for the transactionHistory key
        const addrId = txfData._meta?.address;
        if (addrId) {
          profileKeys.set(`${addrId}.transactionHistory`, JSON.stringify(mergedHistory));
        }
        historyCount = mergedHistory.length;
      } else {
        historyCount = existingHistory.length;
      }

      this.log(`Extracted ${tokenIds.size} token(s), ${historyCount} history entries`);
    } else {
      this.log('No token data loaded from legacy storage (identity-only wallet)');
    }

    return {
      profileKeys,
      txfData,
      tokenIds,
      historyCount,
      conversationCount,
      accountingAndSwapKeys,
      pendingTransferCount,
    };
  }

  // ---------------------------------------------------------------------------
  // Step 3: PERSIST TO ORBITDB
  // ---------------------------------------------------------------------------

  /**
   * Write all transformed Profile data to OrbitDB and pin UXF CAR to IPFS.
   *
   * This step:
   * - Writes all profile key-value pairs via profileStorage.set()
   * - Saves TXF data via profileTokenStorage.save() (which builds UXF bundle,
   *   encrypts CAR, pins to IPFS, adds bundle ref to OrbitDB)
   */
  private async stepPersistToOrbitDb(
    profileStorage: ProfileStorageProvider,
    profileTokenStorage: ProfileTokenStorageProvider,
    data: TransformedData,
  ): Promise<void> {
    this.log('Step 3: PERSIST TO ORBITDB');

    // Write all profile keys to OrbitDB via ProfileStorageProvider.
    // We cast to StorageProvider because the public API is the interface.
    const storage = profileStorage as unknown as StorageProvider;

    let keysWritten = 0;
    for (const [key, value] of data.profileKeys) {
      try {
        await storage.set(key, value);
        keysWritten++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new ProfileError(
          'MIGRATION_FAILED',
          `Failed to write profile key '${key}': ${msg}`,
          err,
        );
      }
    }
    this.log(`Wrote ${keysWritten} profile keys`);

    // Save TXF data via ProfileTokenStorageProvider
    // (builds UXF bundle, encrypts CAR, pins to IPFS, adds bundle ref to OrbitDB)
    if (data.txfData !== null) {
      const saveResult = await profileTokenStorage.save(data.txfData);
      if (!saveResult.success) {
        throw new ProfileError(
          'MIGRATION_FAILED',
          `Failed to save token data: ${saveResult.error ?? 'unknown error'}`,
        );
      }
      this.log(`Token data saved, CID: ${saveResult.cid ?? 'debounced'}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Step 4: SANITY CHECK
  // ---------------------------------------------------------------------------

  /**
   * Verify the migration by reading back from Profile storage and comparing
   * with the transformed data.
   *
   * Checks:
   * - Each non-cache-only profile key can be read back
   * - Token count matches (each tokenId exists in the loaded data)
   * - Transaction history count matches
   * - Accounting and swap keys are present
   *
   * If ANY check fails, throws ProfileError to abort the migration.
   * Legacy data is preserved (not yet cleaned up at this point).
   */
  private async stepSanityCheck(
    profileStorage: ProfileStorageProvider,
    profileTokenStorage: ProfileTokenStorageProvider,
    data: TransformedData,
  ): Promise<void> {
    this.log('Step 4: SANITY CHECK');

    const errors: string[] = [];

    // --- 4a. Verify profile keys can be read back ---
    for (const [key] of data.profileKeys) {
      // Skip cache-only keys (they are not in OrbitDB)
      if (isCacheOnlyProfileKey(key)) continue;

      try {
        const storage = profileStorage as unknown as StorageProvider;
        const actual = await storage.get(key);
        if (actual === null) {
          errors.push(`Profile key '${key}' not found after persist`);
        }
      } catch (err) {
        errors.push(
          `Failed to read back profile key '${key}': ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // --- 4b. Verify token data ---
    if (data.txfData !== null && data.tokenIds.size > 0) {
      const loadResult = await profileTokenStorage.load();
      if (!loadResult.success || !loadResult.data) {
        errors.push(
          `Failed to load token data from profile: ${loadResult.error ?? 'no data returned'}`,
        );
      } else {
        const loadedData = loadResult.data;

        // Collect token IDs from loaded data
        const loadedTokenIds = new Set<string>();
        for (const key of Object.keys(loadedData)) {
          if (key.startsWith('_') && !TXF_OPERATIONAL_KEYS.has(key)) {
            loadedTokenIds.add(key);
          }
          if (key.startsWith('archived-') || key.startsWith('_forked_')) {
            loadedTokenIds.add(key);
          }
        }

        // Check token count
        if (loadedTokenIds.size < data.tokenIds.size) {
          errors.push(
            `Token count mismatch: expected at least ${data.tokenIds.size}, ` +
            `got ${loadedTokenIds.size}`,
          );
        }

        // Check each expected token ID exists
        for (const tokenId of data.tokenIds) {
          if (!loadedTokenIds.has(tokenId)) {
            // Tokens may have slightly different key forms (_ prefix added/removed)
            const altId = tokenId.startsWith('_')
              ? tokenId.slice(1)
              : `_${tokenId}`;
            if (!loadedTokenIds.has(altId)) {
              errors.push(`Token '${tokenId}' not found in migrated data`);
            }
          }
        }

        // Check transaction history count
        if (data.historyCount > 0) {
          const loadedHistory = loadedData._history ?? [];
          let bestHistoryCount = loadedHistory.length;

          // History might be in the profileTokenStorage transactionHistory key
          if (profileTokenStorage.getHistoryEntries) {
            try {
              const entries = await profileTokenStorage.getHistoryEntries();
              bestHistoryCount = Math.max(bestHistoryCount, entries.length);
            } catch {
              // best-effort
            }
          }

          if (bestHistoryCount < data.historyCount) {
            errors.push(
              `History count mismatch: expected ${data.historyCount}, ` +
              `got ${bestHistoryCount}`,
            );
          }
        }
      }
    }

    // --- 4c. Verify accounting and swap keys ---
    for (const key of data.accountingAndSwapKeys) {
      try {
        const storage = profileStorage as unknown as StorageProvider;
        const actual = await storage.get(key);
        if (actual === null) {
          errors.push(`Accounting/swap key '${key}' not found after persist`);
        }
      } catch (err) {
        errors.push(
          `Failed to verify accounting/swap key '${key}': ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // --- 4d. Report results ---
    if (errors.length > 0) {
      const summary = errors.slice(0, 10).join('; ');
      const suffix = errors.length > 10 ? ` (and ${errors.length - 10} more)` : '';
      throw new ProfileError(
        'MIGRATION_FAILED',
        `Sanity check failed with ${errors.length} error(s): ${summary}${suffix}`,
      );
    }

    this.log('Sanity check passed');
  }

  // ---------------------------------------------------------------------------
  // Step 5: CLEANUP
  // ---------------------------------------------------------------------------

  /**
   * Remove legacy data from local storage after a successful sanity check.
   *
   * Important:
   * - Does NOT delete SphereVestingCacheV5 (standalone L1 UTXO cache)
   * - Unpins only the last known IPFS CID (not all historical CIDs)
   * - Preserves the migration.phase key for future reference
   */
  private async stepCleanup(
    legacyStorage: StorageProvider,
    legacyTokenStorage: TokenStorageProvider<TxfStorageDataBase>,
  ): Promise<void> {
    this.log('Step 5: CLEANUP');

    // --- 5a. Collect last known IPFS CID for unpinning ---
    const allKeys = await legacyStorage.keys();
    let lastKnownCid: string | null = null;
    for (const key of allKeys) {
      if (IPFS_CID_KEY_PATTERN.test(key)) {
        const cid = await legacyStorage.get(key);
        if (cid) {
          lastKnownCid = cid;
        }
      }
    }

    // --- 5b. Remove all legacy keys EXCEPT migration tracking ---
    // Note: SphereVestingCacheV5 is a separate IndexedDB database managed by
    // VestingClassifier, not by the StorageProvider. It is unaffected by this
    // cleanup because we only call legacyStorage.remove(), which operates on
    // the StorageProvider's own key-value store.
    for (const key of allKeys) {
      // Preserve migration phase tracking keys
      const stripped = key.startsWith(STORAGE_PREFIX)
        ? key.slice(STORAGE_PREFIX.length)
        : key;
      // Issue #330 — also preserve the legacy-migrated marker so a
      // defensive re-run of migration does not nuke the fallback signal.
      if (
        stripped === MIGRATION_PHASE_KEY ||
        stripped === MIGRATION_STARTED_AT_KEY ||
        stripped === LEGACY_MIGRATED_MARKER_KEY
      ) {
        continue;
      }

      try {
        await legacyStorage.remove(key);
      } catch (err) {
        // Best-effort cleanup -- log and continue
        this.log(
          `Failed to remove legacy key '${key}':`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // --- 5c. Mark legacy token storage as migrated (preserve, don't wipe) ---
    //
    // Issue #330 — pre-fix this step called `legacyTokenStorage.clear()`
    // which dropped the entire legacy token IDB. That made the legacy
    // DB unusable as a fallback when the Profile blockstore loses
    // tokens (the memory-only-blockstore + gateway-eviction race
    // documented in #330). We now keep the bytes and write a marker
    // alongside, so the runtime can wire the legacy DB as a read-only
    // fallback (see `ProfileTokenStorageProvider.setFallbackTokenStorage`
    // and `SphereLoadOptions.fallbackTokenStorage`).
    //
    // The marker is stored on the LEGACY KV store (passed in via the
    // existing `legacyStorage` arg in step 5b's caller chain), not on
    // the legacy token store — token stores don't have a generic kv
    // surface. Callers that need to read the marker do so via the
    // legacy `StorageProvider`. Token data persists; nothing is wiped.
    try {
      await legacyStorage.set(LEGACY_MIGRATED_MARKER_KEY, String(Date.now()));
      this.log('Legacy token storage marked as migrated (preserved as fallback)');
    } catch (err) {
      this.log(
        'Failed to write legacy migrated marker (non-fatal — token data still preserved):',
        err instanceof Error ? err.message : String(err),
      );
    }

    // --- 5d. Attempt to unpin last known IPFS CID (best-effort) ---
    if (lastKnownCid !== null) {
      try {
        await this.unpinCid(lastKnownCid);
        this.log(`Unpinned last known CID: ${lastKnownCid}`);
      } catch (err) {
        this.log(
          `Failed to unpin CID ${lastKnownCid} (non-fatal):`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    this.log('Cleanup completed');
  }

  // ---------------------------------------------------------------------------
  // Private Helpers: IPFS Unpin
  // ---------------------------------------------------------------------------

  /**
   * Attempt to unpin a CID from the IPFS pinning service.
   * This is best-effort -- failures are silently handled by the caller.
   */
  private async unpinCid(cid: string): Promise<void> {
    const url = `${DEFAULT_IPFS_API_URL}/api/v0/pin/rm?arg=${encodeURIComponent(cid)}`;
    const response = await fetch(url, { method: 'POST' });
    if (!response.ok) {
      throw new Error(`IPFS unpin failed: HTTP ${response.status}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Private Helpers: Phase Tracking
  // ---------------------------------------------------------------------------

  /**
   * Persist the current migration phase to legacy storage for crash recovery.
   */
  private async setPhase(
    legacyStorage: StorageProvider,
    phase: MigrationPhase,
  ): Promise<void> {
    this.log(`Phase: ${phase}`);
    await legacyStorage.set(MIGRATION_PHASE_KEY, phase);
  }

  // ---------------------------------------------------------------------------
  // Private Helpers: Logging
  // ---------------------------------------------------------------------------

  private log(message: string, ...args: unknown[]): void {
    logger.debug('ProfileMigration', message, ...args);
  }
}

// =============================================================================
// Module-level Helper Functions
// =============================================================================

/**
 * Type guard for valid migration phases.
 */
function isValidPhase(value: string): value is MigrationPhase {
  return (PHASE_ORDER as readonly string[]).includes(value);
}

/**
 * Map a single legacy key (without `sphere_` prefix) to its Profile key name.
 * Returns null if the key should be excluded (e.g., IPFS state keys).
 */
function mapLegacyKeyToProfileKey(stripped: string): string | null {
  // IPFS state keys are excluded
  if (IPFS_STATE_KEYS_PATTERN.test(stripped)) {
    return null;
  }

  // Dynamic transport keys: last_wallet_event_ts_{hex}, last_dm_event_ts_{hex}
  if (stripped.startsWith('last_wallet_event_ts_')) {
    const suffix = stripped.slice('last_wallet_event_ts_'.length);
    return `transport.lastWalletEventTs.${suffix}`;
  }
  if (stripped.startsWith('last_dm_event_ts_')) {
    const suffix = stripped.slice('last_dm_event_ts_'.length);
    return `transport.lastDmEventTs.${suffix}`;
  }

  // Dynamic swap keys: {addr}_swap:{swapId}
  const swapMatch = /^(.+)_swap:(.+)$/.exec(stripped);
  if (swapMatch) {
    return `${swapMatch[1]}.swap:${swapMatch[2]}`;
  }

  // Per-address keys: {addr}_{keyName}
  // Address IDs look like DIRECT_xxxxxx_yyyyyy (20 chars)
  const addrMatch = /^(DIRECT_[a-z0-9]{6}_[a-z0-9]{6})_(.+)$/.exec(stripped);
  if (addrMatch) {
    const addr = addrMatch[1];
    const keyPart = addrMatch[2];

    const mapping = PROFILE_KEY_MAPPING[keyPart];
    if (mapping && mapping.dynamic) {
      return mapping.profileKey.replace('{addr}', addr);
    }

    // Unknown per-address key -- pass through with dot notation
    return `${addr}.${keyPart}`;
  }

  // Global static mapping
  const globalMapping = PROFILE_KEY_MAPPING[stripped];
  if (globalMapping) {
    return globalMapping.profileKey;
  }

  // Unknown key -- pass through as-is
  return stripped;
}

/**
 * Check if a Profile key maps to a cache-only legacy key.
 */
function isCacheOnlyProfileKey(profileKey: string): boolean {
  for (const [legacyKey, entry] of Object.entries(PROFILE_KEY_MAPPING)) {
    if (entry.profileKey === profileKey && CACHE_ONLY_KEYS.has(legacyKey)) {
      return true;
    }
  }
  return false;
}

/**
 * Extract nametag token IDs from `_nametag` and `_nametags` entries in TXF data.
 *
 * Legacy TXF data stores nametag tokens in two forms:
 * - `_nametag` -- single nametag entry with a `.token` sub-object
 * - `_nametags` -- array of nametag entries, each potentially with a `.token`
 *
 * These token entries are added to the tokenIds set for ingestion into UXF.
 */
function extractNametagTokens(
  txfData: TxfStorageDataBase,
  tokenIds: Set<string>,
): void {
  const data = txfData as unknown as Record<string, unknown>;

  // _nametag -- single nametag token
  const nametagEntry = data['_nametag'];
  if (nametagEntry !== undefined && nametagEntry !== null && typeof nametagEntry === 'object') {
    const nt = nametagEntry as Record<string, unknown>;
    if (nt.token !== undefined && nt.token !== null && typeof nt.token === 'object') {
      tokenIds.add('_nametag');
    }
  }

  // _nametags -- array of nametag entries
  const nametagsEntry = data['_nametags'];
  if (Array.isArray(nametagsEntry)) {
    for (let i = 0; i < nametagsEntry.length; i++) {
      const entry = nametagsEntry[i] as Record<string, unknown> | null | undefined;
      if (entry !== null && entry !== undefined && typeof entry === 'object' && entry.token) {
        tokenIds.add(`_nametags_${i}`);
      }
    }
  }
}

/**
 * Convert legacy `_sent` entries to HistoryRecord entries with type='SENT'.
 */
function convertSentToHistory(sent: readonly TxfSentEntry[]): HistoryRecord[] {
  return sent.map((entry) => ({
    dedupKey: `SENT_${entry.tokenId}_${entry.txHash}`,
    id: entry.txHash,
    type: 'SENT' as const,
    amount: '0', // amount not stored in legacy _sent entries
    coinId: '',
    symbol: '',
    timestamp: entry.sentAt,
    transferId: entry.txHash,
    tokenId: entry.tokenId,
    recipientAddress: entry.recipient,
  }));
}

/**
 * Merge two history arrays, deduplicating by dedupKey, sorted by timestamp descending.
 */
function mergeHistoryEntries(
  existing: readonly HistoryRecord[],
  additional: readonly HistoryRecord[],
): HistoryRecord[] {
  const seen = new Set(existing.map((e) => e.dedupKey));
  const merged = [...existing];

  for (const entry of additional) {
    if (!seen.has(entry.dedupKey)) {
      merged.push(entry);
      seen.add(entry.dedupKey);
    }
  }

  merged.sort((a, b) => b.timestamp - a.timestamp);
  return merged;
}

/**
 * Count the number of distinct addresses in the transformed data.
 * Detected by scanning profile keys for address prefixes (DIRECT_*).
 */
function countAddresses(data: TransformedData): number {
  const addresses = new Set<string>();
  for (const key of data.profileKeys.keys()) {
    const match = /^(DIRECT_[a-z0-9]{6}_[a-z0-9]{6})\./.exec(key);
    if (match) {
      addresses.add(match[1]);
    }
  }
  // At minimum one address is always present (the primary)
  return Math.max(addresses.size, 1);
}

// =============================================================================
// T.1.E: Legacy `invalidTokens` → per-entry-key `invalid` migration
// =============================================================================

/**
 * Result of {@link migrateInvalidTokensToPerEntryKey}.
 */
export interface InvalidTokensMigrationResult {
  /** Whether the migration ran (false when no legacy blob existed). */
  readonly migrated: boolean;
  /** Number of legacy entries migrated to per-entry-key form. */
  readonly entriesMigrated: number;
  /** Number of legacy entries skipped because a per-entry-key was already present. */
  readonly entriesSkippedPreexisting: number;
  /** Number of legacy entries skipped because they were malformed. */
  readonly entriesSkippedMalformed: number;
}

/**
 * Migrate the legacy single-blob `${addr}.invalidTokens` into the
 * per-entry-key `${addr}.invalid.${tokenId}.legacy-${tokenId}` form
 * (T.1.E §6.B; UXF-TRANSFER-IMPL-PLAN.md §6.B).
 *
 * **Synthetic disambiguator**: legacy `TxfInvalidEntry` records carry no
 * `observedTokenContentHash`, so the migration synthesizes one as
 * `legacy-<tokenId>`. This matches the multi-rep schema declared in
 * `PROFILE_KEY_MAPPING` and avoids collisions with real per-entry-key
 * records keyed by a real content hash (which never starts with the
 * literal `legacy-` prefix in the canonical encoding).
 *
 * **Additivity**: the migration NEVER overwrites an existing per-entry-key
 * record at `${addr}.invalid.${tokenId}.${cid}` — if a real entry was
 * written by a later wave (T.3.B onward) before the migration ran, that
 * entry wins. Only the synthetic legacy key is written, and only when
 * absent.
 *
 * **One-way**: after a successful migration, the legacy
 * `${addr}.invalidTokens` blob is deleted. Re-running the migration is a
 * no-op (idempotent — no legacy blob = nothing to do).
 *
 * @param db                 - The OrbitDB-backed profile database.
 * @param addressId          - The address ID prefix (e.g. `DIRECT_aabbcc_ddeeff`).
 * @param encryptionKey      - Optional profile encryption key. When set,
 *                             the legacy blob is decrypted and per-entry
 *                             values are re-encrypted on write.
 * @returns Counts and a `migrated` flag for telemetry.
 */
export async function migrateInvalidTokensToPerEntryKey(
  db: ProfileDatabase,
  addressId: string,
  encryptionKey?: Uint8Array,
): Promise<InvalidTokensMigrationResult> {
  const legacyKey = `${addressId}.invalidTokens`;
  const legacyRaw = await db.get(legacyKey);

  if (legacyRaw === null) {
    // Idempotent no-op — no legacy blob to migrate.
    return {
      migrated: false,
      entriesMigrated: 0,
      entriesSkippedPreexisting: 0,
      entriesSkippedMalformed: 0,
    };
  }

  // Decrypt + parse the legacy blob.
  let legacyEntries: readonly unknown[];
  try {
    const plaintext = encryptionKey
      ? await decryptProfileValue(encryptionKey, legacyRaw)
      : legacyRaw;
    const text = new TextDecoder().decode(plaintext);
    const parsed = JSON.parse(text);
    legacyEntries = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    // A corrupt blob cannot be migrated. Leave it in place; the operator
    // can investigate. Surface a typed error so callers can distinguish
    // this from "no legacy data".
    throw new ProfileError(
      'MIGRATION_FAILED',
      `Failed to decode legacy invalidTokens blob at ${legacyKey}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  let entriesMigrated = 0;
  let entriesSkippedPreexisting = 0;
  let entriesSkippedMalformed = 0;

  for (const raw of legacyEntries) {
    if (raw === null || typeof raw !== 'object') {
      entriesSkippedMalformed++;
      continue;
    }
    const entry = raw as Partial<TxfInvalidEntry>;
    if (typeof entry.tokenId !== 'string' || entry.tokenId.length === 0) {
      entriesSkippedMalformed++;
      continue;
    }

    // Composite per-entry-key id with synthetic observedTokenContentHash.
    const composite = `${entry.tokenId}.legacy-${entry.tokenId}`;
    const newKey = `${addressId}.invalid.${composite}`;

    // ADDITIVITY: skip if a per-entry-key record already exists at this
    // composite key. This protects against a legacy wallet that ran
    // T.3.B (or any future writer producing real composite ids) BEFORE
    // T.1.E migration was applied.
    const existing = await db.get(newKey);
    if (existing !== null) {
      entriesSkippedPreexisting++;
      continue;
    }

    // Encode the entry (preserve the legacy fields verbatim — this is a
    // best-effort migration; the per-entry-key writer treats the stored
    // value as opaque JSON).
    const encoded = new TextEncoder().encode(JSON.stringify(entry));
    const toWrite = encryptionKey
      ? await encryptProfileValue(encryptionKey, encoded)
      : encoded;

    await db.put(newKey, toWrite);
    entriesMigrated++;
  }

  // Delete the legacy blob ONLY after all per-entry writes succeeded.
  // If any of the puts above threw, the legacy blob stays — re-running
  // the migration is safe (additivity protects re-writes).
  await db.del(legacyKey);

  return {
    migrated: true,
    entriesMigrated,
    entriesSkippedPreexisting,
    entriesSkippedMalformed,
  };
}
