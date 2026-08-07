// PaymentsFacade (§4) over REAL wallet-api-v2 ports + FakeWalletApi + the
// Part-E realization engine: send policy (bounded re-plan, remainder-only
// accumulation, keep-open unwrapped), lifecycle posture, and mint journal.
// The world builder lives in facade-harness.ts (shared with heartbeat.test.ts).

import { afterEach, describe, expect, it, vi } from 'vitest';

import { hexToBytes } from '../../../core/crypto';
import { PartialSendConflictError, SphereError } from '../../../core/errors';
import { ProofUnconfirmedError } from '../../../token-engine/errors';
import type { EngineOpOptions, MintParams, SphereToken } from '../../../token-engine';
import { STORE_KEYS, type MintJournalEntry } from '../../../modules/payments-v2/stores';
import { createMachineStores } from '../../../modules/payments-v2/machine/journal';
import {
  ATTENTION_MINT_UNRESOLVED,
  type DeterministicMintCapable,
} from '../../../modules/payments-v2/PaymentsFacade';
import { RealizationEngine } from './machine-harness';
import {
  COIN,
  OWN_PUB,
  PEER_PUB,
  cleanupWorlds,
  eventsOf,
  flushTail,
  makeWorld,
  ownCaller,
  peerCaller,
} from './facade-harness';

/**
 * Advertising harness modelling F13: mint under a (transferId, opIndex) seed is
 * idempotent — a re-call with the same seed returns the SAME token (recovered
 * certification), never a second one. `failNext` simulates a keep-open first
 * attempt: the token certifies but the call dies before returning.
 */
class DetMintEngine extends RealizationEngine implements DeterministicMintCapable {
  readonly deterministicMint = true as const;
  readonly seeds: { transferId: string | undefined; opIndex: number }[] = [];
  failNext = false;
  private readonly mintMemo = new Map<string, SphereToken>();

  override async mint(params: MintParams, options?: EngineOpOptions): Promise<SphereToken> {
    this.seeds.push({ transferId: options?.transferId, opIndex: options?.opIndex ?? 0 });
    if (options?.transferId === undefined) return super.mint(params, options);
    let token = this.mintMemo.get(options.transferId);
    if (token === undefined) {
      token = await super.mint(params);
      this.mintMemo.set(options.transferId, token);
    }
    if (this.failNext) {
      this.failNext = false;
      throw new ProofUnconfirmedError('proof fetch inconclusive after certify (simulated)');
    }
    return token;
  }
}

afterEach(cleanupWorlds);

describe('PaymentsFacade — send policy', () => {
  it('happy direct send: §4 result shape, transfer:updated, mailbox deposit, completed intent', async () => {
    const world = makeWorld();
    const token = await world.seed(100n);
    await world.facade.start();

    const result = await world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN });

    expect(result.status).toBe('delivered');
    expect(result.deliveryPending).toBe(false);
    expect(result.tokens.map((t) => t.id)).toEqual([token.blob.tokenId]);
    expect(result.tokenTransfers).toEqual([{ sourceTokenId: token.blob.tokenId, method: 'direct' }]);
    expect(eventsOf(world, 'transfer:updated')).toHaveLength(1);

    const mailbox = await world.api.listMailbox(peerCaller, 0);
    expect(mailbox.entries.map((e) => e.tokenId)).toEqual([token.blob.tokenId]);
    await flushTail();
    expect(world.api.inspectIntent(ownCaller, result.id)?.status).toBe('completed');
    expect(world.facade.tokens().filter((t) => t.status === 'confirmed')).toHaveLength(0);
  });

  it('split send: change is uploaded/applied and re-enters the pool after the refresh tail', async () => {
    const world = makeWorld();
    await world.seed(500n);
    await world.facade.start();

    const result = await world.facade.send({ recipient: '@peer', amount: '200', coinId: COIN });
    expect(result.tokenTransfers[0]?.method).toBe('split');

    await vi.waitFor(() => {
      const amounts = world.facade.tokens().map((t) => t.amount);
      expect(amounts).toEqual(['300']);
    });
    const assets = await world.facade.assets(COIN);
    expect(assets[0]?.totalAmount).toBe('300');
  });

  it('cross-network recipient is refused BEFORE any reserve (no putIntent, no engine op, pool untouched)', async () => {
    const world = makeWorld();
    await world.seed(100n);
    await world.facade.start();

    await expect(
      world.facade.send({ recipient: '@mars', amount: '100', coinId: COIN })
    ).rejects.toMatchObject({ code: 'INVALID_RECIPIENT' });

    expect(world.counters.putIntent).toBe(0);
    expect(world.engine.transferCalls).toHaveLength(0);
    expect(world.facade.tokens().every((t) => t.status === 'confirmed')).toBe(true);
    // The full balance is still plannable — nothing stayed reserved.
    const ok = await world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN });
    expect(ok.status).toBe('delivered');
  });

  it('a CLEAN failure emits transfer:updated{status:failed} BEFORE the rejection surfaces (§4 — transfer:updated replaces transfer:failed)', async () => {
    const world = makeWorld();
    await world.facade.start();

    // Insufficient balance (empty wallet): a transferId was allocated → it rides the emission.
    let atRejection: unknown[] = [];
    let caught: unknown;
    try {
      await world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN });
    } catch (err) {
      caught = err;
      atRejection = [...eventsOf(world, 'transfer:updated')]; // snapshot AT rejection time
    }
    expect(caught).toBeInstanceOf(SphereError);
    expect((caught as SphereError).code).toBe('SEND_INSUFFICIENT_BALANCE');
    expect(atRejection).toEqual([
      {
        id: 'tid-1',
        status: 'failed',
        tokens: [],
        tokenTransfers: [],
        error: expect.stringContaining('Insufficient balance') as unknown,
      },
    ]);

    // Pre-plan refusal (unresolvable recipient): no transferId ever existed → id ''.
    await expect(
      world.facade.send({ recipient: '@nobody', amount: '100', coinId: COIN })
    ).rejects.toMatchObject({ code: 'INVALID_RECIPIENT' });
    const updates = eventsOf(world, 'transfer:updated') as { id: string; status: string }[];
    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({ id: '', status: 'failed' });
  });

  it('a keep-open rejection NEVER emits status:failed — the intent is converging, a failed label invites a dApp re-send', async () => {
    const world = makeWorld();
    await world.seed(100n);
    await world.facade.start();
    world.engine.afterOp = (_key, kind) =>
      kind === 'direct' ? new ProofUnconfirmedError('proof fetch inconclusive') : null;

    await expect(
      world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN })
    ).rejects.toMatchObject({ code: 'CERTIFICATION_UNCONFIRMED' });

    expect(eventsOf(world, 'transfer:updated')).toEqual([]);
  });

  it('re-plan loop is bounded at MAX_RESELECT with a demote per retried attempt', async () => {
    const world = makeWorld();
    const tokens: SphereToken[] = [];
    for (let i = 0; i < 10; i++) tokens.push(await world.seed(100n));
    for (const token of tokens) await world.engine.foreignSpend(token);
    await world.facade.start();

    await expect(
      world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN })
    ).rejects.toMatchObject({ code: 'TRANSFER_CONFLICT' });

    // 1 initial + 8 re-plans = 9 attempts, each demoting its proven-spent source.
    expect(world.engine.transferCalls).toHaveLength(9);
    const suspected = world.facade.tokens().filter((t) => t.suspectedSpent === true);
    expect(suspected).toHaveLength(9);
    expect(world.facade.tokens()).toHaveLength(10);
  });

  it('partial accumulation: committedTokenIds span attempts, remainingAmount exact, first transferId anchors', async () => {
    const world = makeWorld();
    const a = await world.seed(600n);
    const b = await world.seed(400n);
    const c1 = await world.seed(250n);
    const c2 = await world.seed(150n);
    await world.engine.foreignSpend(b);
    await world.engine.foreignSpend(c2);
    await world.facade.start();

    // #690 order probe: at the first partial's complete, its shortfall is durable.
    let shortfallAtFirstComplete: boolean | null = null;
    let firstPartialTransferId: string | null = null;
    world.hooks.complete = async (transferId) => {
      if (shortfallAtFirstComplete === null) {
        firstPartialTransferId = transferId;
        shortfallAtFirstComplete =
          (await createMachineStores(world.kv).shortfalls.getByKey(transferId)) !== undefined;
      }
    };

    let caught: unknown;
    try {
      await world.facade.send({ recipient: '@peer', amount: '1000', coinId: COIN });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PartialSendConflictError);
    const partial = caught as PartialSendConflictError;
    expect(partial.code).toBe('SEND_PARTIALLY_COMPLETED');
    expect([...partial.committedTokenIds].sort()).toEqual(
      [a.blob.tokenId, c1.blob.tokenId].sort()
    );
    expect(partial.remainingAmount).toBe('150');
    expect(partial.transferId).toBe(firstPartialTransferId);
    expect(shortfallAtFirstComplete).toBe(true);
    expect((partial.cause as SphereError).code).toBe('SEND_INSUFFICIENT_BALANCE');

    // The delivered legs actually reached the recipient exactly once each.
    const mailbox = await world.api.listMailbox(peerCaller, 0);
    expect(mailbox.entries.map((e) => e.tokenId).sort()).toEqual(
      [a.blob.tokenId, c1.blob.tokenId].sort()
    );
    // The LAST shortfall stays durable with the exact still-owed remainder.
    const shortfalls = await createMachineStores(world.kv).shortfalls.list();
    expect(shortfalls.some((s) => s.remainingAmount === '150')).toBe(true);
  });

  it('SENT history records what SETTLED, never the plan: partial 600 + remainder re-plan 400 → two SENT rows totalling exactly the send, each under its own transferId', async () => {
    const world = makeWorld();
    const a = await world.seed(600n);
    const b = await world.seed(400n);
    await world.seed(250n);
    await world.seed(150n);
    await world.engine.foreignSpend(b); // the 400 leg conflicts → partial on attempt 1
    await world.facade.start();

    const result = await world.facade.send({ recipient: '@peer', amount: '1000', coinId: COIN });
    expect(result.tokens.map((t) => t.id)).toContain(a.blob.tokenId);
    await flushTail(); // the clean remainder's history POST rides the fire-and-forget tail

    const { entries } = await world.facade.history({ limit: 50 });
    const sent = entries.filter((e) => e.type === 'SENT');
    expect(sent.map((e) => e.amount).sort()).toEqual(['400', '600']); // settled, never 1000
    expect(new Set(sent.map((e) => e.transferId)).size).toBe(2);
    expect(sent.reduce((sum, e) => sum + BigInt(e.amount), 0n)).toBe(1000n);
  });

  it('an unrecovered remainder leaves SENT at the settled 600 — never the planned 1000', async () => {
    const world = makeWorld();
    await world.seed(600n);
    const b = await world.seed(400n);
    await world.engine.foreignSpend(b);
    await world.facade.start();

    await expect(
      world.facade.send({ recipient: '@peer', amount: '1000', coinId: COIN })
    ).rejects.toBeInstanceOf(PartialSendConflictError);
    await flushTail();

    const { entries } = await world.facade.history({ limit: 50 });
    const sent = entries.filter((e) => e.type === 'SENT');
    expect(sent.map((e) => e.amount)).toEqual(['600']);
  });

  it('keep-open family is rethrown UNWRAPPED: same instance, cause preserved, transferId stamped', async () => {
    const world = makeWorld();
    await world.seed(100n);
    await world.facade.start();
    const netErr = new Error('socket hang up');
    const pue = new ProofUnconfirmedError('proof fetch inconclusive', netErr);
    world.engine.afterOp = (_key, kind) => (kind === 'direct' ? pue : null);

    let caught: unknown;
    try {
      await world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(pue);
    expect((caught as ProofUnconfirmedError).cause).toBe(netErr);
    expect((caught as ProofUnconfirmedError).transferId).toBeDefined();
    const open = await world.api.listIntents(ownCaller, 'open');
    expect(open.map((i) => i.transferId)).toContain((caught as ProofUnconfirmedError).transferId);
    // Keep-open sources stay excluded from the spendable view (§5.2).
    expect(world.facade.tokens()[0]?.status).toBe('transferring');
  });

  it('SEND_SYNC_PENDING passes through unwrapped with the machine-stamped transferId and cause', async () => {
    const world = makeWorld();
    await world.seed(100n);
    await world.facade.start();
    const netErr = new Error('mirror down');
    let applyCalls = 0;
    world.hooks.applyDelta = async () => {
      applyCalls += 1;
      if (applyCalls === 1) throw netErr;
    };

    let caught: unknown;
    try {
      await world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SphereError);
    expect((caught as SphereError).code).toBe('SEND_SYNC_PENDING');
    expect((caught as SphereError).cause).toBe(netErr);
    expect((caught as SphereError).transferId).toBeDefined();
  });

  it('requests.pay routes through the facade send and links the REAL transferId (#441)', async () => {
    const world = makeWorld();
    await world.seed(100n);
    await world.facade.start();
    const wire = await world.api.createRequest(peerCaller, {
      toPubkey: OWN_PUB,
      assets: [{ coinId: COIN, amount: '100' }],
    });
    await world.facade.requests.drainIncoming();
    expect(world.facade.requests.list()[0]?.status).toBe('pending');

    const result = await world.facade.requests.pay(wire.id);

    const outgoing = await world.api.listRequests(peerCaller, { role: 'outgoing' });
    const row = outgoing.requests.find((r) => r.id === wire.id);
    expect(row?.status).toBe('paid');
    expect(row?.transferId).toBe(result.id);
    await flushTail();
    expect(world.api.inspectIntent(ownCaller, result.id)?.status).toBe('completed');
  });
});

describe('PaymentsFacade — receive', () => {
  it('receive(): facade shape, claim ack, RECEIVED history, view refresh, dedup on second drain', async () => {
    const world = makeWorld();
    await world.facade.start();
    const gift = await world.engine.mint({
      recipientPubkey: hexToBytes(OWN_PUB),
      value: { assets: [{ coinId: COIN, amount: 77n }] },
    });
    await world.peerDeliver(gift, 'gift-1');

    const { transfers } = await world.facade.receive();

    expect(transfers).toHaveLength(1);
    expect(transfers[0]?.id).toBe(gift.blob.tokenId);
    expect(transfers[0]?.senderPubkey).toBe(PEER_PUB);
    expect(transfers[0]?.tokens[0]?.amount).toBe('77');
    expect(eventsOf(world, 'transfer:incoming')).toHaveLength(1);

    await vi.waitFor(() => {
      expect(world.facade.tokens().map((t) => t.id)).toContain(gift.blob.tokenId);
    });
    const history = await world.api.listHistory(ownCaller);
    expect(history.records.some((r) => r.type === 'RECEIVED' && r.tokenId === gift.blob.tokenId)).toBe(true);

    const again = await world.facade.receive();
    expect(again.transfers).toHaveLength(0);
  });
});

describe('PaymentsFacade — lifecycle', () => {
  it('start() never awaits resume: a hanging listIntents(open) does not block start', async () => {
    const world = makeWorld();
    await world.seed(100n);
    const gate = world.gate('listOpen');

    await world.facade.start();

    expect(gate.entered).toBe(true); // resume WAS launched…
    gate.release(); // …and start() already resolved while it hung.
    await flushTail();
    const ok = await world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN });
    expect(ok.status).toBe('delivered');
  });

  it('stop() awaits quiescence: an in-flight send settles before stop resolves; restart on the same kv works', async () => {
    const world = makeWorld();
    await world.seed(100n);
    await world.facade.start();
    const gate = world.gate('deliver');
    const timeline: string[] = [];

    const sending = world.facade
      .send({ recipient: '@peer', amount: '100', coinId: COIN })
      .then(() => timeline.push('send-settled'));
    await vi.waitFor(() => expect(gate.entered).toBe(true));

    const stopping = world.facade.stop().then(() => timeline.push('stop-resolved'));
    await flushTail();
    expect(timeline).toEqual([]); // stop is HELD by the in-flight machine
    gate.release();
    await sending;
    await stopping;
    expect(timeline).toEqual(['send-settled', 'stop-resolved']);

    delete world.hooks.deliver;
    await world.seed(60n);
    await world.facade.start();
    await vi.waitFor(async () => {
      const assets = await world.facade.assets(COIN);
      expect(assets[0]?.totalAmount).toBe('60');
    });
    const ok = await world.facade.send({ recipient: '@peer', amount: '60', coinId: COIN });
    expect(ok.status).toBe('delivered');
  });

  it('setEngine mid-flight: the old op finishes on the OLD engine, the old engine is disposed, future ops use the new one', async () => {
    const world = makeWorld();
    const engineB = new RealizationEngine({ chainPubkey: hexToBytes(OWN_PUB) });
    (engineB as unknown as { seq: number }).seq = 5000;
    world.engines.push(engineB);
    const disposed = { a: false };
    Object.assign(world.engine, {
      dispose: () => {
        disposed.a = true;
      },
    });
    const t1 = await world.seed(100n);
    const t2 = await world.seed(40n);
    await world.facade.start();

    const gate = world.gate('putIntent');
    const first = world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN });
    await vi.waitFor(() => expect(gate.entered).toBe(true));
    world.facade.setEngine(engineB);
    expect(disposed.a).toBe(true);
    gate.release();
    delete world.hooks.putIntent;

    const r1 = await first;
    expect(r1.tokens[0]?.id).toBe(t1.blob.tokenId);
    expect(world.engine.transferCalls).toHaveLength(1);
    expect(engineB.transferCalls).toHaveLength(0);

    const r2 = await world.facade.send({ recipient: '@peer', amount: '40', coinId: COIN });
    expect(r2.tokens[0]?.id).toBe(t2.blob.tokenId);
    expect(engineB.transferCalls).toHaveLength(1);
  });
});

describe('PaymentsFacade — mint', () => {
  it('mint(): journal-first (durable BEFORE the engine call), applied under the mintId, MINT history, journal cleared', async () => {
    const world = makeWorld();
    await world.facade.start();
    const mintSpy = vi.spyOn(world.engine, 'mint');
    const order: string[] = [];
    const origSet = world.kv.set.bind(world.kv);
    world.kv.set = async (key, value) => {
      if (key === STORE_KEYS.mintJournal) order.push('journal-write');
      await origSet(key, value);
    };
    mintSpy.mockImplementation(async function (this: RealizationEngine, params, options) {
      order.push('engine-mint');
      return RealizationEngine.prototype.mint.call(world.engine, params, options);
    } as typeof world.engine.mint);

    const result = await world.facade.mint(COIN, 50n);

    expect(result.success).toBe(true);
    expect(order[0]).toBe('journal-write');
    expect(order).toContain('engine-mint');
    expect(order.indexOf('journal-write')).toBeLessThan(order.indexOf('engine-mint'));

    await vi.waitFor(() => {
      expect(world.facade.tokens().map((t) => t.id)).toContain(result.tokenId);
    });
    const history = await world.api.listHistory(ownCaller);
    expect(history.records.some((r) => r.type === 'MINT' && r.tokenId === result.tokenId)).toBe(true);
    expect(await createMachineStores(world.kv).mintJournal.list()).toEqual([]);
  });

  it('mint replay: an entry whose token IS in server inventory is cleared WITHOUT re-minting (server-inventory guard)', async () => {
    const world = makeWorld();
    const already = await world.seed(50n);
    const entry: MintJournalEntry = {
      mintId: 'm-done',
      coinId: COIN,
      amount: '50',
      tokenId: already.blob.tokenId,
      createdAt: 1,
    };
    await world.kv.set(STORE_KEYS.mintJournal, [entry]);
    const mintSpy = vi.spyOn(world.engine, 'mint');

    await world.facade.start();
    await flushTail();

    expect(mintSpy).not.toHaveBeenCalled();
    expect(await createMachineStores(world.kv).mintJournal.list()).toEqual([]);
  });

  it('mint replay: non-deterministic engine NEVER blind re-mints an unresolved entry — holds it and alerts', async () => {
    const world = makeWorld();
    const entry: MintJournalEntry = {
      mintId: 'm-lost',
      coinId: COIN,
      amount: '50',
      tokenId: 'ff'.repeat(32),
      createdAt: 1,
    };
    await world.kv.set(STORE_KEYS.mintJournal, [entry]);
    const mintSpy = vi.spyOn(world.engine, 'mint');

    await world.facade.start();
    await flushTail();

    expect(mintSpy).not.toHaveBeenCalled();
    expect(await createMachineStores(world.kv).mintJournal.list()).toHaveLength(1);
    expect(
      eventsOf(world, 'transfer:attention').some(
        (p) => (p as { code: string }).code === ATTENTION_MINT_UNRESOLVED
      )
    ).toBe(true);
  });

  it('mint replay: keep-open first attempt on an advertising engine → replay re-calls the SAME (transferId, opIndex) seed — exactly one token/apply/history', async () => {
    const det = new DetMintEngine({ chainPubkey: hexToBytes(OWN_PUB) });
    const world = makeWorld({ engine: det });
    let applies = 0;
    world.hooks.applyDelta = async () => {
      applies += 1;
    };
    await world.facade.start();

    det.failNext = true; // token certifies, the call dies before returning (F13 keep-open)
    const first = await world.facade.mint(COIN, 50n);
    expect(first.success).toBe(false);
    expect(await createMachineStores(world.kv).mintJournal.list()).toHaveLength(1);
    expect(world.facade.tokens()).toHaveLength(0);

    await world.facade.stop();
    await world.facade.start();
    await vi.waitFor(async () => {
      expect(await createMachineStores(world.kv).mintJournal.list()).toEqual([]);
    });

    // The engine saw the SAME seed twice — a re-call, never a fresh-seed re-mint.
    expect(det.seeds).toHaveLength(2);
    expect(det.seeds[1]).toEqual(det.seeds[0]);
    expect(det.seeds[0]?.transferId).toBeDefined();
    expect(applies).toBe(1);
    const tokens = world.facade.tokens();
    expect(tokens).toHaveLength(1);
    const history = await world.api.listHistory(ownCaller);
    expect(history.records.filter((r) => r.type === 'MINT')).toHaveLength(1);
    expect(history.records.some((r) => r.type === 'MINT' && r.tokenId === tokens[0]?.id)).toBe(true);

    await world.facade.stop();
    await world.facade.start();
    await flushTail();
    expect(det.seeds).toHaveLength(2); // journal drained — the restart mints nothing
    expect(world.facade.tokens()).toHaveLength(1);
  });
});
