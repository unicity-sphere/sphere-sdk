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
 * Local-infra integration (E2E_LOCAL_INFRA=1):
 *   - Probe the local Nostr relay (ws://127.0.0.1:7777) directly
 *     using infra-probe's `probeNostrRelay`. Same checks as the
 *     public testnet probe — connect, subscribe, publish-and-confirm
 *     for every wallet kind — so per-suite gates still get a real
 *     verdict instead of an "unknown" silently-passes.
 *   - Skip the public testnet faucet HTTP probe (the local faucet
 *     has no HTTP surface) and emit a synthetic "healthy" entry
 *     based on the boot-time chain_pubkey wait. The actual DM
 *     round-trip is exercised by the tests that use the faucet.
 *   - Probe public aggregator + IPFS as normal — those are still
 *     the public testnet endpoints in local-infra mode.
 *
 * Env vars:
 *   `E2E_SKIP_PREFLIGHT=1`       — bypass entirely; never run the probe
 *   `E2E_NETWORK=<name>`         — `mainnet|testnet|dev` (default: testnet)
 *   `E2E_PREFLIGHT_ONLY=<list>`  — comma-separated subset of services to
 *                                  probe. Default: all services (or
 *                                  the local-infra-aware default).
 *   `E2E_LOCAL_INFRA=1`          — use local relay + faucet booted by
 *                                  tests/e2e/local-infra/global-setup.ts
 *                                  (which runs BEFORE this hook in the
 *                                  vitest globalSetup chain).
 */

import { runProbes, SERVICES } from '@unicitylabs/infra-probe';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Load `probeNostrRelay` from infra-probe's internal `src/probes/`
 * tree.
 *
 * @unicitylabs/infra-probe@0.4 declares
 * `exports: { ".": "./src/index.mjs" }` — no subpath exports — so
 * neither static `import` nor `createRequire` can reach the deep
 * probe files: both honor the package-exports gate and reject with
 * ERR_PACKAGE_PATH_NOT_EXPORTED. The escape hatch is to import the
 * file BY ABSOLUTE PATH (file:// URL) — Node's resolver only checks
 * package-exports for bare-specifier imports, not file URLs. Until
 * upstream adds explicit subpath exports for the probe functions,
 * this is the only way to invoke `probeNostrRelay` against a custom
 * endpoint without forking the library.
 *
 * Cached as a module-level promise so the dynamic import runs at most
 * once per vitest globalSetup invocation.
 */
async function loadProbeNostrRelay(): Promise<
  (url: string, opts?: { timeoutMs?: number }) => Promise<unknown>
> {
  // Walk up from this file (tests/e2e/preflight.global-setup.ts) to
  // the SDK root, then descend into node_modules/@unicitylabs/
  // infra-probe/src/probes/nostr.mjs. import.meta.resolve isn't
  // available under vite's SSR loader (which vitest uses for
  // globalSetup), so we can't ask Node to resolve the package — we
  // construct the path manually. file:// URLs bypass the
  // package-exports gate that blocks bare-specifier subpath imports.
  //
  // Hardcoding the relative path is acceptable because:
  //   - This file is in the same workspace as node_modules.
  //   - infra-probe is a direct dev dependency; layout is stable.
  //   - The CHANGELOG covers any path migration when upstream
  //     reorganises the probe folder.
  const sdkRoot = join(HERE, '..', '..');
  const probeNostrPath = join(
    sdkRoot,
    'node_modules',
    '@unicitylabs',
    'infra-probe',
    'src',
    'probes',
    'nostr.mjs',
  );
  if (!existsSync(probeNostrPath)) {
    throw new Error(
      `infra-probe nostr probe not found at ${probeNostrPath}. ` +
        `Reinstall dependencies or update preflight.global-setup.ts to match the new layout.`,
    );
  }
  const mod = (await import(pathToFileURL(probeNostrPath).href)) as {
    probeNostrRelay: (url: string, opts?: { timeoutMs?: number }) => Promise<unknown>;
  };
  return mod.probeNostrRelay;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULT_FILE = join(HERE, '.preflight-result.json');

interface ServiceReport {
  service: string;
  endpoint: string;
  status: 'healthy' | 'degraded' | 'unreachable' | 'error';
  latencyMs: number;
  checks: Array<{ name: string; status: 'pass' | 'fail' | 'warn'; latencyMs?: number; message?: string }>;
  error?: string;
  timestamp: string;
}

interface Report {
  network: string;
  networkLabel?: string;
  startedAt: string;
  completedAt: string;
  services: ServiceReport[];
  summary: { total: number; healthy: number; degraded: number; unreachable: number };
}

/**
 * Synthetic "healthy" report entry for the local DM-driven faucet.
 *
 * The faucet probe in @unicitylabs/infra-probe is HTTP-only (POST
 * /api/v1/faucet/request with an invalid nametag → expect 200 +
 * structured error). The local js-faucet has no HTTP surface — its
 * FAUCET_REQUEST path runs over Sphere DMs only. We already verified
 * the local faucet is up during global-setup boot (waited for
 * `faucet_chain_pubkey_announced` in stdout); the synthetic entry lets
 * per-suite gates that declare `'faucet'` as required continue to pass
 * in local-infra mode without hand-rolling a DM-based probe here.
 *
 * If the faucet stops responding AFTER boot, the test that uses it
 * fails with a clear `local-faucet DM error: …timeout…` message —
 * actionable in its own right, more useful than another 30 s probe.
 */
function buildLocalFaucetReport(faucetPubkey: string): ServiceReport {
  const truncated = faucetPubkey.slice(0, 16);
  return {
    service: 'faucet',
    endpoint: `dm://${truncated}…@local`,
    status: 'healthy',
    latencyMs: 0,
    checks: [
      {
        name: 'boot',
        status: 'pass',
        latencyMs: 0,
        message:
          'local DM-driven faucet — verified during global-setup boot wait. ' +
          'No HTTP probe path; FAUCET_REQUEST round-trip exercised by tests directly.',
      },
    ],
    timestamp: new Date().toISOString(),
  };
}

function summarize(services: ServiceReport[]): Report['summary'] {
  return services.reduce(
    (acc, s) => {
      acc.total += 1;
      if (s.status === 'healthy') acc.healthy += 1;
      else if (s.status === 'degraded') acc.degraded += 1;
      else acc.unreachable += 1;
      return acc;
    },
    { total: 0, healthy: 0, degraded: 0, unreachable: 0 },
  );
}

function logSummary(report: Report): void {
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

function writeReport(report: Report): void {
  try {
    writeFileSync(RESULT_FILE, JSON.stringify(report, null, 2));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[preflight] could not write ${RESULT_FILE}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function setup(): Promise<void> {
  if (process.env.E2E_SKIP_PREFLIGHT === '1') {
    // eslint-disable-next-line no-console
    console.log('[preflight] E2E_SKIP_PREFLIGHT=1 — skipping infra probe');
    return;
  }

  const network = (process.env.E2E_NETWORK ?? 'testnet') as 'mainnet' | 'testnet' | 'dev';
  const localInfra = process.env.E2E_LOCAL_INFRA === '1';

  if (localInfra) {
    await runLocalInfraPreflight(network);
    return;
  }

  await runPublicPreflight(network);
}

async function runPublicPreflight(
  network: 'mainnet' | 'testnet' | 'dev',
): Promise<void> {
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

  let report: Report;
  try {
    report = (await runProbes({ network, only, timeoutMs: 60_000 })) as unknown as Report;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[preflight] probe invocation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    // eslint-disable-next-line no-console
    console.warn('[preflight] suites will fall through to their own skip logic');
    return;
  }
  writeReport(report);
  logSummary(report);
}

/**
 * Probe the local stack:
 *   - Nostr relay at SPHERE_NOSTR_RELAYS (booted by local-infra/global-
 *     setup; falls back to ws://127.0.0.1:7777 if the env var is
 *     unset for some reason).
 *   - Public aggregator + IPFS (untouched in local-infra mode).
 *   - Synthetic faucet entry (verified at boot; see comment on
 *     buildLocalFaucetReport).
 *
 * The result file is written in the same shape `runProbes` produces,
 * so `lib/preflight.ts` (which loads + reads `services` by name)
 * needs no changes.
 */
async function runLocalInfraPreflight(
  network: 'mainnet' | 'testnet' | 'dev',
): Promise<void> {
  const requested = (process.env.E2E_PREFLIGHT_ONLY ?? 'nostr,aggregator,ipfs,faucet')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = requested.filter((s) => !SERVICES.includes(s as (typeof SERVICES)[number]));
  if (unknown.length > 0) {
    throw new Error(
      `[preflight] E2E_PREFLIGHT_ONLY contains unknown service(s): ${unknown.join(', ')}. ` +
        `Valid: ${SERVICES.join(', ')}`,
    );
  }
  const requestedSet = new Set(requested);

  // eslint-disable-next-line no-console
  console.log(
    `[preflight] E2E_LOCAL_INFRA=1 — probing local relay + faucet (synthetic) ` +
      `+ public aggregator/IPFS/fulcrum/market as requested. ` +
      `Probing: ${requested.join(',')}`,
  );

  // Public services we still want to probe — defer to the standard
  // runProbes path with `only` set to the public subset.
  const publicOnly = requested.filter((s) => s !== 'nostr' && s !== 'faucet');
  let publicReport: Report | null = null;
  if (publicOnly.length > 0) {
    try {
      publicReport = (await runProbes({
        network,
        only: publicOnly,
        timeoutMs: 60_000,
      })) as unknown as Report;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[preflight] public-services probe failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const services: ServiceReport[] = [];

  // 1. Local Nostr relay — full publish-and-confirm probe via infra-probe.
  if (requestedSet.has('nostr')) {
    const localRelay = process.env.SPHERE_NOSTR_RELAYS ?? 'ws://127.0.0.1:7777';
    // eslint-disable-next-line no-console
    console.log(`[preflight] probing local relay at ${localRelay}…`);
    try {
      const probeNostrRelay = await loadProbeNostrRelay();
      const nostrReport = (await probeNostrRelay(localRelay, { timeoutMs: 60_000 })) as unknown as ServiceReport;
      services.push(nostrReport);
    } catch (err) {
      services.push({
        service: 'nostr',
        endpoint: localRelay,
        status: 'error',
        latencyMs: 0,
        checks: [],
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        timestamp: new Date().toISOString(),
      });
    }
  }

  // 2. Public services as probed.
  if (publicReport) {
    services.push(...publicReport.services);
  }

  // 3. Synthetic faucet entry.
  if (requestedSet.has('faucet')) {
    const faucetPubkey = process.env.E2E_LOCAL_FAUCET_PUBKEY;
    if (!faucetPubkey) {
      // local-infra mode but the global-setup didn't export the pubkey
      // (probably E2E_LOCAL_INFRA_NO_FAUCET=1 — operator-driven). Don't
      // emit a fake "healthy" — emit "error" so per-suite gates that
      // require faucet skip cleanly with a precise message.
      services.push({
        service: 'faucet',
        endpoint: '(local — not booted)',
        status: 'error',
        latencyMs: 0,
        checks: [],
        error:
          'E2E_LOCAL_INFRA=1 but E2E_LOCAL_FAUCET_PUBKEY not set — local faucet was not booted ' +
          '(E2E_LOCAL_INFRA_NO_FAUCET=1?). Tests requiring the faucet will skip.',
        timestamp: new Date().toISOString(),
      });
    } else {
      services.push(buildLocalFaucetReport(faucetPubkey));
    }
  }

  const startedAt = new Date().toISOString();
  const report: Report = {
    network,
    networkLabel: `Local-Infra over ${network}`,
    startedAt,
    completedAt: new Date().toISOString(),
    services,
    summary: summarize(services),
  };

  writeReport(report);
  logSummary(report);
}

export async function teardown(): Promise<void> {
  // Clean up the result file so a follow-up run starting with a missing
  // probe doesn't accidentally read stale data from a previous run.
  if (existsSync(RESULT_FILE)) {
    try { unlinkSync(RESULT_FILE); } catch { /* best-effort cleanup */ }
  }
}
