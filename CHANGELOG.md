# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### BREAKING — v1 state-transition-sdk removed (v2 engine cutover)

The legacy `@unicitylabs/state-transition-sdk@1.6.1-rc` engine is gone. The
canonical package name now resolves to the v2 SDK (pinned `2.0.0-rc.6027e82`),
consumed exclusively through the `token-engine/` port. Consequences:

- **The token engine is mandatory for money movement.** `send()`,
  `mintFungibleToken()`, `accounting.createInvoice()/importInvoice()` fail
  loudly (`AGGREGATOR_ERROR` / `INVOICE_ORACLE_REQUIRED`) when the oracle does
  not supply a v2 trust base + gateway URL. Recipients must have a published
  chain pubkey (`INVALID_RECIPIENT` otherwise).
- **Removed public API:** `payments.sendInstant()`, `payments.resolveUnconfirmed()`,
  instant-split/payment-session wire types (`types/instant-split`,
  `types/payment-session`), transport `sendInstantSplitBundle`/`onInstantSplitReceived`,
  oracle `submitCommitment`/`getProof`/`waitForProof`/`isSpent`/`getTokenState`/
  `getCurrentRound`/`mint`/`getStateTransitionClient`/`getAggregatorClient`/
  `waitForProofSdk` (+ their commitment/proof/mint types).
  `ReceiveOptions` finalization options are deprecated no-ops (v2 tokens arrive
  finished — there is no finalization phase).
- **Wire compatibility:** the only supported transfer payload is `V2_TRANSFER`
  (a finished v2 token blob). Incoming v1 payloads (V5/V6 instant-split,
  NOSTR-FIRST, `{sourceToken,transferTx}`, plain token JSON) are dropped with an
  explicit error log — peers must run a >=0.8 wallet to send to this wallet.
- **Incoming v2 transfers are now verified** (`engine.verify` + ownership check
  against this wallet's chain pubkey) before entering the balance; `validate()`
  checks v2 tokens via the engine (`verify` + `isSpent`).
- **Stored v1 TXF tokens** stay visible (parsed as plain JSON for display) but
  are unspendable — there is no migration path through the removed v1 engine.
  Orphaned pending-V5 tokens are terminalized to `invalid` on load (data kept).
  Legacy v1 TXF invoices are rejected on import with an explicit error.
- **`NETWORKS.testnet` now points at testnet2** (the v2 gateway network,
  networkId 4, own token registry); `testnet2` stays as an alias. `mainnet`/`dev`
  still point at v1-era aggregators — wallet operations there fail loudly until
  those gateways are cut over to the v2 protocol.
- **`AccountingModuleDependencies.trustBase` removed** (the engine owns trust);
  `accounting.importInvoice` accepts the v2 invoice blob (hex string);
  `CreateInvoiceResult.token` is now that hex blob `string` (was the v1
  `TxfToken` object type).
- **Oracle interface gains three REQUIRED members** the v2 engine is built
  from: `getTrustBaseJson()`, `getAggregatorUrl()`, `getApiKey()` — custom
  `OracleProvider` implementations must provide them.
- **Send-failure money-safety:** finished-but-undelivered transfer blobs are
  journaled (`PENDING_V2_DELIVERIES`) and replayed on `load()`; sources
  certified on-chain during a failed send become terminal `'spent'` (never
  restored to `'confirmed'`); tokens stuck `'transferring'` after a crash are
  reconciled against the network on `load()`.
- **Unicity ID on-chain claim is minted + stored at nametag registration**
  (`registerNametag`, init/load recovery, address switch): a self-issued v2
  `UnicityIdToken` saved as `NametagData { format: 'v2-cbor', token: <hex> }`
  (`NametagData.token` widened to `object | string`). Best-effort + idempotent —
  a gateway outage never fails registration; runtime name resolution stays
  Nostr-binding-only. On networks without a v2 oracle config a warn is logged
  on each load. New exports: `createUnicityIdMinter`, `IUnicityIdMinter`,
  `UnicityIdMintResult` (token-engine).

### Added
- **Thin-wallet core (wallet-api program, sdk-changes S1/S2/S6/S7)** —
  - **`WalletApiClient`** (new `wallet-api/` module + `./wallet-api` subpath export): challenge→sign→JWT auth with mandatory challenge-template verification (`unicity:wallet-api:auth:v1\n` prefix, own-pubkey + plausible-timestamp checks — the spend key never signs unverified server text), rotating refresh tokens (`v1.<sessionId>.<secretHex>`) with rotation-reuse-revocation fallback to a fresh challenge cycle, logout; typed REST for the §16 inventory/intents/blob endpoints (amounts are decimal strings on the wire, `bigint` in types); WS wake channel via the single-use ticket flow; refresh token kept only in injected storage (never logged); non-loopback base URLs must be `https:`. The client keeps the normative LOCAL copy of open intents (E.3) and re-PUTs them on a `syncEpoch` change.
  - **S6 field encryption** (`core/field-encryption.ts`): `deriveFieldEncryptionKey` = HKDF-SHA256(wallet privkey, `sphere-fieldenc-v1`); XChaCha20-Poly1305 envelopes `"enc1." + base64(nonce ‖ ciphertext)`; `assertFieldEnvelopeShape` is the server-side prefix/base64/size-cap check (ARCHITECTURE §8.3). New dependency `@noble/ciphers`.
  - **S2 lazy storage port**: `TokenStorageProvider` gains `listInventory(since?)` (value view, tombstone deltas, no blobs), `getToken(tokenId)` (on-demand blob fetch) and `applyDelta(transferId, spent, added, opts?)`; `WholeBlobInventoryAdapter` derives all three from `load()`/`save()` so every existing whole-blob provider (File/IndexedDB/IPFS) conforms unchanged.
  - **`WalletApiTokenStorageProvider`** (impl/shared, platform-neutral): tombstone-aware delta sync with `more` loops, paginated full pull closed by a `?since=<page-1 cursor>` delta, `syncEpoch`-change handling (discard cursors → full pull → re-PUT open intents), write-behind with empty-import protection (a fresh device or failed load never pushes removals; only confirmed-spend tombstones do), `recoverRemoved()` (re-fetch + locally verify + reactivate wiped tokens; server 409 = actually spent), content-addressed blob upload (412 = already present = success).
  - **S7 storage contract suite** (`tests/contract/storage-provider.contract.ts`): one shared suite run against both `FileTokenStorageProvider` (via the default adapters) and `WalletApiTokenStorageProvider` (against `tests/support/fake-wallet-api.ts`, an in-process §16 fake whose every behavior cites its ARCHITECTURE section).
- **`cacheMessages` option for CommunicationsModule** — `communications: { cacheMessages: false }` in `SphereInitOptions` disables DM caching in memory and storage. Messages still flow through `onDirectMessage()` handlers and `message:dm` events, but are never stored. Useful for anonymous/ephemeral agents (e.g. LLM bots) that only need streaming DM reception. `sendDM()` still works but doesn't cache the sent message. Deduplication is skipped when caching is disabled.
- **Message signing** — `signMessage()`, `verifySignedMessage()`, `hashSignMessage()` crypto functions for secp256k1 ECDSA with recoverable signatures (Bitcoin-like double-SHA256 with `Sphere Signed Message:\n` prefix). `Sphere.signMessage(message)` instance method encapsulates private key access. `SIGNING_ERROR` added to `SphereErrorCode`. `SphereInstance` interface in ConnectHost extended with `signMessage`. 22 unit tests covering signing, verification, round-trips, tampering detection, and edge cases.
- **Centralized logger** — `logger` singleton with `debug`/`warn`/`error` levels, `globalThis`-based state sharing across tsup bundles, per-tag control (`logger.setTagDebug('Nostr', true)`), and custom handler support
- **`SphereError` with typed error codes** — All SDK methods throw `SphereError` with a typed `.code` field (`SphereErrorCode`). 15 error codes: `NOT_INITIALIZED`, `ALREADY_INITIALIZED`, `INVALID_CONFIG`, `INVALID_IDENTITY`, `INSUFFICIENT_BALANCE`, `INVALID_RECIPIENT`, `TRANSFER_FAILED`, `STORAGE_ERROR`, `TRANSPORT_ERROR`, `AGGREGATOR_ERROR`, `VALIDATION_ERROR`, `NETWORK_ERROR`, `TIMEOUT`, `DECRYPTION_ERROR`, `MODULE_NOT_AVAILABLE`
- **`isSphereError()` type guard** — Helper function for typed error handling in catch blocks
- **Silent failure logging** — All previously silent `.catch(() => {})`, empty catch blocks, and timeout-based silent failures now log via `logger.warn` (operational issues) or `logger.debug` (expected/non-critical)
- **20 unit tests** for logger module
- **IPNS push-based sync via WebSocket** — `IpnsSubscriptionClient` connects to `/ws/ipns` on IPFS gateways for real-time IPNS update notifications, with exponential backoff reconnection (5s→60s capped) and 30s keepalive pings
- **Fallback HTTP polling** — When WebSocket is unavailable, the IPFS provider automatically polls for IPNS changes at a configurable interval (default: 90s)
- **Auto-sync on import** — `Sphere.import()` automatically syncs with all registered token storage providers after initialization to recover tokens from IPFS
- **Debounced auto-sync on remote updates** — `PaymentsModule` subscribes to `storage:remote-updated` events from token storage providers and performs a debounced (500ms) sync, emitting a new `sync:remote-update` sphere event
- **`storage:remote-updated` storage event type** — New event emitted by `IpfsStorageProvider` when a remote IPNS change is detected via WebSocket push or HTTP polling
- **`sync:remote-update` sphere event** — New top-level event with `{ providerId, name, sequence, cid, added, removed }` payload, emitted after a push-triggered sync completes
- **WebSocket factory injection in platform factories** — `createNodeIpfsStorageProvider()` and `createBrowserIpfsStorageProvider()` now automatically inject platform-appropriate WebSocket factories
- **`IpfsHttpClient.getGateways()`** — New public accessor returning configured gateway URLs
- **`IpfsStorageConfig` extensions** — New optional fields: `createWebSocket`, `wsUrl`, `fallbackPollIntervalMs`, `syncDebounceMs`
- **`IpnsUpdateEvent` type** — Exported from `impl/shared/ipfs` for consumers
- **24 unit tests** for `IpnsSubscriptionClient` covering subscribe, message handling, reconnection, keepalive, fallback polling, and disconnect

### Fixed
- **IPFS token recovery via TXF merge** — `mergeTxfData()` now recognizes individual token entries (`token-*` keys) stored via `saveToken()`, not just `_`-prefixed TXF keys; previously IPFS sync returned `added: 0` because merge couldn't find tokens in the blob
- **TXF parser handles individual file format** — `parseTxfStorageData()` now extracts tokens from `{ token, meta }` wrapper format used by IPFS individual token storage
- **Sync coalescing** — `PaymentsModule.sync()` now coalesces concurrent calls, preventing race conditions when multiple syncs overlap

### Changed
- All `throw new Error()` in production code replaced with `throw new SphereError()` — zero plain errors remaining
- All `console.log/warn/error` in production code replaced with `logger.debug/warn/error` — console output controlled by debug flag
- `logger.warn()` and `logger.error()` are always shown regardless of debug flag; `logger.debug()` is hidden when `debug=false`
- `PaymentsModule.updateTokenStorageProviders()` now re-subscribes to storage events when providers change
- `PaymentsModule.destroy()` now cleans up storage event subscriptions and debounce timers
- `IpfsStorageProvider.shutdown()` now disconnects the subscription client

[Unreleased]: https://github.com/unicitynetwork/sphere-sdk/compare/main...HEAD
