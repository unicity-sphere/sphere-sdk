/**
 * UXF Transfer — operator `revalidateCascadedChildren()` (T.5.D).
 *
 * Implements §6.1.1's operator-explicit reversal path. After an operator
 * has used `importInclusionProof()` (T.5.D, §6.3 cases 5/6) to flip a
 * parent token from `_invalid` back to the active pool with
 * `manifest.status='valid'` (or `'pending'`), the cascaded children that
 * were marked `parent-rejected` by T.5.B.5 do NOT auto-revalidate. The
 * operator must explicitly invoke `revalidateCascadedChildren(parentTokenId)`
 * — this module is that invocation.
 *
 * **Pure consumer of T.5.B.5** (C3). The cascade walker (T.5.B.5) is the
 * single owner of the cascade-walk semantics. This module:
 *  1. ENUMERATES cascaded children: every `tokenId` in `_invalid` whose
 *     manifest entry has `splitParent === parentTokenId` AND
 *     `invalidReason === 'parent-rejected'`.
 *  2. RE-RUNS validation on each child against the now-valid parent.
 *     The re-run delegates to T.5.B.5 — this module never reimplements
 *     cascade-walk logic.
 *  3. RECURSES into revalidated children's children (transitive
 *     cascade reversal per §6.1.1).
 *
 * **Cycle defense (W32 — per-call-stack visited-set)**. The visited set
 * is a function parameter, threaded through recursion. NOT module-level
 * state. Two concurrent revalidations for different parents do NOT
 * share state — each gets its own set, preventing cross-contamination.
 *
 * **Bounded depth**. Recursion stops at {@link MAX_CHAIN_DEPTH} = 64
 * (matches §5.5 + cascade walker bounds). On overrun, the recursion
 * stops and the partial result includes a `cycle-detected` warning
 * count.
 *
 * **Termination conditions** for each child:
 *  - Parent is now `valid` AND child structurally re-passes [B]/[C]/[E]
 *    (the §5.3 decision matrix sub-checks, run downstream by the
 *    re-validator — this module emits the request, not the verdict).
 *    → child moves from `_invalid` back to active pool. Counted in
 *    `revalidated`.
 *  - Parent is still `invalid`. → child stays in `_invalid`. Counted
 *    in `stillInvalid`.
 *  - Child fails [B]/[C]/[E] for a reason UNRELATED to parent (e.g.
 *    `off-record-spend` if `oracle.isSpent === true` now). → child
 *    stays in `_invalid` with reason updated. Counted in `stillInvalid`
 *    (the manifest's `invalidReason` field is the authoritative source
 *    for the new reason; this module's counter just tracks "still in
 *    `_invalid`").
 *
 * Spec references:
 *  - §6.1.1   Cascade rule + transitive reversal + cycle defense.
 *  - §6.3     Operator override (`importInclusionProof` flips parent
 *             from `_invalid` to `valid`; this module is the next step).
 *  - W32      Per-call-stack visited-set scope.
 *  - C3       Cascade-walking is owned by T.5.B.5; this module is a
 *             consumer of the walker, not an author of cascade logic.
 *
 * @packageDocumentation
 */

import { MAX_CHAIN_DEPTH } from './limits';
import type { CascadeManifestScanner } from './cascade-walker';
import type { TokenManifestEntry } from '../../../profile/token-manifest';
import type { ManifestStore } from '../../../profile/manifest-store';
import type { DispositionReason } from '../../../types/disposition';

// =============================================================================
// 1. Public types — child-revalidator contract
// =============================================================================

/**
 * Verdict returned by the child re-validator for a single cascaded
 * child token.
 *
 *  - `'revalidated'` — the child is now structurally valid (parent
 *    is valid; [B]/[C]/[E] re-passed). The caller has moved the
 *    child from `_invalid` back to the active pool.
 *  - `'parent-still-invalid'` — the parent is still `_invalid`.
 *    The child remains parent-rejected. The walker MUST NOT recurse
 *    into the child's children (its parent's still-rejected status
 *    means the cascade is still in force).
 *  - `'still-invalid-other'` — the parent is now valid, but the
 *    child failed [B]/[C]/[E] for a reason unrelated to the parent
 *    (e.g. `off-record-spend`). The child remains in `_invalid`
 *    with reason updated by the validator. The walker DOES recurse
 *    into the child's children — they may revalidate independently.
 */
export type ChildRevalidationVerdict =
  | { readonly kind: 'revalidated' }
  | { readonly kind: 'parent-still-invalid' }
  | {
      readonly kind: 'still-invalid-other';
      readonly newReason: DispositionReason;
    };

/**
 * Re-validator callback contract. Production wires this to a thin
 * coordinator that:
 *   1. Reads the parent's CURRENT manifest entry to confirm
 *      `status === 'valid'` (the operator override may have flipped
 *      it back, or a concurrent worker action may have re-invalidated
 *      it).
 *   2. Re-runs §5.3 [B] (predicate evaluator), [C] (chain-validator),
 *      [E] (oracle.isSpent) against the child token.
 *   3. On pass: moves the child from `_invalid` back to the active
 *      pool with `status='valid'` (or `'pending'` if the chain has
 *      unfinalized predecessors), strips `invalidReason`, leaves
 *      `splitParent` intact (forensic).
 *   4. On structural fail: leaves the child in `_invalid` with
 *      `invalidReason` updated to the NEW disposition reason.
 *
 * The validator returns the VERDICT — this module's job is to count,
 * not to mutate. (The mutation happens inside the validator, which has
 * scope to the manifest store / disposition writer / pool reader.)
 *
 * Tests inject a deterministic verdict mapping per child.
 */
export type ChildRevalidator = (args: {
  readonly addr: string;
  readonly parentTokenId: string;
  readonly childTokenId: string;
  readonly childManifestEntry: TokenManifestEntry;
}) => Promise<ChildRevalidationVerdict>;

/**
 * Cycle / depth-overrun warning shape.
 */
export interface RevalidationCycleWarning {
  readonly addr: string;
  readonly parentTokenId: string;
  readonly visitedTokenId: string;
  readonly depth: number;
  readonly kind: 'cycle' | 'depth-overrun';
}

// =============================================================================
// 2. Construction options — RevalidateCascadedRunner
// =============================================================================

/**
 * Construction options for {@link RevalidateCascadedRunner}.
 */
export interface RevalidateCascadedOptions {
  /**
   * Manifest scanner — the SAME interface T.5.B.5 cascade walker
   * consumes. Reads entries + enumerates children by `splitParent`.
   * Production wires this to the OrbitDB-backed manifest scanner;
   * tests inject in-memory fakes.
   */
  readonly manifestScanner: CascadeManifestScanner;
  /**
   * Active-pool manifest store — used for parent-validity confirmation
   * (the W27 parent-flip-protection mirror, but here run BEFORE
   * descent rather than inside a CAS).
   */
  readonly manifestStore: Pick<ManifestStore, 'readEntry'>;
  /** Per-child re-validator callback. */
  readonly revalidateChild: ChildRevalidator;
  /**
   * Optional callback invoked on cycle / depth-overrun detection.
   * Defaults to no-op. Used by tests to assert the W32 invariant fires.
   */
  readonly onCycleDetected?: (warning: RevalidationCycleWarning) => void;
  /**
   * Optional override of the chain-depth bound. Defaults to
   * {@link MAX_CHAIN_DEPTH} (64). Tests use a small value to exercise
   * the depth-overrun path without building a 64-deep fixture.
   */
  readonly maxDepth?: number;
}

// =============================================================================
// 3. Result types
// =============================================================================

/**
 * Per-revalidation summary returned by {@link RevalidateCascadedRunner.run}.
 *
 *  - `checked`            — children inspected (every cascaded child
 *                           reachable via the splitParent walk).
 *  - `revalidated`        — children moved from `_invalid` back to
 *                           the active pool (verdict `'revalidated'`).
 *                           Includes transitive descendants.
 *  - `stillInvalid`       — children still in `_invalid` after the
 *                           run (verdict `'parent-still-invalid'`
 *                           OR `'still-invalid-other'`).
 *  - `cycleDefenseFired`  — cycle / depth-overrun defense
 *                           activations.
 */
export interface RevalidationResult {
  readonly checked: number;
  readonly revalidated: number;
  readonly stillInvalid: number;
  readonly cycleDefenseFired: number;
}

// =============================================================================
// 4. RevalidateCascadedRunner
// =============================================================================

/**
 * Operator-driven cascade reversal runner. Construct one per
 * address-scoped pipeline; invoke {@link run} after a successful
 * `importInclusionProof({ allowInvalidOverride: true })`.
 *
 * @example
 * ```ts
 * const runner = new RevalidateCascadedRunner({
 *   manifestScanner, manifestStore, revalidateChild,
 * });
 * const result = await runner.run(addr, parentTokenId);
 * console.log(`revalidated ${result.revalidated} of ${result.checked} children`);
 * ```
 */
export class RevalidateCascadedRunner {
  private readonly opts: RevalidateCascadedOptions;
  private readonly maxDepth: number;

  constructor(options: RevalidateCascadedOptions) {
    this.opts = options;
    this.maxDepth = options.maxDepth ?? MAX_CHAIN_DEPTH;
  }

  /**
   * Run the cascade reversal for one parent token.
   *
   * Walks `splitParent` children transitively. For each child that has
   * `invalidReason === 'parent-rejected'`, runs the injected
   * `revalidateChild` callback to determine whether the child can
   * return to the active pool.
   *
   * @param addr            Address scope for the revalidation.
   * @param parentTokenId   The parent that was just flipped via
   *                        `importInclusionProof()`.
   *
   * @returns A {@link RevalidationResult} summary.
   */
  async run(
    addr: string,
    parentTokenId: string,
  ): Promise<RevalidationResult> {
    // W32: per-call-stack visited-set. NOT module-level. Two concurrent
    // revalidations for different parents have independent sets.
    const visited = new Set<string>();
    visited.add(parentTokenId);

    const counters = mutableCounters();

    await this._walkChildren(
      addr,
      parentTokenId,
      visited,
      0, // initial depth
      counters,
    );

    return freezeCounters(counters);
  }

  // ===========================================================================
  // 4.1. Recursive helper
  // ===========================================================================

  /**
   * @internal
   *
   * Walk the children of `currentTokenId`. For each cascaded child
   * (one whose `splitParent === currentTokenId` AND
   * `invalidReason === 'parent-rejected'`), invoke the re-validator
   * and recurse into successfully-revalidated children's children.
   */
  private async _walkChildren(
    addr: string,
    currentTokenId: string,
    visited: Set<string>,
    depth: number,
    counters: MutableCounters,
  ): Promise<void> {
    // Depth check — defense against corrupted manifest forming a long
    // chain. Per §6.1.1: "bound depth at MAX_CHAIN_DEPTH".
    if (depth >= this.maxDepth) {
      counters.cycleDefenseFired++;
      this._emitCycleWarning({
        addr,
        parentTokenId: currentTokenId,
        visitedTokenId: currentTokenId,
        depth,
        kind: 'depth-overrun',
      });
      return;
    }

    let children: ReadonlyArray<string>;
    try {
      children = await this.opts.manifestScanner.findChildren(
        addr,
        currentTokenId,
      );
    } catch {
      // Defensive: if the scanner throws (e.g. transient backend
      // error), abort this branch rather than aborting the whole
      // revalidation. The operator can re-invoke later.
      return;
    }

    // Sort lexicographically so the revalidation order is deterministic
    // across replicas (matches the cascade walker's ordering rule).
    const sortedChildren = [...children].sort();

    // Confirm the PARENT is currently valid — this is the gate that
    // distinguishes "operator just flipped the parent via
    // importInclusionProof" (parent valid → cascade reversal can fire)
    // from "stale revalidation request" (parent still invalid → no-op
    // for every child). Defense-in-depth against the operator
    // double-invoking after a half-rolled-back override.
    const parentEntry = await this.opts.manifestStore.readEntry(
      addr,
      currentTokenId,
    );
    const parentIsValid =
      parentEntry !== undefined && parentEntry.status === 'valid';

    for (const childTokenId of sortedChildren) {
      // Cycle defense: skip already-visited tokens. Per §6.1.1:
      // "MUST maintain a visited set during transitive recursion".
      if (visited.has(childTokenId)) {
        counters.cycleDefenseFired++;
        this._emitCycleWarning({
          addr,
          parentTokenId: currentTokenId,
          visitedTokenId: childTokenId,
          depth,
          kind: 'cycle',
        });
        continue;
      }
      visited.add(childTokenId);

      const childEntry = await this.opts.manifestScanner.readEntry(
        addr,
        childTokenId,
      );
      if (childEntry === undefined) {
        // Orphan splitParent reference — no manifest entry. Skip
        // silently; the child is not actionable from this path.
        continue;
      }

      // Only revalidate children that were ACTUALLY cascaded —
      // `invalidReason === 'parent-rejected'`. A child with a
      // different invalidReason (e.g. `'off-record-spend'`) is in
      // `_invalid` for an unrelated reason and is NOT this
      // revalidation's responsibility.
      const wasParentRejected =
        childEntry.status === 'invalid' &&
        childEntry.invalidReason === 'parent-rejected' &&
        childEntry.splitParent === currentTokenId;

      if (!wasParentRejected) {
        // Child is not a cascade victim of this parent. Skip without
        // counting — the operator's UI surfaces only children that
        // were actually cascade-rejected.
        continue;
      }

      counters.checked++;

      // If the parent isn't currently valid, every cascaded child
      // remains parent-rejected. Don't bother running the validator
      // — the verdict is determined and we save a roundtrip per
      // child.
      if (!parentIsValid) {
        counters.stillInvalid++;
        continue;
      }

      // Parent is valid; ask the validator whether this specific
      // child re-passes [B]/[C]/[E].
      const verdict = await this.opts.revalidateChild({
        addr,
        parentTokenId: currentTokenId,
        childTokenId,
        childManifestEntry: childEntry,
      });

      switch (verdict.kind) {
        case 'revalidated':
          counters.revalidated++;
          // Transitive cascade reversal — the child is now valid, so
          // its OWN children (grandchildren of the original parent)
          // may revalidate too. Recurse.
          await this._walkChildren(
            addr,
            childTokenId,
            visited,
            depth + 1,
            counters,
          );
          break;
        case 'parent-still-invalid':
          // Race: the parent flipped back to `invalid` between our
          // read above and the validator's read. Treat as still-
          // invalid; do NOT recurse (the cascade is still in force
          // for the subtree).
          counters.stillInvalid++;
          break;
        case 'still-invalid-other':
          // Parent is valid but child fails for a different reason
          // (e.g. `off-record-spend`). The child stays in `_invalid`
          // with `invalidReason` updated by the validator. Per §6.1.1
          // we do NOT recurse: the child is a NEW invalid branch (its
          // own different reason), and grandchildren whose
          // `splitParent` points at this child are now cascaded by
          // the child's NEW invalidation — they remain rejected
          // unless the operator separately overrides the child via
          // its OWN `importInclusionProof` call (which would then
          // invoke `revalidateCascadedChildren(childTokenId)` to
          // walk that subtree).
          counters.stillInvalid++;
          break;
      }
    }
  }

  /** @internal */
  private _emitCycleWarning(warning: RevalidationCycleWarning): void {
    if (this.opts.onCycleDetected !== undefined) {
      this.opts.onCycleDetected(warning);
    }
  }
}

// =============================================================================
// 5. Convenience function — single-shot revalidation
// =============================================================================

/**
 * Convenience wrapper: build a one-off {@link RevalidateCascadedRunner}
 * and dispatch a single revalidation. Useful for tests and ad-hoc
 * operator scripts. Production code constructs the runner once per
 * Sphere instance.
 */
export async function revalidateCascadedChildren(
  options: RevalidateCascadedOptions,
  addr: string,
  parentTokenId: string,
): Promise<RevalidationResult> {
  const runner = new RevalidateCascadedRunner(options);
  return runner.run(addr, parentTokenId);
}

// =============================================================================
// 6. Internal counter helpers
// =============================================================================

interface MutableCounters {
  checked: number;
  revalidated: number;
  stillInvalid: number;
  cycleDefenseFired: number;
}

function mutableCounters(): MutableCounters {
  return {
    checked: 0,
    revalidated: 0,
    stillInvalid: 0,
    cycleDefenseFired: 0,
  };
}

function freezeCounters(c: MutableCounters): RevalidationResult {
  return {
    checked: c.checked,
    revalidated: c.revalidated,
    stillInvalid: c.stillInvalid,
    cycleDefenseFired: c.cycleDefenseFired,
  };
}
