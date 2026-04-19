import { describe, it, expect } from 'vitest';
import {
  computeCid,
  contentHashToCid,
  cidToContentHash,
  elementToIpldBlock,
  exportToCar,
  importFromCar,
} from '../../../uxf/ipld.js';
import { verify } from '../../../uxf/verify.js';
import { ElementPool } from '../../../uxf/element-pool.js';
import { deconstructToken } from '../../../uxf/deconstruct.js';
import { computeElementHash } from '../../../uxf/hash.js';
import { CID } from 'multiformats';
import { decode as dagCborDecode } from '@ipld/dag-cbor';
import type {
  ContentHash,
  UxfElement,
  UxfPackageData,
  InstanceChainEntry,
} from '../../../uxf/types.js';
import { contentHash } from '../../../uxf/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexFill(pattern: string, totalChars: number): string {
  return pattern.repeat(Math.ceil(totalChars / pattern.length)).slice(0, totalChars);
}

function makeElement(
  type: UxfElement['type'],
  content: Record<string, unknown> = {},
  children: Record<string, ContentHash | ContentHash[] | null> = {},
): UxfElement {
  return {
    header: { representation: 1, semantics: 1, kind: 'default', predecessor: null },
    type,
    content,
    children,
  };
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

// ---------------------------------------------------------------------------
// Tests -- computeCid
// ---------------------------------------------------------------------------

describe('computeCid', () => {
  it('deterministic: same element produces same CID', () => {
    const el = makeElement('token-state', { predicate: 'a0'.repeat(32), data: null });
    const cid1 = computeCid(el);
    const cid2 = computeCid(el);
    expect(cid1.toString()).toBe(cid2.toString());
  });

  it('CID uses dag-cbor codec (0x71)', () => {
    const el = makeElement('token-state', { predicate: 'a0'.repeat(32), data: null });
    const cid = computeCid(el);
    expect(cid.code).toBe(0x71);
  });

  it('CID uses sha2-256 hash (0x12)', () => {
    const el = makeElement('token-state', { predicate: 'a0'.repeat(32), data: null });
    const cid = computeCid(el);
    expect(cid.multihash.code).toBe(0x12);
  });
});

// ---------------------------------------------------------------------------
// Tests -- contentHashToCid / cidToContentHash
// ---------------------------------------------------------------------------

describe('contentHashToCid / cidToContentHash', () => {
  it('CID digest matches ContentHash', () => {
    const el = makeElement('token-state', { predicate: 'a0'.repeat(32), data: null });
    const hash = computeElementHash(el);
    const cid = computeCid(el);
    expect(cidToContentHash(cid)).toBe(hash);
  });

  it('round-trip: contentHashToCid then cidToContentHash', () => {
    const hash = contentHash('a0'.repeat(32));
    const cid = contentHashToCid(hash);
    expect(cidToContentHash(cid)).toBe(hash);
  });

  it('non-sha256 CID throws SERIALIZATION_ERROR', () => {
    const fakeDigest = new Uint8Array(32).fill(0xaa);
    const fakeMultihashBytes = new Uint8Array(2 + 32);
    fakeMultihashBytes[0] = 0x14; // sha3-256
    fakeMultihashBytes[1] = 32;
    fakeMultihashBytes.set(fakeDigest, 2);
    const fakeMultihash = { code: 0x14, size: 32, digest: fakeDigest, bytes: fakeMultihashBytes };
    const fakeCid = CID.createV1(0x71, fakeMultihash);

    expect(() => cidToContentHash(fakeCid)).toThrow(/SERIALIZATION_ERROR/);
  });
});

// ---------------------------------------------------------------------------
// Tests -- elementToIpldBlock
// ---------------------------------------------------------------------------

describe('elementToIpldBlock', () => {
  it('returns cid and bytes', () => {
    const el = makeElement('token-state', { predicate: 'a0'.repeat(32), data: null });
    const block = elementToIpldBlock(el);
    expect(block.cid).toBeDefined();
    expect(block.bytes).toBeInstanceOf(Uint8Array);
    expect(block.bytes.length).toBeGreaterThan(0);
  });

  it('children encoded as CID links (not raw hash bytes)', () => {
    const pkg = buildPackageFromToken(makeValidToken('a1'));

    for (const [, element] of pkg.pool) {
      const childValues = Object.values(element.children).filter((v) => v !== null);
      if (childValues.length > 0) {
        const block = elementToIpldBlock(element);
        const decoded = dagCborDecode(block.bytes) as Record<string, any>;

        for (const [, value] of Object.entries(decoded.children)) {
          if (value !== null) {
            if (Array.isArray(value)) {
              for (const item of value) {
                expect(item).toBeInstanceOf(CID);
              }
            } else {
              expect(value).toBeInstanceOf(CID);
            }
          }
        }
        return;
      }
    }
    expect.fail('No element with children found');
  });

  it('CID matches computeElementHash', () => {
    const el = makeElement('token-state', { predicate: 'a0'.repeat(32), data: null });
    const block = elementToIpldBlock(el);
    const hash = computeElementHash(el);
    expect(cidToContentHash(block.cid)).toBe(hash);
  });
});

// ---------------------------------------------------------------------------
// Tests -- exportToCar / importFromCar
// ---------------------------------------------------------------------------

describe('exportToCar / importFromCar', () => {
  it('round-trip preserves package', async () => {
    const pkg = buildPackageFromToken(makeValidToken('a1'));
    const car = await exportToCar(pkg);
    const restored = await importFromCar(car);

    expect(restored.pool.size).toBe(pkg.pool.size);
    expect(restored.manifest.tokens.size).toBe(pkg.manifest.tokens.size);
    for (const [tokenId, rootHash] of pkg.manifest.tokens) {
      expect(restored.manifest.tokens.get(tokenId)).toBe(rootHash);
    }
    for (const hash of pkg.pool.keys()) {
      expect(restored.pool.has(hash)).toBe(true);
    }
  });

  it('round-trip package verifies with no errors', async () => {
    const pkg = buildPackageFromToken(makeValidToken('a1'));
    const car = await exportToCar(pkg);
    const restored = await importFromCar(car);
    const result = verify(restored);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('envelope preserved in round-trip', async () => {
    const pkg = buildPackageFromToken(makeValidToken('a1'));
    const car = await exportToCar(pkg);
    const restored = await importFromCar(car);

    expect(restored.envelope.version).toBe(pkg.envelope.version);
    expect(restored.envelope.createdAt).toBe(pkg.envelope.createdAt);
    expect(restored.envelope.updatedAt).toBe(pkg.envelope.updatedAt);
  });

  it('shared elements appear once in multi-token CAR', async () => {
    const pkg = buildPackageFromTokens([makeValidToken('a1'), makeValidToken('a2', 'b0'.repeat(32))]);
    const car = await exportToCar(pkg);
    const restored = await importFromCar(car);
    expect(restored.pool.size).toBe(pkg.pool.size);
  });

  it('empty package round-trips', async () => {
    const emptyPkg = makePackage(new Map(), new Map());
    const car = await exportToCar(emptyPkg);
    const restored = await importFromCar(car);

    expect(restored.pool.size).toBe(0);
    expect(restored.manifest.tokens.size).toBe(0);
    expect(restored.envelope.version).toBe('1.0.0');
  });

  it('hash verification during CAR import detects tampering', async () => {
    const pkg = buildPackageFromToken(makeValidToken('a1'));
    const car = await exportToCar(pkg);

    const tampered = new Uint8Array(car);
    const idx = Math.floor(tampered.length * 0.75);
    tampered[idx] = tampered[idx] ^ 0xff;

    await expect(importFromCar(tampered)).rejects.toThrow();
  });
});
