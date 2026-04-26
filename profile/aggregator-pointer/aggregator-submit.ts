/**
 * Aggregator submit (T-C1, T-C1b, T-C1c) — SPEC §6, §7.3.
 *
 * Submits a pointer commitment for both sides (A, B) of a given version in
 * parallel and classifies the combined outcome per SPEC §7.3's 13-row state
 * machine. All aggregator access routes through an injected `AggregatorClient`
 * that MUST come from `OracleProvider.getAggregatorClient()` — the pointer
 * layer never instantiates its own aggregator client.
 *
 * Zeroization discipline (R-11):
 *   - T-C1b finally-zero: all ciphertext / state-hash / xor-key / padding
 *     buffers are wiped in the outer `finally` block — guaranteed on both
 *     normal return and thrown paths.
 *   - T-C1c scheduled-zero: a non-suppressible `setTimeout(fill(0),
 *     MAX_CT_RESIDENT_MS)` is scheduled on every ciphertext buffer at
 *     construction. If the submit flow hands a buffer reference to an
 *     unexpected holder (or the finally-zero is skipped by a fatal signal),
 *     the timer still fires. The SDK-internal copies made by `DataHash` /
 *     `Authenticator` are outside our zeroization reach — documented as
 *     residual risk per SPEC R-11.
 */

import { AggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js';
import { Authenticator } from '@unicitylabs/state-transition-sdk/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/state-transition-sdk/lib/api/RequestId.js';
import {
  SubmitCommitmentResponse,
  SubmitCommitmentStatus,
} from '@unicitylabs/state-transition-sdk/lib/api/SubmitCommitmentResponse.js';
import { DataHash } from '@unicitylabs/state-transition-sdk/lib/hash/DataHash.js';
import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm.js';

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
import { computeCidHash } from './marker.js';
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
  /** Signing service wrapper (SigningService.createFromSecret). */
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
   * When true, EXISTS+EXISTS is classified as idempotent_replay (row 4).
   * When false, EXISTS+EXISTS is classified as conflict (row 5), regardless
   * of whether the marker happens to match the current cidBytes (which is
   * always the case when the caller wrote the marker before submit).
   */
  readonly isIdempotentRetryHint?: boolean;
  /** Per-side request timeout. Defaults to PUBLISH_REQUEST_TIMEOUT_MS. */
  readonly timeoutMs?: number;
  /**
   * Optional cancellation signal. Steelman⁴⁶ HIGH: when the publish-loop
   * deadline expires, callers MUST be able to cancel any in-flight HTTP
   * submit so an abandoned promise cannot land a CID at a v that another
   * tab has already moved past (H8 v-burning hazard). When `aborted`
   * fires, both per-side `submitOneSide` calls reject with `AbortError`
   * and submitPointer surfaces it as a thrown error to the caller.
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
  /** Rows 2, 3, 4: one SUCCESS + one REQUEST_ID_EXISTS, OR both REQUEST_ID_EXISTS with marker match. */
  | { readonly kind: 'idempotent_replay'; readonly v: PointerVersion }
  /** Row 5: both REQUEST_ID_EXISTS with no marker match → §9 reconciliation. */
  | { readonly kind: 'conflict'; readonly v: PointerVersion }
  /**
   * Rows 6, 7: one SUCCESS, other network error → retry just the failed side.
   *
   * `committedSideKind` tells the caller WHAT the non-flaky side returned:
   *   - 'success': the other side accepted our commit (Row 6/7 happy path).
   *     The next iteration's EXISTS+EXISTS is OUR own replay → escalate
   *     `isIdempotentRetryHint` to true so combineOutcomes maps Row 4.
   *   - 'exists': the other side already had a commit at our requestId
   *     (cross-device race — HD-synced sibling wallet beat us). The
   *     next iteration's EXISTS+EXISTS is a GENUINE conflict; do NOT
   *     escalate the hint. Without this discrimination, escalation
   *     silently overwrites our publish with the sibling's CID.
   *
   * (Steelman² fix: previously this distinction was lost in the
   * combined outcome.)
   *
   * Wave F.2 architecture advisory MEDIUM remediation: the field is
   * REQUIRED. The optional-field design from Steelman³ existed only
   * to preserve backwards compatibility for external test fixtures
   * constructing SubmitOutcome literals — but optional was a brittle
   * compromise that invited silent "fail-open if undefined" reasoning
   * in future refactors. Internal callers (combineOutcomes) always
   * set it; external consumers must too. The change is type-only
   * (TS-level breaking change) — runtime semantics unchanged.
   */
  | { readonly kind: 'retry_side'; readonly side: Side; readonly committedSideKind: 'success' | 'exists' }
  /** Row 8: both network error → retry whole publish. */
  | { readonly kind: 'retry_both' }
  /** Rows 10, 13: HTTP 429/503+Retry-After or -32006 → honor delay, no retry-budget burn. */
  | { readonly kind: 'retry_after'; readonly retryAfterMs: number; readonly burnedBudget: false }
  /** Row 11: HTTP 5xx without Retry-After → exponential backoff + burn retry budget. */
  | { readonly kind: 'retry_backoff'; readonly burnedBudget: true }
  /** Row 9: AUTHENTICATOR_VERIFICATION_FAILED or REQUEST_ID_MISMATCH → H8 v-burn + BLOCKED trigger. */
  | { readonly kind: 'rejected'; readonly v: PointerVersion; readonly failedSide: Side; readonly reason: string }
  /** Row 12: HTTP 4xx (not 429) → permanent aggregator rejection, no retry. */
  | { readonly kind: 'aggregator_rejected'; readonly reason: string }
  /** Rows 14, 15: JSON parse failure / unknown SubmitCommitmentStatus → fail-closed. */
  | { readonly kind: 'protocol_error'; readonly reason: string };

// ── Internal types ─────────────────────────────────────────────────────────

/** Per-side classification of a single submitCommitment result. */
type SideOutcome =
  | { type: 'success' }
  | { type: 'exists' }
  | { type: 'rejected'; reason: string }
  | { type: 'network_error' }
  | { type: 'retry_after'; retryAfterMs: number }
  | { type: 'backoff'; statusCode: number }
  | { type: 'aggregator_rejected'; reason: string; statusCode: number }
  | { type: 'protocol_error'; reason: string };

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
    // Guard: the buffer may have been zeroed already by finally-zero; that's fine.
    try {
      buf.fill(0);
    } catch {
      /* buffer may be a detached ArrayBuffer after transfer — noop */
    }
  }, MAX_CT_RESIDENT_MS);
  // Don't keep Node alive for the zeroizer — it's a safety net, not a required job.
  if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
    (handle as { unref: () => void }).unref();
  }
}

// ── Per-side submit (with timeout) ─────────────────────────────────────────

async function submitOneSide(
  client: AggregatorClient,
  requestId: RequestId,
  transactionHash: DataHash,
  authenticator: Authenticator,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<SubmitCommitmentResponse> {
  // Steelman⁴⁶: fast-path — if the caller already cancelled, never even
  // hit the wire. The aggregator client itself cannot honor AbortSignal
  // (the SDK does not plumb it through), so this Promise.race-based
  // cancellation is best-effort: it stops the caller from awaiting and
  // unblocks publish-loop deadline progression. The HTTP socket may
  // remain in flight until the per-side timeoutMs fires — that's
  // acceptable because the now-abandoned response is no longer
  // observed by the publish loop and no v=resolvedV state has been
  // committed.
  if (abortSignal?.aborted) {
    const err = new Error('submitCommitment aborted by caller');
    err.name = 'AbortError';
    throw err;
  }
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      const err = new Error(`submitCommitment timed out after ${timeoutMs}ms`);
      err.name = 'PointerSubmitTimeout';
      reject(err);
    }, timeoutMs);
  });
  const abortPromise = abortSignal
    ? new Promise<never>((_, reject) => {
        abortListener = () => {
          const err = new Error('submitCommitment aborted by caller');
          err.name = 'AbortError';
          reject(err);
        };
        abortSignal.addEventListener('abort', abortListener, { once: true });
      })
    : null;
  try {
    const racers: Array<Promise<SubmitCommitmentResponse>> = [
      client.submitCommitment(requestId, transactionHash, authenticator),
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
 * JsonRpcNetworkError (name === 'JsonRpcNetworkError'): surfaces HTTP
 * status via `.status`. We cannot read Retry-After headers (the SDK drops
 * them) — so 429 is treated as retry_after with a 1-second default, 5xx as
 * retry_backoff, and 4xx as aggregator_rejected.
 *
 * JsonRpcDataError (name === 'JsonRpcError'): JSON-RPC layer error code.
 * Code -32006 ("ConcurrencyLimit") maps to synthetic 503+Retry-After=1s
 * per SPEC §7.3 row 13. All other JSON-RPC codes fail-closed as
 * protocol_error.
 *
 * Anything else → network_error (transport/fetch-level failure).
 */
function classifySideResult(result: PromiseSettledResult<SubmitCommitmentResponse>): SideOutcome {
  if (result.status === 'fulfilled') {
    const response = result.value;
    switch (response.status) {
      case SubmitCommitmentStatus.SUCCESS:
        return { type: 'success' };
      case SubmitCommitmentStatus.REQUEST_ID_EXISTS:
        return { type: 'exists' };
      case SubmitCommitmentStatus.AUTHENTICATOR_VERIFICATION_FAILED:
        return { type: 'rejected', reason: 'AUTHENTICATOR_VERIFICATION_FAILED' };
      case SubmitCommitmentStatus.REQUEST_ID_MISMATCH:
        return { type: 'rejected', reason: 'REQUEST_ID_MISMATCH' };
      default:
        // Row 15: unknown SubmitCommitmentStatus — fail closed.
        return {
          type: 'protocol_error',
          reason: `Unknown SubmitCommitmentStatus: ${String(response.status)}`,
        };
    }
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
      // Row 10: 429 — honor Retry-After (we can't read headers, so use a
      // conservative default). Do NOT burn retry budget.
      return { type: 'retry_after', retryAfterMs: 1000 };
    }
    if (status >= 500 && status < 600) {
      // Row 11: 5xx without Retry-After access — backoff + burn retry budget.
      return { type: 'backoff', statusCode: status };
    }
    if (status >= 400 && status < 500) {
      // Row 12: other 4xx → permanent rejection.
      return {
        type: 'aggregator_rejected',
        reason: `HTTP ${status}${msg ? `: ${msg}` : ''}`,
        statusCode: status,
      };
    }
    // Any other HTTP status (1xx, 3xx) is unexpected for JSON-RPC — protocol error.
    return { type: 'protocol_error', reason: `Unexpected HTTP status ${status}${msg ? `: ${msg}` : ''}` };
  }

  // JsonRpcDataError: JSON-RPC-level error (2xx HTTP, { error: { code, message } }).
  if (
    err !== null &&
    typeof err === 'object' &&
    (err as { name?: string }).name === 'JsonRpcError' &&
    typeof (err as { code?: unknown }).code === 'number'
  ) {
    const code = (err as { code: number; message?: string }).code;
    const msg = (err as { message?: string }).message ?? '';
    if (code === -32006) {
      // Row 13: ConcurrencyLimit → synthetic 503 + 1s retry-after.
      return { type: 'retry_after', retryAfterMs: 1000 };
    }
    // Other JSON-RPC error codes are unexpected — fail closed.
    return { type: 'protocol_error', reason: `JSON-RPC error ${code}${msg ? `: ${msg}` : ''}` };
  }

  // Non-RPC-typed errors: classify structurally where possible.
  if (err instanceof Error) {
    // Row 14: JSON parse failures manifest as SyntaxError from JSON.parse.
    // Use the error class (structural) rather than message substring
    // matching, which would misclassify e.g. transport errors whose message
    // contains "json" (hostname) or "parse" (IP parse) as protocol_error.
    if (err.name === 'SyntaxError') {
      return { type: 'protocol_error', reason: err.message };
    }
    // "Invalid response format" is the fixed message thrown by the SDK's
    // AggregatorClient.getBlockHeight on a schema mismatch (and similar).
    // Match exact prefix, not substring anywhere.
    if (err.message.startsWith('Invalid response format')) {
      return { type: 'protocol_error', reason: err.message };
    }
    // Timeout / connection / DNS / TLS / generic → network error (row 6/7/8).
    return { type: 'network_error' };
  }

  // Unknown error shape — treat as network error (most conservative among retryable outcomes).
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

  // Priority 2: REJECTED (row 9) — H8 v-burning. If both sides REJECTED, A wins for reporting.
  if (outA.type === 'rejected') return { kind: 'rejected', v, failedSide: SIDE_A_NUM, reason: outA.reason };
  if (outB.type === 'rejected') return { kind: 'rejected', v, failedSide: SIDE_B_NUM, reason: outB.reason };

  // Priority 3: AGGREGATOR_REJECTED (row 12) — HTTP 4xx permanent.
  if (outA.type === 'aggregator_rejected') return { kind: 'aggregator_rejected', reason: `side=A: ${outA.reason}` };
  if (outB.type === 'aggregator_rejected') return { kind: 'aggregator_rejected', reason: `side=B: ${outB.reason}` };

  // Priority 4: RETRY_AFTER (rows 10, 13) — honor delay, no retry-budget burn.
  if (outA.type === 'retry_after' || outB.type === 'retry_after') {
    const retryMsA = outA.type === 'retry_after' ? outA.retryAfterMs : 0;
    const retryMsB = outB.type === 'retry_after' ? outB.retryAfterMs : 0;
    // Row 10: cap Retry-After at 600 s.
    const retryAfterMs = Math.min(600_000, Math.max(retryMsA, retryMsB));
    return { kind: 'retry_after', retryAfterMs, burnedBudget: false };
  }

  // Priority 5: RETRY_BACKOFF (row 11) — HTTP 5xx without Retry-After.
  if (outA.type === 'backoff' || outB.type === 'backoff') {
    return { kind: 'retry_backoff', burnedBudget: true };
  }

  // Priority 6: NETWORK_ERROR (rows 6, 7, 8).
  const netA = outA.type === 'network_error';
  const netB = outB.type === 'network_error';
  if (netA && netB) return { kind: 'retry_both' };
  if (netA) {
    // By priority order, when netA is true and netB is false, outB MUST be
    // 'success' or 'exists' (other types are caught earlier). Surface
    // which one so the caller can correctly classify the next iteration's
    // EXISTS+EXISTS — see SubmitOutcome.retry_side docstring.
    const committedSideKind: 'success' | 'exists' = outB.type === 'success' ? 'success' : 'exists';
    return { kind: 'retry_side', side: SIDE_A_NUM, committedSideKind };
  }
  if (netB) {
    const committedSideKind: 'success' | 'exists' = outA.type === 'success' ? 'success' : 'exists';
    return { kind: 'retry_side', side: SIDE_B_NUM, committedSideKind };
  }

  // Priority 7: SUCCESS / REQUEST_ID_EXISTS combinations (rows 1–5).
  const sA = outA.type;
  const sB = outB.type;
  if (sA === 'success' && sB === 'success') return { kind: 'success', v }; // Row 1
  if (sA === 'success' && sB === 'exists') return { kind: 'idempotent_replay', v }; // Row 2
  if (sA === 'exists' && sB === 'success') return { kind: 'idempotent_replay', v }; // Row 3
  if (sA === 'exists' && sB === 'exists') {
    // Rows 4 vs 5: the caller's isIdempotentRetryHint is load-bearing.
    //
    // When resolvePublishVersion determined this is an H13 idempotent retry
    // (crash survived; marker + cidBytes unchanged), the aggregator's
    // REQUEST_ID_EXISTS reflects OUR prior crashed commit → row 4.
    //
    // Otherwise (fresh publish OR OTP-safe bumped v), REQUEST_ID_EXISTS on
    // both sides means another device (sharing our signingPubKey across
    // HD sync) raced and committed at this requestId first → row 5 conflict.
    //
    // The secondary check (marker-match against current cidBytes) is kept
    // as a defense-in-depth for callers that may not plumb the hint
    // correctly, but the HINT is authoritative when provided.
    if (isIdempotentRetryHint) {
      return { kind: 'idempotent_replay', v }; // Row 4 — crash recovery
    }
    // Fresh publish OR OTP-safe bump: the marker we wrote pre-submit
    // MATCHES our current cidBytes trivially, but the aggregator has
    // someone else's content — that's a cross-device race.
    void marker;
    void cidBytes;
    return { kind: 'conflict', v }; // Row 5 — genuine conflict
  }

  // Unreachable in the spec's closed matrix; fail closed defensively.
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

  // Input validation (fail fast, before key derivation).
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
  //   [0]          = cidLen (uint8)
  //   [1..1+cidLen] = cidBytes
  //   [1+cidLen..64] = paddingBytes_v
  const full = new Uint8Array(64);
  full[0] = cidBytes.length;
  full.set(cidBytes, 1);
  full.set(paddingBytes, 1 + cidBytes.length);

  // Split halves and XOR to produce ciphertexts (SPEC §6.1, §6.2).
  const partA = full.subarray(0, 32);
  const partB = full.subarray(32, 64);
  const ctA = xor32(partA, xorKeyA);
  const ctB = xor32(partB, xorKeyB);

  // Schedule T-C1c non-suppressible zeroization on ciphertext buffers.
  scheduleZeroization(ctA);
  scheduleZeroization(ctB);

  try {
    // transactionHash_{side, v} = new DataHash(SHA256, ctSide) — SPEC §6.3.
    // DataHash copies internally (verified against @unicitylabs/state-transition-sdk
    // DataHash.js line 13: `this._data = new Uint8Array(_data)`), so after
    // construction ct can be zeroed without affecting the DataHash.
    const transactionHashA = new DataHash(HashAlgorithm.SHA256, ctA);
    const transactionHashB = new DataHash(HashAlgorithm.SHA256, ctB);
    const stateHashA = new DataHash(HashAlgorithm.SHA256, stateHashDigestA);
    const stateHashB = new DataHash(HashAlgorithm.SHA256, stateHashDigestB);

    // Build authenticators. Authenticator.create internally calls
    // signingService.sign(transactionHash.data) (SPEC §6.4).
    const [authenticatorA, authenticatorB] = await Promise.all([
      Authenticator.create(signer.service, transactionHashA, stateHashA),
      Authenticator.create(signer.service, transactionHashB, stateHashB),
    ]);

    // requestId_{side, v} = SHA256(signingPubKey || [0x00, 0x00] || stateHashDigest) — §4.7.
    // RequestId.createFromImprint takes the 34-byte imprint (2-byte algo tag + 32-byte digest).
    const [requestIdA, requestIdB] = await Promise.all([
      RequestId.createFromImprint(signer.signingPubKey, stateHashA.imprint),
      RequestId.createFromImprint(signer.signingPubKey, stateHashB.imprint),
    ]);

    // Submit both sides in parallel, classify each settled result per §7.3.
    // Steelman⁴⁶: thread the caller-supplied abort signal so deadline
    // tripping at the publish-loop level cancels the awaits here.
    const [resultA, resultB] = await Promise.allSettled([
      submitOneSide(aggregatorClient, requestIdA, transactionHashA, authenticatorA, timeoutMs, input.abortSignal),
      submitOneSide(aggregatorClient, requestIdB, transactionHashB, authenticatorB, timeoutMs, input.abortSignal),
    ]);

    // After Promise.allSettled returns, if the abort signal fired during
    // submit, prefer surfacing the abort to the caller over the spec
    // outcome — the loop deadline is the source of truth.
    if (input.abortSignal?.aborted) {
      const err = new Error('submitPointer aborted by caller');
      err.name = 'AbortError';
      throw err;
    }

    const outcomeA = classifySideResult(resultA);
    const outcomeB = classifySideResult(resultB);

    return combineOutcomes(outcomeA, outcomeB, v, cidBytes, marker, isIdempotentRetryHint);
  } finally {
    // T-C1b: finally-zero — wipe all derived secrets and ciphertexts on
    // every exit path. Residual copies held by DataHash/Authenticator/SDK
    // internals are outside our reach (documented as R-11 residual risk).
    ctA.fill(0);
    ctB.fill(0);
    full.fill(0);
    paddingBytes.fill(0);
    stateHashDigestA.fill(0);
    stateHashDigestB.fill(0);
    xorKeyA.fill(0);
    xorKeyB.fill(0);
    // NB: scheduled-zero timers (T-C1c) are intentionally NOT cleared — they
    // stand as a non-suppressible safety net per SPEC intent.
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
};
