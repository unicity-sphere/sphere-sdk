/**
 * Issue #360 Finding #2 — UxfPackage.computeVerifiedProofsAcross unit tests.
 *
 * The new static method replaces the prior `O(B²)` pair loop in
 * profile load with a single combined-pool walk and parallel verifier
 * dispatch. These tests pin:
 *
 *   1. Dedup: 5 unique proofs spread across 3 bundles → verifier
 *      called EXACTLY 5 times (no per-pair re-verification).
 *   2. Resilience: a single verifier throw does not contaminate the
 *      other verifications.
 *   3. Single-bundle degenerate case: no proofs need cross-bundle
 *      references, but the static method still terminates correctly
 *      and produces the same set the legacy helper would have for
 *      B=1 (i.e., whichever proofs the verifier accepts).
 *   4. Concurrency: tasks fan out in parallel rather than awaiting
 *      sequentially.
 *
 * Like the existing UxfPackage.computeVerifiedProofs.test.ts, we mock
 * `assembleInclusionProofForVerification` so the verifier-call branch
 * is exercised without building real proof-graph fixtures.
 */

import { describe, it, expect, vi } from 'vitest';

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
      children: {
        authenticator: null,
        merkleTreePath: '00'.repeat(32),
        unicityCertificate: '00'.repeat(32),
      },
    } as unknown as UxfElement,
  ];
}

function pkgWithPool(pool: Map<ContentHash, UxfElement>): UxfPackage {
  const pkg = UxfPackage.create();
  const data = pkg.packageData as UxfPackageData;
  const mutablePool = data.pool as Map<ContentHash, UxfElement>;
  for (const [k, v] of pool) mutablePool.set(k, v);
  return pkg;
}

describe('UxfPackage.computeVerifiedProofsAcross (Issue #360 Finding #2)', () => {
  it('dedupes proofs across 3 bundles — verifier called exactly once per unique proof', async () => {
    const PROOFS = [
      'a1'.repeat(32),
      'a2'.repeat(32),
      'a3'.repeat(32),
      'a4'.repeat(32),
      'a5'.repeat(32),
    ];
    const tx = (i: number) => '0012' + String(i).padStart(2, '0').repeat(32);

    // Bundle layout: each proof present in at least one bundle; some
    // proofs duplicated across bundles to exercise dedup.
    //   Bundle 0: P0, P1, P2
    //   Bundle 1: P1, P2, P3   (P1, P2 duplicated from B0)
    //   Bundle 2: P2, P3, P4   (P2, P3 duplicated)
    const b0 = pkgWithPool(
      new Map([
        makeInclusionProofElement(PROOFS[0], tx(0)),
        makeInclusionProofElement(PROOFS[1], tx(1)),
        makeInclusionProofElement(PROOFS[2], tx(2)),
      ]),
    );
    const b1 = pkgWithPool(
      new Map([
        makeInclusionProofElement(PROOFS[1], tx(1)),
        makeInclusionProofElement(PROOFS[2], tx(2)),
        makeInclusionProofElement(PROOFS[3], tx(3)),
      ]),
    );
    const b2 = pkgWithPool(
      new Map([
        makeInclusionProofElement(PROOFS[2], tx(2)),
        makeInclusionProofElement(PROOFS[3], tx(3)),
        makeInclusionProofElement(PROOFS[4], tx(4)),
      ]),
    );

    // Reject one proof so the result set is a strict subset of the
    // verifier call set — proves we don't blindly add everything.
    const REJECTED = PROOFS[4];
    const verifier = vi.fn(
      async (input: { proofJson: unknown; transactionHash: string; proofHash?: string }) => {
        return input.proofHash !== REJECTED;
      },
    );

    const verified = await UxfPackage.computeVerifiedProofsAcross(
      [b0, b1, b2],
      verifier,
    );

    // Dedup invariant: 5 unique proofs across 3 bundles → exactly 5
    // verifier invocations. The prior O(B²) helper would have made
    // 3 pair walks × overlapping proofs = many more calls.
    expect(verifier).toHaveBeenCalledTimes(5);

    expect(verified.size).toBe(4);
    for (const p of PROOFS) {
      expect(verified.has(p)).toBe(p !== REJECTED);
    }
  });

  it('verifier throw on one proof does not abort the others', async () => {
    const P_OK = 'b1'.repeat(32);
    const P_BAD = 'b2'.repeat(32);
    const P_ALSO_OK = 'b3'.repeat(32);

    const b0 = pkgWithPool(
      new Map([
        makeInclusionProofElement(P_OK, '0012' + 'cc'.repeat(32)),
        makeInclusionProofElement(P_BAD, '0012' + 'dd'.repeat(32)),
      ]),
    );
    const b1 = pkgWithPool(
      new Map([
        makeInclusionProofElement(P_ALSO_OK, '0012' + 'ee'.repeat(32)),
      ]),
    );

    const verifier = vi.fn(
      async (input: { proofJson: unknown; transactionHash: string; proofHash?: string }) => {
        if (input.proofHash === P_BAD) {
          throw new Error('verifier exploded for this proof');
        }
        return true;
      },
    );

    const verified = await UxfPackage.computeVerifiedProofsAcross([b0, b1], verifier);

    expect(verifier).toHaveBeenCalledTimes(3);
    expect(verified.size).toBe(2);
    expect(verified.has(P_OK)).toBe(true);
    expect(verified.has(P_ALSO_OK)).toBe(true);
    expect(verified.has(P_BAD)).toBe(false);
  });

  it('single-bundle degenerate case — still verifies whatever proofs the bundle contains', async () => {
    const P = 'c1'.repeat(32);
    const only = pkgWithPool(
      new Map([makeInclusionProofElement(P, '0012' + 'aa'.repeat(32))]),
    );
    const verifier = vi.fn(async () => true);

    const verified = await UxfPackage.computeVerifiedProofsAcross([only], verifier);

    // Method runs cleanly with a single package; verifier sees each
    // unique proof exactly once. (The profile call site guards
    // against single-bundle calls; this guarantees the static method
    // is safe for any caller that needs B=1.)
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(verified.size).toBe(1);
    expect(verified.has(P)).toBe(true);
  });

  it('empty-package list returns empty set without invoking verifier', async () => {
    const verifier = vi.fn(async () => true);
    const verified = await UxfPackage.computeVerifiedProofsAcross([], verifier);
    expect(verifier).not.toHaveBeenCalled();
    expect(verified.size).toBe(0);
  });

  it('runs verifier calls concurrently rather than sequentially', async () => {
    const PROOFS = [
      'd1'.repeat(32),
      'd2'.repeat(32),
      'd3'.repeat(32),
      'd4'.repeat(32),
    ];

    const b = pkgWithPool(
      new Map(
        PROOFS.map(
          (p, i) =>
            makeInclusionProofElement(p, '0012' + String(i).padStart(2, '0').repeat(32)) as [
              ContentHash,
              UxfElement,
            ],
        ),
      ),
    );

    // Each verifier call records its start time and then awaits a
    // shared 30ms delay. If the static method awaits sequentially the
    // start-time spread will be >= 90ms (3 × 30ms). If parallel, the
    // spread is bounded by a single delay (<< 90ms).
    const startTimes: number[] = [];
    const VERIFIER_DELAY_MS = 30;
    const verifier = vi.fn(async () => {
      startTimes.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, VERIFIER_DELAY_MS));
      return true;
    });

    const t0 = Date.now();
    const verified = await UxfPackage.computeVerifiedProofsAcross([b], verifier);
    const elapsed = Date.now() - t0;

    expect(verifier).toHaveBeenCalledTimes(4);
    expect(verified.size).toBe(4);

    // All four start times should land within a small window of each
    // other (parallel dispatch). Allow generous slack for CI jitter.
    const spread = Math.max(...startTimes) - Math.min(...startTimes);
    expect(spread).toBeLessThan(VERIFIER_DELAY_MS);

    // Total elapsed should be comparable to a single delay, NOT the
    // sum of all delays. Bound the upper end loosely (3× delay) to
    // tolerate slow CI but still distinguish from purely-sequential
    // execution (which would be 4× delay = 120ms minimum).
    expect(elapsed).toBeLessThan(VERIFIER_DELAY_MS * 3);
  });
});
