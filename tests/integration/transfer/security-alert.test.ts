/**
 * UXF Inter-Wallet Transfer T.5.E — `transfer:security-alert` after
 * sustained NOT_AUTHENTICATED (§9.4.1 hard-fail boundary).
 *
 * Per §9.4.1, sustained NOT_AUTHENTICATED after the
 * `MAX_PROOF_ERROR_RETRIES` budget exhausts the routine recovery path.
 * The worker hard-fails with `reason='proof-invalid'`. By design,
 * `transfer:security-alert` is RESERVED for the §6.3 forbidden-path
 * (two distinct proofs for the same requestId — see
 * `security-alert-conflicting-proofs.test.ts`); a routine sustained
 * NOT_AUTHENTICATED is BoundaryCase #1 — every observation emits
 * `transfer:trustbase-warning` (the routine signal), and the terminal
 * outcome is `proof-invalid` cascade-failed (§6.1.1).
 *
 * This test pins the spec-defined routing:
 *
 *   - sustained NOT_AUTHENTICATED → N trustbase-warning + cascade-failed.
 *   - NO security-alert (the §9.4 reservation).
 *
 * The complementary "actual security-alert" path is tested in
 * `security-alert-conflicting-proofs.test.ts`.
 *
 * Spec refs: §6.1 (NOT_AUTHENTICATED row), §6.1.1 (cascade rule),
 * §6.3 (security-alert reservation), §9.4.1 (routine threat-model
 * boundary).
 */

import { describe, expect, it } from 'vitest';

import {
  ADDR,
  TOKEN_ID,
  buildWorker,
  makeFakeAggregator,
  makeQueueEntry,
  seedQueue,
} from '../../unit/payments/transfer/finalization-worker-recipient-fixtures';

describe('§9.4.1 — sustained NOT_AUTHENTICATED hard-fail routing', () => {
  it('exhausted retries → cascade-failed; trustbase-warning per attempt; NO security-alert', async () => {
    const aggregator = makeFakeAggregator({
      // Polls always return NOT_AUTHENTICATED; the worker exhausts
      // `maxProofErrorRetries` and hard-fails with proof-invalid.
      pollSequence: [
        { kind: 'NOT_AUTHENTICATED' },
        { kind: 'NOT_AUTHENTICATED' },
        { kind: 'NOT_AUTHENTICATED' },
      ],
    });

    const harness = buildWorker({
      aggregator,
      maxProofErrorRetries: 3,
    });
    await seedQueue(harness, [makeQueueEntry()]);

    const result = await harness.worker.processOneToken(TOKEN_ID);

    // Hard-fail terminal (per §6.1 NOT_AUTHENTICATED-after-retries).
    expect(result.terminal).toBe('invalid');
    expect(result.firstHardFailReason).toBe('proof-invalid');
    expect(result.cascadeInvoked).toBe(true);

    // Queue drained even on hard-fail (the entry is removed, its
    // failure recorded as a disposition INVALID).
    const remaining = await harness.queueStore.lookupByTokenId(ADDR, TOKEN_ID);
    expect(remaining.length).toBe(0);

    // Per §9.4.1: every NOT_AUTHENTICATED observation emits a routine
    // trustbase-warning. The worker observed 3 of them (== retry budget).
    const warnings = harness.events.events.filter(
      (e) => e.type === 'transfer:trustbase-warning',
    );
    expect(warnings.length).toBe(3);

    // CRITICAL: §6.3 reserves transfer:security-alert for the
    // forbidden two-different-proofs case. A routine sustained
    // NOT_AUTHENTICATED MUST NOT trigger it.
    const alerts = harness.events.events.filter(
      (e) => e.type === 'transfer:security-alert',
    );
    expect(alerts.length).toBe(0);

    // Cascade-failed ROOT INTENT is emitted by T.5.B's sender worker,
    // but T.5.C's recipient cascade walker is the one called here.
    // The cascade-walker internals are tested separately; here we
    // just confirm cascade was invoked.
    expect(harness.cascadeWalker.cascadeCalls.length).toBe(1);
    expect(harness.cascadeWalker.cascadeCalls[0]!.reason).toBe('proof-invalid');
  });

  it('PATH_INVALID exhausts retries → proof-invalid cascade; NO trustbase-warning, NO security-alert', async () => {
    // Sanity: PATH_INVALID is a different §6.1 row — it is NOT routed
    // through trustbase-warning. The hard-fail outcome is the same
    // (`proof-invalid`), but the warning surface is silent.
    const aggregator = makeFakeAggregator({
      pollSequence: [
        { kind: 'PATH_INVALID' },
        { kind: 'PATH_INVALID' },
        { kind: 'PATH_INVALID' },
      ],
    });

    const harness = buildWorker({
      aggregator,
      maxProofErrorRetries: 3,
    });
    await seedQueue(harness, [makeQueueEntry()]);

    const result = await harness.worker.processOneToken(TOKEN_ID);
    expect(result.firstHardFailReason).toBe('proof-invalid');

    // PATH_INVALID does NOT emit a trustbase-warning (only NOT_AUTHENTICATED
    // does, per §6.1).
    const warnings = harness.events.events.filter(
      (e) => e.type === 'transfer:trustbase-warning',
    );
    expect(warnings.length).toBe(0);

    const alerts = harness.events.events.filter(
      (e) => e.type === 'transfer:security-alert',
    );
    expect(alerts.length).toBe(0);
  });
});
