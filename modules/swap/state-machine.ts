/**
 * SwapModule local state machine.
 *
 * NOTE: The architecture defines 11 states (including PROPOSAL_RECEIVED and REJECTED).
 * This implementation follows the SPEC's 9-state machine:
 * - Acceptors use `progress: 'proposed'` with `role: 'acceptor'` (no PROPOSAL_RECEIVED state)
 * - Rejections transition to `cancelled` (no REJECTED state)
 * - The `swap:rejected` event is emitted alongside `swap:cancelled` for rejection clarity
 */

import type { SwapProgress } from './types.js';
import { SphereError } from '../../core/errors.js';

// =============================================================================
// Valid Transitions
// =============================================================================

/**
 * Defines which progress states can be reached from each state.
 * Terminal states (completed, cancelled, failed) have no outgoing transitions.
 */
export const VALID_PROGRESS_TRANSITIONS: Record<SwapProgress, readonly SwapProgress[]> = {
  proposed:         ['accepted', 'announced', 'cancelled', 'failed'],
  accepted:         ['announced', 'cancelled', 'failed'],
  announced:        ['depositing', 'cancelled', 'failed'],
  depositing:       ['awaiting_counter', 'concluding', 'completed', 'cancelled', 'failed'],
  awaiting_counter: ['concluding', 'completed', 'cancelled', 'failed'],
  concluding:       ['completed', 'cancelled', 'failed'],
  completed:        [],
  cancelled:        [],
  failed:           [],
};

// =============================================================================
// Terminal States
// =============================================================================

/** The set of terminal (final) swap progress states. */
export const TERMINAL_PROGRESS: ReadonlySet<SwapProgress> = new Set<SwapProgress>([
  'completed',
  'cancelled',
  'failed',
]);

// =============================================================================
// Query Helpers
// =============================================================================

/**
 * Returns true if the given progress is a terminal state
 * (completed, cancelled, or failed).
 */
export function isTerminalProgress(progress: SwapProgress): boolean {
  return TERMINAL_PROGRESS.has(progress);
}

/**
 * Returns true if transitioning from `from` to `to` is a valid
 * state machine transition.
 */
export function isValidTransition(from: SwapProgress, to: SwapProgress): boolean {
  return (VALID_PROGRESS_TRANSITIONS[from] as readonly string[]).includes(to);
}

/**
 * Asserts that transitioning from `from` to `to` is valid.
 * Throws `SphereError('SWAP_WRONG_STATE')` if the transition is illegal.
 */
export function assertTransition(from: SwapProgress, to: SwapProgress): void {
  if (!isValidTransition(from, to)) {
    throw new SphereError(
      `Invalid swap progress transition: ${from} → ${to}`,
      'SWAP_WRONG_STATE',
    );
  }
}

// =============================================================================
// Escrow State Mapping
// =============================================================================

/**
 * Maps an escrow-side SwapState string to the corresponding client-side
 * SwapProgress value. Returns `null` if the escrow state is not recognized.
 *
 * The escrow's state machine has finer granularity than the client's.
 * Multiple escrow states may collapse into a single client progress value.
 */
export function mapEscrowStateToProgress(escrowState: string): SwapProgress | null {
  switch (escrowState) {
    case 'ANNOUNCED':
    case 'DEPOSIT_INVOICE_CREATED':
      return 'announced';
    case 'PARTIAL_DEPOSIT':
      return 'depositing';
    case 'DEPOSIT_COVERED':
      return 'awaiting_counter';
    case 'CONCLUDING':
      return 'concluding';
    case 'COMPLETED':
      return 'completed';
    case 'TIMED_OUT':
    case 'CANCELLING':
    case 'CANCELLED':
      return 'cancelled';
    case 'FAILED':
      return 'failed';
    default:
      return null;
  }
}
