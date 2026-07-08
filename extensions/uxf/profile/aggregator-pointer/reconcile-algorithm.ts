/**
 * Reconcile algorithm (T-D3) — SPEC §9.
 *
 * Wraps publishOnceAtVersion with cross-version conflict handling per §9.2:
 *
 *   publishWithConflictHandling(cidProducer, attempts = 0):
 *     if attempts >= PUBLISH_RETRY_BUDGET: raise RETRY_EXHAUSTED
 *     cid = cidProducer()
 *     { validV, includedV } = findLatestValidVersion()
 *     nextV = max(validV, includedV) + 1          // H4
 *     result = publish(cid, nextV)
 *     if result == 'success': return
 *     if result == 'conflict':
 *       re-discover, recoverLatest, fetchAndJoin remote, update localVersion
 *       sleep(backoff(attempts))
 *       recurse with attempts + 1
 *     else: propagate error
 *
 * R-14 reset semantics: the `attempts` counter counts CONFLICT-driven retries
 * only. Intra-attempt transient retries (retry_side, retry_backoff,
 * retry_after) are absorbed by publish-algorithm's inner loop and do NOT
 * consume reconcile's budget.
 */

import type { AggregatorClient, RootTrustBase } from '../../../../token-engine/sdk.js';

import { findLatestValidVersion, type DiscoverResult } from './discover-algorithm.js';
import type { CarFetcher, CidDecoder } from './aggregator-probe.js';
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
import type { PointerMutex } from './mutex-lock.js';
import { publishOnceAtVersion } from './publish-algorithm.js';
import type { PointerSigner } from './signing.js';
import type { PointerVersion } from './types.js';

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Callback invoked after discovering a new remote version during conflict
 * reconciliation. The pointer layer hands the caller the remote CID; caller
 * is responsible for the FULL conflict-merge sequence:
 *
 *   1. Fetch the CAR bytes from IPFS (with content-address verification).
 *   2. Merge the remote bundle into the local OrbitDB OpLog per §10.4
 *      JOIN rules (typically: write a bundle ref keyed by CID).
 *   3. Persist `profile.pointer.version = remoteVersion` (i.e. invoke the
 *      same `persistLocalVersion` callback the layer was constructed with).
 *
 * Step 3 was previously performed by `reconcileAndPublish` after the
 * callback returned. That created a "double persist" with the in-tree
 * production wiring (which already persists internally to enforce the
 * "bundle ref durable BEFORE cursor advance" ordering invariant
 * introduced in commit 561f551), and split ownership across two layers
 * for a single logical commit. We now make the callback the SOLE owner
 * of cursor advancement on the conflict path:
 *
 *   - `reconcileAndPublish` does NOT touch `persistLocalVersion` after
 *     the callback returns; it only advances the in-memory loop variable
 *     used to compute the next discovery's starting version.
 *   - The eventual successful publish in the next iteration persists
 *     `localVersion = nextV` via `publishOnceAtVersion` as before.
 *
 * Implementations MUST therefore call their `persistLocalVersion`
 * adapter (or equivalent storage write) as the LAST step on success,
 * AFTER the OrbitDB bundle ref has landed. Test harnesses whose fake
 * callback does not invoke `persistLocalVersion` will see the storage
 * cursor remain at its previous value across a conflict — that is now
 * the documented contract; the in-memory loop variable inside reconcile
 * tracks the advanced version for subsequent discovery so the next
 * publish still targets the correct `nextV`.
 *
 * The pointer layer does NOT own OrbitDB or IPFS fetch — those stay with
 * the Profile layer. This callback is the integration seam.
 */
export type FetchAndJoinCallback = (remoteCid: Uint8Array, remoteVersion: PointerVersion) => Promise<void>;

export interface ReconcileInput {
  /**
   * Called at the start of each (re)attempt to produce the CID bytes.
   * This lets the caller include any freshly-merged state from fetchAndJoin
   * in the bundle — crucial for H5 conflict semantics.
   */
  readonly cidProducer: () => Promise<Uint8Array>;
  /** Current local version (read from storage at reconcile start). */
  readonly currentLocalVersion: PointerVersion;
  /** HKDF-derived key material. */
  readonly keyMaterial: PointerKeyMaterial;
  /** Signing service. */
  readonly signer: PointerSigner;
  /** Aggregator client. */
  readonly aggregatorClient: AggregatorClient;
  /** Bundled RootTrustBase for proof verification. */
  readonly trustBase: RootTrustBase;
  /** Flag store. */
  readonly flagStore: FlagStore;
  /** Publish mutex. */
  readonly mutex: PointerMutex;
  /** CID decoder (injected by caller — pointer layer doesn't own multiformats). */
  readonly decodeCid: CidDecoder;
  /** CAR fetcher (injected — delegates to profile/ipfs-client). */
  readonly fetchCar: CarFetcher;
  /** fetchAndJoin callback (invoked on CONFLICT to merge remote state). */
  readonly fetchAndJoin: FetchAndJoinCallback;
  /** Persists localVersion after a successful publish. */
  readonly persistLocalVersion: (v: PointerVersion) => Promise<void>;
  /**
   * Resolves the CID bytes for a given pointer version. Used after
   * fetchAndJoin to determine the recovered state's CID before fetching.
   * Typically wraps recoverLatest() / classifyVersion's decoded CID.
   */
  readonly resolveRemoteCid: (version: PointerVersion) => Promise<Uint8Array>;
  /** Maximum reconcile attempts. Defaults to PUBLISH_RETRY_BUDGET. */
  readonly maxAttempts?: number;
  /**
   * Wave G.4: caller-supplied cancellation signal. Aborting unwinds
   * the reconcile loop at the next safe checkpoint (between iterations
   * or via the deadline race inside submit/probe). Propagated all the
   * way down through findLatestValidVersion → probeVersion →
   * fetchProofWithTimeout, and through publishOnceAtVersion →
   * submitPointer → submitOneSide.
   */
  readonly abortSignal?: AbortSignal;
}

export interface ReconcileOutcome {
  readonly kind: 'success';
  readonly v: PointerVersion;
  readonly attemptsUsed: number;
  readonly probeHistory: readonly PointerVersion[];
  /**
   * Versions skipped past during any Phase 3 walkback that ran within
   * this reconcile session (initial discovery on attempts ≥ 1, plus
   * conflict-driven rediscovery). Aggregated across all reconcile
   * iterations — a single reconcile with multiple conflicts may
   * accumulate skipped versions from each iteration's discovery.
   *
   * Empty when no CAR_TRANSIENT skip-past occurred or when all
   * discovery was via the fast-path (attempt 0, no walkback).
   *
   * Surfaced so `publishAggregatorPointerBestEffort` can emit a typed
   * `storage:pointer-version-skipped-unfetchable` event even on the
   * publish path (not just the recover path).
   */
  readonly walkbackUnfetchableSkipped: readonly PointerVersion[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

function computeBackoffMs(n: number): number {
  const expo = Math.min(PUBLISH_BACKOFF_MAX_MS, PUBLISH_BACKOFF_BASE_MS * 2 ** n);
  const jitter = PUBLISH_BACKOFF_JITTER_LO + Math.random() * (PUBLISH_BACKOFF_JITTER_HI - PUBLISH_BACKOFF_JITTER_LO);
  return Math.round(expo * jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * WALKBACK_FLOOR retry budget for `findLatestValidVersion` inside the
 * reconcile loop. The error fires when Phase 3 walkback would cross
 * below the wallet's `currentLocalVersion` — i.e., the aggregator's
 * currently-visible highest committed version is BELOW a version the
 * wallet has already confirmed as its own. The cause is eventual
 * consistency: the aggregator confirmed v=N at publish time, but a
 * fresh discovery query lands on a replica whose view hasn't caught
 * up yet. The condition is transient — once replication completes,
 * discovery sees v=N again.
 *
 * Retry with exponential backoff (reuses the existing PUBLISH_BACKOFF_*
 * schedule for consistency with the rest of the publish flow). With
 * BASE=250ms, MAX=4000ms, the schedule per attempt is
 *   250, 500, 1000, 2000, 4000, 4000, 4000ms
 * (jittered by [0.5, 1.5]×). Seven attempts sum to ~15.75s of total
 * backoff — chosen to ride out the routine testnet replication-lag
 * window (issue #241 reports stalls of several seconds at sustained
 * write rate; 5 attempts at ~7.75s proved insufficient under load).
 * Past this budget the error propagates as a typed WALKBACK_FLOOR; the
 * lifecycle layer catches the transient and emits a typed
 * `storage:replica-lag` event so operators can distinguish it from
 * generic transients in monitoring, then stamps `pendingPublishCid`
 * for the next flush / pointer poll to re-attempt.
 *
 * Issue #241 (B): even when this budget is exhausted, the at-least-
 * once Nostr gate is no longer held closed — pin durability is the
 * cross-device recoverability invariant; the aggregator publish is a
 * liveness optimization that retries asynchronously. This budget thus
 * bounds the latency cost of attempting to ride out lag in-band; the
 * old correctness pressure that required holding the publish mutex
 * "as long as it takes" is gone.
 */
const WALKBACK_FLOOR_RETRY_BUDGET = 7;

/**
 * Wrap `findLatestValidVersion` with a bounded retry loop specifically
 * for `AGGREGATOR_POINTER_WALKBACK_FLOOR`. All other discovery errors
 * (DISCOVERY_OVERFLOW, CAR_UNAVAILABLE, CORRUPT_STREAK, TRUST_BASE_STALE,
 * UNTRUSTED_PROOF, NETWORK_ERROR, abort, etc.) propagate UNCHANGED on
 * the first throw — they are NOT walkback-lag, so retrying them here
 * would just delay surfacing the real fault.
 *
 * Abort-aware: between retries we re-check the input's `abortSignal`
 * so a caller cancellation unwinds promptly instead of riding out the
 * full retry schedule.
 */
async function findLatestValidVersionWithWalkbackFloorRetry(
  callInput: Parameters<typeof findLatestValidVersion>[0],
  abortSignal: AbortSignal | undefined,
): Promise<DiscoverResult> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < WALKBACK_FLOOR_RETRY_BUDGET; attempt++) {
    if (abortSignal?.aborted) {
      const err = new Error('findLatestValidVersion aborted by caller');
      err.name = 'AbortError';
      throw err;
    }
    try {
      return await findLatestValidVersion(callInput);
    } catch (err) {
      lastError = err;
      const code =
        err instanceof AggregatorPointerError ? err.code : undefined;
      if (code !== AggregatorPointerErrorCode.WALKBACK_FLOOR) {
        // Not walkback-lag: surface immediately. Retrying these would
        // mask a real fault (overflow, corrupt streak, untrusted proof).
        throw err;
      }
      // Last attempt — don't sleep, just propagate.
      if (attempt === WALKBACK_FLOOR_RETRY_BUDGET - 1) break;
      await sleep(computeBackoffMs(attempt));
    }
  }
  // Budget exhausted — propagate the last WALKBACK_FLOOR so the
  // caller's outer retry path (Profile-TokenStorage's pending-publish
  // marker, or the periodic pointer poll) can take over.
  throw lastError;
}

// ── reconcileAndPublish ────────────────────────────────────────────────────

/**
 * Publish with conflict reconciliation per SPEC §9.2.
 *
 * This is the top-level primitive the public API (ProfilePointerLayer.publish)
 * invokes. It handles:
 *   - Discovery of V_true on each attempt (for fresh nextV)
 *   - Conflict-driven recursive retry with exponential backoff
 *   - fetchAndJoin integration on every conflict
 *   - PUBLISH_RETRY_BUDGET enforcement (RETRY_EXHAUSTED after 5 conflicts)
 *
 * @throws AggregatorPointerError for:
 *   - RETRY_EXHAUSTED after `maxAttempts` conflicts
 *   - Any non-conflict error from publishOnceAtVersion (REJECTED,
 *     AGGREGATOR_REJECTED, PROTOCOL_ERROR, NETWORK_ERROR,
 *     UNREACHABLE_RECOVERY_BLOCKED, PUBLISH_BUSY, TRUST_BASE_STALE,
 *     UNTRUSTED_PROOF, DISCOVERY_OVERFLOW, CAR_UNAVAILABLE,
 *     CORRUPT_STREAK, etc.)
 */
export async function reconcileAndPublish(input: ReconcileInput): Promise<ReconcileOutcome> {
  const maxAttempts = input.maxAttempts ?? PUBLISH_RETRY_BUDGET;
  const probeHistory: PointerVersion[] = [];
  // Aggregate CAR_TRANSIENT skip-past versions across all discovery iterations
  // within this reconcile session (slow-path discovery + conflict rediscovery).
  const walkbackUnfetchableSkipped: PointerVersion[] = [];

  // Track the EVOLVING localVersion across conflicts (fetchAndJoin updates it).
  let currentLocalVersion = input.currentLocalVersion;

  // Steelman⁴⁸ WARNING: compute ONE wall-clock deadline at the top
  // of reconcile and pass it into both findLatestValidVersion calls
  // (initial + rediscovery). Previously, each call derived its own
  // ~21-min default deadline, so PUBLISH_RETRY_BUDGET=5 × 2 calls/
  // attempt could occupy the publish mutex for up to ~3.5 hours.
  // The shared deadline gives the entire reconcile-and-publish a
  // single budget — saturated by the slowest discovery — and short-
  // circuits subsequent retries once it's gone.
  const RECONCILE_WALL_CLOCK_BUDGET_MS = 5 * 60 * 1000; // 5 minutes
  const reconcileDeadlineMs = Date.now() + RECONCILE_WALL_CLOCK_BUDGET_MS;

  for (let attempts = 0; attempts < maxAttempts; attempts++) {
    // Wave G.4: between-iteration abort checkpoint. The deeper RPC
    // races also respect the signal, but checking at the iteration
    // boundary lets us avoid starting fresh CID production /
    // discovery work after the caller has signalled cancellation.
    if (input.abortSignal?.aborted) {
      const err = new Error('reconcileAndPublish aborted by caller');
      err.name = 'AbortError';
      throw err;
    }
    // Step A: produce a fresh CID (may include state merged on prior conflict).
    const cidBytes = await input.cidProducer();

    // Step B: determine nextV.
    //
    // Issue #263 fast-path: attempt 0 SKIPS the discovery walkback (which
    // costs aggregator round-trip + IPFS CAR fetch per probed version)
    // and targets `currentLocalVersion + 1` directly. For the common
    // no-conflict case this saves ~30s of wall-clock per publish on a
    // healthy testnet. If the fast-path submit returns `conflict`, we
    // fall through to the same §9.2 rediscover + fetchAndJoin + retry
    // loop the always-walkback flow used; attempts >= 1 run the full
    // walkback discovery as before — preserving SPEC §8.2 conflict
    // semantics.
    //
    // Issue #264 — the sibling-broadcast plumbing that issue #263
    // originally added (`siblingHighestV` adoption into
    // `currentLocalVersion`) is INTENTIONALLY OMITTED. The
    // pointer-win broadcast pipeline is gated OFF by default and the
    // aggregator alone is the load-bearing convergence mechanism;
    // adopting a broadcast-derived version into `currentLocalVersion`
    // would leak into `publishOnceAtVersion → resolvePublishVersion`
    // and could silently clear legitimate crash-retry markers whose
    // H8 v-burn accounting is still load-bearing (SPEC §7.1.4 Case 2).
    //
    // Attempts >= 1 (SLOW PATH) run the standard SPEC §8.2 three-phase
    // walk. Discovery errors propagate unchanged (DISCOVERY_OVERFLOW,
    // CAR_UNAVAILABLE, CORRUPT_STREAK, TRUST_BASE_STALE, UNTRUSTED_PROOF),
    // except `AGGREGATOR_POINTER_WALKBACK_FLOOR` which is wrapped in a
    // bounded retry loop to ride out replica-lag windows.
    let nextV: PointerVersion;
    if (attempts === 0) {
      nextV = (currentLocalVersion + 1) as PointerVersion;
    } else {
      const discovery: DiscoverResult = await findLatestValidVersionWithWalkbackFloorRetry(
        {
          currentLocalVersion,
          keyMaterial: input.keyMaterial,
          signer: input.signer,
          aggregatorClient: input.aggregatorClient,
          trustBase: input.trustBase,
          decodeCid: input.decodeCid,
          fetchCar: input.fetchCar,
          discoveryDeadlineMs: reconcileDeadlineMs,
          abortSignal: input.abortSignal,
        },
        input.abortSignal,
      );
      probeHistory.push(...discovery.probeVersions);
      // Accumulate any CAR_TRANSIENT skip-past versions from this walkback pass.
      if (discovery.walkbackUnfetchableSkipped.length > 0) {
        walkbackUnfetchableSkipped.push(...discovery.walkbackUnfetchableSkipped);
      }
      nextV = (Math.max(discovery.validV, discovery.includedV) + 1) as PointerVersion;
    }

    // Step C: run one publish attempt at nextV.
    const outcome = await publishOnceAtVersion(
      {
        cidBytes,
        candidateV: nextV,
        currentLocalVersion,
        keyMaterial: input.keyMaterial,
        signer: input.signer,
        aggregatorClient: input.aggregatorClient,
        flagStore: input.flagStore,
        mutex: input.mutex,
        persistLocalVersion: input.persistLocalVersion,
        abortSignal: input.abortSignal,
      },
      { maxRetries: PUBLISH_RETRY_BUDGET },
    );

    if (outcome.kind === 'success') {
      return {
        kind: 'success',
        v: outcome.v,
        attemptsUsed: attempts + 1,
        probeHistory,
        walkbackUnfetchableSkipped,
      };
    }

    // outcome.kind === 'conflict' — another device published before us.
    //
    // §9.2 reconciliation:
    //   1. Re-discover V_true (it may have advanced again since step B).
    //   2. recoverLatest (=> validV CID).
    //   3. fetchAndJoin remote bundle — callback owns: fetch CAR + write
    //      bundle ref + persist `localVersion = validV` (in that order;
    //      see FetchAndJoinCallback doc). Reconcile only updates its
    //      in-memory loop variable for the next discovery's starting v.
    //   4. sleep(backoff), recurse.
    // Re-discovery failure during conflict reconciliation — propagate unchanged,
    // except for WALKBACK_FLOOR which retries through the helper (same
    // rationale as Step B: replication lag is transient).
    const rediscovery: DiscoverResult = await findLatestValidVersionWithWalkbackFloorRetry(
      {
        currentLocalVersion,
        keyMaterial: input.keyMaterial,
        signer: input.signer,
        aggregatorClient: input.aggregatorClient,
        trustBase: input.trustBase,
        decodeCid: input.decodeCid,
        fetchCar: input.fetchCar,
        discoveryDeadlineMs: reconcileDeadlineMs,
        abortSignal: input.abortSignal,
      },
      input.abortSignal,
    );
    probeHistory.push(...rediscovery.probeVersions);
    // Accumulate any CAR_TRANSIENT skip-past versions from conflict rediscovery.
    if (rediscovery.walkbackUnfetchableSkipped.length > 0) {
      walkbackUnfetchableSkipped.push(...rediscovery.walkbackUnfetchableSkipped);
    }

    if (rediscovery.validV > 0) {
      // Steelman: wrap the remote-fetch + join + persist block with a sleep
      // guard so a caller who immediately re-invokes publish() on throw
      // cannot hot-loop against the aggregator.
      //
      // Architect-review 2026-05-17 (PR #165): the callback OWNS the
      // cursor advance — it persists `localVersion = remoteVersion`
      // AFTER its bundle-ref write lands (see FetchAndJoinCallback
      // contract above and pointer-wiring.ts:buildFetchAndJoin). The
      // earlier double-call from reconcile was idempotent in production
      // (same value, same key) but split ownership of one logical
      // commit across two layers and masked the ordering invariant.
      // We now only update the in-memory loop variable here.
      try {
        const remoteCid = await input.resolveRemoteCid(rediscovery.validV);
        await input.fetchAndJoin(remoteCid, rediscovery.validV);
        currentLocalVersion = rediscovery.validV;
      } catch (err) {
        // Non-transient failures (IPFS unreachable, OrbitDB merge bug,
        // resolveRemoteCid classification flip) bubble out — but sleep
        // backoff first so the caller can't DDoS the aggregator.
        await sleep(computeBackoffMs(attempts));
        throw err;
      }
    } else if (rediscovery.includedV > currentLocalVersion) {
      // Conflict signaled by the aggregator, but rediscovery found NO valid
      // version AND the remote advanced past us into corrupt-only residue.
      // This is distinct from "no pointer ever published" (validV === 0 &&
      // includedV === 0). Signal the anomaly rather than looping silently
      // toward RETRY_EXHAUSTED.
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.CORRUPT_STREAK,
        `Reconcile: aggregator signaled conflict at v>${currentLocalVersion} but ` +
          `no valid version found (includedV=${rediscovery.includedV}, validV=0). ` +
          `Remote state is corrupt-only residue; operator may invoke ` +
          `acceptCorruptStreak(walkbackLimit) for extended walkback.`,
        { currentLocalVersion, includedV: rediscovery.includedV },
      );
    }

    // Backoff before next attempt (SPEC §7.4 / §9 sequencing).
    await sleep(computeBackoffMs(attempts));
  }

  throw new AggregatorPointerError(
    AggregatorPointerErrorCode.RETRY_EXHAUSTED,
    `Reconcile exhausted ${maxAttempts} conflict-retry attempts without landing a publish. ` +
      `Persistent multi-device contention at high frequency.`,
    { maxAttempts },
  );
}

// Test-only exports.
export const __internal = {
  computeBackoffMs,
  sleep,
  findLatestValidVersionWithWalkbackFloorRetry,
  WALKBACK_FLOOR_RETRY_BUDGET,
};
