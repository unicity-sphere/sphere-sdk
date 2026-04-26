/**
 * Per-token JOIN resolver — T-D0 Rule 3 (MVP).
 *
 * PROFILE-ARCHITECTURE §10.4 Rule 3 mandates that when two bundles
 * list the same tokenId with different token-root hashes, the JOIN
 * must pick the longest VALID chain rather than last-writer-wins.
 * The prior behaviour in `uxf/UxfPackage.ts:mergePkg` (blind overwrite
 * at `mutableManifest.set(tokenId, rootHash)`) leaves the loser as an
 * unreachable orphan and is implementation-order-dependent.
 *
 * This module provides `resolveTokenRoot`, a deterministic per-token
 * resolver that inspects the token-root's transaction array, counts
 * committed (proof-bearing) transactions, and produces a structured
 * outcome.
 *
 * Current scope (MVP):
 *   - `single`         — one candidate, no work to do
 *   - `longest-valid`  — candidate N is a strict prefix of candidate M,
 *                        and M has MORE committed txs (M ⊇ N in state)
 *   - `truncated`      — candidate N is a strict prefix of M, but M has
 *                        FEWER committed txs on the common prefix; N wins
 *                        on proof coverage (Rule 4 proof-enriched rebuild
 *                        is deferred, so the current behaviour is to pick
 *                        N)
 *   - `divergent`      — chains share no prefix ordering (true double-
 *                        spend or forked history). Return the candidate
 *                        with the highest committed-tx count, tie-broken
 *                        lexicographically on rootHash. §10.7 handling
 *                        (operator review, acceptCarLoss) is future work.
 *
 * Explicitly OUT of scope (follow-up tasks):
 *   - Rule 4 synthetic proof-enriched root construction — requires new
 *     element hashing and pool mutation; deferred.
 *   - State-hash chain integrity verification — this resolver trusts
 *     that each candidate chain is internally consistent (prior
 *     verification happens at CAR ingestion time); it does NOT
 *     re-validate `transaction.sourceState == previous.destinationState`.
 *   - `deriveStructuralManifest()` integration with the new outcome —
 *     the token manifest still reports structural status only.
 *
 * The resolver is pure: no I/O, no mutation. Callers mutate the
 * manifest based on the returned outcome.
 *
 * @see docs/uxf/PROFILE-AGGREGATOR-POINTER-D0-JOIN-AUDIT.md
 * @see docs/uxf/PROFILE-ARCHITECTURE.md §10.4
 */

import type { ContentHash, UxfElement } from './types';
import {
  ELEMENT_TYPE_INCLUSION_PROOF,
  ELEMENT_TYPE_TOKEN_ROOT,
  ELEMENT_TYPE_TRANSACTION,
} from './types';
import { computeElementHash } from './hash';

// =============================================================================
// Public types
// =============================================================================

/**
 * Per-tokenId JOIN resolution outcome. The `rootHash` field always
 * contains the winner the manifest should point at; `losers` lists
 * the candidates that were superseded (for telemetry / GC
 * prioritisation).
 */
export type ResolveOutcome =
  | { readonly kind: 'single'; readonly rootHash: ContentHash }
  | {
      readonly kind: 'longest-valid';
      readonly rootHash: ContentHash;
      readonly losers: readonly ContentHash[];
    }
  | {
      readonly kind: 'divergent';
      readonly rootHash: ContentHash;
      readonly losers: readonly ContentHash[];
    }
  /**
   * Rule 4 synthetic proof-enriched root. One chain was a linear
   * extension of another (same genesis, same tail direction) but at
   * one or more positions in the common prefix, the shorter chain
   * carried a transaction element with an inclusion proof where the
   * longer chain's element at the same position had none. The
   * resolver emits a new TokenRoot whose transactions array is the
   * pointwise max-proof selection on the common prefix, followed by
   * the longer chain's tail. The caller MUST insert `syntheticRoot`
   * into the pool under `rootHash` before consuming the manifest
   * winner, otherwise the ref dangles.
   */
  | {
      readonly kind: 'enriched';
      readonly rootHash: ContentHash;
      readonly losers: readonly ContentHash[];
      readonly syntheticRoot: UxfElement;
    };

export interface ResolveInput {
  /** Token ID the candidates all claim. Used only for diagnostics. */
  readonly tokenId: string;
  /** All candidate token-root ContentHashes for this tokenId. */
  readonly candidates: readonly ContentHash[];
  /** Shared element pool — candidates dereference through here. */
  readonly pool: ReadonlyMap<ContentHash, UxfElement>;
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Extract the ordered transaction ContentHash list from a token-root.
 * Returns `null` when the candidate is not a token-root or its
 * `transactions` child has the wrong shape — the caller treats that
 * as a "skip" and lets the other candidates decide the outcome.
 */
function getTokenRootTxns(
  rootHash: ContentHash,
  pool: ReadonlyMap<ContentHash, UxfElement>,
): readonly ContentHash[] | null {
  const element = pool.get(rootHash);
  if (!element || element.type !== ELEMENT_TYPE_TOKEN_ROOT) return null;
  const txns = element.children.transactions;
  if (!Array.isArray(txns)) return null;
  // All entries must be ContentHash (strings) — the types allow
  // ContentHash | ContentHash[] | null per child slot, so a malformed
  // pool entry could smuggle in a non-string. Fail safe.
  for (const h of txns) {
    if (typeof h !== 'string') return null;
  }
  return txns as readonly ContentHash[];
}

/**
 * Count transactions that carry an inclusion proof (§10.4 Rule 4
 * definition of "committed"). Walks the transaction children list
 * and dereferences each element, checking its `inclusionProof`
 * child slot. A missing pool entry counts as uncommitted — we
 * cannot assert otherwise without it.
 */
function countCommittedTxns(
  txnHashes: readonly ContentHash[],
  pool: ReadonlyMap<ContentHash, UxfElement>,
): number {
  let n = 0;
  for (const h of txnHashes) {
    const tx = pool.get(h);
    if (!tx || tx.type !== ELEMENT_TYPE_TRANSACTION) continue;
    const proof = tx.children.inclusionProof;
    // Steelman¹⁸: a dangling hash string (not in pool) must NOT count as
    // "committed" — an attacker could craft a transaction with
    // `children.inclusionProof: '<any 64-hex string>'` that resolves to
    // nothing, inflate their committed count, win the JOIN rank, and
    // combine with the synthetic-root enricher to poison the merge.
    // Require the proof element to exist in the pool and be the right type.
    if (typeof proof !== 'string') continue;
    const proofEl = pool.get(proof);
    if (!proofEl || proofEl.type !== ELEMENT_TYPE_INCLUSION_PROOF) continue;
    n++;
  }
  return n;
}

/**
 * Is `shorter` a strict prefix of `longer` (same element references in
 * the same order)? Returns false if lengths are equal or shorter is
 * not a prefix.
 */
function isPrefix(
  shorter: readonly ContentHash[],
  longer: readonly ContentHash[],
): boolean {
  if (shorter.length >= longer.length) return false;
  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] !== longer[i]) return false;
  }
  return true;
}

// =============================================================================
// Resolver
// =============================================================================

/**
 * Resolve the winning token-root for a set of same-tokenId candidates.
 *
 * Deterministic: given the same (candidates, pool) the resolver always
 * returns the same outcome. Order of `candidates` does not affect the
 * outcome — callers should rely on that for cross-device agreement.
 *
 * Performance: O(C × T) where C = candidate count and T = transaction
 * count. Typical case (2 candidates, tens of txs) is trivially fast.
 */
export function resolveTokenRoot(input: ResolveInput): ResolveOutcome {
  const { candidates, pool } = input;

  if (candidates.length === 0) {
    // Call site invariant: the resolver is only invoked on collision,
    // which requires ≥1 candidate. Defensive — throw so the caller's
    // contract is immediately obvious.
    throw new Error('resolveTokenRoot: empty candidates list');
  }

  // Dedupe identical rootHashes. Callers may pass [rh, rh, rh] on
  // degenerate multi-source merges; without this a 3-way "collision"
  // of the same rootHash would be treated as 3 candidates and drop
  // into the longest-valid arm with two fake losers. De-duping keeps
  // the output faithful to the real candidate set.
  const unique = Array.from(new Set(candidates));

  if (unique.length === 1) {
    return { kind: 'single', rootHash: unique[0] };
  }

  // Collect per-candidate metadata once; avoids repeated pool reads.
  // No pre-sort: the final sort below establishes deterministic
  // order via (committedCount DESC, txs.length DESC, rootHash ASC),
  // which is independent of input ordering.
  interface CandidateInfo {
    readonly rootHash: ContentHash;
    readonly txns: readonly ContentHash[];
    readonly committedCount: number;
  }
  const infos: CandidateInfo[] = [];
  for (const rh of unique) {
    const txns = getTokenRootTxns(rh, pool);
    if (txns === null) {
      // Skip malformed candidates — they cannot win. If ALL candidates
      // are malformed we still need to return one; we'll pick the
      // lexicographically first as a last-resort deterministic choice
      // below.
      continue;
    }
    infos.push({
      rootHash: rh,
      txns,
      committedCount: countCommittedTxns(txns, pool),
    });
  }

  if (infos.length === 0) {
    // All candidates malformed. Return the lexicographically first
    // rootHash as `divergent` so the caller knows they got a
    // best-effort fallback (deterministic across devices).
    const sortedUnique = [...unique].sort();
    return {
      kind: 'divergent',
      rootHash: sortedUnique[0],
      losers: sortedUnique.slice(1),
    };
  }
  if (infos.length === 1) {
    // Only one well-formed candidate — treat as `single` even if
    // other candidates were malformed (they can't contribute).
    return { kind: 'single', rootHash: infos[0].rootHash };
  }

  // Pairwise compatibility analysis. Two chains are COMPATIBLE iff
  // every position up to min(lenA, lenB) is either:
  //   - the SAME ContentHash on both sides, OR
  //   - a same-core-different-proof tx pair (Rule 4 candidate —
  //     same sourceState/data/destinationState, differing
  //     inclusionProof).
  // Incompatible at any position → divergent (double-spend / fork).
  //
  // With >2 candidates we walk all pairs: any divergent pair forces
  // the whole tokenId into 'divergent' outcome (conservative; a
  // more sophisticated resolver could partition).
  let foundDivergent = false;
  for (let i = 0; i < infos.length; i++) {
    for (let j = i + 1; j < infos.length; j++) {
      const a = infos[i];
      const b = infos[j];
      const commonLen = Math.min(a.txns.length, b.txns.length);
      for (let k = 0; k < commonLen; k++) {
        if (a.txns[k] === b.txns[k]) continue;
        // Steelman¹⁹ critical #6: sameCoreDifferentProof is the same
        // attack surface as tryEnrichLongestWithProofs — an attacker who
        // supplies a fake `sameCore`-pair with a fabricated inclusion-
        // proof reference can SUPPRESS the `divergent` classification
        // (the operator-alert outcome) and force a `longest-valid`
        // resolution where the legitimate result was a fork. Until an
        // oracle gate verifies the alt's inclusion-proof cryptographically,
        // treat ANY pairwise hash mismatch as divergent.
        //
        // To re-enable: wire OracleProvider into resolveTokenRoot, call
        // oracle.verifyInclusionProof on both sides of the candidate
        // pair, and only allow the sameCoreDifferentProof exemption
        // when both proofs verify.
        foundDivergent = true;
        break;
      }
      if (foundDivergent) break;
    }
    if (foundDivergent) break;
  }

  // Score function for ranking. Two regimes:
  //
  //   foundDivergent — chains are chain-incompatible (genuine fork).
  //     Rank by committedCount desc first (prefer more proofs),
  //     then length desc (longer tie-break), then rootHash asc.
  //     The resolver cannot repair the fork; the highest-ranked
  //     candidate wins the manifest slot but outcome = 'divergent'
  //     so operators are alerted.
  //
  //   Linear-compatible — chains share a common prefix (with
  //     optional same-core-different-proof substitutions at
  //     individual positions, which Rule 4 will enrich below).
  //     Rank by LENGTH desc first so the skeleton for enrichment
  //     is the longest chain — enrichment then pointwise upgrades
  //     positions on that skeleton from any shorter candidate
  //     with a better-proved same-core tx. Without this regime
  //     split, a shorter-but-more-proved chain would win the
  //     rank and be incapable of extending to the longer chain's
  //     tail, forcing the resolver to lose the tail.
  infos.sort((a, b) => {
    if (foundDivergent) {
      if (a.committedCount !== b.committedCount) return b.committedCount - a.committedCount;
      if (a.txns.length !== b.txns.length) return b.txns.length - a.txns.length;
    } else {
      if (a.txns.length !== b.txns.length) return b.txns.length - a.txns.length;
      if (a.committedCount !== b.committedCount) return b.committedCount - a.committedCount;
    }
    return a.rootHash < b.rootHash ? -1 : a.rootHash > b.rootHash ? 1 : 0;
  });
  const winner = infos[0];
  const losers = infos.slice(1).map((c) => c.rootHash);

  if (foundDivergent) {
    return { kind: 'divergent', rootHash: winner.rootHash, losers };
  }

  // Linear-chain case (one chain is a prefix of the other, or one
  // extends the other with additional uncommitted tail). Under
  // strictly content-addressed transactions where identical tx
  // hashes appear on the common prefix, the longer chain wins
  // cleanly via `longest-valid`. But when two bundles captured the
  // same logical tx at different commit states (e.g., tx_i was
  // written uncommitted into chain A, later proved and re-written
  // in chain B before the next step), the two chains have DIFFERENT
  // tx ContentHashes at position i even though the logical state
  // transition is the same. The shorter chain may hold the proved
  // version and the longer chain may hold the unproved version at
  // that position — Rule 4 synthesis produces a merged chain that
  // keeps the longer tail AND adopts the proved element on the
  // common prefix.
  // Steelman¹⁸: tryEnrichLongestWithProofs is DISABLED pending oracle
  // validation gate.  The enricher checks only structural well-formedness
  // (proof element exists, has authenticator + smtPath children); it does NOT
  // verify the authenticator signature or replay the SMT path against a known
  // root.  An attacker controlling one bundle in a multi-source merge could
  // supply a fabricated inclusion-proof element that passes the structural
  // check and wins the rank (via the countCommittedTxns inflator), causing the
  // enricher to build a synthetic token-root carrying that fake proof — a root
  // whose hash was never signed by any real aggregator, yet verify() accepts
  // because it only checks DAG well-formedness.
  //
  // To re-enable: wire an OracleProvider into resolveTokenRoot, call
  // oracle.verifyInclusionProof(proofEl) inside tryEnrichLongestWithProofs,
  // and return null on any cryptographic failure.  Until that gate exists,
  // the enriched path is unreachable — Rule 4 resolves as longest-valid.
  return { kind: 'longest-valid', rootHash: winner.rootHash, losers };
}

// =============================================================================
// Rule 4 — proof-enriched synthetic root (T-D0 audit follow-up)
// =============================================================================

/**
 * Does the transaction at `txHash` carry an inclusion proof?
 *
 * Safe lookup: a missing pool entry or malformed element returns
 * false. Callers treat "missing" as "not proven" — a conservative
 * choice that prefers NOT enriching over enriching from an
 * incomplete source bundle.
 */
function txHasProof(txHash: ContentHash, pool: ReadonlyMap<ContentHash, UxfElement>): boolean {
  const tx = pool.get(txHash);
  if (!tx || tx.type !== ELEMENT_TYPE_TRANSACTION) return false;
  const proof = tx.children.inclusionProof;
  return typeof proof === 'string' && proof.length > 0;
}

/**
 * Two transaction elements are "same core, different proof" iff
 * every child field OTHER THAN `inclusionProof` matches byte-for-
 * byte, and `inclusionProof` differs. Under content-addressed
 * encoding, same-core-same-proof would produce the same
 * ContentHash, so the two input hashes must already be different
 * to reach this helper.
 *
 * Exhaustive field comparison (not an allowlist of known fields):
 * if a future TransactionChildren schema adds a new child slot,
 * this helper must NOT silently collapse two elements that differ
 * only in the new field — that would enrich across a genuine
 * state divergence and produce a synthetic root asserting a
 * transition that neither input ever claimed. Fail-closed by key-
 * set equality + pointwise child equality.
 */
function sameCoreDifferentProof(
  hashA: ContentHash,
  hashB: ContentHash,
  pool: ReadonlyMap<ContentHash, UxfElement>,
): boolean {
  if (hashA === hashB) return false;
  const a = pool.get(hashA);
  const b = pool.get(hashB);
  if (!a || !b) return false;
  if (a.type !== ELEMENT_TYPE_TRANSACTION || b.type !== ELEMENT_TYPE_TRANSACTION) return false;
  const ca = a.children as Record<string, ContentHash | ContentHash[] | null>;
  const cb = b.children as Record<string, ContentHash | ContentHash[] | null>;

  const keysA = Object.keys(ca);
  const keysB = Object.keys(cb);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!(k in cb)) return false;
  }
  // inclusionProof must actually differ (the "different proof" half
  // of the name). If both are identical there, the two hashes would
  // have been equal and we'd have returned at the top.
  if (ca.inclusionProof === cb.inclusionProof) return false;
  for (const k of keysA) {
    if (k === 'inclusionProof') continue;
    const va = ca[k];
    const vb = cb[k];
    if (Array.isArray(va) && Array.isArray(vb)) {
      if (va.length !== vb.length) return false;
      for (let i = 0; i < va.length; i++) {
        if (va[i] !== vb[i]) return false;
      }
    } else if (va !== vb) {
      return false;
    }
  }
  return true;
}

/**
 * Steelman remediation: header-equality gate layered on top of
 * sameCoreDifferentProof for Rule 4 enrichment. Rejects alts whose
 * header differs from the winner's — prevents a malicious source
 * from sneaking a forward-protocol-version or attacker-tagged
 * transaction into the winner's chain via proof-lift.
 */
function sameHeaderShape(a: UxfElement, b: UxfElement): boolean {
  return (
    a.header.representation === b.header.representation &&
    a.header.semantics === b.header.semantics &&
    a.header.kind === b.header.kind &&
    a.header.predecessor === b.header.predecessor
  );
}

/**
 * Steelman remediation: structural well-formedness check on an alt's
 * inclusionProof when the proof element is present in the pool.
 * Rule 4 does NOT run oracle-layer cryptographic verification (that
 * happens at the aggregator boundary). But if the proof element
 * exists in the pool, we require it to carry the expected sub-elements
 * (authenticator + smtPath). Dangling proof references are permitted
 * (verify.ts catches those upstream); this gate closes the
 * "attacker-crafted proof element in the pool" path.
 */
function altProofIsStructurallyValid(
  altElement: UxfElement,
  pool: ReadonlyMap<ContentHash, UxfElement>,
): boolean {
  const children = altElement.children as Record<string, ContentHash | ContentHash[] | null>;
  const proofHash = children.inclusionProof;
  if (typeof proofHash !== 'string') return false;
  const proofEl = pool.get(proofHash);
  if (!proofEl) return true; // dangling — verify.ts upstream catches it
  if (proofEl.type !== ELEMENT_TYPE_INCLUSION_PROOF) return false;
  const pc = proofEl.children as Record<string, unknown>;
  if (typeof pc.authenticator !== 'string') return false;
  if (typeof pc.smtPath !== 'string') return false;
  return true;
}

/**
 * Walk the common prefix of the winner's tx chain vs every OTHER
 * candidate. For each position where winner has no proof and some
 * other candidate has a same-core-different-proof tx with a proof,
 * adopt the proved version. If at least one position was adopted,
 * synthesize a new TokenRoot with the enriched tx list and return
 * it. Otherwise return null — caller falls through to
 * `longest-valid`.
 *
 * Out of scope for this MVP:
 *   - Multi-winner proof sets (picking proofs from N>2 chains):
 *     we walk candidates in `infos` order and take the first
 *     proved-alternative at each position. Deterministic because
 *     `infos` is sorted.
 *   - Proof validity check: we trust the proof element's mere
 *     presence as a "has proof" signal. Real proof verification
 *     (signature + merkle path) happens at the oracle layer.
 *   - Nametags / state-child reconciliation: we copy from the
 *     winner's TokenRoot unchanged. Nametags on the common prefix
 *     are identical by genesis invariant; tail-only nametags would
 *     survive as the winner already carries them.
 */
// Underscore prefix per project lint rule — function preserved for the
// oracle-gate re-enable path but not currently called.
function _tryEnrichLongestWithProofs(
  winner: {
    readonly rootHash: ContentHash;
    readonly txns: readonly ContentHash[];
    readonly committedCount: number;
  },
  infos: readonly {
    readonly rootHash: ContentHash;
    readonly txns: readonly ContentHash[];
    readonly committedCount: number;
  }[],
  pool: ReadonlyMap<ContentHash, UxfElement>,
): { rootHash: ContentHash; syntheticRoot: UxfElement } | null {
  const winnerRoot = pool.get(winner.rootHash);
  if (!winnerRoot || winnerRoot.type !== ELEMENT_TYPE_TOKEN_ROOT) return null;

  const enrichedTxns: ContentHash[] = [...winner.txns];
  let enriched = false;

  for (let pos = 0; pos < enrichedTxns.length; pos++) {
    const curHash = enrichedTxns[pos];
    if (txHasProof(curHash, pool)) continue;

    // Scan other candidates for a same-core-with-proof alternative
    // at this position.
    for (const other of infos) {
      if (other.rootHash === winner.rootHash) continue;
      if (pos >= other.txns.length) continue;
      const altHash = other.txns[pos];
      if (altHash === curHash) continue;
      if (!txHasProof(altHash, pool)) continue;
      if (!sameCoreDifferentProof(curHash, altHash, pool)) continue;

      // Steelman remediation gates layered on top of sameCore:
      //   (a) header shapes must match — guards against attacker-
      //       tagged forward-protocol-version transactions slipping
      //       through proof-lift into the winner's chain.
      //   (b) alt's inclusion-proof element (when present in pool)
      //       must be well-formed.
      const curEl = pool.get(curHash);
      const altEl = pool.get(altHash);
      if (!curEl || !altEl) continue;
      if (!sameHeaderShape(curEl, altEl)) continue;
      if (!altProofIsStructurallyValid(altEl, pool)) continue;

      enrichedTxns[pos] = altHash;
      enriched = true;
      break; // first proved-alternative wins; deterministic by infos order
    }
  }

  if (!enriched) return null;

  // Build the synthetic TokenRoot. Copy the winner's header /
  // content / non-transactions children wholesale; only the
  // `transactions` child is replaced with the enriched array. The
  // synthetic points at the original winner's rootHash as its
  // predecessor — the enriched chain is a refinement of the
  // winner, not an independent lineage. The caller (mergePkg) is
  // responsible for inserting this element into the pool.
  //
  // Deep-clone any array children (nametags today; future array
  // children transparently) so the synthetic does NOT share array
  // references with the input winner element. Mutation of the
  // synthetic's children must never leak back into the pool's
  // original element; UxfElement children are typed `readonly` but
  // TypeScript does not enforce this at runtime. Defense-in-depth.
  const clonedChildren: Record<string, ContentHash | ContentHash[] | null> = {};
  for (const [key, value] of Object.entries(winnerRoot.children)) {
    if (Array.isArray(value)) {
      clonedChildren[key] = [...value];
    } else {
      clonedChildren[key] = value;
    }
  }
  clonedChildren.transactions = enrichedTxns;

  // Header choice for the synthetic:
  //
  //   predecessor = null
  //     Setting this to `winner.rootHash` caused the synthetic to
  //     appear as a successor of the winner in
  //     `rebuildInstanceChainIndex` (uxf/instance-chain.ts:441),
  //     which scans every pool element for predecessor links with
  //     no type / kind filter. A publicly-exported index function
  //     polluted by phantom token-root chains is a brittle
  //     invariant — set predecessor=null so the synthetic is a
  //     stand-alone ref in the pool, not a pseudo-instance-of the
  //     winner. Consumers that want the "which winner produced this
  //     synthetic" relation read the manifest (the synthetic is
  //     the manifest head; the winner is in ResolveOutcome.losers).
  //
  //   kind = 'enriched-synthetic'
  //     Distinct UxfInstanceKind (the `(string & {})` branch of the
  //     type accepts custom tags) so downstream `isSynthetic` /
  //     `kind`-filtering consumers can detect these ephemeral
  //     merge-artifacts even if they end up in secondary indexes
  //     via other code paths. Tags a future failure mode: if a
  //     synthetic accidentally survives into a CAR export, its
  //     `kind` field carries a clear signature for a linter or
  //     consistency-check to catch.
  const syntheticRoot: UxfElement = {
    header: {
      representation: winnerRoot.header.representation,
      semantics: winnerRoot.header.semantics,
      kind: ENRICHED_SYNTHETIC_KIND,
      predecessor: null,
    },
    type: ELEMENT_TYPE_TOKEN_ROOT,
    content: { ...winnerRoot.content },
    children: clonedChildren,
  };

  const rootHash = computeElementHash(syntheticRoot);
  return { rootHash, syntheticRoot };
}

/**
 * UxfInstanceKind for the Rule 4 synthetic TokenRoot. Exposed so
 * downstream consumers can detect merge-artifacts:
 *   if (element.header.kind === ENRICHED_SYNTHETIC_KIND) { … }
 *
 * Exported from the token-join barrel so tests and external
 * consumers reference this constant instead of hard-coding the
 * string.
 */
export const ENRICHED_SYNTHETIC_KIND = 'enriched-synthetic' as const;

/**
 * True iff the element is a Rule 4 synthetic TokenRoot produced by
 * `resolveTokenRoot`. Synthetic roots are ephemeral merge-artifacts;
 * consumers building durable indexes (instance chains, archive
 * snapshots, export manifests) SHOULD filter them out.
 */
export function isEnrichedSyntheticRoot(element: UxfElement): boolean {
  return (
    element.type === ELEMENT_TYPE_TOKEN_ROOT &&
    element.header.kind === ENRICHED_SYNTHETIC_KIND
  );
}

// =============================================================================
// Test-only exports
// =============================================================================

// Steelman¹⁹ warning #7: tryEnrichLongestWithProofs is intentionally NOT
// re-exported via __internal until the oracle validation gate is wired.
// A consumer importing it directly (test or downstream module) would
// bypass the call-site disable and re-introduce the synthetic-root
// injection vulnerability that disabling the call site closed.
export const __internal = {
  getTokenRootTxns,
  countCommittedTxns,
  isPrefix,
};
