/**
 * NFT metadata (#785) against LIVE staging — the assertions the fake engine cannot make.
 *
 * The unit suite drives `mintNft` over `FakeTokenEngine`, which shares the codec and
 * the digest code with the real engine, so the two can never disagree there. Here a
 * REAL testnet2 mint must reproduce the token id the plan derived, the deployed
 * wallet-api must index the vessel type and accept a MINT record naming no coin, and
 * a signature must still verify after a real transfer, read from the RECIPIENT's own
 * blob fetch — bound to the genesis recipient, not to the new owner.
 *
 * Tests are SEQUENTIAL and share wallet A and its minted ids. A keep-open mint is
 * never re-issued (a second `mintNft()` draws a new salt and mints a second NFT); it
 * converges by replaying the journaled bytes on a rebuilt wallet.
 *
 * Requires `STAGING_AGGREGATOR_KEY`; dormant otherwise, and excluded from CI by
 * `vitest.config.ts` (`exclude: ['tests/e2e/**']`). Run:
 *   npx vitest run --config vitest.e2e.config.ts tests/e2e/nft-metadata.staging.e2e.test.ts
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { afterAll, describe, expect, it } from 'vitest';

import { NETWORKS } from '../../constants';
import { bytesToHex, hexToBytes } from '../../core/crypto';
import type { MintNftRequest } from '../../modules/payments-v2/api';
import { createMachineStores } from '../../modules/payments-v2/machine/journal';
import {
  verifyNftLinkContent,
  type NftLink,
  type NftMedia,
  type NftMetadata,
} from '../../token-engine/nft-payload';

import { NETWORK, RUN_STAGING } from './support/staging';
import {
  activeRows,
  convergeByReplay,
  drainUntil,
  historyEntries,
  logStep,
  makeVerticalWallet,
  MINT_CONVERGE_MS,
  must,
  shutdownVerticalWallets,
  waitFor,
  type VWallet,
} from './support/vertical';

/** The network's NFT vessel — the registry's single `non-fungible` entry. */
const VESSEL = NETWORKS[NETWORK].nftTokenType;

/** A complete 1×1 RGBA PNG (valid chunk CRCs): real image bytes, small enough to carry inline. */
const PIXEL_PNG = hexToBytes(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000d4944415478da636460f85f0f0002870180eb47ba920000000049454e44ae426082'
);

/** A hosted file at a pinned commit, so its bytes — and so the pinned digest — never move. */
const LOGO_URI =
  'https://raw.githubusercontent.com/unicitynetwork/unicity-ids/cbf53542465c852ba219b7d2362adef3b85e3ff4/unicity_logo_32.png';
const LOGO_LINK: NftLink = {
  kind: 'link',
  media_type: 'image/png',
  uri: LOGO_URI,
  sha256: 'acc52f7f4e3c271cacb6e633ec8c8508ee74e1415384b8bfd889d6cf0251245c',
};

/** A collection_id in its manifest-hash form: the SHA-256 of a stand-in collection manifest. */
const COLLECTION_ID = bytesToHex(sha256(new TextEncoder().encode('sphere-sdk #785 staging e2e collection manifest')));

/** (1) Signed, inline image, text and integer attributes (one negative), collection and collection_id, external_url. */
const INLINE: NftMetadata = {
  kind: 'metadata',
  name: 'Pixel #1',
  description: 'A one-pixel NFT minted by the sphere-sdk #785 staging e2e',
  image: { kind: 'media', media_type: 'image/png', bytes: PIXEL_PNG },
  animation_url: null,
  external_url: 'https://github.com/unicity-sphere/sphere-sdk/issues/785',
  attributes: [
    { trait_type: 'Colour', value: 'transparent' },
    { trait_type: 'Width', value: 1 },
    { trait_type: 'Offset', value: -7 },
  ],
  collection: 'Sphere SDK e2e',
  collection_id: COLLECTION_ID,
};

/** (2) Signed, image hosted by NftLink; every optional field absent. */
const LINKED: NftMetadata = {
  kind: 'metadata',
  name: 'Unicity logo',
  description: null,
  image: LOGO_LINK,
  animation_url: null,
  external_url: null,
  attributes: [],
  collection: null,
  collection_id: null,
};

/** (3) Unsigned bare media: no name, no creator. */
const BARE: NftMedia = { kind: 'media', media_type: 'image/png', bytes: PIXEL_PNG };

// ── state shared ACROSS tests (sequential) ──────────────────────────────────

let walletA: VWallet | undefined;
const minted: { inline?: string; linked?: string; bare?: string } = {};

function mintedIds(): { inline: string; linked: string; bare: string } {
  return {
    inline: must(minted.inline, 'the inline NFT id'),
    linked: must(minted.linked, 'the linked NFT id'),
    bare: must(minted.bare, 'the bare NFT id'),
  };
}

/**
 * F13 posture for an NFT: `mintNft()` is called exactly ONCE. A failure naming a
 * tokenId was journaled, so it converges by replaying those same bytes on a rebuilt
 * wallet. Only a failure without one (a refused payload, nothing journaled) is fatal.
 */
async function mintNftConverged(
  wallet: VWallet,
  request: MintNftRequest,
  label: string
): Promise<{ wallet: VWallet; tokenId: string }> {
  const result = await wallet.facade.mintNft(request);
  if (result.success) {
    const tokenId = must(result.tokenId, `${label} tokenId`);
    logStep(`${label}: admitted directly (${tokenId})`);
    return { wallet, tokenId };
  }
  if (result.tokenId === undefined) {
    throw new Error(`${label}: refused before journaling: ${result.error ?? 'unknown'}`);
  }
  const tokenId = result.tokenId;
  logStep(`${label}: keep-open (${(result.error ?? 'unknown').slice(0, 90)}) — converging via NFT journal replay, no re-call`);
  const stores = createMachineStores(wallet.kv);
  const converged = await convergeByReplay(
    wallet,
    async (w) =>
      (await stores.nftMintJournal.list()).length === 0 &&
      (await activeRows(w)).some((row) => row.tokenId === tokenId),
    MINT_CONVERGE_MS,
    label
  );
  return { wallet: converged, tokenId };
}

/** A fresh instance on the same identity and kv: its `start()` does a full pull and has an empty NFT cache. */
async function reopen(w: VWallet): Promise<VWallet> {
  await w.facade.stop().catch(() => undefined);
  return makeVerticalWallet(w.tag, { identity: w.identity, kv: w.kv });
}

describe.skipIf(!RUN_STAGING)('NFT metadata (#785) — live staging', () => {
  afterAll(async () => {
    await shutdownVerticalWallets();
  }, 240_000);

  it(
    'mintNft mints signed and unsigned NFTs: exactly three tokens on the server, journal drained, a MINT record per token naming no coin',
    async () => {
      const a0 = await makeVerticalWallet('nft-meta-a');
      const inline = await mintNftConverged(a0, { content: INLINE }, 'mintNft inline image');
      const linked = await mintNftConverged(inline.wallet, { content: LINKED }, 'mintNft linked image');
      const bare = await mintNftConverged(linked.wallet, { content: BARE, sign: false }, 'mintNft bare media');
      const a = bare.wallet;
      walletA = a;
      Object.assign(minted, { inline: inline.tokenId, linked: linked.tokenId, bare: bare.tokenId });
      const ids = [inline.tokenId, linked.tokenId, bare.tokenId];

      for (const id of ids) expect(id).toMatch(/^[0-9a-f]{64}$/);
      expect(new Set(ids).size).toBe(3);
      expect(await createMachineStores(a.kv).nftMintJournal.list()).toEqual([]);

      // Exactly the three planned ids — a replay never certifies a second token under a fresh salt.
      expect((await activeRows(a)).map((row) => row.tokenId).sort()).toEqual([...ids].sort());

      // History swallows a refused POST, so only the record's presence proves wallet-api
      // accepted a MINT with `assets: []`. Read back, a coinless entry names no coin.
      await waitFor(
        a,
        async () => {
          const mints = (await historyEntries(a)).filter((e) => e.type === 'MINT');
          return ids.every((id) => mints.some((e) => e.tokenId === id));
        },
        60_000,
        'a MINT record for each NFT'
      );
      const mints = (await historyEntries(a)).filter((e) => e.type === 'MINT');
      expect(mints).toHaveLength(3);
      for (const entry of mints) expect(entry).toMatchObject({ coinId: '', amount: '0' });
    },
    3_900_000
  );

  it(
    'a reopened wallet lists all three as coinless under the vessel type and reads them back: the signed ones valid by this wallet, the bare one unsigned',
    async () => {
      const a = await reopen(must(walletA, 'wallet A'));
      walletA = a;
      const { inline, linked, bare } = mintedIds();
      const creator = a.identity.chainPubkey;

      // 1. Coinless rows carrying the network's vessel type; no coin token, no balance.
      const rows = a.facade.coinless();
      for (const id of [inline, linked, bare]) {
        expect(rows.find((row) => row.tokenId === id)?.tokenType).toBe(VESSEL);
      }
      expect(a.facade.tokens()).toEqual([]);
      expect(await a.facade.assets()).toEqual([]);

      // 2. The batch read, through the real presigned blob GETs and the real engine decode.
      const views = await a.facade.nfts([inline, linked, bare]);
      expect(views.size).toBe(3);
      expect(views.get(inline)).toEqual({ tokenId: inline, content: INLINE, creator, signature: 'valid' });
      expect(views.get(linked)).toEqual({ tokenId: linked, content: LINKED, creator, signature: 'valid' });
      expect(views.get(bare)).toEqual({ tokenId: bare, content: BARE, creator: null, signature: 'unsigned' });

      // 3. The single read agrees with the batch.
      await expect(a.facade.nft(inline)).resolves.toEqual(views.get(inline));

      // 4. The pinned digest is the hosted file's: a viewer checking the link renders it.
      const response = await fetch(LOGO_URI);
      expect(response.ok).toBe(true);
      expect(verifyNftLinkContent(LOGO_LINK, new Uint8Array(await response.arrayBuffer()))).toBe(true);
    },
    600_000
  );

  it(
    "a signed NFT sent A→B with sendCoinless stays valid for B, from B's own blob fetch, and A's cached reading is refused once it left",
    async () => {
      const a = must(walletA, 'wallet A');
      const { inline } = mintedIds();
      const b = await makeVerticalWallet('nft-meta-b');

      const result = await a.facade.sendCoinless({ recipient: b.identity.chainPubkey, tokenId: inline });
      expect(['delivered', 'confirmed']).toContain(result.status);
      expect(result.tokenTransfers).toEqual([{ sourceTokenId: inline, method: 'direct' }]);

      // B accepting means the full trust-base verify and ownership check passed before it stored.
      await drainUntil(
        b,
        () => b.facade.coinless().some((row) => row.tokenId === inline),
        120_000,
        'B receives the signed NFT'
      );
      // The owner is now B, but the digest names the GENESIS recipient: still A's valid signature.
      await expect(b.facade.nft(inline)).resolves.toEqual({
        tokenId: inline,
        content: INLINE,
        creator: a.identity.chainPubkey,
        signature: 'valid',
      });

      await waitFor(
        a,
        () => !a.facade.coinless().some((row) => row.tokenId === inline),
        90_000,
        'A no longer holds the NFT'
      );
      await expect(a.facade.nft(inline)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    },
    900_000
  );
});
