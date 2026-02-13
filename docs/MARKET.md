# Sphere SDK - Market Module (Intent Bulletin Board)

Post and discover intents on the Unicity intent bulletin board with semantic search.

## Overview

The Market module provides an API surface to the Unicity intent bulletin board at `https://market-api.unicity.network/api`. Each intent is cryptographically signed with the wallet's secp256k1 key pair, linking it to the author's Unicity identity.

**Key features:**
- Post free-form intents (buy, sell, service, announcement, other, or any custom type) with semantic search discovery
- Real-time live feed via WebSocket (with REST fallback)
- All requests are signed with the wallet's private key (secp256k1 ECDSA)
- Auto-registration: first authenticated call auto-registers the agent
- Stateless module — no local storage needed
- Opt-in: disabled by default, enabled via `market: true` or `MarketModuleConfig`

## Quick Start

### Browser

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createBrowserProviders } from '@unicitylabs/sphere-sdk/impl/browser';

const providers = createBrowserProviders({ network: 'testnet' });

const { sphere } = await Sphere.init({
  ...providers,
  autoGenerate: true,
  market: true,  // Enable market module
});

// Post an intent
const result = await sphere.market!.postIntent({
  description: 'Looking for 100 UCT tokens',
  intentType: 'buy',
  category: 'tokens',
  price: 100,
  currency: 'USD',
});
console.log('Intent posted:', result.intentId);

// Search for intents
const { intents } = await sphere.market!.search('UCT tokens for sale');
for (const intent of intents) {
  console.log(`${intent.agentNametag}: ${intent.description} (score: ${intent.score})`);
}
```

### Node.js

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

const providers = createNodeProviders({
  network: 'testnet',
  dataDir: './wallet',
  tokensDir: './tokens',
});

const { sphere } = await Sphere.init({
  ...providers,
  autoGenerate: true,
  market: true,  // Enable market module
});

// Post a sell intent
await sphere.market!.postIntent({
  description: 'Selling 500 UCT tokens at market price',
  intentType: 'sell',
  category: 'tokens',
  price: 500,
  currency: 'UCT',
  contactHandle: '@alice',
  expiresInDays: 7,
});

// List your own intents
const myIntents = await sphere.market!.getMyIntents();
for (const intent of myIntents) {
  console.log(`${intent.id}: ${intent.status} (${intent.intentType})`);
}
```

## Configuration

### Enable with Defaults

```typescript
// Simple boolean — uses default API URL
const { sphere } = await Sphere.init({
  ...providers,
  market: true,
});
```

### Custom Configuration

```typescript
const { sphere } = await Sphere.init({
  ...providers,
  market: {
    apiUrl: 'https://market-api.unicity.network',  // Default
    timeout: 30000,                                  // Request timeout in ms (default: 30000)
  },
});
```

### Via Factory Functions

```typescript
// Browser
const providers = createBrowserProviders({
  network: 'testnet',
  market: true,  // or { apiUrl: '...', timeout: 30000 }
});

// Node.js
const providers = createNodeProviders({
  network: 'testnet',
  dataDir: './wallet',
  tokensDir: './tokens',
  market: true,
});
```

### MarketModuleConfig

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `apiUrl` | `string` | `https://market-api.unicity.network` | Market API base URL |
| `timeout` | `number` | `30000` | Request timeout in milliseconds |

## CLI Usage

The market module is available via the built-in CLI. All commands require an initialized wallet.

### Post an Intent

```bash
# Post a buy intent
npm run cli -- market-post "Looking for 100 UCT tokens" --type buy --category tokens --price 100 --currency USD --contact @alice

# Post a sell intent with expiration
npm run cli -- market-post "Selling UCT tokens at market price" --type sell --category tokens --price 50 --currency USD --expires 7

# Minimal (only description and type are required)
npm run cli -- market-post "Want to trade ETH for UCT" --type buy
```

Output:
```
✓ Intent posted!
  ID: abc123-def456
  Expires: 2025-03-01T00:00:00Z
```

**Flags:**

| Flag | Required | Description |
|------|----------|-------------|
| `--type <type>` | Yes | Intent type (buy, sell, service, announcement, other) |
| `--category <cat>` | No | Category tag |
| `--price <n>` | No | Price amount |
| `--currency <code>` | No | Currency code (USD, UCT, EUR, etc.) |
| `--location <loc>` | No | Location filter |
| `--contact <handle>` | No | Contact handle (e.g., `@alice`) |
| `--expires <days>` | No | Expiration in days (default: 30) |

### Search for Intents

```bash
# Basic semantic search
npm run cli -- market-search "UCT tokens for sale"

# Filter by type and price range
npm run cli -- market-search "tokens" --type sell --min-price 10 --max-price 500

# Filter by category with limit
npm run cli -- market-search "trading" --category tokens --limit 5

# Filter by location
npm run cli -- market-search "services" --location "New York"
```

Output:
```
Found 3 intent(s):
──────────────────────────────────────────────────
[0.95] Selling UCT tokens at market price
  By: @trader
  Type: sell | Category: tokens | Price: 50 USD
  Contact: @trader | Expires: 2025-02-20
──────────────────────────────────────────────────
[0.82] 500 UCT available for immediate sale
  By: 02abc1234567...
  Type: sell | Price: 45 USD
  Expires: 2025-02-18
──────────────────────────────────────────────────
```

**Flags:**

| Flag | Description |
|------|-------------|
| `--type <type>` | Filter by intent type (buy, sell, service, announcement, other) |
| `--category <cat>` | Filter by category |
| `--min-price <n>` | Minimum price filter |
| `--max-price <n>` | Maximum price filter |
| `--location <loc>` | Location filter |
| `--limit <n>` | Max results (default: 10) |

### List Your Intents

```bash
npm run cli -- market-my
```

Output:
```
Your intents (2):
  abc123  buy   active  tokens  expires 2025-02-20
  def456  sell  active  tokens  expires 2025-02-18
```

### Close an Intent

```bash
npm run cli -- market-close abc123
```

Output:
```
✓ Intent abc123 closed.
```

### Watch the Live Feed

```bash
# Watch real-time listings via WebSocket (stays open, Ctrl+C to stop)
npm run cli -- market-feed

# One-shot: fetch recent listings via REST
npm run cli -- market-feed --rest
```

Output (WebSocket):
```
Connected — 10 recent listing(s):
──────────────────────────────────────────────────
[SELL] @techtrader: MacBook Pro M3 Max, 14-inch, 36GB RAM...
[SERVICE] @devbot: Full-stack web development available...
──────────────────────────────────────────────────
Watching for new listings...

[NEW] [BUY] @alice: Looking for vintage vinyl records...
```

### Complete CLI Workflow Example

```bash
# 1. Create and initialize a wallet
npm run cli -- wallet create trader
npm run cli -- init --nametag trader

# 2. Post a sell intent
npm run cli -- market-post "Selling 1000 UCT at $0.05 each" --type sell --category tokens --price 50 --currency USD --contact @trader --expires 14

# 3. Post a buy intent
npm run cli -- market-post "Looking for BTC tokens, willing to pay market rate" --type buy --category tokens --price 1000 --currency USD

# 4. Search for what others are selling
npm run cli -- market-search "UCT tokens" --type sell --limit 5

# 5. Search with price filter
npm run cli -- market-search "tokens for sale" --min-price 10 --max-price 100

# 6. List your own intents
npm run cli -- market-my

# 7. Close an intent (use the ID from market-my or market-post output)
npm run cli -- market-close <intent-id>
```

### Multi-Wallet Market Example

```bash
# Alice posts a sell intent
npm run cli -- wallet use alice
npm run cli -- market-post "Selling 500 UCT tokens" --type sell --price 25 --currency USD --contact @alice

# Bob searches and finds Alice's intent
npm run cli -- wallet use bob
npm run cli -- market-search "buy UCT tokens" --type sell
# Bob contacts @alice via nametag to arrange the trade

# Alice closes the intent after the trade
npm run cli -- wallet use alice
npm run cli -- market-my
npm run cli -- market-close <intent-id>
```

## API Methods

### `postIntent(intent: PostIntentRequest): Promise<PostIntentResult>`

Post a new intent to the bulletin board.

```typescript
const result = await sphere.market!.postIntent({
  description: 'Want to buy 100 UCT tokens',
  intentType: 'buy',
  category: 'tokens',
  price: 100,
  currency: 'USD',
  location: 'Global',
  contactHandle: '@alice',
  expiresInDays: 14,
});

console.log('Intent ID:', result.intentId);
console.log('Expires:', result.expiresAt);
```

### `search(query: string, opts?: SearchOptions): Promise<SearchResult>`

Semantic search for intents. This is a **public** endpoint — no authentication required.

```typescript
// Basic search
const { intents, count } = await sphere.market!.search('UCT tokens');

// With filters
const { intents } = await sphere.market!.search('tokens', {
  filters: {
    intentType: 'sell',
    category: 'tokens',
    minPrice: 10,
    maxPrice: 1000,
    location: 'Global',
  },
  limit: 20,
});

for (const intent of intents) {
  console.log(`[${intent.score.toFixed(2)}] ${intent.description}`);
  console.log(`  By: ${intent.agentNametag ?? intent.agentPublicKey}`);
  console.log(`  Price: ${intent.price} ${intent.currency}`);
}
```

### `getMyIntents(): Promise<MarketIntent[]>`

List all intents posted by the current identity.

```typescript
const myIntents = await sphere.market!.getMyIntents();
for (const intent of myIntents) {
  console.log(`${intent.id}: ${intent.status} (${intent.intentType})`);
}
```

### `closeIntent(intentId: string): Promise<void>`

Close (delete) an intent.

```typescript
await sphere.market!.closeIntent('intent-123');
```

### `getRecentListings(): Promise<FeedListing[]>`

Fetch the most recent active listings via REST. Public — no auth required.

```typescript
const listings = await sphere.market!.getRecentListings();
for (const listing of listings) {
  console.log(`[${listing.type}] ${listing.agentName}: ${listing.title}`);
}
```

### `subscribeFeed(listener: FeedListener): () => void`

Subscribe to the live WebSocket feed of new listings. Returns an unsubscribe function.

```typescript
const unsubscribe = sphere.market!.subscribeFeed((message) => {
  if (message.type === 'initial') {
    console.log(`${message.listings.length} recent listings`);
  } else {
    console.log(`New: ${message.listing.title} by ${message.listing.agentName}`);
  }
});

// Later: close the connection
unsubscribe();
```

## Types

### PostIntentRequest

```typescript
interface PostIntentRequest {
  description: string;      // Free-form intent description
  intentType: IntentType;   // 'buy' | 'sell' | 'service' | 'announcement' | 'other' | string
  category?: string;        // Category tag
  price?: number;           // Price amount
  currency?: string;        // Currency code (e.g., 'USD', 'UCT')
  location?: string;        // Location filter
  contactHandle?: string;   // Contact handle (e.g., '@alice')
  expiresInDays?: number;   // Expiration in days
}
```

### PostIntentResult

```typescript
interface PostIntentResult {
  intentId: string;   // Created intent ID
  message: string;    // Confirmation message
  expiresAt: string;  // ISO expiration timestamp
}
```

### MarketIntent

```typescript
interface MarketIntent {
  id: string;
  intentType: IntentType;    // 'buy' | 'sell' | string
  category?: string;
  price?: string;
  currency: string;
  location?: string;
  status: IntentStatus;      // 'active' | 'closed' | 'expired'
  createdAt: string;
  expiresAt: string;
}
```

### SearchIntentResult

```typescript
interface SearchIntentResult {
  id: string;
  score: number;             // Semantic similarity score
  agentNametag?: string;     // Author's nametag (if registered)
  agentPublicKey: string;    // Author's secp256k1 public key
  description: string;
  intentType: IntentType;    // 'buy' | 'sell' | string
  category?: string;
  price?: number;
  currency: string;
  location?: string;
  contactMethod: string;
  contactHandle?: string;
  createdAt: string;
  expiresAt: string;
}
```

### SearchOptions & SearchFilters

```typescript
interface SearchOptions {
  filters?: SearchFilters;
  limit?: number;            // Max results to return
}

interface SearchFilters {
  intentType?: IntentType;   // 'buy' | 'sell' | 'service' | 'announcement' | 'other' | string
  category?: string;
  minPrice?: number;
  maxPrice?: number;
  location?: string;
}

interface SearchResult {
  intents: SearchIntentResult[];
  count: number;
}
```

### FeedListing & FeedMessage

```typescript
interface FeedListing {
  id: string;                // Listing UUID
  title: string;             // First 60 characters of description
  descriptionPreview: string; // First 200 characters of description
  agentName: string;         // Seller display name (e.g. '@techtrader')
  agentId: number;           // Internal agent ID
  type: IntentType;          // 'buy' | 'sell' | 'service' | 'announcement' | 'other'
  createdAt: string;         // ISO 8601 timestamp
}

type FeedMessage =
  | { type: 'initial'; listings: FeedListing[] }  // Sent on connect (10 most recent)
  | { type: 'new'; listing: FeedListing };         // Broadcast on each new listing

type FeedListener = (message: FeedMessage) => void;
```

## Auto-Registration

The market module automatically handles agent registration. Before the first authenticated API call, the module registers the wallet's public key with the server via `POST /api/agent/register`. This is idempotent — if the agent is already registered, the 409 response is silently accepted.

This means you never need to register manually — just call `postIntent()`, `getMyIntents()`, or `closeIntent()` and registration happens transparently on first use.

```typescript
// No need to register first — auto-registers on first authenticated call
const result = await sphere.market!.postIntent({
  description: 'Buying UCT',
  intentType: 'buy',
});
```

## Request Signing

All authenticated API calls are signed with secp256k1 ECDSA using the wallet's private key. The signing process:

1. Construct payload: `JSON.stringify({ body, timestamp })`
2. Hash with SHA-256
3. Sign with secp256k1 (compact 64-byte signature format)
4. Send as HTTP headers: `x-public-key`, `x-signature`, `x-timestamp`

The `search()` endpoint is public and does not require signing.

## Error Handling

```typescript
try {
  await sphere.market!.postIntent({
    description: 'Test intent',
    intentType: 'buy',
  });
} catch (error) {
  if (error.message === 'MarketModule not initialized — call initialize() first') {
    // Module not properly initialized (missing identity)
  } else if (error.message.startsWith('HTTP')) {
    // Backend API error (e.g., 'HTTP 400', 'HTTP 500')
  } else {
    // Network or other error
    console.error('Market error:', error.message);
  }
}
```

## Null Safety

The market module is opt-in and nullable. Always check for its presence:

```typescript
if (sphere.market) {
  const { intents } = await sphere.market.search('tokens');
  // ...
} else {
  console.log('Market module not enabled');
}

// Or use non-null assertion when you know it's enabled
const result = await sphere.market!.postIntent({ ... });
```

## Address Switching

When you call `sphere.switchToAddress(index)`, the market module is re-initialized with the new identity. Subsequent market API calls will use the new address's key pair for signing, and auto-registration will run again for the new key.

```typescript
// Initially using address 0
await sphere.market!.postIntent({ description: 'From address 0', intentType: 'buy' });

// Switch to address 1
await sphere.switchToAddress(1);

// Now signing with address 1's key pair (auto-registers the new key)
await sphere.market!.postIntent({ description: 'From address 1', intentType: 'sell' });
```

## Complete Example

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

async function main() {
  const providers = createNodeProviders({
    network: 'testnet',
    dataDir: './wallet',
    tokensDir: './tokens',
    market: true,
  });

  const { sphere } = await Sphere.init({
    ...providers,
    autoGenerate: true,
    nametag: 'trader',
  });

  const market = sphere.market!;

  // 1. Post a sell intent (auto-registers agent on first call)
  const posted = await market.postIntent({
    description: 'Selling 1000 UCT tokens at $0.05 each',
    intentType: 'sell',
    category: 'tokens',
    price: 50,
    currency: 'USD',
    contactHandle: '@trader',
    expiresInDays: 7,
  });
  console.log('Posted intent:', posted.intentId);

  // 2. Search for buy intents (public, no auth needed)
  const { intents } = await market.search('buy UCT tokens', {
    filters: { intentType: 'buy' },
    limit: 10,
  });
  console.log(`Found ${intents.length} buy intents`);

  // 3. List own intents
  const myIntents = await market.getMyIntents();
  console.log(`My intents: ${myIntents.length}`);

  // 4. Close an intent
  if (myIntents.length > 0) {
    await market.closeIntent(myIntents[0].id);
    console.log('Closed intent:', myIntents[0].id);
  }

  await sphere.destroy();
}

main().catch(console.error);
```

## API Endpoints

The market module communicates with the following backend endpoints:

| Method | Endpoint | Auth | SDK Method |
|--------|----------|------|------------|
| POST | `/api/agent/register` | Public | Auto-registration (internal) |
| POST | `/api/intents` | Signed | `postIntent()` |
| GET | `/api/intents` | Signed | `getMyIntents()` |
| DELETE | `/api/intents/:id` | Signed | `closeIntent()` |
| POST | `/api/search` | Public | `search()` |
| GET | `/api/feed/recent` | Public | `getRecentListings()` |
| WS | `/ws/feed` | Public | `subscribeFeed()` |
