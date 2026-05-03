/**
 * Vitest globalSetup hook — runs ONCE before any e2e test, ONCE after.
 *
 * Invokes `@unicitylabs/infra-probe` against the configured network,
 * captures the JSON report to `tests/e2e/.preflight-result.json`, and
 * lets each test file decide (via `lib/preflight.ts`) whether its
 * required services are healthy.
 *
 * This file ONLY captures the report — it does NOT fail the run if
 * services are unhealthy. The decision to skip is per-suite (each test
 * file knows which services it depends on, so an IPFS-only test
 * shouldn't be blocked by an unhealthy aggregator).
 *
 * Skip the preflight entirely with `E2E_SKIP_PREFLIGHT=1` (useful when
 * working offline or when the probe itself is what you're debugging).
 *
 * Override the probed network with `E2E_NETWORK=mainnet|testnet|dev`;
 * default is `testnet` (matches the rest of the e2e suite).
 */

import { runProbes } from '@unicitylabs/infra-probe';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULT_FILE = join(HERE, '.preflight-result.json');

export async function setup(): Promise<void> {
  if (process.env.E2E_SKIP_PREFLIGHT === '1') {
    // eslint-disable-next-line no-console
    console.log('[preflight] E2E_SKIP_PREFLIGHT=1 — skipping infra probe');
    return;
  }
  const network = (process.env.E2E_NETWORK ?? 'testnet') as 'mainnet' | 'testnet' | 'dev';
  // eslint-disable-next-line no-console
  console.log(`[preflight] running @unicitylabs/infra-probe --network ${network} (this may take ~30s)…`);

  let report;
  try {
    report = await runProbes({ network, timeoutMs: 60_000 });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[preflight] probe invocation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    // eslint-disable-next-line no-console
    console.warn('[preflight] suites will fall through to their own skip logic');
    return;
  }

  try {
    writeFileSync(RESULT_FILE, JSON.stringify(report, null, 2));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[preflight] could not write ${RESULT_FILE}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  // One-line summary per service — concise and grep-able in CI logs.
  for (const svc of report.services) {
    const glyph = svc.status === 'healthy' ? '✓' : svc.status === 'degraded' ? '⚠' : '✗';
    // eslint-disable-next-line no-console
    console.log(
      `[preflight] ${glyph} ${svc.service.padEnd(11)} ${svc.status}` +
        (svc.error ? ` — ${svc.error}` : ''),
    );
  }
  const { healthy, degraded, unreachable, total } = report.summary;
  // eslint-disable-next-line no-console
  console.log(
    `[preflight] summary: ${healthy} healthy, ${degraded} degraded, ${unreachable} unreachable (of ${total})`,
  );
}

export async function teardown(): Promise<void> {
  // Clean up the result file so a follow-up run starting with a missing
  // probe doesn't accidentally read stale data from a previous run.
  if (existsSync(RESULT_FILE)) {
    try { unlinkSync(RESULT_FILE); } catch { /* best-effort cleanup */ }
  }
}
