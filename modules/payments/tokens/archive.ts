/**
 * Archived / forked token helpers.
 *
 * Extracted from PaymentsModule.ts:997–1017 during Phase 5 (uxfv2-refactor-
 * design.md §2.1). Behavior-preserving pure function; the stateful
 * archived/forked stores remain on the facade for now — Phase 5 later
 * step promotes them into a full TokenArchive class.
 */

import type { TxfToken } from '../../../types/txf';
import { countCommittedTxns } from './identity';

/**
 * Find best token version from archives — the archived or forked entry
 * with the most committed transactions.
 *
 * Archived token is looked up directly; forked entries are scanned by
 * tokenId prefix (fork keys have the form `${tokenId}_${forkTag}`).
 */
export function findBestTokenVersion(
  tokenId: string,
  archivedTokens: Map<string, TxfToken>,
  forkedTokens: Map<string, TxfToken>,
): TxfToken | null {
  const candidates: TxfToken[] = [];

  const archived = archivedTokens.get(tokenId);
  if (archived) candidates.push(archived);

  for (const [key, forked] of forkedTokens) {
    if (key.startsWith(tokenId + '_')) {
      candidates.push(forked);
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => countCommittedTxns(b) - countCommittedTxns(a));
  return candidates[0];
}
