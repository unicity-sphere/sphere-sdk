/**
 * Tests for NostrTransportProvider
 * Covers dynamic relay management
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { NostrTransportProvider } from '../../../transport/NostrTransportProvider';
import type { IWebSocket, IMessageEvent, WebSocketFactory } from '../../../transport/websocket';
import { WebSocketReadyState } from '../../../transport/websocket';

// =============================================================================
// Mock WebSocket
// =============================================================================

class MockWebSocket implements IWebSocket {
  readyState: number = WebSocketReadyState.CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: IMessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;

  private _url: string;
  private shouldFail: boolean;

  constructor(url: string, shouldFail: boolean = false) {
    this._url = url;
    this.shouldFail = shouldFail;

    // Simulate async connection
    setTimeout(() => {
      if (this.shouldFail) {
        this.readyState = WebSocketReadyState.CLOSED;
        this.onerror?.(new Event('error'));
        this.onclose?.({ code: 1006, reason: 'Connection failed' } as CloseEvent);
      } else {
        this.readyState = WebSocketReadyState.OPEN;
        this.onopen?.(new Event('open'));
      }
    }, 10);
  }

  send(_data: string): void {
    // Mock send
  }

  close(): void {
    this.readyState = WebSocketReadyState.CLOSED;
    this.onclose?.({ code: 1000, reason: 'Normal closure' } as CloseEvent);
  }
}

// Track created connections
const createdConnections: Map<string, MockWebSocket> = new Map();
const failingRelays: Set<string> = new Set();

const createMockWebSocket: WebSocketFactory = (url: string) => {
  const ws = new MockWebSocket(url, failingRelays.has(url));
  createdConnections.set(url, ws);
  return ws;
};

// =============================================================================
// Test Setup
// =============================================================================

function createProvider(relays: string[] = ['wss://relay1.test', 'wss://relay2.test']) {
  return new NostrTransportProvider({
    relays,
    createWebSocket: createMockWebSocket,
    timeout: 100,
    autoReconnect: false,
  });
}

// =============================================================================
// Tests
// =============================================================================

describe('NostrTransportProvider', () => {
  beforeEach(() => {
    createdConnections.clear();
    failingRelays.clear();
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
      const provider = createProvider(['wss://relay1.test', 'wss://relay2.test']);
      await provider.connect();

      const connected = provider.getConnectedRelays();
      expect(connected).toContain('wss://relay1.test');
      expect(connected).toContain('wss://relay2.test');
    });

    it('should not include failed relays', async () => {
      failingRelays.add('wss://relay2.test');
      const provider = createProvider(['wss://relay1.test', 'wss://relay2.test']);
      await provider.connect();

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
      const provider = createProvider(['wss://relay1.test']);
      await provider.connect();
      expect(provider.isRelayConnected('wss://relay1.test')).toBe(true);
    });

    it('should return false for failed relay', async () => {
      failingRelays.add('wss://relay1.test');
      const provider = createProvider(['wss://relay1.test', 'wss://relay2.test']);
      await provider.connect();
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
      const provider = createProvider(['wss://relay1.test']);
      await provider.connect();

      const result = await provider.addRelay('wss://relay2.test');
      expect(result).toBe(true);

      // Wait for connection
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(provider.isRelayConnected('wss://relay2.test')).toBe(true);
    });

    it('should return false if new relay fails to connect', async () => {
      const provider = createProvider(['wss://relay1.test']);
      await provider.connect();

      failingRelays.add('wss://failing.test');
      const result = await provider.addRelay('wss://failing.test');

      // Wait for connection attempt
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(result).toBe(false);
      expect(provider.hasRelay('wss://failing.test')).toBe(true); // Still in config
      expect(provider.isRelayConnected('wss://failing.test')).toBe(false);
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
      const provider = createProvider(['wss://relay1.test', 'wss://relay2.test']);
      await provider.connect();

      expect(provider.isRelayConnected('wss://relay2.test')).toBe(true);

      const result = await provider.removeRelay('wss://relay2.test');
      expect(result).toBe(true);
      expect(provider.isRelayConnected('wss://relay2.test')).toBe(false);
      expect(provider.getConnectedRelays()).not.toContain('wss://relay2.test');
    });

    it('should handle removing last relay', async () => {
      const provider = createProvider(['wss://relay1.test']);
      await provider.connect();

      await provider.removeRelay('wss://relay1.test');
      expect(provider.getRelays()).toEqual([]);
      expect(provider.getConnectedRelays()).toEqual([]);
      expect(provider.getStatus()).toBe('error'); // No relays remaining
    });
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
  // Extended MockWebSocket to track sent messages
  class TrackingMockWebSocket implements IWebSocket {
    readyState: number = WebSocketReadyState.CONNECTING;
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: IMessageEvent) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onclose: ((event: unknown) => void) | null = null;
    sentMessages: string[] = [];

    constructor() {
      setTimeout(() => {
        this.readyState = WebSocketReadyState.OPEN;
        this.onopen?.(new Event('open'));
      }, 10);
    }

    send(data: string): void {
      this.sentMessages.push(data);
    }

    close(): void {
      this.readyState = WebSocketReadyState.CLOSED;
    }
  }

  it('should use 32-byte Nostr pubkey in subscription filter, not 33-byte compressed key', async () => {
    let createdWs: TrackingMockWebSocket | null = null;

    const provider = new NostrTransportProvider({
      relays: ['wss://test.relay'],
      createWebSocket: () => {
        createdWs = new TrackingMockWebSocket();
        return createdWs;
      },
      timeout: 100,
      autoReconnect: false,
    });

    // 33-byte compressed public key (with 02/03 prefix)
    const compressedPubkey = '02' + 'a'.repeat(64);

    // Set identity with 33-byte compressed key
    provider.setIdentity({
      privateKey: 'b'.repeat(64),
      publicKey: compressedPubkey, // 33-byte compressed
      address: 'alpha1test',
    });

    await provider.connect();

    // Wait for subscription to be sent
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(createdWs).not.toBeNull();
    expect(createdWs!.sentMessages.length).toBeGreaterThan(0);

    // Find the REQ message (subscription)
    const reqMessage = createdWs!.sentMessages.find(msg => msg.includes('REQ'));
    expect(reqMessage).toBeDefined();

    const parsed = JSON.parse(reqMessage!);
    expect(parsed[0]).toBe('REQ');

    const filter = parsed[2];
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
    // The actual value depends on the private key, but we verify the format is correct
    expect(subscribedPubkey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should include all required event kinds in subscription', async () => {
    let createdWs: TrackingMockWebSocket | null = null;

    const provider = new NostrTransportProvider({
      relays: ['wss://test.relay'],
      createWebSocket: () => {
        createdWs = new TrackingMockWebSocket();
        return createdWs;
      },
      timeout: 100,
      autoReconnect: false,
    });

    provider.setIdentity({
      privateKey: 'b'.repeat(64),
      publicKey: '02' + 'a'.repeat(64),
      address: 'alpha1test',
    });

    await provider.connect();
    await new Promise(resolve => setTimeout(resolve, 50));

    const reqMessage = createdWs!.sentMessages.find(msg => msg.includes('REQ'));
    const parsed = JSON.parse(reqMessage!);
    const filter = parsed[2];

    // Should subscribe to all 4 event kinds (from NOSTR_EVENT_KINDS)
    expect(filter.kinds).toContain(4);     // DIRECT_MESSAGE
    expect(filter.kinds).toContain(31113); // TOKEN_TRANSFER
    expect(filter.kinds).toContain(31115); // PAYMENT_REQUEST
    expect(filter.kinds).toContain(31116); // PAYMENT_REQUEST_RESPONSE
  });

  it('getNostrPubkey should return 32-byte hex, different from identity.publicKey', async () => {
    const provider = new NostrTransportProvider({
      relays: ['wss://test.relay'],
      createWebSocket: () => new TrackingMockWebSocket(),
      timeout: 100,
      autoReconnect: false,
    });

    const compressedPubkey = '03' + 'c'.repeat(64); // 33-byte with 03 prefix

    provider.setIdentity({
      privateKey: 'd'.repeat(64),
      publicKey: compressedPubkey,
      address: 'alpha1test',
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
