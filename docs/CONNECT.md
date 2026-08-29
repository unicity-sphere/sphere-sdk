# Sphere Connect — Developer Guide

Sphere Connect is a secure wallet-dApp communication protocol. It allows web applications (dApps) to request wallet operations from a Sphere wallet — reading balances, sending tokens, signing messages — without exposing private keys.

## Protocol Version

The current Connect protocol version is **`2.1`** (`SPHERE_CONNECT_VERSION = '2.1'`).

> **sphere-sdk 0.15.0 does NOT bump it.** That release is a hard wire break on the
> *state-transition* protocol, but Connect messages carry no state-transition bytes — the token
> blob never crosses this wire (`sphere_getTokens` strips `sdkData`, as it always has). Method
> list, params, result shapes, events, scopes and error codes are byte-identical to 0.14.x.
> The `minSdkVersion` floor DOES move, to `0.15.0-0` — see below. What else changed is
> wallet-host-side: see
> [ConnectHost: the `SphereInstance` contract](#connecthost-the-sphereinstance-contract).

### Compatibility policy

- **Same MAJOR = compatible.** A dApp on 2.0 and a wallet on 2.1 connect fine — MINOR versions within the same MAJOR interoperate.
- **Different MAJOR = rejected.** A v1-era dApp (protocol `'1.0'`) that attempts to handshake with a v2 wallet is rejected with `UNSUPPORTED_PROTOCOL_VERSION` (4007). That peer must update its SDK.
- The **v1 → v2** cut is a one-time hard break: v1 peers are genuinely incompatible and must upgrade.

### Handshake fields

> **SDK version floor (`0.15.0-0`, the state-transition-sdk 3.x line):** the host rejects any
> client whose handshake `sdkVersion` is missing or below `0.15.0-0` (every 0.15.0 prerelease
> passes — those pin the 3.x SDK too) with `UNSUPPORTED_PROTOCOL_VERSION` (4007) and a message
> naming the required minimum. The Connect wire did not change, but `sphere_getTokens` hands raw
> token CBOR across it and a client on the 2.x line cannot decode a 3.x token — it fails with
> `Unsupported Token version`. Such a client is already non-functional against this wallet, so
> the floor turns a cryptic decode failure deep in the dApp into one legible refusal at the
> handshake. Override via `ConnectHostConfig.minSdkVersion`. The claim is compatibility hygiene,
> not security — a hostile client can lie about it.

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
  sphere,        // Sphere SDK instance — pass null when initialWalletState is 'locked'
  transport,     // any ConnectTransport
  origin,        // optional: the origin this host serves, for the wallet's own badge and logs
                 // (NEVER session.dapp.url, which is dApp-CLAIMED metadata)
  initialWalletState: 'locked',  // optional — pass when the wallet is already locked at
                                 // construction (cold start with an encrypted wallet)

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
  // ctx (Connect 2.1) carries the host-side deadline and an AbortSignal: DISMISS YOUR MODAL
  // when it aborts, otherwise the host's own deadline manufactures a double-submit.
  onIntent: async (action, params, session, ctx) => {
    ctx?.signal.addEventListener('abort', () => closeIntentUI());
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

  // Notify-only: the host has ALREADY answered WALLET_LOCKED (4009), or refused a handshake
  // while locked. It never waits for you, and a throw here cannot break it.
  //
  // THIS MUST NOT RAISE A CREDENTIAL SURFACE. A dApp request may trigger a CONSENT prompt;
  // it may never trigger a password field. Light a PASSIVE badge in your PERMANENT chrome
  // ("N requests waiting — Unlock"); show the password field only after a human clicks it.
  // Volume is already bounded by the rate limiter — no coalescing, no cooldown, no cap.
  onLockedRequest: ({ origin, kind, name }) => {
    bumpWaitingBadge({ origin, kind, name });   // origin may be undefined — say "a connected app"
  },

  // Optional: session TTL in ms (default: 24h, 0 = no expiry)
  sessionTtlMs: 86400000,

  // Optional host-side deadlines. The host answers within them no matter what the wallet
  // does, so a dApp never hangs on an abandoned modal.
  requestDeadlineMs: 25000,     // query
  // Intent. MUST stay above ConnectClient's own intentTimeout (120 s default): whoever answers
  // first defines the outcome, and the host cannot know whether the wallet already submitted
  // the transfer. Expiry answers INTENT_OUTCOME_UNKNOWN (4201) — never a cancellation — and
  // aborts ctx.signal so a wallet that CAN still back out does.
  intentDeadlineMs: 180000,
  handshakeDeadlineMs: 120000,  // onConnectionRequest — expiry sends the empty refusal

  // Optional secondary floors (rarely needed — the Connect MAJOR is the era gate)
  minSdkVersion: '0.9.0',    // reject dApps whose npm SDK version is older
  minMinorVersion: 0,         // minimum MINOR within the current MAJOR
});

// The wallet LOCKED. The session is PRESERVED — this is a state, not a teardown.
host.setLocked();

// The Sphere instance is gone for a NON-lock reason (a generic init failure).
// A dead end: unlocking cannot cure it, so it revokes.
host.setUnavailable();

// Destroy the SESSION (logout, wallet deleted, popup closing). Pushes wallet:disconnected.
host.revokeSession();

// Bind a (new) Sphere: the address-switch path AND the unlock path.
host.updateSphere(sphere);

// Destroy host and clean up transport
host.destroy();
```

### ConnectHost: the `SphereInstance` contract

`ConnectHost` does not require a real `Sphere` — it works against anything shaped like
`SphereInstance` (`connect/host/SphereInstance.ts`), which is how wallet hosts and tests inject
their own object. The type is deliberately internal: `ConnectHostConfig.sphere` is declared
`unknown` and `SphereInstance` is not re-exported from `connect/`, so a hand-rolled host object
is checked at RUNTIME, never by your compiler. **That shape changed in 0.15.0**, in step with the
SDK dropping the `sphere.paymentsV2` alias:

```typescript
export interface SphereInstance {
  readonly identity: { chainPubkey: string; directAddress?: string; nametag?: string } | null;
  readonly networkId?: number;
  /** The payments facade. Read LAZILY, per query branch — see below. */
  readonly payments: PaymentsV2;
  signMessage(message: string): string;
  resolve(identifier: string): Promise<unknown>;
  on<T extends SphereEventType>(type: T, handler: SphereEventHandler<T>): () => void;
  // …
}
```

- The legacy `payments: { getBalance/getAssets/… }` shape and the optional `paymentsV2` member are
  **both gone** — hand over the facade as `payments`. Because the config field is `unknown`, a host
  that supplies only the old read shape breaks on the first money query, not at build time.
- **Read `payments` per query, never once up front.** A real `Sphere`'s getter **throws**
  `NOT_INITIALIZED` while no vertical runs — init in flight, mid address-switch, destroyed — and
  `sphere_getIdentity` must still answer in that window. Implement it as a getter, not a field
  captured at construction.

None of this reaches a dApp: the wire is unchanged.

### The lifecycle verbs

`notifyWalletLocked()` **no longer exists**. Its old meaning was *revoke*; its new meaning would
be *lock* — the opposite — so it was removed rather than aliased, to force every call site to pick
a verb at compile time.

| Wallet transition | Call | Wire event | Session |
|---|---|---|---|
| manual lock, idle auto-lock, cold start locked | `setLocked()` | `wallet:locked` | **preserved** |
| unlock | `updateSphere(next)` | `wallet:unlocked` | preserved |
| logout, wallet deleted, popup `beforeunload` | `revokeSession()` | `wallet:disconnected` | destroyed |
| Sphere gone for a non-lock reason | `setUnavailable()` | `wallet:disconnected` | destroyed |

**Ordering contract:** call `setLocked()` **before** `sphere.destroy()`. The host drops its own
Sphere reference in `setLocked()`; destroying first leaves in-flight requests reading a dead
instance.

```typescript
useEffect(() => {
  if (sphere && hostRef.current) {
    hostRef.current.updateSphere(sphere);          // unlock, or a live address switch
  } else if (!sphere && !isLoading && hostRef.current) {
    hostRef.current.setLocked();                   // a LOCK — the dApp stays connected
  }
}, [sphere, isLoading]);
```

While locked, a host that HOLDS a session answers exactly four of the fourteen `RPC_METHODS`:
`sphere_getIdentity` (from an immutable snapshot), `sphere_subscribe`, `sphere_unsubscribe` and
`sphere_disconnect`. The other **ten, and every intent**, are refused `WALLET_LOCKED` (4009):
the five money reads (`getBalance`, `getAssets`, `getFiatBalance`, `getTokens`, `getHistory`),
`sphere_resolve`, and **all four DM reads** (`getConversations`, `getMessages`, `getDMUnreadCount`,
`markAsRead`). Nothing is served from a cache — a dApp holding a stale
balance is about to offer an unpayable spend — and **messaging does not keep working while
locked**, so a dApp must stop polling and wait rather than collect refusals.

A wallet that **cold-starts locked** is different, and it is the common path: the password is
memory-only, so a page reload or a fresh popup lands there. Such a host holds no session and an
empty snapshot, so the HANDSHAKE itself is refused with an errorless empty response — `connect()`
rejects with a bare "Connection rejected by wallet" carrying **no code at all**. There is no 4009
to match on. That silence is deliberate: the refusal must reveal nothing about the wallet to an
origin holding no approval. Treat it as "not ready yet" rather than a permanent rejection — keep
waiting for `HOST_READY`, which the wallet emits once a human unlocks it.

On the way back, `updateSphere()` compares the new Sphere's `chainPubkey` against the one frozen
at lock time. A mismatch — "Forgot password → restore from recovery phrase" installs a different
seed behind an origin-keyed approval — **revokes** instead of unlocking.

### onLockedRequest — a badge, never a password field

`ConnectHostConfig.onLockedRequest` is notify-only: the host has **already** answered 4009 and
never waits for the wallet. A throw from it cannot break the host.

**It must not raise a credential surface.** A dApp request may trigger a *consent* prompt; it may
never trigger a *password* field. Light a passive badge in your permanent chrome ("N requests
waiting — Unlock") and show the password field only after a human clicks it. Volume is already
bounded by the rate limiter, which now guards the query, intent and handshake paths — there is no
coalescing, no cooldown and no cap by design.

`ctx.origin` is `ConnectHostConfig.origin`, i.e. what the *wallet* knows. It is never
`session.dapp.url`, which is dApp-claimed metadata. When it is absent, say "a connected app" —
never claim an origin you cannot verify.

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

> The money queries (`sphere_getBalance`/`getAssets`/`getFiatBalance`/`getTokens`/`getHistory`)
> keep their pre-flip result shapes, served from the payments facade through the host's
> wire-compat adapter — see [Compatibility](#compatibility-the-old-wire-contract-on-a-v2-host).

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
> string — the same convention as the SDK's `payments.mint(coinId, amount: bigint)`
> and `payments.send`. Convert from a human amount at the dApp edge with the SDK's
> `parseTokenAmount('1.5', decimals)` (or ethers/viem `parseUnits`); display with `formatAmount`.
> `coinId` is always the canonical lowercase 64-hex id (a symbol like `UCT` is rejected).

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

> **Server-side (Node.js) recipients:** a wallet built with bare `createNodeProviders` has no
> money rail at all — `Sphere.init` refuses with `INVALID_CONFIG`. Attach the wallet-api
> transport config with `createWalletApiProviders(...)` — see
> [QUICKSTART-NODEJS.md](QUICKSTART-NODEJS.md). Deposits made before the recipient composes the
> rail stay claimable in the mailbox.

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

## Removed: the invoice surface (P11 flip)

The experimental invoice surface — 2 queries (`sphere_getInvoices`, `sphere_getInvoiceStatus`),
9 intents (`create_invoice` … `set_auto_return`) and 2 scopes (`invoice:read`, `invoice:write`)
— was **removed from the protocol** when the SDK's accounting module was deleted. It was never
enabled in any wallet host (every call answered `MODULE_NOT_AVAILABLE`), and the protocol
version stays 2.1. A removed method or intent now answers the standard `METHOD_NOT_FOUND` path;
requesting the removed scopes fails permission validation.

## Events (wallet → dApp push)

| Event | Payload | Delivery |
|-------|---------|----------|
| `transfer:incoming` | token transfer received | via `sphere_subscribe` |
| `transfer:confirmed` | transfer confirmed on chain | via `sphere_subscribe` (compat adapter) |
| `transfer:failed` | transfer failed | via `sphere_subscribe` (compat adapter) |
| `wallet:locked` | wallet locked — **the session is alive** | auto-pushed (no subscribe) |
| `wallet:unlocked` | wallet unlocked, carries the current identity | auto-pushed (no subscribe) |
| `wallet:disconnected` | the session is GONE — re-handshake to continue | auto-pushed (no subscribe) |
| `identity:changed` | active identity changed | auto-pushed (no subscribe) |

> The four wallet events are pushed unconditionally and **cannot** be subscribed —
> `sphere_subscribe` refuses them. `Sphere.on()` accepts any string and would silently never
> emit for them, so the subscribe used to succeed and deliver nothing forever.

## Compatibility: the old wire contract on a v2 host

The SDK's payments vertical (P11 flip) replaced the old module's events and read methods, but
**the Connect wire contract is unchanged — dApps change nothing.** The host serves the old
contract through a built-in adapter (`connect/host/payments-compat.ts`). As of 0.15.0 it is the
only path — the host's pre-flip fallbacks went with the `sphere.paymentsV2` alias.

- **Queries:** `sphere_getBalance` and `sphere_getAssets` are both served from
  `payments.assets()` — the same call, the same array (the Asset shape is unchanged;
  `unconfirmed*` fields are pinned `'0'`/`0`). `sphere_getFiatBalance` sums the priced assets
  (still `null` when no price data), `sphere_getTokens` comes from `payments.tokens()` with the
  internal `sdkData` field stripped, and `sphere_getHistory` from `payments.history()` — the flat
  entry array, entries keeping `timestamp`/`symbol`/`tokenIds`. Parameterless `sphere_getHistory`
  still walks the facade's cursors to exhaustion, because the legacy wire has no cursor and
  completeness is the contract.
- **Events:** every old dApp-subscribable name keeps firing with its old payload shape,
  re-emitted from the 8 v2 events: `transfer:confirmed` / `transfer:delivery_pending` /
  `transfer:failed` from `transfer:updated` (by `status`/`deliveryPending`);
  `payment_request:paid|rejected|expired` from `payment_request:updated`;
  `split:checkpoint-stuck` / `delivery:undeliverable` / `delivery:deferred` from
  `transfer:attention` (by code); `realtime:status` / `storage:degraded` from
  `connection:status`; `sync:completed` / `sync:remote-update` from `inventory:updated`.
  (`send:partial-remainder` is not re-emitted — folded by design, no consumer existed.)
- **Subscribing to the new v2 names** (`transfer:updated`, `transfer:attention`,
  `inventory:updated`, `connection:status`, `payment_request:updated`, …) also works — they are
  ordinary `Sphere.on()` events.

> Session expiry is **not** an event — the next request after the TTL is rejected with
> error `4004 SESSION_EXPIRED`.

### Wallet Lock Handling

**A lock is not a disconnect.** `wallet:locked` means the wallet is locked and the session is
**still alive**: stay connected, keep your `sessionId`, do not re-handshake. Requests answer
`WALLET_LOCKED` (4009) until `wallet:unlocked` arrives on the same session. This is identical in
every transport mode — the old popup-vs-iframe split is gone.

```typescript
client.on('wallet:locked', () => {
  setWalletLocked(true);           // render "wallet locked — unlock to continue"
});                                // do NOT disconnect, do NOT clear the session

client.on('wallet:unlocked', ({ identity }) => {
  setWalletLocked(false);
  // The identity may differ from the one you connected with (a legal address switch before the
  // lock). Compare it before replaying anything that moves money.
  if (identity?.chainPubkey !== connectedChainPubkey) rebuildForNewIdentity(identity);
  else refresh();                  // your own retry — the SDK does not replay for you
});

client.on('wallet:disconnected', () => {
  // THIS is the teardown signal: logout, wallet deleted, or the session expired.
  fullDisconnect();
});
```

Discriminate on `error.code === 4009` (and `error.data.reason === 'locked'`), never on the
message text.

The client tracks this for you: `client.walletLocked` is `true` between the two events, and
`client.isConnected` stays `true` throughout.

#### Old wallets

A Connect **2.0** wallet destroys the session on lock and never emits `wallet:unlocked` or
`wallet:disconnected`, so a dApp waiting for either against one waits forever. Feature-detect
with `client.walletProtocol` after a successful handshake.

#### Resuming during a lock

A resume with a matching `sessionId` **succeeds** while the wallet is locked, and
`ConnectResult.locked` is `true` — this is the common case of a dApp that reloaded mid-lock. It
is connected and must wait for `wallet:unlocked`, not re-handshake.

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
    // data.walletProtocol = '2.1', data.clientProtocol = '1.0' (for example)
    // A version floor also sends what it demanded: data.requiredProtocol, or
    // data.requiredSdk + data.actualSdk. `e.message` already names both sides —
    // showing it verbatim is enough if you have no custom copy.
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
| 4009 | `ERROR_CODES.WALLET_LOCKED` | The wallet is locked. **The session is still alive** — retry after `wallet:unlocked`. Carries `data: { reason: 'locked' }`. Discriminate on the code, never on the message. |
| 4001 | `ERROR_CODES.NOT_CONNECTED` | Request sent before `connect()` succeeded. |
| 4002 | `ERROR_CODES.PERMISSION_DENIED` | Method or intent not in granted permissions. |
| 4003 | `ERROR_CODES.USER_REJECTED` | User rejected an intent in the wallet UI. |
| 4004 | `ERROR_CODES.SESSION_EXPIRED` | Session TTL elapsed. |
| 4005 | `ERROR_CODES.ORIGIN_BLOCKED` | dApp origin is blocked by the wallet. |
| 4006 | `ERROR_CODES.RATE_LIMITED` | Too many requests per second. |
| 4100 | `ERROR_CODES.INSUFFICIENT_BALANCE` | Send intent failed — not enough tokens. |
| 4101 | `ERROR_CODES.INVALID_RECIPIENT` | Recipient not resolvable to a chain pubkey. |
| 4102 | `ERROR_CODES.TRANSFER_FAILED` | Transfer execution failed. |
| 4200 | `ERROR_CODES.INTENT_CANCELLED` | Intent cancelled — the user declined and **nothing happened**. Safe to re-offer. |
| 4201 | `ERROR_CODES.INTENT_OUTCOME_UNKNOWN` | The intent reached the wallet and the answer was lost (a host deadline, a lock, a logout). **The outcome is unknown — the money may or may not have moved. Do NOT retry**; reconcile out of band first. |

Rejection `.data` for the two gate errors:

```typescript
// UNSUPPORTED_PROTOCOL_VERSION (4007)
{
  reason: 'protocol_incompatible';
  walletProtocol: string;  // e.g. '2.1'
  clientProtocol: string;  // e.g. '1.0'

  // Only on the optional MINOR floor — the MINOR the wallet demands, e.g. '2.1'.
  requiredProtocol?: string;

  // Only on the optional npm-SDK floor.
  requiredSdk?: string;         // e.g. '0.12.0'
  actualSdk?: string | null;    // null when the dApp reported no sdkVersion
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

**Enforced in CI:** `tests/unit/connect/protocol-surface.test.ts` snapshots the full wire surface (intents, scopes, methods, **events, error codes**) + `SPHERE_CONNECT_VERSION`. Any change to the surface fails that test until you bump the version and update its snapshot — so the bump can't be forgotten.

**One exception:** an error code the **host never sends** is client-local — it bumps the npm MINOR, not the protocol MINOR. The wire surface did not change, so no dApp can observe it from the wallet.

**Also enforced:** `npm run verify:version` (a CI step that runs **before** the build) pins `connect/version.ts` to `package.json`. It has to run before the build because `prebuild` regenerates that file, so any check placed after would inspect the repaired copy and never catch a committed-stale `SDK_VERSION` — which makes every handshake advertise the wrong `sdkVersion` and any wallet with a `minSdkVersion` floor answer `UNSUPPORTED_PROTOCOL_VERSION` (4007).

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
