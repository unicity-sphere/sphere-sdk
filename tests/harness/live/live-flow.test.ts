/**
 * S5 live e2e (sdk-changes S5) — two REAL SDK wallets send/receive **including
 * a split** via wallet-api on testnet2: the phase-2 harness composition with
 * the REAL aggregator gateway (API key from the wallet-api `.env`, never
 * logged) and the backend booted with the REAL pinned testnet2 roots
 * (docker-compose.live.yml). Every certification and inclusion proof in this
 * file is real; every §8.2 validation runs under the real committee.
 *
 * LOCAL-ONLY (`npm run test:e2e:live`): needs Docker, the sibling wallet-api
 * checkout and network egress; excluded from CI globs. §18 triage rule: infra
 * failures block/retry — they never license code changes or test weakening.
 *
 * Determinism note (same as the mock harness): the live backend pushes §9
 * wakes over WS, so a wallet composed BEFORE a deposit may claim it in the
 * background. Recipients are created AFTER the send where receive() must BE
 * the discovery; pre-existing wallets fence on CONVERGED state only.
 */

import { describe, it, expect, afterEach } from 'vitest';

import { createHarnessWallet, type HarnessWallet } from '../support/harness-wallet';
import { HARNESS_COIN, randomIdentity } from '../support/stack';
import { liveStackFromEnv } from './support/live-stack';
import type { CoinBalance } from '../../../wallet-api';

const stack = liveStackFromEnv();

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

describe('S5 — two wallets send/receive (incl. a split) over the REAL testnet2 aggregator', () => {
  it('real mint → SPLIT send → claim → whole-token send back: both directions converge, value conserved', async () => {
    const a = await newWallet('live-flow-a');
    const bIdentity = randomIdentity();

    // REAL open mint on testnet2 (small amount — testnet posture): the full
    // preset pushes it into A's SERVER inventory (§5.2 upload + §5.3 apply,
    // backend-validated under the REAL trustbase).
    const mint = await a.module.mintFungibleToken(HARNESS_COIN, 1000n);
    expect(mint.success).toBe(true);
    expect(totalOf(await a.client.getBalances())).toBe(1000n);

    // SPLIT send through the real gateway: burn + split-mints certified with
    // real inclusion proofs; 300 to B, 700 change back to A (E.1 deterministic
    // realization; intent persisted server-side per E.3 before the engine ran).
    const sent = await a.module.send({
      recipient: bIdentity.chainPubkey,
      amount: '300',
      coinId: HARNESS_COIN,
      memo: 'live s5 split',
    });
    expect(sent.status).toBe('completed');

    // Server truth: A keeps exactly the 700 change as ONE active row; the
    // backend accepted the split-mint change blob under the real committee.
    expect(await a.client.getBalances()).toEqual([{ coinId: HARNESS_COIN, total: 700n, tokenCount: 1 }]);
    const change = a.module.getTokens().find((t) => t.amount === '700');
    expect(change?.status).toBe('confirmed');

    // B comes online AFTER the deposit (this poll IS the discovery), verifies
    // the real proof chain locally (engine.verify under the real trustbase)
    // and claims into inventory (§6 handoff).
    const b = await newWallet('live-flow-b', bIdentity);
    const { transfers } = await b.module.receive();
    expect(transfers).toHaveLength(1);
    expect(transfers[0].tokens[0]).toMatchObject({ amount: '300', coinId: HARNESS_COIN, status: 'confirmed' });
    expect(totalOf(await b.client.getBalances())).toBe(300n);

    // Reverse direction: B sends the 300 back WHOLE-TOKEN (no split). A
    // existed before the deposit, so fence on CONVERGED state after receive().
    const back = await b.module.send({ recipient: a.identity.chainPubkey, amount: '300', coinId: HARNESS_COIN });
    expect(back.status).toBe('completed');
    await a.module.receive();
    expect(totalOf(await a.client.getBalances())).toBe(1000n);
    expect(totalOf(await b.client.getBalances())).toBe(0n);

    // Value conserved across the whole system after two real sends.
    expect(totalOf(await a.client.getBalances()) + totalOf(await b.client.getBalances())).toBe(1000n);

    // §10 history rows landed server-side for both directions, dedupKey'd.
    const aHistory = await a.client.listHistory();
    expect(aHistory.records.filter((r) => r.dedupKey === `SENT_transfer_${sent.id}`)).toHaveLength(1);
    expect(aHistory.records.some((r) => r.dedupKey.startsWith('RECEIVED_'))).toBe(true);
    const bHistory = await b.client.listHistory();
    expect(bHistory.records.filter((r) => r.dedupKey === `SENT_transfer_${back.id}`)).toHaveLength(1);
    expect(bHistory.records.some((r) => r.dedupKey.startsWith('RECEIVED_'))).toBe(true);

    // Both sends closed their intents (E.3 uniform close) — nothing re-resumes.
    expect(await a.client.listIntents('open')).toHaveLength(0);
    expect(await b.client.listIntents('open')).toHaveLength(0);
  });
});
