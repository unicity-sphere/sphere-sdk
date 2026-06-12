/**
 * Wire key (§5.2) — operator can't correlate token IDs.
 *
 * Pins the HKDF-then-HMAC derivation (KAT), proves determinism, and proves the
 * network is bound into the key (cross-network isolation).
 */

import { describe, it, expect } from 'vitest';

import { wireKey } from '../../../storage/remote/wire-key';

const WALLET_PRIV = '11'.repeat(32);

describe('vault wire key', () => {
  it('pinned KAT for the reserved meta-address key', () => {
    const k = wireKey(WALLET_PRIV, 'testnet2', '_vaultmeta_addr');
    expect(k).toHaveLength(64);
    expect(k).toBe('f60092d93dddf81e5360ad53645ea09b9d5339d4e80b9f21ef85b78e6f27d8f4');
  });

  it('is deterministic for identical inputs', () => {
    expect(wireKey(WALLET_PRIV, 'testnet2', 'hello')).toBe(
      wireKey(WALLET_PRIV, 'testnet2', 'hello'),
    );
  });

  it('binds the network (different network -> different wire key)', () => {
    expect(wireKey(WALLET_PRIV, 'testnet2', 'hello')).not.toBe(
      wireKey(WALLET_PRIV, 'mainnet', 'hello'),
    );
  });
});
