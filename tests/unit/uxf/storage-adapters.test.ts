import { describe, it, expect } from 'vitest';
import {
  InMemoryUxfStorage,
  KvUxfStorageAdapter,
} from '../../../uxf/storage-adapters.js';
import { ElementPool } from '../../../uxf/element-pool.js';
import { deconstructToken } from '../../../uxf/deconstruct.js';
import type {
  ContentHash,
  UxfElement,
  UxfPackageData,
  InstanceChainEntry,
} from '../../../uxf/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexFill(pattern: string, totalChars: number): string {
  return pattern.repeat(Math.ceil(totalChars / pattern.length)).slice(0, totalChars);
}

function makePackage(
  manifest: Map<string, ContentHash>,
  pool: Map<ContentHash, UxfElement>,
  instanceChains: Map<ContentHash, InstanceChainEntry> = new Map(),
): UxfPackageData {
  return {
    envelope: { version: '1.0.0', createdAt: 1700000000, updatedAt: 1700000001 },
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

function makeValidToken(suffix: string, predicateHex: string = 'a0'.repeat(32)): Record<string, unknown> {
  const tokenId = hexFill(suffix, 64);
  return {
    version: '2.0',
    state: { predicate: predicateHex, data: null },
    genesis: {
      data: {
        tokenId,
        tokenType: '00'.repeat(32),
        coinData: [['UCT', '1000000']],
        tokenData: '',
        salt: hexFill('ab', 64),
        recipient: 'DIRECT://test',
        recipientDataHash: null,
        reason: null,
      },
      inclusionProof: {
        authenticator: {
          algorithm: 'secp256k1',
          publicKey: '02' + 'aa'.repeat(32),
          signature: '30' + 'bb'.repeat(63),
          stateHash: 'cc'.repeat(32),
        },
        merkleTreePath: {
          root: 'dd'.repeat(32),
          steps: [{ data: 'ee'.repeat(32), path: '0' }],
        },
        transactionHash: 'ff'.repeat(32),
        unicityCertificate: '11'.repeat(100),
      },
    },
    transactions: [],
    nametags: [],
  };
}

function buildPackageFromToken(token: Record<string, unknown>): UxfPackageData {
  const pool = new ElementPool();
  const rootHash = deconstructToken(pool, token);
  const tokenId = ((token.genesis as any).data as any).tokenId.toLowerCase();
  const manifest = new Map<string, ContentHash>();
  manifest.set(tokenId, rootHash);
  return makePackage(manifest, pool.toMap() as Map<ContentHash, UxfElement>);
}

/** Simple Map-based mock KV store. */
class MockKvStorage {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.store.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Tests -- InMemoryUxfStorage
// ---------------------------------------------------------------------------

describe('InMemoryUxfStorage', () => {
  it('save then load round-trips', async () => {
    const storage = new InMemoryUxfStorage();
    const pkg = buildPackageFromToken(makeValidToken('a1'));

    await storage.save(pkg);
    const loaded = await storage.load();

    expect(loaded).not.toBeNull();
    expect(loaded!.pool.size).toBe(pkg.pool.size);
    expect(loaded!.manifest.tokens.size).toBe(pkg.manifest.tokens.size);
    expect(loaded!.envelope.version).toBe(pkg.envelope.version);
    for (const [tokenId, rootHash] of pkg.manifest.tokens) {
      expect(loaded!.manifest.tokens.get(tokenId)).toBe(rootHash);
    }
  });

  it('load returns null before save', async () => {
    const storage = new InMemoryUxfStorage();
    expect(await storage.load()).toBeNull();
  });

  it('clear removes data', async () => {
    const storage = new InMemoryUxfStorage();
    await storage.save(buildPackageFromToken(makeValidToken('a1')));
    await storage.clear();
    expect(await storage.load()).toBeNull();
  });

  it('save deep-clones (no shared references)', async () => {
    const storage = new InMemoryUxfStorage();
    const pkg = buildPackageFromToken(makeValidToken('a1'));
    const originalPoolSize = pkg.pool.size;

    await storage.save(pkg);
    (pkg.pool as Map<ContentHash, UxfElement>).clear();

    const loaded = await storage.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.pool.size).toBe(originalPoolSize);
  });

  it('multiple save/load cycles (overwrite)', async () => {
    const storage = new InMemoryUxfStorage();
    const pkgA = buildPackageFromToken(makeValidToken('a1'));
    const pkgB = buildPackageFromToken(makeValidToken('a2', 'b0'.repeat(32)));

    await storage.save(pkgA);
    await storage.save(pkgB);

    const loaded = await storage.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.pool.size).toBe(pkgB.pool.size);

    const tokenBId = hexFill('a2', 64);
    expect(loaded!.manifest.tokens.has(tokenBId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests -- KvUxfStorageAdapter
// ---------------------------------------------------------------------------

describe('KvUxfStorageAdapter', () => {
  it('save then load round-trips', async () => {
    const kv = new MockKvStorage();
    const adapter = new KvUxfStorageAdapter(kv);
    const pkg = buildPackageFromToken(makeValidToken('a1'));

    await adapter.save(pkg);
    const loaded = await adapter.load();

    expect(loaded).not.toBeNull();
    expect(loaded!.pool.size).toBe(pkg.pool.size);
    expect(loaded!.manifest.tokens.size).toBe(pkg.manifest.tokens.size);
  });

  it('load returns null when key not set', async () => {
    const kv = new MockKvStorage();
    const adapter = new KvUxfStorageAdapter(kv);
    expect(await adapter.load()).toBeNull();
  });

  it('clear calls remove on storage', async () => {
    const kv = new MockKvStorage();
    const adapter = new KvUxfStorageAdapter(kv);
    await adapter.save(buildPackageFromToken(makeValidToken('a1')));
    await adapter.clear();
    expect(await adapter.load()).toBeNull();
  });

  it('uses custom key when provided', async () => {
    const kv = new MockKvStorage();
    const adapter = new KvUxfStorageAdapter(kv, 'custom_key');
    await adapter.save(buildPackageFromToken(makeValidToken('a1')));

    expect(await kv.get('custom_key')).not.toBeNull();
    expect(await kv.get('uxf_package')).toBeNull();
  });

  it('defaults to uxf_package key', async () => {
    const kv = new MockKvStorage();
    const adapter = new KvUxfStorageAdapter(kv);
    await adapter.save(buildPackageFromToken(makeValidToken('a1')));

    expect(await kv.get('uxf_package')).not.toBeNull();
  });
});
