/**
 * Reserved meta-address entry codec (§5.5).
 *
 * Round-trips the `{directAddress, chainPubkey, formatVersion}` plaintext under
 * a fixed reserved wire key with the seed-derived AEAD key — proving there is no
 * decrypt-needs-address cycle (the key comes from `deriveVaultKey`, not from the
 * address being restored). Also proves the reserved key matches the wire key and
 * that the AAD owner binding holds.
 */

import { describe, it, expect } from 'vitest';

import {
  sealReservedAddress,
  openReservedAddress,
  reservedAddressKey,
} from '../../../storage/remote/reserved-address';
import { wireKey } from '../../../storage/remote/wire-key';

const WALLET_PRIV = '11'.repeat(32);
const CHAIN_PUBKEY = '034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa';
const META = {
  directAddress: 'DIRECT://abc123',
  chainPubkey: CHAIN_PUBKEY,
  formatVersion: 1,
};

describe('reserved meta-address entry codec', () => {
  it('reservedAddressKey === wireKey(_vaultmeta_addr)', () => {
    expect(reservedAddressKey(WALLET_PRIV, 'testnet2')).toBe(
      wireKey(WALLET_PRIV, 'testnet2', '_vaultmeta_addr'),
    );
  });

  it('round-trips the reserved address plaintext', () => {
    const payload = sealReservedAddress(META, WALLET_PRIV, 'testnet2');
    expect(typeof payload.nonce).toBe('string');
    expect(typeof payload.ct).toBe('string');

    const restored = openReservedAddress(payload, CHAIN_PUBKEY, WALLET_PRIV, 'testnet2');
    expect(restored).toEqual(META);
  });

  it('AAD binds the owner (wrong chainPubkey -> open throws)', () => {
    const payload = sealReservedAddress(META, WALLET_PRIV, 'testnet2');
    expect(() =>
      openReservedAddress(payload, '02'.padEnd(66, 'b'), WALLET_PRIV, 'testnet2'),
    ).toThrow();
  });
});
