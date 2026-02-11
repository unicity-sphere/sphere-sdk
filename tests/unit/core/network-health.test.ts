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
    let originalWS: unknown;

    beforeEach(() => {
      originalWS = (globalThis as Record<string, unknown>).WebSocket;
    });

    afterEach(() => {
      if (originalWS !== undefined) {
        (globalThis as Record<string, unknown>).WebSocket = originalWS;
      } else {
        delete (globalThis as Record<string, unknown>).WebSocket;
      }
    });

    it('should report relay unhealthy when WebSocket not available', async () => {
      (globalThis as Record<string, unknown>).WebSocket = undefined;

      const result = await checkNetworkHealth('testnet', { services: ['relay'] });

      expect(result.services.relay).toBeDefined();
      expect(result.services.relay!.healthy).toBe(false);
      expect(result.services.relay!.error).toContain('WebSocket not available');
    });

    it('should report l1 unhealthy when WebSocket not available', async () => {
      (globalThis as Record<string, unknown>).WebSocket = undefined;

      const result = await checkNetworkHealth('testnet', { services: ['l1'] });

      expect(result.services.l1).toBeDefined();
      expect(result.services.l1!.healthy).toBe(false);
      expect(result.services.l1!.error).toContain('WebSocket not available');
    });

    it('should report relay healthy when WebSocket connects successfully', async () => {
      // Mock WebSocket that fires onopen immediately
      (globalThis as Record<string, unknown>).WebSocket = class MockWebSocket {
        onopen: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onclose: (() => void) | null = null;
        constructor() {
          setTimeout(() => this.onopen?.(), 1);
        }
        close() {}
      };

      const result = await checkNetworkHealth('testnet', { services: ['relay'] });

      expect(result.services.relay!.healthy).toBe(true);
      expect(result.services.relay!.responseTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.services.relay!.url).toContain('wss://');
    });

    it('should report l1 healthy when WebSocket connects successfully', async () => {
      (globalThis as Record<string, unknown>).WebSocket = class MockWebSocket {
        onopen: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onclose: (() => void) | null = null;
        constructor() {
          setTimeout(() => this.onopen?.(), 1);
        }
        close() {}
      };

      const result = await checkNetworkHealth('testnet', { services: ['l1'] });

      expect(result.services.l1!.healthy).toBe(true);
      expect(result.services.l1!.responseTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should report relay unhealthy when WebSocket errors', async () => {
      (globalThis as Record<string, unknown>).WebSocket = class MockWebSocket {
        onopen: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onclose: (() => void) | null = null;
        constructor() {
          setTimeout(() => this.onerror?.({}), 1);
        }
        close() {}
      };

      const result = await checkNetworkHealth('testnet', { services: ['relay'] });

      expect(result.services.relay!.healthy).toBe(false);
      expect(result.services.relay!.error).toContain('connection error');
    });

    it('should report relay unhealthy when WebSocket closes before open', async () => {
      (globalThis as Record<string, unknown>).WebSocket = class MockWebSocket {
        onopen: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onclose: ((event: { code: number; reason: string }) => void) | null = null;
        constructor() {
          setTimeout(() => this.onclose?.({ code: 1006, reason: 'Connection refused' }), 1);
        }
        close() {}
      };

      const result = await checkNetworkHealth('testnet', { services: ['relay'] });

      expect(result.services.relay!.healthy).toBe(false);
      expect(result.services.relay!.error).toContain('closed');
    });

    it('should report relay unhealthy on connection timeout', async () => {
      // WebSocket that never fires any event — will timeout
      (globalThis as Record<string, unknown>).WebSocket = class MockWebSocket {
        onopen: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onclose: (() => void) | null = null;
        close() {}
      };

      const result = await checkNetworkHealth('testnet', {
        services: ['relay'],
        timeoutMs: 50,
      });

      expect(result.services.relay!.healthy).toBe(false);
      expect(result.services.relay!.error).toContain('timeout');
    });

    it('should report unhealthy when WebSocket constructor throws', async () => {
      (globalThis as Record<string, unknown>).WebSocket = class MockWebSocket {
        constructor() {
          throw new Error('Invalid URL');
        }
      };

      const result = await checkNetworkHealth('testnet', { services: ['relay'] });

      expect(result.services.relay!.healthy).toBe(false);
      expect(result.services.relay!.error).toContain('Invalid URL');
    });
  });

  describe('parallel checks', () => {
    it('should check all services in parallel', async () => {
      // Mock WebSocket for relay + l1
      (globalThis as Record<string, unknown>).WebSocket = class MockWebSocket {
        onopen: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onclose: (() => void) | null = null;
        constructor() {
          setTimeout(() => this.onopen?.(), 1);
        }
        close() {}
      };

      // Mock fetch for oracle
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ jsonrpc: '2.0', result: 1 }), { status: 200 }),
      );

      const result = await checkNetworkHealth('testnet', {
        services: ['relay', 'oracle', 'l1'],
      });

      expect(result.services.relay).toBeDefined();
      expect(result.services.oracle).toBeDefined();
      expect(result.services.l1).toBeDefined();
      expect(result.services.relay!.healthy).toBe(true);
      expect(result.services.oracle!.healthy).toBe(true);
      expect(result.services.l1!.healthy).toBe(true);
      expect(result.healthy).toBe(true);
    });

    it('should report unhealthy if any service is down', async () => {
      // Relay succeeds, oracle fails
      (globalThis as Record<string, unknown>).WebSocket = class MockWebSocket {
        onopen: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onclose: (() => void) | null = null;
        constructor() {
          setTimeout(() => this.onopen?.(), 1);
        }
        close() {}
      };

      fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await checkNetworkHealth('testnet', {
        services: ['relay', 'oracle'],
      });

      expect(result.services.relay!.healthy).toBe(true);
      expect(result.services.oracle!.healthy).toBe(false);
      expect(result.healthy).toBe(false); // overall unhealthy
    });
  });

  describe('default behavior', () => {
    it('should check all three services when no filter specified', async () => {
      // WebSocket for relay + l1
      (globalThis as Record<string, unknown>).WebSocket = class MockWebSocket {
        onopen: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onclose: (() => void) | null = null;
        constructor() {
          setTimeout(() => this.onopen?.(), 1);
        }
        close() {}
      };

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 }),
      );

      const result = await checkNetworkHealth('testnet');

      // All three services should be checked
      expect(result.services.relay).toBeDefined();
      expect(result.services.oracle).toBeDefined();
      expect(result.services.l1).toBeDefined();
    });
  });
});
