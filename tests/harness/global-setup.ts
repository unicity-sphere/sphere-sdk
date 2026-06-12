/**
 * tests/harness/global-setup.ts — boots the wallet-api compose stack once for
 * the whole harness run, programmatically, and tears it down after.
 *
 * Drives `docker compose ... up --build --wait` from the sibling wallet-api
 * checkout (development-workflow.md phase 2): `--wait` blocks until the
 * stack's healthchecks pass, so readiness is observable state, not sleeps.
 * The compose CLI is used directly (rather than testcontainers' compose
 * wrapper) because the stack contains a one-shot init service
 * (minio-init: bucket + versioning) and a service joining another's network
 * namespace — semantics `up --wait` handles natively.
 *
 * - A dedicated project name (`wallet-api-harness`) keeps the harness stack
 *   apart from a developer's own `wallet-api-dev` stack (same fixed loopback
 *   ports though — only one can run at a time, by design: presigned URLs are
 *   signed for 127.0.0.1:9000).
 * - A pre-up `down -v` self-heals stacks leaked by a killed previous run.
 * - `HARNESS_REUSE_STACK=1` skips up/down and reuses whatever already answers
 *   on the ports (the fast inner loop).
 * - `WALLET_API_DIR` overrides the sibling checkout path.
 */

import { execFileSync } from 'node:child_process';

import { stackFromEnv, walletApiDir } from './support/stack';

const PROJECT = 'wallet-api-harness';

function compose(dir: string, args: string[]): void {
  execFileSync('docker', ['compose', '-p', PROJECT, '-f', 'docker-compose.dev.yml', ...args], {
    cwd: dir,
    stdio: 'inherit',
    timeout: 15 * 60 * 1000,
  });
}

async function assertStackAnswers(): Promise<void> {
  const stack = stackFromEnv();
  for (const url of [`${stack.baseUrl}/v1/health`, `${stack.aggregatorUrl}/health`]) {
    const res = await fetch(url).catch((err: unknown) => {
      throw new Error(`harness stack not reachable at ${url}: ${String(err)}`);
    });
    if (!res.ok) throw new Error(`harness stack unhealthy at ${url}: HTTP ${res.status}`);
  }
}

export default async function setup(): Promise<() => Promise<void>> {
  if (process.env.HARNESS_REUSE_STACK === '1') {
    await assertStackAnswers();
    return async () => {};
  }
  const dir = walletApiDir();
  compose(dir, ['down', '-v', '--remove-orphans']); // self-heal a leaked stack
  compose(dir, ['up', '--build', '--wait']); // returns when healthchecks pass
  await assertStackAnswers();
  return async () => {
    compose(dir, ['down', '-v']);
  };
}
