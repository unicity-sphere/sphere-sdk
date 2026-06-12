/**
 * Courier ack — signed durable-copy claim (Task 5.3, §6.4/§8.2).
 *
 *  - ackSig = signMessage(recipientPriv, ackTemplate(network, sender, entryId, serverNonce));
 *    the fake server verifies it via verifySignedMessage and flips to `claimed`.
 *  - ORDERING: `courier_ack_pending[entryId]` is journaled AFTER the custody
 *    commit and BEFORE the ack POST (custody-commit ≺ ack-journal ≺ ack-POST). A
 *    simulated crash between the journal and the POST re-fires on the next load.
 *  - WIRE: `POST /v1/courier/ack` body is EXACTLY `{entryId, ackSig}` — never the
 *    retired batch `{claimed[]}` shape. `serverNonce` is fetched via GET ack-nonce.
 */

import { describe, it, expect, vi } from 'vitest';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '../../../core/crypto';
import { encodeTokenBlob } from '../../../token-engine/token-blob';
import { CourierDeliveryProvider } from '../../../transport/courier/CourierDeliveryProvider';
import { FakeCourierServer } from '../../helpers/fake-courier-server';
import type { FullIdentity } from '../../../types';
import type {
  CourierHttpClient,
  CourierJournalStore,
  V2TransferSink,
} from '../../../transport/courier/CourierDeliveryProvider';
import type { V2TransferPayload } from '../../../types/v2-transfer';

const NETWORK = 'testnet2';
const SENDER_PRIV = '55'.repeat(32);
const RECIPIENT_PRIV = '66'.repeat(32);
const SENDER_PUB = bytesToHex(secp256k1.getPublicKey(hexToBytes(SENDER_PRIV), true));
const RECIPIENT_PUB = bytesToHex(secp256k1.getPublicKey(hexToBytes(RECIPIENT_PRIV), true));

const TOKEN_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const TOKEN_BYTES = new Uint8Array(40).map((_, i) => (i * 7 + 3) & 0xff);
const BLOB_HEX = bytesToHex(encodeTokenBlob({ v: 1, network: 0, tokenId: TOKEN_ID, token: TOKEN_BYTES }));

const sender: FullIdentity = { chainPubkey: SENDER_PUB, l1Address: 'alpha1s', privateKey: SENDER_PRIV };
const recipient: FullIdentity = { chainPubkey: RECIPIENT_PUB, l1Address: 'alpha1r', privateKey: RECIPIENT_PRIV };

const noopSink: V2TransferSink = async (_p: V2TransferPayload, _s: string) => {};

function memJournal(): CourierJournalStore & { events: string[]; map: Map<string, string> } {
  const map = new Map<string, string>();
  const events: string[] = [];
  return {
    map,
    events,
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => {
      events.push(`set:${k.split(':')[0]}`);
      map.set(k, v);
    },
  };
}

function provider(
  id: FullIdentity,
  client: CourierHttpClient,
  journal: CourierJournalStore,
  sink: V2TransferSink = noopSink,
): CourierDeliveryProvider {
  const p = new CourierDeliveryProvider({
    vaultUrl: 'https://vault.testnet.unicity.network',
    network: NETWORK,
    httpClientFactory: () => client,
    journal,
    onV2Transfer: sink,
  });
  p.setIdentity(id);
  return p;
}

async function deposit(server: FakeCourierServer): Promise<void> {
  const sp = provider(sender, server.clientFor(SENDER_PUB), memJournal());
  await sp.deposit({
    recipientChainPubkey: RECIPIENT_PUB,
    senderChainPubkey: SENDER_PUB,
    transferId: 'tx-1',
    tokenBlobHex: BLOB_HEX,
  });
}

describe('courier ack', () => {
  it('ack body is EXACTLY {entryId, ackSig} and flips the entry to claimed', async () => {
    const server = new FakeCourierServer(NETWORK);
    await deposit(server);

    const rp = provider(recipient, server.clientFor(RECIPIENT_PUB), memJournal());
    await rp.receive();

    expect(server.calls.ackNonce).toHaveLength(1);
    expect(server.calls.ack).toHaveLength(1);
    expect(Object.keys(server.calls.ack[0]).sort()).toEqual(['ackSig', 'entryId']);
    // claimed: the sender's /sent now carries the ackSig.
    const sent = await server.clientFor(SENDER_PUB).sent(0);
    expect(sent.items[0].status).toBe('claimed');
    expect(sent.items[0].ackSig).toBe(server.calls.ack[0].ackSig);
  });

  it('journals ACK-PENDING AFTER custody commit and BEFORE the ack POST', async () => {
    const server = new FakeCourierServer(NETWORK);
    await deposit(server);

    const order: string[] = [];
    const realClient = server.clientFor(RECIPIENT_PUB);
    const client: CourierHttpClient = {
      ...realClient,
      ack: vi.fn(async (req) => {
        order.push('ack-post');
        return realClient.ack(req);
      }),
    };
    const journal = memJournal();
    const sink: V2TransferSink = async () => void order.push('custody-commit');
    // Record the ack-pending journal write.
    const origSet = journal.set;
    journal.set = async (k, v) => {
      if (k.startsWith('courier_ack_pending')) order.push('ack-journal');
      return origSet(k, v);
    };

    const rp = provider(recipient, client, journal, sink);
    await rp.receive();

    // The invariant is the PREFIX ordering custody-commit ≺ ack-journal ≺ ack-POST.
    // (A trailing ack-journal write is the post-claim journal cleanup — irrelevant.)
    expect(order.slice(0, 3)).toEqual(['custody-commit', 'ack-journal', 'ack-post']);
    expect(order.indexOf('ack-journal')).toBeLessThan(order.indexOf('ack-post'));
  });

  it('crash between journal and POST -> re-fired on next load (replayAckPending)', async () => {
    const server = new FakeCourierServer(NETWORK);
    await deposit(server);

    // First client: the ack POST throws (crash after the journal write).
    const realClient = server.clientFor(RECIPIENT_PUB);
    let crash = true;
    const client: CourierHttpClient = {
      ...realClient,
      ack: async (req) => {
        if (crash) throw new Error('network down after journal write');
        return realClient.ack(req);
      },
    };
    const journal = memJournal();
    const rp = provider(recipient, client, journal);

    // receive() journals ACK-PENDING, then the ack POST crashes.
    await expect(rp.receive()).rejects.toThrow();
    expect(journal.map.has(`courier_ack_pending:${NETWORK}:${RECIPIENT_PUB}`)).toBe(true);
    // The server still shows the entry unclaimed.
    let sent = await server.clientFor(SENDER_PUB).sent(0);
    expect(sent.items[0].status).toBe('unclaimed');

    // Recover: a fresh load re-fires the journaled ack, now the POST succeeds.
    crash = false;
    await rp.replayAckPending();
    sent = await server.clientFor(SENDER_PUB).sent(0);
    expect(sent.items[0].status).toBe('claimed');
    // The journal row is cleared after a successful claim.
    const pending = JSON.parse(journal.map.get(`courier_ack_pending:${NETWORK}:${RECIPIENT_PUB}`)!);
    expect(Object.keys(pending)).toHaveLength(0);
  });
});
