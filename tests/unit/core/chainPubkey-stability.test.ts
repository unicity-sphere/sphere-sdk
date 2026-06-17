/**
 * chainPubkey stability cross-check (D9, merge-gate item #7).
 *
 * `chainPubkey` is the wallet's identity anchor (Nostr npub and the L3
 * recipient predicate both hang off it). The v1→v2 migration must NOT change it. sphere
 * derives it with `elliptic` (core/crypto); the v2 state-transition SDK derives signing
 * keys with `@noble/curves`. This test locks that, for a fixed private key, both produce
 * the BYTE-IDENTICAL 33-byte compressed secp256k1 public key — so chainPubkey is stable
 * across the engine swap regardless of which library computes it.
 *
 * SDK-side import goes through token-engine/sdk (the single SDK boundary), exactly as the
 * engine's own tests do.
 */
import { describe, expect, it } from 'vitest';

import { getPublicKey, hexToBytes } from '../../../core/crypto';
import { HexConverter, SigningService } from '../../../token-engine/sdk';

// Fixed, valid secp256k1 private scalars (all < curve order n).
const PRIVATE_KEYS: readonly string[] = [
  '0000000000000000000000000000000000000000000000000000000000000001',
  '1111111111111111111111111111111111111111111111111111111111111111',
  '4242424242424242424242424242424242424242424242424242424242424242',
  'f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f',
];

describe('chainPubkey stability (D9) — sphere elliptic ≡ v2 SDK @noble', () => {
  it('getPublicKey (elliptic) === SigningService.publicKey (@noble) for each key', () => {
    for (const priv of PRIVATE_KEYS) {
      const sphereCompressed = getPublicKey(priv).toLowerCase();
      const sdkCompressed = HexConverter.encode(new SigningService(hexToBytes(priv)).publicKey).toLowerCase();
      expect(sdkCompressed).toBe(sphereCompressed);
      expect(sphereCompressed).toMatch(/^0[23][0-9a-f]{64}$/); // 33-byte compressed point
    }
  });
});
