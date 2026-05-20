/**
 * Local aggregator + MongoDB lifecycle.
 *
 * Wraps `docker compose --profile full up/down` for the `mongodb` +
 * `aggregator` services in tests/e2e/local-infra/docker-compose.yml.
 *
 * The aggregator runs in `BFT_ENABLED=false` standalone mode — block
 * production via internal 1s timer through `bft.NewBFTClientStub`. Real
 * SMT, real inclusion proofs, but no UnicityCertificate attached to
 * blocks. Tests that exercise `Sphere.init({ nametag })` against this
 * stack must set `SPHERE_ORACLE_SKIP_VERIFICATION=1` to bypass the
 * trust-base verification on `Token.mint`. The trade-off is documented
 * in the PR description.
 *
 * **Foundation for hermetic BFT-enabled mode** is also checked in
 * (compose profile `full-bft`: bft-root + bft-aggregator-genesis-gen +
 * upload-shard-conf), but the cert flow between bft-root and the
 * aggregator does not yet complete. That work is tracked as a
 * follow-up and is not invoked by this helper.
 *
 * Cold-boot sequence (first run, ~45-60s):
 *   1. `setup-aggregator-src.sh` clones aggregator-go @ pinned commit.
 *   2. `docker compose build` compiles the aggregator binary (~30s).
 *   3. mongodb comes up (healthcheck on adminCommand:ping).
 *   4. aggregator starts (BFT_ENABLED=false → standalone block
 *      production with the BFTClientStub).
 *
 * Subsequent runs reuse the local image cache — typical ~10s.
 *
 * **Why we still pass USER_UID/USER_GID.** The bind-mount for
 * `.bft-data/genesis` is referenced by the BFT services (compose
 * profile `full-bft`). When a dev opts into that profile, the
 * USER_UID env vars keep file ownership consistent with the host
 * user. Always passing them is harmless in the standalone-only path.
 *
 * @module tests/e2e/local-infra/aggregator
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPOSE_FILE = join(__dirname, 'docker-compose.yml');
const SETUP_SCRIPT = join(__dirname, 'setup-aggregator-src.sh');
const BFT_DATA_DIR = join(__dirname, '.bft-data');
const GENESIS_DIR = join(BFT_DATA_DIR, 'genesis');
const GENESIS_ROOT_DIR = join(BFT_DATA_DIR, 'genesis-root');
const TRUST_BASE_PATH = join(GENESIS_DIR, 'trust-base.json');

/**
 * URL the aggregator listens on (matches docker-compose port mapping).
 */
export const LOCAL_AGGREGATOR_URL = 'http://127.0.0.1:3001';

/**
 * Absolute path of the host-side trust-base.json file the local BFT
 * stack produces. The SDK reads this via `oracle.trustBasePath`
 * (threaded through `SPHERE_TRUST_BASE_PATH` env var). The file only
 * exists after the BFT init containers have run successfully.
 */
export const LOCAL_AGGREGATOR_TRUST_BASE_PATH = TRUST_BASE_PATH;

export interface AggregatorBootOptions {
  /** Drop the persisted MongoDB volume + BFT genesis dir + rebuild
   *  aggregator image. Default false (genesis files persist between
   *  runs, which is the right default — re-running with the same
   *  trust base is faster + tests can rely on stable keys). */
  readonly wipe?: boolean;
  /** Total deadline for the aggregator to become healthy. Default 240s
   *  (covers a cold first-run Docker build of aggregator-go + BFT
   *  genesis generation + a few BFT round-trips for /health to flip). */
  readonly timeoutMs?: number;
  /** Optional prefix for log lines so multi-stack output is greppable. */
  readonly logPrefix?: string;
}

export interface AggregatorHandle {
  /** HTTP JSON-RPC URL clients connect to. */
  readonly url: string;
  /** Absolute path to trust-base.json on the host (SDK reads this for
   *  inclusion-proof verification). */
  readonly trustBasePath: string;
  /** Aggregator container name. */
  readonly containerName: string;
  /** Stop + remove the aggregator AND its mongo + BFT services.
   *  Idempotent. */
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
 * Pre-create the bind-mount directories with the current user's
 * ownership. If Docker creates them on first compose-up, they end up
 * root-owned (the daemon runs as root) and the BFT containers — which
 * we drop to the host user via USER_UID/USER_GID — can't write into
 * them. Doing the mkdir from this host-side process ensures the
 * directories are owned by the running user before any container
 * touches them.
 *
 * If a previous run left root-owned files in there (e.g. an earlier
 * boot before this fix landed), the BFT init container's first
 * operation will fail with "permission denied". We could `docker run
 * --rm chown` the tree here, but that pulls another image and slows
 * cold-start; instead, surface a clear error and let the operator
 * clean up.
 */
function ensureBftDataDirs(prefix: string): void {
  for (const dir of [BFT_DATA_DIR, GENESIS_DIR, GENESIS_ROOT_DIR]) {
    if (!existsSync(dir)) {
      log(prefix, `pre-creating bind-mount dir: ${dir}`);
      mkdirSync(dir, { recursive: true });
    }
  }
}

/**
 * Compose `up/down/stop/rm` invocations. We always pass USER_UID +
 * USER_GID in the env so the BFT containers write genesis files as
 * the host user (avoids the root-owned-bind-mount problem on Linux).
 *
 * On macOS / Windows Docker Desktop the values are inherited from the
 * docker VM's user space; passing them as numeric ids is harmless but
 * the permission semantics differ. Tests on those platforms haven't
 * been validated here.
 */
function composeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    USER_UID: String(process.getuid?.() ?? 1000),
    USER_GID: String(process.getgid?.() ?? 1000),
  };
}

/**
 * Boot `mongodb` + `aggregator` (BFT_ENABLED=false standalone) via
 * compose `--profile full` and wait for the aggregator's /health to
 * respond 200.
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

  // 2. Pre-create the BFT bind-mount tree even though the standalone
  //    aggregator path doesn't use it — keeps the on-disk layout
  //    consistent for devs opting into the experimental `full-bft`
  //    profile and avoids root-ownership surprises on first opt-in.
  ensureBftDataDirs(prefix);

  // 3. Fetch the pinned aggregator-go source (first run clones; subsequent
  //    runs are no-ops). Failures here surface BEFORE we ask compose to
  //    build, so the error message is clearer.
  ensureAggregatorSource(prefix);

  // 4. Optional: wipe persisted state.
  if (opts.wipe) {
    log(prefix, 'wiping previous aggregator + mongo volumes…');
    spawnSync(
      'docker',
      ['compose', '-f', COMPOSE_FILE, '--profile', 'full', 'down', '-v'],
      { encoding: 'utf8', timeout: 60_000, env: composeEnv() },
    );
  }

  // 5. Boot mongo + aggregator (standalone). `--profile full` would
  //    also start relay + ipfs if not yet up, but those are managed
  //    by their own helpers — passing explicit service names keeps
  //    this helper scoped to what it owns.
  log(prefix, `booting mongo + aggregator from ${COMPOSE_FILE}…`);
  const up = spawnSync(
    'docker',
    [
      'compose', '-f', COMPOSE_FILE, '--profile', 'full', 'up', '-d',
      'mongodb', 'aggregator',
    ],
    { encoding: 'utf8', timeout: 600_000, env: composeEnv() },
  );
  if (up.status !== 0) {
    throw new Error(
      `docker compose up failed (exit ${up.status}):\nstdout: ${up.stdout}\nstderr: ${up.stderr}`,
    );
  }

  // 6. Poll /health.
  const deadline = Date.now() + timeoutMs;
  let lastError: string | null = null;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${LOCAL_AGGREGATOR_URL}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (resp.ok) {
        const body = (await resp.json()) as { status?: string; role?: string };
        // BFT mode reports status='healthy', BFT-disabled standalone
        // reports status='ok'. Either is acceptable as proof-of-life.
        if (body.status === 'ok' || body.status === 'healthy') {
          log(
            prefix,
            `aggregator healthy: status=${body.status} role=${body.role ?? '?'} on ${LOCAL_AGGREGATOR_URL}`,
          );
          // The trust-base path is only meaningful when the `full-bft`
          // profile is in use (the file is produced by bft-root). In
          // the default standalone path the file does not exist; we
          // surface the path anyway so callers can check `existsSync`
          // before wiring `SPHERE_TRUST_BASE_PATH`.
          return {
            url: LOCAL_AGGREGATOR_URL,
            trustBasePath: TRUST_BASE_PATH,
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
      `--- aggregator logs ---\n${aggLogs.stdout || aggLogs.stderr || '(empty)'}\n` +
      `--- mongo logs ---\n${mongoLogs.stdout || mongoLogs.stderr || '(empty)'}`,
  );
}

async function stopAggregator(prefix: string, wipe: boolean): Promise<void> {
  log(prefix, `stopping aggregator + mongo (wipe=${wipe})…`);
  const env = composeEnv();
  // Stop only what we started — ipfs + relay are managed by their
  // own helpers.
  for (const svc of ['aggregator', 'mongodb']) {
    spawnSync(
      'docker',
      ['compose', '-f', COMPOSE_FILE, 'stop', svc],
      { encoding: 'utf8', timeout: 30_000, env },
    );
    spawnSync(
      'docker',
      ['compose', '-f', COMPOSE_FILE, 'rm', '-f', '-s', svc],
      { encoding: 'utf8', timeout: 30_000, env },
    );
  }
  if (wipe) {
    spawnSync('docker', ['volume', 'rm', 'local-infra_mongo-data'], {
      encoding: 'utf8',
      timeout: 15_000,
    });
  }
}
