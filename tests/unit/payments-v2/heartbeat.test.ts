// §7 in-session convergence heartbeat + the §4 pending-transfers read surface:
// a keep-open send converges WITHOUT a restart once the limiter lifts (same
// (transferId, opIndex) re-runs only — never a re-issued send), backoff
// 5/10/20/…/120 with a Retry-After floor, idle-when-quiescent, resumeNow()
// coalescing onto the single-flighted pass, and stop() cancelling mid-backoff.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PartialSendConflictError } from '../../../core/errors';
import { ProofUnconfirmedError } from '../../../token-engine/errors';
import {
  ConvergenceHeartbeat,
  HEARTBEAT_CAP_MS,
  HEARTBEAT_SEED_MS,
} from '../../../modules/payments-v2/convergence';
import { STORE_KEYS, type IntentBackstopEntry, type ShortfallEntry } from '../../../modules/payments-v2/stores';
import { createMachineStores } from '../../../modules/payments-v2/machine/journal';
import { FakeApiError } from './fakes/FakeWalletApi';
import {
  COIN,
  PEER_PUB,
  cleanupWorlds,
  eventsOf,
  makeWorld,
  ownCaller,
  peerCaller,
  type World,
} from './facade-harness';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  await cleanupWorlds();
  vi.useRealTimers();
});

/** Yield enough microtask generations for a full promise-only pass to settle. */
async function drain(turns = 256): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/** Advance the fake clock, then let the fired pass settle. */
async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await drain();
}

/**
 * A permanently-stuck open intent: server-open with an undecodable local
 * backstop envelope — every pass classifies it `failed` (no progress) and the
 * pending set never drains, which is exactly what the backoff tests need.
 */
async function seedStuckIntent(w: World, transferId = 'stuck-1'): Promise<void> {
  await w.api.putIntent(ownCaller, { transferId, payload: 'garbage-not-an-envelope' });
  const entry: IntentBackstopEntry = {
    transferId,
    payloadEnvelope: 'garbage-not-an-envelope',
    requiresSeedClose: false,
    disposition: 'open',
    createdAt: 1,
  };
  await w.kv.set(STORE_KEYS.intentBackstop, [entry]);
}

describe('PaymentsFacade — §7 convergence heartbeat', () => {
  it('a keep-open send converges IN-SESSION once the limiter lifts — no restart, no re-issued send', async () => {
    const w = makeWorld();
    const token = await w.seed(100n);
    await w.facade.start();
    await drain();
    expect(w.counters.listOpen).toBe(1); // startup pass idled (nothing pending)

    // Mid-transfer break (e.g. subscription 429): certification indeterminate → keep-open.
    const pue = new ProofUnconfirmedError('proof fetch inconclusive (429)');
    w.engine.afterOp = (_key, kind) => (kind === 'direct' ? pue : null);
    await expect(w.facade.send({ recipient: '@peer', amount: '100', coinId: COIN })).rejects.toBe(pue);
    w.engine.afterOp = null;
    const tid = pue.transferId!;
    expect(tid).toBeDefined();
    expect(w.api.inspectIntent(ownCaller, tid)?.status).toBe('open');
    const putIntents = w.counters.putIntent;

    // The wallet-api limiter is still on when the first heartbeat pass fires.
    let limited = true;
    w.hooks.listOpen = async () => {
      if (limited) throw new FakeApiError(429, 'QUOTA_EXCEEDED', 'still limited');
    };
    await tick(HEARTBEAT_SEED_MS); // t+5 s: pass blocked by the limiter
    expect(w.counters.listOpen).toBe(2);
    expect(w.api.inspectIntent(ownCaller, tid)?.status).toBe('open');

    limited = false; // the limiter lifts
    await tick(2 * HEARTBEAT_SEED_MS); // backoff doubled to 10 s → this pass converges

    expect(w.api.inspectIntent(ownCaller, tid)?.status).toBe('completed');
    const mailbox = await w.api.listMailbox(peerCaller, 0);
    expect(mailbox.entries.map((e) => e.tokenId)).toEqual([token.blob.tokenId]);
    // No re-issued send: ONE intent PUT ever, and the engine saw only
    // same-(transferId, opIndex) re-runs of the SAME realization.
    expect(w.counters.putIntent).toBe(putIntents);
    expect(w.engine.transferCalls.map((c) => c.key)).toEqual([`${tid}:0`, `${tid}:0`]);
    // The heartbeat emits nothing of its own.
    expect(eventsOf(w, 'transfer:updated')).toHaveLength(0);
    expect(await w.facade.pendingTransfers()).toEqual([]);
  });

  it('backoff runs 5/10/20/40/80/120/120 s and a surfaced Retry-After floors the next pass', async () => {
    const w = makeWorld();
    await seedStuckIntent(w);
    await w.facade.start();
    await drain();
    expect(w.counters.listOpen).toBe(1);

    const gaps = [
      HEARTBEAT_SEED_MS,
      2 * HEARTBEAT_SEED_MS,
      4 * HEARTBEAT_SEED_MS,
      8 * HEARTBEAT_SEED_MS,
      16 * HEARTBEAT_SEED_MS,
      HEARTBEAT_CAP_MS, // 32× would be 160 s — capped
      HEARTBEAT_CAP_MS, // and stays capped
    ];
    let calls = 1;
    for (const gap of gaps) {
      await tick(gap - 1);
      expect(w.counters.listOpen).toBe(calls); // never earlier than the backoff
      await tick(1);
      calls += 1;
      expect(w.counters.listOpen).toBe(calls);
    }

    // A Retry-After from the next pass floors the schedule ABOVE the 120 s cap.
    const retryAfterMs = 300_000;
    let armed = true;
    w.hooks.listOpen = async () => {
      if (!armed) return;
      armed = false;
      throw Object.assign(new FakeApiError(429, 'QUOTA_EXCEEDED', 'cool down'), {
        retryAfter: retryAfterMs,
      });
    };
    await tick(HEARTBEAT_CAP_MS); // the pass that surfaces retryAfter
    calls += 1;
    expect(w.counters.listOpen).toBe(calls);

    await tick(retryAfterMs - 1);
    expect(w.counters.listOpen).toBe(calls); // never scheduled earlier than Retry-After
    await tick(1);
    expect(w.counters.listOpen).toBe(calls + 1);
  });

  it('idles when nothing is pending: no timer after start, none after a clean send', async () => {
    const w = makeWorld();
    await w.seed(100n);
    await w.facade.start();
    await drain();
    expect(w.counters.listOpen).toBe(1);

    await tick(30 * 60_000);
    expect(w.counters.listOpen).toBe(1); // startup pass only — heartbeat never scheduled

    const result = await w.facade.send({ recipient: '@peer', amount: '100', coinId: COIN });
    expect(result.deliveryPending).toBe(false);
    await drain(); // fire-and-forget close tail
    await tick(30 * 60_000);
    expect(w.counters.listOpen).toBe(1); // a fully-landed send leaves nothing to converge
  });

  it('resumeNow() coalesces with a running pass — ONE resumeAll in flight — and runs fresh after it settles', async () => {
    const w = makeWorld();
    const gate = w.gate('listOpen');
    await w.facade.start(); // the startup pass parks inside listOpen
    await drain();
    expect(gate.entered).toBe(true);
    expect(w.counters.listOpen).toBe(1);

    const first = w.facade.resumeNow();
    const second = w.facade.resumeNow();
    await drain();
    expect(w.counters.listOpen).toBe(1); // both coalesced onto the running pass

    gate.release();
    await first;
    await second;
    expect(w.counters.listOpen).toBe(1);

    delete w.hooks.listOpen;
    await w.facade.resumeNow(); // after settling, a fresh pass runs
    expect(w.counters.listOpen).toBe(2);
  });

  it('stop() cancels a scheduled tick mid-backoff; a restart re-seeds the backoff', async () => {
    const w = makeWorld();
    await seedStuckIntent(w);
    await w.facade.start();
    await drain();
    expect(w.counters.listOpen).toBe(1);
    await tick(HEARTBEAT_SEED_MS);
    expect(w.counters.listOpen).toBe(2); // next tick would be at +10 s

    await tick(2_000); // 2 s into the 10 s backoff
    await w.facade.stop();
    await tick(60 * 60_000);
    expect(w.counters.listOpen).toBe(2); // cancelled cleanly — nothing ever fired

    await w.facade.start();
    await drain();
    expect(w.counters.listOpen).toBe(3); // fresh startup pass
    await tick(HEARTBEAT_SEED_MS - 1);
    expect(w.counters.listOpen).toBe(3);
    await tick(1);
    expect(w.counters.listOpen).toBe(4); // restart re-seeded the 5 s backoff
  });

  it('an idle settle never cancels a concurrently-armed tick — work appearing mid-pass is not lost', async () => {
    let ticks = 0;
    const hb = new ConvergenceHeartbeat({
      now: () => Date.now(),
      onTick: () => {
        ticks += 1;
      },
    });
    hb.start();
    // A send parks keep-open and arms AFTER an in-flight pass already read the
    // (then-empty) pending set — the pass's idle settle must not cancel it.
    hb.arm();
    hb.settle({ progress: false, retryAfterMs: null }, false);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_SEED_MS);
    expect(ticks).toBe(1);
  });

  it('a partial send whose delivered leg still owes its deposit arms the heartbeat — the deposit lands in-session', async () => {
    const w = makeWorld();
    const big = await w.seed(600n);
    const small = await w.seed(400n);
    await w.engine.foreignSpend(small);
    await w.facade.start();
    await drain();

    let deliverFailures = 2; // the send leg + the in-send resume re-delivery
    w.hooks.deliver = async () => {
      if (deliverFailures > 0) {
        deliverFailures -= 1;
        throw new FakeApiError(500, 'INTERNAL', 'edge sad');
      }
    };
    let caught: unknown;
    try {
      await w.facade.send({ recipient: '@peer', amount: '1000', coinId: COIN });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PartialSendConflictError); // remainder failed AFTER the partial
    expect((await w.api.listMailbox(peerCaller, 0)).entries).toHaveLength(0);

    await tick(HEARTBEAT_SEED_MS); // NO finishSend ran — only the heartbeat can land the deposit
    const mailbox = await w.api.listMailbox(peerCaller, 0);
    expect(mailbox.entries.map((e) => e.tokenId)).toEqual([big.blob.tokenId]);
    // The remainder is still owed: the shortfall row survives, the journal row drained.
    const rows = await w.facade.pendingTransfers();
    expect(rows).toEqual([expect.objectContaining({ kind: 'shortfall', amount: '400' })]);
  });

  it('connection:status recovery resets the backoff: the pending tick fires at the seed, and an idle heartbeat stays idle', async () => {
    const w = makeWorld();
    await seedStuckIntent(w);
    await w.facade.start();
    await drain();
    await tick(HEARTBEAT_SEED_MS);
    await tick(2 * HEARTBEAT_SEED_MS);
    await tick(4 * HEARTBEAT_SEED_MS);
    expect(w.counters.listOpen).toBe(4); // next tick would be at +40 s

    await tick(10_000); // 10 s into the 40 s wait
    w.session.setStatus('connected'); // the wake socket recovered
    await tick(HEARTBEAT_SEED_MS); // fires at the seed, not at the remaining 30 s
    expect(w.counters.listOpen).toBe(5);

    const idle = makeWorld();
    await idle.facade.start();
    await drain();
    idle.session.setStatus('connected');
    await tick(30 * 60_000);
    expect(idle.counters.listOpen).toBe(1); // recovery while idle schedules nothing
  });
});

describe('PaymentsFacade — pendingTransfers() read surface', () => {
  it('a keep-open intent surfaces with its payload fields and empties when the heartbeat converges it', async () => {
    const w = makeWorld();
    await w.seed(100n);
    await w.facade.start();
    await drain();

    const pue = new ProofUnconfirmedError('inconclusive');
    w.engine.afterOp = (_key, kind) => (kind === 'direct' ? pue : null);
    await expect(w.facade.send({ recipient: '@peer', amount: '100', coinId: COIN })).rejects.toBe(pue);
    w.engine.afterOp = null;
    const tid = pue.transferId!;

    expect(await w.facade.pendingTransfers()).toEqual([
      {
        transferId: tid,
        kind: 'open',
        recipient: PEER_PUB,
        coinId: COIN,
        amount: '100',
        legs: { certified: 0, total: 1 },
        deliveryPending: false,
        createdAt: expect.any(Number) as number,
      },
    ]);

    await tick(HEARTBEAT_SEED_MS); // heartbeat converges the parked intent
    expect(await w.facade.pendingTransfers()).toEqual([]);
    expect(w.api.inspectIntent(ownCaller, tid)?.status).toBe('completed');
  });

  it('a certified-but-undelivered leg is counted from the journal and the heartbeat re-delivers it (never re-certifies)', async () => {
    const w = makeWorld();
    const token = await w.seed(100n);
    await w.facade.start();
    await drain();

    let deliverFailures = 1;
    w.hooks.deliver = async () => {
      if (deliverFailures > 0) {
        deliverFailures -= 1;
        throw new FakeApiError(500, 'INTERNAL', 'edge sad');
      }
    };
    const result = await w.facade.send({ recipient: '@peer', amount: '100', coinId: COIN });
    expect(result.deliveryPending).toBe(true);
    await drain(); // the close tail completes the intent; the journal entry stays

    const rows = await w.facade.pendingTransfers();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      transferId: result.id,
      kind: 'open',
      recipient: PEER_PUB,
      legs: { certified: 1, total: 1 },
      deliveryPending: true,
    });

    await tick(HEARTBEAT_SEED_MS); // heartbeat replays the journal
    expect(await w.facade.pendingTransfers()).toEqual([]);
    const mailbox = await w.api.listMailbox(peerCaller, 0);
    expect(mailbox.entries.map((e) => e.tokenId)).toEqual([token.blob.tokenId]);
    expect(w.engine.transferCalls).toHaveLength(1); // #621: re-delivered, never re-certified
  });

  it('a #690 shortfall surfaces DISTINCTLY with the remainder still owed — and does not drive the heartbeat', async () => {
    const w = makeWorld();
    await w.facade.start();
    await drain();
    const entry: ShortfallEntry = {
      transferId: 'partial-9',
      remainingAmount: '400',
      coinId: COIN,
      recipient: PEER_PUB,
      committedTokenIds: ['bb'.repeat(32)],
      createdAt: 7,
    };
    await createMachineStores(w.kv).shortfalls.upsert(entry);

    expect(await w.facade.pendingTransfers()).toEqual([
      {
        transferId: 'partial-9',
        kind: 'shortfall',
        recipient: PEER_PUB,
        coinId: COIN,
        amount: '400',
        legs: { certified: 1, total: 1 },
        deliveryPending: false,
        createdAt: 7,
      },
    ]);

    // The remainder needs a caller decision (re-plan); it is NOT heartbeat work.
    await tick(10 * 60_000);
    expect(w.counters.listOpen).toBe(1);
  });
});

describe("resume GC — stale 'open' backstop entries (S1: not server-open, nothing owed)", () => {
  it('tail crash after complete (intent completed, journal empty): the next pass sweeps the entry, pendingTransfers() empties, the heartbeat idles', async () => {
    const w = makeWorld();
    await w.seed(100n);
    await w.facade.start();
    await drain();
    const result = await w.facade.send({ recipient: '@peer', amount: '100', coinId: COIN });
    await drain(); // fire-and-forget close tail: completeIntent + backstop removal
    expect(w.api.inspectIntent(ownCaller, result.id)?.status).toBe('completed');

    // Simulate the crash window between completeIntent and backstop.removeByKey:
    // re-insert the entry the dead tail never removed.
    const entry: IntentBackstopEntry = {
      transferId: result.id,
      payloadEnvelope: 'sealed-crashed-tail',
      requiresSeedClose: false,
      disposition: 'open',
      createdAt: 1,
    };
    await w.kv.set(STORE_KEYS.intentBackstop, [entry]);
    expect(await w.facade.pendingTransfers()).toHaveLength(1); // the phantom row

    await w.facade.resumeNow();

    expect(await createMachineStores(w.kv).backstop.list()).toEqual([]);
    expect(await w.facade.pendingTransfers()).toEqual([]);
    const passes = w.counters.listOpen;
    await tick(30 * 60_000);
    expect(w.counters.listOpen).toBe(passes); // idle — no timer re-armed by the swept entry
  });

  it("an entry whose intent PUT never acked but with journal legs owed is KEPT (GC, not money logic — when in doubt, keep)", async () => {
    const w = makeWorld();
    await w.facade.start();
    await drain();
    const entry: IntentBackstopEntry = {
      transferId: 'ghost-1',
      payloadEnvelope: 'sealed-unacked',
      requiresSeedClose: false,
      disposition: 'open',
      createdAt: 1,
    };
    await w.kv.set(STORE_KEYS.intentBackstop, [entry]);
    await w.kv.set(STORE_KEYS.deliveryJournal, [
      {
        transferId: 'ghost-1',
        opIndex: 0,
        recipientPubkey: PEER_PUB,
        blobHex: 'aa',
        attempts: 6,
        undeliverable: true,
      },
    ]);

    await w.facade.resumeNow();

    const kept = await createMachineStores(w.kv).backstop.list();
    expect(kept.map((e) => e.transferId)).toEqual(['ghost-1']);
  });

  it('an in-process attempt parked BEFORE its intent PUT acked is never swept by a concurrent pass', async () => {
    const w = makeWorld();
    await w.seed(100n);
    await w.facade.start();
    await drain();

    const gate = w.gate('putIntent');
    const sending = w.facade.send({ recipient: '@peer', amount: '100', coinId: COIN });
    await drain();
    expect(gate.entered).toBe(true); // backstop written, PUT not acked, journal empty

    await w.facade.resumeNow();
    expect(await createMachineStores(w.kv).backstop.list()).toHaveLength(1);

    gate.release();
    const result = await sending;
    expect(result.status).toBe('delivered');
  });
});
