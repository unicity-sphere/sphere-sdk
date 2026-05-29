/**
 * Discover algorithm (T-D2) — SPEC §8.2 three-phase walk.
 *
 *   Phase 1 — exponential expansion via probeVersion (H2 OR-predicate)
 *             from localVersion upward; doubles until probe returns false
 *             or hits DISCOVERY_HARD_CEILING (→ DISCOVERY_OVERFLOW).
 *
 *   Phase 2 — binary search between lo (last included) and hi (first
 *             excluded) → converges to includedV = latest-included version.
 *
 *   Phase 3 — walk back through SEMANTICALLY_INVALID versions via
 *             classifyVersion (H1 four-way). CAR_TRANSIENT versions
 *             (slot EXISTS on-chain but CAR unreachable) are SKIPPED
 *             PAST by default (`skipUnfetchableInWalkback`):
 *             a slot whose proof is authentic but whose CAR cannot be
 *             fetched (404 / network failure / persistent-unavailable)
 *             is treated as walked-past, indistinguishable from
 *             SEMANTICALLY_INVALID for the purpose of finding the
 *             latest VALID predecessor. The skipped versions are
 *             recorded in `walkbackUnfetchableSkipped` for operator
 *             observability — the lifecycle layer emits a typed event
 *             when `recoverLatest()` surfaces them, so monitoring can
 *             surface the data-loss window without requiring the wallet
 *             to be blocked.
 *
 *             PROOF_TRANSIENT versions (aggregator proof RPC failed —
 *             slot existence UNKNOWN) are NEVER skipped-past regardless
 *             of `skipUnfetchableInWalkback`. Walking past a slot whose
 *             existence we haven't verified would silently corrupt the
 *             walkback. Phase 3 treats PROOF_TRANSIENT as a hard stop
 *             and throws CAR_UNAVAILABLE (same as the SPEC-strict path).
 *
 *             SPEC-strict mode (legacy / strict consumers): pass
 *             `skipUnfetchableInWalkback: false` to restore the
 *             SPEC §13 / §10.7 behavior — CAR_TRANSIENT in Phase 3
 *             also throws CAR_UNAVAILABLE so the caller can invoke
 *             the operator-driven `acceptCarLoss(version)` flow after
 *             the persistent-retry window.
 *
 *             Bail after DISCOVERY_CORRUPT_WALKBACK consecutive
 *             non-VALID versions (→ CORRUPT_STREAK), counting both
 *             SEMANTICALLY_INVALID and (when skipped) UNFETCHABLE.
 *
 * Returns { validV, includedV, probeVersions, walkbackUnfetchableSkipped }.
 *
 * W7 walkback floor: when an `acceptCorruptStreak(walkbackLimit)` override
 * raises the walkback ceiling, the effective floor MUST NOT cross below
 * localVersion — crossing below would walk past versions this wallet has
 * already confirmed as its own.
 *
 * ## Why `skipUnfetchableInWalkback` defaults to `true`
 *
 * A pointer slot that EXISTS (proof-included on the aggregator) but whose
 * snapshot CID is unreachable on every configured IPFS gateway represents
 * a real failure mode in production wallets:
 *
 *   - A prior publish landed the proof but the IPFS pin was lost
 *     (operator gateway pruned the bundle, gateway DNS migration left
 *     orphan content, gateway operator decommissioned).
 *   - The 404 is durable — every retry of every gateway returns the
 *     same 404; no amount of "retry later" rescues it.
 *
 * Under the legacy SPEC-strict semantic, `recoverLatest()` THROWS
 * CAR_UNAVAILABLE at the broken version and the wallet has no recovery
 * surface short of operator intervention. The publish path also fails on
 * conflict-driven rediscovery for the same reason. The wallet becomes
 * effectively bricked even though the on-aggregator proof history is
 * intact and the wallet's PRIOR versions are still fetchable.
 *
 * The skip-past semantic preserves the distinction between:
 *   - ABSENT (no probe match)            — true gap, walkback continues
 *                                          past this slot only if Phase 2
 *                                          located includedV above it
 *   - SEMANTICALLY_INVALID (corrupt)     — walked past, counts toward
 *                                          DISCOVERY_CORRUPT_WALKBACK
 *   - CAR_TRANSIENT (EXISTS-BUT-UNFETCHABLE)
 *                                        — walked past (same as
 *                                          SEMANTICALLY_INVALID for
 *                                          discovery purposes), counts
 *                                          toward walkback budget, AND
 *                                          recorded in
 *                                          walkbackUnfetchableSkipped so
 *                                          the caller emits an event for
 *                                          monitoring
 *   - PROOF_TRANSIENT (proof RPC failed) — HARD STOP regardless of
 *                                          skipUnfetchableInWalkback;
 *                                          slot existence UNKNOWN, must
 *                                          not be skipped
 *
 * For PUBLISH `nextV` computation:
 * - `includedV` (the highest INCLUDED slot from Phase 2) is unchanged
 *   by the skip-past behavior. Phase 2 uses `probeVersion` (H2
 *   OR-predicate) which does NOT fetch CARs — only proofs. So even an
 *   UNFETCHABLE slot is correctly counted as "included" for the purpose
 *   of computing `nextV = max(validV, includedV) + 1`.
 * - The skip-past therefore does NOT cause a new publish to overwrite or
 *   collide with the broken prior slot. The new publish supersedes
 *   normally at the next available version.
 *
 * For FETCH-AND-JOIN (cold-start recovery, periodic poll):
 * - `recoverLatest()` returns the latest VALID — the skip-past gives the
 *   wallet a fetchable predecessor instead of blocking entirely.
 * - The fetch-and-join applier (factory closure) fetches the snapshot
 *   CAR at the recovered version's CID. Because the recovered version
 *   is the latest VALID predecessor (CAR was content-address verified
 *   during Phase 3 classify), this fetch SHOULD succeed — but the
 *   applier itself is already best-effort in the lifecycle layer
 *   (`recoverFromAggregatorPointerBestEffort` logs + returns true on
 *   apply failure, so the next periodic poll retries). The data-loss
 *   window is the entries that lived ONLY in the unfetchable slot(s);
 *   the wallet retains everything that survived in the recovered
 *   predecessor and in the OrbitDB peer-to-peer log.
 *
 * Security model: pointer slots are signed by the wallet's own pointer
 * key. A malicious aggregator cannot forge proofs at versions we have
 * not authored. A malicious gateway can already serve a 404. The new
 * semantic does not expand the attacker surface — it expands the
 * recovery surface for the wallet user.
 */

import type { AggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js';
import type { RootTrustBase } from '@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase.js';

import {
  classifyVersion,
  probeVersion,
  type CarFetcher,
  type CidDecoder,
} from './aggregator-probe.js';
import { pickEpochFloor, shouldSkipForEpochFloor } from './epoch-floor.js';
import {
  DISCOVERY_CORRUPT_WALKBACK,
  DISCOVERY_HARD_CEILING,
  DISCOVERY_INITIAL_VERSION,
  PROBE_REQUEST_TIMEOUT_MS,
  VERSION_MAX,
} from './constants.js';
import { AggregatorPointerError, AggregatorPointerErrorCode } from './errors.js';
import type { PointerKeyMaterial } from './key-derivation.js';
import type { PointerSigner } from './signing.js';
import type { PointerVersion } from './types.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface DiscoverInput {
  readonly currentLocalVersion: PointerVersion;
  readonly keyMaterial: PointerKeyMaterial;
  readonly signer: PointerSigner;
  readonly aggregatorClient: AggregatorClient;
  readonly trustBase: RootTrustBase;
  readonly decodeCid: CidDecoder;
  readonly fetchCar: CarFetcher;
  /** Per-request timeout. Defaults to PROBE_REQUEST_TIMEOUT_MS. */
  readonly timeoutMs?: number;
  /**
   * Walkback ceiling override (W6 / acceptCorruptStreak). Defaults to
   * DISCOVERY_CORRUPT_WALKBACK. When > DISCOVERY_CORRUPT_WALKBACK, this
   * indicates the caller invoked acceptCorruptStreak; W7 floor check runs.
   */
  readonly walkbackLimit?: number;
  /**
   * Absolute wall-clock deadline (Date.now() epoch ms) for the entire
   * discovery operation across all three phases. Defaults to a computed
   * upper bound based on PROBE_REQUEST_TIMEOUT_MS and phase iteration limits.
   * Provide a tighter value when the caller holds a mutex with a hard timeout.
   */
  readonly discoveryDeadlineMs?: number;
  /**
   * Wave G.4: caller-supplied cancellation signal. Combined with the
   * internal deadline-driven abort, an external abort short-circuits
   * the in-flight probe RPC immediately rather than letting it run
   * to its per-request timeout.
   */
  readonly abortSignal?: AbortSignal;
  /**
   * Issue #310 — OpLog epoch-floor inspector. Given a Phase-3
   * candidate that classified as VALID, return its snapshot's
   * `epoch` (or undefined for pre-#310 snapshots).
   *
   * Default behavior (callback omitted): epoch-floor walkback is
   * DISABLED. Every VALID candidate is treated as `epoch = 0` —
   * backwards-compatible with pre-#310 SDKs.
   *
   * When supplied, Phase 3 consults this callback on every VALID
   * candidate, tracks the running max epoch as a floor, and SKIPS
   * candidates whose snapshot's epoch is strictly below the floor.
   *
   * On throw, the candidate is treated as SEMANTICALLY_INVALID
   * (skip + walk back, count toward budget).
   */
  readonly inspectSnapshotEpoch?: (
    v: PointerVersion,
    cidBytes: Uint8Array,
  ) => Promise<number | undefined> | number | undefined;
  /**
   * Issue #310 — initial epoch floor before Phase 3 begins. Defaults
   * to 0. Set to the wallet's last-applied snapshot epoch so an
   * aggregator that still serves a pre-reset pointer cannot trick
   * the wallet into walking back to it.
   */
  readonly initialEpochFloor?: number;
  /**
   * Phase 3 walkback policy for `CAR_TRANSIENT` versions (slot EXISTS
   * on-chain — proof verified + CID decoded — but CAR is unreachable).
   *
   * Defaults to `true` (skip-past): a CAR_TRANSIENT slot is treated as
   * walked-past — Phase 3 continues looking for an older VALID predecessor
   * instead of throwing CAR_UNAVAILABLE. The skipped versions are recorded
   * in `walkbackUnfetchableSkipped` for operator observability.
   *
   * Note: `PROOF_TRANSIENT` versions (aggregator proof RPC failed — slot
   * existence UNKNOWN) are NEVER skipped-past regardless of this flag.
   * They always halt Phase 3 with CAR_UNAVAILABLE. The policy only
   * applies to `CAR_TRANSIENT` (slot provably exists, only bytes
   * unavailable).
   *
   * Pass `false` to restore SPEC §13 / §10.7 strict behavior:
   * CAR_TRANSIENT in Phase 3 also throws CAR_UNAVAILABLE so the caller
   * can invoke the operator-driven `acceptCarLoss(version)` flow.
   *
   * Rationale for the default: see the file-header comment block.
   */
  readonly skipUnfetchableInWalkback?: boolean;
}

export interface DiscoverResult {
  /** Latest VALID version (0 if no pointer ever published). */
  readonly validV: PointerVersion;
  /** Latest INCLUDED version (Phase 2 result — may be corrupt residue). */
  readonly includedV: PointerVersion;
  /**
   * List of (v, side) probe-pairs visited during all three phases.
   * Deterministic for a given { localVersion, V_true, corrupt-version set }.
   * Used by getProbeFingerprint() for UI clustering signal.
   */
  readonly probeVersions: readonly PointerVersion[];
  /**
   * Versions visited during Phase 3 walkback whose `classifyVersion`
   * returned `CAR_TRANSIENT` and were skipped past (only when
   * `skipUnfetchableInWalkback !== false`). Empty when no such versions
   * were walked, when SPEC-strict mode was requested, or when Phase 3
   * never ran.
   *
   * Note: `PROOF_TRANSIENT` versions (aggregator proof RPC failed —
   * slot existence UNKNOWN) are NEVER skipped; they halt the walkback
   * with CAR_UNAVAILABLE even in default mode. Only `CAR_TRANSIENT`
   * versions (proof verified, CID decoded, CAR unreachable) appear here.
   *
   * Surfaced to callers so they can emit a typed event
   * (`storage:pointer-version-skipped-unfetchable`) for monitoring,
   * even though discovery itself proceeds without blocking.
   *
   * A version listed here has these properties:
   *   - Inclusion proof was authentic (proof verify OK).
   *   - XOR-decode produced a parseable CID.
   *   - The CAR at that CID was NOT fetchable from any gateway
   *     (transient or persistent — Phase 3 treats them identically
   *     under the skip-past policy).
   *
   * Versions listed here are NOT VALID for `recoverLatest()` purposes;
   * the wallet will receive a strictly-older VALID predecessor (or null)
   * if such a version exists.
   */
  readonly walkbackUnfetchableSkipped: readonly PointerVersion[];
  /**
   * Issue #310 — versions skipped because their snapshot epoch was
   * strictly below the running floor. Empty when `inspectSnapshotEpoch`
   * is not wired, when no candidate fell below the floor, or when
   * Phase 3 never ran.
   */
  readonly walkbackEpochSkipped: readonly PointerVersion[];
  /**
   * Issue #310 — final epoch floor observed by Phase 3 walkback. The
   * `max(epoch)` across all Phase-3 candidates whose CARs the wallet
   * successfully inspected, primed with `initialEpochFloor`.
   */
  readonly pickedEpoch: number;
}

// ── findLatestValidVersion ─────────────────────────────────────────────────

export async function findLatestValidVersion(input: DiscoverInput): Promise<DiscoverResult> {
  // Wave G.4: small wrapper that ensures the external-abort listener
  // is removed on every exit path (success, throw, abort). Without
  // this, a long-lived caller signal would leak a closure-reference
  // per discovery call.
  let cleanupExternalListener: (() => void) | undefined;
  try {
    return await findLatestValidVersionInner(input, (fn) => {
      cleanupExternalListener = fn;
    });
  } finally {
    if (cleanupExternalListener) cleanupExternalListener();
  }
}

async function findLatestValidVersionInner(
  input: DiscoverInput,
  registerCleanup: (fn: () => void) => void,
): Promise<DiscoverResult> {
  const {
    currentLocalVersion,
    keyMaterial,
    signer,
    aggregatorClient,
    trustBase,
    decodeCid,
    fetchCar,
  } = input;
  const timeoutMs = input.timeoutMs ?? PROBE_REQUEST_TIMEOUT_MS;
  // Steelman¹⁹ warning: hard cap walkbackLimit so that arithmetic in the
  // deadline calculation cannot overflow to Infinity (which would silently
  // disable the deadline gate). The 4096 cap matches the SPEC §13
  // acceptCorruptStreak documented ceiling and is enforced here as the
  // arithmetic limit; callers passing larger values (or non-integers,
  // negatives, NaN) get a clean PROTOCOL_ERROR rather than a stealthy
  // unbounded deadline.
  const WALKBACK_HARD_CEILING = 4096;
  const requestedWalkback = input.walkbackLimit ?? DISCOVERY_CORRUPT_WALKBACK;
  if (
    !Number.isInteger(requestedWalkback) ||
    requestedWalkback < 0 ||
    requestedWalkback > WALKBACK_HARD_CEILING
  ) {
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.PROTOCOL_ERROR,
      `Discovery: walkbackLimit must be an integer in [0, ${WALKBACK_HARD_CEILING}], got ${String(requestedWalkback)}.`,
      { walkbackLimit: requestedWalkback },
    );
  }
  const walkbackLimit = requestedWalkback;
  // Steelman¹⁸: bound total discovery time so the mutex is not held forever.
  // Default upper bound: phase ceilings × per-request timeout.
  //   Phase 1: log2(HARD_CEILING / INITIAL) ≈ 12 + Phase 2: 22 ≈ 34 probes
  //   Phase 3: walkbackLimit probes
  // Each probe allows up to timeoutMs. An extra 2× factor absorbs backoff.
  const defaultDeadline =
    Date.now() + (34 + walkbackLimit) * timeoutMs * 2;
  const discoveryDeadlineMs = input.discoveryDeadlineMs ?? defaultDeadline;
  // Steelman⁴⁹ NOTE: track the START time independent of the deadline
  // so error messages report elapsed time correctly even when the
  // caller supplied an external `discoveryDeadlineMs` (e.g.,
  // reconcile's shared budget). The previous arithmetic assumed the
  // deadline was derived from the local default.
  const discoveryStartMs = Date.now();

  const checkDeadline = (): void => {
    if (Date.now() > discoveryDeadlineMs) {
      // Wave G.2: also abort any in-flight probe RPC. Without this,
      // the throw below propagates immediately but a probe that's
      // mid-RPC continues to the wire and consumes resources.
      armDeadlineAbort();
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.RETRY_EXHAUSTED,
        `Discovery exceeded wall-clock deadline after ${Date.now() - discoveryStartMs}ms.`,
        { currentLocalVersion },
      );
    }
  };

  // Wave F.2 security advisory MEDIUM-2 remediation: assert currentLocalVersion
  // is within the discovery search space. A locally-corrupted cache that
  // wrote `localVersion >= DISCOVERY_HARD_CEILING` would force Phase 1 to
  // probe at-or-above the ceiling on the very first iteration, leaking
  // information through the noisy probe pattern. Fail-fast with PROTOCOL_ERROR
  // so storage corruption surfaces clearly instead of as an opaque
  // DISCOVERY_OVERFLOW.
  if (
    !Number.isInteger(currentLocalVersion) ||
    currentLocalVersion < 0 ||
    currentLocalVersion >= DISCOVERY_HARD_CEILING
  ) {
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.PROTOCOL_ERROR,
      `Discovery: currentLocalVersion=${currentLocalVersion} is outside [0, ${DISCOVERY_HARD_CEILING}). ` +
        `Local cache likely corrupted. Run \`pointer recover\` after investigating storage integrity.`,
      { currentLocalVersion, hardCeiling: DISCOVERY_HARD_CEILING },
    );
  }

  // Wave G.2: thread an AbortController so the wall-clock deadline
  // can cancel an in-flight probe RPC. Previously the deadline check
  // fired only BETWEEN probes; an RPC stuck for the full
  // PROBE_REQUEST_TIMEOUT_MS could blow past the deadline by up to
  // that amount. The abort signal lets the deadline interrupt the
  // active probe immediately.
  // Wave G.4: also bridge an externally-supplied abortSignal so the
  // caller can cancel discovery from above. If the external signal
  // is already aborted, fail fast.
  const discoveryAbort = new AbortController();
  let externalDiscoveryAbortListener: (() => void) | undefined;
  if (input.abortSignal) {
    if (input.abortSignal.aborted) {
      try {
        discoveryAbort.abort();
      } catch {
        /* noop */
      }
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.RETRY_EXHAUSTED,
        'Discovery aborted by caller',
        { currentLocalVersion },
      );
    }
    externalDiscoveryAbortListener = (): void => {
      try {
        discoveryAbort.abort();
      } catch {
        /* noop */
      }
    };
    input.abortSignal.addEventListener('abort', externalDiscoveryAbortListener, { once: true });
    const sigCaptured = input.abortSignal;
    const listenerCaptured = externalDiscoveryAbortListener;
    registerCleanup(() => {
      try {
        sigCaptured.removeEventListener('abort', listenerCaptured);
      } catch {
        /* noop */
      }
    });
  }
  const armDeadlineAbort = (): void => {
    if (Date.now() > discoveryDeadlineMs && !discoveryAbort.signal.aborted) {
      try {
        discoveryAbort.abort();
      } catch {
        /* abort() never throws on a fresh controller; defense-in-depth */
      }
    }
  };

  const probeVersions: PointerVersion[] = [];
  // Phase 3: track versions skipped under the EXISTS-BUT-UNFETCHABLE
  // policy (default-on; see file-header). Empty when SPEC-strict mode
  // (`skipUnfetchableInWalkback === false`) was requested or when Phase 3
  // never encountered an unfetchable slot.
  const walkbackUnfetchableSkipped: PointerVersion[] = [];
  const skipUnfetchable = input.skipUnfetchableInWalkback !== false;

  // Issue #310 — epoch-floor tracking. Disabled when
  // `inspectSnapshotEpoch` is not provided.
  const walkbackEpochSkipped: PointerVersion[] = [];
  let epochFloor = (() => {
    const initial = input.initialEpochFloor ?? 0;
    if (
      typeof initial !== 'number' ||
      !Number.isFinite(initial) ||
      !Number.isInteger(initial) ||
      initial < 0
    ) {
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.PROTOCOL_ERROR,
        `Discovery: initialEpochFloor must be a non-negative integer; got ${String(initial)}.`,
        { initialEpochFloor: initial },
      );
    }
    return initial;
  })();
  const inspectEpoch = input.inspectSnapshotEpoch;

  const probeAndRecord = async (v: PointerVersion): Promise<boolean> => {
    checkDeadline();
    probeVersions.push(v);
    return probeVersion({
      v,
      keyMaterial,
      signer,
      aggregatorClient,
      trustBase,
      timeoutMs,
      abortSignal: discoveryAbort.signal,
    });
  };

  // ── Phase 1 — exponential expansion ────────────────────────────────────
  let lo = Math.max(0, currentLocalVersion);
  let hi = Math.max(DISCOVERY_INITIAL_VERSION, lo + 1);

  // Invariant guards: lo ≥ 0, hi ≤ DISCOVERY_HARD_CEILING during the loop.
  while (await probeAndRecord(hi as PointerVersion)) {
    lo = hi;
    const doubled = hi * 2;
    if (doubled > DISCOVERY_HARD_CEILING) {
      if (await probeAndRecord(DISCOVERY_HARD_CEILING)) {
        throw new AggregatorPointerError(
          AggregatorPointerErrorCode.DISCOVERY_OVERFLOW,
          `Phase 1: discovery probe returned true at DISCOVERY_HARD_CEILING=${DISCOVERY_HARD_CEILING}. ` +
            `Latest pointer version exceeds the exponential-expansion ceiling.`,
          { currentLocalVersion, lo, hi: DISCOVERY_HARD_CEILING },
        );
      }
      hi = DISCOVERY_HARD_CEILING;
      break;
    }
    hi = doubled;
  }
  // Invariant after Phase 1: probe(lo) == true (or lo == 0) AND probe(hi) == false.

  // ── Phase 2 — binary search ────────────────────────────────────────────
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await probeAndRecord(mid)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const includedV = lo as PointerVersion;
  // Invariant after Phase 2: probe(includedV) == true (or includedV == 0) AND probe(includedV+1) == false.

  // ── Phase 3 — walkback through non-VALID versions ────────────────────
  //
  // Walks past SEMANTICALLY_INVALID and (when `skipUnfetchable` is true,
  // the default) EXISTS-BUT-UNFETCHABLE versions, looking for the first
  // VALID predecessor. See the file-header for the design rationale on
  // the EXISTS-BUT-UNFETCHABLE policy.
  //
  // W7 walkback floor (SPEC §13 acceptCorruptStreak precondition):
  //   walkback from includedV down to max(0, currentLocalVersion).
  //   Crossing below currentLocalVersion is rejected with WALKBACK_FLOOR —
  //   it would walk past versions this wallet has already confirmed as own.
  let candidate = includedV;
  let walked = 0;
  const walkbackFloor = Math.max(0, currentLocalVersion);

  while (candidate > 0 && walked < walkbackLimit) {
    // W7 floor check (only relevant when walkbackLimit > default — i.e., the
    // acceptCorruptStreak override is active). For the normal flow, the
    // 64-default ceiling is unlikely to cross below localVersion, but the
    // override can be tuned upward enough that the floor matters.
    if (candidate < walkbackFloor) {
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.WALKBACK_FLOOR,
        `Phase 3 walkback reached candidate=${candidate} which is below ` +
          `localVersion=${currentLocalVersion}. Refusing to walk past versions ` +
          `this wallet has already confirmed as its own (SPEC W7).`,
        { candidate, currentLocalVersion },
      );
    }

    // Record this Phase 3 visit in the probe sequence so the probe fingerprint
    // reflects the walkback (corruption + unfetchable) — clustering's MAIN
    // use case is detecting same-prefix wallets (corrupt streaks AND
    // unfetchable-CAR clusters both surface here).
    checkDeadline();
    probeVersions.push(candidate);

    const status = await classifyVersion({
      v: candidate,
      keyMaterial,
      signer,
      aggregatorClient,
      trustBase,
      decodeCid,
      fetchCar,
      timeoutMs,
      abortSignal: discoveryAbort.signal,
    });

    if (status === 'VALID') {
      // Issue #310 — epoch-floor enforcement. Inspect the snapshot's
      // claimed epoch; skip past versions whose epoch is below the
      // running floor. Skip semantics mirror SEMANTICALLY_INVALID
      // (counts toward walkback budget, surfaces in
      // walkbackEpochSkipped for operator observability).
      if (inspectEpoch !== undefined) {
        let candidateEpoch: number | undefined;
        try {
          candidateEpoch = await inspectEpoch(candidate, new Uint8Array(0));
        } catch {
          // Inspector threw → treat as SEMANTICALLY_INVALID-equivalent.
          candidate = (candidate - 1) as PointerVersion;
          walked += 1;
          continue;
        }
        if (shouldSkipForEpochFloor(epochFloor, candidateEpoch)) {
          walkbackEpochSkipped.push(candidate);
          candidate = (candidate - 1) as PointerVersion;
          walked += 1;
          continue;
        }
        epochFloor = pickEpochFloor(epochFloor, candidateEpoch);
      }
      return {
        validV: candidate,
        includedV,
        probeVersions,
        walkbackUnfetchableSkipped,
        walkbackEpochSkipped,
        pickedEpoch: epochFloor,
      };
    }

    if (status === 'SEMANTICALLY_INVALID') {
      candidate = (candidate - 1) as PointerVersion;
      walked += 1;
      continue;
    }

    // PROOF_TRANSIENT: the aggregator proof RPC failed — slot existence UNKNOWN.
    //
    // This is distinct from CAR_TRANSIENT (proof ok, CAR unreachable). We
    // cannot tell whether this version was ever published, so we MUST NOT
    // skip past it regardless of `skipUnfetchableInWalkback`. Walking past
    // an unexamined slot would silently skip a version that may be VALID.
    //
    // Throw CAR_UNAVAILABLE (same code as SPEC-strict CAR_TRANSIENT) so the
    // caller can surface the error or retry. The code matches the legacy
    // behavior for an aggregator outage scenario.
    if (status === 'PROOF_TRANSIENT') {
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.CAR_UNAVAILABLE,
        `Phase 3 walkback: version=${candidate} is PROOF_TRANSIENT — ` +
          `aggregator proof RPC failed, slot existence unknown. ` +
          `Cannot skip past an unexamined slot (retry when aggregator is reachable).`,
        { version: candidate, includedV },
      );
    }

    // CAR_TRANSIENT: the slot EXISTS on-chain (proof verified + CID decoded)
    // but the CAR is not retrievable from any configured gateway.
    //
    // Default policy (`skipUnfetchableInWalkback !== false`): the slot is
    // EXISTS-BUT-UNFETCHABLE — distinct from ABSENT (no proof), from
    // SEMANTICALLY_INVALID (proof partial / CID corrupt), and from
    // PROOF_TRANSIENT (aggregator unreachable). For the purpose of finding
    // the latest VALID predecessor, we treat it like SEMANTICALLY_INVALID:
    // walk back one more, count toward the walkback budget, and record the
    // skipped version for operator observability.
    //
    //   - `includedV` from Phase 2 remains the highest INCLUDED slot
    //     regardless of fetchability, so a downstream publish's
    //     `nextV = max(validV, includedV) + 1` correctly supersedes
    //     above the broken slot. Skipping does NOT collapse the version
    //     space.
    //   - The caller (recoverLatest / reconcile loop) gets either an
    //     older fetchable VALID predecessor or `validV === 0` if no
    //     fetchable predecessor exists. Both outcomes keep the wallet
    //     live.
    //   - Operators receive the skipped versions via
    //     `walkbackUnfetchableSkipped` and can emit a typed event for
    //     monitoring without blocking the wallet.
    //
    // SPEC-strict policy (`skipUnfetchableInWalkback === false`): retain
    // the SPEC §13 / §10.7 throw-CAR_UNAVAILABLE behavior. The caller
    // can then invoke `acceptCarLoss(version)` to bypass the broken slot
    // under operator control.
    if (skipUnfetchable) {
      walkbackUnfetchableSkipped.push(candidate);
      candidate = (candidate - 1) as PointerVersion;
      walked += 1;
      continue;
    }
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.CAR_UNAVAILABLE,
      `Phase 3 walkback: version=${candidate} is CAR_TRANSIENT — ` +
        `proof verified but CAR unreachable; refusing to skip past ` +
        `(use skipUnfetchableInWalkback: true or acceptCarLoss).`,
      { version: candidate, includedV },
    );
  }

  if (candidate === 0) {
    // No valid version ever existed — wallet is pristine, may begin publishing at v=1.
    return {
      validV: 0 as PointerVersion,
      includedV,
      probeVersions,
      walkbackUnfetchableSkipped,
      walkbackEpochSkipped,
      pickedEpoch: epochFloor,
    };
  }

  // Too many consecutive non-VALID versions — bail out (§10.8). The
  // diagnostic carries the unfetchable-skipped + epoch-skipped (issue
  // #310) counts so operators can distinguish "wallet is corrupt"
  // (all skipped were SEMANTICALLY_INVALID) from "IPFS gateways are
  // down" (mostly walkbackUnfetchableSkipped) from "post-reset chain
  // ahead of floor" (mostly walkbackEpochSkipped).
  throw new AggregatorPointerError(
    AggregatorPointerErrorCode.CORRUPT_STREAK,
    `Phase 3 walkback exhausted walkbackLimit=${walkbackLimit} without finding a VALID version ` +
      `(includedV=${includedV}, candidate=${candidate}, ` +
      `unfetchableSkipped=${walkbackUnfetchableSkipped.length}, ` +
      `epochSkipped=${walkbackEpochSkipped.length}, ` +
      `pickedEpoch=${epochFloor}). ` +
      `Operator may invoke acceptCorruptStreak(walkbackLimit) to override.`,
    {
      includedV,
      walkbackLimit,
      walkedSoFar: walked,
      unfetchableSkippedCount: walkbackUnfetchableSkipped.length,
      epochSkippedCount: walkbackEpochSkipped.length,
      pickedEpoch: epochFloor,
    },
  );
}

// ── getProbeFingerprint ────────────────────────────────────────────────────

/**
 * Compute a short stable hash of a probe-version sequence, for UI "same-wallet
 * clustering" signal. NOT secret; MAY be logged.
 *
 * Formula (per IMPL-PLAN): SHA-256 over sorted probe-version-list encoded as
 * be32 bytes, truncated to 8 bytes hex.
 */
export async function computeProbeFingerprint(probeVersions: readonly PointerVersion[]): Promise<string> {
  if (probeVersions.length === 0) return '';

  // Sort for determinism across Phase-1 / Phase-2 / Phase-3 iteration orders.
  const sorted = [...probeVersions].sort((a, b) => a - b);
  const buf = new Uint8Array(sorted.length * 4);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < sorted.length; i++) {
    const v = sorted[i]!;
    if (!Number.isInteger(v) || v < 0 || v > VERSION_MAX) {
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.VERSION_OUT_OF_RANGE,
        `computeProbeFingerprint: probe version ${v} out of range`,
        { v },
      );
    }
    view.setUint32(i * 4, v >>> 0, false); // big-endian
  }
  const { sha256 } = await import('@noble/hashes/sha2.js');
  const digest = sha256(buf);
  let hex = '';
  for (let i = 0; i < 8; i++) {
    hex += digest[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}
