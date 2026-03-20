# NFT Standards Research

> **Purpose:** Comprehensive survey of NFT standards across blockchain ecosystems, informing the design of NFT support in Sphere SDK.
> **Date:** 2026-03-20

---

## Table of Contents

1. [Ethereum NFT Standards](#1-ethereum-nft-standards)
   - [ERC-721](#11-erc-721-non-fungible-token-standard)
   - [ERC-1155](#12-erc-1155-multi-token-standard)
   - [ERC-2981](#13-erc-2981-royalty-standard)
   - [ERC-4907](#14-erc-4907-rental-nft)
   - [ERC-5192](#15-erc-5192-soulbound-token)
   - [ERC-6551](#16-erc-6551-token-bound-accounts)
   - [ERC-7572](#17-erc-7572-contract-level-metadata)
2. [Non-Ethereum NFT Standards](#2-non-ethereum-nft-standards)
   - [Bitcoin Ordinals](#21-bitcoin-ordinals)
   - [Cardano Native Tokens](#22-cardano-native-tokens)
   - [Solana Metaplex](#23-solana-metaplex)
   - [Flow Cadence](#24-flow-cadence-resources)
   - [Cosmos ICS-721](#25-cosmos-ics-721)
   - [Tezos FA2](#26-tezos-fa2)
   - [NEAR NEP-171](#27-near-nep-171)
3. [Metadata Standards](#3-metadata-standards)
   - [JSON Metadata Schema](#31-json-metadata-schema)
   - [Storage Approaches](#32-storage-approaches)
   - [Dynamic Metadata](#33-dynamic-metadata)
4. [Comparative Analysis](#4-comparative-analysis)
5. [Relevance to Unicity](#5-relevance-to-unicity)

---

## 1. Ethereum NFT Standards

### 1.1 ERC-721: Non-Fungible Token Standard

**EIP-721** (Final, June 2018) defines the foundational standard for non-fungible tokens on Ethereum.

#### Core Interface (IERC721)

| Method | Signature | Description |
|--------|-----------|-------------|
| `balanceOf` | `(address owner) → uint256` | Count of NFTs owned by address |
| `ownerOf` | `(uint256 tokenId) → address` | Current owner of a specific token |
| `safeTransferFrom` | `(address from, address to, uint256 tokenId, bytes data)` | Transfer with receiver validation |
| `safeTransferFrom` | `(address from, address to, uint256 tokenId)` | Transfer with receiver validation (no data) |
| `transferFrom` | `(address from, address to, uint256 tokenId)` | Transfer without receiver check |
| `approve` | `(address approved, uint256 tokenId)` | Approve single-token operator |
| `setApprovalForAll` | `(address operator, bool approved)` | Approve/revoke all-token operator |
| `getApproved` | `(uint256 tokenId) → address` | Get approved address for token |
| `isApprovedForAll` | `(address owner, address operator) → bool` | Check operator approval |

#### Events

| Event | Parameters | When |
|-------|------------|------|
| `Transfer` | `from, to, tokenId` | Ownership change (including mint/burn) |
| `Approval` | `owner, approved, tokenId` | Single-token approval set |
| `ApprovalForAll` | `owner, operator, approved` | Operator approval changed |

#### Metadata Extension (ERC721Metadata)

```solidity
function name() → string         // Collection name ("Bored Ape Yacht Club")
function symbol() → string       // Collection symbol ("BAYC")
function tokenURI(uint256) → string  // Per-token metadata URI
```

The `tokenURI` returns a URI pointing to a JSON document conforming to the ERC-721 Metadata JSON Schema (see [§3.1](#31-json-metadata-schema)).

#### Enumerable Extension (ERC721Enumerable)

```solidity
function totalSupply() → uint256                         // Total minted (minus burned)
function tokenByIndex(uint256 index) → uint256            // Global token enumeration
function tokenOfOwnerByIndex(address, uint256) → uint256  // Per-owner enumeration
```

Adds gas overhead to minting and transfers but enables full enumeration. Many modern implementations omit this in favor of off-chain indexing.

#### Receiver Interface (ERC721Receiver)

```solidity
function onERC721Received(address operator, address from, uint256 tokenId, bytes data) → bytes4
```

Must return selector `0x150b7a02`. Called by `safeTransferFrom` when recipient is a contract. Prevents tokens from being permanently locked in incompatible contracts.

#### Key Design Properties

- **One token = one owner.** No fractional ownership at the protocol level.
- **Token IDs are uint256.** Assignment strategy is implementation-defined (sequential, hash-based, etc.).
- **Approval model is two-tier:** per-token approval (one address per token) and per-owner operator approval (blanket access).
- **Mint/burn are transfers.** Mint is `Transfer(address(0), to, tokenId)`, burn is `Transfer(from, address(0), tokenId)`.

#### Security Considerations

- **Reentrancy via `onERC721Received`:** Receiver callback can re-enter the contract.
- **Unchecked `transferFrom`:** Does not validate receiver capability — tokens can be locked.
- **Approval persistence:** Approved address is NOT cleared on transfer in some implementations.
- **ERC-165 detection:** Contracts MUST implement `supportsInterface(0x80ac58cd)` for ERC-721.

---

### 1.2 ERC-1155: Multi Token Standard

**EIP-1155** (Final) enables a single contract to manage both fungible and non-fungible tokens.

#### Core Interface (IERC1155)

| Method | Signature | Description |
|--------|-----------|-------------|
| `balanceOf` | `(address, uint256 id) → uint256` | Balance of specific token type |
| `balanceOfBatch` | `(address[], uint256[] ids) → uint256[]` | Batch balance query |
| `safeTransferFrom` | `(address from, address to, uint256 id, uint256 amount, bytes data)` | Transfer with amount |
| `safeBatchTransferFrom` | `(address from, address to, uint256[] ids, uint256[] amounts, bytes data)` | Batch transfer |
| `setApprovalForAll` | `(address operator, bool approved)` | Operator approval |
| `isApprovedForAll` | `(address, address) → bool` | Check operator approval |

#### Events

| Event | Parameters | When |
|-------|------------|------|
| `TransferSingle` | `operator, from, to, id, value` | Single token transfer |
| `TransferBatch` | `operator, from, to, ids, values` | Batch transfer |
| `ApprovalForAll` | `account, operator, approved` | Operator approval change |
| `URI` | `value, id` | Metadata URI updated |

#### Metadata URI Extension

```solidity
function uri(uint256 id) → string
```

Supports `{id}` substitution in URI templates. For token ID `0x00000000000000000000000000000001`, clients replace `{id}` with the hex-padded ID in the returned URI string.

#### Fungible vs Non-Fungible Handling

ERC-1155 unifies both token types in a single contract:

| Aspect | Fungible | Non-Fungible |
|--------|----------|--------------|
| Supply | Unlimited (amount > 1) | Exactly 1 |
| Interchangeability | All tokens with same ID identical | Each ID unique |
| Balance | `balanceOf(owner, id) >= 0` | `balanceOf(owner, id) ∈ {0, 1}` |
| Use case | In-game currencies, materials | Unique items, art |

**Semi-fungible pattern:** Tokens start as fungible (e.g., event tickets) and become non-fungible after use (e.g., used ticket = collectible).

#### Token ID Encoding Patterns

Common (but not mandatory) encoding:

```
256-bit token ID
├── Upper 128 bits: collection/type identifier
└── Lower 128 bits: item index within collection
```

Formula: `tokenId = (collectionId << 128) + itemIndex`

This encoding is purely conventional — the standard does not mandate any particular structure for token IDs.

#### Gas Efficiency

| Operation | ERC-721 | ERC-1155 | Savings |
|-----------|---------|----------|---------|
| Transfer 1 token | ~65K gas | ~52K gas | ~20% |
| Transfer 100 tokens | ~6.5M gas | ~467K gas | ~93% |
| Per-token in batch | ~65K | ~4.7K | ~93% |

Batch operations achieve order-of-magnitude gas savings by amortizing base transaction costs and storage slot packing.

---

### 1.3 ERC-2981: Royalty Standard

Provides a standardized on-chain royalty declaration (no enforcement).

```solidity
function royaltyInfo(uint256 tokenId, uint256 salePrice) → (address receiver, uint256 royaltyAmount)
```

- Returns royalty recipient and amount for any given sale price.
- Typically expressed as basis points (e.g., 500 = 5%).
- **Not enforced** — marketplaces must voluntarily query and honor royalties.
- Maximum recommended royalty: 100% of sale price (the standard does not restrict).
- Can return different royalty info per tokenId.

**Limitation:** Since enforcement is voluntary, creator royalties have become increasingly optional across major marketplaces (2023-2024 trend). Some chains (e.g., Stacks SIP-090) enforce on-chain, but ERC-2981 cannot.

---

### 1.4 ERC-4907: Rental NFT

Adds a time-limited "user" role separate from ownership.

```solidity
function setUser(uint256 tokenId, address user, uint64 expires)  // Set user + expiry
function userOf(uint256 tokenId) → address                        // Current user
function userExpires(uint256 tokenId) → uint256                   // Expiry timestamp
```

- **Event:** `UpdateUser(uint256 tokenId, address user, uint64 expires)`
- User role expires automatically — no revocation transaction needed.
- Enables rental/lending without transferring ownership.
- User has NO transfer rights — ownership remains with the original owner.

---

### 1.5 ERC-5192: Soulbound Token

Minimal interface for non-transferable tokens.

```solidity
function locked(uint256 tokenId) → bool  // True if token cannot be transferred
```

- **Event:** `Locked(uint256 tokenId)` and `Unlocked(uint256 tokenId)`
- Builds on top of ERC-721 — adds transfer restriction, not a new token type.
- Use cases: credentials, memberships, reputation, identity attestations.
- **Consensual variant (ERC-5484):** Requires both issuer and receiver consent.

---

### 1.6 ERC-6551: Token Bound Accounts

Each NFT becomes a smart contract wallet (account).

- **Registry contract** deploys deterministic account addresses for any `(chainId, tokenContract, tokenId)` tuple.
- Account ownership follows NFT ownership automatically.
- The NFT's account can hold other tokens, NFTs, or interact with protocols.
- Use cases: game characters holding inventory, profile NFTs with history, composable NFT bundles.

**Architecture:**

```
NFT (ERC-721)
  └── Token Bound Account (ERC-6551 Registry → CREATE2 address)
        ├── Holds ERC-20 tokens
        ├── Holds other ERC-721 NFTs
        └── Interacts with DeFi protocols
```

---

### 1.7 ERC-7572: Contract-Level Metadata

Standardizes collection-level metadata (not per-token).

```solidity
function contractURI() → string   // URI to collection-level metadata JSON
```

- **Event:** `ContractURIUpdated()` — emitted when metadata changes.
- JSON schema includes: `name`, `description`, `image`, `banner_image`, `featured_image`, `external_link`, `collaborators`.
- Complements per-token `tokenURI` with collection-wide information.

---

## 2. Non-Ethereum NFT Standards

### 2.1 Bitcoin Ordinals

**Ownership model:** UTXO-based (no smart contracts).

Ordinal Theory assigns sequential numbers to individual satoshis based on the order they were mined. Inscriptions embed arbitrary data (images, JSON, HTML) into the witness data of a Bitcoin transaction.

#### Key Mechanics

| Aspect | Detail |
|--------|--------|
| **Ownership proof** | Whoever controls the UTXO containing the inscribed satoshi owns the inscription |
| **Transfer** | Standard UTXO spend — must carefully control input/output ordering per Ordinal Theory |
| **Metadata** | Immutable, stored on-chain in witness data (Taproot script-path spend) |
| **Collection** | Logical grouping by creator pubkey, inscription number sequence, or parent-child inscriptions |
| **Uniqueness** | Each satoshi has a unique ordinal number; each inscription is a unique creation event |

#### Inscription Process (Commit-Reveal)

1. **Commit transaction:** Creates a Taproot output with the inscription script committed in the script tree.
2. **Reveal transaction:** Spends the commit output via script-path, revealing the inscription in the witness stack.

#### BRC-721 (Unofficial Extension)

Proposed optimization: store collection metadata + image once, reference by index in individual inscriptions. Reduces per-NFT minting cost dramatically.

#### Relevance to Unicity

- **Closest UTXO-based precedent.** Unicity's L1 uses a UTXO model similar to Bitcoin.
- **No smart contracts.** Ownership is structural (ledger-based), not code-based — aligns with Unicity's predicate model.
- **Immutable metadata.** Once inscribed, data cannot be changed — similar to Unicity's genesis `tokenData`.

---

### 2.2 Cardano Native Tokens

**Ownership model:** Ledger-verified minting policies (no smart contracts required for basic NFTs).

Cardano's EUTXO model treats tokens as native ledger assets. NFTs are tokens with a supply of 1, governed by a minting policy.

#### Key Mechanics

| Aspect | Detail |
|--------|--------|
| **Ownership proof** | UTXO holding the token — no contract state lookup needed |
| **Transfer** | Standard UTXO transfer — token moves with the UTXO |
| **Metadata** | CIP-25 (transaction label 721) or CIP-68 (dynamic, smart-contract-backed) |
| **Collection** | **Policy ID** — all tokens minted under the same policy form a collection |
| **Uniqueness** | Guaranteed by minting policy: if policy requires unique asset names, supply=1 is enforced |

#### Policy ID as Collection Identifier

- Policy ID = hash of the minting policy script.
- Time-locked policies: after lock time passes, no new tokens can be minted → collection is provably finite.
- Open policies: minting remains open indefinitely.
- Ecosystem standard: wallets, marketplaces, and explorers all group by policy ID.

#### CIP-25 Metadata Standard

```json
{
  "721": {
    "<policy_id>": {
      "<asset_name>": {
        "name": "SpaceBud #1",
        "image": "ipfs://QmHash",
        "mediaType": "image/png",
        "description": "A SpaceBud",
        "attributes": [...]
      }
    }
  }
}
```

Attached to the minting transaction via transaction metadata label `721`.

#### Relevance to Unicity

- **Most aligned with Unicity's philosophy.** Predicate-based ownership (like minting policies), no smart contracts for basic operations.
- **Policy-based collections** map naturally to Unicity's `tokenType` constant.
- **UTXO transfer** matches Unicity's state transition model.
- **Metadata in genesis** matches Unicity's `genesis.data.tokenData` pattern.

---

### 2.3 Solana Metaplex

**Ownership model:** Token accounts + Program Derived Addresses (PDAs).

#### Key Mechanics

| Aspect | Detail |
|--------|--------|
| **Ownership proof** | Token account holding 1 unit of the mint + Master Edition PDA exists |
| **Transfer** | Token program transfer (move token between accounts) |
| **Metadata** | PDA derived from mint address stores on-chain metadata |
| **Collection** | `collection` field in metadata pointing to a master collection NFT |
| **Uniqueness** | Master Edition PDA existence proves non-fungibility (supply=1) |

#### Token Standards

| Standard | Supply | Use Case |
|----------|--------|----------|
| NonFungible | 1 | Unique 1/1 art |
| FungibleAsset | >1 | Semi-fungible items |
| Fungible | unlimited | Currencies |
| NonFungibleEdition | 1 (derived) | Print editions from master |
| Programmable | 1 (with rules) | Royalty-enforced NFTs |

#### Compressed NFTs (cNFTs)

- Uses concurrent Merkle trees for state compression.
- Store NFT state as leaf hashes on-chain; full data off-chain.
- Minting cost: ~$0.0005 per NFT (vs ~$2 for standard).
- Transfer requires Merkle proof in transaction.
- Trade-off: composability is harder (must provide proof for every interaction).

#### Relevance to Unicity

- **PDA derivation** similar to Unicity's predicate-based state.
- **Merkle tree compression** conceptually similar to Unicity's Sparse Merkle Tree aggregation.
- **Metadata as separate concern** — Unicity similarly separates token state from metadata.

---

### 2.4 Flow Cadence Resources

**Ownership model:** Resource-oriented programming with linear types.

#### Key Mechanics

| Aspect | Detail |
|--------|--------|
| **Ownership proof** | Resource stored directly in account storage (not in a central contract ledger) |
| **Transfer** | Move operator (`<-`) — enforced at compile time, resource exists in exactly one place |
| **Metadata** | MetadataViews interface — modular, extensible metadata system |
| **Collection** | Collection resource interface groups related NFTs in an account |
| **Uniqueness** | Compiler enforces: resources cannot be copied, only moved |

#### Linear Type Safety

```cadence
// Resources can only be moved, never copied
let nft <- collection.withdraw(tokenId)  // Removes from source
recipient.deposit(token: <-nft)           // Moves to destination
// nft is now invalid — compiler prevents use after move
```

#### Relevance to Unicity

- **Token-as-resource** concept aligns with Unicity's "token IS the thing" philosophy.
- **No central ledger** — each account holds its own assets, similar to Unicity's per-wallet token storage.
- **Move semantics** parallel Unicity's state transition model (token moves from one predicate to another).

---

### 2.5 Cosmos ICS-721

**Ownership model:** CW-721 contract (ERC-721-equivalent for CosmWasm) + IBC cross-chain transfer.

#### Cross-Chain Transfer (ICS-721)

```
Source Chain                    Destination Chain
┌──────────┐   IBC packet    ┌──────────┐
│ Lock NFT  │ ──────────────> │ Mint     │
│ in escrow │                 │ voucher  │
└──────────┘                  └──────────┘
     ↑          IBC packet         │
     └──────────────────────────── ┘
              Return: burn voucher,
              unlock original
```

- Debt-voucher model: original locked on source chain, replica minted on destination.
- Metadata preserved across chains via IBC packet data.
- Class ID (≈ contract address) identifies the collection.

#### Relevance to Unicity

- **Cross-chain NFT transfer** could inspire future L1↔L3 NFT portability.
- **Escrow + mint pattern** already used in Unicity's swap module.

---

### 2.6 Tezos FA2

**Ownership model:** Multi-asset contract (similar to ERC-1155).

- Single contract manages fungible, non-fungible, and semi-fungible tokens.
- Batch transfers built into the standard.
- `transfer` accepts a list of `(from, [(to, token_id, amount)])` entries.
- NFT = token with `amount = 1` in all transfers.
- Collection = all tokens within one FA2 contract.

#### Relevance to Unicity

- Multi-asset in single contract maps to Unicity's ability to store multiple token types in one wallet.

---

### 2.7 NEAR NEP-171

**Ownership model:** Contract-stored ownership (ERC-721-like).

- `nft_transfer(receiver_id, token_id, approval_id, memo)` — basic transfer.
- `nft_transfer_call` — transfer with receiver callback (like `safeTransferFrom`).
- **NEP-177:** Metadata extension (name, symbol, icon, base_uri, reference).
- **NEP-178:** Approval management (per-token, with approval IDs for race-condition safety).
- **NEP-181:** Enumeration (`nft_total_supply`, `nft_tokens`, `nft_supply_for_owner`, `nft_tokens_for_owner`).

#### Relevance to Unicity

- Approval IDs for race-condition safety — interesting pattern for concurrent NFT operations.
- Memo field in transfers aligns with Unicity's memo/message system.

---

## 3. Metadata Standards

### 3.1 JSON Metadata Schema

#### ERC-721 Metadata JSON Schema

```json
{
  "name": "Token Name",
  "description": "Token description",
  "image": "ipfs://QmHash...",
  "external_url": "https://example.com/token/1",
  "animation_url": "ipfs://QmVideoHash...",
  "attributes": [
    {
      "trait_type": "Color",
      "value": "Blue"
    },
    {
      "display_type": "number",
      "trait_type": "Generation",
      "value": 2
    },
    {
      "display_type": "boost_percentage",
      "trait_type": "Power Boost",
      "value": 15
    },
    {
      "display_type": "date",
      "trait_type": "Birthday",
      "value": 1640995200
    }
  ]
}
```

#### Extended Metadata Fields (de facto standards)

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Human-readable token name |
| `description` | string | Markdown-enabled description |
| `image` | string | URI to image (IPFS, HTTPS, data:, ar://) |
| `animation_url` | string | URI to multimedia (video, audio, 3D, HTML) |
| `external_url` | string | Link to creator's website |
| `background_color` | string | Hex color for display background (no `#` prefix) |
| `attributes` | array | Trait/property array with `trait_type` and `value` |
| `properties` | object | Arbitrary structured properties (ERC-1155 style) |
| `content` | object | Multi-resolution content (thumbnail, preview, full) |

#### Attribute Display Types

| `display_type` | Rendering |
|-----------------|-----------|
| (omitted) | Text label |
| `number` | Numeric with optional `max_value` |
| `boost_number` | Numeric boost indicator |
| `boost_percentage` | Percentage boost |
| `date` | Unix timestamp → date display |

---

### 3.2 Storage Approaches

| Approach | Immutability | Persistence | Cost | Latency |
|----------|--------------|-------------|------|---------|
| **IPFS + CID** | Content-addressed (immutable) | Requires pinning | Low-moderate | Variable |
| **IPNS** | Mutable pointer to immutable content | Requires pinning | Low | Higher |
| **Arweave** | Permanent, immutable | Guaranteed (200-year endowment) | Higher upfront | Lower |
| **On-chain** | Immutable (in transaction data) | Chain-guaranteed | Highest | Lowest |
| **Centralized (HTTPS)** | Mutable (server-controlled) | Server-dependent | Lowest | Lowest |

#### Best Practices

1. **Use IPFS URIs** (`ipfs://QmHash...`) in metadata, not gateway URLs (`https://ipfs.io/ipfs/...`).
2. **Pin content** via dedicated services (Pinata, nft.storage, Filebase) or run own IPFS node.
3. **Reference CIDs** for images/media inside metadata JSON — ensures integrity.
4. **Store metadata JSON as IPFS object** — the `tokenURI` points to `ipfs://QmMetadataHash`.
5. **Content addressing** ensures: if the content matches the CID, it's authentic regardless of where it was fetched from.

---

### 3.3 Dynamic Metadata

Some NFTs require mutable metadata (game items, evolving art, status tokens):

| Pattern | Mechanism | Trade-offs |
|---------|-----------|------------|
| **IPNS pointer** | IPNS name → latest IPFS CID | Content-addressed but mutable pointer |
| **On-chain state** | Token contract stores mutable fields | Gas cost per update, fully verifiable |
| **Centralized API** | Server returns current metadata | No immutability guarantee |
| **Event-based** | `URI` event signals metadata change | Indexers must track events |
| **Metadata freeze** | `PermanentURI` event (ERC-4906) | Irreversible immutability signal |

---

## 4. Comparative Analysis

### Ownership Models

| Chain | Model | Smart Contract Required | Predicate/Policy Based |
|-------|-------|------------------------|----------------------|
| Ethereum | Contract ledger | Yes | No |
| Bitcoin | UTXO (Ordinals) | No | No (Ordinal Theory) |
| **Cardano** | **UTXO + Policy** | **No** | **Yes** |
| Solana | Token account + PDA | Yes | Partial (PDA derivation) |
| Flow | Account storage (resources) | Yes (but different) | No (type system) |
| **Unicity** | **State + Predicate** | **No** | **Yes** |

### Metadata Location

| Chain | Primary | Mutable | Content-Addressed |
|-------|---------|---------|-------------------|
| Ethereum | Off-chain (IPFS/HTTPS) | Via IPNS or server | IPFS CIDs |
| Bitcoin | On-chain (witness) | No | N/A (immutable) |
| Cardano | Transaction metadata | CIP-68 allows | Optional (IPFS refs) |
| Solana | On-chain PDA | Yes (authority) | Optional |
| **Unicity** | **genesis.data.tokenData** | **No (genesis immutable)** | **Yes (token ID = hash)** |

### Collection Grouping

| Chain | Mechanism | Granularity |
|-------|-----------|-------------|
| Ethereum | Contract address | One collection per contract |
| Cardano | **Policy ID** | All tokens under same policy |
| Solana | Collection metadata field | Points to collection NFT |
| Flow | Collection resource interface | Per-account grouping |
| **Unicity** | **tokenType constant** | **All tokens with same type = collection class** |

---

## 5. Relevance to Unicity

### Best-Fit Models

1. **Cardano** is the closest architectural match:
   - Predicate-based ownership (minting policies ≈ Unicity predicates)
   - No smart contracts for basic operations
   - Metadata in transaction (genesis) data
   - Policy ID for collection grouping ≈ Unicity tokenType

2. **Bitcoin Ordinals** for UTXO-based concepts:
   - Structural ownership (whoever controls the UTXO owns the token)
   - Immutable metadata inscribed at creation
   - No smart contract overhead

3. **Flow's resource model** for philosophy:
   - "Token IS the thing" — tokens are self-contained objects, not entries in a ledger
   - Per-account storage — each wallet holds its own tokens
   - Move semantics — tokens transition between states

### Unicity-Native Advantages

| Feature | How Unicity Compares |
|---------|---------------------|
| **Token identity** | Token ID derived from SHA-256 of genesis data — content-addressed by design |
| **Ownership proof** | Aggregator inclusion proof (SMT path) — cryptographic, not ledger-lookup |
| **Immutable genesis** | `genesis.data.tokenData` is immutable once minted — like Ordinals inscriptions |
| **Predicate-based transfer** | Predicate satisfaction authorizes transfers — like Cardano's minting policies |
| **No smart contracts** | State transitions via predicates — simpler, more verifiable |
| **Existing module pattern** | Invoice tokens prove the model works for non-fungible token types |

### Standards to Adopt (Adapted for Unicity)

| Standard | Adoption Level | Rationale |
|----------|---------------|-----------|
| ERC-721 metadata schema | Full | Universal metadata JSON format |
| ERC-2981 royalty info | Metadata-only | Store in metadata, enforce in marketplace |
| ERC-1155 batch concepts | Selective | Batch queries and transfers for efficiency |
| Cardano policy ID model | Core | tokenType = collection type identifier |
| IPFS content addressing | Full | Already integrated in Sphere SDK |
| ERC-5192 soulbound flag | Metadata-only | `transferable: false` in metadata |
| ERC-6551 token-bound | Future | NFTs holding other tokens (composition) |
