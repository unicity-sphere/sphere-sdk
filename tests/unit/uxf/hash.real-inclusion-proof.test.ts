/**
 * Regression tests for issue #295 — UXF §11 SMT path 256→280-bit relaxation.
 *
 * The fixture under tests/fixtures/uxf/real-testnet-inclusion-proof-long-path.json
 * is a representative `InclusionProof.toJSON()` blob whose
 * `merkleTreePath.steps[].path` values exercise:
 *   - a small value (smoke test)
 *   - the legacy 256-bit ceiling (backward-compat regression)
 *   - the exact 259-bit decimal extracted from the user-reported
 *     sphere.telco migration failure (issue body)
 *   - a 273-bit value (BitString(32-byte hash) boundary)
 *   - the new 280-bit ceiling (BitString(34-byte imprint) maximum)
 *
 * The test round-trips the fixture through:
 *   1. SparseMerkleTreePath.fromJSON() — state-transition-sdk parser
 *   2. prepareSmtSegments() / prepareContentForHashing() — UXF encoder
 *   3. @ipld/dag-cbor encode (canonical form) — must not throw
 *   4. Decoder loop — numerical equality with the fixture inputs
 *
 * Without #295 the encoder threw INVALID_HASH on steps[2] (259 bits).
 * With #295 the encoder emits a variable-length bstr (32 bytes for ≤256-bit,
 * 33–35 bytes for 257–280-bit) and the round-trip preserves every value.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { encode as dagCborEncode } from '@ipld/dag-cbor';

import { SparseMerkleTreePath } from '@unicitylabs/state-transition-sdk/lib/mtree/plain/SparseMerkleTreePath.js';

import { prepareContentForHashing } from '../../../uxf/hash.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(
  __dirname,
  '../../fixtures/uxf/real-testnet-inclusion-proof-long-path.json',
);

interface FixtureShape {
  readonly _provenance: Record<string, unknown>;
  readonly merkleTreePath: {
    readonly root: string;
    readonly steps: ReadonlyArray<{
      readonly path: string;
      readonly data: string | null;
    }>;
  };
}

function loadFixture(): FixtureShape {
  const raw = readFileSync(FIXTURE_PATH, 'utf-8');
  return JSON.parse(raw) as FixtureShape;
}

describe('issue #295 — real-testnet-shaped InclusionProof long-path round-trip', () => {
  it('SparseMerkleTreePath.fromJSON accepts the fixture path values', () => {
    const fixture = loadFixture();
    // state-transition-sdk's parser accepts any non-negative bigint path —
    // this is the upstream behaviour that produced the >256-bit values
    // the UXF encoder was rejecting.
    const sdkPath = SparseMerkleTreePath.fromJSON(fixture.merkleTreePath);
    expect(sdkPath.steps.length).toBe(fixture.merkleTreePath.steps.length);
    // Verify the SDK parsed each path bigint matches the fixture decimal.
    for (let i = 0; i < sdkPath.steps.length; i++) {
      expect(sdkPath.steps[i].path.toString()).toBe(
        fixture.merkleTreePath.steps[i].path,
      );
    }
  });

  it('UXF prepareContentForHashing accepts every fixture step (no INVALID_HASH)', () => {
    const fixture = loadFixture();
    // Convert the fixture step shape to the UXF SmtPath segments shape.
    const segments = fixture.merkleTreePath.steps.map((s) => ({
      data: s.data === null ? null : s.data,
      path: s.path,
    }));
    // The pre-#295 encoder threw on the 259/273/280-bit entries.
    // Post-#295, every entry encodes successfully.
    const result = prepareContentForHashing('smt-path', {
      root: fixture.merkleTreePath.root,
      segments,
    } as Record<string, unknown>);
    expect(result.segments).toBeDefined();
    const prepared = result.segments as Array<{
      data: Uint8Array | null;
      path: Uint8Array;
    }>;
    expect(prepared.length).toBe(fixture.merkleTreePath.steps.length);
    for (let i = 0; i < prepared.length; i++) {
      expect(prepared[i].path).toBeInstanceOf(Uint8Array);
      // Encoder MUST emit non-empty bstr (≥1 byte) for every value
      // including bigint 0 (which it doesn't emit here, but the
      // invariant is encoder-wide).
      expect(prepared[i].path.length).toBeGreaterThan(0);
      // Encoder MUST NOT emit > 35 bytes (UXF SPEC §11 #295 ceiling).
      expect(prepared[i].path.length).toBeLessThanOrEqual(35);
    }
  });

  it('encoder emits expected byte widths per fixture step (backward-compat property)', () => {
    const fixture = loadFixture();
    const segments = fixture.merkleTreePath.steps.map((s) => ({
      data: s.data === null ? null : s.data,
      path: s.path,
    }));
    const result = prepareContentForHashing('smt-path', {
      root: fixture.merkleTreePath.root,
      segments,
    } as Record<string, unknown>);
    const prepared = result.segments as Array<{
      data: Uint8Array | null;
      path: Uint8Array;
    }>;
    // Step 0: 6 bits  → ceil(6/8)=1, BUT backward-compat says ≤256-bit
    // values emit fixed 32 bytes. This locks in that property.
    expect(prepared[0].path.length).toBe(32);
    // Step 1: 256 bits → 32 bytes (backward-compat fixed region).
    expect(prepared[1].path.length).toBe(32);
    // Step 2: 259 bits → ceil(259/8) = 33 bytes (variable region).
    expect(prepared[2].path.length).toBe(33);
    // Step 3: 273 bits → ceil(273/8) = 35 bytes.
    expect(prepared[3].path.length).toBe(35);
    // Step 4: 280 bits → ceil(280/8) = 35 bytes (the ceiling).
    expect(prepared[4].path.length).toBe(35);
  });

  it('@ipld/dag-cbor encode does NOT throw on the long-path fixture', () => {
    const fixture = loadFixture();
    const segments = fixture.merkleTreePath.steps.map((s) => ({
      data: s.data === null ? null : s.data,
      path: s.path,
    }));
    const result = prepareContentForHashing('smt-path', {
      root: fixture.merkleTreePath.root,
      segments,
    } as Record<string, unknown>);
    // The pre-#295 failure was either INVALID_HASH (above) OR a downstream
    // "encountered BigInt larger than allowable range" from cborg. Both
    // are blocked under #295.
    expect(() => dagCborEncode(result)).not.toThrow();
  });

  it('round-trip preserves every fixture path value (bigint equality)', () => {
    const fixture = loadFixture();
    const segments = fixture.merkleTreePath.steps.map((s) => ({
      data: s.data === null ? null : s.data,
      path: s.path,
    }));
    const result = prepareContentForHashing('smt-path', {
      root: fixture.merkleTreePath.root,
      segments,
    } as Record<string, unknown>);
    const prepared = result.segments as Array<{
      data: Uint8Array | null;
      path: Uint8Array;
    }>;
    for (let i = 0; i < prepared.length; i++) {
      // Reconstruct the bigint via the same big-endian decode used by
      // uxf/ipld.ts decodeIpldContentArray.
      let v = 0n;
      for (const b of prepared[i].path) {
        v = (v << 8n) | BigInt(b);
      }
      expect(v.toString()).toBe(fixture.merkleTreePath.steps[i].path);
    }
  });

  it('encoder is deterministic — two calls with the same fixture produce identical bytes', () => {
    const fixture = loadFixture();
    const segments = fixture.merkleTreePath.steps.map((s) => ({
      data: s.data === null ? null : s.data,
      path: s.path,
    }));
    const r1 = prepareContentForHashing('smt-path', {
      root: fixture.merkleTreePath.root,
      segments,
    } as Record<string, unknown>);
    const r2 = prepareContentForHashing('smt-path', {
      root: fixture.merkleTreePath.root,
      segments,
    } as Record<string, unknown>);
    const a = dagCborEncode(r1);
    const b = dagCborEncode(r2);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
