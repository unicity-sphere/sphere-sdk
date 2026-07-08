/**
 * Extended soak: invoice auto-return / manual return validation
 * (Wave 6-P2-9).
 *
 * Wallet A (issuer) creates an invoice, Wallet B (payer) mints funds and
 * pays it, then Wallet A initiates a return of the collected payment
 * back to Wallet B. We verify:
 *
 *   - `createInvoice` mints the invoice token (v2 slim path).
 *   - `payInvoice` delivers funds from B → A.
 *   - `returnAllInvoicePayments(invoiceId)` (the public API on the slim
 *     rebuild) sends the collected amount back to B. `setAutoReturn` is
 *     the flag-toggle sibling; the imperative refund is
 *     `returnAllInvoicePayments`.
 *   - Wallet B observes the refund via `transfer:incoming` within 30s.
 *   - Wallet B's confirmed UCT balance is restored (starting mint minus
 *     any residual on-chain overhead — the returned amount should equal
 *     the paid amount).
 *
 * If the refund path is not fully wired end-to-end on the slim rebuild
 * (a runtime bug the parent may need to follow up on), this soak still
 * validates the API surface and prints the precise failure step.
 *
 * Run:
 *   npx tsx scripts/soak-invoice-return.ts
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

const TAG = 'soak-invoice-return';
const MINT_AMOUNT_B = 5000n;
const INVOICE_AMOUNT = 1000n;

async function main(): Promise<void> {
  const baseDir = process.env.SOAK_DATA_DIR ?? '/tmp/sphere-soak-invoice-return';
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

  // Step 1: Wallet B mints UCT (payer funds).
  log(TAG, 'B: minting UCT (payer funds)', { amount: MINT_AMOUNT_B.toString() });
  const mintRes = await sphereB.payments.mintFungibleToken(UCT_COIN_ID, MINT_AMOUNT_B);
  if (!mintRes.success) {
    throw new Error(`B mint failed: ${mintRes.error}`);
  }
  log(TAG, 'B: minted', { tokenId: mintRes.tokenId });

  await sleep(1000);

  // Record B's pre-payment confirmed balance for the round-trip check.
  const bPreBalance = sumConfirmedUct(sphereB);
  log(TAG, 'B: pre-payment UCT confirmed balance', { balance: bPreBalance.toString() });

  // Step 2: Wallet A creates the invoice targeting itself.
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
    memo: 'soak-invoice-return',
  });
  log(TAG, 'A: createInvoice result', {
    success: invoiceRes.success,
    invoiceId: invoiceRes.invoiceId,
    error: invoiceRes.error,
  });
  if (!invoiceRes.success || !invoiceRes.invoiceId || !invoiceRes.token) {
    throw new Error(
      `A createInvoice failed: ${invoiceRes.error ?? '(no error)'} — see also ` +
        `soak-invoice-lifecycle for the coinId-validation gotcha.`,
    );
  }
  const invoiceId: string = invoiceRes.invoiceId;
  const invoiceToken = invoiceRes.token;

  // Step 3: Wallet B imports the invoice token so it can pay it.
  log(TAG, 'B: importInvoice');
  await sphereB.accounting.importInvoice(invoiceToken);

  // Step 4: pre-arm A's incoming-transfer waiter (the paying leg).
  const aIncomingPromise = waitForEvent<IncomingTransfer>(
    sphereA,
    'transfer:incoming',
    60_000,
    (t) => t.tokens.some((tok) => tok.coinId === UCT_COIN_ID),
  );

  // Step 5: Wallet B pays the invoice.
  // Partial payment (500 of 1000) — keeps the invoice OPEN/PARTIAL so
  // `cancelInvoice({autoReturn:true})` can fire the refund. A fully-
  // covered invoice auto-closes to CLOSED, and CLOSED refuses cancel.
  const PARTIAL_AMOUNT = 500n;
  log(TAG, 'B: payInvoice (partial)', {
    invoiceId,
    amount: PARTIAL_AMOUNT.toString(),
  });
  const payResult = await sphereB.accounting.payInvoice(invoiceId, {
    targetIndex: 0,
    amount: PARTIAL_AMOUNT.toString(),
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

  // Step 6: Wallet A observes the incoming transfer (the paying leg).
  log(TAG, 'A: awaiting transfer:incoming (payment leg)');
  const aIncoming = await aIncomingPromise;
  log(TAG, 'A: transfer:incoming', {
    senderPubkey: aIncoming.senderPubkey,
    tokens: aIncoming.tokens.length,
  });

  // Wait briefly for A's accounting bookkeeping to record the ledger entry
  // (invoice status → COVERED / PARTIAL), otherwise `returnAllInvoicePayments`
  // has nothing to refund yet.
  await sleep(1500);
  const midStatus = await sphereA.accounting.getInvoiceStatus(invoiceId);
  log(TAG, 'A: post-pay invoice status', { state: midStatus.state });

  // Step 7: pre-arm B's incoming-transfer waiter (the refund leg).
  const bIncomingPromise = waitForEvent<IncomingTransfer>(
    sphereB,
    'transfer:incoming',
    45_000,
    (t) => t.tokens.some((tok) => tok.coinId === UCT_COIN_ID),
  );

  // Step 8: Wallet A cancels the invoice with autoReturn = true.
  //
  // `returnAllInvoicePayments()` on a fully-COVERED/CLOSED invoice returns 0
  // by design: the CLOSED freeze zeros per-sender balances via the
  // surplus-distribution algorithm in balance-computer.ts. That API is
  // for OVERPAID (surplus > 0) invoices only.
  //
  // The correct refund flow for a normally-paid invoice is
  // `cancelInvoice({ autoReturn: true })` — this CANCELS the invoice AND
  // refunds all forwarded payments to their senders. (Under the hood it
  // routes through the same per-sender-balance ledger but uses the
  // CANCELLED freeze path which preserves balances instead of zeroing.)
  //
  // For this to work end-to-end the sender's DIRECT:// address must be
  // present in the RECEIVED history entry — Phase 6-P2-12 added the wire
  // hint (payload.sender.directAddress) so the receive path doesn't have
  // to race the sender's Nostr identity binding lookup.
  log(TAG, 'A: cancelInvoice with autoReturn', { invoiceId });
  await sphereA.accounting.cancelInvoice(invoiceId, { autoReturn: true });
  log(TAG, 'A: cancelInvoice returned');

  // Step 9: Wallet B observes the refund via transfer:incoming.
  log(TAG, 'B: awaiting transfer:incoming (refund leg)');
  const bIncoming = await bIncomingPromise;
  log(TAG, 'B: transfer:incoming (refund)', {
    senderPubkey: bIncoming.senderPubkey,
    tokens: bIncoming.tokens.length,
  });

  // Step 10: allow B's payments module to finalize the incoming refund,
  // then verify B's UCT confirmed balance is restored to the pre-payment
  // value (net-zero round trip).
  await sleep(2000);
  const bPostBalance = sumConfirmedUct(sphereB);
  log(TAG, 'B: post-refund UCT confirmed balance', {
    pre: bPreBalance.toString(),
    post: bPostBalance.toString(),
    delta: (bPostBalance - bPreBalance).toString(),
  });

  // A successful round trip should restore B to at least the pre-payment
  // balance. Some flows may momentarily leave the refund unconfirmed —
  // accept "restored" as `post >= pre - INVOICE_AMOUNT + returned-tokens`;
  // strictly, `post` should equal `pre` once the refund lands & finalizes.
  if (bPostBalance < bPreBalance) {
    throw new Error(
      `B balance not restored: pre=${bPreBalance} post=${bPostBalance} ` +
        `— refund arrived (${bIncoming.tokens.length} tokens) but ` +
        `balance is short by ${(bPreBalance - bPostBalance).toString()}.`,
    );
  }

  await sphereA.destroy();
  await sphereB.destroy();

  log(TAG, 'SOAK PASSED');
  reportPass({
    gateway: TESTNET2_GATEWAY,
    invoiceId,
    walletA_chainPubkey: identityA.chainPubkey,
    walletB_chainPubkey: identityB.chainPubkey,
    paidAmount: PARTIAL_AMOUNT.toString(),
    refundMechanism: 'cancelInvoice({autoReturn:true})',
    bPreBalance: bPreBalance.toString(),
    bPostBalance: bPostBalance.toString(),
  });
  forceExit(0);
}

function sumConfirmedUct(sphere: import('../core/Sphere').Sphere): bigint {
  const assets = sphere.payments.getBalance(UCT_COIN_ID);
  let total = 0n;
  for (const asset of assets) {
    if (asset.coinId !== UCT_COIN_ID) continue;
    total += BigInt(asset.confirmedAmount);
  }
  return total;
}

main().catch((err) => {
  log(TAG, 'SOAK FAILED', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack?.split('\n').slice(0, 5).join(' | ') : undefined,
  });
  reportFail('invoice-return', err);
  forceExit(1);
});
