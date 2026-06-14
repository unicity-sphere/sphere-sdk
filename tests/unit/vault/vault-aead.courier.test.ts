import { describe, it, expect } from 'vitest';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  sealCourierEnvelope,
  openCourierEnvelope,
  packCourier,
  unpackCourier,
} from '../../../vault-aead/courier';
import { bytesToHex, hexToBytes } from '../../../core/crypto';

const NETWORK = 'testnet2';
const SENDER_PRIV = '55'.repeat(32);
const RECIPIENT_PRIV = '66'.repeat(32);
const SENDER_PUB = bytesToHex(secp256k1.getPublicKey(hexToBytes(SENDER_PRIV), true));
const RECIPIENT_PUB = bytesToHex(secp256k1.getPublicKey(hexToBytes(RECIPIENT_PRIV), true));
const ENTRY_ID = 'ab'.repeat(32); // 64-hex
const PT = new TextEncoder().encode('{"token":"v2blob","memo":"hi"}');
const FIXED_NONCE = new Uint8Array(24).map((_, i) => 0x10 + i);

function sealParams(extra?: Partial<Record<string, string>>) {
  return {
    network: NETWORK,
    senderPriv: SENDER_PRIV,
    senderPubkey: SENDER_PUB,
    recipientPubkey: RECIPIENT_PUB,
    entryId: ENTRY_ID,
    plaintext: PT,
    ...extra,
  };
}

function openParams(ciphertext: string, extra?: Partial<Record<string, string>>) {
  return {
    network: NETWORK,
    recipientPriv: RECIPIENT_PRIV,
    senderPubkey: SENDER_PUB,
    recipientPubkey: RECIPIENT_PUB,
    entryId: ENTRY_ID,
    ciphertext,
    ...extra,
  };
}

describe('vault-aead courier: envelope + base64(nonce‖ct) framing', () => {
  it('packCourier/unpackCourier are inverse; first 24 bytes are the nonce', () => {
    const nonce = new Uint8Array(24).map((_, i) => i);
    const ct = new Uint8Array([1, 2, 3, 4, 5]);
    const packed = packCourier(nonce, ct);
    const { nonce: n2, ct: c2 } = unpackCourier(packed);
    expect(bytesToHex(n2)).toBe(bytesToHex(nonce));
    expect(bytesToHex(c2)).toBe(bytesToHex(ct));
  });

  it('round-trips via the two ECDH endpoints', () => {
    const ciphertext = sealCourierEnvelope(sealParams());
    const pt = openCourierEnvelope(openParams(ciphertext));
    expect(Buffer.from(pt).equals(Buffer.from(PT))).toBe(true);
  });

  it('deposit round-trip vector (fixed nonce -> fixed packed base64)', () => {
    const ciphertext = sealCourierEnvelope(sealParams(), FIXED_NONCE);
    // KAT — generated once from the real seal with the fixed nonce.
    expect(ciphertext).toBe(
      'EBESExQVFhcYGRobHB0eHyAhIiMkJSYnKgg7ixHAGvoM+Cu8a3VdkGKNbXDiVRO+eWAIaAg02ItCOTT5lW0n3WTkpdwcFg==',
    );
    // and it still opens back to plaintext
    const pt = openCourierEnvelope(openParams(ciphertext));
    expect(Buffer.from(pt).equals(Buffer.from(PT))).toBe(true);
  });

  it('1-byte tamper of entryId (AAD) -> open throws', () => {
    const ciphertext = sealCourierEnvelope(sealParams());
    const badEntryId = 'ac' + ENTRY_ID.slice(2); // flip first byte
    expect(() => openCourierEnvelope(openParams(ciphertext, { entryId: badEntryId }))).toThrow();
  });

  it('1-byte tamper of the packed ciphertext -> open throws', () => {
    const ciphertext = sealCourierEnvelope(sealParams());
    const bytes = new Uint8Array(Buffer.from(ciphertext, 'base64'));
    bytes[bytes.length - 1] ^= 0x01; // flip a ct byte (not nonce)
    const tampered = Buffer.from(bytes).toString('base64');
    expect(() => openCourierEnvelope(openParams(tampered))).toThrow();
  });

  it('cross-network isolation: opening with a different network throws (AAD binds network)', () => {
    // Decision (courier-key-omits-network): the courier AEAD KEY deliberately omits
    // `network` — cross-network isolation is provided by the AAD, which binds network
    // as its first length-delimited field. A `testnet2`-sealed envelope cannot be
    // opened under a `mainnet` AAD: the Poly1305 tag fails. This is the isolation
    // guarantee that makes baking network into the key (wire-affecting KAT churn)
    // unnecessary for single-network deployments.
    const ciphertext = sealCourierEnvelope(sealParams()); // sealed on testnet2
    expect(() => openCourierEnvelope(openParams(ciphertext, { network: 'mainnet' }))).toThrow();
    // And it still opens on the matching network (sanity).
    expect(() => openCourierEnvelope(openParams(ciphertext))).not.toThrow();
  });
});
