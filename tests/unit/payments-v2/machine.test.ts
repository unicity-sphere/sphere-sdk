import { describe, expect, it } from 'vitest';

import { SphereError, isPossiblyCommittedSendOutcome } from '../../../core/errors';
import { ProofUnconfirmedError, TransferConflictError } from '../../../token-engine/errors';
import { summarize } from '../../../modules/payments-v2/machine/TransferMachine';
import {
  MAX_DELIVERY_ATTEMPTS,
  RATE_LIMIT_DEFER_MS,
} from '../../../modules/payments-v2/machine/journal';
import { FakeApiError, QuotaExceededError, ValidationFailedError } from './fakes/FakeWalletApi';
import { makeWorld, opKey } from './machine-harness';

const never = (): Promise<void> => new Promise<void>(() => undefined);

describe('TransferMachine send path (§5.5)', () => {
  it('awaits the intent PUT before any engine op: an intent outage spends nothing and keeps the backstop', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    w.overrides.putIntent = async () => {
      throw new FakeApiError(503, 'UNAVAILABLE', 'intent store down');
    };

    await expect(w.machine().run(plan)).rejects.toThrow('intent store down');

    expect(w.engine.transferCalls).toHaveLength(0);
    expect(await w.engine.isSpent(token)).toBe(false);
    expect(w.log).not.toContain('abortIntent');
    const backstop = await w.stores().backstop.getByKey(plan.transferId);
    expect(backstop?.disposition).toBe('open');
  });

  it('#670: a deterministic 422 intent rejection drops the backstop and never aborts', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    w.overrides.putIntent = async () => {
      throw new ValidationFailedError('payload refused');
    };

    await expect(w.machine().run(plan)).rejects.toThrow('payload refused');

    expect(await w.stores().backstop.getByKey(plan.transferId)).toBeUndefined();
    expect(w.log).not.toContain('abortIntent');
    expect(w.engine.transferCalls).toHaveLength(0);
  });

  it('the intent PUT resolves before the first engine submit (order pin)', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });

    await w.machine().run(plan);

    expect(w.log.indexOf('putIntent')).toBeGreaterThanOrEqual(0);
    expect(w.log.indexOf('putIntent')).toBeLessThan(w.log.indexOf('engine:transfer'));
  });

  it('happy path: certify → journal → one deposit → applyDelta; journal drained, source tombstoned evidenced', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000', memo: 'hi' });

    const result = await w.machine().run(plan);

    expect(result.deliveryPending).toBe(false);
    expect(result.committed).toHaveLength(1);
    expect(w.deposits).toEqual([{ transferId: plan.transferId, tokenId: token.blob.tokenId }]);
    expect(w.applied).toEqual([
      { transferId: plan.transferId, spent: [token.blob.tokenId], added: [] },
    ]);
    expect(await w.stores().deliveryJournal.list()).toHaveLength(0);
    expect(w.api.inspectInventoryRow(w.caller, token.blob.tokenId)).toMatchObject({
      status: 'removed',
      removalClass: 'evidenced',
    });
    const mailbox = await w.api.listMailbox(w.recipientCaller);
    expect(mailbox.entries).toHaveLength(1);
  });

  it('journals the recipient blob BEFORE the deposit attempt (#621 journal-before-deliver)', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    let journaledAtDeposit = false;
    w.overrides.deliver = async () => {
      const entries = await w.stores().deliveryJournal.list();
      journaledAtDeposit = entries.some((e) => e.transferId === plan.transferId && e.opIndex === 0);
    };

    await w.machine().run(plan);

    expect(journaledAtDeposit).toBe(true);
  });

  it('split send: change uploads before applyDelta, lands in added[], and complete is signed', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({
      amount: '600',
      split: { token, splitAmount: '600', remainderAmount: '400' },
    });

    const result = await w.machine().run(plan);
    await w.flushTail();

    expect(result.committed).toHaveLength(1);
    expect(w.log.indexOf('uploadBlobs')).toBeLessThan(w.log.indexOf('applyDelta'));
    expect(w.applied[0].spent).toEqual([token.blob.tokenId]);
    expect(w.applied[0].added).toHaveLength(1);
    expect(w.signCalls).toContain(plan.transferId);
    expect(w.completes.find((c) => c.transferId === plan.transferId)?.signature).toBeDefined();
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('completed');
  });

  it('split ops receive the durable checkpoint store (E.4: the live path MUST supply it)', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ amount: '600', split: { token, splitAmount: '600', remainderAmount: '400' } });

    await w.machine().run(plan);

    expect(w.engine.splitCalls).toEqual([{ key: opKey({ transferId: plan.transferId, opIndex: 0 }), checkpointStore: true }]);
  });

  it('#631 keep-open: ProofUnconfirmed surfaces UNWRAPPED, the intent and backstop stay open, no abort, no apply', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    const pue = new ProofUnconfirmedError('proof fetch timed out');
    w.engine.afterOp = () => pue;

    await expect(w.machine().run(plan)).rejects.toBe(pue);

    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('open');
    expect((await w.stores().backstop.getByKey(plan.transferId))?.disposition).toBe('open');
    expect(w.log).not.toContain('abortIntent');
    expect(w.log).not.toContain('applyDelta');
    expect(isPossiblyCommittedSendOutcome(pue)).toBe(true);
  });

  it('a proven-clean pre-submit reject with nothing certified aborts the intent and clears the backstop', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    w.engine.beforeOp = () => {
      throw new Error('submit rejected: known validation failure');
    };

    await expect(w.machine().run(plan)).rejects.toThrow('known validation failure');

    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('aborted');
    expect(await w.stores().backstop.getByKey(plan.transferId)).toBeUndefined();
    expect(await w.engine.isSpent(token)).toBe(false);
  });

  it('audit#4: a conflicted leg is never in applyDelta.spent[]; the certified sibling is delivered and applied', async () => {
    const w = makeWorld();
    const tokenA = await w.seed(600n);
    const tokenB = await w.seed(400n);
    await w.engine.foreignSpend(tokenB);
    const plan = await w.plan({ tokens: [tokenA, tokenB], amount: '1000' });

    await expect(w.machine().run(plan)).rejects.toBeInstanceOf(TransferConflictError);

    expect(w.applied).toHaveLength(1);
    expect(w.applied[0].spent).toEqual([tokenA.blob.tokenId]);
    expect(w.applied[0].spent).not.toContain(tokenB.blob.tokenId);
    expect(w.deposits.map((d) => d.tokenId)).toEqual([tokenA.blob.tokenId]);
    expect(w.api.inspectInventoryRow(w.caller, tokenB.blob.tokenId)?.status).toBe('active');
  });

  it('a source certified during a failed send is terminal: tombstoned server-side, never restored to active', async () => {
    const w = makeWorld();
    const tokenA = await w.seed(600n);
    const tokenB = await w.seed(400n);
    await w.engine.foreignSpend(tokenB);
    const plan = await w.plan({ tokens: [tokenA, tokenB], amount: '1000' });

    await expect(w.machine().run(plan)).rejects.toBeInstanceOf(TransferConflictError);

    expect(w.api.inspectInventoryRow(w.caller, tokenA.blob.tokenId)?.status).toBe('removed');
    const active = await w.api.listInventory(w.caller);
    expect(active.items.map((i) => i.tokenId)).not.toContain(tokenA.blob.tokenId);
  });

  it('recipient 429 defers the journaled blob without spending the poison budget, and the send still applies (S3)', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    w.overrides.deliver = async () => {
      throw new QuotaExceededError('inbox full', 'max_recipient_entries');
    };

    const result = await w.machine().run(plan);

    expect(result.deliveryPending).toBe(true);
    const [entry] = await w.stores().deliveryJournal.list();
    expect(entry.attempts).toBe(0);
    expect(entry.deferredUntil).toBe(w.clock.t + RATE_LIMIT_DEFER_MS);
    expect(entry.undeliverable).toBeUndefined();
    expect(w.log).toContain('applyDelta');
    expect(w.events.some((e) => e.event === 'transfer:attention' && (e.payload as { code: string }).code === 'delivery:deferred')).toBe(true);
  });

  it('replay honors deferredUntil: skipped before it passes, delivered and drained after', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    w.overrides.deliver = async () => {
      throw new QuotaExceededError('inbox full', 'max_recipient_entries');
    };
    await w.machine().run(plan);
    delete w.overrides.deliver;
    const replayDeps = { delivery: w.deps.delivery, now: () => w.clock.t, attention: () => undefined };

    const early = await w.stores().deliveryJournal.replay(replayDeps);
    expect(early).toMatchObject({ delivered: 0, deferred: 1 });
    expect(await w.stores().deliveryJournal.list()).toHaveLength(1);

    w.clock.t += RATE_LIMIT_DEFER_MS + 1;
    const late = await w.stores().deliveryJournal.replay(replayDeps);
    expect(late).toMatchObject({ delivered: 1 });
    expect(await w.stores().deliveryJournal.list()).toHaveLength(0);
    expect(w.deposits).toHaveLength(1);
  });

  it(`genuine 5xx failures follow the bounded replay: poisoned at ${MAX_DELIVERY_ATTEMPTS} attempts with attention, entry kept`, async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    w.overrides.deliver = async () => {
      throw new FakeApiError(500, 'INTERNAL', 'S3 down');
    };
    await w.machine().run(plan);
    expect((await w.stores().deliveryJournal.list())[0].attempts).toBe(1);

    const attentions: string[] = [];
    const replayDeps = {
      delivery: w.deps.delivery,
      now: () => w.clock.t,
      attention: (_t: string, code: string) => {
        attentions.push(code);
      },
    };
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS - 1; i++) {
      await w.stores().deliveryJournal.replay(replayDeps);
    }

    const [entry] = await w.stores().deliveryJournal.list();
    expect(entry.attempts).toBe(MAX_DELIVERY_ATTEMPTS);
    expect(entry.undeliverable).toBe(true);
    expect(attentions).toEqual(['delivery:undeliverable']);

    const deliversBefore = w.log.filter((l) => l === 'deliver').length;
    await w.stores().deliveryJournal.replay(replayDeps);
    expect(w.log.filter((l) => l === 'deliver').length).toBe(deliversBefore);
    expect(await w.stores().deliveryJournal.list()).toHaveLength(1);
  });

  it('replay is single-flight: concurrent calls coalesce onto one delivery pass', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    w.overrides.deliver = async () => {
      throw new FakeApiError(500, 'INTERNAL', 'flaky');
    };
    await w.machine().run(plan);
    w.overrides.deliver = async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    };

    const deliversBefore = w.log.filter((l) => l === 'deliver').length;
    const replayDeps = { delivery: w.deps.delivery, now: () => w.clock.t, attention: () => undefined };
    await Promise.all([w.stores().deliveryJournal.replay(replayDeps), w.stores().deliveryJournal.replay(replayDeps)]);

    expect(w.log.filter((l) => l === 'deliver').length).toBe(deliversBefore + 1);
    expect(await w.stores().deliveryJournal.list()).toHaveLength(0);
  });

  it('#665: an applyDelta failure surfaces as SEND_SYNC_PENDING carrying the transferId — never a transfer failure', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    w.overrides.applyDelta = async () => {
      throw new FakeApiError(500, 'INTERNAL', 'mirror down');
    };

    let thrown: unknown;
    await w.machine().run(plan).catch((err: unknown) => {
      thrown = err;
    });

    expect(thrown).toBeInstanceOf(SphereError);
    expect((thrown as SphereError).code).toBe('SEND_SYNC_PENDING');
    expect((thrown as SphereError).transferId).toBe(plan.transferId);
    expect(isPossiblyCommittedSendOutcome(thrown)).toBe(true);
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('open');
    expect(w.log).not.toContain('abortIntent');
    expect(w.events.map((e) => e.event)).not.toContain('transfer:failed');
    expect(w.deposits).toHaveLength(1);
  });

  it('#717: send resolves while complete hangs — the fire-and-forget tail still ISSUED the call', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    w.overrides.complete = never;

    const result = await w.machine().run(plan);
    await w.flushTail();

    expect(result.committed).toHaveLength(1);
    expect(w.log).toContain('completeIntent');
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('completed');
  });

  it('two concurrent sends serialize their journal RMW: neither backstop nor journal entry is lost', async () => {
    const w = makeWorld();
    const tokenA = await w.seed(600n);
    const tokenB = await w.seed(400n);
    const planA = await w.plan({ tokens: [tokenA], amount: '600' });
    const planB = await w.plan({ tokens: [tokenB], amount: '400' });
    w.overrides.deliver = async () => {
      throw new FakeApiError(500, 'INTERNAL', 'down');
    };

    const [ra, rb] = await Promise.all([w.machine().run(planA), w.machine().run(planB)]);
    expect(ra.deliveryPending).toBe(true);
    expect(rb.deliveryPending).toBe(true);

    const journal = await w.stores().deliveryJournal.list();
    expect(journal.map((e) => e.transferId).sort()).toEqual([planA.transferId, planB.transferId].sort());
  });

  it('summarize precedence: keep-open outranks conflict outranks other; committed counts certified-with-error (#441)', () => {
    const op = (opIndex: number) => ({ kind: 'direct' as const, opIndex, sourceTokenId: `s${String(opIndex)}`, deliveredAmount: 0n });
    const conflict = new TransferConflictError('lost race');
    const pue = new ProofUnconfirmedError('indeterminate');
    const { committed, cls, firstError } = summarize([
      { op: op(0), certified: true, error: new Error('journal write failed') },
      { op: op(1), certified: false, error: conflict },
      { op: op(2), certified: false, error: pue },
    ]);
    expect(committed).toHaveLength(1);
    expect(cls).toBe('keep-open');
    expect(firstError).toBe(pue);
  });
});
