# PaymentsModule.ts — Final Executable Refactoring Plan

> **HISTORICAL — describes the pre-P11 module.** The P11 flip DELETED
> `modules/payments/` wholesale; the money path is now `modules/payments-v2/`
> (see `docs/PAYMENTS-V2-DESIGN.md`). Kept as the record the rewrite was
> justified from.

> **Superseded in part — read as a record, not as current guidance.** Written before
> the work landed, so its file:line references and "largely dead" verdicts describe a
> tree that no longer exists: #715/#719 restructured the send and resume paths, #722
> deleted the v1/legacy surfaces, and #723 split PaymentsModule into requests/, receive/,
> inventory/, resume/ and history/ (6,169 → 3,594 lines) and removed mergeTombstones,
> resolveSenderInfo, acceptPaymentRequest and markPaymentRequestPaid. Verify against the
> current tree before acting on any coordinate or verdict here.


**Target:** `modules/payments/PaymentsModule.ts` (7,027 lines, 1 class, 161 methods)

> **Baseline note.** Every line number, size and method reference in this plan and in
> [`PAYMENTS-ANALYSIS.md`](./PAYMENTS-ANALYSIS.md) was taken against `main` @ `18ffc802`, where the
> file was 7,027 lines. `main` has since moved: **#698 (concurrent send)** and **#700 (batch
> mailbox deposit)** landed, taking it to 7,179 and — importantly — introducing
> `modules/payments/SendOperations.ts`, which already extracts the send *operation types* and
> outcome summarization (`DirectSendOperation`, `SplitSendOperation`, `OperationOutcome`,
> `summarizeOutcomes`, `isKeepOpenSendError`). **Stage 14 must be rebased onto that file rather
> than re-derived**: it should extend `SendOperations.ts` with the `IntentExecutor` +
> `ConflictPolicy` seam, not create a parallel one. Re-run the line-number survey before executing
> any stage past the mechanical ones.
**Design:** Architecture A (collaborator extraction, risk-first) with Design B's send-pipeline seam, conflict-policy parameter, and verification apparatus grafted in.
**Status:** ready to execute. Stage 1 is runnable today.

---

## ⚠️ Pre-flight: the branch named in CLAUDE.md does not exist

`CLAUDE.md` mandates *"all work branches from and PRs back to `feat/wallet-api-integration`"*. Verified today:

```
git ls-remote --heads origin | grep wallet-api-integration   →  (no output)
git ls-remote --heads origin | grep 'refs/heads/main$'        →  18ffc802...
```

The integration branch is gone from `origin`; the wallet-api code (`walletApi`, `PENDING_V2_DELIVERIES`, `resumeOpenIntents`) is present in `main` at `18ffc802`. **The program branch was merged.** Before Stage 1, confirm with the program owner whether the topology rule now means `main`. This plan assumes **base = `main`** and will need a one-line substitution if a successor integration branch is created. Every PR still links a GitHub issue (`Closes #N`) and squash-merges after green CI (typecheck + lint + build + unit tests).

---

## 1. How we got here

The file **is** the money-safety transaction boundary: every durability invariant is enforced by co-locating mutable state in one object's private fields (~60 of them, `PaymentsModule.ts:1030-1201`, including 11 hand-rolled concurrency primitives with no shared abstraction), so a new invariant *must* be written inside the class to see `this.tokens`, `this.reservationLedger`, `this.settlingJournal` and `this.deps.walletApi` at once — there was never a `SendSaga` to hang a rule on. Surviving-line blame proves the mechanism: **2,354 lines (33%) come from `fix*` commits versus 132 lines (1.9%) from `refactor*`**, with 133 issue-tagged guard comments spanning 33 distinct GitHub issues embedded in the code and **zero** TODO/FIXME markers. `sendOnce` grew 254 → 702 lines in 47 days across 36 commits purely by absorbing incident guards, and its crash-recovery twin `resumeIntent` grew 106 → 288 in lockstep because the two are **independent implementations of one pipeline** (`engine.transfer` at `:2166` *and* `:6416`; `engine.split` at `:2225` *and* `:6459`; `uploadOutputBlob` at `:2316` *and* `:6536`) — three commits (`e8118c51`, `ff875f63`, `cd1e2fb6`) exist solely to make resume behave like send. The one moment the file was small was the v1 cutover (`fde68246`, +167/−2828, leaving 3,515 lines) and the wallet-api migration immediately refilled it to 7,027 in 47 days by layering a **second custody/persistence stack beside the local one inside the same methods** (`const serverApply = !!walletApi && delivery.custody === 'inventory'` at `:2075` *and* `:6365`) rather than behind the `DeliveryProvider`/`TokenStorageProvider` ports it introduced. The only decomposition ever executed lives on the abandoned `origin/@vrogojin/uxf-v2` fork (39 `refactor(payments)(phase-5/6)` commits, 1,260 commits unmerged), and the project's own size accounting is stale — CLAUDE.md records "~139KB"; the file is **309,349 bytes**.

---

## 2. Target structure

`PaymentsModule.ts` **stays** the facade: same class, same file path, same public API, same `export *` surface from `modules/payments/index.ts`. Everything else becomes a collaborator the facade owns and delegates to.

### Three rules that govern every extraction

| # | Rule | Why (verified) |
|---|---|---|
| **R1** | Collaborators receive **LIVE getters**, never constructor-captured values | `deps` sub-properties are mutated in place — `setTokenEngine` `:1279`, `updateTokenStorageProviders` `:5168-5176` — and `this.delivery` is **reassigned on every `initialize()`** at `:1358` |
| **R2** | Any Map that `SpendQueue` closes over must be the **SAME instance** after the move, never a copy | `() => this.tokens` at `:1215`/`:1339` (live getter) and `parsedTokenCache` passed **by value** at `:1216`/`:1339`, never reassigned (only `.clear()` at `:1331`) |
| **R3** | Every private name a test reaches via `(x as any).` keeps a **thin delegator** on the facade | Verified reach-in set is only 8 names, not 161: `replayPendingV2Deliveries` ×11, `handleIncomingTransfer` ×4, `savePendingV2Delivery` ×3, `resolveTransportPubkeyInfo` ×3, `replayBackoffBaseMs` ×3, `save` ×2, `deliveryDeferralMs` ×1, `spendQueue` ×1 → **zero test edits is realistic, not aspirational** |

### Files

| Path | Responsibility | ~Lines | Moves from |
|---|---|---|---|
| `PaymentsModule.ts` | **Facade + lifecycle only.** ctor, `getConfig`, `setTokenEngine`, `initialize` (→ `for (const c of collaborators) c.reset(owner)` + subscription install), `destroy` (→ `dispose()`), `ensureInitialized`, the identity/crypto seam (`getFieldEncryptionKey` `:2649`, `getCheckpointStore` `:2662`, `currentNametagName` `:4707`), one delegator per public member. Owns the collaborator graph and the `SpendQueue`/`SpendPlanner`/`TokenReservationLedger` trio unchanged. | **~1,100** | retains `:1203-1226`, `:1240`, `:1279`, `:1287-1448`, `:1719-1783`, `:2649`, `:2662`, `:4707`, `:7014`, `:7025` |
| `payments-constants.ts` | The 13 incident-tuning constants, each keeping its JSDoc + issue tag. No logic. | 95 | `:131-195` |
| `payments-deps.ts` | Dependency/config contract types only. | 120 | `PaymentsModuleConfig` `:695`, `PaymentsModuleDependencies` `:933`, `ReceiveOptions` `:257`, `ReceiveResult` `:266`, `AssetAccumulator` `:235`, `TransactionHistoryEntry` `:102` |
| `wallet-api-port.ts` | The wallet-api port contract + wire types — the S3/S4 seam the backend codes against. **Import-closure clean** (no browser/IPFS/Nostr). | 190 | `:731-932` (`WalletApiPaymentRequest`, `WalletApiListPaymentRequestsParams`, `WalletApiPaymentRequestsPage`, `WalletApiHistoryRecord`, `PaymentsWalletApiPort`, `PaymentRequestsApi`, `IntentPayloadV1`), `isNonOpenConflict` `:109` |
| `token-parsing.ts` | Pure token-blob/TXF parsing **+ the process-wide `sdkDataCache`**. THE hazard file — see Stage 4. | 300 | `ParsedTokenInfo` `:275`, `enrichWithRegistry` `:288`, `parseTokenInfo` `:306`, `sdkDataCache` `:436`, `SDK_DATA_CACHE_MAX` `:437`, `looksLikeTokenBlob` `:440`, `tryParseBlobKeys` `:450`, `parseSdkDataCached` `:459`, `clearSdkDataCache` `:502`, `extractTokenIdFromSdkData` `:509`, `extractStateHashFromSdkData` `:517`, `createTokenStateKey` `:527`, `extractTokenStateKey` `:535`, `hasSameGenesisTokenId` `:556`, `isSameTokenState` `:565` |
| `payments-internal.ts` | Three cross-cluster micro-helpers that exist as 3–4 copies each. | 70 | `notifyAll<T>()` (new, replaces `:3244-3252`, `:3406-3413`, `:6031-6037`), `debounceSlot()` (new), `isForeignAddressMeta()` (new, replaces `:1515-1521` + `:4939-4945`) |
| `coin-meta.ts` | `TokenRegistry` facade as four free functions. Keeps `TokenRegistry.getInstance()` **inside** (singleton is per tsup bundle context — do not add a second access path). | 45 | `getCoinSymbol` `:2601`, `getCoinName` `:2608`, `getCoinDecimals` `:2615`, `getCoinIconUrl` `:2622` |
| `balances.ts` | Read-only aggregation of a token snapshot → `Asset[]`, plus fiat enrichment. Pure over `Iterable<Token>` + `PriceProvider`. | 190 | `setPriceProvider` `:3557`, `getFiatBalance` `:3579`, `getBalance` `:3615`, `getAssets` `:3626`, `aggregateTokens` `:3695`, `accumulateToken` `:3732`, `newAssetAccumulator` `:3748`, `isPriceDisabled` `:5154` |
| `token-storage-registry.ts` | **ONE answer to "where does state live."** Replaces four independent implementations of "first non-disabled provider" with `active()`, plus `local()`, `all()`, and a `snapshot()` a send holds for its whole duration. | 120 | `getTokenStorageProviders` `:5122`, `getActiveTokenStorageProvider` `:2643`, `getLocalTokenStorageProvider` `:4650`, `firstEnabledTokenStorage` `:975`, `assertLegalCustodyComposition` `:1006`, the `activeId` computation in `save()` `:6706` |
| `delivery-journal.ts` | The `PENDING_V2_DELIVERIES` crash-safety journal, whole. Owns the 4 exclusively-owned fields. **Instantiated in the CONSTRUCTOR, not `initialize()`.** | 240 | `PendingV2Delivery` `:203`, `:6746-6946` (14 methods), fields `journalMutation` `:1201`, `replayInFlight` `:1193`, `replayBackoffBaseMs` `:1183`, `deliveryDeferralMs` `:1185` |
| `txf-archive-store.ts` | Tombstones (+ derived O(1) key set), archived, forked — behind one object, plus the pure algorithms already at module scope. Exposes `toTxfParts()`/`hydrateFromTxf()` so the single-blob persistence unit survives. | 290 | `isIncrementalUpdate` `:593`, `countCommittedTxns` `:628`, `pruneTombstonesByAge` `:637`, `pruneMapByCount` `:656`, `findBestTokenVersion` `:669`, `:4058-4303` (13 methods), `archiveToken` `:6646`, the direct tombstone push in `removeToken` `:4007-4016` |
| `history-store.ts` | History cache, dedup-key upsert, the **three** load paths kept as three named methods. Owns the owner+epoch re-init race guard. | 340 | `computeHistoryDedupKey` `:119`, `getHistory` `:4312`, `addToHistory` `:4349`, `loadHistory` `:4430`, `hydrateHistoryFromServer` `:4491`, `historyEntryFromWire` `:4575`, `tryDecryptField` `:4606`, `importRemoteHistoryEntries` `:4621`, fields `:1145-1148` |
| `token-store.ts` | **The pivot file.** The money map + persistence: `tokens`, `parsedTokenCache`, CRUD with dedup/state-replacement, engine→UI bridge, `validate()`, and whole-blob TXF save/create/load. Exposes both Maps as the SAME instances `SpendQueue` closes over. | 520 | `notifyTokenChange` `:1252`, `rebuildParsedTokenCache` `:2630`, `getTokens` `:3772`, `getToken` `:3791`, `addToken` `:3819`, `updateToken` `:3926`, `removeToken` `:3992`, `storeEngineToken` `:4794`, `cacheEngineParsedToken` `:4825`, `validate` `:5183`, `save` `:6689`, `createStorageData` `:6948`, `loadFromStorageData` `:6967` |
| `provider-sync.ts` | Multi-provider TXF sync (merge + hand-restore), storage-event subscription with its **own** debounce slot. | 300 | `sync` `:4886`, `_doSync` `:4904`, `subscribeToStorageEvents` `:5057`, `unsubscribeStorageEvents` `:5078`, `debouncedSyncFromRemoteUpdate` `:5094` |
| `runtime/pump.ts` | One polling-pump primitive replacing three hand-rolled (timer + inFlight + teardown) triples. Accommodates all three real shapes. | 90 | `:1385-1395`, `:1419-1421`, `teardownDeliveryPump` `:5450` (delivery half), `teardownPaymentRequestPump` `:5692`, `pumpIncomingDeliveries` `:5540`, `pumpIncomingDeliveriesFresh` `:5555`, `pumpPaymentRequests` `:5827` |
| `load-orchestrator.ts` | Boot/hydration: #642 single-flight + owner guard + trailing re-run, wake routing, inventory backstop + its OWN debounce slot, lazy-inventory projection, crash reconcile, legacy PENDING_V5 migration. | 330 | `load` `:1449`, `loadFresh` `:1460`, `loadWith` `:1475`, `mergeLazyInventory` `:2783`, `handleWake` `:5472`, `debouncedInventorySyncFromWake` `:5493`, `resyncInventory` `:5513`, the inventory half of `:5458-5468` |
| `incoming/ingest.ts` | `handleV2Transfer` — the ONE ingest shared by relay and mailbox: decode → `engine.verify` → `isOwnedBy` → dedup → store → emit → history. **One implementation of the verification gate.** | 190 | `handleV2Transfer` `:5284-5403` |
| `incoming/incoming-pump.ts` | Delivery-port pump: list → classify → batched claim/reject ack, poll timer + wake subscription, own single-flight. | 300 | `receive` `:3485`, `handleIncomingTransfer` `:5404`, `doPumpIncomingDeliveries` `:5567`, `classifyIncomingDelivery` `:5627`, `flushIncomingAcks` `:5661`, `resolveSenderInfo` `:4320`, `resolveTransportPubkey` `:5252` |
| `payment-requests/settling-journal.ts` | The #441 deferred-paid durable journal: single-flight load, tail-promise RMW, key-at-enqueue identity guard, corrupt-blob fail-open, **synchronous** in-memory read. Takes a **key RESOLVER**, not a key. | 210 | `prSettlingKey` `:5727`, `ensureSettlingJournalLoaded` `:5737`, `mutateSettlingJournal` `:5767`, `journalSettling` `:5800`, `clearSettling` `:5807`, `reconcileSettlingPaymentRequests` `:6257`, `resolveSettledPaid` `:6327`, `revertSettlingToPayable` `:6346` |
| `payment-requests/pr-store.ts` | Channel-agnostic PR domain state + the 20 public PR methods. Holds the pay→send→settle bridge. | 340 | `:2837-2914` (channel-agnostic half), `:2994-3212`, `:3265-3352`, `dispatchPaymentRequestResponse` `:3372`, `sendPaymentRequestResponse` `:3421` |
| `payment-requests/pr-walletapi-channel.ts` | S4 channel: capability probe, poll timer, persisted `?since=` cursor, once-per-session hydration (#556), memo ECDH decryption, terminal-status machine, `?before=` backfill. | 430 | `sendWalletApiPaymentRequest` `:2915`, `paymentRequestsApi` `:5679`, `:5692-5726`, `:5822-5906`, `decryptPaymentRequestMemo` `:5907`, `PR_WIRE_STATUS` `:5921`, `PR_TERMINAL` `:5927`, `surfaceIncomingPaymentRequest` `:5945`, `:6048-6098` |
| `payment-requests/pr-transport-channel.ts` | Nostr channel: two thin mappers + inline transport send/respond legs. **Deliberately NOT merged** with wallet-api ingest. | 95 | `handleIncomingPaymentRequest` `:3213`, `handlePaymentRequestResponse` `:3353`, transport branches of `:2850-2904` and `:3461-3479` |
| `send/intent-payload.ts` | The E.3 payload contract: build, encrypt, decrypt. The `direct` array ORDER is the `(transferId, opIndex)` pairing contract — isolating it makes that testable. | 130 | `materializeSelectedSources` `:2684`, `buildIntentPayload` `:2717`, `uploadOutputBlob` `:2762`, the payload decrypt in `resumeOpenIntents` `:6165-6185` |
| `send/certification-ledger.ts` | The caller-owned record of what has irreversibly happened. **Passed BY REFERENCE.** | 70 | `committedOnChainTokenIds` `:1923`, `committedDeliveredAmount` `:1929`, `deliveryPending` `:1932`, resume's `spent`/`conflicted`/`undeliveredAmount` `:6398-6404` |
| `send/intent-executor.ts` | **THE unification**: the single (certify → journal → deliver → applyDelta → remove-source) primitive, with **`ConflictPolicy` as a parameter**. Rethrows every engine error UNWRAPPED. | 470 | `:2163-2296` + its resume twin `:6398-6524`, the applyDelta branch `:2298-2346` + `:6534-6545`, the `deliverBlob` closure `:2349-2359` + `:6367-6392`, source removals `:2213`/`:2290`/`:2344` + `:6549-6580` |
| `send/failure-disposition.ts` | **PURE** classification of a failed send. No I/O, no `this`. Exhaustive decision table. | 180 | `:2425-2445`, `:2447-2483`, `:2536-2560`, `:2562-2586`, `:2588-2591` |
| `send/send-flow.ts` | `sendOnce`: re-plan loop, recipient/coin resolution, the SYNCHRONOUS critical section (moved as one unbroken block), the intent PUT with #670 422 handling, the restore loop. | 620 | `send` `:1785`, `demoteSuspectedSpent` `:1867`, `sendOnce` `:1899-2600` minus the bodies that went to the executor/disposition |
| `send/resume-flow.ts` | E.3 resume over the SAME executor with `'skip-leg'` policy. | 420 | `resumeOpenIntents` `:6099`, `resumeIntent` `:6358-6645` minus the executor bodies |
| `mint.ts` | v2 engine self-mint. Free function over `(engine, storeEngineToken)`. | 75 | `mintFungibleToken` `:4769` (guard), `mintFungibleTokenV2` `:4845` |

---

## 3. Ordered stages

Ordering is strictly **risk-ascending**. Every stage through S13 ships standalone value; abandonment at any point leaves the tree strictly better than HEAD.

---

### Stage 1 — Delete provably-unreferenced **private** members
**Risk: mechanical · Depends on: none · Executable today**

Delete, with a grep transcript for each in the PR body:

| Member | Site | Proof |
|---|---|---|
| `fromHex` | `:545-554` | Single hit in the file; `hexToBytes` from `core/crypto` is used instead (`:86`). Not compiler-flagged because `noUnusedLocals: false` |
| `createTombstoneFromToken` | `:574-592` | Single hit repo-wide; tombstones built inline in `removeToken`/`addToken` |
| `export interface ProofPollingJob` | `:715-730` | Single hit repo-wide (v1 NOSTR-FIRST relic). Leaks via `export *` but **not named** in root `index.ts:262-269` |
| unused `type ParsedTokenPool` import | `:45` | Single hit; `ParsedTokenEntry` from the same statement IS used (`:1177`) |
| `reloadNametagsFromStorage` | `:4744-4761` | Zero self-calls; the only other repo hit is a **test title string** at `PaymentsModule.test.ts:941` whose body drives `load()` |
| the `internal?` 2nd param of `send`/`sendOnce` | `:1787`, `:1901`, `:1914`, `:1971-1977` | Only producer was `instantSplitSend`, removed at the v1 cutover. `:1808`/`:1822` are always-true, `:1973-1976` unreachable |

**Do NOT touch any public member in this stage** — `updateToken`, `getNametags`, the `prune*`/`merge*`/`getForkedTokens`/`getBestArchivedVersion` family are unused **but published** on a class exported at `index.ts:259`. They are Stage 2.

- **Files touched:** `PaymentsModule.ts` only.
- **Lines deleted:** ~120. Moved: 0.
- **Verification:** `npm run typecheck && npm run lint && npm run build && npm run test:run` — all green with **`git diff --stat tests/` empty**. That emptiness *is* the proof: if any member were reachable, the compiler or a test would fail. Commit the six `grep -rn '<name>' --include=*.ts .` transcripts.

---

### Stage 2 — Public-surface cleanup (API change, **not** a refactor)
**Risk: low · Depends on: 1**

This is the only stage that alters the package's advertised surface. It is deliberately isolated so no refactor PR ever smuggles an API change.

**Delete (with docs + CHANGELOG in the same PR):**
- `getPendingTransfers()` `:5236-5238` + field `pendingTransfers` `:1035` + its reset `:1315` + the `PENDING_TRANSFERS` restore block `:1649-1657`. **Nothing repo-wide writes that key** (`grep 'set(STORAGE_KEYS_ADDRESS.PENDING_TRANSFERS'` → zero), so the map is permanently empty and the method always returns `[]` — a documented lie. Keep the key in `constants.ts` (`wallet-clear.test.ts:241` and the network-isolation suites assert on it).
- `waitForPendingOperations()` `:3565-3573` + field `pendingBackgroundTasks` `:1036` + push `:1910` + `finally` `:2595`. `core/Sphere.ts:2462` is a **comment** reading *"No destroy, no waitForPendingOperations — old address keeps running."* The array is an unbounded leak: only the dead method drains it.

**Required doc edits (both plans missed these):** `docs/API.md:634`, `docs/INTEGRATION.md:577`, plus a CHANGELOG `[Unreleased]` entry noting `ProofPollingJob` left the `export *` surface (Stage 1).

**Mark `@deprecated`, do NOT delete** — all are documented at `docs/API.md:499-543` and are instance methods on a class exported at `index.ts:259`, so they appear in `dist/index.d.ts`: `pruneTombstones`, `getBestArchivedVersion`, `mergeArchivedTokens`, `pruneArchivedTokens`, `getForkedTokens`, `storeForkedToken`, `mergeForkedTokens`, `pruneForkedTokens`, `updateToken`, `getNametags`.

- **Lines deleted:** ~40 (+ ~10 doc lines changed).
- **Verification:** full suite green; `dist/index.d.ts` diff shows **exactly two** removed members and ten added `@deprecated` tags, nothing else.

---

### Stage 3 — Characterization tests. **NO production change.**
**Risk: mechanical · Depends on: 1**

Six new test files, **zero source edits**. See §6 for full specifications and the cluster each covers. Every test must be **green against unmodified source** — a red one means the design assumption behind its stage is wrong.

- **Verification:** `git diff --stat tests/` shows **additions only**. Run each new file with `--repeat 5` to shake out ordering flakes. Then establish the crash-drill baseline: `npm run test:harness` (`package.json:124` → `vitest run --config vitest.harness.config.ts` → `tests/harness/crash-resume.test.ts`).

---

### Stage 4 — Move pure module-level values
**Risk: mechanical · Depends on: 1**
Creates `token-parsing.ts`, `payments-constants.ts`, `payments-internal.ts`.

Byte-identical cut/paste of `:102-694`, plus `export * from './token-parsing'` in `modules/payments/index.ts` **and** a re-export inside `PaymentsModule.ts` so even the deep import path used by `PaymentsModule.parseTokenInfo.test.ts` / `PaymentsModule.token-keys.test.ts` still resolves.

> **🔴 HAZARD — call this out in review.** `sdkDataCache` (`:436`) is a **module-scope Map shared by every `PaymentsModule` instance in the process** and it backs every tombstone, dedup, journal and history key derivation. It must move as **ONE unit** with `clearSdkDataCache`, and `initialize()`'s single clear call site (`:1314`) must keep pointing at the moved function. `token-parsing.ts` must be reachable **only** through the `modules/payments` graph so tsup does not instantiate it in a second bundle context (the documented `TokenRegistry` singleton hazard).

Convert the `payments-internal.ts` call sites in the same PR: `notifyAll()` replacing `:3244-3252`, `:3406-3413`, `:6031-6037` (do **NOT** fold in `notifyTokenChange` `:1252-1262` — different arity, two-argument callback, deliberately silent `catch {}`); `isForeignAddressMeta()` replacing the duplicated money-safety guard at `:1515-1521` and `:4939-4945` with the per-site log message left at the call site.

- **Lines moved:** ~580. Deleted: ~20 (dedup collapse).
- **Verification:** for each moved block commit the transcript of
  ```bash
  git show HEAD~1:modules/payments/PaymentsModule.ts | sed -n '<A>,<B>p' \
    | diff - <(sed -n '<C>,<D>p' modules/payments/token-parsing.ts)
  ```
  (empty modulo the import prologue). Then full suite green with **zero test edits**, and `dist/index.d.ts` byte-identical apart from source-map comments.

---

### Stage 5 — Move types and ports
**Risk: mechanical · Depends on: 4**
Creates `payments-deps.ts`, `wallet-api-port.ts`. Type-only, zero runtime change.

Root `index.ts:262-269` names `PaymentsModuleConfig`, `PaymentsModuleDependencies`, `PaymentsWalletApiPort`, `ReceiveOptions`, `ReceiveResult`, `TransactionHistoryEntry` explicitly — all six must resolve identically. Keep `wallet-api-port.ts` free of any browser/IPFS/Nostr import so the backend's import closure stays clean (CLAUDE.md: the backend consumes only `./token-engine`; this file is its adjacent contract).

- **Lines moved:** ~320.
- **Verification:** `npm run typecheck && npm run build`; diff generated `dist/index.d.ts` — **byte-identical** apart from source-map comments. Full suite green, zero test edits. Add an import-closure assertion: `grep -nE "impl/browser|ipfs|nostr" modules/payments/wallet-api-port.ts` → empty.

---

### Stage 6 — `coin-meta.ts` + `balances.ts`
**Risk: low · Depends on: 3, 5**

`getAssets` does **not** go through the `getCoin*` facade — it calls `TokenRegistry.getInstance()` directly at `:3632` and `:3653`. Both call paths move into `coin-meta.ts` so the singleton has exactly one access path.

**Behavior-preserving exhaustive switch.** `accumulateToken` `:3732-3747` names only `'transferring'` and `'confirmed'`; every other status falls into `unconfirmedAmount`, which `aggregateTokens:3714` folds into `totalAmount` as spendable. Replace the catch-all `else` with an explicit `switch (token.status)` that **enumerates every current status into exactly the bucket it lands in today** (pinned by the Stage 3(b) table) and adds a `default: assertNever(status)` compile-time guard. **Do not change any bucket assignment** — a future status must fail the build rather than silently become displayed spendable balance.

- **Lines moved:** ~235.
- **Verification:** Stage 3(b) table passes unchanged (zero rows edited). `PaymentsModule.test.ts:574-786` green.

---

### Stage 7 — `TokenStorageRegistry`
**Risk: low-medium · Depends on: 3, 5**

Collapses **four** independently-written implementations of "the first non-disabled provider" — `getActiveTokenStorageProvider:2643-2646` (`.values().next()`), `save()`'s `activeId = providers.keys().next().value` `:6706` (which gates the critical-save **THROW** at `:6718` vs `storage:degraded` at `:6721`), `firstEnabledTokenStorage:975-1005` (feeding `assertLegalCustodyComposition:1006`), and `getLocalTokenStorageProvider:4650-4659` (`type==='local'` else first) — into **one** `active()`.

Add `snapshot()`: a send holds one for its whole duration so `updateTokenStorageProviders()` cannot re-designate custody between `materializeSelectedSources` `:2692` and the post-certification `applyDelta` `:2320`.

- **Lines moved:** ~100. Deleted: ~35.
- **Verification:** Stage 3(c) proves all four sites name the same id for a two-provider composition (today `PaymentsModule.fail-closed.test.ts:232-268` composes exactly **one**, so any re-ordering is invisible). `provider-disable-sync.test.ts`, `token-storage-network.test.ts` green.

---

### Stage 8 — `PendingDeliveryJournal`
**Risk: low · Depends on: 3, 7**

Move `:6746-6946` (14 methods) + the 4 exclusively-owned fields into `class PendingDeliveryJournal`.

**Construct in the CONSTRUCTOR, not `initialize()`.** `journalMutation` `:1201` has **no reset anywhere** (writes only at `:6765-6766`); re-creating the object mid-flight produces two independent locks over one storage key — the exact #517 regression.

Constructor takes **live getters** per R1: `{ storage: () => StorageProvider, delivery: () => DeliveryProvider | null, emit: EmitFn, senderNametag: () => string | undefined }`.

Keep facade delegators per R3: `savePendingV2Delivery`, `replayPendingV2Deliveries`, and `replayBackoffBaseMs`/`deliveryDeferralMs` as get/set accessors.

**Four preservations, each written into the code as a comment, not the commit message:**
1. **Journal-BEFORE-deliver.** `tryDeliver` `:6798-6817` moves whole and already encapsulates "clear only after a successful deliver". Call sites keep their save→deliver order untouched (`:2191`→`:2200`, `:2256`→`:2279`, `:6372`→`:6383`).
2. **ONE mutex.** `withJournalLock` `:6764` moves with all its users (`:6771`, `:6781`, `:6939`).
3. **`journaledByOp` keeps its deliberate NON-filtering** of `undeliverable`/`deferredUntil` (`:6756-6759`) while `replayAll` keeps its filter (`:6838-6841`). Inverting this makes resume re-run `engine.transfer` on a spent source.
4. **`tokenBlob` stays the primary key** and the persisted **ARRAY ORDER** is preserved (`byOp`'s `e.opIndex ?? i` positional fallback is the legacy op pairing). **Never convert the blob to a keyed Map.**

- **Lines moved:** ~230.
- **Verification — three gates:**
  - **Sole-writer grep gate (mechanical proof, not prose):**
    ```bash
    grep -rn 'PENDING_V2_DELIVERIES' modules/ constants.ts
    ```
    must hit **only** `modules/payments/delivery-journal.ts` and `constants.ts`. Verified today the key is written at `:6775`, `:6785`, `:6944` and read at `:6747`, all inside `withJournalLock`. Add this as a CI grep step.
  - `PaymentsModule.wallet-api-delivery.test.ts` (all 50+ cases incl. the two overlapping replays at `:719-731`), `PaymentsModule.v2-send-recovery.test.ts` — zero test edits.
  - **`npm run test:harness`** — required manual gate.

---

### Stage 9 — Delete the write-only OUTBOX
**Risk: low · Depends on: 8**

Delete `saveToOutbox`/`removeFromOutbox`/`loadOutbox` `:6725-6743` and their three call sites (`:2047` pre-send, `:2352` success exit, `:2530` failure exit). Provably write-only: `loadOutbox` has exactly two callers, both inside the pair that writes it, and the code says so at `:2527` — *"The pre-send outbox snapshot can recover nothing (finished blobs are journaled in PENDING_V2_DELIVERIES)."* It costs three storage round-trips on the send hot path and is an unserialized read-modify-write two concurrent sends can interleave.

Keep `STORAGE_KEYS_ADDRESS.OUTBOX` in `constants.ts` and in `NETWORK_SCOPED_ADDRESS_KEYS` — the four network-isolation/clear suites assert only that the **key** is scoped, which stays true.

**One test is deleted with the code:** `PaymentsModule.tokenTransfers.test.ts:237` *"send — outbox lifecycle"*. **This is not weakening a test** — it pins writes to a journal nothing reads. The recovery role it appears to cover belongs to `PENDING_V2_DELIVERIES` and *is* covered by `PaymentsModule.v2-send-recovery.test.ts:169` and `PaymentsModule.wallet-api-delivery.test.ts:523`. State this justification in the PR body; it is the only test deletion in the entire programme.

- **Lines deleted:** ~25 + 3 call sites.
- **Verification:** full suite + `npm run test:harness` green. Confirm the send path lost exactly 3 `storage.set` calls.

---

### Stage 10 — `TxfArchiveStore` + `HistoryStore`
**Risk: medium · Depends on: 3, 4, 7** · *Two independent PRs; may land in parallel*

**10a `txf-archive-store.ts`** — the four parallel TXF satellite stores behind one object. `archiveToken`'s fork branch (`:6656-6663`) **moves verbatim, including the fork case**: `archivedTokens` is read by `AccountingModule` at `:404`, `:1054`, `:1431`, `:4057` and feeds `_scanTokenForAttribution`/`_processTokenTransactions` — i.e. **invoice payment attribution**. Removing or altering that branch silently changes an accounting input. Gated on Stage 3(a), which is the first test that exercises the fork path at all.

**10b `history-store.ts`** — the three load paths kept as three explicitly-named methods. Owns `historyHydratedFor`/`serverSeenHistoryKeys`/`incrementalHistoryPulls`/`hydrationEpoch`; the epoch is bumped by `initialize` `:1324` and re-checked at `:4544` — the guard must span the new boundary via a `reset(owner)` that bumps the epoch.

- **Lines moved:** ~250 + ~310.
- **Verification:** Stage 3(a) green unchanged. `PaymentsModule.tombstone.test.ts`, all four history suites, `PaymentsModule.journey-backlog.test.ts` green, zero edits.

---

### Stage 11 — `TokenStore` + `ProviderSync`
**Risk: medium-high · Depends on: 3, 10** · *The pivot*

`TokenStore` exposes `tokens` and `parsedCache` as the **SAME instances** `SpendQueue` closes over (R2) and takes an injected `onCoinChanged(coinId)` so the **parsed-cache-before-wake** ordering is enforced in one place instead of four.

> **Encapsulation that must be explicit, not theatre.** `_doSync` writes the token map **directly** — `this.tokens.set(tokenId, token)` at `:4986`, deliberately bypassing `addToken`'s dedup/state-replacement rules — and calls `loadFromStorageData` `:4952` and `rebuildParsedTokenCache` `:4997`. If `TokenStore` exposes only `add()/update()/remove()`, `_doSync`'s restore loop is **inexpressible**. Resolution: `TokenStore` exposes a single named privileged method `restoreRaw(tokens: Iterable<Token>)` with a doc comment stating it is the **only** bypass of the dedup rules and that `ProviderSync` is its **only** caller. Enforce with a CI grep: `grep -rn 'restoreRaw' modules/` must hit exactly `token-store.ts` and `provider-sync.ts`.

**Preserve verbatim:** `loadFromStorageData:6976-6987` preserves `status === 'transferring'` tokens across its `tokens.clear()` `:6983`. Without it, the next `save()` (`:6706`, serializing `Array.from(this.tokens.values())`) persists a token set with an in-flight send's source **missing**, which `sendOnce`'s restore loop then skips forever via `if (!this.tokens.has(token.id)) continue` `:2493-2495`. Any `replaceAll()`-shaped primitive loses this silently.

Give `ProviderSync` its **own** debounce slot — today `syncDebounceTimer` `:1152` is shared by two semantically different debouncers (`:5095` `sync()` vs `:5498` `resyncInventory(true)`) and `unsubscribeStorageEvents:5084-5086` clears it. See BUG-2.

- **Lines moved:** ~520 + ~300.
- **Verification:** Stage 3(f) (transferring-preservation + cache-before-wake ordering) and 3(e) green unchanged. `PaymentsModule.tombstone.test.ts`, `PaymentsModule.v2-validate.test.ts`, `PaymentsModule.history-sync.test.ts` green. **`npm run test:harness`.**

---

### Stage 12 — `LoadOrchestrator` + `runtime/Pump` + `incoming/`
**Risk: medium-high · Depends on: 11**

> **🔴 Two semantics that a "mechanical" move would silently change.**
>
> **(i) `this.loaded` has NO `reset()`.** Verified: written at exactly **one** site, `:1658`, and deliberately never reset by `initialize` `:1287-1448` or `destroy` `:1719-1783`. **Five** barrier readers short-circuit on it — `:5289`, `:5406`, `:5569`, `:5838`, `:6105` (`handleV2Transfer`, `handleIncomingTransfer`, `doPumpIncomingDeliveries`, `doPumpPaymentRequests`, `resumeOpenIntents`). `LoadOrchestrator` **must NOT get a `reset()` that touches `loaded`** — that would change all five at once. Its `reset(owner)` resets only `loadInFlight`/`loadInFlightOwner`/`loadRerunRequested`/`loadRerunTimer`.
>
> **(ii) `barrier()` must reproduce the guard exactly:**
> ```ts
> if (!this.loaded && this.loadedPromise) await this.loadedPromise;
> ```
> **not** a bare `await this.loadedPromise` — otherwise every post-load caller gains an await turn.

`runtime/Pump` must accommodate all three real shapes: coalesced with a drain-then-restart bypass (delivery), uncoalesced riding `loadWith`'s own single-flight (inventory), capability-gated (payment-requests). It does **not** unify `pumpHealth` channel names.

`incoming/ingest.ts` keeps `handleV2Transfer` as **one** named unit so the `engine.verify` + `isOwnedBy` gate has exactly one implementation. Facade keeps private shims for `handleV2Transfer` and `handleIncomingTransfer` (R3 — 4+ test files and an e2e treat these names as a de-facto contract).

- **Lines moved:** ~330 + ~90 + ~490.
- **Verification:** `PaymentsModule.load-coalescing.test.ts`, `receive-fresh-pump.test.ts`, `wake-consumers.test.ts`, `wake-reconnect.test.ts`, `v2-receive.test.ts`, `pump-health.test.ts`, `address-switch-*` integration suites — all green, zero edits. Add an explicit assertion that a post-load `handleV2Transfer` call performs **zero** extra microtask turns vs HEAD.

---

### Stage 13 — `payment-requests/`
**Risk: medium-high · Depends on: 8, 12**

Three files: `settling-journal.ts`, `pr-store.ts`, `pr-walletapi-channel.ts`, `pr-transport-channel.ts`.

**Refusal 1 — do NOT build a shared `DurableJournal<T>`.** The two journals share only the ~30-line tail-promise mutex. The delivery journal is stateless (re-reads storage, static key, `withJournalLock` `:6764`); the settling journal materializes an in-memory Map read **synchronously** from the view path `:5967`, with a single-flight loader `:5737-5765`, a corrupt-blob fail-open `:5748-5755`, a **dynamically recomputed** key `:5727`, and a `keyAtEnqueue` drop rule `:5775-5789`. Each journal gets its **own** serializer instance.

**Refusal 2 — do NOT merge the two incoming PR ingests.** Verified the namespaces genuinely differ: transport sets `senderPubkey` from the **32-byte x-only** transport key `:3221` and `requestId` from the inner protocol id `:3232`, notifying **unconditionally**; wallet-api sets both from `wire.id`/`fromPubkey` `:6011` and notifies **only when `status === 'pending'`** `:6027`. And `payPaymentRequestInner:3126` feeds `senderPubkey` **straight into `send({recipient})`**. A unified ingest routes a payment into the wrong key namespace. Two mappers over one channel-tagged domain type.

**Preserve:** `SettlingJournal` takes a **key resolver**, re-checked at enqueue, not a captured key. `peek()` stays **synchronous**. `resolveSettledPaid:6335-6341`'s swallow of a 409 non-open conflict **must be preserved verbatim** — it is currently the only thing bounding the damage from BUG-3.

- **Lines moved:** ~1,075.
- **Verification:** `PaymentsModule.payment-requests.test.ts` (1,004L, both the S4 path at `:197` and the Nostr fallback at `:976`), `address-switch-payment-request-bleed.test.ts`, `tests/harness/two-wallet-flow.test.ts`, `multi-session-sync.test.ts` — green, zero edits.

---

### Stage 14 — The send pipeline. **Three separate PRs.**
**Risk: HIGH · Depends on: 8, 11, 13**

Split into three so no single diff exceeds ~250 relocated lines. This is the direct answer to the judge's *"a 560-line relocation is unreviewable"*.

#### 14a — `intent-payload.ts` + `certification-ledger.ts` + `intent-executor.ts`

> ### 🔴 CONFLICT POLICY IS A PARAMETER. The two loops are NOT copies on this axis.
>
> They share the STEP, not the LOOP. Verified verbatim:
> - **send** (`:2180-2189`) **rethrows** `TransferConflictError` out of the loop — the plan is stale, re-plan under a **NEW** `transferId` — tagging `err.conflictedSourceId` **only when `committedOnChainTokenIds.size === 0`**.
> - **resume** (`:6421-6432`) **catches per-leg**, sets `conflicted = true`, adds `engine.balanceOf(source, payload.coinId)` to `undeliveredAmount`, and **NEVER pushes the leg to `spent`**; `:6520` then throws `firstConflict` if `spent.length === 0`.
>
> A mechanical unification either makes send forward-complete a stale plan or makes resume abort a recoverable intent. **Both are double-pay classes.**
>
> ```ts
> type ConflictPolicy = 'rethrow' | 'skip-leg';
> ```
> Both policies keep their own tests.

> ### 🔴 The ledger is passed BY REFERENCE. Put this paragraph **in the code**.
> ```
> CertificationLedger is constructed by the CALLER and passed in by reference.
> A throw mid-execution therefore leaves the caller holding the same live object
> with its partial state. If it were passed by value, or returned only on success,
> the restore loop at :2499 would see an empty set, fall through to the isSpent
> probe whose catch at :2503-2506 restores OPTIMISTICALLY, and a certified-spent
> source would be re-marked 'confirmed' — re-entering the spend pool as money
> that is already gone.
> ```

**No-wrap rule, tested.** The executor rethrows every engine error **UNWRAPPED**. `keepOpen` at `:2467-2472` is computed from the error **CLASS** (`ProofUnconfirmedError | CheckpointPersistFailedError | SplitCheckpointLostError | CheckpointTrustbaseMismatchError`; plus `TransferConflictError` at `:2476`). One generic re-wrap and `:2476` aborts an intent whose spend may be on-chain.

**Per-leg source removal stays in the executor.** `:2213` performs `await this.removeToken(...)` on the non-`serverApply` path **inside** the loop. `ExecContext` therefore includes a `removeSource(uiTokenId, opId, stateHash)` callback. Moving it after the loop widens the per-leg crash window — do not.

**`EMPTY_MAP` on the send hot path.** Once `internal` is deleted (Stage 1), `result.id` `:1914` is always a fresh `randomUUID()`, so send passes `journaled = EMPTY_MAP` instead of calling `byOp()` — behavior-identical, one fewer storage read per send.

- **Lines moved:** ~600. Deleted: ~130 (the duplicate op bodies).
- **Verification — five gates:**
  1. Stage 3(d) (six resume payload shapes) and 3(g) (disposition table) pass with **zero edits**. An edit to a characterization test here *is* the signal that behavior changed.
  2. New: *"executor throws on leg 1 → the caller's `ledger.has(leg0)` is true and `deliveredAmount` reflects leg 0 only."*
  3. New: **all five** keep-open error classes survive the executor `instanceof`-intact.
  4. New: `realizeFromSplitPlan(plan)` and `realizeFromIntentPayload(toIntentPayload(plan))` emit identical `(kind, opIndex, genesisId)` sequences.
  5. **`npm run test:harness`** — the ONLY end-to-end proof send and resume still agree (SIGKILL at the first `POST /v1/inventory/apply`, fresh process from the same seed, `resumeOpenIntents`, assert exactly-once delivery and one dedupKey'd SENT row). **Required manual gate.**
  6. Mechanical body-diff: extract pre-refactor `:2163-2296` and `:6398-6524` and the post-refactor executor, normalize whitespace, show the executor is their **union with the policy branch as the only structural difference**.

#### 14b — `failure-disposition.ts` (pure)

Extract `classifyFailure(error, facts) → { keepOpen, abortIntent, events, outcome, stampTransferId }` from `:2425-2591`. **No I/O, no `this`.** Every double-pay incident in this file's history is a wrong answer from that one decision: #631 (`:2467`), #665 (`:2545`), #670 (`:2114-2115`), #676, #677 (`:2571-2583`). Highest money-safety return per line in the programme.

**Does NOT move:** the token restore loop `:2485-2519`. It mutates `this.tokens` and `parsedTokenCache` and carries the **parsed-cache-before-queue-wake** ordering (`:2507-2534`, with the explicit comment *"Notify queue AFTER cache is rebuilt"*). It stays with `TokenStore`, called by the orchestrator with the disposition in hand.

- **Lines moved:** ~190.
- **Verification:** the Stage 3(g) table is re-pointed at the extracted pure function with the **same table and the same expectations** — a behavior-preserving extraction changes **zero rows**. Plus `fail-closed.test.ts` (#515 F1/F2, #516, #670), `wallet-api-delivery.test.ts:1034` and `:1072`, `v2-send-recovery.test.ts:148/:205/:240`, `payment-requests.test.ts:481`. **`npm run test:harness`.**

#### 14c — `send-flow.ts` + `resume-flow.ts`

What remains of `sendOnce` and `resumeIntent` collapses onto the pipeline.

> ### 🔴 The synchronous critical section moves as ONE unbroken block.
> `:2005-2010` (the `pendingChangeAmount` scan over `this.tokens`) and `:2012` (`spendPlanner.planSend`) must remain adjacent. `buildParsedPool` `:1995` is the last legal `await` before it; `waitForEntry` `:2018` the first after.
>
> **Ship a structural CI lint rule in this same PR**, not just a test — a test can pass by scheduling luck:
> ```js
> // eslint local rule: no-await-in-spend-critical-section
> // Fails the build if an `await` token appears between the marker comments
> //   // <<< SPEND-CRITICAL-SECTION-BEGIN
> //   // >>> SPEND-CRITICAL-SECTION-END
> ```
> Wrap the block in those markers when it moves.

**Collapse `resumeIntent`'s internal clone:** `:6598-6608` and `:6626-6636` differ only in `amount` and `tokenId`. One local `writeSent(amount, tokenId)` closure inside `resume-flow.ts`, **keeping the `v2_` prefix form** both currently emit (AccountingModule's `token.id` lookups and ledger keys expect it).

- **Lines moved:** ~1,040. Deleted: ~30.
- **Verification:** Stage 3(e) (two overlapping `payments.send()` through the module) green; the new lint rule green; the full send/resume suite green with zero edits; **`npm run test:harness`**.

---

### Stage 15 — `mint.ts` + facade cleanup
**Risk: low · Depends on: 11, 14c**

Extract `mint.ts`. Then `initialize()` becomes `for (const c of this.collaborators) c.reset(owner)` + subscription install, and `destroy()` becomes `dispose()`.

**`initialize()` and `destroy()` do NOT share one `teardownAll(reason)`** — verified they differ substantively: `destroy` clears `paymentRequestHandlers`/`paymentRequestResponseHandlers` (`:1734-1735`) and `initialize` **deliberately does not** (app-registered `onPaymentRequest` observers must survive an address switch). `initialize` additionally clears seven maps, bumps `hydrationEpoch`, and rebuilds the SpendQueue. Only the `loadRerunTimer` clear (`:1325-1329` / `:1723-1727`) is a genuine clone.

`tokenChangeCallbacks` `:1161` is **not** cleared by either — that survives by design.

- **Lines moved:** ~75. Facade wiring: +~120.
- **Verification:** `PaymentsModule.test.ts`, `PaymentsModule.v2-mint.test.ts`, `Sphere.status.test.ts`, all address-switch integration suites green.

---

### Stage 16 — Install the tripwire
**Risk: mechanical · Depends on: 15**

Add a CI line-budget check so this never recurs (root cause #5: *"no size budget, no tripwire, and the project's own size accounting went stale"*):

```bash
# scripts/check-file-budget.mjs — fails the build past the cap
modules/payments/PaymentsModule.ts          1400
modules/payments/send/*.ts                   700
modules/payments/payment-requests/*.ts       500
modules/accounting/AccountingModule.ts      <current+0>   # freeze, do not grow
modules/swap/SwapModule.ts                  <current+0>
core/Sphere.ts                              <current+0>
```

Update CLAUDE.md's stale "File Size Reference" in the same PR.

---

## 4. Verified deduplication list

| ID | Duplication | Sites | Lines saved | Killed by |
|---|---|---|---|---|
| **D-1** | **The send/resume execution pipeline** — `engine.transfer`, `engine.split`, journal-then-deliver, applyDelta, source removal, all written twice | `:2163-2296` + `:6398-6524`; `:2298-2346` + `:6534-6545`; `:2349-2359` + `:6367-6392`; `:2213`/`:2290`/`:2344` + `:6549-6580` | **~130** | **14a** (with `ConflictPolicy` — the two are NOT copies on the conflict axis) |
| **D-2** | Four "first non-disabled provider" implementations with three different rules | `:2643-2646`, `:6706`, `:975-1005`, `:4650-4659` | ~35 | **7** |
| **D-3** | `parseTokenInfo`'s genesis vs state `coinData` branches — 37-line literal clone, differing only in `tokenId` source | `:348-379` vs `:386-416` | ~28 | **4** (extract `coinDataToInfo(coinData, tokenId)`) |
| **D-4** | Three pump triples (timer + inFlight coalescer + teardown); two identical single-flight wrappers | `:1385-1395`, `:1419-1421`, `:5449-5460`, `:5692-5697`, `:5537-5544`, `:5827-5835` | ~18 | **12** (`runtime/Pump`) |
| **D-5** | Three handler-notify loops with identical try/catch/debug-swallow (two share the exact log string) | `:3244-3252`, `:3406-3413`, `:6031-6037` | ~14 | **4** (`notifyAll`) |
| **D-6** | `receive()`'s two branches duplicate the before/after token-map diff loop (guard polarity inverted, semantically identical) | `:3496-3507` vs `:3533-3545` | ~15 | **12** |
| **D-7** | Provider-address money-safety guard duplicated byte-for-byte | `:1515-1521` vs `:4939-4945` | ~12 | **4** (`isForeignAddressMeta`) |
| **D-8** | `resumeIntent`'s two SENT-history tails (differ only in `amount` + `tokenId`) | `:6598-6608` vs `:6626-6636` | ~10 | **14c** (`writeSent` closure) |
| **D-9** | Outgoing-PR construction + no-throw catch tail cloned across the two channels | `:2874-2903` vs `:2955-2984` | ~12 | **13** |
| **D-10** | `validate()`'s mark-invalid tail written twice | `:5201-5203` vs `:5218-5220` | ~4 | **11** (hoist a local `markInvalid`) |
| **D-11** | `addToken` calls `notifyTokenChange` **twice** (`:3902` and `:3910`, separated by an `await`) — merge artifact from `a6d0d1d1` (#107) and `59dd54f2` (#109) | `:3902`, `:3910` | 2 | **BUG-1** — behavior change, see §5 |
| **D-12** | Dead OUTBOX journal (write-only, unserialized RMW, 3 storage round-trips per send) | `:6725-6743` + `:2047`/`:2352`/`:2530` | ~25 | **9** |
| — | **Total** | | **~305** | |

---

## 5. 🔴 Latent bugs — SEPARATE bug-fix PRs, NOT refactor stages

**A refactor PR must never smuggle a behavior fix.** Each of these gets its own GitHub issue and its own PR. None is a prerequisite for any refactor stage, but **BUG-3 and BUG-4 should be filed before Stage 13 and 14 respectively** so the reviewer of those relocations knows the defect is known and deliberately preserved.

### BUG-A 🔥 — Payment-request happy path can double-pay after reload
**Severity: HIGH (money). File before Stage 13.**

`payPaymentRequestInner`'s **success** path flips status to `'paid'` **in memory only** (`:3133`) and then does a best-effort `sendPaymentRequestResponse` whose failure is **merely logged** (`:3134-3138`, verified: `catch { logger.warn(...) }`). `journalSettling` has exactly **one** call site — `:3170`, inside the *possibly-committed* catch.

So: **successful send + failed respond + reload** → `surfaceIncomingPaymentRequest` (`:5964-5981`) finds `wire.status === 'open'` and **no settling entry**, surfaces `'pending'`, and re-fires the handlers (`:6027-6037`). **The user pays twice.** This is the exact class of bug #441 fixed — on the happy path instead of the failure path. `this.paymentRequests` is in-memory only (see the #556 comment at `:1090-1096`), so nothing else covers it.

*Both candidate designs extract the settling journal in a shape that bakes in the assumption it covers pay outcomes; it covers one of two — and both make the gap harder to see afterward.*

### BUG-B 🔥 — Legacy `validate()` branch marks every v1 TXF token `'invalid'` on a gateway outage
**Severity: HIGH (data loss). Independent of every stage.**

`oracle/UnicityAggregatorProvider.ts:203-209` catches every RPC/network error and returns `{ valid: false, spent: false, error }`. The legacy branch at `PaymentsModule.ts:5215-5221` then marks **every** stored v1 TXF token `'invalid'` and **persists it** (`await this.save()` at `:5225`) — with **no transient-failure skip**, while the engine branch fifteen lines above (`:5205-5209`) has exactly that skip *and a comment explaining why* (*"never invalidate funds on an outage"*). Give the legacy branch the same guard.

### BUG-C — `reconcileInFlight` check-then-await-then-set race
**Severity: MEDIUM. File before Stage 13.**

`:6263` checks the flag, `:6264` `await this.ensureSettlingJournalLoaded()`, `:6267` sets it — **two concurrent resumes both pass**. Damage is currently bounded *only* because `resolveSettledPaid:6335-6341` swallows a 409 non-open conflict. **Any settling-journal extraction must preserve that swallow.** Fix = set the flag synchronously before the first await.

### BUG-D — `destroy()` is not a hard stop for writes
**Severity: MEDIUM (data loss window). File before Stage 14.**

`destroy():1719-1783` clears `this.tokens` (`:1752`, verified) and `parsedTokenCache` (`:1749`) but does **not** null `this.deps`, does **not** reset `this.loaded`/`this.loadedPromise` (`this.loaded` written only at `:1658`), and does not drain in-flight work. `ensureInitialized():7014` checks only `this.deps`, so it **still passes after destroy**. A send in flight at `destroy()` reaches its failure handler and runs `await this.save()` at `:2523` — **persisting the now-empty token map over the wallet's storage**. `core/Sphere.ts:3943`/`:3961` call `payments.destroy()` for every address module without draining. Fix = a `disposed` flag that makes `save()` a no-op and `ensureInitialized()` throw.

### BUG-E — `syncDebounceTimer` is shared by two semantically different debouncers
**Severity: LOW (delayed, not lost, convergence). Naturally fixed by Stage 11 — file it anyway so the fix is attributable.**

One field (`:1152`) is set/cleared by `debouncedSyncFromRemoteUpdate` `:5093-5117` (`sync()`) **and** `debouncedInventorySyncFromWake` `:5492-5501` (`resyncInventory(true)`) — each cancels the other. Worse, `unsubscribeStorageEvents:5084-5086` unconditionally clears it, and it is reachable from the **public** `updateTokenStorageProviders()` → `subscribeToStorageEvents:5059`, so a runtime provider swap silently drops a pending inventory-wake resync **even in a pure wallet-api composition with zero `onEvent` providers**. The 30s `inventoryPollTimer` backstop converges it. Note: today `destroy()` clears a pending inventory debounce *only because* the field is shared — the fix must clear the new field in `teardownDeliveryPump()`, which `destroy()` calls at `:1732` and `initialize()`'s prologue at `:1298`.

### BUG-F — `addToken` double-fires the public `onTokenChange` observer
**Severity: LOW. Independent.**

`notifyTokenChange(token)` at `:3902` **and** `:3910`, separated by `await this.cacheEngineParsedToken(token)` — subscribers fire twice on two different microtasks. `git blame` confirms the merge artifact: `:3902` from `a6d0d1d1` (#107), `:3910` from `59dd54f2` (#109). Harmless today (the only in-repo subscriber, `AccountingModule._handleTokenChange:4433-4479`, is watermark-idempotent), but `onTokenChange` `:1240` is **public API** — any third-party counting subscriber double-counts every received/minted/change token. Fix = delete `:3902`, keep the later one.

---

## 6. Characterization tests (Stage 3) — written BEFORE the risky stages

All six must be **green against unmodified source**. Cluster coverage and the exact gap each closes:

| # | File | Cluster | Gap it closes |
|---|---|---|---|
| **(a)** | `PaymentsModule.archives.test.ts` | `repo-archives` (~290L) | **ZERO tests exist today.** `AccountingModule`'s four real `getArchivedTokens` call sites are `vi.fn()`-stubbed at `accounting-test-helpers.ts:92`, so nothing exercises the implementation. Pin: **archive-vs-fork classification** (the branch at `:6656-6663`), union-merge counts, prune ordering (insertion-order oldest-first), and that every mutating merge/prune calls `save()`. **Gates Stage 10a.** |
| **(b)** | `PaymentsModule.balances-table.test.ts` | `balances` | A table driving **every** `TokenStatus` through `getBalance`/`getAssets`, pinning that `'spent'`/`'invalid'` are excluded, `suspectedSpent` is excluded (#625, filtered at `:3705`), `'transferring'` lands only in `transferring*` fields, and **every other status folds into `unconfirmedAmount`** (the current catch-all `else` at `:3743`). This is the contract Stage 6's exhaustive switch must reproduce row-for-row. **Gates Stage 6.** |
| **(c)** | `PaymentsModule.storage-registry.test.ts` | `storage-providers` | Compose **TWO** providers (local + mock IPFS) and pin that the FIRST non-disabled is active, that a save failure on the **active** provider **throws** under `critical:true` (`:6718`) and only emits `storage:degraded` otherwise (`:6721`), and that a non-active failure is log-only. Today `PaymentsModule.fail-closed.test.ts:232-268` composes exactly **one** provider, so any re-ordering refactor is invisible. **Gates Stage 7.** |
| **(d)** | extend `PaymentsModule.wallet-api-delivery.test.ts` | `delivery-journal` | (i) `tokenBlob` is the journal **PRIMARY key** (two entries with the same `transferId` + different blobs both survive); (ii) `journaledByOp`'s **positional** fallback for legacy entries with no `opIndex` (`e.opIndex ?? i`, `:6758`); (iii) `byOp` does **NOT** filter `undeliverable`/`deferredUntil` (`:6756-6759`) while `replayAll` **DOES** (`:6838-6841`) — inverting this makes resume re-run `engine.transfer` on a spent source. **Gates Stage 8.** |
| **(e)** | `PaymentsModule.send-critical-section.test.ts` | `send` | **THE most important new test.** Drive two overlapping `payments.send()` calls for the same coin **through the module** and assert one plans and the other queues. `PaymentsModule.concurrency.test.ts` does **not import PaymentsModule** (imports at lines 17-25 are `TokenReservationLedger`/`SpendPlanner`/`SpendQueue` only) and contains **zero `.send(` calls** — so inserting an `await` between the `pendingChangeAmount` scan (`:2005-2010`) and `planSend` (`:2012`), the single most likely send-extraction regression, currently leaves the entire suite green. **Gates Stages 11 and 14c.** |
| **(f)** | `PaymentsModule.store-invariants.test.ts` | `token-store` | (i) `loadFromStorageData` **PRESERVES** `status === 'transferring'` across its `tokens.clear()` (`:6976-6987`) — race a load against an in-flight send; (ii) `cacheEngineParsedToken` **completes before** `spendQueue.notifyChange` for the same coin (spy asserting the parsed cache already contains the change token when the wake fires). Neither is covered anywhere. **Gates Stage 11.** |
| **(g)** | `PaymentsModule.failure-disposition.test.ts` | `send` failure path | A table over `{TransferConflictError, ProofUnconfirmedError, CheckpointPersistFailedError, SplitCheckpointLostError, CheckpointTrustbaseMismatchError, PartialSendConflictError, plain Error, WalletApiError/422} × {certified 0 / >0} × {intentRejected} × {onChainCommitComplete}` asserting `abortIntent` called/not-called, the surfaced error class, and the events emitted. **Gates Stages 14a and 14b.** |
| **(h)** | `PaymentsModule.resume-intent.test.ts` | `resume` | Drive `resumeIntent` **directly** (today every assertion routes through `resumeOpenIntents`) across six payload shapes: `v:1` direct, `v:1` split, `v:2` split+checkpoint, journaled-op re-deliver, **one-leg conflict with another delivered**, **all-legs conflict**. The last two pin the `'skip-leg'` policy. **Gates Stage 14a.** |

Plus the standing gate: **`npm run test:harness`** baseline recorded in the Stage 3 PR body.

---

## 7. Non-goals and binding invariants

### Explicitly out of scope
- **No behavior fixes inside refactor PRs.** Every item in §5 is a separate issue + PR.
- **No public API deletions** beyond the two in Stage 2 (each with docs + CHANGELOG). The class is exported at `index.ts:259`; instance methods appear in `dist/index.d.ts`. **A repo-internal grep is the wrong test for a published SDK consumed by the Sphere frontend.**
- **No `DurableJournal<T>`.** The two journals share ~30 lines of mutex and nothing else.
- **No unified PR ingest.** Different pubkey namespaces, different id/requestId split, different notify condition.
- **No merge of `initialize()` and `destroy()` teardown** — they differ on handler retention by design.
- **No changes to** `SpendQueue.ts`, `TokenReservationLedger.ts`, `TokenSplitCalculator.ts`, `TransportDeliveryAdapter.ts`, `pump-health.ts`, `token-engine/`, `core/Sphere.ts`, or `modules/accounting/`.
- **No performance work**, except the two incidental wins that fall out of deletions: OUTBOX (−3 storage round-trips per send, Stage 9) and `EMPTY_MAP` (−1 storage read per send, Stage 14a).
- **No test weakening. No `.skip`, no `.only`.** Exactly **one** test is deleted in the entire programme (Stage 9), with its justification in the PR body.

### Invariants that constrain every stage

| Invariant | Enforced at | The failure mode |
|---|---|---|
| **Certified-spend terminality** | `:1923`, `:2186`, `:2253`, `:2493-2519`, `:1608-1633` | Ledger by value → empty set → the `isSpent` probe's `catch {}` at `:2503-2506` restores **optimistically** → a certified-spent source re-enters the spend pool |
| **Keep-open on `ProofUnconfirmedError` + the three checkpoint errors** | `:2467-2472`, `:2474-2483`, `:2581-2583`, `:6486` | Any generic error re-wrap erases `instanceof` → `:2476` aborts an intent whose spend may be on-chain → the caller re-issues `send()` on a different source → **double-pay** |
| **Same-`transferId` resume with stable `(transferId, opIndex)`** | `:2174`, `:2232-2234`, `:6417-6418`, `:6435`, `:2717-2761`, `:6205` | Re-pairing opIndexes makes the engine derive a different stateId → a second, conflicting transaction instead of idempotent recovery |
| **Status-agnostic resume** | `:6395-6412`, `:6423-6432`, `:6520`, `:6539-6544` | `journaledByOp` acquiring `replayAll`'s filter → resume re-runs `engine.transfer` on a spent source |
| **Journal-before-deliver, ONE mutex** | `:2191-2198`, `:2256-2274`, `:6372-6389`, `:6764-6797`, `:6938-6947` | Reordering loses the blob on a crash; two locks over one key is the **#517 regression** |
| **Conflict policy is opposite in send vs resume** | `:2180-2189` (rethrow) vs `:6421-6432` (skip-leg) | Unifying = a double-pay class in both directions |
| **The spend critical section is synchronous** | `:2005-2013`; last legal await `:1995`, first after `:2018` | One inserted `await` and concurrent sends stop queueing — **currently caught by no test** |
| **Parsed-cache before queue wake** | `:3905-3907`, `:3953-3958`, `:2507-2534`, `:4030`+`:4042` | Queued sends re-evaluate against a pool missing the change token → `SEND_QUEUE_TIMEOUT` while the money sits in the wallet |
| **In-flight source survives a wholesale reload** | `:6976-6987` | `save()` persists a token set without the source → the restore loop skips it forever (`:2493-2495`) |
| **Map insertion order == custody precedence** | `:2643-2646`, `:6706`, `:975-1005`, `:4650-4659` | Silently moves which provider's save failure is fatal (#515 F2) |
| **`this.loaded` is never reset; the barrier is `!loaded && loadedPromise`** | written only at `:1658`; read at `:5289`, `:5406`, `:5569`, `:5838`, `:6105` | A mechanical `reset()` changes five barrier readers at once; a bare `await` adds a turn to every post-load caller |
| **Ports rule (S7)** | `delivery.custody` at `:2077`, `:6365`; `assertLegalCustodyComposition` `:1006` | Custody is composition-time, never a per-call flag |
| **Per-address AND per-network storage scoping** | `isNetworkScopedAddressKey` in `constants.ts`; `prCursorKey:5701`, `prSettlingKey:5727` hand-build `${network}:${chainPubkey}` | Cross-network state bleed |
| **`token-engine/` stays browser/IPFS/Nostr-free** | `wallet-api-port.ts` must import nothing platform-specific | Breaks the backend's import closure |
| **`sdkDataCache` is process-wide and must not be duplicated across bundle contexts** | `:436`, cleared only at `:1314` | Two caches → divergent tombstone/dedup/journal/history keys |

---

## 8. Expected end state

| Metric | Value |
|---|---|
| `PaymentsModule.ts` today | **7,027 lines** (309,349 bytes) |
| Lines **deleted outright** | **~335** (Stage 1 ~120, Stage 2 ~40, Stage 9 ~25, dedup collapses D-2…D-10 ~150) |
| Lines **relocated** into 28 new files | **~5,600** |
| Lines **added back** as delegators + collaborator wiring | **~250** |
| `PaymentsModule.ts` residual | **~1,100 lines** — CI hard cap **1,400** |
| Largest remaining single file | `send/send-flow.ts` ~620 — CI cap 700 |
| Net repo delta | **−335 lines**, redistributed across 29 files, none over 700 |
| Test files added | **7** (~1,400 lines of characterization) |
| Test files **modified** | **0** through Stage 13; only the new Stage 3 suites are re-pointed in 14a/14b |
| Test files **deleted** | **1 case** (`PaymentsModule.tokenTransfers.test.ts:237`, Stage 9, justified) |
| PRs | **18** (Stage 14 is three; Stage 10 is two) |

### Abandonment value at each checkpoint

- **After Stage 3** (3 PRs): ~160 lines of dead code gone, the docs no longer document a method that always returns `[]`, and the seven highest-risk untested clusters have characterization coverage — including the send critical section, which **no test reaches today**.
- **After Stage 9** (9 PRs): the file is ~5,300 lines. The delivery journal, the storage registry, all pure parsing and every type/port live outside it behind a mechanical sole-writer grep gate. The send hot path lost three storage round-trips.
- **After Stage 13** (15 PRs): the file is ~2,900 lines and everything except the send/resume pipeline and the facade has moved.
- **After Stage 14c** (17 PRs): the headline payoff lands — **one** execution primitive with conflict policy as a parameter, **one** `opIndex` assignment site replacing four, and the ~190-line failure disposition that produced #631/#665/#670/#676/#677 becomes a pure, exhaustively-tabled function.
- **After Stage 16**: the tripwire that would have caught this in 2026-03, when the file crossed 2,500 lines and nobody noticed.