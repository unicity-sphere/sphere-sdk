/**
 * Token Manifest Derivation
 *
 * Derives the **wallet-level token manifest** from a joined UxfPackage.
 *
 * Per PROFILE-ARCHITECTURE.md §10.2.2, two kinds of "manifest" exist:
 *
 *  - **Bundle manifest** (package-level, STORED in CAR) — a flat
 *    `tokenId → rootHash` map that describes the DAG shape of a single
 *    bundle. Defined in UXF SPECIFICATION.md §5.4 and lives as
 *    `UxfManifest` in `uxf/types.ts`.
 *
 *  - **Token manifest** (wallet-level, DERIVED, never stored) — carries
 *    the same mapping but augmented with per-token **status** derived
 *    from chain validation, conflict detection, and (eventually) oracle
 *    spent-checks. This module produces that artifact.
 *
 * This initial implementation provides the structural subset of the
 * algorithm in §10.6: chain integrity + conflict detection + pending
 * detection. Oracle-based status (`spent`, `double-spend`, etc.) is a
 * future enhancement that layers on top by post-processing these
 * entries against the aggregator.
 *
 * The separation matters: the structural pass is synchronous and pure;
 * the oracle pass is async and network-dependent. Callers that need
 * only the structural view (e.g. UI that doesn't want to wait for
 * oracle latency) can use this directly.
 *
 * @module profile/token-manifest
 */

import type { UxfPackage } from '../bundle/UxfPackage.js';
import type {
  ContentHash,
  InstanceChainEntry,
  UxfPackageData,
} from '../bundle/types.js';

// =============================================================================
// Public types
// =============================================================================

/**
 * Token status categories.
 *
 * - `valid`        — single chain, every transaction has an inclusion proof.
 * - `pending`      — single chain, last transaction has no proof yet.
 * - `conflicting`  — two or more divergent instance chains exist for this
 *                    token (sibling heads in the instance-chain index).
 *                    Oracle resolution is required to determine the winner.
 * - `invalid`      — chain is structurally broken (not yet detected in
 *                    this implementation; reserved for future use).
 * - `pending-conflicting` (Wave 3 steelman) — a conflicting head arrived
 *                    while the existing entry was already in `pending`
 *                    state with an in-flight finalization worker tracking
 *                    its queue entries. The fresh CONFLICTING write
 *                    cannot blindly clobber the pending state because
 *                    the worker would continue finalizing the previous
 *                    chain (rootHash X) while the manifest now declares
 *                    a different head (rootHash Y) authoritative — when
 *                    the worker's proofs land, it would write against
 *                    a stale view. `pending-conflicting` defers the
 *                    full conflict-merge until the worker drains its
 *                    queue (or its caller invalidates the entries
 *                    explicitly); downstream conflict-merger code
 *                    treats `pending-conflicting` like `conflicting`
 *                    for read purposes (both heads are surfaced) but
 *                    the manifest writer / worker reconciliation path
 *                    can recognize the in-flight finalization and avoid
 *                    the data race.
 */
export type TokenManifestStatus =
  | 'valid'
  | 'pending'
  | 'conflicting'
  | 'pending-conflicting'
  | 'invalid';

export interface TokenManifestEntry {
  /**
   * Bundle-manifest root hash for this token (the genesis / token-root
   * content hash from the UXF manifest). Used for DAG traversal.
   */
  readonly rootHash: ContentHash;
  /** Status derived from chain integrity and conflict analysis. */
  readonly status: TokenManifestStatus;
  /**
   * When `status === 'conflicting'`, the set of distinct chain-head
   * hashes found in the instance-chain index for this token. Length
   * is always ≥ 2 when populated. Ordering is sorted ascending for
   * determinism across platforms.
   *
   * Without oracle data we cannot distinguish winner from loser, so
   * all heads are listed symmetrically. The oracle-integration layer
   * will downgrade this field to the "losers" once the authoritative
   * winner is known.
   */
  readonly conflictingHeads?: readonly ContentHash[];
  /**
   * Optional human-readable reason when `status === 'invalid'`.
   * Reserved for future use by the oracle-integration layer. PA §10.11
   * narrows this to a `DispositionReason` from `types/disposition.ts`
   * — typed as `string` here to avoid a circular module dependency.
   */
  readonly invalidReason?: string;
  // ---------------------------------------------------------------------------
  // Cross-replica merge metadata (T.3.C — PA §10.11 / §5.4 normative
  // metadata-preservation rules)
  //
  // All five fields are optional so unaugmented entries from earlier waves
  // round-trip safely. They are populated by the disposition writer / manifest
  // store on first write and merged set-OR / max-merge by the manifest store
  // on every subsequent §5.3 [D] resolve. See `profile/manifest-store.ts`.
  // ---------------------------------------------------------------------------
  /**
   * Coin-split parent reference for §6.1.1 cascade detection. Set by the
   * sender-side splitter when a coin token is minted as the change /
   * recipient output of a `TokenSplitBuilder` operation. Absent on
   * non-split tokens and on every NFT (NFTs are not splittable).
   */
  readonly splitParent?: string;
  /**
   * Set-OR back-reference to the `_audit` collection record(s) this
   * manifest entry was promoted from. Each element is an audit record
   * key of the form `${addr}.audit.${tokenId}.${observedTokenContentHash}`.
   *
   * **Array form** (per §5.4 normative array-merge rule, round-9 user
   * clarification): widening from `string | undefined` to
   * `readonly string[] | undefined` allows multiple audit records to
   * promote to the same canonical manifest entry — divergent audit
   * histories across replicas legitimately produce a multi-entry array
   * and ALL entries are preserved on merge for forensic traceability.
   * Single-element arrays are used when there is only one promotion.
   */
  readonly audit_promoted_from?: readonly string[];
  /**
   * Lamport logical clock (§7.1 invariants). Incremented on every local
   * write per `Lamport.bumpFor`. On §5.3 [D] merge, the post-merge
   * Lamport is `max(left.lamport, right.lamport)` (`Lamport.merge`).
   * Optional for migration safety — entries written before T.3.C did
   * not carry a Lamport; readers treat absent as 0.
   */
  readonly lamport?: number;
  /**
   * Wall-clock millisecond timestamp of the most-recent inclusion-proof
   * refresh that touched this entry (per §6.3 most-recent-proof rule).
   * Used by the §5.3 [D] grafting path to prefer the side with the
   * fresher proof material when both sides are otherwise identical.
   */
  readonly lastProofRefreshAt?: number;
  /**
   * CIDv1 (base32) of the bundle whose §5.3 walk produced this manifest
   * entry. Stored for forensic provenance and as the lex-min tie-break
   * input to `compareCidV1Binary` (per §5.3 [D-conflict]).
   */
  readonly bundleCid?: string;
  /**
   * Sender's transport pubkey (64-hex secp256k1 x-coordinate from the
   * Nostr signing key) of the bundle that produced this entry. Forensic
   * peer attribution; mirrors the `_invalid` / `_audit` records.
   */
  readonly senderTransportPubkey?: string;
  // ---------------------------------------------------------------------------
  // Operator override audit trail (T.5.D — W30 / W31 / N4)
  //
  // Set by `payments.importInclusionProof({ allowInvalidOverride: true })`
  // (§6.3 cases 5/6 — the operator-explicit reversal of the §5.6
  // monotonicity invariant). The override flag is sticky across CRDT merges
  // (set-OR for the boolean; max-merge for the timestamp; lex-min tie-break
  // for the operator pubkey when both sides set it). Once set on any
  // replica, the flag persists through every future merge so a wallet that
  // has performed an operator override keeps the override even when a
  // remote replica's lamport runs ahead.
  //
  // The pair `(overrideAppliedAt, overrideAppliedBy)` is the durable audit
  // trail surfaced to the operator console alongside the
  // `transfer:override-applied` event.
  // ---------------------------------------------------------------------------
  /**
   * `true` iff this entry has been re-validated via an operator
   * `importInclusionProof({ allowInvalidOverride: true })` call. Sticky:
   * once set on any replica, the merged entry retains it (set-OR per §7.1).
   */
  readonly overrideApplied?: boolean;
  /**
   * Wall-clock millisecond timestamp of the most-recent override write
   * (`Date.now()` at the call site). When two replicas independently apply
   * the override, the merged entry takes the later timestamp (max-merge —
   * mirrors the `lastProofRefreshAt` rule).
   */
  readonly overrideAppliedAt?: number;
  /**
   * Operator pubkey (hex; the wallet's chain pubkey at override time) that
   * authored the override. When two replicas independently apply the
   * override, the merged entry preserves the lex-min pubkey (deterministic
   * across replicas without requiring a coordinator). Optional — callers
   * that do not pass an operator pubkey leave the field absent.
   */
  readonly overrideAppliedBy?: string;
}

/**
 * A wallet-level token manifest: `tokenId → TokenManifestEntry`.
 */
export type TokenManifest = Map<string, TokenManifestEntry>;

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Collect all distinct chain heads that share ancestry with the chain
 * rooted at `startHash`.
 *
 * After `mergeInstanceChains()` processes divergent bundles, sibling
 * chains share a common prefix back to the genesis/tail element but
 * have distinct `head` values. Sibling detection must be **anchored
 * to the chain tail**, not to arbitrary overlap: two chains belonging
 * to the same token always share their tail hash, whereas two chains
 * belonging to DIFFERENT tokens that happen to share a mid-chain
 * element (e.g. a shared predicate or mint-batch state) must NOT be
 * treated as siblings. Tail equality as the anchor prevents cross-token
 * mis-attribution.
 *
 * Cost: O(distinctEntries). For typical bundle counts (handful per
 * wallet) this is negligible.
 */
function collectHeads(
  pkg: UxfPackageData,
  startHash: ContentHash,
): Set<ContentHash> {
  const heads = new Set<ContentHash>();

  const seed = pkg.instanceChains.get(startHash);
  if (!seed) {
    // No chain was ever established for this element — the manifest
    // root IS the head by definition.
    heads.add(startHash);
    return heads;
  }

  // Tail = the genesis/original element that every sibling chain of
  // this token must share. InstanceChainEntry.chain is ordered
  // head → … → original, so the last element is the tail.
  const primaryTail = seed.chain[seed.chain.length - 1]?.hash;

  // Enumerate every distinct InstanceChainEntry in the index. The index
  // is a Map from hash → entry, and multiple hashes map to the same
  // entry, so we dedup by reference identity.
  const uniqueEntries = new Set<InstanceChainEntry>();
  for (const entry of pkg.instanceChains.values()) {
    uniqueEntries.add(entry);
  }

  for (const entry of uniqueEntries) {
    // Tail-anchored: an entry belongs to this token's conflict set if
    // and only if its chain tail matches the primary chain's tail.
    // This rejects cross-token overlap via shared mid-chain elements.
    const tail = entry.chain[entry.chain.length - 1]?.hash;
    if (tail === primaryTail) heads.add(entry.head);
  }

  // Edge case: if somehow no heads were collected, fall back to the
  // seed's head so the caller always gets a definite root.
  if (heads.size === 0) heads.add(seed.head);
  return heads;
}

/**
 * Decide the structural status of a single token given the set of heads
 * reachable from its manifest root.
 *
 * If multiple distinct heads exist → `conflicting` plus the non-primary
 * heads as `conflictingRoots`.
 *
 * Otherwise we walk the chain and check whether every link carries its
 * inclusion proof (pending vs valid). Proof presence is signalled by
 * the element's payload — we don't crack open payloads here; that's a
 * higher-layer concern. So at this level a single-head chain is
 * reported as `valid`, and `pending` status is reserved for the
 * oracle-aware pass.
 *
 * This asymmetry is intentional: structural detection is conservative.
 * The oracle layer is the authoritative source of pending vs valid.
 */
function classifyToken(
  heads: Set<ContentHash>,
  rootHash: ContentHash,
): TokenManifestEntry {
  if (heads.size <= 1) {
    return { rootHash, status: 'valid' };
  }

  // Deterministic ordering so cross-platform comparisons work.
  const sorted = [...heads].sort();
  return {
    rootHash,
    status: 'conflicting',
    conflictingHeads: sorted,
  };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Derive a **structural** token manifest from a UxfPackage. This does
 * NOT query the oracle — status values are limited to `valid` and
 * `conflicting` based on the instance-chain topology. `pending` and
 * `invalid` require oracle or payload-level inspection and are produced
 * by a higher layer (future PR).
 *
 * Primary rootHash selection: for each tokenId, the UXF bundle
 * manifest already picks a single head. We honour that choice and
 * record any sibling heads as `conflictingRoots`.
 */
export function deriveStructuralManifest(pkg: UxfPackage): TokenManifest {
  const manifest: TokenManifest = new Map();
  const data: UxfPackageData = (pkg as unknown as { data: UxfPackageData }).data;

  for (const tokenId of pkg.tokenIds()) {
    const rootHash = data.manifest.tokens.get(tokenId);
    if (!rootHash) continue;

    const heads = collectHeads(data, rootHash);
    manifest.set(tokenId, classifyToken(heads, rootHash));
  }

  return manifest;
}

/**
 * Predicate: does the given status represent a token with multiple
 * observed chain heads (i.e. a conflict that the operator should see)?
 *
 * Returns `true` for both `'conflicting'` (post-merge, fully-resolved
 * conflict) AND `'pending-conflicting'` (Wave 3 steelman — conflict
 * detected while a finalization worker was still draining the prior
 * pending head). UI / visibility consumers MUST treat the two
 * symmetrically: from the operator's perspective both indicate "two or
 * more heads exist, oracle resolution / queue drain pending".
 *
 * Worker-drain logic and writer paths that need to distinguish between
 * "conflict-merge can run now" and "wait for the worker first" must
 * still switch on the literal status (see
 * `modules/payments/transfer/disposition-engine.ts`).
 *
 * @param s — a `TokenManifestStatus` value.
 * @returns `true` iff `s ∈ {'conflicting', 'pending-conflicting'}`.
 */
export function isConflictingStatus(s: TokenManifestStatus): boolean {
  return s === 'conflicting' || s === 'pending-conflicting';
}

/**
 * Return just the tokenIds with a conflicting status — that includes
 * BOTH `'conflicting'` (resolved-conflict head) and `'pending-conflicting'`
 * (in-flight-finalization conflict, Wave 3 steelman). Convenience for
 * UI "show me conflicts" views and for alerting.
 *
 * The pending-conflicting case is included so that operators see EVERY
 * token whose head set is ambiguous, regardless of whether the
 * conflict-merger has had a chance to run yet. Hiding pending-conflicting
 * tokens here would silently mask conflicts that haven't yet been
 * promoted to the canonical `'conflicting'` status — exactly the class
 * of conflict the operator most needs to know about (a worker is still
 * working on a head we now suspect is wrong).
 */
export function conflictingTokenIds(manifest: TokenManifest): string[] {
  const out: string[] = [];
  for (const [tokenId, entry] of manifest) {
    if (isConflictingStatus(entry.status)) out.push(tokenId);
  }
  return out;
}
