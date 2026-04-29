/**
 * UXF Transfer T.5.D — `importInclusionProof()` 10 sub-cases (§6.3).
 *
 * Acceptance test for the W4 acceptance: every one of cases
 * 1, 2, 3, 4a, 4b, 5, 6, 7, 8, 9 is exercised against a deterministic
 * fixture. Each case tests:
 *  - The function returns the spec-mandated discriminator
 *    (`{ ok: true, transition }` OR `{ ok: false, reason }`).
 *  - Cases 5 / 6 invoke the override callback EXACTLY ONCE with the
 *    correct `transition` discriminator.
 *  - Cases 5 / 6 emit `transfer:override-applied` EXACTLY ONCE.
 *  - Cases 1, 2, 4a, 4b, 7, 8, 9 do NOT invoke any callback or emit
 *    any event (no state mutation).
 */

import { describe, expect, it } from 'vitest';

import {
  ADDR,
  ADDR_ALT,
  buildImporterHarness,
  invalidEntryFor,
  manifestEntryFor,
  proofFor,
  queueEntryFor,
} from './import-inclusion-proof-fixtures';

describe('§6.3 importInclusionProof — 10 sub-cases (W4)', () => {
  // ---------------------------------------------------------------------------
  // CASE 1 — token unknown to local manifest, no _invalid, no _audit.
  // ---------------------------------------------------------------------------
  it('CASE 1: unknown token → reason="no-such-token"', async () => {
    const h = buildImporterHarness();
    const result = await h.importer.importInclusionProof(
      ADDR,
      'unknown-token-zzz',
      proofFor({ requestId: 'rq-foo' }),
    );
    expect(result).toEqual({ ok: false, reason: 'no-such-token' });
    expect(h.graftCalls.length).toBe(0);
    expect(h.overrideCalls.length).toBe(0);
    expect(h.events.events.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // CASE 2 — token already valid → idempotent no-op.
  // ---------------------------------------------------------------------------
  it('CASE 2: token already valid → transition="pending-still"', async () => {
    const h = buildImporterHarness();
    h.manifest.entries.set(`${ADDR}:t-already-valid`, manifestEntryFor({
      status: 'valid',
    }));
    const result = await h.importer.importInclusionProof(
      ADDR,
      't-already-valid',
      proofFor({ requestId: 'rq-foo' }),
    );
    expect(result).toEqual({ ok: true, transition: 'pending-still' });
    // No proof verification was performed (case 2 returns before).
    expect(h.verifyCalls.length).toBe(0);
    expect(h.graftCalls.length).toBe(0);
    expect(h.overrideCalls.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // CASE 3 — token pending; proof matches an outstanding queue entry.
  // ---------------------------------------------------------------------------
  it('CASE 3: pending + outstanding requestId → graft → "pending→valid" (last)', async () => {
    const h = buildImporterHarness();
    h.manifest.entries.set(`${ADDR}:t-pending`, manifestEntryFor({
      status: 'pending',
    }));
    h.queue.entries.push(queueEntryFor({
      tokenId: 't-pending',
      commitmentRequestId: 'rq-3a',
      status: 'pending',
    }));
    const result = await h.importer.importInclusionProof(
      ADDR,
      't-pending',
      proofFor({ requestId: 'rq-3a' }),
    );
    expect(result).toEqual({ ok: true, transition: 'pending→valid' });
    expect(h.graftCalls.length).toBe(1);
    expect(h.graftCalls[0]!.queueEntry.commitmentRequestId).toBe('rq-3a');
    expect(h.overrideCalls.length).toBe(0);
    // No override-applied event for case 3.
    expect(
      h.events.events.filter((e) => e.type === 'transfer:override-applied').length,
    ).toBe(0);
  });

  it('CASE 3: pending + outstanding requestId AND more remaining → "pending-still"', async () => {
    const h = buildImporterHarness();
    h.manifest.entries.set(`${ADDR}:t-pending2`, manifestEntryFor({
      status: 'pending',
    }));
    h.queue.entries.push(
      queueEntryFor({ tokenId: 't-pending2', commitmentRequestId: 'rq-3a', status: 'pending' }),
      queueEntryFor({ tokenId: 't-pending2', commitmentRequestId: 'rq-3b', status: 'pending', txIndex: 1 }),
    );
    const result = await h.importer.importInclusionProof(
      ADDR,
      't-pending2',
      proofFor({ requestId: 'rq-3a' }),
    );
    expect(result).toEqual({ ok: true, transition: 'pending-still' });
    expect(h.graftCalls.length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // CASE 4a — pending + completed requestId already attached → idempotent.
  // ---------------------------------------------------------------------------
  it('CASE 4a: pending + already-attached → transition="pending-still"', async () => {
    const h = buildImporterHarness();
    h.manifest.entries.set(`${ADDR}:t-attached`, manifestEntryFor({
      status: 'pending',
    }));
    h.queue.entries.push(queueEntryFor({
      tokenId: 't-attached',
      commitmentRequestId: 'rq-attached',
      status: 'attached', // §5.5 step 5 between 1-3 done and 4 removal
    }));
    const result = await h.importer.importInclusionProof(
      ADDR,
      't-attached',
      proofFor({ requestId: 'rq-attached' }),
    );
    expect(result).toEqual({ ok: true, transition: 'pending-still' });
    expect(h.graftCalls.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // CASE 4b — pending; proof's requestId matches NO outstanding/completed.
  // ---------------------------------------------------------------------------
  it('CASE 4b: pending + requestId mismatch → reason="requestid-mismatch"', async () => {
    const h = buildImporterHarness();
    h.manifest.entries.set(`${ADDR}:t-mismatch`, manifestEntryFor({
      status: 'pending',
    }));
    h.queue.entries.push(queueEntryFor({
      tokenId: 't-mismatch',
      commitmentRequestId: 'rq-some-other',
      status: 'pending',
    }));
    const result = await h.importer.importInclusionProof(
      ADDR,
      't-mismatch',
      proofFor({ requestId: 'rq-NOT-HERE' }),
    );
    expect(result).toEqual({ ok: false, reason: 'requestid-mismatch' });
    expect(h.graftCalls.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // CASE 5 — invalid + override + EXACTLY ONE hard-failed entry → flip valid.
  // ---------------------------------------------------------------------------
  it('CASE 5: _invalid + allowInvalidOverride + 1 hard-fail → "invalid→valid"', async () => {
    const h = buildImporterHarness();
    // Invalid record exists.
    h.disposition.entries.set(
      `${ADDR}.invalid.t-bad.${'aa'.repeat(32)}`,
      invalidEntryFor({ tokenId: 't-bad', reason: 'oracle-rejected' }),
    );
    // Manifest carries a stale rootHash so the importer's invalid
    // lookup uses the right key.
    h.manifest.entries.set(`${ADDR}:t-bad`, manifestEntryFor({
      status: 'invalid',
      invalidReason: 'oracle-rejected',
      rootHashHex: 'aa'.repeat(32),
    }));
    h.queue.entries.push(queueEntryFor({
      tokenId: 't-bad',
      commitmentRequestId: 'rq-bad',
      status: 'hard-fail',
    }));
    const result = await h.importer.importInclusionProof(
      ADDR,
      't-bad',
      proofFor({ requestId: 'rq-bad' }),
      { allowInvalidOverride: true, currentTime: 1700000001000, operatorPubkey: 'op-pk-1' },
    );
    expect(result).toEqual({ ok: true, transition: 'invalid→valid' });
    expect(h.overrideCalls.length).toBe(1);
    const ov = h.overrideCalls[0]!;
    expect(ov.transition).toBe('invalid→valid');
    expect(ov.previousReason).toBe('oracle-rejected');
    expect(ov.requeueEntries.length).toBe(0);
    expect(ov.now).toBe(1700000001000);
    expect(ov.operatorPubkey).toBe('op-pk-1');
    // transfer:override-applied event emitted exactly once.
    const oe = h.events.events.filter(
      (e) => e.type === 'transfer:override-applied',
    );
    expect(oe.length).toBe(1);
    expect(oe[0]!.data).toEqual({
      tokenId: 't-bad',
      overrideAppliedAt: 1700000001000,
      overrideAppliedBy: 'op-pk-1',
      previousReason: 'oracle-rejected',
      transition: 'invalid→valid',
    });
  });

  // ---------------------------------------------------------------------------
  // CASE 6 — invalid + override + MULTIPLE hard-failed entries → K-1 re-queue.
  // ---------------------------------------------------------------------------
  it('CASE 6: _invalid + allowInvalidOverride + multiple hard-fail → "invalid→pending"', async () => {
    const h = buildImporterHarness();
    h.disposition.entries.set(
      `${ADDR}.invalid.t-chain.${'bb'.repeat(32)}`,
      invalidEntryFor({ tokenId: 't-chain', reason: 'oracle-rejected' }),
    );
    h.manifest.entries.set(`${ADDR}:t-chain`, manifestEntryFor({
      status: 'invalid',
      invalidReason: 'oracle-rejected',
      rootHashHex: 'bb'.repeat(32),
    }));
    // 3 hard-failed queue entries — proof targets the first; remaining
    // 2 should be re-queued.
    h.queue.entries.push(
      queueEntryFor({ tokenId: 't-chain', commitmentRequestId: 'rq-c0', txIndex: 0, status: 'hard-fail' }),
      queueEntryFor({ tokenId: 't-chain', commitmentRequestId: 'rq-c1', txIndex: 1, status: 'hard-fail' }),
      queueEntryFor({ tokenId: 't-chain', commitmentRequestId: 'rq-c2', txIndex: 2, status: 'hard-fail' }),
    );
    const result = await h.importer.importInclusionProof(
      ADDR,
      't-chain',
      proofFor({ requestId: 'rq-c0' }),
      { allowInvalidOverride: true, currentTime: 1700000002000 },
    );
    expect(result).toEqual({ ok: true, transition: 'invalid→pending' });
    expect(h.overrideCalls.length).toBe(1);
    const ov = h.overrideCalls[0]!;
    expect(ov.transition).toBe('invalid→pending');
    // K-1 re-queue: 2 of the 3 entries should be re-queued (not the
    // resolving one).
    expect(ov.requeueEntries.length).toBe(2);
    const reqIds = ov.requeueEntries.map((e) => e.commitmentRequestId).sort();
    expect(reqIds).toEqual(['rq-c1', 'rq-c2']);
    // override-applied event with transition='invalid→pending'.
    const oe = h.events.events.filter(
      (e) => e.type === 'transfer:override-applied',
    );
    expect(oe.length).toBe(1);
    expect((oe[0]!.data as { transition: string }).transition).toBe(
      'invalid→pending',
    );
  });

  // ---------------------------------------------------------------------------
  // CASE 7 — _invalid AND override flag missing → reject.
  // ---------------------------------------------------------------------------
  it('CASE 7: _invalid + no override flag → reason="tokenId-in-invalid"', async () => {
    const h = buildImporterHarness();
    h.disposition.entries.set(
      `${ADDR}.invalid.t-bad.${'aa'.repeat(32)}`,
      invalidEntryFor({ tokenId: 't-bad', reason: 'oracle-rejected' }),
    );
    h.manifest.entries.set(`${ADDR}:t-bad`, manifestEntryFor({
      status: 'invalid',
      rootHashHex: 'aa'.repeat(32),
    }));
    h.queue.entries.push(queueEntryFor({
      tokenId: 't-bad',
      commitmentRequestId: 'rq-bad',
      status: 'hard-fail',
    }));
    // Default: allowInvalidOverride = false.
    const result = await h.importer.importInclusionProof(
      ADDR,
      't-bad',
      proofFor({ requestId: 'rq-bad' }),
    );
    expect(result).toEqual({ ok: false, reason: 'tokenId-in-invalid' });
    expect(h.overrideCalls.length).toBe(0);
    // override-applied NOT emitted.
    expect(
      h.events.events.filter((e) => e.type === 'transfer:override-applied').length,
    ).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // CASE 8 — proof verify returns PATH_NOT_INCLUDED.
  // ---------------------------------------------------------------------------
  it('CASE 8: PATH_NOT_INCLUDED → reason="proof-not-anchored"', async () => {
    const h = buildImporterHarness({ verifyResult: 'PATH_NOT_INCLUDED' });
    h.manifest.entries.set(`${ADDR}:t-noinclusion`, manifestEntryFor({
      status: 'pending',
    }));
    h.queue.entries.push(queueEntryFor({
      tokenId: 't-noinclusion',
      commitmentRequestId: 'rq-nope',
      status: 'pending',
    }));
    const result = await h.importer.importInclusionProof(
      ADDR,
      't-noinclusion',
      proofFor({ requestId: 'rq-nope' }),
    );
    expect(result).toEqual({ ok: false, reason: 'proof-not-anchored' });
    expect(h.graftCalls.length).toBe(0);
  });

  it('CASE 8: PATH_NOT_INCLUDED on _invalid path → reason="proof-not-anchored"', async () => {
    const h = buildImporterHarness({ verifyResult: 'PATH_NOT_INCLUDED' });
    // Invalid token; even with override flag, bad proof MUST NOT flip it.
    h.disposition.entries.set(
      `${ADDR}.invalid.t-bad-pna.${'aa'.repeat(32)}`,
      invalidEntryFor({ tokenId: 't-bad-pna' }),
    );
    h.manifest.entries.set(`${ADDR}:t-bad-pna`, manifestEntryFor({
      status: 'invalid',
      rootHashHex: 'aa'.repeat(32),
    }));
    const result = await h.importer.importInclusionProof(
      ADDR,
      't-bad-pna',
      proofFor({ requestId: 'rq-anything' }),
      { allowInvalidOverride: true },
    );
    expect(result).toEqual({ ok: false, reason: 'proof-not-anchored' });
    expect(h.overrideCalls.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // CASE 9 — proof verify returns PATH_INVALID / NOT_AUTHENTICATED.
  // ---------------------------------------------------------------------------
  it('CASE 9: PATH_INVALID → reason="proof-trustbase-failed"', async () => {
    const h = buildImporterHarness({ verifyResult: 'PATH_INVALID' });
    h.manifest.entries.set(`${ADDR}:t-bad-proof`, manifestEntryFor({
      status: 'pending',
    }));
    h.queue.entries.push(queueEntryFor({
      tokenId: 't-bad-proof',
      commitmentRequestId: 'rq-bad',
      status: 'pending',
    }));
    const result = await h.importer.importInclusionProof(
      ADDR,
      't-bad-proof',
      proofFor({ requestId: 'rq-bad' }),
    );
    expect(result).toEqual({ ok: false, reason: 'proof-trustbase-failed' });
  });

  it('CASE 9: NOT_AUTHENTICATED → reason="proof-trustbase-failed"', async () => {
    const h = buildImporterHarness({ verifyResult: 'NOT_AUTHENTICATED' });
    h.manifest.entries.set(`${ADDR}:t-not-auth`, manifestEntryFor({
      status: 'pending',
    }));
    const result = await h.importer.importInclusionProof(
      ADDR,
      't-not-auth',
      proofFor({ requestId: 'rq-x' }),
    );
    expect(result).toEqual({ ok: false, reason: 'proof-trustbase-failed' });
  });

  it('CASE 9: THROWN → reason="proof-trustbase-failed"', async () => {
    const h = buildImporterHarness({ verifyResult: 'THROWN' });
    h.manifest.entries.set(`${ADDR}:t-thrown`, manifestEntryFor({
      status: 'pending',
    }));
    const result = await h.importer.importInclusionProof(
      ADDR,
      't-thrown',
      proofFor({ requestId: 'rq-x' }),
    );
    expect(result).toEqual({ ok: false, reason: 'proof-trustbase-failed' });
  });

  // ---------------------------------------------------------------------------
  // Cross-cutting: address scoping — entries for one address do NOT bleed
  // into another address's lookup.
  // ---------------------------------------------------------------------------
  it('address scoping: entries for ADDR_ALT do not satisfy a lookup for ADDR', async () => {
    const h = buildImporterHarness();
    h.manifest.entries.set(`${ADDR_ALT}:t-shared`, manifestEntryFor({
      status: 'valid',
    }));
    const result = await h.importer.importInclusionProof(
      ADDR,
      't-shared',
      proofFor({ requestId: 'rq-x' }),
    );
    // ADDR has no entry → case 1.
    expect(result).toEqual({ ok: false, reason: 'no-such-token' });
  });
});
