# Phase 5 — PaymentsModule.ts Disposition Ledger

Date: 2026-07-07. Branch: `@vrogojin/uxf-v2`. HEAD at ledger start: `34c7baad`.

Input: `modules/payments/PaymentsModule.ts` (19,253 lines, 855 KB).

Purpose: map every method / logical block in PaymentsModule.ts to one of three
dispositions to drive Phase 5's structural split and Phase 6.C's STSDK v1→v2
swap. See `docs/uxf/uxfv2-execution-plan-v2.md` §4 Phase 5, and
`uxfv2-refactor-design.md` §2.1.

## Disposition scheme

- **[A] survive-bound** — Concern belongs in `modules/payments/` post-Phase-6.
  Goes into a per-concern submodule under `modules/payments/{send,receive,
  tokens,read-model,import-export,payment-request,sync,persistence,mint,
  nametag}/`. Facade delegates to it.
- **[B] extension-bound** — Belongs under `extensions/uxf/pipeline/` (or a
  new `extensions/uxf/pipeline/module-glue/` sub-dir). Already moved in
  Phase 3.A step 2 for the standalone pipeline files. Any RESIDUAL glue
  code inside PaymentsModule that must move now is called out here.
- **[C] DELETE-bound** — v1-only machinery scheduled for wholesale deletion
  in Phase 6.C when STSDK is bumped to v2 and the receive-side "tokens
  arrive finished" semantics land. Quarantined into
  `modules/payments/legacy-v1/*.ts` in Phase 5 so that Phase 6.C is
  `git rm` + one facade wiring edit.

## Section-by-section ledger

Line ranges from `PaymentsModule.ts` @ `34c7baad`. Method line ranges come from
Serena's LSP overview of the class body (line 1501–18095). Module-scope
helpers (line 1–1508) and the composition factories (line 18145–19253) sit
outside the class body.

### Module-scope helpers and types (line 1–1508)

| Lines | Symbol / block | Disposition | Target |
|---|---|---|---|
| 1–245 | Imports + `isUxfV1Payload` type-guard | [A] mostly / [B] mostly | facade + submodules; imports rebalance per-submodule |
| 246–316 | `isUxfV1Payload`, other imports | [B] | extensions/uxf; guard already needed there |
| 317–397 | `TransactionHistoryEntry` type re-export + `ImportAdded/ImportSkipped/ImportRejected` taxonomy types | [A] | `modules/payments/import-export/types.ts` |
| 398–430 | `computeHistoryDedupKey` | [A] | `modules/payments/read-model/history.ts` |
| 431–520 | `enrichWithRegistry`, `parseTokenInfo` | [A] | `modules/payments/tokens/parse-token-info.ts` |
| 521–720 | `parseSdkDataCached`, `clearSdkDataCache`, `SDK_DATA_CACHE_MAX`, `sdkDataCache` | [A] | `modules/payments/tokens/parse-cache.ts` |
| 721–800 | `extractTokenIdFromSdkData`, `extractStateHashFromSdkData`, `createTokenStateKey`, `extractTokenStateKey` | [A] | `modules/payments/tokens/identity.ts` |
| 801–930 | `pendingMintDedupKey`, `effectiveDedupKey`, `hasSameGenesisTokenId`, `isSameTokenState` | [A] | `modules/payments/tokens/identity.ts` |
| 931–1004 | `isIncrementalUpdate`, `countCommittedTxns` | [A] | `modules/payments/tokens/identity.ts` |
| 1005–1050 | `findBestTokenVersion` | [A] | `modules/payments/tokens/archive.ts` |
| 1051–1100 | `createTombstoneFromToken`, `pruneTombstonesByAge`, `pruneMapByCount` | [A] | `modules/payments/tokens/tombstones.ts` |
| 1101–1280 | `RecipientFinalizationContext`, `PersistedProofPollingJob`, `ProofPollingJob` interfaces | [C] | `modules/payments/legacy-v1/proof-polling-types.ts` |
| 1281–1400 | `LegacyShapeAdapterRunner`, `SyncOptions`/`SyncResult`, `ReceiveOptions`/`ReceiveResult` | [A]/[B] | Sync types to `modules/payments/sync/types.ts`; receive types to `modules/payments/receive/types.ts`; legacy adapter to `extensions/uxf/pipeline/` |
| 1401–1495 | `ParsedTokenInfo`, `UxfTransferFeatures`, `PaymentsModuleConfig`, `PaymentsModuleDependencies` interfaces | [A] | `modules/payments/types.ts` |
| 1500 | `MAX_SYNCED_HISTORY_ENTRIES` | [A] | `modules/payments/read-model/history.ts` |

### PaymentsModule class (line 1501–18095)

#### Constructor + config accessors + connectivity gate + token observers (line 1501–1935)

| Method | Lines | Disposition | Target |
|---|---|---|---|
| Field declarations (many) | 1501–1720 | (facade fields) | Facade owns them; some move into submodule instances |
| `constructor(config?)` | 1723–1849 | [A] facade | Stays on facade; delegates feature freeze to `modules/payments/config/freeze-features.ts` |
| `getConfig()` | 1856–1858 | [A] facade | Stays on facade |
| `getFeatures()` | 1865–1867 | [A] facade | Stays on facade |
| `configureConnectivityGate` | 1885–1889 | [A] facade | Stays on facade |
| `onTokenChange` | 1901–1906 | [A] facade | Stays on facade |
| `notifyTokenChange` | 1913–1924 | [A] facade | Stays on facade |

#### `initialize(deps)` (line 1936–3487) — 1,551 lines

Mixed disposition. Split by handler block:

| Sub-block | Lines | Disposition | Target |
|---|---|---|---|
| Deps assignment + `applyStorageDeps` invocation | 1936–1998 | [A] facade | Facade |
| `transport.onPaymentRequest` subscription | 1998–2025 | [A] | `modules/payments/payment-request/init-subscription.ts` |
| `transport.onPaymentRequestResponse` subscription | 2025–2225 | [A] | `modules/payments/payment-request/init-subscription.ts` |
| OUTBOX writer readAllNew loop + orphan sweep + tombstone gc wiring | 2225–2455 | [B] | `extensions/uxf/pipeline/module-glue/outbox-worker-wiring.ts` |
| ingestPool + recipient UXF handling | 2455–2988 | [B] | `extensions/uxf/pipeline/module-glue/ingest-worker-wiring.ts` |
| Persisted request-context hydration + recipient finalization pool | 2988–3268 | [B] | `extensions/uxf/pipeline/module-glue/recipient-context-wiring.ts` |
| Spent-state rescan worker + tombstone GC worker install | 3268–3487 | [B] | `extensions/uxf/pipeline/module-glue/rescan-worker-wiring.ts` |

**Verdict:** the entire body of `initialize()` past line ~2000 is [B] extension wiring. The facade's `initialize()` reduces to `this.deps = deps` plus calling out to per-concern init functions.

#### `load()` (line 3497–3876) — 380 lines

| Sub-block | Lines | Disposition | Target |
|---|---|---|---|
| Loaded-guard + storage provider iteration | 3497–3560 | [A] | `modules/payments/persistence/load.ts` |
| Per-provider `getStorageData` + `parseTxfStorageData` + snapshot merge | 3560–3603 | [A] | `modules/payments/persistence/load.ts` |
| Registry-await + parsed-token cache rebuild | 3603–3707 | [A] | `modules/payments/persistence/load.ts` |
| Recovery of stranded received tokens + orphan sweep on load | 3707–3839 | [B] | `extensions/uxf/pipeline/module-glue/load-recovery.ts` |
| Spent-state rescan invocation | 3839–3876 | [B] | `extensions/uxf/pipeline/module-glue/load-recovery.ts` |

#### `install*` worker seams (line 3895–5395) — ~1,500 lines

**All [B] extension-bound** (these are the DI surface for the UXF pipeline).
Facade retains one-liner install methods that delegate to a `PipelineHooksHost`
that the extension activation attaches to.

| Method | Lines | Disposition |
|---|---|---|
| `installIngestWorkerPool` | 3895–3903 | [B] |
| `installSentLedgerWriter` | 3950–3952 | [B] |
| `writeSentEntryFromOutbox` | 4003–4042 | [B] |
| `assertNoDuplicateBundleMembership` | 4111–4148 | [B] |
| `detectOrphanSpendingTokens` | 4183–4203 | [B] |
| `defaultOrphanRecovery` | 4245–4329 | [B] |
| `defaultSpentStateTransition` | 4385–4530 | [B] |
| `installOutboxWriter` | 4532–4603 | [B] |
| `configureRecipientPersistedStorage` | 4951–4963 | [B] |
| `installInclusionProofImporter` | 4974–4976 | [B] |
| `configureOperatorEscapeHatchStorage` | 5007–5024 | [B] |
| `installRevalidateCascadedRunner` | 5031–5033 | [B] |
| `installSendingRecoveryWorker` | 5050–5065 | [B] |
| `installSentReconciliationWorker` | 5085–5097 | [B] |
| `installNostrPersistenceVerifier` | 5111–5119 | [B] |
| `installSpentStateRescanWorker` | 5132–5140 | [B] |
| `setSpentStateRescanTransitionToAudit` | 5168–5172 | [B] |
| `installSpentStateAuditWriter` | 5198–5200 | [B] |
| `installFinalizationWorkerSender` | 5219–5227 | [B] |
| `installFinalizationWorkerRecipient` | 5249–5257 | [B] |
| `getWorkerAbortSignal` | 5269–5271 | [A] facade | Stays on facade (abort signal owned by facade lifecycle) |
| `importInclusionProof` | 5297–5331 | [B] | Operator escape hatch — extension |
| `revalidateCascadedChildren` | 5351–5374 | [B] |
| `installLegacyShapeAdapter` | 5392–5394 | [B] |
| `destroy()` | 5402–5551 | [A] facade | Facade; worker teardown delegated via `PipelineHooksHost.destroy()` |
| `awaitRecipientContextHydration` | 4933–4936 | [B] |

#### `send()` orchestrator + related (line 5566–6853) — ~1,290 lines

| Method | Lines | Disposition | Target |
|---|---|---|---|
| `send(request)` | 5566–6281 | [A] | `modules/payments/send/orchestrator.ts` (~700 lines) |
| `getCoinSymbol`/`getCoinName`/`getCoinDecimals`/`getCoinIconUrl` | 6286–6309 | [A] | `modules/payments/tokens/coin-metadata.ts` |
| `extractCoinAmountForCache` | 6316–6324 | [A] | `modules/payments/tokens/parse-cache.ts` |
| `rebuildParsedTokenCache` | 6330–6345 | [A] | `modules/payments/tokens/parse-cache.ts` |
| `publishUxfBundle` | 6389–6602 | [B] | `extensions/uxf/pipeline/publish-uxf-bundle.ts` |
| `sendInstant` | 6617–6853 | [C] | `modules/payments/legacy-v1/send-instant.ts` (v1 instant-split path; Phase 6.C deletes) |

#### V5/V6 saves + combined-transfer + instant-split processing (line 6906–7595)

| Method | Lines | Disposition |
|---|---|---|
| `saveUnconfirmedV5Token` | 6906–6974 | [C] |
| `saveCommitmentOnlyToken` | 6986–7225 | [C] |
| `processCombinedTransferBundle` | 7240–7363 | [C] |
| `saveProcessedCombinedTransferIds` | 7368–7378 | [C] |
| `loadProcessedCombinedTransferIds` | 7383–7394 | [C] |
| `processInstantSplitBundle` | 7410–7474 | [C] |
| `processInstantSplitBundleSync` | 7480–7589 | [C] |
| `isInstantSplitBundle` | 7597–7599 | [C] |

**All [C]** — v1 instant-split + V5/V6 shapes; main #480 removed them. Quarantine into `modules/payments/legacy-v1/{send-instant,v5-saves,combined-transfer,instant-split}.ts`.

#### Payment requests (line 7611–8045) — ~430 lines

**All [A].** Target: `modules/payments/payment-request/{incoming,outgoing}.ts`.

| Method | Lines | Disposition |
|---|---|---|
| `sendPaymentRequest` | 7611–7673 | [A] outgoing |
| `onPaymentRequest` | 7680–7683 | [A] incoming |
| `getPaymentRequests` | 7689–7694 | [A] incoming |
| `getPendingPaymentRequestsCount` | 7701–7703 | [A] incoming |
| `acceptPaymentRequest` | 7713–7716 | [A] incoming |
| `rejectPaymentRequest` | 7723–7726 | [A] incoming |
| `markPaymentRequestPaid` | 7736–7738 | [A] incoming |
| `clearProcessedPaymentRequests` | 7745–7747 | [A] incoming |
| `removePaymentRequest` | 7754–7756 | [A] incoming |
| `payPaymentRequest` | 7762–7803 | [A] incoming |
| `updatePaymentRequestStatus` | 7805–7818 | [A] incoming |
| `handleIncomingPaymentRequest` | 7820–7862 | [A] incoming |
| `getOutgoingPaymentRequests` | 7872–7878 | [A] outgoing |
| `onPaymentRequestResponse` | 7885–7888 | [A] outgoing |
| `waitForPaymentResponse` | 7896–7921 | [A] outgoing |
| `cancelWaitForPaymentResponse` | 7930–7937 | [A] outgoing |
| `removeOutgoingPaymentRequest` | 7944–7947 | [A] outgoing |
| `clearCompletedOutgoingPaymentRequests` | 7952–7958 | [A] outgoing |
| `handlePaymentRequestResponse` | 7960–8015 | [A] outgoing |
| `sendPaymentRequestResponse` | 8020–8045 | [A] outgoing |

#### `receive()` + drain + read-model getters (line 8066–8671) — ~600 lines

| Method | Lines | Disposition | Target |
|---|---|---|---|
| `receive` | 8066–8187 | [A] | `modules/payments/receive/receive.ts` |
| `drainPendingFinalizations` | 8203–8296 | [C] | `modules/payments/legacy-v1/drain-pending.ts` (v1 finalization — Phase 6.C removes) |
| `setPriceProvider` | 8305–8307 | [A] facade | Stays on facade |
| `waitForPendingOperations` | 8313–8321 | [A] facade | Stays on facade |
| `getFiatBalance` | 8327–8345 | [A] | `modules/payments/read-model/assets.ts` |
| `getBalance` | 8360–8362 | [A] | `modules/payments/read-model/assets.ts` |
| `getAssets` | 8368–8425 | [A] | `modules/payments/read-model/assets.ts` |
| `aggregateTokens` | 8449–8559 | [A] | `modules/payments/read-model/assets.ts` |
| `getTokens` | 8569–8604 | [A] | `modules/payments/read-model/tokens-view.ts` |
| `getToken` | 8612–8618 | [A] | `modules/payments/read-model/tokens-view.ts` |
| `exportTokens` | 8643–8671 | [A] | `modules/payments/import-export/export.ts` |

#### Import + v1 finalization/resolution + pending-V5 persistence (line 8712–10968)

| Method | Lines | Disposition |
|---|---|---|
| `importTokens` | 8712–8920 | [A] |
| `resolveUnconfirmed` | 8941–9055 | [C] |
| `scheduleResolveUnconfirmed` | 9062–9103 | [C] |
| `stopResolveUnconfirmedPolling` | 9105–9110 | [C] |
| `scheduleV6RecoverPermanentSaveRetry` | 9125–9166 | [C] |
| `stopV6RecoverPermanentSaveRetry` | 9168–9174 | [C] |
| `resolveV5Token` | 9194–9379 | [C] |
| `quickProofCheck` | 9384–9401 | [C] |
| `finalizeFromV5Inputs` | 9412–9537 | [C] |
| `gcArchivedV5PendingForFinalized` | 9556–9596 | [C] |
| `isReceivedLegacyPending` | 9617–9665 | [C] |
| `primeProxyAddressCache` | 9677–9698 | [C] |
| `parsePendingFinalization` | 10709–10720 | [C] |
| `hasFinalizationPlan` | 9713–9718 | [C] |
| `updatePendingFinalization` | 10739–10769 | [C] |
| `latestStatePredicateMatchesWallet` | 9745–9776 | [C] |
| `recoverStrandedReceivedTokens` | 9797–10008 | [C] |
| `finalizeStrandedReceivedToken` | 10019–10378 | [C] |
| `tryLocalFinalizeUnconfirmed` | 10409–10568 | [C] |
| `resolveLegacyReceivedToken` | 10570–10654 | [C] |
| `resolveLegacyReceivedTokenViaGetProof` | 10664–10704 | [C] |
| `loadPendingV5Tokens` | 10866–10934 | [C] |
| `savePendingV5Tokens` | 10787–10849 | [C] |
| `saveProcessedSplitGroupIds` | 10941–10952 | [C] |
| `loadProcessedSplitGroupIds` | 10957–10968 | [C] |

**All [C].** Target dir: `modules/payments/legacy-v1/finalization/*.ts` (~2,000 lines).

#### Token repository + tombstones + archive/forked (line 10987–11504)

| Method | Lines | Disposition | Target |
|---|---|---|---|
| `addToken` | 10987–11118 | [A] | `modules/payments/tokens/repository.ts` |
| `updateToken` | 11130–11198 | [A] | `modules/payments/tokens/repository.ts` |
| `removeToken` | 11209–11246 | [A] | `modules/payments/tokens/repository.ts` |
| `getTombstones` | 11261–11263 | [A] | `modules/payments/tokens/tombstones.ts` |
| `isStateTombstoned` | 11273–11275 | [A] | `modules/payments/tokens/tombstones.ts` |
| `rebuildTombstoneKeySet` | 11277–11282 | [A] | `modules/payments/tokens/tombstones.ts` |
| `mergeTombstones` | 11293–11333 | [A] | `modules/payments/tokens/tombstones.ts` |
| `pruneTombstones` | 11340–11349 | [A] | `modules/payments/tokens/tombstones.ts` |
| `getArchivedTokens` | 11363–11365 | [A] | `modules/payments/tokens/archive.ts` |
| `getBestArchivedVersion` | 11376–11378 | [A] | `modules/payments/tokens/archive.ts` |
| `mergeArchivedTokens` | 11391–11415 | [A] | `modules/payments/tokens/archive.ts` |
| `pruneArchivedTokens` | 11424–11432 | [A] | `modules/payments/tokens/archive.ts` |
| `getForkedTokens` | 11446–11448 | [A] | `modules/payments/tokens/archive.ts` |
| `storeForkedToken` | 11459–11466 | [A] | `modules/payments/tokens/archive.ts` |
| `mergeForkedTokens` | 11474–11489 | [A] | `modules/payments/tokens/archive.ts` |
| `pruneForkedTokens` | 11496–11504 | [A] | `modules/payments/tokens/archive.ts` |

#### History (line 11515–11685)

| Method | Lines | Disposition |
|---|---|---|
| `getHistory` | 11515–11517 | [A] |
| `resolveSenderInfo` | 11553–11566 | [A] |
| `addToHistory` | 11577–11608 | [A] |
| `loadHistory` | 11614–11653 | [A] |
| `importRemoteHistoryEntries` | 11661–11685 | [A] |
| `getLocalTokenStorageProvider` | 11690–11700 | [A] |

**All [A].** Target: `modules/payments/read-model/history.ts` (except `getLocalTokenStorageProvider` → `modules/payments/persistence/providers.ts`).

#### Nametag CRUD + mint (line 11713–12085)

| Method | Lines | Disposition | Target |
|---|---|---|---|
| `setNametag` | 11713–11723 | [A] | `modules/payments/nametag/store.ts` |
| `getNametag` | 11739–11746 | [A] | `modules/payments/nametag/store.ts` |
| `getNametagByName` | 11758–11760 | [A] | `modules/payments/nametag/store.ts` |
| `getNametags` | 11767–11769 | [A] | `modules/payments/nametag/store.ts` |
| `hasNametag` | 11782–11784 | [A] | `modules/payments/nametag/store.ts` |
| `hasNametagNamed` | 11791–11793 | [A] | `modules/payments/nametag/store.ts` |
| `clearNametag` | 11798–11802 | [A] | `modules/payments/nametag/store.ts` |
| `clearNametagByName` | 11818–11827 | [A] | `modules/payments/nametag/store.ts` |
| `reloadNametagsFromStorage` | 11835–11852 | [A] | `modules/payments/nametag/store.ts` |
| `mintNametag` | 11861–11934 | [C] | `modules/payments/legacy-v1/mint-nametag.ts` (v1 on-chain nametag mint — deleted by scope §3.8) |
| `mintFungibleToken` | 11964–12085 | [A] | `modules/payments/mint/fungible.ts` (Phase 6.C rewires onto `token-engine`) |
| `isNametagAvailable` | 12091–12114 | [A] | `modules/payments/nametag/availability.ts` |

#### Sync (line 12141–12488)

| Method | Lines | Disposition | Target |
|---|---|---|---|
| `sync` | 12141–12158 | [A] | `modules/payments/sync/engine.ts` |
| `_doSync` | 12160–12386 | [A] | `modules/payments/sync/engine.ts` |
| `subscribeToStorageEvents` | 12396–12412 | [A] | `modules/payments/sync/storage-events.ts` |
| `unsubscribeStorageEvents` | 12417–12427 | [A] | `modules/payments/sync/storage-events.ts` |
| `debouncedSyncFromRemoteUpdate` | 12433–12456 | [A] | `modules/payments/sync/storage-events.ts` |
| `getTokenStorageProviders` | 12461–12488 | [A] | `modules/payments/sync/engine.ts` |
| `isPriceDisabled` | 12493–12498 | [A] facade | Stays on facade |
| `updateTokenStorageProviders` | 12507–12513 | [A] | `modules/payments/sync/engine.ts` |
| `validate` | 12522–12564 | [A] | `modules/payments/sync/engine.ts` |
| `getPendingTransfers` | 12571–12573 | [A] facade | Stays on facade |

#### Recipient/transport resolution + capability warnings (line 12587–12812)

| Method | Lines | Disposition | Target |
|---|---|---|---|
| `resolveTransportPubkey` | 12587–12607 | [A] | `modules/payments/send/recipient-resolve.ts` |
| `computeOutboundAssetKinds` | 12622–12635 | [A] | `modules/payments/send/asset-kind.ts` |
| `resolveOutboundWireProtocol` | 12647–12652 | [A] | `modules/payments/send/asset-kind.ts` |
| `maybeEmitCapabilityWarning` | 12675–12726 | [B] | `extensions/uxf/pipeline/module-glue/capability-warning.ts` (UXF-feature-flag specific) |
| `resolveCoinIdSymbol` | 12758–12812 | [A] | `modules/payments/tokens/coin-metadata.ts` |

#### UXF dispatch (line 12841–15061)

| Method | Lines | Disposition | Target |
|---|---|---|---|
| `recordUxfBundleSentHistory` | 12841–12931 | [B] | `extensions/uxf/pipeline/module-glue/sent-history-recorder.ts` |
| `dispatchUxfConservativeSend` | 12956–13767 | [B] | `extensions/uxf/pipeline/dispatch-conservative.ts` |
| `dispatchUxfInstantSend` | 13787–14787 | [B] | `extensions/uxf/pipeline/dispatch-instant.ts` |
| `dispatchTxfSend` | 14812–15061 | [C] | `modules/payments/legacy-v1/dispatch-txf.ts` (legacy wire) |

#### Source ownership + commitment machinery + resolveRecipientAddress + double-spend (line 15120–15846)

| Method | Lines | Disposition | Target |
|---|---|---|---|
| `validateSourceOwnership` | 15120–15178 | [B] | `extensions/uxf/pipeline/module-glue/source-ownership.ts` (invariant is UXF-pipeline) |
| `submitCommitmentClassified` | 15213–15301 | [C] | `modules/payments/legacy-v1/commitment.ts` (v1 commitment machinery — v2 uses ITokenEngine) |
| `emitDoubleSpendDetectedIfApplicable` | 15319–15355 | [A] | `modules/payments/send/double-spend-emit.ts` (survives; event fan-out) |
| `createSdkCommitment` | 15357–15384 | [C] | `modules/payments/legacy-v1/commitment.ts` |
| `createSigningService` | 15395–15419 | [C] | `modules/payments/legacy-v1/commitment.ts` |
| `getSigningPublicKey` | 15425–15429 | [A] facade | Stays on facade (facade owns identity) |
| `createDirectAddressFromPubkey` | 15434–15455 | [A] | `modules/payments/send/recipient-resolve.ts` |
| `resolveRecipientAddress` | 15461–15517 | [A] | `modules/payments/send/recipient-resolve.ts` |
| `handleCommitmentOnlyTransfer` | 15524–15577 | [C] | `modules/payments/legacy-v1/commitment.ts` |
| `finalizeTransferToken` | 15583–15710 | [C] | `modules/payments/legacy-v1/finalization/finalize-transfer.ts` |
| `deriveRecipientAddressFor` | 15720–15744 | [A] | `modules/payments/send/recipient-resolve.ts` |
| `resolveExpectedTransactionAddress` | 15754–15776 | [C] | `modules/payments/legacy-v1/commitment.ts` |
| `tryRecoverSigningServiceForRecipient` | 15786–15846 | [C] | `modules/payments/legacy-v1/commitment.ts` |
| `bytesToHexSafe` | 15854–15863 | [A] | Use `core/hex.ts` (or `lib/bytes/hex.ts`) |
| `shortHex` | 15870–15873 | [A] | Use `core/hex.ts` (or `lib/bytes/hex.ts`) |
| `finalizeReceivedToken` | 15878–16032 | [C] | `modules/payments/legacy-v1/finalization/finalize-received.ts` |
| `awaitAllProvidersDurable` | 16073–16120 | [B] | `extensions/uxf/pipeline/module-glue/durability-gate.ts` |

#### `handleIncomingTransfer` (line 16143–16722) — 580 lines

| Method | Lines | Disposition | Target |
|---|---|---|---|
| `handleIncomingTransfer` | 16143–16722 | [A]+[B]+[C] mixed | Split by payload-shape switch: v1 branches → `modules/payments/legacy-v1/inbound-legacy.ts`; UXF-shape branches → `extensions/uxf/pipeline/module-glue/inbound-uxf-router.ts`; v2 branch → `modules/payments/receive/inbound-handler.ts` |

**Note:** this is the module's inbound multiplexer over 6 payload shapes. Because the v2 branch is what survives, the surviving core method becomes small; the two other branches quarantine [C] / re-home [B]. Ambiguity flag: some shapes are hybrid v1/v2 and their disposition is a **product-decision hold** — flag for Phase 6 sign-off.

#### Persistence codec (line 16728–17399)

| Method | Lines | Disposition | Target |
|---|---|---|---|
| `archiveToken` | 16728–16751 | [A] | `modules/payments/persistence/codec.ts` |
| `_saveChain` prop | 16776 | facade | facade owns save-chain seq |
| `setStorageEntry` | 16797–16823 | [A] | `modules/payments/persistence/kv-writer-adapter.ts` (adapts to `lib/storage/kv-writer.ts`) |
| `save` | 16828–16840 | [A] | `modules/payments/persistence/save.ts` |
| `_doSave` | 16842–16871 | [A] | `modules/payments/persistence/save.ts` |
| `_lastPinnedOutboxJson` etc | 16879–16880 | (facade props) | facade |
| `_outboxChain` | 16894 | (facade prop) | facade |
| `enqueueOutboxOp` | 16896–16909 | [B] | `extensions/uxf/pipeline/module-glue/outbox-ops.ts` |
| `saveToOutbox` | 16911–16917 | [B] | `extensions/uxf/pipeline/module-glue/outbox-ops.ts` |
| `removeFromOutbox` | 16919–16925 | [B] | `extensions/uxf/pipeline/module-glue/outbox-ops.ts` |
| `writeOutbox` | 16936–16974 | [B] | `extensions/uxf/pipeline/module-glue/outbox-ops.ts` |
| `loadOutbox` | 16988–17031 | [B] | `extensions/uxf/pipeline/module-glue/outbox-ops.ts` |
| `createStorageData` | 17033–17050 | [A] | `modules/payments/persistence/codec.ts` |
| `loadFromStorageData` | 17052–17399 | [A] | `modules/payments/persistence/codec.ts` (347 lines — the TXF codec + snapshot-loser detection; keep `_audit` route intact) |
| `submitAndPollForProof` | 17409–17450 | [C] | `modules/payments/legacy-v1/proof-polling/submit-and-poll.ts` |

#### NOSTR-FIRST proof polling + V6-recover permanent + retry timers (line 17455–18084)

**All [C].** Target: `modules/payments/legacy-v1/proof-polling/` (~700 lines).

| Method | Lines | Disposition |
|---|---|---|
| `addProofPollingJob` | 17455–17466 | [C] |
| `saveProofPollingJobs` | 17477–17539 | [C] |
| `restoreProofPollingJobs` | 17552–17701 | [C] |
| `saveV6RecoverPermanent` | 17715–17740 | [C] |
| `restoreV6RecoverPermanent` | 17750–17808 | [C] |
| `applyV6RecoverPermanentInvalidStatus` | 17835–17878 | [C] |
| `isV6RecoverPermanentToken` | 17893–17901 | [C] |
| `startProofPolling` | 17906–17915 | [C] |
| `stopProofPolling` | 17920–17926 | [C] |
| `processProofPollingQueue` | 17931–18084 | [C] |
| `ensureInitialized` | 18090–18094 | [A] facade | Stays on facade |

#### Module-scope composition factories (line 18145–19253) — ~1,100 lines

**All [B].** Move to `extensions/uxf/pipeline/module-glue/composition.ts`.

| Function | Lines | Disposition |
|---|---|---|
| `buildDefaultFinalizationWorkerSender` | ~18145–18500 | [B] |
| `buildDefaultFinalizationWorkerRecipient` | ~18500–18800 | [B] |
| `buildDefaultInclusionProofImporter` | ~18800–19000 | [B] |
| `buildDefaultRevalidateCascadedRunner` | ~19000–19100 | [B] |
| `createPaymentsModule` | ~19100–19253 | [A] facade | Stays as a factory near the facade; delegates worker composition to the extension |

## Rollup

| Disposition | Approx LoC | % of file |
|---|---:|---:|
| **[A] survive** | ~7,900 | ~41 % |
| **[B] extension** | ~5,800 | ~30 % |
| **[C] delete** | ~5,600 | ~29 % |
| **Facade (retained)** | ~800 target | ~4 % of the target |

Note: the [A]+[B]+[C] rollup sums to ~19,300, matching total file line count within noise. The 800-line facade target subtracts from [A] (facade is what remains after [A]-concerns are moved into submodules).

## Ambiguities and open product-decision holds

1. **`handleIncomingTransfer` payload-shape branches** (line 16143–16722): the 6-shape inbound multiplexer mixes v1/v2/UXF branches. The v2 branch is [A], the UXF-shape branch is [B], and 4 legacy branches are [C]. But some shapes are hybrid and their branch classification is a **product-decision hold** for Phase 6 sign-off — do not blindly quarantine legacy branches without a per-branch review.
2. **`emitDoubleSpendDetectedIfApplicable`** (line 15319–15355): classified [A] because the event surface (`transfer:double-spend-detected`) is a documented public event (CLAUDE.md). But its implementation currently depends on v1 commitment machinery in the same class; the [A] target requires porting to v2 semantics in Phase 6.C. Not blocking Phase 5.
3. **`recordUxfBundleSentHistory`** (line 12841–12931): classified [B] because it emits UXF-pipeline-specific history entries. If the plan wants the history entry shape to be canonical across senders (main also has a similar entry), consider promoting it to [A] and keeping only the UXF-specific fields extension-owned. Flag for product call at Phase 7 API-surface alignment.
4. **`installLegacyShapeAdapter`** (line 5392–5394): the seam itself is [B] but exists because uxf's outbound path calls it. If the shape adapter is v1-only-once-the-inbound is on v2, disposition may drift to [C] in Phase 6.C.
5. **`processInstantSplitBundleSync`** vs `processInstantSplitBundle`: [C] both — but the async one may be reachable from surviving code paths. Verify no [A] method transitively depends on either before quarantine.

## What this ledger enables

- **Phase 5 execution:** each row above is a mechanical move target.
  Submodule dirs to create: 10 [A] concern dirs + 1 `legacy-v1/` dir; ~11 new
  files under `extensions/uxf/pipeline/module-glue/` for [B] extractions.
- **Phase 6.C execution:** the entire `modules/payments/legacy-v1/` dir is
  deleted wholesale (`git rm -r modules/payments/legacy-v1/`) plus one edit
  to remove the facade's delegation stubs to those methods. No surgery in
  the surviving submodules.
