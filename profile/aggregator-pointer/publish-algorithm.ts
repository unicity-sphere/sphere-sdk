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
import { isBlocked, maybeSetBlocked, setBlocked } from './blocked-state.js';
import {
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
/**
 * Maximum cumulative retry_after wait within a single publishOnce call.
 * Prevents a malicious or misconfigured aggregator from wedging the mutex
 * via unbounded Retry-After directives (DoS-by-aggregator).
 */
const MAX_CUMULATIVE_RETRY_AFTER_MS = 60_000;

async function publishOnce(
  input: PublishInput,
  v: PointerVersion,
  attemptOpts: AttemptOptions,
  isIdempotentRetryHint: boolean,
): Promise<PublishOutcome> {
  const { cidBytes, keyMaterial, signer, aggregatorClient, flagStore } = input;

  let retriesConsumed = 0;
  let cumulativeRetryAfterMs = 0;

  for (;;) {
    // Read current marker — submit needs it for row 4 marker-match disambiguation.
    const marker = await readMarker(flagStore);

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
      if (
        err instanceof AggregatorPointerError &&
        err.code === AggregatorPointerErrorCode.MARKER_CORRUPT
      ) {
        try {
          await setBlocked(flagStore, 'marker_corrupt');
        } catch { /* noop — setBlocked error is observational */ }
      }
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
      outcome = await publishOnce(input, resolvedV, attemptOpts, resolution.isIdempotentRetry);
    } catch (submitErr) {
      // Steelman: on REJECTED (H8 v-burning), perform the three bookkeeping
      // steps in SAFETY-FIRST order: SET BLOCKED first (operator's alarm
      // signal), then persist localVersion, then clearMarker. Each step is
      // independently wrapped so a disk-full / quota error in one doesn't
      // silently skip the others.
      if (
        submitErr instanceof AggregatorPointerError &&
        submitErr.code === AggregatorPointerErrorCode.REJECTED
      ) {
        // 1) SET BLOCKED first — operator MUST see the alarm even if
        //    downstream storage writes fail.
        try { await maybeSetBlocked(flagStore, submitErr); } catch { /* noop */ }
        // 2) Persist localVersion (H8 v-burn accounting). A failure here
        //    is surfaced; marker.ts's stale-compact path covers the
        //    marker-ahead-of-localVersion case on next publish.
        try { await input.persistLocalVersion(resolvedV); } catch { /* noop */ }
        // 3) Clear marker.
        try { await clearMarker(flagStore); } catch { /* noop */ }
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
