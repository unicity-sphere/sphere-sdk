/**
 * Integration test for nametag registration and resolution
 * Tests the full cycle: publishIdentityBinding -> resolveNametag
 *
 * Key behavior (matching nostr-js-sdk):
 * - publishIdentityBinding delegates to nostrClient.publishNametagBinding
 * - resolveNametag delegates to nostrClient.queryPubkeyByNametag (first-seen-wins)
 *
 * Uses NostrClient module-level mock since NostrTransportProvider
 * delegates WebSocket management to NostrClient.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// =============================================================================
// Mock relay event store (simulates relay behavior at NostrClient level)
// =============================================================================

interface StoredEvent {
  id: string;
  kind: number;
  content: string;
  tags: string[][];
  pubkey: string;
  created_at: number;
  sig: string;
}

const relayEventStore: StoredEvent[] = [];

function clearRelayStore(): void {
  relayEventStore.length = 0;
}

function matchesFilter(event: StoredEvent, filter: Record<string, unknown>): boolean {
  // Check kinds
  if (filter.kinds && !(filter.kinds as number[]).includes(event.kind)) {
    return false;
  }

  // Check #t tag
  if (filter['#t']) {
    const tTags = event.tags.filter((t) => t[0] === 't').map((t) => t[1]);
    if (!(filter['#t'] as string[]).some((v) => tTags.includes(v))) {
      return false;
    }
  }

  // Check #d tag
  if (filter['#d']) {
    const dTags = event.tags.filter((t) => t[0] === 'd').map((t) => t[1]);
    if (!(filter['#d'] as string[]).some((v) => dTags.includes(v))) {
      return false;
    }
  }

  // Check authors
  if (filter.authors) {
    if (!(filter.authors as string[]).includes(event.pubkey)) {
      return false;
    }
  }

  return true;
}

// =============================================================================
// Mock NostrClient
// =============================================================================

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn();
const mockIsConnected = vi.fn().mockReturnValue(true);
const mockGetConnectedRelays = vi.fn().mockReturnValue(new Set(['wss://mock-relay.test']));
const mockAddConnectionListener = vi.fn();
const mockUnsubscribe = vi.fn();

// publishEvent stores the event in the relay store (roundtrip behavior)
const mockPublishEvent = vi.fn().mockImplementation(async (event: unknown) => {
  relayEventStore.push(event as StoredEvent);
  return 'mock-event-id';
});

// subscribe returns matching events from the relay store
const mockSubscribe = vi.fn().mockImplementation((filter: unknown, callbacks: {
  onEvent?: (event: unknown) => void;
  onEndOfStoredEvents?: () => void;
  onError?: (subId: string, error: string) => void;
}) => {
  const subId = 'sub-' + Math.random().toString(36).slice(2, 8);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filterObj = typeof (filter as any).toJSON === 'function'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? (filter as any).toJSON()
    : filter as Record<string, unknown>;

  // Find matching events in the store
  const matching = relayEventStore.filter((e) => matchesFilter(e, filterObj));
  const limit = (filterObj.limit as number) || 10;

  // Deliver events and EOSE asynchronously
  setTimeout(() => {
    for (const event of matching.slice(0, limit)) {
      callbacks.onEvent?.(event);
    }
    callbacks.onEndOfStoredEvents?.();
  }, 5);

  return subId;
});

// publishNametagBinding: simulates nostr-js-sdk conflict detection
const mockPublishNametagBinding = vi.fn().mockImplementation(
  async (nametagId: string, _address: string, _identity?: unknown) => {
    const { hashNametag: ht } = await import('@unicitylabs/nostr-js-sdk');
    const hashedNametag = ht(nametagId);

    // Check for existing binding by different pubkey (first-seen-wins)
    const existing = relayEventStore.find((e) => {
      const tTag = e.tags.find((t) => t[0] === 't');
      return tTag && tTag[1] === hashedNametag;
    });

    if (existing) {
      // Check if it's a different author — reject
      const nostrPubkey = mockNostrPubkey;
      if (existing.pubkey !== nostrPubkey) {
        return false;
      }
    }

    // Store event (simulating what nostr-js-sdk does)
    const event: StoredEvent = {
      id: 'event_' + Math.random().toString(36).slice(2),
      kind: 30078,
      content: JSON.stringify({
        nametag_hash: hashedNametag,
        address: mockNostrPubkey,
        verified: Date.now(),
      }),
      tags: [
        ['d', hashedNametag],
        ['t', hashedNametag],
      ],
      pubkey: mockNostrPubkey,
      created_at: Math.floor(Date.now() / 1000),
      sig: 'mock-sig',
    };
    relayEventStore.push(event);
    return true;
  }
);

// queryPubkeyByNametag: first-seen-wins lookup
const mockQueryPubkeyByNametag = vi.fn().mockImplementation(async (nametagId: string) => {
  const { hashNametag: ht } = await import('@unicitylabs/nostr-js-sdk');
  const hashedNametag = ht(nametagId);

  const matching = relayEventStore.filter((e) => {
    const tTag = e.tags.find((t) => t[0] === 't');
    return tTag && tTag[1] === hashedNametag;
  });

  if (matching.length === 0) return null;

  // First-seen-wins: earliest created_at
  matching.sort((a, b) => a.created_at - b.created_at);
  return matching[0].pubkey;
});

let mockNostrPubkey = '';

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
      publishNametagBinding: mockPublishNametagBinding,
      queryPubkeyByNametag: mockQueryPubkeyByNametag,
      queryBindingByNametag: vi.fn().mockResolvedValue(null),
      queryBindingByAddress: vi.fn().mockResolvedValue(null),
    })),
  };
});

// Import after mock is set up
const { NostrTransportProvider } = await import('../../transport/NostrTransportProvider');
const { hashNametag } = await import('@unicitylabs/nostr-js-sdk');
type WebSocketFactory = import('../../transport/websocket').WebSocketFactory;

// =============================================================================
// Test Identity
// =============================================================================

const TEST_IDENTITY = {
  privateKey: 'a'.repeat(64),
  publicKey: 'b'.repeat(64), // This is NOT used by publishIdentityBinding
  address: 'alpha1testaddress',
  chainPubkey: '02' + 'b'.repeat(64),
  l1Address: 'alpha1testaddress',
  directAddress: 'DIRECT://testdirectaddress',
  ipnsName: '12D3KooWtest',
  nametag: undefined,
};

// =============================================================================
// Tests
// =============================================================================

describe('Nametag roundtrip integration', () => {
  let provider: InstanceType<typeof NostrTransportProvider>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearRelayStore();

    provider = new NostrTransportProvider({
      relays: ['wss://mock-relay.test'],
      createWebSocket: (() => {}) as WebSocketFactory,
      timeout: 1000,
      autoReconnect: false,
    });
  });

  afterEach(async () => {
    await provider.disconnect();
  });

  it('should publish identity binding with nametag via nostr-js-sdk', async () => {
    provider.setIdentity(TEST_IDENTITY);
    await provider.connect();
    mockNostrPubkey = provider.getNostrPubkey();

    const nametag = 'test-lottery';

    const result = await provider.publishIdentityBinding(
      TEST_IDENTITY.chainPubkey,
      TEST_IDENTITY.l1Address,
      TEST_IDENTITY.directAddress!,
      nametag,
    );
    expect(result).toBe(true);

    // publishNametagBinding was called on the NostrClient
    expect(mockPublishNametagBinding).toHaveBeenCalledWith(
      nametag,
      expect.any(String),
      expect.objectContaining({
        publicKey: TEST_IDENTITY.chainPubkey,
        l1Address: TEST_IDENTITY.l1Address,
        directAddress: TEST_IDENTITY.directAddress,
      }),
    );
  });

  it('should resolve nametag returning event.pubkey (the signer)', async () => {
    provider.setIdentity(TEST_IDENTITY);
    await provider.connect();
    mockNostrPubkey = provider.getNostrPubkey();

    const nametag = 'resolve-test';

    // Publish first
    await provider.publishIdentityBinding(
      TEST_IDENTITY.chainPubkey,
      TEST_IDENTITY.l1Address,
      TEST_IDENTITY.directAddress!,
      nametag,
    );

    // resolveNametag should return event.pubkey (the signer)
    const resolved = await provider.resolveNametag(nametag);
    expect(resolved).toBe(provider.getNostrPubkey());
  });

  it('should return null for non-existent nametag', async () => {
    provider.setIdentity(TEST_IDENTITY);
    await provider.connect();

    const resolvedPubkey = await provider.resolveNametag('non-existent');
    expect(resolvedPubkey).toBeNull();
  });

  it('should allow re-publication by same pubkey', async () => {
    provider.setIdentity(TEST_IDENTITY);
    await provider.connect();
    mockNostrPubkey = provider.getNostrPubkey();

    const nametag = 'republish-test';

    // Publish first time
    const result1 = await provider.publishIdentityBinding(
      TEST_IDENTITY.chainPubkey,
      TEST_IDENTITY.l1Address,
      TEST_IDENTITY.directAddress!,
      nametag,
    );
    expect(result1).toBe(true);

    // Publish second time — should succeed (same pubkey)
    const result2 = await provider.publishIdentityBinding(
      TEST_IDENTITY.chainPubkey,
      TEST_IDENTITY.l1Address,
      TEST_IDENTITY.directAddress!,
      nametag,
    );
    expect(result2).toBe(true);
  });

  it('should reject publication if nametag taken by another pubkey', async () => {
    provider.setIdentity(TEST_IDENTITY);
    await provider.connect();
    mockNostrPubkey = provider.getNostrPubkey();

    const nametag = 'taken-tag';

    // Manually insert an event from "another user" with different pubkey
    const otherPubkey = 'c'.repeat(64);
    const hashedNametag = hashNametag(nametag);

    relayEventStore.push({
      id: 'fake-id',
      kind: 30078,
      content: JSON.stringify({
        nametag_hash: hashedNametag,
        address: otherPubkey,
        verified: Date.now(),
      }),
      tags: [
        ['d', hashedNametag],
        ['t', hashedNametag],
      ],
      pubkey: otherPubkey,
      created_at: Math.floor(Date.now() / 1000),
      sig: 'fake-sig',
    });

    // Try to publish with our identity — should fail
    const result = await provider.publishIdentityBinding(
      TEST_IDENTITY.chainPubkey,
      TEST_IDENTITY.l1Address,
      TEST_IDENTITY.directAddress!,
      nametag,
    );
    expect(result).toBe(false);
  });

  it('should use hashed nametag for privacy', async () => {
    provider.setIdentity(TEST_IDENTITY);
    await provider.connect();
    mockNostrPubkey = provider.getNostrPubkey();

    const nametag = 'my-secret-tag';

    await provider.publishIdentityBinding(
      TEST_IDENTITY.chainPubkey,
      TEST_IDENTITY.l1Address,
      TEST_IDENTITY.directAddress!,
      nametag,
    );

    // publishNametagBinding was called with the raw nametag (nostr-js-sdk handles hashing)
    expect(mockPublishNametagBinding).toHaveBeenCalledWith(
      nametag,
      expect.any(String),
      expect.any(Object),
    );
  });

  it('getNostrPubkey should return 32-byte hex (64 chars)', async () => {
    provider.setIdentity(TEST_IDENTITY);

    const nostrPubkey = provider.getNostrPubkey();

    // Should be 64 hex characters (32 bytes)
    expect(nostrPubkey).toHaveLength(64);
    expect(nostrPubkey).toMatch(/^[0-9a-f]{64}$/);

    // Should NOT have 02/03 prefix (compressed key format)
    expect(nostrPubkey.startsWith('02')).toBe(false);
    expect(nostrPubkey.startsWith('03')).toBe(false);
  });
});
