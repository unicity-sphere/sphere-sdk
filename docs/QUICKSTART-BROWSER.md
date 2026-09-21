# Sphere SDK - Browser Quick Start

> **Upgrading from 0.14.x or earlier?** 0.15.0 moved the base SDK pin to
> `@unicitylabs/state-transition-sdk@3.0.1`, a wire break that no client can straddle, so your
> wallet-api deployment has to move with you. For this guide it changed two things: the
> `sphere.paymentsV2` alias is **removed** (`sphere.payments` **throws** `NOT_INITIALIZED` where the
> alias returned `null` while no vertical was running), and the payment-journal key prefix moved
> from `pv2:` to `pv2g2:` (swept for you). See [Upgrading to 0.15.0](./INTEGRATION.md#upgrading-to-0150).
> Everything below uses `sphere.payments`.

Get up and running with Sphere SDK in web applications in under 5 minutes.

## Installation

```bash
npm install @unicitylabs/sphere-sdk
```

| Package | Required | Description |
|---------|----------|-------------|
| `@unicitylabs/sphere-sdk` | Yes | The SDK |

**That's it!** No additional dependencies for basic usage. Browser uses native WebSocket.

### TypeScript: declare `./impl/browser`

`@unicitylabs/sphere-sdk/impl/browser` ships no type declarations in this release; under `strict`
TypeScript add the declaration shim below (or a one-line
`declare module '@unicitylabs/sphere-sdk/impl/browser';`, which types everything from that entry as
`any`). Save it as a `.d.ts` file that your `tsconfig.json` includes, for example
`src/sphere-sdk-browser.d.ts`:

```ts
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

Import `createWalletApiProviders` from the typed `@unicitylabs/sphere-sdk/impl/shared/wallet-api`
subpath, not from `./impl/browser`.

The shim declares only `createBrowserProviders`. If you import other `./impl/browser` exports, such as
`createLocalStorageProvider` or `createUnicityAggregatorProvider`, add their declarations to the shim, or use
the one-line `declare module '@unicitylabs/sphere-sdk/impl/browser';` form.

> **Note:** No API key is bundled with the SDK: pass the gateway key through `oracle: { apiKey: '...' }`. The testnet2 key is **not a secret** (see `.env.example`): `sk_ddc3cfcc001e4a28ac3fad7407f99590`. A mainnet key, by contrast, IS a secret: keep it in your deploy environment only.
>
> **Networks:** the live networks are **testnet2** (network id 4) and **mainnet** (network id 1). Both are live, each with its own gateway and wallet-api deployment. `'testnet'` is a second name for testnet2's configuration (same endpoints), but it is a different string: use `'testnet2'` (see [One network literal](#one-network-literal)). On mainnet use `network: 'mainnet'` in `createBrowserProviders`, in the `walletApi` config and on `Sphere.init`, the mainnet wallet-api `https://wallet-api.mainnet.unicity.network`, and your mainnet gateway API key, which is a secret. Mainnet shares testnet2's Nostr relay for now, and its token registry lists no fungible coins yet. The v1 network is discontinued and the `dev` preset has been removed: passing it is a type error. The "2" in testnet2 names the **gateway network**, not the base-SDK major: testnet2 is still testnet2 on state-transition-sdk 3.x.

## Framework Setup

Every sample below follows the same three steps:

1. `createBrowserProviders({ network, oracle })` builds `storage` (IndexedDB), `transport` (Nostr)
   and `oracle` (gateway).
2. `createWalletApiProviders(base, { baseUrl, network, deviceId })` adds `walletApi`, the wallet-api
   transport config that the payments vertical is composed from. `Sphere.init` throws
   `INVALID_CONFIG` without it. A wallet that only messages (DMs, group chat, nametags) passes
   `walletApi: 'none'` instead: `network` is still required, `sphere.hasPayments` is then `false`,
   and `sphere.payments` throws `PAYMENTS_NOT_COMPOSED`.
3. `Sphere.init({ ...providers, network, autoGenerate: true })` loads the wallet in this storage, or
   creates one. Neither provider factory returns a `network` field, so `Sphere.init` must get
   `network` itself.

### One network literal

`Sphere.init` compares its own `network` with `walletApi.network` as plain strings and throws
`INVALID_CONFIG` ("walletApi.network "testnet2" does not match the Sphere network ...") when they differ,
including when `Sphere.init` gets no `network` at all. `'testnet'` and `'testnet2'` reach the same endpoints but are different
strings, so mixing them fails this check. The wallet-api deployment names its network too: the testnet2
deployment signs you in only as `'testnet2'`, and the SDK refuses a sign-in challenge for any other network.
Use `'testnet2'` everywhere.

**`deviceId`** keys this device's wallet-api session. Keep it stable across launches on one device
and different on every device (the samples persist a random UUID in `localStorage`). If you omit it,
the SDK uses a new random id, and so a fresh sign-in, on every run.

### Vanilla JavaScript / TypeScript

Save the setup as a module; the framework samples below import it.

```typescript
// wallet.ts
import { Sphere, randomUUID, type SphereInitResult } from '@unicitylabs/sphere-sdk';
import { createBrowserProviders } from '@unicitylabs/sphere-sdk/impl/browser'; // untyped entry: add the declaration shim
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';

// One network literal, used in all three places below.
export const NETWORK = 'testnet2';

// A per-device id: stable across launches on this device, different on every device.
export function deviceId(): string {
  let id = localStorage.getItem('sphere-device-id');
  if (!id) {
    // The SDK's randomUUID(): unlike crypto.randomUUID(), it also works outside a secure context.
    id = randomUUID();
    localStorage.setItem('sphere-device-id', id);
  }
  return id;
}

export function createProviders() {
  // 1. Base providers: storage (IndexedDB) + transport (Nostr) + oracle (gateway).
  const base = createBrowserProviders({
    network: NETWORK,
    oracle: { apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590' }, // public testnet2 gateway key
  });

  // 2. The wallet-api transport config that the payments vertical is composed from.
  return createWalletApiProviders(base, {
    baseUrl: 'https://wallet-api.unicity.network', // testnet2 wallet-api
    network: NETWORK,
    deviceId: deviceId(),
  });
}

// 3. Load the wallet in this storage, or create one.
export function initWallet(): Promise<SphereInitResult> {
  return Sphere.init({ ...createProviders(), network: NETWORK, autoGenerate: true });
}
```

```typescript
import { initWallet } from './wallet';

const { sphere, created, generatedMnemonic } = await initWallet();

if (created && generatedMnemonic) {
  // Returned only by the call that created the wallet. Do not rely on it alone for the backup
  // prompt: keep your own "backup confirmed" flag and show sphere.getMnemonic() until it is set
  // (see "Prompt User to Save Mnemonic" below).
  alert('Save your recovery phrase: ' + generatedMnemonic);
}
```

### React

Start the wallet once per page, outside React's lifecycle: React StrictMode runs effects twice in
development, and the SDK does not serialize two `Sphere.init` calls on the same storage.

```tsx
import { useState, useEffect } from 'react';
import type { Sphere, SphereInitResult } from '@unicitylabs/sphere-sdk';
import { initWallet } from './wallet'; // the Vanilla sample above

// One wallet per page. It lives as long as the page; end it with logout() below.
let walletPromise: Promise<SphereInitResult> | null = null;
function getWallet(): Promise<SphereInitResult> {
  if (!walletPromise) {
    walletPromise = initWallet();
    walletPromise.catch(() => { walletPromise = null; }); // allow a retry after a failure
  }
  return walletPromise;
}

// Logout: forget the page's wallet, then destroy it. After destroy() the instance has no identity
// and sphere.payments throws NOT_INITIALIZED, so the next getWallet() (call it after logout()
// resolves) must start a new one.
async function logout(): Promise<void> {
  const current = walletPromise;
  walletPromise = null;
  if (current) await current.then(({ sphere }) => sphere.destroy(), () => undefined);
}

function useWallet() {
  const [sphere, setSphere] = useState<Sphere | null>(null);
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getWallet().then(
      ({ sphere, created, generatedMnemonic }) => {
        if (!active) return;
        // Only the creating call returns it: see "Prompt User to Save Mnemonic" for the backup flag.
        if (created && generatedMnemonic) setMnemonic(generatedMnemonic);
        setSphere(sphere);
      },
      (err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => { active = false; };
  }, []);

  return { sphere, mnemonic, clearMnemonic: () => setMnemonic(null), error, loading: !sphere && !error };
}

function App() {
  const { sphere, mnemonic, clearMnemonic, error, loading } = useWallet();

  if (error) return <div>Wallet failed to start: {error}</div>;
  if (loading) return <div>Loading wallet...</div>;

  if (mnemonic) {
    return (
      <div>
        <h2>Save your recovery phrase!</h2>
        <code>{mnemonic}</code>
        <button onClick={clearMnemonic}>
          I've saved it
        </button>
      </div>
    );
  }

  return (
    <div>
      <p>Address: {sphere?.identity?.directAddress}</p>
      <p>Nametag: {sphere?.identity?.nametag || 'Not registered'}</p>
    </div>
  );
}
```

### Vue 3

```vue
<script setup lang="ts">
import { ref, shallowRef, onMounted, onUnmounted } from 'vue';
import type { Sphere } from '@unicitylabs/sphere-sdk';
import { initWallet } from './wallet'; // the Vanilla sample above

// shallowRef: keep Vue from wrapping the Sphere instance in a deep reactive proxy.
const sphere = shallowRef<Sphere | null>(null);
const loading = ref(true);
const mnemonic = ref<string | null>(null);
const error = ref<string | null>(null);
let unmounted = false;

onMounted(async () => {
  try {
    const result = await initWallet();
    if (unmounted) {
      await result.sphere.destroy();
      return;
    }
    // Only the creating call returns it: see "Prompt User to Save Mnemonic" for the backup flag.
    if (result.created && result.generatedMnemonic) {
      mnemonic.value = result.generatedMnemonic;
    }
    sphere.value = result.sphere;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
});

onUnmounted(() => {
  unmounted = true;
  void sphere.value?.destroy();
});
</script>

<template>
  <div v-if="loading">Loading wallet...</div>
  <div v-else-if="error">Wallet failed to start: {{ error }}</div>
  <div v-else-if="mnemonic">
    <h2>Save your recovery phrase!</h2>
    <code>{{ mnemonic }}</code>
  </div>
  <div v-else>
    <p>Address: {{ sphere?.identity?.directAddress }}</p>
  </div>
</template>
```

### Next.js (App Router)

The default storage is IndexedDB, which does not exist during server rendering, so load the wallet
module only in the browser:

```tsx
'use client';

import { useState, useEffect } from 'react';
import type { Sphere, SphereInitResult } from '@unicitylabs/sphere-sdk';

// Dynamic import: './wallet' (the Vanilla sample above) loads '@unicitylabs/sphere-sdk/impl/browser'
// only in the browser. One wallet per page, as in the React sample.
let walletPromise: Promise<SphereInitResult> | null = null;
function getWallet(): Promise<SphereInitResult> {
  if (!walletPromise) {
    walletPromise = import('./wallet').then(({ initWallet }) => initWallet());
    walletPromise.catch(() => { walletPromise = null; });
  }
  return walletPromise;
}

export default function WalletPage() {
  const [sphere, setSphere] = useState<Sphere | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getWallet().then(
      ({ sphere }) => { if (active) setSphere(sphere); },
      (err: unknown) => { if (active) setError(err instanceof Error ? err.message : String(err)); },
    );
    return () => { active = false; };
  }, []);

  if (error) return <div>Wallet failed to start: {error}</div>;
  if (!sphere) return <div>Loading...</div>;

  return <div>Address: {sphere.identity?.directAddress}</div>;
}
```

## Storage & Delivery

Where the wallet's data lives:

| Data | Storage | Persistence | Role |
|------|---------|-------------|------|
| Wallet keys (mnemonic or master key), nametags, tracked addresses, token-registry cache + payment journals (`pv2g2:*`) | IndexedDB (database `sphere-storage`) | Per origin, survives reloads | Local secrets + durable payment state |
| Token inventory + transfer intents + mailbox + history | Wallet API | Server-backed, cross-device | Custody + delivery + record |

**No server-side fallback:** `createBrowserProviders` always uses IndexedDB. Where IndexedDB does not exist (for example during server-side rendering) the storage cannot connect, and `Sphere.init` rejects with `STORAGE_ERROR` ("IndexedDB not available: ..."). Create the wallet in client-only code, as the Next.js sample does. The in-memory fallback belongs to `LocalStorageProvider` (`createLocalStorageProvider`, also exported by `./impl/browser`), which `createBrowserProviders` does not use; data in that fallback does not survive a reload.

**Wallet-API delivery:** incoming certified transfers land in your wallet-api mailbox; the SDK drains it continuously while running (wake WebSocket + poll) and verifies every token against the trust base before it enters the balance. Nostr is messaging only, not the payment rail.

**Payment-journal keys:** the `pv2g2:` prefix is 0.15.0's generation of the scoped KV (it was `pv2:` through 0.14.x). The rename is the migration — the superseded keys are swept once when the wallet composes its payments vertical, and there is nothing for you to run.

## Configuration Options

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createBrowserProviders } from '@unicitylabs/sphere-sdk/impl/browser'; // untyped entry: add the declaration shim
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';
import { deviceId } from './wallet'; // the Vanilla sample above

// Step 1: Base providers (storage, transport, oracle)
const base = createBrowserProviders({
  // Network (required): 'mainnet' | 'testnet2'. Use the same literal in all three places.
  // ('testnet' names the same endpoints as 'testnet2' but is a different string.)
  network: 'testnet2',

  // Transport options
  transport: {
    // Set one of the two: `relays` replaces the network defaults; `additionalRelays`
    // extends them and is ignored when `relays` is also set.
    relays: ['wss://custom-relay.com'],              // Replace defaults
    // additionalRelays: ['wss://extra-relay.com'],  // Or: add to defaults
    timeout: 5000,
    autoReconnect: true,
    debug: false,
  },

  // Oracle (v2 gateway) options — REQUIRED AT RUNTIME for send/mint
  oracle: {
    url: 'https://gateway.testnet2.unicity.network',   // Replace default gateway URL
    apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590',     // Gateway API key (public testnet2 key)
  },
  // For a custom trust base URL, build the oracle directly with
  // createUnicityAggregatorProvider({ url, apiKey, trustBaseUrl, network })
  // from '@unicitylabs/sphere-sdk/impl/browser'.

  // Price provider (optional — enables fiat value display)
  price: {
    platform: 'coingecko',    // Currently supported: 'coingecko'
    apiKey: 'CG-xxx',         // Optional (free tier works without key)
    cacheTtlMs: 60000,        // Cache TTL in ms (default: 60s)
  },
});

// Step 2: Attach the wallet-api transport config (REQUIRED for money)
const providers = createWalletApiProviders(base, {
  baseUrl: 'https://wallet-api.unicity.network', // testnet2 wallet-api (mainnet: https://wallet-api.mainnet.unicity.network)
  network: 'testnet2',
  deviceId: deviceId(),                          // stable on this device, unique per device
});

// Step 3: Initialize wallet with the composed providers
const { sphere } = await Sphere.init({
  ...providers,
  network: 'testnet2', // must equal walletApi.network
  autoGenerate: true,
});
```

## Common Operations

The snippets below assume an initialised `sphere` (see [Framework Setup](#framework-setup)).

### Display Wallet Info

```typescript
const identity = sphere.identity;

console.log('L3 Address:', identity?.directAddress);  // DIRECT://...
console.log('Public Key:', identity?.chainPubkey);    // 02abc...
console.log('Nametag:', identity?.nametag);           // 'username' (stored without the leading @)
```

### Check Balance & Assets

```typescript
// Get assets with price data (price fields are null without PriceProvider)
const assets = await sphere.payments.assets();
for (const asset of assets) {
  console.log(`${asset.symbol}: ${asset.totalAmount} (${asset.tokenCount} tokens)`);
  if (asset.fiatValueUsd != null) {
    console.log(`  Value: $${asset.fiatValueUsd.toFixed(2)}`);
  }
}

// Individual tokens (synchronous inventory view)
const tokens = sphere.payments.tokens();
// Coinless tokens (NFTs) are a SEPARATE, disjoint read — never in tokens() (#777)
const nfts = sphere.payments.coinless();
const payload = nfts[0] ? await sphere.payments.tokenData(nfts[0].tokenId) : null;

// Total portfolio value in USD (price fields are null without PriceProvider)
const totalUsd = assets.reduce((sum, a) => sum + (a.fiatValueUsd ?? 0), 0);
const balanceEl = document.getElementById('balance');
if (balanceEl) balanceEl.textContent = `$${totalUsd.toFixed(2)}`;
```

### Coin IDs

`coinId` is the 64-character hex coin id. To get it from a symbol, call `getCoinIdBySymbol('UCT')` (after
`await TokenRegistry.waitForReady()`, because `Sphere.init` starts the registry load without waiting for it; it
returns `undefined` when the symbol is unknown), or take `coinId` from `sphere.payments.assets()` for a coin the
wallet holds.

```typescript
import { TokenRegistry, getCoinIdBySymbol } from '@unicitylabs/sphere-sdk';

// From the token registry (works for any coin the network's registry lists):
await TokenRegistry.waitForReady(); // Sphere.init starts the registry load but does not await it
const coinId = getCoinIdBySymbol('UCT'); // string | undefined
if (!coinId) throw new Error('UCT is not in this network\'s token registry');

// Or from a coin the wallet holds:
const uct = (await sphere.payments.assets()).find((a) => a.symbol === 'UCT');
```

On mainnet the registry lists no fungible coins yet, so the lookup returns `undefined` there.

### Top Up (Testnet Self-Mint)

There is no faucet — on testnet you top up by **self-minting** tokens via the token engine:

```typescript
import { TokenRegistry, getCoinIdBySymbol } from '@unicitylabs/sphere-sdk';

// mint takes the 64-hex coin id
await TokenRegistry.waitForReady();
const coinId = getCoinIdBySymbol('UCT');
if (!coinId) throw new Error('UCT is not in this network\'s token registry');

const res = await sphere.payments.mint(coinId, 100_000_000n); // amount in base units (UCT has 18 decimals on testnet2)
if (res.success) {
  console.log('Minted token:', res.tokenId);
} else {
  console.error('Mint failed:', res.error);
}
```

### Look Up Asset Metadata

The `TokenRegistry` provides metadata (symbol, name, decimals, icons) for all registered assets on the network:

```typescript
import { TokenRegistry } from '@unicitylabs/sphere-sdk';

await TokenRegistry.waitForReady(); // the first load may still be running after Sphere.init
const registry = TokenRegistry.getInstance();

// List all registered assets
const allAssets = registry.getAllDefinitions();
const coins = registry.getFungibleTokens();
const nfts = registry.getNonFungibleTokens();

// Look up a specific asset
const uct = registry.getDefinitionBySymbol('UCT');
console.log(uct?.name, uct?.decimals);  // 'unicity', 18 (testnet2 registry)

// Reverse lookup: symbol → coin ID (undefined when the symbol is unknown)
const coinId = registry.getCoinIdBySymbol('UCT');
```

> **Note:** The registry is configured automatically by `Sphere.init()`. `createBrowserProviders()` does **not** configure it — if you build providers without initialising a Sphere and then read the registry directly, configure it yourself:
>
> ```ts
> import { TokenRegistry, NETWORKS } from '@unicitylabs/sphere-sdk';
>
> await providers.storage.connect(); // the registry caches only into a connected storage
> TokenRegistry.configure({
>   remoteUrl: NETWORKS.testnet2.tokenRegistryUrl,
>   storage: providers.storage,
> });
> ```
> Data is fetched from the network and cached in the storage provider you pass (IndexedDB here). The provider must be connected: on an unconnected one the cache writes fail silently and the definitions are kept in memory only.

### Send Tokens

`send()` resolves only when the payment is sent. `result.status` is `'delivered'` when it landed in the
recipient's mailbox, or `'confirmed'` with `result.deliveryPending === true` when the transfer is certified and
delivery is still being retried. That is success, not an error. `send()` never resolves with `'completed'` or
`'failed'`: a failure throws.

```typescript
// Import the error helpers from the same entry point as Sphere (here: the package root).
import { PartialSendConflictError, isPossiblyCommittedSendOutcome } from '@unicitylabs/sphere-sdk';

// amount: base units; coinId: the 64-hex coin id (see "Coin IDs").
async function sendTokens(recipient: string, amount: string, coinId: string) {
  try {
    const result = await sphere.payments.send({ recipient, amount, coinId });
    // Resolved means sent: result.status is 'delivered', or 'confirmed' with deliveryPending === true.
    showToast(result.deliveryPending
      ? 'Sent. Delivery to the recipient is pending and is retried automatically.'
      : 'Sent!');
  } catch (err) {
    if (err instanceof PartialSendConflictError) {
      // Part of the amount was delivered and is final. Only err.remainingAmount is still owed:
      // if you pay it, do it as a NEW send of exactly that amount, never the original amount.
      showToast(`Partly sent: ${err.remainingAmount} base units were not sent.`);
    } else if (isPossiblyCommittedSendOutcome(err)) {
      // The money may already have left the wallet. Never call send() again for this payment:
      // the SDK completes it under the same transferId. Show it as pending.
      showToast('Sent, waiting for confirmation.');
      // A "retry" button calls sphere.payments.resumeNow(), never send().
    } else {
      // Nothing left the wallet. Read `code` structurally: errors thrown by the providers
      // (e.g. the Nostr transport) are a different SphereError class copy, so isSphereError() is false for them.
      const code = (err as { code?: unknown } | null)?.code;
      switch (code) {
        case 'SEND_INSUFFICIENT_BALANCE': showToast((err as Error).message); break; // names pinned funds when transfers are converging
        case 'INVALID_RECIPIENT': showToast('Recipient not found'); break;
        case 'TRANSPORT_ERROR': showToast('Could not look up the recipient. Check the connection.'); break;
        default: showToast(err instanceof Error ? err.message : String(err));
      }
    }
  }
}
```

Some rejections mean the money may already have left the wallet. `isPossiblyCommittedSendOutcome(err)` is `true`
for exactly these codes: `SEND_SYNC_PENDING`, `CERTIFICATION_UNCONFIRMED`, `CHECKPOINT_PERSIST_FAILED`,
`SPLIT_CHECKPOINT_LOST`, `CHECKPOINT_TRUSTBASE_MISMATCH` and `SEND_PARTIALLY_COMPLETED`. Never call `send()` again
for that payment: a new `send()` gets a new transfer id and pays the recipient a second time. The SDK finishes the
original under its own transfer id; show it as pending (`sphere.payments.pendingTransfers()`), and wire any
"retry" button to `sphere.payments.resumeNow()`. A `PartialSendConflictError` means part of the amount was
delivered and is final; only `err.remainingAmount` is still owed. When `isPossiblyCommittedSendOutcome(err)` is
`false`, the SDK's contract is that nothing left the wallet.

Nametag bindings do not carry a network yet, so the SDK cannot prove that a `@nametag` or `DIRECT://` recipient
uses your network. Every such send emits `transfer:attention` with `code: 'recipient:network-unverified'` and an
empty `transferId`, and then proceeds on your network. Treat it as information, not an error; on mainnet, make
sure the recipient runs mainnet. A bare 66-hex chain pubkey recipient is taken as being on your network.

### Fetch Pending Transfers

For explicit receive (useful in batch operations or when you need to poll):

```typescript
const { transfers } = await sphere.payments.receive();
console.log(`Received ${transfers.length} new transfers`);
```

> `receive()` takes no options: transfers arrive as finished tokens, verified and stored confirmed immediately — there is no finalization phase. While the wallet runs, the mailbox is also drained automatically (you rarely need to call this).

### Register Nametag

> **Note:** `registerNametag()` registers the name by publishing a Nostr identity binding (name ↔ chain pubkey, one owner per name under UNIP-01; see [NAMETAG-BINDINGS.md](./NAMETAG-BINDINGS.md)). Runtime name resolution uses only the Nostr binding. No token is minted.

```typescript
async function registerNametag(username: string) {
  // Publishes the Nostr binding; throws if the name is already taken
  await sphere.registerNametag(username);
  console.log('Registered:', sphere.identity?.nametag);
}
```

To register during init instead, pass `nametag` to `Sphere.init`. It applies only when `init` creates the
wallet: an existing wallet is loaded and `nametag` is ignored.

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { NETWORK, createProviders } from './wallet'; // the Vanilla sample above

const { sphere } = await Sphere.init({
  ...createProviders(),
  network: NETWORK,
  autoGenerate: true,
  nametag: 'alice',
});
```

### Listen for Events

```typescript
// Incoming transfers — handlers receive the event payload directly
sphere.on('transfer:incoming', (transfer) => {
  const from = transfer.senderNametag ?? transfer.senderPubkey;
  showNotification(`Received ${transfer.tokens.length} token(s) from ${from}`);
});

// Direct messages
sphere.communications.onDirectMessage((msg) => {
  showNotification(`Message from ${msg.senderNametag ?? msg.senderPubkey}: ${msg.content}`);
});

// Connection status
sphere.on('connection:changed', (status) => {
  updateConnectionStatus(status.connected);
});
```

### Send Direct Message

```typescript
await sphere.communications.sendDM('@alice', 'Hello from the browser!');
```

### Payment Requests

Request payments over the wallet-api rail (`sphere.payments.requests`). `requests.create()` never throws: it
resolves `{ success, requestId?, error? }`. Never pay from inside the `payment_request:incoming` handler without
the user's decision: `pay()` and `decline()` are alternatives, and `pay()` rethrows `send()`'s errors (handle
them as in [Send Tokens](#send-tokens)).

```typescript
import { TokenRegistry, getCoinIdBySymbol } from '@unicitylabs/sphere-sdk';

// Requester side: create() never throws. It resolves { success, requestId?, error? }.
await TokenRegistry.waitForReady(); // Sphere.init starts the registry load but does not await it
const coinId = getCoinIdBySymbol('UCT'); // the hex coin id, or undefined (see "Coin IDs")
if (!coinId) throw new Error('UCT is not in this network\'s token registry');
const created = await sphere.payments.requests.create('@bob', { coinId, amount: '1000000', memo: 'Order #1234' });
if (!created.success) console.error(created.error);

// Payer side: never pay from the event handler itself. Show the request and let the user decide.
sphere.on('payment_request:incoming', async (request) => {
  // request.amount is a base-unit string and request.coinId the hex coin id; request.symbol is not set here.
  try {
    if (await askUser(request)) {
      await sphere.payments.requests.pay(request.id);
    } else {
      await sphere.payments.requests.decline(request.id);
    }
  } catch (err) {
    console.error('payment request failed', err); // pay() rethrows send() errors: handle them like send()
  }
});

// Status changes of requests you RECEIVED: 'pending' | 'settling' | 'paid' | 'rejected' | 'expired'
sphere.on('payment_request:updated', ({ id, status }) => {
  console.log(`Request ${id}: ${status}`);
});

// Current views (received requests) + housekeeping
const requests = sphere.payments.requests.list();
sphere.payments.requests.dismissProcessed();
```

`payment_request:updated` and `requests.list()` cover requests you **received**. The SDK does not track the
requests you create: detect that one was paid through `transfer:incoming` or `sphere.payments.history()`.

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

### Transaction History

History is a server read-through, paged:

```typescript
const page = await sphere.payments.history({ limit: 50 });
for (const entry of page.entries) {
  console.log(entry.type, entry.amount, entry.symbol, new Date(entry.timestamp));
}
if (page.more) {
  const older = await sphere.payments.history({ before: page.cursor!, limit: 50 });
}
```

## Import Existing Wallet

`Sphere.init` loads the wallet that is already in the storage, if there is one, and then ignores `mnemonic`,
`nametag` and `autoGenerate`. To replace the stored wallet with another phrase, use `Sphere.import`, which first
clears the storage's current wallet, including the payment journals of transfers still in flight; do not run it
while transfers are pending. That clear also destroys any live `Sphere` on the same storage.

Restore from a mnemonic into an empty storage (plaintext storage, the default):

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { NETWORK, createProviders } from './wallet'; // the Vanilla sample above

const { sphere } = await Sphere.init({
  ...createProviders(),
  network: NETWORK,
  mnemonic: 'word1 word2 word3 ... word12',
});
```

The same, with the stored mnemonic encrypted by a password (see [Security](#protect-the-stored-recovery-phrase)):

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { NETWORK, createProviders } from './wallet';

const { sphere } = await Sphere.init({
  ...createProviders(),
  network: NETWORK,
  mnemonic: 'word1 word2 word3 ... word12',
  password: 'my-secret-password',
});
```

Replace whatever wallet the storage holds (`Sphere.import` returns the `Sphere` itself):

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { NETWORK, createProviders } from './wallet';

const sphere = await Sphere.import({
  ...createProviders(),
  network: NETWORK,
  mnemonic: 'word1 word2 word3 ... word12',
});
```

Load an existing password-protected wallet:

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { NETWORK, createProviders } from './wallet';

const { sphere } = await Sphere.init({
  ...createProviders(),
  network: NETWORK,
  password: 'my-secret-password',
});

// init loads the nametag stored with the wallet. If storage has none, init tries to recover it
// from the Nostr binding before it resolves (a recovery has already fired 'nametag:recovered').
// Either way, read it from the identity:
console.log('Nametag:', sphere.identity?.nametag);
```

## Complete React Example

```tsx
import { useState, useEffect, useCallback } from 'react';
import {
  TokenRegistry,
  getCoinIdBySymbol,
  PartialSendConflictError,
  isPossiblyCommittedSendOutcome,
  type Sphere,
  type SphereInitResult,
} from '@unicitylabs/sphere-sdk';
import { initWallet } from './wallet'; // the Vanilla sample above

// One wallet per page (see the React section above).
let walletPromise: Promise<SphereInitResult> | null = null;
function getWallet(): Promise<SphereInitResult> {
  if (!walletPromise) {
    walletPromise = initWallet();
    walletPromise.catch(() => { walletPromise = null; });
  }
  return walletPromise;
}

async function totalUsd(sphere: Sphere): Promise<string> {
  // Price fields are null without a PriceProvider.
  const assets = await sphere.payments.assets();
  return `$${assets.reduce((sum, a) => sum + (a.fiatValueUsd ?? 0), 0).toFixed(2)}`;
}

function WalletApp() {
  const [sphere, setSphere] = useState<Sphere | null>(null);
  const [balance, setBalance] = useState<string>('$0.00');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState('Loading...');

  // Initialize wallet
  useEffect(() => {
    let active = true;
    let off: (() => void) | undefined;

    getWallet()
      .then(async ({ sphere, created, generatedMnemonic }) => {
        if (!active) return;
        if (created && generatedMnemonic) {
          // In production, show a modal that asks the user to back up the phrase, gated on your
          // own "backup confirmed" flag (see "Prompt User to Save Mnemonic"), not on `created`.
          console.log('NEW WALLET - Save mnemonic:', generatedMnemonic);
        }
        setSphere(sphere);
        setStatus('Connected');
        off = sphere.on('transfer:incoming', () => {
          void totalUsd(sphere).then((b) => { if (active) setBalance(b); });
        });
        const b = await totalUsd(sphere);
        if (active) setBalance(b);
      })
      .catch((err: unknown) => {
        if (active) setStatus('Error: ' + (err instanceof Error ? err.message : String(err)));
      });

    return () => { active = false; off?.(); };
  }, []);

  // Send tokens
  const handleSend = useCallback(async () => {
    if (!sphere || !recipient || !amount || sending) return;

    setSending(true);
    setStatus('Sending...');
    try {
      // send() takes the 64-hex coin id.
      await TokenRegistry.waitForReady();
      const coinId = getCoinIdBySymbol('UCT');
      if (!coinId) {
        setStatus('UCT is not in this network\'s token registry');
        return;
      }

      const result = await sphere.payments.send({ recipient, amount, coinId });
      setStatus(result.deliveryPending ? 'Sent (delivery to the recipient is pending)' : 'Sent!');
      setRecipient('');
      setAmount('');
      setBalance(await totalUsd(sphere));
    } catch (err) {
      if (err instanceof PartialSendConflictError) {
        // Part was delivered and is final; only err.remainingAmount is still owed.
        setStatus(`Partly sent: ${err.remainingAmount} base units were not sent.`);
        setRecipient('');
        setAmount('');
      } else if (isPossiblyCommittedSendOutcome(err)) {
        // The money may already have left: never re-send. The SDK completes it.
        setStatus('Sent, waiting for confirmation. Do not send it again.');
        setRecipient('');
        setAmount('');
      } else {
        // Nothing left the wallet.
        setStatus('Not sent: ' + (err instanceof Error ? err.message : String(err)));
      }
    } finally {
      setSending(false);
    }
  }, [sphere, recipient, amount, sending]);

  return (
    <div style={{ padding: 20 }}>
      <h1>Sphere Wallet</h1>
      <p>Status: {status}</p>

      {sphere && (
        <>
          <div style={{ marginBottom: 20 }}>
            <strong>Address:</strong> {sphere.identity?.directAddress}
            <br />
            <strong>Nametag:</strong> {sphere.identity?.nametag || 'Not registered'}
            <br />
            <strong>Balance:</strong> {balance}
          </div>

          <div>
            <h3>Send UCT</h3>
            <input
              placeholder="@recipient or address"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
            />
            <input
              placeholder="Amount (base units)"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <button onClick={handleSend} disabled={sending}>Send</button>
          </div>
        </>
      )}
    </div>
  );
}

export default WalletApp;
```

## Bundler Configuration

### Vite

Works out of the box. No special config needed.

### Webpack 5

Add node polyfills:

```javascript
// webpack.config.js
const { ProvidePlugin } = require('webpack');

module.exports = {
  resolve: {
    fallback: {
      buffer: require.resolve('buffer/'),
    },
  },
  plugins: [
    new ProvidePlugin({
      Buffer: ['buffer', 'Buffer'],
    }),
  ],
};
```

### Create React App

Use `react-app-rewired` or eject:

```javascript
// config-overrides.js
const webpack = require('webpack');

module.exports = function override(config) {
  config.resolve.fallback = {
    buffer: require.resolve('buffer/'),
  };
  config.plugins.push(
    new webpack.ProvidePlugin({
      Buffer: ['buffer', 'Buffer'],
    })
  );
  return config;
};
```

## Security Best Practices

### Never Store Mnemonic in Code

```typescript
// BAD - Don't do this!
const hardCodedMnemonic = 'word1 word2 word3...';

// GOOD - Let user input it
const mnemonic = (document.getElementById('mnemonicInput') as HTMLInputElement | null)?.value ?? '';
```

### Prompt User to Save Mnemonic

`generatedMnemonic` is returned only by the `Sphere.init` call that created the wallet. The phrase is
stored before the rest of the setup runs, so if that call then throws (for example, a requested
`nametag` is already taken), the next `Sphere.init` loads the stored wallet with `created: false`.
Gate your backup prompt on your own "backup confirmed" flag and read the phrase with
`sphere.getMnemonic()` until the user confirms.

```typescript
// Your own flag, one per wallet: set it only when the user confirms the backup.
const backupKey = `sphere-backup-confirmed:${sphere.identity?.chainPubkey}`;
if (localStorage.getItem(backupKey) !== 'true') {
  const phrase = sphere.getMnemonic(); // null for a wallet imported from a master key
  if (phrase) {
    // Show modal, not just console.log
    showMnemonicModal(phrase, () => localStorage.setItem(backupKey, 'true'));
  }
}
```

### Protect the Stored Recovery Phrase

The wallet keeps its mnemonic (or master key) in the storage provider: IndexedDB in the browser, the wallet file
on Node. If you pass `password` when the wallet is created or imported, the SDK encrypts that value with
CryptoJS's password-based AES-256-CBC, which derives the key with OpenSSL's `EVP_BytesToKey` (MD5, one iteration).
That keeps the phrase out of casual view and out of copies of the storage that are read without the password, but
it is a fast key derivation: anyone who obtains the stored value can try passwords offline at high speed, so a
short or common password gives little protection. Without a password the mnemonic is stored as plaintext. The
other stored data (derivation path, nametags, payment journals) is not protected by the password either way. Always
set a password for wallets that hold value, make it long and unique, and protect the storage itself at the
operating-system level (file permissions and disk encryption on servers; the browser profile on clients).
`exportToJSON({ password })` uses the same scheme. There is no call to add or change the password later.
`importFromJSON` / `importFromLegacyFile` use their `password` only to decrypt the backup and store the imported
mnemonic (or master key) without a password, so load a wallet restored that way without `password`: with one,
loading fails with `STORAGE_ERROR`.

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { NETWORK, createProviders } from './wallet'; // the Vanilla sample above

// Create or load with a password: the stored mnemonic is encrypted with it.
// Every later launch must pass the same password; a wrong one fails with
// STORAGE_ERROR 'Failed to decrypt mnemonic'.
const { sphere } = await Sphere.init({
  ...createProviders(),
  network: NETWORK,
  autoGenerate: true,
  password: userPassword,
});
```

### Clear Sensitive Data

`Sphere.clear()` is irreversible: it deletes the wallet's keys, and without a backup of the recovery phrase the
wallet cannot be restored. It also deletes the payment journals of transfers still in flight, and it destroys any
live `Sphere` on that storage. For IndexedDB it empties the whole database named by `dbName` (default
`sphere-storage`), every key `prefix` in it, so give each wallet its own `dbName`.

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';

// When user logs out
await sphere.destroy();

// Optionally clear all SDK-owned wallet data (keys + payment journals;
// also sweeps orphaned pre-flip token databases). Irreversible: back up the phrase first.
// providers.storage: the storage the wallet was created with.
await Sphere.clear({ storage: providers.storage });
```

### Use HTTPS

Always serve your app over HTTPS in production.

## Troubleshooting

### Server-side rendering (SSR)

The default storage is IndexedDB and has no server-side fallback. Load the SDK's browser entry only in the
browser, with a dynamic import in client-only code (see the Next.js sample):

```typescript
const { createBrowserProviders } = await import(
  '@unicitylabs/sphere-sdk/impl/browser'
);
const { createWalletApiProviders } = await import(
  '@unicitylabs/sphere-sdk/impl/shared/wallet-api'
);
```

### "Buffer is not defined"

`@unicitylabs/sphere-sdk/impl/browser` sets `globalThis.Buffer` itself when it is missing. If code runs before
that module loads and needs `Buffer`, install and configure the polyfill:
```bash
npm install buffer
```

Add to your entry point:
```typescript
import { Buffer } from 'buffer';
Object.assign(globalThis, { Buffer });
```

### CORS Errors

If aggregator/relay requests fail with CORS:
- Check if URLs are correct for your network
- Use a proxy in development
- Contact relay/aggregator operators

### IndexedDB Errors

Without IndexedDB, `Sphere.init` rejects with `STORAGE_ERROR` ("IndexedDB not available: ..."): the default
storage has no fallback, and it holds the wallet keys and payment journals (tokens are held by the wallet-api).
Check before you start the wallet:

```typescript
if (typeof indexedDB === 'undefined') {
  console.warn('IndexedDB is not available: the wallet cannot be created or loaded here');
}
```

### WebSocket Connection Failed

```typescript
import { createBrowserProviders } from '@unicitylabs/sphere-sdk/impl/browser'; // untyped entry: add the declaration shim

const base = createBrowserProviders({
  network: 'testnet2',
  oracle: { apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590' },
  transport: {
    debug: true,           // Enable logging
    timeout: 10000,        // Increase timeout
    autoReconnect: true,   // Auto-retry
  },
});
```

### Debug Logging

Enable SDK debug logging in the browser console:

```typescript
import { logger } from '@unicitylabs/sphere-sdk';

// Enable all debug logging
logger.configure({ debug: true });

// Enable only transport logs
logger.setTagDebug('Nostr', true);
```

## Browser Support

No minimum browser version has been tested. The SDK is built for ES2022, and importing the package root calls
`Object.hasOwn` (in the bundled `@noble/curves`), so a browser without `Object.hasOwn` fails at import. That
rules out Chrome and Edge before 93, Firefox before 92, and Safari (macOS and iOS) before 15.4. Treat these as
lower bounds, not a tested floor.

**Required APIs:** `localStorage`, `IndexedDB`, `WebSocket`, `fetch`, `crypto.subtle`

## Next Steps

- [API Reference](./API.md) - Full API documentation
- [Integration Guide](./INTEGRATION.md) - Advanced integration patterns, and [Upgrading to 0.15.0](./INTEGRATION.md#upgrading-to-0150)
- [Connect Protocol](./CONNECT.md) - dApp ↔ wallet RPC (protocol version `2.3`)
- [Parallel token verification](./VERIFICATION-WORKERS.md) - The opt-in worker pool
- [Node.js Quick Start](./QUICKSTART-NODEJS.md) - For server-side usage
