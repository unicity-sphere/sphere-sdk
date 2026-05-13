/**
 * UXF Transfer T.5.B — §6.3 most-recent-proof tombstone path (W16).
 *
 * Spec wording (§6.3):
 *   "If the local manifest already has a proof for a queue entry's
 *    requestId, and a fresh poll returns a NEWER proof for the same
 *    value, the worker:
 *     - Verifies the new proof against trustBase.
 *     - Replaces the old proof element in the pool with the new one.
 *     - Updates the manifest CID rewrite (per §5.5 step 5) — the
 *       token's CBOR encoding now embeds the newer proof, so its
 *       CID changes; tombstone the previous CID.
 *     - Does NOT alter the queue entry's status."
 *
 * Acceptance (W16):
 *   "most-recent-proof tombstone-after-replacement path triggered by
 *    FRESH proof for already-attached requestId."
 *
 * The "newer proof, same value" determination uses the BFT round
 * number (or first-observed timestamp) per §6.3. This test exercises
 * the round-number branch.
 *
 * The "different value" path (security-alert) is exercised in the
 * adversarial test `tests/adversarial/transfer/conflicting-proofs-
 * same-requestid.test.ts` (C10).
 */

import { describe, expect, it } from 'vitest';

import {
  buildWorker,
  makeFakeAggregator,
  makeFakePoolRead,
  makeOutboxEntry,
  makeProof,
  NEW_CID,
  TOKEN_ID,
  REQUEST_ID,
  LOCAL_TX_HASH,
  LOCAL_AUTHENTICATOR,
} from './finalization-worker-sender-fixtures';

describe('§6.3 most-recent-proof tombstone (W16)', () => {
  it('FRESH (higher round) proof for already-attached requestId → replace + emit superseded', async () => {
    // Pre-seed the pool's read-side with an older proof at round=50.
    // The new poll returns the SAME value but at round=100 — the
    // fresher proof wins per §6.3.
    const olderProof = makeProof({ roundNumber: 50 });
    const newerProof = makeProof({ roundNumber: 100 });
    const poolRead = makeFakePoolRead([
      { tokenId: TOKEN_ID, requestId: REQUEST_ID, proof: olderProof },
    ]);
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'SUCCESS' }),
      poll: async () => ({
        kind: 'OK',
        proof: newerProof,
        newCid: NEW_CID,
      }),
    });
    const h = buildWorker({ aggregator, poolRead });
    const result = await h.worker.processOne(makeOutboxEntry());

    expect(result.terminal).toBe('finalized');
    // transfer:proof-superseded emitted.
    const supersededEvents = h.events.events.filter(
      (e) => e.type === 'transfer:proof-superseded',
    );
    expect(supersededEvents).toHaveLength(1);
    const data = supersededEvents[0]!.data as {
      tokenId: string;
      requestId: string;
      previousCid: string;
      newCid: string;
    };
    expect(data.tokenId).toBe(TOKEN_ID);
    expect(data.requestId).toBe(REQUEST_ID);
    expect(data.newCid).toBe(NEW_CID);
  });

  it('OLDER or equal-round proof for already-attached requestId → no replacement', async () => {
    // Existing proof at round=100; new poll at round=50 — STALE. The
    // worker still treats this as success (the proof is valid), but
    // does NOT supersede the existing one.
    const existing = makeProof({ roundNumber: 100 });
    const stale = makeProof({ roundNumber: 50 });
    const poolRead = makeFakePoolRead([
      { tokenId: TOKEN_ID, requestId: REQUEST_ID, proof: existing },
    ]);
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'SUCCESS' }),
      poll: async () => ({
        kind: 'OK',
        proof: stale,
        newCid: NEW_CID,
      }),
    });
    const h = buildWorker({ aggregator, poolRead });
    await h.worker.processOne(makeOutboxEntry());

    const supersededEvents = h.events.events.filter(
      (e) => e.type === 'transfer:proof-superseded',
    );
    expect(supersededEvents).toHaveLength(0);
  });

  it('FRESH path: new manifest CID is the post-rewrite hash; previous CID is tombstoned', async () => {
    const olderProof = makeProof({ roundNumber: 50 });
    const newerProof = makeProof({ roundNumber: 100 });
    const poolRead = makeFakePoolRead([
      { tokenId: TOKEN_ID, requestId: REQUEST_ID, proof: olderProof },
    ]);
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'SUCCESS' }),
      poll: async () => ({
        kind: 'OK',
        proof: newerProof,
        newCid: NEW_CID,
      }),
    });
    const h = buildWorker({ aggregator, poolRead });
    await h.worker.processOne(makeOutboxEntry());

    // The 4-step write order ran — new CID written, previous CID
    // tombstoned (per §5.5 step 5 step 3).
    expect(h.tombstones.insertCalls).toHaveLength(1);
    expect(h.tombstones.insertCalls[0]!.tokenId).toBe(TOKEN_ID);
  });

  it('first-time attachment (no prior proof) does NOT emit superseded', async () => {
    const aggregator = makeFakeAggregator(); // returns OK with default proof
    const h = buildWorker({ aggregator });
    await h.worker.processOne(makeOutboxEntry());

    const supersededEvents = h.events.events.filter(
      (e) => e.type === 'transfer:proof-superseded',
    );
    expect(supersededEvents).toHaveLength(0);
  });

  it('uses (transactionHash, authenticator) as same-value discriminator', async () => {
    // Same transactionHash + same authenticator + higher round → superseded.
    const oldProof = makeProof({
      transactionHash: LOCAL_TX_HASH,
      authenticator: LOCAL_AUTHENTICATOR,
      roundNumber: 50,
    });
    const newProof = makeProof({
      transactionHash: LOCAL_TX_HASH,
      authenticator: LOCAL_AUTHENTICATOR,
      roundNumber: 200,
    });
    const poolRead = makeFakePoolRead([
      { tokenId: TOKEN_ID, requestId: REQUEST_ID, proof: oldProof },
    ]);
    const aggregator = makeFakeAggregator({
      submit: async () => ({ kind: 'SUCCESS' }),
      poll: async () => ({
        kind: 'OK',
        proof: newProof,
        newCid: NEW_CID,
      }),
    });
    const h = buildWorker({ aggregator, poolRead });
    await h.worker.processOne(makeOutboxEntry());

    const supersededEvents = h.events.events.filter(
      (e) => e.type === 'transfer:proof-superseded',
    );
    expect(supersededEvents).toHaveLength(1);
  });
});
