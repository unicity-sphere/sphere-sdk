/**
 * tests/harness/support/stack.ts — the phase-2 stack contract (no vitest
 * imports: the child-process wallet runner shares this module).
 *
 * The suite runs against the wallet-api repo's `docker-compose.dev.yml` stack
 * (development-workflow.md phase 2): real backend over real HTTP, real
 * Postgres/Redis/MinIO behind it, and the §18 LOCAL mock aggregator behind the
 * real state-transition-sdk JSON-RPC wire protocol. Host surface (loopback):
 *
 *   http://127.0.0.1:${WALLET_API_PORT:-3000}   wallet-api
 *   http://127.0.0.1:${AGGREGATOR_PORT:-3001}   mock aggregator (+ /trustbase.json)
 *
 * `WALLET_API_DIR` points at the wallet-api checkout (default: the sibling
 * `../wallet-api`); the global setup boots/tears the stack from there.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { getPublicKey } from '../../../core/crypto';

export interface HarnessStack {
  /** wallet-api base URL (loopback http — allowed by the §4 client rule). */
  readonly baseUrl: string;
  /** Mock-aggregator JSON-RPC base URL (also serves /trustbase.json). */
  readonly aggregatorUrl: string;
  /** Must match the backend's NETWORK env (auth challenges embed it — §4). */
  readonly network: string;
}

export function stackFromEnv(): HarnessStack {
  const apiPort = process.env.WALLET_API_PORT ?? '3000';
  const aggPort = process.env.AGGREGATOR_PORT ?? '3001';
  return {
    baseUrl: `http://127.0.0.1:${apiPort}`,
    aggregatorUrl: `http://127.0.0.1:${aggPort}`,
    network: 'testnet2', // docker-compose.dev.yml NETWORK; fixture tokens stay on NetworkId.LOCAL
  };
}

/** The wallet-api checkout that carries docker-compose.dev.yml. */
export function walletApiDir(): string {
  const dir = resolve(process.cwd(), process.env.WALLET_API_DIR ?? '../wallet-api');
  if (!existsSync(resolve(dir, 'docker-compose.dev.yml'))) {
    throw new Error(
      `wallet-api checkout not found at ${dir} (no docker-compose.dev.yml). ` +
        'The harness is local-only and needs the sibling wallet-api repo — set WALLET_API_DIR. ' +
        'See development-workflow.md (phase-2 harness).'
    );
  }
  return dir;
}

/** The shared LOCAL trustbase, fetched from the stack's mock aggregator. */
export async function fetchTrustbaseJson(aggregatorUrl: string): Promise<unknown> {
  const res = await fetch(`${aggregatorUrl}/trustbase.json`);
  if (!res.ok) throw new Error(`trustbase fetch failed: HTTP ${res.status}`);
  return res.json();
}

/** A fresh random secp256k1 identity — every test isolates by owner. */
export function randomIdentity(): { privateKey: string; chainPubkey: string } {
  for (;;) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const privateKey = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    try {
      return { privateKey, chainPubkey: getPublicKey(privateKey) };
    } catch {
      // out-of-range scalar (probability ~2^-128) — draw again
    }
  }
}

/** The harness coin (64-hex canonical AssetId, like the model suites). */
export const HARNESS_COIN = '11'.repeat(32);
