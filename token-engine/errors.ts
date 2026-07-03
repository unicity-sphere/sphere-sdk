/**
 * token-engine/errors.ts — the engine's typed error surface (Part E.2).
 */

import { SphereError } from '../core/errors';

/**
 * The source state was already consumed by a *different* transaction — the
 * fetched inclusion proof does not match the rebuilt transaction
 * (`TRANSACTION_HASH_MISMATCH`). Typically the owner's other device raced the
 * same source under a different `transferId` (ARCHITECTURE §7).
 *
 * This is a lost race, **not** an interrupted resume: the engine never applies
 * the foreign proof and never retries. The caller's recovery is to abort the
 * intent, drop the lost source from its plan, and re-plan the remainder under
 * a NEW `transferId` (never reusing the old realization) — sdk-changes E.2.
 */
export class TransferConflictError extends SphereError {
  /**
   * #625: the source token id (the caller's id, e.g. `v2_<genesis>`) whose state was already spent.
   * Set by PaymentsModule at the engine call site so the self-healing retry can demote it and re-plan.
   */
  conflictedSourceId?: string;

  constructor(message: string, cause?: unknown) {
    super(message, 'TRANSFER_CONFLICT', cause);
    this.name = 'TransferConflictError';
  }
}

/**
 * The op's certification is INDETERMINATE: the submit was accepted (`SUCCESS`)
 * or failed ambiguously (a thrown submit POST that may have been processed
 * server-side), and the inclusion-proof fetch/verify returned NO verdict — a
 * transient network/timeout error, NOT a matching proof and NOT
 * `TRANSACTION_HASH_MISMATCH`. The source's spend MAY already be on-chain under
 * THIS `transferId`.
 *
 * Unlike {@link TransferConflictError} (a foreign tx won — abort + re-plan under
 * a NEW id), the caller MUST keep the intent OPEN: resume re-derives the
 * byte-identical transaction from `(seed, transferId, opIndex)` and recovers the
 * certified proof + recipient blob, or records the spend if a foreign tx won the
 * race — never a second on-chain spend (sdk-changes E.2/E.3, #631).
 */
export class ProofUnconfirmedError extends SphereError {
  readonly mayHaveCertified = true as const;

  constructor(message: string, cause?: unknown) {
    super(message, 'CERTIFICATION_UNCONFIRMED', cause);
    this.name = 'ProofUnconfirmedError';
  }
}
