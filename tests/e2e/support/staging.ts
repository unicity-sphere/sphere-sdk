/**
 * Shared plumbing for the LIVE staging e2e suites (vertical, session,
 * sphere-wiring): env-derived endpoints, the pinned testnet2 trust base, the
 * Node `ws` adapter, and a plain in-memory ScopedKV.
 */

import { WebSocket as NodeWebSocket } from 'ws';

import type { ScopedKV } from '../../../modules/payments-v2/stores';

export const STAGING_API_KEY = process.env.STAGING_AGGREGATOR_KEY;
export const RUN_STAGING = STAGING_API_KEY !== undefined && STAGING_API_KEY !== '';

export const BASE_URL = process.env.STAGING_WALLET_API ?? 'https://wallet-api.staging.unicity.network';
export const AGGREGATOR_URL = process.env.STAGING_AGGREGATOR ?? 'https://gateway.testnet2.unicity.network';
export const TRUSTBASE_URL =
  process.env.STAGING_TRUSTBASE ??
  'https://raw.githubusercontent.com/unicitynetwork/unicity-ids/main/bft-trustbase.testnet2.json';
export const NETWORK = 'testnet2';

// Structurally satisfies BOTH WebSocketLike shapes (impl/wallet-api-v2/session
// and the old wallet-api/types) — the suites pass it to either factory slot.
export interface StagingWebSocket {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: { code?: number; reason?: string }) => void) | null;
  onerror: ((err?: unknown) => void) | null;
  close(code?: number, reason?: string): void;
}

export function nodeWsFactory(url: string): StagingWebSocket {
  const ws = new NodeWebSocket(url);
  const like: StagingWebSocket = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    close: (code?: number, reason?: string) => ws.close(code, reason),
  };
  ws.on('open', () => like.onopen?.());
  ws.on('message', (data) => like.onmessage?.({ data: data.toString() }));
  ws.on('close', (code) => like.onclose?.({ code }));
  ws.on('error', (err) => like.onerror?.(err));
  return like;
}

// Fetched ONCE per run — the same pinned testnet2 root for every staging suite.
let trustbasePromise: Promise<unknown> | null = null;
export function trustbase(): Promise<unknown> {
  trustbasePromise ??= (async () => {
    const res = await fetch(TRUSTBASE_URL);
    if (!res.ok) throw new Error(`trustbase fetch failed: HTTP ${String(res.status)} (${TRUSTBASE_URL})`);
    return res.json() as Promise<unknown>;
  })();
  return trustbasePromise;
}

export function memoryKV(): ScopedKV {
  const m = new Map<string, unknown>();
  return {
    get: async <T,>(k: string) => (m.has(k) ? (m.get(k) as T) : null),
    set: async (k, v) => void m.set(k, v),
    remove: async (k) => void m.delete(k),
  };
}
