/**
 * Extended soak: multi-coin bundle send (Wave 6-P2-6, scenario 3).
 *
 * Mints UCT + USDU on Wallet A, then sends `{coinId: UCT, additionalAssets:
 * [{kind:'coin', coinId: USDU, ...}]}` in a single `payments.send` call.
 * Verifies both assets land on Wallet B via `transfer:incoming`.
 *
 * Exercises `PaymentsModule.buildTargetList` + the per-target engine op
 * loop (see PaymentsModule.ts §send) so multi-coin bundles are
 * end-to-end validated on the v2 slim rebuild.
 *
 * Run:
 *   npx tsx scripts/soak-multi-coin-bundle.ts
 */

import type { IncomingTransfer } from '../types';
import {
  TESTNET2_GATEWAY,
  UCT_COIN_ID,
  USDU_COIN_ID,
  log,
  initFreshWallet,
  sleep,
  waitForEvent,
  forceExit,
  reportPass,
  reportFail,
} from './soak-helpers';

const TAG = 'soak-multi-coin';
const UCT_MINT = 5000n;
const USDU_MINT = 3000n;
const UCT_SEND = 1000n;
const USDU_SEND = 500n;

async function main(): Promise<void> {
  const baseDir = process.env.SOAK_DATA_DIR ?? '/tmp/sphere-soak-multicoin';
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
  const identityB = sphereB.identity!;

  // Step 1: Wallet A mints UCT + USDU.
  log(TAG, 'A: minting UCT', { amount: UCT_MINT.toString() });
  const mintUct = await sphereA.payments.mintFungibleToken(UCT_COIN_ID, UCT_MINT);
  if (!mintUct.success) throw new Error(`UCT mint failed: ${mintUct.error}`);
  log(TAG, 'A: UCT minted', { tokenId: mintUct.tokenId });

  log(TAG, 'A: minting USDU', { amount: USDU_MINT.toString() });
  const mintUsdu = await sphereA.payments.mintFungibleToken(USDU_COIN_ID, USDU_MINT);
  if (!mintUsdu.success) throw new Error(`USDU mint failed: ${mintUsdu.error}`);
  log(TAG, 'A: USDU minted', { tokenId: mintUsdu.tokenId });

  await sleep(1500);

  // Step 2: pre-arm B's transfer:incoming waiter (must cover both assets).
  const incomingPromise = waitForEvent<IncomingTransfer>(
    sphereB,
    'transfer:incoming',
    60_000,
  );

  // Step 3: A sends multi-coin bundle.
  const recipientHex = identityB.chainPubkey;
  log(TAG, 'A: sending multi-coin bundle', {
    recipient: recipientHex,
    primary: { coinId: UCT_COIN_ID, amount: UCT_SEND.toString() },
    additional: { coinId: USDU_COIN_ID, amount: USDU_SEND.toString() },
  });
  const sendResult = await sphereA.payments.send({
    recipient: recipientHex,
    coinId: UCT_COIN_ID,
    amount: UCT_SEND.toString(),
    additionalAssets: [
      { kind: 'coin', coinId: USDU_COIN_ID, amount: USDU_SEND.toString() },
    ],
    memo: 'soak-multi-coin',
  });
  log(TAG, 'A: send result', {
    id: sendResult.id,
    status: sendResult.status,
    tokens: sendResult.tokens.length,
    error: sendResult.error,
  });
  if (sendResult.status !== 'delivered') {
    throw new Error(`send did not reach 'delivered': ${sendResult.error ?? sendResult.status}`);
  }

  // Step 4: wait for B's receive. The slim rebuild emits one
  // `transfer:incoming` per Nostr event; a multi-coin bundle rides on
  // a single event, so one wait covers it.
  log(TAG, 'B: awaiting transfer:incoming');
  const incoming = await incomingPromise;
  log(TAG, 'B: transfer:incoming received', {
    senderPubkey: incoming.senderPubkey,
    tokens: incoming.tokens.length,
  });

  // Step 5: Wallet B balance check for both coins.
  const uctTokensB = sphereB.payments.getTokens({ coinId: UCT_COIN_ID });
  const usduTokensB = sphereB.payments.getTokens({ coinId: USDU_COIN_ID });
  const uctTotalB = uctTokensB.reduce((s, t) => s + BigInt(t.amount), 0n);
  const usduTotalB = usduTokensB.reduce((s, t) => s + BigInt(t.amount), 0n);
  log(TAG, 'B: post-receive balances', {
    UCT: { count: uctTokensB.length, total: uctTotalB.toString() },
    USDU: { count: usduTokensB.length, total: usduTotalB.toString() },
  });
  if (uctTotalB !== UCT_SEND) {
    throw new Error(`B UCT balance mismatch: expected ${UCT_SEND}, got ${uctTotalB}`);
  }
  if (usduTotalB !== USDU_SEND) {
    throw new Error(`B USDU balance mismatch: expected ${USDU_SEND}, got ${usduTotalB}`);
  }

  // Step 6: Wallet A change tokens.
  const uctTokensA = sphereA.payments.getTokens({ coinId: UCT_COIN_ID });
  const usduTokensA = sphereA.payments.getTokens({ coinId: USDU_COIN_ID });
  const uctTotalA = uctTokensA.reduce((s, t) => s + BigInt(t.amount), 0n);
  const usduTotalA = usduTokensA.reduce((s, t) => s + BigInt(t.amount), 0n);
  log(TAG, 'A: post-send balances', {
    UCT: { count: uctTokensA.length, total: uctTotalA.toString() },
    USDU: { count: usduTokensA.length, total: usduTotalA.toString() },
  });
  const expectedUctChange = UCT_MINT - UCT_SEND;
  const expectedUsduChange = USDU_MINT - USDU_SEND;
  if (uctTotalA !== expectedUctChange) {
    throw new Error(`A UCT change mismatch: expected ${expectedUctChange}, got ${uctTotalA}`);
  }
  if (usduTotalA !== expectedUsduChange) {
    throw new Error(`A USDU change mismatch: expected ${expectedUsduChange}, got ${usduTotalA}`);
  }

  await sphereA.destroy();
  await sphereB.destroy();

  log(TAG, 'SOAK PASSED');
  reportPass({
    gateway: TESTNET2_GATEWAY,
    sent: {
      UCT: UCT_SEND.toString(),
      USDU: USDU_SEND.toString(),
    },
    walletB: {
      UCT: uctTotalB.toString(),
      USDU: usduTotalB.toString(),
    },
    walletA: {
      UCT: uctTotalA.toString(),
      USDU: usduTotalA.toString(),
    },
  });
  forceExit(0);
}

main().catch((err) => {
  log(TAG, 'SOAK FAILED', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack?.split('\n').slice(0, 5).join(' | ') : undefined,
  });
  reportFail('multi-coin-bundle', err);
  forceExit(1);
});
