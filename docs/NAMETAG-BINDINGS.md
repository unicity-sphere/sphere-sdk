# Unicity ID Bindings

How the Sphere SDK publishes and resolves identity binding events on Nostr relays.

## Overview

Unicity ID bindings are Nostr events (kind 30078, NIP-78 parameterized replaceable) that associate a human-readable Unicity ID (`@alice`) with on-chain identity addresses. They enable:

- **Forward lookup**: Unicity ID → pubkey/addresses (e.g., sending tokens to `@alice`)
- **Reverse lookup**: address → Unicity ID/identity (e.g., showing sender info in DMs)
- **Recovery**: encrypted Unicity ID in the event allows private key owner to recover their Unicity ID on wallet import

## Wallet Creation Flow

### Path A: With Unicity ID (`Sphere.init({ nametag: 'alice', ... })`)

```
Sphere.init()
  └─ Sphere.create()
       ├─ storeMnemonic()
       ├─ initializeIdentity()
       ├─ initializeProviders()
       ├─ initializeModules()
       └─ registerNametag('alice')
            ├─ 1. mintNametag('alice')         ← on-chain first
            │    └─ submits to Aggregator, waits for proof
            ├─ 2. publishIdentityBinding(...)  ← Nostr second
            │    └─ nostrClient.publishNametagBinding('alice', pubkey, identity)
            │         ├─ queryPubkeyByNametag('alice')  ← conflict check
            │         └─ publishEvent(bindingEvent)      ← kind 30078
            └─ 3. update local state
```

**Events published: 1** — a Unicity ID binding event with full identity fields.

Mint-before-publish ordering ensures no unbacked Unicity ID claims exist on the relay. If minting fails, nothing is published.

### Path B: Without Unicity ID (`Sphere.init({ autoGenerate: true })`)

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
            └─ publishIdentityBinding(chainPubkey, l1Address, directAddress)
                 └─ publishEvent(baseBindingEvent)  ← kind 30078, no nametag
```

**Events published: 1** — a base identity binding with addresses only (no Unicity ID).

### Path C: Without Unicity ID initially, register later

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
2. Unicity ID binding: `d = SHA256('unicity:nametag:alice')`

Both events share address `#t` tags (hashed chainPubkey, l1Address, directAddress), so address-based reverse lookups find both.

## Event Formats

### Unicity ID Binding Event (with identity)

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
    ["t", "<SHA256('unicity:address:' + l1Address)>"],
    ["l1", "<l1Address>"],
    ["t", "<SHA256('unicity:address:' + directAddress)>"],
    ["t", "<SHA256('unicity:address:' + proxyAddress)>"]
  ],
  "content": {
    "nametag_hash": "<SHA256('unicity:nametag:alice')>",
    "address": "<nostrPubkey>",
    "verified": 1709500000000,
    "nametag": "alice",
    "encrypted_nametag": "<AES-GCM encrypted>",
    "public_key": "02abc...",
    "l1_address": "alpha1...",
    "direct_address": "DIRECT://...",
    "proxy_address": "PROXY://..."
  }
}
```

### Base Identity Binding Event (without Unicity ID)

Published by `syncIdentityWithTransport()` when no Unicity ID is set.

```json
{
  "kind": 30078,
  "pubkey": "<32-byte x-only Nostr pubkey>",
  "created_at": 1709500000,
  "tags": [
    ["d", "<SHA256('unicity:identity:' + nostrPubkey)>"],
    ["t", "<SHA256('unicity:address:' + chainPubkey)>"],
    ["t", "<SHA256('unicity:address:' + directAddress)>"],
    ["t", "<SHA256('unicity:address:' + l1Address)>"]
  ],
  "content": {
    "public_key": "02abc...",
    "l1_address": "alpha1...",
    "direct_address": "DIRECT://..."
  }
}
```

### Capability hints (optional, forward-compat)

Identity binding events (both nametag and base) MAY carry capability hints under `content` describing which wire shapes and asset kinds the wallet supports:

```json
{
  "content": {
    "public_key": "02abc...",
    "l1_address": "alpha1...",
    "direct_address": "DIRECT://...",
    "wireProtocols": ["uxf-car", "uxf-cid", "txf"],
    "assetKinds": ["coin", "nft"]
  }
}
```

- `wireProtocols: string[]` — supported transfer wire shapes (e.g., UXF inline CAR, UXF pinned CID, legacy TXF). Absent → assume `['txf']` for v1.0 wallets that pre-date the hint.
- `assetKinds: string[]` — supported `additionalAssets` discriminator values (e.g., `'coin'`, `'nft'`, future kinds). Absent → assume `['coin']` for v1.0 wallets.

**Hints are informational only.** Receivers MUST still apply the strict `UNKNOWN_ASSET_KIND` reject rule per [UXF-TRANSFER-PROTOCOL §10.4](uxf/UXF-TRANSFER-PROTOCOL.md) regardless of whether a hint is present, missing, or stale. Senders SHOULD consult the hint to pre-empt likely receiver rejections, but a missing/stale hint never overrides the receiver-side reject behavior.

Publishing capability hints is an SDK option (planned in implementation wave T.8 per UXF-TRANSFER-PROTOCOL §13). v1.0 wallets that omit the hint are correctly handled by the receiver defaults above.

## d-tag Strategy

The `d` tag determines which event gets replaced (NIP-78: same kind + pubkey + d-tag = replacement).

| Scenario | d-tag | Purpose |
|----------|-------|---------|
| Unicity ID binding | `SHA256('unicity:nametag:' + nametag)` | One event per Unicity ID per author |
| Base identity binding | `SHA256('unicity:identity:' + nostrPubkey)` | One event per identity (no Unicity ID) |

These are different d-tags, so they create **separate** replaceable events. A wallet that first publishes a base binding and later registers a Unicity ID will have both events on the relay. Only the original author (same Nostr pubkey) can replace their own events.

## Anti-Hijacking

### Conflict Detection (publish-time)

`publishNametagBinding()` queries the relay before publishing. If the Unicity ID is already claimed by a different pubkey, it throws `"already claimed"`. Same pubkey re-publishing (update) is allowed.

**TOCTOU caveat:** There is a race window between the conflict check and the publish. Another user can claim the same Unicity ID in between. This is inherent to Nostr's eventually-consistent relay model — there is no atomic check-and-publish. The mint-before-publish ordering (see below) provides the real enforcement via on-chain state.

### Resolution Strategy (query-time)

All query methods (`queryPubkeyByNametag`, `queryBindingByNametag`, `queryBindingByAddress`) use a two-level strategy:

1. **First-seen-wins across authors** — if multiple pubkeys claim the same Unicity ID or address tag, the author who published the earliest `created_at` event wins. Prevents hijacking. Ties are broken deterministically by lexicographic pubkey comparison (lowest wins).

2. **Latest-wins for same author** — if the rightful owner has multiple events (e.g., initial bare binding + later Unicity ID binding), the most recent event is returned. Ensures the most complete data is returned.

3. **Signature verification** — events with invalid signatures are silently skipped. This prevents malicious relays from injecting forged events to hijack Unicity ID resolution.

This is critical for Path C (register Unicity ID after creation). Address-based lookups find both the old bare binding and the newer Unicity ID binding. Without latest-wins-for-same-author, the stale bare binding (without Unicity ID) would be returned.

### Mint-Before-Publish

`registerNametag()` mints the Unicity ID token on-chain **before** publishing to Nostr. This ensures:
- If minting fails → nothing published (no unbacked claims)
- If minting succeeds but publishing fails → error is surfaced to the user
- No relay-only Unicity ID claims without blockchain backing

## Privacy

- Unicity ID is **hashed** in all indexed tags: `SHA256('unicity:nametag:' + name)` — relay operators see hashes, not plaintext
- Addresses are **hashed** in `t` tags: `SHA256('unicity:address:' + address)` — same relay-level privacy
- **Plaintext Unicity ID is stored in event content** (`content.nametag`). This is intentional: Unicity IDs must be publicly resolvable for the system to work (sending tokens to `@alice` requires resolving her addresses). The tag hashing provides relay-level indexing privacy, while content is publicly readable for kind 30078 events.
- `encrypted_nametag` (AES-GCM) is a separate copy encrypted with the author's private key, enabling wallet recovery on import without relying on the plaintext field
- `pubkey` and `l1` tags contain unhashed values for backward-compatible lookups

## SDK API

### Publishing

```typescript
// Register nametag (mints on-chain first, then publishes)
await sphere.registerNametag('alice');

// Low-level: publish identity binding directly
await transport.publishIdentityBinding(chainPubkey, l1Address, directAddress, 'alice');
```

### Resolving

```typescript
// Unified resolution (accepts @nametag, address, pubkey)
const peer = await sphere.resolve('@alice');
// { nametag, transportPubkey, chainPubkey, l1Address, directAddress, proxyAddress, timestamp }

// Low-level nostr-js-sdk methods
const pubkey = await nostrClient.queryPubkeyByNametag('alice');
const info = await nostrClient.queryBindingByNametag('alice');
const info = await nostrClient.queryBindingByAddress('alpha1...');
```

### Recovery

```typescript
// Automatic on wallet import/load
const { sphere } = await Sphere.init({ mnemonic: '...', ... });
// If nametag found on relay → sphere.identity.nametag is set
// Emits 'nametag:recovered' event
```
