import { describe, it, expect } from 'vitest';

import { sealVaultEntry, openVaultEntry } from '../../../vault-aead/entry';
import { deriveVaultKey } from '../../../vault-aead/derive';

const NETWORK = 'testnet2';
const OWNER_A = '02' + 'aa'.repeat(32);
const OWNER_B = '02' + 'bb'.repeat(32);
const KEY_X = 'token:keyX';
const KEY_Y = 'token:keyY';
const KEY32 = deriveVaultKey('44'.repeat(32), NETWORK);
const PT = new TextEncoder().encode('{"sdkData":"deadbeef"}');

function sealAt(ownerId: string, key: string, version: number) {
  return sealVaultEntry({ network: NETWORK, ownerId, key, version, plaintext: PT, key32: KEY32 });
}

describe('vault-aead entry: AAD-binding tamper matrix', () => {
  it('returns a {nonce, ct} base64 payload', () => {
    const p = sealAt(OWNER_A, KEY_X, 3);
    expect(typeof p.nonce).toBe('string');
    expect(typeof p.ct).toBe('string');
    // base64 round-trips back to 24-byte nonce
    expect(Buffer.from(p.nonce, 'base64').length).toBe(24);
  });

  it('open succeeds for the exact (network, ownerA, keyX, v3)', () => {
    const payload = sealAt(OWNER_A, KEY_X, 3);
    const pt = openVaultEntry({
      network: NETWORK,
      ownerId: OWNER_A,
      key: KEY_X,
      version: 3,
      payload,
      key32: KEY32,
    });
    expect(Buffer.from(pt).equals(Buffer.from(PT))).toBe(true);
  });

  it('throws on owner mutation (ownerB instead of ownerA)', () => {
    const payload = sealAt(OWNER_A, KEY_X, 3);
    expect(() =>
      openVaultEntry({ network: NETWORK, ownerId: OWNER_B, key: KEY_X, version: 3, payload, key32: KEY32 }),
    ).toThrow();
  });

  it('throws on key mutation (keyY instead of keyX)', () => {
    const payload = sealAt(OWNER_A, KEY_X, 3);
    expect(() =>
      openVaultEntry({ network: NETWORK, ownerId: OWNER_A, key: KEY_Y, version: 3, payload, key32: KEY32 }),
    ).toThrow();
  });

  it('throws on version mutation (v4 instead of v3)', () => {
    const payload = sealAt(OWNER_A, KEY_X, 3);
    expect(() =>
      openVaultEntry({ network: NETWORK, ownerId: OWNER_A, key: KEY_X, version: 4, payload, key32: KEY32 }),
    ).toThrow();
  });

  it('throws on network mutation', () => {
    const payload = sealAt(OWNER_A, KEY_X, 3);
    expect(() =>
      openVaultEntry({ network: 'mainnet', ownerId: OWNER_A, key: KEY_X, version: 3, payload, key32: KEY32 }),
    ).toThrow();
  });
});
