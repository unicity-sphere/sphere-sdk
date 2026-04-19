/**
 * Instance Chain Management (WU-05)
 *
 * Implements instance chain operations per ARCHITECTURE Section 3.3
 * and SPECIFICATION Section 7.
 *
 * Instance chains are singly-linked lists of semantically equivalent
 * element versions, linked via the `predecessor` header field. The chain
 * index maps every hash in a chain to a shared InstanceChainEntry,
 * enabling O(1) head lookup from any point.
 *
 * @module uxf/instance-chain
 */

import type {
  ContentHash,
  UxfElement,
  UxfPackageData,
  InstanceChainEntry,
  InstanceChainIndex,
  InstanceSelectionStrategy,
  UxfInstanceKind,
} from './types.js';
import { UxfError } from './errors.js';
import { ElementPool } from './element-pool.js';
import { computeElementHash } from './hash.js';

// ---------------------------------------------------------------------------
// Mutable Index Type
// ---------------------------------------------------------------------------

/**
 * Mutable variant of InstanceChainIndex for internal use.
 * The public API uses ReadonlyMap; internally we need mutation.
 */
export type MutableInstanceChainIndex = Map<ContentHash, InstanceChainEntry>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an empty mutable instance chain index.
 */
export function createInstanceChainIndex(): MutableInstanceChainIndex {
  return new Map<ContentHash, InstanceChainEntry>();
}

// ---------------------------------------------------------------------------
// addInstance
// ---------------------------------------------------------------------------

/**
 * Append a new instance to an existing element's instance chain.
 *
 * If no chain exists yet for `originalHash`, a new chain of length 2
 * is created (original + newInstance). If a chain already exists, the
 * new instance is prepended as the new head.
 *
 * Per SPEC 7.2:
 * - Rule 1: newInstance must have the same element type as the original.
 * - Rule 2: newInstance.header.predecessor must equal the current chain head.
 * - Rule 3: newInstance.header.semantics must be >= predecessor's semantics.
 * - Rule 7: Instance chain index is updated so all hashes point to
 *   the same updated InstanceChainEntry.
 *
 * @param pool          The element pool (newInstance is inserted here).
 * @param index         Mutable instance chain index to update.
 * @param originalHash  Content hash of the original element (must be in pool).
 * @param newInstance   The new instance element to add.
 * @returns Content hash of the newly added instance.
 */
export function addInstance(
  pool: ElementPool,
  index: MutableInstanceChainIndex,
  originalHash: ContentHash,
  newInstance: UxfElement,
): ContentHash {
  // Resolve the original element from the pool.
  const originalElement = pool.get(originalHash);
  if (!originalElement) {
    throw new UxfError(
      'MISSING_ELEMENT',
      `Original element ${originalHash} not found in pool`,
    );
  }

  // Determine the current chain state.
  const existingEntry = index.get(originalHash);

  // The current head hash and element.
  const currentHeadHash = existingEntry ? existingEntry.head : originalHash;
  const currentHeadElement = pool.get(currentHeadHash);
  if (!currentHeadElement) {
    throw new UxfError(
      'MISSING_ELEMENT',
      `Current chain head ${currentHeadHash} not found in pool`,
    );
  }

  // Rule 1: Same element type.
  if (newInstance.type !== originalElement.type) {
    throw new UxfError(
      'INVALID_INSTANCE_CHAIN',
      `Type mismatch: new instance is '${newInstance.type}' but chain element is '${originalElement.type}'`,
    );
  }

  // Rule 2: predecessor must equal current head.
  if (newInstance.header.predecessor !== currentHeadHash) {
    throw new UxfError(
      'INVALID_INSTANCE_CHAIN',
      `Predecessor mismatch: new instance predecessor is '${newInstance.header.predecessor}' but current head is '${currentHeadHash}'`,
    );
  }

  // Rule 3: semantics version must be >= predecessor's.
  if (newInstance.header.semantics < currentHeadElement.header.semantics) {
    throw new UxfError(
      'INVALID_INSTANCE_CHAIN',
      `Semantics version regression: new instance has ${newInstance.header.semantics} but predecessor has ${currentHeadElement.header.semantics}`,
    );
  }

  // Insert new instance into pool.
  const newHash = pool.put(newInstance);

  // Build the updated chain entry.
  let updatedEntry: InstanceChainEntry;

  if (existingEntry) {
    // Extend existing chain: prepend new hash at the front.
    updatedEntry = {
      head: newHash,
      chain: [
        { hash: newHash, kind: newInstance.header.kind },
        ...existingEntry.chain,
      ],
    };
  } else {
    // Create new chain of length 2: [new (head), original (tail)].
    updatedEntry = {
      head: newHash,
      chain: [
        { hash: newHash, kind: newInstance.header.kind },
        { hash: originalHash, kind: originalElement.header.kind },
      ],
    };
  }

  // Update index: all hashes in the chain point to the same entry.
  for (const link of updatedEntry.chain) {
    index.set(link.hash, updatedEntry);
  }

  return newHash;
}

// ---------------------------------------------------------------------------
// selectInstance
// ---------------------------------------------------------------------------

/**
 * Select an instance from a chain according to the given strategy.
 *
 * Per SPEC 7.4:
 * - `latest`:  Return the chain head (O(1)).
 * - `original`: Return the tail (last element in chain array).
 * - `by-kind`: Walk head-to-tail for matching kind; fallback if not found.
 * - `by-representation`: Walk head-to-tail for matching representation version.
 * - `custom`: Walk head-to-tail applying predicate; fallback if not found.
 *
 * @param chainEntry  The instance chain entry to search.
 * @param strategy    The selection strategy.
 * @param pool        The element pool (needed for custom/by-representation lookups).
 * @returns Content hash of the selected instance.
 */
export function selectInstance(
  chainEntry: InstanceChainEntry,
  strategy: InstanceSelectionStrategy,
  pool: ElementPool,
): ContentHash {
  switch (strategy.type) {
    case 'latest':
      return chainEntry.head;

    case 'original':
      // The tail is the last element in the chain array (head -> ... -> original).
      return chainEntry.chain[chainEntry.chain.length - 1].hash;

    case 'by-kind': {
      for (const link of chainEntry.chain) {
        if (link.kind === strategy.kind) {
          return link.hash;
        }
      }
      // Fallback if provided.
      if (strategy.fallback) {
        return selectInstance(chainEntry, strategy.fallback, pool);
      }
      // No match, no fallback: return head.
      return chainEntry.head;
    }

    case 'by-representation': {
      for (const link of chainEntry.chain) {
        const element = pool.get(link.hash);
        if (element && element.header.representation === strategy.version) {
          return link.hash;
        }
      }
      // No match: return head.
      return chainEntry.head;
    }

    case 'custom': {
      for (const link of chainEntry.chain) {
        const element = pool.get(link.hash);
        if (element && strategy.predicate(element)) {
          return link.hash;
        }
      }
      // Fallback if provided.
      if (strategy.fallback) {
        return selectInstance(chainEntry, strategy.fallback, pool);
      }
      // No match, no fallback: return head.
      return chainEntry.head;
    }
  }
}

// ---------------------------------------------------------------------------
// resolveElement
// ---------------------------------------------------------------------------

/**
 * Resolve a content hash to its element, applying instance selection
 * if the hash participates in an instance chain.
 *
 * Per ARCHITECTURE Section 3.3:
 * 1. Check if hash is in the instance chain index.
 * 2. If found, select instance per strategy and return that element.
 * 3. If not found, return the element directly from pool.
 * 4. Throw MISSING_ELEMENT if not in pool.
 *
 * @param pool            The element pool.
 * @param hash            The content hash to resolve.
 * @param instanceChains  The instance chain index.
 * @param strategy        The instance selection strategy.
 * @returns The resolved UxfElement.
 */
export function resolveElement(
  pool: ElementPool,
  hash: ContentHash,
  instanceChains: InstanceChainIndex,
  strategy: InstanceSelectionStrategy,
): UxfElement {
  const chainEntry = instanceChains.get(hash);
  if (chainEntry) {
    const selectedHash = selectInstance(chainEntry, strategy, pool);
    const element = pool.get(selectedHash);
    if (!element) {
      throw new UxfError(
        'MISSING_ELEMENT',
        `Element ${selectedHash} not in pool`,
      );
    }
    return element;
  }

  const element = pool.get(hash);
  if (!element) {
    throw new UxfError('MISSING_ELEMENT', `Element ${hash} not in pool`);
  }
  return element;
}

// ---------------------------------------------------------------------------
// mergeInstanceChains
// ---------------------------------------------------------------------------

/**
 * Merge instance chains from a source index into a target index.
 *
 * Per Decision 6 (branching):
 * - If one chain is a prefix of the other, keep the longer chain.
 * - If chains diverge (different heads, neither is prefix), keep both
 *   heads as sibling entries in the target index.
 * - If target has no chain for the element, add the source chain.
 *
 * @param target      Mutable target index (mutated in place).
 * @param source      Source index to merge from.
 * @param targetPool  The target element pool (for element lookups).
 */
export function mergeInstanceChains(
  target: MutableInstanceChainIndex,
  source: InstanceChainIndex,
  targetPool: ElementPool,
): void {
  // Group source entries by their chain identity (all hashes in a chain
  // share the same InstanceChainEntry reference). Process each unique chain once.
  const processedChains = new Set<InstanceChainEntry>();

  for (const [_hash, sourceEntry] of source) {
    if (processedChains.has(sourceEntry)) {
      continue;
    }
    processedChains.add(sourceEntry);

    // Find the original (tail) hash of the source chain.
    const sourceTailHash = sourceEntry.chain[sourceEntry.chain.length - 1].hash;

    // Check if the target has a chain for any hash in the source chain.
    let targetEntry: InstanceChainEntry | undefined;
    for (const link of sourceEntry.chain) {
      targetEntry = target.get(link.hash);
      if (targetEntry) break;
    }

    if (!targetEntry) {
      // No overlap: add the entire source chain to target.
      for (const link of sourceEntry.chain) {
        target.set(link.hash, sourceEntry);
      }
      continue;
    }

    // Both have chains for the same element. Check prefix relationship.
    const targetHashes = new Set(targetEntry.chain.map((l) => l.hash));
    const sourceHashes = new Set(sourceEntry.chain.map((l) => l.hash));

    // Check if source is a prefix (subset) of target.
    const sourceIsPrefix = sourceEntry.chain.every((l) => targetHashes.has(l.hash));
    if (sourceIsPrefix) {
      // Target is longer or equal: keep target as-is.
      continue;
    }

    // Check if target is a prefix (subset) of source.
    const targetIsPrefix = targetEntry.chain.every((l) => sourceHashes.has(l.hash));
    if (targetIsPrefix) {
      // Source is longer: replace target with source chain.
      // First remove old target entries.
      for (const link of targetEntry.chain) {
        target.delete(link.hash);
      }
      // Add source chain entries.
      for (const link of sourceEntry.chain) {
        target.set(link.hash, sourceEntry);
      }
      continue;
    }

    // Chains diverge: add source chain entries as siblings.
    // Source hashes that are not already in target get added.
    for (const link of sourceEntry.chain) {
      if (!target.has(link.hash)) {
        target.set(link.hash, sourceEntry);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// pruneInstanceChains
// ---------------------------------------------------------------------------

/**
 * Remove entries from the instance chain index whose hashes are in
 * the removed set. If a chain's head is removed, the chain entry
 * is updated or removed entirely.
 *
 * @param index         Mutable instance chain index (mutated in place).
 * @param removedHashes Set of content hashes that have been removed from the pool.
 */
export function pruneInstanceChains(
  index: MutableInstanceChainIndex,
  removedHashes: Set<ContentHash>,
): void {
  if (removedHashes.size === 0) return;

  // Collect unique chain entries that are affected.
  const affectedChains = new Set<InstanceChainEntry>();
  for (const hash of removedHashes) {
    const entry = index.get(hash);
    if (entry) {
      affectedChains.add(entry);
    }
    // Remove the hash from the index regardless.
    index.delete(hash);
  }

  // For each affected chain, rebuild with remaining hashes.
  for (const oldEntry of affectedChains) {
    const remainingLinks = oldEntry.chain.filter(
      (link) => !removedHashes.has(link.hash),
    );

    if (remainingLinks.length <= 1) {
      // Chain is trivial or empty after pruning: remove all remaining entries.
      for (const link of remainingLinks) {
        index.delete(link.hash);
      }
      continue;
    }

    // Rebuild the chain entry with remaining links.
    const newEntry: InstanceChainEntry = {
      head: remainingLinks[0].hash,
      chain: remainingLinks,
    };

    // Update all remaining hashes to point to the new entry.
    for (const link of remainingLinks) {
      index.set(link.hash, newEntry);
    }
  }
}

// ---------------------------------------------------------------------------
// rebuildInstanceChainIndex
// ---------------------------------------------------------------------------

/**
 * Rebuild the instance chain index from scratch by scanning all elements
 * in the pool for non-null predecessor fields.
 *
 * Per SPEC 5.5: "can be rebuilt by following predecessor links."
 *
 * Algorithm:
 * 1. Scan all elements, record predecessor -> successor relationships.
 * 2. Find chain tails (elements with null predecessor that are predecessors
 *    of other elements, or elements that appear as predecessors).
 * 3. Walk from each tail to head, building chain entries.
 * 4. Map all hashes in each chain to the same entry.
 *
 * @param pool  The element pool to scan.
 * @returns A new mutable instance chain index.
 */
export function rebuildInstanceChainIndex(
  pool: ElementPool,
): MutableInstanceChainIndex {
  const index = createInstanceChainIndex();

  // Step 1: Build predecessor -> successor mapping.
  // predecessorOf maps: predecessor hash -> array of successor hashes.
  const successorOf = new Map<ContentHash, ContentHash[]>();
  // Track all hashes that appear as predecessors.
  const hasPredecessor = new Set<ContentHash>();

  for (const [hash, element] of pool.entries()) {
    if (element.header.predecessor !== null) {
      hasPredecessor.add(hash);
      const pred = element.header.predecessor;
      let successors = successorOf.get(pred);
      if (!successors) {
        successors = [];
        successorOf.set(pred, successors);
      }
      successors.push(hash);
    }
  }

  // Step 2: Find chain tails. A tail is an element with null predecessor
  // that has at least one successor (i.e., it is the original element of a chain).
  const tails: ContentHash[] = [];
  for (const [hash, element] of pool.entries()) {
    if (
      element.header.predecessor === null &&
      successorOf.has(hash)
    ) {
      tails.push(hash);
    }
  }

  // Step 3: Walk from each tail to head, building chain entries.
  for (const tailHash of tails) {
    const tailElement = pool.get(tailHash)!;

    // Walk forward from tail to head using successor links.
    // The chain array is ordered head -> ... -> tail, so we build in
    // reverse and then flip.
    const forwardChain: Array<{ hash: ContentHash; kind: UxfInstanceKind }> = [];
    const visited = new Set<ContentHash>();

    // Iterative walk from tail following successors.
    // For linear chains there is exactly one successor per node.
    // For branching chains (Decision 6), multiple successors are possible;
    // each branch produces its own chain entry.
    const walkBranch = (
      startHash: ContentHash,
      startKind: UxfInstanceKind,
      prefix: Array<{ hash: ContentHash; kind: UxfInstanceKind }>,
    ): void => {
      const chain = [...prefix, { hash: startHash, kind: startKind }];
      visited.add(startHash);

      let currentHash = startHash;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const succs = successorOf.get(currentHash);
        if (!succs || succs.length === 0) {
          // currentHash is the head of this branch.
          break;
        }

        if (succs.length === 1) {
          const nextHash = succs[0];
          if (visited.has(nextHash)) break; // cycle protection
          visited.add(nextHash);
          const nextElement = pool.get(nextHash)!;
          chain.push({ hash: nextHash, kind: nextElement.header.kind });
          currentHash = nextHash;
        } else {
          // Branch: each successor starts its own sub-chain.
          for (const nextHash of succs) {
            if (visited.has(nextHash)) continue;
            const nextElement = pool.get(nextHash)!;
            walkBranch(nextHash, nextElement.header.kind, chain);
          }
          return;
        }
      }

      // chain is ordered tail -> ... -> head. Reverse for the entry.
      const reversedChain = [...chain].reverse();
      const headHash = reversedChain[0].hash;

      const entry: InstanceChainEntry = {
        head: headHash,
        chain: reversedChain,
      };

      for (const link of reversedChain) {
        index.set(link.hash, entry);
      }
    };

    walkBranch(tailHash, tailElement.header.kind, []);
  }

  return index;
}
