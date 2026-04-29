/**
 * §11.2 integration — chain-mode merge / backup-import grafts mid-resolution.
 *
 * Spec scenario (§11.2):
 *   "Same chain [as 3-hop forward], but D imports a more-finalized
 *    backup of the same `tokenId` mid-resolution. The backup's proofs
 *    short-circuit the queue."
 *
 * In production, this corresponds to the operator's
 * `payments.importInclusionProof()` escape hatch (T.5.D, §6.3) being
 * called with a proof for a queue entry whose worker has not yet
 * polled. Path-traversal in {@link InclusionProofImporter}:
 *
 *   manifest.status === 'pending' → `_handlePendingPath` → graft
 *   callback fires (case 3) → if no more outstanding queue entries,
 *   return `'pending→valid'`; else return `'pending-still'`.
 *
 * Acceptance:
 *   (a) Import a proof for one of K=3 outstanding queue entries → case 3
 *       graft fires, transition is `'pending-still'` (2 entries remain).
 *   (b) Import proofs for the remaining 2 entries one at a time → the
 *       last import returns `'pending→valid'`. The graft callback is
 *       called once per import.
 *   (c) Importing a proof whose requestId is not in the queue (case 4b)
 *       returns `'requestid-mismatch'` and DOES NOT touch graft state.
 *
 * @packageDocumentation
 */

import { describe, expect, it } from 'vitest';

import {
  ADDR,
  buildImporterHarness,
  manifestEntryFor,
  proofFor,
  queueEntryFor,
} from '../../unit/payments/transfer/import-inclusion-proof-fixtures';

// =============================================================================
// 1. Tests
// =============================================================================

describe('§11.2 — chain-mode merge: backup-import grafts mid-resolution', () => {
  it('K=3 outstanding entries → import 1 → pending-still + 1 graft', async () => {
    const h = buildImporterHarness();
    const tokenId = 't-chain';

    // Manifest: pending (active pool). The chain has 3 outstanding
    // queue entries.
    h.manifest.entries.set(
      `${ADDR}:${tokenId}`,
      manifestEntryFor({ status: 'pending' }),
    );
    h.queue.entries.push(
      queueEntryFor({ tokenId, commitmentRequestId: 'req-c0', txIndex: 0 }),
      queueEntryFor({ tokenId, commitmentRequestId: 'req-c1', txIndex: 1 }),
      queueEntryFor({ tokenId, commitmentRequestId: 'req-c2', txIndex: 2 }),
    );

    // Operator pastes in a proof from the backup for req-c0 (the FIRST
    // hop, not the last). The other 2 entries remain.
    const result = await h.importer.importInclusionProof(
      ADDR,
      tokenId,
      proofFor({ requestId: 'req-c0' }),
    );

    expect(result).toEqual({ ok: true, transition: 'pending-still' });

    // The graft callback fired exactly once for the imported requestId.
    expect(h.graftCalls).toHaveLength(1);
    expect(h.graftCalls[0].tokenId).toBe(tokenId);
    expect(h.graftCalls[0].proof.requestId).toBe('req-c0');
    expect(h.graftCalls[0].queueEntry.commitmentRequestId).toBe('req-c0');

    // No override fired (we're on the pending path, not the invalid path).
    expect(h.overrideCalls).toHaveLength(0);
  });

  it('importing proofs for all 3 entries → final import returns pending→valid', async () => {
    const h = buildImporterHarness();
    const tokenId = 't-chain';
    h.manifest.entries.set(
      `${ADDR}:${tokenId}`,
      manifestEntryFor({ status: 'pending' }),
    );
    h.queue.entries.push(
      queueEntryFor({ tokenId, commitmentRequestId: 'req-c0', txIndex: 0 }),
      queueEntryFor({ tokenId, commitmentRequestId: 'req-c1', txIndex: 1 }),
      queueEntryFor({ tokenId, commitmentRequestId: 'req-c2', txIndex: 2 }),
    );

    // Import 1: c0 → pending-still (2 left).
    const r0 = await h.importer.importInclusionProof(
      ADDR,
      tokenId,
      proofFor({ requestId: 'req-c0' }),
    );
    expect(r0).toEqual({ ok: true, transition: 'pending-still' });

    // Simulate the graft fixture's downstream effect — remove the
    // grafted entry from the queue scanner's view so the next import's
    // "remaining" tally drops to 1, then 0.
    h.queue.entries.splice(
      h.queue.entries.findIndex((e) => e.commitmentRequestId === 'req-c0'),
      1,
    );

    // Import 2: c1 → pending-still (1 left).
    const r1 = await h.importer.importInclusionProof(
      ADDR,
      tokenId,
      proofFor({ requestId: 'req-c1' }),
    );
    expect(r1).toEqual({ ok: true, transition: 'pending-still' });
    h.queue.entries.splice(
      h.queue.entries.findIndex((e) => e.commitmentRequestId === 'req-c1'),
      1,
    );

    // Import 3: c2 → pending→valid (no entries left).
    const r2 = await h.importer.importInclusionProof(
      ADDR,
      tokenId,
      proofFor({ requestId: 'req-c2' }),
    );
    expect(r2).toEqual({ ok: true, transition: 'pending→valid' });

    // 3 grafts in total.
    expect(h.graftCalls).toHaveLength(3);
    expect(h.graftCalls.map((g) => g.proof.requestId)).toEqual([
      'req-c0',
      'req-c1',
      'req-c2',
    ]);
  });

  it('proof for unknown requestId → requestid-mismatch (no graft, no state mutation)', async () => {
    const h = buildImporterHarness();
    const tokenId = 't-chain';
    h.manifest.entries.set(
      `${ADDR}:${tokenId}`,
      manifestEntryFor({ status: 'pending' }),
    );
    h.queue.entries.push(
      queueEntryFor({ tokenId, commitmentRequestId: 'req-c0', txIndex: 0 }),
    );

    // Operator pastes in a proof whose requestId DOES NOT match any
    // outstanding queue entry. The importer's case 4b → reject; the
    // graft callback MUST NOT fire and the queue MUST stay intact.
    const result = await h.importer.importInclusionProof(
      ADDR,
      tokenId,
      proofFor({ requestId: 'req-not-in-queue' }),
    );
    expect(result).toEqual({ ok: false, reason: 'requestid-mismatch' });
    expect(h.graftCalls).toHaveLength(0);
    expect(h.overrideCalls).toHaveLength(0);
    // Queue still carries the 1 outstanding entry.
    expect(h.queue.entries).toHaveLength(1);
  });

  it('replay (already-attached entry) → pending-still, NO new graft', async () => {
    // The §5.5 lifecycle marks an entry `'attached'` in the brief
    // window after the graft completes but before queue removal.
    // Importing the same proof again in that window is a no-op.
    const h = buildImporterHarness();
    const tokenId = 't-chain';
    h.manifest.entries.set(
      `${ADDR}:${tokenId}`,
      manifestEntryFor({ status: 'pending' }),
    );
    h.queue.entries.push(
      queueEntryFor({
        tokenId,
        commitmentRequestId: 'req-c0',
        txIndex: 0,
        status: 'attached',
      }),
    );

    const result = await h.importer.importInclusionProof(
      ADDR,
      tokenId,
      proofFor({ requestId: 'req-c0' }),
    );
    expect(result).toEqual({ ok: true, transition: 'pending-still' });
    // Replay path → graft NOT re-invoked.
    expect(h.graftCalls).toHaveLength(0);
  });
});
