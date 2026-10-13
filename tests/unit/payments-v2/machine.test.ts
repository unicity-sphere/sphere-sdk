import { describe, expect, it } from 'vitest';

import { SphereError, isPossiblyCommittedSendOutcome } from '../../../core/errors';
import { ProofUnconfirmedError, TransferConflictError } from '../../../token-engine/errors';
import {
  summarize,
  type MachinePlan,
  type RehydratedIntent,
} from '../../../modules/payments-v2/machine/TransferMachine';
import {
  MAX_DELIVERY_ATTEMPTS,
  RATE_LIMIT_DEFER_MS,
} from '../../../modules/payments-v2/machine/journal';
import {
  INTENT_UNCONFIRMED_MESSAGE,
  NOT_FENCED_MESSAGE,
  PARTLY_ON_CHAIN_MESSAGE,
} from '../../../modules/payments-v2/send-errors';
import { STORE_KEYS } from '../../../modules/payments-v2/stores';
import { WalletApiHttpError } from '../../../impl/wallet-api-v2/http';
import { FakeApiError, NotFoundError, QuotaExceededError, ValidationFailedError } from './fakes/FakeWalletApi';
import { makeWorld, opKey } from './machine-harness';

const never = (): Promise<void> => new Promise<void>(() => undefined);

async function rejectionOf(op: Promise<unknown>): Promise<unknown> {
  return op.then(
    () => {
      throw new Error('expected the operation to reject');
    },
    (err: unknown) => err
  );
}

function rehydrate(plan: MachinePlan, journaled: RehydratedIntent['journaled']): RehydratedIntent {
  return { transferId: plan.transferId, payload: plan.payload, sources: plan.sources, journaled };
}

describe('TransferMachine send path (§5.5)', () => {
  it('awaits the intent PUT before any engine op: an intent outage spends nothing, re-PUTs the same bytes, and parks the attempt possibly-committed', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    w.overrides.putIntent = async () => {
      throw new FakeApiError(503, 'UNAVAILABLE', 'intent store down');
    };

    const err = await rejectionOf(w.machine().run(plan));

    expect(err).toMatchObject({ code: 'SEND_SYNC_PENDING', transferId: plan.transferId });
    expect(((err as SphereError).cause as Error).message).toBe('intent store down');
    expect(w.engine.transferCalls).toHaveLength(0);
    expect(await w.engine.isSpent(token)).toBe(false);
    expect(w.log).not.toContain('abortIntent');
    const backstop = await w.stores().backstop.getByKey(plan.transferId);
    expect(backstop?.disposition).toBe('open');
    expect(backstop?.intentPut).toBe('unconfirmed');
    expect(w.log.filter((l) => l === 'putIntent')).toHaveLength(3);
    expect(w.putCalls).toEqual(
      new Array(3).fill({ transferId: plan.transferId, envelope: backstop?.payloadEnvelope, requiresSeedClose: false })
    );
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
    expect(w.log.filter((l) => l === 'putIntent')).toHaveLength(1);
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

  // sphere#487: the wallet's own Unicity ID is a per-deliver option, read from
  // the LIVE getter (registration can land between a send and its replay), and
  // the journal replay must carry it too — a crash must not cost the recipient
  // the sender's name.
  it('#487 every deliver carries the sender nametag — on the send path and on a journal replay', async () => {
    const w = makeWorld();
    w.nametag.value = 'alice';
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000', memo: 'hi' });

    await w.machine().run(plan);
    expect(w.delivered).toEqual([{ transferId: plan.transferId, memo: 'hi', senderNametag: 'alice' }]);

    // Now a deferred leg replayed from the journal, after the name changed.
    const journaled = await w.seed(1000n);
    const second = await w.plan({ tokens: [journaled], amount: '1000' });
    w.overrides.deliver = async () => {
      throw new FakeApiError(500, 'INTERNAL', 'S3 down');
    };
    await w.machine().run(second);
    delete w.overrides.deliver;
    w.nametag.value = 'alice2';
    w.delivered.length = 0;

    await w.stores().deliveryJournal.replay({
      delivery: w.deps.delivery,
      now: () => w.clock.t,
      attention: () => undefined,
      ownNametag: () => w.nametag.value,
    });

    expect(w.delivered).toEqual([{ transferId: second.transferId, senderNametag: 'alice2' }]);
  });

  // The leg is already certified when the name is read: a throwing getter must
  // degrade to an anonymous delivery, never replay the blob into the poison
  // budget and strand a settled transfer at delivery:undeliverable.
  it('a throwing nametag getter costs the name, never the delivery', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    w.deps.ownNametag = () => {
      throw new Error('address registry unavailable');
    };

    const result = await w.machine().run(plan);

    expect(result.deliveryPending).toBe(false);
    expect(w.delivered).toEqual([{ transferId: plan.transferId }]);
    expect(await w.stores().deliveryJournal.list()).toHaveLength(0);
  });

  it('a sender with no Unicity ID delivers without a nametag (the field is omitted, never empty)', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });

    await w.machine().run(plan);

    expect(w.delivered).toEqual([{ transferId: plan.transferId }]);
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

  // #835: run() applies only a fully settled attempt. The apply completes an
  // unflagged intent, so a conflict partial is applied by resume, after its shortfall.
  it('audit#4: a conflicted leg is never in applyDelta.spent[]; the certified sibling is delivered, and applied only by the resume', async () => {
    const w = makeWorld();
    const tokenA = await w.seed(600n);
    const tokenB = await w.seed(400n);
    await w.engine.foreignSpend(tokenB);
    const plan = await w.plan({ tokens: [tokenA, tokenB], amount: '1000' });
    const machine = w.machine();

    await expect(machine.run(plan)).rejects.toBeInstanceOf(TransferConflictError);

    expect(w.applied).toEqual([]);
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('open');
    expect(w.deposits.map((d) => d.tokenId)).toEqual([tokenA.blob.tokenId]);

    await machine.resumeIntent(rehydrate(plan, await w.stores().deliveryJournal.byTransfer(plan.transferId)));

    expect(w.applied).toHaveLength(1);
    expect(w.applied[0].spent).toEqual([tokenA.blob.tokenId]);
    expect(w.applied[0].spent).not.toContain(tokenB.blob.tokenId);
    expect(w.api.inspectInventoryRow(w.caller, tokenB.blob.tokenId)?.status).toBe('active');
    expect(w.api.inspectInventoryRow(w.caller, tokenA.blob.tokenId)?.status).toBe('removed');
    expect((await w.stores().shortfalls.getByKey(plan.transferId))?.remainingAmount).toBe('400');
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('completed');
  });

  it('a source certified during a failed send is terminal: tombstoned server-side by the resume, never restored to active', async () => {
    const w = makeWorld();
    const tokenA = await w.seed(600n);
    const tokenB = await w.seed(400n);
    await w.engine.foreignSpend(tokenB);
    const plan = await w.plan({ tokens: [tokenA, tokenB], amount: '1000' });
    const machine = w.machine();

    await expect(machine.run(plan)).rejects.toBeInstanceOf(TransferConflictError);

    expect(w.applied).toEqual([]);
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('open');
    expect(w.deposits.map((d) => d.tokenId)).toEqual([tokenA.blob.tokenId]);

    await machine.resumeIntent(rehydrate(plan, await w.stores().deliveryJournal.byTransfer(plan.transferId)));

    expect(w.applied).toHaveLength(1);
    expect(w.applied[0].spent).toEqual([tokenA.blob.tokenId]);
    expect(w.api.inspectInventoryRow(w.caller, tokenB.blob.tokenId)?.status).toBe('active');
    expect(w.api.inspectInventoryRow(w.caller, tokenA.blob.tokenId)?.status).toBe('removed');
    const active = await w.api.listInventory(w.caller);
    expect(active.items.map((i) => i.tokenId)).not.toContain(tokenA.blob.tokenId);
    expect((await w.stores().shortfalls.getByKey(plan.transferId))?.remainingAmount).toBe('400');
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('completed');
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

// #835: no engine op runs before a PUT of the stored envelope answers 2xx, and a
// failed attempt is reported clean only when nothing on this device can run it.
describe('TransferMachine intent PUT gate (#835)', () => {
  const unavailable = (): FakeApiError => new FakeApiError(503, 'UNAVAILABLE', 'intent store down');

  it('413 is never storable: one PUT, the backstop dropped, the raw error rethrown', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    const tooLarge = new FakeApiError(413, 'PAYLOAD_TOO_LARGE', 'body too large');
    w.overrides.putIntent = async () => {
      throw tooLarge;
    };

    await expect(w.machine().run(plan)).rejects.toBe(tooLarge);

    expect(w.log.filter((l) => l === 'putIntent')).toHaveLength(1);
    expect(await w.stores().backstop.getByKey(plan.transferId)).toBeUndefined();
    expect(w.engine.transferCalls).toHaveLength(0);
    expect(w.log).not.toContain('abortIntent');
  });

  it('a 422 whose backstop removal fails still rejects with the 422, and leaves only an inert pending entry', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    const refused = new ValidationFailedError('payload refused');
    w.overrides.putIntent = async () => {
      w.kv.failWriteKeys.add(STORE_KEYS.intentBackstop);
      throw refused;
    };
    const machine = w.machine();

    await expect(machine.run(plan)).rejects.toBe(refused);

    expect(machine.certifiedSourcesOf(plan)).toEqual([]);
    const entry = await w.stores().backstop.getByKey(plan.transferId);
    expect(entry).toMatchObject({ disposition: 'open', intentPut: 'pending' });
    expect(w.engine.transferCalls).toHaveLength(0);
  });

  it.each([
    ['429 QUOTA_EXCEEDED', () => new QuotaExceededError('open intent cap', 'max_open_intents')],
    ['429 RATE_LIMITED', () => new WalletApiHttpError(429, 'RATE_LIMITED', 'slow down', 60_000)],
    ['401 AUTH_SUPERSEDED', () => new WalletApiHttpError(401, 'AUTH_SUPERSEDED', 'session superseded')],
    ['403 TLS_REQUIRED', () => new WalletApiHttpError(403, 'TLS_REQUIRED', 'tls required')],
    ['409 CONFLICT', () => new FakeApiError(409, 'CONFLICT', 'aborted with another payload')],
  ])('two pre-write refusals (%s) with nothing ambiguous before them fail clean', async (_label, make) => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    const thrown: Error[] = [];
    w.overrides.putIntent = async () => {
      const err = make();
      thrown.push(err);
      throw err;
    };

    const err = await rejectionOf(w.machine().run(plan));

    expect(err).toBe(thrown[1]);
    expect(isPossiblyCommittedSendOutcome(err)).toBe(false);
    expect(w.log.filter((l) => l === 'putIntent')).toHaveLength(2);
    expect(await w.stores().backstop.getByKey(plan.transferId)).toBeUndefined();
    expect(w.log).not.toContain('abortIntent');
    expect(w.engine.transferCalls).toHaveLength(0);
  });

  it('one refusal is no proof: a refusal then a 2xx sends the payment', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    let calls = 0;
    w.overrides.putIntent = async () => {
      calls += 1;
      if (calls === 1) throw new QuotaExceededError('open intent cap', 'max_open_intents');
    };

    const result = await w.machine().run(plan);

    expect(result.committed).toHaveLength(1);
    expect(w.deposits).toHaveLength(1);
  });

  it('a lost PUT response is confirmed by the re-PUT: the send resolves, both PUTs carry identical args', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    let lost = false;
    w.overrides.putIntent = async () => {
      if (lost) return;
      lost = true;
      const call = w.putCalls[w.putCalls.length - 1];
      await w.api.putIntent(w.caller, {
        transferId: call.transferId,
        payload: call.envelope,
        requiresSeedClose: call.requiresSeedClose,
      });
      throw new WalletApiHttpError(0, 'NETWORK', 'response lost');
    };

    const result = await w.machine().run(plan);
    await w.flushTail();

    expect(result.committed).toHaveLength(1);
    expect(w.putCalls).toHaveLength(2);
    expect(w.putCalls[1]).toEqual(w.putCalls[0]);
    expect(w.deposits).toHaveLength(1);
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('completed');
  });

  it('an ambiguous answer then refusals parks the attempt: never clean once the row may exist', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    const thrown: Error[] = [];
    w.overrides.putIntent = async () => {
      const err = thrown.length === 0 ? unavailable() : new WalletApiHttpError(403, 'FORBIDDEN', 'refused');
      thrown.push(err);
      throw err;
    };

    const err = await rejectionOf(w.machine().run(plan));

    expect(err).toMatchObject({ code: 'SEND_SYNC_PENDING', transferId: plan.transferId });
    expect((err as SphereError).message).toBe(INTENT_UNCONFIRMED_MESSAGE);
    expect((err as SphereError).cause).toBe(thrown[2]);
    expect(w.putCalls).toHaveLength(3);
    expect((await w.stores().backstop.getByKey(plan.transferId))?.intentPut).toBe('unconfirmed');
    expect(w.engine.transferCalls).toHaveLength(0);
  });

  it('every re-PUT carries the STORED envelope (never a re-encryption) and the split flag', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ amount: '600', split: { token, splitAmount: '600', remainderAmount: '400' } });
    let nonce = 0;
    const encrypt = w.deps.encryptPayload;
    w.deps.encryptPayload = async (p) => `${await encrypt(p)}#${String((nonce += 1))}`;
    w.overrides.putIntent = async () => {
      throw unavailable();
    };

    await expect(w.machine().run(plan)).rejects.toMatchObject({ code: 'SEND_SYNC_PENDING' });

    const stored = await w.stores().backstop.getByKey(plan.transferId);
    expect(nonce).toBe(1);
    expect(w.putCalls).toEqual(
      new Array(3).fill({ transferId: plan.transferId, envelope: stored?.payloadEnvelope, requiresSeedClose: true })
    );
    expect(w.engine.splitCalls).toHaveLength(0);
  });

  it('intentPut lifecycle: pending while the PUT is unanswered, absent once acked', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    const seen: { during?: unknown; acked?: unknown } = {};
    w.overrides.putIntent = async () => {
      seen.during = (await w.stores().backstop.getByKey(plan.transferId))?.intentPut;
    };
    w.overrides.deliver = async () => {
      const entry = await w.stores().backstop.getByKey(plan.transferId);
      seen.acked = entry === undefined ? 'missing' : 'intentPut' in entry;
    };

    await w.machine().run(plan);

    expect(seen).toEqual({ during: 'pending', acked: false });
  });

  it('intentPut lifecycle: a refused attempt leaves no entry, a parked one reads unconfirmed', async () => {
    const w = makeWorld();
    const refusedToken = await w.seed(500n);
    const parkedToken = await w.seed(500n);
    const refusedPlan = await w.plan({ tokens: [refusedToken], amount: '500' });
    const parkedPlan = await w.plan({ tokens: [parkedToken], amount: '500' });

    w.overrides.putIntent = async () => {
      throw new WalletApiHttpError(403, 'FORBIDDEN', 'refused');
    };
    await expect(w.machine().run(refusedPlan)).rejects.toMatchObject({ status: 403 });
    w.overrides.putIntent = async () => {
      throw unavailable();
    };
    await expect(w.machine().run(parkedPlan)).rejects.toMatchObject({ code: 'SEND_SYNC_PENDING' });

    expect(await w.stores().backstop.getByKey(refusedPlan.transferId)).toBeUndefined();
    expect((await w.stores().backstop.getByKey(parkedPlan.transferId))?.intentPut).toBe('unconfirmed');
  });

  it('a park whose flag write fails is still possibly-committed and remembered in memory', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    w.overrides.putIntent = async () => {
      w.kv.failWriteKeys.add(STORE_KEYS.intentBackstop);
      throw unavailable();
    };
    const machine = w.machine();

    await expect(machine.run(plan)).rejects.toMatchObject({ code: 'SEND_SYNC_PENDING', transferId: plan.transferId });

    expect(machine.wasParked(plan.transferId)).toBe(true);
    expect(machine.wasParked('another-transfer')).toBe(false);
    expect((await w.stores().backstop.getByKey(plan.transferId))?.intentPut).toBe('pending');
  });

  it('a leg certified beside an ordinary leg failure is possibly-committed: no apply, no abort, the intent open', async () => {
    const w = makeWorld();
    const tokenA = await w.seed(600n);
    const tokenB = await w.seed(400n);
    const plan = await w.plan({ tokens: [tokenA, tokenB], amount: '1000' });
    const legFailure = new SphereError('leg failed', 'TRANSFER_FAILED');
    w.engine.beforeOp = (key) => {
      if (key === `${plan.transferId}:1`) throw legFailure;
    };
    const machine = w.machine();

    const err = await rejectionOf(machine.run(plan));

    expect(err).toBeInstanceOf(SphereError);
    expect(err).toMatchObject({ code: 'SEND_SYNC_PENDING', transferId: plan.transferId });
    expect((err as SphereError).message).toBe(PARTLY_ON_CHAIN_MESSAGE);
    expect((err as SphereError).cause).toBe(legFailure);
    expect(isPossiblyCommittedSendOutcome(err)).toBe(true);
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('open');
    expect(w.log).not.toContain('applyDelta');
    expect(w.log).not.toContain('abortIntent');
    expect(machine.certifiedSourcesOf(plan)).toEqual([tokenA.blob.tokenId]);
    expect(w.deposits.map((d) => d.tokenId)).toEqual([tokenA.blob.tokenId]);
  });

  it('a certified leg whose journal write fails is possibly-committed, never the raw storage error', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    w.engine.afterOp = () => {
      w.kv.failWriteKeys.add(STORE_KEYS.deliveryJournal);
      return null;
    };
    const machine = w.machine();

    const err = await rejectionOf(machine.run(plan));

    expect(err).toMatchObject({ code: 'SEND_SYNC_PENDING', transferId: plan.transferId });
    expect(((err as SphereError).cause as Error).message).toContain('injected kv write failure');
    expect(machine.certifiedSourcesOf(plan)).toEqual([token.blob.tokenId]);
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('open');
    expect(w.log).not.toContain('abortIntent');
    expect(w.log).not.toContain('applyDelta');
  });

  it("a failed delivery bookkeeping write never fails a certified send: it still applies, delivery pending", async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    w.overrides.deliver = async () => {
      w.kv.failWriteKeys.add(STORE_KEYS.deliveryJournal);
      throw new FakeApiError(500, 'INTERNAL', 'S3 down');
    };

    const result = await w.machine().run(plan);

    expect(result.deliveryPending).toBe(true);
    expect(w.applied).toEqual([{ transferId: plan.transferId, spent: [token.blob.tokenId], added: [] }]);
    expect(await w.stores().deliveryJournal.byTransfer(plan.transferId)).toHaveProperty('size', 1);
  });

  it('a throwing transfer:updated listener never fails the send', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    w.deps.emit = (event) => {
      if (event === 'transfer:updated') throw new Error('listener exploded');
    };

    const result = await w.machine().run(plan);

    expect(result.committed).toHaveLength(1);
    expect(w.applied).toHaveLength(1);
  });

  it('a reseed during the attempt means a clean leg failure cannot be fenced: held open, never aborted', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    const machine = w.machine();
    w.engine.beforeOp = () => {
      machine.noteReseed();
      throw new Error('clean reject');
    };

    const err = await rejectionOf(machine.run(plan));

    expect(err).toMatchObject({ code: 'SEND_SYNC_PENDING', transferId: plan.transferId });
    expect((err as SphereError).message).toBe(NOT_FENCED_MESSAGE);
    expect(((err as SphereError).cause as Error).message).toBe('clean reject');
    expect(w.log).not.toContain('abortIntent');
    expect((await w.stores().backstop.getByKey(plan.transferId))?.disposition).toBe('open');
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('open');
  });

  it('after an ambiguous PUT answer a clean leg failure cannot be fenced either: held open, never aborted', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    let calls = 0;
    w.overrides.putIntent = async () => {
      calls += 1;
      if (calls === 1) throw unavailable();
    };
    w.engine.beforeOp = () => {
      throw new Error('clean reject');
    };

    const err = await rejectionOf(w.machine().run(plan));

    expect(err).toMatchObject({ code: 'SEND_SYNC_PENDING', transferId: plan.transferId });
    expect((err as SphereError).message).toBe(NOT_FENCED_MESSAGE);
    expect(w.log).not.toContain('abortIntent');
    expect((await w.stores().backstop.getByKey(plan.transferId))?.disposition).toBe('open');
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('open');
  });

  it('every op conflicting after an ambiguous PUT answer is still a clean conflict: a re-run conflicts again', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    await w.engine.foreignSpend(token);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    let calls = 0;
    w.overrides.putIntent = async () => {
      calls += 1;
      if (calls === 1) throw unavailable();
    };

    const err = await rejectionOf(w.machine().run(plan));

    expect(err).toBeInstanceOf(TransferConflictError);
    expect(isPossiblyCommittedSendOutcome(err)).toBe(false);
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('aborted');
    expect(await w.stores().backstop.getByKey(plan.transferId)).toBeUndefined();
  });

  it('a clean leg failure whose tombstone cannot be written is held open: no abort without a durable record', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    w.engine.beforeOp = () => {
      w.kv.failWriteKeys.add(STORE_KEYS.intentBackstop);
      throw new Error('clean reject');
    };

    const err = await rejectionOf(w.machine().run(plan));

    expect(err).toMatchObject({ code: 'SEND_SYNC_PENDING', transferId: plan.transferId });
    expect((err as SphereError).message).toBe(NOT_FENCED_MESSAGE);
    expect(w.log).not.toContain('abortIntent');
    expect(w.api.inspectIntent(w.caller, plan.transferId)?.status).toBe('open');
  });

  it('a clean leg failure whose abort answers 404 NOT_FOUND is clean and leaves nothing behind', async () => {
    const w = makeWorld();
    const token = await w.seed(1000n);
    const plan = await w.plan({ tokens: [token], amount: '1000' });
    w.engine.beforeOp = () => {
      throw new Error('clean reject');
    };
    w.overrides.abort = async () => {
      throw new NotFoundError('unknown intent');
    };

    await expect(w.machine().run(plan)).rejects.toThrow('clean reject');

    expect(await w.stores().backstop.getByKey(plan.transferId)).toBeUndefined();
  });
});
