/**
 * Intra-profile schema migrations.
 *
 * Wave 6-P2-19 (`@vrogojin/uxf-v2`) — the legacy v1 → v2 wallet-import
 * migration path is DELETED per the strict "No v1 backward compatibility!"
 * directive. This file previously carried:
 *
 *   * `ProfileMigration` — the 6-step destructive legacy-KV → Profile
 *     migration flow (SYNC / TRANSFORM / PERSIST / SANITY / CLEANUP /
 *     DONE), including the `LEGACY_MIGRATED_MARKER` marker that flagged
 *     the legacy IDB as post-migration read-only fallback. Deleted.
 *   * Helpers `mapLegacyKeyToProfileKey`, `extractNametagTokens`,
 *     `convertSentToHistory`, `mergeHistoryEntries`, `countAddresses`,
 *     `isCacheOnlyProfileKey`, `isValidPhase`. Deleted with the class.
 *
 * What survives here is a single, unrelated intra-profile schema
 * migration: the T.1.E `_invalidTokens` single-blob → per-entry-key
 * (`${addr}.invalid.${tokenId}.${cid}`) conversion. It has no
 * dependency on v1 wallet layout and lives on for wallets rolling
 * forward inside the Profile substrate itself.
 *
 * @module profile/migration
 */

import type { TxfInvalidEntry } from '../../../storage/storage-provider.js';
import type { ProfileDatabase } from './types.js';
import { ProfileError } from './errors.js';
import {
  encryptProfileValue,
  decryptProfileValue,
} from './encryption.js';

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
