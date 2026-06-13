/**
 * confirmReceipt pagination (finding confirmReceipt-non-paginated-sent(0)).
 *
 * Before the fix `confirmReceipt(handle)` did `client.sent(0)` + `.find()` — a
 * SINGLE, non-paginated page. So a handle whose `/sent` row is on page 2+ (its
 * `sentSeq` past the first page) returned a false `null`: the delivery looked
 * unconfirmed even though the recipient had validly claimed it.
 *
 * The fix anchors the query on the handle's OWN `sentSeq` (`since = sentSeq - 1`),
 * so the target row is the FIRST row of the response regardless of how many other
 * deliveries precede it — cheaper than looping every `/sent` page.
 *
 * This suite forces a small page size (pageLimit:1) and deposits SEVERAL entries so
 * the entry under test lands beyond page 1, then asserts `confirmReceipt` still
 * finds its valid ack. The single-page happy path is kept green by the existing
 * `courier.sent.test.ts`.
 */

import { describe, it, expect } from 'vitest';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '../../../core/crypto';
import { encodeTokenBlob } from '../../../token-engine/token-blob';
import { CourierDeliveryProvider } from '../../../transport/courier/CourierDeliveryProvider';
import { FakeCourierServer } from '../../helpers/fake-courier-server';
import type { FullIdentity } from '../../../types';
import type {
  CourierJournalStore,
  V2TransferSink,
} from '../../../transport/courier/CourierDeliveryProvider';
import type { DeliveryHandle } from '../../../transport/courier/types';
import type { V2TransferPayload } from '../../../types/v2-transfer';

const NETWORK = 'testnet2';
const SENDER_PRIV = '55'.repeat(32);
const RECIPIENT_PRIV = '66'.repeat(32);
const SENDER_PUB = bytesToHex(secp256k1.getPublicKey(hexToBytes(SENDER_PRIV), true));
const RECIPIENT_PUB = bytesToHex(secp256k1.getPublicKey(hexToBytes(RECIPIENT_PRIV), true));

/** A one-row /sent + /inbox page, so any entry past the first lands on page 2+. */
const PAGE_LIMIT = 1;
/** Deposit this many entries; the LAST one's /sent row is on page N (well past 1). */
const ENTRY_COUNT = 4;

const sender: FullIdentity = { chainPubkey: SENDER_PUB, l1Address: 'alpha1s', privateKey: SENDER_PRIV };
const recipient: FullIdentity = { chainPubkey: RECIPIENT_PUB, l1Address: 'alpha1r', privateKey: RECIPIENT_PRIV };
const noopSink: V2TransferSink = async (_p: V2TransferPayload, _s: string) => {};

/** A distinct token blob per index so each deposit is a distinct entryId + tokenId. */
function blobFor(i: number): string {
  const tokenId = i.toString(16).padStart(64, '0');
  const token = new Uint8Array(16).map((_, j) => (i * 13 + j) & 0xff);
  return bytesToHex(encodeTokenBlob({ v: 1, network: 0, tokenId, token }));
}

function memJournal(): CourierJournalStore {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}

function makeProvider(id: FullIdentity, server: FakeCourierServer): CourierDeliveryProvider {
  const p = new CourierDeliveryProvider({
    vaultUrl: 'https://vault.testnet.unicity.network',
    network: NETWORK,
    httpClientFactory: (ownerId) => server.clientFor(ownerId),
    journal: memJournal(),
    onV2Transfer: noopSink,
  });
  p.setIdentity(id);
  return p;
}

describe('courier confirmReceipt pagination', () => {
  it('finds a VALID ack whose /sent row is BEYOND page 1', async () => {
    const server = new FakeCourierServer({ network: NETWORK, pageLimit: PAGE_LIMIT });
    const sp = makeProvider(sender, server);

    // Deposit several entries; the last one's /sent row (sentSeq=ENTRY_COUNT) sits
    // on page ENTRY_COUNT — never page 1 with a one-row page size.
    const handles: DeliveryHandle[] = [];
    for (let i = 1; i <= ENTRY_COUNT; i++) {
      handles.push(
        await sp.deposit({
          recipientChainPubkey: RECIPIENT_PUB,
          senderChainPubkey: SENDER_PUB,
          transferId: `tx-${i}`,
          tokenBlobHex: blobFor(i),
        }),
      );
    }
    const last = handles[ENTRY_COUNT - 1];
    expect(last.sentSeq).toBe(ENTRY_COUNT); // sanity: this row is well past page 1

    // The recipient validly claims EVERY entry (across all inbox pages).
    await makeProvider(recipient, server).receive();

    // The bug: sent(0) returns only page 1 (sentSeq 1), so the last handle's ack is
    // never seen → false null. The fix anchors on the handle's own sentSeq.
    const receipt = await sp.confirmReceipt(last);
    expect(receipt).not.toBeNull();
    expect(receipt?.entryId).toBe(last.entryId);
    expect(receipt?.recipientChainPubkey).toBe(RECIPIENT_PUB);
    expect(receipt?.ackSig).toBeTruthy();
  });

  it('still returns null for an unclaimed handle on page 2+', async () => {
    const server = new FakeCourierServer({ network: NETWORK, pageLimit: PAGE_LIMIT });
    const sp = makeProvider(sender, server);

    const handles: DeliveryHandle[] = [];
    for (let i = 1; i <= ENTRY_COUNT; i++) {
      handles.push(
        await sp.deposit({
          recipientChainPubkey: RECIPIENT_PUB,
          senderChainPubkey: SENDER_PUB,
          transferId: `tx-${i}`,
          tokenBlobHex: blobFor(i),
        }),
      );
    }
    // Nobody claims anything — the page-2 handle is genuinely unconfirmed.
    expect(await sp.confirmReceipt(handles[ENTRY_COUNT - 1])).toBeNull();
  });
});
