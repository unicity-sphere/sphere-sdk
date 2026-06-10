# CLAUDE.md - Sphere SDK Project Context

This file provides context for Claude Code when working with the Sphere SDK project.

## Quick Start (Using SDK as Dependency)

### Installation

**Browser:**
```bash
npm install @unicitylabs/sphere-sdk
```

**Node.js:**
```bash
npm install @unicitylabs/sphere-sdk ws
```

### Complete L3 Wallet Integration Example

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createBrowserProviders } from '@unicitylabs/sphere-sdk/impl/browser';
// For Node.js: import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

// 1. Create providers. `network` is REQUIRED (throws INVALID_CONFIG otherwise).
//    There is NO bundled gateway API key — inject it via oracle.apiKey.
//    The testnet2 key is NOT a secret (see .env.example); a mainnet key IS.
const providers = createBrowserProviders({
  network: 'testnet', // alias of testnet2 — the v2 gateway network
  oracle: { apiKey: 'sk_...' },
});
// Node.js: createNodeProviders({ network: 'testnet', oracle: { apiKey: 'sk_...' },
//                                dataDir: './sphere-data', tokensDir: './sphere-tokens' })

// 2. Init wallet (creates new OR loads existing — single entry point)
const { sphere, created, generatedMnemonic } = await Sphere.init({
  ...providers,
  autoGenerate: true,   // Generate mnemonic if no wallet exists
  nametag: 'alice',     // Optional: register @alice (only on create)
  password: 'secret',   // Optional: encrypt mnemonic (plaintext if omitted)
  accounting: true,     // Enable accounting/invoicing module
  swap: true,           // Enable token swap module
});

if (created && generatedMnemonic) {
  // First run — prompt user to back up mnemonic
  console.log('SAVE THIS:', generatedMnemonic);
}

// 3. Identity is ready
const identity = sphere.identity!;
console.log('L3 address:', identity.directAddress);  // DIRECT://... (primary)
console.log('L1 address:', identity.l1Address);      // alpha1...
console.log('Unicity ID:', identity.nametag);        // alice

// 4. Check tokens and balance
const assets = await sphere.payments.getAssets();
// Asset[]: { coinId, symbol, totalAmount, tokenCount, confirmedAmount,
//            unconfirmedAmount, priceUsd, fiatValueUsd, change24h, ... }

const balances = sphere.payments.getBalance();           // Asset[] (sync, from loaded tokens)
const totalUsd = await sphere.payments.getFiatBalance(); // number | null (null if no PriceProvider)

const tokens = sphere.payments.getTokens();              // individual Token[]
const filtered = sphere.payments.getTokens({ coinId: '...' }); // filter by coin

// 5. Send tokens (L3) — v2 engine path. Requires the token engine (v2 oracle
//    config) and a recipient with a PUBLISHED chain pubkey; fails loudly otherwise.
const result = await sphere.payments.send({
  recipient: '@bob',           // @nametag, DIRECT://..., chain pubkey (02...), or alpha1...
  amount: '1000000',           // in smallest unit (string)
  coinId: 'UCT',               // coin ID (64-hex canonical; short symbols resolved via registry)
  memo: 'Payment for coffee',  // optional
});
// result: { id, status, tokens, tokenTransfers, error? }
// status: 'pending' | 'submitted' | 'confirmed' | 'delivered' | 'completed' | 'failed'

// 6. Receive tokens (explicit one-shot fetch). v2 transfers arrive as FINISHED
//    tokens — stored confirmed immediately, no finalization phase.
//    The old { finalize, timeout, pollInterval } options are deprecated no-ops.
const { transfers } = await sphere.payments.receive();

// Listen for incoming transfers
sphere.on('transfer:incoming', (transfer) => {
  console.log(`From: ${transfer.senderNametag}, Tokens: ${transfer.tokens.length}`);
});

// 7. Self-mint fungible tokens (no faucet — engine.mint to own pubkey)
//    coinId must be even-length lowercase hex (the canonical v2 AssetId form)
const mint = await sphere.payments.mintFungibleToken(coinIdHex, 1000000n);
// { success: true, token, tokenId } | { success: false, error }

// 8. L1 operations (enabled by default, lazy Fulcrum connection)
const l1Balance = await sphere.payments.l1!.getBalance();
// { confirmed, unconfirmed, vested, unvested, total } — all strings in satoshis

const l1Result = await sphere.payments.l1!.send({
  to: 'alpha1...', amount: '100000', feeRate: 5,
});

// 9. Sync with remote storage (IPFS etc.)
const syncResult = await sphere.payments.sync(); // { added, removed }

// 10. Transaction history
const history = sphere.payments.getHistory(); // TransactionHistoryEntry[]

// 11. Peer resolution (Unicity ID → addresses)
const peer = await sphere.resolve('@bob');
// PeerInfo | null: { nametag?, transportPubkey, chainPubkey, l1Address, directAddress, timestamp }

// 12. Multi-address
await sphere.switchToAddress(1);
await sphere.registerNametag('alice2');
const addresses = sphere.getActiveAddresses(); // TrackedAddress[]

// 13. Payment requests
const reqResult = await sphere.payments.sendPaymentRequest('@bob', {
  amount: '1000000', coinId: 'UCT', message: 'Pay for order #1234',
});
const response = await sphere.payments.waitForPaymentResponse(reqResult.requestId!, 120000);

sphere.payments.onPaymentRequest((req) => {
  // Handle incoming: req.senderNametag, req.amount, req.symbol
  sphere.payments.payPaymentRequest(req.id);  // or rejectPaymentRequest()
});

// 13a. Invoicing (requires accounting: true in init; sphere.accounting is nullable)
const invoice = await sphere.accounting!.createInvoice({
  targets: [{ address: identity.directAddress!, assets: [{ coin: ['UCT', '1000000'] }] }],
  memo: 'Order #1234',
});
// invoice.token is the transmittable v2 invoice blob (hex STRING) — pass it to
// importInvoice on the receiving side:
//   const terms = await sphere.accounting!.importInvoice(invoice.token!);

// 13b. Token swaps (requires swap: true in init; sphere.swap is nullable)
const swap = await sphere.swap!.proposeSwap({
  partyA: '@alice', partyB: '@bob',
  partyACurrency: 'UCT',  partyAAmount: '1000000',
  partyBCurrency: 'USDU', partyBAmount: '500000',
  timeout: 3600,                       // seconds, [60, 86400]
  escrowAddress: 'DIRECT://escrow...', // or SwapModuleConfig.defaultEscrowAddress
}, { message: 'wanna trade?' });

// 14. Cleanup
await sphere.destroy();
```

---

## Connect Protocol (dApp ↔ Wallet Integration)

Typed RPC layer for dApp ↔ wallet communication. Full guide: [`docs/CONNECT.md`](docs/CONNECT.md)

| Role | Class | Where it runs |
|------|-------|--------------|
| dApp (client) | `ConnectClient` | any web page / app |
| Wallet (host) | `ConnectHost` | Sphere app / extension background |

**Transports:** `PostMessageTransport` (iframe/popup), `ExtensionTransport` (browser extension), `WebSocketTransport` (Node.js).

**Queries (18):** `sphere_getIdentity`, `sphere_getBalance`, `sphere_getAssets`, `sphere_getFiatBalance`, `sphere_getTokens`, `sphere_getHistory`, `sphere_l1GetBalance`, `sphere_l1GetHistory`, `sphere_resolve`, `sphere_subscribe`, `sphere_unsubscribe`, `sphere_disconnect`, `sphere_getConversations`, `sphere_getMessages`, `sphere_getDMUnreadCount`, `sphere_markAsRead`, `sphere_getInvoices`, `sphere_getInvoiceStatus`.

**Intents (15):** `send`, `l1_send`, `dm`, `payment_request`, `receive`, `sign_message`, `create_invoice`, `close_invoice`, `cancel_invoice`, `pay_invoice`, `return_invoice_payment`, `import_invoice`, `send_invoice_receipts`, `send_cancellation_notices`, `set_auto_return`.

**Permission scopes (16):** `identity:read`, `balance:read`, `tokens:read`, `history:read`, `l1:read`, `events:subscribe`, `resolve:peer`, `transfer:request`, `l1:transfer`, `dm:request`, `dm:read`, `dm:manage`, `payment:request`, `sign:request`, `invoice:read`, `invoice:write`.

**Silent mode:** `new ConnectClient({ ..., silent: true })` — fast-check approved list without UI popup.

**Wallet-pushed events:** `WALLET_EVENTS.LOCKED` (`wallet:locked`), `WALLET_EVENTS.IDENTITY_CHANGED` (`identity:changed`) — pushed by the host without subscription.

---

### What's Included by Default

| Component | Browser | Node.js |
|-----------|---------|---------|
| Storage | IndexedDB (`IndexedDBStorageProvider`) | File-based JSON (`FileStorageProvider`) |
| Token Storage | IndexedDB per-address | File-based per-address |
| Transport (Nostr) | Native WebSocket | `ws` package (install separately) |
| Oracle (network config) | Embedded trust base per network; API key injected via `oracle.apiKey` | Same (+ optional `trustBasePath` file) |
| L1 (ALPHA blockchain) | Enabled, lazy Fulcrum connect | Enabled, lazy Fulcrum connect |
| L1 Vesting Cache | IndexedDB (`SphereVestingCacheV5`) | Memory-only (no persistence) |
| Price (CoinGecko) | Optional (`price` config) | Optional (`price` config) |
| Token Registry | Remote fetch + persistent cache | Remote fetch + file cache |
| IPFS sync | Opt-in (`tokenSync.ipfs.enabled`) | Opt-in |

### Key API Methods Reference

| Method | Returns | Description |
|--------|---------|-------------|
| `Sphere.init(options)` | `{ sphere, created, generatedMnemonic? }` | Create or load wallet |
| `Sphere.exists(storage)` | `Promise<boolean>` | Check if wallet exists |
| `Sphere.clear({ storage, tokenStorage? })` | `void` | Delete all wallet data |
| `Sphere.import(options)` | `Sphere` | Import from mnemonic/masterKey |
| `sphere.payments.getAssets(coinId?)` | `Promise<Asset[]>` | Assets grouped by coin |
| `sphere.payments.getBalance(coinId?)` | `Asset[]` | Synchronous balance from loaded tokens |
| `sphere.payments.getFiatBalance()` | `Promise<number \| null>` | Total USD value |
| `sphere.payments.getTokens(filter?)` | `Token[]` | Get individual tokens |
| `sphere.payments.send(request)` | `Promise<TransferResult>` | Send L3 tokens (engine-only path) |
| `sphere.payments.receive(options?)` | `Promise<ReceiveResult>` | One-shot fetch of pending transfers (options deprecated no-ops) |
| `sphere.payments.mintFungibleToken(coinIdHex, amount)` | `{ success, token?, tokenId?, error? }` | Self-mint via engine (no faucet) |
| `sphere.payments.sync()` | `{ added, removed }` | Sync with remote storage |
| `sphere.payments.validate()` | `{ valid, invalid }` | Verify tokens (engine for v2 blobs, legacy RPC for v1 TXF) |
| `sphere.payments.getHistory()` | `TransactionHistoryEntry[]` | Transaction history |
| `sphere.payments.l1.getBalance()` | `L1Balance` | L1 balance (strings in sats) |
| `sphere.payments.l1.send(request)` | `L1SendResult` | Send L1 transaction |
| `sphere.payments.l1.getHistory(limit?)` | `L1Transaction[]` | L1 tx history |
| `sphere.resolve(identifier)` | `PeerInfo \| null` | Resolve @nametag/address/pubkey |
| `sphere.communications.resolvePeerNametag(pubkey)` | `string \| undefined` | Resolve peer Unicity ID via transport |
| `sphere.registerNametag(name)` | `void` | Register Unicity ID (Nostr binding + best-effort v2 token mint) |
| `sphere.signMessage(message)` | `string` | Sign with wallet key (secp256k1 ECDSA) |
| `sphere.switchToAddress(index, options?)` | `void` | Switch HD address |
| `sphere.getActiveAddresses()` | `TrackedAddress[]` | Non-hidden tracked addresses |
| `sphere.on(event, handler)` | `() => void` (unsubscribe) | Subscribe to events |
| `sphere.accounting.createInvoice(request)` | `CreateInvoiceResult` | Mint a v2 invoice data token (`token` = hex blob string) |
| `sphere.accounting.importInvoice(tokenBlobHex)` | `InvoiceTerms` | Import a received v2 invoice blob (v1 TXF rejected) |
| `sphere.accounting.getInvoiceStatus(invoiceId)` | `InvoiceStatus` | Full status with per-target balances |
| `sphere.accounting.payInvoice(invoiceId, params)` | `TransferResult` | Send payment referencing an invoice |
| `sphere.accounting.closeInvoice(invoiceId, options?)` | `void` | Explicitly close (terminal state) |
| `sphere.accounting.cancelInvoice(invoiceId, options?)` | `void` | Cancel and optionally auto-return |
| `sphere.swap.proposeSwap(deal, options?)` | `SwapProposalResult` | Propose a token swap |
| `sphere.swap.acceptSwap(swapId)` | `void` | Accept a swap proposal |
| `sphere.swap.deposit(swapId)` | `TransferResult` | Deposit into a swap |
| `sphere.swap.getSwaps(filter?)` | `SwapRef[]` | List swaps with filter |

Note: `sphere.accounting`, `sphere.swap`, `sphere.groupChat`, `sphere.market` are
nullable getters — `null` unless the module was enabled in init options.

### Key Events

| Event | Payload | When |
|-------|---------|------|
| `transfer:incoming` | `IncomingTransfer` (`{ senderPubkey, senderNametag?, tokens, receivedAt }`) | Received tokens via Nostr |
| `transfer:confirmed` | `TransferResult` | Outgoing transfer confirmed |
| `transfer:failed` | `TransferResult` | Outgoing transfer failed |
| `identity:changed` | `{ l1Address, directAddress?, chainPubkey, nametag?, addressIndex }` | Address switch |
| `nametag:registered` | `{ nametag, addressIndex }` | Unicity ID registered |
| `nametag:recovered` | `{ nametag }` | Unicity ID recovered from Nostr on import |
| `address:activated` | `{ address: TrackedAddress }` | New address tracked |
| `sync:provider` | `{ providerId, success, added?, removed?, error? }` | Per-provider sync result |
| `payment_request:incoming` | `IncomingPaymentRequest` | Received payment request |
| `invoice:created` | `{ invoiceId, confirmed }` | Invoice token minted or imported |
| `invoice:payment` | `{ invoiceId, transfer, paymentDirection, confirmed }` | Payment attributed to invoice |
| `invoice:covered` | `{ invoiceId, confirmed }` | All targets fully covered |
| `invoice:closed` | `{ invoiceId, explicit }` | Invoice moved to CLOSED |
| `invoice:cancelled` | `{ invoiceId }` | Invoice moved to CANCELLED |
| `swap:proposal_received` | `{ swapId, deal, senderPubkey, senderNametag? }` | Incoming swap proposal |
| `swap:accepted` | `{ swapId, role }` | Swap accepted |
| `swap:deposit_confirmed` | `{ swapId, party, amount, coinId }` | Deposit confirmed by escrow |
| `swap:completed` | `{ swapId, payoutVerified }` | Swap completed (terminal) |
| `swap:cancelled` | `{ swapId, reason, depositsReturned? }` | Swap cancelled (terminal) |

See [QUICKSTART-BROWSER.md](docs/QUICKSTART-BROWSER.md) and [QUICKSTART-NODEJS.md](docs/QUICKSTART-NODEJS.md) for detailed guides.

---

## Project Overview

**Sphere SDK** (`@unicitylabs/sphere-sdk`) is a modular TypeScript SDK for Unicity wallet operations supporting:
- **L1 (ALPHA blockchain)** - UTXO-based blockchain transactions via Electrum (Fulcrum)
- **L3 (Unicity state transition network)** - Token transfers via the **v2 state-transition SDK**, consumed exclusively through the `token-engine/` port

**Version:** 0.8.0-dev.6 (post v1-cutover; see CHANGELOG `[Unreleased]`)
**License:** MIT
**Target:** Node.js >= 22.0.0, Browser (ESM/CJS)
**CLI:** moved out to `@unicity-sphere/cli` (`npm run cli` only prints a pointer)

## Directory Structure

```
sphere-sdk/
├── core/                    # Core wallet and crypto utilities
│   ├── Sphere.ts           # Main wallet class (~165KB) - entry point
│   ├── address.ts          # DIRECT:// address parsing/validation
│   ├── crypto.ts           # BIP39/BIP32, secp256k1, hashing, message signing
│   ├── bech32.ts           # Address encoding/decoding
│   ├── encryption.ts       # AES/Argon2+ChaCha20 encryption utilities
│   ├── errors.ts           # SphereError + SphereErrorCode
│   ├── logger.ts           # Centralized logger singleton
│   ├── currency.ts         # Amount formatting/conversion
│   ├── scan.ts / discover.ts # HD address scanning/discovery
│   ├── network-health.ts   # checkNetworkHealth()
│   └── utils.ts            # Base58, patterns, UUID, helpers
│
├── token-engine/            # ⭐ Anti-corruption layer over the v2 state-transition SDK
│   ├── engine.ts           # ITokenEngine port (frozen contract) + EngineConfig
│   ├── types.ts            # Sphere-domain types: SphereToken, TokenBlob, Mint/Transfer/SplitParams
│   ├── factory.ts          # createSphereTokenEngine(config)
│   ├── SphereTokenEngine.ts # The real adapter (engine implementation)
│   ├── SpherePaymentData.ts # Value envelope codec (coins inside v2 tokens)
│   ├── token-blob.ts       # TokenBlob CBOR encode/decode
│   ├── identity.ts         # deriveDirectAddress() — vendored v1-identical DIRECT:// derivation
│   ├── unicity-id.ts       # createUnicityIdMinter() — self-issued v2 UnicityIdToken mint
│   ├── network.ts          # SphereNetwork ↔ SDK NetworkId mapping
│   └── sdk.ts              # ⚠️ THE ONLY file allowed to import @unicitylabs/state-transition-sdk
│
├── types/                   # TypeScript type definitions
│   ├── index.ts            # Main types (Identity, Token, Transfer, events, etc.)
│   ├── txf.ts              # Token eXchange Format types (legacy v1 storage) + NametagData
│   └── v2-transfer.ts      # V2TransferPayload — the only supported transfer wire format
│
├── modules/                 # Feature modules
│   ├── payments/
│   │   ├── PaymentsModule.ts      # L3 token operations (~139KB)
│   │   ├── L1PaymentsModule.ts    # ALPHA blockchain operations
│   │   ├── SpendQueue.ts          # Concurrent-send queueing (waits for change tokens)
│   │   ├── TokenSplitCalculator.ts # Split planning
│   │   └── TokenReservationLedger.ts # Token reservations for concurrent sends
│   ├── accounting/
│   │   ├── AccountingModule.ts    # Invoice lifecycle and payment attribution (~268KB)
│   │   ├── types.ts               # InvoiceTerms, InvoiceStatus, etc.
│   │   ├── balance-computer.ts    # Per-target status computation
│   │   ├── auto-return.ts         # Automatic refund management
│   │   ├── memo.ts                # Invoice memo encoding + hashInvoiceId
│   │   └── serialization.ts       # Canonical invoice serialization
│   ├── swap/
│   │   ├── SwapModule.ts          # P2P token swap lifecycle (~169KB)
│   │   ├── dm-protocol.ts         # NIP-17 swap DM message protocol
│   │   ├── escrow-client.ts       # Escrow service interaction
│   │   ├── manifest.ts            # Swap manifest signing/verification
│   │   └── state-machine.ts       # Swap progress transitions
│   ├── groupchat/                 # NIP-29 group chat (relay-based)
│   ├── market/                    # Market intents
│   └── communications/            # DMs and broadcasts
│
├── transport/               # P2P messaging abstraction (NostrTransportProvider)
├── storage/                 # Data persistence abstraction
├── oracle/                  # Network-config provider for the token engine
│   ├── oracle-provider.ts         # OracleProvider interface
│   └── UnicityAggregatorProvider.ts # Default implementation
├── price/                   # Token market prices (CoinGeckoPriceProvider)
├── registry/                # Token metadata registry (remote fetch + cache singleton)
├── validation/              # TokenValidator
├── serialization/           # TXF + legacy wallet file parsing (.txt / .dat)
├── connect/                 # Sphere Connect protocol (client/, host/, protocol, permissions)
├── l1/                      # ALPHA blockchain utilities (address, tx, vesting, ...)
├── assets/                  # Embedded trust bases per network (trustbase.ts)
│
├── impl/                    # Platform-specific implementations
│   ├── browser/            # IndexedDB storage, browser oracle/transport/IPFS, connect
│   ├── nodejs/             # FileStorage, Node oracle/transport/IPFS, connect
│   └── shared/             # Config resolvers, network consistency checks, trust-base loaders, IPFS
│
├── tests/                   # Test suite (Vitest): unit/, integration/, e2e/, relay/, fixtures/
├── docs/                    # Documentation (CONNECT.md, QUICKSTART-*, ACCOUNTING-*, SWAP-*, ...)
├── index.ts                 # Main SDK entry point
├── constants.ts             # Global constants, NETWORKS, storage keys
└── package.json
```

## Architecture

### Token Engine (v2) — the only L3 money path

The legacy v1 `@unicitylabs/state-transition-sdk@1.6.1-rc` engine is **removed**.
The canonical package name resolves to the **v2 SDK, pinned `2.0.0-rc.6027e82`**.

- The SDK is imported in exactly ONE file: `token-engine/sdk.ts`. An ESLint
  `no-restricted-imports` rule blocks any other import of
  `@unicitylabs/state-transition-sdk` — everything else codes against the
  `ITokenEngine` port and sphere-domain types from `token-engine/`.
- `ITokenEngine` operations: `getIdentity`, `deriveIdentityAddress`, `tokenId`,
  `readValue`, `balanceOf`, `readMemo`, `readTokenData`, `mint`, `mintDataToken`,
  `transfer`, `split`, `verify`, `isSpent`, `isOwnedBy`, `encodeToken`, `decodeToken`.
- `Sphere` builds the engine from the oracle's config surface
  (`getTrustBaseJson()` / `getAggregatorUrl()` / `getApiKey()`) via
  `createSphereTokenEngine(EngineConfig)`. The trust base JSON is the single
  source of truth for the network id (`RootTrustBase.networkId`, e.g. testnet2 = 4).
- `SphereToken.sdkToken` is an OPAQUE handle — callers store it and hand it back
  to the engine, never call methods on it.
- **The engine is mandatory for money movement**: `send()`, `mintFungibleToken()`,
  `accounting.createInvoice()/importInvoice()` fail loudly (`AGGREGATOR_ERROR` /
  invoice errors) when the oracle does not supply a v2 trust base + gateway URL.

### Single Identity Model
L1 and L3 share the same secp256k1 key pair:

```
mnemonic → master key → BIP32 derivation → identity
                                              ↓
                        ┌─────────────────────┴─────────────────────┐
                        │  chainPubkey:   33-byte compressed pubkey │
                        │  l1Address:     alpha1... (bech32)        │
                        │  directAddress: DIRECT://... (L3)         │
                        │  transportPubkey: derived for Nostr       │
                        └─────────────────────────────────────────────┘
```

The `DIRECT://` address is derived by `token-engine/identity.ts`
(`deriveDirectAddress`) — a vendored, byte-identical reproduction of the v1
derivation. It MUST stay stable: external systems (Quest XP) key user identity
on it.

### Key Types

```typescript
interface Identity {
  chainPubkey: string;      // 33-byte compressed secp256k1 (for L3)
  l1Address: string;        // L1 bech32 address (alpha1...)
  directAddress?: string;   // L3 DIRECT address
  ipnsName?: string;        // IPFS/IPNS identifier
  nametag?: string;         // Unicity ID (@username)
}

interface FullIdentity extends Identity {
  privateKey: string;       // secp256k1 private key (hex)
}

interface TransferRequest {
  recipient: string;        // @nametag, DIRECT://..., chain pubkey, alpha1...
  amount: string;           // Amount in smallest unit
  coinId: string;           // Coin ID (64-hex canonical; short symbols resolved via registry)
  memo?: string;            // Optional message
  // addressMode / transferMode still exist on the type but are IGNORED —
  // there is a single engine send path (no PROXY, no instant/conservative branches).
}

interface TransferResult {
  readonly id: string;
  status: 'pending' | 'submitted' | 'confirmed' | 'delivered' | 'completed' | 'failed';
  readonly tokens: Token[];
  readonly tokenTransfers: TokenTransferDetail[];
  error?: string;
}

// token-engine sphere-domain types
interface TokenBlob {
  v: number;        // blob format version (sphere storage migrations)
  network: number;  // NetworkId.id
  tokenId: string;  // genesis-stable 64-hex id (same across all states)
  token: Uint8Array; // CBOR of the v2 Token
}

interface SphereToken {
  sdkToken: Token;          // OPAQUE v2 SDK handle — never touch outside token-engine/
  blob: TokenBlob;          // serializable form
  value: SphereValue | null; // decoded { assets: [{ coinId, amount: bigint }] }
}
```

### Provider Pattern
Abstract interfaces for platform independence:

| Provider | Interface | Implementations |
|----------|-----------|-----------------|
| Storage | `StorageProvider` | IndexedDBStorageProvider (browser), FileStorageProvider (Node.js) |
| TokenStorage | `TokenStorageProvider` | IndexedDBTokenStorageProvider, FileTokenStorageProvider, IpfsStorageProvider |
| Transport | `TransportProvider` | NostrTransportProvider |
| Oracle | `OracleProvider` | UnicityAggregatorProvider |
| Price | `PriceProvider` | CoinGeckoPriceProvider |

**Oracle is a thin network-config provider** (post v1-cutover). Its surface:
- `initialize(trustBaseJson?)` — loads trust base via the platform loader unless passed explicitly
- `getTrustBaseJson()` / `getAggregatorUrl()` / `getApiKey()` — REQUIRED members; the v2 engine is built from exactly these three
- `validateToken(tokenData)` — best-effort legacy JSON-RPC check for v1 TXF tokens only (display path); v2 blobs are verified via the engine

Custom `OracleProvider` implementations MUST provide the three config accessors.

### Network Configuration (`constants.ts` → `NETWORKS`)

| Network | Aggregator/Gateway | Status |
|---------|--------------------|--------|
| `testnet` | `https://gateway.testnet2.unicity.network` | ⭐ **Alias of testnet2** (v2 gateway, trust-base networkId 4, testnet2 token registry) |
| `testnet2` | `https://gateway.testnet2.unicity.network` | Same config as `testnet` |
| `mainnet` | `aggregator.unicity.network/rpc` | v1-era; **no embedded trust base** — provider factories refuse it (`INVALID_CONFIG`) |
| `dev` | `dev-aggregator.dyndns.org/rpc` | v1-era aggregator — wallet operations fail loudly (`AGGREGATOR_ERROR`) until cut over |

All networks share Nostr relays (`nostr-relay.testnet.unicity.network` for test
nets), IPFS gateways, Fulcrum electrum and group relays per `NETWORKS`.
`assertNetworkConsistency()` (impl/shared/network.ts) refuses provably-broken
networks at provider creation (null or networkId-mismatched trust base).

**API key:** there is NO bundled default. Consumers inject `oracle.apiKey`
(plumbed through `createBrowserProviders`/`createNodeProviders` →
`UnicityAggregatorProvider` → engine). The testnet2 key is non-secret and
pre-filled in `.env.example`; a mainnet key is a secret.

## Common Commands

```bash
# Build (ESM + CJS via tsup, multiple entry points)
npm run build

# Test (watch mode)
npm test

# Test (single run)
npm run test:run

# E2E tests (live testnet2; needs .env with TESTNET2_API_KEY — see .env.example)
npm run test:e2e

# Relay integration tests (Docker testcontainers, or RELAY_URL=...)
npm run test:relay

# Lint
npm run lint

# Type check
npm run typecheck
```

⚠️ **Windows note:** the tsup DTS build is known to segfault on Windows +
Node 22.x. This is a local toolchain trap, NOT a real break — CI (Linux) is
authoritative for build success.

## Key Concepts

### v1 → v2 Cutover (what changed)
- **Removed:** `payments.sendInstant()`, `payments.resolveUnconfirmed()`,
  instant-split/payment-session wire types (`types/instant-split`,
  `types/payment-session`), `NametagMinter`, `TokenSplitExecutor`, oracle
  commitment/proof/mint methods (`submitCommitment`, `getProof`, `waitForProof`,
  `isSpent`, `getTokenState`, `getCurrentRound`, `mint`, SDK client accessors).
- **Wire format:** the only supported transfer payload is `V2_TRANSFER`
  (`{ type: 'V2_TRANSFER', version: '2.0', tokenBlob, memo? }` — a FINISHED v2
  token blob, hex of CBOR(TokenBlob)). Incoming v1 payloads (V5/V6
  instant-split, NOSTR-FIRST, `{sourceToken, transferTx}`, plain token JSON) are
  dropped with an explicit error log — peers must run a >=0.8 wallet.
- **Stored v1 TXF tokens** stay visible (parsed as JSON for display) but are
  unspendable; orphaned pending-V5 tokens are terminalized to `invalid` on load.

### Send Pipeline (v2, money-safety)
- `send()` requires the token engine AND a recipient with a published chain
  pubkey (`INVALID_RECIPIENT` otherwise). Transfers lock to
  `SignaturePredicate(recipient chainPubkey)`.
- Spend planning goes through `SpendQueue` + `TokenReservationLedger`
  (synchronous critical section; concurrent sends queue for change tokens
  instead of failing).
- The engine `transfer`/`split` produces a FINISHED token for the recipient.
  The moment it is certified on-chain (source already spent), the blob is
  journaled in `PENDING_V2_DELIVERIES` storage and only removed after
  successful transport delivery — `load()` replays undelivered blobs, so a
  crash or transport failure never loses the recipient's token.
- **Failure restore semantics:** source tokens whose spend was certified
  on-chain during a failed send become terminal `'spent'` — never restored to
  `'confirmed'`. Tokens stuck `'transferring'` after a crash are reconciled
  against the network on `load()`.

### Receive & Verification (v2)
- v2 transfers arrive as finished tokens: decode + verify + store, no
  commitment/proof/finalization round-trip. `receive()` is a one-shot fetch;
  its old finalization options are deprecated no-ops.
- **Incoming transfers are verified before entering the balance:**
  `engine.verify` (full trust-base proof check) + `engine.isOwnedBy(token,
  own chainPubkey)` — tokens that fail verification or are not addressed to
  this wallet are rejected (warn log). Dedup by genesis-stable tokenId.
- `validate()` checks v2 blob tokens via the engine (`verify` + `isSpent`);
  legacy v1 TXF tokens fall back to the oracle's `validateToken` RPC.
  Transient engine failures skip the token (never invalidate funds on an outage).

### Minting
- `payments.mintFungibleToken(coinIdHex, amount: bigint)` = **engine self-mint**
  (v2 standalone mint to the wallet's own pubkey, no faucet, no commitment
  round-trip). Lets a fresh wallet top up on testnet2.
- `engine.mintDataToken` mints NON-value (data) tokens — used for invoices.

### Unicity IDs (nametags)
- Human-readable aliases (e.g., `@alice`) for receiving payments.
- **Registration = publishing the Nostr identity binding** (name ↔ chainPubkey,
  first-seen-wins is the global uniqueness guard). Runtime name resolution is
  Nostr-binding-only; receive is always `SignaturePredicate(chainPubkey)`;
  there is **no PROXY addressing anywhere**.
- `registerNametag()` ALSO best-effort mints + stores a **self-issued v2
  `UnicityIdToken`** (`token-engine/unicity-id.ts`, `createUnicityIdMinter`),
  saved as `NametagData { format: 'v2-cbor', token: <CBOR hex string> }`. The
  mint is deterministic per (name, wallet key) → idempotent re-mint recovers a
  lost token; a gateway outage never fails registration (retried on next load).
  The stored token is unused at runtime (kept for a future issuer/verification
  model). `NametagMinter` / `mintNametag` DO NOT EXIST anymore.
- Recovered from Nostr when importing a wallet; each HD address can have its own.

### Accounting / Invoicing
- **Invoice IS a v2 data token** minted via `engine.mintDataToken` (terms in the
  token's data, deterministic salt → stable terms-derived tokenId).
- `CreateInvoiceResult.token` is the transmittable **hex blob string**;
  `importInvoice` takes that hex string (legacy v1 TXF invoices are rejected
  with an explicit error). No trust-base dependency in
  `AccountingModuleDependencies` — the engine owns trust.
- State machine: `OPEN -> PARTIAL -> COVERED -> CLOSED` (or `CANCELLED`,
  `EXPIRED`). Terminal states freeze balances.
- Privacy: on-chain memos embed `SHA-256(invoiceId)`; recipients verify by
  re-hashing (legacy raw-ID memos still resolve via `resolveInvoiceRef()`).
- Auto-return refunds payments to closed/cancelled invoices with a dedup ledger.

### Token Swaps
- `SwapModule` (`sphere.swap`) orchestrates P2P swaps via an escrow service.
- Protocol v2: signed manifests with Unicity-ID binding proofs; all messages via
  NIP-17 encrypted DMs; deposits are payments of escrow-created invoices;
  payout verified locally via `verifyPayout()`.
- State machine: `proposed -> accepted -> announced -> depositing -> concluding
  -> completed` (or `cancelled`/`failed`).

### L1 Payments (Enabled by Default)
- L1 module (`sphere.payments.l1`) is created automatically; Fulcrum WebSocket
  connection is **lazy** — deferred until first L1 operation.
- Set `l1: null` in init options to disable L1 entirely.
- **Vesting cache:** IndexedDB (`SphereVestingCacheV5`) in browser; memory-only in Node.js.

### Peer Resolution
- `sphere.resolve(identifier)` — unified lookup via transport.
- Accepts: `@nametag`, `DIRECT://...`, `alpha1...`, chain pubkey (`02`/`03`),
  transport pubkey (64-hex). Returns `PeerInfo` or `null`.
- Identity binding event published on init/load — wallet discoverable without a Unicity ID.

### Token Registry (Remote + Cached)
- `TokenRegistry` singleton provides token metadata (symbol, name, decimals,
  icons) by coin ID. No bundled data — remote URL per network
  (`NETWORKS[network].tokenRegistryUrl`; testnet/testnet2 use
  `unicity-ids.testnet2.json`) + persistent cache.
- `TokenRegistry.waitForReady()` gates token parsing in `PaymentsModule.load()`.
- Configured both by provider factories and by `Sphere` itself (tsup bundles
  duplicate the singleton per entry point — both bundle contexts need `configure()`).

### Network-Scoped Storage
- Token/payment operational state (pending transfers, outbox, history,
  invoice/swap ledgers, …) is **per-address AND per-network**
  (`isNetworkScopedAddressKey` in constants.ts) — a testnet2 auto-return ledger
  can never fire a send on another network. Chat/identity keys stay
  network-agnostic. Storage providers take a `network` parameter.
- `PENDING_V2_DELIVERIES` (per-address, network-scoped) journals
  finished-but-undelivered transfer blobs (see Send Pipeline).

### IndexedDB Databases (Browser)

| Database | Provider | Purpose |
|----------|----------|---------|
| `sphere-storage` | `IndexedDBStorageProvider` | Wallet keys, per-address data |
| `sphere-token-storage-*` | `IndexedDBTokenStorageProvider` | Token data per address |
| `SphereVestingCacheV5` | `VestingClassifier` | L1 UTXO→coinbase tracing cache |

`Sphere.clear({ storage, tokenStorage })` deletes all of them.

## Testing

**Framework:** Vitest
**Test files:** 170 (`tests/unit/`, `tests/integration/`, `tests/e2e/`, `tests/relay/`)
**Run:** `npm run test:run` (unit/integration), `npm run test:e2e` (live testnet2, needs `.env`), `npm run test:relay`

Key test areas:
- `tests/unit/token-engine/` — engine contract, factory, FakeTokenEngine,
  identity golden test (`identity.test.ts` locks the DIRECT:// derivation),
  `wallet-address-invariant.test.ts`, `unicity-id-mint.test.ts`, token-blob codec
- `tests/unit/modules/PaymentsModule*.test.ts` — send/receive/mint/validate,
  V2_TRANSFER wire format, delivery journal, spend queue
- `tests/unit/modules/AccountingModule.*.test.ts` — invoice lifecycle, status, auto-return, receipts
- `tests/unit/modules/SwapModule.*.test.ts` — swap lifecycle, deposits, payouts, cancellation
- `tests/unit/core/` — Sphere lifecycle, nametag sync/recovery, clear
- `tests/e2e/token-engine.testnet2.e2e.test.ts`, `payments-v2.testnet2.e2e.test.ts`
  — live testnet2 (skipped unless `TESTNET2_API_KEY` is set)
- `tests/relay/groupchat-relay.test.ts` — NIP-29 relay integration (Docker + remote)

## Dependencies

**Core (from package.json):**
- `@unicitylabs/state-transition-sdk` — **pinned `2.0.0-rc.6027e82`** (v2 engine; imported only via `token-engine/sdk.ts`)
- `@unicitylabs/nostr-js-sdk` `^0.5.0` — Nostr protocol
- `@noble/hashes` `^2`, `@noble/curves` `^2` — cryptography
- `bip39`, `elliptic`, `crypto-js`, `canonicalize`, `buffer`

**Optional/peer (IPFS + Node WebSocket):**
- `@libp2p/crypto`, `@libp2p/peer-id`, `ipns`, `multiformats` — IPNS support
- `ws` — Node.js WebSocket (peer, optional)

## File Size Reference

Largest files (for context):
- `modules/accounting/AccountingModule.ts` — ~268KB (invoice lifecycle)
- `modules/swap/SwapModule.ts` — ~169KB (swap lifecycle)
- `core/Sphere.ts` — ~165KB (wallet lifecycle)
- `modules/payments/PaymentsModule.ts` — ~139KB (payment logic)

## Code Style

- TypeScript strict mode
- ESLint with TypeScript rules (+ the token-engine SDK import boundary)
- ESM modules (with CJS build output)
- Prefer `interface` over `type` for objects
- Use `readonly` for immutable properties
- Async/await over raw promises
