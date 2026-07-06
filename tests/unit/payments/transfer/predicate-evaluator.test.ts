/**
 * Tests for `modules/payments/transfer/predicate-evaluator.ts` (T.3.B.1).
 *
 * Spec references: §5.3 [A] structural-failure routing, §5.3 [B]
 * not-our-state routing.
 */

import { describe, it, expect } from 'vitest';
import type { IPredicate } from '@unicitylabs/state-transition-sdk/lib/predicate/IPredicate';

import { evaluatePredicateBindsToUs } from '../../../../extensions/uxf/pipeline/predicate-evaluator';

// =============================================================================
// Test doubles — minimal IPredicate stubs
// =============================================================================

/**
 * Build a stub predicate where `isOwner` returns the given fixed
 * boolean. Other IPredicate methods throw (we should never call them
 * here — `evaluatePredicateBindsToUs` calls only `isOwner`).
 */
function predicateBindingTo(answer: boolean): IPredicate {
  // Cast through unknown — these stubs intentionally implement only
  // the surface this verifier touches.
  return {
    isOwner: async (_pk: Uint8Array): Promise<boolean> => answer,
  } as unknown as IPredicate;
}

function predicateThrowingSync(error: unknown): IPredicate {
  return {
    isOwner: (_pk: Uint8Array): Promise<boolean> => {
      throw error;
    },
  } as unknown as IPredicate;
}

function predicateRejectingAsync(error: unknown): IPredicate {
  return {
    isOwner: async (_pk: Uint8Array): Promise<boolean> => {
      throw error;
    },
  } as unknown as IPredicate;
}

function predicateReturningTruthyNonBoolean(value: unknown): IPredicate {
  return {
    // SDK contract is Promise<boolean>; we test that we coerce.
    isOwner: async (_pk: Uint8Array) => value as boolean,
  } as unknown as IPredicate;
}

const PUBKEY_33 = new Uint8Array(33);
PUBKEY_33[0] = 0x02; // compressed prefix

// =============================================================================
// Test cases
// =============================================================================

describe('evaluatePredicateBindsToUs — happy path', () => {
  it('returns ok:true bindsToUs:true when predicate accepts our key', async () => {
    const result = await evaluatePredicateBindsToUs(
      predicateBindingTo(true),
      PUBKEY_33,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bindsToUs).toBe(true);
    }
  });

  it('returns ok:true bindsToUs:false when predicate rejects our key', async () => {
    const result = await evaluatePredicateBindsToUs(
      predicateBindingTo(false),
      PUBKEY_33,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bindsToUs).toBe(false);
    }
  });
});

describe('evaluatePredicateBindsToUs — structural failure', () => {
  it('returns ok:false threw:true on synchronous throw inside isOwner', async () => {
    const boom = new Error('predicate parser blew up');
    const result = await evaluatePredicateBindsToUs(
      predicateThrowingSync(boom),
      PUBKEY_33,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.threw).toBe(true);
      expect(result.error).toBe(boom);
    }
  });

  it('returns ok:false threw:true on async (rejected) throw inside isOwner', async () => {
    const boom = new RangeError('hash digest length');
    const result = await evaluatePredicateBindsToUs(
      predicateRejectingAsync(boom),
      PUBKEY_33,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.threw).toBe(true);
      expect(result.error).toBe(boom);
    }
  });

  it('catches non-Error throw values (string, number, undefined)', async () => {
    for (const thrown of ['boom', 42, undefined]) {
      const result = await evaluatePredicateBindsToUs(
        predicateThrowingSync(thrown),
        PUBKEY_33,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.threw).toBe(true);
        expect(result.error).toBe(thrown);
      }
    }
  });
});

describe('evaluatePredicateBindsToUs — defensive arg validation', () => {
  it('returns ok:false on null predicate', async () => {
    const result = await evaluatePredicateBindsToUs(
      null as unknown as IPredicate,
      PUBKEY_33,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.threw).toBe(true);
      expect(result.error).toBeInstanceOf(TypeError);
    }
  });

  it('returns ok:false on undefined predicate', async () => {
    const result = await evaluatePredicateBindsToUs(
      undefined as unknown as IPredicate,
      PUBKEY_33,
    );
    expect(result.ok).toBe(false);
  });

  it('returns ok:false on non-Uint8Array pubkey', async () => {
    const result = await evaluatePredicateBindsToUs(
      predicateBindingTo(true),
      'hex-string-pubkey' as unknown as Uint8Array,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.threw).toBe(true);
      expect(result.error).toBeInstanceOf(TypeError);
    }
  });
});

describe('evaluatePredicateBindsToUs — strict boolean enforcement (steelman)', () => {
  // Steelman fix: SDK contract is `Promise<boolean>`. A defective or
  // compromised SDK returning truthy non-boolean (1, {}, "false"-string,
  // unawaited inner Promise) MUST surface as a structural defect rather
  // than be silently coerced — otherwise a bad SDK release could grant
  // ownership of every token. Anything other than literal true/false
  // routes to {ok: false, threw: true, error: TypeError}.
  it('rejects truthy non-boolean (1) as structural defect', async () => {
    const result = await evaluatePredicateBindsToUs(
      predicateReturningTruthyNonBoolean(1),
      PUBKEY_33,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.threw).toBe(true);
      expect(result.error).toBeInstanceOf(TypeError);
    }
  });

  it('rejects falsy non-boolean (0) as structural defect', async () => {
    const result = await evaluatePredicateBindsToUs(
      predicateReturningTruthyNonBoolean(0),
      PUBKEY_33,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.threw).toBe(true);
      expect(result.error).toBeInstanceOf(TypeError);
    }
  });

  it('rejects null as structural defect', async () => {
    const result = await evaluatePredicateBindsToUs(
      predicateReturningTruthyNonBoolean(null),
      PUBKEY_33,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.threw).toBe(true);
      expect(result.error).toBeInstanceOf(TypeError);
    }
  });
});

describe('evaluatePredicateBindsToUs — purity', () => {
  it('does not mutate the predicate object', async () => {
    const stub = predicateBindingTo(true);
    const snapshot = JSON.stringify(Object.keys(stub));
    await evaluatePredicateBindsToUs(stub, PUBKEY_33);
    expect(JSON.stringify(Object.keys(stub))).toBe(snapshot);
  });

  it('does not mutate the pubkey bytes', async () => {
    const pk = new Uint8Array([1, 2, 3, 4]);
    const before = Array.from(pk);
    await evaluatePredicateBindsToUs(predicateBindingTo(true), pk);
    expect(Array.from(pk)).toEqual(before);
  });
});
