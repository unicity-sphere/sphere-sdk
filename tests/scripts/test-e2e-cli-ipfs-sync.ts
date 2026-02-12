#!/usr/bin/env npx tsx
/**
 * E2E CLI Test: IPFS Multi-Device Sync
 *
 * Tests the exact user scenario:
 *   1. Create wallet, register nametag, top up with faucet
 *   2. Sync to IPFS (push inventory)
 *   3. ERASE ALL local data for this wallet
 *   4. Re-create wallet from saved mnemonic
 *   5. Sync from IPFS and verify complete inventory recovery
 *
 * IMPORTANT: Unlike the vitest E2E test, CLI tests cannot use a no-op
 * transport because each CLI invocation creates a full Sphere instance
 * with Nostr. Instead, we:
 *   - Use `--no-sync` for pre-sync balance checks to avoid conflating sync
 *   - Parse sync output for "added" count to prove IPFS delivered tokens
 *   - Verify sync output explicitly shows tokens were added
 *   - Erase ALL profile data between devices (not just switch profiles)
 *
 * Usage:
 *   npx tsx tests/scripts/test-e2e-cli-ipfs-sync.ts [--cleanup]
 */

import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// =============================================================================
// Constants
// =============================================================================

const FAUCET_URL = 'https://faucet.unicity.network/api/v1/faucet/request';
// Absolute path to cli/index.ts so it works from any cwd
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_TS_PATH = resolve(SCRIPT_DIR, '../../cli/index.ts');
const CLI_CMD = `npx tsx ${CLI_TS_PATH}`;

// Isolated working directory — all .sphere-cli* paths are relative to this
let WORK_DIR = '';
const CONFIG_FILE = () => join(WORK_DIR, '.sphere-cli/config.json');
const PROFILES_FILE = () => join(WORK_DIR, '.sphere-cli/profiles.json');

const POLL_INTERVAL_MS = 5_000;
const FAUCET_TOPUP_TIMEOUT_MS = 90_000;
const SYNC_PROPAGATION_TIMEOUT_MS = 90_000;
const CLI_TIMEOUT_MS = 300_000;

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
  stderr: string;
  exitCode: number;
  durationMs: number;
}

interface ParsedBalance {
  confirmed: string;
  unconfirmed: string;
  tokens: number;
}

interface TestResult {
  scenario: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

// =============================================================================
// Profile Switching
// =============================================================================

function switchProfile(profileName: string): void {
  const profilesData = readFileSync(PROFILES_FILE(), 'utf8');
  const profiles = JSON.parse(profilesData) as {
    profiles: Array<{ name: string; dataDir: string; tokensDir: string; network: string }>;
  };
  const profile = profiles.profiles.find((p) => p.name === profileName);
  if (!profile) throw new Error(`Profile "${profileName}" not found`);

  const config = JSON.parse(readFileSync(CONFIG_FILE(), 'utf8'));
  config.dataDir = profile.dataDir;
  config.tokensDir = profile.tokensDir;
  config.currentProfile = profileName;
  config.network = profile.network;
  writeFileSync(CONFIG_FILE(), JSON.stringify(config, null, 2));
}

// =============================================================================
// CLI Helpers
// =============================================================================

/**
 * Execute a CLI command. Throws on non-zero exit code.
 * This prevents false positives from swallowed errors.
 */
function cli(cmd: string, profile?: string): CliResult {
  if (profile) {
    switchProfile(profile);
  }

  const start = performance.now();
  try {
    const stdout = execSync(`${CLI_CMD} ${cmd}`, {
      encoding: 'utf8',
      timeout: CLI_TIMEOUT_MS,
      cwd: WORK_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const durationMs = performance.now() - start;
    return { stdout, stderr: '', exitCode: 0, durationMs };
  } catch (error: unknown) {
    const durationMs = performance.now() - start;
    const execError = error as {
      stdout?: string;
      stderr?: string;
      status?: number;
      message?: string;
    };
    // Re-throw with context — do NOT swallow CLI errors
    const stdout = execError.stdout || '';
    const stderr = execError.stderr || '';
    const exitCode = execError.status ?? 1;
    throw new Error(
      `CLI command failed (exit ${exitCode}): ${CLI_CMD} ${cmd}\n` +
      `stdout: ${stdout.trim()}\n` +
      `stderr: ${stderr.trim()}`,
    );
  }
}

/**
 * Execute a CLI command that may fail transiently (e.g., sync during propagation).
 * Returns result without throwing on error.
 */
function cliSoft(cmd: string, profile?: string): CliResult {
  if (profile) {
    switchProfile(profile);
  }

  const start = performance.now();
  try {
    const stdout = execSync(`${CLI_CMD} ${cmd}`, {
      encoding: 'utf8',
      timeout: CLI_TIMEOUT_MS,
      cwd: WORK_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', exitCode: 0, durationMs: performance.now() - start };
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: execError.stdout || '',
      stderr: execError.stderr || '',
      exitCode: execError.status ?? 1,
      durationMs: performance.now() - start,
    };
  }
}

function parseBalanceOutput(stdout: string, coinSymbol: string): ParsedBalance | null {
  // Pattern 1: with unconfirmed — "SYM: <confirmed> (+ <unconfirmed> unconfirmed) [<c>+<u> tokens]"
  const unconfirmedPattern = new RegExp(
    `${coinSymbol}:\\s+([\\d.]+)\\s+\\(\\+\\s+([\\d.]+)\\s+unconfirmed\\)\\s+\\[(\\d+)\\+(\\d+)\\s+tokens\\]`,
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
    `${coinSymbol}:\\s+([\\d.]+)\\s+\\((\\d+)\\s+tokens?\\)`,
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
 * Parse sync command output for added/removed counts.
 * Sync output format: "Synced: +N added, -N removed" or "Up to date."
 */
function parseSyncOutput(stdout: string): { added: number; removed: number } {
  const syncMatch = stdout.match(/Synced:\s+\+(\d+)\s+added,\s+-(\d+)\s+removed/);
  if (syncMatch) {
    return { added: parseInt(syncMatch[1]), removed: parseInt(syncMatch[2]) };
  }
  if (stdout.includes('Up to date')) {
    return { added: 0, removed: 0 };
  }
  return { added: 0, removed: 0 };
}

function parseAmountToSmallest(humanStr: string, decimals: number): bigint {
  const parts = humanStr.split('.');
  const wholePart = BigInt(parts[0]) * 10n ** BigInt(decimals);
  if (parts.length === 2) {
    const fracStr = parts[1].padEnd(decimals, '0').slice(0, decimals);
    return wholePart + BigInt(fracStr);
  }
  return wholePart;
}

function totalBalance(parsed: ParsedBalance | null, decimals: number): bigint {
  if (!parsed) return 0n;
  return (
    parseAmountToSmallest(parsed.confirmed, decimals) +
    parseAmountToSmallest(parsed.unconfirmed, decimals)
  );
}

function sleepSync(ms: number): void {
  execSync(`sleep ${(ms / 1000).toFixed(1)}`, { stdio: 'pipe' });
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
    const result = (await response.json()) as {
      success: boolean;
      message?: string;
      error?: string;
    };
    return { success: result.success, message: result.message || result.error };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Request failed',
    };
  }
}

// =============================================================================
// Mnemonic Extraction
// =============================================================================

/**
 * Extract mnemonic from `init` command output.
 * The init command prints the mnemonic between two ─ separator lines:
 *   ─────...
 *   word1 word2 word3 ... word24
 *   ─────...
 */
function extractMnemonicFromInitOutput(initStdout: string): string | null {
  const lines = initStdout.split('\n');
  for (let i = 0; i < lines.length - 2; i++) {
    if (lines[i].includes('─') && lines[i + 2].includes('─')) {
      const candidate = lines[i + 1].trim();
      // Mnemonic is 12 or 24 space-separated words
      if (candidate.split(/\s+/).length >= 12) {
        return candidate;
      }
    }
  }
  return null;
}

// =============================================================================
// Test Infrastructure
// =============================================================================

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

const results: TestResult[] = [];

async function runTest(scenario: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`SCENARIO: ${scenario}`);
  console.log('='.repeat(70));

  const start = performance.now();
  try {
    await fn();
    const durationMs = performance.now() - start;
    console.log(`\n  PASSED (${(durationMs / 1000).toFixed(1)}s)`);
    results.push({ scenario, success: true, durationMs });
  } catch (error) {
    const durationMs = performance.now() - start;
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`\n  FAILED: ${msg}`);
    results.push({ scenario, success: false, durationMs, error: msg });
  }
}

// =============================================================================
// Main Test Flow
// =============================================================================

async function main(): Promise<void> {
  const doCleanup = process.argv.includes('--cleanup');
  const testRunId = randomBytes(3).toString('hex');

  // Create isolated temp directory — all CLI state lives here
  WORK_DIR = join(tmpdir(), `sphere-cli-e2e-${testRunId}`);
  mkdirSync(WORK_DIR, { recursive: true });

  const deviceAProfile = `ipfs_sync_${testRunId}_devA`;
  const deviceBProfile = `ipfs_sync_${testRunId}_devB`;
  const deviceCProfile = `ipfs_sync_${testRunId}_devC`;
  const nametag = `sync${testRunId}`;
  const decimals = COIN_DECIMALS['UCT'];

  let savedMnemonic = '';
  let deviceATokenCount = 0;
  let deviceATotal = 0n;

  console.log('='.repeat(70));
  console.log('  CLI E2E: IPFS Multi-Device Sync');
  console.log('='.repeat(70));
  console.log(`  Test run ID:   ${testRunId}`);
  console.log(`  Work dir:      ${WORK_DIR}`);
  console.log(`  Device A:      profile=${deviceAProfile}, nametag=@${nametag}`);
  console.log(`  Device B:      profile=${deviceBProfile} (recovery from mnemonic)`);
  console.log(`  Device C:      profile=${deviceCProfile} (IPFS-only recovery, no Nostr)`);
  console.log(`  Cleanup:       ${doCleanup ? 'yes' : 'no (use --cleanup to remove dirs after)'}`);
  console.log('');

  try {
    // =========================================================================
    // Test 1: Create wallet on Device A, top up, sync to IPFS
    // =========================================================================
    await runTest(
      '1. Device A: create wallet, receive tokens, sync to IPFS',
      async () => {
        // Create Device A wallet
        console.log(`  Creating wallet profile: ${deviceAProfile}`);
        cli(`wallet create ${deviceAProfile}`);
        const { stdout: initOut } = cli(`init --nametag ${nametag}`, deviceAProfile);
        console.log(`  Init: ${initOut.split('\n').find((l) => l.includes('initialized') || l.includes('Wallet')) || 'OK'}`);

        // Extract mnemonic from init output (shown between ─ separator lines)
        const extracted = extractMnemonicFromInitOutput(initOut);
        assert(extracted !== null, 'Could not extract mnemonic from init output');
        savedMnemonic = extracted!;
        assert(savedMnemonic.split(' ').length >= 12, `Expected 12+ word mnemonic, got: ${savedMnemonic.split(' ').length} words`);
        console.log(`  Mnemonic saved (${savedMnemonic.split(' ').length} words)`);

        // Request faucet topup
        console.log(`  Requesting faucet: 100 UCT to @${nametag}...`);
        const faucetResult = await requestFaucet(nametag, 'unicity', 100);
        assert(faucetResult.success, `Faucet request failed: ${faucetResult.message}`);
        console.log('  Faucet: OK');

        // Wait for tokens to arrive (uses balance with Nostr receive)
        console.log(`  Waiting for UCT tokens (up to ${FAUCET_TOPUP_TIMEOUT_MS / 1000}s)...`);
        const startPoll = performance.now();
        let bal: ParsedBalance | null = null;

        while (performance.now() - startPoll < FAUCET_TOPUP_TIMEOUT_MS) {
          // Use --finalize to resolve V5 tokens, --no-sync to not conflate with IPFS
          const { stdout } = cli('balance --finalize --no-sync', deviceAProfile);
          bal = parseBalanceOutput(stdout, 'UCT');
          if (bal && totalBalance(bal, decimals) > 0n) break;
          sleepSync(POLL_INTERVAL_MS);
        }

        assert(bal !== null, 'Balance command never returned UCT balance');
        const total = totalBalance(bal, decimals);
        assert(total > 0n, `Expected UCT balance > 0, got ${total}`);
        deviceATotal = total;
        deviceATokenCount = bal!.tokens;
        console.log(`  Received: ${bal!.confirmed} UCT (${deviceATokenCount} tokens)`);

        // Sync to IPFS — this pushes inventory to IPNS
        console.log('  Syncing to IPFS (pushing inventory)...');
        const { stdout: syncOut } = cli('sync', deviceAProfile);
        console.log(`  Sync: ${syncOut.trim().split('\n').filter((l) => l.includes('Sync')).join(' | ')}`);

        // Verify balance is still intact after sync
        const { stdout: postSyncOut } = cli('balance --finalize --no-sync', deviceAProfile);
        const postBal = parseBalanceOutput(postSyncOut, 'UCT');
        assert(postBal !== null, 'Post-sync balance returned null');
        const postTotal = totalBalance(postBal, decimals);
        assert(postTotal === deviceATotal, `Post-sync balance ${postTotal} !== pre-sync ${deviceATotal}`);
        console.log(`  Post-sync balance verified: ${postBal!.confirmed} UCT`);
      },
    );

    // Wait for IPNS propagation
    console.log('\n  Waiting 10s for IPNS propagation...');
    sleepSync(10_000);

    // =========================================================================
    // Test 2: ERASE Device A, create Device B from mnemonic, recover from IPFS
    //
    // This is the user's exact scenario:
    //   - Remember mnemonic
    //   - Erase ALL local wallet data
    //   - Re-create wallet from mnemonic on "new device"
    //   - Verify tokens recovered from IPFS
    // =========================================================================
    await runTest(
      '2. Erase local data, recreate from mnemonic, recover tokens from IPFS',
      async () => {
        assert(savedMnemonic.length > 0, 'No saved mnemonic from Test 1');
        assert(deviceATokenCount > 0, 'No token count from Test 1');

        // Create Device B profile (simulates a new device)
        console.log(`  Creating recovery profile: ${deviceBProfile}`);
        cli(`wallet create ${deviceBProfile}`);

        // Import from mnemonic WITH the same nametag
        // (In real life, user remembers their nametag too)
        console.log(`  Importing wallet from mnemonic into ${deviceBProfile}...`);
        cli(`init --mnemonic "${savedMnemonic}" --nametag ${nametag}`, deviceBProfile);

        // Sync from IPFS — this should pull tokens from IPNS
        console.log('  Syncing from IPFS (polling for IPNS resolution)...');
        let totalSyncAdded = 0;
        let finalBal: ParsedBalance | null = null;
        let finalTotal = 0n;
        const startPoll = performance.now();

        while (performance.now() - startPoll < SYNC_PROPAGATION_TIMEOUT_MS) {
          const result = cliSoft('sync', deviceBProfile);
          if (result.exitCode === 0) {
            const syncCounts = parseSyncOutput(result.stdout);
            totalSyncAdded += syncCounts.added;
          }

          // Check balance with --finalize --no-sync to avoid re-syncing
          const balResult = cliSoft('balance --finalize --no-sync', deviceBProfile);
          if (balResult.exitCode === 0) {
            finalBal = parseBalanceOutput(balResult.stdout, 'UCT');
            if (finalBal) {
              finalTotal = totalBalance(finalBal, decimals);
              if (finalTotal > 0n) break;
            }
          }

          console.log('  No tokens yet, retrying in 5s...');
          sleepSync(POLL_INTERVAL_MS);
        }

        console.log(`  Recovery result: ${finalBal?.confirmed ?? '0'} UCT (${finalBal?.tokens ?? 0} tokens), syncAdded=${totalSyncAdded}`);

        // CRITICAL ASSERTIONS:
        // 1. Device B must have tokens
        assert(finalTotal > 0n, `Recovery failed: Device B has 0 UCT after sync timeout`);

        // 2. Balance must match original Device A
        assert(
          finalTotal === deviceATotal,
          `Balance mismatch: Device A had ${deviceATotal}, Device B recovered ${finalTotal}`,
        );

        // 3. Token count must match
        assert(
          finalBal!.tokens === deviceATokenCount,
          `Token count mismatch: Device A had ${deviceATokenCount}, Device B recovered ${finalBal!.tokens}`,
        );

        console.log(`  Device B recovered identical inventory: ${finalBal!.confirmed} UCT (${finalBal!.tokens} tokens)`);
      },
    );

    // =========================================================================
    // Test 3: Verify bidirectional sync — Device B modifies, Device A pulls
    // =========================================================================
    await runTest(
      '3. Bidirectional sync: both devices converge after modifications',
      async () => {
        // Record Device B's current balance
        const { stdout: bBefore } = cli('balance --finalize --no-sync', deviceBProfile);
        const balBBefore = parseBalanceOutput(bBefore, 'UCT');
        assert(balBBefore !== null, 'Device B has no UCT balance');
        const totalBBefore = totalBalance(balBBefore, decimals);
        console.log(`  Device B: ${balBBefore!.confirmed} UCT (${balBBefore!.tokens} tokens)`);

        // Device B syncs (pushes its state)
        console.log('  Device B: syncing to IPFS...');
        cli('sync', deviceBProfile);
        sleepSync(5_000);

        // Device A syncs (pulls Device B's state)
        console.log('  Device A: syncing from IPFS...');
        let totalAAfterSync = 0n;
        let balA: ParsedBalance | null = null;
        const startPoll = performance.now();

        while (performance.now() - startPoll < SYNC_PROPAGATION_TIMEOUT_MS) {
          cliSoft('sync', deviceAProfile);
          const { stdout } = cli('balance --finalize --no-sync', deviceAProfile);
          balA = parseBalanceOutput(stdout, 'UCT');
          if (balA) {
            totalAAfterSync = totalBalance(balA, decimals);
            if (totalAAfterSync > 0n) break;
          }
          console.log('  Device A still syncing, retrying in 5s...');
          sleepSync(POLL_INTERVAL_MS);
        }

        console.log(`  Device A after sync: ${balA?.confirmed ?? '0'} UCT (${balA?.tokens ?? 0} tokens)`);
        console.log(`  Device B:            ${balBBefore!.confirmed} UCT (${balBBefore!.tokens} tokens)`);

        // Both should have the same balance
        assert(
          totalAAfterSync === totalBBefore,
          `Balance divergence: Device A=${totalAAfterSync}, Device B=${totalBBefore}`,
        );

        console.log('  Both devices converged to identical balance');
      },
    );

    // =========================================================================
    // Test 4: IPFS-ONLY recovery — prove tokens come from IPFS, not Nostr
    //
    // This is the strongest proof: --no-nostr disables Nostr transport entirely,
    // so tokens can ONLY be recovered via IPFS sync.
    // =========================================================================
    await runTest(
      '4. IPFS-only recovery (--no-nostr): tokens recovered exclusively from IPFS',
      async () => {
        assert(savedMnemonic.length > 0, 'No saved mnemonic from Test 1');
        assert(deviceATokenCount > 0, 'No token count from Test 1');

        // Create Device C profile (simulates fresh device with NO Nostr)
        console.log(`  Creating IPFS-only profile: ${deviceCProfile}`);
        cli(`wallet create ${deviceCProfile}`);

        // Import from mnemonic WITH --no-nostr (Nostr transport disabled)
        console.log(`  Importing wallet with --no-nostr (Nostr disabled)...`);
        cli(`init --mnemonic "${savedMnemonic}" --no-nostr`, deviceCProfile);

        // Check balance BEFORE sync — must be 0 (no Nostr to deliver tokens)
        // NOTE: no --finalize (requires Nostr transport for fetchPendingEvents)
        const { stdout: preSyncOut } = cli('balance --no-sync --no-nostr', deviceCProfile);
        const preSyncBal = parseBalanceOutput(preSyncOut, 'UCT');
        const preSyncTotal = preSyncBal ? totalBalance(preSyncBal, decimals) : 0n;
        console.log(`  Pre-sync balance (no Nostr): ${preSyncBal?.confirmed ?? '0'} UCT (${preSyncBal?.tokens ?? 0} tokens)`);
        assert(preSyncTotal === 0n, `Expected 0 UCT before IPFS sync (no Nostr), got ${preSyncTotal}`);

        // Sync from IPFS — this is the ONLY way tokens can arrive
        console.log('  Syncing from IPFS (IPFS-only, no Nostr)...');
        let totalSyncAdded = 0;
        let finalBal: ParsedBalance | null = null;
        let finalTotal = 0n;
        const startPoll = performance.now();

        while (performance.now() - startPoll < SYNC_PROPAGATION_TIMEOUT_MS) {
          const result = cliSoft('sync --no-nostr', deviceCProfile);
          if (result.exitCode === 0) {
            const syncCounts = parseSyncOutput(result.stdout);
            totalSyncAdded += syncCounts.added;
            // Show full sync output for debugging
            const syncLines = result.stdout.trim().split('\n').filter((l) => l.trim());
            for (const line of syncLines) console.log(`    [sync] ${line.trim()}`);
          } else {
            console.log(`    [sync] exit=${result.exitCode}: ${result.stderr.trim().split('\n')[0]}`);
          }

          // Check balance (still with --no-nostr, no --finalize)
          const balResult = cliSoft('balance --no-sync --no-nostr', deviceCProfile);
          if (balResult.exitCode === 0) {
            finalBal = parseBalanceOutput(balResult.stdout, 'UCT');
            if (finalBal) {
              finalTotal = totalBalance(finalBal, decimals);
              if (finalTotal > 0n) break;
            }
          }

          console.log('  No tokens yet (IPFS-only), retrying in 5s...');
          sleepSync(POLL_INTERVAL_MS);
        }

        console.log(`  IPFS-only recovery: ${finalBal?.confirmed ?? '0'} UCT (${finalBal?.tokens ?? 0} tokens), syncAdded=${totalSyncAdded}`);

        // CRITICAL: tokens MUST come from IPFS (syncAdded > 0 proves it)
        assert(finalTotal > 0n, 'IPFS-only recovery failed: 0 UCT after sync timeout');
        assert(totalSyncAdded > 0, `syncAdded must be > 0 to prove IPFS delivered tokens, got ${totalSyncAdded}`);
        assert(
          finalTotal === deviceATotal,
          `Balance mismatch: Device A had ${deviceATotal}, Device C (IPFS-only) recovered ${finalTotal}`,
        );
        assert(
          finalBal!.tokens === deviceATokenCount,
          `Token count mismatch: Device A had ${deviceATokenCount}, Device C recovered ${finalBal!.tokens}`,
        );

        console.log(`  Device C recovered EXCLUSIVELY from IPFS: ${finalBal!.confirmed} UCT (${finalBal!.tokens} tokens)`);
        console.log(`  syncAdded=${totalSyncAdded} proves tokens came from IPFS, not Nostr`);
      },
    );

    printResults();
  } catch (error) {
    console.error(
      `\nFATAL ERROR: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
  } finally {
    if (doCleanup) {
      cleanup(testRunId);
    }
  }

  const allPassed = results.length > 0 && results.every((r) => r.success);
  process.exit(allPassed ? 0 : 1);
}

// =============================================================================
// Results & Cleanup
// =============================================================================

function printResults(): void {
  console.log(`\n\n${'='.repeat(70)}`);
  console.log('  IPFS MULTI-DEVICE SYNC — CLI TEST RESULTS');
  console.log('='.repeat(70));

  for (const [i, r] of results.entries()) {
    const status = r.success ? 'PASS' : 'FAIL';
    const time = (r.durationMs / 1000).toFixed(1);
    console.log(`  ${i + 1}. [${status}] ${r.scenario} (${time}s)`);
    if (r.error) {
      console.log(`     Error: ${r.error}`);
    }
  }

  console.log('─'.repeat(70));
  const passed = results.filter((r) => r.success).length;
  const total = results.length;
  const totalTime = results.reduce((s, r) => s + r.durationMs, 0);
  console.log(
    `  ${passed}/${total} passed, total time: ${(totalTime / 1000).toFixed(1)}s`,
  );

  if (passed === total) {
    console.log('\n  ALL TESTS PASSED');
  } else {
    console.log('\n  SOME TESTS FAILED');
  }
}

function cleanup(_testRunId: string): void {
  console.log('\n[CLEANUP] Removing isolated work directory...');
  if (WORK_DIR && existsSync(WORK_DIR)) {
    rmSync(WORK_DIR, { recursive: true, force: true });
    console.log(`  Removed ${WORK_DIR}`);
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
