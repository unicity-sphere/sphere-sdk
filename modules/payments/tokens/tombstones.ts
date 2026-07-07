/**
 * Tombstone helpers — pure functions for tombstone creation, aging, pruning.
 *
 * Extracted from PaymentsModule.ts:902–992 during Phase 5 (uxfv2-refactor-
 * design.md §2.1). Behavior-preserving pure functions.
 */

import type { Token } from '../../../types';
import type { TombstoneEntry } from '../../../types/txf';
import {
  extractTokenIdFromSdkData,
  extractStateHashFromSdkData,
} from './identity';

/**
 * Create tombstone from token — requires valid tokenId and stateHash.
 */
export function createTombstoneFromToken(token: Token): TombstoneEntry | null {
  const tokenId = extractTokenIdFromSdkData(token.sdkData);
  const stateHash = extractStateHashFromSdkData(token.sdkData);

  // Both tokenId and stateHash are required for a valid tombstone
  if (!tokenId || !stateHash) {
    return null;
  }

  return {
    tokenId,
    stateHash,
    timestamp: Date.now(),
  };
}

/**
 * Prune tombstones by age and count.
 * Default: drop entries older than 30 days, cap at 100 kept.
 */
export function pruneTombstonesByAge(
  tombstones: TombstoneEntry[],
  maxAge: number = 30 * 24 * 60 * 60 * 1000,
  maxCount: number = 100,
): TombstoneEntry[] {
  const now = Date.now();
  let result = tombstones.filter((t) => now - t.timestamp < maxAge);

  if (result.length > maxCount) {
    result = [...result].sort((a, b) => b.timestamp - a.timestamp);
    result = result.slice(0, maxCount);
  }

  return result;
}

/**
 * Prune a Map by count — keep only the most recent `maxCount` entries.
 */
export function pruneMapByCount<T>(items: Map<string, T>, maxCount: number): Map<string, T> {
  if (items.size <= maxCount) {
    return new Map(items);
  }

  const entries = [...items.entries()];
  const toKeep = entries.slice(entries.length - maxCount);
  return new Map(toKeep);
}
