/**
 * Network Health Check
 *
 * Standalone utility for checking network service availability before Sphere.init().
 * Uses NETWORKS config for URLs — no providers or Sphere instance needed.
 */

import { NETWORKS, type NetworkType } from '../constants';
import type { NetworkHealthResult, ServiceHealthResult, HealthCheckFn } from '../types';

const DEFAULT_TIMEOUT_MS = 5000;

type ServiceName = 'relay' | 'oracle';

export interface CheckNetworkHealthOptions {
  /** Timeout per service check in ms (default: 5000) */
  timeoutMs?: number;
  /** Which services to check (default: all) */
  services?: ServiceName[];
  /** Custom URLs — override defaults from NETWORKS[network] */
  urls?: {
    /** Custom Nostr relay WebSocket URL (e.g. 'wss://my-relay.example.com') */
    relay?: string;
    /** Custom aggregator HTTP URL (e.g. 'https://my-aggregator.example.com') */
    oracle?: string;
  };
  /**
   * Custom health checks — run in parallel alongside built-in checks.
   * Key = service name (e.g. 'mongodb', 'ipfs', 'redis'), value = check function.
   *
   * @example
   * ```typescript
   * const health = await checkNetworkHealth('testnet', {
   *   checks: {
   *     mongodb: async (timeoutMs) => {
   *       const start = Date.now();
   *       try {
   *         await mongoClient.db().command({ ping: 1 });
   *         return { healthy: true, url: 'mongodb://localhost:27017', responseTimeMs: Date.now() - start };
   *       } catch (err) {
   *         return { healthy: false, url: 'mongodb://localhost:27017', responseTimeMs: null, error: err.message };
   *       }
   *     },
   *   },
   * });
   * // health.services.mongodb?.healthy
   * ```
   */
  checks?: Record<string, HealthCheckFn>;
}

/**
 * Check network service availability before Sphere.init().
 *
 * Runs all checks in parallel. Each service is tested independently with its own timeout.
 *
 * @example
 * ```typescript
 * import { checkNetworkHealth } from '@unicitylabs/sphere-sdk';
 *
 * const health = await checkNetworkHealth('testnet');
 * if (health.healthy) {
 *   // Safe to init
 *   const { sphere } = await Sphere.init({ ... });
 * } else {
 *   // Show which services are down
 *   for (const [name, result] of Object.entries(health.services)) {
 *     if (!result.healthy) console.warn(`${name}: ${result.error}`);
 *   }
 * }
 *
 * // Check only specific services
 * const relayHealth = await checkNetworkHealth('testnet', { services: ['relay'] });
 *
 * // Use custom URLs instead of defaults
 * const custom = await checkNetworkHealth('testnet', {
 *   urls: {
 *     relay: 'wss://my-relay.example.com',
 *     oracle: 'https://my-aggregator.example.com',
 *   },
 * });
 *
 * // Add custom health checks for your own providers
 * const health = await checkNetworkHealth('testnet', {
 *   checks: {
 *     mongodb: async (timeoutMs) => {
 *       const start = Date.now();
 *       try {
 *         await mongoClient.db().command({ ping: 1 });
 *         return { healthy: true, url: 'mongodb://localhost:27017', responseTimeMs: Date.now() - start };
 *       } catch (err) {
 *         return { healthy: false, url: 'mongodb://localhost:27017', responseTimeMs: null, error: String(err) };
 *       }
 *     },
 *   },
 * });
 * // health.services.mongodb?.healthy === true
 * ```
 */
export async function checkNetworkHealth(
  network: NetworkType = 'testnet',
  options?: CheckNetworkHealthOptions,
): Promise<NetworkHealthResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const servicesToCheck = options?.services ?? (['relay', 'oracle'] as ServiceName[]);
  const networkConfig = NETWORKS[network];
  const customUrls = options?.urls;

  const startTime = Date.now();

  const allChecks: Promise<[string, ServiceHealthResult]>[] = [];

  // Built-in service checks
  if (servicesToCheck.includes('relay')) {
    const relayUrl = customUrls?.relay ?? networkConfig.nostrRelays[0] as string;
    allChecks.push(checkWebSocket(relayUrl, timeoutMs).then((r) => ['relay', r]));
  }

  if (servicesToCheck.includes('oracle')) {
    const oracleUrl = customUrls?.oracle ?? networkConfig.aggregatorUrl;
    allChecks.push(checkOracle(oracleUrl, timeoutMs).then((r) => ['oracle', r]));
  }

  // Custom checks — run in parallel with built-in ones
  if (options?.checks) {
    for (const [name, checkFn] of Object.entries(options.checks)) {
      allChecks.push(
        runCustomCheck(name, checkFn, timeoutMs).then((r) => [name, r]),
      );
    }
  }

  const results = await Promise.allSettled(allChecks);

  const services: NetworkHealthResult['services'] = {};
  let allHealthy = true;

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const [name, healthResult] = result.value;
      services[name] = healthResult;
      if (!healthResult.healthy) allHealthy = false;
    } else {
      // Promise.allSettled should never reject, but handle gracefully
      allHealthy = false;
    }
  }

  return {
    healthy: allHealthy,
    services,
    totalTimeMs: Date.now() - startTime,
  };
}

/**
 * Check a WebSocket endpoint by opening a connection and waiting for the open event.
 */
async function checkWebSocket(url: string, timeoutMs: number): Promise<ServiceHealthResult> {
  const startTime = Date.now();

  // Check if WebSocket is available in the environment
  const WS = typeof globalThis !== 'undefined' && (globalThis as Record<string, unknown>).WebSocket as
    | (new (url: string) => WebSocket)
    | undefined;

  if (!WS) {
    return {
      healthy: false,
      url,
      responseTimeMs: null,
      error: 'WebSocket not available in this environment',
    };
  }

  return new Promise<ServiceHealthResult>((resolve) => {
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { ws.close(); } catch { /* ignore */ }
        resolve({
          healthy: false,
          url,
          responseTimeMs: null,
          error: `Connection timeout after ${timeoutMs}ms`,
        });
      }
    }, timeoutMs);

    let ws: WebSocket;
    try {
      ws = new WS(url);
    } catch (err) {
      clearTimeout(timer);
      return resolve({
        healthy: false,
        url,
        responseTimeMs: null,
        error: `Failed to create WebSocket: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    ws.onopen = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        const responseTimeMs = Date.now() - startTime;
        try { ws.close(); } catch { /* ignore */ }
        resolve({ healthy: true, url, responseTimeMs });
      }
    };

    ws.onerror = (_event) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        try { ws.close(); } catch { /* ignore */ }
        resolve({
          healthy: false,
          url,
          responseTimeMs: null,
          error: 'WebSocket connection error',
        });
      }
    };

    ws.onclose = (event) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({
          healthy: false,
          url,
          responseTimeMs: null,
          error: `WebSocket closed: ${event.reason || `code ${event.code}`}`,
        });
      }
    };
  });
}

/**
 * The gateway is a routing layer: every JSON-RPC call must carry a `stateId` or a
 * `shardId` or it is refused with HTTP 400 before the method is even looked at.
 * An all-zero state id routes like any other and reads as what it is — a probe.
 */
const HEALTH_PROBE_STATE_ID = '00'.repeat(32);

/**
 * Pull the block number out of a JSON-RPC body.
 *
 * The HTTP status alone cannot answer this. A healthy gateway answers a routing
 * mistake with HTTP 400 *and* a JSON body, and JSON-RPC puts application errors in
 * a 200 response — so both directions of "trust the status code" are wrong. Only
 * a numeric `result.blockNumber` proves the aggregator answered.
 */
function readBlockNumber(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const result = (body as { result?: unknown }).result;
  if (typeof result !== 'object' || result === null) return null;
  const n = (result as { blockNumber?: unknown }).blockNumber;
  return typeof n === 'string' || typeof n === 'number' ? String(n) : null;
}

/** The `error` member of a JSON-RPC body, or the gateway's bare `{"error": "..."}`. */
function readRpcError(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const err = (body as { error?: unknown }).error;
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string') return message;
    return JSON.stringify(err);
  }
  return null;
}

/**
 * Check oracle (aggregator) endpoint via HTTP POST.
 */
async function checkOracle(url: string, timeoutMs: number): Promise<ServiceHealthResult> {
  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'get_block_height',
        params: { stateId: HEALTH_PROBE_STATE_ID },
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);
    const responseTimeMs = Date.now() - startTime;

    const body: unknown = await response.json().catch(() => null);
    if (readBlockNumber(body) !== null) {
      return { healthy: true, url, responseTimeMs };
    }

    const rpcError = readRpcError(body);
    return {
      healthy: false,
      url,
      responseTimeMs,
      error:
        rpcError ??
        (response.ok
          ? 'aggregator answered without a block height'
          : `HTTP ${String(response.status)} ${response.statusText}`),
    };
  } catch (err) {
    return {
      healthy: false,
      url,
      responseTimeMs: null,
      error: err instanceof Error
        ? (err.name === 'AbortError' ? `Connection timeout after ${timeoutMs}ms` : err.message)
        : String(err),
    };
  }
}

/**
 * Run a user-provided custom health check with timeout protection.
 */
async function runCustomCheck(
  name: string,
  checkFn: HealthCheckFn,
  timeoutMs: number,
): Promise<ServiceHealthResult> {
  try {
    const result = await Promise.race([
      checkFn(timeoutMs),
      new Promise<ServiceHealthResult>((resolve) =>
        setTimeout(
          () => resolve({
            healthy: false,
            url: name,
            responseTimeMs: null,
            error: `Custom check '${name}' timeout after ${timeoutMs}ms`,
          }),
          timeoutMs,
        ),
      ),
    ]);
    return result;
  } catch (err) {
    return {
      healthy: false,
      url: name,
      responseTimeMs: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
