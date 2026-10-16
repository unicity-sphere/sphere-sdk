/**
 * #846: a pure conflict on resume (every leg lost to a foreign spend, nothing delivered) ends the
 * way every other cancel ends. Its tombstone is written before the abort, it is reported
 * `conflicted` only once the server confirms the abort, and a row another device completed first
 * is paid, never payable again.
 */

import { describe, expect, it, vi } from 'vitest';

import { ActiveOps, Converger } from '../../../modules/payments-v2/convergence';
import { WalletApiHttpError } from '../../../impl/wallet-api-v2/http';
import { createMachineStores } from '../../../modules/payments-v2/machine/journal';
import { resumeAll } from '../../../modules/payments-v2/machine/resume';
import { Requests, type RequestWire } from '../../../modules/payments-v2/requests/Requests';
import { reseedAndReset } from '../../../modules/payments-v2/restore';
import { STORE_KEYS } from '../../../modules/payments-v2/stores';
import { ProofUnconfirmedError } from '../../../token-engine/errors';
import { FakeApiError, completeMessageFor, fakeSeedSignature } from './fakes/FakeWalletApi';
import { COIN, makeWorld, type World } from './machine-harness';
import { stubRequestMemoCodec } from './support';

const OWED = { transferId: 'earlier', remainingAmount: '400', coinId: COIN, recipient: 'aa', committedTokenIds: [], createdAt: 1 };

const fail500 = async (): Promise<void> => {
  throw new FakeApiError(500, 'INTERNAL', 'injected abort outage');
};

/** The server never stored the row (as after a database restore): a typed 404 confirms the cancel. */
const neverStored = async (): Promise<void> => {
  throw new FakeApiError(404, 'NOT_FOUND', 'intent not found');
};

/** A keep-open send whose only source another device then spends: its next resume is a pure conflict. */
async function lostRace(w: World, owes = false): Promise<string> {
  const token = await w.seed(1000n);
  const plan = await w.plan({ tokens: [token], amount: '1000' });
  w.engine.beforeOp = () => {
    throw new ProofUnconfirmedError('submit lost in transit');
  };
  await expect(w.machine().run(plan)).rejects.toMatchObject({ code: 'CERTIFICATION_UNCONFIRMED' });
  w.engine.beforeOp = null;
  await w.engine.foreignSpend(token);
  if (owes) await w.stores().backstop.patch(plan.transferId, (e) => ({ ...e, owes: [OWED] }));
  return plan.transferId;
}

/** The same lost race on an intent another device of the wallet wrote: no local entry here. */
async function foreignLostRace(w: World): Promise<string> {
  const token = await w.seed(1000n);
  const id = 'other-device';
  const body = { v: 2, kind: 'coin', recipient: w.recipientHex, coinId: COIN, amount: '1000', direct: [token.blob.tokenId] };
  await w.api.putIntent(w.caller, { transferId: id, payload: `enc:${JSON.stringify(body)}`, requiresSeedClose: false });
  await w.engine.foreignSpend(token);
  return id;
}

function completeFirst(w: World, transferId: string): () => Promise<void> {
  return async () => {
    const signature = fakeSeedSignature(w.senderHex, completeMessageFor(transferId));
    await w.api.completeIntent(w.caller, { transferId, signature }); // lands between the listing and the abort
  };
}

async function link(w: World, transferId: string): Promise<void> {
  await w.kv.set(STORE_KEYS.settlingLinks, { r1: { requestId: 'r1', transferId, committed: false, createdAt: 1 } });
}

/** One app session: a Requests over the world's KV, wired into a converger as the facade wires it. */
function session(w: World, responded: unknown[]): Converger {
  const unused = async (): Promise<never> => {
    throw new Error('unused');
  };
  const requests = new Requests({
    client: {
      createPaymentRequest: unused,
      listPaymentRequests: unused,
      respondPaymentRequest: async (id, response) => {
        responded.push({ id, response });
        return {} as RequestWire;
      },
    },
    kv: w.kv,
    ownPubkey: w.senderHex,
    send: unused,
    resolvePubkey: async () => null,
    listAbortedTransferIds: async () => (await w.deps.intents.listAborted()).map((row) => row.transferId),
    emit: () => undefined,
    memo: stubRequestMemoCodec,
  });
  return new Converger({
    machineDeps: w.deps,
    stores: createMachineStores(w.kv),
    delivery: w.deps.delivery,
    reconcile: (report) => requests.reconcile(report),
    linkedTransferIds: () => requests.linkedTransferIds(),
    refreshView: async () => undefined,
    replayMints: async () => 0,
    replayNftMints: async () => 0,
    replayCustomMints: async () => 0,
    replayBurns: async () => 0,
    activeOps: new ActiveOps(),
    parked: new Set(),
    emit: () => undefined,
    now: () => w.clock.t,
  });
}

describe('a pure conflict on resume is reported conflicted only once its abort is confirmed (#846)', () => {
  it('the abort fails: not conflicted, the link stays settling, and the pass that confirms the abort reverts it', async () => {
    const w = makeWorld();
    const id = await lostRace(w);
    await link(w, id);
    w.overrides.abort = fail500;

    const report = await resumeAll(w.deps);

    expect(report).toEqual({ resumed: [], conflicted: [], failed: [id] });
    expect(w.api.inspectIntent(w.caller, id)?.status, 'another device could still run it').toBe('open');
    expect((await w.stores().backstop.getByKey(id))?.disposition, 'cancelled, so never resumed').toBe('abortPending');

    const responded: unknown[] = [];
    const run = session(w, responded);
    await run.convergeOnce();
    expect(w.kv.map.get(STORE_KEYS.settlingLinks), 'still settling while the abort fails').toHaveProperty('r1');

    delete w.overrides.abort;
    await run.convergeOnce();

    expect(w.api.inspectIntent(w.caller, id)?.status).toBe('aborted');
    expect(w.kv.map.get(STORE_KEYS.settlingLinks), 'payable once the cancel is confirmed').toEqual({});
    expect(await w.stores().backstop.getByKey(id)).toBeUndefined();
    expect(responded, 'nothing moved: never responded paid').toEqual([]);
  });

  it('the row was completed on another device before the abort landed: paid, never payable, and what it held is settled', async () => {
    const w = makeWorld();
    const id = await lostRace(w, true);
    await link(w, id);
    w.overrides.abort = completeFirst(w, id);
    const responded: unknown[] = [];

    await session(w, responded).convergeOnce();

    expect(w.api.inspectIntent(w.caller, id)?.status).toBe('completed');
    expect(responded, 'the payment went out: the request resolves paid').toEqual([
      { id: 'r1', response: { action: 'paid', transferId: id } },
    ]);
    expect(await w.stores().backstop.getByKey(id)).toBeUndefined();
    expect(await w.stores().shortfalls.getByKey('earlier'), 'the completed holder paid it: never owed again').toBeUndefined();
  });

  it('the tombstone cannot be written: nothing is aborted, it is reported failed, and the next pass cancels it', async () => {
    const w = makeWorld();
    const id = await lostRace(w);
    w.kv.failWriteKeys.add(STORE_KEYS.intentBackstop);

    const report = await resumeAll(w.deps);

    expect(report).toEqual({ resumed: [], conflicted: [], failed: [id] });
    expect(w.log, 'no abort without a durable tombstone').not.toContain('abortIntent');
    expect(w.api.inspectIntent(w.caller, id)?.status).toBe('open');

    w.kv.failWriteKeys.delete(STORE_KEYS.intentBackstop);
    expect(await resumeAll(w.deps)).toEqual({ resumed: [], conflicted: [id], failed: [] });
    expect(w.api.inspectIntent(w.caller, id)?.status).toBe('aborted');
  });

  it('the abort is confirmed but the entry removal fails: it stays a tombstone, so an epoch re-seed never re-PUTs the aborted row', async () => {
    const w = makeWorld();
    const id = await lostRace(w, true);
    w.overrides.abort = async () => {
      w.kv.failWriteKeys.add(STORE_KEYS.intentBackstop); // after the tombstone write, before the removal
    };

    const report = await resumeAll(w.deps);

    expect(report).toEqual({ resumed: [], conflicted: [], failed: [id] });
    expect((await w.stores().backstop.getByKey(id))?.disposition).toBe('abortPending');
    const reput = vi.fn(async () => undefined);
    await reseedAndReset({
      stores: w.stores(),
      kv: w.kv,
      reput,
      reseedCheckpoint: async () => true,
      decryptPayload: w.deps.decryptPayload,
      fullRePull: async () => undefined,
      attention: () => undefined,
    });
    expect(reput, 'a byte-equal re-PUT would re-open the aborted row').not.toHaveBeenCalled();
    expect(w.api.inspectIntent(w.caller, id)?.status).toBe('aborted');

    delete w.overrides.abort;
    w.kv.failWriteKeys.delete(STORE_KEYS.intentBackstop);
    expect(await resumeAll(w.deps)).toEqual({ resumed: [], conflicted: [id], failed: [] });
    expect(await w.stores().backstop.getByKey(id)).toBeUndefined();
    expect((await w.stores().shortfalls.getByKey('earlier'))?.remainingAmount, 'owed again: nothing was paid').toBe('400');
  });
});

describe('a pure conflict on resume whose abort is not answered 204 (#846)', () => {
  it('the abort answers 429 with Retry-After: failed, kept as a cancel, and the pass hands that wait to the heartbeat', async () => {
    const w = makeWorld();
    const id = await lostRace(w);
    w.overrides.abort = async () => {
      throw new WalletApiHttpError(429, 'RATE_LIMITED', `POST /v1/intents/${id}/abort: rate limit exceeded`, 120_000);
    };

    const report = await resumeAll(w.deps);

    expect(report).toEqual({ resumed: [], conflicted: [], failed: [id], retryAfterMs: 120_000 });
    expect((await w.stores().backstop.getByKey(id))?.disposition).toBe('abortPending');
    expect(w.api.inspectIntent(w.caller, id)?.status).toBe('open');
  });

  it('the abort answers 404 NOT_FOUND: conflicted, its rows owed again, and the tombstone is kept for the reconcile', async () => {
    const w = makeWorld();
    const id = await lostRace(w, true);
    w.overrides.abort = neverStored;

    const report = await resumeAll(w.deps);

    expect(report.conflicted).toEqual([id]);
    expect(report.failed).toEqual([]);
    expect(report.retireAfterReconcile?.map((entry) => entry.transferId)).toEqual([id]);
    const kept = await w.stores().backstop.getByKey(id);
    expect(kept?.disposition, 'no listing will ever show the row: the tombstone is the verdict').toBe('abortPending');
    expect(kept?.owes, 'it no longer holds what it handed back').toBeUndefined();
    expect((await w.stores().shortfalls.getByKey('earlier'))?.remainingAmount).toBe('400');
  });

  it('the abort answers 404 NOT_FOUND in a full pass: the link is payable again, then the tombstone goes', async () => {
    const w = makeWorld();
    const id = await lostRace(w);
    await link(w, id);
    w.overrides.abort = neverStored;
    const responded: unknown[] = [];

    await session(w, responded).convergeOnce();

    expect(w.kv.map.get(STORE_KEYS.settlingLinks), 'payable once the cancel is confirmed').toEqual({});
    expect(responded, 'nothing moved: never responded paid').toEqual([]);
    expect(await w.stores().backstop.getByKey(id), 'retired once no link names it').toBeUndefined();
  });
});

describe('a pure conflict on resume of an intent with no local entry (#846)', () => {
  it('another device wrote it: conflicted only once its abort is confirmed', async () => {
    const w = makeWorld();
    const id = await foreignLostRace(w);
    w.overrides.abort = fail500;

    expect(await resumeAll(w.deps)).toEqual({ resumed: [], conflicted: [], failed: [id] });
    expect(w.api.inspectIntent(w.caller, id)?.status).toBe('open');

    delete w.overrides.abort;
    expect(await resumeAll(w.deps)).toEqual({ resumed: [], conflicted: [id], failed: [] });
    expect(w.api.inspectIntent(w.caller, id)?.status).toBe('aborted');
    expect(await w.stores().backstop.list(), 'nothing local is created for it').toEqual([]);
  });

  it('its row was completed before the abort landed: paid, never conflicted', async () => {
    const w = makeWorld();
    const id = await foreignLostRace(w);
    w.overrides.abort = completeFirst(w, id);

    expect(await resumeAll(w.deps)).toEqual({ resumed: [], conflicted: [], failed: [] });
    expect(w.api.inspectIntent(w.caller, id)?.status).toBe('completed');
  });

  it('its abort answers 404 NOT_FOUND: conflicted, and nothing local is created for it', async () => {
    const w = makeWorld();
    const id = await foreignLostRace(w);
    w.overrides.abort = neverStored;

    expect(await resumeAll(w.deps)).toEqual({ resumed: [], conflicted: [id], failed: [] });
    expect(await w.stores().backstop.list()).toEqual([]);
  });
});
