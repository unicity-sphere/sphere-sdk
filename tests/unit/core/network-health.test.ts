import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkNetworkHealth } from '../../../core/network-health';

describe('checkNetworkHealth', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('oracle check', () => {
    it('should report oracle healthy on HTTP 200', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ jsonrpc: '2.0', result: 42 }), { status: 200 }),
      );

      const result = await checkNetworkHealth('testnet', { services: ['oracle'] });

      expect(result.services.oracle).toBeDefined();
      expect(result.services.oracle!.healthy).toBe(true);
      expect(result.services.oracle!.responseTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.healthy).toBe(true);
    });

    it('should report oracle unhealthy on HTTP error', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('Server Error', { status: 500, statusText: 'Internal Server Error' }),
      );

      const result = await checkNetworkHealth('testnet', { services: ['oracle'] });

      expect(result.services.oracle!.healthy).toBe(false);
      expect(result.services.oracle!.error).toContain('500');
      expect(result.healthy).toBe(false);
    });

    it('should report oracle unhealthy on fetch error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await checkNetworkHealth('testnet', { services: ['oracle'] });

      expect(result.services.oracle!.healthy).toBe(false);
      expect(result.services.oracle!.error).toContain('ECONNREFUSED');
    });

    it('should report oracle unhealthy on abort/timeout', async () => {
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      Object.defineProperty(abortError, 'name', { value: 'AbortError' });
      fetchSpy.mockRejectedValueOnce(abortError);

      const result = await checkNetworkHealth('testnet', { services: ['oracle'], timeoutMs: 100 });

      expect(result.services.oracle!.healthy).toBe(false);
      expect(result.services.oracle!.error).toContain('timeout');
    });
  });

  describe('service filtering', () => {
    it('should only check specified services', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ jsonrpc: '2.0', result: 1 }), { status: 200 }),
      );

      const result = await checkNetworkHealth('testnet', { services: ['oracle'] });

      expect(result.services.oracle).toBeDefined();
      expect(result.services.relay).toBeUndefined();
      expect(result.services.l1).toBeUndefined();
    });
  });

  describe('result shape', () => {
    it('should include totalTimeMs', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 }),
      );

      const result = await checkNetworkHealth('testnet', { services: ['oracle'] });

      expect(result.totalTimeMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.totalTimeMs).toBe('number');
    });

    it('should include url in service results', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 }),
      );

      const result = await checkNetworkHealth('testnet', { services: ['oracle'] });

      expect(result.services.oracle!.url).toBeTruthy();
      expect(typeof result.services.oracle!.url).toBe('string');
    });
  });

  describe('network selection', () => {
    it('should use testnet URLs by default', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 }),
      );

      await checkNetworkHealth('testnet', { services: ['oracle'] });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      // Testnet aggregator is goggregator-test.unicity.network
      expect(calledUrl).toContain('goggregator-test');
    });

    it('should use mainnet URLs when specified', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 }),
      );

      await checkNetworkHealth('mainnet', { services: ['oracle'] });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain('aggregator.unicity.network');
    });
  });

  describe('WebSocket checks (relay, l1)', () => {
    it('should report relay unhealthy when WebSocket not available', async () => {
      // In Node.js test env without WebSocket polyfill, globalThis.WebSocket is undefined
      const originalWS = (globalThis as Record<string, unknown>).WebSocket;
      (globalThis as Record<string, unknown>).WebSocket = undefined;

      try {
        const result = await checkNetworkHealth('testnet', { services: ['relay'] });

        expect(result.services.relay).toBeDefined();
        expect(result.services.relay!.healthy).toBe(false);
        expect(result.services.relay!.error).toContain('WebSocket not available');
      } finally {
        if (originalWS !== undefined) {
          (globalThis as Record<string, unknown>).WebSocket = originalWS;
        }
      }
    });

    it('should report l1 unhealthy when WebSocket not available', async () => {
      const originalWS = (globalThis as Record<string, unknown>).WebSocket;
      (globalThis as Record<string, unknown>).WebSocket = undefined;

      try {
        const result = await checkNetworkHealth('testnet', { services: ['l1'] });

        expect(result.services.l1).toBeDefined();
        expect(result.services.l1!.healthy).toBe(false);
        expect(result.services.l1!.error).toContain('WebSocket not available');
      } finally {
        if (originalWS !== undefined) {
          (globalThis as Record<string, unknown>).WebSocket = originalWS;
        }
      }
    });
  });
});
