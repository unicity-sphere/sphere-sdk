# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **IPNS push-based sync via WebSocket** — `IpnsSubscriptionClient` connects to `/ws/ipns` on IPFS gateways for real-time IPNS update notifications, with exponential backoff reconnection (5s→60s capped) and 30s keepalive pings
- **Fallback HTTP polling** — When WebSocket is unavailable, the IPFS provider automatically polls for IPNS changes at a configurable interval (default: 90s)
- **Auto-sync on provider registration** — `Sphere.addTokenStorageProvider()` now triggers a fire-and-forget `sync()` when the wallet is already initialized, eliminating manual retry loops
- **Auto-sync on import** — `Sphere.import()` automatically syncs with all registered token storage providers after initialization to recover tokens from IPFS
- **Debounced auto-sync on remote updates** — `PaymentsModule` subscribes to `storage:remote-updated` events from token storage providers and performs a debounced (500ms) sync, emitting a new `sync:remote-update` sphere event
- **`storage:remote-updated` storage event type** — New event emitted by `IpfsStorageProvider` when a remote IPNS change is detected via WebSocket push or HTTP polling
- **`sync:remote-update` sphere event** — New top-level event with `{ providerId, name, sequence, cid, added, removed }` payload, emitted after a push-triggered sync completes
- **WebSocket factory injection in platform factories** — `createNodeIpfsStorageProvider()` and `createBrowserIpfsStorageProvider()` now automatically inject platform-appropriate WebSocket factories
- **`IpfsHttpClient.getGateways()`** — New public accessor returning configured gateway URLs
- **`IpfsStorageConfig` extensions** — New optional fields: `createWebSocket`, `wsUrl`, `fallbackPollIntervalMs`, `syncDebounceMs`
- **`IpnsUpdateEvent` type** — Exported from `impl/shared/ipfs` for consumers
- **24 unit tests** for `IpnsSubscriptionClient` covering subscribe, message handling, reconnection, keepalive, fallback polling, and disconnect

### Changed
- `PaymentsModule.updateTokenStorageProviders()` now re-subscribes to storage events when providers change
- `PaymentsModule.destroy()` now cleans up storage event subscriptions and debounce timers
- `IpfsStorageProvider.shutdown()` now disconnects the subscription client

[Unreleased]: https://github.com/unicitynetwork/sphere-sdk/compare/main...HEAD
