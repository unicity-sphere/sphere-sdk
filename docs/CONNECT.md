# Sphere Connect — Developer Guide

Sphere Connect is a secure wallet-dApp communication protocol. It allows web applications (dApps) to request wallet operations from a Sphere wallet — reading balances, sending tokens, signing messages — without exposing private keys.

## Protocol Version

The current Connect protocol version is **`2.0`** (`SPHERE_CONNECT_VERSION = '2.0'`).

### Compatibility policy

- **Same MAJOR = compatible.** A dApp on 2.0 and a wallet on 2.1 connect fine — MINOR versions within the same MAJOR interoperate.
- **Different MAJOR = rejected.** A v1-era dApp (protocol `'1.0'`) that attempts to handshake with a v2 wallet is rejected with `UNSUPPORTED_PROTOCOL_VERSION` (4007). That peer must update its SDK.
- The **v1 → v2** cut is a one-time hard break: v1 peers are genuinely incompatible and must upgrade.

### Handshake fields

Two new optional fields are sent in the handshake (added in v2; both fields are additive and carry no breaking change to the wire format):

| Field | Direction | Type | Description |
|-------|-----------|------|-------------|
| `sdkVersion` | request & response | `string` | npm SDK version of the sender. Sent automatically by `ConnectClient`; also present in the wallet response. |
| `network` | request & response | `NetworkInfo` | The sender's active network. dApp sends its target network; wallet echoes its own. |

**`NetworkInfo`** shape:

```typescript
interface NetworkInfo {
  id: number;    // RootTrustBase.networkId — testnet2 = 4
  name?: string; // informational ('testnet2' | 'mainnet' | ...)
}
```

The dApp sets `network` via `ConnectClientConfig.network` (see [Setting up ConnectClient](#setting-up-connectclient-dapp-side) below). If the dApp omits this field (or the network id does not match the wallet's active network), the handshake is rejected with `INCOMPATIBLE_NETWORK` (4008).

The wallet's network id comes from `Sphere.networkId`, which is derived from the trust base loaded at init time (testnet2 = 4).

---

## Network Configuration

### SPHERE_NETWORKS — the recommended way to declare a network

Use `SPHERE_NETWORKS` (exported from `@unicitylabs/sphere-sdk/connect`) instead of a raw `{ id, name }` literal. It is derived directly from `constants.NETWORKS` so the numeric id can never drift from the SDK's embedded trust base:

```typescript
import { SPHERE_NETWORKS } from '@unicitylabs/sphere-sdk/connect';

// With ConnectClient:
const client = new ConnectClient({ /* ... */, network: SPHERE_NETWORKS.testnet2 });

// With autoConnect:
const result = await autoConnect({ /* ... */, network: SPHERE_NETWORKS.testnet2 });
```

`SPHERE_NETWORKS` is also importable by backend services from `@unicitylabs/sphere-sdk/connect` — this entry point has no browser-only deps, so it is safe to use in Node.js and `sphere-api` without pulling in DOM APIs.

The registry currently exposes exactly one entry: `SPHERE_NETWORKS.testnet2` = `{ id: 4, name: 'testnet2' }`. Richer descriptor fields (`gatewayUrl`, `symbol`, `explorer`, `icon`) and runtime switch/add-network are deferred to a future multi-network effort. The legacy `testnet` alias is intentionally absent from `SPHERE_NETWORKS`.

### NetworkInfo

`NetworkInfo` is the descriptor type for a Unicity network:

```typescript
interface NetworkInfo {
  readonly id: number;    // canonical match key — RootTrustBase.networkId (testnet2 = 4)
  readonly name?: string; // human-readable metadata only
}
```

`id` is the canonical key used by the gate (analogous to EIP-155 chainId). The wallet matches solely on `id`; `name` is optional metadata. Custom or future networks use the same shape: `network: { id, name }`.

### Single source of truth

`SPHERE_NETWORKS` is derived from `constants.NETWORKS` (which holds the `networkId` of each network's embedded trust base). This ensures the registry value is always byte-identical to the network id the wallet sees at runtime. Issue [#597](https://github.com/unicity-sphere/sphere-sdk/issues/597).

---

## Architecture

```
dApp (browser)                    Wallet (Sphere / Extension)
─────────────────                 ──────────────────────────
ConnectClient                ↔    ConnectHost
     │                                  │
     └── ConnectTransport ──────────────┘
```

- **ConnectHost** — runs inside the wallet. Bridges `ConnectTransport` to a `Sphere` instance.
- **ConnectClient** — runs inside the dApp. Sends requests and receives responses.
- **ConnectTransport** — the communication channel (PostMessage, WebSocket, or Extension).

---

## Transports

### PostMessageTransport (browser)
Used when the dApp and wallet communicate via `window.postMessage`.

```typescript
import { PostMessageTransport } from '@unicitylabs/sphere-sdk/connect/browser';

// dApp inside an iframe — talk to parent window
const transport = PostMessageTransport.forClient();

// dApp opens wallet in a popup
const popup = window.open(WALLET_URL + '/connect', 'sphere-wallet', 'width=420,height=650');
const transport = PostMessageTransport.forClient({ target: popup, targetOrigin: WALLET_URL });

// Wallet side (host)
const transport = PostMessageTransport.forHost();
```

### ExtensionTransport (browser extension)
Used when the Sphere browser extension is installed. The dApp communicates through the extension's content script relay.

```typescript
import { ExtensionTransport } from '@unicitylabs/sphere-sdk/connect/browser';

// dApp side — sends via window.postMessage with sphere-connect-ext namespace
const transport = ExtensionTransport.forClient();

// Extension background — receives via chrome.runtime.onMessage
const transport = ExtensionTransport.forHost({
  onMessage: chrome.runtime.onMessage,
  tabs: chrome.tabs,
});
```

### WebSocketTransport (Node.js)
Used for server-side or CLI dApps.

```typescript
import { WebSocketTransport } from '@unicitylabs/sphere-sdk/connect/nodejs';

const transport = WebSocketTransport.forClient({ url: 'ws://localhost:3000' });
const transport = WebSocketTransport.forHost({ port: 3000 });
```

#### safeSend pattern for WebSocket bridges

When building a WebSocket bridge (e.g. a backend relay between two `WebSocketTransport` instances), always guard `ws.send()` calls. Queries from the remote side may arrive while the local WebSocket is closing, which throws an error.

```typescript
const safeSend = (data: string) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(data);
};
```

Use `safeSend` everywhere you would otherwise call `ws.send()` in message handlers and forwarding logic.

---

## Setting up ConnectHost (wallet side)

```typescript
import { ConnectHost } from '@unicitylabs/sphere-sdk/connect';

const host = new ConnectHost({
  sphere,        // Sphere SDK instance
  transport,     // any ConnectTransport

  // Called when a new dApp requests connection.
  // silent=true means: reject immediately if not already approved — do NOT open any UI.
  // clientInfo carries { protocolVersion, network?, sdkVersion? } from the handshake.
  onConnectionRequest: async (dapp, requestedPermissions, silent, clientInfo) => {
    if (silent) {
      // Check your approval storage — if not approved, return rejected
      return { approved: false, grantedPermissions: [] };
    }
    // Show approval UI to user
    const approved = await showApprovalUI(dapp, requestedPermissions);
    return { approved, grantedPermissions: requestedPermissions };
  },

  // Called when a dApp sends an intent (send tokens, sign message, etc.)
  onIntent: async (action, params, session) => {
    const result = await showIntentUI(action, params);
    return { result };
  },

  // Called when a dApp explicitly disconnects — clean up any persisted permissions
  onDisconnect: async (session) => {
    await removeApprovedOrigin(session.dapp.url);
  },

  // Notify-only: called when the compatibility gate rejects a connection.
  // Use this to surface the rejection reason in the wallet UI.
  // Does NOT affect the gate decision — the host already rejected when this fires.
  // `silent` is true for auto-connect attempts: avoid showing UI for those.
  onConnectionRejected: (dapp, error, silent) => {
    if (!silent) showRejectionBanner(dapp?.name, error.message);
  },

  // Optional: session TTL in ms (default: 24h, 0 = no expiry)
  sessionTtlMs: 86400000,

  // Optional secondary floors (rarely needed — the Connect MAJOR is the era gate)
  minSdkVersion: '0.9.0',    // reject dApps whose npm SDK version is older
  minMinorVersion: 0,         // minimum MINOR within the current MAJOR
});

// Revoke current session without destroying the host
host.revokeSession();

// Notify connected dApp that the wallet is locked / logged out
host.notifyWalletLocked();

// Destroy host and clean up transport
host.destroy();
```

### notifyWalletLocked()

Wallet hosts **must** call `host.notifyWalletLocked()` when the wallet is logged out or the `Sphere` instance is destroyed. This fires a `WALLET_EVENTS.LOCKED` event to the connected dApp so it can react appropriately (see [Wallet Lock Handling](#wallet-lock-handling) below).

In the Sphere web app's ConnectPage, watch the `sphere` instance and notify when it becomes null:

```typescript
useEffect(() => {
  if (sphere && hostRef.current) {
    hostRef.current.updateSphere(sphere);
  } else if (!sphere && !isLoading && hostRef.current) {
    hostRef.current.notifyWalletLocked();
  }
}, [sphere, isLoading]);
```

The extension's background script should do the same when the wallet is destroyed or the user logs out.

---

## autoConnect (recommended for browser dApps)

The simplest way to connect from a browser dApp. Auto-detects the best transport and handles the full lifecycle:

```typescript
import { autoConnect } from '@unicitylabs/sphere-sdk/connect/browser';
import { SPHERE_NETWORKS } from '@unicitylabs/sphere-sdk/connect';

const result = await autoConnect({
  dapp: { name: 'My App', url: location.origin },
  walletUrl: 'https://sphere.unicity.network',
  network: SPHERE_NETWORKS.testnet2, // required by the v2 compatibility gate
  silent: true, // auto-reconnect without UI if already approved
});

// Use the client
const balance = await result.client.query('sphere_getBalance');
await result.client.intent('send', { to: '@alice', amount: '1000000000000000000', coinId: '<lowercase 64-hex coin id>' }); // amount in base units
result.client.on('transfer:incoming', (data) => console.log(data));

// Disconnect
await result.disconnect();
```

### Transport priority

`autoConnect` selects the best transport automatically:

| Priority | Mode | Detection | Transport |
|----------|------|-----------|-----------|
| P1 | Iframe | `isInIframe()` | `PostMessageTransport` to parent |
| P2 | Extension | `hasExtension()` | `ExtensionTransport` via content script |
| P3 | Popup | fallback | `PostMessageTransport` to popup window |

You can force a specific transport:
```typescript
await autoConnect({ dapp, walletUrl, forceTransport: 'extension' });
```

### Auto-reconnect on page reload

For extension mode, the wallet's background service worker is always running. A silent connect on page load reconnects instantly if the origin is already approved:

```typescript
// On mount: try silent auto-connect
try {
  const result = await autoConnect({ dapp, walletUrl, silent: true });
  // Connected — origin was already approved
} catch {
  // Not approved — show Connect button
}
```

### Detection utilities

These are also exported from the SDK:
```typescript
import { isInIframe, hasExtension, detectTransport } from '@unicitylabs/sphere-sdk/connect/browser';
import type { DetectedTransport } from '@unicitylabs/sphere-sdk/connect/browser';

detectTransport(); // → 'iframe' | 'extension' | 'popup'
```

### AutoConnectResult

```typescript
interface AutoConnectResult {
  client: ConnectClient;              // Use for queries, intents, events
  connection: ConnectResult;          // Session info, identity, permissions
  transport: 'iframe' | 'extension' | 'popup';
  disconnect: () => Promise<void>;    // Clean up everything
}
```

---

## Setting up ConnectClient (dApp side)

```typescript
import { ConnectClient, SPHERE_NETWORKS } from '@unicitylabs/sphere-sdk/connect';
import type { NetworkInfo } from '@unicitylabs/sphere-sdk/connect';

const client = new ConnectClient({
  transport,
  dapp: {
    name: 'My dApp',
    description: 'A Sphere-connected application',
    url: location.origin,
  },

  // REQUIRED for the v2 compatibility gate: the network this dApp targets.
  // The wallet rejects the handshake with INCOMPATIBLE_NETWORK (4008) if it does not match.
  // Use SPHERE_NETWORKS for the canonical value — it is derived from constants.NETWORKS
  // so the numeric id cannot drift. Custom networks use the same shape: { id, name }.
  network: SPHERE_NETWORKS.testnet2,

  // Set to true for silent auto-connect checks (no approval popup shown)
  silent: false,

  // Resume a previous popup session (P3 / popup mode only)
  resumeSessionId: sessionStorage.getItem('sphere-session') ?? undefined,
});

// Connect — returns identity, sessionId, permissions
// Rejects with ConnectError if the compatibility gate refuses (see Error Handling below).
const result = await client.connect();
// result.identity   → { chainPubkey, directAddress?, nametag? }
// result.sessionId  → string (save for resumeSessionId on next load)
// result.permissions → PermissionScope[]

// After a successful connect, the wallet's active network is available:
// client.walletNetwork → NetworkInfo | null  (e.g. { id: 4, name: undefined })

// Queries — read data from wallet
const balance = await client.query('sphere_getBalance');
const assets  = await client.query('sphere_getAssets');

// Intents — wallet opens UI for user confirmation
const txResult = await client.intent('send', {
  to: '@alice',
  amount: '1000000000000000000',         // base units (smallest unit), as a string
  coinId: '<lowercase 64-hex coin id>',
});

// Sign a message (e.g. challenge-response auth)
const { signature, publicKey } = await client.intent('sign_message', {
  message: 'Sign in to My App\n\nNonce: abc123',
});

// Events — wallet pushes real-time updates
const unsub = client.on('transfer:incoming', (data) => {
  console.log('Incoming transfer:', data);
});

// Disconnect
await client.disconnect();
```

---

## Silent Mode

Silent mode lets a dApp check whether it is already approved by the wallet **without opening any approval UI**. This is used for auto-connect on page load.

```typescript
// On page load: silently check if already approved
const client = new ConnectClient({ transport, dapp, silent: true });
try {
  const result = await client.connect(); // fast: no popup, no UI
  // Already approved — restore session
} catch {
  // Not approved — show Connect button, wait for user action
}
```

The wallet's `onConnectionRequest` receives `silent=true` and must return `{ approved: false }` immediately if the origin is unknown, without opening any window.

---

## RPC Methods (query)

| Method | Params | Returns |
|--------|--------|---------|
| `sphere_getIdentity` | — | `PublicIdentity` |
| `sphere_getBalance` | `coinId?` | balance array |
| `sphere_getAssets` | `coinId?` | asset array |
| `sphere_getFiatBalance` | — | `{ fiatBalance }` |
| `sphere_getTokens` | `coinId?` | token array |
| `sphere_getHistory` | — | transaction history |
| `sphere_resolve` | `identifier` | resolved address info |
| `sphere_getConversations` | — | DM conversation list |
| `sphere_getMessages` | `peerPubkey, limit?, before?` | DM message page |
| `sphere_getDMUnreadCount` | `peerPubkey?` | unread count |
| `sphere_markAsRead` | `messageIds` | acknowledgement |
| `sphere_subscribe` | `event` | `{ subscribed, event }` |
| `sphere_unsubscribe` | `event` | `{ unsubscribed, event }` |
| `sphere_disconnect` | — | `{ disconnected }` |

> Invoice queries (`sphere_getInvoices`, `sphere_getInvoiceStatus`) exist in the protocol but
> are experimental and not enabled in the Sphere wallet — see [Experimental](#experimental--not-supported-by-the-sphere-wallet).

## Intent Actions (require user confirmation)

| Action | Params | Result (Sphere wallet) |
|--------|--------|------------------------|
| `send` | `to, amount, coinId, memo?` | `{ success, transferId?, status, deliveryPending }` |
| `dm` | `to, message` | `{ sent, messageId, timestamp }` |
| `payment_request` | `to, amount, coinId, message?` | `{ success, requestId }` |
| `receive` | — | `{ transfers }` |
| `sign_message` | `message` | `{ signature, publicKey }` |
| `mint` | `coinId` (lowercase hex), `amount` (smallest units) | `{ tokenId, coinId, amount }` |

> **Amount units:** `amount` is always in **base units** (the smallest indivisible unit), as a
> string — the same convention as `mint`, the token engine (`mintFungibleToken(coinId, amount: bigint)`)
> and the SDK's `payments.send`. Convert from a human amount at the dApp edge with the SDK's
> `parseTokenAmount('1.5', decimals)` (or ethers/viem `parseUnits`); display with `formatAmount`.
> `coinId` is always the canonical lowercase 64-hex id (a symbol like `UCT` is rejected).
>
> Invoice/accounting intents (`create_invoice` … `set_auto_return`) exist in the protocol but
> are experimental and not enabled in the Sphere wallet — see
> [Experimental](#experimental--not-supported-by-the-sphere-wallet).

### send Intent Result — delivery semantics

The `send` result distinguishes **on-chain finality** from **recipient-side delivery**:

- `deliveryPending: false` — the transfer certified on-chain **and** landed in the recipient's
  mailbox/transport. Done.
- `deliveryPending: true` — the spend is **committed on-chain** (or, for possibly-certified resolutions,
  may be) but the recipient-side delivery is
  journaled in the sender's wallet and retries automatically (covenant §3.1). **Never re-issue
  the send** — the source tokens are terminally spent, and a fresh `intent('send', …)` would
  pay the recipient a second time from different tokens. `transferId` may be absent on this
  path (possibly-certified resolutions carry no id; the still-open intent owns settlement).
- Treat the money as sent in both cases; use `deliveryPending` only to set expectations
  ("recipient may receive it with a delay") — not to gate retries.
- `status` is one of `'pending' | 'submitted' | 'confirmed' | 'delivered' | 'completed' | 'failed'`.
- The SDK's `TransferResult` also carries `deliveryState` (`'landed' | 'pending-delivery'`), but the wallet does **not** forward it over Connect — `deliveryPending` is the only delivery signal a dApp receives.

> **Server-side (Node.js) recipients:** a wallet built with bare `createNodeProviders` only
> listens on the Nostr transport and will **never see** deliveries from wallet-api-composed
> senders (which includes the hosted Sphere wallet — it delivers via the wallet-api mailbox,
> not Nostr). A Node.js recipient of dApp/wallet sends **must** compose the wallet-api
> delivery rail — `createWalletApiProviders(...)` or `createOwnStorageWalletApiProviders(...)`
> — see [QUICKSTART-NODEJS.md](QUICKSTART-NODEJS.md). Deposits made before the recipient
> composes the rail stay claimable in the mailbox.

### sign_message Intent

The `sign_message` intent lets a dApp request a cryptographic signature from the wallet. The wallet signs using secp256k1 ECDSA with a Bitcoin-like double-SHA256 hash and the `Sphere Signed Message:\n` prefix.

```typescript
// dApp requests signature
const result = await client.intent('sign_message', {
  message: 'Sign in to My App\n\nDomain: example.com\nNonce: R_6j46iCPW\nIssued At: 2026-03-03T20:50:26Z',
});

// result = { signature: '1f3a5b7c...', publicKey: '02ed95e9...' }
// signature: 130-char hex (v + r + s), publicKey: 66-char compressed secp256k1
```

**Server-side verification** (using SDK crypto functions):

```typescript
import { verifySignedMessage } from '@unicitylabs/sphere-sdk';

const isValid = verifySignedMessage(originalMessage, signature, expectedPubkey);
// Recovers pubkey from signature via ECDSA recovery and compares with expected
```

**Security properties:**
- Private key never leaves the wallet — signing happens inside `Sphere.signMessage()`
- Recoverable signature — server can verify without storing the public key
- Canonical signatures — prevents signature malleability attacks
- The wallet displays the full message text for user review before signing

### mint Intent

The `mint` intent lets a dApp ask the connected wallet to **self-mint** a fungible token to the user's own wallet (the v2 replacement for the testnet faucet). The wallet always asks the user to confirm; minting is never silent.

```typescript
// dApp requests a self-mint (coinId is lowercase hex, amount in smallest units)
const result = await client.intent('mint', {
  coinId: '1111111111111111111111111111111111111111111111111111111111111111',
  amount: '1000000',
});

// result = { tokenId: '…64-hex…', coinId: '…', amount: '1000000' }
```

Requires the `mint:request` permission scope. Minting only succeeds on networks that allow standalone self-mint (testnet2 today); on networks where it is unavailable the wallet returns an error from the token engine.

When the wallet runs with **subscriptions enabled**, a `mint` is rejected with `INTERNAL_ERROR` and the message `Subscription is still being set up — try again in a moment` until the wallet's per-wallet subscription key reaches the oracle. This is transient — treat it as a retry, not a failure. It never occurs on wallets running without subscriptions.

## Experimental — not supported by the Sphere wallet

Invoicing/accounting is **defined in the protocol** for forward-compatibility but is
**experimental and not enabled in the Sphere wallet**: it is implemented in the SDK and
unit-tested, but has no live/e2e verification and is not wired into the wallet. The wallet
rejects these intents with `METHOD_NOT_FOUND`, and the invoice queries error with
`MODULE_NOT_AVAILABLE`. **Do not use them yet.**

- **Intents** (scope `invoice:write`, or `transfer:request` for the paying ones):
  `create_invoice`, `close_invoice`, `cancel_invoice`, `pay_invoice`,
  `return_invoice_payment`, `import_invoice`, `send_invoice_receipts`,
  `send_cancellation_notices`, `set_auto_return`.
- **Queries** (scope `invoice:read`): `sphere_getInvoices`, `sphere_getInvoiceStatus`.

## Events (wallet → dApp push)

| Event | Payload | Delivery |
|-------|---------|----------|
| `transfer:incoming` | token transfer received | via `sphere_subscribe` |
| `transfer:confirmed` | transfer confirmed on chain | via `sphere_subscribe` |
| `transfer:failed` | transfer failed | via `sphere_subscribe` |
| `wallet:locked` | wallet locked / logged out | auto-pushed (no subscribe) |
| `identity:changed` | active identity changed | auto-pushed (no subscribe) |

> Session expiry is **not** an event — the next request after the TTL is rejected with
> error `4004 SESSION_EXPIRED`.

### Wallet Lock Handling

When the wallet is locked or the user logs out, the host fires a `WALLET_EVENTS.LOCKED` event (see [`notifyWalletLocked()`](#notifywalletlocked) above). How the dApp handles this depends on the transport mode:

#### Popup mode (P3)

Fully disconnect — destroy the transport, clear the client reference, and remove the saved session from `sessionStorage`. **Do not close the popup window itself**, because the user may log into a different wallet in the same popup. The dApp should show the "Connect" button again.

```typescript
client.on('wallet:locked', async () => {
  await disconnect();
  sessionStorage.removeItem(SESSION_KEY);
  setClient(null);
  setConnection(null);
  // Do NOT call popup.close() — user may log in again in the popup
});
```

#### Extension / iframe mode (P1, P2)

The wallet's background service worker or parent frame stays alive. Instead of disconnecting, set a `isWalletLocked` flag and wait for the user to unlock. When the wallet is unlocked, the host calls `updateSphere(newSphere)` and fires an `identity:changed` event, which signals the dApp to resume:

```typescript
client.on('wallet:locked', () => {
  setIsWalletLocked(true);
});

client.on('identity:changed', (identity) => {
  setIsWalletLocked(false);
  // Refresh UI with new identity if it changed
});
```

---

## Error Handling

`client.connect()` rejects with a **`ConnectError`** when the compatibility gate refuses the connection. `ConnectError` has a numeric `.code` and an optional `.data` payload with rejection details.

**Important:** discriminate on the numeric `.code`, not `instanceof ConnectError`. The `instanceof` check is unreliable when multiple bundle copies of the SDK are present (e.g. a dApp and its dependencies each bundling the SDK separately).

```typescript
import { ConnectError, ERROR_CODES } from '@unicitylabs/sphere-sdk/connect';

try {
  await client.connect();
} catch (e) {
  const code = (e as { code?: number })?.code;
  if (code === ERROR_CODES.INCOMPATIBLE_NETWORK) {
    // data.reason = 'network_incompatible'
    // data.walletNetwork = { id: number }
    // data.clientNetwork = NetworkInfo | null
    showWrongNetwork((e as ConnectError).data);
  } else if (code === ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION) {
    // data.reason = 'protocol_incompatible'
    // data.walletProtocol = '2.0', data.clientProtocol = '1.0' (for example)
    showUpdateRequired((e as ConnectError).data);
  } else {
    showGenericError();
  }
}
```

### Error codes

| Code | Constant | When |
|------|----------|------|
| 4007 | `ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION` | Connect MAJOR version mismatch (e.g. v1 dApp connecting to v2 wallet). dApp must update its SDK. |
| 4008 | `ERROR_CODES.INCOMPATIBLE_NETWORK` | dApp targets a different network than the wallet (or omitted `network` in `ConnectClientConfig`). |
| 4001 | `ERROR_CODES.NOT_CONNECTED` | Request sent before `connect()` succeeded. |
| 4002 | `ERROR_CODES.PERMISSION_DENIED` | Method or intent not in granted permissions. |
| 4003 | `ERROR_CODES.USER_REJECTED` | User rejected an intent in the wallet UI. |
| 4004 | `ERROR_CODES.SESSION_EXPIRED` | Session TTL elapsed. |
| 4005 | `ERROR_CODES.ORIGIN_BLOCKED` | dApp origin is blocked by the wallet. |
| 4006 | `ERROR_CODES.RATE_LIMITED` | Too many requests per second. |
| 4100 | `ERROR_CODES.INSUFFICIENT_BALANCE` | Send intent failed — not enough tokens. |
| 4101 | `ERROR_CODES.INVALID_RECIPIENT` | Recipient not resolvable to a chain pubkey. |
| 4102 | `ERROR_CODES.TRANSFER_FAILED` | Transfer execution failed. |
| 4200 | `ERROR_CODES.INTENT_CANCELLED` | Intent cancelled (user closed wallet UI). |

Rejection `.data` for the two gate errors:

```typescript
// UNSUPPORTED_PROTOCOL_VERSION (4007)
{
  reason: 'protocol_incompatible';
  walletProtocol: string;  // e.g. '2.0'
  clientProtocol: string;  // e.g. '1.0'
}

// INCOMPATIBLE_NETWORK (4008)
{
  reason: 'network_incompatible';
  walletNetwork: { id: number };       // wallet's active network
  clientNetwork: NetworkInfo | null;   // what the dApp sent (null if omitted)
}
```

---

## Permission Scopes

Permissions are requested during handshake and checked on every request:

| Scope | Grants access to |
|-------|-----------------|
| `identity:read` | `sphere_getIdentity`, `receive` intent (always granted) |
| `balance:read` | `sphere_getBalance`, `sphere_getFiatBalance`, `sphere_getAssets` |
| `tokens:read` | `sphere_getTokens` |
| `history:read` | `sphere_getHistory` |
| `events:subscribe` | `sphere_subscribe`, `sphere_unsubscribe` |
| `resolve:peer` | `sphere_resolve` |
| `transfer:request` | `send` intent |
| `dm:request` | `dm` intent |
| `dm:read` | `sphere_getConversations`, `sphere_getMessages`, `sphere_getDMUnreadCount` |
| `dm:manage` | `sphere_markAsRead` |
| `payment:request` | `payment_request` intent |
| `sign:request` | `sign_message` intent |
| `mint:request` | `mint` intent (self-mint a fungible token) |
| `invoice:read` | invoice queries (experimental — see above) |
| `invoice:write` | invoice intents (experimental — see above) |

---

## Session Resume (popup mode)

When using a popup window (P3), the session ID can be persisted to avoid re-showing the approval modal on page reload. Extension mode (P2) does not need this — the extension's background service worker keeps the session alive, and a silent `autoConnect` on mount is sufficient.

### Full lifecycle

**1. Save session after successful connect:**

```typescript
const SESSION_KEY = 'sphere-session';

const result = await autoConnect({ dapp, walletUrl, permissions });
sessionStorage.setItem(SESSION_KEY, result.connection.sessionId);
```

**2. Resume on page refresh:**

Read the saved sessionId and pass it as `resumeSessionId`. If resume fails (e.g. wallet popup was closed), clear storage and fall back to a fresh connect:

```typescript
const savedSession = sessionStorage.getItem(SESSION_KEY);

try {
  const result = await autoConnect({
    dapp,
    walletUrl,
    permissions,
    resumeSessionId: savedSession ?? undefined,
  });
  sessionStorage.setItem(SESSION_KEY, result.connection.sessionId);
} catch {
  sessionStorage.removeItem(SESSION_KEY);
  // Show Connect button — session could not be resumed
}
```

**3. Clear on disconnect:**

```typescript
await result.disconnect();
sessionStorage.removeItem(SESSION_KEY);
```

**4. `willAutoConnect` check:**

To prevent a flash of the Connect button before auto-connect completes, check whether a resume is likely to succeed before rendering:

```typescript
const willAutoConnect =
  !!sessionStorage.getItem(SESSION_KEY) || (await hasExtension());
```

Use this to show a loading state instead of the Connect button while auto-connect is in progress.

### Low-level ConnectClient usage

If you are using `ConnectClient` directly instead of `autoConnect`:

```typescript
const client = new ConnectClient({
  transport,
  dapp,
  resumeSessionId: sessionStorage.getItem(SESSION_KEY) ?? undefined,
});
```

The host will skip `onConnectionRequest` if the presented `sessionId` matches the active session.

---

## Versioning & Deprecation Policy

Connect uses semver MAJOR.MINOR. The rules:

| Change type | Version bump | Notes |
|-------------|-------------|-------|
| Add method / intent / event / optional field | MINOR | No break — peers feature-detect by version |
| Change or remove an existing message / field | MAJOR | Breaking — requires a deprecation window |
| Behaviour fix with no wire change | PATCH (no Connect bump) | Invisible to peers |

**Enforced in CI:** `tests/unit/connect/protocol-surface.test.ts` snapshots the full wire surface (intents, scopes, methods) + `SPHERE_CONNECT_VERSION`. Any change to the surface fails that test until you bump the version and update its snapshot — so the bump can't be forgotten.

**Deprecation window for MAJOR changes:** announce the upcoming MAJOR → soft-warn via the handshake response `warning` field (non-fatal, logged by the client) → reject (MAJOR bumped). Never a flag-day cut except the current v1 → v2 migration (v1 peers are genuinely incompatible — no transition period is possible).

The `warning` field in `SphereHandshake` is reserved for this deprecation flow. No call site emits one yet.

---

## Migration Order (wallet-first rollout)

When the wallet and dApps must both update (e.g. a new mandatory field or a MAJOR bump), always deploy in this order:

1. **Deploy the gated wallet first** (Sphere, centrally deployed) — it must accept both the old and new client versions during the transition window, OR the MAJOR has been bumped and old clients are intentionally rejected.
2. **Release the new SDK** — makes dApps send the new fields (e.g. `network` + `sdkVersion` in v2).
3. **Upgrade dApps** — update to the new SDK, declare `ConnectClientConfig.network`, wire `onConnectionRejected`.

For the v1 → v2 migration specifically: the wallet already requires v2; dApps must update to SDK ≥ 0.9.x and declare `network` in their `ConnectClientConfig`.

**Downstream repos that need separate PRs for v2:**
- `sphere-sdk-connect-example` — declare `ConnectClientConfig.network` in all example clients.
- `sphere` (wallet) — wire `onConnectionRejected` in the Connect page host config.

---

## Deferred: Runtime Network Switching

There is no `switch_network` intent, no `network:changed` event, and no `switchNetwork()` method. A network mismatch at handshake time is rejected with `INCOMPATIBLE_NETWORK` (4008). Runtime switching is deferred to a future multi-network effort — only testnet2 is live, and the SDK has no runtime network switch.
