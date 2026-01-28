/**
 * Integration test for nametag registration and resolution
 * Tests the full cycle: register -> resolve
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NostrTransportProvider } from '../../transport/NostrTransportProvider';
import type { IWebSocket, IMessageEvent, WebSocketFactory } from '../../transport/websocket';
import { WebSocketReadyState } from '../../transport/websocket';
import type { FullIdentity } from '../../types';

// =============================================================================
// Mock Relay that stores and returns events
// =============================================================================

interface NostrEvent {
  id: string;
  kind: number;
  content: string;
  tags: string[][];
  pubkey: string;
  created_at: number;
  sig: string;
}

class MockRelayWebSocket implements IWebSocket {
  readyState: number = WebSocketReadyState.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: IMessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  private url: string;
  private static storedEvents: NostrEvent[] = [];

  constructor(url: string) {
    this.url = url;

    // Simulate async connection
    setTimeout(() => {
      this.readyState = WebSocketReadyState.OPEN;
      this.onopen?.(new Event('open'));
    }, 10);
  }

  static clearEvents(): void {
    MockRelayWebSocket.storedEvents = [];
  }

  static getStoredEvents(): NostrEvent[] {
    return [...MockRelayWebSocket.storedEvents];
  }

  send(data: string): void {
    const message = JSON.parse(data);
    const [type, ...args] = message;

    if (type === 'EVENT') {
      // Store the event
      const event = args[0] as NostrEvent;
      MockRelayWebSocket.storedEvents.push(event);

      // Send OK response
      setTimeout(() => {
        this.onmessage?.({
          data: JSON.stringify(['OK', event.id, true, '']),
        } as IMessageEvent);
      }, 5);
    } else if (type === 'REQ') {
      // Query events
      const subId = args[0];
      const filter = args[1];

      // Find matching events
      const matchingEvents = MockRelayWebSocket.storedEvents.filter(event => {
        // Check kind
        if (filter.kinds && !filter.kinds.includes(event.kind)) {
          return false;
        }

        // Check #t tag
        if (filter['#t']) {
          const tTags = event.tags.filter(t => t[0] === 't').map(t => t[1]);
          if (!filter['#t'].some((v: string) => tTags.includes(v))) {
            return false;
          }
        }

        // Check #d tag
        if (filter['#d']) {
          const dTags = event.tags.filter(t => t[0] === 'd').map(t => t[1]);
          if (!filter['#d'].some((v: string) => dTags.includes(v))) {
            return false;
          }
        }

        return true;
      });

      // Send matching events
      setTimeout(() => {
        for (const event of matchingEvents.slice(0, filter.limit || 10)) {
          this.onmessage?.({
            data: JSON.stringify(['EVENT', subId, event]),
          } as IMessageEvent);
        }

        // Send EOSE
        this.onmessage?.({
          data: JSON.stringify(['EOSE', subId]),
        } as IMessageEvent);
      }, 10);
    } else if (type === 'CLOSE') {
      // Subscription closed, do nothing
    }
  }

  close(): void {
    this.readyState = WebSocketReadyState.CLOSED;
    this.onclose?.({ code: 1000, reason: 'Normal closure' } as CloseEvent);
  }
}

const createMockWebSocket: WebSocketFactory = (url: string) => {
  return new MockRelayWebSocket(url);
};

// =============================================================================
// Test Identity
// =============================================================================

const TEST_IDENTITY: FullIdentity = {
  privateKey: 'a'.repeat(64),
  publicKey: 'b'.repeat(64),
  address: 'alpha1testaddress',
  ipnsName: '12D3KooWtest',
  nametag: undefined,
};

// =============================================================================
// Tests
// =============================================================================

describe('Nametag roundtrip integration', () => {
  let provider: NostrTransportProvider;

  beforeEach(() => {
    MockRelayWebSocket.clearEvents();

    provider = new NostrTransportProvider({
      relays: ['wss://mock-relay.test'],
      createWebSocket: createMockWebSocket,
      timeout: 1000,
      autoReconnect: false,
    });
  });

  afterEach(async () => {
    await provider.disconnect();
  });

  it('should register and resolve nametag', async () => {
    // Setup
    provider.setIdentity(TEST_IDENTITY);
    await provider.connect();

    const nametag = 'test-lottery';
    const publicKey = TEST_IDENTITY.publicKey;

    // Register nametag
    const registerResult = await provider.registerNametag(nametag, publicKey);
    expect(registerResult).toBe(true);

    // Verify event was stored
    const storedEvents = MockRelayWebSocket.getStoredEvents();
    expect(storedEvents.length).toBe(1);

    const event = storedEvents[0];
    expect(event.kind).toBe(30078); // NAMETAG_BINDING

    // Check tags include all required fields
    const tagNames = event.tags.map(t => t[0]);
    expect(tagNames).toContain('d');
    expect(tagNames).toContain('t');
    expect(tagNames).toContain('nametag');
    expect(tagNames).toContain('address');
    expect(tagNames).toContain('p');

    // Check address tag has correct value
    const addressTag = event.tags.find(t => t[0] === 'address');
    expect(addressTag?.[1]).toBe(publicKey);

    // Check content is valid JSON with correct structure
    const content = JSON.parse(event.content);
    expect(content).toHaveProperty('nametag_hash');
    expect(content).toHaveProperty('address', publicKey);
    expect(content).toHaveProperty('verified');

    // Resolve nametag
    const resolvedPubkey = await provider.resolveNametag(nametag);
    expect(resolvedPubkey).toBe(publicKey);
  });

  it('should return null for non-existent nametag', async () => {
    provider.setIdentity(TEST_IDENTITY);
    await provider.connect();

    const resolvedPubkey = await provider.resolveNametag('non-existent');
    expect(resolvedPubkey).toBeNull();
  });

  it('should detect already registered nametag', async () => {
    provider.setIdentity(TEST_IDENTITY);
    await provider.connect();

    const nametag = 'duplicate-test';
    const publicKey = TEST_IDENTITY.publicKey;

    // Register first time
    const result1 = await provider.registerNametag(nametag, publicKey);
    expect(result1).toBe(true);

    // Register second time - should succeed (same pubkey)
    const result2 = await provider.registerNametag(nametag, publicKey);
    expect(result2).toBe(true);

    // Only one event should be stored (second call should not publish)
    const storedEvents = MockRelayWebSocket.getStoredEvents();
    expect(storedEvents.length).toBe(1);
  });

  it('should reject registration if nametag taken by another pubkey', async () => {
    provider.setIdentity(TEST_IDENTITY);
    await provider.connect();

    const nametag = 'taken-tag';
    const otherPubkey = 'c'.repeat(64);

    // Register with other pubkey first
    await provider.registerNametag(nametag, otherPubkey);

    // Try to register with our pubkey
    const result = await provider.registerNametag(nametag, TEST_IDENTITY.publicKey);
    expect(result).toBe(false);
  });

  it('should resolve nametag from address tag (nostr-js-sdk format)', async () => {
    provider.setIdentity(TEST_IDENTITY);
    await provider.connect();

    const nametag = 'sdk-format';
    const publicKey = TEST_IDENTITY.publicKey;

    await provider.registerNametag(nametag, publicKey);

    // Verify resolveNametag finds it via 'address' tag
    const resolved = await provider.resolveNametag(nametag);
    expect(resolved).toBe(publicKey);
  });
});
