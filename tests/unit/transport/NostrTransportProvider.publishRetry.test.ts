/**
 * Tests for NostrTransportProvider publishEvent retry logic
 *
 * The publishEvent method retries up to 3 total attempts (1 initial + 2 retries)
 * with 500ms delays between attempts when relay rejection errors occur.
 * Only relay-level rejections ("Event rejected: ..." or "sent 0 of ...") are retried;
 * other errors (disconnected, no relays) fail immediately.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { WebSocketFactory } from '../../../transport/websocket';

// =============================================================================
// Mock Setup
// =============================================================================

const mockSubscribe = vi.fn().mockReturnValue('mock-sub-id');
const mockUnsubscribe = vi.fn();
const mockPublishEvent = vi.fn().mockResolvedValue('mock-event-id');
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn();
const mockIsConnected = vi.fn().mockReturnValue(true);
const mockGetConnectedRelays = vi.fn().mockReturnValue(new Set(['wss://relay1.test']));
const mockAddConnectionListener = vi.fn();

vi.mock('@unicitylabs/nostr-js-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@unicitylabs/nostr-js-sdk')>();
  return {
    ...actual,
    NostrClient: vi.fn().mockImplementation(() => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
      isConnected: mockIsConnected,
      getConnectedRelays: mockGetConnectedRelays,
      subscribe: mockSubscribe,
      unsubscribe: mockUnsubscribe,
      publishEvent: mockPublishEvent,
      addConnectionListener: mockAddConnectionListener,
    })),
  };
});

// Import provider after mock is set up
const { NostrTransportProvider } = await import('../../../transport/NostrTransportProvider');

// =============================================================================
// Test Helpers
// =============================================================================

function createProvider(relays: string[] = ['wss://relay1.test']) {
  return new NostrTransportProvider({
    relays,
    createWebSocket: (() => {}) as unknown as WebSocketFactory,
    timeout: 100,
    autoReconnect: false,
  });
}

function createMockNostrEvent() {
  return {
    id: 'test-event-id',
    kind: 4,
    content: 'test content',
    tags: [],
    pubkey: 'a'.repeat(64),
    created_at: Math.floor(Date.now() / 1000),
    sig: 'sig' + 'a'.repeat(128),
  };
}

/**
 * Run publishEvent with fake timers, advancing through retry delays.
 * Immediately attaches a catch handler to prevent unhandled rejection warnings.
 * Returns the settled result.
 */
async function publishWithRetries(
  provider: InstanceType<typeof NostrTransportProvider>,
  event: ReturnType<typeof createMockNostrEvent>,
  expectedRetries: number,
): Promise<{ error?: any }> {
  let caughtError: any;
  const promise = (provider as any).publishEvent(event).catch((err: any) => {
    caughtError = err;
  });

  for (let i = 0; i < expectedRetries; i++) {
    await vi.advanceTimersByTimeAsync(500);
  }
  await promise;

  return { error: caughtError };
}

// =============================================================================
// Tests
// =============================================================================

describe('publishEvent retry logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockPublishEvent.mockResolvedValue('mock-event-id');
    mockIsConnected.mockReturnValue(true);
    mockGetConnectedRelays.mockReturnValue(new Set(['wss://relay1.test']));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('success cases', () => {
    it('should succeed on first attempt without retrying', async () => {
      const provider = createProvider();
      await provider.connect();

      const { error } = await publishWithRetries(provider, createMockNostrEvent(), 0);

      expect(error).toBeUndefined();
      expect(mockPublishEvent).toHaveBeenCalledTimes(1);
    });

    it('should retry once and succeed on second attempt', async () => {
      const provider = createProvider();
      await provider.connect();

      mockPublishEvent
        .mockRejectedValueOnce(new Error('Event rejected: sent 0 of 1 report'))
        .mockResolvedValueOnce('mock-event-id');

      const { error } = await publishWithRetries(provider, createMockNostrEvent(), 1);

      expect(error).toBeUndefined();
      expect(mockPublishEvent).toHaveBeenCalledTimes(2);
    });

    it('should retry twice and succeed on third attempt', async () => {
      const provider = createProvider();
      await provider.connect();

      mockPublishEvent
        .mockRejectedValueOnce(new Error('Event rejected: sent 0 of 1 report'))
        .mockRejectedValueOnce(new Error('Event rejected: relay busy'))
        .mockResolvedValueOnce('mock-event-id');

      const { error } = await publishWithRetries(provider, createMockNostrEvent(), 2);

      expect(error).toBeUndefined();
      expect(mockPublishEvent).toHaveBeenCalledTimes(3);
    });
  });

  describe('failure cases', () => {
    it('should throw TRANSPORT_ERROR after exhausting 3 attempts', async () => {
      const provider = createProvider();
      await provider.connect();

      mockPublishEvent.mockRejectedValue(new Error('Event rejected: sent 0 of 1 report'));

      const { error } = await publishWithRetries(provider, createMockNostrEvent(), 2);

      expect(error).toBeDefined();
      expect(error.code).toBe('TRANSPORT_ERROR');
      expect(mockPublishEvent).toHaveBeenCalledTimes(3);
    });

    it('should include original relay error reason in SphereError message', async () => {
      const provider = createProvider();
      await provider.connect();

      mockPublishEvent.mockRejectedValue(new Error('Event rejected: sent 0 of 1 report'));

      const { error } = await publishWithRetries(provider, createMockNostrEvent(), 2);

      expect(error).toBeDefined();
      expect(error.code).toBe('TRANSPORT_ERROR');
      expect(error.message).toContain('sent 0 of 1 report');
      expect(mockPublishEvent).toHaveBeenCalledTimes(3);
    });
  });

  describe('relay rejection pattern matching', () => {
    it('should retry on "Event rejected:" errors', async () => {
      const provider = createProvider();
      await provider.connect();

      mockPublishEvent
        .mockRejectedValueOnce(new Error('Event rejected: sent 0 of 1 report'))
        .mockResolvedValueOnce('mock-event-id');

      const { error } = await publishWithRetries(provider, createMockNostrEvent(), 1);

      expect(error).toBeUndefined();
      expect(mockPublishEvent).toHaveBeenCalledTimes(2);
    });

    it('should retry on "sent 0 of" errors', async () => {
      const provider = createProvider();
      await provider.connect();

      mockPublishEvent
        .mockRejectedValueOnce(new Error('sent 0 of 3 relays'))
        .mockResolvedValueOnce('mock-event-id');

      const { error } = await publishWithRetries(provider, createMockNostrEvent(), 1);

      expect(error).toBeUndefined();
      expect(mockPublishEvent).toHaveBeenCalledTimes(2);
    });

    it('should retry with mixed relay rejection messages', async () => {
      const provider = createProvider();
      await provider.connect();

      mockPublishEvent
        .mockRejectedValueOnce(new Error('Event rejected: sent 0 of 1'))
        .mockRejectedValueOnce(new Error('sent 0 of 3 relays'))
        .mockRejectedValueOnce(new Error('Event rejected: blocked'));

      const { error } = await publishWithRetries(provider, createMockNostrEvent(), 2);

      expect(error).toBeDefined();
      expect(error.code).toBe('TRANSPORT_ERROR');
      expect(mockPublishEvent).toHaveBeenCalledTimes(3);
    });
  });

  describe('non-retryable errors fail immediately', () => {
    it('should not retry "No connected relays" errors', async () => {
      const provider = createProvider();
      await provider.connect();

      mockPublishEvent.mockRejectedValue(new Error('No connected relays'));

      const { error } = await publishWithRetries(provider, createMockNostrEvent(), 0);

      expect(error).toBeDefined();
      expect(error.code).toBe('TRANSPORT_ERROR');
      expect(error.message).toContain('No connected relays');
      // Should only try once — not a relay rejection
      expect(mockPublishEvent).toHaveBeenCalledTimes(1);
    });

    it('should not retry "Client has been disconnected" errors', async () => {
      const provider = createProvider();
      await provider.connect();

      mockPublishEvent.mockRejectedValue(new Error('Client has been disconnected'));

      const { error } = await publishWithRetries(provider, createMockNostrEvent(), 0);

      expect(error).toBeDefined();
      expect(error.code).toBe('TRANSPORT_ERROR');
      expect(mockPublishEvent).toHaveBeenCalledTimes(1);
    });
  });

  describe('max attempts boundary', () => {
    it('should succeed on the last possible attempt (3rd attempt)', async () => {
      const provider = createProvider();
      await provider.connect();

      mockPublishEvent
        .mockRejectedValueOnce(new Error('Event rejected: relay issue'))
        .mockRejectedValueOnce(new Error('Event rejected: relay issue'))
        .mockResolvedValueOnce('mock-event-id');

      const { error } = await publishWithRetries(provider, createMockNostrEvent(), 2);

      expect(error).toBeUndefined();
      expect(mockPublishEvent).toHaveBeenCalledTimes(3);
    });

    it('should fail after 3 attempts even if 4th would succeed', async () => {
      const provider = createProvider();
      await provider.connect();

      mockPublishEvent
        .mockRejectedValueOnce(new Error('Event rejected: a'))
        .mockRejectedValueOnce(new Error('Event rejected: b'))
        .mockRejectedValueOnce(new Error('Event rejected: c'))
        .mockResolvedValueOnce('mock-event-id'); // Should NOT be reached

      const { error } = await publishWithRetries(provider, createMockNostrEvent(), 2);

      expect(error).toBeDefined();
      expect(error.code).toBe('TRANSPORT_ERROR');
      expect(mockPublishEvent).toHaveBeenCalledTimes(3);
    });
  });

  describe('initialization checks', () => {
    it('should fail immediately with NOT_INITIALIZED if NostrClient not set up', async () => {
      const provider = createProvider();
      // Don't connect — leave NostrClient undefined

      const { error } = await publishWithRetries(provider, createMockNostrEvent(), 0);

      expect(error).toBeDefined();
      expect(error.code).toBe('NOT_INITIALIZED');
      expect(mockPublishEvent).not.toHaveBeenCalled();
    });
  });
});
