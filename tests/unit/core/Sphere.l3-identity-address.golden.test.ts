/**
 * B6 (XP-CRITICAL) characterization test — legacy `DIRECT://` identity address.
 *
 * Quest XP and Unicity IDs are keyed (via sphere-api, Path A / D10) on the wallet's
 * legacy `DIRECT://` address. The v1 derivation runs through
 * `SigningService.createFromSecret(secret)`, which **SHA-256-hashes the secret**
 * before using it as the signing scalar — so the address is a function of
 * `getPublicKey(SHA256(privateKey))`, NOT of the raw `chainPubkey =
 * getPublicKey(privateKey)`. The migration replaces the v1 derivation with the
 * shared `deriveDirectAddress(pubkey)` helper (A6); this test locks the fact that
 * the delegation formula reproduces the legacy address **byte-for-byte** for real
 * private keys, and that dropping the pre-hash would silently change every user's
 * address (wiping XP).
 *
 * Golden vectors were recorded from the v1.6.1 `deriveL3PredicateAddress`
 * (`SigningService.createFromSecret` + `UnmaskedPredicateReference`) BEFORE the swap.
 * SDK-free on purpose (engine helper + core/crypto only).
 */
import { describe, expect, it } from 'vitest';

import { deriveDirectAddress } from '../../../token-engine';
import { getPublicKey, hexToBytes, sha256 } from '../../../core/crypto';

/** privateKey (hex) → legacy DIRECT:// recorded from the v1 path. */
const GOLDEN: ReadonlyArray<readonly [string, string]> = [
  [
    '0000000000000000000000000000000000000000000000000000000000000001',
    'DIRECT://0000b97b4a83dc3fe636d4f21dbfe4c93149e07367539a059a9c8e64ad7d9fdc30644eaaf64b',
  ],
  [
    '1111111111111111111111111111111111111111111111111111111111111111',
    'DIRECT://0000ed33f0366e3220d75411f4aedc51d0330536ab08e01d3b681e096b195dcdbe2f61718711',
  ],
  [
    '4242424242424242424242424242424242424242424242424242424242424242',
    'DIRECT://0000f7a7cd194a82e27ac02bdc7a5a89c02c4188c5fe55fdc2ee80829c26d02bb93f069127a3',
  ],
];

/** The migration's correct delegation: pre-hash the secret, then derive. */
const deriveFromPrivateKey = (privateKey: string): Promise<string> =>
  deriveDirectAddress(hexToBytes(getPublicKey(sha256(privateKey, 'hex'))));

describe('B6 — legacy DIRECT:// identity address (Path A, XP-invariant)', () => {
  it('delegation formula reproduces the v1 legacy DIRECT:// byte-for-byte', async () => {
    for (const [privateKey, expected] of GOLDEN) {
      expect(await deriveFromPrivateKey(privateKey)).toBe(expected);
    }
  });

  it('the SHA-256 pre-hash is load-bearing — a naive raw-pubkey derivation would change the address (XP wipe)', async () => {
    for (const [privateKey, expected] of GOLDEN) {
      const naive = await deriveDirectAddress(hexToBytes(getPublicKey(privateKey)));
      expect(naive).not.toBe(expected);
    }
  });
});
