# Direct Messages

End‑to‑end encrypted one‑to‑one messages (NIP‑17 gift wrap), reached through `sphere.communications`.

```typescript
// Send a DM (by @nametag or public key)
await sphere.communications.sendDM('@alice', 'Hello!');

// Listen for incoming DMs
sphere.communications.onDirectMessage((msg) => {
  console.log(`From ${msg.senderNametag ?? msg.senderPubkey}: ${msg.content}`);
});
```

## History on connect

By default the SDK resumes from the last DM it processed (the timestamp is persisted in storage). On the very first connect it starts from "now" — no historical replay.

Use `dmSince` to control how far back to fetch on first connect:

```typescript
const { sphere } = await Sphere.init({
  ...providers,
  autoGenerate: true,
  dmSince: Math.floor(Date.now() / 1000) - 86400,  // last 24 hours
});
```

Once the SDK has processed DMs, the timestamp is persisted and `dmSince` is ignored on later connects.

## Ephemeral mode (no caching)

For anonymous agents or bots that don't need history, disable DM caching:

```typescript
const { sphere } = await Sphere.init({
  ...providers,
  communications: { cacheMessages: false },
});

// Stream-only: receive, process, forget
sphere.communications.onDirectMessage((msg) => {
  processAndReply(msg);
});

// sendDM still works — the message is sent but not stored locally
await sphere.communications.sendDM('@alice', 'response');
```

When `cacheMessages` is `false`:

- `onDirectMessage()` handlers and `message:dm` events fire normally.
- Messages are never stored in memory or persisted to storage.
- `getConversation()` / `getConversations()` return empty results.
- Deduplication is skipped (duplicate relay deliveries may trigger duplicate events).

## Reading conversations

```typescript
const conversation  = sphere.communications.getConversation('@alice'); // chronological
const conversations = sphere.communications.getConversations();         // Map keyed by peer
```

(These return empty when `cacheMessages` is `false`.)
