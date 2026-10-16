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
       ├─ initializeIdentityFromMnemonic()
       ├─ initializeProviders()
       ├─ initializeModules()
       └─ registerNametag('alice')
            ├─ 1. publishIdentityBinding(...)  ← the sole registration act
            │    └─ nostrClient.publishNametagBinding('alice', nostrPubkey, identity)
            │         ├─ queryPubkeyByNametag('alice')  ← conflict check
            │         └─ publishEvent(bindingEvent)      ← kind 30078, UNIP-01 marker
            ├─ 2. update local state and persist the nametag cache
            └─ 3. emit 'nametag:registered'
```

**Events published: 1** — a nametag binding event with full identity fields.

Registration mints nothing. Publishing the Nostr binding is the registration act and the only
registration record: there is no nametag token, on chain or local, and name resolution reads
Nostr bindings only. Uniqueness comes from the publish-time conflict check and the UNIP-01
single-owner marker the binding carries (see [Anti-Hijacking](#anti-hijacking)). If the publish
reports failure (the name is taken, or the publish itself failed), `registerNametag()` throws
`VALIDATION_ERROR` (`'Failed to register Unicity ID. It may already be taken.'`) and changes no
local state.

### Path B: Without nametag (`Sphere.init({ autoGenerate: true })`)

```
Sphere.init()
  └─ Sphere.create()
       ├─ storeMnemonic()
       ├─ initializeIdentityFromMnemonic()
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
const { sphere } = await Sphere.init({ ...providers, network: 'testnet2', autoGenerate: true });
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

Published by `registerNametag()` via nostr-js-sdk's `publishNametagBinding()` (`createBindingEvent`
in nostr-js-sdk 0.6.0, the version this SDK locks).

```json
{
  "kind": 30078,
  "pubkey": "<32-byte x-only Nostr pubkey>",
  "created_at": 1709500000,
  "tags": [
    ["d", "<SHA256('unicity:nametag:alice')>"],
    ["L", "unicity:nametag"],
    ["nametag", "<SHA256('unicity:nametag:alice')>"],
    ["t", "<SHA256('unicity:nametag:alice')>"],
    ["address", "<nostrPubkey>"],
    ["t", "<SHA256('unicity:address:' + nostrPubkey)>"],
    ["t", "<SHA256('unicity:address:' + chainPubkey)>"],
    ["pubkey", "<chainPubkey>"],
    ["t", "<SHA256('unicity:address:' + directAddress)>"]
  ],
  "content": {
    "nametag_hash": "<SHA256('unicity:nametag:alice')>",
    "address": "<nostrPubkey>",
    "verified": 1709500000,
    "encrypted_nametag": "<AES-GCM encrypted>",
    "nametag": "alice",
    "public_key": "02abc...",
    "direct_address": "DIRECT://..."
  }
}
```

- `["L", "unicity:nametag"]` is the **UNIP-01 ownership marker** (a NIP-32 label). It opts the
  binding into single-owner semantics and is what resolution prefers (see
  [Resolution Strategy](#resolution-strategy-query-time)). A binding published without it loses to
  any marked binding for the same name.
- The `address` tag and `content.address` hold the author's Nostr pubkey; its hash is indexed as a
  `t` tag like the other addresses.
- `content.verified` is a Unix timestamp in **seconds** (`Math.floor(Date.now() / 1000)`).
- The nametag is normalised (lowercase, `@unicity` suffix stripped, phone numbers in E.164) before
  it is hashed.

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

Ownership follows **UNIP-01**, which nostr-js-sdk implements from 0.6.0 (this SDK locks 0.6.1).
Every nametag binding carries the `["L", "unicity:nametag"]` marker. A relay that implements
UNIP-01 enforces single ownership of a marked name: the first author it accepts for that name owns
it (relay receive order, not the event's `created_at`), and it rejects a marked binding for that
name from any other author.

### Conflict Detection (publish-time)

`publishNametagBinding()` first collects the authors claiming the name (the candidates of the rule
below). If any author other than the publisher claims it, it throws `"already claimed"` — including
a name contested by several authors, which resolves to `null` but is not available. It then publishes the binding; a relay
rejection that names an ownership conflict ("owned by another key" / "already claimed", the UNIP-01
single-owner rejection) also throws `"already claimed"`, and any other publish error makes it
return `false`. Re-publishing by the same pubkey (an update) is allowed.

The Sphere transport turns the `"already claimed"` throw into `false`, and `registerNametag()`
throws `VALIDATION_ERROR` whenever the publish returns `false`.

**TOCTOU caveat:** the client-side check is a read followed by a write, so two clients can both pass
it. On a UNIP-01 relay the relay settles the race: it keeps the first author it received and
rejects the other publish, which then fails as `"already claimed"`. If relays disagree, resolution
returns `null` for the name instead of picking a winner (below).

### Resolution Strategy (query-time)

The query methods (`queryPubkeyByNametag`, `queryBindingByNametag`, `queryBindingByAddress`) collect
the matching binding events and keep only those that bind the queried identifier: for a nametag,
bindings whose `d` tag is the nametag hash (the tag a UNIP-01 relay vets ownership of); for an
address, events that carry the address's `t` tag. They skip any event whose signature does not
verify (so a relay cannot inject a forged binding), group the rest by author, and keep each
author's most recent event (by `created_at`). Then (nostr-js-sdk 0.6.1):

1. **Marked bindings first (nametags only).** If any author's most recent binding carries the
   UNIP-01 marker, only those authors count. Address lookups ignore the marker: it vouches for the
   binding's nametag, not for the addresses the binding advertises.
2. **One author resolves; more than one is `null`.** Exactly one remaining author: that author's
   most recent binding is the answer. More than one (a competing claim, or relays in different
   states): the query resolves to `null` rather than guessing. `created_at` is chosen by the
   publisher, so it never decides between authors. A name with a single legacy (unmarked) binding
   still resolves. (nostr-js-sdk 0.6.0 and earlier fell back to the earliest `created_at` among
   unmarked bindings.)
3. **Latest-wins for the same author** — the winning author's most recent event is returned, so the
   most complete data comes back.

Rule 3 is what makes Path C (register nametag after creation) work. Address-based lookups find both
the old bare binding and the newer nametag binding. Without latest-wins-for-same-author, the stale
bare binding (without nametag) would be returned.

### No Unicity ID token

There is no self-issued `UnicityIdToken`: its mint was removed when the SDK moved to
state-transition-sdk 2.0 (sphere-sdk 0.12.0), and nothing in this SDK mints, stores or reads a
nametag token. The Nostr binding is the only
registration record, and runtime name resolution is Nostr-binding-only.

## Privacy

- Nametag is **hashed** in all indexed tags: `SHA256('unicity:nametag:' + name)` — relay operators see hashes, not plaintext
- Addresses are **hashed** in `t` tags: `SHA256('unicity:address:' + address)` — same relay-level privacy
- **Plaintext nametag is stored in event content** (`content.nametag`). This is intentional: nametags must be publicly resolvable for the system to work (sending tokens to `@alice` requires resolving her addresses). The tag hashing provides relay-level indexing privacy, while content is publicly readable for kind 30078 events.
- `encrypted_nametag` (AES-GCM) is a separate copy encrypted with the author's private key, enabling wallet recovery on import without relying on the plaintext field
- the `pubkey` tag contains an unhashed value for backward-compatible lookups

## SDK API

### Publishing

```typescript
// Register a nametag for the current address: publishes the Nostr binding (the only
// registration record; nothing is minted), updates the local nametag cache and emits
// 'nametag:registered'. Throws VALIDATION_ERROR if the name is taken or the publish failed.
await sphere.registerNametag('alice');

// Low-level: publish a binding through the transport directly. This bypasses Sphere's
// local nametag state and cache, so prefer registerNametag(). publishIdentityBinding is
// an optional TransportProvider member, and it resolves false (it does not throw) when
// the name is taken or the publish failed.
const transport = sphere.getTransport();
const me = sphere.identity;
if (me) {
  const published = await transport.publishIdentityBinding?.(me.chainPubkey, me.directAddress ?? '', 'alice');
}
```

### Resolving

```typescript
// Unified resolution (accepts @nametag, DIRECT:// address, chain pubkey, transport pubkey)
const peer = await sphere.resolve('@alice');
// PeerInfo | null: { nametag?, transportPubkey, chainPubkey, directAddress, timestamp }

// Low-level nostr-js-sdk methods on a connected NostrClient (UNIP-01 resolution, above)
const pubkey = await nostrClient.queryPubkeyByNametag('alice');       // string | null
const byName = await nostrClient.queryBindingByNametag('alice');      // BindingInfo | null
const byAddress = await nostrClient.queryBindingByAddress('DIRECT://...'); // BindingInfo | null
```

### Recovery

Recovery runs inside `Sphere.init` / `create` / `load` / `import` and finishes before they
return. It emits `nametag:recovered` at that point, so a listener added after the call does not
see it. Read `sphere.identity?.nametag` instead; the event is useful for later recoveries, such as
the identity sync after `switchToAddress()`.

```typescript
// Import into a storage with no wallet yet (over an existing wallet, import rejects with
// ALREADY_INITIALIZED unless overwrite: true replaces it), then recover the nametag from the relay.
const sphere = await Sphere.import({ ...providers, network: 'testnet2', mnemonic });
console.log(sphere.identity?.nametag); // the recovered nametag, or undefined if none was found
```
