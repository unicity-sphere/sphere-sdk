/**
 * Round 3 — `isValidTokenId` regex tightening.
 *
 * The validator was `[0-9a-fA-F]{64}` (case-insensitive). The
 * inclusion-proof importer's `CANONICAL_TOKEN_ID_RE` is the strict
 * lowercase form `[0-9a-f]{64}`. The two-shape disagreement was a
 * per-tokenId mutex hazard — uppercase tokenIds satisfying
 * `isValidTokenId` (legacy form) acquired separate mutex slots from
 * the corresponding lowercase form.
 *
 * Round 3 tightens `isValidTokenId` to the canonical lowercase form.
 * Callers that legitimately receive uppercase from the SDK must
 * lowercase-normalize at the call site before invoking the validator.
 */

import { describe, it, expect } from 'vitest';
import { isValidTokenId } from '../../../types/txf';

describe('Round 3: isValidTokenId rejects non-lowercase hex', () => {
  it('rejects all-uppercase 64-char hex', () => {
    expect(isValidTokenId('AB'.repeat(32))).toBe(false);
  });

  it('rejects mixed-case 64-char hex', () => {
    expect(isValidTokenId('aB'.repeat(16) + 'Cd'.repeat(16))).toBe(false);
  });

  it('accepts canonical 64-char lowercase hex', () => {
    expect(isValidTokenId('ab'.repeat(32))).toBe(true);
    expect(isValidTokenId('0123456789abcdef'.repeat(4))).toBe(true);
    expect(isValidTokenId('00'.repeat(32))).toBe(true);
    expect(isValidTokenId('ff'.repeat(32))).toBe(true);
  });

  it('rejects wrong length', () => {
    expect(isValidTokenId('ab'.repeat(31))).toBe(false); // 62
    expect(isValidTokenId('ab'.repeat(33))).toBe(false); // 66
    expect(isValidTokenId('')).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(isValidTokenId('z'.repeat(64))).toBe(false);
    expect(isValidTokenId('g'.repeat(64))).toBe(false);
    expect(isValidTokenId('-'.repeat(64))).toBe(false);
  });

  it('agrees with the importer canonical regex', () => {
    // Mirror the importer's regex exactly; both must agree.
    const importerRe = /^[0-9a-f]{64}$/;
    const samples = [
      'ab'.repeat(32),
      'AB'.repeat(32),
      '00'.repeat(32),
      'ff'.repeat(32),
      'aB'.repeat(16) + 'Cd'.repeat(16),
      'Z'.repeat(64),
      '',
      'short',
    ];
    for (const s of samples) {
      expect(isValidTokenId(s)).toBe(importerRe.test(s));
    }
  });
});
