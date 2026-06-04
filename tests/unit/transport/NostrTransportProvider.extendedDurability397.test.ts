/**
 * Issue #397 — extended-durability publisher hold for short-lived
 * recipient processes.
 *
 * Tests the new `publishWithExtendedDurability` private method on
 * `NostrTransportProvider`. The method extends the standard
 * `publishWithVerification` window from ~1.5 seconds to ~30 seconds by
 * re-querying the relay at a schedule of escalating checkpoints and
 * re-publishing the same event if it has been evicted.
 *
 * What this fixes (reproduced by `manual-test-accounting-roundtrip.sh`):
 *   - testnet's single Nostr relay sometimes evicts gift wraps within
 *     seconds of publish, well before a short-lived recipient CLI
 *     subscribes;
 *   - pre-fix, the publisher's `publishWithVerification` queried at
 *     ~1.5s, observed the event still present, returned success, then
 *     exited — and the recipient's later subscribe got nothing.
 *
 * The tests below exercise the method directly through reflection
 * (mirrors the durabilityCooldown272 pattern) because routing through
 * the public `sendMessage` path would require functional NIP-17
 * crypto + identity setup that adds no logic coverage to this surface.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WebSocketFactory } from '../../../transport/websocket';

// =============================================================================
// Mock NostrClient
// =============================================================================

const mockSubscribe = vi.fn();
const mockUnsubscribe = vi.fn();
const mockPublishEvent = vi.fn().mockResolvedValue('mock-event-id');
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn();
const mockIsConnected = vi.fn().mockReturnValue(true);
const mockGetConnectedRelays = vi
  .fn()
  .mockReturnValue(new Set(['wss://test.relay']));
const mockAddConnectionListener = vi.fn();
const mockRelaysMap = new Map<string, unknown>();
const mockStopPingTimer = vi.fn();

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
      relays: mockRelaysMap,
      stopPingTimer: mockStopPingTimer,
    })),
  };
});

const { NostrTransportProvider } = await import(
  '../../../transport/NostrTransportProvider'
);

// =============================================================================
// Test Helpers
// =============================================================================

function createProvider(): InstanceType<typeof NostrTransportProvider> {
  return new NostrTransportProvider({
    relays: ['wss://test.relay'],
    createWebSocket: (() => {}) as unknown as WebSocketFactory,
    timeout: 100,
    autoReconnect: false,
  });
}

function createMockNostrEvent() {
  return {
    id: 'a'.repeat(64),
    kind: 1059, // GIFT_WRAP
    content: 'mock encrypted content',
    tags: [['p', 'b'.repeat(64)]],
    pubkey: 'c'.repeat(64),
    created_at: Math.floor(Date.now() / 1000),
    sig: 'd'.repeat(128),
  };
}

/**
 * Build a `mockSubscribe` implementation that controls the verify
 * outcome for each successive `queryEvents` call.
 *
 * Each entry in `verifyOutcomes` corresponds to one call to
 * `mockSubscribe` and decides what the synthetic subscription delivers:
 *   - `'present'` — onEvent fires with the target event, then EOSE.
 *   - `'absent'`  — only EOSE fires (no events delivered).
 *   - `'timeout'` — neither onEvent nor EOSE fires (queryEvents times out).
 *
 * The method returns a fake subId.
 */
function installVerifyOutcomes(
  event: ReturnType<typeof createMockNostrEvent>,
  verifyOutcomes: ReadonlyArray<'present' | 'absent' | 'timeout'>,
): void {
  let call = 0;
  mockSubscribe.mockImplementation(
    (_filter: unknown, callbacks: { onEvent?: (e: unknown) => void; onEndOfStoredEvents?: () => void }) => {
      const outcome = verifyOutcomes[call] ?? 'present';
      call++;
      // Defer to microtask so subscribe() returns the subId before
      // settling, matching the real nostr-js-sdk behavior.
      queueMicrotask(() => {
        if (outcome === 'present') {
          callbacks.onEvent?.(event);
          callbacks.onEndOfStoredEvents?.();
        } else if (outcome === 'absent') {
          callbacks.onEndOfStoredEvents?.();
        }
        // 'timeout' → never settle; queryEvents will hit its 8s cap.
      });
      return `sub-${call}`;
    },
  );
}

/**
 * Drive a `publishWithExtendedDurability` promise to settlement under
 * fake timers. Advances the timer in 1s steps until the promise either
 * resolves or rejects, capped at a generous wall-clock budget.
 */
async function drivePromise<T>(
  promise: Promise<T>,
): Promise<{ value?: T; error?: unknown }> {
  let value: T | undefined;
  let error: unknown;
  const tracked = promise.then(
    (v) => {
      value = v;
    },
    (e) => {
      error = e;
    },
  );

  // The schedule maxes out at 30s, plus 8s query timeouts per
  // checkpoint. 5 minutes is a generous safety budget for the timer
  // advance loop; we exit as soon as the promise settles.
  for (let i = 0; i < 300; i++) {
    await vi.advanceTimersByTimeAsync(1000);
    if (value !== undefined || error !== undefined) break;
  }
  // Yield once more to flush any pending microtasks.
  await tracked.catch(() => undefined);
  return { value, error };
}

// =============================================================================
// Tests
// =============================================================================

describe('NostrTransportProvider.publishWithExtendedDurability (#397)', () => {
  beforeEach(() => {
    mockPublishEvent.mockReset();
    mockSubscribe.mockReset();
    mockUnsubscribe.mockReset();
    mockConnect.mockReset();
    mockIsConnected.mockReset();
    mockGetConnectedRelays.mockReset();

    vi.useFakeTimers();

    mockPublishEvent.mockResolvedValue('mock-event-id');
    mockConnect.mockResolvedValue(undefined);
    mockIsConnected.mockReturnValue(true);
    mockGetConnectedRelays.mockReturnValue(new Set(['wss://test.relay']));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves without republishing when the event stays durable at every checkpoint', async () => {
    const provider = createProvider();
    await provider.connect();
    const event = createMockNostrEvent();
    // Verify call sequence: 1 from publishWithVerification + 4 from
    // extended-durability checkpoints (3000, 8000, 18000, 30000).
    installVerifyOutcomes(event, [
      'present', // publishWithVerification post-publish verify
      'present', // checkpoint 3000ms
      'present', // checkpoint 8000ms
      'present', // checkpoint 18000ms
      'present', // checkpoint 30000ms
    ]);

    const { value, error } = await drivePromise(
      (provider as unknown as { publishWithExtendedDurability: (e: unknown, l: string) => Promise<void> })
        .publishWithExtendedDurability(event, 'dm'),
    );

    expect(error).toBeUndefined();
    expect(value).toBeUndefined();
    // Exactly one publish — the initial one. Zero republishes.
    expect(mockPublishEvent).toHaveBeenCalledTimes(1);
  });

  it('republishes when the event is observed missing at a checkpoint, then succeeds on the next verify', async () => {
    const provider = createProvider();
    await provider.connect();
    const event = createMockNostrEvent();
    // Sequence:
    //  1. publishWithVerification post-publish verify → present
    //  2. checkpoint 3000ms → present
    //  3. checkpoint 8000ms → ABSENT → triggers republish
    //  4. republish's own post-publish verify → present
    //  5. checkpoint 18000ms → present
    //  6. checkpoint 30000ms → present
    installVerifyOutcomes(event, [
      'present',
      'present',
      'absent',
      'present',
      'present',
      'present',
    ]);

    const { error } = await drivePromise(
      (provider as unknown as { publishWithExtendedDurability: (e: unknown, l: string) => Promise<void> })
        .publishWithExtendedDurability(event, 'dm'),
    );

    expect(error).toBeUndefined();
    // 2 publishes: initial + 1 republish triggered at 8000ms checkpoint.
    expect(mockPublishEvent).toHaveBeenCalledTimes(2);
  });

  it('throws TRANSPORT_ERROR after exhausting the republish budget', async () => {
    const provider = createProvider();
    await provider.connect();
    const event = createMockNostrEvent();
    // Sequence: post-publish verify present, then every checkpoint
    // misses. Each miss triggers a republish + its own verify (which
    // returns present, satisfying the inner publishWithVerification);
    // then the next checkpoint misses again.
    //  - call 1: post-publish verify → present
    //  - call 2: cp 3000ms → ABSENT (republish #1 fires)
    //  - call 3: republish #1 verify → present
    //  - call 4: cp 8000ms → ABSENT (republish #2 fires)
    //  - call 5: republish #2 verify → present
    //  - call 6: cp 18000ms → ABSENT (republish #3 fires)
    //  - call 7: republish #3 verify → present
    //  - call 8: cp 30000ms → ABSENT (budget exhausted → throws)
    installVerifyOutcomes(event, [
      'present', // 1
      'absent',  // 2 — cp 3000ms
      'present', // 3 — republish 1 verify
      'absent',  // 4 — cp 8000ms
      'present', // 5 — republish 2 verify
      'absent',  // 6 — cp 18000ms
      'present', // 7 — republish 3 verify
      'absent',  // 8 — cp 30000ms (budget exhausted)
    ]);

    const { error } = await drivePromise(
      (provider as unknown as { publishWithExtendedDurability: (e: unknown, l: string) => Promise<void> })
        .publishWithExtendedDurability(event, 'invoice_delivery'),
    );

    expect(error).toBeDefined();
    expect((error as { code?: string }).code).toBe('TRANSPORT_ERROR');
    expect((error as { message?: string }).message).toMatch(/non-durable/);
    // 4 publishes: initial + 3 republishes (the budget).
    expect(mockPublishEvent).toHaveBeenCalledTimes(4);
  });

  it('treats a verify-query disconnect throw as optimistically durable (no republish)', async () => {
    const provider = createProvider();
    await provider.connect();
    const event = createMockNostrEvent();
    // queryEvents throws SphereError 'No connected relays' if the
    // client is not connected when the verify call fires. Simulate by
    // returning false from isConnected the moment the second verify
    // call is about to query the relay.
    //
    // Sequence:
    //  - call 1 (publishWithVerification verify, post-publish): present
    //  - call 2 (extended durability cp 3000ms): isConnected→false →
    //    queryEvents throws → catch fires → continue (no republish)
    //  - call 3 (cp 8000ms): isConnected→true again → present
    //  - call 4 (cp 18000ms): present
    //  - call 5 (cp 30000ms): present
    installVerifyOutcomes(event, [
      'present',
      'present', // unused — the second queryEvents throws before subscribing
      'present',
      'present',
      'present',
    ]);
    let isConnCall = 0;
    mockIsConnected.mockImplementation(() => {
      isConnCall++;
      // queryEvents checks isConnected at the top. The first call is
      // for the post-publish verify (publishWithVerification path).
      // The second is for the cp-3000ms verify — return false here so
      // queryEvents throws and the extended-durability catch fires.
      if (isConnCall === 2) return false;
      return true;
    });

    const { error } = await drivePromise(
      (provider as unknown as { publishWithExtendedDurability: (e: unknown, l: string) => Promise<void> })
        .publishWithExtendedDurability(event, 'dm'),
    );

    expect(error).toBeUndefined();
    // Zero republishes — disconnect-mid-flight is optimistic.
    expect(mockPublishEvent).toHaveBeenCalledTimes(1);
  });
});
