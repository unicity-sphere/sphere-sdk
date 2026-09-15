// NFT metadata (#785) on the PaymentsFacade over REAL wallet-api-v2 ports +
// FakeWalletApi: the journal-first mintNft and its crash replay, and the
// nft()/nfts() reads behind the bounded cache.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { NETWORKS } from '../../../constants';
import { bytesToHex, hexToBytes } from '../../../core/crypto';
import { SphereError } from '../../../core/errors';
import type { EngineOpOptions, MintDataTokenParams, SphereToken } from '../../../token-engine';
import { ProofUnconfirmedError } from '../../../token-engine/errors';
import { encodeNftContent, encodeNftSigned, type NftMedia, type NftMetadata } from '../../../token-engine/nft-payload';
import type { NftView } from '../../../modules/payments-v2/api';
import { Converger, type ConvergerDeps } from '../../../modules/payments-v2/convergence';
import { NftCache } from '../../../modules/payments-v2/inventory/nft-read';
import { createMachineStores } from '../../../modules/payments-v2/machine/journal';
import { NFT_MAX_PAYLOAD_BYTES } from '../../../modules/payments-v2/mint-nft';
import { STORE_KEYS, type NftMintJournalEntry } from '../../../modules/payments-v2/stores';
import { RealizationEngine } from './machine-harness';
import {
  OWN_PRIV,
  OWN_PUB,
  PEER_PUB,
  cleanupWorlds,
  eventsOf,
  flushTail,
  makeWorld,
  ownCaller,
  type World,
} from './facade-harness';

afterEach(cleanupWorlds);

const VESSEL = NETWORKS.testnet2.nftTokenType;

const IMAGE: NftMedia = {
  kind: 'media',
  media_type: 'image/png',
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
};

const METADATA: NftMetadata = {
  kind: 'metadata',
  name: 'Kitty #1',
  description: 'A ginger test cat',
  image: IMAGE,
  animation_url: null,
  external_url: 'https://example.com/kitty/1',
  attributes: [
    { trait_type: 'colour', value: 'ginger' },
    { trait_type: 'lives', value: 9 },
  ],
  collection: 'Kitties',
  collection_id: '5eed'.repeat(16),
};

/** The harness engine, able to sign as the wallet's own chain key. */
function keyedEngine(): RealizationEngine {
  return new RealizationEngine({ chainPubkey: hexToBytes(OWN_PUB), privateKey: hexToBytes(OWN_PRIV) });
}

interface MintCall {
  transferId: string | undefined;
  recipient: string;
  data: string;
  salt: string;
  tokenType: string;
}

/**
 * The aggregator's view of a data-token mint: one salt is one token id, so a
 * re-call under a certified salt RECOVERS that token, and other bytes under it
 * are a conflict. `failNext` certifies, then dies before returning.
 */
class DetNftEngine extends RealizationEngine {
  readonly mintCalls: MintCall[] = [];
  failNext = false;
  private readonly certified = new Map<string, { data: string; token: SphereToken }>();

  constructor() {
    super({ chainPubkey: hexToBytes(OWN_PUB), privateKey: hexToBytes(OWN_PRIV) });
  }

  get certifiedCount(): number {
    return this.certified.size;
  }

  override async mintDataToken(params: MintDataTokenParams, options?: EngineOpOptions): Promise<SphereToken> {
    const call: MintCall = {
      transferId: options?.transferId,
      recipient: bytesToHex(params.recipientPubkey),
      data: bytesToHex(params.data),
      salt: bytesToHex(params.salt ?? new Uint8Array(0)),
      tokenType: bytesToHex(params.tokenType ?? new Uint8Array(0)),
    };
    this.mintCalls.push(call);
    let leaf = this.certified.get(call.salt);
    if (leaf === undefined) {
      leaf = { data: call.data, token: await super.mintDataToken(params, options) };
      this.certified.set(call.salt, leaf);
    } else if (leaf.data !== call.data) {
      throw new Error('TRANSACTION_HASH_MISMATCH (simulated): other bytes under a certified salt');
    }
    if (this.failNext) {
      this.failNext = false;
      throw new ProofUnconfirmedError('proof fetch inconclusive after certify (simulated)');
    }
    return leaf.token;
  }
}

function countApplies(world: World, counter: { applies: number }): void {
  world.hooks.applyDelta = async () => {
    counter.applies += 1;
  };
}

async function nftJournal(world: World): Promise<NftMintJournalEntry[]> {
  return createMachineStores(world.kv).nftMintJournal.list();
}

async function waitForCoinless(world: World, tokenId: string | undefined): Promise<void> {
  await vi.waitFor(() => {
    expect(world.facade.coinless().map((row) => row.tokenId)).toContain(tokenId);
  });
}

describe('PaymentsFacade — mintNft (#785)', () => {
  it('mints a signed NFT to the wallet: a coinless row, a valid reading by this wallet, a MINT record naming no coin', async () => {
    const world = makeWorld({ engine: keyedEngine() });
    await world.facade.start();
    await flushTail();
    const updatesBefore = eventsOf(world, 'inventory:updated').length;

    const result = await world.facade.mintNft({ content: METADATA });

    expect(result).toEqual({ success: true, tokenId: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const tokenId = result.tokenId!;
    await waitForCoinless(world, tokenId);
    expect(world.facade.tokens()).toEqual([]);
    expect(eventsOf(world, 'inventory:updated').length).toBeGreaterThan(updatesBefore);
    await expect(world.facade.nft(tokenId)).resolves.toEqual({
      tokenId,
      content: METADATA,
      creator: OWN_PUB,
      signature: 'valid',
    });
    const history = await world.api.listHistory(ownCaller);
    expect(history.records.filter((r) => r.type === 'MINT')).toEqual([
      expect.objectContaining({ tokenId, assets: [] }),
    ]);
    expect(await nftJournal(world)).toEqual([]);
  });

  it('sign: false mints an unsigned NFT — no creator is claimed', async () => {
    const world = makeWorld({ engine: keyedEngine() });
    await world.facade.start();

    const result = await world.facade.mintNft({ content: IMAGE, sign: false });

    expect(result.success).toBe(true);
    await waitForCoinless(world, result.tokenId);
    await expect(world.facade.nft(result.tokenId!)).resolves.toEqual({
      tokenId: result.tokenId,
      content: IMAGE,
      creator: null,
      signature: 'unsigned',
    });
  });

  it('refuses invalid content before anything is journaled or minted', async () => {
    const world = makeWorld({ engine: keyedEngine() });
    await world.facade.start();
    const mintSpy = vi.spyOn(world.engine, 'mintDataToken');

    const result = await world.facade.mintNft({ content: { ...METADATA, name: '' } });

    expect(result.success).toBe(false);
    expect(result.tokenId).toBeUndefined();
    expect(result.error).toMatch(/name/);
    expect(world.kv.sets.filter((s) => s.key === STORE_KEYS.nftMintJournal)).toEqual([]);
    expect(await nftJournal(world)).toEqual([]);
    expect(mintSpy).not.toHaveBeenCalled();
  });

  it('refuses a payload over NFT_MAX_PAYLOAD_BYTES before anything is journaled or minted', async () => {
    // wallet-api refuses an oversize blob only at upload, AFTER certification: no replay could store it.
    const world = makeWorld({ engine: keyedEngine() });
    await world.facade.start();
    const mintSpy = vi.spyOn(world.engine, 'mintDataToken');
    const oversize: NftMedia = { kind: 'media', media_type: 'video/mp4', bytes: new Uint8Array(NFT_MAX_PAYLOAD_BYTES) };

    const result = await world.facade.mintNft({ content: oversize, sign: false });

    expect(NFT_MAX_PAYLOAD_BYTES).toBe(1024 * 1024); // the documented limit
    expect(result.success).toBe(false);
    expect(result.tokenId).toBeUndefined();
    expect(result.error).toMatch(/over the 1048576-byte limit: link large files with NftLink/);
    expect(world.kv.sets.filter((s) => s.key === STORE_KEYS.nftMintJournal)).toEqual([]);
    expect(mintSpy).not.toHaveBeenCalled();
  });

  it('counts the NftSigned wrapper: a signed payload of exactly the limit mints, one byte more does not', async () => {
    const world = makeWorld({ engine: keyedEngine() });
    await world.facade.start();
    const mintSpy = vi.spyOn(world.engine, 'mintDataToken');
    // The unsigned item's head at a 4-byte length, inside the 107-byte NftSigned wrapper.
    const head = encodeNftContent({ ...IMAGE, bytes: new Uint8Array(65_536) }).length - 65_536;
    const fill = NFT_MAX_PAYLOAD_BYTES - 107 - head;

    const atLimit = await world.facade.mintNft({ content: { ...IMAGE, bytes: new Uint8Array(fill) } });
    const over = await world.facade.mintNft({ content: { ...IMAGE, bytes: new Uint8Array(fill + 1) } });

    expect(atLimit.success).toBe(true);
    expect(mintSpy).toHaveBeenCalledTimes(1);
    expect(mintSpy.mock.calls[0][0].data).toHaveLength(NFT_MAX_PAYLOAD_BYTES);
    expect(over.success).toBe(false);
    expect(over.error).toContain(`${String(NFT_MAX_PAYLOAD_BYTES + 1)} bytes, over the`);
    expect(await nftJournal(world)).toEqual([]);
  }, 30_000);

  it('journals the plan BEFORE the chain op, holding exactly the bytes the engine is then asked to mint', async () => {
    const world = makeWorld({ engine: keyedEngine() });
    await world.facade.start();
    const order: string[] = [];
    const origSet = world.kv.set.bind(world.kv);
    world.kv.set = async (key, value) => {
      if (key === STORE_KEYS.nftMintJournal) order.push('journal-write');
      await origSet(key, value);
    };
    const journaledAtMint: NftMintJournalEntry[][] = [];
    const calls: { params: MintDataTokenParams; options: EngineOpOptions | undefined }[] = [];
    const real = world.engine.mintDataToken.bind(world.engine);
    vi.spyOn(world.engine, 'mintDataToken').mockImplementation(async (params, options) => {
      order.push('engine-mint');
      journaledAtMint.push(await nftJournal(world));
      calls.push({ params, options });
      return real(params, options);
    });

    const result = await world.facade.mintNft({ content: METADATA });

    expect(result.success).toBe(true);
    expect(order[0]).toBe('journal-write');
    expect(order.indexOf('journal-write')).toBeLessThan(order.indexOf('engine-mint'));
    expect(calls).toHaveLength(1);
    const [{ params, options }] = calls;
    expect(journaledAtMint[0]).toEqual([
      {
        mintId: options?.transferId,
        tokenId: result.tokenId,
        dataHex: bytesToHex(params.data),
        saltHex: bytesToHex(params.salt!),
        tokenTypeHex: VESSEL,
        createdAt: expect.any(Number),
      },
    ]);
    expect(bytesToHex(params.recipientPubkey)).toBe(OWN_PUB);
    expect(await nftJournal(world)).toEqual([]);
  });

  it('never finalises a token the plan did not name: the entry stays journaled and nothing is applied', async () => {
    const world = makeWorld({ engine: keyedEngine() });
    await world.facade.start();
    const counter = { applies: 0 };
    countApplies(world, counter);
    const real = world.engine.mintDataToken.bind(world.engine);
    vi.spyOn(world.engine, 'mintDataToken').mockImplementation((params, options) =>
      real({ ...params, salt: new Uint8Array(32).fill(9) }, options)
    );

    const result = await world.facade.mintNft({ content: IMAGE, sign: false });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/plan names/);
    expect(counter.applies).toBe(0);
    expect(await nftJournal(world)).toHaveLength(1);
  });
});

describe('PaymentsFacade — NFT mint journal replay (#785)', () => {
  it('a mint that certified but died is replayed after a restart with the SAME journaled bytes — one token, one apply, one MINT record', async () => {
    const det = new DetNftEngine();
    const world = makeWorld({ engine: det });
    const counter = { applies: 0 };
    countApplies(world, counter);
    await world.facade.start();

    det.failNext = true;
    const first = await world.facade.mintNft({ content: METADATA });
    expect(first.success).toBe(false);
    expect(first.tokenId).toMatch(/^[0-9a-f]{64}$/);
    expect(await nftJournal(world)).toHaveLength(1);
    expect(counter.applies).toBe(0);
    await world.facade.stop(); // the process dies

    const restarted = makeWorld({ restartOf: world });
    countApplies(restarted, counter);
    await restarted.facade.start();
    await vi.waitFor(async () => {
      expect(await nftJournal(restarted)).toEqual([]);
    });

    expect(det.mintCalls).toHaveLength(2);
    expect(det.mintCalls[1]).toEqual(det.mintCalls[0]);
    expect(det.mintCalls[0]).toMatchObject({ recipient: OWN_PUB, tokenType: VESSEL });
    expect(det.certifiedCount).toBe(1);
    expect(counter.applies).toBe(1);
    await waitForCoinless(restarted, first.tokenId);
    await expect(restarted.facade.nft(first.tokenId!)).resolves.toMatchObject({
      content: METADATA,
      creator: OWN_PUB,
      signature: 'valid',
    });
    const history = await restarted.api.listHistory(ownCaller);
    expect(history.records.filter((r) => r.type === 'MINT')).toEqual([
      expect.objectContaining({ tokenId: first.tokenId, assets: [] }),
    ]);

    await restarted.facade.stop();
    const again = makeWorld({ restartOf: restarted });
    countApplies(again, counter);
    await again.facade.start();
    await flushTail();
    expect(det.mintCalls).toHaveLength(2); // journal drained — the restart mints nothing
    expect(counter.applies).toBe(1);
  });

  it('a retained entry is heartbeat work and converges in-session, without a restart', async () => {
    const det = new DetNftEngine();
    const world = makeWorld({ engine: det });
    await world.facade.start();
    await flushTail();
    const stores = createMachineStores(world.kv);
    const converger = new Converger({ stores } as unknown as ConvergerDeps);

    det.failNext = true;
    const first = await world.facade.mintNft({ content: IMAGE, sign: false });
    expect(first.success).toBe(false);
    expect(await converger.pendingWork()).toBe(true);

    await world.facade.resumeNow();

    expect(await stores.nftMintJournal.list()).toEqual([]);
    expect(await converger.pendingWork()).toBe(false);
    expect(det.mintCalls).toHaveLength(2);
    expect(det.certifiedCount).toBe(1);
    await waitForCoinless(world, first.tokenId);
  });

  it('an unreadable coin mint journal does not starve the NFT replay', async () => {
    const det = new DetNftEngine();
    const world = makeWorld({ engine: det });
    await world.facade.start();
    await flushTail();
    det.failNext = true;
    const first = await world.facade.mintNft({ content: IMAGE, sign: false });
    expect(first.success).toBe(false);
    world.kv.failKeys.add(STORE_KEYS.mintJournal);

    await world.facade.resumeNow();

    expect(await nftJournal(world)).toEqual([]);
    expect(det.certifiedCount).toBe(1);
    await waitForCoinless(world, first.tokenId);
  });

  it('replay clears an entry whose token is already active server-side, without minting again', async () => {
    const world = makeWorld({ engine: keyedEngine() });
    const payload = encodeNftContent(IMAGE);
    const already = await world.seedCoinless(payload);
    const entry: NftMintJournalEntry = {
      mintId: 'nft-done',
      tokenId: already.blob.tokenId,
      dataHex: bytesToHex(payload),
      saltHex: '00'.repeat(32),
      tokenTypeHex: VESSEL,
      createdAt: 1,
    };
    await world.kv.set(STORE_KEYS.nftMintJournal, [entry]);
    const mintSpy = vi.spyOn(world.engine, 'mintDataToken');

    await world.facade.start();
    await vi.waitFor(async () => {
      expect(await nftJournal(world)).toEqual([]);
    });

    expect(mintSpy).not.toHaveBeenCalled();
  });

  it('keeps the coin mint journal separate: a coin replay never reads an NFT entry', async () => {
    const world = makeWorld({ engine: keyedEngine() });
    await world.facade.start();
    const result = await world.facade.mintNft({ content: IMAGE, sign: false });

    expect(result.success).toBe(true);
    expect(world.kv.sets.some((s) => s.key === STORE_KEYS.nftMintJournal)).toBe(true);
    expect(world.kv.sets.some((s) => s.key === STORE_KEYS.mintJournal)).toBe(false);
  });
});

describe('PaymentsFacade — nft() / nfts() (#785)', () => {
  it('nfts() returns only held NFTs, fetching blobs once and serving a repeat from the cache', async () => {
    const world = makeWorld({ engine: keyedEngine() });
    const coin = await world.seed(10n);
    const kitty = await world.seedCoinless(); // coinless, but its payload is not an NFT
    const media = await world.seedCoinless(encodeNftContent(IMAGE));
    await world.facade.start();
    const minted = await world.facade.mintNft({ content: METADATA });
    const mintedId = minted.tokenId!;
    await waitForCoinless(world, mintedId);
    const fetches: string[][] = [];
    world.hooks.getBlobs = async (ids) => {
      fetches.push([...ids]);
    };
    const unheld = 'ff'.repeat(32);
    const ids = [unheld, coin.blob.tokenId, kitty.blob.tokenId, media.blob.tokenId, mintedId];

    const first = await world.facade.nfts(ids);

    expect([...first.keys()]).toEqual([media.blob.tokenId, mintedId]);
    expect(first.get(media.blob.tokenId)).toEqual({
      tokenId: media.blob.tokenId,
      content: IMAGE,
      creator: null,
      signature: 'unsigned',
    });
    expect(first.get(mintedId)).toEqual({ tokenId: mintedId, content: METADATA, creator: OWN_PUB, signature: 'valid' });
    expect(fetches).toHaveLength(1);
    expect([...fetches[0]].sort()).toEqual([coin.blob.tokenId, kitty.blob.tokenId, media.blob.tokenId, mintedId].sort());

    const second = await world.facade.nfts(ids);

    expect(second).toEqual(first);
    await expect(world.facade.nft(coin.blob.tokenId)).resolves.toBeNull();
    await expect(world.facade.nft(kitty.blob.tokenId)).resolves.toBeNull();
    await expect(world.facade.nft(mintedId)).resolves.toEqual(first.get(mintedId));
    expect(fetches).toHaveLength(1); // "not an NFT" is cached too
  });

  it('nft() of a token the wallet does not hold throws VALIDATION_ERROR, without fetching', async () => {
    const world = makeWorld({ engine: keyedEngine() });
    await world.facade.start();
    const fetch = vi.fn(async () => undefined);
    world.hooks.getBlobs = fetch;

    const err = await world.facade.nft('ff'.repeat(32)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SphereError);
    expect((err as SphereError).code).toBe('VALIDATION_ERROR');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a cached reading does not outlive the holding: once the NFT is sent away it is refused', async () => {
    const world = makeWorld({ engine: keyedEngine() });
    const media = await world.seedCoinless(encodeNftContent(IMAGE));
    await world.facade.start();
    await expect(world.facade.nft(media.blob.tokenId)).resolves.toMatchObject({ signature: 'unsigned' });

    await world.facade.sendCoinless({ recipient: '@peer', tokenId: media.blob.tokenId });
    await vi.waitFor(() => {
      expect(world.facade.coinless()).toEqual([]);
    });

    await expect(world.facade.nft(media.blob.tokenId)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect((await world.facade.nfts([media.blob.tokenId])).size).toBe(0);
  });

  it('a blob that does not decode is absent from nfts() and NOT cached — the next read tries again', async () => {
    const world = makeWorld({ engine: keyedEngine() });
    const media = await world.seedCoinless(encodeNftContent(IMAGE));
    await world.facade.start();
    const fetches: string[][] = [];
    world.hooks.getBlobs = async (ids) => {
      fetches.push([...ids]);
    };
    vi.spyOn(world.engine, 'decodeToken').mockRejectedValueOnce(new Error('corrupt blob (simulated)'));

    expect((await world.facade.nfts([media.blob.tokenId])).size).toBe(0);
    const second = await world.facade.nfts([media.blob.tokenId]);

    expect(second.get(media.blob.tokenId)).toMatchObject({ content: IMAGE, signature: 'unsigned' });
    expect(fetches).toHaveLength(2);
  });

  it('reports the creator a forged NftSigned CLAIMS, with signature invalid', async () => {
    // Anyone can name another wallet's key over junk signature bytes: creator alone attributes nothing.
    const world = makeWorld({ engine: keyedEngine() });
    const forged = encodeNftSigned(hexToBytes(PEER_PUB), encodeNftContent(IMAGE), new Uint8Array(65).fill(1));
    const token = await world.seedCoinless(forged);
    await world.facade.start();

    await expect(world.facade.nft(token.blob.tokenId)).resolves.toEqual({
      tokenId: token.blob.tokenId,
      content: IMAGE,
      creator: PEER_PUB,
      signature: 'invalid',
    });
  });

  it('nfts() reads more held NFTs than one blob-urls request may name', async () => {
    // FakeWalletApi refuses a blob-urls request over its PAGE_LIMIT (100 by default), as wallet-api does.
    const world = makeWorld({ engine: keyedEngine() });
    const ids: string[] = [];
    for (let i = 0; i < 250; i++) ids.push((await world.seedCoinless(encodeNftContent(IMAGE))).blob.tokenId);
    await world.facade.start();

    const views = await world.facade.nfts(ids);

    expect(new Set(ids).size).toBe(250);
    expect(views.size).toBe(ids.length);
    expect(views.get(ids[249])).toEqual({ tokenId: ids[249], content: IMAGE, creator: null, signature: 'unsigned' });
  });
});

describe('NftCache', () => {
  const view = (tokenId: string): NftView => ({ tokenId, content: IMAGE, creator: null, signature: 'unsigned' });

  it('evicts the least recently used entry past its bound — a read counts as use', () => {
    const cache = new NftCache(2);
    cache.set('a', view('a'));
    cache.set('b', null);
    expect(cache.get('a')).toEqual(view('a'));

    cache.set('c', view('c'));

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toEqual(view('a'));
    expect(cache.get('c')).toEqual(view('c'));
  });

  it('holds 256 entries by default', () => {
    const cache = new NftCache();
    for (let i = 0; i <= 256; i++) cache.set(`t${String(i)}`, null);

    expect(cache.get('t0')).toBeUndefined();
    expect(cache.get('t1')).toBeNull();
    expect(cache.get('t256')).toBeNull();
  });
});
