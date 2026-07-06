# uxf-v2 — Phase 4 sub-phase 4-Adapter report (checkpoint)

Date: 2026-07-07. Branch: `@vrogojin/uxf-v2`. Head: `395ff3aa`.

Sub-phase 4-Adapter lands the OrbitDB-free substrate skeleton (`ProfileKv*` +
`LocalBlockCache*` + `ProfileKvAdapter`) as an **opt-in path** alongside the
still-default OrbitDB stack. Nothing OrbitDB-related has been deleted; the
default consumer experience is unchanged. The KV path is exercisable via
`ProfileConfig.substrate: 'kv'` and covered by a 54-test conformance suite.

Sub-phase 4-Swap (E/F) and 4-Tests (G/H) — the destructive waves (delete
OrbitDB / Helia / libp2p / IPNS stack, remove 7 npm deps, retarget legacy
OrbitDB tests, add JOIN-merge e2e) — are deferred to follow-up sessions.

Companion documents:
- Feasibility investigation: `docs/uxf/uxfv2-substrate-alternatives.md`
- Full execution plan: `scratchpad/uxfv2-execution-plan-v2.md`

---

## 0. TL;DR

- **Landed** on `@vrogojin/uxf-v2`, 5 commits, all pushed
- **Net delta** (`git diff 2fe11555..HEAD --stat | tail -1`): **+2,407
  insertions / −60 deletions across 22 files** — this is a pure-addition
  wave; deletions land in sub-phase 4-Swap
- **Build**: green (`npm run build`)
- **Typecheck**: green (`npx tsc --noEmit` returns 0)
- **Unit test suite**: **8877 pass / 0 fail / 16 skipped** (baseline was
  8823/0/16 — added exactly 54 new KV conformance tests, 0 regressions)
- **Deps**: no changes (removal is sub-phase 4-Swap)
- **Default consumer path**: unchanged (opt-in)
- **Phase 5 (core mega-file structural splits)** can proceed — this
  checkpoint is a stable base

---

## 1. Commits

Chronological, on `@vrogojin/uxf-v2`:

| SHA | Subject |
|-----|---------|
| `d2c3b799` | `feat(profile/kv): ProfileKv (Node + browser) + LocalBlockCache substrate skeleton` |
| `667862df` | `feat(profile/kv): ProfileKvAdapter — byte-stable ProfileDatabase impl` |
| `1deb0dae` | `feat(profile): opt-in KV substrate wiring (substrate: 'kv')` |
| `0553920a` | `refactor(profile): rename orbitdb-write-fairness → kv-write-fairness` |
| `395ff3aa` | `test(profile/kv): conformance suite for ProfileKv* + Adapter (+54 tests)` |

Every commit is pushed and standalone-green (build + typecheck + tests
pass at each SHA).

---

## 2. Files added

New directory `extensions/uxf/profile/kv/` — 6 source files:

| File | LoC | Purpose |
|------|----:|---------|
| `profile-kv-node.ts` | 382 | Node file-per-key backend: fsync + atomic-rename, in-memory key index rebuilt from a manifest sidecar, prefix scan by iteration |
| `profile-kv-browser.ts` | 302 | Browser IndexedDB backend: one object store, prefix scan via key-range cursor (O(matched)) |
| `local-block-cache-node.ts` | 145 | Thin `{ get, put, has }` facade over `blockstore-fs`; matches ipfs-client's `HeliaLike` structural shape; exports `concatChunks` helper |
| `local-block-cache-browser.ts` | 96 | Same facade over `blockstore-idb` |
| `profile-kv-adapter.ts` | 462 | `ProfileDatabase`-implementing class; envelope IO with security-tag downgrade; `emitMergeApplied()`; `getHelia()` exposes the block cache |
| `index.ts` | 35 | Barrel |

Also added:
- `extensions/uxf/profile/errors.ts` — 5 new `PROFILE_KV_*` error codes
- `extensions/uxf/profile/types.ts` — `ProfileConfig.substrate?: 'orbitdb' | 'kv'`

Renamed (Commit E-lite):
- `extensions/uxf/profile/orbitdb-write-fairness.ts` →
  `extensions/uxf/profile/kv-write-fairness.ts`
- `OrbitDbWriteFairness` → `KvWriteFairness`
- `MAX_CONCURRENT_ORBITDB_WRITES` → `MAX_CONCURRENT_KV_WRITES`
- Same for the matching test file

New tests (`tests/unit/profile/kv/`):

| File | Tests | LoC |
|------|------:|----:|
| `profile-kv-node.test.ts` | 20 | 330 |
| `profile-kv-browser.test.ts` | 14 | 172 |
| `profile-kv-adapter.test.ts` | 20 | 331 |

Total conformance suite: **54 tests, 833 LoC** — within team-lead's
800–1200 LoC scope.

---

## 3. The `substrate` option — how the two paths coexist

```typescript
interface ProfileConfig {
  readonly substrate?: 'orbitdb' | 'kv';   // NEW; default 'orbitdb'
  readonly orbitDb: OrbitDbConfig;
  // ...
}
```

`createProfileProviders(config, cacheStorage, oracle?, substrateOverride?)`
gained an optional fourth parameter — a pre-built `ProfileDatabase`. The
platform-specific factories (`profile/node.ts`, `profile/browser.ts`)
construct a `ProfileKvAdapter` and inject it when the caller passes
`substrate: 'kv'`:

- **Node** (`createNodeProfileProviders`):
  ```
  {dataDir}/orbitdb/kv-<shortname>/        # KV files
  {dataDir}/orbitdb/kv-<shortname>/blocks/ # blockstore-fs
  ```
- **Browser** (`createBrowserProfileProviders`):
  ```
  IDB db "sphere-profile-kv-<shortname>"        # KV
  IDB db "sphere-profile-kv-blocks-<shortname>" # blockstore-idb
  ```

The 16-hex `<shortname>` is derived from the wallet's private key by
`deriveProfileDbNameShort()` — byte-stable with `OrbitDbAdapter`'s
`derivePublicKeyShort()` so cross-device opens on the same seed land
on the same directory / IDB name.

The KV backends are constructed **lazily at `adapter.connect()` time**
via `backendFactory: (shortName) => ProfileKvBackend` closures, so the
factories don't need to know the shortname at factory-call time (it's
derived from an OrbitDbConfig passed to `connect()`).

`substrate: 'orbitdb'` (or omitted) → no change; `new OrbitDbAdapter()`
as before.

---

## 4. What sub-phase 4-Swap (deferred) will do

Once the KV path has been soak-validated by flipping test wallets to
`substrate: 'kv'`, sub-phase 4-Swap does the destructive cutover:

1. Flip the wallet-factory default `substrate` to `'kv'` (or drop the
   flag entirely and make `'kv'` the only path).
2. Delete `extensions/uxf/profile/orbitdb-adapter.ts` (1,807 LoC).
3. Delete Helia shims — `extensions/uxf/profile/helia-blockstore-shim.ts`
   (401 LoC) + `helia-blockstore-pin-shim.ts` (566 LoC).
4. Delete `extensions/uxf/profile/http-block-broker.ts` (136 LoC).
5. Delete `extensions/uxf/profile/nostr-replication.ts` (812 LoC —
   dead code per the substrate report; defined and exported, never
   instantiated).
6. Delete `extensions/uxf/profile/migration/ipns-reader.ts` +
   `unixfs-verify.ts` (~1,125 LoC).
7. Delete `impl/shared/ipfs/` (3,110 LoC — measured, larger than the
   report's ~2,865 estimate) plus its browser `IpfsStorageProvider.ts`.
8. Remove 7 npm dependencies from `package.json`:
   - `@orbitdb/core`, `helia`, `@chainsafe/libp2p-gossipsub`,
     `@libp2p/bootstrap`, `ipns`, `@libp2p/crypto`, `@libp2p/peer-id`
9. Drop `httpOnlyIpfs` / `bootstrapPeers` / `enablePubSub` fields from
   `OrbitDbConfig` (rename type to `ProfileKvConnectConfig`).
10. Update `Sphere.clear()` — no more OrbitDB / Helia IndexedDB
    databases to hunt (one KV directory / IDB name per profile).

Estimated 4-Swap size: **~ −7,700 LoC** (matches the report §6 target).

---

## 5. What sub-phase 4-Tests (deferred) will do

1. Retarget or delete the OrbitDB-only tests:
   - `tests/integration/orbitdb-adapter.test.ts`
   - `tests/unit/profile/orbitdb-adapter.test.ts`
   - `tests/unit/profile/orbitdb-adapter-entries.test.ts`
   - `tests/unit/profile/orbitdb-adapter-reset-corrupted-log.test.ts`
   - `tests/integration/helia-blockstore-shim-fd.test.ts`
   - `tests/integration/oplog-bundle-roundtrip.test.ts` — retarget
     to the KV path
   - `tests/integration/profile/concurrent-replica-outbox.test.ts` —
     retarget to KV path
   - `tests/e2e/pointer-roundtrip.test.ts` — retarget
   - `tests/e2e/ipfs-multi-device-sync.test.ts` — retarget or delete
   - `tests/e2e/ipfs-token-persistence.test.ts` — retarget or delete
   - `tests/e2e/wallet-lifecycle.test.ts` — audit
   - All `tests/unit/impl/shared/ipfs/*.test.ts` — delete (legacy IPNS
     stack goes away)
2. Add a JOIN-merge e2e that drives two `substrate: 'kv'` wallets
   through the aggregator-pointer + CAR + JOIN flow (this is the
   cross-device sync test the substrate report §4 highlights).
3. Update soak playbooks (`manual-test-*.sh`) to opt into
   `substrate: 'kv'` and re-baseline.

---

## 6. Numbers vs. the Phase 4 execution-plan DoD

| DoD line | Full Phase 4 target | 4-Adapter (this checkpoint) | Status |
|---|---|---|---|
| Build green (`npm run build`) | ✅ | ✅ | ✅ |
| Typecheck green (`npx tsc --noEmit` = 0) | ✅ | ✅ | ✅ |
| Test suite pass rate ≥ 100% | 8823/0/16 floor | **8877/0/16** (+54 KV) | ✅ |
| Net LoC | `−6,000 ± 500` | **+2,407 / −60** (adder wave; deletes in 4-Swap) | 🕓 deferred |
| 7 deps removed | ✅ | 0 (deferred to 4-Swap) | 🕓 deferred |
| ESLint core→extensions boundary | ✅ | ✅ | ✅ |
| No OrbitDB/Helia/libp2p prod hits | ✅ | not yet (still the default) | 🕓 deferred |

The full Phase-4 DoD splits cleanly across the three sub-phases:

- **4-Adapter (this checkpoint, DONE)** — additive; ProfileKv path
  fully implemented, wired opt-in, conformance-tested.
- **4-Swap (next session, TODO)** — destructive; flip default, delete
  OrbitDB stack, remove 7 deps.
- **4-Tests (session after next, TODO)** — retarget legacy tests, add
  JOIN-merge e2e, update soak playbooks.

Each sub-phase is independently green-and-shippable — the tree at
`395ff3aa` is a stable checkpoint the next session builds on cleanly.

---

## 7. Surprises / scope deviations

None. The `blockstore-fs` / `blockstore-idb` v4 `get()` returning an
`AsyncGenerator<Uint8Array>` (rather than a plain `Uint8Array`) was
newly-discovered mid-implementation — resolved cleanly by a shared
`concatChunks()` helper in `local-block-cache-node.ts` that materializes
the generator into a single `Uint8Array` matching `ipfs-client.ts`'s
`HeliaLike` shape.

`impl/shared/ipfs/` measured at **3,110 LoC** rather than the substrate
report's ~2,865 estimate — 8% larger surface for 4-Swap to remove.

---

## 8. Follow-ups tracked in memory

The following memory records document context for future sessions:
- `project_uxf` — Universal eXchange Format context
- `project_pointer_layer_status` — SPEC §14.1 wave status (unchanged)
- `feedback_vrogojin_uxf_branch_workflow` — always target `@vrogojin/uxf-v2`, never `main`

New follow-up item to track (see §4/§5 above): sub-phase 4-Swap /
4-Tests execution.
