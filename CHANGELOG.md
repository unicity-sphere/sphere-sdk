# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Removed
- **BREAKING:** Removed the entire L1 (ALPHA blockchain) layer — `sphere.payments.l1`, the `L1` namespace, `L1Config`, `identity.l1Address`, the `sphere_l1GetBalance` / `sphere_l1GetHistory` Connect queries, the `l1_send` intent, and the `l1:read` / `l1:transfer` permission scopes. Wallets are now L3-only.

### Fixed — history disappears on reload (#549)

- **History reload (#549, the HISTORY twin of #521):** in the wallet-api
  composition `PaymentsModule.loadHistory()` read from the local token storage
  provider's `getHistoryEntries()`, but the thin `WalletApiTokenStorageProvider`
  keeps no history — so a reloaded instance (tab refresh) fell into an empty KV
  fallback and rendered an empty transaction history, even though every send /
  receive POSTs the record to the server's §10 log. `loadHistory()` now rebuilds
  `_historyCache` from `walletApi.listHistory()` (newest-first keyset pages until
  `more:false`, deduped by `dedupKey`) whenever the `walletApi` client is
  present; the S6 `memo` / `counterpartyNametag` envelopes are decrypted with the
  owner's own field key on read-back (§8.3). Compositions without `walletApi`
  keep the legacy local path. The `PaymentsWalletApiPort` gains a `listHistory`
  member (the READ side of the §10 client-written log). Regression: send→reload
  (SENT record, memo decrypted) and receive→reload (RECEIVED record, sender
  nametag + memo decrypted) against the fake backend, asserting the in-session
  and post-reload sets match (no loss, no dupes).

### Fixed — reload renders an empty wallet (#521)

- **Thin-provider reload (#521):** `WalletApiTokenStorageProvider` persisted
  its inventory cursor durably while the item view lived only in process
  memory, so a reloaded instance (tab refresh) delta-synced from the warm
  cursor into an empty view and rendered an empty wallet. The first sync of
  each instance/identity session is now always a full pull (both `load()`
  entry paths and the lazy-view merge benefit); deltas resume within the
  session.

### Fixed — incident 2026-06-12 hardening (#515, #516)

- **Fail-closed composition invariant (#515 F1):** wallet-api CUSTODY
  artifacts (the thin `WalletApiTokenStorageProvider`, delivery custody
  `'inventory'`) composed without the `walletApi` client now throw
  `INVALID_CONFIG` at `PaymentsModule.initialize`/`Sphere.init` instead of
  silently running local-custody semantics. `TokenStorageProvider` gains an
  optional `requiresWalletApi` marker. `Sphere.init` now forwards the
  `delivery`, `walletApi` and `communications` options to
  `Sphere.create`/`Sphere.load` — previously they were silently dropped.
- **Checked SaveResult (#515 F2):** `PaymentsModule` now checks
  `SaveResult.success` of the ACTIVE custody provider. User-facing flows
  (mint, the send pipeline's custody writes) fail loudly (`STORAGE_ERROR`);
  background saves emit the new `storage:degraded` event.
- **Surfaced wallet-api session state (#515 F3):** a failed sign-in is
  recorded (readable via `sphere.walletApiSessionStatus`) and emitted as the
  new `walletapi:session` event (`'offline'`/`'online'`); boot stays
  non-blocking.
- **Double-pay hazard (#516):** `WalletApiClient.abortIntent` flips the LOCAL
  intent copy to `'aborted'` even when the server abort cannot land (dead
  backend); the unlanded abort is replayed by `resyncOpenIntents`
  (PUT + abort), so a send that failed at `putIntent` can never be re-executed
  by `resumeOpenIntents` after reconnect.

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
- **Delivery port + mailbox + composition (wallet-api program, sdk-changes S2-consumer/S3/S4/S7)** —
  - **`DeliveryProvider` port** (`transport/delivery-provider.ts`, exported from the root barrel): `deliver(recipientPubkey, blob, { transferId, memo? }) → { deliveryId }` (idempotent per (token, state)), `incoming(sinceCursor?)` AsyncIterable of `{ deliveryId, transferId?, senderPubkey?, memo?, fetchBlob(), cursor }` (+ optional `onWake` hook), `ack(deliveryId, 'claimed' | 'rejected')`. `deliveryId` is CONTENT-DERIVED — `hex(SHA-256(tokenId bytes ‖ stateHash bytes))`, the backend's entry_id formula (`computeDeliveryId`/`deliveryKeysFromBlob` helpers) — never a server row id. Custody (`'inventory' | 'external'`) is a composition-time constructor property, never a per-call flag; implementations keep a persistent (tokenId, stateHash) seen-set as the recipient-side replay guard.
  - **`WalletApiMailboxProvider`** (impl/shared, the S3 reference implementation): deliver = sha256 + upload-urls upload (412 = already present = success) → idempotent `POST /v1/mailbox` with the entryId verified content-derived; memos S6-encrypted before they leave the device (decrypted on incoming when the wallet key matches); incoming = `GET /v1/mailbox?since=` paging with pending-only filtering, `blobCollected` handling and byte-level re-verification of fetched blobs; ack = claim with the provider's custody (`'external'` always sends `intoInventory:false`) or reject (terminal for discovery only).
  - **`WalletApiClient` mailbox + history endpoints**: `depositMailbox`, `listMailbox`, `claimMailbox`, `rejectMailbox`, `postHistoryRecords`, `listHistory` (§6/§10/§16; decimal-string amounts, S6 envelopes verbatim).
  - **PaymentsModule rewiring (S2 consumer + S3)**: balances/coin-selection read the storage port's `listInventory()` view as LAZY records (zero blob downloads; `Token.lazy`); the send path runs awaited `putIntent` (E.3) → `getToken()` only for the SELECTED sources → engine transfer/split seeded by ONE per-send `transferId` → journaled `deliver()` through the delivery port (the `transport.sendTokenTransfer` V2_TRANSFER leg is gone; without a composed port a `TransportDeliveryAdapter` preserves the relay path through the same seam) → one `applyDelta` carrying the send's transferId (inventory-custody compositions) → `completeIntent` (uniform E.3 close) → dedupKey'd `POST /v1/history` with S6-encrypted memo/nametag. The `PENDING_V2_DELIVERIES` journal + replay-on-load now point at the port (the journal records the recipient's CHAIN pubkey). Incoming deliveries feed the existing transport-agnostic `handleV2Transfer` from `incoming()` (poll + wake + one-shot `receive()`); local-verification failures `ack('rejected')` and surface as the new **`transfer:invalid`** event. New public `resumeOpenIntents()` re-runs open intents deterministically (conflicts abort per E.2). SpendQueue/TokenReservationLedger and the Nostr DM/group-chat/nametag paths are untouched.
  - **S4 composition** (impl/shared/wallet-api): `createSphereProviders(base, { storage, delivery, engine })` selects each port independently; `createWalletApiProviders` = the full preset (thin storage + mailbox custody `'inventory'`); `createOwnStorageWalletApiProviders` = delivery-only (app storage keeps custody; mailbox custody `'external'` baked in). `Sphere.init`/`create`/`load`/`import` accept `delivery` + `walletApi`; the auth lifecycle is wired (sign-in on unlock, logout on account switch, open-intent resume at sign-in).
  - **S7 delivery contract suite** (`tests/contract/delivery-provider.contract.ts`) run against `WalletApiMailboxProvider` in both custody modes, plus fake-server §6/§16 mailbox semantics (deposit idempotency incl. recipient/key-mismatch 409, caps 429, claim handoff/alreadyClaimed/upgrade/failed bucket, reject-stays-claimable, read pointer, blobCollected) and §10 history.
- **Payment requests ride wallet-api (wallet-api program, sdk-changes S4 — backend M4)** —
  - **`WalletApiClient` payment-request endpoints** (§10/§16): `createPaymentRequest` (payer auto-provisioned; per-payer open cap → 429; `expiresAt` sent ISO-8601), role-aware `listPaymentRequests` — incoming = the payer's gap-free `?since=<seq>` stream (bigint cursor, the standard §16 since contract), outgoing = the requester's newest-first `?before=<opaque keyset>` backfill (string|null cursor); the two cursor families are unrepresentable to mix client-side — and `respondPaymentRequest` (`{action:'paid', transferId}` required pair / `{action:'declined'}` forbids it; addressee-only 403, open-only 409). Amounts decimal strings ⇄ `bigint`; the memo is the S6 `enc1.` envelope verbatim (encrypt before calling — it decrypts only under the requester's wallet key).
  - **PaymentsModule path selection (covenant §3.1-6)**: when the composed `walletApi` port carries the payment-request capability (the S4 presets), `sendPaymentRequest`/reject/pay flow through the §16 endpoints with the memo S6-encrypted client-side, and the Nostr payment-request subscriptions are NOT installed; without it the transport path is untouched. Incoming requests are discovered by polling the `?since=` seq stream (new public `syncPaymentRequests()`; cursor persisted per network+identity like the mailbox cursor; `syncEpoch` change → re-pull from 0 with id-dedup; a restarted module recovers still-open requests via a `status=open` bootstrap scan) and surfaced through the existing handler/event surface. `payPaymentRequest` links the fulfilling send via `respond(action:'paid', transferId)`; `rejectPaymentRequest` maps to `action:'declined'` and is server-confirmed BEFORE the local flip (403/409 propagate); `acceptPaymentRequest` stays a local UI state (the backend models open → paid|declined|expired only). Outgoing responses fold in from the `?before=` backfill (requester sees paid/declined/expired; `waitForPaymentResponse` resolves).
  - **Fake backend M4 contract** (`tests/support/fake-wallet-api.ts`): per-payer gap-free seq + payer auto-provisioning, role views with the real wire shapes (seq/cursor/syncEpoch as JSON numbers, per `src/payments/service.ts`), role × cursor mixing → 422 `VALIDATION_FAILED`, respond semantics 403/404/409/422, per-payer open cap → 429 `QUOTA_EXCEEDED`, `expireDuePaymentRequests()` server-owned-expiry hook.
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
