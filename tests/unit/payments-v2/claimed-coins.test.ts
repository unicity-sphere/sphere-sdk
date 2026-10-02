import { afterEach, describe, expect, it, vi } from 'vitest';

import { STORAGE_KEYS_GLOBAL } from '../../../constants';
import { hexToBytes } from '../../../core/crypto';
import { SphereError } from '../../../core/errors';
import { logger } from '../../../core/logger';
import { VERDICT_RETRY_MS } from '../../../modules/payments-v2/inventory/verdicts';
import type { PriceReader } from '../../../modules/payments-v2/inventory/presentation';
import { TokenRegistry } from '../../../registry';
import type { StorageProvider } from '../../../storage';
import { CoinClaims } from '../../../token-engine/claims';
import { TokenType } from '../../../token-engine/sdk';
import { SpherePaymentData } from '../../../token-engine/SpherePaymentData';
import type { SphereToken } from '../../../token-engine/types';
import { cleanupWorlds, COIN, eventsOf, makeWorld, OWN_PUB, type World } from './facade-harness';

const CLAIMED = 'bb'.repeat(32);
const BRIDGED_TYPE = '6f'.repeat(32);
const OTHER_TYPE = '70'.repeat(32);
const REASON = new Uint8Array([0xc0, 0x01]);

function claims(): CoinClaims {
  const claimed = new CoinClaims();
  claimed.add({ tokenType: new TokenType(hexBytes(BRIDGED_TYPE)), coinIds: [CLAIMED], verify: vi.fn() });
  return claimed;
}

function hexBytes(hex: string): Uint8Array {
  return hexToBytes(hex);
}

async function minted(
  world: World,
  tokenType: string,
  salt: number,
  options: { coinId?: string; justification?: Uint8Array | null } = {}
): Promise<SphereToken> {
  const justification = options.justification === undefined ? REASON : options.justification;
  return world.engine.mintDataToken({
    recipientPubkey: hexToBytes(OWN_PUB),
    data: await SpherePaymentData.fromValue({ assets: [{ coinId: options.coinId ?? CLAIMED, amount: 10n }] }).encode(),
    tokenType: hexBytes(tokenType),
    salt: new Uint8Array(32).fill(salt),
    ...(justification !== null ? { justification } : {}),
  });
}

async function holdings(world: World, coinId = CLAIMED): Promise<[string, string | null][]> {
  const shown = [...(await world.facade.assets(coinId)), ...(await world.facade.unverifiedAssets(coinId))];
  return shown.map((a) => [a.totalAmount, a.unverified ?? null]);
}

// The testnet2 registry entry of unicitynetwork/unicity-ids#10: bridged Sepolia USDC.
const USDC_E = 'eae954053183b9d1836d6b5c892867014bcc1571fcc6813f5b56b16a78d0497f';
const USDC_E_TYPE = '2ccbf3157add2b9a2dcc10e772abf5cf328e2723f9f290a9d2b6c4a42a132d6c';
const USDC_E_ENTRY = {
  network: 'unicity:testnet2',
  assetKind: 'fungible',
  name: 'usd-coin-sepolia',
  symbol: 'USDC.e',
  decimals: 6,
  description: 'USDC bridged from Ethereum Sepolia to Unicity testnet v2',
  icons: [{ url: 'https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/32/icon/usdc.png' }],
  id: USDC_E,
  issuance: { tokenType: USDC_E_TYPE },
};
const NATIVE_ENTRY = { network: 'unicity:testnet2', assetKind: 'fungible', name: 'unicity', symbol: 'UCT', decimals: 0, description: 'native', id: COIN };
const { issuance: _unclaimed, ...USDC_E_UNCLAIMED } = USDC_E_ENTRY;
const REGISTRY_URL = 'https://registry.test/unicity-ids.testnet2.json';

const registries: TokenRegistry[] = [];

function cacheStorage(definitions: readonly object[] | null, readable: Promise<void>): StorageProvider {
  const store = new Map<string, string>();
  if (definitions !== null) {
    store.set(`${STORAGE_KEYS_GLOBAL.TOKEN_REGISTRY_CACHE}:${REGISTRY_URL}`, JSON.stringify(definitions));
    store.set(`${STORAGE_KEYS_GLOBAL.TOKEN_REGISTRY_CACHE_TS}:${REGISTRY_URL}`, String(Date.now()));
  }
  return {
    get: async (key: string) => {
      await readable;
      return store.get(key) ?? null;
    },
    set: async (key: string, value: string) => void store.set(key, value),
  } as unknown as StorageProvider;
}

/** An owned registry whose persistent cache holds `definitions` (null: no cache), never auto-refreshed. */
function registryFrom(definitions: readonly object[] | null, readable: Promise<void> = Promise.resolve()): TokenRegistry {
  const registry = TokenRegistry.create({ remoteUrl: REGISTRY_URL, storage: cacheStorage(definitions, readable), autoRefresh: false });
  registries.push(registry);
  return registry;
}

/** A registry whose cache read waits until `release()`. */
function slowRegistryFrom(definitions: readonly object[]): { registry: TokenRegistry; release: () => void } {
  let release = (): void => undefined;
  const readable = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { registry: registryFrom(definitions, readable), release };
}

async function refresh(registry: TokenRegistry, definitions: readonly object[]): Promise<void> {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(definitions), { status: 200 }));
  expect(await registry.refreshFromRemote()).toBe(true);
  fetch.mockRestore();
}

/** Quotes every coin it is asked about at 1 USD. */
function anyPrice(): PriceReader & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    getPrices: async (names) => {
      asked.push(...names);
      return new Map(names.map((name) => [name, { priceUsd: 1 }]));
    },
  };
}

afterEach(async () => {
  await cleanupWorlds();
  for (const registry of registries.splice(0)) registry.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('PaymentsFacade — claimed coins', () => {
  it('counts a held token of a claimed coin once it verifies, and keeps a look-alike of another type apart', async () => {
    const world = makeWorld({ claims: claims() });
    await world.hold(await minted(world, BRIDGED_TYPE, 1));
    await world.hold(await minted(world, OTHER_TYPE, 2));

    await world.facade.start();

    await vi.waitFor(async () => expect(await holdings(world)).toEqual([['10', null], ['10', 'refused']]));
    expect(eventsOf(world, 'inventory:updated').length).toBeGreaterThan(0);
  });

  it('lists only verified holdings in assets() and tokens(), and the others in unverifiedAssets() and unverifiedTokens()', async () => {
    const world = makeWorld({ claims: claims() });
    const bridged = await minted(world, BRIDGED_TYPE, 1);
    const lookalike = await minted(world, OTHER_TYPE, 2);
    await world.hold(bridged);
    await world.hold(lookalike);
    await world.facade.start();
    await vi.waitFor(async () => expect(await holdings(world)).toEqual([['10', null], ['10', 'refused']]));

    expect((await world.facade.assets(CLAIMED)).map((a) => a.unverified ?? null)).toEqual([null]);
    expect((await world.facade.unverifiedAssets(CLAIMED)).map((a) => a.unverified)).toEqual(['refused']);
    expect(world.facade.tokens({ coinId: CLAIMED }).map((t) => t.id)).toEqual([bridged.blob.tokenId]);
    expect(world.facade.unverifiedTokens({ coinId: CLAIMED }).map((t) => t.id)).toEqual([lookalike.blob.tokenId]);
  });

  it('refuses to spend a token of a claimed coin that failed verification', async () => {
    const world = makeWorld({ claims: claims() });
    const counterfeit = await minted(world, BRIDGED_TYPE, 1);
    await world.hold(counterfeit);
    const verify = vi.spyOn(world.engine, 'verify').mockResolvedValue({ ok: false, reason: 'FAIL' });
    await world.facade.start();
    await vi.waitFor(() => expect(verify).toHaveBeenCalled());

    const send = world.facade.send({ recipient: '@peer', amount: '10', coinId: CLAIMED });

    await expect(send).rejects.toBeInstanceOf(SphereError);
    await expect(send).rejects.toMatchObject({ code: 'SEND_INSUFFICIENT_BALANCE' });
    expect(await holdings(world)).toEqual([['10', 'refused']]);
  });

  it('trusts a custom mint of the issuing type at once, without checking the held token again', async () => {
    const world = makeWorld({ claims: claims() });
    await world.facade.start();
    const verify = vi.spyOn(world.engine, 'verify');

    const result = await world.facade.mintCustom({
      tokenType: hexBytes(BRIDGED_TYPE),
      salt: new Uint8Array(32).fill(9),
      data: await SpherePaymentData.fromValue({ assets: [{ coinId: CLAIMED, amount: 10n }] }).encode(),
      justification: REASON,
      assets: [{ coinId: CLAIMED, amount: 10n }],
    });

    expect(result.success).toBe(true);
    await vi.waitFor(async () => expect(await holdings(world)).toEqual([['10', null]]));
    expect(verify).not.toHaveBeenCalled();
  });

  it('keeps a custom mint accepted only by its own per-call verifier pending until the registered verifier passes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const world = makeWorld({ claims: claims() });
    await world.facade.start();
    const verify = vi
      .spyOn(world.engine, 'verify')
      .mockRejectedValueOnce(new SphereError('lock short of its confirmations', 'MINT_REASON_UNVERIFIABLE'))
      .mockResolvedValue({ ok: true });

    const result = await world.facade.mintCustom({
      tokenType: hexBytes(BRIDGED_TYPE),
      salt: new Uint8Array(32).fill(8),
      data: await SpherePaymentData.fromValue({ assets: [{ coinId: CLAIMED, amount: 10n }] }).encode(),
      justification: REASON,
      assets: [{ coinId: CLAIMED, amount: 10n }],
      mintJustificationVerifiers: [{ tag: 49152n, verify: vi.fn() }],
    });

    expect(result.success).toBe(true);
    await vi.waitFor(async () => expect(await holdings(world)).toEqual([['10', 'pending']]));
    const tokenId = result.tokenId!;
    await expect(world.facade.send({ recipient: '@peer', amount: '10', coinId: CLAIMED })).rejects.toMatchObject({
      code: 'SEND_INSUFFICIENT_BALANCE',
    });
    await expect(world.facade.sendWholeToken({ recipient: '@peer', tokenId })).rejects.toThrow(/not a spendable holding/);
    expect(await world.facade.burn({ tokenId, reasonBytes: new Uint8Array([1]) })).toMatchObject({ success: false });
    await vi.advanceTimersByTimeAsync(VERDICT_RETRY_MS);
    await vi.waitFor(async () => expect(await holdings(world)).toEqual([['10', null]]));
    expect(verify).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('keeps the change of a verified token trusted after a send, without checking it again', async () => {
    const world = makeWorld({ claims: claims() });
    await world.hold(await minted(world, BRIDGED_TYPE, 1));
    await world.facade.start();
    await vi.waitFor(async () => expect(await holdings(world)).toEqual([['10', null]]));
    const verify = vi.spyOn(world.engine, 'verify');

    await world.facade.send({ recipient: '@peer', amount: '4', coinId: CLAIMED });

    await vi.waitFor(async () => expect(await holdings(world)).toEqual([['6', null]]));
    expect(verify).not.toHaveBeenCalled();
  });

  it('announces a received look-alike as unverified and a received token of the issuing type as verified', async () => {
    const world = makeWorld({ claims: claims() });
    await world.facade.start();
    const verify = vi.spyOn(world.engine, 'verify');
    await world.peerDeliver(await minted(world, OTHER_TYPE, 1), 'in-1');
    await world.peerDeliver(await minted(world, BRIDGED_TYPE, 2), 'in-2');

    const { transfers } = await world.facade.receive();

    const announced = transfers.map((t) => [t.tokens.map((x) => x.unverified ?? 'verified'), (t.unverifiedTokens ?? []).map((x) => x.unverified)]);
    expect(announced.sort()).toEqual([
      [[], ['refused']],
      [['verified'], []],
    ]);
    await vi.waitFor(async () => expect(await holdings(world)).toEqual([['10', null], ['10', 'refused']]));
    expect(verify).toHaveBeenCalledTimes(2);
    const received = (await world.facade.history()).entries.filter((e) => e.type === 'RECEIVED' && e.coinId === CLAIMED);
    expect(received.map((e) => e.amount)).toEqual(['10']);
  });
});

describe('PaymentsFacade — coins the token registry claims (#833)', () => {
  it('without the plugin, refuses a look-alike of another type and keeps a token of the issuing type pending, out of every balance', async () => {
    const world = makeWorld({ registry: registryFrom([USDC_E_ENTRY]) });
    const issued = await minted(world, USDC_E_TYPE, 1, { coinId: USDC_E });
    const lookalike = await minted(world, OTHER_TYPE, 2, { coinId: USDC_E });
    await world.hold(issued);
    await world.hold(lookalike);

    await world.facade.start();

    await vi.waitFor(async () => expect(await holdings(world, USDC_E)).toEqual([['10', 'pending'], ['10', 'refused']]));
    expect(await world.facade.assets()).toEqual([]);
    expect(world.facade.tokens()).toEqual([]);
    expect(world.facade.unverifiedTokens({ coinId: USDC_E }).map((t) => [t.id, t.unverified])).toEqual([
      [issued.blob.tokenId, 'pending'],
      [lookalike.blob.tokenId, 'refused'],
    ]);
  });

  it('never trusts a token of the issuing type minted with no reason: verify passes without a policy, so it stays pending, unspent and unpriced', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const price = anyPrice();
    const world = makeWorld({ registry: registryFrom([USDC_E_ENTRY, NATIVE_ENTRY]), price });
    const squat = await minted(world, USDC_E_TYPE, 1, { coinId: USDC_E, justification: null });
    await world.hold(squat);
    await world.seed(5n);
    const verify = vi.spyOn(world.engine, 'verify').mockResolvedValue({ ok: true });
    const decode = vi.spyOn(world.engine, 'decodeToken');
    const judged = (): number => decode.mock.calls.filter(([blob]) => blob.tokenId === squat.blob.tokenId).length;

    await world.facade.start();
    await vi.waitFor(() => expect(judged()).toBe(1));
    await vi.advanceTimersByTimeAsync(VERDICT_RETRY_MS * 4);

    expect(judged()).toBe(1);
    expect(verify.mock.calls.filter(([token]) => token.blob.tokenId === squat.blob.tokenId)).toEqual([]);
    expect(await holdings(world, USDC_E)).toEqual([['10', 'pending']]);
    expect(world.facade.tokens({ coinId: USDC_E })).toEqual([]);
    expect(world.facade.unverifiedTokens({ coinId: USDC_E }).map((t) => [t.id, t.unverified])).toEqual([[squat.blob.tokenId, 'pending']]);
    expect((await world.facade.unverifiedAssets(USDC_E)).map((a) => [a.symbol, a.priceUsd, a.fiatValueUsd])).toEqual([['USDC.e', null, null]]);
    expect((await world.facade.assets()).map((a) => [a.symbol, a.priceUsd])).toEqual([['UCT', 1]]);
    expect(price.asked).not.toContain('usd-coin-sepolia');
    await expect(world.facade.send({ recipient: '@peer', amount: '10', coinId: USDC_E })).rejects.toMatchObject({
      code: 'SEND_INSUFFICIENT_BALANCE',
    });
    await expect(world.facade.sendWholeToken({ recipient: '@peer', tokenId: squat.blob.tokenId })).rejects.toThrow(/not a spendable holding/);
    expect(await world.facade.burn({ tokenId: squat.blob.tokenId, reasonBytes: new Uint8Array([1]) })).toMatchObject({ success: false });
  });

  it('receives a token of the issuing type as pending when no plugin can verify it, and records no receipt of the coin', async () => {
    const world = makeWorld({ registry: registryFrom([USDC_E_ENTRY]) });
    await world.facade.start();
    await world.peerDeliver(await minted(world, USDC_E_TYPE, 1, { coinId: USDC_E, justification: null }), 'in-1');
    await world.peerDeliver(await minted(world, OTHER_TYPE, 2, { coinId: USDC_E }), 'in-2');

    const { transfers } = await world.facade.receive();

    const announced = transfers.map((t) => [t.tokens.length, (t.unverifiedTokens ?? []).map((x) => x.unverified)]);
    expect(announced.sort()).toEqual([
      [0, ['pending']],
      [0, ['refused']],
    ]);
    await vi.waitFor(async () => expect((await holdings(world, USDC_E)).sort()).toEqual([['10', 'pending'], ['10', 'refused']]));
    const received = (await world.facade.history()).entries.filter((e) => e.type === 'RECEIVED' && e.coinId === USDC_E);
    expect(received).toEqual([]);
  });

  it('keeps a custom mint of the issuing type pending when no plugin can verify it', async () => {
    const world = makeWorld({ registry: registryFrom([USDC_E_ENTRY]) });
    await world.facade.start();

    const result = await world.facade.mintCustom({
      tokenType: hexBytes(USDC_E_TYPE),
      salt: new Uint8Array(32).fill(9),
      data: await SpherePaymentData.fromValue({ assets: [{ coinId: USDC_E, amount: 10n }] }).encode(),
      justification: REASON,
      assets: [{ coinId: USDC_E, amount: 10n }],
    });

    expect(result.success).toBe(true);
    await vi.waitFor(async () => expect(await holdings(world, USDC_E)).toEqual([['10', 'pending']]));
    await expect(world.facade.send({ recipient: '@peer', amount: '4', coinId: USDC_E })).rejects.toMatchObject({
      code: 'SEND_INSUFFICIENT_BALANCE',
    });
  });

  it('with the plugin loaded, an agreeing registry claim changes nothing: verdicts remembered without it still hold', async () => {
    const plugin = (): CoinClaims => {
      const claimed = new CoinClaims();
      claimed.add({ tokenType: new TokenType(hexBytes(USDC_E_TYPE)), coinIds: [USDC_E], verify: vi.fn() });
      return claimed;
    };
    const first = makeWorld({ claims: plugin() });
    await first.hold(await minted(first, USDC_E_TYPE, 1, { coinId: USDC_E }));
    await first.facade.start();
    await vi.waitFor(async () => expect(await holdings(first, USDC_E)).toEqual([['10', null]]));
    await first.facade.stop();

    const restarted = makeWorld({ restartOf: first, claims: plugin(), registry: registryFrom([USDC_E_ENTRY]) });
    const verify = vi.spyOn(restarted.engine, 'verify');
    await restarted.facade.start();

    await vi.waitFor(async () => expect(await holdings(restarted, USDC_E)).toEqual([['10', null]]));
    expect(verify).not.toHaveBeenCalled();
  });

  it('keeps the plugin claim when the registry names another issuing type, and logs the conflict once', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const conflicting = [{ ...USDC_E_ENTRY, id: CLAIMED }];
    const registry = registryFrom(conflicting);
    const world = makeWorld({ claims: claims(), registry });
    const bridged = await minted(world, BRIDGED_TYPE, 1);
    await world.hold(bridged);
    await world.hold(await minted(world, USDC_E_TYPE, 2));

    await world.facade.start();
    await vi.waitFor(async () => expect(await holdings(world)).toEqual([['10', null], ['10', 'refused']]));
    await refresh(registry, conflicting);
    await world.facade.assets();

    expect(world.facade.tokens({ coinId: CLAIMED }).map((t) => t.id)).toEqual([bridged.blob.tokenId]);
    const conflicts = warn.mock.calls.filter(([, message]) => String(message).includes(`issuer of coin ${CLAIMED}`));
    expect(conflicts).toHaveLength(1);
    expect(String(conflicts[0]![1])).toContain(USDC_E_TYPE);
  });

  it('applies a cached registry claim from the first drain: a drain waits for the cache read, never for a fetch', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const { registry, release } = slowRegistryFrom([USDC_E_ENTRY]);
    const world = makeWorld({ registry });
    await world.peerDeliver(await minted(world, USDC_E_TYPE, 1, { coinId: USDC_E }), 'in-1');

    const drained = world.facade.receive();
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const { transfers } = await drained;

    expect(transfers.flatMap((t) => t.tokens)).toEqual([]);
    expect(transfers.flatMap((t) => (t.unverifiedTokens ?? []).map((x) => x.unverified))).toEqual(['pending']);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads the registry cache before the remembered verdicts, so a restart keeps them when the registry claims other coins', async () => {
    const plugin = claims();
    const first = makeWorld({ claims: plugin, registry: registryFrom([USDC_E_ENTRY]) });
    await first.hold(await minted(first, BRIDGED_TYPE, 1));
    await first.facade.start();
    await vi.waitFor(async () => expect(await holdings(first)).toEqual([['10', null]]));
    await first.facade.stop();

    const { registry, release } = slowRegistryFrom([USDC_E_ENTRY]);
    const restarted = makeWorld({ restartOf: first, claims: claims(), registry });
    const verify = vi.spyOn(restarted.engine, 'verify');
    const started = restarted.facade.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await started;

    await vi.waitFor(async () => expect(await holdings(restarted)).toEqual([['10', null]]));
    expect(verify).not.toHaveBeenCalled();
  });

  it('re-judges held tokens when the registry loads or refreshes after start, and tells readers', async () => {
    const registry = registryFrom(null);
    const world = makeWorld({ registry });
    await world.hold(await minted(world, USDC_E_TYPE, 1, { coinId: USDC_E }));
    await world.hold(await minted(world, OTHER_TYPE, 2, { coinId: USDC_E }));
    await world.facade.start();
    await vi.waitFor(async () => expect(await holdings(world, USDC_E)).toEqual([['20', null]]));
    const before = eventsOf(world, 'inventory:updated').length;

    await refresh(registry, [USDC_E_ENTRY]);

    expect(eventsOf(world, 'inventory:updated').length).toBeGreaterThan(before);
    await vi.waitFor(async () => expect(await holdings(world, USDC_E)).toEqual([['10', 'pending'], ['10', 'refused']]));
    expect(await world.facade.assets(USDC_E)).toEqual([]);

    await refresh(registry, [USDC_E_UNCLAIMED]);

    await vi.waitFor(async () => expect(await holdings(world, USDC_E)).toEqual([['20', null]]));
  });

  it('a refresh that leaves the claims as they were judges nothing again', async () => {
    const registry = registryFrom([USDC_E_ENTRY]);
    const world = makeWorld({ registry });
    await world.hold(await minted(world, OTHER_TYPE, 1, { coinId: USDC_E }));
    await world.facade.start();
    await vi.waitFor(async () => expect(await holdings(world, USDC_E)).toEqual([['10', 'refused']]));
    const decode = vi.spyOn(world.engine, 'decodeToken');
    const before = eventsOf(world, 'inventory:updated').length;

    await refresh(registry, [{ ...USDC_E_ENTRY, description: 'reworded' }]);
    await world.facade.assets();

    expect(decode).not.toHaveBeenCalled();
    expect(eventsOf(world, 'inventory:updated').length).toBe(before);
  });
});
