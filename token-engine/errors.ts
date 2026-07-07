// SHA-pinned from unicity-sphere/sphere-sdk main@ce758f6b — do not modify without a re-sync note.
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

/**
 * A split's burn certified but its checkpoint (sdk-changes E.4, sphere-sdk#501) could NOT be
 * durably persisted — the `SplitCheckpointStore.put` rejected (network / 5xx / timeout / quota) —
 * so NO mint leg was submitted. The burn is on-chain (funds in-flight, not lost); the outputs are
 * fully recoverable on resume.
 *
 * Keep-open family (like {@link ProofUnconfirmedError}): the caller MUST keep the intent OPEN and
 * resume under the SAME `transferId` — the next attempt re-derives the byte-identical burn,
 * re-persists the checkpoint (content-idempotent), and mints. NEVER abort.
 */
export class CheckpointPersistFailedError extends SphereError {
  readonly mayHaveCertified = true as const;

  constructor(message: string, cause?: unknown) {
    super(message, 'CHECKPOINT_PERSIST_FAILED', cause);
    this.name = 'CheckpointPersistFailedError';
  }
}

/**
 * A split cannot be rebuilt from its checkpoint, in a way that is NOT a lost race: either a mint
 * leaf is already certified on-chain but no stored bytes reproduce its certified transactionHash
 * (server data loss / withholding, or a pre-E.4 legacy intent), or a stored checkpoint fails its
 * byte-binding checks (the re-derived burn tx ≠ the stored bytes — cross-version derivation drift
 * — or a corrupt stored proof, or a burnt-token re-encode mismatch).
 *
 * Distinct from {@link TransferConflictError}: a split-mint stateId is HKDF-derived from
 * `(seed, transferId)`, so only a seed-holder under THIS `transferId` can have certified it — this
 * is never a foreign spend. Keep-open, alert loudly: the caller MUST NOT abort, NOT complete, and
 * NOT record the source as foreign-spent (sdk-changes E.4).
 */
export class SplitCheckpointLostError extends SphereError {
  constructor(message: string, cause?: unknown) {
    super(message, 'SPLIT_CHECKPOINT_LOST', cause);
    this.name = 'SplitCheckpointLostError';
  }
}

/**
 * A stored split checkpoint (sdk-changes E.4) is authentic and byte-bound to the re-derived burn
 * transaction, but its inclusion proof no longer verifies against the CURRENT trust base
 * (`INVALID_TRUSTBASE`) — a validator-set / quorum rotation while the intent was open. The bytes
 * are NOT wrong; re-burning would strand the certified split, so the engine never falls through to
 * a re-burn.
 *
 * Keep-open, distinct signal: the operational remedy is to drain open split intents BEFORE a
 * validator rotation (the SDK has no epoch map — single-epoch trust base, ARCHITECTURE §8.2/§19).
 */
export class CheckpointTrustbaseMismatchError extends SphereError {
  constructor(message: string, cause?: unknown) {
    super(message, 'CHECKPOINT_TRUSTBASE_MISMATCH', cause);
    this.name = 'CheckpointTrustbaseMismatchError';
  }
}
