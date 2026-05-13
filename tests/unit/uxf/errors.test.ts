/**
 * Tests for uxf/errors.ts
 * Covers UxfError construction, prototype chain, and error code typing.
 */

import { describe, it, expect } from 'vitest';
import { UxfError } from '../../../uxf/errors';
import type { UxfErrorCode } from '../../../uxf/errors';

describe('UxfError', () => {
  it('constructs with code and message', () => {
    const error = new UxfError('INVALID_HASH', 'bad hash');
    expect(error.message).toBe('[UXF:INVALID_HASH] bad hash');
    expect(error.code).toBe('INVALID_HASH');
  });

  it('is an instance of Error', () => {
    const error = new UxfError('MISSING_ELEMENT', 'not found');
    expect(error instanceof Error).toBe(true);
  });

  it('is an instance of UxfError', () => {
    const error = new UxfError('CYCLE_DETECTED', 'loop');
    expect(error instanceof UxfError).toBe(true);
  });

  it('sets name to UxfError', () => {
    const error = new UxfError('TYPE_MISMATCH', 'wrong');
    expect(error.name).toBe('UxfError');
  });

  it('stores optional cause', () => {
    const originalError = new Error('root cause');
    const error = new UxfError('SERIALIZATION_ERROR', 'fail', originalError);
    expect(error.cause).toBe(originalError);
  });

  it('cause defaults to undefined', () => {
    const error = new UxfError('INVALID_HASH', 'x');
    expect(error.cause).toBeUndefined();
  });

  it('code is typed as UxfErrorCode -- all 12 codes are valid', () => {
    const codes: UxfErrorCode[] = [
      'INVALID_HASH',
      'MISSING_ELEMENT',
      'TOKEN_NOT_FOUND',
      'STATE_INDEX_OUT_OF_RANGE',
      'TYPE_MISMATCH',
      'INVALID_INSTANCE_CHAIN',
      'DUPLICATE_TOKEN',
      'SERIALIZATION_ERROR',
      'VERIFICATION_FAILED',
      'CYCLE_DETECTED',
      'INVALID_PACKAGE',
      'NOT_IMPLEMENTED',
    ];

    for (const code of codes) {
      const error = new UxfError(code, `test ${code}`);
      expect(error.code).toBe(code);
      expect(error.message).toBe(`[UXF:${code}] test ${code}`);
    }

    expect(codes).toHaveLength(12);
  });
});
