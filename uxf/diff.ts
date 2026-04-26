/**
 * UXF Diff and Delta Operations (WU-10)
 *
 * Implements diff and delta operations per ARCHITECTURE Section 8.5.
 *
 * - `diff(source, target)` computes the minimal delta to transform source into target.
 * - `applyDelta(pkg, delta)` mutates a package by applying a delta.
 *
 * @module uxf/diff
 */

import type {
  ContentHash,
  UxfElement,
  UxfPackageData,
  UxfDelta,
  InstanceChainEntry,
} from './types.js';
import { computeElementHash } from './hash.js';
import { UxfError } from './errors.js';

// ---------------------------------------------------------------------------
// diff()
// ---------------------------------------------------------------------------

/**
 * Compute the minimal delta between two UXF packages.
 *
 * The delta describes the changes needed to transform `source` into `target`:
 * - `addedElements`: elements in target's pool but not in source's pool.
 * - `removedElements`: element hashes in source's pool but not in target's pool.
 * - `addedTokens`: manifest entries in target but not in source, or with a
 *    different root hash.
 * - `removedTokens`: token IDs in source's manifest but not in target's.
 * - `addedChainEntries`: instance chain entries in target but not in source.
 *
 * @param source - The source (baseline) package.
 * @param target - The target package.
 * @returns The minimal delta from source to target.
 */
export function diff(source: UxfPackageData, target: UxfPackageData): UxfDelta {
  // --- Pool diff ---
  const addedElements = new Map<ContentHash, UxfElement>();
  for (const [hash, element] of target.pool) {
    if (!source.pool.has(hash)) {
      addedElements.set(hash, element);
    }
  }

  const removedElements = new Set<ContentHash>();
  for (const hash of source.pool.keys()) {
    if (!target.pool.has(hash)) {
      removedElements.add(hash);
    }
  }

  // --- Manifest diff ---
  const addedTokens = new Map<string, ContentHash>();
  for (const [tokenId, rootHash] of target.manifest.tokens) {
    const sourceRoot = source.manifest.tokens.get(tokenId);
    if (sourceRoot === undefined || sourceRoot !== rootHash) {
      addedTokens.set(tokenId, rootHash);
    }
  }

  const removedTokens = new Set<string>();
  for (const tokenId of source.manifest.tokens.keys()) {
    if (!target.manifest.tokens.has(tokenId)) {
      removedTokens.add(tokenId);
    }
  }

  // --- Instance chain diff ---
  // Steelman²⁸ critical: compare every (hash, kind) pair across the
  // chain — not just `head` and `length`. The previous shallow check
  // missed any middle-link substitution, making the diff non-lossless:
  // applying (source ∪ delta) ≠ target when intermediate links differ.
  const addedChainEntries = new Map<ContentHash, InstanceChainEntry>();
  const processedEntries = new Set<InstanceChainEntry>();

  const chainsEqual = (a: InstanceChainEntry, b: InstanceChainEntry): boolean => {
    if (a.head !== b.head) return false;
    if (a.chain.length !== b.chain.length) return false;
    for (let i = 0; i < a.chain.length; i++) {
      if (a.chain[i].hash !== b.chain[i].hash) return false;
      if (a.chain[i].kind !== b.chain[i].kind) return false;
    }
    return true;
  };

  for (const [hash, targetEntry] of target.instanceChains) {
    if (processedEntries.has(targetEntry)) {
      continue;
    }
    processedEntries.add(targetEntry);

    const sourceEntry = source.instanceChains.get(hash);
    if (!sourceEntry || !chainsEqual(sourceEntry, targetEntry)) {
      // New or changed chain entry -- add under the head hash
      addedChainEntries.set(targetEntry.head, targetEntry);
    }
  }

  return {
    addedElements,
    removedElements,
    addedTokens,
    removedTokens,
    addedChainEntries,
  };
}

// ---------------------------------------------------------------------------
// applyDelta()
// ---------------------------------------------------------------------------

/**
 * Apply a delta to a UXF package, mutating it in place.
 *
 * Operations:
 * 1. Add all `addedElements` to the pool.
 * 2. Remove all `removedElements` from the pool.
 * 3. Add/update manifest entries from `addedTokens`.
 * 4. Remove manifest entries for `removedTokens`.
 * 5. Merge instance chain entries from `addedChainEntries`.
 *
 * Edge cases are handled gracefully:
 * - addedElements that already exist in the pool are no-ops (content-addressed dedup).
 * - removedElements that don't exist in the pool are no-ops.
 *
 * @param pkg - The package to mutate.
 * @param delta - The delta to apply.
 */
export function applyDelta(pkg: UxfPackageData, delta: UxfDelta): void {
  // Cast readonly types to mutable for in-place mutation.
  // The architecture specifies that applyDelta mutates in place.
  const mutablePool = pkg.pool as Map<ContentHash, UxfElement>;
  const mutableManifestTokens = pkg.manifest.tokens as Map<string, ContentHash>;
  const mutableChains = pkg.instanceChains as Map<ContentHash, InstanceChainEntry>;

  // 1. Add elements to pool (with hash verification)
  for (const [hash, element] of delta.addedElements) {
    if (!mutablePool.has(hash)) {
      const recomputed = computeElementHash(element);
      if (recomputed !== hash) {
        throw new UxfError(
          'VERIFICATION_FAILED',
          `Delta element hash mismatch: key ${hash}, computed ${recomputed}`,
        );
      }
      mutablePool.set(hash, element);
    }
  }

  // 2. Remove elements from pool, AND prune any instance-chain entries
  // that referenced the removed hashes.
  // Steelman²⁸ critical: previously the chain index was left dangling —
  // entries kept pointing at hashes no longer in the pool. The next
  // verify() reported MISSING_ELEMENT and walkReachable silently stopped
  // at dead hashes, breaking GC and reachability analysis.
  if (delta.removedElements.size > 0) {
    const removedSet =
      delta.removedElements instanceof Set
        ? delta.removedElements
        : new Set(delta.removedElements);
    for (const hash of removedSet) {
      mutablePool.delete(hash);
    }
    // Rebuild affected chain entries with the remaining (live) links.
    const affectedChainEntries = new Set<InstanceChainEntry>();
    for (const hash of removedSet) {
      const entry = mutableChains.get(hash);
      if (entry) affectedChainEntries.add(entry);
      mutableChains.delete(hash);
    }
    for (const oldEntry of affectedChainEntries) {
      // Steelman²⁹ warning: if the chain's authored HEAD itself was
      // removed, drop the entire chain rather than silently re-electing
      // a survivor as head. Re-electing would shift "newest authored"
      // to whatever survived — a semantic change the caller did not
      // request. Removing the chain forces the caller to make any
      // re-anchoring explicit.
      if (removedSet.has(oldEntry.head)) {
        for (const link of oldEntry.chain) mutableChains.delete(link.hash);
        continue;
      }
      const remainingLinks = oldEntry.chain.filter(
        (link) => !removedSet.has(link.hash),
      );
      if (remainingLinks.length <= 1) {
        // Chain is trivial after pruning — drop all remaining mappings.
        for (const link of remainingLinks) mutableChains.delete(link.hash);
        continue;
      }
      const newEntry: InstanceChainEntry = {
        head: remainingLinks[0].hash,
        chain: remainingLinks,
      };
      for (const link of remainingLinks) mutableChains.set(link.hash, newEntry);
    }
  }

  // 3. Add/update manifest entries
  for (const [tokenId, rootHash] of delta.addedTokens) {
    mutableManifestTokens.set(tokenId, rootHash);
  }

  // 4. Remove manifest entries
  for (const tokenId of delta.removedTokens) {
    mutableManifestTokens.delete(tokenId);
  }

  // 5. Merge instance chain entries
  for (const [_hash, entry] of delta.addedChainEntries) {
    // Map all hashes in the chain to the entry
    for (const link of entry.chain) {
      mutableChains.set(link.hash, entry);
    }
  }
}
