import { afterEach, describe, expect, it, vi } from 'vitest';

import { bytesToHex, hexToBytes } from '../../../core/crypto';
import type { BurnParams, EngineOpOptions, SphereToken } from '../../../token-engine';
import { ProofUnconfirmedError } from '../../../token-engine/errors';
import { createMachineStores } from '../../../modules/payments-v2/machine/journal';
import type { BurnJournalEntry } from '../../../modules/payments-v2/stores';
import { RealizationEngine } from './machine-harness';
import { COIN, OWN_PUB, cleanupWorlds, flushTail, makeWorld, ownCaller, type World } from './facade-harness';

afterEach(cleanupWorlds);

const REASON = new Uint8Array([0xd9, 0x98, 0x88, 0x8b, 0x01, 0x1a, 0xcd, 0x86, 0x90, 0xdc]);

class DetBurnEngine extends RealizationEngine {
  readonly calls: { transferId?: string; tokenId: string; reason: string }[] = [];
  failNext = false;
  private readonly certified = new Map<string, SphereToken>();

  constructor() {
    super({ chainPubkey: hexToBytes(OWN_PUB) });
  }

  override async burn(params: BurnParams, options?: EngineOpOptions): Promise<SphereToken> {
    const id = options?.transferId ?? '';
    this.calls.push({ transferId: options?.transferId, tokenId: params.token.blob.tokenId, reason: bytesToHex(params.reasonBytes) });
    let burned = this.certified.get(id);
    if (burned === undefined) {
      burned = await super.burn(params, options);
      this.certified.set(id, burned);
    }
    if (this.failNext) {
      this.failNext = false;
      throw new ProofUnconfirmedError('proof fetch inconclusive after certify (simulated)');
    }
    return burned;
  }
}

async function journal(world: World): Promise<BurnJournalEntry[]> {
  return createMachineStores(world.kv).burnJournal.list();
}

async function heldIds(world: World): Promise<string[]> {
  return world.facade.tokens().map((t) => t.id);
}

describe('PaymentsFacade — burn (plugin tokens)', () => {
  it('burns a held token: the row leaves the inventory, a SENT record names the token, the blob waits for acknowledgement', async () => {
    const det = new DetBurnEngine();
    const world = makeWorld({ engine: det });
    const source = await world.seed(100n);
    await world.facade.start();
    const tokenId = source.blob.tokenId;

    const result = await world.facade.burn({ tokenId, reasonBytes: REASON });

    expect(result).toMatchObject({ success: true, tokenId, burnId: expect.any(String) });
    expect(result.burnedToken).toBeInstanceOf(Uint8Array);
    expect(det.calls).toEqual([{ transferId: result.burnId, tokenId, reason: bytesToHex(REASON) }]);
    await vi.waitFor(async () => {
      expect(await heldIds(world)).toEqual([]);
    });
    const history = await world.api.listHistory(ownCaller);
    expect(history.records.filter((r) => r.type === 'SENT')).toEqual([
      expect.objectContaining({ tokenId, assets: [{ coinId: COIN, amount: '100' }] }),
    ]);
    const burned = await det.decodeToken({ tokenId, token: result.burnedToken! });
    expect(det.isOwnedBy(burned, hexToBytes(OWN_PUB))).toBe(false);
    expect(det.readMemo(burned)).toEqual(REASON);

    const pending = await world.facade.pendingBurns();
    expect(pending).toEqual([
      expect.objectContaining({ burnId: result.burnId, tokenId, reasonBytes: REASON, settled: true, burnedToken: result.burnedToken }),
    ]);
    await world.facade.acknowledgeBurn(result.burnId);
    expect(await world.facade.pendingBurns()).toEqual([]);
    expect(await journal(world)).toEqual([]);
  });

  it('refuses a token this wallet does not hold, before anything is journaled', async () => {
    const det = new DetBurnEngine();
    const world = makeWorld({ engine: det });
    await world.facade.start();

    const result = await world.facade.burn({ tokenId: 'ab'.repeat(32), reasonBytes: REASON });

    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/not held here/) });
    expect(det.calls).toEqual([]);
    expect(await journal(world)).toEqual([]);
  });

  it('a burn that certified but died before the apply is settled after a restart under the SAME burnId — no second burn', async () => {
    const det = new DetBurnEngine();
    const world = makeWorld({ engine: det });
    const source = await world.seed(100n);
    await world.facade.start();

    det.failNext = true;
    const first = await world.facade.burn({ tokenId: source.blob.tokenId, reasonBytes: REASON });
    expect(first.success).toBe(false);
    expect(await journal(world)).toEqual([expect.objectContaining({ burnedTokenHex: null, settled: false })]);
    expect(await heldIds(world)).toEqual([source.blob.tokenId]);
    await world.facade.stop();

    const restarted = makeWorld({ restartOf: world });
    await restarted.facade.start();
    await vi.waitFor(async () => {
      expect(await journal(restarted)).toEqual([expect.objectContaining({ settled: true })]);
    });

    expect(det.calls).toHaveLength(2);
    expect(det.calls[1]).toEqual(det.calls[0]);
    await vi.waitFor(async () => {
      expect(await heldIds(restarted)).toEqual([]);
    });
    const [pending] = await restarted.facade.pendingBurns();
    expect(pending?.burnedToken).toBeInstanceOf(Uint8Array);
    const history = await restarted.api.listHistory(ownCaller);
    expect(history.records.filter((r) => r.type === 'SENT')).toHaveLength(1);
  });

  it('a burn whose spend was applied but not marked settled is not re-applied on replay', async () => {
    const det = new DetBurnEngine();
    const world = makeWorld({ engine: det });
    const source = await world.seed(100n);
    await world.facade.start();
    let applies = 0;
    world.hooks.applyDelta = async () => {
      applies += 1;
    };

    const first = await world.facade.burn({ tokenId: source.blob.tokenId, reasonBytes: REASON });
    expect(first.success).toBe(true);
    expect(applies).toBe(1);
    const [entry] = await journal(world);
    await createMachineStores(world.kv).burnJournal.upsert({ ...entry!, settled: false });
    await world.facade.stop();

    const restarted = makeWorld({ restartOf: world });
    restarted.hooks.applyDelta = async () => {
      applies += 1;
    };
    await restarted.facade.start();
    await vi.waitFor(async () => {
      expect(await journal(restarted)).toEqual([expect.objectContaining({ settled: true })]);
    });

    expect(applies).toBe(1);
    expect(det.calls).toHaveLength(1);
  });

  it('acknowledging an unsettled burn is refused; acknowledging an unknown burn is a no-op', async () => {
    const det = new DetBurnEngine();
    const world = makeWorld({ engine: det });
    const source = await world.seed(100n);
    await world.facade.start();

    det.failNext = true;
    const first = await world.facade.burn({ tokenId: source.blob.tokenId, reasonBytes: REASON });
    await expect(world.facade.acknowledgeBurn(first.burnId)).rejects.toThrow(/not settled/);
    await expect(world.facade.acknowledgeBurn('nope')).resolves.toBeUndefined();
    expect(await journal(world)).toHaveLength(1);
    await flushTail();
  });
});
