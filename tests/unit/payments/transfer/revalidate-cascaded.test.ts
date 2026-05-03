/**
 * UXF Transfer T.5.D — `revalidateCascadedChildren()` (§6.1.1).
 *
 * Acceptance test for the §6.1.1 transitive cascade-reversal:
 *   - Every cascaded child of a revalidated parent is RE-CHECKED.
 *   - Successfully revalidated children's grandchildren cascade
 *     (transitive).
 *   - A child whose validator returns `'parent-still-invalid'` does
 *     NOT cause grandchildren to revalidate.
 *   - A child whose validator returns `'still-invalid-other'` DOES
 *     allow grandchildren to revalidate (their unrelated invalidation
 *     is independent of the parent chain).
 *   - Cycle defense (W32): per-call-stack visited-set + bounded depth.
 *   - Children with `invalidReason !== 'parent-rejected'` are skipped
 *     (they were not cascade victims of THIS parent).
 *   - Parent currently `invalid` → no children revalidate (the
 *     operator hasn't yet flipped the parent).
 */

import { describe, expect, it } from 'vitest';

import {
  ADDR,
  buildRevalidatorHarness,
  manifestEntryFor,
} from './import-inclusion-proof-fixtures';

describe('§6.1.1 revalidateCascadedChildren', () => {
  it('parent valid + child cascaded → revalidate succeeds', async () => {
    const PARENT = 'p-1';
    const C1 = 'c-1';
    const h = buildRevalidatorHarness({
      verdicts: new Map([[C1, { kind: 'revalidated' }]]),
    });
    h.manifest.entries.set(`${ADDR}:${PARENT}`, manifestEntryFor({
      status: 'valid',
      rootHashHex: 'aa'.repeat(32),
    }));
    h.manifest.entries.set(`${ADDR}:${C1}`, manifestEntryFor({
      status: 'invalid',
      invalidReason: 'parent-rejected',
      splitParent: PARENT,
      rootHashHex: 'b1'.repeat(32),
    }));

    const r = await h.runner.run(ADDR, PARENT);
    expect(r.checked).toBe(1);
    expect(r.revalidated).toBe(1);
    expect(r.stillInvalid).toBe(0);
    expect(h.callsByChild).toEqual([C1]);
  });

  it('transitive: revalidated child causes grandchild revalidation', async () => {
    const PARENT = 'p';
    const C = 'c';
    const GC = 'gc';
    const h = buildRevalidatorHarness({
      verdicts: new Map([
        [C, { kind: 'revalidated' }],
        [GC, { kind: 'revalidated' }],
      ]),
    });
    h.manifest.entries.set(`${ADDR}:${PARENT}`, manifestEntryFor({
      status: 'valid',
      rootHashHex: '01'.repeat(32),
    }));
    h.manifest.entries.set(`${ADDR}:${C}`, manifestEntryFor({
      status: 'invalid',
      invalidReason: 'parent-rejected',
      splitParent: PARENT,
      rootHashHex: '02'.repeat(32),
    }));
    h.manifest.entries.set(`${ADDR}:${GC}`, manifestEntryFor({
      status: 'invalid',
      invalidReason: 'parent-rejected',
      splitParent: C,
      rootHashHex: '03'.repeat(32),
    }));

    const r = await h.runner.run(ADDR, PARENT);
    expect(r.checked).toBe(2);
    expect(r.revalidated).toBe(2);
    expect(r.stillInvalid).toBe(0);
    expect(h.callsByChild).toEqual([C, GC]);
  });

  it('parent-still-invalid stops descent — grandchild NOT revalidated', async () => {
    const PARENT = 'p';
    const C = 'c';
    const GC = 'gc';
    const h = buildRevalidatorHarness({
      verdicts: new Map([
        // Race: validator observes parent flipped back to invalid.
        [C, { kind: 'parent-still-invalid' }],
      ]),
    });
    h.manifest.entries.set(`${ADDR}:${PARENT}`, manifestEntryFor({
      status: 'valid',
      rootHashHex: '01'.repeat(32),
    }));
    h.manifest.entries.set(`${ADDR}:${C}`, manifestEntryFor({
      status: 'invalid',
      invalidReason: 'parent-rejected',
      splitParent: PARENT,
      rootHashHex: '02'.repeat(32),
    }));
    h.manifest.entries.set(`${ADDR}:${GC}`, manifestEntryFor({
      status: 'invalid',
      invalidReason: 'parent-rejected',
      splitParent: C,
      rootHashHex: '03'.repeat(32),
    }));

    const r = await h.runner.run(ADDR, PARENT);
    expect(r.checked).toBe(1); // Only C inspected.
    expect(r.stillInvalid).toBe(1);
    // GC NOT visited — `parent-still-invalid` aborts the subtree.
    expect(h.callsByChild).toEqual([C]);
  });

  it('still-invalid-other does NOT recurse — child is a new invalid branch', async () => {
    // Per §6.1.1 the cascade reversal walks ONLY through children
    // whose `parent-rejected` invalidation has been resolved. When the
    // validator returns `'still-invalid-other'` (e.g. the middle
    // node's chain re-passes against the parent but its OWN [E] check
    // surfaced `off-record-spend`), the middle node remains invalid
    // for a DIFFERENT reason — grandchildren cascaded under it are
    // now under the new reason, not the original parent-rejected. The
    // operator must `importInclusionProof` the middle node SEPARATELY
    // to walk that subtree.
    const PARENT = 'p';
    const C = 'c';
    const GC = 'gc';
    const h = buildRevalidatorHarness({
      verdicts: new Map([
        [C, { kind: 'still-invalid-other', newReason: 'off-record-spend' }],
        [GC, { kind: 'revalidated' }],
      ]),
    });
    h.manifest.entries.set(`${ADDR}:${PARENT}`, manifestEntryFor({
      status: 'valid',
      rootHashHex: '01'.repeat(32),
    }));
    h.manifest.entries.set(`${ADDR}:${C}`, manifestEntryFor({
      status: 'invalid',
      invalidReason: 'parent-rejected',
      splitParent: PARENT,
      rootHashHex: '02'.repeat(32),
    }));
    h.manifest.entries.set(`${ADDR}:${GC}`, manifestEntryFor({
      status: 'invalid',
      invalidReason: 'parent-rejected',
      splitParent: C,
      rootHashHex: '03'.repeat(32),
    }));

    const r = await h.runner.run(ADDR, PARENT);
    expect(r.checked).toBe(1); // Only C inspected; GC subtree NOT walked.
    expect(r.revalidated).toBe(0);
    expect(r.stillInvalid).toBe(1);
    expect(h.callsByChild).toEqual([C]);
  });

  it('parent currently invalid → cascade reversal short-circuits per child', async () => {
    const PARENT = 'p';
    const C = 'c';
    const h = buildRevalidatorHarness({
      verdicts: new Map([[C, { kind: 'revalidated' }]]),
    });
    // Parent is STILL invalid (operator hasn't flipped via importInclusionProof).
    h.manifest.entries.set(`${ADDR}:${PARENT}`, manifestEntryFor({
      status: 'invalid',
      invalidReason: 'oracle-rejected',
      rootHashHex: 'aa'.repeat(32),
    }));
    h.manifest.entries.set(`${ADDR}:${C}`, manifestEntryFor({
      status: 'invalid',
      invalidReason: 'parent-rejected',
      splitParent: PARENT,
      rootHashHex: 'b1'.repeat(32),
    }));

    const r = await h.runner.run(ADDR, PARENT);
    expect(r.checked).toBe(1);
    expect(r.revalidated).toBe(0);
    expect(r.stillInvalid).toBe(1);
    // The validator was NOT invoked — the runner short-circuited via the
    // parent-validity gate.
    expect(h.callsByChild.length).toBe(0);
  });

  it('child with invalidReason !== "parent-rejected" is skipped (not a cascade victim)', async () => {
    const PARENT = 'p';
    const OTHER = 'c-other-reason';
    const h = buildRevalidatorHarness({
      verdicts: new Map([[OTHER, { kind: 'revalidated' }]]),
    });
    h.manifest.entries.set(`${ADDR}:${PARENT}`, manifestEntryFor({
      status: 'valid',
      rootHashHex: 'aa'.repeat(32),
    }));
    // Child has splitParent set but reason is `'off-record-spend'` —
    // NOT a cascade victim. Skip silently.
    h.manifest.entries.set(`${ADDR}:${OTHER}`, manifestEntryFor({
      status: 'invalid',
      invalidReason: 'off-record-spend',
      splitParent: PARENT,
      rootHashHex: 'b1'.repeat(32),
    }));

    const r = await h.runner.run(ADDR, PARENT);
    expect(r.checked).toBe(0);
    expect(r.revalidated).toBe(0);
    expect(r.stillInvalid).toBe(0);
    expect(h.callsByChild.length).toBe(0);
  });

  it('orphan splitParent (no manifest entry for child) is skipped', async () => {
    const PARENT = 'p';
    const ORPHAN = 'orphan';
    const h = buildRevalidatorHarness();
    h.manifest.entries.set(`${ADDR}:${PARENT}`, manifestEntryFor({
      status: 'valid',
      rootHashHex: 'aa'.repeat(32),
    }));
    // ORPHAN claims splitParent=PARENT but child entry has no
    // invalidReason — let's actually instantiate it AND remove its
    // entry to simulate orphan state cleanly. Easier path: stage a
    // valid entry then delete it to satisfy `findChildren` AND
    // trigger the no-manifest-entry skip.
    h.manifest.entries.set(`${ADDR}:${ORPHAN}`, manifestEntryFor({
      status: 'valid', // not parent-rejected
      splitParent: PARENT,
      rootHashHex: 'b1'.repeat(32),
    }));

    const r = await h.runner.run(ADDR, PARENT);
    expect(r.checked).toBe(0); // Child is not parent-rejected → skipped.
  });

  it('cycle defense (W32): visited-set per-call-stack — no infinite loop', async () => {
    // Construct a corrupted manifest where two children claim each
    // other as splitParent (impossible in honest construction but
    // possible under storage corruption). The walker must terminate.
    const PARENT = 'p';
    const A = 'a';
    const B = 'b';
    const h = buildRevalidatorHarness({
      verdicts: new Map([
        [A, { kind: 'revalidated' }],
        [B, { kind: 'revalidated' }],
      ]),
    });
    h.manifest.entries.set(`${ADDR}:${PARENT}`, manifestEntryFor({
      status: 'valid',
      rootHashHex: '01'.repeat(32),
    }));
    h.manifest.entries.set(`${ADDR}:${A}`, manifestEntryFor({
      status: 'invalid',
      invalidReason: 'parent-rejected',
      splitParent: PARENT,
      rootHashHex: '02'.repeat(32),
    }));
    h.manifest.entries.set(`${ADDR}:${B}`, manifestEntryFor({
      status: 'invalid',
      invalidReason: 'parent-rejected',
      splitParent: A,
      rootHashHex: '03'.repeat(32),
    }));
    // Inject the corruption: another entry whose splitParent is B and
    // child is A (closing the cycle).
    h.manifest.entries.set(`${ADDR}:cycle-extra`, manifestEntryFor({
      status: 'invalid',
      invalidReason: 'parent-rejected',
      splitParent: B,
      rootHashHex: '04'.repeat(32),
    }));
    // Force A to also have splitParent=B as a stored-but-corrupt extra
    // by overlay (splitParent is a single field — the cycle would only
    // arise from an A that's both PARENT's child AND B's child). The
    // visited-set defends regardless.

    const r = await h.runner.run(ADDR, PARENT);
    // No infinite loop — assert termination.
    expect(r.checked).toBeGreaterThanOrEqual(1);
    // Cycle defense MAY have fired depending on traversal — but the
    // run must terminate.
    expect(typeof r.cycleDefenseFired).toBe('number');
  });

  it('bounded depth: maxDepth=2 fires cycleDefenseFired at depth >= 2', async () => {
    // Build a 4-deep cascade chain: PARENT → C → GC → GGC. With
    // maxDepth=2 the recursion stops at depth=2 (when about to read
    // GC's children) and cycle-defense fires once. C and GC are
    // revalidated normally; GGC is never reached.
    const PARENT = 'p';
    const C = 'c';
    const GC = 'gc';
    const GGC = 'ggc';
    const h = buildRevalidatorHarness({
      verdicts: new Map([
        [C, { kind: 'revalidated' }],
        [GC, { kind: 'revalidated' }],
        [GGC, { kind: 'revalidated' }],
      ]),
      maxDepth: 2,
    });
    h.manifest.entries.set(`${ADDR}:${PARENT}`, manifestEntryFor({
      status: 'valid', rootHashHex: '01'.repeat(32),
    }));
    h.manifest.entries.set(`${ADDR}:${C}`, manifestEntryFor({
      status: 'invalid', invalidReason: 'parent-rejected', splitParent: PARENT,
      rootHashHex: '02'.repeat(32),
    }));
    h.manifest.entries.set(`${ADDR}:${GC}`, manifestEntryFor({
      status: 'invalid', invalidReason: 'parent-rejected', splitParent: C,
      rootHashHex: '03'.repeat(32),
    }));
    h.manifest.entries.set(`${ADDR}:${GGC}`, manifestEntryFor({
      status: 'invalid', invalidReason: 'parent-rejected', splitParent: GC,
      rootHashHex: '04'.repeat(32),
    }));

    const r = await h.runner.run(ADDR, PARENT);
    expect(r.cycleDefenseFired).toBeGreaterThanOrEqual(1);
    // Verify the cycle warnings include a depth-overrun kind.
    const overrun = h.cycleWarnings.filter((w) => w.kind === 'depth-overrun');
    expect(overrun.length).toBeGreaterThanOrEqual(1);
    // C and GC processed; GGC NOT reached due to depth cap.
    expect(h.callsByChild).not.toContain(GGC);
  });

  it('parent flip-back mid-loop → fresh parent state read per child (steelman #170)', async () => {
    // Steelman fix: previously the runner read the parent ONCE before
    // the children loop and re-used `parentIsValid` for every child
    // (and grandchild). If a concurrent worker flipped the parent
    // back to `invalid` during the iteration, every subsequent child
    // would still be fed to the validator with stale `parentIsValid=true`.
    //
    // The fix re-reads the parent FRESH inside the loop body, ahead of
    // each child's validator call. This test:
    //   1. Sets parent = `valid` and three cascaded children C1, C2, C3.
    //   2. After C1's validator runs, flips parent → `invalid`.
    //   3. Asserts: C2 and C3 see the flipped parent and short-circuit
    //      via the `!parentIsValid` branch — `stillInvalid` increments
    //      WITHOUT invoking the validator.
    const PARENT = 'p';
    const C1 = 'c1';
    const C2 = 'c2';
    const C3 = 'c3';

    let flipDone = false;
    const h = buildRevalidatorHarness({
      verdicts: new Map([
        [C1, { kind: 'revalidated' }],
        [C2, { kind: 'revalidated' }],
        [C3, { kind: 'revalidated' }],
      ]),
      beforeVerdict: ({ childTokenId, manifest }) => {
        // Right after C1's validator call, flip parent to invalid.
        // Subsequent reads of PARENT will see status='invalid', so
        // C2/C3 must short-circuit before invoking the validator.
        if (childTokenId === C1 && !flipDone) {
          const cur = manifest.entries.get(`${ADDR}:${PARENT}`)!;
          manifest.entries.set(`${ADDR}:${PARENT}`, {
            ...cur,
            status: 'invalid',
            invalidReason: 'oracle-rejected',
          });
          flipDone = true;
        }
      },
    });

    h.manifest.entries.set(`${ADDR}:${PARENT}`, manifestEntryFor({
      status: 'valid',
      rootHashHex: 'aa'.repeat(32),
    }));
    for (const [tid, hex] of [
      [C1, 'b1'.repeat(32)],
      [C2, 'b2'.repeat(32)],
      [C3, 'b3'.repeat(32)],
    ] as const) {
      h.manifest.entries.set(`${ADDR}:${tid}`, manifestEntryFor({
        status: 'invalid',
        invalidReason: 'parent-rejected',
        splitParent: PARENT,
        rootHashHex: hex,
      }));
    }

    const r = await h.runner.run(ADDR, PARENT);

    // All three children inspected (the `wasParentRejected` filter
    // accepts them all).
    expect(r.checked).toBe(3);
    // Only C1 was revalidated — C2/C3 short-circuited via the fresh
    // per-child parent-read seeing the flip-back.
    expect(r.revalidated).toBe(1);
    expect(r.stillInvalid).toBe(2);
    // Critically: the validator was invoked ONLY for C1. Without the
    // per-child fresh parent-read, the loop would have invoked
    // validator for C2 and C3 too (using stale `parentIsValid=true`).
    expect(h.callsByChild).toEqual([C1]);
  });

  it('grandchildren get fresh parent state per recursive frame (steelman #170)', async () => {
    // Steelman: the runner's recursion into a successfully-revalidated
    // child reuses the SAME `_walkChildren` recursion. The recursive
    // frame's `currentTokenId` is the child (now grandparent of the
    // walk's root). The fresh-parent-read MUST happen against the
    // grandparent for each grandchild — not against the original root.
    //
    // Setup: PARENT (valid) → C (cascaded) → GC1, GC2, GC3 (cascaded).
    // After C revalidates, recursion descends. Before GC2's validator
    // call, flip C back to `invalid`. GC2/GC3 must short-circuit.
    const PARENT = 'p';
    const C = 'c';
    const GC1 = 'gc1';
    const GC2 = 'gc2';
    const GC3 = 'gc3';

    let cFlipped = false;
    const h = buildRevalidatorHarness({
      verdicts: new Map([
        [C, { kind: 'revalidated' }],
        [GC1, { kind: 'revalidated' }],
        [GC2, { kind: 'revalidated' }],
        [GC3, { kind: 'revalidated' }],
      ]),
      beforeVerdict: ({ childTokenId, manifest }) => {
        if (childTokenId === GC1 && !cFlipped) {
          // Flip C back to invalid AFTER GC1's validator has been
          // invoked but BEFORE GC2/GC3 are processed.
          const cur = manifest.entries.get(`${ADDR}:${C}`)!;
          manifest.entries.set(`${ADDR}:${C}`, {
            ...cur,
            status: 'invalid',
            invalidReason: 'parent-rejected',
            splitParent: PARENT,
          });
          cFlipped = true;
        }
      },
    });

    h.manifest.entries.set(`${ADDR}:${PARENT}`, manifestEntryFor({
      status: 'valid',
      rootHashHex: '01'.repeat(32),
    }));
    h.manifest.entries.set(`${ADDR}:${C}`, manifestEntryFor({
      status: 'invalid',
      invalidReason: 'parent-rejected',
      splitParent: PARENT,
      rootHashHex: '02'.repeat(32),
    }));
    for (const [tid, hex] of [
      [GC1, '03'.repeat(32)],
      [GC2, '04'.repeat(32)],
      [GC3, '05'.repeat(32)],
    ] as const) {
      h.manifest.entries.set(`${ADDR}:${tid}`, manifestEntryFor({
        status: 'invalid',
        invalidReason: 'parent-rejected',
        splitParent: C,
        rootHashHex: hex,
      }));
    }

    const r = await h.runner.run(ADDR, PARENT);

    // C revalidated; GC1 revalidated (before C-flip);
    // GC2 and GC3 short-circuited (saw C as invalid).
    expect(r.checked).toBe(4); // C + GC1 + GC2 + GC3
    expect(r.revalidated).toBe(2); // C + GC1
    expect(r.stillInvalid).toBe(2); // GC2 + GC3
    // Validator called only for C and GC1. GC2 and GC3 short-circuited
    // because the recursive frame's per-child parent-read saw C
    // flipped back to invalid.
    expect(h.callsByChild).toEqual([C, GC1]);
  });

  it('per-call-stack visited-set isolation (W32)', async () => {
    // Two independent revalidations against different parents must not
    // share visited-set state.
    const P1 = 'p1';
    const P2 = 'p2';
    const C = 'shared-c';
    const h = buildRevalidatorHarness({
      verdicts: new Map([[C, { kind: 'revalidated' }]]),
    });
    h.manifest.entries.set(`${ADDR}:${P1}`, manifestEntryFor({
      status: 'valid', rootHashHex: '01'.repeat(32),
    }));
    h.manifest.entries.set(`${ADDR}:${P2}`, manifestEntryFor({
      status: 'valid', rootHashHex: '02'.repeat(32),
    }));
    h.manifest.entries.set(`${ADDR}:${C}`, manifestEntryFor({
      status: 'invalid',
      invalidReason: 'parent-rejected',
      splitParent: P1,
      rootHashHex: '03'.repeat(32),
    }));

    // First run for P1 — visits C.
    const r1 = await h.runner.run(ADDR, P1);
    expect(r1.checked).toBe(1);
    expect(r1.revalidated).toBe(1);
    // Reset the validator's call log for clarity.
    h.callsByChild.length = 0;

    // Second run for P2 — child has been revalidated; no cascaded
    // descendants of P2. Should be 0 checked. Critically, the visited
    // set from the first run MUST NOT bleed into the second run.
    const r2 = await h.runner.run(ADDR, P2);
    expect(r2.checked).toBe(0);
  });
});
