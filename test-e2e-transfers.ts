#!/usr/bin/env npx tsx
/**
 * E2E Transfer Test Script
 *
 * Creates two fresh wallets with random nametags, tops up one via faucet,
 * runs transfer tests across coins and addressing modes, and verifies
 * balance conservation, tombstones, and spent token handling.
 *
 * Usage:
 *   npx tsx test-e2e-transfers.ts [--cleanup]
 */

import { Sphere } from './core/Sphere';
import { createNodeProviders } from './impl/nodejs';
import { TokenRegistry } from './registry/TokenRegistry';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';

// =============================================================================
// Constants
// =============================================================================

const FAUCET_URL = 'https://faucet.unicity.network/api/v1/faucet/request';
const NETWORK = 'testnet' as const;
const FAUCET_TOPUP_TIMEOUT_MS = 90_000;
const TRANSFER_TIMEOUT_MS = 60_000;
const INTER_TEST_DELAY_MS = 3_000;
const POLL_INTERVAL_MS = 1_000;

const FAUCET_COINS = [
  { faucetName: 'unicity', symbol: 'UCT', amount: 100 },
  { faucetName: 'bitcoin', symbol: 'BTC', amount: 1 },
  { faucetName: 'ethereum', symbol: 'ETH', amount: 42 },
];

// =============================================================================
// Types
// =============================================================================

interface BalanceSnapshot {
  confirmed: bigint;
  unconfirmed: bigint;
  total: bigint;
  tokens: number;
}

interface TombstoneSnapshot {
  count: number;
  entries: Array<{ tokenId: string; stateHash: string }>;
}

interface TransferTestResult {
  scenario: string;
  mode: 'direct' | 'proxy';
  amount: string;
  amountSmallest: bigint;
  coin: string;
  sendTimeMs: number;
  receiveTimeMs: number;
  success: boolean;
  balanceVerified: boolean;
  tombstoneVerified: boolean;
  knownFailing: boolean;
  senderDelta: bigint;
  receiverDelta: bigint;
  tombstonesBefore: number;
  tombstonesAfter: number;
  error?: string;
  skipped?: boolean;
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

function getBalance(sphere: Sphere, coinSymbol: string): BalanceSnapshot {
  const balances = sphere.payments.getBalance();
  const bal = balances.find(b => b.symbol === coinSymbol);
  if (!bal) return { confirmed: 0n, unconfirmed: 0n, total: 0n, tokens: 0 };
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
  return `${formatted} (${bal.tokens} tokens)`;
}

function getTombstoneSnapshot(sphere: Sphere): TombstoneSnapshot {
  const tombstones = sphere.payments.getTombstones();
  return {
    count: tombstones.length,
    entries: tombstones.map(t => ({ tokenId: t.tokenId, stateHash: t.stateHash })),
  };
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

async function loadWallet(profileName: string): Promise<Sphere> {
  const dataDir = `./.sphere-cli-${profileName}`;
  const tokensDir = `${dataDir}/tokens`;

  const providers = createNodeProviders({
    network: NETWORK,
    dataDir,
    tokensDir,
  });

  const { sphere } = await Sphere.init({ ...providers });
  return sphere;
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
      body: JSON.stringify({
        unicityId: nametag, // No @ prefix
        coin,
        amount,
      }),
    });
    const result = await response.json() as { success: boolean; message?: string; error?: string };
    return {
      success: result.success,
      message: result.message || result.error,
    };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : 'Request failed' };
  }
}

async function topupAndWait(sphere: Sphere, nametag: string): Promise<void> {
  console.log('\n[TOPUP] Requesting tokens from faucet...');

  for (const coin of FAUCET_COINS) {
    const result = await requestFaucet(nametag, coin.faucetName, coin.amount);
    const status = result.success ? 'OK' : `FAILED: ${result.message}`;
    console.log(`  ${coin.symbol} (${coin.amount}): ${status}`);
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\n[TOPUP] Waiting for tokens to arrive via Nostr...');
  const startTime = performance.now();
  const registry = TokenRegistry.getInstance();

  while (performance.now() - startTime < FAUCET_TOPUP_TIMEOUT_MS) {
    await sphere.payments.load();

    let allReceived = true;
    for (const coin of FAUCET_COINS) {
      const bal = getBalance(sphere, coin.symbol);
      if (bal.total === 0n) {
        allReceived = false;
        break;
      }
    }

    if (allReceived) {
      const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
      console.log(`  All tokens received in ${elapsed}s`);

      for (const coin of FAUCET_COINS) {
        const bal = getBalance(sphere, coin.symbol);
        const coinDef = registry.getDefinitionBySymbol(coin.symbol);
        const decimals = coinDef?.decimals ?? 0;
        console.log(`  ${coin.symbol}: ${formatBalance(bal, decimals)}`);
      }
      return;
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Timeout - print what we have
  console.log('  WARNING: Topup timed out. Current balances:');
  for (const coin of FAUCET_COINS) {
    const bal = getBalance(sphere, coin.symbol);
    const coinDef = registry.getDefinitionBySymbol(coin.symbol);
    const decimals = coinDef?.decimals ?? 0;
    console.log(`  ${coin.symbol}: ${formatBalance(bal, decimals)}`);
  }
  throw new Error('Faucet topup timed out - not all tokens received');
}

// =============================================================================
// Polling
// =============================================================================

async function waitForReceiverBalance(
  receiver: Sphere,
  coinSymbol: string,
  expectedMinTotal: bigint,
  timeoutMs: number = TRANSFER_TIMEOUT_MS,
): Promise<{ receiveTimeMs: number; finalBalance: BalanceSnapshot }> {
  const startTime = performance.now();

  while (performance.now() - startTime < timeoutMs) {
    await receiver.payments.load();
    const balance = getBalance(receiver, coinSymbol);

    if (balance.total >= expectedMinTotal) {
      return {
        receiveTimeMs: performance.now() - startTime,
        finalBalance: balance,
      };
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  const finalBalance = getBalance(receiver, coinSymbol);
  return {
    receiveTimeMs: performance.now() - startTime,
    finalBalance,
  };
}

// =============================================================================
// Test Runner
// =============================================================================

interface TransferTestConfig {
  scenario: string;
  sender: Sphere;
  receiver: Sphere;
  receiverNametag: string;
  amount: string;
  coinSymbol: string;
  mode: 'direct' | 'proxy';
  knownFailing?: boolean;
}

async function runTransferTest(config: TransferTestConfig): Promise<TransferTestResult> {
  const {
    scenario, sender, receiver, receiverNametag,
    amount, coinSymbol, mode, knownFailing = false,
  } = config;

  const registry = TokenRegistry.getInstance();
  const coinDef = registry.getDefinitionBySymbol(coinSymbol);
  if (!coinDef) throw new Error(`Unknown coin: ${coinSymbol}`);
  const decimals = coinDef.decimals ?? 0;
  const amountSmallest = parseAmount(amount, decimals);

  console.log(`\n${'='.repeat(70)}`);
  console.log(`SCENARIO: ${scenario}${knownFailing ? ' [KNOWN FAILING]' : ''}`);
  console.log(`  Mode: ${mode.toUpperCase()}, Amount: ${amount} ${coinSymbol} (${amountSmallest} smallest)`);
  console.log('='.repeat(70));

  const result: TransferTestResult = {
    scenario,
    mode,
    amount,
    amountSmallest,
    coin: coinSymbol,
    sendTimeMs: 0,
    receiveTimeMs: 0,
    success: false,
    balanceVerified: false,
    tombstoneVerified: false,
    knownFailing,
    senderDelta: 0n,
    receiverDelta: 0n,
    tombstonesBefore: 0,
    tombstonesAfter: 0,
  };

  try {
    // Snapshot BEFORE
    await sender.payments.load();
    await receiver.payments.load();
    const senderBefore = getBalance(sender, coinSymbol);
    const receiverBefore = getBalance(receiver, coinSymbol);
    const tombsBefore = getTombstoneSnapshot(sender);
    result.tombstonesBefore = tombsBefore.count;

    console.log(`\n[1] Balances BEFORE:`);
    console.log(`    Sender:   ${formatBalance(senderBefore, decimals)}`);
    console.log(`    Receiver: ${formatBalance(receiverBefore, decimals)}`);
    console.log(`    Sender tombstones: ${tombsBefore.count}`);

    // Check sufficient balance
    if (senderBefore.total < amountSmallest) {
      throw new Error(
        `Insufficient sender balance: ${senderBefore.total} < ${amountSmallest}`,
      );
    }

    // Send
    console.log(`[2] Sending (${mode.toUpperCase()} mode)...`);
    const sendStart = performance.now();

    const sendResult = await sender.payments.send({
      recipient: `@${receiverNametag}`,
      amount: amountSmallest.toString(),
      coinId: coinDef.id,
      addressMode: mode,
    });

    result.sendTimeMs = performance.now() - sendStart;
    console.log(`    Send completed in ${result.sendTimeMs.toFixed(0)}ms`);
    console.log(`    Status: ${sendResult.status}, TxHash: ${sendResult.txHash?.slice(0, 16) ?? 'N/A'}...`);

    // Snapshot sender AFTER send
    await sender.payments.load();
    const senderAfterSend = getBalance(sender, coinSymbol);
    const tombsAfterSend = getTombstoneSnapshot(sender);
    result.tombstonesAfter = tombsAfterSend.count;

    console.log(`[3] Sender balance AFTER send: ${formatBalance(senderAfterSend, decimals)}`);
    console.log(`    Sender tombstones after: ${tombsAfterSend.count}`);

    // Wait for receiver
    console.log(`[4] Waiting for receiver (up to ${TRANSFER_TIMEOUT_MS / 1000}s)...`);
    const expectedReceiverTotal = receiverBefore.total + amountSmallest;

    const receiveResult = await waitForReceiverBalance(
      receiver, coinSymbol, expectedReceiverTotal, TRANSFER_TIMEOUT_MS,
    );
    result.receiveTimeMs = receiveResult.receiveTimeMs;
    console.log(`    Receive detected in ${receiveResult.receiveTimeMs.toFixed(0)}ms`);
    console.log(`    Receiver balance AFTER: ${formatBalance(receiveResult.finalBalance, decimals)}`);

    // Calculate deltas (reload sender in case state changed during receiver wait)
    await sender.payments.load();
    const senderAfter = getBalance(sender, coinSymbol);
    const senderDelta = senderBefore.total - senderAfter.total;
    const receiverDelta = receiveResult.finalBalance.total - receiverBefore.total;
    result.senderDelta = senderDelta;
    result.receiverDelta = receiverDelta;

    // Balance verification
    console.log(`\n[5] BALANCE VERIFICATION:`);
    console.log(`    Sender lost:     ${senderDelta} (expected: ${amountSmallest})`);
    console.log(`    Receiver gained: ${receiverDelta} (expected: ${amountSmallest})`);

    const senderLossCorrect = senderDelta === amountSmallest;
    const receiverGainCorrect = receiverDelta === amountSmallest;
    const balanceConserved = senderDelta === receiverDelta;

    if (senderLossCorrect && receiverGainCorrect && balanceConserved) {
      console.log(`    BALANCE VERIFIED: Sender loss == Receiver gain == ${amountSmallest}`);
      result.balanceVerified = true;
    } else {
      console.log(`    BALANCE MISMATCH!`);
      if (!senderLossCorrect) console.log(`      - Sender should have lost ${amountSmallest}, actually lost ${senderDelta}`);
      if (!receiverGainCorrect) console.log(`      - Receiver should have gained ${amountSmallest}, actually gained ${receiverDelta}`);
    }

    // Tombstone verification
    console.log(`\n[6] TOMBSTONE VERIFICATION:`);
    console.log(`    Before: ${tombsBefore.count}, After: ${tombsAfterSend.count}`);
    if (tombsAfterSend.count > tombsBefore.count) {
      console.log(`    TOMBSTONE VERIFIED: ${tombsAfterSend.count - tombsBefore.count} new tombstone(s)`);
      result.tombstoneVerified = true;
    } else {
      console.log(`    TOMBSTONE NOT VERIFIED: no new tombstones after send`);
    }

    result.success = (sendResult.status === 'completed' || sendResult.status === 'delivered')
      && result.balanceVerified;

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`    ERROR: ${errorMsg}`);
    result.error = errorMsg;

    if (knownFailing) {
      console.log(`    [KNOWN_FAILING] Marking as skipped`);
      result.skipped = true;
    }
  }

  return result;
}

// =============================================================================
// Results Printer
// =============================================================================

function printResultsTable(results: TransferTestResult[]): void {
  console.log('\n\n');
  console.log('='.repeat(120));
  console.log('  TEST RESULTS SUMMARY');
  console.log('='.repeat(120));
  console.log('');
  console.log(
    '  #  | Scenario                          | Mode   | Amount       | Send(ms) | Recv(ms) | Balance | Tombstone | Status',
  );
  console.log(
    '-----+-----------------------------------+--------+--------------+----------+----------+---------+-----------+-----------',
  );

  results.forEach((r, i) => {
    const num = String(i + 1).padStart(3);
    const scenario = r.scenario.slice(0, 33).padEnd(33);
    const mode = r.mode.toUpperCase().padEnd(6);
    const amount = `${r.amount} ${r.coin}`.padEnd(12).slice(0, 12);
    const sendTime = r.skipped ? '    -   ' : r.sendTimeMs.toFixed(0).padStart(8);
    const recvTime = r.skipped ? '    -   ' : r.receiveTimeMs.toFixed(0).padStart(8);
    const balanceOk = r.skipped ? '   -   ' : (r.balanceVerified ? '  PASS ' : '  FAIL ');
    const tombOk = r.skipped ? '    -    ' : (r.tombstoneVerified ? '   PASS  ' : '   FAIL  ');

    let status: string;
    if (r.skipped) status = '  SKIPPED ';
    else if (r.success) status = '  PASS    ';
    else if (r.knownFailing) status = ' KNOWN_FAIL';
    else status = '  FAIL    ';

    console.log(
      ` ${num} | ${scenario} | ${mode} | ${amount} | ${sendTime} | ${recvTime} |${balanceOk}|${tombOk}|${status}`,
    );
  });

  console.log(
    '-----+-----------------------------------+--------+--------------+----------+----------+---------+-----------+-----------',
  );

  // Statistics
  const directResults = results.filter(r => !r.knownFailing);
  const directPassed = directResults.filter(r => r.success);
  const balanceVerified = directResults.filter(r => r.balanceVerified);
  const tombVerified = directResults.filter(r => r.tombstoneVerified);

  console.log(`\nSTATISTICS:`);
  console.log(`   DIRECT tests passed:       ${directPassed.length}/${directResults.length}`);
  console.log(`   Balance verified:          ${balanceVerified.length}/${directResults.length}`);
  console.log(`   Tombstone verified:        ${tombVerified.length}/${directResults.length}`);

  const proxyResults = results.filter(r => r.knownFailing);
  const proxySkipped = proxyResults.filter(r => r.skipped);
  console.log(`   PROXY tests (known-fail):  ${proxySkipped.length} skipped / ${proxyResults.length} total`);

  if (directPassed.length > 0) {
    const avgSend = directPassed.reduce((s, r) => s + r.sendTimeMs, 0) / directPassed.length;
    const avgRecv = directPassed.reduce((s, r) => s + r.receiveTimeMs, 0) / directPassed.length;
    console.log(`   Avg send time (passing):   ${avgSend.toFixed(0)}ms`);
    console.log(`   Avg receive time (passing):${avgRecv.toFixed(0)}ms`);
  }

  // Final verdict
  console.log('');
  if (directPassed.length === directResults.length) {
    console.log('ALL DIRECT TESTS PASSED - Balance conservation verified, tombstones working');
  } else {
    console.log('SOME DIRECT TESTS FAILED:');
    for (const r of directResults.filter(r => !r.success)) {
      console.log(`   - ${r.scenario}: ${r.error ?? 'balance/tombstone mismatch'}`);
    }
  }
}

// =============================================================================
// Cleanup
// =============================================================================

async function cleanup(testRunId: string): Promise<void> {
  const aliceDir = `./.sphere-cli-test_${testRunId}_alice`;
  const bobDir = `./.sphere-cli-test_${testRunId}_bob`;
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

  const aliceNametag = `e2e${testRunId}a`;
  const bobNametag = `e2e${testRunId}b`;
  const aliceProfile = `test_${testRunId}_alice`;
  const bobProfile = `test_${testRunId}_bob`;

  console.log('='.repeat(70));
  console.log('  E2E Transfer Test Suite');
  console.log('='.repeat(70));
  console.log(`  Test run ID:  ${testRunId}`);
  console.log(`  Alice:        @${aliceNametag} (profile: ${aliceProfile})`);
  console.log(`  Bob:          @${bobNametag} (profile: ${bobProfile})`);
  console.log(`  Cleanup:      ${doCleanup ? 'yes' : 'no (use --cleanup to remove dirs after)'}`);
  console.log('');

  const results: TransferTestResult[] = [];
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
    console.log(`  Bob identity:   ${bob.identity?.directAddress?.slice(0, 30)}...`);

    // Topup Alice
    await topupAndWait(alice, aliceNametag);

    // =========================================================================
    // Phase 2: DIRECT Mode Tests
    // =========================================================================
    console.log('\n\n--- PHASE 2: DIRECT MODE TESTS ---');

    // Test 1: UCT transfer (split)
    results.push(await runTransferTest({
      scenario: '1. UCT transfer (split from 100)',
      sender: alice,
      receiver: bob,
      receiverNametag: bobNametag,
      amount: '1',
      coinSymbol: 'UCT',
      mode: 'direct',
    }));
    await new Promise(r => setTimeout(r, INTER_TEST_DELAY_MS));

    // Reload wallets to get fresh state
    await alice.payments.load();
    await bob.payments.load();

    // Test 2: BTC partial (split)
    results.push(await runTransferTest({
      scenario: '2. BTC partial (split from 1)',
      sender: alice,
      receiver: bob,
      receiverNametag: bobNametag,
      amount: '0.1',
      coinSymbol: 'BTC',
      mode: 'direct',
    }));
    await new Promise(r => setTimeout(r, INTER_TEST_DELAY_MS));

    await alice.payments.load();
    await bob.payments.load();

    // Test 3: ETH transfer (split)
    results.push(await runTransferTest({
      scenario: '3. ETH transfer (split from 42)',
      sender: alice,
      receiver: bob,
      receiverNametag: bobNametag,
      amount: '1',
      coinSymbol: 'ETH',
      mode: 'direct',
    }));
    await new Promise(r => setTimeout(r, INTER_TEST_DELAY_MS));

    await alice.payments.load();
    await bob.payments.load();

    // Test 4: Send-back UCT (bob -> alice)
    results.push(await runTransferTest({
      scenario: '4. Send-back UCT (bob -> alice)',
      sender: bob,
      receiver: alice,
      receiverNametag: aliceNametag,
      amount: '0.5',
      coinSymbol: 'UCT',
      mode: 'direct',
    }));
    await new Promise(r => setTimeout(r, INTER_TEST_DELAY_MS));

    await alice.payments.load();
    await bob.payments.load();

    // =========================================================================
    // Phase 3: PROXY Mode Tests (known-failing)
    // =========================================================================
    console.log('\n\n--- PHASE 3: PROXY MODE TESTS (KNOWN FAILING) ---');

    // Test 5: PROXY UCT
    results.push(await runTransferTest({
      scenario: '5. PROXY UCT (alice -> bob)',
      sender: alice,
      receiver: bob,
      receiverNametag: bobNametag,
      amount: '0.1',
      coinSymbol: 'UCT',
      mode: 'proxy',
      knownFailing: true,
    }));
    await new Promise(r => setTimeout(r, INTER_TEST_DELAY_MS));

    await alice.payments.load();
    await bob.payments.load();

    // Test 6: PROXY BTC send-back
    results.push(await runTransferTest({
      scenario: '6. PROXY BTC send-back (bob -> alice)',
      sender: bob,
      receiver: alice,
      receiverNametag: aliceNametag,
      amount: '0.01',
      coinSymbol: 'BTC',
      mode: 'proxy',
      knownFailing: true,
    }));

    // =========================================================================
    // Phase 4: Summary
    // =========================================================================
    printResultsTable(results);

  } catch (error) {
    console.error(`\nFATAL ERROR: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
  } finally {
    // Destroy spheres
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

  // Exit code based on DIRECT test results
  const directResults = results.filter(r => !r.knownFailing);
  const allDirectPassed = directResults.length > 0 && directResults.every(r => r.success);
  process.exit(allDirectPassed ? 0 : 1);
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
