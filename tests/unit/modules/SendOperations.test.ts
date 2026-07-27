/**
 * SendOperations — the pure reduction that turns a send's SETTLED
 * per-operation outcomes into committed accounting + the one error to surface.
 *
 * These tables are the executable spec of the parallel-send failure
 * semantics: exact #677 partial accounting, the #625 "tag only when nothing
 * certified" rule, and the keep-open precedence (#631/#684). They run without
 * any module harness — the reducer is imported directly.
 */
import { describe, it, expect } from 'vitest';
import {
  summarizeOutcomes,
  isKeepOpenSendError,
  type OperationOutcome,
  type SendOperation,
} from '../../../modules/payments/SendOperations';
import type { SphereToken } from '../../../token-engine';
import {
  CheckpointPersistFailedError,
  CheckpointTrustbaseMismatchError,
  ProofUnconfirmedError,
  SplitCheckpointLostError,
  TransferConflictError,
} from '../../../token-engine';

const FAKE_SDK_TOKEN = { __fake: true } as unknown as SphereToken;
const FAKE_CHANGE = { __fakeChange: true } as unknown as SphereToken;

function directOp(opIndex: number, amount: bigint): SendOperation {
  return {
    kind: 'direct', opIndex,
    uiTokenId: `ui-${opIndex}`, genesisId: `gen-${opIndex}`, sourceSdkData: `blob-${opIndex}`,
    sdkToken: FAKE_SDK_TOKEN, deliveredAmount: amount,
  };
}

function splitOp(opIndex: number, splitAmount: bigint, remainderAmount: bigint): SendOperation {
  return {
    kind: 'split', opIndex,
    uiTokenId: `ui-${opIndex}`, genesisId: `gen-${opIndex}`, sourceSdkData: `blob-${opIndex}`,
    sdkToken: FAKE_SDK_TOKEN, deliveredAmount: splitAmount, remainderAmount,
  };
}

function certified(op: SendOperation, extra: Partial<OperationOutcome> = {}): OperationOutcome {
  return { op, certified: true, delivered: true, ...extra };
}

function failed(op: SendOperation, error: unknown): OperationOutcome {
  return { op, certified: false, error };
}

describe('summarizeOutcomes — accounting', () => {
  it('full success: everything committed, no error, no tag', () => {
    const s = summarizeOutcomes([certified(directOp(0, 30n)), certified(directOp(1, 20n))]);
    expect(s.primaryError).toBeUndefined();
    expect(s.conflictTagSourceId).toBeUndefined();
    expect(s.committedUiIds).toEqual(new Set(['ui-0', 'ui-1']));
    expect(s.committedAmount).toBe(50n);
    expect(s.deliveryPending).toBe(false);
    expect(s.changeOutput).toBeNull();
  });

  it('committed ops are returned in plan (opIndex) order regardless of settle order', () => {
    const s = summarizeOutcomes([certified(directOp(2, 1n)), certified(directOp(0, 1n)), certified(directOp(1, 1n))]);
    expect(s.committed.map((o) => o.op.opIndex)).toEqual([0, 1, 2]);
  });

  it('a deferred delivery flips deliveryPending without failing anything (§3.1/#621)', () => {
    const s = summarizeOutcomes([certified(directOp(0, 1n)), certified(directOp(1, 1n), { delivered: false })]);
    expect(s.deliveryPending).toBe(true);
    expect(s.primaryError).toBeUndefined();
    expect(s.committedAmount).toBe(2n);
  });

  it('a split op contributes only splitAmount and propagates its change token (#677)', () => {
    const s = summarizeOutcomes([
      certified(directOp(0, 100n)),
      certified(splitOp(1, 25n, 75n), { changeOutput: FAKE_CHANGE }),
    ]);
    expect(s.committedAmount).toBe(125n); // 100 whole + 25 split — never the split source's full value
    expect(s.changeOutput).toBe(FAKE_CHANGE);
  });

  it('an op that certified but failed a local post-step is STILL committed (money left the wallet)', () => {
    const journalError = new Error('journal write failed');
    const s = summarizeOutcomes([
      certified(directOp(0, 10n)),
      { op: directOp(1, 10n), certified: true, error: journalError },
    ]);
    expect(s.committedUiIds).toEqual(new Set(['ui-0', 'ui-1']));
    expect(s.committedAmount).toBe(20n);
    expect(s.primaryError).toBe(journalError);
    expect(s.conflictTagSourceId).toBeUndefined();
  });
});

describe('summarizeOutcomes — error precedence', () => {
  it('conflict with NOTHING certified: surfaced and tagged for the #625 full re-plan', () => {
    const conflict = new TransferConflictError('lost race');
    const s = summarizeOutcomes([failed(directOp(0, 10n), conflict), failed(directOp(1, 10n), new Error('timeout'))]);
    expect(s.primaryError).toBe(conflict);
    expect(s.conflictTagSourceId).toBe('ui-0');
    expect(s.committedAmount).toBe(0n);
  });

  it('conflict with ≥1 certified sibling: surfaced UNTAGGED, committed amount exact (#677)', () => {
    const conflict = new TransferConflictError('lost race');
    const s = summarizeOutcomes([certified(directOp(0, 60n)), failed(directOp(1, 40n), conflict)]);
    expect(s.primaryError).toBe(conflict);
    expect(s.conflictTagSourceId).toBeUndefined(); // a full-amount re-plan would over-request
    expect(s.committedAmount).toBe(60n);           // remainder = request − 60, exact
  });

  it('keep-open beats a conflict — the intent must survive for resume (#631)', () => {
    const unconfirmed = new ProofUnconfirmedError('proof fetch inconclusive');
    const conflict = new TransferConflictError('lost race');
    const s = summarizeOutcomes([failed(directOp(0, 10n), conflict), failed(directOp(1, 10n), unconfirmed)]);
    expect(s.primaryError).toBe(unconfirmed);
    expect(s.conflictTagSourceId).toBeUndefined(); // tagging would authorize an abort + full re-plan
  });

  it('multiple keep-open failures: the lowest opIndex is surfaced', () => {
    const first = new CheckpointPersistFailedError('checkpoint append failed');
    const second = new ProofUnconfirmedError('proof fetch inconclusive');
    const s = summarizeOutcomes([failed(directOp(1, 1n), second), failed(directOp(0, 1n), first)]);
    expect(s.primaryError).toBe(first);
  });

  it('conflict beats a generic failure even at a higher opIndex', () => {
    const conflict = new TransferConflictError('lost race');
    const s = summarizeOutcomes([failed(directOp(0, 1n), new Error('timeout')), failed(directOp(1, 1n), conflict)]);
    expect(s.primaryError).toBe(conflict);
    expect(s.conflictTagSourceId).toBe('ui-1');
  });

  it('generic failures only: the lowest opIndex is surfaced, no tag', () => {
    const first = new Error('network down');
    const s = summarizeOutcomes([failed(directOp(0, 1n), first), failed(directOp(1, 1n), new Error('later'))]);
    expect(s.primaryError).toBe(first);
    expect(s.conflictTagSourceId).toBeUndefined();
  });
});

describe('isKeepOpenSendError', () => {
  it('matches exactly the four keep-open classes', () => {
    expect(isKeepOpenSendError(new ProofUnconfirmedError('x'))).toBe(true);
    expect(isKeepOpenSendError(new CheckpointPersistFailedError('x'))).toBe(true);
    expect(isKeepOpenSendError(new SplitCheckpointLostError('x'))).toBe(true);
    expect(isKeepOpenSendError(new CheckpointTrustbaseMismatchError('x'))).toBe(true);
    expect(isKeepOpenSendError(new TransferConflictError('x'))).toBe(false);
    expect(isKeepOpenSendError(new Error('x'))).toBe(false);
  });
});
