/**
 * UnicityAggregatorProvider.waitForProof — Phase 6 wave-6-P2-11 coverage.
 *
 * Wave 6-P2-7 flagged the `waitForProof` polling loop for verification
 * after the wave-6-P2-4a shrink dropped the v1-shaped `waitForProofSdk`
 * twin. The loop MUST:
 *
 *   1. Return immediately when `getProof` yields a canonical
 *      inclusion proof on the first call (no unnecessary sleep).
 *   2. Poll on `pollInterval` cadence until a proof arrives or the
 *      timeout expires — the polling loop, not the aggregator's
 *      atomic `submitCertificationRequest` return, is the recipient's
 *      only route to the proof for pending requestIds.
 *   3. Throw `SphereError('TIMEOUT')` when the wall-clock deadline
 *      elapses without a proof.
 *   4. Emit `proof:received` on success so telemetry pickers observe
 *      terminal transitions.
 *   5. Invoke the optional `onPoll` callback with a 1-indexed attempt
 *      counter that increments on every getProof() call.
 *
 * Test strategy: mock the SDK boundary and stub `getProof` directly on
 * the provider so we can control per-call return values without wiring
 * fake HTTP responses.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../token-engine/sdk', () => {
  class AggregatorClient {
    getLatestBlockNumber = vi.fn().mockResolvedValue(1n);
  }
  class StateTransitionClient {
    constructor(public readonly aggregator: unknown) {}
  }
  class RootTrustBase {
    static fromJSON(json: unknown): RootTrustBase {
      return new RootTrustBase(json);
    }
    constructor(public readonly source: unknown) {}
  }
  return { AggregatorClient, StateTransitionClient, RootTrustBase };
});

import { UnicityAggregatorProvider } from '../../../oracle/UnicityAggregatorProvider';
import type { InclusionProof } from '../../../oracle/oracle-provider';

function canonicalProof(requestId: string, round = 7): InclusionProof {
  return {
    requestId,
    roundNumber: round,
    proof: {
      authenticator: { sig: 'x' },
      merkleTreePath: { steps: [] },
      transactionHash: '0xabc',
      unicityCertificate: { cert: 'y' },
    },
    timestamp: Date.now(),
  };
}

describe('UnicityAggregatorProvider.waitForProof (v2 slim, wave-6-P2-11)', () => {
  let p: UnicityAggregatorProvider;

  beforeEach(async () => {
    p = new UnicityAggregatorProvider({
      url: 'https://aggregator.example',
      // Keep timeout low enough that fake-timer advances don't lag behind
      // Date.now() cadence in the runner.
      timeout: 5000,
    });
    await p.initialize({});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns immediately when getProof resolves on the first poll', async () => {
    const getProof = vi
      .spyOn(p, 'getProof')
      .mockResolvedValue(canonicalProof('req-fast'));
    const onPoll = vi.fn();

    const proof = await p.waitForProof('req-fast', { onPoll });

    expect(proof.requestId).toBe('req-fast');
    expect(proof.roundNumber).toBe(7);
    expect(getProof).toHaveBeenCalledTimes(1);
    expect(onPoll).toHaveBeenCalledTimes(1);
    expect(onPoll).toHaveBeenCalledWith(1);
  });

  it('emits proof:received on successful return', async () => {
    vi.spyOn(p, 'getProof').mockResolvedValue(canonicalProof('req-emit'));
    const events: string[] = [];
    p.onEvent((e) => events.push(e.type));

    await p.waitForProof('req-emit');

    expect(events).toContain('proof:received');
  });

  it('polls until a proof arrives and increments attempt on every getProof call', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    vi.spyOn(p, 'getProof').mockImplementation(async () => {
      callCount++;
      if (callCount < 3) return null;
      return canonicalProof('req-poll');
    });
    const onPoll = vi.fn();

    const proofPromise = p.waitForProof('req-poll', {
      timeout: 10_000,
      pollInterval: 100,
      onPoll,
    });

    // Two sleeps at 100 ms each between the 3 getProof calls.
    await vi.advanceTimersByTimeAsync(250);
    const proof = await proofPromise;

    expect(proof.requestId).toBe('req-poll');
    expect(callCount).toBe(3);
    expect(onPoll).toHaveBeenNthCalledWith(1, 1);
    expect(onPoll).toHaveBeenNthCalledWith(2, 2);
    expect(onPoll).toHaveBeenNthCalledWith(3, 3);
  });

  it('throws SphereError(TIMEOUT) when the deadline elapses without a proof', async () => {
    vi.useFakeTimers();
    vi.spyOn(p, 'getProof').mockResolvedValue(null);

    const proofPromise = p.waitForProof('req-timeout', {
      timeout: 200,
      pollInterval: 50,
    });
    // Attach a catch handler up front so the unresolved rejection during
    // timer advancement doesn't trip vitest's unhandled-rejection guard.
    const settled = proofPromise.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(500);
    const err = await settled;

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Timeout waiting for proof|req-timeout/);
    // Include a defensive check against the SphereError code name.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((err as any).code ?? '').toMatch(/TIMEOUT/);
  });

  it('propagates unexpected sync throws from getProof as loop termination', async () => {
    // Wave 6-P2-11 audit: `getProof` catches errors internally and returns
    // null. But defensively, if a caller passes a monkey-patched getProof
    // that throws, the polling loop MUST NOT swallow it silently — the
    // promise should reject with the underlying error so operators see
    // the diagnostic surface rather than an ambiguous timeout.
    const boom = new Error('unexpected getProof exception');
    vi.spyOn(p, 'getProof').mockRejectedValue(boom);

    await expect(p.waitForProof('req-throws', { timeout: 5000 })).rejects.toThrow(
      /unexpected getProof exception/,
    );
  });
});
