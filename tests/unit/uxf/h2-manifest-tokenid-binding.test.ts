/**
 * Tests for Audit #333 H2 — UXF manifest tokenId binding.
 *
 * Background
 * ----------
 * Before the H2 fix, the manifest entry `tokenId → rootHash` was only
 * regex-shape-checked at the import boundary (uxf/json.ts:430,
 * uxf/ipld.ts:555) and never asserted equal to the genesis tokenId
 * encoded in the referenced token-root element. Every element hash
 * still self-verified, so a hostile sender could craft a manifest
 * mapping `tokenId=A → root-that-mints-tokenId=B` and every existing
 * gate would pass. Downstream consumers that trust the manifest key
 * (dedup, ownership filtering, balance computation) would mis-identify
 * the token — an identity-confusion primitive.
 *
 * Fix
 * ---
 *   - `uxf/verify.ts` now asserts `pool.get(rootHash).content.tokenId ===
 *     manifestKey` for every manifest entry. Mismatches surface as
 *     `MANIFEST_TOKENID_MISMATCH` verification errors. Non-root types
 *     surface as `MANIFEST_TYPE_MISMATCH`.
 *   - `uxf/json.ts:packageFromJson` and `uxf/ipld.ts:importFromCar`
 *     reject at the import boundary with `VERIFICATION_FAILED` so
 *     consumers bypassing verify() still get the protection.
 */

import { describe, it, expect } from 'vitest';
import { packageToJson, packageFromJson } from '../../../extensions/uxf/bundle/json.js';
import { exportToCar, importFromCar } from '../../../extensions/uxf/bundle/ipld.js';
import { verify } from '../../../extensions/uxf/bundle/verify.js';
import { ElementPool } from '../../../extensions/uxf/bundle/element-pool.js';
import { deconstructToken } from '../../../extensions/uxf/bundle/deconstruct.js';
import { UxfError } from '../../../extensions/uxf/bundle/errors.js';
import type {
  ContentHash,
  UxfElement,
  UxfPackageData,
  InstanceChainEntry,
} from '../../../extensions/uxf/bundle/types.js';

// ---------------------------------------------------------------------------
// Test fixture helpers (adapted from tests/unit/uxf/json.test.ts)
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

function makeValidToken(suffix: string): Record<string, unknown> {
  const tokenId = hexFill(suffix, 64);
  return {
    version: '2.0',
    state: { predicate: 'a0'.repeat(32), data: null },
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
  const tokenId = (
    (token.genesis as { data: { tokenId: string } }).data.tokenId
  ).toLowerCase();
  const manifest = new Map<string, ContentHash>();
  manifest.set(tokenId, rootHash);
  return makePackage(manifest, pool.toMap() as Map<ContentHash, UxfElement>);
}

/**
 * Construct a UxfPackageData with a manifest deliberately mapping the
 * WRONG tokenId to a real token-root. The pool still self-verifies (the
 * root element's hash matches its content), but the manifest key lies
 * about which tokenId it represents.
 */
function buildBundleWithSpoofedManifestKey(): {
  spoofedKey: string;
  realTokenId: string;
  pkg: UxfPackageData;
} {
  const token = makeValidToken('aa');
  const realTokenId = (
    (token.genesis as { data: { tokenId: string } }).data.tokenId
  ).toLowerCase();
  // Pick a different valid-shape tokenId for the spoofed key.
  const spoofedKey = hexFill('cc', 64);
  expect(spoofedKey).not.toBe(realTokenId);

  const pool = new ElementPool();
  const rootHash = deconstructToken(pool, token);
  const manifest = new Map<string, ContentHash>();
  manifest.set(spoofedKey, rootHash);
  return {
    spoofedKey,
    realTokenId,
    pkg: makePackage(manifest, pool.toMap() as Map<ContentHash, UxfElement>),
  };
}

/**
 * Construct a UxfPackageData whose manifest points at an element of
 * the WRONG type (e.g., a `genesis` element rather than a `token-root`).
 * Pool self-verifies but the entry is structurally meaningless as a
 * manifest root.
 */
function buildBundleWithWrongElementType(): {
  manifestKey: string;
  pkg: UxfPackageData;
} {
  const token = makeValidToken('dd');
  const realTokenId = (
    (token.genesis as { data: { tokenId: string } }).data.tokenId
  ).toLowerCase();

  const pool = new ElementPool();
  deconstructToken(pool, token);
  // Find a non-root element in the pool to use as the bogus manifest target.
  let bogusHash: ContentHash | null = null;
  for (const [hash, el] of pool.toMap()) {
    if (el.type !== 'token-root') {
      bogusHash = hash;
      break;
    }
  }
  if (bogusHash === null) throw new Error('test bug: no non-root element');

  const manifest = new Map<string, ContentHash>();
  manifest.set(realTokenId, bogusHash);
  return {
    manifestKey: realTokenId,
    pkg: makePackage(manifest, pool.toMap() as Map<ContentHash, UxfElement>),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Audit #333 H2 — manifest tokenId binding', () => {
  describe('verify() — primary structural-integrity gate', () => {
    it('passes for a correctly-bound manifest (regression baseline)', () => {
      const pkg = buildPackageFromToken(makeValidToken('a1'));
      const result = verify(pkg);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('reports MANIFEST_TOKENID_MISMATCH when the manifest key does not match the root content.tokenId', () => {
      const { spoofedKey, realTokenId, pkg } = buildBundleWithSpoofedManifestKey();
      const result = verify(pkg);
      expect(result.valid).toBe(false);
      const mismatch = result.errors.find(
        (e) => e.code === 'MANIFEST_TOKENID_MISMATCH',
      );
      expect(mismatch).toBeDefined();
      expect(mismatch!.message).toContain(spoofedKey);
      expect(mismatch!.message).toContain(realTokenId);
      expect(mismatch!.tokenId).toBe(spoofedKey);
    });

    it('reports MANIFEST_TYPE_MISMATCH when the manifest points at a non-root element', () => {
      const { pkg } = buildBundleWithWrongElementType();
      const result = verify(pkg);
      expect(result.valid).toBe(false);
      const typeMismatch = result.errors.find(
        (e) => e.code === 'MANIFEST_TYPE_MISMATCH',
      );
      expect(typeMismatch).toBeDefined();
      expect(typeMismatch!.message).toMatch(/expected 'token-root'/);
    });
  });

  describe('json import boundary — fail-fast rejection', () => {
    it('rejects a spoofed-key bundle with VERIFICATION_FAILED', () => {
      const { spoofedKey, realTokenId, pkg } = buildBundleWithSpoofedManifestKey();
      const json = packageToJson(pkg);

      let thrown: unknown = null;
      try {
        packageFromJson(json);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(UxfError);
      const err = thrown as UxfError;
      expect(err.code).toBe('VERIFICATION_FAILED');
      expect(err.message).toMatch(/Audit #333 H2/);
      expect(err.message).toContain(spoofedKey);
      expect(err.message).toContain(realTokenId);
    });

    it('rejects a wrong-element-type manifest at the json boundary', () => {
      const { pkg } = buildBundleWithWrongElementType();
      const json = packageToJson(pkg);

      let thrown: unknown = null;
      try {
        packageFromJson(json);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(UxfError);
      const err = thrown as UxfError;
      expect(err.code).toBe('VERIFICATION_FAILED');
      expect(err.message).toMatch(/expected 'token-root'/);
    });

    it('accepts a correctly-bound bundle (no regression)', () => {
      const pkg = buildPackageFromToken(makeValidToken('a1'));
      const json = packageToJson(pkg);
      const restored = packageFromJson(json);
      expect(restored.manifest.tokens.size).toBe(1);
    });
  });

  describe('CAR import boundary — fail-fast rejection', () => {
    it('rejects a spoofed-key bundle at the CAR boundary', async () => {
      const { pkg } = buildBundleWithSpoofedManifestKey();
      // exportToCar SHOULD succeed — the export side does not assert
      // the binding (audit didn't flag exporters), so we exercise the
      // adversary's full path: produce a CAR with a spoofed manifest
      // and verify the receiver rejects on import.
      const car = await exportToCar(pkg);
      await expect(importFromCar(car)).rejects.toMatchObject({
        code: 'VERIFICATION_FAILED',
        message: expect.stringMatching(/Audit #333 H2/),
      });
    });

    it('accepts a correctly-bound bundle via CAR (no regression)', async () => {
      const pkg = buildPackageFromToken(makeValidToken('a1'));
      const car = await exportToCar(pkg);
      const restored = await importFromCar(car);
      expect(restored.manifest.tokens.size).toBe(1);
    });
  });
});
