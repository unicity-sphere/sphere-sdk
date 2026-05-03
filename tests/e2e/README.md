# tests/e2e — Real-network end-to-end tests

This directory contains tests that hit the **live Unicity testnet** (or mainnet, when explicitly opted in). Two kinds of test live here:

- **vitest TypeScript tests** (`*.test.ts`) — exercised by `npm run test:e2e`.
- **shell-script CLI tests** (`*.sh`) — run individually or via `run-all.sh`.

## Infra-probe preflight gate (read this if a test says "SKIP")

Every e2e test is gated on `@unicitylabs/infra-probe` first. The probe runs once at suite start, captures the live state of the four-service Unicity stack (Nostr relay, L3 aggregator, IPFS gateway, L1 Fulcrum, market intent database), and each test decides whether to run based on the services it actually depends on.

**Why:** running e2e tests against degraded infra produces false-negatives — a Nostr publish that hangs because the relay's silent has nothing to do with the SDK code under test, but it consumes 30 s of the timeout budget and reports as a regression. The gate cuts these false-negatives at the source.

**Skip policy** (intentionally conservative — we'd rather run a test that turns out to time out than skip one that would have caught a real regression):

| Probe outcome | Action |
|---|---|
| every required service `healthy` | run the test |
| at least one service `degraded` | warn but still run |
| at least one service `unreachable` / `error` | skip the suite cleanly |

Skipped tests print a clear `[preflight] skipping suite: ...` line so it's never silent.

### Bypassing the gate

```sh
# Bypass the probe entirely — useful when working offline or debugging the probe itself.
E2E_SKIP_PREFLIGHT=1 npm run test:e2e
E2E_SKIP_PREFLIGHT=1 bash tests/e2e/pointer-N1.sh

# Shell-only: opt out of automatic preflight invocation but still allow manual calls.
E2E_NO_AUTO_PREFLIGHT=1 bash tests/e2e/run-all.sh

# Probe a different network.
E2E_NETWORK=mainnet npm run test:e2e

# Tighter probe budget for faster iteration.
E2E_PROBE_TIMEOUT=15000 bash tests/e2e/swap-cli-e2e.sh
```

### Probing only the services your tests need (UXF-friendly)

The default probe checks all five services. If the test you're running doesn't depend on a service (e.g. UXF tests don't depend on Fulcrum or Market), set `E2E_PREFLIGHT_ONLY` to skip that service from the probe entirely. Combined with vitest's path filter, this lets you run a UXF-only dev cycle without paying the probe-timeout cost on services UXF doesn't gate on:

```sh
# UXF dev cycle — probe only what UXF tests need; ignore Fulcrum + Market state.
E2E_PREFLIGHT_ONLY=nostr,aggregator,ipfs RUN_UXF_E2E=1 \
  npm run test:e2e -- tests/e2e/uxf-send-receive.test.ts

# Pointer-roundtrip dev cycle — same idea, narrower set.
E2E_PREFLIGHT_ONLY=nostr,aggregator npm run test:e2e -- tests/e2e/pointer-roundtrip.test.ts

# Same env var works for shell scripts (it's the auto-invoke service list there).
E2E_PREFLIGHT_ONLY=nostr,aggregator bash tests/e2e/swap-cli-e2e.sh
```

Per-suite gates are unaffected — they declare their own required services (see the table below) and remain authoritative for "should this suite run?". Filtering the probe just means a service the suite didn't list is also not probed; if the suite *did* list a service that's filtered out, the gate logs a warning and falls through to running anyway (your filter is your responsibility).

## How the gate is wired

### vitest

- `vitest.e2e.config.ts` references `tests/e2e/preflight.global-setup.ts` as `globalSetup`. This runs ONCE before any test file loads and writes the probe report to `tests/e2e/.preflight-result.json` (gitignored).
- Each `*.test.ts` imports `preflightSkip` from `./lib/preflight` and uses `describe.skipIf(SKIP)` to gate its suite. Required services are declared per-file (e.g. `['nostr', 'aggregator', 'ipfs']`).
- If the probe didn't run (file missing) tests fall through to their existing skip logic — the gate never silently skips.

### Shell scripts

- `preflight-infra.sh` defines a `preflight_infra <services>` function that wraps `npx -y @unicitylabs/infra-probe` and translates the documented exit codes into a skip decision. On `unreachable`, it `exit 0`s the calling script with a clear `SKIP:` line that `run-all.sh` greps as a non-failure.
- `pointer-N0-prologue.sh` (sourced by every `pointer-N*.sh` test) and `e2e-helpers.sh` (sourced by every `0X-swap-*.sh` test) auto-invoke `preflight_infra` on source.
- Standalone scripts (`cli-storage-modes.sh`, `swap-cli-e2e.sh`, `run-all.sh`) call it inline near the top.

## Per-suite required-services table

For reference, this is what each suite declares it needs:

| File | Required services | Notes |
|---|---|---|
| `dm-nip17.test.ts` | nostr | NIP-17 DM only |
| `messaging-e2e.test.ts` | nostr | DM Communications module |
| `wallet-clear.test.ts` | nostr, aggregator | Nametag mint + cleanup |
| `wallet-lifecycle.test.ts` | nostr, aggregator, ipfs | Full lifecycle |
| `ipfs-sync.test.ts` | nostr, ipfs | Storage replication |
| `ipfs-multi-device-sync.test.ts` | nostr, ipfs | Multi-device |
| `ipfs-token-persistence.test.ts` | nostr, aggregator, ipfs | Active tokens |
| `profile-sync.test.ts` | nostr, ipfs | OrbitDB+IPFS profile |
| `profile-multi-device-sync.test.ts` | nostr, ipfs | Profile multi-device |
| `profile-token-persistence.test.ts` | nostr, aggregator, ipfs | Profile active tokens |
| `swap-continuous.test.ts` | nostr, aggregator | Full swap lifecycle (also opt-in via RUN_CONTINUOUS_TESTS) |
| `uxf-send-receive.test.ts` | nostr, aggregator, ipfs | UXF transfer (also opt-in via RUN_UXF_E2E) |
| `pointer-roundtrip.test.ts` | aggregator, nostr | Pointer-layer round-trip |
| `network-health.test.ts` | (none) | Tests SDK's own check; runs unconditionally |

Pointer + swap shell scripts default to `nostr,aggregator,ipfs` and `nostr,aggregator` respectively. Override per-script via `E2E_PREFLIGHT_ONLY`.

## Adding a new test

1. Decide which services your test actually depends on (NOT every service the SDK transitively touches — only the ones whose downtime would invalidate the test's signal).
2. Add the corresponding gate at the top of the file:
   - **vitest**: `import { preflightSkip } from './lib/preflight';` then `const SKIP_INFRA = preflightSkip(['nostr', '...'], 'my-suite-name');` and use `describe.skipIf(SKIP_INFRA)('my suite', ...)`.
   - **shell**: source `pointer-N0-prologue.sh` or `e2e-helpers.sh` and the gate fires automatically. To override services use `E2E_PREFLIGHT_ONLY` before sourcing.
3. Update the per-suite table above.
