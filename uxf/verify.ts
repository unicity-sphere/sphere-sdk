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
  // -----------------------------------------------------------------------
  for (const [hash, element] of pkg.pool) {
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

    // DFS walk from this token's root, detecting cycles within this subgraph
    const visitedInSubgraph = new Set<ContentHash>();
    const stack: Array<{
      hash: ContentHash;
      parentType?: string;
      childRole?: string;
      isArrayChild?: boolean;
    }> = [{ hash: rootHash }];

    while (stack.length > 0) {
      const { hash, parentType, childRole, isArrayChild } = stack.pop()!;

      // Check 4: Cycle detection within this token's subgraph
      if (visitedInSubgraph.has(hash)) {
        errors.push({
          code: 'CYCLE_DETECTED',
          message: `Cycle detected: element ${hash} visited twice in token ${tokenId} subgraph`,
          tokenId,
          elementHash: hash,
        });
        continue;
      }

      visitedInSubgraph.add(hash);
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
        continue;
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

      // Also walk instance chain members for this element (mark as reachable)
      const chainEntry = pkg.instanceChains.get(hash);
      if (chainEntry) {
        for (const link of chainEntry.chain) {
          if (!visitedInSubgraph.has(link.hash)) {
            allReachable.add(link.hash);
            // Walk children of chain members too
            const chainElement = pkg.pool.get(link.hash);
            if (chainElement) {
              elementsChecked.add(link.hash);
              pushChildren(stack, link.hash, chainElement);
            }
          }
        }
      }

      // Push children onto the stack
      pushChildren(stack, hash, element);
    }
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Push child references from an element onto the DFS stack.
 */
function pushChildren(
  stack: Array<{
    hash: ContentHash;
    parentType?: string;
    childRole?: string;
    isArrayChild?: boolean;
  }>,
  _parentHash: ContentHash,
  element: UxfElement,
): void {
  for (const [role, ref] of Object.entries(element.children)) {
    if (ref === null) {
      continue;
    }
    if (Array.isArray(ref)) {
      for (const childHash of ref as ContentHash[]) {
        stack.push({
          hash: childHash,
          parentType: element.type,
          childRole: role,
          isArrayChild: true,
        });
      }
    } else {
      stack.push({
        hash: ref as ContentHash,
        parentType: element.type,
        childRole: role,
        isArrayChild: false,
      });
    }
  }
}
