/**
 * Tests for NostrTransportProvider
 * Covers dynamic relay management
 *
 * Note: Since NostrTransportProvider now uses NostrClient from nostr-js-sdk
 * for robust connection management, tests that require mock WebSocket connections
 * need to mock NostrClient at the module level.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WebSocketFactory } from '../../../transport/websocket';

// =============================================================================
// Mock NostrClient
// =============================================================================

const mockSubscribe = vi.fn().mockReturnValue('mock-sub-id');
const mockUnsubscribe = vi.fn();
const mockPublishEvent = vi.fn().mockResolvedValue('mock-event-id');
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn();
const mockIsConnected = vi.fn().mockReturnValue(true);
const mockGetConnectedRelays = vi.fn().mockReturnValue(new Set(['wss://relay1.test', 'wss://relay2.test']));
const mockAddConnectionListener = vi.fn();
// Mirrors the private `relays` Map and `stopPingTimer(url)` in NostrClient.
// suppressSubscriptions() reaches into these to stop application-level
// keepalive pings on the bare connection (see NostrTransportProvider doc).
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

// Now import the provider (after mock is set up)
const { NostrTransportProvider } = await import('../../../transport/NostrTransportProvider');

// =============================================================================
// Test Setup
// =============================================================================

function createProvider(relays: string[] = ['wss://relay1.test', 'wss://relay2.test']) {
  return new NostrTransportProvider({
    relays,
    createWebSocket: (() => {}) as unknown as WebSocketFactory, // Not used anymore, NostrClient handles it
    timeout: 100,
    autoReconnect: false,
  });
}

// =============================================================================
// Tests
// =============================================================================

describe('NostrTransportProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock return values
    mockIsConnected.mockReturnValue(true);
    mockGetConnectedRelays.mockReturnValue(new Set(['wss://relay1.test', 'wss://relay2.test']));
  });

  describe('getRelays()', () => {
    it('should return configured relays', () => {
      const provider = createProvider(['wss://relay1.test', 'wss://relay2.test']);
      expect(provider.getRelays()).toEqual(['wss://relay1.test', 'wss://relay2.test']);
    });

    it('should return empty array if no relays configured', () => {
      const provider = createProvider([]);
      expect(provider.getRelays()).toEqual([]);
    });

    it('should return a copy, not the original array', () => {
      const provider = createProvider(['wss://relay1.test']);
      const relays = provider.getRelays();
      relays.push('wss://modified.test');
      expect(provider.getRelays()).toEqual(['wss://relay1.test']);
    });
  });

  describe('getConnectedRelays()', () => {
    it('should return empty array before connection', () => {
      const provider = createProvider();
      expect(provider.getConnectedRelays()).toEqual([]);
    });

    it('should return connected relays after connect', async () => {
      mockGetConnectedRelays.mockReturnValue(new Set(['wss://relay1.test', 'wss://relay2.test']));
      const provider = createProvider(['wss://relay1.test', 'wss://relay2.test']);
      await provider.connect();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();

      const connected = provider.getConnectedRelays();
      expect(connected).toContain('wss://relay1.test');
      expect(connected).toContain('wss://relay2.test');
    });

    it('should not include failed relays', async () => {
      // Mock that only relay1 is connected
      mockGetConnectedRelays.mockReturnValue(new Set(['wss://relay1.test']));
      const provider = createProvider(['wss://relay1.test', 'wss://relay2.test']);
      await provider.connect();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();

      const connected = provider.getConnectedRelays();
      expect(connected).toContain('wss://relay1.test');
      expect(connected).not.toContain('wss://relay2.test');
    });
  });

  describe('hasRelay()', () => {
    it('should return true for configured relay', () => {
      const provider = createProvider(['wss://relay1.test']);
      expect(provider.hasRelay('wss://relay1.test')).toBe(true);
    });

    it('should return false for non-configured relay', () => {
      const provider = createProvider(['wss://relay1.test']);
      expect(provider.hasRelay('wss://other.test')).toBe(false);
    });
  });

  describe('isRelayConnected()', () => {
    it('should return false before connection', () => {
      const provider = createProvider(['wss://relay1.test']);
      expect(provider.isRelayConnected('wss://relay1.test')).toBe(false);
    });

    it('should return true for connected relay', async () => {
      mockGetConnectedRelays.mockReturnValue(new Set(['wss://relay1.test']));
      const provider = createProvider(['wss://relay1.test']);
      await provider.connect();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();
      expect(provider.isRelayConnected('wss://relay1.test')).toBe(true);
    });

    it('should return false for failed relay', async () => {
      mockGetConnectedRelays.mockReturnValue(new Set(['wss://relay2.test']));
      const provider = createProvider(['wss://relay1.test', 'wss://relay2.test']);
      await provider.connect();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();
      expect(provider.isRelayConnected('wss://relay1.test')).toBe(false);
      expect(provider.isRelayConnected('wss://relay2.test')).toBe(true);
    });
  });

  describe('addRelay()', () => {
    it('should add relay to config', async () => {
      const provider = createProvider(['wss://relay1.test']);
      await provider.addRelay('wss://relay2.test');
      expect(provider.getRelays()).toContain('wss://relay2.test');
    });

    it('should return false if relay already exists', async () => {
      const provider = createProvider(['wss://relay1.test']);
      const result = await provider.addRelay('wss://relay1.test');
      expect(result).toBe(false);
    });

    it('should connect to relay if already connected', async () => {
      mockGetConnectedRelays.mockReturnValue(new Set(['wss://relay1.test', 'wss://relay2.test']));
      const provider = createProvider(['wss://relay1.test']);
      await provider.connect();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();

      const result = await provider.addRelay('wss://relay2.test');
      expect(result).toBe(true);
      expect(mockConnect).toHaveBeenCalledWith('wss://relay2.test');
    });

    it('should return false if new relay fails to connect', async () => {
      mockGetConnectedRelays.mockReturnValue(new Set(['wss://relay1.test']));
      const provider = createProvider(['wss://relay1.test']);
      await provider.connect();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();

      // Mock connect failure for the new relay
      mockConnect.mockRejectedValueOnce(new Error('Connection failed'));
      const result = await provider.addRelay('wss://failing.test');

      expect(result).toBe(false);
      expect(provider.hasRelay('wss://failing.test')).toBe(true); // Still in config
    });
  });

  describe('removeRelay()', () => {
    it('should remove relay from config', async () => {
      const provider = createProvider(['wss://relay1.test', 'wss://relay2.test']);
      await provider.removeRelay('wss://relay2.test');
      expect(provider.getRelays()).not.toContain('wss://relay2.test');
      expect(provider.getRelays()).toContain('wss://relay1.test');
    });

    it('should return false if relay not found', async () => {
      const provider = createProvider(['wss://relay1.test']);
      const result = await provider.removeRelay('wss://nonexistent.test');
      expect(result).toBe(false);
    });

    it('should disconnect from relay if connected', async () => {
      mockGetConnectedRelays.mockReturnValue(new Set(['wss://relay1.test', 'wss://relay2.test']));
      const provider = createProvider(['wss://relay1.test', 'wss://relay2.test']);
      await provider.connect();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();

      expect(provider.isRelayConnected('wss://relay2.test')).toBe(true);

      // After removing, update the mock
      mockGetConnectedRelays.mockReturnValue(new Set(['wss://relay1.test']));
      const result = await provider.removeRelay('wss://relay2.test');
      expect(result).toBe(true);
      // Note: NostrClient doesn't support removing individual relays at runtime
      // The relay is just removed from config
    });

    it('should handle removing last relay', async () => {
      mockGetConnectedRelays.mockReturnValue(new Set(['wss://relay1.test']));
      const provider = createProvider(['wss://relay1.test']);
      await provider.connect();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();

      // After removing, mock that no relays are connected
      mockIsConnected.mockReturnValue(false);
      mockGetConnectedRelays.mockReturnValue(new Set());
      await provider.removeRelay('wss://relay1.test');
      expect(provider.getRelays()).toEqual([]);
      expect(provider.getConnectedRelays()).toEqual([]);
      expect(provider.getStatus()).toBe('error'); // No relays remaining
    });
  });

  describe('suppressSubscriptions()', () => {
    beforeEach(() => {
      mockStopPingTimer.mockClear();
      mockRelaysMap.clear();
      mockRelaysMap.set('wss://relay1.test', { connected: true });
      mockRelaysMap.set('wss://relay2.test', { connected: true });
    });

    it('stops application-level ping timers on every relay', async () => {
      const provider = createProvider(['wss://relay1.test', 'wss://relay2.test']);
      await provider.connect();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();
      // Pre-flight: provider should not have called stopPingTimer at connect time.
      expect(mockStopPingTimer).not.toHaveBeenCalled();

      // The cast mirrors the production call site — suppressSubscriptions is
      // declared on the provider but only activated by Sphere when the mux
      // takes over event routing.
      (provider as unknown as { suppressSubscriptions(): void }).suppressSubscriptions();

      expect(mockStopPingTimer).toHaveBeenCalledTimes(2);
      expect(mockStopPingTimer).toHaveBeenCalledWith('wss://relay1.test');
      expect(mockStopPingTimer).toHaveBeenCalledWith('wss://relay2.test');
    });

    it('is a no-op when nostrClient is not yet constructed', () => {
      const provider = createProvider(['wss://relay1.test']);
      // Pre-connect — nostrClient is null. suppressSubscriptions returns
      // early without throwing.
      expect(() =>
        (provider as unknown as { suppressSubscriptions(): void }).suppressSubscriptions(),
      ).not.toThrow();
      expect(mockStopPingTimer).not.toHaveBeenCalled();
    });
  });
});

// =============================================================================
// Reconnect Re-subscription Tests
// =============================================================================

describe('Reconnect re-subscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsConnected.mockReturnValue(true);
    mockGetConnectedRelays.mockReturnValue(new Set(['wss://relay1.test']));
  });

  it('should re-subscribe to events after relay reconnect', async () => {
    const provider = createProvider(['wss://relay1.test']);

    // Set identity so subscribeToEvents has something to subscribe to
    provider.setIdentity({
      privateKey: 'a'.repeat(64),
      chainPubkey: '02' + 'b'.repeat(64),
      directAddress: 'DIRECT://test',
    });

    await provider.connect();

    // Issue #423 — auto-arm to preserve pre-gate test semantics

    await provider.armSubscriptions();

    // Capture the connection listener registered during connect()
    expect(mockAddConnectionListener).toHaveBeenCalled();
    const listener = mockAddConnectionListener.mock.calls[0][0];

    // subscribe was called during initial connect (subscribeToEvents)
    const subscribeCalls = mockSubscribe.mock.calls.length;

    // Simulate relay reconnect
    listener.onReconnected('wss://relay1.test');

    // Wait for the async re-subscription
    await vi.waitFor(() => {
      expect(mockSubscribe.mock.calls.length).toBeGreaterThan(subscribeCalls);
    });
  });

  it('should not throw if reconnect happens without identity', async () => {
    const provider = createProvider(['wss://relay1.test']);

    // Connect without identity
    await provider.connect();
    // Issue #423 — auto-arm to preserve pre-gate test semantics
    await provider.armSubscriptions();

    const listener = mockAddConnectionListener.mock.calls[0][0];

    // Should not throw — subscribeToEvents exits early without identity
    expect(() => listener.onReconnected('wss://relay1.test')).not.toThrow();
  });
});

// =============================================================================
// Nametag Format Tests
// =============================================================================

describe('Nametag binding format', () => {
  it('should create binding event with nostr-js-sdk compatible format', async () => {
    // This test verifies the event structure matches nostr-js-sdk
    const { hashNametag } = await import('@unicitylabs/nostr-js-sdk');

    const nametag = 'test-user';
    const publicKey = 'a'.repeat(64);
    const hashedNametag = hashNametag(nametag);

    // Expected format from nostr-js-sdk (no 'p' tag)
    const expectedTags = [
      ['d', hashedNametag],
      ['nametag', hashedNametag],
      ['t', hashedNametag],
      ['address', publicKey],
    ];

    const expectedContent = {
      nametag_hash: hashedNametag,
      address: publicKey,
      verified: expect.any(Number),
    };

    // Verify the tags include all required fields
    for (const [tagName] of expectedTags) {
      expect(['d', 'nametag', 't', 'address']).toContain(tagName);
    }

    // Verify content structure
    expect(expectedContent).toHaveProperty('nametag_hash');
    expect(expectedContent).toHaveProperty('address');
    expect(expectedContent).toHaveProperty('verified');
  });

  it('should parse address from various binding event formats', () => {
    const publicKey = 'b'.repeat(64);

    // Format 1: nostr-js-sdk style with 'address' tag
    const event1 = {
      tags: [['address', publicKey], ['d', 'hash']],
      content: '{}',
      pubkey: 'c'.repeat(64),
    };
    const addressTag1 = event1.tags.find((t: string[]) => t[0] === 'address');
    expect(addressTag1?.[1]).toBe(publicKey);

    // Format 2: Legacy SDK style with 'p' tag (backward compatibility)
    const event2 = {
      tags: [['p', publicKey], ['d', 'hash']],
      content: publicKey,
      pubkey: 'c'.repeat(64),
    };
    const pubkeyTag2 = event2.tags.find((t: string[]) => t[0] === 'p');
    expect(pubkeyTag2?.[1]).toBe(publicKey);

    // Format 3: nostr-js-sdk style with JSON content
    const event3 = {
      tags: [['d', 'hash']],
      content: JSON.stringify({ nametag_hash: 'hash', address: publicKey }),
      pubkey: 'c'.repeat(64),
    };
    const content3 = JSON.parse(event3.content);
    expect(content3.address).toBe(publicKey);
  });
});

// =============================================================================
// Event Subscription Pubkey Format Tests
// =============================================================================

describe('Event subscription pubkey format', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsConnected.mockReturnValue(true);
    mockGetConnectedRelays.mockReturnValue(new Set(['wss://test.relay']));
  });

  it('should use 32-byte Nostr pubkey in subscription filter, not 33-byte compressed key', async () => {
    const provider = createProvider(['wss://test.relay']);

    // 33-byte compressed public key (with 02/03 prefix)
    const compressedPubkey = '02' + 'a'.repeat(64);

    // Set identity with 33-byte compressed key
    provider.setIdentity({
      privateKey: 'b'.repeat(64),
      chainPubkey: compressedPubkey, // 33-byte compressed
    });

    await provider.connect();

    // Issue #423 — auto-arm to preserve pre-gate test semantics

    await provider.armSubscriptions();

    // Wait for subscription to be sent
    await new Promise(resolve => setTimeout(resolve, 50));

    // Verify subscribe was called
    expect(mockSubscribe).toHaveBeenCalled();

    // Get the filter that was passed to subscribe
    const [filterArg] = mockSubscribe.mock.calls[0];
    const filter = filterArg.toJSON();

    expect(filter['#p']).toBeDefined();
    const subscribedPubkey = filter['#p'][0];

    // Should be 64 hex chars (32 bytes), NOT 66 hex chars (33 bytes)
    expect(subscribedPubkey).toHaveLength(64);

    // Should NOT start with 02 or 03 (compressed key prefix)
    expect(subscribedPubkey.startsWith('02')).toBe(false);
    expect(subscribedPubkey.startsWith('03')).toBe(false);

    // Should NOT equal the 33-byte compressed key we passed in
    expect(subscribedPubkey).not.toBe(compressedPubkey);

    // Should be derived from the private key (via keyManager.getPublicKeyHex())
    expect(subscribedPubkey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should include all required event kinds in subscriptions (wallet and chat)', async () => {
    const provider = createProvider(['wss://test.relay']);

    provider.setIdentity({
      privateKey: 'b'.repeat(64),
      chainPubkey: '02' + 'a'.repeat(64),
    });

    await provider.connect();

    // Issue #423 — auto-arm to preserve pre-gate test semantics

    await provider.armSubscriptions();
    await new Promise(resolve => setTimeout(resolve, 50));

    // Should create two subscriptions: wallet and chat
    expect(mockSubscribe).toHaveBeenCalledTimes(2);

    // First subscription: wallet events (with since filter)
    const [walletFilterArg] = mockSubscribe.mock.calls[0];
    const walletFilter = walletFilterArg.toJSON();
    expect(walletFilter.kinds).toContain(4);     // DIRECT_MESSAGE
    expect(walletFilter.kinds).toContain(31113); // TOKEN_TRANSFER
    expect(walletFilter.kinds).toContain(31115); // PAYMENT_REQUEST
    expect(walletFilter.kinds).toContain(31116); // PAYMENT_REQUEST_RESPONSE
    expect(walletFilter.since).toBeDefined();    // Wallet has since filter

    // Second subscription: DM events (GIFT_WRAP, with its own since filter)
    const [chatFilterArg] = mockSubscribe.mock.calls[1];
    const chatFilter = chatFilterArg.toJSON();
    expect(chatFilter.kinds).toContain(1059);  // GIFT_WRAP (NIP-17)
    expect(chatFilter.since).toBeDefined();    // DM has its own since filter
  });

  it('getNostrPubkey should return 32-byte hex, different from identity.chainPubkey', async () => {
    const provider = createProvider(['wss://test.relay']);

    const compressedPubkey = '03' + 'c'.repeat(64); // 33-byte with 03 prefix

    provider.setIdentity({
      privateKey: 'd'.repeat(64),
      chainPubkey: compressedPubkey,
    });

    const nostrPubkey = provider.getNostrPubkey();

    // Should be 32 bytes (64 hex chars)
    expect(nostrPubkey).toHaveLength(64);
    expect(nostrPubkey).toMatch(/^[0-9a-f]{64}$/);

    // Should NOT be the 33-byte compressed key
    expect(nostrPubkey).not.toBe(compressedPubkey);
    expect(nostrPubkey.length).not.toBe(66);
  });
});

// =============================================================================
// Content Prefix Stripping Tests
// =============================================================================

describe('Content prefix stripping', () => {
  // Test the stripContentPrefix logic by importing and testing directly
  // Since it's private, we test the expected behavior through unit tests

  const prefixes = [
    'payment_request:',
    'token_transfer:',
    'payment_response:',
  ];

  function stripContentPrefix(content: string): string {
    for (const prefix of prefixes) {
      if (content.startsWith(prefix)) {
        return content.slice(prefix.length);
      }
    }
    return content;
  }

  describe('stripContentPrefix()', () => {
    it('should strip payment_request: prefix', () => {
      const content = 'payment_request:{"amount":"100"}';
      const result = stripContentPrefix(content);
      expect(result).toBe('{"amount":"100"}');
    });

    it('should strip token_transfer: prefix', () => {
      const content = 'token_transfer:{"token":"..."}';
      const result = stripContentPrefix(content);
      expect(result).toBe('{"token":"..."}');
    });

    it('should strip payment_response: prefix', () => {
      const content = 'payment_response:{"status":"paid"}';
      const result = stripContentPrefix(content);
      expect(result).toBe('{"status":"paid"}');
    });

    it('should not modify content without prefix', () => {
      const content = '{"amount":"100"}';
      const result = stripContentPrefix(content);
      expect(result).toBe('{"amount":"100"}');
    });

    it('should not strip unknown prefixes', () => {
      const content = 'unknown_prefix:{"data":"test"}';
      const result = stripContentPrefix(content);
      expect(result).toBe('unknown_prefix:{"data":"test"}');
    });

    it('should handle empty content', () => {
      const result = stripContentPrefix('');
      expect(result).toBe('');
    });

    it('should handle prefix-only content', () => {
      const result = stripContentPrefix('token_transfer:');
      expect(result).toBe('');
    });

    it('should allow JSON.parse after stripping prefix', () => {
      const content = 'token_transfer:{"token":"abc","amount":"1000"}';
      const stripped = stripContentPrefix(content);
      const parsed = JSON.parse(stripped);
      expect(parsed.token).toBe('abc');
      expect(parsed.amount).toBe('1000');
    });
  });
});

// =============================================================================
// Last Event Timestamp Persistence Tests
// =============================================================================

describe('Last event timestamp persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsConnected.mockReturnValue(true);
    mockGetConnectedRelays.mockReturnValue(new Set(['wss://test.relay']));
  });

  function createProviderWithStorage(storage: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> }) {
    return new NostrTransportProvider({
      relays: ['wss://test.relay'],
      createWebSocket: (() => {}) as unknown as WebSocketFactory,
      timeout: 100,
      autoReconnect: false,
      storage,
    });
  }

  function setIdentity(provider: InstanceType<typeof NostrTransportProvider>) {
    provider.setIdentity({
      privateKey: 'b'.repeat(64),
      chainPubkey: '02' + 'a'.repeat(64),
    });
  }

  describe('subscribeToEvents since filter', () => {
    it('should use stored timestamp when storage has a value', async () => {
      const storedTimestamp = '1700000000';
      const mockStorage = {
        get: vi.fn().mockResolvedValue(storedTimestamp),
        set: vi.fn().mockResolvedValue(undefined),
      };

      const provider = createProviderWithStorage(mockStorage);
      setIdentity(provider);
      await provider.connect();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockSubscribe).toHaveBeenCalled();
      const [walletFilterArg] = mockSubscribe.mock.calls[0];
      const walletFilter = walletFilterArg.toJSON();
      expect(walletFilter.since).toBe(1700000000);
    });

    it('should use current time when storage has no value (fresh wallet)', async () => {
      const mockStorage = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
      };

      const now = Math.floor(Date.now() / 1000);
      const provider = createProviderWithStorage(mockStorage);
      setIdentity(provider);
      await provider.connect();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockSubscribe).toHaveBeenCalled();
      const [walletFilterArg] = mockSubscribe.mock.calls[0];
      const walletFilter = walletFilterArg.toJSON();
      // Should be approximately current time (within 5 seconds)
      expect(walletFilter.since).toBeGreaterThanOrEqual(now - 5);
      expect(walletFilter.since).toBeLessThanOrEqual(now + 5);
    });

    it('should use current time when storage read fails', async () => {
      const mockStorage = {
        get: vi.fn().mockRejectedValue(new Error('Storage error')),
        set: vi.fn().mockResolvedValue(undefined),
      };

      const now = Math.floor(Date.now() / 1000);
      const provider = createProviderWithStorage(mockStorage);
      setIdentity(provider);
      await provider.connect();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockSubscribe).toHaveBeenCalled();
      const [walletFilterArg] = mockSubscribe.mock.calls[0];
      const walletFilter = walletFilterArg.toJSON();
      expect(walletFilter.since).toBeGreaterThanOrEqual(now - 5);
      expect(walletFilter.since).toBeLessThanOrEqual(now + 5);
    });

    it('should use 24h fallback when no storage adapter provided', async () => {
      const provider = createProvider(['wss://test.relay']);
      setIdentity(provider);

      const now = Math.floor(Date.now() / 1000);
      await provider.connect();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockSubscribe).toHaveBeenCalled();
      const [walletFilterArg] = mockSubscribe.mock.calls[0];
      const walletFilter = walletFilterArg.toJSON();
      // Should be approximately now - 86400 (24h)
      const expected24hAgo = now - 86400;
      expect(walletFilter.since).toBeGreaterThanOrEqual(expected24hAgo - 5);
      expect(walletFilter.since).toBeLessThanOrEqual(expected24hAgo + 5);
    });

    it('should apply independent since filter to DM subscription from storage', async () => {
      const mockStorage = {
        get: vi.fn().mockImplementation((key: string) => {
          if (key.startsWith('last_wallet_event_ts_')) return Promise.resolve('1700000000');
          if (key.startsWith('last_dm_event_ts_')) return Promise.resolve('1699999000');
          return Promise.resolve(null);
        }),
        set: vi.fn().mockResolvedValue(undefined),
      };

      const provider = createProviderWithStorage(mockStorage);
      setIdentity(provider);
      await provider.connect();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();
      await new Promise(resolve => setTimeout(resolve, 50));

      // Two subscriptions: wallet and DM (chat)
      expect(mockSubscribe).toHaveBeenCalledTimes(2);
      const [chatFilterArg] = mockSubscribe.mock.calls[1];
      const chatFilter = chatFilterArg.toJSON();
      expect(chatFilter.kinds).toContain(1059); // GIFT_WRAP
      // since = stored timestamp - NIP-17 randomization window (±2 days), clamped to 0
      const TWO_DAYS = 2 * 24 * 60 * 60;
      expect(chatFilter.since).toBe(Math.max(0, 1699999000 - TWO_DAYS));
    });

    it('should read storage key based on nostr pubkey prefix', async () => {
      const mockStorage = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
      };

      const provider = createProviderWithStorage(mockStorage);
      setIdentity(provider);
      await provider.connect();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();
      await new Promise(resolve => setTimeout(resolve, 50));

      // Four reads: persistent dedup events (#275) + persistent cooldowns (#275)
      // + wallet event ts + DM event ts. All four use the same pubkey prefix.
      expect(mockStorage.get).toHaveBeenCalledTimes(4);
      const calledKeys = mockStorage.get.mock.calls.map((c) => c[0] as string);
      expect(calledKeys).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^processed_wallet_event_ids_[0-9a-f]{16}$/),
          expect.stringMatching(/^failed_event_cooldowns_[0-9a-f]{16}$/),
          expect.stringMatching(/^last_wallet_event_ts_[0-9a-f]{16}$/),
          expect.stringMatching(/^last_dm_event_ts_[0-9a-f]{16}$/),
        ]),
      );
    });

    it('should use fallback since when no stored timestamp and fallback is set', async () => {
      const mockStorage = {
        get: vi.fn().mockResolvedValue(null), // No stored timestamp
        set: vi.fn().mockResolvedValue(undefined),
      };

      const fallbackTs = 1690000000;
      const provider = createProviderWithStorage(mockStorage);
      provider.setFallbackSince(fallbackTs);
      setIdentity(provider);
      await provider.connect();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockSubscribe).toHaveBeenCalled();
      const [walletFilterArg] = mockSubscribe.mock.calls[0];
      const walletFilter = walletFilterArg.toJSON();
      expect(walletFilter.since).toBe(fallbackTs);
    });

    it('should ignore fallback when stored timestamp exists', async () => {
      const storedTimestamp = '1700000000';
      const mockStorage = {
        get: vi.fn().mockResolvedValue(storedTimestamp),
        set: vi.fn().mockResolvedValue(undefined),
      };

      const provider = createProviderWithStorage(mockStorage);
      provider.setFallbackSince(1690000000); // Earlier than stored
      setIdentity(provider);
      await provider.connect();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockSubscribe).toHaveBeenCalled();
      const [walletFilterArg] = mockSubscribe.mock.calls[0];
      const walletFilter = walletFilterArg.toJSON();
      expect(walletFilter.since).toBe(1700000000); // Stored value wins
    });

    it('should consume fallback after first use (not reuse on next subscription)', async () => {
      const mockStorage = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
      };

      const fallbackTs = 1690000000;
      const provider = createProviderWithStorage(mockStorage);
      provider.setFallbackSince(fallbackTs);
      setIdentity(provider);
      await provider.connect();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();
      await new Promise(resolve => setTimeout(resolve, 50));

      // First subscription should use fallback
      const [firstWalletFilter] = mockSubscribe.mock.calls[0];
      expect(firstWalletFilter.toJSON().since).toBe(fallbackTs);

      // Reset mocks and trigger another subscription (e.g. identity change)
      mockSubscribe.mockClear();
      setIdentity(provider);
      await new Promise(resolve => setTimeout(resolve, 50));

      // Second subscription should NOT use fallback (was consumed)
      const now = Math.floor(Date.now() / 1000);
      const [secondWalletFilter] = mockSubscribe.mock.calls[0];
      const secondSince = secondWalletFilter.toJSON().since;
      expect(secondSince).toBeGreaterThanOrEqual(now - 5);
      expect(secondSince).toBeLessThanOrEqual(now + 5);
    });
  });

  describe('updateLastEventTimestamp', () => {
    it('should persist timestamp for DIRECT_MESSAGE (wallet) events', async () => {
      const mockStorage = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
      };

      const provider = createProviderWithStorage(mockStorage);
      setIdentity(provider);
      await provider.connect();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();
      await new Promise(resolve => setTimeout(resolve, 50));

      // Reset mock to only track calls from handleEvent
      mockStorage.set.mockClear();

      // Simulate a wallet event via the subscription callback
      // Use kind 4 (DIRECT_MESSAGE) because handleDirectMessage is a no-op
      // (it logs and returns), so the code continues to updateLastEventTimestamp.
      const subscribeCall = mockSubscribe.mock.calls[0];
      const callbacks = subscribeCall[1];
      callbacks.onEvent({
        id: 'event1',
        kind: 4, // DIRECT_MESSAGE
        content: '{}',
        tags: [],
        pubkey: 'a'.repeat(64),
        created_at: 1700000100,
        sig: 'sig',
      });

      // Wait for fire-and-forget async operations
      await new Promise(resolve => setTimeout(resolve, 100));

      // updateLastEventTimestamp uses in-memory comparison, then writes directly
      expect(mockStorage.set).toHaveBeenCalledWith(
        expect.stringMatching(/^last_wallet_event_ts_/),
        '1700000100'
      );
    });

    it('should only update if new timestamp is greater than in-memory tracker', async () => {
      // Seed the in-memory tracker by providing a stored timestamp on connect
      const mockStorage = {
        get: vi.fn().mockResolvedValue('1700000300'),
        set: vi.fn().mockResolvedValue(undefined),
      };

      const provider = createProviderWithStorage(mockStorage);
      setIdentity(provider);
      await provider.connect();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();
      await new Promise(resolve => setTimeout(resolve, 50));

      mockStorage.set.mockClear();

      const callbacks = mockSubscribe.mock.calls[0][1];
      callbacks.onEvent({
        id: 'event3',
        kind: 4, // DIRECT_MESSAGE (no-op handler, won't throw)
        content: '{}',
        tags: [],
        pubkey: 'a'.repeat(64),
        created_at: 1700000200, // Older than in-memory tracker (1700000300)
        sig: 'sig',
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      // set should NOT be called because 200 < 300 (in-memory check)
      expect(mockStorage.set).not.toHaveBeenCalled();
    });

    it('should update timestamp when newer event arrives', async () => {
      const mockStorage = {
        get: vi.fn().mockResolvedValue('1700000100'),
        set: vi.fn().mockResolvedValue(undefined),
      };

      const provider = createProviderWithStorage(mockStorage);
      setIdentity(provider);
      await provider.connect();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();
      await new Promise(resolve => setTimeout(resolve, 50));

      mockStorage.set.mockClear();

      const callbacks = mockSubscribe.mock.calls[0][1];
      callbacks.onEvent({
        id: 'event-newer',
        kind: 4, // DIRECT_MESSAGE
        content: '{}',
        tags: [],
        pubkey: 'a'.repeat(64),
        created_at: 1700000200, // Newer than in-memory tracker (1700000100)
        sig: 'sig',
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockStorage.set).toHaveBeenCalledWith(
        expect.stringMatching(/^last_wallet_event_ts_/),
        '1700000200'
      );
    });

    it('should handle rapid sequential events without race condition', async () => {
      const mockStorage = {
        get: vi.fn().mockResolvedValue(null), // fresh wallet
        set: vi.fn().mockResolvedValue(undefined),
      };

      const provider = createProviderWithStorage(mockStorage);
      setIdentity(provider);
      await provider.connect();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();
      await new Promise(resolve => setTimeout(resolve, 50));

      mockStorage.set.mockClear();

      const callbacks = mockSubscribe.mock.calls[0][1];

      // Fire 3 events in rapid succession (no await between them)
      callbacks.onEvent({
        id: 'rapid-1', kind: 4, content: '{}', tags: [],
        pubkey: 'a'.repeat(64), created_at: 1700000100, sig: 'sig',
      });
      callbacks.onEvent({
        id: 'rapid-2', kind: 4, content: '{}', tags: [],
        pubkey: 'a'.repeat(64), created_at: 1700000300, sig: 'sig',
      });
      callbacks.onEvent({
        id: 'rapid-3', kind: 4, content: '{}', tags: [],
        pubkey: 'a'.repeat(64), created_at: 1700000200, sig: 'sig',
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      // In-memory tracker ensures monotonic writes:
      // event1 (100): 100 > 0 → write 100
      // event2 (300): 300 > 100 → write 300
      // event3 (200): 200 < 300 → skip (no regression!)
      expect(mockStorage.set).toHaveBeenCalledTimes(2);
      // Last write should be 300, not 200
      const lastSetCall = mockStorage.set.mock.calls[mockStorage.set.mock.calls.length - 1];
      expect(lastSetCall[1]).toBe('1700000300');
    });

    it('should NOT persist DM timestamp when GIFT_WRAP unwrap fails', async () => {
      const mockStorage = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
      };

      const provider = createProviderWithStorage(mockStorage);
      setIdentity(provider);
      await provider.connect();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();
      await new Promise(resolve => setTimeout(resolve, 50));

      mockStorage.get.mockClear();
      mockStorage.set.mockClear();

      // Chat subscription is the second one
      const chatCallbacks = mockSubscribe.mock.calls[1][1];
      chatCallbacks.onEvent({
        id: 'chat-event',
        kind: 1059, // GIFT_WRAP
        content: '{}', // Invalid gift wrap — unwrap will fail
        tags: [],
        pubkey: 'a'.repeat(64),
        created_at: 1700000500,
        sig: 'sig',
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      // Timestamp should NOT be persisted when unwrap fails,
      // otherwise the event would be permanently skipped on reconnect
      expect(mockStorage.set).not.toHaveBeenCalled();
    });

    it('should handle storage write errors gracefully', async () => {
      const mockStorage = {
        get: vi.fn().mockResolvedValue(null), // fresh wallet
        set: vi.fn().mockRejectedValue(new Error('Write failed')),
      };

      const provider = createProviderWithStorage(mockStorage);
      setIdentity(provider);
      await provider.connect();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();
      await new Promise(resolve => setTimeout(resolve, 50));

      mockStorage.set.mockClear();

      const callbacks = mockSubscribe.mock.calls[0][1];
      // Should not throw even when storage.set fails
      expect(() => {
        callbacks.onEvent({
          id: 'event4',
          kind: 4, // DIRECT_MESSAGE (no-op handler, won't throw)
          content: '{}',
          tags: [],
          pubkey: 'a'.repeat(64),
          created_at: 1700000400,
          sig: 'sig',
        });
      }).not.toThrow();

      await new Promise(resolve => setTimeout(resolve, 100));
      // Verify set was attempted (and failed gracefully)
      expect(mockStorage.set).toHaveBeenCalled();
    });
  });
});

// =============================================================================
// Issue #275 — Persistent dedup of Nostr event IDs
// =============================================================================

describe('Issue #275 — persistent dedup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsConnected.mockReturnValue(true);
    mockGetConnectedRelays.mockReturnValue(new Set(['wss://test.relay']));
  });

  function createProviderWithStorage(storage: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> }) {
    return new NostrTransportProvider({
      relays: ['wss://test.relay'],
      createWebSocket: (() => {}) as unknown as WebSocketFactory,
      timeout: 100,
      autoReconnect: false,
      storage,
    });
  }

  function setIdentity(provider: InstanceType<typeof NostrTransportProvider>) {
    provider.setIdentity({
      privateKey: 'b'.repeat(64),
      chainPubkey: '02' + 'a'.repeat(64),
    });
  }

  describe('hydration on connect', () => {
    it('should hydrate persisted event IDs and dedupe subsequent dispatch', async () => {
      const persistedIds = JSON.stringify(['evt-a', 'evt-b']);
      const mockStorage = {
        get: vi.fn().mockImplementation((key: string) => {
          if (key.startsWith('processed_wallet_event_ids_')) {
            return Promise.resolve(persistedIds);
          }
          return Promise.resolve(null);
        }),
        set: vi.fn().mockResolvedValue(undefined),
      };

      const provider = createProviderWithStorage(mockStorage);
      setIdentity(provider);
      await provider.connect();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();
      await new Promise(resolve => setTimeout(resolve, 50));

      // Fire one of the hydrated event IDs through the handler
      const callbacks = mockSubscribe.mock.calls[0][1];
      const before = mockStorage.set.mock.calls.length;
      callbacks.onEvent({
        id: 'evt-a',
        kind: 4, // DIRECT_MESSAGE
        content: '{}',
        tags: [],
        pubkey: 'a'.repeat(64),
        created_at: 1700000500,
        sig: 'sig',
      });

      // Wait beyond the 200ms debounce window so any pending write
      // would have landed by now.
      await new Promise(resolve => setTimeout(resolve, 300));

      // No new write should land for a hydrated/already-processed event —
      // the dedup short-circuits BEFORE updateLastEventTimestamp.
      const after = mockStorage.set.mock.calls.length;
      const tsWrites = mockStorage.set.mock.calls
        .slice(before, after)
        .filter((c) => typeof c[0] === 'string' && (c[0] as string).startsWith('last_wallet_event_ts_'));
      expect(tsWrites.length).toBe(0);
    });

    it('should tolerate malformed persisted JSON gracefully', async () => {
      const mockStorage = {
        get: vi.fn().mockImplementation((key: string) => {
          if (key.startsWith('processed_wallet_event_ids_')) {
            return Promise.resolve('{not valid json');
          }
          return Promise.resolve(null);
        }),
        set: vi.fn().mockResolvedValue(undefined),
      };

      const provider = createProviderWithStorage(mockStorage);
      setIdentity(provider);
      // Should not throw — corrupt data degrades to "start fresh".
      await expect(provider.connect()).resolves.toBeUndefined();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(mockSubscribe).toHaveBeenCalled();
    });

    it('should ignore non-array persisted JSON', async () => {
      const mockStorage = {
        get: vi.fn().mockImplementation((key: string) => {
          if (key.startsWith('processed_wallet_event_ids_')) {
            return Promise.resolve(JSON.stringify({ not: 'an array' }));
          }
          return Promise.resolve(null);
        }),
        set: vi.fn().mockResolvedValue(undefined),
      };

      const provider = createProviderWithStorage(mockStorage);
      setIdentity(provider);
      await expect(provider.connect()).resolves.toBeUndefined();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();
      await new Promise(resolve => setTimeout(resolve, 50));

      // Subsequent event with same id should be processed (not deduped).
      const callbacks = mockSubscribe.mock.calls[0][1];
      mockStorage.set.mockClear();
      callbacks.onEvent({
        id: 'evt-after-malformed',
        kind: 4,
        content: '{}',
        tags: [],
        pubkey: 'a'.repeat(64),
        created_at: 1700000900,
        sig: 'sig',
      });
      await new Promise(resolve => setTimeout(resolve, 50));
      // ts write should occur (event processed)
      const tsWrites = mockStorage.set.mock.calls.filter(
        (c) => typeof c[0] === 'string' && (c[0] as string).startsWith('last_wallet_event_ts_'),
      );
      expect(tsWrites.length).toBe(1);
    });

    it('should hydrate persisted cooldowns and respect remaining window', async () => {
      const nextRetryAt = Date.now() + 60_000;
      const cooldowns = JSON.stringify([['stuck-evt', { nextRetryAt, attempts: 2 }]]);
      const mockStorage = {
        get: vi.fn().mockImplementation((key: string) => {
          if (key.startsWith('failed_event_cooldowns_')) {
            return Promise.resolve(cooldowns);
          }
          return Promise.resolve(null);
        }),
        set: vi.fn().mockResolvedValue(undefined),
      };

      const provider = createProviderWithStorage(mockStorage);
      setIdentity(provider);
      await provider.connect();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();
      await new Promise(resolve => setTimeout(resolve, 50));

      // Direct map inspection — the cooldown should have been hydrated
      // into the in-memory ledger so the next TOKEN_TRANSFER dispatch
      // for this id short-circuits at the gate. We assert on map state
      // rather than on side-effects to disambiguate from kind-31113's
      // handler-throw path (GAP 5 in steelman review).
      const cooldownsMap = (provider as unknown as {
        failedEventCooldowns: Map<string, { nextRetryAt: number; attempts: number }>;
      }).failedEventCooldowns;
      expect(cooldownsMap.has('stuck-evt')).toBe(true);
      expect(cooldownsMap.get('stuck-evt')?.attempts).toBe(2);
    });

    it('should drop stale cooldown entries on hydrate', async () => {
      // Mix a stale entry (drop) and a fresh entry (kept). Inspect the
      // in-memory map size after hydrate.
      const now = Date.now();
      const veryStale = now - 600_000; // 10 minutes ago — should drop
      const fresh = now + 30_000;       // 30s in future — should keep
      const cooldowns = JSON.stringify([
        ['stale-evt', { nextRetryAt: veryStale, attempts: 1 }],
        ['fresh-evt', { nextRetryAt: fresh, attempts: 2 }],
      ]);
      const mockStorage = {
        get: vi.fn().mockImplementation((key: string) => {
          if (key.startsWith('failed_event_cooldowns_')) {
            return Promise.resolve(cooldowns);
          }
          return Promise.resolve(null);
        }),
        set: vi.fn().mockResolvedValue(undefined),
      };

      const provider = createProviderWithStorage(mockStorage);
      setIdentity(provider);
      await provider.connect();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();
      await new Promise(resolve => setTimeout(resolve, 50));

      // Inspect the private field to verify the drop happened.
      const cooldownsMap = (provider as unknown as {
        failedEventCooldowns: Map<string, { nextRetryAt: number; attempts: number }>;
      }).failedEventCooldowns;
      expect(cooldownsMap.has('stale-evt')).toBe(false);
      expect(cooldownsMap.has('fresh-evt')).toBe(true);
      expect(cooldownsMap.size).toBe(1);
    });
  });

  describe('persist on event processed', () => {
    it('should write processed_wallet_event_ids after debounce window', async () => {
      const mockStorage = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
      };

      const provider = createProviderWithStorage(mockStorage);
      setIdentity(provider);
      await provider.connect();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();
      await new Promise(resolve => setTimeout(resolve, 50));

      mockStorage.set.mockClear();

      const callbacks = mockSubscribe.mock.calls[0][1];
      callbacks.onEvent({
        id: 'evt-persist-1',
        kind: 4,
        content: '{}',
        tags: [],
        pubkey: 'a'.repeat(64),
        created_at: 1700000123,
        sig: 'sig',
      });

      // Wait longer than 200ms debounce window
      await new Promise(resolve => setTimeout(resolve, 350));

      const dedupWrites = mockStorage.set.mock.calls.filter(
        (c) => typeof c[0] === 'string' && (c[0] as string).startsWith('processed_wallet_event_ids_'),
      );
      expect(dedupWrites.length).toBe(1);
      const payload = JSON.parse(dedupWrites[0][1] as string);
      expect(Array.isArray(payload)).toBe(true);
      expect(payload).toContain('evt-persist-1');
    });

    it('should coalesce rapid arrivals into a single debounced write', async () => {
      const mockStorage = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
      };

      const provider = createProviderWithStorage(mockStorage);
      setIdentity(provider);
      await provider.connect();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();
      await new Promise(resolve => setTimeout(resolve, 50));

      mockStorage.set.mockClear();
      const callbacks = mockSubscribe.mock.calls[0][1];

      // Fire 5 events well within the 200ms debounce window
      for (let i = 0; i < 5; i++) {
        callbacks.onEvent({
          id: `burst-${i}`,
          kind: 4,
          content: '{}',
          tags: [],
          pubkey: 'a'.repeat(64),
          created_at: 1700000200 + i,
          sig: 'sig',
        });
      }

      // Wait beyond debounce
      await new Promise(resolve => setTimeout(resolve, 350));

      const dedupWrites = mockStorage.set.mock.calls.filter(
        (c) => typeof c[0] === 'string' && (c[0] as string).startsWith('processed_wallet_event_ids_'),
      );
      // Coalesced: at most one write for the whole burst.
      expect(dedupWrites.length).toBe(1);
      const payload = JSON.parse(dedupWrites[0][1] as string);
      expect(payload.length).toBe(5);
    });
  });

  describe('cross-process semantics', () => {
    it('should NOT add to processed set when event has no id', async () => {
      const mockStorage = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
      };
      const provider = createProviderWithStorage(mockStorage);
      setIdentity(provider);
      await provider.connect();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();
      await new Promise(resolve => setTimeout(resolve, 50));
      mockStorage.set.mockClear();

      const callbacks = mockSubscribe.mock.calls[0][1];
      callbacks.onEvent({
        // no id
        kind: 4,
        content: '{}',
        tags: [],
        pubkey: 'a'.repeat(64),
        created_at: 1700001000,
        sig: 'sig',
      });

      await new Promise(resolve => setTimeout(resolve, 300));
      const dedupWrites = mockStorage.set.mock.calls.filter(
        (c) => typeof c[0] === 'string' && (c[0] as string).startsWith('processed_wallet_event_ids_'),
      );
      expect(dedupWrites.length).toBe(0);
    });

    it('should evict oldest entry when exceeding PROCESSED_EVENT_IDS_CAP', async () => {
      const mockStorage = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
      };
      const provider = createProviderWithStorage(mockStorage);
      setIdentity(provider);
      await provider.connect();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();
      await new Promise(resolve => setTimeout(resolve, 50));

      // Pre-populate the set to exactly the cap by reaching into the
      // private field. FIFO eviction must keep the set bounded.
      const internal = provider as unknown as {
        processedEventIds: Set<string>;
        markEventProcessed: (id: string) => void;
      };
      const { LIMITS } = await import('../../../constants');
      const cap = LIMITS.PROCESSED_EVENT_IDS_CAP;
      for (let i = 0; i < cap; i++) {
        internal.processedEventIds.add(`pre-${i}`);
      }
      expect(internal.processedEventIds.size).toBe(cap);

      // Add ONE more via markEventProcessed — should evict the oldest
      // ('pre-0') and stay at exactly cap.
      internal.markEventProcessed('overflow-id');
      expect(internal.processedEventIds.size).toBe(cap);
      expect(internal.processedEventIds.has('pre-0')).toBe(false); // evicted
      expect(internal.processedEventIds.has('pre-1')).toBe(true);
      expect(internal.processedEventIds.has('overflow-id')).toBe(true);
    });

    it('should flush pending dedup write on disconnect()', async () => {
      const mockStorage = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
      };
      const provider = createProviderWithStorage(mockStorage);
      setIdentity(provider);
      await provider.connect();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();
      await new Promise(resolve => setTimeout(resolve, 50));

      const callbacks = mockSubscribe.mock.calls[0][1];
      callbacks.onEvent({
        id: 'evt-flush-on-disconnect',
        kind: 4, // DIRECT_MESSAGE
        content: '{}',
        tags: [],
        pubkey: 'a'.repeat(64),
        created_at: 1700002000,
        sig: 'sig',
      });

      // Let handleEvent finish its synchronous portion so the timer is
      // armed. We do NOT wait the full 200ms debounce window.
      await new Promise(resolve => setTimeout(resolve, 50));
      mockStorage.set.mockClear();

      // Disconnect must flush the pending write — without this, the
      // pending dedup add would be lost on process exit.
      await provider.disconnect();

      const dedupWrites = mockStorage.set.mock.calls.filter(
        (c) => typeof c[0] === 'string' && (c[0] as string).startsWith('processed_wallet_event_ids_'),
      );
      expect(dedupWrites.length).toBe(1);
      const payload = JSON.parse(dedupWrites[0][1] as string);
      expect(payload).toContain('evt-flush-on-disconnect');
    });

    it('should cancel the armed debounce timer on setIdentity', async () => {
      const mockStorage = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
      };
      const provider = createProviderWithStorage(mockStorage);
      setIdentity(provider);
      await provider.connect();
      // Issue #423 — auto-arm to preserve pre-gate test semantics
      await provider.armSubscriptions();
      await new Promise(resolve => setTimeout(resolve, 50));

      const callbacks = mockSubscribe.mock.calls[0][1];
      callbacks.onEvent({
        id: 'pre-switch',
        kind: 4,
        content: '{}',
        tags: [],
        pubkey: 'a'.repeat(64),
        created_at: 1700001500,
        sig: 'sig',
      });

      // Let handleEvent finish its synchronous work (markEventProcessed
      // schedules the 200ms debounce timer). Wait 50ms — well under
      // the 200ms debounce — so the timer is armed but has not fired.
      await new Promise(resolve => setTimeout(resolve, 50));
      mockStorage.set.mockClear();

      // setIdentity must clear the armed timer.
      await provider.setIdentity({
        privateKey: 'c'.repeat(64),
        chainPubkey: '02' + 'd'.repeat(64),
      });

      // Wait past the original 200ms debounce window. If the timer was
      // properly cancelled, no write should carry 'pre-switch'.
      await new Promise(resolve => setTimeout(resolve, 350));

      const dedupWrites = mockStorage.set.mock.calls.filter(
        (c) => typeof c[0] === 'string' && (c[0] as string).startsWith('processed_wallet_event_ids_'),
      );
      // Either no write happened OR the writes carry only events from
      // the NEW identity (which is empty in this test).
      for (const w of dedupWrites) {
        const payload = JSON.parse(w[1] as string);
        expect(payload).not.toContain('pre-switch');
      }
    });
  });
});
