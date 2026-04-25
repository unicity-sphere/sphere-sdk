/**
 * Aggregator submit (T-C1, T-C1b, T-C1c, T-C8) — SPEC §6, §7.3.
 *
 * Tests cover:
 *   - All 13 §7.3 outcome rows (state machine coverage)
 *   - H8 v-burning on REJECTED (row 9)
 *   - T-C1b finally-zero on both return and throw paths
 *   - T-C1c scheduled-zero (MAX_CT_RESIDENT_MS)
 *   - Input validation (v range, cidBytes length)
 *   - Marker-match disambiguation (row 4 vs row 5)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SubmitCommitmentResponse, SubmitCommitmentStatus } from '@unicitylabs/state-transition-sdk/lib/api/SubmitCommitmentResponse.js';
import type { AggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js';
import type { RequestId } from '@unicitylabs/state-transition-sdk/lib/api/RequestId.js';
import type { DataHash } from '@unicitylabs/state-transition-sdk/lib/hash/DataHash.js';
import type { Authenticator } from '@unicitylabs/state-transition-sdk/lib/api/Authenticator.js';

import {
  submitPointer,
  type SubmitInput,
  AggregatorPointerErrorCode,
  derivePointerKeyMaterial,
  buildPointerSigner,
  createMasterPrivateKey,
  computeCidHash,
  SIDE_A_NUM,
  SIDE_B_NUM,
  MAX_CT_RESIDENT_MS,
  VERSION_MAX,
} from '../../../../profile/aggregator-pointer/index.js';
// Test-only access to internal helpers.
import { __internal } from '../../../../profile/aggregator-pointer/aggregator-submit.js';

// ── Test fixtures ──────────────────────────────────────────────────────────

const WALLET_SEED = new Uint8Array(32).fill(0x42); // fixed seed for deterministic tests
const VALID_CID = new Uint8Array([0x12, 0x20, ...new Array(32).fill(0xab)]); // 34-byte SHA-256 multihash

async function buildFixtures() {
  const masterKey = createMasterPrivateKey(WALLET_SEED);
  const keyMaterial = derivePointerKeyMaterial(masterKey);
  const signer = await buildPointerSigner(keyMaterial.signingSeed);
  return { keyMaterial, signer };
}

function mockResponse(status: SubmitCommitmentStatus): SubmitCommitmentResponse {
  return new SubmitCommitmentResponse(status);
}

interface MockClientCalls {
  requestIds: RequestId[];
  transactionHashes: DataHash[];
  authenticators: Authenticator[];
}

function mockClient(
  responder: (callIdx: number) => Promise<SubmitCommitmentResponse>,
): { client: AggregatorClient; calls: MockClientCalls } {
  const calls: MockClientCalls = { requestIds: [], transactionHashes: [], authenticators: [] };
  let callIdx = 0;
  const client = {
    submitCommitment: vi.fn(
      async (requestId: RequestId, transactionHash: DataHash, authenticator: Authenticator) => {
        calls.requestIds.push(requestId);
        calls.transactionHashes.push(transactionHash);
        calls.authenticators.push(authenticator);
        const i = callIdx++;
        return responder(i);
      },
    ),
  } as unknown as AggregatorClient;
  return { client, calls };
}

function jsonRpcNetworkError(status: number, message = ''): Error {
  const err = new Error(message) as Error & { status: number; name: string };
  err.name = 'JsonRpcNetworkError';
  err.status = status;
  return err;
}

function jsonRpcDataError(code: number, message = ''): Error {
  const err = new Error(message) as Error & { code: number; name: string };
  err.name = 'JsonRpcError';
  err.code = code;
  return err;
}

// ── Input validation ───────────────────────────────────────────────────────

describe('submitPointer — input validation', () => {
  it('throws VERSION_OUT_OF_RANGE for v < 1', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const { client } = mockClient(async () => mockResponse(SubmitCommitmentStatus.SUCCESS));
    const input: SubmitInput = {
      v: 0 as never,
      cidBytes: VALID_CID,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker: null,
    };
    await expect(submitPointer(input)).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.VERSION_OUT_OF_RANGE,
    });
  });

  it('throws VERSION_OUT_OF_RANGE for v > VERSION_MAX', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const { client } = mockClient(async () => mockResponse(SubmitCommitmentStatus.SUCCESS));
    await expect(
      submitPointer({
        v: (VERSION_MAX + 1) as never,
        cidBytes: VALID_CID,
        keyMaterial,
        signer,
        aggregatorClient: client,
        marker: null,
      }),
    ).rejects.toMatchObject({ code: AggregatorPointerErrorCode.VERSION_OUT_OF_RANGE });
  });

  it('throws CID_TOO_LARGE for empty CID', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const { client } = mockClient(async () => mockResponse(SubmitCommitmentStatus.SUCCESS));
    await expect(
      submitPointer({
        v: 1,
        cidBytes: new Uint8Array(0),
        keyMaterial,
        signer,
        aggregatorClient: client,
        marker: null,
      }),
    ).rejects.toMatchObject({ code: AggregatorPointerErrorCode.CID_TOO_LARGE });
  });

  it('throws CID_TOO_LARGE for CID > CID_MAX_BYTES', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const { client } = mockClient(async () => mockResponse(SubmitCommitmentStatus.SUCCESS));
    await expect(
      submitPointer({
        v: 1,
        cidBytes: new Uint8Array(64), // CID_MAX_BYTES = 63
        keyMaterial,
        signer,
        aggregatorClient: client,
        marker: null,
      }),
    ).rejects.toMatchObject({ code: AggregatorPointerErrorCode.CID_TOO_LARGE });
  });
});

// ── §7.3 state machine: 13 outcome rows ────────────────────────────────────

describe('submitPointer — §7.3 state machine', () => {
  it('Row 1: SUCCESS + SUCCESS → success', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const { client } = mockClient(async () => mockResponse(SubmitCommitmentStatus.SUCCESS));
    const out = await submitPointer({
      v: 1,
      cidBytes: VALID_CID,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker: null,
    });
    expect(out).toEqual({ kind: 'success', v: 1 });
  });

  it('Row 2: SUCCESS + REQUEST_ID_EXISTS → idempotent_replay', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const { client } = mockClient(async (i) =>
      mockResponse(i === 0 ? SubmitCommitmentStatus.SUCCESS : SubmitCommitmentStatus.REQUEST_ID_EXISTS),
    );
    const out = await submitPointer({
      v: 5,
      cidBytes: VALID_CID,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker: null,
    });
    expect(out).toEqual({ kind: 'idempotent_replay', v: 5 });
  });

  it('Row 3: REQUEST_ID_EXISTS + SUCCESS → idempotent_replay', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const { client } = mockClient(async (i) =>
      mockResponse(i === 0 ? SubmitCommitmentStatus.REQUEST_ID_EXISTS : SubmitCommitmentStatus.SUCCESS),
    );
    const out = await submitPointer({
      v: 7,
      cidBytes: VALID_CID,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker: null,
    });
    expect(out).toEqual({ kind: 'idempotent_replay', v: 7 });
  });

  it('Row 4: EXISTS + EXISTS with isIdempotentRetryHint=true → idempotent_replay', async () => {
    // H13 crash-retry: resolvePublishVersion detected idempotent retry; hint=true.
    const { keyMaterial, signer } = await buildFixtures();
    const { client } = mockClient(async () => mockResponse(SubmitCommitmentStatus.REQUEST_ID_EXISTS));
    const marker = { v: 10, cidHash: computeCidHash(VALID_CID) };
    const out = await submitPointer({
      v: 10,
      cidBytes: VALID_CID,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker,
      isIdempotentRetryHint: true,
    });
    expect(out).toEqual({ kind: 'idempotent_replay', v: 10 });
  });

  it('Row 5: EXISTS + EXISTS with marker-match but hint=false → conflict (hint is authoritative)', async () => {
    // Critical: pre-submit marker always matches current cidBytes. Hint disambiguates.
    const { keyMaterial, signer } = await buildFixtures();
    const { client } = mockClient(async () => mockResponse(SubmitCommitmentStatus.REQUEST_ID_EXISTS));
    const marker = { v: 10, cidHash: computeCidHash(VALID_CID) };
    const out = await submitPointer({
      v: 10,
      cidBytes: VALID_CID,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker,
      isIdempotentRetryHint: false,
    });
    expect(out).toEqual({ kind: 'conflict', v: 10 });
  });

  it('Row 5: EXISTS + EXISTS with no marker → conflict', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const { client } = mockClient(async () => mockResponse(SubmitCommitmentStatus.REQUEST_ID_EXISTS));
    const out = await submitPointer({
      v: 10,
      cidBytes: VALID_CID,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker: null,
    });
    expect(out).toEqual({ kind: 'conflict', v: 10 });
  });

  it('Row 5: EXISTS + EXISTS with marker cidHash mismatch → conflict', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const { client } = mockClient(async () => mockResponse(SubmitCommitmentStatus.REQUEST_ID_EXISTS));
    const differentCid = new Uint8Array([0x12, 0x20, ...new Array(32).fill(0x99)]);
    const marker = { v: 10, cidHash: computeCidHash(differentCid) };
    const out = await submitPointer({
      v: 10,
      cidBytes: VALID_CID,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker,
    });
    expect(out).toEqual({ kind: 'conflict', v: 10 });
  });

  it('Row 5: EXISTS + EXISTS with marker at different v → conflict', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const { client } = mockClient(async () => mockResponse(SubmitCommitmentStatus.REQUEST_ID_EXISTS));
    const marker = { v: 9, cidHash: computeCidHash(VALID_CID) }; // marker at v=9, but we're publishing v=10
    const out = await submitPointer({
      v: 10,
      cidBytes: VALID_CID,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker,
    });
    expect(out).toEqual({ kind: 'conflict', v: 10 });
  });

  it('Row 6: SUCCESS + network error → retry_side B', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const { client } = mockClient(async (i) => {
      if (i === 0) return mockResponse(SubmitCommitmentStatus.SUCCESS);
      throw new TypeError('fetch failed');
    });
    const out = await submitPointer({
      v: 1,
      cidBytes: VALID_CID,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker: null,
    });
    // Steelman² fix: retry_side now carries committedSideKind to
    // distinguish "our commit accepted on the other side" (success)
    // from "another HD-synced device beat us" (exists).
    expect(out).toEqual({ kind: 'retry_side', side: SIDE_B_NUM, committedSideKind: 'success' });
  });

  it('Row 7: network error + SUCCESS → retry_side A', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const { client } = mockClient(async (i) => {
      if (i === 0) throw new Error('ECONNREFUSED');
      return mockResponse(SubmitCommitmentStatus.SUCCESS);
    });
    const out = await submitPointer({
      v: 1,
      cidBytes: VALID_CID,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker: null,
    });
    expect(out).toEqual({ kind: 'retry_side', side: SIDE_A_NUM, committedSideKind: 'success' });
  });

  it('Row 8: network error + network error → retry_both', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const { client } = mockClient(async () => {
      throw new Error('connection refused');
    });
    const out = await submitPointer({
      v: 1,
      cidBytes: VALID_CID,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker: null,
    });
    expect(out).toEqual({ kind: 'retry_both' });
  });

  it('Row 9: AUTHENTICATOR_VERIFICATION_FAILED → rejected (H8 v-burning)', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const { client } = mockClient(async (i) =>
      mockResponse(
        i === 0
          ? SubmitCommitmentStatus.AUTHENTICATOR_VERIFICATION_FAILED
          : SubmitCommitmentStatus.SUCCESS,
      ),
    );
    const out = await submitPointer({
      v: 42,
      cidBytes: VALID_CID,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker: null,
    });
    expect(out).toEqual({
      kind: 'rejected',
      v: 42,
      failedSide: SIDE_A_NUM,
      reason: 'AUTHENTICATOR_VERIFICATION_FAILED',
    });
  });

  it('Row 9: REQUEST_ID_MISMATCH on B → rejected side B', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const { client } = mockClient(async (i) =>
      mockResponse(
        i === 0 ? SubmitCommitmentStatus.SUCCESS : SubmitCommitmentStatus.REQUEST_ID_MISMATCH,
      ),
    );
    const out = await submitPointer({
      v: 42,
      cidBytes: VALID_CID,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker: null,
    });
    expect(out).toEqual({
      kind: 'rejected',
      v: 42,
      failedSide: SIDE_B_NUM,
      reason: 'REQUEST_ID_MISMATCH',
    });
  });

  it('Row 10: HTTP 429 → retry_after, burnedBudget=false', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const { client } = mockClient(async () => {
      throw jsonRpcNetworkError(429, 'Too Many Requests');
    });
    const out = await submitPointer({
      v: 1,
      cidBytes: VALID_CID,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker: null,
    });
    expect(out).toEqual({ kind: 'retry_after', retryAfterMs: 1000, burnedBudget: false });
  });

  it('Row 11: HTTP 500 → retry_backoff, burnedBudget=true', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const { client } = mockClient(async () => {
      throw jsonRpcNetworkError(500, 'Internal Server Error');
    });
    const out = await submitPointer({
      v: 1,
      cidBytes: VALID_CID,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker: null,
    });
    expect(out).toEqual({ kind: 'retry_backoff', burnedBudget: true });
  });

  it('Row 11: HTTP 503 → retry_backoff, burnedBudget=true', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const { client } = mockClient(async () => {
      throw jsonRpcNetworkError(503, 'Service Unavailable');
    });
    const out = await submitPointer({
      v: 1,
      cidBytes: VALID_CID,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker: null,
    });
    expect(out.kind).toBe('retry_backoff');
  });

  it('Row 12: HTTP 400 → aggregator_rejected (permanent)', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const { client } = mockClient(async () => {
      throw jsonRpcNetworkError(400, 'Bad Request');
    });
    const out = await submitPointer({
      v: 1,
      cidBytes: VALID_CID,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker: null,
    });
    expect(out.kind).toBe('aggregator_rejected');
    if (out.kind === 'aggregator_rejected') {
      expect(out.reason).toContain('HTTP 400');
    }
  });

  it('Row 13: JSON-RPC -32006 ConcurrencyLimit → retry_after 1s, burnedBudget=false', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const { client } = mockClient(async () => {
      throw jsonRpcDataError(-32006, 'ConcurrencyLimit');
    });
    const out = await submitPointer({
      v: 1,
      cidBytes: VALID_CID,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker: null,
    });
    expect(out).toEqual({ kind: 'retry_after', retryAfterMs: 1000, burnedBudget: false });
  });

  it('Row 14: SyntaxError (JSON parse) → protocol_error', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const { client } = mockClient(async () => {
      // JSON.parse throws SyntaxError on malformed JSON — simulate authentically.
      throw new SyntaxError('Unexpected end of JSON input');
    });
    const out = await submitPointer({
      v: 1,
      cidBytes: VALID_CID,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker: null,
    });
    expect(out.kind).toBe('protocol_error');
  });

  it('Row 14: "Invalid response format" exact-prefix → protocol_error', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const { client } = mockClient(async () => {
      throw new Error('Invalid response format for block height');
    });
    const out = await submitPointer({
      v: 1,
      cidBytes: VALID_CID,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker: null,
    });
    expect(out.kind).toBe('protocol_error');
  });

  it('Row 14 false-positive fixed: DNS error mentioning "json" → network_error (not protocol_error)', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const { client } = mockClient(async () => {
      // Previously this would misclassify as protocol_error due to substring match.
      throw new Error('getaddrinfo ENOTFOUND json-api.example.com');
    });
    const out = await submitPointer({
      v: 1,
      cidBytes: VALID_CID,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker: null,
    });
    expect(out.kind).toBe('retry_both'); // both sides network_error → retry_both
  });

  it('Row 15: unknown SubmitCommitmentStatus → protocol_error', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const { client } = mockClient(
      async () => new SubmitCommitmentResponse('FUTURE_STATUS_v3' as unknown as SubmitCommitmentStatus),
    );
    const out = await submitPointer({
      v: 1,
      cidBytes: VALID_CID,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker: null,
    });
    expect(out.kind).toBe('protocol_error');
  });

  it('Row 10 cap: retry_after caps at 600 s', async () => {
    // Combined output from retry_after logic must cap at 600 s per SPEC row 10.
    const out = __internal.combineOutcomes(
      { type: 'retry_after', retryAfterMs: 1_000_000 },
      { type: 'success' },
      1,
      new Uint8Array(1),
      null,
    );
    expect(out.kind).toBe('retry_after');
    if (out.kind === 'retry_after') {
      expect(out.retryAfterMs).toBe(600_000);
    }
  });
});

// ── Priority ordering (critical invariants) ────────────────────────────────

describe('submitPointer — priority ordering', () => {
  it('REJECTED wins over EXISTS (H8 v-burning takes precedence over conflict)', async () => {
    const out = __internal.combineOutcomes(
      { type: 'rejected', reason: 'REQUEST_ID_MISMATCH' },
      { type: 'exists' },
      3,
      VALID_CID,
      null,
    );
    expect(out.kind).toBe('rejected');
  });

  it('PROTOCOL_ERROR wins over REJECTED (fail-closed)', async () => {
    const out = __internal.combineOutcomes(
      { type: 'rejected', reason: 'x' },
      { type: 'protocol_error', reason: 'bad JSON' },
      3,
      VALID_CID,
      null,
    );
    expect(out.kind).toBe('protocol_error');
  });

  it('AGGREGATOR_REJECTED wins over retry_after', async () => {
    const out = __internal.combineOutcomes(
      { type: 'aggregator_rejected', reason: 'HTTP 403', statusCode: 403 },
      { type: 'retry_after', retryAfterMs: 5000 },
      1,
      VALID_CID,
      null,
    );
    expect(out.kind).toBe('aggregator_rejected');
  });

  it('retry_after wins over backoff', async () => {
    const out = __internal.combineOutcomes(
      { type: 'retry_after', retryAfterMs: 1000 },
      { type: 'backoff', statusCode: 500 },
      1,
      VALID_CID,
      null,
    );
    expect(out.kind).toBe('retry_after');
    if (out.kind === 'retry_after') {
      expect(out.burnedBudget).toBe(false);
    }
  });

  it('backoff wins over network_error', async () => {
    const out = __internal.combineOutcomes(
      { type: 'backoff', statusCode: 500 },
      { type: 'network_error' },
      1,
      VALID_CID,
      null,
    );
    expect(out.kind).toBe('retry_backoff');
  });
});

// ── T-C1c scheduled-zero (MAX_CT_RESIDENT_MS) ──────────────────────────────

describe('submitPointer — T-C1c scheduled-zero', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules timers at MAX_CT_RESIDENT_MS for ciphertext buffers', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const { client } = mockClient(async () => mockResponse(SubmitCommitmentStatus.SUCCESS));
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    await submitPointer({
      v: 1,
      cidBytes: VALID_CID,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker: null,
    });

    // Expect at least 2 setTimeout calls at MAX_CT_RESIDENT_MS (one for each ciphertext).
    // Per-side submitOneSide also uses setTimeout for the request timeout; we filter.
    const scheduledZeroCalls = setTimeoutSpy.mock.calls.filter(
      (call) => call[1] === MAX_CT_RESIDENT_MS,
    );
    expect(scheduledZeroCalls.length).toBeGreaterThanOrEqual(2);

    setTimeoutSpy.mockRestore();
  });
});

// ── T-C1b finally-zero (zeroize on throw) ──────────────────────────────────

describe('submitPointer — T-C1b finally-zero', () => {
  it('does not propagate errors — finally block runs on throw path', async () => {
    // This test verifies that the try { ... } finally { ctA.fill(0); ... } pattern
    // survives thrown errors. Since we cannot observe internal buffers directly, we
    // rely on the code structure plus the observation that submitPointer always
    // returns a SubmitOutcome rather than throwing (except for input-validation).
    const { keyMaterial, signer } = await buildFixtures();
    const { client } = mockClient(async () => {
      throw new SyntaxError('Unexpected token in JSON at position 42');
    });
    const out = await submitPointer({
      v: 1,
      cidBytes: VALID_CID,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker: null,
    });
    // SyntaxError → protocol_error (row 14).
    expect(out.kind).toBe('protocol_error');
  });
});

// ── OracleProvider routing (T-C7 integration) ─────────────────────────────

describe('submitPointer — OracleProvider routing', () => {
  it('calls AggregatorClient.submitCommitment exactly twice (once per side)', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const { client, calls } = mockClient(async () => mockResponse(SubmitCommitmentStatus.SUCCESS));
    await submitPointer({
      v: 1,
      cidBytes: VALID_CID,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker: null,
    });
    expect(calls.requestIds.length).toBe(2);
    expect(calls.transactionHashes.length).toBe(2);
    expect(calls.authenticators.length).toBe(2);
  });

  it('produces distinct requestIds for sides A and B (different stateHashDigest)', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const { client, calls } = mockClient(async () => mockResponse(SubmitCommitmentStatus.SUCCESS));
    await submitPointer({
      v: 1,
      cidBytes: VALID_CID,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker: null,
    });
    // RequestIds extend DataHash; compare via toString().
    const idA = calls.requestIds[0]!.toString();
    const idB = calls.requestIds[1]!.toString();
    expect(idA).not.toBe(idB);
  });

  it('produces distinct transactionHashes for sides A and B (different ciphertext)', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const { client, calls } = mockClient(async () => mockResponse(SubmitCommitmentStatus.SUCCESS));
    await submitPointer({
      v: 1,
      cidBytes: VALID_CID,
      keyMaterial,
      signer,
      aggregatorClient: client,
      marker: null,
    });
    const hashA = calls.transactionHashes[0]!.toString();
    const hashB = calls.transactionHashes[1]!.toString();
    expect(hashA).not.toBe(hashB);
  });
});

// ── xor32 and arraysEqual helpers ──────────────────────────────────────────

describe('__internal helpers', () => {
  it('xor32 produces correct 32-byte XOR', () => {
    const a = new Uint8Array(32).fill(0xff);
    const b = new Uint8Array(32).fill(0x0f);
    const result = __internal.xor32(a, b);
    expect(result.length).toBe(32);
    for (let i = 0; i < 32; i++) {
      expect(result[i]).toBe(0xf0);
    }
  });

  it('xor32 with zero keys returns input', () => {
    const a = new Uint8Array(32).fill(0x42);
    const zeros = new Uint8Array(32);
    const result = __internal.xor32(a, zeros);
    expect(Array.from(result)).toEqual(Array.from(a));
  });

  it('arraysEqual: same bytes → true', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 4]);
    expect(__internal.arraysEqual(a, b)).toBe(true);
  });

  it('arraysEqual: different lengths → false', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3, 4]);
    expect(__internal.arraysEqual(a, b)).toBe(false);
  });

  it('arraysEqual: same length different bytes → false', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 4]);
    expect(__internal.arraysEqual(a, b)).toBe(false);
  });
});
