import { describe, it, expect } from 'vitest';
import { packageToJson, packageFromJson } from '../../../extensions/uxf/bundle/json.js';
import { verify } from '../../../extensions/uxf/bundle/verify.js';
import { ElementPool } from '../../../extensions/uxf/bundle/element-pool.js';
import { deconstructToken } from '../../../extensions/uxf/bundle/deconstruct.js';
import { ELEMENT_TYPE_IDS } from '../../../extensions/uxf/bundle/types.js';
import type {
  ContentHash,
  UxfElement,
  UxfPackageData,
  InstanceChainEntry,
} from '../../../extensions/uxf/bundle/types.js';

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

      // Verify structural equality
      const result = verify(restored);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
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
      // FIX 6 note: tokenId itself must now match /^[0-9a-f]{64}$/, so use
      // a structurally-valid tokenId. The invalid contentHash on the
      // VALUE side is what we want to surface as INVALID_HASH.
      const validTokenId = 'a'.repeat(64);
      const json = JSON.stringify({
        uxf: '1.0.0',
        metadata: { version: '1.0.0', createdAt: 0, updatedAt: 0, elementCount: 0, tokenCount: 0 },
        manifest: { [validTokenId]: 'ABCD' },
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

  // Steelman⁴⁹ regression: ensure dangling-manifest entries are
  // rejected at the serialize boundary instead of silently soft-failing.
  describe('dangling manifest fail-closed (steelman⁴⁹)', () => {
    it('packageToJson throws MISSING_ELEMENT for manifest entry whose root is absent from pool', async () => {
      const pkg = buildPackageFromToken(makeValidToken('a1'));
      // Forge a manifest entry that points at a hash NOT in the pool.
      const ghostHash = '00'.repeat(32) as ContentHash;
      (pkg.manifest.tokens as Map<string, ContentHash>).set('ghost-token-id', ghostHash);
      const { UxfError } = await import('../../../extensions/uxf/bundle/errors.js');
      try {
        packageToJson(pkg);
        throw new Error('expected packageToJson to throw');
      } catch (e) {
        expect(e).toBeInstanceOf(UxfError);
        expect((e as InstanceType<typeof UxfError>).code).toBe('MISSING_ELEMENT');
        expect(String(e)).toMatch(/ghost-token-id/);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Steelman regression — FIX 6: manifest tokenId regex validation on import.
// ---------------------------------------------------------------------------

describe('packageFromJson — manifest tokenId validation (FIX 6)', () => {
  function makeMinimalJson(manifest: Record<string, string>): string {
    return JSON.stringify({
      uxf: '1.0.0',
      metadata: {
        version: '1.0.0',
        createdAt: 1,
        updatedAt: 1,
        elementCount: 0,
        tokenCount: Object.keys(manifest).length,
      },
      manifest,
      instanceChainIndex: {},
      indexes: { byTokenType: {}, byCoinId: {}, byStateHash: {} },
      elements: {},
    });
  }

  it('rejects __proto__ as manifest tokenId', () => {
    // Hand-craft JSON: passing `{ __proto__: ... }` to JSON.stringify
    // sets the prototype rather than emitting a `__proto__` key, so
    // we string-build the JSON to make the malicious key reach the
    // parse boundary.
    const json = '{"uxf":"1.0.0","metadata":{"version":"1.0.0","createdAt":1,"updatedAt":1,"elementCount":0,"tokenCount":0},"manifest":{"__proto__":"' + 'a'.repeat(64) + '"},"instanceChainIndex":{},"indexes":{"byTokenType":{},"byCoinId":{},"byStateHash":{}},"elements":{}}';
    let err: any;
    try {
      packageFromJson(json);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('SERIALIZATION_ERROR');
    expect(String(err.message)).toMatch(/Invalid manifest tokenId/);
  });

  it('rejects empty-string manifest tokenId', () => {
    const json = makeMinimalJson({ '': 'a'.repeat(64) });
    let err: any;
    try {
      packageFromJson(json);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('SERIALIZATION_ERROR');
  });

  it('rejects non-hex unicode tokenId', () => {
    const json = makeMinimalJson({ ['zz'.repeat(32)]: 'a'.repeat(64) });
    let err: any;
    try {
      packageFromJson(json);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('SERIALIZATION_ERROR');
  });

  it('rejects 69-char hex tokenId (above the 64-68 valid range, #226)', () => {
    // #226 relaxed the regex from `{64}` to `{64,68}` so invoice
    // tokenIds (imprint form, 68 chars) survive round-trip. Anything
    // strictly outside [64, 68] is still rejected.
    const json = makeMinimalJson({ ['ab'.repeat(34) + 'a']: 'a'.repeat(64) }); // 69 chars
    let err: any;
    try {
      packageFromJson(json);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('SERIALIZATION_ERROR');
  });

  it('rejects 63-char hex tokenId', () => {
    const json = makeMinimalJson({ ['ab'.repeat(31) + 'a']: 'a'.repeat(64) });
    let err: any;
    try {
      packageFromJson(json);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('SERIALIZATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
// Steelman regression — FIX 7: NaN/Infinity rejection in requireNumber +
// integer/non-negative checks for createdAt/updatedAt.
// ---------------------------------------------------------------------------

describe('packageFromJson — timestamp validation (FIX 7)', () => {
  function makeJsonWithCreatedAt(createdAt: unknown): string {
    return JSON.stringify({
      uxf: '1.0.0',
      metadata: {
        version: '1.0.0',
        createdAt,
        updatedAt: 1,
        elementCount: 0,
        tokenCount: 0,
      },
      manifest: {},
      instanceChainIndex: {},
      indexes: { byTokenType: {}, byCoinId: {}, byStateHash: {} },
      elements: {},
    });
  }

  // Note: JSON.stringify drops NaN/Infinity to `null`. We hand-craft a
  // JSON string with literal `NaN`/`Infinity` to exercise the parser's
  // typeof-narrowing path. JSON.parse will reject literal NaN/Infinity
  // outright, so the malformed-payload path lands inside the JSON.parse
  // try/catch (SERIALIZATION_ERROR). Either way the call MUST throw.
  it('rejects literal NaN createdAt (parse-error or typed-error)', () => {
    const json = '{"uxf":"1.0.0","metadata":{"version":"1.0.0","createdAt":NaN,"updatedAt":1,"elementCount":0,"tokenCount":0},"manifest":{},"instanceChainIndex":{},"indexes":{"byTokenType":{},"byCoinId":{},"byStateHash":{}},"elements":{}}';
    let err: any;
    try {
      packageFromJson(json);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('SERIALIZATION_ERROR');
  });

  it('rejects literal Infinity createdAt', () => {
    const json = '{"uxf":"1.0.0","metadata":{"version":"1.0.0","createdAt":Infinity,"updatedAt":1,"elementCount":0,"tokenCount":0},"manifest":{},"instanceChainIndex":{},"indexes":{"byTokenType":{},"byCoinId":{},"byStateHash":{}},"elements":{}}';
    let err: any;
    try {
      packageFromJson(json);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('SERIALIZATION_ERROR');
  });

  it('rejects negative createdAt', () => {
    const json = makeJsonWithCreatedAt(-1);
    let err: any;
    try {
      packageFromJson(json);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('SERIALIZATION_ERROR');
    expect(String(err.message)).toMatch(/non-negative integer/);
  });

  it('rejects fractional createdAt', () => {
    const json = makeJsonWithCreatedAt(1.5);
    let err: any;
    try {
      packageFromJson(json);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('SERIALIZATION_ERROR');
    expect(String(err.message)).toMatch(/non-negative integer/);
  });

  it('accepts createdAt: 0 (legitimate boundary)', () => {
    const json = makeJsonWithCreatedAt(0);
    // Should NOT throw (0 is a valid non-negative integer).
    const pkg = packageFromJson(json);
    expect(pkg.envelope.createdAt).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Steelman regression — FIX 8: version literal whitelist.
// ---------------------------------------------------------------------------

describe('packageFromJson — version whitelist (FIX 8)', () => {
  function makeJsonWithVersion(version: unknown): string {
    return JSON.stringify({
      uxf: version,
      metadata: { version: '1.0.0', createdAt: 1, updatedAt: 1, elementCount: 0, tokenCount: 0 },
      manifest: {},
      instanceChainIndex: {},
      indexes: { byTokenType: {}, byCoinId: {}, byStateHash: {} },
      elements: {},
    });
  }

  it('rejects version "99.0.0"', () => {
    const json = makeJsonWithVersion('99.0.0');
    let err: any;
    try {
      packageFromJson(json);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('SERIALIZATION_ERROR');
    expect(String(err.message)).toMatch(/Unsupported uxf version/);
  });

  it('rejects empty-string version', () => {
    const json = makeJsonWithVersion('');
    let err: any;
    try {
      packageFromJson(json);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('SERIALIZATION_ERROR');
    expect(String(err.message)).toMatch(/Unsupported uxf version/);
  });

  it('rejects "DROP TABLE" SQL-injection-style version', () => {
    const json = makeJsonWithVersion('DROP TABLE');
    let err: any;
    try {
      packageFromJson(json);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('SERIALIZATION_ERROR');
  });

  it('accepts canonical version "1.0.0"', () => {
    const json = makeJsonWithVersion('1.0.0');
    const pkg = packageFromJson(json);
    expect(pkg.envelope.version).toBe('1.0.0');
  });
});

// ---------------------------------------------------------------------------
// Steelman regression — FIX 9: MANIFEST_MAX_SIZE cap on import.
// ---------------------------------------------------------------------------

describe('packageFromJson — manifest size cap (FIX 9)', () => {
  it('rejects manifest with >MANIFEST_MAX_SIZE entries with LIMIT_EXCEEDED', () => {
    // Generate 100_001 valid 64-char hex keys; even without elements,
    // the manifest size cap MUST fire before the loop iterates.
    const manifest: Record<string, string> = {};
    for (let i = 0; i <= 100_000; i++) {
      // Pad i to 64 hex chars deterministically.
      const k = i.toString(16).padStart(64, '0');
      manifest[k] = 'a'.repeat(64);
    }
    const json = JSON.stringify({
      uxf: '1.0.0',
      metadata: { version: '1.0.0', createdAt: 1, updatedAt: 1, elementCount: 0, tokenCount: Object.keys(manifest).length },
      manifest,
      instanceChainIndex: {},
      indexes: { byTokenType: {}, byCoinId: {}, byStateHash: {} },
      elements: {},
    });
    let err: any;
    try {
      packageFromJson(json);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('LIMIT_EXCEEDED');
    expect(String(err.message)).toMatch(/Manifest entry count exceeds/);
  });
});

// ---------------------------------------------------------------------------
// Steelman³ regression — FIX 1 (Round 3): ELEMENTS_MAX_SIZE pool size cap.
// ---------------------------------------------------------------------------

describe('packageFromJson — elements pool size cap (FIX 1, Round 3)', () => {
  it('rejects elements pool with >ELEMENTS_MAX_SIZE entries with LIMIT_EXCEEDED', () => {
    // Generate 100_001 valid 64-char hex element keys. The bodies are
    // arbitrary objects — the cap MUST fire BEFORE any element body is
    // processed (no contentHash + computeElementHash invocations).
    const elements: Record<string, unknown> = {};
    for (let i = 0; i <= 100_000; i++) {
      const k = i.toString(16).padStart(64, '0');
      // Minimal element shape; will never be inspected because the cap
      // fires first.
      elements[k] = {
        header: { representation: 1, semantics: 1, kind: 'default', predecessor: null },
        type: 0,
        content: {},
        children: {},
      };
    }
    const json = JSON.stringify({
      uxf: '1.0.0',
      metadata: {
        version: '1.0.0',
        createdAt: 1,
        updatedAt: 1,
        elementCount: Object.keys(elements).length,
        tokenCount: 0,
      },
      manifest: {},
      instanceChainIndex: {},
      indexes: { byTokenType: {}, byCoinId: {}, byStateHash: {} },
      elements,
    });
    let err: any;
    try {
      packageFromJson(json);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('LIMIT_EXCEEDED');
    expect(String(err.message)).toMatch(/Elements pool size exceeds ELEMENTS_MAX_SIZE/);
  });
});

// ---------------------------------------------------------------------------
// Steelman³ regression — FIX 3 (Round 3): meta.creator/description type guards.
// ---------------------------------------------------------------------------

describe('packageFromJson — meta.creator/description type guards (FIX 3, Round 3)', () => {
  function makeJsonWithMeta(meta: Record<string, unknown>): string {
    return JSON.stringify({
      uxf: '1.0.0',
      metadata: {
        version: '1.0.0',
        createdAt: 1,
        updatedAt: 1,
        elementCount: 0,
        tokenCount: 0,
        ...meta,
      },
      manifest: {},
      instanceChainIndex: {},
      indexes: { byTokenType: {}, byCoinId: {}, byStateHash: {} },
      elements: {},
    });
  }

  it('rejects meta.creator: 42 (number) with SERIALIZATION_ERROR', () => {
    const json = makeJsonWithMeta({ creator: 42 });
    let err: any;
    try {
      packageFromJson(json);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('SERIALIZATION_ERROR');
    expect(String(err.message)).toMatch(/Invalid "creator"/);
  });

  it('rejects meta.creator: { __proto__: ... } (object) with SERIALIZATION_ERROR', () => {
    const json = makeJsonWithMeta({ creator: { evil: true } });
    let err: any;
    try {
      packageFromJson(json);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('SERIALIZATION_ERROR');
  });

  it('rejects meta.description: 42 (number) with SERIALIZATION_ERROR', () => {
    const json = makeJsonWithMeta({ description: 42 });
    let err: any;
    try {
      packageFromJson(json);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('SERIALIZATION_ERROR');
    expect(String(err.message)).toMatch(/Invalid "description"/);
  });

  it('rejects meta.description: [] (array) with SERIALIZATION_ERROR', () => {
    const json = makeJsonWithMeta({ description: [] });
    let err: any;
    try {
      packageFromJson(json);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('SERIALIZATION_ERROR');
  });

  it('accepts meta.creator: undefined / absent (legitimate)', () => {
    const json = makeJsonWithMeta({});
    const pkg = packageFromJson(json);
    expect(pkg.envelope.creator).toBeUndefined();
  });

  it('accepts meta.creator: "alice" (legitimate string)', () => {
    const json = makeJsonWithMeta({ creator: 'alice' });
    const pkg = packageFromJson(json);
    expect(pkg.envelope.creator).toBe('alice');
  });
});

// ---------------------------------------------------------------------------
// Steelman³ regression — FIX 4 (Round 3): length caps on creator / description.
// ---------------------------------------------------------------------------

describe('packageFromJson — creator/description length caps (FIX 4, Round 3)', () => {
  function makeJsonWithMeta(meta: Record<string, unknown>): string {
    return JSON.stringify({
      uxf: '1.0.0',
      metadata: {
        version: '1.0.0',
        createdAt: 1,
        updatedAt: 1,
        elementCount: 0,
        tokenCount: 0,
        ...meta,
      },
      manifest: {},
      instanceChainIndex: {},
      indexes: { byTokenType: {}, byCoinId: {}, byStateHash: {} },
      elements: {},
    });
  }

  it('rejects 257-char creator with LIMIT_EXCEEDED', () => {
    const json = makeJsonWithMeta({ creator: 'a'.repeat(257) });
    let err: any;
    try {
      packageFromJson(json);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('LIMIT_EXCEEDED');
    expect(String(err.message)).toMatch(/MAX_CREATOR_LENGTH/);
  });

  it('rejects 1025-char description with LIMIT_EXCEEDED', () => {
    const json = makeJsonWithMeta({ description: 'd'.repeat(1025) });
    let err: any;
    try {
      packageFromJson(json);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('LIMIT_EXCEEDED');
    expect(String(err.message)).toMatch(/MAX_DESCRIPTION_LENGTH/);
  });

  it('accepts 256-char creator (boundary)', () => {
    const json = makeJsonWithMeta({ creator: 'a'.repeat(256) });
    const pkg = packageFromJson(json);
    expect(pkg.envelope.creator?.length).toBe(256);
  });

  it('accepts 1024-char description (boundary)', () => {
    const json = makeJsonWithMeta({ description: 'd'.repeat(1024) });
    const pkg = packageFromJson(json);
    expect(pkg.envelope.description?.length).toBe(1024);
  });
});
