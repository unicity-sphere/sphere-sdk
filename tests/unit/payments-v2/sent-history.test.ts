// #842: SENT history is posted BESIDE the apply, never gated on POST /complete or on
// the apply's answer. The apply itself completes an unflagged intent, so once it
// commits the row is never listed open again: the next pass sweeps its backstop as
// S1 residue and records nothing. A SENT POST that waited for the apply's answer or
// for the close would be lost for good, leaving history() empty for money that left.

import { describe, expect, it } from 'vitest';

import { isPossiblyCommittedSendOutcome } from '../../../core/errors';
import { ProofUnconfirmedError, TransferConflictError } from '../../../token-engine/errors';
import { WalletApiHttpError } from '../../../impl/wallet-api-v2/http';
import { ActiveOps, Converger, derivePendingTransfers } from '../../../modules/payments-v2/convergence';
import { resumeAll } from '../../../modules/payments-v2/machine/resume';
import { STORE_KEYS } from '../../../modules/payments-v2/stores';
import { FakeApiError } from './fakes/FakeWalletApi';
import { makeWorld, type World } from './machine-harness';

interface Recorded {
  transferId: string;
  phase: string;
  committedAmount: string;
}

function captureHistory(w: World): Recorded[] {
  return captureHistoryInto(w, []);
}

function captureHistoryInto(w: World, recorded: Recorded[]): Recorded[] {
  w.deps.recordHistory = async ({ transferId, phase, committedAmount }) => {
    w.log.push('recordHistory');
    recorded.push({ transferId, phase, committedAmount });
  };
  return recorded;
}

/** The server applies the delta (and so completes an unflagged intent), then the answer is lost. */
function loseApplyAnswerOnce(w: World): void {
  const apply = w.deps.storage.applyDelta.bind(w.deps.storage);
  let lose = true;
  w.deps.storage.applyDelta = async (delta) => {
    const result = await apply(delta);
    if (!lose) return result;
    lose = false;
    throw new FakeApiError(504, 'GATEWAY_TIMEOUT', 'apply answer lost');
  };
}

/**
 * The process dies the moment the apply is ISSUED: the server commits it, and nothing the
 * client starts afterwards ever leaves. `recordHistory` counts only calls made before that.
 */
function dieOnApply(w: World): { recorded: Recorded[]; revive(): void } {
  const storage = w.deps.storage;
  const apply = storage.applyDelta.bind(storage);
  const recorded: Recorded[] = [];
  let dead = false;
  w.deps.recordHistory = async ({ transferId, phase, committedAmount }) => {
    if (!dead) recorded.push({ transferId, phase, committedAmount });
  };
  storage.applyDelta = async (delta) => {
    dead = true;
    await apply(delta);
    return new Promise<never>(() => undefined);
  };
  return {
    recorded,
    revive: () => {
      storage.applyDelta = apply;
      captureHistoryInto(w, recorded);
    },
  };
}

function failApplyOnce(w: World): void {
  let fail = true;
  w.overrides.applyDelta = async () => {
    if (!fail) return;
    fail = false;
    throw new FakeApiError(503, 'UNAVAILABLE', 'apply down');
  };
}

function failCompleteOnce(w: World): void {
  let fail = true;
  w.overrides.complete = async () => {
    if (!fail) return;
    fail = false;
    throw new FakeApiError(503, 'UNAVAILABLE', 'complete down');
  };
}

/** One leg, and two: a second leg puts more local work between the record and the apply. */
const LEGS = [
  { legs: 'one leg', amounts: [1000n] },
  { legs: 'two legs', amounts: [600n, 400n] },
];

async function seedAll(w: World, amounts: bigint[]): Promise<Awaited<ReturnType<World['seed']>>[]> {
  const tokens: Awaited<ReturnType<World['seed']>>[] = [];
  for (const amount of amounts) tokens.push(await w.seed(amount));
  return tokens;
}

/** A send whose apply failed before the server acted: certified, delivered, still open. */
async function openAfterFailedApply(w: World, amounts: bigint[] = [1000n]): Promise<string> {
  const plan = await w.plan({ tokens: await seedAll(w, amounts), amount: '1000' });
  failApplyOnce(w);
  await expect(w.machine().run(plan)).rejects.toMatchObject({ code: 'SEND_SYNC_PENDING' });
  await w.flushTail();
  expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('open');
  return plan.transferId;
}

/** Collects every unhandled rejection raised while `body` runs (and its tail settles). */
async function unhandledDuring(body: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    await body();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  return seen;
}

describe('#842 SENT history is posted beside the apply, never gated on the close', () => {
  it('T1 run(): a complete that fails after the apply still records SENT history, once', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    const recorded = captureHistory(w);
    failCompleteOnce(w);

    await w.machine().run(plan);
    await w.flushTail();

    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status, 'the apply completed the row').toBe('completed');
    expect(recorded).toEqual([{ transferId: plan.transferId, phase: 'sent', committedAmount: '1000' }]);
    await resumeAll(w.deps);
    expect(await w.stores().backstop.getByKey(plan.transferId), 'S1 swept the residue').toBeUndefined();
    expect(recorded).toHaveLength(1);
  });

  it('T3 run(): the apply lands but its answer is lost — SEND_SYNC_PENDING, and SENT history recorded', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    const recorded = captureHistory(w);
    loseApplyAnswerOnce(w);

    const err = await w.machine().run(plan).then(
      () => null,
      (e: unknown) => e
    );
    await w.flushTail();

    expect(err).toMatchObject({ code: 'SEND_SYNC_PENDING', transferId: plan.transferId });
    expect(isPossiblyCommittedSendOutcome(err)).toBe(true);
    expect(recorded).toEqual([{ transferId: plan.transferId, phase: 'sent', committedAmount: '1000' }]);
    const report = await resumeAll(w.deps);
    expect(report).toMatchObject({ resumed: [], conflicted: [], failed: [] });
    expect(await w.stores().backstop.getByKey(plan.transferId)).toBeUndefined();
    expect(recorded).toHaveLength(1);
  });

  it.each(LEGS)('C1 run() over $legs: the process dies once the apply is issued — SENT was already issued, and survives the restart sweep', async ({ amounts }) => {
    const w = makeWorld();
    const plan = await w.plan({ tokens: await seedAll(w, amounts), amount: '1000' });
    const death = dieOnApply(w);

    void w.machine().run(plan);
    await w.flushTail();

    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status, 'the apply committed').toBe('completed');
    expect(death.recorded, 'issued before the apply').toEqual([{ transferId: plan.transferId, phase: 'sent', committedAmount: '1000' }]);

    // Restart: a fresh pass over the same server and durable stores.
    death.revive();
    const report = await resumeAll(w.deps);
    expect(report).toMatchObject({ resumed: [], conflicted: [], failed: [] });
    expect(await w.stores().backstop.getByKey(plan.transferId), 'the restart sweep removed the backstop').toBeUndefined();
    expect(death.recorded, 'exactly one SENT row, from before the crash').toHaveLength(1);
  });

  it.each(LEGS)('C2 resume over $legs: the process dies once the apply is issued — SENT was already issued, and survives the restart sweep', async ({ amounts }) => {
    const w = makeWorld();
    const transferId = await openAfterFailedApply(w, amounts);
    const death = dieOnApply(w);

    void resumeAll(w.deps);
    await w.flushTail();

    expect(w.api.inspectIntent(w.caller, transferId)?.status, 'the apply committed').toBe('completed');
    expect(death.recorded, 'issued before the apply').toEqual([{ transferId, phase: 'resumed', committedAmount: '1000' }]);

    death.revive();
    const report = await resumeAll(w.deps);
    expect(report).toMatchObject({ resumed: [], conflicted: [], failed: [] });
    expect(await w.stores().backstop.getByKey(transferId)).toBeUndefined();
    expect(death.recorded).toHaveLength(1);
  });

  it('T2 resume: a close that fails after the apply records SENT history and still reports failed', async () => {
    const w = makeWorld();
    const transferId = await openAfterFailedApply(w);
    const recorded = captureHistory(w);
    failCompleteOnce(w);

    const first = await resumeAll(w.deps);

    expect(first.failed).toEqual([transferId]);
    expect(w.api.inspectIntent(w.caller, transferId)?.status).toBe('completed');
    expect(recorded).toEqual([{ transferId, phase: 'resumed', committedAmount: '1000' }]);
    await resumeAll(w.deps);
    expect(await w.stores().backstop.getByKey(transferId)).toBeUndefined();
    expect(recorded).toHaveLength(1);
  });

  it('T4 resume: the apply lands but its answer is lost — SENT history recorded once, the next pass sweeps', async () => {
    const w = makeWorld();
    const transferId = await openAfterFailedApply(w);
    const recorded = captureHistory(w);
    loseApplyAnswerOnce(w);

    const first = await resumeAll(w.deps);

    expect(first.failed).toEqual([transferId]);
    expect(recorded).toEqual([{ transferId, phase: 'resumed', committedAmount: '1000' }]);
    await resumeAll(w.deps);
    expect(await w.stores().backstop.getByKey(transferId)).toBeUndefined();
    expect(recorded).toHaveLength(1);
  });

  it('T5 settled partial: the apply lands but its answer is lost — the settled 600 is recorded, never the plan', async () => {
    const w = makeWorld();
    const tokenA = await w.seed(600n);
    const tokenB = await w.seed(400n);
    await w.engine.foreignSpend(tokenB);
    const plan = await w.plan({ tokens: [tokenA, tokenB], amount: '1000', transferId: 'p-1' });
    await expect(w.machine().run(plan)).rejects.toBeInstanceOf(TransferConflictError);
    const recorded = captureHistory(w);
    loseApplyAnswerOnce(w);

    const first = await resumeAll(w.deps);

    expect(first.failed).toEqual(['p-1']);
    expect(recorded).toEqual([{ transferId: 'p-1', phase: 'resumed', committedAmount: '600' }]);
    expect((await w.stores().shortfalls.getByKey('p-1'))?.remainingAmount).toBe('400');
  });

  it('T7 resume: a history POST that never answers holds neither the apply nor the close', async () => {
    const w = makeWorld();
    const transferId = await openAfterFailedApply(w);
    w.log.length = 0;
    w.deps.recordHistory = () => {
      w.log.push('recordHistory');
      return new Promise<never>(() => undefined);
    };

    void resumeAll(w.deps);
    await w.flushTail();

    expect(w.completes.map((c) => c.transferId), 'the close was issued').toEqual([transferId]);
    expect(w.api.inspectIntent(w.caller, transferId)?.status).toBe('completed');
    const order = w.log.filter((step) => ['recordHistory', 'completeIntent'].includes(step));
    expect(order, 'SENT went out beside the apply, never after the close').toEqual(['recordHistory', 'completeIntent']);
  });

  it('T10 resume: an apply that fails is reported failed at once, even while the history POST never answers', async () => {
    const w = makeWorld();
    const transferId = await openAfterFailedApply(w);
    w.deps.recordHistory = () => new Promise<never>(() => undefined);
    failApplyOnce(w);

    const report = await Promise.race([
      resumeAll(w.deps),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 200)),
    ]);

    expect(report, 'the pass is not held by the POST').not.toBe('hung');
    expect(report).toMatchObject({ resumed: [], failed: [transferId] });
    expect(w.completes, 'nothing closes after a failed apply').toEqual([]);
  });

  it('T12 resume: a close that fails while the history POST never answers is reported with its Retry-After, and the pass goes on', async () => {
    const w = makeWorld();
    const stuck = await openAfterFailedApply(w);
    const next = await openAfterFailedApply(w);
    w.deps.recordHistory = () => new Promise<never>(() => undefined);
    w.overrides.complete = async (transferId) => {
      if (transferId === stuck) throw new WalletApiHttpError(429, 'RATE_LIMITED', 'complete: rate limit exceeded', 60_000);
    };

    const report = await Promise.race([
      resumeAll(w.deps),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 200)),
    ]);

    expect(report, 'the close failure is not held by the POST').not.toBe('hung');
    expect(report).toMatchObject({ resumed: [next], failed: [stuck], retryAfterMs: 60_000 });
  });

  it('T8 run(): a history POST that never answers holds neither the apply, the close nor send()', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    w.deps.recordHistory = () => {
      w.log.push('recordHistory');
      return new Promise<never>(() => undefined);
    };

    await expect(w.machine().run(plan)).resolves.toMatchObject({ deliveryPending: false });
    await w.flushTail();

    expect(w.completes.map((c) => c.transferId), 'the close was issued').toEqual([plan.transferId]);
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('completed');
    expect(await w.stores().backstop.getByKey(plan.transferId), 'the close tail finished').toBeUndefined();
    const order = w.log.filter((step) => ['recordHistory', 'applyDelta', 'completeIntent'].includes(step));
    expect(order).toEqual(['recordHistory', 'applyDelta', 'completeIntent']);
  });

  it('T6a run(): a history POST that throws neither fails the send nor escapes as an unhandled rejection', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    w.deps.recordHistory = async () => {
      throw new FakeApiError(500, 'INTERNAL', 'history down');
    };

    const unhandled = await unhandledDuring(async () => {
      await expect(w.machine().run(plan)).resolves.toMatchObject({ deliveryPending: false });
    });

    expect(unhandled).toEqual([]);
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('completed');
    expect(await w.stores().backstop.getByKey(plan.transferId), 'the close tail still ran').toBeUndefined();
  });

  it('T6b resume: a history POST that throws never turns a resumed intent into a failure', async () => {
    const w = makeWorld();
    const transferId = await openAfterFailedApply(w);
    w.deps.recordHistory = async () => {
      throw new FakeApiError(500, 'INTERNAL', 'history down');
    };

    const unhandled = await unhandledDuring(async () => {
      const report = await resumeAll(w.deps);
      expect(report).toMatchObject({ resumed: [transferId], conflicted: [], failed: [] });
    });

    expect(unhandled).toEqual([]);
    expect(w.api.inspectIntent(w.caller, transferId)?.status).toBe('completed');
    expect(await w.stores().backstop.getByKey(transferId)).toBeUndefined();
  });

  it('T6c run(): a history hook that throws synchronously fails nothing either', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    w.deps.recordHistory = () => {
      throw new Error('history hook threw');
    };

    await expect(w.machine().run(plan)).resolves.toMatchObject({ deliveryPending: false });
    await w.flushTail();

    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('completed');
    expect(await w.stores().backstop.getByKey(plan.transferId)).toBeUndefined();
  });

  it('T9 a recipient blob the history read cannot decode records nothing and still applies and closes', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    const recorded = captureHistory(w);
    w.engine.decodeToken = async () => {
      throw new Error('undecodable');
    };

    await expect(w.machine().run(plan)).resolves.toMatchObject({ deliveryPending: false });
    await w.flushTail();

    expect(recorded).toEqual([]);
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('completed');
    expect(await w.stores().backstop.getByKey(plan.transferId)).toBeUndefined();
  });

  it('T11 run(): a deposit still owed does not hold the row back — SENT records the certified amount', async () => {
    const w = makeWorld();
    const plan = await w.plan({ tokens: await seedAll(w, [600n, 400n]), amount: '1000' });
    const recorded = captureHistory(w);
    w.overrides.deliver = async () => {
      throw new FakeApiError(503, 'UNAVAILABLE', 'mailbox down');
    };

    await expect(w.machine().run(plan)).resolves.toMatchObject({ deliveryPending: true });
    await w.flushTail();

    expect(w.deposits, 'nothing reached the mailbox').toEqual([]);
    expect(recorded).toEqual([{ transferId: plan.transferId, phase: 'sent', committedAmount: '1000' }]);
  });

  it('N1 a clean failure (nothing certified) records no SENT history', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    await w.engine.foreignSpend(token);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    const recorded = captureHistory(w);

    await expect(w.machine().run(plan)).rejects.toBeInstanceOf(TransferConflictError);
    await w.flushTail();
    await resumeAll(w.deps);

    expect(recorded).toEqual([]);
  });

  // The server keeps the FIRST post under a dedupKey, so a SENT row posted before the
  // attempt settled would fix the certified part as the payment's amount for good.
  it('N2 a keep-open leg beside a certified one: run() posts nothing, and resume posts the settled 1000', async () => {
    const w = makeWorld();
    const plan = await w.plan({ tokens: await seedAll(w, [600n, 400n]), amount: '1000' });
    const recorded = captureHistory(w);
    let unconfirmed = true;
    w.engine.beforeOp = (key) => {
      if (key !== `${plan.transferId}:1` || !unconfirmed) return;
      unconfirmed = false;
      throw new ProofUnconfirmedError('proof not seen yet');
    };

    await expect(w.machine().run(plan)).rejects.toSatisfy(isPossiblyCommittedSendOutcome);
    await w.flushTail();
    expect(recorded, 'nothing is posted while a leg is unsettled').toEqual([]);

    const report = await resumeAll(w.deps);

    expect(report).toMatchObject({ resumed: [plan.transferId], failed: [] });
    expect(recorded).toEqual([{ transferId: plan.transferId, phase: 'resumed', committedAmount: '1000' }]);
  });
});

/** The process dies the moment the apply is issued, and the SENT POST already in flight dies with it. */
function dieOnApplyLosingPost(w: World): { recorded: Recorded[]; revive(): void } {
  const storage = w.deps.storage;
  const apply = storage.applyDelta.bind(storage);
  const recorded: Recorded[] = [];
  w.deps.recordHistory = () => new Promise<never>(() => undefined); // issued, never answered
  storage.applyDelta = async (delta) => {
    await apply(delta);
    return new Promise<never>(() => undefined);
  };
  return {
    recorded,
    revive: () => {
      storage.applyDelta = apply;
      captureHistoryInto(w, recorded);
    },
  };
}

function convergerOf(w: World, activeOps = new ActiveOps()): Converger {
  return new Converger({
    machineDeps: w.deps,
    stores: w.stores(),
    delivery: w.deps.delivery,
    reconcile: async () => undefined,
    refreshView: async () => undefined,
    replayMints: async () => 0,
    replayNftMints: async () => 0,
    replayCustomMints: async () => 0,
    replayBurns: async () => 0,
    activeOps,
    parked: new Set(),
    emit: () => undefined,
    now: () => w.clock.t,
  });
}

/** A convergence pass that starts after everything so far: a restart, or the next heartbeat. */
async function passLater(w: World, converger = convergerOf(w)): Promise<void> {
  w.clock.t += 1_000;
  await converger.convergeOnce();
  await w.flushTail();
}

async function outbox(w: World): Promise<Recorded[]> {
  return (await w.stores().sentOutbox.list()).map(({ transferId, phase, committedAmount }) => ({ transferId, phase, committedAmount }));
}

/** A settled send whose SENT POST was answered "try again": its record is in the outbox. */
async function sentWithRecordKept(w: World): Promise<string> {
  const plan = await w.plan({ tokens: [await w.seed(1000n)], amount: '1000' });
  w.deps.recordHistory = async () => false;
  await w.machine().run(plan);
  await w.flushTail();
  expect(await outbox(w)).toEqual([{ transferId: plan.transferId, phase: 'sent', committedAmount: '1000' }]);
  return plan.transferId;
}

describe('#842 the SENT outbox keeps a record until its POST is answered for good', () => {
  it.each(LEGS)('O1 run() over $legs: the process dies once the apply is issued, taking the in-flight POST with it — the restart re-posts the kept record once', async ({ amounts }) => {
    const w = makeWorld();
    const plan = await w.plan({ tokens: await seedAll(w, amounts), amount: '1000' });
    const death = dieOnApplyLosingPost(w);

    void w.machine().run(plan);
    await w.flushTail();

    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status, 'the apply committed').toBe('completed');
    expect(await outbox(w), 'kept before the apply').toEqual([{ transferId: plan.transferId, phase: 'sent', committedAmount: '1000' }]);

    death.revive();
    await passLater(w);

    expect(death.recorded, 'exactly one SENT row, re-posted from the outbox').toEqual([
      { transferId: plan.transferId, phase: 'sent', committedAmount: '1000' },
    ]);
    expect(await outbox(w)).toEqual([]);
    expect(await w.stores().backstop.getByKey(plan.transferId), 'the restart swept the backstop').toBeUndefined();
  });

  it.each(LEGS)('O2 resume over $legs: the process dies once the apply is issued, taking the in-flight POST with it — the restart re-posts the kept record once', async ({ amounts }) => {
    const w = makeWorld();
    const transferId = await openAfterFailedApply(w, amounts);
    const death = dieOnApplyLosingPost(w);

    void resumeAll(w.deps);
    await w.flushTail();

    expect(w.api.inspectIntent(w.caller, transferId)?.status, 'the apply committed').toBe('completed');
    expect(await outbox(w)).toEqual([{ transferId, phase: 'resumed', committedAmount: '1000' }]);

    death.revive();
    await passLater(w);

    expect(death.recorded).toEqual([{ transferId, phase: 'resumed', committedAmount: '1000' }]);
    expect(await outbox(w)).toEqual([]);
  });

  it('O3 run(): the POST fails while the apply and close succeed — nothing is left pending, and the next pass posts the kept record once', async () => {
    const w = makeWorld();
    const transferId = await sentWithRecordKept(w);

    expect(w.api.inspectIntent(w.caller, transferId)?.status).toBe('completed');
    expect(await w.stores().backstop.getByKey(transferId), 'the send itself settled').toBeUndefined();
    expect(await derivePendingTransfers(w.stores(), w.deps.decryptPayload), 'a kept record is not a pending transfer').toEqual([]);

    const recorded = captureHistory(w);
    await passLater(w);

    expect(recorded).toEqual([{ transferId, phase: 'sent', committedAmount: '1000' }]);
    expect(await outbox(w)).toEqual([]);
  });

  it('O4 an acknowledged POST leaves nothing in the outbox', async () => {
    const w = makeWorld();
    const plan = await w.plan({ tokens: [await w.seed(1000n)], amount: '1000' });
    const recorded = captureHistory(w);

    await w.machine().run(plan);
    await w.flushTail();

    expect(recorded).toHaveLength(1);
    expect(await outbox(w)).toEqual([]);
  });

  it('O5 a re-post that throws keeps the record for the next pass; one whose payload cannot be read is dropped unposted', async () => {
    const w = makeWorld();
    await sentWithRecordKept(w);
    let calls = 0;
    w.deps.recordHistory = async () => {
      calls += 1;
      throw new Error('history down');
    };

    await passLater(w);
    expect(calls).toBe(1);
    expect(await outbox(w), 'a retry may still record it').toHaveLength(1);

    const [kept] = await w.stores().sentOutbox.list();
    await w.stores().sentOutbox.upsert({ ...kept!, payloadEnvelope: 'not-an-envelope' });
    await passLater(w);
    expect(calls, 'nothing is posted for a payload no retry can read').toBe(1);
    expect(await outbox(w)).toEqual([]);
  });

  it('O6 a re-post that never answers holds no pass, and the next pass starts no second POST for it', async () => {
    const w = makeWorld();
    await sentWithRecordKept(w);
    let calls = 0;
    w.deps.recordHistory = () => {
      calls += 1;
      return new Promise<never>(() => undefined);
    };
    const converger = convergerOf(w);

    await passLater(w, converger);
    await passLater(w, converger);

    expect(calls).toBe(1);
    expect(await outbox(w)).toHaveLength(1);
  });

  it('O7 a pass never re-posts the record of a transfer still in process: its attempt posts its own', async () => {
    const w = makeWorld();
    const transferId = await sentWithRecordKept(w);
    const recorded = captureHistory(w);
    const active = new ActiveOps();
    active.add(transferId);

    await passLater(w, convergerOf(w, active));
    expect(recorded).toEqual([]);

    active.delete(transferId);
    await passLater(w, convergerOf(w, active));
    expect(recorded).toHaveLength(1);
    expect(await outbox(w)).toEqual([]);
  });

  it('O10 a pass that resumes an intent posts its record once: the re-post skips a record kept during the pass', async () => {
    const w = makeWorld();
    const transferId = await openAfterFailedApply(w);
    let calls = 0;
    let answer: () => void = () => undefined;
    w.deps.recordHistory = () => {
      calls += 1;
      return new Promise<void>((resolve) => {
        answer = resolve;
      });
    };

    await passLater(w); // resumes, applies and closes; its own POST is still in flight

    expect(w.api.inspectIntent(w.caller, transferId)?.status).toBe('completed');
    expect(calls, "only the attempt's POST").toBe(1);
    answer();
    await w.flushTail();
    expect(await outbox(w)).toEqual([]);
  });

  it('O11 every attempt carries the time the record was kept, a later re-post included', async () => {
    const w = makeWorld();
    const keptAt = w.clock.t;
    const stamps: (number | undefined)[] = [];
    w.deps.recordHistory = async ({ timestamp }) => {
      stamps.push(timestamp);
      return stamps.length > 1 ? undefined : false; // the first POST fails, the re-post lands
    };

    await w.machine().run(await w.plan({ tokens: [await w.seed(1000n)], amount: '1000' }));
    await w.flushTail();
    await passLater(w);

    expect(stamps).toEqual([keptAt, keptAt]);
    expect(await outbox(w)).toEqual([]);
  });

  it("O12 a kept record arms the heartbeat; an acknowledged POST and a pass's own failed re-post do not", async () => {
    const w = makeWorld();
    let arms = 0;
    w.deps.armHeartbeat = () => {
      arms += 1;
    };
    captureHistory(w);
    await w.machine().run(await w.plan({ tokens: [await w.seed(1000n)], amount: '1000' }));
    await w.flushTail();
    expect(arms, 'acknowledged: nothing kept').toBe(0);

    await sentWithRecordKept(w);
    expect(arms, 'kept: an idle wallet must run a pass').toBe(1);

    await passLater(w); // the re-post fails again: the running heartbeat's own backoff decides
    expect(arms).toBe(1);
  });

  it('O8 the heartbeat counts a kept record as work until it is posted', async () => {
    const w = makeWorld();
    await sentWithRecordKept(w);
    const converger = convergerOf(w);
    expect(await converger.pendingWork()).toBe(true);

    captureHistory(w);
    await passLater(w, converger);
    expect(await converger.pendingWork()).toBe(false);
  });

  it('O9 an outbox that cannot be written fails nothing: the send settles and its POST still leaves', async () => {
    const w = makeWorld();
    w.kv.failWriteKeys.add(STORE_KEYS.sentOutbox);
    const plan = await w.plan({ tokens: [await w.seed(1000n)], amount: '1000' });
    const recorded = captureHistory(w);

    await expect(w.machine().run(plan)).resolves.toMatchObject({ deliveryPending: false });
    await w.flushTail();

    expect(recorded).toEqual([{ transferId: plan.transferId, phase: 'sent', committedAmount: '1000' }]);
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('completed');
  });
});
