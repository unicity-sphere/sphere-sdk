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
export const ATTEMPT_MAX_RETRIES_HARD_CAP = 20;

// Steelman²⁰ critical: file-lock staleness must EXCEED the maximum time
// publishOnce can hold the mutex.  Worst case:
//   MAX_CUMULATIVE_RETRY_AFTER_MS (180s)
//   + ATTEMPT_MAX_RETRIES_HARD_CAP × PUBLISH_BACKOFF_MAX_MS × 2 (160s)
//   = 340s upper bound.
// Add a 60s safety margin → 400s. The cost is "crashed-process recovery
// takes 400s" which is acceptable for an interactive wallet (a crashed
// wallet cannot publish anyway). Setting this BELOW the worst-case hold
// would let proper-lockfile reap the lock mid-iteration and let a second
// process take it — a silent mutex violation.
export const FILE_LOCK_STALE_MS =
  MAX_CUMULATIVE_RETRY_AFTER_MS +
  ATTEMPT_MAX_RETRIES_HARD_CAP * PUBLISH_BACKOFF_MAX_MS * 2 +
  60_000;
