import { afterEach, describe, expect, it, vi } from 'vitest';

import { bytesToHex, hexToBytes } from '../../../core/crypto';
import type { EngineOpOptions, MintDataTokenParams, SphereToken } from '../../../token-engine';
import { ProofUnconfirmedError } from '../../../token-engine/errors';
import { SpherePaymentData } from '../../../token-engine/SpherePaymentData';
import { createMachineStores } from '../../../modules/payments-v2/machine/journal';
import type { CustomMintJournalEntry } from '../../../modules/payments-v2/stores';
import { RealizationEngine } from './machine-harness';
import { COIN, OWN_PRIV, OWN_PUB, cleanupWorlds, flushTail, makeWorld, ownCaller, type World } from './facade-harness';

afterEach(cleanupWorlds);

const TOKEN_TYPE = hexToBytes('6f'.repeat(32));
const SALT = hexToBytes('a5'.repeat(32));
const JUSTIFICATION = new Uint8Array([0xda, 0x00, 0x14, 0x4b, 0x52, 0x81, 0x01]);
const AMOUNT = 1_000_000n;

class DetEngine extends RealizationEngine {
  readonly calls: { transferId?: string; data: string; salt: string; tokenType: string; justification: string | null }[] = [];
  failNext = false;
  private readonly certified = new Map<string, { data: string; token: SphereToken }>();

  constructor() {
    super({ chainPubkey: hexToBytes(OWN_PUB), privateKey: hexToBytes(OWN_PRIV) });
  }

  override async mintDataToken(params: MintDataTokenParams, options?: EngineOpOptions): Promise<SphereToken> {
    const call = {
      transferId: options?.transferId,
      data: bytesToHex(params.data),
      salt: bytesToHex(params.salt ?? new Uint8Array(0)),
      tokenType: bytesToHex(params.tokenType ?? new Uint8Array(0)),
      justification: params.justification ? bytesToHex(params.justification) : null,
    };
    this.calls.push(call);
    let leaf = this.certified.get(call.salt);
    if (leaf === undefined) {
      leaf = { data: call.data, token: await super.mintDataToken(params, options) };
      this.certified.set(call.salt, leaf);
    } else if (leaf.data !== call.data) {
      throw new Error('TRANSACTION_HASH_MISMATCH (simulated)');
    }
    if (this.failNext) {
      this.failNext = false;
      throw new ProofUnconfirmedError('proof fetch inconclusive after certify (simulated)');
    }
    return leaf.token;
  }
}

async function valuedPayload(): Promise<Uint8Array> {
  return SpherePaymentData.fromValue({ assets: [{ coinId: COIN, amount: AMOUNT }] }).encode();
}

async function journal(world: World): Promise<CustomMintJournalEntry[]> {
  return createMachineStores(world.kv).customMintJournal.list();
}

function request(data: Uint8Array) {
  return { tokenType: TOKEN_TYPE, salt: SALT, data, justification: JUSTIFICATION, assets: [{ coinId: COIN, amount: AMOUNT }] };
}

describe('PaymentsFacade — mintCustom (plugin tokens)', () => {
  it('mints to the wallet with the caller-fixed type, salt and reason: a valued row, a MINT record naming the coin, an empty journal', async () => {
    const det = new DetEngine();
    const world = makeWorld({ engine: det });
    await world.facade.start();

    const result = await world.facade.mintCustom(request(await valuedPayload()));

    expect(result).toEqual({ success: true, tokenId: expect.stringMatching(/^[0-9a-f]{64}$/) });
    await vi.waitFor(() => {
      expect(world.facade.tokens().map((t) => [t.id, t.amount, t.coinId])).toEqual([[result.tokenId, AMOUNT.toString(), COIN]]);
    });
    expect(det.calls).toEqual([
      {
        transferId: expect.any(String),
        data: bytesToHex(await valuedPayload()),
        salt: bytesToHex(SALT),
        tokenType: bytesToHex(TOKEN_TYPE),
        justification: bytesToHex(JUSTIFICATION),
      },
    ]);
    const history = await world.api.listHistory(ownCaller);
    expect(history.records.filter((r) => r.type === 'MINT')).toEqual([
      expect.objectContaining({ tokenId: result.tokenId, assets: [{ coinId: COIN, amount: AMOUNT.toString() }] }),
    ]);
    expect(await journal(world)).toEqual([]);
  });

  it('the same salt names the same token: a second call with the same request recovers, never mints twice', async () => {
    const det = new DetEngine();
    const world = makeWorld({ engine: det });
    await world.facade.start();
    const payload = await valuedPayload();

    const first = await world.facade.mintCustom(request(payload));
    const second = await world.facade.mintCustom(request(payload));

    expect(second.success).toBe(true);
    expect(second.tokenId).toBe(first.tokenId);
    expect(det.calls).toHaveLength(2);
    expect(det.calls[1]).toMatchObject({ data: det.calls[0]!.data, salt: det.calls[0]!.salt });
  });

  it('refuses a malformed request before anything is journaled or minted', async () => {
    const det = new DetEngine();
    const world = makeWorld({ engine: det });
    await world.facade.start();

    const badType = await world.facade.mintCustom({ ...request(await valuedPayload()), tokenType: new Uint8Array(31) });
    const badSalt = await world.facade.mintCustom({ ...request(await valuedPayload()), salt: new Uint8Array(8) });
    const badAsset = await world.facade.mintCustom({ ...request(await valuedPayload()), assets: [{ coinId: 'zz', amount: 1n }] });

    for (const r of [badType, badSalt, badAsset]) expect(r).toMatchObject({ success: false, error: expect.stringMatching(/mintCustom/) });
    expect(det.calls).toEqual([]);
    expect(await journal(world)).toEqual([]);
  });

  it('journals the bytes BEFORE the chain op, and the engine is asked for exactly those bytes', async () => {
    const det = new DetEngine();
    const world = makeWorld({ engine: det });
    await world.facade.start();
    const payload = await valuedPayload();
    let seenAtMint: CustomMintJournalEntry[] = [];
    const original = det.mintDataToken.bind(det);
    vi.spyOn(det, 'mintDataToken').mockImplementation(async (params, options) => {
      seenAtMint = await journal(world);
      return original(params, options);
    });

    await world.facade.mintCustom(request(payload));

    expect(seenAtMint).toEqual([
      expect.objectContaining({
        tokenId: '',
        dataHex: bytesToHex(payload),
        saltHex: bytesToHex(SALT),
        tokenTypeHex: bytesToHex(TOKEN_TYPE),
        justificationHex: bytesToHex(JUSTIFICATION),
        assets: [{ coinId: COIN, amount: AMOUNT.toString() }],
      }),
    ]);
  });

  it('a mint that certified but died is replayed after a restart with the SAME bytes — one token, one apply, one MINT record', async () => {
    const det = new DetEngine();
    const world = makeWorld({ engine: det });
    const counter = { applies: 0 };
    world.hooks.applyDelta = async () => {
      counter.applies += 1;
    };
    await world.facade.start();
    const payload = await valuedPayload();

    det.failNext = true;
    const first = await world.facade.mintCustom(request(payload));
    expect(first.success).toBe(false);
    expect(await journal(world)).toHaveLength(1);
    expect(counter.applies).toBe(0);
    await world.facade.stop();

    const restarted = makeWorld({ restartOf: world });
    restarted.hooks.applyDelta = async () => {
      counter.applies += 1;
    };
    await restarted.facade.start();
    await vi.waitFor(async () => {
      expect(await journal(restarted)).toEqual([]);
    });

    expect(det.calls).toHaveLength(2);
    expect(det.calls[1]).toEqual(det.calls[0]);
    expect(counter.applies).toBe(1);
    await vi.waitFor(() => {
      expect(restarted.facade.tokens().map((t) => t.amount)).toEqual([AMOUNT.toString()]);
    });
    const history = await restarted.api.listHistory(ownCaller);
    expect(history.records.filter((r) => r.type === 'MINT')).toHaveLength(1);

    await restarted.facade.stop();
    const again = makeWorld({ restartOf: restarted });
    await again.facade.start();
    await flushTail();
    expect(det.calls).toHaveLength(2);
  });

  it('a replay verifies the genesis reason under the engine registry: the per-call verifiers are not journaled', async () => {
    const det = new DetEngine();
    const world = makeWorld({ engine: det });
    await world.facade.start();
    const payload = await valuedPayload();
    const verifier = { tag: 1330002n, verify: vi.fn() };
    const seen: (unknown[] | undefined)[] = [];
    const original = det.mintDataToken.bind(det);
    vi.spyOn(det, 'mintDataToken').mockImplementation(async (params, options) => {
      seen.push(params.mintJustificationVerifiers as unknown[] | undefined);
      return original(params, options);
    });

    det.failNext = true;
    await world.facade.mintCustom({ ...request(payload), mintJustificationVerifiers: [verifier] });
    await world.facade.stop();
    const restarted = makeWorld({ restartOf: world });
    await restarted.facade.start();
    await vi.waitFor(async () => {
      expect(await journal(restarted)).toEqual([]);
    });

    expect(seen).toEqual([[verifier], undefined]);
  });
});
