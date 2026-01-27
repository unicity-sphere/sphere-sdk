# SDK2 Implementation Plan

## Architecture Note

**Oracle (abstract) → Aggregator (concrete)**:
- `OracleProvider` - abstract interface for any service providing verifiable truth about token state
- `UnicityAggregatorProvider` - concrete implementation using Unicity's aggregator service

The aggregator is the Unicity network's oracle - it aggregates state transitions into rounds and provides cryptographic inclusion proofs.

## Current Status

### Done (real implementation)
- [x] File structure and architecture
- [x] Type definitions (types/index.ts)
- [x] Provider interfaces (Storage, Transport, Oracle)
- [x] Constants file with storage keys and defaults
- [x] Wallet management API (exists/create/load/import/clear)

### Done (Phase 1)
- [x] BIP39/BIP32 key derivation (core/crypto.ts)
- [x] AES-256 encryption (core/encryption.ts)
- [x] Sphere.ts uses real crypto instead of simpleHash

### Done (Phase 2)
- [x] L1PaymentsModule - real L1 SDK integration
- [x] Import from existing network.ts (getBalance, getUtxo, getTransactionHistory)
- [x] Import from existing tx.ts (sendAlpha, createTransactionPlan)
- [x] send() method with real transaction creation
- [x] getBalance(), getUtxos(), getHistory() with Fulcrum WebSocket

### Done (Storage & Communications)
- [x] LocalStorageProvider - complete (key-value, JSON helpers, SSR fallback)
- [x] CommunicationsModule - complete (DMs, broadcasts, handlers)

### Done (Phase 5)
- [x] IpfsStorageProvider - Helia integration
- [x] IPNS key derivation from wallet private key using HKDF
- [x] Hybrid HTTP + DHT publishing/fetching
- [x] Proper IPNS name derivation via libp2p PeerId

### Done (Phase 3)
- [x] UnicityAggregatorProvider - real SDK integration (StateTransitionClient, AggregatorClient)
- [x] PaymentsModule - SDK token parsing for incoming transfers
- [x] Token validation using SDK Token.fromJSON() and verify()
- [x] Full transfer flow with SDK TransferCommitment
- [x] SigningService integration for transaction signing
- [x] ProxyAddress/TokenId for recipient resolution

### Done (Phase 4)
- [x] NostrTransportProvider - real @unicitylabs/nostr-js-sdk integration
- [x] NostrKeyManager for key management
- [x] Real secp256k1 event signing via Event.create()
- [x] NIP-04 encryption/decryption via NIP04.encryptHex/decryptHex
- [x] Nametag registration via transport

### Done (Token Splitting)
- [x] TokenSplitCalculator - calculates optimal token splits for partial transfers
- [x] TokenSplitExecutor - stub with interfaces, delegates to L3 implementation for actual splits
  - Note: Full split execution requires complex SDK integration; use L3 TokenSplitExecutor

### Done (Multi-Address Support)
- [x] HD address derivation via `deriveAddress(index, isChange?)`
- [x] Arbitrary path derivation via `deriveAddressAtPath(path)`
- [x] Batch derivation via `deriveAddresses(count, includeChange?)`
- [x] Path getters: `getBasePath()`, `getDefaultAddressPath()`
- [x] AddressInfo type exported

### Not needed
- ~~Migration utilities~~ - app adapts its storage keys when integrating SDK

### Not started
- [ ] Tests (deferred until extracted to separate library)

---

## Phase 1: Key Derivation & Encryption

### 1.1 BIP39/BIP32 Integration
**File:** `src/sdk2/core/crypto.ts`

```typescript
// Use existing libraries from the project
import * as bip39 from 'bip39';
import { ec as EC } from 'elliptic';

export function mnemonicToSeed(mnemonic: string): Uint8Array;
export function deriveKey(seed: Uint8Array, path: string): { privateKey: string; publicKey: string };
export function generateMnemonic(strength?: 128 | 256): string;
export function validateMnemonic(mnemonic: string): boolean;
```

### 1.2 Encryption
**File:** `src/sdk2/core/encryption.ts`

```typescript
import CryptoJS from 'crypto-js';

export function encrypt(data: string, password: string): string;
export function decrypt(encrypted: string, password: string): string | null;
export function deriveEncryptionKey(password: string, salt: string): string;
```

### 1.3 Update Sphere.ts
- Replace `simpleHash()` with real BIP39/BIP32
- Replace `btoa/atob` with AES-256 encryption
- Add password parameter to create/load/import

---

## Phase 2: L1 Payments Integration

### 2.1 Connect L1PaymentsModule to existing SDK
**File:** `src/sdk2/modules/payments/L1PaymentsModule.ts`

```typescript
// Import from existing L1 SDK
import { createWallet, getBalance, createTransaction, broadcastTransaction } from '@/components/wallet/L1/sdk';

// Implement methods:
async send(request: L1TransferRequest): Promise<L1TransferResult> {
  // Use existing tx.ts logic
}

async getBalance(): Promise<L1Balance> {
  // Use existing network.ts + balance logic
}

async getUtxos(): Promise<L1Utxo[]> {
  // Use existing scan.ts logic
}

async getHistory(): Promise<L1Transaction[]> {
  // Use existing transaction history
}
```

### 2.2 Fulcrum WebSocket Integration
**File:** `src/sdk2/impl/browser/network/FulcrumProvider.ts`

```typescript
// Wrap existing network.ts functionality
export class FulcrumProvider {
  connect(url: string): Promise<void>;
  getBalance(address: string): Promise<{ confirmed: bigint; unconfirmed: bigint }>;
  getUtxos(address: string): Promise<Utxo[]>;
  broadcast(txHex: string): Promise<string>;
  subscribe(address: string, callback: (tx: Transaction) => void): () => void;
}
```

---

## Phase 3: L3 Payments Integration

### 3.1 State Transition SDK Integration
**File:** `src/sdk2/modules/payments/PaymentsModule.ts`

```typescript
import { Token, StateTransitionClient } from '@unicitylabs/state-transition-sdk';

// Update send() method:
async send(request: TransferRequest): Promise<TransferResult> {
  const client = ServiceProvider.getStateTransitionClient();

  // 1. Get tokens from storage
  // 2. Use TokenSplitCalculator for optimal split
  // 3. Create transfer commitment
  // 4. Submit to aggregator
  // 5. Wait for proof
  // 6. Send via Nostr
  // 7. Update storage
}
```

### 3.2 Update Aggregator Provider
**File:** `src/sdk2/impl/browser/oracle/UnicityAggregatorProvider.ts`

```typescript
import { StateTransitionClient } from '@unicitylabs/state-transition-sdk';

// Use real SDK methods:
async submitCommitment(commitment: TransferCommitment): Promise<SubmitResult> {
  const client = new StateTransitionClient(this.config.url);
  // Real implementation
}

async validateToken(tokenData: unknown): Promise<ValidationResult> {
  // Use SDK validation
}
```

---

## Phase 4: Nostr Integration

### 4.1 Real Nostr Implementation
**File:** `src/sdk2/impl/browser/transport/NostrTransportProvider.ts`

```typescript
import { NostrClient, nip04 } from '@unicitylabs/nostr-js-sdk';

// Update methods:
private async encryptContent(content: string, recipientPubkey: string): Promise<string> {
  return await nip04.encrypt(this.identity.privateKey, recipientPubkey, content);
}

private async decryptContent(content: string, senderPubkey: string): Promise<string> {
  return await nip04.decrypt(this.identity.privateKey, senderPubkey, content);
}

// Real event signing:
private async createEvent(kind: number, content: string, tags: string[][]): Promise<NostrEvent> {
  // Use proper secp256k1 signing
}
```

### 4.2 Token Transfer Protocol
```typescript
// NIP-78 application-specific event for token transfers
interface TokenTransferEvent {
  kind: 30078;
  content: encrypted({
    token: string;      // Serialized Token
    proof: string;      // Inclusion proof
    memo?: string;
  });
  tags: [
    ['d', uniqueId],
    ['p', recipientPubkey],
    ['t', 'token-transfer']
  ];
}
```

---

## Phase 5: IPFS Storage

### 5.1 Helia Integration
**File:** `src/sdk2/impl/browser/storage/IpfsStorageProvider.ts`

```typescript
import { createHelia } from 'helia';
import { json } from '@helia/json';
import { ipns } from '@helia/ipns';

// Real implementation:
async save(data: TData): Promise<SaveResult> {
  const helia = await this.getHelia();
  const j = json(helia);
  const cid = await j.add(data);

  if (this.config.enableIpns) {
    await this.publishIpns(cid);
  }

  return { success: true, cid: cid.toString() };
}
```

### 5.2 Sync Logic
```typescript
// Port existing IpfsStorageService logic:
- Bidirectional sync with conflict resolution
- Tombstone support for deletions
- Tab coordination via SyncCoordinator
- Metrics and caching
```

---

## Phase 6: Communications Module

### 6.1 Direct Messages
**File:** `src/sdk2/modules/communications/CommunicationsModule.ts`

```typescript
async sendDM(recipient: string, content: string): Promise<string> {
  const pubkey = await this.resolveRecipient(recipient);
  return await this.deps.transport.sendMessage(pubkey, content);
}

async getConversations(): Promise<Conversation[]> {
  // Load from storage, merge with incoming
}

async getMessages(conversationId: string): Promise<DirectMessage[]> {
  // Load messages for conversation
}
```

### 6.2 Broadcast/Channel Messages
```typescript
async subscribeToBroadcast(tags: string[]): void {
  this.deps.transport.subscribeToBroadcast(tags, (broadcast) => {
    this.handleBroadcast(broadcast);
  });
}

async publishBroadcast(content: string, tags?: string[]): Promise<string> {
  return await this.deps.transport.publishBroadcast(content, tags);
}
```

---

## Phase 7: Event System & Hooks

### 7.1 Incoming Transfer Handling
```typescript
// In PaymentsModule:
private async handleIncomingTransfer(transfer: IncomingTokenTransfer): Promise<void> {
  // 1. Validate token with aggregator
  // 2. Parse and create Token object
  // 3. Save to storage
  // 4. Emit 'transfer:incoming' event
}
```

### 7.2 Connection Management
```typescript
// Auto-reconnect logic
sphere.on('connection:changed', ({ provider, connected }) => {
  if (!connected) {
    // Attempt reconnect
  }
});
```

---

## Phase 8: Testing

### 8.1 Unit Tests
```
tests/unit/sdk2/
├── core/
│   ├── Sphere.test.ts
│   ├── crypto.test.ts
│   └── encryption.test.ts
├── modules/
│   ├── PaymentsModule.test.ts
│   ├── L1PaymentsModule.test.ts
│   └── CommunicationsModule.test.ts
└── providers/
    ├── LocalStorageProvider.test.ts
    ├── NostrTransportProvider.test.ts
    └── UnicityAggregatorProvider.test.ts
```

### 8.2 Integration Tests
```
tests/integration/sdk2/
├── wallet-lifecycle.test.ts
├── token-transfer.test.ts
├── ipfs-sync.test.ts
└── nostr-messaging.test.ts
```

---

## Phase 9: Migration & Compatibility

### 9.1 Storage Migration
```typescript
// Migrate from old storage keys to new ones
export async function migrateStorage(storage: StorageProvider): Promise<void> {
  const oldKeys = {
    'sphere_wallet_mnemonic': STORAGE_KEYS.MNEMONIC,
    'sphere_wallet_master': STORAGE_KEYS.MASTER_KEY,
    // ...
  };

  for (const [oldKey, newKey] of Object.entries(oldKeys)) {
    const value = await storage.get(oldKey);
    if (value) {
      await storage.set(newKey, value);
      await storage.remove(oldKey);
    }
  }
}
```

### 9.2 API Compatibility Layer
```typescript
// For gradual migration from old code
export function createLegacyAdapter(sphere: Sphere) {
  return {
    // Old API methods mapped to new ones
    getIdentity: () => sphere.identity,
    sendTokens: (to, amount) => sphere.payments.send({ recipient: to, amount, coinId: 'ALPHA' }),
    // ...
  };
}
```

---

## File Structure (Final)

```
src/sdk2/
├── index.ts                    # Main exports
├── constants.ts                # All constants
├── core/
│   ├── index.ts
│   ├── Sphere.ts              # Main SDK class
│   ├── crypto.ts              # BIP39/BIP32
│   └── encryption.ts          # AES-256
├── types/
│   └── index.ts               # All type definitions
├── storage/
│   ├── index.ts
│   └── storage-provider.ts    # Interface
├── transport/
│   ├── index.ts
│   └── transport-provider.ts  # Interface
├── oracle/
│   ├── index.ts
│   └── oracle-provider.ts     # Interface
├── modules/
│   ├── payments/
│   │   ├── index.ts
│   │   ├── PaymentsModule.ts  # L3 payments
│   │   └── L1PaymentsModule.ts # L1 payments
│   └── communications/
│       ├── index.ts
│       └── CommunicationsModule.ts
└── impl/
    └── browser/
        ├── index.ts           # Browser exports
        ├── storage/
        │   ├── LocalStorageProvider.ts
        │   └── IpfsStorageProvider.ts
        ├── transport/
        │   └── NostrTransportProvider.ts
        ├── oracle/
        │   └── UnicityAggregatorProvider.ts
        └── network/
            └── FulcrumProvider.ts  # L1 network
```

---

## Priority Order

1. **Phase 1** - Key derivation & encryption (critical for security)
2. **Phase 3** - L3 payments (core functionality)
3. **Phase 4** - Nostr integration (required for transfers)
4. **Phase 2** - L1 payments (secondary priority)
5. **Phase 5** - IPFS storage (sync feature)
6. **Phase 6** - Communications (messaging feature)
7. **Phase 8** - Testing
8. **Phase 9** - Migration
