import { afterEach, describe, expect, it, vi } from 'vitest';

import { hexToBytes } from '../../../core/crypto';
import { SphereError } from '../../../core/errors';
import { VERDICT_RETRY_MS } from '../../../modules/payments-v2/inventory/verdicts';
import { CoinClaims } from '../../../token-engine/claims';
import { TokenType } from '../../../token-engine/sdk';
import { SpherePaymentData } from '../../../token-engine/SpherePaymentData';
import type { SphereToken } from '../../../token-engine/types';
import { cleanupWorlds, eventsOf, makeWorld, OWN_PUB, type World } from './facade-harness';

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

async function minted(world: World, tokenType: string, salt: number): Promise<SphereToken> {
  return world.engine.mintDataToken({
    recipientPubkey: hexToBytes(OWN_PUB),
    data: await SpherePaymentData.fromValue({ assets: [{ coinId: CLAIMED, amount: 10n }] }).encode(),
    tokenType: hexBytes(tokenType),
    salt: new Uint8Array(32).fill(salt),
    justification: REASON,
  });
}

async function holdings(world: World): Promise<[string, string | null][]> {
  return (await world.facade.assets(CLAIMED)).map((a) => [a.totalAmount, a.unverified ?? null]);
}

afterEach(cleanupWorlds);

describe('PaymentsFacade — claimed coins', () => {
  it('counts a held token of a claimed coin once it verifies, and keeps a look-alike of another type apart', async () => {
    const world = makeWorld({ claims: claims() });
    await world.hold(await minted(world, BRIDGED_TYPE, 1));
    await world.hold(await minted(world, OTHER_TYPE, 2));

    await world.facade.start();

    await vi.waitFor(async () => expect(await holdings(world)).toEqual([['10', null], ['10', 'refused']]));
    expect(eventsOf(world, 'inventory:updated').length).toBeGreaterThan(0);
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

    expect(transfers.flatMap((t) => t.tokens.map((token) => token.unverified ?? 'verified')).sort()).toEqual(['refused', 'verified']);
    await vi.waitFor(async () => expect(await holdings(world)).toEqual([['10', null], ['10', 'refused']]));
    expect(verify).toHaveBeenCalledTimes(2);
  });
});
