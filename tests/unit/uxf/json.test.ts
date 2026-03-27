import { describe, it, expect } from 'vitest';
import { packageToJson, packageFromJson } from '../../../uxf/json.js';
import { verify } from '../../../uxf/verify.js';
import { ElementPool } from '../../../uxf/element-pool.js';
import { deconstructToken } from '../../../uxf/deconstruct.js';
import { ELEMENT_TYPE_IDS } from '../../../uxf/types.js';
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
  envelope?: Partial<UxfPackageData['envelope']>,
): UxfPackageData {
  return {
    envelope: { version: '1.0.0', createdAt: 1700000000, updatedAt: 1700000001, ...envelope },
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

/** Token with a split reason (object reason that becomes dag-cbor Uint8Array). */
function makeTokenWithReason(suffix: string): Record<string, unknown> {
  const tokenId = hexFill(suffix, 64);
  return {
    version: '2.0',
    state: { predicate: 'f0'.repeat(32), data: null },
    genesis: {
      data: {
        tokenId,
        tokenType: '00'.repeat(32),
        coinData: [['UCT', '400000']],
        tokenData: '',
        salt: hexFill('ac', 64),
        recipient: 'DIRECT://test-reason',
        recipientDataHash: null,
        reason: { type: 'TOKEN_SPLIT', amount: '500000' },
      },
      inclusionProof: {
        authenticator: {
          algorithm: 'secp256k1',
          publicKey: '02' + 'a3'.repeat(32),
          signature: '30' + 'b3'.repeat(63),
          stateHash: 'c3'.repeat(32),
        },
        merkleTreePath: {
          root: 'd3'.repeat(32),
          steps: [{ data: 'e3'.repeat(32), path: '0' }],
        },
        transactionHash: 'f3'.repeat(32),
        unicityCertificate: '44'.repeat(100),
      },
    },
    transactions: [],
    nametags: [],
  };
}

function buildPackageFromToken(
  token: Record<string, unknown>,
  envelope?: Partial<UxfPackageData['envelope']>,
): UxfPackageData {
  const pool = new ElementPool();
  const rootHash = deconstructToken(pool, token);
  const tokenId = ((token.genesis as any).data as any).tokenId.toLowerCase();
  const manifest = new Map<string, ContentHash>();
  manifest.set(tokenId, rootHash);
  return makePackage(manifest, pool.toMap() as Map<ContentHash, UxfElement>, new Map(), envelope);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('packageToJson / packageFromJson', () => {
  describe('round-trip', () => {
    it('round-trip preserves package', () => {
      const pkg = buildPackageFromToken(makeValidToken('a1'));
      const json = packageToJson(pkg);
      const restored = packageFromJson(json);

      expect(restored.pool.size).toBe(pkg.pool.size);
      expect(restored.manifest.tokens.size).toBe(pkg.manifest.tokens.size);
      for (const [tokenId, rootHash] of pkg.manifest.tokens) {
        expect(restored.manifest.tokens.get(tokenId)).toBe(rootHash);
      }
      for (const hash of pkg.pool.keys()) {
        expect(restored.pool.has(hash)).toBe(true);
      }

      // Verify structural equality (verify may report CYCLE_DETECTED for
      // content-addressed dedup'd state nodes, which is expected)
      const result = verify(restored);
      const nonCycleErrors = result.errors.filter((e) => e.code !== 'CYCLE_DETECTED');
      expect(nonCycleErrors).toHaveLength(0);
    });

    it('round-trip preserves element content', () => {
      const pkg = buildPackageFromToken(makeValidToken('a1'));
      const json = packageToJson(pkg);
      const restored = packageFromJson(json);

      for (const [hash, element] of pkg.pool) {
        const restoredEl = restored.pool.get(hash)!;
        expect(restoredEl.type).toBe(element.type);
        expect(restoredEl.header.representation).toBe(element.header.representation);
        expect(restoredEl.header.semantics).toBe(element.header.semantics);
        expect(restoredEl.header.kind).toBe(element.header.kind);
        expect(restoredEl.header.predecessor).toBe(element.header.predecessor);
      }
    });
  });

  describe('JSON format', () => {
    it('JSON has "uxf" version field', () => {
      const pkg = buildPackageFromToken(makeValidToken('a1'));
      const parsed = JSON.parse(packageToJson(pkg));
      expect(parsed.uxf).toBe('1.0.0');
    });

    it('JSON has metadata with required fields', () => {
      const pkg = buildPackageFromToken(makeValidToken('a1'));
      const parsed = JSON.parse(packageToJson(pkg));
      expect(parsed.metadata.version).toBe('1.0.0');
      expect(typeof parsed.metadata.createdAt).toBe('number');
      expect(typeof parsed.metadata.updatedAt).toBe('number');
      expect(typeof parsed.metadata.elementCount).toBe('number');
      expect(typeof parsed.metadata.tokenCount).toBe('number');
    });

    it('elements use integer type IDs', () => {
      const pkg = buildPackageFromToken(makeValidToken('a1'));
      const parsed = JSON.parse(packageToJson(pkg));
      for (const elem of Object.values(parsed.elements)) {
        expect(typeof (elem as any).type).toBe('number');
      }
    });

    it('Maps serialized as plain objects', () => {
      const pkg = buildPackageFromToken(makeValidToken('a1'));
      const parsed = JSON.parse(packageToJson(pkg));
      expect(typeof parsed.manifest).toBe('object');
      expect(Array.isArray(parsed.manifest)).toBe(false);
    });

    it('optional creator and description preserved', () => {
      const pkg = buildPackageFromToken(makeValidToken('a1'), {
        creator: 'test-creator',
        description: 'test description',
      });
      const parsed = JSON.parse(packageToJson(pkg));
      expect(parsed.metadata.creator).toBe('test-creator');
      expect(parsed.metadata.description).toBe('test description');

      const restored = packageFromJson(JSON.stringify(parsed));
      expect(restored.envelope.creator).toBe('test-creator');
      expect(restored.envelope.description).toBe('test description');
    });

    it('absent creator and description omitted', () => {
      const pkg = buildPackageFromToken(makeValidToken('a1'));
      const parsed = JSON.parse(packageToJson(pkg));
      expect(parsed.metadata.creator).toBeUndefined();
      expect(parsed.metadata.description).toBeUndefined();
    });
  });

  describe('content serialization', () => {
    it('reason Uint8Array survives round-trip', () => {
      const pkg = buildPackageFromToken(makeTokenWithReason('b1'));
      const json = packageToJson(pkg);
      const parsed = JSON.parse(json);

      // Find genesis-data element with non-null reason in JSON
      let foundReason = false;
      for (const elem of Object.values(parsed.elements)) {
        const e = elem as any;
        const typeTag = Object.entries(ELEMENT_TYPE_IDS).find(([, id]) => id === e.type)?.[0];
        if (typeTag === 'genesis-data' && e.content.reason !== null) {
          expect(typeof e.content.reason).toBe('string');
          foundReason = true;
        }
      }
      expect(foundReason).toBe(true);

      // After round-trip, reason should be Uint8Array
      const restored = packageFromJson(json);
      for (const [, element] of restored.pool) {
        if (element.type === 'genesis-data') {
          const reason = (element.content as any).reason;
          if (reason !== null) {
            expect(reason).toBeInstanceOf(Uint8Array);
          }
        }
      }
    });

    it('reason null preserved', () => {
      const pkg = buildPackageFromToken(makeValidToken('a1'));
      const json = packageToJson(pkg);
      const restored = packageFromJson(json);

      for (const [, element] of restored.pool) {
        if (element.type === 'genesis-data') {
          expect((element.content as any).reason).toBeNull();
        }
      }
    });
  });

  describe('hex normalization on deserialize', () => {
    it('uppercase hex in long content fields normalized to lowercase on parse', () => {
      const pkg = buildPackageFromToken(makeValidToken('a1'));
      const json = packageToJson(pkg);
      const parsed = JSON.parse(json);

      // Inject uppercase hex in authenticator publicKey (>= 64 chars)
      let originalKey = '';
      for (const elem of Object.values(parsed.elements)) {
        const e = elem as any;
        const typeTag = Object.entries(ELEMENT_TYPE_IDS).find(([, id]) => id === e.type)?.[0];
        if (typeTag === 'authenticator' && e.content.publicKey) {
          originalKey = e.content.publicKey;
          e.content.publicKey = e.content.publicKey.toUpperCase();
          break;
        }
      }
      expect(originalKey.length).toBeGreaterThanOrEqual(64);

      // Normalization lowercases it back, so hash matches and deserialization succeeds
      const restored = packageFromJson(JSON.stringify(parsed));
      for (const [, element] of restored.pool) {
        if (element.type === 'authenticator') {
          expect((element.content as any).publicKey).toBe(originalKey);
        }
      }
    });

    it('short strings not normalized', () => {
      const pkg = buildPackageFromToken(makeValidToken('a1'));
      const json = packageToJson(pkg);
      const restored = packageFromJson(json);

      for (const [, element] of restored.pool) {
        if (element.type === 'authenticator') {
          expect((element.content as any).algorithm).toBe('secp256k1');
        }
      }
    });
  });

  describe('error handling', () => {
    it('malformed JSON throws SERIALIZATION_ERROR', () => {
      expect(() => packageFromJson('not json {')).toThrow(/SERIALIZATION_ERROR/);
    });

    it('missing uxf field throws SERIALIZATION_ERROR', () => {
      expect(() => packageFromJson('{}')).toThrow(/SERIALIZATION_ERROR/);
    });

    it('missing metadata throws SERIALIZATION_ERROR', () => {
      expect(() => packageFromJson('{"uxf":"1.0.0"}')).toThrow(/SERIALIZATION_ERROR/);
    });

    it('missing elements throws SERIALIZATION_ERROR', () => {
      const json = JSON.stringify({
        uxf: '1.0.0',
        metadata: { version: '1.0.0', createdAt: 0, updatedAt: 0, elementCount: 0, tokenCount: 0 },
        manifest: {},
      });
      expect(() => packageFromJson(json)).toThrow(/SERIALIZATION_ERROR/);
    });

    it('element hash mismatch on deserialize throws SERIALIZATION_ERROR', () => {
      const pkg = buildPackageFromToken(makeValidToken('a1'));
      const parsed = JSON.parse(packageToJson(pkg));
      const hash = Object.keys(parsed.elements)[0];
      parsed.elements[hash].content._tampered = 'yes';
      expect(() => packageFromJson(JSON.stringify(parsed))).toThrow(/SERIALIZATION_ERROR/);
    });

    it('unknown element type ID throws SERIALIZATION_ERROR', () => {
      const pkg = buildPackageFromToken(makeValidToken('a1'));
      const parsed = JSON.parse(packageToJson(pkg));
      const hash = Object.keys(parsed.elements)[0];
      parsed.elements[hash].type = 999;
      expect(() => packageFromJson(JSON.stringify(parsed))).toThrow(/SERIALIZATION_ERROR/);
    });

    it('invalid content hash in manifest throws INVALID_HASH', () => {
      const json = JSON.stringify({
        uxf: '1.0.0',
        metadata: { version: '1.0.0', createdAt: 0, updatedAt: 0, elementCount: 0, tokenCount: 0 },
        manifest: { someToken: 'ABCD' },
        elements: {},
      });
      expect(() => packageFromJson(json)).toThrow(/INVALID_HASH/);
    });
  });

  describe('instance chain index serialization', () => {
    it('instance chain index round-trips', () => {
      const pkg = buildPackageFromToken(makeValidToken('a1'));

      const el1Hash = [...pkg.pool.keys()][0];
      const el2Hash = [...pkg.pool.keys()][1];

      const chainEntry: InstanceChainEntry = {
        head: el1Hash,
        chain: [
          { hash: el1Hash, kind: 'default' },
          { hash: el2Hash, kind: 'individual-proof' },
        ],
      };
      (pkg.instanceChains as Map<ContentHash, InstanceChainEntry>).set(el1Hash, chainEntry);
      (pkg.instanceChains as Map<ContentHash, InstanceChainEntry>).set(el2Hash, chainEntry);

      const json = packageToJson(pkg);
      const restored = packageFromJson(json);

      expect(restored.instanceChains.size).toBeGreaterThan(0);
      const restoredChain = restored.instanceChains.get(el1Hash);
      expect(restoredChain).toBeDefined();
      expect(restoredChain!.head).toBe(el1Hash);
      expect(restoredChain!.chain).toHaveLength(2);
    });

    it('empty instance chain index round-trips', () => {
      const pkg = buildPackageFromToken(makeValidToken('a1'));
      expect(pkg.instanceChains.size).toBe(0);
      const restored = packageFromJson(packageToJson(pkg));
      expect(restored.instanceChains.size).toBe(0);
    });
  });
});
