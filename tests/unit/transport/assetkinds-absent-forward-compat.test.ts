/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * T.8.B / W20 — assetKinds-absent forward-compatibility.
 *
 * Per UXF §10.4: when a binding event is SILENT about `asset_kinds`,
 * receivers MUST treat the peer as a v1.0 coin-only wallet. Concretely:
 *
 *   - Reading: PeerInfo.assetKinds is `undefined` (we do NOT synthesise
 *     a `['coin']` array on read — the absence carries information and
 *     the W20 default is applied at the consumption site, not at parse).
 *   - Consumption (PaymentsModule.maybeEmitCapabilityWarning): when
 *     `peerInfo.assetKinds === undefined`, fall back to `['coin']`.
 *     An outbound NFT entry then triggers `transfer:capability-warning`.
 *
 * This test pins both halves of the contract so future refactors don't
 * accidentally collapse "absent" and "empty" into the same shape.
 *
 * Spec refs: §10.4 (W20 — assetKinds absent ⇒ assume ['coin']).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NOSTR_EVENT_KINDS } from '../../../constants';

// =============================================================================
// Mock NostrClient — same pattern as capability-hint.test.ts
// =============================================================================

const storedQueryEvents: Map<string, unknown[]> = new Map();
const publishedEvents: unknown[] = [];

function filterKey(filter: Record<string, unknown>): string {
  if (filter['#t']) return `nametag:${(filter['#t'] as string[])[0]}`;
  if (filter.authors) return `author:${(filter.authors as string[])[0]}`;
  return `kinds:${(filter.kinds as number[])?.join(',')}`;
}

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockIsConnected = vi.fn().mockReturnValue(true);
const mockGetConnectedRelays = vi.fn().mockReturnValue(new Set(['wss://test.relay']));
const mockAddConnectionListener = vi.fn();

const mockSubscribe = vi.fn().mockImplementation((filter: unknown, callbacks: {
  onEvent?: (event: unknown) => void;
  onEndOfStoredEvents?: () => void;
}) => {
  const subId = 'sub-' + Math.random().toString(36).slice(2, 8);
  const filterObj = typeof (filter as any).toJSON === 'function'
    ? (filter as any).toJSON()
    : filter as Record<string, unknown>;
  const key = filterKey(filterObj);
  const events = storedQueryEvents.get(key) || [];
  setTimeout(() => {
    for (const event of events) callbacks.onEvent?.(event);
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
      disconnect: vi.fn(),
      isConnected: mockIsConnected,
      getConnectedRelays: mockGetConnectedRelays,
      subscribe: mockSubscribe,
      unsubscribe: vi.fn(),
      publishEvent: vi.fn().mockImplementation(async (event: unknown) => {
        publishedEvents.push(event); return 'mock-event-id';
      }),
      addConnectionListener: mockAddConnectionListener,
      queryBindingByNametag: vi.fn().mockResolvedValue(null),
      queryBindingByAddress: vi.fn().mockResolvedValue(null),
      queryPubkeyByNametag: vi.fn().mockResolvedValue(null),
      publishNametagBinding: vi.fn().mockResolvedValue(true),
      publishIdentityBinding: vi.fn().mockResolvedValue(true),
    })),
  };
});

const { NostrTransportProvider } = await import('../../../transport/NostrTransportProvider');
const { DEFAULT_ASSET_KINDS_WHEN_ABSENT } =
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
    directAddress: TEST_DIRECT_ADDRESS,
  });
}

function buildBindingEvent(content: Record<string, unknown>, pubkey: string): unknown {
  return {
    id: 'event_' + Math.random().toString(36).slice(2),
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    kind: NOSTR_EVENT_KINDS.NAMETAG_BINDING,
    tags: [['d', 'mock-d-tag']],
    content: JSON.stringify(content),
    sig: 'mocksignature',
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('T.8.B / W20 — assetKinds absent ⇒ assume [coin]', () => {
  let provider: InstanceType<typeof NostrTransportProvider>;

  beforeEach(() => {
    vi.clearAllMocks();
    storedQueryEvents.clear();
    publishedEvents.length = 0;
    mockIsConnected.mockReturnValue(true);
    provider = createProvider();
    setupIdentity(provider);
  });

  describe('Read side — PeerInfo.assetKinds remains `undefined` when the wire is silent', () => {
    it('returns assetKinds=undefined when the binding event has no asset_kinds field at all', async () => {
      await provider.connect();

      // Older v1.0 wallet — content has the canonical address fields but
      // no capability hints whatsoever.
      const event = buildBindingEvent({
        public_key: '02' + 'd'.repeat(64),
        l1_address: 'alpha1older',
        direct_address: 'DIRECT://older',
      }, PEER_NOSTR_PUBKEY);
      storedQueryEvents.set(`author:${PEER_NOSTR_PUBKEY}`, [event]);

      const peerInfo = await provider.resolveTransportPubkeyInfo(PEER_NOSTR_PUBKEY);
      expect(peerInfo).not.toBeNull();
      // CRITICAL: absent on the wire → undefined on PeerInfo (not [coin]).
      // The W20 default is applied by the CONSUMER (PaymentsModule), not
      // the parser. This preserves the absent-vs-empty distinction.
      expect(peerInfo!.assetKinds).toBeUndefined();
      expect(peerInfo!.wireProtocols).toBeUndefined();
    });

    it('returns assetKinds=undefined when the field is non-array (defensive parsing)', async () => {
      await provider.connect();
      const event = buildBindingEvent({
        public_key: '02' + 'd'.repeat(64),
        // Malformed — string instead of array. Treat as absent.
        asset_kinds: 'coin' as unknown,
      } as Record<string, unknown>, PEER_NOSTR_PUBKEY);
      storedQueryEvents.set(`author:${PEER_NOSTR_PUBKEY}`, [event]);

      const peerInfo = await provider.resolveTransportPubkeyInfo(PEER_NOSTR_PUBKEY);
      expect(peerInfo!.assetKinds).toBeUndefined();
    });
  });

  describe('Forward-compat default constant', () => {
    it('exposes DEFAULT_ASSET_KINDS_WHEN_ABSENT = ["coin"]', () => {
      // Pinning the W20 default at the constant layer so consumers can
      // opt in without re-deriving the rule from the spec text.
      expect(DEFAULT_ASSET_KINDS_WHEN_ABSENT).toEqual(['coin']);
    });
  });

  describe('Consumer behaviour — older peer (assetKinds absent) + outbound NFT triggers warning', () => {
    // The actual consumer-side check lives in PaymentsModule
    // (see tests/unit/payments/capability-warning.test.ts). Here we just
    // pin the read-side semantics: a binding event WITHOUT asset_kinds is
    // distinguishable from one WITH `asset_kinds: []` and from one WITH
    // `asset_kinds: ['coin', 'nft']`. The downstream consumer applies the
    // W20 default; this test confirms the parser preserves the signal so
    // the consumer CAN apply it.
    it('older event vs explicit-empty event vs full-capability event are all distinguishable', async () => {
      await provider.connect();

      const olderPubkey = '11' + '1'.repeat(62);
      const explicitEmptyPubkey = '22' + '2'.repeat(62);
      const fullCapPubkey = '33' + '3'.repeat(62);

      // 1. Older peer — no capability fields at all.
      storedQueryEvents.set(`author:${olderPubkey}`, [
        buildBindingEvent({
          public_key: '02' + 'a'.repeat(64),
          direct_address: 'DIRECT://older',
        }, olderPubkey),
      ]);

      // 2. Explicit-empty — capability fields present but empty arrays.
      storedQueryEvents.set(`author:${explicitEmptyPubkey}`, [
        buildBindingEvent({
          public_key: '02' + 'b'.repeat(64),
          direct_address: 'DIRECT://explicit-empty',
          wire_protocols: [],
          asset_kinds: [],
        }, explicitEmptyPubkey),
      ]);

      // 3. Full capability — both arrays populated with the v1.0 set.
      storedQueryEvents.set(`author:${fullCapPubkey}`, [
        buildBindingEvent({
          public_key: '02' + 'c'.repeat(64),
          direct_address: 'DIRECT://full',
          wire_protocols: ['uxf-car', 'uxf-cid', 'txf'],
          asset_kinds: ['coin', 'nft'],
        }, fullCapPubkey),
      ]);

      const olderInfo = await provider.resolveTransportPubkeyInfo(olderPubkey);
      const explicitEmptyInfo = await provider.resolveTransportPubkeyInfo(explicitEmptyPubkey);
      const fullCapInfo = await provider.resolveTransportPubkeyInfo(fullCapPubkey);

      // Three distinct shapes — undefined, [], full.
      expect(olderInfo!.assetKinds).toBeUndefined();
      expect(explicitEmptyInfo!.assetKinds).toEqual([]);
      expect(fullCapInfo!.assetKinds).toEqual(['coin', 'nft']);

      expect(olderInfo!.wireProtocols).toBeUndefined();
      expect(explicitEmptyInfo!.wireProtocols).toEqual([]);
      expect(fullCapInfo!.wireProtocols).toEqual(['uxf-car', 'uxf-cid', 'txf']);
    });
  });
});
