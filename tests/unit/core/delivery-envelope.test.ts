/**
 * Recipient-addressed delivery envelopes (sdk-changes S6 / wallet-api delivery):
 * an ECDH-to-recipient `{ n?: senderNametag, t?: memo }` bundle in the SAME
 * `enc1.` XChaCha20-Poly1305 wire envelope the self-scoped field encryption
 * uses — so the backend cannot tell the two apart and stores both opaquely.
 *
 * Pins the fixes for the two receiver-side bugs:
 *   A) the sender nametag travels (so the recipient never renders "Someone");
 *   B) the memo decrypts for the RECIPIENT (the self-scoped key never could).
 */

import { describe, it, expect } from 'vitest';
import {
  deriveDeliveryEncryptionKey,
  encryptDeliveryBundle,
  decryptDeliveryBundle,
  DELIVERY_ENCRYPTION_HKDF_INFO,
} from '../../../core/delivery-envelope';
import { FIELD_ENVELOPE_PREFIX, encryptField } from '../../../core/field-encryption';
import { getPublicKey } from '../../../core/crypto';
import { SphereError } from '../../../core/errors';

// Three real secp256k1 identities (sender, recipient, eavesdropper).
const SENDER_PRIV = '11'.repeat(32);
const RECIPIENT_PRIV = '22'.repeat(32);
const INTRUDER_PRIV = '33'.repeat(32);
const SENDER_PUB = getPublicKey(SENDER_PRIV);
const RECIPIENT_PUB = getPublicKey(RECIPIENT_PRIV);

describe('delivery-envelope (ECDH-to-recipient S6)', () => {
  it('the ECDH key is symmetric: senderPriv+recipientPub === recipientPriv+senderPub', () => {
    const senderSide = deriveDeliveryEncryptionKey(SENDER_PRIV, RECIPIENT_PUB);
    const recipientSide = deriveDeliveryEncryptionKey(RECIPIENT_PRIV, SENDER_PUB);
    expect(Array.from(senderSide)).toEqual(Array.from(recipientSide));
    expect(senderSide.length).toBe(32);
  });

  it('bundles nametag + memo into one enc1 envelope the RECIPIENT decrypts (bug A + B)', () => {
    const senderKey = deriveDeliveryEncryptionKey(SENDER_PRIV, RECIPIENT_PUB);
    const envelope = encryptDeliveryBundle(senderKey, { senderNametag: 'api-1', memo: 'hi' });
    expect(envelope).toBeDefined();
    expect(envelope!.startsWith(FIELD_ENVELOPE_PREFIX)).toBe(true); // wire shape unchanged
    expect(envelope).not.toContain('api-1');
    expect(envelope).not.toContain('hi');

    const recipientKey = deriveDeliveryEncryptionKey(RECIPIENT_PRIV, SENDER_PUB);
    expect(decryptDeliveryBundle(recipientKey, envelope!)).toEqual({ senderNametag: 'api-1', memo: 'hi' });
  });

  it('a self-send round-trips: ECDH(priv, ownPub) on both sides', () => {
    const selfKey = deriveDeliveryEncryptionKey(SENDER_PRIV, SENDER_PUB);
    const envelope = encryptDeliveryBundle(selfKey, { senderNametag: 'api-1', memo: 'note to self' });
    expect(decryptDeliveryBundle(selfKey, envelope!)).toEqual({ senderNametag: 'api-1', memo: 'note to self' });
  });

  it('a THIRD wallet CANNOT decrypt (addressed to the recipient only) — throws, not silent garbage', () => {
    const senderKey = deriveDeliveryEncryptionKey(SENDER_PRIV, RECIPIENT_PUB);
    const envelope = encryptDeliveryBundle(senderKey, { senderNametag: 'api-1', memo: 'hi' });
    const intruderKey = deriveDeliveryEncryptionKey(INTRUDER_PRIV, SENDER_PUB);
    expect(() => decryptDeliveryBundle(intruderKey, envelope!)).toThrow(SphereError);
  });

  it('attaches the nametag even with no memo (memo-less transfer still fixes bug A)', () => {
    const key = deriveDeliveryEncryptionKey(SENDER_PRIV, RECIPIENT_PUB);
    const envelope = encryptDeliveryBundle(key, { senderNametag: 'api-1' });
    expect(envelope).toBeDefined();
    const recipientKey = deriveDeliveryEncryptionKey(RECIPIENT_PRIV, SENDER_PUB);
    expect(decryptDeliveryBundle(recipientKey, envelope!)).toEqual({ senderNametag: 'api-1' });
  });

  it('carries a memo with no nametag', () => {
    const key = deriveDeliveryEncryptionKey(SENDER_PRIV, RECIPIENT_PUB);
    const envelope = encryptDeliveryBundle(key, { memo: 'just a memo' });
    expect(envelope).toBeDefined();
    expect(decryptDeliveryBundle(key, envelope!)).toEqual({ memo: 'just a memo' });
  });

  it('returns undefined when there is nothing to carry (no nametag, no memo, empty strings)', () => {
    const key = deriveDeliveryEncryptionKey(SENDER_PRIV, RECIPIENT_PUB);
    expect(encryptDeliveryBundle(key, {})).toBeUndefined();
    expect(encryptDeliveryBundle(key, { senderNametag: '', memo: '' })).toBeUndefined();
  });

  it('uses a delivery-specific HKDF label distinct from self-scoped S6', () => {
    expect(DELIVERY_ENCRYPTION_HKDF_INFO).toBe('sphere-deliveryenc-v1');
  });

  it('rejects a non-JSON plaintext as a decryption error (not a silent pass)', () => {
    // Hand a valid enc1 envelope over the SAME key whose plaintext is not JSON:
    // a tampered/legacy envelope must not crash the receive loop.
    const key = deriveDeliveryEncryptionKey(SENDER_PRIV, RECIPIENT_PUB);
    // encryptDeliveryBundle always emits JSON; go one level down to forge a
    // valid enc1 envelope whose plaintext is NOT JSON.
    const bad = encryptField(key, 'not json');
    expect(() => decryptDeliveryBundle(key, bad)).toThrow(SphereError);
  });
});
