// What a planned op is and what its outcome means — pure helpers shared by the
// send and resume paths of TransferMachine (§5.5/§5.6 of docs/PAYMENTS-V2-DESIGN.md).

import type { ITokenEngine } from '../../../token-engine/engine';
import type { SphereToken } from '../../../token-engine/types';
import {
  CheckpointPersistFailedError,
  CheckpointTrustbaseMismatchError,
  ProofUnconfirmedError,
  SplitCheckpointLostError,
  TransferConflictError,
} from '../../../token-engine/errors';
import { coinIdOf, splitOf } from './payload-view';
import type { IntentPayload, OutcomeClass, PlannedOp } from './types';

const KEEP_OPEN_CODES = new Set([
  'CERTIFICATION_UNCONFIRMED',
  'CHECKPOINT_PERSIST_FAILED',
  'SPLIT_CHECKPOINT_LOST',
  'CHECKPOINT_TRUSTBASE_MISMATCH',
]);

/** opIndex is plan-derived: the op's position in direct[], split at direct.length (E.1). */
export function buildOps(payload: IntentPayload): PlannedOp[] {
  const ops: PlannedOp[] = payload.direct.map((sourceTokenId, opIndex) => ({
    kind: 'direct',
    opIndex,
    sourceTokenId,
    deliveredAmount: 0n,
  }));
  if (payload.split !== undefined) {
    ops.push({
      kind: 'split',
      opIndex: payload.direct.length,
      sourceTokenId: payload.split.tokenId,
      deliveredAmount: BigInt(payload.split.splitAmount),
    });
  }
  return ops;
}

export function classifyError(e: unknown): OutcomeClass {
  if (
    e instanceof ProofUnconfirmedError ||
    e instanceof SplitCheckpointLostError ||
    e instanceof CheckpointPersistFailedError ||
    e instanceof CheckpointTrustbaseMismatchError
  ) {
    return 'keep-open';
  }
  if (e instanceof TransferConflictError) return 'conflict';
  const coded = e !== null && typeof e === 'object' ? (e as { code?: unknown; mayHaveCertified?: unknown }) : null;
  if (coded !== null) {
    if (coded.mayHaveCertified === true) return 'keep-open';
    if (typeof coded.code === 'string' && KEEP_OPEN_CODES.has(coded.code)) return 'keep-open';
    if (coded.code === 'TRANSFER_CONFLICT') return 'conflict';
  }
  return 'other';
}

export function conflictAmount(
  engine: ITokenEngine,
  payload: IntentPayload,
  op: PlannedOp,
  source: SphereToken | undefined
): bigint {
  const split = splitOf(payload);
  if (op.kind === 'split') return BigInt(split!.splitAmount);
  const coinId = coinIdOf(payload);
  if (coinId === undefined) return 0n; // token-addressed: the unit is the token
  return source !== undefined ? engine.balanceOf(source, coinId) : 0n;
}
