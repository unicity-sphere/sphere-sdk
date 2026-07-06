/**
 * Adversarial test — broken source-state continuity (Note C8).
 *
 * Steelman defense: a hostile sender ships a token with a 3-tx chain
 * where tx[2].sourceState is NOT equal to tx[1].destinationState. Each
 * individual tx may have a valid authenticator (signed correctly over
 * its own claimed transactionHash) and a valid inclusion proof — both
 * are LOCAL invariants. But the chain itself is spliced: the sender
 * has stitched tx[2] from a DIFFERENT token's history onto the back
 * of tx[0]→tx[1].
 *
 * The §5.3 [C](2) protocol mandates a full-chain continuity walk:
 * for every i ≥ 1, `chain[i].sourceState === chain[i - 1]
 * .destinationState`. The continuity walker (`continuity-walker.ts`)
 * implements this as its own pure function so the contract is
 * enforced uniformly and is hard to bypass via refactor.
 *
 * This test confirms:
 *
 *   1. The walker catches the splice at the FIRST broken link (i=2 in
 *      the canonical scenario).
 *   2. The disposition reason is the canonical `'continuity-broken'`
 *      string from the §5.4 reason union — exactly the on-wire form
 *      that lands in `_invalid` records.
 *   3. The walker does NOT need any cryptographic input — purely
 *      structural string comparison — so even a sender who has stolen
 *      victim keys cannot bypass this check by re-signing the spliced
 *      tx (the splice is at the structural reference layer, not at
 *      the signature layer).
 *
 * Spec references: §5.3 [C](2), Note C8.
 */

import { describe, it, expect } from 'vitest';

import {
  walkContinuity,
  type TxLike,
} from '../../../extensions/uxf/pipeline/continuity-walker';

// =============================================================================
// Adversarial chain construction
// =============================================================================

function tx(sourceState: string, destinationState: string): TxLike {
  return { sourceState, destinationState };
}

/**
 * The canonical hostile chain: 3 transactions, with tx[2] spliced from
 * some other token's history.
 *
 *   tx[0]: s0 → s1
 *   tx[1]: s1 → s2          (continuous so far)
 *   tx[2]: foreign-state → s3   (BREAK — tx[2].sourceState !== s2)
 *
 * If the receiver only checked tx[2]'s individual authenticator and
 * proof (assume both pass), they'd accept a token whose mid-history
 * was structurally fabricated.
 */
function brokenAtIndex2(): TxLike[] {
  return [
    tx('s0', 's1'),
    tx('s1', 's2'),
    tx('foreign-victim-state', 's3'), // splice from another token's history
  ];
}

// =============================================================================
// Test cases
// =============================================================================

describe('C8 — hostile chain with broken source-state continuity is caught', () => {
  it('detects the splice at the broken link with continuity-broken disposition', () => {
    const result = walkContinuity(brokenAtIndex2());

    // Critical invariants:
    //  1. The splice IS detected (chain rejected).
    expect(result.ok).toBe(false);

    if (!result.ok) {
      //  2. The broken index is identified precisely.
      expect(result.brokenAt).toBe(2);

      //  3. The reason is the canonical on-wire string. This pins the
      //     value to the exact form used in `_invalid` records — a
      //     refactor that renames it (e.g., to `'chain-broken'`) goes
      //     red here AND fails the §5.4 enum snapshot in
      //     `tests/unit/types/disposition.test.ts`.
      expect(result.reason).toBe('continuity-broken');
    }
  });

  it('detects splice at index 1 (immediate first-link break)', () => {
    // Variant: the sender doesn't even bother making the first link
    // continuous. Catches the trivial case.
    const chain = [tx('s0', 's1'), tx('foreign-state-1', 's2'), tx('s2', 's3')];
    const result = walkContinuity(chain);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAt).toBe(1);
      expect(result.reason).toBe('continuity-broken');
    }
  });

  it('reports FIRST broken index when multiple splices exist', () => {
    // Sophisticated splice: TWO breaks, only the first should be
    // reported. The walker is allowed to short-circuit on first break;
    // the disposition record only needs one reason.
    const chain = [
      tx('s0', 's1'),
      tx('foreign-A', 'foreign-B'), // break #1 at i=1
      tx('foreign-C', 'foreign-D'), // break #2 at i=2 (should not be reported)
    ];
    const result = walkContinuity(chain);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAt).toBe(1);
    }
  });

  it('detects splice in a long chain (deep splice scenario)', () => {
    // Sender builds 9 honest txs then splices the head from a foreign
    // token's history.
    const chain: TxLike[] = [];
    for (let i = 0; i < 9; i++) {
      chain.push(tx(`s${i}`, `s${i + 1}`));
    }
    chain.push(tx('foreign-deep', 's10')); // break at i=9
    const result = walkContinuity(chain);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAt).toBe(9);
      expect(result.reason).toBe('continuity-broken');
    }
  });

  it('walker does not need crypto — purely structural', () => {
    // Even with arbitrary string identifiers, the walker enforces
    // the invariant. Sender keys / signatures are irrelevant here.
    const chain = [
      tx('genesis-XYZ', 'a'),
      tx('a', 'b'),
      tx('NOT-b', 'c'),
    ];
    const result = walkContinuity(chain);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAt).toBe(2);
    }
  });

  it('honest contiguous chain passes (no false positive)', () => {
    // Negative control: a clean chain MUST pass.
    const chain = [tx('s0', 's1'), tx('s1', 's2'), tx('s2', 's3')];
    const result = walkContinuity(chain);
    expect(result.ok).toBe(true);
  });

  it('catches a partial/sparse spliced tx (undefined sourceState)', () => {
    // Sender ships a defective tx with undefined sourceState (e.g.,
    // serialization bug or deliberate sparse construction). The
    // walker compares with === — undefined !== string surfaces as
    // a broken link.
    const chain: TxLike[] = [
      tx('s0', 's1'),
      { sourceState: undefined as unknown as string, destinationState: 's2' },
    ];
    const result = walkContinuity(chain);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAt).toBe(1);
      expect(result.reason).toBe('continuity-broken');
    }
  });
});
