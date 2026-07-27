/**
 * SendOperations — the parallel-send decision layer.
 *
 * One send() fans out into N independent on-chain operations (0–N whole-token
 * transfers + at most one split, ARCHITECTURE §7). PaymentsModule certifies
 * them concurrently (bounded batches) and reduces the SETTLED outcomes here:
 * committed accounting plus the one error to surface. Everything in this file
 * is pure data + pure functions — no I/O, no wallet state — so the money-
 * critical failure semantics (#625/#677/#631) are table-testable in isolation
 * (tests/unit/modules/SendOperations.test.ts).
 */

import type { SphereToken } from '../../token-engine';
import {
  CheckpointPersistFailedError,
  CheckpointTrustbaseMismatchError,
  ProofUnconfirmedError,
  SplitCheckpointLostError,
  TransferConflictError,
} from '../../token-engine';

/**
 * Cap on a send's on-chain operations (direct transfers + the at-most-one
 * split) certified concurrently. Mirrors the split fan-out's
 * MAX_MINT_CONCURRENCY (token-engine/SphereTokenEngine.ts, #684) and its
 * rationale: an unbounded fan-out would submit + proof-poll every operation at
 * once against the gateway. Deliberately NOT imported from the engine — that
 * constant is private to the engine implementation.
 */
export const MAX_SEND_OPERATION_CONCURRENCY = 8;

/** One on-chain operation of a send: a whole-token transfer, or the at-most-one split. */
export interface SendOperation {
  readonly kind: 'direct' | 'split';
  /** Position in the persisted intent's op order — the stable (transferId, opIndex) resume key (§8.1). */
  readonly opIndex: number;
  readonly uiTokenId: string;
  readonly genesisId: string;
  /** The source blob AS HELD (pre-spend) — the single authority for both spent-state derivations (M2/M3). */
  readonly sourceSdkData: string;
  readonly sdkToken: SphereToken;
  /** Value this op delivers to the recipient (#677): direct = the whole token amount, split = splitAmount only. */
  readonly deliveredAmount: bigint;
  /** Split only: the change value minted back to this wallet. */
  readonly remainderAmount?: bigint;
}

/**
 * Settled outcome of one send operation. `certified` and `error` are
 * deliberately orthogonal: certified+error means the on-chain spend happened
 * but a local post-step (the journal write) failed — accounting MUST still
 * count the op as committed (the money left the wallet; resume recovers the
 * journaled blob from the intent).
 */
export interface OperationOutcome {
  readonly op: SendOperation;
  readonly certified: boolean;
  /** tryDeliver result; false = deferred, blob stays journaled (§3.1/#621). Only present when certified. */
  readonly delivered?: boolean;
  /** Split only: the change token minted back to this wallet (present once certified). */
  readonly changeOutput?: SphereToken;
  readonly error?: unknown;
}

/**
 * The one summary the sequential apply/failure path consumes. Derived from
 * SETTLED outcomes only — never from in-flight state — so the #625 tag and the
 * #677 remainder arithmetic can never under-count concurrent certifications
 * (an under-count re-plans too much and double-pays the recipient).
 */
export interface SendOutcomeSummary {
  /** Certified ops in plan (opIndex) order — committed on-chain regardless of later local failures. */
  readonly committed: OperationOutcome[];
  readonly committedUiIds: Set<string>;
  /** Σ deliveredAmount over committed ops (#677). */
  readonly committedAmount: bigint;
  /** True when any committed op's delivery was deferred (§3.1/#621). */
  readonly deliveryPending: boolean;
  readonly changeOutput: SphereToken | null;
  /** The ONE error to surface (keep-open > conflict > other, lowest opIndex). Undefined = full success. */
  readonly primaryError?: unknown;
  /** #625: uiTokenId to tag onto a surfaced conflict — set ONLY when nothing certified in this attempt. */
  readonly conflictTagSourceId?: string;
}

/**
 * The keep-open error family: the op may have certified even though it threw,
 * so the intent MUST stay open for resume (#631 / E.4). Shared by the outcome
 * reduction and sendOnce's failure disposition — the two MUST agree.
 */
export function isKeepOpenSendError(err: unknown): boolean {
  return (
    err instanceof ProofUnconfirmedError ||
    err instanceof CheckpointPersistFailedError ||
    err instanceof SplitCheckpointLostError ||
    err instanceof CheckpointTrustbaseMismatchError
  );
}

/**
 * Reduce a send's settled operation outcomes to committed accounting + the one
 * error to surface. Pure. Error precedence (lowest opIndex within each class):
 *  1. keep-open (ProofUnconfirmed / checkpoint trio) — surfacing anything else
 *     could let the failure disposition abort an intent while this op's spend
 *     may be on-chain (stranded value);
 *  2. TransferConflictError — carries the #625/#677 recovery contracts;
 *  3. anything else (timeout, network, journal write).
 */
export function summarizeOutcomes(outcomes: readonly OperationOutcome[]): SendOutcomeSummary {
  const committed = outcomes
    .filter((o) => o.certified)
    .sort((a, b) => a.op.opIndex - b.op.opIndex);
  const base = {
    committed,
    committedUiIds: new Set(committed.map((o) => o.op.uiTokenId)),
    committedAmount: committed.reduce((sum, o) => sum + o.op.deliveredAmount, 0n),
    deliveryPending: committed.some((o) => o.delivered === false),
    changeOutput: committed.find((o) => o.changeOutput !== undefined)?.changeOutput ?? null,
  };

  const failures = outcomes
    .filter((o) => o.error !== undefined)
    .sort((a, b) => a.op.opIndex - b.op.opIndex);
  if (failures.length === 0) return base;

  const keepOpen = failures.find((o) => isKeepOpenSendError(o.error));
  if (keepOpen !== undefined) return { ...base, primaryError: keepOpen.error };

  const conflict = failures.find((o) => o.error instanceof TransferConflictError);
  const primary = conflict ?? failures[0];
  return {
    ...base,
    primaryError: primary.error,
    // #625: a full-amount re-plan is safe only when NOTHING certified in this
    // attempt — decided here from the complete settled set, never mid-flight.
    ...(conflict !== undefined && committed.length === 0
      ? { conflictTagSourceId: conflict.op.uiTokenId }
      : {}),
  };
}
