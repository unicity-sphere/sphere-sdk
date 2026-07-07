/**
 * Extended soak: invoice OPEN → PARTIAL → COVERED lifecycle
 * (Wave 6-P2-6, scenario 2).
 *
 * Wallet A creates an invoice targeting its own directAddress. Wallet B
 * imports the invoice token via `importInvoice`, then pays it via
 * `sphere.accounting.payInvoice`. We verify:
 *
 *   - `createInvoice` mints via `tokenEngine.mintDataToken` (v2 slim
 *     path, one atomic call — see AccountingModule.ts §createInvoice).
 *   - `importInvoice` accepts a `TxfToken` and populates the recipient's
 *     invoice cache.
 *   - `payInvoice` routes through `PaymentsModule.send` with the invoice
 *     memo attached.
 *   - Status transitions OPEN → PARTIAL/COVERED via
 *     `getInvoiceStatus`.
 *   - Wallet A receives the payment via `transfer:incoming`.
 *
 * Run:
 *   npx tsx scripts/soak-invoice-lifecycle.ts
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

const TAG = 'soak-invoice';
const MINT_AMOUNT_B = 5000n;
const INVOICE_AMOUNT = 1000n;

async function main(): Promise<void> {
  const baseDir = process.env.SOAK_DATA_DIR ?? '/tmp/sphere-soak-invoice';
  log(TAG, 'start', { gateway: TESTNET2_GATEWAY, baseDir });

  const walletA = await initFreshWallet({
    tag: `${TAG}:A`,
    dataDir: `${baseDir}/wallet-a`,
    accounting: true,
  });
  const walletB = await initFreshWallet({
    tag: `${TAG}:B`,
    dataDir: `${baseDir}/wallet-b`,
    accounting: true,
  });
  const sphereA = walletA.sphere;
  const sphereB = walletB.sphere;
  const identityA = sphereA.identity!;
  const identityB = sphereB.identity!;

  if (!sphereA.accounting || !sphereB.accounting) {
    throw new Error('accounting module not enabled on one or both wallets');
  }

  // Step 1: Wallet B mints UCT (payer needs funds).
  log(TAG, 'B: minting UCT (payer funds)', { amount: MINT_AMOUNT_B.toString() });
  const mintRes = await sphereB.payments.mintFungibleToken(UCT_COIN_ID, MINT_AMOUNT_B);
  if (!mintRes.success) {
    throw new Error(`B mint failed: ${mintRes.error}`);
  }
  log(TAG, 'B: minted', { tokenId: mintRes.tokenId });

  await sleep(1000);

  // Step 2: Wallet A creates the invoice.
  //
  // NOTE — v2-facing bug flagged here: `AccountingModule.createInvoice`
  // validates `coinId` with `/^[A-Za-z0-9]+$/` AND `length <= 20`.
  // v2 coinIds are 64-hex, so this validation rejects them. We attempt
  // the mint anyway with the canonical 64-hex `UCT_COIN_ID`; if the
  // rejection surfaces here, the soak reports the exact error message
  // so the parent can propagate the bug up-stack.
  log(TAG, 'A: createInvoice', {
    target: identityA.directAddress,
    coinId: UCT_COIN_ID,
    amount: INVOICE_AMOUNT.toString(),
  });
  const invoiceRes = await sphereA.accounting.createInvoice({
    targets: [
      {
        address: identityA.directAddress!,
        assets: [{ coin: [UCT_COIN_ID, INVOICE_AMOUNT.toString()] }],
      },
    ],
    memo: 'soak-invoice-lifecycle',
  });
  log(TAG, 'A: createInvoice result', {
    success: invoiceRes.success,
    invoiceId: invoiceRes.invoiceId,
    error: invoiceRes.error,
  });
  if (!invoiceRes.success || !invoiceRes.invoiceId || !invoiceRes.token) {
    throw new Error(
      `A createInvoice failed: ${invoiceRes.error ?? '(no error)'} — likely the ` +
        `AccountingModule coinId validation (^[A-Za-z0-9]+$ AND length<=20) ` +
        `is rejecting the canonical 64-hex v2 coinId. This is a v2-facing bug.`,
    );
  }
  const invoiceId: string = invoiceRes.invoiceId;
  const invoiceToken = invoiceRes.token;

  // Step 3: Wallet B imports the invoice token.
  log(TAG, 'B: importInvoice');
  const importedTerms = await sphereB.accounting.importInvoice(invoiceToken);
  log(TAG, 'B: importInvoice ok', {
    hasCreator: Boolean(importedTerms.creator),
    targets: importedTerms.targets.length,
  });

  // Step 4: check pre-pay status.
  const preStatus = await sphereB.accounting.getInvoiceStatus(invoiceId);
  log(TAG, 'B: pre-pay invoice status', { state: preStatus.state });
  if (preStatus.state !== 'OPEN') {
    throw new Error(`Pre-pay state should be OPEN, got ${preStatus.state}`);
  }

  // Step 5: pre-arm A's transfer:incoming waiter.
  const incomingPromise = waitForEvent<IncomingTransfer>(
    sphereA,
    'transfer:incoming',
    60_000,
    (t) => t.tokens.some((tok) => tok.coinId === UCT_COIN_ID),
  );

  // Step 6: Wallet B pays the invoice.
  log(TAG, 'B: payInvoice', { invoiceId, amount: INVOICE_AMOUNT.toString() });
  const payResult = await sphereB.accounting.payInvoice(invoiceId, {
    targetIndex: 0,
    amount: INVOICE_AMOUNT.toString(),
  });
  log(TAG, 'B: payInvoice result', {
    id: payResult.id,
    status: payResult.status,
    tokens: payResult.tokens.length,
    error: payResult.error,
  });
  if (payResult.status !== 'delivered') {
    throw new Error(
      `payInvoice did not reach 'delivered': status=${payResult.status} error=${payResult.error ?? '(none)'}`,
    );
  }

  // Step 7: Wallet A observes the incoming transfer.
  log(TAG, 'A: awaiting transfer:incoming');
  const incoming = await incomingPromise;
  log(TAG, 'A: transfer:incoming', {
    senderPubkey: incoming.senderPubkey,
    tokens: incoming.tokens.length,
  });

  // Step 8: post-pay status should be COVERED (single target, single asset,
  // full amount).
  await sleep(500);
  const postStatus = await sphereA.accounting.getInvoiceStatus(invoiceId);
  log(TAG, 'A: post-pay invoice status', { state: postStatus.state });
  if (postStatus.state !== 'COVERED' && postStatus.state !== 'PARTIAL') {
    throw new Error(
      `Post-pay state should be COVERED or PARTIAL, got ${postStatus.state}`,
    );
  }

  await sphereA.destroy();
  await sphereB.destroy();

  log(TAG, 'SOAK PASSED');
  reportPass({
    gateway: TESTNET2_GATEWAY,
    invoiceId,
    finalState: postStatus.state,
    walletA_chainPubkey: identityA.chainPubkey,
    walletB_chainPubkey: identityB.chainPubkey,
    paidAmount: INVOICE_AMOUNT.toString(),
  });
  forceExit(0);
}

main().catch((err) => {
  log(TAG, 'SOAK FAILED', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack?.split('\n').slice(0, 5).join(' | ') : undefined,
  });
  reportFail('invoice-lifecycle', err);
  forceExit(1);
});
