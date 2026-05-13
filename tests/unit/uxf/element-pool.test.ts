import { describe, it, expect } from 'vitest';
import { ElementPool, collectGarbage, walkReachable } from '../../../uxf/element-pool.js';
import { computeElementHash } from '../../../uxf/hash.js';
import type {
  ContentHash,
  UxfElement,
  UxfPackageData,
  InstanceChainIndex,
  InstanceChainEntry,
} from '../../../uxf/types.js';
import { contentHash } from '../../../uxf/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal UxfElement with default header. */
function makeElement(
  type: UxfElement['type'],
  content: Record<string, unknown> = {},
  children: Record<string, ContentHash | ContentHash[] | null> = {},
): UxfElement {
  return {
    header: {
      representation: 1,
      semantics: 1,
      kind: 'default',
      predecessor: null,
    },
    type,
    content,
    children,
  };
}

/** Build a minimal UxfPackageData for GC tests. */
function makePackage(
  manifest: Map<string, ContentHash>,
  pool: Map<ContentHash, UxfElement>,
  instanceChains: Map<ContentHash, InstanceChainEntry> = new Map(),
): UxfPackageData {
  return {
    envelope: {
      version: '1.0.0',
      createdAt: 0,
      updatedAt: 0,
    },
    manifest: { tokens: manifest },
    pool,
    instanceChains,
    indexes: {
      byTokenType: new Map(),
      byCoinId: new Map(),
      byStateHash: new Map(),
    },
  };
}

// ---------------------------------------------------------------------------
// ElementPool -- put / get / has / delete
// ---------------------------------------------------------------------------

describe('ElementPool', () => {
  describe('put / get / has / delete', () => {
    it('put returns content hash and stores element', () => {
      const pool = new ElementPool();
      const el = makeElement('token-state', { data: null, predicate: 'aa'.repeat(32) });
      const hash = pool.put(el);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(pool.get(hash)).toBe(el);
    });

    it('put deduplicates: same element twice returns same hash, pool size is 1', () => {
      const pool = new ElementPool();
      const el = makeElement('token-state', { data: null, predicate: 'aa'.repeat(32) });
      const h1 = pool.put(el);
      const h2 = pool.put(el);
      expect(h1).toBe(h2);
      expect(pool.size).toBe(1);
    });

    it('has returns true for existing element', () => {
      const pool = new ElementPool();
      const el = makeElement('token-state', { data: null, predicate: 'aa'.repeat(32) });
      const hash = pool.put(el);
      expect(pool.has(hash)).toBe(true);
    });

    it('has returns false for non-existent hash', () => {
      const pool = new ElementPool();
      const unknown = contentHash('ff'.repeat(32));
      expect(pool.has(unknown)).toBe(false);
    });

    it('get returns undefined for non-existent hash', () => {
      const pool = new ElementPool();
      const unknown = contentHash('ff'.repeat(32));
      expect(pool.get(unknown)).toBeUndefined();
    });

    it('delete removes element and returns true', () => {
      const pool = new ElementPool();
      const el = makeElement('token-state', { data: null, predicate: 'aa'.repeat(32) });
      const hash = pool.put(el);
      expect(pool.delete(hash)).toBe(true);
      expect(pool.has(hash)).toBe(false);
    });

    it('delete returns false for non-existent hash', () => {
      const pool = new ElementPool();
      const unknown = contentHash('ff'.repeat(32));
      expect(pool.delete(unknown)).toBe(false);
    });

    it('size tracks element count', () => {
      const pool = new ElementPool();
      const el1 = makeElement('token-state', { data: null, predicate: 'aa'.repeat(32) });
      const el2 = makeElement('token-state', { data: null, predicate: 'bb'.repeat(32) });
      const el3 = makeElement('token-state', { data: null, predicate: 'cc'.repeat(32) });
      pool.put(el1);
      pool.put(el2);
      const h3 = pool.put(el3);
      expect(pool.size).toBe(3);
      pool.delete(h3);
      expect(pool.size).toBe(2);
    });
  });

  describe('iteration', () => {
    it('entries yields all [hash, element] pairs', () => {
      const pool = new ElementPool();
      const el1 = makeElement('token-state', { data: null, predicate: 'aa'.repeat(32) });
      const el2 = makeElement('token-state', { data: null, predicate: 'bb'.repeat(32) });
      const h1 = pool.put(el1);
      const h2 = pool.put(el2);
      const entries = [...pool.entries()];
      expect(entries).toHaveLength(2);
      const hashSet = new Set(entries.map(([h]) => h));
      expect(hashSet.has(h1)).toBe(true);
      expect(hashSet.has(h2)).toBe(true);
    });

    it('hashes yields all content hashes', () => {
      const pool = new ElementPool();
      const el1 = makeElement('token-state', { data: null, predicate: 'aa'.repeat(32) });
      const el2 = makeElement('token-state', { data: null, predicate: 'bb'.repeat(32) });
      pool.put(el1);
      pool.put(el2);
      expect([...pool.hashes()]).toHaveLength(2);
    });

    it('values yields all elements', () => {
      const pool = new ElementPool();
      const el1 = makeElement('token-state', { data: null, predicate: 'aa'.repeat(32) });
      const el2 = makeElement('token-state', { data: null, predicate: 'bb'.repeat(32) });
      pool.put(el1);
      pool.put(el2);
      expect([...pool.values()]).toHaveLength(2);
    });
  });

  describe('toMap / fromMap', () => {
    it('toMap returns the internal map', () => {
      const pool = new ElementPool();
      const el = makeElement('token-state', { data: null, predicate: 'aa'.repeat(32) });
      const hash = pool.put(el);
      const map = pool.toMap();
      expect(map.size).toBe(1);
      expect(map.get(hash)).toBe(el);
    });

    it('fromMap creates a pool from a map', () => {
      const el = makeElement('token-state', { data: null, predicate: 'aa'.repeat(32) });
      const hash = computeElementHash(el);
      const map = new Map<ContentHash, UxfElement>([[hash, el]]);
      const pool = ElementPool.fromMap(map);
      expect(pool.size).toBe(1);
      expect(pool.get(hash)).toBe(el);
    });

    it('toMap/fromMap round-trip preserves elements', () => {
      const pool = new ElementPool();
      const el1 = makeElement('token-state', { data: null, predicate: 'aa'.repeat(32) });
      const el2 = makeElement('token-state', { data: null, predicate: 'bb'.repeat(32) });
      pool.put(el1);
      pool.put(el2);

      const restored = ElementPool.fromMap(pool.toMap());
      expect(restored.size).toBe(pool.size);
      for (const [hash, element] of pool.entries()) {
        expect(restored.get(hash)).toBe(element);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// collectGarbage
// ---------------------------------------------------------------------------

describe('collectGarbage', () => {
  it('reachable elements are kept', () => {
    // Build a tiny token: root -> state (leaf child)
    const stateEl = makeElement('token-state', { data: null, predicate: 'aa'.repeat(32) });
    const stateHash = computeElementHash(stateEl);

    const genesisDataEl = makeElement('genesis-data', {
      tokenId: 'bb'.repeat(32),
      tokenType: 'cc'.repeat(32),
      coinData: [],
      tokenData: 'dd'.repeat(32),
      salt: 'ee'.repeat(32),
      recipient: 'DIRECT://test',
      recipientDataHash: null,
      reason: null,
    });
    const genesisDataHash = computeElementHash(genesisDataEl);

    const rootEl = makeElement('token-root', {
      tokenId: 'bb'.repeat(32),
      version: '2.0',
    }, {
      genesis: genesisDataHash,
      transactions: [],
      state: stateHash,
      nametags: [],
    });
    const rootHash = computeElementHash(rootEl);

    const pool = new Map<ContentHash, UxfElement>([
      [rootHash, rootEl],
      [stateHash, stateEl],
      [genesisDataHash, genesisDataEl],
    ]);
    const manifest = new Map<string, ContentHash>([['bb'.repeat(32), rootHash]]);
    const pkg = makePackage(manifest, pool);

    const removed = collectGarbage(pkg);
    expect(removed.size).toBe(0);
    expect(pkg.pool.size).toBe(3);
  });

  it('orphaned elements are removed', () => {
    // Root -> state, plus an orphaned element
    const stateEl = makeElement('token-state', { data: null, predicate: 'aa'.repeat(32) });
    const stateHash = computeElementHash(stateEl);

    const rootEl = makeElement('token-root', {
      tokenId: 'bb'.repeat(32),
      version: '2.0',
    }, {
      genesis: stateHash, // reuse for simplicity
      transactions: [],
      state: stateHash,
      nametags: [],
    });
    const rootHash = computeElementHash(rootEl);

    // Orphaned element -- not referenced by anything
    const orphanEl = makeElement('authenticator', {
      algorithm: 'secp256k1',
      publicKey: 'ff'.repeat(16),
      signature: 'ee'.repeat(32),
      stateHash: 'dd'.repeat(32),
    });
    const orphanHash = computeElementHash(orphanEl);

    const pool = new Map<ContentHash, UxfElement>([
      [rootHash, rootEl],
      [stateHash, stateEl],
      [orphanHash, orphanEl],
    ]);
    const manifest = new Map<string, ContentHash>([['bb'.repeat(32), rootHash]]);
    const pkg = makePackage(manifest, pool);

    const removed = collectGarbage(pkg);
    expect(removed.size).toBe(1);
    expect(removed.has(orphanHash)).toBe(true);
    expect(pkg.pool.has(orphanHash)).toBe(false);
    expect(pkg.pool.size).toBe(2);
  });

  it('shared elements are not removed when still referenced by another token', () => {
    // Shared state element used by two tokens
    const sharedState = makeElement('token-state', { data: null, predicate: 'aa'.repeat(32) });
    const sharedHash = computeElementHash(sharedState);

    const root1 = makeElement('token-root', {
      tokenId: '11'.repeat(32),
      version: '2.0',
    }, {
      genesis: sharedHash,
      transactions: [],
      state: sharedHash,
      nametags: [],
    });
    const root1Hash = computeElementHash(root1);

    const root2 = makeElement('token-root', {
      tokenId: '22'.repeat(32),
      version: '2.0',
    }, {
      genesis: sharedHash,
      transactions: [],
      state: sharedHash,
      nametags: [],
    });
    const root2Hash = computeElementHash(root2);

    const pool = new Map<ContentHash, UxfElement>([
      [root1Hash, root1],
      [root2Hash, root2],
      [sharedHash, sharedState],
    ]);

    // Both tokens in manifest
    const manifest = new Map<string, ContentHash>([
      ['11'.repeat(32), root1Hash],
      ['22'.repeat(32), root2Hash],
    ]);

    // Remove token 1 from manifest, shared element should survive
    manifest.delete('11'.repeat(32));

    const pkg = makePackage(manifest, pool);
    const removed = collectGarbage(pkg);

    // root1 is orphaned, but sharedState is still reachable from root2
    expect(removed.has(root1Hash)).toBe(true);
    expect(removed.has(sharedHash)).toBe(false);
    expect(pkg.pool.has(sharedHash)).toBe(true);
  });

  it('instance chain elements are reachable', () => {
    // Original element
    const originalEl = makeElement('token-state', { data: null, predicate: 'aa'.repeat(32) });
    const originalHash = computeElementHash(originalEl);

    // Newer instance (different kind, predecessor points to original)
    const newerEl: UxfElement = {
      header: {
        representation: 2,
        semantics: 1,
        kind: 'consolidated-proof',
        predecessor: originalHash,
      },
      type: 'token-state',
      content: { data: null, predicate: 'bb'.repeat(32) },
      children: {},
    };
    const newerHash = computeElementHash(newerEl);

    // Token root references only the original hash
    const rootEl = makeElement('token-root', {
      tokenId: 'cc'.repeat(32),
      version: '2.0',
    }, {
      genesis: originalHash,
      transactions: [],
      state: originalHash,
      nametags: [],
    });
    const rootHash = computeElementHash(rootEl);

    const pool = new Map<ContentHash, UxfElement>([
      [rootHash, rootEl],
      [originalHash, originalEl],
      [newerHash, newerEl],
    ]);

    // Instance chain: originalHash and newerHash are in the same chain
    const chainEntry: InstanceChainEntry = {
      head: newerHash,
      chain: [
        { hash: newerHash, kind: 'consolidated-proof' },
        { hash: originalHash, kind: 'default' },
      ],
    };
    const instanceChains = new Map<ContentHash, InstanceChainEntry>([
      [originalHash, chainEntry],
      [newerHash, chainEntry],
    ]);

    const manifest = new Map<string, ContentHash>([['cc'.repeat(32), rootHash]]);
    const pkg = makePackage(manifest, pool, instanceChains);

    const removed = collectGarbage(pkg);

    // Both chain members should be kept (original is referenced, newer via chain expansion)
    expect(removed.size).toBe(0);
    expect(pkg.pool.has(originalHash)).toBe(true);
    expect(pkg.pool.has(newerHash)).toBe(true);
  });

  it('prunes instance chain index entries for removed hashes', () => {
    // Orphaned element that is in an instance chain
    const orphanEl = makeElement('authenticator', {
      algorithm: 'secp256k1',
      publicKey: 'ff'.repeat(16),
      signature: 'ee'.repeat(32),
      stateHash: 'dd'.repeat(32),
    });
    const orphanHash = computeElementHash(orphanEl);

    const chainEntry: InstanceChainEntry = {
      head: orphanHash,
      chain: [{ hash: orphanHash, kind: 'default' }],
    };
    const instanceChains = new Map<ContentHash, InstanceChainEntry>([
      [orphanHash, chainEntry],
    ]);

    // A simple reachable root with no reference to the orphan
    const stateEl = makeElement('token-state', { data: null, predicate: 'aa'.repeat(32) });
    const stateHash = computeElementHash(stateEl);
    const rootEl = makeElement('token-root', {
      tokenId: 'bb'.repeat(32),
      version: '2.0',
    }, {
      genesis: stateHash,
      transactions: [],
      state: stateHash,
      nametags: [],
    });
    const rootHash = computeElementHash(rootEl);

    const pool = new Map<ContentHash, UxfElement>([
      [rootHash, rootEl],
      [stateHash, stateEl],
      [orphanHash, orphanEl],
    ]);
    const manifest = new Map<string, ContentHash>([['bb'.repeat(32), rootHash]]);
    const pkg = makePackage(manifest, pool, instanceChains);

    const removed = collectGarbage(pkg);
    expect(removed.has(orphanHash)).toBe(true);
    // Instance chain entry for the orphan should be pruned
    expect(pkg.instanceChains.has(orphanHash)).toBe(false);
  });
});
