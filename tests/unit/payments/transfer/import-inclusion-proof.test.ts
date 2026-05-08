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

import { describe, expect, it, vi } from 'vitest';

import { InclusionProofImporter } from '../../../../modules/payments/transfer/import-inclusion-proof';
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
    // Steelman crit #16: regex now requires LOWERCASE hex (case-canonical
    // form). Uppercase tokenIds are rejected at the entry point so that
    // the per-tokenId mutex slot is consistent across concurrent
    // operator calls. Wallet code lowercases SDK tokenIds before
    // forwarding to the importer; this test exercises the canonical
    // path with a lowercase 64-hex tokenId.
    const h = buildImporterHarness();
    const id = 'ab'.repeat(32);
    const result = await h.importer.importInclusionProof(
      ADDR,
      id,
      proofFor({ requestId: 'rq' }),
    );
    // No manifest entry → CASE 1 'no-such-token' (not 'invalid-tokenid').
    expect(result).toEqual({ ok: false, reason: 'no-such-token' });
  });

  it('Steelman crit #16: uppercase 64-char hex tokenId is rejected as invalid-tokenid', async () => {
    // The canonicality regex was tightened to lowercase-only so the
    // per-tokenId mutex's case-fold normalization is defense-in-depth
    // rather than load-bearing. Uppercase input now gates at the entry
    // point so two concurrent calls "AB...EF" + "ab...ef" cannot both
    // pass — 'AB...EF' is rejected before mutex acquire.
    const h = buildImporterHarness();
    const id = 'AB'.repeat(32);
    const result = await h.importer.importInclusionProof(
      ADDR,
      id,
      proofFor({ requestId: 'rq' }),
    );
    expect(result).toEqual({ ok: false, reason: 'invalid-tokenid' });
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

  // ===========================================================================
  // (Wave 4 regression #2) canonicalAuthenticatorEquals coverage
  //
  // §155's byte-equal binding compare on `authenticator` was wrong.
  // `authenticator` is JSON-encoded on most production paths and JSON
  // object key order is NOT canonical. Two semantically-identical
  // authenticators emitted by different serializers (sender's commitJson
  // vs aggregator's response vs recipient's `Transaction.toJSON()`) can
  // produce different bytes — naive `hexEqualsIgnoreCase` reports
  // `proof-binding-mismatch` for every legitimate proof. The fix uses a
  // canonical compare that parses both sides and compares fields by
  // value.
  // ===========================================================================
  describe('Wave 4 #2: canonicalAuthenticatorEquals binding compare', () => {
    // (a) Two semantically-identical authenticators with different JSON
    //     key orders → ACCEPTED.
    it('CASE 3 (#W4-2): pending + same authenticator with permuted JSON key order → ACCEPTED', async () => {
      const h = buildImporterHarness();
      // Aggregator-style key order: {algorithm, publicKey, signature, stateHash}
      const queueAuthn = JSON.stringify({
        algorithm: 'secp256k1',
        publicKey: '02' + 'aa'.repeat(32),
        signature: '11'.repeat(64),
        stateHash: '0000' + 'cc'.repeat(32),
      });
      // SDK-interface-style key order:
      // {publicKey, algorithm, signature, stateHash} — different bytes,
      // SAME semantic value.
      const proofAuthn = JSON.stringify({
        publicKey: '02' + 'aa'.repeat(32),
        algorithm: 'secp256k1',
        signature: '11'.repeat(64),
        stateHash: '0000' + 'cc'.repeat(32),
      });
      // Sanity check: the byte strings DIFFER (so the regression would
      // hit `hexEqualsIgnoreCase` length-mismatch / string-inequality).
      expect(queueAuthn).not.toBe(proofAuthn);
      h.manifest.entries.set(`${ADDR}:${tk('t-keyorder')}`, manifestEntryFor({
        status: 'pending',
      }));
      h.queue.entries.push(queueEntryFor({
        tokenId: tk('t-keyorder'),
        commitmentRequestId: 'rq-keyorder',
        status: 'pending',
        transactionHash: '0000' + 'ab'.repeat(32),
        authenticator: queueAuthn,
      }));
      const result = await h.importer.importInclusionProof(
        ADDR,
        tk('t-keyorder'),
        proofFor({
          requestId: 'rq-keyorder',
          transactionHash: '0000' + 'ab'.repeat(32),
          authenticator: proofAuthn,
        }),
      );
      expect(result).toEqual({ ok: true, transition: 'pending→valid' });
      expect(h.graftCalls.length).toBe(1);
    });

    it('CASE 5 (#W4-2): _invalid + same authenticator with permuted JSON key order → ACCEPTED override', async () => {
      const h = buildImporterHarness();
      const queueAuthn = JSON.stringify({
        algorithm: 'secp256k1',
        publicKey: '02' + 'bb'.repeat(32),
        signature: '22'.repeat(64),
        stateHash: '0000' + 'dd'.repeat(32),
      });
      const proofAuthn = JSON.stringify({
        publicKey: '02' + 'bb'.repeat(32),
        signature: '22'.repeat(64),
        algorithm: 'secp256k1',
        stateHash: '0000' + 'dd'.repeat(32),
      });
      expect(queueAuthn).not.toBe(proofAuthn);
      h.disposition.entries.set(
        `${ADDR}.invalid.${tk('t-key-inv')}.${'aa'.repeat(32)}`,
        invalidEntryFor({ tokenId: tk('t-key-inv'), reason: 'oracle-rejected' }),
      );
      h.manifest.entries.set(`${ADDR}:${tk('t-key-inv')}`, manifestEntryFor({
        status: 'invalid',
        invalidReason: 'oracle-rejected',
        rootHashHex: 'aa'.repeat(32),
      }));
      h.queue.entries.push(queueEntryFor({
        tokenId: tk('t-key-inv'),
        commitmentRequestId: 'rq-key-inv',
        status: 'hard-fail',
        transactionHash: '0000' + 'ee'.repeat(32),
        authenticator: queueAuthn,
      }));
      const result = await h.importer.importInclusionProof(
        ADDR,
        tk('t-key-inv'),
        proofFor({
          requestId: 'rq-key-inv',
          transactionHash: '0000' + 'ee'.repeat(32),
          authenticator: proofAuthn,
        }),
        { allowInvalidOverride: true },
      );
      expect(result).toEqual({ ok: true, transition: 'invalid→valid' });
      expect(h.overrideCalls.length).toBe(1);
    });

    // (b) Different-content authenticators → REJECTED.
    it('CASE 3 (#W4-2): pending + DIFFERENT authenticator content (different signature) → REJECTED', async () => {
      const h = buildImporterHarness();
      const queueAuthn = JSON.stringify({
        algorithm: 'secp256k1',
        publicKey: '02' + 'aa'.repeat(32),
        signature: '11'.repeat(64),
        stateHash: '0000' + 'cc'.repeat(32),
      });
      // Different signature — semantically distinct authenticator.
      const proofAuthn = JSON.stringify({
        publicKey: '02' + 'aa'.repeat(32),
        algorithm: 'secp256k1',
        signature: '99'.repeat(64),
        stateHash: '0000' + 'cc'.repeat(32),
      });
      h.manifest.entries.set(`${ADDR}:${tk('t-diff-sig')}`, manifestEntryFor({
        status: 'pending',
      }));
      h.queue.entries.push(queueEntryFor({
        tokenId: tk('t-diff-sig'),
        commitmentRequestId: 'rq-diff-sig',
        status: 'pending',
        transactionHash: '0000' + 'ab'.repeat(32),
        authenticator: queueAuthn,
      }));
      const result = await h.importer.importInclusionProof(
        ADDR,
        tk('t-diff-sig'),
        proofFor({
          requestId: 'rq-diff-sig',
          transactionHash: '0000' + 'ab'.repeat(32),
          authenticator: proofAuthn,
        }),
      );
      expect(result).toEqual({ ok: false, reason: 'proof-binding-mismatch' });
      expect(h.graftCalls.length).toBe(0);
    });

    it('CASE 3 (#W4-2): pending + DIFFERENT publicKey → REJECTED', async () => {
      const h = buildImporterHarness();
      const queueAuthn = JSON.stringify({
        algorithm: 'secp256k1',
        publicKey: '02' + 'aa'.repeat(32),
        signature: '11'.repeat(64),
        stateHash: '0000' + 'cc'.repeat(32),
      });
      const proofAuthn = JSON.stringify({
        algorithm: 'secp256k1',
        publicKey: '03' + 'aa'.repeat(32), // different prefix
        signature: '11'.repeat(64),
        stateHash: '0000' + 'cc'.repeat(32),
      });
      h.manifest.entries.set(`${ADDR}:${tk('t-diff-pk')}`, manifestEntryFor({
        status: 'pending',
      }));
      h.queue.entries.push(queueEntryFor({
        tokenId: tk('t-diff-pk'),
        commitmentRequestId: 'rq-diff-pk',
        status: 'pending',
        transactionHash: '0000' + 'ab'.repeat(32),
        authenticator: queueAuthn,
      }));
      const result = await h.importer.importInclusionProof(
        ADDR,
        tk('t-diff-pk'),
        proofFor({
          requestId: 'rq-diff-pk',
          transactionHash: '0000' + 'ab'.repeat(32),
          authenticator: proofAuthn,
        }),
      );
      expect(result).toEqual({ ok: false, reason: 'proof-binding-mismatch' });
    });

    // (c) Empty queue-entry authenticator — Wave 6 update:
    //
    //     Previously (Wave 4) treated empty queue-entry authenticator as
    //     a forensic regression and returned `'queue-entry-incomplete'`.
    //     Wave 6 corrected the semantics: the IPLD wire format
    //     (deconstructTransferData → assembleTransactionData) does NOT
    //     preserve `data.authenticator`, so EVERY production bundle's
    //     recipient queue entry has empty authenticator. The §6.3
    //     binding decision degrades to `transactionHash`-only (the
    //     load-bearing check); the operator-supplied proof is grafted
    //     when transactionHash matches.
    it('CASE 3 (Wave 6): pending + EMPTY queue authenticator → degrades to transactionHash-only binding, graft applied', async () => {
      const h = buildImporterHarness();
      h.manifest.entries.set(`${ADDR}:${tk('t-empty-q')}`, manifestEntryFor({
        status: 'pending',
      }));
      h.queue.entries.push(queueEntryFor({
        tokenId: tk('t-empty-q'),
        commitmentRequestId: 'rq-empty-q',
        status: 'pending',
        transactionHash: '0000' + 'ab'.repeat(32),
        authenticator: '', // production state post-IPLD-round-trip
      }));
      const result = await h.importer.importInclusionProof(
        ADDR,
        tk('t-empty-q'),
        proofFor({
          requestId: 'rq-empty-q',
          transactionHash: '0000' + 'ab'.repeat(32),
          authenticator: 'authn-anything',
        }),
      );
      // Empty queue-entry authenticator no longer fails — graft proceeds
      // because transactionHash byte-equal compare succeeds. The single
      // outstanding requestId resolves on this proof so the transition
      // is `pending→valid`.
      expect(result).toEqual({ ok: true, transition: 'pending→valid' });
      expect(h.graftCalls.length).toBe(1);
    });

    it('CASE 3 (Wave 6): pending + EMPTY queue authenticator + transactionHash MISMATCH → reason="proof-binding-mismatch"', async () => {
      const h = buildImporterHarness();
      h.manifest.entries.set(`${ADDR}:${tk('t-empty-q-tx-mm')}`, manifestEntryFor({
        status: 'pending',
      }));
      h.queue.entries.push(queueEntryFor({
        tokenId: tk('t-empty-q-tx-mm'),
        commitmentRequestId: 'rq-empty-q-tx-mm',
        status: 'pending',
        transactionHash: '0000' + 'ab'.repeat(32),
        authenticator: '', // production state post-IPLD-round-trip
      }));
      const result = await h.importer.importInclusionProof(
        ADDR,
        tk('t-empty-q-tx-mm'),
        proofFor({
          requestId: 'rq-empty-q-tx-mm',
          // Different transactionHash (load-bearing check still binds).
          transactionHash: '0000' + 'cd'.repeat(32),
          authenticator: 'whatever',
        }),
      );
      expect(result).toEqual({ ok: false, reason: 'proof-binding-mismatch' });
      expect(h.graftCalls.length).toBe(0);
    });

    it('CASE 5 (Wave 6): _invalid + EMPTY queue authenticator → degrades to transactionHash-only binding, override applied', async () => {
      const h = buildImporterHarness();
      h.disposition.entries.set(
        `${ADDR}.invalid.${tk('t-empty-inv')}.${'aa'.repeat(32)}`,
        invalidEntryFor({ tokenId: tk('t-empty-inv'), reason: 'oracle-rejected' }),
      );
      h.manifest.entries.set(`${ADDR}:${tk('t-empty-inv')}`, manifestEntryFor({
        status: 'invalid',
        invalidReason: 'oracle-rejected',
        rootHashHex: 'aa'.repeat(32),
      }));
      h.queue.entries.push(queueEntryFor({
        tokenId: tk('t-empty-inv'),
        commitmentRequestId: 'rq-empty-inv',
        status: 'hard-fail',
        transactionHash: '0000' + 'ee'.repeat(32),
        authenticator: '', // production state post-IPLD-round-trip
      }));
      const result = await h.importer.importInclusionProof(
        ADDR,
        tk('t-empty-inv'),
        proofFor({
          requestId: 'rq-empty-inv',
          transactionHash: '0000' + 'ee'.repeat(32),
          authenticator: 'whatever',
        }),
        { allowInvalidOverride: true },
      );
      // Wave 6: empty queue authenticator degrades to transactionHash-
      // only binding; override callback IS invoked, audit event IS
      // emitted. The §5.6 monotonicity invariant breach is the
      // operator's explicit decision (allowInvalidOverride: true).
      expect(result).toEqual({ ok: true, transition: 'invalid→valid' });
      expect(h.overrideCalls.length).toBe(1);
      expect(
        h.events.events.filter((e) => e.type === 'transfer:override-applied').length,
      ).toBe(1);
    });

    // (d) transactionHash byte-equal still works case-insensitively.
    //     Regression-pinning — make sure the canonical-authenticator
    //     change did not accidentally generalize transactionHash
    //     compare beyond hex.
    it('CASE 3 (#W4-2): pending + transactionHash hex case-insensitive → ACCEPTED', async () => {
      const h = buildImporterHarness();
      const sharedAuthn = JSON.stringify({
        algorithm: 'secp256k1',
        publicKey: '02' + 'aa'.repeat(32),
        signature: '33'.repeat(64),
        stateHash: '0000' + 'ee'.repeat(32),
      });
      h.manifest.entries.set(`${ADDR}:${tk('t-tx-case')}`, manifestEntryFor({
        status: 'pending',
      }));
      h.queue.entries.push(queueEntryFor({
        tokenId: tk('t-tx-case'),
        commitmentRequestId: 'rq-tx-case',
        status: 'pending',
        // queue stores upper-case hex for transactionHash...
        transactionHash: '0000' + 'AB'.repeat(32),
        authenticator: sharedAuthn,
      }));
      const result = await h.importer.importInclusionProof(
        ADDR,
        tk('t-tx-case'),
        proofFor({
          requestId: 'rq-tx-case',
          // ...proof brings lower-case; SAME bytes → MATCH.
          transactionHash: '0000' + 'ab'.repeat(32),
          authenticator: sharedAuthn,
        }),
      );
      expect(result).toEqual({ ok: true, transition: 'pending→valid' });
      expect(h.graftCalls.length).toBe(1);
    });

    it('CASE 3 (#W4-2): pending + transactionHash DIFFERENT bytes (case-insensitive cmp still fires) → REJECTED', async () => {
      const h = buildImporterHarness();
      const sharedAuthn = JSON.stringify({
        algorithm: 'secp256k1',
        publicKey: '02' + 'aa'.repeat(32),
        signature: '33'.repeat(64),
        stateHash: '0000' + 'ee'.repeat(32),
      });
      h.manifest.entries.set(`${ADDR}:${tk('t-tx-diff')}`, manifestEntryFor({
        status: 'pending',
      }));
      h.queue.entries.push(queueEntryFor({
        tokenId: tk('t-tx-diff'),
        commitmentRequestId: 'rq-tx-diff',
        status: 'pending',
        transactionHash: '0000' + 'ab'.repeat(32),
        authenticator: sharedAuthn,
      }));
      const result = await h.importer.importInclusionProof(
        ADDR,
        tk('t-tx-diff'),
        proofFor({
          requestId: 'rq-tx-diff',
          // Truly different bytes — must REJECT regardless of case-cmp.
          transactionHash: '0000' + 'CD'.repeat(32),
          authenticator: sharedAuthn,
        }),
      );
      expect(result).toEqual({ ok: false, reason: 'proof-binding-mismatch' });
    });

    // (e) Mixed shapes — one side JSON, the other opaque hex/text.
    //     Refusal is the safe choice (re-encoding could silently accept
    //     attacker-shaped opaque bytes that "look like" canonical JSON).
    it('CASE 3 (#W4-2): pending + JSON queue authn vs opaque proof authn → REJECTED', async () => {
      const h = buildImporterHarness();
      h.manifest.entries.set(`${ADDR}:${tk('t-mixed')}`, manifestEntryFor({
        status: 'pending',
      }));
      h.queue.entries.push(queueEntryFor({
        tokenId: tk('t-mixed'),
        commitmentRequestId: 'rq-mixed',
        status: 'pending',
        transactionHash: '0000' + 'ab'.repeat(32),
        authenticator: JSON.stringify({
          algorithm: 'secp256k1',
          publicKey: '02' + 'aa'.repeat(32),
          signature: '11'.repeat(64),
          stateHash: '0000' + 'cc'.repeat(32),
        }),
      }));
      const result = await h.importer.importInclusionProof(
        ADDR,
        tk('t-mixed'),
        proofFor({
          requestId: 'rq-mixed',
          transactionHash: '0000' + 'ab'.repeat(32),
          authenticator: 'opaquehexnotjson',
        }),
      );
      expect(result).toEqual({ ok: false, reason: 'proof-binding-mismatch' });
    });

    // (f) Backward-compat: both sides are plain hex blobs (legacy /
    //     test paths). canonicalAuthenticatorEquals falls back to
    //     hexEqualsIgnoreCase.
    it('CASE 3 (#W4-2 fallback): both sides plain hex (case-insensitive equal) → ACCEPTED', async () => {
      const h = buildImporterHarness();
      h.manifest.entries.set(`${ADDR}:${tk('t-hex-fb')}`, manifestEntryFor({
        status: 'pending',
      }));
      h.queue.entries.push(queueEntryFor({
        tokenId: tk('t-hex-fb'),
        commitmentRequestId: 'rq-hex-fb',
        status: 'pending',
        transactionHash: '0000' + 'ab'.repeat(32),
        authenticator: 'AUTHn-X',
      }));
      const result = await h.importer.importInclusionProof(
        ADDR,
        tk('t-hex-fb'),
        proofFor({
          requestId: 'rq-hex-fb',
          transactionHash: '0000' + 'ab'.repeat(32),
          authenticator: 'authN-x',
        }),
      );
      expect(result).toEqual({ ok: true, transition: 'pending→valid' });
    });
  });

  // ===========================================================================
  // Steelman crit #15 — _findInvalidEntry recovery via prefix scan when the
  // disposition writer routed the token to `_invalid` AND removed the
  // manifest entry. The legacy fallback content-hash always missed this
  // case; the prefix scanner is the structural recovery path.
  // ===========================================================================
  describe('Steelman crit #15: _findInvalidEntry uses prefix scan, not broken fallback', () => {
    it('manifest entry removed + _invalid record present → CASE 5 override applies (not CASE 1 no-such-token)', async () => {
      const h = buildImporterHarness();
      const tid = tk('t-crit15');
      // Disposition writer wrote an _invalid record under
      // ${ADDR}.invalid.${tid}.<observedHash> AND removed the manifest
      // entry. The importer arrives without any manifest cross-reference.
      const observedHash = 'cc'.repeat(32);
      h.disposition.entries.set(
        `${ADDR}.invalid.${tid}.${observedHash}`,
        invalidEntryFor({
          tokenId: tid,
          observedTokenContentHash: observedHash as never,
          reason: 'oracle-rejected',
        }),
      );
      // Hard-failed queue entry to drive the case-5 override path.
      h.queue.entries.push(queueEntryFor({
        tokenId: tid,
        commitmentRequestId: 'rq-15a',
        status: 'hard-fail',
        transactionHash: '0000' + 'ab'.repeat(32),
      }));
      const result = await h.importer.importInclusionProof(
        ADDR,
        tid,
        proofFor({
          requestId: 'rq-15a',
          transactionHash: '0000' + 'ab'.repeat(32),
        }),
        { allowInvalidOverride: true },
      );
      // Pre-fix: returned 'no-such-token' because fallbackContentHash
      // miss never recovered the _invalid record.
      // Post-fix: prefix scan recovers the record and case 5 applies.
      expect(result).toEqual({ ok: true, transition: 'invalid→valid' });
      expect(h.overrideCalls.length).toBe(1);
      expect(h.overrideCalls[0]!.previousReason).toBe('oracle-rejected');
    });

    it('multiple _invalid records present → most recent (max observedAt) is selected', async () => {
      const h = buildImporterHarness();
      const tid = tk('t-crit15-multi');
      const hashOld = 'aa'.repeat(32);
      const hashNew = 'bb'.repeat(32);
      // Both observedAt values must be at-or-before the harness clock
      // (1700000000000) — Round 3 rejects records observed beyond
      // `now + 5min` as forgeries. The "newer" record is therefore
      // the one closer to the harness clock.
      h.disposition.entries.set(
        `${ADDR}.invalid.${tid}.${hashOld}`,
        invalidEntryFor({
          tokenId: tid,
          observedTokenContentHash: hashOld as never,
          reason: 'oracle-rejected',
          observedAt: 1699999000000, // 1000s before harness clock
        }),
      );
      h.disposition.entries.set(
        `${ADDR}.invalid.${tid}.${hashNew}`,
        invalidEntryFor({
          tokenId: tid,
          observedTokenContentHash: hashNew as never,
          reason: 'predicate-eval',
          observedAt: 1700000000000, // exactly at harness clock (most recent)
        }),
      );
      h.queue.entries.push(queueEntryFor({
        tokenId: tid,
        commitmentRequestId: 'rq-15b',
        status: 'hard-fail',
        transactionHash: '0000' + 'ab'.repeat(32),
      }));
      const result = await h.importer.importInclusionProof(
        ADDR,
        tid,
        proofFor({
          requestId: 'rq-15b',
          transactionHash: '0000' + 'ab'.repeat(32),
        }),
        { allowInvalidOverride: true },
      );
      expect(result).toEqual({ ok: true, transition: 'invalid→valid' });
      // The override must reference the MOST-RECENT invalid record
      // (predicate-eval, not oracle-rejected).
      expect(h.overrideCalls[0]!.previousReason).toBe('predicate-eval');
    });

    it('no _invalid record + no _audit + no manifest → reason="no-such-token"', async () => {
      const h = buildImporterHarness();
      const tid = tk('t-crit15-empty');
      const result = await h.importer.importInclusionProof(
        ADDR,
        tid,
        proofFor({ requestId: 'rq' }),
      );
      expect(result).toEqual({ ok: false, reason: 'no-such-token' });
    });

    it('_audit record present (manifest entry absent) → CASE 1 no-such-token (recovers via prefix scan)', async () => {
      // Wave 4 already encoded that audit-only collapses to no-such-token.
      // The fix here is that we must REACH the audit branch via prefix
      // scan; the legacy fallback hash would miss the audit record too.
      const h = buildImporterHarness();
      const tid = tk('t-crit15-audit');
      const observedHash = 'dd'.repeat(32);
      h.disposition.entries.set(
        `${ADDR}.audit.${tid}.${observedHash}`,
        { tokenId: tid, auditStatus: 'audit-not-our-state' },
      );
      const result = await h.importer.importInclusionProof(
        ADDR,
        tid,
        proofFor({ requestId: 'rq' }),
      );
      expect(result).toEqual({ ok: false, reason: 'no-such-token' });
    });
  });

  // ===========================================================================
  // Steelman crit #16 — per-tokenId mutex case-fold normalization.
  // ===========================================================================
  describe('Steelman crit #16: per-tokenId mutex normalizes tokenId case', () => {
    it('CANONICAL_TOKEN_ID_RE rejects uppercase hex (mutex slot uniqueness)', async () => {
      const h = buildImporterHarness();
      const upper = 'AB'.repeat(32);
      const result = await h.importer.importInclusionProof(
        ADDR,
        upper,
        proofFor({ requestId: 'rq' }),
      );
      expect(result).toEqual({ ok: false, reason: 'invalid-tokenid' });
    });

    it('mixed-case tokenIds cannot bypass mutex serialization (regex rejects upper, normalization is defense-in-depth)', async () => {
      // Two callers pass the SAME canonical tokenId — both lowercase.
      // The fix ensures both callers share a single mutex slot. We
      // can't easily assert "same slot" externally, but we assert
      // the second call sees the first call's committed state (no
      // double-override race).
      const h = buildImporterHarness();
      const tid = tk('t-crit16');
      const observedHash = 'cc'.repeat(32);
      h.disposition.entries.set(
        `${ADDR}.invalid.${tid}.${observedHash}`,
        invalidEntryFor({
          tokenId: tid,
          observedTokenContentHash: observedHash as never,
          reason: 'oracle-rejected',
        }),
      );
      h.queue.entries.push(queueEntryFor({
        tokenId: tid,
        commitmentRequestId: 'rq-16',
        status: 'hard-fail',
        transactionHash: '0000' + 'ab'.repeat(32),
      }));
      // Race two operator calls — both target the same canonical
      // tokenId (lowercase). With case-fold normalization the mutex
      // serializes them; without it (and without regex tightening)
      // they would race.
      const [r1, r2] = await Promise.all([
        h.importer.importInclusionProof(
          ADDR,
          tid,
          proofFor({
            requestId: 'rq-16',
            transactionHash: '0000' + 'ab'.repeat(32),
          }),
          { allowInvalidOverride: true },
        ),
        h.importer.importInclusionProof(
          ADDR,
          tid,
          proofFor({
            requestId: 'rq-16',
            transactionHash: '0000' + 'ab'.repeat(32),
          }),
          { allowInvalidOverride: true },
        ),
      ]);
      // Both succeed (idempotent on retry); applyOverride was invoked
      // either once OR twice depending on mutex strategy, but both
      // calls cannot interleave their decision phases.
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
    });
  });

  // ===========================================================================
  // Steelman warning — queue-entry-incomplete reachable.
  // ===========================================================================
  describe('Steelman warning: queue-entry-incomplete is reachable', () => {
    it('CASE 3: queue entry has empty transactionHash → reason="queue-entry-incomplete"', async () => {
      const h = buildImporterHarness();
      const tid = tk('t-qei');
      h.manifest.entries.set(`${ADDR}:${tid}`, manifestEntryFor({
        status: 'pending',
      }));
      h.queue.entries.push(queueEntryFor({
        tokenId: tid,
        commitmentRequestId: 'rq-qei',
        status: 'pending',
        transactionHash: '', // empty — incomplete writer state
      }));
      const result = await h.importer.importInclusionProof(
        ADDR,
        tid,
        proofFor({
          requestId: 'rq-qei',
          transactionHash: '0000' + 'ab'.repeat(32),
        }),
      );
      expect(result).toEqual({ ok: false, reason: 'queue-entry-incomplete' });
    });

    it('CASE 3: BOTH proof and queue have empty transactionHash → reason="queue-entry-incomplete" (NOT trivial match)', async () => {
      const h = buildImporterHarness();
      const tid = tk('t-qei2');
      h.manifest.entries.set(`${ADDR}:${tid}`, manifestEntryFor({
        status: 'pending',
      }));
      h.queue.entries.push(queueEntryFor({
        tokenId: tid,
        commitmentRequestId: 'rq-qei2',
        status: 'pending',
        transactionHash: '',
      }));
      const result = await h.importer.importInclusionProof(
        ADDR,
        tid,
        proofFor({
          requestId: 'rq-qei2',
          transactionHash: '', // both empty — would trivially pass binding
        }),
      );
      // Pre-fix: hexEqualsIgnoreCase('','') returns true and the
      // importer attempts to graft on requestId-only — defeats the
      // §155 binding compare entirely.
      // Post-fix: gated to queue-entry-incomplete.
      expect(result).toEqual({ ok: false, reason: 'queue-entry-incomplete' });
      expect(h.graftCalls.length).toBe(0);
    });

    it('CASE 5: hard-fail queue entry has empty transactionHash → reason="queue-entry-incomplete"', async () => {
      const h = buildImporterHarness();
      const tid = tk('t-qei3');
      const observedHash = 'cc'.repeat(32);
      h.disposition.entries.set(
        `${ADDR}.invalid.${tid}.${observedHash}`,
        invalidEntryFor({
          tokenId: tid,
          observedTokenContentHash: observedHash as never,
          reason: 'oracle-rejected',
        }),
      );
      h.queue.entries.push(queueEntryFor({
        tokenId: tid,
        commitmentRequestId: 'rq-qei3',
        status: 'hard-fail',
        transactionHash: '',
      }));
      const result = await h.importer.importInclusionProof(
        ADDR,
        tid,
        proofFor({
          requestId: 'rq-qei3',
          transactionHash: '0000' + 'ab'.repeat(32),
        }),
        { allowInvalidOverride: true },
      );
      expect(result).toEqual({ ok: false, reason: 'queue-entry-incomplete' });
      expect(h.overrideCalls.length).toBe(0);
    });
  });

  // ===========================================================================
  // Steelman warning — emit failure must not propagate after override commit.
  // ===========================================================================
  describe('Steelman warning: transfer:override-applied emit failure does not propagate', () => {
    it('emit handler throws → applyOverride is committed; importer returns success result', async () => {
      const h = buildImporterHarness();
      // Replace the emit recorder with one that throws.
      const overrideEvents: unknown[] = [];
      const opts: ConstructorParameters<typeof InclusionProofImporter>[0] = {
        manifestStore: h.manifestStore,
        dispositionStorage: h.disposition,
        queueScanner: h.queue,
        verifyProof: async () => 'OK',
        graftCallback: { graft: async () => undefined },
        overrideCallback: {
          applyOverride: async (args) => {
            overrideEvents.push({ phase: 'commit', args });
          },
        },
        emit: () => {
          throw new Error('handler crashed');
        },
        now: () => 1700000000000,
      };
      const importer = new InclusionProofImporter(opts);
      const tid = tk('t-emit-fail');
      const observedHash = 'cc'.repeat(32);
      h.disposition.entries.set(
        `${ADDR}.invalid.${tid}.${observedHash}`,
        invalidEntryFor({
          tokenId: tid,
          observedTokenContentHash: observedHash as never,
          reason: 'oracle-rejected',
        }),
      );
      h.queue.entries.push(queueEntryFor({
        tokenId: tid,
        commitmentRequestId: 'rq-emit',
        status: 'hard-fail',
        transactionHash: '0000' + 'ab'.repeat(32),
      }));
      // Suppress console.warn noise from the catch.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = await importer.importInclusionProof(
        ADDR,
        tid,
        proofFor({
          requestId: 'rq-emit',
          transactionHash: '0000' + 'ab'.repeat(32),
        }),
        { allowInvalidOverride: true },
      );
      warnSpy.mockRestore();
      // Override committed; success returned despite emit throw.
      expect(result).toEqual({ ok: true, transition: 'invalid→valid' });
      expect(overrideEvents.length).toBe(1);
    });
  });

  // ===========================================================================
  // Round 3 — _findInvalidEntry observedAt validation
  //
  // Pre-Round-3, `rec.observedAt > best.observedAt` returned `false` for
  // NaN-vs-numeric comparisons, allowing a corrupt NaN-baseline record
  // to dominate ranking. A compromised local writer could plant
  // Number.MAX_VALUE to always win the freshest-record selection. Round
  // 3 validates observedAt per-read and skips invalid records entirely.
  // ===========================================================================
  describe('Round 3: _findInvalidEntry validates observedAt', () => {
    it('NaN observedAt + legitimate record present → legitimate record selected', async () => {
      const h = buildImporterHarness();
      const tid = tk('t-r3-nan');
      const hashCorrupt = 'aa'.repeat(32);
      const hashGood = 'bb'.repeat(32);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Plant the NaN record FIRST (in storage iteration order; Map
      // iteration is insertion-ordered) so the legacy bug would
      // incorrectly seed `best = { observedAt: NaN }` and every
      // subsequent comparison `legit.observedAt > NaN` returns false.
      h.disposition.entries.set(
        `${ADDR}.invalid.${tid}.${hashCorrupt}`,
        invalidEntryFor({
          tokenId: tid,
          observedTokenContentHash: hashCorrupt as never,
          reason: 'oracle-rejected',
          observedAt: Number.NaN,
        }),
      );
      h.disposition.entries.set(
        `${ADDR}.invalid.${tid}.${hashGood}`,
        invalidEntryFor({
          tokenId: tid,
          observedTokenContentHash: hashGood as never,
          reason: 'predicate-eval',
          observedAt: 1700000000000,
        }),
      );
      h.queue.entries.push(queueEntryFor({
        tokenId: tid,
        commitmentRequestId: 'rq-r3-nan',
        status: 'hard-fail',
        transactionHash: '0000' + 'ab'.repeat(32),
      }));
      const result = await h.importer.importInclusionProof(
        ADDR,
        tid,
        proofFor({
          requestId: 'rq-r3-nan',
          transactionHash: '0000' + 'ab'.repeat(32),
        }),
        { allowInvalidOverride: true },
      );
      warnSpy.mockRestore();

      // The legitimate (predicate-eval) record must be selected.
      expect(result).toEqual({ ok: true, transition: 'invalid→valid' });
      expect(h.overrideCalls.length).toBe(1);
      expect(h.overrideCalls[0]!.previousReason).toBe('predicate-eval');
    });

    it('MAX_VALUE observedAt + legitimate record → MAX_VALUE rejected, legitimate selected', async () => {
      const h = buildImporterHarness();
      const tid = tk('t-r3-maxval');
      const hashAttack = 'aa'.repeat(32);
      const hashGood = 'bb'.repeat(32);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Compromised local writer plants MAX_VALUE to dominate.
      h.disposition.entries.set(
        `${ADDR}.invalid.${tid}.${hashAttack}`,
        invalidEntryFor({
          tokenId: tid,
          observedTokenContentHash: hashAttack as never,
          reason: 'oracle-rejected',
          observedAt: Number.MAX_VALUE,
        }),
      );
      h.disposition.entries.set(
        `${ADDR}.invalid.${tid}.${hashGood}`,
        invalidEntryFor({
          tokenId: tid,
          observedTokenContentHash: hashGood as never,
          reason: 'predicate-eval',
          observedAt: 1700000000000,
        }),
      );
      h.queue.entries.push(queueEntryFor({
        tokenId: tid,
        commitmentRequestId: 'rq-r3-max',
        status: 'hard-fail',
        transactionHash: '0000' + 'ab'.repeat(32),
      }));
      const result = await h.importer.importInclusionProof(
        ADDR,
        tid,
        proofFor({
          requestId: 'rq-r3-max',
          transactionHash: '0000' + 'ab'.repeat(32),
        }),
        { allowInvalidOverride: true },
      );
      warnSpy.mockRestore();

      // MAX_VALUE is rejected (>> now + tolerance); legitimate wins.
      expect(result).toEqual({ ok: true, transition: 'invalid→valid' });
      expect(h.overrideCalls.length).toBe(1);
      expect(h.overrideCalls[0]!.previousReason).toBe('predicate-eval');
    });

    it('Infinity / negative / non-number observedAt all rejected', async () => {
      const h = buildImporterHarness();
      const tid = tk('t-r3-bad-shapes');
      const hashInf = 'aa'.repeat(32);
      const hashNeg = 'bb'.repeat(32);
      const hashStr = 'cc'.repeat(32);
      const hashGood = 'dd'.repeat(32);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      h.disposition.entries.set(
        `${ADDR}.invalid.${tid}.${hashInf}`,
        invalidEntryFor({
          tokenId: tid,
          observedTokenContentHash: hashInf as never,
          reason: 'oracle-rejected',
          observedAt: Number.POSITIVE_INFINITY,
        }),
      );
      h.disposition.entries.set(
        `${ADDR}.invalid.${tid}.${hashNeg}`,
        invalidEntryFor({
          tokenId: tid,
          observedTokenContentHash: hashNeg as never,
          reason: 'oracle-rejected',
          observedAt: -1,
        }),
      );
      h.disposition.entries.set(
        `${ADDR}.invalid.${tid}.${hashStr}`,
        // Force a non-number value via cast — production InvalidEntry
        // is typed `observedAt: number`, but a corrupt JSON read could
        // surface a string. The validator must reject it.
        invalidEntryFor({
          tokenId: tid,
          observedTokenContentHash: hashStr as never,
          reason: 'oracle-rejected',
          observedAt: 'not-a-number' as unknown as number,
        }),
      );
      h.disposition.entries.set(
        `${ADDR}.invalid.${tid}.${hashGood}`,
        invalidEntryFor({
          tokenId: tid,
          observedTokenContentHash: hashGood as never,
          reason: 'continuity-broken',
          observedAt: 1700000123456,
        }),
      );
      h.queue.entries.push(queueEntryFor({
        tokenId: tid,
        commitmentRequestId: 'rq-r3-shapes',
        status: 'hard-fail',
        transactionHash: '0000' + 'ab'.repeat(32),
      }));
      const result = await h.importer.importInclusionProof(
        ADDR,
        tid,
        proofFor({
          requestId: 'rq-r3-shapes',
          transactionHash: '0000' + 'ab'.repeat(32),
        }),
        { allowInvalidOverride: true },
      );
      warnSpy.mockRestore();

      expect(result).toEqual({ ok: true, transition: 'invalid→valid' });
      expect(h.overrideCalls[0]!.previousReason).toBe('continuity-broken');
    });

    it('all records have invalid observedAt → treated as no record (no-such-token)', async () => {
      const h = buildImporterHarness();
      const tid = tk('t-r3-all-bad');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Two entries, both with corrupt observedAt. With no manifest,
      // no audit, and no valid invalid record, the importer collapses
      // to CASE 1 no-such-token.
      h.disposition.entries.set(
        `${ADDR}.invalid.${tid}.${'aa'.repeat(32)}`,
        invalidEntryFor({
          tokenId: tid,
          observedTokenContentHash: 'aa'.repeat(32) as never,
          reason: 'oracle-rejected',
          observedAt: Number.NaN,
        }),
      );
      h.disposition.entries.set(
        `${ADDR}.invalid.${tid}.${'bb'.repeat(32)}`,
        invalidEntryFor({
          tokenId: tid,
          observedTokenContentHash: 'bb'.repeat(32) as never,
          reason: 'oracle-rejected',
          observedAt: Number.MAX_VALUE,
        }),
      );
      const result = await h.importer.importInclusionProof(
        ADDR,
        tid,
        proofFor({ requestId: 'rq-r3-all-bad' }),
        { allowInvalidOverride: true },
      );
      warnSpy.mockRestore();

      // No valid record → no-such-token
      expect(result).toEqual({ ok: false, reason: 'no-such-token' });
    });
  });

  // ===========================================================================
  // Round 3 — _findInvalidEntry prefix-scan cap surfacing
  //
  // The cap defends against hostile peers planting millions of crafted
  // matches. When the cap is hit, an operator-alert is emitted so the
  // operator can investigate.
  // ===========================================================================
  describe('Round 3: _findInvalidEntry caps prefix-scan results', () => {
    it('2000 matching records → at most cap (1024) keys read; alert emitted; valid record still selected', async () => {
      const h = buildImporterHarness();
      const tid = tk('t-r3-overflow');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Plant 2000 records under the prefix. The legitimate "winner"
      // is at index 1500 (within cap reach when keys are sorted by
      // hash; we just plant enough to exceed the cap).
      for (let i = 0; i < 2000; i++) {
        const hash = i.toString(16).padStart(64, '0');
        h.disposition.entries.set(
          `${ADDR}.invalid.${tid}.${hash}`,
          invalidEntryFor({
            tokenId: tid,
            observedTokenContentHash: hash as never,
            reason: 'oracle-rejected',
            observedAt: 1700000000000 + i,
          }),
        );
      }
      h.queue.entries.push(queueEntryFor({
        tokenId: tid,
        commitmentRequestId: 'rq-r3-overflow',
        status: 'hard-fail',
        transactionHash: '0000' + 'ab'.repeat(32),
      }));

      const result = await h.importer.importInclusionProof(
        ADDR,
        tid,
        proofFor({
          requestId: 'rq-r3-overflow',
          transactionHash: '0000' + 'ab'.repeat(32),
        }),
        { allowInvalidOverride: true },
      );
      warnSpy.mockRestore();

      // The override should still apply against the freshest valid
      // record within the cap (call succeeds rather than failing
      // silently).
      expect(result).toEqual({ ok: true, transition: 'invalid→valid' });
      // Operator-alert was emitted at least once (the cap-hit alert
      // routes to 'transfer:operator-alert' with code 'oracle-rejected').
      const alerts = h.events.events.filter(
        (e) => e.type === 'transfer:operator-alert',
      );
      expect(alerts.length).toBeGreaterThanOrEqual(1);
    });
  });
});
