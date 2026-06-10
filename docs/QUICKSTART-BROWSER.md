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

> **Note:** No API key is bundled with the SDK. The `testnet` gateway (testnet2, see below) requires one — inject it via `oracle: { apiKey: '...' }`. The testnet2 key is **not a secret** (see `.env.example`): `sk_ddc3cfcc001e4a28ac3fad7407f99590`. A mainnet key, by contrast, IS a secret — keep it in your deploy environment only.
>
> **Networks:** since the v1→v2 cutover, `network: 'testnet'` points at the **testnet2 v2 gateway** (`https://gateway.testnet2.unicity.network`; the network id comes from the trust base). `'testnet2'` is an alias of the same configuration. `mainnet`/`dev` still point at v1-era aggregators and cannot serve the v2 engine yet — wallet operations there fail with `AGGREGATOR_ERROR`.

## Framework Setup

### Vanilla JavaScript / TypeScript

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createBrowserProviders } from '@unicitylabs/sphere-sdk/impl/browser';

async function initWallet() {
  const providers = createBrowserProviders({
    network: 'testnet',
    oracle: { apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590' }, // public testnet2 key
  });

  const { sphere, created, generatedMnemonic } = await Sphere.init({
    ...providers,
    network: 'testnet', // required — Sphere.init throws without it
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
        network: 'testnet',
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
    network: 'testnet',
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
    network: 'testnet',
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
  // Network: 'mainnet' | 'testnet' | 'testnet2' | 'dev'
  // ('testnet' IS testnet2 — the v2 gateway; mainnet/dev are still v1-era and
  //  cannot serve the v2 engine yet)
  network: 'testnet',

  // Transport options
  transport: {
    relays: ['wss://custom-relay.com'],           // Replace defaults
    additionalRelays: ['wss://extra-relay.com'],  // Add to defaults
    timeout: 5000,
    autoReconnect: true,
    debug: false,
  },

  // Oracle (v2 gateway) options
  oracle: {
    url: 'https://gateway.testnet2.unicity.network',   // Replace default gateway URL
    apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590',     // Gateway API key (public testnet2 key)
  },
  // For a custom trust base URL, build the oracle directly with
  // createUnicityAggregatorProvider({ url, apiKey, trustBaseUrl, network })
  // from '@unicitylabs/sphere-sdk/impl/browser'.

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

// Per-coin balances (synchronous, no price data)
const balances = sphere.payments.getBalance();

// Total portfolio value in USD (null if PriceProvider not configured)
const totalUsd = await sphere.payments.getFiatBalance();
document.getElementById('balance').textContent =
  totalUsd != null ? `$${totalUsd.toFixed(2)}` : 'N/A';

// L1 (ALPHA) balance (payments.l1 is null when L1 is disabled via l1: null)
const l1Balance = await sphere.payments.l1?.getBalance();
```

### Top Up (Testnet Self-Mint)

There is no faucet — on testnet you top up by **self-minting** tokens via the v2 token engine:

```typescript
import { TokenRegistry } from '@unicitylabs/sphere-sdk';

// mintFungibleToken takes the hex coin id, not the symbol
const coinId = TokenRegistry.getInstance().getCoinIdBySymbol('UCT');
const res = await sphere.payments.mintFungibleToken(coinId!, 100_000_000n);
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
const coins = registry.getFungibleDefinitions();
const nfts = registry.getNonFungibleDefinitions();

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
    await sphere.payments.send({
      coinId: 'UCT',
      amount: '1000000',
      recipient: '@alice',
    });
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

> The legacy `ReceiveOptions` (`finalize`, `timeout`, `pollInterval`) are deprecated **no-ops**: v2 transfers arrive as finished tokens and are stored confirmed immediately — there is no finalization phase.

### Register Nametag

> **Note:** `registerNametag()` registers the name by publishing a Nostr identity binding (name ↔ chain pubkey, first-seen-wins). A self-issued v2 Unicity ID token is additionally minted and stored **best-effort** — registration never fails because of it. Runtime name resolution uses only the Nostr binding.

```typescript
async function registerNametag(username: string) {
  // Publishes the Nostr binding; throws if the name is already taken
  await sphere.registerNametag(username);
  console.log('Registered:', sphere.identity?.nametag);
}

// Alternative: register during init
const { sphere } = await Sphere.init({
  ...providers,
  network: 'testnet',
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

### Invoicing

Enable the accounting module when initializing the wallet:

```typescript
const { sphere } = await Sphere.init({
  ...providers,
  network: 'testnet',
  autoGenerate: true,
  accounting: true,  // Enable with defaults
});
```

**Create an invoice** (mints an invoice data token via the v2 token engine):

```typescript
const result = await sphere.accounting!.createInvoice({
  targets: [
    {
      address: sphere.identity!.directAddress!,  // Pay to self (your DIRECT:// address)
      assets: [
        { coin: ['UCT', '5000000'] },             // Request 5 UCT (in smallest units)
      ],
    },
  ],
  memo: 'Order #1234',
  dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000, // Due in 7 days
});

console.log('Invoice ID:', result.invoiceId);
```

**Check invoice status:**

```typescript
const status = await sphere.accounting!.getInvoiceStatus(result.invoiceId!);
// status.state: 'OPEN' | 'PARTIAL' | 'COVERED' | 'CLOSED' | 'CANCELLED' | 'EXPIRED'
console.log('State:', status.state);
```

**Pay an invoice** (as the payer, after importing the invoice token):

```typescript
const transferResult = await sphere.accounting!.payInvoice(invoiceId, {
  targetIndex: 0,  // Which target to pay (index into invoice.targets)
  // amount: '5000000',  // Omit to pay the full remaining amount
});
```

**Close an invoice** (only target parties may close):

```typescript
await sphere.accounting!.closeInvoice(invoiceId);
```

**List invoices:**

```typescript
const invoices = await sphere.accounting!.getInvoices({ createdByMe: true });
for (const ref of invoices) {
  console.log(ref.invoiceId, ref.terms.memo, ref.closed ? 'CLOSED' : 'OPEN');
}
```

**Listen for invoice events:**

```typescript
sphere.on('invoice:payment', (data) => {
  console.log(`Payment received for invoice ${data.invoiceId}`);
});

sphere.on('invoice:covered', (data) => {
  console.log(`Invoice ${data.invoiceId} fully covered!`);
});
```

> **Note:** `createInvoice()` requires the Oracle provider (v2 gateway config), which is included automatically by `createBrowserProviders()`.

### Token Swaps

The swap module enables trustless two-party token exchanges via an escrow service. Enable it when initializing:

```typescript
const { sphere } = await Sphere.init({
  ...providers,
  network: 'testnet',
  autoGenerate: true,
  accounting: true,  // Required (swap uses invoices internally)
  swap: true,        // Enable swap module
});
```

**Propose a swap:**

```typescript
const result = await sphere.swap!.proposeSwap({
  partyA: sphere.identity!.directAddress!,
  partyB: '@bob',
  partyACurrency: 'UCT',
  partyAAmount: '1000000',
  partyBCurrency: 'USDU',
  partyBAmount: '500000',
  timeout: 3600,
  escrowAddress: '@escrow-testnet',
});

console.log('Swap ID:', result.swapId);
// result.swap.progress === 'proposed'
```

**Listen for incoming proposals and accept:**

```typescript
sphere.on('swap:proposal_received', async (data) => {
  console.log('Swap proposal from:', data.senderNametag ?? data.senderPubkey);
  console.log('Deal:', data.deal);

  // Accept and deposit
  await sphere.swap!.acceptSwap(data.swapId);
  await sphere.swap!.deposit(data.swapId);
});
```

**Deposit into a swap (proposer side, after counterparty accepts):**

```typescript
sphere.on('swap:announced', async (data) => {
  // Escrow is ready, deposit now
  const transferResult = await sphere.swap!.deposit(data.swapId);
  console.log('Deposit sent:', transferResult.id);
});
```

**Monitor progress:**

```typescript
sphere.on('swap:completed', (data) => {
  console.log('Swap completed!', data.swapId, 'Payout verified:', data.payoutVerified);
});

sphere.on('swap:cancelled', (data) => {
  console.log('Swap cancelled:', data.swapId, 'Reason:', data.reason);
});

sphere.on('swap:failed', (data) => {
  console.log('Swap failed:', data.swapId, data.error);
});
```

**List and query swaps:**

```typescript
// All active swaps
const swaps = sphere.swap!.getSwaps({ excludeTerminal: true });

// Detailed status (optionally query the escrow for its view)
const status = await sphere.swap!.getSwapStatus(swapId, { queryEscrow: true });
console.log('Progress:', status.progress, 'Escrow state:', status.escrowState);
```

## Import Existing Wallet

```typescript
// From mnemonic (recovery, plaintext storage — default)
const { sphere } = await Sphere.init({
  ...providers,
  network: 'testnet',
  mnemonic: 'word1 word2 word3 ... word12',
});

// From mnemonic with password encryption
const { sphere } = await Sphere.init({
  ...providers,
  network: 'testnet',
  mnemonic: 'word1 word2 word3 ... word12',
  password: 'my-secret-password',
});

// Load existing wallet with password
const { sphere } = await Sphere.init({
  ...providers,
  network: 'testnet',
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
        network: 'testnet',
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

// Optionally clear all SDK-owned wallet data (keys + tokens)
await Sphere.clear({
  storage: providers.storage,
  tokenStorage: providers.tokenStorage,
});
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
- [Integration Guide](./INTEGRATION.md) - Advanced integration patterns
- [IPFS Storage Guide](./IPFS-STORAGE.md) - IPFS/IPNS token sync configuration
- [Node.js Quick Start](./QUICKSTART-NODEJS.md) - For server-side usage
