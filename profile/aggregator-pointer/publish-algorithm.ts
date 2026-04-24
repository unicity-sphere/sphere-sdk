/**
 * Publish algorithm (T-D1) — SPEC §7.1, §7.2, §7.3, §7.4.
 *
 * Orchestrates a single publish attempt at a specified version:
 *
 *   1. Acquire the per-wallet publish mutex (§7.1.1).
 *   2. Check BLOCKED state — fail fast if set (§10.2).
 *   3. Resolve publish version via pending-version marker (§7.1.4, H13).
 *   4. Write marker durably (§7.1.3).
 *   5. Build payload + submit both sides (T-C1 via submitPointer).
 *   6. Map SubmitOutcome → PublishOutcome, handling §7.4 backoff + retries
 *      within this attempt's scope (retry_after, retry_backoff, retry_side,
 *      retry_both). The caller (reconcile-algorithm.ts) handles cross-version
 *      retries on conflict / REJECTED / BLOCKED.
 *   7. On success (or H8 v-burning rejection): persist localVersion, clear
 *      marker atomically per §7.1.6.
 *   8. On classifiable blocking errors: maybeSetBlocked.
 *   9. Release mutex (LIFO: file lock then in-process mutex).
 *
 * This module owns the §7.3 state-machine interpretation but does NOT own
 * cross-version reconciliation — that is reconcile-algorithm.ts's job.
 */

import type { AggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js';

import { submitPointer, type SubmitOutcome } from './aggregator-submit.js';
import { isBlocked, maybeSetBlocked } from './blocked-state.js';
import {
  MAX_CUMULATIVE_RETRY_AFTER_MS,
  PUBLISH_BACKOFF_BASE_MS,
  PUBLISH_BACKOFF_JITTER_HI,
  PUBLISH_BACKOFF_JITTER_LO,
  PUBLISH_BACKOFF_MAX_MS,
  PUBLISH_RETRY_BUDGET,
} from './constants.js';
import { AggregatorPointerError, AggregatorPointerErrorCode } from './errors.js';
import type { FlagStore } from './flag-store.js';
import type { PointerKeyMaterial } from './key-derivation.js';
import { clearMarker, readMarker, resolvePublishVersion, writeMarker } from './marker.js';
import type { MutexHandle, PointerMutex } from './mutex-lock.js';
import type { PointerSigner } from './signing.js';
import type { PointerVersion } from './types.js';

// ── Public types ───────────────────────────────────────────────────────────

export interface PublishInput {
  /** CID byte-string to publish. */
  readonly cidBytes: Uint8Array;
  /** Target candidate version (caller may have computed this via H4 max(validV, includedV)+1). */
  readonly candidateV: PointerVersion;
  /** Current local version (from `profile.pointer.version` storage). */
  readonly currentLocalVersion: PointerVersion;
  /** HKDF-derived key material. */
  readonly keyMaterial: PointerKeyMaterial;
  /** Signing service wrapper. */
  readonly signer: PointerSigner;
  /** Aggregator client (MUST come from OracleProvider.getAggregatorClient()). */
  readonly aggregatorClient: AggregatorClient;
  /** Flag store (per-wallet durable key-value for marker, blocked, etc.). */
  readonly flagStore: FlagStore;
  /** Publish mutex (cross-tab / cross-process). */
  readonly mutex: PointerMutex;
  /**
   * Callback invoked with the persisted version after a successful publish.
   * Caller wires this to `storage.write('profile.pointer.version', v)` per §7.1.6.
   */
  readonly persistLocalVersion: (v: PointerVersion) => Promise<void>;
  /** Optional mutex acquisition timeout. Defaults to 30_000ms. */
  readonly mutexTimeoutMs?: number;
}

export type PublishOutcome =
  /** Happy path: both sides committed (or idempotent replay). */
  | { readonly kind: 'success'; readonly v: PointerVersion; readonly idempotent: boolean }
  /**
   * Another device raced us — caller must invoke reconcile-algorithm which will
   * discover V_true, fetchAndJoin, advance localVersion, retry at new nextV.
   */
  | { readonly kind: 'conflict'; readonly v: PointerVersion };

/** Options for the intra-attempt retry loop inside publishOnce. */
interface AttemptOptions {
  /**
   * Maximum number of budget-consuming retry iterations to run INSIDE a single
   * publishOnce call (applies to retry_backoff + retry_side + retry_both).
   * retry_after iterations do NOT consume this budget (SPEC row 10).
   *
   * Default = PUBLISH_RETRY_BUDGET (5). Reconcile-algorithm passes its own
   * remaining budget here to keep the total attempts bounded.
   */
  readonly maxRetries: number;
}

// ── Backoff helper (§7.4) ──────────────────────────────────────────────────

/**
 * Jittered exponential backoff per SPEC §7.4:
 *   backoff(n) = min(MAX_MS, BASE_MS * 2^n) * uniform(JITTER_LO, JITTER_HI)
 *
 * n is the 0-indexed retry count. Non-cryptographic RNG is acceptable.
 */
function computeBackoffMs(n: number): number {
  const expo = Math.min(PUBLISH_BACKOFF_MAX_MS, PUBLISH_BACKOFF_BASE_MS * 2 ** n);
  const jitter = PUBLISH_BACKOFF_JITTER_LO + Math.random() * (PUBLISH_BACKOFF_JITTER_HI - PUBLISH_BACKOFF_JITTER_LO);
  return Math.round(expo * jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── publishOnce ────────────────────────────────────────────────────────────

/**
 * Internal: run one publish attempt at a fixed version `v` with the §7.3
 * state-machine + §7.4 retry loop for transient failures.
 *
 * Returns a PublishOutcome describing the final classification for THIS v.
 * Caller (publish()) handles the mutex, marker, and localVersion
 * persistence around this function.
 *
 * Throws AggregatorPointerError for:
 *   - REJECTED (row 9, H8 v-burn — caller persists localVersion=v anyway)
 *   - AGGREGATOR_REJECTED (row 12, permanent fail)
 *   - PROTOCOL_ERROR (rows 14, 15 — fail closed)
 *   - RETRY_EXHAUSTED (budget exhausted within this attempt)
 *   - NETWORK_ERROR (after budget exhaustion on network path)
 */
async function publishOnce(
  input: PublishInput,
  v: PointerVersion,
  attemptOpts: AttemptOptions,
  isIdempotentRetryHintInitial: boolean,
  mutexHandle: MutexHandle,
): Promise<PublishOutcome> {
  const { cidBytes, keyMaterial, signer, aggregatorClient, flagStore } = input;

  let retriesConsumed = 0;
  let cumulativeRetryAfterMs = 0;

  // Steelman remediation (finding #7): read the marker ONCE before the
  // retry loop. Previously the marker was re-read on every iteration;
  // a torn IndexedDB write during a retry (Safari aggressive eviction)
  // would throw MARKER_CORRUPT mid-loop, burning the wallet to BLOCKED
  // even though an earlier iteration may have successfully committed.
  // The mutex is held throughout publishOnce, so no concurrent writer
  // can change the marker — re-reading inside the loop was strictly
  // redundant and unsafe.
  const marker = await readMarker(flagStore);

  // Steelman remediation (finding #5): `isIdempotentRetryHint` is load-
  // bearing for Row 4 vs Row 5 disambiguation. If a prior iteration of
  // this loop observed `retry_side` (one side committed, the other
  // had a transient network error), the subsequent iteration will see
  // EXISTS+EXISTS — that is OUR own commit replaying, not a genuine
  // cross-device conflict. We must escalate the hint to true once we
  // have observed partial success, to prevent spurious Row 5 conflict
  // classification + pointless fetchAndJoin of our own state.
  let isIdempotentRetryHint = isIdempotentRetryHintInitial;

  for (;;) {
    // Steelman remediation: verify the publish mutex is still held before
    // every submit. In browsers, BFCache/freeze/tab-discard can release
    // Web Locks while our async continuation is suspended; if we resume
    // and submit at a stale `v` another tab has already advanced past,
    // we violate mutual exclusion. assertHeld() throws PUBLISH_BUSY
    // if the lock is gone.
    mutexHandle.assertHeld();

    const outcome: SubmitOutcome = await submitPointer({
      v,
      cidBytes,
      keyMaterial,
      signer,
      aggregatorClient,
      marker,
      isIdempotentRetryHint,
    });

    switch (outcome.kind) {
      case 'success':
      case 'idempotent_replay':
        return { kind: 'success', v, idempotent: outcome.kind === 'idempotent_replay' };

      case 'conflict':
        return { kind: 'conflict', v };

      case 'rejected': {
        // H8 v-burning: caller persists localVersion=v, clears marker, SETs BLOCKED.
        const err = new AggregatorPointerError(
          AggregatorPointerErrorCode.REJECTED,
          `publish at v=${v}: aggregator rejected side=${outcome.failedSide} (${outcome.reason}). ` +
            `H8 v-burning — version ${v} permanently consumed.`,
          { v, failedSide: outcome.failedSide, reason: outcome.reason },
        );
        throw err;
      }

      case 'aggregator_rejected': {
        throw new AggregatorPointerError(
          AggregatorPointerErrorCode.AGGREGATOR_REJECTED,
          `publish at v=${v}: aggregator returned permanent 4xx — ${outcome.reason}`,
          { v, reason: outcome.reason },
        );
      }

      case 'protocol_error': {
        throw new AggregatorPointerError(
          AggregatorPointerErrorCode.PROTOCOL_ERROR,
          `publish at v=${v}: protocol error — ${outcome.reason}`,
          { v, reason: outcome.reason },
        );
      }

      case 'retry_after': {
        // Row 10 / 13: honor Retry-After. No budget consumption (SPEC §7.3 row 10).
        // Steelman: cumulative cap prevents a malicious aggregator from wedging
        // the mutex via unbounded Retry-After directives.
        cumulativeRetryAfterMs += outcome.retryAfterMs;
        if (cumulativeRetryAfterMs > MAX_CUMULATIVE_RETRY_AFTER_MS) {
          throw new AggregatorPointerError(
            AggregatorPointerErrorCode.RETRY_EXHAUSTED,
            `publish at v=${v}: cumulative retry_after ${cumulativeRetryAfterMs}ms ` +
              `exceeds cap ${MAX_CUMULATIVE_RETRY_AFTER_MS}ms. ` +
              `Aggregator is returning persistent Retry-After; giving up.`,
            { v, cumulativeRetryAfterMs },
          );
        }
        await sleep(outcome.retryAfterMs);
        continue;
      }

      case 'retry_backoff': {
        // Row 11: HTTP 5xx without Retry-After — exponential backoff + consume budget.
        if (retriesConsumed >= attemptOpts.maxRetries) {
          throw new AggregatorPointerError(
            AggregatorPointerErrorCode.RETRY_EXHAUSTED,
            `publish at v=${v}: exhausted retry budget (${attemptOpts.maxRetries}) on HTTP 5xx backoff.`,
            { v },
          );
        }
        await sleep(computeBackoffMs(retriesConsumed));
        retriesConsumed += 1;
        continue;
      }

      case 'retry_side':
      case 'retry_both': {
        // Rows 6, 7, 8: network-level failure on one or both sides.
        // We re-submit the whole v (aggregator idempotency on per-requestId
        // ensures the already-succeeded side is a no-op REQUEST_ID_EXISTS).
        if (retriesConsumed >= attemptOpts.maxRetries) {
          // Surface as NETWORK_ERROR — triggers the BLOCKED classifier.
          throw new AggregatorPointerError(
            AggregatorPointerErrorCode.NETWORK_ERROR,
            `publish at v=${v}: exhausted retry budget (${attemptOpts.maxRetries}) on network-error retry.`,
            { v },
          );
        }
        // Steelman remediation (finding #5): `retry_side` guarantees one
        // side committed (combineOutcomes Priority 6 excludes protocol/
        // rejected/aggregator_rejected/retry_after/backoff paths — by
        // the time we reach `retry_side` the non-flaky side must have
        // returned success or exists). Escalate the hint so the NEXT
        // iteration's EXISTS+EXISTS is classified as Row 4 idempotent
        // replay (our own commit) rather than Row 5 conflict. `retry_both`
        // is left alone — neither side committed.
        if (outcome.kind === 'retry_side') {
          isIdempotentRetryHint = true;
        }
        await sleep(computeBackoffMs(retriesConsumed));
        retriesConsumed += 1;
        continue;
      }
    }
  }
}

// ── Public entry: publish ──────────────────────────────────────────────────

/**
 * Execute one publish attempt at `candidateV`, wrapping it in the mutex +
 * marker + localVersion persistence discipline.
 *
 * This function is the single-version primitive invoked by reconcile-algorithm.
 * It does NOT handle cross-version conflict retry — a `conflict` outcome is
 * surfaced up so the caller can re-discover and target a new nextV.
 *
 * Callers MUST provide `persistLocalVersion` as the adapter to the outer
 * wallet-storage system — the pointer layer does not own `profile.pointer.version`.
 *
 * @throws AggregatorPointerError for BLOCKED, REJECTED, AGGREGATOR_REJECTED,
 *   PROTOCOL_ERROR, RETRY_EXHAUSTED, NETWORK_ERROR, and mutex PUBLISH_BUSY.
 */
export async function publishOnceAtVersion(
  input: PublishInput,
  attemptOpts: AttemptOptions = { maxRetries: PUBLISH_RETRY_BUDGET },
): Promise<PublishOutcome> {
  const { cidBytes, candidateV, currentLocalVersion, flagStore, mutex } = input;
  const mutexTimeoutMs = input.mutexTimeoutMs ?? 30_000;

  // Step 1: acquire mutex (§7.1.1). The mutex module already raises
  // PUBLISH_BUSY on timeout — let it propagate.
  const handle: MutexHandle = await mutex.acquire({ timeoutMs: mutexTimeoutMs });

  try {
    // Step 2: check BLOCKED (§10.2). A blocked wallet cannot publish until
    // CLEAR conditions are satisfied externally.
    const blocked = await isBlocked(flagStore);
    if (blocked.blocked) {
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.UNREACHABLE_RECOVERY_BLOCKED,
        `publish refused: wallet is in BLOCKED state (reason=${blocked.reason ?? 'unknown'}). ` +
          `Clear via recoverLatest() or acceptCarLoss() per SPEC §10.2.4.`,
        { reason: blocked.reason },
      );
    }

    // Step 3: resolve publish version via marker (§7.1.4 + H13 idempotent retry).
    // candidateV is the caller's H4 target (max(validV, includedV) + 1).
    // The marker may override (bump further) if crash-safety demands it.
    //
    // Steelman: a MARKER_CORRUPT error here MUST SET BLOCKED — per SPEC §13
    // clearPendingMarker contract, marker corruption forces the operator
    // through verified recovery before publish can resume.
    let resolution;
    try {
      resolution = await resolvePublishVersion(flagStore, currentLocalVersion, cidBytes, candidateV);
    } catch (err) {
      // maybeSetBlocked classifies MARKER_CORRUPT → 'marker_corrupt' internally.
      // Using the classifier (not a direct setBlocked) keeps the single
      // source of truth in blocked-state.ts.
      try { await maybeSetBlocked(flagStore, err); } catch { /* noop */ }
      throw err;
    }
    const resolvedV = resolution.v;

    // Step 4: write marker durably (§7.1.2, §7.1.3). Skip if this is an
    // idempotent retry (the marker is already persistent and matches).
    if (!resolution.isIdempotentRetry) {
      await writeMarker(flagStore, resolvedV, cidBytes);
    }

    // Step 5–6: submit + §7.3 state machine + §7.4 retry loop.
    // Pass isIdempotentRetry hint from resolvePublishVersion so submit can
    // correctly disambiguate row 4 (crash-retry idempotent) vs row 5
    // (cross-device conflict) — the pre-submit marker write would otherwise
    // always match the current cidBytes.
    let outcome: PublishOutcome;
    try {
      outcome = await publishOnce(input, resolvedV, attemptOpts, resolution.isIdempotentRetry, handle);
    } catch (submitErr) {
      // Steelman: on REJECTED (H8 v-burning), perform three bookkeeping steps:
      //   1) SET BLOCKED (classifier maps REJECTED → 'rejected' reason; operator alarm)
      //   2) Clear marker FIRST — a stale marker with a NOW-mismatched cidHash
      //      would trigger Case 4 OTP-safe bump on next publish, wasting a
      //      version. Clearing removes the ambiguity.
      //   3) Persist localVersion (H8 v-burn accounting) — must record that
      //      resolvedV is permanently consumed.
      //
      // Order (1 → 2 → 3) prefers SAFETY over storage consistency: even if
      // steps 2 or 3 fail, step 1 is the load-bearing alarm that forces the
      // operator through §10.2.4 verified recovery before publish resumes.
      //
      // Each step's failure is recorded on the thrown error's context so
      // callers / UIs / telemetry can surface partial-failure warnings
      // (closing the "silent swallow" hole from prior hardening pass).
      if (
        submitErr instanceof AggregatorPointerError &&
        submitErr.code === AggregatorPointerErrorCode.REJECTED
      ) {
        const bookkeeping: {
          blockedSet: boolean;
          markerCleared: boolean;
          localVersionPersisted: boolean;
          failures: string[];
        } = {
          blockedSet: false,
          markerCleared: false,
          localVersionPersisted: false,
          failures: [],
        };
        try {
          const reason = await maybeSetBlocked(flagStore, submitErr);
          bookkeeping.blockedSet = reason !== null;
          if (reason === null) {
            bookkeeping.failures.push('maybeSetBlocked returned null (classifier gap — REJECTED must map to a known reason)');
          }
        } catch (e) {
          bookkeeping.failures.push(`maybeSetBlocked threw: ${String(e)}`);
        }
        try {
          await clearMarker(flagStore);
          bookkeeping.markerCleared = true;
        } catch (e) {
          bookkeeping.failures.push(`clearMarker threw: ${String(e)}`);
        }
        try {
          await input.persistLocalVersion(resolvedV);
          bookkeeping.localVersionPersisted = true;
        } catch (e) {
          bookkeeping.failures.push(`persistLocalVersion threw: ${String(e)}`);
        }
        // Attach diagnostics to the thrown error so the caller / UI / telemetry
        // can surface partial-failure warnings. Using `details` (the existing
        // AggregatorPointerError field) rather than mutating a new field.
        (submitErr as unknown as { h8Bookkeeping?: typeof bookkeeping }).h8Bookkeeping = bookkeeping;
      } else {
        // On other aggregator/network errors, maybe SET BLOCKED (classifier
        // filters by category). Do NOT clear marker — next retry needs it.
        try { await maybeSetBlocked(flagStore, submitErr); } catch { /* noop */ }
      }
      throw submitErr;
    }

    if (outcome.kind === 'success') {
      // §7.1.6 atomicity: persist localVersion FIRST, then clear marker.
      // A crash between these leaves a stale marker that §7.1.4 compacts
      // correctly on next publish.
      await input.persistLocalVersion(outcome.v);
      await clearMarker(flagStore);
    }
    // On 'conflict', KEEP the marker — reconcile-algorithm will retry at a
    // new nextV, at which point resolvePublishVersion decides whether to
    // compact or carry forward.
    return outcome;
  } finally {
    // Step 9: release mutex (LIFO handled by MutexHandle.release).
    try {
      await handle.release();
    } catch {
      /* noop — release errors are observational only */
    }
  }
}

// Test-only exports.
export const __internal = {
  computeBackoffMs,
  publishOnce,
  sleep,
};
