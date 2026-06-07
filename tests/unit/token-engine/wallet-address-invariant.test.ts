import { describe, expect, it } from 'vitest';

import { getPublicKey, sha256, hexToBytes } from '../../../core/crypto';
import { deriveDirectAddress } from '../../../token-engine/identity';

/**
 * Wallet-level XP-invariant lock. The wallet's DIRECT:// address is
 * `deriveDirectAddress(getPublicKey(SHA256(privateKey)))` (core/Sphere
 * deriveL3PredicateAddress). These golden addresses were recorded from the v1
 * path and confirmed byte-identical to the vendored derivation, for several
 * wallet private keys. Quest XP is keyed on this address — it must never change.
 */
const WALLET_GOLDEN: ReadonlyArray<readonly [privateKey: string, address: string]> = [
  ['0000000000000000000000000000000000000000000000000000000000000001', 'DIRECT://0000b97b4a83dc3fe636d4f21dbfe4c93149e07367539a059a9c8e64ad7d9fdc30644eaaf64b'],
  ['7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f', 'DIRECT://0000c6fcb02e86386b35d20908185da2752d9b94bf1222bcb602ca838323c3d35d6f0ee90e9a'],
  ['a3f1c2d4e5b6978012345678abcdefabcdef0123456789abcdef0123456789ab', 'DIRECT://0000c3f1e98c5d61ef26abaeae052f5726c91dbe33f65af22f5e404ba2b2f9e6ee97cbf6c452'],
  ['deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef0', 'DIRECT://0000b6b71b6b7003700f2b758c5f824ab51758a4a2833534a4f1d8b47d34da62fec2105b0aa3'],
];

describe('wallet DIRECT:// address (full derivation — XP invariant)', () => {
  it.each(WALLET_GOLDEN)('matches the golden wallet address for key %s', async (privateKey, address) => {
    const walletPubkey = hexToBytes(getPublicKey(sha256(privateKey, 'hex')));
    expect(await deriveDirectAddress(walletPubkey)).toBe(address);
  });
});
