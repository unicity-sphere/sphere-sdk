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
 * The "Insufficient balance" flake this suite used to hit is FIXED, not
 * suppressed: a send was planned from a local view the server balance had
 * already outrun. `module.sync()` is a write-only flush, so no amount of polling
 * it reconciles anything — the waits now live in harness/support/settle.ts and
 * every send goes through sendWhenSpendable.
 *
 * Gated on STAGING_AGGREGATOR_KEY. Run:
 *   STAGING_AGGREGATOR_KEY=sk_... npx vitest run --config vitest.e2e.config.ts \
 *     tests/e2e/payments-v2.staging.e2e.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest';

import { createHarnessWallet, type HarnessWallet } from '../harness/support/harness-wallet';
import { HARNESS_COIN, randomIdentity } from '../harness/support/stack';
import type { HarnessStack } from '../harness/support/stack';
import { sendWhenSpendable, waitForBalance, waitForSpendable } from '../harness/support/settle';

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

describe.runIf(!!API_KEY)('PaymentsModule payment path over staging wallet-api + testnet2', () => {
  it('a whole-token send lands in the recipient wallet and is spendable', async () => {
    const alice = await newWallet('pay-alice');
    const bob = await newWallet('pay-bob');

    expect((await alice.module.mintFungibleToken(HARNESS_COIN, 10n)).success).toBe(true);
    expect(await waitForBalance(alice, 10n)).toBe(10n);

    await sendWhenSpendable(alice, bob.identity.chainPubkey, 10n);

    // The recipient sees it through the real mailbox, not a handed-over blob.
    expect(await waitForBalance(bob, 10n)).toBe(10n);
    expect(await waitForBalance(alice, 0n)).toBe(0n);

    // Spendable: Bob sends it onward, which only succeeds if he truly owns it.
    // Wait for the LOCAL inventory too — spend planning reads that, not the
    // server balance asserted above.
    expect(await waitForSpendable(bob, 10n)).toBe(10n);
    const carol = await newWallet('pay-carol');
    await sendWhenSpendable(bob, carol.identity.chainPubkey, 10n);
    expect(await waitForBalance(carol, 10n)).toBe(10n);
    expect(await waitForBalance(bob, 0n)).toBe(0n);
  }, 300_000);

  it('a split send pays the recipient and leaves the change with the sender', async () => {
    const alice = await newWallet('split-alice');
    const bob = await newWallet('split-bob');

    expect((await alice.module.mintFungibleToken(HARNESS_COIN, 100n)).success).toBe(true);
    expect(await waitForBalance(alice, 100n)).toBe(100n);

    await sendWhenSpendable(alice, bob.identity.chainPubkey, 60n);

    // Value is conserved across the split: 60 delivered, 40 change retained.
    expect(await waitForBalance(bob, 60n)).toBe(60n);
    expect(await waitForBalance(alice, 40n)).toBe(40n);
  }, 300_000);
});
