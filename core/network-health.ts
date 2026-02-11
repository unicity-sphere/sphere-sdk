/**
 * Network Health Check
 *
 * Standalone utility for checking network service availability before Sphere.init().
 * Uses NETWORKS config for URLs — no providers or Sphere instance needed.
 */

import { NETWORKS, type NetworkType } from '../constants';
import type { NetworkHealthResult, ServiceHealthResult } from '../types';

const DEFAULT_TIMEOUT_MS = 5000;

type ServiceName = 'relay' | 'oracle' | 'l1';

export interface CheckNetworkHealthOptions {
  /** Timeout per service check in ms (default: 5000) */
  timeoutMs?: number;
  /** Which services to check (default: all) */
  services?: ServiceName[];
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
 * ```
 */
export async function checkNetworkHealth(
  network: NetworkType = 'testnet',
  options?: CheckNetworkHealthOptions,
): Promise<NetworkHealthResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const servicesToCheck = options?.services ?? (['relay', 'oracle', 'l1'] as ServiceName[]);
  const networkConfig = NETWORKS[network];

  const startTime = Date.now();

  const checks: Promise<[ServiceName, ServiceHealthResult]>[] = [];

  if (servicesToCheck.includes('relay')) {
    const relayUrl = networkConfig.nostrRelays[0] as string;
    checks.push(checkWebSocket(relayUrl, timeoutMs).then((r) => ['relay', r]));
  }

  if (servicesToCheck.includes('oracle')) {
    checks.push(checkOracle(networkConfig.aggregatorUrl, timeoutMs).then((r) => ['oracle', r]));
  }

  if (servicesToCheck.includes('l1')) {
    checks.push(checkWebSocket(networkConfig.electrumUrl, timeoutMs).then((r) => ['l1', r]));
  }

  const results = await Promise.allSettled(checks);

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

    ws.onerror = (event) => {
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
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'get_round_number', params: {} }),
      signal: controller.signal,
    });

    clearTimeout(timer);
    const responseTimeMs = Date.now() - startTime;

    if (response.ok) {
      return { healthy: true, url, responseTimeMs };
    }

    return {
      healthy: false,
      url,
      responseTimeMs,
      error: `HTTP ${response.status} ${response.statusText}`,
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
