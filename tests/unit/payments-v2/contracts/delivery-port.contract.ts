/**
 * delivery-port.contract.ts — the S7 DeliveryPort contract suite. Invariants
 * pinned here (test names are the spec): content-derived deliveryId, unbound
 * deliveryKeys refusal, key-variant 409 absorption, batch fallback, the
 * persistent seen-set (entered ONLY after a successful ack), and the
 * memo/senderNametag round-trip.
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { DeliveryPort, IncomingDelivery, StoragePort } from '../../../../modules/payments-v2/ports';

export interface DeliveryContractBlob {
  bytes: Uint8Array;
  sha256: string;
  tokenId: string;
  stateHash: string;
}

export interface DeliveryBlobOptions {
  tokenId?: string;
  stateHash?: string;
  consumedStates?: string[];
  /** Same (tokenId, stateHash), different bytes — the rebuilt-proof case. */
  variant?: string;
}

export interface DeliveryPortHarness {
  /** Owner-account port; every call shares the SAME durable seen-set. */
  makePort(opts?: { bound?: boolean }): DeliveryPort;
  /** The owner's StoragePort — used to advance the owner's inventory state. */
  storage: StoragePort;
  ownerPubkey: string;
  /** Counterparty port (own account and seen-set, keys bound). */
  counterpartyPort: DeliveryPort;
  counterpartyPubkey: string;
  makeBlob(toPubkey: string, opts?: DeliveryBlobOptions): DeliveryContractBlob;
}

export function expectedDeliveryId(tokenIdHex: string, stateHashHex: string): string {
  return createHash('sha256')
    .update(Buffer.from(tokenIdHex, 'hex'))
    .update(Buffer.from(stateHashHex, 'hex'))
    .digest('hex');
}

async function collect(iter: AsyncIterable<IncomingDelivery>): Promise<IncomingDelivery[]> {
  const out: IncomingDelivery[] = [];
  for await (const delivery of iter) out.push(delivery);
  return out;
}

async function supersede(h: DeliveryPortHarness, blob: DeliveryContractBlob): Promise<void> {
  const newer = h.makeBlob(h.ownerPubkey, { tokenId: blob.tokenId, consumedStates: [blob.stateHash] });
  const keys = await h.storage.uploadBlobs([{ sha256: newer.sha256, bytes: newer.bytes }]);
  await h.storage.applyDelta({
    transferId: `supersede-${blob.tokenId.slice(0, 8)}`,
    spent: [],
    added: [{ tokenId: newer.tokenId, key: keys.get(newer.sha256) as string }],
  });
}

export function describeDeliveryPortContract(
  name: string,
  makeHarness: () => DeliveryPortHarness | Promise<DeliveryPortHarness>
): void {
  describe(`DeliveryPort contract: ${name}`, () => {
    it('deliver returns the content-derived deliveryId — hex(SHA-256(tokenId ‖ stateHash))', async () => {
      const h = await makeHarness();
      const blob = h.makeBlob(h.counterpartyPubkey);
      const receipt = await h.makePort().deliver(h.counterpartyPubkey, blob.bytes, { transferId: 't-single' });
      expect(receipt.deliveryId).toBe(expectedDeliveryId(blob.tokenId, blob.stateHash));
    });

    it('deliverBatch receipts are content-derived deliveryIds in request order, never server seqs', async () => {
      const h = await makeHarness();
      const a = h.makeBlob(h.counterpartyPubkey);
      const b = h.makeBlob(h.counterpartyPubkey);
      const receipts = await h
        .makePort()
        .deliverBatch?.(h.counterpartyPubkey, [a.bytes, b.bytes], { transferId: 't-batch' });
      expect(receipts?.map((r) => r.deliveryId)).toEqual([
        expectedDeliveryId(a.tokenId, a.stateHash),
        expectedDeliveryId(b.tokenId, b.stateHash),
      ]);
    });

    it('deliver throws the unbound-deliveryKeys refusal when no derivation is bound', async () => {
      const h = await makeHarness();
      const blob = h.makeBlob(h.counterpartyPubkey);
      const port = h.makePort({ bound: false });
      await expect(port.deliver(h.counterpartyPubkey, blob.bytes, { transferId: 't-unbound' })).rejects.toThrow(
        /deliveryKeys|unbound/i
      );
    });

    it('a key-variant 409 (same state, different bytes) absorbs as idempotent success with the same deliveryId', async () => {
      const h = await makeHarness();
      const port = h.makePort();
      const original = h.makeBlob(h.counterpartyPubkey);
      const variant = h.makeBlob(h.counterpartyPubkey, {
        tokenId: original.tokenId,
        stateHash: original.stateHash,
        variant: 'rebuilt-proof',
      });
      expect(variant.sha256).not.toBe(original.sha256);
      const first = await port.deliver(h.counterpartyPubkey, original.bytes, { transferId: 't-orig' });
      const second = await port.deliver(h.counterpartyPubkey, variant.bytes, { transferId: 't-orig' });
      expect(second.deliveryId).toBe(first.deliveryId);
      expect(second.deliveryId).toBe(expectedDeliveryId(original.tokenId, original.stateHash));
    });

    it('a batch-level 409 falls back per-entry: the conflicted entry absorbs, the sibling lands', async () => {
      const h = await makeHarness();
      const port = h.makePort();
      const conflicted = h.makeBlob(h.counterpartyPubkey);
      await port.deliver(h.counterpartyPubkey, conflicted.bytes, { transferId: 't-pre' });
      const variant = h.makeBlob(h.counterpartyPubkey, {
        tokenId: conflicted.tokenId,
        stateHash: conflicted.stateHash,
        variant: 'rebuilt',
      });
      const fresh = h.makeBlob(h.counterpartyPubkey);
      const receipts = await port.deliverBatch?.(h.counterpartyPubkey, [variant.bytes, fresh.bytes], {
        transferId: 't-fallback',
      });
      expect(receipts?.map((r) => r.deliveryId)).toEqual([
        expectedDeliveryId(conflicted.tokenId, conflicted.stateHash),
        expectedDeliveryId(fresh.tokenId, fresh.stateHash),
      ]);
      const incoming = await collect(h.counterpartyPort.incoming());
      const ids = incoming.map((d) => d.deliveryId);
      expect(ids).toContain(expectedDeliveryId(fresh.tokenId, fresh.stateHash));
    });

    it('incoming yields the delivery and fetchBlob returns bytes whose derived keys match the entry id', async () => {
      const h = await makeHarness();
      const blob = h.makeBlob(h.ownerPubkey);
      await h.counterpartyPort.deliver(h.ownerPubkey, blob.bytes, { transferId: 't-in' });
      const deliveries = await collect(h.makePort().incoming());
      const match = deliveries.find((d) => d.deliveryId === expectedDeliveryId(blob.tokenId, blob.stateHash));
      expect(match).toBeDefined();
      expect([...(await match?.fetchBlob() ?? new Uint8Array())]).toEqual([...blob.bytes]);
    });

    it('memo and senderNametag round-trip from deliver options to the incoming delivery', async () => {
      const h = await makeHarness();
      const blob = h.makeBlob(h.ownerPubkey);
      await h.counterpartyPort.deliver(h.ownerPubkey, blob.bytes, {
        transferId: 't-memo',
        memo: 'for the coffee',
        senderNametag: 'carol',
      });
      const deliveries = await collect(h.makePort().incoming());
      const match = deliveries.find((d) => d.deliveryId === expectedDeliveryId(blob.tokenId, blob.stateHash));
      expect(match?.memo).toBe('for the coffee');
      expect(match?.senderNametag).toBe('carol');
    });

    it('an acked (claimed) delivery is never re-yielded — not by this instance and not by a NEW port instance', async () => {
      const h = await makeHarness();
      const blob = h.makeBlob(h.ownerPubkey);
      await h.counterpartyPort.deliver(h.ownerPubkey, blob.bytes, { transferId: 't-ack' });
      const port = h.makePort();
      const id = expectedDeliveryId(blob.tokenId, blob.stateHash);
      expect((await collect(port.incoming())).map((d) => d.deliveryId)).toContain(id);
      await port.ack(id, 'claimed');
      expect((await collect(port.incoming())).map((d) => d.deliveryId)).not.toContain(id);
      expect((await collect(h.makePort().incoming())).map((d) => d.deliveryId)).not.toContain(id);
    });

    it('a rejected delivery enters the seen-set after the ack and is not re-yielded by a new instance', async () => {
      const h = await makeHarness();
      const blob = h.makeBlob(h.ownerPubkey);
      await h.counterpartyPort.deliver(h.ownerPubkey, blob.bytes, { transferId: 't-reject' });
      const port = h.makePort();
      const id = expectedDeliveryId(blob.tokenId, blob.stateHash);
      expect((await collect(port.incoming())).map((d) => d.deliveryId)).toContain(id);
      await port.ack(id, 'rejected', 'invalid');
      expect((await collect(h.makePort().incoming())).map((d) => d.deliveryId)).not.toContain(id);
    });

    it('the seen-set records an entry ONLY after its ack succeeded — a failed claim leaves it re-yielded by a NEW port instance', async () => {
      const h = await makeHarness();
      const blob = h.makeBlob(h.ownerPubkey);
      await h.counterpartyPort.deliver(h.ownerPubkey, blob.bytes, { transferId: 't-crash' });
      await supersede(h, blob);
      const port = h.makePort();
      const id = expectedDeliveryId(blob.tokenId, blob.stateHash);
      expect((await collect(port.incoming())).map((d) => d.deliveryId)).toContain(id);
      await expect(port.ack(id, 'claimed')).rejects.toThrow();
      expect((await collect(h.makePort().incoming())).map((d) => d.deliveryId)).toContain(id);
    });
  });
}
