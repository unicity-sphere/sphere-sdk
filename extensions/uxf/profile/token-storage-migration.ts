/**
 * Bidirectional Token Storage Migration (Issue #286)
 *
 * Copies a wallet's token inventory between two `TokenStorageProvider`
 * implementations, preserving every TXF-level structural field
 * (`_meta`, tokens, archived tokens, `_tombstones`, `_outbox`, `_sent`,
 * `_invalid`, `_history`, `_audit`, `_finalizationQueue`).
 *
 * Designed to support consumer-driven storage swaps such as the
 * sphere.telco PR #305 regression (an upgrade from
 * `IndexedDBTokenStorageProvider` to `ProfileTokenStorageProvider`
 * silently zeroed every existing wallet's balance because the new
 * Profile store opens fresh, no migration runs). Calling
 * `migrateTokenStorage()` BEFORE swapping the provider passed to
 * `Sphere.init` makes the swap safe — and the same primitive supports
 * a rollback to legacy if the new store is later disabled.
 *
 * ## Semantics
 *
 * - **Bidirectional.** Pass `direction: 'legacy-to-profile'` or
 *   `'profile-to-legacy'`. The function treats the two providers
 *   symmetrically — only the marker keyspace differs.
 * - **Non-destructive.** The source provider is never written to. After
 *   a successful migration the source still holds the original data,
 *   so a future rollback in the OTHER direction reproduces the
 *   original wallet state.
 * - **Idempotent.** A per-direction marker
 *   (`legacy_migration_v1_complete:<addressId>` /
 *   `profile_migration_v1_complete:<addressId>`) is written to the
 *   `markerStorage` after a successful copy. A second invocation in
 *   the same direction with the marker present short-circuits.
 *   Pass `force: true` to bypass the marker (e.g., the user added
 *   tokens to legacy after the first migration and wants to refresh
 *   the joint inventory).
 * - **Crash-safe.** The target's `save()` is a full overwrite, not an
 *   append — a crash mid-flight leaves the target with either the
 *   pre-migration state (write didn't land) or the post-migration
 *   state (write landed). Re-running re-loads the source snapshot
 *   and re-writes the target. The marker is the LAST operation, so
 *   any crash before it triggers a re-run on the next launch.
 * - **Aggregator-spent aware.** When an `oracle` is passed, every
 *   active token's current state hash is probed via `oracle.isSpent()`
 *   before the target write. Tokens reported `spent` are demoted from
 *   the active inventory to the `archived-` slot — they remain in the
 *   user's history but no longer appear in `getAssets()` / spend
 *   selection. This sits BESIDE the runtime `SpentStateRescanWorker`
 *   (auto-installed by PaymentsModule, issue #281); the migration
 *   probe is a one-shot equivalent for the wallet's first post-swap
 *   load so the user doesn't see "phantom" spent balances even before
 *   the worker's first scan cycle.
 * - **OpLog cap safe.** `ProfileTokenStorageProvider.save()` does NOT
 *   inline the TxfStorageDataBase in OpLog — it writes a UXF CAR to
 *   IPFS and stamps a thin bundle CID ref in OrbitDB. So migrating
 *   thousands of tokens is structurally bounded by IPFS payload size,
 *   not the 128 KiB MAX_PAYLOAD_BYTES cap. The marker write itself is
 *   ~200 bytes — well below the cap — and uses the system-class
 *   `'cache_index'` entry type when the marker storage supports
 *   `setEntry`.
 *
 * ## What this primitive does NOT migrate
 *
 * - Key-value storage entries (mnemonic, derivation path, group-chat,
 *   pending V5 tokens, accounting state, proof-polling jobs). Those
 *   live in the `StorageProvider` layer, which is a separate
 *   abstraction (both Profile and legacy providers expose KV
 *   compatible interfaces, so they survive a Profile swap on their
 *   own without help from this primitive).
 *
 * Forked-token entries (`_forked_*`) ARE migrated as-is — they carry
 * alternate state-history for a tokenId and live in their own
 * keyspace slot (no collision with the active `_<tokenId>` key).
 * The count is exposed via `forksMigrated` for operator visibility.
 *
 * ## Comparison with `importLegacyTokens`
 *
 * `importLegacyTokens` (the existing legacy → Profile helper) operates
 * at the `PaymentsModule.importTokens` level. It re-builds the
 * in-memory token map plus the local derived cache (history,
 * tombstones, etc.) on a LIVE PaymentsModule. It is the right
 * primitive when the caller has a live `Sphere` instance and wants
 * to merge legacy tokens into the active wallet view.
 *
 * `migrateTokenStorage` operates at the `TokenStorageProvider` level.
 * It is the right primitive when the caller is preparing storage
 * BEFORE constructing `Sphere`, or rolling back from one storage
 * shape to another. Both helpers can coexist: a typical sphere.telco
 * `SphereProvider.initialize` calls `migrateTokenStorage()` to seed
 * the Profile-backed target, then constructs Sphere with the Profile
 * providers — and a subsequent in-app "merge legacy file" UI gesture
 * calls `importLegacyTokens` to additively union an external TXF
 * file.
 *
 * @example sphere.telco SphereProvider.initialize integration
 * ```ts
 * import { createBrowserProfileProviders } from '@unicitylabs/sphere-sdk/profile/browser';
 * import { createBrowserProviders } from '@unicitylabs/sphere-sdk/impl/browser';
 * import { migrateLegacyToProfile } from '@unicitylabs/sphere-sdk/profile';
 *
 * // Build legacy + Profile providers side-by-side
 * const legacy = createBrowserProviders({ network: 'mainnet' });
 * const profile = createBrowserProfileProviders({ network: 'mainnet' });
 *
 * // Initialize both with the same identity (so the addressId matches)
 * legacy.tokenStorage.setIdentity(identity);
 * profile.tokenStorage.setIdentity(identity);
 * await legacy.tokenStorage.initialize();
 * await profile.tokenStorage.initialize();
 *
 * // Migrate legacy → Profile, with aggregator-spent gating
 * const result = await migrateLegacyToProfile({
 *   legacy: legacy.tokenStorage,
 *   profile: profile.tokenStorage,
 *   identity,
 *   oracle: providers.oracle,
 *   markerStorage: profile.storage,
 * });
 * if (!result.success) {
 *   console.error('migration failed', result.errors);
 * }
 *
 * // Now construct Sphere with Profile providers — tokens visible
 * const { sphere } = await Sphere.init({
 *   ...profile,
 *   transport: providers.transport,
 *   oracle: providers.oracle,
 * });
 * ```
 *
 * @module profile/token-storage-migration
 */

import { logger } from '../../../core/logger.js';
import { getAddressId, STORAGE_PREFIX } from '../../../constants.js';
import type {
  TokenStorageProvider,
  TxfStorageDataBase,
  StorageProvider,
} from '../../../storage/storage-provider.js';
import type { OracleProvider } from '../../../oracle/oracle-provider.js';
import type { FullIdentity } from '../../../types';
import { isTokenKey, isArchivedKey, isForkedKey, archivedKeyFromTokenId } from '../../../types/txf.js';
import type { TxfToken } from '../../../types/txf.js';
// Issue #292 — Sphere-bound overload of `migrateLegacyToProfile`. Type-only
// imports keep the dependency direction profile→core (matches browser.ts /
// node.ts factory imports); the runtime `attachIdentityToProfileProviders`
// lives in `./attach-identity` to avoid pulling Sphere itself into the
// runtime graph of this file.
import type { Sphere } from '../../../core/Sphere';
import type { NetworkType } from '../../../constants';
import type { ProfileConfig } from './types';

// =============================================================================
// Public types
// =============================================================================

/** Migration direction. */
export type MigrationDirection = 'legacy-to-profile' | 'profile-to-legacy';

/** Per-phase progress callback payload. */
export interface TokenStorageMigrationProgress {
  /** Address being migrated. */
  readonly addressId: string;
  /** Direction of the migration. */
  readonly direction: MigrationDirection;
  /** Phase name. */
  readonly phase:
    | 'check-marker'
    | 'source-load'
    | 'oracle-probe'
    | 'target-save'
    | 'await-flush'
    | 'stamp-marker'
    | 'complete';
  /** Tokens processed so far in the current phase. */
  readonly processed: number;
  /** Total tokens expected in the current phase. */
  readonly total: number;
}

/** Options for {@link migrateTokenStorage}. */
export interface TokenStorageMigrationOptions {
  /** Source provider — read-only. */
  readonly source: TokenStorageProvider<TxfStorageDataBase>;
  /** Target provider — receives a single `save()` call. */
  readonly target: TokenStorageProvider<TxfStorageDataBase>;
  /** Direction (drives marker keyspace only). */
  readonly direction: MigrationDirection;
  /**
   * Wallet identity. Both providers MUST already accept this identity
   * (call `setIdentity` + `initialize` BEFORE invoking the migration).
   * The function uses `identity.directAddress` to compute the marker
   * keyspace and to call `oracle.isSpent(identity.chainPubkey, ...)`.
   */
  readonly identity: FullIdentity;
  /**
   * Optional aggregator. When provided, every active token's current
   * state hash is probed. Tokens reported `spent` are demoted to the
   * `archived-` slot in the target. Tokens whose probe THROWS are
   * left in the active slot (defensive — same fail-closed semantics
   * as the runtime worker).
   */
  readonly oracle?: OracleProvider;
  /**
   * Where to store the idempotency marker. Typical choice: the
   * `StorageProvider` of the TARGET environment (Profile's
   * `ProfileStorageProvider` for legacy→Profile; the legacy
   * `IndexedDBStorageProvider` / `FileStorageProvider` for the
   * reverse direction). When omitted, the marker phase is skipped
   * entirely — every call re-runs the copy. Pass `null` explicitly
   * for the same effect.
   */
  readonly markerStorage?: StorageProvider | null;
  /**
   * Optional per-phase progress callback.
   */
  readonly onProgress?: (p: TokenStorageMigrationProgress) => void;
  /**
   * Enumerate without writing. The target is NOT modified; the
   * marker is NOT stamped. Useful for a CLI `--dry-run` flag.
   */
  readonly dryRun?: boolean;
  /**
   * Bypass the idempotency marker. The migration runs even if the
   * marker is already set. The marker IS rewritten on success so
   * subsequent calls observe the latest timestamp.
   */
  readonly force?: boolean;
}

/** Per-bucket counts captured by the migration. */
export interface TokenStorageMigrationCounts {
  /** Active token entries (`_<tokenId>` keys, NOT including archived). */
  readonly tokensMigrated: number;
  /** Archived token entries (`archived-<tokenId>` keys). */
  readonly archivedMigrated: number;
  /** Tombstones (entries in `_tombstones`). */
  readonly tombstonesMigrated: number;
  /** OUTBOX entries (entries in `_outbox`). */
  readonly outboxMigrated: number;
  /** SENT entries (entries in `_sent`). */
  readonly sentMigrated: number;
  /** History entries (entries in `_history`). */
  readonly historyMigrated: number;
  /** Audit entries (entries in `_audit`). */
  readonly auditMigrated: number;
  /** Finalization queue entries (entries in `_finalizationQueue`). */
  readonly finalizationQueueMigrated: number;
  /** Invalid entries (entries in `_invalid`). */
  readonly invalidMigrated: number;
  /**
   * Forked-token entries (`_forked_<tokenId>_<stateHash>`) copied
   * as-is. Forks are alternate state-history for a tokenId; they
   * live in their own keyspace slot and never collide with the
   * active `_<tokenId>` key, so a literal byte-copy is safe and
   * preserves the wallet's audit trail. Exposed separately from
   * `tokensMigrated` for operator visibility.
   */
  readonly forksMigrated: number;
  /**
   * Active tokens demoted to `archived-` due to `oracle.isSpent === true`.
   * Always 0 when `oracle` is omitted. Counted independently from
   * `archivedMigrated` (those were already archived in source).
   */
  readonly spentTokensArchived: number;
  /**
   * Oracle probes that threw (network / RPC error). The token is left
   * in its source bucket and is NOT demoted. The wallet's runtime
   * `SpentStateRescanWorker` will re-probe after the wallet boots.
   */
  readonly oracleProbeErrors: number;
}

/** Result of a single {@link migrateTokenStorage} invocation. */
export interface TokenStorageMigrationResult extends TokenStorageMigrationCounts {
  /** True when the migration ran without fatal errors. */
  readonly success: boolean;
  /** Computed addressId for the migrated identity. */
  readonly addressId: string;
  /** Direction passed to {@link migrateTokenStorage}. */
  readonly direction: MigrationDirection;
  /**
   * True when the marker was set and `force` was false — the function
   * returned early without touching the target. All counts are 0.
   */
  readonly skippedDueToMarker: boolean;
  /** True when `dryRun` was set — counts are real but no writes happened. */
  readonly dryRun: boolean;
  /** Wall-clock duration. */
  readonly durationMs: number;
  /** Fatal-and-non-fatal failures collected during the run. */
  readonly errors: ReadonlyArray<{
    readonly phase: TokenStorageMigrationProgress['phase'];
    readonly error: string;
  }>;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Schema version of the migration marker payload. Bump when the
 * marker JSON shape changes in a way that older readers can't parse.
 */
export const TOKEN_STORAGE_MIGRATION_MARKER_VERSION = 1 as const;

const MARKER_KEY_PREFIX_LEGACY_TO_PROFILE = 'legacy_migration_v1_complete';
const MARKER_KEY_PREFIX_PROFILE_TO_LEGACY = 'profile_migration_v1_complete';

/**
 * Reserved keys that never carry a token payload. These are the
 * structural / operational slots on `TxfStorageDataBase` (kept in sync
 * with `RESERVED_KEYS` in `types/txf.ts` plus the post-merge T.0.G7
 * fields).
 */
const RESERVED_KEYS = new Set<string>([
  '_meta',
  '_tombstones',
  '_outbox',
  '_sent',
  '_invalid',
  '_history',
  '_integrity',
  '_audit',
  '_finalizationQueue',
  '_nametag',
  '_nametags',
  '_invalidatedNametags',
  '_mintOutbox',
]);

// =============================================================================
// Public API
// =============================================================================

/**
 * Migrate a wallet's TXF token inventory from `source` to `target`,
 * preserving every structural field of `TxfStorageDataBase`.
 *
 * See the module docstring for the full contract — idempotency,
 * crash-safety, aggregator-spent gating, OpLog cap safety, and what
 * is intentionally NOT migrated.
 *
 * @param opts See {@link TokenStorageMigrationOptions}.
 * @returns See {@link TokenStorageMigrationResult}.
 */
export async function migrateTokenStorage(
  opts: TokenStorageMigrationOptions,
): Promise<TokenStorageMigrationResult> {
  const startTime = Date.now();
  const errors: Array<{ phase: TokenStorageMigrationProgress['phase']; error: string }> = [];

  if (!opts.identity.directAddress) {
    return failureResult({
      addressId: '',
      direction: opts.direction,
      errors: [{ phase: 'check-marker', error: 'identity.directAddress is required' }],
      dryRun: !!opts.dryRun,
      durationMs: Date.now() - startTime,
    });
  }

  const addressId = getAddressId(opts.identity.directAddress);
  const markerKey = markerKeyFor(opts.direction, addressId);

  // ── Phase 1: idempotency marker check ──────────────────────────────────
  emitProgress(opts.onProgress, addressId, opts.direction, 'check-marker', 0, 0);

  if (!opts.force && opts.markerStorage) {
    try {
      const existing = await opts.markerStorage.get(markerKey);
      if (existing && isHonoredMarkerPayload(existing)) {
        logger.debug(
          'TokenStorageMigration',
          `marker present (${markerKey}); skipping (use force:true to override)`,
        );
        return {
          success: true,
          addressId,
          direction: opts.direction,
          skippedDueToMarker: true,
          dryRun: !!opts.dryRun,
          tokensMigrated: 0,
          archivedMigrated: 0,
          tombstonesMigrated: 0,
          outboxMigrated: 0,
          sentMigrated: 0,
          historyMigrated: 0,
          auditMigrated: 0,
          finalizationQueueMigrated: 0,
          invalidMigrated: 0,
          forksMigrated: 0,
          spentTokensArchived: 0,
          oracleProbeErrors: 0,
          durationMs: Date.now() - startTime,
          errors: [],
        };
      }
    } catch (err) {
      // Marker read failure is non-fatal — proceed with the migration.
      // The marker write at the end may also fail, in which case the
      // next run repeats the migration (idempotent at the data layer).
      errors.push({
        phase: 'check-marker',
        error: `marker read failed: ${errMsg(err)} (proceeding)`,
      });
    }
  }

  // ── Phase 2: load source snapshot ──────────────────────────────────────
  emitProgress(opts.onProgress, addressId, opts.direction, 'source-load', 0, 0);

  let sourceData: TxfStorageDataBase;
  try {
    const loaded = await opts.source.load();
    if (!loaded.success || !loaded.data) {
      return failureResult({
        addressId,
        direction: opts.direction,
        errors: [
          ...errors,
          {
            phase: 'source-load',
            error: loaded.error ?? 'source.load() returned no data',
          },
        ],
        dryRun: !!opts.dryRun,
        durationMs: Date.now() - startTime,
      });
    }
    sourceData = loaded.data;
  } catch (err) {
    return failureResult({
      addressId,
      direction: opts.direction,
      errors: [...errors, { phase: 'source-load', error: errMsg(err) }],
      dryRun: !!opts.dryRun,
      durationMs: Date.now() - startTime,
    });
  }

  // ── Phase 3: bucket inventory + optional oracle-spent probe ────────────
  const buckets = classifyBuckets(sourceData);
  emitProgress(
    opts.onProgress,
    addressId,
    opts.direction,
    'oracle-probe',
    0,
    buckets.activeTokens.length,
  );

  let spentTokensArchived = 0;
  let oracleProbeErrors = 0;
  // Build the target snapshot by starting from the source and applying
  // post-probe migrations. We mutate a NEW object so the original
  // `sourceData` reference is never mutated (some providers cache the
  // loaded snapshot and rely on identity-stability).
  const targetData: TxfStorageDataBase = shallowCopyStorageData(sourceData);

  if (opts.oracle) {
    const pubkey = opts.identity.chainPubkey;
    if (!pubkey) {
      errors.push({
        phase: 'oracle-probe',
        error: 'oracle provided but identity.chainPubkey is missing — skipping probe',
      });
    } else {
      // Concurrency-capped probes — at scale (1500+ tokens) a sequential
      // loop would block the migration for minutes. The cap matches the
      // SpentStateRescanWorker's default (MAX_CONCURRENT_SPENT_RESCANS=4)
      // so we don't out-load the runtime worker. The oracle is expected
      // to internally rate-limit / dedupe (UnicityAggregatorProvider
      // caches isSpent results with a TTL), so concurrent calls are
      // benign.
      const ORACLE_PROBE_CONCURRENCY = 4;
      const candidates = buckets.activeTokens
        .map((entry) => ({
          ...entry,
          stateHash: extractCurrentStateHashFromTxf(entry.txf),
        }))
        .filter((c) => c.stateHash.length > 0);

      for (let i = 0; i < candidates.length; i += ORACLE_PROBE_CONCURRENCY) {
        const batch = candidates.slice(i, i + ORACLE_PROBE_CONCURRENCY);
        const outcomes = await Promise.all(
          batch.map(async (c) => {
            try {
              const spent = await opts.oracle!.isSpent(pubkey, c.stateHash);
              return { ok: true as const, key: c.key, txf: c.txf, spent };
            } catch (err) {
              return { ok: false as const, key: c.key, err };
            }
          }),
        );
        for (const outcome of outcomes) {
          if (!outcome.ok) {
            oracleProbeErrors += 1;
            logger.debug(
              'TokenStorageMigration',
              `oracle.isSpent threw for ${outcome.key}: ${errMsg(outcome.err)} (leaving in active slot)`,
            );
            continue;
          }
          if (outcome.spent) {
            // Demote active → archived. Preserves the token payload in
            // the inventory so getHistory() / archived views still see
            // it; only spend selection / getAssets() will skip it.
            const tokenId = outcome.key.startsWith('_') ? outcome.key.slice(1) : outcome.key;
            const archivedKey = archivedKeyFromTokenId(tokenId);
            const slot = targetData as unknown as Record<string, unknown>;
            // Steelman fix (collision-safe): if the wallet ALREADY has
            // an archived entry for this tokenId (legitimate after a
            // reissue cycle), do NOT overwrite — the existing archived
            // payload is its own historical record. Leave the active
            // slot untouched in that case so the next load surfaces
            // the apparent conflict (the disposition engine will
            // resolve it via the standard archived/active rules).
            if (slot[archivedKey] !== undefined) {
              logger.debug(
                'TokenStorageMigration',
                `oracle reported ${outcome.key} spent, but target already has ${archivedKey} — leaving in active slot to avoid clobbering existing archived payload`,
              );
              continue;
            }
            slot[archivedKey] = outcome.txf;
            delete slot[outcome.key];
            spentTokensArchived += 1;
          }
        }
      }
    }
  }

  // Refresh / synthesize the `_meta` slot. The Profile and legacy
  // providers always populate `_meta` on load(), so the source path
  // typically already provides it. We defensively synthesize the
  // four required TxfMeta fields here so a buggy source (or an
  // imported file with a partial `_meta`) doesn't propagate
  // malformed metadata to the target. The `updatedAt` is always
  // refreshed to the migration time so operators can distinguish
  // the post-migration meta from the source's pre-migration meta.
  const sourceMeta = targetData._meta ?? ({} as Partial<TxfStorageDataBase['_meta']>);
  targetData._meta = {
    version: sourceMeta.version ?? 1,
    address: sourceMeta.address ?? (opts.identity.chainPubkey ?? ''),
    formatVersion: sourceMeta.formatVersion ?? '2.0',
    ipnsName: sourceMeta.ipnsName,
    updatedAt: Date.now(),
  };

  // ── Phase 4: dry-run early exit ────────────────────────────────────────
  const finalBuckets = classifyBuckets(targetData);
  const counts: TokenStorageMigrationCounts = {
    tokensMigrated: finalBuckets.activeTokens.length,
    archivedMigrated: finalBuckets.archivedTokens.length,
    tombstonesMigrated: targetData._tombstones?.length ?? 0,
    outboxMigrated: targetData._outbox?.length ?? 0,
    sentMigrated: targetData._sent?.length ?? 0,
    historyMigrated: targetData._history?.length ?? 0,
    auditMigrated: targetData._audit?.length ?? 0,
    finalizationQueueMigrated: targetData._finalizationQueue?.length ?? 0,
    invalidMigrated: targetData._invalid?.length ?? 0,
    forksMigrated: buckets.forksMigrated,
    spentTokensArchived,
    oracleProbeErrors,
  };

  if (opts.dryRun) {
    emitProgress(opts.onProgress, addressId, opts.direction, 'complete', 0, 0);
    return {
      success: true,
      addressId,
      direction: opts.direction,
      skippedDueToMarker: false,
      dryRun: true,
      ...counts,
      durationMs: Date.now() - startTime,
      errors,
    };
  }

  // ── Phase 5: write target ──────────────────────────────────────────────
  emitProgress(
    opts.onProgress,
    addressId,
    opts.direction,
    'target-save',
    counts.tokensMigrated,
    counts.tokensMigrated,
  );

  try {
    const saved = await opts.target.save(targetData);
    if (!saved.success) {
      return failureResult({
        addressId,
        direction: opts.direction,
        errors: [
          ...errors,
          { phase: 'target-save', error: saved.error ?? 'target.save() returned !success' },
        ],
        dryRun: false,
        durationMs: Date.now() - startTime,
        // Preserve the counts we computed pre-save so callers can see
        // what would have been migrated.
        counts,
      });
    }
  } catch (err) {
    return failureResult({
      addressId,
      direction: opts.direction,
      errors: [...errors, { phase: 'target-save', error: errMsg(err) }],
      dryRun: false,
      durationMs: Date.now() - startTime,
      counts,
    });
  }

  // ── Phase 6: drain any debounced flush so the marker stamp lands
  //            ONLY after the target write is durable. Without this
  //            a Profile-backed target may return from save() with the
  //            data still queued in the flush scheduler — and a marker
  //            stamped early would let a crash leave us with a marker
  //            but no data on the target.
  emitProgress(opts.onProgress, addressId, opts.direction, 'await-flush', 0, 0);

  if (typeof opts.target.awaitNextFlush === 'function') {
    try {
      // Bulk import: the post-save flush has to pin one CAR block per
      // sub-element across every migrated token, and that scales linearly
      // with wallet size. The hot-path 30s default is correct for
      // incoming-transfer ack latency; it is the wrong shape for a
      // one-shot operation whose duration grows with input. Pass 0 to
      // disable the wall-clock deadline (the 4-iteration runaway guard
      // inside awaitNextFlush still trips on a genuine save→flush feedback
      // loop). Callers that need a cap (e.g., a CLI with its own
      // user-cancellable progress UI) can wrap the migration in their own
      // AbortSignal / setTimeout, or set the target's flushScheduler
      // budgets at provider construction.
      await opts.target.awaitNextFlush(0);
    } catch (err) {
      // A flush failure means the data is NOT durable. Do NOT stamp
      // the marker — return a failure so the next run retries.
      return failureResult({
        addressId,
        direction: opts.direction,
        errors: [
          ...errors,
          { phase: 'await-flush', error: `awaitNextFlush failed: ${errMsg(err)}` },
        ],
        dryRun: false,
        durationMs: Date.now() - startTime,
        counts,
      });
    }
  }

  // ── Phase 7: stamp marker ──────────────────────────────────────────────
  emitProgress(opts.onProgress, addressId, opts.direction, 'stamp-marker', 0, 0);

  if (opts.markerStorage) {
    const markerPayload = JSON.stringify({
      v: TOKEN_STORAGE_MIGRATION_MARKER_VERSION,
      direction: opts.direction,
      addressId,
      completedAt: Date.now(),
      counts,
    });
    try {
      // System-class entry type — the marker is operator-bookkeeping
      // not a user action. Falls through to plain set() when the
      // provider doesn't implement setEntry (file / legacy IndexedDB).
      const markerStorageWithSetEntry = opts.markerStorage as StorageProvider & {
        setEntry?: (key: string, value: string, entryType: string) => Promise<void>;
      };
      if (typeof markerStorageWithSetEntry.setEntry === 'function') {
        await markerStorageWithSetEntry.setEntry(markerKey, markerPayload, 'cache_index');
      } else {
        await opts.markerStorage.set(markerKey, markerPayload);
      }
    } catch (err) {
      // Non-fatal: the data IS durable on the target. The next
      // invocation will re-run the migration (a wasted pass but
      // idempotent — target.save is a full overwrite).
      errors.push({
        phase: 'stamp-marker',
        error: `marker write failed: ${errMsg(err)} (data is durable on target)`,
      });
    }
  }

  emitProgress(opts.onProgress, addressId, opts.direction, 'complete', 0, 0);

  return {
    success: true,
    addressId,
    direction: opts.direction,
    skippedDueToMarker: false,
    dryRun: false,
    ...counts,
    durationMs: Date.now() - startTime,
    errors,
  };
}

/**
 * Options shape for the existing legacy→Profile convenience wrapper. Kept
 * as a named type so the discriminated overload below can reference it.
 *
 * Consumers passing this shape supply their own `FullIdentity` — typically
 * because they derived identity outside the SDK (rare) or because they're
 * exercising the lower-level path. Callers with a live `Sphere` instance
 * SHOULD prefer the {@link MigrateLegacyToProfileFromSphereOptions} variant
 * to avoid synthesizing a `FullIdentity` (which can crash inside
 * `Profile*.setIdentity` if `privateKey === ''`; see Issue #292).
 */
export interface MigrateLegacyToProfileOptions {
  readonly legacy: TokenStorageProvider<TxfStorageDataBase>;
  readonly profile: TokenStorageProvider<TxfStorageDataBase>;
  readonly identity: FullIdentity;
  readonly oracle?: OracleProvider;
  readonly markerStorage?: StorageProvider | null;
  readonly onProgress?: (p: TokenStorageMigrationProgress) => void;
  readonly dryRun?: boolean;
  readonly force?: boolean;
}

/**
 * Sphere-bound variant (Issue #292). Consumers pass a live `Sphere` instance
 * plus the legacy provider; the helper:
 *
 *   1. Calls the platform-appropriate
 *      `create{Browser,Node}ProfileProvidersFromSphere` factory to build
 *      Profile providers WITH identity already attached (private key never
 *      crosses the SDK boundary).
 *   2. Runs the same `migrateTokenStorage` flow.
 *   3. Returns the constructed Profile providers as part of the result so
 *      the consumer can immediately hand them to `Sphere.init` /
 *      `Sphere.load` / store them in app state.
 *
 * The `factory` field is INJECTED rather than imported here to keep this
 * file platform-agnostic. The browser/node entry points wire their own
 * factory; consumers typically call this through one of the platform
 * helpers, but the raw entry point lets unit tests stub the factory.
 *
 * @see https://github.com/unicity-sphere/sphere-sdk/issues/292
 */
export interface MigrateLegacyToProfileFromSphereOptions {
  /** Live Sphere instance — used as the identity authority. */
  readonly sphere: Sphere;
  /**
   * Legacy token storage provider (already set up with identity +
   * initialized) — the migration SOURCE.
   */
  readonly legacy: TokenStorageProvider<TxfStorageDataBase>;
  /**
   * Factory callback that builds the Profile providers with identity
   * pre-attached. Typically one of:
   *
   *   - `createBrowserProfileProvidersFromSphere` (from
   *     `@unicitylabs/sphere-sdk/profile/browser`)
   *   - `createNodeProfileProvidersFromSphere` (from
   *     `@unicitylabs/sphere-sdk/profile/node`)
   *
   * Injected (rather than imported here) so `token-storage-migration.ts`
   * stays platform-agnostic and the IndexedDB / file-system tree is only
   * pulled into the bundle the consumer is actually building.
   */
  readonly profileFactory: (
    sphere: Sphere,
    config: {
      readonly network: NetworkType;
      readonly profileConfig?: Partial<ProfileConfig>;
      readonly oracle?: OracleProvider;
    },
  ) => Promise<{
    readonly storage: StorageProvider;
    readonly tokenStorage: TokenStorageProvider<TxfStorageDataBase>;
  }>;
  /** Network preset — forwarded to `profileFactory`. */
  readonly network: NetworkType;
  /** Profile-specific configuration overrides — forwarded to `profileFactory`. */
  readonly profileConfig?: Partial<ProfileConfig>;
  /** Oracle — forwarded to BOTH the factory AND the migration's spent-probe. */
  readonly oracle?: OracleProvider;
  /**
   * Override marker storage. When omitted, the Profile factory's storage
   * is used (matches the recommended idiom for legacy→Profile migrations).
   */
  readonly markerStorage?: StorageProvider | null;
  readonly onProgress?: (p: TokenStorageMigrationProgress) => void;
  readonly dryRun?: boolean;
  readonly force?: boolean;
}

/**
 * Result of the Sphere-bound `migrateLegacyToProfile` overload. Extends
 * the base {@link TokenStorageMigrationResult} with the constructed
 * Profile providers so consumers can immediately swap them in (no
 * separate factory call required).
 */
export interface MigrateLegacyToProfileFromSphereResult
  extends TokenStorageMigrationResult {
  /** The Profile providers constructed by `profileFactory`. */
  readonly profileProviders: {
    readonly storage: StorageProvider;
    readonly tokenStorage: TokenStorageProvider<TxfStorageDataBase>;
  };
}

/**
 * Convenience wrapper for the common case: migrating from a legacy
 * `IndexedDBTokenStorageProvider` / `FileTokenStorageProvider` to a
 * Profile-backed `ProfileTokenStorageProvider`.
 *
 * Two overloads:
 *
 *   1. **Original** `{ legacy, profile, identity, ... }` — caller supplies
 *      a `FullIdentity` directly. Unchanged from #286.
 *   2. **Sphere-bound (Issue #292)** `{ sphere, legacy, profileFactory,
 *      network, ... }` — caller supplies a live Sphere; the helper builds
 *      the Profile providers with identity attached internally (private
 *      key never crosses the SDK boundary) and returns them alongside
 *      the migration result.
 *
 * The overloads are discriminated by the presence of `sphere`. Backward
 * compatibility: every existing call site supplying `{ legacy, profile,
 * identity }` continues to work without source changes.
 */
export async function migrateLegacyToProfile(
  opts: MigrateLegacyToProfileOptions,
): Promise<TokenStorageMigrationResult>;
export async function migrateLegacyToProfile(
  opts: MigrateLegacyToProfileFromSphereOptions,
): Promise<MigrateLegacyToProfileFromSphereResult>;
export async function migrateLegacyToProfile(
  opts: MigrateLegacyToProfileOptions | MigrateLegacyToProfileFromSphereOptions,
): Promise<TokenStorageMigrationResult | MigrateLegacyToProfileFromSphereResult> {
  // Discriminate via the TRUTHY presence of `sphere` — the original
  // overload never carries a `sphere` field at all. Checking
  // `'sphere' in opts` alone would mis-fire on `{ sphere: undefined }`
  // (the key is present, the value is undefined), routing to the
  // Sphere path and crashing on missing `profileFactory`. The
  // truthy guard handles that boundary case cleanly.
  if (isSphereBoundOptions(opts)) {
    return migrateLegacyToProfileFromSphereImpl(opts);
  }
  return migrateTokenStorage({
    source: opts.legacy,
    target: opts.profile,
    direction: 'legacy-to-profile',
    identity: opts.identity,
    oracle: opts.oracle,
    markerStorage: opts.markerStorage,
    onProgress: opts.onProgress,
    dryRun: opts.dryRun,
    force: opts.force,
  });
}

/**
 * Type predicate for the Sphere-bound overload. Returns true when `sphere`
 * is present AND truthy (rules out `{ sphere: undefined }` keys and
 * `null`). The original `MigrateLegacyToProfileOptions` shape never
 * carries a `sphere` field at all.
 *
 * @internal
 */
function isSphereBoundOptions(
  opts: MigrateLegacyToProfileOptions | MigrateLegacyToProfileFromSphereOptions,
): opts is MigrateLegacyToProfileFromSphereOptions {
  return (
    'sphere' in opts &&
    (opts as MigrateLegacyToProfileFromSphereOptions).sphere !== undefined &&
    (opts as MigrateLegacyToProfileFromSphereOptions).sphere !== null
  );
}

/**
 * Internal — implementation of the Sphere-bound overload. Extracted so the
 * overload signatures stay readable and unit tests can target it
 * directly with a stub `profileFactory`.
 *
 * The Sphere's `FullIdentity` is reached via the platform-specific
 * factory's internal call to `Sphere._withFullIdentityForProfileFactory`.
 * This file never receives the private key — only the factory closure
 * does, and even there it stays inside the SDK.
 */
async function migrateLegacyToProfileFromSphereImpl(
  opts: MigrateLegacyToProfileFromSphereOptions,
): Promise<MigrateLegacyToProfileFromSphereResult> {
  // The factory returns providers with identity already bound. The Sphere
  // accessor inside it will throw `SphereError('NOT_INITIALIZED')` when the
  // Sphere instance has no identity — surface that to the caller verbatim.
  const profileProviders = await opts.profileFactory(opts.sphere, {
    network: opts.network,
    profileConfig: opts.profileConfig,
    oracle: opts.oracle,
  });

  // Sphere's identity getter is public-info-only, so we can read it to
  // pass to the migration body. The privateKey field is stamped as `''`
  // here on purpose — `migrateTokenStorage` does NOT call
  // `Profile*.setIdentity` (that already happened inside the factory);
  // it only uses `identity.directAddress` (for the addressId-keyed
  // marker) and `identity.chainPubkey` (for the oracle probe). The empty
  // privateKey is never touched.
  const identityForMigration = identityForMigrationFromSphere(opts.sphere);

  const markerStorage =
    opts.markerStorage === undefined ? profileProviders.storage : opts.markerStorage;

  const result = await migrateTokenStorage({
    source: opts.legacy,
    target: profileProviders.tokenStorage,
    direction: 'legacy-to-profile',
    identity: identityForMigration,
    oracle: opts.oracle,
    markerStorage,
    onProgress: opts.onProgress,
    dryRun: opts.dryRun,
    force: opts.force,
  });

  return { ...result, profileProviders };
}

/**
 * Reads the PUBLIC identity from a Sphere and synthesizes a `FullIdentity`
 * with an empty `privateKey` for the migration body. The migration body
 * never calls `setIdentity` on the providers (the factory already did
 * that via `_withFullIdentityForProfileFactory`) — it only consults
 * `directAddress` (marker keyspace) and `chainPubkey` (oracle probe). The
 * empty `privateKey` is provably never dereferenced on this code path; if
 * a future change adds a `setIdentity` call inside `migrateTokenStorage`
 * the existing unit test
 * `migrateLegacyToProfile_emptyPrivateKey_throwsClearError` will catch it.
 *
 * @internal
 */
function identityForMigrationFromSphere(sphere: Sphere): FullIdentity {
  const publicIdentity = sphere.identity;
  if (!publicIdentity) {
    // Mirror SphereError shape without coupling to it — keeps this file's
    // dependency graph narrow (and matches the surrounding fail-fast
    // returns earlier in this module).
    throw new Error(
      'migrateLegacyToProfile({ sphere }): Sphere has no identity — call Sphere.init/create/load first',
    );
  }
  return {
    chainPubkey: publicIdentity.chainPubkey,
    directAddress: publicIdentity.directAddress,
    ipnsName: publicIdentity.ipnsName,
    nametag: publicIdentity.nametag,
    // INTENTIONAL: privateKey stays inside Sphere. The migration body
    // does not invoke any code path that reads this field; see the
    // identityForMigrationFromSphere docstring.
    privateKey: '',
  };
}

/**
 * Convenience wrapper for the rollback direction:
 * `ProfileTokenStorageProvider` → legacy
 * `IndexedDBTokenStorageProvider` / `FileTokenStorageProvider`.
 *
 * Equivalent to `migrateTokenStorage({ source: profile, target: legacy,
 * direction: 'profile-to-legacy', ... })`.
 */
export async function migrateProfileToLegacy(opts: {
  readonly profile: TokenStorageProvider<TxfStorageDataBase>;
  readonly legacy: TokenStorageProvider<TxfStorageDataBase>;
  readonly identity: FullIdentity;
  readonly oracle?: OracleProvider;
  readonly markerStorage?: StorageProvider | null;
  readonly onProgress?: (p: TokenStorageMigrationProgress) => void;
  readonly dryRun?: boolean;
  readonly force?: boolean;
}): Promise<TokenStorageMigrationResult> {
  return migrateTokenStorage({
    source: opts.profile,
    target: opts.legacy,
    direction: 'profile-to-legacy',
    identity: opts.identity,
    oracle: opts.oracle,
    markerStorage: opts.markerStorage,
    onProgress: opts.onProgress,
    dryRun: opts.dryRun,
    force: opts.force,
  });
}

/**
 * Check whether a migration marker is present for `(direction,
 * addressId)`. Useful for UIs that want to surface "wallet already
 * migrated" without running the full helper.
 */
export async function isTokenStorageMigrationComplete(opts: {
  readonly markerStorage: StorageProvider;
  readonly direction: MigrationDirection;
  readonly identity: FullIdentity;
}): Promise<boolean> {
  if (!opts.identity.directAddress) return false;
  const addressId = getAddressId(opts.identity.directAddress);
  const key = markerKeyFor(opts.direction, addressId);
  const value = await opts.markerStorage.get(key);
  return value !== null && value !== '';
}

/**
 * Clear a previously-stamped migration marker. Use this when the
 * consumer wants to force-rerun the migration on the next invocation
 * (e.g., the user added more tokens to legacy after the first
 * migration).
 *
 * Note: clearing the marker does NOT delete the migrated data on the
 * target. The next migration run will re-write the target with the
 * latest source snapshot.
 */
export async function clearTokenStorageMigrationMarker(opts: {
  readonly markerStorage: StorageProvider;
  readonly direction: MigrationDirection;
  readonly identity: FullIdentity;
}): Promise<void> {
  if (!opts.identity.directAddress) return;
  const addressId = getAddressId(opts.identity.directAddress);
  const key = markerKeyFor(opts.direction, addressId);
  await opts.markerStorage.remove(key);
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Build the marker key for a (direction, addressId) pair. The
 * keyspace deliberately overlaps with `STORAGE_KEYS_GLOBAL` shape
 * (`sphere_` prefix added by the provider) — addressId is appended
 * with `:` so the marker is per-address even when wallets manage
 * multiple HD addresses.
 */
/**
 * Decide whether a stored marker value should be HONORED as
 * "migration complete." Honored markers short-circuit the migration;
 * non-honored markers cause the helper to re-run.
 *
 * The honored set is:
 *   - any value missing the `v` field (legacy / pre-versioned marker
 *     — treated as v=1 for backward compat)
 *   - any value whose `v` is ≤ {@link TOKEN_STORAGE_MIGRATION_MARKER_VERSION}
 *
 * Markers from a FUTURE schema version are NOT honored — a v:2
 * marker from a newer SDK may describe data the older v:1 reader
 * cannot represent, so the safer behavior is to re-run the
 * migration (which is data-idempotent) than to assume forward-
 * compat. Steelman finding 2 (PR #289 review).
 */
function isHonoredMarkerPayload(raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Pre-versioned plain-string marker (or corruption). Treat as
    // honored — preserves backward-compat for any consumer who
    // wrote a non-JSON marker through an older API surface.
    return true;
  }
  if (parsed === null || typeof parsed !== 'object') {
    // Same backward-compat reasoning.
    return true;
  }
  const obj = parsed as { v?: unknown };
  if (obj.v === undefined) {
    // Pre-versioned JSON marker — honored.
    return true;
  }
  if (typeof obj.v !== 'number' || !Number.isFinite(obj.v) || obj.v < 0) {
    // Malformed `v` field — re-run is the safe choice.
    return false;
  }
  return obj.v <= TOKEN_STORAGE_MIGRATION_MARKER_VERSION;
}

function markerKeyFor(direction: MigrationDirection, addressId: string): string {
  const prefix =
    direction === 'legacy-to-profile'
      ? MARKER_KEY_PREFIX_LEGACY_TO_PROFILE
      : MARKER_KEY_PREFIX_PROFILE_TO_LEGACY;
  // The StorageProvider implementations internally strip / add the
  // `sphere_` prefix as needed. We pass the bare key so it works
  // uniformly across IndexedDB / file / Profile providers.
  void STORAGE_PREFIX; // documented dependency — no transformation needed here
  return `${prefix}:${addressId}`;
}

interface TxfBuckets {
  /** Active token entries (`_<tokenId>` keys, excluding reserved). */
  activeTokens: Array<{ key: string; txf: TxfToken }>;
  /** Archived token entries (`archived-<tokenId>` keys). */
  archivedTokens: Array<{ key: string; txf: TxfToken }>;
  /** Number of `_forked_*` keys observed (copied as-is to target). */
  forksMigrated: number;
}

/**
 * Walk a TxfStorageDataBase and bucket its keys. Reserved operational
 * keys are recognized via {@link RESERVED_KEYS}; everything else is
 * classified via the txf key helpers.
 */
function classifyBuckets(data: TxfStorageDataBase): TxfBuckets {
  const activeTokens: Array<{ key: string; txf: TxfToken }> = [];
  const archivedTokens: Array<{ key: string; txf: TxfToken }> = [];
  let forksMigrated = 0;

  for (const [key, value] of Object.entries(data)) {
    if (RESERVED_KEYS.has(key)) continue;
    if (isForkedKey(key)) {
      // Forks are copied as-is by save() (whole-snapshot overwrite).
      // We surface the count for operator visibility.
      if (value && typeof value === 'object') forksMigrated += 1;
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    const txf = value as TxfToken;
    if (isArchivedKey(key)) {
      archivedTokens.push({ key, txf });
    } else if (isTokenKey(key)) {
      activeTokens.push({ key, txf });
    }
  }

  return { activeTokens, archivedTokens, forksMigrated };
}

/**
 * Build a new TxfStorageDataBase whose top-level keys reference the
 * same value objects as `data`. We do NOT deep-clone — the migration
 * is treated as a read-only consumer of the source values, and the
 * target.save() implementations are expected to serialize/copy on
 * write.
 */
function shallowCopyStorageData(data: TxfStorageDataBase): TxfStorageDataBase {
  const out: TxfStorageDataBase = {
    _meta: { ...data._meta },
  };
  for (const [key, value] of Object.entries(data)) {
    if (key === '_meta') continue;
    (out as unknown as Record<string, unknown>)[key] = value;
  }
  return out;
}

/**
 * Extract the current state hash from a TxfToken by reading the last
 * non-null inclusion proof's authenticator. Returns the empty string
 * when the token has no committed state transitions (a pending mint
 * — no state hash to probe).
 */
function extractCurrentStateHashFromTxf(txf: TxfToken): string {
  if (!txf) return '';
  // Walk transactions backwards — the latest committed transition is
  // the one whose inclusionProof is non-null. Pending (uncommitted)
  // transitions carry `inclusionProof: null` and have no committed
  // state hash.
  if (Array.isArray(txf.transactions) && txf.transactions.length > 0) {
    for (let i = txf.transactions.length - 1; i >= 0; i -= 1) {
      const tx = txf.transactions[i];
      if (tx?.inclusionProof?.authenticator?.stateHash) {
        return tx.inclusionProof.authenticator.stateHash;
      }
    }
  }
  // No committed transition — use the genesis inclusion proof's
  // state hash (the mint commitment binds the genesis state).
  if (txf.genesis?.inclusionProof?.authenticator?.stateHash) {
    return txf.genesis.inclusionProof.authenticator.stateHash;
  }
  return '';
}

function emitProgress(
  cb: ((p: TokenStorageMigrationProgress) => void) | undefined,
  addressId: string,
  direction: MigrationDirection,
  phase: TokenStorageMigrationProgress['phase'],
  processed: number,
  total: number,
): void {
  if (!cb) return;
  try {
    cb({ addressId, direction, phase, processed, total });
  } catch (err) {
    // Never let a user-supplied progress callback abort the migration.
    logger.debug(
      'TokenStorageMigration',
      `onProgress threw (ignored): ${errMsg(err)}`,
    );
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface FailureResultArgs {
  readonly addressId: string;
  readonly direction: MigrationDirection;
  readonly errors: ReadonlyArray<{ phase: TokenStorageMigrationProgress['phase']; error: string }>;
  readonly dryRun: boolean;
  readonly durationMs: number;
  readonly counts?: TokenStorageMigrationCounts;
}

function failureResult(args: FailureResultArgs): TokenStorageMigrationResult {
  const c = args.counts;
  return {
    success: false,
    addressId: args.addressId,
    direction: args.direction,
    skippedDueToMarker: false,
    dryRun: args.dryRun,
    tokensMigrated: c?.tokensMigrated ?? 0,
    archivedMigrated: c?.archivedMigrated ?? 0,
    tombstonesMigrated: c?.tombstonesMigrated ?? 0,
    outboxMigrated: c?.outboxMigrated ?? 0,
    sentMigrated: c?.sentMigrated ?? 0,
    historyMigrated: c?.historyMigrated ?? 0,
    auditMigrated: c?.auditMigrated ?? 0,
    finalizationQueueMigrated: c?.finalizationQueueMigrated ?? 0,
    invalidMigrated: c?.invalidMigrated ?? 0,
    forksMigrated: c?.forksMigrated ?? 0,
    spentTokensArchived: c?.spentTokensArchived ?? 0,
    oracleProbeErrors: c?.oracleProbeErrors ?? 0,
    durationMs: args.durationMs,
    errors: args.errors,
  };
}
