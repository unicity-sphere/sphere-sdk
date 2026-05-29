/**
 * UXF Transfer T.5.B.5 — cycle defense (§6.1.1, W32).
 *
 * Token chains are append-only DAGs (parents are predecessors, children
 * are successors), so cycles cannot arise from honest chain construction.
 * However, `splitParent` is a manifest-side annotation that could in
 * principle be corrupted. The implementation MUST:
 *  1. Maintain a visited set during transitive recursion.
 *  2. Bound depth at MAX_CHAIN_DEPTH (default 64).
 *
 * On detected cycle or depth-overrun, the recursion stops and returns
 * a partial result with `cycleDefenseFired > 0`.
 *
 * Acceptance:
 *  - Self-loop (child claims itself as parent) → recursion terminates.
 *  - A → B → A cycle → recursion terminates without infinite looping.
 *  - Long chain exceeding maxDepth → recursion terminates at the bound.
 */

import { describe, expect, it } from 'vitest';

import {
  ADDR,
  buildWalker,
  makeFakeManifestStorage,
  makeManifestEntry,
} from './cascade-walker-fixtures';

describe('§6.1.1 cycle defense — visited-set + depth-bound (W32)', () => {
  it('self-loop in splitParent does not infinite-loop', async () => {
    const TOKEN = 't';
    // The token's manifest claims `splitParent: t` (impossible in
    // honest construction, but a corrupted manifest could carry it).
    const storage = makeFakeManifestStorage([
      {
        addr: ADDR,
        tokenId: TOKEN,
        entry: makeManifestEntry({
          status: 'invalid',
          invalidReason: 'oracle-rejected',
          splitParent: TOKEN, // corrupted self-loop
        }),
      },
    ]);

    const harness = buildWalker({
      storage,
      classes: { [TOKEN]: 'coin' },
    });

    // The cascade root is the same token. The findChildren scanner
    // would return [TOKEN] (because the entry's splitParent === TOKEN).
    // The visited set MUST contain TOKEN as the root, so the recursion
    // skips it.
    const result = await harness.walker.cascade(
      ADDR,
      TOKEN,
      'oracle-rejected',
    );

    // No actual cascade — the only candidate child is the cascade root
    // itself, which is in the visited set.
    expect(result.cascaded).toBe(0);
    expect(result.cycleDefenseFired).toBeGreaterThanOrEqual(1);
  });

  it('A → B → A cycle terminates via visited-set', async () => {
    // Corrupted: A.splitParent = B, B.splitParent = A. The cascade
    // starts at B (the failing parent). The walker enumerates B's
    // children → finds A; cascades A; A's children → finds B; B is
    // in the visited set → recursion terminates.
    const A = 'tok-a';
    const B = 'tok-b';

    const storage = makeFakeManifestStorage([
      {
        addr: ADDR,
        tokenId: A,
        entry: makeManifestEntry({
          rootHashHex: 'a1'.repeat(32),
          status: 'pending',
          splitParent: B,
        }),
      },
      {
        addr: ADDR,
        tokenId: B,
        entry: makeManifestEntry({
          rootHashHex: 'b1'.repeat(32),
          status: 'invalid',
          invalidReason: 'oracle-rejected',
          splitParent: A,
        }),
      },
    ]);

    const harness = buildWalker({
      storage,
      classes: { [B]: 'coin' },
    });

    const result = await harness.walker.cascade(ADDR, B, 'oracle-rejected');

    // A is cascaded; the recursion into A finds B (cycle), terminates.
    expect(result.cascaded).toBe(1);
    expect(result.cycleDefenseFired).toBeGreaterThanOrEqual(1);

    // Verify the recursion ended cleanly — A is now invalid, B's
    // status is unchanged (it was already invalid). No infinite loop.
    const aEntry = await storage.readEntry(ADDR, A);
    expect(aEntry?.status).toBe('invalid');
    expect(aEntry?.invalidReason).toBe('parent-rejected');
  });

  it('depth-overrun at maxDepth halts recursion', async () => {
    // Build a long linear chain: c0 -> c1 -> c2 -> ... where each
    // ci+1.splitParent = ci. With maxDepth=3, recursion stops at c3.
    const PARENT = 'depth-root';
    const ENTRIES: Array<{ tokenId: string; parent: string }> = [];
    let prev = PARENT;
    const N = 10;
    for (let i = 0; i < N; i++) {
      const id = `c${i}`;
      ENTRIES.push({ tokenId: id, parent: prev });
      prev = id;
    }

    const storage = makeFakeManifestStorage([
      {
        addr: ADDR,
        tokenId: PARENT,
        entry: makeManifestEntry({
          status: 'invalid',
          invalidReason: 'oracle-rejected',
        }),
      },
      ...ENTRIES.map((e, i) => ({
        addr: ADDR,
        tokenId: e.tokenId,
        entry: makeManifestEntry({
          rootHashHex: i.toString(16).padStart(2, '0').repeat(32),
          status: 'pending' as const,
          splitParent: e.parent,
        }),
      })),
    ]);

    const harness = buildWalker({
      storage,
      classes: { [PARENT]: 'coin' },
      maxDepth: 3,
    });

    const result = await harness.walker.cascade(
      ADDR,
      PARENT,
      'oracle-rejected',
    );

    // With maxDepth=3, only c0/c1/c2 are cascaded; the recursion into
    // c2's children stops because depth would equal maxDepth.
    expect(result.cascaded).toBe(3);
    expect(result.cycleDefenseFired).toBeGreaterThanOrEqual(1);

    expect((await storage.readEntry(ADDR, 'c0'))?.status).toBe('invalid');
    expect((await storage.readEntry(ADDR, 'c1'))?.status).toBe('invalid');
    expect((await storage.readEntry(ADDR, 'c2'))?.status).toBe('invalid');
    // c3 SHOULD be unchanged (the depth-bound stopped the walk before
    // c2's children were enumerated).
    expect((await storage.readEntry(ADDR, 'c3'))?.status).toBe('pending');
  });

  it('cycle warning callback receives kind discriminator', async () => {
    const TOKEN = 't';
    const storage = makeFakeManifestStorage([
      {
        addr: ADDR,
        tokenId: TOKEN,
        entry: makeManifestEntry({
          status: 'invalid',
          invalidReason: 'oracle-rejected',
          splitParent: TOKEN,
        }),
      },
    ]);

    const harness = buildWalker({
      storage,
      classes: { [TOKEN]: 'coin' },
    });

    await harness.walker.cascade(ADDR, TOKEN, 'oracle-rejected');

    expect(harness.cycleWarnings.length).toBeGreaterThanOrEqual(1);
    expect(harness.cycleWarnings[0].kind).toBe('cycle');
  });
});
