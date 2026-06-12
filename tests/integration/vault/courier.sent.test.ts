/**
 * Sender-gated delivery confirmation (Task 5.4, §6.5).
 *
 *  - `GET /v1/courier/sent?since=` rows carry `ackSig`.
 *  - The SENDER — not the server — gates "delivered" + GC: ONLY a valid
 *    `verifySignedMessage(ackSig, recipientChainPubkey)` over the bound template
 *    licenses `onDelivered` (which removes PENDING_V2_DELIVERIES). A FORGED flag
 *    without a valid sig is rejected → the entry keeps redelivering and, past the
 *    attempt cap, surfaces `delivery_unconfirmed`. Backoff bound asserted.
 */

import { describe, it, expect } from 'vitest';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes, signMessage } from '../../../core/crypto';
import { encodeTokenBlob } from '../../../token-engine/token-blob';
import { CourierDeliveryProvider } from '../../../transport/courier/CourierDeliveryProvider';
import { FakeCourierServer } from '../../helpers/fake-courier-server';
import type { FullIdentity } from '../../../types';
import type {
  CourierDeliveryConfig,
  CourierJournalStore,
  V2TransferSink,
} from '../../../transport/courier/CourierDeliveryProvider';
import type { V2TransferPayload } from '../../../types/v2-transfer';

const NETWORK = 'testnet2';
const SENDER_PRIV = '55'.repeat(32);
const RECIPIENT_PRIV = '66'.repeat(32);
const ATTACKER_PRIV = '99'.repeat(32);
const SENDER_PUB = bytesToHex(secp256k1.getPublicKey(hexToBytes(SENDER_PRIV), true));
const RECIPIENT_PUB = bytesToHex(secp256k1.getPublicKey(hexToBytes(RECIPIENT_PRIV), true));

const TOKEN_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const TOKEN_BYTES = new Uint8Array(40).map((_, i) => (i * 7 + 3) & 0xff);
const BLOB_HEX = bytesToHex(encodeTokenBlob({ v: 1, network: 0, tokenId: TOKEN_ID, token: TOKEN_BYTES }));

const sender: FullIdentity = { chainPubkey: SENDER_PUB, l1Address: 'alpha1s', privateKey: SENDER_PRIV };
const recipient: FullIdentity = { chainPubkey: RECIPIENT_PUB, l1Address: 'alpha1r', privateKey: RECIPIENT_PRIV };
const noopSink: V2TransferSink = async (_p: V2TransferPayload, _s: string) => {};

function memJournal(): CourierJournalStore {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}

function makeSender(server: FakeCourierServer, overrides: Partial<CourierDeliveryConfig> = {}, journal = memJournal()) {
  const p = new CourierDeliveryProvider({
    vaultUrl: 'https://vault.testnet.unicity.network',
    network: NETWORK,
    httpClientFactory: (ownerId) => server.clientFor(ownerId),
    journal,
    onV2Transfer: noopSink,
    ...overrides,
  });
  p.setIdentity(sender);
  return p;
}

function makeRecipient(server: FakeCourierServer, sink: V2TransferSink = noopSink) {
  const p = new CourierDeliveryProvider({
    vaultUrl: 'https://vault.testnet.unicity.network',
    network: NETWORK,
    httpClientFactory: (ownerId) => server.clientFor(ownerId),
    journal: memJournal(),
    onV2Transfer: sink,
  });
  p.setIdentity(recipient);
  return p;
}

const env = {
  recipientChainPubkey: RECIPIENT_PUB,
  senderChainPubkey: SENDER_PUB,
  transferId: 'tx-1',
  tokenBlobHex: BLOB_HEX,
};

describe('courier sender-gated delivery confirmation', () => {
  it('a VALID recipient ackSig licenses onDelivered (removes PENDING_V2_DELIVERIES)', async () => {
    const server = new FakeCourierServer(NETWORK);
    const delivered: string[] = [];
    const sp = makeSender(server, { onDelivered: async (id) => void delivered.push(id) });
    const handle = await sp.deposit(env);

    // Recipient claims it for real (valid signed ack).
    await makeRecipient(server).receive();

    // /sent row carries the ackSig.
    const sent = await server.clientFor(SENDER_PUB).sent(0);
    expect(sent.items[0].ackSig).toBeTruthy();

    await sp.pollSent();
    expect(delivered).toEqual([handle.entryId]);
    expect(await sp.sentState(handle.entryId)).toBe('delivered');
  });

  it('a FORGED ackSig (no valid recipient sig) does NOT license delivery — keeps redelivering', async () => {
    const server = new FakeCourierServer(NETWORK);
    const delivered: string[] = [];
    const sp = makeSender(server, { onDelivered: async (id) => void delivered.push(id) });
    const handle = await sp.deposit(env);

    // The server forges a `claimed` flag with an ackSig NOT signed by the recipient
    // (signed by an attacker key over a bogus nonce) — a hostile/broken operator.
    const forged = signMessage(ATTACKER_PRIV, 'unicity:courier:ack:v1\n' + NETWORK + '\nx\n' + handle.entryId + '\nz');
    server.forgeSentAckSig(handle.entryId, forged);

    await sp.pollSent();
    // Not delivered: the forged sig fails verifySignedMessage against the recipient pubkey.
    expect(delivered).toEqual([]);
    expect(await sp.sentState(handle.entryId)).toBe('pending');
  });

  it('past the attempt cap a still-unconfirmed entry surfaces delivery_unconfirmed', async () => {
    const server = new FakeCourierServer(NETWORK);
    const sp = makeSender(server, { maxRedeliveryAttempts: 3 });
    const handle = await sp.deposit(env);
    // Recipient never claims; each pollSent finds it unclaimed -> bumps attempts.
    await sp.pollSent();
    await sp.pollSent();
    expect(await sp.sentState(handle.entryId)).toBe('pending');
    await sp.pollSent(); // attempts hits 3 == cap
    expect(await sp.sentState(handle.entryId)).toBe('delivery_unconfirmed');
  });

  it('backoff is exponential and capped', async () => {
    const server = new FakeCourierServer(NETWORK);
    const sp = makeSender(server, { backoffBaseMs: 1000, backoffMaxMs: 8000 });
    expect(sp.backoffMs(0)).toBe(1000);
    expect(sp.backoffMs(1)).toBe(2000);
    expect(sp.backoffMs(2)).toBe(4000);
    expect(sp.backoffMs(3)).toBe(8000);
    expect(sp.backoffMs(10)).toBe(8000); // capped
  });

  it('confirmReceipt returns the signed receipt only for a validly-claimed handle', async () => {
    const server = new FakeCourierServer(NETWORK);
    const sp = makeSender(server);
    const handle = await sp.deposit(env);

    expect(await sp.confirmReceipt(handle)).toBeNull(); // not yet claimed
    await makeRecipient(server).receive();
    const receipt = await sp.confirmReceipt(handle);
    expect(receipt?.entryId).toBe(handle.entryId);
    expect(receipt?.recipientChainPubkey).toBe(RECIPIENT_PUB);
    expect(receipt?.ackSig).toBeTruthy();
  });
});
