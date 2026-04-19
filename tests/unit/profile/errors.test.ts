/**
 * Tests for profile/errors.ts
 * Covers ProfileError construction, prototype chain, error code typing, and message formatting.
 */

import { describe, it, expect } from 'vitest';
import { ProfileError } from '../../../profile/errors';
import type { ProfileErrorCode } from '../../../profile/errors';

describe('ProfileError', () => {
  it('constructs with code and message', () => {
    const error = new ProfileError('ENCRYPTION_FAILED', 'bad key');
    expect(error.message).toBe('[PROFILE:ENCRYPTION_FAILED] bad key');
    expect(error.code).toBe('ENCRYPTION_FAILED');
  });

  it('is an instance of Error', () => {
    const error = new ProfileError('DECRYPTION_FAILED', 'tampered');
    expect(error instanceof Error).toBe(true);
  });

  it('is an instance of ProfileError', () => {
    const error = new ProfileError('BUNDLE_NOT_FOUND', 'missing');
    expect(error instanceof ProfileError).toBe(true);
  });

  it('sets name to ProfileError', () => {
    const error = new ProfileError('MIGRATION_FAILED', 'step 3');
    expect(error.name).toBe('ProfileError');
  });

  it('stores optional cause', () => {
    const originalError = new Error('root cause');
    const error = new ProfileError('MIGRATION_FAILED', 'fail', originalError);
    expect(error.cause).toBe(originalError);
  });

  it('cause defaults to undefined', () => {
    const error = new ProfileError('ENCRYPTION_FAILED', 'x');
    expect(error.cause).toBeUndefined();
  });

  it('all 11 error codes produce valid formatted messages', () => {
    const codes: ProfileErrorCode[] = [
      'PROFILE_NOT_INITIALIZED',
      'ORBITDB_WRITE_FAILED',
      'ORBITDB_READ_FAILED',
      'ORBITDB_CONNECTION_FAILED',
      'ORBITDB_NOT_INSTALLED',
      'BUNDLE_NOT_FOUND',
      'CONSOLIDATION_IN_PROGRESS',
      'MIGRATION_FAILED',
      'ENCRYPTION_FAILED',
      'DECRYPTION_FAILED',
      'BOOTSTRAP_REQUIRED',
    ];

    for (const code of codes) {
      const error = new ProfileError(code, `test ${code}`);
      expect(error.code).toBe(code);
      expect(error.message).toBe(`[PROFILE:${code}] test ${code}`);
    }

    expect(codes).toHaveLength(11);
  });
});
