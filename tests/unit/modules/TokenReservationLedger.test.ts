/**
 * Tests for modules/payments/TokenReservationLedger.ts
 *
 * Pure synchronous unit tests. No mocks needed — TokenReservationLedger
 * is a standalone data structure with no external dependencies.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  TokenReservationLedger,
  type ReservationEntry,
} from '../../../modules/payments/TokenReservationLedger';

// =============================================================================
// Helpers
// =============================================================================

/** Shorthand for creating a single-token reservation entry array. */
function entry(tokenId: string, amount: bigint, tokenAmount: bigint) {
  return [{ tokenId, amount, tokenAmount }];
}

/** Shorthand for creating a multi-token reservation entry array. */
function entries(
  ...items: Array<{ tokenId: string; amount: bigint; tokenAmount: bigint }>
) {
  return items;
}

// =============================================================================
// Tests
// =============================================================================

describe('TokenReservationLedger', () => {
  let ledger: TokenReservationLedger;

  beforeEach(() => {
    ledger = new TokenReservationLedger();
  });

  // ---------------------------------------------------------------------------
  // Basic Operations
  // ---------------------------------------------------------------------------

  describe('Basic Operations', () => {
    it('reserve() creates a reservation with correct amounts', () => {
      ledger.reserve('res-1', entry('tok-1', 500000n, 1000000n), 'UCT');

      expect(ledger.getFreeAmount('tok-1', 1000000n)).toBe(500000n);
      expect(ledger.getTotalReserved('tok-1')).toBe(500000n);
      expect(ledger.getSize()).toBe(1);
    });

    it('reserve() for multiple tokens in one reservation', () => {
      ledger.reserve(
        'res-1',
        entries(
          { tokenId: 'tok-1', amount: 400000n, tokenAmount: 1000000n },
          { tokenId: 'tok-2', amount: 1000000n, tokenAmount: 2000000n },
        ),
        'UCT',
      );

      expect(ledger.getFreeAmount('tok-1', 1000000n)).toBe(600000n);
      expect(ledger.getFreeAmount('tok-2', 2000000n)).toBe(1000000n);
      // Unreferenced token is unaffected
      expect(ledger.getFreeAmount('tok-3', 500000n)).toBe(500000n);
      expect(ledger.getTotalReserved('tok-1')).toBe(400000n);
      expect(ledger.getTotalReserved('tok-2')).toBe(1000000n);
    });

    it('commit() deletes reservation and frees capacity', () => {
      ledger.reserve('res-1', entry('tok-1', 500000n, 1000000n), 'UCT');
      ledger.commit('res-1');

      // Committed reservations are deleted from the ledger
      expect(ledger.getReservation('res-1')).toBeUndefined();
      // Capacity is freed (no longer in token index)
      expect(ledger.getFreeAmount('tok-1', 1000000n)).toBe(1000000n);
      expect(ledger.getTotalReserved('tok-1')).toBe(0n);
    });

    it('cancel() releases reservation amounts', () => {
      ledger.reserve('res-1', entry('tok-1', 500000n, 1000000n), 'UCT');
      ledger.cancel('res-1');

      expect(ledger.getFreeAmount('tok-1', 1000000n)).toBe(1000000n);
      expect(ledger.getTotalReserved('tok-1')).toBe(0n);
    });

    it('getFreeAmount() returns token amount minus all active reservations', () => {
      ledger.reserve('res-1', entry('tok-1', 300000n, 1000000n), 'UCT');
      ledger.reserve('res-2', entry('tok-1', 400000n, 1000000n), 'UCT');

      expect(ledger.getFreeAmount('tok-1', 1000000n)).toBe(300000n);
    });

    it('getTotalReserved() sums across all active reservations for a token', () => {
      ledger.reserve('res-1', entry('tok-1', 300000n, 1000000n), 'UCT');
      ledger.reserve('res-2', entry('tok-1', 400000n, 1000000n), 'UCT');

      expect(ledger.getTotalReserved('tok-1')).toBe(700000n);
    });

    it('getTotalReserved() returns 0n for unknown token', () => {
      expect(ledger.getTotalReserved('nonexistent')).toBe(0n);
    });

    it('getFreeAmount() returns full tokenAmount for unknown token', () => {
      expect(ledger.getFreeAmount('nonexistent', 1000000n)).toBe(1000000n);
    });

    it('hasActiveReservation() returns true when active reservation exists', () => {
      ledger.reserve('res-1', entry('tok-1', 300000n, 1000000n), 'UCT');
      expect(ledger.hasActiveReservation('tok-1')).toBe(true);
    });

    it('hasActiveReservation() returns false after cancel', () => {
      ledger.reserve('res-1', entry('tok-1', 300000n, 1000000n), 'UCT');
      ledger.cancel('res-1');
      expect(ledger.hasActiveReservation('tok-1')).toBe(false);
    });

    it('hasActiveReservation() returns false for committed-only token', () => {
      ledger.reserve('res-1', entry('tok-1', 300000n, 1000000n), 'UCT');
      ledger.commit('res-1');
      // committed is NOT active
      expect(ledger.hasActiveReservation('tok-1')).toBe(false);
    });

    it('hasActiveReservation() returns false for unknown token', () => {
      expect(ledger.hasActiveReservation('nonexistent')).toBe(false);
    });

    it('getReservation() returns the reservation entry', () => {
      ledger.reserve('res-1', entry('tok-1', 500000n, 1000000n), 'UCT');
      const res = ledger.getReservation('res-1');
      expect(res).toBeDefined();
      expect(res!.reservationId).toBe('res-1');
      expect(res!.coinId).toBe('UCT');
      expect(res!.status).toBe('active');
      expect(res!.amounts.get('tok-1')).toBe(500000n);
    });

    it('getReservation() returns undefined for unknown id', () => {
      expect(ledger.getReservation('nonexistent')).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Partial Reservation (Multiple sends from same token)
  // ---------------------------------------------------------------------------

  describe('Partial Reservation', () => {
    it('two reservations on same token, each claiming part of the amount', () => {
      ledger.reserve('res-1', entry('tok-1', 300000n, 1000000n), 'UCT');
      ledger.reserve('res-2', entry('tok-1', 400000n, 1000000n), 'UCT');

      expect(ledger.getSize()).toBe(2);
      expect(ledger.getFreeAmount('tok-1', 1000000n)).toBe(300000n);
    });

    it('cancel one partial reservation, other remains with updated free amount', () => {
      ledger.reserve('res-1', entry('tok-1', 300000n, 1000000n), 'UCT');
      ledger.reserve('res-2', entry('tok-1', 400000n, 1000000n), 'UCT');

      ledger.cancel('res-1');

      expect(ledger.getFreeAmount('tok-1', 1000000n)).toBe(600000n);
      expect(ledger.getTotalReserved('tok-1')).toBe(400000n);
    });

    it('commit one, cancel other: both free capacity fully', () => {
      ledger.reserve('res-1', entry('tok-1', 300000n, 1000000n), 'UCT');
      ledger.reserve('res-2', entry('tok-1', 400000n, 1000000n), 'UCT');

      ledger.commit('res-1');
      ledger.cancel('res-2');

      // Commit deletes reservation and frees capacity; cancel also frees capacity
      expect(ledger.getFreeAmount('tok-1', 1000000n)).toBe(1000000n);
      expect(ledger.getTotalReserved('tok-1')).toBe(0n);
    });

    it('three partial reservations exhausting full token amount', () => {
      ledger.reserve('res-1', entry('tok-1', 300000n, 1000000n), 'UCT');
      ledger.reserve('res-2', entry('tok-1', 400000n, 1000000n), 'UCT');
      ledger.reserve('res-3', entry('tok-1', 300000n, 1000000n), 'UCT');

      expect(ledger.getFreeAmount('tok-1', 1000000n)).toBe(0n);
      expect(ledger.getTotalReserved('tok-1')).toBe(1000000n);
    });

    it('duplicate tokenId entries within one reservation are accumulated', () => {
      // Two entries for same tokenId in one reserve call
      ledger.reserve(
        'res-1',
        entries(
          { tokenId: 'tok-1', amount: 200000n, tokenAmount: 1000000n },
          { tokenId: 'tok-1', amount: 300000n, tokenAmount: 1000000n },
        ),
        'UCT',
      );

      expect(ledger.getTotalReserved('tok-1')).toBe(500000n);
      expect(ledger.getFreeAmount('tok-1', 1000000n)).toBe(500000n);
    });
  });

  // ---------------------------------------------------------------------------
  // Validation & Error Cases
  // ---------------------------------------------------------------------------

  describe('Validation & Error Cases', () => {
    it('reserve() with empty entries throws EMPTY_RESERVATION', () => {
      expect(() => ledger.reserve('res-1', [], 'UCT')).toThrow(
        'EMPTY_RESERVATION',
      );
    });

    it('reserve() with duplicate reservationId throws DUPLICATE_RESERVATION_ID', () => {
      ledger.reserve('res-1', entry('tok-1', 500000n, 1000000n), 'UCT');

      expect(() =>
        ledger.reserve('res-1', entry('tok-1', 100000n, 1000000n), 'UCT'),
      ).toThrow('DUPLICATE_RESERVATION_ID');
    });

    it('reserve() with zero amount throws INVALID_RESERVATION_AMOUNT', () => {
      expect(() =>
        ledger.reserve('res-1', entry('tok-1', 0n, 1000000n), 'UCT'),
      ).toThrow('INVALID_RESERVATION_AMOUNT');
    });

    it('reserve() with negative amount throws INVALID_RESERVATION_AMOUNT', () => {
      expect(() =>
        ledger.reserve('res-1', entry('tok-1', -100n, 1000000n), 'UCT'),
      ).toThrow('INVALID_RESERVATION_AMOUNT');
    });

    it('reserve() with amount exceeding free amount throws INSUFFICIENT_FREE_AMOUNT', () => {
      ledger.reserve('res-1', entry('tok-1', 700000n, 1000000n), 'UCT');

      expect(() =>
        ledger.reserve('res-2', entry('tok-1', 500000n, 1000000n), 'UCT'),
      ).toThrow('INSUFFICIENT_FREE_AMOUNT');
    });

    it('reserve() with amount exceeding tokenAmount throws INSUFFICIENT_FREE_AMOUNT', () => {
      expect(() =>
        ledger.reserve('res-1', entry('tok-1', 1500000n, 1000000n), 'UCT'),
      ).toThrow('INSUFFICIENT_FREE_AMOUNT');
    });

    it('reserve() is all-or-nothing: no state change on validation failure', () => {
      // First entry valid, second entry would exceed free amount
      expect(() =>
        ledger.reserve(
          'res-1',
          entries(
            { tokenId: 'tok-1', amount: 500000n, tokenAmount: 1000000n },
            { tokenId: 'tok-2', amount: 3000000n, tokenAmount: 2000000n },
          ),
          'UCT',
        ),
      ).toThrow('INSUFFICIENT_FREE_AMOUNT');

      // Nothing should be reserved
      expect(ledger.getTotalReserved('tok-1')).toBe(0n);
      expect(ledger.getTotalReserved('tok-2')).toBe(0n);
      expect(ledger.getSize()).toBe(0);
    });

    it('cancel() for unknown reservationId is no-op', () => {
      ledger.reserve('res-1', entry('tok-1', 500000n, 1000000n), 'UCT');

      // Should not throw
      ledger.cancel('unknown-id');

      expect(ledger.getFreeAmount('tok-1', 1000000n)).toBe(500000n);
    });

    it('cancel() for already-cancelled reservation is idempotent no-op', () => {
      ledger.reserve('res-1', entry('tok-1', 500000n, 1000000n), 'UCT');
      ledger.cancel('res-1');
      ledger.cancel('res-1'); // second call

      expect(ledger.getFreeAmount('tok-1', 1000000n)).toBe(1000000n);
    });

    it('commit() for already-committed reservation is idempotent no-op', () => {
      ledger.reserve('res-1', entry('tok-1', 500000n, 1000000n), 'UCT');
      ledger.commit('res-1');
      ledger.commit('res-1'); // second call — reservation already deleted, no-op

      // Reservation was deleted on first commit
      expect(ledger.getReservation('res-1')).toBeUndefined();
    });

    it('commit() for already-cancelled reservation is no-op (reservation already deleted)', () => {
      ledger.reserve('res-1', entry('tok-1', 500000n, 1000000n), 'UCT');
      ledger.cancel('res-1');
      ledger.commit('res-1'); // should be no-op — reservation already deleted by cancel

      expect(ledger.getReservation('res-1')).toBeUndefined();
      expect(ledger.getFreeAmount('tok-1', 1000000n)).toBe(1000000n);
    });

    it('cancel() after commit is no-op (reservation already deleted)', () => {
      ledger.reserve('res-1', entry('tok-1', 500000n, 1000000n), 'UCT');
      ledger.commit('res-1');
      ledger.cancel('res-1'); // reservation already deleted by commit, no-op

      expect(ledger.getReservation('res-1')).toBeUndefined();
      // Capacity was freed by commit
      expect(ledger.getFreeAmount('tok-1', 1000000n)).toBe(1000000n);
    });

    it('commit() for unknown reservationId is no-op', () => {
      // Should not throw
      ledger.commit('nonexistent');
      expect(ledger.getSize()).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // cancelForToken
  // ---------------------------------------------------------------------------

  describe('cancelForToken', () => {
    it('cancels ALL active reservations containing that token', () => {
      ledger.reserve('res-1', entry('tok-1', 200000n, 1000000n), 'UCT');
      ledger.reserve(
        'res-2',
        entries(
          { tokenId: 'tok-1', amount: 300000n, tokenAmount: 1000000n },
          { tokenId: 'tok-2', amount: 100000n, tokenAmount: 2000000n },
        ),
        'UCT',
      );
      ledger.reserve('res-3', entry('tok-2', 400000n, 2000000n), 'UCT');

      const cancelled = ledger.cancelForToken('tok-1');

      expect(cancelled).toHaveLength(2);
      expect(cancelled).toContain('res-1');
      expect(cancelled).toContain('res-2');

      // tok-1 fully free
      expect(ledger.getFreeAmount('tok-1', 1000000n)).toBe(1000000n);

      // tok-2: res-2 was cancelled (released 100000), res-3 still active (400000)
      expect(ledger.getTotalReserved('tok-2')).toBe(400000n);
      expect(ledger.getFreeAmount('tok-2', 2000000n)).toBe(1600000n);

      // res-3 untouched
      expect(ledger.getReservation('res-3')?.status).toBe('active');
    });

    it('returns empty array for token with no reservations', () => {
      ledger.reserve('res-1', entry('tok-1', 200000n, 1000000n), 'UCT');

      const cancelled = ledger.cancelForToken('tok-2');
      expect(cancelled).toEqual([]);
    });

    it('committed reservations are already gone, cancelForToken only cancels active ones', () => {
      ledger.reserve('res-1', entry('tok-1', 300000n, 1000000n), 'UCT');
      ledger.reserve('res-2', entry('tok-1', 200000n, 1000000n), 'UCT');
      ledger.commit('res-1');

      const cancelled = ledger.cancelForToken('tok-1');

      // Only res-2 should be cancelled (active); res-1 was already deleted by commit
      expect(cancelled).toEqual(['res-2']);
      expect(ledger.getReservation('res-1')).toBeUndefined();
      expect(ledger.getReservation('res-2')).toBeUndefined(); // deleted after cancel
    });

    it('after cancelForToken(), getFreeAmount returns full token amount when no committed reservations', () => {
      ledger.reserve('res-1', entry('tok-1', 700000n, 1000000n), 'UCT');
      ledger.cancelForToken('tok-1');
      expect(ledger.getFreeAmount('tok-1', 1000000n)).toBe(1000000n);
    });
  });

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  describe('Cleanup', () => {
    it('cleanup(maxAgeMs) removes reservations older than threshold', () => {
      // Create a reservation with a known createdAt by mocking Date.now
      const originalNow = Date.now;
      try {
        Date.now = () => 100;
        ledger.reserve('res-1', entry('tok-1', 200000n, 1000000n), 'UCT');

        Date.now = () => 200;
        ledger.reserve('res-2', entry('tok-1', 100000n, 1000000n), 'UCT');

        // At time 400, cleanup with maxAge 150 -> threshold is 250
        // res-1 (created=100, age=300) -> old, remove
        // res-2 (created=200, age=200) -> old, remove
        Date.now = () => 400;
        const cancelled = ledger.cleanup(150);

        expect(cancelled).toContain('res-1');
        expect(cancelled).toContain('res-2');
        expect(ledger.getSize()).toBe(0);
        expect(ledger.getFreeAmount('tok-1', 1000000n)).toBe(1000000n);
      } finally {
        Date.now = originalNow;
      }
    });

    it('cleanup returns IDs of active reservations that were cancelled', () => {
      const originalNow = Date.now;
      try {
        Date.now = () => 100;
        ledger.reserve('res-1', entry('tok-1', 200000n, 1000000n), 'UCT');
        ledger.reserve('res-2', entry('tok-1', 100000n, 1000000n), 'UCT');

        Date.now = () => 5000;
        ledger.reserve('res-3', entry('tok-1', 50000n, 1000000n), 'UCT');

        Date.now = () => 5100;
        const cancelled = ledger.cleanup(500);

        // res-1 and res-2 old enough, res-3 is not
        expect(cancelled).toHaveLength(2);
        expect(cancelled).toContain('res-1');
        expect(cancelled).toContain('res-2');
        expect(ledger.getReservation('res-3')?.status).toBe('active');
      } finally {
        Date.now = originalNow;
      }
    });

    it('cleanup removes committed and cancelled entries too (by age) but only returns active ones', () => {
      const originalNow = Date.now;
      try {
        Date.now = () => 100;
        ledger.reserve('res-1', entry('tok-1', 300000n, 1000000n), 'UCT');
        ledger.reserve('res-2', entry('tok-1', 400000n, 1000000n), 'UCT');
        ledger.commit('res-2');

        Date.now = () => 5000;
        const cancelled = ledger.cleanup(500);

        // res-1 was active -> cancelled by cleanup -> returned
        // res-2 was committed -> removed but not in cancelled list
        expect(cancelled).toEqual(['res-1']);

        // Both are removed from the ledger
        expect(ledger.getSize()).toBe(0);

        // res-2 was committed so its amount was freed by cleanup removal
        // (cleanup removes from tokenIndex for active ones that get cancelled)
        // For committed, they are just deleted from reservations map
        expect(ledger.getFreeAmount('tok-1', 1000000n)).toBe(1000000n);
      } finally {
        Date.now = originalNow;
      }
    });

    it('cleanup does not remove reservations within threshold', () => {
      const originalNow = Date.now;
      try {
        Date.now = () => 5000;
        ledger.reserve('res-1', entry('tok-1', 300000n, 1000000n), 'UCT');

        Date.now = () => 5050;
        const cancelled = ledger.cleanup(100);

        expect(cancelled).toEqual([]);
        expect(ledger.getSize()).toBe(1);
        expect(ledger.getReservation('res-1')?.status).toBe('active');
      } finally {
        Date.now = originalNow;
      }
    });
  });

  // ---------------------------------------------------------------------------
  // clear() and getSize()
  // ---------------------------------------------------------------------------

  describe('clear() and getSize()', () => {
    it('clear() removes all reservations and indexes', () => {
      ledger.reserve('res-1', entry('tok-1', 300000n, 1000000n), 'UCT');
      ledger.reserve('res-2', entry('tok-2', 500000n, 2000000n), 'UCT');

      expect(ledger.getSize()).toBe(2);

      ledger.clear();

      expect(ledger.getSize()).toBe(0);
      expect(ledger.getTotalReserved('tok-1')).toBe(0n);
      expect(ledger.getTotalReserved('tok-2')).toBe(0n);
      expect(ledger.getFreeAmount('tok-1', 1000000n)).toBe(1000000n);
      expect(ledger.hasActiveReservation('tok-1')).toBe(false);
    });

    it('getSize() counts only active reservations (commit and cancel both delete)', () => {
      ledger.reserve('res-1', entry('tok-1', 100000n, 1000000n), 'UCT');
      ledger.reserve('res-2', entry('tok-1', 100000n, 1000000n), 'UCT');
      ledger.reserve('res-3', entry('tok-1', 100000n, 1000000n), 'UCT');

      ledger.commit('res-1');  // deleted from map
      ledger.cancel('res-2');  // also deleted from map

      // Only res-3 remains (active)
      expect(ledger.getSize()).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Invariant Checks
  // ---------------------------------------------------------------------------

  describe('Invariants', () => {
    const TOKEN_AMOUNT = 1000000n;

    /** Verify I-RL-2: free + reserved = tokenAmount */
    function assertInvariant(tokenId: string, tokenAmount: bigint) {
      const free = ledger.getFreeAmount(tokenId, tokenAmount);
      const reserved = ledger.getTotalReserved(tokenId);
      expect(free + reserved).toBe(tokenAmount);
      // I-RL-1: free >= 0
      expect(free >= 0n).toBe(true);
    }

    it('I-RL-2: getFreeAmount + getTotalReserved === tokenAmount after each operation', () => {
      assertInvariant('tok-1', TOKEN_AMOUNT);

      ledger.reserve('res-1', entry('tok-1', 300000n, TOKEN_AMOUNT), 'UCT');
      assertInvariant('tok-1', TOKEN_AMOUNT);

      ledger.reserve('res-2', entry('tok-1', 200000n, TOKEN_AMOUNT), 'UCT');
      assertInvariant('tok-1', TOKEN_AMOUNT);

      ledger.commit('res-1');
      assertInvariant('tok-1', TOKEN_AMOUNT);

      ledger.cancel('res-2');
      assertInvariant('tok-1', TOKEN_AMOUNT);
    });

    it('I-RL-1: getFreeAmount never goes negative even with buggy tokenAmount', () => {
      ledger.reserve('res-1', entry('tok-1', 500000n, 1000000n), 'UCT');

      // Query with a smaller tokenAmount than reserved — should clamp to 0n
      expect(ledger.getFreeAmount('tok-1', 100000n)).toBe(0n);
    });

    it('I-RL-4: status transitions are one-directional (active -> committed, active -> cancelled)', () => {
      ledger.reserve('res-1', entry('tok-1', 300000n, 1000000n), 'UCT');
      ledger.reserve('res-2', entry('tok-1', 200000n, 1000000n), 'UCT');

      // active -> committed (valid) — reservation is deleted
      ledger.commit('res-1');
      expect(ledger.getReservation('res-1')).toBeUndefined();

      // cancel after commit is no-op (reservation already gone)
      ledger.cancel('res-1');
      expect(ledger.getReservation('res-1')).toBeUndefined();

      // active -> cancelled (valid) — reservation is deleted
      ledger.cancel('res-2');
      expect(ledger.getReservation('res-2')).toBeUndefined();

      // cancelled -> committed is no-op (reservation already gone)
      ledger.commit('res-2');
      expect(ledger.getReservation('res-2')).toBeUndefined();
    });

    it('I-RL-5: tokenIndex stays consistent after reserve/cancel/commit sequences', () => {
      ledger.reserve('res-1', entry('tok-1', 300000n, 1000000n), 'UCT');
      ledger.reserve('res-2', entry('tok-1', 200000n, 1000000n), 'UCT');

      // Cancel res-1 -> tok-1 should still be in index (res-2 remains)
      ledger.cancel('res-1');
      expect(ledger.hasActiveReservation('tok-1')).toBe(true);
      expect(ledger.getTotalReserved('tok-1')).toBe(200000n);

      // Cancel res-2 -> tok-1 should have no active reservations
      ledger.cancel('res-2');
      expect(ledger.hasActiveReservation('tok-1')).toBe(false);
      expect(ledger.getTotalReserved('tok-1')).toBe(0n);
    });

    it('I-RL-6: duplicate reservationId is rejected', () => {
      ledger.reserve('res-1', entry('tok-1', 300000n, 1000000n), 'UCT');

      expect(() =>
        ledger.reserve('res-1', entry('tok-2', 100000n, 500000n), 'UCT'),
      ).toThrow('DUPLICATE_RESERVATION_ID');
    });

    it('fuzz: random sequence of 100 operations preserves invariants', () => {
      const tokens = [
        { id: 'tok-1', amount: 1000000n },
        { id: 'tok-2', amount: 2000000n },
        { id: 'tok-3', amount: 500000n },
        { id: 'tok-4', amount: 750000n },
        { id: 'tok-5', amount: 1500000n },
      ];
      const activeIds: string[] = [];
      const allIds: string[] = [];
      let nextId = 0;

      // Seed-based pseudo-random for reproducibility
      let seed = 42;
      function rand() {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed;
      }

      for (let i = 0; i < 100; i++) {
        const op = rand() % 5;

        try {
          if (op === 0) {
            // reserve: pick 1-2 random tokens, reserve a small amount
            const tok = tokens[rand() % tokens.length];
            const maxFree = ledger.getFreeAmount(tok.id, tok.amount);
            if (maxFree > 0n) {
              const amount = BigInt((rand() % Number(maxFree)) + 1);
              const resId = `fuzz-${nextId++}`;
              ledger.reserve(
                resId,
                entry(tok.id, amount, tok.amount),
                'UCT',
              );
              activeIds.push(resId);
              allIds.push(resId);
            }
          } else if (op === 1 && activeIds.length > 0) {
            // cancel a random active reservation
            const idx = rand() % activeIds.length;
            ledger.cancel(activeIds[idx]);
            activeIds.splice(idx, 1);
          } else if (op === 2 && activeIds.length > 0) {
            // commit a random active reservation
            const idx = rand() % activeIds.length;
            ledger.commit(activeIds[idx]);
            activeIds.splice(idx, 1);
          } else if (op === 3) {
            // cancelForToken
            const tok = tokens[rand() % tokens.length];
            ledger.cancelForToken(tok.id);
            // Remove cancelled ones from activeIds (simplified: just refresh)
            const remaining: string[] = [];
            for (const id of activeIds) {
              const res = ledger.getReservation(id);
              if (res && res.status === 'active') {
                remaining.push(id);
              }
            }
            activeIds.length = 0;
            activeIds.push(...remaining);
          } else if (op === 4) {
            // cleanup with large maxAge (shouldn't affect recent entries)
            ledger.cleanup(999999999);
          }
        } catch {
          // Expected: INSUFFICIENT_FREE_AMOUNT etc. — skip
        }

        // Verify invariant after every operation
        for (const tok of tokens) {
          const free = ledger.getFreeAmount(tok.id, tok.amount);
          const reserved = ledger.getTotalReserved(tok.id);
          expect(free + reserved).toBe(tok.amount);
          expect(free >= 0n).toBe(true);
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Edge Cases
  // ---------------------------------------------------------------------------

  describe('Edge Cases', () => {
    it('reserving the exact full token amount leaves 0 free', () => {
      ledger.reserve('res-1', entry('tok-1', 1000000n, 1000000n), 'UCT');
      expect(ledger.getFreeAmount('tok-1', 1000000n)).toBe(0n);
    });

    it('reserving full amount then another reserve throws INSUFFICIENT_FREE_AMOUNT', () => {
      ledger.reserve('res-1', entry('tok-1', 1000000n, 1000000n), 'UCT');
      expect(() =>
        ledger.reserve('res-2', entry('tok-1', 1n, 1000000n), 'UCT'),
      ).toThrow('INSUFFICIENT_FREE_AMOUNT');
    });

    it('cancel then re-reserve the same amounts succeeds', () => {
      ledger.reserve('res-1', entry('tok-1', 1000000n, 1000000n), 'UCT');
      ledger.cancel('res-1');
      // Re-reserve with different ID
      ledger.reserve('res-2', entry('tok-1', 1000000n, 1000000n), 'UCT');
      expect(ledger.getFreeAmount('tok-1', 1000000n)).toBe(0n);
    });

    it('reserve with amount = 1n (minimum valid amount)', () => {
      ledger.reserve('res-1', entry('tok-1', 1n, 1000000n), 'UCT');
      expect(ledger.getTotalReserved('tok-1')).toBe(1n);
      expect(ledger.getFreeAmount('tok-1', 1000000n)).toBe(999999n);
    });

    it('many reservations on different coins', () => {
      ledger.reserve('res-1', entry('tok-1', 100n, 1000n), 'UCT');
      ledger.reserve('res-2', entry('tok-2', 200n, 2000n), 'USDU');

      expect(ledger.getReservation('res-1')?.coinId).toBe('UCT');
      expect(ledger.getReservation('res-2')?.coinId).toBe('USDU');
      expect(ledger.getTotalReserved('tok-1')).toBe(100n);
      expect(ledger.getTotalReserved('tok-2')).toBe(200n);
    });

    it('cancelForToken on multi-token reservation removes from all token indexes', () => {
      ledger.reserve(
        'res-1',
        entries(
          { tokenId: 'tok-1', amount: 100n, tokenAmount: 1000n },
          { tokenId: 'tok-2', amount: 200n, tokenAmount: 2000n },
        ),
        'UCT',
      );

      ledger.cancelForToken('tok-1');

      // res-1 cancelled, so tok-2 should also be freed
      expect(ledger.getTotalReserved('tok-1')).toBe(0n);
      expect(ledger.getTotalReserved('tok-2')).toBe(0n);
      expect(ledger.hasActiveReservation('tok-2')).toBe(false);
    });

    it('cleanup with maxAgeMs = 0 removes everything', () => {
      const originalNow = Date.now;
      try {
        Date.now = () => 1000;
        ledger.reserve('res-1', entry('tok-1', 300000n, 1000000n), 'UCT');
        ledger.reserve('res-2', entry('tok-1', 200000n, 1000000n), 'UCT');

        Date.now = () => 1001;
        const cancelled = ledger.cleanup(0);

        expect(cancelled).toHaveLength(2);
        expect(ledger.getSize()).toBe(0);
      } finally {
        Date.now = originalNow;
      }
    });
  });

  describe('cancelForToken with excludeReservationId', () => {
    it('skips the excluded reservation when cancelling for a token', () => {
      ledger.reserve('res-keep', entry('tok-1', 300000n, 1000000n), 'UCT');
      ledger.reserve('res-cancel', entry('tok-1', 200000n, 1000000n), 'UCT');

      const cancelled = ledger.cancelForToken('tok-1', 'res-keep');
      expect(cancelled).toEqual(['res-cancel']);
      // Excluded reservation still active — token still reserved
      expect(ledger.hasActiveReservation('tok-1')).toBe(true);
      expect(ledger.getFreeAmount('tok-1', 1000000n)).toBe(700000n);
    });

    it('cancels all when excludeReservationId does not match any reservation', () => {
      ledger.reserve('res-1', entry('tok-1', 300000n, 1000000n), 'UCT');
      ledger.reserve('res-2', entry('tok-1', 200000n, 1000000n), 'UCT');

      const cancelled = ledger.cancelForToken('tok-1', 'res-nonexistent');
      expect(cancelled).toEqual(['res-1', 'res-2']);
      // No active reservations remain for this token
      expect(ledger.hasActiveReservation('tok-1')).toBe(false);
    });

    it('preserves excluded reservation even when it is the only one', () => {
      ledger.reserve('res-only', entry('tok-1', 500000n, 1000000n), 'UCT');

      const cancelled = ledger.cancelForToken('tok-1', 'res-only');
      expect(cancelled).toEqual([]);
      expect(ledger.getFreeAmount('tok-1', 1000000n)).toBe(500000n);
    });
  });
});
