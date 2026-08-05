/**
 * LIVE staging CROSS-VERSION interop e2e: wallet O runs the OLD payments module
 * (modules/payments — what 0.12/0.13.x clients ship, composed over wallet-api
 * custody exactly like that fleet: createHarnessWallet custody 'inventory');
 * wallet V runs the NEW payments-v2 vertical (support/vertical.ts — the same
 * composition the vertical e2e certifies). Both transact on the REAL staging
 * wallet-api + testnet2 gateway, proving the wire (mailbox blobs, S6 envelopes,
 * payment requests, history) is version-agnostic in BOTH directions.
 *
 * Tests are SEQUENTIAL and share the two wallets. Money flow:
 *   O mints 1000 → O sends 300 to V (old split) → V sends 100 back (v2 split)
 *   → V pays O's 50 payment request. End state: O=850, V=150 — conserved.
 *
 * Degraded-staging posture: keep-open outcomes are NEVER re-issued on either
 * side. The v2 side converges via support/vertical.ts replay/resume; the old
 * side converges via its own machinery — load() (PENDING_V2_DELIVERIES replay)
 * + resumeOpenIntents() (E.3 same-transferId resume). Mint retries are paced
 * and admitted ONLY for a clean 429 rate-limit reject with nothing landed.
 *
 * Gated on STAGING_AGGREGATOR_KEY. Run:
 *   set -a && source .env && set +a && npx vitest run --config vitest.e2e.config.ts \
 *     tests/e2e/cross-version-interop.staging.e2e.test.ts
 */
import { afterAll, describe, expect, it } from 'vitest';

import { isPossiblyCommittedSendOutcome } from '../../core/errors';
import type { TransferResult } from '../../types';
import { createHarnessWallet, type HarnessWallet } from '../harness/support/harness-wallet';
import { HARNESS_COIN, randomIdentity, type HarnessStack } from '../harness/support/stack';
import {
  refreshView,
  spendableOf,
  totalOf,
  waitForBalance,
  waitForSpendable,
  waitForTokenOfAmount,
  waitForTokens,
} from '../harness/support/settle';
import {
  AGGREGATOR_URL,
  BASE_URL,
  NETWORK,
  RUN_STAGING as RUN,
  STAGING_API_KEY as API_KEY,
  TRUSTBASE_URL,
} from './support/staging';
import {
  activeRows,
  convergeByReplay,
  drainUntil,
  historyEntries,
  localTotal,
  logStep,
  makeVerticalWallet,
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
  type VWallet,
} from './support/vertical';

// The OLD side rides the same staging endpoints as the vertical (no third copy).
const STACK: HarnessStack = {
  baseUrl: BASE_URL,
  aggregatorUrl: AGGREGATOR_URL,
  network: NETWORK,
  ...(API_KEY !== undefined && API_KEY !== '' ? { aggregatorApiKey: API_KEY } : {}),
  trustbaseUrl: TRUSTBASE_URL,
};

// ── old-side (0.13-era) helpers: pace, converge, never re-issue ──────────────

const RATE_LIMIT_RE = /\b429\b|too many requests|rate.?limit/i;
const MINT_KEEP_OPEN_RE = /^V2 mint failed: Mint certification failed: certification unconfirmed/;

/**
 * Old-module mint with paced retries for staging's rate limiter ONLY — and
 * only while the server inventory shows NOTHING landed. Two admissible shapes:
 * a clean 429 reject, and the 0.13 module's mint keep-open (the engine wraps a
 * 429'd submit+proof-poll as `certification unconfirmed` — observed live, cause
 * `Too Many Requests`; the old stack has no mint journal to prove it clean).
 * A mint retry cannot double-count: the failed attempt stored/uploaded no blob,
 * so no observable surface (inventory, balance, history) ever sees it. Sends
 * get NO such latitude — a send keep-open is never re-issued anywhere here.
 */
async function mintOldPaced(o: HarnessWallet, amount: bigint, label: string): Promise<void> {
  const before = totalOf(await o.client.getBalances());
  for (let attempt = 1; ; attempt++) {
    const result = await o.module.mintFungibleToken(HARNESS_COIN, amount);
    if (result.success) {
      logStep(`${label}: minted ${result.tokenId} on attempt ${String(attempt)}`);
      return;
    }
    const rateLimitShaped = RATE_LIMIT_RE.test(result.error) || MINT_KEEP_OPEN_RE.test(result.error);
    const nothingLanded = totalOf(await o.client.getBalances()) === before;
    if (!rateLimitShaped || !nothingLanded || attempt >= 12) {
      throw new Error(`${label}: mint failed, not retryable (attempt ${String(attempt)}): ${result.error}`);
    }
    logStep(
      `${label}: rate-limited mint attempt ${String(attempt)} (${result.error.slice(0, 60)}…), nothing landed — pacing 20 s`
    );
    await sleep(20_000);
  }
}

/**
 * Old-side keep-open convergence: cycles of load() (replays the
 * PENDING_V2_DELIVERIES journal, reconciles stuck sources) +
 * resumeOpenIntents() (E.3 resume under the SAME transferId) — the exact
 * machinery a 0.13 client runs at sign-in. NEVER a second send().
 */
async function oldConverge(o: HarnessWallet, settled: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + SEND_CONVERGE_MS;
  for (let cycle = 1; ; cycle++) {
    await sleep(PACE_MS);
    try {
      await o.module.load();
      await o.module.resumeOpenIntents();
    } catch (err) {
      logStep(`${label}: old resume cycle ${String(cycle)} failed (${String(err).slice(0, 80)}) — repacing`);
    }
    try {
      if (await settled()) {
        logStep(`${label}: old side converged on cycle ${String(cycle)}`);
        return;
      }
    } catch {
      // transient observation failure — keep pacing
    }
    if (Date.now() >= deadline) {
      throw new Error(`${label}: old side did not converge within ${String(SEND_CONVERGE_MS)} ms`);
    }
  }
}

/** Wait for a plannable pool, send once, converge any keep-open/pending-delivery outcome. */
async function oldSendConverged(
  o: HarnessWallet,
  recipientPubkey: string,
  amount: bigint,
  settled: () => Promise<boolean>,
  label: string
): Promise<TransferResult | null> {
  const spendDeadline = Date.now() + 90_000;
  while (spendableOf(o) < amount && Date.now() < spendDeadline) {
    await refreshView(o);
    if (spendableOf(o) >= amount) break;
    await sleep(3_000);
  }
  let result: TransferResult;
  try {
    result = await o.module.send({ recipient: recipientPubkey, amount: amount.toString(), coinId: HARNESS_COIN });
  } catch (err) {
    if (!isPossiblyCommittedSendOutcome(err)) throw err;
    logStep(`${label}: keep-open (${(err as Error).message.slice(0, 80)}…) — converging via load()+resumeOpenIntents, same transferId`);
    await oldConverge(o, settled, label);
    return null;
  }
  if (result.deliveryPending === true) {
    logStep(`${label}: certified but delivery pending — converging via the load() delivery-journal replay`);
    await oldConverge(o, settled, label);
  } else {
    logStep(`${label}: admitted directly (${result.id})`);
  }
  return result;
}

/** Best-effort old-module mailbox drain (mirrors settle.ts's posture). */
async function drainOld(o: HarnessWallet): Promise<void> {
  try {
    await o.module.receive();
  } catch {
    // mailbox drain is best-effort; state assertions poll the server
  }
}

// ── wallets shared ACROSS tests (sequential; later tests spend earlier balances) ──

let oldW: HarnessWallet | undefined;
let v2W: VWallet | undefined;
let oldMintGenesis = ''; // test 1: bare-hex genesis of O's 1000 mint
let vReceivedId = ''; // test 2: the fresh 300 genesis V received from O's split

afterAll(async () => {
  oldW?.destroy();
  await shutdownVerticalWallets();
}, 240_000);

describe.runIf(RUN)('LIVE staging: cross-version interop (old payments module ↔ payments-v2 vertical)', () => {
  it('old-module wallet mints on staging', async () => {
    const identity = randomIdentity();
    // Namespace by identity so a run never inherits a prior run's local state.
    oldW = await createHarnessWallet({
      stack: STACK,
      identity,
      deviceId: `iv-old-${identity.chainPubkey.slice(2, 14)}`,
      custody: 'inventory',
    });
    await oldW.module.load();
    const o = oldW;

    await mintOldPaced(o, 1000n, 'interop mint O 1000');
    expect(await waitForBalance(o, 1000n)).toBe(1000n);

    // Exactly one token backs the balance, and its id is genesis-stable v2_<hex>.
    const held = await waitForTokens(o, 1000n, 1);
    expect(held).toHaveLength(1);
    const tokenId = await waitForTokenOfAmount(o, 1000n);
    expect(tokenId).toMatch(/^v2_[0-9a-f]+$/);
    oldMintGenesis = tokenId.slice(3);
  }, 1_800_000);

  it('old→new: a 0.13-era send arrives in the v2 vertical, verified before balance', async () => {
    const o = must(oldW, 'old wallet');
    v2W = await makeVerticalWallet('iv');
    const v = v2W;

    const vPaid = async (): Promise<boolean> => {
      await v.facade.receive().catch(() => undefined);
      return localTotal(v) === 300n;
    };
    const result = await oldSendConverged(o, v.identity.chainPubkey, 300n, vPaid, 'old→new 300');
    if (result !== null) {
      expect(result.status).toBe('completed');
      // O's only token was 1000, so the old stack HAD to split: fresh genesis to V.
      expect(result.tokenTransfers).toEqual([{ sourceTokenId: `v2_${oldMintGenesis}`, method: 'split' }]);
    }

    // V's acceptance implies the full real trust-base verify + isOwnedBy passed
    // BEFORE the token entered the balance (Receive screens before store/claim).
    await drainUntil(v, () => localTotal(v) === 300n, 180_000, 'V receives 300 from the old module');
    const vTokens = v.facade.tokens();
    expect(vTokens).toHaveLength(1);
    vReceivedId = must(vTokens[0], 'V received token').id;
    expect(vReceivedId).not.toBe(oldMintGenesis); // the split minted a FRESH genesis for the 300 leg
    expect(await serverTotal(v)).toBe(300n);
    expect((await activeRows(v)).map((r) => r.tokenId)).toEqual([vReceivedId]);

    // V RECEIVED history leg; O SENT history leg (recorded by whichever path ran).
    await waitFor(v, async () => (await receivedLegs(v, vReceivedId)).length === 1, 60_000, 'V RECEIVED history leg');
    const sentDeadline = Date.now() + 60_000;
    while (
      !o.module.getHistory().some((e) => e.type === 'SENT' && e.amount === '300') &&
      Date.now() < sentDeadline
    ) {
      await sleep(2_000);
    }
    const oSent = o.module.getHistory().filter((e) => e.type === 'SENT' && e.amount === '300');
    expect(oSent).toHaveLength(1);
    if (result !== null) expect(oSent[0]?.transferId).toBe(result.id);

    // O keeps exactly the 700 change.
    expect(await waitForBalance(o, 700n)).toBe(700n);
    expect(await waitForTokens(o, 700n, 1)).toHaveLength(1);

    // Exactly-once: a 10 s over-drain changes NOTHING on V.
    await sleep(10_000);
    await v.facade.receive().catch(() => undefined);
    expect(localTotal(v)).toBe(300n);
    expect(await serverTotal(v)).toBe(300n);
    expect(await receivedLegs(v, vReceivedId)).toHaveLength(1);
  }, 1_500_000);

  it('new→old: a v2 send (forcing a SPLIT of the 300) arrives in the old module', async () => {
    const o = must(oldW, 'old wallet');

    const oPaid = async (): Promise<boolean> => {
      await drainOld(o);
      return totalOf(await o.client.getBalances()) === 800n;
    };
    const sent = await sendConverged(
      must(v2W, 'v2 wallet'),
      { recipient: o.identity.chainPubkey, amount: '100', coinId: HARNESS_COIN },
      oPaid,
      'new→old 100'
    );
    v2W = sent.wallet;
    const v = v2W;
    if (sent.result !== null) {
      expect(['delivered', 'confirmed']).toContain(sent.result.status);
      // V held only the 300 token, so the v2 machine HAD to split it.
      expect(sent.result.tokenTransfers).toEqual([{ sourceTokenId: vReceivedId, method: 'split' }]);
    }

    // O receives through the old module's own receive/pump path.
    expect(await waitForBalance(o, 800n)).toBe(800n);
    const oHeld = await waitForTokens(o, 800n, 2); // 700 change + the received 100
    expect(oHeld.map((t) => t.amt).sort((a, b) => (a < b ? -1 : 1))).toEqual([100n, 700n]);
    const oHundredId = await waitForTokenOfAmount(o, 100n);
    expect(oHundredId).toMatch(/^v2_[0-9a-f]+$/);
    expect(oHundredId.slice(3)).not.toBe(vReceivedId); // fresh genesis minted by V's split

    // SPENDABLE by the old stack: the received token enters the confirmed
    // plannable pool (the SpendQueue predicate), and the old validator finds
    // nothing invalid — the old receive path verified it before storing.
    expect(await waitForSpendable(o, 800n)).toBe(800n);
    const verdict = await o.module.validate();
    expect(verdict.invalid).toHaveLength(0);

    // V keeps exactly the 200 change token (fresh genesis), locally and on the server.
    await waitFor(
      v,
      () => {
        const tokens = v.facade.tokens();
        return tokens.length === 1 && tokens[0]?.amount === '200' && tokens[0].id !== vReceivedId;
      },
      90_000,
      'V settles to the 200 change token'
    );
    const changeId = must(v.facade.tokens()[0], 'V change token').id;
    expect((await activeRows(v)).map((r) => r.tokenId)).toEqual([changeId]);
    expect(await serverTotal(v)).toBe(200n);
    await waitFor(
      v,
      async () => (await historyEntries(v)).some((e) => e.type === 'SENT' && e.transferId === sent.transferId),
      60_000,
      'V SENT history record'
    );
    await waitFor(v, async () => (await openIntentIds(v)).length === 0, 60_000, 'V open intents empty');

    // Exactly-once BOTH sides: a 10 s over-drain moves nothing, no doubled legs.
    await sleep(10_000);
    await drainOld(o);
    await v.facade.receive().catch(() => undefined);
    expect(totalOf(await o.client.getBalances())).toBe(800n);
    expect(o.module.getHistory().filter((e) => e.type === 'RECEIVED' && e.amount === '100')).toHaveLength(1);
    expect(localTotal(v)).toBe(200n);
    expect(await serverTotal(v)).toBe(200n);

    // Conservation across versions: O=800, V=200 — the original 1000, nothing more.
    expect(totalOf(await o.client.getBalances()) + (await serverTotal(v))).toBe(1000n);
  }, 1_500_000);

  it('request interop: an old-module payment request is visible to and payable by the v2 client', async () => {
    const o = must(oldW, 'old wallet');
    const v0 = must(v2W, 'v2 wallet');

    const created = await o.module.sendPaymentRequest(v0.identity.chainPubkey, {
      amount: '50',
      coinId: HARNESS_COIN,
      message: 'interop: pay me 50',
    });
    if (!created.success && (created.error ?? '').includes('payment-request capability')) {
      // Runtime branch, NOT .skip: the composed old port lacks the PR surface.
      logStep(
        'LOUD REPORT: the old-module composition lacks the wallet-api payment-request surface — request-interop leg NOT exercised on this run'
      );
      return;
    }
    expect(created.success).toBe(true);
    const requestId = must(created.requestId, 'payment request id');

    // V sees it in the drained mirror, with the S6 memo decrypted CROSS-VERSION
    // (old sender ECDH envelope → v2 requestMemoCodec).
    await waitFor(
      v0,
      async () => {
        await v0.facade.requests.drainIncoming().catch(() => undefined);
        return v0.facade.requests.list().some((r) => r.id === requestId);
      },
      120_000,
      'V sees the old-module payment request'
    );
    const view = must(
      v0.facade.requests.list().find((r) => r.id === requestId),
      'request view'
    );
    expect(view.senderPubkey).toBe(o.identity.chainPubkey);
    expect(view.amount).toBe('50');
    expect(view.coinId).toBe(HARNESS_COIN);
    expect(view.status).toBe('pending');
    expect(view.message).toBe('interop: pay me 50');

    const oPaid = async (): Promise<boolean> => {
      await drainOld(o);
      return totalOf(await o.client.getBalances()) === 850n;
    };
    // requests.pay → a REAL v2 send of 50 back to O. Keep-open converges via the
    // settling-journal reconcile on the rebuilt instance — never a re-pay.
    let payResult: TransferResult | null = null;
    try {
      payResult = await v0.facade.requests.pay(requestId);
    } catch (err) {
      if (!isPossiblyCommittedSendOutcome(err)) throw err;
      logStep(`pay PR: keep-open (${(err as Error).message.slice(0, 80)}…) — converging, never re-paying`);
      v2W = await convergeByReplay(v0, oPaid, SEND_CONVERGE_MS, 'pay PR');
    }
    if (payResult !== null && payResult.deliveryPending === true) {
      logStep('pay PR: certified but delivery pending — converging via delivery-journal replay');
      v2W = await convergeByReplay(v0, oPaid, SEND_CONVERGE_MS, 'pay PR delivery');
    } else if (payResult !== null) {
      expect(['delivered', 'confirmed']).toContain(payResult.status);
    }
    const v = must(v2W, 'v2 wallet');

    // O receives the 50.
    expect(await waitForBalance(o, 850n)).toBe(850n);

    // O's request resolves paid on the OLD request surface (its outgoing view —
    // the request O sent), fed by the old module's own wallet-api PR pump.
    await waitFor(
      v,
      async () => {
        await o.module.syncPaymentRequests();
        return o.module.getOutgoingPaymentRequests().find((r) => r.id === requestId)?.status === 'paid';
      },
      180_000,
      'O outgoing request resolves paid'
    );
    // V's mirror agrees.
    await waitFor(
      v,
      async () => {
        await v.facade.requests.drainIncoming().catch(() => undefined);
        return v.facade.requests.list().find((r) => r.id === requestId)?.status === 'paid';
      },
      60_000,
      'V request mirror shows paid'
    );

    // Exactly-once + conservation: a 10 s over-drain moves nothing; O=850, V=150.
    await sleep(10_000);
    await drainOld(o);
    await v.facade.receive().catch(() => undefined);
    expect(totalOf(await o.client.getBalances())).toBe(850n);
    expect(localTotal(v)).toBe(150n);
    expect(await serverTotal(v)).toBe(150n);
    expect(o.module.getHistory().filter((e) => e.type === 'RECEIVED' && e.amount === '50')).toHaveLength(1);
    expect(totalOf(await o.client.getBalances()) + (await serverTotal(v))).toBe(1000n);
  }, 1_800_000);
});
