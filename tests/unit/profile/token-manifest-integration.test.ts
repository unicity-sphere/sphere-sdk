/**
 * Integration tests for deriveStructuralManifest() against the real
 * UxfPackage. The pure-function suite in token-manifest.test.ts uses a
 * hand-built package fixture; this file goes the full distance — build
 * real packages with real tokens and confirm the deriver's output.
 */

import { describe, it, expect } from 'vitest';
import { UxfPackage } from '../../../uxf/UxfPackage.js';
import {
  deriveStructuralManifest,
  conflictingTokenIds,
} from '../../../profile/token-manifest';
import { TOKEN_A, TOKEN_B } from '../../fixtures/uxf-mock-tokens.js';

function tokenId(token: Record<string, unknown>): string {
  return ((token.genesis as any).data as any).tokenId.toLowerCase();
}

describe('deriveStructuralManifest (real UxfPackage)', () => {
  it('returns valid status for every token in a fresh single-bundle package', () => {
    const pkg = UxfPackage.create();
    pkg.ingest(TOKEN_A);
    pkg.ingest(TOKEN_B);

    const manifest = deriveStructuralManifest(pkg);
    expect(manifest.size).toBe(2);

    const idA = tokenId(TOKEN_A);
    const idB = tokenId(TOKEN_B);
    expect(manifest.get(idA)?.status).toBe('valid');
    expect(manifest.get(idB)?.status).toBe('valid');
    expect(manifest.get(idA)?.conflictingHeads).toBeUndefined();
    expect(conflictingTokenIds(manifest)).toEqual([]);
  });

  it('merging two bundles with the same tokens keeps them valid (no divergence)', () => {
    const pkgA = UxfPackage.create();
    pkgA.ingest(TOKEN_A);

    const pkgB = UxfPackage.create();
    pkgB.ingest(TOKEN_A); // same token, same state

    pkgA.merge(pkgB);

    const manifest = deriveStructuralManifest(pkgA);
    expect(manifest.size).toBe(1);
    expect(manifest.get(tokenId(TOKEN_A))?.status).toBe('valid');
  });

  it('manifest carries bundle-manifest root as rootHash', () => {
    const pkg = UxfPackage.create();
    pkg.ingest(TOKEN_A);

    const manifest = deriveStructuralManifest(pkg);
    const entry = manifest.get(tokenId(TOKEN_A))!;

    // The rootHash must match what the bundle manifest stores for this
    // tokenId — the deriver is faithful to the structural truth.
    const expectedRoot = (pkg as unknown as {
      data: { manifest: { tokens: Map<string, string> } };
    }).data.manifest.tokens.get(tokenId(TOKEN_A));
    expect(entry.rootHash).toBe(expectedRoot);
  });
});
