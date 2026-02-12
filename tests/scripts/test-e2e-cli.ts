#!/usr/bin/env npx tsx
/**
 * E2E CLI Transfer Test Script
 *
 * Exercises CLI commands (wallet create, init, send, balance) by spawning
 * child processes, parsing stdout, and verifying balance conservation.
 * Mirrors the test matrix from test-e2e-transfers.ts.
 *
 * Usage:
 *   npx tsx tests/scripts/test-e2e-cli.ts [--cleanup]
 */

import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';

// =============================================================================
// Constants
// =============================================================================

const FAUCET_URL = 'https://faucet.unicity.network/api/v1/faucet/request';
const CLI_CMD = 'npx tsx cli/index.ts';
const CONFIG_FILE = '.sphere-cli/config.json';
const PROFILES_FILE = '.sphere-cli/profiles.json';
const TRANSFER_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 3_000;
const INTER_TEST_DELAY_MS = 3_000;
const FAUCET_TOPUP_TIMEOUT_MS = 90_000;

const FAUCET_COINS = [
  { faucetName: 'unicity', symbol: 'UCT', amount: 100 },
  { faucetName: 'bitcoin', symbol: 'BTC', amount: 1 },
  { faucetName: 'ethereum', symbol: 'ETH', amount: 42 },
];

// Decimals per coin (must match TokenRegistry)
const COIN_DECIMALS: Record<string, number> = {
  UCT: 8,
  BTC: 8,
  ETH: 18,
};

// =============================================================================
// Types
// =============================================================================

interface CliResult {
  stdout: string;
  durationMs: number;
}

interface ParsedBalance {
  confirmed: string; // human-readable (e.g. "99")
  unconfirmed: string; // human-readable (e.g. "1")
  tokens: number;
}

interface TestResult {
  scenario: string;
  transferMode: 'instant' | 'conservative';
  amount: string;
  coin: string;
  sendTimeMs: number;
  receiveTimeMs: number;
  finalizeTimeMs: number;
  balanceVerified: boolean;
  success: boolean;
  error?: string;
}

// =============================================================================
// Profile Switching (direct config file writes, no Sphere creation)
// =============================================================================

/**
 * Switch the active CLI profile by writing the config file directly.
 * This avoids creating a Sphere instance (which `wallet use` does),
 * preventing Nostr messages from being consumed before the actual command runs.
 */
function switchProfile(profileName: string): void {
  const profilesData = readFileSync(PROFILES_FILE, 'utf8');
  const profiles = JSON.parse(profilesData) as { profiles: Array<{ name: string; dataDir: string; tokensDir: string; network: string }> };
  const profile = profiles.profiles.find(p => p.name === profileName);
  if (!profile) throw new Error(`Profile "${profileName}" not found`);

  const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  config.dataDir = profile.dataDir;
  config.tokensDir = profile.tokensDir;
  config.currentProfile = profileName;
  config.network = profile.network;
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// =============================================================================
// CLI Helpers
// =============================================================================

/**
 * Switch to a profile (via config file) and run a CLI command.
 * Returns stdout and duration.
 */
function cli(cmd: string, profile?: string): CliResult {
  if (profile) {
    switchProfile(profile);
  }

  const start = performance.now();
  const stdout = execSync(`${CLI_CMD} ${cmd}`, {
    encoding: 'utf8',
    timeout: 300_000, // 5 min max for long operations
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const durationMs = performance.now() - start;

  return { stdout, durationMs };
}

/**
 * Parse balance output from `cli balance`.
 *
 * Formats:
 *   "UCT: 99 (3 tokens)"
 *   "UCT: 98 (+ 1 unconfirmed) [2+1 tokens]"
 */
function parseBalanceOutput(stdout: string, coinSymbol: string): ParsedBalance | null {
  const esc = coinSymbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Pattern 1: with unconfirmed — "SYM: <confirmed> (+ <unconfirmed> unconfirmed) [<c>+<u> tokens]"
  const unconfirmedPattern = new RegExp(
    `${esc}:\\s+([\\d.]+)\\s+\\(\\+\\s+([\\d.]+)\\s+unconfirmed\\)\\s+\\[(\\d+)\\+(\\d+)\\s+tokens\\]`
  );
  const m1 = stdout.match(unconfirmedPattern);
  if (m1) {
    return {
      confirmed: m1[1],
      unconfirmed: m1[2],
      tokens: parseInt(m1[3]) + parseInt(m1[4]),
    };
  }

  // Pattern 2: confirmed only — "SYM: <amount> (<n> tokens)"
  const confirmedPattern = new RegExp(
    `${esc}:\\s+([\\d.]+)\\s+\\((\\d+)\\s+tokens?\\)`
  );
  const m2 = stdout.match(confirmedPattern);
  if (m2) {
    return {
      confirmed: m2[1],
      unconfirmed: '0',
      tokens: parseInt(m2[2]),
    };
  }

  return null;
}

/**
 * Parse balance output, throwing if parsing fails.
 * Use in critical paths where a null result indicates a CLI format change, not a zero balance.
 */
function requireParsedBalance(stdout: string, coinSymbol: string, context: string): ParsedBalance {
  const parsed = parseBalanceOutput(stdout, coinSymbol);
  if (!parsed) {
    const relevantLines = stdout.split('\n').filter(l => l.includes(coinSymbol) || l.includes('balance')).join('\n  ');
    throw new Error(
      `Failed to parse ${coinSymbol} balance (${context}). ` +
      `CLI output may have changed format.\n  Relevant output:\n  ${relevantLines || stdout.trim()}`
    );
  }
  return parsed;
}

/**
 * Convert a human-readable amount string to bigint in smallest units.
 * e.g. "1.5" with 8 decimals → 150000000n
 */
function parseAmountToSmallest(humanStr: string, decimals: number): bigint {
  const parts = humanStr.split('.');
  const wholePart = BigInt(parts[0]) * (10n ** BigInt(decimals));
  if (parts.length === 2) {
    const fracStr = parts[1].padEnd(decimals, '0').slice(0, decimals);
    return wholePart + BigInt(fracStr);
  }
  return wholePart;
}

/**
 * Read balance using `balance --finalize` which includes a 2s Nostr sync delay.
 * This ensures incoming Nostr messages are received before reading balance.
 */
function readBalance(profile: string, coinSymbol: string): { balance: ParsedBalance | null; durationMs: number } {
  const { stdout, durationMs } = cli('balance --finalize', profile);
  return { balance: parseBalanceOutput(stdout, coinSymbol), durationMs };
}

/**
 * Poll balance (using --finalize for Nostr sync) until a coin appears at >= minAmount.
 */
function waitForBalance(
  profile: string,
  coinSymbol: string,
  minAmount: bigint,
  timeoutMs: number = TRANSFER_TIMEOUT_MS,
): { balance: ParsedBalance; durationMs: number; timedOut: boolean } {
  const decimals = COIN_DECIMALS[coinSymbol] ?? 8;
  const startTime = performance.now();
  let consecutiveErrors = 0;

  while (performance.now() - startTime < timeoutMs) {
    try {
      const { balance: parsed } = readBalance(profile, coinSymbol);
      consecutiveErrors = 0;

      if (parsed) {
        const confirmedSmallest = parseAmountToSmallest(parsed.confirmed, decimals);
        const unconfirmedSmallest = parseAmountToSmallest(parsed.unconfirmed, decimals);
        const totalSmallest = confirmedSmallest + unconfirmedSmallest;

        if (totalSmallest >= minAmount) {
          return {
            balance: parsed,
            durationMs: performance.now() - startTime,
            timedOut: false,
          };
        }
      }
    } catch (error) {
      consecutiveErrors++;
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`    [poll] Transient CLI error (${consecutiveErrors}): ${msg.split('\n')[0]}`);
      if (consecutiveErrors >= 5) {
        throw new Error(`Too many consecutive CLI errors in waitForBalance: ${msg}`);
      }
    }

    sleepSync(POLL_INTERVAL_MS);
  }

  // Final check
  console.warn(`    WARNING: waitForBalance timed out after ${(timeoutMs / 1000).toFixed(0)}s for ${coinSymbol}`);
  const { balance: parsed } = readBalance(profile, coinSymbol);
  return {
    balance: parsed || { confirmed: '0', unconfirmed: '0', tokens: 0 },
    durationMs: performance.now() - startTime,
    timedOut: true,
  };
}

/**
 * Synchronous sleep using Atomics.wait (portable, no shell dependency).
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// =============================================================================
// Test Run ID & Profile Names
// =============================================================================

function generateTestRunId(): string {
  return randomBytes(3).toString('hex');
}

// =============================================================================
// Setup: create wallets, faucet topup
// =============================================================================

function setupWallet(profile: string, nametag: string): void {
  console.log(`[SETUP] Creating wallet profile: ${profile}, nametag: @${nametag}`);
  // wallet create also switches to the new profile internally
  cli(`wallet create ${profile}`);
  const { stdout } = cli(`init --nametag ${nametag}`, profile);
  console.log(`  Init output (trimmed): ${stdout.split('\n').find(l => l.includes('initialized')) || 'OK'}`);
}

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

async function topupAndWait(profile: string, nametag: string): Promise<void> {
  console.log('\n[TOPUP] Requesting tokens from faucet...');

  for (const coin of FAUCET_COINS) {
    const result = await requestFaucet(nametag, coin.faucetName, coin.amount);
    const status = result.success ? 'OK' : `FAILED: ${result.message}`;
    console.log(`  ${coin.symbol} (${coin.amount}): ${status}`);
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\n[TOPUP] Waiting for tokens to arrive...');
  const startTime = performance.now();
  let lastStdout = '';

  while (performance.now() - startTime < FAUCET_TOPUP_TIMEOUT_MS) {
    let allReceived = true;

    // Use --finalize for Nostr sync on each poll
    const { stdout } = cli('balance --finalize', profile);
    lastStdout = stdout;
    for (const coin of FAUCET_COINS) {
      const parsed = parseBalanceOutput(stdout, coin.symbol);
      if (!parsed || (parsed.confirmed === '0' && parsed.unconfirmed === '0')) {
        allReceived = false;
        break;
      }
    }

    if (allReceived) {
      const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
      console.log(`  All tokens received in ${elapsed}s`);
      for (const coin of FAUCET_COINS) {
        const parsed = parseBalanceOutput(stdout, coin.symbol);
        if (parsed) {
          console.log(`  ${coin.symbol}: ${parsed.confirmed} (${parsed.tokens} tokens)`);
        }
      }
      return;
    }

    sleepSync(POLL_INTERVAL_MS);
  }

  const missing: string[] = [];
  for (const coin of FAUCET_COINS) {
    const parsed = parseBalanceOutput(lastStdout, coin.symbol);
    if (!parsed || (parsed.confirmed === '0' && parsed.unconfirmed === '0')) {
      missing.push(coin.symbol);
    }
  }
  throw new Error(`Faucet topup timed out. Missing: ${missing.join(', ')}`);
}

// =============================================================================
// Test Runner
// =============================================================================

interface TransferTestConfig {
  scenario: string;
  senderProfile: string;
  receiverProfile: string;
  receiverNametag: string;
  amount: string;
  coinSymbol: string;
  transferMode: 'instant' | 'conservative';
}

function runTransferTest(config: TransferTestConfig): TestResult {
  const {
    scenario, senderProfile, receiverProfile, receiverNametag,
    amount, coinSymbol, transferMode,
  } = config;

  const decimals = COIN_DECIMALS[coinSymbol] ?? 8;
  const amountSmallest = parseAmountToSmallest(amount, decimals);

  console.log(`\n${'='.repeat(70)}`);
  console.log(`SCENARIO: ${scenario}`);
  console.log(`  TxMode: ${transferMode.toUpperCase()}, Amount: ${amount} ${coinSymbol}`);
  console.log('='.repeat(70));

  const result: TestResult = {
    scenario,
    transferMode,
    amount,
    coin: coinSymbol,
    sendTimeMs: 0,
    receiveTimeMs: 0,
    finalizeTimeMs: 0,
    balanceVerified: false,
    success: false,
  };

  try {
    // 1. Snapshot sender balance BEFORE (use --finalize for Nostr sync)
    const { stdout: senderBeforeOut } = cli('balance --finalize', senderProfile);
    const senderBefore = requireParsedBalance(senderBeforeOut, coinSymbol, 'sender BEFORE');
    const senderBeforeTotal = parseAmountToSmallest(senderBefore.confirmed, decimals)
      + parseAmountToSmallest(senderBefore.unconfirmed, decimals);

    // 2. Snapshot receiver balance BEFORE
    const { balance: receiverBefore } = readBalance(receiverProfile, coinSymbol);
    const receiverBeforeTotal = receiverBefore
      ? parseAmountToSmallest(receiverBefore.confirmed, decimals) + parseAmountToSmallest(receiverBefore.unconfirmed, decimals)
      : 0n;

    console.log(`[1] Sender BEFORE:   ${senderBefore.confirmed} ${coinSymbol} (${senderBefore.tokens} tokens)`);
    console.log(`    Receiver BEFORE: ${receiverBefore?.confirmed ?? '0'} ${coinSymbol} (${receiverBefore?.tokens ?? 0} tokens)`);

    // Check sufficient balance
    if (senderBeforeTotal < amountSmallest) {
      throw new Error(`Insufficient sender balance: ${senderBeforeTotal} < ${amountSmallest}`);
    }

    // 3. Send
    const modeFlag = transferMode === 'conservative' ? '--conservative' : '--instant';
    const sendCmd = `send @${receiverNametag} ${amount} --coin ${coinSymbol} ${modeFlag}`;
    console.log(`[2] Sending: ${sendCmd}`);

    const { stdout: sendOut, durationMs: sendTime } = cli(sendCmd, senderProfile);
    result.sendTimeMs = sendTime;

    // Check for success
    if (!sendOut.includes('Transfer successful')) {
      throw new Error(`Send failed: ${sendOut.trim().split('\n').pop()}`);
    }
    console.log(`    Send completed in ${sendTime.toFixed(0)}ms`);

    // 4. Poll receiver balance until amount arrives (uses --finalize for Nostr sync)
    console.log(`[3] Waiting for receiver balance...`);
    const expectedReceiverTotal = receiverBeforeTotal + amountSmallest;
    const { balance: receiverAfter, durationMs: recvTime } = waitForBalance(
      receiverProfile, coinSymbol, expectedReceiverTotal, TRANSFER_TIMEOUT_MS,
    );
    result.receiveTimeMs = recvTime;
    console.log(`    Received in ${recvTime.toFixed(0)}ms — ${receiverAfter.confirmed} ${coinSymbol}`);

    // 5. Finalize on receiver (explicit finalization pass)
    console.log(`[4] Finalizing receiver...`);
    const { durationMs: finTime } = cli('balance --finalize', receiverProfile);
    result.finalizeTimeMs = finTime;
    console.log(`    Finalize completed in ${finTime.toFixed(0)}ms`);

    // 6. Wait for sender's change token (use --finalize for Nostr sync)
    console.log(`[5] Waiting for sender change token (up to 20s)...`);
    const expectedSenderTotal = senderBeforeTotal - amountSmallest;
    const { balance: senderAfter } = waitForBalance(
      senderProfile, coinSymbol, expectedSenderTotal, 20_000,
    );
    const senderAfterTotal = parseAmountToSmallest(senderAfter.confirmed, decimals)
      + parseAmountToSmallest(senderAfter.unconfirmed, decimals);

    // 7. Re-read receiver balance after finalization for accurate verification
    const { stdout: receiverFinalOut } = cli('balance --finalize', receiverProfile);
    const receiverFinal = requireParsedBalance(receiverFinalOut, coinSymbol, 'receiver FINAL');
    const receiverFinalTotal = parseAmountToSmallest(receiverFinal.confirmed, decimals)
      + parseAmountToSmallest(receiverFinal.unconfirmed, decimals);

    // 8. Verify balance conservation
    const senderDelta = senderBeforeTotal - senderAfterTotal;
    const receiverDelta = receiverFinalTotal - receiverBeforeTotal;

    console.log(`\n[6] BALANCE VERIFICATION:`);
    console.log(`    Sender lost:     ${senderDelta} (expected: ${amountSmallest})`);
    console.log(`    Receiver gained: ${receiverDelta} (expected: ${amountSmallest})`);

    const senderOk = senderDelta === amountSmallest;
    const receiverOk = receiverDelta === amountSmallest;
    const conserved = senderDelta === receiverDelta;

    if (senderOk && receiverOk && conserved) {
      console.log(`    BALANCE VERIFIED`);
      result.balanceVerified = true;
    } else {
      console.log(`    BALANCE MISMATCH!`);
      if (!senderOk) console.log(`      Sender should have lost ${amountSmallest}, actually lost ${senderDelta}`);
      if (!receiverOk) console.log(`      Receiver should have gained ${amountSmallest}, actually gained ${receiverDelta}`);
    }

    result.success = result.balanceVerified;

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

function printResultsTable(results: TestResult[]): void {
  console.log('\n\n');
  console.log('='.repeat(130));
  console.log('  CLI E2E TEST RESULTS');
  console.log('='.repeat(130));
  console.log('');
  console.log(
    '  #  | Scenario                          | TxMode | Amount       | Send(ms) | Recv(ms) | Fin(ms) | Balance | Status',
  );
  console.log(
    '-----+-----------------------------------+--------+--------------+----------+----------+---------+---------+---------',
  );

  results.forEach((r, i) => {
    const num = String(i + 1).padStart(3);
    const scenario = r.scenario.slice(0, 33).padEnd(33);
    const txMode = r.transferMode.slice(0, 6).toUpperCase().padEnd(6);
    const amount = `${r.amount} ${r.coin}`.padEnd(12).slice(0, 12);
    const sendTime = r.sendTimeMs.toFixed(0).padStart(8);
    const recvTime = r.receiveTimeMs.toFixed(0).padStart(8);
    const finTime = r.finalizeTimeMs.toFixed(0).padStart(7);
    const balanceOk = r.balanceVerified ? '  PASS ' : '  FAIL ';
    const status = r.success ? '  PASS ' : '  FAIL ';

    console.log(
      ` ${num} | ${scenario} | ${txMode} | ${amount} | ${sendTime} | ${recvTime} | ${finTime} |${balanceOk}|${status}`,
    );
  });

  console.log(
    '-----+-----------------------------------+--------+--------------+----------+----------+---------+---------+---------',
  );

  // Statistics
  const passed = results.filter(r => r.success);
  const instantResults = results.filter(r => r.transferMode === 'instant');
  const conservativeResults = results.filter(r => r.transferMode === 'conservative');

  const avg = (arr: TestResult[], fn: (r: TestResult) => number): string =>
    arr.length > 0
      ? (arr.reduce((s, r) => s + fn(r), 0) / arr.length).toFixed(0)
      : 'N/A';

  console.log(`\nSTATISTICS:`);
  console.log(`   Total passed:              ${passed.length}/${results.length}`);

  const instantPassed = instantResults.filter(r => r.success);
  const conservPassed = conservativeResults.filter(r => r.success);
  console.log(`   INSTANT tests passed:      ${instantPassed.length}/${instantResults.length}`);
  console.log(`   CONSERVATIVE tests passed: ${conservPassed.length}/${conservativeResults.length}`);

  if (instantPassed.length > 0) {
    console.log(`   Avg send time (instant):   ${avg(instantPassed, r => r.sendTimeMs)}ms`);
    console.log(`   Avg recv time (instant):   ${avg(instantPassed, r => r.receiveTimeMs)}ms`);
    console.log(`   Avg finalize (instant):    ${avg(instantPassed, r => r.finalizeTimeMs)}ms`);
  }
  if (conservPassed.length > 0) {
    console.log(`   Avg send time (conserv.):  ${avg(conservPassed, r => r.sendTimeMs)}ms`);
    console.log(`   Avg recv time (conserv.):  ${avg(conservPassed, r => r.receiveTimeMs)}ms`);
    console.log(`   Avg finalize (conserv.):   ${avg(conservPassed, r => r.finalizeTimeMs)}ms`);
  }

  // Benchmark comparison
  printBenchmarkComparison(results);

  // Final verdict
  console.log('');
  if (passed.length === results.length) {
    console.log('ALL TESTS PASSED');
  } else {
    console.log('SOME TESTS FAILED:');
    for (const r of results.filter(r => !r.success)) {
      console.log(`   - ${r.scenario}: ${r.error ?? 'balance mismatch'}`);
    }
  }
}

function printBenchmarkComparison(results: TestResult[]): void {
  console.log('\n--- BENCHMARK: INSTANT vs CONSERVATIVE ---\n');
  console.log(
    '                            Instant                       Conservative',
  );
  console.log(
    '  Scenario              Send(ms) Recv(ms) Fin(ms)     Send(ms) Recv(ms) Fin(ms)',
  );
  console.log('  ' + '-'.repeat(80));

  const coins = [...new Set(results.map(r => r.coin))];
  const fmtMs = (v: number | undefined): string =>
    v !== undefined ? v.toFixed(0).padStart(8) : '     N/A';

  for (const coin of coins) {
    const coinResults = results.filter(r => r.coin === coin);
    const instantR = coinResults.find(r => r.transferMode === 'instant');
    const conservR = coinResults.find(r => r.transferMode === 'conservative');

    const label = `${coin} split`.padEnd(20);
    console.log(
      `  ${label}  ${fmtMs(instantR?.sendTimeMs)}  ${fmtMs(instantR?.receiveTimeMs)}  ${fmtMs(instantR?.finalizeTimeMs)}  ${fmtMs(conservR?.sendTimeMs)}  ${fmtMs(conservR?.receiveTimeMs)}  ${fmtMs(conservR?.finalizeTimeMs)}`,
    );
  }

  // Send-back rows
  const sendBacks = results.filter(r => r.scenario.toLowerCase().includes('send-back'));
  if (sendBacks.length > 0) {
    const instantSB = sendBacks.find(r => r.transferMode === 'instant');
    const conservSB = sendBacks.find(r => r.transferMode === 'conservative');

    const label = 'Send-back UCT'.padEnd(20);
    console.log(
      `  ${label}  ${fmtMs(instantSB?.sendTimeMs)}  ${fmtMs(instantSB?.receiveTimeMs)}  ${fmtMs(instantSB?.finalizeTimeMs)}  ${fmtMs(conservSB?.sendTimeMs)}  ${fmtMs(conservSB?.receiveTimeMs)}  ${fmtMs(conservSB?.finalizeTimeMs)}`,
    );
  }

  // Averages
  const instant = results.filter(r => r.transferMode === 'instant' && r.success);
  const conserv = results.filter(r => r.transferMode === 'conservative' && r.success);
  const avg = (arr: TestResult[], fn: (r: TestResult) => number): string =>
    arr.length > 0
      ? (arr.reduce((s, r) => s + fn(r), 0) / arr.length).toFixed(0).padStart(8)
      : '     N/A';

  console.log('  ' + '-'.repeat(80));
  console.log(
    `  ${'Average'.padEnd(20)}  ${avg(instant, r => r.sendTimeMs)}  ${avg(instant, r => r.receiveTimeMs)}  ${avg(instant, r => r.finalizeTimeMs)}  ${avg(conserv, r => r.sendTimeMs)}  ${avg(conserv, r => r.receiveTimeMs)}  ${avg(conserv, r => r.finalizeTimeMs)}`,
  );
  console.log('');
}

// =============================================================================
// Cleanup
// =============================================================================

function cleanupProfiles(testRunId: string): void {
  const aliceDir = `.sphere-cli-e2ecli_${testRunId}_alice`;
  const bobDir = `.sphere-cli-e2ecli_${testRunId}_bob`;

  console.log(`\n[CLEANUP] Removing ${aliceDir} and ${bobDir}`);
  if (existsSync(aliceDir)) rmSync(aliceDir, { recursive: true, force: true });
  if (existsSync(bobDir)) rmSync(bobDir, { recursive: true, force: true });
  console.log('  Done.');
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  const doCleanup = process.argv.includes('--cleanup');
  const testRunId = generateTestRunId();

  const aliceProfile = `e2ecli_${testRunId}_alice`;
  const bobProfile = `e2ecli_${testRunId}_bob`;
  const aliceNametag = `cli${testRunId}a`;
  const bobNametag = `cli${testRunId}b`;

  console.log('='.repeat(70));
  console.log('  CLI E2E Transfer Test Suite');
  console.log('='.repeat(70));
  console.log(`  Test run ID:  ${testRunId}`);
  console.log(`  Alice:        @${aliceNametag} (profile: ${aliceProfile})`);
  console.log(`  Bob:          @${bobNametag} (profile: ${bobProfile})`);
  console.log(`  Cleanup:      ${doCleanup ? 'yes' : 'no (use --cleanup to remove dirs after)'}`);
  console.log('');

  const results: TestResult[] = [];

  try {
    // =========================================================================
    // Phase 1: Setup wallets
    // =========================================================================
    console.log('\n--- PHASE 1: WALLET SETUP ---\n');

    setupWallet(aliceProfile, aliceNametag);
    setupWallet(bobProfile, bobNametag);

    // Topup Alice via faucet
    await topupAndWait(aliceProfile, aliceNametag);

    // =========================================================================
    // Phase 2: DIRECT split tests (instant + conservative)
    // =========================================================================
    console.log('\n\n--- PHASE 2: DIRECT MODE TESTS (INSTANT vs CONSERVATIVE) ---');

    // Test 1: UCT split (instant)
    results.push(runTransferTest({
      scenario: '1. UCT split (instant)',
      senderProfile: aliceProfile,
      receiverProfile: bobProfile,
      receiverNametag: bobNametag,
      amount: '1',
      coinSymbol: 'UCT',
      transferMode: 'instant',
    }));
    sleepSync(INTER_TEST_DELAY_MS);

    // Test 2: UCT split (conservative)
    results.push(runTransferTest({
      scenario: '2. UCT split (conservative)',
      senderProfile: aliceProfile,
      receiverProfile: bobProfile,
      receiverNametag: bobNametag,
      amount: '1',
      coinSymbol: 'UCT',
      transferMode: 'conservative',
    }));
    sleepSync(INTER_TEST_DELAY_MS);

    // Test 3: BTC split (instant)
    results.push(runTransferTest({
      scenario: '3. BTC split (instant)',
      senderProfile: aliceProfile,
      receiverProfile: bobProfile,
      receiverNametag: bobNametag,
      amount: '0.1',
      coinSymbol: 'BTC',
      transferMode: 'instant',
    }));
    sleepSync(INTER_TEST_DELAY_MS);

    // Test 4: BTC split (conservative)
    results.push(runTransferTest({
      scenario: '4. BTC split (conservative)',
      senderProfile: aliceProfile,
      receiverProfile: bobProfile,
      receiverNametag: bobNametag,
      amount: '0.1',
      coinSymbol: 'BTC',
      transferMode: 'conservative',
    }));
    sleepSync(INTER_TEST_DELAY_MS);

    // Test 5: ETH split (instant)
    results.push(runTransferTest({
      scenario: '5. ETH split (instant)',
      senderProfile: aliceProfile,
      receiverProfile: bobProfile,
      receiverNametag: bobNametag,
      amount: '1',
      coinSymbol: 'ETH',
      transferMode: 'instant',
    }));
    sleepSync(INTER_TEST_DELAY_MS);

    // Test 6: ETH split (conservative)
    results.push(runTransferTest({
      scenario: '6. ETH split (conservative)',
      senderProfile: aliceProfile,
      receiverProfile: bobProfile,
      receiverNametag: bobNametag,
      amount: '1',
      coinSymbol: 'ETH',
      transferMode: 'conservative',
    }));
    sleepSync(INTER_TEST_DELAY_MS);

    // =========================================================================
    // Phase 3: Send-back tests (bob → alice)
    // =========================================================================
    console.log('\n\n--- PHASE 3: SEND-BACK TESTS (INSTANT vs CONSERVATIVE) ---');

    // Finalize Bob's tokens before send-back
    console.log('\n[RESOLVE] Finalizing Bob UCT tokens before send-back...');
    const { durationMs: finMs } = cli('balance --finalize', bobProfile);
    console.log(`  Finalize completed in ${finMs.toFixed(0)}ms`);

    // Test 7: Send-back UCT (instant, bob → alice)
    results.push(runTransferTest({
      scenario: '7. Send-back UCT (instant)',
      senderProfile: bobProfile,
      receiverProfile: aliceProfile,
      receiverNametag: aliceNametag,
      amount: '0.5',
      coinSymbol: 'UCT',
      transferMode: 'instant',
    }));
    sleepSync(INTER_TEST_DELAY_MS);

    // Finalize Bob's remaining tokens before conservative send-back
    console.log('\n[RESOLVE] Finalizing Bob remaining UCT tokens...');
    cli('balance --finalize', bobProfile);

    // Test 8: Send-back UCT (conservative, bob → alice)
    results.push(runTransferTest({
      scenario: '8. Send-back UCT (conservative)',
      senderProfile: bobProfile,
      receiverProfile: aliceProfile,
      receiverNametag: aliceNametag,
      amount: '0.5',
      coinSymbol: 'UCT',
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
    if (doCleanup) {
      cleanupProfiles(testRunId);
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
