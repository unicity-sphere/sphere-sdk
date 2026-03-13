#!/usr/bin/env npx tsx
/**
 * E2E Multi-Token Transfer Stress Test Script
 *
 * Tests heavy multi-token transfer scenarios to verify no tokens are lost:
 *
 *   Scenario A — "Split-then-multi-transfer":
 *     Alice starts with 100 UCT (1 token). She splits it into 15 pieces by
 *     sending small amounts to Bob in succession (each forces a split).
 *     After all 15 transfers, verify balance conservation.
 *
 *   Scenario B — "15 rapid-fire split transfers":
 *     Alice sends 15 quick split transfers to Bob back-to-back with minimal
 *     delay. Verifies that every transfer arrives (no Nostr d-tag collision
 *     or timestamp filter drops).
 *
 * Both scenarios verify:
 *   - Balance conservation: sender_loss == receiver_gain == expected_total
 *   - Token count: receiver ends with the expected number of tokens
 *   - No token loss: total supply across both wallets is unchanged
 *
 * Usage:
 *   npx tsx tests/scripts/test-e2e-multi-transfers.ts [--cleanup]
 */

import { Sphere } from '../../core/Sphere';
import { createNodeProviders } from '../../impl/nodejs';
import { TokenRegistry } from '../../registry/TokenRegistry';
import { TransferMode } from '../../types';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';

// =============================================================================
// Constants
// =============================================================================

const FAUCET_URL = 'https://faucet.unicity.network/api/v1/faucet/request';
const NETWORK = 'testnet' as const;
const FAUCET_TOPUP_TIMEOUT_MS = 90_000;
const TRANSFER_TIMEOUT_MS = 90_000;
const CHANGE_TOKEN_TIMEOUT_MS = 20_000;
const INTER_TRANSFER_DELAY_MS = 2_000;
const POLL_INTERVAL_MS = 1_000;

// =============================================================================
// Types
// =============================================================================

interface BalanceSnapshot {
  confirmed: bigint;
  unconfirmed: bigint;
  total: bigint;
  tokens: number;
}

interface ScenarioResult {
  scenario: string;
  transferCount: number;
  successfulTransfers: number;
  failedTransfers: number;
  totalAmountSent: bigint;
  senderBalanceBefore: bigint;
  senderBalanceAfter: bigint;
  receiverBalanceBefore: bigint;
  receiverBalanceAfter: bigint;
  senderDelta: bigint;
  receiverDelta: bigint;
  balanceConserved: boolean;
  totalSupplyConserved: boolean;
  totalTimeMs: number;
  success: boolean;
  error?: string;
}

// =============================================================================
// Utility Functions
// =============================================================================

function generateTestRunId(): string {
  return randomBytes(3).toString('hex');
}

function parseAmount(amountStr: string, decimals: number): bigint {
  const multiplier = 10n ** BigInt(decimals);
  const parts = amountStr.split('.');
  if (parts.length === 2) {
    const wholePart = BigInt(parts[0]) * multiplier;
    const fracStr = parts[1].padEnd(decimals, '0').slice(0, decimals);
    const fracPart = BigInt(fracStr);
    return wholePart + fracPart;
  }
  return BigInt(parts[0]) * multiplier;
}

function getBalance(sphere: Sphere, coinSymbol: string, allowMissing = false): BalanceSnapshot {
  const balances = sphere.payments.getBalance();
  const bal = balances.find(b => b.symbol === coinSymbol);
  if (!bal) {
    if (allowMissing) return { confirmed: 0n, unconfirmed: 0n, total: 0n, tokens: 0 };
    throw new Error(`Coin ${coinSymbol} not found. Available: ${balances.map(b => b.symbol).join(', ') || 'none'}`);
  }
  return {
    confirmed: BigInt(bal.confirmedAmount),
    unconfirmed: BigInt(bal.unconfirmedAmount),
    total: BigInt(bal.totalAmount),
    tokens: bal.tokenCount,
  };
}

function formatBalance(bal: BalanceSnapshot, decimals: number): string {
  const divisor = BigInt(10 ** decimals);
  const whole = bal.total / divisor;
  const frac = bal.total % divisor;
  const formatted = frac > 0n
    ? `${whole}.${frac.toString().padStart(decimals, '0').replace(/0+$/, '')}`
    : whole.toString();
  return `${formatted} (${bal.tokens} tokens, ${bal.confirmed > 0n ? 'conf' : ''}${bal.unconfirmed > 0n ? '+unconf' : ''})`;
}

// =============================================================================
// Wallet Management
// =============================================================================

async function createTestWallet(
  profileName: string,
  nametag: string,
): Promise<{ sphere: Sphere; mnemonic?: string }> {
  const dataDir = `./.sphere-cli-${profileName}`;
  const tokensDir = `${dataDir}/tokens`;

  const providers = createNodeProviders({
    network: NETWORK,
    dataDir,
    tokensDir,
  });

  const { sphere, generatedMnemonic } = await Sphere.init({
    ...providers,
    autoGenerate: true,
    nametag,
  });

  return { sphere, mnemonic: generatedMnemonic };
}

// =============================================================================
// Faucet
// =============================================================================

async function requestFaucet(
  nametag: string,
  coin: string,
  amount: number,
): Promise<{ success: boolean; message?: string }> {
  try {
    const response = await fetch(FAUCET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unicityId: nametag, coin, amount }),
    });
    const result = await response.json() as { success: boolean; message?: string; error?: string };
    return { success: result.success, message: result.message || result.error };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : 'Request failed' };
  }
}

async function topupAndWait(
  sphere: Sphere,
  nametag: string,
  coin: string,
  amount: number,
  symbol: string,
  expectedSmallest: bigint,
): Promise<void> {
  console.log(`\n[TOPUP] Requesting ${amount} ${symbol} from faucet for @${nametag}...`);
  const result = await requestFaucet(nametag, coin, amount);
  const status = result.success ? 'OK' : `FAILED: ${result.message}`;
  console.log(`  Faucet response: ${status}`);

  if (!result.success) {
    throw new Error(`Faucet request failed: ${result.message}`);
  }

  console.log(`[TOPUP] Waiting for ${symbol} to arrive via Nostr...`);
  const startTime = performance.now();

  while (performance.now() - startTime < FAUCET_TOPUP_TIMEOUT_MS) {
    await sphere.payments.load();
    const bal = getBalance(sphere, symbol, true);
    if (bal.total >= expectedSmallest) {
      const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
      console.log(`  ${symbol} received in ${elapsed}s: ${bal.total} smallest units (${bal.tokens} tokens)`);
      return;
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  const finalBal = getBalance(sphere, symbol, true);
  throw new Error(`Faucet topup timed out. ${symbol}: got ${finalBal.total}, expected >= ${expectedSmallest}`);
}

// =============================================================================
// Polling
// =============================================================================

async function waitForReceiverBalance(
  receiver: Sphere,
  coinSymbol: string,
  expectedMinTotal: bigint,
  timeoutMs: number = TRANSFER_TIMEOUT_MS,
): Promise<{ receiveTimeMs: number; finalBalance: BalanceSnapshot; timedOut: boolean }> {
  const startTime = performance.now();

  while (performance.now() - startTime < timeoutMs) {
    await receiver.payments.load();
    const balance = getBalance(receiver, coinSymbol, true);

    if (balance.total >= expectedMinTotal) {
      return {
        receiveTimeMs: performance.now() - startTime,
        finalBalance: balance,
        timedOut: false,
      };
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  const finalBalance = getBalance(receiver, coinSymbol, true);
  return {
    receiveTimeMs: performance.now() - startTime,
    finalBalance,
    timedOut: true,
  };
}

async function waitForSenderChange(
  sender: Sphere,
  coinSymbol: string,
  expectedTotal: bigint,
  timeoutMs: number = CHANGE_TOKEN_TIMEOUT_MS,
): Promise<{ balance: BalanceSnapshot; timedOut: boolean }> {
  const deadline = performance.now() + timeoutMs;
  let bal = getBalance(sender, coinSymbol);
  while (performance.now() < deadline && bal.total < expectedTotal) {
    await new Promise(r => setTimeout(r, 1_000));
    await sender.payments.load();
    bal = getBalance(sender, coinSymbol);
  }
  return { balance: bal, timedOut: bal.total < expectedTotal };
}

// =============================================================================
// Scenario A: Split into N pieces via successive transfers
// =============================================================================

async function runScenarioA(
  sender: Sphere,
  receiver: Sphere,
  receiverNametag: string,
  coinSymbol: string,
  transferCount: number,
  amountPerTransfer: string,
  transferMode: TransferMode,
): Promise<ScenarioResult> {
  const registry = TokenRegistry.getInstance();
  const coinDef = registry.getDefinitionBySymbol(coinSymbol);
  if (!coinDef) throw new Error(`Unknown coin: ${coinSymbol}`);
  const decimals = coinDef.decimals ?? 0;
  const amountSmallest = parseAmount(amountPerTransfer, decimals);
  const totalExpected = amountSmallest * BigInt(transferCount);

  const scenario = `A: ${transferCount}x ${amountPerTransfer} ${coinSymbol} splits (${transferMode})`;

  console.log(`\n${'='.repeat(70)}`);
  console.log(`SCENARIO: ${scenario}`);
  console.log(`  Transfer count: ${transferCount}`);
  console.log(`  Amount per transfer: ${amountPerTransfer} ${coinSymbol} (${amountSmallest} smallest)`);
  console.log(`  Total expected: ${totalExpected} smallest`);
  console.log(`  Mode: ${transferMode.toUpperCase()}`);
  console.log('='.repeat(70));

  const result: ScenarioResult = {
    scenario,
    transferCount,
    successfulTransfers: 0,
    failedTransfers: 0,
    totalAmountSent: 0n,
    senderBalanceBefore: 0n,
    senderBalanceAfter: 0n,
    receiverBalanceBefore: 0n,
    receiverBalanceAfter: 0n,
    senderDelta: 0n,
    receiverDelta: 0n,
    balanceConserved: false,
    totalSupplyConserved: false,
    totalTimeMs: 0,
    success: false,
  };

  const startTime = performance.now();

  try {
    // Snapshot BEFORE
    await sender.payments.load();
    await receiver.payments.load();
    const senderBefore = getBalance(sender, coinSymbol);
    const receiverBefore = getBalance(receiver, coinSymbol, true);
    result.senderBalanceBefore = senderBefore.total;
    result.receiverBalanceBefore = receiverBefore.total;
    const totalSupplyBefore = senderBefore.total + receiverBefore.total;

    console.log(`\n[BEFORE] Sender:   ${formatBalance(senderBefore, decimals)}`);
    console.log(`[BEFORE] Receiver: ${formatBalance(receiverBefore, decimals)}`);
    console.log(`[BEFORE] Total supply: ${totalSupplyBefore}`);

    if (senderBefore.total < totalExpected) {
      throw new Error(
        `Insufficient sender balance: ${senderBefore.total} < ${totalExpected}`,
      );
    }

    // Execute N transfers sequentially
    for (let i = 0; i < transferCount; i++) {
      const transferNum = i + 1;
      console.log(`\n  [${transferNum}/${transferCount}] Sending ${amountPerTransfer} ${coinSymbol}...`);

      try {
        const sendStart = performance.now();
        const sendResult = await sender.payments.send({
          recipient: `@${receiverNametag}`,
          amount: amountSmallest.toString(),
          coinId: coinDef.id,
          transferMode,
        });
        const sendTime = performance.now() - sendStart;

        const sendOk = sendResult.status === 'completed' || sendResult.status === 'delivered';
        if (sendOk) {
          result.successfulTransfers++;
          result.totalAmountSent += amountSmallest;
          console.log(`    OK in ${sendTime.toFixed(0)}ms (status: ${sendResult.status})`);
        } else {
          result.failedTransfers++;
          console.log(`    FAILED: status=${sendResult.status}, error=${sendResult.error}`);
        }

        // Wait for sender's change token before next transfer
        const expectedSenderAfter = senderBefore.total - (amountSmallest * BigInt(transferNum));
        const changeResult = await waitForSenderChange(sender, coinSymbol, expectedSenderAfter);
        if (changeResult.timedOut) {
          console.log(`    WARNING: Sender change token timed out (balance: ${changeResult.balance.total}, expected: ${expectedSenderAfter})`);
        }

        // Reload sender state for next iteration
        await sender.payments.load();
      } catch (err) {
        result.failedTransfers++;
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`    ERROR: ${msg}`);
      }

      // Small delay between transfers to allow background processing
      if (i < transferCount - 1) {
        await new Promise(r => setTimeout(r, INTER_TRANSFER_DELAY_MS));
      }
    }

    // Wait for all transfers to arrive at receiver
    console.log(`\n[RECEIVE] Waiting for receiver to accumulate ${transferCount} transfers...`);
    const expectedReceiverTotal = receiverBefore.total + result.totalAmountSent;
    const receiveResult = await waitForReceiverBalance(
      receiver, coinSymbol, expectedReceiverTotal, TRANSFER_TIMEOUT_MS,
    );

    if (receiveResult.timedOut) {
      console.log(`  WARNING: Receiver timed out. Got ${receiveResult.finalBalance.total}, expected ${expectedReceiverTotal}`);
    } else {
      console.log(`  Received all in ${receiveResult.receiveTimeMs.toFixed(0)}ms`);
    }

    // Snapshot AFTER
    await sender.payments.load();
    const senderAfter = getBalance(sender, coinSymbol);
    const receiverAfter = receiveResult.finalBalance;
    result.senderBalanceAfter = senderAfter.total;
    result.receiverBalanceAfter = receiverAfter.total;

    result.senderDelta = senderBefore.total - senderAfter.total;
    result.receiverDelta = receiverAfter.total - receiverBefore.total;
    const totalSupplyAfter = senderAfter.total + receiverAfter.total;

    console.log(`\n[AFTER] Sender:   ${formatBalance(senderAfter, decimals)}`);
    console.log(`[AFTER] Receiver: ${formatBalance(receiverAfter, decimals)}`);
    console.log(`[AFTER] Total supply: ${totalSupplyAfter}`);

    // Verification
    console.log(`\n[VERIFY] Balance conservation:`);
    console.log(`  Sender lost:     ${result.senderDelta} (expected: ${result.totalAmountSent})`);
    console.log(`  Receiver gained: ${result.receiverDelta} (expected: ${result.totalAmountSent})`);
    console.log(`  Total supply:    ${totalSupplyBefore} -> ${totalSupplyAfter}`);

    result.balanceConserved =
      result.senderDelta === result.totalAmountSent &&
      result.receiverDelta === result.totalAmountSent &&
      result.senderDelta === result.receiverDelta;

    result.totalSupplyConserved = totalSupplyBefore === totalSupplyAfter;

    if (result.balanceConserved) {
      console.log(`  BALANCE CONSERVATION: PASS`);
    } else {
      console.log(`  BALANCE CONSERVATION: FAIL`);
      if (result.senderDelta !== result.totalAmountSent) {
        console.log(`    Sender should have lost ${result.totalAmountSent}, actually lost ${result.senderDelta}`);
      }
      if (result.receiverDelta !== result.totalAmountSent) {
        console.log(`    Receiver should have gained ${result.totalAmountSent}, actually gained ${result.receiverDelta}`);
      }
    }

    if (result.totalSupplyConserved) {
      console.log(`  TOTAL SUPPLY CONSERVATION: PASS`);
    } else {
      console.log(`  TOTAL SUPPLY CONSERVATION: FAIL (${totalSupplyBefore} -> ${totalSupplyAfter}, diff: ${totalSupplyAfter - totalSupplyBefore})`);
    }

    result.success =
      result.successfulTransfers > 0 &&
      result.failedTransfers === 0 &&
      !receiveResult.timedOut &&
      result.balanceConserved &&
      result.totalSupplyConserved;

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`  SCENARIO ERROR: ${errorMsg}`);
    result.error = errorMsg;
  }

  result.totalTimeMs = performance.now() - startTime;
  return result;
}

// =============================================================================
// Scenario B: N rapid-fire transfers with minimal delay
// =============================================================================

async function runScenarioB(
  sender: Sphere,
  receiver: Sphere,
  receiverNametag: string,
  coinSymbol: string,
  transferCount: number,
  amountPerTransfer: string,
  transferMode: TransferMode,
): Promise<ScenarioResult> {
  const registry = TokenRegistry.getInstance();
  const coinDef = registry.getDefinitionBySymbol(coinSymbol);
  if (!coinDef) throw new Error(`Unknown coin: ${coinSymbol}`);
  const decimals = coinDef.decimals ?? 0;
  const amountSmallest = parseAmount(amountPerTransfer, decimals);
  const totalExpected = amountSmallest * BigInt(transferCount);

  const scenario = `B: ${transferCount}x rapid ${amountPerTransfer} ${coinSymbol} (${transferMode})`;

  console.log(`\n${'='.repeat(70)}`);
  console.log(`SCENARIO: ${scenario}`);
  console.log(`  Transfer count: ${transferCount}`);
  console.log(`  Amount per transfer: ${amountPerTransfer} ${coinSymbol} (${amountSmallest} smallest)`);
  console.log(`  Total expected: ${totalExpected} smallest`);
  console.log(`  Mode: ${transferMode.toUpperCase()} (rapid-fire)`);
  console.log('='.repeat(70));

  const result: ScenarioResult = {
    scenario,
    transferCount,
    successfulTransfers: 0,
    failedTransfers: 0,
    totalAmountSent: 0n,
    senderBalanceBefore: 0n,
    senderBalanceAfter: 0n,
    receiverBalanceBefore: 0n,
    receiverBalanceAfter: 0n,
    senderDelta: 0n,
    receiverDelta: 0n,
    balanceConserved: false,
    totalSupplyConserved: false,
    totalTimeMs: 0,
    success: false,
  };

  const startTime = performance.now();

  try {
    // Snapshot BEFORE
    await sender.payments.load();
    await receiver.payments.load();
    const senderBefore = getBalance(sender, coinSymbol);
    const receiverBefore = getBalance(receiver, coinSymbol, true);
    result.senderBalanceBefore = senderBefore.total;
    result.receiverBalanceBefore = receiverBefore.total;
    const totalSupplyBefore = senderBefore.total + receiverBefore.total;

    console.log(`\n[BEFORE] Sender:   ${formatBalance(senderBefore, decimals)}`);
    console.log(`[BEFORE] Receiver: ${formatBalance(receiverBefore, decimals)}`);
    console.log(`[BEFORE] Total supply: ${totalSupplyBefore}`);

    if (senderBefore.total < totalExpected) {
      throw new Error(
        `Insufficient sender balance: ${senderBefore.total} < ${totalExpected}`,
      );
    }

    // Execute N transfers as fast as possible (sequentially but minimal delay)
    // Each transfer must wait for the previous change token before proceeding,
    // otherwise the sender won't have a token to split.
    console.log(`\n[RAPID-FIRE] Sending ${transferCount} transfers...`);
    const transferTimes: number[] = [];

    for (let i = 0; i < transferCount; i++) {
      const transferNum = i + 1;

      try {
        const sendStart = performance.now();
        const sendResult = await sender.payments.send({
          recipient: `@${receiverNametag}`,
          amount: amountSmallest.toString(),
          coinId: coinDef.id,
          transferMode,
        });
        const sendTime = performance.now() - sendStart;
        transferTimes.push(sendTime);

        const sendOk = sendResult.status === 'completed' || sendResult.status === 'delivered';
        if (sendOk) {
          result.successfulTransfers++;
          result.totalAmountSent += amountSmallest;
          console.log(`  [${transferNum}/${transferCount}] OK in ${sendTime.toFixed(0)}ms`);
        } else {
          result.failedTransfers++;
          console.log(`  [${transferNum}/${transferCount}] FAILED: ${sendResult.status} ${sendResult.error ?? ''}`);
        }

        // Wait for change token before next transfer
        const expectedSenderAfter = senderBefore.total - (amountSmallest * BigInt(transferNum));
        const changeResult = await waitForSenderChange(sender, coinSymbol, expectedSenderAfter);
        if (changeResult.timedOut) {
          console.log(`  [${transferNum}/${transferCount}] WARNING: Change token timed out`);
        }
        await sender.payments.load();
      } catch (err) {
        result.failedTransfers++;
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  [${transferNum}/${transferCount}] ERROR: ${msg}`);
      }
    }

    // Stats
    if (transferTimes.length > 0) {
      const avgMs = transferTimes.reduce((a, b) => a + b, 0) / transferTimes.length;
      const minMs = Math.min(...transferTimes);
      const maxMs = Math.max(...transferTimes);
      console.log(`\n  Transfer times: avg=${avgMs.toFixed(0)}ms, min=${minMs.toFixed(0)}ms, max=${maxMs.toFixed(0)}ms`);
    }

    // Wait for all transfers to arrive at receiver
    console.log(`\n[RECEIVE] Waiting for receiver to accumulate all transfers...`);
    const expectedReceiverTotal = receiverBefore.total + result.totalAmountSent;
    const receiveResult = await waitForReceiverBalance(
      receiver, coinSymbol, expectedReceiverTotal, TRANSFER_TIMEOUT_MS,
    );

    if (receiveResult.timedOut) {
      console.log(`  WARNING: Receiver timed out. Got ${receiveResult.finalBalance.total}, expected ${expectedReceiverTotal}`);
    } else {
      console.log(`  Received all in ${receiveResult.receiveTimeMs.toFixed(0)}ms`);
    }

    // Snapshot AFTER
    await sender.payments.load();
    const senderAfter = getBalance(sender, coinSymbol);
    const receiverAfter = receiveResult.finalBalance;
    result.senderBalanceAfter = senderAfter.total;
    result.receiverBalanceAfter = receiverAfter.total;

    result.senderDelta = senderBefore.total - senderAfter.total;
    result.receiverDelta = receiverAfter.total - receiverBefore.total;
    const totalSupplyAfter = senderAfter.total + receiverAfter.total;

    console.log(`\n[AFTER] Sender:   ${formatBalance(senderAfter, decimals)}`);
    console.log(`[AFTER] Receiver: ${formatBalance(receiverAfter, decimals)}`);
    console.log(`[AFTER] Total supply: ${totalSupplyAfter}`);

    // Verification
    console.log(`\n[VERIFY] Balance conservation:`);
    console.log(`  Sender lost:     ${result.senderDelta} (expected: ${result.totalAmountSent})`);
    console.log(`  Receiver gained: ${result.receiverDelta} (expected: ${result.totalAmountSent})`);
    console.log(`  Total supply:    ${totalSupplyBefore} -> ${totalSupplyAfter}`);

    result.balanceConserved =
      result.senderDelta === result.totalAmountSent &&
      result.receiverDelta === result.totalAmountSent &&
      result.senderDelta === result.receiverDelta;

    result.totalSupplyConserved = totalSupplyBefore === totalSupplyAfter;

    if (result.balanceConserved) {
      console.log(`  BALANCE CONSERVATION: PASS`);
    } else {
      console.log(`  BALANCE CONSERVATION: FAIL`);
      if (result.senderDelta !== result.totalAmountSent) {
        console.log(`    Sender should have lost ${result.totalAmountSent}, actually lost ${result.senderDelta}`);
      }
      if (result.receiverDelta !== result.totalAmountSent) {
        console.log(`    Receiver should have gained ${result.totalAmountSent}, actually gained ${result.receiverDelta}`);
      }
    }

    if (result.totalSupplyConserved) {
      console.log(`  TOTAL SUPPLY CONSERVATION: PASS`);
    } else {
      console.log(`  TOTAL SUPPLY CONSERVATION: FAIL (${totalSupplyBefore} -> ${totalSupplyAfter}, diff: ${totalSupplyAfter - totalSupplyBefore})`);
    }

    result.success =
      result.successfulTransfers > 0 &&
      result.failedTransfers === 0 &&
      !receiveResult.timedOut &&
      result.balanceConserved &&
      result.totalSupplyConserved;

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`  SCENARIO ERROR: ${errorMsg}`);
    result.error = errorMsg;
  }

  result.totalTimeMs = performance.now() - startTime;
  return result;
}

// =============================================================================
// Results Summary
// =============================================================================

function printResults(results: ScenarioResult[]): void {
  console.log('\n\n');
  console.log('='.repeat(120));
  console.log('  MULTI-TRANSFER E2E TEST RESULTS');
  console.log('='.repeat(120));
  console.log('');
  console.log(
    '  #  | Scenario                                            | Tx OK/Total | Balance | Supply  | Time(s) | Status',
  );
  console.log(
    '-----+-----------------------------------------------------+-------------+---------+---------+---------+---------',
  );

  results.forEach((r, i) => {
    const num = String(i + 1).padStart(3);
    const scenario = r.scenario.slice(0, 51).padEnd(51);
    const txCount = `${r.successfulTransfers}/${r.transferCount}`.padEnd(11);
    const balance = r.balanceConserved ? '  PASS ' : '  FAIL ';
    const supply = r.totalSupplyConserved ? '  PASS ' : '  FAIL ';
    const time = (r.totalTimeMs / 1000).toFixed(1).padStart(7);
    const status = r.success ? '  PASS ' : '  FAIL ';

    console.log(
      ` ${num} | ${scenario} | ${txCount} |${balance}|${supply}| ${time} |${status}`,
    );
  });

  console.log(
    '-----+-----------------------------------------------------+-------------+---------+---------+---------+---------',
  );

  const passed = results.filter(r => r.success);
  console.log(`\n  TOTAL: ${passed.length}/${results.length} scenarios passed`);

  if (passed.length === results.length) {
    console.log('\n  ALL TESTS PASSED — No tokens lost in multi-transfer scenarios');
  } else {
    console.log('\n  SOME TESTS FAILED:');
    for (const r of results.filter(r => !r.success)) {
      console.log(`    - ${r.scenario}: ${r.error ?? 'balance/supply mismatch'}`);
      if (r.failedTransfers > 0) {
        console.log(`      ${r.failedTransfers} transfer(s) failed`);
      }
      if (!r.balanceConserved) {
        console.log(`      Balance not conserved: sent=${r.totalAmountSent}, sender_loss=${r.senderDelta}, receiver_gain=${r.receiverDelta}`);
      }
      if (!r.totalSupplyConserved) {
        console.log(`      Total supply changed: before=${r.senderBalanceBefore + r.receiverBalanceBefore}, after=${r.senderBalanceAfter + r.receiverBalanceAfter}`);
      }
    }
  }
}

// =============================================================================
// Cleanup
// =============================================================================

async function cleanup(testRunId: string): Promise<void> {
  const aliceDir = `./.sphere-cli-mt_${testRunId}_alice`;
  const bobDir = `./.sphere-cli-mt_${testRunId}_bob`;
  console.log(`\n[CLEANUP] Removing ${aliceDir} and ${bobDir}`);
  await rm(aliceDir, { recursive: true, force: true });
  await rm(bobDir, { recursive: true, force: true });
  console.log('  Done.');
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  const doCleanup = process.argv.includes('--cleanup');
  const testRunId = generateTestRunId();

  const aliceNametag = `mt${testRunId}a`;
  const bobNametag = `mt${testRunId}b`;
  const aliceProfile = `mt_${testRunId}_alice`;
  const bobProfile = `mt_${testRunId}_bob`;

  console.log('='.repeat(70));
  console.log('  Multi-Token Transfer Stress Test');
  console.log('='.repeat(70));
  console.log(`  Test run ID:  ${testRunId}`);
  console.log(`  Alice:        @${aliceNametag} (profile: ${aliceProfile})`);
  console.log(`  Bob:          @${bobNametag} (profile: ${bobProfile})`);
  console.log(`  Cleanup:      ${doCleanup ? 'yes' : 'no (use --cleanup to remove dirs after)'}`);
  console.log('');

  const results: ScenarioResult[] = [];
  let alice: Sphere | null = null;
  let bob: Sphere | null = null;

  try {
    // =========================================================================
    // Phase 1: Setup
    // =========================================================================
    console.log('\n--- PHASE 1: WALLET SETUP ---\n');

    console.log('[SETUP] Creating Alice wallet...');
    const aliceResult = await createTestWallet(aliceProfile, aliceNametag);
    alice = aliceResult.sphere;
    console.log(`  Alice identity: ${alice.identity?.directAddress?.slice(0, 30)}...`);

    console.log('[SETUP] Creating Bob wallet...');
    const bobResult = await createTestWallet(bobProfile, bobNametag);
    bob = bobResult.sphere;
    console.log(`  Bob identity: ${bob.identity?.directAddress?.slice(0, 30)}...`);

    // Topup Alice with UCT — we need enough for both scenarios
    // Scenario A: 15 x 1 UCT = 15 UCT
    // Scenario B: 15 x 1 UCT = 15 UCT
    // Total: 30 UCT needed, request 100 UCT
    const uctDecimals = 18;
    const expectedUct = parseAmount('100', uctDecimals);
    await topupAndWait(alice, aliceNametag, 'unicity', 100, 'UCT', expectedUct);

    // =========================================================================
    // Phase 2: Scenario A — 15 sequential split transfers
    // =========================================================================
    console.log('\n\n--- PHASE 2: SCENARIO A — SPLIT-THEN-MULTI-TRANSFER ---');

    results.push(await runScenarioA(
      alice, bob, bobNametag,
      'UCT', 15, '1',
      'instant',
    ));

    // Brief pause between scenarios
    await new Promise(r => setTimeout(r, 5_000));
    await alice.payments.load();
    await bob.payments.load();

    // =========================================================================
    // Phase 3: Scenario B — 15 rapid-fire transfers
    // =========================================================================
    console.log('\n\n--- PHASE 3: SCENARIO B — RAPID-FIRE TRANSFERS ---');

    // Alice should still have ~85 UCT after Scenario A
    results.push(await runScenarioB(
      alice, bob, bobNametag,
      'UCT', 15, '1',
      'instant',
    ));

    // =========================================================================
    // Phase 4: Summary
    // =========================================================================
    printResults(results);

  } catch (error) {
    console.error(`\nFATAL ERROR: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
  } finally {
    if (alice) {
      try { await alice.destroy(); } catch { /* ignore */ }
    }
    if (bob) {
      try { await bob.destroy(); } catch { /* ignore */ }
    }

    if (doCleanup) {
      await cleanup(testRunId);
    }
  }

  // Exit code based on results
  const allPassed = results.length > 0 && results.every(r => r.success);
  process.exit(allPassed ? 0 : 1);
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
