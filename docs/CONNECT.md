# Sphere Connect — Developer Guide

Sphere Connect is a secure wallet-dApp communication protocol. It allows web applications (dApps) to request wallet operations from a Sphere wallet — reading balances, sending tokens, signing messages — without exposing private keys.

## Install & entry points

```bash
npm install @unicitylabs/sphere-sdk
```

A dApp imports **only** the Connect subpaths. They are small, self-contained bundles — no
state-transition-sdk, no nostr, no `@noble`, no `bip39`, no `buffer` — so an `autoConnect`-only dApp
ships a few KB, not the wallet SDK:

| Subpath | What it gives you | Where it runs |
|---------|-------------------|---------------|
| `@unicitylabs/sphere-sdk/connect` | `ConnectClient`, `ConnectError`, `ERROR_CODES`, `SPHERE_NETWORKS`, `RPC_METHODS`, `INTENT_ACTIONS`, `PERMISSION_SCOPES`, the NFT wire helpers, and `ConnectHost` for wallets | anywhere (browser, Node, a backend service) |
| `@unicitylabs/sphere-sdk/connect/browser` | `autoConnect`, `PostMessageTransport`, the `isInIframe`/`hasExtension`/`detectTransport` helpers, and the legacy `ExtensionTransport` | browser only |
| `@unicitylabs/sphere-sdk/connect/nodejs` | `WebSocketTransport` (the `createServer`/`createClient` factory object), `WebSocketServerTransport`, `WebSocketClientTransport`, and the `WebSocketServerConfig` / `WebSocketClientConfig` types | Node.js only |

**External dependencies, precisely.** `./connect` and `./connect/browser` import nothing outside the
package: their built files contain no bare specifier at all, so a dApp that uses only those two
pulls in no third-party code through the SDK. `./connect/nodejs` is the one exception —
`WebSocketServerTransport.start()` runs `await import('ws')`, so the **server** side of that entry
does need `ws` at runtime. It is declared as an **optional peer dependency** (`ws >= 8.0.0`), the
import is dynamic and only reached when you start a server, and the build leaves `ws` external
rather than bundling it, so nothing is inlined into your output. Install `ws` yourself if you host a
WebSocket Connect endpoint. The client side never needs it: `WebSocketClientTransport` takes the
`createWebSocket` factory you supply.

Do **not** import the package root (`@unicitylabs/sphere-sdk`) from a dApp: that is the wallet-side
SDK and pulls in the whole token engine.

### TypeScript setup

Resolve these subpaths through the package's `exports` map — set
`"moduleResolution": "bundler"` (Vite, webpack, Rollup, esbuild) or `"node16"`/`"nodenext"` with a
matching `"module"`, and set a `"target"` of ES2017 or later. The samples in this guide use
top-level `await`, and without a `target` TypeScript falls back to ES5 and rejects it (TS1378):

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true
  }
}
```

**CommonJS projects.** Under `"node16"`/`"nodenext"` in a package without `"type": "module"`,
TypeScript reads the `require` declarations (`.d.cts`), and there `./connect` and `./connect/browser`
each declare their own `ConnectClient` and `ConnectError`. The client that `autoConnect()` returns is
then not assignable to the `ConnectClient` type imported from `@unicitylabs/sphere-sdk/connect`
(TS2322, "Types have separate declarations of a private property"). Build the dApp as ESM
(`"type": "module"`) or use `"moduleResolution": "bundler"`; there both entries share one declaration.

Do **not** hand-write tsconfig `paths` entries pointing at files inside the package's `dist/`
folder. Those paths bypass `exports`, they are not part of the published contract, and a
declaration file reached that way can bind to a sibling `.js` and silently degrade to `any`. If an
older `"moduleResolution": "node"` setup cannot see the subpaths, upgrade the resolution mode
rather than mapping into `dist/`.

## Protocol Version

The current Connect protocol version is **`2.3`** (`SPHERE_CONNECT_VERSION = '2.3'`).

- **2.3** adds the `mint_nft` intent and its `nft:mint` scope — see [mint_nft Intent](#mint_nft-intent).
- **2.2** added the `send_nft` intent and its `nft:transfer` scope.

Both are additive MINOR bumps. The handshake gate compares MAJOR only, so a 2.1 or 2.2 dApp still
connects to a 2.3 wallet. An SDK host older than 2.3 answers `mint_nft` with `PERMISSION_DENIED`
(4002), because no scope maps to it there; read `client.walletProtocol` to tell that apart from a
refused scope.

> **sphere-sdk 0.15.0 does NOT bump it.** That release is a hard wire break on the
> *state-transition* protocol, but Connect messages carry no state-transition bytes — the token
> blob never crosses this wire (`sphere_getTokens` strips `sdkData`, as it always has). Method
> list, params, result shapes, events, scopes and error codes are byte-identical to 0.14.x, and
> the `minSdkVersion` floor stays `0.14.1-0`. What changed is wallet-host-side: see
> [ConnectHost: the `SphereInstance` contract](#connecthost-the-sphereinstance-contract).

### Compatibility policy

- **Same MAJOR = compatible.** A dApp on 2.0 and a wallet on 2.1 connect fine — MINOR versions within the same MAJOR interoperate.
- **Different MAJOR = rejected.** A v1-era dApp (protocol `'1.0'`) that attempts to handshake with a v2 wallet is rejected with `UNSUPPORTED_PROTOCOL_VERSION` (4007). That peer must update its SDK.
- The **v1 → v2** cut is a one-time hard break: v1 peers are genuinely incompatible and must upgrade.

### Handshake fields

> **SDK version floor (0.14.1, the P11 flip):** the host rejects any client whose handshake
> `sdkVersion` is missing or below `0.14.1-0` (every 0.14.1 prerelease passes) with
> `UNSUPPORTED_PROTOCOL_VERSION` (4007) and a message naming the required minimum — pre-flip
> clients expect a wallet surface that no longer exists. Override via
> `ConnectHostConfig.minSdkVersion`, which replaces this floor rather than adding to it, so a lower
> value admits pre-flip clients again. The claim is compatibility hygiene, not security.

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
import { ConnectClient, SPHERE_NETWORKS } from '@unicitylabs/sphere-sdk/connect';
import { autoConnect } from '@unicitylabs/sphere-sdk/connect/browser';

// With ConnectClient (transport and dapp as in "Setting up ConnectClient" below):
const client = new ConnectClient({ transport, dapp, network: SPHERE_NETWORKS.testnet2 });

// With autoConnect:
const result = await autoConnect({ dapp, network: SPHERE_NETWORKS.testnet2 });
```

`SPHERE_NETWORKS` is also importable by backend services from `@unicitylabs/sphere-sdk/connect` — this entry point has no browser-only deps, so it is safe to use in Node.js and `sphere-api` without pulling in DOM APIs.

The registry exposes two entries: `SPHERE_NETWORKS.mainnet` = `{ id: 1, name: 'mainnet' }` and `SPHERE_NETWORKS.testnet2` = `{ id: 4, name: 'testnet2' }`. A dApp must declare the one it targets — the handshake gate compares network ids numerically and is fail-closed, so a testnet2 dApp is refused by a mainnet wallet and vice versa (`INCOMPATIBLE_NETWORK`). Note that adding an entry only helps dApps that re-pin the SDK; one on an older version must declare `{ id: 1 }` by hand. Richer descriptor fields (`gatewayUrl`, `symbol`, `explorer`, `icon`) and runtime switch/add-network are deferred to a future multi-network effort. The legacy `testnet` alias is intentionally absent from `SPHERE_NETWORKS`.

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
dApp (browser or Node.js)         Wallet (Sphere)
─────────────────                 ──────────────────────────
ConnectClient                ↔    ConnectHost
     │                                  │
     └── ConnectTransport ──────────────┘
```

- **ConnectHost** — runs inside the wallet. Bridges `ConnectTransport` to a `Sphere` instance.
- **ConnectClient** — runs inside the dApp. Sends requests and receives responses.
- **ConnectTransport** — the communication channel: PostMessage (browser), WebSocket (Node.js), or the legacy Extension relay.

---

## Transports

### PostMessageTransport (browser)
Used when the dApp and wallet communicate via `window.postMessage`.

```typescript
import { PostMessageTransport } from '@unicitylabs/sphere-sdk/connect/browser';

// --- dApp side (client) ---

// dApp inside an iframe — talk to the parent window (the default target)
const transport = PostMessageTransport.forClient();

// dApp opens the wallet in a popup — see "dApp side, popup" below

// --- Wallet side (host) ---
// forHost(target, options) — BOTH arguments are required.
// iframe mode: target = the iframe element (or its contentWindow)
const transport = PostMessageTransport.forHost(iframeEl, { allowedOrigins: [dappOrigin] });
// popup mode: target = window.opener
const transport = PostMessageTransport.forHost(window.opener, { allowedOrigins: [dappOrigin] });
```

`allowedOrigins` is the host's inbound filter; its first entry is also the `targetOrigin` the host
posts to. `['*']` is development only.

**dApp side, popup (P3).** `autoConnect` does all of this for you (see
[autoConnect](#autoconnect-recommended-for-browser-dapps)); by hand it takes three steps. Open
`<wallet>/connect?origin=<your origin>`: the Sphere wallet's popup page refuses to start without
`origin` ("Missing origin parameter") and uses it as its `allowedOrigins`. Check that the popup
opened, because `window.open()` returns `null` when it is blocked. Then wait for the wallet's
`HOST_READY` message before the handshake: `connect()` sends its handshake once, and one that
arrives before the popup's host listens is lost, so `connect()` fails with "Connection timeout".
See also the note on the hosted wallet below.

```typescript
import { PostMessageTransport } from '@unicitylabs/sphere-sdk/connect/browser';
import { HOST_READY_TYPE } from '@unicitylabs/sphere-sdk/connect';

const WALLET_URL = 'https://sphere.unicity.network';
const popup = window.open(
  `${WALLET_URL}/connect?origin=${encodeURIComponent(location.origin)}`,
  'sphere-wallet',
  'width=420,height=720',
);
if (!popup) throw new Error('The wallet popup was blocked');

// Wait for HOST_READY (autoConnect gives up after HOST_READY_TIMEOUT, 30 s).
await new Promise<void>((resolve) => {
  window.addEventListener('message', function onReady(event: MessageEvent) {
    if (event.source === popup && event.data?.type === HOST_READY_TYPE) {
      window.removeEventListener('message', onReady);
      resolve();
    }
  });
});

const popupTransport = PostMessageTransport.forClient({ target: popup, targetOrigin: WALLET_URL });
```

### ExtensionTransport (legacy — no supported wallet)

> **Legacy.** The Sphere browser extension is discontinued: **no supported wallet answers this
> transport today.** `ExtensionTransport` still ships so existing builds keep compiling, and
> `autoConnect` still detects the extension (P2) if something injects `window.sphere`, but do not
> build a new integration on it. Use the hosted wallet (iframe / custom agent) or, for Node.js,
> `WebSocketTransport`.

The dApp communicated through the extension's content script relay:

```typescript
import { ExtensionTransport } from '@unicitylabs/sphere-sdk/connect/browser';

// dApp side — sends via window.postMessage with the sphere-connect-ext namespace
const transport = ExtensionTransport.forClient();

// Extension background — receives via chrome.runtime.onMessage
const transport = ExtensionTransport.forHost({
  onMessage: chrome.runtime.onMessage,
  tabs: chrome.tabs,
});
```

### WebSocketTransport (Node.js)
Used for server-side or CLI dApps. The factory methods are `createServer` / `createClient` — there
is no `forHost` / `forClient` here — and each returns a transport you must open yourself.

```typescript
import { WebSocketTransport } from '@unicitylabs/sphere-sdk/connect/nodejs';
import type { WebSocketClientConfig } from '@unicitylabs/sphere-sdk/connect/nodejs';
import WebSocket from 'ws';   // `ws` is an OPTIONAL peer dependency

// Wallet side: listen. `start()` imports `ws` dynamically — install it or this throws.
const server = WebSocketTransport.createServer({ port: 3000, host: '127.0.0.1' });
await server.start();

// dApp side: connect. `createWebSocket` is REQUIRED — the SDK never imports a
// WebSocket implementation for you on the client path.
const client = WebSocketTransport.createClient({
  url: 'ws://localhost:3000',
  // A `ws` socket works at runtime, but its event types are narrower than the SDK's
  // internal socket interface, so TypeScript needs this cast.
  createWebSocket: (url) => new WebSocket(url) as unknown as ReturnType<WebSocketClientConfig['createWebSocket']>,
  autoReconnect: false,          // default: true
});
await client.connect();
```

**Security of the WebSocket host.** `WebSocketServerTransport` binds `0.0.0.0` unless you pass
`host`, so pass `'127.0.0.1'` as above. Loopback keeps other machines out, not other programs on
this one: the server does not look at the upgrade request (there is no `Origin` check), so nothing
in the SDK tells your dApp apart from any other local process, or from a browser page, that connects
to the port. It serves one socket at a time, and the session is **not tied to that socket**: when
the approved client's socket closes without `sphere_disconnect`, the host keeps the session, and
the next socket to connect is served under it with no handshake, because queries and intents carry
no session id. The transport tells the host nothing when a socket closes. So on this transport
never approve silently or from a stored approval (there is no verified origin to key one on), keep
`sessionTtlMs` short, and use it only between processes you trust.

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

// dappOrigin: the origin your transport verifies — the one you passed to
// PostMessageTransport.forHost(target, { allowedOrigins: [dappOrigin] }). Key every stored
// approval by it, never by dapp.url, which the dApp fills in itself.
const host = new ConnectHost({
  sphere,        // Sphere SDK instance — pass null when initialWalletState is 'locked'
  transport,     // any ConnectTransport
  origin: dappOrigin, // optional: the dApp origin this host serves, for the wallet's own badge
                      // and logs (NEVER session.dapp.url, which is dApp-CLAIMED metadata)
  initialWalletState: 'locked',  // optional — pass when the wallet is already locked at
                                 // construction (cold start with an encrypted wallet)

  // Called when a new dApp requests connection.
  // silent=true means: reject immediately if not already approved — do NOT open any UI.
  // clientInfo carries { protocolVersion, network?, sdkVersion? } from the handshake.
  onConnectionRequest: async (dapp, requestedPermissions, silent, clientInfo) => {
    // Your approval storage, keyed by the verified origin (a WebSocket host has none:
    // see "Security of the WebSocket host").
    const saved = loadApproval(dappOrigin);
    if (saved) return { approved: true, grantedPermissions: saved };
    if (silent) return { approved: false, grantedPermissions: [] };
    // Show approval UI to user
    const approved = await showApprovalUI(dapp, requestedPermissions);
    if (approved) saveApproval(dappOrigin, requestedPermissions);
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

  // Called when a dApp explicitly disconnects — drop its stored approval, under the same
  // verified origin (session.dapp.url is dApp-claimed)
  onDisconnect: async () => {
    removeApproval(dappOrigin);
  },

  // Notify-only: called when the compatibility gate rejects a connection.
  // Use this to surface the rejection reason in the wallet UI.
  // Does NOT affect the gate decision — the host already rejected when this fires.
  // `silent` is true for auto-connect attempts: avoid showing UI for those.
  onConnectionRejected: (dapp, error, silent) => {
    if (!silent) showRejectionBanner(dapp?.name, error.message);
  },

  // Notify-only: the host has ALREADY answered a query or intent with WALLET_LOCKED (4009),
  // or accepted a session resume while locked. It is not called for a refused handshake.
  // It never waits for you, and a throw here cannot break it.
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
  handshakeDeadlineMs: 120000,  // onConnectionRequest — expiry sends the empty refusal.
                                // The dApp's own ConnectClient `timeout` (30 s default)
                                // also bounds connect(): see "Setting up ConnectClient".

  // Optional floors. minSdkVersion REPLACES the default npm-SDK floor ('0.14.1-0',
  // DEFAULT_MIN_CLIENT_SDK_VERSION) instead of adding to it, so never set it lower.
  minSdkVersion: '0.14.1-0',  // reject dApps whose npm SDK version is older
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

// Destroy the host. It does not own the transport: destroy that yourself.
host.destroy();
transport.destroy();
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

One related case does reach a dApp. A **messaging-only** `Sphere` (`walletApi: 'none'`, 0.17.3 and
later) has no payments at all: `sphere.hasPayments` is `false`, and its `payments` getter throws
`PAYMENTS_NOT_COMPOSED` for the life of the instance, not the transient `NOT_INITIALIZED`. A host
bound to one answers every money query (`sphere_getBalance`, `getAssets`, `getFiatBalance`,
`getTokens`, `getHistory`) with `INTERNAL_ERROR` (-32603) and `data.reason: 'PAYMENTS_NOT_COMPOSED'`,
and retrying does not help. Subscribing to a payment event succeeds, but the event never fires,
because nothing composes the payments module that would emit it. `sphere_getIdentity` still answers.

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
  const host = hostRef.current;
  if (!host) return;
  if (sphere) {
    host.updateSphere(sphere);                     // unlock, or a live address switch
  } else if (!isLoading) {
    if (isLocked) host.setLocked();                // a LOCK — the dApp stays connected
    else host.setUnavailable();                    // any other loss of Sphere — revokes
  }
}, [sphere, isLoading, isLocked]);
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
origin holding no approval. Treat it as "not ready yet" rather than a permanent rejection, and
connect again when the wallet posts `HOST_READY`. The Sphere wallet posts it when a human unlocks a
host that holds no session. `HOST_READY` is a plain `{ type: HOST_READY_TYPE }` window message,
outside the Connect namespace, so it never reaches a `ConnectClient`, and `autoConnect` does not
listen for it in iframe mode (P1): listen yourself.

```typescript
import { HOST_READY_TYPE } from '@unicitylabs/sphere-sdk/connect';

// Iframe mode (P1): connect again whenever the wallet announces a ready host.
window.addEventListener('message', (event: MessageEvent) => {
  if (event.source === window.parent && event.data?.type === HOST_READY_TYPE) void tryConnect();
});
```

The Sphere wallet's custom-agent host also posts `HOST_READY` every time the dApp's frame loads,
locked or not, so a retry can be refused again: keep the listener until you are connected. In popup
mode (P3) `autoConnect` itself waits for `HOST_READY` before its handshake, and the Sphere wallet's
popup does not post it while locked, so the user has `HOST_READY_TIMEOUT` (30 s) to unlock before
`autoConnect` rejects with "autoConnect: Wallet popup did not respond in time".

On the way back, `updateSphere()` compares the new Sphere's `chainPubkey` against the one frozen
at lock time. A mismatch — "Forgot password → restore from recovery phrase" installs a different
seed behind an origin-keyed approval — **revokes** instead of unlocking. A different network id
revokes as well, and so does a session that expired while the wallet was locked. On a live wallet,
an `updateSphere()` with a Sphere on a different network also revokes instead of rebinding; an
address switch on the same network keeps the session.

### onLockedRequest — a badge, never a password field

`ConnectHostConfig.onLockedRequest` is notify-only: the host has **already** answered a query or
intent with 4009, or accepted a session resume while locked, and never waits for the wallet. It is
not called for a handshake the host refuses. A throw from it cannot break the host.

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
});
// Not `silent: true` here: a silent connect is refused, without any UI, for an origin the
// wallet has not approved yet, so a first-time user could never connect. See
// "Auto-reconnect on page reload" for the silent attempt.

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
| P1 | Iframe | `isInIframe()` | `PostMessageTransport` to parent — **the live path**, see below |
| P2 | Extension | `hasExtension()` | `ExtensionTransport` via content script — **legacy, no supported wallet** |
| P3 | Popup | fallback | `PostMessageTransport` to popup window — see the hosted-wallet note below |

You can force a specific transport:
```typescript
await autoConnect({ dapp, walletUrl, network: SPHERE_NETWORKS.testnet2, forceTransport: 'iframe' });
```

### Running against the hosted wallet

The way a dApp runs against the hosted wallet at `https://sphere.unicity.network` is as a **custom
agent**, which the wallet loads in an iframe — so `autoConnect` takes P1 and no popup is involved:

```
https://sphere.unicity.network/agents/custom?url=<your dApp URL>
```

**Your dApp must be served over `https`, from a host that is reachable from the public internet.**
Two independent gates enforce that, and a local dev URL fails both:

1. **The CDN in front of the hosted wallet rejects local URLs in the query string.** Any request to
   `sphere.unicity.network` whose query string contains `localhost` or `127.0.0.1` answers **403**,
   served by CloudFront (`ERROR: The request could not be satisfied`), before the wallet's own code
   runs. Measured with `curl` on 2026-09-17 against `/agents/custom?url=…` and `/connect?origin=…`,
   with and without browser-like `User-Agent`/`Accept` headers; `https://localhost:5173` is refused
   exactly like `http://localhost:5173`. It is a CDN rule about local URLs in the query, not
   anything specific to Connect — the same routes answer **200** for a public `https` URL.
2. **The wallet only frames `https`.** It builds a custom tab only when the URL's protocol is
   `https:` — `isHttpsUrl`, a protocol-only check, in `sphere`'s
   `src/components/desktop/DesktopLayout.tsx:80`. A plain `http://` URL never becomes an iframe
   `src`.

So to test a local build against the hosted wallet, put it behind an **https tunnel** — ngrok,
cloudflared or equivalent — and open
`https://sphere.unicity.network/agents/custom?url=<the tunnel's https URL>`. A tunnel URL is public
and `https`, so it passes both gates.

Typing an `https` URL into the wallet's own in-app **Load Custom URL** prompt navigates inside the
page to `/agents/custom?url=…`, so no request reaches the CDN at that moment and gate 1 does not
apply then; reloading or sharing that page does send the URL to the CDN, and a local URL then gets
the 403. Gate 2 still applies: a bare `localhost:5173` typed into the prompt is completed to
`http://localhost:5173` and refused, so type the full `https://` URL. That path has not been tested
end to end here, so treat it as untried rather than as a documented workaround.

A wallet you run yourself has no CDN in front of it, so gate 1 does not apply, but gate 2 is wallet
code: a custom-agent URL must still be `https` there too (for a local dApp, serve it over `https`
with a certificate the browser trusts). The popup route (P3) has no such check.

About the popup route (P3): the route itself is served — `GET https://sphere.unicity.network/connect`
answers **200**, and so does `/connect?origin=<a public https origin>` (curl, 2026-09-17). A 403
there is gate 1 above, triggered by a `localhost` origin in the query string, not the wallet
refusing the route. Whether the popup handshake itself completes end to end against the hosted
wallet has not been tested, which is why the custom-agent iframe path above is the documented one.

Because the dApp runs inside the wallet's iframe, `isInIframe()` is true and
`PostMessageTransport.forClient()` talks to the parent window — no `walletUrl` is needed in that
mode.

That client accepts whichever page is its parent. `forClient()` without a `targetOrigin` posts to
`'*'` and filters inbound messages only by "the sender is `window.parent`", with no origin check,
and `autoConnect` has no option to change that. So any page that frames your dApp can answer its
handshake and act as its wallet. Do not treat an identity or an intent result received over Connect
as proof: verify payments and signatures on your server. If the dApp should run only inside the
hosted wallet, send `Content-Security-Policy: frame-ancestors https://sphere.unicity.network`, or
pin the parent yourself with `new ConnectClient({ transport: PostMessageTransport.forClient({
targetOrigin: 'https://sphere.unicity.network' }), dapp, network })` instead of `autoConnect`.

### Auto-reconnect on page reload

Inside the wallet (iframe mode, P1), a silent connect on page load reconnects without UI if the
origin is already approved:

```typescript
import { autoConnect, isInIframe } from '@unicitylabs/sphere-sdk/connect/browser';
import { SPHERE_NETWORKS } from '@unicitylabs/sphere-sdk/connect';

// On mount, in iframe mode only: try a silent auto-connect
if (isInIframe()) {
  try {
    const result = await autoConnect({
      dapp,
      walletUrl,
      network: SPHERE_NETWORKS.testnet2,   // required at runtime — see below
      silent: true,
    });
    // Connected — origin was already approved
  } catch {
    // Not approved (or the wallet is locked) — show Connect button
  }
}
```

In popup mode (P3) there is no silent reconnect. `autoConnect` always opens the wallet popup first,
and `silent` only suppresses the approval prompt inside it. Browsers generally block `window.open()`
outside a user gesture, and `autoConnect` then throws "autoConnect: Failed to open wallet popup —
check popup blocker settings"; if the popup does open, the user sees a wallet window. Connect in
popup mode from a click handler.

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

  // Resume a session the wallet's host still holds (in practice iframe mode: see Session Resume)
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

// Sign a message (e.g. challenge-response auth).
// `query` and `intent` are generic and default to `unknown`, so name the result shape
// yourself — destructuring an untyped result does not compile under `strict`.
const { signature, publicKey } = await client.intent<{ signature: string; publicKey: string }>(
  'sign_message',
  { message: 'Sign in to My App\n\nNonce: abc123' },
);

// Events — wallet pushes real-time updates
const unsub = client.on('transfer:incoming', (data) => {
  console.log('Incoming transfer:', data);
});

// Disconnect
await client.disconnect();
```

**`timeout` also bounds `connect()`.** `ConnectClientConfig.timeout` (default 30000 ms) limits the
handshake as well as each query, while the host keeps its approval prompt open for up to 120 s
(`handshakeDeadlineMs`). A user who takes longer than `timeout` to approve gets an uncoded
`Error('Connection timeout')` in the dApp, although the wallet goes on to create the session; the
Sphere wallet also stores the approval, so connecting again succeeds without a prompt. For a
non-silent connect, either set `timeout` above the approval window (it then applies to every query
too) or catch the timeout and connect again.

---

## Silent Mode

Silent mode lets a dApp check whether it is already approved by the wallet **without opening any approval UI**. This is used for auto-connect on page load.

```typescript
// On page load: silently check if already approved
const client = new ConnectClient({ transport, dapp, network: SPHERE_NETWORKS.testnet2, silent: true });
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
| `sphere_getHistory` | `limit?` | transaction history: the first page, sized by `limit`, when `limit` is given; otherwise every entry |
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
| `send_nft` | `to, tokenId, memo?` | On the wire since 2.2, with its `nft:transfer` scope — but **the Sphere wallet currently does not implement it** and answers `METHOD_NOT_FOUND` (-32601); `SUPPORTED_INTENTS` in `sphere`'s `src/components/connect/intentValidation.ts` does not list it. That is the wallet's state today, not a protocol statement: feature-detect by trying the intent and treating -32601 as "unsupported". |
| `mint_nft` | `content` (`WireNftContent`), `sign?` (default `true`) | `{ tokenId }` |

> **Amount units:** `amount` is always in **base units** (the smallest indivisible unit), as a
> string — the same convention as the SDK's `payments.mint(coinId, amount: bigint)`
> and `payments.send`. Convert from a human amount at the dApp edge with your own converter, for
> example viem's or ethers' `parseUnits('1.5', decimals)`, and display with `formatUnits`. The
> SDK's `parseTokenAmount` / `formatAmount` are exported only from the package root and `./core`,
> which a dApp should not import (see [Install & entry points](#install--entry-points)); no Connect
> entry exports them. `coinId` is always the canonical lowercase 64-hex id (a symbol like `UCT` is
> rejected).

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
- The Sphere wallet displays the full message text for user review before signing

**What they do not cover:**
- **Signatures are not unique.** The wallet produces low-S signatures, but `verifySignedMessage()`
  does not require low-S: it also accepts the high-S twin of a valid signature (`s' = n − s`, recovery
  bit flipped), which anyone can compute from the original. Never use the signature string as an id
  or a replay key; put a single-use nonce in the message and check it.
- **Nothing binds the signature to the dApp that asked for it.** The wallet signs whatever text the
  dApp sends, and the `Domain:` line in the sample above is text the dApp wrote. The Sphere wallet
  shows it as "Requested by …" without comparing it with the origin the request came from, so a
  connected dApp can ask the user to sign a challenge that another service issued. A server that
  accepts signed sign-ins must check that the signature verifies for the expected public key and that
  the message is exactly a challenge it issued itself (its own domain, a nonce it has not seen before,
  a short expiry). Those checks stop replays; they cannot prove that the user signed on your site, so
  never treat the `Domain:` line as that proof.

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

A mint that fails after the wallet journaled it may still complete: the wallet resumes it. The wallet answers `INTENT_OUTCOME_UNKNOWN` (4201) with `data.tokenId` — do not send the intent again; reconcile against that token id. A mint refused before anything was journaled carries no `data`, and may be sent again.

### mint_nft Intent

The `mint_nft` intent (Connect 2.3) asks the wallet to mint **one NFT to its own active address**
with `payments.mintNft({ content, sign })`. **The wallet asks the user every time and shows what
will be minted — a `mint_nft` is never auto-approved.** `ConnectHost.setIntentAutoApprove` throws
for it, and the host hands every `mint_nft` to `onIntent` even if an auto-approve handler exists.

It requires the `nft:mint` scope. Neither `mint:request` nor `nft:transfer` grants it: a dApp
approved to top up test coins or to move NFTs must not gain the right to put the user's creator
signature on content the dApp chose.

```typescript
import { nftContentToWire } from '@unicitylabs/sphere-sdk/connect';
import type { MintNftIntentParams, MintNftIntentResult } from '@unicitylabs/sphere-sdk/connect';

const params: MintNftIntentParams = {
  content: nftContentToWire({
    kind: 'metadata',
    name: 'Cat #1',
    description: null,
    image: { kind: 'media', media_type: 'image/png', bytes: pngBytes }, // Uint8Array → base64
    animation_url: null,
    external_url: null,
    attributes: [{ trait_type: 'Eyes', value: 'green' }],
    collection: 'Cats',
    collection_id: null,
  }),
  sign: true, // the default: NftSigned, with the wallet's chain key as creator
};

const { tokenId } = await client.intent<MintNftIntentResult>('mint_nft', params);
```

**Params.** `content` is a `WireNftContent`: an `NftContent` ([NFT-METADATA.md](NFT-METADATA.md))
with every inline `NftMedia.bytes` replaced by standard base64 (RFC 4648 §4, with padding), because
Connect messages are JSON and JSON cannot carry a `Uint8Array`. An `NftLink` is
unchanged. `nftContentToWire` builds it.

| `kind` | Fields besides `kind` — all required |
|--------|--------------------------------------|
| `metadata` | `name`, `description`, `image`, `animation_url`, `external_url`, `attributes`, `collection`, `collection_id`. An absent optional field is `null`, never omitted. `image` and `animation_url` each hold a `media`, a `link` or `null`; `attributes` is `[{ trait_type, value }]`, `[]` when there are none; `collection_id` is a hex string, passed through unchanged. |
| `media` | `media_type`, `bytes` (base64) |
| `link` | `media_type`, `uri`, `sha256` (64 hex) |

**Wallet side.** `nftContentFromWire(params.content)` checks the shape — exactly these fields with
these JSON types, no nested `metadata`, canonical base64 — and throws a `VALIDATION_ERROR` whose
message names the offending field (`Invalid NFT content.image.bytes: …`). It does not judge field
values: non-empty text, media-type grammar, URI schemes, the `collection_id` hex rule, a document
link in a media slot and the size cap stay in `payments.mintNft`, whose refusal the wallet returns
as the intent error.

**Result.** `{ tokenId }` — 64 lowercase hex.

**Errors.**

| When | Answer |
|------|--------|
| The session lacks `nft:mint` | `PERMISSION_DENIED` (4002), from the host |
| The user declines | `USER_REJECTED` (4003) |
| Malformed params (shape, base64) | `INVALID_PARAMS` (-32602), from the wallet — the Sphere wallet checks them up front and its message names the offending field |
| Content that is certainly over the size cap | `INVALID_PARAMS` (-32602), from the Sphere wallet, before any UI: it estimates the size from the params as they arrive. Content that passes this estimate but is still too large is refused by `payments.mintNft`, as in the next row. |
| The mint is refused before anything is journaled | An intent error carrying `MintResult.error`, with no `data`; the Sphere wallet sends it as `INTERNAL_ERROR` (-32603). Nothing was minted; the intent may be sent again. |
| The Sphere wallet runs with subscriptions enabled and its subscription key has not reached the oracle yet | `INTERNAL_ERROR` (-32603), `Subscription is still being set up — try again in a moment`, before anything is minted. Transient: retry, as for `mint`. |
| The mint fails after it was journaled | `INTENT_OUTCOME_UNKNOWN` (4201) with `data.tokenId`. The wallet resumes the mint, so it **may still complete**: do not send the intent again; reconcile against the token id. |
| The wallet cannot tell whether the mint started | `INTENT_OUTCOME_UNKNOWN` (4201), without `data` |
| The host stops waiting (its deadline, a lock, a revoked session) | `INTENT_OUTCOME_UNKNOWN` (4201), from the host. The wallet dismisses its dialog and starts nothing more for the intent, but a mint already under way may still complete: do not send the intent again. |

`onIntent` may return `error.data`; the host relays it as `ConnectError.data` under the code the
wallet chose, `INTENT_OUTCOME_UNKNOWN` included. It drops `data` only when it downgrades a channel
code (`WALLET_LOCKED`, `NOT_CONNECTED`) to `INTENT_OUTCOME_UNKNOWN` itself.

**Size.** The encoded payload, `NftSigned` wrapper included, must be at most 1 MiB
(`NFT_MAX_PAYLOAD_BYTES`); `payments.mintNft` refuses a larger one before anything is minted. Keep
inline media at or below about 900 KB, and link larger files with `NftLink`.

## Removed: the invoice surface (P11 flip)

The experimental invoice surface — 2 queries (`sphere_getInvoices`, `sphere_getInvoiceStatus`),
9 intents (`create_invoice` … `set_auto_return`) and 2 scopes (`invoice:read`, `invoice:write`)
— was **removed from the protocol** when the SDK's accounting module was deleted. It was never
enabled in any wallet host (every call answered `MODULE_NOT_AVAILABLE`), and the removal did not
bump the protocol version (2.1 at the time). Passing a removed scope in
`ConnectClientConfig.permissions` is a type error (`PermissionScope` no longer has it). At runtime
nothing rejects it: the SDK host does not validate requested scopes, it hands them to
`onConnectionRequest` as received, and a granted unknown scope maps to no method or intent.
`validatePermissions()` is exported for wallets that want to filter requested scopes themselves.

A removed — or simply unknown — method or intent answers **`PERMISSION_DENIED` (4002)**, not
`METHOD_NOT_FOUND`: `hasMethodPermission()` / `hasIntentPermission()` return false for anything
unmapped, and that check is what refuses the request. On a **locked** wallet the lock gate runs
first, so the same request answers `WALLET_LOCKED` (4009) until `wallet:unlocked` — deliberately,
so a dApp is not told its permissions are wrong for something it may simply have to retry.
`METHOD_NOT_FOUND` (-32601) comes from the *wallet*, not from the SDK host. The Sphere wallet
currently answers any intent outside its supported set with it — `send_nft` today — per
`SUPPORTED_INTENTS` in `sphere`'s `src/components/connect/intentValidation.ts`; another wallet may
answer differently.

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

> The four wallet events are pushed unconditionally, and the 2.1+ client never sends
> `sphere_subscribe` for them. A `sphere_subscribe` for one of them (an older dApp sends it) is
> answered with **success**, `{ subscribed: true, event }`, without attaching anything to
> `Sphere.on()`, which accepts any string and would never emit these names. The host answers success
> rather than an error on purpose: an error broke every dApp built before 2.1, whose
> `client.on('wallet:locked', …)` sends that subscribe.

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

> There is no dedicated expiry event and no expiry timer: the first request after the TTL is
> answered `4004 SESSION_EXPIRED`, and the host then revokes the session and pushes
> `wallet:disconnected`.

### Wallet Lock Handling

**A lock is not a disconnect.** `wallet:locked` means the wallet is locked and the session is
**still alive**: stay connected, keep your `sessionId`, do not re-handshake. Requests answer
`WALLET_LOCKED` (4009) until `wallet:unlocked` arrives on the same session. This is identical in
every transport mode — the old popup-vs-iframe split is gone.

```typescript
client.on('wallet:locked', () => {
  setWalletLocked(true);           // render "wallet locked — unlock to continue"
});                                // do NOT disconnect, do NOT clear the session

// `ConnectEventHandler` receives `unknown`: type the payload at the handler boundary.
client.on('wallet:unlocked', (data) => {
  const { identity } = data as { identity?: PublicIdentity };
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

**Important:** discriminate on the numeric `.code`, not `instanceof ConnectError`. `instanceof` is false whenever the error was built by a different copy of the class. In 0.17.3 and earlier, `@unicitylabs/sphere-sdk/connect/browser` shipped its own copy of `ConnectClient`, so errors from `autoConnect()` were never `instanceof` the `ConnectError` exported by `@unicitylabs/sphere-sdk/connect`. From the first release after 0.17.3 the ESM Connect entry points share one copy; the `.cjs` entries still carry one each, and a process that loads the SDK through both `import` and `require()`, or a dApp whose dependencies bundle their own SDK, still holds two.

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
| 4001 | `ERROR_CODES.NOT_CONNECTED` | No live session: `connect()` has not succeeded, or the session was revoked (`sphere_disconnect`, a logout, expiry, `setUnavailable()`). A query in flight when the session is revoked gets it too. The client also raises it locally, as "Not connected" or "Disconnected". |
| 4002 | `ERROR_CODES.PERMISSION_DENIED` | Method or intent not in granted permissions. |
| 4003 | `ERROR_CODES.USER_REJECTED` | User rejected an intent in the wallet UI. |
| 4004 | `ERROR_CODES.SESSION_EXPIRED` | Session TTL elapsed. |
| 4005 | `ERROR_CODES.ORIGIN_BLOCKED` | **Reserved.** Defined on the wire; no sphere-sdk path emits it, and the Sphere wallet currently does not emit it either. |
| 4006 | `ERROR_CODES.RATE_LIMITED` | Too many requests per second. |
| 4100 | `ERROR_CODES.INSUFFICIENT_BALANCE` | **Reserved.** No sphere-sdk path emits it; the Sphere wallet currently answers a refused send with `TRANSFER_FAILED` (4102) instead. |
| 4101 | `ERROR_CODES.INVALID_RECIPIENT` | **Reserved.** No sphere-sdk path emits it; the Sphere wallet currently answers an unresolvable recipient with `TRANSFER_FAILED` (4102) as well. |
| 4102 | `ERROR_CODES.TRANSFER_FAILED` | Transfer execution failed — what the Sphere wallet currently sends when it rejects a send. |
| -32601 | `ERROR_CODES.METHOD_NOT_FOUND` | Comes from the **wallet**, never from the SDK host (there an unmapped name is 4002). The Sphere wallet currently answers every intent outside its supported set, `send_nft` included, with it. |
| -32602 | `ERROR_CODES.INVALID_PARAMS` | Also the wallet's. The Sphere wallet currently validates intent params up front and rejects a malformed one with it, before showing any UI. |
| -32603 | `ERROR_CODES.INTERNAL_ERROR` | The host caught an error it cannot attribute: a router throw (a `SphereError`'s code rides in `data.reason`, e.g. `'PAYMENTS_NOT_COMPOSED'` from a messaging-only wallet), a query that outlived the host deadline, or an intent handler that threw. A wallet that destroys its Sphere without calling `setLocked()` / `setUnavailable()` first also produces it. |
| 4200 | `ERROR_CODES.INTENT_CANCELLED` | Intent cancelled — the user declined and **nothing happened**. Safe to re-offer. |
| 4201 | `ERROR_CODES.INTENT_OUTCOME_UNKNOWN` | The intent reached the wallet and its outcome is unknown: the answer was lost (a host deadline, a lock, a logout), or the wallet cannot tell whether the operation will still complete (a mint journaled before it failed carries `data.tokenId`). **The money or token may or may not have moved. Do NOT retry**; reconcile out of band first. |

> **Where each row comes from.** Nine codes are emitted by the SDK host itself — 4001, 4002, 4004,
> 4006, 4007, 4008, 4009, -32603 and 4201 (the only `ERROR_CODES.*` members referenced under
> `connect/`). Those are properties of this repo and hold for any wallet built on it. Everything
> else in the table is the *wallet's* to send: 4003 and 4200 come from the wallet's own rejection,
> relayed by the host, and the rows written "the Sphere wallet currently …" describe the Sphere
> wallet as it stands today — `sphere`, `src/components/connect/intentValidation.ts`,
> `ConnectIntentHandler.tsx` and `ConnectProvider.tsx`, read at commit `762d350d` — not protocol
> guarantees. Every one of these codes is defined on the wire, so another wallet may legitimately
> use a "reserved" code and the Sphere wallet may start emitting one. Discriminate on `.code`, and
> handle the codes you depend on defensively rather than treating this column as fixed.

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
| `nft:transfer` | `send_nft` intent (move one NFT) |
| `nft:mint` | `mint_nft` intent (mint one NFT to the wallet, signed as the user by default). Not implied by `mint:request` or `nft:transfer` |

---

## Session Resume

A dApp can save its `sessionId` and present it again as `resumeSessionId` after a reload. The host
keeps its session in memory only, so a resume works only while the same wallet page, and its
`ConnectHost`, is still alive:

- **Iframe (P1): resume works.** The Sphere wallet's custom-agent host is not torn down when the
  dApp inside it reloads, so the reloaded dApp resumes its session without any prompt.
- **Popup (P3): resume cannot work.** `autoConnect` opens `<walletUrl>/connect` again on every call,
  which loads a fresh wallet page with a new host and no session, and the Sphere wallet's popup page
  also revokes its session when it unloads. What skips the approval prompt there is the wallet's own
  stored approval for your origin, not the `sessionId`.

A `sessionId` the host does not hold is not an error: the host treats the handshake as a new
connection and calls `onConnectionRequest` (with the Sphere wallet, an approved origin connects
without a prompt). (The legacy extension mode did not need any of this — its background service
worker kept the session alive — but no supported wallet serves that transport any more.)

### Full lifecycle (iframe mode)

**1. Save session after successful connect:**

```typescript
const SESSION_KEY = 'sphere-session';

const result = await autoConnect({ dapp, walletUrl, permissions, network: SPHERE_NETWORKS.testnet2 });
sessionStorage.setItem(SESSION_KEY, result.connection.sessionId);
```

**2. Resume on page refresh:**

Read the saved sessionId and pass it as `resumeSessionId`. If the host no longer holds that session, the handshake simply runs as a new connection; if `autoConnect` rejects (the user declined, or the wallet is locked), clear the saved id and show your Connect button:

```typescript
const savedSession = sessionStorage.getItem(SESSION_KEY);

try {
  const result = await autoConnect({
    dapp,
    walletUrl,
    permissions,
    network: SPHERE_NETWORKS.testnet2,
    resumeSessionId: savedSession ?? undefined,
  });
  sessionStorage.setItem(SESSION_KEY, result.connection.sessionId);
} catch {
  sessionStorage.removeItem(SESSION_KEY);
  // Show Connect button — no automatic connection this time
}
```

**3. Clear on disconnect:**

```typescript
await result.disconnect();
sessionStorage.removeItem(SESSION_KEY);
```

**4. `willAutoConnect` check:**

To prevent a flash of the Connect button before auto-connect completes, check before rendering whether an automatic connect will run. Resume and silent reconnects happen only in iframe mode, so:

```typescript
const willAutoConnect = isInIframe();   // synchronous
```

Use this to show a loading state instead of the Connect button while auto-connect is in progress.

### Low-level ConnectClient usage

If you are using `ConnectClient` directly instead of `autoConnect`:

```typescript
const client = new ConnectClient({
  transport,
  dapp,
  network: SPHERE_NETWORKS.testnet2,   // required at runtime, resume or not
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

For the v1 → v2 migration specifically: the wallet already requires v2; dApps must declare `network` in their `ConnectClientConfig` and run an SDK at or above the host's npm floor, **`0.14.1`** (`DEFAULT_MIN_CLIENT_SDK_VERSION = '0.14.1-0'`, so every `0.14.1` prerelease passes). Anything below it is refused with `UNSUPPORTED_PROTOCOL_VERSION` (4007) before any UI appears.

**Downstream follow-ups for v2 (both done):**
- `sphere-sdk-connect-example` declares `ConnectClientConfig.network` (`SPHERE_NETWORKS.testnet2`) in its example clients.
- `sphere` (wallet) wires `onConnectionRejected` in both of its Connect hosts, the popup page and the custom-agent iframe.

---

## Deferred: Runtime Network Switching

There is no `switch_network` intent, no `network:changed` event, and no `switchNetwork()` method. A network mismatch at handshake time is rejected with `INCOMPATIBLE_NETWORK` (4008).

**Both networks are live**: `SPHERE_NETWORKS.mainnet` (id 1) and `SPHERE_NETWORKS.testnet2` (id 4). Which one a wallet or dApp runs on is chosen when it starts, so a Connect session is bound to the network declared in its handshake — there is no in-session switch on either side. A dApp that wants to follow the user across networks must tear the session down and connect again against the other network. Runtime switching over the wire is deferred to a future multi-network effort.
