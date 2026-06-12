import { describe, it, expect } from 'vitest';

import { NETWORKS } from '../../../constants';
import { getPublicKey } from '../../../core/crypto';

describe('NetworkConfig vaultUrl + vaultServerKey', () => {
  it('pins the production vault URLs', () => {
    expect(NETWORKS.testnet2.vaultUrl).toBe('https://vault.testnet.unicity.network');
    expect(NETWORKS.mainnet.vaultUrl).toBe('https://vault.unicity.network');
  });

  it('every network has a vaultUrl', () => {
    for (const net of Object.values(NETWORKS)) {
      expect(typeof net.vaultUrl).toBe('string');
      expect(net.vaultUrl.length).toBeGreaterThan(0);
    }
  });

  it('vaultServerKey is a 66-hex compressed pubkey on every network', () => {
    for (const net of Object.values(NETWORKS)) {
      expect(net.vaultServerKey).toMatch(/^0[23][0-9a-f]{64}$/);
    }
  });

  it('testnet2.vaultServerKey is the compressed pubkey of SERVER_SIGN_PRIV=`a`.repeat(64)', () => {
    // Part A pins the same fixture (SERVER_SIGN_PRIV = 'a'.repeat(64)); the SDK
    // must be able to verify the server's epochSig against this key.
    expect(NETWORKS.testnet2.vaultServerKey).toBe(getPublicKey('a'.repeat(64), true));
  });
});
