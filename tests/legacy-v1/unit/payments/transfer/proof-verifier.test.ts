/**
 * Tests for `modules/payments/transfer/proof-verifier.ts` (T.3.B.1).
 *
 * Spec references: §5.3 [C](3) PATH_NOT_INCLUDED-at-receive maps to
 * `proof-invalid` (caller responsibility); §5.3 [A] verifier-throw
 * maps to `proof-throw`.
 */

import { describe, it, expect } from 'vitest';
import { InclusionProofVerificationStatus } from '@unicitylabs/state-transition-sdk/lib/transaction/InclusionProof';
import type { InclusionProof } from '@unicitylabs/state-transition-sdk/lib/transaction/InclusionProof';
import type { RequestId } from '@unicitylabs/state-transition-sdk/lib/api/RequestId';
import type { RootTrustBase } from '@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase';

import { verifyProof } from '../../../../extensions/uxf/pipeline/proof-verifier';

// =============================================================================
// Test doubles
// =============================================================================

function proofReturning(status: InclusionProofVerificationStatus): InclusionProof {
  return {
    verify: async (
      _t: RootTrustBase,
      _r: RequestId,
    ): Promise<InclusionProofVerificationStatus> => status,
  } as unknown as InclusionProof;
}

function proofThrowingSync(error: unknown): InclusionProof {
  return {
    verify: (_t: RootTrustBase, _r: RequestId) => {
      throw error;
    },
  } as unknown as InclusionProof;
}

function proofRejectingAsync(error: unknown): InclusionProof {
  return {
    verify: async (_t: RootTrustBase, _r: RequestId) => {
      throw error;
    },
  } as unknown as InclusionProof;
}

function proofReturningUnknownStatus(): InclusionProof {
  return {
    verify: async (_t: RootTrustBase, _r: RequestId) =>
      'FUTURE_NEW_STATUS' as unknown as InclusionProofVerificationStatus,
  } as unknown as InclusionProof;
}

const FAKE_TRUSTBASE = {} as RootTrustBase;
const FAKE_REQUEST_ID = {} as RequestId;

// =============================================================================
// Test cases
// =============================================================================

describe('verifyProof — happy path / status forwarding', () => {
  it('returns OK on InclusionProofVerificationStatus.OK', async () => {
    const result = await verifyProof(
      proofReturning(InclusionProofVerificationStatus.OK),
      FAKE_TRUSTBASE,
      FAKE_REQUEST_ID,
    );
    expect(result).toBe('OK');
  });

  it('returns PATH_INVALID on InclusionProofVerificationStatus.PATH_INVALID', async () => {
    const result = await verifyProof(
      proofReturning(InclusionProofVerificationStatus.PATH_INVALID),
      FAKE_TRUSTBASE,
      FAKE_REQUEST_ID,
    );
    expect(result).toBe('PATH_INVALID');
  });

  it('returns NOT_AUTHENTICATED on InclusionProofVerificationStatus.NOT_AUTHENTICATED', async () => {
    const result = await verifyProof(
      proofReturning(InclusionProofVerificationStatus.NOT_AUTHENTICATED),
      FAKE_TRUSTBASE,
      FAKE_REQUEST_ID,
    );
    expect(result).toBe('NOT_AUTHENTICATED');
  });

  it('returns PATH_NOT_INCLUDED on InclusionProofVerificationStatus.PATH_NOT_INCLUDED', async () => {
    // CRITICAL: this module returns the literal `PATH_NOT_INCLUDED`
    // unchanged. The receive-time mapping to `proof-invalid` is the
    // caller's (T.3.B.2) responsibility per §5.3 [C](3).
    const result = await verifyProof(
      proofReturning(InclusionProofVerificationStatus.PATH_NOT_INCLUDED),
      FAKE_TRUSTBASE,
      FAKE_REQUEST_ID,
    );
    expect(result).toBe('PATH_NOT_INCLUDED');
  });
});

describe('verifyProof — exceptional paths return THROWN', () => {
  it('returns THROWN on synchronous throw inside verify', async () => {
    const result = await verifyProof(
      proofThrowingSync(new Error('CBOR decode failed')),
      FAKE_TRUSTBASE,
      FAKE_REQUEST_ID,
    );
    expect(result).toBe('THROWN');
  });

  it('returns THROWN on async-rejected verify', async () => {
    const result = await verifyProof(
      proofRejectingAsync(new RangeError('SMT path malformed')),
      FAKE_TRUSTBASE,
      FAKE_REQUEST_ID,
    );
    expect(result).toBe('THROWN');
  });

  it('returns THROWN on non-Error throw values', async () => {
    const result = await verifyProof(
      proofThrowingSync('boom-string'),
      FAKE_TRUSTBASE,
      FAKE_REQUEST_ID,
    );
    expect(result).toBe('THROWN');
  });

  it('returns THROWN on unknown future status (forward-compat fail-closed)', async () => {
    const result = await verifyProof(
      proofReturningUnknownStatus(),
      FAKE_TRUSTBASE,
      FAKE_REQUEST_ID,
    );
    expect(result).toBe('THROWN');
  });
});

describe('verifyProof — defensive arg validation', () => {
  it('returns THROWN on null proof', async () => {
    const result = await verifyProof(
      null as unknown as InclusionProof,
      FAKE_TRUSTBASE,
      FAKE_REQUEST_ID,
    );
    expect(result).toBe('THROWN');
  });

  it('returns THROWN on null trustBase', async () => {
    const result = await verifyProof(
      proofReturning(InclusionProofVerificationStatus.OK),
      null as unknown as RootTrustBase,
      FAKE_REQUEST_ID,
    );
    expect(result).toBe('THROWN');
  });

  it('returns THROWN on null requestId', async () => {
    const result = await verifyProof(
      proofReturning(InclusionProofVerificationStatus.OK),
      FAKE_TRUSTBASE,
      null as unknown as RequestId,
    );
    expect(result).toBe('THROWN');
  });

  it('returns THROWN when proof.verify is not a function', async () => {
    const broken = { verify: 'not-a-function' } as unknown as InclusionProof;
    const result = await verifyProof(broken, FAKE_TRUSTBASE, FAKE_REQUEST_ID);
    expect(result).toBe('THROWN');
  });
});

describe('verifyProof — purity / idempotence', () => {
  it('repeated calls return identical results (OK)', async () => {
    const proof = proofReturning(InclusionProofVerificationStatus.OK);
    const a = await verifyProof(proof, FAKE_TRUSTBASE, FAKE_REQUEST_ID);
    const b = await verifyProof(proof, FAKE_TRUSTBASE, FAKE_REQUEST_ID);
    expect(a).toBe(b);
  });

  it('repeated calls return identical results (PATH_NOT_INCLUDED)', async () => {
    const proof = proofReturning(
      InclusionProofVerificationStatus.PATH_NOT_INCLUDED,
    );
    const a = await verifyProof(proof, FAKE_TRUSTBASE, FAKE_REQUEST_ID);
    const b = await verifyProof(proof, FAKE_TRUSTBASE, FAKE_REQUEST_ID);
    expect(a).toBe(b);
    expect(a).toBe('PATH_NOT_INCLUDED');
  });
});
