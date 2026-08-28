/**
 * The aggregator stack `test:aggregator` runs against, driven by Testcontainers.
 *
 * Adapted from state-transition-sdk-js `tests/integration/support/aggregatorStack.mjs`
 * so the three SDKs exercise one topology; see ../docker/docker-compose.yml.
 */

import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { DockerComposeEnvironment, Wait } from 'testcontainers';

const COMPOSE_DIR = path.join(__dirname, '..', 'docker');
const DATA_DIR = path.join(COMPOSE_DIR, 'data');
const TRUST_BASE_PATH = path.join(DATA_DIR, 'genesis', 'trust-base.json');

/** The aggregator's own port inside the container; the host port is ephemeral. */
const AGGREGATOR_PORT = 3000;
/** Genesis, a replica-set election and the first certified round, on a cold start. */
const STARTUP_TIMEOUT_MS = 240_000;

export interface AggregatorStack {
  readonly url: string;
  readonly trustBasePath: string;
  stop(): Promise<void>;
}

async function blockHeight(url: string): Promise<bigint | null> {
  try {
    const response = await fetch(url, {
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'get_block_height', params: {} }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const { result } = (await response.json()) as { result?: { blockNumber?: string } };
    return result?.blockNumber != null ? BigInt(result.blockNumber) : null;
  } catch {
    return null;
  }
}

/**
 * Block until consensus is certifying rounds.
 *
 * A healthy aggregator is not a usable one: until consensus hands it a reference
 * time it answers every certification request with SERVICE_NOT_READY, so the
 * tests would fail against a service that is merely still starting.
 */
async function waitForCertification(url: string): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const height = await blockHeight(url);
    if (height != null && height > 0n) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Aggregator at ${url} did not certify a block within ${String(STARTUP_TIMEOUT_MS)}ms.`);
}

/**
 * Start the stack. The suite always runs against one it started itself, on a
 * chain that begins empty — pointing it at a service someone else is running is
 * what `test:e2e` is for, and would mean a green run proved nothing about the
 * compose file this suite exists to exercise.
 */
export async function startAggregatorStack(): Promise<AggregatorStack> {
  // Genesis is bind-mounted and survives a container teardown. Reusing it against
  // the fresh mongodb and redis volumes below would pair a chain that remembers
  // nothing with a root node that remembers everything.
  await rm(DATA_DIR, { force: true, recursive: true });
  await mkdir(path.join(DATA_DIR, 'genesis'), { recursive: true });
  await mkdir(path.join(DATA_DIR, 'genesis-root'), { recursive: true });

  const environment = await new DockerComposeEnvironment(COMPOSE_DIR, 'docker-compose.yml')
    .withEnvironment({
      // Port 0 publishes on an ephemeral host port, so concurrent runs and CI
      // jobs cannot collide on a fixed one.
      AGGREGATOR_PORT: '0',
      USER_GID: String(process.getgid?.() ?? 1001),
      USER_UID: String(process.getuid?.() ?? 1001),
    })
    .withWaitStrategy(
      'aggregator-1',
      Wait.forHttp('/health', AGGREGATOR_PORT).forStatusCode(200).withStartupTimeout(STARTUP_TIMEOUT_MS),
    )
    .withStartupTimeout(STARTUP_TIMEOUT_MS)
    .up();

  const aggregator = environment.getContainer('aggregator-1');
  const url = `http://${aggregator.getHost()}:${String(aggregator.getMappedPort(AGGREGATOR_PORT))}`;
  await waitForCertification(url);

  return {
    stop: async (): Promise<void> => {
      await environment.down({ removeVolumes: true });
      await rm(DATA_DIR, { force: true, recursive: true });
    },
    trustBasePath: TRUST_BASE_PATH,
    url,
  };
}
