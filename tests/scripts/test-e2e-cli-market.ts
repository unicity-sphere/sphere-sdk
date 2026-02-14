#!/usr/bin/env npx tsx
/**
 * E2E CLI Market Module Test Script
 *
 * Exercises all market CLI commands (market-post, market-search, market-my,
 * market-close) against the live testnet Market API.
 *
 * Usage:
 *   npx tsx tests/scripts/test-e2e-cli-market.ts [--cleanup]
 */

import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

// =============================================================================
// Constants
// =============================================================================

const MARKET_API_URL = 'https://market-api.unicity.network';
const CLI_CMD = 'npx tsx cli/index.ts';
const CONFIG_FILE = '.sphere-cli/config.json';
const PROFILES_FILE = '.sphere-cli/profiles.json';

// =============================================================================
// Types
// =============================================================================

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

interface TestResult {
  name: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}

// =============================================================================
// Profile Switching (direct config file writes, no Sphere creation)
// =============================================================================

function switchProfile(profileName: string): void {
  const profilesData = readFileSync(PROFILES_FILE, 'utf8');
  const profiles = JSON.parse(profilesData) as {
    profiles: Array<{ name: string; dataDir: string; tokensDir: string; network: string }>;
  };
  const profile = profiles.profiles.find((p) => p.name === profileName);
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
  let stdout = '';
  let stderr = '';
  let exitCode = 0;

  try {
    stdout = execSync(`${CLI_CMD} ${cmd}`, {
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string; status?: number };
    stdout = execError.stdout ?? '';
    stderr = execError.stderr ?? '';
    exitCode = execError.status ?? 1;
  }

  const durationMs = performance.now() - start;
  return { stdout, stderr, exitCode, durationMs };
}

// =============================================================================
// Test Helpers
// =============================================================================

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertIncludes(haystack: string, needle: string, context: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`Expected output to include "${needle}" (${context}). Got:\n${haystack.slice(0, 500)}`);
  }
}

// =============================================================================
// Setup & Cleanup
// =============================================================================

function generateTestRunId(): string {
  return randomBytes(3).toString('hex');
}

function setupWallet(profile: string, nametag: string): void {
  console.log(`[SETUP] Creating wallet profile: ${profile}, nametag: @${nametag}`);
  cli(`wallet create ${profile}`);
  const { stdout, exitCode } = cli(`init --nametag ${nametag}`, profile);
  if (exitCode !== 0) {
    throw new Error(`Failed to initialize wallet: ${stdout}`);
  }
  console.log(`  Init: ${stdout.split('\n').find((l) => l.includes('initialized')) || 'OK'}`);
}

function cleanupProfiles(testRunId: string): void {
  const dir = `.sphere-cli-mkt_${testRunId}`;
  console.log(`\n[CLEANUP] Removing ${dir}`);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  console.log('  Done.');
}

// =============================================================================
// API Health Check
// =============================================================================

async function checkMarketApiAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${MARKET_API_URL}/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    const contentType = res.headers.get('content-type') ?? '';
    return res.ok && contentType.includes('application/json');
  } catch {
    return false;
  }
}

// =============================================================================
// Test Runner
// =============================================================================

async function main(): Promise<void> {
  const doCleanup = process.argv.includes('--cleanup');
  const testRunId = generateTestRunId();

  const profileName = `mkt_${testRunId}`;
  const nametag = `mkt${testRunId}`;

  console.log('='.repeat(70));
  console.log('  CLI E2E Market Module Test Suite');
  console.log('='.repeat(70));
  console.log(`  Test run ID:  ${testRunId}`);
  console.log(`  Profile:      ${profileName}`);
  console.log(`  Nametag:      @${nametag}`);
  console.log(`  Cleanup:      ${doCleanup ? 'yes' : 'no (use --cleanup to remove dirs after)'}`);
  console.log('');

  // Check if Market API is available
  console.log(`Checking Market API availability at ${MARKET_API_URL}...`);
  const apiAvailable = await checkMarketApiAvailable();
  if (!apiAvailable) {
    console.error('\nFAILED: Market API is not available at ' + MARKET_API_URL);
    console.error('Cannot run E2E market tests without a live Market API.');
    process.exit(1);
  }
  console.log('Market API is available.\n');

  const results: TestResult[] = [];
  let postedIntentId: string | undefined;

  try {
    // =========================================================================
    // Phase 1: Setup wallet
    // =========================================================================
    console.log('\n--- PHASE 1: WALLET SETUP ---\n');
    setupWallet(profileName, nametag);

    // =========================================================================
    // Phase 2: Test market commands
    // =========================================================================
    console.log('\n--- PHASE 2: MARKET COMMAND TESTS ---\n');

    // Test 1: market-post (buy intent)
    {
      const testName = 'market-post (buy)';
      console.log(`\n[TEST] ${testName}`);
      const start = performance.now();
      try {
        const desc = `Looking for 100 UCT tokens test-${testRunId}`;
        const { stdout, exitCode } = cli(
          `market-post "${desc}" --type buy --category tokens --price 100 --currency USD --contact @${nametag}`,
          profileName,
        );
        assert(exitCode === 0, `exit code was ${exitCode}`);
        assertIncludes(stdout, 'Intent posted', 'should confirm posting');
        assertIncludes(stdout, 'ID:', 'should show intent ID');

        // Parse intent ID for later close test
        const idMatch = stdout.match(/ID:\s*(\S+)/);
        if (idMatch) {
          postedIntentId = idMatch[1];
          console.log(`  Posted intent ID: ${postedIntentId}`);
        }

        const durationMs = performance.now() - start;
        console.log(`  PASS (${durationMs.toFixed(0)}ms)`);
        results.push({ name: testName, passed: true, durationMs });
      } catch (error) {
        const durationMs = performance.now() - start;
        const msg = error instanceof Error ? error.message : String(error);
        console.log(`  FAIL — ${msg}`);
        results.push({ name: testName, passed: false, durationMs, error: msg });
      }
    }

    // Test 2: market-post (sell intent)
    {
      const testName = 'market-post (sell)';
      console.log(`\n[TEST] ${testName}`);
      const start = performance.now();
      try {
        const desc = `Selling UCT tokens at market price test-${testRunId}`;
        const { stdout, exitCode } = cli(
          `market-post "${desc}" --type sell --category tokens --price 50 --currency USD`,
          profileName,
        );
        assert(exitCode === 0, `exit code was ${exitCode}`);
        assertIncludes(stdout, 'Intent posted', 'should confirm posting');
        const durationMs = performance.now() - start;
        console.log(`  PASS (${durationMs.toFixed(0)}ms)`);
        results.push({ name: testName, passed: true, durationMs });
      } catch (error) {
        const durationMs = performance.now() - start;
        const msg = error instanceof Error ? error.message : String(error);
        console.log(`  FAIL — ${msg}`);
        results.push({ name: testName, passed: false, durationMs, error: msg });
      }
    }

    // Test 3: market-search
    {
      const testName = 'market-search';
      console.log(`\n[TEST] ${testName}`);
      const start = performance.now();
      try {
        const { stdout, exitCode } = cli(
          `market-search "UCT tokens test-${testRunId}" --limit 10`,
          profileName,
        );
        assert(exitCode === 0, `exit code was ${exitCode}`);
        assertIncludes(stdout, 'Found', 'should show found count');
        // Should find at least one of our posted intents
        assertIncludes(stdout, 'intent', 'should show intent results');
        const durationMs = performance.now() - start;
        console.log(`  PASS (${durationMs.toFixed(0)}ms)`);
        results.push({ name: testName, passed: true, durationMs });
      } catch (error) {
        const durationMs = performance.now() - start;
        const msg = error instanceof Error ? error.message : String(error);
        console.log(`  FAIL — ${msg}`);
        results.push({ name: testName, passed: false, durationMs, error: msg });
      }
    }

    // Test 4: market-my
    {
      const testName = 'market-my';
      console.log(`\n[TEST] ${testName}`);
      const start = performance.now();
      try {
        const { stdout, exitCode } = cli('market-my', profileName);
        assert(exitCode === 0, `exit code was ${exitCode}`);
        assertIncludes(stdout, 'Your intents', 'should list own intents');
        // Should have at least 2 intents (the buy and sell we posted)
        const countMatch = stdout.match(/Your intents \((\d+)\)/);
        const count = countMatch ? parseInt(countMatch[1]) : 0;
        assert(count >= 2, `expected >= 2 intents, got ${count}`);
        const durationMs = performance.now() - start;
        console.log(`  PASS (${durationMs.toFixed(0)}ms) — ${count} intents found`);
        results.push({ name: testName, passed: true, durationMs });
      } catch (error) {
        const durationMs = performance.now() - start;
        const msg = error instanceof Error ? error.message : String(error);
        console.log(`  FAIL — ${msg}`);
        results.push({ name: testName, passed: false, durationMs, error: msg });
      }
    }

    // Test 5: market-close
    {
      const testName = 'market-close';
      console.log(`\n[TEST] ${testName}`);
      const start = performance.now();
      try {
        assert(!!postedIntentId, 'no intent ID from market-post test');
        const { stdout, exitCode } = cli(`market-close ${postedIntentId}`, profileName);
        assert(exitCode === 0, `exit code was ${exitCode}`);
        assertIncludes(stdout, 'closed', 'should confirm closing');
        const durationMs = performance.now() - start;
        console.log(`  PASS (${durationMs.toFixed(0)}ms)`);
        results.push({ name: testName, passed: true, durationMs });
      } catch (error) {
        const durationMs = performance.now() - start;
        const msg = error instanceof Error ? error.message : String(error);
        console.log(`  FAIL — ${msg}`);
        results.push({ name: testName, passed: false, durationMs, error: msg });
      }
    }

    // Test 6: market-my (after close)
    {
      const testName = 'market-my (after close)';
      console.log(`\n[TEST] ${testName}`);
      const start = performance.now();
      try {
        const { stdout, exitCode } = cli('market-my', profileName);
        assert(exitCode === 0, `exit code was ${exitCode}`);
        assertIncludes(stdout, 'Your intents', 'should list own intents');
        const countMatch = stdout.match(/Your intents \((\d+)\)/);
        const count = countMatch ? parseInt(countMatch[1]) : 0;
        // After closing one of two intents, we expect at least 1
        // (the closed one might still appear as "closed" or might be removed)
        console.log(`  Intent count after close: ${count}`);
        const durationMs = performance.now() - start;
        console.log(`  PASS (${durationMs.toFixed(0)}ms)`);
        results.push({ name: testName, passed: true, durationMs });
      } catch (error) {
        const durationMs = performance.now() - start;
        const msg = error instanceof Error ? error.message : String(error);
        console.log(`  FAIL — ${msg}`);
        results.push({ name: testName, passed: false, durationMs, error: msg });
      }
    }

    // =========================================================================
    // Phase 3: Summary
    // =========================================================================
    console.log('\n\n');
    console.log('='.repeat(70));
    console.log('  MARKET CLI E2E TEST RESULTS');
    console.log('='.repeat(70));
    console.log('');
    console.log('  #  | Test                         | Time(ms) | Status');
    console.log('-----+------------------------------+----------+---------');

    results.forEach((r, i) => {
      const num = String(i + 1).padStart(3);
      const name = r.name.padEnd(28).slice(0, 28);
      const time = r.durationMs.toFixed(0).padStart(8);
      const status = r.passed ? '  PASS ' : '  FAIL ';
      console.log(` ${num} | ${name} | ${time} |${status}`);
    });

    console.log('-----+------------------------------+----------+---------');

    const passed = results.filter((r) => r.passed).length;
    const total = results.length;
    console.log(`\nPassed: ${passed}/${total}`);

    if (passed === total) {
      console.log('\nALL TESTS PASSED');
    } else {
      console.log('\nFAILED TESTS:');
      for (const r of results.filter((r) => !r.passed)) {
        console.log(`  - ${r.name}: ${r.error}`);
      }
    }
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
  const allPassed = results.length > 0 && results.every((r) => r.passed);
  process.exit(allPassed ? 0 : 1);
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
