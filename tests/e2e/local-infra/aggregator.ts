/**
 * Local aggregator + MongoDB lifecycle.
 *
 * Wraps `docker compose --profile full up/down` for the
 * `aggregator` + `mongodb` services in tests/e2e/local-infra/
 * docker-compose.yml. The aggregator runs in BFT-disabled standalone
 * mode (BFT_ENABLED=false, DISABLE_HIGH_AVAILABILITY=true) — block
 * production happens via an internal 1s timer that calls
 * `roundManager.StartNewRound()` + `FinalizeBlock()` directly, so the
 * SMT and inclusion proofs are real but no external consensus is
 * required.
 *
 * On first boot we run `setup-aggregator-src.sh` to fetch a pinned
 * aggregator-go checkout, then compose's `build:` directive compiles
 * the image (~30s on first run, cached on subsequent runs).
 *
 * MongoDB is the only external dependency of the aggregator — no
 * BFT-core, no trust-base, no validator keys.
 *
 * @module tests/e2e/local-infra/aggregator
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPOSE_FILE = join(__dirname, 'docker-compose.yml');
const SETUP_SCRIPT = join(__dirname, 'setup-aggregator-src.sh');

/**
 * URL the aggregator listens on (matches docker-compose port mapping).
 */
export const LOCAL_AGGREGATOR_URL = 'http://127.0.0.1:3001';

export interface AggregatorBootOptions {
  /** Drop the persisted MongoDB volume + rebuild aggregator image. Default false. */
  readonly wipe?: boolean;
  /** Total deadline for the aggregator to become healthy. Default 180s
   *  (covers a cold first-run Docker build of aggregator-go). */
  readonly timeoutMs?: number;
  /** Optional prefix for log lines so multi-stack output is greppable. */
  readonly logPrefix?: string;
}

export interface AggregatorHandle {
  /** HTTP JSON-RPC URL clients connect to. */
  readonly url: string;
  /** Aggregator container name. */
  readonly containerName: string;
  /** Stop + remove the aggregator AND its mongo. Idempotent. */
  stop(opts?: { wipe?: boolean }): Promise<void>;
}

const log = (prefix: string, msg: string): void => {
   
  console.log(`${prefix}${msg}`);
};

/**
 * Ensure the pinned aggregator-go checkout exists at
 * tests/e2e/local-infra/.aggregator-go/. Idempotent; see the
 * setup-aggregator-src.sh script for the pin logic + dev-override
 * env vars.
 */
function ensureAggregatorSource(prefix: string): void {
  log(prefix, 'ensuring aggregator-go source is fetched at pinned commit…');
  const r = spawnSync('bash', [SETUP_SCRIPT], {
    encoding: 'utf8',
    timeout: 180_000,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (r.status !== 0) {
    throw new Error(
      `setup-aggregator-src.sh failed (exit ${r.status}). Stdout: ${r.stdout}`,
    );
  }
}

/**
 * Boot `mongodb` + `aggregator` via the compose `full` profile and
 * wait for the aggregator's /health to respond 200.
 */
export async function bootLocalAggregator(
  opts: AggregatorBootOptions = {},
): Promise<AggregatorHandle> {
  const prefix = opts.logPrefix ?? '[local-aggregator] ';
  const timeoutMs = opts.timeoutMs ?? 180_000;

  // 1. Sanity check: docker CLI present.
  const dockerVersion = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
  });
  if (dockerVersion.status !== 0) {
    throw new Error(
      `docker is not available (exit ${dockerVersion.status}): ${dockerVersion.stderr || dockerVersion.stdout}. ` +
        'Install Docker or unset E2E_FULL_LOCAL_STACK to run against the public testnet.',
    );
  }

  // 2. Fetch the pinned aggregator-go source (first run clones; subsequent
  //    runs are no-ops). Failures here surface BEFORE we ask compose to
  //    build, so the error message is clearer.
  ensureAggregatorSource(prefix);

  // 3. Optional: wipe persisted state.
  if (opts.wipe) {
    log(prefix, 'wiping previous aggregator + mongo volumes…');
    spawnSync(
      'docker',
      ['compose', '-f', COMPOSE_FILE, '--profile', 'full', 'down', '-v'],
      { encoding: 'utf8', timeout: 60_000 },
    );
  }

  // 4. Boot the two services. `--profile full` selects mongodb + aggregator
  //    (and ipfs — ipfs.ts manages its own depends-on; harmless to start
  //    here too if compose is invoked again with the same profile).
  log(prefix, `booting mongodb + aggregator from ${COMPOSE_FILE}…`);
  const up = spawnSync(
    'docker',
    ['compose', '-f', COMPOSE_FILE, '--profile', 'full', 'up', '-d', 'mongodb', 'aggregator'],
    { encoding: 'utf8', timeout: 600_000 },
  );
  if (up.status !== 0) {
    throw new Error(
      `docker compose up failed (exit ${up.status}):\nstdout: ${up.stdout}\nstderr: ${up.stderr}`,
    );
  }

  // 5. Poll /health.
  const deadline = Date.now() + timeoutMs;
  let lastError: string | null = null;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${LOCAL_AGGREGATOR_URL}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (resp.ok) {
        const body = (await resp.json()) as { status?: string; role?: string };
        // BFT-disabled standalone reports status='ok'. BFT-enabled
        // would report 'healthy'. Either is acceptable as proof-of-
        // life; the role discriminator tells the operator which mode
        // is running.
        if (body.status === 'ok' || body.status === 'healthy') {
          log(
            prefix,
            `aggregator healthy: status=${body.status} role=${body.role ?? '?'} on ${LOCAL_AGGREGATOR_URL}`,
          );
          return {
            url: LOCAL_AGGREGATOR_URL,
            containerName: 'uxf-e2e-aggregator',
            stop: async (stopOpts) => stopAggregator(prefix, stopOpts?.wipe ?? false),
          };
        }
        lastError = `unexpected /health body: ${JSON.stringify(body).slice(0, 160)}`;
      } else {
        lastError = `HTTP ${resp.status}`;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }

  // Boot failed — capture aggregator + mongo logs before tearing down.
  const aggLogs = spawnSync('docker', ['logs', 'uxf-e2e-aggregator', '--tail', '60'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  const mongoLogs = spawnSync('docker', ['logs', 'uxf-e2e-mongo', '--tail', '20'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  await stopAggregator(prefix, /* wipe */ false);
  throw new Error(
    `local aggregator never became healthy within ${timeoutMs}ms (last error: ${lastError ?? 'unknown'}).\n` +
      `--- aggregator logs (last 60 lines) ---\n${aggLogs.stdout || aggLogs.stderr || '(empty)'}\n` +
      `--- mongo logs (last 20 lines) ---\n${mongoLogs.stdout || mongoLogs.stderr || '(empty)'}`,
  );
}

async function stopAggregator(prefix: string, wipe: boolean): Promise<void> {
  log(prefix, `stopping aggregator + mongo (wipe=${wipe})…`);
  // We only stop the two services we started — ipfs is managed by
  // ipfs.ts's own handle. compose's `stop`/`rm` accepts service names.
  spawnSync(
    'docker',
    ['compose', '-f', COMPOSE_FILE, 'stop', 'aggregator', 'mongodb'],
    { encoding: 'utf8', timeout: 30_000 },
  );
  spawnSync(
    'docker',
    ['compose', '-f', COMPOSE_FILE, 'rm', '-f', '-s', 'aggregator', 'mongodb'],
    { encoding: 'utf8', timeout: 30_000 },
  );
  if (wipe) {
    // `compose down -v` without service args would tear down the WHOLE
    // stack (including relay). Drop the two volumes we own explicitly.
    spawnSync('docker', ['volume', 'rm', 'local-infra_mongo-data'], {
      encoding: 'utf8',
      timeout: 15_000,
    });
  }
}
