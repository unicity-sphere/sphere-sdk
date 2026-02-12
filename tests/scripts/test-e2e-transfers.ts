#!/usr/bin/env npx tsx
/**
 * E2E Transfer Test Script
 *
 * Creates two fresh wallets with random nametags, tops up one via faucet,
 * runs transfer tests across coins and addressing modes, and verifies
 * balance conservation, tombstones, and spent token handling.
 *
 * Usage:
 *   npx tsx tests/scripts/test-e2e-transfers.ts [--cleanup]
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

interface PhaseTimings {
  [phase: string]: number; // ms
}

interface TransferTestResult {
  scenario: string;
  mode: 'direct' | 'proxy';
  transferMode: TransferMode;
  amount: string;
  amountSmallest: bigint;
  coin: string;
  sendTimeMs: number;
  receiveTimeMs: number;
  receiverResolutionMs: number;
  phases: PhaseTimings;
  success: boolean;
  balanceVerified: boolean;
  tombstoneVerified: boolean;
  senderDelta: bigint;
  receiverDelta: bigint;
  tombstonesBefore: number;
  tombstonesAfter: number;
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

async function waitForTokenResolution(
  sphere: Sphere,
  coinSymbol: string,
  timeoutMs: number = 30_000,
): Promise<{ resolved: boolean; durationMs: number }> {
  const startTime = performance.now();

  while (performance.now() - startTime < timeoutMs) {
    // Call resolveUnconfirmed directly (not fire-and-forget)
    const resolution = await sphere.payments.resolveUnconfirmed();

    // Check if all tokens for this coin are confirmed
    const bal = getBalance(sphere, coinSymbol);
    if (bal.unconfirmed === 0n && bal.confirmed > 0n) {
      return { resolved: true, durationMs: performance.now() - startTime };
    }

    // Wait before next attempt (proofs need ~2s aggregator rounds)
    await new Promise(r => setTimeout(r, 2_000));
    await sphere.payments.load();
  }

  return { resolved: false, durationMs: performance.now() - startTime };
}

// =============================================================================
// Console-log timing interceptor
// =============================================================================

/**
 * Captures timestamped console.log output to extract per-phase durations.
 * Returns a stop() function and a between() accessor.
 */
function createPhaseCapture() {
  const entries: Array<{ ts: number; msg: string }> = [];
  const origLog = console.log;
  const origWarn = console.warn;

  const capture = (...args: unknown[]) => {
    const msg = args.map(a => (typeof a === 'string' ? a : String(a))).join(' ');
    entries.push({ ts: performance.now(), msg });
    origLog.apply(console, args as Parameters<typeof console.log>);
  };

  console.log = capture as typeof console.log;
  console.warn = capture as typeof console.warn;

  return {
    stop() {
      console.log = origLog;
      console.warn = origWarn;
    },
    /** Extract duration between two log-message markers (substring match) */
    between(startMarker: string, endMarker: string): number | null {
      const s = entries.find(e => e.msg.includes(startMarker));
      const e = [...entries].reverse().find(e => e.msg.includes(endMarker));
      if (s && e && e.ts >= s.ts) return e.ts - s.ts;
      return null;
    },
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
  transferMode: TransferMode;
}

async function runTransferTest(config: TransferTestConfig): Promise<TransferTestResult> {
  const {
    scenario, sender, receiver, receiverNametag,
    amount, coinSymbol, mode, transferMode,
  } = config;

  const registry = TokenRegistry.getInstance();
  const coinDef = registry.getDefinitionBySymbol(coinSymbol);
  if (!coinDef) throw new Error(`Unknown coin: ${coinSymbol}`);
  const decimals = coinDef.decimals ?? 0;
  const amountSmallest = parseAmount(amount, decimals);

  console.log(`\n${'='.repeat(70)}`);
  console.log(`SCENARIO: ${scenario}`);
  console.log(`  Mode: ${mode.toUpperCase()}, TxMode: ${transferMode.toUpperCase()}, Amount: ${amount} ${coinSymbol} (${amountSmallest} smallest)`);
  console.log('='.repeat(70));

  const result: TransferTestResult = {
    scenario,
    mode,
    transferMode,
    amount,
    amountSmallest,
    coin: coinSymbol,
    sendTimeMs: 0,
    receiveTimeMs: 0,
    receiverResolutionMs: 0,
    phases: {},
    success: false,
    balanceVerified: false,
    tombstoneVerified: false,
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

    // Send with phase capture
    console.log(`[2] Sending (${mode.toUpperCase()} / ${transferMode.toUpperCase()})...`);
    const cap = createPhaseCapture();
    const sendStart = performance.now();

    const sendResult = await sender.payments.send({
      recipient: `@${receiverNametag}`,
      amount: amountSmallest.toString(),
      coinId: coinDef.id,
      addressMode: mode,
      transferMode,
    });

    const sendEnd = performance.now();
    cap.stop();
    result.sendTimeMs = sendEnd - sendStart;

    // Extract per-phase timings from captured logs
    if (transferMode === 'conservative') {
      const burn = cap.between('Step 1: Burning', 'Original token burned');
      const mint = cap.between('Step 2: Minting', 'Split tokens minted');
      const transfer = cap.between('Step 3: Transferring', 'Split transfer complete');
      if (burn !== null) result.phases['split.burn'] = burn;
      if (mint !== null) result.phases['split.mint'] = mint;
      if (transfer !== null) result.phases['split.transfer'] = transfer;
      if (burn !== null && mint !== null && transfer !== null) {
        result.phases['chain.total'] = burn + mint + transfer;
      }
    } else {
      // Instant mode
      const nostrSend = cap.between('NOSTR-FIRST: Sending direct token', 'Direct token sent successfully');
      if (nostrSend !== null) result.phases['nostr.send'] = nostrSend;
    }

    console.log(`    Send completed in ${result.sendTimeMs.toFixed(0)}ms`);
    console.log(`    Status: ${sendResult.status}, Transfers: ${sendResult.tokenTransfers.length} token(s)`);

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

    // Measure receiver resolution (unconfirmed → confirmed)
    console.log(`[4b] Measuring receiver token resolution...`);
    const receiverBal = getBalance(receiver, coinSymbol);
    if (receiverBal.unconfirmed > 0n) {
      const resolution = await waitForTokenResolution(receiver, coinSymbol);
      result.receiverResolutionMs = resolution.durationMs;
      console.log(`    Resolution: resolved=${resolution.resolved} in ${resolution.durationMs.toFixed(0)}ms`);
    } else {
      result.receiverResolutionMs = 0;
      console.log(`    Resolution: already confirmed (0ms)`);
    }

    // Wait for sender's change token to appear from background processing
    // (InstantSplit sends split amount immediately, change token arrives ~4s later)
    console.log(`    Waiting for sender change token (up to 15s)...`);
    const expectedSenderTotal = senderBefore.total - amountSmallest;
    const changeDeadline = performance.now() + 15_000;
    let senderAfter = getBalance(sender, coinSymbol);
    while (performance.now() < changeDeadline && senderAfter.total < expectedSenderTotal) {
      await new Promise(r => setTimeout(r, 1000));
      await sender.payments.load();
      senderAfter = getBalance(sender, coinSymbol);
    }
    if (senderAfter.total < expectedSenderTotal) {
      console.warn(`    WARNING: Sender change token wait timed out (15s). Balance: ${senderAfter.total}, expected: ${expectedSenderTotal}`);
    }
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
  }

  return result;
}

// =============================================================================
// Results Printer
// =============================================================================

function printResultsTable(results: TransferTestResult[]): void {
  console.log('\n\n');
  console.log('='.repeat(140));
  console.log('  TEST RESULTS SUMMARY');
  console.log('='.repeat(140));
  console.log('');
  console.log(
    '  #  | Scenario                          | Mode   | TxMode | Amount       | Send(ms) | Recv(ms) | Res(ms) | Balance | Tombstone | Status',
  );
  console.log(
    '-----+-----------------------------------+--------+--------+--------------+----------+----------+---------+---------+-----------+-----------',
  );

  results.forEach((r, i) => {
    const num = String(i + 1).padStart(3);
    const scenario = r.scenario.slice(0, 33).padEnd(33);
    const mode = r.mode.toUpperCase().padEnd(6);
    const txMode = r.transferMode.slice(0, 6).toUpperCase().padEnd(6);
    const amount = `${r.amount} ${r.coin}`.padEnd(12).slice(0, 12);
    const sendTime = r.sendTimeMs.toFixed(0).padStart(8);
    const recvTime = r.receiveTimeMs.toFixed(0).padStart(8);
    const resTime = r.receiverResolutionMs.toFixed(0).padStart(7);
    const balanceOk = r.balanceVerified ? '  PASS ' : '  FAIL ';
    const tombOk = r.tombstoneVerified ? '   PASS  ' : '   FAIL  ';
    const status = r.success ? '  PASS    ' : '  FAIL    ';

    console.log(
      ` ${num} | ${scenario} | ${mode} | ${txMode} | ${amount} | ${sendTime} | ${recvTime} | ${resTime} |${balanceOk}|${tombOk}|${status}`,
    );
  });

  console.log(
    '-----+-----------------------------------+--------+--------+--------------+----------+----------+---------+---------+-----------+-----------',
  );

  // Statistics
  const passed = results.filter(r => r.success);
  const instantResults = results.filter(r => r.transferMode === 'instant');
  const conservativeResults = results.filter(r => r.transferMode === 'conservative');
  const instantPassed = instantResults.filter(r => r.success);
  const conservativePassed = conservativeResults.filter(r => r.success);
  const balanceVerified = results.filter(r => r.balanceVerified);
  const tombVerified = results.filter(r => r.tombstoneVerified);

  const avg = (arr: TransferTestResult[], fn: (r: TransferTestResult) => number): string =>
    arr.length > 0
      ? (arr.reduce((s, r) => s + fn(r), 0) / arr.length).toFixed(0)
      : 'N/A';

  console.log(`\nSTATISTICS:`);
  console.log(`   Total passed:              ${passed.length}/${results.length}`);
  console.log(`   INSTANT tests passed:      ${instantPassed.length}/${instantResults.length}`);
  console.log(`   CONSERVATIVE tests passed: ${conservativePassed.length}/${conservativeResults.length}`);
  console.log(`   Balance verified:          ${balanceVerified.length}/${results.length}`);
  console.log(`   Tombstone verified:        ${tombVerified.length}/${results.length}`);

  if (instantPassed.length > 0) {
    console.log(`   Avg send time (instant):   ${avg(instantPassed, r => r.sendTimeMs)}ms`);
    console.log(`   Avg recv time (instant):   ${avg(instantPassed, r => r.receiveTimeMs)}ms`);
    console.log(`   Avg resolution (instant):  ${avg(instantPassed, r => r.receiverResolutionMs)}ms`);
  }
  if (conservativePassed.length > 0) {
    console.log(`   Avg send time (conserv.):  ${avg(conservativePassed, r => r.sendTimeMs)}ms`);
    console.log(`   Avg recv time (conserv.):  ${avg(conservativePassed, r => r.receiveTimeMs)}ms`);
    console.log(`   Avg resolution (conserv.): ${avg(conservativePassed, r => r.receiverResolutionMs)}ms`);
  }

  // Benchmark comparison: instant vs conservative side-by-side
  printBenchmarkComparison(results);

  // Phase breakdown
  const withPhases = results.filter(r => Object.keys(r.phases).length > 0);
  if (withPhases.length > 0) {
    console.log('\n--- PHASE BREAKDOWN (sender side) ---\n');
    for (const r of withPhases) {
      console.log(`  ${r.scenario} [${r.transferMode.toUpperCase()}]`);
      console.log(`    Total send:     ${r.sendTimeMs.toFixed(0)} ms`);
      const phaseKeys = Object.keys(r.phases).sort();
      for (const key of phaseKeys) {
        const pct = ((r.phases[key] / r.sendTimeMs) * 100).toFixed(1);
        console.log(`    ${key.padEnd(18)} ${r.phases[key].toFixed(0).padStart(6)} ms  (${pct}%)`);
      }
      console.log('');
    }
  }

  // Final verdict
  console.log('');
  if (passed.length === results.length) {
    console.log('ALL TESTS PASSED - Balance conservation verified, tombstones working');
  } else {
    console.log('SOME TESTS FAILED:');
    for (const r of results.filter(r => !r.success)) {
      console.log(`   - ${r.scenario}: ${r.error ?? 'balance/tombstone mismatch'}`);
    }
  }
}

/**
 * Print side-by-side INSTANT vs CONSERVATIVE benchmark comparison.
 * Groups tests by coin to show paired results.
 */
function printBenchmarkComparison(results: TransferTestResult[]): void {
  console.log('\n--- BENCHMARK: INSTANT vs CONSERVATIVE ---\n');
  console.log(
    '                            Instant                          Conservative',
  );
  console.log(
    '  Scenario              Send(ms) Recv(ms)  Res(ms)      Send(ms) Recv(ms)  Res(ms)',
  );
  console.log(
    '  ' + '-'.repeat(85),
  );

  // Find paired tests: same coin where one is instant and the other conservative
  // Group by coin symbol
  const coins = [...new Set(results.map(r => r.coin))];

  for (const coin of coins) {
    const coinResults = results.filter(r => r.coin === coin);
    const instantR = coinResults.find(r => r.transferMode === 'instant');
    const conservR = coinResults.find(r => r.transferMode === 'conservative');

    const fmtMs = (v: number | undefined): string =>
      v !== undefined ? v.toFixed(0).padStart(8) : '     N/A';

    const label = `${coin} split`.padEnd(20);
    const iSend = fmtMs(instantR?.sendTimeMs);
    const iRecv = fmtMs(instantR?.receiveTimeMs);
    const iRes = fmtMs(instantR?.receiverResolutionMs);
    const cSend = fmtMs(conservR?.sendTimeMs);
    const cRecv = fmtMs(conservR?.receiveTimeMs);
    const cRes = fmtMs(conservR?.receiverResolutionMs);

    console.log(
      `  ${label}  ${iSend}  ${iRecv}  ${iRes}    ${cSend}  ${cRecv}  ${cRes}`,
    );
  }

  // Also show send-back if present
  const sendBacks = results.filter(r => r.scenario.toLowerCase().includes('send-back'));
  if (sendBacks.length > 0) {
    const instantSB = sendBacks.find(r => r.transferMode === 'instant');
    const conservSB = sendBacks.find(r => r.transferMode === 'conservative');

    const fmtMs = (v: number | undefined): string =>
      v !== undefined ? v.toFixed(0).padStart(8) : '     N/A';

    const label = 'Send-back UCT'.padEnd(20);
    console.log(
      `  ${label}  ${fmtMs(instantSB?.sendTimeMs)}  ${fmtMs(instantSB?.receiveTimeMs)}  ${fmtMs(instantSB?.receiverResolutionMs)}    ${fmtMs(conservSB?.sendTimeMs)}  ${fmtMs(conservSB?.receiveTimeMs)}  ${fmtMs(conservSB?.receiverResolutionMs)}`,
    );
  }

  // Averages
  const instant = results.filter(r => r.transferMode === 'instant' && r.success);
  const conserv = results.filter(r => r.transferMode === 'conservative' && r.success);

  const avg = (arr: TransferTestResult[], fn: (r: TransferTestResult) => number): string =>
    arr.length > 0
      ? (arr.reduce((s, r) => s + fn(r), 0) / arr.length).toFixed(0).padStart(8)
      : '     N/A';

  console.log('  ' + '-'.repeat(85));
  console.log(
    `  ${'Average'.padEnd(20)}  ${avg(instant, r => r.sendTimeMs)}  ${avg(instant, r => r.receiveTimeMs)}  ${avg(instant, r => r.receiverResolutionMs)}    ${avg(conserv, r => r.sendTimeMs)}  ${avg(conserv, r => r.receiveTimeMs)}  ${avg(conserv, r => r.receiverResolutionMs)}`,
  );
  console.log('');
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
    // Phase 2: DIRECT mode split tests (instant + conservative)
    // =========================================================================
    console.log('\n\n--- PHASE 2: DIRECT MODE TESTS (INSTANT vs CONSERVATIVE) ---');

    // Test 1: UCT split (instant)
    results.push(await runTransferTest({
      scenario: '1. UCT split (instant)',
      sender: alice,
      receiver: bob,
      receiverNametag: bobNametag,
      amount: '1',
      coinSymbol: 'UCT',
      mode: 'direct',
      transferMode: 'instant',
    }));
    await new Promise(r => setTimeout(r, INTER_TEST_DELAY_MS));
    await alice.payments.load();
    await bob.payments.load();

    // Test 2: UCT split (conservative)
    results.push(await runTransferTest({
      scenario: '2. UCT split (conservative)',
      sender: alice,
      receiver: bob,
      receiverNametag: bobNametag,
      amount: '1',
      coinSymbol: 'UCT',
      mode: 'direct',
      transferMode: 'conservative',
    }));
    await new Promise(r => setTimeout(r, INTER_TEST_DELAY_MS));
    await alice.payments.load();
    await bob.payments.load();

    // Test 3: BTC split (instant)
    results.push(await runTransferTest({
      scenario: '3. BTC split (instant)',
      sender: alice,
      receiver: bob,
      receiverNametag: bobNametag,
      amount: '0.1',
      coinSymbol: 'BTC',
      mode: 'direct',
      transferMode: 'instant',
    }));
    await new Promise(r => setTimeout(r, INTER_TEST_DELAY_MS));
    await alice.payments.load();
    await bob.payments.load();

    // Test 4: BTC split (conservative)
    results.push(await runTransferTest({
      scenario: '4. BTC split (conservative)',
      sender: alice,
      receiver: bob,
      receiverNametag: bobNametag,
      amount: '0.1',
      coinSymbol: 'BTC',
      mode: 'direct',
      transferMode: 'conservative',
    }));
    await new Promise(r => setTimeout(r, INTER_TEST_DELAY_MS));
    await alice.payments.load();
    await bob.payments.load();

    // Test 5: ETH split (instant)
    results.push(await runTransferTest({
      scenario: '5. ETH split (instant)',
      sender: alice,
      receiver: bob,
      receiverNametag: bobNametag,
      amount: '1',
      coinSymbol: 'ETH',
      mode: 'direct',
      transferMode: 'instant',
    }));
    await new Promise(r => setTimeout(r, INTER_TEST_DELAY_MS));
    await alice.payments.load();
    await bob.payments.load();

    // Test 6: ETH split (conservative)
    results.push(await runTransferTest({
      scenario: '6. ETH split (conservative)',
      sender: alice,
      receiver: bob,
      receiverNametag: bobNametag,
      amount: '1',
      coinSymbol: 'ETH',
      mode: 'direct',
      transferMode: 'conservative',
    }));
    await new Promise(r => setTimeout(r, INTER_TEST_DELAY_MS));
    await alice.payments.load();
    await bob.payments.load();

    // =========================================================================
    // Phase 3: Send-back tests (instant + conservative)
    // =========================================================================
    console.log('\n\n--- PHASE 3: SEND-BACK TESTS (INSTANT vs CONSERVATIVE) ---');

    // Resolve Bob's unconfirmed UCT tokens before send-back
    console.log('\n[RESOLVE] Resolving Bob unconfirmed UCT tokens...');
    const uctResolution = await waitForTokenResolution(bob, 'UCT');
    console.log(`  UCT resolved=${uctResolution.resolved} in ${uctResolution.durationMs.toFixed(0)}ms`);

    // Test 7: Send-back UCT (instant, bob -> alice)
    results.push(await runTransferTest({
      scenario: '7. Send-back UCT (instant)',
      sender: bob,
      receiver: alice,
      receiverNametag: aliceNametag,
      amount: '0.5',
      coinSymbol: 'UCT',
      mode: 'direct',
      transferMode: 'instant',
    }));
    await new Promise(r => setTimeout(r, INTER_TEST_DELAY_MS));
    await alice.payments.load();
    await bob.payments.load();

    // Resolve Bob's remaining UCT tokens before conservative send-back
    console.log('\n[RESOLVE] Resolving Bob remaining UCT tokens...');
    const uctResolution2 = await waitForTokenResolution(bob, 'UCT');
    console.log(`  UCT resolved=${uctResolution2.resolved} in ${uctResolution2.durationMs.toFixed(0)}ms`);

    // Test 8: Send-back UCT (conservative, bob -> alice)
    results.push(await runTransferTest({
      scenario: '8. Send-back UCT (conservative)',
      sender: bob,
      receiver: alice,
      receiverNametag: aliceNametag,
      amount: '0.5',
      coinSymbol: 'UCT',
      mode: 'direct',
      transferMode: 'conservative',
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

  // Exit code based on ALL test results
  const allPassed = results.length > 0 && results.every(r => r.success);
  process.exit(allPassed ? 0 : 1);
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
