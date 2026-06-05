import { describe, expect, it } from 'vitest';

import { deriveDirectAddress } from '../../../token-engine/identity';

function hex(h: string): Uint8Array {
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

// Fixed reference pubkeys (compressed secp256k1): the generator G and k=2.
const PUBKEY_G = hex('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
const PUBKEY_2 = hex('02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5');

// GOLDEN VECTOR — locks the legacy DIRECT:// derivation byte-for-byte (recorded
// from the v1 UnmaskedPredicateReference path). Quest XP is keyed on this
// address (Path A); if it ever changes, users silently lose XP. At final v1
// removal, the vendored byte-exact recipe MUST still reproduce this value.
const GOLDEN_G = 'DIRECT://00001386dc2547e656f7041444e3ef3772f374305551724ef9fe86cf004a118d917dd4192a29';

describe('deriveDirectAddress (legacy DIRECT:// — Path A)', () => {
  it('matches the golden vector for a fixed pubkey (XP-invariant lock)', async () => {
    expect(await deriveDirectAddress(PUBKEY_G)).toBe(GOLDEN_G);
  });

  it('is deterministic (same pubkey → same address)', async () => {
    expect(await deriveDirectAddress(PUBKEY_G)).toBe(await deriveDirectAddress(PUBKEY_G));
  });

  it('produces a DIRECT:// address', async () => {
    expect(await deriveDirectAddress(PUBKEY_G)).toMatch(/^DIRECT:\/\//);
  });

  it('different pubkeys → different addresses', async () => {
    expect(await deriveDirectAddress(PUBKEY_G)).not.toBe(await deriveDirectAddress(PUBKEY_2));
  });
});
