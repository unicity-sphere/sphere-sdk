/**
 * Wave I.5 / J / J.b: UxfPackage.computeVerifiedProofs unit tests.
 *
 * Verifies the helper that walks inclusion-proof elements across two
 * UxfPackage pools, assembles each into the SDK JSON shape, calls the
 * caller-supplied verifier, and returns the set of proof
 * ContentHashes that verified.
 *
 * Wave J.b — coverage fix: bypass `assembleInclusionProofForVerification`
 * by mocking the assemble module so the verifier-success path is
 * actually exercised. The pre-J.b tests used minimal fixtures whose
 * children references didn't resolve, forcing assembly to throw and
 * the helper to `continue` past the verifier call.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock assemble.ts so assembleInclusionProofForVerification returns
// a stub proofJson without actually walking the pool. This lets us
// exercise the verifier-call branch deterministically.
vi.mock('../../../uxf/assemble.js', async () => {
  const actual = await vi.importActual<typeof import('../../../uxf/assemble.js')>(
    '../../../uxf/assemble.js',
  );
  return {
    ...actual,
    assembleInclusionProofForVerification: vi.fn(
      (_pool: unknown, proofHash: string) => {
        return { stubProofForHash: proofHash };
      },
    ),
  };
});

import { UxfPackage } from '../../../uxf/UxfPackage.js';
import type { UxfPackageData, UxfElement, ContentHash } from '../../../uxf/types.js';

const ELEMENT_TYPE_INCLUSION_PROOF = 'inclusion-proof' as const;

/**
 * Build a minimal inclusion-proof-shaped element. We don't need it to
 * be valid for SDK reconstruction — we only need the type tag and
 * content.transactionHash field; the verifier is a stub.
 */
function makeInclusionProofElement(
  hash: string,
  txHashImprint: string,
): [ContentHash, UxfElement] {
  return [
    hash as ContentHash,
    {
      header: {
        representation: 1,
        semantics: 1,
        kind: 'default' as const,
        predecessor: null,
      },
      type: ELEMENT_TYPE_INCLUSION_PROOF,
      content: { transactionHash: txHashImprint },
      // Children references — assembleInclusionProof would resolve
      // these. We pass empty refs so assemble throws and the helper
      // catches and skips, which is fine for the verifier-driven
      // tests below: we replace the verifier with a stub that doesn't
      // care about proofJson shape.
      children: { authenticator: null, merkleTreePath: '00'.repeat(32), unicityCertificate: '00'.repeat(32) },
    } as unknown as UxfElement,
  ];
}

function pkgWithPool(pool: Map<ContentHash, UxfElement>): UxfPackage {
  // Bypass the public ingest/merge API and inject directly into the
  // packageData mutable pool. This keeps the test focused on
  // computeVerifiedProofs's pool-walk logic, not on token
  // assembly fidelity.
  const pkg = UxfPackage.create();
  const data = pkg.packageData as UxfPackageData;
  const mutablePool = data.pool as Map<ContentHash, UxfElement>;
  for (const [k, v] of pool) mutablePool.set(k, v);
  return pkg;
}

describe('UxfPackage.computeVerifiedProofs (Wave I.5 / J)', () => {
  it('passes proofHash + transactionHash imprint to verifier; only adds verified hashes to set', async () => {
    const PROOF_A = 'aa'.repeat(32);
    const PROOF_B = 'bb'.repeat(32);
    const TX_A_IMPRINT = '0012' + 'cc'.repeat(32); // 68-char imprint
    const TX_B_IMPRINT = '0012' + 'dd'.repeat(32);

    const target = pkgWithPool(
      new Map([
        makeInclusionProofElement(PROOF_A, TX_A_IMPRINT),
      ]),
    );
    const source = pkgWithPool(
      new Map([
        makeInclusionProofElement(PROOF_B, TX_B_IMPRINT),
      ]),
    );

    const verifier = vi.fn(async (input: { proofJson: unknown; transactionHash: string; proofHash?: string }) => {
      // Verify proofA, refuse proofB.
      return input.proofHash === PROOF_A;
    });

    const verified = await target.computeVerifiedProofs(source, verifier);
    // Wave J.b: with assemble mocked, the verifier IS called for each
    // proof element (combined pool of target + source).
    expect(verifier).toHaveBeenCalledTimes(2);
    // Verifier received the imprint hex AND the proof's ContentHash.
    expect(verifier).toHaveBeenCalledWith({
      proofJson: { stubProofForHash: PROOF_A },
      transactionHash: TX_A_IMPRINT,
      proofHash: PROOF_A,
    });
    expect(verifier).toHaveBeenCalledWith({
      proofJson: { stubProofForHash: PROOF_B },
      transactionHash: TX_B_IMPRINT,
      proofHash: PROOF_B,
    });
    // Only proofA was verified (verifier returned true only for it).
    expect(verified.has(PROOF_A)).toBe(true);
    expect(verified.has(PROOF_B)).toBe(false);
    expect(verified.size).toBe(1);
  });

  it('combines pools from this + other (cross-package dedup)', async () => {
    // Same proof element appears in both packages. The combined-pool
    // walk visits it ONCE (Map dedup by key) so the verifier is
    // called once.
    const PROOF_SHARED = 'ee'.repeat(32);
    const TX_SHARED = '0012' + 'ff'.repeat(32);
    const target = pkgWithPool(
      new Map([makeInclusionProofElement(PROOF_SHARED, TX_SHARED)]),
    );
    const source = pkgWithPool(
      new Map([makeInclusionProofElement(PROOF_SHARED, TX_SHARED)]),
    );
    const verifier = vi.fn(async () => true);
    const verified = await target.computeVerifiedProofs(source, verifier);
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(verified.has(PROOF_SHARED)).toBe(true);
    expect(verified.size).toBe(1);
  });

  it('verifier throw is caught and treated as not-verified (conservative)', async () => {
    const PROOF = 'aa'.repeat(32);
    const TX_IMPRINT = '0012' + 'bb'.repeat(32);
    const target = pkgWithPool(
      new Map([makeInclusionProofElement(PROOF, TX_IMPRINT)]),
    );
    const source = pkgWithPool(new Map());
    const verifier = vi.fn(async () => {
      throw new Error('verifier exploded');
    });
    const verified = await target.computeVerifiedProofs(source, verifier);
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(verified.size).toBe(0);
  });

  it('skips proof elements whose transactionHash content is not a string', async () => {
    const PROOF = 'aa'.repeat(32);
    const target = pkgWithPool(
      new Map([
        [
          PROOF as ContentHash,
          {
            header: { representation: 1, semantics: 1, kind: 'default' as const, predecessor: null },
            type: ELEMENT_TYPE_INCLUSION_PROOF,
            content: { transactionHash: null }, // non-inclusion proof shape
            children: { authenticator: null, merkleTreePath: '00'.repeat(32), unicityCertificate: '00'.repeat(32) },
          } as unknown as UxfElement,
        ],
      ]),
    );
    const source = pkgWithPool(new Map());
    const verifier = vi.fn(async () => true);
    const verified = await target.computeVerifiedProofs(source, verifier);
    expect(verified.size).toBe(0);
    // null transactionHash → element is skipped BEFORE the verifier
    // is called.
    expect(verifier).not.toHaveBeenCalled();
  });
});
