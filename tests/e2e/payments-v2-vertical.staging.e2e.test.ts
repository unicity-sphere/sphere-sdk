/**
 * LIVE staging money e2e for the payments-v2 VERTICAL (docs/PAYMENTS-V2-DESIGN.md
 * §10 transfer-shape matrix + standing rule): PaymentsFacade composed over the
 * REAL impl/wallet-api-v2 ports (storage/mailbox/checkpoints/session) and the
 * REAL token engine against the REAL staging wallet-api + testnet2 gateway.
 * No fakes anywhere — every seam the unit facade suite stubbed is real here.
 * The composition + convergence helpers live in support/vertical.ts (shared
 * with the cross-version interop e2e).
 *
 * Tests are SEQUENTIAL and share wallets: later tests spend earlier balances.
 *
 * Degraded-staging posture (observed: submits admitted, inclusion proofs late,
 * so the SDK correctly returns keep-open outcomes): a keep-open mint or send is
 * NEVER re-issued (F13 / #631 — a fresh id would double-pay). Convergence is
 * always the RECOVERY machinery: rebuild the vertical on the SAME kv+identity
 * and let start() replay journals / resume the SAME transferId, paced under a
 * generous deadline. Money assertions stay exact — exactly-once, conservation.
 *
 * The #835 block near the end has its own wallets, so `-t '#835'` runs it alone.
 * It injects faults on PUT /v1/intents only, over the REAL authed client. The
 * #842 block after it (`-t '#842'`, its own wallets too) injects them on
 * POST /v1/intents/:id/complete and POST /v1/inventory/apply.
 *
 * Gated on STAGING_AGGREGATOR_KEY. Run:
 *   set -a && source .env && set +a && npx vitest run --config vitest.e2e.config.ts \
 *     tests/e2e/payments-v2-vertical.staging.e2e.test.ts
 */
import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { isPossiblyCommittedSendOutcome, SphereError } from '../../core/errors';
import { WalletApiV2Client, type HistoryRecordWire } from '../../impl/wallet-api-v2/client';
import { createWalletApiHttp, WalletApiHttpError } from '../../impl/wallet-api-v2/http';
import type { DeliveryPort, StoragePort } from '../../modules/payments-v2/ports';
import { createMachineStores } from '../../modules/payments-v2/machine/journal';
import { INTENT_UNCONFIRMED_MESSAGE } from '../../modules/payments-v2/send-errors';
import type { TransferResult } from '../../types';
import { BASE_URL, HARNESS_COIN, randomIdentity } from './support/staging';
import { memoryKV, RUN_STAGING as RUN } from './support/staging';
import {
  activeRows,
  convergeByReplay,
  drainUntil,
  historyEntries,
  localTotal,
  logStep,
  makeVerticalWallet,
  mintConverged,
  must,
  openIntentIds,
  PACE_MS,
  receivedLegs,
  SEND_CONVERGE_MS,
  sendConverged,
  serverTotal,
  shutdownVerticalWallets,
  sleep,
  waitFor,
  type AuthedClient,
  type VWallet,
} from './support/vertical';

afterAll(async () => {
  await shutdownVerticalWallets();
}, 240_000);

// ── wallets shared ACROSS tests (sequential; later tests spend earlier balances) ──

let walletA: VWallet | undefined;
let walletB: VWallet | undefined;
let mintedA = ''; // test 1: A's minted 1000-token genesis id
let splitToA = ''; // test 3: the fresh 400 genesis A received from B's split
let legsBeforeRoundtrip = 0; // test 5: A's RECEIVED count for splitToA before the roundtrip

describe.runIf(RUN)('LIVE staging: payments-v2 vertical (facade over real ports + engine)', () => {
  it('mint: journal-first self-mint lands on-chain, in server inventory, and in MINT history — exactly once, whatever the attempt count', async () => {
    walletA = await makeVerticalWallet('a');

    const minted = await mintConverged(walletA, 1000n, 'mint A 1000');
    walletA = minted.wallet;
    const a = walletA;
    mintedA = minted.tokenId;
    expect(mintedA).toMatch(/^[0-9a-f]+$/);

    // Journal-first lifecycle: convergence (direct or replayed) drains the journal.
    expect(await createMachineStores(a.kv).mintJournal.list()).toEqual([]);

    await waitFor(a, () => localTotal(a) === 1000n, 60_000, 'A local view shows the 1000 mint');
    const assets = await a.facade.assets(HARNESS_COIN);
    expect(assets).toHaveLength(1);
    expect(assets[0]?.totalAmount).toBe('1000');
    expect(a.facade.tokens().map((t) => t.id)).toEqual([mintedA]);

    const rows = await activeRows(a);
    expect(rows).toHaveLength(1); // exactly ONE token — replay never double-mints
    expect(rows[0]?.tokenId).toBe(mintedA);
    expect(await serverTotal(a)).toBe(1000n);

    await waitFor(
      a,
      async () =>
        (await historyEntries(a)).some((e) => e.type === 'MINT' && e.tokenId === mintedA && e.amount === '1000'),
      30_000,
      'MINT history record'
    );
    // Exactly ONE MINT record, however many replay cycles convergence took.
    const mintRecords = (await historyEntries(a)).filter((e) => e.type === 'MINT');
    expect(mintRecords).toHaveLength(1);
    expect(mintRecords[0]).toMatchObject({ tokenId: mintedA, amount: '1000' });
  }, 1_800_000);

  it('exact single: whole-token A→B; recipient verifies before balance; intent completes', async () => {
    walletB = await makeVerticalWallet('b');
    const b = walletB;

    const bPaid = async (): Promise<boolean> => {
      await b.facade.receive().catch(() => undefined);
      return localTotal(b) === 1000n;
    };
    const sent = await sendConverged(
      must(walletA, 'wallet A'),
      { recipient: b.identity.chainPubkey, amount: '1000', coinId: HARNESS_COIN },
      bPaid,
      'send A→B 1000'
    );
    walletA = sent.wallet;
    const a = walletA;
    if (sent.result !== null) {
      expect(['delivered', 'confirmed']).toContain(sent.result.status);
      expect(sent.result.tokenTransfers).toEqual([{ sourceTokenId: mintedA, method: 'direct' }]);
    }

    // B's acceptance implies the full real trust-base verify + isOwnedBy passed
    // (Receive screens BEFORE store/claim); the claim puts the row in B's inventory.
    await drainUntil(b, () => localTotal(b) === 1000n, 90_000, 'B receives 1000');
    expect((await activeRows(b)).map((r) => r.tokenId)).toEqual([mintedA]);
    expect(await serverTotal(b)).toBe(1000n);

    await waitFor(a, async () => (await serverTotal(a)) === 0n && localTotal(a) === 0n, 60_000, 'A drained to 0');

    await waitFor(
      a,
      async () => (await historyEntries(a)).some((e) => e.type === 'SENT' && e.transferId === sent.transferId),
      30_000,
      'A SENT history record'
    );
    expect(await receivedLegs(b, mintedA)).toHaveLength(1);

    // closeTail is fire-and-forget after send() resolves — poll to empty.
    await waitFor(a, async () => (await openIntentIds(a)).length === 0, 60_000, 'A open intents empty');
    // The certified blob left exactly once: A's delivery journal is drained.
    await waitFor(a, async () => (await createMachineStores(a.kv).deliveryJournal.list()).length === 0, 30_000, 'A delivery journal drained');
  }, 1_500_000);

  it('split: B→A 400 of 1000 — burn+checkpoint+mints; change stays with B', async () => {
    const a = must(walletA, 'wallet A');

    const aPaid = async (): Promise<boolean> => {
      await a.facade.receive().catch(() => undefined);
      return localTotal(a) === 400n;
    };
    const sent = await sendConverged(
      must(walletB, 'wallet B'),
      { recipient: a.identity.chainPubkey, amount: '400', coinId: HARNESS_COIN },
      aPaid,
      'split B→A 400'
    );
    walletB = sent.wallet;
    const b = walletB;
    if (sent.result !== null) {
      expect(['delivered', 'confirmed']).toContain(sent.result.status);
      expect(sent.result.tokenTransfers).toEqual([{ sourceTokenId: mintedA, method: 'split' }]);
    }

    await drainUntil(a, () => localTotal(a) === 400n, 90_000, 'A receives the 400 split output');
    const aTokens = a.facade.tokens();
    expect(aTokens).toHaveLength(1);
    splitToA = must(aTokens[0], 'A split-output token').id;
    expect(splitToA).not.toBe(mintedA); // split mints a FRESH genesis
    legsBeforeRoundtrip = (await receivedLegs(a, splitToA)).length;
    expect(legsBeforeRoundtrip).toBe(1);

    // B keeps exactly the 600 change (fresh genesis), locally and on the server.
    await waitFor(
      b,
      () => {
        const tokens = b.facade.tokens();
        return tokens.length === 1 && tokens[0]?.amount === '600' && tokens[0].id !== mintedA;
      },
      90_000,
      'B local view settles to the 600 change token'
    );
    const changeId = must(b.facade.tokens()[0], 'B change token').id;
    const bRows = await activeRows(b);
    expect(bRows.map((r) => r.tokenId)).toEqual([changeId]);
    expect(await serverTotal(b)).toBe(600n);

    // The split is SENT-recorded under the same transferId, direct or resumed.
    await waitFor(
      b,
      async () => (await historyEntries(b)).some((e) => e.type === 'SENT' && e.transferId === sent.transferId),
      30_000,
      'B SENT history record'
    );

    // requiresSeedClose intent: an empty open list proves the SIGNED seed-close
    // (wallet-api.complete.v1) was accepted by the real server gate.
    await waitFor(b, async () => (await openIntentIds(b)).length === 0, 60_000, 'B open intents empty');
    await waitFor(b, async () => (await createMachineStores(b.kv).deliveryJournal.list()).length === 0, 30_000, 'B delivery journal drained');
  }, 1_500_000);

  it('self-send: spend and claim commute; no phantom, no double', async () => {
    const selfSettled = async (w: VWallet): Promise<boolean> => {
      await w.facade.receive().catch(() => undefined);
      return (
        localTotal(w) === 400n &&
        (await serverTotal(w)) === 400n &&
        (await receivedLegs(w, splitToA)).length === 2
      );
    };
    const sent = await sendConverged(
      must(walletA, 'wallet A'),
      { recipient: must(walletA, 'wallet A').identity.chainPubkey, amount: '400', coinId: HARNESS_COIN },
      selfSettled,
      'self-send A 400'
    );
    walletA = sent.wallet;
    const a = walletA;
    if (sent.result !== null) {
      expect(['delivered', 'confirmed']).toContain(sent.result.status);
      expect(sent.result.tokenTransfers).toEqual([{ sourceTokenId: splitToA, method: 'direct' }]);
    }

    // The self-output rides A's own mailbox; the claim reactivates the row at
    // the NEW state. Settled = same genesis, same value, exactly once.
    await drainUntil(
      a,
      async () =>
        localTotal(a) === 400n &&
        (await serverTotal(a)) === 400n &&
        (await receivedLegs(a, splitToA)).length === 2,
      120_000,
      'A self-send round-trips through the mailbox'
    );

    const rows = await activeRows(a);
    expect(rows.map((r) => r.tokenId)).toEqual([splitToA]); // one active row — no phantom, no double
    expect(a.facade.tokens().map((t) => ({ id: t.id, amount: t.amount }))).toEqual([
      { id: splitToA, amount: '400' },
    ]);
    legsBeforeRoundtrip = 2; // (splitToA@mint-state, splitToA@self-send-state)
    await waitFor(a, async () => (await openIntentIds(a)).length === 0, 60_000, 'A open intents empty');
  }, 1_500_000);

  it('roundtrip A→B→A: the re-acquired genesis at a NEW state is accepted; two RECEIVED legs', async () => {
    const b = must(walletB, 'wallet B');

    const bHolds1000 = async (): Promise<boolean> => {
      await b.facade.receive().catch(() => undefined);
      return localTotal(b) === 1000n;
    };
    const out = await sendConverged(
      must(walletA, 'wallet A'),
      { recipient: b.identity.chainPubkey, amount: '400', coinId: HARNESS_COIN },
      bHolds1000,
      'roundtrip A→B 400'
    );
    walletA = out.wallet;
    const a = walletA;
    if (out.result !== null) {
      expect(out.result.tokenTransfers).toEqual([{ sourceTokenId: splitToA, method: 'direct' }]);
    }
    await drainUntil(b, () => localTotal(b) === 1000n, 90_000, 'B holds 600 change + the 400 roundtrip token');
    expect(await receivedLegs(b, splitToA)).toHaveLength(1);

    // B's pool is {600, 400}: exact-single selection MUST send the SAME genesis back whole.
    const aReacquired = async (): Promise<boolean> => {
      await a.facade.receive().catch(() => undefined);
      return localTotal(a) === 400n && (await receivedLegs(a, splitToA)).length === legsBeforeRoundtrip + 1;
    };
    const back = await sendConverged(
      b,
      { recipient: a.identity.chainPubkey, amount: '400', coinId: HARNESS_COIN },
      aReacquired,
      'roundtrip B→A 400'
    );
    walletB = back.wallet;
    const b2 = walletB;
    if (back.result !== null) {
      expect(back.result.tokenTransfers).toEqual([{ sourceTokenId: splitToA, method: 'direct' }]);
    }

    // Per-state dedup accepts the re-acquired genesis at its NEW state: the
    // roundtrip return is a FRESH leg on top of the two prior states (test 3
    // receipt + test 4 self-send), never deduped away and never doubled.
    await drainUntil(
      a,
      async () =>
        localTotal(a) === 400n && (await receivedLegs(a, splitToA)).length === legsBeforeRoundtrip + 1,
      120_000,
      'A re-acquires the same genesis at a new state'
    );
    expect(await receivedLegs(a, splitToA)).toHaveLength(3);
    expect((await activeRows(a)).map((r) => r.tokenId)).toEqual([splitToA]);
    expect(await serverTotal(a)).toBe(400n);
    await waitFor(b2, async () => (await serverTotal(b2)) === 600n && localTotal(b2) === 600n, 60_000, 'B back to 600');
  }, 2_400_000);

  it('crash-window resume: a deposit that fails once is journaled and a SECOND instance replays it — recipient paid exactly once', async () => {
    // Fail the FIRST deliverBatch call AND the FIRST deliver call, then pass through:
    // the certified blob must survive in the journal across the simulated crash.
    const failOnce = (inner: DeliveryPort): DeliveryPort => {
      let batchFailed = false;
      let deliverFailed = false;
      return {
        bindDeliveryKeys: (derive) => inner.bindDeliveryKeys(derive),
        deliver: async (recipient, blob, options) => {
          if (!deliverFailed) {
            deliverFailed = true;
            throw new Error('synthetic network error: deliver (crash window)');
          }
          return inner.deliver(recipient, blob, options);
        },
        deliverBatch: async (recipient, blobs, options) => {
          if (!batchFailed) {
            batchFailed = true;
            throw new Error('synthetic network error: deliverBatch (crash window)');
          }
          return inner.deliverBatch!(recipient, blobs, options);
        },
        incoming: (since) => inner.incoming(since),
        incomingEpoch: () => inner.incomingEpoch(),
        ack: (id, disposition, reason) => inner.ack(id, disposition, reason),
        ...(inner.onWake !== undefined ? { onWake: inner.onWake.bind(inner) } : {}),
      };
    };

    const cIdentity = randomIdentity();
    const cKv = memoryKV();
    let c1 = await makeVerticalWallet('c', { identity: cIdentity, kv: cKv, wrapDelivery: failOnce });
    const d = await makeVerticalWallet('d');

    const minted = await mintConverged(c1, 500n, 'mint C 500', { wrapDelivery: failOnce });
    c1 = minted.wallet;
    const genesis = minted.tokenId;
    await waitFor(c1, () => localTotal(c1) === 500n, 60_000, 'C local view shows the 500 mint');

    let sendResult: TransferResult | null = null;
    try {
      sendResult = await c1.facade.send({
        recipient: d.identity.chainPubkey,
        amount: '500',
        coinId: HARNESS_COIN,
      });
    } catch (err) {
      // Degraded staging can keep-open the CERTIFICATION leg too; the same
      // second-instance replay covers both windows (#631 — same transferId).
      if (!isPossiblyCommittedSendOutcome(err)) throw err;
      logStep(`crash-window: certification keep-open (${(err as Error).message.slice(0, 80)}…)`);
    }
    if (sendResult !== null) {
      // Certification succeeded, both delivery attempts failed: the send resolves
      // with the blob JOURNALED, never lost and never re-certified.
      expect(sendResult.deliveryPending).toBe(true);
      expect(sendResult.status).toBe('confirmed');
      const journaled = await createMachineStores(cKv).deliveryJournal.list();
      expect(journaled).toHaveLength(1);
      expect(journaled[0]?.transferId).toBe(sendResult.id);
      expect(journaled[0]?.recipientPubkey).toBe(d.identity.chainPubkey);
    }

    // Simulated crash: instance 1 goes away; instance 2 rises on the SAME kv + identity.
    await c1.facade.stop();
    let c2 = await makeVerticalWallet('c', { identity: cIdentity, kv: cKv });

    const dPaid = async (): Promise<boolean> => {
      await d.facade.receive().catch(() => undefined);
      return localTotal(d) === 500n && (await serverTotal(d)) === 500n;
    };
    try {
      await drainUntil(d, async () => localTotal(d) === 500n && (await serverTotal(d)) === 500n, 120_000, 'D paid via journal replay');
    } catch {
      // Still degraded: keep replaying the SAME journals/intents, paced.
      logStep('crash-window: second instance did not converge in one window — paced replay cycles');
      c2 = await convergeByReplay(c2, dPaid, SEND_CONVERGE_MS, 'crash-window replay');
    }
    await waitFor(c2, async () => (await createMachineStores(cKv).deliveryJournal.list()).length === 0, 60_000, 'C journal drained');
    await waitFor(c2, async () => (await openIntentIds(c2)).length === 0, 60_000, 'C open intents empty');
    expect(await serverTotal(c2)).toBe(0n);

    // No double delivery: a further 10 s drain window changes NOTHING for D.
    await sleep(10_000);
    await d.facade.receive().catch(() => undefined);
    expect(localTotal(d)).toBe(500n);
    expect(await serverTotal(d)).toBe(500n);
    expect((await activeRows(d)).map((r) => r.tokenId)).toEqual([genesis]);
    expect(await receivedLegs(d, genesis)).toHaveLength(1);
  }, 3_000_000);
});

// ── #835: a PUT /v1/intents whose outcome the client cannot see ──────────────
//
// Faults ride PUT /v1/intents only, over the REAL authed client
// (MakeOptions.wrapClient); the session, every other call, the ports, the engine
// and the gateway stay real. The shapes are what impl/wallet-api-v2/http.ts
// produces: fetchRaw's status-0 NETWORK wrapper, and the wallet-api 429
// RATE_LIMITED envelope (wallet-api src/lib/errors.ts). 'gateway-200' runs the PUT
// through the real http layer and client against a hop that answers an empty 200
// itself and never forwards the request.

type PutFault = 'response-lost' | 'network-down' | 'rate-limited' | 'gateway-200';

interface PutCall {
  readonly transferId: string;
  readonly envelope: string;
  readonly requiresSeedClose: boolean | undefined;
  readonly fault: PutFault | null;
}

interface PutFaults {
  readonly calls: PutCall[];
  /** Every error the wrapper raised, in order. */
  readonly thrown: WalletApiHttpError[];
  /** The next PUTs end in these faults, in order; after them PUTs pass through. */
  queue(...faults: PutFault[]): void;
  /** Every PUT fails before it leaves the client, until unwrap(). */
  outage(fault: 'network-down' | 'rate-limited' | 'gateway-200'): void;
  /** Back to the plain real client. */
  unwrap(): void;
  wrap(inner: AuthedClient): AuthedClient;
}

function putFaults(): PutFaults {
  const calls: PutCall[] = [];
  const thrown: WalletApiHttpError[] = [];
  const queued: PutFault[] = [];
  let outage: PutFault | null = null;
  const raise = (err: WalletApiHttpError): WalletApiHttpError => {
    thrown.push(err);
    return err;
  };
  const hop = new WalletApiV2Client(
    createWalletApiHttp({
      baseUrl: BASE_URL,
      fetchFn: async () => ({ status: 200, ok: true, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }),
      getToken: () => null,
    })
  );
  const network = (transferId: string, when: string): WalletApiHttpError =>
    new WalletApiHttpError(
      0,
      'NETWORK',
      `wallet-api request failed: PUT ${BASE_URL}/v1/intents/${transferId}: synthetic connection reset ${when} (#835)`
    );
  return {
    calls,
    thrown,
    queue: (...faults) => {
      queued.push(...faults);
    },
    outage: (fault) => {
      outage = fault;
    },
    unwrap: () => {
      outage = null;
      queued.length = 0;
    },
    wrap: (inner) => ({
      ...inner,
      putIntent: async (transferId, envelope, requiresSeedClose) => {
        const fault = outage ?? queued.shift() ?? null;
        calls.push({ transferId, envelope, requiresSeedClose, fault });
        if (fault === 'network-down') throw raise(network(transferId, 'before the request left'));
        if (fault === 'gateway-200') {
          const answer = await hop.putIntent(transferId, envelope, requiresSeedClose).then(
            () => new Error('the real client read a 200 from a hop as a stored intent'),
            (err: unknown) => err
          );
          if (!(answer instanceof WalletApiHttpError)) throw answer;
          throw raise(answer);
        }
        if (fault === 'rate-limited') {
          throw raise(new WalletApiHttpError(429, 'RATE_LIMITED', `PUT /v1/intents/${transferId}: rate limit exceeded`, 1_000));
        }
        await inner.putIntent(transferId, envelope, requiresSeedClose);
        // The server stored (or matched) the row; only its answer is lost.
        if (fault === 'response-lost') throw raise(network(transferId, 'after the server answered'));
      },
    }),
  };
}

/** One send is one transferId (never re-issued), and every (re-)PUT of it carries the SAME stored bytes. */
function expectOneIntent(calls: readonly PutCall[], transferId: string): void {
  expect([...new Set(calls.map((c) => c.transferId))], 'one send, one transferId').toEqual([transferId]);
  expect(new Set(calls.map((c) => c.envelope)).size, 'every (re-)PUT carries the same envelope').toBe(1);
  expect(new Set(calls.map((c) => c.requiresSeedClose)).size).toBe(1);
}

/** The server never had a row: GET progress answers the typed 404, and neither listing names it. */
async function expectNoServerRow(w: VWallet, transferId: string): Promise<void> {
  const answer = await w.api.getProgress(transferId).then(
    (records) => records,
    (err: unknown) => err
  );
  expect(answer, 'GET /v1/intents/<id>/progress for an intent the server never stored').toBeInstanceOf(WalletApiHttpError);
  expect((answer as WalletApiHttpError).status).toBe(404);
  expect((answer as WalletApiHttpError).code).toBe('NOT_FOUND');
  expect(await openIntentIds(w)).not.toContain(transferId);
  expect((await w.api.listIntents('aborted')).map((i) => i.transferId)).not.toContain(transferId);
}

function failedUpdates(w: VWallet, transferId: string, fromEvent: number): TransferResult[] {
  return w.events
    .slice(fromEvent)
    .filter((x) => x.event === 'transfer:updated')
    .map((x) => x.payload as TransferResult)
    .filter((r) => r.id === transferId && r.status === 'failed');
}

async function paid(w: VWallet, amount: bigint): Promise<boolean> {
  await w.facade.receive().catch(() => undefined);
  return localTotal(w) === amount && (await serverTotal(w)) === amount;
}

async function sentRecords(w: VWallet, transferId: string): Promise<unknown[]> {
  return (await historyEntries(w)).filter((x) => x.type === 'SENT' && x.transferId === transferId);
}

// Wallets shared ACROSS the three tests (sequential): one 100 token minted by E
// travels E→F (lost response), back F→E (held, then converged), and E→F is
// refused (429) — so the block needs no wallet from the suite above.
let walletE: VWallet | undefined;
let walletF: VWallet | undefined;
let tokenE = '';
const eFaults = putFaults();
const fFaults = putFaults();

describe.runIf(RUN)('LIVE staging: #835 PUT /v1/intents with an unknown outcome (real client, faulted PUT)', () => {
  it('a PUT whose response is lost after the server stored it: the immediate re-PUT is absorbed — delivered exactly once, one transferId', async () => {
    walletE = await makeVerticalWallet('e', { wrapClient: eFaults.wrap });
    walletF = await makeVerticalWallet('f', { wrapClient: fFaults.wrap });
    const minted = await mintConverged(walletE, 100n, 'mint E 100', { wrapClient: eFaults.wrap });
    walletE = minted.wallet;
    tokenE = minted.tokenId;
    const e = walletE;
    const f = walletF;
    await waitFor(e, () => localTotal(e) === 100n, 60_000, 'E local view shows the 100 mint');

    const first = eFaults.calls.length;
    eFaults.queue('response-lost');
    let result: TransferResult | null = null;
    let transferId: string;
    try {
      result = await e.facade.send({ recipient: f.identity.chainPubkey, amount: '100', coinId: HARNESS_COIN });
      transferId = result.id;
    } catch (err) {
      // Degraded staging can keep-open the CERTIFICATION after the gate passed:
      // the SAME transferId converges (#631), never a second send.
      if (!isPossiblyCommittedSendOutcome(err)) throw err;
      transferId = must((err as SphereError).transferId, 'keep-open transferId');
      logStep(`#835 lost response: keep-open ${transferId} (${(err as Error).message.slice(0, 80)}…)`);
    }
    const gate = eFaults.calls.slice(first);
    expect(gate.map((c) => c.fault), 'the lost answer, then ONE re-PUT that the server answered 2xx').toEqual([
      'response-lost',
      null,
    ]);
    expectOneIntent(gate, transferId);
    if (result !== null) {
      expect(['delivered', 'confirmed']).toContain(result.status);
      expect(result.tokenTransfers).toEqual([{ sourceTokenId: tokenE, method: 'direct' }]);
    }
    let sender = e;
    if (result === null || result.deliveryPending === true) {
      sender = await convergeByReplay(e, () => paid(f, 100n), SEND_CONVERGE_MS, '#835 lost response E→F', {
        wrapClient: eFaults.wrap,
      });
      walletE = sender;
    }

    // Exactly once: F holds the one token at one RECEIVED leg; E is drained under ONE SENT record.
    await drainUntil(f, () => localTotal(f) === 100n, 90_000, 'F receives the 100');
    expect((await activeRows(f)).map((r) => r.tokenId)).toEqual([tokenE]);
    expect(await serverTotal(f)).toBe(100n);
    await waitFor(sender, async () => (await serverTotal(sender)) === 0n && localTotal(sender) === 0n, 60_000, 'E drained to 0');
    await waitFor(sender, async () => (await sentRecords(sender, transferId)).length > 0, 30_000, 'E SENT history record');
    expect(await sentRecords(sender, transferId)).toHaveLength(1);
    await waitFor(sender, async () => (await openIntentIds(sender)).length === 0, 60_000, 'E open intents empty');
    await waitFor(sender, async () => (await sender.facade.pendingTransfers()).length === 0, 60_000, 'E nothing pending');

    // No double delivery: a further 10 s drain window changes NOTHING for F.
    await sleep(10_000);
    await f.facade.receive().catch(() => undefined);
    expect(localTotal(f)).toBe(100n);
    expect(await serverTotal(f)).toBe(100n);
    expect(await receivedLegs(f, tokenE)).toHaveLength(1);
  }, 3_000_000);

  it('a PUT that never leaves, 3 times: SEND_SYNC_PENDING with its transferId and no server row; unwrapped, resumeNow PUTs the SAME intent and runs it — delivered exactly once', async () => {
    const e = must(walletE, 'wallet E');
    const f = must(walletF, 'wallet F');
    await waitFor(
      f,
      () => f.facade.tokens().some((t) => t.id === tokenE && t.status === 'confirmed'),
      60_000,
      'F holds the 100 spendable'
    );

    const first = fFaults.calls.length;
    const firstEvent = f.events.length;
    fFaults.outage('network-down');
    const outcome = await f.facade
      .send({ recipient: e.identity.chainPubkey, amount: '100', coinId: HARNESS_COIN })
      .then(
        (result) => ({ result }),
        (error: unknown) => ({ error })
      );
    const gate = fFaults.calls.slice(first);

    expect('error' in outcome, 'a send whose PUT outcome stayed unknown never resolves').toBe(true);
    const held = (outcome as { error: unknown }).error as SphereError;
    expect(held).toBeInstanceOf(SphereError);
    expect(held.code).toBe('SEND_SYNC_PENDING');
    expect(isPossiblyCommittedSendOutcome(held)).toBe(true);
    expect(held.message).toBe(INTENT_UNCONFIRMED_MESSAGE);
    expect(held.cause, 'the last answer rides as the cause').toBe(fFaults.thrown[fFaults.thrown.length - 1]);
    const transferId = must(held.transferId, 'held transferId');
    expect(gate.map((c) => c.fault), 'the PUT and two immediate re-PUTs, none of which left the client').toEqual([
      'network-down',
      'network-down',
      'network-down',
    ]);
    expectOneIntent(gate, transferId);

    // Held, not failed: no 'failed' update, the entry waits for the converger, the source stays pinned.
    expect(failedUpdates(f, transferId, firstEvent)).toEqual([]);
    const entry = await createMachineStores(f.kv).backstop.getByKey(transferId);
    expect(entry?.disposition).toBe('open');
    expect(entry?.intentPut).toBe('unconfirmed');
    expect(gate[0]?.envelope, 'the PUT bytes are the stored envelope').toBe(entry?.payloadEnvelope);
    expect((await f.facade.pendingTransfers()).map((p) => [p.transferId, p.kind])).toEqual([[transferId, 'open']]);
    expect(f.facade.tokens().find((t) => t.id === tokenE)?.status, 'a held send keeps its source').toBe('transferring');
    await expectNoServerRow(f, transferId);
    expect(await serverTotal(f), 'nothing ran: F still holds the 100 on the server').toBe(100n);

    // Unwrapped. The retry verb, never send(): a pass re-PUTs the held entry's SAME
    // envelope (no row is listed), and a later one runs it from the listing.
    // resumeNow coalesces onto a pass already in flight, so keep asking, paced.
    fFaults.unwrap();
    await f.facade.resumeNow();
    await f.facade.resumeNow();
    let lastResume = Date.now();
    await drainUntil(
      e,
      async () => {
        if (Date.now() - lastResume >= PACE_MS) {
          lastResume = Date.now();
          await f.facade.resumeNow();
        }
        return localTotal(e) === 100n && (await serverTotal(e)) === 100n;
      },
      SEND_CONVERGE_MS,
      'E paid by the held send, converged in-session'
    );

    const all = fFaults.calls.slice(first);
    expectOneIntent(all, transferId);
    expect(
      all.filter((c) => c.fault === null).length,
      'the converger PUT the held intent once the service answered'
    ).toBeGreaterThanOrEqual(1);
    expect((await activeRows(e)).map((r) => r.tokenId)).toEqual([tokenE]);
    expect(await receivedLegs(e, tokenE)).toHaveLength(1);
    await waitFor(f, async () => (await serverTotal(f)) === 0n && localTotal(f) === 0n, 60_000, 'F drained to 0');
    await waitFor(f, async () => (await sentRecords(f, transferId)).length > 0, 30_000, 'F SENT history record');
    expect(await sentRecords(f, transferId)).toHaveLength(1);
    await waitFor(f, async () => (await openIntentIds(f)).length === 0, 60_000, 'F open intents empty');
    await waitFor(f, async () => (await f.facade.pendingTransfers()).length === 0, 60_000, 'F nothing pending');
    expect(failedUpdates(f, transferId, firstEvent)).toEqual([]);

    // No double delivery: a further 10 s drain window changes NOTHING for E.
    await sleep(10_000);
    await e.facade.receive().catch(() => undefined);
    expect(localTotal(e)).toBe(100n);
    expect(await serverTotal(e)).toBe(100n);
    expect(await receivedLegs(e, tokenE)).toHaveLength(1);
  }, 1_500_000);

  it('two pre-write 429 RATE_LIMITED answers: a clean rejection, nothing held, and the server never had a row for that transferId', async () => {
    const e = must(walletE, 'wallet E');
    const f = must(walletF, 'wallet F');
    await waitFor(
      e,
      () => e.facade.tokens().some((t) => t.id === tokenE && t.status === 'confirmed'),
      60_000,
      'E holds the 100 spendable'
    );

    const first = eFaults.calls.length;
    const firstEvent = e.events.length;
    eFaults.queue('rate-limited', 'rate-limited');
    const outcome = await e.facade
      .send({ recipient: f.identity.chainPubkey, amount: '100', coinId: HARNESS_COIN })
      .then(
        (result) => ({ result }),
        (error: unknown) => ({ error })
      );
    const gate = eFaults.calls.slice(first);

    expect(gate.map((c) => c.fault), 'two typed refusals, nothing ambiguous before them: no third PUT').toEqual([
      'rate-limited',
      'rate-limited',
    ]);
    const transferId = must(gate[0], 'the refused PUT').transferId;
    expectOneIntent(gate, transferId);
    expect('error' in outcome, 'a refused PUT never resolves the send').toBe(true);
    const err = (outcome as { error: unknown }).error;
    expect(err, 'the wire refusal itself is the verdict').toBe(eFaults.thrown[eFaults.thrown.length - 1]);
    expect(err).toBeInstanceOf(WalletApiHttpError);
    expect((err as WalletApiHttpError).status).toBe(429);
    expect((err as WalletApiHttpError).code).toBe('RATE_LIMITED');
    expect(isPossiblyCommittedSendOutcome(err)).toBe(false);
    expect(failedUpdates(e, transferId, firstEvent)).toHaveLength(1);

    // Nothing held anywhere: no backstop entry, no pending row, the source spendable again.
    expect(await createMachineStores(e.kv).backstop.getByKey(transferId)).toBeUndefined();
    expect(await e.facade.pendingTransfers()).toEqual([]);
    expect(e.facade.tokens().map((t) => ({ id: t.id, amount: t.amount, status: t.status }))).toEqual([
      { id: tokenE, amount: '100', status: 'confirmed' },
    ]);
    await expectNoServerRow(e, transferId);
    expect(await serverTotal(e)).toBe(100n);

    // A convergence pass never ensures a refused attempt: no further PUT, still no row.
    await e.facade.resumeNow();
    expect(eFaults.calls.slice(first)).toHaveLength(2);
    await expectNoServerRow(e, transferId);
    expect(await paid(f, 0n), 'F was never paid').toBe(true);
    expect(localTotal(e)).toBe(100n);
  }, 600_000);

  it('a PUT answered 200 by a hop that never forwarded it, 3 times: held, no server row; unwrapped, it converges — delivered exactly once', async () => {
    const e = must(walletE, 'wallet E');
    const f = must(walletF, 'wallet F');

    const first = eFaults.calls.length;
    const firstEvent = e.events.length;
    const legsBefore = (await receivedLegs(f, tokenE)).length; // F received this token once already, E→F above
    eFaults.outage('gateway-200');
    const outcome = await e.facade
      .send({ recipient: f.identity.chainPubkey, amount: '100', coinId: HARNESS_COIN })
      .then(
        (result) => ({ result }),
        (error: unknown) => ({ error })
      );
    const gate = eFaults.calls.slice(first);

    expect('error' in outcome, 'a 2xx other than 204 never confirms the intent').toBe(true);
    const held = (outcome as { error: unknown }).error as SphereError;
    expect(held.code).toBe('SEND_SYNC_PENDING');
    expect(held.message).toBe(INTENT_UNCONFIRMED_MESSAGE);
    expect(held.cause).toBe(eFaults.thrown[eFaults.thrown.length - 1]);
    expect(held.cause).toMatchObject({ status: 200, code: 'PROTOCOL' });
    const transferId = must(held.transferId, 'held transferId');
    expect(gate.map((c) => c.fault)).toEqual(['gateway-200', 'gateway-200', 'gateway-200']);
    expectOneIntent(gate, transferId);
    expect(failedUpdates(e, transferId, firstEvent)).toEqual([]);
    expect((await createMachineStores(e.kv).backstop.getByKey(transferId))?.intentPut).toBe('unconfirmed');
    await expectNoServerRow(e, transferId);
    expect(await serverTotal(e), 'nothing ran: E still holds the 100 on the server').toBe(100n);

    eFaults.unwrap();
    await e.facade.resumeNow();
    await e.facade.resumeNow();
    let lastResume = Date.now();
    await drainUntil(
      f,
      async () => {
        if (Date.now() - lastResume >= PACE_MS) {
          lastResume = Date.now();
          await e.facade.resumeNow();
        }
        return localTotal(f) === 100n && (await serverTotal(f)) === 100n;
      },
      SEND_CONVERGE_MS,
      'F paid by the held send, converged in-session'
    );

    expectOneIntent(eFaults.calls.slice(first), transferId);
    expect(await receivedLegs(f, tokenE)).toHaveLength(legsBefore + 1);
    await waitFor(e, async () => (await serverTotal(e)) === 0n && localTotal(e) === 0n, 60_000, 'E drained to 0');
    await waitFor(e, async () => (await openIntentIds(e)).length === 0, 60_000, 'E open intents empty');
    expect(failedUpdates(e, transferId, firstEvent)).toEqual([]);
    await sleep(10_000);
    await f.facade.receive().catch(() => undefined);
    expect(localTotal(f)).toBe(100n);
    expect(await receivedLegs(f, tokenE)).toHaveLength(legsBefore + 1);
  }, 1_500_000);
});

// ── #842: SENT history is posted beside the apply, never gated on the close ───
//
// Faults ride POST /v1/intents/:id/complete (over the facade's REAL authed client,
// MakeOptions.wrapClient) and POST /v1/inventory/apply (over the facade's REAL
// storage port, MakeOptions.wrapStorage). The apply completes an unflagged intent on
// the server, so once it commits no pass lists the row again: the SENT row must
// already be on its way, whatever the close or the apply's answer did.

interface CloseFaults {
  /** Which faults fired, in order. */
  readonly fired: ('complete-503' | 'apply-answer-lost')[];
  /** Every SENT record the facade POSTed, in order (a re-POST included). */
  readonly sent: HistoryRecordWire[];
  /** The next complete answers 503 before it reaches the server. */
  failCompleteOnce(): void;
  /** The next apply commits on the server, then its answer is lost. */
  loseApplyAnswerOnce(): void;
  wrapClient(inner: AuthedClient): AuthedClient;
  wrapStorage(inner: StoragePort): StoragePort;
}

function closeFaults(): CloseFaults {
  const fired: CloseFaults['fired'] = [];
  const sent: HistoryRecordWire[] = [];
  let completeArmed = false;
  let applyArmed = false;
  return {
    fired,
    sent,
    failCompleteOnce: () => {
      completeArmed = true;
    },
    loseApplyAnswerOnce: () => {
      applyArmed = true;
    },
    wrapClient: (inner) => ({
      ...inner,
      completeIntent: async (transferId, signature) => {
        if (completeArmed) {
          completeArmed = false;
          fired.push('complete-503');
          throw new WalletApiHttpError(503, 'HTTP_503', `POST /v1/intents/${transferId}/complete failed with status 503 (synthetic, #842)`);
        }
        await inner.completeIntent(transferId, signature);
      },
      postHistory: async (records) => {
        sent.push(...records.filter((r) => r.type === 'SENT'));
        return inner.postHistory(records);
      },
    }),
    // WalletApiStoragePort is a class: forward each member, a spread would drop its prototype methods.
    wrapStorage: (inner) => ({
      listInventory: (since) => inner.listInventory(since),
      getBlobs: (ids) => inner.getBlobs(ids),
      uploadBlobs: (blobs) => inner.uploadBlobs(blobs),
      applyDelta: async (delta) => {
        const result = await inner.applyDelta(delta);
        if (!applyArmed) return result;
        applyArmed = false;
        fired.push('apply-answer-lost');
        throw new WalletApiHttpError(0, 'NETWORK', `wallet-api request failed: POST ${BASE_URL}/v1/inventory/apply: synthetic connection reset after the server answered (#842)`);
      },
    }),
  };
}

/** Run convergence passes, paced, until nothing of `transferId` is left open or pending on `w`. */
async function settledByPasses(w: VWallet, transferId: string, label: string): Promise<void> {
  let lastResume = 0;
  await waitFor(
    w,
    async () => {
      if (Date.now() - lastResume >= PACE_MS) {
        lastResume = Date.now();
        await w.facade.resumeNow();
      }
      const local = await createMachineStores(w.kv).backstop.getByKey(transferId);
      return local === undefined && !(await openIntentIds(w)).includes(transferId) && (await w.facade.pendingTransfers()).length === 0;
    },
    SEND_CONVERGE_MS,
    label
  );
}

let walletG: VWallet | undefined;
let walletH: VWallet | undefined;
let tokenG = '';
const gFaults = closeFaults();
const hFaults = closeFaults();
const gWrap = { wrapClient: gFaults.wrapClient, wrapStorage: gFaults.wrapStorage };
const hWrap = { wrapClient: hFaults.wrapClient, wrapStorage: hFaults.wrapStorage };

describe.runIf(RUN)('LIVE staging: #842 SENT history beside the apply (real client, faulted complete / apply)', () => {
  it('complete answers 503 once after a good apply: after resumeNow, exactly one SENT row in the real history', async () => {
    walletG = await makeVerticalWallet('g', gWrap);
    walletH = await makeVerticalWallet('h', hWrap);
    const minted = await mintConverged(walletG, 100n, 'mint G 100', gWrap);
    walletG = minted.wallet;
    tokenG = minted.tokenId;
    const g0 = walletG;
    const h = walletH;
    await waitFor(g0, () => localTotal(g0) === 100n, 60_000, 'G local view shows the 100 mint');

    gFaults.failCompleteOnce();
    const firstEvent = g0.events.length;
    const outcome = await g0.facade
      .send({ recipient: h.identity.chainPubkey, amount: '100', coinId: HARNESS_COIN })
      .then(
        (result) => ({ result }),
        (error: unknown) => ({ error })
      );
    let g = g0;
    let transferId: string;
    if ('result' in outcome) {
      transferId = outcome.result.id;
    } else {
      // Degraded staging can keep the certification open: the SAME transferId converges, wrapped alike.
      if (!isPossiblyCommittedSendOutcome(outcome.error)) throw outcome.error;
      transferId = must((outcome.error as SphereError).transferId, 'keep-open transferId');
    }
    if ('error' in outcome || outcome.result.deliveryPending === true) {
      g = await convergeByReplay(g0, () => paid(h, 100n), SEND_CONVERGE_MS, '#842 complete 503 G→H', gWrap);
      walletG = g;
    }
    await waitFor(g, () => gFaults.fired.includes('complete-503'), 120_000, 'the complete fault fired');
    await settledByPasses(g, transferId, '#842 complete 503: G settles');

    await drainUntil(h, () => localTotal(h) === 100n, 90_000, 'H receives the 100');
    expect(await receivedLegs(h, tokenG)).toHaveLength(1);
    expect(await serverTotal(g)).toBe(0n);
    const rows = await sentRecords(g, transferId);
    expect(rows, 'exactly one SENT row, although the close failed').toHaveLength(1);
    expect(rows[0]).toMatchObject({ transferId, coinId: HARNESS_COIN, amount: '100' });
    expect(failedUpdates(g0, transferId, firstEvent)).toEqual([]);
    expect(failedUpdates(g, transferId, g === g0 ? firstEvent : 0)).toEqual([]);
  }, 3_000_000);

  it("the apply's answer is lost after the server commits: possibly-committed, then exactly one SENT row; the real server dedups a re-POST", async () => {
    const g = must(walletG, 'wallet G');
    const h0 = must(walletH, 'wallet H');
    await waitFor(
      h0,
      () => h0.facade.tokens().some((t) => t.id === tokenG && t.status === 'confirmed'),
      60_000,
      'H holds the 100 spendable'
    );

    hFaults.loseApplyAnswerOnce();
    const firstEvent = h0.events.length;
    const outcome = await h0.facade
      .send({ recipient: g.identity.chainPubkey, amount: '100', coinId: HARNESS_COIN })
      .then(
        (result) => ({ result }),
        (error: unknown) => ({ error })
      );
    expect('error' in outcome, 'a send whose apply answer was lost never resolves').toBe(true);
    const err = (outcome as { error: unknown }).error;
    expect(isPossiblyCommittedSendOutcome(err)).toBe(true);
    const transferId = must((err as SphereError).transferId, 'possibly-committed transferId');
    logStep(`#842 lost apply answer: ${(err as SphereError).code} ${transferId}`);
    let h = h0;
    if (!hFaults.fired.includes('apply-answer-lost')) {
      // Degraded staging kept the certification open first: the resume applies under the SAME transferId.
      h = await convergeByReplay(h0, () => hFaults.fired.includes('apply-answer-lost'), SEND_CONVERGE_MS, '#842 lost apply H→G', hWrap);
      walletH = h;
    }
    await settledByPasses(h, transferId, '#842 lost apply: H settles');

    await drainUntil(g, () => localTotal(g) === 100n, 90_000, 'G receives the 100 back');
    expect(await receivedLegs(g, tokenG)).toHaveLength(1);
    expect(await serverTotal(h)).toBe(0n);
    const rows = await sentRecords(h, transferId);
    expect(rows, 'exactly one SENT row, although the apply answer was lost').toHaveLength(1);
    expect(rows[0]).toMatchObject({ transferId, coinId: HARNESS_COIN, amount: '100' });
    expect(failedUpdates(h0, transferId, firstEvent)).toEqual([]);
    expect(failedUpdates(h, transferId, h === h0 ? firstEvent : 0)).toEqual([]);

    // The facade's SENT record, POSTed again as every re-post is built: a FRESH entry id, the same
    // dedupKey. The server must dedup on the dedupKey, or each pass adds a row for one payment.
    const record = must(hFaults.sent.find((r) => r.dedupKey === transferId), 'the SENT record H posted');
    expect(await h.api.postHistory([{ ...record, id: randomUUID() }])).toEqual({ inserted: 0, deduped: 1 });
    expect(await sentRecords(h, transferId)).toHaveLength(1);
  }, 3_000_000);
});
