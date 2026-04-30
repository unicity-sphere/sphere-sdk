# UXF Inter-Wallet Transfer — T.8.D Production Cutover Runbook

> Task: **T.8.D** — Production cutover: remove legacy single-coin TXF code paths;
> per-feature flag becomes vestigial.
> Status: shipped on `feature/uxf-packaging-format`.
> Audience: release operators, on-call, integrators of `@unicitylabs/sphere-sdk`.

## Overview

T.8.D is the **final** PR in the 12-wave UXF inter-wallet transfer rollout. Once
it merges:

- The legacy single-coin TXF send fast path is **deleted** — every conservative
  send goes through the UXF orchestrator (T.4.A / T.5.A).
- The per-feature flag matrix becomes **vestigial** — defaults flip to the
  `'uxf'` shape and the dispatcher fork is unconditional. Flags remain wired
  for surgical per-flag revert; new code MUST NOT branch on them.
- `tools/restore-legacy-outbox.ts` is the **only** supported back-out path for
  already-migrated wallets.
- `.github/workflows/external-acks-gate.yml` gates merge on the configured
  external integrator acks (sphere app + openclaw-unicity at PR-prep time;
  see § Pre-cutover checklist for the live list).

Companion to `UXF-TRANSFER-IMPL-PLAN.md` §T.8.D. Assumes Waves T.1–T.8.C are
shipped and T.8.E.{1,2,3} suites are green on `main`.

**Flow:** pre-cutover checklist → external-acks gate → testnet 24h soak →
mainnet staged rollout → 7-day monitoring. If anything misfires:
[§ Back-out](#back-out-procedure).

---

## Pre-cutover checklist

Run this checklist **on the eve of merge**. Every item must be confirmed
before clicking "Squash and merge" on the T.8.D PR.

### Code readiness

- [ ] `git log --oneline main..feature/uxf-packaging-format | wc -l` matches
      the expected wave count (51 plan tasks across 12 waves; ~380+ commits
      counting steelman recursion).
- [ ] T.8.A regression fixture (`tests/regression/uxf-t2d-reference-snapshot.test.ts`)
      passes on the cutover commit. **Any failure here forces a fixture-regen
      ADR per round-4 N1 — DO NOT proceed.**
- [ ] T.8.B capability hint test suite green (`tests/unit/payments/capability-warning.test.ts`).
- [ ] T.8.C error-surface audit suite green
      (`tests/unit/errors/error-surface-audit.test.ts`).
- [ ] T.8.E.1 integration suite green on the deterministic-clock harness
      (`tests/integration/transfer/`). The W29 cross-mode CID 5-min-delay
      test (`§11.2-cross-mode-cid-delivery-5min-delay.test.ts`) MUST pass.
- [ ] T.8.E.2 compatibility suite green (`tests/compatibility/transfer/`).
      This includes the **C7 round-trip test**:
      `tests/integration/profile/legacy-outbox-restore-roundtrip.test.ts`.
      **C7 is a hard merge gate** — if it fails, the back-out path is broken
      and cutover MUST NOT proceed.
- [ ] T.8.E.3 adversarial suite green (`tests/adversarial/transfer/`). C8/C9/C10
      tests covered. Suite runs in < 8 minutes; flake rate < 0.5% over the
      last 5 nightly runs.

### External integrator acks

> **Repo audit at PR-prep time** (after the original plan was written):
> `unicity-sphere/agentsphere` does NOT exist as a real GitHub repo.
> Plan §T.8.D listed it as a 3rd ack target, but the audit found only
> 2 confirmed sphere-sdk consumers in active development. The 3rd ack
> can be added to the workflow's `REPOS` list if/when an `agentsphere`
> repo materializes.

- [ ] [`unicity-sphere/sphere#302`](https://github.com/unicity-sphere/sphere/issues/302)
      — issue with label `uxf-transfer-v1-ack` is **closed**.
      Verifies the wallet UI host widened the `onIntent` callback
      (`schemaVersion` 4th argument) per `CONNECT-HOST-MIGRATION-NOTE.md`.
- [ ] [`unicitynetwork/openclaw-unicity#8`](https://github.com/unicitynetwork/openclaw-unicity/issues/8)
      — issue with label `uxf-transfer-v1-ack` is **closed**. Verifies
      the openclaw-unicity plugin migrated.

Verify with the same command CI uses:

```bash
for repo in unicity-sphere/sphere unicitynetwork/openclaw-unicity; do
  echo "=== $repo ==="
  gh issue list --state closed --search "label:uxf-transfer-v1-ack" --repo "$repo"
done
```

Each repo MUST show **at least one closed issue with the label**. If any list is
empty, the merge is **blocked** by `external-acks-gate.yml` (see
[§ External-acks gate](#external-acks-gate)).

### Operational readiness

- [ ] On-call rotation acknowledged the cutover window. Pager covers the
      24h post-merge soak.
- [ ] Restore script tested in staging:
      `npx tsx tools/restore-legacy-outbox.ts --addr <addr> --profile-path <path> --dry-run`
      against a wallet that ran the T.6.D forward migration in the previous wave.
      Output matches the snapshot under `tests/integration/profile/fixtures/`.
- [ ] Telemetry dashboard live. Counters listed in [§ Soak metrics](#soak-metrics)
      are visible.
- [ ] Rollback PR pre-staged: a draft revert PR for T.8.D exists locally so
      it can be opened in seconds if cutover misfires.

---

## What T.8.D removes

**W33 ADR appendix.** This section is the audit trail for the cutover —
every legacy export, function, type, and config slated for deletion is listed
here. The list is normative: any deletion not enumerated here MUST be moved
to a follow-up PR with its own justification.

### Exports / functions

- `modules/payments/PaymentsModule.ts`:
  - The legacy single-coin conservative-send fast path (the branch reachable
    when `features.senderUxf === false`). After T.8.D, the orchestrator-routed
    path is unconditional; the dispatcher branches only on `transferMode`.
  - Internal helpers `legacySingleCoinSplit()` and `legacyOutboxStub()` —
    callers all migrated under T.7.C.
- `modules/payments/transfer/legacy_outbox.ts`:
  - The legacy outbox decoder (`decodeLegacyOutboxBlob()` and its companion
    `encodeLegacyOutboxBlob()`). Reads were already replaced by per-entry-key
    readers under T.6.A; T.8.D deletes the encoder + decoder pair.
- `modules/accounting/AccountingModule.ts`:
  - The `payInvoiceLegacyFallback()` private path (force-conservative legacy
    coercion, replaced by T.7.D's W21 path).
- `cli/index.ts`:
  - The `forceConservative` legacy-coercion branch around line 2831
    (the `transferMode = forceConservative ? 'conservative' : 'instant'`
    expression remains, but the legacy fall-through guarded by
    `!features.senderUxf` is removed).

### Types

- `types/uxf-outbox.ts`:
  - `LegacyOutboxBlob` (single-blob form). The per-entry shape
    `LegacyOutboxEntry` is **retained** because it is still emitted by the
    backup writer and consumed by `tools/restore-legacy-outbox.ts`.
- `profile/types.ts`:
  - `PROFILE_KEY_MAPPING['invalidTokens']` (the `@deprecated` legacy entry
    flagged with "SHOULD be removed in T.8.D once the migration window
    closes"). The per-entry-key prefix `invalid` replaces it.

### Config / feature flags

- `Sphere.init({ features })` continues to accept the full `UxfTransferFeatures`
  shape **for compatibility** but `validateFeatures()` (T.1.B.1) now rejects
  the V0–V1 configurations (legacy-only and types-widening-only). After
  T.8.D the only valid configurations are V3–V7 (full UXF on both sides;
  outbox in `'dual-write'` or `'uxf'` mode).

### NOT removed in T.8.D (deferred)

The following are explicitly **left in place** by T.8.D and tracked for a
future cleanup PR:

- `tools/restore-legacy-outbox.ts` — kept indefinitely as the back-out path.
- `LegacyOutboxEntry` type — required by the restore tool.
- `${addr}.legacyOutbox.backup` profile entries — operators may delete after
  90 days post-cutover at their discretion (no automated GC).
- `features.outbox === 'dual-write'` — kept for one release after T.8.D so
  wallets mid-migration can complete the transition without flipping straight
  to `'uxf'`.

A follow-up PR `T.9-legacy-outbox-final-removal` is on the roadmap (no committed
date) to delete the restore tool, the `LegacyOutboxEntry` type, and the
`'dual-write'` outbox mode.

---

## Feature flag flips

T.8.D flips the **defaults** of the feature flag matrix. The flags themselves
remain in the type definition for one release (vestigial) so a per-flag revert
is possible without code surgery.

| Flag | Pre-T.8.D default | Post-T.8.D default | Effect |
| --- | --- | --- | --- |
| `features.typesWidening` | `true` | `true` | Type-level only; unchanged. |
| `features.senderUxf` | `false` | **`true`** | Conservative sends route through UXF orchestrator. |
| `features.recipientUxf` | `false` | **`true`** | Inbound bundles ingested via T.5.B/T.5.C workers. |
| `features.recipientLegacyAdapter` | `true` | **`false`** | Legacy-shape adapter (T.7.B) is no longer the primary; legacy senders still work via the four-shape detector but the path is no longer the default. |
| `features.cidDelivery` | `false` | **`true`** | CID-mode delivery becomes default (T.4.A pin path). |
| `features.instantMode` | `false` | **`true`** | Instant-mode workers active. |
| `features.outbox` | `'legacy'` | **`'dual-write'`** | Wallets continue dual-writing for one release; new installs default to `'uxf'`. |
| `features.txfOptIn` | `false` | `false` | Unchanged — TXF mode remains opt-in. |
| `features.defaultModeIsUxf` | `false` (flipped to `true` in T.7.E) | `true` | The default `transferMode` is `'instant'` over UXF. |
| `features.recoveryWorker` | `false` | **`true`** | Sending-recovery worker (Phase 8 steelman) re-publishes stuck `'sending'` entries. |

**`Sphere.init({ features })` semantics.** `validateFeatures()` (T.1.B.1) is
strict-whitelist. Passing any combination outside V3–V7 throws
`INVALID_FEATURE_COMBINATION` at init time. The 8-row valid-combination matrix
in `UXF-TRANSFER-IMPL-PLAN.md` §7.A is unchanged; only the **default** moves
from V1 → V5 (V5 = full UXF on both sides + dual-write outbox).

**Override per-flag.** Operators can pin a specific flag to `false` in
`Sphere.init({ features })` for a single wallet. This is the **per-flag
surgical rollback** path (W42). Example, to disable the recovery worker on a
problem wallet without reverting cutover:

```typescript
Sphere.init({
  ...providers,
  features: { recoveryWorker: false },  // others use new defaults
});
```

Override is **deprecated for `senderUxf` / `recipientUxf`** — passing `false`
for either now throws because the legacy paths are deleted.

---

## Rollout

T.8.D rolls out in three phases. Each phase has a hard pause-point with
explicit go/no-go criteria.

### Phase 1 — Testnet (24h soak)

1. Merge T.8.D PR to `main`. CI publishes `@unicitylabs/sphere-sdk` to a
   pre-release tag (e.g., `0.7.0-rc.1`).
2. Deploy the pre-release tag to **testnet wallets only** (CI nightly
   integration env + the canary testnet wallet).
3. Run the 24h smoke battery:
   - 5-token conservative send + receive between two testnet wallets.
   - Chain-mode 3-hop send (A → B → C → D before any aggregator round-trip)
     per `tests/integration/transfer/chain-mode-3-hop.test.ts`.
   - Multi-asset send: UCT + USDU + 1 NFT in one bundle per
     `tests/integration/transfer/multi-coin-additional-assets.test.ts`.
   - CID-mode send forced via `delivery: { kind: 'force-cid' }` per
     `tests/integration/transfer/forced-cid-tiny.test.ts`.
4. **Go/no-go review** at T+24h. Required green metrics:
   - `transfer:bundle-published` > 0 and `transfer:fetch-failed` = 0.
   - `transfer:security-alert` = 0.
   - `transfer:capability-warning` = 0 (no legacy peers warned because all
     external integrators have ack'd).
   - C7 round-trip test re-run on testnet wallet: green.
5. If green: tag `@unicitylabs/sphere-sdk` `0.7.0` and proceed to Phase 2.
6. If red: see [§ Back-out procedure](#back-out-procedure).

### Phase 2 — Mainnet (staged)

Deploy in three slices:

1. **5% of mainnet wallets** (canary cohort). Soak 4h. Watch metrics.
2. **50% of mainnet wallets** (broad cohort). Soak 4h. Watch metrics.
3. **100% of mainnet wallets**.

The slicing is enforced at the SDK consumer (sphere app, agentsphere)
release-channel level — the SDK itself does not slice.

### Phase 3 — 7-day post-cutover monitoring

After 100% rollout, the on-call runs the [§ Soak metrics](#soak-metrics)
dashboard daily for 7 days. Any threshold breach triggers an investigation;
two consecutive breaches trigger back-out.

---

## Soak metrics

Watch these counters via the `sphere.on()` event surface during rollout. All
events are documented in `UXF-TRANSFER-IMPL-PLAN.md` §7.E.

### Volume / health (expect non-zero)

| Event | Healthy range | Action on anomaly |
| --- | --- | --- |
| `transfer:bundle-published` | matches send call rate | If `0` despite send calls, sender path broken — investigate. |
| `transfer:bundle-received` | tracks published rate (modulo network latency) | Wide gap → recipient ingest broken or transport issue. |
| `transfer:confirmed` | matches `bundle-published` within 60s p99 | Lag → finalization-worker queue depth issue. |

### Error rates (expect rare)

| Event | Healthy threshold | Action on breach |
| --- | --- | --- |
| `transfer:fetch-failed` | < 0.1% of sends | Investigate IPFS gateway health; bundle CID fetch path failing. |
| `transfer:trustbase-warning` | < 0.5% of sends; debounced via T.5.F | Sustained → aggregator trust-base staleness; coordinate with aggregator team. |
| `transfer:security-alert` | **0** in steady state | **Immediate page** — §6.3 forbidden two-different-values path or suspect aggregator. |
| `transfer:cascade-failed` | rare, tied to upstream parent failures | Investigate per-tokenId `splitParent` chain (coin path) or per-recipient outbox (NFT path). |
| `transfer:cascade-risk-warning` | informational | None — sender-side warning only. |
| `transfer:capability-warning` | low post-cutover (every legacy peer's ack closed the issue) | Sustained > 1% → external integrator regressed. Ping their on-call. |
| `transfer:override-applied` | rare, audit-trail only | Verify `overrideAppliedBy` matches an authorized operator. |

### Queue depth / saturation

| Metric | Source | Healthy | Investigate at |
| --- | --- | --- | --- |
| Ingest queue depth | `transfer:ingest-queue-full` count | low | sustained > 5/min → recipient pool overloaded; consider raising `MAX_INGEST_WORKERS` |
| Per-token ingest backpressure | `transfer:ingest-queue-full-per-token` count | rare bursts | sustained → adversarial peer or hot tokenId; investigate sender |
| OrbitDB write fairness queue | `OrbitDbWriteFairness.getMetrics()` (`waitQueueDepth / inflightCount`) | `waitQueueDepth / 8 < 0.5` | sustained > 0.5 for 30s → ADR-005 revisit criteria triggered (cap may need tuning) |
| Sending-recovery worker | `INGEST_QUEUE_FULL` counter (recovery-side) + per-entry retry count | retries < 3/entry typical | repeated `failed-transient` transitions → investigate stuck entries |

---

## Back-out procedure

T.8.D back-out is **two-step**: revert the PR, then restore migrated wallets.

### Step 1 — Revert the T.8.D PR

```bash
git revert <T.8.D-merge-sha>
git push origin main
```

This restores the legacy code paths. Set `features.senderUxf=false` and
`features.recipientUxf=false` on affected wallets to re-enable the
dispatcher fork's legacy branch. The reverted SDK version flows through
the normal release channel.

### Step 2 — Restore migrated wallets (if needed)

T.6.D's outbox migration is **one-way** at the data level. Wallets that
already migrated to the per-entry-key outbox have their legacy entries on
disk only as a backup snapshot at `${addr}.legacyOutbox.backup`. After PR
revert, these wallets boot with legacy code that does NOT see the new
per-entry-key entries — they appear empty.

Run `tools/restore-legacy-outbox.ts` per affected wallet:

```bash
# Dry-run first (mandatory — never run live without classifying entries)
npx tsx tools/restore-legacy-outbox.ts \
  --addr <addressId> \
  --profile-path <path-to-orbitdb-store> \
  [--encryption-key <hex64>] \
  --dry-run

# If the dry-run output looks correct, run live (no --dry-run)
npx tsx tools/restore-legacy-outbox.ts \
  --addr <addressId> \
  --profile-path <path-to-orbitdb-store> \
  [--encryption-key <hex64>]
```

**Flags:**

| Flag | Meaning |
| --- | --- |
| `--addr <addressId>` | **Required.** The `${addr}` prefix used in the migration (e.g., `DIRECT_aabbcc_ddeeff`). |
| `--profile-path <path>` | **Required.** Path to the wallet's OrbitDB store directory. |
| `--encryption-key <hex64>` | Optional. AES-256 key (64 hex chars) for encrypted profiles. The script uses the same key to RE-encrypt restored values. |
| `--dry-run` | Read + classify entries; do not write. Exits 0. **Always run first.** |
| `--clear-sentinel` | Also delete `${addr}.legacyOutbox.migrated`, allowing the migration to re-run on next boot. **Recommended only when fully rewinding.** Default: keep the sentinel. |
| `--quiet` | Print JSON result only. |

**Idempotency.** Re-running the restore on the same wallet is a no-op for
already-restored entries. The script classifies each entry as
`would-restore | already-restored | mismatch` and surfaces the counts in
the result JSON.

**Sentinel handling.** By default the migration sentinel
(`${addr}.legacyOutbox.migrated`) is **NOT cleared**. This is intentional:
restore is a recovery action and the operator presumably wants the
migration to NOT re-run on the next boot (otherwise the restore is
immediately undone). Pass `--clear-sentinel` only when fully rewinding to
pre-migration state and re-allowing the migration.

**Round-trip property (C7).** The restore script's correctness is gated by
`tests/integration/profile/legacy-outbox-restore-roundtrip.test.ts`. The
test plants legacy entries → migrates → restores → asserts byte-identity.
This test is a **hard merge gate** for T.8.D — if the round-trip fails,
the back-out path is unsound and cutover MUST NOT ship.

**"Byte-identical" definition.** Excludes Lamport stamps, `observedAt`
timestamps, `_schemaVersion`, and sentinel keys. See
`UXF-TRANSFER-IMPL-PLAN.md` §8 item 14 for the explicit field-list.

### Step 3 — Verify and close the incident

After revert + restore:

- Re-run the restore script with `--dry-run` on each affected wallet — output
  should show `would-restore: 0, already-restored: N, mismatched: 0`.
- Confirm `transfer:*` event volumes return to pre-cutover baseline.
- Open a postmortem issue; tag with the `uxf-transfer-rollback` label so
  follow-up cleanup PRs can reference it.

---

## Known limitations

These are post-cutover items the user explicitly chose to ship as v1
limitations rather than defer cutover. Each is tracked in the source for
visibility.

### Semaphore released around `sleep` (intentional for backpressure)

The finalization-worker base (`modules/payments/transfer/finalization-worker-base.ts`)
holds the per-aggregator + per-token semaphore across the FULL poll loop —
including the `sleep()` call between poll attempts. The worker does NOT
release the permit during sleep.

**Why:** releasing across sleep would let a stampede of waiting workers
flood the aggregator the moment the first sleeping worker yields. Holding
the permit through sleep provides backpressure: the aggregator sees at most
N concurrent pollers per token regardless of contention.

**Limitation:** under sustained slow-aggregator response times, throughput
is bounded by `MAX_AGG_PERMITS / poll_loop_duration` rather than by the
worker count. Operators can raise `MAX_AGG_PERMITS` per aggregator if the
soak metrics show poll-bound saturation.

This is **not a bug** — it's the correct backpressure choice per Phase 6
review. Do NOT "fix" it without an ADR.

### Restore script is one-shot per wallet

`tools/restore-legacy-outbox.ts` operates on a single wallet at a time.
Multi-wallet bulk restore is out of scope; operators script the loop
themselves (one `npx tsx tools/restore-legacy-outbox.ts` invocation per
`addressId`).

### Per-process semaphore registry

The per-aggregator semaphore registry in `modules/payments/transfer/aggregator-semaphores.ts`
is per-process. Multi-process wallets sharing one OrbitDB store are out of
scope for v1.0 (same scope decision as ADR-005).

### Profile encryption key handling on restore

`--encryption-key` accepts the AES-256 key as a hex string on the CLI.
JS strings cannot be zeroized, so the key leaks to GC for the script's
lifetime. Acceptable for a one-shot recovery script; do **not** wrap the
restore in a long-running daemon. Spawn a fresh process per wallet.

---

## External-acks gate

T.8.D depends on a non-code gate: three external integrator repos must
close their `uxf-transfer-v1-ack`-labeled tracking issues before merge.

### CI mechanism

`.github/workflows/external-acks-gate.yml` runs as a **required check** on
the T.8.D PR. The workflow uses `gh` to query each repo:

```bash
gh issue list \
  --state closed \
  --search "label:uxf-transfer-v1-ack" \
  --repo unicity-sphere/sphere
# (and same for unicitynetwork/openclaw-unicity)
```

If any query returns an empty list, the workflow **fails** and the PR
cannot be merged. The check re-runs on PR sync, so closing the upstream
issue automatically unblocks merge.

### Tracking issues

| Repo | Issue | Label | Purpose |
| --- | --- | --- | --- |
| [`unicity-sphere/sphere`](https://github.com/unicity-sphere/sphere/issues/302) | #302 | `uxf-transfer-v1-ack` | Wallet UI host widened `onIntent` callback (`schemaVersion` 4th arg). |
| [`unicitynetwork/openclaw-unicity`](https://github.com/unicitynetwork/openclaw-unicity/issues/8) | #8 | `uxf-transfer-v1-ack` | OpenClaw plugin migrated. |

> Plan §T.8.D listed `unicity-sphere/agentsphere` as a 3rd ack target,
> but at PR-prep time that repo doesn't exist yet. If/when it lands,
> append it to the workflow's `REPOS` list and add a row here.

### Pre-merge verification

Run the same query locally before opening T.8.D for review (see the
[§ Pre-cutover checklist](#pre-cutover-checklist) script). Each repo MUST
report at least one closed issue. If any reports zero, the T.8.D PR
description SHOULD note "blocked on `<repo>` ack" and the on-call should
escalate to the upstream maintainer.

### Reference

- `CONNECT-HOST-MIGRATION-NOTE.md` — describes the `schemaVersion` widening
  that the three integrators ack'd.
- `UXF-TRANSFER-IMPL-PLAN.md` §T.7.C.5 — the documentation task that
  triggered the external coordination.
- `UXF-TRANSFER-IMPL-PLAN.md` §8 item 10 — open-question entry that
  formalized the gate.

---

## Tracking issues

Phase 8 deferred-item tracking issues. Most were addressed in Phase 8 itself;
the only remaining item at cutover time is the semaphore-released-around-sleep
design choice, which is **intentional** and documented as a known limitation
above.

| Issue | Status at cutover | Notes |
| --- | --- | --- |
| Semaphore released across sleep | **deferred → known limitation** | Kept for backpressure per user direction (Phase 6 review). See [§ Known limitations](#known-limitations). |
| W26 cross-restart deadline anchor | **shipped** | Persistence + per-aggregator process-global semaphore in commit `e163e94`. |
| W41 / T.5.F two-strike trustBase staleness | **shipped** | Two-strike + sibling-worker race protection in commit `041379f` / `7fe5de9`. |
| Phase 7 steelman recursion fixes | **shipped** | 11 hardening fixes + 3 follow-on recursion fixes in commits `3c621d7` / `6597ff6`. |
| Profile token-storage god-object refactor | **shipped** | Split into 4 sub-modules (facade-preserved) in commit `cd5a871`. |
| Manifest-store mergeManifestEntry symmetric rootHash fallback | **shipped** | Commit `0448e26`. |
| T.5.D per-tokenId mutex in `importInclusionProof` | **shipped** | Commit `4ba4129`. |
| Finalization-worker shared §6.1 cycle driver extraction | **shipped** | Commits `2a6abfd` / `69726cf` (Option B functional extraction). |

If any of these regress during the 7-day post-cutover window, file a
follow-up issue with label `uxf-transfer-v1-postmortem` and link the
relevant commit SHA above.

---

## Emergency contacts

| Role | Contact | When to page |
| --- | --- | --- |
| Cutover lead | _to be filled by ops_ | Cutover go/no-go decisions; back-out approval. |
| SDK on-call | _to be filled by ops_ | `transfer:security-alert` events; sustained `transfer:fetch-failed` > 1%; restore-script failures. |
| Aggregator on-call | _to be filled by ops_ | `transfer:trustbase-warning` sustained; aggregator hard-rejection traffic. |
| External integrator (agentsphere) | _to be filled by ops_ | `onIntent` regressions; `schemaVersion` detection mismatches. |
| External integrator (sphere app) | _to be filled by ops_ | Wallet UI confirmation flow regressions. |

---

## See also

- `docs/uxf/UXF-TRANSFER-PROTOCOL.md` — canonical protocol spec.
- `docs/uxf/UXF-TRANSFER-IMPL-PLAN.md` — 12-wave implementation plan (T.1–T.8).
- `docs/uxf/CONNECT-HOST-MIGRATION-NOTE.md` — `schemaVersion` widening migration note.
- `docs/uxf/ADR-005-orbitdb-write-fairness.md` — write-fairness cap and queue ADR.
- `tools/restore-legacy-outbox.ts` — back-out script (T.6.D.2).
- `.github/workflows/external-acks-gate.yml` — CI gate enforcing the three external acks.
- `tests/integration/profile/legacy-outbox-restore-roundtrip.test.ts` — C7 round-trip gate.
- `tests/regression/uxf-t2d-reference-snapshot.test.ts` — T.8.A wire-format regression fixture.
