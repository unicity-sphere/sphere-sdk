/**
 * Local IPFS (Kubo) lifecycle.
 *
 * Wraps `docker compose --profile full up/down` for the `ipfs` service
 * in tests/e2e/local-infra/docker-compose.yml. Runs vanilla
 * `ipfs/kubo:latest` with default config — wallets publish their own
 * CAR bundles via the API (5001 → host 5002) and read back via the
 * gateway (8080 → host 8082).
 *
 * No pre-seeded data; the repo is empty on each fresh `wipe` boot.
 * Tests that need IPFS content publish it themselves (the SDK's
 * IpfsStorageProvider handles add/pin/resolve).
 *
 * @module tests/e2e/local-infra/ipfs
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPOSE_FILE = join(__dirname, 'docker-compose.yml');

/** Kubo HTTP API URL (POST verbs). */
export const LOCAL_IPFS_API_URL = 'http://127.0.0.1:5002';
/** Kubo HTTP Gateway URL (GET /ipfs/<cid>). */
export const LOCAL_IPFS_GATEWAY_URL = 'http://127.0.0.1:8082';

export interface IpfsBootOptions {
  /** Drop the persisted IPFS repo (pinned CIDs etc.) before booting. Default false. */
  readonly wipe?: boolean;
  /** Total deadline for the daemon to come up. Default 120s. */
  readonly timeoutMs?: number;
  /** Optional log prefix. */
  readonly logPrefix?: string;
}

export interface IpfsHandle {
  /** Kubo HTTP API URL (used by SDK IPFS provider for add/pin/cat). */
  readonly apiUrl: string;
  /** Kubo HTTP Gateway URL (used by SDK IPFS provider for resolve-by-CID). */
  readonly gatewayUrl: string;
  /** Container name. */
  readonly containerName: string;
  /** Stop + remove. Idempotent. */
  stop(opts?: { wipe?: boolean }): Promise<void>;
}

const log = (prefix: string, msg: string): void => {
   
  console.log(`${prefix}${msg}`);
};

/**
 * Boot the `ipfs` compose service and poll its API for readiness.
 */
export async function bootLocalIpfs(
  opts: IpfsBootOptions = {},
): Promise<IpfsHandle> {
  const prefix = opts.logPrefix ?? '[local-ipfs] ';
  const timeoutMs = opts.timeoutMs ?? 120_000;

  // 1. Sanity check: docker CLI present.
  const dockerVersion = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
  });
  if (dockerVersion.status !== 0) {
    throw new Error(
      `docker is not available (exit ${dockerVersion.status}): ${dockerVersion.stderr || dockerVersion.stdout}.`,
    );
  }

  // 2. Optional wipe.
  if (opts.wipe) {
    log(prefix, 'wiping previous ipfs-data volume…');
    spawnSync(
      'docker',
      ['compose', '-f', COMPOSE_FILE, 'stop', 'ipfs'],
      { encoding: 'utf8', timeout: 30_000 },
    );
    spawnSync(
      'docker',
      ['compose', '-f', COMPOSE_FILE, 'rm', '-f', '-s', 'ipfs'],
      { encoding: 'utf8', timeout: 30_000 },
    );
    spawnSync('docker', ['volume', 'rm', 'local-infra_ipfs-data'], {
      encoding: 'utf8',
      timeout: 15_000,
    });
  }

  // 3. Boot.
  log(prefix, `booting ipfs (kubo) from ${COMPOSE_FILE}…`);
  const up = spawnSync(
    'docker',
    ['compose', '-f', COMPOSE_FILE, '--profile', 'full', 'up', '-d', 'ipfs'],
    { encoding: 'utf8', timeout: 180_000 },
  );
  if (up.status !== 0) {
    throw new Error(
      `docker compose up failed (exit ${up.status}):\nstdout: ${up.stdout}\nstderr: ${up.stderr}`,
    );
  }

  // 4. Poll API version.
  const deadline = Date.now() + timeoutMs;
  let lastError: string | null = null;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${LOCAL_IPFS_API_URL}/api/v0/version`, {
        method: 'POST',
        signal: AbortSignal.timeout(2_000),
      });
      if (resp.ok) {
        const body = (await resp.json()) as { Version?: string; Commit?: string };
        log(
          prefix,
          `ipfs healthy: kubo ${body.Version ?? '?'} (${body.Commit ?? '?'}) on api=${LOCAL_IPFS_API_URL} gateway=${LOCAL_IPFS_GATEWAY_URL}`,
        );
        return {
          apiUrl: LOCAL_IPFS_API_URL,
          gatewayUrl: LOCAL_IPFS_GATEWAY_URL,
          containerName: 'uxf-e2e-ipfs',
          stop: async (stopOpts) => stopIpfs(prefix, stopOpts?.wipe ?? false),
        };
      }
      lastError = `HTTP ${resp.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }

  const logs = spawnSync('docker', ['logs', 'uxf-e2e-ipfs', '--tail', '60'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  await stopIpfs(prefix, /* wipe */ false);
  throw new Error(
    `local ipfs never became healthy within ${timeoutMs}ms (last error: ${lastError ?? 'unknown'}).\n` +
      `--- ipfs logs (last 60 lines) ---\n${logs.stdout || logs.stderr || '(empty)'}`,
  );
}

async function stopIpfs(prefix: string, wipe: boolean): Promise<void> {
  log(prefix, `stopping ipfs (wipe=${wipe})…`);
  spawnSync(
    'docker',
    ['compose', '-f', COMPOSE_FILE, 'stop', 'ipfs'],
    { encoding: 'utf8', timeout: 30_000 },
  );
  spawnSync(
    'docker',
    ['compose', '-f', COMPOSE_FILE, 'rm', '-f', '-s', 'ipfs'],
    { encoding: 'utf8', timeout: 30_000 },
  );
  if (wipe) {
    spawnSync('docker', ['volume', 'rm', 'local-infra_ipfs-data'], {
      encoding: 'utf8',
      timeout: 15_000,
    });
  }
}
