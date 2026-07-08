/**
 * Token import — bulk-load TXF wire-format tokens into a wallet.
 *
 * Extracted from PaymentsModule.ts:8449–8657 during Phase 5 (uxfv2-refactor-
 * design.md §2.1 and uxfv2-phase-5-payments-disposition.md). Behavior-
 * preserving: same taxonomy, same pre-check order, same guard rails as the
 * pre-split facade method. The extracted function accepts an
 * {@link ImportHost} shim so it stays decoupled from
 * `PaymentsModule` internals — the facade wires `this.tokens`,
 * `this.isStateTombstoned`, `this.addToken` into the host.
 */

import type { Token, TokenStatus } from '../../../types';
import { txfToToken } from '../../../serialization/txf-serializer';

/**
 * Wave 6-P2-18: the v1 `TxfToken` alias in `types/txf` is deleted. The
 * TXF wire format still speaks the state-transition-sdk v1 JSON shape
 * (it is the format two SDKs on the same network exchange), so the
 * import path retains a local minimal interface for the fields it
 * actually reads.
 */
interface WireTxfToken {
  genesis?: {
    data?: {
      tokenId?: string;
    };
  };
  state?: unknown;
  transactions?: unknown[];
}
import { logger } from '../../../core/logger';
import {
  effectiveDedupKey,
  extractStateHashFromSdkData,
  extractTokenIdFromSdkData,
} from '../tokens';
import type {
  ImportAdded,
  ImportRejected,
  ImportSkipped,
  ImportTokensResult,
} from './types';

/**
 * Minimal capability surface required by {@link importTokensInto}. The
 * facade `PaymentsModule` provides these directly — `tokens` is its
 * in-memory `Map<string, Token>`, `isStateTombstoned` and `addToken`
 * are its methods bound to the instance.
 */
export interface ImportHost {
  readonly tokens: ReadonlyMap<string, Token>;
  isStateTombstoned(genesisTokenId: string, stateHash: string): boolean;
  addToken(token: Token): Promise<boolean>;
}

export interface ImportTokensOptions {
  skipExistingGenesis?: boolean;
}

/**
 * Import tokens from TXF wire-format objects.
 *
 * Each token receives a fresh local UUID. Dedup is performed in-line
 * (not just via addToken) so that the per-token outcome includes a
 * specific reason code instead of an opaque "skipped" flag. See the
 * facade docstring at PaymentsModule.importTokens for the full
 * per-code semantics and strict-mode behaviour.
 */
export async function importTokensInto(
  host: ImportHost,
  txfTokens: readonly WireTxfToken[],
  options?: ImportTokensOptions,
): Promise<ImportTokensResult> {
  const added: ImportAdded[] = [];
  const skipped: ImportSkipped[] = [];
  const rejected: ImportRejected[] = [];

  for (const txf of txfTokens) {
    const genesisTokenId = txf?.genesis?.data?.tokenId ?? null;
    if (!genesisTokenId) {
      rejected.push({
        genesisTokenId: null,
        code: 'malformed',
        reason: 'Missing genesis.data.tokenId',
      });
      continue;
    }
    if (!txf.state || !txf.genesis) {
      rejected.push({
        genesisTokenId,
        code: 'malformed',
        reason: 'Missing state or genesis section',
      });
      continue;
    }

    // Effective dedup key combines current-state hash (for
    // finalized tokens) and a genesis-content hash (for pending-
    // mint tokens). See `effectiveDedupKey`.
    const incomingDedupKey = effectiveDedupKey(txf as Parameters<typeof effectiveDedupKey>[0]);

    // Real stateHash for the tombstone check — via the canonical
    // `parseSdkDataCached` path. Tombstones are only keyed on
    // concrete post-spend hashes, so pending tokens can never
    // match one (by definition their first state transition
    // hasn't happened yet).
    const incomingStateHash = extractStateHashFromSdkData(
      JSON.stringify(txf),
    );

    // -- Pre-check 1: tombstoned (previously spent).
    if (incomingStateHash && host.isStateTombstoned(genesisTokenId, incomingStateHash)) {
      skipped.push({
        genesisTokenId,
        code: 'tombstoned',
        reason: `(tokenId, stateHash) previously spent from this wallet`,
      });
      continue;
    }

    // Scan in-memory wallet for matching genesis / state. Track
    // the matched token's status so we can distinguish a true
    // "state replaced a live state" from "stale bookkeeping record
    // (spent/invalid) was overwritten" downstream.
    //
    // For the dedup-key comparison we reuse `parseSdkDataCached`
    // via extractStateHashFromSdkData rather than re-parsing each
    // existing token's sdkData in the loop (was O(N×M) JSON.parse
    // on large wallets). For pending existing tokens with empty
    // stateHash, we fall through to the one-off JSON.parse — rare
    // path.
    let exactDuplicateLocalId: string | null = null;
    let genesisMatchLocalId: string | null = null;
    let genesisMatchStatus: TokenStatus | null = null;
    let genesisMatchIsPending = false;
    for (const [existingId, existing] of host.tokens) {
      const existingTokenId = extractTokenIdFromSdkData(existing.sdkData);
      if (existingTokenId !== genesisTokenId) continue;

      const existingStateHash = extractStateHashFromSdkData(existing.sdkData);
      let existingDedupKey: string;
      let existingIsPending = false;
      if (existingStateHash) {
        // Fast path: both via the cached parser — no re-parse.
        existingDedupKey = existingStateHash;
      } else if (existing.sdkData) {
        // Pending existing (empty stateHash). Compute the fallback
        // the same way we did for the incoming token.
        try {
          const existingTxf = JSON.parse(existing.sdkData) as Parameters<typeof effectiveDedupKey>[0];
          existingDedupKey = effectiveDedupKey(existingTxf);
          existingIsPending = true;
        } catch {
          // Malformed sdkData — treat as genesis-only match with
          // no identifiable current state.
          genesisMatchLocalId = existingId;
          genesisMatchStatus = existing.status;
          continue;
        }
      } else {
        genesisMatchLocalId = existingId;
        genesisMatchStatus = existing.status;
        continue;
      }

      if (existingDedupKey === incomingDedupKey) {
        exactDuplicateLocalId = existingId;
        break;
      }
      genesisMatchLocalId = existingId;
      genesisMatchStatus = existing.status;
      genesisMatchIsPending = existingIsPending;
    }

    // -- Pre-check 2: exact duplicate.
    if (exactDuplicateLocalId) {
      skipped.push({
        genesisTokenId,
        code: 'duplicate',
        reason: 'Exact (tokenId, stateHash) already owned',
      });
      continue;
    }

    // -- Pre-check 3: strict-mode genesis collision.
    // Exception: if the wallet's existing copy is a pending-mint
    // (empty current stateHash) and the incoming is finalized
    // (has a real stateHash), allow the upgrade — the incoming
    // carries strictly more information than what we already have,
    // and refusing would leave the wallet stuck on the pending
    // record. This is the common "migrated legacy while mint was
    // in flight, now rerun after finalization" pattern.
    if (options?.skipExistingGenesis && genesisMatchLocalId) {
      const incomingIsPending = incomingDedupKey.startsWith('pending-');
      const upgradingPendingToFinalized = genesisMatchIsPending && !incomingIsPending;
      if (!upgradingPendingToFinalized) {
        skipped.push({
          genesisTokenId,
          code: 'genesis-exists',
          reason: 'Genesis tokenId owned at a different state; strict mode preserves current state',
        });
        continue;
      }
      // Fall through — the incoming finalized state will replace
      // the prior pending record via addToken's state-update path.
    }

    // Build the UI token. Failures here are malformed-input
    // rejections, not skips.
    const localId = crypto.randomUUID();
    let uiToken: Token;
    try {
      uiToken = txfToToken(localId, txf);
    } catch (err) {
      rejected.push({
        genesisTokenId,
        code: 'malformed',
        reason: `txfToToken failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    // Hand off to addToken. Pre-checks above mean addToken should
    // not return false here — but defend against it just in case.
    try {
      const addedOk = await host.addToken(uiToken);
      if (addedOk) {
        if (genesisMatchLocalId) {
          // Differentiate:
          //   - Replacing a LIVE state (confirmed/submitted/...):
          //     the user previously held this state of the token;
          //     UI should highlight the overwrite.
          //   - Replacing a DEAD record (spent/invalid): the prior
          //     entry was bookkeeping for a token we no longer
          //     controlled; no user-visible state was lost.
          const isStaleRecord =
            genesisMatchStatus === 'spent' || genesisMatchStatus === 'invalid';
          added.push({
            localId,
            genesisTokenId,
            code: isStaleRecord ? 'stale-record-replaced' : 'state-replaced',
            note: isStaleRecord
              ? 'Overwrote a stale spent/invalid record of the same tokenId'
              : 'Replaced an existing state of the same tokenId (lenient mode)',
          });
        } else {
          added.push({ localId, genesisTokenId, code: 'added' });
        }
      } else {
        // Defensive — addToken returned false despite our pre-checks.
        // This indicates a race (the wallet mutated between our
        // pre-check scan and addToken's own guard) or a guard
        // pattern we didn't enumerate. Log at warn level so field
        // operators can correlate it with transport activity.
        logger.warn(
          'Payments',
          `importTokens: addToken unexpectedly refused token ${genesisTokenId.slice(0, 16)}... ` +
            `after pre-checks (possible race with incoming transfer). Marking as skipped/unknown.`,
        );
        skipped.push({
          genesisTokenId,
          code: 'unknown',
          reason: 'addToken returned false after pre-checks (race or unrecognised guard)',
        });
      }
    } catch (err) {
      rejected.push({
        genesisTokenId,
        code: 'add-failed',
        reason: `addToken failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { added, skipped, rejected };
}
