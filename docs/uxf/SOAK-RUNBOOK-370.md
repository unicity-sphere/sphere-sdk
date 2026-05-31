# Issue #370 — A/B Soak Runbook

CAR-batched `/dag/import` + `/dag/export` vs the legacy per-block `/dag/put` + `block/get` pattern. Validates the wall-clock and throttling deltas claimed in [#370](https://github.com/unicity-sphere/sphere-sdk/issues/370).

## Prerequisite — Part 1 of #370 must be done

The operator gateway `unicity-ipfs1.dyndns.org` (and any sibling gateways the SDK fans-out to) **must expose** `/api/v0/dag/import` and `/api/v0/dag/export` at the haproxy/nginx ACL layer. Until that change is live, the SDK's capability probe correctly detects "not exposed" and falls through to the legacy per-block path — meaning both A and B runs end up taking the same code path and no delta will appear.

Confirm Part 1 is live before running:

```bash
curl -sS -o /dev/null -w "import=%{http_code}\n" -X POST "https://unicity-ipfs1.dyndns.org/api/v0/dag/import"
curl -sS -o /dev/null -w "export=%{http_code}\n" -X POST "https://unicity-ipfs1.dyndns.org/api/v0/dag/export"
```

- **Both must return 400** (healthy Kubo on empty body). Anything else (`404`, `405`, `5xx`) means Part 1 is not done.
- The matching `/api/v0/dag/put` probe should also return `400` (sanity-check that the gateway is healthy in general).

## A/B method

Two soak runs against the **same** gateway, **same** kubo container, **same** wallet workload, with only the SDK build varying. Both runs use `SPHERE_PERF=1` to dump counters every 5s.

### Run A (baseline — legacy per-block path)

Build from `main` (no issue-#370 code). Even if Part 1 is live, this run only knows `/dag/put` + `/block/get`.

```bash
git checkout main
git pull
npm ci
npm run build

# Soak driver
SPHERE_PERF=1 SPHERE_DEBUG=perf=info bash .tmp/soak-264.sh 2>&1 | tee /tmp/soak-370-run-A.log
```

### Run B (with #370 fast path)

Build from `perf/issue-370-car-batching-import-export` (or after PR #371 merges, from `main`).

```bash
git checkout perf/issue-370-car-batching-import-export
git pull
npm ci
npm run build

SPHERE_PERF=1 SPHERE_DEBUG=perf=info bash .tmp/soak-264.sh 2>&1 | tee /tmp/soak-370-run-B.log
```

## Counters to compare

The `core/perf-counters.ts` module dumps a snapshot every `SPHERE_PERF_DUMP_MS` (default 5000) via `logger.info('perf', …)`. Post-process the run logs with the same approach used in `#363`.

### Public-surface counters (both runs measure them; A/B compares directly)

| Counter | Meaning | Expected A → B |
|---|---|---|
| `ipfs.pinCar.calls` | Pin operations | unchanged |
| `ipfs.pinCar.totalMs` | Whole-selector pin wall-clock (sum / count = per-call) | **drops 5–10×** |
| `ipfs.pinCar.bytes` | Total bytes pinned | unchanged |
| `ipfs.pinCar.error` | Pin failures | unchanged or lower (fewer throttling failures) |
| `ipfs.fetchCar.calls` | Fetch operations | unchanged |
| `ipfs.fetchCar.totalMs` | Whole-selector fetch wall-clock | **drops 5–10×** |
| `ipfs.fetchCar.bytes` | Total bytes fetched | unchanged |

### Path-attribution counters (B-only)

| Counter | Meaning |
|---|---|
| `ipfs.pinCar.fastPath` | Pins that took the `/dag/import` path |
| `ipfs.pinCar.legacyPath` | Pins that fell through to per-block `/dag/put` |
| `ipfs.fetchCar.fastPath` | Fetches that took the `/dag/export` path |
| `ipfs.fetchCar.legacyPath` | Fetches that fell through to per-block BFS |
| `ipfs.fetchCar.localHeliaPath` | Fetches served entirely from local Helia (zero HTTP) |
| `ipfs.fetchCar.rawCodec` | Raw-codec backcompat short-circuit (legacy pinned bundles) |

When Part 1 is live and stable: expect `fastPath` ≈ 100% of `(fastPath + legacyPath)` on both pin and fetch sides. Any `legacyPath` count points at a transient gateway issue worth a manual look.

### Fast-path-only counters (B-only)

| Counter | Meaning | Expected |
|---|---|---|
| `ipfs.dagImport.calls` | Successful `/dag/import` POSTs | ≈ `ipfs.pinCar.fastPath` |
| `ipfs.dagImport.totalMs` | `/dag/import` wall-clock (sum / count = per-call) | small (one HTTP round-trip per CAR) |
| `ipfs.dagImport.bytes` | Bytes sent via `/dag/import` | ≈ `ipfs.pinCar.bytes` (on fast path) |
| `ipfs.dagImport.error` | Fast-path failures that triggered fallback | low |
| `ipfs.dagExport.*` | Mirrored counters for fetch fast path | analogous |

### Legacy-path-only counters (both runs)

| Counter | Meaning |
|---|---|
| `ipfs.pinCar.legacy.totalMs` / `legacy.blocks` / `legacy.bytes` / `legacy.error` | Per-block `/dag/put` work attribution |
| `ipfs.fetchCar.legacy.totalMs` / `legacy.blocks` / `legacy.bytes` | Per-block BFS work attribution |

On Run B: `legacy.*` counters drop to near-zero (only fires on transient fast-path fallback).
On Run A: `legacy.*` ≈ `ipfs.{pinCar,fetchCar}.*` (every call takes the legacy path).

### Capability-probe counters (B-only)

| Counter | Meaning | Expected |
|---|---|---|
| `ipfs.probe.calls` | Total selector → probe invocations | matches pin + fetch call count |
| `ipfs.probe.cacheHits` | Probe satisfied from the per-process cache | ≈ `calls - gateway_count` |
| `ipfs.probe.dagImportOk` / `dagImportMissing` | Per-gateway probe outcome | `Ok` count == number of capable gateways |
| `ipfs.probe.dagExportOk` / `dagExportMissing` | Per-gateway probe outcome | analogous |
| `ipfs.probe.totalMs` | Probe wall-clock (per fresh gateway) | < 2000 (the `PROBE_TIMEOUT_MS`) |

## Pass criteria

1. **Wall-clock**: `ipfs.pinCar.totalMs` per-call (sum / `ipfs.pinCar.calls`) drops by **at least 5×** in B vs A. Same for `ipfs.fetchCar.totalMs`.
2. **Path attribution**: `ipfs.pinCar.fastPath / (fastPath + legacyPath) >= 0.95` in B (≥95% of pins took the fast path).
3. **Throttling**: `ipfs.pinCar.error` (and the operator-side kubo `MAX_PINS_PER_SECOND` overflow logs) drops to **zero** in B during the §D.1 pre-clear snapshot burst that motivated the change.
4. **No regression on local-Helia path**: `ipfs.fetchCar.localHeliaPath` count and `ipfs.fetchCar.legacy.totalMs` for those calls match A (the local-helia short-circuit still bypasses HTTP entirely).
5. **Probe cost is amortized**: `ipfs.probe.totalMs` divided by `ipfs.probe.calls` shows a near-zero average (probe runs once per gateway then every subsequent call is a cache hit).

## Fail-soft criteria

- If `ipfs.pinCar.fastPath / (fastPath + legacyPath) < 0.5` in B: investigate which gateway's probe is failing. The fast path silently falls through on any probe miss or per-call failure — no test failures will surface, only the perf delta missing.
- If `ipfs.dagImport.error` is non-zero: a capable gateway is rejecting our `/dag/import` posts mid-flight. Check the gateway's error log; common causes are CAR-size limit, malformed CAR, or per-IP rate limit hit at the proxy layer.
- If `ipfs.fetchCar.legacy.totalMs` doesn't drop ≈ to zero in B but `fetchCar.totalMs` does: the local-Helia short-circuit or raw-codec backcompat is taking a larger share of the workload than expected. That's actually a win (zero-HTTP fast-path), confirm via `localHeliaPath` and `rawCodec` counts.

## Notes

- Perf-counters are opt-in (`SPHERE_PERF=1`). When off, every counter call is a single boolean check + early return — zero overhead in production builds.
- Counter snapshots accumulate across the whole process lifetime. A/B comparison divides by the matching `.calls` counter to get per-call averages.
- The `core/perf-counters.ts` foundation was introduced in commit `c5962f0` (#363); existing IPFS instrumentation lives in `pinCarBlocksToIpfs`, `fetchFromIpfs`, and `fetchCarFromIpfs`. Issue #370 added the `dagImport.*`, `dagExport.*`, `probe.*`, and path-split counters and moved the `pinCar.*` / `fetchCar.*` public counters to the selector level so they measure whole-call wall-clock regardless of which internal path served the request.
