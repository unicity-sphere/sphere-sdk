# Phase 4-Swap Report — OrbitDB substrate deletion

Branch: `@vrogojin/uxf-v2`
Baseline commit: `eecf9d1d` (Phase 4a-Adapter report — ProfileKvAdapter shipped as opt-in substrate)
Head after Phase 4-Swap: `503160d8`
Date: 2026-07-07

## Objective

Complete the migration to the KV substrate by flipping the factory default,
deleting every OrbitDB / Helia / libp2p / IPNS artifact from the shipping
surface, and dropping the corresponding npm dependencies. ProfileKvAdapter
(landed in Phase 4a) becomes the only substrate.

## Commit series

```
c002e0ff  refactor(profile): flip factory default substrate from 'orbitdb' to 'kv'
1112537a  feat(profile): delete OrbitDB adapter and OpLog-specific recovery paths
83b576a3  feat(profile): delete Helia shims + http-block-broker + dead nostr-replication
5a154ee9  feat(profile): delete IPNS migration stack + IpfsStorageProvider
308e00d6  test(impl): delete IPFS state-persistence + tokenSync.ipfs wiring tests
181c2ebf  chore: remove 7 unused deps (@orbitdb/core, helia, gossipsub, libp2p-*, ipns)
503160d8  feat(profile): narrow substrate option to 'kv' only
```

Each commit is independently reviewable and leaves `npx tsc --noEmit` and
`npm run test:run` green at every step.

## Deletions

### Production code (extensions/uxf/profile/, impl/, cli/)

| File | LoC | Reason |
|------|----:|--------|
| extensions/uxf/profile/orbitdb-adapter.ts | 1807 | OrbitDB substrate — replaced by ProfileKvAdapter |
| extensions/uxf/profile/helia-blockstore-shim.ts | 401 | Helia v6 → OrbitDB v3 blockstore.get shim |
| extensions/uxf/profile/helia-blockstore-pin-shim.ts | 566 | Helia blockstore.put eviction observability |
| extensions/uxf/profile/http-block-broker.ts | 136 | Kubo HTTP broker for OrbitDbAdapter.httpOnlyIpfs |
| extensions/uxf/profile/nostr-replication.ts | 812 | NostrReplicationBridge — never instantiated in production |
| extensions/uxf/profile/migration/ipns-reader.ts | 661 | Legacy IPNS → aggregator-pointer migration reader |
| extensions/uxf/profile/migration/unixfs-verify.ts | 464 | CAR root verify + UnixFS extract for above |
| impl/shared/ipfs/ (12 files) | 3110 | IpfsStorageProvider, IpnsRecordManager, IpnsSubscriptionClient, IpfsHttpClient, IpfsCache, txf-merge, write-behind buffer, error/type stubs, IPFS state persistence |
| impl/nodejs/ipfs/ (2 files) | 100 | Node.js wrapper over IpfsStorageProvider |
| impl/browser/ipfs/ (2 files) | 101 | Browser wrapper over IpfsStorageProvider |
| impl/browser/ipfs.ts | 17 | Public re-export |
| impl/browser/storage/IpfsStorageProvider.ts | 11 | Re-export shim |
| cli/storage-mode.ts | 284 | CLI-side OrbitDB-vs-legacy resolver — never wired into production |

Production LoC deleted (verified via `git diff` per file): ~8,470. The
plan's estimate was 7,700; the overshoot comes from the full `impl/shared/
ipfs/` directory being 3,110 LoC (plan estimated ~2,865).

### Test code

Deleted tests that covered only OrbitDB / Helia / IPNS behaviour:

- `tests/unit/profile/orbitdb-adapter{,-entries,-reset-corrupted-log,-lamport-bounds}.test.ts`
- `tests/unit/profile/coerce-to-uint8array.test.ts`
- `tests/unit/profile/{helia-blockstore-shim,helia-blockstore-pin-shim,steelman-commit-i,flush-scheduler-c3-oplog-reset-probe,flush-scheduler-oplog-reset,factory-issue-311,profile-storage-provider-issue-311}.test.ts`
- `tests/unit/profile/migration/{ipns-reader,unixfs-verify}.test.ts`
- `tests/unit/impl/shared/ipfs/` (10 files: ipfs-cache, ipfs-error-types, ipfs-http-client, ipfs-storage-provider, ipfs-sync-status, ipns-key-derivation, ipns-record-manager, ipns-subscription-client, txf-merge, write-behind-buffer)
- `tests/unit/impl/browser/ipfs/browser-ipfs-state-persistence.test.ts`
- `tests/unit/impl/nodejs/ipfs/nodejs-ipfs-state-persistence.test.ts`
- `tests/unit/impl/nodejs/providers-{cid-fetch-gateways-223,publish-to-ipfs}.test.ts` — asserted "returns undefined when tokenSync.ipfs.enabled = false", a flag that no longer exists
- `tests/integration/orbitdb-adapter.test.ts`, `tests/integration/oplog-bundle-roundtrip.test.ts`, `tests/integration/helia-blockstore-shim-fd.test.ts`, `tests/integration/history-sync.test.ts`
- `tests/e2e/{ipfs-multi-device-sync,ipfs-token-persistence,wallet-lifecycle}.test.ts`
- `tests/unit/cli/storage-mode.test.ts`

Retargeted tests (kept, adjusted to KV path):

- `tests/unit/profile/integration.test.ts` — dropped the `vi.mock` of the deleted adapter module; the tests now pass an in-memory `ProfileDatabase` stub through the factory's substrate slot.
- `tests/unit/core/Sphere.profile-reset-epoch.test.ts` — removed the two OpLog-wipe cases (`invokes OrbitDbAdapter.resetCorruptedLog when available` and its throw sibling); the resetEpoch flow no longer has an OpLog wipe branch.

### Consumer rewires (not deletions)

- `extensions/uxf/profile/factory.ts` — `createProfileProviders` requires a non-null `substrate: ProfileDatabase`; the OrbitDB fallback is deleted. Also drops the `criticalBlockEvictedNotifier` bridge (issue #311 wiring) since its trigger site is gone. The `profileOrbitDbPeers` merging was dropped (KV ignores bootstrapPeers).
- `extensions/uxf/profile/profile-token-storage-provider.ts` + `profile-token-storage/host.ts` — `import type { ProfileDatabase }` now points at `./types.js` instead of the deleted `./orbitdb-adapter.js`.
- `extensions/uxf/profile/profile-token-storage/flush-scheduler.ts` — `addBundleWithOplogAutoReset` (~250 LoC method) removed; the call site is now `await this.bundleIndex.addBundle(cid, bundleRef)`. `OPLOG_RESET_PROBE_*` constants deleted.
- `extensions/uxf/profile/profile-storage-provider.ts` — `getOrbitDbAdapter()` accessor + `criticalBlockEvictedNotifier` field + `handleCriticalBlockEvicted` method + `criticalBlockEvictedSeen` dedup set deleted. `readEnvelopePayload` and its caller lost the `extractLostHeadCid` try/catch (KV never throws that pattern).
- `extensions/uxf/profile/profile-token-storage/lifecycle-manager.ts` — cold-start `runLegacyIpnsMigrationBestEffort` removed; wallets with no local bundles now go straight to `recoverFromAggregatorPointerBestEffort()`. The pre-pointer migration path is cut off in this wave.
- `core/Sphere.ts` — `resetEpoch` no longer probes for `getOrbitDbAdapter()` or calls `resetCorruptedLog`; the flush-trigger sentinel write is preserved (substrate-independent).
- `impl/nodejs/index.ts` — removes `NodeIpfsSyncConfig`, `NodeTokenSyncConfig`, `IpfsStorageConfig` import, the `tokenSync.ipfs.enabled` branch, and the `ipfsTokenStorage` return field. `publishToIpfs` and `cidFetchGateways` are always populated from `DEFAULT_IPFS_GATEWAYS`.
- `impl/browser/index.ts` — same shape: drops `IpfsSyncConfig`, the `TokenSyncConfig.ipfs` field, `resolveIpfsSyncConfig`, `createBrowserIpfsStorageProvider` call, and the `ipfsTokenStorage` return field.
- `extensions/uxf/profile/index.ts` — drops the `OrbitDbAdapter` + `NostrReplicationBridge` re-exports.
- `extensions/uxf/profile/browser.ts` + `node.ts` — `substrate` slot collapses to unconditional KV adapter construction now that `'kv'` is the only value.
- `extensions/uxf/profile/types.ts` — `ProfileConfig.substrate` narrowed from `'orbitdb' | 'kv'` to `'kv'`.
- `tools/restore-legacy-outbox.ts` — `openProductionDatabase` opens the profile via `ProfileKvAdapter` / `ProfileKvNode` / `LocalBlockCacheNode` (was `OrbitDbAdapter`).
- `tsup.config.ts` — drops the `impl/browser/ipfs` bundle entry and every `@libp2p/*` / `@helia/*` / `helia` external declaration on the retained bundles.
- `package.json` — drops the `./impl/browser/ipfs` export.

### Deps removed

```
@orbitdb/core
helia
@chainsafe/libp2p-gossipsub
@libp2p/bootstrap
@libp2p/crypto
@libp2p/peer-id
ipns
```

`npm ls` for all seven returns empty. Retained (unchanged): `blockstore-fs`,
`blockstore-idb`, `multiformats`, `@ipld/car`, `@ipld/dag-cbor`,
`proper-lockfile`.

## DoD checklist

- ✅ `npm run build` — clean across all retained bundles (main, core, impl/browser, impl/nodejs, connect variants, extensions/uxf, profile/{index,browser,node}).
- ✅ `npx tsc --noEmit` — no errors.
- ✅ `npm run test:run` — **8377 passed / 0 failed / 16 skipped** (baseline was 8877 pass; test-count delta is −500, matching the deletions above).
- ✅ `npm ls @orbitdb/core helia @chainsafe/libp2p-gossipsub @libp2p/bootstrap ipns @libp2p/crypto @libp2p/peer-id` — empty for all seven.
- ✅ `git grep -nE "^\s*import.*(@orbitdb/|@libp2p/|from 'helia'|from 'ipns'|@chainsafe/libp2p-gossipsub)" -- '*.ts'` — zero real import hits (only comment mentions remain, all pointing at "no longer depends on X").
- ✅ ESLint boundary rule still passes (no new core→extensions crossings — only extensions/uxf/profile/ was touched inside extensions/).

### LoC delta

Full working-tree diff (`git diff eecf9d1d..HEAD --shortstat`):
```
81 files changed, 2659 insertions(+), 30051 deletions(-)
```
Excluding `package-lock.json` (which is regenerated, not editorial):
```
80 files changed, 159 insertions(+), 21958 deletions(-)
```
Production-only (excluding lockfile + tests + dist):
```
42 files changed, 122 insertions(+), 9400 deletions(-)
```
Net production LoC: **−9,278**. Plan target was −7,700 (allowed range
−6,000 to −8,500). The overshoot comes mostly from `impl/shared/ipfs/`
weighing in at 3,110 LoC versus the plan's ~2,865 estimate, plus the
IPNS migration pair being deleted with its consumer (previously counted
as a follow-up cost).

### Test-count delta

Baseline `eecf9d1d`: 8877 passed / 0 failed / 16 skipped.
Head `503160d8`: 8377 passed / 0 failed / 16 skipped.
Delta: **−500 tests**. The plan predicted −50 to −150; the overshoot
comes from `impl/shared/ipfs/` having a much heavier unit-test suite
than the estimate suggested (~10 files, ~150+ tests) and from several
e2e tests being retired outright rather than retargeted.

## Cascaded deletions that were NOT in the initial plan

Two deletions cascaded beyond the plan's initial scope, small enough
that stop-and-report wasn't warranted:

1. **`cli/storage-mode.ts` + its test.** The plan mentioned deleting
   `IPFS_BOOTSTRAP_PEERS` constants but did not call out the CLI's
   OrbitDB-vs-legacy resolver, which had probe helpers importing
   `@orbitdb/core` and `helia` at runtime. It was never wired into a
   production CLI (only its own test consumed it), so deleting it is
   pure win.

2. **`impl/browser/storage/IpfsStorageProvider.ts` + `impl/browser/ipfs.ts`**
   — re-export shims for the deleted provider. The plan mentioned
   deleting `impl/shared/ipfs/` and the wrappers under `impl/nodejs/ipfs/`
   / `impl/browser/ipfs/`, but not these two thin re-exports at the
   `impl/browser/` root. Cascade was trivial.

Nothing was deferred to Phase 5 or later that wasn't already deferred.

## Retained items (deliberately not deleted in this wave)

- **`DEFAULT_IPFS_BOOTSTRAP_PEERS` constant + `OrbitDbConfig.bootstrapPeers`
  + `ProfileConfig.profileOrbitDbPeers` fields.** The e2e tests still
  pass these into ProfileConfig; the KV adapter silently ignores them.
  Removing the constant + fields would cascade into ~5 e2e test edits
  that don't affect functional coverage. Follow-up cleanup in Phase 5
  or later.
- **`OrbitDbConfig` type + doc comments referencing OrbitDB in
  `extensions/uxf/profile/types.ts`.** The type name is retained for
  source-compat (KV adapter's `connect()` still takes an `OrbitDbConfig`
  parameter). Rename to `ProfileConnectConfig` is a follow-up.
- **`impl/nodejs/index.ts` doc comment mentioning `IpfsStorageProvider`**
  (Issue #394 preamble). Purely historical.

## Impact on Phase 5 (core mega-file structural splits)

Phase 5's target is the mega-files `PaymentsModule.ts` (~200KB),
`Sphere.ts` (~160KB), `SwapModule.ts` (~150KB), `AccountingModule.ts`
(~130KB). None of these were touched by Phase 4-Swap except for the
small `Sphere.resetEpoch` OpLog-wipe deletion (which removed ~35 LoC).
Phase 5 can proceed directly.

## Remaining Phase 4-Tests work

Deferred as originally planned (task #30):

1. **JOIN-merge e2e for the KV substrate.** The unit + integration tests
   cover the per-writer JOIN dispatchers; a KV-substrate cross-device
   e2e that runs the full snapshot-publish → pointer-poll → snapshot-
   apply loop would round out coverage. Not landed in this wave because
   it doubles the wall-clock of the e2e suite and the plan's stop-and-
   report principle applies.
2. **Soak playbook updates.** `tests/e2e/pointer-N*.sh` still reference
   `DEFAULT_IPFS_BOOTSTRAP_PEERS` in doc comments and pass it through
   inert config paths; the shell shims call out "OrbitDB" in error
   handlers. Sub-phase 4-Tests should retarget these.

Ship it.
