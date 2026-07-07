/**
 * Shared helpers for Wave 6-P2-6 extended soak scripts. Keeps each
 * scenario file focused on the flow being exercised.
 *
 * Not exported from the package barrel — internal to scripts/.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Sphere } from '../index';
import type { SphereInitResult } from '../core/Sphere';
import { createNodeProviders } from '../impl/nodejs';

export const TESTNET2_GATEWAY = 'https://gateway.testnet2.unicity.network';
export const TESTNET2_API_KEY =
  process.env.TESTNET2_API_KEY ?? 'sk_ddc3cfcc001e4a28ac3fad7407f99590';
export const UCT_COIN_ID =
  'f581d30f593e4b369d684a4563b5246f07b1d265f7178a2c0a82b81f39c24dc0';
export const USDU_COIN_ID =
  'e210f98956f564bfe67ee94fddd386b5157f660d1957169b391f962093a2da2a';

/**
 * Diagnostic log to stderr. `console.error` auto-flushes under tsx —
 * `process.stderr.write` sometimes buffers when the parent redirects.
 */
export function log(tag: string, step: string, detail?: unknown): void {
  const suffix = detail !== undefined ? ` — ${safeJson(detail)}` : '';
  console.error(`[${tag}] ${step}${suffix}`);
}

function safeJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() : val));
}

export function ensureFreshDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Init a fresh wallet against testnet2 with a random mnemonic.
 * Cleans/creates the given data directory. Enables accounting + swap
 * so the invoice soak can share this helper.
 */
export async function initFreshWallet(params: {
  tag: string;
  dataDir: string;
  accounting?: boolean;
  swap?: boolean;
}): Promise<SphereInitResult> {
  ensureFreshDir(params.dataDir);
  log(params.tag, 'initFreshWallet: building providers', { dataDir: params.dataDir });
  const providers = createNodeProviders({
    network: 'testnet2',
    oracle: { apiKey: TESTNET2_API_KEY },
    dataDir: params.dataDir,
    tokensDir: path.join(params.dataDir, 'tokens'),
  });
  log(params.tag, 'initFreshWallet: Sphere.init');
  const result = await Sphere.init({
    ...providers,
    network: 'testnet2',
    tokenEngine: { apiKey: TESTNET2_API_KEY },
    autoGenerate: true,
    accounting: params.accounting ?? false,
    swap: params.swap ?? false,
  });
  const identity = result.sphere.identity!;
  log(params.tag, 'initFreshWallet: ready', {
    chainPubkey: identity.chainPubkey,
    directAddress: identity.directAddress,
    hasTokenEngine: result.sphere.tokenEngine !== null,
  });
  if (result.sphere.tokenEngine === null) {
    throw new Error(
      `${params.tag}: sphere.tokenEngine is null — wave 6-P2-4e wiring missing`,
    );
  }
  return result;
}

/**
 * Await a Sphere event once. Rejects on timeout so the caller sees
 * exactly which step of the pipeline stalled.
 */
export function waitForEvent<T>(
  sphere: import('../core/Sphere').Sphere,
  event: string,
  timeoutMs: number,
  matcher?: (payload: T) => boolean,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const off = sphere.on(event as any, (payload: any) => {
      if (done) return;
      if (matcher && !matcher(payload as T)) return;
      done = true;
      clearTimeout(t);
      off();
      resolve(payload as T);
    });
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      off();
      reject(new Error(`timeout waiting for ${event} after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

/** Force-exit — Nostr transport keeps the Node event loop alive. */
export function forceExit(code: number): never {
  process.exit(code);
}

export function reportPass(payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ result: 'PASSED', ...payload }, null, 2) + '\n');
}

export function reportFail(step: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack =
    err instanceof Error ? err.stack?.split('\n').slice(0, 8).join(' | ') : undefined;
  process.stdout.write(
    JSON.stringify({ result: 'FAILED', failedStep: step, message, stack }, null, 2) + '\n',
  );
}
