/**
 * Preflight infra-probe gate for vitest e2e tests.
 *
 * Wraps `@unicitylabs/infra-probe`'s output into a per-suite skip
 * decision. The probe runs ONCE per `npm run test:e2e` invocation
 * (via `tests/e2e/preflight.global-setup.ts` vitest globalSetup),
 * writes a JSON result file, and each test file imports
 * `shouldSkipForUnhealthyInfra(...)` to derive its own SKIP boolean
 * based on the services that test actually depends on.
 *
 * Skip policy (intentionally conservative — we'd rather run a test
 * that turns out to time out than skip one that would have caught a
 * regression):
 *   - `unreachable` / `error` → skip the suite (false-negatives we
 *     can't avoid anyway; better to skip cleanly)
 *   - `degraded`              → warn but run; the test may still pass,
 *     and if it doesn't the failure is informative
 *   - `healthy`               → run normally
 *
 * If the probe didn't run (file missing / unparseable), every suite
 * falls through to its existing behavior — we do NOT silently skip.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// __dirname equivalent in ESM TypeScript (vitest transpiles import.meta).
const HERE = dirname(fileURLToPath(import.meta.url));
export const PREFLIGHT_RESULT_FILE = join(HERE, '..', '.preflight-result.json');

/** Service names the probe reports — keep in sync with @unicitylabs/infra-probe SERVICES. */
export type ServiceName = 'nostr' | 'aggregator' | 'ipfs' | 'fulcrum' | 'market';

export interface ServiceCheck {
  readonly name: string;
  readonly status: 'pass' | 'fail' | 'warn';
  readonly latencyMs?: number;
  readonly message?: string;
}

export interface ServiceReport {
  readonly service: ServiceName | string;
  readonly endpoint: string;
  readonly status: 'healthy' | 'degraded' | 'unreachable' | 'error';
  readonly latencyMs: number;
  readonly checks: readonly ServiceCheck[];
  readonly error?: string;
  readonly timestamp: string;
}

export interface PreflightReport {
  readonly network: string;
  readonly networkLabel: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly services: readonly ServiceReport[];
  readonly summary: { total: number; healthy: number; degraded: number; unreachable: number };
}

let cached: PreflightReport | null | undefined; // undefined = not yet attempted

/**
 * Load the preflight probe report from disk (cached after first call).
 * Returns null if the file is missing / unparseable — callers should
 * treat that as "no preflight info available; fall back to legacy
 * behavior" rather than as a skip signal.
 */
export function loadPreflightReport(): PreflightReport | null {
  if (cached !== undefined) return cached;
  if (!existsSync(PREFLIGHT_RESULT_FILE)) {
    cached = null;
    return null;
  }
  try {
    const raw = readFileSync(PREFLIGHT_RESULT_FILE, 'utf8');
    const parsed = JSON.parse(raw) as PreflightReport;
    if (!parsed || !Array.isArray(parsed.services)) throw new Error('malformed report');
    cached = parsed;
    return parsed;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[preflight] could not parse ${PREFLIGHT_RESULT_FILE}: ${err instanceof Error ? err.message : String(err)}`,
    );
    cached = null;
    return null;
  }
}

/**
 * Decide whether a vitest suite should skip itself given the services
 * it actually depends on. Use the result with `describe.skipIf(...)`.
 *
 * Returns `false` when the suite SHOULD run, or a `{ reason }` object
 * when it should NOT (the reason is suitable for `console.warn`).
 *
 * @example
 *   const SKIP = shouldSkipForUnhealthyInfra(['nostr', 'aggregator']);
 *   if (SKIP) console.warn(`[preflight] skipping suite: ${SKIP.reason}`);
 *   describe.skipIf(Boolean(SKIP))('UXF send/receive', () => { ... });
 */
export function shouldSkipForUnhealthyInfra(
  required: ReadonlyArray<ServiceName | string>,
): false | { reason: string } {
  const report = loadPreflightReport();
  if (!report) {
    // No preflight info — don't skip; the test's own logic decides.
    return false;
  }

  const blockers: string[] = [];
  for (const name of required) {
    const svc = report.services.find((s) => s.service === name);
    if (!svc) {
      // The probe didn't include this service. Most common cause: the
      // probe was run with --only excluding it. Don't skip; that's not
      // a service-down signal.
      // eslint-disable-next-line no-console
      console.warn(
        `[preflight] no probe data for required service "${name}"; not gating on it`,
      );
      continue;
    }
    if (svc.status === 'unreachable' || svc.status === 'error') {
      blockers.push(
        `${svc.service}: ${svc.status}${svc.error ? ` (${svc.error})` : ''}`,
      );
    } else if (svc.status === 'degraded') {
      // Warn but don't skip — degraded service may still let the test pass.
      // eslint-disable-next-line no-console
      console.warn(
        `[preflight] required service "${name}" is degraded (suite will still run): ${
          svc.checks.find((c) => c.status !== 'pass')?.message ?? '(no fail message)'
        }`,
      );
    }
  }

  if (blockers.length === 0) return false;
  return {
    reason: `infra-probe reports ${blockers.length} required service(s) as unreachable: ${blockers.join('; ')}`,
  };
}

/**
 * Convenience wrapper: derive SKIP, log, and return a boolean for
 * `describe.skipIf` / `it.skipIf`. Use in test-file top-level scope:
 *
 *   const SKIP_INFRA = preflightSkip(['nostr', 'aggregator'], 'pointer-roundtrip');
 *   describe.skipIf(SKIP_INFRA)('Pointer roundtrip', () => { ... });
 */
export function preflightSkip(
  required: ReadonlyArray<ServiceName | string>,
  suiteLabel?: string,
): boolean {
  const decision = shouldSkipForUnhealthyInfra(required);
  if (decision === false) return false;
  // eslint-disable-next-line no-console
  console.warn(
    `[preflight] skipping ${suiteLabel ?? 'suite'}: ${decision.reason}`,
  );
  return true;
}
