/**
 * Courier inbox/sent pagination + watermark persistence
 * (finding courier-readpointer-and-watermark-never-persisted).
 *
 * Before the fix the provider READ a since/watermark but NEVER wrote it back and
 * IGNORED the `more` flag, so:
 *  - `receive()` only processed the FIRST page and always re-queried `since=0` —
 *    a delivery on page 2 was a LOST TRANSFER (never received/acked).
 *  - `pollSent()` likewise dropped page-2 confirmations and re-polled from 0.
 *
 * This suite drives MORE than one page (pageLimit:2) and asserts:
 *  - every inbox entry across ALL pages is received (page-2 delivery is NOT lost);
 *  - a SECOND `receive()` resumes from the persisted read pointer (not `since=0`);
 *  - `pollSent()` confirms a page-2 delivery and persists the sent watermark so the
 *    next poll resumes past the already-delivered prefix.
 */

import { describe, it, expect } from 'vitest';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '../../../core/crypto';
import { encodeTokenBlob } from '../../../token-engine/token-blob';
import { CourierDeliveryProvider } from '../../../transport/courier/CourierDeliveryProvider';
import { FakeCourierServer } from '../../helpers/fake-courier-server';
import type { FullIdentity } from '../../../types';
import type { V2TransferPayload } from '../../../types/v2-transfer';
import type {
  CourierDeliveryConfig,
  CourierJournalStore,
  V2TransferSink,
} from '../../../transport/courier/CourierDeliveryProvider';

const NETWORK = 'testnet2';
const SENDER_PRIV = '55'.repeat(32);
const RECIPIENT_PRIV = '66'.repeat(32);
const SENDER_PUB = bytesToHex(secp256k1.getPublicKey(hexToBytes(SENDER_PRIV), true));
const RECIPIENT_PUB = bytesToHex(secp256k1.getPublicKey(hexToBytes(RECIPIENT_PRIV), true));

const sender: FullIdentity = { chainPubkey: SENDER_PUB, l1Address: 'alpha1s', privateKey: SENDER_PRIV };
const recipient: FullIdentity = { chainPubkey: RECIPIENT_PUB, l1Address: 'alpha1r', privateKey: RECIPIENT_PRIV };
const noopSink: V2TransferSink = async (_p: V2TransferPayload, _s: string) => {};

/** A distinct token blob per index so each deposit is a distinct entryId + tokenId. */
function blobFor(i: number): string {
  const tokenId = i.toString(16).padStart(64, '0');
  const token = new Uint8Array(16).map((_, j) => (i * 13 + j) & 0xff);
  return bytesToHex(encodeTokenBlob({ v: 1, network: 0, tokenId, token }));
}

function memJournal(): CourierJournalStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, get: async (k) => map.get(k) ?? null, set: async (k, v) => void map.set(k, v) };
}

function makeProvider(
  id: FullIdentity,
  server: FakeCourierServer,
  journal: CourierJournalStore,
  overrides: Partial<CourierDeliveryConfig> = {},
): CourierDeliveryProvider {
  const p = new CourierDeliveryProvider({
    vaultUrl: 'https://vault.testnet.unicity.network',
    network: NETWORK,
    httpClientFactory: (ownerId) => server.clientFor(ownerId),
    journal,
    onV2Transfer: noopSink,
    ...overrides,
  });
  p.setIdentity(id);
  return p;
}

/** Deposit `count` distinct envelopes from the sender to the recipient. */
async function depositMany(server: FakeCourierServer, count: number): Promise<void> {
  const sp = makeProvider(sender, server, memJournal());
  for (let i = 1; i <= count; i++) {
    await sp.deposit({
      recipientChainPubkey: RECIPIENT_PUB,
      senderChainPubkey: SENDER_PUB,
      transferId: `tx-${i}`,
      tokenBlobHex: blobFor(i),
    });
  }
}

describe('courier inbox pagination + read-pointer persistence', () => {
  it('receive() pulls ALL entries across pages (a page-2 delivery is NOT lost)', async () => {
    const server = new FakeCourierServer({ network: NETWORK, pageLimit: 2 });
    await depositMany(server, 5); // 5 entries / pageLimit 2 → 3 pages

    const received: string[] = [];
    const sink: V2TransferSink = async (p) => void received.push(p.tokenBlob);
    const rp = makeProvider(recipient, server, memJournal(), { onV2Transfer: sink });
    await rp.receive();

    // All 5 envelopes (including those on pages 2 and 3) were opened + handled.
    expect(received).toHaveLength(5);
    const expected = [1, 2, 3, 4, 5].map(blobFor).sort();
    expect([...received].sort()).toEqual(expected);
  });

  it('a SECOND receive() resumes from the persisted read pointer, not since=0', async () => {
    const server = new FakeCourierServer({ network: NETWORK, pageLimit: 2 });
    await depositMany(server, 5);

    const journal = memJournal();
    const rp = makeProvider(recipient, server, journal, { onV2Transfer: noopSink });
    await rp.receive();

    // The persisted read pointer advanced to the highest processed seq (5).
    const ptr = journal.map.get(`courier_read_pointer:${NETWORK}:${RECIPIENT_PUB}`);
    expect(ptr).toBe('5');

    // A second receive() must NOT re-query from 0 — it resumes from the watermark.
    server.calls.inbox.length = 0;
    await rp.receive();
    expect(server.calls.inbox[0]).toBe(5);
    // No re-query from 0 at all on the second pass.
    expect(server.calls.inbox).not.toContain(0);
  });
});

describe('courier /sent pagination + watermark persistence', () => {
  it('pollSent confirms a page-2 delivery and persists the sent watermark', async () => {
    const server = new FakeCourierServer({ network: NETWORK, pageLimit: 2 });
    const delivered: string[] = [];
    const journal = memJournal();
    const sp = makeProvider(sender, server, journal, { onDelivered: async (id) => void delivered.push(id) });

    const handles: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const h = await sp.deposit({
        recipientChainPubkey: RECIPIENT_PUB,
        senderChainPubkey: SENDER_PUB,
        transferId: `tx-${i}`,
        tokenBlobHex: blobFor(i),
      });
      handles.push(h.entryId);
    }

    // The recipient claims EVERY entry (across all inbox pages) for real.
    const rp = makeProvider(recipient, server, memJournal());
    await rp.receive();

    await sp.pollSent();

    // Every deposited entry — including those whose /sent row is on page 2/3 — is
    // confirmed delivered (the page-2 confirmation is NOT dropped).
    expect([...delivered].sort()).toEqual([...handles].sort());
    // The sent watermark advanced to the highest contiguously-delivered sentSeq (5).
    expect(journal.map.get(`courier_sent_watermark:${NETWORK}:${SENDER_PUB}`)).toBe('5');

    // A subsequent poll resumes past the delivered prefix, not from 0.
    server.calls.sent.length = 0;
    await sp.pollSent();
    expect(server.calls.sent[0]).toBe(5);
    expect(server.calls.sent).not.toContain(0);
  });

  it('the sent watermark does NOT advance past a still-pending entry', async () => {
    const server = new FakeCourierServer({ network: NETWORK, pageLimit: 2 });
    const journal = memJournal();
    const sp = makeProvider(sender, server, journal);

    for (let i = 1; i <= 3; i++) {
      await sp.deposit({
        recipientChainPubkey: RECIPIENT_PUB,
        senderChainPubkey: SENDER_PUB,
        transferId: `tx-${i}`,
        tokenBlobHex: blobFor(i),
      });
    }
    // Nobody claims anything → no entry is delivered.
    await sp.pollSent();

    // The watermark must stay at 0: advancing past unconfirmed entries would drop
    // their future delivery confirmation (a lost transfer).
    expect(journal.map.get(`courier_sent_watermark:${NETWORK}:${SENDER_PUB}`) ?? '0').toBe('0');
  });
});
