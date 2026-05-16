/**
 * Error taxonomy (T-A2) — count + class invariants.
 */

import { describe, it, expect } from 'vitest';
import {
  AggregatorPointerError,
  AggregatorPointerErrorCode,
} from '../../../../profile/aggregator-pointer/index.js';

describe('AggregatorPointerError taxonomy (T-A2)', () => {
  it('exposes exactly 27 codes (SPEC §12 v3.5)', () => {
    // 26 AGGREGATOR_POINTER_* + 1 SECURITY_ORIGIN_MISMATCH
    expect(Object.keys(AggregatorPointerErrorCode).length).toBe(27);
  });

  it('all AGGREGATOR_POINTER_* codes carry the correct prefix', () => {
    for (const [key, value] of Object.entries(AggregatorPointerErrorCode)) {
      if (key === 'SECURITY_ORIGIN_MISMATCH') {
        expect(value).toBe('SECURITY_ORIGIN_MISMATCH');
      } else {
        expect(value.startsWith('AGGREGATOR_POINTER_')).toBe(true);
      }
    }
  });

  it('values are pairwise unique', () => {
    const values = Object.values(AggregatorPointerErrorCode);
    expect(new Set(values).size).toBe(values.length);
  });

  it('instance carries code + message + details', () => {
    const err = new AggregatorPointerError(
      AggregatorPointerErrorCode.REJECTED,
      'v burned',
      { v: 7, side: 0x00 },
    );
    expect(err.code).toBe('AGGREGATOR_POINTER_REJECTED');
    expect(err.message).toBe('v burned');
    expect(err.details).toEqual({ v: 7, side: 0x00 });
    expect(err.name).toBe('AggregatorPointerError');
    expect(err).toBeInstanceOf(Error);
  });

  it('instance chains cause', () => {
    const inner = new Error('network down');
    const err = new AggregatorPointerError(
      AggregatorPointerErrorCode.NETWORK_ERROR,
      'submit failed',
      undefined,
      { cause: inner },
    );
    expect((err as Error & { cause?: unknown }).cause).toBe(inner);
  });

  it('message defaults to code if omitted', () => {
    const err = new AggregatorPointerError(AggregatorPointerErrorCode.CONFLICT);
    expect(err.message).toBe('AGGREGATOR_POINTER_CONFLICT');
  });

  it('deleted v3.4 codes are NOT in the taxonomy', () => {
    const codes = Object.values(AggregatorPointerErrorCode) as string[];
    expect(codes).not.toContain('AGGREGATOR_POINTER_CERT_PIN_MISMATCH');
    expect(codes).not.toContain('AGGREGATOR_POINTER_MIRROR_LIST_TAMPERED');
    expect(codes).not.toContain('AGGREGATOR_POINTER_TRUST_BASE_DIVERGENCE');
  });
});
