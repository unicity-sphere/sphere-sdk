/**
 * tests/harness/support/settle.ts — the waits a LIVE test needs before it may
 * assert or spend.
 *
 * Three views of the same money are eventually consistent, and a live test that
 * reads the wrong one flakes:
 *  - the SERVER balance (`client.getBalances()`) — authoritative for value;
 *  - the LOCAL token map (`module.getTokens()`) — what spend planning reads;
 *  - a token's STATUS — only 'confirmed' can be planned against.
 *
 * `module.sync()` does NOT reconcile any of this: it is a write-only flush
 * (`save()`, `{added:0,removed:0}`). Polling it re-reads the same stale map
 * forever. `receive()` claims what the mailbox holds and `load()` re-reads the
 * server inventory — which is also what prunes the spent PARENT after a
 * self-initiated split.
 *
 * Every wait here has a deadline and then RETURNS rather than throwing (except
 * the explicit lookup), so the caller's own assertion fires on the last real
 * snapshot: a genuine bug surfaces as that assertion failing, never as a wait
 * masking it.
 */

import { HARNESS_COIN } from './stack';
import type { HarnessWallet } from './harness-wallet';
import type { CoinBalance } from '../../../wallet-api';

/** A wallet's held tokens as {id, amount} — genesis-stable ids (`v2_<genesisId>`). */
export type Held = Array<{ id: string; amt: bigint }>;

const POLL_MS = 3_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The harness coin's total in a server balance list. */
export function totalOf(balances: CoinBalance[]): bigint {
  return balances.find((b) => b.coinId === HARNESS_COIN)?.total ?? 0n;
}

/** Value the wallet can PLAN against right now: confirmed tokens only. */
export function spendableOf(w: HarnessWallet): bigint {
  return w.module
    .getTokens()
    .filter((t) => t.status === 'confirmed')
    .reduce((sum, t) => sum + BigInt(t.amount), 0n);
}

/** Pull the LOCAL view back in line with the server, and return what it holds. */
export async function refreshView(w: HarnessWallet): Promise<Held> {
  try {
    await w.module.receive();
  } catch {
    /* mailbox drain is best-effort — load() below still reconciles the inventory */
  }
  await w.module.load();
  return w.module.getTokens().map((t) => ({ id: t.id, amt: BigInt(t.amount) }));
}

/** Poll (draining the mailbox each round) until the SERVER balance reaches `want`. */
export async function waitForBalance(w: HarnessWallet, want: bigint, timeoutMs = 120_000): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await w.module.receive();
    } catch {
      /* mailbox drain is best-effort; keep polling the server balance */
    }
    const last = totalOf(await w.client.getBalances());
    if (last === want || Date.now() >= deadline) return last;
    await sleep(POLL_MS);
  }
}

/** Poll the refreshed view until the wallet holds `want` in SPENDABLE (confirmed) tokens. */
export async function waitForSpendable(w: HarnessWallet, want: bigint, timeoutMs = 90_000): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await refreshView(w);
    const held = spendableOf(w);
    if (held === want || Date.now() >= deadline) return held;
    await sleep(POLL_MS);
  }
}

/** Poll the refreshed view until it settles to `wantTotal` (and `wantDistinct` ids, if given). */
export async function waitForTokens(
  w: HarnessWallet,
  wantTotal: bigint,
  wantDistinct?: number,
  timeoutMs = 90_000,
): Promise<Held> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const held = await refreshView(w);
    const total = held.reduce((s, t) => s + t.amt, 0n);
    const distinct = new Set(held.map((t) => t.id)).size;
    const settled = total === wantTotal && (wantDistinct === undefined || distinct === wantDistinct);
    if (settled || Date.now() >= deadline) return held;
    await sleep(POLL_MS);
  }
}

/**
 * The id of the token holding exactly `amt`, waiting for the view to show it.
 * Reading it from ONE un-reconciled snapshot is what made the staging suites
 * flaky: the server balance was already right while the local map was empty.
 */
export async function waitForTokenOfAmount(w: HarnessWallet, amt: bigint, timeoutMs = 90_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const held = await refreshView(w);
    const hit = held.find((t) => t.amt === amt);
    if (hit) return hit.id;
    if (Date.now() >= deadline) {
      throw new Error(
        `${w.identity.chainPubkey.slice(0, 6)} holds no ${amt}-token (has ${held.map((h) => `${h.id.slice(0, 8)}:${h.amt}`).join(',')})`
      );
    }
    await sleep(POLL_MS);
  }
}

/**
 * Wait until the sender's LOCAL view can cover `amount`, then send.
 *
 * Spend planning reads the local inventory, never the server balance, so a send
 * issued straight after a `waitForBalance` can plan against a view that has not
 * caught up and fail SEND_INSUFFICIENT_BALANCE. If the view never catches up the
 * send still runs, so a genuine planning bug fails the test.
 */
export async function sendWhenSpendable(
  from: HarnessWallet,
  toPubkey: string,
  amount: bigint,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (spendableOf(from) < amount && Date.now() < deadline) {
    await refreshView(from);
    if (spendableOf(from) >= amount) break;
    await sleep(POLL_MS);
  }
  await from.module.send({ recipient: toPubkey, amount: amount.toString(), coinId: HARNESS_COIN });
}
