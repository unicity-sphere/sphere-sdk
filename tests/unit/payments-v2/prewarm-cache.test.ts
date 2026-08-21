// PrewarmCache: the freshness guard behind prewarmSend. Every test here exists
// because keying on tokenId alone would compile, pass the facade tests, and
// silently feed a send a blob at an already-spent state.

import { describe, expect, it } from 'vitest';

import { PrewarmCache } from '../../../modules/payments-v2/prewarm-cache';

const A = new Uint8Array([1, 2, 3]);
const B = new Uint8Array([4, 5, 6]);

describe('PrewarmCache — state-scoped by construction (F6)', () => {
  it('returns a blob only for the state it was warmed at', () => {
    const cache = new PrewarmCache();
    cache.put('T', 'S1', A);

    expect(cache.get('T', 'S1')).toBe(A);
    // The token advanced (incoming claim, another device). Reusing the S1 blob
    // here would declare a spent state in the payload's spentStates.
    expect(cache.get('T', 'S2')).toBeUndefined();
  });

  it('treats an unknown state as a miss, never as a wildcard', () => {
    const cache = new PrewarmCache();
    cache.put('T', 'S1', A);
    // stateHashOf returns undefined for a tombstoned or unseen token; that must
    // not degrade into "any state will do".
    expect(cache.get('T', undefined)).toBeUndefined();
  });

  it('misses on a token that was never warmed', () => {
    const cache = new PrewarmCache();
    cache.put('T', 'S1', A);
    expect(cache.get('OTHER', 'S1')).toBeUndefined();
  });

  it('keeps distinct states of the same token apart', () => {
    const cache = new PrewarmCache();
    cache.put('T', 'S1', A);
    cache.put('T', 'S2', B);

    expect(cache.get('T', 'S1')).toBe(A);
    expect(cache.get('T', 'S2')).toBe(B);
    expect(cache.size).toBe(2);
  });

  it('clear drops everything, so a cancelled send leaves nothing behind', () => {
    const cache = new PrewarmCache();
    cache.put('T', 'S1', A);
    cache.clear();

    expect(cache.get('T', 'S1')).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});
