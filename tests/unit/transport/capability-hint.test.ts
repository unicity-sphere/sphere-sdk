/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * T.8.B — Capability hint surfacing in identity binding events.
 *
 * The publishing peer SHOULD encode `wire_protocols` and `asset_kinds`
 * arrays in the JSON content of its identity binding event (kind 30078).
 * The reading peer SHOULD surface those hints on `PeerInfo` so senders
 * can detect protocol mismatches BEFORE shipping a UXF bundle.
 *
 * Spec refs: §10.4 (capability hints — informational only).
 *
 * NOTE: assetKinds-absent forward-compatibility (W20) lives in a sibling
 * test file: `assetkinds-absent-forward-compat.test.ts`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NOSTR_EVENT_KINDS } from '../../../constants';

// =============================================================================
// Mock NostrClient (mirrors NostrTransportProvider.nametag.test.ts pattern)
// =============================================================================

const storedQueryEvents: Map<string, unknown[]> = new Map();
const publishedEvents: unknown[] = [];

function filterKey(filter: Record<string, unknown>): string {
  if (filter['#t']) return `nametag:${(filter['#t'] as string[])[0]}`;
  if (filter['#d']) return `nametag:${(filter['#d'] as string[])[0]}`;
  if (filter.authors) return `author:${(filter.authors as string[])[0]}`;
  return `kinds:${(filter.kinds as number[])?.join(',')}`;
}

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn();
const mockIsConnected = vi.fn().mockReturnValue(true);
const mockGetConnectedRelays = vi.fn().mockReturnValue(new Set(['wss://test.relay']));
const mockAddConnectionListener = vi.fn();
const mockUnsubscribe = vi.fn();
const mockPublishEvent = vi.fn().mockImplementation(async (event: unknown) => {
  publishedEvents.push(event);
  return 'mock-event-id';
});

const mockSubscribe = vi.fn().mockImplementation((filter: unknown, callbacks: {
  onEvent?: (event: unknown) => void;
  onEndOfStoredEvents?: () => void;
  onError?: (subId: string, error: string) => void;
}) => {
  const subId = 'sub-' + Math.random().toString(36).slice(2, 8);
  const filterObj = typeof (filter as any).toJSON === 'function'
    ? (filter as any).toJSON()
    : filter as Record<string, unknown>;
  const key = filterKey(filterObj);
  const events = storedQueryEvents.get(key) || [];
  setTimeout(() => {
    for (const event of events) {
      callbacks.onEvent?.(event);
    }
    callbacks.onEndOfStoredEvents?.();
  }, 5);
  return subId;
});

const mockQueryBindingByNametag = vi.fn().mockResolvedValue(null);
const mockQueryBindingByAddress = vi.fn().mockResolvedValue(null);

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
      queryBindingByNametag: mockQueryBindingByNametag,
      queryBindingByAddress: mockQueryBindingByAddress,
      queryPubkeyByNametag: vi.fn().mockResolvedValue(null),
      publishNametagBinding: vi.fn().mockResolvedValue(true),
      publishIdentityBinding: vi.fn().mockResolvedValue(true),
    })),
  };
});

const { NostrTransportProvider } = await import('../../../transport/NostrTransportProvider');
const { SUPPORTED_WIRE_PROTOCOLS, SUPPORTED_ASSET_KINDS } =
  await import('../../../transport/transport-provider');
type WebSocketFactory = import('../../../transport/websocket').WebSocketFactory;

const TEST_PRIVATE_KEY = 'a'.repeat(64);
const TEST_COMPRESSED_PUBKEY = '02' + 'b'.repeat(64);
const TEST_L1_ADDRESS = 'alpha1testaddress123';
const TEST_DIRECT_ADDRESS = 'DIRECT://testdirectaddress';
const PEER_NOSTR_PUBKEY = 'c'.repeat(64);

function createProvider(): InstanceType<typeof NostrTransportProvider> {
  return new NostrTransportProvider({
    relays: ['wss://test.relay'],
    createWebSocket: (() => {}) as WebSocketFactory,
    timeout: 1000,
    autoReconnect: false,
  });
}

function setupIdentity(provider: InstanceType<typeof NostrTransportProvider>) {
  provider.setIdentity({
    privateKey: TEST_PRIVATE_KEY,
    chainPubkey: TEST_COMPRESSED_PUBKEY,
    l1Address: TEST_L1_ADDRESS,
    directAddress: TEST_DIRECT_ADDRESS,
  });
}

// Build a binding event whose content carries any capability hints we want
// to test against. Fields omitted from `options` are omitted from the JSON
// content — that's how W20's "assetKinds absent" case is encoded.
function buildBindingEvent(options: {
  pubkey: string;
  publicKey?: string;
  l1Address?: string;
  directAddress?: string;
  wireProtocols?: ReadonlyArray<string>;
  assetKinds?: ReadonlyArray<string>;
  timestamp?: number;
}): unknown {
  const content: Record<string, unknown> = {};
  if (options.publicKey) content.public_key = options.publicKey;
  if (options.l1Address) content.l1_address = options.l1Address;
  if (options.directAddress) content.direct_address = options.directAddress;
  if (options.wireProtocols !== undefined) content.wire_protocols = options.wireProtocols;
  if (options.assetKinds !== undefined) content.asset_kinds = options.assetKinds;

  return {
    id: 'event_' + Math.random().toString(36).slice(2),
    pubkey: options.pubkey,
    created_at: options.timestamp ?? Math.floor(Date.now() / 1000),
    kind: NOSTR_EVENT_KINDS.NAMETAG_BINDING,
    tags: [
      ['d', 'mock-d-tag'],
    ],
    content: JSON.stringify(content),
    sig: 'mocksignature',
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('T.8.B — capability hint surfacing in identity binding events', () => {
  let provider: InstanceType<typeof NostrTransportProvider>;

  beforeEach(() => {
    vi.clearAllMocks();
    storedQueryEvents.clear();
    publishedEvents.length = 0;
    mockIsConnected.mockReturnValue(true);
    provider = createProvider();
    setupIdentity(provider);
  });

  describe('publish: identity binding event encodes capability hints', () => {
    it('emits wire_protocols=[uxf-car, uxf-cid, txf] and asset_kinds=[coin, nft] (no-nametag path)', async () => {
      await provider.connect();

      const success = await provider.publishIdentityBinding(
        TEST_COMPRESSED_PUBKEY, TEST_L1_ADDRESS, TEST_DIRECT_ADDRESS,
      );

      expect(success).toBe(true);
      // Exactly one event published in the no-nametag path.
      expect(publishedEvents.length).toBe(1);

      const event = publishedEvents[0] as { kind: number; content: string };
      expect(event.kind).toBe(NOSTR_EVENT_KINDS.NAMETAG_BINDING);

      const content = JSON.parse(event.content) as Record<string, unknown>;
      expect(content.wire_protocols).toEqual(['uxf-car', 'uxf-cid', 'txf']);
      expect(content.asset_kinds).toEqual(['coin', 'nft']);
      // And the canonical address fields stay alongside.
      expect(content.public_key).toBe(TEST_COMPRESSED_PUBKEY);
      expect(content.l1_address).toBe(TEST_L1_ADDRESS);
      expect(content.direct_address).toBe(TEST_DIRECT_ADDRESS);
    });

    it('still emits an identity binding with capabilities when a nametag is supplied', async () => {
      await provider.connect();

      // The nametag path delegates to nostr-js-sdk for the nametag-specific
      // event AND additionally publishes the no-nametag capability binding.
      const success = await provider.publishIdentityBinding(
        TEST_COMPRESSED_PUBKEY, TEST_L1_ADDRESS, TEST_DIRECT_ADDRESS, 'alice',
      );
      expect(success).toBe(true);

      // Find the locally-published event (the upstream's nametag binding
      // goes through `nostrClient.publishNametagBinding`, NOT publishEvent).
      expect(publishedEvents.length).toBe(1);
      const event = publishedEvents[0] as { kind: number; content: string };
      const content = JSON.parse(event.content) as Record<string, unknown>;
      expect(content.wire_protocols).toEqual(['uxf-car', 'uxf-cid', 'txf']);
      expect(content.asset_kinds).toEqual(['coin', 'nft']);
    });

    it('preserves nametag + proxy_address on the per-pubkey capability binding', async () => {
      // Regression guard: without this, `resolveTransportPubkeyInfo`
      // (most-recent-author wins) would return `nametag: undefined` after
      // the capability binding lands AFTER the nametag binding for the
      // same author.
      await provider.connect();
      await provider.publishIdentityBinding(
        TEST_COMPRESSED_PUBKEY, TEST_L1_ADDRESS, TEST_DIRECT_ADDRESS, 'alice',
      );

      expect(publishedEvents.length).toBe(1);
      const event = publishedEvents[0] as { content: string };
      const content = JSON.parse(event.content) as Record<string, unknown>;
      expect(content.nametag).toBe('alice');
      // proxy_address is computed from the nametag — must be a non-empty string.
      expect(typeof content.proxy_address).toBe('string');
      expect((content.proxy_address as string).length).toBeGreaterThan(0);
    });

    it('exposes SUPPORTED_WIRE_PROTOCOLS / SUPPORTED_ASSET_KINDS as the canonical v1.0 set', () => {
      // The published event's content MUST mirror these constants — keep
      // the constants and the wire field aligned at the type level.
      expect(SUPPORTED_WIRE_PROTOCOLS).toEqual(['uxf-car', 'uxf-cid', 'txf']);
      expect(SUPPORTED_ASSET_KINDS).toEqual(['coin', 'nft']);
    });
  });

  describe('read: PeerInfo carries capability hints when present in the event content', () => {
    it('resolveTransportPubkeyInfo returns wireProtocols + assetKinds when the event has both', async () => {
      await provider.connect();

      const event = buildBindingEvent({
        pubkey: PEER_NOSTR_PUBKEY,
        publicKey: '02' + 'd'.repeat(64),
        l1Address: 'alpha1peeraddr',
        directAddress: 'DIRECT://peer',
        wireProtocols: ['uxf-car', 'uxf-cid', 'txf'],
        assetKinds: ['coin', 'nft'],
      });
      storedQueryEvents.set(`author:${PEER_NOSTR_PUBKEY}`, [event]);

      const peerInfo = await provider.resolveTransportPubkeyInfo(PEER_NOSTR_PUBKEY);
      expect(peerInfo).not.toBeNull();
      expect(peerInfo!.wireProtocols).toEqual(['uxf-car', 'uxf-cid', 'txf']);
      expect(peerInfo!.assetKinds).toEqual(['coin', 'nft']);
    });

    it('preserves the empty-array case (peer present but explicitly empty) — distinct from absent', async () => {
      await provider.connect();
      const event = buildBindingEvent({
        pubkey: PEER_NOSTR_PUBKEY,
        publicKey: '02' + 'e'.repeat(64),
        wireProtocols: [],
        assetKinds: [],
      });
      storedQueryEvents.set(`author:${PEER_NOSTR_PUBKEY}`, [event]);

      const peerInfo = await provider.resolveTransportPubkeyInfo(PEER_NOSTR_PUBKEY);
      expect(peerInfo).not.toBeNull();
      // Empty array is a non-default explicit signal — must surface as-is.
      expect(peerInfo!.wireProtocols).toEqual([]);
      expect(peerInfo!.assetKinds).toEqual([]);
    });

    it('discoverAddresses populates capability hints per-author', async () => {
      await provider.connect();

      const peer1Pubkey = 'aa' + 'a'.repeat(62);
      const peer2Pubkey = 'bb' + 'b'.repeat(62);
      const event1 = buildBindingEvent({
        pubkey: peer1Pubkey,
        publicKey: '02' + 'a'.repeat(64),
        wireProtocols: ['uxf-car'],
        assetKinds: ['coin'],
      });
      const event2 = buildBindingEvent({
        pubkey: peer2Pubkey,
        publicKey: '02' + 'b'.repeat(64),
        wireProtocols: ['uxf-car', 'uxf-cid', 'txf'],
        assetKinds: ['coin', 'nft'],
      });
      // discoverAddresses uses `authors: [peer1, peer2]`. Our filterKey
      // mock returns `author:<authors[0]>`, so seed under that key. Both
      // events are delivered for that single subscription — the receiver
      // groups them by author.pubkey.
      storedQueryEvents.set(`author:${peer1Pubkey}`, [event1, event2]);

      const peerInfos = await provider.discoverAddresses([peer1Pubkey, peer2Pubkey]);
      expect(peerInfos.length).toBe(2);

      const byPubkey = new Map(peerInfos.map(p => [p.transportPubkey, p]));
      expect(byPubkey.get(peer1Pubkey)?.wireProtocols).toEqual(['uxf-car']);
      expect(byPubkey.get(peer1Pubkey)?.assetKinds).toEqual(['coin']);
      expect(byPubkey.get(peer2Pubkey)?.wireProtocols).toEqual(['uxf-car', 'uxf-cid', 'txf']);
      expect(byPubkey.get(peer2Pubkey)?.assetKinds).toEqual(['coin', 'nft']);
    });

    it('drops non-string entries from the wire arrays (defense against malformed events)', async () => {
      await provider.connect();
      const event = buildBindingEvent({
        pubkey: PEER_NOSTR_PUBKEY,
        wireProtocols: ['uxf-car', 42 as unknown as string, null as unknown as string, 'txf'],
        assetKinds: ['coin', { junk: true } as unknown as string],
      });
      storedQueryEvents.set(`author:${PEER_NOSTR_PUBKEY}`, [event]);

      const peerInfo = await provider.resolveTransportPubkeyInfo(PEER_NOSTR_PUBKEY);
      expect(peerInfo!.wireProtocols).toEqual(['uxf-car', 'txf']);
      expect(peerInfo!.assetKinds).toEqual(['coin']);
    });
  });
});
