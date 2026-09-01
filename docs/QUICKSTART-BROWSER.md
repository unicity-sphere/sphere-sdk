# Sphere SDK - Browser Quick Start

> **On 0.15.0.** The base SDK pin moved to `@unicitylabs/state-transition-sdk@3.0.1` — a wire
> break that no client can straddle, so your wallet-api deployment has to bump with you (see the
> [flag-day section](../README.md#0150--the-state-transition-sdk-301-flag-day)). What that
> changes in this guide is `sphere.paymentsV2` — the alias is **removed**, and `sphere.payments`
> **throws** `NOT_INITIALIZED` where the alias returned `null` while no vertical was running —
> plus the payment-journal key prefix below (`pv2:` → `pv2g2:`, swept for you). Everything else
> is untouched, and everything below already uses `sphere.payments`.

Get up and running with Sphere SDK in web applications in under 5 minutes.

## Installation

```bash
npm install @unicitylabs/sphere-sdk
```

| Package | Required | Description |
|---------|----------|-------------|
| `@unicitylabs/sphere-sdk` | Yes | The SDK |

**That's it!** No additional dependencies for basic usage. Browser uses native WebSocket.

> **Note:** No API key is bundled with the SDK. The `testnet` gateway (testnet2, see below) requires one — inject it via `oracle: { apiKey: '...' }`. The testnet2 key is **not a secret** (see `.env.example`): `sk_ddc3cfcc001e4a28ac3fad7407f99590`. A mainnet key, by contrast, IS a secret — keep it in your deploy environment only.
>
> **Networks:** the live networks are **testnet2** and **mainnet**. `network: 'testnet'` is an alias of testnet2 (`https://gateway.testnet2.unicity.network`; the network id comes from the trust base). `mainnet` runs against `https://gateway.mainnet.unicity.network` (network id 1) — the chain and gateway are live, but there is no mainnet wallet-api deployment yet, so `Sphere.init` cannot complete a mainnet money path. The v1 network is discontinued and the `dev` preset has been removed — passing it is now a type error. The "2" in testnet2 names the **gateway network**, not the base-SDK major: testnet2 is still testnet2 on state-transition-sdk 3.x.

## Framework Setup

### Vanilla JavaScript / TypeScript

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createBrowserProviders } from '@unicitylabs/sphere-sdk/impl/browser';
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';

async function initWallet() {
  // Step 1: Create base providers (storage + transport + oracle)
  const base = createBrowserProviders({
    network: 'testnet',
    oracle: { apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590' }, // public testnet2 key
  });

  // Step 2: Attach the wallet-api transport config (REQUIRED — Sphere.init
  //         throws INVALID_CONFIG without it; money rides the wallet-api vertical)
  const providers = createWalletApiProviders(base, {
    baseUrl: 'https://wallet-api.unicity.network',
    network: 'testnet2',
    deviceId: 'my-stable-device-id', // Must be stable across sessions
  });

  // Step 3: Initialize wallet
  const { sphere, created, generatedMnemonic } = await Sphere.init({
    ...providers,
    autoGenerate: true,
  });

  if (created && generatedMnemonic) {
    // IMPORTANT: Show to user and ask them to save it!
    alert('Save your recovery phrase: ' + generatedMnemonic);
  }

  return sphere;
}
```

### React

```tsx
import { useState, useEffect } from 'react';
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createBrowserProviders } from '@unicitylabs/sphere-sdk/impl/browser';
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';

function useWallet() {
  const [sphere, setSphere] = useState<Sphere | null>(null);
  const [loading, setLoading] = useState(true);
  const [mnemonic, setMnemonic] = useState<string | null>(null);

  useEffect(() => {
    const init = async () => {
      // Step 1: Create base providers
      const base = createBrowserProviders({
        network: 'testnet',
        oracle: { apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590' }, // public testnet2 key
      });

      // Step 2: Attach the wallet-api transport config (REQUIRED — money rides the wallet-api vertical)
      const providers = createWalletApiProviders(base, {
        baseUrl: 'https://wallet-api.unicity.network',
        network: 'testnet2',
        deviceId: 'my-stable-device-id',
      });

      // Step 3: Initialize wallet
      const { sphere, created, generatedMnemonic } = await Sphere.init({
        ...providers,
        autoGenerate: true,
      });

      if (created && generatedMnemonic) {
        setMnemonic(generatedMnemonic);
      }

      setSphere(sphere);
      setLoading(false);
    };

    init();

    return () => {
      sphere?.destroy();
    };
  }, []);

  return { sphere, loading, mnemonic };
}

function App() {
  const { sphere, loading, mnemonic } = useWallet();

  if (loading) return <div>Loading wallet...</div>;

  if (mnemonic) {
    return (
      <div>
        <h2>Save your recovery phrase!</h2>
        <code>{mnemonic}</code>
        <button onClick={() => /* clear mnemonic after user confirms */}>
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
import { ref, onMounted, onUnmounted } from 'vue';
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createBrowserProviders } from '@unicitylabs/sphere-sdk/impl/browser';
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';

const sphere = ref<Sphere | null>(null);
const loading = ref(true);
const mnemonic = ref<string | null>(null);

onMounted(async () => {
  // Step 1: Create base providers
  const base = createBrowserProviders({
    network: 'testnet',
    oracle: { apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590' }, // public testnet2 key
  });

  // Step 2: Attach the wallet-api transport config (REQUIRED — money rides the wallet-api vertical)
  const providers = createWalletApiProviders(base, {
    baseUrl: 'https://wallet-api.unicity.network',
    network: 'testnet2',
    deviceId: 'my-stable-device-id',
  });

  // Step 3: Initialize wallet
  const result = await Sphere.init({
    ...providers,
    autoGenerate: true,
  });

  if (result.created && result.generatedMnemonic) {
    mnemonic.value = result.generatedMnemonic;
  }

  sphere.value = result.sphere;
  loading.value = false;
});

onUnmounted(() => {
  sphere.value?.destroy();
});
</script>

<template>
  <div v-if="loading">Loading wallet...</div>
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

```tsx
'use client';

import { useState, useEffect } from 'react';
import { Sphere } from '@unicitylabs/sphere-sdk';

// Dynamic import to avoid SSR issues
async function initWallet() {
  const { createBrowserProviders } = await import(
    '@unicitylabs/sphere-sdk/impl/browser'
  );
  const { createWalletApiProviders } = await import(
    '@unicitylabs/sphere-sdk/impl/shared/wallet-api'
  );

  // Step 1: Create base providers
  const base = createBrowserProviders({
    network: 'testnet',
    oracle: { apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590' }, // public testnet2 key
  });

  // Step 2: Attach the wallet-api transport config (REQUIRED — money rides the wallet-api vertical)
  const providers = createWalletApiProviders(base, {
    baseUrl: 'https://wallet-api.unicity.network',
    network: 'testnet2',
    deviceId: 'my-stable-device-id',
  });

  // Step 3: Initialize wallet
  return Sphere.init({
    ...providers,
    autoGenerate: true,
  });
}

export default function WalletPage() {
  const [sphere, setSphere] = useState<Sphere | null>(null);

  useEffect(() => {
    initWallet().then(({ sphere }) => setSphere(sphere));
    return () => { sphere?.destroy(); };
  }, []);

  if (!sphere) return <div>Loading...</div>;

  return <div>Address: {sphere.identity?.directAddress}</div>;
}
```

## Storage & Delivery

Where the wallet's data lives:

| Data | Storage | Persistence | Role |
|------|---------|-------------|------|
| Wallet (mnemonic, nametag) + payment journals (`pv2g2:*`) | `localStorage` / `IndexedDB` | Per-domain, survives refresh | Local secrets + durable payment state |
| Token inventory + transfer intents + mailbox + history | Wallet API | Server-backed, cross-device | Custody + delivery + record |

**SSR Note:** If `localStorage` is unavailable (SSR), an in-memory fallback is used.

**Wallet-API delivery:** incoming certified transfers land in your wallet-api mailbox; the SDK drains it continuously while running (wake WebSocket + poll) and verifies every token against the trust base before it enters the balance. Nostr is messaging only, not the payment rail.

**Payment-journal keys:** the `pv2g2:` prefix is 0.15.0's generation of the scoped KV (it was `pv2:` through 0.14.x). The rename is the migration — the superseded keys are swept once when the wallet composes its payments vertical, and there is nothing for you to run.

## Configuration Options

```typescript
import { createBrowserProviders } from '@unicitylabs/sphere-sdk/impl/browser';
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';

// Step 1: Base providers (required for network, oracle, transport)
const base = createBrowserProviders({
  // Network: 'mainnet' | 'testnet' | 'testnet2'
  // ('testnet' IS testnet2 — the v2 gateway network. 'mainnet' is live on-chain
  //  but has no wallet-api deployment yet, so its money path is unreachable.)
  network: 'testnet',

  // Transport options
  transport: {
    relays: ['wss://custom-relay.com'],           // Replace defaults
    additionalRelays: ['wss://extra-relay.com'],  // Add to defaults
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
  baseUrl: 'https://wallet-api.unicity.network', // Canonical testnet2 host
  network: 'testnet2',
  deviceId: 'my-stable-device-id',               // Must be stable across sessions
});

// Step 3: Initialize wallet with the composed providers
const { sphere } = await Sphere.init({
  ...providers,
  autoGenerate: true,
});
```

## Common Operations

### Display Wallet Info

```typescript
const identity = sphere.identity;

console.log('L3 Address:', identity?.directAddress);  // DIRECT://...
console.log('Public Key:', identity?.chainPubkey);    // 02abc...
console.log('Nametag:', identity?.nametag);           // @username
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

// Total portfolio value in USD (price fields are null without PriceProvider)
const totalUsd = assets.reduce((sum, a) => sum + (a.fiatValueUsd ?? 0), 0);
document.getElementById('balance').textContent = `$${totalUsd.toFixed(2)}`;
```

### Top Up (Testnet Self-Mint)

There is no faucet — on testnet you top up by **self-minting** tokens via the token engine:

```typescript
import { TokenRegistry } from '@unicitylabs/sphere-sdk';

// mint takes the hex coin id, not the symbol
const coinId = TokenRegistry.getInstance().getCoinIdBySymbol('UCT');
const res = await sphere.payments.mint(coinId!, 100_000_000n);
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

const registry = TokenRegistry.getInstance();

// List all registered assets
const allAssets = registry.getAllDefinitions();
const coins = registry.getFungibleTokens();
const nfts = registry.getNonFungibleTokens();

// Look up a specific asset
const uct = registry.getDefinitionBySymbol('UCT');
console.log(uct?.name, uct?.decimals);  // 'Unicity Token', 8

// Reverse lookup: symbol → coin ID
const coinId = registry.getCoinIdBySymbol('UCT');
```

> **Note:** The registry is configured automatically by `createBrowserProviders()` and `Sphere.init()`. Data is fetched from the network and cached in `localStorage`.

### Send Tokens

```typescript
import { isSphereError } from '@unicitylabs/sphere-sdk';

async function sendTokens(recipient: string, amount: string) {
  try {
    const result = await sphere.payments.send({
      coinId: 'UCT',
      amount: '1000000',
      recipient: '@alice',
    });
    
    // Transfer is certified on-chain, now awaiting recipient mailbox delivery
    console.log('Status:', result.status);  // 'pending', 'submitted', 'confirmed', 'delivered', 'completed', etc.
    
    // deliveryPending=true means certified but recipient delivery deferred (NORMAL, not a failure)
    if (result.deliveryPending) {
      console.log('Transfer certified; recipient mailbox delivery in progress...');
    }
    
    showToast('Sent!');
  } catch (error) {
    if (isSphereError(error)) {
      switch (error.code) {
        case 'INSUFFICIENT_BALANCE': showToast('Not enough funds'); break;
        case 'INVALID_RECIPIENT': showToast('Recipient not found'); break;
        case 'TRANSPORT_ERROR': showToast('Network issue, try again'); break;
        default: showToast(error.message);
      }
    } else {
      showToast('Something went wrong');
    }
  }
}
```

### Fetch Pending Transfers

For explicit receive (useful in batch operations or when you need to poll):

```typescript
const { transfers } = await sphere.payments.receive();
console.log(`Received ${transfers.length} new transfers`);
```

> `receive()` takes no options: transfers arrive as finished tokens, verified and stored confirmed immediately — there is no finalization phase. While the wallet runs, the mailbox is also drained automatically (you rarely need to call this).

### Register Nametag

> **Note:** `registerNametag()` registers the name by publishing a Nostr identity binding (name ↔ chain pubkey, first-seen-wins). Runtime name resolution uses only the Nostr binding.

```typescript
async function registerNametag(username: string) {
  // Publishes the Nostr binding; throws if the name is already taken
  await sphere.registerNametag(username);
  console.log('Registered:', sphere.identity?.nametag);
}

// Alternative: register during init
const { sphere } = await Sphere.init({
  ...providers,
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

Request payments over the wallet-api rail (`sphere.payments.requests`):

```typescript
// Send a payment request (memo travels in an encrypted envelope)
const result = await sphere.payments.requests.create('@bob', {
  coinId: 'UCT',
  amount: '1000000',
  memo: 'Order #1234',
});

// Track outgoing request status
sphere.on('payment_request:updated', ({ id, status }) => {
  // 'pending' | 'settling' | 'paid' | 'rejected' | 'expired'
  console.log(`Request ${id}: ${status}`);
});

// Handle incoming requests
sphere.on('payment_request:incoming', async (request) => {
  console.log(`${request.senderNametag} requests ${request.amount} ${request.symbol}`);
  await sphere.payments.requests.pay(request.id);      // pay...
  // await sphere.payments.requests.decline(request.id); // ...or decline
});

// Current views + housekeeping
const requests = sphere.payments.requests.list();
sphere.payments.requests.dismissProcessed();
```

> Paying is crash-safe: a request is durably `settling` before any possibly-committed
> error can surface, so a reload never double-pays.

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

```typescript
// From mnemonic (recovery, plaintext storage — default)
const { sphere } = await Sphere.init({
  ...providers,
  mnemonic: 'word1 word2 word3 ... word12',
});

// From mnemonic with password encryption
const { sphere } = await Sphere.init({
  ...providers,
  mnemonic: 'word1 word2 word3 ... word12',
  password: 'my-secret-password',
});

// Load existing wallet with password
const { sphere } = await Sphere.init({
  ...providers,
  password: 'my-secret-password',
});

// Nametag will be auto-recovered from Nostr if it was registered
sphere.on('nametag:recovered', (data) => {
  console.log('Recovered nametag:', data.nametag);
});
```

## Complete React Example

```tsx
import { useState, useEffect, useCallback } from 'react';
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createBrowserProviders } from '@unicitylabs/sphere-sdk/impl/browser';
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';

function WalletApp() {
  const [sphere, setSphere] = useState<Sphere | null>(null);
  const [balance, setBalance] = useState<string>('0');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [status, setStatus] = useState('Loading...');

  // Initialize wallet
  useEffect(() => {
    const init = async () => {
      // Step 1: Create base providers
      const base = createBrowserProviders({
        network: 'testnet',
        oracle: { apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590' },
      });

      // Step 2: Attach the wallet-api transport config (REQUIRED — money rides the wallet-api vertical)
      const providers = createWalletApiProviders(base, {
        baseUrl: 'https://wallet-api.unicity.network',
        network: 'testnet2',
        deviceId: 'my-stable-device-id',
      });

      // Step 3: Initialize wallet
      const { sphere, created, generatedMnemonic } = await Sphere.init({
        ...providers,
        autoGenerate: true,
      });

      if (created && generatedMnemonic) {
        // In production, show modal to save mnemonic
        console.log('NEW WALLET - Save mnemonic:', generatedMnemonic);
      }

      setSphere(sphere);
      setStatus('Connected');

      // Load balance (total USD value; price fields need a PriceProvider)
      const sumFiat = async () => {
        const assets = await sphere.payments.assets();
        return assets.reduce((sum, a) => sum + (a.fiatValueUsd ?? 0), 0);
      };
      setBalance(`$${(await sumFiat()).toFixed(2)}`);

      // Listen for incoming
      sphere.on('transfer:incoming', async () => {
        setBalance(`$${(await sumFiat()).toFixed(2)}`);
      });
    };

    init().catch((err) => setStatus('Error: ' + err.message));

    return () => { sphere?.destroy(); };
  }, []);

  // Send tokens
  const handleSend = useCallback(async () => {
    if (!sphere || !recipient || !amount) return;

    setStatus('Sending...');
    try {
      const result = await sphere.payments.send({
        recipient,
        amount,
        coinId: 'UCT',
      });
      
      setStatus(result.deliveryPending ? 'Sent (delivery in progress)' : 'Sent!');
      setRecipient('');
      setAmount('');

      // Refresh balance
      const assets = await sphere.payments.assets();
      setBalance(`$${assets.reduce((s, a) => s + (a.fiatValueUsd ?? 0), 0).toFixed(2)}`);
    } catch (err: any) {
      setStatus('Error: ' + err.message);
    }
  }, [sphere, recipient, amount]);

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
            <h3>Send Tokens</h3>
            <input
              placeholder="@recipient or address"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
            />
            <input
              placeholder="Amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <button onClick={handleSend}>Send</button>
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
const mnemonic = 'word1 word2 word3...';

// GOOD - Let user input it
const mnemonic = document.getElementById('mnemonicInput').value;
```

### Prompt User to Save Mnemonic

```typescript
if (created && generatedMnemonic) {
  // Show modal, not just console.log
  showMnemonicModal(generatedMnemonic);
}
```

### Clear Sensitive Data

```typescript
// When user logs out
await sphere.destroy();

// Optionally clear all SDK-owned wallet data (keys + payment journals;
// also sweeps orphaned pre-flip token databases)
await Sphere.clear({ storage: providers.storage });
```

### Use HTTPS

Always serve your app over HTTPS in production.

## Troubleshooting

### "localStorage is not defined" (SSR)

Use dynamic import:
```typescript
const { createBrowserProviders } = await import(
  '@unicitylabs/sphere-sdk/impl/browser'
);
const { createWalletApiProviders } = await import(
  '@unicitylabs/sphere-sdk/impl/shared/wallet-api'
);
```

### "Buffer is not defined"

Install and configure polyfill:
```bash
npm install buffer
```

Add to your entry point:
```typescript
import { Buffer } from 'buffer';
window.Buffer = Buffer;
```

### CORS Errors

If aggregator/relay requests fail with CORS:
- Check if URLs are correct for your network
- Use a proxy in development
- Contact relay/aggregator operators

### IndexedDB Errors

```typescript
// Check if IndexedDB is available
if (!window.indexedDB) {
  console.warn('IndexedDB not supported, tokens won\'t persist');
}
```

### WebSocket Connection Failed

```typescript
const base = createBrowserProviders({
  network: 'testnet',
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

| Browser | Version | Notes |
|---------|---------|-------|
| Chrome | 89+ | Full support |
| Firefox | 89+ | Full support |
| Safari | 15+ | Full support |
| Edge | 89+ | Full support |
| Mobile Chrome | 89+ | Full support |
| Mobile Safari | 15+ | Full support |

**Required APIs:** `localStorage`, `IndexedDB`, `WebSocket`, `fetch`, `crypto.subtle`

## Next Steps

- [API Reference](./API.md) - Full API documentation
- [Integration Guide](./INTEGRATION.md) - Advanced integration patterns, and [Upgrading to 0.15.0](./INTEGRATION.md#upgrading-to-0150)
- [Connect Protocol](./CONNECT.md) - dApp ↔ wallet RPC (protocol version `2.1`)
- [Parallel token verification](./VERIFICATION-WORKERS.md) - The opt-in worker pool
- [Node.js Quick Start](./QUICKSTART-NODEJS.md) - For server-side usage
