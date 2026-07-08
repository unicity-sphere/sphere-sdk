/**
 * Wave 6-P2-16 — Aggregator submit (T-C1) v2 API coverage.
 *
 * The v2 state-transition SDK replaced v1's
 * `submitCommitment(requestId, transactionHash, authenticator)` /
 * `SubmitCommitmentStatus` with
 * `submitCertificationRequest(certificationData)` /
 * `CertificationStatus`. The pointer classifier's
 * `SUCCESS/REJECTED/AGGREGATOR_REJECTED/EXISTS` buckets are unchanged;
 * only the on-wire status strings differ. This file locks in the
 * v2-status mappings and re-asserts the SPEC §7.3 13-row state machine.
 *
 * Bucket mapping (`REJECTED_STATUSES` and `AGGREGATOR_REJECTED_STATUSES`
 * are exported via `__internal` for reference):
 *
 *   SUCCESS                                → 'success'      (row 1)
 *   SIGNATURE_VERIFICATION_FAILED          → 'rejected'     (row 9)
 *   INVALID_SIGNATURE_FORMAT               → 'rejected'     (row 9)
 *   INVALID_PUBLIC_KEY_FORMAT              → 'rejected'     (row 9)
 *   STATE_ID_MISMATCH                      → 'aggregator_rejected' (row 12)
 *   INVALID_SOURCE_STATE_HASH_FORMAT       → 'aggregator_rejected' (row 12)
 *   INVALID_TRANSACTION_HASH_FORMAT        → 'aggregator_rejected' (row 12)
 *   UNSUPPORTED_ALGORITHM                  → 'aggregator_rejected' (row 12)
 *   INVALID_SHARD                          → 'aggregator_rejected' (row 12)
 *   any other status string                → 'exists'  (v2 tolerance
 *     contract: unknown statuses mean "certification for this state
 *     may already exist"; pointer's marker-match / isIdempotentRetryHint
 *     path then discriminates row 4 vs row 5)
 *
 * The state-machine combineOutcomes tests are the same as v1; only the
 * per-side classification renames.
 */

import { describe, it, expect } from 'vitest';
import { CertificationStatus } from '../../../token-engine/sdk.js';

import { __internal } from '../../../extensions/uxf/profile/aggregator-pointer/aggregator-submit.js';
import { SIDE_A_NUM, SIDE_B_NUM } from '../../../extensions/uxf/profile/aggregator-pointer/types.js';
import type { PointerVersion } from '../../../extensions/uxf/profile/aggregator-pointer/types.js';

const { classifySideResult, combineOutcomes } = __internal;

// ── Helpers ────────────────────────────────────────────────────────────────

function fulfilled(status: string) {
  return { status: 'fulfilled' as const, value: { status } };
}

function rejected(reason: unknown) {
  return { status: 'rejected' as const, reason };
}

function jsonRpcNetworkError(status: number, message = '') {
  const err = new Error(message) as Error & { status: number };
  err.name = 'JsonRpcNetworkError';
  err.status = status;
  return err;
}

function jsonRpcError(code: number, message = '') {
  const err = new Error(message) as Error & { code: number };
  err.name = 'JsonRpcError';
  err.code = code;
  return err;
}

const V: PointerVersion = 5;
const CID_BYTES = new Uint8Array(36).fill(0xab);
const CID_HASH = new Uint8Array(32).fill(0xcd);

// ── classifySideResult ─────────────────────────────────────────────────────

describe('classifySideResult (per-side outcome mapping)', () => {
  it('maps SUCCESS → success', () => {
    expect(classifySideResult(fulfilled(CertificationStatus.SUCCESS))).toEqual({
      type: 'success',
    });
  });

  it('maps SIGNATURE_VERIFICATION_FAILED → rejected (row 9 H8 v-burn)', () => {
    expect(
      classifySideResult(fulfilled(CertificationStatus.SIGNATURE_VERIFICATION_FAILED)),
    ).toEqual({
      type: 'rejected',
      reason: CertificationStatus.SIGNATURE_VERIFICATION_FAILED,
    });
  });

  it('maps INVALID_SIGNATURE_FORMAT → rejected (row 9 H8 v-burn)', () => {
    expect(
      classifySideResult(fulfilled(CertificationStatus.INVALID_SIGNATURE_FORMAT)),
    ).toEqual({
      type: 'rejected',
      reason: CertificationStatus.INVALID_SIGNATURE_FORMAT,
    });
  });

  it('maps INVALID_PUBLIC_KEY_FORMAT → rejected (row 9 H8 v-burn)', () => {
    expect(
      classifySideResult(fulfilled(CertificationStatus.INVALID_PUBLIC_KEY_FORMAT)),
    ).toEqual({
      type: 'rejected',
      reason: CertificationStatus.INVALID_PUBLIC_KEY_FORMAT,
    });
  });

  it('maps STATE_ID_MISMATCH → aggregator_rejected (row 12 permanent)', () => {
    const out = classifySideResult(fulfilled(CertificationStatus.STATE_ID_MISMATCH));
    expect(out.type).toBe('aggregator_rejected');
  });

  it('maps INVALID_SOURCE_STATE_HASH_FORMAT → aggregator_rejected', () => {
    const out = classifySideResult(fulfilled(CertificationStatus.INVALID_SOURCE_STATE_HASH_FORMAT));
    expect(out.type).toBe('aggregator_rejected');
  });

  it('maps INVALID_TRANSACTION_HASH_FORMAT → aggregator_rejected', () => {
    const out = classifySideResult(fulfilled(CertificationStatus.INVALID_TRANSACTION_HASH_FORMAT));
    expect(out.type).toBe('aggregator_rejected');
  });

  it('maps UNSUPPORTED_ALGORITHM → aggregator_rejected', () => {
    const out = classifySideResult(fulfilled(CertificationStatus.UNSUPPORTED_ALGORITHM));
    expect(out.type).toBe('aggregator_rejected');
  });

  it('maps INVALID_SHARD → aggregator_rejected', () => {
    const out = classifySideResult(fulfilled(CertificationStatus.INVALID_SHARD));
    expect(out.type).toBe('aggregator_rejected');
  });

  it('maps unknown status string → exists (v2 tolerance contract)', () => {
    // Per CertificationResponse.d.ts, the aggregator may emit statuses
    // unknown to this SDK version — the caller must NOT fail-closed, and
    // must instead treat them as "certification for this state may
    // already exist". The pointer's H2/H3 state machine then applies
    // marker-match / isIdempotentRetryHint to distinguish idempotent
    // replay (row 4) from cross-device conflict (row 5).
    const out = classifySideResult(fulfilled('SOMETHING_NEW'));
    expect(out.type).toBe('exists');
  });

  it('maps HTTP 429 → retry_after with 1s default (SDK cannot read Retry-After)', () => {
    const out = classifySideResult(rejected(jsonRpcNetworkError(429, 'Too Many Requests')));
    expect(out).toEqual({ type: 'retry_after', retryAfterMs: 1000 });
  });

  it('maps HTTP 5xx → backoff (row 11: burn retry budget)', () => {
    const out = classifySideResult(rejected(jsonRpcNetworkError(503, 'Service Unavailable')));
    expect(out.type).toBe('backoff');
    if (out.type === 'backoff') {
      expect(out.statusCode).toBe(503);
    }
  });

  it('maps HTTP 4xx (not 429) → aggregator_rejected (row 12 permanent)', () => {
    const out = classifySideResult(rejected(jsonRpcNetworkError(400, 'Bad Request')));
    expect(out.type).toBe('aggregator_rejected');
    if (out.type === 'aggregator_rejected') {
      expect(out.statusCode).toBe(400);
    }
  });

  it('maps JSON-RPC -32006 (ConcurrencyLimit) → retry_after 1s (row 13)', () => {
    const out = classifySideResult(rejected(jsonRpcError(-32006, 'Concurrency limit')));
    expect(out).toEqual({ type: 'retry_after', retryAfterMs: 1000 });
  });

  it('maps other JSON-RPC codes → protocol_error (fail-closed)', () => {
    const out = classifySideResult(rejected(jsonRpcError(-32700, 'Parse error')));
    expect(out.type).toBe('protocol_error');
  });

  it('maps SyntaxError (JSON.parse failure) → protocol_error (row 14)', () => {
    const err = new SyntaxError('Unexpected token < in JSON');
    const out = classifySideResult(rejected(err));
    expect(out.type).toBe('protocol_error');
  });

  it('maps generic Error → network_error (rows 6/7/8 retryable)', () => {
    const err = Object.assign(new Error('ETIMEDOUT'), { name: 'FetchError' });
    const out = classifySideResult(rejected(err));
    expect(out.type).toBe('network_error');
  });
});

// ── combineOutcomes — SPEC §7.3 13-row state machine ──────────────────────

describe('combineOutcomes (SPEC §7.3 13-row state machine)', () => {
  it('row 1: SUCCESS + SUCCESS → { kind:"success", v }', () => {
    const out = combineOutcomes(
      { type: 'success' },
      { type: 'success' },
      V,
      CID_BYTES,
      null,
    );
    expect(out).toEqual({ kind: 'success', v: V });
  });

  it('row 2: SUCCESS + EXISTS → idempotent_replay', () => {
    const out = combineOutcomes(
      { type: 'success' },
      { type: 'exists' },
      V,
      CID_BYTES,
      null,
    );
    expect(out).toEqual({ kind: 'idempotent_replay', v: V });
  });

  it('row 3: EXISTS + SUCCESS → idempotent_replay', () => {
    const out = combineOutcomes(
      { type: 'exists' },
      { type: 'success' },
      V,
      CID_BYTES,
      null,
    );
    expect(out).toEqual({ kind: 'idempotent_replay', v: V });
  });

  it('row 4: EXISTS + EXISTS WITH idempotent-retry hint → idempotent_replay (crash recovery)', () => {
    const out = combineOutcomes(
      { type: 'exists' },
      { type: 'exists' },
      V,
      CID_BYTES,
      { v: V, cidHash: CID_HASH },
      true, // isIdempotentRetryHint
    );
    expect(out).toEqual({ kind: 'idempotent_replay', v: V });
  });

  it('row 5: EXISTS + EXISTS WITHOUT idempotent hint → conflict (cross-device race)', () => {
    const out = combineOutcomes(
      { type: 'exists' },
      { type: 'exists' },
      V,
      CID_BYTES,
      { v: V, cidHash: CID_HASH },
      false,
    );
    expect(out).toEqual({ kind: 'conflict', v: V });
  });

  it('row 6: SUCCESS + network_error → retry_side B, committedSideKind=success', () => {
    const out = combineOutcomes(
      { type: 'success' },
      { type: 'network_error' },
      V,
      CID_BYTES,
      null,
    );
    expect(out).toEqual({
      kind: 'retry_side',
      side: SIDE_B_NUM,
      committedSideKind: 'success',
    });
  });

  it('row 7: network_error + SUCCESS → retry_side A, committedSideKind=success', () => {
    const out = combineOutcomes(
      { type: 'network_error' },
      { type: 'success' },
      V,
      CID_BYTES,
      null,
    );
    expect(out).toEqual({
      kind: 'retry_side',
      side: SIDE_A_NUM,
      committedSideKind: 'success',
    });
  });

  it('row 6 variant: EXISTS + network_error → retry_side B, committedSideKind=exists', () => {
    const out = combineOutcomes(
      { type: 'exists' },
      { type: 'network_error' },
      V,
      CID_BYTES,
      null,
    );
    expect(out).toEqual({
      kind: 'retry_side',
      side: SIDE_B_NUM,
      committedSideKind: 'exists',
    });
  });

  it('row 8: network_error + network_error → retry_both', () => {
    const out = combineOutcomes(
      { type: 'network_error' },
      { type: 'network_error' },
      V,
      CID_BYTES,
      null,
    );
    expect(out).toEqual({ kind: 'retry_both' });
  });

  it('row 9: rejected side A → { kind:"rejected", failedSide:A, reason }', () => {
    const out = combineOutcomes(
      { type: 'rejected', reason: CertificationStatus.SIGNATURE_VERIFICATION_FAILED },
      { type: 'success' },
      V,
      CID_BYTES,
      null,
    );
    expect(out).toEqual({
      kind: 'rejected',
      v: V,
      failedSide: SIDE_A_NUM,
      reason: CertificationStatus.SIGNATURE_VERIFICATION_FAILED,
    });
  });

  it('row 9: rejected side B when A is SUCCESS → failedSide=B', () => {
    const out = combineOutcomes(
      { type: 'success' },
      { type: 'rejected', reason: CertificationStatus.INVALID_PUBLIC_KEY_FORMAT },
      V,
      CID_BYTES,
      null,
    );
    expect(out).toEqual({
      kind: 'rejected',
      v: V,
      failedSide: SIDE_B_NUM,
      reason: CertificationStatus.INVALID_PUBLIC_KEY_FORMAT,
    });
  });

  it('row 10: retry_after wins over 5xx backoff and caps at 600s', () => {
    const out = combineOutcomes(
      { type: 'retry_after', retryAfterMs: 5_000 },
      { type: 'backoff', statusCode: 502 },
      V,
      CID_BYTES,
      null,
    );
    expect(out).toEqual({ kind: 'retry_after', retryAfterMs: 5_000, burnedBudget: false });
  });

  it('row 10: retry_after uses the MAX of both sides when both present', () => {
    const out = combineOutcomes(
      { type: 'retry_after', retryAfterMs: 2_000 },
      { type: 'retry_after', retryAfterMs: 8_000 },
      V,
      CID_BYTES,
      null,
    );
    expect(out).toEqual({ kind: 'retry_after', retryAfterMs: 8_000, burnedBudget: false });
  });

  it('row 10: retry_after is capped at 600s even if a side reports higher', () => {
    const out = combineOutcomes(
      { type: 'retry_after', retryAfterMs: 3_600_000 },
      { type: 'success' },
      V,
      CID_BYTES,
      null,
    );
    expect(out).toEqual({ kind: 'retry_after', retryAfterMs: 600_000, burnedBudget: false });
  });

  it('row 11: 5xx backoff without retry_after → burnedBudget=true', () => {
    const out = combineOutcomes(
      { type: 'backoff', statusCode: 503 },
      { type: 'success' },
      V,
      CID_BYTES,
      null,
    );
    expect(out).toEqual({ kind: 'retry_backoff', burnedBudget: true });
  });

  it('row 12: HTTP 4xx aggregator_rejected → permanent, no retry', () => {
    const out = combineOutcomes(
      { type: 'aggregator_rejected', reason: 'HTTP 400: Bad Request', statusCode: 400 },
      { type: 'success' },
      V,
      CID_BYTES,
      null,
    );
    expect(out.kind).toBe('aggregator_rejected');
  });

  it('rows 14/15: protocol_error has top priority (fail-closed)', () => {
    const out = combineOutcomes(
      { type: 'protocol_error', reason: 'JSON parse failed' },
      { type: 'success' },
      V,
      CID_BYTES,
      null,
    );
    expect(out.kind).toBe('protocol_error');
  });

  it('protocol_error precedence: even when side B is REJECTED, A protocol_error wins', () => {
    const out = combineOutcomes(
      { type: 'protocol_error', reason: 'JSON parse failed' },
      { type: 'rejected', reason: CertificationStatus.SIGNATURE_VERIFICATION_FAILED },
      V,
      CID_BYTES,
      null,
    );
    expect(out.kind).toBe('protocol_error');
  });
});
