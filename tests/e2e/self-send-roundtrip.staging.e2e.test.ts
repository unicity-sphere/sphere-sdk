/**
 * LIVE money-loss repro — self-send + A→B→A round-trip over the REAL staging
 * wallet-api and the REAL testnet2 aggregator, with REAL (testnet) transactions.
 *
 * This is the only test that can validate the fix end-to-end: the fakes return
 * certificationData AND inclusionCertificate together (like today's aggregator),
 * so no fake can exercise the ExclusionCert / isSpent discriminator, and no fake
 * reproduces the real mailbox/inventory timing. Here the token is minted, sent,
 * claimed, and sent BACK across two real wallets, and we assert value is conserved.
 *
 * Verified 2026-07-19: on `main` the whole-token SELF-send LOSES 100% (server
 * balance stays 0), and this test conserves it on the fix branch — same test,
 * real staging + testnet2. (The A→B→A round-trip is the timing-dependent variant:
 * it conserves here and does not reproduce on every live run, unlike the
 * deterministic self-send; the integration repros cover it deterministically.)
 *
 * NOTE: staging wallet-api is PRE-Unit-A (no per-row state_hash), so this exercises
 * the DEGRADED path (M2 local keep-guard + M4 skip, no server-side repair) — i.e.
 * exactly what production hits today.
 *
 * Gated on STAGING_AGGREGATOR_KEY. Run:
 *   STAGING_AGGREGATOR_KEY=sk_... npx vitest run --config vitest.e2e.config.ts \
 *     tests/e2e/self-send-roundtrip.staging.e2e.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest';

import { createHarnessWallet, type HarnessWallet } from '../harness/support/harness-wallet';
import { HARNESS_COIN, randomIdentity } from '../harness/support/stack';
import type { HarnessStack } from '../harness/support/stack';
import type { CoinBalance } from '../../wallet-api';

const API_KEY = process.env.STAGING_AGGREGATOR_KEY;

const STACK: HarnessStack = {
  baseUrl: process.env.STAGING_WALLET_API ?? 'https://wallet-api.staging.unicity.network',
  aggregatorUrl: process.env.STAGING_AGGREGATOR ?? 'https://gateway.testnet2.unicity.network',
  network: 'testnet2',
  ...(API_KEY ? { aggregatorApiKey: API_KEY } : {}),
  trustbaseUrl:
    process.env.STAGING_TRUSTBASE ??
    'https://raw.githubusercontent.com/unicitynetwork/unicity-ids/main/bft-trustbase.testnet2.json',
};

const wallets: HarnessWallet[] = [];
afterEach(() => {
  while (wallets.length) wallets.pop()?.destroy();
});

async function newWallet(deviceId: string, identity = randomIdentity()): Promise<HarnessWallet> {
  const w = await createHarnessWallet({ stack: STACK, identity, deviceId, custody: 'inventory' });
  wallets.push(w);
  await w.module.load();
  return w;
}

function totalOf(balances: CoinBalance[]): bigint {
  return balances.find((b) => b.coinId === HARNESS_COIN)?.total ?? 0n;
}

/** Poll (draining the mailbox each round) until the server balance reaches `want`, or timeout. */
async function waitForBalance(w: HarnessWallet, want: bigint, timeoutMs = 120_000): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  let last = -1n;
  for (;;) {
    try {
      await w.module.receive();
    } catch {
      /* mailbox drain is best-effort; keep polling the server balance */
    }
    last = totalOf(await w.client.getBalances());
    if (last === want || Date.now() >= deadline) return last;
    await new Promise((r) => setTimeout(r, 3_000));
  }
}

describe.runIf(!!API_KEY)('LIVE self-send + round-trip over staging wallet-api + testnet2', () => {
  it('whole-token SELF-send conserves funds (pre-fix: 100% loss)', async () => {
    const a = await newWallet('live-ss-a');

    expect((await a.module.mintFungibleToken(HARNESS_COIN, 10n)).success).toBe(true);
    expect(await waitForBalance(a, 10n)).toBe(10n);

    // Send the WHOLE token to our own address — the deterministic-loss case.
    await a.module.send({ recipient: a.identity.chainPubkey, amount: '10', coinId: HARNESS_COIN });

    // The invariant is only that value is CONSERVED once the dust settles — never 0.
    expect(await waitForBalance(a, 10n)).toBe(10n);
    // and it is a real, spendable token (not a phantom lazy row)
    expect(a.module.getTokens().reduce((s, t) => s + BigInt(t.amount), 0n)).toBe(10n);
  }, 300_000);

  it('A→B→A round-trip conserves A funds (pre-fix: permanent loss)', async () => {
    const a = await newWallet('live-rt-a');
    const bId = randomIdentity();

    expect((await a.module.mintFungibleToken(HARNESS_COIN, 10n)).success).toBe(true);
    expect(await waitForBalance(a, 10n)).toBe(10n);

    // A → B
    await a.module.send({ recipient: bId.chainPubkey, amount: '10', coinId: HARNESS_COIN });
    const b = await newWallet('live-rt-b', bId);
    expect(await waitForBalance(b, 10n)).toBe(10n);
    expect(await waitForBalance(a, 0n)).toBe(0n);

    // B → A (the round-trip — A re-acquires the same genesis token)
    await b.module.send({ recipient: a.identity.chainPubkey, amount: '10', coinId: HARNESS_COIN });
    expect(await waitForBalance(a, 10n)).toBe(10n); // A gets it back, conserved
    expect(await waitForBalance(b, 0n)).toBe(0n);

    // Total across both wallets is conserved (no token vanished).
    const aTotal = totalOf(await a.client.getBalances());
    const bTotal = totalOf(await b.client.getBalances());
    expect(aTotal + bTotal).toBe(10n);
    expect(aTotal).toBe(10n);
  }, 420_000);
});
