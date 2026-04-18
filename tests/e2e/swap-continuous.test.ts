/**
 * E2E: Continuous-process swap test — full lifecycle.
 *
 * Validates the bug report: "Swap DM Delivery Failure in Long-Running Processes"
 * by running ALL swap participants as persistent processes:
 *
 * - Alice and Bob: two Sphere SDK instances in this Node.js process (long-running)
 * - Escrow: launched as a child process (long-running, same as production)
 *
 * Tests the complete swap lifecycle:
 *   propose → accept → announce → deposit (both) → complete
 *
 * This specifically tests that the chat subscription health check keeps
 * NIP-17 gift-wrap subscriptions alive so swap DMs are delivered in real-time.
 *
 * Skipped unless RUN_CONTINUOUS_TESTS=1 (requires network + testnet relay + escrow).
 *
 * Usage:
 *   RUN_CONTINUOUS_TESTS=1 npx vitest run tests/e2e/swap-continuous.test.ts
 *
 *   With escrow path override:
 *   RUN_CONTINUOUS_TESTS=1 ESCROW_DIR=/path/to/escrow-service npx vitest run tests/e2e/swap-continuous.test.ts
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { Sphere } from '../../core/Sphere';
import { execSync, spawn, ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  makeTempDirs,
  makeProviders,
  ensureTrustbase,
  requestFaucet,
  waitForTokens,
  getBalance,
  rand,
} from './helpers';

const SKIP = !process.env.RUN_CONTINUOUS_TESTS;
const ESCROW_SRC = process.env.ESCROW_DIR || join(__dirname, '../../../../escrow-service');
const SDK_ROOT = join(__dirname, '../..');

// Timeouts
const ESCROW_STARTUP_TIMEOUT = 60_000;
const FAUCET_TIMEOUT = 120_000;
const EVENT_TIMEOUT = 60_000;
const SWAP_COMPLETE_TIMEOUT = 180_000; // 3 min — aggregator confirmation can be slow on testnet
const FULL_TEST_TIMEOUT = 600_000;   // 10 min total — includes deposit confirmation + payout delivery

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wait for an event on a Sphere instance with timeout. */
function waitForEvent<T>(sphere: Sphere, event: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${event}`)), timeoutMs);
    const unsub = (sphere as any).on(event, (data: T) => {
      clearTimeout(timer);
      unsub();
      resolve(data);
    });
  });
}

/** Poll swap progress until it reaches a target state. */
async function waitForProgress(
  sphere: Sphere,
  swapId: string,
  targets: string[],
  timeoutMs: number,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const status = await (sphere as any).swap.getSwapStatus(swapId);
      if (targets.includes(status?.progress)) return status.progress;
    } catch {
      // swap may not exist yet on this side
    }
    await sleep(2000);
  }
  throw new Error(`Timeout waiting for swap ${swapId.slice(0, 8)} to reach ${targets.join('|')}`);
}

describe.skipIf(SKIP)('Continuous-process swap E2E (full lifecycle)', () => {
  let workspace: string;
  let escrowDir: string;
  let escrowProcess: ChildProcess | null = null;
  let escrowNametag: string;
  let aliceSphere: Sphere | null = null;
  let bobSphere: Sphere | null = null;
  let escrowLogFd: number | null = null;

  beforeAll(async () => {
    // Create workspace
    workspace = join(tmpdir(), `swap-continuous-${Date.now()}-${rand()}`);
    mkdirSync(workspace, { recursive: true });

    // Copy escrow service
    escrowDir = join(workspace, 'escrow');
    console.log(`Copying escrow from ${ESCROW_SRC} to ${escrowDir}...`);
    cpSync(ESCROW_SRC, escrowDir, { recursive: true, filter: (src) => !src.includes('node_modules') && !src.includes('.sphere-escrow') && !src.includes('.escrow-data') });

    // Patch escrow to use local SDK
    const pkgPath = join(escrowDir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    pkg.dependencies['@unicitylabs/sphere-sdk'] = `file:${SDK_ROOT}`;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

    // Install
    console.log('Installing escrow dependencies...');
    execSync('npm install', { cwd: escrowDir, stdio: 'pipe', timeout: 60_000 });

    // Generate .env
    escrowNametag = `esc-cont-${rand()}`;
    writeFileSync(join(escrowDir, '.env'), [
      'NODE_ENV=development',
      'LOG_LEVEL=info',
      'SPHERE_WALLET_PATH=./.sphere-escrow',
      'SPHERE_NETWORK=testnet',
      `SPHERE_NAMETAG=${escrowNametag}`,
      'ESCROW_DATA_DIR=./.escrow-data',
      'MAX_PENDING_SWAPS=100',
    ].join('\n') + '\n');

    // Launch escrow as a persistent process
    console.log(`Launching escrow @${escrowNametag}...`);
    const escrowLog = join(workspace, 'escrow.log');
    escrowLogFd = require('fs').openSync(escrowLog, 'w');
    escrowProcess = spawn('npx', ['tsx', '--env-file=.env', 'src/index.ts'], {
      cwd: escrowDir,
      stdio: ['ignore', escrowLogFd, escrowLogFd],
      detached: true,
    });

    // Wait for escrow to start
    const startTime = Date.now();
    while (Date.now() - startTime < ESCROW_STARTUP_TIMEOUT) {
      if (existsSync(escrowLog)) {
        const log = readFileSync(escrowLog, 'utf8');
        if (log.includes('Escrow service started successfully')) {
          console.log(`Escrow ready in ${Math.round((Date.now() - startTime) / 1000)}s`);
          break;
        }
        if (log.includes('FATAL')) {
          throw new Error(`Escrow failed to start:\n${log.slice(-500)}`);
        }
      }
      await sleep(1000);
    }
  }, ESCROW_STARTUP_TIMEOUT + 30_000);

  afterAll(async () => {
    // Destroy Sphere instances
    if (aliceSphere) await aliceSphere.destroy().catch(() => {});
    if (bobSphere) await bobSphere.destroy().catch(() => {});

    // Kill escrow process group
    if (escrowProcess?.pid) {
      try { process.kill(-escrowProcess.pid, 'SIGTERM'); } catch { /* ignore */ }
      await sleep(2000);
      try { process.kill(-escrowProcess.pid, 'SIGKILL'); } catch { /* ignore */ }
    }

    // Close escrow log fd
    if (escrowLogFd !== null) {
      try { require('fs').closeSync(escrowLogFd); } catch { /* ignore */ }
      escrowLogFd = null;
    }

    // Preserve escrow log on failure (for diagnosis)
    if (existsSync(join(workspace, 'escrow.log'))) {
      const preserved = `/tmp/escrow-continuous-${Date.now()}.log`;
      cpSync(join(workspace, 'escrow.log'), preserved);
      console.log(`Escrow log: ${preserved}`);
    }
  });

  it('full swap lifecycle between two long-running SDK instances + escrow', async () => {
    const suffix = rand();
    const aliceTag = `alice-cont-${suffix}`;
    const bobTag = `bob-cont-${suffix}`;

    // ── Create Alice (long-running) ──
    console.log(`\n=== Creating Alice @${aliceTag} ===`);
    const aliceDirs = makeTempDirs(`alice-${suffix}`);
    await ensureTrustbase(aliceDirs.dataDir);
    const aliceProviders = makeProviders(aliceDirs);
    const aliceInit = await Sphere.init({
      ...aliceProviders,
      autoGenerate: true,
      nametag: aliceTag,
      accounting: true,
      swap: true,
    });
    aliceSphere = aliceInit.sphere;
    console.log(`Alice: @${aliceTag} — ${aliceSphere.identity!.directAddress?.slice(0, 40)}...`);

    // ── Create Bob (long-running) ──
    console.log(`=== Creating Bob @${bobTag} ===`);
    const bobDirs = makeTempDirs(`bob-${suffix}`);
    await ensureTrustbase(bobDirs.dataDir);
    const bobProviders = makeProviders(bobDirs);
    const bobInit = await Sphere.init({
      ...bobProviders,
      autoGenerate: true,
      nametag: bobTag,
      accounting: true,
      swap: true,
    });
    bobSphere = bobInit.sphere;
    console.log(`Bob: @${bobTag} — ${bobSphere.identity!.directAddress?.slice(0, 40)}...`);

    // ── Fund both parties (10x swap amount) ──
    // Faucet amounts are in whole coins (the faucet converts to smallest units internally).
    // 10 BTC → 10 * 10^8 = 1000000000 smallest units. Swap needs 1 BTC = 100000000.
    console.log('\n=== Funding via faucet ===');
    await requestFaucet(aliceTag, 'bitcoin', 10);   // 10 BTC (swap needs 1)
    await requestFaucet(bobTag, 'ethereum', 100);    // 100 ETH (swap needs 10)

    console.log('Waiting for Alice BTC...');
    await waitForTokens(aliceSphere, 'BTC', 1n, FAUCET_TIMEOUT);
    const aliceBTCBefore = getBalance(aliceSphere, 'BTC');
    console.log(`Alice BTC before: ${aliceBTCBefore.total} (${aliceBTCBefore.tokens} tokens)`);

    console.log('Waiting for Bob ETH...');
    await waitForTokens(bobSphere, 'ETH', 1n, FAUCET_TIMEOUT);
    const bobETHBefore = getBalance(bobSphere, 'ETH');
    console.log(`Bob ETH before: ${bobETHBefore.total} (${bobETHBefore.tokens} tokens)`);

    // ── Ping escrow ──
    console.log('\n=== Pinging escrow ===');
    const pong = await (aliceSphere as any).swap.pingEscrow(`@${escrowNametag}`, 30_000);
    console.log(`Escrow responded: ${JSON.stringify(pong)}`);

    // ── Alice proposes swap ──
    console.log('\n=== Alice proposes swap: 1 BTC ↔ 10 ETH ===');
    const proposalPromise = waitForEvent(bobSphere, 'swap:proposal_received', EVENT_TIMEOUT);

    const dealStart = performance.now();
    // Swap 1/10th of the balance. This tests token splitting — the deposit
    // must split the token and preserve the change (9/10th remains).
    const aliceSwapAmount = aliceBTCBefore.total / 10n;  // 1 BTC out of 10
    const bobSwapAmount = bobETHBefore.total / 10n;      // 10 ETH out of 100
    console.log(`Swap amounts: Alice offers ${aliceSwapAmount} BTC, wants ${bobSwapAmount} ETH`);

    // Use directAddress for partyA (avoids nametag resolution delay) and
    // nametag for partyB (tests cross-format resolution).
    const proposal = await (aliceSphere as any).swap.proposeSwap({
      partyA: aliceSphere.identity!.directAddress!,
      partyB: `@${bobTag}`,
      partyACurrency: 'BTC',
      partyAAmount: aliceSwapAmount.toString(),
      partyBCurrency: 'ETH',
      partyBAmount: bobSwapAmount.toString(),
      timeout: 3600,
      escrowAddress: `@${escrowNametag}`,
    });
    const swapId = proposal.swapId;
    console.log(`Proposed: ${swapId.slice(0, 16)}...`);

    // ── Bob receives proposal (DM delivery test) ──
    const proposalEvent = await proposalPromise as { swapId: string };
    const deliveryMs = Math.round(performance.now() - dealStart);
    console.log(`Bob received proposal in ${deliveryMs}ms`);
    expect(proposalEvent.swapId).toBe(swapId);
    expect(deliveryMs).toBeLessThan(EVENT_TIMEOUT);

    // ── Bob accepts ──
    console.log('\n=== Bob accepts ===');
    await (bobSphere as any).swap.acceptSwap(swapId);
    console.log('Bob accepted');

    // ── Wait for both to reach 'announced' ──
    console.log('Waiting for announced state...');
    await Promise.all([
      waitForProgress(aliceSphere, swapId, ['announced', 'depositing', 'concluding', 'completed'], EVENT_TIMEOUT),
      waitForProgress(bobSphere, swapId, ['announced', 'depositing', 'concluding', 'completed'], EVENT_TIMEOUT),
    ]);
    console.log('Both parties reached announced');

    // ── Both deposit (with retry — deposit invoice may not have arrived yet) ──
    console.log('\n=== Deposits ===');
    async function depositWithRetry(sphere: Sphere, label: string): Promise<any> {
      const deadline = Date.now() + EVENT_TIMEOUT;
      while (Date.now() < deadline) {
        try {
          return await (sphere as any).swap.deposit(swapId);
        } catch (err: any) {
          if (err?.code === 'SWAP_WRONG_STATE' && err.message?.includes('not yet available')) {
            console.log(`  ${label}: deposit invoice not ready, retrying in 3s...`);
            await sleep(3000);
            continue;
          }
          throw err;
        }
      }
      throw new Error(`${label}: deposit timed out waiting for invoice`);
    }
    const [bobDeposit, aliceDeposit] = await Promise.all([
      depositWithRetry(bobSphere, 'Bob'),
      depositWithRetry(aliceSphere, 'Alice'),
    ]);
    console.log(`Alice deposit: ${aliceDeposit.status}`);
    console.log(`Bob deposit: ${bobDeposit.status}`);

    // Wait for background split to complete (change token creation)
    await aliceSphere.payments.waitForPendingOperations();
    await bobSphere.payments.waitForPendingOperations();

    // ── Verify change tokens survived deposit (token split correctness) ──
    console.log('\n=== Verifying change tokens after deposit ===');
    const aliceBTCAfterDeposit = getBalance(aliceSphere, 'BTC');
    const bobETHAfterDeposit = getBalance(bobSphere, 'ETH');
    const expectedAliceBTCRemaining = aliceBTCBefore.total - aliceSwapAmount;
    const expectedBobETHRemaining = bobETHBefore.total - bobSwapAmount;
    console.log(`Alice BTC: ${aliceBTCAfterDeposit.total} (expected ${expectedAliceBTCRemaining})`);
    console.log(`Bob ETH: ${bobETHAfterDeposit.total} (expected ${expectedBobETHRemaining})`);
    expect(aliceBTCAfterDeposit.total).toBe(expectedAliceBTCRemaining);
    expect(bobETHAfterDeposit.total).toBe(expectedBobETHRemaining);

    // ── Wait for swap completion ──
    // The escrow needs to: confirm deposits (aggregator round-trip) → close deposit invoice
    // → create payout invoices → pay payouts → complete. This can take 60-120s on testnet.
    console.log('\n=== Waiting for completion ===');
    async function waitWithLog(sphere: Sphere, label: string): Promise<string> {
      const start = Date.now();
      let lastProgress = '';
      while (Date.now() - start < SWAP_COMPLETE_TIMEOUT) {
        try {
          const status = await (sphere as any).swap.getSwapStatus(swapId);
          if (status?.progress !== lastProgress) {
            lastProgress = status?.progress;
            console.log(`  ${label}: ${lastProgress} [${Math.round((Date.now() - start) / 1000)}s]`);
          }
          if (['completed', 'failed', 'cancelled'].includes(status?.progress)) {
            return status.progress;
          }
        } catch { /* swap may be pruned */ }
        await sleep(3000);
      }
      return lastProgress || 'unknown';
    }
    const [aliceFinal, bobFinal] = await Promise.all([
      waitWithLog(aliceSphere, 'Alice'),
      waitWithLog(bobSphere, 'Bob'),
    ]);
    console.log(`Alice: ${aliceFinal}, Bob: ${bobFinal}`);
    expect(aliceFinal).toBe('completed');
    expect(bobFinal).toBe('completed');

    // ── Verify payout tokens received ──
    // Poll receive() to pick up the payout invoice tokens delivered by the escrow.
    console.log('\n=== Verifying payout delivery ===');
    const payoutDeadline = Date.now() + SWAP_COMPLETE_TIMEOUT;
    let aliceGotETH = false;
    let bobGotBTC = false;
    while (Date.now() < payoutDeadline && (!aliceGotETH || !bobGotBTC)) {
      try { await aliceSphere.payments.receive({ finalize: true }); } catch { /* tolerate */ }
      try { await bobSphere.payments.receive({ finalize: true }); } catch { /* tolerate */ }

      if (!aliceGotETH && getBalance(aliceSphere, 'ETH').total > 0n) {
        aliceGotETH = true;
        console.log(`  ✓ Alice received ETH payout [${Math.round((Date.now() - payoutDeadline + SWAP_COMPLETE_TIMEOUT) / 1000)}s]`);
      }
      if (!bobGotBTC && getBalance(bobSphere, 'BTC').total > 0n) {
        bobGotBTC = true;
        console.log(`  ✓ Bob received BTC payout [${Math.round((Date.now() - payoutDeadline + SWAP_COMPLETE_TIMEOUT) / 1000)}s]`);
      }
      if (!aliceGotETH || !bobGotBTC) await sleep(3000);
    }

    const aliceFinalBTC = getBalance(aliceSphere, 'BTC');
    const aliceFinalETH = getBalance(aliceSphere, 'ETH');
    const bobFinalBTC = getBalance(bobSphere, 'BTC');
    const bobFinalETH = getBalance(bobSphere, 'ETH');
    console.log(`\nFinal balances:`);
    console.log(`  Alice: BTC=${aliceFinalBTC.total} (was ${aliceBTCBefore.total}) ETH=${aliceFinalETH.total} (was 0)`);
    console.log(`  Bob:   BTC=${bobFinalBTC.total} (was 0) ETH=${bobFinalETH.total} (was ${bobETHBefore.total})`);

    // HARD assertions — verify exact payout amounts
    // Alice: deposited aliceSwapAmount BTC, should receive bobSwapAmount ETH
    expect(aliceFinalETH.total).toBe(bobSwapAmount);
    // Bob: deposited bobSwapAmount ETH, should receive aliceSwapAmount BTC
    expect(bobFinalBTC.total).toBe(aliceSwapAmount);

    // Alice should still have her change (original - deposited)
    expect(aliceFinalBTC.total).toBe(aliceBTCBefore.total - aliceSwapAmount);
    // Bob should still have his change (original - deposited)
    expect(bobFinalETH.total).toBe(bobETHBefore.total - bobSwapAmount);

    console.log('\n✅ Full continuous-process swap lifecycle verified:');
    console.log(`   Alice: -${aliceSwapAmount} BTC, +${bobSwapAmount} ETH`);
    console.log(`   Bob:   -${bobSwapAmount} ETH, +${aliceSwapAmount} BTC`);
  }, FULL_TEST_TIMEOUT);

  it('DM delivery latency between long-running instances', async () => {
    // Use the already-running Alice and Bob from the previous test
    if (!aliceSphere || !bobSphere) {
      expect.fail('Alice/Bob not initialized — previous test may have failed or been skipped');
    }

    // Send a DM from Alice to Bob and measure delivery time
    console.log('\n=== DM latency measurement ===');

    const dmPromise = new Promise<number>((resolve, reject) => {
      const start = performance.now();
      const timer = setTimeout(() => reject(new Error('DM not received within 30s')), 30_000);
      const unsub = bobSphere!.communications.onDirectMessage((dm) => {
        if (dm.content === 'latency-ping') {
          clearTimeout(timer);
          unsub();
          resolve(Math.round(performance.now() - start));
        }
      });
    });

    const bobPubkey = bobSphere.identity!.chainPubkey;
    await aliceSphere.communications.sendDM(bobPubkey, 'latency-ping');

    const latencyMs = await dmPromise;
    console.log(`DM delivery latency: ${latencyMs}ms`);
    expect(latencyMs).toBeLessThan(30_000);
  }, 60_000);
});
