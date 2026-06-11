/**
 * WalletApiMailboxProvider against the S7 delivery contract suite, on the
 * in-process fake backend (sdk-changes S3/S7; ARCHITECTURE §6/§16).
 *
 * Runs the shared suite TWICE — once per composition-time custody mode — plus
 * provider-specific pins the generic suite cannot assume:
 * - the strict seen-set test against a HOSTILE backend (an entry replayed as
 *   `pending` after resolution — the client guard, not the server, rejects);
 * - the asymmetric claim upgrade visible at the provider level;
 * - S6 memo encryption: ciphertext on the wire, decryptable by the owner.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { FakeWalletApi } from '../support/fake-wallet-api';
import { MemoryKeyValueStore, makeTestToken, testIdentity } from '../support/wallet-api-test-helpers';
import { WalletApiClient } from '../../wallet-api';
import { WalletApiMailboxProvider } from '../../impl/shared/wallet-api';
import type { DeliveryCustody, IncomingDelivery } from '../../transport/delivery-provider';
import { FIELD_ENVELOPE_PREFIX } from '../../core/field-encryption';
import {
  describeDeliveryProviderContract,
  type DeliveryProviderContractContext,
} from './delivery-provider.contract';

const SENDER = testIdentity(1);
const RECIPIENT = testIdentity(2);

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

interface Harness extends DeliveryProviderContractContext {
  fake: FakeWalletApi;
  recipientProvider: WalletApiMailboxProvider;
  recipientClient: WalletApiClient;
}

async function makeHarness(custody: DeliveryCustody): Promise<Harness> {
  const fake = new FakeWalletApi();
  const baseUrl = await fake.start();

  const senderClient = new WalletApiClient({
    baseUrl,
    network: fake.network,
    deviceId: 'sender-dev',
    storage: new MemoryKeyValueStore(),
  });
  const sender = new WalletApiMailboxProvider({
    client: senderClient,
    custody: 'external',
    stateStore: new MemoryKeyValueStore(),
  });
  sender.setIdentity(SENDER);

  const recipientClient = new WalletApiClient({
    baseUrl,
    network: fake.network,
    deviceId: 'recipient-dev',
    storage: new MemoryKeyValueStore(),
  });
  const recipientState = new MemoryKeyValueStore();
  const makeRecipient = (): WalletApiMailboxProvider => {
    const provider = new WalletApiMailboxProvider({
      client: recipientClient,
      custody,
      stateStore: recipientState, // SAME persistent state across restarts
    });
    provider.setIdentity(RECIPIENT);
    return provider;
  };
  const recipientProvider = makeRecipient();

  return {
    fake,
    sender,
    recipient: recipientProvider,
    recipientProvider,
    recipientClient,
    recipientPubkey: RECIPIENT.chainPubkey,
    makeBlob() {
      const t = makeTestToken();
      return { bytes: t.bytes, tokenId: t.tokenId, stateHash: hex(sha256(t.blob.token)) };
    },
    async recipientInventoryHas(tokenId: string): Promise<boolean> {
      return fake.getRow(RECIPIENT.chainPubkey, tokenId)?.status === 'active';
    },
    async restartRecipient() {
      return makeRecipient();
    },
    async cleanup() {
      await fake.stop();
    },
  };
}

describeDeliveryProviderContract("WalletApiMailboxProvider (custody: 'inventory')", () =>
  makeHarness('inventory')
);
describeDeliveryProviderContract("WalletApiMailboxProvider (custody: 'external')", () =>
  makeHarness('external')
);

// =============================================================================
// Provider-specific pins (beyond the generic suite)
// =============================================================================

async function drain(
  provider: WalletApiMailboxProvider,
  sinceCursor?: string
): Promise<IncomingDelivery[]> {
  const out: IncomingDelivery[] = [];
  for await (const d of provider.incoming(sinceCursor)) out.push(d);
  return out;
}

describe('WalletApiMailboxProvider — provider-specific semantics', () => {
  let h: Harness;

  afterEach(async () => {
    await h.cleanup?.();
  });

  describe("custody 'external' (delivery-only)", () => {
    beforeEach(async () => {
      h = await makeHarness('external');
    });

    it('the seen-set (not server status) rejects a HOSTILE replay of a resolved entry', async () => {
      const blob = h.makeBlob();
      const { deliveryId } = await h.sender.deliver(h.recipientPubkey, blob.bytes, { transferId: 'tf-h1' });
      await drain(h.recipientProvider);
      await h.recipientProvider.ack(deliveryId, 'claimed');

      // A restored/buggy/malicious backend replays the entry as pending —
      // the recipient never trusts the backend (ARCHITECTURE §8.2).
      h.fake.tamperMailboxEntryToPending(h.recipientPubkey, deliveryId);

      const replayed = await drain(h.recipientProvider, '0');
      expect(replayed.find((d) => d.deliveryId === deliveryId)).toBeUndefined();
    });

    it('claims record intoInventory:false server-side (the §6 delivery-only disposition)', async () => {
      const blob = h.makeBlob();
      const { deliveryId } = await h.sender.deliver(h.recipientPubkey, blob.bytes, { transferId: 'tf-h2' });
      await drain(h.recipientProvider);
      await h.recipientProvider.ack(deliveryId, 'claimed');

      expect(h.fake.getMailboxEntry(h.recipientPubkey, deliveryId)).toMatchObject({
        status: 'claimed',
        intoInventory: false,
      });
    });

    it('the §6 asymmetric upgrade: a later inventory-custody ack performs the missing insert', async () => {
      const blob = h.makeBlob();
      const { deliveryId } = await h.sender.deliver(h.recipientPubkey, blob.bytes, { transferId: 'tf-h2b' });
      await drain(h.recipientProvider);
      await h.recipientProvider.ack(deliveryId, 'claimed'); // intoInventory:false
      expect(await h.recipientInventoryHas(blob.tokenId)).toBe(false);

      // The owner switches to wallet-api custody: an 'inventory' provider
      // re-acks the already-claimed entry — the §6 false→true upgrade inserts
      // the row (idempotent); the reverse direction never removes rows.
      const upgraded = new WalletApiMailboxProvider({
        client: h.recipientClient,
        custody: 'inventory',
        stateStore: new MemoryKeyValueStore(),
      });
      upgraded.setIdentity(RECIPIENT);
      await upgraded.ack(deliveryId, 'claimed');

      expect(await h.recipientInventoryHas(blob.tokenId)).toBe(true);
      expect(h.fake.getMailboxEntry(h.recipientPubkey, deliveryId)).toMatchObject({
        status: 'claimed',
        intoInventory: true,
      });
    });
  });

  describe("custody 'inventory' (full handoff)", () => {
    beforeEach(async () => {
      h = await makeHarness('inventory');
    });

    it('a claim performs the §6 ownership handoff: the SENDER’s active row flips to an evidenced tombstone', async () => {
      // Seed the sender-side inventory row at the source state (the row the
      // handoff must flip — notify fires at deposit, so the recipient may
      // claim before the sender applies).
      const blob = h.makeBlob();
      h.fake.seedInventory(SENDER.chainPubkey, [
        { tokenId: blob.tokenId, assets: [{ coinId: 'c0'.repeat(32), amount: 1000n }] },
      ]);

      const { deliveryId } = await h.sender.deliver(h.recipientPubkey, blob.bytes, { transferId: 'tf-h3' });
      await drain(h.recipientProvider);
      await h.recipientProvider.ack(deliveryId, 'claimed');

      expect(h.fake.getRow(SENDER.chainPubkey, blob.tokenId)).toMatchObject({
        status: 'removed',
        removal: 'evidenced',
      });
      expect(h.fake.getRow(RECIPIENT.chainPubkey, blob.tokenId)).toMatchObject({ status: 'active' });
    });

    it('S6: a memo travels as an enc1 envelope (never plaintext); a foreign wallet surfaces it as absent', async () => {
      const blob = h.makeBlob();
      const { deliveryId } = await h.sender.deliver(h.recipientPubkey, blob.bytes, {
        transferId: 'tf-h4',
        memo: 'coffee money',
      });

      // The wire/stored form is the S6 envelope — the operator never sees
      // plaintext (ARCHITECTURE §8.3).
      const stored = h.fake.getMailboxEntry(h.recipientPubkey, deliveryId);
      expect(stored?.memo?.startsWith(FIELD_ENVELOPE_PREFIX)).toBe(true);
      expect(stored?.memo).not.toContain('coffee');

      // The S6 key is WALLET-scoped (HKDF from the wallet key): only the
      // writing wallet's devices can decrypt. The recipient is a DIFFERENT
      // wallet, so its provider surfaces the memo as absent — never as raw
      // ciphertext.
      const incoming = await drain(h.recipientProvider);
      const delivery = incoming.find((d) => d.deliveryId === deliveryId);
      expect(delivery).toBeDefined();
      expect(delivery!.memo).toBeUndefined();
    });

    it('S6: a SELF-send memo round-trips (the wallet-scoped key decrypts its own envelope)', async () => {
      // Sender deposits to their own mailbox (multi-device / self-transfer).
      const selfProvider = h.sender; // bound to SENDER's identity
      const t = makeTestToken();
      const { deliveryId } = await selfProvider.deliver(SENDER.chainPubkey, t.bytes, {
        transferId: 'tf-h4b',
        memo: 'note to self',
      });
      const incoming = await drain(selfProvider as WalletApiMailboxProvider);
      const delivery = incoming.find((d) => d.deliveryId === deliveryId);
      expect(delivery).toBeDefined();
      expect(delivery!.memo).toBe('note to self');
    });

    it('blobCollected: an entry without a fetchable blob throws a typed error from fetchBlob', async () => {
      const blob = h.makeBlob();
      const { deliveryId } = await h.sender.deliver(h.recipientPubkey, blob.bytes, { transferId: 'tf-h5' });
      // Simulate the entry surfacing without a retained blob (§6: only
      // resolved entries lose blobs after retention — surfacing a pending one
      // this way is a server contract violation the client must surface, not
      // silently skip).
      h.fake.collectMailboxBlob(h.recipientPubkey, deliveryId);

      const incoming = await drain(h.recipientProvider);
      const delivery = incoming.find((d) => d.deliveryId === deliveryId);
      expect(delivery).toBeDefined();
      await expect(delivery!.fetchBlob()).rejects.toThrow(/blobCollected|no fetchable blob/);
    });
  });
});
