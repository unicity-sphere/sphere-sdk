/**
 * UXF Transfer T.5.C — recipient cascade with NO children.
 *
 * "Pure-receive" semantics: when the recipient has only RECEIVED a
 * token (never forwarded it via instant-mode), there are no
 * `splitParent` children AND no outbox entries that shipped it. The
 * cascade walker is invoked but reports `{cascaded:0, nftNotified:0}`
 * — there is nothing to walk.
 *
 * Self-invalidation STILL applies in BOTH coin and NFT classes.
 *
 * Spec refs: §6.1.1 (cascade rules — coin/NFT class-disjoint paths),
 * §5.5 step 7.
 */

import { describe, expect, it } from 'vitest';

import {
  TOKEN_ID,
  buildWorker,
  makeFakeAggregator,
  makeFakeCascadeWalker,
  makeQueueEntry,
  seedQueue,
} from './finalization-worker-recipient-fixtures';

describe('recipient cascade — coin token, no children (pure-receive)', () => {
  it('hard-fail triggers cascade walker that reports no children', async () => {
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'AUTHENTICATOR_VERIFICATION_FAILED' }),
    });
    const cascadeWalker = makeFakeCascadeWalker({
      tokenClass: 'coin',
      // No children registered for the failing tokenId.
      children: new Map(),
    });
    const harness = buildWorker({ aggregator, cascadeWalker });
    await seedQueue(harness, [makeQueueEntry()]);

    const result = await harness.worker.processOneToken(TOKEN_ID);

    expect(result.cascadeInvoked).toBe(true);
    expect(cascadeWalker.cascadeCalls.length).toBe(1);

    // Self-invalidation written.
    const invalid = harness.dispositionWriter.writes.filter(
      (w) => w.record.disposition === 'INVALID',
    );
    expect(invalid.length).toBe(1);
    expect(invalid[0].record.tokenId).toBe(TOKEN_ID);
  });
});

describe('recipient cascade — NFT token, no forward (pure-receive)', () => {
  it('hard-fail triggers cascade walker that has no NFT outbox to notify', async () => {
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'AUTHENTICATOR_VERIFICATION_FAILED' }),
    });
    const cascadeWalker = makeFakeCascadeWalker({
      tokenClass: 'nft',
      // No outbox entries — no NFT forward.
    });
    const harness = buildWorker({ aggregator, cascadeWalker });
    await seedQueue(harness, [makeQueueEntry()]);

    const result = await harness.worker.processOneToken(TOKEN_ID);

    expect(result.cascadeInvoked).toBe(true);
    expect(cascadeWalker.cascadeCalls.length).toBe(1);

    // Self-invalidation STILL applies.
    const invalid = harness.dispositionWriter.writes.filter(
      (w) => w.record.disposition === 'INVALID',
    );
    expect(invalid.length).toBe(1);
  });
});

describe('recipient cascade — unknown token class (locally absent)', () => {
  it('cascade walker invoked with null class → no-op cascade; self-invalidation still fires', async () => {
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'AUTHENTICATOR_VERIFICATION_FAILED' }),
    });
    const cascadeWalker = makeFakeCascadeWalker({
      tokenClass: null, // token unknown locally
    });
    const harness = buildWorker({ aggregator, cascadeWalker });
    await seedQueue(harness, [makeQueueEntry()]);

    const result = await harness.worker.processOneToken(TOKEN_ID);

    // Cascade is INVOKED (we still call cascade.cascade) but it
    // reports 0 cascaded.
    expect(result.cascadeInvoked).toBe(true);
    expect(cascadeWalker.cascadeCalls.length).toBe(1);
    // Self-invalidation written.
    const invalid = harness.dispositionWriter.writes.filter(
      (w) => w.record.disposition === 'INVALID',
    );
    expect(invalid.length).toBe(1);
  });
});

describe('recipient cascade — cascade walker throws', () => {
  it('walker throw does NOT propagate — operator-alert emitted', async () => {
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'AUTHENTICATOR_VERIFICATION_FAILED' }),
    });
    const cascadeWalker = makeFakeCascadeWalker({ tokenClass: 'coin' });
    // Override cascade to throw.
    cascadeWalker.cascade = async () => {
      throw new Error('walker boom');
    };
    const harness = buildWorker({ aggregator, cascadeWalker });
    await seedQueue(harness, [makeQueueEntry()]);

    const result = await harness.worker.processOneToken(TOKEN_ID);

    // The worker still terminates with 'invalid' — the walker throw
    // is swallowed and surfaced as an operator-alert.
    expect(result.terminal).toBe('invalid');
    const alerts = harness.events.events.filter(
      (e) => e.type === 'transfer:operator-alert',
    );
    expect(alerts.length).toBeGreaterThanOrEqual(1);
  });
});
