// #847 keeps exactly one DIRECT:// job: the wallet's Sphere Quests account id.
// The Quests backend cannot derive that id from a chain pubkey (the wallet derives
// it from getPublicKey(SHA256(privateKey))), so it reads it back from the identity
// binding the wallet publishes: resolve(<66-hex chain pubkey>) → PeerInfo.directAddress.
//
// Every other SDK test mocks the nostr client, so a nostr-js-sdk bump that stopped
// writing `content.direct_address` would stay green and break Quests sign-in. Here
// the REAL upstream builders run behind NostrTransportProvider's parameter mapping:
// only the relay I/O (connect, publishEvent, subscribe) is faked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getPublicKey } from '../../../core/crypto';
import type { WebSocketFactory } from '../../../transport/websocket';

const relay = vi.hoisted(() => ({ published: [] as { tags: string[][]; content: string }[] }));

vi.mock('@unicitylabs/nostr-js-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@unicitylabs/nostr-js-sdk')>();
  type SdkEvent = Parameters<typeof actual.parseBindingInfo>[0];
  class RelaylessNostrClient extends actual.NostrClient {
    override connect = async (): Promise<void> => undefined;
    override disconnect = (): void => undefined;
    override isConnected = (): boolean => true;
    override getConnectedRelays = (): Set<string> => new Set(['wss://fake.relay']);
    override queryPubkeyByNametag = async (): Promise<string | null> => null;
    override publishEvent = async (event: SdkEvent): Promise<string> => {
      relay.published.push(event);
      return 'fake-event-id';
    };
    override subscribe = ((...args: unknown[]): string => {
      const listener = args.find((a) => typeof a === 'object' && a !== null && 'onEndOfStoredEvents' in a) as
        | { onEndOfStoredEvents?: (id: string) => void }
        | undefined;
      setTimeout(() => listener?.onEndOfStoredEvents?.('fake-sub'), 0);
      return 'fake-sub';
    }) as never;
    override unsubscribe = (): void => undefined;
    // The reverse lookup over what was published: the `t` tag the builder wrote.
    override queryBindingByAddress = async (address: string) => {
      const tag = actual.hashAddressForTag(address);
      const event = relay.published.find((e) => e.tags.some(([k, v]) => k === 't' && v === tag));
      return event ? actual.parseBindingInfo(event as SdkEvent) : null;
    };
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
