import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import { WebSocket as WsWebSocket } from 'ws';
import { checkNetworkHealth } from '../../../core/network-health';

describe('checkNetworkHealth', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;

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
        onerror: ((event: unknown) => void) | null = null;
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

  describe('edge cases', () => {
    it('should return healthy with no checks when services array is empty', async () => {
      const result = await checkNetworkHealth('testnet', { services: [] });

      expect(result.healthy).toBe(true);
      expect(result.services.relay).toBeUndefined();
      expect(result.services.oracle).toBeUndefined();
      expect(result.services.l1).toBeUndefined();
      expect(result.totalTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should use dev network URLs', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 }),
      );

      const result = await checkNetworkHealth('dev', { services: ['oracle'] });

      expect(result.services.oracle).toBeDefined();
      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      // Dev uses dev-aggregator URL
      expect(calledUrl).toContain('dev-aggregator');
    });

    it('should include responseTimeMs for non-ok HTTP responses', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('Bad Request', { status: 400, statusText: 'Bad Request' }),
      );

      const result = await checkNetworkHealth('testnet', { services: ['oracle'] });

      expect(result.services.oracle!.healthy).toBe(false);
      expect(result.services.oracle!.responseTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.services.oracle!.error).toContain('400');
    });

    it('should handle non-Error thrown in fetch', async () => {
      fetchSpy.mockRejectedValueOnce('string error');

      const result = await checkNetworkHealth('testnet', { services: ['oracle'] });

      expect(result.services.oracle!.healthy).toBe(false);
      expect(result.services.oracle!.error).toBe('string error');
    });

    it('should use custom oracle URL from urls option', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 }),
      );

      const result = await checkNetworkHealth('testnet', {
        services: ['oracle'],
        urls: { oracle: 'https://my-custom-aggregator.example.com' },
      });

      expect(result.services.oracle!.healthy).toBe(true);
      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toBe('https://my-custom-aggregator.example.com');
    });

    it('should use custom relay URL from urls option', async () => {
      (globalThis as Record<string, unknown>).WebSocket = class MockWebSocket {
        url: string;
        onopen: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onclose: (() => void) | null = null;
        constructor(url: string) {
          this.url = url;
          setTimeout(() => this.onopen?.(), 1);
        }
        close() {}
      };

      const result = await checkNetworkHealth('testnet', {
        services: ['relay'],
        urls: { relay: 'wss://my-custom-relay.example.com' },
      });

      expect(result.services.relay!.healthy).toBe(true);
      expect(result.services.relay!.url).toBe('wss://my-custom-relay.example.com');
    });

    it('should use custom l1 URL from urls option', async () => {
      (globalThis as Record<string, unknown>).WebSocket = class MockWebSocket {
        url: string;
        onopen: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onclose: (() => void) | null = null;
        constructor(url: string) {
          this.url = url;
          setTimeout(() => this.onopen?.(), 1);
        }
        close() {}
      };

      const result = await checkNetworkHealth('testnet', {
        services: ['l1'],
        urls: { l1: 'wss://my-custom-fulcrum.example.com:50004' },
      });

      expect(result.services.l1!.healthy).toBe(true);
      expect(result.services.l1!.url).toBe('wss://my-custom-fulcrum.example.com:50004');
    });

    it('should mix custom and default URLs', async () => {
      // Custom oracle, default relay
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

      const result = await checkNetworkHealth('testnet', {
        services: ['relay', 'oracle'],
        urls: { oracle: 'https://custom-oracle.example.com' },
      });

      // Oracle uses custom URL
      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toBe('https://custom-oracle.example.com');

      // Relay uses default testnet URL
      expect(result.services.relay!.url).toContain('nostr-relay.testnet.unicity.network');
    });

    it('should show close code when reason is empty', async () => {
      (globalThis as Record<string, unknown>).WebSocket = class MockWebSocket {
        onopen: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onclose: ((event: { code: number; reason: string }) => void) | null = null;
        constructor() {
          setTimeout(() => this.onclose?.({ code: 1006, reason: '' }), 1);
        }
        close() {}
      };

      const originalWS = (globalThis as Record<string, unknown>).WebSocket;
      const result = await checkNetworkHealth('testnet', { services: ['relay'] });
      (globalThis as Record<string, unknown>).WebSocket = originalWS;

      expect(result.services.relay!.healthy).toBe(false);
      expect(result.services.relay!.error).toContain('code 1006');
    });
  });

  describe('custom checks', () => {
    it('should run custom check function and include result', async () => {
      const result = await checkNetworkHealth('testnet', {
        services: [],  // skip built-in checks
        checks: {
          mongodb: async (_timeoutMs) => ({
            healthy: true,
            url: 'mongodb://localhost:27017',
            responseTimeMs: 5,
          }),
        },
      });

      expect(result.services.mongodb).toBeDefined();
      expect(result.services.mongodb!.healthy).toBe(true);
      expect(result.services.mongodb!.url).toBe('mongodb://localhost:27017');
      expect(result.services.mongodb!.responseTimeMs).toBe(5);
      expect(result.healthy).toBe(true);
    });

    it('should report unhealthy when custom check fails', async () => {
      const result = await checkNetworkHealth('testnet', {
        services: [],
        checks: {
          redis: async () => ({
            healthy: false,
            url: 'redis://localhost:6379',
            responseTimeMs: null,
            error: 'ECONNREFUSED',
          }),
        },
      });

      expect(result.services.redis!.healthy).toBe(false);
      expect(result.services.redis!.error).toBe('ECONNREFUSED');
      expect(result.healthy).toBe(false);
    });

    it('should catch exceptions thrown by custom check', async () => {
      const result = await checkNetworkHealth('testnet', {
        services: [],
        checks: {
          broken: async () => {
            throw new Error('connection pool exhausted');
          },
        },
      });

      expect(result.services.broken!.healthy).toBe(false);
      expect(result.services.broken!.error).toBe('connection pool exhausted');
    });

    it('should timeout custom check that hangs', async () => {
      const result = await checkNetworkHealth('testnet', {
        services: [],
        timeoutMs: 50,
        checks: {
          slow: async () => {
            await new Promise((r) => setTimeout(r, 5000));
            return { healthy: true, url: 'slow://service', responseTimeMs: 5000 };
          },
        },
      });

      expect(result.services.slow!.healthy).toBe(false);
      expect(result.services.slow!.error).toContain('timeout');
    });

    it('should run custom checks in parallel with built-in', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 }),
      );

      const result = await checkNetworkHealth('testnet', {
        services: ['oracle'],
        checks: {
          ipfs: async () => ({
            healthy: true,
            url: 'https://ipfs.example.com',
            responseTimeMs: 10,
          }),
        },
      });

      // Both built-in and custom present
      expect(result.services.oracle).toBeDefined();
      expect(result.services.oracle!.healthy).toBe(true);
      expect(result.services.ipfs).toBeDefined();
      expect(result.services.ipfs!.healthy).toBe(true);
      expect(result.healthy).toBe(true);
    });

    it('should handle multiple custom checks', async () => {
      const result = await checkNetworkHealth('testnet', {
        services: [],
        checks: {
          mongodb: async () => ({
            healthy: true,
            url: 'mongodb://localhost:27017',
            responseTimeMs: 3,
          }),
          redis: async () => ({
            healthy: true,
            url: 'redis://localhost:6379',
            responseTimeMs: 1,
          }),
          ipfs: async () => ({
            healthy: false,
            url: 'https://ipfs.example.com',
            responseTimeMs: null,
            error: 'gateway down',
          }),
        },
      });

      expect(result.services.mongodb!.healthy).toBe(true);
      expect(result.services.redis!.healthy).toBe(true);
      expect(result.services.ipfs!.healthy).toBe(false);
      expect(result.healthy).toBe(false); // one is down
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

// =============================================================================
// Real WebSocket tests — uses `ws` package with a local server
// =============================================================================

describe('checkNetworkHealth with real WebSocket', () => {
  let originalWS: unknown;

  beforeEach(() => {
    originalWS = (globalThis as Record<string, unknown>).WebSocket;
    // Provide a real WebSocket implementation from ws package
    (globalThis as Record<string, unknown>).WebSocket = WsWebSocket;
  });

  afterEach(() => {
    if (originalWS !== undefined) {
      (globalThis as Record<string, unknown>).WebSocket = originalWS;
    } else {
      delete (globalThis as Record<string, unknown>).WebSocket;
    }
    vi.restoreAllMocks();
  });

  it('should report healthy when local WebSocket server accepts connection', async () => {
    const wss = new WebSocketServer({ port: 0 });
    const port = (wss.address() as { port: number }).port;

    try {
      const result = await new Promise<boolean>((resolve) => {
        const ws = new WsWebSocket(`ws://127.0.0.1:${port}`);
        ws.onopen = () => { ws.close(); resolve(true); };
        ws.onerror = () => { resolve(false); };
      });
      expect(result).toBe(true);
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  it('should report unhealthy when connection is refused', async () => {
    // Use a port that's definitely not listening
    const result = await new Promise<{ connected: boolean; error?: string }>((resolve) => {
      const ws = new WsWebSocket('ws://127.0.0.1:1');
      ws.onopen = () => { ws.close(); resolve({ connected: true }); };
      ws.onerror = () => { resolve({ connected: false, error: 'connection error' }); };
    });

    expect(result.connected).toBe(false);
  });

  it('should handle server that immediately closes connection', async () => {
    const wss = new WebSocketServer({ port: 0 });
    const port = (wss.address() as { port: number }).port;

    // Server immediately closes every connection
    wss.on('connection', (ws) => {
      ws.close(1000, 'Go away');
    });

    try {
      const result = await new Promise<{ opened: boolean; closed: boolean; code?: number }>((resolve) => {
        let opened = false;
        const ws = new WsWebSocket(`ws://127.0.0.1:${port}`);
        ws.onopen = () => { opened = true; };
        ws.onclose = (event) => {
          resolve({ opened, closed: true, code: (event as unknown as { code: number }).code });
        };
        ws.onerror = () => {
          resolve({ opened, closed: true });
        };
      });

      // Connection was established then closed by server
      expect(result.closed).toBe(true);
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  it('should timeout on a server that hangs without accepting', async () => {
    // Create a raw TCP server that accepts connections but never sends WS handshake
    const net = await import('net');
    const server = net.createServer((_socket) => {
      // intentionally do nothing — no WS upgrade
    });

    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    const port = (server.address() as { port: number }).port;

    try {
      const start = Date.now();
      const timeoutMs = 200;
      const result = await new Promise<{ connected: boolean; timedOut: boolean }>((resolve) => {
        const ws = new WsWebSocket(`ws://127.0.0.1:${port}`, { handshakeTimeout: timeoutMs });

        const timeout = setTimeout(() => {
          try { ws.terminate(); } catch { /* ignore */ }
          resolve({ connected: false, timedOut: true });
        }, timeoutMs);
        ws.onopen = () => {
          clearTimeout(timeout);
          ws.close();
          resolve({ connected: true, timedOut: false });
        };
        ws.onerror = () => {
          clearTimeout(timeout);
          resolve({ connected: false, timedOut: false });
        };
      });

      const elapsed = Date.now() - start;
      // Should have timed out (not connected instantly)
      expect(result.connected).toBe(false);
      expect(elapsed).toBeGreaterThanOrEqual(100);
    } finally {
      server.close();
    }
  }, 5000);
});
