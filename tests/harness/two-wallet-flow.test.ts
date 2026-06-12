/**
 * Phase-2 harness — full two-wallet flows over the REAL backend
 * (development-workflow.md phase 2; the systematic fake-drift detector).
 *
 * Two complete S4 wallet compositions (real WalletApiClient, real engine over
 * the stack's LOCAL mock aggregator via the SDK's real JSON-RPC wire client)
 * drive the real wallet-api backend over real HTTP:
 *
 * - A mints (open minting, LOCAL) → the §5.2 presigned upload + §5.3 apply put
 *   the token in A's SERVER inventory (backend-validated, §8.2);
 * - A sends to B: intent (E.3) → engine → mailbox deposit → apply → complete;
 *   B discovers via mailbox poll, claims into inventory (§6 handoff);
 * - balances and history converge on BOTH sides through the real backend;
 * - a split send conserves value (change back to A) on both sides;
 * - a payment request round-trips create→pay→respond('paid') with the linking
 *   transferId (§10/§16).
 *
 * Determinism note: the REAL backend pushes §9 wakes over a live WS, so a
 * wallet composed BEFORE a deposit may claim it in the background. Where a
 * test wants `receive()` to be the discovery, the recipient wallet is created
 * AFTER the send; where the recipient must exist earlier (payment requests),
 * assertions fence on CONVERGED state (tokens/balances/entries), never on
 * who-pumped-first.
 *
 * Local-only: needs Docker + the sibling wallet-api checkout (the global
 * setup boots docker-compose.dev.yml). See development-workflow.md.
 */

import { describe, it, expect, afterEach } from 'vitest';

import { createHarnessWallet, type HarnessWallet } from './support/harness-wallet';
import { HARNESS_COIN, randomIdentity, stackFromEnv } from './support/stack';
import type { CoinBalance } from '../../wallet-api';

const stack = stackFromEnv();

const wallets: HarnessWallet[] = [];
afterEach(() => {
  while (wallets.length) wallets.pop()?.destroy();
});

async function newWallet(deviceId: string, identity = randomIdentity()): Promise<HarnessWallet> {
  const wallet = await createHarnessWallet({ stack, identity, deviceId, custody: 'inventory' });
  wallets.push(wallet);
  await wallet.module.load();
  return wallet;
}

function totalOf(balances: CoinBalance[], coinId = HARNESS_COIN): bigint {
  return balances.find((b) => b.coinId === coinId)?.total ?? 0n;
}

describe('two-wallet send/receive over the real backend', () => {
  it('mint → send → mailbox poll → claim: balances and history converge on both sides', async () => {
    const a = await newWallet('flow-a');
    const bIdentity = randomIdentity();

    // Open mint (LOCAL) through the real engine; the full preset pushes it
    // into A's SERVER inventory (presigned PUT + apply, validated §8.2).
    const mint = await a.module.mintFungibleToken(HARNESS_COIN, 1000n);
    expect(mint.success).toBe(true);
    expect(totalOf(await a.client.getBalances())).toBe(1000n);

    const result = await a.module.send({
      recipient: bIdentity.chainPubkey,
      amount: '1000',
      coinId: HARNESS_COIN,
      memo: 'harness flow',
    });
    expect(result.status).toBe('completed');

    // B comes online AFTER the deposit (so this explicit poll IS the
    // discovery — no wake raced it) and claims into inventory (§6 handoff).
    const b = await newWallet('flow-b', bIdentity);
    const { transfers } = await b.module.receive();
    expect(transfers).toHaveLength(1);
    expect(transfers[0].tokens[0]).toMatchObject({ amount: '1000', coinId: HARNESS_COIN, status: 'confirmed' });

    // Balance convergence on BOTH sides — through the real backend.
    expect(totalOf(await a.client.getBalances())).toBe(0n);
    expect(totalOf(await b.client.getBalances())).toBe(1000n);
    expect(a.module.getTokens()).toHaveLength(0);
    expect(b.module.getTokens()[0]).toMatchObject({ amount: '1000', status: 'confirmed' });

    // The mailbox entry resolved under the send's transferId, exactly once.
    const mailbox = await b.client.listMailbox();
    const entries = mailbox.entries.filter((e) => e.transferId === result.id);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('claimed');

    // §10 history rows exist SERVER-side for both parties, dedupKey'd.
    const aHistory = await a.client.listHistory();
    expect(aHistory.records.filter((r) => r.dedupKey === `SENT_transfer_${result.id}`)).toHaveLength(1);
    const bHistory = await b.client.listHistory();
    expect(bHistory.records.some((r) => r.dedupKey.startsWith('RECEIVED_'))).toBe(true);

    // And the recipient surfaced it as an incoming transfer event.
    expect(b.events.some((e) => e.type === 'transfer:incoming')).toBe(true);
  });

  it('a split send conserves value: 300 to B, 700 change back to A, both sides converge', async () => {
    const a = await newWallet('split-a');
    const bIdentity = randomIdentity();
    expect((await a.module.mintFungibleToken(HARNESS_COIN, 1000n)).success).toBe(true);

    const result = await a.module.send({ recipient: bIdentity.chainPubkey, amount: '300', coinId: HARNESS_COIN });
    expect(result.status).toBe('completed');

    // Server truth: A keeps exactly the 700 remainder as ONE active row.
    const aBalances = await a.client.getBalances();
    expect(aBalances).toEqual([{ coinId: HARNESS_COIN, total: 700n, tokenCount: 1 }]);

    // Locally the change output is a full (non-lazy) confirmed record.
    const change = a.module.getTokens().find((t) => t.amount === '700');
    expect(change?.status).toBe('confirmed');
    expect(change?.sdkData).toBeDefined();

    const b = await newWallet('split-b', bIdentity);
    const { transfers } = await b.module.receive();
    expect(transfers).toHaveLength(1);
    expect(transfers[0].tokens[0].amount).toBe('300');
    expect(totalOf(await b.client.getBalances())).toBe(300n);

    // Value conserved across the whole system.
    expect(totalOf(await a.client.getBalances()) + totalOf(await b.client.getBalances())).toBe(1000n);
  });
});

describe('payment requests over the real backend (§10/§16)', () => {
  it("create → pay → respond('paid') round-trips with the linking transferId", async () => {
    const requester = await newWallet('pr-requester');
    const payer = await newWallet('pr-payer');
    expect((await payer.module.mintFungibleToken(HARNESS_COIN, 1000n)).success).toBe(true);

    // Requester creates the request via the wallet-api S4 capability.
    const created = await requester.module.sendPaymentRequest(payer.identity.chainPubkey, {
      amount: '400',
      coinId: HARNESS_COIN,
      message: 'harness invoice',
    });
    expect(created.success).toBe(true);
    const requestId = created.requestId;
    expect(requestId).toBeDefined();

    // Payer drains the gap-free incoming stream and sees it.
    await payer.module.syncPaymentRequests();
    const incoming = payer.module.getPaymentRequests();
    expect(incoming.some((r) => r.id === requestId && r.amount === '400')).toBe(true);

    // Pay: send + respond('paid', transferId) — the §16 linkage.
    const payResult = await payer.module.payPaymentRequest(requestId as string);
    expect(payResult.status).toBe('completed');

    // Server truth for the requester: status 'paid' linked to the SEND.
    const outgoing = await requester.client.listPaymentRequests({ role: 'outgoing' });
    const record = outgoing.requests.find((r) => r.id === requestId);
    expect(record).toBeDefined();
    expect(record).toMatchObject({ status: 'paid', transferId: payResult.id });

    // The funds arrive through the real rails. The requester existed before
    // the deposit, so a §9 wake may already have claimed it in the
    // background — receive() coalesces with any in-flight pump; assert the
    // CONVERGED state, not who pumped first.
    await requester.module.receive();
    expect(requester.module.getTokens().filter((t) => t.amount === '400' && t.status === 'confirmed')).toHaveLength(1);
    expect(totalOf(await requester.client.getBalances())).toBe(400n);
    expect(totalOf(await payer.client.getBalances())).toBe(600n);
  });
});
