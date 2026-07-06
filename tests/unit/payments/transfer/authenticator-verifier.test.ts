/**
 * Tests for `modules/payments/transfer/authenticator-verifier.ts` (T.3.B.1).
 *
 * Spec references: §5.3 [C](1) ECDSA per-tx mandatory, §5.3 [A]
 * structural-throw routing, W37 / Note N7 per-tx-not-just-head.
 */

import { describe, it, expect } from 'vitest';
import type { Authenticator } from '@unicitylabs/state-transition-sdk/lib/api/Authenticator';
import type { DataHash } from '@unicitylabs/state-transition-sdk/lib/hash/DataHash';

import { verifyAuthenticator } from '../../../../extensions/uxf/pipeline/authenticator-verifier';

// =============================================================================
// Test doubles — minimal Authenticator + DataHash stubs
// =============================================================================

function authenticatorReturning(answer: boolean): Authenticator {
  return {
    verify: async (_h: DataHash): Promise<boolean> => answer,
  } as unknown as Authenticator;
}

function authenticatorThrowingSync(error: unknown): Authenticator {
  return {
    verify: (_h: DataHash): Promise<boolean> => {
      throw error;
    },
  } as unknown as Authenticator;
}

function authenticatorRejectingAsync(error: unknown): Authenticator {
  return {
    verify: async (_h: DataHash): Promise<boolean> => {
      throw error;
    },
  } as unknown as Authenticator;
}

function authenticatorReturningNonBoolean(value: unknown): Authenticator {
  return {
    verify: async (_h: DataHash) => value as boolean,
  } as unknown as Authenticator;
}

const FAKE_DATAHASH = {
  // We never inspect this in the wrapper; the SDK call is stubbed.
  algorithm: 0,
  data: new Uint8Array(32),
  imprint: new Uint8Array(34),
} as unknown as DataHash;

// =============================================================================
// Test cases
// =============================================================================

describe('verifyAuthenticator — happy path', () => {
  it('returns ok:true valid:true when SDK verify returns true', async () => {
    const result = await verifyAuthenticator(
      authenticatorReturning(true),
      FAKE_DATAHASH,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.valid).toBe(true);
    }
  });

  it('returns ok:true valid:false when SDK verify returns false', async () => {
    const result = await verifyAuthenticator(
      authenticatorReturning(false),
      FAKE_DATAHASH,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.valid).toBe(false);
    }
  });
});

describe('verifyAuthenticator — structural failure', () => {
  it('returns ok:false threw:true on sync throw inside verify', async () => {
    const boom = new RangeError('signature bytes invalid');
    const result = await verifyAuthenticator(
      authenticatorThrowingSync(boom),
      FAKE_DATAHASH,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.threw).toBe(true);
      expect(result.error).toBe(boom);
    }
  });

  it('returns ok:false threw:true on async-reject inside verify', async () => {
    const boom = new Error('curve operation failed');
    const result = await verifyAuthenticator(
      authenticatorRejectingAsync(boom),
      FAKE_DATAHASH,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.threw).toBe(true);
      expect(result.error).toBe(boom);
    }
  });

  it('catches non-Error throws (string, undefined)', async () => {
    for (const thrown of ['secp256k1 horror', undefined]) {
      const result = await verifyAuthenticator(
        authenticatorThrowingSync(thrown),
        FAKE_DATAHASH,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(thrown);
      }
    }
  });
});

describe('verifyAuthenticator — defensive arg validation', () => {
  it('returns ok:false on null authenticator', async () => {
    const result = await verifyAuthenticator(
      null as unknown as Authenticator,
      FAKE_DATAHASH,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(TypeError);
    }
  });

  it('returns ok:false on null transactionHash', async () => {
    const result = await verifyAuthenticator(
      authenticatorReturning(true),
      null as unknown as DataHash,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(TypeError);
    }
  });

  it('returns ok:false when authenticator.verify is not a function', async () => {
    const broken = { verify: 'not-a-function' } as unknown as Authenticator;
    const result = await verifyAuthenticator(broken, FAKE_DATAHASH);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(TypeError);
    }
  });
});

describe('verifyAuthenticator — strict boolean enforcement (steelman)', () => {
  // Steelman fix: SDK contract is `Promise<boolean>`. A defective SDK
  // returning truthy non-boolean would otherwise silently accept
  // forged signatures. Anything other than literal true/false surfaces
  // as a structural defect so the disposition matrix can route to
  // STRUCTURAL_INVALID.
  it('rejects truthy non-boolean (1) as structural defect', async () => {
    const result = await verifyAuthenticator(
      authenticatorReturningNonBoolean(1),
      FAKE_DATAHASH,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.threw).toBe(true);
      expect(result.error).toBeInstanceOf(TypeError);
    }
  });

  it('rejects falsy non-boolean (0) as structural defect', async () => {
    const result = await verifyAuthenticator(
      authenticatorReturningNonBoolean(0),
      FAKE_DATAHASH,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.threw).toBe(true);
      expect(result.error).toBeInstanceOf(TypeError);
    }
  });
});

describe('verifyAuthenticator — purity', () => {
  it('does not mutate the authenticator object', async () => {
    const auth = authenticatorReturning(true);
    const snapshot = JSON.stringify(Object.keys(auth));
    await verifyAuthenticator(auth, FAKE_DATAHASH);
    expect(JSON.stringify(Object.keys(auth))).toBe(snapshot);
  });

  it('returns identical results across repeated calls (idempotent)', async () => {
    const auth = authenticatorReturning(true);
    const a = await verifyAuthenticator(auth, FAKE_DATAHASH);
    const b = await verifyAuthenticator(auth, FAKE_DATAHASH);
    expect(a).toEqual(b);
  });
});
