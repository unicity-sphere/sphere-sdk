/**
 * Group Chat Module (NIP-29)
 *
 * Relay-based group chat using NIP-29 protocol on a dedicated Nostr relay.
 * Embeds its own NostrClient — does NOT share the wallet's TransportProvider.
 */

import {
  NostrClient,
  NostrKeyManager,
  Filter,
  type Event,
} from '@unicitylabs/nostr-js-sdk';

import { logger } from '../../core/logger';
import { SphereError } from '../../core/errors';

import type {
  FullIdentity,
  SphereEventType,
  SphereEventMap,
} from '../../types';
import type { StorageProvider } from '../../storage';
import { STORAGE_KEYS_GLOBAL, STORAGE_KEYS_ADDRESS, NIP29_KINDS } from '../../constants';

import type {
  GroupData,
  GroupMessageData,
  GroupMemberData,
  GroupChatModuleConfig,
  CreateGroupOptions,
  GroupRole,
} from './types';
import { GroupRole as GroupRoleEnum, GroupVisibility as GroupVisibilityEnum } from './types';

// =============================================================================
// Dependencies
// =============================================================================

export interface GroupChatModuleDependencies {
  identity: FullIdentity;
  storage: StorageProvider;
  emitEvent: <T extends SphereEventType>(type: T, data: SphereEventMap[T]) => void;
}

// =============================================================================
// NIP-29 Filter Helper
// =============================================================================

/**
 * Extended filter data for NIP-29 queries.
 * NIP-29 uses 'h' tags for group IDs which aren't in the standard Filter type.
 */
interface Nip29FilterData {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  '#e'?: string[];
  '#p'?: string[];
  '#t'?: string[];
  '#d'?: string[];
  '#h'?: string[];
  since?: number;
  until?: number;
  limit?: number;
}

function createNip29Filter(data: Nip29FilterData): Filter {
  return new Filter(data as ConstructorParameters<typeof Filter>[0]);
}

// =============================================================================
// Implementation
// =============================================================================

export class GroupChatModule {
  private config: Required<GroupChatModuleConfig>;
  private deps: GroupChatModuleDependencies | null = null;

  // Nostr connection (separate from wallet relay)
  private client: NostrClient | null = null;
  private keyManager: NostrKeyManager | null = null;
  private connected = false;
  private connecting = false;
  private connectPromise: Promise<void> | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Subscription tracking (for cleanup)
  private subscriptionIds: string[] = [];

  // In-memory state
  private groups: Map<string, GroupData> = new Map();
  private messages: Map<string, GroupMessageData[]> = new Map(); // groupId -> messages
  private members: Map<string, GroupMemberData[]> = new Map();   // groupId -> members
  private processedEventIds: Set<string> = new Set();
  private pendingLeaves: Set<string> = new Set();

  // Persistence debounce
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistPromise: Promise<void> | null = null;

  // Relay admin cache
  private relayAdminPubkeys: Set<string> | null = null;
  private relayAdminFetchPromise: Promise<Set<string>> | null = null;

  // Listeners
  private messageHandlers: Set<(message: GroupMessageData) => void> = new Set();

  constructor(config?: GroupChatModuleConfig) {
    this.config = {
      relays: config?.relays ?? [],
      defaultMessageLimit: config?.defaultMessageLimit ?? 50,
      maxPreviousTags: config?.maxPreviousTags ?? 3,
      reconnectDelayMs: config?.reconnectDelayMs ?? 3000,
      maxReconnectAttempts: config?.maxReconnectAttempts ?? 5,
    };
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  initialize(deps: GroupChatModuleDependencies): void {
    // If re-initializing (address switch), destroy old connection
    if (this.deps) {
      this.destroyConnection();
    }

    this.deps = deps;

    // Create key manager from identity
    const secretKey = Buffer.from(deps.identity.privateKey, 'hex');
    this.keyManager = NostrKeyManager.fromPrivateKey(secretKey);
  }

  async load(): Promise<void> {
    this.ensureInitialized();
    const storage = this.deps!.storage;

    // Always clear in-memory state first so stale data from a previous
    // address never leaks into the newly loaded address.
    this.groups.clear();
    this.messages.clear();
    this.members.clear();
    this.processedEventIds.clear();

    // Load groups
    const groupsJson = await storage.get(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS);
    if (groupsJson) {
      try {
        const parsed: GroupData[] = JSON.parse(groupsJson);
        for (const g of parsed) {
          this.groups.set(g.id, g);
        }
      } catch {
        // Corrupted data, start fresh
      }
    }

    // Load messages
    const messagesJson = await storage.get(STORAGE_KEYS_ADDRESS.GROUP_CHAT_MESSAGES);
    if (messagesJson) {
      try {
        const parsed: GroupMessageData[] = JSON.parse(messagesJson);
        for (const m of parsed) {
          const groupId = m.groupId;
          if (!this.messages.has(groupId)) {
            this.messages.set(groupId, []);
          }
          this.messages.get(groupId)!.push(m);
        }
      } catch {
        // Corrupted data, start fresh
      }
    }

    // Load members
    const membersJson = await storage.get(STORAGE_KEYS_ADDRESS.GROUP_CHAT_MEMBERS);
    if (membersJson) {
      try {
        const parsed: GroupMemberData[] = JSON.parse(membersJson);
        for (const m of parsed) {
          const groupId = m.groupId;
          if (!this.members.has(groupId)) {
            this.members.set(groupId, []);
          }
          this.members.get(groupId)!.push(m);
        }
      } catch {
        // Corrupted data, start fresh
      }
    }

    // Load processed event IDs
    const processedJson = await storage.get(STORAGE_KEYS_ADDRESS.GROUP_CHAT_PROCESSED_EVENTS);
    if (processedJson) {
      try {
        const parsed: string[] = JSON.parse(processedJson);
        this.processedEventIds = new Set(parsed);
      } catch {
        // Start fresh
      }
    }
  }

  destroy(): void {
    this.destroyConnection();
    this.groups.clear();
    this.messages.clear();
    this.members.clear();
    this.processedEventIds.clear();
    this.pendingLeaves.clear();
    this.messageHandlers.clear();
    this.relayAdminPubkeys = null;
    this.relayAdminFetchPromise = null;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.deps = null;
  }

  private destroyConnection(): void {
    // Cancel pending reconnect
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Unsubscribe all active subscriptions
    if (this.client) {
      for (const subId of this.subscriptionIds) {
        try { this.client.unsubscribe(subId); } catch (err) { logger.debug('GroupChat', 'Failed to unsubscribe', err); }
      }
      this.subscriptionIds = [];
      try {
        this.client.disconnect();
      } catch (err) {
        logger.debug('GroupChat', 'Failed to disconnect', err);
      }
      this.client = null;
    }
    this.connected = false;
    this.connecting = false;
    this.connectPromise = null;
    this.reconnectAttempts = 0;
    this.keyManager = null;
  }

  // ===========================================================================
  // Connection
  // ===========================================================================

  async connect(): Promise<void> {
    if (this.connected) {
      // Already connected — refresh subscriptions for the current address
      // (e.g., after load() switched to a different address's data).
      await this.refreshSubscriptions();
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connecting = true;
    this.connectPromise = this.doConnect().finally(() => {
      this.connecting = false;
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  getConnectionStatus(): boolean {
    return this.connected;
  }

  /**
   * Refresh subscriptions after load() switched to a different address.
   * Clears old subscriptions, restores groups if needed, and re-subscribes.
   */
  private async refreshSubscriptions(): Promise<void> {
    if (!this.client) return;

    // Clear old subscriptions (for previous address's groups)
    for (const subId of this.subscriptionIds) {
      try { this.client.unsubscribe(subId); } catch (err) { logger.debug('GroupChat', 'Failed to unsubscribe', err); }
    }
    this.subscriptionIds = [];

    // Update key manager for new identity
    const secretKey = Buffer.from(this.deps!.identity.privateKey, 'hex');
    this.keyManager = NostrKeyManager.fromPrivateKey(secretKey);

    if (this.groups.size === 0) {
      await this.restoreJoinedGroups();
    } else {
      await this.subscribeToJoinedGroups();
    }

    this.deps!.emitEvent('groupchat:connection', { connected: true });
  }

  private async doConnect(): Promise<void> {
    this.ensureInitialized();

    if (!this.keyManager) {
      const secretKey = Buffer.from(this.deps!.identity.privateKey, 'hex');
      this.keyManager = NostrKeyManager.fromPrivateKey(secretKey);
    }

    // Check relay URL change and clear stale data
    const primaryRelay = this.config.relays[0];
    if (primaryRelay) {
      await this.checkAndClearOnRelayChange(primaryRelay);
    }

    this.client = new NostrClient(this.keyManager);

    try {
      await this.client.connect(...this.config.relays);
      this.connected = true;
      this.reconnectAttempts = 0;

      // Check if we have local groups
      if (this.groups.size === 0) {
        // No local groups — try to restore from relay (e.g., after wallet import)
        await this.restoreJoinedGroups();
      } else {
        // Subscribe to events for existing joined groups
        await this.subscribeToJoinedGroups();
      }

      // Emit connection event AFTER groups are loaded/subscribed,
      // so consumers don't query getGroups() while restoreJoinedGroups() is still running.
      this.deps!.emitEvent('groupchat:connection', { connected: true });
    } catch (error) {
      logger.error('GroupChat', 'Failed to connect to relays', error);
      this.deps!.emitEvent('groupchat:connection', { connected: false });
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      logger.error('GroupChat', 'Max reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.deps) { // Guard against post-destroy fire
        this.connect().catch((err) => logger.error('GroupChat', 'Reconnect failed:', err));
      }
    }, this.config.reconnectDelayMs);
  }

  // ===========================================================================
  // Subscription Management
  // ===========================================================================

  private async subscribeToJoinedGroups(): Promise<void> {
    if (!this.client) return;

    const groupIds = Array.from(this.groups.keys());
    if (groupIds.length === 0) return;

    // Use the latest message timestamp across all groups as the `since` floor
    // so the relay only sends events newer than what we already have.
    const latestTimestamp = this.getLatestMessageTimestamp(groupIds);

    // Subscribe to group messages
    this.trackSubscription(
      createNip29Filter({
        kinds: [NIP29_KINDS.CHAT_MESSAGE, NIP29_KINDS.THREAD_ROOT, NIP29_KINDS.THREAD_REPLY],
        '#h': groupIds,
        ...(latestTimestamp ? { since: latestTimestamp } : {}),
      }),
      { onEvent: (event: Event) => this.handleGroupEvent(event) },
    );

    // Subscribe to group metadata changes
    this.trackSubscription(
      createNip29Filter({
        kinds: [NIP29_KINDS.GROUP_METADATA, NIP29_KINDS.GROUP_MEMBERS, NIP29_KINDS.GROUP_ADMINS],
        '#d': groupIds,
      }),
      { onEvent: (event: Event) => this.handleMetadataEvent(event) },
    );

    // Subscribe to moderation events
    this.trackSubscription(
      createNip29Filter({
        kinds: [NIP29_KINDS.DELETE_EVENT, NIP29_KINDS.REMOVE_USER, NIP29_KINDS.DELETE_GROUP],
        '#h': groupIds,
      }),
      { onEvent: (event: Event) => this.handleModerationEvent(event) },
    );
  }

  private subscribeToGroup(groupId: string): void {
    if (!this.client) return;

    const latestTimestamp = this.getLatestMessageTimestamp([groupId]);

    this.trackSubscription(
      createNip29Filter({
        kinds: [NIP29_KINDS.CHAT_MESSAGE, NIP29_KINDS.THREAD_ROOT, NIP29_KINDS.THREAD_REPLY],
        '#h': [groupId],
        ...(latestTimestamp ? { since: latestTimestamp } : {}),
      }),
      { onEvent: (event: Event) => this.handleGroupEvent(event) },
    );

    this.trackSubscription(
      createNip29Filter({
        kinds: [NIP29_KINDS.DELETE_EVENT, NIP29_KINDS.REMOVE_USER, NIP29_KINDS.DELETE_GROUP],
        '#h': [groupId],
      }),
      { onEvent: (event: Event) => this.handleModerationEvent(event) },
    );
  }

  // ===========================================================================
  // Event Handlers
  // ===========================================================================

  private handleGroupEvent(event: Event): void {
    if (this.processedEventIds.has(event.id)) return;

    const groupId = this.getGroupIdFromEvent(event);
    if (!groupId) return;

    const group = this.groups.get(groupId);
    if (!group) return;

    const { text: content, senderNametag } = this.unwrapMessageContent(event.content);

    const message: GroupMessageData = {
      id: event.id,
      groupId,
      content,
      timestamp: event.created_at * 1000,
      senderPubkey: event.pubkey,
      senderNametag: senderNametag || undefined,
      replyToId: this.extractReplyTo(event),
      previousIds: this.extractPreviousIds(event),
    };

    this.saveMessageToMemory(message);
    this.addProcessedEventId(event.id);

    // Update or create member with nametag from this message
    if (senderNametag) {
      this.updateMemberNametag(groupId, event.pubkey, senderNametag, event.created_at * 1000);
    }

    // Update group last message and unread count
    this.updateGroupLastMessage(groupId, content.slice(0, 100), message.timestamp);
    const myPubkey = this.getMyPublicKey();
    if (event.pubkey !== myPubkey) {
      group.unreadCount = (group.unreadCount || 0) + 1;
    }

    // Emit event and notify listeners
    this.deps!.emitEvent('groupchat:message', message);
    this.deps!.emitEvent('groupchat:updated', {} as Record<string, never>);
    for (const handler of this.messageHandlers) {
      try { handler(message); } catch { /* ignore handler errors */ }
    }

    this.schedulePersist();
  }

  private handleMetadataEvent(event: Event): void {
    const groupId = this.getGroupIdFromMetadataEvent(event);
    if (!groupId) return;

    const group = this.groups.get(groupId);
    if (!group) return;

    if (event.kind === NIP29_KINDS.GROUP_METADATA) {
      if (!event.content || event.content.trim() === '') return;
      try {
        const metadata = JSON.parse(event.content);
        group.name = metadata.name || group.name;
        group.description = metadata.about || group.description;
        group.picture = metadata.picture || group.picture;
        group.updatedAt = event.created_at * 1000;
        this.groups.set(groupId, group);
        this.persistGroups();
      } catch {
        // Skip malformed metadata
      }
    } else if (event.kind === NIP29_KINDS.GROUP_MEMBERS) {
      this.updateMembersFromEvent(groupId, event);
    } else if (event.kind === NIP29_KINDS.GROUP_ADMINS) {
      this.updateAdminsFromEvent(groupId, event);
    }
  }

  private handleModerationEvent(event: Event): void {
    const groupId = this.getGroupIdFromEvent(event);
    if (!groupId) return;

    const group = this.groups.get(groupId);
    if (!group) return;

    if (event.kind === NIP29_KINDS.DELETE_EVENT) {
      const eTags = event.tags.filter((t: string[]) => t[0] === 'e');
      for (const tag of eTags) {
        const messageId = tag[1];
        if (messageId) {
          this.deleteMessageFromMemory(groupId, messageId);
        }
      }
      this.deps!.emitEvent('groupchat:updated', {} as Record<string, never>);
      this.persistMessages();
    } else if (event.kind === NIP29_KINDS.REMOVE_USER) {
      if (this.processedEventIds.has(event.id)) return;

      // Ignore events before we joined
      const eventTimestampMs = event.created_at * 1000;
      if (group.localJoinedAt && eventTimestampMs < group.localJoinedAt) {
        this.addProcessedEventId(event.id);
        return;
      }

      this.addProcessedEventId(event.id);

      const pTags = event.tags.filter((t: string[]) => t[0] === 'p');
      const myPubkey = this.getMyPublicKey();

      for (const tag of pTags) {
        const removedPubkey = tag[1];
        if (!removedPubkey) continue;

        if (removedPubkey === myPubkey) {
          if (this.pendingLeaves.has(groupId)) {
            // Voluntary leave
            this.pendingLeaves.delete(groupId);
            this.deps!.emitEvent('groupchat:updated', {} as Record<string, never>);
          } else {
            // Kicked by admin
            const groupName = group.name || groupId;
            this.removeGroupFromMemory(groupId);
            this.deps!.emitEvent('groupchat:kicked', { groupId, groupName });
            this.deps!.emitEvent('groupchat:updated', {} as Record<string, never>);
          }
        } else {
          // Someone else was kicked
          this.removeMemberFromMemory(groupId, removedPubkey);
        }
      }
      this.schedulePersist();
    } else if (event.kind === NIP29_KINDS.DELETE_GROUP) {
      if (this.processedEventIds.has(event.id)) return;

      const deleteTimestampMs = event.created_at * 1000;
      if (deleteTimestampMs < group.createdAt) {
        this.addProcessedEventId(event.id);
        return;
      }

      this.addProcessedEventId(event.id);

      const groupName = group.name || groupId;
      this.removeGroupFromMemory(groupId);
      this.deps!.emitEvent('groupchat:group_deleted', { groupId, groupName });
      this.deps!.emitEvent('groupchat:updated', {} as Record<string, never>);
      this.schedulePersist();
    }
  }

  private updateMembersFromEvent(groupId: string, event: Event): void {
    const pTags = event.tags.filter((t: string[]) => t[0] === 'p');
    const existingMembers = this.members.get(groupId) || [];

    for (const tag of pTags) {
      const pubkey = tag[1];
      const roleFromTag = tag[3] as GroupRole | undefined;
      const existing = existingMembers.find((m) => m.pubkey === pubkey);
      const role = roleFromTag || existing?.role || GroupRoleEnum.MEMBER;

      const member: GroupMemberData = {
        pubkey,
        groupId,
        role,
        nametag: existing?.nametag,
        joinedAt: existing?.joinedAt || event.created_at * 1000,
      };

      this.saveMemberToMemory(member);
    }
    this.persistMembers();
  }

  private updateAdminsFromEvent(groupId: string, event: Event): void {
    const pTags = event.tags.filter((t: string[]) => t[0] === 'p');
    const existingMembers = this.members.get(groupId) || [];

    for (const tag of pTags) {
      const pubkey = tag[1];
      const existing = existingMembers.find((m) => m.pubkey === pubkey);

      if (existing) {
        existing.role = GroupRoleEnum.ADMIN;
        this.saveMemberToMemory(existing);
      } else {
        this.saveMemberToMemory({
          pubkey,
          groupId,
          role: GroupRoleEnum.ADMIN,
          joinedAt: event.created_at * 1000,
        });
      }
    }
    this.persistMembers();
  }

  // ===========================================================================
  // Group Membership Restoration
  // ===========================================================================

  private async restoreJoinedGroups(): Promise<GroupData[]> {
    if (!this.client) return [];

    const myPubkey = this.getMyPublicKey();
    if (!myPubkey) return [];

    const groupIdsWithMembership = new Set<string>();

    await this.oneshotSubscription(
      new Filter({ kinds: [NIP29_KINDS.GROUP_MEMBERS] }),
      {
        onEvent: (event: Event) => {
          const groupId = this.getGroupIdFromMetadataEvent(event);
          if (!groupId) return;
          const pTags = event.tags.filter((t: string[]) => t[0] === 'p');
          if (pTags.some((tag: string[]) => tag[1] === myPubkey)) {
            groupIdsWithMembership.add(groupId);
          }
        },
        onComplete: () => {},
        timeoutMs: 15000,
        timeoutLabel: 'restoreJoinedGroups',
      },
    );

    if (groupIdsWithMembership.size === 0) return [];

    const restoredGroups: GroupData[] = [];

    for (const groupId of groupIdsWithMembership) {
      if (this.groups.has(groupId)) continue;

      try {
        const group = await this.fetchGroupMetadataInternal(groupId);
        if (group) {
          this.groups.set(groupId, group);
          restoredGroups.push(group);

          await Promise.all([
            this.fetchAndSaveMembers(groupId),
            this.fetchMessages(groupId),
          ]);
        }
      } catch (error) {
        logger.warn('GroupChat', 'Failed to restore group', groupId, error);
      }
    }

    if (restoredGroups.length > 0) {
      await this.subscribeToJoinedGroups();
      this.deps!.emitEvent('groupchat:updated', {} as Record<string, never>);
      this.schedulePersist();
    }

    return restoredGroups;
  }

  // ===========================================================================
  // Public API — Groups
  // ===========================================================================

  async fetchAvailableGroups(): Promise<GroupData[]> {
    await this.ensureConnected();
    if (!this.client) return [];

    const groupsMap = new Map<string, GroupData>();
    const memberCountsMap = new Map<string, number>();

    await Promise.all([
      this.oneshotSubscription(
        new Filter({ kinds: [NIP29_KINDS.GROUP_METADATA] }),
        {
          onEvent: (event: Event) => {
            const group = this.parseGroupMetadata(event);
            if (group && group.visibility === GroupVisibilityEnum.PUBLIC) {
              const existing = groupsMap.get(group.id);
              if (!existing || group.createdAt > existing.createdAt) {
                groupsMap.set(group.id, group);
              }
            }
          },
          onComplete: () => {},
          timeoutMs: 10000,
          timeoutLabel: 'fetchAvailableGroups(metadata)',
        },
      ),
      this.oneshotSubscription(
        new Filter({ kinds: [NIP29_KINDS.GROUP_MEMBERS] }),
        {
          onEvent: (event: Event) => {
            const groupId = this.getGroupIdFromMetadataEvent(event);
            if (groupId) {
              const pTags = event.tags.filter((t: string[]) => t[0] === 'p');
              memberCountsMap.set(groupId, pTags.length);
            }
          },
          onComplete: () => {},
          timeoutMs: 10000,
          timeoutLabel: 'fetchAvailableGroups(members)',
        },
      ),
    ]);

    for (const [groupId, count] of memberCountsMap) {
      const group = groupsMap.get(groupId);
      if (group) group.memberCount = count;
    }

    return Array.from(groupsMap.values());
  }

  async joinGroup(groupId: string, inviteCode?: string): Promise<boolean> {
    await this.ensureConnected();
    if (!this.client) return false;

    try {
      let group = await this.fetchGroupMetadataInternal(groupId);

      if (!group && !inviteCode) return false;

      const tags: string[][] = [['h', groupId]];
      if (inviteCode) tags.push(['code', inviteCode]);

      const eventId = await this.client.createAndPublishEvent({
        kind: NIP29_KINDS.JOIN_REQUEST,
        tags,
        content: '',
      });

      if (eventId) {
        // For hidden groups, fetch metadata now that we're a member
        if (!group) {
          group = await this.fetchGroupMetadataInternal(groupId);
          if (!group) return false;
        }

        group.localJoinedAt = Date.now();
        this.groups.set(groupId, group);
        this.subscribeToGroup(groupId);

        await Promise.all([
          this.fetchMessages(groupId),
          this.fetchAndSaveMembers(groupId),
        ]);

        this.deps!.emitEvent('groupchat:joined', { groupId, groupName: group.name });
        this.deps!.emitEvent('groupchat:updated', {} as Record<string, never>);
        this.persistAll();
        return true;
      }

      return false;
    } catch (error) {
      // Handle "already a member" as success
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('already a member')) {
        const group = await this.fetchGroupMetadataInternal(groupId);
        if (group) {
          group.localJoinedAt = Date.now();
          this.groups.set(groupId, group);
          this.subscribeToGroup(groupId);
          await Promise.all([
            this.fetchMessages(groupId),
            this.fetchAndSaveMembers(groupId),
          ]);
          this.deps!.emitEvent('groupchat:joined', { groupId, groupName: group.name });
          this.deps!.emitEvent('groupchat:updated', {} as Record<string, never>);
          this.persistAll();
          return true;
        }
      }
      logger.error('GroupChat', 'Failed to join group', error);
      return false;
    }
  }

  async leaveGroup(groupId: string): Promise<boolean> {
    await this.ensureConnected();
    if (!this.client) return false;

    try {
      this.pendingLeaves.add(groupId);

      const eventId = await this.client.createAndPublishEvent({
        kind: NIP29_KINDS.LEAVE_REQUEST,
        tags: [['h', groupId]],
        content: '',
      });

      if (eventId) {
        this.removeGroupFromMemory(groupId);
        this.deps!.emitEvent('groupchat:left', { groupId });
        this.deps!.emitEvent('groupchat:updated', {} as Record<string, never>);
        this.persistAll();
        return true;
      }

      this.pendingLeaves.delete(groupId);
      return false;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('group not found') || msg.includes('not a member')) {
        this.removeGroupFromMemory(groupId);
        this.persistAll();
        return true;
      }
      logger.error('GroupChat', 'Failed to leave group', error);
      return false;
    }
  }

  async createGroup(options: CreateGroupOptions): Promise<GroupData | null> {
    await this.ensureConnected();
    if (!this.client) return null;

    const creatorPubkey = this.getMyPublicKey();
    if (!creatorPubkey) return null;

    const proposedGroupId = options.name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 20) || this.randomId();

    try {
      const isPrivate = options.visibility === GroupVisibilityEnum.PRIVATE;

      // Publish CREATE_GROUP first, then fetch the metadata.
      // The relay creates the group synchronously, so by the time the OK
      // response arrives the GROUP_METADATA event is queryable.
      const eventId = await this.client.createAndPublishEvent({
        kind: NIP29_KINDS.CREATE_GROUP,
        tags: [['h', proposedGroupId]],
        content: JSON.stringify({
          name: options.name,
          about: options.description,
          picture: options.picture,
          closed: true,
          private: isPrivate,
          hidden: isPrivate,
        }),
      });

      if (!eventId) return null;

      // Fetch the group metadata the relay created for us
      let group = await this.fetchGroupMetadataInternal(proposedGroupId);

      if (!group) {
        // Fallback: build group data from what we know
        group = {
          id: proposedGroupId,
          relayUrl: this.config.relays[0] || '',
          name: options.name,
          description: options.description,
          visibility: options.visibility || GroupVisibilityEnum.PUBLIC,
          createdAt: Date.now(),
          memberCount: 1,
        };
      }

      if (!group.name || group.name === 'Unnamed Group') {
        group.name = options.name;
      }
      if (options.description && !group.description) {
        group.description = options.description;
      }
      group.visibility = options.visibility || GroupVisibilityEnum.PUBLIC;
      group.memberCount = 1;

      this.groups.set(group.id, group);

      this.subscribeToGroup(group.id);

      this.client!.createAndPublishEvent({
        kind: NIP29_KINDS.JOIN_REQUEST,
        tags: [['h', group.id]],
        content: '',
      }).catch((err) => logger.debug('GroupChat', 'Background operation failed', err));

      // Fetch member/admin lists, then ensure creator is always admin.
      // The fetch can return incomplete data if the relay hasn't indexed
      // the admin event yet, so we re-assert after.
      await this.fetchAndSaveMembers(group.id).catch((err) => logger.debug('GroupChat', 'Failed to fetch members', group.id, err));
      this.saveMemberToMemory({
        pubkey: creatorPubkey,
        groupId: group.id,
        role: GroupRoleEnum.ADMIN,
        joinedAt: Date.now(),
      });

      this.deps!.emitEvent('groupchat:joined', { groupId: group.id, groupName: group.name });
      this.deps!.emitEvent('groupchat:updated', {} as Record<string, never>);
      this.schedulePersist();

      return group;
    } catch (error) {
      logger.error('GroupChat', 'Failed to create group', error);
      return null;
    }
  }

  async deleteGroup(groupId: string): Promise<boolean> {
    await this.ensureConnected();
    if (!this.client) return false;

    const group = this.groups.get(groupId);
    if (!group) return false;

    // Relay admins can delete public groups; group admins can delete their own groups
    const canDelete = await this.canModerateGroup(groupId);
    if (!canDelete) return false;

    try {
      const eventId = await this.client.createAndPublishEvent({
        kind: NIP29_KINDS.DELETE_GROUP,
        tags: [['h', groupId]],
        content: '',
      });

      if (eventId) {
        const groupName = group.name || groupId;
        this.removeGroupFromMemory(groupId);
        this.deps!.emitEvent('groupchat:group_deleted', { groupId, groupName });
        this.deps!.emitEvent('groupchat:updated', {} as Record<string, never>);
        this.persistAll();
        return true;
      }
      return false;
    } catch (error) {
      logger.error('GroupChat', 'Failed to delete group', error);
      return false;
    }
  }

  async createInvite(groupId: string): Promise<string | null> {
    await this.ensureConnected();
    if (!this.client) return null;

    if (!this.isCurrentUserAdmin(groupId)) return null;

    try {
      const inviteCode = this.randomId();

      const eventId = await this.client.createAndPublishEvent({
        kind: NIP29_KINDS.CREATE_INVITE,
        tags: [
          ['h', groupId],
          ['code', inviteCode],
        ],
        content: '',
      });

      return eventId ? inviteCode : null;
    } catch (error) {
      logger.error('GroupChat', 'Failed to create invite', error);
      return null;
    }
  }

  // ===========================================================================
  // Public API — Messages
  // ===========================================================================

  async sendMessage(
    groupId: string,
    content: string,
    replyToId?: string,
  ): Promise<GroupMessageData | null> {
    await this.ensureConnected();
    if (!this.client) return null;

    const group = this.groups.get(groupId);
    if (!group) return null;

    try {
      const senderNametag = this.deps!.identity.nametag || null;
      const kind = replyToId ? NIP29_KINDS.THREAD_REPLY : NIP29_KINDS.CHAT_MESSAGE;

      const tags: string[][] = [['h', groupId]];

      // Add previous message IDs for ordering
      const groupMessages = this.messages.get(groupId) || [];
      const recentIds = groupMessages
        .slice(-this.config.maxPreviousTags)
        .map((m) => (m.id || '').slice(0, 8))
        .filter(Boolean);
      if (recentIds.length > 0) {
        tags.push(['previous', ...recentIds]);
      }

      if (replyToId) {
        tags.push(['e', replyToId, '', 'reply']);
      }

      const wrappedContent = this.wrapMessageContent(content, senderNametag);

      const eventId = await this.client.createAndPublishEvent({
        kind,
        tags,
        content: wrappedContent,
      });

      if (eventId) {
        const myPubkey = this.getMyPublicKey();
        const message: GroupMessageData = {
          id: eventId,
          groupId,
          content,
          timestamp: Date.now(),
          senderPubkey: myPubkey || '',
          senderNametag: senderNametag || undefined,
          replyToId,
          previousIds: recentIds,
        };

        this.saveMessageToMemory(message);
        this.addProcessedEventId(eventId);
        this.updateGroupLastMessage(groupId, content.slice(0, 100), message.timestamp);
        this.persistAll();
        return message;
      }
      return null;
    } catch (error) {
      logger.error('GroupChat', 'Failed to send message', error);
      return null;
    }
  }

  async fetchMessages(
    groupId: string,
    since?: number,
    limit?: number,
  ): Promise<GroupMessageData[]> {
    await this.ensureConnected();
    if (!this.client) return [];

    const fetchedMessages: GroupMessageData[] = [];
    const filterData: Nip29FilterData = {
      kinds: [NIP29_KINDS.CHAT_MESSAGE, NIP29_KINDS.THREAD_ROOT, NIP29_KINDS.THREAD_REPLY],
      '#h': [groupId],
    };

    if (since) filterData.since = Math.floor(since / 1000);
    if (limit) filterData.limit = limit;
    if (!limit && !since) filterData.limit = this.config.defaultMessageLimit;

    return this.oneshotSubscription(createNip29Filter(filterData), {
      onEvent: (event: Event) => {
        const { text: content, senderNametag } = this.unwrapMessageContent(event.content);

        const message: GroupMessageData = {
          id: event.id,
          groupId,
          content,
          timestamp: event.created_at * 1000,
          senderPubkey: event.pubkey,
          senderNametag: senderNametag || undefined,
          replyToId: this.extractReplyTo(event),
          previousIds: this.extractPreviousIds(event),
        };

        fetchedMessages.push(message);
        this.saveMessageToMemory(message);
        this.addProcessedEventId(event.id);

        if (senderNametag) {
          this.updateMemberNametag(groupId, event.pubkey, senderNametag, event.created_at * 1000);
        }
      },
      onComplete: () => {
        this.schedulePersist();
        return fetchedMessages;
      },
      timeoutMs: 10000,
      timeoutLabel: `fetchMessages(${groupId})`,
    });
  }

  // ===========================================================================
  // Public API — Queries (from local state)
  // ===========================================================================

  getGroups(): GroupData[] {
    return Array.from(this.groups.values())
      .sort((a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0));
  }

  getGroup(groupId: string): GroupData | null {
    return this.groups.get(groupId) || null;
  }

  getMessages(groupId: string): GroupMessageData[] {
    return (this.messages.get(groupId) || [])
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  getMembers(groupId: string): GroupMemberData[] {
    return (this.members.get(groupId) || [])
      .sort((a, b) => a.joinedAt - b.joinedAt);
  }

  getMember(groupId: string, pubkey: string): GroupMemberData | null {
    const members = this.members.get(groupId) || [];
    return members.find((m) => m.pubkey === pubkey) || null;
  }

  getTotalUnreadCount(): number {
    let total = 0;
    for (const group of this.groups.values()) {
      total += group.unreadCount || 0;
    }
    return total;
  }

  markGroupAsRead(groupId: string): void {
    const group = this.groups.get(groupId);
    if (group && (group.unreadCount || 0) > 0) {
      group.unreadCount = 0;
      this.groups.set(groupId, group);
      this.persistGroups();
    }
  }

  // ===========================================================================
  // Public API — Admin
  // ===========================================================================

  async kickUser(groupId: string, userPubkey: string, reason?: string): Promise<boolean> {
    await this.ensureConnected();
    if (!this.client) return false;

    const canModerate = await this.canModerateGroup(groupId);
    if (!canModerate) return false;

    const myPubkey = this.getMyPublicKey();
    if (myPubkey === userPubkey) return false;

    try {
      const eventId = await this.client.createAndPublishEvent({
        kind: NIP29_KINDS.REMOVE_USER,
        tags: [['h', groupId], ['p', userPubkey]],
        content: reason || '',
      });

      if (eventId) {
        this.removeMemberFromMemory(groupId, userPubkey);
        this.deps!.emitEvent('groupchat:updated', {} as Record<string, never>);
        this.persistMembers();
        return true;
      }
      return false;
    } catch (error) {
      logger.error('GroupChat', 'Failed to kick user', error);
      return false;
    }
  }

  async deleteMessage(groupId: string, messageId: string): Promise<boolean> {
    await this.ensureConnected();
    if (!this.client) return false;

    const canModerate = await this.canModerateGroup(groupId);
    if (!canModerate) return false;

    try {
      const eventId = await this.client.createAndPublishEvent({
        kind: NIP29_KINDS.DELETE_EVENT,
        tags: [['h', groupId], ['e', messageId]],
        content: '',
      });

      if (eventId) {
        this.deleteMessageFromMemory(groupId, messageId);
        this.deps!.emitEvent('groupchat:updated', {} as Record<string, never>);
        this.persistMessages();
        return true;
      }
      return false;
    } catch (error) {
      logger.error('GroupChat', 'Failed to delete message', error);
      return false;
    }
  }

  isCurrentUserAdmin(groupId: string): boolean {
    const myPubkey = this.getMyPublicKey();
    if (!myPubkey) return false;

    const member = this.getMember(groupId, myPubkey);
    return member?.role === GroupRoleEnum.ADMIN;
  }

  isCurrentUserModerator(groupId: string): boolean {
    const myPubkey = this.getMyPublicKey();
    if (!myPubkey) return false;

    const member = this.getMember(groupId, myPubkey);
    return member?.role === GroupRoleEnum.ADMIN || member?.role === GroupRoleEnum.MODERATOR;
  }

  /**
   * Check if current user can moderate a group:
   * - Group admin/moderator can always moderate their group
   * - Relay admins can moderate public groups
   */
  async canModerateGroup(groupId: string): Promise<boolean> {
    if (this.isCurrentUserAdmin(groupId) || this.isCurrentUserModerator(groupId)) {
      return true;
    }
    const group = this.groups.get(groupId);
    if (group && group.visibility === GroupVisibilityEnum.PUBLIC) {
      return this.isCurrentUserRelayAdmin();
    }
    return false;
  }

  async isCurrentUserRelayAdmin(): Promise<boolean> {
    const myPubkey = this.getMyPublicKey();
    if (!myPubkey) return false;

    const admins = await this.fetchRelayAdmins();
    return admins.has(myPubkey);
  }

  getCurrentUserRole(groupId: string): GroupRole | null {
    const myPubkey = this.getMyPublicKey();
    if (!myPubkey) return null;

    const member = this.getMember(groupId, myPubkey);
    return member?.role || null;
  }

  // ===========================================================================
  // Public API — Listeners
  // ===========================================================================

  onMessage(handler: (message: GroupMessageData) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  // ===========================================================================
  // Public API — Utilities
  // ===========================================================================

  getRelayUrls(): string[] {
    return this.config.relays;
  }

  getMyPublicKey(): string | null {
    return this.keyManager?.getPublicKeyHex() || null;
  }

  /**
   * Returns the latest message timestamp (in Nostr seconds) across the given groups,
   * or 0 if no messages exist.  Used to set `since` on subscriptions so the relay
   * only sends events we don't already have.
   */
  private getLatestMessageTimestamp(groupIds: string[]): number {
    let latest = 0;
    for (const gid of groupIds) {
      const msgs = this.messages.get(gid);
      if (!msgs) continue;
      for (const m of msgs) {
        const ts = Math.floor(m.timestamp / 1000);
        if (ts > latest) latest = ts;
      }
    }
    return latest;
  }

  // ===========================================================================
  // Private — Relay Admin
  // ===========================================================================

  private async fetchRelayAdmins(): Promise<Set<string>> {
    if (this.relayAdminPubkeys) return this.relayAdminPubkeys;
    if (this.relayAdminFetchPromise) return this.relayAdminFetchPromise;

    this.relayAdminFetchPromise = this.doFetchRelayAdmins();
    const result = await this.relayAdminFetchPromise;
    this.relayAdminFetchPromise = null;
    return result;
  }

  private async doFetchRelayAdmins(): Promise<Set<string>> {
    await this.ensureConnected();
    if (!this.client) return new Set();

    const adminPubkeys = new Set<string>();
    return this.oneshotSubscription(
      new Filter({ kinds: [NIP29_KINDS.GROUP_ADMINS], '#d': ['', '_'] }),
      {
        onEvent: (event: Event) => {
          const pTags = event.tags.filter((t: string[]) => t[0] === 'p');
          for (const tag of pTags) {
            if (tag[1]) adminPubkeys.add(tag[1]);
          }
        },
        onComplete: () => {
          this.relayAdminPubkeys = adminPubkeys;
          return adminPubkeys;
        },
      },
    );
  }

  // ===========================================================================
  // Private — Fetch Helpers
  // ===========================================================================

  private async fetchGroupMetadataInternal(groupId: string): Promise<GroupData | null> {
    if (!this.client) return null;

    let result: GroupData | null = null;
    return this.oneshotSubscription(
      new Filter({ kinds: [NIP29_KINDS.GROUP_METADATA], '#d': [groupId] }),
      {
        onEvent: (event: Event) => {
          if (!result) result = this.parseGroupMetadata(event);
        },
        onComplete: () => result,
      },
    );
  }

  private async fetchAndSaveMembers(groupId: string): Promise<void> {
    const [members, adminPubkeys] = await Promise.all([
      this.fetchGroupMembersInternal(groupId),
      this.fetchGroupAdminsInternal(groupId),
    ]);

    for (const member of members) {
      if (adminPubkeys.includes(member.pubkey)) {
        member.role = GroupRoleEnum.ADMIN;
      }
      this.saveMemberToMemory(member);
    }

    // Save admins not in member list
    for (const pubkey of adminPubkeys) {
      const existing = (this.members.get(groupId) || []).find((m) => m.pubkey === pubkey);
      if (!existing) {
        this.saveMemberToMemory({
          pubkey,
          groupId,
          role: GroupRoleEnum.ADMIN,
          joinedAt: Date.now(),
        });
      }
    }

    this.persistMembers();
  }

  private async fetchGroupMembersInternal(groupId: string): Promise<GroupMemberData[]> {
    if (!this.client) return [];

    const members: GroupMemberData[] = [];
    return this.oneshotSubscription(
      new Filter({ kinds: [NIP29_KINDS.GROUP_MEMBERS], '#d': [groupId] }),
      {
        onEvent: (event: Event) => {
          const pTags = event.tags.filter((t: string[]) => t[0] === 'p');
          for (const tag of pTags) {
            members.push({
              pubkey: tag[1],
              groupId,
              role: (tag[3] as GroupRole) || GroupRoleEnum.MEMBER,
              joinedAt: event.created_at * 1000,
            });
          }
        },
        onComplete: () => members,
      },
    );
  }

  private async fetchGroupAdminsInternal(groupId: string): Promise<string[]> {
    if (!this.client) return [];

    const adminPubkeys: string[] = [];
    return this.oneshotSubscription(
      new Filter({ kinds: [NIP29_KINDS.GROUP_ADMINS], '#d': [groupId] }),
      {
        onEvent: (event: Event) => {
          const pTags = event.tags.filter((t: string[]) => t[0] === 'p');
          for (const tag of pTags) {
            if (tag[1] && !adminPubkeys.includes(tag[1])) {
              adminPubkeys.push(tag[1]);
            }
          }
        },
        onComplete: () => adminPubkeys,
      },
    );
  }

  // ===========================================================================
  // Private — In-Memory State Helpers
  // ===========================================================================

  private saveMessageToMemory(message: GroupMessageData): void {
    const groupId = message.groupId;
    if (!this.messages.has(groupId)) {
      this.messages.set(groupId, []);
    }
    const msgs = this.messages.get(groupId)!;
    const idx = msgs.findIndex((m) => m.id === message.id);
    if (idx >= 0) {
      msgs[idx] = message;
    } else {
      msgs.push(message);
      // Prune oldest messages beyond limit (keep 2x defaultMessageLimit for scroll-back)
      const maxMessages = this.config.defaultMessageLimit * 2;
      if (msgs.length > maxMessages) {
        msgs.splice(0, msgs.length - maxMessages);
      }
    }
  }

  private deleteMessageFromMemory(groupId: string, messageId: string): void {
    const msgs = this.messages.get(groupId);
    if (msgs) {
      const idx = msgs.findIndex((m) => m.id === messageId);
      if (idx >= 0) msgs.splice(idx, 1);
    }
  }

  private saveMemberToMemory(member: GroupMemberData): void {
    const groupId = member.groupId;
    if (!this.members.has(groupId)) {
      this.members.set(groupId, []);
    }
    const mems = this.members.get(groupId)!;
    const idx = mems.findIndex((m) => m.pubkey === member.pubkey);
    if (idx >= 0) {
      mems[idx] = member;
    } else {
      mems.push(member);
    }
  }

  private removeMemberFromMemory(groupId: string, pubkey: string): void {
    const mems = this.members.get(groupId);
    if (mems) {
      const idx = mems.findIndex((m) => m.pubkey === pubkey);
      if (idx >= 0) mems.splice(idx, 1);
    }
    // Update member count
    const group = this.groups.get(groupId);
    if (group) {
      group.memberCount = (this.members.get(groupId) || []).length;
      this.groups.set(groupId, group);
    }
  }

  private removeGroupFromMemory(groupId: string): void {
    this.groups.delete(groupId);
    this.messages.delete(groupId);
    this.members.delete(groupId);
  }

  private updateGroupLastMessage(groupId: string, text: string, timestamp: number): void {
    const group = this.groups.get(groupId);
    if (group && timestamp >= (group.lastMessageTime || 0)) {
      group.lastMessageText = text;
      group.lastMessageTime = timestamp;
      this.groups.set(groupId, group);
    }
  }

  private updateMemberNametag(
    groupId: string,
    pubkey: string,
    nametag: string,
    joinedAt: number,
  ): void {
    const members = this.members.get(groupId) || [];
    const existing = members.find((m) => m.pubkey === pubkey);

    if (existing) {
      if (existing.nametag !== nametag) {
        existing.nametag = nametag;
        this.saveMemberToMemory(existing);
      }
    } else {
      this.saveMemberToMemory({
        pubkey,
        groupId,
        role: GroupRoleEnum.MEMBER,
        nametag,
        joinedAt,
      });
    }
  }

  private addProcessedEventId(eventId: string): void {
    this.processedEventIds.add(eventId);
    // Keep max 10,000
    if (this.processedEventIds.size > 10000) {
      const arr = Array.from(this.processedEventIds);
      this.processedEventIds = new Set(arr.slice(arr.length - 10000));
    }
  }

  // ===========================================================================
  // Private — Persistence
  // ===========================================================================

  /** Schedule a debounced persist (coalesces rapid event bursts). */
  private schedulePersist(): void {
    if (this.persistTimer) return; // Already scheduled
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistPromise = this.doPersistAll().catch((err) => {
        logger.error('GroupChat', 'Persistence error:', err);
      }).finally(() => {
        this.persistPromise = null;
      });
    }, 200);
  }

  /** Persist immediately (for explicit flush points). */
  private async persistAll(): Promise<void> {
    // Wait for any pending debounced persist
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.persistPromise) {
      await this.persistPromise;
    }
    await this.doPersistAll();
  }

  private async doPersistAll(): Promise<void> {
    await Promise.all([
      this.persistGroups(),
      this.persistMessages(),
      this.persistMembers(),
      this.persistProcessedEvents(),
    ]);
  }

  private async persistGroups(): Promise<void> {
    if (!this.deps) return;
    const data = Array.from(this.groups.values());
    await this.deps.storage.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_GROUPS, JSON.stringify(data));
  }

  private async persistMessages(): Promise<void> {
    if (!this.deps) return;
    const allMessages: GroupMessageData[] = [];
    for (const msgs of this.messages.values()) {
      allMessages.push(...msgs);
    }
    await this.deps.storage.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_MESSAGES, JSON.stringify(allMessages));
  }

  private async persistMembers(): Promise<void> {
    if (!this.deps) return;
    const allMembers: GroupMemberData[] = [];
    for (const mems of this.members.values()) {
      allMembers.push(...mems);
    }
    await this.deps.storage.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_MEMBERS, JSON.stringify(allMembers));
  }

  private async persistProcessedEvents(): Promise<void> {
    if (!this.deps) return;
    const arr = Array.from(this.processedEventIds);
    await this.deps.storage.set(STORAGE_KEYS_ADDRESS.GROUP_CHAT_PROCESSED_EVENTS, JSON.stringify(arr));
  }

  // ===========================================================================
  // Private — Relay URL Change Detection
  // ===========================================================================

  private async checkAndClearOnRelayChange(currentRelayUrl: string): Promise<void> {
    if (!this.deps) return;

    const stored = await this.deps.storage.get(STORAGE_KEYS_GLOBAL.GROUP_CHAT_RELAY_URL);

    if (stored && stored !== currentRelayUrl) {
      // Relay changed — clear stale data
      this.groups.clear();
      this.messages.clear();
      this.members.clear();
      this.processedEventIds.clear();
      await this.persistAll();
    }

    // Also check if stored groups have different relay URL
    if (!stored) {
      for (const group of this.groups.values()) {
        if (group.relayUrl && group.relayUrl !== currentRelayUrl) {
          this.groups.clear();
          this.messages.clear();
          this.members.clear();
          this.processedEventIds.clear();
          await this.persistAll();
          break;
        }
      }
    }

    await this.deps.storage.set(STORAGE_KEYS_GLOBAL.GROUP_CHAT_RELAY_URL, currentRelayUrl);
  }

  // ===========================================================================
  // Private — Message Content Wrapping
  // ===========================================================================

  private wrapMessageContent(content: string, senderNametag: string | null): string {
    if (senderNametag) {
      return JSON.stringify({ senderNametag, text: content });
    }
    return content;
  }

  private unwrapMessageContent(content: string): { text: string; senderNametag: string | null } {
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed === 'object' && parsed.text !== undefined) {
        return { text: parsed.text, senderNametag: parsed.senderNametag || null };
      }
    } catch {
      // Not JSON
    }
    return { text: content, senderNametag: null };
  }

  // ===========================================================================
  // Private — Event Tag Helpers
  // ===========================================================================

  private getGroupIdFromEvent(event: Event): string | null {
    const hTag = event.tags.find((t: string[]) => t[0] === 'h');
    return hTag ? hTag[1] : null;
  }

  private getGroupIdFromMetadataEvent(event: Event): string | null {
    const dTag = event.tags.find((t: string[]) => t[0] === 'd');
    if (dTag?.[1]) return dTag[1];
    const hTag = event.tags.find((t: string[]) => t[0] === 'h');
    return hTag?.[1] ?? null;
  }

  private extractReplyTo(event: Event): string | undefined {
    const eTag = event.tags.find((t: string[]) => t[0] === 'e' && t[3] === 'reply');
    return eTag ? eTag[1] : undefined;
  }

  private extractPreviousIds(event: Event): string[] | undefined {
    const previousTag = event.tags.find((t: string[]) => t[0] === 'previous');
    return previousTag ? previousTag.slice(1) : undefined;
  }

  private parseGroupMetadata(event: Event): GroupData | null {
    try {
      const groupId = this.getGroupIdFromMetadataEvent(event);
      if (!groupId) return null;

      let name = 'Unnamed Group';
      let description: string | undefined;
      let picture: string | undefined;
      let isPrivate = false;

      if (event.content && event.content.trim()) {
        try {
          const metadata = JSON.parse(event.content);
          name = metadata.name || name;
          description = metadata.about || metadata.description;
          picture = metadata.picture;
          isPrivate = metadata.private === true;
        } catch {
          // Not JSON, check tags
        }
      }

      for (const tag of event.tags) {
        if (tag[0] === 'name' && tag[1]) name = tag[1];
        if (tag[0] === 'about' && tag[1]) description = tag[1];
        if (tag[0] === 'picture' && tag[1]) picture = tag[1];
        if (tag[0] === 'private') isPrivate = true;
        if (tag[0] === 'public' && tag[1] === 'false') isPrivate = true;
      }

      return {
        id: groupId,
        relayUrl: this.config.relays[0] || '',
        name,
        description,
        picture,
        visibility: isPrivate ? GroupVisibilityEnum.PRIVATE : GroupVisibilityEnum.PUBLIC,
        createdAt: event.created_at * 1000,
      };
    } catch {
      return null;
    }
  }

  // ===========================================================================
  // Private — Utility
  // ===========================================================================

  /** Subscribe and track the subscription ID for cleanup. */
  private trackSubscription(filter: Filter, handlers: { onEvent: (event: Event) => void; onEndOfStoredEvents?: () => void }): string {
    const subId = this.client!.subscribe(filter, {
      onEvent: handlers.onEvent,
      onEndOfStoredEvents: handlers.onEndOfStoredEvents ?? (() => {}),
    });
    this.subscriptionIds.push(subId);
    return subId;
  }

  /** Subscribe for a one-shot fetch, auto-unsubscribe on EOSE or timeout. */
  private oneshotSubscription<T>(
    filter: Filter,
    opts: {
      onEvent: (event: Event) => void;
      onComplete: () => T;
      timeoutMs?: number;
      timeoutLabel?: string;
    },
  ): Promise<T> {
    return new Promise((resolve) => {
      let done = false;
      const state: { subId?: string } = {};

      const finish = () => {
        if (done) return;
        done = true;
        if (state.subId) {
          try { this.client!.unsubscribe(state.subId); } catch (err) { logger.debug('GroupChat', 'Failed to unsubscribe', err); }
          const idx = this.subscriptionIds.indexOf(state.subId);
          if (idx >= 0) this.subscriptionIds.splice(idx, 1);
        }
        resolve(opts.onComplete());
      };

      const subId = this.client!.subscribe(filter, {
        onEvent: (event: Event) => { if (!done) opts.onEvent(event); },
        onEndOfStoredEvents: finish,
      });
      state.subId = subId;
      this.subscriptionIds.push(subId);

      setTimeout(() => {
        if (!done && opts.timeoutLabel) {
          logger.warn('GroupChat', `${opts.timeoutLabel} timed out`);
        }
        finish();
      }, opts.timeoutMs ?? 5000);
    });
  }

  private ensureInitialized(): void {
    if (!this.deps) {
      throw new SphereError('GroupChatModule not initialized', 'NOT_INITIALIZED');
    }
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }
  }

  private randomId(): string {
    const bytes = new Uint8Array(8);
    if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
      globalThis.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
}

// =============================================================================
// Factory Function
// =============================================================================

export function createGroupChatModule(config?: GroupChatModuleConfig): GroupChatModule {
  return new GroupChatModule(config);
}
