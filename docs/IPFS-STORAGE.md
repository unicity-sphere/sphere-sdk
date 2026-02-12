# IPFS Storage Provider

Cross-platform HTTP-based IPFS/IPNS token storage for the Sphere SDK. Works in both browser and Node.js with no additional dependencies.

## Overview

The IPFS Storage Provider backs up wallet token data to IPFS (InterPlanetary File System) using IPNS (InterPlanetary Name System) for mutable references. It uses standard HTTP APIs — no Helia, no libp2p DHT, no extra packages required.

**Key features:**
- **Cross-platform**: Same HTTP-based implementation for browser and Node.js
- **Zero extra dependencies**: Built into the SDK, uses native `fetch`
- **Deterministic identity**: IPNS name derived from wallet key (same wallet = same IPNS name on any device)
- **Conflict resolution**: Automatic merge of local and remote token data
- **Multi-tier caching**: Known-fresh cache, IPNS TTL cache, immutable content cache
- **Circuit breaker**: Automatic gateway failover on repeated errors
- **Version chaining**: Sidecar-validated `_meta.lastCid` chain prevents stale overwrites

## Quick Start

### Browser

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createBrowserProviders } from '@unicitylabs/sphere-sdk/impl/browser';

const providers = createBrowserProviders({
  network: 'testnet',
  tokenSync: {
    ipfs: { enabled: true },
  },
});

const { sphere } = await Sphere.init({ ...providers, autoGenerate: true });

// Sync tokens with IPFS
const result = await sphere.payments.sync();
console.log(`Added: ${result.added}, Removed: ${result.removed}`);
```

### Node.js

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

const providers = createNodeProviders({
  network: 'testnet',
  dataDir: './wallet-data',
  tokensDir: './tokens-data',
  tokenSync: {
    ipfs: { enabled: true },
  },
});

const { sphere } = await Sphere.init({ ...providers, autoGenerate: true });

// Sync tokens with IPFS
const result = await sphere.payments.sync();
console.log(`Added: ${result.added}, Removed: ${result.removed}`);
```

## How It Works

### IPNS Identity Derivation

Each wallet deterministically derives an IPNS identity from its private key:

```
secp256k1 privateKey (hex)
  → HKDF(sha256, key, info="ipfs-storage-ed25519-v1", 32 bytes)
  → Ed25519 key pair
  → libp2p PeerId
  → IPNS name (e.g., "12D3KooW...")
```

The same wallet key always produces the same IPNS name, enabling cross-device recovery.

### Save Flow

1. Increment data version and attach `_meta.lastCid` (chain link to previous CID)
2. Serialize token data as JSON and upload to IPFS via `POST /api/v0/add`
3. Create a signed IPNS record pointing to the new CID (sequence = max(local, remote) + 1)
4. Publish the IPNS record to all gateways via `POST /api/v0/routing/put`
5. Update local cache and persist state (sequence number, CID, version)

### Load Flow

1. **Known-fresh cache** — If data was recently saved (within 30s), return cached data immediately
2. **IPNS TTL cache** — If IPNS record is cached (within 60s), fetch content by CID
3. **Network resolution** — Resolve IPNS via routing API across all gateways, pick highest sequence number
4. **Fetch content** — Download JSON by CID from gateways (races all gateways for fastest response)
5. **Stale fallback** — On network error, return expired cached data if available

### Sync Flow

1. Load remote data via the load flow above
2. If no remote data exists, upload local data as initial state
3. If versions differ, merge local and remote using TXF merge rules
4. Save merged result back to IPFS

### TXF Merge Rules

When local and remote data diverge, the merge algorithm applies these rules:

| Data | Rule |
|------|------|
| `_meta.version` | `max(local, remote) + 1` |
| `_tombstones` | Union by composite key `(tokenId, stateHash)`, newer timestamp wins on duplicate |
| Token entries | Present in one source → add; present in both → local wins |
| Tombstone filter | Tokens matching any tombstone entry are excluded |
| `_outbox` | Union with dedup by `id` (local wins) |
| `_sent` | Union with dedup by `tokenId` (local wins) |
| `_invalid` | Union with dedup by `tokenId` (local wins) |

## Configuration

### `IpfsStorageConfig`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `gateways` | `string[]` | Unicity IPFS nodes | Gateway URLs for HTTP API |
| `fetchTimeoutMs` | `number` | `15000` | Content fetch timeout |
| `resolveTimeoutMs` | `number` | `10000` | IPNS resolution timeout |
| `publishTimeoutMs` | `number` | `30000` | IPNS publish timeout |
| `connectivityTimeoutMs` | `number` | `5000` | Gateway health check timeout |
| `ipnsLifetimeMs` | `number` | 99 years | IPNS record lifetime |
| `ipnsCacheTtlMs` | `number` | `60000` | IPNS cache TTL (60s) |
| `circuitBreakerThreshold` | `number` | `3` | Consecutive failures before cooldown |
| `circuitBreakerCooldownMs` | `number` | `60000` | Circuit breaker cooldown period |
| `knownFreshWindowMs` | `number` | `30000` | Known-fresh cache window after publish |
| `debug` | `boolean` | `false` | Enable debug logging |

### Default Gateways

The SDK ships with Unicity-operated IPFS nodes:

```typescript
// constants.ts
UNICITY_IPFS_NODES = [
  { host: 'unicity-ipfs1.dyndns.org', httpPort: 9080, httpsPort: 443 }
]
```

HTTPS is used by default. Override with `gateways` config for custom nodes.

## Reliability Features

### Multi-Tier Caching

```
┌─────────────────────────────────────────────────────┐
│  Known-Fresh Cache (30s after publish)              │
│  → Skip network entirely, return cached data        │
├─────────────────────────────────────────────────────┤
│  IPNS Record Cache (60s TTL)                        │
│  → Use cached CID, fetch content if not cached      │
├─────────────────────────────────────────────────────┤
│  Content Cache (infinite TTL — CID is immutable)    │
│  → Content by CID never changes, cache forever      │
├─────────────────────────────────────────────────────┤
│  Stale Fallback (on network error)                  │
│  → Return expired cached data rather than fail      │
└─────────────────────────────────────────────────────┘
```

### Circuit Breaker

Gateways are tracked for consecutive failures:
- After **3 consecutive failures**, a gateway enters **60s cooldown**
- During cooldown, the gateway is skipped for all operations
- After cooldown expires, the gateway is retried
- A single successful request resets the failure counter
- `NOT_FOUND` errors (expected for new wallets) do **not** trigger the circuit breaker

### Version Chaining (Sidecar Validation)

Each save includes `_meta.lastCid` — the CID that was stored on the sidecar before this update:

- **Bootstrap** (first-ever save): `lastCid` is omitted
- **Normal update**: `lastCid` = the CID from the previous save or load
- The sidecar validates this chain, rejecting stale overwrites from devices with outdated state

## Advanced Usage

### Manual Provider Creation

```typescript
import { createBrowserIpfsStorageProvider } from '@unicitylabs/sphere-sdk/impl/browser/ipfs';
// or
import { createNodeIpfsStorageProvider } from '@unicitylabs/sphere-sdk/impl/nodejs/ipfs';

// Browser
const provider = createBrowserIpfsStorageProvider({
  gateways: ['https://my-ipfs-node.com'],
  debug: true,
});

// Node.js (with file-based state persistence)
import { FileStorageProvider } from '@unicitylabs/sphere-sdk/impl/nodejs';
const storage = new FileStorageProvider('./wallet-data');
const provider = createNodeIpfsStorageProvider(
  { debug: true },
  storage,  // Used for persisting IPNS state between sessions
);
```

### Dynamic Add/Remove at Runtime

```typescript
import { createBrowserIpfsStorageProvider } from '@unicitylabs/sphere-sdk/impl/browser/ipfs';

// Add IPFS sync after wallet is initialized
const ipfsProvider = createBrowserIpfsStorageProvider();
await sphere.addTokenStorageProvider(ipfsProvider);

// Check if IPFS sync is active
if (sphere.hasTokenStorageProvider('ipfs')) {
  console.log('IPFS sync is enabled');
}

// Remove IPFS sync
await sphere.removeTokenStorageProvider('ipfs');
```

### Event Handling

```typescript
// Listen for per-provider sync events
sphere.on('sync:provider', (event) => {
  if (event.providerId === 'ipfs') {
    console.log(`IPFS sync: ${event.success ? 'OK' : 'FAILED'}`);
    if (event.success) {
      console.log(`  Added: ${event.added}, Removed: ${event.removed}`);
    }
  }
});

// Listen for storage-level events on the provider directly
const provider = createBrowserIpfsStorageProvider();
provider.onEvent?.((event) => {
  switch (event.type) {
    case 'storage:saving': console.log('Uploading to IPFS...'); break;
    case 'storage:saved': console.log('Saved:', event.data); break;
    case 'storage:error': console.log('Error:', event.error); break;
    case 'sync:started': console.log('Sync started'); break;
    case 'sync:completed': console.log('Sync complete:', event.data); break;
    case 'sync:conflict': console.log('Conflicts resolved:', event.data); break;
  }
});
```

### State Persistence

IPNS state (sequence number, last CID, version) is persisted between sessions:

| Platform | Storage | Key |
|----------|---------|-----|
| Browser | `localStorage` | `ipfs_state_{ipnsName}` |
| Node.js | File via `StorageProvider` | `ipfs_state_{ipnsName}` |

This allows the provider to resume with the correct sequence number after a restart, preventing accidental sequence downgrades.

### Public Accessors

```typescript
// After initialization
provider.getIpnsName();        // "12D3KooW..." — IPNS name for this wallet
provider.getLastCid();         // "bafy..." — last known CID
provider.getSequenceNumber();  // 5n — current IPNS sequence
provider.getDataVersion();     // 3 — data version counter
provider.getRemoteCid();       // "bafy..." — CID on remote (for chain validation)
```

## Troubleshooting

### IPNS Record Not Found

Expected on first use — the wallet has no IPFS data yet. The first `sync()` call uploads local data as the initial state.

### Gateway Errors

If all gateways fail, check connectivity:
```typescript
const provider = createBrowserIpfsStorageProvider({ debug: true });
// Debug logs show: [IPFS-Storage] and [IPFS-HTTP] prefixed messages
```

Common causes:
- Network connectivity issues
- All gateways in circuit breaker cooldown (wait 60s or restart)
- Firewall blocking HTTPS to IPFS nodes

### Recovery After Local Storage Wipe

If local token storage is cleared but IPFS data exists:

```typescript
// Re-initialize wallet (derives same IPNS name from same key)
const { sphere } = await Sphere.init({ ...providers, mnemonic: '...' });

// Sync pulls tokens from IPFS
const result = await sphere.payments.sync();
console.log(`Recovered ${result.added} tokens from IPFS`);
```

### IPNS Propagation Delay

IPNS records may take a few seconds to propagate across gateways. The known-fresh cache (30s) prevents re-fetching immediately after a save. If reading from a different device immediately after writing, a brief delay is expected.

### Version Conflict

If a save fails with a version conflict (sidecar rejects `_meta.lastCid`), this means another device updated the data since the last load. Resolution:

1. Call `sync()` — it loads the latest remote data, merges, and saves
2. The merge algorithm handles conflicts automatically (local wins for token entries)
