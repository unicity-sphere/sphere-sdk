/**
 * GroupChatModule.createGroup — the id a new group is created under.
 *
 * Drives the REAL createGroup() against a stand-in NostrClient that records what is published and
 * rejects a CREATE_GROUP the way the real client surfaces a relay's OK=false:
 * `Error('Event rejected: <relay message>')`.
 */
import { describe, expect, it, vi } from 'vitest';
import { GroupChatModule } from '../../../modules/groupchat/GroupChatModule';
import { NIP29_KINDS } from '../../../constants';
import type { StorageProvider } from '../../../storage';
import type { FullIdentity } from '../../../types';

function createMockStorage(): StorageProvider {
  return {
    id: 'mock', name: 'Mock', type: 'local' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    has: vi.fn().mockResolvedValue(false),
    keys: vi.fn().mockResolvedValue([]),
    clear: vi.fn().mockResolvedValue(undefined),
    saveTrackedAddresses: vi.fn().mockResolvedValue(undefined),
    loadTrackedAddresses: vi.fn().mockResolvedValue([]),
  } as unknown as StorageProvider;
}

interface PublishedEvent { kind: number; tags: string[][]; content: string; }

/**
 * Minimal NostrClient stand-in. `rejections` are relay messages for successive CREATE_GROUP
 * publishes; once they run out, publishes are accepted. Subscriptions end their stored events
 * immediately with nothing stored.
 */
function makeMockClient(rejections: string[]) {
  const published: PublishedEvent[] = [];
  let subscriptions = 0;
  return {
    published,
    async createAndPublishEvent(data: PublishedEvent): Promise<string> {
      published.push(data);
      const rejection = data.kind === NIP29_KINDS.CREATE_GROUP ? rejections.shift() : undefined;
      if (rejection !== undefined) throw new Error(`Event rejected: ${rejection}`);
      return 'e'.repeat(64);
    },
    subscribe(_filter: unknown, handlers: { onEndOfStoredEvents?: () => void }): string {
      setTimeout(() => handlers.onEndOfStoredEvents?.(), 0);
      return `sub${subscriptions++}`;
    },
    unsubscribe(): void {},
  };
}

function setup(rejections: string[] = []) {
  const identity: FullIdentity = {
    privateKey: '01'.padStart(64, '0'),
    chainPubkey: '02' + 'a'.repeat(64),
  };
  const mod = new GroupChatModule();
  mod.initialize({ identity, storage: createMockStorage(), emitEvent: vi.fn() });
  const client = makeMockClient(rejections);
  // Inject the stand-in client and skip connecting to real relays.
  Object.assign(mod as unknown as { client: unknown; connected: boolean }, { client, connected: true });
  const createdIds = () =>
    client.published
      .filter((e) => e.kind === NIP29_KINDS.CREATE_GROUP)
      .map((e) => e.tags.find((t) => t[0] === 'h')?.[1]);
  return { mod, createdIds };
}

describe('GroupChatModule.createGroup — group id', () => {
  it('creates the group under a slug of its name and a random part', async () => {
    const { mod, createdIds } = setup();

    const group = await mod.createGroup({ name: 'Unicity Devs' });

    expect(createdIds()).toHaveLength(1);
    expect(createdIds()[0]).toMatch(/^unicity-devs-[0-9a-f]{16}$/);
    expect(group?.id).toBe(createdIds()[0]);
  });

  // The client settles a publish on the first relay's answer. With several relays, one refusal can
  // arrive while another relay has created the group, so publishing again would orphan that group.
  it.each([
    'invalid: that group already exists',
    'restricted: only admins can create groups',
  ])('does not publish again when the relay refuses the creation: %s', async (reason) => {
    const { mod, createdIds } = setup([reason]);

    const group = await mod.createGroup({ name: 'General' });

    expect(createdIds()).toHaveLength(1);
    expect(group).toBeNull();
  });
});
