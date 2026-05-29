/**
 * Profile Aggregator Pointer Layer — constants (SPEC §3, v3.5).
 *
 * All constants are locked per spec. Any change requires a SPEC bump
 * AND a rename of PROFILE_POINTER_HKDF_INFO (v1 → v2).
 */

import { utf8ToBytes } from '@noble/hashes/utils.js';

// HKDF info strings (§4)
export const PROFILE_POINTER_HKDF_INFO = utf8ToBytes('uxf-profile-aggregator-pointer-v1'); // 33 bytes
export const SIGNING_SEED_INFO = utf8ToBytes('uxf-profile-pointer-sig-v1'); // 26 bytes
export const XOR_SEED_INFO = utf8ToBytes('uxf-profile-pointer-xor-v1'); // 26 bytes
export const PAD_SEED_INFO = utf8ToBytes('uxf-profile-pointer-pad-v1'); // 26 bytes

// Side markers (§3, §4.4, §4.5, §5)
export const SIDE_A = 0x00;
export const SIDE_B = 0x01;

// Payload layout (§3, §5)
export const PAYLOAD_LEN_BYTES = 32;
export const CID_MAX_BYTES = 63; // 2*PAYLOAD_LEN_BYTES - 1

// Version bounds (§3)
export const VERSION_MIN = 1;
export const VERSION_MAX = 2 ** 31 - 1;

// Discovery (§3, §8.2)
export const DISCOVERY_INITIAL_VERSION = 1024;
export const DISCOVERY_HARD_CEILING = 2 ** 22; // 4_194_304
export const DISCOVERY_PARALLELISM = 1;
export const DISCOVERY_CORRUPT_WALKBACK = 64;

// Publish retry + backoff (§3, §9)
export const PUBLISH_RETRY_BUDGET = 5;
export const PUBLISH_BACKOFF_BASE_MS = 250;
export const PUBLISH_BACKOFF_MAX_MS = 4000;
export const PUBLISH_BACKOFF_JITTER_LO = 0.5;
export const PUBLISH_BACKOFF_JITTER_HI = 1.5;

// Algorithm tag (§3, §4.7)
export const AGGREGATOR_ALG_TAG_SHA256 = new Uint8Array([0x00, 0x00]);

// Per-wallet storage keys (§3, templated on hex(signingPubKey))
export function mutexKey(signingPubKeyHex: string): string {
  return `profile.pointer.publish.lock.${signingPubKeyHex}`;
}
export function pendingVersionKey(signingPubKeyHex: string): string {
  return `profile.pointer.pending_version.${signingPubKeyHex}`;
}
export function blockedFlagKey(signingPubKeyHex: string): string {
  return `profile.pointer.blocked.${signingPubKeyHex}`;
}

// Marker + ciphertext hygiene (§3, §7.1.4, §11.11)
export const MARKER_MAX_JUMP = 1024;
export const MAX_CT_RESIDENT_MS = 500;

// CAR fetch limits (§3, §8.5, §10.7)
export const MAX_CAR_BYTES = 100 * 1024 * 1024;
export const MAX_CAR_FETCH_INITIAL_RESPONSE_MS = 10_000;
export const MAX_CAR_FETCH_STALL_MS = 30_000;
export const MAX_CAR_FETCH_TOTAL_MS = 300_000;
export const MAX_CAR_FETCH_RETRY = 3;
export const MAX_CAR_FETCH_RETRY_BACKOFF_BASE_MS = 500;
export const CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS = 12;
export const CAR_FETCH_PERSISTENT_TOTAL_DURATION_MS = 86_400_000; // 24 h
export const POINTER_PEER_DISCOVERY_MS = 600_000; // 10 min

// RPC timeouts (§3, W4)
export const PUBLISH_REQUEST_TIMEOUT_MS = 30_000;
export const PROBE_REQUEST_TIMEOUT_MS = 10_000;
export const IPNS_RESOLVE_TIMEOUT_MS = 20_000;

// Capability protocol (§13.4, v3.5)
export const NODE_ENV_KEY = 'NODE_ENV';
export const SPHERE_ALLOW_OVERRIDES_KEY = 'SPHERE_ALLOW_OVERRIDES';
export const SPHERE_ALLOW_OVERRIDES_VALUE = '1';

// Trust-base rotation bound (T-C4 steelman). A forged certificate claiming
// an epoch wildly beyond the bundled trust base would otherwise wedge the
// wallet permanently in "update SDK" state. Cap the plausible rotation
// window; anything beyond is classified as forgery, not rotation.
export const MAX_PLAUSIBLE_EPOCH_GAP = 1024n;

// Publish retry_after cumulative cap (T-D1 steelman). A malicious or
// misconfigured aggregator could wedge the publish mutex indefinitely via
// unbounded Retry-After directives. Cap the total wait time within a
// single publishOnce invocation. Sized to accommodate three legitimate
// 60-second load-shed cycles before failing.
export const MAX_CUMULATIVE_RETRY_AFTER_MS = 180_000;

// Steelman²⁰: hard cap on AttemptOptions.maxRetries to prevent loopDeadline
// arithmetic overflow and to size FILE_LOCK_STALE_MS predictably.
// Default maxRetries (PUBLISH_RETRY_BUDGET) is 5; this cap is the upper
// bound for exotic test setups or aggressive recovery paths.
//
// Steelman²¹: lowered from 20 to 10. Each retry can consume both a
// backoff sleep (~8s) AND two network round-trips (~60s for both sides
// at PUBLISH_REQUEST_TIMEOUT_MS). Cap=20 gave a worst-case hold of
// ~1560s which would force FILE_LOCK_STALE_MS to ~26 minutes — an
// unacceptably long crashed-process recovery window. Cap=10 yields a
// worst-case hold of ~860s ≈ 14 minutes, with FILE_LOCK_STALE_MS at
// ~15 minutes (acceptable for interactive wallets).
export const ATTEMPT_MAX_RETRIES_HARD_CAP = 10;

// Steelman²¹ critical: file-lock staleness must EXCEED the maximum time
// publishOnce can hold the mutex INCLUDING network time, not just sleep.
// Worst-case per iteration:
//   PUBLISH_BACKOFF_MAX_MS × 2  (sleep budget; ×2 absorbs jitter)
//   + PUBLISH_REQUEST_TIMEOUT_MS × 2  (network round-trips; both sides A/B)
// Total worst case:
//   MAX_CUMULATIVE_RETRY_AFTER_MS (retry_after sleep cap)
//   + ATTEMPT_MAX_RETRIES_HARD_CAP × (sleep budget + network budget)
//   + FILE_LOCK_STALE_MARGIN_MS (safety)
//
// Setting FILE_LOCK_STALE_MS BELOW the worst-case hold lets proper-lockfile
// reap the lock mid-iteration and a second process take it — silent mutex
// violation. The new formula closes the network-time gap that F.20-F.23
// missed (only sleep budget was counted).
export const FILE_LOCK_STALE_MARGIN_MS = 60_000;
export const FILE_LOCK_STALE_MS =
  MAX_CUMULATIVE_RETRY_AFTER_MS +
  ATTEMPT_MAX_RETRIES_HARD_CAP *
    (PUBLISH_BACKOFF_MAX_MS * 2 + PUBLISH_REQUEST_TIMEOUT_MS * 2) +
  FILE_LOCK_STALE_MARGIN_MS;

// Steelman²¹/²²/²³: module-load invariant — TWO-SIDED.
//
// We pin a HARDCODED expected value (FILE_LOCK_STALE_MS_EXPECTED). Both
// directions are checked:
//
//   (a) FILE_LOCK_STALE_MS < EXPECTED  → manual override / formula drift
//       reduced the value below the documented safety property. Throw.
//
//   (b) FILE_LOCK_STALE_MS > EXPECTED  → a component constant grew
//       (e.g., ATTEMPT_MAX_RETRIES_HARD_CAP raised) without the contributor
//       re-deriving and updating the literal. The new value may be safe,
//       but we want the contributor to actively re-validate. Throw.
//
// Together, (a) + (b) form a tripwire: ANY change to ANY component or to
// the formula forces a coordinated update of FILE_LOCK_STALE_MS_EXPECTED
// in this file, which forces the contributor to re-derive the safety
// property at PR time.
//
// As of F.24 with cap=10, retry_after=180s, backoff_max=4s, request_timeout=30s:
//   expectedHold = 180_000 + 10 × (4_000 × 2 + 30_000 × 2) = 860_000ms
//   margin       = 60_000ms
//   FILE_LOCK_STALE_MS = 920_000ms
const FILE_LOCK_STALE_MS_EXPECTED = 920_000;
if (FILE_LOCK_STALE_MS !== FILE_LOCK_STALE_MS_EXPECTED) {
  throw new Error(
    `pointer-layer constants invariant violated: FILE_LOCK_STALE_MS=${FILE_LOCK_STALE_MS} ` +
      `does NOT match FILE_LOCK_STALE_MS_EXPECTED=${FILE_LOCK_STALE_MS_EXPECTED}. ` +
      `If you changed a component constant or the formula, re-derive the safety property ` +
      `(MAX_CUMULATIVE_RETRY_AFTER_MS + ATTEMPT_MAX_RETRIES_HARD_CAP × ` +
      `(PUBLISH_BACKOFF_MAX_MS × 2 + PUBLISH_REQUEST_TIMEOUT_MS × 2) + FILE_LOCK_STALE_MARGIN_MS) ` +
      `and update FILE_LOCK_STALE_MS_EXPECTED in constants.ts to match.`,
  );
}
