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
 * Env vars:
 *   `E2E_SKIP_PREFLIGHT=1`       — bypass entirely; never run the probe
 *   `E2E_NETWORK=<name>`         — `mainnet|testnet|dev` (default: testnet)
 *   `E2E_PREFLIGHT_ONLY=<list>`  — comma-separated subset of services to
 *                                  probe. Default: all five services.
 *                                  Use this to skip a Fulcrum/Market
 *                                  probe when the tests you're running
 *                                  don't need them — saves the probe-
 *                                  timeout wall-clock on degraded
 *                                  components your tests don't gate on.
 *                                  Example for a UXF-only dev cycle:
 *                                    E2E_PREFLIGHT_ONLY=nostr,aggregator,ipfs
 *                                  Per-suite gates only block on
 *                                  services they explicitly require, so
 *                                  filtering the probe never causes a
 *                                  test to incorrectly run — it just
 *                                  speeds up the preflight phase.
 */

import { runProbes, SERVICES } from '@unicitylabs/infra-probe';
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

  // Optional `E2E_PREFLIGHT_ONLY=nostr,aggregator,ipfs` filter. Validate
  // each entry against SERVICES so a typo fails fast rather than
  // silently probing nothing.
  let only: string[] | undefined;
  if (process.env.E2E_PREFLIGHT_ONLY) {
    only = process.env.E2E_PREFLIGHT_ONLY.split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = only.filter((s) => !SERVICES.includes(s as (typeof SERVICES)[number]));
    if (unknown.length > 0) {
      throw new Error(
        `[preflight] E2E_PREFLIGHT_ONLY contains unknown service(s): ${unknown.join(', ')}. ` +
          `Valid: ${SERVICES.join(', ')}`,
      );
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[preflight] running @unicitylabs/infra-probe --network ${network}` +
      (only ? ` --only ${only.join(',')}` : '') +
      ` (this may take ~30s)…`,
  );

  let report;
  try {
    report = await runProbes({ network, only, timeoutMs: 60_000 });
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
