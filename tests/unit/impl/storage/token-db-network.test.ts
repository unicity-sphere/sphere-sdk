/**
 * Token storage DB name is per-network + keyed by chainPubkey.
 *
 * Same mnemonic on testnet(v1) and testnet2(v2) used to share ONE DB
 * (sphere-token-storage-{addressId}) — mixing v1/v2 tokens. Now the network is
 * baked into the prefix and the identity component is the full chainPubkey
 * (always present, not truncated like getAddressId's DIRECT_first6_last6).
 */

import { describe, it, expect } from 'vitest';
import { IndexedDBTokenStorageProvider } from '../../../../impl/browser/storage/IndexedDBTokenStorageProvider';
import type { FullIdentity } from '../../../../types';

const identity = {
  chainPubkey: '03aabb',
  directAddress: 'DIRECT://xyz',
  privateKey: 'priv',
  publicKey: 'pub',
} as unknown as FullIdentity;

const dbNameOf = (p: IndexedDBTokenStorageProvider): string =>
  (p as unknown as { dbName: string }).dbName;

describe('IndexedDBTokenStorageProvider — per-network DB name', () => {
  it('bakes the network into the DB name (network before chainPubkey)', () => {
    const p = new IndexedDBTokenStorageProvider({ network: 'testnet2' });
    p.setIdentity(identity);
    expect(dbNameOf(p)).toBe('sphere-token-storage-testnet2-03aabb');
  });

  it('different networks → different DB for the SAME chainPubkey (network is the separator)', () => {
    const t2 = new IndexedDBTokenStorageProvider({ network: 'testnet2' });
    const t1 = new IndexedDBTokenStorageProvider({ network: 'testnet' });
    t2.setIdentity(identity);
    t1.setIdentity(identity);
    expect(dbNameOf(t2)).toBe('sphere-token-storage-testnet2-03aabb');
    expect(dbNameOf(t1)).toBe('sphere-token-storage-testnet-03aabb');
    expect(dbNameOf(t2)).not.toBe(dbNameOf(t1));
  });

  it('no network → legacy-shaped name (backward compatible for direct usage)', () => {
    const p = new IndexedDBTokenStorageProvider();
    p.setIdentity(identity);
    expect(dbNameOf(p)).toBe('sphere-token-storage-03aabb');
  });
});
