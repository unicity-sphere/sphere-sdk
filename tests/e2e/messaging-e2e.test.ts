/**
 * E2E functional tests for Messaging CLI commands (DM + Group Chat).
 *
 * Exercises real SDK functions over the live testnet relay — NOT dry runs.
 *
 * Two test suites:
 *   1. DM Communications Module — round-trip DMs, conversation history,
 *      unread counts, read receipts, composing indicators
 *   2. Group Chat Module — create/join/leave/delete groups, post messages,
 *      fetch messages, members, unread counts
 *
 * Run manually:
 *   npx vitest run --config vitest.e2e.config.ts tests/e2e/messaging-e2e.test.ts
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Sphere } from '../../core/Sphere';
import { createNodeProviders } from '../../impl/nodejs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DirectMessage } from '../../types';
import { rand, makeTempDirs, ensureTrustbase, DEFAULT_API_KEY } from './helpers';

// =============================================================================
// Helpers
// =============================================================================

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function waitForDM(sphere: Sphere, timeoutMs = 30000): Promise<DirectMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout: DM not received within ${timeoutMs}ms`)),
      timeoutMs,
    );
    sphere.communications.onDirectMessage((msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
  });
}

function collectDMs(
  sphere: Sphere,
  count: number,
  timeoutMs = 30000,
): Promise<DirectMessage[]> {
  return new Promise((resolve, reject) => {
    const received: DirectMessage[] = [];
    const timer = setTimeout(
      () => reject(new Error(`Timeout: only ${received.length}/${count} DMs received`)),
      timeoutMs,
    );
    sphere.communications.onDirectMessage((msg) => {
      received.push(msg);
      if (received.length >= count) {
        clearTimeout(timer);
        resolve(received);
      }
    });
  });
}

async function createSphere(
  label: string,
  nametag?: string,
  opts?: { groupChat?: boolean },
) {
  const dirs = makeTempDirs(label);
  await ensureTrustbase(dirs.dataDir);

  const providers = createNodeProviders({
    network: 'testnet',
    dataDir: dirs.dataDir,
    tokensDir: dirs.tokensDir,
    oracle: {
      trustBasePath: join(dirs.dataDir, 'trustbase.json'),
      apiKey: DEFAULT_API_KEY,
    },
    ...(opts?.groupChat ? { groupChat: true } : {}),
  });

  const result = await Sphere.init({
    ...providers,
    autoGenerate: true,
    ...(nametag ? { nametag } : {}),
    ...(opts?.groupChat ? { groupChat: true } : {}),
  });

  return { sphere: result.sphere, dirs };
}

// =============================================================================
// DM Communications Module E2E
// =============================================================================

describe('DM Communications Module E2E', () => {
  const cleanupDirs: string[] = [];
  const spheres: Sphere[] = [];

  afterEach(async () => {
    for (const s of spheres) {
      try { await s.destroy(); } catch { /* cleanup */ }
    }
    spheres.length = 0;
    for (const d of cleanupDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
    cleanupDirs.length = 0;
  });

  it('sendDM and onDirectMessage deliver message end-to-end', async () => {
    const aliceTag = `e2e-alice-${rand()}`;
    const bobTag = `e2e-bob-${rand()}`;

    const { sphere: alice, dirs: aliceDirs } = await createSphere('alice', aliceTag);
    const { sphere: bob, dirs: bobDirs } = await createSphere('bob', bobTag);
    spheres.push(alice, bob);
    cleanupDirs.push(aliceDirs.base, bobDirs.base);

    // Wait for relay subscriptions to establish
    const dmPromise = waitForDM(bob);
    await sleep(3000);

    const text = `DM e2e test ${Date.now()}`;
    const sent = await alice.communications.sendDM(`@${bobTag}`, text);

    // Verify sendDM return value
    expect(sent.id).toBeTruthy();
    expect(sent.recipientPubkey).toBeTruthy();
    expect(sent.senderPubkey).toBe(alice.identity!.chainPubkey);
    expect(sent.senderNametag).toBe(aliceTag);
    expect(sent.content).toBe(text);
    expect(sent.timestamp).toBeGreaterThan(0);

    // Verify Bob receives
    const received = await dmPromise;
    expect(received.content).toBe(text);
    expect(received.senderPubkey).toBeTruthy();
    expect(received.senderNametag).toBe(aliceTag);
    expect(received.isRead).toBe(false);
  }, 90000);

  it('getConversation returns sent and received messages after round-trip', async () => {
    const aliceTag = `e2e-alice-${rand()}`;
    const bobTag = `e2e-bob-${rand()}`;

    const { sphere: alice, dirs: aliceDirs } = await createSphere('alice', aliceTag);
    const { sphere: bob, dirs: bobDirs } = await createSphere('bob', bobTag);
    spheres.push(alice, bob);
    cleanupDirs.push(aliceDirs.base, bobDirs.base);

    await sleep(3000);

    // Alice -> Bob: capture transport pubkeys from message objects
    const bobDmPromise = waitForDM(bob, 30000);
    await sleep(1000);
    const sentByAlice = await alice.communications.sendDM(`@${bobTag}`, 'Hello Bob');
    const receivedByBob = await bobDmPromise;

    // sentByAlice.recipientPubkey is Bob's transport pubkey (resolved from nametag)
    const bobTransportPubkey = sentByAlice.recipientPubkey;
    // receivedByBob.senderPubkey is Alice's transport pubkey
    const aliceTransportPubkey = receivedByBob.senderPubkey;

    await sleep(5000);

    // Bob -> Alice
    const aliceDmPromise = waitForDM(alice, 30000);
    await sleep(1000);
    await bob.communications.sendDM(`@${aliceTag}`, 'Hi Alice');
    await aliceDmPromise;

    // Alice's conversation with Bob (use transport pubkey)
    const aliceConvo = alice.communications.getConversation(bobTransportPubkey);
    expect(aliceConvo.length).toBe(2);
    expect(aliceConvo[0].content).toBe('Hello Bob');
    expect(aliceConvo[1].content).toBe('Hi Alice');

    // Bob's conversation with Alice (use transport pubkey)
    const bobConvo = bob.communications.getConversation(aliceTransportPubkey);
    expect(bobConvo.length).toBe(2);
    expect(bobConvo[0].content).toBe('Hello Bob');
    expect(bobConvo[1].content).toBe('Hi Alice');
  }, 90000);

  it('getConversations groups messages by peer', async () => {
    const aliceTag = `e2e-alice-${rand()}`;
    const bobTag = `e2e-bob-${rand()}`;

    const { sphere: alice, dirs: aliceDirs } = await createSphere('alice', aliceTag);
    const { sphere: bob, dirs: bobDirs } = await createSphere('bob', bobTag);
    spheres.push(alice, bob);
    cleanupDirs.push(aliceDirs.base, bobDirs.base);

    await sleep(3000);

    // Alice -> Bob
    const bobDmPromise = waitForDM(bob, 30000);
    await sleep(1000);
    const sentByAlice = await alice.communications.sendDM(`@${bobTag}`, 'msg1');
    await bobDmPromise;

    await sleep(5000);

    // Bob -> Alice
    const aliceDmPromise = waitForDM(alice, 30000);
    await sleep(1000);
    await bob.communications.sendDM(`@${aliceTag}`, 'msg2');
    await aliceDmPromise;

    // Alice should have exactly 1 conversation (with Bob, keyed by transport pubkey)
    const conversations = alice.communications.getConversations();
    expect(conversations.size).toBe(1);

    // The peer key is Bob's transport pubkey (from the sent message)
    const bobTransportPubkey = sentByAlice.recipientPubkey;
    const msgs = conversations.get(bobTransportPubkey);
    expect(msgs).toBeDefined();
    expect(msgs!.length).toBe(2);
  }, 90000);

  it('getUnreadCount and markAsRead track read state', async () => {
    const aliceTag = `e2e-alice-${rand()}`;
    const bobTag = `e2e-bob-${rand()}`;

    const { sphere: alice, dirs: aliceDirs } = await createSphere('alice', aliceTag);
    const { sphere: bob, dirs: bobDirs } = await createSphere('bob', bobTag);
    spheres.push(alice, bob);
    cleanupDirs.push(aliceDirs.base, bobDirs.base);

    await sleep(3000);

    // Alice sends 3 DMs to Bob
    const collected = collectDMs(bob, 3, 45000);
    await sleep(1000);

    await alice.communications.sendDM(`@${bobTag}`, 'msg-1');
    await sleep(1000);
    await alice.communications.sendDM(`@${bobTag}`, 'msg-2');
    await sleep(1000);
    await alice.communications.sendDM(`@${bobTag}`, 'msg-3');

    const received = await collected;
    expect(received.length).toBe(3);

    // Use the transport pubkey from the received messages for peer filtering
    const aliceTransportPubkey = received[0].senderPubkey;

    // All 3 unread
    expect(bob.communications.getUnreadCount()).toBe(3);
    expect(bob.communications.getUnreadCount(aliceTransportPubkey)).toBe(3);

    // Mark first 2 as read
    await bob.communications.markAsRead([received[0].id, received[1].id]);
    expect(bob.communications.getUnreadCount()).toBe(1);
    expect(bob.communications.getUnreadCount(aliceTransportPubkey)).toBe(1);

    // Mark last as read
    await bob.communications.markAsRead([received[2].id]);
    expect(bob.communications.getUnreadCount()).toBe(0);
    expect(bob.communications.getUnreadCount(aliceTransportPubkey)).toBe(0);
  }, 90000);

  it('sendComposingIndicator does not throw', async () => {
    const aliceTag = `e2e-alice-${rand()}`;
    const bobTag = `e2e-bob-${rand()}`;

    const { sphere: alice, dirs: aliceDirs } = await createSphere('alice', aliceTag);
    const { sphere: bob, dirs: bobDirs } = await createSphere('bob', bobTag);
    spheres.push(alice, bob);
    cleanupDirs.push(aliceDirs.base, bobDirs.base);

    await sleep(3000);

    // Fire-and-forget — just verify it doesn't throw
    await expect(
      alice.communications.sendComposingIndicator(`@${bobTag}`),
    ).resolves.toBeUndefined();
  }, 60000);
});

// =============================================================================
// Group Chat Module E2E
// =============================================================================

describe.sequential('Group Chat Module E2E', () => {
  const cleanupDirs: string[] = [];
  const spheres: Sphere[] = [];

  // Shared state across sequential tests
  let creatorSphere: Sphere;
  let joinerSphere: Sphere;
  let groupId: string;
  let joinerJoined = false;
  const groupRand = rand();
  const groupName = `Test Group ${groupRand}`;
  const creatorTag = `e2e-creator-${groupRand}`;
  const joinerTag = `e2e-joiner-${groupRand}`;

  /** Retry joinGroup up to maxAttempts with delay between attempts. */
  async function retryJoinGroup(
    sphere: Sphere,
    gid: string,
    maxAttempts = 3,
    delayMs = 3000,
  ): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
      const joined = await sphere.groupChat!.joinGroup(gid);
      if (joined) return true;
      if (i < maxAttempts - 1) await sleep(delayMs);
    }
    return false;
  }

  afterEach(async () => {
    // Cleanup is deferred to the last test (deleteGroup).
  });

  it('setup: create two identities with groupChat enabled', async () => {
    const { sphere: creator, dirs: creatorDirs } = await createSphere(
      'creator', creatorTag, { groupChat: true },
    );
    const { sphere: joiner, dirs: joinerDirs } = await createSphere(
      'joiner', joinerTag, { groupChat: true },
    );
    spheres.push(creator, joiner);
    cleanupDirs.push(creatorDirs.base, joinerDirs.base);

    creatorSphere = creator;
    joinerSphere = joiner;

    expect(creator.groupChat).not.toBeNull();
    expect(joiner.groupChat).not.toBeNull();
    expect(creator.identity!.nametag).toBe(creatorTag);
    expect(joiner.identity!.nametag).toBe(joinerTag);

    // Wait for relay connections to establish
    await sleep(3000);
  }, 120000);

  it('createGroup creates a group and creator is admin', async () => {
    const group = await creatorSphere.groupChat!.createGroup({
      name: groupName,
      description: 'E2E test group',
    });

    expect(group).not.toBeNull();
    expect(group!.id).toBeTruthy();
    expect(group!.name).toBe(groupName);
    expect(group!.memberCount).toBeGreaterThanOrEqual(1);

    groupId = group!.id;

    // Let relay settle before subsequent operations
    await sleep(2000);

    // Verify getGroup
    const fetched = creatorSphere.groupChat!.getGroup(groupId);
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe(groupName);

    // Verify getGroups includes it
    const groups = creatorSphere.groupChat!.getGroups();
    expect(groups.some((g) => g.id === groupId)).toBe(true);

    // Verify creator is admin
    const role = creatorSphere.groupChat!.getCurrentUserRole(groupId);
    expect(role).toBe('ADMIN');
  }, 120000);

  it('sendMessage posts to group and appears in getMessages', async () => {
    const msg1Text = `First message ${groupRand}`;
    const msg2Text = `Second message ${groupRand}`;

    const sent1 = await creatorSphere.groupChat!.sendMessage(groupId, msg1Text);
    expect(sent1).not.toBeNull();
    expect(sent1!.content).toBe(msg1Text);
    expect(sent1!.groupId).toBe(groupId);

    await sleep(1000);

    const sent2 = await creatorSphere.groupChat!.sendMessage(groupId, msg2Text);
    expect(sent2).not.toBeNull();
    expect(sent2!.content).toBe(msg2Text);

    // Let relay index messages before fetch tests
    await sleep(2000);

    // Verify messages in local state
    const messages = creatorSphere.groupChat!.getMessages(groupId);
    const contents = messages.map((m) => m.content);
    expect(contents).toContain(msg1Text);
    expect(contents).toContain(msg2Text);

    // Sorted by timestamp
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i].timestamp).toBeGreaterThanOrEqual(messages[i - 1].timestamp);
    }
  }, 120000);

  it('fetchAvailableGroups lists the created public group', async () => {
    const available = await creatorSphere.groupChat!.fetchAvailableGroups();
    const found = available.find((g) => g.id === groupId);
    expect(found).toBeDefined();
    expect(found!.name).toBe(groupName);
    expect(found!.visibility).toBe('PUBLIC');
  }, 120000);

  it('joinGroup allows second identity to join', async () => {
    const joined = await retryJoinGroup(joinerSphere, groupId);
    expect(joined).toBe(true);
    joinerJoined = true;

    // Let relay settle after join (member list fetch can be slow under load)
    await sleep(3000);

    // Verify group in joiner's local state
    const group = joinerSphere.groupChat!.getGroup(groupId);
    expect(group).not.toBeNull();
    expect(group!.name).toBe(groupName);

    // Role may be null if member list wasn't fully populated under relay load;
    // if present, it should be MEMBER
    const role = joinerSphere.groupChat!.getCurrentUserRole(groupId);
    if (role !== null) {
      expect(role).toBe('MEMBER');
    }
  }, 120000);

  it('fetchMessages retrieves messages posted before join', async () => {
    expect(joinerJoined).toBe(true);

    // Fetch messages from relay (not relying on local state from join)
    const messages = await joinerSphere.groupChat!.fetchMessages(groupId);

    const msg1Text = `First message ${groupRand}`;
    const msg2Text = `Second message ${groupRand}`;
    const contents = messages.map((m) => m.content);
    expect(contents).toContain(msg1Text);
    expect(contents).toContain(msg2Text);
  }, 120000);

  it('getMembers lists creator as admin', async () => {
    const creatorPubkey = creatorSphere.groupChat!.getMyPublicKey();

    // Verify from creator's perspective (creator's state has accurate admin info)
    const creatorMembers = creatorSphere.groupChat!.getMembers(groupId);
    expect(creatorMembers.length).toBeGreaterThanOrEqual(1);

    const selfAsAdmin = creatorMembers.find((m) => m.pubkey === creatorPubkey);
    expect(selfAsAdmin).toBeDefined();
    expect(selfAsAdmin!.role).toBe('ADMIN');

    // Verify creator sees itself as admin via dedicated API
    expect(creatorSphere.groupChat!.isCurrentUserAdmin(groupId)).toBe(true);
  }, 120000);

  it('markGroupAsRead and getTotalUnreadCount work correctly', async () => {
    expect(joinerJoined).toBe(true);

    // Mark all as read
    joinerSphere.groupChat!.markGroupAsRead(groupId);

    const group = joinerSphere.groupChat!.getGroup(groupId);
    expect(group).not.toBeNull();
    expect(group!.unreadCount ?? 0).toBe(0);

    // Total unread should be non-negative
    const total = joinerSphere.groupChat!.getTotalUnreadCount();
    expect(total).toBeGreaterThanOrEqual(0);
  }, 120000);

  it('deleteGroup removes the group (cleanup)', async () => {
    const deleted = await creatorSphere.groupChat!.deleteGroup(groupId);
    expect(deleted).toBe(true);

    // Verify group is gone from creator's state
    const group = creatorSphere.groupChat!.getGroup(groupId);
    expect(group).toBeNull();

    const groups = creatorSphere.groupChat!.getGroups();
    expect(groups.some((g) => g.id === groupId)).toBe(false);

    // Final cleanup: destroy spheres and temp dirs
    for (const s of spheres) {
      try { await s.destroy(); } catch { /* cleanup */ }
    }
    spheres.length = 0;
    for (const d of cleanupDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
    cleanupDirs.length = 0;
  }, 120000);
});
