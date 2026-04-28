# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **UXF Inter-Wallet Transfer Protocol — spec-level changes** (implementation lands in subsequent waves; see `docs/uxf/UXF-TRANSFER-PROTOCOL.md`):
  - **Multi-asset send** — `TransferRequest.additionalAssets?: AdditionalAsset[]` discriminated union (`{kind:'coin', coinId, amount} | {kind:'nft', tokenId}`) enables multi-coin and mixed coin+NFT transfers in a single `payments.send()` call. Per-kind validation: distinct coinIds incl. primary; distinct NFT tokenIds; coin amounts > 0. Forward-compat: receivers reject unrecognized `kind` with `UNKNOWN_ASSET_KIND`. See UXF-TRANSFER-PROTOCOL §4.1 and `docs/INTEGRATION.md`.
  - **Canonical NFT model** — NFT = token with empty/null `coinData` (after zero-amount pruning); coin = non-empty. Class-disjoint at the protocol level. NFT transfers are whole-token (no split, `tokenId` preserved). Coin tokens cannot satisfy NFT targets even on tokenId match → `INSUFFICIENT_BALANCE` reason='nft-not-owned'. See UXF-TRANSFER-PROTOCOL §4.1.
  - **Chain mode opt-in** — `TransferRequest.allowPendingTokens?: boolean` (default `false`). When `true`, the source-token selector may spill over to `pending` tokens after exhausting `valid` ones. Strict ordering: finalized-first, then pending-by-age. See UXF-TRANSFER-PROTOCOL §2.3 + §2.5.
  - **`confirmNftPending` flag** — required `true` when `allowPendingTokens: true` AND any NFT target's source has unfinalized predecessor txs. Prevents accidental cascade of irrecoverable NFT identity (`NFT_PENDING_REQUIRES_CONFIRMATION` rejection without it). See UXF-TRANSFER-PROTOCOL §4.1 cascade-asymmetry warning.
  - **Identity-binding capability hints** — optional `wireProtocols: string[]` and `assetKinds: string[]` for forward-compat. Informational only — receivers still apply the strict `UNKNOWN_ASSET_KIND` reject rule. See UXF-TRANSFER-PROTOCOL §10.4.
  - **Bundle ingest concurrency** — recipient runs a `MAX_INGEST_WORKERS = 16` default worker pool with a bounded ingest queue. DoS defense against rogue long-running bundles. Per-tokenId mutex coordinates cross-bundle conflicts. See UXF-TRANSFER-PROTOCOL §5.0.
  - **`_audit` collection** — NEW (Wave T.3). Multi-representation aware: keyed by `${addr}.audit.${tokenId}.${observedTokenContentHash}`. Stores `NOT_OUR_CURRENT_STATE` and `UNSPENDABLE_BY_US` dispositions distinct from cryptographically broken tokens (which stay in `_invalid`, also widened to multi-representation key). See UXF-TRANSFER-PROTOCOL §5.4.
  - **Periodic rescans** — two orthogonal scanners promoted to in-scope (design summary): profile-pointer rescan (default 30s, detects sibling-instance updates) and per-token spent-state rescan (default 5 min/token, detects off-record spends). See UXF-TRANSFER-PROTOCOL §12.3.
  - **Transfer error model** — canonical against `@unicitylabs/state-transition-sdk`: `REQUEST_ID_MISMATCH` at submit = double-spend signal; sustained `PATH_NOT_INCLUDED` past `POLLING_WINDOW` (default 30 min) = oracle rejected; `PATH_INVALID` / `NOT_AUTHENTICATED` retry up to `MAX_PROOF_ERROR_RETRIES`. Threat model: aggregator faulty-not-hostile; explicit threat boundary in §9.4.1.
  - **Most-recent-proof rule** — same `requestId` + same value can have multiple valid proofs across BFT rounds; canonicalize by latest BFT round (supersedes the considered-and-rejected lex-min-CID rule for proofs; lex-min `bundleCid` still governs divergent-chain tie-breaks per UXF-TRANSFER-PROTOCOL §5.3 [D-conflict]). Two proofs for same `requestId` with different values → `transfer:security-alert` (single-spend violation; out-of-scope hostile path). See UXF-TRANSFER-PROTOCOL §6.3.
  - **Outbox CRDT invariants** — three-tier state partition (active / soft-terminal / hard-terminal); Lamport clock with `max(local, observed)+1` rule; `overrideApplied` sticky flag for operator-import override stickiness; two-set `commitmentRequestIds` (outstanding + completed) preventing finalized-then-re-added re-submission. See UXF-TRANSFER-PROTOCOL §7.1.
  - **Operator escape hatches** — `payments.importInclusionProof(tokenId, proofBytes, {allowInvalidOverride?})` with 9-case enumeration; `revalidateCascadedChildren(parentTokenId)` (transitive). See UXF-TRANSFER-PROTOCOL §6.3 + §6.1.1.
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
