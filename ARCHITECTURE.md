# Sphere SDK — Architecture

This document explains how the Sphere SDK works underneath the friendly API. The [README](README.md) deliberately avoids this depth; if you are integrating, extending, or debugging the SDK, start here.

The whole system rests on one idea, repeated at every layer: **a single key per user, and cryptographic proofs carried peer‑to‑peer instead of stored on a chain.**

---

## 1. One key, many identities

A wallet is created from a BIP‑39 recovery phrase. That phrase derives a single secp256k1 private key (BIP‑32, path `m/44'/0'/0'/0/{index}`), and from that one key the SDK derives every address a user needs:

```
recovery phrase
   └─ BIP-39 seed
        └─ BIP-32 master key  (HMAC-SHA512 "Bitcoin seed")
             └─ child private key d at m/44'/0'/0'/0/{index}
                  │
                  ├─ used DIRECTLY (key = d):
                  │    ├─ chain public key — 33-byte compressed secp256k1
                  │    │      → messaging/transport identity (x-only: pubkey.slice(2))
                  │    │      → Unicity-ID binding, signMessage / verifySignedMessage
                  │    └─ ALPHA address — alpha1… (hash160 of the chain public key)
                  │
                  └─ HASHED FIRST (key = SHA-256(d), via SigningService.createFromSecret):
                       └─ token signing key
                              → wallet token address (DIRECT://…)
                              → owns and signs tokens on the main network
```

> **There are actually two secp256k1 keypairs per address — this trips people up.** The **raw** child key `d` drives the messaging identity (the transport key is the chain public key with its parity prefix stripped, `pubkey.slice(2)`), the Unicity-ID binding, message signing, and the ALPHA address. The **token** key is `SHA-256(d)`: `SigningService.createFromSecret(secret)` hashes the secret *before* using it, so the `DIRECT://` token address and all token signatures are a **different elliptic‑curve point** from the chain/messaging key. Code that needs the token key must go through `SigningService.createFromSecret(privKey)` (as `deriveL3PredicateAddress` does). Using `new SigningService(privKey)` (the raw constructor) gives the messaging key instead — it will *not* match the token address. See [docs/IDENTITY-CRYPTO.md](docs/IDENTITY-CRYPTO.md).

**One recovery phrase still fully reconstructs everything** — both keypairs derive deterministically from the same child key, and (with help from the relay) so does the user's Unicity ID.

A second key system appears in exactly one place: the optional IPFS/IPNS token backup derives an **Ed25519** key from the wallet secret via HKDF (`info = "ipfs-storage-ed25519-v1"`). Nothing else uses a second curve.

### Identity shape

```typescript
interface Identity {
  chainPubkey: string;     // 33-byte compressed secp256k1 (token network)
  directAddress?: string;  // DIRECT://…  — primary wallet address
  l1Address: string;       // alpha1…     — ALPHA base-chain coin only
  ipnsName?: string;       // identifier for IPFS token backup
  nametag?: string;        // the Unicity ID (human-readable handle, e.g. @alice)
}
```

---

## 2. The two networks

The Sphere SDK spans two independent networks. The README calls them "tokens" and "the ALPHA coin"; here are their real names and mechanics. (Historically these are referred to as **L3** and **L1**.)

### 2a. The Unicity token network ("L3") — the core

This is what the Sphere SDK is fundamentally for. A **token** is a self‑contained cryptographic object: a genesis (mint) record plus a chain of transfers, each anchored by a Merkle **inclusion proof** signed by a Byzantine‑fault‑tolerant validator set (the *trust base*).

The defining property: **only a commitment (a hash) is ever published on the network.** The token itself — its full history and proofs — lives off‑chain and travels directly between users (over the messaging transport). This buys three things:

- **Privacy** — the network reveals nothing about amounts, token types, or parties.
- **Scale** — a consensus round absorbs an enormous number of commitments; it is effectively one global sparse Merkle tree of spent states.
- **Offline creation** — commitments can be built without connectivity and submitted later.

The service that batches commitments into rounds and issues the signed proofs is the **aggregator** (the SDK calls it the *Oracle*).

### 2b. The ALPHA blockchain ("L1")

A conventional UTXO chain, Bitcoin‑style (SegWit / P2WPKH, bech32 `alpha1…` addresses). The SDK builds and signs transactions by hand (BIP‑143 signature hashing, low‑S canonical signatures, a fixed fee, 546‑sat dust threshold) and talks to a **Fulcrum** Electrum server over a WebSocket. The connection is *lazy* — it isn't opened until the first ALPHA operation.

It also includes a **vesting classifier**: it traces each coin back to the coinbase that created it to label it vested or unvested, caching results in IndexedDB (browser) or memory (Node).

### Network presets

`createBrowserProviders({ network })` / `createNodeProviders({ network })` wire every service from one name. Endpoint values come from `constants.ts`:

| Service | mainnet | testnet | dev |
|---|---|---|---|
| Aggregator | `aggregator.unicity.network/rpc` | `goggregator-test.unicity.network` | `dev-aggregator.dyndns.org/rpc` |
| Messaging relay | `relay.unicity.network` | `nostr-relay.testnet.unicity.network` | `nostr-relay.testnet.unicity.network` |
| Fulcrum (ALPHA) | `fulcrum.unicity.network:50004` | `fulcrum.unicity.network:50004` | `fulcrum.unicity.network:50004` |
| Group‑chat relay | `sphere-relay.unicity.network` | `sphere-relay.unicity.network` | `sphere-relay.unicity.network` |

Token metadata (symbols, decimals, icons) is fetched from a remote registry and cached; prices are optional via a CoinGecko provider.

---

## 3. How a token transfer works

Sending a token reduces to: commit, prove, deliver.

```
1. Resolve recipient (Unicity ID / DIRECT:// / pubkey) → an address object
2. Build a TransferCommitment over the token, recipient, a random 32-byte salt,
   an optional on-chain message, signed with the sender's key
3. Submit the commitment to the aggregator
4. Wait for the inclusion proof (proof the commitment landed in a round)
5. Turn commitment + proof into a finalized transfer transaction
6. Deliver { sourceToken, transferTx } to the recipient over the messaging transport
7. Recipient verifies the proof locally against the trust base — the sender is never trusted
```

When the amount is smaller than a single token's value, the SDK performs an **atomic split**: it burns the original and mints two new tokens (one for the recipient, one as change), each proof‑verified. Split salts are *deterministic* (derived from the token id and amounts), so a split is replayable and idempotent rather than duplicating value.

### Two transfer modes

- **Instant** (default) — all tokens are bundled into one message and shipped immediately; proofs are resolved in the background. Fast; failure can leave a partial delivery.
- **Conservative** — each token is fully proven before it is sent. Slower; all‑or‑nothing per token.

### Verification (the trust anchor)

A recipient (or any holder) confirms a token by recomputing its state, deriving a `RequestId`, fetching the inclusion proof from the aggregator, and checking the Merkle path against the **trust base**:

```
spent  ⟺  merkleTreePath.verify(requestId) is valid AND included AND authenticator ≠ null
```

This is the single mechanism behind double‑spend detection, receive‑side validation, and swap payout verification.

---

## 4. TXF — the token storage/wire format

Tokens are stored and transmitted as **TXF (Token eXchange Format)**, a version‑stable JSON that mirrors the on‑chain proof structure:

```
TxfToken {
  version: "2.0",
  genesis,                 // mint record + inclusion proof
  state,                   // current ownership predicate
  transactions[],          // history; inclusionProof == null means "pending"
  nametags?, _integrity?
}
   inclusionProof {
     authenticator { algorithm, publicKey, signature, stateHash },
     merkleTreePath { root, steps[] },
     unicityCertificate     // CBOR, signed by the BFT validator set
   }
```

Everything is normalized to hex for cross‑version stability. Storage layers it into a document with reserved keys (`_meta`, `_tombstones`, `_outbox`, …) and `_{tokenId}` entries; spent states get tombstones, and divergent histories are kept under `_forked_…` keys.

Helpers: `tokenToTxf`, `txfToToken`, `buildTxfStorageData`, `parseTxfStorageData`, `getCurrentStateHash`, `hasUncommittedTransactions`.

### Validating tokens directly

```typescript
import { createTokenValidator } from '@unicitylabs/sphere-sdk';

const validator = createTokenValidator({ aggregatorClient, trustBase });
const { validTokens, issues } = await validator.validateAllTokens(tokens);
const isSpent = await validator.isTokenStateSpent(tokenId, stateHash, publicKey);
```

---

## 5. Messaging transport

All peer‑to‑peer delivery — token transfers, payment requests, direct messages — rides on Nostr relays.

- **Direct messages** use NIP‑17 gift wrap: a three‑layer envelope (rumor → seal → gift wrap) encrypted with NIP‑44 under an ephemeral key, with timestamps randomized ±2 days for privacy.
- **Token transfers** are a custom event kind, NIP‑04 encrypted, tagged to the recipient.
- **Identity binding** uses a replaceable event (kind 30078) that maps a Unicity ID ↔ transport key ↔ wallet addresses, with first‑seen‑wins anti‑hijacking and an encrypted Unicity ID that can be recovered after import. (In the API/transport this is the `nametag`.)
- **Group chat** uses NIP‑29 on a dedicated relay with its own connection, separate from the wallet transport.

The transport persists a per‑wallet "last seen" timestamp so reconnects resume rather than replay history, and verifies publishes by querying the relay back for the event.

---

## 6. Module map

```
Sphere (entry point: init / create / load / import / clear)
├── payments          — token transfers, balances, history
│   └── l1            — ALPHA blockchain operations (lazy Fulcrum connection)
├── accounting        — invoices (an invoice IS a token), payment attribution, auto-return
├── swap              — peer-to-peer token swaps via an escrow service
├── communications    — direct messages and broadcasts
├── groupChat         — NIP-29 group messaging (its own relay connection)
├── market            — signed intent board (post/search listings)
└── connect (host)    — dApp ↔ wallet RPC
```

A few notes that explain the design:

- **An invoice is a token.** Accounting mints invoices as tokens with a dedicated token type; payment matching uses an on‑chain memo carrying a *hash* of the invoice id (so third parties can't correlate), with the refund address and contact riding on‑chain but never in cleartext.
- **Swap rides on accounting rides on payments.** Deposits happen by paying escrow‑issued invoices; the SDK is a *client* of the escrow service and never custodies funds. Manifests are signed and content‑hashed (`swap_id = SHA‑256` of the canonical manifest, byte‑identical to the escrow's computation).
- **Modules reuse the layer below** rather than reimplementing it — no module re‑invents transfers or transport.

---

## 7. Providers and storage

The Sphere SDK is platform‑agnostic through five injectable interfaces:

| Provider | Role | Browser default | Node default |
|---|---|---|---|
| `StorageProvider` | wallet keys, per‑address data | IndexedDB | files (atomic write) |
| `TokenStorageProvider` | token data (TXF) | IndexedDB per address | files per address |
| `TransportProvider` | peer‑to‑peer messaging | Nostr (native WS) | Nostr (`ws`) |
| `OracleProvider` | aggregator / proofs | included | included |
| `PriceProvider` | fiat prices | optional (CoinGecko) | optional (CoinGecko) |

Wallet data is namespaced: global keys (recovery phrase, master key, tracked addresses, caches) and per‑address keys scoped by an `addressId` derived from the wallet address. `Sphere.clear()` deletes them in a strict order (vesting cache → token databases → key store) to avoid leaving partial state.

See [docs/PROVIDERS-AND-CONFIG.md](docs/PROVIDERS-AND-CONFIG.md) for configuration, custom providers, and runtime management.

---

## 8. Dependency stack

The Sphere SDK is composition on top of Unicity's protocol packages:

```
@unicitylabs/sphere-sdk
├─ @unicitylabs/state-transition-sdk     ← the token engine (mint/transfer/split, commitments, proofs)
│    ├─ @unicitylabs/commons             ← signing, hashing, sparse Merkle tree, CBOR, RequestId, InclusionProof
│    └─ @unicitylabs/bft-js-sdk          ← RootTrustBase, UnicityCertificate (BFT consensus anchor)
├─ @unicitylabs/nostr-js-sdk             ← messaging crypto (NIP-04/17/44, identity binding)
├─ @noble/curves, @noble/hashes          ← modern curve/hash primitives
├─ elliptic, crypto-js                   ← secp256k1 + SHA/RIPEMD/HMAC/AES (core + ALPHA chain)
├─ bip39                                 ← recovery phrases
├─ canonicalize                          ← RFC-8785 JSON canonicalization (swap manifests, invoice ids)
└─ optional: @libp2p/crypto, @libp2p/peer-id, ipns, multiformats (IPFS backup), ws (Node)
```

The irreducible bottom is `@unicitylabs/commons` (Merkle + CBOR + hashing) and `@unicitylabs/bft-js-sdk` (the trust base), plus secp256k1. Everything above is built from those.

---

## In one sentence

*One wallet key derives a base‑chain address and a messaging identity directly, plus a token‑custody key one SHA‑256 step further; tokens live as self‑verifying off‑chain proof bundles passed directly between users, while the network only ever sees opaque commitments validated against a BFT trust base.*
