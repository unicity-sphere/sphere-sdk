/**
 * GroupChatModule Relay Integration Tests
 *
 * Tests the GroupChatModule against a real NIP-29 relay (Zooid).
 *
 * Two modes:
 *   1. Docker (default) — spins up relay + nginx proxy via testcontainers.
 *      Requires Docker on the host.
 *   2. Remote — set RELAY_URL env var to point at a deployed relay.
 *      Example:  RELAY_URL=wss://sphere-relay.unicity.network npm run test:relay
 *
 * When running against a remote relay, tests that require relay-admin
 * privileges or private-group support are automatically skipped if the
 * relay does not grant them to the test user keys.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, Network, type StartedTestContainer, type StartedNetwork, Wait } from 'testcontainers';
import { NostrKeyManager } from '@unicitylabs/nostr-js-sdk';

import { GroupChatModule } from '../../modules/groupchat/GroupChatModule';
import { GroupVisibility } from '../../modules/groupchat/types';
import type { GroupData, GroupMessageData } from '../../modules/groupchat/types';
import type { StorageProvider } from '../../storage';
import type { FullIdentity, SphereEventType, SphereEventMap, TrackedAddressEntry, ProviderStatus } from '../../types';

// =============================================================================
// Constants
// =============================================================================

const RELAY_IMAGE = 'ghcr.io/unicitynetwork/unicity-relay:sha-999b6ec';
const RELAY_PORT = 3334;
const PROXY_PORT = 80;
const RELAY_ALIAS = 'relay'; // Docker network alias for the relay container

const REMOTE_RELAY_URL = process.env.RELAY_URL; // e.g. wss://sphere-relay.unicity.network
const USE_DOCKER = !REMOTE_RELAY_URL;

const RELAY_SECRET = '0000000000000000000000000000000000000000000000000000000000000099';
const USER_A_PRIVATE_KEY = '0000000000000000000000000000000000000000000000000000000000000001';
const USER_B_PRIVATE_KEY = '0000000000000000000000000000000000000000000000000000000000000002';

// =============================================================================
// Helpers
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until a WebSocket URL accepts connections.
 */
async function waitForWebSocket(url: string, timeoutMs: number): Promise<void> {
  const { default: WebSocket } = await import('ws');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.on('open', () => { ws.close(); resolve(); });
        ws.on('error', () => { ws.close(); reject(); });
        setTimeout(() => { ws.close(); reject(); }, 2000);
      });
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`WebSocket at ${url} not ready after ${timeoutMs}ms`);
}

function getXOnlyPubkey(privateKeyHex: string): string {
  const secretKey = Buffer.from(privateKeyHex, 'hex');
  const km = NostrKeyManager.fromPrivateKey(secretKey);
  return km.getPublicKeyHex();
}

/**
 * Minimal in-memory StorageProvider for tests.
 */
class InMemoryStorageProvider implements StorageProvider {
  readonly id = 'memory';
  readonly name = 'Memory';
  readonly type = 'local' as const;
  private data = new Map<string, string>();

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  isConnected(): boolean { return true; }
  getStatus(): ProviderStatus { return 'connected'; }
  setIdentity(): void {}

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.data.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return this.data.has(key);
  }

  async keys(prefix?: string): Promise<string[]> {
    const allKeys: string[] = [];
    this.data.forEach((_, k) => allKeys.push(k));
    if (!prefix) return allKeys;
    return allKeys.filter((k) => k.startsWith(prefix));
  }

  async clear(prefix?: string): Promise<void> {
    if (!prefix) {
      this.data.clear();
      return;
    }
    const toDelete: string[] = [];
    this.data.forEach((_, k) => { if (k.startsWith(prefix)) toDelete.push(k); });
    toDelete.forEach((k) => this.data.delete(k));
  }

  async saveTrackedAddresses(): Promise<void> {}
  async loadTrackedAddresses(): Promise<TrackedAddressEntry[]> { return []; }
}

interface TestModule {
  module: GroupChatModule;
  events: Array<{ type: string; data: unknown }>;
  storage: InMemoryStorageProvider;
}

async function connectWithRetry(module: GroupChatModule, maxAttempts = 15): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await module.connect();
      if (module.getConnectionStatus()) return;
    } catch {
      // Swallow and retry
    }
    await sleep(1000);
  }
  throw new Error('Failed to connect to relay after retries');
}

function createTestModule(privateKeyHex: string, relayUrl: string): TestModule {
  const events: Array<{ type: string; data: unknown }> = [];

  const identity: FullIdentity = {
    privateKey: privateKeyHex,
    chainPubkey: '02' + getXOnlyPubkey(privateKeyHex),
    l1Address: 'alpha1testdummy',
  };

  const storage = new InMemoryStorageProvider();

  const emitEvent = <T extends SphereEventType>(type: T, data: SphereEventMap[T]): void => {
    events.push({ type, data });
  };

  const module = new GroupChatModule({ relays: [relayUrl] });
  module.initialize({ identity, storage, emitEvent });

  return { module, events, storage };
}

// =============================================================================
// Test Suite
// =============================================================================

describe('GroupChatModule Relay Integration', () => {
  // Docker resources (only used when USE_DOCKER is true)
  let network: StartedNetwork | undefined;
  let relayContainer: StartedTestContainer | undefined;
  let proxyContainer: StartedTestContainer | undefined;

  let relayUrl: string;

  let userA: TestModule;
  let userB: TestModule;

  // Unique suffix for this test run — prevents "group already exists" on persistent relays.
  const runId = Math.random().toString(36).slice(2, 8);

  // Relay capability flags (detected at startup).
  // In Docker mode these are always true (we control the config).
  // In remote mode they depend on the deployed relay's configuration.
  let userAIsRelayAdmin = false;
  let privateGroupsSupported = false;

  // Shared group IDs populated during setup
  let publicGroupId: string;
  let privateGroupId: string;
  let userBGroupId: string;

  beforeAll(async () => {
    if (USE_DOCKER) {
      // ----- Docker mode: spin up relay + nginx proxy -----
      const userAPubkey = getXOnlyPubkey(USER_A_PRIVATE_KEY);
      const relayPubkey = getXOnlyPubkey(RELAY_SECRET);

      // Docker network lets the proxy reach the relay by hostname.
      network = await new Network().start();

      // 1. Start the proxy first to learn the random host port.
      //    Uses nginx resolver + variable proxy_pass so the upstream hostname
      //    ("relay") is resolved lazily at request time via Docker DNS (127.0.0.11),
      //    not at startup — avoiding the "host not found" crash.
      const nginxConf = [
        'server {',
        `  listen ${PROXY_PORT};`,
        '  resolver 127.0.0.11 valid=1s;',
        '  location / {',
        `    set $backend http://${RELAY_ALIAS}:${RELAY_PORT};`,
        '    proxy_pass $backend;',
        '    proxy_http_version 1.1;',
        '    proxy_set_header Upgrade $http_upgrade;',
        '    proxy_set_header Connection "upgrade";',
        '    proxy_set_header Host $http_host;',
        '  }',
        '}',
      ].join('\n');

      proxyContainer = await new GenericContainer('nginx:alpine')
        .withNetwork(network)
        .withCopyContentToContainer([{
          content: nginxConf,
          target: '/etc/nginx/conf.d/default.conf',
        }])
        .withExposedPorts(PROXY_PORT)
        .start();

      const mappedPort = proxyContainer.getMappedPort(PROXY_PORT);

      // 2. Start the relay with RELAY_HOST matching the public URL that clients
      //    connect to (localhost:<mappedPort>). This ensures the Host header and
      //    the NIP-42 AUTH relay URL tag both match what the relay expects.
      relayContainer = await new GenericContainer(RELAY_IMAGE)
        .withPlatform('linux/amd64')
        .withNetwork(network)
        .withNetworkAliases(RELAY_ALIAS)
        .withEnvironment({
          RELAY_HOST: `localhost:${mappedPort}`,
          RELAY_SECRET: RELAY_SECRET,
          RELAY_PUBKEY: relayPubkey,
          ADMIN_PUBKEYS: `"${userAPubkey}"`,
          GROUPS_ADMIN_CREATE_ONLY: 'false',
          GROUPS_PRIVATE_ADMIN_ONLY: 'false',
          GROUPS_PRIVATE_RELAY_ADMIN_ACCESS: 'false',
          PORT: String(RELAY_PORT),
        })
        .withWaitStrategy(Wait.forLogMessage(/running on/))
        .withStartupTimeout(60000)
        .start();

      relayUrl = `ws://localhost:${mappedPort}`;
    } else {
      // ----- Remote mode: use the provided relay URL -----
      relayUrl = REMOTE_RELAY_URL!;
    }

    await waitForWebSocket(relayUrl, 30000);

    // Create modules and connect
    userA = createTestModule(USER_A_PRIVATE_KEY, relayUrl);
    userB = createTestModule(USER_B_PRIVATE_KEY, relayUrl);
    await connectWithRetry(userA.module);
    await connectWithRetry(userB.module);

    // Allow NIP-42 AUTH handshake to complete before publishing events.
    await sleep(1500);

    // Detect relay capabilities
    userAIsRelayAdmin = await userA.module.isCurrentUserRelayAdmin();

    // Create groups via SDK API
    const publicGroup = await userA.module.createGroup({
      name: `Public ${runId}`,
      visibility: GroupVisibility.PUBLIC,
    });
    expect(publicGroup).not.toBeNull();
    publicGroupId = publicGroup!.id;

    // Private group creation may fail on relays with GROUPS_PRIVATE_ADMIN_ONLY=true
    // when User A is not a relay admin. Try creating one and verify the full
    // invite-join flow works end-to-end (as opposed to a local fallback).
    try {
      const privateGroup = await userA.module.createGroup({
        name: `Private ${runId}`,
        visibility: GroupVisibility.PRIVATE,
      });
      if (privateGroup) {
        const probeInvite = await userA.module.createInvite(privateGroup.id);
        if (probeInvite) {
          const probeJoin = await userB.module.joinGroup(privateGroup.id, probeInvite);
          if (probeJoin) {
            privateGroupId = privateGroup.id;
            privateGroupsSupported = true;
          }
        }
      }
    } catch {
      // Private groups not supported — skip those tests
    }

    const userBGroup = await userB.module.createGroup({
      name: `UserB ${runId}`,
      visibility: GroupVisibility.PUBLIC,
    });
    expect(userBGroup).not.toBeNull();
    userBGroupId = userBGroup!.id;

    await sleep(500);
  }, 120000);

  afterAll(async () => {
    userA?.module.destroy();
    userB?.module.destroy();
    if (USE_DOCKER) {
      await proxyContainer?.stop();
      await relayContainer?.stop();
      await network?.stop();
    }
  });

  // ===========================================================================
  // Connection & Basics
  // ===========================================================================

  describe('connection', () => {
    it('connects to relay', () => {
      expect(userA.module.getConnectionStatus()).toBe(true);
      expect(userB.module.getConnectionStatus()).toBe(true);
    });

    it('reports relay admin status correctly', async () => {
      if (userAIsRelayAdmin) {
        // In Docker mode User A is always configured as relay admin
        expect(await userA.module.isCurrentUserRelayAdmin()).toBe(true);
      }
      // User B should never be relay admin
      expect(await userB.module.isCurrentUserRelayAdmin()).toBe(false);
    });
  });

  // ===========================================================================
  // Group Creation (verified via discovery)
  // ===========================================================================

  describe('group creation', () => {
    it('public group exists on relay', async () => {
      const groups = await userA.module.fetchAvailableGroups();
      const found = groups.find((g: GroupData) => g.id === publicGroupId);
      expect(found).toBeTruthy();
      expect(found!.name).toBe(`Public ${runId}`);
      expect(found!.visibility).toBe(GroupVisibility.PUBLIC);
    });

    it('non-admin user created group exists', async () => {
      const groups = await userA.module.fetchAvailableGroups();
      const found = groups.find((g: GroupData) => g.id === userBGroupId);
      expect(found).toBeTruthy();
      expect(found!.name).toBe(`UserB ${runId}`);
    });

    it('user A is member of public group', () => {
      const groups = userA.module.getGroups();
      const found = groups.find((g: GroupData) => g.id === publicGroupId);
      expect(found).toBeTruthy();
    });
  });

  // ===========================================================================
  // Group Discovery & Joining
  // ===========================================================================

  describe('discovery & joining', () => {
    it('fetchAvailableGroups returns public groups', async () => {
      const groups = await userB.module.fetchAvailableGroups();
      expect(groups.length).toBeGreaterThanOrEqual(2); // public + userB's group
    });

    it('joins a public group', async () => {
      const joined = await userB.module.joinGroup(publicGroupId);
      expect(joined).toBe(true);

      const groups = userB.module.getGroups();
      const found = groups.find((g: GroupData) => g.id === publicGroupId);
      expect(found).toBeTruthy();
    });

    it('joins a private group with invite', async () => {
      if (!privateGroupsSupported) return; // relay doesn't support private groups

      const inviteCode = await userA.module.createInvite(privateGroupId);
      expect(inviteCode).not.toBeNull();

      const joined = await userB.module.joinGroup(privateGroupId, inviteCode!);
      expect(joined).toBe(true);

      const groups = userB.module.getGroups();
      const found = groups.find((g: GroupData) => g.id === privateGroupId);
      expect(found).toBeTruthy();
    });
  });

  // ===========================================================================
  // Messaging
  // ===========================================================================

  describe('messaging', () => {
    it('sends and fetches messages', async () => {
      const sent = await userA.module.sendMessage(publicGroupId, 'Hello from User A');
      expect(sent).not.toBeNull();
      expect(sent!.content).toBe('Hello from User A');

      await sleep(500);

      const messages = await userB.module.fetchMessages(publicGroupId);
      expect(messages.length).toBeGreaterThanOrEqual(1);

      const found = messages.find((m: GroupMessageData) => m.content === 'Hello from User A');
      expect(found).toBeTruthy();
    });

    it('sends reply with replyToId', async () => {
      const original = await userA.module.sendMessage(publicGroupId, 'Original message');
      expect(original).not.toBeNull();

      await sleep(300);

      const reply = await userB.module.sendMessage(publicGroupId, 'Reply to original', original!.id);
      expect(reply).not.toBeNull();
      expect(reply!.replyToId).toBe(original!.id);
    });

    it('message appears in local state', async () => {
      const sent = await userA.module.sendMessage(publicGroupId, 'Local state check');
      expect(sent).not.toBeNull();

      const messages = userA.module.getMessages(publicGroupId);
      const found = messages.find((m: GroupMessageData) => m.content === 'Local state check');
      expect(found).toBeTruthy();
    });
  });

  // ===========================================================================
  // Members
  // ===========================================================================

  describe('members', () => {
    it('creator is admin of their group', () => {
      const isAdmin = userA.module.isCurrentUserAdmin(publicGroupId);
      expect(isAdmin).toBe(true);
    });

    it('joiner is member', () => {
      const members = userB.module.getMembers(publicGroupId);
      const userBPubkey = userB.module.getMyPublicKey();
      const found = members.find((m) => m.pubkey === userBPubkey);
      expect(found).toBeTruthy();
      expect(found!.role).toBe('MEMBER');
    });

    it('member count reflects joined users', () => {
      const members = userA.module.getMembers(publicGroupId);
      expect(members.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ===========================================================================
  // Moderation
  // ===========================================================================

  describe('moderation', () => {
    let moderationGroupId: string;
    let moderationMessageId: string;

    beforeAll(async () => {
      const group = await userA.module.createGroup({
        name: `Moderation ${runId}`,
        visibility: GroupVisibility.PUBLIC,
      });
      expect(group).not.toBeNull();
      moderationGroupId = group!.id;
      await sleep(300);
      await userB.module.joinGroup(moderationGroupId);
      await sleep(300);

      const msg = await userB.module.sendMessage(moderationGroupId, 'To be deleted');
      expect(msg).not.toBeNull();
      moderationMessageId = msg!.id!;
      await sleep(300);
    });

    it('group admin deletes a message', async () => {
      const deleted = await userA.module.deleteMessage(moderationGroupId, moderationMessageId);
      expect(deleted).toBe(true);

      await sleep(300);
      const messages = userA.module.getMessages(moderationGroupId);
      const found = messages.find((m: GroupMessageData) => m.id === moderationMessageId);
      expect(found).toBeFalsy();
    });

    it('group admin kicks user', async () => {
      const userBPubkey = userB.module.getMyPublicKey()!;
      const kicked = await userA.module.kickUser(moderationGroupId, userBPubkey, 'test kick');
      expect(kicked).toBe(true);

      await sleep(300);
      const members = userA.module.getMembers(moderationGroupId);
      const found = members.find((m) => m.pubkey === userBPubkey);
      expect(found).toBeFalsy();
    });

    it('relay admin can moderate public group', async () => {
      if (!userAIsRelayAdmin) return; // requires relay admin privileges

      // User A is relay admin, userBGroupId is User B's public group
      // User A must have this group in local state to check moderation
      if (!userA.module.getGroup(userBGroupId)) {
        await userA.module.joinGroup(userBGroupId);
        await sleep(300);
      }
      const canModerate = await userA.module.canModerateGroup(userBGroupId);
      expect(canModerate).toBe(true);
    });

    it('relay admin cannot moderate private group they are not in', async () => {
      // canModerateGroup checks local groups map — since the private group
      // isn't in User A's local state, it returns false
      const canModerate = await userA.module.canModerateGroup('nonexistent_private_group');
      expect(canModerate).toBe(false);
    });
  });

  // ===========================================================================
  // Group Lifecycle
  // ===========================================================================

  describe('group lifecycle', () => {
    let lifecycleGroupId: string;

    beforeAll(async () => {
      const group = await userA.module.createGroup({
        name: `Lifecycle ${runId}`,
        visibility: GroupVisibility.PUBLIC,
      });
      expect(group).not.toBeNull();
      lifecycleGroupId = group!.id;
      await sleep(300);
      await userB.module.joinGroup(lifecycleGroupId);
      await sleep(300);
    });

    it('leaves group', async () => {
      const left = await userB.module.leaveGroup(lifecycleGroupId);
      expect(left).toBe(true);

      const groups = userB.module.getGroups();
      const found = groups.find((g: GroupData) => g.id === lifecycleGroupId);
      expect(found).toBeFalsy();
    });

    it('rejoins after leaving', async () => {
      const rejoined = await userB.module.joinGroup(lifecycleGroupId);
      expect(rejoined).toBe(true);

      const groups = userB.module.getGroups();
      const found = groups.find((g: GroupData) => g.id === lifecycleGroupId);
      expect(found).toBeTruthy();
    });

    it('admin deletes group', async () => {
      const deleted = await userA.module.deleteGroup(lifecycleGroupId);
      expect(deleted).toBe(true);

      const groups = userA.module.getGroups();
      const found = groups.find((g: GroupData) => g.id === lifecycleGroupId);
      expect(found).toBeFalsy();
    });
  });

  // ===========================================================================
  // Invites (Private Groups)
  // ===========================================================================

  describe('invites', () => {
    let inviteGroupId: string;
    let invitesReady = false;

    beforeAll(async () => {
      if (!privateGroupsSupported) return;

      const group = await userA.module.createGroup({
        name: `Invite ${runId}`,
        visibility: GroupVisibility.PRIVATE,
      });
      expect(group).not.toBeNull();
      inviteGroupId = group!.id;
      invitesReady = true;
      await sleep(300);
    });

    it('creates invite code', async () => {
      if (!invitesReady) return;

      const code = await userA.module.createInvite(inviteGroupId);
      expect(code).not.toBeNull();
      expect(typeof code).toBe('string');
      expect(code!.length).toBeGreaterThan(0);
    });

    it('invite code allows joining', async () => {
      if (!invitesReady) return;

      const code = await userA.module.createInvite(inviteGroupId);
      expect(code).not.toBeNull();

      const joined = await userB.module.joinGroup(inviteGroupId, code!);
      expect(joined).toBe(true);

      const groups = userB.module.getGroups();
      const found = groups.find((g: GroupData) => g.id === inviteGroupId);
      expect(found).toBeTruthy();
    });
  });

  // ===========================================================================
  // Persistence
  // ===========================================================================

  describe('persistence', () => {
    it('state persists to storage', async () => {
      // Allow debounced persist to complete
      await sleep(500);
      const groupsJson = await userA.storage.get('group_chat_groups');
      expect(groupsJson).not.toBeNull();

      const groups = JSON.parse(groupsJson!);
      expect(Array.isArray(groups)).toBe(true);
      expect(groups.length).toBeGreaterThan(0);
    });

    it('loads from storage on init', async () => {
      await sleep(500);
      const freshModule = new GroupChatModule({ relays: [relayUrl] });
      const identity: FullIdentity = {
        privateKey: USER_A_PRIVATE_KEY,
        chainPubkey: '02' + getXOnlyPubkey(USER_A_PRIVATE_KEY),
        l1Address: 'alpha1testdummy',
      };

      freshModule.initialize({
        identity,
        storage: userA.storage,
        emitEvent: () => {},
      });
      await freshModule.load();

      const groups = freshModule.getGroups();
      expect(groups.length).toBeGreaterThan(0);

      freshModule.destroy();
    });
  });

  // ===========================================================================
  // Unread Counts
  // ===========================================================================

  describe('unread counts', () => {
    let unreadGroupId: string;

    beforeAll(async () => {
      const group = await userA.module.createGroup({
        name: `Unread ${runId}`,
        visibility: GroupVisibility.PUBLIC,
      });
      expect(group).not.toBeNull();
      unreadGroupId = group!.id;
      await sleep(300);
      await userB.module.joinGroup(unreadGroupId);
      await sleep(500);
    });

    it('unread count API works', async () => {
      userA.module.markGroupAsRead(unreadGroupId);

      await userB.module.sendMessage(unreadGroupId, 'Unread test message');
      await sleep(1000);

      const totalUnread = userA.module.getTotalUnreadCount();
      expect(typeof totalUnread).toBe('number');
    });

    it('markGroupAsRead resets unread count', () => {
      userA.module.markGroupAsRead(unreadGroupId);
      const group = userA.module.getGroup(unreadGroupId);
      expect(group).not.toBeNull();
      expect(group!.unreadCount ?? 0).toBe(0);
    });
  });
});
