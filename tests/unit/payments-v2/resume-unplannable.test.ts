/**
 * #840: one open intent this client cannot plan, or whose sources the server refuses to
 * read, fails ALONE. Every other open intent in the pass still resumes, the pass still
 * reconciles, and the refused intent is left open: never executed, aborted or completed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../../../core/logger';
import { WalletApiHttpError } from '../../../impl/wallet-api-v2/http';
import { ActiveOps, Converger, derivePendingTransfers, type ConvergerDeps } from '../../../modules/payments-v2/convergence';
import { createMachineStores } from '../../../modules/payments-v2/machine/journal';
import { resumeAll } from '../../../modules/payments-v2/machine/resume';
import type { MachineDeps } from '../../../modules/payments-v2/machine/TransferMachine';
import { STORE_KEYS } from '../../../modules/payments-v2/stores';
import { ProofUnconfirmedError } from '../../../token-engine/errors';
import { FakeApiError } from './fakes/FakeWalletApi';
import { COIN, makeWorld, type World } from './machine-harness';

const BAD_ID = '00000000-0000-4000-8000-000000000840'; // sorts before every harness id
const TWO_256 = (1n << 256n).toString();

afterEach(() => {
  vi.restoreAllMocks();
});

/** A keep-open send: its leg's proof never confirmed, so its resume must READ its source again. */
async function keepOpenSend(w: World, amount = 1000n): Promise<string> {
  const plan = await w.plan({ tokens: [await w.seed(amount)], amount: amount.toString() });
  const unconfirmed = new ProofUnconfirmedError('proof fetch inconclusive');
  w.engine.afterOp = (key) => (key === `${plan.transferId}:0` ? unconfirmed : null);
  await expect(w.machine().run(plan)).rejects.toBe(unconfirmed);
  w.engine.afterOp = null;
  return plan.transferId;
}

/** An intent another client of this wallet wrote, server-open, with no local entry here. */
async function stageIntent(w: World, id: string, payload: Record<string, unknown>): Promise<void> {
  const body = { v: 2, kind: 'coin', recipient: w.recipientHex, coinId: COIN, amount: '1000', ...payload };
  await w.api.putIntent(w.caller, { transferId: id, payload: `enc:${JSON.stringify(body)}`, requiresSeedClose: true });
}

/** One direct leg, then a split of a second token: a late refusal would spend the direct leg first. */
async function stageSplit(w: World, id: string, split: Record<string, unknown>, coinId = COIN): Promise<void> {
  const direct = await w.seed(400n);
  const source = await w.seed(1000n);
  await stageIntent(w, id, {
    coinId,
    direct: [direct.blob.tokenId],
    split: { tokenId: source.blob.tokenId, ...split },
  });
}

/** blob-urls as wallet-api answers it: a whole batch 400s on one malformed id and 403s on one not owned. */
function serverFaithfulBlobs(w: World, failDownloadOf?: string): void {
  const lenient = w.deps.storage.getBlobs.bind(w.deps.storage);
  w.deps.storage.getBlobs = async (ids) => {
    if (ids.some((id) => !/^(?:[0-9a-f]{2}){1,64}$/.test(id))) {
      throw new FakeApiError(400, 'VALIDATION', 'expected a lowercase-hex token id');
    }
    if (ids.some((id) => !w.blobByTokenId.has(id))) throw new FakeApiError(403, 'FORBIDDEN', 'not in inventory');
    if (failDownloadOf !== undefined && ids.includes(failDownloadOf)) {
      throw new FakeApiError(502, 'BLOB_DOWNLOAD', 'one blob download failed');
    }
    return lenient(ids);
  };
}

type Reconciled = { resumed: string[]; conflicted: string[]; open: string[] };

function converger(
  w: World,
  machineDeps: MachineDeps = w.deps,
  stores = createMachineStores(w.kv)
): { run: Converger; reconcile: ReturnType<typeof vi.fn> } {
  const reconcile = vi.fn(async (_report: Reconciled) => undefined);
  const deps: ConvergerDeps = {
    machineDeps,
    stores,
    delivery: w.deps.delivery,
    reconcile,
    refreshView: async () => undefined,
    replayMints: async () => 0,
    replayNftMints: async () => 0,
    replayCustomMints: async () => 0,
    replayBurns: async () => 0,
    activeOps: new ActiveOps(),
    parked: new Set(),
    emit: () => undefined,
    now: () => w.clock.t,
  };
  return { run: new Converger(deps), reconcile };
}

function expectUntouched(w: World): void {
  expect(w.engine.transferCalls).toHaveLength(0);
  expect(w.engine.splitCalls).toHaveLength(0);
  expect(w.api.inspectIntent(w.caller, BAD_ID)?.status).toBe('open');
  expect(w.log).not.toContain('abortIntent');
}

describe('one open intent resume cannot plan never wedges the pass (#840)', () => {
  it('a split amount BigInt cannot parse fails that intent alone: every other open intent in the pass resumes', async () => {
    const w = makeWorld();
    await stageSplit(w, BAD_ID, { splitAmount: 'abc', remainderAmount: '400' });
    const good = await keepOpenSend(w);

    const report = await resumeAll(w.deps);

    expect(report).toEqual({ resumed: [good], conflicted: [], failed: [BAD_ID] });
    expect(w.api.inspectIntent(w.caller, good)?.status).toBe('completed');
    expect(w.api.inspectIntent(w.caller, BAD_ID)?.status).toBe('open');
  });

  const outOfDomain: [unknown, unknown][] = [
    ['abc', '400'], ['1e3', '400'], ['600.0', '400'], ['', '1000'], [' 600', '400'], ['+600', '400'],
    ['0x258', '400'], ['0600', '400'], ['-5', '1005'], ['0', '1000'], [TWO_256, '400'],
    ['600', 'abc'], ['600', ''], ['600', '0x190'], ['600', '0400'], ['1000', '0'], ['1005', '-5'], ['600', TWO_256],
    [600, '400'], [2 ** 60, '400'], ['600', 400], ['600', 2 ** 60],
  ];
  for (const [splitAmount, remainderAmount] of outOfDomain) {
    it(`a split of ${JSON.stringify(splitAmount)} + ${JSON.stringify(remainderAmount)} is refused before any leg runs`, async () => {
      const w = makeWorld();
      await stageSplit(w, BAD_ID, { splitAmount, remainderAmount });

      const report = await resumeAll(w.deps);

      expect(report).toEqual({ resumed: [], conflicted: [], failed: [BAD_ID] });
      expectUntouched(w);
    });
  }

  for (const coinId of [COIN.toUpperCase(), COIN.slice(1), '']) {
    it(`a split under coin id ${JSON.stringify(coinId)} is refused before the direct leg beside it is spent`, async () => {
      const w = makeWorld();
      await stageSplit(w, BAD_ID, { splitAmount: '600', remainderAmount: '400' }, coinId);

      const report = await resumeAll(w.deps);

      expect(report).toEqual({ resumed: [], conflicted: [], failed: [BAD_ID] });
      expectUntouched(w);
    });
  }

  it('the smallest asset value on either side of a split still resumes: 1 is in the domain', async () => {
    for (const split of [{ splitAmount: '1', remainderAmount: '999' }, { splitAmount: '999', remainderAmount: '1' }]) {
      const w = makeWorld();
      const source = await w.seed(1000n);
      await stageIntent(w, BAD_ID, { direct: [], split: { tokenId: source.blob.tokenId, ...split } });
      expect(await resumeAll(w.deps)).toEqual({ resumed: [BAD_ID], conflicted: [], failed: [] });
    }
  });

  it('the largest asset value still resumes: 2^256 - 1 is in the domain', async () => {
    const w = makeWorld();
    const max = (1n << 256n) - 1n;
    const source = await w.seed(max);
    await stageIntent(w, BAD_ID, {
      amount: (max - 1n).toString(),
      direct: [],
      split: { tokenId: source.blob.tokenId, splitAmount: (max - 1n).toString(), remainderAmount: '1' },
    });
    expect(await resumeAll(w.deps)).toEqual({ resumed: [BAD_ID], conflicted: [], failed: [] });
  });

  it('a send whose requested amount has a leading zero still resumes: amount is written verbatim, never re-read', async () => {
    const w = makeWorld();
    const plan = await w.plan({ tokens: [await w.seed(600n)], amount: '0600' });
    const outage = async (): Promise<void> => {
      throw new FakeApiError(500, 'INTERNAL', 'injected outage');
    };
    w.overrides.deliver = outage;
    w.overrides.applyDelta = outage;
    await expect(w.machine().run(plan)).rejects.toMatchObject({ code: 'SEND_SYNC_PENDING' });
    delete w.overrides.deliver;
    delete w.overrides.applyDelta;

    expect(await resumeAll(w.deps)).toEqual({ resumed: [plan.transferId], conflicted: [], failed: [] });
  });

  it('the pass still reconciles: the resumed intent is reported, the refused one stays open, never unaccounted', async () => {
    const w = makeWorld();
    await stageSplit(w, BAD_ID, { splitAmount: 'abc', remainderAmount: '400' });
    const good = await keepOpenSend(w);
    const { run, reconcile } = converger(w);

    const outcome = await run.convergeOnce();

    expect(outcome.progress).toBe(true);
    expect(reconcile).toHaveBeenCalledTimes(1);
    const passed = reconcile.mock.calls[0][0] as Reconciled;
    expect(passed.resumed).toEqual([good]);
    expect(passed.conflicted).toEqual([]);
    expect(passed.open).toContain(BAD_ID);
  });

  it('a refused intent stays open across passes: no leg, no shortfall, no complete, no abort, one warning', async () => {
    const w = makeWorld();
    await stageSplit(w, BAD_ID, { splitAmount: '0600', remainderAmount: '400' });
    const warn = vi.spyOn(logger, 'warn');
    const { run, reconcile } = converger(w);

    for (let pass = 0; pass < 6; pass++) await run.convergeOnce();

    expect(reconcile).toHaveBeenCalledTimes(6);
    for (const [passed] of reconcile.mock.calls) expect((passed as Reconciled).open).toContain(BAD_ID);
    expectUntouched(w);
    expect(w.completes).toEqual([]);
    expect(await w.stores().shortfalls.list()).toEqual([]);
    expect(warn.mock.calls.filter(([, message]) => String(message).includes(BAD_ID))).toHaveLength(1);
  });
});

describe('a source read the server refuses fails only the intent that named it (#840)', () => {
  for (const [label, badSource] of [['a malformed', 'ZZ'], ['an empty', ''], ['an unowned', 'ab'.repeat(32)]] as const) {
    it(`a foreign intent naming ${label} source id does not stop a keep-open send resuming`, async () => {
      const w = makeWorld();
      serverFaithfulBlobs(w);
      await stageIntent(w, BAD_ID, { amount: '1', direct: [badSource] });
      const good = await keepOpenSend(w);

      const report = await resumeAll(w.deps);

      expect(report).toEqual({ resumed: [good], conflicted: [], failed: [BAD_ID] });
      expect(w.api.inspectIntent(w.caller, good)?.status).toBe('completed');
      expect(w.api.inspectIntent(w.caller, BAD_ID)?.status).toBe('open');
      expect(w.log).not.toContain('abortIntent');
    });
  }

  it('one blob download that fails costs only the intent whose source it was', async () => {
    const w = makeWorld();
    const unreadable = await w.seed(1000n);
    serverFaithfulBlobs(w, unreadable.blob.tokenId);
    await stageIntent(w, BAD_ID, { direct: [unreadable.blob.tokenId] });
    const good = await keepOpenSend(w);

    const report = await resumeAll(w.deps);

    expect(report).toEqual({ resumed: [good], conflicted: [], failed: [BAD_ID] });
    expect(w.api.inspectIntent(w.caller, BAD_ID)?.status).toBe('open');
  });

  it("a source read's Retry-After reaches the report, so the heartbeat waits it out", async () => {
    const w = makeWorld();
    const good = await keepOpenSend(w);
    w.deps.storage.getBlobs = async () => {
      throw new WalletApiHttpError(503, 'UNAVAILABLE', 'POST /v1/tokens/blob-urls: unavailable', 30_000);
    };

    expect(await resumeAll(w.deps)).toEqual({ resumed: [], conflicted: [], failed: [good], retryAfterMs: 30_000 });
  });

  it("a per-intent re-read's Retry-After reaches the report when the refused batch carried none", async () => {
    const w = makeWorld();
    const first = await keepOpenSend(w);
    const second = await keepOpenSend(w);
    let calls = 0;
    w.deps.storage.getBlobs = async () => {
      calls++;
      if (calls === 1) throw new FakeApiError(403, 'FORBIDDEN', 'not in inventory');
      throw new WalletApiHttpError(503, 'UNAVAILABLE', 'POST /v1/tokens/blob-urls: unavailable', 30_000);
    };

    const report = await resumeAll(w.deps);

    expect(calls).toBe(3);
    expect(report).toEqual({ resumed: [], conflicted: [], failed: [first, second].sort(), retryAfterMs: 30_000 });
  });
});

async function neverStoredTombstone(w: World): Promise<void> {
  await w.stores().backstop.upsert({
    transferId: 'never-stored',
    payloadEnvelope: `enc:${JSON.stringify({ v: 2, kind: 'coin', recipient: w.recipientHex, coinId: COIN, amount: '1', direct: [] })}`,
    requiresSeedClose: false,
    disposition: 'abortPending',
    createdAt: 1,
  });
}

describe('a pass that throws part-way keeps the verdicts it already made durable (#840)', () => {

  it('with no token engine: the retired tombstone is still reported conflicted', async () => {
    const w = makeWorld();
    const good = await keepOpenSend(w);
    await neverStoredTombstone(w);
    const unavailable = (): never => {
      throw new Error('paymentsV2: token engine unavailable');
    };
    const { run, reconcile } = converger(w, { ...w.deps, engine: unavailable });

    await run.convergeOnce();

    expect(await w.stores().backstop.getByKey('never-stored')).toBeUndefined();
    expect(reconcile).toHaveBeenCalledTimes(1);
    const passed = reconcile.mock.calls[0][0] as Reconciled;
    expect(passed.conflicted).toEqual(['never-stored']);
    expect(passed.open).toContain(good);
  });

  it('with an unreadable delivery journal: the retired tombstone is still reported conflicted, the rest stay open', async () => {
    const w = makeWorld();
    const good = await keepOpenSend(w);
    await stageIntent(w, BAD_ID, { amount: '1', direct: [] });
    await neverStoredTombstone(w);
    w.kv.failKeys.add(STORE_KEYS.deliveryJournal);
    const { run, reconcile } = converger(w);

    await run.convergeOnce();

    expect(await w.stores().backstop.getByKey('never-stored')).toBeUndefined();
    expect(reconcile).toHaveBeenCalledTimes(1);
    const passed = reconcile.mock.calls[0][0] as Reconciled;
    expect(passed.resumed).toEqual([]);
    expect(passed.conflicted).toEqual(['never-stored']);
    expect(passed.open).toEqual(expect.arrayContaining([good, BAD_ID]));
    expect(w.api.inspectIntent(w.caller, BAD_ID)?.status).toBe('open');
  });
});

describe("a cancel the server never stored keeps its tombstone until the reconcile consumed the verdict (#840)", () => {
  // The tombstone is the verdict's only durable copy: the aborted listing never shows a row the
  // server never stored, so without it a later pass finds the link unaccounted and resolves it paid.
  it('the pass that judged it never reached the reconcile: the tombstone stays, and the next pass reports it conflicted', async () => {
    const w = makeWorld();
    await neverStoredTombstone(w);

    expect(await resumeAll(w.deps)).toMatchObject({ conflicted: ['never-stored'] });

    expect((await w.stores().backstop.getByKey('never-stored'))?.disposition).toBe('abortPending');
    const { run, reconcile } = converger(w);
    await run.convergeOnce();
    expect((reconcile.mock.calls[0][0] as Reconciled).conflicted).toEqual(['never-stored']);
    expect(await w.stores().backstop.getByKey('never-stored')).toBeUndefined();
  });

  it("the post-pass backstop read fails: the reconcile is skipped, the tombstone stays, the next pass reports it conflicted", async () => {
    const w = makeWorld();
    await neverStoredTombstone(w);
    const stores = createMachineStores(w.kv);
    const list = stores.backstop.list.bind(stores.backstop);
    let unreadable = true;
    stores.backstop.list = async () => {
      if (!unreadable) return list();
      unreadable = false;
      throw new Error('injected backstop read failure');
    };
    const { run, reconcile } = converger(w, w.deps, stores);

    await run.convergeOnce();
    expect(reconcile).not.toHaveBeenCalled();
    expect(await w.stores().backstop.getByKey('never-stored')).toBeDefined();

    await run.convergeOnce();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect((reconcile.mock.calls[0][0] as Reconciled).conflicted).toEqual(['never-stored']);
    expect(await w.stores().backstop.getByKey('never-stored')).toBeUndefined();
  });

  it('the kept tombstone stops holding what it handed back: the shortfall is listed, and a paid one never comes back', async () => {
    const w = makeWorld();
    const owed = { transferId: 'earlier', remainingAmount: '400', coinId: COIN, recipient: w.recipientHex, committedTokenIds: [], createdAt: 1 };
    await neverStoredTombstone(w);
    await w.stores().backstop.patch('never-stored', (e) => ({ ...e, owes: [owed] }));
    const decrypt = (envelope: string): Promise<unknown> => w.deps.decryptPayload(envelope);

    await resumeAll(w.deps);
    expect((await w.stores().backstop.getByKey('never-stored'))?.owes).toBeUndefined();
    expect((await derivePendingTransfers(w.stores(), decrypt)).map((row) => row.transferId)).toEqual(['earlier']);

    await w.stores().shortfalls.removeByKey('earlier'); // the user paid the remainder under a new send
    expect(await resumeAll(w.deps)).toMatchObject({ conflicted: ['never-stored'] });
    expect(await w.stores().shortfalls.list()).toEqual([]);
  });

  it('the reconcile throws: the tombstone stays, and the next pass reports it conflicted again', async () => {
    const w = makeWorld();
    await neverStoredTombstone(w);
    const { run, reconcile } = converger(w);
    reconcile.mockRejectedValueOnce(new Error('settling journal unreadable'));

    await run.convergeOnce();
    expect(await w.stores().backstop.getByKey('never-stored')).toBeDefined();

    await run.convergeOnce();
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect((reconcile.mock.calls[1][0] as Reconciled).conflicted).toEqual(['never-stored']);
    expect(await w.stores().backstop.getByKey('never-stored')).toBeUndefined();
  });
});
