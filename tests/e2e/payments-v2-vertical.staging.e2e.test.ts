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
 * Gated on STAGING_AGGREGATOR_KEY. Run:
 *   set -a && source .env && set +a && npx vitest run --config vitest.e2e.config.ts \
 *     tests/e2e/payments-v2-vertical.staging.e2e.test.ts
 */
import { afterAll, describe, expect, it } from 'vitest';

import { isPossiblyCommittedSendOutcome } from '../../core/errors';
import type { DeliveryPort } from '../../modules/payments-v2/ports';
import { createMachineStores } from '../../modules/payments-v2/machine/journal';
import type { TransferResult } from '../../types';
import { HARNESS_COIN, randomIdentity } from './support/staging';
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
  receivedLegs,
  SEND_CONVERGE_MS,
  sendConverged,
  serverTotal,
  shutdownVerticalWallets,
  sleep,
  waitFor,
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
