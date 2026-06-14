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

describe('courier deposit — journal-first ordering (courier-deposit-journal-ordering-vs-design)', () => {
  const env = {
    recipientChainPubkey: RECIPIENT_PUB,
    senderChainPubkey: SENDER_PUB,
    transferId: 'tx-1',
    tokenBlobHex: BLOB_HEX,
  };

  /** The provider's sent-pending journal key for the sender on this network. */
  const sentPendingKey = `courier_sent_pending:${NETWORK}:${SENDER_PUB}`;

  function providerWith(
    journal: CourierJournalStore,
    depositImpl: (req: { entryId: string }) => Promise<{ entryId: string; seq: number; sentSeq: number; status: 'unclaimed' }>,
  ): CourierDeliveryProvider {
    const p = new CourierDeliveryProvider({
      vaultUrl: 'https://vault.testnet.unicity.network',
      network: NETWORK,
      httpClientFactory: () => ({
        deposit: (req) => depositImpl(req),
        inbox: async () => ({ readPointer: 0, syncEpoch: 1, more: false, items: [] }),
        ackNonce: async () => ({ serverNonce: 'n' }),
        ack: async () => ({ result: 'failed' as const }),
        sent: async () => ({ more: false, items: [] }),
      }),
      journal,
      onV2Transfer: async () => {},
    });
    p.setIdentity(senderId);
    return p;
  }

  it('journals the sender-side pending tracking BEFORE the deposit POST (journal ≺ POST)', async () => {
    const journal = memJournal();
    // A crash simulated AT the POST: the journal entry must already exist, so the
    // delivery is tracked + reconcilable even though the POST never returned.
    let journalAtPostTime: string | null = null;
    const provider = providerWith(journal, async () => {
      journalAtPostTime = await journal.get(sentPendingKey); // snapshot at POST time
      throw new Error('network down at POST');
    });

    await expect(provider.deposit(env)).rejects.toThrow('network down at POST');

    // The pending tracking was journaled BEFORE the POST was attempted.
    expect(journalAtPostTime).not.toBeNull();
    const atPost = JSON.parse(journalAtPostTime!) as Record<string, { recipientPubkey: string; state: string }>;
    const entries = Object.values(atPost);
    expect(entries).toHaveLength(1);
    expect(entries[0].recipientPubkey).toBe(RECIPIENT_PUB);
    expect(entries[0].state).toBe('pending');
  });

  it('records the server sentSeq onto the journaled entry after a successful POST', async () => {
    const journal = memJournal();
    const provider = providerWith(journal, async (req) => ({
      entryId: req.entryId,
      seq: 1,
      sentSeq: 42,
      status: 'unclaimed' as const,
    }));

    const handle = await provider.deposit(env);
    expect(handle.sentSeq).toBe(42);

    const stored = JSON.parse((await journal.get(sentPendingKey))!) as Record<string, { sentSeq?: number }>;
    expect(Object.values(stored)[0].sentSeq).toBe(42);
  });

  it('a re-POST of an already-journaled deposit is harmless (server dedups on entryId)', async () => {
    // After a crash AFTER the POST, a reload re-deposits. The server dedups on
    // (recipientPubkey, entryId) so the row count stays 1 — idempotent.
    const server = new FakeCourierServer(NETWORK);
    const journal = memJournal();
    const p = new CourierDeliveryProvider({
      vaultUrl: 'https://vault.testnet.unicity.network',
      network: NETWORK,
      httpClientFactory: (ownerId) => server.clientFor(ownerId),
      journal,
      onV2Transfer: async () => {},
    });
    p.setIdentity(senderId);

    await p.deposit(env);
    await p.deposit(env); // re-POST after a simulated crash
    expect(server.deliveryCount).toBe(1);
    // A single journal entry survives the re-deposit (no duplicate tracking).
    const stored = JSON.parse((await journal.get(sentPendingKey))!) as Record<string, unknown>;
    expect(Object.keys(stored)).toHaveLength(1);
  });
});
