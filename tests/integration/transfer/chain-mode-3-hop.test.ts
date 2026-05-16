/**
 * §11.2 integration — Chain-mode 3-hop forward.
 *
 * Spec scenario (§11.2):
 *   "3-hop instant-mode forward: A→B→C→D before any aggregator
 *    round-trip. D receives a token with 3 unfinalized txs. D's worker
 *    resolves all 3; status transitions `pending → valid` only after
 *    the third proof attaches."
 *
 * Pipeline under test:
 *   - The recipient-side finalization worker (T.5.C) is the part of the
 *     pipeline that resolves the 3-deep chain. We seed its queue with
 *     three queue entries (one per unfinalized predecessor), drive
 *     `processOneToken`, and assert:
 *
 *       (a) the worker submits + polls for every queue entry,
 *       (b) the per-entry poll outcomes feed back into the manifest
 *           write path,
 *       (c) the queue is fully drained,
 *       (d) the terminal disposition is `valid` (not invalid, not
 *           pending), confirming the last proof flips the token.
 *
 * The aggregator stub returns OK for every queue entry — the chain is
 * legitimate and every hop's commitment anchors. The §6.1.1 cascade is
 * NOT exercised here (separate test file covers cascade-on-hard-fail).
 *
 * @packageDocumentation
 */

import { describe, expect, it } from 'vitest';

import {
  ADDR,
  NEW_CID,
  buildWorker,
  makeFakeAggregator,
  makeProof,
  makeQueueEntry,
  seedQueue,
} from '../../unit/payments/transfer/finalization-worker-recipient-fixtures';

describe('§11.2 — chain-mode 3-hop forward (instant)', () => {
  it('3 unfinalized predecessors all resolve OK; queue drains; terminal=valid', async () => {
    // Aggregator returns OK for every poll — the chain is legitimate
    // end-to-end. Per-request poll responses make the worker's
    // outcome deterministic regardless of which entry it processes
    // first. The proof's transactionHash matches the queue entry's
    // LOCAL_TX_HASH (no race-lost).
    const reqs = ['req-A', 'req-B', 'req-C'];
    const perRequestPoll = new Map(
      reqs.map((r) => [
        r,
        [
          {
            kind: 'OK' as const,
            proof: makeProof(),
            newCid: NEW_CID,
          },
        ],
      ]),
    );
    const aggregator = makeFakeAggregator({ perRequestPoll });
    const harness = buildWorker({ aggregator });

    // Seed the queue with 3 entries, one per chain hop. Each entry
    // carries a distinct commitmentRequestId — A, B, C.
    const entries = reqs.map((r, i) =>
      makeQueueEntry({
        commitmentRequestId: r,
        txIndex: i,
      }),
    );
    await seedQueue(harness, entries);

    // The worker drives ONE token's full chain in a single call. We
    // process the canonical TOKEN_ID (every queue entry shares it).
    const result = await harness.worker.processOneToken(
      entries[0].tokenId,
    );

    // Every queue entry produced a successful proof attachment.
    expect(result.terminal).toBe('valid');
    expect(result.successCount).toBe(3);
    expect(result.hardFailCount).toBe(0);

    // Every requestId got polled at least once.
    for (const r of reqs) {
      const polls = aggregator.pollCalls.filter((c) => c.requestId === r);
      expect(polls.length).toBeGreaterThanOrEqual(1);
    }

    // Queue drained — no leftover entries for this tokenId.
    const remaining = await harness.queueStore.lookupByTokenId(
      ADDR,
      entries[0].tokenId,
    );
    expect(remaining).toHaveLength(0);

    // Pool: 3 attachProof calls (one per resolved entry). Note:
    // `attachCalls.requestId` is the QUEUE ENTRY ID (`token-1:0`,
    // `token-1:1`, `token-1:2`), not the commitmentRequestId — this
    // is the contract of `PoolWriteAdapter.attachProof` per the
    // T.5.C fixture's makeFakePool.
    expect(harness.pool.attachCalls).toHaveLength(3);
    const attachedKeys = harness.pool.attachCalls
      .map((c) => c.requestId)
      .sort();
    expect(attachedKeys).toEqual(entries.map((e) => e.entryId).sort());

    // No cascade — the chain resolved cleanly.
    expect(harness.cascadeWalker.cascadeCalls).toHaveLength(0);
  });

  it('partial chain (2 of 3 OK, 3rd PATH_NOT_INCLUDED then OK) — eventually drains to valid', async () => {
    // Realistic: req-C lags by one round (PATH_NOT_INCLUDED on first
    // poll) but anchors on retry. Queue still drains; terminal valid.
    const perRequestPoll = new Map<
      string,
      ReadonlyArray<{ kind: string }>
    >([
      [
        'req-A',
        [{ kind: 'OK', proof: makeProof(), newCid: NEW_CID }] as ReadonlyArray<{
          kind: string;
        }>,
      ],
      [
        'req-B',
        [{ kind: 'OK', proof: makeProof(), newCid: NEW_CID }],
      ],
      [
        'req-C',
        [
          { kind: 'PATH_NOT_INCLUDED' },
          { kind: 'OK', proof: makeProof(), newCid: NEW_CID },
        ],
      ],
    ]);
    // Cast through the fixture — the loose ReadonlyArray<{kind: string}>
    // shape is widened to PollOutcome[] inside the fake.
    const aggregator = makeFakeAggregator({
      perRequestPoll: perRequestPoll as unknown as Parameters<
        typeof makeFakeAggregator
      >[0]['perRequestPoll'],
    });
    const harness = buildWorker({ aggregator, maxProofErrorRetries: 5 });

    const reqs = ['req-A', 'req-B', 'req-C'];
    const entries = reqs.map((r, i) =>
      makeQueueEntry({ commitmentRequestId: r, txIndex: i }),
    );
    await seedQueue(harness, entries);

    const result = await harness.worker.processOneToken(entries[0].tokenId);

    expect(result.terminal).toBe('valid');
    expect(result.successCount).toBe(3);
    expect(result.hardFailCount).toBe(0);

    // req-C was polled at least twice (the not-included → OK retry).
    const cPolls = aggregator.pollCalls.filter((c) => c.requestId === 'req-C');
    expect(cPolls.length).toBeGreaterThanOrEqual(2);
  });
});
