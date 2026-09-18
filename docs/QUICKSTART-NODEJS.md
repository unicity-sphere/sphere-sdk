# Sphere SDK - Node.js Quick Start

> **Upgrading from 0.14.x or earlier?** 0.15.0 moved the base SDK pin to
> `@unicitylabs/state-transition-sdk@3.0.1`, a wire break that no client can straddle, so your
> wallet-api deployment has to move with you. For this guide it changed two things: the
> `sphere.paymentsV2` alias is **removed** (`sphere.payments` **throws** `NOT_INITIALIZED` where the
> alias returned `null` while no vertical was running), and the payment-journal key prefix moved
> from `pv2:` to `pv2g2:` (swept for you). See [Upgrading to 0.15.0](./INTEGRATION.md#upgrading-to-0150).
> Everything below uses `sphere.payments`.

Get up and running with Sphere SDK in Node.js in under 5 minutes.

## Installation

```bash
npm install @unicitylabs/sphere-sdk ws
```

| Package | Required | Description |
|---------|----------|-------------|
| `@unicitylabs/sphere-sdk` | Yes | The SDK |
| `ws` | Yes, with `@unicitylabs/sphere-sdk/impl/nodejs` | WebSocket for the Nostr transport; imported when the module loads, on every Node version |

Install `ws` next to the SDK (`npm install @unicitylabs/sphere-sdk ws`). `@unicitylabs/sphere-sdk/impl/nodejs`
imports `ws` when the module loads, on every Node version, and the package declares `ws` only as an optional
peer dependency, so npm does not install it for you.

**Node.js version:** 22.0.0 or higher (the package's `engines` field)

> **Note:** No API key is bundled with the SDK: pass the gateway key through `oracle: { apiKey: '...' }`. The testnet2 key is **not a secret** (see `.env.example`): `sk_ddc3cfcc001e4a28ac3fad7407f99590`. A mainnet key, by contrast, IS a secret: keep it in your deploy environment only.
>
> **Networks:** the live networks are **testnet2** (network id 4) and **mainnet** (network id 1). Both are live, each with its own gateway and wallet-api deployment. `'testnet'` is a second name for testnet2's configuration (same endpoints), but it is a different string: use `'testnet2'` (see [One network literal](#one-network-literal)). On mainnet use `network: 'mainnet'` in `createNodeProviders`, in the `walletApi` config and on `Sphere.init`, the mainnet wallet-api `https://wallet-api.mainnet.unicity.network`, and your mainnet gateway API key, which is a secret. Mainnet shares testnet2's Nostr relay for now, and its token registry lists no fungible coins yet. The v1 network is discontinued and the `dev` preset has been removed: passing it is a type error. The "2" in testnet2 names the **gateway network**, not the base-SDK major: testnet2 is still testnet2 on state-transition-sdk 3.x.

## CLI

The Sphere CLI lives in its own repository, [unicity-sphere/sphere-cli](https://github.com/unicity-sphere/sphere-cli),
and is not published to npm yet: `npm install -g @unicity-sphere/cli` fails with a 404. Its command reference
lives in that repository; see [QUICKSTART-CLI.md](QUICKSTART-CLI.md).

## Transfer Mode

Transfers are **sender-driven**: the sender certifies the transfer on-chain (collects the inclusion proof) and deposits the finished token into the recipient's wallet-api mailbox — the receiver verifies and stores it as confirmed with no finalization phase. There is a single transfer flow; the old `instant`/`conservative` modes no longer exist.

## Storage

Node.js implementation uses **file-based storage** for local state; token custody is the wallet-api backend:

| Data | Location | Format |
|------|----------|--------|
| Wallet (keys, nametag) + payment journals (`pv2g2:*`) | `dataDir/wallet.json` (or custom file name; `dataDir` defaults to `./sphere-data`) | JSON (plaintext or password-encrypted mnemonic) |
| Token inventory + transfer intents + mailbox + history | Wallet API server | Server custody |


## Minimal Example

```typescript
// npm install @unicitylabs/sphere-sdk ws
import { Sphere, TokenRegistry } from '@unicitylabs/sphere-sdk';
import { createNodeProviders, createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

// One network literal, used in all three places below.
const NETWORK = 'testnet2';

async function main() {
  // 1. Create base providers (handles storage, transport, oracle)
  const base = createNodeProviders({
    network: NETWORK,
    dataDir: './wallet-data', // optional, default './sphere-data'
    oracle: {
      apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590', // Public testnet2 key
    },
  });

  // 2. Attach the wallet-api transport config (REQUIRED — money rides the wallet-api vertical)
  const providers = createWalletApiProviders(base, {
    baseUrl: 'https://wallet-api.unicity.network', // testnet2 wallet-api
    network: NETWORK,
    deviceId: 'my-service-host-1', // stable on this machine, unique per machine
  });

  // 3. Initialize wallet (auto-creates if doesn't exist)
  const { sphere, created, generatedMnemonic } = await Sphere.init({
    ...providers,
    network: NETWORK, // Required: it selects the token registry, and it must equal
                      // walletApi.network (a mismatch throws INVALID_CONFIG)
    autoGenerate: true,
  });

  // 4. Save mnemonic on first run!
  if (created && generatedMnemonic) {
    console.log('SAVE THIS MNEMONIC:', generatedMnemonic);
  }

  // 5. Use the wallet
  console.log('Direct Address:', sphere.identity?.directAddress);

  // 6. Cleanup
  await sphere.destroy();
  TokenRegistry.destroy(); // stops the process-global registry refresh timer, so Node can exit
}

main().catch(console.error);
```

`sphere.destroy()` stops this Sphere's own registry, but `Sphere.init` also configures the process-wide
`TokenRegistry`, whose hourly refresh timer keeps Node's event loop alive. Call `TokenRegistry.destroy()` after
`sphere.destroy()` when the process should exit.

### One network literal

`Sphere.init` compares its own `network` with `walletApi.network` as plain strings and throws
`INVALID_CONFIG` ("walletApi.network "testnet2" does not match the Sphere network ...") when they differ,
including when `Sphere.init` gets no `network` at all. `'testnet'` and `'testnet2'` reach the same endpoints but are different
strings, so mixing them fails this check. The wallet-api deployment names its network too: the testnet2
deployment signs you in only as `'testnet2'`, and the SDK refuses a sign-in challenge for any other network.
Use `'testnet2'` everywhere.

**`deviceId`** keys this machine's wallet-api session. Keep it stable across restarts on one machine and
different on every machine. If you omit it, the SDK uses a new random id, and so a fresh sign-in, on every run.

## Messaging-Only Wallet (no money)

A bot that is only ever a Nostr client — DMs, group chat, a nametag — declines the money
composition explicitly. It needs no wallet-api deployment, no `WALLET_API_URL` in its config and
no device id, and the backend carries no idle authenticated device for it.

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

const base = createNodeProviders({ network: 'testnet2', dataDir: './bot-data' });

const { sphere } = await Sphere.init({
  ...base,               // storage + transport + oracle; no createWalletApiProviders call
  network: 'testnet2',   // still required: it selects the token registry and group-chat relays
  walletApi: 'none',     // explicit: compose no money (#793)
  autoGenerate: true,
  nametag: 'kbbot',
});

sphere.hasPayments;      // false
sphere.payments;         // throws SphereError, code 'PAYMENTS_NOT_COMPOSED'
```

Nothing of the payments vertical runs: no wallet-api session, device registration, wake socket or
mailbox drain, no token engine, and no `pv2g2:` key on disk — at boot and on an address switch
alike. Identity, storage, `communications`, `groupChat` and `registerNametag` are unchanged.

**Omitting `walletApi` is still a refusal, not an opt-out** — `Sphere.init` throws
`INVALID_CONFIG` exactly as before. A dropped environment variable must never be indistinguishable
from a deliberate choice, which is the whole reason the choice has to be sayable.

The opt-out is a composition choice, not a wipe: a wallet that HAS moved money keeps its `pv2g2:`
state on disk, and opening it with `'none'` simply does not resume anything. Open intents stay
open — their sources still reserved on the backend — until it is next opened with a wallet-api
config, which resumes them as usual. Nothing is lost; it is deferred. Don't flip a wallet with
transfers in flight.

## What Gets Created

```
./wallet-data/
  └── wallet.json      # Wallet data (mnemonic stored plaintext or password-encrypted)
                       # + per-address payment journals under pv2g2:* keys
```

Tokens live in the wallet-api backend (server custody) — no local token files.

The `pv2g2:` prefix is 0.15.0's generation of the scoped KV (it was `pv2:` through 0.14.x). The
rename is the migration — the superseded keys are swept once when the wallet composes its
payments vertical, and there is nothing for you to run or delete.

## Configuration Options

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders, createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

// Step 1: Create base providers
const base = createNodeProviders({
  // Network (required): 'mainnet' | 'testnet2'. Use the same literal in all three places.
  // ('testnet' names the same endpoints as 'testnet2' but is a different string.)
  network: 'testnet2',

  // Storage directory (optional, default: './sphere-data')
  dataDir: './wallet-data',

  // Custom wallet file name (default: 'wallet.json'). Keep the JSON format for a wallet
  // you run: a '.txt' name stores ONLY the mnemonic (see "Custom Wallet File Names").
  walletFileName: 'my-wallet.json',

  // Transport options
  transport: {
    relays: ['wss://custom-relay.com'],           // Replace default relays
    additionalRelays: ['wss://extra-relay.com'],  // Add to defaults
    timeout: 5000,
    autoReconnect: true,
    debug: false,
  },

  // Oracle (v2 gateway) options
  oracle: {
    url: 'https://gateway.testnet2.unicity.network',  // Replace default gateway URL
    trustBasePath: './trustbase.json',                // Optional: overrides the embedded trust base; a missing file falls back to it
    apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590',    // Gateway API key (public testnet2 key)
  },

  // Price provider (optional — enables fiat value display)
  price: {
    platform: 'coingecko',    // Currently supported: 'coingecko'
    apiKey: 'CG-xxx',         // Optional (free tier works without key)
    cacheTtlMs: 60000,        // Cache TTL in ms (default: 60s)
  },
});

// Step 2: Attach the wallet-api transport config (required for money)
const providers = createWalletApiProviders(base, {
  baseUrl: 'https://wallet-api.unicity.network',  // testnet2 wallet-api (mainnet: https://wallet-api.mainnet.unicity.network)
  network: 'testnet2',                             // must equal the Sphere network
  deviceId: 'my-service-host-1',                   // stable on this machine, unique per machine (random per run if omitted)
});

// Step 3: Initialize
const { sphere } = await Sphere.init({ ...providers, network: 'testnet2', autoGenerate: true });
```

A trust base read from a file needs the network to fall back to when you build the loader yourself:

```typescript
import { createNodeTrustBaseLoader } from '@unicitylabs/sphere-sdk/impl/nodejs';

const loader = createNodeTrustBaseLoader('./trustbase-testnet2.json', 'testnet2');
const trustBase = await loader.load(); // the file's JSON, or the embedded testnet2 trust base
```

(Via the factory, `createNodeProviders({ network: 'testnet2', oracle: { trustBasePath: './trustbase.json' } })`
passes `network` as that fallback itself.)

## Common Operations

The snippets below assume an initialised `sphere` (see [Minimal Example](#minimal-example)).

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

// Total portfolio value in USD
const totalUsd = assets.reduce((sum, a) => sum + (a.fiatValueUsd ?? 0), 0);
console.log('Total USD:', totalUsd);
```

### Coin IDs

`coinId` is the 64-character hex coin id. The SDK does not resolve symbols on the money path: `coinId: 'UCT'`
matches no coin, so `send()` fails with `SEND_INSUFFICIENT_BALANCE`, and a payment request created with it can
never be paid. Look the id up first: `getCoinIdBySymbol('UCT')` (after `await TokenRegistry.waitForReady()`,
because `Sphere.init` starts the registry load without waiting for it; it returns `undefined` when the symbol is
unknown), or take `coinId` from `sphere.payments.assets()` for a coin the wallet holds.

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

// mint takes the hex coin id, not the symbol
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

> **Note:** The registry is configured automatically by `Sphere.init()`. `createNodeProviders()` does **not** configure it — if you build providers without initialising a Sphere and then read the registry directly, configure it yourself:
>
> ```ts
> import { TokenRegistry, NETWORKS } from '@unicitylabs/sphere-sdk';
>
> TokenRegistry.configure({
>   remoteUrl: NETWORKS.testnet2.tokenRegistryUrl,
>   storage: providers.storage,
> });
> ```
> Data is fetched from the network and cached in the storage provider you pass (the wallet file here).

### Send Tokens

`send()` resolves only when the payment is sent. `result.status` is `'delivered'` when it landed in the
recipient's mailbox, or `'confirmed'` with `result.deliveryPending === true` when the transfer is certified and
delivery is still being retried. That is success, not an error. `send()` never resolves with `'completed'` or
`'failed'`: a failure throws (see [Error Handling](#error-handling)).

```typescript
import { TokenRegistry, getCoinIdBySymbol } from '@unicitylabs/sphere-sdk';

await TokenRegistry.waitForReady();
const coinId = getCoinIdBySymbol('UCT'); // the 64-hex coin id; send() does not resolve symbols
if (!coinId) throw new Error('UCT is not in this network\'s token registry');

// Send to nametag — the sender certifies the transfer on-chain (collects the
// inclusion proof) and delivers a finished token via wallet-api mailbox
const result = await sphere.payments.send({
  recipient: '@alice',
  amount: '1000000',  // In base units
  coinId,
});

console.log('Transfer ID:', result.id);
console.log('Status:', result.status); // 'delivered', or 'confirmed' with deliveryPending === true
if (result.deliveryPending) {
  console.log('Note: certified on-chain, delivery deferred (normal behavior)');
}

// Send to direct address
const result2 = await sphere.payments.send({
  recipient: 'DIRECT://0000be36...',
  amount: '500000',
  coinId,
});
```

Nametag bindings do not carry a network yet, so the SDK cannot prove that a `@nametag` or `DIRECT://` recipient
uses your network. Every such send emits `transfer:attention` with `code: 'recipient:network-unverified'` and an
empty `transferId`, and then proceeds on your network. Treat it as information, not an error; on mainnet, make
sure the recipient runs mainnet. A bare 66-hex chain pubkey recipient is taken as being on your network.

### Fetch Pending Transfers (Explicit Receive)

For batch/CLI apps, use `receive()` to explicitly drain the wallet-api mailbox:

```typescript
// Fetch and process all pending incoming transfers
const { transfers } = await sphere.payments.receive();
console.log(`Received ${transfers.length} transfers`);
for (const transfer of transfers) {
  for (const token of transfer.tokens) {
    console.log(`  ${token.amount} ${token.symbol}`);
  }
  console.log(`From: ${transfer.senderNametag ?? transfer.senderPubkey}`);
}
```

> `receive()` takes no options: transfers arrive as finished tokens, verified against the trust base and stored confirmed immediately — there is no finalization phase. While the wallet runs, the mailbox is also drained automatically.

### Register Nametag

> **Note:** `registerNametag()` registers the name by publishing a Nostr identity binding (name ↔ chain pubkey, first-seen-wins). Runtime name resolution uses only the Nostr binding. No token is minted.

```typescript
// Publishes the Nostr binding; throws if the name is already taken
await sphere.registerNametag('myusername');
console.log('Registered:', sphere.identity?.nametag);
```

### Listen for Incoming Transfers

```typescript
// Handlers receive the event payload directly (IncomingTransfer)
sphere.on('transfer:incoming', (transfer) => {
  for (const token of transfer.tokens) {
    console.log('Received:', token.amount, token.symbol);
  }
  console.log('From:', transfer.senderNametag ?? transfer.senderPubkey);
});
```

### Send Direct Messages

```typescript
await sphere.communications.sendDM('@alice', 'Hello!');

sphere.communications.onDirectMessage((msg) => {
  console.log('Message from', msg.senderNametag ?? msg.senderPubkey, ':', msg.content);
});
```

## Import Existing Wallet

`Sphere.init` loads the wallet that is already in the storage, if there is one, and then ignores `mnemonic`,
`nametag` and `autoGenerate`. To replace the stored wallet with another phrase, use `Sphere.import`, which first
clears the storage's current wallet, including the payment journals of transfers still in flight; do not run it
while transfers are pending. That clear also destroys any live `Sphere` on the same storage.

The samples in this section and the next use `providers` from the [Minimal Example](#minimal-example).

Restore from a mnemonic into an empty storage (plaintext storage, the default):

```typescript
const { sphere } = await Sphere.init({
  ...providers,
  network: 'testnet2',
  mnemonic: 'your twelve word mnemonic phrase here ...',
});
```

The same, with the stored mnemonic encrypted by a password (see [Password Encryption](#password-encryption)):

```typescript
const { sphere } = await Sphere.init({
  ...providers,
  network: 'testnet2',
  mnemonic: 'your twelve word mnemonic phrase here ...',
  password: 'my-secret-password',
});
```

Replace whatever wallet the storage holds, from a master key (legacy). `Sphere.import` returns the `Sphere` itself:

```typescript
const sphere = await Sphere.import({
  masterKey: '64-char-hex-master-key',
  chainCode: '64-char-hex-chain-code',
  basePath: "m/84'/1'/0'",
  derivationMode: 'bip32',
  network: 'testnet2',
  ...providers,
});
```

## Password Encryption

By default, the mnemonic is stored as **plaintext** in `wallet.json`. You can optionally encrypt it with a password.

The wallet keeps its mnemonic (or master key) in the storage provider: IndexedDB in the browser, the wallet file
on Node. If you pass `password` when the wallet is created or imported, the SDK encrypts that value with
CryptoJS's password-based AES-256-CBC, which derives the key with OpenSSL's `EVP_BytesToKey` (MD5, one iteration).
That keeps the phrase out of casual view and out of copies of the storage that are read without the password, but
it is a fast key derivation: anyone who obtains the stored value can try passwords offline at high speed, so a
short or common password gives little protection. Without a password the mnemonic is stored as plaintext. The
other stored data (derivation path, nametags, payment journals) is not encrypted either way. Always set a password
for wallets that hold value, make it long and unique, and protect the storage itself at the operating-system level
(file permissions and disk encryption on servers; the browser profile on clients). `exportToJSON({ password })`
uses the same scheme. There is no call to add or change the password later, and `importFromJSON` /
`importFromLegacyFile` store the imported seed without a password.

Create a wallet with password encryption:

```typescript
const { sphere } = await Sphere.init({
  ...providers,
  network: 'testnet2',
  autoGenerate: true,
  password: 'my-secret-password',
});
```

Load it on later runs with the same password (a wrong or missing one fails with `STORAGE_ERROR`
`'Failed to decrypt mnemonic'`):

```typescript
const { sphere } = await Sphere.init({
  ...providers,
  network: 'testnet2',
  password: 'my-secret-password',
});
```

Load a wallet without a password (plaintext mnemonic, the default):

```typescript
const { sphere } = await Sphere.init({ ...providers, network: 'testnet2' });
```

**Backwards compatibility:** Wallets created with older SDK versions (encrypted with the internal default key) will load correctly without a password.

### Custom Wallet File Names

```typescript
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

// Use a custom file name (JSON, like the default wallet.json)
const base = createNodeProviders({
  network: 'testnet2',
  dataDir: './wallet-data',
  walletFileName: 'my-wallet.json',
});
```

A file name ending in `.txt` switches the file storage to text mode: it reads the file as a bare mnemonic and
writes back **only** the mnemonic. Everything else the wallet stores (tracked addresses, nametags, the
token-registry cache, and the payment journals under `pv2g2:*`: the delivery journal, open-intent records,
payment-request settling links, the wallet-api refresh token and stream cursors) is kept in memory only and is
lost when the process exits, so after a restart the SDK no longer has its local record of transfers that were
still in flight. Keep the JSON format for any wallet you run; to start from a phrase kept in a `.txt` file, read
the phrase and create a JSON wallet from it, as below.

### Loading External Wallet Files

If you have a plaintext mnemonic file from another source, read the phrase and keep the wallet in a JSON wallet file:

```typescript
import { readFileSync } from 'node:fs';
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders, createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

// The phrase from the external file
const mnemonic = readFileSync('./external-mnemonic.txt', 'utf-8').trim();

const base = createNodeProviders({
  network: 'testnet2',
  dataDir: './wallet-data', // the wallet lives in ./wallet-data/wallet.json (JSON mode)
  oracle: {
    apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590',
  },
});

const providers = createWalletApiProviders(base, {
  baseUrl: 'https://wallet-api.unicity.network',
  network: 'testnet2',
  deviceId: 'my-service-host-1', // stable on this machine, unique per machine
});

// Creates the wallet from the phrase when wallet.json holds none; if it already holds
// a wallet, that wallet is loaded and `mnemonic` is ignored (use Sphere.import to replace it).
const { sphere } = await Sphere.init({
  ...providers,
  network: 'testnet2',
  mnemonic,
});
```

## Multi-Address Wallet

```typescript
// Get current address index
const index = sphere.getCurrentAddressIndex(); // 0

// Switch to different address
await sphere.switchToAddress(1);
console.log('New address:', sphere.identity?.directAddress);

// Register nametag for this address
await sphere.registerNametag('myname-work');

// Derive keys without switching: { privateKey, publicKey, path, index } (no address).
// Never log or serialise the whole object: it holds the private key.
const addr = sphere.deriveAddress(2);
console.log(addr.path, addr.publicKey);
```

## Event Handling

```typescript
// The payments vertical emits exactly 8 events; identity/comms events ride the
// same bus (see SphereEventMap in types/index.ts for the full list)
sphere.on('transfer:incoming', handler);        // IncomingTransfer
sphere.on('transfer:updated', handler);         // TransferResult (read status/deliveryPending)
sphere.on('transfer:attention', handler);       // { transferId, code, detail? }
sphere.on('inventory:updated', handler);        // {}
sphere.on('history:updated', handler);          // HistoryEntry (the recorded entry)
sphere.on('payment_request:incoming', handler); // PaymentRequestView
sphere.on('payment_request:updated', handler);  // { id, status } (requests you received)
sphere.on('connection:status', handler);        // { status: 'connected'|'degraded'|'offline' }
sphere.on('message:dm', handler);
sphere.on('message:broadcast', handler);
sphere.on('connection:changed', handler);
sphere.on('nametag:registered', handler);
sphere.on('nametag:recovered', handler);        // recovery during init fires before init resolves
sphere.on('identity:changed', handler);

// Unsubscribe
const unsubscribe = sphere.on('transfer:incoming', handler);
unsubscribe(); // Stop listening
```

## Payment Requests

Request payments over the wallet-api rail (`sphere.payments.requests`). `requests.create()` never throws: it
resolves `{ success, requestId?, error? }`. Never pay from inside the `payment_request:incoming` handler without
a decision: `pay()` and `decline()` are alternatives, and `pay()` rethrows `send()`'s errors (handle them as in
[Error Handling](#error-handling)).

```typescript
import { getCoinIdBySymbol } from '@unicitylabs/sphere-sdk';

// Requester side: create() never throws. It resolves { success, requestId?, error? }.
const coinId = getCoinIdBySymbol('UCT'); // the hex coin id (see "Coin IDs")
if (coinId) {
  const created = await sphere.payments.requests.create('@bob', { coinId, amount: '1000000', memo: 'Order #1234' });
  if (!created.success) console.error(created.error);
}

// Payer side: never pay from the event handler itself. Decide first (a person, or your own policy).
sphere.on('payment_request:incoming', async (request) => {
  // request.amount is a base-unit string and request.coinId the hex coin id; request.symbol is not set here.
  try {
    if (await shouldPay(request)) {
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

`pay()` never leaves a request payable after a possibly-committed failure: before it rethrows such an error it
durably links the request to the transfer and marks it `'settling'`, and a second `pay()` of the same id in the
same process joins the first. That link is written after the send returns or throws, not before it starts. If the
app or process stops while `pay()` is still waiting on the send, no link exists: on the next start the request is
listed as `'pending'` again and `payment_request:incoming` fires again, even if the transfer went through (a transfer
the SDK had already recorded is resumed when the wallet starts). Before paying a request again after a restart, check
`sphere.payments.pendingTransfers()` and `sphere.payments.history()` for a transfer to that requester.

## Transaction History

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

## Error Handling

Some rejections mean the money may already have left the wallet. `isPossiblyCommittedSendOutcome(err)` is `true`
for exactly these codes: `SEND_SYNC_PENDING`, `CERTIFICATION_UNCONFIRMED`, `CHECKPOINT_PERSIST_FAILED`,
`SPLIT_CHECKPOINT_LOST`, `CHECKPOINT_TRUSTBASE_MISMATCH` and `SEND_PARTIALLY_COMPLETED`. Never call `send()` again
for that payment: a new `send()` gets a new transfer id and pays the recipient a second time. The SDK finishes the
original under its own transfer id; show it as pending (`sphere.payments.pendingTransfers()`), and wire any
"retry" button to `sphere.payments.resumeNow()`. A `PartialSendConflictError` means part of the amount was
delivered and is final; only `err.remainingAmount` is still owed. When `isPossiblyCommittedSendOutcome(err)` is
`false`, the SDK's contract is that nothing left the wallet.

```typescript
// Import the error helpers from the same entry point as Sphere (here: the package root).
import { PartialSendConflictError, isPossiblyCommittedSendOutcome } from '@unicitylabs/sphere-sdk';

try {
  const result = await sphere.payments.send({ recipient: '@alice', amount: '1000000', coinId });
  // Resolved means sent: result.status is 'delivered', or 'confirmed' with deliveryPending === true.
  console.log('Sent:', result.id, result.status);
} catch (err) {
  if (err instanceof PartialSendConflictError) {
    // Part of the amount was delivered and is final. Only err.remainingAmount is still owed:
    // if you pay it, do it as a NEW send of exactly that amount, never the original amount.
    console.error(`Partly sent: ${err.remainingAmount} base units were not sent.`);
  } else if (isPossiblyCommittedSendOutcome(err)) {
    // The money may already have left the wallet. Never call send() again for this payment:
    // the SDK completes it under the same transferId.
    console.error('Sent, waiting for confirmation.');
    const pending = await sphere.payments.pendingTransfers(); // what is still converging
    await sphere.payments.resumeNow();                        // the retry verb, never send()
  } else {
    // Nothing left the wallet. Read `code` structurally: errors thrown by the providers
    // (e.g. the Nostr transport) are a different SphereError class copy, so isSphereError() is false for them.
    const code = (err as { code?: unknown } | null)?.code;
    switch (code) {
      case 'SEND_INSUFFICIENT_BALANCE':
        console.error((err as Error).message); // names pinned funds when transfers are converging
        break;
      case 'INVALID_RECIPIENT':
        console.error('Recipient not found');
        break;
      case 'TRANSPORT_ERROR':
        console.error('Could not look up the recipient. Check the connection.');
        break;
      default:
        console.error('Transfer failed:', err instanceof Error ? err.message : String(err));
    }
  }
}
```

## TypeScript Support

Full TypeScript support with exported types:

```typescript
import type {
  Identity,
  FullIdentity,
  StorageProvider,
  TransportProvider,
  OracleProvider,
  ProviderStatus,
  SphereEventType,
} from '@unicitylabs/sphere-sdk';
```

## Custom CLI Example

Build your own CLI tool using the SDK:

```typescript
#!/usr/bin/env node
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders, createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

async function main() {
  const base = createNodeProviders({
    network: 'testnet2',
    dataDir: './my-wallet',
    oracle: {
      apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590',
    },
  });

  const providers = createWalletApiProviders(base, {
    baseUrl: 'https://wallet-api.unicity.network',
    network: 'testnet2',
    deviceId: 'my-cli-host-1', // stable on this machine, unique per machine
  });

  const { sphere, created, generatedMnemonic } = await Sphere.init({
    ...providers,
    network: 'testnet2',
    autoGenerate: true,
  });

  if (created) {
    console.log('\n=== NEW WALLET CREATED ===');
    console.log('Mnemonic (SAVE THIS!):', generatedMnemonic);
    console.log('==========================\n');
  }

  console.log('Direct Address:', sphere.identity?.directAddress);
  console.log('Nametag:', sphere.identity?.nametag || '(not registered)');

  // Listen for incoming transfers (handler receives the IncomingTransfer payload)
  sphere.on('transfer:incoming', (transfer) => {
    console.log('\nIncoming transfer!');
    for (const token of transfer.tokens) {
      console.log('Amount:', token.amount, token.symbol);
    }
    console.log('From:', transfer.senderNametag ?? transfer.senderPubkey);
  });

  // Keep running
  console.log('\nListening for transfers... Press Ctrl+C to exit');

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await sphere.destroy();
    process.exit(0);
  });
}

main().catch(console.error);
```

## Troubleshooting

### "Cannot find module 'ws'"

`@unicitylabs/sphere-sdk/impl/nodejs` imports `ws` when it loads, on every Node version, and npm does not
install it for you (it is an optional peer dependency):
```bash
npm install ws
```

### "Failed to connect to any relay"
Check network connectivity and relay URLs:
```typescript
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

const base = createNodeProviders({
  network: 'testnet2',
  transport: {
    debug: true,  // Enable debug logging
    timeout: 10000,  // Increase timeout
  },
});
```

### Trust base

The mainnet and testnet2 trust bases are embedded in the SDK, so no file is needed. `oracle.trustBasePath` only
overrides them: when that file is missing or unreadable, the loader falls back to the embedded trust base for
`network` without an error.

### Data not persisting
The file storage creates `dataDir` itself; make sure the process can write to it. A wallet file whose name ends
in `.txt` persists only the mnemonic (see [Custom Wallet File Names](#custom-wallet-file-names)).

### Debug Logging

Enable SDK debug logging to diagnose issues:

```typescript
import fs from 'node:fs';
import { logger } from '@unicitylabs/sphere-sdk';

// Enable all debug logging
logger.configure({ debug: true });

// Enable only specific modules
logger.setTagDebug('Nostr', true);      // Transport logs
logger.setTagDebug('PaymentsV2', true); // Payment logs

// Custom log handler (e.g., write to file)
logger.configure({
  debug: true,
  handler: (level, tag, message, ...args) => {
    fs.appendFileSync('sdk.log', `[${level}] [${tag}] ${message}\n`);
  },
});
```

## Next Steps

- [API Reference](./API.md) - Full API documentation
- [Integration Guide](./INTEGRATION.md) - Advanced integration patterns, and [Upgrading to 0.15.0](./INTEGRATION.md#upgrading-to-0150)
- [Connect Protocol](./CONNECT.md) - dApp ↔ wallet RPC (protocol version `2.3`)
- [Parallel token verification](./VERIFICATION-WORKERS.md) - The opt-in worker pool
- [Browser Quick Start](./QUICKSTART-BROWSER.md) - For web applications
