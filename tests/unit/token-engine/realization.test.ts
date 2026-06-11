import { describe, expect, it } from 'vitest';

import {
  deriveRealization,
  REALIZATION_HKDF_INFO_PREFIX,
  type RealizationField,
} from '../../../token-engine/realization';
import { HexConverter } from '../../../token-engine/sdk';

const PRIV_KEY_HEX = '01'.repeat(32);
const TRANSFER_ID = '123e4567-e89b-42d3-a456-426614174000';

// Independently computed with Node's built-in crypto:
//   crypto.hkdfSync('sha256', Buffer.from('01'.repeat(32), 'hex'), Buffer.alloc(0),
//     Buffer.from(`sphere-realization-v1:123e4567-e89b-42d3-a456-426614174000:${field}:${index}`), 32)
// (empty HKDF salt ≡ HashLen zero bytes per RFC 5869 — the same "no salt" form
// @noble/hashes uses, mirroring ipns-key-derivation.ts). Pins both the formula
// and the info-string layout `sphere-realization-v1:<transferId>:<field>:<index>`.
const VECTORS: ReadonlyArray<{ field: RealizationField; index: number; hex: string }> = [
  { field: 'stateMask', index: 0, hex: '0745faebed15108b55d8e6ef0d7aad11f6c11218c2b09544d073884d03c1dd46' },
  { field: 'salt', index: 0, hex: '53613bb1d688648ca08ebd4d3b686983391115f895e3d97f905efd2a932ca369' },
  { field: 'salt', index: 1, hex: 'fa0927805faf413df18aabfc6b0fd9190160487b04f5c3d4d8ac339d078cd20d' },
  { field: 'burn', index: 0, hex: '002f07f2ab9369791b91cc65ef907371e345251466d28afb56ea6cfb7c2fdd52' },
  { field: 'tokenType', index: 0, hex: 'fdfef585980fd90aa1eae39ce2063b88b47eedcd3f50279e7cf4e1cb88f2f503' },
];

describe('deriveRealization (Part E.1)', () => {
  it('is versioned with the spec prefix', () => {
    expect(REALIZATION_HKDF_INFO_PREFIX).toBe('sphere-realization-v1');
  });

  it('returns 32 bytes', () => {
    const out = deriveRealization(PRIV_KEY_HEX, TRANSFER_ID, 0, 'stateMask');
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(32);
  });

  it('is deterministic for the same (key, transferId, index, field)', () => {
    const a = deriveRealization(PRIV_KEY_HEX, TRANSFER_ID, 3, 'salt');
    const b = deriveRealization(PRIV_KEY_HEX, TRANSFER_ID, 3, 'salt');
    expect(HexConverter.encode(a)).toBe(HexConverter.encode(b));
  });

  it('matches the hand-computed HKDF-SHA256 vectors', () => {
    for (const v of VECTORS) {
      expect(HexConverter.encode(deriveRealization(PRIV_KEY_HEX, TRANSFER_ID, v.index, v.field))).toBe(v.hex);
    }
  });

  it('is distinct across transferId, field, index and key', () => {
    const base = HexConverter.encode(deriveRealization(PRIV_KEY_HEX, TRANSFER_ID, 0, 'salt'));
    const otherTransfer = HexConverter.encode(
      deriveRealization(PRIV_KEY_HEX, '00000000-0000-4000-8000-000000000000', 0, 'salt'),
    );
    const otherField = HexConverter.encode(deriveRealization(PRIV_KEY_HEX, TRANSFER_ID, 0, 'stateMask'));
    const otherIndex = HexConverter.encode(deriveRealization(PRIV_KEY_HEX, TRANSFER_ID, 1, 'salt'));
    const otherKey = HexConverter.encode(deriveRealization('02'.repeat(32), TRANSFER_ID, 0, 'salt'));
    const all = [base, otherTransfer, otherField, otherIndex, otherKey];
    expect(new Set(all).size).toBe(all.length);
  });
});
