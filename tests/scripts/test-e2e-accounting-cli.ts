#!/usr/bin/env npx tsx
/**
 * E2E CLI Accounting (Invoice) Test Script
 *
 * Exercises invoice CLI commands by spawning child processes, parsing stdout,
 * and verifying the full invoice lifecycle: create → pay → status → close.
 *
 * Prerequisites:
 *   - Two wallet profiles ("alice" and "bob") with funded UCT tokens
 *   - Access to testnet aggregator and Nostr relays
 *
 * Usage:
 *   npx tsx tests/scripts/test-e2e-accounting-cli.ts [--cleanup]
 *
 * This script mirrors the pattern from test-e2e-cli.ts.
 */

import { execSync } from 'node:child_process';
import { rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';

// =============================================================================
// Constants
// =============================================================================

const CLI_CMD = 'npx tsx cli/index.ts';
const CONFIG_FILE = '.sphere-cli/config.json';
const PROFILES_FILE = '.sphere-cli/profiles.json';
const TRANSFER_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 3_000;

// =============================================================================
// Types
// =============================================================================

interface CliResult {
  stdout: string;
  stderr: string;
  durationMs: number;
  exitCode: number;
}

interface TestResult {
  scenario: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

// =============================================================================
// Helpers
// =============================================================================

function cli(args: string, timeout = 30_000): CliResult {
  const start = Date.now();
  try {
    const stdout = execSync(`${CLI_CMD} ${args}`, {
      timeout,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    return { stdout, stderr: '', durationMs: Date.now() - start, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      durationMs: Date.now() - start,
      exitCode: e.status ?? 1,
    };
  }
}

function switchProfile(profileName: string): void {
  const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
  const profiles = JSON.parse(readFileSync(PROFILES_FILE, 'utf-8'));
  const profile = profiles[profileName];
  if (!profile) throw new Error(`Profile "${profileName}" not found`);
  config.dataDir = profile.dataDir;
  config.tokensDir = profile.tokensDir;
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function sleep(ms: number): void {
  execSync(`sleep ${ms / 1000}`, { stdio: 'ignore' });
}

function extractInvoiceId(output: string): string | null {
  // Look for 64-hex-char invoice ID in output
  const match = output.match(/([0-9a-f]{64})/i);
  return match ? match[1].toLowerCase() : null;
}

// =============================================================================
// Test Scenarios
// =============================================================================

const results: TestResult[] = [];

function test(scenario: string, fn: () => void): void {
  const start = Date.now();
  try {
    fn();
    results.push({ scenario, success: true, durationMs: Date.now() - start });
    console.log(`  ✓ ${scenario} (${Date.now() - start}ms)`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ scenario, success: false, durationMs: Date.now() - start, error: msg });
    console.log(`  ✗ ${scenario}: ${msg}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// =============================================================================
// Main
// =============================================================================

console.log('╔══════════════════════════════════════════╗');
console.log('║   E2E Invoice CLI Tests                  ║');
console.log('╚══════════════════════════════════════════╝');
console.log();

// ---------------------------------------------------------------------------
// Scenario 1: Full invoice lifecycle (create → pay → status → close)
// ---------------------------------------------------------------------------

console.log('Scenario 1: Full invoice lifecycle');

let invoiceId: string | null = null;

test('1a: Alice creates an invoice for Bob to pay', () => {
  switchProfile('alice');
  const bobAddress = cli('identity').stdout.match(/directAddress:\s*(DIRECT:\/\/\S+)/)?.[1];
  assert(!!bobAddress, 'Could not get Alice directAddress');

  const result = cli(`invoice-create --target ${bobAddress} --asset "1000000 UCT" --memo "E2E test invoice"`);
  assert(result.exitCode === 0, `invoice-create failed: ${result.stderr}`);
  invoiceId = extractInvoiceId(result.stdout);
  assert(!!invoiceId, 'Could not extract invoice ID from output');
  console.log(`    Invoice ID: ${invoiceId!.slice(0, 16)}...`);
});

test('1b: Alice checks invoice status (should be OPEN)', () => {
  switchProfile('alice');
  assert(!!invoiceId, 'No invoice ID from previous step');
  const result = cli(`invoice-status ${invoiceId!.slice(0, 16)}`);
  assert(result.exitCode === 0, `invoice-status failed: ${result.stderr}`);
  assert(result.stdout.includes('OPEN'), `Expected OPEN state, got: ${result.stdout}`);
});

test('1c: Alice lists invoices (should include new invoice)', () => {
  switchProfile('alice');
  const result = cli('invoice-list');
  assert(result.exitCode === 0, `invoice-list failed: ${result.stderr}`);
  assert(result.stdout.includes(invoiceId!.slice(0, 16)), 'Invoice not in list');
});

test('1d: Bob pays the invoice', () => {
  switchProfile('bob');
  assert(!!invoiceId, 'No invoice ID from previous step');
  // Bob needs to import the invoice first (or pay directly by ID)
  const result = cli(`invoice-pay ${invoiceId!.slice(0, 16)} --amount 1000000`, TRANSFER_TIMEOUT_MS);
  assert(result.exitCode === 0, `invoice-pay failed: ${result.stderr}`);
});

test('1e: Alice checks invoice status (should be COVERED or PARTIAL)', () => {
  switchProfile('alice');
  sleep(5000); // Wait for Nostr delivery
  const result = cli(`invoice-status ${invoiceId!.slice(0, 16)}`);
  assert(result.exitCode === 0, `invoice-status failed: ${result.stderr}`);
  const hasCoveredOrPartial = result.stdout.includes('COVERED') || result.stdout.includes('PARTIAL');
  assert(hasCoveredOrPartial, `Expected COVERED or PARTIAL, got: ${result.stdout}`);
});

test('1f: Alice closes the invoice', () => {
  switchProfile('alice');
  assert(!!invoiceId, 'No invoice ID');
  const result = cli(`invoice-close ${invoiceId!.slice(0, 16)}`);
  assert(result.exitCode === 0, `invoice-close failed: ${result.stderr}`);
});

test('1g: Alice verifies invoice is CLOSED', () => {
  switchProfile('alice');
  const result = cli(`invoice-status ${invoiceId!.slice(0, 16)}`);
  assert(result.exitCode === 0, `invoice-status failed: ${result.stderr}`);
  assert(result.stdout.includes('CLOSED'), `Expected CLOSED, got: ${result.stdout}`);
});

test('1h: Alice sends receipts', () => {
  switchProfile('alice');
  const result = cli(`invoice-receipts ${invoiceId!.slice(0, 16)}`);
  assert(result.exitCode === 0, `invoice-receipts failed: ${result.stderr}`);
});

test('1i: Alice views related transfers', () => {
  switchProfile('alice');
  const result = cli(`invoice-transfers ${invoiceId!.slice(0, 16)}`);
  assert(result.exitCode === 0, `invoice-transfers failed: ${result.stderr}`);
});

// ---------------------------------------------------------------------------
// Scenario 2: Invoice cancellation + auto-return
// ---------------------------------------------------------------------------

console.log('\nScenario 2: Invoice cancellation');

let cancelInvoiceId: string | null = null;

test('2a: Alice creates a second invoice', () => {
  switchProfile('alice');
  const aliceAddr = cli('identity').stdout.match(/directAddress:\s*(DIRECT:\/\/\S+)/)?.[1];
  assert(!!aliceAddr, 'Could not get Alice directAddress');
  const result = cli(`invoice-create --target ${aliceAddr} --asset "500000 UCT" --memo "Cancel test"`);
  assert(result.exitCode === 0, `invoice-create failed: ${result.stderr}`);
  cancelInvoiceId = extractInvoiceId(result.stdout);
  assert(!!cancelInvoiceId, 'Could not extract invoice ID');
});

test('2b: Alice cancels the invoice', () => {
  switchProfile('alice');
  assert(!!cancelInvoiceId, 'No invoice ID');
  const result = cli(`invoice-cancel ${cancelInvoiceId!.slice(0, 16)}`);
  assert(result.exitCode === 0, `invoice-cancel failed: ${result.stderr}`);
});

test('2c: Verify CANCELLED status', () => {
  switchProfile('alice');
  const result = cli(`invoice-status ${cancelInvoiceId!.slice(0, 16)}`);
  assert(result.exitCode === 0, `invoice-status failed: ${result.stderr}`);
  assert(result.stdout.includes('CANCELLED'), `Expected CANCELLED, got: ${result.stdout}`);
});

// ---------------------------------------------------------------------------
// Scenario 3: invoice-parse-memo (pure utility, no wallet needed)
// ---------------------------------------------------------------------------

console.log('\nScenario 3: Memo parsing utility');

test('3a: Parse valid forward memo', () => {
  const hexId = 'a'.repeat(64);
  const result = cli(`invoice-parse-memo "INV:${hexId}:F payment for order"`);
  assert(result.exitCode === 0, `parse failed: ${result.stderr}`);
  assert(result.stdout.includes(hexId) || result.stdout.includes('forward'), 'Parsed output missing expected fields');
});

test('3b: Parse invalid memo returns null', () => {
  const result = cli('invoice-parse-memo "not a valid memo"');
  assert(result.exitCode === 0, `parse failed: ${result.stderr}`);
  assert(result.stdout.includes('null') || result.stdout.includes('No match'), 'Expected null/no match output');
});

// ---------------------------------------------------------------------------
// Scenario 4: Auto-return settings
// ---------------------------------------------------------------------------

console.log('\nScenario 4: Auto-return configuration');

test('4a: Show auto-return settings', () => {
  switchProfile('alice');
  const result = cli('invoice-auto-return');
  assert(result.exitCode === 0, `auto-return show failed: ${result.stderr}`);
});

test('4b: Enable global auto-return', () => {
  switchProfile('alice');
  const result = cli('invoice-auto-return --enable');
  assert(result.exitCode === 0, `auto-return enable failed: ${result.stderr}`);
});

test('4c: Disable global auto-return', () => {
  switchProfile('alice');
  const result = cli('invoice-auto-return --disable');
  assert(result.exitCode === 0, `auto-return disable failed: ${result.stderr}`);
});

// ---------------------------------------------------------------------------
// Scenario 5: Invoice export
// ---------------------------------------------------------------------------

console.log('\nScenario 5: Invoice export');

test('5a: Export invoice to file', () => {
  switchProfile('alice');
  assert(!!invoiceId, 'No invoice ID from scenario 1');
  const result = cli(`invoice-export ${invoiceId!.slice(0, 16)}`);
  assert(result.exitCode === 0, `invoice-export failed: ${result.stderr}`);
  // Should mention the output file path
  assert(result.stdout.includes('invoice-') || result.stdout.includes('.json'), 'Expected file path in output');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\n══════════════════════════════════════════');
const passed = results.filter((r) => r.success).length;
const failed = results.filter((r) => !r.success).length;
console.log(`Results: ${passed} passed, ${failed} failed out of ${results.length} tests`);

if (failed > 0) {
  console.log('\nFailed tests:');
  for (const r of results.filter((r) => !r.success)) {
    console.log(`  ✗ ${r.scenario}: ${r.error}`);
  }
  process.exit(1);
}

console.log('\n✓ All E2E accounting CLI tests passed!');
