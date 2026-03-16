/**
 * SwapModule.stateMachine.test.ts
 *
 * UT-SWAP-SM-001 through UT-SWAP-SM-028
 * Tests for state-machine.ts: assertTransition, isTerminalProgress,
 * isValidTransition, mapEscrowStateToProgress, VALID_PROGRESS_TRANSITIONS.
 * These test state-machine.ts directly (not through SwapModule).
 */

import { describe, it, expect } from 'vitest';
import {
  assertTransition,
  isTerminalProgress,
  isValidTransition,
  mapEscrowStateToProgress,
  VALID_PROGRESS_TRANSITIONS,
  TERMINAL_PROGRESS,
} from '../../../modules/swap/state-machine.js';
import { SphereError } from '../../../core/errors.js';
import type { SwapProgress } from '../../../modules/swap/types.js';

describe('SwapModule — state machine (state-machine.ts)', () => {
  // =========================================================================
  // Valid transitions from 'proposed'
  // =========================================================================

  describe('valid transitions from proposed', () => {
    // UT-SWAP-SM-001: proposed -> accepted
    it('UT-SWAP-SM-001: proposed -> accepted is valid', () => {
      expect(() => assertTransition('proposed', 'accepted')).not.toThrow();
      expect(isValidTransition('proposed', 'accepted')).toBe(true);
    });

    // UT-SWAP-SM-002: proposed -> cancelled
    it('UT-SWAP-SM-002: proposed -> cancelled is valid', () => {
      expect(() => assertTransition('proposed', 'cancelled')).not.toThrow();
      expect(isValidTransition('proposed', 'cancelled')).toBe(true);
    });

    // UT-SWAP-SM-003: proposed -> failed
    it('UT-SWAP-SM-003: proposed -> failed is valid', () => {
      expect(() => assertTransition('proposed', 'failed')).not.toThrow();
      expect(isValidTransition('proposed', 'failed')).toBe(true);
    });
  });

  // =========================================================================
  // Valid transitions from 'accepted'
  // =========================================================================

  describe('valid transitions from accepted', () => {
    // UT-SWAP-SM-004: accepted -> announced
    it('UT-SWAP-SM-004: accepted -> announced is valid', () => {
      expect(() => assertTransition('accepted', 'announced')).not.toThrow();
      expect(isValidTransition('accepted', 'announced')).toBe(true);
    });

    // UT-SWAP-SM-005: accepted -> failed
    it('UT-SWAP-SM-005: accepted -> failed is valid', () => {
      expect(() => assertTransition('accepted', 'failed')).not.toThrow();
      expect(isValidTransition('accepted', 'failed')).toBe(true);
    });

    // UT-SWAP-SM-006: accepted -> cancelled
    it('UT-SWAP-SM-006: accepted -> cancelled is valid', () => {
      expect(() => assertTransition('accepted', 'cancelled')).not.toThrow();
      expect(isValidTransition('accepted', 'cancelled')).toBe(true);
    });
  });

  // =========================================================================
  // Valid transitions from 'announced'
  // =========================================================================

  describe('valid transitions from announced', () => {
    // UT-SWAP-SM-007: announced -> depositing
    it('UT-SWAP-SM-007: announced -> depositing is valid', () => {
      expect(() => assertTransition('announced', 'depositing')).not.toThrow();
      expect(isValidTransition('announced', 'depositing')).toBe(true);
    });

    // UT-SWAP-SM-008: announced -> cancelled
    it('UT-SWAP-SM-008: announced -> cancelled is valid', () => {
      expect(() => assertTransition('announced', 'cancelled')).not.toThrow();
      expect(isValidTransition('announced', 'cancelled')).toBe(true);
    });
  });

  // =========================================================================
  // Valid transitions from 'depositing'
  // =========================================================================

  describe('valid transitions from depositing', () => {
    // UT-SWAP-SM-009: depositing -> awaiting_counter
    it('UT-SWAP-SM-009: depositing -> awaiting_counter is valid', () => {
      expect(() => assertTransition('depositing', 'awaiting_counter')).not.toThrow();
      expect(isValidTransition('depositing', 'awaiting_counter')).toBe(true);
    });

    // UT-SWAP-SM-010: depositing -> failed
    it('UT-SWAP-SM-010: depositing -> failed is valid', () => {
      expect(() => assertTransition('depositing', 'failed')).not.toThrow();
      expect(isValidTransition('depositing', 'failed')).toBe(true);
    });

    // UT-SWAP-SM-010a: depositing -> cancelled
    it('UT-SWAP-SM-010a: depositing -> cancelled is valid', () => {
      expect(() => assertTransition('depositing', 'cancelled')).not.toThrow();
      expect(isValidTransition('depositing', 'cancelled')).toBe(true);
    });

    // depositing -> concluding
    it('depositing -> concluding is valid', () => {
      expect(() => assertTransition('depositing', 'concluding')).not.toThrow();
      expect(isValidTransition('depositing', 'concluding')).toBe(true);
    });

    // depositing -> completed
    it('depositing -> completed is valid', () => {
      expect(() => assertTransition('depositing', 'completed')).not.toThrow();
      expect(isValidTransition('depositing', 'completed')).toBe(true);
    });
  });

  // =========================================================================
  // Valid transitions from 'awaiting_counter'
  // =========================================================================

  describe('valid transitions from awaiting_counter', () => {
    // UT-SWAP-SM-011: awaiting_counter -> concluding
    it('UT-SWAP-SM-011: awaiting_counter -> concluding is valid', () => {
      expect(() => assertTransition('awaiting_counter', 'concluding')).not.toThrow();
      expect(isValidTransition('awaiting_counter', 'concluding')).toBe(true);
    });

    // UT-SWAP-SM-012: awaiting_counter -> cancelled
    it('UT-SWAP-SM-012: awaiting_counter -> cancelled is valid', () => {
      expect(() => assertTransition('awaiting_counter', 'cancelled')).not.toThrow();
      expect(isValidTransition('awaiting_counter', 'cancelled')).toBe(true);
    });

    // awaiting_counter -> completed
    it('awaiting_counter -> completed is valid', () => {
      expect(() => assertTransition('awaiting_counter', 'completed')).not.toThrow();
    });

    // awaiting_counter -> failed
    it('awaiting_counter -> failed is valid', () => {
      expect(() => assertTransition('awaiting_counter', 'failed')).not.toThrow();
    });
  });

  // =========================================================================
  // Valid transitions from 'concluding'
  // =========================================================================

  describe('valid transitions from concluding', () => {
    // UT-SWAP-SM-013: concluding -> completed
    it('UT-SWAP-SM-013: concluding -> completed is valid', () => {
      expect(() => assertTransition('concluding', 'completed')).not.toThrow();
      expect(isValidTransition('concluding', 'completed')).toBe(true);
    });

    // UT-SWAP-SM-014: concluding -> cancelled
    it('UT-SWAP-SM-014: concluding -> cancelled is valid', () => {
      expect(() => assertTransition('concluding', 'cancelled')).not.toThrow();
      expect(isValidTransition('concluding', 'cancelled')).toBe(true);
    });

    // UT-SWAP-SM-015: concluding -> failed
    it('UT-SWAP-SM-015: concluding -> failed is valid', () => {
      expect(() => assertTransition('concluding', 'failed')).not.toThrow();
      expect(isValidTransition('concluding', 'failed')).toBe(true);
    });
  });

  // =========================================================================
  // Invalid transitions
  // =========================================================================

  describe('invalid transitions throw SWAP_WRONG_STATE', () => {
    // UT-SWAP-SM-016: proposed -> depositing
    it('UT-SWAP-SM-016: proposed -> depositing is invalid', () => {
      expect(() => assertTransition('proposed', 'depositing')).toThrow(SphereError);
      try {
        assertTransition('proposed', 'depositing');
      } catch (err) {
        expect((err as SphereError).code).toBe('SWAP_WRONG_STATE');
      }
    });

    // UT-SWAP-SM-017: proposed -> concluding
    it('UT-SWAP-SM-017: proposed -> concluding is invalid', () => {
      expect(() => assertTransition('proposed', 'concluding')).toThrow(SphereError);
      expect(isValidTransition('proposed', 'concluding')).toBe(false);
    });

    // UT-SWAP-SM-018: announced -> completed
    it('UT-SWAP-SM-018: announced -> completed is invalid', () => {
      expect(() => assertTransition('announced', 'completed')).toThrow(SphereError);
      expect(isValidTransition('announced', 'completed')).toBe(false);
    });

    // UT-SWAP-SM-019: depositing -> announced
    it('UT-SWAP-SM-019: depositing -> announced is invalid', () => {
      expect(() => assertTransition('depositing', 'announced')).toThrow(SphereError);
      expect(isValidTransition('depositing', 'announced')).toBe(false);
    });

    // UT-SWAP-SM-020: awaiting_counter -> proposed
    it('UT-SWAP-SM-020: awaiting_counter -> proposed is invalid', () => {
      expect(() => assertTransition('awaiting_counter', 'proposed')).toThrow(SphereError);
      expect(isValidTransition('awaiting_counter', 'proposed')).toBe(false);
    });

    // UT-SWAP-SM-021: completed -> cancelled
    it('UT-SWAP-SM-021: completed -> cancelled is invalid (terminal state)', () => {
      expect(() => assertTransition('completed', 'cancelled')).toThrow(SphereError);
      expect(isValidTransition('completed', 'cancelled')).toBe(false);
    });

    // UT-SWAP-SM-022: completed -> depositing
    it('UT-SWAP-SM-022: completed -> depositing is invalid (terminal state)', () => {
      expect(() => assertTransition('completed', 'depositing')).toThrow(SphereError);
      expect(isValidTransition('completed', 'depositing')).toBe(false);
    });

    // UT-SWAP-SM-023: cancelled -> proposed
    it('UT-SWAP-SM-023: cancelled -> proposed is invalid (terminal state)', () => {
      expect(() => assertTransition('cancelled', 'proposed')).toThrow(SphereError);
      expect(isValidTransition('cancelled', 'proposed')).toBe(false);
    });

    // UT-SWAP-SM-024: cancelled -> depositing
    it('UT-SWAP-SM-024: cancelled -> depositing is invalid (terminal state)', () => {
      expect(() => assertTransition('cancelled', 'depositing')).toThrow(SphereError);
      expect(isValidTransition('cancelled', 'depositing')).toBe(false);
    });

    // UT-SWAP-SM-025: failed -> depositing
    it('UT-SWAP-SM-025: failed -> depositing is invalid (terminal state)', () => {
      expect(() => assertTransition('failed', 'depositing')).toThrow(SphereError);
      expect(isValidTransition('failed', 'depositing')).toBe(false);
    });
  });

  // =========================================================================
  // Terminal states have no valid transitions
  // =========================================================================

  describe('terminal states have no valid outgoing transitions', () => {
    it('completed has empty transition list', () => {
      expect(VALID_PROGRESS_TRANSITIONS['completed']).toEqual([]);
    });

    it('cancelled has empty transition list', () => {
      expect(VALID_PROGRESS_TRANSITIONS['cancelled']).toEqual([]);
    });

    it('failed has empty transition list', () => {
      expect(VALID_PROGRESS_TRANSITIONS['failed']).toEqual([]);
    });
  });

  // =========================================================================
  // UT-SWAP-SM-026: isTerminalProgress
  // =========================================================================

  describe('UT-SWAP-SM-026: isTerminalProgress', () => {
    it('completed is terminal', () => {
      expect(isTerminalProgress('completed')).toBe(true);
    });

    it('cancelled is terminal', () => {
      expect(isTerminalProgress('cancelled')).toBe(true);
    });

    it('failed is terminal', () => {
      expect(isTerminalProgress('failed')).toBe(true);
    });

    it('proposed is NOT terminal', () => {
      expect(isTerminalProgress('proposed')).toBe(false);
    });

    it('accepted is NOT terminal', () => {
      expect(isTerminalProgress('accepted')).toBe(false);
    });

    it('announced is NOT terminal', () => {
      expect(isTerminalProgress('announced')).toBe(false);
    });

    it('depositing is NOT terminal', () => {
      expect(isTerminalProgress('depositing')).toBe(false);
    });

    it('awaiting_counter is NOT terminal', () => {
      expect(isTerminalProgress('awaiting_counter')).toBe(false);
    });

    it('concluding is NOT terminal', () => {
      expect(isTerminalProgress('concluding')).toBe(false);
    });
  });

  // =========================================================================
  // UT-SWAP-SM-027: mapEscrowStateToProgress
  // =========================================================================

  describe('UT-SWAP-SM-027: mapEscrowStateToProgress maps all 10 escrow states', () => {
    it('ANNOUNCED -> announced', () => {
      expect(mapEscrowStateToProgress('ANNOUNCED')).toBe('announced');
    });

    it('DEPOSIT_INVOICE_CREATED -> announced', () => {
      expect(mapEscrowStateToProgress('DEPOSIT_INVOICE_CREATED')).toBe('announced');
    });

    it('PARTIAL_DEPOSIT -> depositing', () => {
      expect(mapEscrowStateToProgress('PARTIAL_DEPOSIT')).toBe('depositing');
    });

    it('DEPOSIT_COVERED -> awaiting_counter', () => {
      expect(mapEscrowStateToProgress('DEPOSIT_COVERED')).toBe('awaiting_counter');
    });

    it('CONCLUDING -> concluding', () => {
      expect(mapEscrowStateToProgress('CONCLUDING')).toBe('concluding');
    });

    it('COMPLETED -> completed', () => {
      expect(mapEscrowStateToProgress('COMPLETED')).toBe('completed');
    });

    it('TIMED_OUT -> cancelled', () => {
      expect(mapEscrowStateToProgress('TIMED_OUT')).toBe('cancelled');
    });

    it('CANCELLING -> cancelled', () => {
      expect(mapEscrowStateToProgress('CANCELLING')).toBe('cancelled');
    });

    it('CANCELLED -> cancelled', () => {
      expect(mapEscrowStateToProgress('CANCELLED')).toBe('cancelled');
    });

    it('FAILED -> failed', () => {
      expect(mapEscrowStateToProgress('FAILED')).toBe('failed');
    });

    it('unknown escrow state returns null', () => {
      expect(mapEscrowStateToProgress('NONEXISTENT_STATE')).toBeNull();
    });
  });

  // =========================================================================
  // UT-SWAP-SM-028: TERMINAL_PROGRESS set is correct
  // =========================================================================

  it('UT-SWAP-SM-028: TERMINAL_PROGRESS contains exactly completed, cancelled, failed', () => {
    expect(TERMINAL_PROGRESS.size).toBe(3);
    expect(TERMINAL_PROGRESS.has('completed')).toBe(true);
    expect(TERMINAL_PROGRESS.has('cancelled')).toBe(true);
    expect(TERMINAL_PROGRESS.has('failed')).toBe(true);
    expect(TERMINAL_PROGRESS.has('proposed' as SwapProgress)).toBe(false);
  });
});
