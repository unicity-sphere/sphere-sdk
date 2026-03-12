/**
 * Group Chat Types (NIP-29)
 * Plain interfaces for SDK consumers — no classes, no UI helpers.
 */

// =============================================================================
// Enums
// =============================================================================

export const GroupRole = {
  ADMIN: 'ADMIN',
  MODERATOR: 'MODERATOR',
  MEMBER: 'MEMBER',
} as const;

export type GroupRole = (typeof GroupRole)[keyof typeof GroupRole];

export const GroupVisibility = {
  PUBLIC: 'PUBLIC',
  PRIVATE: 'PRIVATE',
} as const;

export type GroupVisibility = (typeof GroupVisibility)[keyof typeof GroupVisibility];

// =============================================================================
// Data Interfaces
// =============================================================================

export interface GroupData {
  id: string;
  relayUrl: string;
  name: string;
  description?: string;
  picture?: string;
  visibility: GroupVisibility;
  createdAt: number;
  updatedAt?: number;
  memberCount?: number;
  unreadCount?: number;
  lastMessageTime?: number;
  lastMessageText?: string;
  /** Only admins and moderators can post; other members are read-only (NIP-29 "write-restricted" tag) */
  writeRestricted?: boolean;
  /** When the current user joined this group locally (used to filter old events) */
  localJoinedAt?: number;
}

export interface GroupMessageData {
  id?: string;
  groupId: string;
  content: string;
  timestamp: number;
  senderPubkey: string;
  senderNametag?: string;
  replyToId?: string;
  previousIds?: string[];
}

export interface GroupMemberData {
  pubkey: string;
  groupId: string;
  role: GroupRole;
  nametag?: string;
  joinedAt: number;
}

// =============================================================================
// Configuration
// =============================================================================

export interface GroupChatModuleConfig {
  /** Override relay URLs (default: from network config) */
  relays?: string[];
  /** Default message fetch limit (default: 50) */
  defaultMessageLimit?: number;
  /** Max previous message IDs in ordering tags (default: 3) */
  maxPreviousTags?: number;
  /** Reconnect delay in ms (default: 3000) */
  reconnectDelayMs?: number;
  /** Max reconnect attempts (default: 5) */
  maxReconnectAttempts?: number;
}

// =============================================================================
// Pagination
// =============================================================================

export interface GroupMessagesPage {
  messages: GroupMessageData[];
  hasMore: boolean;
  oldestTimestamp: number | null;
}

export interface GetGroupMessagesPageOptions {
  /** Max messages to return (default: 20) */
  limit?: number;
  /** Return messages older than this timestamp */
  before?: number;
}

// =============================================================================
// Group Creation
// =============================================================================

export interface CreateGroupOptions {
  name: string;
  description?: string;
  picture?: string;
  visibility?: GroupVisibility;
  /** Only admins and moderators can post; other members are read-only */
  writeRestricted?: boolean;
}
