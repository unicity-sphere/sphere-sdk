# Sphere SDK Integration Guide

> **Quick Start**: For a fast setup, see the platform-specific guides:
> - [Browser Quick Start](./QUICKSTART-BROWSER.md) - Web applications
> - [Node.js Quick Start](./QUICKSTART-NODEJS.md) - Server-side / CLI
> - [Connect Protocol](./CONNECT.md) - Wallet ↔ dApp communication
>
> This document covers advanced integration patterns, the wallet composition model, custom provider implementations, and production custody patterns.

> **Which version this page describes:** the 0.17 line (0.17.3 is the current npm release).
> Coming from 0.14.x or earlier? Read [Upgrading to 0.15.0](#upgrading-to-0150) first — the
> base-SDK pin moved to `@unicitylabs/state-transition-sdk@3.0.1`, which is a wire break no
> client can straddle, and `sphere.paymentsV2` is gone. Later breaking changes are in the
> [CHANGELOG](../CHANGELOG.md): 0.16.0 removed `Sphere.getInstance()`, `Sphere.isInitialized()`
> and the root export `getSphere` (hold the instance the entry point returns; `sphere.isReady`
> answers readiness) and made mainnet runnable; 0.17.x added coinless tokens (NFTs) and, in
> 0.17.3, the messaging-only `walletApi: 'none'` composition.

## Table of Contents

1. [Upgrading to 0.15.0](#upgrading-to-0150)
2. [Setup](#setup)
3. [Wallet Composition](#wallet-composition)
4. [Custody Model](#custody-model)
5. [Wallet Operations](#wallet-operations)
6. [L3 Payments](#l3-payments)
7. [How Transfers Work](#how-transfers-work-sender-driven)
8. [Payment Requests](#payment-requests)
9. [Communications](#communications)
10. [Custom Providers](#custom-providers)
11. [Events](#events)
12. [Nametags (Unicity IDs)](#nametags-unicity-ids)
13. [Error Handling](#error-handling)
14. [Best Practices](#best-practices)
15. [Testing](#testing)

---

## Upgrading to 0.15.0

Two things change for an integrator: the base SDK pin, and the removal of the `paymentsV2`
alias. Everything else on this page — composition, custody, the facade surface, the 8 events,
the error contract — is unchanged.

### The base-SDK pin: 2.1.0 → 3.0.1 (a flag day)

`@unicitylabs/state-transition-sdk` is pinned **exactly**, and 0.15.0 moves that pin to
`3.0.1`. v3 threads one new concept through the protocol: every transaction carries `expiresAt`,
an exclusive request deadline in Unix seconds, and every inclusion proof carries the
`referenceTime` of the round that certified it. The sparse-Merkle leaf value became
`H(transactionHash, referenceTime)` instead of the bare transaction hash, and the wire versions
of `Token`, `MintTransaction`, `TransferTransaction` and `CertificationData` all moved with it.

**Nothing a 2.x client wrote decodes, and nothing a 2.x client writes is accepted by the
upgraded gateway.** There is no straddle window and no compatibility shim, because the forcing
function is the aggregator, which hard-rejects `CertificationDataVersion = 1`. Concretely:

- **Bump the wallet-api backend in lockstep.** Both repos pin the base SDK exactly, so bumping
  one alone cannot be deduped by npm and leaves two mutually unintelligible realms live. The
  release is accompanied by a testnet + wallet-api backend reset.
- **A 2.x token blob no longer decodes.** Incoming blobs that fail to decode are logged and
  acked as invalid by the receive drain rather than silently dropped — they never enter the
  balance.
- **Stored split checkpoints from 2.x are unreadable by design.** `CHECKPOINT_VERSION` is 2 and
  `CHECKPOINT_SDK_VERSION` names the 3.0.1 pin, so a stale record is refused by *name* rather
  than by a byte comparison that would blame "derivation drift".
- **Nothing to run for the client's durable KV.** The scoped prefix moved from
  `pv2:{network}:{chainPubkey}:` to `pv2g2:{network}:{chainPubkey}:`, and the superseded `pv2:`
  keys are swept once when the vertical is composed. The rename IS the migration: the sync-epoch
  latch lives in that KV, and a latch that survived a backend reset would make the session see a
  changed epoch and re-PUT every locally-open intent into a freshly wiped backend — intents
  referencing tokens that no longer exist, which can never complete and hold their sources
  reserved forever. Under the new prefix the latch reads null and no restore fires.
  `Sphere.clear()` is not the fix for this (it clears with no prefix and takes the mnemonic
  with it) and is not needed.

**The error contract is unchanged, and nothing in your integration moves.** Sphere sets no
request deadline on any transaction (`expiresAt` is left for the service to assign), and v3's two
new certification statuses are not clean rejects — `REQUEST_EXPIRED` and `SERVICE_NOT_READY` each
report only that *this* submit was not admitted, never that no earlier attempt certified.
`TRANSACTION_HASH_MISMATCH` remains the only conflict signal, and `CERTIFICATION_UNCONFIRMED` /
[`isPossiblyCommittedSendOutcome()`](#send-error-handling) keep exactly the meaning they had. The
reasoning behind the deadline policy is in the CHANGELOG entry for 0.15.0.

### `sphere.paymentsV2` is removed

The deprecated alias, and the `paymentsV2: true` init flag that had already become a no-op, are
both gone. `sphere.payments` is the same facade the alias returned. The one behavioural
difference is the migration step a consumer will otherwise discover in production:

| | `sphere.paymentsV2` (removed) | `sphere.payments` |
|---|---|---|
| No vertical running (init in flight, mid address-switch, destroyed) | evaluated to `null` | **throws** `SphereError` with `code: 'NOT_INITIALIZED'` |
| Sphere initialised with `walletApi: 'none'` (messaging only, added in 0.17.3) | (did not exist) | **throws** `SphereError` with `code: 'PAYMENTS_NOT_COMPOSED'` (permanent for that instance) |

`sphere.hasPayments` tells the two apart without a `try`/`catch`: it is `false` only for a
`walletApi: 'none'` Sphere (see [Messaging-only wallets](#messaging-only-wallets-walletapi-none)).

```typescript
import { isSphereError } from '@unicitylabs/sphere-sdk';
import type { Token } from '@unicitylabs/sphere-sdk';

// BEFORE — the alias absorbed "not ready yet" (no longer compiles: paymentsV2 is removed)
// const tokens = sphere.paymentsV2?.tokens() ?? [];

// AFTER — the throw IS the readiness signal
let tokens: Token[] = [];
try {
  tokens = sphere.payments.tokens();
} catch (err) {
  if (!isSphereError(err) || err.code !== 'NOT_INITIALIZED') throw err;
}
```

With a wallet-api composition, `Sphere.init()` resolves with the vertical started, so ordinary
call sites read `sphere.payments` directly; the guard is only for code that can run while the
wallet is between states. `accounting:` / `swap:` are **not** part of this cleanup — they still throw a typed
`INVALID_CONFIG`, deliberately.

Wallet hosts embedding `ConnectHost` have one more change to make: the host's `SphereInstance`
contract now declares `readonly payments: PaymentsV2` and dropped both the legacy `payments`
read shape and the optional `paymentsV2`. The Connect **wire** is untouched — see
[ConnectHost: the `SphereInstance` contract](./CONNECT.md#connecthost-the-sphereinstance-contract).

---

## Setup

### Step 1: Create Base Providers

The first step is to create a base provider bundle with storage, transport, and oracle
configuration. `network` is required (the factories throw `INVALID_CONFIG` without it). Use
**one network literal, `'testnet2'`, in all three places**: here, in the `walletApi` config
(Step 2) and on `Sphere.init` (Step 3). The bundle does not carry `network`, so spreading it into
`Sphere.init` does not supply one.

```typescript
// Browser (requires CORS proxy for free CoinGecko API — see "CORS Proxy" section below)
import { createBrowserProviders } from '@unicitylabs/sphere-sdk/impl/browser'; // untyped entry: add the declaration shim below

const baseProviders = createBrowserProviders({
  network: 'testnet2',
  oracle: {
    apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590',  // testnet2 public key (NOT secret)
  },
  price: {
    platform: 'coingecko',
    baseUrl: '/api/coingecko',  // CORS proxy path (see "CORS Proxy" section)
  },
});
```

`@unicitylabs/sphere-sdk/impl/browser` ships no type declarations in this release; under
`strict` TypeScript add the declaration shim below (or a one-line
`declare module '@unicitylabs/sphere-sdk/impl/browser';`, which types everything from that entry
as `any`). Import `createWalletApiProviders` from the typed
`@unicitylabs/sphere-sdk/impl/shared/wallet-api` subpath, not from `./impl/browser`.

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

```typescript
// Node.js (no proxy needed). npm install @unicitylabs/sphere-sdk ws
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

const baseProviders = createNodeProviders({
  network: 'testnet2',
  dataDir: './wallet-data',  // optional, default './sphere-data'
  oracle: {
    apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590',  // testnet2 public key
  },
  price: { platform: 'coingecko', apiKey: 'CG-xxx' },  // Optional
});
```

Install `ws` next to the SDK (`npm install @unicitylabs/sphere-sdk ws`).
`@unicitylabs/sphere-sdk/impl/nodejs` imports `ws` when the module loads, on every Node version,
and the package declares `ws` only as an optional peer dependency, so npm does not install it for
you. The package's `engines` field requires Node.js `>=22.0.0`.

### Networks (Post v1-Cutover)

Both mainnet and testnet2 are live, each with its own gateway and wallet-api deployment.

| | testnet2 | mainnet |
|---|---|---|
| `network` literal (all three places) | `'testnet2'` | `'mainnet'` |
| Network id | 4 | 1 |
| Gateway (`NETWORKS[n].aggregatorUrl`) | `https://gateway.testnet2.unicity.network` | `https://gateway.mainnet.unicity.network` |
| Gateway API key | public: `sk_ddc3cfcc001e4a28ac3fad7407f99590` | a secret; keep it in your deploy environment |
| wallet-api `baseUrl` | `https://wallet-api.unicity.network` | `https://wallet-api.mainnet.unicity.network` |
| Nostr relay | `wss://nostr-relay.testnet.unicity.network` | the same relay (mainnet has none of its own yet) |
| Token registry fungible coins | UCT and others | none yet (only the non-fungible token type) |

- **`testnet`** is a second key in `NETWORKS` with the same endpoints as `testnet2`, but it is a
  different string. `Sphere.init` compares its own `network` with `walletApi.network` as plain
  strings and throws `INVALID_CONFIG` ("walletApi.network "testnet2" does not match the Sphere
  network ...") when they differ, including when `Sphere.init` gets no `network` at all, so
  mixing `'testnet'` and `'testnet2'` fails this check. The wallet-api deployment names its
  network too: the testnet2 deployment signs you in only as `'testnet2'`, and the SDK refuses a
  sign-in challenge for any other network. Use `'testnet2'` everywhere. (`SPHERE_NETWORKS`, the
  Connect registry, lists only `mainnet` and `testnet2`.)
- **mainnet**: use `network: 'mainnet'` in `createBrowserProviders`/`createNodeProviders`, in the
  `walletApi` config and on `Sphere.init`, the mainnet wallet-api
  `https://wallet-api.mainnet.unicity.network`, and your mainnet gateway API key, which is a
  secret. Mainnet shares testnet2's Nostr relay for now, and its token registry lists no fungible
  coins yet.
- The **dev** preset was removed with the discontinued v1 network.

The **"v2" in testnet2 is the gateway network, not the base-SDK major.** They are separate axes:
testnet2 is still testnet2 after the 0.15.0 bump to state-transition-sdk 3.0.1, and it is not
renamed "testnet3". What the pin governs is the bytes on that network — a gateway serving the v3
protocol accepts nothing a 2.x client writes.

### Aggregator API Key

The SDK does **not** ship a default aggregator API key. Pass it explicitly via `oracle.apiKey` when creating providers:

- **testnet / testnet2 keys are NOT secret** — safe to commit in `.env.example` and show in docs.
- **mainnet keys ARE secret** — keep them only in your deploy environment, never committed.

If no `apiKey` is provided, the token engine still constructs, but its gateway requests are unauthenticated and the SDK logs a `TokenEngine` warning. Pass the key explicitly, as every sample on this page does; whether a gateway serves unauthenticated requests is the gateway's policy, not something the SDK decides.

---

## Wallet Composition

### Money requires the wallet-api transport config — init fails closed

Money moves ONLY through the wallet-api vertical. `Sphere.init` **throws `INVALID_CONFIG`**
when the provider bundle carries no `walletApi` transport config — there is no silent
degraded mode. `createWalletApiProviders` builds the config. A wallet that never moves money
opts out explicitly with `walletApi: 'none'` (see
[Messaging-only wallets](#messaging-only-wallets-walletapi-none)).

### Step 2: Attach the Wallet-Api Transport Config

```typescript
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';

const providers = createWalletApiProviders(baseProviders, {
  baseUrl: 'https://wallet-api.unicity.network',  // testnet2 wallet-api
  network: 'testnet2',                             // the same literal as Step 1 and Step 3
  deviceId: myDeviceId,  // stable across launches on this device, different on every device (e.g. a persisted UUID)
});

// providers now includes:
// - all baseProviders (storage, transport, oracle)
// - walletApi: WalletApiTransportConfig — the plain config the payments
//   vertical is composed from ({ network, baseUrl, deviceId })
```

**WalletApiCompositionConfig** (the second argument of `createWalletApiProviders`):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `baseUrl` | string | Yes | Base URL of the wallet-api instance (`https://wallet-api.unicity.network` for testnet2, `https://wallet-api.mainnet.unicity.network` for mainnet). The type requires it even when `paymentsV2Transport` is supplied; to omit it, build the `walletApi` config yourself (see below). |
| `network` | string | Yes | Must equal the `network` passed to `Sphere.init`, as an exact string (`'testnet'` does not equal `'testnet2'` here), or init throws `INVALID_CONFIG`. |
| `deviceId` | string | No | Per-device label — the refresh-token row's key. Keep it stable on one device across launches and different on every device. If omitted, the SDK uses a random `sphere-<uuid>` and every run performs a fresh challenge sign-in. |
| `fetchFn` | function | No | Injectable fetch (defaults to `globalThis.fetch`) |
| `webSocketFactory` | function | No | Injectable WebSocket factory (defaults to `globalThis.WebSocket`; e.g. the `ws` package on Node < 22) |
| `paymentsV2Transport` | function | No | DI seam: supply the whole per-address transport bundle (`{ session, client }`) — offline tests, custom hosts. When set, it is used instead of `baseUrl`. |

To inject the transport without a `baseUrl`, build a `WalletApiTransportConfig` directly: there
`baseUrl` is optional when `paymentsV2Transport` is set, and the seam wins over `baseUrl`.

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import type { WalletApiTransportConfig } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

const base = createNodeProviders({ network: 'testnet2' });
const walletApi: WalletApiTransportConfig = { network: 'testnet2', paymentsV2Transport };
const { sphere } = await Sphere.init({ ...base, walletApi, network: 'testnet2', autoGenerate: true });
```

### Step 3: Initialize the Wallet

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';

const { sphere, created, generatedMnemonic } = await Sphere.init({
  ...providers,  // storage, transport, oracle, walletApi
  network: 'testnet2', // required; must equal walletApi.network
  autoGenerate: true,  // Generate mnemonic if no wallet exists
  nametag: 'alice',    // Optional: register @alice (used only when init creates the wallet)
  password: 'secret',  // Optional: encrypts the stored mnemonic (see below); plaintext if omitted
});

if (created && generatedMnemonic) {
  // First launch — show mnemonic to user for backup
  console.log('Save this mnemonic:', generatedMnemonic);
}

console.log('Address:', sphere.identity?.directAddress);  // DIRECT://... (L3)
```

`Sphere.init` loads the wallet that is already in the storage, if there is one, and then ignores
`mnemonic`, `nametag` and `autoGenerate`. `generatedMnemonic` is returned only by the call that
created the wallet. That call stores the mnemonic before it brings up the providers, so if a
later step fails (for example, the requested nametag is already taken), init throws, the
mnemonic stays in storage, and the next init loads it with `created: false` and no
`generatedMnemonic`. Do not gate the backup prompt on `created` alone: keep your own
"backup confirmed" flag, and until it is set show `sphere.getMnemonic()`.

**The stored mnemonic and `password`.** The wallet keeps its mnemonic (or master key) in the
storage provider: IndexedDB in the browser, the wallet file on Node. If you pass `password` when
the wallet is created or imported, the SDK encrypts that value with CryptoJS's password-based
AES-256-CBC, which derives the key with OpenSSL's `EVP_BytesToKey` (MD5, one iteration). That
keeps the phrase out of casual view and out of copies of the storage that are read without the
password, but it is a fast key derivation: anyone who obtains the stored value can try passwords
offline at high speed, so a short or common password gives little protection. Without a password
the mnemonic is stored as plaintext. The other stored data (derivation path, nametags, payment
journals) is not protected by the password either way. Always set a password for wallets that
hold value, make it long and unique, and protect the storage itself at the operating-system
level (file permissions and disk encryption on servers; the browser profile on clients).
`exportToJSON({ password })` uses the same scheme. There is no call to add or change the password later, and `importFromJSON`
/ `importFromLegacyFile` store the imported seed without a password. Later launches must pass the
same password; for a mnemonic wallet a wrong or missing one fails with `STORAGE_ERROR`
`'Failed to decrypt mnemonic'`.

**Removed init options:** `accounting: true` / `swap: true` **throw** typed `INVALID_CONFIG`
(invoicing and swaps no longer exist in the SDK) — a refusal kept deliberately.
`paymentsV2: true` was a deprecated no-op and is **gone in 0.15.0**; `tokenStorage` / `delivery`
no longer exist.

### Complete Node.js Example

```typescript
// npm install @unicitylabs/sphere-sdk ws
import { Sphere, TokenRegistry, getCoinIdBySymbol } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';

const NETWORK = 'testnet2'; // one literal, used in all three places below

// Step 1: Base providers
const baseProviders = createNodeProviders({
  network: NETWORK,
  dataDir: './wallet-data',
  oracle: { apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590' },
});

// Step 2: Attach the wallet-api transport config
const providers = createWalletApiProviders(baseProviders, {
  baseUrl: 'https://wallet-api.unicity.network',
  network: NETWORK,
  deviceId: 'my-service-host-1', // stable on this machine, unique per machine
});

// Step 3: Initialize wallet
const { sphere, created, generatedMnemonic } = await Sphere.init({
  ...providers,
  network: NETWORK,
  autoGenerate: true,
});

// Step 4: Use payments (sender-driven, certified on-chain, delivered via mailbox).
// coinId is the 64-hex coin id; look it up, symbols are not resolved on the money path.
await TokenRegistry.waitForReady(); // Sphere.init starts the registry load but does not await it
const coinId = getCoinIdBySymbol('UCT'); // string | undefined
if (!coinId) throw new Error('UCT is not in this network\'s token registry');

const result = await sphere.payments.send({
  recipient: '@alice',
  amount: '1000000',
  coinId,
  memo: 'hi',
});

console.log('Status:', result.status);  // 'delivered', or 'confirmed' with deliveryPending: true
console.log('Delivery pending:', result.deliveryPending);  // true = certified on-chain, mailbox deposit deferred (NORMAL)

// Receive tokens (explicit drain; automatic while running)
const { transfers } = await sphere.payments.receive();

// Shut down so the process can exit
await sphere.destroy();
TokenRegistry.destroy(); // stops the process-global registry refresh timer
```

`sphere.destroy()` stops this Sphere's own registry, but `Sphere.init` also configures the
process-wide `TokenRegistry`, whose hourly refresh timer keeps Node's event loop alive. Call
`TokenRegistry.destroy()` after `sphere.destroy()` when the process should exit.

### Messaging-only wallets (`walletApi: 'none'`)

A wallet that only messages (DMs, group chat, nametags) passes `walletApi: 'none'` (the exported
constant `NO_PAYMENTS`). It composes no money: no wallet-api session, no token engine, no
payments state. `network` is still required, because it selects the token registry and the
group-chat relays. `sphere.hasPayments` is then `false`, and `sphere.payments` throws
`PAYMENTS_NOT_COMPOSED`. Leaving `walletApi` out altogether still throws `INVALID_CONFIG`, and so
does any other string.

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

const base = createNodeProviders({ network: 'testnet2' });

const { sphere } = await Sphere.init({
  ...base,
  walletApi: 'none',   // messaging only: no wallet-api session, no token engine, no money
  network: 'testnet2', // still required: it selects the token registry and group-chat relays
  autoGenerate: true,
});

sphere.hasPayments; // false; reading sphere.payments throws PAYMENTS_NOT_COMPOSED
await sphere.communications.sendDM('@alice', 'hello');
```

---

## Custody Model

Token custody is **server-side**: the wallet-api backend holds the token inventory, transfer
intents, delivery mailbox, history and payment requests. The client holds the keys (nothing
money-critical can happen without the wallet's signatures) plus a small per-address durable KV
(`pv2g2:{network}:{chainPubkey}:*` in the plain `StorageProvider`) — refresh token, sync cursors,
receive seen-set, and the intent/delivery/mint journals. The `g2` generation arrived with
0.15.0; see [Upgrading to 0.15.0](#upgrading-to-0150) for why the rename is the migration.

- **Multi-device**: inventory is server-backed, so a second device signs in (challenge → JWT)
  and sees the same funds. `deviceId` keys the per-device refresh-token row.
- **Trust boundary**: the server is *record*, not *authority* — every incoming token is
  verified against the trust base (engine.verify + ownership) BEFORE it enters the balance,
  and every spend is signed client-side.
- **Own-storage custody was rescinded** (spec amendment, wallet-api sdk-changes S7): there is
  no local token store and no `TokenStorageProvider` port. What remains swappable is the
  transport — the `paymentsV2Transport` seam injects a whole custom wire (tests, custom hosts),
  and the `StoragePort`/`DeliveryPort` contracts (`modules/payments-v2/ports.ts`) are
  contract-test-enforced.

---

## Wallet Operations

### Check if Wallet Exists

```typescript
const exists = await Sphere.exists(providers.storage);
```

### Create or Load Wallet (Recommended)

```typescript
// Sphere.init() handles both creation and loading automatically
const { sphere, created, generatedMnemonic } = await Sphere.init({
  ...providers,
  network: 'testnet2',
  autoGenerate: true,  // Generate mnemonic if wallet doesn't exist
  nametag: 'alice',    // Optional: register nametag (only when init creates the wallet)
});

if (created && generatedMnemonic) {
  console.log('Backup these words:', generatedMnemonic);
}
```

`Sphere.init` returns `{ sphere, created, generatedMnemonic? }`. `Sphere.create`, `Sphere.load`
and `Sphere.import` return the `Sphere` instance itself (`Promise<Sphere>`), not `{ sphere }`.

### Import from Mnemonic

`Sphere.init({ ...providers, mnemonic })` is create-or-load, not an import: if a wallet already
exists in the storage it is loaded and `mnemonic` is ignored. To replace the stored wallet with
another phrase, use `Sphere.import`:

```typescript
const sphere = await Sphere.import({
  ...providers,
  network: 'testnet2',
  mnemonic: 'abandon abandon abandon ...',
});
```

`Sphere.import` first clears the storage's current wallet, including the payment journals of
transfers still in flight; do not run it while transfers are pending. For IndexedDB the cleared
unit is the whole database named by `dbName` (every key `prefix` in it), so give each wallet its
own `dbName`.

### Get Identity

```typescript
const identity = sphere.identity; // Identity | null (never includes the private key)
if (!identity) throw new Error('wallet not ready');

console.log('Chain Pubkey:', identity.chainPubkey);   // 33-byte compressed secp256k1
console.log('Direct Address:', identity.directAddress); // DIRECT://... (L3)
console.log('Nametag:', identity.nametag);            // e.g., 'alice'
```

### Clear Wallet

```typescript
await Sphere.clear({ storage: providers.storage });
// Clears the KV store (keys + pv2g2:* payment journals); in the browser it also
// sweeps orphaned pre-flip sphere-token-storage-* databases.
```

This is a wipe, not a maintenance step: it clears the store with no prefix, so the mnemonic goes
with it. It is not the way to migrate the 0.15.0 scoped-KV generation — that needs nothing from
you.

It also **destroys the live Spheres on that backing store** before wiping: each one's payments
vertical stops, its providers disconnect, and every `sphere.on()` handler goes with it. Drop
your references afterwards. The scope is the store the provider addresses, not the provider
object — two provider objects reporting the same
[`backingStoreId`](#storage-provider-interface) share the teardown, and a Sphere on other
storage is never touched. `Sphere.import()` clears first, so it carries the same consequence.

### Multi-Address Derivation

The SDK supports HD (Hierarchical Deterministic) address derivation following BIP32/BIP44 standards.

```typescript
// Derive key material for additional receiving addresses: { privateKey, publicKey, path, index }
const addr1 = sphere.deriveAddress(1);  // m/44'/0'/0'/0/1
const addr2 = sphere.deriveAddress(2);  // m/44'/0'/0'/0/2

// Never log or serialise the whole object: it holds the private key.
console.log('Key 1:', addr1.publicKey, addr1.path);
console.log('Key 2:', addr2.publicKey, addr2.path);

// Derive change addresses
const change0 = sphere.deriveAddress(0, true);  // m/44'/0'/0'/1/0

// Derive at arbitrary path
const custom = sphere.deriveAddressAtPath("m/44'/0'/0'/0/10");

// Get multiple addresses at once
const addresses = sphere.deriveAddresses(5);  // First 5 receiving addresses
const allAddrs = sphere.deriveAddresses(5, true);  // 5 receiving + 5 change

// Check derivation capability
if (sphere.hasMasterKey()) {
  console.log('HD derivation available');
  console.log('Base path:', sphere.getBasePath());
}
```

Each derived address has its own keypair but shares the same master seed:

```typescript
interface AddressInfo {
  privateKey: string;  // Unique per address
  publicKey: string;   // Unique per address
  path: string;        // Full BIP32 path
  index: number;       // Address index
}
```

`deriveAddress(index)` returns key material, not an address. For the `DIRECT://` address use
`sphere.identity?.directAddress` (active address) or
`sphere.getTrackedAddress(index)?.directAddress` (after `switchToAddress(index)`, which tracks the
index).

### Tracked Addresses

The SDK tracks which addresses have been activated (via create, switchToAddress, registerNametag). This lets UI display the list of used addresses with metadata.

```typescript
// Get all active (non-hidden) addresses
const addresses = sphere.getActiveAddresses();
for (const addr of addresses) {
  console.log(`#${addr.index}: ${addr.directAddress}`);
  console.log(`  Nametag: ${addr.nametag ?? 'none'}`);
  console.log(`  Created: ${new Date(addr.createdAt)}`);
}

// Switch to a new address (auto-tracked)
await sphere.switchToAddress(2);

// Register nametag for current address
await sphere.registerNametag('bob');

// Hide an address from UI (only a tracked index; an untracked one throws INVALID_CONFIG)
await sphere.setAddressHidden(2, true);

// Get all including hidden
const all = sphere.getAllTrackedAddresses();

// Get single address
const addr = sphere.getTrackedAddress(0);

// Listen for new address activations
sphere.on('address:activated', ({ address }) => {
  console.log(`New address tracked: #${address.index}`);
});

sphere.on('address:hidden', ({ index, addressId }) => {
  console.log(`Address #${index} hidden`);
});
```

---

## L3 Payments

L3 is the primary payment layer. Transfers are **sender-driven**: the sender's token engine
certifies the transfer on-chain via the gateway and delivers a **finished** token to the
recipient over the wallet-api mailbox — the recipient verifies it and stores it as `'confirmed'` immediately.

### Typical Wallet Flow

```typescript
// 1. Init wallet (walletApi config and network required)
const { sphere } = await Sphere.init({ ...providers, network: 'testnet2', autoGenerate: true, nametag: 'alice' });

// 2. Check what tokens we have
const assets = await sphere.payments.assets();
for (const asset of assets) {
  console.log(`${asset.symbol}: ${asset.totalAmount} (${asset.tokenCount} tokens)`);
}

// 3. Send tokens (coinId is the 64-hex coin id, here taken from a held asset)
const uct = assets.find((a) => a.symbol === 'UCT');
if (!uct) throw new Error('no UCT in this wallet');
const result = await sphere.payments.send({
  recipient: '@bob',
  amount: '1000000',
  coinId: uct.coinId,
});

// 4. Listen for incoming transfers
sphere.on('transfer:incoming', (transfer) => {
  console.log(`Received from ${transfer.senderNametag}: ${transfer.tokens.length} tokens`);
});

// 5. View history (server read-through, paged)
const page = await sphere.payments.history({ limit: 50 });

// 6. Cleanup
await sphere.destroy();
```

There is no `sync()` and no `validate()`: the server is the record (nothing to flush), and
every incoming token is verified before it enters the balance.

### Get Balance & Assets

```typescript
// Aggregated balances by coin, with price data when a PriceProvider is configured
const assets = await sphere.payments.assets();
for (const asset of assets) {
  console.log(`${asset.symbol}: ${asset.totalAmount} (${asset.tokenCount} tokens)`);
  console.log(`  Price: $${asset.priceUsd ?? 'N/A'}`);
  console.log(`  Value: $${asset.fiatValueUsd?.toFixed(2) ?? 'N/A'}`);
  console.log(`  24h change: ${asset.change24h ?? 'N/A'}%`);
}

// Filter to a single coin
const uctAssets = await sphere.payments.assets(coinIdHex);

// Total portfolio value in USD
const totalUsd = assets.reduce((sum, a) => sum + (a.fiatValueUsd ?? 0), 0);
```

The `Asset` shape is unchanged from pre-flip releases: `unconfirmedAmount`/`unconfirmedTokenCount`
are pinned `'0'`/`0` (nothing is ever unconfirmed in server custody);
`transferringAmount`/`transferringTokenCount` still report in-flight sends.

### Get Individual Tokens

```typescript
// All tokens (synchronous inventory view)
const tokens = sphere.payments.tokens();

for (const token of tokens) {
  console.log(`Token ${token.id}: ${token.amount} ${token.symbol}`);
  console.log(`  Coin ID: ${token.coinId}`);
}

// Filter by coin
const uctTokens = sphere.payments.tokens({ coinId: coinIdHex });
```

### Get Coinless Tokens (NFTs)

A token whose genesis data carries no value envelope names no coin. These are a **separate,
disjoint read** — never returned by `tokens()`, and contributing to no balance:

```typescript
const nfts = sphere.payments.coinless();

for (const nft of nfts) {
  console.log(`Token ${nft.tokenId}`);
  // The CLASS of token, not its identity — every token of one kind shares a type.
  console.log(`  Type: ${nft.tokenType ?? '(unrecorded)'}`);
}

// The payload — an NFT's actual content. A call, not a field: it is unbounded
// and the blob is fetched on demand.
const bytes = await sphere.payments.tokenData(nfts[0].tokenId);
```

Lazy tokens (blob not yet downloaded) carry value metadata only; the blob is fetched on demand
when the token is selected for a spend.

### Send Tokens

```typescript
import { TokenRegistry, getCoinIdBySymbol } from '@unicitylabs/sphere-sdk';

// coinId is the 64-hex coin id. send() does not resolve symbols.
await TokenRegistry.waitForReady(); // Sphere.init starts the registry load but does not await it
const coinId = getCoinIdBySymbol('UCT'); // string | undefined
if (!coinId) throw new Error('UCT is not in this network\'s token registry');

// Send to nametag (resolved via Nostr)
const toNametag = await sphere.payments.send({
  recipient: '@alice',
  amount: '1000000',
  coinId,
  memo: 'Payment for coffee',
});

// Send to DIRECT address
const toAddress = await sphere.payments.send({
  recipient: 'DIRECT://0000be36...',
  amount: '500000',
  coinId,
});

// Send to chain pubkey (33-byte compressed secp256k1)
const toPubkey = await sphere.payments.send({
  recipient: '02abc123...',
  amount: '500000',
  coinId,
});

// A resolved send() means sent; a failure throws (see Error Handling).
console.log('Transfer ID:', toNametag.id);
console.log('Status:', toNametag.status);  // 'delivered', or 'confirmed' with deliveryPending: true
console.log('Delivery pending:', toNametag.deliveryPending);  // true means on-chain but recipient mailbox deposit deferred
```

`send()` resolves only when the payment is sent. `result.status` is `'delivered'` when it landed
in the recipient's mailbox, or `'confirmed'` with `result.deliveryPending === true` when the
transfer is certified and delivery is still being retried. That is success, not an error.
`send()` never resolves with `'completed'` or `'failed'`, and it never sets `result.error`: a
failure throws. Of the other `TransferStatus` values, `'submitted'` (progress) and `'failed'` (a
clean failure) appear only on the `transfer:updated` event, and `'completed'` is never produced.

**SendRequest fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `recipient` | Yes | `@nametag`, `DIRECT://...`, or chain pubkey |
| `amount` | Yes | Amount in smallest unit (string) |
| `coinId` | Yes | The 64-character hex coin id. Symbols are **not** resolved on the money path: `coinId: 'UCT'` matches no coin, so `send()` fails with `SEND_INSUFFICIENT_BALANCE`. Look it up with `getCoinIdBySymbol()` (after `await TokenRegistry.waitForReady()`; it returns `undefined` for an unknown symbol), or take `coinId` from `sphere.payments.assets()` for a coin the wallet holds. |
| `memo` | No | Optional message (recipient-encrypted envelope) |

The recipient must have a **published chain pubkey** (Nostr identity binding) — otherwise
`send()` throws `INVALID_RECIPIENT`. The token engine must be available (oracle with a v2
trust base + gateway URL) — otherwise `Sphere.init` already fails with `INVALID_CONFIG` when it
starts the payments vertical.

Nametag bindings do not carry a network yet, so the SDK cannot prove that a `@nametag` or
`DIRECT://` recipient uses your network. Every such send emits `transfer:attention` with
`code: 'recipient:network-unverified'` and an empty `transferId`, and then proceeds on your
network. Treat it as information, not an error; on mainnet, make sure the recipient runs mainnet.
A bare 66-hex chain pubkey recipient is taken as being on your network.

### Receive Tokens

Incoming tokens arrive automatically via the wallet-api mailbox while the wallet runs.
Subscribe to the event:

```typescript
sphere.on('transfer:incoming', (transfer) => {
  console.log('Sender:', transfer.senderPubkey);
  console.log('Sender nametag:', transfer.senderNametag);
  console.log('Tokens:', transfer.tokens.length);
  console.log('Received at:', new Date(transfer.receivedAt));
});
```

For batch/CLI applications that need explicit receive (one-shot drain):

```typescript
const { transfers } = await sphere.payments.receive();
console.log(`Received ${transfers.length} transfers`);
```

Every incoming token is engine-verified against the trust base and ownership-checked BEFORE it
enters the balance; dedup is per (tokenId, stateHash): a durable seen-set of content-derived
delivery ids (SHA-256 of tokenId and stateHash, recorded after the ack succeeds), plus a check
against the state the wallet already holds, so a token re-received at a new state is accepted;
tokens are stored before the mailbox claim is acknowledged (a crash re-claims, never loses).

### Transaction History

Server read-through, paged, newest-first:

```typescript
const page = await sphere.payments.history({ limit: 50 });

for (const entry of page.entries) {
  console.log(`${entry.type}: ${entry.amount} ${entry.coinId}`);
  console.log(`  Date: ${new Date(entry.timestamp)}`);
  if (entry.recipientNametag) {
    console.log(`  To: @${entry.recipientNametag}`);
  }
}

if (page.more) {
  const older = await sphere.payments.history({ before: page.cursor!, limit: 50 });
}
```

### Peer Resolution

```typescript
// Resolve any identifier to PeerInfo (nametag, address, pubkey)
const peer = await sphere.resolve('@alice');
if (peer) {
  console.log('Chain pubkey:', peer.chainPubkey);
  console.log('Direct address:', peer.directAddress);
  console.log('Nametag:', peer.nametag);
}
```

### Price Provider (Optional)

```typescript
import { createPriceProvider } from '@unicitylabs/sphere-sdk';

// Set or replace PriceProvider at runtime
sphere.setPriceProvider(createPriceProvider({
  platform: 'coingecko',
  apiKey: userProvidedKey,  // Optional for free tier
  baseUrl: '/api/coingecko',  // CORS proxy for browser (see below)
}));
```

Without a PriceProvider, the price fields in `assets()` are `null`. All other functionality works normally.

**CORS Proxy (Browser only):** CoinGecko's free API lacks CORS headers. Add a proxy in development:

```typescript
// vite.config.ts
export default defineConfig({
  server: {
    proxy: {
      '/api/coingecko': {
        target: 'https://api.coingecko.com/api/v3',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/coingecko/, ''),
      },
    },
  },
});
```

Then pass `baseUrl: '/api/coingecko'` in the `price` config. In production, use Nginx or a Cloudflare Worker as a reverse proxy. CoinGecko Pro API supports CORS natively and doesn't require a proxy.

Node.js environments are not subject to CORS — no proxy needed.

---

## How Transfers Work (Sender-Driven)

When you call `send()`, the transfer runs as a durable server-side intent:

1. **Intent first** — the transfer intent is recorded on the wallet-api server BEFORE any
   chain op (crash-safe by construction).
2. **Engine spends** the source token (or splits it when the exact amount is unavailable);
   a split posts a signed, field-encrypted progress checkpoint of its burn.
3. **Certification** — submitted to the gateway; the inclusion proof finishes the token.
4. **Mailbox deposit** — the finished token blob is deposited into the recipient's wallet-api
   mailbox, and the intent is closed with a signed complete. The blob is the base SDK's own
   `Token.toCBOR()` bytes with no sphere-private envelope around them — the same form on the
   wire, in the mailbox and in server storage.

The recipient verifies it (`engine.verify` + ownership check) and stores it as `'confirmed'` —
there is no receiver-side commitment submission, proof polling, or finalization phase.

**Money safety:**

- A crash at ANY stage resumes the SAME `transferId` when the vertical starts — never a second
  spend. A possibly-committed outcome (any error for which `isPossiblyCommittedSendOutcome(err)`
  is true, such as `CERTIFICATION_UNCONFIRMED` or `SEND_SYNC_PENDING`) keeps the intent OPEN;
  **never re-issue `send()`** for it (a fresh transferId on a different source double-pays).
  The retry verb is `sphere.payments.resumeNow()` (see [Send Error Handling](#send-error-handling)).
- A certified-but-undelivered blob is journaled locally (#621) and re-deposited with a bounded
  poison budget (#517); `deliveryPending: true` on the result is **normal, not a failure** —
  the token is safe on-chain and will be delivered asynchronously.
- A clean conflict (`TransferConflictError`) demotes the stale source (`suspectedSpent` —
  excluded from selection, recoverable by resync) and re-plans, up to 8 times (`MAX_RESELECT`);
  a whole-token send is not re-planned.
- For splits, your change token is minted by the same on-chain operation and is immediately
  spendable (no placeholder, no background proof step).

---

## Payment Requests

Payment requests ride the wallet-api rail (`sphere.payments.requests`); the memo travels in a
recipient-ECDH encrypted envelope.

### Send Payment Request

`create()` never throws: it resolves `{ success, requestId?, error? }`, so check `success`.
`coinId` is the 64-hex coin id: a request created with `coinId: 'UCT'` is accepted and stored
verbatim, but it can never be paid (the payer's `send()` matches no coin).

```typescript
import { TokenRegistry, getCoinIdBySymbol } from '@unicitylabs/sphere-sdk';

await TokenRegistry.waitForReady();
const coinId = getCoinIdBySymbol('UCT'); // string | undefined
if (coinId) {
  const result = await sphere.payments.requests.create('@bob', {
    coinId,
    amount: '1000000',
    memo: 'Payment for order #1234',
  });

  if (result.success) {
    console.log('Request sent, ID:', result.requestId);
  } else {
    console.error('Request failed:', result.error);
  }
}
```

### Track Status

The SDK tracks only requests you **received**: `list()` and `payment_request:updated` cover
those. It does not track requests you created, so a requester detects payment through
`transfer:incoming` or `sphere.payments.history()`.

```typescript
// Payer side: status changes of a request you received
sphere.on('payment_request:updated', ({ id, status }) => {
  // 'pending' | 'settling' | 'paid' | 'rejected' | 'expired'
  console.log(`request ${id} is now ${status}`);
});

// Requester side: watch incoming transfers instead
sphere.on('transfer:incoming', (transfer) => {
  console.log('received from', transfer.senderNametag ?? transfer.senderPubkey);
});
```

### Handle Incoming Requests

Never pay from inside the `payment_request:incoming` handler without the user's decision;
`pay()` and `decline()` are alternatives. `pay()` rethrows `send()`'s errors: handle them as in
[Send Error Handling](#send-error-handling).

```typescript
sphere.on('payment_request:incoming', async (request) => {
  // PaymentRequestView: { id, requestId, senderPubkey, senderNametag?, amount,
  //                       coinId, symbol?, message?, timestamp, status }
  // request.amount is a base-unit string and request.coinId the hex coin id; request.symbol is not set here.
  try {
    if (await askUser(request)) {
      await sphere.payments.requests.pay(request.id);
    } else {
      // A server 403/409 propagates (a refused decline is not success)
      await sphere.payments.requests.decline(request.id);
    }
  } catch (err) {
    console.error('payment request failed', err); // pay() rethrows send() errors: handle them like send()
  }
});

// Current views of the requests you received
const requests = sphere.payments.requests.list();

// Drop terminal entries from list()
sphere.payments.requests.dismissProcessed();
```

`pay()` never leaves a request payable after a possibly-committed failure: before it rethrows
such an error it durably links the request to the transfer and marks it `'settling'`, and a
second `pay()` of the same id in the same process joins the first. That link is written after
the send returns or throws, not before it starts. If the app or process stops while `pay()` is
still waiting on the send, no link exists: on the next start the request is listed as
`'pending'` again and `payment_request:incoming` fires again, even if the transfer went through
(a transfer the SDK had already recorded is resumed when the wallet starts). Before paying a
request again after a restart, check `sphere.payments.pendingTransfers()` and
`sphere.payments.history()` for a transfer to that requester.

---

## Communications

### Send Direct Message

```typescript
const message = await sphere.communications.sendDM('@bob', 'Hello!');
console.log('Message ID:', message.id);
```

### Get Conversations

```typescript
const conversations = sphere.communications.getConversations();

for (const [peer, messages] of conversations) {
  console.log(`Conversation with ${peer}: ${messages.length} messages`);
}
```

### Subscribe to Messages

```typescript
// Direct messages
sphere.communications.onDirectMessage((message) => {
  console.log(`${message.senderNametag}: ${message.content}`);
});

// Broadcasts
sphere.communications.subscribeToBroadcasts(['news', 'updates']);
sphere.communications.onBroadcast((broadcast) => {
  console.log(`[${broadcast.tags}] ${broadcast.content}`);
});
```

### Publish Broadcast

```typescript
await sphere.communications.broadcast('Hello world!', ['general']);
```

---

## Custom Providers

> **Money ports:** token custody is the wallet-api backend — there is no TokenStorageProvider
> to implement. The swappable money surface is (a) the `paymentsV2Transport` seam in the
> `walletApi` config (inject a whole per-address transport bundle `{ session, client }`), and
> (b) the `StoragePort` / `DeliveryPort` contracts in `modules/payments-v2/ports.ts`, enforced
> by the conformance suites under `tests/unit/payments-v2/contracts/`.

### Storage Provider Interface

The default browser implementation is `IndexedDBStorageProvider` (database: `sphere-storage`, object store: `kv`). For Node.js, `FileStorageProvider` is used. Both support per-address key scoping via `setIdentity()`.

All three provider ports extend `BaseProvider`, so every custom provider also declares its
metadata (`id`, `name`, `type`) and the connection lifecycle:

```typescript
interface BaseProvider {
  readonly id: string;
  readonly name: string;
  readonly type: 'local' | 'cloud' | 'p2p' | 'network';
  readonly description?: string;

  connect(config?: unknown): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  getStatus(): ProviderStatus;
}
```

```typescript
interface StorageProvider extends BaseProvider {
  /**
   * Stable identity of the BACKING STORE this provider addresses — not of this
   * object, and not of the class. Optional, but supply it if two provider objects
   * can address one store: two instances returning the same value share erasure,
   * so `Sphere.clear()` (and `Sphere.import()`, which clears first) tears down the
   * live Spheres of both. Compose it from everything that selects the store (file
   * path, database name, key prefix) behind a scheme prefix, so two kinds of store
   * can never collide on one string. It must not change over the provider's
   * lifetime — it is read again on teardown. Omitted, liveness falls back to
   * per-object identity, i.e. a second provider over the same data is treated as
   * unrelated.
   */
  readonly backingStoreId?: string;

  setIdentity(identity: FullIdentity): void;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  keys(prefix?: string): Promise<string[]>;
  clear(prefix?: string): Promise<void>;

  // Tracked addresses registry.
  // saveTrackedAddresses MUST MERGE, NEVER REPLACE — see the write contract below.
  // A replacing implementation silently loses addresses.
  saveTrackedAddresses(entries: TrackedAddressEntry[]): Promise<void>;
  loadTrackedAddresses(): Promise<TrackedAddressEntry[]>;
}
```

#### The tracked-address write contract

`saveTrackedAddresses` **must merge, never replace.** `entries` is one writer's snapshot, not
the whole truth: every Sphere sharing this storage keeps its own copy of the registry and
persists all of it. Writing the argument verbatim is a lost update — A activates index 1, B
(whose snapshot predates that) activates index 2, and B's write erases index 1 while A still
reports it. This happens on a single network with a single provider, and it is the #766
data-loss bug; do **not** try to fix it by renaming or network-scoping the key.

The contract — `storage/tracked-addresses.ts` is the in-repo reference implementation:

- read the stored registry and **union it with `entries` by `index`**;
- on a conflicting index, the entry with the greater `updatedAt` supplies `hidden` (ties keep
  the incoming entry), and `createdAt` keeps the **earlier** value;
- **serialize concurrent calls**, so one call's read cannot interleave with another's write.
  Per provider instance is the floor; because `backingStoreId` explicitly permits several
  provider objects over one store, serialize per backing store wherever the platform allows
  it (see below);
- a failed write must **not brick later writes**, and must still reject to its own caller.

A union is safe because there is no delete path: entries are only ever added, and wiping the
wallet removes the key itself (`Sphere.clear()`). Adding a per-entry delete would require
revisiting this contract.

`index` must be a **uint32** — an integer in `0` … `0xffffffff`, because it is a BIP32 child
number. An `entries` row that is not one must make the **write reject** (the reference
`mergeTrackedAddresses` throws a `VALIDATION_ERROR` `SphereError`): dropping it silently would
report a save that never happened, and the row would derive another address's keys. Rows already
**stored** are **dropped on read** instead, not repaired (see
[`TrackedAddressEntry`](./API.md#trackedaddressentry)), so one bad row cannot brick every later
write. `loadTrackedAddresses` is otherwise tolerant: unusable or corrupt storage must read as
`[]`, never throw.

If your platform runs the merge inside a transaction whose abort replaces the failure reason —
IndexedDB does — validate the argument before opening it, or callers see a generic abort instead
of the reason.

```typescript
import type { StorageProvider, TrackedAddressEntry } from '@unicitylabs/sphere-sdk';

/** Tolerant read: unusable JSON and a wrong top-level shape both read as absent. */
export function parseRegistry(raw: string | null): TrackedAddressEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const rows = (parsed as { addresses?: unknown } | null)?.addresses;
  if (!Array.isArray(rows)) return [];

  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return rows.flatMap((row) => {
    const e = (row ?? {}) as Record<string, unknown>;
    const index = e.index;
    // Repair the timestamps, but DROP an underivable index: it would alias a real address.
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 0xffffffff) {
      return [];
    }
    return [{
      ...e,
      index,
      hidden: e.hidden === true,
      createdAt: num(e.createdAt),
      updatedAt: num(e.updatedAt),
    } as TrackedAddressEntry];
  });
}

/** One write chain per BACKING STORE, so two provider objects over one store cannot interleave. */
const trackedWrites = new Map<string, Promise<unknown>>();

export async function saveTrackedAddressesMerging(
  kv: Pick<StorageProvider, 'get' | 'set'>,
  storeId: string,
  entries: readonly TrackedAddressEntry[],
): Promise<void> {
  const run = (trackedWrites.get(storeId) ?? Promise.resolve()).then(async () => {
    const merged = new Map<number, TrackedAddressEntry>();
    for (const e of parseRegistry(await kv.get('tracked_addresses'))) {
      merged.set(e.index, e);
    }
    for (const e of entries) {
      // Refuse the WRITE: a dropped row here would report a save that never happened.
      if (!Number.isInteger(e.index) || e.index < 0 || e.index > 0xffffffff) {
        throw new Error(`tracked address index ${e.index} is not a BIP32 child number`);
      }
      const existing = merged.get(e.index);
      if (!existing) {
        merged.set(e.index, e);
        continue;
      }
      const winner = e.updatedAt >= existing.updatedAt ? e : existing; // ties keep the incoming entry
      merged.set(e.index, {
        ...existing,
        ...winner,
        index: e.index,
        createdAt: Math.min(existing.createdAt, e.createdAt),
      });
    }
    const addresses = [...merged.values()].sort((a, b) => a.index - b.index);
    await kv.set('tracked_addresses', JSON.stringify({ version: 1, addresses }));
  });
  // The chain tail swallows the rejection so one failed write cannot brick every later
  // one; the caller still sees the error by awaiting `run`.
  trackedWrites.set(storeId, run.then(() => undefined, () => undefined));
  await run;
}
```

The provider then delegates, and reads through the same tolerant parse:

```typescript
// inside your StorageProvider class
readonly backingStoreId: string;

constructor(private readonly path: string) {
  // Assign it here, after `path` exists. A field initializer that reads `this.path` runs
  // before the constructor body and would give every instance 'mystore:undefined', i.e.
  // one shared id, so Sphere.clear() on one store would tear down the Spheres of all of them.
  this.backingStoreId = `mystore:${path}`;
}

async saveTrackedAddresses(entries: TrackedAddressEntry[]): Promise<void> {
  await saveTrackedAddressesMerging(this, this.backingStoreId, entries);
}

async loadTrackedAddresses(): Promise<TrackedAddressEntry[]> {
  return parseRegistry(await this.get('tracked_addresses'));
}
```

A module-level chain covers several provider objects in **one JS realm** and nothing more. Where
the platform offers a real transaction, use it instead: `IndexedDBStorageProvider` does the whole
read-merge-write in one `readwrite` transaction, which IndexedDB orders across every connection
and every tab.

Conformance is enforced by `tests/unit/storage/contracts/tracked-addresses.contract.ts` —
run a custom provider through its `describeTrackedAddressesContract()` suite, the same one the
three bundled providers are held to. The suite lives in this repository's `tests/` tree, which
is not part of the npm package (it ships only `dist`, `README.md` and `LICENSE`), so clone the
repository to run it.

### Transport Provider Interface

```typescript
interface TransportProvider extends BaseProvider {
  setIdentity(identity: FullIdentity): void | Promise<void>;
  sendMessage(recipientPubkey: string, content: string): Promise<string>;
  onMessage(callback: (msg: IncomingMessage) => void): () => void;

  // Peer resolution (optional)
  resolve?(identifier: string): Promise<PeerInfo | null>;
  resolveNametagInfo?(nametag: string): Promise<PeerInfo | null>;
  resolveAddressInfo?(address: string): Promise<PeerInfo | null>;

  // Identity binding (optional)
  publishIdentityBinding?(chainPubkey: string, directAddress: string, nametag?: string): Promise<boolean>;

  // Broadcast (optional)
  publishBroadcast?(content: string, tags?: string[]): Promise<string>;
  subscribeToBroadcast?(tags: string[], callback: (b: IncomingBroadcast) => void): () => void;

  // ...plus further optional members (read receipts, typing indicators, relay management,
  // address discovery): see transport/transport-provider.ts
}
```

### Oracle Provider Interface

Post v1-cutover the oracle is a thin **network-config provider** for the token engine: it
loads the root trust base (JSON) and exposes the gateway URL + API key. The engine builds its
own clients from these — custom implementations MUST provide the three config accessors.

```typescript
interface OracleProvider extends BaseProvider {
  /** Loads the trust base JSON (via the platform loader when not passed explicitly). */
  initialize(trustBaseJson?: unknown): Promise<void>;

  // Token-engine config surface (REQUIRED)
  getTrustBaseJson(): unknown | null;   // raw trust-base JSON (networkId comes from it)
  getAggregatorUrl(): string;           // gateway (aggregator) base URL
  getApiKey(): string | undefined;      // gateway API key, when required (e.g. testnet2)

  // Optional: swap the key on a live provider (Sphere.setOracleApiKey() also rebuilds the engine)
  setApiKey?(apiKey: string): void;
}
```

---

## Events

### Available Events

```typescript
// The 8 payments-vertical events
sphere.on('transfer:incoming', (transfer) => { });        // IncomingTransfer
sphere.on('transfer:updated', (result) => { });           // TransferResult — read status/deliveryPending
sphere.on('transfer:attention', ({ transferId, code, detail }) => { });  // see the code table below
sphere.on('inventory:updated', () => { });
sphere.on('history:updated', () => { });
sphere.on('payment_request:incoming', (view) => { });     // PaymentRequestView
sphere.on('payment_request:updated', ({ id, status }) => { });
sphere.on('connection:status', ({ status }) => { });      // 'connected' | 'degraded' | 'offline'

// Message events
sphere.on('message:dm', (message) => { });
sphere.on('message:broadcast', (broadcast) => { });

// Connection events
sphere.on('connection:changed', ({ provider, connected }) => { });
sphere.on('nametag:registered', ({ nametag, addressIndex }) => { });
sphere.on('nametag:recovered', ({ nametag }) => { });   // later recoveries only (see below)

// Identity events
sphere.on('identity:changed', ({ directAddress, chainPubkey, nametag, addressIndex }) => { });

// Address tracking events
sphere.on('address:activated', ({ address }) => { });  // New address tracked
sphere.on('address:hidden', ({ index, addressId }) => { });
sphere.on('address:unhidden', ({ index, addressId }) => { });
```

Event handlers receive the payload directly (`(e) => e.addressIndex`, not `e.data.addressIndex`),
and `on()` returns its own unsubscribe function.

`transfer:attention` codes (the `code` field):

| Code | Meaning |
|------|---------|
| `recipient:network-unverified` | Informational, emitted with an empty `transferId` on every send to a `@nametag` or `DIRECT://` recipient: bindings do not carry a network yet, so the recipient's network cannot be checked (see [Send Tokens](#send-tokens)). |
| `delivery:deferred` | The token is certified, but the mailbox deposit was rate-limited; it is deferred and retried. |
| `delivery:undeliverable` | The mailbox deposit failed on every attempt of its retry budget. |
| `split:checkpoint-stuck` | Resuming a split failed on its burn checkpoint (`detail` names `SPLIT_CHECKPOINT_LOST` or `CHECKPOINT_TRUSTBASE_MISMATCH`). |
| `sync:pending` | The spend committed on-chain, but applying it to the wallet-api mirror failed; resume converges it. |
| `mint:unresolved` | A journaled mint cannot be replayed safely and is held (`transferId` is the mint id). |
| `intent:reseed-rejected` | After a backend restore, re-submitting an open intent was refused (`detail` has the reason). |
| `claim:conflict` | A mailbox claim conflicted on the server and the entry was rejected as stale (`detail` is the delivery id). |

The pre-flip names are gone from the public event map. dApps on the Connect wire still receive
these through the ConnectHost compat adapter: `transfer:confirmed`,
`transfer:delivery_pending`, `transfer:failed`, `payment_request:incoming` (in the legacy
shape), `payment_request:paid`, `payment_request:rejected`, `payment_request:expired`,
`split:checkpoint-stuck`, `delivery:undeliverable`, `delivery:deferred`, `realtime:status`,
`storage:degraded`, `sync:completed` and `sync:remote-update` (see
[CONNECT.md](CONNECT.md#compatibility-the-old-wire-contract-on-a-v2-host)). Any other pre-flip
name, such as `sync:started` or `sync:error`, falls through to `sphere.on()` and never fires.
The `invoice:*` and `swap:*` names are **not** among the adapted ones: the accounting and
swap modules were deleted and the compat adapter never re-emitted those events, so nothing
delivers them on any surface.

Nametag recovery during `Sphere.init` / `load` / `import` finishes, and emits
`nametag:recovered`, before the call returns, so a listener added afterwards does not see it.
Check `sphere.identity?.nametag` after init. The event is useful for later recoveries, such as
after `switchToAddress()`.

### Unsubscribe

```typescript
const unsubscribe = sphere.on('transfer:incoming', handler);

// Later...
unsubscribe();
```

---

## Nametags (Unicity IDs)

Nametags provide human-readable addresses (e.g., `@alice`) for receiving tokens. A nametag is a
**Nostr identity binding** (name ↔ chainPubkey) — receive is always locked to your chain pubkey;
there is no PROXY address scheme.

### Registration Flow

```typescript
// Register during wallet creation (nametag is used only when init creates the wallet)
const { sphere } = await Sphere.init({
  ...providers,
  network: 'testnet2',
  autoGenerate: true,
  nametag: 'alice',
});

// Or register after wallet is created
await sphere.registerNametag('alice');

// Check availability first (no binding resolves for the name)
const available = await sphere.isNametagAvailable('alice');
```

Registering a nametag publishes a Nostr identity binding (name to chain pubkey). No token is
minted; the binding is the only registration record.

### Multi-Address Nametags

Each derived address can have its own nametag:

```typescript
// Register @alice for address 0
await sphere.registerNametag('alice');

// Switch to address 1 and register @bob
await sphere.switchToAddress(1);
await sphere.registerNametag('bob');

// Query nametags by HD index (the index must be tracked)
sphere.getTrackedAddress(0)?.nametag;  // 'alice'
sphere.getTrackedAddress(1)?.nametag;  // 'bob'

// Or by the short addressId ('DIRECT_xxxxxx_yyyyyy'), not an index and not a DIRECT:// string
const addr1 = sphere.getTrackedAddress(1);
sphere.getNametagForAddress(addr1?.addressId);  // 'bob'

// Every active address with its nametag
sphere.getActiveAddresses().map((a) => [a.index, a.nametag]);  // [[0, 'alice'], [1, 'bob']]
```

`getAllAddressNametags()` is deprecated; it returns `Map<addressId, Map<nametagIndex, nametag>>`,
keyed by the short addressId, not by HD index.

### Troubleshooting: "Nametag already taken"

**Error** (a `SphereError` with `code: 'VALIDATION_ERROR'`):
```
Failed to register Unicity ID. It may already be taken.
```

With Nostr debug logging on (`logger.setTagDebug('Nostr', true)`), the transport also logs:
```
[Nostr] Unicity ID already taken: myname
```

**Cause:** The nametag is registered to a different public key. This happens when:

1. **Storage cleared or inaccessible** → `Sphere.exists()` returns `false` → new wallet created
2. **Different mnemonic provided** on subsequent runs

**Note:** `autoGenerate: true` does NOT generate new mnemonic every restart. It only generates if `Sphere.exists()` returns `false`.

**Solution:**

Use persistent file storage (recommended for a backend). `createNodeProviders` writes the
wallet file under `dataDir`, so the same wallet is loaded on every run:

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders, createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

const providers = createWalletApiProviders(
  createNodeProviders({
    network: 'testnet2',
    dataDir: './wallet-data',  // the wallet file (and its mnemonic) persists here
    oracle: { apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590' },
  }),
  { baseUrl: 'https://wallet-api.unicity.network', network: 'testnet2', deviceId: 'my-service-host-1' },
);

const { sphere } = await Sphere.init({
  ...providers,
  network: 'testnet2',
  autoGenerate: true,
  nametag: 'myservice',
});
```

Or use a fixed mnemonic from the environment (with the same `providers`; the mnemonic is used
only when the storage holds no wallet yet):

```typescript
const { sphere } = await Sphere.init({
  ...providers,
  network: 'testnet2',
  mnemonic: process.env.WALLET_MNEMONIC,
  nametag: 'myservice',
});
```

**Debug storage issues:**
```typescript
const exists = await Sphere.exists(providers.storage);
console.log('Wallet exists:', exists);  // Should be true after first run

// Enable debug logs. The browser IndexedDB provider logs under 'IndexedDB';
// the Node file provider has no log tag of its own, so turn on everything there.
logger.setTagDebug('IndexedDB', true);
logger.configure({ debug: true });
```

### Nametag Sync on Load

When loading an existing wallet, the SDK automatically syncs the identity binding with Nostr:

```typescript
// On Sphere.load() (and Sphere.init() on an existing wallet):
// 1. Looks up the binding published under this wallet's key
// 2. If one exists: recovers a nametag missing locally (emits 'nametag:recovered'), and
//    re-publishes only if the binding lacks the address, the pubkey or the local nametag
// 3. If none exists: publishes one, and logs a warning if the nametag is taken by another pubkey
// A failure here is logged and never fails the load.
```

### Nametag Recovery on Import

When importing a wallet without specifying a nametag, the SDK automatically attempts to recover it from Nostr:

```typescript
// Import wallet - nametag will be recovered if found on Nostr
const sphere = await Sphere.import({
  ...providers,
  network: 'testnet2',
  mnemonic: 'your twelve words...',
  // No nametag specified
});

// Recovery has already finished (and emitted 'nametag:recovered') when import returns,
// so read the result instead of listening for the event:
if (sphere.identity?.nametag) {
  console.log('Nametag recovered:', sphere.identity.nametag);
}
```

The recovery process (it runs before `Sphere.import` / `Sphere.init` returns):
1. Derives transport pubkey from wallet keys
2. Queries Nostr for nametag events owned by this pubkey
3. If found, sets the nametag locally and emits `nametag:recovered` event

---

## Error Handling

### Send Error Handling

`send()` resolves only when the payment is sent. `result.status` is `'delivered'` when it landed
in the recipient's mailbox, or `'confirmed'` with `result.deliveryPending === true` when the
transfer is certified and delivery is still being retried. That is success, not an error.
`send()` never resolves with `'completed'` or `'failed'`: a failure throws, so wrap it in
`try`/`catch`.

Some rejections mean the money may already have left the wallet.
`isPossiblyCommittedSendOutcome(err)` is `true` for exactly these codes: `SEND_SYNC_PENDING`,
`CERTIFICATION_UNCONFIRMED`, `CHECKPOINT_PERSIST_FAILED`, `SPLIT_CHECKPOINT_LOST`,
`CHECKPOINT_TRUSTBASE_MISMATCH` and `SEND_PARTIALLY_COMPLETED`. Never call `send()` again for
that payment: a new `send()` gets a new transfer id and pays the recipient a second time. The SDK
finishes the original under its own transfer id; show it as pending
(`sphere.payments.pendingTransfers()`), and wire any "retry" button to
`sphere.payments.resumeNow()`. A `PartialSendConflictError` means part of the amount was
delivered and is final; only `err.remainingAmount` is still owed. When
`isPossiblyCommittedSendOutcome(err)` is `false`, the SDK's contract is that nothing left the
wallet.

```typescript
// Import the error helpers from the same entry point as Sphere (here: the package root).
import { Sphere, PartialSendConflictError, isPossiblyCommittedSendOutcome } from '@unicitylabs/sphere-sdk';

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

Clean failures you can branch on: `SEND_INSUFFICIENT_BALANCE` (not enough spendable funds; its
message names funds pinned by transfers still converging), `INVALID_RECIPIENT` (no published
chain pubkey, or a recipient on another network), `TRANSPORT_ERROR` (the recipient lookup could
not reach the Nostr relays) and `VALIDATION_ERROR` (for example a malformed amount).
`INSUFFICIENT_BALANCE` exists in the `SphereErrorCode` union but is never thrown.

### Verification Is Built In

There is no `validate()` to call: every incoming token is engine-verified against the trust
base and ownership-checked BEFORE it enters the balance, and a stale source discovered during
a send is demoted (`suspectedSpent`) and excluded from selection automatically.

```typescript
// Subscribe to transfer lifecycle events
sphere.on('transfer:updated', (transfer) => {
  console.log('Transfer update:', transfer.id, transfer.status);
});

sphere.on('transfer:attention', ({ transferId, code }) => {
  // Informational, on every @nametag / DIRECT:// send (empty transferId): not a problem.
  if (code === 'recipient:network-unverified') return;
  console.warn('Transfer needs attention:', transferId, code);
});
```

### Typed Error Handling

SDK methods throw `SphereError` with a typed `.code` field. `isSphereError()` is an `instanceof`
check, and each bundle of the package (the root, `./core`, `./impl/browser`, `./impl/nodejs`)
carries its own copy of the `SphereError` class. An error thrown inside a provider built by
`createBrowserProviders` / `createNodeProviders` (for example the Nostr transport's
`TRANSPORT_ERROR`) therefore fails `isSphereError()` imported from the root. Read `code`
structurally when an error can come from a provider, and import `isPossiblyCommittedSendOutcome`
/ `PartialSendConflictError` from the same entry point as `Sphere`.

```typescript
try {
  await sphere.registerNametag('alice');
} catch (err) {
  // Structural read: works whichever bundle's SphereError class was thrown.
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'VALIDATION_ERROR') showError('Invalid or already taken');
  else if (code === 'ALREADY_INITIALIZED') showError('This address already has a Unicity ID');
  else throw err;
}
```

### Debug Logging

Enable the centralized logger to diagnose issues:

```typescript
import { logger } from '@unicitylabs/sphere-sdk';

logger.configure({ debug: true });

// Or enable specific modules:
logger.setTagDebug('PaymentsV2', true);  // the payments vertical
logger.setTagDebug('Nostr', true);       // the Nostr transport
```

---

## Best Practices

### 1. Always Handle Wallet State

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createBrowserProviders } from '@unicitylabs/sphere-sdk/impl/browser'; // untyped entry: add the declaration shim
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';

// One network literal, used in all three places below.
const NETWORK = 'testnet2';

// A per-device id: stable across launches on this device, different on every device.
function deviceId(): string {
  let id = localStorage.getItem('sphere-device-id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('sphere-device-id', id);
  }
  return id;
}

async function initApp() {
  const baseProviders = createBrowserProviders({
    network: NETWORK,
    oracle: { apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590' }, // public testnet2 gateway key
  });
  const providers = createWalletApiProviders(baseProviders, {
    baseUrl: 'https://wallet-api.unicity.network', // testnet2 wallet-api
    network: NETWORK,
    deviceId: deviceId(),
  });

  // Sphere.init() handles both creation and loading
  const { sphere } = await Sphere.init({
    ...providers,
    network: NETWORK,
    autoGenerate: true,
  });

  // Gate the backup prompt on your own flag, not on `created`: a first init that fails after
  // storing the mnemonic leaves it in storage, and the retry returns created: false.
  if (localStorage.getItem('sphere-backup-confirmed') !== 'true') {
    showBackupUi(sphere.getMnemonic()); // until the user confirms, then set the flag
  }
  return sphere;
}
```

### 2. Subscribe to Events Early

```typescript
// Sphere.init() returns an initialized sphere — subscribe to events right after
const { sphere } = await Sphere.init({ ...providers, network: 'testnet2', autoGenerate: true });

sphere.on('transfer:incoming', handleIncomingTransfer);
sphere.on('message:dm', handleMessage);
```

### 3. Graceful Shutdown

```typescript
window.addEventListener('beforeunload', async () => {
  await sphere.destroy();
});
```

### 4. Handle Reconnection

```typescript
sphere.on('connection:changed', async ({ provider, connected }) => {
  if (!connected) {
    console.log(`${provider} disconnected, attempting reconnect...`);
    // SDK handles reconnection automatically
  }
});
```

### 5. Event Timestamp Persistence

Token transfers and payment requests do not travel over Nostr: they arrive through the
wallet-api (mailbox and request stream), and receive dedup is described under
[Receive Tokens](#receive-tokens). The Nostr transport persists resume timestamps for
**messages** only, per wallet pubkey, so that on reconnect or app restart it asks the relays only
for newer events.

This is handled automatically when using `createBrowserProviders()` or `createNodeProviders()`: the
storage provider is passed to the transport.

**Behavior by subscription:**

| Subscription | With a stored timestamp | No stored timestamp | No storage adapter |
|--------------|-------------------------|---------------------|--------------------|
| Legacy kind-4 DMs | Resume from it | `now - 24h`, the one-shot fallback Sphere sets when it brings up the providers and on `switchToAddress()`; `now` if none is set | `now - 24h` |
| NIP-17 gift-wrap DMs | Resume from it | The transport's fallback DM timestamp, if one was set before subscribing, else `now` | The same fallback, else `now` |

Gift-wrap timestamps are randomised by up to two days for privacy, so the relay filter for them
starts two days before the chosen timestamp.

---

## Testing

The SDK includes a comprehensive test suite using Vitest.

### Running Tests

```bash
# Run all tests (watch mode)
npm test

# Run once (CI mode)
npm run test:run

# Run specific test file
npx vitest run tests/unit/core/crypto.test.ts

# E2E tests against live testnet2 (requires .env — see .env.example)
npm run test:e2e

# Relay and aggregator suites (own configs, excluded from the default run)
npm run test:relay
npm run test:aggregator
```

`vitest.config.ts` configures the `v8` coverage provider, but `@vitest/coverage-v8` is not a
devDependency: install it before running `npx vitest run --coverage`.

### Test Coverage

The default run (`vitest.config.ts`) covers 138 test files; `tests/e2e`, `tests/relay` and
`tests/aggregator` are excluded from it. Major areas:

| Area | Description |
|------|-------------|
| `tests/unit/core` | Crypto (BIP39/BIP32), currency, encryption, Sphere lifecycle |
| `tests/unit/token-engine` | The engine adapter: mint, transfer, split, verify, spent-check, the `expiresAt` policy, wire-version pins, and the golden `DIRECT://` derivation |
| `tests/unit/payments-v2` | The payments vertical: TransferMachine send/resume, receive drain, requests, mint journal, history, facade, port contracts, adversarial fakes |
| `tests/unit/modules` | Communications, GroupChat, Market |
| `tests/unit/connect` | Connect protocol surface, compatibility gate, lock, payments-compat adapter |
| `tests/unit/storage` | The tracked-address write contract (`contracts/tracked-addresses.contract.ts`) and the bundled providers held to it |
| `tests/unit/registry` | TokenRegistry instances and network resolution |
| `tests/unit/constants` | Network consistency, embedded trust-base integrity |
| `tests/unit/serialization` | Wallet text backups |
| `tests/unit/transport` | Nostr P2P messaging, event timestamp persistence |
| `tests/unit/impl` | IndexedDB storage provider, config resolvers, backing-store ids, wallet-api composition |
| `tests/mutation` | Mutation probes over the payments vertical, the token engine and the wallet-api wire (`tests/mutation/probes.json`; `npm run test:mutation`, all must be KILLED) |
| `tests/integration` | Sphere payments wiring, per-address bleed invariants, wallet import/export, nametag round-trips |
| `tests/e2e` | Live staging/testnet2 flows (gated behind `.env` keys; skipped otherwise) |

### Writing Tests

Tests follow the structure:

```
tests/
├── unit/
│   ├── core/            # crypto, currency, encryption, Sphere.*
│   ├── token-engine/    # engine adapter
│   ├── payments-v2/     # the vertical: machine, receive, requests, fakes, contracts/
│   ├── modules/         # Communications*, GroupChat*, Market*
│   ├── connect/         # protocol surface, lock, payments-compat adapter
│   ├── storage/         # tracked-address contract (contracts/) + provider runs
│   ├── registry/        # TokenRegistry
│   ├── constants/       # network consistency, trust-base integrity
│   ├── oracle/
│   ├── price/
│   ├── transport/
│   ├── serialization/
│   ├── support/         # shared mocks
│   └── impl/            # browser / shared providers, composition
├── integration/
├── e2e/                 # live-network tests (vitest.e2e.config.ts)
├── mutation/            # probes.json (scripts/test-mutation.mjs)
├── relay/               # vitest.relay.config.ts
├── aggregator/          # vitest.aggregator.config.ts
├── support/
└── fixtures/
```

Example test:

```typescript
import { describe, it, expect } from 'vitest';
import { generateMnemonic, validateMnemonic } from '../../../core/crypto';

describe('generateMnemonic()', () => {
  it('should generate valid 12-word mnemonic', () => {
    const mnemonic = generateMnemonic(128); // entropy bits: 128 = 12 words, 256 = 24 words
    const words = mnemonic.split(' ');

    expect(words).toHaveLength(12);
    expect(validateMnemonic(mnemonic)).toBe(true);
  });
});
```
