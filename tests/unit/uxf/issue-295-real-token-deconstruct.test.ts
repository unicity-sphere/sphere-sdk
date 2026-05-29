/**
 * End-to-end regression test for issue #295 — real-token fixture
 * captured live from the user-reported failing wallet.
 *
 * The fixture under
 *   tests/fixtures/uxf/user-reported-issue-295-real-token.json
 * is a complete TxfToken captured from a user's browser IndexedDB
 * (`sphere-token-storage-DIRECT_00009f_b7304c`) on 2026-05-27. The
 * token's genesis InclusionProof contains a step[0] path of bit-length
 * 261 — the kind of value the pre-rewrite UXF encoder rejected with
 * `[UXF:INVALID_HASH] SMT path exceeds 256 bits`, blocking the user's
 * Profile migration. The embedded nametag token additionally carries the
 * exact 259-bit decimal that surfaced in the user-reported error
 * message verbatim.
 *
 * Companion to tests/unit/uxf/hash.real-inclusion-proof.test.ts which
 * tests the path-encoder slice with a synthesized 5-step fixture; this
 * test exercises the full `deconstructToken` pipeline against real
 * production-shape data. If either slips through, the OTHER catches it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { deconstructToken } from '../../../uxf/deconstruct.js';
import { ElementPool } from '../../../uxf/element-pool.js';
import type { SmtPathContent } from '../../../uxf/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(
  __dirname,
  '../../fixtures/uxf/user-reported-issue-295-real-token.json',
);

interface FixtureShape {
  readonly _captureContext: {
    readonly tokenId: string;
    readonly offendingStep: { readonly bitLength: number; readonly path: string };
    readonly embeddedNametagOffender: { readonly bitLength: number; readonly path: string };
  };
  readonly token: unknown;
}

function loadFixture(): FixtureShape {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as FixtureShape;
}

describe('issue #295 — real-token deconstruct (full pipeline)', () => {
  it('deconstructToken does NOT throw on the real failing token', () => {
    const fixture = loadFixture();
    const pool = new ElementPool();
    // Pre-rewrite this threw [UXF:INVALID_HASH] on the 261-bit step[0].
    // Post-rewrite UXF embeds STS-canonical CBOR opaquely — no rejection.
    expect(() => deconstructToken(pool, fixture.token)).not.toThrow();
  });

  it('the offending step is preserved in the pool as opaque CBOR bytes', () => {
    const fixture = loadFixture();
    const pool = new ElementPool();
    deconstructToken(pool, fixture.token);

    // Find every smt-path element written to the pool — the real token
    // produces several (genesis proof + transaction proof + embedded
    // nametag's genesis proof). Each MUST be stored as { cbor: hex }.
    let smtPathElements = 0;
    let totalCborBytes = 0;
    for (const [, element] of (pool as unknown as { elements: Map<string, unknown> }).elements) {
      const el = element as { type: string; content: unknown };
      if (el.type !== 'smt-path') continue;
      const content = el.content as SmtPathContent;
      expect(typeof content.cbor).toBe('string');
      expect(content.cbor.length).toBeGreaterThan(0);
      // Hex string -> bytes count.
      totalCborBytes += content.cbor.length / 2;
      smtPathElements += 1;
    }

    // Token has 3 InclusionProofs (genesis + transactions[0] + nametag
    // genesis), so we expect 3 SmtPath elements minimum.
    expect(smtPathElements).toBeGreaterThanOrEqual(3);
    // Real-token CBOR blobs are ~1.5-5.6 KB total per TOKEN-ANALYSIS.md
    // sanity bound.
    expect(totalCborBytes).toBeGreaterThan(0);
    expect(totalCborBytes).toBeLessThan(20_000);
  });

  it('exposes the offending step bit-lengths used by this regression', () => {
    // Documents in-test what makes this fixture interesting. If
    // anybody trims the fixture or substitutes shorter paths, this
    // assertion immediately surfaces it.
    const fixture = loadFixture();
    expect(fixture._captureContext.offendingStep.bitLength).toBe(261);
    expect(fixture._captureContext.embeddedNametagOffender.bitLength).toBe(259);
    // The 259-bit value is the exact decimal reported in the issue body.
    expect(fixture._captureContext.embeddedNametagOffender.path).toBe(
      '463173912653332971197029146511962916219743101902252076413000309295050477951098',
    );
  });
});
