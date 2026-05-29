/**
 * UXF Inter-Wallet Transfer — Conflict / merge engine (T.3.D).
 *
 * The §5.3 [D] decision-tree node-3 implementation. Given two
 * {@link TokenManifestEntry} records describing the same `tokenId` —
 * the existing local entry (`prev`) and a newly-arrived one (`next`)
 * derived from an incoming bundle — this module decides which of three
 * merge categories applies and produces a single deterministic merged
 * entry plus the §5.4 cross-replica metadata deltas:
 *
 *   1. **identical-no-op**       — both sides describe the same chain
 *                                  (`prev.rootHash === next.rootHash`).
 *                                  Idempotent receive. Metadata still
 *                                  union-merges per §5.4.
 *   2. **prefix-extension-merge**— one chain is a strict prefix or
 *                                  extension of the other. Honors §5.6
 *                                  monotonic-graft invariant: proofs
 *                                  accumulate, never delete. Delegates
 *                                  the chain selection to Wave G.3's
 *                                  {@link resolveTokenRoot} so the same
 *                                  resolver underpins package-level
 *                                  joins (`mergePkg`) and recipient-side
 *                                  manifest merges. The merged entry
 *                                  carries the resolver's winning
 *                                  `rootHash`; downstream re-runs of
 *                                  §5.3 [B'] (predicate evaluation
 *                                  on the merged head) and [E]
 *                                  (oracle.isSpent) are the caller's
 *                                  responsibility — see the test
 *                                  fixture "post-merge re-run of [B']
 *                                  surfaces NOT_OUR_CURRENT_STATE" for
 *                                  the exact contract.
 *   3. **genuinely-divergent-conflict**
 *                                — the two chains share no compatible
 *                                  prefix (true double-spend or fork).
 *                                  Manifest status is set to
 *                                  `'conflicting'`; the lex-min
 *                                  `bundleCid` (compared on raw CIDv1
 *                                  binary form per §5.3 [D-conflict]
 *                                  and T.1.D's
 *                                  {@link compareCidV1Binary}) wins
 *                                  the primary `rootHash` slot. Both
 *                                  sides' `rootHash` and any prior
 *                                  conflictingHeads are union-merged
 *                                  into the resulting `conflictingHeads`
 *                                  array (deduplicated, sorted).
 *
 * **Pure / I/O-free**. The merger performs NO storage or network calls;
 * all chain-resolution context (the shared element pool, the optional
 * verified-proof set) is supplied by the caller. The function is thus
 * trivially testable, and the output is a fully-formed
 * {@link TokenManifestEntry} that {@link ManifestStore.upsert} (T.3.C)
 * accepts as `next` for its CAS-retry loop.
 *
 * **Monotonic-graft invariant** (§5.6, normative): a `valid`/`pending`
 * token's queue entries can only be REMOVED — never re-added — and a
 * resolved chain MUST contain at least every proof either side's chain
 * carried. Wave G.3's {@link resolveTokenRoot} satisfies this for the
 * pool-level rebuild; the merger inherits the guarantee by delegating
 * chain selection to that resolver and then enforcing on the manifest:
 *   - `audit_promoted_from`: union (set-OR);
 *   - `conflictingHeads`:     union (set-OR);
 *   - `lamport`:              max-merge (§7.1);
 *   - `lastProofRefreshAt`:   max-merge (§6.3);
 *   - `splitParent`:          preserved-if-set, lex-min on divergence;
 *   - `bundleCid` /
 *     `senderTransportPubkey`: chain-winning side's value, falling back
 *                              to the other side when the winner does
 *                              not carry the field.
 *
 * **Lex-min tie-break is on BINARY**, not base32: per §5.3
 * [D-conflict] paragraph the comparator MUST operate on the parsed
 * CIDv1 byte sequence. Base32 alphabet ordering does NOT match binary
 * byte ordering, so two replicas comparing `'b...' < 'b...'` strings
 * could disagree on the same input — fatal for distributed
 * convergence. {@link compareCidV1Binary} (T.1.D) is the canonical
 * comparator and is the default; tests inject deterministic stubs.
 *
 * **Interaction with §5.5 step 9 [B'] re-run**: when the prefix-
 * extension merge produces a chain that is now LONGER than the
 * recipient's prior local copy, the merged head's destination state
 * may bind to a DIFFERENT identity (e.g., the recipient observed a
 * transfer-out they themselves authored, but the sender's bundle is
 * the more-recent version of the chain that includes that outbound
 * transition). The merger reports that the merge is a chain-content
 * extension via the `decision === 'prefix-extension-merge'` branch
 * but does NOT re-run the predicate check — that re-run is the §5.3
 * [B'] step the caller (T.3.E orchestrator / §5.5 step 9 worker)
 * runs against the merged entry's `rootHash`. The expected downstream
 * shape, per Appendix A "B-not-ours" row: if [B'] returns
 * `bindsToUs: false`, the disposition writer routes the merged manifest
 * entry to `_audit` with `reason='not-our-state'` (the merge IS the
 * canonical view; the pre-merge entry, if any, is also superseded —
 * see §5.3 [B'] "the pre-merge entry is also superseded — the merge
 * represents a more-canonical view"). The unit test for that path
 * lives in this module's test suite and exercises the
 * `decision === 'prefix-extension-merge'` shape against a synthetic
 * "we authored a transfer-out" merge.
 *
 * @module modules/payments/transfer/conflict-merger
 *
 * @see UXF-TRANSFER-PROTOCOL §5.3 [D]      (decision matrix node 3)
 * @see UXF-TRANSFER-PROTOCOL §5.4          (manifest metadata-preservation
 *                                          rules — set-OR / max-merge axes)
 * @see UXF-TRANSFER-PROTOCOL §5.6          (replay/duplicate/merge handling
 *                                          — monotonic-graft invariant)
 * @see UXF-TRANSFER-PROTOCOL §5.5 step 9   ([B'] / [D] / [E] re-run after
 *                                          finalization queue drain)
 * @see uxf/token-join.ts                   (Wave G.3 `resolveTokenRoot` —
 *                                          the chain-resolution primitive)
 * @see modules/payments/transfer/limits.ts (T.1.D `compareCidV1Binary`)
 */

import {
  resolveTokenRoot,
  type ResolveOutcome,
} from '../../../uxf/token-join.js';
import type { ContentHash, UxfElement } from '../../../uxf/types.js';
import type {
  TokenManifestEntry,
  TokenManifestStatus,
} from '../../../profile/token-manifest.js';

import { compareCidV1Binary } from './limits.js';

// =============================================================================
// 1. Public types
// =============================================================================

/**
 * Decision the merger produced for a `(prev, next)` pair. Stable on-wire
 * string union; future additions MUST be classified into one of these
 * three categories or land an ADR documenting a new branch.
 *
 * - `'identical-no-op'`              — `prev.rootHash === next.rootHash`.
 *                                      Pure metadata-merge result.
 * - `'prefix-extension-merge'`       — chains are linearly compatible;
 *                                      the resolver's winner (typically
 *                                      the longer chain, possibly an
 *                                      enriched synthetic root) takes
 *                                      the primary slot.
 * - `'genuinely-divergent-conflict'` — chains are not linearly
 *                                      compatible; lex-min `bundleCid`
 *                                      wins primary; both heads land
 *                                      in `conflictingHeads`.
 */
export type ConflictMergeDecision =
  | 'identical-no-op'
  | 'prefix-extension-merge'
  | 'genuinely-divergent-conflict';

/**
 * Comparator used for the §5.3 [D-conflict] lex-min tie-break. Defaults
 * to {@link compareCidV1Binary}; tests inject deterministic stubs.
 */
export type CidComparator = (a: string, b: string) => -1 | 0 | 1;

/**
 * Inputs to {@link mergeConflictingHeads}.
 *
 * `pool` and `verifiedProofs` are forwarded to {@link resolveTokenRoot}
 * verbatim. The merger does not pre-process them in any way; callers
 * pass the post-merge VIRTUAL pool that contains both prev's and next's
 * elements (the same pool the package-level merger constructs in
 * `UxfPackage.mergePkg`).
 *
 * `compareCids` is optional; when omitted, the merger uses
 * {@link compareCidV1Binary}. The parameter exists so unit tests can
 * inject a deterministic stub without parsing real CIDv1 strings.
 */
export interface MergeConflictingHeadsInput {
  /** The currently-persisted manifest entry. */
  readonly prev: TokenManifestEntry;
  /** The newly-arrived manifest entry to fold in. */
  readonly next: TokenManifestEntry;
  /**
   * Shared element pool, post-merge — must contain every element the
   * resolver needs to dereference (token-roots, transactions, inclusion
   * proofs). The §10.4 Rules 3 / 4 chain analysis runs against this map.
   */
  readonly pool: ReadonlyMap<ContentHash, UxfElement>;
  /**
   * Optional set of inclusion-proof element ContentHashes that have
   * passed `OracleProvider.verifyInclusionProof`. Wave G.3 enrichment
   * activates only when this set is non-empty AND
   * {@link resolveTokenRoot} surfaces a same-core-different-proof
   * candidate; otherwise the resolver falls back to the conservative
   * `longest-valid` outcome.
   */
  readonly verifiedProofs?: ReadonlySet<ContentHash>;
  /**
   * Optional CIDv1-binary comparator override. Default
   * {@link compareCidV1Binary}.
   */
  readonly compareCids?: CidComparator;
}

/**
 * Output of {@link mergeConflictingHeads}. The discriminator is
 * {@link ConflictMergeDecision}; the `merged` entry is what the caller
 * passes to {@link ManifestStore.upsert} as `next`. `superseded` lists
 * the rootHash(es) that were displaced by the merge — useful for
 * GC / pool-tombstone bookkeeping; empty for `'identical-no-op'`.
 */
export interface MergeConflictingHeadsResult {
  readonly decision: ConflictMergeDecision;
  /**
   * The merged manifest entry. Always references a rootHash that
   * resolves in `pool` (either the resolver's surviving chain or, in
   * the enriched case, the resolver's synthetic root, which the caller
   * MUST insert into the persistent pool before consuming the merged
   * entry — mirrors `UxfPackage.mergePkg`'s contract).
   */
  readonly merged: TokenManifestEntry;
  /**
   * Pre-merge rootHash(es) that the merge displaced. For
   * `'identical-no-op'` this is empty; for `'prefix-extension-merge'`
   * it lists the loser side's rootHash (and, in the rare enriched
   * case, the original winner's rootHash, since the synthetic root
   * displaces ALL inputs); for `'genuinely-divergent-conflict'` it is
   * empty (both heads are RETAINED via `conflictingHeads`, neither is
   * "displaced").
   */
  readonly superseded: readonly ContentHash[];
  /**
   * The Wave G.3 resolver's outcome, surfaced for the caller's
   * downstream pool-write logic. Present whenever the merger invoked
   * the resolver (i.e., NOT for `'identical-no-op'`); `null` otherwise.
   * The caller in particular uses `outcome.kind === 'enriched'` and
   * `outcome.syntheticRoot` to decide whether a synthetic token-root
   * needs to be staged into the pool before the manifest write
   * commits.
   */
  readonly resolverOutcome: ResolveOutcome | null;
}

// =============================================================================
// 2. mergeConflictingHeads — the §5.3 [D] node-3 implementation
// =============================================================================

/**
 * Decide the §5.3 [D] merge category for two manifest entries with the
 * same `tokenId` and produce a deterministic merged entry per §5.4
 * metadata-preservation rules.
 *
 * Ordering:
 *   1. Equality short-circuit — if `prev.rootHash === next.rootHash`,
 *      return `'identical-no-op'` immediately. The merged entry is
 *      `prev` with the §5.4 set-OR / max-merge applied for metadata
 *      fields (the chain-content side is identical so no [D] decision
 *      is needed).
 *   2. Otherwise invoke {@link resolveTokenRoot} with both rootHashes
 *      as candidates. The resolver's outcome dictates the branch:
 *        - `'longest-valid'`, `'enriched'`, `'single'` → linear-
 *          compatible → `'prefix-extension-merge'`. Winner is the
 *          resolver's `rootHash`; loser(s) populate `superseded`.
 *        - `'divergent'` → `'genuinely-divergent-conflict'`. The
 *          merger ignores the resolver's winner pick (it is the
 *          conservative committed-count rank, NOT the §5.3
 *          [D-conflict] lex-min `bundleCid` rule) and instead
 *          performs the lex-min comparison itself.
 *   3. Apply §5.4 metadata preservation (set-OR / max-merge) to every
 *      cross-replica field regardless of branch.
 *
 * **Why the divergent branch overrides the resolver's winner**: the
 * package-level resolver was designed for the JOIN context where no
 * `bundleCid` is available — it ranks by `committedCount`. The
 * recipient-side merger has both `prev.bundleCid` and `next.bundleCid`
 * and the protocol pins lex-min on those. Preserving the resolver's
 * pick here would break cross-device convergence: two replicas that
 * see different commit-counts on the same divergent pair would disagree
 * on the winner. The lex-min rule is the canonical override.
 *
 * **Lamport bump**: the merger does NOT bump the Lamport clock — it
 * computes the post-merge value as `max(prev.lamport, next.lamport)`
 * per §7.1 / §5.4. The {@link ManifestStore.upsert} CAS path will
 * bump the clock once it observes the merged entry (T.3.C handles
 * this).
 *
 * **No I/O guarantee**: this function calls only {@link resolveTokenRoot}
 * (pure) and {@link compareCidV1Binary} (pure). No storage, no network,
 * no oracle. The caller orchestrates re-runs of [B'] / [E] outside.
 */
export function mergeConflictingHeads(
  input: MergeConflictingHeadsInput,
): MergeConflictingHeadsResult {
  const { prev, next, pool, verifiedProofs } = input;
  const compareCids: CidComparator = input.compareCids ?? compareCidV1Binary;

  // ---------------------------------------------------------------------------
  // Step 1: equality short-circuit (identical-no-op).
  //
  // When both sides describe the same chain, no [D] decision is
  // required; only metadata-merge runs. This is the §5.6 idempotent-
  // receive case and the most common merger invocation.
  // ---------------------------------------------------------------------------
  if (prev.rootHash === next.rootHash) {
    // The chain-content sides are identical, so the chain decision is
    // a no-op — but METADATA fields (bundleCid, splitParent, status,
    // etc.) can disagree across the two sides. Pick the metadata-
    // winner side DETERMINISTICALLY and ORDER-INDEPENDENTLY (lex-min
    // bundleCid → present-beats-absent → lex-min rootHash) so that
    // replicas observing `(A, B)` and `(B, A)` produce IDENTICAL
    // merged entries. A naive `prev` pick would let bundleCid /
    // splitParent / senderTransportPubkey / status flip-flop based on
    // arrival order, breaking §5.4 cross-replica convergence.
    const metaWinnerSide = pickMetadataWinnerSide(prev, next, compareCids);
    const winnerEntry = metaWinnerSide === 'prev' ? prev : next;
    const loserEntry = metaWinnerSide === 'prev' ? next : prev;
    // Status: §5.6 monotonic invariant — if either side has been
    // marked `'invalid'` (e.g., one replica observed an off-band
    // hard-fail signal), that status MUST NOT regress on idempotent
    // receive. Same logic for `'conflicting'` (a prior conflict
    // surfaced by another sibling head we haven't merged yet stays
    // visible to the UI). `mergeStatus` is symmetric on the
    // 'invalid'/'conflicting' branches and falls back to the winner
    // side's status on ties — order-independent given a deterministic
    // winner selection above.
    const status = mergeStatus(winnerEntry.status, loserEntry.status);
    const merged = mergeMetadataPreserving(
      winnerEntry,
      loserEntry,
      // Chain-content fields: identical on both sides; either rootHash
      // works (we use prev.rootHash for byte-stability with prior
      // versions of this function).
      prev.rootHash,
      status,
      // For identical-no-op, conflictingHeads should NOT include the
      // shared rootHash (it's the primary, not a conflict).
      unionContentHashes(prev.conflictingHeads, next.conflictingHeads),
      compareCids,
    );
    return {
      decision: 'identical-no-op',
      merged,
      superseded: [],
      resolverOutcome: null,
    };
  }

  // ---------------------------------------------------------------------------
  // Step 2: invoke the Wave G.3 resolver to classify the chain pair.
  //
  // Note: we pass BOTH rootHashes as candidates; the resolver dedups
  // internally and returns `'single'` if they happen to point to the
  // same pool entry (degenerate but possible if the pool is shared
  // and prev/next disagree on hash but resolve to the same element —
  // shouldn't happen with content-addressed pools, but resolveTokenRoot
  // handles it deterministically).
  // ---------------------------------------------------------------------------
  const outcome = resolveTokenRoot({
    tokenId: '__conflict_merger__',
    candidates: [prev.rootHash, next.rootHash],
    pool,
    verifiedProofs,
  });

  // ---------------------------------------------------------------------------
  // Step 3a: divergent chain pair → genuinely-divergent-conflict.
  //
  // Override the resolver's winner pick with the §5.3 [D-conflict]
  // lex-min `bundleCid` rule. If neither side has a `bundleCid` (legacy
  // entry written before T.3.C), fall back to lex-min on `rootHash`
  // itself — deterministic and identifies the same canonical winner
  // across replicas. If only one side has a bundleCid, the side WITH
  // the bundleCid wins (forensic provenance is more recent).
  // ---------------------------------------------------------------------------
  if (outcome.kind === 'divergent') {
    const winnerSide = pickDivergentWinner(prev, next, compareCids);
    const winnerEntry = winnerSide === 'prev' ? prev : next;
    const loserEntry = winnerSide === 'prev' ? next : prev;

    // conflictingHeads = union of both sides' rootHash and any prior
    // conflictingHeads on either side. Always includes the loser's
    // rootHash. The primary (winner.rootHash) is conventionally NOT
    // re-listed in conflictingHeads — the array carries siblings, not
    // the winner.
    const heads = new Set<ContentHash>();
    heads.add(loserEntry.rootHash);
    if (prev.conflictingHeads) for (const h of prev.conflictingHeads) heads.add(h);
    if (next.conflictingHeads) for (const h of next.conflictingHeads) heads.add(h);
    // Defensive: drop the winner from the conflictingHeads if it
    // somehow ended up there via prior-state union (e.g., a prev
    // entry that listed itself as a conflictingHead — malformed but
    // handle gracefully).
    heads.delete(winnerEntry.rootHash);
    const conflictingHeads = [...heads].sort() as readonly ContentHash[];

    // Status: §5.6 monotonic invariant — when one side is already
    // `'invalid'` (e.g., a prior off-band hard-fail signal), that
    // pinned status MUST NOT regress to `'conflicting'` even when the
    // chain pair is genuinely divergent. `mergeStatus` enforces the
    // `invalid > conflicting > pending > valid` total order; for two
    // non-invalid sides on this branch the result is `'conflicting'`,
    // matching the prior hardcoded value. (Steelman fix W3.3.)
    const status = mergeStatus(
      mergeStatus(prev.status, next.status),
      'conflicting',
    );
    const merged = mergeMetadataPreserving(
      winnerEntry,
      loserEntry,
      winnerEntry.rootHash,
      status,
      conflictingHeads,
      compareCids,
    );

    return {
      decision: 'genuinely-divergent-conflict',
      merged,
      // Both heads RETAINED (in `conflictingHeads`) — neither is
      // displaced. The caller's pool-GC logic should treat this as
      // "preserve both rootHashes; do not tombstone".
      superseded: [],
      resolverOutcome: outcome,
    };
  }

  // ---------------------------------------------------------------------------
  // Step 3b: linear-compatible chain pair → prefix-extension-merge.
  //
  // Outcomes covered: `'longest-valid'`, `'enriched'`, `'single'`. The
  // resolver's `rootHash` is the canonical winner; `losers` lists the
  // displaced rootHashes. Note that for `'enriched'` the winner is a
  // synthetic token-root NOT identical to either prev or next — both
  // original heads land in `superseded` (the resolver already does this
  // for us by listing them in `losers`).
  //
  // Identify which manifest entry the winner came from. For
  // `'longest-valid'`, the winner is the longer chain — usually `next`
  // (recipient just received it) but could be `prev` if the local copy
  // is longer than the incoming one (unusual but legal). For
  // `'enriched'`, the winner is a synthetic root — neither prev nor
  // next; we conventionally treat `next` as the "freshness side" for
  // metadata purposes (its `bundleCid` / `senderTransportPubkey` are
  // newer) and use it as the metadata winner side.
  // ---------------------------------------------------------------------------
  let winnerEntry: TokenManifestEntry;
  let loserEntry: TokenManifestEntry;
  let winnerRootHash: ContentHash;

  if (outcome.kind === 'enriched') {
    // Synthetic root — neither prev nor next. The chain-content slot
    // (`winnerRootHash`) is the resolver's synthetic root, but the
    // METADATA-merge winner side must be picked DETERMINISTICALLY and
    // ORDER-INDEPENDENTLY: a naive pick of `next` produces asymmetric
    // results across replicas that received the same two manifests in
    // opposite arrival orders (replica X with `(prev=A, next=B)` and
    // replica Y with `(prev=B, next=A)` would diverge on `bundleCid`
    // / `senderTransportPubkey` / `splitParent` etc., breaking
    // cross-device convergence after gossip).
    //
    // The deterministic order-independent rule mirrors the divergent-
    // conflict tie-break (§5.3 [D-conflict]):
    //   1. Prefer side with lex-min `bundleCid` (binary CIDv1 compare).
    //   2. Side with `bundleCid` beats side without one.
    //   3. Tiebreak: lex-min `rootHash` (deterministic 64-char hex).
    // This is the canonical "metadata winner" rule for cases where the
    // resolver's chain-content winner is not one of the inputs.
    const metaWinnerSide = pickMetadataWinnerSide(prev, next, compareCids);
    winnerEntry = metaWinnerSide === 'prev' ? prev : next;
    loserEntry = metaWinnerSide === 'prev' ? next : prev;
    winnerRootHash = outcome.rootHash;
  } else if (outcome.rootHash === prev.rootHash) {
    winnerEntry = prev;
    loserEntry = next;
    winnerRootHash = prev.rootHash;
  } else if (outcome.rootHash === next.rootHash) {
    winnerEntry = next;
    loserEntry = prev;
    winnerRootHash = next.rootHash;
  } else {
    // Defensive: the resolver returned a rootHash that is neither
    // prev nor next and not a synthetic-root case. This shouldn't
    // happen — a `'single'`/`'longest-valid'` outcome MUST point at
    // one of the input candidates. Use the same deterministic
    // order-independent metadata-winner rule as the enriched branch
    // so the merger remains symmetric under input swap (otherwise a
    // naive `next`-winner pick would diverge across replicas that
    // observe the same pair in opposite order).
    const metaWinnerSide = pickMetadataWinnerSide(prev, next, compareCids);
    winnerEntry = metaWinnerSide === 'prev' ? prev : next;
    loserEntry = metaWinnerSide === 'prev' ? next : prev;
    winnerRootHash = outcome.rootHash;
  }

  // Status of the merged entry: per §5.6 monotonic invariant, an
  // existing `'invalid'` status MUST NOT regress. Otherwise take the
  // winner side's status — typically `'valid'` or `'pending'` per the
  // [E] re-run that the caller performs after merge. The caller is
  // responsible for re-running [B'] (predicate) and [E] (oracle.isSpent)
  // on the merged head; this function just carries the chain-winning
  // side's status through verbatim.
  const status: TokenManifestStatus = mergeStatus(
    winnerEntry.status,
    loserEntry.status,
  );

  // conflictingHeads: union of prior heads from BOTH sides, dedupe,
  // drop the new winner. This captures the §5.4 normative
  // "conflictingHeads is set-OR".
  const conflictingHeads = unionContentHashes(
    prev.conflictingHeads,
    next.conflictingHeads,
  );
  const filteredHeads = conflictingHeads
    ? (conflictingHeads.filter((h) => h !== winnerRootHash) as readonly ContentHash[])
    : undefined;

  const merged = mergeMetadataPreserving(
    winnerEntry,
    loserEntry,
    winnerRootHash,
    status,
    filteredHeads && filteredHeads.length > 0 ? filteredHeads : undefined,
    compareCids,
  );

  // `superseded`: every original-input rootHash that the resolver
  // displaced. For `'longest-valid'` / `'single'` this is the loser
  // entry's rootHash (the resolver's `losers` array contains the same
  // info). For `'enriched'` we ALSO list the winner-side's input root
  // (the synthetic root displaced both originals).
  const superseded: ContentHash[] = [];
  if (outcome.kind === 'enriched') {
    // Both inputs are displaced. Sort so the array shape is order-
    // independent under prev/next swap (otherwise replicas observing
    // the same pair in opposite arrival orders would emit different
    // `superseded` arrays — semantically equivalent but byte-distinct).
    const both = new Set<ContentHash>([prev.rootHash, next.rootHash]);
    for (const h of [...both].sort() as ContentHash[]) {
      superseded.push(h);
    }
  } else {
    // Pull from the resolver's `losers` array, which is already
    // de-duped against the winner. Restrict to {prev.rootHash,
    // next.rootHash} so we never list a hash neither input carried.
    const inputs = new Set<ContentHash>([prev.rootHash, next.rootHash]);
    if (outcome.kind === 'longest-valid') {
      for (const h of outcome.losers) {
        if (inputs.has(h) && h !== winnerRootHash) superseded.push(h);
      }
    }
    // 'single' — no losers; defensive no-op. 'divergent' is already
    // handled above and exits the function before reaching this branch.
  }

  return {
    decision: 'prefix-extension-merge',
    merged,
    superseded,
    resolverOutcome: outcome,
  };
}

// =============================================================================
// 3. Internal helpers — metadata-preservation rules (§5.4 normative)
// =============================================================================

/**
 * Build the post-merge manifest entry, applying the §5.4 metadata-
 * preservation rules. The chain-content fields (`rootHash`, `status`,
 * `conflictingHeads`) are passed in by the caller because the
 * decision branch already determined them; this helper only handles
 * the union / max-merge axes.
 *
 * @param winner        Side whose `bundleCid` / `senderTransportPubkey`
 *                      / `lastProofRefreshAt` we prefer when both
 *                      sides set them. Typically the chain-winning
 *                      side (per §5.4 "chain-winning side stamped them").
 * @param loser         Side whose values fall back when the winner did
 *                      not carry them.
 * @param rootHash      Pre-decided primary `rootHash` for the merged
 *                      entry.
 * @param status        Pre-decided status for the merged entry.
 * @param conflictingHeads
 *                      Pre-decided `conflictingHeads` (already deduped /
 *                      sorted) or `undefined` for "no conflict heads".
 * @param compareCids   Comparator used for `bundleCid` divergence
 *                      tie-breaking. Currently informational — not
 *                      consumed by the helper but threaded through for
 *                      future schema additions that need it.
 */
function mergeMetadataPreserving(
  winner: TokenManifestEntry,
  loser: TokenManifestEntry,
  rootHash: ContentHash,
  status: TokenManifestStatus,
  conflictingHeads: readonly ContentHash[] | undefined,
  compareCids: CidComparator,
): TokenManifestEntry {
  // splitParent — preserved-if-set; lex-min on divergence (§5.4).
  // Parameter `compareCids` is not used here; the comparison is on
  // string identifiers (see token-manifest splitParent shape) and the
  // protocol does NOT mandate binary CID compare on this axis.
  void compareCids;
  let splitParent: string | undefined;
  if (winner.splitParent === undefined) {
    splitParent = loser.splitParent;
  } else if (loser.splitParent === undefined) {
    splitParent = winner.splitParent;
  } else if (winner.splitParent === loser.splitParent) {
    splitParent = winner.splitParent;
  } else {
    // Defect: divergent splitParent. Use lex-min for deterministic
    // cross-replica convergence (§5.4 rule).
    splitParent =
      winner.splitParent < loser.splitParent
        ? winner.splitParent
        : loser.splitParent;
  }

  // audit_promoted_from — set-OR (deduplicated, lex-sorted) per §5.4.
  const auditPromotedFrom = unionStrings(
    winner.audit_promoted_from,
    loser.audit_promoted_from,
  );

  // lamport — max-merge per §7.1.
  const lamport = maxOpt(winner.lamport, loser.lamport);

  // lastProofRefreshAt — max-merge per §6.3 (most-recent-proof rule).
  const lastProofRefreshAt = maxOpt(
    winner.lastProofRefreshAt,
    loser.lastProofRefreshAt,
  );

  // bundleCid — winner first; fall back to loser.
  const bundleCid = winner.bundleCid ?? loser.bundleCid;

  // senderTransportPubkey — same precedence as bundleCid.
  const senderTransportPubkey =
    winner.senderTransportPubkey ?? loser.senderTransportPubkey;

  // invalidReason — preserve the existing reason if set on either
  // side. Per §5.6 monotonic invariant, an `'invalid'` status NEVER
  // regresses; the reason MUST be preserved alongside.
  const invalidReason = winner.invalidReason ?? loser.invalidReason;

  // Operator-override audit triple (§6.3 / §7.0, T.5.D — W30/W31/N4).
  // Sticky per §7.1: once any replica sets `overrideApplied: true`,
  // every future merge preserves it. Steelman fix W3.5 — previously
  // these fields were dropped on `mergeMetadataPreserving`, breaking
  // §6.3 cases 5/6 cross-replica convergence.
  //
  //  - `overrideApplied`   — set-OR (boolean OR; sticky `true`).
  //  - `overrideAppliedAt` — max-merge (most-recent override wall-clock).
  //  - `overrideAppliedBy` — lex-min on tie (deterministic operator
  //                          attribution when both replicas
  //                          independently authored the override).
  const overrideApplied =
    winner.overrideApplied === true || loser.overrideApplied === true
      ? true
      : undefined;
  const overrideAppliedAt = maxOpt(
    winner.overrideAppliedAt,
    loser.overrideAppliedAt,
  );
  const overrideAppliedBy = mergeOverrideBy(
    winner.overrideAppliedBy,
    loser.overrideAppliedBy,
  );

  // Assemble. Use stripUndefined to keep the on-disk shape minimal
  // (mirrors `profile/manifest-store.ts` mergeManifestEntry — entries
  // with audit_promoted_from = undefined would otherwise serialize as
  // explicit-undefined keys in some encoders).
  return stripUndefined({
    rootHash,
    status,
    conflictingHeads,
    invalidReason,
    splitParent,
    audit_promoted_from: auditPromotedFrom,
    lamport,
    lastProofRefreshAt,
    bundleCid,
    senderTransportPubkey,
    overrideApplied,
    overrideAppliedAt,
    overrideAppliedBy,
  });
}

/**
 * Pick the winner of a divergent merge per §5.3 [D-conflict] lex-min
 * rule.
 *
 * Rule order:
 *   1. If both sides carry `bundleCid`, lex-min on the binary CIDv1
 *      form (`compareCids`). The smaller bundleCid wins.
 *   2. If only one side carries `bundleCid`, that side wins (forensic
 *      provenance is preferred over its absence).
 *   3. If neither side carries `bundleCid`, fall back to lex-min on
 *      `rootHash`. ContentHash strings are 64-char lowercase hex, so
 *      JS `<` comparison IS deterministic and identical across
 *      replicas — no binary parsing required for this fallback.
 *
 * This rule order is deterministic: every replica observing the same
 * `(prev, next)` pair picks the same winner.
 */
function pickDivergentWinner(
  prev: TokenManifestEntry,
  next: TokenManifestEntry,
  compareCids: CidComparator,
): 'prev' | 'next' {
  const prevCid = prev.bundleCid;
  const nextCid = next.bundleCid;

  if (prevCid !== undefined && nextCid !== undefined) {
    const cmp = compareCids(prevCid, nextCid);
    if (cmp < 0) return 'prev';
    if (cmp > 0) return 'next';
    // Equal bundleCids on a divergent pair shouldn't happen (the
    // bundleCid IS content-addressed; identical bundleCids ⇒ identical
    // bundles ⇒ identical chains). Fall through to the next tier for
    // defense-in-depth.
  }
  if (prevCid !== undefined && nextCid === undefined) return 'prev';
  if (nextCid !== undefined && prevCid === undefined) return 'next';

  // Neither side has a bundleCid (or both bundleCids tied) — fall back
  // to lex-min on `rootHash`. ContentHash strings are 64-char lowercase
  // hex; standard `<` is deterministic and identical across replicas.
  if (prev.rootHash < next.rootHash) return 'prev';
  if (prev.rootHash > next.rootHash) return 'next';

  // Same rootHash AND same/no bundleCid (this picker is also called
  // for the identical-no-op metadata-winner pick). The two entries can
  // STILL disagree on `senderTransportPubkey`, `splitParent`,
  // `lamport`, etc. — replicas observing the same `(prev, next)` pair
  // in opposite orders MUST still produce the same merged metadata,
  // so we extend the tiebreak chain. The full chain is:
  //   bundleCid → rootHash → senderTransportPubkey → splitParent
  //     → lamport → lastProofRefreshAt
  // (present-beats-absent, then lex-min for strings, then numerical-
  // min for numbers — all deterministic, all order-independent.)
  const psp = prev.senderTransportPubkey;
  const nsp = next.senderTransportPubkey;
  if (psp !== undefined && nsp !== undefined) {
    if (psp < nsp) return 'prev';
    if (psp > nsp) return 'next';
  } else if (psp !== undefined) {
    return 'prev';
  } else if (nsp !== undefined) {
    return 'next';
  }

  const psp2 = prev.splitParent;
  const nsp2 = next.splitParent;
  if (psp2 !== undefined && nsp2 !== undefined) {
    if (psp2 < nsp2) return 'prev';
    if (psp2 > nsp2) return 'next';
  } else if (psp2 !== undefined) {
    return 'prev';
  } else if (nsp2 !== undefined) {
    return 'next';
  }

  const pl = prev.lamport;
  const nl = next.lamport;
  if (pl !== undefined && nl !== undefined) {
    if (pl < nl) return 'prev';
    if (pl > nl) return 'next';
  } else if (pl !== undefined) {
    return 'prev';
  } else if (nl !== undefined) {
    return 'next';
  }

  const pp = prev.lastProofRefreshAt;
  const np = next.lastProofRefreshAt;
  if (pp !== undefined && np !== undefined) {
    if (pp < np) return 'prev';
    if (pp > np) return 'next';
  } else if (pp !== undefined) {
    return 'prev';
  } else if (np !== undefined) {
    return 'next';
  }

  // Fully tied across every tiebreak axis we have — the two entries
  // are semantically equivalent for metadata-merge purposes (every
  // field in the projection produces the same output regardless of
  // which side we treat as winner). Return 'prev' deterministically;
  // either choice produces identical merged output.
  return 'prev';
}

/**
 * Pick the deterministic order-independent "metadata winner side"
 * between two manifest entries. Used by the prefix-extension merger
 * for the `'enriched'` outcome branch (where the chain-content winner
 * is a synthetic root not equal to either input) and the defensive
 * fallback (where the resolver returned an unrecognized rootHash).
 *
 * The rule is intentionally identical to {@link pickDivergentWinner}
 * — both contexts need the same canonical "which side's bundleCid /
 * senderTransportPubkey / splitParent should the merged entry inherit"
 * answer. Replicating the rule (rather than calling
 * {@link pickDivergentWinner} directly) keeps the two call sites
 * semantically named for the operator scanning the code; the impl is
 * shared.
 *
 * **Why this MUST be order-independent**: when replica X receives
 * `(prev=A, next=B)` and replica Y receives `(prev=B, next=A)`, both
 * MUST produce the same merged entry (by rootHash AND every metadata
 * field). A naive pick of `next` would let the bundleCid / pubkey
 * fields flip-flop based on arrival order, defeating the §5.4 cross-
 * replica convergence guarantee.
 */
function pickMetadataWinnerSide(
  prev: TokenManifestEntry,
  next: TokenManifestEntry,
  compareCids: CidComparator,
): 'prev' | 'next' {
  return pickDivergentWinner(prev, next, compareCids);
}

/**
 * Merge two statuses per the §5.6 monotonic invariant.
 *
 * **Total order (steelman fix W3.4 — associativity)**:
 *   `invalid > conflicting > pending > valid`
 *
 * The merged status is the higher-precedence of the two inputs,
 * INDEPENDENT of which side is "winner". This makes the merge a pure
 * function of the multiset `{winnerStatus, loserStatus}` and therefore
 * commutative AND associative by construction — `mergeStatus(merge(a,b), c)`
 * always equals `mergeStatus(a, merge(b,c))` for any 3-way grouping.
 *
 * Rationale per status:
 *   - `'invalid'`     — sticky per §5.6 monotonic-pin invariant (no
 *                       regression out of `_invalid` is permitted).
 *   - `'conflicting'` — surfaces the highest-severity observable status
 *                       to the UI; preserved unless dominated by `'invalid'`.
 *   - `'pending'`     — promoted over `'valid'` because it signals the
 *                       caller still has work to do (oracle finalization,
 *                       proof fetch). Demoting back to `'valid'` is the
 *                       [E] re-run's job (§5.5 step 9), not the merger's.
 *   - `'valid'`       — base case; only survives when both inputs are valid.
 *
 * **Why total-order beats winner-takes-status (W9 audit)**: the previous
 * implementation returned `winnerStatus` for the no-invalid no-conflicting
 * case. Winner selection is itself a function of bundleCid / rootHash /
 * Lamport tie-breaks, which can flip across associativity groupings.
 * `merge(merge(a-pending, b-valid), c-valid)` and `merge(a-pending,
 * merge(b-valid, c-valid))` could land different "winners" and hence
 * different statuses. The total-order rule eliminates the dependency.
 *
 * Note: this helper does NOT decide between `'valid'` and `'pending'`
 * after a merge that drops unfinalized txs — that decision lives in
 * the [E] re-run (oracle.isSpent + finalizationQueue scan) which is
 * the caller's responsibility per §5.5 step 9. The merger reflects the
 * higher-severity of the two inputs.
 */
function mergeStatus(
  winnerStatus: TokenManifestStatus,
  loserStatus: TokenManifestStatus,
): TokenManifestStatus {
  const wRank = statusRank(winnerStatus);
  const lRank = statusRank(loserStatus);
  if (wRank > lRank) return winnerStatus;
  if (lRank > wRank) return loserStatus;
  // Same-rank tie. (Wave 3 steelman) `'conflicting'` and
  // `'pending-conflicting'` share rank 2; without an explicit tie-break
  // the function would return `winnerStatus`, breaking commutativity
  // (the property tests and the cross-replica convergence guarantee).
  // Resolve by lex-min on the literal string — deterministic across
  // replicas, breaks the same way regardless of argument order.
  return winnerStatus <= loserStatus ? winnerStatus : loserStatus;
}

/**
 * Total-order rank for {@link TokenManifestStatus}: higher number = higher
 * precedence on merge. See {@link mergeStatus} for the rationale.
 *
 * (Wave 3 steelman) `'pending-conflicting'` ranks identically to
 * `'conflicting'` — the merger treats both as conflict-resolved heads
 * whose lex-min tie-break wins primary `rootHash`. Distinguishing the
 * two is the job of the worker / writer that recognizes in-flight
 * finalization and decides whether to drain the queue first.
 */
function statusRank(s: TokenManifestStatus): number {
  switch (s) {
    case 'invalid':
      return 3;
    case 'conflicting':
    case 'pending-conflicting':
      return 2;
    case 'pending':
      return 1;
    case 'valid':
      return 0;
  }
}

/**
 * Union of two `string[] | undefined` arrays, deduped and lex-sorted.
 * Returns `undefined` when both inputs are absent / empty so callers
 * can omit the field on serialization.
 */
function unionStrings(
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined,
): readonly string[] | undefined {
  const empty = (x: ReadonlyArray<string> | undefined): boolean =>
    x === undefined || x.length === 0;
  if (empty(a) && empty(b)) return undefined;
  const set = new Set<string>();
  if (a) for (const v of a) set.add(v);
  if (b) for (const v of b) set.add(v);
  return [...set].sort();
}

/**
 * Union of two `ContentHash[] | undefined` arrays, deduped and
 * lex-sorted. Mirrors {@link unionStrings} but preserves the
 * branded-string return type. Returns `undefined` when both inputs
 * are absent / empty.
 */
function unionContentHashes(
  a: ReadonlyArray<ContentHash> | undefined,
  b: ReadonlyArray<ContentHash> | undefined,
): readonly ContentHash[] | undefined {
  const empty = (x: ReadonlyArray<ContentHash> | undefined): boolean =>
    x === undefined || x.length === 0;
  if (empty(a) && empty(b)) return undefined;
  const set = new Set<ContentHash>();
  if (a) for (const v of a) set.add(v);
  if (b) for (const v of b) set.add(v);
  return [...set].sort() as readonly ContentHash[];
}

/**
 * Return `max(a, b)` for two `number | undefined` operands, or
 * `undefined` when both are absent.
 */
function maxOpt(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

/**
 * Merge two `overrideAppliedBy` operator-pubkey strings: lex-min when
 * both are set, present-beats-absent otherwise. Mirrors §7.1 Rule 2
 * tie-break on the operator pubkey field.
 */
function mergeOverrideBy(
  a: string | undefined,
  b: string | undefined,
): string | undefined {
  if (a === undefined && b === undefined) return undefined;
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a <= b ? a : b;
}

/**
 * Strip `undefined` properties from an object literal; pure / shallow.
 * Mirrors `profile/manifest-store.ts` to keep on-disk shape minimal.
 */
function stripUndefined<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

// =============================================================================
// 4. Re-exports (caller convenience)
// =============================================================================

export { compareCidV1Binary } from './limits.js';
export type { ResolveOutcome } from '../../../uxf/token-join.js';
