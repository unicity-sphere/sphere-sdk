/**
 * Courier deposit (Task 5.1, §6.2/§6.3) against the in-process fake server.
 *
 * Asserts the provider seals + packs `ciphertext = base64(nonce24‖ct)`, POSTs the
 * exact deposit body `{recipientPubkey, entryId, transferId, ciphertext}` (entryId
 * = the ECDH `courierEntryId`; NO `{nonce,ct}` hint object), and that the recipient
 * can open the deposited envelope back to the original V2_TRANSFER payload.
 */

import { describe, it, expect } from 'vitest';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '../../../core/crypto';
import { encodeTokenBlob } from '../../../token-engine/token-blob';
import { CourierDeliveryProvider } from '../../../transport/courier/CourierDeliveryProvider';
import { courierEntryId } from '../../../transport/courier/entryId';
import { openCourierEnvelope, unpackCourier } from '../../../vault-aead/courier';
import { FakeCourierServer } from '../../helpers/fake-courier-server';
import type { FullIdentity } from '../../../types';
import type { CourierJournalStore, V2TransferSink } from '../../../transport/courier/CourierDeliveryProvider';

const NETWORK = 'testnet2';
const SENDER_PRIV = '55'.repeat(32);
const RECIPIENT_PRIV = '66'.repeat(32);
const SENDER_PUB = bytesToHex(secp256k1.getPublicKey(hexToBytes(SENDER_PRIV), true));
const RECIPIENT_PUB = bytesToHex(secp256k1.getPublicKey(hexToBytes(RECIPIENT_PRIV), true));

const TOKEN_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const TOKEN_BYTES = new Uint8Array(40).map((_, i) => (i * 7 + 3) & 0xff);
const BLOB_HEX = bytesToHex(encodeTokenBlob({ v: 1, network: 0, tokenId: TOKEN_ID, token: TOKEN_BYTES }));

function memJournal(): CourierJournalStore {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}

const senderId: FullIdentity = {
  chainPubkey: SENDER_PUB,
  l1Address: 'alpha1sender',
  privateKey: SENDER_PRIV,
};

function makeProvider(server: FakeCourierServer, sink: V2TransferSink): CourierDeliveryProvider {
  const p = new CourierDeliveryProvider({
    vaultUrl: 'https://vault.testnet.unicity.network',
    network: NETWORK,
    httpClientFactory: (ownerId) => server.clientFor(ownerId),
    journal: memJournal(),
    onV2Transfer: sink,
  });
  p.setIdentity(senderId);
  return p;
}

describe('courier deposit', () => {
  it('POSTs exactly {recipientPubkey, entryId, transferId, ciphertext} (no hint object)', async () => {
    const server = new FakeCourierServer(NETWORK);
    const provider = makeProvider(server, async () => {});

    const handle = await provider.deposit({
      recipientChainPubkey: RECIPIENT_PUB,
      senderChainPubkey: SENDER_PUB,
      transferId: 'tx-1',
      tokenBlobHex: BLOB_HEX,
    });

    expect(server.calls.deposit).toHaveLength(1);
    const body = server.calls.deposit[0];
    expect(Object.keys(body).sort()).toEqual(['ciphertext', 'entryId', 'recipientPubkey', 'transferId']);
    expect(body.recipientPubkey).toBe(RECIPIENT_PUB);
    expect(body.transferId).toBe('tx-1');
    expect(body.entryId).toBe(courierEntryId(SENDER_PRIV, RECIPIENT_PUB, BLOB_HEX));
    expect(handle.entryId).toBe(body.entryId);
    // ciphertext is a single packed base64 string (NOT a {nonce,ct} object).
    expect(typeof body.ciphertext).toBe('string');
    expect((body as Record<string, unknown>).hint).toBeUndefined();
  });

  it('ciphertext is base64(nonce24‖ct) — first 24 bytes are the nonce, opens to the payload', async () => {
    const server = new FakeCourierServer(NETWORK);
    const provider = makeProvider(server, async () => {});

    await provider.deposit({
      recipientChainPubkey: RECIPIENT_PUB,
      senderChainPubkey: SENDER_PUB,
      transferId: 'tx-1',
      tokenBlobHex: BLOB_HEX,
      memo: 'hello',
    });

    const { ciphertext, entryId } = server.calls.deposit[0];
    const { nonce } = unpackCourier(ciphertext);
    expect(nonce).toHaveLength(24);

    const pt = openCourierEnvelope({
      network: NETWORK,
      recipientPriv: RECIPIENT_PRIV,
      senderPubkey: SENDER_PUB,
      recipientPubkey: RECIPIENT_PUB,
      entryId,
      ciphertext,
    });
    const decoded = JSON.parse(new TextDecoder().decode(pt));
    expect(decoded.type).toBe('V2_TRANSFER');
    expect(decoded.tokenBlob).toBe(BLOB_HEX);
    expect(decoded.memo).toBe('hello');
  });

  it('deposit is idempotent (same entryId -> single stored row)', async () => {
    const server = new FakeCourierServer(NETWORK);
    const provider = makeProvider(server, async () => {});
    const env = {
      recipientChainPubkey: RECIPIENT_PUB,
      senderChainPubkey: SENDER_PUB,
      transferId: 'tx-1',
      tokenBlobHex: BLOB_HEX,
    };
    await provider.deposit(env);
    await provider.deposit(env);
    expect(server.deliveryCount).toBe(1);
  });
});
