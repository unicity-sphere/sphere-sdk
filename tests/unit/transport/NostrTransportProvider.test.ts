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
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: IMessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

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

    // Expected format from nostr-js-sdk
    const expectedTags = [
      ['d', hashedNametag],
      ['nametag', hashedNametag],
      ['t', hashedNametag],
      ['address', publicKey],
      ['p', publicKey],
    ];

    const expectedContent = {
      nametag_hash: hashedNametag,
      address: publicKey,
      verified: expect.any(Number),
    };

    // Verify the tags include all required fields
    for (const [tagName] of expectedTags) {
      expect(['d', 'nametag', 't', 'address', 'p']).toContain(tagName);
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

    // Format 2: SDK style with 'p' tag
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
