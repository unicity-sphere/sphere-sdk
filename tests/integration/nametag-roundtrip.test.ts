/**
 * Integration test for nametag registration and resolution
 * Tests the full cycle: register -> resolve
 *
 * Key behavior (matching nostr-js-sdk):
 * - registerNametag uses 32-byte Nostr pubkey from keyManager (not passed publicKey)
 * - resolveNametag returns event.pubkey (the signer), not address tag
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

// Import after mock is set up
const { NostrTransportProvider } = await import('../../transport/NostrTransportProvider');
const { hashNametag } = await import('@unicitylabs/nostr-js-sdk');
type WebSocketFactory = import('../../transport/websocket').WebSocketFactory;

// =============================================================================
// Test Identity
// =============================================================================

const TEST_IDENTITY = {
  privateKey: 'a'.repeat(64),
  publicKey: 'b'.repeat(64), // This is NOT used by registerNametag
  address: 'alpha1testaddress',
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

  it('should register nametag with correct event structure', async () => {
    provider.setIdentity(TEST_IDENTITY);
    await provider.connect();

    const nametag = 'test-lottery';

    // Register nametag
    const registerResult = await provider.registerNametag(
      nametag,
      TEST_IDENTITY.publicKey
    );
    expect(registerResult).toBe(true);

    // Verify event was published
    expect(relayEventStore.length).toBe(1);

    const event = relayEventStore[0];
    expect(event.kind).toBe(30078); // NAMETAG_BINDING (APP_DATA)

    // Check tags include all required fields (matching nostr-js-sdk format)
    const tagNames = event.tags.map((t) => t[0]);
    expect(tagNames).toContain('d'); // Required for parameterized replaceable
    expect(tagNames).toContain('t'); // Indexed tag for relay search

    // Check content is valid JSON with correct structure
    const content = JSON.parse(event.content);
    expect(content).toHaveProperty('nametag_hash');
    expect(content).toHaveProperty('address');
  });

  it('should use 32-byte nostr pubkey from keyManager, not passed publicKey', async () => {
    provider.setIdentity(TEST_IDENTITY);
    await provider.connect();

    const nametag = 'pubkey-test';

    await provider.registerNametag(nametag, TEST_IDENTITY.publicKey);

    const event = relayEventStore[0];

    // Get the actual nostr pubkey used
    const nostrPubkey = provider.getNostrPubkey();

    // Address tag should contain nostrPubkey (from keyManager), NOT TEST_IDENTITY.publicKey
    const addressTag = event.tags.find((t) => t[0] === 'address');
    expect(addressTag?.[1]).toBe(nostrPubkey);
    expect(addressTag?.[1]).not.toBe(TEST_IDENTITY.publicKey);

    // Content should also use nostrPubkey
    const content = JSON.parse(event.content);
    expect(content.address).toBe(nostrPubkey);

    // event.pubkey is the signer - should match nostrPubkey
    expect(event.pubkey).toBe(nostrPubkey);
  });

  it('should resolve nametag returning event.pubkey (the signer)', async () => {
    provider.setIdentity(TEST_IDENTITY);
    await provider.connect();

    const nametag = 'resolve-test';

    // Register first (stores event in relay store)
    await provider.registerNametag(nametag, TEST_IDENTITY.publicKey);

    const event = relayEventStore[0];

    // resolveNametag should return event.pubkey (the signer)
    const resolved = await provider.resolveNametag(nametag);
    expect(resolved).toBe(event.pubkey);

    // This should be the nostr pubkey from keyManager
    expect(resolved).toBe(provider.getNostrPubkey());
  });

  it('should return null for non-existent nametag', async () => {
    provider.setIdentity(TEST_IDENTITY);
    await provider.connect();

    const resolvedPubkey = await provider.resolveNametag('non-existent');
    expect(resolvedPubkey).toBeNull();
  });

  it('should allow re-registration by same pubkey (republish with correct format)', async () => {
    provider.setIdentity(TEST_IDENTITY);
    await provider.connect();

    const nametag = 'republish-test';
    const nostrPubkey = provider.getNostrPubkey();

    // Register first time
    const result1 = await provider.registerNametag(
      nametag,
      TEST_IDENTITY.publicKey
    );
    expect(result1).toBe(true);

    // Register second time - should succeed and republish
    const result2 = await provider.registerNametag(
      nametag,
      TEST_IDENTITY.publicKey
    );
    expect(result2).toBe(true);

    // Two events stored (always republishes to ensure correct format)
    expect(relayEventStore.length).toBe(2);

    // Both events have same pubkey
    expect(relayEventStore[0].pubkey).toBe(nostrPubkey);
    expect(relayEventStore[1].pubkey).toBe(nostrPubkey);
  });

  it('should reject registration if nametag taken by another pubkey', async () => {
    provider.setIdentity(TEST_IDENTITY);
    await provider.connect();

    const nametag = 'taken-tag';

    // Manually insert an event from "another user" with different pubkey
    const otherPubkey = 'c'.repeat(64);
    const hashedNametag = hashNametag(nametag);

    // Simulate event from another user already in relay store
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
        ['nametag', hashedNametag],
        ['address', otherPubkey],
      ],
      pubkey: otherPubkey, // Different pubkey (the signer)
      created_at: Math.floor(Date.now() / 1000),
      sig: 'fake-sig',
    });

    // Try to register with our identity - should fail
    const result = await provider.registerNametag(
      nametag,
      TEST_IDENTITY.publicKey
    );
    expect(result).toBe(false);

    // No new events added (still just the fake one)
    expect(relayEventStore.length).toBe(1);
  });

  it('should query by #t tag first (nostr-js-sdk format)', async () => {
    provider.setIdentity(TEST_IDENTITY);
    await provider.connect();

    const nametag = 't-tag-test';

    await provider.registerNametag(nametag, TEST_IDENTITY.publicKey);

    // Event should have 't' tag for indexed search
    const event = relayEventStore[0];
    const tTag = event.tags.find((t) => t[0] === 't');
    expect(tTag).toBeDefined();

    // Resolution should work via #t tag query
    const resolved = await provider.resolveNametag(nametag);
    expect(resolved).toBe(event.pubkey);
  });

  it('should use hashed nametag for privacy', async () => {
    provider.setIdentity(TEST_IDENTITY);
    await provider.connect();

    const nametag = 'my-secret-tag';

    await provider.registerNametag(nametag, TEST_IDENTITY.publicKey);

    const event = relayEventStore[0];

    // Raw nametag should NOT appear anywhere in the event
    const eventStr = JSON.stringify(event);
    expect(eventStr).not.toContain(nametag);

    // But hashed version should be in tags
    const hashedNametag = hashNametag(nametag);
    expect(eventStr).toContain(hashedNametag);
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
