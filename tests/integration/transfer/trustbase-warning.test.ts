/**
 * UXF Inter-Wallet Transfer T.5.E — `transfer:trustbase-warning`
 * integration test (§9.4 / §9.4.1).
 *
 * This test wires the production
 * {@link FinalizationWorkerRecipient} against an aggregator stub that
 * returns NOT_AUTHENTICATED for the first poll (simulating a stale
 * local trustBase) and OK on subsequent polls (simulating a refresh).
 *
 * Expected:
 *   - `transfer:trustbase-warning` emitted on the NOT_AUTHENTICATED
 *     observation, BEFORE the retry succeeds.
 *   - Retry path eventually succeeds once the aggregator returns OK.
 *   - `transfer:security-alert` is NOT emitted — trustbase-warning is
 *     the routine §9.4.1 case.
 *
 * Spec refs: §6.1 (NOT_AUTHENTICATED row), §9.4.1 (routine threat-model
 * boundary), §6.3 (security-alert reservation).
 */

import { describe, expect, it } from 'vitest';

import {
  ADDR,
  NEW_CID,
  TOKEN_ID,
  buildWorker,
  makeFakeAggregator,
  makeProof,
  makeQueueEntry,
  seedQueue,
} from '../../unit/payments/transfer/finalization-worker-recipient-fixtures';

describe('§9.4.1 — transfer:trustbase-warning integration', () => {
  it('NOT_AUTHENTICATED → emit warning → retry succeeds (refresh path)', async () => {
    // Simulate: poll 1 = NOT_AUTHENTICATED (stale trustBase),
    //           poll 2 = OK (after operator refresh).
    const aggregator = makeFakeAggregator({
      pollSequence: [
        { kind: 'NOT_AUTHENTICATED', error: 'validator sig 0x42 unknown' },
        {
          kind: 'OK',
          proof: makeProof(),
          newCid: NEW_CID,
        },
      ],
    });

    const harness = buildWorker({
      aggregator,
      maxProofErrorRetries: 3,
    });
    await seedQueue(harness, [makeQueueEntry()]);

    const result = await harness.worker.processOneToken(TOKEN_ID);

    // Retry SUCCEEDED — terminal valid, queue drained.
    expect(result.terminal).toBe('valid');
    expect(result.successCount).toBe(1);
    expect(result.hardFailCount).toBe(0);

    // Queue drained.
    const remaining = await harness.queueStore.lookupByTokenId(ADDR, TOKEN_ID);
    expect(remaining.length).toBe(0);

    // EXACTLY ONE trustbase-warning emitted.
    const warnings = harness.events.events.filter(
      (e) => e.type === 'transfer:trustbase-warning',
    );
    expect(warnings.length).toBe(1);

    const w = warnings[0]!.data as {
      tokenId: string;
      requestId: string;
      attempt: number;
      message: string;
    };
    expect(w.tokenId).toBe(TOKEN_ID);
    expect(w.requestId).toBe('req-0');
    expect(w.attempt).toBeGreaterThanOrEqual(1);
    expect(w.message.length).toBeGreaterThan(0);

    // CRITICAL: §6.3 reserves transfer:security-alert for the forbidden
    // path. A routine NOT_AUTHENTICATED MUST NOT trip it.
    const alerts = harness.events.events.filter(
      (e) => e.type === 'transfer:security-alert',
    );
    expect(alerts.length).toBe(0);
  });

  it('multiple NOT_AUTHENTICATED before OK → multiple warnings (one per attempt)', async () => {
    // Two NOT_AUTHENTICATED retries BEFORE the eventual OK — each
    // triggers a separate warning so observability dashboards can count
    // refresh attempts.
    const aggregator = makeFakeAggregator({
      pollSequence: [
        { kind: 'NOT_AUTHENTICATED' },
        { kind: 'NOT_AUTHENTICATED' },
        {
          kind: 'OK',
          proof: makeProof(),
          newCid: NEW_CID,
        },
      ],
    });

    const harness = buildWorker({
      aggregator,
      maxProofErrorRetries: 5,
    });
    await seedQueue(harness, [makeQueueEntry()]);

    const result = await harness.worker.processOneToken(TOKEN_ID);
    expect(result.terminal).toBe('valid');

    const warnings = harness.events.events.filter(
      (e) => e.type === 'transfer:trustbase-warning',
    );
    expect(warnings.length).toBe(2);
  });
});
