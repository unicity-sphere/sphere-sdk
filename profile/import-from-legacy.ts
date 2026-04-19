/**
 * Legacy → Profile Import (the user-driven migration model).
 *
 * Migration is **explicit, non-destructive, and idempotent**. It is
 * conceptually identical to "import a TXF wallet file" — the source
 * happens to be a live legacy `TokenStorageProvider` instead of a file.
 *
 * Semantics (per user direction):
 *
 *   - Always invoked explicitly. Never auto-runs on init.
 *   - Legacy storage is **never deleted** unless the caller explicitly
 *     requests it (`deleteLegacyOnSuccess: true`).
 *   - May be re-run any number of times. Each run produces the JOINT
 *     inventory of legacy + Profile, with `addToken`'s tombstone +
 *     `(tokenId, stateHash)` dedup gating duplicates and previously
 *     spent tokens.
 *   - Token statuses, manifest derivation, and the local derived
 *     cache (tombstones / sent / history) are recomputed automatically
 *     via the normal Profile load path on next read.
 *
 * What it is NOT:
 *
 *   - Not a phased state machine (the previous `ProfileMigration` did
 *     that, but its destructive cleanup is no longer the model).
 *   - Not identity-coupled. Identity verification is the caller's
 *     responsibility — typically done at the CLI layer by comparing
 *     mnemonics or chainPubkeys before invoking this helper.
 *
 * @module profile/import-from-legacy
 */

import { logger } from '../core/logger.js';
import type {
  TokenStorageProvider,
  TxfStorageDataBase,
} from '../storage/storage-provider.js';
import type { TxfToken } from '../types/txf.js';
import type { PaymentsModule } from '../modules/payments/PaymentsModule.js';
import {
  isTokenKey,
  isArchivedKey,
  isForkedKey,
} from '../types/txf.js';

// =============================================================================
// Types
// =============================================================================

export interface LegacyImportOptions {
  /**
   * If true, only enumerate what would be imported — no writes. Useful
   * for the CLI's `--dry-run` flag. Default false.
   */
  readonly dryRun?: boolean;
}

export interface LegacyImportResult {
  readonly success: boolean;
  /** Total TxfTokens extracted from legacy storage (active + archived + forked). */
  readonly tokensFound: number;
  /** Tokens newly added to the target Profile. */
  readonly tokensAdded: number;
  /** Tokens skipped (already owned, tombstoned, or superseded). */
  readonly tokensSkipped: number;
  /** Tokens rejected (malformed input). */
  readonly tokensRejected: number;
  /** Per-token rejection reasons (truncated to 100 entries). */
  readonly rejections: ReadonlyArray<{
    readonly genesisTokenId: string | null;
    readonly reason: string;
  }>;
  /** Wall-clock duration of the import. */
  readonly durationMs: number;
  /** Set when the helper exited early due to an error. */
  readonly error?: string;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Import every TXF token from a legacy `TokenStorageProvider` into a
 * target Profile-backed `PaymentsModule`. Read-only against the source
 * — the legacy storage is untouched.
 *
 * The caller MUST ensure source and target represent the same wallet
 * identity (same mnemonic / chainPubkey). This helper does not verify
 * that — importing tokens whose predicates target a different wallet
 * would simply land them in the inventory as unspendable, which is
 * undesirable but not unsafe.
 *
 * Re-running the helper after a previous successful import is a no-op
 * for already-present tokens, modulo any tokens that were added to
 * legacy storage in the meantime.
 *
 * @param legacyTokenStorage  Source — any `TokenStorageProvider<TxfStorageDataBase>`
 * @param targetPayments      Target — a Profile-backed `PaymentsModule`
 * @param options             {@link LegacyImportOptions}
 */
export async function importLegacyTokens(
  legacyTokenStorage: TokenStorageProvider<TxfStorageDataBase>,
  targetPayments: PaymentsModule,
  options: LegacyImportOptions = {},
): Promise<LegacyImportResult> {
  const startTime = Date.now();

  // 1. Read the legacy TXF storage. This is a snapshot — no further
  //    interaction with the legacy provider after this.
  const loaded = await legacyTokenStorage.load();
  if (!loaded.success || !loaded.data) {
    return emptyResult({
      durationMs: Date.now() - startTime,
      error: loaded.error ?? 'legacy load() failed (no data)',
    });
  }

  // 2. Extract TxfToken values from the storage data. We collect from
  //    every token-like key:
  //      - active tokens (`_<tokenId>`)
  //      - archived tokens (`archived-<tokenId>`)
  //      - forked tokens (`_forked_<tokenId>_<stateHash>`)
  //    Operational keys (_meta, _tombstones, _outbox, etc.) are skipped.
  const txfTokens = extractTxfTokensFromStorageData(loaded.data);

  if (options.dryRun) {
    return {
      success: true,
      tokensFound: txfTokens.length,
      tokensAdded: 0,
      tokensSkipped: 0,
      tokensRejected: 0,
      rejections: [],
      durationMs: Date.now() - startTime,
    };
  }

  // 3. Hand off to PaymentsModule.importTokens — same code path as
  //    the file-based `tokens-import` CLI, with identical dedup +
  //    tombstone semantics. Re-running yields the joint inventory.
  if (txfTokens.length === 0) {
    return {
      success: true,
      tokensFound: 0,
      tokensAdded: 0,
      tokensSkipped: 0,
      tokensRejected: 0,
      rejections: [],
      durationMs: Date.now() - startTime,
    };
  }

  let importResult;
  try {
    importResult = await targetPayments.importTokens(txfTokens);
  } catch (err) {
    return emptyResult({
      durationMs: Date.now() - startTime,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    success: true,
    tokensFound: txfTokens.length,
    tokensAdded: importResult.added.length,
    tokensSkipped: importResult.skipped.length,
    tokensRejected: importResult.rejected.length,
    rejections: importResult.rejected.slice(0, 100),
    durationMs: Date.now() - startTime,
  };
}

// =============================================================================
// Internal helpers
// =============================================================================

function extractTxfTokensFromStorageData(data: TxfStorageDataBase): TxfToken[] {
  const out: TxfToken[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (!value || typeof value !== 'object') continue;
    if (!(isTokenKey(key) || isArchivedKey(key) || isForkedKey(key))) continue;
    const candidate = value as Partial<TxfToken>;
    if (candidate.genesis && candidate.state) {
      out.push(value as TxfToken);
    }
  }
  return out;
}

function emptyResult(extra: Partial<LegacyImportResult> & { durationMs: number }): LegacyImportResult {
  return {
    success: false,
    tokensFound: 0,
    tokensAdded: 0,
    tokensSkipped: 0,
    tokensRejected: 0,
    rejections: [],
    ...extra,
  };
}

// Suppress unused-import warning in builds that don't use the logger.
void logger;
