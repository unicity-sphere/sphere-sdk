/**
 * Bundle acquirer — UXF Inter-Wallet Transfer recipient (T.3.A + T.4.B).
 *
 * Sits between the transport layer (which delivers a decoded
 * {@link UxfTransferPayload}) and the bundle verifier (T.3.A
 * `bundle-verifier.ts`). Responsibilities, in order:
 *
 *   1. **CID-mode branch (T.4.B)** — if `payload.kind === 'uxf-cid'`,
 *      delegate to {@link fetchCarByCid} (cid-fetcher.ts). The fetcher
 *      walks the configured gateway list, stream-fetches under the
 *      32 MiB cap, and verifies the CAR root CID matches `bundleCid`.
 *      On success we re-enter the CAR-validation path with the fetched
 *      bytes. On all-gateways-failure, the fetcher emits
 *      `transfer:fetch-failed` and throws
 *      `BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT` — the worker pool
 *      treats this as TRANSIENT (W13: NO disposition record).
 *
 *      **Gateway list resolution** (§3.3): we use the wallet's own
 *      configured gateway list, NOT `payload.senderGateways` (the
 *      latter is informational only — a hostile sender could lie). The
 *      caller passes the resolved gateway list via `options.gateways`.
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
 *   - **CID-mode path enabled (T.4.B)**. When the caller does NOT supply
 *     `options.gateways`, the legacy `BUNDLE_REJECTED_CID_MODE_NOT_YET_SUPPORTED`
 *     reject path is preserved for backward-compat with callers that
 *     have not yet wired the gateway list. New callers (post-T.4.B)
 *     SHOULD always pass `gateways` so the CID branch works.
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
import type {
  CidFetcherEmit,
  CidFetcherFetch,
} from './cid-fetcher.js';
// NOTE — `fetchCarByCid` is no longer the uxf-cid fetch primitive (see
// Issue #223 inline comment in the uxf-cid branch below). It remains
// exported from `./cid-fetcher` for any legacy caller / future
// streaming-CAR consumer; UXF transfer bundles route through
// `fetchCarFromIpfs` instead because the gateway's `?format=car`
// endpoint cannot traverse Option-C raw-bstr child references.
import { fetchCarFromIpfs } from '../../../profile/ipfs-client.js';
import { ProfileError } from '../../../profile/errors.js';
import { RELAY_SAFE_CAP_BYTES } from './limits.js';
import type { ReplayLRU } from './replay-lru.js';

// =============================================================================
// 1.5. Steelman fix #170 — recipient-side inline-CAR size cap
// =============================================================================

/**
 * Maximum size (in characters) of the `carBase64` string in a `kind: 'uxf-car'`
 * payload that the recipient will accept.
 *
 * **Why a recipient-side cap exists:** the sender enforces
 * `clampInlineCap` against `RELAY_SAFE_CAP_BYTES = 96 KiB` before
 * inlining a CAR. But the cap is only authoritative if the RECIPIENT
 * also enforces it. Without recipient-side enforcement, a hostile
 * sender (or a mis-configured one) can ship a 6 MiB base64 payload
 * (~4.5 MiB CAR) inline, bypassing the relay-safe cap entirely. The
 * recipient then base64-decodes the entire blob and runs CAR parse on
 * it — both expensive operations the cap was supposed to prevent.
 *
 * **Authoritative bound:** the recipient's check here is the canonical
 * enforcement point. The sender's clamp is a politeness layer for the
 * relay; the recipient's check is a defense.
 *
 * **Computation:** base64 inflates 4 bytes → 3 bytes (ratio 4/3). For a
 * raw byte cap of `RELAY_SAFE_CAP_BYTES` (96 KiB = 98304 bytes), the
 * base64 string is at most `ceil(98304 * 4 / 3) = 131072` characters
 * (with possible trailing `=` padding adding up to 2 bytes more). We
 * add a small slack (16 bytes) to absorb whitespace / padding without
 * false-positives on legitimately-sized bundles.
 *
 * Effective cap: `ceil(RELAY_SAFE_CAP_BYTES * 4/3) + slack`.
 */
const INLINE_BASE64_SLACK_BYTES = 16;
export const RECIPIENT_MAX_INLINE_CARBASE64_LENGTH =
  Math.ceil((RELAY_SAFE_CAP_BYTES * 4) / 3) + INLINE_BASE64_SLACK_BYTES;

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
// 2. Public types — CID-fetch wiring options (T.4.B)
// =============================================================================

/**
 * Optional CID-fetch wiring for {@link acquireBundle}.
 *
 * When the incoming payload's `kind` is `'uxf-cid'`, the acquirer
 * delegates to {@link fetchCarByCid} — but only if a non-empty
 * `gateways` list is supplied. Without gateways we preserve the legacy
 * T.3.A reject path (`BUNDLE_REJECTED_CID_MODE_NOT_YET_SUPPORTED`) for
 * backward-compat with callers that have not yet been migrated.
 *
 * Spec refs: §3.3 (gateway list is recipient-controlled, NOT
 * `senderGateways`), §3.3.1 (32 MiB cap), §9.2 / W13 (transient-only
 * failure path — no disposition record).
 */
export interface AcquireBundleCidOptions {
  /**
   * Gateway URL list, walked in order. SHOULD be the wallet's own
   * configured list — `payload.senderGateways` is unauthenticated and
   * ignored by this code path on principle (§3.3 hostile-sender
   * defense).
   */
  readonly gateways?: ReadonlyArray<string>;
  /**
   * Optional fetch override (test seam). Defaults to `globalThis.fetch`.
   */
  readonly fetch?: CidFetcherFetch;
  /**
   * Optional event emitter — wired by the caller to the Sphere event
   * bus so a `transfer:fetch-failed` event surfaces to the application
   * when every gateway fails (§9.2).
   */
  readonly emit?: CidFetcherEmit;
  /**
   * Optional abort signal — propagates through to the streaming fetch
   * loop. The caller (worker pool) cancels via this when shutting down.
   */
  readonly signal?: AbortSignal;
  /**
   * Optional override of the recipient-side max CAR size cap. Defaults
   * to {@link MAX_FETCHED_CAR_BYTES} (32 MiB). Tests pass smaller
   * values to exercise the streaming-abort path with feasible mocks.
   */
  readonly maxBytes?: number;
}

// =============================================================================
// 3. Public API — acquireBundle
// =============================================================================

/**
 * Steelman fix #170 — per-`(senderPubkey, bundleCid)` in-flight latch
 * for concurrent verify coalescing.
 *
 * **Bug:** the `lru.has(...)` short-circuit at Step 4 runs BEFORE
 * verification; `lru.add(...)` at Step 7 runs AFTER. Two concurrent
 * worker calls receiving the SAME `(senderPubkey, bundleCid)` both
 * observe `has === false`, both run the full §5.2 pipeline (CAR
 * parse, hash recompute, `pkg.verify()`). Wasted CPU; an attacker can
 * amplify by republishing the same bundle to two relays the recipient
 * subscribes to.
 *
 * **Fix:** a module-scoped `Map` keyed by `${senderPubkey}|${bundleCid}`
 * holds the in-flight verification promise. On entry, `acquireBundle`
 * checks the map; if a promise exists for this key, it returns the
 * SAME promise (so both callers share the result). The entry is
 * removed via `.finally()` once the promise settles — but only AFTER
 * the LRU has been marked, so subsequent calls hit the LRU
 * short-circuit instead of restarting verify.
 *
 * **Latch lifetime ordering** (critical):
 *
 *   1. acquireBundle() runs `doVerify()` which, on success, calls
 *      `lru.add(...)` BEFORE returning the verified bundle.
 *   2. The `.finally()` registered on the inflight promise runs AFTER
 *      `doVerify()` has already returned — i.e., AFTER `lru.add` ran.
 *   3. The `.finally()` removes the latch entry from the map.
 *   4. A subsequent `acquireBundle` call observes `lru.has(...) === true`
 *      and short-circuits via the ReplayOutcome path. NO restart of
 *      verification.
 *
 * If `doVerify` throws (any rejection path), the LRU is NOT marked
 * (Step 7 only runs on success). `.finally()` still removes the latch.
 * A retry then runs `doVerify` afresh — which is the desired behavior:
 * a hostile sender shipping a malformed bundle should not have their
 * failure cached as "verified" and recurring re-arrivals SHOULD re-try
 * §5.2 in case the next arrival is well-formed.
 *
 * **Memory bound:** the map is bounded by the number of *concurrently
 * in-flight* verifications. The worker pool fan-out caps this at
 * MAX_INGEST_WORKERS = 16, so the map never exceeds ~16 entries plus
 * a transient burst window during finalization. No leak even under
 * pathological concurrency: each entry self-removes via `.finally()`.
 *
 * **Per-process scope is correct:** the LRU is per-process; latch
 * coalescing is also per-process. Two separate Sphere instances in the
 * same Node process would each have their own `acquireBundle` import,
 * which means each gets its own module-scoped map. That is fine —
 * separate Sphere instances don't share an LRU either.
 */
const inflight = new Map<string, Promise<AcquireBundleResult>>();

// =============================================================================
// 3.5. Steelman warning fix — negative-LRU for verify-failed sequences
// =============================================================================

/**
 * Maximum entries in {@link verifyFailedLru} before FIFO eviction.
 * Distinct from the main {@link ReplayLRU} bounds — this is a small,
 * dedicated cache local to bundle-acquirer.
 */
const VERIFY_FAILED_LRU_MAX_ENTRIES = 1024;

/**
 * Time-to-live (ms) for negative-LRU entries. After this window
 * elapses, a re-arrival of the same `(senderPubkey, bundleCid)` pair
 * will run the full verification pipeline again — at which point the
 * sender may have shipped a corrected bundle (e.g. retry after a
 * transient encoding bug). 30 seconds is long enough to absorb the
 * inflight-latch finally-microtask + repeated re-arrivals from a
 * hostile loop, but short enough to be operationally invisible to a
 * legitimate retry.
 */
const VERIFY_FAILED_LRU_TTL_MS = 30_000;

/**
 * Negative LRU keyed on `${senderPubkey}|${bundleCid}` recording recent
 * `pkg.verify()` failures (and other hard rejections from
 * {@link doAcquireBundle}'s catch path).
 *
 * **Why this exists (steelman warning fix):** the main {@link ReplayLRU}
 * is marked ONLY on successful verification (intentional — failures
 * MUST NOT short-circuit a corrected republish; see Step 7 doc). But
 * after a failed verify, sequential re-arrivals of the SAME (sender,
 * bundleCid) pair (post the inflight-latch finally microtask) re-run
 * the full §5.2 pipeline (CAR-parse, hash recompute, `pkg.verify()`).
 * A hostile sender can amplify this by re-publishing the same invalid
 * bundleCid in a tight loop.
 *
 * The negative LRU plugs that gap: a recent failure short-circuits to
 * the cached failure for {@link VERIFY_FAILED_LRU_TTL_MS} before the
 * main pipeline retries. Bounded entries (FIFO eviction) prevent
 * unbounded memory growth even under hostile flooding.
 *
 * **Round 3 regression fix — transient errors are NOT cached.** The
 * Round 2 implementation cached ANY `SphereError`, including
 * {@link TRANSIENT_REJECT_CODES} like
 * `BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT`. A one-time gateway blip
 * would then short-circuit the W13 retry path for
 * {@link VERIFY_FAILED_LRU_TTL_MS} (30 s) — e.g., a temporary IPFS
 * outage poisons the cache for 30 s, blocking legitimate retries from
 * the same sender. {@link recordVerifyFailure} now filters these out
 * so transient failures continue to re-run the pipeline immediately.
 * Permanent / structural rejections still cache correctly.
 *
 * **Why it is local to bundle-acquirer (NOT integrated with
 * ReplayLRU):** the two have different semantics — ReplayLRU keys on
 * successful verifications and gates short-circuit; this one keys on
 * failures and gates re-attempt. Mixing them would either pollute
 * ReplayLRU's success-only invariant or force ReplayLRU to grow a
 * second class of entries with different eviction rules. A separate
 * Map is simpler and keeps the failure semantics scoped to where they
 * are produced.
 *
 * **Memory bound:** at most {@link VERIFY_FAILED_LRU_MAX_ENTRIES}
 * entries × ~200-byte composite key + 16-byte timestamp ≈ 220 KiB
 * resident worst case. Acceptable for an interactive wallet.
 */
interface VerifyFailedEntry {
  readonly cachedAt: number;
  readonly errorCode: string;
  readonly errorMessage: string;
}
const verifyFailedLru = new Map<string, VerifyFailedEntry>();

/**
 * Round 3 fix — error codes that are CLASS:transient and MUST NOT be
 * cached in the negative LRU. Caching a transient failure would block
 * the legitimate W13 retry pathway for the negative-LRU TTL (30 s),
 * which conflicts with the spec requirement that transient failures
 * surface only to the sender's outbox timeout (no recipient-side
 * disposition / retry suppression).
 *
 * Currently a single code, but exported as a set so future
 * documented-transient codes can be added in one place. Search the
 * `core/errors.ts` file for "TRANSIENT" to confirm scope.
 */
const TRANSIENT_REJECT_CODES = new Set<string>([
  'BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT',
]);

/**
 * Insert a negative-LRU entry for `(senderPubkey, bundleCid)`. Evicts
 * the oldest entry (Map insertion order ≡ insertion-time recency) when
 * the cap is exceeded.
 *
 * **Round 3 regression fix:** transient-class error codes (see
 * {@link TRANSIENT_REJECT_CODES}) are filtered out and NOT cached. A
 * one-time gateway blip on a `uxf-cid` payload should not block the
 * W13 retry pathway for the cache TTL — that would convert a transient
 * failure into a recipient-side persistent rejection. Permanent /
 * structural rejections (root-CID mismatch, malformed envelope, verify
 * failure, ...) still cache correctly so a hostile re-publish loop
 * cannot amplify CPU.
 */
function recordVerifyFailure(
  senderPubkey: string,
  bundleCid: string,
  err: SphereError,
): void {
  if (TRANSIENT_REJECT_CODES.has(err.code)) {
    return;
  }
  const key = `${senderPubkey}|${bundleCid}`;
  // Refresh on insert: delete-then-insert pushes the entry to the back
  // of iteration order (LRU semantics). FIFO eviction at the front.
  verifyFailedLru.delete(key);
  verifyFailedLru.set(key, {
    cachedAt: Date.now(),
    errorCode: err.code,
    errorMessage: err.message,
  });
  while (verifyFailedLru.size > VERIFY_FAILED_LRU_MAX_ENTRIES) {
    const oldest = verifyFailedLru.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    verifyFailedLru.delete(oldest);
  }
}

/**
 * Look up `(senderPubkey, bundleCid)` in the negative LRU. Returns the
 * cached failure if present AND within {@link VERIFY_FAILED_LRU_TTL_MS}
 * of `cachedAt`; otherwise null. Stale entries are silently dropped on
 * read so the cache never accumulates expired entries.
 */
function getCachedVerifyFailure(
  senderPubkey: string,
  bundleCid: string,
): VerifyFailedEntry | null {
  const key = `${senderPubkey}|${bundleCid}`;
  const entry = verifyFailedLru.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > VERIFY_FAILED_LRU_TTL_MS) {
    verifyFailedLru.delete(key);
    return null;
  }
  return entry;
}

/**
 * Test-only: clear all inflight latches AND the negative LRU.
 * Production code must never call this. Tests use it between
 * assertions to avoid cross-test leakage when a fixture deliberately
 * holds a verify promise open or seeds the negative LRU.
 */
export function __clearInflightForTests(): void {
  inflight.clear();
  verifyFailedLru.clear();
}

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
 * @param cidOptions    Optional T.4.B CID-fetch wiring. When supplied
 *                      (with a non-empty `gateways` list), enables the
 *                      `kind: 'uxf-cid'` branch. Omit to preserve the
 *                      pre-T.4.B "CID not yet supported" reject.
 *
 * @returns A {@link VerifiedBundle} on first-time success, or a
 *          {@link ReplayOutcome} when the LRU short-circuits.
 *
 * @throws {SphereError} `BUNDLE_REJECTED_CID_MODE_NOT_YET_SUPPORTED`
 *         for `kind: 'uxf-cid'` when no `cidOptions.gateways` are
 *         supplied (legacy reject path).
 * @throws {SphereError} `BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT` if
 *         every gateway in `cidOptions.gateways` failed (T.4.B; W13:
 *         caller MUST treat as TRANSIENT, NO disposition record).
 * @throws {SphereError} `FETCHED_CAR_TOO_LARGE` is collapsed into a
 *         per-gateway failure reason; never escapes directly.
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
  cidOptions?: AcquireBundleCidOptions,
): Promise<AcquireBundleResult> {
  // ---- Step 0: per-(sender, bundleCid) inflight latch ----
  // Coalesce concurrent verify calls with the same key. See module-level
  // `inflight` doc for the latch lifetime rationale (note: latch is
  // released via .finally AFTER doAcquireBundle has already called
  // lru.add, so subsequent callers hit the LRU short-circuit rather than
  // restarting verification).
  //
  // We key on `senderPubkey` (the AUTHENTICATED Nostr signing pubkey,
  // per the @param doc above) and `payload.bundleCid` (the sender's
  // claim — verified later in Step 3 against the CAR root). Using the
  // claim here is safe because: (a) on mismatch, doAcquireBundle throws
  // BUNDLE_REJECTED_ROOT_CID_MISMATCH, the latch is released without
  // marking the LRU, and a re-arrival will retry; (b) the latch only
  // affects parallel calls *during* this verify — it does not poison
  // any post-verify state.
  //
  // The latch is only engaged for UXF v1.0 payload shapes that carry a
  // `bundleCid`. Legacy shapes (no `bundleCid`) fall through directly to
  // doAcquireBundle, which rejects them as
  // BUNDLE_REJECTED_MALFORMED_ENVELOPE — there is no benefit in
  // coalescing rejections of unrecognized shapes.
  if (!isUxfTransferPayloadCar(payload) && !isUxfTransferPayloadCid(payload)) {
    return doAcquireBundle(payload, senderPubkey, lru, cidOptions);
  }

  // Steelman warning fix — negative LRU short-circuit. If we recently
  // failed to verify this exact (sender, bundleCid) pair, re-throw the
  // cached failure rather than re-running the full pipeline. Bounded
  // TTL ({@link VERIFY_FAILED_LRU_TTL_MS}) so a corrected republish
  // does eventually retry; bounded size ({@link
  // VERIFY_FAILED_LRU_MAX_ENTRIES}) so a hostile flood cannot bloat
  // memory.
  const cachedFailure = getCachedVerifyFailure(senderPubkey, payload.bundleCid);
  if (cachedFailure) {
    throw new SphereError(
      `acquireBundle: negative-LRU short-circuit — recent failure cached ` +
        `(${cachedFailure.errorCode}: ${cachedFailure.errorMessage})`,
      cachedFailure.errorCode as never,
    );
  }

  const latchKey = `${senderPubkey}|${payload.bundleCid}`;
  const existing = inflight.get(latchKey);
  if (existing) {
    return existing;
  }
  const promise = doAcquireBundle(payload, senderPubkey, lru, cidOptions)
    .catch((err: unknown) => {
      // Negative-LRU population (steelman warning fix). Record only
      // SphereError instances — system-level errors (out-of-memory,
      // abort) are not bundle-attributable and shouldn't poison the
      // cache against a corrected re-arrival.
      if (err instanceof SphereError) {
        recordVerifyFailure(senderPubkey, payload.bundleCid, err);
      }
      throw err;
    })
    .finally(() => {
      // Remove the latch only AFTER doAcquireBundle resolves/rejects.
      // For success: doAcquireBundle has already called lru.add(), so
      // the next `acquireBundle` for the same key hits the main LRU
      // short-circuit. For failure: the negative-LRU short-circuits
      // immediate re-arrivals; the main LRU is unchanged so a fresh
      // pipeline runs after the negative-LRU TTL elapses.
      inflight.delete(latchKey);
    });
  inflight.set(latchKey, promise);
  return promise;
}

/**
 * The verification body. Extracted from {@link acquireBundle} so the
 * latch wrapper does not have to inline 60+ lines of pipeline. All
 * documented behavior of `acquireBundle` lives here.
 */
async function doAcquireBundle(
  payload: UxfTransferPayload,
  senderPubkey: string,
  lru: ReplayLRU,
  cidOptions?: AcquireBundleCidOptions,
): Promise<AcquireBundleResult> {
  // ---- Step 1: CID-mode branch (T.4.B) ----
  // We obtain `carBytes` and `extractedCid` from one of two paths:
  //   - uxf-car: base64-decode the embedded payload.
  //   - uxf-cid: stream-fetch from a configured gateway list.
  // Both paths converge into the same `(carBytes, extractedCid,
  // bundleCid)` triplet, and the rest of the pipeline (LRU + verifier)
  // runs identically. This deliberate convergence is why "force-cid on
  // a tiny bundle still goes through CID fetch" is a no-op regression
  // for the receiver — the CID path doesn't shortcut based on size.
  let carBytes: Uint8Array;
  let extractedCid: string;

  if (isUxfTransferPayloadCid(payload)) {
    if (!cidOptions || !cidOptions.gateways || cidOptions.gateways.length === 0) {
      // Pre-T.4.B compat: caller has not wired CID-fetch yet.
      throw new SphereError(
        'acquireBundle: kind="uxf-cid" requires cidOptions.gateways to be ' +
          'a non-empty list (T.4.B CID-fetch path); none supplied',
        'BUNDLE_REJECTED_CID_MODE_NOT_YET_SUPPORTED',
      );
    }
    // Issue #223 — switch the uxf-cid fetch from the trustless-gateway
    // CAR endpoint (`?format=car`) to the hierarchical block-walking
    // fetcher (`profile/ipfs-client.ts:fetchCarFromIpfs`).
    //
    // **Why the switch is necessary.** The sender pins every UXF block
    // individually via `dag/put` (`profile/ipfs-client.ts:pinCarBlocksToIpfs`).
    // Under Issue #213's Option-C canonical encoding, child references
    // inside UXF element blocks are stored as raw 32-byte bstrs — NOT
    // as standard CBOR Tag 42 CID links — so that
    // `sha256(block.bytes) === block.cid.multihash.digest` holds for
    // every sub-block. The gateway's `?format=car` DAG traversal can
    // only follow Tag 42 CID links, so it returns only the root +
    // envelope + manifest and stops there. The receiver sees a CAR
    // missing every UXF element sub-block and `pkg.verify()` throws
    // `MISSING_ELEMENT` (`uxf/verify.ts:241`), which
    // `IngestWorkerPool.classifyAcquireError` silently swallows as a
    // hard bundle rejection — the transfer is invisible.
    //
    // `fetchCarFromIpfs` is the symmetric consumer for the producer's
    // per-block pin path: it parses the root, walks UXF-aware element
    // children (`isUxfElement` / `walkUxfElement`), fetches each block
    // via `block/get`, and reassembles a CAR. The result is a CAR
    // that `UxfPackage.fromCar` and `pkg.verify` will accept.
    //
    // **Trade-offs vs `fetchCarByCid` (which is still kept for legacy
    // callers and as the streaming-fetch primitive):**
    //   - Per-block fetches instead of one streaming gateway hit (more
    //     round-trips, but each is a small `block/get` and capped by
    //     `FETCH_CAR_MAX_BLOCKS`).
    //   - `transfer:fetch-failed` event — fired below from this
    //     boundary when `fetchCarFromIpfs` throws (mirrors the W13
    //     telemetry contract that `fetchCarByCid` honored from inside).
    //   - No caller AbortSignal pass-through — the worker pool's
    //     per-bundle wall-clock budget still applies via
    //     `BUNDLE_MAX_PROCESSING_MS` in the dispatcher.
    //
    // Defense-in-depth: we still re-extract the root CID from the
    // reassembled bytes and compare against `payload.bundleCid` below.
    try {
      carBytes = await fetchCarFromIpfs(
        [...cidOptions.gateways],
        payload.bundleCid,
      );
    } catch (cause) {
      if (cause instanceof ProfileError && cause.code === 'BUNDLE_NOT_FOUND') {
        // Fire the W13 telemetry event so operator dashboards see the
        // failed gateway-walk. The bundle-acquirer is the boundary
        // that owns this signal in the new block-walk path (the old
        // `fetchCarByCid` emitted from inside).
        cidOptions.emit?.('transfer:fetch-failed', {
          bundleCid: payload.bundleCid,
          senderTransportPubkey: senderPubkey,
          gatewaysAttempted: [...cidOptions.gateways],
          failureReasons: [`block-walk-failed: ${cause.message.slice(0, 200)}`],
        });
        // Re-wrap as the canonical bundle-acquirer transient. W13:
        // NO disposition record; the worker pool's
        // `classifyAcquireError` recognizes this code and short-
        // circuits the disposition write.
        throw new SphereError(
          `acquireBundle: fetchCarFromIpfs failed for ${payload.bundleCid}: ${cause.message}`,
          'BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT',
          {
            bundleCid: payload.bundleCid,
            gatewaysAttempted: [...cidOptions.gateways],
            reason: 'block-walk-failed',
          },
        );
      }
      throw cause;
    }
    // Re-extract from the bytes (NOT trusting the fetcher's claim).
    // `extractCarRootCid` throws BUNDLE_REJECTED_INVALID_CAR /
    // BUNDLE_REJECTED_MULTI_ROOT — correct surface-level errors at
    // this boundary because the fetcher has already delivered bytes
    // claimed to be a valid CAR; if they aren't, the recipient sees
    // the same error code as the uxf-car branch.
    extractedCid = await extractCarRootCid(carBytes);
    if (extractedCid !== payload.bundleCid) {
      // The fetcher's internal check was bypassed somehow — surface
      // the same mismatch error the uxf-car path uses so downstream
      // telemetry / disposition logic stays uniform across both
      // branches.
      throw new SphereError(
        `acquireBundle: defense-in-depth CID re-check failed — ` +
          `CAR root CID ${extractedCid} does not match payload.bundleCid ` +
          `${payload.bundleCid} (fetcher's internal verification was bypassed)`,
        'BUNDLE_REJECTED_ROOT_CID_MISMATCH',
      );
    }
  } else if (isUxfTransferPayloadCar(payload)) {
    // ---- Step 2: recipient-side inline-CAR size cap (steelman #170) ----
    // Authoritative enforcement of the §3.3.1 inline-CAR cap at the
    // recipient. The sender's `clampInlineCap` is a politeness layer for
    // the relay; the recipient is the SINGLE SOURCE OF TRUTH for
    // refusing oversized inline payloads. See module-level
    // `RECIPIENT_MAX_INLINE_CARBASE64_LENGTH` doc for the math behind
    // the bound (96 KiB raw → ~131072 base64 chars + slack). A hostile
    // sender shipping carBase64 above this cap is rejected BEFORE we
    // base64-decode (we never allocate a multi-megabyte buffer for
    // their attack).
    if (payload.carBase64.length > RECIPIENT_MAX_INLINE_CARBASE64_LENGTH) {
      throw new SphereError(
        `acquireBundle: carBase64 length ${payload.carBase64.length} exceeds ` +
          `recipient inline cap ${RECIPIENT_MAX_INLINE_CARBASE64_LENGTH} (raw cap ` +
          `${RELAY_SAFE_CAP_BYTES} bytes); use kind="uxf-cid" for larger bundles`,
        'BUNDLE_REJECTED_INLINE_CAP_EXCEEDED',
      );
    }
    // `carBase64ToBytes` throws BUNDLE_REJECTED_MALFORMED_ENVELOPE on
    // base64-alphabet violations; `extractCarRootCid` throws
    // BUNDLE_REJECTED_INVALID_CAR or BUNDLE_REJECTED_MULTI_ROOT.
    carBytes = carBase64ToBytes(payload.carBase64);
    extractedCid = await extractCarRootCid(carBytes);

    // ---- Step 3: Root-CID consistency (uxf-car path) ----
    if (extractedCid !== payload.bundleCid) {
      throw new SphereError(
        `acquireBundle: CAR root CID ${extractedCid} does not match ` +
          `payload.bundleCid ${payload.bundleCid}`,
        'BUNDLE_REJECTED_ROOT_CID_MISMATCH',
      );
    }
  } else {
    // Legacy / unknown shapes are routed elsewhere (T.7.B legacy adapter).
    // Reaching here means the caller mis-routed the payload.
    throw new SphereError(
      'acquireBundle: payload is not a UXF v1.0 uxf-car or uxf-cid envelope ' +
        '(legacy shapes are handled by the legacy-adapter pipeline)',
      'BUNDLE_REJECTED_MALFORMED_ENVELOPE',
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

  // ---- Step 8: Graduate sender into the trusted pool ----
  // Option B post-steelman: senders that have shipped at least one
  // successfully verified bundle live in the trusted pool, immune to
  // sybil-driven bucket-level eviction in the untrusted pool. Calling
  // markSenderTrusted ONLY after a successful verifyBundleStructure
  // ensures attackers cannot trivially graduate their throwaway
  // pubkeys — they would need to ship a real CAR, with a real
  // pkg.verify() success, every time.
  lru.markSenderTrusted(senderPubkey);

  return verified;
}
