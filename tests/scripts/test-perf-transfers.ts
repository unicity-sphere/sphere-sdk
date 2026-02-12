#!/usr/bin/env npx tsx
/**
 * Performance Measurement Script for Token Transfers
 *
 * Measures wall-clock timing for every phase of:
 *   - Split transfers (burn → mint → transfer → Nostr → finalize)
 *   - Whole-token transfers (commit → proof → Nostr → finalize)
 *   - DIRECT vs PROXY finalization
 *
 * Instruments the SDK internals via monkey-patching to capture per-phase
 * timings without modifying SDK source code.
 *
 * Usage:
 *   npx tsx tests/scripts/test-perf-transfers.ts [--cleanup] [--runs N]
 */

import { Sphere } from '../../core/Sphere';
import { createNodeProviders } from '../../impl/nodejs';
import { TokenRegistry } from '../../registry/TokenRegistry';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';

// =============================================================================
// Config
// =============================================================================

const FAUCET_URL = 'https://faucet.unicity.network/api/v1/faucet/request';
const NETWORK = 'testnet' as const;
const FAUCET_TOPUP_TIMEOUT_MS = 90_000;
const TRANSFER_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;
const INTER_TEST_DELAY_MS = 3_000;

// =============================================================================
// Types
// =============================================================================

interface PhaseTimings {
  [phase: string]: number; // ms
}

interface TransferMeasurement {
  label: string;
  mode: 'direct' | 'proxy';
  type: 'split' | 'whole';
  coin: string;
  amount: string;
  sendTotalMs: number;
  receiveTotalMs: number;
  phases: PhaseTimings;
  success: boolean;
  error?: string;
}

// =============================================================================
// Console-log timing interceptor
// =============================================================================

/**
 * Captures timestamped console.log output to extract per-phase durations.
 * Returns a stop() function and a getPhases() accessor.
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
    /** All captured entries */
    entries() {
      return entries;
    },
  };
}

// =============================================================================
// Helpers
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
    return wholePart + BigInt(fracStr);
  }
  return BigInt(parts[0]) * multiplier;
}

interface BalanceSnapshot {
  total: bigint;
  tokens: number;
}

function getBalance(sphere: Sphere, coinSymbol: string): BalanceSnapshot {
  const balances = sphere.payments.getBalance();
  const bal = balances.find(b => b.symbol === coinSymbol);
  if (!bal) return { total: 0n, tokens: 0 };
  return { total: BigInt(bal.totalAmount), tokens: bal.tokenCount };
}

// =============================================================================
// Wallet & Faucet
// =============================================================================

async function createTestWallet(profileName: string, nametag: string): Promise<Sphere> {
  const dataDir = `./.sphere-cli-${profileName}`;
  const tokensDir = `${dataDir}/tokens`;
  const providers = createNodeProviders({ network: NETWORK, dataDir, tokensDir });
  const { sphere } = await Sphere.init({ ...providers, autoGenerate: true, nametag });
  return sphere;
}

async function requestFaucet(nametag: string, coin: string, amount: number): Promise<boolean> {
  try {
    const res = await fetch(FAUCET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unicityId: nametag, coin, amount }),
    });
    const json = await res.json() as { success: boolean };
    return json.success;
  } catch {
    return false;
  }
}

async function topupAndWait(sphere: Sphere, nametag: string, coin: { faucetName: string; symbol: string; amount: number }): Promise<void> {
  await requestFaucet(nametag, coin.faucetName, coin.amount);

  const deadline = performance.now() + FAUCET_TOPUP_TIMEOUT_MS;
  while (performance.now() < deadline) {
    await sphere.payments.load();
    const bal = getBalance(sphere, coin.symbol);
    if (bal.total > 0n) return;
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Topup timed out for ${coin.symbol}`);
}

// =============================================================================
// Measurement runner
// =============================================================================

async function measureTransfer(opts: {
  label: string;
  sender: Sphere;
  receiver: Sphere;
  receiverNametag: string;
  amount: string;
  coinSymbol: string;
  mode: 'direct' | 'proxy';
  type: 'split' | 'whole';
}): Promise<TransferMeasurement> {
  const registry = TokenRegistry.getInstance();
  const coinDef = registry.getDefinitionBySymbol(opts.coinSymbol);
  if (!coinDef) throw new Error(`Unknown coin: ${opts.coinSymbol}`);
  const decimals = coinDef.decimals ?? 0;
  const amountSmallest = parseAmount(opts.amount, decimals);

  const result: TransferMeasurement = {
    label: opts.label,
    mode: opts.mode,
    type: opts.type,
    coin: opts.coinSymbol,
    amount: opts.amount,
    sendTotalMs: 0,
    receiveTotalMs: 0,
    phases: {},
    success: false,
  };

  try {
    // Snapshot receiver balance before
    await opts.receiver.payments.load();
    const receiverBefore = getBalance(opts.receiver, opts.coinSymbol);

    // --- SEND with phase capture ---
    const cap = createPhaseCapture();
    const sendStart = performance.now();

    await opts.sender.payments.send({
      recipient: `@${opts.receiverNametag}`,
      amount: amountSmallest.toString(),
      coinId: coinDef.id,
      addressMode: opts.mode,
    });

    const sendEnd = performance.now();
    cap.stop();
    result.sendTotalMs = sendEnd - sendStart;

    // Extract phases from captured logs
    if (opts.type === 'split') {
      const burn = cap.between('Step 1: Burning', 'Original token burned');
      const mint = cap.between('Step 2: Minting', 'Split tokens minted');
      const transfer = cap.between('Step 3: Transferring', 'Split transfer complete');
      const nostrSend = cap.between('Sending split token', 'Split token sent successfully');

      if (burn !== null) result.phases['split.burn'] = burn;
      if (mint !== null) result.phases['split.mint'] = mint;
      if (transfer !== null) result.phases['split.transfer'] = transfer;
      if (nostrSend !== null) result.phases['nostr.send'] = nostrSend;

      // Compute on-chain total (burn + mint + transfer)
      if (burn !== null && mint !== null && transfer !== null) {
        result.phases['chain.total'] = burn + mint + transfer;
      }
    } else {
      const commit = cap.between('Sending direct token', 'Direct token sent successfully');
      if (commit !== null) result.phases['nostr.send'] = commit;
    }

    // --- RECEIVE timing ---
    const receiveStart = performance.now();
    const expectedTotal = receiverBefore.total + amountSmallest;

    const deadline = receiveStart + TRANSFER_TIMEOUT_MS;
    while (performance.now() < deadline) {
      await opts.receiver.payments.load();
      const bal = getBalance(opts.receiver, opts.coinSymbol);
      if (bal.total >= expectedTotal) break;
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }

    result.receiveTotalMs = performance.now() - receiveStart;

    // Verify
    const receiverAfter = getBalance(opts.receiver, opts.coinSymbol);
    const gained = receiverAfter.total - receiverBefore.total;
    result.success = gained === amountSmallest;
    if (!result.success) {
      result.error = `Balance mismatch: gained ${gained}, expected ${amountSmallest}`;
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  return result;
}

// =============================================================================
// Report
// =============================================================================

function printReport(measurements: TransferMeasurement[]): void {
  console.log('\n');
  console.log('='.repeat(100));
  console.log('  TRANSFER PERFORMANCE REPORT');
  console.log('='.repeat(100));

  // Summary table
  console.log('\n--- SUMMARY ---\n');
  console.log(
    '  #  | Test                                     | Mode   | Type  | Send(ms) | Recv(ms) | Status'
  );
  console.log(
    '-----+------------------------------------------+--------+-------+----------+----------+--------'
  );

  measurements.forEach((m, i) => {
    const num = String(i + 1).padStart(3);
    const label = m.label.padEnd(40).slice(0, 40);
    const mode = m.mode.toUpperCase().padEnd(6);
    const type = m.type.padEnd(5);
    const send = m.sendTotalMs.toFixed(0).padStart(8);
    const recv = m.receiveTotalMs.toFixed(0).padStart(8);
    const status = m.success ? ' PASS ' : ' FAIL ';
    console.log(` ${num} | ${label} | ${mode} | ${type} | ${send} | ${recv} | ${status}`);
  });

  console.log(
    '-----+------------------------------------------+--------+-------+----------+----------+--------'
  );

  // Phase breakdown
  console.log('\n--- PHASE BREAKDOWN (sender side) ---\n');

  for (const m of measurements) {
    console.log(`  ${m.label} [${m.mode.toUpperCase()} / ${m.type}]`);
    console.log(`    Total send:     ${m.sendTotalMs.toFixed(0)} ms`);

    const phaseKeys = Object.keys(m.phases).sort();
    if (phaseKeys.length > 0) {
      for (const key of phaseKeys) {
        const pct = ((m.phases[key] / m.sendTotalMs) * 100).toFixed(1);
        console.log(`    ${key.padEnd(18)} ${m.phases[key].toFixed(0).padStart(6)} ms  (${pct}%)`);
      }
      // Overhead = total - sum of captured phases (address resolution, save, etc.)
      const capturedSum = phaseKeys.reduce((s, k) => s + m.phases[k], 0);
      const overhead = m.sendTotalMs - capturedSum;
      if (overhead > 0) {
        const pct = ((overhead / m.sendTotalMs) * 100).toFixed(1);
        console.log(`    overhead/other    ${overhead.toFixed(0).padStart(6)} ms  (${pct}%)`);
      }
    }
    console.log(`    Receive:        ${m.receiveTotalMs.toFixed(0)} ms`);
    console.log('');
  }

  // Comparison tables
  console.log('--- COMPARISON: DIRECT vs PROXY ---\n');

  const splitDirect = measurements.filter(m => m.type === 'split' && m.mode === 'direct');
  const splitProxy = measurements.filter(m => m.type === 'split' && m.mode === 'proxy');
  const wholeDirect = measurements.filter(m => m.type === 'whole' && m.mode === 'direct');
  const wholeProxy = measurements.filter(m => m.type === 'whole' && m.mode === 'proxy');

  const avg = (arr: TransferMeasurement[], fn: (m: TransferMeasurement) => number): string =>
    arr.length > 0
      ? (arr.reduce((s, m) => s + fn(m), 0) / arr.length).toFixed(0)
      : 'N/A';

  console.log('                        Send avg(ms)    Recv avg(ms)');
  console.log(`  Split + DIRECT:       ${avg(splitDirect, m => m.sendTotalMs).padStart(8)}        ${avg(splitDirect, m => m.receiveTotalMs).padStart(8)}`);
  console.log(`  Split + PROXY:        ${avg(splitProxy, m => m.sendTotalMs).padStart(8)}        ${avg(splitProxy, m => m.receiveTotalMs).padStart(8)}`);
  console.log(`  Whole + DIRECT:       ${avg(wholeDirect, m => m.sendTotalMs).padStart(8)}        ${avg(wholeDirect, m => m.receiveTotalMs).padStart(8)}`);
  console.log(`  Whole + PROXY:        ${avg(wholeProxy, m => m.sendTotalMs).padStart(8)}        ${avg(wholeProxy, m => m.receiveTotalMs).padStart(8)}`);

  // Chain phase averages for splits
  console.log('\n--- SPLIT PHASE AVERAGES ---\n');
  const allSplits = measurements.filter(m => m.type === 'split' && m.success);
  if (allSplits.length > 0) {
    const phaseNames = ['split.burn', 'split.mint', 'split.transfer', 'chain.total', 'nostr.send'];
    for (const phase of phaseNames) {
      const vals = allSplits.map(m => m.phases[phase]).filter(v => v !== undefined);
      if (vals.length > 0) {
        const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
        const min = Math.min(...vals);
        const max = Math.max(...vals);
        console.log(`  ${phase.padEnd(18)} avg: ${mean.toFixed(0).padStart(6)} ms   min: ${min.toFixed(0).padStart(6)}   max: ${max.toFixed(0).padStart(6)}`);
      }
    }
  }

  console.log('');
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  const doCleanup = process.argv.includes('--cleanup');
  const runsArg = process.argv.indexOf('--runs');
  const testRunId = generateTestRunId();

  const aliceNametag = `pf${testRunId}a`;
  const bobNametag = `pf${testRunId}b`;
  const aliceProfile = `perf_${testRunId}_alice`;
  const bobProfile = `perf_${testRunId}_bob`;

  console.log('='.repeat(70));
  console.log('  Transfer Performance Measurement');
  console.log('='.repeat(70));
  console.log(`  Run ID: ${testRunId}`);
  console.log(`  Alice:  @${aliceNametag}  Bob: @${bobNametag}`);
  console.log('');

  const measurements: TransferMeasurement[] = [];
  let alice: Sphere | null = null;
  let bob: Sphere | null = null;

  try {
    // --- Setup ---
    console.log('--- SETUP ---\n');

    console.log('Creating wallets...');
    alice = await createTestWallet(aliceProfile, aliceNametag);
    bob = await createTestWallet(bobProfile, bobNametag);
    console.log('  Wallets created.\n');

    // Topup Alice with UCT (we need enough for multiple tests)
    console.log('Requesting faucet topup...');
    await topupAndWait(alice, aliceNametag, { faucetName: 'unicity', symbol: 'UCT', amount: 100 });
    console.log('  UCT received.\n');

    // =========================================================================
    // Test 1: Split + DIRECT (alice -> bob, 1 UCT from 100)
    // =========================================================================
    console.log('--- TEST 1: Split + DIRECT ---');
    measurements.push(await measureTransfer({
      label: '1. Split + DIRECT (alice->bob 1 UCT)',
      sender: alice, receiver: bob, receiverNametag: bobNametag,
      amount: '1', coinSymbol: 'UCT', mode: 'direct', type: 'split',
    }));
    await new Promise(r => setTimeout(r, INTER_TEST_DELAY_MS));
    await alice.payments.load();
    await bob.payments.load();

    // =========================================================================
    // Test 2: Split + PROXY (alice -> bob, 1 UCT from 99)
    // =========================================================================
    console.log('--- TEST 2: Split + PROXY ---');
    measurements.push(await measureTransfer({
      label: '2. Split + PROXY (alice->bob 1 UCT)',
      sender: alice, receiver: bob, receiverNametag: bobNametag,
      amount: '1', coinSymbol: 'UCT', mode: 'proxy', type: 'split',
    }));
    await new Promise(r => setTimeout(r, INTER_TEST_DELAY_MS));
    await alice.payments.load();
    await bob.payments.load();

    // =========================================================================
    // Test 3: Whole token + DIRECT (bob -> alice, send back 1 UCT - bob has 1 token)
    // =========================================================================
    console.log('--- TEST 3: Whole token + DIRECT ---');
    measurements.push(await measureTransfer({
      label: '3. Whole + DIRECT (bob->alice 1 UCT)',
      sender: bob, receiver: alice, receiverNametag: aliceNametag,
      amount: '1', coinSymbol: 'UCT', mode: 'direct', type: 'whole',
    }));
    await new Promise(r => setTimeout(r, INTER_TEST_DELAY_MS));
    await alice.payments.load();
    await bob.payments.load();

    // =========================================================================
    // Test 4: Whole token + PROXY (bob -> alice, send back 1 UCT)
    // =========================================================================
    // Bob needs another token. Alice sends 1 UCT to Bob (split), then Bob sends it back whole via PROXY.
    console.log('--- PREP: Send 1 UCT to Bob for whole-token PROXY test ---');
    await alice.payments.send({
      recipient: `@${bobNametag}`,
      amount: parseAmount('1', 18).toString(),
      coinId: TokenRegistry.getInstance().getDefinitionBySymbol('UCT')!.id,
      addressMode: 'direct',
    });
    await new Promise(r => setTimeout(r, INTER_TEST_DELAY_MS));
    await alice.payments.load();
    await bob.payments.load();

    // Wait for Bob to receive
    const deadline = performance.now() + TRANSFER_TIMEOUT_MS;
    while (performance.now() < deadline) {
      await bob.payments.load();
      if (getBalance(bob, 'UCT').total > 0n) break;
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
    await new Promise(r => setTimeout(r, INTER_TEST_DELAY_MS));

    console.log('--- TEST 4: Whole token + PROXY ---');
    measurements.push(await measureTransfer({
      label: '4. Whole + PROXY (bob->alice 1 UCT)',
      sender: bob, receiver: alice, receiverNametag: aliceNametag,
      amount: '1', coinSymbol: 'UCT', mode: 'proxy', type: 'whole',
    }));
    await new Promise(r => setTimeout(r, INTER_TEST_DELAY_MS));
    await alice.payments.load();
    await bob.payments.load();

    // =========================================================================
    // Test 5 & 6: Repeat split DIRECT & PROXY for second sample
    // =========================================================================
    console.log('--- TEST 5: Split + DIRECT (2nd sample) ---');
    measurements.push(await measureTransfer({
      label: '5. Split + DIRECT (alice->bob 0.5 UCT)',
      sender: alice, receiver: bob, receiverNametag: bobNametag,
      amount: '0.5', coinSymbol: 'UCT', mode: 'direct', type: 'split',
    }));
    await new Promise(r => setTimeout(r, INTER_TEST_DELAY_MS));
    await alice.payments.load();
    await bob.payments.load();

    console.log('--- TEST 6: Split + PROXY (2nd sample) ---');
    measurements.push(await measureTransfer({
      label: '6. Split + PROXY (alice->bob 0.5 UCT)',
      sender: alice, receiver: bob, receiverNametag: bobNametag,
      amount: '0.5', coinSymbol: 'UCT', mode: 'proxy', type: 'split',
    }));

    // =========================================================================
    // Report
    // =========================================================================
    printReport(measurements);

  } catch (error) {
    console.error(`\nFATAL ERROR: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.stack) console.error(error.stack);
  } finally {
    if (alice) { try { await alice.destroy(); } catch { /* */ } }
    if (bob) { try { await bob.destroy(); } catch { /* */ } }
    if (doCleanup) {
      const aliceDir = `./.sphere-cli-${aliceProfile}`;
      const bobDir = `./.sphere-cli-${bobProfile}`;
      await rm(aliceDir, { recursive: true, force: true });
      await rm(bobDir, { recursive: true, force: true });
      console.log('Cleaned up test directories.');
    }
  }

  const allPassed = measurements.length > 0 && measurements.every(m => m.success);
  process.exit(allPassed ? 0 : 1);
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
