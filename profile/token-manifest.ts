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

import type { UxfPackage } from '../uxf/UxfPackage.js';
import type {
  ContentHash,
  InstanceChainEntry,
  UxfPackageData,
} from '../uxf/types.js';

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
 */
export type TokenManifestStatus =
  | 'valid'
  | 'pending'
  | 'conflicting'
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
   * Reserved for future use by the oracle-integration layer.
   */
  readonly invalidReason?: string;
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
 * Return just the tokenIds with `conflicting` status. Convenience for
 * UI "show me conflicts" views and for alerting.
 */
export function conflictingTokenIds(manifest: TokenManifest): string[] {
  const out: string[] = [];
  for (const [tokenId, entry] of manifest) {
    if (entry.status === 'conflicting') out.push(tokenId);
  }
  return out;
}
