/**
 * UXF Transfer T.5.D — Operator override audit trail (W30 / W31 / N4).
 *
 * Acceptance test for the audit-trail acceptance criteria:
 *   - W30: `overrideAppliedAt`, `overrideAppliedBy` are forwarded into
 *     the override callback so the wiring layer can stamp them on the
 *     manifest entry (sticky across CRDT merges).
 *   - W31: `transfer:override-applied` event is emitted EXACTLY ONCE
 *     per successful override (cases 5 / 6); NEVER for rejection
 *     paths (cases 1, 2, 4a, 4b, 7, 8, 9).
 *   - N4: the event payload carries the audit-trail tuple
 *     (`overrideAppliedAt`, `overrideAppliedBy`, `previousReason`,
 *     `transition`) so the operator console can build a complete
 *     forensic record without re-reading state.
 *
 * The event payload shape is locked down — adding fields is a deliberate
 * spec change (covered by the snapshot test in
 * `tests/unit/types/sphere-events-uxf.test.ts` once T.5.E lands).
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
} from './import-inclusion-proof-fixtures';

describe('§6.3 importInclusionProof — override audit trail (W30 / W31 / N4)', () => {
  it('W30 + W31: case 5 success carries overrideAppliedAt + overrideAppliedBy', async () => {
    const h = buildImporterHarness();
    h.disposition.entries.set(
      `${ADDR}.invalid.${tk('t-w30')}.${'aa'.repeat(32)}`,
      invalidEntryFor({ tokenId: tk('t-w30'), reason: 'oracle-rejected' }),
    );
    h.manifest.entries.set(`${ADDR}:${tk('t-w30')}`, manifestEntryFor({
      status: 'invalid',
      invalidReason: 'oracle-rejected',
      rootHashHex: 'aa'.repeat(32),
    }));
    h.queue.entries.push(queueEntryFor({
      tokenId: tk('t-w30'),
      commitmentRequestId: 'rq-w30',
      status: 'hard-fail',
    }));

    const ts = 1700000123456;
    const operator = '02deadbeef'.repeat(3) + 'fe';
    const result = await h.importer.importInclusionProof(
      ADDR,
      tk('t-w30'),
      proofFor({ requestId: 'rq-w30' }),
      { allowInvalidOverride: true, currentTime: ts, operatorPubkey: operator },
    );
    expect(result).toEqual({ ok: true, transition: 'invalid→valid' });

    // W30 — override callback receives the audit-trail tuple.
    expect(h.overrideCalls.length).toBe(1);
    expect(h.overrideCalls[0]!.now).toBe(ts);
    expect(h.overrideCalls[0]!.operatorPubkey).toBe(operator);

    // W31 / N4 — transfer:override-applied event payload locked down.
    const oe = h.events.events.filter(
      (e) => e.type === 'transfer:override-applied',
    );
    expect(oe.length).toBe(1);
    expect(oe[0]!.data).toEqual({
      tokenId: tk('t-w30'),
      overrideAppliedAt: ts,
      overrideAppliedBy: operator,
      previousReason: 'oracle-rejected',
      transition: 'invalid→valid',
    });
  });

  it('W30: case 6 success carries overrideAppliedAt + overrideAppliedBy + transition=invalid→pending', async () => {
    const h = buildImporterHarness();
    h.disposition.entries.set(
      `${ADDR}.invalid.${tk('t-w30-chain')}.${'bb'.repeat(32)}`,
      invalidEntryFor({ tokenId: tk('t-w30-chain'), reason: 'oracle-rejected' }),
    );
    h.manifest.entries.set(`${ADDR}:${tk('t-w30-chain')}`, manifestEntryFor({
      status: 'invalid',
      invalidReason: 'oracle-rejected',
      rootHashHex: 'bb'.repeat(32),
    }));
    h.queue.entries.push(
      queueEntryFor({ tokenId: tk('t-w30-chain'), commitmentRequestId: 'rq-cc-0', txIndex: 0, status: 'hard-fail' }),
      queueEntryFor({ tokenId: tk('t-w30-chain'), commitmentRequestId: 'rq-cc-1', txIndex: 1, status: 'hard-fail' }),
      queueEntryFor({ tokenId: tk('t-w30-chain'), commitmentRequestId: 'rq-cc-2', txIndex: 2, status: 'hard-fail' }),
    );

    const ts = 1700000999999;
    const result = await h.importer.importInclusionProof(
      ADDR,
      tk('t-w30-chain'),
      proofFor({ requestId: 'rq-cc-1' }),
      { allowInvalidOverride: true, currentTime: ts, operatorPubkey: 'op-2' },
    );
    expect(result).toEqual({ ok: true, transition: 'invalid→pending' });

    expect(h.overrideCalls.length).toBe(1);
    expect(h.overrideCalls[0]!.transition).toBe('invalid→pending');
    expect(h.overrideCalls[0]!.now).toBe(ts);

    const oe = h.events.events.filter(
      (e) => e.type === 'transfer:override-applied',
    );
    expect(oe.length).toBe(1);
    expect((oe[0]!.data as { transition: string }).transition).toBe(
      'invalid→pending',
    );
    expect((oe[0]!.data as { overrideAppliedAt: number }).overrideAppliedAt)
      .toBe(ts);
  });

  it('W31: rejection paths NEVER emit transfer:override-applied', async () => {
    // Build a fresh harness for each rejection case to ensure isolation.
    const cases: ReadonlyArray<() => Promise<void>> = [
      // Case 1 — no such token.
      async () => {
        const h = buildImporterHarness();
        await h.importer.importInclusionProof(
          ADDR,
          'gone',
          proofFor({ requestId: 'rq-x' }),
          { allowInvalidOverride: true },
        );
        expect(
          h.events.events.filter((e) => e.type === 'transfer:override-applied').length,
        ).toBe(0);
      },
      // Case 7 — invalid + no override.
      async () => {
        const h = buildImporterHarness();
        h.disposition.entries.set(
          `${ADDR}.invalid.${tk('t')}.${'aa'.repeat(32)}`,
          invalidEntryFor({ tokenId: tk('t') }),
        );
        h.manifest.entries.set(`${ADDR}:${tk('t')}`, manifestEntryFor({
          status: 'invalid',
          rootHashHex: 'aa'.repeat(32),
        }));
        await h.importer.importInclusionProof(
          ADDR,
          tk('t'),
          proofFor({ requestId: 'rq-x' }),
        );
        expect(
          h.events.events.filter((e) => e.type === 'transfer:override-applied').length,
        ).toBe(0);
      },
      // Case 8 — PATH_NOT_INCLUDED, even with override flag.
      async () => {
        const h = buildImporterHarness({ verifyResult: 'PATH_NOT_INCLUDED' });
        h.disposition.entries.set(
          `${ADDR}.invalid.${tk('t')}.${'aa'.repeat(32)}`,
          invalidEntryFor({ tokenId: tk('t') }),
        );
        h.manifest.entries.set(`${ADDR}:${tk('t')}`, manifestEntryFor({
          status: 'invalid',
          rootHashHex: 'aa'.repeat(32),
        }));
        await h.importer.importInclusionProof(
          ADDR,
          tk('t'),
          proofFor({ requestId: 'rq-x' }),
          { allowInvalidOverride: true },
        );
        expect(
          h.events.events.filter((e) => e.type === 'transfer:override-applied').length,
        ).toBe(0);
      },
      // Case 9 — PATH_INVALID, even with override flag.
      async () => {
        const h = buildImporterHarness({ verifyResult: 'PATH_INVALID' });
        h.disposition.entries.set(
          `${ADDR}.invalid.${tk('t')}.${'aa'.repeat(32)}`,
          invalidEntryFor({ tokenId: tk('t') }),
        );
        h.manifest.entries.set(`${ADDR}:${tk('t')}`, manifestEntryFor({
          status: 'invalid',
          rootHashHex: 'aa'.repeat(32),
        }));
        await h.importer.importInclusionProof(
          ADDR,
          tk('t'),
          proofFor({ requestId: 'rq-x' }),
          { allowInvalidOverride: true },
        );
        expect(
          h.events.events.filter((e) => e.type === 'transfer:override-applied').length,
        ).toBe(0);
      },
    ];
    for (const c of cases) await c();
  });

  it('W30: callsite without operatorPubkey omits the field but stamps timestamp', async () => {
    const h = buildImporterHarness();
    h.disposition.entries.set(
      `${ADDR}.invalid.${tk('t')}.${'aa'.repeat(32)}`,
      invalidEntryFor({ tokenId: tk('t'), reason: 'oracle-rejected' }),
    );
    h.manifest.entries.set(`${ADDR}:${tk('t')}`, manifestEntryFor({
      status: 'invalid',
      rootHashHex: 'aa'.repeat(32),
    }));
    h.queue.entries.push(queueEntryFor({
      tokenId: tk('t'),
      commitmentRequestId: 'rq-x',
      status: 'hard-fail',
    }));
    const ts = 1700000777777;
    const result = await h.importer.importInclusionProof(
      ADDR,
      tk('t'),
      proofFor({ requestId: 'rq-x' }),
      { allowInvalidOverride: true, currentTime: ts },
    );
    expect(result).toEqual({ ok: true, transition: 'invalid→valid' });
    expect(h.overrideCalls.length).toBe(1);
    expect(h.overrideCalls[0]!.now).toBe(ts);
    expect(h.overrideCalls[0]!.operatorPubkey).toBeUndefined();

    const oe = h.events.events.filter(
      (e) => e.type === 'transfer:override-applied',
    );
    expect(oe.length).toBe(1);
    const payload = oe[0]!.data as {
      tokenId: string;
      overrideAppliedAt: number;
      overrideAppliedBy?: string;
    };
    expect(payload.overrideAppliedAt).toBe(ts);
    expect(payload.overrideAppliedBy).toBeUndefined();
  });

  it('W30 sticky-flag propagation: overrideApplied + overrideAppliedAt + overrideAppliedBy survive merge', async () => {
    // The mergeManifestEntry helper is exercised by manifest-store.test.ts;
    // here we directly verify the set-OR / max-merge / lex-min semantics
    // for the audit-trail fields by importing the helper.
    const { mergeManifestEntry } = await import(
      '../../../../profile/manifest-store'
    );
    const base = manifestEntryFor({
      status: 'valid',
      rootHashHex: 'cc'.repeat(32),
    });
    const a = {
      ...base,
      overrideApplied: true,
      overrideAppliedAt: 1700000111111,
      overrideAppliedBy: 'opB-zzz',
    };
    const b = {
      ...base,
      overrideApplied: true,
      overrideAppliedAt: 1700000222222,
      overrideAppliedBy: 'opA-aaa',
    };
    const merged = mergeManifestEntry(a, b);
    // Set-OR — true wins.
    expect(merged.overrideApplied).toBe(true);
    // Max-merge — later timestamp wins.
    expect(merged.overrideAppliedAt).toBe(1700000222222);
    // Lex-min on divergent operator pubkeys — `'opA-aaa' < 'opB-zzz'`.
    expect(merged.overrideAppliedBy).toBe('opA-aaa');

    // Asymmetric: only one side has the override.
    const c = manifestEntryFor({
      status: 'valid',
      rootHashHex: 'dd'.repeat(32),
    });
    const merged2 = mergeManifestEntry(c, a);
    expect(merged2.overrideApplied).toBe(true);
    expect(merged2.overrideAppliedAt).toBe(1700000111111);
    expect(merged2.overrideAppliedBy).toBe('opB-zzz');
  });
});
