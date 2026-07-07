/**
 * Wave 6-P2-10b — Aggregator submit (T-C1) coverage restoration.
 *
 * Legacy tests in tests/legacy-v1/unit/profile/pointer/aggregator-submit.test.ts
 * were quarantined in wave 6-P2-5. This file restores the core §7.3
 * state-machine coverage using the pointer layer's own `__internal`
 * test-only exports (classifySideResult, combineOutcomes) — the same
 * hooks the module publishes for out-of-band verification.
 *
 * Coverage split:
 *
 *   classifySideResult — per-side settled-Promise → SideOutcome mapping:
 *     - SUCCESS / REQUEST_ID_EXISTS / AUTHENTICATOR_VERIFICATION_FAILED /
 *       REQUEST_ID_MISMATCH → 'success' / 'exists' / 'rejected'
 *     - Unknown SubmitCommitmentStatus → 'protocol_error'
 *     - JsonRpcNetworkError 429 → 'retry_after' with 1s default
 *     - JsonRpcNetworkError 5xx → 'backoff' (retry-with-budget)
 *     - JsonRpcNetworkError 4xx (not 429) → 'aggregator_rejected' permanent
 *     - JsonRpcError -32006 (ConcurrencyLimit) → 'retry_after' 1s
 *     - JsonRpcError other → 'protocol_error'
 *     - SyntaxError (parse failure) → 'protocol_error'
 *     - Unclassified Error → 'network_error'
 *
 *   combineOutcomes — SPEC §7.3 13-row state machine:
 *     Row 1 — SUCCESS + SUCCESS → { kind:'success', v }
 *     Row 2/3 — SUCCESS + REQUEST_ID_EXISTS (either side) → 'idempotent_replay'
 *     Row 4 — EXISTS + EXISTS with idempotent hint → 'idempotent_replay'
 *     Row 5 — EXISTS + EXISTS fresh publish (no hint) → 'conflict'
 *     Row 6/7 — SUCCESS + network_error → 'retry_side' with committedSideKind='success'
 *     Row 6/7 (variant) — EXISTS + network_error → 'retry_side' with committedSideKind='exists'
 *     Row 8 — network_error + network_error → 'retry_both'
 *     Row 9 — REJECTED (either side) → 'rejected' with failedSide + reason
 *     Row 10 — 'retry_after' priority takes precedence over 5xx backoff
 *     Row 11 — 5xx backoff (no retry_after present)
 *     Row 12 — 4xx (aggregator_rejected) — permanent
 *     Row 13 — JSON-RPC -32006 → maps to retry_after in classifySideResult
 *     Row 14/15 — SyntaxError / unknown status → protocol_error precedence
 *
 * The tests exercise ONLY the pure classification + reducer logic. No real
 * signing, no key derivation, no aggregator client. This mirrors the
 * module's own `__internal` export contract.
 */

import { describe, it, expect } from 'vitest';
import { SubmitCommitmentStatus } from 'stsdk-v1/lib/api/SubmitCommitmentResponse.js';

import { __internal } from '../../../extensions/uxf/profile/aggregator-pointer/aggregator-submit.js';
import { SIDE_A_NUM, SIDE_B_NUM } from '../../../extensions/uxf/profile/aggregator-pointer/types.js';
import type { PointerVersion } from '../../../extensions/uxf/profile/aggregator-pointer/types.js';

const { classifySideResult, combineOutcomes } = __internal;

// ── Helpers ────────────────────────────────────────────────────────────────

function fulfilled(status: SubmitCommitmentStatus) {
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
    expect(classifySideResult(fulfilled(SubmitCommitmentStatus.SUCCESS))).toEqual({
      type: 'success',
    });
  });

  it('maps REQUEST_ID_EXISTS → exists', () => {
    expect(classifySideResult(fulfilled(SubmitCommitmentStatus.REQUEST_ID_EXISTS))).toEqual({
      type: 'exists',
    });
  });

  it('maps AUTHENTICATOR_VERIFICATION_FAILED → rejected', () => {
    expect(
      classifySideResult(fulfilled(SubmitCommitmentStatus.AUTHENTICATOR_VERIFICATION_FAILED)),
    ).toEqual({
      type: 'rejected',
      reason: 'AUTHENTICATOR_VERIFICATION_FAILED',
    });
  });

  it('maps REQUEST_ID_MISMATCH → rejected', () => {
    expect(classifySideResult(fulfilled(SubmitCommitmentStatus.REQUEST_ID_MISMATCH))).toEqual({
      type: 'rejected',
      reason: 'REQUEST_ID_MISMATCH',
    });
  });

  it('maps unknown SubmitCommitmentStatus → protocol_error (row 15 fail-closed)', () => {
    const out = classifySideResult(
      fulfilled('SOMETHING_NEW' as unknown as SubmitCommitmentStatus),
    );
    expect(out.type).toBe('protocol_error');
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
    // Signals a cross-device race: the sibling committed at THIS side,
    // so the retry loop must NOT escalate isIdempotentRetryHint.
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
      { type: 'rejected', reason: 'AUTHENTICATOR_VERIFICATION_FAILED' },
      { type: 'success' },
      V,
      CID_BYTES,
      null,
    );
    expect(out).toEqual({
      kind: 'rejected',
      v: V,
      failedSide: SIDE_A_NUM,
      reason: 'AUTHENTICATOR_VERIFICATION_FAILED',
    });
  });

  it('row 9: rejected side B when A is SUCCESS → failedSide=B', () => {
    const out = combineOutcomes(
      { type: 'success' },
      { type: 'rejected', reason: 'REQUEST_ID_MISMATCH' },
      V,
      CID_BYTES,
      null,
    );
    expect(out).toEqual({
      kind: 'rejected',
      v: V,
      failedSide: SIDE_B_NUM,
      reason: 'REQUEST_ID_MISMATCH',
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
    // The reducer's priority order guarantees protocol_error > rejected.
    const out = combineOutcomes(
      { type: 'protocol_error', reason: 'JSON parse failed' },
      { type: 'rejected', reason: 'AUTHENTICATOR_VERIFICATION_FAILED' },
      V,
      CID_BYTES,
      null,
    );
    expect(out.kind).toBe('protocol_error');
  });
});
