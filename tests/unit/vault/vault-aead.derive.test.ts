import { describe, it, expect } from 'vitest';

import {
  lengthDelim,
  u32be,
  u64be,
  deriveVaultKey,
  deriveCourierKey,
} from '../../../vault-aead/derive';
import { bytesToHex } from '../../../core/crypto';

const WALLET_PRIV = '11'.repeat(32);

describe('vault-aead derive: lengthDelim / u64be / HKDF', () => {
  it('lengthDelim is unambiguous (length-prefix prevents concatenation collision)', () => {
    const a = lengthDelim(['a', 'bc']);
    const b = lengthDelim(['ab', 'c']);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('lengthDelim frames each part as u32be(len)‖bytes', () => {
    const out = lengthDelim(['a']); // 00 00 00 01 61
    expect(bytesToHex(out)).toBe('0000000161');
  });

  it('u32be encodes 4-byte big-endian', () => {
    expect(bytesToHex(u32be(1))).toBe('00000001');
    expect(bytesToHex(u32be(0x01020304))).toBe('01020304');
  });

  it('u64be encodes 8-byte big-endian (pinned for v=3)', () => {
    expect(bytesToHex(u64be(3))).toBe('0000000000000003');
    expect(bytesToHex(u64be(0))).toBe('0000000000000000');
    // accepts bigint too
    expect(bytesToHex(u64be(0xdeadbeefn))).toBe('00000000deadbeef');
  });

  it('deriveVaultKey: pinned KAT', () => {
    const k = deriveVaultKey(WALLET_PRIV, 'testnet2');
    expect(k.length).toBe(32);
    // KAT — generated once from the real HKDF-SHA256 implementation.
    expect(bytesToHex(k)).toBe(
      'a7015dbb1eeb9cf7abb42450697e4d3b78d6cb85b49c72bcc2b5aeeb9d4e5780',
    );
  });

  it('deriveVaultKey is per-network (different network -> different key)', () => {
    const a = deriveVaultKey(WALLET_PRIV, 'testnet2');
    const b = deriveVaultKey(WALLET_PRIV, 'mainnet');
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('deriveCourierKey: pinned KAT', () => {
    const ecdh = new Uint8Array(32).map((_, i) => i + 1);
    const k = deriveCourierKey(ecdh, 'unicity-courier-entryid-v1');
    expect(k.length).toBe(32);
    // KAT — generated once from the real HKDF-SHA256 implementation.
    expect(bytesToHex(k)).toBe(
      '7d2ab774e1d350d734f590e65b3aa4720b6d49083a251b89d52748e7027f0984',
    );
  });
});
