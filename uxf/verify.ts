/**
 * UXF Package Verification (WU-09)
 *
 * Implements structural integrity verification per ARCHITECTURE Section 8.4
 * and SPECIFICATION Section 7.3.
 *
 * Checks performed:
 * 1. Manifest root existence in pool
 * 2. Child reference resolution (all refs point to existing pool entries)
 * 3. Content hash integrity (re-hash every element, compare to pool key)
 * 4. DAG cycle detection (track visited during traversal per token subgraph)
 * 5. Instance chain validation (type consistency, linear sequence, predecessor linkage)
 * 6. Orphaned element detection (warning, not error)
 *
 * @module uxf/verify
 */

import type {
  ContentHash,
  UxfElement,
  UxfPackageData,
  UxfVerificationResult,
  UxfVerificationIssue,
  InstanceChainEntry,
} from './types.js';
import { computeElementHash } from './hash.js';
import { encode as dagCborEncode } from '@ipld/dag-cbor';
import { VERIFY_MAX_ELEMENT_BYTES } from './limits.js';

// ---------------------------------------------------------------------------
// Expected child element types (for type consistency checks)
// ---------------------------------------------------------------------------

/**
 * Maps parent element type + child role to expected child element type.
 * Used for element type consistency validation during DAG walk.
 */
const EXPECTED_CHILD_TYPES: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  'token-root': {
    genesis: 'genesis',
    state: 'token-state',
    // transactions -> 'transaction', nametags -> 'token-root' (handled in array)
  },
  genesis: {
    data: 'genesis-data',
    inclusionProof: 'inclusion-proof',
    destinationState: 'token-state',
  },
  transaction: {
    sourceState: 'token-state',
    data: 'transaction-data',
    inclusionProof: 'inclusion-proof',
    destinationState: 'token-state',
  },
  'inclusion-proof': {
    authenticator: 'authenticator',
    merkleTreePath: 'smt-path',
    unicityCertificate: 'unicity-certificate',
  },
};

/**
 * Maps parent element type + array child role to expected child element type.
 */
const EXPECTED_ARRAY_CHILD_TYPES: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  'token-root': {
    transactions: 'transaction',
    nametags: 'token-root',
  },
};

// ---------------------------------------------------------------------------
// verify()
// ---------------------------------------------------------------------------

/**
 * Verify structural integrity of a UXF package.
 *
 * Performs comprehensive checks on the package structure and returns
 * a result with errors, warnings, and statistics. The package is
 * considered valid if there are zero errors.
 *
 * @param pkg - The UXF package to verify.
 * @returns Verification result with errors, warnings, and stats.
 */
export function verify(pkg: UxfPackageData): UxfVerificationResult {
  const errors: UxfVerificationIssue[] = [];
  const warnings: UxfVerificationIssue[] = [];
  const elementsChecked = new Set<ContentHash>();
  let instanceChainsChecked = 0;

  // -----------------------------------------------------------------------
  // Check 3: Content hash integrity for ALL elements in pool
  //
  // Steelman²⁸ warning: cap the maximum pool size to prevent a 1M-entry
  // bloat-DoS. Verifying every element re-hashes it; without a cap a
  // hostile package can force 1M SHA-256 calls. The 1_000_000 cap is
  // far above any legitimate package and well below the 5–10s budget.
  // -----------------------------------------------------------------------
  const VERIFY_MAX_POOL_SIZE = 1_000_000;
  if (pkg.pool.size > VERIFY_MAX_POOL_SIZE) {
    errors.push({
      code: 'INVALID_PACKAGE',
      message: `Pool size ${pkg.pool.size} exceeds VERIFY_MAX_POOL_SIZE=${VERIFY_MAX_POOL_SIZE} — refusing to verify (bloat-DoS protection).`,
    });
    return {
      valid: false,
      errors,
      warnings,
      stats: {
        tokensChecked: 0,
        elementsChecked: 0,
        orphanedElements: 0,
        instanceChainsChecked: 0,
      },
    };
  }
  // Steelman Wave 3 warning: per-element BYTE cap, not just per-element
  // count. VERIFY_MAX_POOL_SIZE bounds N (count) but N × per-element-bytes
  // is the true memory pressure. A 100k-element pool of 100 KiB elements
  // fits the count cap but is 10 GB total. Re-encode each element's
  // content+children sub-tree once and reject before re-hashing if any
  // single element exceeds VERIFY_MAX_ELEMENT_BYTES.
  for (const [hash, element] of pkg.pool) {
    let elementSizeBytes: number;
    try {
      // We measure the size of the element's content+children sub-tree
      // (the data blobs that drive memory cost). Header is bounded
      // size (small fixed schema) so excluded from the cap window.
      const probe = dagCborEncode({
        content: element.content,
        children: element.children,
      });
      elementSizeBytes = probe.byteLength;
    } catch {
      // dag-cbor encode failure here means the element is structurally
      // unencodable — let computeElementHash below produce the precise
      // error.
      elementSizeBytes = 0;
    }
    if (elementSizeBytes > VERIFY_MAX_ELEMENT_BYTES) {
      errors.push({
        code: 'INVALID_PACKAGE',
        message:
          `Element ${hash} content+children size ${elementSizeBytes} bytes ` +
          `exceeds VERIFY_MAX_ELEMENT_BYTES=${VERIFY_MAX_ELEMENT_BYTES} ` +
          `(per-element bloat-DoS protection).`,
        elementHash: hash,
      });
      // Skip the recompute for oversized elements — re-hashing a 100 MiB
      // body burns CPU we explicitly refuse to spend.
      continue;
    }
    const recomputed = computeElementHash(element);
    if (recomputed !== hash) {
      errors.push({
        code: 'VERIFICATION_FAILED',
        message: `Content hash mismatch: pool key ${hash} but recomputed ${recomputed}`,
        elementHash: hash,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Check 1 + 2 + 4 + element type consistency: Walk from manifest roots
  // -----------------------------------------------------------------------
  const allReachable = new Set<ContentHash>();

  for (const [tokenId, rootHash] of pkg.manifest.tokens) {
    // Check 1: Manifest root exists in pool
    if (!pkg.pool.has(rootHash)) {
      errors.push({
        code: 'MISSING_ELEMENT',
        message: `Manifest root hash ${rootHash} for token ${tokenId} not found in pool`,
        tokenId,
        elementHash: rootHash,
      });
      continue;
    }

    // DFS walk from this token's root, detecting cycles within this subgraph.
    // We use path-based cycle detection: `pathStack` tracks ancestor nodes on the
    // current DFS path, while `visited` tracks fully-explored nodes to skip re-walks.
    // This correctly handles DAG diamonds (same node via two sibling paths) without
    // false CYCLE_DETECTED errors, while still catching true back-edge cycles.
    const visited = new Set<ContentHash>();
    const pathStack = new Set<ContentHash>();

    // Steelman²⁸ warning: explicit depth cap. V8 stack frames are ~10K
    // deep before overflow — a hand-crafted DAG with deeply nested
    // nametag chains (or other recursive child structures) can crash
    // verify before any check runs. 4096 is comfortably below the V8
    // limit and far above any legitimate DAG depth.
    const VERIFY_MAX_DEPTH = 4096;

    // Recursive DFS helper
    const dfsWalk = (
      hash: ContentHash,
      parentType?: string,
      childRole?: string,
      isArrayChild?: boolean,
      depth: number = 0,
    ): void => {
      if (depth > VERIFY_MAX_DEPTH) {
        errors.push({
          code: 'CYCLE_DETECTED',
          message: `Verify exceeded VERIFY_MAX_DEPTH=${VERIFY_MAX_DEPTH} in token ${tokenId} subgraph at ${hash}; possible deeply-nested DAG or undetected cycle.`,
          tokenId,
          elementHash: hash,
        });
        return;
      }
      // Check 4: True cycle detection (back-edge to ancestor)
      if (pathStack.has(hash)) {
        errors.push({
          code: 'CYCLE_DETECTED',
          message: `Cycle detected: element ${hash} visited twice in token ${tokenId} subgraph`,
          tokenId,
          elementHash: hash,
        });
        return;
      }

      // Already fully explored (DAG diamond) — skip
      if (visited.has(hash)) {
        allReachable.add(hash);
        return;
      }

      allReachable.add(hash);
      elementsChecked.add(hash);

      const element = pkg.pool.get(hash);
      if (!element) {
        // Check 2: Child reference resolution
        errors.push({
          code: 'MISSING_ELEMENT',
          message: `Child reference ${hash} not found in pool (referenced from ${parentType ?? 'manifest'} role "${childRole ?? 'root'}")`,
          tokenId,
          elementHash: hash,
        });
        return;
      }

      // Element type consistency check
      if (parentType && childRole) {
        let expectedType: string | undefined;
        if (isArrayChild) {
          expectedType = EXPECTED_ARRAY_CHILD_TYPES[parentType]?.[childRole];
        } else {
          expectedType = EXPECTED_CHILD_TYPES[parentType]?.[childRole];
        }
        if (expectedType && element.type !== expectedType) {
          errors.push({
            code: 'TYPE_MISMATCH',
            message: `Element ${hash} has type '${element.type}' but expected '${expectedType}' as '${childRole}' child of '${parentType}'`,
            tokenId,
            elementHash: hash,
          });
        }
      }

      // Enter path
      pathStack.add(hash);

      // Also walk instance chain members for this element (mark as reachable)
      const chainEntry = pkg.instanceChains.get(hash);
      if (chainEntry) {
        for (const link of chainEntry.chain) {
          if (!visited.has(link.hash)) {
            allReachable.add(link.hash);
            // Walk children of chain members too
            const chainElement = pkg.pool.get(link.hash);
            if (chainElement) {
              elementsChecked.add(link.hash);
              walkChildren(hash, chainElement, depth);
            }
          }
        }
      }

      // Walk children
      walkChildren(hash, element, depth);

      // Leave path, mark fully explored
      pathStack.delete(hash);
      visited.add(hash);
    };

    // Helper to walk children of an element via DFS
    // Steelman²⁸: receives current depth so recursive calls can enforce
    // the VERIFY_MAX_DEPTH cap (passed through to dfsWalk).
    const walkChildren = (
      _parentHash: ContentHash,
      element: UxfElement,
      currentDepth: number,
    ): void => {
      for (const [role, ref] of Object.entries(element.children)) {
        if (ref === null) {
          continue;
        }
        if (Array.isArray(ref)) {
          for (const childHash of ref as ContentHash[]) {
            dfsWalk(childHash, element.type, role, true, currentDepth + 1);
          }
        } else {
          dfsWalk(ref as ContentHash, element.type, role, false, currentDepth + 1);
        }
      }
    };

    dfsWalk(rootHash);
  }

  // -----------------------------------------------------------------------
  // Check 5: Instance chain validation (SPEC 7.3)
  // -----------------------------------------------------------------------
  const processedChains = new Set<InstanceChainEntry>();

  for (const [_hash, chainEntry] of pkg.instanceChains) {
    if (processedChains.has(chainEntry)) {
      continue;
    }
    processedChains.add(chainEntry);
    instanceChainsChecked++;

    if (chainEntry.chain.length === 0) {
      errors.push({
        code: 'INVALID_INSTANCE_CHAIN',
        message: 'Instance chain has zero entries',
      });
      continue;
    }

    // 7.3 Rule 4: All elements present in pool
    let chainType: string | undefined;
    const chainHashes = new Set<ContentHash>();

    for (let i = 0; i < chainEntry.chain.length; i++) {
      const link = chainEntry.chain[i];

      // Cycle detection within chain
      if (chainHashes.has(link.hash)) {
        errors.push({
          code: 'INVALID_INSTANCE_CHAIN',
          message: `Cycle in instance chain: hash ${link.hash} appears multiple times`,
          elementHash: link.hash,
        });
        break;
      }
      chainHashes.add(link.hash);

      const element = pkg.pool.get(link.hash);
      if (!element) {
        errors.push({
          code: 'MISSING_ELEMENT',
          message: `Instance chain element ${link.hash} not found in pool`,
          elementHash: link.hash,
        });
        continue;
      }

      // 7.3 Rule 1: All elements share the same type
      if (chainType === undefined) {
        chainType = element.type;
      } else if (element.type !== chainType) {
        errors.push({
          code: 'INVALID_INSTANCE_CHAIN',
          message: `Instance chain type mismatch: expected '${chainType}' but element ${link.hash} has type '${element.type}'`,
          elementHash: link.hash,
        });
      }

      // 7.3 Rule 3: Tail has predecessor: null
      if (i === chainEntry.chain.length - 1) {
        if (element.header.predecessor !== null) {
          errors.push({
            code: 'INVALID_INSTANCE_CHAIN',
            message: `Instance chain tail ${link.hash} has non-null predecessor: ${element.header.predecessor}`,
            elementHash: link.hash,
          });
        }
      }

      // Predecessor linkage: each non-tail entry's predecessor must match the next entry's hash
      if (i < chainEntry.chain.length - 1) {
        const expectedPredecessor = chainEntry.chain[i + 1].hash;
        if (element.header.predecessor !== expectedPredecessor) {
          errors.push({
            code: 'INVALID_INSTANCE_CHAIN',
            message: `Instance chain predecessor mismatch at position ${i}: element ${link.hash} has predecessor '${element.header.predecessor}' but expected '${expectedPredecessor}'`,
            elementHash: link.hash,
          });
        }
      }

      // 7.3 Rule 5: Content hashes match (already checked globally above)
    }

    // Head consistency check
    if (chainEntry.head !== chainEntry.chain[0].hash) {
      errors.push({
        code: 'INVALID_INSTANCE_CHAIN',
        message: `Instance chain head mismatch: entry head is ${chainEntry.head} but first chain element is ${chainEntry.chain[0].hash}`,
        elementHash: chainEntry.head,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Check 6: Orphaned elements (warning)
  // -----------------------------------------------------------------------
  let orphanedElements = 0;
  for (const hash of pkg.pool.keys()) {
    if (!allReachable.has(hash)) {
      orphanedElements++;
    }
  }

  if (orphanedElements > 0) {
    warnings.push({
      code: 'VERIFICATION_FAILED',
      message: `${orphanedElements} orphaned element(s) found in pool (not reachable from any manifest root)`,
    });
  }

  // -----------------------------------------------------------------------
  // Check 8: Divergent instance chains (multiple heads -> warning)
  // -----------------------------------------------------------------------
  // Group chains by tail (original) element. If multiple chains share the
  // same tail but have different heads, they are divergent.
  const tailToHeads = new Map<ContentHash, Set<ContentHash>>();
  const processedForDivergence = new Set<InstanceChainEntry>();

  for (const [_hash, chainEntry] of pkg.instanceChains) {
    if (processedForDivergence.has(chainEntry)) {
      continue;
    }
    processedForDivergence.add(chainEntry);

    if (chainEntry.chain.length > 0) {
      const tailHash = chainEntry.chain[chainEntry.chain.length - 1].hash;
      let heads = tailToHeads.get(tailHash);
      if (!heads) {
        heads = new Set();
        tailToHeads.set(tailHash, heads);
      }
      heads.add(chainEntry.head);
    }
  }

  for (const [tailHash, heads] of tailToHeads) {
    if (heads.size > 1) {
      warnings.push({
        code: 'INVALID_INSTANCE_CHAIN',
        message: `Divergent instance chain: element ${tailHash} has ${heads.size} heads: ${[...heads].join(', ')}`,
        elementHash: tailHash,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Build result
  // -----------------------------------------------------------------------
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats: {
      tokensChecked: pkg.manifest.tokens.size,
      elementsChecked: elementsChecked.size,
      orphanedElements,
      instanceChainsChecked,
    },
  };
}

