// #847 keeps exactly one DIRECT:// job: the wallet's Sphere Quests account id.
// The Quests backend cannot derive that id from a chain pubkey (the wallet derives
// it from getPublicKey(SHA256(privateKey))), so it reads it back from the identity
// binding the wallet publishes: resolve(<66-hex chain pubkey>) → PeerInfo.directAddress.
//
// Every other SDK test mocks the nostr client, so a nostr-js-sdk bump that stopped
// writing `content.direct_address` would stay green and break Quests sign-in. Here
// the REAL upstream builders and the REAL lookup (address filter, candidate check,
// signature verify, single-owner pick) run behind NostrTransportProvider: only the
// relay I/O is faked, and the fake relay replays what was published to a matching
// subscription, then EOSE.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getPublicKey } from '../../../core/crypto';
import type { WebSocketFactory } from '../../../transport/websocket';

interface StoredEvent {
  kind: number;
  pubkey: string;
  tags: string[][];
  content: string;
}
const relay = vi.hoisted(() => ({ published: [] as StoredEvent[] }));

/** A relay's filter match over the fields the binding queries use. */
function matches(filter: unknown, event: StoredEvent): boolean {
  const json = JSON.parse(JSON.stringify(filter)) as Record<string, unknown>;
  return Object.entries(json).every(([key, wanted]) => {
    if (!Array.isArray(wanted)) return true;
    if (key === 'kinds') return wanted.includes(event.kind);
    if (key === 'authors') return wanted.includes(event.pubkey);
    if (!key.startsWith('#')) return true;
    return event.tags.some(([name, value]) => name === key.slice(1) && wanted.includes(value));
  });
}

vi.mock('@unicitylabs/nostr-js-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@unicitylabs/nostr-js-sdk')>();
  type SdkEvent = Parameters<typeof actual.parseBindingInfo>[0];
  class RelaylessNostrClient extends actual.NostrClient {
    override connect = async (): Promise<void> => undefined;
    override disconnect = (): void => undefined;
    override isConnected = (): boolean => true;
    override getConnectedRelays = (): Set<string> => new Set(['wss://fake.relay']);
    override publishEvent = async (event: SdkEvent): Promise<string> => {
      relay.published.push(event);
      return 'fake-event-id';
    };
    // Stored events matching the filter, then EOSE: what a relay answers a REQ with.
    override subscribe = ((filter: unknown, listener: {
      onEvent?: (event: SdkEvent) => void;
      onEndOfStoredEvents?: (id: string) => void;
    }): string => {
      setTimeout(() => {
        for (const event of relay.published.filter((e) => matches(filter, e))) listener.onEvent?.(event as SdkEvent);
        listener.onEndOfStoredEvents?.('fake-sub');
      }, 0);
      return 'fake-sub';
    }) as never;
    override unsubscribe = (): void => undefined;
  }
  return { ...actual, NostrClient: RelaylessNostrClient };
});

const { NostrTransportProvider } = await import('../../../transport/NostrTransportProvider');

const PRIVATE_KEY = '44'.repeat(32);
const CHAIN_PUBKEY = getPublicKey(PRIVATE_KEY);
const QUESTS_ID = 'DIRECT://0000' + '5a'.repeat(32) + 'a1b2c3d4';

let transport: InstanceType<typeof NostrTransportProvider>;

beforeEach(async () => {
  relay.published.length = 0;
  transport = new NostrTransportProvider({
    relays: ['wss://fake.relay'],
    createWebSocket: (() => undefined) as unknown as WebSocketFactory,
    timeout: 1000,
    autoReconnect: false,
  });
  transport.setIdentity({ privateKey: PRIVATE_KEY, chainPubkey: CHAIN_PUBKEY });
  await transport.connect();
});

afterEach(async () => {
  await transport.disconnect();
});

function onlyContent(): Record<string, unknown> {
  expect(relay.published).toHaveLength(1);
  return JSON.parse(relay.published[0]!.content) as Record<string, unknown>;
}

describe('#847 Quests surface — the identity binding carries the Quests id', () => {
  it('a binding without a Unicity ID writes direct_address and public_key (real upstream builder)', async () => {
    await expect(transport.publishIdentityBinding(CHAIN_PUBKEY, QUESTS_ID)).resolves.toBe(true);

    const content = onlyContent();
    expect(content.direct_address).toBe(QUESTS_ID);
    expect(content.public_key).toBe(CHAIN_PUBKEY);
  });

  it('a binding with a Unicity ID writes direct_address and public_key (real upstream builder)', async () => {
    await expect(transport.publishIdentityBinding(CHAIN_PUBKEY, QUESTS_ID, 'alice')).resolves.toBe(true);

    const content = onlyContent();
    expect(content.direct_address).toBe(QUESTS_ID);
    expect(content.public_key).toBe(CHAIN_PUBKEY);
  });

  it('resolve(<66-hex chain pubkey>) reads the published Quests id back as PeerInfo.directAddress', async () => {
    await transport.publishIdentityBinding(CHAIN_PUBKEY, QUESTS_ID);

    const peer = await transport.resolve(CHAIN_PUBKEY);

    expect(peer?.chainPubkey).toBe(CHAIN_PUBKEY);
    expect(peer?.directAddress).toBe(QUESTS_ID);
  });
});
