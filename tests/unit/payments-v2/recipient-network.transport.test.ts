// §5.6 cross-network recipient gate, driven from the RELAY (#733/#734).
//
// Every other test of this gate hands the facade an already-populated
// `PeerInfo`/`RecipientInfo`, which is the same hollowness the gate itself had:
// it proves the comparison, never the production path that must produce the
// value. Here a fake nostr client serves RAW signed binding events, a real
// NostrTransportProvider resolves them, the production `resolveRecipientInfo`
// converts, and the production gate decides — per identifier route.
//
// The routes do NOT have the same capability, and that asymmetry is the point:
//   - transport pubkey (64-hex): sphere parses the signed event itself, so a
//     declared network IS read and a foreign one IS refused, end to end.
//   - `@nametag` / `DIRECT://`: resolution goes through nostr-js-sdk's
//     `queryBindingBy*`, whose `parseBindingInfo` whitelists the content fields
//     and never hands back the selected event — the declaration is dropped
//     before sphere can see it, so the gate can only SIGNAL. That limitation is
//     PINNED below (with upstream's real parser doing the dropping), not
//     assumed; the pins go red the day #734 lands, which is when
//     `bindingInfoToPeerInfo` must start carrying the field.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NOSTR_EVENT_KINDS } from '../../../constants';
import { ATTENTION_RECIPIENT_NETWORK_UNVERIFIED } from '../../../modules/payments-v2/PaymentsFacade';
import type { PeerInfo } from '../../../transport';
import type { WebSocketFactory } from '../../../transport/websocket';
import { COIN, NET, PEER_PUB, cleanupWorlds, eventsOf, makeWorld } from './facade-harness';

// =============================================================================
// Fake relay: raw signed binding events, indexed the three ways resolution asks
// =============================================================================

interface RawEvent {
  id: string;
  kind: number;
  content: string;
  tags: string[][];
  pubkey: string;
  created_at: number;
  sig: string;
}

const fake = vi.hoisted(() => ({
  events: [] as {
    id: string;
    kind: number;
    content: string;
    tags: string[][];
    pubkey: string;
    created_at: number;
    sig: string;
  }[],
  byNametag: new Map<string, unknown>(),
  byAddress: new Map<string, unknown>(),
}));

vi.mock('@unicitylabs/nostr-js-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@unicitylabs/nostr-js-sdk')>();
  const filterOf = (filter: unknown): Record<string, unknown> =>
    typeof (filter as { toJSON?: () => Record<string, unknown> }).toJSON === 'function'
      ? (filter as { toJSON: () => Record<string, unknown> }).toJSON()
      : (filter as Record<string, unknown>);
  return {
    ...actual,
    NostrClient: vi.fn().mockImplementation(() => ({
      connect: async () => undefined,
      disconnect: () => undefined,
      isConnected: () => true,
      getConnectedRelays: () => new Set(['wss://fake.relay']),
      addConnectionListener: () => undefined,
      removeConnectionListener: () => undefined,
      publishEvent: async () => 'fake-event-id',
      getQueryTimeout: () => 20000,
      setQueryTimeout: () => undefined,
      unsubscribe: () => undefined,
      // Raw REQ: authors-filtered stored events, then EOSE — what
      // resolveTransportPubkeyInfo/discoverAddresses read.
      subscribe: (...args: unknown[]) => {
        const [filter, listener] = (
          typeof args[0] === 'string' ? args.slice(1) : args
        ) as [unknown, { onEvent?: (e: unknown) => void; onEndOfStoredEvents?: (id: string) => void }];
        const authors = filterOf(filter).authors as string[] | undefined;
        setTimeout(() => {
          if (authors) {
            for (const event of fake.events) {
              if (authors.includes(event.pubkey)) listener.onEvent?.(event);
            }
          }
          listener.onEndOfStoredEvents?.('fake-sub');
        }, 0);
        return 'fake-sub';
      },
      // The two SDK-parsed routes: resolution picks the owner's event and hands
      // back ONLY `parseBindingInfo`'s whitelist — upstream's REAL parser here,
      // so what it drops is upstream's behaviour, not this fake's.
      queryBindingByNametag: async (nametag: string) => {
        const event = fake.byNametag.get(nametag);
        return event ? actual.parseBindingInfo(event as Parameters<typeof actual.parseBindingInfo>[0]) : null;
      },
      queryBindingByAddress: async (address: string) => {
        const event = fake.byAddress.get(address);
        return event ? actual.parseBindingInfo(event as Parameters<typeof actual.parseBindingInfo>[0]) : null;
      },
      queryPubkeyByNametag: async () => null,
      publishNametagBinding: async () => true,
      publishIdentityBinding: async () => true,
    })),
  };
});

const { NostrTransportProvider } = await import('../../../transport/NostrTransportProvider');
const { parseBindingInfo } = await import('@unicitylabs/nostr-js-sdk');
type SdkEvent = Parameters<typeof parseBindingInfo>[0];
type BindingInfo = ReturnType<typeof parseBindingInfo>;

// Type-level tripwire, checked by `npm run typecheck:tests`: when upstream
// (#734) adds `network` to BindingInfo this stops compiling — wire it into
// NostrTransportProvider.bindingInfoToPeerInfo and delete the tripwire.
type UpstreamBindingCarriesNetwork = 'network' extends keyof BindingInfo ? true : false;
const upstreamBindingCarriesNetwork: UpstreamBindingCarriesNetwork = false;

// =============================================================================
// Fixtures
// =============================================================================

const PEER_TRANSPORT_PUB = PEER_PUB.slice(2); // x-only nostr pubkey (64 hex)
const PEER_DIRECT = 'DIRECT://peer';

let seq = 0;

/** A raw, signed identity-binding event as it sits on a relay. */
function bindingEvent(content: Record<string, unknown>, pubkey = PEER_TRANSPORT_PUB): RawEvent {
  return {
    id: `event-${++seq}`,
    kind: NOSTR_EVENT_KINDS.NAMETAG_BINDING,
    content: JSON.stringify(content),
    tags: [['d', `d-${seq}`]],
    pubkey,
    created_at: 1_700_000_000 + seq,
    sig: 'fake-sig',
  };
}

/** Publishes one binding event to the fake relay under every lookup route. */
function publishBinding(options: { network?: string; nametag?: string } = {}): RawEvent {
  const content: Record<string, unknown> = {
    public_key: PEER_PUB,
    direct_address: PEER_DIRECT,
    ...(options.nametag !== undefined ? { nametag: options.nametag } : {}),
    ...(options.network !== undefined ? { network: options.network } : {}),
  };
  const event = bindingEvent(content);
  fake.events.push(event);
  fake.byNametag.set(options.nametag ?? 'alice', event);
  fake.byAddress.set(PEER_DIRECT, event);
  return event;
}

let transport: InstanceType<typeof NostrTransportProvider>;

async function connectTransport(): Promise<void> {
  transport = new NostrTransportProvider({
    relays: ['wss://fake.relay'],
    // Inert: the (mocked) NostrClient owns its sockets, so this is never called.
    createWebSocket: (() => undefined) as unknown as WebSocketFactory,
    timeout: 1000,
    autoReconnect: false,
  });
  transport.setIdentity({ privateKey: '33'.repeat(32), chainPubkey: PEER_PUB });
  await transport.connect();
}

const resolvePeer = (identifier: string): Promise<PeerInfo | null> => transport.resolve(identifier);

beforeEach(async () => {
  fake.events.length = 0;
  fake.byNametag.clear();
  fake.byAddress.clear();
  await connectTransport();
});

afterEach(async () => {
  await cleanupWorlds();
  await transport.disconnect();
});

// =============================================================================
// Resolution: what each route can and cannot read off the relay
// =============================================================================

describe('NostrTransportProvider — the network a binding declares, per route', () => {
  it('transport-pubkey route: reads the network declared by the raw signed event', async () => {
    publishBinding({ network: 'mars' });

    const peer = await transport.resolve(PEER_TRANSPORT_PUB);

    expect(peer?.chainPubkey).toBe(PEER_PUB);
    expect(peer?.network).toBe('mars');
  });

  it('transport-pubkey route: a binding with no network — or a blank one — declares nothing', async () => {
    publishBinding();
    expect((await transport.resolve(PEER_TRANSPORT_PUB))?.network).toBeUndefined();

    fake.events.length = 0;
    publishBinding({ network: '' });
    expect((await transport.resolve(PEER_TRANSPORT_PUB))?.network).toBeUndefined();
  });

  // TRIPWIRE (#734). Upstream's own parser does the dropping here. When these
  // two go red, `network` survives `parseBindingInfo` — wire it through
  // bindingInfoToPeerInfo, flip these expectations, and tighten §5.6's third row.
  it('@nametag route: upstream drops a declared network before sphere can see it', async () => {
    const event = publishBinding({ network: 'mars', nametag: 'alice' });
    expect((JSON.parse(event.content) as { network: string }).network).toBe('mars');
    expect('network' in parseBindingInfo(event as unknown as SdkEvent)).toBe(false);
    expect(upstreamBindingCarriesNetwork).toBe(false);

    const peer = await transport.resolve('@alice');

    expect(peer?.chainPubkey).toBe(PEER_PUB); // the route worked…
    expect(peer?.network).toBeUndefined(); // …only the declaration is gone
  });

  it('DIRECT:// route: upstream drops a declared network before sphere can see it', async () => {
    publishBinding({ network: 'mars' });

    const peer = await transport.resolve(PEER_DIRECT);

    expect(peer?.chainPubkey).toBe(PEER_PUB);
    expect(peer?.network).toBeUndefined();
  });
});

// =============================================================================
// The gate, reached from the relay through production resolution
// =============================================================================

describe('§5.6 recipient gate — relay → transport → resolveRecipientInfo → facade', () => {
  it('transport-pubkey recipient on ANOTHER network is REFUSED before any reserve', async () => {
    publishBinding({ network: 'mars' });
    const world = makeWorld({ resolvePeer });
    await world.seed(100n);
    await world.facade.start();

    await expect(
      world.facade.send({ recipient: PEER_TRANSPORT_PUB, amount: '100', coinId: COIN })
    ).rejects.toMatchObject({
      code: 'INVALID_RECIPIENT',
      message: expect.stringContaining(`is on network "mars" but this session is on "${NET}"`) as unknown,
    });

    expect(world.counters.putIntent).toBe(0);
    expect(world.engine.transferCalls).toHaveLength(0);
    expect(eventsOf(world, 'transfer:attention')).toEqual([]);
  });

  it('transport-pubkey recipient proving THIS session network proceeds, unsignalled', async () => {
    publishBinding({ network: NET });
    const world = makeWorld({ resolvePeer });
    await world.seed(100n);
    await world.facade.start();

    const result = await world.facade.send({
      recipient: PEER_TRANSPORT_PUB,
      amount: '100',
      coinId: COIN,
    });

    expect(result.status).toBe('delivered');
    expect(eventsOf(world, 'transfer:attention')).toEqual([]);
  });

  // The limitation, enforced where it costs money: the binding on the relay
  // DOES declare a foreign network, and these two routes still send.
  it('LIMITATION (#734) @nametag recipient: the declaration is unreadable, so the send PROCEEDS and is signalled', async () => {
    publishBinding({ network: 'mars', nametag: 'alice' });
    const world = makeWorld({ resolvePeer });
    await world.seed(100n);
    await world.facade.start();

    const result = await world.facade.send({ recipient: '@alice', amount: '100', coinId: COIN });

    expect(result.status).toBe('delivered');
    expect(eventsOf(world, 'transfer:attention')).toEqual([
      {
        transferId: '',
        code: ATTENTION_RECIPIENT_NETWORK_UNVERIFIED,
        detail: expect.stringContaining('could not verify the network of recipient @alice') as unknown,
      },
    ]);
  });

  it('LIMITATION (#734) DIRECT:// recipient: the declaration is unreadable, so the send PROCEEDS and is signalled', async () => {
    publishBinding({ network: 'mars' });
    const world = makeWorld({ resolvePeer });
    await world.seed(100n);
    await world.facade.start();

    const result = await world.facade.send({ recipient: PEER_DIRECT, amount: '100', coinId: COIN });

    expect(result.status).toBe('delivered');
    expect(eventsOf(world, 'transfer:attention')).toEqual([
      {
        transferId: '',
        code: ATTENTION_RECIPIENT_NETWORK_UNVERIFIED,
        detail: expect.stringContaining(`recipient ${PEER_DIRECT}`) as unknown,
      },
    ]);
  });
});
