# Sphere SDK

A modular TypeScript SDK for Unicity wallet operations (Unicity state transition network).

## Features

- **Wallet Management** - BIP39/BIP32 key derivation; optional password encryption of the stored seed (see [Wallet Security & Encryption](#wallet-security--encryption))
- **Payments** - Engine-certified token transfers over the **wallet-api vertical** (durable server-side intents, mailbox delivery, crash-safe resume under the same transferId); server custody — the backend holds inventory, keys stay local
- **Payment Requests** - Request payments over the wallet-api rail with encrypted memos and durable settling
- **Market (Intents)** - Signed intent bulletin board with semantic search and live feed
- **Group Chat** - NIP-29 relay-based group messaging with moderation
- **Messaging (Nostr)** - NIP-17 DMs + NIP-29 group chat and nametag publishing — **messaging only; not the payment rail**
- **Multi-Address** - HD address derivation (BIP32/BIP44)
- **Connect Protocol** - dApp ↔ wallet communication via `ConnectClient` / `ConnectHost` (hosted wallet in an iframe, or WebSocket for Node.js dApps)

## Installation

```bash
npm install @unicitylabs/sphere-sdk        # browser
npm install @unicitylabs/sphere-sdk ws     # Node.js: ws is required, see "Node.js Providers"
```

## Quick Start Guides

Choose your platform:

| Platform | Guide | Required | Notes |
|----------|-------|----------|-------|
| **Browser** | [QUICKSTART-BROWSER.md](docs/QUICKSTART-BROWSER.md) | SDK only | Default storage: IndexedDB. TypeScript: `./impl/browser` ships no type declarations yet (see [the shim](#typescript-declarations-for-implbrowser)) |
| **Node.js** | [QUICKSTART-NODEJS.md](docs/QUICKSTART-NODEJS.md) | SDK + `ws`, Node.js >= 22 | Default storage: a wallet file under `./sphere-data` |
| **CLI** | [unicity-sphere/sphere-cli](https://github.com/unicity-sphere/sphere-cli) | Separate repository | Not published to npm yet |
| **dApp integration** | [CONNECT.md](docs/CONNECT.md) | SDK only | `ws` (Node.js dApps) |

## CLI (Command Line Interface)

The Sphere CLI lives in its own repository, [unicity-sphere/sphere-cli](https://github.com/unicity-sphere/sphere-cli),
and is not published to npm yet: `npm install -g @unicity-sphere/cli` fails with a 404. Its `package.json`
depends on this SDK through a local path (`file:../../sphere-sdk`), so it builds only next to a checkout of
this repository. See [docs/QUICKSTART-CLI.md](docs/QUICKSTART-CLI.md).

## Quick Start

> **Setup is two provider layers, not one.** `createBrowserProviders` / `createNodeProviders`
> build only the **base** (storage + transport + oracle). You **must** then attach the wallet-api
> transport config with `createWalletApiProviders` — money moves only through the wallet-api
> vertical. Skipping it fails loudly: `Sphere.init` throws `INVALID_CONFIG`.

```typescript
import { Sphere, TokenRegistry, getCoinIdBySymbol, randomUUID } from '@unicitylabs/sphere-sdk';
import { createBrowserProviders } from '@unicitylabs/sphere-sdk/impl/browser'; // untyped entry: add the declaration shim below
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';

// One network literal, used in all three places below.
const NETWORK = 'testnet2';

// A per-device id: stable across launches on this device, different on every device.
function deviceId(): string {
  let id = localStorage.getItem('sphere-device-id');
  if (!id) {
    // The SDK's randomUUID(): unlike crypto.randomUUID(), it also works outside a secure context.
    id = randomUUID();
    localStorage.setItem('sphere-device-id', id);
  }
  return id;
}

// 1. Base providers: storage (IndexedDB) + transport (Nostr) + oracle (gateway).
//    `network` is required here: createBrowserProviders throws INVALID_CONFIG without it.
const base = createBrowserProviders({
  network: NETWORK,
  oracle: { apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590' }, // public testnet2 gateway key
});

// 2. The wallet-api transport config that the payments vertical is composed from.
//    Returns { ...base, walletApi }; walletApi is a plain config object.
const providers = createWalletApiProviders(base, {
  baseUrl: 'https://wallet-api.unicity.network', // testnet2 wallet-api
  network: NETWORK,
  deviceId: deviceId(),
});

// 3. Load the wallet in this storage, or create one. `network` is required here too.
const { sphere, created, generatedMnemonic } = await Sphere.init({
  ...providers,
  network: NETWORK,
  autoGenerate: true,
});
if (created && generatedMnemonic) {
  console.log('SAVE THIS RECOVERY PHRASE:', generatedMnemonic);
}

// 4. Send: engine-driven, certified on-chain. The recipient needs a published identity
//    (chain pubkey), e.g. a registered Unicity ID; otherwise send fails with INVALID_RECIPIENT.
//    coinId is the 64-hex coin id; getCoinIdBySymbol() returns it for a symbol.
await TokenRegistry.waitForReady(); // Sphere.init starts the registry load but does not await it
const coinId = getCoinIdBySymbol('UCT'); // string | undefined
if (!coinId) throw new Error('UCT is not in this network\'s token registry');

const result = await sphere.payments.send({
  recipient: '@alice',
  amount: '1000000',     // base units, as a decimal STRING (never a JS number)
  coinId,
  memo: 'hello',
});
console.log(result.status);   // 'delivered', or 'confirmed' with result.deliveryPending === true
// A resolved send() means sent. deliveryPending === true is NORMAL, not a failure: the token is
// certified on-chain and the mailbox delivery is retried automatically (see "Send result" below).

// 5. Receive: incoming transfers land automatically while the wallet runs (mailbox drain +
//    wake socket). To drain explicitly (e.g. a CLI/batch app), call receive():
const { transfers } = await sphere.payments.receive();
sphere.on('transfer:incoming', (t) => console.log('received from', t.senderNametag ?? t.senderPubkey));

console.log(await sphere.payments.assets());
```

`generatedMnemonic` is returned only by the `Sphere.init` call that created the wallet. The phrase is
stored before the rest of the setup runs, so if that call then throws (for example, a requested
`nametag` is already taken), the next `Sphere.init` loads the stored wallet with `created: false`.
Gate your backup prompt on your own "backup confirmed" flag and read the phrase with
`sphere.getMnemonic()` until the user confirms.

Nametag bindings do not carry a network yet, so the SDK cannot prove that a `@nametag` or `DIRECT://`
recipient uses your network. Every such send emits `transfer:attention` with
`code: 'recipient:network-unverified'` and an empty `transferId`, and then proceeds on your network.
Treat it as information, not an error; on mainnet, make sure the recipient runs mainnet. A bare 66-hex
chain pubkey recipient is taken as being on your network.

### What just happened (the provider model)

A wallet is composed from **swappable ports**, layered in two steps:

| Layer | Built by | What it supplies |
|-------|----------|-------------------|
| **Base** | `createBrowserProviders` / `createNodeProviders` | `storage` (keys/identity/journals), `transport` (Nostr — **messaging/nametags only**), `oracle` (gateway/trust base) |
| **wallet-api transport** | `createWalletApiProviders(base, …)` | `walletApi` — the transport CONFIG (`{ network, baseUrl, deviceId?, fetchFn?, webSocketFactory?, paymentsV2Transport? }`) the payments vertical is composed from |

- **The rail is wallet-api, not Nostr.** Transfers are certified on-chain by the token engine and the finished token is deposited into the recipient's **wallet-api mailbox**. Nostr carries messaging/nametags — **it does not move payments.**
- **Custody is server-side.** The wallet-api backend holds your token inventory; your keys never leave the client. (Own-storage custody was rescinded — there is no local token store.)
- **The money ports are contract-enforced.** `StoragePort`/`DeliveryPort` (`modules/payments-v2/ports.ts`) have wallet-api implementations; the `paymentsV2Transport` seam in the `walletApi` config lets tests/custom hosts inject a whole replacement bundle.
- **`network` placement.** Required on `createBrowserProviders`/`createNodeProviders`, in the `walletApi` config, AND on `Sphere.init`; use one literal, `'testnet2'`, in all three places. Neither provider factory returns a `network` field, so `...providers` cannot supply it. `Sphere.init` compares its own `network` with `walletApi.network` as plain strings and throws `INVALID_CONFIG` ("walletApi.network "testnet2" does not match the Sphere network ...") when they differ, including when `Sphere.init` gets no `network` at all; this happens before any storage write. `'testnet'` and `'testnet2'` reach the same endpoints but are different strings, so mixing them fails this check. The wallet-api deployment names its network too: the testnet2 deployment signs you in only as `'testnet2'`, and the SDK refuses a sign-in challenge for any other network. The base-provider literal is not compared by that check, but it scopes the storage keys, while the payments state is keyed by the `Sphere.init` network, so mixing the two literals splits one wallet's state across two names.
- **Messaging-only wallets say so out loud.** A wallet that never touches money — a Nostr DM or group-chat bot — passes `walletApi: 'none'` instead of a config: no wallet-api session, device registration, mailbox drain, token engine or `pv2g2:` key. `network` is still required, because it selects the token registry and the group-chat relays. `sphere.payments` then throws `PAYMENTS_NOT_COMPOSED` and `sphere.hasPayments` is `false`. **Omitting `walletApi` altogether still throws `INVALID_CONFIG`** — a dropped env var must never read as a deliberate choice.

For manual/advanced provider wiring, see [Custom Providers Configuration](#custom-providers-configuration). For the deeper integration guide, see [docs/INTEGRATION.md](docs/INTEGRATION.md).

### Send result (`TransferResult`)

`send()` resolves only when the payment is sent, with a `TransferResult`:

| Field | Meaning |
|-------|---------|
| `status` | `'delivered'` when the payment landed in the recipient's mailbox, or `'confirmed'` when the transfer is certified and delivery is still being retried (`deliveryPending === true`). `send()` never resolves with `'completed'` or `'failed'`: a failure throws. (`'submitted'` and `'failed'` appear only as `transfer:updated` event payloads.) |
| `deliveryPending` | `true` when the spend is **certified on-chain** but the recipient's **mailbox delivery was deferred** (a full inbox / transient outage). **This is success, not failure** — the token is finalized and the finished blob is journaled and re-delivered automatically. |
| `deliveryState` | `'landed'` (delivered) or `'pending-delivery'` (deferred, as above). |

A resolved `send()` is sent, whichever of the two statuses it carries. Use `deliveryPending` only to show a "delivery pending" hint — never as an error. A stale-but-spent source is self-healed (the next live coin is selected automatically).

#### Handling `send()` rejections: never re-send a possibly-committed payment (money-safety)

Some rejections mean the money may already have left the wallet. `isPossiblyCommittedSendOutcome(err)` is `true`
for exactly these codes: `SEND_SYNC_PENDING`, `CERTIFICATION_UNCONFIRMED`, `CHECKPOINT_PERSIST_FAILED`,
`SPLIT_CHECKPOINT_LOST`, `CHECKPOINT_TRUSTBASE_MISMATCH` and `SEND_PARTIALLY_COMPLETED`. Never call `send()` again
for that payment: a new `send()` gets a new transfer id and pays the recipient a second time. The SDK finishes the
original under its own transfer id; show it as pending (`sphere.payments.pendingTransfers()`), and wire any
"retry" button to `sphere.payments.resumeNow()`. A `PartialSendConflictError` means part of the amount was
delivered and is final; only `err.remainingAmount` is still owed. When `isPossiblyCommittedSendOutcome(err)` is
`false`, the SDK's contract is that nothing left the wallet.

- `CERTIFICATION_UNCONFIRMED` is a **`ProofUnconfirmedError`** (`mayHaveCertified: true`): the spend may already be on-chain but the proof fetch was inconclusive. `SEND_SYNC_PENDING` can mean the spend committed on-chain and the wallet-api mirror is still catching up.
- **Recovery is automatic.** The open intent is replayed under the same `transferId` (recovers the proof + delivery, or records the spend if a rival tx won; **never a second spend**): partially-committed outcomes converge in-process, and every remaining open intent is resumed when the vertical starts (`Sphere.init` / `Sphere.load` / an address switch). `sphere.payments.resumeNow()` runs that convergence now; it is the only retry verb.
- Clean failures you can branch on: `SEND_INSUFFICIENT_BALANCE` (when funds are pinned by transfers still converging, its message says how much and points to `pendingTransfers()`), `INVALID_RECIPIENT`, `TRANSPORT_ERROR` (the recipient lookup could not reach the relay) and `VALIDATION_ERROR` (a bad amount). `INSUFFICIENT_BALANCE` is never thrown.
- Import the error helpers from the same entry point as `Sphere`, and read `code` structurally for the clean failures: errors thrown by provider code (the `./impl/*` bundles, for example the Nostr transport during the recipient lookup) are a different `SphereError` class copy, so `isSphereError()` is `false` for them.

```ts
// Import the error helpers from the same entry point as Sphere (here: the package root).
import { PartialSendConflictError, isPossiblyCommittedSendOutcome } from '@unicitylabs/sphere-sdk';

try {
  const result = await sphere.payments.send({ recipient: '@alice', amount: '1000000', coinId });
  // Resolved means sent: result.status is 'delivered', or 'confirmed' with deliveryPending === true.
  if (result.deliveryPending) show('Sent. Delivery to the recipient is pending and is retried automatically.');
} catch (err) {
  if (err instanceof PartialSendConflictError) {
    // Part of the amount was delivered and is final. Only err.remainingAmount is still owed:
    // if you pay it, do it as a NEW send of exactly that amount, never the original amount.
    show(`Partly sent: ${err.remainingAmount} base units were not sent.`);
  } else if (isPossiblyCommittedSendOutcome(err)) {
    // The money may already have left the wallet. Never call send() again for this payment:
    // the SDK completes it under the same transferId. Show it as pending.
    show('Sent, waiting for confirmation.');
    const pending = await sphere.payments.pendingTransfers(); // rows for a "pending" list
    // A "retry" button calls sphere.payments.resumeNow(), never send().
  } else {
    // Nothing left the wallet. Read `code` structurally: errors thrown by the providers
    // (e.g. the Nostr transport) are a different SphereError class copy, so isSphereError() is false for them.
    const code = (err as { code?: unknown } | null)?.code;
    switch (code) {
      case 'SEND_INSUFFICIENT_BALANCE': show((err as Error).message); break; // names pinned funds when transfers are converging
      case 'INVALID_RECIPIENT': show('Recipient not found'); break;
      case 'TRANSPORT_ERROR': show('Could not look up the recipient. Check the connection.'); break;
      default: show(err instanceof Error ? err.message : String(err));
    }
  }
}
```

### TypeScript: declarations for `./impl/browser`

`@unicitylabs/sphere-sdk/impl/browser` ships no type declarations in this release; under `strict`
TypeScript add the declaration shim below (or a one-line `declare module '@unicitylabs/sphere-sdk/impl/browser';`,
which types everything from that entry as `any`). Import `createWalletApiProviders` from the typed
`@unicitylabs/sphere-sdk/impl/shared/wallet-api` subpath, as above.

```typescript
// Consumer-side declarations for '@unicitylabs/sphere-sdk/impl/browser'.
// That entry ships no .d.ts (tsup builds it with dts: false), so strict
// TypeScript reports TS7016 on the import without this file. Delete it once
// the package ships declarations for ./impl/browser.
declare module '@unicitylabs/sphere-sdk/impl/browser' {
  import type {
    NetworkType, StorageProvider, TransportProvider, OracleProvider, PriceProvider,
    PricePlatform, GroupChatModuleConfig, MarketModuleConfig,
  } from '@unicitylabs/sphere-sdk';

  export interface BrowserProvidersConfig {
    /** Required: createBrowserProviders throws INVALID_CONFIG without it. */
    network: NetworkType;
    debug?: boolean;
    storage?: { prefix?: string; dbName?: string; debug?: boolean };
    transport?: {
      relays?: string[]; additionalRelays?: string[]; timeout?: number; autoReconnect?: boolean;
      debug?: boolean; reconnectDelay?: number; maxReconnectAttempts?: number;
    };
    oracle?: { url?: string; apiKey?: string; timeout?: number; skipVerification?: boolean; debug?: boolean };
    price?: { platform?: PricePlatform; apiKey?: string; baseUrl?: string; cacheTtlMs?: number; timeout?: number; debug?: boolean };
    groupChat?: { enabled?: boolean; relays?: string[] } | boolean;
    market?: { apiUrl?: string; timeout?: number } | boolean;
  }

  export interface BrowserProviders {
    storage: StorageProvider;
    transport: TransportProvider;
    oracle: OracleProvider;
    price?: PriceProvider;
    groupChat?: GroupChatModuleConfig | boolean;
    market?: MarketModuleConfig | boolean;
  }

  export function createBrowserProviders(config: BrowserProvidersConfig): BrowserProviders;
}
```

The shim declares only `createBrowserProviders`. The other `./impl/browser` exports used later in this
README (`createLocalStorageProvider`, `createNostrTransportProvider`, `createUnicityAggregatorProvider`)
need their own declarations, or the one-line form.

## Migrating off `sphere.paymentsV2`

The deprecated `sphere.paymentsV2` alias and the `paymentsV2: true` init flag are **removed** in
0.15.0. `sphere.payments` is the only accessor, and it is the same facade the alias returned.

One behavioural difference matters: while no vertical is running (init in flight, mid
address-switch, destroyed) the alias returned `null` and `sphere.payments` **throws**
`SphereError` with `code: 'NOT_INITIALIZED'`. Call sites that leaned on the nullish alias —
`sphere.paymentsV2?.tokens()`, `?? fallback`, `if (sphere.paymentsV2)` as a readiness probe —
silently degraded to "no payments" before and now throw, so catch `NOT_INITIALIZED` where you
used to check for null. Code that runs after `await Sphere.init(…)` and before `destroy()` —
everything else in this README — reads `sphere.payments` directly.

A wallet initialised with `walletApi: 'none'` has no payments at all: there `sphere.payments` throws
`PAYMENTS_NOT_COMPOSED`, permanently, instead of the transient `NOT_INITIALIZED`. Use
`sphere.hasPayments` to tell the two cases apart without a try/catch.

The `accounting:` / `swap:` options are **not** part of this cleanup: they still throw a typed
`INVALID_CONFIG`, deliberately, because those modules were removed and a silently ignored option
would hide that.

## Network Configuration

The SDK ships network presets that configure all services automatically. `network` is **required** — there is no default:

| `network` literal | networkId | Gateway (preset) | Nostr relay (preset) | wallet-api `baseUrl` (you pass it) |
|-------------------|-----------|------------------|----------------------|------------------------------------|
| `'testnet2'` | 4 | `https://gateway.testnet2.unicity.network` | `wss://nostr-relay.testnet.unicity.network` | `https://wallet-api.unicity.network` |
| `'mainnet'` | 1 | `https://gateway.mainnet.unicity.network` | the testnet relay (mainnet has none of its own yet) | `https://wallet-api.mainnet.unicity.network` |
| `'testnet'` | 4 | same as `testnet2` | same as `testnet2` | none: the testnet2 wallet-api signs in only as `'testnet2'`, and the SDK refuses its sign-in challenge for `'testnet'`. Use `'testnet2'` |

> **Live networks are testnet2 and mainnet**, each with its own gateway and wallet-api deployment. `testnet` is a second key with testnet2's configuration (network id 4, taken from the trust base; the testnet2 token registry), but it is a different string, so it fails the `network` check against a `'testnet2'` wallet-api config (see [`network` placement](#what-just-happened-the-provider-model)). `SPHERE_NETWORKS` exposes only `mainnet` and `testnet2`. The v1 network is discontinued — the old `goggregator-test` testnet spoke the removed v1 protocol, and the `dev` network that aliased its trust base has been removed along with every other v1 pointer. On mainnet use `network: 'mainnet'` in `createBrowserProviders`/`createNodeProviders`, in the `walletApi` config and on `Sphere.init`, the mainnet wallet-api `https://wallet-api.mainnet.unicity.network`, and your mainnet gateway API key, which is a secret. Mainnet shares testnet2's Nostr relay for now, and its token registry lists no fungible coins yet. The transfer wire payload is the finished token blob — the base SDK's own `Token.toCBOR()` bytes, with no sphere envelope around them — deposited into the recipient's wallet-api mailbox.
>
> The **network** name (testnet2) and the **base-SDK major** (3.x since 0.15.0) are separate axes: testnet2 is still testnet2 after the 3.0.1 bump. What the bump changes is the bytes on that network — a gateway serving the v3 protocol accepts nothing a 2.x client writes, and vice versa.

```typescript
// Use the testnet2 preset for all services
const presetOnly = createBrowserProviders({ network: 'testnet2' });

// Override specific services while using the network preset
const customGateway = createBrowserProviders({
  network: 'testnet2',
  oracle: { url: 'https://custom-gateway.example.com' }, // custom testnet2 gateway
});
```

### API Key

The SDK bundles **no default API key**. Pass the gateway key via `oracle: { apiKey }`. Without one the token engine is still built, the SDK logs a `TokenEngine` warning, and gateway requests are unauthenticated; whether a gateway serves them is the gateway's policy.

```typescript
const withApiKey = createBrowserProviders({
  network: 'testnet2',
  oracle: { apiKey: 'sk_...' },
});
```

The **testnet2 key is not a secret** — it is published in [.env.example](.env.example) and safe to keep in docs and client code. A **mainnet** key, by contrast, IS a secret: keep it in your deploy environment only.

### Testnet2 endpoints (the values we build with)

The `testnet2` preset wires most of these automatically — you only pass `network`, `oracle.apiKey`, and the wallet-api `baseUrl`. The full set, for reference and manual wiring:

| What | Value |
|------|-------|
| Network | `testnet2`, networkId **4** (the `testnet` key has the same gateway, relays and token registry, but it is a different literal and the testnet2 wallet-api signs in only as `'testnet2'`; use `testnet2`) |
| **Aggregator / gateway** (token engine) | `https://gateway.testnet2.unicity.network` |
| **Aggregator API key** (public — **not** a secret) | `sk_ddc3cfcc001e4a28ac3fad7407f99590` |
| **wallet-api** (delivery + token storage) | `https://wallet-api.unicity.network` |
| **Nostr relay** (messaging / nametags) | `wss://nostr-relay.testnet.unicity.network` |
| **Group-chat relay** (NIP-29) | `wss://sphere-relay.unicity.network` |
| **Token registry** | `https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/unicity-ids.testnet2.json` |

The aggregator key above is the **testnet2** key only and is safe in client code; a **mainnet** key is a real secret and must never be committed.

Mainnet (`network: 'mainnet'`, networkId **1**): gateway `https://gateway.mainnet.unicity.network`, wallet-api
`https://wallet-api.mainnet.unicity.network`, the same Nostr and group-chat relays as testnet2, and token registry
`https://raw.githubusercontent.com/unicitynetwork/unicity-ids/refs/heads/main/unicity-ids.mainnet.json`, which
currently lists only the non-fungible base token type (no fungible coins yet).

## Price Provider (Optional)

Enable fiat price display by adding a `price` config. Currently supports CoinGecko API (free and pro tiers).

```typescript
// With CoinGecko (free tier, no API key)
const base = createBrowserProviders({
  network: 'testnet2',
  price: { platform: 'coingecko' },
});
// With CoinGecko Pro: price: { platform: 'coingecko', apiKey: 'CG-xxx' }

const providers = createWalletApiProviders(base, {
  baseUrl: 'https://wallet-api.unicity.network',
  network: 'testnet2',
});
const { sphere } = await Sphere.init({ ...providers, network: 'testnet2', autoGenerate: true });

// Assets with price data
const assets = await sphere.payments.assets();
// [{ coinId, symbol, totalAmount, priceUsd: 97500, fiatValueUsd: 975.00, change24h: 2.3, ... }]

// Total portfolio value in USD
const totalUsd = assets.reduce((sum, a) => sum + (a.fiatValueUsd ?? 0), 0);
```

Without `price` config, the price fields in `assets()` are `null`. All other functionality works normally.

You can also set the price provider after initialization — price is a composition-time property of the payments vertical, so verticals composed after the call (the next address switch) pick it up:

```typescript
import { createPriceProvider } from '@unicitylabs/sphere-sdk';

sphere.setPriceProvider(createPriceProvider({
  platform: 'coingecko',
  apiKey: 'CG-xxx',
}));
```

## Test Tokens on Testnet (Self-Mint)

There is no faucet. On testnet you top up your wallet by **self-minting** fungible tokens via the token engine — `mint(coinIdHex, amount)` mints a finished token directly to this wallet (journal-first: crash-safe, a replay converges idempotently):

```typescript
import { TokenRegistry, getCoinIdBySymbol } from '@unicitylabs/sphere-sdk';

// Resolve the coin's hex id from the token registry (or pass a hex coinId directly).
await TokenRegistry.waitForReady(); // Sphere.init starts the registry load but does not await it
const coinId = getCoinIdBySymbol('UCT'); // string | undefined
if (!coinId) throw new Error('UCT is not in this network\'s token registry');

const result = await sphere.payments.mint(coinId, 1000n);
if (result.success) {
  console.log('Minted token:', result.tokenId);
} else {
  console.error('Mint failed:', result.error);
}
```

> **Note:** Minting needs the token engine, which `Sphere.init` builds from the oracle's trust base and
> gateway URL (without them `Sphere.init` rejects with `INVALID_CONFIG`); pass the gateway key via
> `oracle: { apiKey }`. A mint that fails after it was journaled resolves `{ success: false, error }`
> and is replayed by the SDK: do not call `mint()` again for it. See [API Key](#api-key) above.

## Multi-Address Support

The SDK supports HD (Hierarchical Deterministic) wallets with multiple addresses:

```typescript
// Get current address index
const currentIndex = sphere.getCurrentAddressIndex(); // 0

// Switch to a different address
await sphere.switchToAddress(1);
console.log(sphere.identity?.directAddress); // DIRECT://... (address at index 1)

// Register nametag for this address (independent per address)
await sphere.registerNametag('bob');

// Switch back to first address
await sphere.switchToAddress(0);

// Get the nametag of a specific address. Index 1 is tracked because we switched to it.
const bobNametag = sphere.getTrackedAddress(1)?.nametag; // 'bob'
// getNametagForAddress takes the short addressId ('DIRECT_xxxxxx_yyyyyy'), not an index:
const sameNametag = sphere.getNametagForAddress(sphere.getTrackedAddress(1)?.addressId);

// All active addresses with their nametags (TrackedAddress[], sorted by index)
const active = sphere.getActiveAddresses();
// [{ index: 0, addressId: 'DIRECT_…', directAddress: 'DIRECT://…', nametag: 'alice', … }, { index: 1, …, nametag: 'bob' }]

// deriveAddress() returns keys, not an address: { privateKey, publicKey, path, index }.
const keys2 = sphere.deriveAddress(2);
console.log(keys2.publicKey, keys2.path); // never log or serialise the whole object: it holds the private key
```

`deriveAddress(index)` returns key material, `{ privateKey, publicKey, path, index }`, not an address; never log or
serialise the whole object. For the `DIRECT://` address use `sphere.identity?.directAddress` (active address) or
`sphere.getTrackedAddress(index)?.directAddress` (after `switchToAddress(index)`). `getAllAddressNametags()` is
deprecated; it returns `Map<addressId, Map<nametagIndex, nametag>>`, keyed by the short `addressId`.

### Identity Properties

**Important:** The DIRECT address is the primary address for the Unicity network.

```typescript
interface Identity {
  chainPubkey: string;         // 33-byte compressed secp256k1 public key
  directAddress?: string;      // DIRECT address (DIRECT://...) - PRIMARY ADDRESS
  ipnsName?: string;           // legacy derived id ('12D3KooW…'); nothing in the SDK uses it
  nametag?: string;            // Registered nametag (@username)
}

// Access identity - use directAddress as primary
console.log(sphere.identity?.directAddress);    // DIRECT://0000be36... (PRIMARY)
console.log(sphere.identity?.nametag);          // alice (human-readable)
console.log(sphere.identity?.chainPubkey);      // 02abc123... (33-byte compressed)
```

### Address Change Event

Event handlers receive the payload directly: `sphere.on('identity:changed', (e) => e.addressIndex)`, not
`e.data.addressIndex`. `on()` returns an unsubscribe function.

```typescript
// Listen for address switches
const off = sphere.on('identity:changed', (event) => {
  console.log('Switched to address index:', event.addressIndex);
  console.log('L3 address:', event.directAddress);
  console.log('Chain pubkey:', event.chainPubkey);
  console.log('Nametag:', event.nametag);
});

// Nametag recoveries after init (e.g. after switchToAddress)
sphere.on('nametag:recovered', (event) => {
  console.log('Recovered nametag from Nostr:', event.nametag);
});

off(); // stop listening
```

Nametag recovery during `Sphere.init` / `load` / `import` finishes, and emits `nametag:recovered`, before the call
returns, so a listener added afterwards does not see it. Check `sphere.identity?.nametag` after init. The event is
useful for later recoveries, such as after `switchToAddress()`.

## Payment Requests

Request payments from others over the wallet-api rail (`sphere.payments.requests`). Request memos ride an encrypted recipient-ECDH envelope.

- `requests.create(to, { coinId, amount, memo? })` never throws; it resolves `{ success, requestId?, error? }`. Check `success`. `coinId` is the 64-hex coin id (look it up with `getCoinIdBySymbol()`).
- Never pay from inside the `payment_request:incoming` handler without the user's decision; `pay()` and `decline()` are alternatives. `pay()` rethrows `send()`'s errors: handle them as in [Handling `send()` rejections](#handling-send-rejections-never-re-send-a-possibly-committed-payment-money-safety).
- `payment_request:updated` reports requests you **received**. The SDK does not track requests you created: detect payment through `transfer:incoming` or `sphere.payments.history()`.
- `request.amount` is a base-unit string and `request.coinId` the hex id; `request.symbol` is not set by the SDK event.

When the send inside `pay()` fails with a possibly-committed error, `pay()` links the request to that transfer (the
error's `transferId`) in the payments journal and marks it `'settling'` before it rethrows, so the request is not
payable, and the link survives a restart. One exception: if writing that link to storage fails, `pay()` rejects with
the storage error instead of the send error, so `isPossiblyCommittedSendOutcome` is `false` for it although the
payment may have gone out; the link is then held in memory and reaches storage only with a later successful journal
write. A second `pay()` of the same id while the first is still running joins it. The link is written after the send
returns or throws, not before it starts. If the app or process stops while `pay()` is still waiting on the send, or
before a link that failed to write reaches storage, no link exists: on the next start the request is listed as
`'pending'` again and `payment_request:incoming` fires again, even if the transfer went through (a transfer the SDK
had already recorded is resumed when the wallet starts). Before paying a request again after a restart, check
`sphere.payments.pendingTransfers()` and `sphere.payments.history()` for a transfer to that requester.

```typescript
import { TokenRegistry, getCoinIdBySymbol } from '@unicitylabs/sphere-sdk';

// Requester side: create() never throws. It resolves { success, requestId?, error? }.
await TokenRegistry.waitForReady();
const coinId = getCoinIdBySymbol('UCT'); // the 64-hex coin id, or undefined
if (coinId) {
  const created = await sphere.payments.requests.create('@bob', {
    coinId,
    amount: '1000000',
    memo: 'Payment for order #1234',
  });
  if (!created.success) console.error(created.error);
}

// Payer side: never pay from the event handler itself. Show the request and let the user decide.
sphere.on('payment_request:incoming', async (request) => {
  // request.amount is a base-unit string and request.coinId the hex coin id; request.symbol is not set here.
  console.log(`${request.senderNametag ?? request.senderPubkey} requests ${request.amount} of ${request.coinId}`);
  try {
    if (await askUser(request)) {
      await sphere.payments.requests.pay(request.id);
    } else {
      // A server 403/409 propagates: a refused decline is not success.
      await sphere.payments.requests.decline(request.id);
    }
  } catch (err) {
    console.error('payment request failed', err); // pay() rethrows send() errors: handle them like send()
  }
});

// Current views (requests you received) + housekeeping
const open = sphere.payments.requests.list();
sphere.payments.requests.dismissProcessed();
```

## Group Chat (NIP-29)

Relay-based group messaging using the NIP-29 protocol. The module embeds its own Nostr connection separate from the wallet transport.

### Enabling Group Chat

```typescript
// Enable with network defaults (wss://sphere-relay.unicity.network)
const { sphere } = await Sphere.init({
  ...providers,
  network: 'testnet2', // also selects the default group-chat relay
  autoGenerate: true,
  groupChat: true,
});
// Or enable with a custom relay: groupChat: { relays: ['wss://my-nip29-relay.com'] }

// Access the module (null unless Sphere.init got groupChat)
const gc = sphere.groupChat!;
```

### Connection

```typescript
// Connect to the NIP-29 relay
await gc.connect();
console.log('Connected:', gc.getConnectionStatus());

// Check if current user is a relay admin
const isRelayAdmin = await gc.isCurrentUserRelayAdmin();
```

### Groups

```typescript
import { GroupVisibility } from '@unicitylabs/sphere-sdk';

// Create a public group. createGroup resolves GroupData | null.
const group = await gc.createGroup({
  name: 'General',
  description: 'Public discussion',
});
if (!group) throw new Error('Could not create the group');

// Create a private group
const privateGroup = await gc.createGroup({
  name: 'Team',
  visibility: GroupVisibility.PRIVATE,
});

// Create a write-restricted group (only admins and moderators can post)
const announcements = await gc.createGroup({
  name: 'Announcements',
  writeRestricted: true,
});

// Discover and join
const available = await gc.fetchAvailableGroups(); // public groups on relay
await gc.joinGroup(group.id);

// Join private group with invite
if (privateGroup) await gc.joinGroup(privateGroup.id, inviteCode);

// List joined groups
const groups = gc.getGroups();

// Leave or delete
await gc.leaveGroup(group.id);
await gc.deleteGroup(group.id); // admin only
```

### Messaging

```typescript
// Send a message. sendMessage resolves GroupMessageData | null.
const msg = await gc.sendMessage(group.id, 'Hello!');

// Reply to a message: the third argument is replyToId?: string
await gc.sendMessage(group.id, 'Agreed', msg?.id);

// Fetch messages from the relay: fetchMessages(groupId, since?: number (ms), limit?: number)
const messages = await gc.fetchMessages(group.id, undefined, 50);

// Get locally cached messages
const cached = gc.getMessages(group.id);

// Listen for new messages in real-time
const unsubscribe = gc.onMessage((message) => {
  console.log(`[${message.groupId}] ${message.senderPubkey}: ${message.content}`);
});
```

### Members & Moderation

```typescript
// Get members
const members = gc.getMembers(group.id);

// Check roles
gc.isCurrentUserAdmin(group.id);     // boolean
gc.isCurrentUserModerator(group.id); // boolean
await gc.canModerateGroup(group.id); // includes relay admin check
gc.canWriteToGroup(group.id);       // false if write-restricted and not admin/moderator

// Moderate (requires admin/moderator role)
await gc.kickUser(group.id, userPubkey, 'reason');
await gc.deleteMessage(group.id, messageId);
```

### Invites (Private Groups)

```typescript
// Create invite code (admin only). createInvite resolves string | null.
const invite = await gc.createInvite(group.id);

// Share invite code, recipient joins with:
if (invite) await gc.joinGroup(group.id, invite);
```

### Unread Counts

```typescript
const total = gc.getTotalUnreadCount();
gc.markGroupAsRead(group.id);
```

### Key Types

```typescript
interface GroupData {
  id: string;
  relayUrl: string;
  name: string;
  description?: string;
  picture?: string;
  visibility: GroupVisibility;  // 'PUBLIC' | 'PRIVATE'
  createdAt: number;
  updatedAt?: number;
  memberCount?: number;
  unreadCount?: number;
  lastMessageTime?: number;
  lastMessageText?: string;
  writeRestricted?: boolean;   // Only admins and moderators can post
  localJoinedAt?: number;      // When the current user joined this group locally
}

interface GroupMessageData {
  id?: string;
  groupId: string;
  content: string;
  timestamp: number;
  senderPubkey: string;
  senderNametag?: string;
  replyToId?: string;
  previousIds?: string[];
}

interface GroupMemberData {
  pubkey: string;
  groupId: string;
  role: GroupRole;  // 'ADMIN' | 'MODERATOR' | 'MEMBER'
  nametag?: string;
  joinedAt: number;
}
```

## Direct Messages (NIP-17)

End-to-end encrypted DMs via NIP-17 gift wrap, accessed through `sphere.communications`:

```typescript
// Send a DM (by nametag or pubkey)
await sphere.communications.sendDM('@alice', 'Hello!');

// Listen for incoming DMs
sphere.communications.onDirectMessage((msg) => {
  console.log(`From ${msg.senderNametag ?? msg.senderPubkey}: ${msg.content}`);
});
```

### DM History on Connect

By default, the SDK resumes from the last processed DM timestamp (persisted in storage). On first connect, it starts from "now" — no historical replay.

`Sphere.init` also accepts a `dmSince` option (unix seconds), meant as a fallback start for that first
subscription. With the Nostr transport it does not take effect in this release: `Sphere.init` records it
only after the wallet's DM subscription is already open, so a first connect starts from "now" either way.

### Ephemeral Mode (No Caching)

For anonymous agents or LLM bots that don't need message history, disable DM caching. A bot that never
moves money also passes `walletApi: 'none'` (see [the provider model](#what-just-happened-the-provider-model)):

```typescript
const { sphere } = await Sphere.init({
  ...base,             // the createBrowserProviders / createNodeProviders result, without createWalletApiProviders
  walletApi: 'none',   // messaging only: no wallet-api session, no token engine, no money
  network: 'testnet2', // still required: it selects the token registry and group-chat relays
  autoGenerate: true,
  communications: { cacheMessages: false },
});

// Stream-only: receive, process, forget
sphere.communications.onDirectMessage((msg) => {
  processAndReply(msg);
});

// sendDM still works — message is sent but not stored locally
await sphere.communications.sendDM('@alice', 'response');
```

When `cacheMessages` is `false`:
- `onDirectMessage()` handlers and `message:dm` events fire normally
- Messages are never stored in memory or persisted to storage
- `getConversation()` / `getConversations()` return empty results
- Deduplication is skipped (duplicate relay deliveries may trigger duplicate events)

## Alternative: Manual Create/Load

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import {
  createLocalStorageProvider,
  createNostrTransportProvider,
  createUnicityAggregatorProvider,
} from '@unicitylabs/sphere-sdk/impl/browser'; // untyped entry: declare these too (see the TypeScript note above)

const NETWORK = 'testnet2';

const storage = createLocalStorageProvider({ network: NETWORK });
// Without `relays` the transport falls back to public Nostr relays (relay.damus.io, nos.lol,
// relay.nostr.band), so pass the Unicity relay explicitly.
const transport = createNostrTransportProvider({
  relays: ['wss://nostr-relay.testnet.unicity.network'],
});
// `network` is required: it selects the trust base the token engine is built from. A `trustBaseUrl`
// is only an override and still needs `network` as its fallback. The apiKey authenticates gateway requests.
const oracle = createUnicityAggregatorProvider({
  url: 'https://gateway.testnet2.unicity.network',
  apiKey: 'sk_...',
  network: NETWORK,
});

// The wallet-api transport config — REQUIRED for money (init throws INVALID_CONFIG without it)
const walletApi = {
  network: NETWORK,
  baseUrl: 'https://wallet-api.unicity.network',
  deviceId: 'device-1234', // stable on this device, different on every device (e.g. a persisted UUID)
};

// Check if wallet exists
if (await Sphere.exists(storage)) {
  // Load existing wallet: Sphere.load resolves the instance itself
  const sphere = await Sphere.load({ storage, transport, oracle, walletApi, network: NETWORK });
} else {
  // Create new wallet with mnemonic
  const mnemonic = Sphere.generateMnemonic();
  const sphere = await Sphere.create({
    mnemonic,
    storage,
    transport,
    oracle,
    walletApi,
    network: NETWORK,
  });
  console.log('Save this mnemonic:', mnemonic);
}
```

## Import from Master Key (Legacy Wallets)

For wallets whose master key was extracted elsewhere (e.g. an older backup):

```typescript
// Import from master key + chain code (BIP32 mode). Sphere.import resolves the instance itself.
const bip32Wallet = await Sphere.import({
  masterKey: '64-hex-chars-master-private-key',
  chainCode: '64-hex-chars-chain-code',
  basePath: "m/84'/1'/0'",  // BIP84 account path
  derivationMode: 'bip32',
  storage, transport, oracle, walletApi,
  network: 'testnet2',
});

// Or import from master key only (WIF HMAC mode)
const wifWallet = await Sphere.import({
  masterKey: '64-hex-chars-master-private-key',
  derivationMode: 'wif_hmac',
  storage, transport, oracle, walletApi,
  network: 'testnet2',
});
```

> **`Sphere.import()` wipes first, and that wipe destroys live Spheres.** When a wallet already
> exists on the given storage — or a Sphere is live on it — import calls `Sphere.clear()` before
> writing, which calls `destroy()` on every live `Sphere` built on that **backing store**: their
> payments verticals stop, their providers disconnect, and every `sphere.on()` handler goes with
> them. The scope is the store, not the provider object: two provider objects reporting the same
> `backingStoreId` share the teardown, while a Sphere on unrelated storage is left alone. Drop
> your references to the old instance rather than reusing it.
>
> The clear also erases the storage's payments state (`pv2g2:*`), including the journals of
> transfers still in flight, so do not import while transfers are pending. With IndexedDB the store
> is the whole database named by `dbName`: every key `prefix` in it is erased, so give each wallet
> its own `dbName`.

## Wallet Export/Import (JSON)

```typescript
// Export to JSON (for backup)
const json = sphere.exportToJSON();
console.log(JSON.stringify(json));

// Export with encryption
const encryptedJson = sphere.exportToJSON({ password: 'user-password' });

// Export with multiple addresses
const multiJson = sphere.exportToJSON({ addressCount: 5 });

// Import from JSON. importFromJSON never throws: { success, sphere?, mnemonic?, error? }.
// Like Sphere.import it needs walletApi and network, and it first clears the wallet in this storage.
const res = await Sphere.importFromJSON({
  ...providers,               // storage, transport, oracle, walletApi
  network: 'testnet2',
  jsonContent: JSON.stringify(encryptedJson),
  password: 'user-password',  // decrypts an encrypted backup
});
if (!res.success || !res.sphere) throw new Error(res.error ?? 'import failed');
const restored = res.sphere;  // keep it: this is the live instance
```

`importFromJSON` (and `importFromLegacyFile`) use `password` only to decrypt the backup: the imported
seed is stored **without** a password (see [Wallet Security & Encryption](#wallet-security--encryption)).

## Wallet Info & Backup

```typescript
// Get wallet info
const info = sphere.getWalletInfo();
console.log('Source:', info.source);        // 'mnemonic' | 'file' | 'unknown'
console.log('Has mnemonic:', info.hasMnemonic);
console.log('Derivation mode:', info.derivationMode);
console.log('Base path:', info.basePath);

// Get mnemonic for backup (if available)
const mnemonic = sphere.getMnemonic();
if (mnemonic) {
  console.log('Backup this:', mnemonic);
}
```

## Core Utilities

The SDK exports commonly needed utility functions:

```typescript
import {
  // Crypto
  bytesToHex, hexToBytes,
  generateMnemonic, validateMnemonic,
  sha256,
  getPublicKey, createKeyPair,

  // Currency conversion
  parseTokenAmount,     // "1.5" → 1500000000000000000n (strict; throws on invalid input)
  safeParseTokenAmount, // like parseTokenAmount but returns null instead of throwing
  toHumanReadable,      // 1500000000000000000n → "1.5"
  formatAmount,         // Format with decimals and symbol

  // Base58 (Bitcoin-style)
  base58Encode, base58Decode,
  isValidPrivateKey,

  // General utilities
  sleep, randomHex, randomUUID,
  findPattern, extractFromText,
} from '@unicitylabs/sphere-sdk';
```

## Token format & verification

Tokens are opaque CBOR blobs — the base SDK's own `Token.toCBOR()` bytes, with no sphere-private
envelope wrapped around them (`Token.sdkData` carries the hex when a blob is loaded). That is the
same form on the wire, in the wallet-api mailbox and in server storage. Since 0.15.0 those bytes
are **state-transition-sdk 3.x** CBOR; a 2.x blob does not decode and is rejected on receipt (the
drain warns and acks it as invalid rather than silently dropping it).

Inventory lives in the wallet-api backend; the SDK downloads blobs on demand (lazy tokens carry
value metadata only until selected for a spend). Every incoming token is engine-verified (full
trust-base proof check) and ownership-checked **before it enters the balance** — there is no
separate validate step to run.

## Architecture

**Single Identity Model**: A single secp256k1 key pair backs the L3 identity. One mnemonic = one wallet.

```
mnemonic → master key → BIP32 derivation → identity
                                              ↓
                        ┌─────────────────────┴─────────────────────┐
                        │              shared keys                  │
                        │  privateKey:   "abc..."  (hex secp256k1)  │
                        │  chainPubkey:  "02def..." (33-byte comp.) │
                        │  directAddress: "DIRECT://..." (L3)       │
                        └─────────────────────┬─────────────────────┘
                                              ↓
              ┌──────────────────┬──────────────────┐
              ↓                  ↓                  ↓
         L3 (Unicity)        Group Chat           Nostr
       sphere.payments    sphere.groupChat  sphere.communications
       Tokens, engine     NIP-29 messaging    P2P messaging
```

```
Sphere (main entry point)
├── identity       - Wallet identity (address, publicKey, nametag)
├── payments       - The payments facade: assets/tokens/history/send/mint/receive/requests
├── market         - Intent bulletin board (via sphere.market)
├── groupChat      - NIP-29 group messaging (via sphere.groupChat)
└── communications - Direct messages & broadcasts

Payments vertical (modules/payments-v2/ — docs/PAYMENTS-V2-DESIGN.md)
└── PaymentsFacade over swappable money ports (StoragePort / DeliveryPort,
    contract-test-enforced) + TransferMachine (durable server-side intents,
    resume under the same transferId) + receive drain (verified before
    balance) + requests + paged history. Composed per address from the
    `walletApi` transport config (core/payments-v2-wiring.ts).

Token Engine (token-engine/)
└── The wallet's boundary to the base state-transition SDK (pinned 3.0.1):
    all mint / transfer / split / verify / spent-check operations go through
    the ITokenEngine port. Sphere builds the engine from the oracle's config
    (trust base JSON + gateway URL + API key); no state-transition SDK
    objects cross this boundary.

Providers (injectable)
├── StorageProvider      - Key-value persistence: keys/identity + the pv2g2:* scoped KV
├── TransportProvider    - Messaging (Nostr) — NOT the payment rail
├── OracleProvider       - Token-engine config (trust base JSON + gateway URL + API key)
└── walletApi (config)   - WalletApiTransportConfig — the wallet-api wire the
                           money ports are composed from (not a provider object)

Implementation (platform-specific)
├── impl/shared/            - Common interfaces & resolvers
├── impl/shared/wallet-api/ - createWalletApiProviders() → { ...base, walletApi }
├── impl/wallet-api-v2/     - The wallet-api wire: session (auth + wake WS), client,
│                             storage/mailbox/checkpoint port implementations
├── impl/browser/        - Browser base: LocalStorage/IndexedDB + createBrowserProviders()
└── impl/nodejs/         - Node.js base: File storage + createNodeProviders()

Core Utilities
├── crypto     - Key derivation, hashing, signatures
├── currency   - Amount formatting and conversion
└── utils      - Base58, patterns, sleep, random
```

## Shared Configuration Pattern

Both browser and Node.js implementations share common configuration interfaces and resolution logic
(in this repository: `impl/shared/config.ts` and `impl/shared/resolvers.ts`). `@unicitylabs/sphere-sdk/impl/shared`
is **not** a package export: the base types are re-exported from `@unicitylabs/sphere-sdk/impl/nodejs`, and the
resolvers (`getNetworkConfig`, `resolveTransportConfig`, `resolveOracleConfig`, `resolveArrayConfig`) are internal.

```typescript
import type {
  BaseTransportConfig,  // Common transport options
  BaseOracleConfig,     // Common oracle options
  BaseProviders,        // Common result structure
  NodeOracleConfig,     // BaseOracleConfig + trustBasePath (Node.js)
} from '@unicitylabs/sphere-sdk/impl/nodejs';
```

### Extend/Override Pattern

The configuration resolution follows a consistent pattern across platforms. For relay lists the priority is
replace > extend > defaults:

| Config | Result (network defaults `['a', 'b']`) |
|--------|----------------------------------------|
| none | `['a', 'b']` (defaults) |
| `{ relays: ['x'] }` | `['x']` (replace) |
| `{ additionalRelays: ['c'] }` | `['a', 'b', 'c']` (extend) |

### Platform-Specific Extensions

Each platform extends the base interfaces with platform-specific options: the browser transport config adds
`reconnectDelay` and `maxReconnectAttempts`; the Node.js oracle config adds `trustBasePath` for a file-based trust base:

```typescript
import type { NodeOracleConfig } from '@unicitylabs/sphere-sdk/impl/nodejs';

const oracle: NodeOracleConfig = {
  apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590', // public testnet2 gateway key
  trustBasePath: './trustbase.json',             // Node.js only; falls back to the embedded trust base of `network`
};
```

## Documentation

Consumer-facing:

- [API Reference](./docs/API.md) — `Sphere`, the payments facade and the modules
- [Integration Guide](./docs/INTEGRATION.md) — composition, custody, custom providers, events
- [Browser Quick Start](./docs/QUICKSTART-BROWSER.md) / [Node.js Quick Start](./docs/QUICKSTART-NODEJS.md)
- [Connect Protocol](./docs/CONNECT.md) — dApp ↔ wallet RPC (protocol version `2.3`)
- [Parallel token verification](./docs/VERIFICATION-WORKERS.md) — the opt-in worker pool
- [CHANGELOG](./CHANGELOG.md) — per-release notes (versioned sections start at `0.14.11`)

Design and migration references:

- [Payments vertical design](./docs/PAYMENTS-V2-DESIGN.md) — the design record of the money vertical (marked DRAFT; its §5 directory layout predates the current `modules/payments-v2/` tree)
- [Payments migration guide](./docs/MIGRATION-PAYMENTS-V2.md) — what the P11 flip moved
- [Token registry migration guide](./docs/MIGRATION-TOKEN-REGISTRY.md) — the per-Sphere token
  registry, the removed `Sphere.getInstance()` / `isInitialized()` lifecycle globals, and
  `Sphere.clear()` / `import()` becoming backing-store-scoped

## Browser Providers

The SDK includes browser-ready provider implementations:

| Provider | Description |
|----------|-------------|
| `IndexedDBStorageProvider` | IndexedDB storage; the default of `createBrowserProviders` |
| `LocalStorageProvider` | Browser localStorage with SSR fallback (an alternative to IndexedDB) |
| `NostrTransportProvider` | Nostr relay messaging: NIP-17 DMs (NIP-04 only for legacy encrypted events), nametag bindings |
| `UnicityAggregatorProvider` | Network config for the token engine (trust base + gateway URL + API key) |

## Node.js Providers

For CLI and server applications. Install `ws` next to the SDK (`npm install @unicitylabs/sphere-sdk ws`).
`@unicitylabs/sphere-sdk/impl/nodejs` imports `ws` when the module loads, on every Node version, and the package
declares `ws` only as an optional peer dependency, so npm does not install it for you. The package requires
Node.js >= 22 (`engines`).

```typescript
// npm install @unicitylabs/sphere-sdk ws
import { Sphere, TokenRegistry } from '@unicitylabs/sphere-sdk';
import { createNodeProviders, createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

const NETWORK = 'testnet2';

// Quick start with testnet2
const base = createNodeProviders({
  network: NETWORK,
  dataDir: './wallet-data', // optional, default './sphere-data'
  oracle: { apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590' }, // public testnet2 gateway key
});

const { sphere } = await Sphere.init({
  ...createWalletApiProviders(base, {
    baseUrl: 'https://wallet-api.unicity.network',
    network: NETWORK,
    deviceId: 'my-service-host-1', // stable on this machine, unique per machine
  }),
  network: NETWORK,
  autoGenerate: true,
});

// ... use sphere ...

await sphere.destroy();
TokenRegistry.destroy(); // stops the process-global registry refresh timer, so Node can exit

// Full configuration
const fullyConfigured = createNodeProviders({
  network: NETWORK,
  dataDir: './wallet-data',
  transport: {
    additionalRelays: ['wss://my-relay.com'],
    timeout: 10000,
    debug: true,
  },
  oracle: {
    apiKey: 'my-api-key',
    trustBasePath: './trustbase.json',  // Node.js specific; `network` is the fallback when the file is missing
  },
});
```

`sphere.destroy()` stops this Sphere's own registry, but `Sphere.init` also configures the process-wide
`TokenRegistry`, whose hourly refresh timer keeps Node's event loop alive. Call `TokenRegistry.destroy()` after
`sphere.destroy()` when the process should exit.

### Manual Provider Creation

```typescript
import {
  FileStorageProvider,
  createNostrTransportProvider,
  createNodeTrustBaseLoader,
} from '@unicitylabs/sphere-sdk/impl/nodejs';

// File-based wallet storage (keys/identity/journals — tokens are server custody)
const storage = new FileStorageProvider('./wallet-data');

// Nostr with Node.js WebSocket
const transport = createNostrTransportProvider({
  relays: ['wss://nostr-relay.testnet.unicity.network'],
});

// Load the trust base from a local file. A path needs the network to fall back to:
const trustBaseLoader = createNodeTrustBaseLoader('./trustbase-testnet2.json', 'testnet2');
const trustBase = await trustBaseLoader.load(); // the file's JSON, or the embedded testnet2 trust base
```

## Custom Providers Configuration

The SDK uses an **extend/override pattern** for flexible configuration:

| Option | Behavior |
|--------|----------|
| `relays` | **Replaces** default relays entirely |
| `additionalRelays` | **Adds** to default relays |
| `url` | **Replaces** default URL (uses network default if not set) |

```typescript
// Simple: use network preset
const simple = createBrowserProviders({ network: 'testnet2' });

// Add extra relays to testnet2 defaults
const extraRelays = createBrowserProviders({
  network: 'testnet2',
  transport: {
    additionalRelays: ['wss://my-relay.com', 'wss://backup-relay.com'],
    // Result: testnet relay + my-relay + backup-relay
  },
});

// Replace relays entirely (ignores network defaults)
const ownRelays = createBrowserProviders({
  network: 'testnet2',
  transport: {
    relays: ['wss://only-this-relay.com'],
    // Result: only-this-relay (testnet default ignored)
  },
});

// Override aggregator, keep other testnet2 defaults
const ownAggregator = createBrowserProviders({
  network: 'testnet2',
  oracle: {
    url: 'https://my-aggregator.com',  // replaces the testnet2 aggregator
    apiKey: 'my-api-key',
  },
});

// Full custom configuration
const fullyCustom = createBrowserProviders({
  network: 'testnet2',
  storage: {
    prefix: 'myapp_',
  },
  transport: {
    additionalRelays: ['wss://extra-relay.com'],
    timeout: 15000,
    autoReconnect: true,
    debug: true,
  },
  oracle: {
    url: 'https://custom-aggregator.com',
    apiKey: 'secret',
    timeout: 60000,
  },
});

```


## Custom Money Transport (Advanced)

Token custody is the wallet-api backend — there is no local token store to swap. What IS swappable is the money transport: the `paymentsV2Transport` seam in the `walletApi` config injects a whole per-address bundle (session + wire client) in place of the default HTTP+WebSocket wire. This is how the SDK's own offline test suites run. The port contracts live in `modules/payments-v2/ports.ts` (`StoragePort`, `DeliveryPort`) with conformance suites under `tests/unit/payments-v2/contracts/`.

`createWalletApiProviders()` types `baseUrl` as required. To supply the transport yourself, build the `walletApi`
config directly: in `WalletApiTransportConfig`, `baseUrl` is optional when `paymentsV2Transport` is set, and the
seam wins over `baseUrl`.

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import type { WalletApiTransportConfig } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

const base = createNodeProviders({ network: 'testnet2' });
const walletApi: WalletApiTransportConfig = {
  network: 'testnet2',
  paymentsV2Transport: (args) => myTransportBundle(args), // returns { session, client }
};
const { sphere } = await Sphere.init({ ...base, walletApi, network: 'testnet2', autoGenerate: true });
```

## Dynamic Relay Management

Nostr relays can be added or removed at runtime through the transport provider. The relay-management
methods are optional members of `TransportProvider` (the Nostr transport implements them), so call them with `?.`
under `strict`:

```typescript
const transport = sphere.getTransport();

// Get current relays
const configuredRelays = transport.getRelays?.() ?? [];          // All configured
const connectedRelays = transport.getConnectedRelays?.() ?? [];  // Currently connected

// Add a new relay (connects immediately if provider is connected)
await transport.addRelay?.('wss://new-relay.com');

// Remove a relay from the configuration. The live connection is dropped only on the next reconnect.
await transport.removeRelay?.('wss://old-relay.com');

// Check relay status
transport.hasRelay?.('wss://relay.com');         // Is configured?
transport.isRelayConnected?.('wss://relay.com'); // Is connected?
```

### Relay Events

Relay events (`transport:relay_added`, `transport:relay_removed`, `transport:error`, ...) are not Sphere events;
they are emitted by the Nostr transport provider and are subscribed with its `onEvent()`, which is not part of the
`TransportProvider` interface. Connection changes also reach `sphere.on('connection:changed', ...)`.

```typescript
import type { Sphere, TransportEventCallback } from '@unicitylabs/sphere-sdk';

const nostr = sphere.getTransport() as ReturnType<Sphere['getTransport']> & {
  onEvent?(callback: TransportEventCallback): () => void;
};
const unsubscribe = nostr.onEvent?.((event) => {
  // event: { type, timestamp, data?, error? }
  if (event.type === 'transport:relay_added') console.log('Relay added:', event.data);      // { relay, connected, error? }
  if (event.type === 'transport:relay_removed') console.log('Relay removed:', event.data);  // { relay }
  if (event.type === 'transport:error') console.log('Transport error:', event.data ?? event.error);
});

// transport:connected / disconnected / reconnecting / error are also bridged to this Sphere event:
sphere.on('connection:changed', (e) => console.log(e.provider, e.connected, e.status));
```

### UI Integration Example

```typescript
// User adds relay via settings UI
async function handleAddRelay(relayUrl: string) {
  const transport = sphere.getTransport();

  if (transport.hasRelay?.(relayUrl)) {
    showError('Relay already configured');
    return;
  }

  const success = await transport.addRelay?.(relayUrl);
  if (success) {
    showSuccess(`Added ${relayUrl}`);
  } else {
    showWarning(`Added but failed to connect to ${relayUrl}`);
  }
}

// User removes relay via settings UI. This edits the configuration only:
// the live connection is dropped on the next reconnect.
async function handleRemoveRelay(relayUrl: string) {
  const transport = sphere.getTransport();
  await transport.removeRelay?.(relayUrl);
  showSuccess(`Removed ${relayUrl}`);
}

// Display relay status in UI
function getRelayStatuses() {
  const transport = sphere.getTransport();
  return (transport.getRelays?.() ?? []).map(relay => ({
    url: relay,
    connected: transport.isRelayConnected?.(relay) ?? false,
  }));
}
```

## Nametags (Unicity IDs)

Nametags provide human-readable addresses (e.g., `@alice`) for receiving payments. Valid formats: lowercase alphanumeric with `_` or `-` (3–20 chars), or E.164 phone numbers (e.g., `+14155552671`). Input is normalized to lowercase automatically.

**How registration works:** registering a nametag publishes a **Nostr identity binding** (name ↔ chain pubkey). Uniqueness follows UNIP-01: every nametag binding the SDK publishes carries the `["L", "unicity:nametag"]` marker, a UNIP-01 relay keeps the first author it receives for a marked name, and resolution uses the marked binding (`null` when more than one author holds a marked binding for the name). `created_at` first-seen-wins applies only to legacy unmarked bindings and can be forged (see [docs/NAMETAG-BINDINGS.md](docs/NAMETAG-BINDINGS.md)). A name is available iff no binding resolves for it (`sphere.isNametagAvailable(name)`). Runtime name resolution is binding-only; payments always go to the recipient's key-based `DIRECT://` address (there are no PROXY addresses).

Registration is **Nostr-binding-only**. The self-issued `UnicityIdToken` on-chain claim was removed with the 2.0.0 state-transition-sdk bump (upstream deleted the unicity-id primitive) — nothing is minted at registration, and nothing on chain is consulted to resolve a name.

### Registering a Nametag

```typescript
// During wallet creation. If the storage already holds a wallet, init loads it and
// ignores mnemonic and nametag.
const { sphere } = await Sphere.init({
  ...providers,
  network: 'testnet2',
  mnemonic: 'your twelve words...',
  nametag: 'alice',  // Will register @alice
});

// Or after creation
await sphere.registerNametag('alice');

// Check availability first
const free = await sphere.isNametagAvailable('alice');
```

### Common Pitfall: Nametag Already Taken

If you see this error:
```
Failed to register Unicity ID. It may already be taken.
```

This means the nametag is registered (bound on Nostr) to a **different public key**. Common causes:

1. **Storage cleared or not persisting**:
   - `Sphere.exists()` returns `false` because storage is empty/inaccessible
   - SDK creates a new wallet with new keypair
   - Nametag registration fails because old pubkey owns it on Nostr

2. **Different mnemonic provided**:
   ```typescript
   // ❌ WRONG: Random mnemonic each time
   const mnemonic = Sphere.generateMnemonic();
   const { sphere } = await Sphere.init({
     ...providers,
     network: 'testnet2',
     mnemonic,
     nametag: 'myservice',  // Fails after first run
   });
   ```

**Note:** `autoGenerate: true` does NOT generate a new mnemonic on every restart. It only generates one if `Sphere.exists()` returns `false` (wallet not found in storage).

### Solution: Persistent Storage or Fixed Mnemonic

**Option 1: Persistent file storage** (recommended for backend):

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders, createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

// createNodeProviders stores the wallet in a file under dataDir, so it persists across restarts.
const providers = createWalletApiProviders(
  createNodeProviders({ network: 'testnet2', dataDir: './wallet-data' }),
  { baseUrl: 'https://wallet-api.unicity.network', network: 'testnet2', deviceId: 'my-service-host-1' },
);

const { sphere } = await Sphere.init({
  ...providers,
  network: 'testnet2',
  autoGenerate: true,  // OK: mnemonic saved to disk, reused on restart
  nametag: 'myservice',
});
```

**Option 2: Fixed mnemonic from environment**:

```typescript
const { sphere } = await Sphere.init({
  ...providers,
  network: 'testnet2',
  mnemonic: process.env.WALLET_MNEMONIC,  // Same mnemonic every time
  nametag: 'myservice',
});
```

### Debugging Storage Issues

If nametag fails unexpectedly, check if wallet exists:

```typescript
const exists = await Sphere.exists(storage);
console.log('Wallet exists:', exists);  // Should be true after first run

// If false - storage is not persisting properly
```

### Nametag Recovery on Import

When a wallet is imported (`Sphere.import`, `importFromJSON`, `importFromLegacyFile`) or created from an existing
mnemonic without a `nametag`, the SDK looks the nametag up in its Nostr binding and restores it before the call
returns. The `nametag:recovered` event for that recovery has already fired by then, so a listener added afterwards
does not see it: read `sphere.identity?.nametag` instead.

```typescript
// Import wallet: this CLEARS the wallet already in this storage first, then stores the given one.
// The nametag is recovered automatically if found on Nostr.
const sphere = await Sphere.import({
  ...providers,
  network: 'testnet2',
  mnemonic: 'your twelve words...',
  // No nametag specified - will try to recover from Nostr
});

// After import, check if nametag was recovered
console.log(sphere.identity?.nametag);  // 'alice' (if found on Nostr)
```

### Multi-Address Nametags

Each derived address can have its own independent nametag:

```typescript
// Address 0: @alice
await sphere.registerNametag('alice');

// Switch to address 1 and register different nametag
await sphere.switchToAddress(1);
await sphere.registerNametag('bob');

// Now:
// - Address 0 → @alice
// - Address 1 → @bob

// Get nametag for specific address (both indexes are tracked: 0 at creation, 1 by the switch)
const aliceTag = sphere.getTrackedAddress(0)?.nametag;  // 'alice'
const bobTag = sphere.getTrackedAddress(1)?.nametag;    // 'bob'
```

---

## Wallet Security & Encryption

The wallet keeps its mnemonic (or master key) in the storage provider: IndexedDB in the browser, the wallet file
on Node. If you pass `password` when the wallet is created or imported, the SDK encrypts that value with
CryptoJS's password-based AES-256-CBC, which derives the key with OpenSSL's `EVP_BytesToKey` (MD5, one iteration).
That keeps the phrase out of casual view and out of copies of the storage that are read without the password, but
it is a fast key derivation: anyone who obtains the stored value can try passwords offline at high speed, so a
short or common password gives little protection. Without a password the mnemonic is stored as plaintext. The
other stored data (derivation path, nametags, payment journals) is not protected by the password either way.
Always set a password for wallets that hold value, make it long and unique, and protect the storage itself at the
operating-system level (file permissions and disk encryption on servers; the browser profile on clients).
`exportToJSON({ password })` uses the same scheme. There is no call to add or change the password later, and
`importFromJSON` / `importFromLegacyFile` store the imported mnemonic or master key without a password: load that
wallet later without `password` (passing the backup password to `Sphere.init` / `Sphere.load` fails with
`STORAGE_ERROR`).

```typescript
// Create or load with a password: the stored mnemonic is encrypted with it.
const { sphere } = await Sphere.init({ ...providers, network: 'testnet2', autoGenerate: true, password: userPassword });

// Later launches must pass the same password; a wrong one fails with STORAGE_ERROR 'Failed to decrypt mnemonic'.
await sphere.destroy();
const again = await Sphere.load({ ...providers, network: 'testnet2', password: userPassword });

// A password-protected JSON backup (same CryptoJS scheme as the stored seed):
const backup = again.exportToJSON({ password: userPassword });
```

(`exportToTxt({ password })` uses a different scheme: PBKDF2-SHA1 with 100,000 iterations and a fixed salt, then
CryptoJS AES with the derived key as a passphrase.)

## License

MIT
