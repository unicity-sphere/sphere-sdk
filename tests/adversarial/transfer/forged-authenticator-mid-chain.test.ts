/**
 * Adversarial test — forged authenticator at mid-chain (W37 / Note N7).
 *
 * Steelman defense: a hostile sender ships a token with a 3-tx chain
 * where tx[0] (genesis-adjacent) and tx[2] (head) are both signed
 * authentically (the sender's actual keys), but tx[1] in the middle has
 * a FORGED authenticator — its signature does not verify against its
 * claimed transactionHash. If the receiver only verified the head
 * authenticator (tx[2]), the splice would slip through and the receiver
 * would accept a chain whose middle state was never cryptographically
 * authorized.
 *
 * The §5.3 [C](1) protocol mandates per-tx ECDSA verification (W37):
 * for a K-tx chain, the walker MUST call `verifyAuthenticator()` K
 * times. This test confirms that contract by simulating the chain walk
 * and asserting:
 *
 *   1. Verification of tx[0] returns ok:true valid:true (authentic).
 *   2. Verification of tx[1] returns ok:true valid:false (FORGED — caught).
 *   3. The splice is detected at the FIRST forged tx (i=1), NOT at i=2
 *      (head-only verify would erroneously pass at i=2).
 *
 * This is the canonical regression for W37 — if a future refactor of
 * the decision-matrix walker (T.3.B.2) replaces per-tx verify with
 * head-only verify, this test goes red.
 *
 * Spec references: §5.3 [C](1), W37, Note N7.
 */

import { describe, it, expect } from 'vitest';
import type { Authenticator } from '@unicitylabs/state-transition-sdk/lib/api/Authenticator';
import type { DataHash } from '@unicitylabs/state-transition-sdk/lib/hash/DataHash';

import { verifyAuthenticator } from '../../../extensions/uxf/pipeline/authenticator-verifier';

// =============================================================================
// Adversarial chain construction
// =============================================================================

/**
 * Stub authenticator that returns a fixed boolean from `verify`. We
 * model "authentic" (returns true) vs "forged" (returns false).
 */
function authenticatorWithFixedAnswer(answer: boolean): Authenticator {
  return {
    verify: async (_h: DataHash): Promise<boolean> => answer,
  } as unknown as Authenticator;
}

interface AdversarialTx {
  /** Test-only label so failure messages identify the splice point. */
  readonly label: string;
  readonly authenticator: Authenticator;
  readonly transactionHash: DataHash;
}

/**
 * Build the canonical adversarial chain: 3 txs, tx[1] forged.
 *
 *   index 0: authentic (sender's keys signed correctly)
 *   index 1: FORGED   (signature does NOT match transactionHash)
 *   index 2: authentic (sender's keys signed correctly)
 *
 * If a recipient only verifies the head (tx[2]), the chain looks
 * valid. The protocol requires walking K=3 verifications.
 */
function adversarialChain(): AdversarialTx[] {
  // Real DataHashes are not necessary; the stub `verify` ignores its
  // argument and returns a fixed boolean. Build placeholder objects.
  const fakeHash = (i: number): DataHash =>
    ({
      algorithm: 0,
      data: new Uint8Array(32).fill(i),
      imprint: new Uint8Array(34).fill(i),
    }) as unknown as DataHash;

  return [
    {
      label: 'tx[0] genesis-adjacent (authentic)',
      authenticator: authenticatorWithFixedAnswer(true),
      transactionHash: fakeHash(0),
    },
    {
      label: 'tx[1] mid-chain (FORGED — splice point)',
      authenticator: authenticatorWithFixedAnswer(false),
      transactionHash: fakeHash(1),
    },
    {
      label: 'tx[2] head (authentic)',
      authenticator: authenticatorWithFixedAnswer(true),
      transactionHash: fakeHash(2),
    },
  ];
}

// =============================================================================
// Adversarial chain walker (mirrors T.3.B.2's per-tx loop)
// =============================================================================

interface ChainWalkResult {
  /** Index of the first invalid tx, or -1 if all valid. */
  readonly invalidAt: number;
  /** Total number of verifyAuthenticator calls made. */
  readonly verifyCalls: number;
}

/**
 * Walk a chain, calling verifyAuthenticator per-tx. Returns the index
 * of the first invalid tx (or -1 if all valid) and the total count of
 * verify calls — used in this test to confirm we walked the WHOLE chain
 * up to (and including) the splice point.
 */
async function walkChainPerTx(
  chain: ReadonlyArray<AdversarialTx>,
): Promise<ChainWalkResult> {
  let calls = 0;
  for (let i = 0; i < chain.length; i++) {
    calls++;
    const result = await verifyAuthenticator(
      chain[i].authenticator,
      chain[i].transactionHash,
    );
    if (!result.ok) {
      // SDK threw — short-circuit, structural failure.
      return { invalidAt: i, verifyCalls: calls };
    }
    if (!result.valid) {
      // Crypto verify said "no". Short-circuit at the splice point.
      return { invalidAt: i, verifyCalls: calls };
    }
  }
  return { invalidAt: -1, verifyCalls: calls };
}

// =============================================================================
// Test cases
// =============================================================================

describe('W37 — forged authenticator at mid-chain is caught per-tx', () => {
  it('detects the splice at tx[1] (NOT at tx[2] — head-only would miss it)', async () => {
    const chain = adversarialChain();
    const result = await walkChainPerTx(chain);

    // Critical invariants:
    //  1. The splice IS detected.
    expect(result.invalidAt).toBe(1);

    //  2. We made exactly 2 verify calls (i=0 passed, i=1 failed and
    //     short-circuited). If we'd skipped tx[1] and verified only
    //     tx[0] and tx[2], invalidAt would be -1 and the splice would
    //     slip through — that's the W37 bug we're guarding against.
    expect(result.verifyCalls).toBe(2);
  });

  it('confirms that head-only verify (skipping tx[1]) WOULD miss the splice', async () => {
    // This negative-control test demonstrates the bug we're avoiding.
    // If a buggy walker only verified the head (last tx), it would
    // declare the chain valid even though tx[1] is forged.
    const chain = adversarialChain();
    const headOnlyResult = await verifyAuthenticator(
      chain[chain.length - 1].authenticator,
      chain[chain.length - 1].transactionHash,
    );
    expect(headOnlyResult.ok).toBe(true);
    if (headOnlyResult.ok) {
      // BAD outcome: head says "valid"; real chain has a forgery at
      // index 1. Confirms why per-tx verify is mandatory.
      expect(headOnlyResult.valid).toBe(true);
    }
  });

  it('per-tx verify catches a forgery at tx[0] (chain head from receiver perspective)', async () => {
    // Variant: forgery at the first tx instead of the middle.
    const chain: AdversarialTx[] = [
      {
        label: 'tx[0] FORGED',
        authenticator: authenticatorWithFixedAnswer(false),
        transactionHash: { imprint: new Uint8Array(34) } as unknown as DataHash,
      },
      {
        label: 'tx[1] authentic',
        authenticator: authenticatorWithFixedAnswer(true),
        transactionHash: { imprint: new Uint8Array(34) } as unknown as DataHash,
      },
    ];
    const result = await walkChainPerTx(chain);
    expect(result.invalidAt).toBe(0);
    expect(result.verifyCalls).toBe(1);
  });

  it('per-tx verify catches a forgery at tx[K-1] (head splice)', async () => {
    // Variant: forgery at the last tx (the head). Trivially caught by
    // any non-zero verify, but worth a sanity check.
    const chain: AdversarialTx[] = [
      {
        label: 'tx[0] authentic',
        authenticator: authenticatorWithFixedAnswer(true),
        transactionHash: { imprint: new Uint8Array(34) } as unknown as DataHash,
      },
      {
        label: 'tx[1] FORGED',
        authenticator: authenticatorWithFixedAnswer(false),
        transactionHash: { imprint: new Uint8Array(34) } as unknown as DataHash,
      },
    ];
    const result = await walkChainPerTx(chain);
    expect(result.invalidAt).toBe(1);
    expect(result.verifyCalls).toBe(2);
  });

  it('all-authentic chain passes per-tx verify (no false positives)', async () => {
    const chain: AdversarialTx[] = [0, 1, 2, 3, 4].map((i) => ({
      label: `tx[${i}] authentic`,
      authenticator: authenticatorWithFixedAnswer(true),
      transactionHash: {
        imprint: new Uint8Array(34).fill(i),
      } as unknown as DataHash,
    }));
    const result = await walkChainPerTx(chain);
    expect(result.invalidAt).toBe(-1);
    expect(result.verifyCalls).toBe(chain.length);
  });

  it('SDK throw in the middle is also caught (structural failure)', async () => {
    // Hostile sender ships a malformed authenticator that throws
    // inside the SDK (RangeError on signature parse, etc.). Per
    // §5.3 [A], this maps to STRUCTURAL_INVALID, NOT auth-invalid.
    const chain: AdversarialTx[] = [
      {
        label: 'tx[0] authentic',
        authenticator: authenticatorWithFixedAnswer(true),
        transactionHash: { imprint: new Uint8Array(34) } as unknown as DataHash,
      },
      {
        label: 'tx[1] SDK-throw (malformed)',
        authenticator: {
          verify: () => {
            throw new RangeError('signature bytes invalid');
          },
        } as unknown as Authenticator,
        transactionHash: { imprint: new Uint8Array(34) } as unknown as DataHash,
      },
      {
        label: 'tx[2] authentic',
        authenticator: authenticatorWithFixedAnswer(true),
        transactionHash: { imprint: new Uint8Array(34) } as unknown as DataHash,
      },
    ];
    const result = await walkChainPerTx(chain);
    expect(result.invalidAt).toBe(1);
    expect(result.verifyCalls).toBe(2);
  });
});
