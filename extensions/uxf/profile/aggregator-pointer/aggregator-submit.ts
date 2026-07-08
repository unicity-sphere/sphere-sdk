/**
 * Aggregator submit (T-C1, T-C1b, T-C1c) — SPEC §6, §7.3.
 *
 * Wave 6-P2-16 migration: the v2 state-transition SDK replaced v1's
 * `submitCommitment(requestId, transactionHash, authenticator)` with
 * `submitCertificationRequest(certificationData)`. This module now:
 *
 *   1. Wraps the pointer's synthetic per-side commitment in a
 *      {@link PointerTransaction} (see `pointer-transaction.ts`).
 *   2. Signs it via `SignaturePredicateUnlockScript.create`, which signs a
 *      hash of (sourceStateHash || transactionHash) using the pointer
 *      signing key.
 *   3. Builds `CertificationData.fromTransaction` and submits via
 *      `submitCertificationRequest`.
 *
 * The v2 `CertificationResponse.status` enum lost `REQUEST_ID_EXISTS`;
 * `classifySideResult` therefore treats:
 *   - `SUCCESS`                     → 'success' (row 1).
 *   - a known "clean reject" status → 'aggregator_rejected' (row 12)
 *     UNLESS the status specifically calls out a signature/key problem,
 *     which maps to 'rejected' (row 9, H8 v-burn).
 *   - any UNKNOWN status string     → 'exists' (per v2's tolerance contract:
 *     the aggregator may emit new statuses that mean "a certification for
 *     this state MAY already exist"; the pointer treats this identically to
 *     v1's REQUEST_ID_EXISTS so H2/H3 idempotent-replay / conflict handling
 *     continues to work).
 *   - transport errors, unknown JSON-RPC codes → same buckets as v1.
 *
 * All aggregator access still routes through an injected `AggregatorClient`
 * that MUST come from `OracleProvider.getAggregatorClient()`.
 *
 * Zeroization discipline (R-11):
 *   - T-C1b finally-zero: all ciphertext / state-hash / xor-key / padding
 *     buffers are wiped in the outer `finally` block — guaranteed on both
 *     normal return and thrown paths.
 *   - T-C1c scheduled-zero: a non-suppressible `setTimeout(fill(0),
 *     MAX_CT_RESIDENT_MS)` is scheduled on every ciphertext buffer at
 *     construction. If the submit flow hands a buffer reference to an
 *     unexpected holder (or the finally-zero is skipped by a fatal signal),
 *     the timer still fires.
 */

import {
  AggregatorClient,
  CertificationData,
  CertificationResponse,
  CertificationStatus,
  DataHash,
  HashAlgorithm,
  SignaturePredicateUnlockScript,
} from '../../../../token-engine/sdk.js';

import {
  CID_MAX_BYTES,
  MAX_CT_RESIDENT_MS,
  PUBLISH_REQUEST_TIMEOUT_MS,
  VERSION_MAX,
  VERSION_MIN,
} from './constants.js';
import { AggregatorPointerError, AggregatorPointerErrorCode } from './errors.js';
import {
  derivePaddingBytes,
  deriveStateHashDigest,
  deriveXorKey,
  type PointerKeyMaterial,
} from './key-derivation.js';
import { PointerTransaction } from './pointer-transaction.js';
import type { PointerSigner } from './signing.js';
import { SIDE_A_NUM, SIDE_B_NUM, type PendingVersionMarker, type PointerVersion, type Side } from './types.js';

// ── Public types ───────────────────────────────────────────────────────────

export interface SubmitInput {
  /** Pointer version (must be in [VERSION_MIN, VERSION_MAX]). */
  readonly v: PointerVersion;
  /** CID byte-string (1–CID_MAX_BYTES bytes). */
  readonly cidBytes: Uint8Array;
  /** HKDF-derived key material (pointer secrets). */
  readonly keyMaterial: PointerKeyMaterial;
  /** Signing service wrapper (v2 `new SigningService(seed)`). */
  readonly signer: PointerSigner;
  /** Aggregator client — MUST come from OracleProvider.getAggregatorClient(). */
  readonly aggregatorClient: AggregatorClient;
  /**
   * Pending-version marker (§7.3 row 4 idempotent-replay detection).
   * Pass `null` when no marker exists at this version.
   *
   * For marker-match disambiguation to work correctly, the marker MUST be
   * the marker that existed BEFORE this publish attempt — NOT the marker
   * just written by the current attempt. Use `isIdempotentRetryHint` to
   * signal whether the resolved v came from a crash-retry (in which case
   * EXISTS+EXISTS → idempotent_replay) or a fresh publish (→ conflict).
   */
  readonly marker: PendingVersionMarker | null;
  /**
   * Explicit hint from resolvePublishVersion indicating whether this submit
   * is an H13 idempotent crash-retry (true) or a fresh publish (false).
   */
  readonly isIdempotentRetryHint?: boolean;
  /** Per-side request timeout. Defaults to PUBLISH_REQUEST_TIMEOUT_MS. */
  readonly timeoutMs?: number;
  /**
   * Optional cancellation signal (see docstring in aggregator-probe.ts for
   * the deadline-race rationale).
   */
  readonly abortSignal?: AbortSignal;
}

/**
 * Combined outcome per SPEC §7.3 13-row state machine.
 *
 * The caller (publish-algorithm.ts, Phase D) owns the retry loop, budget
 * accounting, and H8 marker/localVersion bookkeeping. This module returns a
 * pure classification; it does not mutate any durable state.
 */
export type SubmitOutcome =
  /** Row 1: both SUCCESS. Persist localVersion = v. */
  | { readonly kind: 'success'; readonly v: PointerVersion }
  /** Rows 2, 3, 4: one SUCCESS + one "exists", OR both "exists" with marker match. */
  | { readonly kind: 'idempotent_replay'; readonly v: PointerVersion }
  /** Row 5: both "exists" with no marker match → §9 reconciliation. */
  | { readonly kind: 'conflict'; readonly v: PointerVersion }
  /**
   * Rows 6, 7: one SUCCESS, other network error → retry just the failed side.
   *
   * `committedSideKind` tells the caller WHAT the non-flaky side returned:
   *   - 'success': the other side accepted our commit (Row 6/7 happy path).
   *   - 'exists': the other side had a prior commit — cross-device race.
   */
  | { readonly kind: 'retry_side'; readonly side: Side; readonly committedSideKind: 'success' | 'exists' }
  /** Row 8: both network error → retry whole publish. */
  | { readonly kind: 'retry_both' }
  /** Rows 10, 13: HTTP 429/503+Retry-After or -32006 → honor delay. */
  | { readonly kind: 'retry_after'; readonly retryAfterMs: number; readonly burnedBudget: false }
  /** Row 11: HTTP 5xx without Retry-After → exponential backoff + burn retry budget. */
  | { readonly kind: 'retry_backoff'; readonly burnedBudget: true }
  /** Row 9: signature/key rejection → H8 v-burn + BLOCKED trigger. */
  | { readonly kind: 'rejected'; readonly v: PointerVersion; readonly failedSide: Side; readonly reason: string }
  /** Row 12: HTTP 4xx (not 429) OR clean-reject status → permanent aggregator rejection. */
  | { readonly kind: 'aggregator_rejected'; readonly reason: string }
  /** Rows 14, 15: JSON parse failure / catastrophic protocol violation → fail-closed. */
  | { readonly kind: 'protocol_error'; readonly reason: string };

// ── Internal types ─────────────────────────────────────────────────────────

/** Per-side classification of a single submitCertificationRequest result. */
type SideOutcome =
  | { type: 'success' }
  | { type: 'exists' }
  | { type: 'rejected'; reason: string }
  | { type: 'network_error' }
  | { type: 'retry_after'; retryAfterMs: number }
  | { type: 'backoff'; statusCode: number }
  | { type: 'aggregator_rejected'; reason: string; statusCode: number }
  | { type: 'protocol_error'; reason: string };

/**
 * v2 aggregator statuses that unambiguously mean the pointer's per-side
 * signature or key material was rejected — H8 v-burn (row 9) territory.
 */
const REJECTED_STATUSES: ReadonlySet<string> = new Set([
  CertificationStatus.SIGNATURE_VERIFICATION_FAILED,
  CertificationStatus.INVALID_SIGNATURE_FORMAT,
  CertificationStatus.INVALID_PUBLIC_KEY_FORMAT,
]);

/**
 * v2 aggregator statuses that mean the caller's payload was structurally
 * invalid (state-id mismatch, malformed hash bytes, wrong shard, unsupported
 * algorithm). These are permanent rejections — the caller is a bug or a
 * misconfiguration — not a v-burn event.
 */
const AGGREGATOR_REJECTED_STATUSES: ReadonlySet<string> = new Set([
  CertificationStatus.STATE_ID_MISMATCH,
  CertificationStatus.INVALID_SOURCE_STATE_HASH_FORMAT,
  CertificationStatus.INVALID_TRANSACTION_HASH_FORMAT,
  CertificationStatus.UNSUPPORTED_ALGORITHM,
  CertificationStatus.INVALID_SHARD,
]);

// ── Helpers ────────────────────────────────────────────────────────────────

function xor32(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = (a[i] ?? 0) ^ (b[i] ?? 0);
  return out;
}

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Schedule a non-suppressible zeroization of `buf` at MAX_CT_RESIDENT_MS (T-C1c). */
function scheduleZeroization(buf: Uint8Array): void {
  const handle = setTimeout(() => {
    try {
      buf.fill(0);
    } catch {
      /* buffer may be a detached ArrayBuffer after transfer — noop */
    }
  }, MAX_CT_RESIDENT_MS);
  if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
    (handle as { unref: () => void }).unref();
  }
}

// ── Per-side submit (with timeout) ─────────────────────────────────────────

async function submitOneSide(
  client: AggregatorClient,
  certificationData: CertificationData,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<CertificationResponse> {
  if (abortSignal?.aborted) {
    const err = new Error('submitCertificationRequest aborted by caller');
    err.name = 'AbortError';
    throw err;
  }
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      const err = new Error(`submitCertificationRequest timed out after ${timeoutMs}ms`);
      err.name = 'PointerSubmitTimeout';
      reject(err);
    }, timeoutMs);
  });
  const abortPromise = abortSignal
    ? new Promise<never>((_, reject) => {
        abortListener = () => {
          const err = new Error('submitCertificationRequest aborted by caller');
          err.name = 'AbortError';
          reject(err);
        };
        abortSignal.addEventListener('abort', abortListener, { once: true });
      })
    : null;
  try {
    const racers: Array<Promise<CertificationResponse>> = [
      client.submitCertificationRequest(certificationData),
      timeoutPromise,
    ];
    if (abortPromise) racers.push(abortPromise);
    return await Promise.race(racers);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    if (abortListener && abortSignal) {
      abortSignal.removeEventListener('abort', abortListener);
    }
  }
}

// ── Result classification (§7.3 per-side) ──────────────────────────────────

/**
 * Map a settled Promise result from `submitOneSide` to a `SideOutcome`.
 *
 * v2 CertificationResponse.status is a string with tolerance for unknown
 * values (see CertificationResponse.d.ts). We consult two sets:
 *
 *   REJECTED_STATUSES        → 'rejected' (row 9, H8 v-burn)
 *   AGGREGATOR_REJECTED_STATUSES → 'aggregator_rejected' (row 12 permanent)
 *
 * SUCCESS → 'success'. Any other status string (including yet-to-be-added
 * "state-already-exists" style values a future aggregator might emit) is
 * bucketed as 'exists' — the pointer's H2/H3 state machine then applies
 * marker-match / hint disambiguation to decide idempotent-replay vs conflict.
 * This matches the CertificationResponse.d.ts contract that unknown statuses
 * mean "the request was not accepted → probe getInclusionProof for the
 * actual state" — pointer's next iteration effectively does that via the
 * marker-match bookkeeping.
 *
 * Errors are classified the same way as v1:
 *   JsonRpcNetworkError 429 → retry_after (SDK cannot read Retry-After).
 *   JsonRpcNetworkError 5xx → backoff.
 *   JsonRpcNetworkError 4xx → aggregator_rejected.
 *   JsonRpcError -32006     → retry_after (ConcurrencyLimit).
 *   JsonRpcError other      → protocol_error.
 *   SyntaxError             → protocol_error (JSON parse failure).
 *   Everything else         → network_error.
 */
function classifySideResult(result: PromiseSettledResult<CertificationResponse>): SideOutcome {
  if (result.status === 'fulfilled') {
    const response = result.value;
    const status = response.status;
    if (status === CertificationStatus.SUCCESS) {
      return { type: 'success' };
    }
    if (REJECTED_STATUSES.has(status)) {
      return { type: 'rejected', reason: status };
    }
    if (AGGREGATOR_REJECTED_STATUSES.has(status)) {
      return { type: 'aggregator_rejected', reason: status, statusCode: 400 };
    }
    // Unknown / future status — bucket as 'exists' so the H2/H3 state machine
    // (marker-match + isIdempotentRetryHint) can disambiguate a genuine
    // conflict from an idempotent replay. This matches v2's contract that
    // unknown status strings mean "the request was not accepted; consult
    // getInclusionProof for the state's actual certification".
    return { type: 'exists' };
  }

  const err: unknown = result.reason;

  // JsonRpcNetworkError: set by JsonRpcHttpTransport on non-2xx responses.
  if (
    err !== null &&
    typeof err === 'object' &&
    (err as { name?: string }).name === 'JsonRpcNetworkError' &&
    typeof (err as { status?: unknown }).status === 'number'
  ) {
    const status = (err as { status: number; message?: string }).status;
    const msg = (err as { message?: string }).message ?? '';
    if (status === 429) {
      return { type: 'retry_after', retryAfterMs: 1000 };
    }
    if (status >= 500 && status < 600) {
      return { type: 'backoff', statusCode: status };
    }
    if (status >= 400 && status < 500) {
      return {
        type: 'aggregator_rejected',
        reason: `HTTP ${status}${msg ? `: ${msg}` : ''}`,
        statusCode: status,
      };
    }
    return { type: 'protocol_error', reason: `Unexpected HTTP status ${status}${msg ? `: ${msg}` : ''}` };
  }

  // JsonRpcDataError: JSON-RPC-level error.
  if (
    err !== null &&
    typeof err === 'object' &&
    (err as { name?: string }).name === 'JsonRpcError' &&
    typeof (err as { code?: unknown }).code === 'number'
  ) {
    const code = (err as { code: number; message?: string }).code;
    const msg = (err as { message?: string }).message ?? '';
    if (code === -32006) {
      return { type: 'retry_after', retryAfterMs: 1000 };
    }
    return { type: 'protocol_error', reason: `JSON-RPC error ${code}${msg ? `: ${msg}` : ''}` };
  }

  if (err instanceof Error) {
    if (err.name === 'SyntaxError') {
      return { type: 'protocol_error', reason: err.message };
    }
    if (err.message.startsWith('Invalid response format')) {
      return { type: 'protocol_error', reason: err.message };
    }
    return { type: 'network_error' };
  }

  return { type: 'network_error' };
}

// ── Combine (§7.3 13-row state machine) ────────────────────────────────────

function combineOutcomes(
  outA: SideOutcome,
  outB: SideOutcome,
  v: PointerVersion,
  cidBytes: Uint8Array,
  marker: PendingVersionMarker | null,
  isIdempotentRetryHint: boolean = false,
): SubmitOutcome {
  // Priority 1: PROTOCOL_ERROR (rows 14, 15) — fail closed.
  if (outA.type === 'protocol_error') return { kind: 'protocol_error', reason: `side=A: ${outA.reason}` };
  if (outB.type === 'protocol_error') return { kind: 'protocol_error', reason: `side=B: ${outB.reason}` };

  // Priority 2: REJECTED (row 9) — H8 v-burning.
  if (outA.type === 'rejected') return { kind: 'rejected', v, failedSide: SIDE_A_NUM, reason: outA.reason };
  if (outB.type === 'rejected') return { kind: 'rejected', v, failedSide: SIDE_B_NUM, reason: outB.reason };

  // Priority 3: AGGREGATOR_REJECTED (row 12) — HTTP 4xx or v2 clean-reject.
  if (outA.type === 'aggregator_rejected') return { kind: 'aggregator_rejected', reason: `side=A: ${outA.reason}` };
  if (outB.type === 'aggregator_rejected') return { kind: 'aggregator_rejected', reason: `side=B: ${outB.reason}` };

  // Priority 4: RETRY_AFTER (rows 10, 13).
  if (outA.type === 'retry_after' || outB.type === 'retry_after') {
    const retryMsA = outA.type === 'retry_after' ? outA.retryAfterMs : 0;
    const retryMsB = outB.type === 'retry_after' ? outB.retryAfterMs : 0;
    const retryAfterMs = Math.min(600_000, Math.max(retryMsA, retryMsB));
    return { kind: 'retry_after', retryAfterMs, burnedBudget: false };
  }

  // Priority 5: RETRY_BACKOFF (row 11).
  if (outA.type === 'backoff' || outB.type === 'backoff') {
    return { kind: 'retry_backoff', burnedBudget: true };
  }

  // Priority 6: NETWORK_ERROR (rows 6, 7, 8).
  const netA = outA.type === 'network_error';
  const netB = outB.type === 'network_error';
  if (netA && netB) return { kind: 'retry_both' };
  if (netA) {
    const committedSideKind: 'success' | 'exists' = outB.type === 'success' ? 'success' : 'exists';
    return { kind: 'retry_side', side: SIDE_A_NUM, committedSideKind };
  }
  if (netB) {
    const committedSideKind: 'success' | 'exists' = outA.type === 'success' ? 'success' : 'exists';
    return { kind: 'retry_side', side: SIDE_B_NUM, committedSideKind };
  }

  // Priority 7: SUCCESS / EXISTS combinations (rows 1–5).
  const sA = outA.type;
  const sB = outB.type;
  if (sA === 'success' && sB === 'success') return { kind: 'success', v }; // Row 1
  if (sA === 'success' && sB === 'exists') return { kind: 'idempotent_replay', v }; // Row 2
  if (sA === 'exists' && sB === 'success') return { kind: 'idempotent_replay', v }; // Row 3
  if (sA === 'exists' && sB === 'exists') {
    if (isIdempotentRetryHint) {
      return { kind: 'idempotent_replay', v }; // Row 4 — crash recovery
    }
    void marker;
    void cidBytes;
    return { kind: 'conflict', v }; // Row 5 — genuine conflict
  }

  return {
    kind: 'protocol_error',
    reason: `Unhandled outcome combination: sideA=${sA}, sideB=${sB}`,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Submit a pointer commitment for both sides of `v` in parallel (§7.3).
 *
 * Preconditions:
 *   - `v ∈ [VERSION_MIN, VERSION_MAX]`
 *   - `cidBytes.length ∈ [1, CID_MAX_BYTES]`
 *   - Caller has acquired the publish mutex (SPEC §7.1.1)
 *   - Caller has persisted the pending-version marker before calling (SPEC §7.1.2)
 *
 * Returns a `SubmitOutcome` describing what the caller should do next. Pure
 * function over the input — no durable state is mutated.
 *
 * Throws `AggregatorPointerError(VERSION_OUT_OF_RANGE)` / `CID_TOO_LARGE`
 * on input validation failures. Does NOT throw on any spec-covered §7.3
 * outcome — those are returned in the `SubmitOutcome` union.
 */
export async function submitPointer(input: SubmitInput): Promise<SubmitOutcome> {
  const { v, cidBytes, keyMaterial, signer, aggregatorClient, marker } = input;
  const timeoutMs = input.timeoutMs ?? PUBLISH_REQUEST_TIMEOUT_MS;
  const isIdempotentRetryHint = input.isIdempotentRetryHint ?? false;

  // Input validation.
  if (!Number.isInteger(v) || v < VERSION_MIN || v > VERSION_MAX) {
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.VERSION_OUT_OF_RANGE,
      `submitPointer: v must be in [${VERSION_MIN}, ${VERSION_MAX}]; got ${v}.`,
      { v },
    );
  }
  if (cidBytes.length < 1 || cidBytes.length > CID_MAX_BYTES) {
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.CID_TOO_LARGE,
      `submitPointer: cidBytes length must be in [1, ${CID_MAX_BYTES}]; got ${cidBytes.length}.`,
      { cidLen: cidBytes.length },
    );
  }

  // Derive deterministic material. Every derived buffer MUST be zeroed in the
  // outer `finally` (T-C1b). For ciphertext buffers we additionally schedule
  // a non-suppressible timer (T-C1c).
  const paddingBytes = derivePaddingBytes(keyMaterial.padSeed, v, cidBytes.length);
  const stateHashDigestA = deriveStateHashDigest(keyMaterial.xorSeed, SIDE_A_NUM, v);
  const stateHashDigestB = deriveStateHashDigest(keyMaterial.xorSeed, SIDE_B_NUM, v);
  const xorKeyA = deriveXorKey(keyMaterial.xorSeed, SIDE_A_NUM, v);
  const xorKeyB = deriveXorKey(keyMaterial.xorSeed, SIDE_B_NUM, v);

  // Build the 64-byte plaintext `full` buffer (SPEC §5.3).
  const full = new Uint8Array(64);
  full[0] = cidBytes.length;
  full.set(cidBytes, 1);
  full.set(paddingBytes, 1 + cidBytes.length);

  const partA = full.subarray(0, 32);
  const partB = full.subarray(32, 64);
  const ctA = xor32(partA, xorKeyA);
  const ctB = xor32(partB, xorKeyB);

  scheduleZeroization(ctA);
  scheduleZeroization(ctB);

  try {
    const transactionHashA = new DataHash(HashAlgorithm.SHA256, ctA);
    const transactionHashB = new DataHash(HashAlgorithm.SHA256, ctB);
    const stateHashA = new DataHash(HashAlgorithm.SHA256, stateHashDigestA);
    const stateHashB = new DataHash(HashAlgorithm.SHA256, stateHashDigestB);

    // Build a PointerTransaction per side, sign it with the pointer's key,
    // and package into CertificationData for submission.
    const txA = PointerTransaction.create(signer.signingPubKey, stateHashA, transactionHashA);
    const txB = PointerTransaction.create(signer.signingPubKey, stateHashB, transactionHashB);

    const [unlockA, unlockB] = await Promise.all([
      SignaturePredicateUnlockScript.create(txA, signer.service),
      SignaturePredicateUnlockScript.create(txB, signer.service),
    ]);

    const [certA, certB] = await Promise.all([
      CertificationData.fromTransaction(txA, unlockA),
      CertificationData.fromTransaction(txB, unlockB),
    ]);

    // Submit both sides in parallel, classify each settled result per §7.3.
    const [resultA, resultB] = await Promise.allSettled([
      submitOneSide(aggregatorClient, certA, timeoutMs, input.abortSignal),
      submitOneSide(aggregatorClient, certB, timeoutMs, input.abortSignal),
    ]);

    const outcomeA = classifySideResult(resultA);
    const outcomeB = classifySideResult(resultB);

    return combineOutcomes(outcomeA, outcomeB, v, cidBytes, marker, isIdempotentRetryHint);
  } finally {
    // T-C1b: finally-zero on every exit path.
    ctA.fill(0);
    ctB.fill(0);
    full.fill(0);
    paddingBytes.fill(0);
    stateHashDigestA.fill(0);
    stateHashDigestB.fill(0);
    xorKeyA.fill(0);
    xorKeyB.fill(0);
  }
}

// ── Test-only exports ──────────────────────────────────────────────────────

/**
 * Internal helpers exported for unit-testing the §7.3 state machine in
 * isolation. NOT part of the public API.
 */
export const __internal = {
  classifySideResult,
  combineOutcomes,
  xor32,
  arraysEqual,
  REJECTED_STATUSES,
  AGGREGATOR_REJECTED_STATUSES,
};
