# Sphere Connect — Developer Guide

Sphere Connect is a secure wallet-dApp communication protocol. It allows web applications (dApps) to request wallet operations from a Sphere wallet — reading balances, sending tokens, signing messages — without exposing private keys.

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

---

## Setting up ConnectHost (wallet side)

```typescript
import { ConnectHost } from '@unicitylabs/sphere-sdk/connect';

const host = new ConnectHost({
  sphere,        // Sphere SDK instance
  transport,     // any ConnectTransport

  // Called when a new dApp requests connection.
  // silent=true means: reject immediately if not already approved — do NOT open any UI.
  onConnectionRequest: async (dapp, requestedPermissions, silent) => {
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

  // Optional: session TTL in ms (default: 24h, 0 = no expiry)
  sessionTtlMs: 86400000,
});

// Revoke current session without destroying the host
host.revokeSession();

// Destroy host and clean up transport
host.destroy();
```

---

## Setting up ConnectClient (dApp side)

```typescript
import { ConnectClient } from '@unicitylabs/sphere-sdk/connect';

const client = new ConnectClient({
  transport,
  dapp: {
    name: 'My dApp',
    description: 'A Sphere-connected application',
    url: location.origin,
  },

  // Set to true for silent auto-connect checks (no approval popup shown)
  silent: false,

  // Resume a previous popup session (P3 / popup mode only)
  resumeSessionId: sessionStorage.getItem('sphere-session') ?? undefined,
});

// Connect — returns identity, sessionId, permissions
const result = await client.connect();
// result.identity   → { chainPubkey, l1Address, directAddress?, nametag? }
// result.sessionId  → string (save for resumeSessionId on next load)
// result.permissions → PermissionScope[]

// Queries — read data from wallet
const balance = await client.query('sphere_getBalance');
const assets  = await client.query('sphere_getAssets');

// Intents — wallet opens UI for user confirmation
const txResult = await client.intent('send', {
  recipient: '@alice',
  amount: 100,
  coinId: 'USDC',
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
| `sphere_l1GetBalance` | — | L1 balance |
| `sphere_l1GetHistory` | `limit?` | L1 history |
| `sphere_resolve` | `identifier` | resolved address info |
| `sphere_subscribe` | `event` | `{ subscribed, event }` |
| `sphere_unsubscribe` | `event` | `{ unsubscribed, event }` |
| `sphere_disconnect` | — | `{ disconnected }` |

## Intent Actions (require user confirmation)

| Action | Params |
|--------|--------|
| `send` | `recipient, amount, coinId` |
| `l1_send` | `recipient, amount` |
| `dm` | `recipient, content` |
| `payment_request` | `amount, coinId, description?` |
| `receive` | `coinId?` |
| `sign_message` | `message` |

## Events (wallet → dApp push)

| Event | Payload |
|-------|---------|
| `transfer:incoming` | token transfer received |
| `transfer:confirmed` | transfer confirmed on chain |
| `transfer:failed` | transfer failed |
| `balance:updated` | balance changed |
| `identity:updated` | identity info changed |
| `session:expired` | session TTL reached |

---

## Permission Scopes

Permissions are requested during handshake and checked on every request:

| Scope | Grants access to |
|-------|-----------------|
| `identity:read` | `sphere_getIdentity` |
| `balance:read` | `sphere_getBalance`, `sphere_getFiatBalance` |
| `assets:read` | `sphere_getAssets` |
| `tokens:read` | `sphere_getTokens` |
| `history:read` | `sphere_getHistory` |
| `l1:read` | `sphere_l1GetBalance`, `sphere_l1GetHistory` |
| `events:subscribe` | `sphere_subscribe/unsubscribe` |
| `intent:send` | `send` intent |
| `intent:l1_send` | `l1_send` intent |
| `intent:dm` | `dm` intent |
| `intent:payment_request` | `payment_request` intent |
| `intent:receive` | `receive` intent |
| `intent:sign_message` | `sign_message` intent |
| `comms:read` | DM conversations |
| `comms:write` | send DMs |

---

## Session Resume (popup mode)

When using a popup window (P3), the session ID can be persisted to avoid re-showing the approval modal on page reload:

```typescript
// Save after connect
sessionStorage.setItem('sphere-session', result.sessionId);

// Restore on next load
const client = new ConnectClient({
  transport,
  dapp,
  resumeSessionId: sessionStorage.getItem('sphere-session') ?? undefined,
});
```

The host will skip `onConnectionRequest` if the presented `sessionId` matches the active session.
