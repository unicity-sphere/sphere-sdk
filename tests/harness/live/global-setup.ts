/**
 * tests/harness/live/global-setup.ts — boots the wallet-api compose stack with
 * the REAL testnet2 validation roots (docker-compose.dev.yml +
 * docker-compose.live.yml override) once for the live S5 run, and probes the
 * REAL gateway before any test spends the key.
 *
 * §18 triage rule (ARCHITECTURE): an unreachable testnet/gateway is an INFRA
 * blocker — this setup fails loudly with a BLOCKER message; it never licenses
 * code changes or test weakening. `HARNESS_REUSE_STACK=1` reuses a running
 * stack (the fast inner loop); `WALLET_API_DIR` overrides the sibling path.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { walletApiDir } from '../support/stack';
import { liveStackFromEnv } from './support/live-stack';

const PROJECT = 'wallet-api-live';
const FILES = ['-f', 'docker-compose.dev.yml', '-f', 'docker-compose.live.yml'];

function compose(dir: string, args: string[]): void {
  execFileSync('docker', ['compose', '-p', PROJECT, ...FILES, ...args], {
    cwd: dir,
    stdio: 'inherit',
    timeout: 15 * 60 * 1000,
  });
}

async function assertBackendAnswers(baseUrl: string): Promise<void> {
  const url = `${baseUrl}/v1/health`;
  const res = await fetch(url).catch((err: unknown) => {
    throw new Error(`live stack not reachable at ${url}: ${String(err)}`);
  });
  if (!res.ok) throw new Error(`live stack unhealthy at ${url}: HTTP ${res.status}`);
}

/**
 * Gateway reachability probe: an unauthenticated `get_inclusion_proof.v2` for
 * a random (never-certified) stateId — answers 200 with a non-inclusion proof
 * when the gateway is up. Spends nothing and needs no key.
 */
async function assertGatewayAnswers(aggregatorUrl: string): Promise<void> {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'get_inclusion_proof.v2',
    params: { stateId: randomBytes(32).toString('hex') },
  };
  const res = await fetch(aggregatorUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch((err: unknown) => {
    throw new Error(
      `§18 BLOCKER (infra): testnet2 gateway not reachable at ${aggregatorUrl}: ${String(err)} — ` +
        'retry later; do NOT change code or weaken tests for this.'
    );
  });
  if (!res.ok) {
    throw new Error(
      `§18 BLOCKER (infra): testnet2 gateway unhealthy at ${aggregatorUrl}: HTTP ${res.status} — ` +
        'retry later; do NOT change code or weaken tests for this.'
    );
  }
}

export default async function setup(): Promise<() => Promise<void>> {
  // Validates the key EXISTS (names only, never values) before a 2-minute
  // compose build can waste the failure.
  const stack = liveStackFromEnv();
  await assertGatewayAnswers(stack.aggregatorUrl);

  if (process.env.HARNESS_REUSE_STACK === '1') {
    await assertBackendAnswers(stack.baseUrl);
    return async () => {};
  }
  const dir = walletApiDir();
  compose(dir, ['down', '-v', '--remove-orphans']); // self-heal a leaked stack
  compose(dir, ['up', '--build', '--wait']); // returns when healthchecks pass (incl. real-roots pin fetch)
  await assertBackendAnswers(stack.baseUrl);
  return async () => {
    compose(dir, ['down', '-v']);
  };
}
