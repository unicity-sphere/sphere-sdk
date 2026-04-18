/**
 * Tests for profile/token-manifest.ts
 *
 * Verifies structural token-manifest derivation: valid status for
 * single-head chains, conflicting status when merged bundles introduce
 * sibling heads via the instance-chain index.
 */

import { describe, it, expect } from 'vitest';
import {
  deriveStructuralManifest,
  conflictingTokenIds,
  type TokenManifest,
} from '../../../profile/token-manifest';
import type { UxfPackage } from '../../../uxf/UxfPackage';
import type {
  ContentHash,
  InstanceChainEntry,
  UxfManifest,
  UxfPackageData,
} from '../../../uxf/types';

// ---------------------------------------------------------------------------
// Fixture helpers (build minimal UxfPackageData + UxfPackage shapes)
// ---------------------------------------------------------------------------

function mockPackage(
  manifestTokens: Record<string, ContentHash>,
  instanceChains: Map<ContentHash, InstanceChainEntry> = new Map(),
): UxfPackage {
  const data: Partial<UxfPackageData> = {
    manifest: {
      tokens: new Map(Object.entries(manifestTokens)),
    } as UxfManifest,
    instanceChains,
    // The remaining fields (pool, envelope, etc.) are not consulted by
    // the deriver, so leaving them `undefined` is safe here.
  };
  return {
    data,
    tokenIds(): string[] {
      return [...data.manifest!.tokens.keys()];
    },
  } as unknown as UxfPackage;
}

function chainEntry(
  head: ContentHash,
  chainHashes: ContentHash[],
): InstanceChainEntry {
  return {
    head,
    chain: chainHashes.map((hash) => ({ hash, kind: 'primary' as const })),
  } as InstanceChainEntry;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('deriveStructuralManifest', () => {
  it('returns empty map for empty package', () => {
    const pkg = mockPackage({});
    expect(deriveStructuralManifest(pkg).size).toBe(0);
  });

  it('classifies a token with no instance chain as valid', () => {
    const pkg = mockPackage({ tokenA: 'rootA' });
    const manifest = deriveStructuralManifest(pkg);
    expect(manifest.get('tokenA')).toEqual({
      rootHash: 'rootA',
      status: 'valid',
    });
  });

  it('classifies a token with a single-head chain as valid', () => {
    const chain = chainEntry('headA', ['headA', 'rootA']);
    const idx = new Map<ContentHash, InstanceChainEntry>();
    idx.set('rootA', chain);
    idx.set('headA', chain);

    const pkg = mockPackage({ tokenA: 'rootA' }, idx);
    const manifest = deriveStructuralManifest(pkg);
    expect(manifest.get('tokenA')?.status).toBe('valid');
    // The deriver honours the bundle-manifest root as primary even if
    // the chain's actual head differs; oracle layer resolves which is
    // authoritative.
    expect(manifest.get('tokenA')?.rootHash).toBe('rootA');
  });

  it('classifies diverged sibling chains as conflicting', () => {
    // Two distinct chain entries that both claim the same ancestor
    // `rootA`. This is the post-merge state produced by
    // mergeInstanceChains when bundles diverge on the same state.
    const chainA = chainEntry('headA', ['headA', 'rootA']);
    const chainB = chainEntry('headB', ['headB', 'rootA']);

    const idx = new Map<ContentHash, InstanceChainEntry>();
    // After a diverging merge, rootA maps to the primary (A). headA
    // maps to A. headB maps to B (sibling added only for its
    // not-yet-seen hash).
    idx.set('rootA', chainA);
    idx.set('headA', chainA);
    idx.set('headB', chainB);

    const pkg = mockPackage({ tokenA: 'rootA' }, idx);
    const manifest = deriveStructuralManifest(pkg);

    const entry = manifest.get('tokenA');
    expect(entry?.status).toBe('conflicting');
    expect(entry?.rootHash).toBe('rootA');
    // Both heads are listed symmetrically (oracle layer decides which
    // is the winner).
    expect(entry?.conflictingHeads).toBeDefined();
    expect(entry?.conflictingHeads).toContain('headA');
    expect(entry?.conflictingHeads).toContain('headB');
    expect(entry?.conflictingHeads?.length).toBe(2);
  });

  it('lists conflicting tokenIds via conflictingTokenIds()', () => {
    const chainA = chainEntry('headA', ['headA', 'rootA']);
    const chainB = chainEntry('headB', ['headB', 'rootA']);
    const chainC = chainEntry('headC', ['headC', 'rootC']);

    const idx = new Map<ContentHash, InstanceChainEntry>();
    idx.set('rootA', chainA);
    idx.set('headA', chainA);
    idx.set('headB', chainB);
    // Token C is clean
    idx.set('rootC', chainC);
    idx.set('headC', chainC);

    const pkg = mockPackage(
      {
        tokenA: 'rootA',
        tokenClean: 'rootClean', // no chain entry — treated as valid
        tokenC: 'rootC',
      },
      idx,
    );

    const manifest = deriveStructuralManifest(pkg);
    const conflicts = conflictingTokenIds(manifest);
    expect(conflicts).toEqual(['tokenA']);
    expect(manifest.get('tokenClean')?.status).toBe('valid');
    expect(manifest.get('tokenC')?.status).toBe('valid');
  });

  it('handles multiple conflicting heads per token', () => {
    const chainA = chainEntry('headA', ['headA', 'rootA']);
    const chainB = chainEntry('headB', ['headB', 'rootA']);
    const chainD = chainEntry('headD', ['headD', 'rootA']);

    const idx = new Map<ContentHash, InstanceChainEntry>();
    idx.set('rootA', chainA);
    idx.set('headA', chainA);
    idx.set('headB', chainB);
    idx.set('headD', chainD);

    const pkg = mockPackage({ tokenA: 'rootA' }, idx);
    const manifest: TokenManifest = deriveStructuralManifest(pkg);

    const entry = manifest.get('tokenA');
    expect(entry?.status).toBe('conflicting');
    expect(entry?.conflictingHeads?.length).toBe(3);
    expect([...(entry?.conflictingHeads ?? [])].sort()).toEqual(['headA', 'headB', 'headD']);
  });
});
