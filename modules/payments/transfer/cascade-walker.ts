/**
 * UXF Transfer — class-aware cascade walker (T.5.B.5).
 *
 * Single owner of cascade logic per `docs/uxf/UXF-TRANSFER-PROTOCOL.md`
 * §6.1.1. The sender-side finalization worker (T.5.B) hard-fails an
 * outbox entry and EMITS `transfer:cascade-failed`; this module is the
 * CONSUMER that walks the cascade.
 *
 * **Class asymmetry (C11)** — per §6.1.1:
 *  - **Coin path**: walk children whose manifest entry has
 *    `splitParent === parentTokenId`. Each child is marked
 *    `manifest.status='invalid'` with `invalidReason='parent-rejected'`
 *    via {@link ManifestCas} (W27 parent-flip protection: the parent's
 *    status is re-read inside the CAS payload). Recursion is transitive
 *    (grandchildren cascade too) bounded by {@link MAX_CHAIN_DEPTH}.
 *    `transfer:cascade-failed` is emitted for any outbox entry that
 *    referenced the cascaded children.
 *  - **NFT path**: NO `splitParent` walk (NFTs preserve `tokenId` and
 *    are never split). Outbox entries that shipped this NFT are
 *    examined — one `transfer:cascade-failed` per (recipient-pubkey,
 *    tokenId). Per issue #167, NON-instant outbox entries (conservative
 *    / txf) are now ALSO emitted with `mode: 'conservative'|'txf'` and
 *    `silent: true` so UI consumers can render the irrecoverable
 *    "lost-NFT" hard-error path. Historic behaviour silently dropped
 *    these — leaving the user with a token they thought succeeded but
 *    which had in fact shipped silently.
 *
 * **Race-lost EXCEPTION (§6.1.1)** — when `reason === 'race-lost'` the
 * cascade does NOT fire. The source token is genuinely valid (the
 * race-winner's tx is on-chain); the recipient never received our
 * bundle. Cascade returns `{cascaded: 0, nftNotified: 0}` with no
 * mutations.
 *
 * **Cycle defense (W32 + spec §6.1.1)** — cycles cannot arise from
 * honest chain construction (DAG), but `splitParent` is a manifest-side
 * annotation that could be corrupted. Defense:
 *   1. **Per-call-stack visited-set** (W32): the visited set is a
 *      function parameter, NOT module-level state. Two concurrent
 *      cascades for different parents do NOT share state — each has
 *      its own set, preventing cross-contamination.
 *   2. **Bounded depth**: recursion stops at
 *      {@link MAX_CHAIN_DEPTH} = 64 (matches §5.5 chain-depth bound).
 *      On overrun, the recursion stops and a warning is logged via the
 *      injected `onCycleDetected` callback (or a no-op if not provided).
 *
 * **Parent-flip protection (W27)** — between the time T.5.B emits
 * `transfer:cascade-failed` and the cascade walker reads the parent's
 * manifest entry, an `importInclusionProof()` override could have
 * flipped the parent back to `valid` (§6.3 stuck-PENDING escape hatch).
 * The CAS-based child write therefore re-reads the parent's manifest
 * entry INSIDE the CAS payload computation. If the parent is no longer
 * `invalid`, the cascade for that child is a no-op (the entire
 * subtree-walk for that branch aborts).
 *
 * **Pure-ish API**: the walker uses ONLY injected dependencies
 * (manifestStore-shaped reader, manifestCas, outboxScanner, emit). No
 * module-level state. Multiple `CascadeWalker` instances in the same
 * process are independent.
 *
 * Spec references:
 *  - §6.1.1 (cascade rule, race-lost special case, cycle defense)
 *  - §6.1   (sender-side worker hard-fail trigger)
 *  - §4.1   (canonical asset model — coin vs NFT class-disjoint)
 *  - W27    (parent-flip protection inside CAS)
 *  - W32    (visited-set per-call-stack scope)
 *
 * @packageDocumentation
 */

import { MAX_CHAIN_DEPTH } from './limits';
import {
  ManifestCas,
  type ManifestCasResult,
} from '../../../profile/manifest-cas';
import type { TokenManifestEntry } from '../../../profile/token-manifest';
import type { DispositionReason } from '../../../types/disposition';
import type {
  SphereEventMap,
  SphereEventType,
} from '../../../types';
import type { UxfTransferOutboxEntry } from '../../../types/uxf-outbox';

// =============================================================================
// 1. Injected dependency contracts
// =============================================================================

/**
 * Narrow read-only manifest scanner used by the walker. The coin path
 * needs:
 *  - {@link readEntry}    — to inspect a tokenId's current manifest
 *                           entry (parent-flip check, child status,
 *                           token-class lookup via stored class hint).
 *  - {@link findChildren} — to enumerate tokenIds whose entry has
 *                           `splitParent === parentTokenId`.
 *
 * Production wires this to the OrbitDB-backed manifest store; tests
 * inject in-memory fakes.
 */
export interface CascadeManifestScanner {
  /**
   * Read the current manifest entry for `(addr, tokenId)`. Returns
   * `undefined` if no entry exists.
   *
   * MUST observe the latest committed value (no caching layered above
   * the underlying CRDT view) — the W27 parent-flip protection requires
   * a freshly-observed parent status inside each CAS payload.
   */
  readEntry(
    addr: string,
    tokenId: string,
  ): Promise<TokenManifestEntry | undefined>;

  /**
   * Enumerate tokenIds whose manifest entry has
   * `splitParent === parentTokenId`. Order is implementation-defined;
   * the walker does NOT rely on ordering (only on completeness).
   *
   * Production implementations MAY be backed by a secondary index or by
   * a full-scan fallback — the walker treats the call as best-effort
   * (stale results merely defer cascade work to a subsequent worker
   * pass; missing results are forensically recoverable via the operator
   * `revalidateCascadedChildren()` path).
   *
   * **Failure semantics**: a thrown error is NOT swallowed. The walker
   * increments {@link CascadeResult.scannerErrors}, invokes
   * {@link CascadeWalkerOptions.onScannerError} with
   * `phase: 'find-children'`, logs to `console.warn`, and aborts the
   * branch (children below `parentTokenId` remain un-cascaded for THIS
   * pass). The operator's `revalidateCascadedChildren()` path is the
   * recovery channel.
   */
  findChildren(
    addr: string,
    parentTokenId: string,
  ): Promise<ReadonlyArray<string>>;
}

/**
 * Narrow read-only outbox scanner. The walker uses this to find outbox
 * entries that shipped a given tokenId so it can emit
 * `transfer:cascade-failed` per (recipient, tokenId).
 *
 * Production wires this to {@link OutboxWriter.readAllNew}; tests
 * inject in-memory fakes.
 */
export interface CascadeOutboxScanner {
  /**
   * Return all outbox entries (new schema) whose `tokenIds` includes
   * `tokenId`. Order is implementation-defined. Tombstoned / removed
   * entries MUST be filtered out by the implementation.
   */
  findEntriesByTokenId(
    tokenId: string,
  ): Promise<ReadonlyArray<UxfTransferOutboxEntry>>;
}

/**
 * Token-class lookup callback. Returns `'coin'` or `'nft'` for the
 * given tokenId. The walker invokes this on the FAILING token (the
 * cascade root) to decide which path to take.
 *
 * Production wires this to a pool reader that materializes the token
 * and runs `classifyToken()` (T.2.B); tests inject a function that
 * looks up a class from a per-test fixture map.
 *
 * Returns `null` when the token is not known locally — the walker
 * treats this as a no-op cascade (no class → no children to walk and
 * no outbox to emit for; the operator can invoke
 * `revalidateCascadedChildren()` later if needed).
 */
export type ClassifyTokenLookup = (
  addr: string,
  tokenId: string,
) => Promise<'coin' | 'nft' | null>;

// =============================================================================
// 2. CascadeWalker construction options
// =============================================================================

/** Cycle / depth-overrun warning shape passed to {@link CascadeWalkerOptions.onCycleDetected}. */
export interface CascadeCycleWarning {
  readonly addr: string;
  readonly parentTokenId: string;
  readonly visitedTokenId: string;
  readonly depth: number;
  readonly kind: 'cycle' | 'depth-overrun';
}

/**
 * Scanner-error warning shape passed to
 * {@link CascadeWalkerOptions.onScannerError}.
 *
 *  - `phase: 'find-children'` — `manifestScanner.findChildren()` threw.
 *    The cascade walk for that branch aborted with no further recursion;
 *    children below that node remain un-cascaded. Operators may invoke
 *    `revalidateCascadedChildren()` later to recover the missed branch.
 *  - `phase: 'find-outbox-entries'` — `outboxScanner.findEntriesByTokenId()`
 *    threw. The outbox notification for `tokenId` was skipped; the
 *    cascade walk continued for OTHER children. Operators may inspect
 *    the outbox manually to identify shipments that did not receive a
 *    `transfer:cascade-failed` event.
 *
 * The walker increments the {@link CascadeResult.scannerErrors} counter
 * AND invokes this callback on every such error so operators can wire
 * alerts. Critical because cascade is the load-bearing defense against
 * parent-recipient-rejected token spending — silent scanner failures
 * leave child tokens marked `valid` while their parent is `_invalid`.
 */
export interface CascadeScannerError {
  readonly addr: string;
  readonly tokenId: string;
  readonly phase: 'find-children' | 'find-outbox-entries';
  readonly error: unknown;
}

/**
 * Construction options for {@link CascadeWalker}. All external
 * dependencies are injected so unit tests can drive the walker against
 * deterministic fakes without spinning up OrbitDB or the outbox store.
 */
export interface CascadeWalkerOptions {
  /** Manifest scanner — read entries + enumerate children by splitParent. */
  readonly manifestScanner: CascadeManifestScanner;
  /** ManifestCas helper for parent-flip-protected child writes (W27). */
  readonly manifestCas: ManifestCas;
  /** Outbox scanner — find entries that shipped a given tokenId. */
  readonly outboxScanner: CascadeOutboxScanner;
  /** Token-class lookup for the cascade root. */
  readonly classifyToken: ClassifyTokenLookup;
  /** Event emitter — same surface used by Sphere. */
  readonly emit: <T extends SphereEventType>(
    type: T,
    data: SphereEventMap[T],
  ) => void;
  /**
   * Optional callback invoked when the cycle defense (visited-set or
   * depth-overrun) prevents recursion. Defaults to a no-op. Used by
   * tests to assert the W32 invariant fires.
   */
  readonly onCycleDetected?: (warning: CascadeCycleWarning) => void;
  /**
   * Optional callback invoked when an injected scanner throws
   * (`manifestScanner.findChildren()` or
   * `outboxScanner.findEntriesByTokenId()`). Defaults to a no-op; the
   * walker still increments {@link CascadeResult.scannerErrors} and
   * logs to `console.warn`. Operators wire this to push to their alert
   * pipeline because a swallowed scanner error means a child remained
   * `valid` while its parent flipped to `_invalid` — a security-critical
   * regression that the receiver-side cascade is the load-bearing
   * defense against.
   */
  readonly onScannerError?: (error: CascadeScannerError) => void;
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
 * Per-cascade summary returned by {@link CascadeWalker.cascade}.
 *
 *  - `cascaded`     — number of coin-class child manifest entries
 *                     successfully transitioned to `invalid` /
 *                     `parent-rejected`. Includes transitive
 *                     descendants. Excludes children for which the CAS
 *                     write was aborted by the W27 parent-flip check.
 *  - `nftNotified`  — number of outbox entries for which
 *                     `transfer:cascade-failed` was emitted in the NFT
 *                     path. Does NOT include the coin-path emissions
 *                     (which are counted in `outboxNotified`).
 *  - `outboxNotified` — number of outbox entries for which
 *                       `transfer:cascade-failed` was emitted in the
 *                       coin path (i.e. notification of downstream
 *                       recipients of cascaded children).
 *  - `parentFlipAborted` — number of children skipped because the
 *                          W27 parent-flip protection observed the
 *                          parent had been re-validated via
 *                          `importInclusionProof()` between the
 *                          cascade trigger and the child write.
 *  - `cycleDefenseFired` — number of times the depth-overrun /
 *                          true-cycle defense prevented further
 *                          recursion. **Wave 4 steelman split**: this
 *                          counter no longer conflates DAG-join skips
 *                          (legitimate "same child visited twice via
 *                          different paths") with corruption-class
 *                          cycles. It increments ONLY on
 *                          `depth >= MAX_CHAIN_DEPTH` (an acyclic
 *                          coin-split graph cannot legitimately reach
 *                          this depth — the underlying manifest is
 *                          corrupted or contains a true cycle).
 *                          Operator dashboards SHOULD treat any
 *                          non-zero value here as a forensic signal.
 *  - `dagJoinSkipped`    — number of times a child was skipped because
 *                          it was already in the per-walk `visited`
 *                          set without depth-overrun. **Wave 4 split**:
 *                          this is normal DAG behavior — a coin-split
 *                          can reach the same descendant via multiple
 *                          parent paths, and the second arrival is
 *                          correctly suppressed to avoid duplicate
 *                          cascades. A non-zero value here is NOT a
 *                          forensic signal; it's expected on graphs
 *                          with shared descendants. Surface it in the
 *                          operator dashboard separately so true
 *                          corruption alerts (`cycleDefenseFired`)
 *                          aren't drowned in normal traffic.
 *  - `silentNotified` — number of outbox entries with non-instant
 *                       transfer mode for which `transfer:cascade-failed`
 *                       was emitted with `silent: true`. These are the
 *                       conservative / txf cascades that the historic
 *                       walker dropped silently — the count is
 *                       INCLUDED in `nftNotified` / `outboxNotified` as
 *                       appropriate (it is a discriminator overlay, not
 *                       a separate counter), so callers reasoning about
 *                       total events emitted SHOULD use
 *                       `nftNotified + outboxNotified` and break out
 *                       silent-vs-instant via this counter when the UI
 *                       split matters. Issue #167.
 *  - `scannerErrors`  — number of times an injected scanner
 *                       (`findChildren` / `findEntriesByTokenId`) threw
 *                       and the walker had to abort that branch /
 *                       outbox-notification. Surface this counter +
 *                       wire {@link CascadeWalkerOptions.onScannerError}
 *                       to alerting; a non-zero value is a forensic
 *                       signal that the cascade is incomplete and the
 *                       operator should run
 *                       `revalidateCascadedChildren()` against the
 *                       parent. Critical because cascade is the
 *                       load-bearing defense against
 *                       parent-recipient-rejected token spending.
 */
export interface CascadeResult {
  readonly cascaded: number;
  readonly nftNotified: number;
  readonly outboxNotified: number;
  readonly parentFlipAborted: number;
  readonly cycleDefenseFired: number;
  /**
   * Wave 4 steelman: legitimate DAG-join skips. See the
   * {@link CascadeResult.cycleDefenseFired} JSDoc above for the
   * rationale on splitting this out of the cycle counter.
   */
  readonly dagJoinSkipped: number;
  readonly silentNotified: number;
  readonly scannerErrors: number;
}

// =============================================================================
// 4. CascadeWalker
// =============================================================================

/**
 * Class-aware cascade walker.
 *
 * Construct one per address-scoped pipeline; pass the same instance
 * to every consumer of `transfer:cascade-failed` events from the
 * sender-side worker (or call {@link cascade} directly in test
 * harnesses). Holds NO module-level state.
 *
 * @example
 * ```ts
 * const walker = new CascadeWalker({
 *   manifestScanner, manifestCas, outboxScanner,
 *   classifyToken, emit,
 * });
 * sphere.on('transfer:cascade-failed', async (e) => {
 *   await walker.cascade(addr, e.tokenId, e.reason);
 * });
 * ```
 */
export class CascadeWalker {
  private readonly options: CascadeWalkerOptions;
  private readonly maxDepth: number;

  constructor(options: CascadeWalkerOptions) {
    this.options = options;
    this.maxDepth = options.maxDepth ?? MAX_CHAIN_DEPTH;
  }

  /**
   * Run the cascade for a single failing parent token. The class of
   * the failing token determines the path:
   *  - **`'coin'`** → walk `splitParent` children transitively, mark
   *    each invalid via parent-flip-protected CAS, emit
   *    `transfer:cascade-failed` for outbox entries referencing the
   *    cascaded children.
   *  - **`'nft'`** → no `splitParent` walk; emit
   *    `transfer:cascade-failed` for outbox entries that shipped this
   *    NFT.
   *
   * Race-lost short-circuits with no work.
   *
   * @param addr            Address scope for the cascade.
   * @param parentTokenId   Failing token's id (the cascade root).
   * @param reason          Disposition reason from T.5.B's hard-fail.
   *                        Determines whether the cascade fires
   *                        (race-lost ⇒ no-op).
   *
   * @returns A {@link CascadeResult} summary. Pure — does not mutate
   *          the caller's reference state.
   */
  async cascade(
    addr: string,
    parentTokenId: string,
    reason: DispositionReason,
  ): Promise<CascadeResult> {
    // -------------------------------------------------------------------------
    // §6.1.1 race-lost EXCEPTION — early return.
    // -------------------------------------------------------------------------
    // The source token is genuinely valid (race-winner's tx is on-chain);
    // the recipient never received our bundle. No cascade fires. This is
    // the FIRST CHECK before any I/O — a misplaced check below would
    // mean we could leak partial state on a race-lost.
    if (reason === 'race-lost') {
      return EMPTY_RESULT;
    }

    // -------------------------------------------------------------------------
    // Resolve the failing token's class. Routes to coin vs NFT path.
    // -------------------------------------------------------------------------
    const klass = await this.options.classifyToken(addr, parentTokenId);
    if (klass === null) {
      // Token not known locally — nothing to cascade. (E.g. the token
      // was removed by a concurrent operator action; the operator can
      // invoke `revalidateCascadedChildren()` later if needed.)
      return EMPTY_RESULT;
    }

    if (klass === 'nft') {
      return this._cascadeNft(addr, parentTokenId, reason);
    }
    return this._cascadeCoin(addr, parentTokenId, reason);
  }

  // ===========================================================================
  // 4.1. Coin path — recursive splitParent walk with W27 + W32 defenses.
  // ===========================================================================

  /**
   * Coin-path cascade. Walks `splitParent` children transitively, marks
   * each invalid via parent-flip-protected CAS, emits
   * `transfer:cascade-failed` for outbox entries referencing the
   * cascaded children.
   *
   * The visited-set is constructed HERE and threaded through recursion
   * — it is per-call-stack (W32), NEVER module-level state. The
   * starting token is added to the set so the recursion cannot revisit
   * the cascade root.
   *
   * @internal
   */
  private async _cascadeCoin(
    addr: string,
    parentTokenId: string,
    reason: DispositionReason,
  ): Promise<CascadeResult> {
    // W32: visited-set is a per-call-stack Set. NOT module-level.
    // Concurrent cascades for different parents have independent sets;
    // a token visited in one cascade is NOT marked-as-visited for the
    // other.
    const visited = new Set<string>();
    visited.add(parentTokenId);

    // Wave 4 steelman: separate `ancestors` set tracks the active
    // recursion path (root -> ... -> currentTokenId). A child landing
    // back inside `ancestors` is a TRUE cycle (graph corruption); a
    // child landing in `visited` but NOT `ancestors` is a legitimate
    // DAG-join (the child was reached and cascaded via another path
    // earlier in this walk; the second arrival is correctly suppressed
    // as redundant work). The two cases warrant different operator
    // signals — see CascadeResult.cycleDefenseFired vs dagJoinSkipped
    // JSDoc.
    const ancestors = new Set<string>();
    ancestors.add(parentTokenId);

    const counters = mutableCounters();

    await this._walkCoinChildren(
      addr,
      parentTokenId,
      reason,
      visited,
      ancestors,
      0, // initial depth
      counters,
    );

    return freezeCounters(counters);
  }

  /**
   * Recursive helper. Reads children of `currentTokenId`, applies the
   * `parent-rejected` cascade to each via parent-flip-protected CAS,
   * emits `transfer:cascade-failed` per outbox entry, then recurses
   * into each cascaded child's children.
   *
   * Termination conditions:
   *  - depth >= {@link maxDepth} (cycle / corruption defense)
   *  - child already in `visited` set (cycle defense)
   *  - child has no manifest entry (orphan reference; no-op)
   *  - W27 parent-flip protection aborted the CAS (no recursion)
   *
   * @internal
   */
  private async _walkCoinChildren(
    addr: string,
    currentTokenId: string,
    rootReason: DispositionReason,
    visited: Set<string>,
    ancestors: Set<string>,
    depth: number,
    counters: MutableCounters,
  ): Promise<void> {
    // Depth check — defense against corrupted manifest forming a long
    // chain. Per §6.1.1: "bound depth at MAX_CHAIN_DEPTH (default 64)".
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
      children = await this.options.manifestScanner.findChildren(
        addr,
        currentTokenId,
      );
    } catch (err) {
      // CRITICAL — surface scanner errors. Cascade is the load-bearing
      // defense against parent-recipient-rejected token spending; a
      // silently-swallowed `findChildren` failure leaves child tokens
      // marked `valid` while the parent is `_invalid`. We:
      //   1. Increment `scannerErrors` so the caller sees a non-zero
      //      result and can decide to retry / alert.
      //   2. Invoke `onScannerError` so operators can wire their alert
      //      pipeline to this signal directly.
      //   3. Log to `console.warn` as a last-resort breadcrumb.
      //   4. Abort THIS branch (children below `currentTokenId` won't be
      //      cascaded). The operator's `revalidateCascadedChildren()`
      //      path is the recovery channel.
      counters.scannerErrors++;
      this._emitScannerError({
        addr,
        tokenId: currentTokenId,
        phase: 'find-children',
        error: err,
      });
      try {
        // eslint-disable-next-line no-console
        console.warn(
          '[cascade-walker] findChildren failed for',
          { addr, tokenId: currentTokenId },
          err,
        );
      } catch {
        // ignore logging failures
      }
      return;
    }

    // Sort children lexicographically so the cascade order is
    // deterministic across replicas. Per §6.1 step 9 lock-ordering rule
    // (where applicable): "acquire each child's lock individually (in
    // lexicographic order of `tokenId`)". CAS strategy doesn't take
    // locks, but maintaining the same order keeps the audit log
    // reproducible.
    const sortedChildren = [...children].sort();

    for (const childTokenId of sortedChildren) {
      // Cycle defense: skip already-visited tokens. Per §6.1.1:
      // "MUST maintain a visited set during transitive recursion".
      // Cycles are defended primarily via the cascade ROOT being added
      // to `visited` at function entry — descendants walking back to
      // the root will see it in `visited`. We DO NOT mark the child
      // here; we mark only AFTER a successful cascade write (below).
      // Rationale: if `_cascadeChildWithParentFlipCheck` returns
      // `'parent-flipped'`, the child has NOT been mutated. Marking it
      // visited here would mean a re-cascade in a SUBSEQUENT walker
      // pass (after the parent flips back to `_invalid` again) would
      // skip this child within the same walk lifetime — leaving it
      // permanently uncascaded for this pass. Moving the mark after
      // the successful write keeps cycle defense intact (the root is
      // still the breaker) while letting transient parent-flip aborts
      // be re-attempted on the next worker pass.
      if (visited.has(childTokenId)) {
        // Wave 4 steelman: discriminate true cycle from legitimate
        // DAG-join. If `childTokenId` is in `ancestors`, walking into
        // it would re-enter an active recursion frame — that's a true
        // cycle (graph corruption: a descendant claims a `splitParent`
        // that resolves back to one of its own ancestors). If it's in
        // `visited` but NOT `ancestors`, we already cascaded this child
        // via another path earlier in this walk — a legitimate
        // DAG-join, normal for graphs with shared descendants.
        //
        // The two cases warrant different operator signals:
        //   - cycleDefenseFired → forensic alert (corruption suspected)
        //   - dagJoinSkipped    → diagnostic only (expected behavior)
        //
        // We still emit the cycle warning event for forensic visibility
        // (the historic `kind: 'cycle'` label is preserved verbatim
        // for callers wired to the existing signal); the counter
        // discriminates.
        if (ancestors.has(childTokenId)) {
          counters.cycleDefenseFired++;
        } else {
          counters.dagJoinSkipped++;
        }
        this._emitCycleWarning({
          addr,
          parentTokenId: currentTokenId,
          visitedTokenId: childTokenId,
          depth,
          kind: 'cycle',
        });
        continue;
      }

      // Apply the cascade to this child. The CAS payload computation
      // re-reads the parent (W27 parent-flip protection); on parent
      // flip, the CAS aborts and the recursion DOES NOT descend into
      // this child's children (their parent's now-valid status means
      // the cascade was stale).
      const writeResult = await this._cascadeChildWithParentFlipCheck(
        addr,
        currentTokenId,
        childTokenId,
        rootReason,
      );

      if (writeResult === 'parent-flipped') {
        counters.parentFlipAborted++;
        // Do NOT recurse — the parent is no longer rejected, so the
        // child's children's cascade would be stale too. Skip the
        // whole subtree.
        // Critically: we do NOT add `childTokenId` to `visited` here.
        // If the parent flips back to `_invalid` later (e.g. operator
        // override revoked, or another cascade event re-fires the
        // rejection), the next walker pass MUST be free to re-attempt
        // the cascade on this child. Cycle defense is preserved by
        // the root membership in `visited`.
        continue;
      }
      if (writeResult === 'no-entry' || writeResult === 'cas-exhausted') {
        // No-op for missing entries; CAS-exhausted means contention
        // we can't resolve in this pass — operator will need to
        // re-trigger via `revalidateCascadedChildren()` if they want
        // to fix this branch. Same rationale as parent-flipped: don't
        // mark visited (we want subsequent passes to re-attempt).
        continue;
      }

      // Successfully cascaded — count it and emit cascade-failed for
      // any outbox entries referencing this child. Now safe to mark
      // visited: the child has been mutated to `_invalid`, so any
      // re-walk in this pass (e.g. via a corrupted-cycle path) would
      // be a no-op (the idempotency branch in `_cascadeChildWithParentFlipCheck`
      // would short-circuit). Marking it here also prevents redundant
      // work for legitimate DAG joins.
      visited.add(childTokenId);

      counters.cascaded++;
      const tally = await this._emitCascadeFailedForOutboxEntries(
        addr,
        childTokenId,
        rootReason,
      );
      counters.outboxNotified += tally.emitted;
      counters.silentNotified += tally.silent;
      if (tally.scannerError) {
        counters.scannerErrors++;
      }

      // Recurse into the child's children (transitive cascade).
      // Push `childTokenId` onto the ancestors set for the duration of
      // the recursive call so a descendant pointing back at it would
      // be classified as a true cycle. Pop in `finally` so concurrent
      // siblings (later iterations of this for-loop) don't see the
      // ancestor tag.
      ancestors.add(childTokenId);
      try {
        await this._walkCoinChildren(
          addr,
          childTokenId,
          rootReason,
          visited,
          ancestors,
          depth + 1,
          counters,
        );
      } finally {
        ancestors.delete(childTokenId);
      }
    }
  }

  /**
   * Apply the `parent-rejected` cascade to one child via
   * parent-flip-protected CAS (W27).
   *
   * The CAS payload computation re-reads the PARENT's manifest entry
   * inside the same logical step. If the parent has flipped to `valid`
   * (e.g. concurrent `importInclusionProof()`), the cascade is aborted
   * (no-op). This prevents stale cascades from invalidating children
   * whose parent is no longer rejected.
   *
   * Bounded retry: on `cas-mismatch` / `concurrent-modification`, retry
   * up to {@link CASCADE_CAS_RETRIES} times. On exhaustion, return
   * `'cas-exhausted'` — the caller logs and continues; the operator
   * can re-run the cascade via `revalidateCascadedChildren()` if
   * needed.
   *
   * Returns:
   *  - `'ok'`              — child is now `_invalid`/`parent-rejected`.
   *  - `'no-entry'`        — child manifest entry missing; no-op.
   *  - `'parent-flipped'`  — parent is no longer `invalid`; cascade
   *                          aborted.
   *  - `'cas-exhausted'`   — CAS retries exhausted; operator action
   *                          required.
   *
   * @internal
   */
  private async _cascadeChildWithParentFlipCheck(
    addr: string,
    parentTokenId: string,
    childTokenId: string,
    rootReason: DispositionReason,
  ): Promise<'ok' | 'no-entry' | 'parent-flipped' | 'cas-exhausted'> {
    void rootReason; // currently always 'parent-rejected' on the child;
    //               root reason is forensic, not on-disk.

    let attempts = 0;
    while (attempts < CASCADE_CAS_RETRIES) {
      attempts++;

      // -----------------------------------------------------------------------
      // W27 parent-flip protection: re-read the parent inside the CAS
      // payload computation. The READ here is the freshly-observed
      // value the CAS will commit against; if a concurrent
      // `importInclusionProof()` has flipped the parent to `valid`
      // between the cascade trigger and now, we observe that flip
      // here and abort.
      // -----------------------------------------------------------------------
      const parentEntry = await this.options.manifestScanner.readEntry(
        addr,
        parentTokenId,
      );
      if (parentEntry === undefined || parentEntry.status !== 'invalid') {
        // Parent is no longer invalid — cascade aborted.
        return 'parent-flipped';
      }

      // Read the child's current manifest entry — required as the CAS
      // precondition (we swap on the child's rootHash, not the parent's).
      const childEntry = await this.options.manifestScanner.readEntry(
        addr,
        childTokenId,
      );
      if (childEntry === undefined) {
        return 'no-entry';
      }
      // Idempotency: if the child is already invalid/parent-rejected,
      // treat as success without re-writing.
      if (
        childEntry.status === 'invalid' &&
        childEntry.invalidReason === 'parent-rejected' &&
        childEntry.splitParent === parentTokenId
      ) {
        return 'ok';
      }

      // Build the cascaded child entry. Preserve every existing field
      // and OVERLAY status/invalidReason/splitParent. Note: per §6.1.1
      // step 3 we move the child to `_invalid` collection; the
      // disposition writer downstream (T.3.C) handles that move via
      // its routing rules. Here we update the manifest entry's status
      // — the in-pool `_invalid` write is performed by the upstream
      // disposition pipeline if the operator re-runs the dispositions.
      // The minimal cascade write is the manifest status flip with the
      // splitParent reference preserved for `revalidateCascadedChildren()`.
      const next: TokenManifestEntry = {
        ...childEntry,
        status: 'invalid',
        invalidReason: 'parent-rejected',
        // Preserve splitParent — operator's `revalidateCascadedChildren`
        // uses this to find the parent for re-validation.
        splitParent: parentTokenId,
      };

      const result: ManifestCasResult = await this.options.manifestCas.update(
        addr,
        childTokenId,
        { contentHash: childEntry.rootHash },
        next,
      );

      if (result.ok) {
        return 'ok';
      }

      // CAS conflict — retry from re-read. The retry loop is bounded;
      // pathological contention (e.g. another worker constantly
      // writing the child) surfaces as 'cas-exhausted'.
      if (
        result.reason === 'cas-mismatch' ||
        result.reason === 'concurrent-modification'
      ) {
        continue;
      }

      // 'not-found' surfaces as a programming error here (we observed
      // an entry above) — fall through to retry once; a second
      // not-found means the child was deleted concurrently.
      if (result.reason === 'not-found') {
        return 'no-entry';
      }
    }

    return 'cas-exhausted';
  }

  // ===========================================================================
  // 4.2. NFT path — outbox-driven notification only (no splitParent walk).
  // ===========================================================================

  /**
   * NFT-path cascade. Per §6.1.1: NFTs preserve `tokenId` and are NEVER
   * split, so there are no `splitParent` children to walk. The walker
   * examines outbox entries that shipped this NFT and emits
   * `transfer:cascade-failed` per (recipient-pubkey, tokenId).
   *
   * **Issue #167 — conservative NFT must not be silent.** Historic
   * behaviour dropped `mode !== 'instant'` outbox entries with no event,
   * which left conservative NFT cascades indistinguishable from "no
   * outstanding shipments." For NFTs that is the canonical "lost-NFT"
   * signal — the sender shipped a one-of-a-kind token, the recipient
   * never finalized, and the source token is now forensically
   * irrecoverable. We now emit cascade-failed with `mode: 'conservative'`
   * (or `'txf'`) and `silent: true` so the UI can render a hard-error
   * distinct from instant-mode cascade failures. The counts roll up
   * into `nftNotified`; the `silentNotified` discriminator carries the
   * silent-mode subtotal.
   *
   * @internal
   */
  private async _cascadeNft(
    addr: string,
    parentTokenId: string,
    rootReason: DispositionReason,
  ): Promise<CascadeResult> {
    // Wave 5 steelman fix #4: thread `addr` into outbox-scanner
    // failure surfacing so multi-address operator alerts can be
    // attributed correctly. The outbox scanner itself is
    // address-scoped at construction; addr threading is for the
    // `onScannerError` callback's payload.
    const counters = mutableCounters();
    const tally = await this._emitCascadeFailedForOutboxEntries(
      addr,
      parentTokenId,
      rootReason,
    );
    counters.nftNotified = tally.emitted;
    counters.silentNotified += tally.silent;
    if (tally.scannerError) {
      counters.scannerErrors++;
    }
    return freezeCounters(counters);
  }

  // ===========================================================================
  // 4.3. Outbox notification — shared by both paths.
  // ===========================================================================

  /**
   * Find every outbox entry that shipped `tokenId` and emit
   * `transfer:cascade-failed` for each. Returns the count of events
   * emitted, broken out by `silent`-discriminator.
   *
   * Emits with discriminators:
   *  - `mode: 'instant'`, `silent` omitted — live finalization-path
   *    cascade. Receiver-side reconciliation may still recover.
   *  - `mode: 'conservative'` (or `'txf'`), `silent: true` — cascades
   *    on entries that finalized before publish. Historic behaviour
   *    dropped these silently (issue #167); they are now emitted so UI
   *    consumers can render a hard-error distinct from instant-mode.
   *    Receiver-side reconciliation cannot recover (the bundle is
   *    already on the wire / on-chain).
   *
   * Filters out:
   *  - entries whose `status` is hard-terminal already (`finalized`,
   *    `expired`) — emitting cascade-failed for an already-finalized
   *    entry would be misleading; the receiver already has a cleanly
   *    attached proof from the sender. (`failed-permanent` IS
   *    notified — operator may want to forensically correlate.)
   *
   * @internal
   */
  private async _emitCascadeFailedForOutboxEntries(
    addr: string,
    tokenId: string,
    rootReason: DispositionReason,
  ): Promise<{
    readonly emitted: number;
    readonly silent: number;
    readonly scannerError: boolean;
  }> {
    let entries: ReadonlyArray<UxfTransferOutboxEntry>;
    try {
      entries = await this.options.outboxScanner.findEntriesByTokenId(tokenId);
    } catch (err) {
      // Surface outbox scanner failures alongside manifest scanner
      // failures: increment counter, invoke callback, log breadcrumb.
      // Skip notification for THIS tokenId; the cascade walk continues
      // for other children.
      //
      // Wave 5 steelman fix #4: thread `addr` from the caller's
      // walk frame so operators wiring `onScannerError` can attribute
      // the failure to the originating wallet/address. Previously this
      // emitted `addr: ''` which made multi-address operator alerting
      // (e.g. "which sub-account's outbox is flaking?") impossible.
      this._emitScannerError({
        addr,
        tokenId,
        phase: 'find-outbox-entries',
        error: err,
      });
      try {
        // eslint-disable-next-line no-console
        console.warn(
          '[cascade-walker] findEntriesByTokenId failed for',
          { tokenId },
          err,
        );
      } catch {
        // ignore logging failures
      }
      return { emitted: 0, silent: 0, scannerError: true };
    }

    let emitted = 0;
    let silent = 0;
    for (const e of entries) {
      // Drop hard-terminal statuses regardless of mode — emitting
      // cascade-failed for a finalized entry would be misleading.
      if (e.status === 'finalized' || e.status === 'expired') continue;

      const isInstant = e.mode === 'instant';
      // For non-instant entries, mark the event as silent so UI can
      // render a distinct (hard-error) notification — issue #167.
      const eventPayload = isInstant
        ? {
            outboxId: e.id,
            tokenId,
            bundleCid: e.bundleCid,
            recipientTransportPubkey: e.recipientTransportPubkey,
            reason: rootReason,
            mode: 'instant' as const,
          }
        : {
            outboxId: e.id,
            tokenId,
            bundleCid: e.bundleCid,
            recipientTransportPubkey: e.recipientTransportPubkey,
            reason: rootReason,
            mode: e.mode,
            silent: true,
          };

      this.options.emit('transfer:cascade-failed', eventPayload);
      emitted++;
      if (!isInstant) silent++;
    }
    return { emitted, silent, scannerError: false };
  }

  /** @internal */
  private _emitCycleWarning(warning: CascadeCycleWarning): void {
    if (this.options.onCycleDetected !== undefined) {
      this.options.onCycleDetected(warning);
    }
  }

  /** @internal */
  private _emitScannerError(error: CascadeScannerError): void {
    if (this.options.onScannerError !== undefined) {
      try {
        this.options.onScannerError(error);
      } catch {
        // Callback failures must not abort the cascade. Defensive.
      }
    }
  }
}

// =============================================================================
// 5. Internal counter helpers
// =============================================================================

interface MutableCounters {
  cascaded: number;
  nftNotified: number;
  outboxNotified: number;
  parentFlipAborted: number;
  cycleDefenseFired: number;
  /** Wave 4 steelman: DAG-join skips, distinct from true cycles. */
  dagJoinSkipped: number;
  silentNotified: number;
  scannerErrors: number;
}

function mutableCounters(): MutableCounters {
  return {
    cascaded: 0,
    nftNotified: 0,
    outboxNotified: 0,
    parentFlipAborted: 0,
    cycleDefenseFired: 0,
    dagJoinSkipped: 0,
    silentNotified: 0,
    scannerErrors: 0,
  };
}

function freezeCounters(c: MutableCounters): CascadeResult {
  return {
    cascaded: c.cascaded,
    nftNotified: c.nftNotified,
    outboxNotified: c.outboxNotified,
    parentFlipAborted: c.parentFlipAborted,
    cycleDefenseFired: c.cycleDefenseFired,
    dagJoinSkipped: c.dagJoinSkipped,
    silentNotified: c.silentNotified,
    scannerErrors: c.scannerErrors,
  };
}

const EMPTY_RESULT: CascadeResult = Object.freeze({
  cascaded: 0,
  nftNotified: 0,
  outboxNotified: 0,
  parentFlipAborted: 0,
  cycleDefenseFired: 0,
  dagJoinSkipped: 0,
  silentNotified: 0,
  scannerErrors: 0,
});

/**
 * Bounded retry budget for the parent-flip-protected child write. Three
 * retries absorbs reasonable burst contention without livelock. On
 * exhaustion the walker logs and continues — the operator's
 * `revalidateCascadedChildren()` path is the recovery channel.
 */
const CASCADE_CAS_RETRIES = 3;
