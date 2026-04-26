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
 *             classifyVersion (H1 three-way). TRANSIENT_UNAVAILABLE
 *             versions propagate as CAR_UNAVAILABLE — we do NOT skip
 *             past them because tokens may still exist. Bail after
 *             DISCOVERY_CORRUPT_WALKBACK consecutive invalid versions
 *             (→ CORRUPT_STREAK).
 *
 * Returns { validV, includedV } (H4 return shape).
 *
 * W7 walkback floor: when an `acceptCorruptStreak(walkbackLimit)` override
 * raises the walkback ceiling, the effective floor MUST NOT cross below
 * localVersion — crossing below would walk past versions this wallet has
 * already confirmed as its own.
 */

import type { AggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js';
import type { RootTrustBase } from '@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase.js';

import {
  classifyVersion,
  probeVersion,
  type CarFetcher,
  type CidDecoder,
} from './aggregator-probe.js';
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
}

// ── findLatestValidVersion ─────────────────────────────────────────────────

export async function findLatestValidVersion(input: DiscoverInput): Promise<DiscoverResult> {
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
  const walkbackLimit = input.walkbackLimit ?? DISCOVERY_CORRUPT_WALKBACK;
  // Steelman¹⁸: bound total discovery time so the mutex is not held forever.
  // Default upper bound: phase ceilings × per-request timeout.
  //   Phase 1: log2(HARD_CEILING / INITIAL) ≈ 12 + Phase 2: 22 ≈ 34 probes
  //   Phase 3: walkbackLimit probes
  // Each probe allows up to timeoutMs. An extra 2× factor absorbs backoff.
  const defaultDeadline =
    Date.now() + (34 + walkbackLimit) * timeoutMs * 2;
  const discoveryDeadlineMs = input.discoveryDeadlineMs ?? defaultDeadline;

  const checkDeadline = (): void => {
    if (Date.now() > discoveryDeadlineMs) {
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.RETRY_EXHAUSTED,
        `Discovery exceeded wall-clock deadline after ${Date.now() - (discoveryDeadlineMs - (34 + walkbackLimit) * timeoutMs * 2)}ms.`,
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

  const probeVersions: PointerVersion[] = [];
  const probeAndRecord = async (v: PointerVersion): Promise<boolean> => {
    checkDeadline();
    probeVersions.push(v);
    return probeVersion({ v, keyMaterial, signer, aggregatorClient, trustBase, timeoutMs });
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

  // ── Phase 3 — walkback through SEMANTICALLY_INVALID versions ───────────
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
    // reflects the corruption walkback — clustering's MAIN use case is
    // detecting same-corrupt-prefix wallets.
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
    });

    if (status === 'VALID') {
      return { validV: candidate, includedV, probeVersions };
    }

    if (status === 'SEMANTICALLY_INVALID') {
      candidate = (candidate - 1) as PointerVersion;
      walked += 1;
      continue;
    }

    // TRANSIENT_UNAVAILABLE: tokens may still exist at this version. DO NOT
    // walk past — surface as CAR_UNAVAILABLE so the caller can retry later
    // (or invoke §10.7 acceptCarLoss flow after the persistent-retry window).
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.CAR_UNAVAILABLE,
      `Phase 3 walkback: version=${candidate} is TRANSIENT_UNAVAILABLE. ` +
        `Tokens may still exist; refusing to skip past.`,
      { version: candidate, includedV },
    );
  }

  if (candidate === 0) {
    // No valid version ever existed — wallet is pristine, may begin publishing at v=1.
    return { validV: 0 as PointerVersion, includedV, probeVersions };
  }

  // Too many consecutive SEMANTICALLY_INVALID versions — bail out (§10.8).
  throw new AggregatorPointerError(
    AggregatorPointerErrorCode.CORRUPT_STREAK,
    `Phase 3 walkback exhausted walkbackLimit=${walkbackLimit} without finding a VALID version ` +
      `(includedV=${includedV}, candidate=${candidate}). ` +
      `Operator may invoke acceptCorruptStreak(walkbackLimit) to override.`,
    { includedV, walkbackLimit, walkedSoFar: walked },
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
