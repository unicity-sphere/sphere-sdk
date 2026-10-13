import { describe, expect, it } from 'vitest';

import { ProofUnconfirmedError, TransferConflictError } from '../../../token-engine/errors';
import { resumeAll } from '../../../modules/payments-v2/machine/resume';
import { createMachineStores } from '../../../modules/payments-v2/machine/journal';
import { STORE_KEYS, type IntentBackstopEntry } from '../../../modules/payments-v2/stores';
import { FakeApiError, ValidationFailedError } from './fakes/FakeWalletApi';
import { COIN, makeWorld, opKey, type World } from './machine-harness';

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
      coinId: plan.payload.kind === 'coin' ? plan.payload.coinId : '',
      committedTokenIds: [tokenA.blob.tokenId],
    });
    expect(w.api.inspectIntent(w.caller, 'partial-1')?.status).toBe('completed');
  });

  it('#745 review: a conflict does NOT license settling when another leg failed ordinarily', async () => {
    // summarize ranks conflict above 'other', so an intent holding BOTH used to
    // read as merely-conflicted and settle. The ordinarily-failed leg is in
    // neither committed[] nor conflicts[], so its amount vanished from the
    // shortfall and the recipient was quietly underpaid on a CLOSED intent.
    const w = makeWorld();
    const tokenA = await w.seed(500n);
    const tokenB = await w.seed(300n);
    const tokenC = await w.seed(200n);
    const plan = await w.plan({
      tokens: [tokenA, tokenB, tokenC],
      amount: '1000',
      transferId: 'masked-1',
    });
    const pue = new ProofUnconfirmedError('submit lost in transit');
    // Both B and C must stay UNjournaled, so resume re-certifies them (a
    // journaled leg is replayed from the journal and never re-run).
    w.engine.beforeOp = (key) => {
      if (key === 'masked-1:1' || key === 'masked-1:2') throw pue;
    };
    w.overrides.deliver = fail500;
    await expect(w.machine().run(plan)).rejects.toBe(pue);
    w.engine.beforeOp = null;
    delete w.overrides.deliver;

    // On resume: B is a clean conflict, C fails with an ordinary error.
    await w.engine.foreignSpend(tokenB);
    w.engine.afterOp = (key) => (key === 'masked-1:2' ? new Error('storage exploded') : null);

    await resumeAll(w.deps);
    w.engine.afterOp = null;

    // The intent must stay OPEN — nothing settled, no shortfall claiming the
    // transfer is finished, and C's source is untouched.
    expect(w.api.inspectIntent(w.caller, 'masked-1')?.status).toBe('open');
    expect(await createMachineStores(w.kv).shortfalls.getByKey('masked-1')).toBeUndefined();
    expect(w.completes.map((c) => c.transferId)).not.toContain('masked-1');
    expect(w.api.inspectInventoryRow(w.caller, tokenC.blob.tokenId)?.status).toBe('active');
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
    // #835: the row stays open until the server confirms the abort, so the send is not clean.
    const err = await w.machine().run(plan).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toMatchObject({ code: 'SEND_SYNC_PENDING', transferId: plan.transferId });
    expect(((err as { cause?: Error }).cause as Error).message).toBe('clean pre-submit reject');
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

  it('#676 + #835: a locally-aborted intent whose server abort fails again is reported failed, not conflicted', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    w.engine.beforeOp = () => {
      throw new Error('clean pre-submit reject');
    };
    w.overrides.abort = fail500;
    await expect(w.machine().run(plan)).rejects.toMatchObject({ code: 'SEND_SYNC_PENDING' });
    w.engine.beforeOp = null;
    const engineCallsAfterSend = w.engine.transferCalls.length;

    const report = await resumeAll(w.deps);

    // Until the abort is confirmed another device could still run the open row: a link stays settling.
    expect(report).toEqual({ resumed: [], conflicted: [], failed: [plan.transferId] });
    expect((await w.stores().backstop.getByKey(plan.transferId))?.disposition).toBe('abortPending');
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('open');
    expect(w.engine.transferCalls.length).toBe(engineCallsAfterSend);

    delete w.overrides.abort;
    const next = await resumeAll(w.deps);

    expect(next.conflicted).toEqual([plan.transferId]);
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('aborted');
    expect(await w.stores().backstop.getByKey(plan.transferId)).toBeUndefined();
    expect(w.engine.transferCalls.length).toBe(engineCallsAfterSend);
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

describe('resume refuses a durable intent it cannot safely execute (#777)', () => {
  /** Stage a raw intent the way a foreign/newer client would have written it. */
  async function stageRawIntent(w: World, transferId: string, payload: unknown): Promise<void> {
    await w.api.putIntent(w.caller, {
      transferId,
      payload: `enc:${JSON.stringify(payload)}`,
      requiresSeedClose: false,
    });
  }

  it('refuses an EXPLICIT unknown kind rather than running it under coin semantics', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const id = 'c0000000-0000-4000-8000-000000000001';
    // Coin-SHAPED, so only the discriminant tells it apart. Migrating this to
    // 'coin' would execute a payload written for semantics this client lacks.
    await stageRawIntent(w, id, {
      v: 2,
      kind: 'swap',
      recipient: w.recipientHex,
      coinId: COIN,
      amount: '1000',
      direct: [token.blob.tokenId],
    });

    const report = await resumeAll(w.deps);

    expect(report.failed).toContain(id);
    expect(report.resumed).not.toContain(id);
    expect(w.engine.transferCalls).toHaveLength(0);
    expect(w.api.inspectIntent(w.caller, id)?.status).toBe('open');
  });

  it('still migrates an ABSENT kind to coin — the only shape written before #777', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const id = 'c0000000-0000-4000-8000-000000000002';
    await stageRawIntent(w, id, {
      v: 2,
      recipient: w.recipientHex,
      coinId: COIN,
      amount: '1000',
      direct: [token.blob.tokenId],
      spentStates: {
        [token.blob.tokenId]: await stateOfToken(w, token),
      },
    });

    const report = await resumeAll(w.deps);

    expect(report.failed).not.toContain(id);
  });

  it('refuses a coinless intent whose source is an UNREADABLE envelope, not just a valued one', async () => {
    // `bare_collection` decodes to value === null exactly like a coinless token, so
    // a value check passes it through. The envelope is the question.
    const w = makeWorld();
    const token = await w.seed(1000n);
    const id = 'c0000000-0000-4000-8000-000000000004';
    w.engine.forceEnvelope(token.blob.tokenId, 'bare_collection');
    await stageRawIntent(w, id, {
      v: 2,
      kind: 'whole',
      recipient: w.recipientHex,
      direct: [token.blob.tokenId],
      spentStates: { [token.blob.tokenId]: await stateOfToken(w, token) },
    });

    const report = await resumeAll(w.deps);

    expect(report.failed).toContain(id);
    expect(w.engine.transferCalls).toHaveLength(0);
  });

  it("applies the same guards to 0.17.0's 'coinless' spelling of a whole intent", async () => {
    // 0.17.0 wrote kind: 'coinless'; those intents are durable SERVER state, so this
    // client still resumes them — under the same envelope authority, not around it.
    const w = makeWorld();
    const bad = await w.seed(1000n);
    const good = await w.seed(1000n);
    const refused = 'c0000000-0000-4000-8000-000000000005';
    const resumed = 'c0000000-0000-4000-8000-000000000006';
    w.engine.forceEnvelope(bad.blob.tokenId, 'bare_collection');
    await stageRawIntent(w, refused, {
      v: 2,
      kind: 'coinless',
      recipient: w.recipientHex,
      direct: [bad.blob.tokenId],
      spentStates: { [bad.blob.tokenId]: await stateOfToken(w, bad) },
    });
    await stageRawIntent(w, resumed, {
      v: 2,
      kind: 'coinless',
      recipient: w.recipientHex,
      direct: [good.blob.tokenId],
      spentStates: { [good.blob.tokenId]: await stateOfToken(w, good) },
    });

    const report = await resumeAll(w.deps);

    expect(report.failed).toContain(refused);
    expect(report.failed).not.toContain(resumed);
    expect(report.resumed).toContain(resumed);
  });

  it('RESUMES a whole intent whose source carries coins — it moves the token, coins included', async () => {
    // A whole spend is not coinless-only: a valued source travels as-is, and the
    // history row records what it actually carried.
    const w = makeWorld();
    const valued = await w.seed(1000n);
    const id = 'c0000000-0000-4000-8000-000000000003';
    await stageRawIntent(w, id, {
      v: 2,
      kind: 'whole',
      recipient: w.recipientHex,
      direct: [valued.blob.tokenId],
      spentStates: {
        [valued.blob.tokenId]: await stateOfToken(w, valued),
      },
    });

    const report = await resumeAll(w.deps);

    expect(report.failed).not.toContain(id);
    expect(report.resumed).toContain(id);
  });
});

async function stateOfToken(
  w: World,
  token: { blob: { token: Uint8Array } }
): Promise<{ local: string; protocol: string }> {
  const keys = await w.engine.deliveryKeys(token.blob.token);
  return { local: keys.stateHash, protocol: keys.stateHash };
}

// ── #835: the converger ensures a parked intent before anything else ────────

const unavailable = async (): Promise<void> => {
  throw new FakeApiError(503, 'UNAVAILABLE', 'intent store down');
};

/** A send whose every PUT answer was ambiguous: SEND_SYNC_PENDING, entry flagged 'unconfirmed', no row. */
async function parkSend(w: World, plan: Awaited<ReturnType<World['plan']>>): Promise<IntentBackstopEntry> {
  w.overrides.putIntent = unavailable;
  await expect(w.machine().run(plan)).rejects.toMatchObject({ code: 'SEND_SYNC_PENDING', transferId: plan.transferId });
  delete w.overrides.putIntent;
  const parked = await w.stores().backstop.getByKey(plan.transferId);
  expect(parked?.intentPut).toBe('unconfirmed');
  return parked!;
}

function openEntry(transferId: string, extra: Partial<IntentBackstopEntry> = {}): IntentBackstopEntry {
  const payload = { v: 2, kind: 'coin', recipient: 'aa', coinId: COIN, amount: '1', direct: [] };
  return {
    transferId,
    payloadEnvelope: `enc:${JSON.stringify(payload)}`,
    requiresSeedClose: false,
    disposition: 'open',
    createdAt: 1,
    ...extra,
  };
}

async function mailboxSize(w: World): Promise<number> {
  return (await w.api.listMailbox(w.recipientCaller)).entries.length;
}

describe('resume confirms a parked intent before it resumes or sweeps anything (#835)', () => {
  it('a parked entry with no row is re-PUT with its stored bytes, then resumed in the SAME pass under the same transferId', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    const parked = await parkSend(w, plan);
    w.putCalls.length = 0;

    const first = await resumeAll(w.deps);

    expect(w.putCalls).toEqual([
      { transferId: plan.transferId, envelope: parked.payloadEnvelope, requiresSeedClose: parked.requiresSeedClose },
    ]);
    expect(first).toEqual({ resumed: [plan.transferId], conflicted: [], failed: [] });
    expect(w.engine.transferCalls.map((c) => c.key)).toEqual([`${plan.transferId}:0`]);

    const second = await resumeAll(w.deps);

    expect(second).toEqual({ resumed: [], conflicted: [], failed: [] });
    expect(w.putCalls).toHaveLength(1);
    expect(w.engine.transferCalls.map((c) => c.key)).toEqual([`${plan.transferId}:0`]);
    expect(await mailboxSize(w)).toBe(1);
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('completed');
    expect(await w.stores().backstop.getByKey(plan.transferId)).toBeUndefined();
  });

  it('an ambiguous re-PUT keeps the entry flagged across passes — it is never swept', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    await parkSend(w, plan);
    w.overrides.putIntent = unavailable;
    w.putCalls.length = 0;

    for (let pass = 1; pass <= 3; pass++) {
      const report = await resumeAll(w.deps);
      expect(report).toEqual({ resumed: [], conflicted: [], failed: [plan.transferId] });
      expect((await w.stores().backstop.getByKey(plan.transferId))?.intentPut).toBe('unconfirmed');
      expect(w.putCalls).toHaveLength(pass);
    }
    expect(w.engine.transferCalls).toHaveLength(0);
  });

  it('a 422 on the re-PUT proves nothing was ever stored: the entry is dropped and reported conflicted', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    await parkSend(w, plan);
    w.overrides.putIntent = async () => {
      throw new ValidationFailedError('payload refused');
    };

    const report = await resumeAll(w.deps);

    expect(report).toEqual({ resumed: [], conflicted: [plan.transferId], failed: [] });
    expect(await w.stores().backstop.getByKey(plan.transferId)).toBeUndefined();
    expect(w.api.inspectIntent(w.caller, plan.transferId)).toBeUndefined();
    expect(w.engine.transferCalls).toHaveLength(0);
  });

  it('a parked entry whose row already exists is unflagged without a re-PUT and resumed in the same pass', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    // The server stores every PUT and every response is lost.
    w.overrides.putIntent = async () => {
      const call = w.putCalls[w.putCalls.length - 1];
      await w.api.putIntent(w.caller, { transferId: call.transferId, payload: call.envelope, requiresSeedClose: call.requiresSeedClose });
      throw new FakeApiError(0, 'NETWORK', 'response lost');
    };
    await expect(w.machine().run(plan)).rejects.toMatchObject({ code: 'SEND_SYNC_PENDING' });
    delete w.overrides.putIntent;
    expect((await w.stores().backstop.getByKey(plan.transferId))?.intentPut).toBe('unconfirmed');
    w.putCalls.length = 0;

    const report = await resumeAll(w.deps);

    expect(w.putCalls).toEqual([]);
    expect(report).toEqual({ resumed: [plan.transferId], conflicted: [], failed: [] });
    expect(await mailboxSize(w)).toBe(1);
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('completed');
  });

  it('a parked id with an in-process attempt is left alone', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    await parkSend(w, plan);
    w.putCalls.length = 0;

    const report = await resumeAll(w.deps, { isLocallyActive: (id) => id === plan.transferId });

    expect(w.putCalls).toEqual([]);
    expect(report).toEqual({ resumed: [], conflicted: [], failed: [] });
    expect((await w.stores().backstop.getByKey(plan.transferId))?.intentPut).toBe('unconfirmed');
  });

  it('an entry with no flag, or a pending one, is never re-PUT: without a row it is S1 residue', async () => {
    const w = makeWorld();
    await w.stores().backstop.upsert(openEntry('unflagged'));
    await w.stores().backstop.upsert(openEntry('never-acked', { intentPut: 'pending' }));

    const report = await resumeAll(w.deps);

    expect(w.putCalls).toEqual([]);
    expect(report).toEqual({ resumed: [], conflicted: [], failed: [] });
    expect(await w.stores().backstop.list()).toEqual([]);
  });

  it('a pending entry the machine parked in memory (its flag write failed) is confirmed like a flagged one', async () => {
    const w = makeWorld();
    const entry = openEntry('parked-in-memory', { intentPut: 'pending' });
    await w.stores().backstop.upsert(entry);
    const isParked = (id: string): boolean => id === entry.transferId;

    const report = await resumeAll(w.deps, { isParked });

    expect(w.putCalls).toEqual([{ transferId: entry.transferId, envelope: entry.payloadEnvelope, requiresSeedClose: false }]);
    // Confirmed, then run in the same pass: this synthetic intent has no legs, so it simply closes.
    expect(report).toEqual({ resumed: [entry.transferId], conflicted: [], failed: [] });
    expect(w.api.inspectIntent(w.caller, entry.transferId)?.status).toBe('completed');
  });

  it('a deferred pass (unreadable backstop) says so through onDeferred and confirms nothing', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    await parkSend(w, plan);
    w.putCalls.length = 0;
    w.kv.failKeys.add(STORE_KEYS.intentBackstop);
    let deferred = 0;

    const report = await resumeAll(w.deps, { onDeferred: () => (deferred += 1) });

    expect(deferred).toBe(1);
    expect(report).toEqual({ resumed: [], conflicted: [], failed: [] });
    expect(w.putCalls).toEqual([]);
  });
});

describe('resume never lets a conflict mask another outcome, and never applies before the shortfall (#835)', () => {
  it('a delivered leg whose re-certification is unconfirmed beside a conflict is not aborted and not reported conflicted', async () => {
    const w = makeWorld();
    const tokenB = await w.seed(400n);
    const tokenA = await w.seed(600n);
    await w.engine.foreignSpend(tokenB);
    // B (op 0) conflicts, A (op 1) certifies and is delivered: a pure-conflict partial.
    const plan = await w.plan({ tokens: [tokenB, tokenA], amount: '1000', transferId: 'mask-c' });
    await expect(w.machine().run(plan)).rejects.toBeInstanceOf(TransferConflictError);
    expect(await mailboxSize(w)).toBe(1);
    const transfer = w.engine.transfer.bind(w.engine);
    w.engine.transfer = async (params, options) => {
      if (opKey(options) === 'mask-c:1') throw new ProofUnconfirmedError('gateway blip while re-certifying');
      return transfer(params, options);
    };
    const mark = w.log.length;

    const report = await resumeAll(w.deps);

    expect(report).toEqual({ resumed: [], conflicted: [], failed: ['mask-c'] });
    expect(w.log.slice(mark)).not.toContain('abortIntent');
    expect(w.api.inspectIntent(w.caller, 'mask-c')?.status).toBe('open');
    expect((await w.stores().backstop.getByKey('mask-c'))?.disposition).toBe('open');
  });

  it('the shortfall is durable before ANY apply: no shortfall, no apply — and on recovery shortfall, apply, complete', async () => {
    const w = makeWorld();
    const tokenA = await w.seed(600n);
    const tokenB = await w.seed(400n);
    await w.engine.foreignSpend(tokenB);
    const plan = await w.plan({ tokens: [tokenA, tokenB], amount: '1000', transferId: 'order-1' });
    await expect(w.machine().run(plan)).rejects.toBeInstanceOf(TransferConflictError);
    w.kv.failWriteKeys.add(STORE_KEYS.shortfalls);

    const report = await resumeAll(w.deps);

    expect(report.failed).toEqual(['order-1']);
    expect(w.applied).toEqual([]);
    expect(w.api.inspectIntent(w.caller, 'order-1')?.status).toBe('open');
    expect(await w.stores().shortfalls.getByKey('order-1')).toBeUndefined();

    w.kv.failWriteKeys.delete(STORE_KEYS.shortfalls);
    const set = w.kv.set.bind(w.kv);
    w.kv.set = async <T>(key: string, value: T): Promise<void> => {
      await set(key, value);
      if (key === STORE_KEYS.shortfalls) w.log.push('shortfall');
    };
    const mark = w.log.length;

    const recovered = await resumeAll(w.deps);

    expect(recovered.resumed).toEqual(['order-1']);
    const order = w.log.slice(mark).filter((l) => l === 'shortfall' || l === 'applyDelta' || l === 'completeIntent');
    expect(order).toEqual(['shortfall', 'applyDelta', 'completeIntent']);
    expect(w.applied.map((a) => a.spent)).toEqual([[tokenA.blob.tokenId]]);
  });

  it('a close that fails after the partial apply reports closed: false and keeps the backstop; the next pass converges it', async () => {
    const w = makeWorld();
    const tokenA = await w.seed(600n);
    const tokenB = await w.seed(400n);
    await w.engine.foreignSpend(tokenB);
    const plan = await w.plan({ tokens: [tokenA, tokenB], amount: '1000', transferId: 'close-1' });
    const machine = w.machine();
    await expect(machine.run(plan)).rejects.toBeInstanceOf(TransferConflictError);
    const histories: { transferId: string; phase: string; committedAmount: string }[] = [];
    w.deps.recordHistory = async ({ transferId, phase, committedAmount }) => {
      histories.push({ transferId, phase, committedAmount });
    };
    let failClose = true;
    w.overrides.complete = async () => {
      if (failClose) throw new FakeApiError(503, 'UNAVAILABLE', 'complete down');
    };

    const outcome = await machine.resumeIntent({
      transferId: plan.transferId,
      payload: plan.payload,
      sources: plan.sources,
      journaled: await w.stores().deliveryJournal.byTransfer(plan.transferId),
    });

    expect(outcome.closed).toBe(false);
    expect(outcome.partial).toMatchObject({ transferId: 'close-1', remainingAmount: '400' });
    expect(histories).toEqual([{ transferId: 'close-1', phase: 'resumed', committedAmount: '600' }]);
    expect(await w.stores().backstop.getByKey('close-1')).toBeDefined();
    expect((await w.stores().shortfalls.getByKey('close-1'))?.remainingAmount).toBe('400');
    expect(w.applied.map((a) => a.spent)).toEqual([[tokenA.blob.tokenId]]);

    failClose = false;
    await resumeAll(w.deps);

    expect(w.api.inspectIntent(w.caller, 'close-1')?.status).toBe('completed');
    expect(await w.stores().backstop.getByKey('close-1')).toBeUndefined();
    expect((await w.stores().shortfalls.getByKey('close-1'))?.remainingAmount).toBe('400');
  });

  it('a settled partial that closes reports closed: true', async () => {
    const w = makeWorld();
    const tokenA = await w.seed(600n);
    const tokenB = await w.seed(400n);
    await w.engine.foreignSpend(tokenB);
    const plan = await w.plan({ tokens: [tokenA, tokenB], amount: '1000', transferId: 'close-2' });
    const machine = w.machine();
    await expect(machine.run(plan)).rejects.toBeInstanceOf(TransferConflictError);

    const outcome = await machine.resumeIntent({
      transferId: plan.transferId,
      payload: plan.payload,
      sources: plan.sources,
      journaled: await w.stores().deliveryJournal.byTransfer(plan.transferId),
    });

    expect(outcome.closed).toBe(true);
    expect(await w.stores().backstop.getByKey('close-2')).toBeUndefined();
  });
});

describe('a local abort record goes only once the server says the row cannot run (#835)', () => {
  async function tombstone(w: World, transferId: string): Promise<IntentBackstopEntry> {
    const entry = openEntry(transferId, { disposition: 'abortPending' });
    await w.stores().backstop.upsert(entry);
    return entry;
  }

  it('an unlisted tombstone whose abort answers 2xx is dropped', async () => {
    const w = makeWorld();
    const entry = await tombstone(w, 'aborted-row');
    await w.api.putIntent(w.caller, { transferId: entry.transferId, payload: entry.payloadEnvelope });
    await w.api.abortIntent(w.caller, entry.transferId);

    await resumeAll(w.deps);

    expect(w.log).toContain('abortIntent');
    expect(await w.stores().backstop.getByKey(entry.transferId)).toBeUndefined();
  });

  it('an unlisted tombstone whose abort answers 404 NOT_FOUND (no row) is dropped', async () => {
    const w = makeWorld();
    const entry = await tombstone(w, 'no-row');

    await resumeAll(w.deps);

    expect(w.log).toContain('abortIntent');
    expect(await w.stores().backstop.getByKey(entry.transferId)).toBeUndefined();
  });

  it.each([
    ['a 500', () => new FakeApiError(500, 'INTERNAL', 'injected outage')],
    ['an unrouted 404', () => new FakeApiError(404, 'HTTP_404', 'no such route')],
  ])('an unlisted tombstone whose abort answers %s is kept', async (_label, make) => {
    const w = makeWorld();
    const entry = await tombstone(w, 'abort-fails');
    w.overrides.abort = async () => {
      throw make();
    };

    await resumeAll(w.deps);

    expect(await w.stores().backstop.getByKey(entry.transferId)).toEqual(entry);
  });

  it('a tombstone of an in-process attempt is untouched: no abort call, no removal', async () => {
    const w = makeWorld();
    const entry = await tombstone(w, 'active-1');

    await resumeAll(w.deps, { isLocallyActive: (id) => id === entry.transferId });

    expect(w.log).not.toContain('abortIntent');
    expect(await w.stores().backstop.getByKey(entry.transferId)).toEqual(entry);
  });

  it('removeIfUnchanged removes only the exact entry it was judged against', async () => {
    const w = makeWorld();
    const stores = w.stores();
    const entry = openEntry('cas-1');
    await stores.backstop.upsert(entry);

    expect(await stores.backstop.removeIfUnchanged('cas-1', { ...entry, intentPut: 'unconfirmed' })).toBe(false);
    expect(await stores.backstop.getByKey('cas-1')).toEqual(entry);
    expect(await stores.backstop.removeIfUnchanged('cas-1', entry)).toBe(true);
    expect(await stores.backstop.getByKey('cas-1')).toBeUndefined();
    expect(await stores.backstop.removeIfUnchanged('cas-1', entry)).toBe(false);
  });
});
