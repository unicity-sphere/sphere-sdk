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
  tk,
} from './import-inclusion-proof-fixtures';

describe('§6.3 importInclusionProof — 10 sub-cases (W4)', () => {
  // ---------------------------------------------------------------------------
  // CASE 1 — token unknown to local manifest, no _invalid, no _audit.
  // ---------------------------------------------------------------------------
  it('CASE 1: unknown token → reason="no-such-token"', async () => {
    const h = buildImporterHarness();
    const result = await h.importer.importInclusionProof(
      ADDR,
      tk('unknown-token-zzz'),
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
    h.manifest.entries.set(`${ADDR}:${tk('t-already-valid')}`, manifestEntryFor({
      status: 'valid',
    }));
    const result = await h.importer.importInclusionProof(
      ADDR,
      tk('t-already-valid'),
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
    h.manifest.entries.set(`${ADDR}:${tk('t-pending')}`, manifestEntryFor({
      status: 'pending',
    }));
    h.queue.entries.push(queueEntryFor({
      tokenId: tk('t-pending'),
      commitmentRequestId: 'rq-3a',
      status: 'pending',
    }));
    const result = await h.importer.importInclusionProof(
      ADDR,
      tk('t-pending'),
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
    h.manifest.entries.set(`${ADDR}:${tk('t-pending2')}`, manifestEntryFor({
      status: 'pending',
    }));
    h.queue.entries.push(
      queueEntryFor({ tokenId: tk('t-pending2'), commitmentRequestId: 'rq-3a', status: 'pending' }),
      queueEntryFor({ tokenId: tk('t-pending2'), commitmentRequestId: 'rq-3b', status: 'pending', txIndex: 1 }),
    );
    const result = await h.importer.importInclusionProof(
      ADDR,
      tk('t-pending2'),
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
    h.manifest.entries.set(`${ADDR}:${tk('t-attached')}`, manifestEntryFor({
      status: 'pending',
    }));
    h.queue.entries.push(queueEntryFor({
      tokenId: tk('t-attached'),
      commitmentRequestId: 'rq-attached',
      status: 'attached', // §5.5 step 5 between 1-3 done and 4 removal
    }));
    const result = await h.importer.importInclusionProof(
      ADDR,
      tk('t-attached'),
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
    h.manifest.entries.set(`${ADDR}:${tk('t-mismatch')}`, manifestEntryFor({
      status: 'pending',
    }));
    h.queue.entries.push(queueEntryFor({
      tokenId: tk('t-mismatch'),
      commitmentRequestId: 'rq-some-other',
      status: 'pending',
    }));
    const result = await h.importer.importInclusionProof(
      ADDR,
      tk('t-mismatch'),
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
      `${ADDR}.invalid.${tk('t-bad')}.${'aa'.repeat(32)}`,
      invalidEntryFor({ tokenId: tk('t-bad'), reason: 'oracle-rejected' }),
    );
    // Manifest carries a stale rootHash so the importer's invalid
    // lookup uses the right key.
    h.manifest.entries.set(`${ADDR}:${tk('t-bad')}`, manifestEntryFor({
      status: 'invalid',
      invalidReason: 'oracle-rejected',
      rootHashHex: 'aa'.repeat(32),
    }));
    h.queue.entries.push(queueEntryFor({
      tokenId: tk('t-bad'),
      commitmentRequestId: 'rq-bad',
      status: 'hard-fail',
    }));
    const result = await h.importer.importInclusionProof(
      ADDR,
      tk('t-bad'),
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
      tokenId: tk('t-bad'),
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
      `${ADDR}.invalid.${tk('t-chain')}.${'bb'.repeat(32)}`,
      invalidEntryFor({ tokenId: tk('t-chain'), reason: 'oracle-rejected' }),
    );
    h.manifest.entries.set(`${ADDR}:${tk('t-chain')}`, manifestEntryFor({
      status: 'invalid',
      invalidReason: 'oracle-rejected',
      rootHashHex: 'bb'.repeat(32),
    }));
    // 3 hard-failed queue entries — proof targets the first; remaining
    // 2 should be re-queued.
    h.queue.entries.push(
      queueEntryFor({ tokenId: tk('t-chain'), commitmentRequestId: 'rq-c0', txIndex: 0, status: 'hard-fail' }),
      queueEntryFor({ tokenId: tk('t-chain'), commitmentRequestId: 'rq-c1', txIndex: 1, status: 'hard-fail' }),
      queueEntryFor({ tokenId: tk('t-chain'), commitmentRequestId: 'rq-c2', txIndex: 2, status: 'hard-fail' }),
    );
    const result = await h.importer.importInclusionProof(
      ADDR,
      tk('t-chain'),
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
      `${ADDR}.invalid.${tk('t-bad')}.${'aa'.repeat(32)}`,
      invalidEntryFor({ tokenId: tk('t-bad'), reason: 'oracle-rejected' }),
    );
    h.manifest.entries.set(`${ADDR}:${tk('t-bad')}`, manifestEntryFor({
      status: 'invalid',
      rootHashHex: 'aa'.repeat(32),
    }));
    h.queue.entries.push(queueEntryFor({
      tokenId: tk('t-bad'),
      commitmentRequestId: 'rq-bad',
      status: 'hard-fail',
    }));
    // Default: allowInvalidOverride = false.
    const result = await h.importer.importInclusionProof(
      ADDR,
      tk('t-bad'),
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
    h.manifest.entries.set(`${ADDR}:${tk('t-noinclusion')}`, manifestEntryFor({
      status: 'pending',
    }));
    h.queue.entries.push(queueEntryFor({
      tokenId: tk('t-noinclusion'),
      commitmentRequestId: 'rq-nope',
      status: 'pending',
    }));
    const result = await h.importer.importInclusionProof(
      ADDR,
      tk('t-noinclusion'),
      proofFor({ requestId: 'rq-nope' }),
    );
    expect(result).toEqual({ ok: false, reason: 'proof-not-anchored' });
    expect(h.graftCalls.length).toBe(0);
  });

  it('CASE 8: PATH_NOT_INCLUDED on _invalid path → reason="proof-not-anchored"', async () => {
    const h = buildImporterHarness({ verifyResult: 'PATH_NOT_INCLUDED' });
    // Invalid token; even with override flag, bad proof MUST NOT flip it.
    h.disposition.entries.set(
      `${ADDR}.invalid.${tk('t-bad-pna')}.${'aa'.repeat(32)}`,
      invalidEntryFor({ tokenId: tk('t-bad-pna') }),
    );
    h.manifest.entries.set(`${ADDR}:${tk('t-bad-pna')}`, manifestEntryFor({
      status: 'invalid',
      rootHashHex: 'aa'.repeat(32),
    }));
    const result = await h.importer.importInclusionProof(
      ADDR,
      tk('t-bad-pna'),
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
    h.manifest.entries.set(`${ADDR}:${tk('t-bad-proof')}`, manifestEntryFor({
      status: 'pending',
    }));
    h.queue.entries.push(queueEntryFor({
      tokenId: tk('t-bad-proof'),
      commitmentRequestId: 'rq-bad',
      status: 'pending',
    }));
    const result = await h.importer.importInclusionProof(
      ADDR,
      tk('t-bad-proof'),
      proofFor({ requestId: 'rq-bad' }),
    );
    expect(result).toEqual({ ok: false, reason: 'proof-trustbase-failed' });
  });

  it('CASE 9: NOT_AUTHENTICATED → reason="proof-trustbase-failed"', async () => {
    const h = buildImporterHarness({ verifyResult: 'NOT_AUTHENTICATED' });
    h.manifest.entries.set(`${ADDR}:${tk('t-not-auth')}`, manifestEntryFor({
      status: 'pending',
    }));
    const result = await h.importer.importInclusionProof(
      ADDR,
      tk('t-not-auth'),
      proofFor({ requestId: 'rq-x' }),
    );
    expect(result).toEqual({ ok: false, reason: 'proof-trustbase-failed' });
  });

  it('CASE 9: THROWN → reason="proof-trustbase-failed"', async () => {
    const h = buildImporterHarness({ verifyResult: 'THROWN' });
    h.manifest.entries.set(`${ADDR}:${tk('t-thrown')}`, manifestEntryFor({
      status: 'pending',
    }));
    const result = await h.importer.importInclusionProof(
      ADDR,
      tk('t-thrown'),
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
    h.manifest.entries.set(`${ADDR_ALT}:${tk('t-shared')}`, manifestEntryFor({
      status: 'valid',
    }));
    const result = await h.importer.importInclusionProof(
      ADDR,
      tk('t-shared'),
      proofFor({ requestId: 'rq-x' }),
    );
    // ADDR has no entry → case 1.
    expect(result).toEqual({ ok: false, reason: 'no-such-token' });
  });

  // ---------------------------------------------------------------------------
  // (#155) proof-binding-mismatch — pending path. The proof's requestId
  // matches an outstanding queue entry, but its transactionHash and/or
  // authenticator disagree with the queue entry's bound triple.
  // ---------------------------------------------------------------------------
  it('CASE 3 (#155): pending + transactionHash mismatch → reason="proof-binding-mismatch"', async () => {
    const h = buildImporterHarness();
    h.manifest.entries.set(`${ADDR}:${tk('t-tx-mismatch')}`, manifestEntryFor({
      status: 'pending',
    }));
    h.queue.entries.push(queueEntryFor({
      tokenId: tk('t-tx-mismatch'),
      commitmentRequestId: 'rq-tx',
      status: 'pending',
      transactionHash: '0000' + 'aa'.repeat(32),
      authenticator: 'authn-A',
    }));
    const result = await h.importer.importInclusionProof(
      ADDR,
      tk('t-tx-mismatch'),
      proofFor({
        requestId: 'rq-tx',
        // Different transactionHash — same requestId.
        transactionHash: '0000' + 'bb'.repeat(32),
        authenticator: 'authn-A',
      }),
    );
    expect(result).toEqual({ ok: false, reason: 'proof-binding-mismatch' });
    expect(h.graftCalls.length).toBe(0);
    expect(h.overrideCalls.length).toBe(0);
  });

  it('CASE 3 (#155): pending + authenticator mismatch → reason="proof-binding-mismatch"', async () => {
    const h = buildImporterHarness();
    h.manifest.entries.set(`${ADDR}:${tk('t-auth-mismatch')}`, manifestEntryFor({
      status: 'pending',
    }));
    h.queue.entries.push(queueEntryFor({
      tokenId: tk('t-auth-mismatch'),
      commitmentRequestId: 'rq-auth',
      status: 'pending',
      transactionHash: '0000' + 'aa'.repeat(32),
      authenticator: 'authn-A',
    }));
    const result = await h.importer.importInclusionProof(
      ADDR,
      tk('t-auth-mismatch'),
      proofFor({
        requestId: 'rq-auth',
        transactionHash: '0000' + 'aa'.repeat(32),
        authenticator: 'authn-B', // mismatch
      }),
    );
    expect(result).toEqual({ ok: false, reason: 'proof-binding-mismatch' });
    expect(h.graftCalls.length).toBe(0);
  });

  it('CASE 3 (#155): pending + case-different but byte-equal hex → graft accepted', async () => {
    const h = buildImporterHarness();
    h.manifest.entries.set(`${ADDR}:${tk('t-case')}`, manifestEntryFor({
      status: 'pending',
    }));
    h.queue.entries.push(queueEntryFor({
      tokenId: tk('t-case'),
      commitmentRequestId: 'rq-case',
      status: 'pending',
      transactionHash: '0000' + 'AB'.repeat(32),
      authenticator: 'AUTHn-X',
    }));
    const result = await h.importer.importInclusionProof(
      ADDR,
      tk('t-case'),
      proofFor({
        requestId: 'rq-case',
        // Same bytes, different case — must compare equal.
        transactionHash: '0000' + 'ab'.repeat(32),
        authenticator: 'authN-x',
      }),
    );
    expect(result).toEqual({ ok: true, transition: 'pending→valid' });
    expect(h.graftCalls.length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // (#155) proof-binding-mismatch — invalid path. An attacker who knows
  // the victim's tokenId + a hard-failed requestId could otherwise paste
  // any aggregator-anchored proof sharing that requestId and flip
  // `_invalid → valid`. The §6.3 most-recent-proof / single-spend
  // forbidden-case checks require the full triple to match.
  // ---------------------------------------------------------------------------
  it('CASE 5 (#155): _invalid + requestId match but transactionHash mismatch → reason="proof-binding-mismatch"', async () => {
    const h = buildImporterHarness();
    h.disposition.entries.set(
      `${ADDR}.invalid.${tk('t-evil')}.${'aa'.repeat(32)}`,
      invalidEntryFor({ tokenId: tk('t-evil'), reason: 'oracle-rejected' }),
    );
    h.manifest.entries.set(`${ADDR}:${tk('t-evil')}`, manifestEntryFor({
      status: 'invalid',
      invalidReason: 'oracle-rejected',
      rootHashHex: 'aa'.repeat(32),
    }));
    h.queue.entries.push(queueEntryFor({
      tokenId: tk('t-evil'),
      commitmentRequestId: 'rq-evil',
      status: 'hard-fail',
      transactionHash: '0000' + 'aa'.repeat(32),
      authenticator: 'authn-victim',
    }));
    const result = await h.importer.importInclusionProof(
      ADDR,
      tk('t-evil'),
      proofFor({
        // Attacker brings a different proof (different transaction)
        // that happens to share the requestId.
        requestId: 'rq-evil',
        transactionHash: '0000' + 'cc'.repeat(32),
        authenticator: 'authn-attacker',
      }),
      { allowInvalidOverride: true },
    );
    expect(result).toEqual({ ok: false, reason: 'proof-binding-mismatch' });
    // Override callback NOT invoked, no event emitted — the §5.6
    // monotonicity invariant remains intact.
    expect(h.overrideCalls.length).toBe(0);
    expect(
      h.events.events.filter((e) => e.type === 'transfer:override-applied').length,
    ).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // (#165) invalid-record-missing — manifest carries `status='invalid'`
  // but no `_invalid` record exists. Default behaviour is to refuse the
  // override; opt-in via `allowSyntheticInvalidEntry: true` to fall back
  // to synthesis from the manifest fields.
  // ---------------------------------------------------------------------------
  it('CASE invalid-record-missing (#165): manifest=invalid + no _invalid record → reason="invalid-record-missing"', async () => {
    const h = buildImporterHarness();
    h.manifest.entries.set(`${ADDR}:${tk('t-orphan')}`, manifestEntryFor({
      status: 'invalid',
      invalidReason: 'oracle-rejected',
      rootHashHex: 'aa'.repeat(32),
    }));
    // NB: no disposition entry written — structurally inconsistent.
    h.queue.entries.push(queueEntryFor({
      tokenId: tk('t-orphan'),
      commitmentRequestId: 'rq-orphan',
      status: 'hard-fail',
    }));
    const result = await h.importer.importInclusionProof(
      ADDR,
      tk('t-orphan'),
      proofFor({ requestId: 'rq-orphan' }),
      { allowInvalidOverride: true },
    );
    expect(result).toEqual({ ok: false, reason: 'invalid-record-missing' });
    expect(h.overrideCalls.length).toBe(0);
    expect(
      h.events.events.filter((e) => e.type === 'transfer:override-applied').length,
    ).toBe(0);
  });

  it('CASE invalid-record-missing (#165): allowSyntheticInvalidEntry=true falls back to synthesis', async () => {
    const h = buildImporterHarness();
    h.manifest.entries.set(`${ADDR}:${tk('t-orphan-ok')}`, manifestEntryFor({
      status: 'invalid',
      invalidReason: 'oracle-rejected',
      rootHashHex: 'aa'.repeat(32),
    }));
    h.queue.entries.push(queueEntryFor({
      tokenId: tk('t-orphan-ok'),
      commitmentRequestId: 'rq-orphan-ok',
      status: 'hard-fail',
    }));
    const result = await h.importer.importInclusionProof(
      ADDR,
      tk('t-orphan-ok'),
      proofFor({ requestId: 'rq-orphan-ok' }),
      {
        allowInvalidOverride: true,
        allowSyntheticInvalidEntry: true,
        currentTime: 1700000004000,
      },
    );
    expect(result).toEqual({ ok: true, transition: 'invalid→valid' });
    expect(h.overrideCalls.length).toBe(1);
    // The synthesized invalid entry has empty-string provenance — the
    // operator opted into accepting that loss.
    expect(h.overrideCalls[0]!.previousInvalidEntry.bundleCid).toBe('');
    expect(h.overrideCalls[0]!.previousInvalidEntry.senderTransportPubkey).toBe('');
  });

  it('CASE invalid-record-missing (#165): _invalid record present → falls through to case 5/6 (no synthesis)', async () => {
    // When both the manifest entry and the disposition record are
    // present, we use the disposition record (real provenance), not
    // the synthesized one.
    const h = buildImporterHarness();
    h.disposition.entries.set(
      `${ADDR}.invalid.${tk('t-paired')}.${'aa'.repeat(32)}`,
      invalidEntryFor({
        tokenId: tk('t-paired'),
        reason: 'oracle-rejected',
        bundleCid: 'bafy-real',
        senderTransportPubkey: 'pk-real',
      }),
    );
    h.manifest.entries.set(`${ADDR}:${tk('t-paired')}`, manifestEntryFor({
      status: 'invalid',
      invalidReason: 'oracle-rejected',
      rootHashHex: 'aa'.repeat(32),
    }));
    h.queue.entries.push(queueEntryFor({
      tokenId: tk('t-paired'),
      commitmentRequestId: 'rq-paired',
      status: 'hard-fail',
    }));
    const result = await h.importer.importInclusionProof(
      ADDR,
      tk('t-paired'),
      proofFor({ requestId: 'rq-paired' }),
      { allowInvalidOverride: true },
    );
    expect(result).toEqual({ ok: true, transition: 'invalid→valid' });
    expect(h.overrideCalls.length).toBe(1);
    // Real provenance preserved — not the empty-string synthesis.
    expect(h.overrideCalls[0]!.previousInvalidEntry.bundleCid).toBe('bafy-real');
    expect(h.overrideCalls[0]!.previousInvalidEntry.senderTransportPubkey).toBe('pk-real');
  });

  // ---------------------------------------------------------------------------
  // (Wave 3 steelman) invalid-tokenid — reject non-canonical tokenIds before
  // any storage probe. An attacker shaping a tokenId like `"../"` could
  // otherwise probe `_invalid` storage at an attacker-controlled key on a
  // backend that doesn't enforce key shape, then mis-apply the override
  // against a colliding sentinel-keyed record.
  // ---------------------------------------------------------------------------
  it('Wave 3 steelman: non-hex tokenId is rejected with reason="invalid-tokenid"', async () => {
    const h = buildImporterHarness();
    const result = await h.importer.importInclusionProof(
      ADDR,
      '../',
      proofFor({ requestId: 'rq-anything' }),
    );
    expect(result).toEqual({ ok: false, reason: 'invalid-tokenid' });
    // The reject fires BEFORE any storage probe — verifyProof / queue
    // scan / disposition read are NOT touched.
    expect(h.verifyCalls.length).toBe(0);
    expect(h.graftCalls.length).toBe(0);
    expect(h.overrideCalls.length).toBe(0);
    expect(h.events.events.length).toBe(0);
  });

  it('Wave 3 steelman: tokenId with wrong length is rejected', async () => {
    const h = buildImporterHarness();
    // 32 hex chars instead of 64.
    const result = await h.importer.importInclusionProof(
      ADDR,
      'ab'.repeat(16),
      proofFor({ requestId: 'rq' }),
    );
    expect(result).toEqual({ ok: false, reason: 'invalid-tokenid' });
  });

  it('Wave 3 steelman: empty tokenId is rejected', async () => {
    const h = buildImporterHarness();
    const result = await h.importer.importInclusionProof(
      ADDR,
      '',
      proofFor({ requestId: 'rq' }),
    );
    expect(result).toEqual({ ok: false, reason: 'invalid-tokenid' });
  });

  it('Wave 3 steelman: 64-char hex tokenId (canonical form) passes the validation gate', async () => {
    // Mixed case is allowed (case-insensitive validation).
    const h = buildImporterHarness();
    const id = 'AB'.repeat(32);
    const result = await h.importer.importInclusionProof(
      ADDR,
      id,
      proofFor({ requestId: 'rq' }),
    );
    // No manifest entry → CASE 1 'no-such-token' (not 'invalid-tokenid').
    expect(result).toEqual({ ok: false, reason: 'no-such-token' });
  });

  // ---------------------------------------------------------------------------
  // (Wave 3 steelman) requestid-ambiguous — defensive guard against a
  // queue scanner returning >1 matching entry for the same
  // (tokenId, commitmentRequestId). Production code paths cannot produce
  // duplicates, but a writer bug or CRDT concurrent-add could surface
  // them; silently picking matching[0] would risk applying the proof to
  // the wrong entry. Surface the ambiguity instead.
  // ---------------------------------------------------------------------------
  it('Wave 3 steelman: pending path — duplicate (tokenId, requestId) → reason="requestid-ambiguous"', async () => {
    const h = buildImporterHarness();
    const tid = tk('t-amb');
    h.manifest.entries.set(`${ADDR}:${tid}`, manifestEntryFor({
      status: 'pending',
    }));
    // Two queue entries with IDENTICAL (tokenId, commitmentRequestId).
    h.queue.entries.push(
      queueEntryFor({
        tokenId: tid,
        commitmentRequestId: 'rq-dup',
        status: 'pending',
        txIndex: 0,
      }),
      queueEntryFor({
        tokenId: tid,
        commitmentRequestId: 'rq-dup',
        status: 'pending',
        txIndex: 1, // distinct entry, same routing key
      }),
    );
    const result = await h.importer.importInclusionProof(
      ADDR,
      tid,
      proofFor({ requestId: 'rq-dup' }),
    );
    expect(result).toEqual({ ok: false, reason: 'requestid-ambiguous' });
    // Importer refuses to graft against an ambiguous match.
    expect(h.graftCalls.length).toBe(0);
    expect(h.overrideCalls.length).toBe(0);
  });

  it('Wave 3 steelman: invalid path — duplicate (tokenId, requestId) → reason="requestid-ambiguous"', async () => {
    const h = buildImporterHarness();
    const tid = tk('t-amb-inv');
    h.disposition.entries.set(
      `${ADDR}.invalid.${tid}.${'aa'.repeat(32)}`,
      invalidEntryFor({ tokenId: tid, reason: 'oracle-rejected' }),
    );
    h.manifest.entries.set(`${ADDR}:${tid}`, manifestEntryFor({
      status: 'invalid',
      invalidReason: 'oracle-rejected',
      rootHashHex: 'aa'.repeat(32),
    }));
    h.queue.entries.push(
      queueEntryFor({
        tokenId: tid,
        commitmentRequestId: 'rq-dup-inv',
        status: 'hard-fail',
        txIndex: 0,
      }),
      queueEntryFor({
        tokenId: tid,
        commitmentRequestId: 'rq-dup-inv',
        status: 'hard-fail',
        txIndex: 1,
      }),
    );
    const result = await h.importer.importInclusionProof(
      ADDR,
      tid,
      proofFor({ requestId: 'rq-dup-inv' }),
      { allowInvalidOverride: true },
    );
    expect(result).toEqual({ ok: false, reason: 'requestid-ambiguous' });
    // Override callback NOT invoked — the §5.6 monotonicity invariant
    // is preserved and the operator gets a distinct reason for triage.
    expect(h.overrideCalls.length).toBe(0);
    expect(
      h.events.events.filter((e) => e.type === 'transfer:override-applied').length,
    ).toBe(0);
  });
});
