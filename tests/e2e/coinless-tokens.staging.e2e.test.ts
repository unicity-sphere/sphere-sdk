/**
 * Coinless tokens against LIVE staging — the assertions fakes cannot make.
 *
 * Every other coinless test in this repo runs against `FakeTokenEngine` or a stub
 * that round-trips whatever it was handed, so wrong CBOR sails through them
 * (CLAUDE.md: facade tests swap a fake engine via `setEngine` and would pass with
 * the CBOR wrong). This leg mints a REAL testnet2-certified coinless token, indexes
 * it through the deployed backend, and reads it back through the presigned GET.
 *
 * Requires `STAGING_AGGREGATOR_KEY`; dormant otherwise, and excluded from CI by
 * `vitest.config.ts` (`exclude: ['tests/e2e/**']`) — run with `npm run test:e2e`.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { afterAll, describe, expect, it } from 'vitest';

import { bytesToHex, hexToBytes } from '../../core/crypto';
import { randomUUID } from '../../core/uuid';
import { WalletApiStoragePort } from '../../impl/wallet-api-v2/storage';
import { CborSerializer } from '../../token-engine/sdk';
import type { SphereToken } from '../../token-engine/types';

import { RUN_STAGING } from './support/staging';
import {
  activeRows,
  drainUntil,
  logStep,
  makeVerticalWallet,
  shutdownVerticalWallets,
  waitFor,
  type VWallet,
} from './support/vertical';

/**
 * The registry's canonical testnet2 non-fungible TYPE id (`assetKind:
 * "non-fungible"` in unicity-ids.testnet2.json). Minting without one takes
 * `TokenType.generate()`'s 32 random bytes, which is a valid token but not what a
 * real NFT carries — and this leg exists to exercise the real shape.
 */
const TESTNET2_NFT_TYPE = '971a26eef0e3aeb22bd3e7d44c47ce963400037e8df42b50d4d44e1589f83826';

/** Non-null on purpose: byte-identity needs something to compare. */
const NFT_PAYLOAD = CborSerializer.encodeTextString('kitty #1');

const HARNESS_COIN = 'a'.repeat(64);

describe.skipIf(!RUN_STAGING)('coinless tokens — live staging', () => {
  afterAll(async () => {
    await shutdownVerticalWallets();
  });

  /** Mint a real coinless token and index it through the deployed backend. */
  async function mintAndIndexCoinless(w: VWallet, data: Uint8Array): Promise<SphereToken> {
    const token = await w.engine.mintDataToken({
      recipientPubkey: hexToBytes(w.identity.chainPubkey),
      data,
      tokenType: hexToBytes(TESTNET2_NFT_TYPE),
    });
    logStep(`minted coinless token ${token.blob.tokenId.slice(0, 12)}…`);

    // The stored blob is the WHOLE Token CBOR (§5.2 content-addressed), never the
    // genesis payload — which is exactly why reading it back has to decode.
    const bytes = token.blob.token;
    const shaHex = bytesToHex(sha256(bytes));
    const storage = new WalletApiStoragePort(w.api);
    const key = (await storage.uploadBlobs([{ sha256: shaHex, bytes }])).get(shaHex);
    if (key === undefined) throw new Error('upload returned no key for the coinless blob');

    await storage.applyDelta({
      transferId: randomUUID(),
      spent: [],
      added: [{ tokenId: token.blob.tokenId, key }],
    });
    logStep(`indexed coinless token ${token.blob.tokenId.slice(0, 12)}…`);
    return token;
  }

  /** A fresh instance on the same identity/kv: its `start()` does a full pull. */
  async function reopen(w: VWallet): Promise<VWallet> {
    await w.facade.stop().catch(() => undefined);
    return makeVerticalWallet(w.tag, { identity: w.identity, kv: w.kv });
  }

  it(
    'a REAL coinless token surfaces in coinless() and never in tokens(), and its payload round-trips byte-identically',
    async () => {
      let w = await makeVerticalWallet('coinless-read');
      const token = await mintAndIndexCoinless(w, NFT_PAYLOAD);
      w = await reopen(w);

      // 1. Present in the disjoint read, carrying the registry type.
      const rows = w.facade.coinless();
      const row = rows.find((r) => r.tokenId === token.blob.tokenId);
      expect(row).toBeDefined();
      expect(row?.tokenType).toBe(TESTNET2_NFT_TYPE);

      // 2. Absent from tokens(), on a token that made a real round trip through
      //    S3 and §8.2 rather than a fixture the mirror was handed.
      expect(w.facade.tokens().map((t) => t.id)).not.toContain(token.blob.tokenId);

      // 3. Contributes to no balance.
      expect(await w.facade.assets()).toEqual([]);

      // 4. THE assertion a fake cannot make: the payload survives CBOR encode →
      //    SHA-256 content addressing → S3 → presigned GET → CBOR decode. A fake
      //    engine returns whatever it was handed, so only this catches a
      //    `tokenData` that returned the blob instead of the genesis payload.
      expect(await w.facade.tokenData(token.blob.tokenId)).toEqual(NFT_PAYLOAD);
    },
    600_000
  );

  it(
    'an EMPTY genesis payload is coinless, and stays distinct from an absent one',
    async () => {
      let w = await makeVerticalWallet('coinless-null');
      const token = await w.engine.mintDataToken({
        recipientPubkey: hexToBytes(w.identity.chainPubkey),
        data: new Uint8Array(0),
        tokenType: hexToBytes(TESTNET2_NFT_TYPE),
      });
      const bytes = token.blob.token;
      const shaHex = bytesToHex(sha256(bytes));
      const storage = new WalletApiStoragePort(w.api);
      const key = (await storage.uploadBlobs([{ sha256: shaHex, bytes }])).get(shaHex);
      if (key === undefined) throw new Error('upload returned no key');
      await storage.applyDelta({
        transferId: randomUUID(),
        spent: [],
        added: [{ tokenId: token.blob.tokenId, key }],
      });

      w = await reopen(w);

      expect(w.facade.coinless().map((r) => r.tokenId)).toContain(token.blob.tokenId);
      // Classified `none_absent` — coinless, not a failure. But it reads back as an
      // EMPTY payload rather than null: a typed array is truthy, so zero bytes
      // survive the round trip as data. (`mintDataToken` types `data` as required,
      // so a genuinely absent payload is not expressible through this API at all.)
      expect(await w.facade.tokenData(token.blob.tokenId)).toEqual(new Uint8Array(0));
    },
    600_000
  );

  it(
    'a valued token and a coinless one coexist: each in exactly one read, balance unaffected',
    async () => {
      let w = await makeVerticalWallet('coinless-mixed');
      const nft = await mintAndIndexCoinless(w, NFT_PAYLOAD);

      const mint = await w.facade.mint(HARNESS_COIN, 500n);
      if (!mint.success) throw new Error(`valued mint failed: ${mint.error ?? 'unknown'}`);
      const coinTokenId = mint.tokenId;
      logStep(`minted valued token ${(coinTokenId ?? '').slice(0, 12)}…`);

      w = await reopen(w);

      const coinlessIds = w.facade.coinless().map((r) => r.tokenId);
      const tokenIds = w.facade.tokens().map((t) => t.id);

      expect(coinlessIds).toContain(nft.blob.tokenId);
      expect(coinlessIds).not.toContain(coinTokenId);
      expect(tokenIds).toContain(coinTokenId);
      expect(tokenIds).not.toContain(nft.blob.tokenId);

      // The coinless row changes no balance: the valued mint is the whole total.
      const assets = await w.facade.assets();
      expect(assets).toHaveLength(1);
      expect(assets[0]?.totalAmount).toBe('500');
    },
    900_000
  );
});

describe.skipIf(!RUN_STAGING)('coinless tokens — transfer, live staging', () => {
  afterAll(async () => {
    await shutdownVerticalWallets();
  });

  async function mintAndIndex(w: VWallet, data: Uint8Array): Promise<SphereToken> {
    const token = await w.engine.mintDataToken({
      recipientPubkey: hexToBytes(w.identity.chainPubkey),
      data,
      tokenType: hexToBytes(TESTNET2_NFT_TYPE),
    });
    const bytes = token.blob.token;
    const shaHex = bytesToHex(sha256(bytes));
    const storage = new WalletApiStoragePort(w.api);
    const key = (await storage.uploadBlobs([{ sha256: shaHex, bytes }])).get(shaHex);
    if (key === undefined) throw new Error('upload returned no key');
    await storage.applyDelta({
      transferId: randomUUID(),
      spent: [],
      added: [{ tokenId: token.blob.tokenId, key }],
    });
    logStep(`indexed coinless ${token.blob.tokenId.slice(0, 12)}…`);
    return token;
  }

  it(
    'moves a REAL coinless token A→B: certified on testnet2, verified by B before it enters inventory',
    async () => {
      let a = await makeVerticalWallet('nft-a');
      const b = await makeVerticalWallet('nft-b');
      const nft = await mintAndIndex(a, NFT_PAYLOAD);

      // Reopen so A's mirror sees the freshly indexed row.
      await a.facade.stop().catch(() => undefined);
      a = await makeVerticalWallet('nft-a', { identity: a.identity, kv: a.kv });
      expect(a.facade.coinless().map((t) => t.tokenId)).toContain(nft.blob.tokenId);

      const result = await a.facade.sendCoinless({
        recipient: b.identity.chainPubkey,
        tokenId: nft.blob.tokenId,
      });
      expect(['delivered', 'confirmed']).toContain(result.status);
      expect(result.tokenTransfers).toEqual([
        { sourceTokenId: nft.blob.tokenId, method: 'direct' },
      ]);

      // B accepting implies the FULL real trust-base verify + isOwnedBy passed —
      // Receive screens before it stores or claims.
      await drainUntil(
        b,
        () => b.facade.coinless().some((t) => t.tokenId === nft.blob.tokenId),
        120_000,
        'B receives the coinless token'
      );
      expect((await activeRows(b)).map((r) => r.tokenId)).toContain(nft.blob.tokenId);

      // The payload survived the whole round trip, byte for byte, through a
      // DIFFERENT wallet's blob fetch.
      expect(await b.facade.tokenData(nft.blob.tokenId)).toEqual(NFT_PAYLOAD);

      // …and it left A.
      await waitFor(
        a,
        () => !a.facade.coinless().some((t) => t.tokenId === nft.blob.tokenId),
        90_000,
        'A no longer holds the token'
      );
      expect(await a.facade.assets()).toEqual([]);
    },
    900_000
  );

  it(
    'refuses to move a VALUED token through sendCoinless, against the real backend',
    async () => {
      const w = await makeVerticalWallet('nft-refuse');
      const mint = await w.facade.mint(HARNESS_COIN, 250n);
      if (!mint.success || mint.tokenId === undefined) {
        throw new Error(`valued mint failed: ${mint.error ?? 'unknown'}`);
      }

      await expect(
        w.facade.sendCoinless({ recipient: w.identity.chainPubkey, tokenId: mint.tokenId })
      ).rejects.toThrow(/not a spendable coinless holding|carries coin value/);

      // Refused BEFORE any chain op: the coin is still spendable.
      const assets = await w.facade.assets();
      expect(assets[0]?.totalAmount).toBe('250');
    },
    600_000
  );
});
