/**
 * Local faucet lifecycle.
 *
 * Spawns the js-faucet image (built via /home/vrogojin/js-faucet/Dockerfile,
 * tagged `ghcr.io/unicitynetwork/agentic-hosting/faucet:local`) directly
 * via `docker run -d`, attached to the host network so it can reach the
 * local relay on 127.0.0.1:7777 and the public testnet aggregator/IPFS.
 *
 * Why direct `docker run` instead of going through agentic-hosting's
 * Host Manager? The HMA stack adds a wallet-bootstrap + spawn DM round-
 * trip for the manager, plus a control DM for each spawn. That works
 * for trader-service's e2e (which exercises the HMA's lifecycle path)
 * but is overkill here — we only need a faucet that listens for
 * `FAUCET_REQUEST` DMs. The faucet's manager-handshake never has to
 * complete: the public-faucet command path runs as soon as the DM
 * subscription is up, regardless of whether `acp.hello_ack` ever
 * arrives.
 *
 * The faucet's own pubkey is logged to stdout at boot. We tail the
 * container logs until we see the `chain_pubkey` field, then export
 * it as `E2E_LOCAL_FAUCET_PUBKEY` for tests.
 *
 * @module tests/e2e/local-infra/faucet
 */

import { spawnSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';

/**
 * Image tag the faucet container runs from. The image MUST be built
 * locally before global-setup runs:
 *
 *   cd /home/vrogojin && docker build -f js-faucet/Dockerfile \
 *     -t ghcr.io/unicitylabs/agentic-hosting/faucet:local .
 *
 * The agentic-hosting/templates.json references the same tag (with
 * `unicitylabs` typo'd as `unicitynetwork` in places — both names
 * are in active use across the org).
 */
const FAUCET_IMAGE_DEFAULT = 'ghcr.io/unicitynetwork/agentic-hosting/faucet:local';

export interface FaucetBootOptions {
  /** Image tag override. Default: `ghcr.io/unicitynetwork/agentic-hosting/faucet:local`. */
  readonly image?: string;
  /** Container name. Default: `uxf-e2e-faucet`. */
  readonly containerName?: string;
  /**
   * Local Nostr relay WebSocket URL the faucet must use. Threaded into
   * the container as `SPHERE_NOSTR_RELAYS` — the SDK env-override
   * picks it up in createNodeProviders.
   */
  readonly relayUrl: string;
  /** Total deadline for the faucet to report its pubkey. Default 120s. */
  readonly timeoutMs?: number;
  /** Optional log prefix. */
  readonly logPrefix?: string;
}

export interface FaucetHandle {
  /** Container name (for `docker logs`). */
  readonly containerName: string;
  /** secp256k1 chain pubkey (compressed, 66 hex chars). */
  readonly chainPubkey: string;
  /** Convenience: `DIRECT://<chainPubkey>`. */
  readonly directAddress: string;
  /** Stop + remove the container. Idempotent. */
  stop(): Promise<void>;
}

const log = (prefix: string, msg: string): void => {
  // eslint-disable-next-line no-console
  console.log(`${prefix}${msg}`);
};

/**
 * Fake but well-formed UNICITY_* env vars for the faucet's tenant
 * config parser. These are tenant-bookkeeping fields the HMA injects
 * in production; the faucet's runtime path doesn't depend on their
 * VALUES being meaningful — only that they parse.
 *
 * The MANAGER_PUBKEY / MANAGER_DIRECT_ADDRESS values are valid (random
 * secp256k1 pubkey + DIRECT-encoded variant) so the tenant-config
 * isHexKey gate passes. We never actually send DMs to that key, so
 * its lack of a real wallet behind it is irrelevant.
 */
function buildTenantEnvFor(relayUrl: string): Record<string, string> {
  // Generate a REAL compressed secp256k1 pubkey for UNICITY_MANAGER_
  // PUBKEY. The faucet's tenant-config validator decompresses the
  // pubkey to verify it's on-curve (not a structural format check),
  // so a random 02-prefixed 32-byte string is rejected with
  // "bad point: is not on curve". Generating a fresh ephemeral
  // keypair is the simplest way through that gate — we never sign
  // or encrypt with this key, so the privkey is discarded
  // immediately.
  const fakeManagerPrivkey = randomBytes(32);
  const fakeManagerPubkey = Buffer.from(
    secp256k1.getPublicKey(fakeManagerPrivkey, /* compressed */ true),
  ).toString('hex');
  const fakeManagerDirect = `DIRECT://${fakeManagerPubkey}`;
  const instanceId = randomUUID();
  return {
    UNICITY_MANAGER_PUBKEY: fakeManagerPubkey,
    UNICITY_MANAGER_DIRECT_ADDRESS: fakeManagerDirect,
    UNICITY_BOOT_TOKEN: randomUUID(),
    UNICITY_INSTANCE_ID: instanceId,
    UNICITY_INSTANCE_NAME: `e2e-local-faucet-${instanceId.slice(0, 8)}`,
    UNICITY_TEMPLATE_ID: 'faucet-agent',
    UNICITY_NETWORK: 'testnet', // aggregator + IPFS still public testnet
    UNICITY_LOG_LEVEL: 'info',
    UNICITY_HEARTBEAT_INTERVAL_MS: '60000',
    // Local infra override — the SDK's createNodeProviders honors
    // SPHERE_NOSTR_RELAYS as a hard relay override (added on the uxf
    // branch for this harness).
    SPHERE_NOSTR_RELAYS: relayUrl,
  };
}

/**
 * Spawn the faucet container, tail its stdout for the boot log line
 * that announces `chain_pubkey`, and return a handle. Throws on
 * timeout or container exit.
 */
export async function bootLocalFaucet(opts: FaucetBootOptions): Promise<FaucetHandle> {
  const prefix = opts.logPrefix ?? '[local-faucet] ';
  const image = opts.image ?? FAUCET_IMAGE_DEFAULT;
  const containerName = opts.containerName ?? 'uxf-e2e-faucet';
  const timeoutMs = opts.timeoutMs ?? 120_000;

  // 1. Pre-clean: any leftover container from a crashed previous run.
  spawnSync('docker', ['rm', '-f', containerName], {
    encoding: 'utf8',
    timeout: 15_000,
  });

  // 2. Verify image is locally available — pulling from GHCR can fail
  //    silently with auth issues; better to surface a clear error here.
  const inspect = spawnSync('docker', ['image', 'inspect', image], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (inspect.status !== 0) {
    throw new Error(
      `faucet image ${image} not available locally. Build it first:\n` +
        `  cd /home/vrogojin && docker build -f js-faucet/Dockerfile -t ${image} .\n` +
        `(or set --image to an alternate tag).`,
    );
  }

  // 3. Spawn the faucet. --network host lets the container reach
  //    127.0.0.1:7777 (the relay) AND wss://goggregator-test.unicity.network
  //    (the public aggregator) without a custom Docker network. On Linux
  //    this is the simplest topology; if portability to Docker Desktop
  //    becomes relevant we can switch to a user-defined bridge with
  //    host.docker.internal.
  log(prefix, `spawning ${containerName} from ${image}…`);
  const env = buildTenantEnvFor(opts.relayUrl);
  // NOTE: deliberately no `--rm`. If the faucet exits before we can
  // capture its logs (crash on bad env, image bug, etc.), `--rm`
  // would race the log-tail loop and we would see "No such
  // container" instead of the actionable failure reason. Teardown
  // calls `docker rm -f` so the container is cleaned up either way.
  const dockerArgs = [
    'run',
    '-d',
    '--name', containerName,
    '--network', 'host',
  ];
  for (const [k, v] of Object.entries(env)) {
    dockerArgs.push('-e', `${k}=${v}`);
  }
  dockerArgs.push(image);

  const run = spawnSync('docker', dockerArgs, {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (run.status !== 0) {
    throw new Error(
      `docker run faucet failed (exit ${run.status}):\nstdout: ${run.stdout}\nstderr: ${run.stderr}`,
    );
  }

  // 4. Tail logs until we see chain_pubkey or the container dies.
  const deadline = Date.now() + timeoutMs;
  let chainPubkey: string | null = null;
  while (Date.now() < deadline) {
    // Container alive?
    const ps = spawnSync(
      'docker',
      ['inspect', '-f', '{{.State.Running}}', containerName],
      { encoding: 'utf8', timeout: 5_000 },
    );
    if (ps.status !== 0 || ps.stdout.trim() !== 'true') {
      const logs = spawnSync('docker', ['logs', containerName, '--tail', '100'], {
        encoding: 'utf8',
        timeout: 5_000,
      });
      throw new Error(
        `faucet container exited prematurely.\n--- logs ---\n${logs.stdout || logs.stderr || '(empty)'}`,
      );
    }

    const logs = spawnSync('docker', ['logs', containerName, '--tail', '200'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    const text = `${logs.stdout}\n${logs.stderr}`;
    chainPubkey = parseChainPubkey(text);
    if (chainPubkey) break;
    await new Promise((r) => setTimeout(r, 1_000));
  }

  if (!chainPubkey) {
    const logs = spawnSync('docker', ['logs', containerName, '--tail', '100'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    spawnSync('docker', ['rm', '-f', containerName], { encoding: 'utf8', timeout: 15_000 });
    throw new Error(
      `faucet did not log chain_pubkey within ${timeoutMs}ms.\n--- logs ---\n${logs.stdout || logs.stderr || '(empty)'}`,
    );
  }

  log(prefix, `faucet ready: chain_pubkey=${chainPubkey.slice(0, 16)}…`);

  return {
    containerName,
    chainPubkey,
    directAddress: `DIRECT://${chainPubkey}`,
    stop: async () => {
      spawnSync('docker', ['rm', '-f', containerName], {
        encoding: 'utf8',
        timeout: 30_000,
      });
    },
  };
}

/**
 * Extract the faucet's secp256k1 chainPubkey from its stdout log lines.
 *
 * The faucet's pino logger emits structured JSON. Boot lines contain
 * either:
 *   `"chain_pubkey":"02ab…"` (preferred — js-faucet logs identity at
 *                              registering_nametag step)
 *   `"pubkey":"02ab…"`        (fallback — older log format)
 *
 * If neither matches, return null and the caller keeps polling.
 */
function parseChainPubkey(text: string): string | null {
  const patterns = [
    /"chain_pubkey"\s*:\s*"((?:02|03)[0-9a-f]{64})"/i,
    /"pubkey"\s*:\s*"((?:02|03)[0-9a-f]{64})"/i,
    /chain_pubkey[=:]\s*((?:02|03)[0-9a-f]{64})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m && typeof m[1] === 'string') return m[1];
  }
  return null;
}
