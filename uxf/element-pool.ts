/**
 * Content-addressed element pool and garbage collection.
 *
 * The ElementPool is the canonical in-memory store for all UxfElements.
 * Elements are keyed by their SHA-256 content hash, ensuring automatic
 * deduplication: identical logical elements share a single entry.
 *
 * @module uxf/element-pool
 */

import type {
  ContentHash,
  UxfElement,
  UxfPackageData,
  InstanceChainIndex,
  InstanceChainEntry,
} from './types.js';
import { computeElementHash } from './hash.js';

// ---------------------------------------------------------------------------
// ElementPool
// ---------------------------------------------------------------------------

/**
 * Content-addressed element store.
 * All elements across all tokens share a single pool.
 */
export class ElementPool {
  /** hash -> element. The canonical store. */
  private readonly elements: Map<ContentHash, UxfElement> = new Map();

  /** Number of elements in the pool. */
  get size(): number {
    return this.elements.size;
  }

  /** Check if an element with the given hash exists. */
  has(hash: ContentHash): boolean {
    return this.elements.has(hash);
  }

  /** Get element by hash, or undefined if not present. */
  get(hash: ContentHash): UxfElement | undefined {
    return this.elements.get(hash);
  }

  /**
   * Insert an element into the pool.
   * Computes the content hash via {@link computeElementHash} and deduplicates:
   * if an element with the same hash already exists, this is a no-op.
   *
   * @returns The content hash of the element.
   */
  put(element: UxfElement): ContentHash {
    const hash = computeElementHash(element);
    if (!this.elements.has(hash)) {
      this.elements.set(hash, element);
    }
    return hash;
  }

  /**
   * Remove an element by hash.
   *
   * @returns true if the element was present and removed, false otherwise.
   */
  delete(hash: ContentHash): boolean {
    return this.elements.delete(hash);
  }

  /** Iterate all [hash, element] pairs. */
  entries(): IterableIterator<[ContentHash, UxfElement]> {
    return this.elements.entries();
  }

  /** Iterate all content hashes in the pool. */
  hashes(): IterableIterator<ContentHash> {
    return this.elements.keys();
  }

  /** Iterate all elements in the pool. */
  values(): IterableIterator<UxfElement> {
    return this.elements.values();
  }

  /**
   * Export the pool's contents as a ReadonlyMap.
   * Returns the internal Map directly (no copy) for efficient read access.
   */
  toMap(): ReadonlyMap<ContentHash, UxfElement> {
    return this.elements;
  }

  /**
   * Create an ElementPool pre-populated from a Map.
   * The entries are copied by reference (no re-hashing).
   */
  static fromMap(map: ReadonlyMap<ContentHash, UxfElement>): ElementPool {
    const pool = new ElementPool();
    for (const [hash, element] of map) {
      pool.elements.set(hash, element);
    }
    return pool;
  }
}

// ---------------------------------------------------------------------------
// DAG Reachability Walk
// ---------------------------------------------------------------------------

/**
 * Recursively walk the DAG rooted at {@link hash}, marking every reachable
 * element (including instance chain peers) into {@link reachable}.
 *
 * The walk is depth-first. If a hash has already been visited it is skipped,
 * preventing infinite loops in the presence of shared sub-DAGs.
 *
 * For each visited element:
 * 1. The hash itself is added to the reachable set.
 * 2. If the hash participates in an instance chain, ALL hashes in that chain
 *    are added to the reachable set (and their elements are walked).
 * 3. Every child reference (single hash, array of hashes, or null) is
 *    recursively walked.
 *
 * @param pool            The element pool to read from.
 * @param hash            The starting content hash.
 * @param instanceChains  The instance chain index for chain expansion.
 * @param reachable       Accumulator set -- mutated in place.
 */
export function walkReachable(
  pool: ElementPool | ReadonlyMap<ContentHash, UxfElement>,
  hash: ContentHash,
  instanceChains: InstanceChainIndex,
  reachable: Set<ContentHash>,
): void {
  if (reachable.has(hash)) {
    return;
  }
  reachable.add(hash);

  // If this hash participates in an instance chain, mark all chain members
  // as reachable and walk their elements too.
  const chainEntry: InstanceChainEntry | undefined = instanceChains.get(hash);
  if (chainEntry) {
    for (const link of chainEntry.chain) {
      if (!reachable.has(link.hash)) {
        reachable.add(link.hash);
        walkElementChildren(pool, link.hash, instanceChains, reachable);
      }
    }
  }

  // Walk the element's own children.
  walkElementChildren(pool, hash, instanceChains, reachable);
}

/**
 * Resolve an element from the pool and recursively walk its children.
 * If the element is not in the pool the walk silently stops (the element
 * may have been removed or not yet added).
 */
function walkElementChildren(
  pool: ElementPool | ReadonlyMap<ContentHash, UxfElement>,
  hash: ContentHash,
  instanceChains: InstanceChainIndex,
  reachable: Set<ContentHash>,
): void {
  const element: UxfElement | undefined =
    pool instanceof ElementPool ? pool.get(hash) : pool.get(hash);

  if (!element) {
    return;
  }

  for (const childRef of Object.values(element.children)) {
    if (childRef === null) {
      continue;
    }
    if (Array.isArray(childRef)) {
      for (const childHash of childRef as ContentHash[]) {
        walkReachable(pool, childHash, instanceChains, reachable);
      }
    } else {
      walkReachable(pool, childRef as ContentHash, instanceChains, reachable);
    }
  }
}

// ---------------------------------------------------------------------------
// Garbage Collection
// ---------------------------------------------------------------------------

/**
 * Mark-and-sweep garbage collection over a UXF package.
 *
 * 1. **Mark** -- walk from every manifest root through the full DAG
 *    (including instance chain expansions) to build the set of reachable
 *    element hashes.
 * 2. **Sweep** -- delete every element in the pool that is NOT reachable.
 * 3. **Prune** -- remove instance chain index entries whose hashes were
 *    removed.
 *
 * The function mutates `pkg.pool` and `pkg.instanceChains` in place.
 *
 * @param pkg  The package to garbage-collect. Its pool and instanceChains
 *             are mutated (cast from their Readonly types).
 * @returns The set of content hashes that were removed.
 */
export function collectGarbage(pkg: UxfPackageData): Set<ContentHash> {
  // --- 1. Build the reachable set ---
  const reachable = new Set<ContentHash>();
  for (const rootHash of pkg.manifest.tokens.values()) {
    walkReachable(pkg.pool, rootHash, pkg.instanceChains, reachable);
  }

  // --- 2. Sweep unreachable elements ---
  const removed = new Set<ContentHash>();
  // The pool is typed as ReadonlyMap in UxfPackageData, but the architecture
  // specifies that collectGarbage mutates it in place. Cast to the mutable
  // underlying Map (or ElementPool).
  const mutablePool = pkg.pool as Map<ContentHash, UxfElement> & { delete(hash: ContentHash): boolean };

  // Collect hashes to remove first (avoid mutating while iterating).
  for (const hash of pkg.pool.keys()) {
    if (!reachable.has(hash)) {
      removed.add(hash);
    }
  }

  for (const hash of removed) {
    mutablePool.delete(hash);
  }

  // --- 3. Prune instance chain index entries for removed hashes ---
  if (removed.size > 0) {
    const mutableChains = pkg.instanceChains as Map<ContentHash, InstanceChainEntry>;
    for (const hash of removed) {
      mutableChains.delete(hash);
    }
  }

  return removed;
}
