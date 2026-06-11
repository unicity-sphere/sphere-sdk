/**
 * tests/contract/storage-provider.contract.ts — the shared storage-provider
 * contract suite (sdk-changes S7).
 *
 * One suite that EVERY `TokenStorageProvider` implementation must pass — this
 * is what makes "swappable" (covenant §3.1-6) enforceable rather than
 * aspirational. It exercises the S2 lazy-port semantics every implementation
 * shares: the no-blob inventory view with `bigint` amounts, on-demand blob
 * fetch, and idempotent apply-delta spend recording.
 *
 * Provider-specific *remote* semantics (real tombstoned deltas, `syncEpoch`
 * resync, `recoverRemoved()`, empty-import protection) are pinned in the
 * wallet-api contract test next to this runner — a local whole-blob store has
 * no change journal or server tombstones to exercise.
 *
 * Run it via `describeStorageProviderContract(name, makeContext)` from a
 * `.test.ts` file (see file-token-storage-provider.contract.test.ts and
 * wallet-api-token-storage-provider.contract.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { TokenStorageProvider, TxfStorageDataBase } from '../../storage';
import { makeTestToken, type TestToken } from '../support/wallet-api-test-helpers';

export interface StorageProviderContractContext {
  provider: TokenStorageProvider<TxfStorageDataBase>;
  /**
   * Seed tokens into the store the way the engine path would (a whole-blob
   * `save()` for local providers; write-behind upload + apply for remote).
   */
  seed(tokens: TestToken[]): Promise<void>;
  cleanup?(): Promise<void>;
}

export function describeStorageProviderContract(
  name: string,
  makeContext: () => Promise<StorageProviderContractContext>
): void {
  describe(`storage-provider contract: ${name}`, () => {
    let ctx: StorageProviderContractContext;

    beforeEach(async () => {
      ctx = await makeContext();
    });

    afterEach(async () => {
      await ctx.cleanup?.();
    });

    it('starts with an empty active view (more:false)', async () => {
      const view = await ctx.provider.listInventory();
      expect(view.items).toEqual([]);
      expect(view.more).toBe(false);
    });

    it('lists seeded tokens as active items with bigint amounts — no blobs', async () => {
      // An amount beyond 2^53 must survive exactly (decimal-string wire — §11).
      const big = 2n ** 60n + 7n;
      const t1 = makeTestToken({ amount: 1500n });
      const t2 = makeTestToken({ amount: big, coinId: 'd1'.repeat(32) });
      await ctx.seed([t1, t2]);

      const view = await ctx.provider.listInventory();
      expect(view.more).toBe(false);
      expect(view.items).toHaveLength(2);
      for (const item of view.items) {
        expect(item.status).toBe('active');
        expect(typeof item.seq).toBe('bigint');
        // The view is value metadata only — no blob field exists on items.
        expect('token' in item).toBe(false);
      }
      const i1 = view.items.find((i) => i.tokenId === t1.tokenId);
      const i2 = view.items.find((i) => i.tokenId === t2.tokenId);
      expect(i1?.assets).toEqual([{ coinId: t1.coinId, amount: 1500n }]);
      expect(i2?.assets).toEqual([{ coinId: t2.coinId, amount: big }]);

      // Distinct seqs, cursor covers them.
      expect(i1!.seq).not.toEqual(i2!.seq);
      expect(view.cursor >= i1!.seq && view.cursor >= i2!.seq).toBe(true);
    });

    it('getToken returns the decoded blob for a stored token', async () => {
      const t = makeTestToken();
      await ctx.seed([t]);
      const blob = await ctx.provider.getToken(t.tokenId);
      expect(blob.tokenId).toBe(t.tokenId);
      expect(blob.v).toBe(t.blob.v);
      expect(blob.network).toBe(t.blob.network);
      expect(Array.from(blob.token)).toEqual(Array.from(t.blob.token));
    });

    it('getToken rejects an unknown token', async () => {
      await expect(ctx.provider.getToken('ee'.repeat(32))).rejects.toThrow();
    });

    it('applyDelta(spent) drops the token from the active view', async () => {
      const t1 = makeTestToken();
      const t2 = makeTestToken();
      await ctx.seed([t1, t2]);

      await ctx.provider.applyDelta('11111111-1111-4111-8111-111111111111', [t1.tokenId], []);

      const view = await ctx.provider.listInventory();
      expect(view.items.map((i) => i.tokenId)).toEqual([t2.tokenId]);
    });

    it('applyDelta is idempotent for a replayed transferId (§5.3)', async () => {
      const t1 = makeTestToken();
      const t2 = makeTestToken();
      await ctx.seed([t1, t2]);

      const transferId = '22222222-2222-4222-8222-222222222222';
      await ctx.provider.applyDelta(transferId, [t1.tokenId], []);
      // The replay is a strict no-op — never an error, never a second change.
      await ctx.provider.applyDelta(transferId, [t1.tokenId], []);

      const view = await ctx.provider.listInventory();
      expect(view.items.map((i) => i.tokenId)).toEqual([t2.tokenId]);
    });

    it('applyDelta rejects a tokenId in both spent and added (§5.3 — 422)', async () => {
      const t = makeTestToken();
      await ctx.seed([t]);
      await expect(
        ctx.provider.applyDelta(
          '33333333-3333-4333-8333-333333333333',
          [t.tokenId],
          [{ tokenId: t.tokenId, key: 'whatever' }]
        )
      ).rejects.toThrow();
    });

    it('applyDelta rejects an added token whose bytes were never stored', async () => {
      const ghost = makeTestToken();
      await expect(
        ctx.provider.applyDelta('44444444-4444-4444-8444-444444444444', [], [
          { tokenId: ghost.tokenId, key: `local/t/${'00'.repeat(32)}` },
        ])
      ).rejects.toThrow();
    });
  });
}
