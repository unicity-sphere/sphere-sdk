# modules/payments/legacy-v1/ — Quarantine Directory (Phase 6.C Delete)

**All files here are scheduled for wholesale deletion in Phase 6.C** of
the uxf-v2 refactor. Per uxfv2-execution-plan-v2.md §4 Phase 6.C:

> Delete `modules/payments/legacy-v1/` wholesale (the Phase-5 quarantine
> pays off) + the remaining v1-only shims + their test files.

**Do not add new functionality here.** Files here are strictly v1-STSDK-
coupled machinery that becomes moot when the STSDK v1→v2 swap lands
(receive-side "tokens arrive finished" semantics, engine-managed
commitment machinery, no proof polling).

## Contents (planned per uxfv2-phase-5-payments-disposition.md)

Rows tagged [C] from the disposition ledger. Sub-dirs mirror the
concern taxonomy where useful:

- `finalization/` — resolveUnconfirmed + V5 finalization family (~2,000
  LoC): `resolveUnconfirmed`, `scheduleResolveUnconfirmed`,
  `stopResolveUnconfirmedPolling`, `resolveV5Token`, `quickProofCheck`,
  `finalizeFromV5Inputs`, `gcArchivedV5PendingForFinalized`,
  `isReceivedLegacyPending`, `parsePendingFinalization`,
  `hasFinalizationPlan`, `updatePendingFinalization`,
  `latestStatePredicateMatchesWallet`, `recoverStrandedReceivedTokens`,
  `finalizeStrandedReceivedToken`, `tryLocalFinalizeUnconfirmed`,
  `resolveLegacyReceivedToken`, `resolveLegacyReceivedTokenViaGetProof`,
  `loadPendingV5Tokens`, `savePendingV5Tokens`,
  `saveProcessedSplitGroupIds`, `loadProcessedSplitGroupIds`,
  `finalizeTransferToken`, `finalizeReceivedToken`, `drainPendingFinalizations`.

- `proof-polling/` — NOSTR-FIRST proof polling + V6-recover-permanent
  (~700 LoC): `addProofPollingJob`, `saveProofPollingJobs`,
  `restoreProofPollingJobs`, `saveV6RecoverPermanent`,
  `restoreV6RecoverPermanent`, `applyV6RecoverPermanentInvalidStatus`,
  `isV6RecoverPermanentToken`, `startProofPolling`, `stopProofPolling`,
  `processProofPollingQueue`, `submitAndPollForProof`,
  `PersistedProofPollingJob`, `ProofPollingJob` types,
  `scheduleV6RecoverPermanentSaveRetry`, `stopV6RecoverPermanentSaveRetry`.

- `commitment.ts` — v1 commitment machinery (~800 LoC):
  `submitCommitmentClassified`, `createSdkCommitment`,
  `createSigningService`, `handleCommitmentOnlyTransfer`,
  `resolveExpectedTransactionAddress`, `tryRecoverSigningServiceForRecipient`.

- `send-instant.ts` — v1 instant send (~236 LoC): `sendInstant`.

- `v5-saves.ts` — V5 unconfirmed / commitment-only saves (~370 LoC):
  `saveUnconfirmedV5Token`, `saveCommitmentOnlyToken`.

- `combined-transfer.ts` — v1 combined-transfer bundle path (~140 LoC):
  `processCombinedTransferBundle`, `saveProcessedCombinedTransferIds`,
  `loadProcessedCombinedTransferIds`.

- `instant-split.ts` — v1 instant-split bundle processing (~190 LoC):
  `processInstantSplitBundle`, `processInstantSplitBundleSync`,
  `isInstantSplitBundle`.

- `dispatch-txf.ts` — legacy TXF wire dispatch (~250 LoC):
  `dispatchTxfSend`.

- `inbound-legacy.ts` — legacy branches of `handleIncomingTransfer`
  (post-per-branch-split; scope TBD in Phase 6.C per the ambiguity
  flag in uxfv2-phase-5-payments-disposition.md §Ambiguities).

- `mint-nametag.ts` — v1 on-chain nametag mint (~74 LoC): `mintNametag`.
  Retired per scope §3.8; the v2 wallet-api / UnicityIdToken model
  replaces it.

## Compile / test posture during Phase 5

Files remain wired to the facade via `PaymentsModule.ts` delegating to
them (each [C] method's body is a one-line `xxxImpl.call(this, ...args)`
delegation to a helper in this directory). Test files targeting these
behaviors stay live until Phase 6.C's `git rm` wave.

**Landed (waves 1–3):** all rows tagged [C] in the disposition ledger
have moved into this directory. `modules/payments/legacy-v1/**/*.ts` is
now in `tsconfig.json`'s `exclude` list — the quarantine directory is no
longer part of the primary compilation root set, so Phase 6.C's
`git rm -r modules/payments/legacy-v1/` produces a clean bulk-delete diff
with a single facade edit (remove the barrel import + the delegator
methods) plus the tsconfig line removal.

Excluding the directory from the tsconfig root set does not stop TS from
compiling the files transitively via the facade's barrel import — it
declares the quarantine intent and lets Phase 6.C's `git rm` land without
needing to touch `include`/`exclude`.
