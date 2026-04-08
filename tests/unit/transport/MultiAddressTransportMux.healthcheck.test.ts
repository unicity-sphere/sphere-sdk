/**
 * Tests for MultiAddressTransportMux chat subscription health check.
 *
 * Verifies that the mux monitors both wallet and chat (gift-wrap) subscriptions
 * independently and re-subscribes when either goes stale.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// =============================================================================
// Mock NostrClient and nostr-js-sdk
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

// Import after mock setup
const { MultiAddressTransportMux } = await import('../../../transport/MultiAddressTransportMux');
const { EventKinds } = await import('@unicitylabs/nostr-js-sdk');

// =============================================================================
// Helpers
// =============================================================================

function createMux() {
  return new MultiAddressTransportMux({
    relays: ['wss://relay1.test'],
    createWebSocket: (() => {}) as any,
    timeout: 100,
    autoReconnect: false,
  });
}

const TEST_IDENTITY = {
  chainPubkey: '02' + 'ab'.repeat(32),
  l1Address: 'alpha1testaddr',
  directAddress: 'DIRECT://test',
  transportPubkey: 'cc'.repeat(32),
  privateKey: 'dd'.repeat(32),
};

// =============================================================================
// Tests
// =============================================================================

describe('MultiAddressTransportMux health check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockIsConnected.mockReturnValue(true);
    mockGetConnectedRelays.mockReturnValue(new Set(['wss://relay1.test']));
    mockSubscribe.mockReturnValue('mock-sub-id');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function setupConnectedMux() {
    const mux = createMux();
    mux.addAddress(0, TEST_IDENTITY);
    await mux.connect();
    // Clear call counts from initial subscription setup
    mockSubscribe.mockClear();
    mockUnsubscribe.mockClear();
    return mux;
  }

  describe('chat health check triggers re-subscription', () => {
    it('should re-subscribe when no gift-wrap events arrive for 60s', async () => {
      const mux = await setupConnectedMux();

      // Advance time past the chat threshold (60s) but under wallet threshold (300s)
      // The health check runs every 30s
      vi.advanceTimersByTime(30_000); // 30s — no trigger yet
      expect(mockSubscribe).not.toHaveBeenCalled();

      vi.advanceTimersByTime(31_000); // 61s total — chat check should trigger
      // Allow async updateSubscriptions to settle
      await vi.runAllTimersAsync().catch(() => {});
      await Promise.resolve();

      expect(mockSubscribe).toHaveBeenCalled();

      await mux.disconnect();
    });

    it('should NOT trigger chat health check when gift-wrap events are arriving', async () => {
      const mux = await setupConnectedMux();
      const muxAny = mux as any;

      // Simulate gift-wrap event arriving every 20s
      vi.advanceTimersByTime(20_000);
      muxAny.lastChatEventAt = Date.now();

      vi.advanceTimersByTime(20_000); // 40s total
      muxAny.lastChatEventAt = Date.now();

      vi.advanceTimersByTime(20_000); // 60s total, but last event was just now
      muxAny.lastChatEventAt = Date.now();

      vi.advanceTimersByTime(10_000); // 70s total — health check fires at 60s and 90s
      // No re-subscription should have happened because chat events kept arriving
      expect(mockSubscribe).not.toHaveBeenCalled();

      await mux.disconnect();
    });
  });

  describe('gift-wrap events reset the chat health timer', () => {
    it('should update lastChatEventAt when a GIFT_WRAP event is handled', async () => {
      const mux = await setupConnectedMux();
      const muxAny = mux as any;

      // Set lastChatEventAt to the past
      const pastTime = Date.now() - 50_000;
      muxAny.lastChatEventAt = pastTime;

      // Simulate a gift-wrap event through handleEvent
      await muxAny.handleEvent({
        id: 'test-gift-wrap-1',
        kind: EventKinds.GIFT_WRAP, // 1059
        content: 'encrypted-content',
        tags: [['p', 'somepubkey']],
        pubkey: 'senderpubkey',
        created_at: Math.floor(Date.now() / 1000),
        sig: 'sig',
      });

      // lastChatEventAt should have been updated
      expect(muxAny.lastChatEventAt).toBeGreaterThan(pastTime);

      await mux.disconnect();
    });

    it('should NOT update lastChatEventAt for non-GIFT_WRAP events', async () => {
      const mux = await setupConnectedMux();
      const muxAny = mux as any;

      const chatTimeBefore = muxAny.lastChatEventAt;

      // Advance time a bit so Date.now() changes
      vi.advanceTimersByTime(1000);

      // Simulate a wallet event (kind 4 = DIRECT_MESSAGE)
      await muxAny.handleEvent({
        id: 'test-wallet-event-1',
        kind: 4,
        content: 'encrypted-content',
        tags: [['p', 'somepubkey']],
        pubkey: 'senderpubkey',
        created_at: Math.floor(Date.now() / 1000),
        sig: 'sig',
      });

      // lastChatEventAt should NOT have changed
      expect(muxAny.lastChatEventAt).toBe(chatTimeBefore);
      // But lastWalletEventAt should have updated
      expect(muxAny.lastWalletEventAt).toBeGreaterThan(chatTimeBefore);

      await mux.disconnect();
    });
  });

  describe('wallet and chat health checks work independently', () => {
    it('should trigger wallet health check at 300s even if chat events arrive', async () => {
      const mux = await setupConnectedMux();
      const muxAny = mux as any;

      // Keep chat alive by resetting its timestamp periodically
      // but let wallet go stale
      for (let t = 30_000; t <= 270_000; t += 30_000) {
        vi.advanceTimersByTime(30_000);
        muxAny.lastChatEventAt = Date.now(); // chat is alive
      }

      // At 270s, wallet has been stale but under 300s threshold
      expect(mockSubscribe).not.toHaveBeenCalled();

      // Advance to 300s+
      vi.advanceTimersByTime(31_000); // 301s total
      await vi.runAllTimersAsync().catch(() => {});
      await Promise.resolve();

      // Wallet health check should have triggered re-subscription
      expect(mockSubscribe).toHaveBeenCalled();

      await mux.disconnect();
    });

    it('should trigger chat health check at 60s even if wallet events arrive', async () => {
      const mux = await setupConnectedMux();
      const muxAny = mux as any;

      // Keep wallet alive but let chat go stale
      vi.advanceTimersByTime(30_000); // 30s — health check fires
      muxAny.lastWalletEventAt = Date.now(); // wallet alive
      expect(mockSubscribe).not.toHaveBeenCalled();

      vi.advanceTimersByTime(31_000); // 61s — second health check fires
      muxAny.lastWalletEventAt = Date.now(); // wallet still alive
      await vi.runAllTimersAsync().catch(() => {});
      await Promise.resolve();

      // Chat health check should have triggered (chat stale for 61s > 60s)
      expect(mockSubscribe).toHaveBeenCalled();

      await mux.disconnect();
    });

    it('should not double-trigger when both wallet and chat are stale', async () => {
      const mux = await setupConnectedMux();
      const muxAny = mux as any;

      // Spy on updateSubscriptions to count calls
      const updateSpy = vi.spyOn(muxAny, 'updateSubscriptions').mockResolvedValue(undefined);

      // Set both timestamps far in the past so both are stale
      muxAny.lastWalletEventAt = Date.now() - 400_000;
      muxAny.lastChatEventAt = Date.now() - 400_000;

      // Advance by one health check interval (30s) — exactly one check fires
      vi.advanceTimersByTime(30_000);

      // The wallet check fires first (it's in the `if` branch).
      // The chat check is in the `else` branch, so it should NOT also fire.
      // Only one updateSubscriptions call should happen per interval tick.
      expect(updateSpy).toHaveBeenCalledTimes(1);

      updateSpy.mockRestore();
      await mux.disconnect();
    });
  });

  describe('disconnect and updateSubscriptions reset timestamps', () => {
    it('should reset lastChatEventAt on disconnect', async () => {
      const mux = await setupConnectedMux();
      const muxAny = mux as any;

      // Set timestamps to the past
      muxAny.lastChatEventAt = 1000;
      muxAny.lastWalletEventAt = 1000;

      await mux.disconnect();

      // Both should be reset to approximately now
      const now = Date.now();
      expect(muxAny.lastChatEventAt).toBeGreaterThanOrEqual(now - 1000);
      expect(muxAny.lastWalletEventAt).toBeGreaterThanOrEqual(now - 1000);
    });

    it('should reset both timestamps when updateSubscriptions is called', async () => {
      const mux = await setupConnectedMux();
      const muxAny = mux as any;

      // Set timestamps to the past
      muxAny.lastChatEventAt = 1000;
      muxAny.lastWalletEventAt = 1000;

      // Trigger updateSubscriptions
      await muxAny.updateSubscriptions();

      const now = Date.now();
      expect(muxAny.lastChatEventAt).toBeGreaterThanOrEqual(now - 1000);
      expect(muxAny.lastWalletEventAt).toBeGreaterThanOrEqual(now - 1000);
    });
  });
});
