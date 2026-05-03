/**
 * Wave M (Round 7 W2): UnicityAggregatorProvider.verifyInclusionProof
 * cache-key uniqueness across forged-vs-genuine same-tx scenarios.
 *
 * Wave I.7 added a composite cache key `${proofHash}:${transactionHash}`
 * specifically to prevent the forged-then-genuine denial-of-verification
 * scenario: forged proof A returns false → cached → genuine proof B for
 * same tx returns false from cache. Without the proofHash component,
 * both proofs collide on the cache key.
 *
 * This test asserts that two distinct proofs attesting the same
 * transactionHash but with different proofHash result in TWO independent
 * verifier invocations (not a poisoned cache hit).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnicityAggregatorProvider } from '../../../oracle/UnicityAggregatorProvider';

// Mock the SDK InclusionProof.fromJSON to return a stub proof object
// whose verify() method we control per-test. We don't need real crypto
// — we only assert cache-keying behavior.
vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/InclusionProof', async () => {
  const actual = await vi.importActual<typeof import('@unicitylabs/state-transition-sdk/lib/transaction/InclusionProof')>(
    '@unicitylabs/state-transition-sdk/lib/transaction/InclusionProof',
  );
  return {
    ...actual,
    InclusionProof: {
      fromJSON: vi.fn(),
    },
  };
});

vi.mock('@unicitylabs/state-transition-sdk/lib/api/RequestId', async () => {
  const actual = await vi.importActual<typeof import('@unicitylabs/state-transition-sdk/lib/api/RequestId')>(
    '@unicitylabs/state-transition-sdk/lib/api/RequestId',
  );
  return {
    ...actual,
    RequestId: {
      create: vi.fn(async () => ({ /* stub */ })),
    },
  };
});

import {
  InclusionProof as MockedSdkInclusionProof,
  InclusionProofVerificationStatus,
} from '@unicitylabs/state-transition-sdk/lib/transaction/InclusionProof';

describe('UnicityAggregatorProvider.verifyInclusionProof — cache-key uniqueness (Wave I.7 / M.2)', () => {
  const TX_IMPRINT = '0012' + 'cc'.repeat(32); // 68-char imprint
  const FAKE_PROOF_HASH = 'aa'.repeat(32);
  const REAL_PROOF_HASH = 'bb'.repeat(32);

  let provider: UnicityAggregatorProvider;
  let verifyCallCount: number;

  beforeEach(async () => {
    verifyCallCount = 0;
    // Build a provider with a stub trust base so the early `!trustBase`
    // return doesn't fire.
    provider = new UnicityAggregatorProvider({
      url: 'https://test.example/',
      apiKey: undefined,
      timeoutMs: 1000,
      skipVerification: true,
    });
    // Inject stub trust base directly (skip initialize).
    (provider as unknown as { trustBase: unknown }).trustBase = { stub: true };
  });

  it('forged proof A and genuine proof B attesting the same tx do NOT collide in cache', async () => {
    // First call: forged proof A. fromJSON returns a stub whose
    // verify() returns NOT_AUTHENTICATED. transactionHash matches
    // the input imprint so byte-comparison passes; the verify step
    // returns false. Cache key: A:TX → false.
    const forgedProof = {
      authenticator: { publicKey: new Uint8Array(33), stateHash: { stub: 'A' } },
      transactionHash: { imprint: hexToBytes(TX_IMPRINT) },
      verify: vi.fn(async () => {
        verifyCallCount++;
        return InclusionProofVerificationStatus.NOT_AUTHENTICATED;
      }),
    };
    const genuineProof = {
      authenticator: { publicKey: new Uint8Array(33), stateHash: { stub: 'B' } },
      transactionHash: { imprint: hexToBytes(TX_IMPRINT) },
      verify: vi.fn(async () => {
        verifyCallCount++;
        return InclusionProofVerificationStatus.OK;
      }),
    };

    const fromJsonMock = MockedSdkInclusionProof.fromJSON as unknown as ReturnType<typeof vi.fn>;
    fromJsonMock.mockReturnValueOnce(forgedProof);
    fromJsonMock.mockReturnValueOnce(genuineProof);

    // Verify forged — returns false, cache key includes proofHash A.
    const r1 = await provider.verifyInclusionProof!({
      proofJson: { stub: 'forged' },
      transactionHash: TX_IMPRINT,
      proofHash: FAKE_PROOF_HASH,
    });
    expect(r1).toBe(false);
    expect(verifyCallCount).toBe(1);

    // Verify genuine — distinct proofHash, distinct cache key. Must
    // re-run verify (not return cached false).
    const r2 = await provider.verifyInclusionProof!({
      proofJson: { stub: 'genuine' },
      transactionHash: TX_IMPRINT,
      proofHash: REAL_PROOF_HASH,
    });
    expect(r2).toBe(true);
    // Critical: verifier was called twice — second call NOT served
    // from poisoned cache.
    expect(verifyCallCount).toBe(2);
  });

  it('repeated calls with the same proofHash + transactionHash hit the cache (no re-verify)', async () => {
    // Sanity check that the cache works for the legitimate case.
    const proof = {
      authenticator: { publicKey: new Uint8Array(33), stateHash: { stub: 'X' } },
      transactionHash: { imprint: hexToBytes(TX_IMPRINT) },
      verify: vi.fn(async () => {
        verifyCallCount++;
        return InclusionProofVerificationStatus.OK;
      }),
    };
    const fromJsonMock = MockedSdkInclusionProof.fromJSON as unknown as ReturnType<typeof vi.fn>;
    fromJsonMock.mockReturnValueOnce(proof);

    const r1 = await provider.verifyInclusionProof!({
      proofJson: { stub: 'p' },
      transactionHash: TX_IMPRINT,
      proofHash: REAL_PROOF_HASH,
    });
    expect(r1).toBe(true);
    expect(verifyCallCount).toBe(1);

    // Second identical call — cache hit, no re-verify.
    const r2 = await provider.verifyInclusionProof!({
      proofJson: { stub: 'p' },
      transactionHash: TX_IMPRINT,
      proofHash: REAL_PROOF_HASH,
    });
    expect(r2).toBe(true);
    expect(verifyCallCount).toBe(1); // unchanged
  });

  // Steelman finding #156: verifyInclusionProof must throw NOT_INITIALIZED
  // when the trust base never loaded — silently returning false is a
  // degraded crypto state where every legitimate proof is dropped.
  it('throws NOT_INITIALIZED (not returns false) when trustBase is null', async () => {
    const noTrustBaseProvider = new UnicityAggregatorProvider({
      url: 'https://test.example/',
      apiKey: undefined,
      timeoutMs: 1000,
      skipVerification: true,
    });
    // Explicitly clear (constructor leaves it null too, but be belt-and-braces).
    (noTrustBaseProvider as unknown as { trustBase: unknown }).trustBase = null;

    await expect(
      noTrustBaseProvider.verifyInclusionProof!({
        proofJson: { stub: 'irrelevant' },
        transactionHash: TX_IMPRINT,
        proofHash: REAL_PROOF_HASH,
      }),
    ).rejects.toThrow(/trustBase not loaded/i);
  });

  it('two callers — one with proofHash, one without — do NOT collide on the same tx imprint', async () => {
    // proofHash-included key: `${proofHash}:${transactionHash}`
    // proofHash-omitted key:  `${transactionHash}`
    // Different keys → both calls run their own verify.
    const proof1 = {
      authenticator: { publicKey: new Uint8Array(33), stateHash: { stub: '1' } },
      transactionHash: { imprint: hexToBytes(TX_IMPRINT) },
      verify: vi.fn(async () => {
        verifyCallCount++;
        return InclusionProofVerificationStatus.OK;
      }),
    };
    const proof2 = {
      authenticator: { publicKey: new Uint8Array(33), stateHash: { stub: '2' } },
      transactionHash: { imprint: hexToBytes(TX_IMPRINT) },
      verify: vi.fn(async () => {
        verifyCallCount++;
        return InclusionProofVerificationStatus.OK;
      }),
    };
    const fromJsonMock = MockedSdkInclusionProof.fromJSON as unknown as ReturnType<typeof vi.fn>;
    fromJsonMock.mockReturnValueOnce(proof1);
    fromJsonMock.mockReturnValueOnce(proof2);

    await provider.verifyInclusionProof!({
      proofJson: { stub: 'p1' },
      transactionHash: TX_IMPRINT,
      proofHash: REAL_PROOF_HASH,
    });
    await provider.verifyInclusionProof!({
      proofJson: { stub: 'p2' },
      transactionHash: TX_IMPRINT,
      // proofHash omitted
    });
    expect(verifyCallCount).toBe(2);
  });
});

// Local hex helper.
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return out;
}
