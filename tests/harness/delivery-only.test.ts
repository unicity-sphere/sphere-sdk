/**
 * Phase-2 harness — the delivery-only composition over the REAL backend
 * (sdk-changes S7: own storage + wallet-api delivery).
 *
 * Custody stays client-side end to end: the sender never calls apply (the
 * send closes via intents/complete alone — §6 storage-opt-out senders), the
 * recipient's claims are `intoInventory: false` by composition, and the
 * server performs ZERO inventory writes for either party — asserted through
 * the REAL inventory API, not a fake's internals.
 */

import { describe, it, expect, afterEach } from 'vitest';

import { createHarnessWallet, type HarnessWallet } from './support/harness-wallet';
import { HARNESS_COIN, randomIdentity, stackFromEnv } from './support/stack';

const stack = stackFromEnv();

const wallets: HarnessWallet[] = [];
afterEach(() => {
  while (wallets.length) wallets.pop()?.destroy();
});

async function newOwnStorageWallet(deviceId: string, identity = randomIdentity()): Promise<HarnessWallet> {
  const wallet = await createHarnessWallet({
    stack,
    identity,
    deviceId,
    custody: 'external',
  });
  wallets.push(wallet);
  await wallet.module.load();
  return wallet;
}

describe('own storage + wallet-api delivery (delivery-only composition)', () => {
  it('tokens move via the mailbox with ZERO server-side inventory writes on either side', async () => {
    const sender = await newOwnStorageWallet('do-sender');
    const recipientIdentity = randomIdentity();

    // Mint into the app's OWN storage — nothing reaches the server inventory.
    expect((await sender.module.mintFungibleToken(HARNESS_COIN, 1000n)).success).toBe(true);
    expect((await sender.client.listInventory()).items).toHaveLength(0);

    const result = await sender.module.send({
      recipient: recipientIdentity.chainPubkey,
      amount: '1000',
      coinId: HARNESS_COIN,
    });
    expect(result.status).toBe('completed');

    // The recipient comes online AFTER the deposit, so this explicit poll IS
    // the discovery (a wallet composed earlier could have claimed on a §9
    // wake — the real backend pushes them, unlike the in-process fake).
    const recipient = await newOwnStorageWallet('do-recipient', recipientIdentity);

    // E.3 uniform close: completeIntent alone closed the send (no apply).
    expect(await sender.client.listIntents('open')).toHaveLength(0);

    // The recipient discovers and claims — custody stays in app storage.
    const { transfers } = await recipient.module.receive();
    expect(transfers).toHaveLength(1);
    expect(recipient.module.getTokens()[0]).toMatchObject({ amount: '1000', status: 'confirmed' });

    // The §6 delivery-only property, asserted via the REAL inventory API:
    // zero inventory writes server-side for sender AND recipient.
    expect((await sender.client.listInventory()).items).toHaveLength(0);
    expect((await recipient.client.listInventory()).items).toHaveLength(0);
    expect(await sender.client.getBalances()).toEqual([]);
    expect(await recipient.client.getBalances()).toEqual([]);

    // The mailbox entry resolved (claimed) under the send's transferId.
    const mailbox = await recipient.client.listMailbox();
    const entries = mailbox.entries.filter((e) => e.transferId === result.id);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('claimed');
  });
});
