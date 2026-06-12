import { describe, it, expect } from 'vitest';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { assertOnCurve, ecdhX } from '../../../vault-aead/ecdh';
import { bytesToHex, hexToBytes } from '../../../core/crypto';

const SENDER_PRIV = '22'.repeat(32);
const RECIPIENT_PRIV = '33'.repeat(32);
const SENDER_PUB = bytesToHex(secp256k1.getPublicKey(hexToBytes(SENDER_PRIV), true));
const RECIPIENT_PUB = bytesToHex(secp256k1.getPublicKey(hexToBytes(RECIPIENT_PRIV), true));

describe('vault-aead ecdh: on-curve guard + ECDH-x', () => {
  it('assertOnCurve passes for a real derived compressed pubkey', () => {
    expect(() => assertOnCurve(RECIPIENT_PUB)).not.toThrow();
  });

  it('assertOnCurve throws on a fabricated bad point (x not on curve)', () => {
    // '02' + an x-coord that is not a valid field element / not on the curve.
    expect(() => assertOnCurve('02' + 'ff'.repeat(32))).toThrow();
  });

  it('ecdhX returns 32 bytes and is symmetric across the two endpoints', () => {
    const a = ecdhX(SENDER_PRIV, RECIPIENT_PUB);
    const b = ecdhX(RECIPIENT_PRIV, SENDER_PUB);
    expect(a.length).toBe(32);
    expect(b.length).toBe(32);
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });

  it('ecdhX pins the x-coordinate (slice [1,33), NOT [0,32))', () => {
    // KAT — generated once. A wrong slice round-trips but yields a wrong KAT.
    const x = ecdhX(SENDER_PRIV, RECIPIENT_PUB);
    expect(bytesToHex(x)).toBe(
      '9110f8760a37d96052e3dcaf14862a147654f49f722cf213568ccef1eca2ec71',
    );
  });

  it('@noble v2 getSharedSecret rejects a hex string (must pass Uint8Array)', () => {
    // Documents the gotcha: ecdhX hexToBytes-es internally; calling the raw
    // primitive with a hex string throws.
    expect(() => secp256k1.getSharedSecret(SENDER_PRIV as never, hexToBytes(RECIPIENT_PUB))).toThrow();
  });
});
