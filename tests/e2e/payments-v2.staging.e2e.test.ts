/**
 * WALLET payment path over the REAL staging wallet-api and the REAL testnet2
 * aggregator: PaymentsModule.send() delivers to a second real wallet, and the
 * recipient ends up holding a spendable token.
 *
 * This replaces a same-named test that composed a memory delivery double and
 * mock storage around a real engine: it proved a token certified on-chain and
 * then handed the blob to a second in-process module. Delivery, storage and
 * custody — everything wallet-api owns — were fabricated, so the composition
 * under test did not exist in production.
 *
 * KNOWN FLAKE: the whole-token test intermittently fails with "Insufficient
 * balance" when the whole e2e suite runs, while passing 3/3 in isolation — both
 * staging suites then drive the same shared backend concurrently. Ruled out: the
 * clear()+repopulate in loadFromStorageData is fully synchronous, so a send
 * cannot observe a half-loaded token map. Unproven and worth its own look; the
 * sibling staging suite is independently flaky on the same runs.
 *
 * Gated on STAGING_AGGREGATOR_KEY. Run:
 *   STAGING_AGGREGATOR_KEY=sk_... npx vitest run --config vitest.e2e.config.ts \
 *     tests/e2e/payments-v2.staging.e2e.test.ts
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

async function newWallet(deviceId: string): Promise<HarnessWallet> {
  const identity = randomIdentity();
  const w = await createHarnessWallet({
    stack: STACK,
    identity,
    // Namespace by identity so a run never inherits a prior run's local state.
    deviceId: `${deviceId}-${identity.chainPubkey.slice(2, 14)}`,
    custody: 'inventory',
  });
  wallets.push(w);
  await w.module.load();
  return w;
}

function totalOf(balances: CoinBalance[]): bigint {
  return balances.find((b) => b.coinId === HARNESS_COIN)?.total ?? 0n;
}

/**
 * Poll — receive()ing each round — until the wallet holds `want` in SPENDABLE
 * (confirmed) tokens. Three states are eventually consistent here and a test
 * that spends too early races them: the server balance, the local token set, and
 * a token's status. `getTokens()` lists tokens of any status, so summing it
 * counts one that has landed but cannot yet be spent.
 */
async function waitForSpendable(w: HarnessWallet, want: bigint, timeoutMs = 90_000): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await w.module.receive();
    } catch {
      /* best-effort drain; keep polling */
    }
    const held = w.module
      .getTokens()
      .filter((t) => t.status === 'confirmed')
      .reduce((sum, t) => sum + BigInt(t.amount), 0n);
    if (held === want || Date.now() >= deadline) return held;
    await new Promise((r) => setTimeout(r, 3_000));
  }
}

/** Poll (draining the mailbox each round) until the server balance reaches `want`. */
async function waitForBalance(w: HarnessWallet, want: bigint, timeoutMs = 120_000): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await w.module.receive();
    } catch {
      /* mailbox drain is best-effort; keep polling the server balance */
    }
    const last = totalOf(await w.client.getBalances());
    if (last === want || Date.now() >= deadline) return last;
    await new Promise((r) => setTimeout(r, 3_000));
  }
}

describe.runIf(!!API_KEY)('PaymentsModule payment path over staging wallet-api + testnet2', () => {
  it('a whole-token send lands in the recipient wallet and is spendable', async () => {
    const alice = await newWallet('pay-alice');
    const bob = await newWallet('pay-bob');

    expect((await alice.module.mintFungibleToken(HARNESS_COIN, 10n)).success).toBe(true);
    expect(await waitForBalance(alice, 10n)).toBe(10n);

    await alice.module.send({ recipient: bob.identity.chainPubkey, amount: '10', coinId: HARNESS_COIN });

    // The recipient sees it through the real mailbox, not a handed-over blob.
    expect(await waitForBalance(bob, 10n)).toBe(10n);
    expect(await waitForBalance(alice, 0n)).toBe(0n);

    // Spendable: Bob sends it onward, which only succeeds if he truly owns it.
    // Wait for the LOCAL inventory too — spend planning reads that, not the
    // server balance asserted above.
    expect(await waitForSpendable(bob, 10n)).toBe(10n);
    const carol = await newWallet('pay-carol');
    await bob.module.send({ recipient: carol.identity.chainPubkey, amount: '10', coinId: HARNESS_COIN });
    expect(await waitForBalance(carol, 10n)).toBe(10n);
    expect(await waitForBalance(bob, 0n)).toBe(0n);
  }, 300_000);

  it('a split send pays the recipient and leaves the change with the sender', async () => {
    const alice = await newWallet('split-alice');
    const bob = await newWallet('split-bob');

    expect((await alice.module.mintFungibleToken(HARNESS_COIN, 100n)).success).toBe(true);
    expect(await waitForBalance(alice, 100n)).toBe(100n);

    await alice.module.send({ recipient: bob.identity.chainPubkey, amount: '60', coinId: HARNESS_COIN });

    // Value is conserved across the split: 60 delivered, 40 change retained.
    expect(await waitForBalance(bob, 60n)).toBe(60n);
    expect(await waitForBalance(alice, 40n)).toBe(40n);
  }, 300_000);
});
