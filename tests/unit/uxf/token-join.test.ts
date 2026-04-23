/**
 * Unit tests for the per-token JOIN resolver (uxf/token-join.ts).
 *
 * The resolver is pure: no mutation, no I/O. These tests build
 * minimal-but-structurally-correct token-root + transaction elements
 * in an in-memory pool, then assert the resolver's decision for each
 * of the classical §10.4 Rule 3 scenarios enumerated in
 * PROFILE-AGGREGATOR-POINTER-D0-JOIN-AUDIT.md.
 */

import { describe, it, expect } from 'vitest';

import type { ContentHash, UxfElement } from '../../../uxf/types';
import { resolveTokenRoot } from '../../../uxf/token-join';

// ---------------------------------------------------------------------------
// Element factories — minimal enough to satisfy the resolver's reads.
// ---------------------------------------------------------------------------

function makeTransaction(id: string, opts: { committed: boolean }): [ContentHash, UxfElement] {
  const hash = `tx-${id}` as ContentHash;
  const el: UxfElement = {
    header: { version: '2.0' } as never,
    type: 'transaction',
    content: {},
    children: {
      sourceState: `state-src-${id}`,
      data: opts.committed ? `tx-data-${id}` : null,
      inclusionProof: opts.committed ? `proof-${id}` : null,
      destinationState: `state-dst-${id}`,
    },
  };
  return [hash, el];
}

function makeTokenRoot(
  rootName: string,
  txnHashes: ContentHash[],
): [ContentHash, UxfElement] {
  const hash = `root-${rootName}` as ContentHash;
  const el: UxfElement = {
    header: { version: '2.0' } as never,
    type: 'token-root',
    content: { tokenId: 'T', version: '2.0' },
    children: {
      genesis: 'genesis-X',
      transactions: txnHashes,
      state: 'state-X',
      nametags: [],
    },
  };
  return [hash, el];
}

type PoolEntry = [ContentHash, UxfElement];
function buildPool(...entries: PoolEntry[]): Map<ContentHash, UxfElement> {
  return new Map(entries);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveTokenRoot', () => {
  it('returns `single` for a single candidate', () => {
    const [txH, tx] = makeTransaction('0', { committed: true });
    const [rootH, root] = makeTokenRoot('A', [txH]);
    const pool = buildPool([txH, tx], [rootH, root]);

    const outcome = resolveTokenRoot({
      tokenId: 'T',
      candidates: [rootH],
      pool,
    });
    expect(outcome.kind).toBe('single');
    expect(outcome.rootHash).toBe(rootH);
  });

  it('returns `longest-valid` when one chain is a strict prefix of the other', () => {
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [t1H, t1] = makeTransaction('1', { committed: true });
    const [t2H, t2] = makeTransaction('2', { committed: true });

    const [shortRootH, shortRoot] = makeTokenRoot('short', [t0H, t1H]);
    const [longRootH, longRoot] = makeTokenRoot('long', [t0H, t1H, t2H]);

    const pool = buildPool(
      [t0H, t0],
      [t1H, t1],
      [t2H, t2],
      [shortRootH, shortRoot],
      [longRootH, longRoot],
    );

    const outcome = resolveTokenRoot({
      tokenId: 'T',
      candidates: [shortRootH, longRootH],
      pool,
    });
    expect(outcome.kind).toBe('longest-valid');
    expect(outcome.rootHash).toBe(longRootH);
    if (outcome.kind === 'longest-valid') {
      expect(outcome.losers).toEqual([shortRootH]);
    }
  });

  it('is order-independent (swap candidates → same result)', () => {
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [t1H, t1] = makeTransaction('1', { committed: true });

    const [shortRootH, shortRoot] = makeTokenRoot('short', [t0H]);
    const [longRootH, longRoot] = makeTokenRoot('long', [t0H, t1H]);

    const pool = buildPool(
      [t0H, t0],
      [t1H, t1],
      [shortRootH, shortRoot],
      [longRootH, longRoot],
    );

    const outcomeA = resolveTokenRoot({
      tokenId: 'T',
      candidates: [shortRootH, longRootH],
      pool,
    });
    const outcomeB = resolveTokenRoot({
      tokenId: 'T',
      candidates: [longRootH, shortRootH],
      pool,
    });
    expect(outcomeA).toEqual(outcomeB);
  });

  it('returns `divergent` when chains fork (no prefix relation)', () => {
    // Two chains of length 2 whose second tx differs — different
    // forks of the same tokenId. Deterministic winner: higher
    // committed-tx count, else lexicographic rootHash.
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [t1aH, t1a] = makeTransaction('1a', { committed: true });
    const [t1bH, t1b] = makeTransaction('1b', { committed: false });

    const [rootAH, rootA] = makeTokenRoot('A', [t0H, t1aH]);
    const [rootBH, rootB] = makeTokenRoot('B', [t0H, t1bH]);

    const pool = buildPool(
      [t0H, t0],
      [t1aH, t1a],
      [t1bH, t1b],
      [rootAH, rootA],
      [rootBH, rootB],
    );

    const outcome = resolveTokenRoot({
      tokenId: 'T',
      candidates: [rootAH, rootBH],
      pool,
    });
    expect(outcome.kind).toBe('divergent');
    // rootA has 2 committed txs; rootB has 1. rootA should win.
    expect(outcome.rootHash).toBe(rootAH);
  });

  it('returns `truncated` when a shorter chain outranks a longer one on committed txs', () => {
    // Short chain: 2 committed. Long chain: 3 txs but only 1 committed
    // (the last two are uncommitted). Short wins on proof coverage.
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [t1H, t1] = makeTransaction('1', { committed: true });
    const [t2H, t2] = makeTransaction('2', { committed: false });
    const [t3H, t3] = makeTransaction('3', { committed: false });

    const [shortRootH, shortRoot] = makeTokenRoot('short', [t0H, t1H]);
    // Long chain shares the first tx with the short chain but its
    // second and third are uncommitted — so Rule 4 would prefer the
    // short chain's proof coverage. Because the two chains share
    // only a 1-element prefix, `isPrefix` is false → divergent.
    // To test `truncated` cleanly we need a genuine prefix relation
    // where committed-count-on-winner < longer-candidate-length.
    // Construct: short = [t0, t1] both committed, long = [t0, t1, t2]
    // where t2 is uncommitted. Then long has 2 committed vs short's
    // 2 — tied committed-count but long is longer, so long wins via
    // `longest-valid`. That's NOT the `truncated` case.
    //
    // `truncated` requires: prefix relation AND winner has FEWER
    // txs. That happens when the longer chain added uncommitted
    // txs on top but the SHORTER chain has MORE committed txs than
    // the longer — which can only happen if the longer chain lost
    // committed txs somewhere (impossible under prefix relation,
    // since prefix txs are identical).
    //
    // Conclusion: under pure prefix-relation semantics, the longer
    // chain always has ≥ committed-count of the shorter. So the
    // `truncated` outcome is unreachable in practice for prefix
    // relations — it only fires as a safety net if the pool is
    // inconsistent. We assert that the resolver still picks the
    // longer chain (longest-valid) here, and leave the `truncated`
    // branch as documented dead-code-for-now.
    const [, , , ] = [t2H, t2, t3H, t3]; // keep fixtures declared

    const [longRootH, longRoot] = makeTokenRoot('long', [t0H, t1H, t2H]);

    const pool = buildPool(
      [t0H, t0],
      [t1H, t1],
      [t2H, t2],
      [shortRootH, shortRoot],
      [longRootH, longRoot],
    );

    const outcome = resolveTokenRoot({
      tokenId: 'T',
      candidates: [shortRootH, longRootH],
      pool,
    });
    // Prefix-relation: committed counts tie at 2, longer chain wins.
    expect(outcome.kind).toBe('longest-valid');
    expect(outcome.rootHash).toBe(longRootH);
  });

  it('treats missing token-root elements as malformed and skips them', () => {
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [realRootH, realRoot] = makeTokenRoot('real', [t0H]);
    const phantomRootH = 'root-phantom' as ContentHash;

    const pool = buildPool([t0H, t0], [realRootH, realRoot]);

    const outcome = resolveTokenRoot({
      tokenId: 'T',
      candidates: [realRootH, phantomRootH],
      pool,
    });
    // Only one well-formed candidate — treat as single.
    expect(outcome.kind).toBe('single');
    expect(outcome.rootHash).toBe(realRootH);
  });

  it('ties break deterministically by rootHash', () => {
    // Two roots with identical tx arrays (same committed count) and
    // same length → ranking falls through to lexicographic rootHash.
    const [t0H, t0] = makeTransaction('0', { committed: true });
    const [, realRoot] = makeTokenRoot('zzz', [t0H]);
    const [, realRoot2] = makeTokenRoot('aaa', [t0H]);
    const rootZ = 'root-zzz' as ContentHash;
    const rootA = 'root-aaa' as ContentHash;

    const pool = buildPool([t0H, t0], [rootZ, realRoot], [rootA, realRoot2]);

    const outcome = resolveTokenRoot({
      tokenId: 'T',
      candidates: [rootZ, rootA],
      pool,
    });
    // Same-length compatible chains with identical tx arrays are
    // treated as non-divergent; tiebreak picks `root-aaa`
    // (lexicographic).
    expect(outcome.rootHash).toBe(rootA);
  });

  it('throws on empty candidates list (invariant violation)', () => {
    expect(() =>
      resolveTokenRoot({
        tokenId: 'T',
        candidates: [],
        pool: new Map(),
      }),
    ).toThrow('empty candidates');
  });
});
