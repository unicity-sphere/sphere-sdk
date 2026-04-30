---
status: draft (pre-push)
purpose: PR description bodies prepared for the user to copy into GitHub when opening the cutover PR series. NOT meant to be reviewed as part of any PR — purely a staging artifact.
---

# PR Description Drafts

## PR #1 — UXF Inter-Wallet Transfer Protocol — implementation

**Title**: `feat(uxf): inter-wallet transfer protocol — implementation (51 of 52 plan tasks)`

**Body**:

```markdown
## Summary

Implements the UXF Inter-Wallet Transfer Protocol per
`docs/uxf/UXF-TRANSFER-PROTOCOL.md` (canonical spec) and
`docs/uxf/UXF-TRANSFER-IMPL-PLAN.md` (52-task plan). 51 of 52 tasks
shipped on this branch across 12 dependency-respecting waves; T.8.D
production cutover is a separate follow-up PR gated on external acks.

## What's included

- **Phase 5** — 12 implementation waves, T.0 → T.8.E.3.
- **Phase 6** — 6-agent validation review (code, refactoring, arch,
  specs, security, ecosystem); 9 cleanup fixes (`bb5d892`).
- **Phase 7** — steelman adversarial pass + recursion; 14 hardening
  fixes (`3c621d7`, `6597ff6`).
- **Phase 8** — 6 post-cutover refactors (importInclusionProof mutex;
  symmetric mergeManifestEntry; profile-token-storage god-object split
  with facade preservation; W26 cross-restart persistence;
  per-aggregator process-global semaphore; sending-recovery-worker;
  worker dedup via shared §6.1 cycle driver).

## Capabilities

3 transfer modes (conservative/instant/TXF), multi-asset wire
(coin+NFT class-disjoint), 13 `transfer:*` events, `importInclusion-
Proof` 10-case operator escape hatch + audit trail, replay-LRU per-
sender isolation, race-lost detection, §6.3 conflicting-proof
security-alert, trustBase staleness with two-strike refresh, cascade
walker class-aware (coin via splitParent, NFT via outbox), error
redaction (W40), CRDT outbox (10-status state machine + property
tests for associativity / commutativity / idempotency).

## Backward compatibility

Public API surface unchanged. Feature flags default OFF — zero
behavior change. ConnectHost `onIntent` 4th arg optional. 4 legacy
wire shapes still accepted (T.7.B legacy-shape-adapter).

## Test plan

- [x] tsc clean.
- [x] eslint clean on new/modified files.
- [x] Full suite: 376 files / 6242 pass / 13 skipped (intentional;
      see runbook) / 0 fail.
- [x] T.8.A byte-identical CAR fixture preserved.

## Reviewing

Branch is large by design (51 plan tasks on one feature branch).
Walk the commit log — each title maps to a plan task.

## Refs

- `docs/uxf/UXF-TRANSFER-PROTOCOL.md` (canonical spec)
- `docs/uxf/UXF-TRANSFER-IMPL-PLAN.md` (52-task plan)
- `docs/uxf/UXF-TRANSFER-CUTOVER-RUNBOOK.md` (operator runbook)
- `docs/uxf/CONNECT-HOST-MIGRATION-NOTE.md` (cross-repo migration)
- `docs/uxf/ADR-005-orbitdb-write-fairness.md`
- `docs/INTEGRATION.md` (operator API + 13 events table)
```

---

## PR #2 — T.8.D Production Cutover

**Title**: `feat(uxf): T.8.D production cutover — flip defaults + remove legacy paths`

**Labels**: `t8d-cutover` (required to fire `external-acks-gate.yml`)

**Body**:

```markdown
## Summary

Production cutover for the UXF Inter-Wallet Transfer Protocol. Flips
feature flag defaults, removes legacy single-coin TXF code paths.

**Pre-requisite**: PR #<NN> (impl) merged + soak complete.

## External-acks gate

CI workflow `.github/workflows/external-acks-gate.yml` enforces all 3
maintainer tracking issues are CLOSED with label `uxf-transfer-v1-ack`:

- [ ] `unicity-sphere/agentsphere#NN` — agentsphere maintainer ack
- [ ] `unicity-sphere/sphere#NN` — sphere app maintainer ack
- [ ] `unicity-sphere/openclaw-unicity#NN` — openclaw-unicity ack

Required secret: `EXTERNAL_ACKS_TOKEN` (fine-grained PAT, `Issues:
Read` on the 3 upstream repos).

## What changes

- Feature flag defaults flip: `senderUxf`, `recipientUxf`,
  `recipientLegacyAdapter`, `recoveryWorker` all → true.
- Default `transferMode` is now `'instant'` over UXF.
- Legacy single-coin TXF code paths removed per W33 ADR appendix.
- TXF sender (T.7.A) + legacy-shape-adapter (T.7.B) remain — opt-in
  via `transferMode: 'txf'` and inbound legacy-shape acceptance.

## Rollout

Per `docs/uxf/UXF-TRANSFER-CUTOVER-RUNBOOK.md`: testnet 24h soak →
mainnet 5%/50%/100% staged → 7-day monitoring.

## Back-out

Revert this PR + run `tools/restore-legacy-outbox.ts --addr <addr>
--profile-path <path>` per affected wallet. Idempotent.

## Test plan

- [x] tsc clean.
- [x] T.8.A regression fixture passes.
- [x] T.6.D.2 restore-roundtrip integration test passes.
- [ ] All 3 external-ack tracking issues closed.
- [ ] Testnet 24h soak completed.
- [ ] Ops sign-off per runbook §Pre-cutover checklist.

Refs: `docs/uxf/UXF-TRANSFER-IMPL-PLAN.md` §T.8.D,
`docs/uxf/UXF-TRANSFER-CUTOVER-RUNBOOK.md`.
```
