/**
 * UXF Inter-Wallet Transfer T.5.E — `transfer:override-applied`
 * (W31 / §6.3 stuck-PENDING escape) integration test.
 *
 * Per W31, EVERY successful
 * `payments.importInclusionProof({ allowInvalidOverride: true })` call
 * that flips a token from `_invalid` back to the active pool MUST emit
 * `transfer:override-applied` exactly once with the durable audit
 * trail.
 *
 * This integration test wires the production
 * {@link InclusionProofImporter} (T.5.D) against the in-memory
 * importer harness and asserts:
 *
 *   - Case 5 (single hard-failed entry) emits override-applied with
 *     `transition='invalid→valid'`.
 *   - Case 6 (K-1 re-queue / chain mode) emits override-applied with
 *     `transition='invalid→pending'` and the requeueEntries shape.
 *   - The event payload matches the §6.3 W31 spec exactly:
 *       { tokenId, overrideAppliedAt, overrideAppliedBy?, previousReason,
 *         transition }.
 *   - Failure cases (case 7, case 8 on _invalid path) DO NOT emit the
 *     event.
 *   - The event is emitted ONCE PER successful override (idempotency
 *     boundary check).
 *
 * Spec refs: §6.3 (most-recent-proof), W30 (operator override), W31
 * (event), N4 (audit listener — see operator-override-audit-listener.test.ts).
 */

import { describe, expect, it } from 'vitest';

import {
  ADDR,
  buildImporterHarness,
  invalidEntryFor,
  manifestEntryFor,
  proofFor,
  queueEntryFor,
  tk,
} from '../../unit/payments/transfer/import-inclusion-proof-fixtures';

describe('§6.3 W31 — transfer:override-applied integration', () => {
  it('case 5 (single hard-failed entry) emits override-applied with invalid→valid', async () => {
    const h = buildImporterHarness();
    const T_BAD = tk('t-bad');
    h.disposition.entries.set(
      `${ADDR}.invalid.${T_BAD}.${'aa'.repeat(32)}`,
      invalidEntryFor({ tokenId: T_BAD, reason: 'oracle-rejected' }),
    );
    h.manifest.entries.set(
      `${ADDR}:${T_BAD}`,
      manifestEntryFor({
        status: 'invalid',
        invalidReason: 'oracle-rejected',
        rootHashHex: 'aa'.repeat(32),
      }),
    );
    h.queue.entries.push(
      queueEntryFor({
        tokenId: T_BAD,
        commitmentRequestId: 'rq-bad',
        status: 'hard-fail',
      }),
    );

    const result = await h.importer.importInclusionProof(
      ADDR,
      T_BAD,
      proofFor({ requestId: 'rq-bad' }),
      {
        allowInvalidOverride: true,
        currentTime: 1700000001000,
        operatorPubkey: 'op-pk-1',
      },
    );

    expect(result).toEqual({ ok: true, transition: 'invalid→valid' });

    // Override callback invoked exactly once with the right shape.
    expect(h.overrideCalls.length).toBe(1);
    const ov = h.overrideCalls[0]!;
    expect(ov.transition).toBe('invalid→valid');
    expect(ov.previousReason).toBe('oracle-rejected');
    expect(ov.requeueEntries.length).toBe(0);

    // Event emitted exactly once.
    const events = h.events.events.filter(
      (e) => e.type === 'transfer:override-applied',
    );
    expect(events.length).toBe(1);

    // Event payload matches the W31 spec.
    expect(events[0]!.data).toEqual({
      tokenId: T_BAD,
      overrideAppliedAt: 1700000001000,
      overrideAppliedBy: 'op-pk-1',
      previousReason: 'oracle-rejected',
      transition: 'invalid→valid',
    });
  });

  it('case 6 (K-1 re-queue / chain mode) emits override-applied with invalid→pending', async () => {
    const h = buildImporterHarness();
    const T_CHAIN = tk('t-chain');
    h.disposition.entries.set(
      `${ADDR}.invalid.${T_CHAIN}.${'bb'.repeat(32)}`,
      invalidEntryFor({ tokenId: T_CHAIN, reason: 'oracle-rejected' }),
    );
    h.manifest.entries.set(
      `${ADDR}:${T_CHAIN}`,
      manifestEntryFor({
        status: 'invalid',
        invalidReason: 'oracle-rejected',
        rootHashHex: 'bb'.repeat(32),
      }),
    );
    h.queue.entries.push(
      queueEntryFor({
        tokenId: T_CHAIN,
        commitmentRequestId: 'rq-c0',
        txIndex: 0,
        status: 'hard-fail',
      }),
      queueEntryFor({
        tokenId: T_CHAIN,
        commitmentRequestId: 'rq-c1',
        txIndex: 1,
        status: 'hard-fail',
      }),
      queueEntryFor({
        tokenId: T_CHAIN,
        commitmentRequestId: 'rq-c2',
        txIndex: 2,
        status: 'hard-fail',
      }),
    );

    const result = await h.importer.importInclusionProof(
      ADDR,
      T_CHAIN,
      proofFor({ requestId: 'rq-c0' }),
      { allowInvalidOverride: true, currentTime: 1700000002000 },
    );

    expect(result).toEqual({ ok: true, transition: 'invalid→pending' });

    const events = h.events.events.filter(
      (e) => e.type === 'transfer:override-applied',
    );
    expect(events.length).toBe(1);
    const data = events[0]!.data as {
      tokenId: string;
      overrideAppliedAt: number;
      overrideAppliedBy?: string;
      previousReason: string;
      transition: string;
    };
    expect(data.tokenId).toBe(T_CHAIN);
    expect(data.overrideAppliedAt).toBe(1700000002000);
    expect(data.transition).toBe('invalid→pending');
    // operatorPubkey was omitted in this call — must reflect undefined.
    expect(data.overrideAppliedBy).toBeUndefined();
    expect(data.previousReason).toBe('oracle-rejected');
  });

  it('case 7 (no override flag) does NOT emit override-applied', async () => {
    const h = buildImporterHarness();
    const T_BAD = tk('t-bad');
    h.disposition.entries.set(
      `${ADDR}.invalid.${T_BAD}.${'aa'.repeat(32)}`,
      invalidEntryFor({ tokenId: T_BAD }),
    );
    h.manifest.entries.set(
      `${ADDR}:${T_BAD}`,
      manifestEntryFor({
        status: 'invalid',
        rootHashHex: 'aa'.repeat(32),
      }),
    );
    h.queue.entries.push(
      queueEntryFor({
        tokenId: T_BAD,
        commitmentRequestId: 'rq-bad',
        status: 'hard-fail',
      }),
    );

    const result = await h.importer.importInclusionProof(
      ADDR,
      T_BAD,
      proofFor({ requestId: 'rq-bad' }),
      // allowInvalidOverride OMITTED → defaults to false.
    );
    expect(result).toEqual({ ok: false, reason: 'tokenId-in-invalid' });

    const events = h.events.events.filter(
      (e) => e.type === 'transfer:override-applied',
    );
    expect(events.length).toBe(0);
  });

  it('case 8 (PATH_NOT_INCLUDED on _invalid path) does NOT emit override-applied', async () => {
    // Even with the override flag set, a bad proof MUST NOT flip the
    // token. The event is only emitted on SUCCESSFUL override.
    const h = buildImporterHarness({ verifyResult: 'PATH_NOT_INCLUDED' });
    const T_BAD = tk('t-bad');
    h.disposition.entries.set(
      `${ADDR}.invalid.${T_BAD}.${'aa'.repeat(32)}`,
      invalidEntryFor({ tokenId: T_BAD }),
    );
    h.manifest.entries.set(
      `${ADDR}:${T_BAD}`,
      manifestEntryFor({
        status: 'invalid',
        rootHashHex: 'aa'.repeat(32),
      }),
    );

    const result = await h.importer.importInclusionProof(
      ADDR,
      T_BAD,
      proofFor({ requestId: 'rq-anything' }),
      { allowInvalidOverride: true },
    );
    expect(result).toEqual({ ok: false, reason: 'proof-not-anchored' });

    const events = h.events.events.filter(
      (e) => e.type === 'transfer:override-applied',
    );
    expect(events.length).toBe(0);
  });

  it('idempotency: repeated successful override on same token emits ONCE PER call', async () => {
    // The event surface fires per-CALL. Two distinct
    // `importInclusionProof` calls each succeeding produce two events
    // — that is the expected audit trail (operator clicked override
    // twice). The PRODUCTION manifest mutation is idempotent; the
    // event is the call counter.
    const h = buildImporterHarness();
    const T_BAD = tk('t-bad');
    h.disposition.entries.set(
      `${ADDR}.invalid.${T_BAD}.${'aa'.repeat(32)}`,
      invalidEntryFor({ tokenId: T_BAD, reason: 'oracle-rejected' }),
    );
    h.manifest.entries.set(
      `${ADDR}:${T_BAD}`,
      manifestEntryFor({
        status: 'invalid',
        invalidReason: 'oracle-rejected',
        rootHashHex: 'aa'.repeat(32),
      }),
    );
    h.queue.entries.push(
      queueEntryFor({
        tokenId: T_BAD,
        commitmentRequestId: 'rq-bad',
        status: 'hard-fail',
      }),
    );

    const r1 = await h.importer.importInclusionProof(
      ADDR,
      T_BAD,
      proofFor({ requestId: 'rq-bad' }),
      {
        allowInvalidOverride: true,
        currentTime: 1700000001000,
        operatorPubkey: 'op-pk-1',
      },
    );
    expect(r1.ok).toBe(true);

    const r2 = await h.importer.importInclusionProof(
      ADDR,
      T_BAD,
      proofFor({ requestId: 'rq-bad' }),
      {
        allowInvalidOverride: true,
        currentTime: 1700000002000,
        operatorPubkey: 'op-pk-2',
      },
    );
    // The second call may succeed or short-circuit depending on the
    // manifest's post-flip status; either way, the WHEN-OK invariant is
    // "exactly one event per successful override".
    const events = h.events.events.filter(
      (e) => e.type === 'transfer:override-applied',
    );

    // r2.ok determines whether a second event fires.
    if (r2.ok === true) {
      expect(events.length).toBe(2);
      // Second event carries the second call's operator pubkey.
      const e2 = events[1]!.data as { overrideAppliedBy?: string; overrideAppliedAt: number };
      expect(e2.overrideAppliedBy).toBe('op-pk-2');
      expect(e2.overrideAppliedAt).toBe(1700000002000);
    } else {
      expect(events.length).toBe(1);
      const e1 = events[0]!.data as { overrideAppliedBy?: string };
      expect(e1.overrideAppliedBy).toBe('op-pk-1');
    }
  });
});
