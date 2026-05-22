# Providers & Configuration

Sphere is configured by **providers** — pluggable backends for storage, messaging, proofs, and prices. The factory functions `createBrowserProviders()` and `createNodeProviders()` assemble a complete set from a single network name; everything below is for customizing that.

## Network presets

A network name configures every service at once.

Values below are from `constants.ts` (the source of truth). Note the `/rpc` suffix on mainnet/dev aggregators but **not** testnet.

| Network | Aggregator | Messaging relay | Fulcrum (ALPHA) | Group‑chat relay |
|---|---|---|---|---|
| `mainnet` | aggregator.unicity.network/rpc | relay.unicity.network | fulcrum.unicity.network:50004 | sphere-relay.unicity.network |
| `testnet` | goggregator-test.unicity.network | nostr-relay.testnet.unicity.network | fulcrum.unicity.network:50004 | sphere-relay.unicity.network |
| `dev` | dev-aggregator.dyndns.org/rpc | nostr-relay.testnet.unicity.network | fulcrum.unicity.network:50004 | sphere-relay.unicity.network |

```typescript
// Use a preset
const providers = createBrowserProviders({ network: 'testnet' });

// Override one service, keep the rest
const providers = createBrowserProviders({
  network: 'testnet',
  oracle: { url: 'https://custom-aggregator.example.com' },
});
```

## Browser providers

| Provider | Description |
|---|---|
| `LocalStorageProvider` | Browser localStorage with SSR fallback |
| `IndexedDBStorageProvider` | Default key‑value store |
| `NostrTransportProvider` | Relay messaging |
| `UnicityAggregatorProvider` | Aggregator for proofs |
| `IpfsStorageProvider` | HTTP‑based IPFS/IPNS token backup |

## Node.js providers

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

const providers = createNodeProviders({
  network: 'testnet',
  dataDir: './wallet-data',
  tokensDir: './tokens',
});

const { sphere } = await Sphere.init({ ...providers, autoGenerate: true });
```

Full configuration:

```typescript
const providers = createNodeProviders({
  network: 'testnet',
  dataDir: './wallet-data',
  tokensDir: './tokens',
  walletFileName: 'mnemonic.txt', // optional: custom filename; .txt is read as a raw mnemonic
  transport: { additionalRelays: ['wss://my-relay.com'], timeout: 10000, debug: true },
  oracle:    { apiKey: 'my-api-key', trustBasePath: './trustbase.json' },
  l1:        { enableVesting: true },
});
```

### Manual provider creation (Node.js)

```typescript
import {
  FileStorageProvider,
  FileTokenStorageProvider,
  createNostrTransportProvider,
  createNodeTrustBaseLoader,
} from '@unicitylabs/sphere-sdk/impl/nodejs';

const storage      = new FileStorageProvider('./wallet-data');
const tokenStorage = new FileTokenStorageProvider('./tokens');
const transport    = createNostrTransportProvider({ relays: ['wss://relay.unicity.network'] });

const trustBase = await createNodeTrustBaseLoader('./trustbase-testnet.json').load();
```

## Wallet password (encryption at rest)

The recovery phrase is stored as plaintext by default, or AES‑encrypted if you pass a password:

```typescript
const { sphere } = await Sphere.init({ ...providers, password: 'my-secret' });
```

Wallets written without a password (or by an external app as a plaintext `wallet.json` / `.txt`) still load without one; previously encrypted wallets remain compatible.

## Prices (optional)

Enable fiat values with a `price` config (CoinGecko, free or pro):

```typescript
const providers = createBrowserProviders({
  network: 'testnet',
  price: { platform: 'coingecko' },               // free tier
  // price: { platform: 'coingecko', apiKey: 'CG-xxx' }, // pro
});

const usd    = await sphere.payments.getFiatBalance(); // total in USD, or null without prices
const assets = await sphere.payments.getAssets();      // includes priceUsd / fiatValueUsd / change24h
```

You can also set it after init:

```typescript
import { createPriceProvider } from '@unicitylabs/sphere-sdk';
sphere.setPriceProvider(createPriceProvider({ platform: 'coingecko', apiKey: 'CG-xxx' }));
```

Without a price provider, `getFiatBalance()` returns `null` and the price fields on `getAssets()` are `null`; everything else works. (`getBalance()` always returns the `Asset[]` breakdown — it's price‑independent.)

## The extend / override pattern

Configuration uses a consistent rule across platforms:

| Option | Behavior |
|---|---|
| `relays` | **Replaces** the default relays |
| `additionalRelays` | **Adds** to the defaults |
| `gateways` | **Replaces** default IPFS gateways |
| `additionalGateways` | **Adds** to the defaults |
| `url`, `electrumUrl` | **Replaces** the default URL (network default otherwise) |

```typescript
// Add to defaults
createBrowserProviders({ network: 'testnet', transport: { additionalRelays: ['wss://extra.com'] } });

// Replace defaults entirely
createBrowserProviders({ network: 'testnet', transport: { relays: ['wss://only-this.com'] } });
```

Shared interfaces and resolver helpers live under `@unicitylabs/sphere-sdk/impl/shared` (`BaseTransportConfig`, `BaseOracleConfig`, `L1Config`, `getNetworkConfig`, `resolveTransportConfig`, `resolveArrayConfig`, …). Each platform extends the base with its own options (browser adds `reconnectDelay`/`maxReconnectAttempts`; Node adds `trustBasePath`).

## Token sync backends

Token backup can be enabled independently of the rest.

| Backend | Status | Description |
|---|---|---|
| `ipfs` | Ready | HTTP‑based IPFS/IPNS (browser + Node) |
| `mongodb` | Planned | Centralized storage |
| `file` | Planned | Local file system (Node) |
| `cloud` | Planned | S3 / GCP / Azure |

```typescript
const providers = createBrowserProviders({
  network: 'testnet',
  tokenSync: { ipfs: { enabled: true, additionalGateways: ['https://my-gateway.com'] } },
});
```

See [IPFS-STORAGE.md](IPFS-STORAGE.md) for caching, merge rules, and troubleshooting.

## Custom token storage provider

Implement `TokenStorageProvider` for your own backend:

```typescript
import type {
  TokenStorageProvider, TxfStorageDataBase, SaveResult, LoadResult, SyncResult,
} from '@unicitylabs/sphere-sdk/storage';
import type { FullIdentity, ProviderStatus } from '@unicitylabs/sphere-sdk/types';

class MyStorageProvider implements TokenStorageProvider<TxfStorageDataBase> {
  readonly id = 'my-storage';
  readonly name = 'My Custom Storage';
  readonly type = 'remote' as const;

  private status: ProviderStatus = 'disconnected';
  private identity: FullIdentity | null = null;

  setIdentity(identity: FullIdentity) { this.identity = identity; }
  async initialize() { this.status = 'connected'; return true; }
  async shutdown()   { this.status = 'disconnected'; }
  async connect()    { await this.initialize(); }
  async disconnect() { await this.shutdown(); }
  isConnected()      { return this.status === 'connected'; }
  getStatus()        { return this.status; }

  async load(): Promise<LoadResult<TxfStorageDataBase>> {
    return {
      success: true,
      data: { _meta: { version: 1, address: this.identity?.l1Address ?? '', formatVersion: '2.0', updatedAt: Date.now() } },
      source: 'remote', timestamp: Date.now(),
    };
  }
  async save(data: TxfStorageDataBase): Promise<SaveResult> {
    return { success: true, timestamp: Date.now() };
  }
  async sync(localData: TxfStorageDataBase): Promise<SyncResult<TxfStorageDataBase>> {
    await this.save(localData);
    return { success: true, merged: localData, added: 0, removed: 0, conflicts: 0 };
  }
}

const { sphere } = await Sphere.init({ ...providers, tokenStorage: new MyStorageProvider(), autoGenerate: true });
```

## Dynamic provider management (runtime)

After `Sphere.init()`, token storage providers can be added or removed live:

```typescript
import { createBrowserIpfsStorageProvider } from '@unicitylabs/sphere-sdk/impl/browser/ipfs';

const ipfs = createBrowserIpfsStorageProvider({ gateways: ['https://my-ipfs-node.com'] });
await sphere.addTokenStorageProvider(ipfs);

sphere.hasTokenStorageProvider('ipfs-token-storage'); // true
await sphere.removeTokenStorageProvider('ipfs-token-storage');

sphere.on('sync:provider', (e) => {
  console.log(`${e.providerId}: ${e.success ? `+${e.added}/-${e.removed}` : e.error}`);
});
await sphere.payments.sync();
```

## Dynamic relay management

```typescript
const transport = sphere.getTransport();

transport.getRelays();           // configured
transport.getConnectedRelays();  // currently connected

await transport.addRelay('wss://new-relay.com');
await transport.removeRelay('wss://old-relay.com');

transport.hasRelay('wss://relay.com');
transport.isRelayConnected('wss://relay.com');

sphere.on('transport:relay_added',   (e) => console.log('added', e.data.relay, e.data.connected));
sphere.on('transport:relay_removed', (e) => console.log('removed', e.data.relay));
sphere.on('transport:error',         (e) => console.log('error', e.data.error));
```

## Browser bundling

The SDK runs in the browser, but it (and its `@unicitylabs/nostr-js-sdk` dependency) reference Node built‑ins (`crypto`, `zlib`) and globals (`Buffer`, `process`). Most modern bundlers don't polyfill these automatically, so a bare import can fail with `Buffer is not defined` or unresolved `node:` built‑ins. Provide polyfills/shims.

**Vite**
```ts
// vite.config.ts
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default {
  plugins: [nodePolyfills({ globals: { Buffer: true, process: true } })],
};
```

**Webpack 5** — add `resolve.fallback` for `crypto`/`zlib`/`stream` (or stub the ones you don't use) and provide `Buffer`/`process` via `ProvidePlugin`.

If a bundler still trips on an unused Node built‑in pulled in transitively, alias it to an empty stub. (This affects bundling only — at runtime the SDK uses Web Crypto and native WebSocket in the browser.)

## Protocol / version compatibility

This SDK **bundles `@unicitylabs/state-transition-sdk` `1.6.1`**, and the public testnet aggregator speaks that **v1** request shape. Use the state‑transition client the SDK already bundles (everything under `sphere.payments` does).

If you also import `@unicitylabs/state-transition-sdk` directly in your app, **pin the same version the SDK bundles.** A separately installed v2 line uses a different request shape (e.g. `certification_request` + an `X-State-ID` header) that the v1 aggregator rejects with `HTTP 400` on fields like `requestId` / `shardId`. Mixing major lines against the same endpoint is the usual cause of unexplained 400s.
