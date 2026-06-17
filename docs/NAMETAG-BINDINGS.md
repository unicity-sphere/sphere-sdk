# Nametag Bindings

How the Sphere SDK publishes and resolves identity binding events on Nostr relays.

## Overview

Nametag bindings are Nostr events (kind 30078, NIP-78 parameterized replaceable) that associate a human-readable nametag (`@alice`) with on-chain identity addresses. They enable:

- **Forward lookup**: nametag → pubkey/addresses (e.g., sending tokens to `@alice`)
- **Reverse lookup**: address → nametag/identity (e.g., showing sender info in DMs)
- **Recovery**: encrypted nametag in the event allows private key owner to recover their nametag on wallet import

## Wallet Creation Flow

### Path A: With nametag (`Sphere.init({ nametag: 'alice', ... })`)

```
Sphere.init()
  └─ Sphere.create()
       ├─ storeMnemonic()
       ├─ initializeIdentity()
       ├─ initializeProviders()
       ├─ initializeModules()
       └─ registerNametag('alice')
            ├─ 1. publishIdentityBinding(...)  ← the sole registration act
            │    └─ nostrClient.publishNametagBinding('alice', pubkey, identity)
            │         ├─ queryPubkeyByNametag('alice')  ← conflict check
            │         └─ publishEvent(bindingEvent)      ← kind 30078
            ├─ 2. update local state
            └─ 3. ensureUnicityIdTokenStored()  ← best-effort, fire-and-forget
                 └─ mints a self-issued v2 UnicityIdToken via the v2 gateway
                    and stores it (format: 'v2-cbor'); never blocks/fails
                    registration
```

**Events published: 1** — a nametag binding event with full identity fields.

Since the v1→v2 cutover there is **no on-chain nametag mint as part of registration**: publishing the Nostr binding is the registration act, and its first-seen-wins failure path is the uniqueness guard. A self-issued v2 **UnicityIdToken** is *additionally* minted and stored (format `'v2-cbor'`) **best-effort** after the binding is published — a gateway outage or missing v2 oracle config never fails registration, and the mint is retried on a later wallet load (it is deterministic per name + address key). The token is not consumed anywhere yet; **runtime name resolution stays Nostr-binding-only**.

### Path B: Without nametag (`Sphere.init({ autoGenerate: true })`)

```
Sphere.init()
  └─ Sphere.create()
       ├─ storeMnemonic()
       ├─ initializeIdentity()
       ├─ initializeProviders()
       ├─ initializeModules()
       ├─ recoverNametagFromTransport()  ← try to find existing nametag
       └─ syncIdentityWithTransport()    ← publish identity binding
            ├─ resolve(transportPubkey)   ← check for existing event
            └─ publishIdentityBinding(chainPubkey, directAddress)
                 └─ publishEvent(baseBindingEvent)  ← kind 30078, no nametag
```

**Events published: 1** — a base identity binding with addresses only (no nametag).

### Path C: Without nametag initially, register later

```
// Initial creation (Path B above)
const { sphere } = await Sphere.init({ autoGenerate: true, ... });
// Published: base identity binding (d = hash(identity:pubkey))

// Later...
await sphere.registerNametag('alice');
// Published: nametag binding (d = hash(nametag:alice))
```

**Events published: 2 total** (different d-tags, both coexist on relay):
1. Base identity binding: `d = SHA256('unicity:identity:' + nostrPubkey)`
2. Nametag binding: `d = SHA256('unicity:nametag:alice')`

Both events share address `#t` tags (hashed chainPubkey, directAddress), so address-based reverse lookups find both.

## Event Formats

### Nametag Binding Event (with identity)

Published by `registerNametag()` via nostr-js-sdk's `publishNametagBinding()`.

```json
{
  "kind": 30078,
  "pubkey": "<32-byte x-only Nostr pubkey>",
  "created_at": 1709500000,
  "tags": [
    ["d", "<SHA256('unicity:nametag:alice')>"],
    ["nametag", "<SHA256('unicity:nametag:alice')>"],
    ["t", "<SHA256('unicity:nametag:alice')>"],
    ["address", "<nostrPubkey>"],
    ["t", "<SHA256('unicity:address:' + chainPubkey)>"],
    ["pubkey", "<chainPubkey>"],
    ["t", "<SHA256('unicity:address:' + directAddress)>"]
  ],
  "content": {
    "nametag_hash": "<SHA256('unicity:nametag:alice')>",
    "address": "<nostrPubkey>",
    "verified": 1709500000000,
    "nametag": "alice",
    "encrypted_nametag": "<AES-GCM encrypted>",
    "public_key": "02abc...",
    "direct_address": "DIRECT://..."
  }
}
```

> The wire format (nostr-js-sdk) still allows an optional `proxy_address` field and tag, but the SDK no longer emits them — PROXY addressing was removed in the v1→v2 cutover. Events published by older wallets may still contain them.

### Base Identity Binding Event (without nametag)

Published by `syncIdentityWithTransport()` when no nametag is set.

```json
{
  "kind": 30078,
  "pubkey": "<32-byte x-only Nostr pubkey>",
  "created_at": 1709500000,
  "tags": [
    ["d", "<SHA256('unicity:identity:' + nostrPubkey)>"],
    ["t", "<SHA256('unicity:address:' + chainPubkey)>"],
    ["t", "<SHA256('unicity:address:' + directAddress)>"]
  ],
  "content": {
    "public_key": "02abc...",
    "direct_address": "DIRECT://..."
  }
}
```

## d-tag Strategy

The `d` tag determines which event gets replaced (NIP-78: same kind + pubkey + d-tag = replacement).

| Scenario | d-tag | Purpose |
|----------|-------|---------|
| Nametag binding | `SHA256('unicity:nametag:' + nametag)` | One event per nametag per author |
| Base identity binding | `SHA256('unicity:identity:' + nostrPubkey)` | One event per identity (no nametag) |

These are different d-tags, so they create **separate** replaceable events. A wallet that first publishes a base binding and later registers a nametag will have both events on the relay. Only the original author (same Nostr pubkey) can replace their own events.

## Anti-Hijacking

### Conflict Detection (publish-time)

`publishNametagBinding()` queries the relay before publishing. If the nametag is already claimed by a different pubkey, it throws `"already claimed"`. Same pubkey re-publishing (update) is allowed.

**TOCTOU caveat:** There is a race window between the conflict check and the publish. Another user can claim the same nametag in between. This is inherent to Nostr's eventually-consistent relay model — there is no atomic check-and-publish. The first-seen-wins resolution strategy (below) is what settles such races at query time: the earliest `created_at` claim wins.

### Resolution Strategy (query-time)

All query methods (`queryPubkeyByNametag`, `queryBindingByNametag`, `queryBindingByAddress`) use a two-level strategy:

1. **First-seen-wins across authors** — if multiple pubkeys claim the same nametag or address tag, the author who published the earliest `created_at` event wins. Prevents hijacking. Ties are broken deterministically by lexicographic pubkey comparison (lowest wins).

2. **Latest-wins for same author** — if the rightful owner has multiple events (e.g., initial bare binding + later nametag binding), the most recent event is returned. Ensures the most complete data is returned.

3. **Signature verification** — events with invalid signatures are silently skipped. This prevents malicious relays from injecting forged events to hijack nametag resolution.

This is critical for Path C (register nametag after creation). Address-based lookups find both the old bare binding and the newer nametag binding. Without latest-wins-for-same-author, the stale bare binding (without nametag) would be returned.

### Self-Issued Unicity ID Token (v2)

Since the v1→v2 cutover, the Nostr binding alone IS the registration — there is no on-chain mint gating it. After the binding is published, `registerNametag()` (and wallet create/import/load paths) call `ensureUnicityIdTokenStored()`, which **best-effort** mints a self-issued v2 `UnicityIdToken` via the v2 gateway (`createUnicityIdMinter().mintUnicityIdToken(name)`) and stores it in the wallet's nametag list with `format: 'v2-cbor'`:

- Fire-and-forget: a gateway outage or missing v2 oracle config never fails registration
- Idempotent: skipped if a `'v2-cbor'` token for the name is already stored
- Deterministic per (name, address key): a later load re-mints the identical token (lost-storage recovery)
- Not consumed anywhere yet — **runtime name resolution stays Nostr-binding-only**

## Privacy

- Nametag is **hashed** in all indexed tags: `SHA256('unicity:nametag:' + name)` — relay operators see hashes, not plaintext
- Addresses are **hashed** in `t` tags: `SHA256('unicity:address:' + address)` — same relay-level privacy
- **Plaintext nametag is stored in event content** (`content.nametag`). This is intentional: nametags must be publicly resolvable for the system to work (sending tokens to `@alice` requires resolving her addresses). The tag hashing provides relay-level indexing privacy, while content is publicly readable for kind 30078 events.
- `encrypted_nametag` (AES-GCM) is a separate copy encrypted with the author's private key, enabling wallet recovery on import without relying on the plaintext field
- the `pubkey` tag contains an unhashed value for backward-compatible lookups

## SDK API

### Publishing

```typescript
// Register nametag (publishes the Nostr binding; afterwards a self-issued
// v2 UnicityIdToken is minted + stored best-effort)
await sphere.registerNametag('alice');

// Low-level: publish identity binding directly
await transport.publishIdentityBinding(chainPubkey, directAddress, 'alice');
```

### Resolving

```typescript
// Unified resolution (accepts @nametag, address, pubkey)
const peer = await sphere.resolve('@alice');
// { nametag, transportPubkey, chainPubkey, directAddress, timestamp }

// Low-level nostr-js-sdk methods
const pubkey = await nostrClient.queryPubkeyByNametag('alice');
const info = await nostrClient.queryBindingByNametag('alice');
const info = await nostrClient.queryBindingByAddress('DIRECT://...');
```

### Recovery

```typescript
// Automatic on wallet import/load
const { sphere } = await Sphere.init({ mnemonic: '...', ... });
// If nametag found on relay → sphere.identity.nametag is set
// Emits 'nametag:recovered' event
```
