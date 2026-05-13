/**
 * UXF Transfer T.5.B.5 — visited-set scope (W32).
 *
 * The visited set is per-call-stack — a function parameter, NOT
 * module-level state. Two concurrent cascades for different parents
 * have independent visited sets; a token visited in one cascade is
 * NOT marked-as-visited for the other.
 *
 * Acceptance:
 *  - Two concurrent cascades for different parents → both produce
 *    correct results, no cross-contamination.
 *  - A token reachable from BOTH cascades (defensively, via a corrupted
 *    or shared splitParent) is independently visited by each.
 *  - The walker class itself holds NO module-level state for the
 *    visited set (verified via consecutive cascade calls returning
 *    independent results).
 */

import { describe, expect, it } from 'vitest';

import {
  ADDR,
  buildWalker,
  makeFakeManifestStorage,
  makeManifestEntry,
} from './cascade-walker-fixtures';

describe('cascade visited-set scope (W32) — per-call-stack, NOT module-level', () => {
  it('two concurrent cascades for different parents do not cross-contaminate', async () => {
    // Two independent cascade trees:
    //   PARENT_A → A1, A2
    //   PARENT_B → B1, B2
    // Both run in parallel; both should cascade their respective
    // children. If the visited-set were module-level, the second
    // cascade might skip children seen by the first.
    const PARENT_A = 'parent-a';
    const PARENT_B = 'parent-b';
    const A1 = 'a-1';
    const A2 = 'a-2';
    const B1 = 'b-1';
    const B2 = 'b-2';

    const storage = makeFakeManifestStorage([
      {
        addr: ADDR,
        tokenId: PARENT_A,
        entry: makeManifestEntry({
          rootHashHex: 'a0'.repeat(32),
          status: 'invalid',
          invalidReason: 'oracle-rejected',
        }),
      },
      {
        addr: ADDR,
        tokenId: PARENT_B,
        entry: makeManifestEntry({
          rootHashHex: 'b0'.repeat(32),
          status: 'invalid',
          invalidReason: 'oracle-rejected',
        }),
      },
      {
        addr: ADDR,
        tokenId: A1,
        entry: makeManifestEntry({
          rootHashHex: 'a1'.repeat(32),
          status: 'pending',
          splitParent: PARENT_A,
        }),
      },
      {
        addr: ADDR,
        tokenId: A2,
        entry: makeManifestEntry({
          rootHashHex: 'a2'.repeat(32),
          status: 'pending',
          splitParent: PARENT_A,
        }),
      },
      {
        addr: ADDR,
        tokenId: B1,
        entry: makeManifestEntry({
          rootHashHex: 'b1'.repeat(32),
          status: 'pending',
          splitParent: PARENT_B,
        }),
      },
      {
        addr: ADDR,
        tokenId: B2,
        entry: makeManifestEntry({
          rootHashHex: 'b2'.repeat(32),
          status: 'pending',
          splitParent: PARENT_B,
        }),
      },
    ]);

    const harness = buildWalker({
      storage,
      classes: { [PARENT_A]: 'coin', [PARENT_B]: 'coin' },
    });

    // Run both cascades concurrently. The visited-set per cascade is
    // independent, so both should each cascade 2 children.
    const [resultA, resultB] = await Promise.all([
      harness.walker.cascade(ADDR, PARENT_A, 'oracle-rejected'),
      harness.walker.cascade(ADDR, PARENT_B, 'oracle-rejected'),
    ]);

    expect(resultA.cascaded).toBe(2);
    expect(resultB.cascaded).toBe(2);

    for (const child of [A1, A2, B1, B2]) {
      const entry = await storage.readEntry(ADDR, child);
      expect(entry?.status).toBe('invalid');
      expect(entry?.invalidReason).toBe('parent-rejected');
    }
  });

  it('two cascades over the same shared child both visit it (independent visited-sets)', async () => {
    // Defensively constructed scenario: two parents claim the same
    // child via `splitParent`. (Honest construction guarantees one
    // parent per child, but a corrupted manifest could carry this.)
    // A module-level visited set would skip the second visit; a
    // per-call-stack visited set visits in both cascades.
    //
    // We verify by running the cascades SEQUENTIALLY and asserting
    // the second cascade does NOT skip the shared child due to
    // residual visited-set state.
    const PARENT_A = 'pa';
    const PARENT_B = 'pb';
    const SHARED = 'shared-child';

    const storage = makeFakeManifestStorage([
      {
        addr: ADDR,
        tokenId: PARENT_A,
        entry: makeManifestEntry({
          status: 'invalid',
          invalidReason: 'oracle-rejected',
        }),
      },
      {
        addr: ADDR,
        tokenId: PARENT_B,
        entry: makeManifestEntry({
          status: 'invalid',
          invalidReason: 'oracle-rejected',
        }),
      },
      {
        addr: ADDR,
        tokenId: SHARED,
        entry: makeManifestEntry({
          status: 'pending',
          splitParent: PARENT_A,
        }),
      },
    ]);

    const harness = buildWalker({
      storage,
      classes: { [PARENT_A]: 'coin', [PARENT_B]: 'coin' },
    });

    // First cascade: PARENT_A → SHARED is cascaded. SHARED.splitParent
    // is now PARENT_A still (we preserve the original splitParent).
    const r1 = await harness.walker.cascade(
      ADDR,
      PARENT_A,
      'oracle-rejected',
    );
    expect(r1.cascaded).toBe(1);

    // Now reset SHARED.splitParent to PARENT_B and reset its status
    // to pending so the second cascade can find it as a child.
    const sharedEntry = await storage.readEntry(ADDR, SHARED);
    storage.entries.set(`${ADDR}:${SHARED}`, {
      ...sharedEntry!,
      status: 'pending',
      invalidReason: undefined,
      splitParent: PARENT_B,
    });

    // Second cascade: PARENT_B → SHARED. If the visited set were
    // module-level, the previous cascade's visit would mark SHARED as
    // visited — and the second cascade would skip it.
    const r2 = await harness.walker.cascade(
      ADDR,
      PARENT_B,
      'oracle-rejected',
    );
    expect(r2.cascaded).toBe(1);
    const finalEntry = await storage.readEntry(ADDR, SHARED);
    expect(finalEntry?.status).toBe('invalid');
    expect(finalEntry?.invalidReason).toBe('parent-rejected');
  });

  it('walker class instance reuse: holds no visited-set state between cascades', async () => {
    // Sanity: re-run the same cascade against fresh storage in two
    // back-to-back calls. A module-level visited set would corrupt
    // the second call.
    const PARENT = 'p';
    const CHILD = 'c';

    const storage = makeFakeManifestStorage([
      {
        addr: ADDR,
        tokenId: PARENT,
        entry: makeManifestEntry({
          status: 'invalid',
          invalidReason: 'oracle-rejected',
        }),
      },
      {
        addr: ADDR,
        tokenId: CHILD,
        entry: makeManifestEntry({
          status: 'pending',
          splitParent: PARENT,
        }),
      },
    ]);

    const harness = buildWalker({
      storage,
      classes: { [PARENT]: 'coin' },
    });

    const r1 = await harness.walker.cascade(ADDR, PARENT, 'oracle-rejected');
    expect(r1.cascaded).toBe(1);

    // Reset the child to pending; the visited-set is per-call so the
    // walker must cascade it again on the second run.
    const childEntry = await storage.readEntry(ADDR, CHILD);
    storage.entries.set(`${ADDR}:${CHILD}`, {
      ...childEntry!,
      status: 'pending',
      invalidReason: undefined,
    });

    const r2 = await harness.walker.cascade(ADDR, PARENT, 'oracle-rejected');
    expect(r2.cascaded).toBe(1);
  });
});
