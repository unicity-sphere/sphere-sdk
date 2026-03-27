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
  // Find chain entries in target that are not in source (by hash key).
  // We compare by checking if the source has the same hash with the same
  // head and chain length. If not, it is a new or changed entry.
  const addedChainEntries = new Map<ContentHash, InstanceChainEntry>();
  const processedEntries = new Set<InstanceChainEntry>();

  for (const [hash, targetEntry] of target.instanceChains) {
    if (processedEntries.has(targetEntry)) {
      continue;
    }
    processedEntries.add(targetEntry);

    const sourceEntry = source.instanceChains.get(hash);
    if (!sourceEntry || sourceEntry.head !== targetEntry.head ||
        sourceEntry.chain.length !== targetEntry.chain.length) {
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

  // 1. Add elements to pool
  for (const [hash, element] of delta.addedElements) {
    if (!mutablePool.has(hash)) {
      mutablePool.set(hash, element);
    }
  }

  // 2. Remove elements from pool
  for (const hash of delta.removedElements) {
    mutablePool.delete(hash);
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
