#!/usr/bin/env npx tsx
/**
 * E2E CLI Multi-Token Transfer Stress Test Script
 *
 * Mirrors test-e2e-multi-transfers.ts but drives everything through CLI
 * subprocess invocation, matching the pattern in test-e2e-cli.ts.
 *
 *   Scenario A — "Split-then-multi-transfer":
 *     Alice sends 15 sequential split transfers to Bob via CLI.
 *     After all 15, verify balance conservation via CLI balance output.
 *
 *   Scenario B — "15 rapid-fire split transfers":
 *     Alice sends 15 transfers to Bob as fast as the CLI allows.
 *     Verifies every transfer arrives and no tokens are lost.
 *
 * Usage:
 *   npx tsx tests/scripts/test-e2e-cli-multi-transfers.ts [--cleanup]
 */

import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

// =============================================================================
// Constants
// =============================================================================

const FAUCET_URL = 'https://faucet.unicity.network/api/v1/faucet/request';
const CLI_CMD = 'npx tsx cli/index.ts';
const CONFIG_FILE = '.sphere-cli/config.json';
const PROFILES_FILE = '.sphere-cli/profiles.json';
const TRANSFER_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 3_000;
const INTER_TRANSFER_DELAY_MS = 2_000;
const FAUCET_TOPUP_TIMEOUT_MS = 90_000;

const COIN_DECIMALS: Record<string, number> = {
  UCT: 18,
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
  confirmed: string;
  unconfirmed: string;
  tokens: number;
}

interface ScenarioResult {
  scenario: string;
  transferCount: number;
  successfulSends: number;
  failedSends: number;
  totalAmountSent: bigint;
  senderTotalBefore: bigint;
  senderTotalAfter: bigint;
  receiverTotalBefore: bigint;
  receiverTotalAfter: bigint;
  senderDelta: bigint;
  receiverDelta: bigint;
  balanceConserved: boolean;
  totalSupplyConserved: boolean;
  totalTimeMs: number;
  success: boolean;
  error?: string;
}

// =============================================================================
// Profile Switching
// =============================================================================

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

function cli(cmd: string, profile?: string): CliResult {
  if (profile) {
    switchProfile(profile);
  }

  const start = performance.now();
  const stdout = execSync(`${CLI_CMD} ${cmd}`, {
    encoding: 'utf8',
    timeout: 300_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const durationMs = performance.now() - start;

  return { stdout, durationMs };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// =============================================================================
// Balance Parsing
// =============================================================================

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

function parseAmountToSmallest(humanStr: string, decimals: number): bigint {
  const parts = humanStr.split('.');
  const wholePart = BigInt(parts[0]) * (10n ** BigInt(decimals));
  if (parts.length === 2) {
    const fracStr = parts[1].padEnd(decimals, '0').slice(0, decimals);
    return wholePart + BigInt(fracStr);
  }
  return wholePart;
}

function getCliBalance(profile: string, coinSymbol: string): { total: bigint; parsed: ParsedBalance | null } {
  const { stdout } = cli('balance --finalize', profile);
  const parsed = parseBalanceOutput(stdout, coinSymbol);
  if (!parsed) return { total: 0n, parsed: null };
  const decimals = COIN_DECIMALS[coinSymbol] ?? 18;
  const total = parseAmountToSmallest(parsed.confirmed, decimals)
    + parseAmountToSmallest(parsed.unconfirmed, decimals);
  return { total, parsed };
}

// =============================================================================
// Polling
// =============================================================================

function waitForBalance(
  profile: string,
  coinSymbol: string,
  minAmount: bigint,
  timeoutMs: number = TRANSFER_TIMEOUT_MS,
): { total: bigint; parsed: ParsedBalance; durationMs: number; timedOut: boolean } {
  const decimals = COIN_DECIMALS[coinSymbol] ?? 18;
  const startTime = performance.now();
  let consecutiveErrors = 0;

  while (performance.now() - startTime < timeoutMs) {
    try {
      const { stdout } = cli('balance --finalize', profile);
      consecutiveErrors = 0;

      const parsed = parseBalanceOutput(stdout, coinSymbol);
      if (parsed) {
        const total = parseAmountToSmallest(parsed.confirmed, decimals)
          + parseAmountToSmallest(parsed.unconfirmed, decimals);

        if (total >= minAmount) {
          return {
            total,
            parsed,
            durationMs: performance.now() - startTime,
            timedOut: false,
          };
        }
      }
    } catch (error) {
      consecutiveErrors++;
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`    [poll] CLI error (${consecutiveErrors}): ${msg.split('\n')[0]}`);
      if (consecutiveErrors >= 5) {
        throw new Error(`Too many consecutive CLI errors: ${msg}`);
      }
    }

    sleepSync(POLL_INTERVAL_MS);
  }

  // Final check
  const { stdout } = cli('balance --finalize', profile);
  const parsed = parseBalanceOutput(stdout, coinSymbol);
  const total = parsed
    ? parseAmountToSmallest(parsed.confirmed, decimals) + parseAmountToSmallest(parsed.unconfirmed, decimals)
    : 0n;
  return {
    total,
    parsed: parsed || { confirmed: '0', unconfirmed: '0', tokens: 0 },
    durationMs: performance.now() - startTime,
    timedOut: true,
  };
}

// =============================================================================
// Setup
// =============================================================================

function generateTestRunId(): string {
  return randomBytes(3).toString('hex');
}

function setupWallet(profile: string, nametag: string): void {
  console.log(`[SETUP] Creating wallet profile: ${profile}, nametag: @${nametag}`);
  cli(`wallet create ${profile}`);
  const { stdout } = cli(`init --nametag ${nametag}`, profile);
  console.log(`  Init: ${stdout.split('\n').find(l => l.includes('initialized')) || 'OK'}`);
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
  console.log('\n[TOPUP] Requesting 100 UCT from faucet...');
  const result = await requestFaucet(nametag, 'unicity', 100);
  const status = result.success ? 'OK' : `FAILED: ${result.message}`;
  console.log(`  Faucet response: ${status}`);
  if (!result.success) throw new Error(`Faucet request failed: ${result.message}`);

  console.log('[TOPUP] Waiting for UCT to arrive...');
  const startTime = performance.now();

  while (performance.now() - startTime < FAUCET_TOPUP_TIMEOUT_MS) {
    const { stdout } = cli('balance --finalize', profile);
    const parsed = parseBalanceOutput(stdout, 'UCT');
    if (parsed && parsed.confirmed !== '0') {
      const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
      console.log(`  UCT received in ${elapsed}s: ${parsed.confirmed} (${parsed.tokens} tokens)`);
      return;
    }
    sleepSync(POLL_INTERVAL_MS);
  }

  throw new Error('Faucet topup timed out for UCT');
}

// =============================================================================
// Scenario A: Sequential split transfers via CLI
// =============================================================================

function runScenarioA(
  senderProfile: string,
  receiverProfile: string,
  receiverNametag: string,
  transferCount: number,
  amount: string,
  coinSymbol: string,
): ScenarioResult {
  const decimals = COIN_DECIMALS[coinSymbol] ?? 18;
  const amountSmallest = parseAmountToSmallest(amount, decimals);
  const totalExpected = amountSmallest * BigInt(transferCount);
  const scenario = `A-CLI: ${transferCount}x ${amount} ${coinSymbol} sequential splits`;

  console.log(`\n${'='.repeat(70)}`);
  console.log(`SCENARIO: ${scenario}`);
  console.log(`  Transfers: ${transferCount}, Amount each: ${amount} ${coinSymbol}`);
  console.log(`  Total expected: ${totalExpected} smallest units`);
  console.log('='.repeat(70));

  const result: ScenarioResult = {
    scenario,
    transferCount,
    successfulSends: 0,
    failedSends: 0,
    totalAmountSent: 0n,
    senderTotalBefore: 0n,
    senderTotalAfter: 0n,
    receiverTotalBefore: 0n,
    receiverTotalAfter: 0n,
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
    const senderBefore = getCliBalance(senderProfile, coinSymbol);
    const receiverBefore = getCliBalance(receiverProfile, coinSymbol);
    if (senderBefore.parsed === null) {
      throw new Error(`Failed to parse sender ${coinSymbol} balance before scenario — CLI output format may have changed`);
    }
    result.senderTotalBefore = senderBefore.total;
    result.receiverTotalBefore = receiverBefore.total;
    const totalSupplyBefore = senderBefore.total + receiverBefore.total;

    console.log(`\n[BEFORE] Sender:   ${senderBefore.parsed.confirmed} ${coinSymbol} (${senderBefore.parsed.tokens} tokens)`);
    console.log(`[BEFORE] Receiver: ${receiverBefore.parsed?.confirmed ?? '0'} ${coinSymbol} (${receiverBefore.parsed?.tokens ?? 0} tokens)`);

    if (senderBefore.total < totalExpected) {
      throw new Error(`Insufficient sender balance: ${senderBefore.total} < ${totalExpected}`);
    }

    // Execute N transfers
    for (let i = 0; i < transferCount; i++) {
      const transferNum = i + 1;
      const sendCmd = `send @${receiverNametag} ${amount} --coin ${coinSymbol} --instant`;

      console.log(`  [${transferNum}/${transferCount}] ${sendCmd}`);

      try {
        const { stdout: sendOut, durationMs: sendTime } = cli(sendCmd, senderProfile);

        if (sendOut.includes('Transfer successful')) {
          result.successfulSends++;
          result.totalAmountSent += amountSmallest;
          console.log(`    OK in ${sendTime.toFixed(0)}ms`);
        } else {
          result.failedSends++;
          const lastLine = sendOut.trim().split('\n').pop();
          console.log(`    FAILED: ${lastLine}`);
        }
      } catch (err) {
        result.failedSends++;
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`    ERROR: ${msg.split('\n')[0]}`);
      }

      // Small delay between transfers
      if (i < transferCount - 1) {
        sleepSync(INTER_TRANSFER_DELAY_MS);
      }
    }

    // Wait for receiver to accumulate all transfers
    console.log(`\n[RECEIVE] Waiting for receiver to accumulate ${result.successfulSends} transfers...`);
    const expectedReceiverTotal = receiverBefore.total + result.totalAmountSent;
    const recvResult = waitForBalance(
      receiverProfile, coinSymbol, expectedReceiverTotal, TRANSFER_TIMEOUT_MS,
    );

    if (recvResult.timedOut) {
      console.log(`  WARNING: Receiver timed out. Got ${recvResult.total}, expected ${expectedReceiverTotal}`);
    } else {
      console.log(`  All received in ${recvResult.durationMs.toFixed(0)}ms`);
    }

    // Wait for sender change tokens to settle
    console.log(`[SETTLE] Reading final sender balance...`);
    const expectedSenderTotal = senderBefore.total - result.totalAmountSent;
    const senderFinal = waitForBalance(
      senderProfile, coinSymbol, expectedSenderTotal, 30_000,
    );

    result.senderTotalAfter = senderFinal.total;
    result.receiverTotalAfter = recvResult.total;

    result.senderDelta = senderBefore.total - senderFinal.total;
    result.receiverDelta = recvResult.total - receiverBefore.total;
    const totalSupplyAfter = senderFinal.total + recvResult.total;

    // Verification
    console.log(`\n[VERIFY]`);
    console.log(`  Sender lost:     ${result.senderDelta} (expected: ${result.totalAmountSent})`);
    console.log(`  Receiver gained: ${result.receiverDelta} (expected: ${result.totalAmountSent})`);
    console.log(`  Total supply:    ${totalSupplyBefore} -> ${totalSupplyAfter}`);

    result.balanceConserved =
      result.senderDelta === result.totalAmountSent &&
      result.receiverDelta === result.totalAmountSent &&
      result.senderDelta === result.receiverDelta;

    result.totalSupplyConserved = totalSupplyBefore === totalSupplyAfter;

    console.log(`  Balance conservation: ${result.balanceConserved ? 'PASS' : 'FAIL'}`);
    console.log(`  Supply conservation:  ${result.totalSupplyConserved ? 'PASS' : 'FAIL'}`);

    if (!result.balanceConserved) {
      if (result.senderDelta !== result.totalAmountSent) {
        console.log(`    Sender should have lost ${result.totalAmountSent}, actually lost ${result.senderDelta}`);
      }
      if (result.receiverDelta !== result.totalAmountSent) {
        console.log(`    Receiver should have gained ${result.totalAmountSent}, actually gained ${result.receiverDelta}`);
      }
    }

    result.success =
      result.successfulSends > 0 &&
      result.failedSends === 0 &&
      !recvResult.timedOut &&
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
// Scenario B: Rapid-fire transfers via CLI
// =============================================================================

function runScenarioB(
  senderProfile: string,
  receiverProfile: string,
  receiverNametag: string,
  transferCount: number,
  amount: string,
  coinSymbol: string,
): ScenarioResult {
  const decimals = COIN_DECIMALS[coinSymbol] ?? 18;
  const amountSmallest = parseAmountToSmallest(amount, decimals);
  const totalExpected = amountSmallest * BigInt(transferCount);
  const scenario = `B-CLI: ${transferCount}x rapid ${amount} ${coinSymbol}`;

  console.log(`\n${'='.repeat(70)}`);
  console.log(`SCENARIO: ${scenario}`);
  console.log(`  Transfers: ${transferCount}, Amount each: ${amount} ${coinSymbol}`);
  console.log(`  Total expected: ${totalExpected} smallest units`);
  console.log(`  Mode: RAPID-FIRE (minimal delay)`);
  console.log('='.repeat(70));

  const result: ScenarioResult = {
    scenario,
    transferCount,
    successfulSends: 0,
    failedSends: 0,
    totalAmountSent: 0n,
    senderTotalBefore: 0n,
    senderTotalAfter: 0n,
    receiverTotalBefore: 0n,
    receiverTotalAfter: 0n,
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
    const senderBefore = getCliBalance(senderProfile, coinSymbol);
    const receiverBefore = getCliBalance(receiverProfile, coinSymbol);
    if (senderBefore.parsed === null) {
      throw new Error(`Failed to parse sender ${coinSymbol} balance before scenario — CLI output format may have changed`);
    }
    result.senderTotalBefore = senderBefore.total;
    result.receiverTotalBefore = receiverBefore.total;
    const totalSupplyBefore = senderBefore.total + receiverBefore.total;

    console.log(`\n[BEFORE] Sender:   ${senderBefore.parsed.confirmed} ${coinSymbol} (${senderBefore.parsed.tokens} tokens)`);
    console.log(`[BEFORE] Receiver: ${receiverBefore.parsed?.confirmed ?? '0'} ${coinSymbol} (${receiverBefore.parsed?.tokens ?? 0} tokens)`);

    if (senderBefore.total < totalExpected) {
      throw new Error(`Insufficient sender balance: ${senderBefore.total} < ${totalExpected}`);
    }

    // Rapid-fire: no delay between sends (CLI is inherently sequential, but
    // we don't add any artificial delay beyond what the CLI itself takes)
    console.log(`\n[RAPID-FIRE] Sending ${transferCount} transfers...`);
    const sendTimes: number[] = [];

    for (let i = 0; i < transferCount; i++) {
      const transferNum = i + 1;
      const sendCmd = `send @${receiverNametag} ${amount} --coin ${coinSymbol} --instant`;

      try {
        const { stdout: sendOut, durationMs: sendTime } = cli(sendCmd, senderProfile);
        sendTimes.push(sendTime);

        if (sendOut.includes('Transfer successful')) {
          result.successfulSends++;
          result.totalAmountSent += amountSmallest;
          console.log(`  [${transferNum}/${transferCount}] OK in ${sendTime.toFixed(0)}ms`);
        } else {
          result.failedSends++;
          const lastLine = sendOut.trim().split('\n').pop();
          console.log(`  [${transferNum}/${transferCount}] FAILED: ${lastLine}`);
        }
      } catch (err) {
        result.failedSends++;
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  [${transferNum}/${transferCount}] ERROR: ${msg.split('\n')[0]}`);
      }
      // No deliberate delay in rapid-fire mode
    }

    // Stats
    if (sendTimes.length > 0) {
      const avgMs = sendTimes.reduce((a, b) => a + b, 0) / sendTimes.length;
      const minMs = Math.min(...sendTimes);
      const maxMs = Math.max(...sendTimes);
      console.log(`\n  Send times: avg=${avgMs.toFixed(0)}ms, min=${minMs.toFixed(0)}ms, max=${maxMs.toFixed(0)}ms`);
    }

    // Wait for receiver to accumulate all transfers
    console.log(`\n[RECEIVE] Waiting for receiver to accumulate ${result.successfulSends} transfers...`);
    const expectedReceiverTotal = receiverBefore.total + result.totalAmountSent;
    const recvResult = waitForBalance(
      receiverProfile, coinSymbol, expectedReceiverTotal, TRANSFER_TIMEOUT_MS,
    );

    if (recvResult.timedOut) {
      console.log(`  WARNING: Receiver timed out. Got ${recvResult.total}, expected ${expectedReceiverTotal}`);
    } else {
      console.log(`  All received in ${recvResult.durationMs.toFixed(0)}ms`);
    }

    // Wait for sender change tokens
    console.log(`[SETTLE] Reading final sender balance...`);
    const expectedSenderTotal = senderBefore.total - result.totalAmountSent;
    const senderFinal = waitForBalance(
      senderProfile, coinSymbol, expectedSenderTotal, 30_000,
    );

    result.senderTotalAfter = senderFinal.total;
    result.receiverTotalAfter = recvResult.total;

    result.senderDelta = senderBefore.total - senderFinal.total;
    result.receiverDelta = recvResult.total - receiverBefore.total;
    const totalSupplyAfter = senderFinal.total + recvResult.total;

    // Verification
    console.log(`\n[VERIFY]`);
    console.log(`  Sender lost:     ${result.senderDelta} (expected: ${result.totalAmountSent})`);
    console.log(`  Receiver gained: ${result.receiverDelta} (expected: ${result.totalAmountSent})`);
    console.log(`  Total supply:    ${totalSupplyBefore} -> ${totalSupplyAfter}`);

    result.balanceConserved =
      result.senderDelta === result.totalAmountSent &&
      result.receiverDelta === result.totalAmountSent &&
      result.senderDelta === result.receiverDelta;

    result.totalSupplyConserved = totalSupplyBefore === totalSupplyAfter;

    console.log(`  Balance conservation: ${result.balanceConserved ? 'PASS' : 'FAIL'}`);
    console.log(`  Supply conservation:  ${result.totalSupplyConserved ? 'PASS' : 'FAIL'}`);

    if (!result.balanceConserved) {
      if (result.senderDelta !== result.totalAmountSent) {
        console.log(`    Sender should have lost ${result.totalAmountSent}, actually lost ${result.senderDelta}`);
      }
      if (result.receiverDelta !== result.totalAmountSent) {
        console.log(`    Receiver should have gained ${result.totalAmountSent}, actually gained ${result.receiverDelta}`);
      }
    }

    result.success =
      result.successfulSends > 0 &&
      result.failedSends === 0 &&
      !recvResult.timedOut &&
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
  console.log('  CLI MULTI-TRANSFER E2E TEST RESULTS');
  console.log('='.repeat(120));
  console.log('');
  console.log(
    '  #  | Scenario                                            | Sends OK/N  | Balance | Supply  | Time(s) | Status',
  );
  console.log(
    '-----+-----------------------------------------------------+-------------+---------+---------+---------+---------',
  );

  results.forEach((r, i) => {
    const num = String(i + 1).padStart(3);
    const scenario = r.scenario.slice(0, 51).padEnd(51);
    const sends = `${r.successfulSends}/${r.transferCount}`.padEnd(11);
    const balance = r.balanceConserved ? '  PASS ' : '  FAIL ';
    const supply = r.totalSupplyConserved ? '  PASS ' : '  FAIL ';
    const time = (r.totalTimeMs / 1000).toFixed(1).padStart(7);
    const status = r.success ? '  PASS ' : '  FAIL ';

    console.log(
      ` ${num} | ${scenario} | ${sends} |${balance}|${supply}| ${time} |${status}`,
    );
  });

  console.log(
    '-----+-----------------------------------------------------+-------------+---------+---------+---------+---------',
  );

  const passed = results.filter(r => r.success);
  console.log(`\n  TOTAL: ${passed.length}/${results.length} scenarios passed`);

  if (passed.length === results.length) {
    console.log('\n  ALL TESTS PASSED — No tokens lost in CLI multi-transfer scenarios');
  } else {
    console.log('\n  SOME TESTS FAILED:');
    for (const r of results.filter(r => !r.success)) {
      console.log(`    - ${r.scenario}: ${r.error ?? 'balance/supply mismatch'}`);
      if (r.failedSends > 0) {
        console.log(`      ${r.failedSends} send(s) failed`);
      }
      if (!r.balanceConserved) {
        console.log(`      Balance mismatch: sent=${r.totalAmountSent}, sender_loss=${r.senderDelta}, receiver_gain=${r.receiverDelta}`);
      }
    }
  }
}

// =============================================================================
// Cleanup
// =============================================================================

function cleanupProfiles(testRunId: string): void {
  const aliceDir = `.sphere-cli-climt_${testRunId}_alice`;
  const bobDir = `.sphere-cli-climt_${testRunId}_bob`;

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

  const aliceProfile = `climt_${testRunId}_alice`;
  const bobProfile = `climt_${testRunId}_bob`;
  const aliceNametag = `cmt${testRunId}a`;
  const bobNametag = `cmt${testRunId}b`;

  console.log('='.repeat(70));
  console.log('  CLI Multi-Token Transfer Stress Test');
  console.log('='.repeat(70));
  console.log(`  Test run ID:  ${testRunId}`);
  console.log(`  Alice:        @${aliceNametag} (profile: ${aliceProfile})`);
  console.log(`  Bob:          @${bobNametag} (profile: ${bobProfile})`);
  console.log(`  Cleanup:      ${doCleanup ? 'yes' : 'no (use --cleanup to remove dirs after)'}`);
  console.log('');

  const results: ScenarioResult[] = [];

  try {
    // =========================================================================
    // Phase 1: Setup
    // =========================================================================
    console.log('\n--- PHASE 1: WALLET SETUP ---\n');

    setupWallet(aliceProfile, aliceNametag);
    setupWallet(bobProfile, bobNametag);

    await topupAndWait(aliceProfile, aliceNametag);

    // =========================================================================
    // Phase 2: Scenario A — 15 sequential split transfers
    // =========================================================================
    console.log('\n\n--- PHASE 2: SCENARIO A — SEQUENTIAL SPLIT TRANSFERS ---');

    results.push(runScenarioA(
      aliceProfile, bobProfile, bobNametag,
      15, '1', 'UCT',
    ));

    sleepSync(5_000);

    // =========================================================================
    // Phase 3: Scenario B — 15 rapid-fire transfers
    // =========================================================================
    console.log('\n\n--- PHASE 3: SCENARIO B — RAPID-FIRE TRANSFERS ---');

    results.push(runScenarioB(
      aliceProfile, bobProfile, bobNametag,
      15, '1', 'UCT',
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
    if (doCleanup) {
      cleanupProfiles(testRunId);
    }
  }

  const allPassed = results.length > 0 && results.every(r => r.success);
  process.exit(allPassed ? 0 : 1);
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
