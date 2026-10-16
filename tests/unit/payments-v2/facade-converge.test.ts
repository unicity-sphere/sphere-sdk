/**
 * #844: a send whose attempt certified legs beside a conflict converges in-process from what
 * run() settled. No leg run() certified or proved conflicted is submitted or deposited again,
 * and the legs it never reached certify in run()'s waves.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { hexToBytes } from '../../../core/crypto';
import { isPossiblyCommittedSendOutcome } from '../../../core/errors';
import { ProofUnconfirmedError } from '../../../token-engine/errors';
import type { EngineOpOptions, SphereToken, SplitParams, SplitResult, TransferParams } from '../../../token-engine';
import type { TransferResult } from '../../../types';
import { RealizationEngine, opKey } from './machine-harness';
import { COIN, OWN_PUB, cleanupWorlds, eventsOf, flushTail, makeWorld, ownCaller, peerCaller, type World } from './facade-harness';

afterEach(cleanupWorlds);

/** A gateway that blips on every re-submission of an op it already answered. */
class BlipOnRepeatEngine extends RealizationEngine {
  private readonly answered = new Set<string>();
  private once(options?: EngineOpOptions): void {
    const key = opKey(options);
    if (this.answered.has(key)) throw new ProofUnconfirmedError('gateway blip (simulated)');
    this.answered.add(key);
  }
  override async transfer(p: TransferParams, o?: EngineOpOptions): Promise<SphereToken> {
    this.once(o);
    return super.transfer(p, o);
  }
  override async split(p: SplitParams, o?: EngineOpOptions): Promise<SplitResult> {
    this.once(o);
    return super.split(p, o);
  }
}

/** Each listed op is submitted once with no proof seen; every op takes a tick, so a wave's legs overlap. */
class SlowOpEngine extends RealizationEngine {
  readonly unconfirmed = new Set<string>();
  private readonly inFlight = new Set<string>();
  /** The most ops of one transfer, at or past `fromOp`, ever in flight together. */
  widest = 0;
  fromOp = 20;
  override async transfer(p: TransferParams, o?: EngineOpOptions): Promise<SphereToken> {
    const key = opKey(o);
    if ((o?.opIndex ?? 0) >= this.fromOp) this.inFlight.add(key);
    this.widest = Math.max(this.widest, [...this.inFlight].filter((k) => k.startsWith(`${o?.transferId ?? ''}:`)).length);
    try {
      await new Promise((resolve) => setTimeout(resolve, 2));
      const out = await super.transfer(p, o);
      if (this.unconfirmed.delete(key)) throw new ProofUnconfirmedError('no proof before the deadline (simulated)');
      return out;
    } finally {
      this.inFlight.delete(key);
    }
  }
}

const keysOf = (calls: { key: string }[], transferId: string): string[] =>
  calls.map((c) => c.key).filter((k) => k.startsWith(`${transferId}:`));
const updatesOf = (world: World, transferId: string): TransferResult[] =>
  (eventsOf(world, 'transfer:updated') as TransferResult[]).filter((u) => u.id === transferId);

async function seedMany(world: World, amounts: bigint[]): Promise<SphereToken[]> {
  const tokens: SphereToken[] = [];
  for (const amount of amounts) tokens.push(await world.seed(amount));
  return tokens;
}

/** A spent-status probe that is down for the listed sources: the facade's own isSpent sweep demotes none of them. */
class ProbeDownEngine extends RealizationEngine {
  readonly probeDown = new Set<string>();
  override async isSpent(token: SphereToken, o?: EngineOpOptions): Promise<boolean> {
    if (this.probeDown.has(token.blob.tokenId)) throw new Error('spent-status probe unavailable (simulated)');
    return super.isSpent(token, o);
  }
}

/** 1..22 plus a 300 decoy: a send of 253 plans all 22 direct (exact), so op 20 and op 21 sit in the second wave. */
async function twentyTwoLegs(world: World): Promise<SphereToken[]> {
  const tokens = await seedMany(world, Array.from({ length: 22 }, (_, i) => BigInt(i + 1)));
  await world.seed(300n); // what a re-plan of the remainder spends
  return tokens;
}

describe('#844 the in-process converge reuses what run() settled', () => {
  it('F1 every leg of the partial attempt runs on the engine once and is deposited once', async () => {
    const world = makeWorld();
    await world.seed(600n);
    const b = await world.seed(400n);
    await world.seed(250n);
    await world.seed(150n);
    await world.engine.foreignSpend(b);
    await world.facade.start();
    let deposits = 0;
    world.hooks.deliver = async () => {
      deposits += 1;
    };

    const result = await world.facade.send({ recipient: '@peer', amount: '1000', coinId: COIN });
    await flushTail();

    expect(result.status).toBe('delivered');
    expect(keysOf(world.engine.transferCalls, 'tid-1')).toEqual(['tid-1:0', 'tid-1:1']);
    expect(deposits).toBe((await world.api.listMailbox(peerCaller, 0)).entries.length);
  });

  it('F2 a certified split leg is not re-run: its change from run() lands in the inventory', async () => {
    const world = makeWorld();
    const a = await world.seed(400n);
    await world.seed(400n);
    await world.seed(1000n);
    await world.engine.foreignSpend(a);
    await world.facade.start();
    const applied: { transferId: string; added?: unknown[] }[] = [];
    world.hooks.applyDelta = async (delta) => {
      applied.push(delta as { transferId: string; added?: unknown[] });
    };

    const result = await world.facade.send({ recipient: '@peer', amount: '600', coinId: COIN });
    await flushTail();

    expect(result.status).toBe('delivered');
    expect(keysOf(world.engine.splitCalls, 'tid-1')).toEqual(['tid-1:1']);
    expect(keysOf(world.engine.transferCalls, 'tid-1')).toEqual(['tid-1:0']);
    expect(applied.find((d) => d.transferId === 'tid-1')?.added, 'the split change from run()').toHaveLength(1);
  });

  it('F3 a gateway blip on a re-submission cannot fail a send whose partial run() settled', async () => {
    const engine = new BlipOnRepeatEngine({ chainPubkey: hexToBytes(OWN_PUB) });
    const world = makeWorld({ engine });
    await world.seed(600n);
    const b = await world.seed(400n);
    await world.seed(250n);
    await world.seed(150n);
    await engine.foreignSpend(b);
    await world.facade.start();

    const result = await world.facade.send({ recipient: '@peer', amount: '1000', coinId: COIN });
    await flushTail();

    expect(result.status).toBe('delivered');
    expect((eventsOf(world, 'transfer:updated') as TransferResult[]).filter((u) => u.status === 'failed')).toEqual([]);
    expect(world.api.inspectIntent(ownCaller, 'tid-1')?.status).toBe('completed');
    expect(await world.facade.pendingTransfers()).toEqual([]);
  });

  it('F4 a leg run() never reached, unconfirmed in the converge: possibly-committed, no re-plan, no settled leg re-submitted', async () => {
    const engine = new SlowOpEngine({ chainPubkey: hexToBytes(OWN_PUB) });
    const world = makeWorld({ engine });
    const tokens = await twentyTwoLegs(world);
    await engine.foreignSpend(tokens[0]);
    engine.unconfirmed.add('tid-1:20');
    await world.facade.start();

    let caught: unknown;
    try {
      await world.facade.send({ recipient: '@peer', amount: '253', coinId: COIN });
    } catch (err) {
      caught = err;
    }
    await flushTail();

    expect(isPossiblyCommittedSendOutcome(caught)).toBe(true);
    expect((caught as { transferId?: string }).transferId).toBe('tid-1');
    expect([...new Set(world.putCalls.map((c) => c.transferId))]).toEqual(['tid-1']);
    expect(engine.unconfirmed.size, 'the converge reached the leg run() never ran').toBe(0);
    const keys = keysOf(engine.transferCalls, 'tid-1');
    expect(keys.slice(0, 20).sort(), 'run(): the first wave').toEqual(Array.from({ length: 20 }, (_, i) => `tid-1:${String(i)}`).sort());
    expect(keys.slice(20).sort(), 'the converge: only the second wave').toEqual(['tid-1:20', 'tid-1:21']);
    expect(updatesOf(world, 'tid-1').filter((u) => u.status === 'failed')).toEqual([]);
    expect(world.api.inspectIntent(ownCaller, 'tid-1')?.status).toBe('open');
  });

  it('F5 the legs run() never reached certify in one wave and report progress on top of the legs run() certified', async () => {
    const engine = new SlowOpEngine({ chainPubkey: hexToBytes(OWN_PUB) });
    const world = makeWorld({ engine });
    const tokens = await twentyTwoLegs(world);
    await engine.foreignSpend(tokens[0]);
    await world.facade.start();

    const result = await world.facade.send({ recipient: '@peer', amount: '253', coinId: COIN });
    await flushTail();

    expect(result.status).toBe('delivered');
    expect(engine.widest, 'op 20 and op 21 were in flight together').toBe(2);
    const progress = updatesOf(world, 'tid-1').filter((u) => u.status === 'submitted');
    expect(progress.map((u) => u.tokenTransfers.length), "run()'s 19 legs, then each leg of the converge").toEqual([
      ...Array.from({ length: 19 }, (_, i) => i + 1),
      20,
      21,
    ]);
  });

  it('F6 a reused conflict beside a fresh-wave conflict: the remainder is their sum and both sources end demoted', async () => {
    const world = makeWorld();
    const tokens = await twentyTwoLegs(world);
    await world.engine.foreignSpend(tokens[0]);
    await world.engine.foreignSpend(tokens[20]);
    await world.facade.start();

    const result = await world.facade.send({ recipient: '@peer', amount: '253', coinId: COIN });
    await flushTail();

    expect(result.status).toBe('delivered');
    expect(keysOf(world.engine.transferCalls, 'tid-1').filter((k) => k === 'tid-1:0'), 'the reused conflict never re-runs').toHaveLength(1);
    expect(keysOf(world.engine.transferCalls, 'tid-1').filter((k) => k === 'tid-1:20'), 'the fresh conflict ran once').toHaveLength(1);
    const suspected = world.facade
      .tokens()
      .filter((t) => t.suspectedSpent === true)
      .map((t) => t.id)
      .sort();
    expect(suspected).toEqual([tokens[0].blob.tokenId, tokens[20].blob.tokenId].sort());
    const { entries } = await world.api.listMailbox(peerCaller, 0);
    expect(entries, '20 direct legs of tid-1, then one leg of the remainder (1 + 21)').toHaveLength(21);
    expect(await world.facade.pendingTransfers()).toEqual([]);
  });

  it('F6b the converge demotes both conflicted sources itself: no other demotion can, with the spent-status probe down', async () => {
    const engine = new ProbeDownEngine({ chainPubkey: hexToBytes(OWN_PUB) });
    const world = makeWorld({ engine });
    const tokens = await twentyTwoLegs(world);
    await engine.foreignSpend(tokens[0]);
    await engine.foreignSpend(tokens[20]);
    engine.probeDown.add(tokens[0].blob.tokenId);
    engine.probeDown.add(tokens[20].blob.tokenId);
    await world.facade.start();

    // How the remainder ends is not this test's subject: only the converge can have demoted.
    await world.facade.send({ recipient: '@peer', amount: '253', coinId: COIN }).catch(() => undefined);
    await flushTail();

    const suspected = world.facade
      .tokens()
      .filter((t) => t.suspectedSpent === true)
      .map((t) => t.id)
      .sort();
    expect(suspected, 'demoted by the partial settle of the converge, from its proven conflicts').toEqual(
      [tokens[0].blob.tokenId, tokens[20].blob.tokenId].sort()
    );
  });
});
