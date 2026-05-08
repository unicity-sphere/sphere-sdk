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
 * Re-validator callback contract.
 *
 * **CONTRACT — parent re-read inside the validator's CAS.** Concurrent
 * worker actions (or a reverted `importInclusionProof()` override) can
 * flip the parent's manifest entry back to `'invalid'` between the
 * runner's pre-loop parent-validity check and the validator's mutation.
 * This module performs a fresh `manifestStore.readEntry()` on the
 * parent **immediately before** invoking the validator for each child
 * (defense-in-depth — see {@link RevalidateCascadedRunner._walkChildren}),
 * but the validator itself MUST also re-read the parent INSIDE its CAS
 * payload computation and abort with `'parent-still-invalid'` if the
 * parent is no longer `'valid'`. Otherwise a TOCTOU race lets a
 * concurrent re-invalidation slip past both gates.
 *
 * Production wires this to a thin coordinator that:
 *   1. Reads the parent's CURRENT manifest entry to confirm
 *      `status === 'valid'` (the operator override may have flipped
 *      it back, or a concurrent worker action may have re-invalidated
 *      it). MUST happen INSIDE the CAS payload, NOT before.
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

/**
 * Scanner-error warning shape passed to
 * {@link RevalidateCascadedOptions.onScannerError} (steelman warning,
 * mirrored from `cascade-walker.ts`).
 *
 * `phase: 'find-children'` — `manifestScanner.findChildren()` threw.
 * The walker for that branch aborts with no further recursion;
 * children below that node remain un-revalidated. Operators may
 * re-invoke `revalidateCascadedChildren()` later.
 */
export interface RevalidationScannerError {
  readonly addr: string;
  readonly tokenId: string;
  readonly phase: 'find-children';
  readonly error: unknown;
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
   * Optional callback invoked when the manifest scanner's
   * `findChildren()` throws (steelman warning — mirror of
   * cascade-walker's `onScannerError`). Defaults to a no-op; the
   * runner still increments {@link RevalidationResult.scannerErrors}
   * and logs to `console.warn`. Operators wire this to push to their
   * alert pipeline because a swallowed scanner error means a
   * cascaded subtree was NOT revalidated.
   */
  readonly onScannerError?: (error: RevalidationScannerError) => void;
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
  /**
   * Number of times `manifestScanner.findChildren()` threw and the
   * runner had to abort that branch (steelman warning — mirror of
   * cascade-walker's counter). Surface this counter + wire
   * {@link RevalidateCascadedOptions.onScannerError} to alerting; a
   * non-zero value is a forensic signal that a cascaded subtree was
   * NOT revalidated. The operator can re-invoke later.
   */
  readonly scannerErrors: number;
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
    } catch (err) {
      // (Steelman warning) Mirror cascade-walker's scanner-error path:
      // increment the counter, invoke the callback, log to console.warn.
      // The previous silent `catch { return }` collapsed forensic signal
      // — a swallowed `findChildren` failure leaves cascaded children
      // un-revalidated indefinitely (the operator can't tell the run
      // succeeded vs aborted on a transient backend error).
      counters.scannerErrors++;
      if (this.opts.onScannerError !== undefined) {
        try {
          this.opts.onScannerError({
            addr,
            tokenId: currentTokenId,
            phase: 'find-children',
            error: err,
          });
        } catch {
          // ignore callback failures — telemetry is best-effort.
        }
      }
      try {
        // eslint-disable-next-line no-console
        console.warn(
          '[revalidate-cascaded] findChildren failed for',
          { addr, tokenId: currentTokenId },
          err,
        );
      } catch {
        // ignore logging failures
      }
      return;
    }

    // Sort lexicographically so the revalidation order is deterministic
    // across replicas (matches the cascade walker's ordering rule).
    const sortedChildren = [...children].sort();

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

      // RE-READ the parent FRESH for each child. The parent's status
      // can flip mid-loop:
      //   - A concurrent worker may re-invalidate the parent (e.g.
      //     T.5.B sees a fresh oracle-rejected disposition arriving
      //     after the operator's importInclusionProof override).
      //   - The operator may invoke importInclusionProof again with
      //     a different verdict on the parent.
      //   - Recursion: when we descend into a successfully revalidated
      //     child to walk grandchildren, we re-enter `_walkChildren`
      //     with `currentTokenId = childTokenId`; that recursive frame
      //     reads the child-as-parent fresh here too (defense against
      //     stale state from the prior frame's perspective).
      // Defense-in-depth: the validator also MUST re-read the parent
      // inside its CAS (see {@link ChildRevalidator}'s contract). This
      // pre-loop read is a cheap roundtrip-saver; the CAS read is the
      // authoritative gate.
      const parentEntry = await this.opts.manifestStore.readEntry(
        addr,
        currentTokenId,
      );
      const parentIsValid =
        parentEntry !== undefined && parentEntry.status === 'valid';

      // If the parent isn't currently valid, every cascaded child
      // remains parent-rejected. Don't bother running the validator
      // — the verdict is determined and we save a roundtrip per
      // child.
      if (!parentIsValid) {
        counters.stillInvalid++;
        continue;
      }

      // Parent is valid; ask the validator whether this specific
      // child re-passes [B]/[C]/[E]. The validator MUST re-read the
      // parent INSIDE its CAS — see {@link ChildRevalidator}.
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
          // may revalidate too. Recurse. The recursive frame re-reads
          // the child (now grandparent) fresh inside its own loop, so
          // a flip of THAT entry mid-grandchildren-walk is caught.
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
          // pre-loop read above and the validator's CAS read. Treat
          // as still-invalid; do NOT recurse (the cascade is still in
          // force for the subtree).
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
  scannerErrors: number;
}

function mutableCounters(): MutableCounters {
  return {
    checked: 0,
    revalidated: 0,
    stillInvalid: 0,
    cycleDefenseFired: 0,
    scannerErrors: 0,
  };
}

function freezeCounters(c: MutableCounters): RevalidationResult {
  return {
    checked: c.checked,
    revalidated: c.revalidated,
    stillInvalid: c.stillInvalid,
    cycleDefenseFired: c.cycleDefenseFired,
    scannerErrors: c.scannerErrors,
  };
}
