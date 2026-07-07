/**
 * Import/Export taxonomy — result types for {@link importTokens}.
 *
 * Extracted from PaymentsModule.ts:322–396 during Phase 5 (uxfv2-refactor-
 * design.md §2.1 and uxfv2-phase-5-payments-disposition.md). Behavior-
 * preserving: same shapes as before. Re-exported through PaymentsModule.ts
 * so external consumer imports (`import { ImportTokensResult, ... } from
 * '@unicitylabs/sphere-sdk'`) keep working unchanged.
 *
 * Codes are stable enums suitable for switch-on-code logic in callers
 * (CLI, scripting, UI).
 */

/**
 * Outcome codes for a successfully-imported token.
 */
export type ImportAddedCode =
  /** Token was new to the wallet — fresh acquisition. */
  | 'added'
  /**
   * Lenient mode only: an active (confirmed or submitted) state of
   * the same genesis tokenId existed in the wallet and has been
   * archived by addToken's state-update path. The imported state is
   * now authoritative. Distinct from `'stale-record-replaced'` below.
   */
  | 'state-replaced'
  /**
   * Lenient mode only: the wallet already held a record for the same
   * genesis tokenId but its status was `'spent'` or `'invalid'` — the
   * prior entry was a dead bookkeeping record, not an active state.
   * Import simply resurrected the tokenId. UI should treat this as
   * effectively fresh ('added'-like) with no warning.
   */
  | 'stale-record-replaced';

export type ImportSkipCode =
  /** Exact (tokenId, stateHash) already in the wallet. */
  | 'duplicate'
  /** (tokenId, stateHash) was previously spent from this wallet. */
  | 'tombstoned'
  /**
   * Strict-mode only: tokenId is in the wallet at a DIFFERENT state
   * and we refuse to clobber that state from an import.
   */
  | 'genesis-exists'
  /** addToken returned false despite the pre-checks (race or unknown). */
  | 'unknown';

export type ImportRejectCode =
  /** TxfToken structure is invalid (missing fields, wrong types, etc.). */
  | 'malformed'
  /** addToken threw an unexpected error during the write path. */
  | 'add-failed';

/**
 * Discriminated union so `note` is structurally required on the
 * `'state-replaced'` and `'stale-record-replaced'` branches — consumers
 * don't need `!` assertions after switch-on-code.
 */
export type ImportAdded =
  | {
      readonly localId: string;
      readonly genesisTokenId: string;
      readonly code: 'added';
    }
  | {
      readonly localId: string;
      readonly genesisTokenId: string;
      readonly code: 'state-replaced' | 'stale-record-replaced';
      readonly note: string;
    };

export interface ImportSkipped {
  readonly genesisTokenId: string;
  readonly code: ImportSkipCode;
  readonly reason: string;
}

export interface ImportRejected {
  readonly genesisTokenId: string | null;
  readonly code: ImportRejectCode;
  readonly reason: string;
}

export interface ImportTokensResult {
  readonly added: ImportAdded[];
  readonly skipped: ImportSkipped[];
  readonly rejected: ImportRejected[];
}
