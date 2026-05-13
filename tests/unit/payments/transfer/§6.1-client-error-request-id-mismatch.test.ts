/**
 * UXF Transfer T.5.B — REQUEST_ID_MISMATCH → 'client-error' (C12/C13).
 *
 * Per §6.1's submit-side mapping:
 *
 *   REQUEST_ID_MISMATCH = "client sent inconsistent (requestId,
 *                         sourceState, transactionHash) tuple"
 *                       → CLIENT BUG, not a double-spend signal.
 *
 * Acceptance (C12/C13):
 *   "REQUEST_ID_MISMATCH → hard-fail, reason='client-error' (operator
 *    alert)."
 *
 * Cascade behavior:
 *   client-error is NOT in §6.1.1's cascade set (cascade fires only
 *   for failures that invalidate the chain — race-lost is special-
 *   cased AND client-error means the wallet bug, not the chain bug).
 *   Tests pin the absence of `transfer:cascade-failed`.
 *
 * Operator alert:
 *   `transfer:operator-alert` is emitted with `code: 'client-error'`
 *   so wallet operators can correlate to their bug telemetry.
 *
 * Spec refs: §6.1 (submit-side error model), §6.1.2 (outbox terminal
 * states), C13 in T.5.D's import-inclusion-proof handling.
 */

import { describe, expect, it } from 'vitest';

import {
  buildWorker,
  makeFakeAggregator,
  makeOutboxEntry,
} from './finalization-worker-sender-fixtures';

describe('§6.1 REQUEST_ID_MISMATCH → client-error (C12/C13)', () => {
  it('hard-fails with reason=client-error', async () => {
    const aggregator = makeFakeAggregator({
      submit: async () => ({
        kind: 'REQUEST_ID_MISMATCH',
        error: 'inconsistent (requestId, sourceState, transactionHash) tuple',
      }),
    });
    const h = buildWorker({ aggregator });
    const result = await h.worker.processOne(makeOutboxEntry());

    expect(result.terminal).toBe('failed-permanent');
    expect(result.firstHardFailReason).toBe('client-error');
  });

  it('emits transfer:operator-alert with code=client-error', async () => {
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'REQUEST_ID_MISMATCH' }),
    });
    const h = buildWorker({ aggregator });
    await h.worker.processOne(makeOutboxEntry());

    const alerts = h.events.events.filter(
      (e) => e.type === 'transfer:operator-alert',
    );
    expect(alerts).toHaveLength(1);
    const data = alerts[0]!.data as { code: string; tokenId: string; message: string };
    expect(data.code).toBe('client-error');
    expect(data.message).toContain('REQUEST_ID_MISMATCH');
  });

  it('does NOT cascade (client-error is not in §6.1.1 cascade set)', async () => {
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'REQUEST_ID_MISMATCH' }),
    });
    const h = buildWorker({ aggregator });
    const result = await h.worker.processOne(makeOutboxEntry());

    expect(result.cascadeFailedEmitted).toBe(false);
    const cascadeEvents = h.events.events.filter(
      (e) => e.type === 'transfer:cascade-failed',
    );
    expect(cascadeEvents).toHaveLength(0);
  });

  it('short-circuits at submit — no poll happens', async () => {
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'REQUEST_ID_MISMATCH' }),
    });
    const h = buildWorker({ aggregator });
    await h.worker.processOne(makeOutboxEntry());

    expect(h.aggregator.submitCalls).toBe(1);
    expect(h.aggregator.pollCalls).toBe(0);
    expect(h.pool.attachCalls).toHaveLength(0);
  });

  it('REQUEST_ID_MISMATCH is distinct from race-lost (NOT detected via this code)', async () => {
    // C12 normative wording: "Race-lost detected via REQUEST_ID_EXISTS
    // at submit + OK with mismatching transactionHash at poll. NOT via
    // REQUEST_ID_MISMATCH." This test pins that distinction by asserting
    // the reason is 'client-error', not 'race-lost'.
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'REQUEST_ID_MISMATCH' }),
    });
    const h = buildWorker({ aggregator });
    const result = await h.worker.processOne(makeOutboxEntry());

    expect(result.firstHardFailReason).not.toBe('race-lost');
    expect(result.firstHardFailReason).toBe('client-error');
  });

  it('persists client-error in the outbox error field for operator inspection', async () => {
    const aggregator = makeFakeAggregator({
      submit: async () => ({
        kind: 'REQUEST_ID_MISMATCH',
        error: 'inconsistent tuple',
      }),
    });
    const h = buildWorker({ aggregator });
    await h.worker.processOne(makeOutboxEntry());

    expect(h.outbox.entries().status).toBe('failed-permanent');
    expect(h.outbox.entries().error).toContain('client-error');
  });
});
