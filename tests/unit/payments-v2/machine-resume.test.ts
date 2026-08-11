import { describe, expect, it } from 'vitest';

import { ProofUnconfirmedError } from '../../../token-engine/errors';
import { resumeAll } from '../../../modules/payments-v2/machine/resume';
import { createMachineStores } from '../../../modules/payments-v2/machine/journal';
import { STORE_KEYS } from '../../../modules/payments-v2/stores';
import { FakeApiError } from './fakes/FakeWalletApi';
import { makeWorld, type World } from './machine-harness';

const fail500 = async (): Promise<void> => {
  throw new FakeApiError(500, 'INTERNAL', 'injected outage');
};

/** A send whose certification + journal landed but delivery AND apply failed: intent open, blob journaled. */
async function sendCrashedPreApply(w: World, plan: Awaited<ReturnType<World['plan']>>): Promise<void> {
  w.overrides.deliver = fail500;
  w.overrides.applyDelta = fail500;
  await expect(w.machine().run(plan)).rejects.toMatchObject({ code: 'SEND_SYNC_PENDING' });
  delete w.overrides.deliver;
  delete w.overrides.applyDelta;
  expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('open');
}

describe('TransferMachine resume path (§5.5 P6 — same machine, rehydrated)', () => {
  it('#621: a journaled leg is re-delivered, never re-certified — the engine is not called again for it', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    await sendCrashedPreApply(w, plan);
    expect(await w.stores().deliveryJournal.byTransfer(plan.transferId)).toHaveProperty('size', 1);
    const engineCallsAfterSend = w.engine.transferCalls.length;

    const report = await resumeAll(w.deps);

    expect(report.resumed).toEqual([plan.transferId]);
    expect(w.engine.transferCalls.length).toBe(engineCallsAfterSend);
    expect((await w.api.listMailbox(w.recipientCaller)).entries).toHaveLength(1);
    expect(w.applied.at(-1)).toEqual({ transferId: plan.transferId, spent: [token.blob.tokenId], added: [] });
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('completed');
    expect(await w.stores().deliveryJournal.list()).toHaveLength(0);
    expect(await w.stores().backstop.getByKey(plan.transferId)).toBeUndefined();
  });

  it('#631: resume converges an indeterminate op under the SAME (transferId, opIndex) — one realization, no second spend', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    const pue = new ProofUnconfirmedError('proof fetch inconclusive');
    w.engine.afterOp = (key) => (key === `${plan.transferId}:0` ? pue : null);
    await expect(w.machine().run(plan)).rejects.toBe(pue);
    w.engine.afterOp = null;
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('open');

    const report = await resumeAll(w.deps);

    expect(report.resumed).toEqual([plan.transferId]);
    const keys = w.engine.transferCalls.map((c) => c.key);
    expect(keys).toEqual([`${plan.transferId}:0`, `${plan.transferId}:0`]);
    expect(w.deposits).toEqual([{ transferId: plan.transferId, tokenId: token.blob.tokenId }]);
    expect(w.applied.at(-1)?.spent).toEqual([token.blob.tokenId]);
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('completed');
  });

  it('#744: a resume whose journal write fails keeps the intent OPEN — the certified blob is never destroyed', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    const pue = new ProofUnconfirmedError('proof fetch inconclusive');
    w.engine.afterOp = (key) => (key === `${plan.transferId}:0` ? pue : null);
    await expect(w.machine().run(plan)).rejects.toBe(pue);
    w.engine.afterOp = null;
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('open');
    expect(await w.stores().deliveryJournal.list()).toHaveLength(0);

    // The op now certifies, but its #621 journal entry cannot be written
    // (quota, aborted transaction, torn-down storage). The blob exists only in
    // memory: closing the intent here would spend the source and destroy it.
    w.kv.failWriteKeys.add(STORE_KEYS.deliveryJournal);

    const report = await resumeAll(w.deps);

    // NOT reported as resumed, and above all not settled.
    expect(report.resumed).not.toContain(plan.transferId);
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('open');
    expect(w.completes.map((c) => c.transferId)).not.toContain(plan.transferId);
    expect(w.applied.map((a) => a.transferId)).not.toContain(plan.transferId);
    expect((await w.api.listMailbox(w.recipientCaller)).entries).toHaveLength(0);

    // Storage recovers: the SAME transferId converges, paying the recipient once.
    w.kv.failWriteKeys.delete(STORE_KEYS.deliveryJournal);
    const recovered = await resumeAll(w.deps);

    expect(recovered.resumed).toEqual([plan.transferId]);
    expect((await w.api.listMailbox(w.recipientCaller)).entries).toHaveLength(1);
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('completed');
    expect(w.applied.at(-1)?.spent).toEqual([token.blob.tokenId]);
  });

  it('audit#4: a conflicted resume leg is never in spent[]; the delivered leg completes with the remainder-only shortfall', async () => {
    const w = makeWorld();
    const tokenA = await w.seed(600n);
    const tokenB = await w.seed(400n);
    const plan = await w.plan({ tokens: [tokenA, tokenB], amount: '1000', transferId: 'partial-1' });
    const pue = new ProofUnconfirmedError('submit lost in transit');
    w.engine.beforeOp = (key) => {
      if (key === 'partial-1:1') throw pue;
    };
    w.overrides.deliver = fail500;
    await expect(w.machine().run(plan)).rejects.toBe(pue);
    w.engine.beforeOp = null;
    delete w.overrides.deliver;
    await w.engine.foreignSpend(tokenB);

    const report = await resumeAll(w.deps);

    expect(report.resumed).toEqual(['partial-1']);
    expect(report.conflicted).toEqual([]);
    expect(w.applied).toHaveLength(1);
    expect(w.applied[0].spent).toEqual([tokenA.blob.tokenId]);
    expect(w.applied[0].spent).not.toContain(tokenB.blob.tokenId);
    expect(w.api.inspectInventoryRow(w.caller, tokenB.blob.tokenId)?.status).toBe('active');
    expect(w.api.inspectInventoryRow(w.caller, tokenA.blob.tokenId)?.status).toBe('removed');
    const shortfall = await createMachineStores(w.kv).shortfalls.getByKey('partial-1');
    expect(shortfall).toMatchObject({
      remainingAmount: '400',
      coinId: plan.payload.coinId,
      committedTokenIds: [tokenA.blob.tokenId],
    });
    expect(w.api.inspectIntent(w.caller, 'partial-1')?.status).toBe('completed');
  });

  it('#690: the shortfall record is durable BEFORE complete fires — a crash between complete and the surface finds it on reload', async () => {
    const w = makeWorld();
    const tokenA = await w.seed(600n);
    const tokenB = await w.seed(400n);
    const plan = await w.plan({ tokens: [tokenA, tokenB], amount: '1000', transferId: 'partial-2' });
    w.engine.beforeOp = (key) => {
      if (key === 'partial-2:1') throw new ProofUnconfirmedError('lost');
    };
    w.overrides.deliver = fail500;
    await w.machine().run(plan).catch(() => undefined);
    w.engine.beforeOp = null;
    delete w.overrides.deliver;
    await w.engine.foreignSpend(tokenB);
    let shortfallVisibleAtComplete = false;
    w.overrides.complete = async (transferId) => {
      shortfallVisibleAtComplete = (await createMachineStores(w.kv).shortfalls.getByKey(transferId)) !== undefined;
    };

    await resumeAll(w.deps);

    expect(shortfallVisibleAtComplete).toBe(true);
    const reloaded = await createMachineStores(w.kv).shortfalls.getByKey('partial-2');
    expect(reloaded?.remainingAmount).toBe('400');
  });

  it('#676: a locally-aborted intent is converged to a server abort and NEVER re-executed', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    w.engine.beforeOp = () => {
      throw new Error('clean pre-submit reject');
    };
    w.overrides.abort = fail500;
    await expect(w.machine().run(plan)).rejects.toThrow('clean pre-submit reject');
    w.engine.beforeOp = null;
    delete w.overrides.abort;
    expect((await w.stores().backstop.getByKey(plan.transferId))?.disposition).toBe('abortPending');
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('open');
    const engineCallsAfterSend = w.engine.transferCalls.length;

    const report = await resumeAll(w.deps);

    expect(report.conflicted).toEqual([plan.transferId]);
    expect(report.resumed).toEqual([]);
    expect(w.engine.transferCalls.length).toBe(engineCallsAfterSend);
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('aborted');
    expect(await w.stores().backstop.getByKey(plan.transferId)).toBeUndefined();
    expect(w.log.filter((l) => l === 'applyDelta')).toHaveLength(0);
  });

  it('#676: a backstop read failure defers EVERY intent and classifies nothing', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    await sendCrashedPreApply(w, plan);
    const engineCallsAfterSend = w.engine.transferCalls.length;
    const logMark = w.log.length;
    w.kv.failKeys.add(STORE_KEYS.intentBackstop);

    const report = await resumeAll(w.deps);

    expect(report).toEqual({ resumed: [], conflicted: [], failed: [] });
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('open');
    expect(w.engine.transferCalls.length).toBe(engineCallsAfterSend);
    expect(w.log.slice(logMark)).not.toContain('abortIntent');
    expect(w.log.slice(logMark)).not.toContain('completeIntent');
    expect(w.log.slice(logMark)).not.toContain('deliver');
  });

  it('a v:1 payload is refused into the failed bucket with the intent left untouched', async () => {
    const w = makeWorld();
    await w.seed(1000n);
    const legacyPayload = `enc:${JSON.stringify({ v: 1, recipient: w.recipientHex, coinId: 'aa', amount: '5', direct: ['dead'] })}`;
    await w.api.putIntent(w.caller, { transferId: 'legacy-1', payload: legacyPayload });

    const report = await resumeAll(w.deps);

    expect(report.failed).toEqual(['legacy-1']);
    expect(report.conflicted).toEqual([]);
    expect(w.api.inspectIntent(w.caller, 'legacy-1')?.status).toBe('open');
    expect(w.log).not.toContain('abortIntent');
    expect(w.engine.transferCalls).toHaveLength(0);
  });

  it('#634: a resumed split re-runs THROUGH the engine (never the journal shortcut) and recovers the change output', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ amount: '600', split: { token, splitAmount: '600', remainderAmount: '400' } });
    await sendCrashedPreApply(w, plan);
    expect(w.engine.splitCalls).toHaveLength(1);

    const report = await resumeAll(w.deps);

    expect(report.resumed).toEqual([plan.transferId]);
    expect(w.engine.splitCalls.map((c) => c.key)).toEqual([`${plan.transferId}:0`, `${plan.transferId}:0`]);
    expect(w.applied.at(-1)?.added).toHaveLength(1);
    expect(w.completes.at(-1)?.signature).toBeDefined();
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('completed');
  });

  it('E.2: a pure-conflict resume (nothing delivered) aborts the intent, applies nothing, records no shortfall', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    w.engine.beforeOp = () => {
      throw new ProofUnconfirmedError('submit lost in transit');
    };
    await w.machine().run(plan).catch(() => undefined);
    w.engine.beforeOp = null;
    await w.engine.foreignSpend(token);
    const applyCallsAfterSend = w.log.filter((l) => l === 'applyDelta').length;

    const report = await resumeAll(w.deps);

    expect(report.conflicted).toEqual([plan.transferId]);
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('aborted');
    expect(w.log.filter((l) => l === 'applyDelta')).toHaveLength(applyCallsAfterSend);
    expect(await w.stores().shortfalls.list()).toHaveLength(0);
    expect(w.completes).toHaveLength(0);
    expect(await w.stores().backstop.getByKey(plan.transferId)).toBeUndefined();
  });

  it('duplicate resume is idempotent: a completed intent is unlisted and nothing re-runs', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    await sendCrashedPreApply(w, plan);
    await resumeAll(w.deps);
    const engineCalls = w.engine.transferCalls.length;
    const deposits = w.deposits.length;
    const applies = w.applied.length;

    const second = await resumeAll(w.deps);

    expect(second).toEqual({ resumed: [], conflicted: [], failed: [] });
    expect(w.engine.transferCalls.length).toBe(engineCalls);
    expect(w.deposits.length).toBe(deposits);
    expect(w.applied.length).toBe(applies);
  });
});
