/**
 * Token parse cache — shared module-scope cache of parsed sdkData fields
 * to avoid repeated JSON.parse in hot loops.
 *
 * Extracted from PaymentsModule.ts:718–759 during Phase 5 (uxfv2-refactor-
 * design.md §2.1). Behavior-preserving: same singleton semantics as the
 * pre-split module-scope global.
 *
 * Cleared on address switch via {@link clearSdkDataCache}.
 */

import { getCurrentStateHash } from '../../../serialization/txf-serializer';

// Cache parsed sdkData fields. Key = sdkData string reference,
// value = { tokenId, stateHash }. Cleared on address switch.
const sdkDataCache = new Map<string, { tokenId: string | null; stateHash: string }>();
const SDK_DATA_CACHE_MAX = 2000;

export function parseSdkDataCached(
  sdkData: string,
): { tokenId: string | null; stateHash: string } {
  const cached = sdkDataCache.get(sdkData);
  if (cached) return cached;

  let tokenId: string | null = null;
  let stateHash = '';
  try {
    const txf = JSON.parse(sdkData);
    tokenId = txf.genesis?.data?.tokenId || null;
    stateHash = getCurrentStateHash(txf) || '';

    // Try alternative locations if not found in standard place
    if (!stateHash) {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      if ((txf as any).state?.hash) {
        stateHash = (txf as any).state.hash;
      } else if ((txf as any).stateHash) {
        stateHash = (txf as any).stateHash;
      } else if ((txf as any).currentStateHash) {
        stateHash = (txf as any).currentStateHash;
      }
      /* eslint-enable @typescript-eslint/no-explicit-any */
    }
  } catch {
    // Invalid JSON — return defaults
  }

  const entry = { tokenId, stateHash };
  // Evict cache if it grows too large (unlikely in normal usage)
  if (sdkDataCache.size >= SDK_DATA_CACHE_MAX) {
    sdkDataCache.clear();
  }
  sdkDataCache.set(sdkData, entry);
  return entry;
}

export function clearSdkDataCache(): void {
  sdkDataCache.clear();
}
