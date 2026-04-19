import { describe, it, expect } from 'vitest';
import { diff, applyDelta } from '../../../uxf/diff.js';
import { verify } from '../../../uxf/verify.js';
import { ElementPool } from '../../../uxf/element-pool.js';
import { deconstructToken } from '../../../uxf/deconstruct.js';
import type {
  ContentHash,
  UxfElement,
  UxfPackageData,
  UxfDelta,
  InstanceChainEntry,
} from '../../../uxf/types.js';
import { contentHash } from '../../../uxf/types.js';

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
    envelope: { version: '1.0.0', createdAt: 0, updatedAt: 0 },
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

function makeTokenWithTransfer(suffix: string): Record<string, unknown> {
  const tokenId = hexFill(suffix, 64);
  return {
    version: '2.0',
    state: { predicate: 'b0'.repeat(32), data: null },
    genesis: {
      data: {
        tokenId,
        tokenType: '00'.repeat(32),
        coinData: [['UCT', '5000000']],
        tokenData: '',
        salt: hexFill('cd', 64),
        recipient: 'DIRECT://addr-1',
        recipientDataHash: null,
        reason: null,
      },
      inclusionProof: {
        authenticator: {
          algorithm: 'secp256k1',
          publicKey: '02' + 'a1'.repeat(32),
          signature: '30' + 'b1'.repeat(63),
          stateHash: 'c1'.repeat(32),
        },
        merkleTreePath: { root: 'd1'.repeat(32), steps: [{ data: 'e1'.repeat(32), path: '0' }] },
        transactionHash: 'f1'.repeat(32),
        unicityCertificate: '22'.repeat(100),
      },
    },
    transactions: [
      {
        data: {
          sourceState: { predicate: 'a0'.repeat(32), data: null },
          recipient: 'DIRECT://addr-2',
          salt: hexFill('ef', 64),
          recipientDataHash: null,
          message: null,
          nametags: [],
        },
        inclusionProof: {
          authenticator: {
            algorithm: 'secp256k1',
            publicKey: '02' + 'a2'.repeat(32),
            signature: '30' + 'b2'.repeat(63),
            stateHash: 'c2'.repeat(32),
          },
          merkleTreePath: { root: 'd2'.repeat(32), steps: [{ data: 'e2'.repeat(32), path: '1' }] },
          transactionHash: 'f2'.repeat(32),
          unicityCertificate: '33'.repeat(100),
        },
      },
    ],
    nametags: [],
  };
}

function buildPackageFromTokens(tokens: Record<string, unknown>[]): UxfPackageData {
  const pool = new ElementPool();
  const manifest = new Map<string, ContentHash>();
  for (const token of tokens) {
    const rootHash = deconstructToken(pool, token);
    const tokenId = ((token.genesis as any).data as any).tokenId.toLowerCase();
    manifest.set(tokenId, rootHash);
  }
  return makePackage(manifest, pool.toMap() as Map<ContentHash, UxfElement>);
}

function clonePackage(pkg: UxfPackageData): UxfPackageData {
  return {
    envelope: { ...pkg.envelope },
    manifest: { tokens: new Map(pkg.manifest.tokens) },
    pool: new Map(pkg.pool),
    instanceChains: new Map(pkg.instanceChains),
    indexes: {
      byTokenType: new Map(pkg.indexes.byTokenType),
      byCoinId: new Map(pkg.indexes.byCoinId),
      byStateHash: new Map(pkg.indexes.byStateHash),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests -- diff
// ---------------------------------------------------------------------------

describe('diff', () => {
  it('identical packages produce empty delta', () => {
    const pkg = buildPackageFromTokens([makeValidToken('a1'), makeValidToken('a2', 'b0'.repeat(32))]);
    const delta = diff(pkg, pkg);
    expect(delta.addedElements.size).toBe(0);
    expect(delta.removedElements.size).toBe(0);
    expect(delta.addedTokens.size).toBe(0);
    expect(delta.removedTokens.size).toBe(0);
    expect(delta.addedChainEntries.size).toBe(0);
  });

  it('added token produces delta with added elements and manifest entry', () => {
    const tokenA = makeValidToken('a1');
    const tokenB = makeValidToken('a2', 'b0'.repeat(32));
    const source = buildPackageFromTokens([tokenA]);
    const target = buildPackageFromTokens([tokenA, tokenB]);
    const delta = diff(source, target);

    expect(delta.addedElements.size).toBeGreaterThan(0);
    expect(delta.addedTokens.size).toBe(1);
    expect(delta.removedTokens.size).toBe(0);
  });

  it('removed token produces delta with removed elements and token ID', () => {
    const tokenA = makeValidToken('a1');
    const tokenB = makeValidToken('a2', 'b0'.repeat(32));
    const source = buildPackageFromTokens([tokenA, tokenB]);
    const target = buildPackageFromTokens([tokenA]);
    const delta = diff(source, target);

    expect(delta.removedElements.size).toBeGreaterThan(0);
    expect(delta.removedTokens.size).toBe(1);
    expect(delta.addedTokens.size).toBe(0);
  });

  it('shared elements are not in added or removed', () => {
    const tokenA = makeValidToken('a1');
    const tokenB = makeValidToken('a2', 'b0'.repeat(32));
    const source = buildPackageFromTokens([tokenA]);
    const target = buildPackageFromTokens([tokenB]);

    const delta = diff(source, target);
    const sharedHashes = new Set<ContentHash>();
    for (const hash of source.pool.keys()) {
      if (target.pool.has(hash)) {
        sharedHashes.add(hash);
      }
    }
    for (const hash of sharedHashes) {
      expect(delta.addedElements.has(hash)).toBe(false);
      expect(delta.removedElements.has(hash)).toBe(false);
    }
  });

  it('instance chain changes detected', () => {
    const tokenA = makeValidToken('a1');
    const source = buildPackageFromTokens([tokenA]);
    const target = clonePackage(source);

    const el1Hash = [...target.pool.keys()][0];
    const chainEntry: InstanceChainEntry = {
      head: el1Hash,
      chain: [{ hash: el1Hash, kind: 'default' }],
    };
    (target.instanceChains as Map<ContentHash, InstanceChainEntry>).set(el1Hash, chainEntry);

    const delta = diff(source, target);
    expect(delta.addedChainEntries.size).toBeGreaterThan(0);
  });

  it('modified token produces addedTokens entry', () => {
    const tokenA = makeValidToken('a1');
    const tokenATx = makeTokenWithTransfer('a1');
    const source = buildPackageFromTokens([tokenA]);
    const target = buildPackageFromTokens([tokenATx]);

    const delta = diff(source, target);
    // Same tokenId but different root hash -> addedTokens
    expect(delta.addedTokens.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests -- applyDelta
// ---------------------------------------------------------------------------

describe('applyDelta', () => {
  it('apply then verify produces no errors', () => {
    const tokenA = makeValidToken('a1');
    const tokenB = makeValidToken('a2', 'b0'.repeat(32));
    const source = buildPackageFromTokens([tokenA]);
    const target = buildPackageFromTokens([tokenA, tokenB]);
    const delta = diff(source, target);

    applyDelta(source, delta);
    const result = verify(source);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('corrupted element in delta throws VERIFICATION_FAILED', () => {
    const tokenA = makeValidToken('a1');
    const tokenB = makeValidToken('a2', 'b0'.repeat(32));
    const source = buildPackageFromTokens([tokenA]);
    const target = buildPackageFromTokens([tokenA, tokenB]);
    const delta = diff(source, target);

    const mutableAdded = delta.addedElements as Map<ContentHash, UxfElement>;
    const [hash, element] = [...mutableAdded.entries()][0];
    mutableAdded.set(hash, { ...element, content: { ...element.content, _tampered: 'yes' } });

    expect(() => applyDelta(source, delta)).toThrow(/VERIFICATION_FAILED/);
  });

  it('round-trip: diff(a, b) then apply to a produces package equivalent to b', () => {
    const tokenA = makeValidToken('a1');
    const tokenB = makeValidToken('a2', 'b0'.repeat(32));
    const a = buildPackageFromTokens([tokenA]);
    const b = buildPackageFromTokens([tokenA, tokenB]);
    const delta = diff(a, b);
    applyDelta(a, delta);

    expect(a.manifest.tokens.size).toBe(b.manifest.tokens.size);
    for (const [tokenId, rootHash] of b.manifest.tokens) {
      expect(a.manifest.tokens.get(tokenId)).toBe(rootHash);
    }
    expect(a.pool.size).toBe(b.pool.size);
  });

  it('idempotent: applying delta of identical packages is a no-op', () => {
    const a = buildPackageFromTokens([makeValidToken('a1')]);
    const originalSize = a.pool.size;
    const delta = diff(a, a);
    applyDelta(a, delta);
    expect(a.pool.size).toBe(originalSize);
  });

  it('already-existing elements in addedElements are no-ops', () => {
    const a = buildPackageFromTokens([makeValidToken('a1')]);
    const originalSize = a.pool.size;

    const [hash, element] = [...a.pool.entries()][0];
    const delta: UxfDelta = {
      addedElements: new Map([[hash, element]]),
      removedElements: new Set(),
      addedTokens: new Map(),
      removedTokens: new Set(),
      addedChainEntries: new Map(),
    };
    applyDelta(a, delta);
    expect(a.pool.size).toBe(originalSize);
  });

  it('non-existent hashes in removedElements are no-ops', () => {
    const a = buildPackageFromTokens([makeValidToken('a1')]);
    const originalSize = a.pool.size;
    const delta: UxfDelta = {
      addedElements: new Map(),
      removedElements: new Set([contentHash('f0'.repeat(32))]),
      addedTokens: new Map(),
      removedTokens: new Set(),
      addedChainEntries: new Map(),
    };
    applyDelta(a, delta);
    expect(a.pool.size).toBe(originalSize);
  });
});
