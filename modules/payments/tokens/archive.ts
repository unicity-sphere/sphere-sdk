/**
 * Archived / forked token helpers.
 *
 * Extracted from PaymentsModule.ts:997–1017 during Phase 5 (uxfv2-refactor-
 * design.md §2.1). Behavior-preserving pure function; the stateful
 * archived/forked stores remain on the facade for now — Phase 5 later
 * step promotes them into a full TokenArchive class.
 */

import { countCommittedTxns } from './identity';

/**
 * Wave 6-P2-18: the `TxfToken` type alias is deleted. Archived and forked
 * entries are shaped by the underlying state-transition-sdk v1 JSON
 * (still v1 until the STSDK v2 swap lands); we hold them as `unknown` at
 * the archive-store boundary and let `countCommittedTxns` narrow.
 */
type ArchivedTokenValue = unknown;

/**
 * Find best token version from archives — the archived or forked entry
 * with the most committed transactions.
 *
 * Archived token is looked up directly; forked entries are scanned by
 * tokenId prefix (fork keys have the form `${tokenId}_${forkTag}`).
 */
export function findBestTokenVersion(
  tokenId: string,
  archivedTokens: Map<string, ArchivedTokenValue>,
  forkedTokens: Map<string, ArchivedTokenValue>,
): ArchivedTokenValue | null {
  const candidates: ArchivedTokenValue[] = [];

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
