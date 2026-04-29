/**
 * UXF Transfer T.5.D — `importInclusionProof()` C13 client-error path.
 *
 * Acceptance test for the C13 acceptance: when the `_invalid` record's
 * `reason` is `'client-error'` (REQUEST_ID_MISMATCH at submit — a CLIENT
 * BUG, not a sender misbehavior), the importer:
 *   1. Routes through the same case-5/case-6 logic as any other reason.
 *   2. Forwards `reason='client-error'` into the override callback's
 *      `previousReason` field.
 *   3. Forwards `reason='client-error'` into the
 *      `transfer:override-applied` event's `previousReason` field.
 *
 * The C13 client-error path is special because the underlying defect is
 * a wallet bug, NOT an aggregator failure or a peer's misbehavior. The
 * operator console correlates the override-applied event back to the
 * original `transfer:operator-alert` (emitted by the disposition writer
 * when the entry first landed in `_invalid` with `reason='client-error'`)
 * so the audit chain is complete.
 */

import { describe, expect, it } from 'vitest';

import {
  ADDR,
  buildImporterHarness,
  invalidEntryFor,
  manifestEntryFor,
  proofFor,
  queueEntryFor,
} from './import-inclusion-proof-fixtures';

describe('§6.3 importInclusionProof — C13 client-error reason path', () => {
  it('case 5 with reason=client-error → previousReason="client-error" propagated', async () => {
    const h = buildImporterHarness();
    h.disposition.entries.set(
      `${ADDR}.invalid.t-c13.${'aa'.repeat(32)}`,
      invalidEntryFor({ tokenId: 't-c13', reason: 'client-error' }),
    );
    h.manifest.entries.set(`${ADDR}:t-c13`, manifestEntryFor({
      status: 'invalid',
      invalidReason: 'client-error',
      rootHashHex: 'aa'.repeat(32),
    }));
    h.queue.entries.push(queueEntryFor({
      tokenId: 't-c13',
      commitmentRequestId: 'rq-c13',
      status: 'hard-fail',
    }));

    const result = await h.importer.importInclusionProof(
      ADDR,
      't-c13',
      proofFor({ requestId: 'rq-c13' }),
      { allowInvalidOverride: true, currentTime: 1700000003000, operatorPubkey: 'op-c13' },
    );
    expect(result).toEqual({ ok: true, transition: 'invalid→valid' });

    // The override callback receives the SAME `previousReason` value
    // the disposition writer recorded (`'client-error'`). This is
    // critical for forensic audit — the operator's later log review
    // must show that the `_invalid` entry was originally placed there
    // by REQUEST_ID_MISMATCH (the C13 client bug), NOT by a more
    // common reason like `'oracle-rejected'`.
    expect(h.overrideCalls.length).toBe(1);
    expect(h.overrideCalls[0]!.previousReason).toBe('client-error');
    expect(h.overrideCalls[0]!.previousInvalidEntry.reason).toBe('client-error');

    // The transfer:override-applied event MUST carry the same
    // previousReason so the operator console's listener can correlate
    // back to the original transfer:operator-alert event the
    // disposition writer emitted when the entry first landed in
    // `_invalid`.
    const oe = h.events.events.filter(
      (e) => e.type === 'transfer:override-applied',
    );
    expect(oe.length).toBe(1);
    expect((oe[0]!.data as { previousReason: string }).previousReason).toBe(
      'client-error',
    );
  });

  it('case 6 with reason=client-error: K-1 re-queue + previousReason propagation', async () => {
    const h = buildImporterHarness();
    h.disposition.entries.set(
      `${ADDR}.invalid.t-c13-chain.${'bb'.repeat(32)}`,
      invalidEntryFor({ tokenId: 't-c13-chain', reason: 'client-error' }),
    );
    h.manifest.entries.set(`${ADDR}:t-c13-chain`, manifestEntryFor({
      status: 'invalid',
      invalidReason: 'client-error',
      rootHashHex: 'bb'.repeat(32),
    }));
    h.queue.entries.push(
      queueEntryFor({ tokenId: 't-c13-chain', commitmentRequestId: 'rq-cc-0', txIndex: 0, status: 'hard-fail' }),
      queueEntryFor({ tokenId: 't-c13-chain', commitmentRequestId: 'rq-cc-1', txIndex: 1, status: 'hard-fail' }),
    );

    const result = await h.importer.importInclusionProof(
      ADDR,
      't-c13-chain',
      proofFor({ requestId: 'rq-cc-0' }),
      { allowInvalidOverride: true },
    );
    expect(result).toEqual({ ok: true, transition: 'invalid→pending' });
    expect(h.overrideCalls.length).toBe(1);
    expect(h.overrideCalls[0]!.previousReason).toBe('client-error');
    expect(h.overrideCalls[0]!.requeueEntries.length).toBe(1);
    expect(h.overrideCalls[0]!.requeueEntries[0]!.commitmentRequestId).toBe(
      'rq-cc-1',
    );
  });

  it('case 7 (no override) with reason=client-error: tokenId-in-invalid', async () => {
    const h = buildImporterHarness();
    h.disposition.entries.set(
      `${ADDR}.invalid.t-c13-no-ov.${'aa'.repeat(32)}`,
      invalidEntryFor({ tokenId: 't-c13-no-ov', reason: 'client-error' }),
    );
    h.manifest.entries.set(`${ADDR}:t-c13-no-ov`, manifestEntryFor({
      status: 'invalid',
      invalidReason: 'client-error',
      rootHashHex: 'aa'.repeat(32),
    }));
    h.queue.entries.push(queueEntryFor({
      tokenId: 't-c13-no-ov',
      commitmentRequestId: 'rq-x',
      status: 'hard-fail',
    }));

    // Default: allowInvalidOverride = false. C13 reason does NOT bypass
    // the operator-explicit override requirement — same as every other
    // reason.
    const result = await h.importer.importInclusionProof(
      ADDR,
      't-c13-no-ov',
      proofFor({ requestId: 'rq-x' }),
    );
    expect(result).toEqual({ ok: false, reason: 'tokenId-in-invalid' });
    expect(h.overrideCalls.length).toBe(0);
    // No override-applied event for the rejection path.
    expect(
      h.events.events.filter((e) => e.type === 'transfer:override-applied').length,
    ).toBe(0);
  });
});
