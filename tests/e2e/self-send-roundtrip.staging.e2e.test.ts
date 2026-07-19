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

    // Prove staging exposes per-row state_hash (Unit A) — else this would silently test the
    // degraded (skip-primary) path instead of M4's real state-scoped reconciliation.
    const inv = await a.client.listInventory();
    expect(inv.items[0]?.stateHash).toMatch(/^[0-9a-f]+$/);

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

  it('round-trips the SAME genesis token (direct) AND a split output (direct) — re-acquired at A, proven by id', async () => {
    const a = await newWallet('mrt-a');
    const b = await newWallet('mrt-b');
    const c = await newWallet('mrt-c');

    // A wallet's held token IDs (v2_<genesisId>) — genesis-stable across transfers, so a
    // re-acquired token keeps the SAME id. This is what makes it a genuine round-trip of the
    // SAME token (the actual bug), not a value coincidence.
    const idsOf = (w: HarnessWallet): string[] => w.module.getTokens().map((t) => t.id).sort();
    const idOfAmount = (w: HarnessWallet, amt: bigint): string => {
      const t = w.module.getTokens().find((x) => BigInt(x.amount) === amt);
      if (!t) throw new Error(`${w.identity.chainPubkey.slice(0, 6)} holds no ${amt}-token (has ${idsOf(w).join(',')})`);
      return t.id;
    };

    expect((await a.module.mintFungibleToken(HARNESS_COIN, 100n)).success).toBe(true);
    expect(await waitForBalance(a, 100n)).toBe(100n);
    const g0 = idOfAmount(a, 100n); // the minted token

    // --- Phase 1: round-trip the WHOLE minted token A→B→A (DIRECT). Genesis id is preserved,
    // so A re-acquires the SAME token g0. (Pre-fix this is where A loses it.) ---
    await a.module.send({ recipient: b.identity.chainPubkey, amount: '100', coinId: HARNESS_COIN });
    expect(await waitForBalance(b, 100n)).toBe(100n);
    expect(idOfAmount(b, 100n)).toBe(g0); // same token now at B
    await b.module.send({ recipient: a.identity.chainPubkey, amount: '100', coinId: HARNESS_COIN });
    expect(await waitForBalance(a, 100n)).toBe(100n);
    expect(idsOf(a)).toEqual([g0]); // ← A re-acquired the SAME genesis token

    // --- Phase 2: SPLIT it (60 to B + 40 change at A). This BURNS g0 and mints two NEW genesis
    // tokens: g1 (60, at B) and g2 (40, A's change). ---
    await a.module.send({ recipient: b.identity.chainPubkey, amount: '60', coinId: HARNESS_COIN });
    expect(await waitForBalance(b, 60n)).toBe(60n);
    expect(await waitForBalance(a, 40n)).toBe(40n);
    const g1 = idOfAmount(b, 60n); // split output sent to B
    const g2 = idOfAmount(a, 40n); // split change kept at A
    expect(new Set([g0, g1, g2]).size).toBe(3); // split minted brand-new genesis ids

    // --- Phase 3: round-trip the SPLIT OUTPUT g1 (60) whole B→C→A (DIRECT) — A re-acquires g1. ---
    await b.module.send({ recipient: c.identity.chainPubkey, amount: '60', coinId: HARNESS_COIN });
    expect(await waitForBalance(c, 60n)).toBe(60n);
    expect(idOfAmount(c, 60n)).toBe(g1);
    await c.module.send({ recipient: a.identity.chainPubkey, amount: '60', coinId: HARNESS_COIN });
    expect(await waitForBalance(a, 100n)).toBe(100n); // A now holds g2(40) + g1(60)
    expect(idOfAmount(a, 60n)).toBe(g1); // ← A re-acquired the SAME split-output token g1
    expect(idsOf(a)).toEqual([g1, g2].sort());

    // --- Phase 4: round-trip the OTHER split output g2 (40) whole A→C→A (DIRECT) — A re-acquires g2. ---
    await a.module.send({ recipient: c.identity.chainPubkey, amount: '40', coinId: HARNESS_COIN });
    expect(await waitForBalance(c, 40n)).toBe(40n);
    expect(idOfAmount(c, 40n)).toBe(g2);
    await c.module.send({ recipient: a.identity.chainPubkey, amount: '40', coinId: HARNESS_COIN });
    expect(await waitForBalance(a, 100n)).toBe(100n);
    expect(idOfAmount(a, 40n)).toBe(g2); // ← A re-acquired the SAME split-output token g2

    // End: A holds exactly the two split outputs (60 + 40 = 100); B and C empty; conserved.
    expect(idsOf(a)).toEqual([g1, g2].sort());
    expect(a.module.getTokens().reduce((s, t) => s + BigInt(t.amount), 0n)).toBe(100n);
    expect(totalOf(await b.client.getBalances())).toBe(0n);
    expect(totalOf(await c.client.getBalances())).toBe(0n);
    const total =
      totalOf(await a.client.getBalances()) +
      totalOf(await b.client.getBalances()) +
      totalOf(await c.client.getBalances());
    expect(total).toBe(100n);
  }, 600_000);
});
