/**
 * storage-port.contract.ts — the S7 StoragePort contract suite. Any
 * implementation must pass with a harness that fabricates decodable blobs for
 * its backend. Typed-error convention the port contract pins: applyDelta
 * lineage refusal carries `code: 'DELTA_CONFLICT'`, delta validation refusal
 * carries `code: 'DELTA_VALIDATION'`.
 */
import { describe, expect, it } from 'vitest';

import type { StoragePort } from '../../../../modules/payments-v2/ports';

export interface StorageContractBlob {
  bytes: Uint8Array;
  sha256: string;
  tokenId: string;
  stateHash: string;
}

export interface StorageBlobOptions {
  tokenId?: string;
  stateHash?: string;
  consumedStates?: string[];
  ownerPubkey?: string;
  coinId?: string;
  amount?: string;
}

export interface StoragePortHarness {
  port: StoragePort;
  ownerPubkey: string;
  makeBlob(opts?: StorageBlobOptions): StorageContractBlob;
}

function codeOf(err: unknown): string | undefined {
  return (err as { code?: string }).code;
}

async function seed(
  harness: StoragePortHarness,
  transferId: string,
  opts: StorageBlobOptions = {}
): Promise<{ blob: StorageContractBlob; cursor: number }> {
  const blob = harness.makeBlob(opts);
  const keys = await harness.port.uploadBlobs([{ sha256: blob.sha256, bytes: blob.bytes }]);
  const key = keys.get(blob.sha256);
  expect(key).toBeDefined();
  const result = await harness.port.applyDelta({
    transferId,
    spent: [],
    added: [{ tokenId: blob.tokenId, key: key as string }],
  });
  return { blob, cursor: result.cursor };
}

export function describeStoragePortContract(
  name: string,
  makeHarness: () => StoragePortHarness | Promise<StoragePortHarness>
): void {
  describe(`StoragePort contract: ${name}`, () => {
    it('uploadBlobs returns a sha256→key entry for every uploaded blob', async () => {
      const h = await makeHarness();
      const a = h.makeBlob();
      const b = h.makeBlob();
      const keys = await h.port.uploadBlobs([
        { sha256: a.sha256, bytes: a.bytes },
        { sha256: b.sha256, bytes: b.bytes },
      ]);
      expect(keys.get(a.sha256)).toBeDefined();
      expect(keys.get(b.sha256)).toBeDefined();
    });

    it('applyDelta(add) makes the token listable as active; a later spend leaves only active rows in a no-since list', async () => {
      const h = await makeHarness();
      const { blob: kept } = await seed(h, 'tid-keep');
      const { blob: spent } = await seed(h, 'tid-spend-seed');
      await h.port.applyDelta({ transferId: 'tid-spend', spent: [spent.tokenId], added: [] });
      const page = await h.port.listInventory();
      expect(page.items.map((i) => i.tokenId)).toEqual([kept.tokenId]);
      expect(page.items[0]?.status).toBe('active');
      expect(page.items[0]?.stateHash).toBe(kept.stateHash);
    });

    it('a ?since= delta includes the tombstone of a spent token', async () => {
      const h = await makeHarness();
      const { blob } = await seed(h, 'tid-seed');
      const before = await h.port.listInventory();
      await h.port.applyDelta({ transferId: 'tid-spend', spent: [blob.tokenId], added: [] });
      const delta = await h.port.listInventory(before.cursor);
      const tombstone = delta.items.find((i) => i.tokenId === blob.tokenId);
      expect(tombstone?.status).toBe('removed');
    });

    it('applyDelta replay of the same transferId returns the recorded cursor and mutates nothing, even after later writes', async () => {
      const h = await makeHarness();
      const first = await seed(h, 'tid-1');
      await seed(h, 'tid-2');
      const snapshot = await h.port.listInventory();
      const key = (await h.port.uploadBlobs([{ sha256: first.blob.sha256, bytes: first.blob.bytes }])).get(
        first.blob.sha256
      );
      const replay = await h.port.applyDelta({
        transferId: 'tid-1',
        spent: [],
        added: [{ tokenId: first.blob.tokenId, key: key as string }],
      });
      expect(replay.cursor).toBe(first.cursor);
      const after = await h.port.listInventory();
      expect(after.items).toEqual(snapshot.items);
      expect(after.cursor).toBe(snapshot.cursor);
    });

    it('applyDelta lineage refusal surfaces as the typed conflict error (code DELTA_CONFLICT)', async () => {
      const h = await makeHarness();
      const { blob: stale } = await seed(h, 'tid-s1');
      await seed(h, 'tid-s2', { tokenId: stale.tokenId, consumedStates: [stale.stateHash] });
      const key = (await h.port.uploadBlobs([{ sha256: stale.sha256, bytes: stale.bytes }])).get(stale.sha256);
      const err = await h.port
        .applyDelta({ transferId: 'tid-stale-readd', spent: [], added: [{ tokenId: stale.tokenId, key: key as string }] })
        .then(() => null)
        .catch((e: unknown) => e);
      expect(err).not.toBeNull();
      expect(codeOf(err)).toBe('DELTA_CONFLICT');
    });

    it('applyDelta validation refusal surfaces as the typed validation error (code DELTA_VALIDATION)', async () => {
      const h = await makeHarness();
      const err = await h.port
        .applyDelta({ transferId: 'tid-bad', spent: ['ab'.repeat(32)], added: [] })
        .then(() => null)
        .catch((e: unknown) => e);
      expect(err).not.toBeNull();
      expect(codeOf(err)).toBe('DELTA_VALIDATION');
    });

    it('getBlobs returns byte-identical bytes for each requested tokenId', async () => {
      const h = await makeHarness();
      const { blob: a } = await seed(h, 'tid-a');
      const { blob: b } = await seed(h, 'tid-b');
      const blobs = await h.port.getBlobs([a.tokenId, b.tokenId]);
      expect([...(blobs.get(a.tokenId) ?? [])]).toEqual([...a.bytes]);
      expect([...(blobs.get(b.tokenId) ?? [])]).toEqual([...b.bytes]);
    });
  });
}
