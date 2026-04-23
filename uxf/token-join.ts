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
  if (!element || element.type !== 'token-root') return null;
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
    if (!tx || tx.type !== 'transaction') continue;
    const proof = tx.children.inclusionProof;
    if (proof && typeof proof === 'string') {
      n++;
    }
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

  // Pairwise prefix analysis. For each pair, classify:
  //   - a is prefix of b (or vice versa)      → linear chain relation
  //   - neither is a prefix of the other      → divergent (double-spend)
  //
  // With >2 candidates we walk all pairs: any divergent pair forces
  // the whole tokenId into 'divergent' outcome (conservative; a more
  // sophisticated resolver could partition and pick a winner per
  // partition).
  let foundDivergent = false;
  for (let i = 0; i < infos.length; i++) {
    for (let j = i + 1; j < infos.length; j++) {
      const a = infos[i];
      const b = infos[j];
      // Identical chains with the same rootHash would have been
      // deduped by the Map; here identical txn lists with different
      // rootHashes indicates differing ancillary content (state,
      // nametags). We treat that as non-divergent but call it out
      // via the prefix-check: neither is a strict prefix, so this
      // falls into the "divergent" branch unless we handle it.
      if (a.txns.length === b.txns.length) {
        // Same length — if identical arrays, neither is a strict
        // prefix, but the chains are compatible. We still need to
        // pick one; defer to committed-count tiebreak below.
        let same = true;
        for (let k = 0; k < a.txns.length; k++) {
          if (a.txns[k] !== b.txns[k]) {
            same = false;
            break;
          }
        }
        if (!same) {
          foundDivergent = true;
        }
        continue;
      }
      if (a.txns.length < b.txns.length) {
        if (!isPrefix(a.txns, b.txns)) foundDivergent = true;
      } else {
        if (!isPrefix(b.txns, a.txns)) foundDivergent = true;
      }
    }
    if (foundDivergent) break;
  }

  // Score function for ranking: committed-tx count is primary, total
  // txn length is secondary, rootHash ascending as the final
  // deterministic tiebreak. When `foundDivergent`, all candidates
  // are siblings of one another (chain-incompatible) — we still pick
  // the one with the highest committed count so downstream code can
  // proceed, but emit `divergent` so operators can investigate.
  infos.sort((a, b) => {
    if (a.committedCount !== b.committedCount) {
      return b.committedCount - a.committedCount; // higher first
    }
    if (a.txns.length !== b.txns.length) {
      return b.txns.length - a.txns.length; // longer first
    }
    // Already lexicographic-sorted input, preserve that tiebreak.
    return a.rootHash < b.rootHash ? -1 : a.rootHash > b.rootHash ? 1 : 0;
  });
  const winner = infos[0];
  const losers = infos.slice(1).map((c) => c.rootHash);

  if (foundDivergent) {
    return { kind: 'divergent', rootHash: winner.rootHash, losers };
  }

  // Linear-chain case (one chain is a prefix of the other, or they
  // are identical). Under content-addressed transactions, identical
  // tx hashes guarantee identical committedness on the common
  // prefix — so the longer chain always has ≥ committed-tx count of
  // the shorter. The ranking above therefore picks the longest
  // compatible chain; `longest-valid` is the only reachable outcome
  // here. Rule 4 proof enrichment (synthetic root built from
  // per-element proof lifting across bundles) would re-introduce a
  // `truncated` / synthetic variant, but that requires new element
  // hashing and pool mutation and is deferred (see scope comment).
  return { kind: 'longest-valid', rootHash: winner.rootHash, losers };
}

// =============================================================================
// Test-only exports
// =============================================================================

export const __internal = {
  getTokenRootTxns,
  countCommittedTxns,
  isPrefix,
};
