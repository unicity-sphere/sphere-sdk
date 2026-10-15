// #842: SENT history is posted BESIDE the apply, never gated on POST /complete or on
// the apply's answer. The apply itself completes an unflagged intent, so once it
// commits the row is never listed open again: the next pass sweeps its backstop as
// S1 residue and records nothing. A SENT POST that waited for the apply's answer or
// for the close would be lost for good, leaving history() empty for money that left.

import { describe, expect, it } from 'vitest';

import { isPossiblyCommittedSendOutcome } from '../../../core/errors';
import { TransferConflictError } from '../../../token-engine/errors';
import { resumeAll } from '../../../modules/payments-v2/machine/resume';
import { FakeApiError } from './fakes/FakeWalletApi';
import { makeWorld, type World } from './machine-harness';

interface Recorded {
  transferId: string;
  phase: string;
  committedAmount: string;
}

function captureHistory(w: World): Recorded[] {
  const recorded: Recorded[] = [];
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

/** The server applies the delta, then the process dies before the answer arrives: it never returns. */
function applyThenDie(w: World): { revive(): void } {
  const storage = w.deps.storage;
  const apply = storage.applyDelta.bind(storage);
  storage.applyDelta = async (delta) => {
    await apply(delta);
    return new Promise<never>(() => undefined);
  };
  return {
    revive: () => {
      storage.applyDelta = apply;
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

/** A send whose apply failed before the server acted: certified, delivered, still open. */
async function openAfterFailedApply(w: World): Promise<string> {
  const token = await w.seed(1000n);
  const plan = await w.plan({ tokens: [token], amount: '1000' });
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

  it('C1 run(): the apply commits and the process dies before its answer — SENT is already recorded, and survives the restart sweep', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    const recorded = captureHistory(w);
    const death = applyThenDie(w);

    void w.machine().run(plan);
    await w.flushTail();

    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status, 'the apply committed').toBe('completed');
    expect(recorded).toEqual([{ transferId: plan.transferId, phase: 'sent', committedAmount: '1000' }]);

    // Restart: a fresh pass over the same server and durable stores.
    death.revive();
    const report = await resumeAll(w.deps);
    expect(report).toMatchObject({ resumed: [], conflicted: [], failed: [] });
    expect(await w.stores().backstop.getByKey(plan.transferId), 'the restart sweep removed the backstop').toBeUndefined();
    expect(recorded, 'exactly one SENT row, from before the crash').toHaveLength(1);
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
});
