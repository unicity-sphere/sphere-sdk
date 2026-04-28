/**
 * Bundle acquirer — UXF Inter-Wallet Transfer recipient (T.3.A).
 *
 * Sits between the transport layer (which delivers a decoded
 * {@link UxfTransferPayload}) and the bundle verifier (T.3.A
 * `bundle-verifier.ts`). Responsibilities, in order:
 *
 *   1. **CID-mode gate (T.4.B deferred)** — if `payload.kind === 'uxf-cid'`,
 *      throw `BUNDLE_REJECTED_CID_MODE_NOT_YET_SUPPORTED`. The IPFS fetch
 *      pipeline lands in T.4.B; this module is CAR-only in T.3.
 *
 *   2. **CAR root-CID extraction** — decode `payload.carBase64` to bytes
 *      and run `extractCarRootCid` (T.1.D). This catches:
 *        - `BUNDLE_REJECTED_INVALID_CAR` — bytes don't parse as CARv1.
 *        - `BUNDLE_REJECTED_MULTI_ROOT` — CAR has ≠ 1 root (§5.2 #1).
 *      Both are forwarded as-is from T.1.D's helper.
 *
 *   3. **Root-CID consistency** — confirm the extracted root CID matches
 *      `payload.bundleCid`. The sender authenticates the bundle by
 *      committing to its CID in the outer envelope; a mismatch means
 *      the sender lied about which CAR they're shipping (or the CAR
 *      was swapped in transit). Reject with
 *      `BUNDLE_REJECTED_ROOT_CID_MISMATCH`.
 *
 *   4. **Replay LRU short-circuit** — consult the per-sender-bucketed
 *      {@link ReplayLRU}. If we've recently processed this
 *      `(senderPubkey, bundleCid)` pair, return a `{replay: true}`
 *      sentinel instead of re-running §5.2 (idempotent per §5.6). The
 *      caller treats this as a no-op — the original processing's
 *      disposition stands.
 *
 *   5. **CAR import** — `UxfPackage.fromCar(carBytes)`. On any
 *      `UxfError` thrown by the import path (malformed envelope,
 *      missing manifest, ...) we surface as
 *      `BUNDLE_REJECTED_VERIFY_FAILED` because the acquirer's contract
 *      is "bundle's structure was unacceptable"; the verifier code path
 *      (#6 below) uses the same code for downstream `pkg.verify()`
 *      failures.
 *
 *   6. **Bundle verification** — delegate to {@link verifyBundleStructure}.
 *      On success, mark the LRU and return the {@link VerifiedBundle}.
 *
 * Design notes:
 *
 *   - **LRU is marked AFTER successful verification, NOT on first
 *     arrival.** A bundle that fails §5.2 should NOT short-circuit a
 *     re-arriving valid bundle with the same `bundleCid` — the second
 *     arrival might be a different sender's republish or a corrected
 *     version. (In practice, `bundleCid` is content-addressed, so a
 *     different CID means a different bundle. But we reserve the right
 *     to attempt §5.2 again on each new arrival until success, which
 *     is more robust.)
 *
 *   - **The acquirer does NOT enforce the §5.0 ingest queue back-
 *     pressure cap** (`INGEST_QUEUE_SIZE`). That cap is the caller's
 *     responsibility (T.3.E worker pool). The acquirer assumes its
 *     input has already passed back-pressure gating.
 *
 *   - **CAR-only path** — T.3.A explicitly defers `uxf-cid` to T.4.B.
 *     The `BUNDLE_REJECTED_CID_MODE_NOT_YET_SUPPORTED` code is the
 *     well-typed "not implemented yet" signal so callers can branch
 *     deterministically rather than match on a generic message.
 *
 * Spec references:
 *   - §5.1   Bundle acquisition (CAR / CID branch + replay LRU).
 *   - §5.2   Bundle verification (delegated).
 *   - §5.6   Idempotency (replay LRU short-circuit is a no-op).
 *
 * @packageDocumentation
 */

import { SphereError } from '../../../core/errors.js';
import type { UxfTransferPayload } from '../../../types/uxf-transfer.js';
import {
  isUxfTransferPayloadCar,
  isUxfTransferPayloadCid,
} from '../../../types/uxf-transfer.js';
import { UxfPackage } from '../../../uxf/UxfPackage.js';
import { UxfError } from '../../../uxf/errors.js';
import {
  carBase64ToBytes,
  extractCarRootCid,
} from '../../../uxf/transfer-payload.js';

import {
  verifyBundleStructure,
  type VerifiedBundle,
} from './bundle-verifier.js';
import type { ReplayLRU } from './replay-lru.js';

// =============================================================================
// 1. Public types — discriminated outcome
// =============================================================================

/**
 * The replay short-circuit signal: this `(senderPubkey, bundleCid)`
 * pair was processed recently, and re-processing is a no-op per §5.6.
 * The caller MUST NOT touch local state — the original processing's
 * disposition stands.
 */
export interface ReplayOutcome {
  readonly replay: true;
  /** Echo of the bundleCid that short-circuited; useful for telemetry. */
  readonly bundleCid: string;
}

/**
 * Successful bundle acquisition + verification. The `verified` flag
 * lets the caller narrow the union via a single property check.
 */
export type AcquireBundleResult = VerifiedBundle | ReplayOutcome;

/**
 * Type guard distinguishing the two outcomes of {@link acquireBundle}.
 */
export function isReplayOutcome(result: AcquireBundleResult): result is ReplayOutcome {
  return (result as { replay?: boolean }).replay === true;
}

// =============================================================================
// 2. Public API — acquireBundle
// =============================================================================

/**
 * Acquire and verify a bundle from a `UxfTransferPayload`.
 *
 * @param payload       The decoded outer envelope (from
 *                      `decodeTransferPayload` in T.1.D).
 * @param senderPubkey  The Nostr signing pubkey of the event author
 *                      (transport pubkey, 64-hex). Used to partition
 *                      the {@link ReplayLRU} per Note N5. Callers MUST
 *                      pass the AUTHENTICATED pubkey (i.e., the one
 *                      verified by the Nostr event signature), NOT the
 *                      unauthenticated `payload.sender.transportPubkey`
 *                      claim — the latter could be lied about by a
 *                      hostile sender to share a bucket with another
 *                      identity.
 * @param lru           A {@link ReplayLRU} instance for short-circuit
 *                      handling. Same instance across all worker
 *                      invocations — the LRU is module-scoped.
 *
 * @returns A {@link VerifiedBundle} on first-time success, or a
 *          {@link ReplayOutcome} when the LRU short-circuits.
 *
 * @throws {SphereError} `BUNDLE_REJECTED_CID_MODE_NOT_YET_SUPPORTED`
 *         for `kind: 'uxf-cid'` (T.4.B will enable).
 * @throws {SphereError} `BUNDLE_REJECTED_MALFORMED_ENVELOPE` if
 *         `carBase64` decode fails (delegated to
 *         {@link carBase64ToBytes}).
 * @throws {SphereError} `BUNDLE_REJECTED_INVALID_CAR` if CAR bytes
 *         don't parse (from `extractCarRootCid`).
 * @throws {SphereError} `BUNDLE_REJECTED_MULTI_ROOT` if CAR has ≠ 1 root
 *         (from `extractCarRootCid`, §5.2 #1).
 * @throws {SphereError} `BUNDLE_REJECTED_ROOT_CID_MISMATCH` if the
 *         CAR's root CID disagrees with `payload.bundleCid`.
 * @throws {SphereError} `BUNDLE_REJECTED_VERIFY_FAILED` if `pkg.verify()`
 *         reports any DAG-integrity error (§5.2 #1) OR if
 *         `UxfPackage.fromCar` throws (malformed envelope, ...).
 * @throws {SphereError} `BUNDLE_REJECTED_CHAIN_DEPTH_EXCEEDED` (§5.2 #3).
 * @throws {SphereError} `BUNDLE_REJECTED_UNCLAIMED_ROOT_COUNT_EXCEEDED`
 *         (§5.2 #4).
 * @throws {SphereError} `BUNDLE_REJECTED_MALFORMED_ENVELOPE` if the
 *         `payload` discriminator is unrecognized (legacy / unknown
 *         shape — out of scope here).
 */
export async function acquireBundle(
  payload: UxfTransferPayload,
  senderPubkey: string,
  lru: ReplayLRU,
): Promise<AcquireBundleResult> {
  // ---- Step 1: CID-mode gate (T.4.B deferred) ----
  if (isUxfTransferPayloadCid(payload)) {
    throw new SphereError(
      'acquireBundle: kind="uxf-cid" delivery is not yet supported in this build ' +
        '(T.4.B will enable IPFS-fetch path)',
      'BUNDLE_REJECTED_CID_MODE_NOT_YET_SUPPORTED',
    );
  }

  // ---- Discriminator check: only uxf-car is in scope here ----
  if (!isUxfTransferPayloadCar(payload)) {
    // Legacy / unknown shapes are routed elsewhere (T.7.B legacy adapter).
    // Reaching here means the caller mis-routed the payload.
    throw new SphereError(
      'acquireBundle: payload is not a UXF v1.0 uxf-car envelope ' +
        '(legacy shapes are handled by the legacy-adapter pipeline)',
      'BUNDLE_REJECTED_MALFORMED_ENVELOPE',
    );
  }

  // ---- Step 2: CAR root-CID extraction ----
  // `carBase64ToBytes` throws BUNDLE_REJECTED_MALFORMED_ENVELOPE on
  // base64-alphabet violations; `extractCarRootCid` throws
  // BUNDLE_REJECTED_INVALID_CAR or BUNDLE_REJECTED_MULTI_ROOT.
  const carBytes = carBase64ToBytes(payload.carBase64);
  const extractedCid = await extractCarRootCid(carBytes);

  // ---- Step 3: Root-CID consistency ----
  if (extractedCid !== payload.bundleCid) {
    throw new SphereError(
      `acquireBundle: CAR root CID ${extractedCid} does not match ` +
        `payload.bundleCid ${payload.bundleCid}`,
      'BUNDLE_REJECTED_ROOT_CID_MISMATCH',
    );
  }

  // ---- Step 4: Replay LRU short-circuit ----
  if (lru.has(senderPubkey, extractedCid)) {
    return {
      replay: true,
      bundleCid: extractedCid,
    };
  }

  // ---- Step 5: CAR import ----
  // Wrap UxfError → SphereError so callers see a uniform error code
  // surface. The original error rides as `cause` for forensics.
  let pkg: UxfPackage;
  try {
    pkg = await UxfPackage.fromCar(carBytes);
  } catch (cause) {
    if (cause instanceof UxfError) {
      throw new SphereError(
        `acquireBundle: UxfPackage.fromCar failed: ${cause.message}`,
        'BUNDLE_REJECTED_VERIFY_FAILED',
        cause,
      );
    }
    // Re-throw non-UxfError causes verbatim — they're system-level
    // (out-of-memory, abort signal, ...) not bundle structural.
    throw cause;
  }

  // ---- Step 6: §5.2 verification ----
  // Throws on rejection; otherwise returns the VerifiedBundle.
  const verified = verifyBundleStructure(pkg, payload, extractedCid);

  // ---- Step 7: Mark LRU only AFTER successful verification ----
  // If verification threw, we want a fresh re-arrival to retry §5.2 —
  // a hostile sender shipping a malformed bundle should not poison
  // the LRU against a later valid republish (different bundleCid in
  // that case anyway, but the principle stands: failures don't
  // suppress retries).
  lru.add(senderPubkey, extractedCid);

  return verified;
}
