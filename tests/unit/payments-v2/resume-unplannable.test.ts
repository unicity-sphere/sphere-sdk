/**
 * #840: one open intent this client cannot plan, or whose sources the server refuses to
 * read, fails ALONE. Every other open intent in the pass still resumes, the pass still
 * reconciles, and the refused intent is left open: never executed, aborted or completed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SphereError } from '../../../core/errors';
import { logger } from '../../../core/logger';
import { WalletApiHttpError } from '../../../impl/wallet-api-v2/http';
import {
  ActiveOps,
  Converger,
  ConvergenceHeartbeat,
  HEARTBEAT_CAP_MS,
  HEARTBEAT_SEED_MS,
  derivePendingTransfers,
  type ConvergerDeps,
} from '../../../modules/payments-v2/convergence';
import { createMachineStores } from '../../../modules/payments-v2/machine/journal';
import { resumeAll } from '../../../modules/payments-v2/machine/resume';
import { Requests, type RequestWire } from '../../../modules/payments-v2/requests/Requests';
import type { MachineDeps } from '../../../modules/payments-v2/machine/TransferMachine';
import { STORE_KEYS } from '../../../modules/payments-v2/stores';
import { ProofUnconfirmedError } from '../../../token-engine/errors';
import { FakeApiError } from './fakes/FakeWalletApi';
import { COIN, makeWorld, type World } from './machine-harness';
import { stubRequestMemoCodec } from './support';

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
async function stageIntent(w: World, id: string, payload: Record<string, unknown>, requiresSeedClose = true): Promise<void> {
  const body = { v: 2, kind: 'coin', recipient: w.recipientHex, coinId: COIN, amount: '1000', ...payload };
  await w.api.putIntent(w.caller, { transferId: id, payload: `enc:${JSON.stringify(body)}`, requiresSeedClose });
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
  stores = createMachineStores(w.kv),
  over: Partial<ConvergerDeps> = {}
): { run: Converger; reconcile: ReturnType<typeof vi.fn> } {
  const reconcile = vi.fn(async (_report: Reconciled) => undefined);
  const deps: ConvergerDeps = {
    machineDeps,
    stores,
    delivery: w.deps.delivery,
    reconcile,
    linkedTransferIds: async () => new Set<string>(),
    refreshView: async () => undefined,
    replayMints: async () => 0,
    replayNftMints: async () => 0,
    replayCustomMints: async () => 0,
    replayBurns: async () => 0,
    activeOps: new ActiveOps(),
    parked: new Set(),
    emit: () => undefined,
    now: () => w.clock.t,
    ...over,
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

  for (const coinId of [COIN.toUpperCase(), COIN.slice(1), '']) {
    it(`a direct-only send under coin id ${JSON.stringify(coinId)} is refused: a conflicted leg would cost 0 and complete it`, async () => {
      const w = makeWorld();
      const kept = await w.seed(600n);
      const lost = await w.seed(400n);
      await w.engine.foreignSpend(lost);
      await stageIntent(w, BAD_ID, { coinId, direct: [kept.blob.tokenId, lost.blob.tokenId] });

      const report = await resumeAll(w.deps);

      expect(report).toEqual({ resumed: [], conflicted: [], failed: [BAD_ID] });
      expectUntouched(w);
      expect(w.log).not.toContain('completeIntent');
    });
  }

  for (const requiresSeedClose of [false, true]) {
    it(`a coin intent that names no leg is refused (requiresSeedClose ${requiresSeedClose}): zero ops would complete it paid`, async () => {
      const w = makeWorld();
      await stageIntent(w, BAD_ID, { direct: [] }, requiresSeedClose);

      const report = await resumeAll(w.deps);

      expect(report).toEqual({ resumed: [], conflicted: [], failed: [BAD_ID] });
      expectUntouched(w);
      expect(w.log).not.toContain('completeIntent');
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

  it('a refused batch that asked to back off is not re-read per intent', async () => {
    const w = makeWorld();
    const first = await keepOpenSend(w);
    const second = await keepOpenSend(w);
    let calls = 0;
    w.deps.storage.getBlobs = async () => {
      calls++;
      throw new WalletApiHttpError(429, 'RATE_LIMITED', 'POST /v1/tokens/blob-urls: slow down', 30_000);
    };

    const report = await resumeAll(w.deps);

    expect(calls, 'one request per intent would multiply the load the server asked to shed').toBe(1);
    expect(report).toEqual({ resumed: [], conflicted: [], failed: [first, second].sort(), retryAfterMs: 30_000 });
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

    expect(calls, 'a re-read answered with a Retry-After ends the per-intent reads for this pass').toBe(2);
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

  it('stripping what it handed back fails: the verdict still reaches the reconcile, and a later pass lists the row and retires it', async () => {
    const w = makeWorld();
    const owed = { transferId: 'earlier', remainingAmount: '400', coinId: COIN, recipient: w.recipientHex, committedTokenIds: [], createdAt: 1 };
    await neverStoredTombstone(w);
    await w.stores().backstop.patch('never-stored', (e) => ({ ...e, owes: [owed] }));
    const decrypt = (envelope: string): Promise<unknown> => w.deps.decryptPayload(envelope);
    let linked = new Set(['never-stored']);
    const { run, reconcile } = converger(w, w.deps, createMachineStores(w.kv), {
      linkedTransferIds: async () => linked,
    });
    w.kv.failWriteKeys.add(STORE_KEYS.intentBackstop);

    await run.convergeOnce();
    expect((reconcile.mock.calls[0][0] as Reconciled).conflicted).toEqual(['never-stored']);
    expect((await w.stores().backstop.getByKey('never-stored'))?.owes).toEqual([owed]);
    expect(await derivePendingTransfers(w.stores(), decrypt), 'still held, so never listed').toEqual([]);

    w.kv.failWriteKeys.delete(STORE_KEYS.intentBackstop);
    linked = new Set();
    await run.convergeOnce();
    expect((reconcile.mock.calls[1][0] as Reconciled).conflicted).toEqual(['never-stored']);
    expect(await w.stores().backstop.getByKey('never-stored')).toBeUndefined();
    expect((await derivePendingTransfers(w.stores(), decrypt)).map((row) => row.transferId)).toEqual(['earlier']);
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

/** A held send: possibly committed, and it names its transferId. */
function pending(transferId: string): SphereError {
  const err = new SphereError('held', 'SEND_SYNC_PENDING');
  err.transferId = transferId;
  return err;
}

/** One app session: a fresh Requests over the world's KV, wired into a converger as the facade wires it. */
function session(w: World, responded: unknown[]): Converger {
  const requests = new Requests({
    client: {
      createPaymentRequest: async () => {
        throw new Error('unused');
      },
      listPaymentRequests: async () => {
        throw new Error('unused');
      },
      respondPaymentRequest: async (id, response) => {
        responded.push({ id, response });
        return {} as RequestWire;
      },
    },
    kv: w.kv,
    ownPubkey: w.senderHex,
    send: async () => {
      throw new Error('unused');
    },
    resolvePubkey: async () => null,
    listAbortedTransferIds: async () => [],
    emit: () => undefined,
    memo: stubRequestMemoCodec,
  });
  return converger(w, w.deps, createMachineStores(w.kv), {
    reconcile: (report) => requests.reconcile(report),
    linkedTransferIds: () => requests.linkedTransferIds(),
  }).run;
}

describe('a never-stored cancel keeps its tombstone while a settling link still names it (#840)', () => {
  // A reconcile can resolve without applying the verdict; after a restart the link would be
  // unaccounted, absent from every aborted listing, and resolved paid though nothing moved.
  async function linkedTombstone(w: World): Promise<void> {
    await neverStoredTombstone(w);
    const link = { requestId: 'r1', transferId: 'never-stored', committed: false, createdAt: 1 };
    await w.kv.set(STORE_KEYS.settlingLinks, { r1: link });
  }

  it('a settling journal that failed open to empty: the tombstone stays, and the next session reverts the link', async () => {
    const w = makeWorld();
    await linkedTombstone(w);
    const responded: unknown[] = [];
    const get = w.kv.get.bind(w.kv);
    let transient = true;
    w.kv.get = async <T>(key: string): Promise<T | null> => {
      if (transient && key === STORE_KEYS.settlingLinks) {
        transient = false;
        throw new Error('injected transient read failure');
      }
      return get<T>(key);
    };

    await session(w, responded).convergeOnce();
    expect(await w.stores().backstop.getByKey('never-stored')).toBeDefined();

    await session(w, responded).convergeOnce(); // restart
    expect(w.kv.map.get(STORE_KEYS.settlingLinks)).toEqual({});
    expect(await w.stores().backstop.getByKey('never-stored')).toBeUndefined();
    await session(w, responded).convergeOnce();
    expect(responded, 'nothing moved: the request must never be responded paid').toEqual([]);
  });

  it('a failed write of the cleared link: the link stays in memory, and the next pass clears it before the tombstone goes', async () => {
    const w = makeWorld();
    await linkedTombstone(w);
    const responded: unknown[] = [];
    const run = session(w, responded);
    w.kv.failWriteKeys.add(STORE_KEYS.settlingLinks);

    await run.convergeOnce();
    expect(await w.stores().backstop.getByKey('never-stored')).toBeDefined();

    w.kv.failWriteKeys.delete(STORE_KEYS.settlingLinks);
    await run.convergeOnce();
    expect(w.kv.map.get(STORE_KEYS.settlingLinks)).toEqual({});
    expect(await w.stores().backstop.getByKey('never-stored')).toBeUndefined();
    await session(w, responded).convergeOnce(); // restart
    expect(responded, 'nothing moved: the request must never be responded paid').toEqual([]);
  });

  it('a link to it still queued behind a stalled journal write: the tombstone stays, and nothing is responded paid', async () => {
    const w = makeWorld();
    await neverStoredTombstone(w);
    await stageSplit(w, BAD_ID, { splitAmount: 'abc', remainderAmount: '400' }); // r0's link: open every pass
    const wire = (id: string): RequestWire => ({
      id, seq: 1, fromPubkey: w.recipientHex, toPubkey: w.senderHex, assets: [{ coinId: COIN, amount: '1' }],
      status: 'open', transferId: null, createdAt: '2026-01-01T00:00:00.000Z',
    });
    const responded: unknown[] = [];
    const requests = new Requests({
      client: {
        createPaymentRequest: async () => {
          throw new Error('unused');
        },
        listPaymentRequests: async () => ({ requests: [wire('r0'), wire('r1')], more: false, cursor: 1, syncEpoch: 1 }),
        respondPaymentRequest: async (id, response) => {
          responded.push({ id, response });
          return wire(id);
        },
      },
      kv: w.kv, ownPubkey: w.senderHex, resolvePubkey: async () => null, listAbortedTransferIds: async () => [],
      emit: () => undefined, memo: stubRequestMemoCodec,
      send: vi.fn().mockRejectedValueOnce(pending(BAD_ID)).mockRejectedValueOnce(pending('never-stored')),
    });
    await requests.drainIncoming();
    const set = w.kv.set.bind(w.kv);
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => (release = resolve));
    w.kv.set = async <T>(key: string, value: T): Promise<void> => {
      if (key === STORE_KEYS.settlingLinks) await stalled;
      return set(key, value);
    };
    const paying = [requests.pay('r0'), requests.pay('r1')].map((p) => p.catch(() => undefined));
    const run = converger(w, w.deps, createMachineStores(w.kv), {
      reconcile: (report) => requests.reconcile(report),
      linkedTransferIds: () => requests.linkedTransferIds(),
    }).run;

    await run.convergeOnce();
    expect(await w.stores().backstop.getByKey('never-stored')).toBeDefined();

    release();
    await Promise.all(paying);
    await run.convergeOnce();
    await run.convergeOnce();
    expect(responded, 'nothing moved: the request must never be responded paid').toEqual([]);
    expect(requests.list().find((view) => view.id === 'r1')?.status).toBe('pending');
  });

  it('an unreadable settling journal after the reconcile: the tombstone stays', async () => {
    const w = makeWorld();
    await neverStoredTombstone(w);
    const { run } = converger(w, w.deps, createMachineStores(w.kv), {
      linkedTransferIds: async () => {
        throw new Error('injected settling journal read failure');
      },
    });

    await run.convergeOnce();
    expect(await w.stores().backstop.getByKey('never-stored')).toBeDefined();
  });
});

describe('a kept never-stored tombstone is no progress once reported: the heartbeat backs off (#840)', () => {
  /** Drives each pass's outcome through a real heartbeat and returns the delays it scheduled. */
  async function delaysOver(run: Converger, passes: number): Promise<number[]> {
    const delays: number[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((_fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return 0;
    }) as typeof setTimeout);
    const heartbeat = new ConvergenceHeartbeat({ now: () => 0, onTick: () => undefined });
    heartbeat.start();
    for (let i = 0; i < passes; i++) heartbeat.settle(await run.convergeOnce(), await run.pendingWork());
    return delays;
  }

  it('an unreadable settling journal keeps the tombstone, and only the first pass of a session counts as progress', async () => {
    const w = makeWorld();
    await neverStoredTombstone(w);
    w.kv.failKeys.add(STORE_KEYS.settlingLinks);
    const progress: boolean[] = [];
    const first = session(w, []);
    const convergeOnce = first.convergeOnce.bind(first);
    first.convergeOnce = async () => {
      const outcome = await convergeOnce();
      progress.push(outcome.progress);
      return outcome;
    };

    const delays = await delaysOver(first, 7);

    expect(progress).toEqual([true, false, false, false, false, false, false]);
    expect(delays).toEqual([HEARTBEAT_SEED_MS, 10_000, 20_000, 40_000, 80_000, HEARTBEAT_CAP_MS, HEARTBEAT_CAP_MS]);
    expect(await w.stores().backstop.getByKey('never-stored')).toBeDefined();
    expect((await session(w, []).convergeOnce()).progress, 'a restart reports the kept verdict once').toBe(true);
  });

  it('a link still names it: re-reporting the kept verdict does not reset the backoff', async () => {
    const w = makeWorld();
    await neverStoredTombstone(w);
    const { run, reconcile } = converger(w, w.deps, createMachineStores(w.kv), {
      linkedTransferIds: async () => new Set(['never-stored']),
    });

    expect(await delaysOver(run, 3)).toEqual([HEARTBEAT_SEED_MS, 10_000, 20_000]);
    expect(reconcile.mock.calls.map((call) => (call[0] as Reconciled).conflicted)).toEqual([
      ['never-stored'],
      ['never-stored'],
      ['never-stored'],
    ]);
  });

  it('an abort that fails between the kept verdicts does not make the next one fresh progress', async () => {
    const w = makeWorld();
    await neverStoredTombstone(w);
    let pass = 0;
    w.overrides.abort = async () => {
      if (pass % 2 === 1) throw new FakeApiError(502, 'UPSTREAM', 'bad gateway');
    };
    const { run } = converger(w, w.deps, createMachineStores(w.kv), {
      linkedTransferIds: async () => new Set(['never-stored']),
    });

    const progress: boolean[] = [];
    for (; pass < 6; pass++) progress.push((await run.convergeOnce()).progress);

    expect(progress).toEqual([true, false, false, false, false, false]);
    expect(await w.stores().backstop.getByKey('never-stored')).toBeDefined();
  });

  it('another cancel judged beside a kept one, or a new verdict on a kept one, is still progress', async () => {
    const w = makeWorld();
    await neverStoredTombstone(w);
    const { run } = converger(w, w.deps, createMachineStores(w.kv), {
      linkedTransferIds: async () => new Set(['never-stored', 'second']),
    });
    expect((await run.convergeOnce()).progress).toBe(true);
    expect((await run.convergeOnce()).progress).toBe(false);

    const second = await w.stores().backstop.getByKey('never-stored');
    await w.stores().backstop.upsert({ ...second!, transferId: 'second' });
    expect((await run.convergeOnce()).progress).toBe(true);
    expect((await run.convergeOnce()).progress).toBe(false);

    // The row turns up aborted after all: a new verdict on a kept id, which the converger did not retire.
    await w.api.putIntent(w.caller, { transferId: 'never-stored', payload: second!.payloadEnvelope });
    await w.api.abortIntent(w.caller, 'never-stored');
    expect(await run.convergeOnce()).toMatchObject({ progress: true });
    expect(await w.stores().backstop.getByKey('never-stored')).toBeUndefined();
  });
});
