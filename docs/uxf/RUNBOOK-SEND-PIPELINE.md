# Operator Runbook — OUTBOX/SEND Pipeline Events

**Audience**: operators and on-call engineers running wallets that emit Sphere SDK events on the send side. Every event in this runbook can fire in normal operation; the runbook describes what each one means, what state the wallet is in when it fires, the diagnostic data to collect, and the recommended actions.

**Scope**: the seven events surfaced by Issue #166 + the OUTBOX-SEND-FOLLOWUPS wave:

- `transfer:orphan-spending-detected`
- `transfer:orphan-recovered`
- `transfer:sent-reconciliation-recovered`
- `transfer:sent-reconciliation-failed`
- `transfer:retention-warning`
- `transfer:retention-republish-rearmed`
- `transfer:retention-republish-skipped`

**See also**:
- [OUTBOX-SEND-FOLLOWUPS.md](./OUTBOX-SEND-FOLLOWUPS.md) — open follow-ups + architecture recap
- [UXF-TRANSFER-PROTOCOL.md](./UXF-TRANSFER-PROTOCOL.md) §7 — outbox state machine
- [PROFILE-ARCHITECTURE.md](./PROFILE-ARCHITECTURE.md) §10.12 — per-entry-key storage

---

## Architecture recap (skip if you know it)

The OUTBOX is a working queue. Each entry tracks a single token-transfer bundle from `'packaging' → 'sending' → 'delivered'`/`'delivered-instant' → ...`. On terminal success, the entry's contents are copied into the **SENT ledger** (the durable historical record) and the OUTBOX entry is **tombstoned** (deleted via marker, not via `db.del()` — so concurrent replicas can't resurrect).

Three background workers maintain the pipeline:

| Worker | Purpose |
|--------|---------|
| `SendingRecoveryWorker` | Republishes entries stuck in `'sending'` past a threshold. |
| `SentReconciliationWorker` | Re-runs SENT-writes that failed at the dispatcher's transition. |
| `NostrPersistenceVerifier` | Detects retention drops on previously-delivered events. Default-OFF. |
| `TombstoneGcWorker` | Reclaims storage by `db.del()`-ing tombstones past a retention window. Default-OFF. |

A sweeper (`detectOrphanSpendingTokens()`) catches tokens marked `'transferring'` locally but never persisted to OUTBOX — the crash window between `commitSources` and `outbox.create`.

CAR bytes are pinned to IPFS by our node. Nostr `TOKEN_TRANSFER` events carry either inline CAR bytes (for small bundles) or just the CID-by-reference. **Bundle bytes are NEVER stored in OUTBOX, SENT, or tombstones — only the CID is retained.**

---

## Event sections

### `transfer:orphan-spending-detected`

**Payload**: `{ tokenId, detectedAt, coinId, amount }`

**What it means.** The orphan-spending sweeper found a token marked `'transferring'` in the local store but absent from both OUTBOX and SENT. This is the signature of a crash between two steps in the send flow:

1. `selectSources` marked the token `'transferring'` and `commitSources` issued the spending commit to the aggregator.
2. The orchestrator's `outbox.create` hook failed to write the OUTBOX entry (process crash, browser tab kill, OrbitDB unavailable, etc.).

The aggregator's view may or may not include the commit. Locally the token is unspendable (`'transferring'`).

**Diagnostic data to collect.**

- The `tokenId` from the payload.
- Recent log lines matching `[Payments] Orphan spending tx detected: token <tokenId>` (these include the last-known `updatedAt` for the token).
- Wallet's `getTokens({ tokenId })` output to see the on-disk state.
- If the aggregator is queryable: `oracle.isSpent(<sourceStateHash>)` answer for the token's pre-commit state.

**Actions.**

1. **If `features.orphanAutoRecovery` is OFF (the default):** the wallet emits this event but takes no action. You can:
   - Manually flip the token's status back to `'confirmed'` via direct profile edit (test environments only).
   - Or: enable `features.orphanAutoRecovery` and restart the wallet — the recovery hook runs aggregator cross-check before restoring (see `transfer:orphan-recovered`).
2. **If aggregator reports the source state SPENT:** the commit landed on-chain. Local restore would diverge from the aggregator's view. You must either re-package the bundle from the post-spend state (out of scope for the auto-recovery hook today) or accept the value as already-sent.
3. **If aggregator reports the source state UNSPENT:** safe to restore. Enabling `features.orphanAutoRecovery` performs this restore automatically; `transfer:orphan-recovered` then fires.

**Forward direction.** A repeated `'orphan-spending-detected'` for the same `tokenId` across many cycles is a stuck state — operator intervention is required.

---

### `transfer:orphan-recovered`

**Payload**: `{ tokenId, coinId, amount, fromStatus, toStatus, strategy, recoveredAt }`

**What it means.** The auto-recovery hook (gated on `features.orphanAutoRecovery`, default-OFF) cross-checked the aggregator and confirmed the source state was UNSPENT, then flipped the token from `'transferring'` back to `toStatus` (today: `'confirmed'`). The value is spendable again.

**State of the system.** Token is back in normal circulation. No OUTBOX or SENT entry is created — the recovery is purely local (the send that originally moved the token to `'transferring'` is treated as if it never happened).

**Diagnostic data.** Generally none required — the event is informational.

**Actions.**

- **None required** in the happy path. Log line `[Payments] Orphan spending tx auto-recovered: token <tokenId>` will be present at DEBUG level.
- **If you see this for a tokenId AND the recipient later reports they got the bundle:** the aggregator cross-check returned UNSPENT but the commit had actually landed via a separate path (rare race during aggregator reconciliation, or aggregator returned a stale view). Re-validate the token via `payments.validate()`; expect an aggregator-side state-mismatch error. Manual reconciliation: re-package or write off.

**Strategy field.** Today only `'restore-to-confirmed'` is implemented. Future strategies (e.g. `'restore-with-recipient-notification'`) extend the union additively.

---

### `transfer:sent-reconciliation-recovered`

**Payload**: `{ outboxId, tokenIds, mode, recoveredAt }`

**What it means.** A SENT-ledger write that was missed at the dispatcher's `delivered`/`delivered-instant` transition (because the SENT writer threw — usually OrbitDB transient unavailability) was successfully retried by the `SentReconciliationWorker`. The OUTBOX entry is now tombstoned; the SENT entry is durable.

**State of the system.** Normal operation has resumed. The forensic OUTBOX entry that was kept live at `'delivered'` for triage has been retired.

**Diagnostic data.** Generally none — the worker logged the retry attempts at WARN level (`[Payments] SentReconciliationWorker: retry succeeded`).

**Actions.**

- **None required.** This is the documented happy path for SENT-write transient failures.
- **If this event fires frequently for many `outboxId`s:** OrbitDB / profile storage is intermittently failing at the dispatcher's transition step. Investigate the underlying storage layer (disk pressure, IPFS gateway latency, peer connectivity for OrbitDB replication).

---

### `transfer:sent-reconciliation-failed`

**Payload**: `{ outboxId, consecutiveFailures, lastError, failedAt }`

**What it means.** The `SentReconciliationWorker` retried a SENT-write `maxRetries` times in a row and gave up. The OUTBOX entry remains live at `'delivered'` (or `'delivered-instant'`) as the forensic record. Auto-retry is suspended for this entry until the wallet restarts (the failure counter is process-local).

**State of the system.** Forensic-record mode. The recipient already has the bundle (the original publish succeeded), but the wallet's permanent SENT-ledger record is incomplete.

**Diagnostic data.**

- The `outboxId` from the payload.
- The `lastError` field — usually the SENT writer's underlying throw message.
- Recent log lines matching `[Payments] SentReconciliationWorker: transition to failed-transient`.
- Profile storage health: is OrbitDB responding? Is the address's per-entry-key prefix readable?

**Actions.**

1. **Inspect `lastError`.**
   - **Disk full / OS-level write error:** free space, then restart the wallet. On restart the reconciliation worker re-arms and will retry; `transfer:sent-reconciliation-recovered` should fire on success.
   - **OrbitDB peer disconnected:** wait for reconnection then restart. Same recovery path.
   - **Profile encryption failure:** check the wallet's master key state. If keys are corrupted, profile data is unrecoverable — escalate.
2. **If the underlying issue is resolved but `transfer:sent-reconciliation-recovered` does NOT fire after restart:** the OUTBOX entry's status may have advanced past `'delivered'` (e.g. recovery worker re-published and got a different ack path). Inspect via direct profile read; if structurally valid, the SENT entry can be written manually via test/escape-hatch APIs.

---

### `transfer:retention-warning`

**Payload**: `{ sentId, nostrEventId, bundleCid, tokenIds, recipientTransportPubkey, detectedAt }`

**What it means.** The `NostrPersistenceVerifier` queried the relay set for a previously-delivered `nostrEventId` and the relay returned "missing" (verified absent). The bundle reached the relay at publish time (we got the ack), but is now gone — retention policy eviction, relay restart, or relay-segregation.

Whether the recipient saw the event before it dropped is **unknown**. They may have it; they may not. This event fires regardless.

**State of the system.** Send is in an uncertain state. The SENT ledger entry is the durable record of the historical delivery; nothing on the wallet side is broken.

**Diagnostic data.**

- The `bundleCid` — verifies the bundle is still pinned (check IPFS).
- The `recipientTransportPubkey` — verifies the recipient is reachable.
- Companion event: a `transfer:retention-republish-rearmed` OR `transfer:retention-republish-skipped` should fire immediately after this one if `outboxProvider` is wired. If it doesn't, the verifier's republish wiring is broken.

**Actions.**

1. **If the wallet wires `outboxProvider` (the default for `Sphere`):** wait for the `republish-rearmed` companion. The `SendingRecoveryWorker` will republish on its next cycle (≤30s).
2. **If `republish-skipped` companion fires with `reason='entry-tombstoned-or-missing'`:** the OUTBOX entry is gone (conservative-mode successful send). Today the worker cannot re-publish; manual recovery is to ask the recipient if they received it. **Future:** the cross-cutting "Re-publish from where?" follow-up will use the IPFS-pinned bundle + the SENT entry's CID to materialize a new OUTBOX entry.
3. **If you see this event for many `sentId`s simultaneously:** the relay set is experiencing retention pressure. Consider widening the relay list or moving to longer-retention relays.

---

### `transfer:retention-republish-rearmed`

**Payload**: `{ sentId, nostrEventId, bundleCid, tokenIds, recipientTransportPubkey, fromStatus, toStatus, rearmedAt }`

**What it means.** Companion to `transfer:retention-warning`. The verifier successfully transitioned the live OUTBOX entry at `sentId` from `fromStatus` (`'delivered'` or `'delivered-instant'`) back to `'sending'`. The `SendingRecoveryWorker` will pick it up on its next cycle and republish.

The original SENT entry is **untouched** — it stays as the historical record of the first delivery. The recipient's replay-LRU dedupes by `bundleCid`, so duplicate publishes are harmless.

**State of the system.** Recovery is in flight. The OUTBOX entry is back at `'sending'`; the worker will republish.

**Diagnostic data.** Generally none.

**Actions.**

- **None required.** Watch for the recovery worker's `[Payments] SendingRecoveryWorker: re-publish ok` log line.
- **If the OUTBOX entry remains at `'sending'` for >5 minutes without a `delivered`/`delivered-instant` transition:** something in the republish path is failing. Inspect via `getOutboxEntries()` and look at the `submitRetryCount` field. After `maxRetries` failures the entry transitions to `'failed-transient'`.

---

### `transfer:retention-republish-skipped`

**Payload**: `{ sentId, nostrEventId, bundleCid, reason, observedStatus?, errorMessage?, detectedAt }`

**What it means.** Companion to `transfer:retention-warning`. The verifier could NOT initiate a re-publish for this `sentId`. The `reason` field explains why.

**Reasons and actions.**

| Reason | What it means | Action |
|--------|---------------|--------|
| `'no-outbox-writer'` | The feature is wired but no `OutboxWriter` is currently installed (legacy wallet, pre-install, or post-destroy). | Confirm the wallet uses the profile-backed storage path. Legacy KV-only wallets cannot use this recovery surface. |
| `'entry-tombstoned-or-missing'` | The SENT-ledger id has no live OUTBOX counterpart. **Common in conservative-mode wallets** where successful SENT writes tombstone the OUTBOX entry. | The IPFS-pinned bundle bytes (referenced by `bundleCid`) ARE available, but the code path to materialize a new OUTBOX entry from the SENT entry has not yet landed. Manual recovery: contact the recipient. Future: see OUTBOX-SEND-FOLLOWUPS "Re-publish from where?". |
| `'wrong-status'` | The OUTBOX entry exists but is at a status other than `'delivered'`/`'delivered-instant'` (e.g. `'finalizing'`, `'expired'`, post-cancellation). | Check `observedStatus` for forensic context. If the entry is in `'finalizing'`, the finalization worker is making progress and this re-publish path is the wrong recovery surface. If `'expired'`, the retention window passed — no recovery is appropriate. |
| `'transition-failed'` | The state-machine update itself threw. | `errorMessage` carries the underlying throw. Most likely an OrbitDB read failure or an unrelated SphereError. Retry on next verifier cycle (the entry's `checkedIds` flag was set so it won't be retried — wallet restart re-arms). |

**Forward direction.** Once the "Re-publish from where?" architectural decision lands (using the IPFS-pinned CAR bytes referenced by `bundleCid`), the `'entry-tombstoned-or-missing'` skip reason will become rare — the verifier will materialize a fresh OUTBOX entry from the SENT record and CID, and re-publish from there.

---

## Cross-cutting troubleshooting

### "I see retention warnings for every SENT entry"

Likely cause: the relay set's retention window is shorter than `verifyDelayMs`. Tune `NostrPersistenceVerifierOptions.verifyDelayMs` upward, or move to longer-retention relays.

### "Orphan-spending detection fires after every restart"

Likely cause: a send is genuinely stuck in `'transferring'` and the wallet hasn't been told whether to recover or escalate. Either enable `features.orphanAutoRecovery` (after confirming the safety contract) or manually triage via the steps in `transfer:orphan-spending-detected`.

### "SENT-reconciliation-failed fires repeatedly for the same outboxId"

Likely cause: persistent OrbitDB write failure at the SENT-ledger prefix. After `maxRetries`, auto-retry is suspended in-process. A wallet restart re-arms the worker. If failures persist across restarts, the underlying storage is broken — escalate.

### "Tombstone GC reports zero purged but tombstones exist"

Likely cause: the tombstones are within the retention window (default 30 days from their `deletedAt`). If you need to reclaim storage urgently, you can construct a worker with a shorter `retentionMs` — but DO NOT go below the longest realistic concurrent-replica pre-sync window. See OUTBOX-SEND-FOLLOWUPS item #4 safety contract.

---

## Configuration reference

```typescript
// All flags are properties of PaymentsModuleConfig.features:
features: {
  recoveryWorker:                true,   // default-ON
  sentReconciliationWorker:      true,   // default-ON
  nostrPersistenceVerifier:      false,  // default-OFF (soak gated)
  orphanAutoRecovery:            false,  // default-OFF (soak gated; safe after item #1)
  tombstoneGcWorker:             false,  // default-OFF (soak gated)
}
```

Per OUTBOX-SEND-FOLLOWUPS item #5, the three default-OFF flags will flip to default-ON after a 7-day soak in non-prod.
