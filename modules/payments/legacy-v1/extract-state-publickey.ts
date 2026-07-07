/**
 * Extract the current-state predicate publicKey (hex) from a token's
 * serialized SDK data (the JSON string persisted in TXF storage as
 * `Token.sdkData`).
 *
 * Used by:
 *   - PaymentsModule's spent-state rescan worker (chooses the predicate
 *     pubkey instead of falling back to `chainPubkey` for tokens whose
 *     state is locked to a non-self predicate).
 *   - SwapModule.verifyPayout (issue #535) — derives the predicate
 *     pubkey for the per-payout-token `oracle.isSpent` probe.
 *
 * Returns null when:
 *   - `sdkData` is undefined / empty.
 *   - JSON parse fails.
 *   - `SdkToken.fromJSON` rejects the shape.
 *   - PredicateEngineService cannot build a predicate (unknown engine).
 *   - The built predicate does not carry a `publicKey` field.
 *
 * Callers SHOULD fall back to `chainPubkey` (or another sensible default)
 * on null so the probe still happens — never fail-open on the spent
 * check itself.
 */

import { Token as SdkToken } from 'stsdk-v1/lib/token/Token';
import { PredicateEngineService } from 'stsdk-v1/lib/predicate/PredicateEngineService';
import { bytesToHex } from '../../../core/hex';

export async function extractCurrentStatePublicKeyHexFromSdkData(
  sdkData: string | undefined,
): Promise<string | null> {
  if (!sdkData) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(sdkData);
  } catch {
    return null;
  }
  let sdkTokenInstance;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sdkTokenInstance = await SdkToken.fromJSON(parsed as any);
  } catch {
    return null;
  }
  if (!sdkTokenInstance?.state?.predicate) return null;
  let predicate;
  try {
    predicate = await PredicateEngineService.createPredicate(
      sdkTokenInstance.state.predicate,
    );
  } catch {
    return null;
  }
  const pubkey = (predicate as unknown as { publicKey?: Uint8Array })
    .publicKey;
  if (!(pubkey instanceof Uint8Array) || pubkey.length === 0) return null;
  return bytesToHex(pubkey);
}
