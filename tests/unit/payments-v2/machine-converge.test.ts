/**
 * #844: TransferMachine.convergeRun — the in-process converge of a conflicted run() reuses what
 * that run() settled in this process (its certified legs, its proven conflicts, its deposit
 * state) and certifies only the ops it never reached, in run()'s CERTIFY_WIDTH waves.
 */
import { describe, expect, it } from 'vitest';

import { isPossiblyCommittedSendOutcome } from '../../../core/errors';
import type { SphereToken } from '../../../token-engine';
import { ProofUnconfirmedError, TransferConflictError } from '../../../token-engine/errors';
import { RATE_LIMIT_DEFER_MS } from '../../../modules/payments-v2/machine/journal';
import { STORE_KEYS } from '../../../modules/payments-v2/stores';
import { FakeApiError, QuotaExceededError } from './fakes/FakeWalletApi';
import { makeWorld, opKey, type World } from './machine-harness';

async function rejectionOf(op: Promise<unknown>): Promise<unknown> {
  return op.then(
    () => {
      throw new Error('expected the operation to reject');
    },
    (err: unknown) => err
  );
}

async function seedMany(w: World, amounts: bigint[]): Promise<SphereToken[]> {
  const tokens: SphereToken[] = [];
  for (const amount of amounts) tokens.push(await w.seed(amount));
  return tokens;
}

const ones = (n: number): bigint[] => Array.from({ length: n }, () => 1n);
const deferredAttentions = (w: World): unknown[] =>
  w.events.filter((e) => e.event === 'transfer:attention' && (e.payload as { code: string }).code === 'delivery:deferred');

describe('#844 convergeRun reuses what run() settled', () => {
  it('M1 settles a partial with no chain op and no deposit for any leg run() settled', async () => {
    const w = makeWorld();
    const a = await w.seed(600n);
    const b = await w.seed(400n);
    await w.engine.foreignSpend(b);
    const plan = await w.plan({ tokens: [a, b], amount: '1000' });
    const machine = w.machine();
    await expect(machine.run(plan)).rejects.toBeInstanceOf(TransferConflictError);
    const calls = w.engine.transferCalls.length;
    const deposits = w.deposits.length;

    const outcome = await machine.convergeRun(plan);

    expect(w.engine.transferCalls).toHaveLength(calls);
    expect(w.deposits).toHaveLength(deposits);
    expect(outcome).toMatchObject({ deliveryPending: false, closed: true });
    expect(outcome.partial.remainingAmount).toBe('400');
    expect(outcome.partial.committedTokenIds).toEqual([a.blob.tokenId]);
    expect(w.applied.map((d) => d.spent)).toEqual([[a.blob.tokenId]]);
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('completed');
  });

  it('M1s reuses a certified split leg: its change from run() is applied, the split never re-runs', async () => {
    const w = makeWorld();
    const a = await w.seed(400n);
    const big = await w.seed(1000n);
    await w.engine.foreignSpend(a);
    const plan = await w.plan({ tokens: [a], amount: '600', split: { token: big, splitAmount: '200', remainderAmount: '800' } });
    const machine = w.machine();
    await expect(machine.run(plan)).rejects.toBeInstanceOf(TransferConflictError);

    const outcome = await machine.convergeRun(plan);

    expect(w.engine.splitCalls).toHaveLength(1);
    expect(outcome.partial.remainingAmount).toBe('400');
    expect(w.applied).toHaveLength(1);
    expect(w.applied[0].spent).toEqual([big.blob.tokenId]);
    expect(w.applied[0].added).toHaveLength(1);
  });

  it('M2 certifies and deposits only the legs run() never reached', async () => {
    const w = makeWorld();
    const tokens = await seedMany(w, ones(22));
    await w.engine.foreignSpend(tokens[3]);
    const plan = await w.plan({ tokens, amount: '22' });
    const machine = w.machine();
    await expect(machine.run(plan)).rejects.toBeInstanceOf(TransferConflictError);
    expect(w.engine.transferCalls).toHaveLength(20);
    const deposits = w.deposits.length;

    const outcome = await machine.convergeRun(plan);

    expect(w.engine.transferCalls.slice(20).map((c) => c.key)).toEqual([`${plan.transferId}:20`, `${plan.transferId}:21`]);
    expect(w.deposits.length - deposits).toBe(2);
    expect(outcome.partial.committedTokenIds).toHaveLength(21);
    expect(outcome.partial.remainingAmount).toBe('1');
  });

  it('M2b the legs run() never reached certify in one wave, and each reports progress beside the legs run() certified', async () => {
    const w = makeWorld();
    const tokens = await seedMany(w, ones(22));
    await w.engine.foreignSpend(tokens[3]);
    const plan = await w.plan({ tokens, amount: '22' });
    const machine = w.machine();
    await expect(machine.run(plan)).rejects.toBeInstanceOf(TransferConflictError);
    let inFlight = 0;
    let widest = 0;
    w.engine.beforeOp = () => {
      inFlight += 1;
      widest = Math.max(widest, inFlight);
    };
    const settle = w.engine.afterOp;
    w.engine.afterOp = (key, kind) => {
      inFlight -= 1;
      return settle?.(key, kind) ?? null;
    };
    const from = w.events.length;

    await machine.convergeRun(plan);

    const progress = w.events
      .slice(from)
      .filter((e) => e.event === 'transfer:updated')
      .map((e) => (e.payload as { status: string; tokenTransfers: unknown[] }));
    expect(progress.map((p) => p.status)).toEqual(['submitted', 'submitted']);
    expect(progress.map((p) => p.tokenTransfers.length), 'run()s 19 legs, then each fresh one').toEqual([20, 21]);
    expect(widest, 'both fresh legs were in flight together').toBe(2);
  });

  it('M3 a fresh leg unconfirmed keeps the intent open and applies nothing; a fresh leg that certified is still named', async () => {
    const w = makeWorld();
    const tokens = await seedMany(w, ones(22));
    await w.engine.foreignSpend(tokens[3]);
    const plan = await w.plan({ tokens, amount: '22' });
    const machine = w.machine();
    await expect(machine.run(plan)).rejects.toBeInstanceOf(TransferConflictError);
    w.engine.afterOp = (key) => (key === `${plan.transferId}:21` ? new ProofUnconfirmedError('no proof (simulated)') : null);

    const err = await rejectionOf(machine.convergeRun(plan));

    expect(err).toBeInstanceOf(ProofUnconfirmedError);
    expect(w.applied).toEqual([]);
    expect(await w.stores().shortfalls.getByKey(plan.transferId)).toBeUndefined();
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('open');
    const named = machine.certifiedSourcesOf(plan);
    expect(named, 'the leg the converge certified').toContain(tokens[20].blob.tokenId);
    expect(named).not.toContain(tokens[21].blob.tokenId);
    expect(named).toHaveLength(20);
  });

  it('M4 a deposit run() could not make stays owed in the journal: reported pending, never retried in process', async () => {
    const w = makeWorld();
    const a = await w.seed(600n);
    const b = await w.seed(400n);
    await w.engine.foreignSpend(b);
    const plan = await w.plan({ tokens: [a, b], amount: '1000' });
    w.overrides.deliver = async () => {
      throw new FakeApiError(500, 'INTERNAL', 'mailbox down');
    };
    const machine = w.machine();
    await expect(machine.run(plan)).rejects.toBeInstanceOf(TransferConflictError);
    delete w.overrides.deliver;
    const attempts = w.delivered.length;

    const outcome = await machine.convergeRun(plan);

    expect(outcome.deliveryPending).toBe(true);
    expect(w.delivered).toHaveLength(attempts);
    const owed = [...(await w.stores().deliveryJournal.byTransfer(plan.transferId)).values()];
    expect(owed.map((e) => e.attempts), 'neither reset nor counted twice').toEqual([1]);
  });

  it('M4b a deposit run() was told to defer (429) keeps its deferral: nothing deposited in process, one delivery:deferred', async () => {
    const w = makeWorld();
    const a = await w.seed(600n);
    const b = await w.seed(400n);
    await w.engine.foreignSpend(b);
    const plan = await w.plan({ tokens: [a, b], amount: '1000' });
    w.overrides.deliver = async () => {
      throw new QuotaExceededError('inbox full', 'max_recipient_entries');
    };
    const machine = w.machine();
    await expect(machine.run(plan)).rejects.toBeInstanceOf(TransferConflictError);
    const deferredUntil = w.clock.t + RATE_LIMIT_DEFER_MS;
    delete w.overrides.deliver;
    const attempts = w.delivered.length;

    const outcome = await machine.convergeRun(plan);

    expect(outcome.deliveryPending).toBe(true);
    expect(w.delivered, 'the deferral is honoured in process too').toHaveLength(attempts);
    expect(w.deposits).toEqual([]);
    const [entry] = [...(await w.stores().deliveryJournal.byTransfer(plan.transferId)).values()];
    expect(entry).toMatchObject({ opIndex: 0, attempts: 0, deferredUntil });
    expect(deferredAttentions(w)).toHaveLength(1);
  });

  it('M5 (defensive: the facade converges only a plan run() settled) a plan with no run record is never converged', async () => {
    const w = makeWorld();
    const a = await w.seed(600n);
    const plan = await w.plan({ tokens: [a], amount: '600' });

    const err = await rejectionOf(w.machine().convergeRun(plan));

    expect(isPossiblyCommittedSendOutcome(err)).toBe(true);
    expect((err as { transferId?: string }).transferId).toBe(plan.transferId);
    expect(w.engine.transferCalls).toHaveLength(0);
    expect(w.applied).toEqual([]);
  });

  it('M6 (defensive: such a run() is possibly-committed, never converged by the facade) a certified leg whose journal write failed is re-certified and journaled, never reused', async () => {
    const w = makeWorld();
    const a = await w.seed(600n);
    const b = await w.seed(400n);
    await w.engine.foreignSpend(b);
    const plan = await w.plan({ tokens: [a, b], amount: '1000' });
    w.kv.failWriteKeys.add(STORE_KEYS.deliveryJournal);
    const machine = w.machine();
    expect(isPossiblyCommittedSendOutcome(await rejectionOf(machine.run(plan)))).toBe(true);
    w.kv.failWriteKeys.delete(STORE_KEYS.deliveryJournal);

    const outcome = await machine.convergeRun(plan);

    expect(w.engine.transferCalls.filter((c) => c.key === opKey({ transferId: plan.transferId, opIndex: 0 }))).toHaveLength(2);
    expect(w.deposits.map((d) => d.transferId)).toEqual([plan.transferId]);
    expect(outcome.partial.committedTokenIds).toEqual([a.blob.tokenId]);
    expect(machine.certifiedSourcesOf(plan), 'named once, though certified twice').toEqual([a.blob.tokenId]);
  });

  it('M7 a split in a wave run() never reached certifies once in the converge: its change applied once, its blob deposited once', async () => {
    const w = makeWorld();
    const tokens = await seedMany(w, ones(20));
    const big = await w.seed(10n);
    await w.engine.foreignSpend(tokens[3]);
    const plan = await w.plan({ tokens, amount: '25', split: { token: big, splitAmount: '5', remainderAmount: '5' } });
    const machine = w.machine();
    await expect(machine.run(plan)).rejects.toBeInstanceOf(TransferConflictError);
    expect(w.engine.splitCalls, 'the split is in the second wave').toHaveLength(0);
    const deposits = w.deposits.length;

    const outcome = await machine.convergeRun(plan);

    expect(w.engine.splitCalls.map((c) => c.key)).toEqual([`${plan.transferId}:20`]);
    expect(w.applied).toHaveLength(1);
    expect(w.applied[0].added).toHaveLength(1);
    expect(w.applied[0].spent).toContain(big.blob.tokenId);
    expect(w.deposits.length - deposits).toBe(1);
    expect(outcome.partial.remainingAmount).toBe('1');
  });

  it('M8 a reused conflict beside a fresh-wave conflict: the shortfall is their sum, and a later wave still runs', async () => {
    const w = makeWorld();
    const amounts = Array.from({ length: 41 }, (_, i) => BigInt(i + 1));
    const tokens = await seedMany(w, amounts);
    await w.engine.foreignSpend(tokens[3]);
    await w.engine.foreignSpend(tokens[25]);
    const plan = await w.plan({ tokens, amount: amounts.reduce((s, x) => s + x, 0n).toString() });
    const machine = w.machine();
    await expect(machine.run(plan)).rejects.toBeInstanceOf(TransferConflictError);

    const outcome = await machine.convergeRun(plan);

    expect(outcome.partial.remainingAmount).toBe(String(4 + 26));
    expect(outcome.partial.committedTokenIds).toHaveLength(39);
    expect(outcome.partial.committedTokenIds).not.toContain(tokens[3].blob.tokenId);
    expect(outcome.partial.committedTokenIds).not.toContain(tokens[25].blob.tokenId);
    expect(w.engine.transferCalls.map((c) => c.key), 'the third wave ran past the fresh conflict').toContain(`${plan.transferId}:40`);
    expect(w.engine.transferCalls.filter((c) => c.key === `${plan.transferId}:3`), 'the reused conflict never re-runs').toHaveLength(1);
  });

  it("M9 run()'s owed deposit landed by the journal replay meanwhile: the converge reports nothing pending", async () => {
    const w = makeWorld();
    const a = await w.seed(600n);
    const b = await w.seed(400n);
    await w.engine.foreignSpend(b);
    const plan = await w.plan({ tokens: [a, b], amount: '1000' });
    w.overrides.deliver = async () => {
      throw new FakeApiError(500, 'INTERNAL', 'mailbox down');
    };
    const machine = w.machine();
    await expect(machine.run(plan)).rejects.toBeInstanceOf(TransferConflictError);
    delete w.overrides.deliver;
    // The heartbeat's journal replay is not ActiveOps-gated: it can land the deposit mid-converge.
    const replayed = await w.stores().deliveryJournal.replay({ delivery: w.deps.delivery, now: () => w.clock.t, attention: () => undefined });
    expect(replayed).toMatchObject({ delivered: 1 });

    const outcome = await machine.convergeRun(plan);

    expect(outcome.deliveryPending).toBe(false);
    expect(w.deposits.map((d) => d.tokenId)).toHaveLength(1);
  });

  it('M9b the journal cannot be read after a deposit run() owed: the converge keeps reporting it pending', async () => {
    const w = makeWorld();
    const a = await w.seed(600n);
    const b = await w.seed(400n);
    await w.engine.foreignSpend(b);
    const plan = await w.plan({ tokens: [a, b], amount: '1000' });
    w.overrides.deliver = async () => {
      throw new FakeApiError(500, 'INTERNAL', 'mailbox down');
    };
    const machine = w.machine();
    await expect(machine.run(plan)).rejects.toBeInstanceOf(TransferConflictError);
    delete w.overrides.deliver;
    w.kv.failKeys.add(STORE_KEYS.deliveryJournal);

    const outcome = await machine.convergeRun(plan);
    w.kv.failKeys.delete(STORE_KEYS.deliveryJournal);

    expect(outcome.deliveryPending).toBe(true);
    expect(outcome.closed).toBe(true);
  });

  it('a partial over a port with deliverBatch: run() batches its legs, the converge batches only the legs it certified', async () => {
    const w = makeWorld();
    const tokens = await seedMany(w, ones(22));
    await w.engine.foreignSpend(tokens[3]);
    const plan = await w.plan({ tokens, amount: '22' });
    const batches: number[] = [];
    const batch = w.deps.delivery.deliverBatch!.bind(w.deps.delivery);
    w.deps.delivery.deliverBatch = async (recipient, blobs, options) => {
      batches.push(blobs.length);
      return batch(recipient, blobs, options);
    };
    const machine = w.machine();
    await expect(machine.run(plan)).rejects.toBeInstanceOf(TransferConflictError);

    const outcome = await machine.convergeRun(plan);

    expect(batches).toEqual([19, 2]);
    expect(w.deposits).toHaveLength(21);
    expect(outcome.deliveryPending).toBe(false);
    expect(await w.stores().deliveryJournal.byTransfer(plan.transferId)).toEqual(new Map());
  });
});
