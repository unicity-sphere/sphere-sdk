# Sphere SDK - Browser Quick Start

Get up and running with Sphere SDK in web applications in under 5 minutes.

## Installation

```bash
npm install @unicitylabs/sphere-sdk
```

| Package | Required | Description |
|---------|----------|-------------|
| `@unicitylabs/sphere-sdk` | Yes | The SDK |

**That's it!** No additional dependencies for basic usage. Browser uses native WebSocket. IPFS sync is built-in — no extra packages needed.

> **Note:** API key for aggregator is included by default. For custom deployments, configure via `oracle: { apiKey: 'your-key' }`.

## Framework Setup

### Vanilla JavaScript / TypeScript

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createBrowserProviders } from '@unicitylabs/sphere-sdk/impl/browser';

async function initWallet() {
  const providers = createBrowserProviders({ network: 'testnet' });

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

function useWallet() {
  const [sphere, setSphere] = useState<Sphere | null>(null);
  const [loading, setLoading] = useState(true);
  const [mnemonic, setMnemonic] = useState<string | null>(null);

  useEffect(() => {
    const init = async () => {
      const providers = createBrowserProviders({ network: 'testnet' });

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
      <p>Address: {sphere?.identity?.l1Address}</p>
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

const sphere = ref<Sphere | null>(null);
const loading = ref(true);
const mnemonic = ref<string | null>(null);

onMounted(async () => {
  const providers = createBrowserProviders({ network: 'testnet' });

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
    <p>Address: {{ sphere?.identity?.l1Address }}</p>
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

  const providers = createBrowserProviders({ network: 'testnet' });

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

  return <div>Address: {sphere.identity?.l1Address}</div>;
}
```

## Storage

Browser SDK uses two storage mechanisms automatically:

| Data | Storage | Persistence |
|------|---------|-------------|
| Wallet (mnemonic, nametag) | `localStorage` | Per-domain, survives refresh |
| Tokens | `IndexedDB` | Per-domain, larger capacity |

**SSR Note:** If `localStorage` is unavailable (SSR), an in-memory fallback is used.

## Configuration Options

```typescript
const providers = createBrowserProviders({
  // Network: 'mainnet' | 'testnet' | 'dev'
  network: 'testnet',

  // Transport options
  transport: {
    relays: ['wss://custom-relay.com'],           // Replace defaults
    additionalRelays: ['wss://extra-relay.com'],  // Add to defaults
    timeout: 5000,
    autoReconnect: true,
    debug: false,
  },

  // Oracle options
  oracle: {
    aggregatorUrl: 'https://custom-aggregator.com/rpc',
    trustBaseUrl: '/trustbase.json',  // Fetch from your server
    apiKey: 'your-api-key',
  },

  // L1 blockchain options
  l1: {
    electrumUrl: 'wss://custom-electrum:50004',
    enableVesting: true,
  },

  // Price provider (optional — enables fiat value display)
  price: {
    platform: 'coingecko',    // Currently supported: 'coingecko'
    apiKey: 'CG-xxx',         // Optional (free tier works without key)
    cacheTtlMs: 60000,        // Cache TTL in ms (default: 60s)
  },

  // Market module (optional — intent bulletin board)
  market: true,  // or { apiUrl: 'https://market-api.unicity.network', timeout: 30000 }

  // Token sync (optional IPFS)
  tokenSync: {
    ipfs: {
      enabled: true,
      additionalGateways: ['https://my-ipfs-gateway.com'],
    },
  },
});
```

## Common Operations

### Display Wallet Info

```typescript
const identity = sphere.identity;

console.log('L1 Address:', identity?.l1Address);      // alpha1...
console.log('L3 Address:', identity?.directAddress);  // DIRECT://...
console.log('Public Key:', identity?.chainPubkey);    // 02abc...
console.log('Nametag:', identity?.nametag);           // @username
```

### Check Balance & Assets

```typescript
// Get assets with price data (price fields are null without PriceProvider)
const assets = await sphere.payments.getAssets();
for (const asset of assets) {
  console.log(`${asset.symbol}: ${asset.totalAmount} (${asset.tokenCount} tokens)`);
  if (asset.fiatValueUsd != null) {
    console.log(`  Value: $${asset.fiatValueUsd.toFixed(2)}`);
  }
}

// Total portfolio value in USD (null if PriceProvider not configured)
const totalUsd = await sphere.payments.getFiatBalance();
document.getElementById('balance').textContent =
  totalUsd != null ? `$${totalUsd.toFixed(2)}` : 'N/A';

// L1 (ALPHA) balance
const l1Balance = await sphere.payments.l1.getBalance();
```

### Send Tokens

```typescript
async function sendTokens(recipient: string, amount: string) {
  try {
    const result = await sphere.payments.send({
      recipient,  // '@alice' or 'DIRECT://...'
      amount,
      coinId: 'UCT',
      // transferMode: 'instant',      // default — fast send, receiver resolves proofs
      // transferMode: 'conservative', // collect all proofs first, then deliver
    });
    console.log('Sent! Transfers:', result.tokenTransfers);
  } catch (error) {
    console.error('Failed:', error.message);
  }
}
```

### Fetch Pending Transfers

For explicit receive (useful in batch operations or when you need to poll):

```typescript
const { transfers } = await sphere.payments.receive();
console.log(`Received ${transfers.length} new transfers`);
```

### Register Nametag

> **Note:** `registerNametag()` mints a token on-chain. This uses the Oracle (Aggregator) provider which is included by default with `createBrowserProviders()`.

```typescript
async function registerNametag(username: string) {
  // This registers on Nostr AND mints token on-chain
  await sphere.registerNametag(username);
  console.log('Registered:', sphere.identity?.nametag);
}

// Alternative: register during init (also mints token)
const { sphere } = await Sphere.init({
  ...providers,
  autoGenerate: true,
  nametag: 'alice',  // Mints token on-chain!
});
```

### Listen for Events

```typescript
// Incoming transfers
sphere.on('transfer:incoming', (transfer) => {
  showNotification(`Received ${transfer.tokens.length} token(s) from ${transfer.senderNametag ?? transfer.senderPubkey}`);
});

// Direct messages
sphere.communications.onDirectMessage((msg) => {
  showNotification(`Message from ${msg.senderNametag ?? msg.senderPubkey}: ${msg.content}`);
});

// Connection status
sphere.on('connection:changed', ({ connected }) => {
  updateConnectionStatus(connected);
});
```

### Send Direct Message

```typescript
await sphere.communications.sendDM('@alice', 'Hello from the browser!');
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
sphere.on('nametag:recovered', ({ nametag }) => {
  console.log('Recovered nametag:', nametag);
});
```

## Complete React Example

```tsx
import { useState, useEffect, useCallback } from 'react';
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createBrowserProviders } from '@unicitylabs/sphere-sdk/impl/browser';

function WalletApp() {
  const [sphere, setSphere] = useState<Sphere | null>(null);
  const [balance, setBalance] = useState<string>('0');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [status, setStatus] = useState('Loading...');

  // Initialize wallet
  useEffect(() => {
    const init = async () => {
      const providers = createBrowserProviders({ network: 'testnet' });
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

      // Load balance (total USD value, null if no PriceProvider)
      const bal = await sphere.payments.getFiatBalance();
      setBalance(bal != null ? `$${bal.toFixed(2)}` : 'N/A');

      // Listen for incoming
      sphere.on('transfer:incoming', async () => {
        const newBal = await sphere.payments.getFiatBalance();
        setBalance(newBal != null ? `$${newBal.toFixed(2)}` : 'N/A');
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
      await sphere.payments.send({
        recipient,
        amount,
        coinId: 'UCT',
      });
      setStatus('Sent!');
      setRecipient('');
      setAmount('');

      // Refresh balance
      const bal = await sphere.payments.getFiatBalance();
      setBalance(bal != null ? `$${bal.toFixed(2)}` : 'N/A');
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
            <strong>Address:</strong> {sphere.identity?.l1Address}
            <br />
            <strong>Nametag:</strong> {sphere.identity?.nametag || 'Not registered'}
            <br />
            <strong>Balance:</strong> {balance} UCT
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

// Optionally clear storage
localStorage.clear();
indexedDB.deleteDatabase('sphere-tokens');
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
const providers = createBrowserProviders({
  network: 'testnet',
  transport: {
    debug: true,           // Enable logging
    timeout: 10000,        // Increase timeout
    autoReconnect: true,   // Auto-retry
  },
});
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
- [Integration Guide](./INTEGRATION.md) - Advanced integration patterns
- [IPFS Storage Guide](./IPFS-STORAGE.md) - IPFS/IPNS token sync configuration
- [Node.js Quick Start](./QUICKSTART-NODEJS.md) - For server-side usage
