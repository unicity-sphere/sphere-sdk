/**
 * Tests for uxf/instance-chain.ts (WU-05)
 *
 * Covers: addInstance, selectInstance, resolveElement,
 *         mergeInstanceChains, pruneInstanceChains, rebuildInstanceChainIndex
 */

import { describe, it, expect } from 'vitest';
import type {
  ContentHash,
  UxfElement,
  UxfElementType,
  UxfInstanceKind,
  InstanceChainEntry,
  InstanceSelectionStrategy,
} from '../../../uxf/types.js';
import { ElementPool } from '../../../uxf/element-pool.js';
import {
  addInstance,
  selectInstance,
  resolveElement,
  mergeInstanceChains,
  pruneInstanceChains,
  rebuildInstanceChainIndex,
  createInstanceChainIndex,
  type MutableInstanceChainIndex,
} from '../../../uxf/instance-chain.js';
import { UxfError } from '../../../uxf/errors.js';
import { computeElementHash } from '../../../uxf/hash.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a test UxfElement with sensible defaults.
 */
function makeElement(
  type: UxfElementType,
  content: Record<string, unknown>,
  opts?: {
    kind?: UxfInstanceKind;
    predecessor?: ContentHash | null;
    semantics?: number;
    representation?: number;
  },
): UxfElement {
  return {
    header: {
      representation: opts?.representation ?? 1,
      semantics: opts?.semantics ?? 1,
      kind: opts?.kind ?? 'default',
      predecessor: opts?.predecessor ?? null,
    },
    type,
    content,
    children: {},
  };
}

/**
 * Insert an element into the pool and return its hash.
 */
function putElement(pool: ElementPool, element: UxfElement): ContentHash {
  return pool.put(element);
}

// ---------------------------------------------------------------------------
// addInstance
// ---------------------------------------------------------------------------

describe('addInstance', () => {
  it('creates a new chain of length 2 (original + new)', () => {
    const pool = new ElementPool();
    const index = createInstanceChainIndex();

    const original = makeElement('token-state', { data: null, predicate: 'aa' });
    const originalHash = putElement(pool, original);

    const newInst = makeElement('token-state', { data: null, predicate: 'bb' }, {
      predecessor: originalHash,
    });

    const newHash = addInstance(pool, index, originalHash, newInst);

    expect(index.has(originalHash)).toBe(true);
    expect(index.has(newHash)).toBe(true);

    const entry = index.get(originalHash)!;
    expect(entry.chain).toHaveLength(2);
    expect(entry.head).toBe(newHash);
    expect(entry.chain[0].hash).toBe(newHash);
    expect(entry.chain[1].hash).toBe(originalHash);
  });

  it('extends existing chain (3 elements)', () => {
    const pool = new ElementPool();
    const index = createInstanceChainIndex();

    const original = makeElement('token-state', { data: null, predicate: 'aa' });
    const originalHash = putElement(pool, original);

    const inst1 = makeElement('token-state', { data: null, predicate: 'bb' }, {
      predecessor: originalHash,
    });
    const hash1 = addInstance(pool, index, originalHash, inst1);

    const inst2 = makeElement('token-state', { data: null, predicate: 'cc' }, {
      predecessor: hash1,
    });
    const hash2 = addInstance(pool, index, originalHash, inst2);

    const entry = index.get(originalHash)!;
    expect(entry.chain).toHaveLength(3);
    expect(entry.head).toBe(hash2);
    expect(entry.chain[0].hash).toBe(hash2);
    expect(entry.chain[1].hash).toBe(hash1);
    expect(entry.chain[2].hash).toBe(originalHash);
  });

  it('rejects wrong element type', () => {
    const pool = new ElementPool();
    const index = createInstanceChainIndex();

    const original = makeElement('token-state', { data: null, predicate: 'aa' });
    const originalHash = putElement(pool, original);

    const wrongType = makeElement('authenticator', { algorithm: 'secp256k1', publicKey: 'aabb', signature: 'ccdd', stateHash: 'eeff' }, {
      predecessor: originalHash,
    });

    expect(() => addInstance(pool, index, originalHash, wrongType)).toThrow(UxfError);
    try {
      addInstance(pool, index, originalHash, wrongType);
    } catch (e) {
      expect((e as UxfError).code).toBe('INVALID_INSTANCE_CHAIN');
    }
  });

  it('rejects wrong predecessor', () => {
    const pool = new ElementPool();
    const index = createInstanceChainIndex();

    const original = makeElement('token-state', { data: null, predicate: 'aa' });
    const originalHash = putElement(pool, original);

    // Use a fake predecessor that does not match the current head
    const fakePred = computeElementHash(
      makeElement('token-state', { data: null, predicate: 'ff' }),
    );

    const badPred = makeElement('token-state', { data: null, predicate: 'bb' }, {
      predecessor: fakePred,
    });

    expect(() => addInstance(pool, index, originalHash, badPred)).toThrow(UxfError);
    try {
      addInstance(pool, index, originalHash, badPred);
    } catch (e) {
      expect((e as UxfError).code).toBe('INVALID_INSTANCE_CHAIN');
    }
  });

  it('rejects semantics version downgrade', () => {
    const pool = new ElementPool();
    const index = createInstanceChainIndex();

    const original = makeElement('token-state', { data: null, predicate: 'aa' }, {
      semantics: 2,
    });
    const originalHash = putElement(pool, original);

    const downgrade = makeElement('token-state', { data: null, predicate: 'bb' }, {
      predecessor: originalHash,
      semantics: 1,
    });

    expect(() => addInstance(pool, index, originalHash, downgrade)).toThrow(UxfError);
    try {
      addInstance(pool, index, originalHash, downgrade);
    } catch (e) {
      expect((e as UxfError).code).toBe('INVALID_INSTANCE_CHAIN');
    }
  });

  it('accepts equal semantics version', () => {
    const pool = new ElementPool();
    const index = createInstanceChainIndex();

    const original = makeElement('token-state', { data: null, predicate: 'aa' }, {
      semantics: 1,
    });
    const originalHash = putElement(pool, original);

    const sameSemantics = makeElement('token-state', { data: null, predicate: 'bb' }, {
      predecessor: originalHash,
      semantics: 1,
    });

    // Should not throw
    const newHash = addInstance(pool, index, originalHash, sameSemantics);
    expect(index.get(newHash)!.chain).toHaveLength(2);
  });

  it('inserts new element into pool', () => {
    const pool = new ElementPool();
    const index = createInstanceChainIndex();

    const original = makeElement('token-state', { data: null, predicate: 'aa' });
    const originalHash = putElement(pool, original);

    const inst = makeElement('token-state', { data: null, predicate: 'dd' }, {
      predecessor: originalHash,
    });

    const newHash = addInstance(pool, index, originalHash, inst);
    expect(pool.get(newHash)).toBeDefined();
    expect(pool.get(newHash)!.content).toEqual(inst.content);
  });

  it('all chain hashes point to the same InstanceChainEntry reference', () => {
    const pool = new ElementPool();
    const index = createInstanceChainIndex();

    const original = makeElement('token-state', { data: null, predicate: 'aa' });
    const originalHash = putElement(pool, original);

    const inst1 = makeElement('token-state', { data: null, predicate: 'bb' }, {
      predecessor: originalHash,
    });
    const hash1 = addInstance(pool, index, originalHash, inst1);

    const inst2 = makeElement('token-state', { data: null, predicate: 'cc' }, {
      predecessor: hash1,
    });
    const hash2 = addInstance(pool, index, originalHash, inst2);

    const entryA = index.get(originalHash);
    const entryB = index.get(hash1);
    const entryC = index.get(hash2);

    // Same reference
    expect(entryA).toBe(entryB);
    expect(entryB).toBe(entryC);
  });

  it('rejects when original element is not in pool', () => {
    const pool = new ElementPool();
    const index = createInstanceChainIndex();

    const fakeHash = computeElementHash(
      makeElement('token-state', { data: null, predicate: 'ff' }),
    );

    const inst = makeElement('token-state', { data: null, predicate: 'bb' }, {
      predecessor: fakeHash,
    });

    expect(() => addInstance(pool, index, fakeHash, inst)).toThrow(UxfError);
    try {
      addInstance(pool, index, fakeHash, inst);
    } catch (e) {
      expect((e as UxfError).code).toBe('MISSING_ELEMENT');
    }
  });
});

// ---------------------------------------------------------------------------
// selectInstance
// ---------------------------------------------------------------------------

describe('selectInstance', () => {
  /**
   * Build a 3-element chain in-memory with varying kinds, semantics, representations.
   * Chain order: [head (index 0), middle (index 1), tail/original (index 2)]
   */
  function buildChain(): {
    pool: ElementPool;
    entry: InstanceChainEntry;
    hashes: ContentHash[];
  } {
    const pool = new ElementPool();
    const index = createInstanceChainIndex();

    // original: kind=default, semantics=1, representation=1
    const original = makeElement('token-state', { data: null, predicate: 'aa' }, {
      kind: 'default',
      semantics: 1,
      representation: 1,
    });
    const origHash = putElement(pool, original);

    // middle: kind=individual-proof, semantics=2, representation=2
    const middle = makeElement('token-state', { data: null, predicate: 'bb' }, {
      kind: 'individual-proof',
      semantics: 2,
      representation: 2,
      predecessor: origHash,
    });
    const midHash = addInstance(pool, index, origHash, middle);

    // head: kind=consolidated-proof, semantics=3, representation=3
    const head = makeElement('token-state', { data: null, predicate: 'cc' }, {
      kind: 'consolidated-proof',
      semantics: 3,
      representation: 3,
      predecessor: midHash,
    });
    const headHash = addInstance(pool, index, origHash, head);

    const entry = index.get(origHash)!;
    return { pool, entry, hashes: [headHash, midHash, origHash] };
  }

  it('strategy=latest returns head', () => {
    const { pool, entry, hashes } = buildChain();
    const result = selectInstance(entry, { type: 'latest' }, pool);
    expect(result).toBe(hashes[0]);
  });

  it('strategy=original returns tail', () => {
    const { pool, entry, hashes } = buildChain();
    const result = selectInstance(entry, { type: 'original' }, pool);
    expect(result).toBe(hashes[2]);
  });

  it('strategy=by-kind returns matching kind', () => {
    const { pool, entry, hashes } = buildChain();
    const result = selectInstance(
      entry,
      { type: 'by-kind', kind: 'individual-proof' },
      pool,
    );
    expect(result).toBe(hashes[1]);
  });

  it('strategy=by-kind with no match returns head', () => {
    const { pool, entry, hashes } = buildChain();
    const result = selectInstance(
      entry,
      { type: 'by-kind', kind: 'zk-proof' },
      pool,
    );
    expect(result).toBe(hashes[0]); // head
  });

  it('strategy=by-kind with fallback', () => {
    const { pool, entry, hashes } = buildChain();
    const result = selectInstance(
      entry,
      { type: 'by-kind', kind: 'zk-proof', fallback: { type: 'original' } },
      pool,
    );
    expect(result).toBe(hashes[2]); // tail via fallback
  });

  it('strategy=by-representation returns matching version', () => {
    const { pool, entry, hashes } = buildChain();
    const result = selectInstance(
      entry,
      { type: 'by-representation', version: 2 },
      pool,
    );
    expect(result).toBe(hashes[1]);
  });

  it('strategy=by-representation with no match returns head', () => {
    const { pool, entry, hashes } = buildChain();
    const result = selectInstance(
      entry,
      { type: 'by-representation', version: 99 },
      pool,
    );
    expect(result).toBe(hashes[0]); // head
  });

  it('strategy=custom with matching predicate', () => {
    const { pool, entry, hashes } = buildChain();
    const result = selectInstance(
      entry,
      { type: 'custom', predicate: (el) => el.header.semantics === 2 },
      pool,
    );
    expect(result).toBe(hashes[1]);
  });

  it('strategy=custom with no match returns head', () => {
    const { pool, entry, hashes } = buildChain();
    const result = selectInstance(
      entry,
      { type: 'custom', predicate: () => false },
      pool,
    );
    expect(result).toBe(hashes[0]); // head
  });

  it('strategy=custom with fallback', () => {
    const { pool, entry, hashes } = buildChain();
    const result = selectInstance(
      entry,
      { type: 'custom', predicate: () => false, fallback: { type: 'original' } },
      pool,
    );
    expect(result).toBe(hashes[2]); // tail via fallback
  });
});

// ---------------------------------------------------------------------------
// resolveElement
// ---------------------------------------------------------------------------

describe('resolveElement', () => {
  it('with chain: returns selected instance element', () => {
    const pool = new ElementPool();
    const index = createInstanceChainIndex();

    const original = makeElement('token-state', { data: null, predicate: 'aa' });
    const origHash = putElement(pool, original);

    const inst = makeElement('token-state', { data: null, predicate: 'bb' }, {
      predecessor: origHash,
    });
    const instHash = addInstance(pool, index, origHash, inst);

    // strategy=latest -> should return head (inst)
    const resolved = resolveElement(pool, origHash, index, { type: 'latest' });
    expect(resolved).toBe(pool.get(instHash));
  });

  it('without chain: returns element directly from pool', () => {
    const pool = new ElementPool();
    const index = createInstanceChainIndex();

    const element = makeElement('token-state', { data: null, predicate: 'aa' });
    const hash = putElement(pool, element);

    const resolved = resolveElement(pool, hash, index, { type: 'latest' });
    expect(resolved).toBe(pool.get(hash));
  });

  it('missing element throws MISSING_ELEMENT', () => {
    const pool = new ElementPool();
    const index = createInstanceChainIndex();

    const fakeHash = computeElementHash(
      makeElement('token-state', { data: null, predicate: 'ff' }),
    );

    expect(() => resolveElement(pool, fakeHash, index, { type: 'latest' })).toThrow(UxfError);
    try {
      resolveElement(pool, fakeHash, index, { type: 'latest' });
    } catch (e) {
      expect((e as UxfError).code).toBe('MISSING_ELEMENT');
    }
  });

  it('chain entry with missing selected instance throws MISSING_ELEMENT', () => {
    const pool = new ElementPool();
    const index = createInstanceChainIndex();

    const original = makeElement('token-state', { data: null, predicate: 'aa' });
    const origHash = putElement(pool, original);

    const inst = makeElement('token-state', { data: null, predicate: 'bb' }, {
      predecessor: origHash,
    });
    const instHash = addInstance(pool, index, origHash, inst);

    // Remove the head from the pool to simulate missing element
    pool.delete(instHash);

    expect(() => resolveElement(pool, origHash, index, { type: 'latest' })).toThrow(UxfError);
    try {
      resolveElement(pool, origHash, index, { type: 'latest' });
    } catch (e) {
      expect((e as UxfError).code).toBe('MISSING_ELEMENT');
    }
  });
});

// ---------------------------------------------------------------------------
// mergeInstanceChains
// ---------------------------------------------------------------------------

describe('mergeInstanceChains', () => {
  it('no overlap: source chain added to target', () => {
    const pool = new ElementPool();
    const target = createInstanceChainIndex();
    const source = createInstanceChainIndex();

    // Build a chain in the source
    const original = makeElement('token-state', { data: null, predicate: 'aa' });
    const origHash = putElement(pool, original);

    const inst = makeElement('token-state', { data: null, predicate: 'bb' }, {
      predecessor: origHash,
    });
    const instHash = addInstance(pool, source, origHash, inst);

    mergeInstanceChains(target, source, pool);

    expect(target.has(origHash)).toBe(true);
    expect(target.has(instHash)).toBe(true);
    expect(target.get(origHash)!.chain).toHaveLength(2);
  });

  it('source is prefix of target: target kept as-is', () => {
    const pool = new ElementPool();
    const target = createInstanceChainIndex();
    const source = createInstanceChainIndex();

    const original = makeElement('token-state', { data: null, predicate: 'aa' });
    const origHash = putElement(pool, original);

    // Source: chain of 2
    const inst1 = makeElement('token-state', { data: null, predicate: 'bb' }, {
      predecessor: origHash,
    });
    const hash1 = addInstance(pool, source, origHash, inst1);

    // Target: chain of 3 (superset)
    // We need to build target chain manually to share the same hashes
    const inst1t = makeElement('token-state', { data: null, predicate: 'bb' }, {
      predecessor: origHash,
    });
    addInstance(pool, target, origHash, inst1t);

    const inst2t = makeElement('token-state', { data: null, predicate: 'cc' }, {
      predecessor: hash1,
    });
    addInstance(pool, target, origHash, inst2t);

    const targetEntryBefore = target.get(origHash)!;
    expect(targetEntryBefore.chain).toHaveLength(3);

    mergeInstanceChains(target, source, pool);

    // Target should be unchanged (3 elements)
    expect(target.get(origHash)!.chain).toHaveLength(3);
  });

  it('target is prefix of source: source replaces target', () => {
    const pool = new ElementPool();
    const target = createInstanceChainIndex();
    const source = createInstanceChainIndex();

    const original = makeElement('token-state', { data: null, predicate: 'aa' });
    const origHash = putElement(pool, original);

    // Target: chain of 2
    const inst1 = makeElement('token-state', { data: null, predicate: 'bb' }, {
      predecessor: origHash,
    });
    const hash1 = addInstance(pool, target, origHash, inst1);

    // Source: chain of 3 (superset) - shares original and inst1
    const inst1s = makeElement('token-state', { data: null, predicate: 'bb' }, {
      predecessor: origHash,
    });
    addInstance(pool, source, origHash, inst1s);

    const inst2s = makeElement('token-state', { data: null, predicate: 'cc' }, {
      predecessor: hash1,
    });
    const hash2 = addInstance(pool, source, origHash, inst2s);

    mergeInstanceChains(target, source, pool);

    // Target should now have source's longer chain (3 elements)
    expect(target.get(origHash)!.chain).toHaveLength(3);
    expect(target.get(origHash)!.head).toBe(hash2);
  });

  it('divergent chains: both kept', () => {
    const pool = new ElementPool();
    const target = createInstanceChainIndex();
    const source = createInstanceChainIndex();

    const original = makeElement('token-state', { data: null, predicate: 'aa' });
    const origHash = putElement(pool, original);

    // Target branch: original -> instT
    const instT = makeElement('token-state', { data: null, predicate: 'aabb' }, {
      predecessor: origHash,
    });
    const hashT = addInstance(pool, target, origHash, instT);

    // Source branch: original -> instS (different content, so different hash)
    const instS = makeElement('token-state', { data: null, predicate: 'ccdd' }, {
      predecessor: origHash,
    });
    const hashS = addInstance(pool, source, origHash, instS);

    mergeInstanceChains(target, source, pool);

    // Both head hashes should be in the target index
    expect(target.has(hashT)).toBe(true);
    expect(target.has(hashS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pruneInstanceChains
// ---------------------------------------------------------------------------

describe('pruneInstanceChains', () => {
  it('removes entries for removed hashes', () => {
    const pool = new ElementPool();
    const index = createInstanceChainIndex();

    const original = makeElement('token-state', { data: null, predicate: 'aa' });
    const origHash = putElement(pool, original);

    const inst1 = makeElement('token-state', { data: null, predicate: 'bb' }, {
      predecessor: origHash,
    });
    const hash1 = addInstance(pool, index, origHash, inst1);

    const inst2 = makeElement('token-state', { data: null, predicate: 'cc' }, {
      predecessor: hash1,
    });
    const hash2 = addInstance(pool, index, origHash, inst2);

    // Remove the middle hash
    pruneInstanceChains(index, new Set([hash1]));

    // Middle hash should be gone
    expect(index.has(hash1)).toBe(false);
    // Remaining chain should have 2 entries (head + original)
    const entry = index.get(origHash);
    expect(entry).toBeDefined();
    expect(entry!.chain).toHaveLength(2);
    expect(entry!.chain[0].hash).toBe(hash2);
    expect(entry!.chain[1].hash).toBe(origHash);
  });

  it('removes trivial chain (1 remaining)', () => {
    const pool = new ElementPool();
    const index = createInstanceChainIndex();

    const original = makeElement('token-state', { data: null, predicate: 'aa' });
    const origHash = putElement(pool, original);

    const inst = makeElement('token-state', { data: null, predicate: 'bb' }, {
      predecessor: origHash,
    });
    const instHash = addInstance(pool, index, origHash, inst);

    // Remove one of the two -> chain of 1 -> dissolved
    pruneInstanceChains(index, new Set([instHash]));

    expect(index.has(origHash)).toBe(false);
    expect(index.has(instHash)).toBe(false);
  });

  it('no-op for empty removedHashes set', () => {
    const pool = new ElementPool();
    const index = createInstanceChainIndex();

    const original = makeElement('token-state', { data: null, predicate: 'aa' });
    const origHash = putElement(pool, original);

    const inst = makeElement('token-state', { data: null, predicate: 'bb' }, {
      predecessor: origHash,
    });
    const instHash = addInstance(pool, index, origHash, inst);

    const sizeBefore = index.size;
    pruneInstanceChains(index, new Set());
    expect(index.size).toBe(sizeBefore);
  });
});

// ---------------------------------------------------------------------------
// rebuildInstanceChainIndex
// ---------------------------------------------------------------------------

describe('rebuildInstanceChainIndex', () => {
  it('reconstructs chains from predecessor links', () => {
    const pool = new ElementPool();

    // Build elements with predecessor links manually
    const original = makeElement('token-state', { data: null, predicate: 'aa' });
    const origHash = putElement(pool, original);

    const inst1 = makeElement('token-state', { data: null, predicate: 'bb' }, {
      predecessor: origHash,
    });
    const hash1 = putElement(pool, inst1);

    const inst2 = makeElement('token-state', { data: null, predicate: 'cc' }, {
      predecessor: hash1,
    });
    const hash2 = putElement(pool, inst2);

    const rebuilt = rebuildInstanceChainIndex(pool);

    // All three hashes should be in the index
    expect(rebuilt.has(origHash)).toBe(true);
    expect(rebuilt.has(hash1)).toBe(true);
    expect(rebuilt.has(hash2)).toBe(true);

    const entry = rebuilt.get(origHash)!;
    expect(entry.chain).toHaveLength(3);
    expect(entry.head).toBe(hash2);
    // Chain order: head -> ... -> tail
    expect(entry.chain[0].hash).toBe(hash2);
    expect(entry.chain[2].hash).toBe(origHash);
  });

  it('handles branching (two successors)', () => {
    const pool = new ElementPool();

    const original = makeElement('token-state', { data: null, predicate: 'aa' });
    const origHash = putElement(pool, original);

    // Two different instances pointing to the same predecessor
    const branchA = makeElement('token-state', { data: null, predicate: 'aabb' }, {
      predecessor: origHash,
    });
    const hashA = putElement(pool, branchA);

    const branchB = makeElement('token-state', { data: null, predicate: 'aabbcc' }, {
      predecessor: origHash,
    });
    const hashB = putElement(pool, branchB);

    const rebuilt = rebuildInstanceChainIndex(pool);

    // Both branches should have entries
    expect(rebuilt.has(hashA)).toBe(true);
    expect(rebuilt.has(hashB)).toBe(true);

    // They should be in separate chain entries (different heads)
    const entryA = rebuilt.get(hashA)!;
    const entryB = rebuilt.get(hashB)!;
    expect(entryA.head).toBe(hashA);
    expect(entryB.head).toBe(hashB);
  });

  it('ignores elements with no predecessor links', () => {
    const pool = new ElementPool();

    // Standalone elements with no predecessor and no successors
    putElement(pool, makeElement('token-state', { data: null, predicate: 'aa' }));
    putElement(pool, makeElement('authenticator', { algorithm: 'secp256k1', publicKey: 'aabb', signature: 'ccdd', stateHash: 'eeff' }));

    const rebuilt = rebuildInstanceChainIndex(pool);
    expect(rebuilt.size).toBe(0);
  });

  it('cycle protection: visited hashes not re-walked', () => {
    const pool = new ElementPool();

    // Build a long chain to verify no infinite loop
    let prevHash: ContentHash | null = null;
    const hashes: ContentHash[] = [];

    for (let i = 0; i < 20; i++) {
      // Use a valid hex predicate that varies per iteration
      const hexByte = i.toString(16).padStart(2, '0');
      const el = makeElement('token-state', { data: null, predicate: `aa${hexByte}` }, {
        predecessor: prevHash,
      });
      const h = putElement(pool, el);
      hashes.push(h);
      prevHash = h;
    }

    // Should complete without hanging
    const rebuilt = rebuildInstanceChainIndex(pool);

    // All hashes should be in the index
    for (const h of hashes) {
      expect(rebuilt.has(h)).toBe(true);
    }

    const entry = rebuilt.get(hashes[0])!;
    expect(entry.chain).toHaveLength(20);
    expect(entry.head).toBe(hashes[hashes.length - 1]);
  });
});
