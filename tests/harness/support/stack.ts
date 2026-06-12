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
  /** Aggregator JSON-RPC base URL (the stack's mock, or the REAL gateway in live mode). */
  readonly aggregatorUrl: string;
  /** Must match the backend's NETWORK env (auth challenges embed it — §4). */
  readonly network: string;
  /** Gateway API key (live mode only — testnet2 requires it for submits). NEVER logged. */
  readonly aggregatorApiKey?: string;
  /**
   * Where the trustbase JSON lives. The mock aggregator serves its own at
   * /trustbase.json; the live suite points at the REAL pinned testnet2 root
   * (the same URL the backend's §8.2 boot pin uses).
   */
  readonly trustbaseUrl?: string;
}

/**
 * Live-mode handoff to child processes: the crash-drill runner is a separate
 * OS process that rebuilds its stack via `stackFromEnv()`, so the live suite
 * exports its configuration through HARNESS_LIVE_* env vars (set by
 * tests/harness/live/support/live-stack.ts; inherited via spawn env).
 */
export function stackFromEnv(): HarnessStack {
  const apiPort = process.env.WALLET_API_PORT ?? '3000';
  const aggPort = process.env.AGGREGATOR_PORT ?? '3001';
  const base = {
    baseUrl: `http://127.0.0.1:${apiPort}`,
    network: 'testnet2', // docker-compose.dev.yml NETWORK; fixture tokens stay on NetworkId.LOCAL
  };
  const liveAggregatorUrl = process.env.HARNESS_LIVE_AGGREGATOR_URL;
  const liveTrustbaseUrl = process.env.HARNESS_LIVE_TRUSTBASE_URL;
  if (liveAggregatorUrl && liveTrustbaseUrl) {
    return {
      ...base,
      aggregatorUrl: liveAggregatorUrl,
      trustbaseUrl: liveTrustbaseUrl,
      ...(process.env.HARNESS_LIVE_AGGREGATOR_KEY
        ? { aggregatorApiKey: process.env.HARNESS_LIVE_AGGREGATOR_KEY }
        : {}),
    };
  }
  return { ...base, aggregatorUrl: `http://127.0.0.1:${aggPort}` };
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

/** The stack's trustbase: the mock's own LOCAL root, or the REAL pinned one in live mode. */
export async function fetchTrustbaseJson(stack: HarnessStack): Promise<unknown> {
  const url = stack.trustbaseUrl ?? `${stack.aggregatorUrl}/trustbase.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`trustbase fetch failed: HTTP ${res.status} (${url})`);
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
