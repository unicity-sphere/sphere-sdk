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
import {
  refreshView,
  sendWhenSpendable,
  totalOf,
  waitForBalance,
  waitForTokenOfAmount,
  waitForTokens,
} from '../harness/support/settle';

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
  // Namespace local storage by the (random) identity so runs never inherit a prior run's
  // stale local tokens/journal — otherwise leftover state contaminates id-composition checks.
  const uniqueDeviceId = `${deviceId}-${identity.chainPubkey.slice(2, 14)}`;
  const w = await createHarnessWallet({ stack: STACK, identity, deviceId: uniqueDeviceId, custody: 'inventory' });
  wallets.push(w);
  await w.module.load();
  return w;
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
    await sendWhenSpendable(a, a.identity.chainPubkey, 10n);

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
    await sendWhenSpendable(a, bId.chainPubkey, 10n);
    const b = await newWallet('live-rt-b', bId);
    expect(await waitForBalance(b, 10n)).toBe(10n);
    expect(await waitForBalance(a, 0n)).toBe(0n);

    // B → A (the round-trip — A re-acquires the same genesis token)
    await sendWhenSpendable(b, a.identity.chainPubkey, 10n);
    expect(await waitForBalance(a, 10n)).toBe(10n); // A gets it back, conserved
    expect(await waitForBalance(b, 0n)).toBe(0n);

    // Total across both wallets is conserved (no token vanished).
    const aTotal = totalOf(await a.client.getBalances());
    const bTotal = totalOf(await b.client.getBalances());
    expect(aTotal + bTotal).toBe(10n);
    expect(aTotal).toBe(10n);
  }, 420_000);

  it('a→b→c→b→a→c→a→b→a round-trips ONE token with NO splits — same genesis id the whole way', async () => {
    const a = await newWallet('rt1-a');
    const b = await newWallet('rt1-b');
    const c = await newWallet('rt1-c');
    const byName: Record<'a' | 'b' | 'c', HarnessWallet> = { a, b, c };
    // Held token ids (v2_<genesisId>) are genesis-stable across transfers.
    const idsOf = (w: HarnessWallet): string[] => w.module.getTokens().map((t) => t.id).sort();

    expect((await a.module.mintFungibleToken(HARNESS_COIN, 100n)).success).toBe(true);
    expect(await waitForBalance(a, 100n)).toBe(100n);
    const g0 = idsOf(a)[0]!; // the one and only token — it never changes identity below

    // Every hop moves the WHOLE token (amount == full value), so every transfer is DIRECT and
    // preserves the genesis id. The one token visits all three wallets and is re-acquired at A
    // three times (hops 4, 6, 8). Nothing ever splits, so the id stays g0 for the entire path.
    const hops: Array<['a' | 'b' | 'c', 'a' | 'b' | 'c']> = [
      ['a', 'b'], ['b', 'c'], ['c', 'b'], ['b', 'a'], ['a', 'c'], ['c', 'a'], ['a', 'b'], ['b', 'a'],
    ];
    for (const [fromName, toName] of hops) {
      const from = byName[fromName];
      const to = byName[toName];
      await sendWhenSpendable(from, to.identity.chainPubkey, 100n);
      expect(await waitForBalance(to, 100n)).toBe(100n);
      expect(await waitForBalance(from, 0n)).toBe(0n);
      // Receiver holds exactly ONE token and it is still g0 — same token, never split/duplicated.
      expect(idsOf(to)).toEqual([g0]);
      const total =
        totalOf(await a.client.getBalances()) +
        totalOf(await b.client.getBalances()) +
        totalOf(await c.client.getBalances());
      expect(total).toBe(100n);
    }

    // Ends back at A holding exactly the original token, whole.
    expect(idsOf(a)).toEqual([g0]);
    expect(await waitForBalance(a, 100n)).toBe(100n);
    expect(totalOf(await b.client.getBalances())).toBe(0n);
    expect(totalOf(await c.client.getBalances())).toBe(0n);
  }, 600_000);

  it('MIXED send (direct + split in one package) mid-path, with same-token re-acquire, conserves', async () => {
    const a = await newWallet('mix-a');
    const b = await newWallet('mix-b');
    const c = await newWallet('mix-c');

    // Every genesis-id / composition read below goes through the refreshed view: getTokens() is an
    // eventually-consistent LOCAL cache, and a flush does not reconcile it (see refreshView).
    const idsOf = async (w: HarnessWallet): Promise<string[]> => (await refreshView(w)).map((t) => t.id).sort();
    const idOfAmount = waitForTokenOfAmount;

    expect((await a.module.mintFungibleToken(HARNESS_COIN, 100n)).success).toBe(true);
    expect(await waitForBalance(a, 100n)).toBe(100n);
    const g0 = await idOfAmount(a, 100n);

    // --- Phase 1: whole-token round-trip A→B→A (DIRECT) — A re-acquires the SAME token g0. ---
    await sendWhenSpendable(a, b.identity.chainPubkey, 100n);
    expect(await waitForBalance(b, 100n)).toBe(100n);
    await sendWhenSpendable(b, a.identity.chainPubkey, 100n);
    expect(await waitForBalance(a, 100n)).toBe(100n);
    expect(await idsOf(a)).toEqual([g0]);

    // --- Phase 2: two SPLITs fragment A into three tokens spread across the wallets. Each split
    // burns its parent and mints fresh genesis ids. ---
    await sendWhenSpendable(a, b.identity.chainPubkey, 30n); // g0 → g1(30@B) + g2(70@A)
    expect(await waitForBalance(b, 30n)).toBe(30n);
    expect(await waitForBalance(a, 70n)).toBe(70n);
    const g1 = await idOfAmount(b, 30n);
    await sendWhenSpendable(a, c.identity.chainPubkey, 40n); // g2 → g3(40@C) + g4(30@A)
    expect(await waitForBalance(c, 40n)).toBe(40n);
    expect(await waitForBalance(a, 30n)).toBe(30n);
    const g3 = await idOfAmount(c, 40n);
    const g4 = await idOfAmount(a, 30n);

    // --- Phase 3: pull the two fragments back so A holds THREE tokens {30, 30, 40} = 100. ---
    await sendWhenSpendable(b, a.identity.chainPubkey, 30n); // g1 whole → A
    expect(await waitForBalance(a, 60n)).toBe(60n);
    await sendWhenSpendable(c, a.identity.chainPubkey, 40n); // g3 whole → A
    expect(await waitForBalance(a, 100n)).toBe(100n);
    const aFrag = await waitForTokens(a, 100n, 3); // settle: three distinct tokens {30, 30, 40}
    const preMixIds = new Set(aFrag.map((t) => t.id));
    expect(preMixIds).toEqual(new Set([g4, g1, g3])); // A re-acquired g1 and g3 whole
    const known = new Set([g0, g1, g3, g4]); // every genesis id seen so far (g2 already burned)

    // --- Phase 4: THE MIXED SEND. A sends 80 from {30,30,40}. No whole-token subset sums to 80,
    // so coin selection sends two tokens WHOLE (direct) and SPLITS the third for the remaining 20
    // — a single send whose package is a split AND direct transfers together. ---
    await sendWhenSpendable(a, b.identity.chainPubkey, 80n);
    expect(await waitForBalance(b, 80n)).toBe(80n);
    expect(await waitForBalance(a, 20n)).toBe(20n);

    // The RECIPIENT's view is the authoritative proof of the package's shape: B receives exactly
    // three tokens — two arriving WHOLE (their pre-mix genesis ids preserved = DIRECT legs) and
    // one with a fresh genesis id (the SPLIT leg). Both transfer kinds in ONE send.
    const bTokens = await waitForTokens(b, 80n, 3); // settle: three legs totaling 80
    const directLegs = bTokens.filter((t) => preMixIds.has(t.id)); // arrived WHOLE — genesis preserved
    const splitLegs = bTokens.filter((t) => !known.has(t.id)); // fresh genesis minted by the split
    expect(directLegs).toHaveLength(2); // two DIRECT transfers in the package
    expect(splitLegs).toHaveLength(1); // one SPLIT leg in the SAME package

    // The SENDER keeps only the split's change. After a self-initiated split the local inventory
    // over-lists the spent parent until an inventory resync prunes it (server balance is already
    // 20 — waitForBalance above). waitForTokens settles the local view to the one change leg.
    const aTokens = await waitForTokens(a, 20n, 1);
    expect(aTokens).toHaveLength(1); // just the change leg, once the spent parent is pruned
    expect(aTokens[0]?.amt).toBe(20n);
    expect(known.has(aTokens[0]?.id ?? '')).toBe(false); // change is a fresh genesis (parent was burned)

    // conservation on the server immediately after the mixed send
    expect(
      totalOf(await a.client.getBalances()) +
        totalOf(await b.client.getBalances()) +
        totalOf(await c.client.getBalances()),
    ).toBe(100n);

    // --- Phase 5: B returns its three tokens whole — value round-trips back to A, conserved. ---
    await sendWhenSpendable(b, a.identity.chainPubkey, 80n);
    expect(await waitForBalance(a, 100n)).toBe(100n);
    expect(totalOf(await b.client.getBalances())).toBe(0n);
    expect(totalOf(await c.client.getBalances())).toBe(0n);
    expect((await waitForTokens(a, 100n)).reduce((s, t) => s + t.amt, 0n)).toBe(100n);
  }, 600_000);
});
