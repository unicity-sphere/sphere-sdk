/**
 * tests/contract/delivery-provider.contract.ts — the shared delivery-provider
 * contract suite (sdk-changes S7).
 *
 * One suite that every `DeliveryProvider` implementation must pass — what
 * makes the delivery rail "swappable" (covenant §3.1-6) enforceable rather
 * than aspirational. It pins the NORMATIVE S7 semantics:
 *
 * - `deliver` is idempotent per (token, state) — including after the
 *   recipient claimed (ARCHITECTURE §6 deposit idempotency);
 * - `deliveryId` is CONTENT-DERIVED — `hex(SHA-256(tokenId bytes ‖ stateHash
 *   bytes))`, the backend's entry_id formula, re-implemented INSIDE this
 *   suite so an implementation echoing server row ids cannot pass
 *   (covenant §3.1-4);
 * - custody is a COMPOSITION-TIME property: `'external'` acks perform zero
 *   inventory writes even though `ack` takes no options at all; `'inventory'`
 *   acks perform the §6 ownership handoff;
 * - the persistent (tokenId, stateHash) seen-set survives a provider restart
 *   and rejects replayed deliveries (the recipient never trusts the backend —
 *   ARCHITECTURE §8.2);
 * - a rejected delivery is terminal for DISCOVERY only — later deliveries
 *   keep flowing past it (§6: one bad entry can never wedge the pointer).
 *
 * Run it via `describeDeliveryProviderContract(name, makeContext)` from a
 * `.test.ts` file (see wallet-api-mailbox-provider.contract.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import type { DeliveryProvider, IncomingDelivery } from '../../transport/delivery-provider';
import { unwrapTokenBlobBytes } from '../../token-engine/token-blob';

export interface DeliveryBlobFixture {
  /** Encoded TokenBlob bytes addressed to the recipient. */
  bytes: Uint8Array;
  /** Genesis-stable 64-hex token id. */
  tokenId: string;
  /** Per-state hash: hex(SHA-256(inner token bytes)). */
  stateHash: string;
}

export interface DeliveryProviderContractContext {
  /** The sender-side provider (same transport, the sender's identity). */
  sender: DeliveryProvider;
  /** The recipient-side provider UNDER TEST. */
  recipient: DeliveryProvider;
  /** Recipient chain pubkey (33-byte compressed, hex) — deliver()'s address. */
  recipientPubkey: string;
  /** Build a fresh finished-token blob addressed to the recipient. */
  makeBlob(): DeliveryBlobFixture;
  /**
   * Whether the rail's INVENTORY of record holds an ACTIVE row for the
   * recipient + tokenId (drives the custody assertions).
   */
  recipientInventoryHas(tokenId: string): Promise<boolean>;
  /**
   * Recreate the recipient provider over the SAME persistent state (a process
   * restart) — pins seen-set persistence.
   */
  restartRecipient(): Promise<DeliveryProvider>;
  cleanup?(): Promise<void>;
}

/** The backend's entry_id formula (ARCHITECTURE §6), re-implemented here. */
function referenceDeliveryId(tokenIdHex: string, stateHashHex: string): string {
  const hexToBytes = (h: string): Uint8Array => {
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return out;
  };
  const tokenId = hexToBytes(tokenIdHex);
  const stateHash = hexToBytes(stateHashHex);
  const joined = new Uint8Array(tokenId.length + stateHash.length);
  joined.set(tokenId, 0);
  joined.set(stateHash, tokenId.length);
  return Array.from(sha256(joined), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function drain(provider: DeliveryProvider, sinceCursor?: string): Promise<IncomingDelivery[]> {
  const out: IncomingDelivery[] = [];
  for await (const d of provider.incoming(sinceCursor)) out.push(d);
  return out;
}

export function describeDeliveryProviderContract(
  name: string,
  makeContext: () => Promise<DeliveryProviderContractContext>
): void {
  describe(`delivery-provider contract: ${name}`, () => {
    let ctx: DeliveryProviderContractContext;

    beforeEach(async () => {
      ctx = await makeContext();
    });

    afterEach(async () => {
      await ctx.cleanup?.();
    });

    it('deliver() returns the CONTENT-DERIVED deliveryId (the backend entry_id formula)', async () => {
      const blob = ctx.makeBlob();
      const receipt = await ctx.sender.deliver(ctx.recipientPubkey, blob.bytes, { transferId: 'tf-1' });
      // covenant §3.1-4: never a server row id or seq.
      expect(receipt.deliveryId).toBe(referenceDeliveryId(blob.tokenId, blob.stateHash));
    });

    it('deliver() is idempotent per (token, state) — same id, no error, no duplicate', async () => {
      const blob = ctx.makeBlob();
      const first = await ctx.sender.deliver(ctx.recipientPubkey, blob.bytes, { transferId: 'tf-2' });
      const second = await ctx.sender.deliver(ctx.recipientPubkey, blob.bytes, { transferId: 'tf-2' });
      expect(second.deliveryId).toBe(first.deliveryId);

      const incoming = await drain(ctx.recipient);
      expect(incoming.filter((d) => d.deliveryId === first.deliveryId)).toHaveLength(1);
    });

    it('incoming() yields the delivery with the exact token bytes and its transferId', async () => {
      const blob = ctx.makeBlob();
      const { deliveryId } = await ctx.sender.deliver(ctx.recipientPubkey, blob.bytes, {
        transferId: 'tf-3',
      });

      const incoming = await drain(ctx.recipient);
      const delivery = incoming.find((d) => d.deliveryId === deliveryId);
      expect(delivery).toBeDefined();
      expect(delivery!.transferId).toBe('tf-3');
      expect(typeof delivery!.cursor).toBe('string');
      // The INNER token bytes round-trip byte-exactly. The envelope itself is
      // transport-dependent: the wallet-api rail carries RAW wire bytes
      // (ARCHITECTURE §5.2/§8.2 — the 39051 envelope never crosses the §16
      // API), while peer transports may carry the envelope verbatim.
      expect(Array.from(unwrapTokenBlobBytes(await delivery!.fetchBlob()))).toEqual(
        Array.from(unwrapTokenBlobBytes(blob.bytes))
      );
    });

    it("custody is composition-time: ack('claimed') with NO options honors the constructed mode", async () => {
      const blob = ctx.makeBlob();
      const { deliveryId } = await ctx.sender.deliver(ctx.recipientPubkey, blob.bytes, {
        transferId: 'tf-4',
      });
      await drain(ctx.recipient); // discover
      await ctx.recipient.ack(deliveryId, 'claimed');

      if (ctx.recipient.custody === 'inventory') {
        // §6 ownership handoff: the claimed token entered the rail's inventory.
        expect(await ctx.recipientInventoryHas(blob.tokenId)).toBe(true);
      } else {
        // §6 delivery-only claim: ZERO inventory writes — custody stays with
        // the app's own storage, with nothing remembered at the call site.
        expect(await ctx.recipientInventoryHas(blob.tokenId)).toBe(false);
      }
    });

    it('deliver() still succeeds (same id) AFTER the recipient claimed — replay-safe deposits', async () => {
      const blob = ctx.makeBlob();
      const { deliveryId } = await ctx.sender.deliver(ctx.recipientPubkey, blob.bytes, {
        transferId: 'tf-5',
      });
      await drain(ctx.recipient);
      await ctx.recipient.ack(deliveryId, 'claimed');

      // ARCHITECTURE §6: a crashed sender's re-deposit always succeeds, even
      // after the recipient has claimed — what makes journal replay safe.
      const replay = await ctx.sender.deliver(ctx.recipientPubkey, blob.bytes, { transferId: 'tf-5' });
      expect(replay.deliveryId).toBe(deliveryId);
    });

    it('the persistent seen-set rejects a replayed delivery across a provider restart', async () => {
      const blob = ctx.makeBlob();
      const { deliveryId } = await ctx.sender.deliver(ctx.recipientPubkey, blob.bytes, {
        transferId: 'tf-6',
      });
      await drain(ctx.recipient);
      await ctx.recipient.ack(deliveryId, 'claimed');

      // Fresh provider instance over the same persistent state; force a
      // from-the-start pull (cursor '0') — the SEEN-SET, not the cursor, is
      // the replay guard (S7: the recipient never trusts the backend).
      const restarted = await ctx.restartRecipient();
      const replayed = await drain(restarted, '0');
      expect(replayed.find((d) => d.deliveryId === deliveryId)).toBeUndefined();
    });

    it("ack('rejected') is terminal for discovery only — later deliveries keep flowing", async () => {
      const bad = ctx.makeBlob();
      const { deliveryId: badId } = await ctx.sender.deliver(ctx.recipientPubkey, bad.bytes, {
        transferId: 'tf-7a',
      });
      await drain(ctx.recipient);
      await ctx.recipient.ack(badId, 'rejected');

      // A rejected delivery performs no inventory writes…
      expect(await ctx.recipientInventoryHas(bad.tokenId)).toBe(false);

      // …never resurfaces…
      const good = ctx.makeBlob();
      const { deliveryId: goodId } = await ctx.sender.deliver(ctx.recipientPubkey, good.bytes, {
        transferId: 'tf-7b',
      });
      const next = await drain(ctx.recipient);
      expect(next.find((d) => d.deliveryId === badId)).toBeUndefined();
      // …and discovery continues past it (§6: one bad entry can never wedge
      // the read pointer).
      expect(next.find((d) => d.deliveryId === goodId)).toBeDefined();
    });
  });
}
