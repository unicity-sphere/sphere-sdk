# Sphere CLI Extraction & DM-Transport Migration Plan
> **Status: HISTORICAL — the extraction shipped; the CLI now lives in `@unicity-sphere/cli` (github.com/unicity-sphere/sphere-cli) and `sphere-sdk/cli/` was removed. Faucet/topup references below predate the v1→v2 cutover — top-up is now a v2 self-mint (payments.mintFungibleToken).**

**Status:** Phase 0 complete (2026-04-21). Phase 1 in progress.
**Target repo:** `github.com/unicity-sphere/sphere-cli` (created 2026-04-21)
**npm scope:** `@unicity-sphere` (claimed 2026-04-21 by `cryptodragon`)
**Stakeholders:** `unicity-sphere/sphere-sdk`, `agentic_hosting`
**Audience:** engineers implementing phases 1–6 below. This plan is deliberately exhaustive; it replaces ad-hoc decisions during the migration and is the artifact to revise if any of those decisions change.

---

## Decisions Log (2026-04-21)

All §6 open questions and all Q-A–Q-F follow-ups are resolved:

| Ref | Question | Resolution |
|---|---|---|
| 6.1 | Config dir migration | **XDG by default** (`~/.config/sphere/`), legacy `./.sphere-cli/` fallback with deprecation warning, drop fallback in v1.0. |
| 6.2 | NIP-17 payload ceiling | **Pagination accepted as the fix** when we hit the limit. Cursor-based pagination on `hm.list` targeted for v0.2. |
| 6.3 | Fresh-subscription latency & sync semantics | **Default = full sync completion before return.** CLI commands wait for aggregator, Nostr relay confirmation, and IPFS sync to complete. `--skip-<subsystem>` flags skip specific waits. `--timeout <ms>` overrides. `--profile <name>` pre-warms a session. Per-command sync matrix produced in phase 3 (see §5 Phase 3 deliverables). |
| 6.4 | Trader direct-controller auth path | **Tenants must be host-agnostic.** `sphere tenant` is a **first-class sibling** of `sphere host` — addresses tenants by their own nametag/pubkey, not by `(host, instance_id)` coordinates. Full state-level tenant mobility (checkpoint/restore between hosts) is a separate future spec; this CLI refactor delivers the *addressing* model that future mobility needs. See §6.9. |
| 6.5 | Daemon migration | Confirmed. `sphere-sdk/cli/daemon.ts` comes along as `sphere daemon {start\|stop\|status}`, surface unchanged except for import paths. |
| 6.6 | Host manager runs as Sphere wallet | Confirmed. Manager gets an nsec at deployment; addressable via `@<nametag>`. Relay outage = controller↔manager outage (same failure mode as tenant↔manager). |
| 6.7 | Pubkey format compatibility | **Normalize to 66-char compressed everywhere.** Add `sphere config show --format=authorized-controllers` helper that emits the exact string operators paste into manager config. |
| 6.8 | Uncommitted changes on `feat/idempotent-spawn-replay-auth` | Assume that branch merges to master **before** phase 3 begins. DM-transport design is forward-compatible either way; content-hash replay guard becomes more valuable under DM where a malicious relay could replay ciphertext. |
| Q-A | npm scope | **`@unicity-sphere/cli`** — scope claimed; `cryptodragon` is owner. |
| Q-B | hmcp-protocol package location | **Stays in agentic-hosting as a workspace** — no separate repo. Publish target `@unicitylabs/hmcp-protocol`. |
| Q-C | Binary name | **`sphere`** (primary), **aliases `scli`, `sphere-cli`**. The new package's `sphere-cli` binary fully replaces the existing `/usr/local/bin/sphere-cli` (which today points at sphere-sdk's CLI). |
| Q-D | Tenant mobility scope | **Minimum scope:** address tenants by their own identity, not by host coordinates; split command tree into `sphere host` (HMCP to manager) and `sphere tenant` (ACP DM — system commands via manager, owner commands direct). Full mobility (state checkpoint/restore) deferred to separate spec. |
| Q-E | Per-command sync matrix | **Required deliverable of phase 3.** Every command gets a documented matrix of which subsystems it waits on (aggregator, Nostr DM, Nostr event relay subscribe, IPFS upload, IPFS fetch, heartbeat roundtrip) by default, which `--skip-*` flags are valid, and what "done" means. |
| Q-F | Command tree split (host vs tenant) | **Confirmed.** See §1.3 for the updated namespace list. |

**Correction to the plan (2026-04-21):** HTTP bridge is **deleted everywhere, with zero fallback** — not even as a hidden test-only transport. Unit and integration tests use in-process Sphere stubs + mock relays; e2e tests use real relays (testcontainers where available). §2.7 and §3.2 updated accordingly.

---

## 0. Scope & problem statement

Today two CLIs live inside two production library repos:

1. `sphere-sdk/cli/` — a 6,150-line monolith (`cli/index.ts` 5,045 lines; `cli/daemon.ts` 686 lines; `cli/daemon-config.ts` 414 lines; `cli/bin.mjs` 17 lines). It is a Sphere wallet swiss-army-knife: `init`, wallet profiles, balance, tokens, assets, DM send/inbox/history, groups, market, invoicing (accounting), swap, nametag, faucet, crypto primitives, daemon. ~100 subcommands via hand-rolled `switch (command)` dispatch.
2. `agentic-hosting/src/cli/` — `ahctl`, a 10-command controller (`spawn`, `list`, `stop`, `start`, `inspect`, `command`, `remove`, `pause`, `resume`, `help`) built on `commander`. It talks to the host manager via a localhost HTTP bridge (`src/cli/transport/http-bridge.ts`, endpoint `POST /hmcp` on port 9400) with a trust-the-`X-Controller-Pubkey`-header auth model. The manager bridge is `src/host-manager/http-bridge.ts`.

**The strategic move:** extract both into a single standalone repo `sphere-cli`, and replace `ahctl`'s HTTP bridge with NIP-17 encrypted Nostr DMs. This gives controller→manager the same cryptographic authentication and transport as the already-working manager↔tenant channel (`src/host-manager/acp-client.ts` ↔ `src/tenant/acp-listener.ts`).

The HTTP bridge must die. It exists only because the CLI was a child process and the manager ran as its parent: the bridge was a convenience, not a design. Its auth model is broken by design (anyone who can reach port 9400 can claim any controller pubkey via header). Over DM, the pubkey is cryptographically bound to the NIP-17 envelope; `AUTHORIZED_CONTROLLERS` enforcement at `src/host-manager/auth.ts:11-22` already assumes this — it's the bridge that weakens it.

---

## 1. Target architecture

### 1.1 New repo layout

```
sphere-cli/
├── README.md                     # install + quickstart
├── LICENSE                       # MIT (match sphere-sdk)
├── CHANGELOG.md
├── package.json                  # @unicity-sphere/cli, bin: "sphere"
├── tsup.config.ts                # ESM + CJS bundle, single entry
├── tsconfig.json
├── eslint.config.js
├── vitest.config.ts
├── .github/
│   └── workflows/
│       ├── ci.yml                # lint, typecheck, test on PR
│       └── release.yml           # tag → npm publish on main
├── bin/
│   └── sphere.mjs                # node shim, ESM entry
├── src/
│   ├── index.ts                  # root command dispatcher (commander)
│   ├── context.ts                # shared CliContext (config, sphere instance, logger)
│   ├── config/
│   │   ├── config.ts             # load/save ~/.sphere-cli/config.json
│   │   ├── profiles.ts           # wallet profile store
│   │   └── schema.ts             # zod/manual schema for on-disk config
│   ├── sphere/
│   │   ├── init.ts               # getSphere() (single shared init)
│   │   ├── identity.ts           # nsec/mnemonic/profile resolution for CLI sessions
│   │   └── transport.ts          # createCliTransport (see §2)
│   ├── commands/
│   │   ├── wallet/               # init, status, list, use, create, delete, current
│   │   ├── balance/              # balance, tokens, assets, asset-info, l1-balance, verify-balance
│   │   ├── payments/             # send, receive, history, sync
│   │   ├── addresses/            # addresses, switch, hide, unhide
│   │   ├── nametag/              # nametag, nametag-info, my-nametag, nametag-sync
│   │   ├── crypto/               # encrypt, decrypt, parse-wallet, wallet-info,
│   │   │                         # generate-key, validate-key, hex-to-wif, derive-*
│   │   ├── util/                 # to-smallest, to-human, format, base58-*
│   │   ├── faucet/               # topup
│   │   ├── dm/                   # dm, dm-inbox, dm-history
│   │   ├── group/                # group-create, group-list, group-my, group-join,
│   │   │                         # group-leave, group-send, group-messages,
│   │   │                         # group-members, group-info
│   │   ├── market/               # market-post, market-search, market-my,
│   │   │                         # market-close, market-feed
│   │   ├── invoice/              # invoice-* (14 commands)
│   │   ├── swap/                 # swap-propose, swap-list, swap-accept, swap-ping,
│   │   │                         # swap-status, swap-deposit, swap-reject, swap-cancel
│   │   ├── daemon/               # daemon start/stop/status (thin wrappers over ../daemon)
│   │   ├── host/                 # NEW — ex-ahctl commands under "host" namespace
│   │   │   ├── spawn.ts
│   │   │   ├── list.ts
│   │   │   ├── stop.ts
│   │   │   ├── start.ts
│   │   │   ├── inspect.ts
│   │   │   ├── command.ts
│   │   │   ├── remove.ts
│   │   │   ├── pause.ts
│   │   │   ├── resume.ts
│   │   │   └── help.ts
│   │   └── completions/          # bash, zsh, fish
│   ├── daemon/                   # long-running event listener (moved from sphere-sdk/cli/daemon.ts)
│   │   ├── daemon.ts
│   │   ├── config.ts
│   │   └── actions/              # bash/webhook/builtin
│   ├── formatters/               # table, status, json output — moved from agentic-hosting/src/cli/formatters/
│   ├── transport/
│   │   ├── dm-transport.ts       # HmcpOverDm — the new transport (§2)
│   │   ├── correlation.ts        # msg_id → Promise<HmcpResponse>
│   │   └── subscriber.ts         # lifecycle for short-lived CLI subscriptions
│   └── util/
│       ├── args.ts               # option parsing helpers
│       ├── errors.ts             # CliError, exit codes
│       └── prompt.ts             # stdin prompt (moved from cli/index.ts)
├── tests/
│   ├── unit/
│   ├── integration/              # mocked Sphere + fake relay
│   └── e2e/                      # against live relay + docker host manager
└── docs/
    ├── ARCHITECTURE.md
    ├── MIGRATION-FROM-AHCTL.md
    ├── MIGRATION-FROM-SPHERE-SDK-CLI.md
    └── DM-TRANSPORT.md
```

### 1.2 Package + binary

- **npm package name:** `@unicity-sphere/cli`. Rationale: scope matches new GitHub org `unicity-sphere`. Avoids collision with the existing `@unicitylabs/*` publishing surface, which the user has been using as a pre-release vehicle.
- **Binary name(s):** primary `sphere`, alias `scli`.
  - `sphere` is the obvious, memorable name. Collision risk with `sphere` (astronomy tool) exists but the user controls the org and can disambiguate.
  - `scli` is the short alias for power users; no external collisions found.
  - Do **not** keep `sphere-cli` as a binary name — it reads as the project, not the command. But publish with `bin: { sphere, scli, "sphere-cli": "sphere" }` so existing docs continue to work.
- **Deprecate `ahctl`:** publish a stub package `ahctl` that prints "ahctl has moved; run `sphere host <cmd>`" and exits non-zero. Keep for two minor versions.

### 1.3 Command topology

The two CLIs cover very different surface areas — wallet vs host management. They should share an identity/config layer but present as **namespaced subcommand trees** to keep each coherent:

```
sphere <global-flags> <namespace> <command> [args]

Namespaces:
  wallet      init, status, list, use, create, delete, current
  balance     balance, tokens, assets, asset-info, l1-balance, verify-balance
  payments    send, receive, history, sync, addresses, switch, hide, unhide
  nametag     register, info, sync, my
  dm          send, inbox, history
  group       create, list, my, join, leave, send, messages, members, info
  market      post, search, my, close, feed
  invoice     create, import, list, status, close, cancel, pay, return,
              receipts, notices, auto-return, transfers, export, parse-memo
  swap        propose, list, accept, ping, status, deposit, reject, cancel
  host        spawn, list, stop, start, inspect, remove, pause, resume, help
              # HMCP commands: controller → manager, host-scoped lifecycle
  tenant      status, shutdown, log-level, strategy, intent, swap, portfolio,
              withdraw, exec, help
              # ACP commands: controller → tenant, tenant-scoped operations.
              # Addressed by the tenant's own @nametag/pubkey (host-agnostic).
              # System commands (status/shutdown/exec/log-level) route through
              # the tenant's current host; owner commands (strategy/intent/
              # swap/portfolio/withdraw) DM the tenant directly.
  crypto      encrypt, decrypt, parse-wallet, wallet-info, generate-key,
              validate-key, hex-to-wif, derive-pubkey, derive-address
  util        to-smallest, to-human, format, base58-encode, base58-decode
  config      show, set, get, unset    # per-user + global config management
  daemon      start, stop, status
  faucet      topup
  completions bash|zsh|fish
```

**Compatibility aliases** for the legacy flat syntax: `sphere swap-propose` routes to `sphere swap propose`, `sphere dm-inbox` routes to `sphere dm inbox`, etc. Drop aliases in v1.0.

### 1.4 Build system

**tsup** (not vite, not bare tsc):
- Both source repos use tsup already. One less thing to learn.
- Dual ESM/CJS output. CJS is needed for `#!/usr/bin/env node` bin to work under older Node without `--experimental-vm-modules` dances.
- Single entry `src/index.ts` → `dist/index.js` + `dist/index.cjs` + `.d.ts`.
- `bin/sphere.mjs` is a 15-line shim (like `sphere-sdk/cli/bin.mjs:1-17`) that chooses `dist/index.cjs` when present, falls back to `tsx src/index.ts` during dev.

---

## 2. DM transport design

### 2.1 The interface

Replace `src/cli/transport/types.ts:3-6` (`CliTransport.sendRequest(request): Promise<HmcpResponse>`) with:

```ts
// sphere-cli/src/transport/dm-transport.ts
export interface DmTransportConfig {
  /** The recipient manager, as a Unicity address: @nametag, DIRECT://hex, or raw hex pubkey. */
  managerAddress: string;
  /** How long to wait for a reply DM before rejecting. Default 120s (matches HMCP hello_timeout + margin). */
  timeoutMs?: number;
  /** How long to wait for the first relay to confirm subscription. Default 5s. */
  subscribeTimeoutMs?: number;
  /** Relay URLs. If unset, read from profile. */
  relays?: readonly string[];
}

export interface DmTransport {
  /**
   * Send an HMCP request over DM and await the correlated response.
   * Throws TimeoutError if no matching reply within timeoutMs.
   * Throws AuthError if the replying pubkey is not the expected manager.
   */
  sendRequest(request: HmcpRequest): Promise<HmcpResponse>;
  dispose(): Promise<void>;
}

export async function createDmTransport(
  sphere: Sphere,
  config: DmTransportConfig,
): Promise<DmTransport>;
```

### 2.2 Identity — where does the CLI wallet come from?

The new transport requires the CLI to **be** a Sphere wallet — DMs are signed by a secp256k1 key and the manager's `auth.isAuthorized(senderPubkey)` (`src/host-manager/auth.ts:13`) matches against `AUTHORIZED_CONTROLLERS`. That pubkey must exist.

**Chosen UX:** reuse the existing wallet profile machinery from `sphere-sdk/cli/index.ts:58-136`. A `sphere` session always has an active profile, and the same profile that a developer uses for `sphere balance` is the one that signs `sphere host spawn`. The authorized-controllers config in the host manager lists that profile's `chainPubkey`.

Concretely:
1. User runs `sphere wallet create --name dev-controller --network testnet`.
2. `sphere config show` prints the `chainPubkey` in compressed hex (66 chars, the format `AUTHORIZED_CONTROLLERS` expects per `src/host-manager/auth.test.ts`).
3. Operator adds that pubkey to the manager's `authorized_controllers` config on the host.
4. User runs `sphere host spawn -t <template> -n <name>` — the CLI's active profile signs, DM goes to manager, manager verifies against allowlist, manager DMs back. No env var, no header.

**Fallback modes** (documented, not default):
- `SPHERE_CLI_NSEC=nsec1...` env var for CI/scripts. Overrides the active profile for that invocation. Never reads from argv (leaks to process listings).
- `--profile <name>` flag to pick a non-active profile without switching.
- `SPHERE_CLI_EPHEMERAL=1` generates a fresh key per invocation. Useless for HMCP (never authorized) but useful for anonymous DM reads, market browsing, etc.

**Do not** prompt for nsec interactively — CLIs must be scriptable.

### 2.3 Discovering the manager

The `ahctl` today uses an **address** (`AHCTL_BRIDGE_URL=http://127.0.0.1:9400`). The DM-based CLI needs a **Unicity address** for the manager.

**Chosen mechanism:** `--manager <address>` flag, or `SPHERE_HOST_MANAGER` env var. Accepts any form the SDK resolves:
- `@host-manager-production` (nametag — canonical, per the user's MEMORY.md feedback)
- `DIRECT://027f3a...` (direct address, no Nostr lookup)
- `027f3a...` (raw compressed hex pubkey)

**Persistence:** `sphere config set host.manager @host-manager-production` stores the preferred manager in `~/.sphere-cli/config.json` under `host.manager`. `--manager` flag overrides per-invocation. A command run without manager configured prints:

```
Error: no host manager configured.
Run `sphere config set host.manager @<nametag>` or use --manager.
```

Nametag resolution has a cost (one Nostr query). For hot paths, `sphere config resolve-manager` caches the direct address back to config; the plain-hex pubkey path skips the lookup entirely.

### 2.4 Request/response correlation

HMCP already ships `msg_id` on requests (`src/protocols/hmcp.ts:237-244`) and `in_reply_to` on responses (`src/protocols/hmcp.ts:247-257`). The transport keeps a `Map<msgId, { resolve, reject, timer }>` and demultiplexes DMs from the subscription:

```
sendRequest(req):
  msgId = req.msg_id
  register pending{resolve,reject} under msgId
  start timeoutTimer(timeoutMs) that rejects + unregisters
  subscribe (if not already)
  sphere.communications.sendDM(managerAddress, serializeMessage(req))
  return promise

on dm received (senderPubkey, content):
  parse HmcpResponse (may fail — drop silently with debug log)
  look up pending[response.in_reply_to]
  if !pending: drop (stale or unsolicited) — log at debug
  if !pubkeysEqual(senderPubkey, expectedManagerPubkey): drop + warn
    (prevents response injection from an attacker who knows msg_id)
  clearTimer(pending.timer)
  unregister
  resolve(response)
```

**The auth check on incoming DMs is load-bearing.** The SDK's `CommunicationsModule.onDirectMessage` handler at `sphere-sdk/modules/communications/CommunicationsModule.ts:449` receives every DM addressed to the CLI's pubkey. An attacker who has guessed a pending `msg_id` (or observed the outgoing DM on the relay graph) could forge a reply. Drop any response where `senderPubkey !== resolvedManagerPubkey`.

**Cancellation:** expose `AbortSignal` support on `sendRequest(req, { signal })`. SIGINT from the user must abort in-flight requests cleanly.

### 2.5 Subscription lifecycle — the hard problem

Short-lived CLI invocations cannot afford to:
- Connect to N Nostr relays from cold
- Sync their full DM inbox history
- Wait several seconds per invocation

**Strategy:** the CLI always loads the wallet's persistent Sphere storage (it already does — every profile has its own dir, see `sphere-sdk/cli/index.ts:34-37`). But it opts out of full history sync for one-shot host commands:

1. `getSphere({ scope: 'host-command' })` creates a Sphere with `cacheMessages: false` on the communications module (`sphere-sdk/modules/communications/CommunicationsModule.ts:27-40` — the cachedmessages: false path exists precisely for this: "anonymous/ephemeral agents"). The CLI doesn't need historical DMs to execute a single HMCP request/response.
2. Start relay subscriptions in parallel. Resolve the promise when **any one** relay confirms (`OK` or `EOSE` — sphere-sdk's transport should expose this; if not, add it).
3. Set a hard cap: `subscribeTimeoutMs=5s`. If no relay responds, fail fast with "no relays reachable".
4. Fire the DM send.
5. Await response or timeout.
6. `dispose()` unsubscribes and closes.

**Expected latency** (empirical numbers required before shipping — see §6):
- Cold relay connect: ~300–800 ms on a healthy relay
- DM round trip (publish → peer receive → peer publish → our receive): ~500–1500 ms
- Total per-command: ~1–3 s wall clock

For interactive use this is acceptable; for scripted loops it hurts. Mitigations:
- `sphere host-session start` opens a long-running relay connection that subsequent commands attach to via IPC (unix socket under `~/.sphere-cli/session.sock`). Deferred to v0.3.
- Prefer `DIRECT://<hex>` managers over `@nametag` to skip nametag lookup.

### 2.6 DM payload size

HMCP envelopes are capped at 64KB by `src/protocols/envelope.ts:19` (`MAX_MESSAGE_SIZE`). The largest response today is `hm.spawn_ready` (`HmSpawnReadyPayload` at `src/protocols/hmcp.ts:111-118` — fits in <500 bytes) or `hm.list_result` which scales with instance count; at 200 bytes per instance summary, 64KB holds ~300 instances. Good enough.

NIP-17 gift-wrapped DMs have a ~65KB practical ceiling (rumor payload + seal + gift wrap encryption, each adding constant overhead). Validate empirically with a `hm.list` over 100 instances during phase 3. If we bump against it, add cursor pagination to `hm.list` (payload: `cursor`, response: `next_cursor`). Non-blocking for v0.1.

### 2.7 Why not keep HTTP bridge as fallback?

The user explicitly rejected this, correctly. Reasons:

1. **Auth model is wrong.** The `X-Controller-Pubkey` header is trust-on-claim. `AUTHORIZED_CONTROLLERS` allowlist works only because the bridge is bound to `127.0.0.1` by default (`src/host-manager/http-bridge.ts:14`) — any process on the box can bypass it. DM-based auth is cryptographic.
2. **Two transports = two code paths to keep in sync.** Protocol changes have to be mirrored.
3. **Remote operation.** Operators running the manager on a server cannot use ahctl today without port-forwarding or SSH. DM removes that entirely — the controller talks to the manager from anywhere.
4. **The manager already accepts DMs** (`src/host-manager/manager.ts` → `handleIncomingDm`). The bridge at `src/host-manager/http-bridge.ts:146-148` literally calls `manager.handleIncomingDm(pubkey, bridgeAddress, body)`. The server-side code is already DM-shaped.

**The HTTP bridge is deleted everywhere. No fallback, not even hidden or test-only.**

For testing, the substitution happens at a different seam:
- **Unit tests** inject a mock `DmTransport` that resolves `sendRequest` synchronously against an in-memory manager stub. No transport switch is needed.
- **Integration tests** wire sphere-cli to a mock `Sphere` with an in-memory `CommunicationsModule` that delivers DMs directly to a test host-manager instance (existing pattern in `agentic-hosting/test/mocks/mock-sphere.ts`).
- **E2E tests** spin up real Nostr relays (testcontainers / `nak`) + a real host manager, validating the production DM path end-to-end.

No `SPHERE_CLI_TRANSPORT=http` hidden env. No `http-transport.ts`. There is only DM.

---

## 3. Code migration map

### 3.1 sphere-sdk/cli/

| File | Fate | Notes |
|---|---|---|
| `cli/bin.mjs` | **DELETE** | Replaced by `sphere-cli/bin/sphere.mjs`. |
| `cli/index.ts` (5045 lines) | **MOVE + SPLIT** | Split by namespace under `sphere-cli/src/commands/*/`. Every `case '<name>':` block becomes a file. The dispatcher becomes a `commander` tree instead of the hand-rolled switch. Shared helpers (`getSphere`, `closeSphere`, `parseAssetArg`, `ensureSync`, `resolveCoin`) move to `sphere-cli/src/sphere/init.ts` + `sphere-cli/src/util/`. |
| `cli/daemon.ts` (686 lines) | **MOVE** | To `sphere-cli/src/daemon/daemon.ts`. Imports change from `'../core/Sphere'` to `'@unicitylabs/sphere-sdk'`. |
| `cli/daemon-config.ts` (414 lines) | **MOVE** | To `sphere-cli/src/daemon/config.ts`. |
| `package.json` cli script `"cli": "npx tsx cli/index.ts"` | **DELETE** | Library has no CLI. |
| `package.json` `"files": ["dist", "README.md", "LICENSE"]` | **UNCHANGED** | cli/ was never in `files` — already excluded from npm publish. |

### 3.2 agentic-hosting/src/cli/

| File | Fate | Notes |
|---|---|---|
| `src/cli/main.ts` | **DELETE** | Replaced by `sphere host` namespace. |
| `src/cli/config.ts` | **DELETE** | `AHCTL_CONTROLLER_PUBKEY` / `AHCTL_BRIDGE_URL` gone; CLI gets pubkey from active profile. |
| `src/cli/config.test.ts` | **DELETE** | Config parser is deleted. |
| `src/cli/utils.ts` | **MOVE** | To `sphere-cli/src/util/identifiers.ts` (`isUuid`). |
| `src/cli/commands/*.ts` (10 files) | **MOVE + REWRITE** | To `sphere-cli/src/commands/host/*.ts`. The command bodies are mostly unchanged — what changes is `getTransport()` now returns `DmTransport`, not `HttpBridgeTransport`. Command files import `createHmcpRequest` from `@unicitylabs/hmcp-protocol` (new — see §4). |
| `src/cli/transport/http-bridge.ts` | **DELETE** | |
| `src/cli/transport/http-bridge.test.ts` | **DELETE** | |
| `src/cli/transport/types.ts` | **MOVE + RENAME** | To `sphere-cli/src/transport/types.ts` as `HostTransport`. |
| `src/cli/transport/index.ts` | **DELETE** | Re-export map changes. |
| `src/cli/formatters/*.ts` (3 files) | **MOVE** | To `sphere-cli/src/formatters/host/`. |
| `bin/ahctl` | **DELETE** | Binary deleted from agentic-hosting. Operators use `sphere host`. |
| `package.json` `bin: { ahctl: "./bin/ahctl" }` | **DELETE** | |

### 3.3 agentic-hosting host-manager side (STAYS — simplified)

The manager is not moving; the refactor simplifies it:

| File | Fate | Notes |
|---|---|---|
| `src/host-manager/manager.ts` | **STAY (small edit)** | `handleIncomingDm` already exists — it's called from the HTTP bridge today. Replace the bridge caller with the real Sphere DM subscription (same pattern as `src/tenant/main.ts:108-134`). |
| `src/host-manager/main.ts:45-60` | **REWRITE** | Currently wires `createHttpBridge`. Rewire to subscribe to Sphere DMs via the manager's own wallet: `sphere.communications.onDirectMessage(msg => manager.handleIncomingDm(msg.senderPubkey, msg.senderPubkey /*direct addr*/, msg.content))`. The `sender` at `main.ts:28-37` stays — it already uses pending responses; change it to DM directly: `sphere.communications.sendDM(recipient, content)`. |
| `src/host-manager/http-bridge.ts` | **DELETE** | |
| `src/host-manager/http-bridge.test.ts` | **DELETE** | |
| `src/host-manager/hmcp-handler.ts` | **STAY** | Pure protocol logic, no bridge dependencies. |
| `src/host-manager/auth.ts` | **STAY (no change)** | Already the right model. |
| `src/host-manager/acp-client.ts` | **STAY (no change)** | Already DM-based. |

The manager binary itself becomes a Sphere-wallet-backed service instead of an HTTP-bridge-backed service. This is a cleanup the migration enables, not a requirement of phase 4 — the manager can keep running its HTTP bridge alongside during phase 4 if needed; phase 5 removes it.

### 3.4 Protocols (cross-cutting)

`src/protocols/hmcp.ts` + `src/protocols/acp.ts` + `src/protocols/envelope.ts` (three files, ~13KB total) are pure TypeScript — no Docker, no HTTP, no Node-only APIs. They are the protocol contract between `sphere-cli` (client), the host manager, and tenants.

**Two options:**

1. **Keep in agentic-hosting, export as sub-path.** Add a `"./protocols"` export to agentic-hosting's package.json. `sphere-cli` imports with:
   ```ts
   import { createHmcpRequest, type HmcpResponse } from '@unicitylabs/agentic-hosting/protocols';
   ```
   Pros: no new repo. Cons: `sphere-cli` pulls `@unicitylabs/agentic-hosting` transitively → dockerode, ws, etc. Even with tree-shaking the type surface drags in the package install.

2. **Factor out as `@unicitylabs/hmcp-protocol`.** New small package in agentic-hosting's monorepo (or a separate repo — but overkill for ~13KB of types). Contains just `hmcp.ts`, `acp.ts`, `envelope.ts`, plus tests.
   Pros: clean dep graph. `sphere-cli` depends only on `@unicitylabs/sphere-sdk` + `@unicitylabs/hmcp-protocol`. Cons: one more publish target.

**Chosen: option 2.** The isolation is worth it. agentic-hosting's own code imports from the same package, eliminating the current duplication-by-relative-path. Publish under the existing `@unicitylabs` scope (not `@unicity-sphere`) since that scope already owns the agentic-hosting subsystem.

Structure (within agentic-hosting, as a workspace or a plain sub-dir that npm can publish):
```
protocols/
├── package.json        # @unicitylabs/hmcp-protocol
├── tsup.config.ts
├── src/
│   ├── hmcp.ts         # moved from src/protocols/hmcp.ts
│   ├── acp.ts          # moved from src/protocols/acp.ts
│   ├── envelope.ts     # moved from src/protocols/envelope.ts
│   └── index.ts
└── tests/
```

`agentic-hosting/src/protocols/` becomes re-exports from the new package so the rest of `src/` doesn't move.

### 3.5 Shared code

| From | Fate | Notes |
|---|---|---|
| `agentic-hosting/src/shared/crypto.ts` (`SECP256K1_HEX_KEY_RE`, `pubkeysEqual`, `tokensEqual`) | **STAY** | Manager-side only. But the regex + equality primitives should also be exported from `@unicitylabs/hmcp-protocol` since the CLI needs them for input validation. Duplicate is cheap (60 lines). |
| `agentic-hosting/src/shared/types.ts` (`InstanceState`) | **SPLIT** | `InstanceState` is part of the HMCP contract — move to `@unicitylabs/hmcp-protocol`. Other types (`TenantConfig`, `ManagerConfig`) stay. |
| `agentic-hosting/src/shared/errors.ts` (`ProtocolError`) | **SPLIT** | `ProtocolError` used by `hmcp.ts` → moves with it. |

---

## 4. Integration contract

### 4.1 sphere-cli ⇢ @unicitylabs/sphere-sdk

`sphere-cli` uses the SDK for:
- `Sphere.init` / `Sphere.load` / `Sphere.exists` (wallet lifecycle)
- `sphere.identity.chainPubkey` / `sphere.identity.directAddress`
- `sphere.communications.sendDM(recipient, content)` / `sphere.on('message:dm', ...)`
- `sphere.payments.send(...)` / token registry / L1 crypto primitives
- All the existing sphere-sdk/cli/index.ts surface

The SDK is already published and versioned. `sphere-cli` declares `"@unicitylabs/sphere-sdk": "^0.7.0"`. No breaking change required in the SDK.

### 4.2 sphere-cli ⇢ @unicitylabs/hmcp-protocol

`sphere-cli` uses the new package for:
- `createHmcpRequest(type, payload)` — request constructor
- `parseHmcpResponse(json)` — response parser with validation
- Type definitions: `HmcpRequest`, `HmcpResponse`, `HmSpawnPayload`, etc.
- `SECP256K1_HEX_KEY_RE` for input validation
- `InstanceState` enum

Zero runtime dependency on agentic-hosting. This is what makes the split clean.

### 4.3 Host manager ⇢ @unicitylabs/hmcp-protocol

The manager is now **also** a consumer of `@unicitylabs/hmcp-protocol`. Today `src/host-manager/manager.ts` imports from `../protocols/hmcp.js` — those imports change to `@unicitylabs/hmcp-protocol`. The re-export at `src/protocols/index.ts` keeps the legacy paths working during the transition.

---

## 5. Migration phases

Phases are designed for **incremental**, **reversible** steps. Each phase is independently mergeable and verifiable.

### Phase 0 — planning + agreement (this document)

- **Files touched:** only `docs/SPHERE-CLI-EXTRACTION-PLAN.md` in both repos.
- **Success criteria:** reviewer sign-off on §1–§6. Open questions in §6 resolved or marked "accepted risk".
- **Rollback:** delete the doc.

### Phase 1 — create `github.com/unicity-sphere/sphere-cli` scaffold

- **Files touched:** all in the new repo.
- New repo scaffold: `package.json`, `tsconfig.json`, `tsup.config.ts`, `eslint.config.js`, `vitest.config.ts`, `.github/workflows/{ci.yml,release.yml}`, `README.md`, `LICENSE` (MIT), `CHANGELOG.md`.
- Stub `src/index.ts` that prints `Sphere CLI v0.0.0` and exits 0.
- CI: lint + typecheck + test must pass. Release workflow gated on tag `v*`.
- **Success criteria:** `npm ci && npm run build && npm test` green locally and in CI; `npm pack` produces a valid tarball.
- **Rollback:** archive the repo; trivial.

### Phase 2 — move sphere-sdk CLI code (minimal behavioral change)

Two branches, two PRs:

**Branch A — `sphere-cli/feat/import-from-sphere-sdk`:**
- Copy `cli/index.ts`, `cli/daemon.ts`, `cli/daemon-config.ts`, `cli/bin.mjs` into `sphere-cli/src/legacy/`.
- Rewire imports from relative (`'../core/...'`) to package (`'@unicitylabs/sphere-sdk'` + its sub-paths).
- Split `index.ts`'s dispatcher into namespace files — but keep the legacy flat names as aliases.
- Move `daemon.ts` to `src/daemon/`.
- Ship v0.1.0-alpha.0 on npm tag `alpha`.

**Branch B — `sphere-sdk/refactor/extract-cli-to-sphere-cli` (already exists):**
- **Keep** `cli/` directory on this branch — this PR doesn't delete anything yet (phase 5 does).
- Add a new README section: "The Sphere CLI has moved to `@unicity-sphere/cli`. See migration guide."
- Add `cli/index.ts` deprecation banner: prints to stderr when invoked via `npm run cli`.

- **Success criteria:** alpha CLI installs via `npm i -g @unicity-sphere/cli@alpha`; every command from the sphere-sdk CLI runs with identical behavior (verified against the existing sphere-sdk/cli integration tests, ported to sphere-cli).
- **Rollback:** keep sphere-sdk/cli in place; don't publish alpha to `latest`.

### Phase 3 — design + implement DmTransport, dogfood against live host manager

Branch: `sphere-cli/feat/dm-transport`.

- Extract `@unicitylabs/hmcp-protocol` in agentic-hosting (see §3.4) as a workspace sub-package. Publish `@unicitylabs/hmcp-protocol@0.1.0`.
- Implement `sphere-cli/src/transport/dm-transport.ts` per §2.
- Implement correlation layer with per-msg_id pending map + timeout.
- Implement short-lived subscriber with any-relay-EOSE wait.
- **Produce per-command sync matrix** (`sphere-cli/docs/SYNC-MATRIX.md`) — every command from both CLIs gets a row documenting default waits, valid `--skip-*` flags, and default `--timeout`. Matrix is a merge-blocking deliverable, not optional. See §6.10.
- Unit tests: mock `Sphere` + mock relay, verify request-response round trip, timeout behavior, sender-pubkey auth check, AbortSignal cancellation, per-command wait/skip semantics.
- E2E test: stand up a real host manager + real Nostr relay (testcontainers — sphere-sdk already uses it per devDependencies), run `sphere host spawn` against it, verify the container is created.
- Measure latency — record P50/P95/P99 in a perf doc under `docs/DM-TRANSPORT.md`. If P95 > 5s, invest in session optimization (persistent `sphere host-session` background process) before phase 4.
- **Success criteria:** `npm run test:e2e` green; P95 latency documented and ≤ 5s for a single `sphere host list` against a local relay; SYNC-MATRIX.md lists every command from v0.1 surface; `@unicitylabs/hmcp-protocol@0.1.0` published.
- **Rollback:** ship only the protocol package; don't ship the transport yet.

### Phase 4 — migrate ahctl commands to DmTransport

Branch: `sphere-cli/feat/host-commands` (and the existing `agentic-hosting/refactor/ahctl-dm-transport`).

- Copy `agentic-hosting/src/cli/commands/*.ts` into `sphere-cli/src/commands/host/*.ts` one file at a time; rewire to `DmTransport`.
- Port `agentic-hosting/src/cli/formatters/` to `sphere-cli/src/formatters/host/`.
- Update `sphere-cli/src/index.ts` dispatcher: add `host` namespace.
- Verify each command matches ahctl's output byte-for-byte (except bridge-specific error messages) via golden-file tests.
- In agentic-hosting: **do not delete** `src/cli/` yet. Mark `bin/ahctl` as deprecated; print "sphere-cli supersedes ahctl" on stderr.
- Publish `@unicity-sphere/cli@0.1.0-beta.0`. Announce in release notes.
- **Success criteria:** every ahctl command has a `sphere host` equivalent that produces equivalent output against the same host manager. Both tools coexist on an engineer's machine for at least 1 week of internal use.
- **Rollback:** delete the `host` namespace from sphere-cli; ahctl continues to ship.

### Phase 5 — delete CLI code from source repos

Branches: `sphere-sdk/refactor/delete-cli` and `agentic-hosting/refactor/delete-ahctl`.

- Enforce a **deprecation transition window** of at least 4 weeks from phase 4 publish.
- sphere-sdk: `rm -r cli/`. Remove `"cli": "npx tsx cli/index.ts"` from package.json. Remove `tsx` devDep if nothing else uses it.
- agentic-hosting: `rm -r src/cli/ src/host-manager/http-bridge.ts src/host-manager/http-bridge.test.ts bin/ahctl`. Remove `bin` from package.json.
- Rewire `src/host-manager/main.ts` to subscribe to DMs directly via Sphere SDK (§3.3). Deprecate `HMCP_BRIDGE_PORT` / `HMCP_BRIDGE_HOST` env vars; print a startup warning.
- Manager binary now requires `SPHERE_MANAGER_NSEC` (or a profile dir) — that's a deployment-docs update.
- **Success criteria:** agentic-hosting's test suite green without any `http-bridge` in the tree; no `ahctl` binary; sphere-sdk's test suite green without `cli/`.
- **Rollback:** revert is clean (git revert). But by this phase, operators are on sphere-cli — rolling back breaks them.

### Phase 6 — publish v0.1 of sphere-cli

- Move `@unicity-sphere/cli@0.1.0-beta.N` to `0.1.0` (stable).
- Publish homebrew tap, doc site, completion scripts.
- `ahctl` stub package: publishes a v0.99 that prints "moved to sphere-cli" and exits 1.
- Announce.

**Success criteria:** one week of no new issues tagged `regression:dm-transport`.

---

## 6. Questions + risks (all resolved 2026-04-21)

### 6.1 Discoverability for existing sphere-sdk CLI users ✅ RESOLVED

- The sphere-sdk README at `sphere-sdk/README.md` refers to `npm run cli` and shell completions installed under `sphere-cli` — both need updates.
- Existing users who alias `sphere-cli` to `npm run cli` in sphere-sdk's checkout will get the sphere-sdk binary until they `npm i -g @unicity-sphere/cli`. A one-time stderr deprecation banner covers this.
- **Resolution:** **XDG by default** (`~/.config/sphere/`), legacy `./.sphere-cli/` as fallback with deprecation warning printed on use, **drop fallback in v1.0**. Config migration helper: `sphere config migrate-from-legacy` performs a one-shot move of `./.sphere-cli/` → `~/.config/sphere/`.

### 6.2 NIP-17 payload ceiling ✅ RESOLVED

- Single `hm.list_result` grows linearly with instance count. At ~200 bytes/instance, 64KB holds ~300 instances. For multi-tenant hosts at that scale, pagination on `hm.list` is required. Not blocking for v0.1 (internal deployments have <50 instances), but tracked for v0.2.
- **Resolution (accepted):** 64KB limit is a protocol-level cap (`src/protocols/envelope.ts:19`). When we hit it, cursor-based pagination on `hm.list` is the fix. v0.2 roadmap item.

### 6.3 Fresh-subscription-per-command latency & sync semantics ✅ RESOLVED

- **Resolution:** The default CLI contract is **"wait for everything the command causally implies."** Concretely:
  - A command that fires an aggregator write waits for aggregator acknowledgement before returning.
  - A command that publishes a Nostr event waits for `OK` from at least one configured relay.
  - A command that uploads content to IPFS waits for the CID to resolve against the configured IPFS node.
  - A command that sends a DM waits for the correlated reply DM (HMCP `in_reply_to`).
  - A command that triggers tenant heartbeat (e.g. after `hm.spawn`) waits for the first heartbeat if applicable.
- **Opt-outs:**
  - `--skip-aggregator-sync` / `--skip-ipfs-sync` / `--skip-relay-ack` — per-subsystem opt-out for power users who know the state propagates externally.
  - `--timeout <ms>` — global ceiling; default is derived from the sum of expected sync times per command (e.g., 30s for a spawn that expects hello within 30s).
  - `--profile <name>` — picks a non-active wallet profile AND pre-warms relay subscriptions for a single-invocation session when combined with `--keep-session`.
- **Per-command sync matrix:** required deliverable in phase 3 (see §5). Each command documents which subsystems it waits on by default, which `--skip-*` flags are valid, and what "done" means.

### 6.4 Trader's direct-controller auth path & tenant mobility ✅ RESOLVED

- **Resolution:** Tenants **must be host-agnostic**. Controllers address tenants by the tenant's own `@nametag` / pubkey, not by `(host-manager, instance_id)` coordinates. The CLI command tree splits into `sphere host` (HMCP → manager, host-scoped lifecycle) and `sphere tenant` (ACP → tenant, tenant-scoped operations). Both are **first-class sibling namespaces**.
- **Routing for tenant commands:**
  - System-scoped (`STATUS`, `SHUTDOWN_GRACEFUL`, `SET_LOG_LEVEL`, `EXEC` — see `src/tenant/acp-listener.ts:68`) route **through the tenant's current host manager**. The CLI discovers the current host via a lookup table (`~/.config/sphere/tenants.json` — indexed by tenant pubkey, populated by `sphere host spawn` response and by `sphere tenant adopt`).
  - Owner-scoped (`SET_STRATEGY`, `CREATE_INTENT`, `WITHDRAW_TOKEN`, trading commands) **DM the tenant directly**, bypassing any manager. Host-agnostic by construction.
- **Minimum scope this refactor delivers:** the addressing model and command split above — enough for tenants to be relocatable without client-side changes. Full state-level mobility (checkpoint/restore between hosts, identity portability, live migration) is a separate spec and does not block v0.1.
- See §6.9 below for tenant-mobility follow-up items.

### 6.5 Daemon migration ✅ RESOLVED

`sphere-sdk/cli/daemon.ts` is a long-running event listener with configurable bash/webhook actions. It's a CLI-adjacent tool, not a library feature. **Resolution:** comes along into sphere-cli under `sphere daemon {start|stop|status}`. It does NOT become a host-management daemon — those are orthogonal. Existing daemon surface unchanged except for import paths.

### 6.6 Host manager runs as a Sphere wallet now ✅ RESOLVED

Phase 5 makes the manager a Sphere wallet process. This means:
- The manager has an nsec (secret) that must be provisioned at deploy time. Today it has no secret (HTTP bridge is unauthenticated).
- The manager's pubkey becomes its Nostr identity. Controllers address it via `@<nametag>` or direct hex.
- The manager must be present on Nostr relays to receive DMs. If relays are down, the manager is unreachable — this is a real operational consideration the HTTP bridge did not have.
- **Resolution (accepted):** relays being down is an incident class operators already accept for tenant↔manager traffic. Symmetrizing controller↔manager to the same failure mode is a simplification. Key custody model (env var / file / Vault) is an ops decision tracked in phase 5 deployment docs.

### 6.7 Format compatibility ✅ RESOLVED

`AHCTL_CONTROLLER_PUBKEY` accepts 64/66/130 hex (`src/cli/config.ts:12`). `AUTHORIZED_CONTROLLERS` comparison at `src/host-manager/auth.ts` uses `pubkeysEqual` which is length-agnostic. Sphere SDK's `identity.chainPubkey` is 66-char compressed. **Resolution:** normalize to 66-char compressed everywhere in sphere-cli; add `sphere config show --format=authorized-controllers` that emits exactly the form operators paste into manager config. Non-66-char inputs are accepted on command lines but normalized immediately, with a one-line stderr notice explaining the normalization.

### 6.8 Uncommitted changes on `feat/idempotent-spawn-replay-auth` ✅ RESOLVED

`feat/idempotent-spawn-replay-auth` is not yet merged to master. It touches `src/host-manager/manager.ts` heavily (content-hash replay guard, direct controller auth, round-7 queue-cap defense). **Resolution:** assume that branch merges before phase 3 begins. Phase 3 rebases on master. DM-transport design is forward-compatible — content-hash replay guard becomes more valuable under DM (where an attacker controlling a relay could replay ciphertext).

### 6.9 Tenant mobility follow-up (new, 2026-04-21)

Resolving 6.4 created a set of follow-up items that are **in scope for future work, not this CLI refactor**. Tracked here for continuity:

1. **Tenant identity portability:** today the wallet dir at `${tenants_dir}/${instance_id}/wallet` is host-local. A migration would require exporting the wallet state and importing it under a new instance_id on the destination host. `hm.export_tenant_state` / `hm.import_tenant_state` commands deferred to a later spec.
2. **Live vs cold migration:** cold = stop source, copy state, spawn on destination. Live = continuous replication + cutover. Cold is a v0.2 candidate; live is a v1.x research item.
3. **`sphere tenant adopt @tenant --host @manager-X`:** registers an existing tenant (spawned on a different host, or manually bootstrapped) into the local tenant lookup table so owner-scoped commands route. This is small and could even land in v0.1 if time allows.
4. **Post-migration identity continuity:** the tenant's nametag and chain pubkey must survive migration; `instance_id` may be regenerated per host. External parties (counterparties in trading) reference tenant by nametag/pubkey and should not notice migration. Addressing model in this refactor already assumes this.

### 6.10 Per-command sync matrix (new, 2026-04-21)

Producing the per-command sync matrix is a **mandatory phase 3 deliverable** (see §5 Phase 3 success criteria). Format:

```
Command: sphere host spawn
Default waits:
  - HMCP request DM ack (manager subscribed + envelope accepted by ≥1 relay)
  - spawn_ready correlated response (up to hello_timeout_ms)
  - Nametag registration if --nametag (Nostr publish + ≥1 relay OK)
Skips:
  - --skip-relay-ack (just return once manager pubkey subscribed)
  - --skip-nametag-sync (don't wait for registration)
Timeout: --timeout overrides total, default = hello_timeout_ms + 10s

Command: sphere wallet send <recipient> <amount> <coin>
Default waits:
  - Aggregator commit (SMT inclusion proof delivered)
  - Nostr DM to recipient ack (transfer envelope accepted by ≥1 relay)
  - IPFS publish of new token state (CID resolvable)
Skips:
  - --skip-aggregator-sync (fire-and-forget; caller verifies later)
  - --skip-ipfs-sync (no IPFS publish wait)
  - --skip-relay-ack (don't wait for DM ack)
Timeout: --timeout overrides total, default 60s.
```

Matrix lives at `sphere-cli/docs/SYNC-MATRIX.md` and is published with v0.1 release notes.

---

## 7. Git mechanics

### 7.1 Branches

| Repo | Branch | Purpose | State |
|---|---|---|---|
| sphere-sdk | `refactor/extract-cli-to-sphere-cli` | host-side work for phase 2 (deprecation banner) + phase 5 (delete `cli/`) | created, empty |
| agentic-hosting | `refactor/ahctl-dm-transport` | host-side work for phase 4 (deprecate) + phase 5 (delete `src/cli/`, `http-bridge`, `bin/ahctl`) | created, empty |
| sphere-cli | `main` (bootstrap) | phase 1 scaffold | repo does not exist yet |
| sphere-cli | `feat/import-from-sphere-sdk` | phase 2 | not yet |
| sphere-cli | `feat/dm-transport` | phase 3 | not yet |
| sphere-cli | `feat/host-commands` | phase 4 | not yet |
| agentic-hosting | `refactor/extract-hmcp-protocol` | phase 3, factor out `@unicitylabs/hmcp-protocol` | not yet |

### 7.2 PRs blocking the refactor

- `agentic-hosting#feat/idempotent-spawn-replay-auth` — must merge to master before phase 3 rebase (otherwise replay-guard + direct-controller auth land twice).
- `sphere-sdk#5eb2994` (v0.7.0 release) — already on main; phase 2 targets v0.7.x.

### 7.3 New repo creation ✅ DONE (2026-04-21)

**`github.com/unicity-sphere/sphere-cli`:**
- ✅ Created (public, default branch `main`, description "The unified CLI for Sphere SDK and agentic-hosting control").
- ✅ npm scope `@unicity-sphere` claimed by `cryptodragon` (owner).
- Initial README: one-paragraph description, install (`npm i -g @unicity-sphere/cli`), quickstart (`sphere wallet init && sphere host list`), link to docs.
- LICENSE: MIT (match sphere-sdk's LICENSE file byte-for-byte).
- Branch protection on `main`: require PR + 1 review + passing CI — **to configure after first commit lands.**
- Labels: same set as sphere-sdk.

### 7.4 Preserving git history

**Options for moving sphere-sdk/cli/ → sphere-cli/src/:**

1. `git filter-branch` / `git filter-repo` — rewrite sphere-sdk history into a new repo containing only `cli/` history, then graft as sphere-cli's initial commit. Cleanest history; most work.
2. `git subtree split` — same result, simpler command, but requires squashing.
3. **Just copy, attribute in commit.** Single commit: "feat: import CLI from sphere-sdk@5eb2994". Reference the source SHA in the commit message. History lookup goes through the sphere-sdk repo.

**Recommendation: option 3.** Reasons:
- The CLI is being restructured heavily (switch → commander tree, namespace split). Old blames don't map to new file structure anyway.
- New repo, new history. Makes PRs cleaner.
- Cost: history lookup requires switching repos. Acceptable — blame in sphere-sdk/cli/ is pinned at the import SHA.

Apply the same reasoning to agentic-hosting/src/cli/ → sphere-cli/src/commands/host/.

---

## 8. Success definition

By end of phase 6:

1. A single `npm i -g @unicity-sphere/cli` installs one binary (`sphere`, `scli`, `sphere-cli` alias) that covers everything both CLIs do today.
2. `sphere host spawn` works over DM against a remote host manager that never exposed any HTTP port. Controller auth is cryptographic (NIP-17 signature verified against `AUTHORIZED_CONTROLLERS`).
3. `sphere-sdk` ships without `cli/`. `agentic-hosting` ships without `src/cli/`, `src/host-manager/http-bridge.ts`, or `bin/ahctl`.
4. `@unicitylabs/hmcp-protocol` is published as a standalone types + validators package; both sphere-cli and agentic-hosting consume it.
5. Latency for a single host command over a healthy relay is documented at < 5s P95.
6. Docs in all three repos cross-link to the canonical place for each concern.

---

## Appendix A — File/line cross-reference

**sphere-sdk CLI surface:**
- Dispatcher: `cli/index.ts:1491-4778` (switch statement spanning ~3300 lines)
- Namespaces approximately: `cli/index.ts:1685-1866` (wallet), `cli/index.ts:1867-2220` (balance), `cli/index.ts:2926-3028` (dm), `cli/index.ts:3028-3367` (group), `cli/index.ts:3367-3599` (market), `cli/index.ts:3599-4231` (invoice), `cli/index.ts:4231-4728` (swap), `cli/index.ts:4729-4748` (daemon), `cli/index.ts:4750-4767` (completions).
- Shell completion generators: `cli/index.ts:4887-5045`.
- Daemon: `cli/daemon.ts:1-686`, `cli/daemon-config.ts:1-414`.

**agentic-hosting CLI surface:**
- Main + command wiring: `src/cli/main.ts:1-53`.
- Config: `src/cli/config.ts:1-36` (env vars to be deleted).
- HTTP bridge client: `src/cli/transport/http-bridge.ts:1-80` (to be deleted).
- Per-command handlers: `src/cli/commands/*.ts` (10 files, avg 50 lines each).
- HMCP protocol types (moving to @unicitylabs/hmcp-protocol): `src/protocols/hmcp.ts:1-336`, `src/protocols/acp.ts:1-154`, `src/protocols/envelope.ts:1-78`.
- Manager-side HTTP bridge (to be deleted in phase 5): `src/host-manager/http-bridge.ts:1-239`, `src/host-manager/main.ts:45-60`.
- Manager-side DM entry point (already exists): `src/host-manager/manager.ts` → `handleIncomingDm` (called from bridge at `http-bridge.ts:146`).
- Auth allowlist (no change): `src/host-manager/auth.ts:1-22`.
- Existing DM wiring pattern (mirror for manager): `src/tenant/main.ts:100-134`.

**sphere-sdk DM surface the new transport uses:**
- `core/Sphere.ts` → `Sphere.init(...)` creates `sphere.communications`.
- `modules/communications/CommunicationsModule.ts:243-275` → `sendDM(recipient, content)` (resolves @nametag / DIRECT:// / hex).
- `modules/communications/CommunicationsModule.ts:449-470` → `onDirectMessage(handler)` subscription with replay for late handlers.
- `modules/communications/CommunicationsModule.ts:27-40` → `cacheMessages: false` mode for ephemeral CLI sessions.
