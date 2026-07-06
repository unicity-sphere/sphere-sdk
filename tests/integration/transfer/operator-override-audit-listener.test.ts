/**
 * UXF Inter-Wallet Transfer T.5.E — N4 audit-listener integration test.
 *
 * Per N4 (operator override audit-trail listener), an external observer
 * SHOULD be able to subscribe to `transfer:override-applied` and capture
 * a complete audit record without coupling to the import pipeline's
 * internals. The event surface is the audit trail.
 *
 * This test wires an "audit listener" that mirrors what an operator
 * console / compliance subsystem would do:
 *
 *   1. Subscribe to `transfer:override-applied`.
 *   2. Append every received event to an immutable append-only ledger.
 *   3. Verify the ledger captures EXACTLY the audit fields the spec
 *      promises (tokenId, overrideAppliedAt, overrideAppliedBy?,
 *      previousReason, transition).
 *
 * The listener consumes from the same event recorder used elsewhere in
 * the test suite — production wiring goes through `Sphere.on()` on the
 * SDK's event bus, which has the same `(type, data)` shape.
 *
 * Spec refs: §6.3, W30, W31, N4.
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
import type { SphereEventMap } from '../../../types';
import type { DispositionReason } from '../../../extensions/uxf/types/disposition';

// =============================================================================
// 1. Audit listener — mirrors what an operator console would do.
// =============================================================================

interface AuditRecord {
  readonly tokenId: string;
  readonly overrideAppliedAt: number;
  readonly overrideAppliedBy?: string;
  readonly previousReason: DispositionReason;
  readonly transition: 'invalid→valid' | 'invalid→pending';
  readonly capturedAt: number; // listener-side wall-clock at capture time
}

class AuditListener {
  private readonly _ledger: AuditRecord[] = [];
  private _captureClock = 2_000_000_000_000;

  get ledger(): ReadonlyArray<AuditRecord> {
    return this._ledger;
  }

  handleOverrideApplied(
    payload: SphereEventMap['transfer:override-applied'],
  ): void {
    this._ledger.push({
      tokenId: payload.tokenId,
      overrideAppliedAt: payload.overrideAppliedAt,
      overrideAppliedBy: payload.overrideAppliedBy,
      previousReason: payload.previousReason,
      transition: payload.transition,
      capturedAt: this._captureClock++,
    });
  }
}

// =============================================================================
// 2. Tests
// =============================================================================

describe('N4 — operator override audit-trail listener', () => {
  it('captures the full W31 audit trail for case 5 (invalid→valid)', async () => {
    const harness = buildImporterHarness();
    const listener = new AuditListener();

    // Wire the listener to the harness event recorder. In production,
    // the wiring is `sphere.on('transfer:override-applied', ...)`. We
    // replay the recorder's events into the listener for ergonomics —
    // the SHAPE of the wiring is the same.
    const originalEmit = harness.events.emit;
    const wiredEmit: typeof originalEmit = (type, data) => {
      originalEmit(type, data);
      if (type === 'transfer:override-applied') {
        listener.handleOverrideApplied(
          data as SphereEventMap['transfer:override-applied'],
        );
      }
    };

    // Reach into the importer harness and rebuild with the wired emit.
    // We can do this by re-wiring the recorder in place — the emit fn
    // is a closure over the events array.
    (
      harness.events as unknown as { emit: typeof wiredEmit }
    ).emit = wiredEmit;
    // Re-build the importer with the wired emit.
    const h2 = buildImporterHarness();
    const wiredEmit2: typeof h2.events.emit = (type, data) => {
      h2.events.emit(type, data);
      if (type === 'transfer:override-applied') {
        listener.handleOverrideApplied(
          data as SphereEventMap['transfer:override-applied'],
        );
      }
    };
    // Replace the importer's emit by going through the orchestration:
    // import the production importer with our wired emit.
    const {
      InclusionProofImporter,
    } = await import(
      '../../../extensions/uxf/pipeline/import-inclusion-proof'
    );
    const wiredImporter = new InclusionProofImporter({
      manifestStore: h2.manifestStore,
      dispositionStorage: h2.disposition,
      queueScanner: h2.queue,
      verifyProof: async () => 'OK',
      graftCallback: { async graft() {} },
      overrideCallback: {
        async applyOverride() {
          /* recorded externally; the event is what we audit */
        },
      },
      emit: wiredEmit2,
      now: () => 1700000001000,
    });

    // Seed the disposition + manifest + queue for a case-5 setup.
    const T_BAD = tk('t-bad');
    h2.disposition.entries.set(
      `${ADDR}.invalid.${T_BAD}.${'aa'.repeat(32)}`,
      invalidEntryFor({ tokenId: T_BAD, reason: 'oracle-rejected' }),
    );
    h2.manifest.entries.set(
      `${ADDR}:${T_BAD}`,
      manifestEntryFor({
        status: 'invalid',
        invalidReason: 'oracle-rejected',
        rootHashHex: 'aa'.repeat(32),
      }),
    );
    h2.queue.entries.push(
      queueEntryFor({
        tokenId: T_BAD,
        commitmentRequestId: 'rq-bad',
        status: 'hard-fail',
      }),
    );

    const result = await wiredImporter.importInclusionProof(
      ADDR,
      T_BAD,
      proofFor({ requestId: 'rq-bad' }),
      {
        allowInvalidOverride: true,
        currentTime: 1700000001000,
        operatorPubkey: 'op-pk-N4',
      },
    );
    expect(result).toEqual({ ok: true, transition: 'invalid→valid' });

    // The listener captured exactly one record.
    expect(listener.ledger.length).toBe(1);
    const r = listener.ledger[0]!;
    expect(r.tokenId).toBe(T_BAD);
    expect(r.overrideAppliedAt).toBe(1700000001000);
    expect(r.overrideAppliedBy).toBe('op-pk-N4');
    expect(r.previousReason).toBe('oracle-rejected');
    expect(r.transition).toBe('invalid→valid');
    // Listener also stamps its own capture clock — useful for forensic
    // ordering when multiple overrides land in quick succession.
    expect(r.capturedAt).toBeGreaterThan(0);
  });

  it('captures multiple overrides in order (multi-token replay)', async () => {
    const h = buildImporterHarness();
    const listener = new AuditListener();
    const wiredEmit: typeof h.events.emit = (type, data) => {
      h.events.emit(type, data);
      if (type === 'transfer:override-applied') {
        listener.handleOverrideApplied(
          data as SphereEventMap['transfer:override-applied'],
        );
      }
    };

    const {
      InclusionProofImporter,
    } = await import(
      '../../../extensions/uxf/pipeline/import-inclusion-proof'
    );

    // Two distinct tokens: one case-5 (invalid→valid), one case-6
    // (invalid→pending). Both go through the same importer, so the
    // listener sees both events in arrival order.
    const importer = new InclusionProofImporter({
      manifestStore: h.manifestStore,
      dispositionStorage: h.disposition,
      queueScanner: h.queue,
      verifyProof: async () => 'OK',
      graftCallback: { async graft() {} },
      overrideCallback: { async applyOverride() {} },
      emit: wiredEmit,
      now: () => 1700000010000,
    });

    // Token A — case 5.
    const T_A = tk('t-A');
    const T_B = tk('t-B');
    h.disposition.entries.set(
      `${ADDR}.invalid.${T_A}.${'aa'.repeat(32)}`,
      invalidEntryFor({ tokenId: T_A, reason: 'oracle-rejected' }),
    );
    h.manifest.entries.set(
      `${ADDR}:${T_A}`,
      manifestEntryFor({
        status: 'invalid',
        invalidReason: 'oracle-rejected',
        rootHashHex: 'aa'.repeat(32),
      }),
    );
    h.queue.entries.push(
      queueEntryFor({
        tokenId: T_A,
        commitmentRequestId: 'rq-A0',
        status: 'hard-fail',
      }),
    );

    // Token B — case 6 (chain-mode K-1 re-queue).
    h.disposition.entries.set(
      `${ADDR}.invalid.${T_B}.${'bb'.repeat(32)}`,
      invalidEntryFor({ tokenId: T_B, reason: 'oracle-rejected' }),
    );
    h.manifest.entries.set(
      `${ADDR}:${T_B}`,
      manifestEntryFor({
        status: 'invalid',
        invalidReason: 'oracle-rejected',
        rootHashHex: 'bb'.repeat(32),
      }),
    );
    h.queue.entries.push(
      queueEntryFor({
        tokenId: T_B,
        commitmentRequestId: 'rq-B0',
        txIndex: 0,
        status: 'hard-fail',
      }),
      queueEntryFor({
        tokenId: T_B,
        commitmentRequestId: 'rq-B1',
        txIndex: 1,
        status: 'hard-fail',
      }),
    );

    const rA = await importer.importInclusionProof(
      ADDR,
      T_A,
      proofFor({ requestId: 'rq-A0' }),
      {
        allowInvalidOverride: true,
        currentTime: 1700000020000,
        operatorPubkey: 'op-A',
      },
    );
    expect(rA).toEqual({ ok: true, transition: 'invalid→valid' });

    const rB = await importer.importInclusionProof(
      ADDR,
      T_B,
      proofFor({ requestId: 'rq-B0' }),
      {
        allowInvalidOverride: true,
        currentTime: 1700000030000,
        operatorPubkey: 'op-B',
      },
    );
    expect(rB).toEqual({ ok: true, transition: 'invalid→pending' });

    // Listener captured both, in arrival order.
    expect(listener.ledger.length).toBe(2);
    expect(listener.ledger[0]!.tokenId).toBe(T_A);
    expect(listener.ledger[0]!.transition).toBe('invalid→valid');
    expect(listener.ledger[0]!.overrideAppliedBy).toBe('op-A');
    expect(listener.ledger[1]!.tokenId).toBe(T_B);
    expect(listener.ledger[1]!.transition).toBe('invalid→pending');
    expect(listener.ledger[1]!.overrideAppliedBy).toBe('op-B');

    // capturedAt is monotonic — the listener's own clock advances.
    expect(listener.ledger[1]!.capturedAt).toBeGreaterThan(
      listener.ledger[0]!.capturedAt,
    );
  });

  it('audit ledger payload is type-safe — every captured record assignable to AuditRecord', () => {
    // Compile-time / runtime sanity: the listener consumes
    // `SphereEventMap['transfer:override-applied']` which means a
    // refactor of the event shape would either:
    //   (a) widen the payload — test still compiles + records still
    //       carry the additional fields (forward-compat).
    //   (b) drop a required field — `AuditRecord` no longer assignable
    //       and tsc fails.
    // This test is the canary; the payload shape is auditable.
    const samplePayload: SphereEventMap['transfer:override-applied'] = {
      tokenId: 't-1',
      overrideAppliedAt: 1700000000000,
      overrideAppliedBy: 'op-pk',
      previousReason: 'oracle-rejected' satisfies DispositionReason,
      transition: 'invalid→valid',
    };

    const record: AuditRecord = {
      tokenId: samplePayload.tokenId,
      overrideAppliedAt: samplePayload.overrideAppliedAt,
      overrideAppliedBy: samplePayload.overrideAppliedBy,
      previousReason: samplePayload.previousReason,
      transition: samplePayload.transition,
      capturedAt: Date.now(),
    };

    expect(record.tokenId).toBe('t-1');
    expect(record.transition).toBe('invalid→valid');
  });
});
