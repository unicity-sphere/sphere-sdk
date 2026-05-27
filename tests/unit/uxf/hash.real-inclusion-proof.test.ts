/**
 * Regression tests for issue #295 (rewrite #2) — UXF embeds the
 * InclusionProof's SmtPath as an opaque STS-canonical CBOR blob.
 *
 * The fixture under tests/fixtures/uxf/real-testnet-inclusion-proof-long-path.json
 * is a representative `InclusionProof.toJSON()` blob whose
 * `merkleTreePath.steps[].path` values exercise:
 *   - a small value (smoke test)
 *   - the legacy 256-bit boundary
 *   - the exact 259-bit decimal extracted from the user-reported
 *     sphere.telco migration failure (issue body)
 *   - a 273-bit value (BitString(34-byte imprint) max — STS's current ceiling)
 *   - a 280-bit value (above STS's current ceiling — verifies UXF imposes
 *     no upper bound at the UXF layer)
 *
 * The test round-trips the fixture through:
 *   1. SparseMerkleTreePath.fromJSON() — STS parser
 *   2. deconstructSmtPath / putElement — UXF stores opaque CBOR bytes
 *   3. fromCBOR().toJSON() — STS round-trip (the path assembleSmtPath uses)
 *   4. Comparison of the toJSON output against the original — must
 *      be lossless.
 *
 * Pre-rewrite the UXF encoder threw INVALID_HASH on any step > 256 bits.
 * Post-rewrite UXF stores the STS-canonical bytes verbatim — STS owns
 * the encoding, UXF only ferries the blob.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { encode as dagCborEncode } from '@ipld/dag-cbor';

import { SparseMerkleTreePath } from '@unicitylabs/state-transition-sdk/lib/mtree/plain/SparseMerkleTreePath.js';

import { prepareContentForHashing } from '../../../uxf/hash.js';
import { deconstructSmtPath } from '../../../uxf/deconstruct.js';
import { ElementPool } from '../../../uxf/element-pool.js';
import type { SmtPathContent } from '../../../uxf/types.js';

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

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

describe('issue #295 — real-testnet InclusionProof opaque-embed round-trip', () => {
  it('SparseMerkleTreePath.fromJSON accepts the fixture path values', () => {
    const fixture = loadFixture();
    // state-transition-sdk's parser accepts any non-negative bigint path.
    const sdkPath = SparseMerkleTreePath.fromJSON(fixture.merkleTreePath);
    expect(sdkPath.steps.length).toBe(fixture.merkleTreePath.steps.length);
    for (let i = 0; i < sdkPath.steps.length; i++) {
      expect(sdkPath.steps[i].path.toString()).toBe(
        fixture.merkleTreePath.steps[i].path,
      );
    }
  });

  it('deconstructSmtPath embeds the opaque STS-canonical CBOR blob (no UXF inspection)', () => {
    const fixture = loadFixture();
    const pool = new ElementPool();
    const hash = deconstructSmtPath(pool, fixture.merkleTreePath);

    // Verify the stored element content is the STS CBOR bytes verbatim.
    const stored = pool.get(hash);
    expect(stored).toBeDefined();
    expect(stored!.type).toBe('smt-path');
    const content = stored!.content as unknown as SmtPathContent;
    expect(typeof content.cbor).toBe('string');
    // The stored hex must equal SparseMerkleTreePath.fromJSON(...).toCBOR().
    const sdkPath = SparseMerkleTreePath.fromJSON(fixture.merkleTreePath);
    expect(content.cbor).toBe(bytesToHex(sdkPath.toCBOR()));
  });

  it('round-trip through opaque CBOR preserves every fixture step (lossless)', () => {
    const fixture = loadFixture();
    // Forward: fromJSON -> toCBOR
    const sdkPath = SparseMerkleTreePath.fromJSON(fixture.merkleTreePath);
    const cborBytes = sdkPath.toCBOR();
    // Reverse: fromCBOR -> toJSON (this is what assembleSmtPath does).
    const reconstructed = SparseMerkleTreePath.fromCBOR(cborBytes);
    const json = reconstructed.toJSON();

    // Root preserved.
    expect(json.root).toBe(fixture.merkleTreePath.root);
    // Every step preserved.
    expect(json.steps.length).toBe(fixture.merkleTreePath.steps.length);
    for (let i = 0; i < json.steps.length; i++) {
      expect(json.steps[i].path).toBe(fixture.merkleTreePath.steps[i].path);
      // STS canonicalises data: null stays null; hex strings preserved.
      expect(json.steps[i].data).toBe(fixture.merkleTreePath.steps[i].data);
    }
  });

  it('@ipld/dag-cbor encode does NOT throw on the long-path fixture (opaque embed)', () => {
    const fixture = loadFixture();
    const sdkPath = SparseMerkleTreePath.fromJSON(fixture.merkleTreePath);
    const cborHex = bytesToHex(sdkPath.toCBOR());
    const result = prepareContentForHashing('smt-path', { cbor: cborHex });
    // No UXF-side decomposition, no UXF-side bit-length check.
    // dag-cbor just wraps the bytes in a bstr.
    expect(() => dagCborEncode(result)).not.toThrow();
  });

  it('UXF encoder is deterministic — two calls produce identical bytes', () => {
    const fixture = loadFixture();
    const sdkPath = SparseMerkleTreePath.fromJSON(fixture.merkleTreePath);
    const cborHex = bytesToHex(sdkPath.toCBOR());
    const r1 = prepareContentForHashing('smt-path', { cbor: cborHex });
    const r2 = prepareContentForHashing('smt-path', { cbor: cborHex });
    const a = dagCborEncode(r1);
    const b = dagCborEncode(r2);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('two tokens with identical paths share the same SmtPath element (dedup smoke test)', () => {
    const fixture = loadFixture();
    const pool = new ElementPool();
    // First insertion creates the element.
    const h1 = deconstructSmtPath(pool, fixture.merkleTreePath);
    const sizeAfterFirst = pool.size;
    // Second insertion of the SAME path produces the same ContentHash,
    // and the pool size does NOT grow (whole-element dedup via Map keyed
    // on ContentHash). This is the dedup behaviour that was always
    // present at the UXF pool level — segments were inline content,
    // never separate pool entries, so the opaque-embed rewrite preserves
    // it. See uxf/deconstruct.ts:deconstructSmtPath (single putElement).
    const h2 = deconstructSmtPath(pool, fixture.merkleTreePath);
    expect(h2).toBe(h1);
    expect(pool.size).toBe(sizeAfterFirst);

    // Sanity: a different path produces a different hash.
    const otherJson = {
      root: '99'.repeat(32),
      steps: [{ path: '1', data: 'aa'.repeat(32) }],
    };
    const h3 = deconstructSmtPath(pool, otherJson);
    expect(h3).not.toBe(h1);
    expect(pool.size).toBe(sizeAfterFirst + 1);
  });

  it('hex<->bytes conversion is round-trip lossless (helper sanity)', () => {
    const fixture = loadFixture();
    const sdkPath = SparseMerkleTreePath.fromJSON(fixture.merkleTreePath);
    const bytes = sdkPath.toCBOR();
    const hex = bytesToHex(bytes);
    expect(Array.from(hexToBytes(hex))).toEqual(Array.from(bytes));
  });
});
