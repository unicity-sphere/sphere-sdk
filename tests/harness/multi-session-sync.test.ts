/**
 * Phase-2 harness — TWO SESSIONS of the SAME custodial owner converge in
 * realtime over the REAL backend + the REAL wake WebSocket (sphere-sdk#523 G4).
 *
 * The capstone for the 6-step cross-session-sync fix: the backend wakes both
 * parties + re-stamps payment-request seq (upsert-by-id), and the SDK consumes
 * all three wake streams (inventory/mailbox/payment_requests), polls inventory
 * as a backstop, upserts payment-request status + emits resolution events, and
 * self-heals its wake socket with a reconnect supervisor + catch-up pump.
 * Unit tests (in-process fake) and wallet-api integration tests already cover
 * the pieces; THIS proves the whole loop with two REAL SDK compositions of one
 * owner against the REAL stack — the missing cross-repo coverage.
 *
 * Two sessions = ONE identity, two `deviceId`s, two independent
 * modules/stateStores (exactly the "two browser windows of the same wallet"
 * the bug reports describe). They share the server's inventory + payment-request
 * streams; each gets its own wake socket.
 *
 * The properties under test (every assertion is CONVERGED state, never a
 * call-count or a tautology — each would FAIL if convergence didn't happen):
 *
 *  1. Inventory converges from the WAKE alone. Session A lands a token in the
 *     owner's server inventory (mint); session B converges its balance +
 *     getTokens() with NO manual sync call, well under the 30 s poll backstop —
 *     so the wake, not the poll, did it.
 *  2. Payment-request resolution converges. A third-party requester creates a
 *     request to the owner; BOTH sessions surface it `pending`; session A pays
 *     it; session B drops it from the actionable view (status → `paid`) via the
 *     wake + the §16 seq re-stamp upsert, again with no manual sync, and fires
 *     `payment_request:paid`.
 *  3. Dead-socket recovery. Session B's wake socket is force-closed; while it is
 *     dark, session A lands another token; B's supervisor reconnects and the
 *     catch-up pump converges the new token.
 *
 * Determinism: the backstop poll is 30 s (DELIVERY_POLL_INTERVAL_MS) and the
 * inventory-wake debounce 500 ms, so a CONVERGENCE_BUDGET_MS well under 30 s
 * proves the wake/catch-up path — a poll could not have fired yet. `B` is
 * always composed BEFORE the change it must converge to (the whole point: a
 * pre-existing second window), so convergence can only come from realtime, not
 * a fresh load().
 *
 * Local-only: needs Docker + the sibling wallet-api checkout (the global setup
 * boots docker-compose.dev.yml). See development-workflow.md.
 */

import { describe, it, expect, afterEach } from 'vitest';

import { createHarnessWallet, type HarnessWallet } from './support/harness-wallet';
import { HARNESS_COIN, randomIdentity, stackFromEnv } from './support/stack';
import type { CoinBalance, WebSocketLike } from '../../wallet-api';

const stack = stackFromEnv();

/** Convergence must beat the 30 s poll backstop with margin — so it's the WAKE. */
const CONVERGENCE_BUDGET_MS = 12_000;

const wallets: HarnessWallet[] = [];
afterEach(() => {
  while (wallets.length) wallets.pop()?.destroy();
});

function totalOf(balances: CoinBalance[], coinId = HARNESS_COIN): bigint {
  return balances.find((b) => b.coinId === coinId)?.total ?? 0n;
}

/** A live session of `identity`: own deviceId, own module/stateStore. */
async function newSession(
  deviceId: string,
  identity: { privateKey: string; chainPubkey: string },
  webSocketFactory?: (url: string) => WebSocketLike
): Promise<HarnessWallet> {
  const wallet = await createHarnessWallet({
    stack,
    identity,
    deviceId,
    custody: 'inventory',
    ...(webSocketFactory ? { webSocketFactory } : {}),
  });
  wallets.push(wallet);
  await wallet.module.load();
  return wallet;
}

/**
 * Poll `predicate()` until it returns truthy or the budget elapses. Throws on
 * timeout so the failing assertion's `expect` runs against the LAST observed
 * value — i.e. the test fails iff convergence did not happen in time. There is
 * NO manual module.sync()/receive() here: convergence is the wake's job.
 */
async function waitFor<T>(predicate: () => T | undefined, budgetMs = CONVERGENCE_BUDGET_MS): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`convergence not reached within ${budgetMs}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('two sessions of the same owner converge over the real wake socket (#523 G4)', () => {
  it('inventory: session B converges a token landed by session A from the wake alone', async () => {
    const owner = randomIdentity();
    // BOTH sessions exist BEFORE the change — two open browser windows.
    const a = await newSession('owner-dev-a', owner);
    const b = await newSession('owner-dev-b', owner);

    // Sanity: both start empty (shared server inventory, two fresh sessions).
    expect(totalOf(await a.client.getBalances())).toBe(0n);
    expect(totalOf(await b.client.getBalances())).toBe(0n);
    expect(b.module.getTokens()).toHaveLength(0);

    // Session A mints — the token lands in the owner's SERVER inventory
    // (presigned PUT + apply, §8.2) and the backend wakes the owner's sockets.
    expect((await a.module.mintFungibleToken(HARNESS_COIN, 1000n)).success).toBe(true);

    // Session B converges with NO manual sync — wake → debounced inventory
    // resync → load(). Within the budget (≪ 30 s poll), so it's the wake.
    const converged = await waitFor(() => {
      const token = b.module.getTokens().find((t) => t.amount === '1000');
      return token?.status === 'confirmed' ? token : undefined;
    });
    expect(converged).toMatchObject({ amount: '1000', status: 'confirmed' });

    // Real server-side balance convergence on the pre-existing session B.
    expect(totalOf(await b.client.getBalances())).toBe(1000n);
    // And session B emitted the realtime inventory-update event (custodial path).
    expect(b.events.some((e) => e.type === 'sync:remote-update')).toBe(true);
  });

  it('payment requests: session A pays, session B drops it from the actionable view via the wake', async () => {
    const owner = randomIdentity();
    const requester = await newSession('pr-requester', randomIdentity());
    const a = await newSession('owner-pr-a', owner);
    const b = await newSession('owner-pr-b', owner);

    // Fund session A so it can actually pay (mint converges on B too, but the
    // PR is the property under test here).
    expect((await a.module.mintFungibleToken(HARNESS_COIN, 1000n)).success).toBe(true);

    // The third party creates a §16 payment request to the owner.
    const created = await requester.module.sendPaymentRequest(owner.chainPubkey, {
      amount: '400',
      coinId: HARNESS_COIN,
      message: 'multi-session invoice',
    });
    expect(created.success).toBe(true);
    const requestId = created.requestId as string;
    expect(requestId).toBeDefined();

    // BOTH sessions surface it as actionable `pending` from the wake alone.
    await waitFor(() => a.module.getPaymentRequests().find((r) => r.id === requestId && r.status === 'pending'));
    await waitFor(() => b.module.getPaymentRequests().find((r) => r.id === requestId && r.status === 'pending'));

    // Session A pays it (send + respond('paid', transferId) — the §16 linkage).
    const payResult = await a.module.payPaymentRequest(requestId);
    expect(payResult.status).toBe('completed');

    // Session B — with NO manual sync — advances the request to its terminal
    // server state via the payment_requests wake + the §16 seq re-stamp upsert,
    // dropping it from the actionable (pending) view.
    const resolved = await waitFor(() =>
      b.module.getPaymentRequests().find((r) => r.id === requestId && r.status === 'paid')
    );
    expect(resolved?.status).toBe('paid');
    expect(b.module.getPaymentRequests({ status: 'pending' }).some((r) => r.id === requestId)).toBe(false);

    // Session B fired the resolution event so the UI can drop the action card.
    await waitFor(() =>
      b.events.find((e) => e.type === 'payment_request:paid' && (e.data as { id?: string }).id === requestId)
    );

    // Server truth for the requester: the request is paid, linked to A's send.
    const outgoing = await requester.client.listPaymentRequests({ role: 'outgoing' });
    expect(outgoing.requests.find((r) => r.id === requestId)).toMatchObject({
      status: 'paid',
      transferId: payResult.id,
    });
  });

  it('dead-socket recovery: session B reconnects and catches up a change made while dark', async () => {
    const owner = randomIdentity();
    const a = await newSession('owner-dark-a', owner);

    // Session B records its live wake socket so the test can force-close it.
    const sockets: WebSocketLike[] = [];
    const recordingFactory = (url: string): WebSocketLike => {
      const Ctor = (globalThis as { WebSocket: new (u: string) => WebSocketLike }).WebSocket;
      const ws = new Ctor(url);
      sockets.push(ws);
      return ws;
    };
    const b = await newSession('owner-dark-b', owner, recordingFactory);

    // First convergence proves the socket is live (a token over the happy path).
    expect((await a.module.mintFungibleToken(HARNESS_COIN, 100n)).success).toBe(true);
    await waitFor(() => b.module.getTokens().find((t) => t.amount === '100' && t.status === 'confirmed'));
    expect(sockets.length).toBeGreaterThan(0);

    // Go dark: force-close B's live wake socket. The supervisor keeps
    // onclose/onerror live, so this triggers a backed-off reconnect — NOT a
    // silent death. (Closing it is exactly what a proxy/idle/tab-suspend does.)
    sockets[sockets.length - 1].close();

    // While B is dark, session A lands another token. B's poll backstop is 30 s
    // away; only a reconnect + catch-up pump can converge this within budget.
    expect((await a.module.mintFungibleToken(HARNESS_COIN, 250n)).success).toBe(true);

    // B reconnects (a NEW socket is opened) and the catch-up pump converges the
    // token landed during the dark window — well under the 30 s poll.
    const recovered = await waitFor(() =>
      b.module.getTokens().find((t) => t.amount === '250' && t.status === 'confirmed')
    );
    expect(recovered).toMatchObject({ amount: '250', status: 'confirmed' });
    // The supervisor opened a fresh socket to heal — the drop did not end realtime.
    expect(sockets.length).toBeGreaterThan(1);

    // Total balance converged on the pre-existing dark session: 100 + 250.
    expect(totalOf(await b.client.getBalances())).toBe(350n);
  });
});
