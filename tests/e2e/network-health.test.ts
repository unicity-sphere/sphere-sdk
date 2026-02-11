/**
 * E2E Test: Live Network Health Checks
 *
 * Runs `checkNetworkHealth()` against real testnet services.
 * Requires network connectivity — will be skipped in offline/CI environments
 * by the e2e test runner (npm run test:e2e).
 *
 * Run with: npm run test:e2e
 */

import { describe, it, expect } from 'vitest';
import { checkNetworkHealth } from '../../core/network-health';

// Provide ws WebSocket to globalThis for Node.js environment
import { WebSocket as WsWebSocket } from 'ws';
if (!(globalThis as Record<string, unknown>).WebSocket) {
  (globalThis as Record<string, unknown>).WebSocket = WsWebSocket;
}

describe('checkNetworkHealth — live testnet', () => {
  it('should check oracle (aggregator) on testnet', async () => {
    const result = await checkNetworkHealth('testnet', {
      services: ['oracle'],
      timeoutMs: 15000,
    });

    expect(result.services.oracle).toBeDefined();
    expect(result.services.oracle!.url).toContain('goggregator-test');
    expect(typeof result.services.oracle!.healthy).toBe('boolean');

    if (result.services.oracle!.healthy) {
      expect(result.services.oracle!.responseTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.services.oracle!.responseTimeMs).toBeLessThan(15000);
    } else {
      expect(result.services.oracle!.error).toBeDefined();
    }

    expect(result.totalTimeMs).toBeGreaterThanOrEqual(0);
  }, 20000);

  it('should check relay (Nostr) on testnet', async () => {
    const result = await checkNetworkHealth('testnet', {
      services: ['relay'],
      timeoutMs: 15000,
    });

    expect(result.services.relay).toBeDefined();
    expect(result.services.relay!.url).toContain('wss://');
    expect(typeof result.services.relay!.healthy).toBe('boolean');

    if (result.services.relay!.healthy) {
      expect(result.services.relay!.responseTimeMs).toBeGreaterThanOrEqual(0);
    }
  }, 20000);

  it('should check L1 (Electrum) on testnet', async () => {
    const result = await checkNetworkHealth('testnet', {
      services: ['l1'],
      timeoutMs: 15000,
    });

    expect(result.services.l1).toBeDefined();
    expect(result.services.l1!.url).toContain('wss://');
    expect(typeof result.services.l1!.healthy).toBe('boolean');

    if (result.services.l1!.healthy) {
      expect(result.services.l1!.responseTimeMs).toBeGreaterThanOrEqual(0);
    }
  }, 20000);

  it('should check all services in parallel on testnet', async () => {
    const result = await checkNetworkHealth('testnet', {
      timeoutMs: 15000,
    });

    // All three services should be present
    expect(result.services.oracle).toBeDefined();
    expect(result.services.relay).toBeDefined();
    expect(result.services.l1).toBeDefined();

    // Overall result
    expect(typeof result.healthy).toBe('boolean');
    expect(result.totalTimeMs).toBeGreaterThanOrEqual(0);
    // Parallel checks — total time should be less than 3 × individual timeouts
    expect(result.totalTimeMs).toBeLessThan(45000);

    // Log results for debugging
    for (const [name, svc] of Object.entries(result.services)) {
      if (svc) {
        const status = svc.healthy ? `healthy (${svc.responseTimeMs}ms)` : `unhealthy: ${svc.error}`;
        console.log(`  ${name}: ${status}`);
      }
    }
  }, 30000);

  it('should timeout quickly with very low timeout', async () => {
    const result = await checkNetworkHealth('testnet', {
      services: ['oracle'],
      timeoutMs: 1, // 1ms — virtually guaranteed to timeout
    });

    expect(result.services.oracle).toBeDefined();
    // Should be unhealthy (timeout) or just barely made it (unlikely but possible)
    expect(typeof result.services.oracle!.healthy).toBe('boolean');
    if (!result.services.oracle!.healthy) {
      expect(result.services.oracle!.error).toBeDefined();
    }
  }, 10000);

  it('should check mainnet oracle', async () => {
    const result = await checkNetworkHealth('mainnet', {
      services: ['oracle'],
      timeoutMs: 15000,
    });

    expect(result.services.oracle).toBeDefined();
    expect(result.services.oracle!.url).toContain('aggregator.unicity.network');
    expect(typeof result.services.oracle!.healthy).toBe('boolean');
  }, 20000);
});
