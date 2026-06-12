/**
 * Courier entryId (§6.2) — HMAC over the ECDH shared secret (finding #12).
 *
 *   entryId = HMAC-SHA256(
 *     HKDF-SHA256(ecdhX(senderPriv, recipientPub), 'unicity-courier-entryid-v1'),
 *     tokenId ‖ stateHash
 *   )                                                              -> 64-hex
 *
 * The entryId binds to the EXACT `stateHash` that `PaymentsModule.tryParseBlobKeys`
 * derives (`sha256(bytesToHex(blob.token), 'hex')`) — pinned here against a fixture
 * blob so a divergence on either side is caught. The sender holds the ECDH secret
 * and the journaled blob, so it recomputes the identical entryId for replay-dedup.
 */

import { describe, it, expect } from 'vitest';

import { sha256 } from '../../../core/crypto';
import { encodeTokenBlob, decodeTokenBlob } from '../../../token-engine/token-blob';
import { hexToBytes, bytesToHex } from '../../../core/crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { courierEntryId, courierStateHash } from '../../../transport/courier/entryId';

const SENDER_PRIV = '55'.repeat(32);
const RECIPIENT_PRIV = '66'.repeat(32);
const SENDER_PUB = bytesToHex(secp256k1.getPublicKey(hexToBytes(SENDER_PRIV), true));
const RECIPIENT_PUB = bytesToHex(secp256k1.getPublicKey(hexToBytes(RECIPIENT_PRIV), true));

// A fixed v2 token blob: { v:1, network:0, tokenId, token } (token = the CBOR bytes).
const TOKEN_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const TOKEN_BYTES = new Uint8Array(40).map((_, i) => (i * 7 + 3) & 0xff);
const BLOB = encodeTokenBlob({ v: 1, network: 0, tokenId: TOKEN_ID, token: TOKEN_BYTES });
const BLOB_HEX = bytesToHex(BLOB);

describe('courier entryId', () => {
  it('stateHash equals tryParseBlobKeys (sha256(bytesToHex(blob.token)))', () => {
    // The exact computation tryParseBlobKeys performs.
    const blob = decodeTokenBlob(hexToBytes(BLOB_HEX));
    const expected = sha256(bytesToHex(blob.token), 'hex');
    expect(courierStateHash(BLOB_HEX)).toBe(expected);
  });

  it('pinned KAT', () => {
    const id = courierEntryId(SENDER_PRIV, RECIPIENT_PUB, BLOB_HEX);
    expect(id).toHaveLength(64);
    expect(id).toBe('6947a85f3d95dc27728b2f05e1c4480b7be86b3877262100277de2ede57cbfab');
  });

  it('sender recompute is identical (replay-dedup holds)', () => {
    const a = courierEntryId(SENDER_PRIV, RECIPIENT_PUB, BLOB_HEX);
    const b = courierEntryId(SENDER_PRIV, RECIPIENT_PUB, BLOB_HEX);
    expect(a).toBe(b);
  });

  it('different recipient -> different entryId', () => {
    const other = bytesToHex(secp256k1.getPublicKey(hexToBytes('77'.repeat(32)), true));
    expect(courierEntryId(SENDER_PRIV, RECIPIENT_PUB, BLOB_HEX)).not.toBe(
      courierEntryId(SENDER_PRIV, other, BLOB_HEX),
    );
  });
});
