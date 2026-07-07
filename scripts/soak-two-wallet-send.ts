/**
 * Extended soak: two-wallet L3 send end-to-end (Wave 6-P2-6, scenario 1).
 *
 * Runs entirely against `gateway.testnet2.unicity.network`. Init two fresh
 * Node wallets (A and B), mint 5000 UCT on A, send 2000 UCT to B via
 * `sphere.payments.send`, and verify B receives the tokens through the
 * `transfer:incoming` event. Verifies:
 *
 *   - `sphere.tokenEngine` is wired on both wallets (wave 6-P2-4e).
 *   - `sphere.payments.mintFungibleToken` produces a spendable token.
 *   - `sphere.payments.send` routes through the slim UXF wire format
 *     (v2 `payments.deliverTokens` — see PaymentsModule.ts §send).
 *   - Nostr transport delivers the payload cross-wallet in the same
 *     process (transport subscription started by
 *     `PaymentsModule.initialize`).
 *   - B accepts the token via `handleIncomingTransfer` and re-derives a
 *     UI-shaped `Token` (verify + isOwnedBy gates persistence).
 *
 * Exit 0 on PASS, non-zero on FAIL. Diagnostic on stderr, JSON summary
 * on stdout.
 *
 * Run:
 *   npx tsx scripts/soak-two-wallet-send.ts
 *
 * Env:
 *   TESTNET2_API_KEY — override embedded testnet2 key (optional).
 *   SOAK_DATA_DIR    — base data dir (default: /tmp/sphere-soak-2wallet).
 */

import type { IncomingTransfer } from '../types';
import {
  TESTNET2_GATEWAY,
  UCT_COIN_ID,
  log,
  initFreshWallet,
  sleep,
  waitForEvent,
  forceExit,
  reportPass,
  reportFail,
} from './soak-helpers';

const TAG = 'soak-2wallet';
const MINT_AMOUNT = 5000n;
const SEND_AMOUNT = 2000n;
const EXPECTED_CHANGE = 3000n;

async function main(): Promise<void> {
  const baseDir = process.env.SOAK_DATA_DIR ?? '/tmp/sphere-soak-2wallet';
  log(TAG, 'start', { gateway: TESTNET2_GATEWAY, baseDir });

  const walletA = await initFreshWallet({
    tag: `${TAG}:A`,
    dataDir: `${baseDir}/wallet-a`,
  });
  const walletB = await initFreshWallet({
    tag: `${TAG}:B`,
    dataDir: `${baseDir}/wallet-b`,
  });

  const sphereA = walletA.sphere;
  const sphereB = walletB.sphere;
  const identityA = sphereA.identity!;
  const identityB = sphereB.identity!;

  log(TAG, 'both wallets ready', {
    A: { chainPubkey: identityA.chainPubkey, directAddress: identityA.directAddress },
    B: { chainPubkey: identityB.chainPubkey, directAddress: identityB.directAddress },
  });

  // Step 1: mint 5000 UCT on Wallet A via PaymentsModule (goes through
  // the token-engine and lands in `sphere.payments.tokens`).
  log(TAG, 'A: minting UCT', { amount: MINT_AMOUNT.toString() });
  const mintResult = await sphereA.payments.mintFungibleToken(UCT_COIN_ID, MINT_AMOUNT);
  if (!mintResult.success) {
    throw new Error(`Wallet A mint failed: ${mintResult.error}`);
  }
  log(TAG, 'A: minted', {
    tokenId: mintResult.tokenId,
    amount: mintResult.token.amount,
  });

  const balanceA_beforeSend = sphereA.payments.getTokens({ coinId: UCT_COIN_ID });
  log(TAG, 'A: pre-send balance', {
    tokens: balanceA_beforeSend.length,
    total: balanceA_beforeSend
      .reduce((s, t) => s + BigInt(t.amount), 0n)
      .toString(),
  });

  // Step 2: give Nostr identity bindings a moment to settle.
  await sleep(1500);

  // Step 3: subscribe B to transfer:incoming BEFORE A sends, so the event
  // is not raced by the transport-subscription hookup timing.
  const incomingPromise = waitForEvent<IncomingTransfer>(
    sphereB,
    'transfer:incoming',
    45_000,
    (t) => t.tokens.some((tok) => tok.coinId === UCT_COIN_ID),
  );

  // Step 4: A → B send. Address B by its 64-hex transport pubkey (= chain
  // pubkey minus the 02/03 prefix). PaymentsModule extracts the recipient
  // chain pubkey from `transport.resolve()` — which returns the identity
  // binding B published on init — with a fallback to the raw hex.
  const recipientHex = identityB.chainPubkey; // full 66-hex, works via extractChainPubkey fallback
  log(TAG, 'A: sending', { recipient: recipientHex, amount: SEND_AMOUNT.toString() });
  const sendResult = await sphereA.payments.send({
    recipient: recipientHex,
    coinId: UCT_COIN_ID,
    amount: SEND_AMOUNT.toString(),
    memo: 'soak-two-wallet-send',
  });
  log(TAG, 'A: send result', {
    id: sendResult.id,
    status: sendResult.status,
    tokens: sendResult.tokens.length,
    error: sendResult.error,
  });
  if (sendResult.status !== 'delivered') {
    throw new Error(
      `Wallet A send did not reach 'delivered' — status=${sendResult.status} error=${sendResult.error ?? '(none)'}`,
    );
  }

  // Step 5: wait for B's transfer:incoming.
  log(TAG, 'B: awaiting transfer:incoming');
  const incoming = await incomingPromise;
  log(TAG, 'B: transfer:incoming received', {
    senderPubkey: incoming.senderPubkey,
    tokens: incoming.tokens.length,
    tokenIds: incoming.tokens.map((t) => t.id),
  });

  // Step 6: B verifies its wallet state.
  const balanceB = sphereB.payments.getTokens({ coinId: UCT_COIN_ID });
  const balanceB_total = balanceB.reduce((s, t) => s + BigInt(t.amount), 0n);
  log(TAG, 'B: post-receive balance', {
    tokens: balanceB.length,
    total: balanceB_total.toString(),
  });
  if (balanceB_total !== SEND_AMOUNT) {
    throw new Error(
      `Wallet B balance mismatch: expected ${SEND_AMOUNT}, got ${balanceB_total}`,
    );
  }

  // Step 7: A verifies change token = 3000 UCT.
  const balanceA = sphereA.payments.getTokens({ coinId: UCT_COIN_ID });
  const balanceA_total = balanceA.reduce((s, t) => s + BigInt(t.amount), 0n);
  log(TAG, 'A: post-send balance', {
    tokens: balanceA.length,
    total: balanceA_total.toString(),
  });
  if (balanceA_total !== EXPECTED_CHANGE) {
    throw new Error(
      `Wallet A change mismatch: expected ${EXPECTED_CHANGE}, got ${balanceA_total}`,
    );
  }

  // Step 8: clean shutdown.
  await sphereA.destroy();
  await sphereB.destroy();

  log(TAG, 'SOAK PASSED');
  reportPass({
    gateway: TESTNET2_GATEWAY,
    walletA: {
      chainPubkey: identityA.chainPubkey,
      finalBalance: balanceA_total.toString(),
      tokenCount: balanceA.length,
    },
    walletB: {
      chainPubkey: identityB.chainPubkey,
      finalBalance: balanceB_total.toString(),
      tokenCount: balanceB.length,
    },
    sent: SEND_AMOUNT.toString(),
    minted: MINT_AMOUNT.toString(),
  });
  forceExit(0);
}

main().catch((err) => {
  log(TAG, 'SOAK FAILED', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack?.split('\n').slice(0, 5).join(' | ') : undefined,
  });
  reportFail('two-wallet-send', err);
  forceExit(1);
});
