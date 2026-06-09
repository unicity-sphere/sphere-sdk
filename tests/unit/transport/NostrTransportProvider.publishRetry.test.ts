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

// Retry delay is RETRY_BASE_DELAY_MS + random jitter up to RETRY_JITTER_MS.
// These constants must stay in sync with the constants in
// `transport/NostrTransportProvider.ts::publishEvent`:
//   RETRY_BASE_DELAY_MS = 500
//   RETRY_JITTER_MS     = 200
// The test advances by `MAX_DELAY_MS` — the strict upper bound of the actual
// delay (max jitter is `JITTER - 1` due to Math.floor). Using the upper bound
// rather than the exact max guarantees the setTimeout callback fires on every
// run, regardless of the non-deterministic Math.random() value.
const RETRY_BASE_DELAY_MS = 500;
const RETRY_JITTER_MS = 200;
const MAX_DELAY_MS = RETRY_BASE_DELAY_MS + RETRY_JITTER_MS; // 700ms

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
    await vi.advanceTimersByTimeAsync(MAX_DELAY_MS);
  }
  await promise;

  return { error: caughtError };
}

// =============================================================================
// Tests
// =============================================================================

describe('publishEvent retry logic', () => {
  beforeEach(() => {
    // mockReset (not just clearAllMocks) is required to drop any queued
    // `.mockResolvedValueOnce` / `.mockRejectedValueOnce` leftovers from
    // prior tests. Tests that queue more Once values than the code consumes
    // (e.g. "4th would succeed" tests) would otherwise bleed into subsequent tests.
    mockPublishEvent.mockReset();
    mockConnect.mockReset();
    mockIsConnected.mockReset();
    mockGetConnectedRelays.mockReset();
    vi.useFakeTimers();
    mockPublishEvent.mockResolvedValue('mock-event-id');
    mockConnect.mockResolvedValue(undefined);
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

  describe('case-insensitive relay pattern matching', () => {
    it('should retry on capitalized "Event Rejected:" variants', async () => {
      const provider = createProvider();
      await provider.connect();

      mockPublishEvent
        .mockRejectedValueOnce(new Error('Event Rejected: policy violation'))
        .mockResolvedValueOnce('mock-event-id');

      const { error } = await publishWithRetries(provider, createMockNostrEvent(), 1);

      expect(error).toBeUndefined();
      expect(mockPublishEvent).toHaveBeenCalledTimes(2);
    });

    it('should retry on capitalized "Sent 0 of" variants (strfry style)', async () => {
      const provider = createProvider();
      await provider.connect();

      mockPublishEvent
        .mockRejectedValueOnce(new Error('Sent 0 of 1 report'))
        .mockResolvedValueOnce('mock-event-id');

      const { error } = await publishWithRetries(provider, createMockNostrEvent(), 1);

      expect(error).toBeUndefined();
      expect(mockPublishEvent).toHaveBeenCalledTimes(2);
    });

    it('should retry on SHOUTED rejection messages', async () => {
      const provider = createProvider();
      await provider.connect();

      mockPublishEvent
        .mockRejectedValueOnce(new Error('EVENT REJECTED: BLOCKED'))
        .mockResolvedValueOnce('mock-event-id');

      const { error } = await publishWithRetries(provider, createMockNostrEvent(), 1);

      expect(error).toBeUndefined();
      expect(mockPublishEvent).toHaveBeenCalledTimes(2);
    });
  });

  describe('disconnect race during retry', () => {
    it('should not TypeError if nostrClient is nulled during the in-flight await', async () => {
      // Regression test for the local-snapshot pattern: if we wrote
      // `await this.nostrClient.publishEvent(...)` directly, nulling
      // `this.nostrClient` during the await would cause the next attempt
      // to throw `TypeError: Cannot read properties of null`. With the
      // local `client` snapshot, the in-flight call completes with the
      // mock's rejection and the retry loop's own null check handles the
      // disconnect gracefully on the next iteration.
      const provider = createProvider();
      await provider.connect();

      mockPublishEvent.mockRejectedValue(new Error('Event rejected: sent 0 of 1'));

      let caughtError: any;
      const runPromise = (provider as any).publishEvent(createMockNostrEvent()).catch((err: any) => {
        caughtError = err;
      });

      // Drain the first mock rejection's microtask, then immediately null
      // the client — simulating a concurrent disconnect mid-retry-window.
      await vi.advanceTimersByTimeAsync(0);
      (provider as any).nostrClient = null;
      await vi.advanceTimersByTimeAsync(MAX_DELAY_MS);
      await runPromise;

      expect(caughtError).toBeDefined();
      expect(caughtError.code).toBe('TRANSPORT_ERROR');
      expect(caughtError.message).not.toMatch(/TypeError|null/);
    });

    it('should fail fast if nostrClient becomes null between attempts', async () => {
      const provider = createProvider();
      await provider.connect();

      // First attempt rejects with a retryable error. After we catch, null out
      // the client to simulate a concurrent disconnect() call during the delay.
      mockPublishEvent.mockRejectedValueOnce(new Error('Event rejected: sent 0 of 1'));

      let caughtError: any;
      const runPromise = (provider as any).publishEvent(createMockNostrEvent()).catch((err: any) => {
        caughtError = err;
      });

      // Let the first attempt fail (microtask flush), then null out the client
      // before advancing past the retry delay.
      await vi.advanceTimersByTimeAsync(0);
      (provider as any).nostrClient = null;
      await vi.advanceTimersByTimeAsync(MAX_DELAY_MS);
      await runPromise;

      expect(caughtError).toBeDefined();
      expect(caughtError.code).toBe('TRANSPORT_ERROR');
      expect(caughtError.message).toMatch(/disconnected/i);
      // Only one publish attempt — the retry short-circuits on the null check
      expect(mockPublishEvent).toHaveBeenCalledTimes(1);
    });
  });

  describe('error cause chaining', () => {
    it('should attach the original error as cause on the thrown SphereError', async () => {
      const provider = createProvider();
      await provider.connect();

      const originalError = new Error('Event rejected: sent 0 of 1 report');
      mockPublishEvent.mockRejectedValue(originalError);

      const { error } = await publishWithRetries(provider, createMockNostrEvent(), 2);

      expect(error).toBeDefined();
      expect(error.code).toBe('TRANSPORT_ERROR');
      expect(error.cause).toBe(originalError);
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
