# Group Chat

Relay‑based group messaging using the NIP‑29 protocol. The group‑chat module runs its own messaging connection, separate from the wallet's, and is reached through `sphere.groupChat`.

## Enabling group chat

```typescript
// Enable with network defaults (wss://sphere-relay.unicity.network)
const { sphere } = await Sphere.init({
  ...providers,
  autoGenerate: true,
  groupChat: true,
});

// Enable with a custom relay
const { sphere } = await Sphere.init({
  ...providers,
  autoGenerate: true,
  groupChat: { relays: ['wss://my-nip29-relay.com'] },
});

// Access the module
const gc = sphere.groupChat!;
```

## Connection

```typescript
await gc.connect();
console.log('Connected:', gc.getConnectionStatus());

// Is the current user a relay admin?
const isRelayAdmin = await gc.isCurrentUserRelayAdmin();
```

## Groups

```typescript
import { GroupVisibility } from '@unicitylabs/sphere-sdk';

// Public group
const group = await gc.createGroup({ name: 'General', description: 'Public discussion' });

// Private group
const privateGroup = await gc.createGroup({ name: 'Team', visibility: GroupVisibility.PRIVATE });

// Write-restricted group (only admins/writers can post)
const announcements = await gc.createGroup({ name: 'Announcements', writeRestricted: true });

// Discover and join
const available = await gc.fetchAvailableGroups();    // public groups on the relay
await gc.joinGroup(group.id);
await gc.joinGroup(privateGroup.id, inviteCode);       // private group with invite

// List, leave, delete
const groups = gc.getGroups();
await gc.leaveGroup(group.id);
await gc.deleteGroup(group.id);                        // admin only
```

## Messaging

```typescript
const msg = await gc.sendMessage(group.id, 'Hello!');
await gc.sendMessage(group.id, 'Agreed', { replyToId: msg.id });   // reply

const messages = await gc.fetchMessages(group.id, { limit: 50 });   // from relay
const cached   = gc.getMessages(group.id);                          // local cache

// Real-time
const unsubscribe = gc.onMessage((message) => {
  console.log(`[${message.groupId}] ${message.senderPubkey}: ${message.content}`);
});
```

## Members & moderation

```typescript
const members = gc.getMembers(group.id);

gc.isCurrentUserAdmin(group.id);      // boolean
gc.isCurrentUserModerator(group.id);  // boolean
await gc.canModerateGroup(group.id);  // includes relay-admin check
gc.canWriteToGroup(group.id);         // false if write-restricted and not admin/moderator

// Requires admin/moderator role
await gc.kickUser(group.id, userPubkey, 'reason');
await gc.deleteMessage(group.id, messageId);
```

## Invites (private groups)

```typescript
const invite = await gc.createInvite(group.id);  // admin only
// share the code; recipient joins with:
await gc.joinGroup(group.id, invite);
```

## Unread counts

```typescript
const total = gc.getTotalUnreadCount();
gc.markGroupAsRead(group.id);
```

## Key types

```typescript
interface GroupData {
  id: string;
  relayUrl: string;
  name: string;
  description?: string;
  visibility: GroupVisibility;  // 'PUBLIC' | 'PRIVATE'
  writeRestricted?: boolean;    // only admins and moderators can post
  memberCount?: number;
  unreadCount?: number;
  lastMessageTime?: number;
  lastMessageText?: string;
}

interface GroupMessageData {
  id?: string;
  groupId: string;
  content: string;
  timestamp: number;
  senderPubkey: string;
  senderNametag?: string;
  replyToId?: string;
}

interface GroupMemberData {
  pubkey: string;
  groupId: string;
  role: GroupRole;  // 'ADMIN' | 'MODERATOR' | 'MEMBER'
  nametag?: string;
  joinedAt: number;
}
```
