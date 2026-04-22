/**
 * Pending-version marker — crash-safety guard (T-B2, SPEC §7.1.2–§7.1.6).
 *
 * The marker stores `(v, cidHash)` durably BEFORE any downstream derivation
 * runs.  On next publish attempt, the marker is read and:
 *   - cidHash matches → idempotent retry (H13): same v, re-derive deterministic payload
 *   - cidHash differs → rollback-safe bump: advance v to currentLocal+1
 *   - version jump > MARKER_MAX_JUMP → MARKER_CORRUPT (C1 clamp)
 *
 * SPEC §7.1.4 integrity check: cidHash MUST be exactly 32 bytes.
 *
 * SPEC §7.1.6 marker-clear atomicity: persist localVersion first, clear marker
 * second.  A crash between them leaves a stale marker at the already-completed
 * v, which §7.1.4 compacts correctly on next publish.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes as nobleHexToBytes } from '@noble/hashes/utils.js';
import { AggregatorPointerError, AggregatorPointerErrorCode } from './errors.js';
import { MARKER_MAX_JUMP, VERSION_MIN, VERSION_MAX } from './constants.js';
import type { FlagStore } from './flag-store.js';
import type { PendingVersionMarker, PointerVersion } from './types.js';

// Storage key suffix (scoped by FlagStore prefix).
const MARKER_KEY = 'pending_version';

interface MarkerRecord {
  v: number;
  cidHash: string; // hex-encoded 32 bytes
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Compute the 32-byte cidHash for a CID byte array.
 * cidHash = SHA-256(cidBytes) per SPEC §7.1.2.
 */
export function computeCidHash(cidBytes: Uint8Array): Uint8Array {
  return sha256(cidBytes);
}

/**
 * Read the pending-version marker from durable storage.
 * Returns null if no marker is present.
 *
 * @throws AggregatorPointerError(MARKER_CORRUPT) if the stored JSON is
 *   malformed, cidHash is not 64 hex chars (32 bytes), or version is invalid.
 */
export async function readMarker(store: FlagStore): Promise<PendingVersionMarker | null> {
  const raw = await store.get(MARKER_KEY);
  if (raw === null) return null;

  let rec: unknown;
  try {
    rec = JSON.parse(raw);
  } catch {
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.MARKER_CORRUPT,
      `pending_version marker contains invalid JSON (SPEC §7.1.5).`,
      { raw },
    );
  }

  const r = rec as Partial<MarkerRecord>;
  if (
    typeof r.v !== 'number' ||
    !Number.isInteger(r.v) ||
    r.v < VERSION_MIN ||
    r.v > VERSION_MAX ||
    typeof r.cidHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(r.cidHash)
  ) {
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.MARKER_CORRUPT,
      `pending_version marker failed integrity check: cidHash must be 64 hex chars, v must be in [${VERSION_MIN}, ${VERSION_MAX}] (SPEC §7.1.5).`,
      { record: rec },
    );
  }

  return {
    v: r.v as PointerVersion,
    cidHash: nobleHexToBytes(r.cidHash),
  };
}

/**
 * Write the pending-version marker durably.
 *
 * MUST be called before any downstream derivation for version `v`.
 * The FlagStore guarantees durability (fsync / transaction.oncomplete).
 *
 * @throws RangeError if cidBytes is not exactly 32 bytes.
 */
export async function writeMarker(
  store: FlagStore,
  v: PointerVersion,
  cidBytes: Uint8Array,
): Promise<void> {
  if (cidBytes.length !== 32) {
    throw new RangeError(`writeMarker: cidBytes must be exactly 32 bytes; got ${cidBytes.length}`);
  }
  const rec: MarkerRecord = {
    v,
    cidHash: bytesToHex(computeCidHash(cidBytes)),
  };
  await store.set(MARKER_KEY, JSON.stringify(rec));
}

/**
 * Clear the pending-version marker after a successful publish.
 *
 * Per §7.1.6: call this AFTER persisting localVersion.
 */
export async function clearMarker(store: FlagStore): Promise<void> {
  await store.remove(MARKER_KEY);
}

export interface MarkerResolution {
  /** Resolved version to publish at. */
  v: PointerVersion;
  /** True → idempotent retry (same v, same cidHash — re-derive deterministic payload). */
  isIdempotentRetry: boolean;
  /** True → marker was stale (already-completed v); was cleared automatically. */
  wasCompacted: boolean;
}

/**
 * Resolve the publish version given the current marker, currentLocalVersion,
 * and the CID of the bundle being published.
 *
 * Implements SPEC §7.1.4 + H13 logic:
 *
 *   Case 1 (H13 idempotent retry): marker.v === currentLocalVersion+1
 *     AND cidHash matches newCidBytes → re-use marker.v, isIdempotentRetry = true
 *
 *   Case 2 (marker stale / already completed): marker.v <= currentLocalVersion
 *     → compact (clear) and treat as "no marker"
 *
 *   Case 3 (MARKER_MAX_JUMP exceeded): marker.v - currentLocalVersion > MARKER_MAX_JUMP
 *     → throw MARKER_CORRUPT
 *
 *   Case 4 (OTP-safe bump): cidHash mismatch on marker.v → advance PAST marker.v
 *     when marker.v == currentLocalVersion+1 (may have emitted ciphertext at that v);
 *     advance to currentLocalVersion+1 otherwise (fresh v, safe)
 *
 *   Case 5 (no marker): v = currentLocalVersion + 1
 */
export async function resolvePublishVersion(
  store: FlagStore,
  currentLocalVersion: PointerVersion,
  newCidBytes: Uint8Array,
): Promise<MarkerResolution> {
  const marker = await readMarker(store);

  if (marker === null) {
    return { v: currentLocalVersion + 1, isIdempotentRetry: false, wasCompacted: false };
  }

  // Case 2: stale marker (crash happened before localVersion was persisted,
  // but after a previous successful publish cleared the marker).
  if (marker.v <= currentLocalVersion) {
    await clearMarker(store);
    return { v: currentLocalVersion + 1, isIdempotentRetry: false, wasCompacted: true };
  }

  const jump = marker.v - currentLocalVersion;

  // Case 3: version-jump clamp (C1).
  if (jump > MARKER_MAX_JUMP) {
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.MARKER_CORRUPT,
      `pending_version marker version jump ${jump} exceeds MARKER_MAX_JUMP=${MARKER_MAX_JUMP} (SPEC §7.1.4 C1 clamp).`,
      { markerV: marker.v, currentLocalVersion, jump },
    );
  }

  // Case 1 (H13 idempotent retry): same v, same cidHash → re-derive.
  const newCidHash = computeCidHash(newCidBytes);
  const cidHashMatch =
    marker.cidHash.length === newCidHash.length &&
    marker.cidHash.every((b, i) => b === newCidHash[i]);

  if (marker.v === currentLocalVersion + 1 && cidHashMatch) {
    return { v: marker.v, isIdempotentRetry: true, wasCompacted: false };
  }

  // Case 4: cidHash mismatch — OTP-safe bump.
  //
  // If marker.v === currentLocalVersion + 1, a prior crashed publish attempt
  // may have already emitted a ciphertext to the aggregator derived from
  // xorKey_{side, marker.v}.  Reusing marker.v with a different plaintext
  // would XOR under the same key, collapsing the one-time-pad to
  //   C_old XOR C_new = P_old XOR P_new.
  //
  // We therefore advance PAST marker.v to guarantee a fresh xorKey.
  // For any other jump (marker.v > currentLocalVersion + 1), the candidate
  // v is currentLocalVersion + 1 which is already fresh (not marker.v), safe.
  const safeV =
    marker.v === currentLocalVersion + 1 ? marker.v + 1 : currentLocalVersion + 1;
  return { v: safeV, isIdempotentRetry: false, wasCompacted: false };
}
