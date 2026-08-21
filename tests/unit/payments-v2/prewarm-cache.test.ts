// PrewarmCache: the freshness guard behind prewarmSend. Every test here exists
// because keying on tokenId alone would compile, pass the facade tests, and
// silently feed a send a blob at an already-spent state.

import { describe, expect, it } from 'vitest';

import { PrewarmCache, takeSourceBlobs } from '../../../modules/payments-v2/prewarm-cache';

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

describe('takeSourceBlobs — freshness comes from the server, not the mirror', () => {
  /** A mirror that is BEHIND the server until delta() pulls the advance. */
  function staleMirror(advanceTo: string | undefined) {
    const state = new Map([['T', 'S1']]);
    let pulled = 0;
    return {
      pulled: () => pulled,
      view: {
        stateHashOf: (id: string) => state.get(id),
        delta: async (): Promise<void> => {
          pulled += 1;
          if (advanceTo === undefined) state.delete('T');
          else state.set('T', advanceTo);
        },
      },
    };
  }

  it('re-fetches a token the server already advanced, even though the mirror still shows the warmed state', async () => {
    const cache = new PrewarmCache();
    cache.put('T', 'S1', A);
    const mirror = staleMirror('S2');
    const fetched: string[][] = [];
    const storagePort = {
      getBlobs: async (ids: string[]) => {
        fetched.push(ids);
        return new Map([['T', B]]);
      },
    };

    const out = await takeSourceBlobs({ view: mirror.view, storagePort, cache }, ['T']);

    // Without the refresh both sides read the same stale mirror, the key matches,
    // and the S1 blob — a state the token has already left — reaches spentStates.
    expect(mirror.pulled()).toBe(1);
    expect(fetched).toEqual([['T']]);
    expect(out.get('T')).toBe(B);
  });

  it('serves the warm blob when the refresh confirms the token has not moved', async () => {
    const cache = new PrewarmCache();
    cache.put('T', 'S1', A);
    const mirror = staleMirror('S1');
    const storagePort = {
      getBlobs: async (): Promise<Map<string, Uint8Array>> => {
        throw new Error('must not re-fetch a token that is still at its warmed state');
      },
    };

    const out = await takeSourceBlobs({ view: mirror.view, storagePort, cache }, ['T']);

    expect(mirror.pulled()).toBe(1);
    expect(out.get('T')).toBe(A);
  });

  it('falls back to fetching everything when the refresh itself fails', async () => {
    const cache = new PrewarmCache();
    cache.put('T', 'S1', A);
    const fetched: string[][] = [];
    const view = {
      stateHashOf: () => 'S1',
      delta: async (): Promise<void> => {
        throw new Error('offline');
      },
    };
    const storagePort = {
      getBlobs: async (ids: string[]) => {
        fetched.push(ids);
        return new Map([['T', B]]);
      },
    };

    // Unverifiable freshness is not freshness: prefer the authoritative read.
    const out = await takeSourceBlobs({ view, storagePort, cache }, ['T']);
    expect(fetched).toEqual([['T']]);
    expect(out.get('T')).toBe(B);
  });

  it('skips the refresh entirely when nothing was warmed', async () => {
    const cache = new PrewarmCache();
    const mirror = staleMirror('S2');
    const storagePort = { getBlobs: async (): Promise<Map<string, Uint8Array>> => new Map([['T', B]]) };

    await takeSourceBlobs({ view: mirror.view, storagePort, cache }, ['T']);

    expect(mirror.pulled()).toBe(0); // an unwarmed send must not pay for a delta
  });
});
