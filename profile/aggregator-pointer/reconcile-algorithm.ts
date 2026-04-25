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

import type { AggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js';
import type { RootTrustBase } from '@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase.js';

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
 * is responsible for:
 *   - Fetching the CAR bytes from IPFS (with content-address verification)
 *   - Merging the remote bundle into the local OrbitDB OpLog per §10.4 JOIN rules
 *   - Persisting any derived state updates
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
}

export interface ReconcileOutcome {
  readonly kind: 'success';
  readonly v: PointerVersion;
  readonly attemptsUsed: number;
  readonly probeHistory: readonly PointerVersion[];
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

  // Track the EVOLVING localVersion across conflicts (fetchAndJoin updates it).
  let currentLocalVersion = input.currentLocalVersion;

  for (let attempts = 0; attempts < maxAttempts; attempts++) {
    // Step A: produce a fresh CID (may include state merged on prior conflict).
    const cidBytes = await input.cidProducer();

    // Step B: discover V_true and target nextV = max(validV, includedV) + 1 (H4).
    // Discovery errors propagate unchanged (DISCOVERY_OVERFLOW, CAR_UNAVAILABLE,
    // CORRUPT_STREAK, TRUST_BASE_STALE, UNTRUSTED_PROOF). Reconcile cannot
    // make progress without a valid V_true.
    const discovery: DiscoverResult = await findLatestValidVersion({
      currentLocalVersion,
      keyMaterial: input.keyMaterial,
      signer: input.signer,
      aggregatorClient: input.aggregatorClient,
      trustBase: input.trustBase,
      decodeCid: input.decodeCid,
      fetchCar: input.fetchCar,
    });
    probeHistory.push(...discovery.probeVersions);
    const nextV = (Math.max(discovery.validV, discovery.includedV) + 1) as PointerVersion;

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
      },
      { maxRetries: PUBLISH_RETRY_BUDGET },
    );

    if (outcome.kind === 'success') {
      return {
        kind: 'success',
        v: outcome.v,
        attemptsUsed: attempts + 1,
        probeHistory,
      };
    }

    // outcome.kind === 'conflict' — another device published before us.
    //
    // §9.2 reconciliation:
    //   1. Re-discover V_true (it may have advanced again since step B).
    //   2. recoverLatest (=> validV CID).
    //   3. fetchAndJoin remote bundle.
    //   4. Persist localVersion = validV.
    //   5. sleep(backoff), recurse.
    // Re-discovery failure during conflict reconciliation — propagate unchanged.
    const rediscovery: DiscoverResult = await findLatestValidVersion({
      currentLocalVersion,
      keyMaterial: input.keyMaterial,
      signer: input.signer,
      aggregatorClient: input.aggregatorClient,
      trustBase: input.trustBase,
      decodeCid: input.decodeCid,
      fetchCar: input.fetchCar,
    });
    probeHistory.push(...rediscovery.probeVersions);

    if (rediscovery.validV > 0) {
      // Steelman: wrap the remote-fetch + join + persist block with a sleep
      // guard so a caller who immediately re-invokes publish() on throw
      // cannot hot-loop against the aggregator.
      try {
        const remoteCid = await input.resolveRemoteCid(rediscovery.validV);
        await input.fetchAndJoin(remoteCid, rediscovery.validV);
        await input.persistLocalVersion(rediscovery.validV);
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
};
