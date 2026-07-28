# PaymentsModule.ts — Analysis Findings

Evidence base for [PAYMENTS-REFACTOR.md](./PAYMENTS-REFACTOR.md). Produced by a 15-agent
analysis (archaeology, responsibility clustering, intra/cross-file duplication scans, coupling
and invariant inventory, public-surface and dead-code audit), with every claim put through an
adversarial refutation pass. **34 duplication claims raised → 21 survived. 16 dead-code claims → 9 survived.**

Baseline at time of analysis: `main` @ `18ffc802`, typecheck clean, 210 test files / 3,330 tests green.

---

## 1. Growth archaeology

PaymentsModule.ts went 1899 → 7027 lines across 152 commits in 6 months (2026-01-27 … 2026-07-27), with exactly one shrink event (fde68246, -2828, the v1 deletion) and zero decomposition events on main. Surviving-line blame: 2354 lines (33%) come from `fix*` commits, 132 lines (1.9%) from `refactor*` commits; 133 issue-tagged guard comments referencing 33 distinct GitHub issues are embedded in the code. The dominant mechanism is that the file IS the money-safety transaction boundary — every new invariant needs simultaneous access to `this.tokens`, `this.reservationLedger`, `this.settlingJournal`, `this.deps.walletApi`, so it must be written inside the class. `sendOnce` alone grew 254 → 702 lines in 47 days (36 distinct commits) purely by absorbing incident guards; its resume twin `resumeIntent` grew 106 → 283 in lockstep because the two are independent implementations of the same pipeline (engine.transfer at L2166 AND L6416, engine.split at L2225 AND L6459, delivery.deliver at L2143, L6384 AND L6908). Three sibling files were ever extracted, each forced by an external requirement (SpendQueue+TokenReservationLedger by the #87 TOCTOU fix, TransportDeliveryAdapter by the S3/S7 ports work, pump-health by a #630 logging-noise fix) — never by a "this file is too big" decision. The only real decomposition that exists (39 `refactor(payments)(phase-5/6)` commits splitting the module into tokens/, persistence/, read-model/, sync/, payment-request/, nametag/, mint/ submodules, 2026-07-07) lives on the abandoned origin/@vrogojin/uxf-v2 fork which diverged 2026-05-13 and never merged (1260 commits behind main's line). The project's own CLAUDE.md still records the file as "~139KB"; it is 309,349 bytes — the growth was never on anyone's dashboard, and the file contains zero TODO/FIXME.

### Growth phases

| Period | Lines at end | Driver |
|---|---|---|
| 2026-01-27 → 2026-02-03 (225eb593 … 80d97356, 10 commits) | **2664** | Greenfield v1 L3 payments module, then immediate third-party wire-format compatibility work: 'support Sphere wallet transfer format (sourceToken/transferTx)', 'full lottery compatibility for token handling', token split for partial transfers, nametag minting, multi-address. The file was born at 1899 lines in a single commit — it was never small. |
| 2026-02-04 → 2026-02-16 (1069a61a … d5b4afba, ~35 commits) | **4619** | Feature bolt-on wave with no new seams: INSTANT_SPLIT V5 flow (+290 in one commit), the PROXY/DIRECT addressing matrix re-decided five times in four days, TokenRegistry, PriceProvider, IPFS/IPNS push sync + write-behind buffer, three consecutive redesigns of receive(). Peak single commit: a0ec3ae3 +592 for 'PROXY transfer balance conservation'. |
| 2026-02-20 → 2026-02-26 (4e6fb9c0 … 1f8f08d5, 7 commits) | **5405** | Correctness churn on state the module owned directly: the L3 transaction-history dedup was 'redesigned to prevent duplicates' twice in one day (+192/-84 then +187/-82), the V5 finalization persistence/retry pipeline was rebuilt (+270/-51), and the V6 combined transfer bundle replaced V5's per-token Nostr messages (+496/-196) while keeping the V5 receive path. |
| 2026-03-01 → 2026-05-04 (929836b7 … 29d582bd, 9 commits) | **6034** | v1 peak. Low commit volume, high line-weight: per-address independent modules, and the first concurrency crisis — #87 'eliminate TOCTOU race in concurrent send()' (+264) which is the ONLY commit in the file's history that extracted real collaborators (SpendQueue.ts + TokenReservationLedger.ts were born here), followed by #107 SpendQueue steelman (+215) putting most of the new logic back into the m |
| 2026-06-05 → 2026-06-10 (f5ce630e … a24d808c, 14 commits) | **3515** | v2 cutover. A dual-stack period first — nine 'feat(track-b)' commits added the v2 engine send/receive/value-read paths ALONGSIDE the live v1 stack (6034 → 6176) — then the single largest deletion in the file's life, fde68246 (+167/-2828), removed the v1 send/receive/finalization stack. This is the only time the file ever shrank, and it was a deletion, not a decomposition: nothing was moved out, th |
| 2026-06-10 → 2026-06-18 (3566dbcc … cbac6f38, 20 commits) | **5590** | wallet-api program integration (sdk-changes Part E, S3/S4/S7). The freed 2828 lines were re-filled in 8 days by a SECOND custody/persistence stack layered beside the local one, inside the same class: DeliveryProvider port + WalletApiMailboxProvider (+803, the largest non-init commit ever), payment requests on wallet-api (+482), fail-closed composition checks (+114), server history hydration (+133) |
| 2026-06-24 → 2026-07-27 (382e0877 … 493d3cdb, 25 commits) | **7027** | Pure post-integration money-safety hardening — no new product feature. 19 commits in July alone, +1384/-214 (net +1170); 15 of the 19 are fixes and 4 of those are reviews-of-a-fix (Codex P1, Copilot review, Copilot re-review, audit #4). Every commit adds a guard inside an existing method rather than a new collaborator. Issues consumed: #441 #621 #622 #623 #624 #625 #626 #630 #631 #634 #642 #659 #6 |

### Root causes

**1. The class IS the money-safety transaction boundary. All durability/atomicity invariants are enforced by co-locating mutable state in one object's private fields, so any new invariant MUST be written inside the class to see `this.tokens`, `this.reservationLedger`, `this.parsedTokenCache`, `this.settlingJournal`, `this.deps.walletApi` at once. There is no PaymentEngine / SendSaga / IntentJournal collaborator to hang new rules on.**

- Evidence: ~60 private fields declared L1030-1201 (modules/payments/PaymentsModule.ts:1030-1201), including 11 hand-rolled concurrency primitives with no shared abstraction: pumpInFlight:1079, prPumpInFlight:1087, reconcileInFlight:1114, settlingJournalLoad:1110, settlingJournalWrite:1111, loadInFlight/loadInFlightOwner/loadRerunRequested/loadRerunTimer:1130-1133, _syncInProgress:1158, payInFlight:1174, replayInFlight:1193, journalMutation:1201. The CLAUDE.md constraint 'SpendQueue + TokenReservationLedger form a SYNCHRONOUS critical section — must not introduce an await' is exactly why nothing could be pulled out piecemeal.
- Preventable by: A `SendSaga` object owning the (plan → certify → journal → deliver → close) sequence, with the token map behind a `TokenRepository` interface and the reservation ledger passed in — so a new invariant is a new method on the saga, not a new flag on a 7000-line class. The seam existed conceptually since 2026-04-17 (#87 created SpendQueue) but was never widened.

**2. Two independent implementations of the send pipeline were allowed to exist and diverge: `sendOnce` (the live path) and `resumeIntent` (the crash-recovery path), plus a third partial copy in `replayOneDelivery`. Every money-safety fix therefore has to be written 2–3 times, and each fix that was written only once became the next incident.**

- Evidence: engine.transfer at PaymentsModule.ts:2166 AND :6416; engine.split at :2225 AND :6459; uploadOutputBlob at :2316 AND :6536; completeIntent at :2364 AND :6597/:6625; delivery.deliver at :2143, :6384 AND :6908. Three commits exist purely to make resume behave like send: e8118c51 'resume re-delivers/records instead of re-certifying' (+105/-18), ff875f63 'resume split leg no longer wedges' (+55/-28), cd1e2fb6 'resume forward-completes delivered legs, surfaces remainder (audit #4)' (+104/-16). resumeIntent grew 106→283 lines and resumeOpenIntents 47→144 in lockstep with sendOnce's 254→702.
- Preventable by: One `executeIntent(transferId, plan, {resuming})` used by both entry points — the CLAUDE.md rule 'resume replays the SAME transferId, status-agnostic' already says the two paths are the same operation; the code never expressed that.

**3. The wallet-api migration layered a second custody/persistence stack BESIDE the local one inside the same methods instead of behind the DeliveryProvider/TokenStorageProvider ports it introduced. The ports were created; the branching on which stack is active was not moved behind them.**

- Evidence: `const serverApply = !!walletApi && delivery.custody === 'inventory'` at PaymentsModule.ts:2075 and again at :6365 forks the entire persistence tail of both send implementations; 43 `walletApi` references in the file; `assertLegalCustodyComposition` (:1006-1028) exists only to reject illegal runtime combinations of the two stacks; `getLocalTokenStorageProvider` (:4650) vs `getActiveTokenStorageProvider` (:2643) vs `getTokenStorageProviders` (:5122) are three different answers to 'where does state live'. The two commits that introduced this are the two largest non-init commits in the file's history: f625c3a9 (+803, 645 lines still surviving) and 7cc8a1bd (+482, 425 surviving).
- Preventable by: Making custody a composition-time type (two concrete implementations of one `PaymentsBackend` port) rather than a runtime boolean read inside sendOnce — which is literally what the project's own S7 ports rule asks for ('custody is a composition-time property, never a per-call flag'), applied one level too shallow.

**4. Incident-driven patch cadence with no post-fix restructuring step, amplified by review loops that append guards to the same method. Fixing is scoped; consolidating is not.**

- Evidence: 69 fix-prefixed commits vs 12 refactor-prefixed across 152. Surviving-line blame at HEAD: 2354 lines from `fix*` commits (33.5% of the file) vs 132 lines from `refactor*` (1.9%). 133 issue-tagged comment sites spanning 33 distinct issues (#441 appears 17×, #621 14×, #517 13×, #515 10×, #642 9×). The #441 mechanism alone took four commits in 24h — 8dd79d5d (+284/-14), 729f37f9 '(Codex P1)' (+30/-7), 966494c7 '(Copilot review)' (+30/-11), 1b0b7624 '(Copilot re-review)' (+17/-3) — each adding a guard, none restructuring.
- Preventable by: A rule that a hardening PR touching a >400-line method must either shrink it or extract the guarded concern — the same energy that produced 2279 lines of incident-narrative comments would have produced the objects those narratives describe.

**5. No size budget, no tripwire, and the project's own size accounting went stale — so the growth was structurally invisible.**

- Evidence: CLAUDE.md 'File Size Reference' records `modules/payments/PaymentsModule.ts — ~139KB`; the file is 309,349 bytes (2.2× the recorded figure). Zero TODO/FIXME/HACK markers in all 7027 lines. No commit, doc, or issue anywhere in the repo proposes splitting it (`git log --all --grep` for split/decompose returns only the abandoned fork's work). Instead the file carries 44 `// =====` section banners (:1269 Lifecycle, :1759 Send, :2828 Payment Requests, :3468 Receive, :4047 Tombstones, :4149 Archives, :4232 Forked Tokens, :4304 History, :4663 Nametag, :4874 Sync & Validate …) — the concerns were named 44 times and extracted 0 times.
- Preventable by: A CI line/byte budget on modules/payments/*.ts that fails the build past a threshold, forcing the extraction conversation at ~2500 lines instead of never.

**6. The only decomposition ever executed lives on an abandoned fork; main's line never received one, and the effort was spent twice over.**

- Evidence: origin/@vrogojin/uxf-v2 diverged from main at 557f9c82 (2026-05-13, v0.7.2, file = 6034 lines) and ran a 39-commit `refactor(payments)(phase-5/6)` series on 2026-07-07 that split the module into tokens/, persistence/, read-model/, sync/, payment-request/, import-export/, nametag/, mint/ and lib/ submodules (c247ba91, ad1e3a4e, a8f3587f, 85705f22, 77b8b8c7, a091e532, 49bb4340, d085bcd1, b77580ce) and then rebuilt it as a ~1750-LoC ITokenEngine facade by quarantining 9538 LoC into legacy-v1/ (4836d166). `git merge-base --is-ancestor 4836d166 main` → NO; 1260 commits unmerged; branch last touched 2026-07-08. Main meanwhile solved the same problem by DELETING v1 (fde68246) and immediately re-filling the space with wallet-api code.
- Preventable by: Doing the decomposition on the mainline before/with the v2 cutover instead of in a parallel fork — the cutover commit (fde68246, -2828) was the one moment the file was small (3515) and the natural time to cut it into pieces; it went from 3515 to 7027 in the 47 days after.

**7. The file was almost never the unit of work — it was collateral in cross-cutting changes, so no one was ever inside it with a mandate to restructure.**

- Evidence: 152 commits touching it, averaging 8.18 files changed per commit; only 12 of 152 (7.9%) touched this file alone. The three sibling extractions that DID happen were all side effects of unrelated mandates: SpendQueue.ts + TokenReservationLedger.ts came out of 601624ac (a TOCTOU bug fix, #87), TransportDeliveryAdapter.ts out of f625c3a9 (a ports refactor, #502), pump-health.ts out of fa408e79 (a log-noise fix, #630). Not one extraction was motivated by file size.
- Preventable by: Scheduling structural work as its own issue with its own PR (the program process in ../wallet-api/development-workflow.md requires every PR to close an issue — no issue was ever filed for this file's structure).

**8. Tests were split by concern while the implementation was not, which both hid the problem (each concern LOOKS owned) and raised the cost of ever splitting it (every suite constructs the whole module, some reach into privates).**

- Evidence: 23 test files named `tests/unit/modules/PaymentsModule.*.test.ts` totalling 10,170 lines — payment-requests (1004), wallet-api-delivery (1764), concurrency (783), tombstone (571), history-integration (494), journey-backlog (467) … i.e. the concerns were legible enough to name 23 times. 41 `(x as any).` private reach-ins across 5 of them (17 in PaymentsModule.wallet-api-delivery.test.ts, 11 in v2-send-recovery, 6 in v2-receive) bind tests to internals like `(module as any).handleIncomingTransfer`, `(module as any).spendQueue`, `(module as any).replayPendingV2Deliveries`.
- Preventable by: Letting the test-file boundaries drive the source boundaries — the 23 suite names ARE the extraction plan, and were available from 2026-06 onward.

### Accretion patterns

| Pattern | Occurrences | Lines added |
|---|---|---|
| Incident guard inlined into an existing mega-method instead of a new collaborator. Each fixed bug leaves a guard + a paragraph of rationale at the point of failure, so the hottest method absorbs every incident. | 133 | 2354 |
| Per-incident mutable 'what already happened' flag declared in the sendOnce preamble and threaded through its ~250-line catch block. Each new failure mode needed to know how far the previous ones got. | 5 | 120 |
| Every new background pump gets its own timer field + inFlight coalescer + teardown method (+ wake unsubscribe), hand-rolled; no shared Pump abstraction ever emerged, and 8 further ad-hoc single-flight/serialization guard | 11 | 200 |
| Every new durability requirement gets its own bespoke journal: a key function, a load/parse, a mutate, a write — all hand-rolled against `storage.get/set` with JSON.stringify. Serialization of the read-modify-write was r | 6 | 430 |
| Each satellite token store got its own near-identical getter + merge + prune triple operating on a Map/array field and calling the same `save()`. Three stores, one shape, zero shared code. | 11 | 245 |
| Owner/identity re-check hand-rolled at every new site that awaits, because a long-lived per-address module can switch identity mid-flight. Two of the sites are literal copy-paste of the same five-line block. | 7 | 45 |
| Per-incident tuning constant parked at module scope with a JSDoc paragraph, rather than configuration on the component that uses it. | 13 | 95 |
| Duplicated engine-op tail: the resume path re-implements the send path's certify → upload → apply → close sequence rather than calling it, so each hardening lands twice (or three times for delivery). | 6 | 283 |
| Incident history encoded as prose comments inside the class instead of as structure. The file carries its own postmortem archive. | 2279 | 2279 |
| Trivial delegation methods added one per consumer need rather than exposing the collaborator once. | 4 | 24 |

---

## 2. Responsibility clusters

161 methods / 5,999 class lines resolve into 18 responsibility clusters. Sizes: send 1,006L (sendOnce alone is 702L, L1899-2600), pr-core 498L, token-store 491L, resume 446L (resumeIntent 288L), incoming 428L, pr-walletapi 404L, load 392L (loadWith 244L), history 309L, lifecycle 303L, repo-archives 297L, provider-sync 289L, balances 244L, delivery-journal 202L, settling-journal 196L, pr-transport 71L, storage-providers 76L, nametags 96L, mint 66L.

FIELD OWNERSHIP IS THE REAL PROBLEM. Of ~60 private fields, only 17 are owned by exactly one cluster. `deps` is touched by 17 of 18 clusters (57 methods); `this.tokens` by 9 clusters (26 methods); `tombstones`/`tombstoneKeySet`/`archivedTokens`/`forkedTokens` by 3 each; `nametags` by 4; `settlingJournal` by 3; `paymentRequests` by 3. Four clusters (send, resume, balances, repo-archives, nametags, history, mint, storage-providers) own ZERO fields exclusively — including the two largest money paths. `initialize` L1287-1448 is the sole reset point for every one of those fields, so no cluster can move out until it exposes a reset()/dispose().

REFACTOR ORDER dictated by the graph (leaf-first; each step listed has no unresolved outbound edges after the prior steps):
1. delivery-journal (L6746-6947) — 4 exclusive fields, only outbound edge is currentNametagName L6900. Cleanest extraction; extracting it FIRST gives send and resume a stable journal port.
2. storage-providers (L2643/L4650/L5122/L5168) — stateless selector, 8 consumers; invert its one outbound edge (updateTokenStorageProviders->subscribeToStorageEvents L5175) into a callback.
3. balances + the getCoin* registry facade (L2601-2629, L3557-3771, L5154) — a pure sink with zero outbound cross-cluster calls.
4. repo-archives (L4058-4311, L6646) — high internal cohesion and its algorithms are already free functions (L589-687); but note it is mostly DEAD (mergeArchivedTokens/mergeForkedTokens/prune*/storeForkedToken/getBestArchivedVersion/getForkedTokens have zero non-test, non-internal callers; only AccountingModule.getArchivedTokens survives). Blocked only by removeToken's direct tombstone push L4007-4008 and by createStorageData L6961-6963.
5. history (L4312-4648) + mint + nametags — each needs one interface (history: a HistorySink so createStorageData L6964 stops owning it; nametags: split currentNametagName L4707 out as an identity accessor with 4 cross-cluster callers).
6. token-store persistence split (createStorageData L6948 / loadFromStorageData L6967 / save L6689) — this single TXF blob is what pins repo-archives + nametags + history into the class; it must be decomposed before step 4/5 can fully land.
7. pr-* trio LAST-BUT-ONE: extract a `PaymentRequestChannel` port (create/respond/ingest). The transport and wallet-api impls are NOT two parallel modules — the fork lives inline inside pr-core's sendPaymentRequest L2845-2904 and sendPaymentRequestResponse L3433-3479, while the incoming path is genuinely duplicated (handleIncomingPaymentRequest L3213-3264 vs surfaceIncomingPaymentRequest L5945-6047 both dedup/unshift/emit/run-handlers). dispatchPaymentRequestResponse L3372 already proves the pattern for the response leg. settling-journal must move WITH pr-* (its storage key derives from paymentRequestsApi L5728 and surfaceIncomingPaymentRequest reads the journal SYNCHRONOUSLY at L5967 after a preload at L5871).
8. send + resume TOGETHER, never separately. resumeIntent L6358-6645 is a line-for-line re-implementation of sendOnce's certify→journal→deliver→applyDelta→removeToken pipeline (send L2191/L2200/L2213, L2256/L2275/L2279/L2290, L2316-2344 vs resume L6372/L6383, L6486, L6536-6575). Extracting one without the other forks the money-safety invariants (certified source must go terminal 'spent' L2509-2517; keep-open on ProofUnconfirmed L2470-2474; same-transferId replay L6404-6412).

HARD CONSTRAINTS ANY SPLIT MUST PRESERVE:
- The SpendQueue critical section L2005-2014 is synchronous and reads `this.tokens` directly (last legal await: buildParsedPool L1995; first after: waitForEntry L2018). Putting the token map behind an async port breaks concurrent-send correctness.
- savePendingV2Delivery MUST precede tryDeliver (L2191→L2200, L2256→L2279, L6372→L6383) and all journal RMW must stay inside withJournalLock L6764.
- payPaymentRequestInner journals settling L3182 BEFORE flipping status L3183.
- surfaceIncomingPaymentRequest's synchronous settlingJournal read L5967 depends on the ensureSettlingJournalLoaded await at L5871.

TWO LATENT COUPLINGS THE CALL GRAPH ALONE HIDES: (a) `syncDebounceTimer` is shared by load's debouncedInventorySyncFromWake L5495-5497 and provider-sync's debouncedSyncFromRemoteUpdate L5095-5100 — a wake cancels a pending remote-update sync and vice versa; (b) `_doSync` L4904-5056 is a SECOND full hydration path that duplicates loadWith's post-load repair (loadFromStorageData L4959 → hand-restore tokens L4966-5000 → restore nametags L5003 → rebuild cache L5008 → import history L5013).

| Cluster | ~Lines | Cohesion | Extractability | Members |
|---|---|---|---|---|
| **send** | 1006 | low | entangled | 12 |
| **pr-core** | 498 | medium | needs-interface | 20 |
| **token-store** | 491 | medium | needs-interface | 13 |
| **resume** | 446 | high | needs-interface | 2 |
| **incoming** | 428 | medium | needs-interface | 10 |
| **pr-walletapi** | 404 | high | needs-interface | 14 |
| **load** | 392 | medium | needs-interface | 7 |
| **history** | 309 | high | needs-interface | 7 |
| **lifecycle** | 303 | low | entangled | 8 |
| **repo-archives** | 297 | high | needs-interface | 14 |
| **provider-sync** | 289 | medium | needs-interface | 6 |
| **balances** | 244 | high | clean | 12 |
| **delivery-journal** | 202 | high | clean | 13 |
| **settling-journal** | 196 | high | needs-interface | 8 |
| **nametags** | 96 | high | needs-interface | 7 |
| **storage-providers** | 76 | high | clean | 4 |
| **pr-transport** | 71 | high | clean | 2 |
| **mint** | 66 | high | clean | 2 |

<details><summary>Per-cluster detail (owned vs shared state, blockers)</summary>

### send — ~1006 lines

The outgoing money path: re-plan loop, spend planning through SpendQueue/TokenReservationLedger, E.3 intent PUT, engine transfer/split, on-chain commit bookkeeping, applyDelta, the 190-line failure/restore handler, and the pre-send outbox.

- **Extractability:** entangled (low cohesion)
- **Shares:** `tokens`, `parsedTokenCache`, `reservationLedger`, `spendQueue`, `spendPlanner`, `pendingTransfers`, `pendingBackgroundTasks`, `delivery`, `checkpointStore`, `deps`
- ⚠ Blocker: sendOnce L1899-2600 is 702 lines with ~12 responsibilities: recipient resolve L1953-1965, coin symbol→id resolution L1982-2003, spend planning L1995-2022, tokens→'transferring' + critical save L2039-2044, outbox L2047, intent PUT + #670 422 handling L2091-2154, direct-transfer loop L2163-2215, split L2221-2296, applyDelta branch L2298-2346, completeIntent L2362, history L2382-2394, and a failure handler L2412-2593.
- ⚠ Blocker: Owns ZERO private fields exclusively — everything it mutates belongs to token-store, delivery-journal, history or lifecycle.
- ⚠ Blocker: SYNCHRONOUS CRITICAL SECTION at L2005-2014: the pending-change scan iterates this.tokens directly and spendPlanner.planSend L2012 takes reservationLedger + spendQueue + result.id atomically. Any extraction that puts this.tokens behind an async port (or awaits inside) breaks the concurrent-send guarantee. buildParsedPool L1995 is the last legal await before it; waitForEntry L2018 the first after.
- ⚠ Blocker: The certify→journal→deliver→(applyDelta)→removeToken sequence at L2191-2213 / L2256-2290 / L2316-2344 is DUPLICATED almost line-for-line in resumeIntent L6372-6383 / L6486 / L6536-6575. Extracting a shared `executeIntentOp` primitive is the real refactor, and it must preserve: journal BEFORE deliver (L2191 then L2200), committedOnChainTokenIds tracking L2178/L2231, and never restoring a certified source to 'confirmed' L2509-2517.
- ⚠ Blocker: getCheckpointStore L2662 and uploadOutputBlob L2762 are wallet-api plumbing shared with resume (L6448, L6536).

### pr-core — ~498 lines

Payment-request domain state and public API shared by both channels: incoming list, outgoing map, status machine, pay single-flight, waiters, response dispatch. Also holds the two CHANNEL-BRANCHING dispatchers.

- **Extractability:** needs-interface (medium cohesion)
- **Owns:** `payInFlight`
- **Shares:** `paymentRequests`, `outgoingPaymentRequests`, `paymentRequestHandlers`, `paymentRequestResponseHandlers`, `pendingResponseResolvers`, `deps`
- ⚠ Blocker: The two-implementations problem lives HERE, not in the channel clusters: sendPaymentRequest L2845-2848 branches to sendWalletApiPaymentRequest, else runs the transport impl inline L2850-2904; sendPaymentRequestResponse L3433-3459 branches to prApi.respondPaymentRequest, else runs the transport impl inline L3461-3479. Extracting a `PaymentRequestChannel` port (create / respond / ingest) would collapse both.
- ⚠ Blocker: payPaymentRequestInner L3108-3195 is the money-critical bridge: it calls send L3130, then on a possibly-committed outcome journals settling L3182 BEFORE flipping status L3183 (order is load-bearing), and falls back to durable 'paid' L3195 when there is no wallet-api PR port. It couples pr-core → send → settling-journal.
- ⚠ Blocker: this.paymentRequests is a plain array mutated by three clusters (pr-core L3072/L3086/L3198, pr-transport L3243, pr-walletapi L6029) with no encapsulation.
- ⚠ Blocker: dispatchPaymentRequestResponse L3372 is correctly shared by both channels (transport L3355, wallet-api L6089) — the ONE place the duplication was already resolved; the incoming path was not.

### token-store — ~491 lines

The in-memory token Map plus its CRUD, dedup/state-replacement rules, parsed-token cache for SpendQueue, engine→UI token bridge, and the whole-blob TXF persistence (save/createStorageData/loadFromStorageData).

- **Extractability:** needs-interface (medium cohesion)
- **Owns:** `tokenChangeCallbacks`
- **Shares:** `tokens`, `tombstones`, `tombstoneKeySet`, `archivedTokens`, `forkedTokens`, `nametags`, `_historyCache`, `parsedTokenCache`, `reservationLedger`, `spendQueue`, `deps`
- ⚠ Blocker: createStorageData L6948-6966 serializes tokens + nametags L6960 + tombstones L6961 + archivedTokens L6962 + forkedTokens L6963 + history L6964 into ONE blob; loadFromStorageData L6967-7013 reads them all back. This single persistence unit is the #1 blocker to splitting repo-archives, nametags and history into separate stores.
- ⚠ Blocker: save() is called from 22 sites across 8 clusters (L1615, L1642, L1893, L2044, L2352, L2523, L3898, L3965, L4022, L4038, L4126, L4143, L4208, L4227, L4262, L4282, L4299, L4681, L4735, L4913, L5031, L5225) — it is the de-facto global commit.
- ⚠ Blocker: removeToken L3992 writes tombstones DIRECTLY (this.tombstones.push L4007, tombstoneKeySet.add L4008) instead of via the repo-archives API, AND cancels reservations L4029 AND wakes the spend queue L4042 — three clusters mutated from one method.
- ⚠ Blocker: addToken L3819 mutates tombstone lookups L3847, archives L3877/L3898, spend-queue cache L3905-3907, and fires the AccountingModule observer L3902/L3911 (duplicated call).
- ⚠ Blocker: this.tokens is read directly by 9 clusters (balances L3698, send L2006, incoming L5340, resume L6549, provider-sync L4959, load L1559, repo-archives L4100, lifecycle L1315).

### resume — ~446 lines

E.3 intent resume: list open intents, honor local abort dispositions (#676), decrypt payload, re-run the same transferId (re-deliver journaled blobs instead of re-certifying), classify outcomes, and reconcile the settling journal.

- **Extractability:** needs-interface (high cohesion)
- **Shares:** `tokens`, `delivery`, `loaded`, `loadedPromise`, `deps`
- ⚠ Blocker: resumeIntent L6358-6645 (288 lines) re-implements sendOnce's execution pipeline: deliverBlob+journal L6367-6392, direct-leg loop L6398-6432, split with checkpoint L6435-6524, applyDelta L6534-6545, local source removal with M7 state-aware keep-guard L6549-6580, partial-completion tail L6592-6629, completeIntent+history L6632-6644. Extracting send WITHOUT extracting this will fork the money-safety invariants.
- ⚠ Blocker: Owns no fields; depends on send's getCheckpointStore L6448 and uploadOutputBlob L6536, delivery-journal's journaledByOp L6394 / savePendingV2Delivery L6372 / tryDeliver L6383, token-store's removeToken L6556 / storeEngineToken L6486, and settling-journal's reconcile L6247.
- ⚠ Blocker: resumeOpenIntents L6099 fires reconcileSettlingPaymentRequests L6247 unconditionally at the end — the ONLY seam that resolves a deferred payment-request 'paid'. The settling reconcile cannot be moved without re-parenting this call.

### incoming — ~428 lines

Receiving assets: the explicit receive() one-shot, the delivery-port pump (list → classify → batched claim/reject ack), the legacy relay subscription handler, and handleV2Transfer (decode/verify/isOwnedBy/dedup/store/emit/history).

- **Extractability:** needs-interface (medium cohesion)
- **Owns:** `pumpInFlight`
- **Shares:** `tokens`, `loaded`, `loadedPromise`, `injectedDelivery`, `deliveryPollTimer`, `inventoryPollTimer`, `deliveryWakeUnsub`, `deps`
- ⚠ Blocker: teardownDeliveryPump L5450 clears deliveryPollTimer AND inventoryPollTimer L5464-5468 — the inventory timer is a `load` concern (it calls resyncInventory L1394), so the teardown crosses the incoming/load boundary.
- ⚠ Blocker: handleV2Transfer L5284-5403 is the shared ingest for BOTH channels (relay L5424, mailbox L5652) and mixes verification L5323-5333, replay/stale-state gating L5340-5359, storage L5362, event emit L5375, and history write L5384 in one 120-line method.
- ⚠ Blocker: receive L3485 forks on injectedDelivery L3493: the port branch pumps L3495 and diffs this.tokens L3497, the relay branch calls transport.fetchPendingEvents L3520 then loadFresh L3529 — two different notions of "receive".
- ⚠ Blocker: loaded/loadedPromise gating (L5289-5291, L5406-5408, L5569-5571) is a load-cluster invariant reached into from here.

### pr-walletapi — ~404 lines

S4 wallet-api payment-request channel: capability detection, poll timer, persisted gap-free `?since=` cursor, once-per-session full hydration (#556), memo decryption, incoming surface, outgoing `?before=` backfill.

- **Extractability:** needs-interface (high cohesion)
- **Owns:** `prPumpInFlight`
- **Shares:** `paymentRequests`, `outgoingPaymentRequests`, `paymentRequestHandlers`, `prPollTimer`, `prBootstrapped`, `settlingJournal`, `loaded`, `loadedPromise`, `deps`
- ⚠ Blocker: surfaceIncomingPaymentRequest L5945 reads this.settlingJournal SYNCHRONOUSLY at L5967 and relies on pumpIncomingPaymentRequests L5871 having awaited ensureSettlingJournalLoaded first. Any extraction must preserve that preload ordering or a settling request re-surfaces payable (= double-pay).
- ⚠ Blocker: paymentRequestsApi L5679 is a capability probe consumed by 4 other clusters (lifecycle L1418, load L1678, pr-core L2845/L3159/L3433, settling-journal L5728/L6329) — it is the de-facto channel selector and belongs on the port, not here.
- ⚠ Blocker: prCursorKey L5701 and prSettlingKey L5727 both derive their storage key from paymentRequestsApi()?.network — the settling journal's key depends on this cluster's capability probe.
- ⚠ Blocker: teardownPaymentRequestPump L5692 clears prPollTimer, which lifecycle installs L1410-1412.

### load — ~392 lines

Boot/hydration orchestration and inventory convergence: single-flight load with owner guard + trailing re-run, wake routing, debounced inventory resync, lazy-inventory projection.

- **Extractability:** needs-interface (medium cohesion)
- **Owns:** `loadInFlight`, `loadInFlightOwner`
- **Shares:** `deps`, `tokens`, `pendingTransfers`, `loaded`, `loadedPromise`, `loadRerunRequested`, `loadRerunTimer`, `injectedDelivery`, `pumpHealth`, `syncDebounceTimer`
- ⚠ Blocker: loadWith L1475-1718 is a 244-line pipeline that reaches into 8 clusters inline: provider iteration L1506, loadFromStorageData L1519, rebuildParsedTokenCache L1521, importRemoteHistoryEntries L1529, mergeLazyInventory L1550, placeholder sweep L1559-1571, PENDING_V5 migration L1580-1620, transferring-token network reconcile L1625-1644, loadHistory L1647, pendingTransfers L1650-1657, replay L1673, two pump kicks L1678-1685.
- ⚠ Blocker: syncDebounceTimer is SHARED with provider-sync: debouncedInventorySyncFromWake L5495-5497 and debouncedSyncFromRemoteUpdate L5095-5100 clear/set the SAME field, so an `inventory` wake cancels a pending IPFS remote-update sync and vice versa. Any split must give each its own timer or the behavior changes.
- ⚠ Blocker: mergeLazyInventory L2783 writes directly into this.tokens L2820 and calls four balances/registry helpers L2803-2806.

### history — ~309 lines

Transaction history: in-memory cache, local append + best-effort §10 server POST, and THREE distinct load paths (local provider + legacy KV migration, wallet-api keyset hydration with incremental fast path, IPFS/TXF import).

- **Extractability:** needs-interface (high cohesion)
- **Shares:** `_historyCache`, `historyHydratedFor`, `serverSeenHistoryKeys`, `incrementalHistoryPulls`, `hydrationEpoch`, `deps`
- ⚠ Blocker: Three parallel implementations of the same concept, all writing _historyCache: loadHistory L4430-4490 (local provider L4437 + one-time KV migration L4441-4463 + bare-KV fallback L4466-4488), hydrateHistoryFromServer L4491-4574 (100-page keyset pagination L4531-4550, incremental stop condition L4543, owner+epoch guard L4552, merge-vs-replace L4556-4568), importRemoteHistoryEntries L4621-4648 (IPFS/TXF merge). loadHistory L4431 selects between the first two.
- ⚠ Blocker: addToHistory L4349-4429 writes THREE places: provider history store L4372, in-memory cache L4376-4381, and the encrypted §16 wire POST L4390-4419 — the wire mapping (30 lines of field shaping) belongs in a mapper next to historyEntryFromWire L4575.
- ⚠ Blocker: createStorageData L6964 also serializes _historyCache into the TXF blob (capped at MAX_SYNCED_HISTORY_ENTRIES L130), so history is a fourth persistence surface owned by token-store.
- ⚠ Blocker: hydrationEpoch is bumped by lifecycle L1326 and read here L4507/L4552 — the re-init race guard spans the boundary.

### lifecycle — ~303 lines

Module construction, dependency wiring, address-switch reset, teardown, init-guard, per-identity field key. `initialize` is the god-method: it resets ~30 fields belonging to 12 other clusters and installs every subscription/timer.

- **Extractability:** entangled (low cohesion)
- **Owns:** `moduleConfig`, `fieldEncryptionKey`, `unsubscribeTransfers`, `unsubscribePaymentRequests`, `unsubscribePaymentRequestResponses`
- **Shares:** `deps (17 clusters)`, `tokens`, `tombstones`, `tombstoneKeySet`, `archivedTokens`, `forkedTokens`, `_historyCache`, `nametags`, `pendingTransfers`, `parsedTokenCache`, `reservationLedger`, `spendQueue`, `spendPlanner`, `delivery`, `injectedDelivery`, `deliveryWakeUnsub`, `deliveryPollTimer`, `inventoryPollTimer`, `prPollTimer`, `prBootstrapped`, `settlingJournal`, `settlingJournalLoad`, `settlingJournalWrite`, `checkpointStore`, `priceProvider`, `pumpHealth`, `loadRerunRequested`, `loadRerunTimer`, `historyHydratedFor`, `serverSeenHistoryKeys`, `incrementalHistoryPulls`, `hydrationEpoch`, `paymentRequestHandlers`, `paymentRequestResponseHandlers`, `pendingResponseResolvers`, `pendingBackgroundTasks`
- ⚠ Blocker: initialize L1287-1448 is the ONLY place per-address state is reset; every cluster's reset lives there (tokens L1315, tombstones L1318-1319, history L1322-1326, nametags L1332, spend queue L1335-1343, PR journal L1415-1417, PR bootstrap flag L1409). Splitting clusters requires each to expose a reset()/dispose() first.
- ⚠ Blocker: getFieldEncryptionKey L2649 is an identity/crypto concern, not lifecycle: consumed by send (L2098, L2673), history (L4381, L4611) and resume (L6172). It belongs in a small IdentityCrypto seam.
- ⚠ Blocker: destroy L1719 clears this.tokens L1770 for balance-query safety — a token-store concern reached across the boundary.

### repo-archives — ~297 lines

Tombstones, archived (spent/superseded) TXF tokens, and forked (alternative-history) TXF tokens: four parallel stores with parallel get/merge/prune method families.

- **Extractability:** needs-interface (high cohesion)
- **Shares:** `tombstones`, `tombstoneKeySet`, `archivedTokens`, `forkedTokens`, `tokens`
- ⚠ Blocker: Owns ZERO fields exclusively — all four maps are also written by lifecycle (reset L1318-1321) and token-store (loadFromStorageData L6994/L7010-7011, createStorageData L6961-6963, removeToken's direct tombstone push L4007-4008).
- ⚠ Blocker: Largely DEAD in production: mergeArchivedTokens, mergeForkedTokens, pruneTombstones, pruneArchivedTokens, pruneForkedTokens, storeForkedToken, getBestArchivedVersion, getForkedTokens have ZERO callers outside this file (storeForkedToken/isStateTombstoned/archiveToken only have internal ones). getTombstones/mergeTombstones are used only by tests; getArchivedTokens is used by AccountingModule (4 sites, e.g. modules/accounting/AccountingModule.ts:404). This whole cluster is the cheapest deletion/extraction target.
- ⚠ Blocker: The pure algorithms are ALREADY module-level free functions (isIncrementalUpdate L589, countCommittedTxns L628, pruneTombstonesByAge L634, pruneMapByCount L653, findBestTokenVersion L668) — only the map plumbing is in the class.

### provider-sync — ~289 lines

Multi-provider (IPFS/file) TXF sync with merge-and-restore, push-based storage-event subscription with debounce, and token validation.

- **Extractability:** needs-interface (medium cohesion)
- **Owns:** `_syncInProgress`, `storageEventUnsubscribers`
- **Shares:** `tokens`, `parsedTokenCache`, `nametags`, `syncDebounceTimer`, `deps`
- ⚠ Blocker: _doSync L4904-5056 (153 lines) is a second full hydration path parallel to loadWith: it calls createStorageData L4919, loadFromStorageData L4959, then hand-restores tokens lost by the clear L4966-5000, restores nametags L5003-5005, rebuilds the parsed cache L5008, and imports history L5011-5017. It duplicates loadWith's post-load repair logic.
- ⚠ Blocker: validate L5183-5235 has nothing to do with sync — it belongs with token-store/engine verification; it shares only save L5225 and parsedTokenCache L5215/L5231.
- ⚠ Blocker: syncDebounceTimer is shared with load's wake path (see the `load` cluster blocker) — a wake and a remote-update event cancel each other.
- ⚠ Blocker: unsubscribeStorageEvents L5078 is called by lifecycle L1302/L1782 and re-subscribed by storage-providers' updateTokenStorageProviders L5175.

### balances — ~244 lines

Read-only aggregation of this.tokens into Asset[] plus fiat pricing, and the TokenRegistry facade (symbol/name/decimals/icon).

- **Extractability:** clean (high cohesion)
- **Shares:** `tokens`, `priceProvider`, `deps`
- ⚠ Blocker: Only needs a token snapshot supplier (`() => Iterable<Token>`) + PriceProvider + TokenRegistry. aggregateTokens L3695-3731 is the sole reader of this.tokens in the cluster.
- ⚠ Blocker: The four getCoin* registry wrappers L2601-2629 are consumed cross-cluster by load (mergeLazyInventory L2803-2806), send (sendOnce L2385), resume (resumeIntent L6600/L6640) and history (historyEntryFromWire L4585) — split them into a tiny CoinMeta facade so balances can leave without dragging them.

### delivery-journal — ~202 lines

The PENDING_V2_DELIVERIES crash-safety journal: atomic RMW under a promise mutex, deliver-with-clear, bounded replay with backoff, 429 deferral, and poison surfacing.

- **Extractability:** clean (high cohesion)
- **Owns:** `journalMutation`, `replayInFlight`, `replayBackoffBaseMs`, `deliveryDeferralMs`
- **Shares:** `delivery`, `deps`
- ⚠ Blocker: Cleanest extraction in the file: 4 exclusively-owned fields, and its only external surface is `deps.storage` (one key, STORAGE_KEYS_ADDRESS.PENDING_V2_DELIVERIES L6747), `this.delivery` (L6908), `deps.emitEvent` (L6890, L6927) and currentNametagName L6900.
- ⚠ Blocker: Two test-only overridable fields (replayBackoffBaseMs L1173-ish decl, deliveryDeferralMs) must stay settable after extraction — tests drive the bounded retry loop through them.
- ⚠ Blocker: withJournalLock L6764 must remain the SOLE serializer: save/remove/update all load→mutate→store the whole blob (L6771-6778, L6781-6788, L6939-6946).

### settling-journal — ~196 lines

#441 deferred-paid durable journal linking a payment request to a possibly-committed transfer, with a serialized RMW chain and the resume-time reconcile that resolves paid / reverts to payable.

- **Extractability:** needs-interface (high cohesion)
- **Owns:** `reconcileInFlight`
- **Shares:** `settlingJournal`, `settlingJournalLoad`, `settlingJournalWrite`, `deps`
- ⚠ Blocker: Physically split across the file (L5727-5821 and L6257-6357) with resume L6099-6256 wedged between the halves.
- ⚠ Blocker: mutateSettlingJournal L5767-5799 captures prSettlingKey at ENQUEUE time L5775 and re-checks it twice L5777/L5782 — an identity-switch guard that only works because prSettlingKey lives in the same object. Extraction must pass the key resolver in, not the key.
- ⚠ Blocker: reconcileSettlingPaymentRequests L6257 takes the resume outcome + open-intent ids + local intent map as arguments (L6258-6262) — it is a resume callback, not a standalone service; and resolveSettledPaid L6327 calls back into pr-walletapi's respondPaymentRequest L6332 and pr-core's updatePaymentRequestStatus L6344.
- ⚠ Blocker: Reset lives in lifecycle L1415-1417.

### nametags — ~96 lines

Local minted-nametag records plus currentNametagName — the outgoing-memo display identity used by every outbound channel.

- **Extractability:** needs-interface (high cohesion)
- **Shares:** `nametags`, `deps`
- ⚠ Blocker: this.nametags is written by token-store's loadFromStorageData L7012, read by createStorageData L6960, snapshotted+restored by provider-sync's _doSync L4933/L5018-5020, and reset by lifecycle L1332 — the cluster owns no field exclusively.
- ⚠ Blocker: currentNametagName L4707 has 4 cross-cluster callers (send L2110, resume L6379, delivery-journal L6900, pr-walletapi L2943) and prefers deps.getCurrentNametag L4708 over the local array — it is really an identity accessor, not nametag storage. Extract it separately from the nametags[] store.
- ⚠ Blocker: reloadNametagsFromStorage L4744 re-reads every provider and re-parses the whole TXF blob just to recover nametags.

### storage-providers — ~76 lines

Provider registry/selector: the active (custody) provider, the local (history) provider, the enabled-provider map, and runtime replacement.

- **Extractability:** clean (high cohesion)
- **Shares:** `deps`
- ⚠ Blocker: Pure selection over deps.tokenStorageProviders / deps.tokenStorage / deps.disabledProviderIds — extractable as a standalone `TokenStorageRegistry` with zero state. Consumed by 8 clusters (load L1505, token-store L6691, send L1883/L2699/L2320, history L4371/L4436/L4630, nametags L4746, provider-sync L4909/L5062, resume L6362).
- ⚠ Blocker: It duplicates the module-level firstEnabledTokenStorage L975-989 used by assertLegalCustodyComposition L1006.
- ⚠ Blocker: updateTokenStorageProviders L5168 calls back into provider-sync's subscribeToStorageEvents L5175 — the only outbound edge; invert it with a callback.

### pr-transport — ~71 lines

Nostr/relay payment-request channel adapters: convert a transport wire request/response into the domain surface.

- **Extractability:** clean (high cohesion)
- **Shares:** `paymentRequests`, `paymentRequestHandlers`, `deps`
- ⚠ Blocker: handleIncomingPaymentRequest L3213-3264 duplicates surfaceIncomingPaymentRequest L5945-6047's tail: dedup L3215 vs L6020, registry lookup L3218-3220 vs L6042, unshift L3241 vs L6029, emit L3244 vs L6034, handler loop L3246-3252 vs L6035-6041. Extract ONE `ingestIncomingRequest(IncomingPaymentRequest)` in pr-core and both channels become thin mappers.
- ⚠ Blocker: handlePaymentRequestResponse L3353 is already a pure mapper onto dispatchPaymentRequestResponse — the template for what the incoming path should look like.

### mint — ~66 lines

Self-mint of fungible tokens via the v2 engine.

- **Extractability:** clean (high cohesion)
- **Shares:** `deps`
- ⚠ Blocker: Needs only ITokenEngine + token-store's storeEngineToken L4865 (criticalSave path). No fields of its own. Extract behind `(engine, storeToken) => mint`.

</details>

---

## 3. Verified duplications (21 survived adversarial review)

Total removable: **~490 lines**. Risk = risk of *unifying*, not of leaving it.

| Risk | Lines | Duplication | Drift bug? |
|---|---|---|---|
| low | 85 | wallet-api §16 wire types re-declared verbatim in PaymentsModule (the originals are already exported from the barrel PaymentsModule imports) | — |
| low | 60 | Four journal quartets (key builder + load + mutate + write); only two of the four serialize their read-modify-write — the OUTBOX is an unserialized RMW AND is write-only dead weigh | 🔴 yes |
| low | 40 | Pump triples: three (timer field + inFlight promise + teardown) sets plus two more timers, all set up with the same `setInterval(pumpHealth.run(...), DELIVERY_POLL_INTERVAL_MS)` li | — |
| low | 36 | Persisted `{cursor, syncEpoch}` read/write is byte-identical in PaymentsModule and WalletApiMailboxProvider (third variant in WalletApiTokenStorageProvider) | — |
| low | 30 | `sendPaymentRequest` (transport) and `sendWalletApiPaymentRequest` — the OutgoingPaymentRequest construction and the no-throw try/catch tail are literal clones | — |
| low | 28 | `parseTokenInfo`'s genesis.coinData and state.coinData branches are a 37-line literal clone | — |
| low | 25 | The 'is this sdkData a v2 engine blob?' predicate exists five times across five files | — |
| medium | 21 | `resolveTransportPubkey` reimplements a lossy subset of `core/transport-resolver.ts`, which was written FOR PaymentsModule and is never used by it | 🔴 yes |
| low | 18 | `validate()` repeats the mark-invalid tail; `deferDelivery`/`markDeliveryPoison`/`bumpDeliveryAttempts` repeat updatePendingV2Delivery+log+emit | — |
| low | 18 | Four 'pick a token storage provider' helpers with four different selection rules | — |
| low | 18 | Handler-dispatch loops iterate the live Set; CommunicationsModule snapshots it and documents why, PaymentsModule/Sphere/GroupChat do not | 🔴 yes |
| low | 15 | `receive()`'s two branches duplicate the 'diff the token map before/after and synthesize IncomingTransfer' loop | — |
| low | 14 | `syncDebounceTimer` shared by two cloned debouncers — an inventory-wake resync and a storage-remote-update sync cancel each other, and `unsubscribeStorageEvents()` silently kills a | 🔴 yes |
| low | 14 | Three handler-notify loops with identical try/catch/debug-swallow bodies | — |
| high | 14 | Three `wallet-api-<x>:<kind>:<network>:<chainPubkey>` state-key builders, and PaymentsModule's silently falls back to the literal 'default' network | 🔴 yes |
| low | 12 | resumeIntent contains its OWN duplicated SENT-history tail (partial vs full completion) — two 11-line clones inside one method | — |
| low | 12 | Provider-address-guard block duplicated between `loadWith` and `_doSync` | — |
| low | 10 | Dead local `fromHex` in PaymentsModule duplicating `core/crypto.hexToBytes`, which the same file already imports | — |
| high | 10 | The LOCAL tombstone state-hash derivation has two independent implementations, using two different crypto libraries, on opposite sides of the same key namespace | — |
| medium | 8 | Genesis-id derivation from a UI token id written five times in two spellings | — |
| low | 2 | `addToken` calls `notifyTokenChange(token)` twice for every added token | — |

<details><summary>Sites and proposed fixes</summary>

### wallet-api §16 wire types re-declared verbatim in PaymentsModule (the originals are already exported from the barrel PaymentsModule imports)

- **Kind:** redundant-abstraction · **Risk:** low · **Saves:** ~85 lines
- **Sites:** `modules/payments/PaymentsModule.ts:728-786`, `modules/payments/PaymentsModule.ts:854-885`, `wallet-api/types.ts:279-309`, `wallet-api/types.ts:313-382`
- **Divergence:** Field-for-field identical today (I diffed all 7 pairs). The two copies are structurally coupled only by review discipline: `wallet-api/client.ts:759,764,780,801,830` is typed against the ORIGINALS, so any §16 wire change lands in wallet-api/types.ts and silently leaves PaymentsModule's mirror stale — the `PaymentsWalletApiPort` structural check would then start REJECTING a conformant `WalletApiClient` (or, worse for an added optional field, accept it and drop the field). PM's `status: 'open'|'paid'|'declined'|'expired'` is an inline literal where wallet-api has the named `PaymentRequestWireStatus` (L313), so a wire-enum extension diverges without a compile error at the mirror.
- **Fix:** Delete `WalletApiPaymentRequest` (L731-744), `WalletApiListPaymentRequestsParams` (L747-749), `WalletApiPaymentRequestsPage` (L752-767) and `WalletApiHistoryRecord` (L775-786); replace with `import type { PaymentRequestRecord as WalletApiPaymentRequest, ListPaymentRequestsParams, PaymentRequestsPage, HistoryWireRecord as WalletApiHistoryRecord, HistoryPage, CreatePaymentRequestInput, RespondPaymentRequestInput } from '../../wallet-api';` and re-export the aliases for API compatibility. Then rewr

### Four journal quartets (key builder + load + mutate + write); only two of the four serialize their read-modify-write — the OUTBOX is an unserialized RMW AND is write-only dead weight on the send hot path

- **Kind:** divergent-clone · **Risk:** low · **Saves:** ~60 lines
- **Sites:** `modules/payments/PaymentsModule.ts:6725-6740`, `modules/payments/PaymentsModule.ts:6746-6788`, `modules/payments/PaymentsModule.ts:6938-6946`, `modules/payments/PaymentsModule.ts:5701-5723`, `modules/payments/PaymentsModule.ts:5727-5809`
- **Divergence:** Four journals over `deps.storage` with the identical load→mutate→JSON.stringify→set shape and four different concurrency postures: (a) PENDING_V2_DELIVERIES uses `withJournalLock` (L6764, added by #517); (b) the settling journal uses a *different* mechanism — a tail-promise chain plus a per-mutation identity-key guard (L5767-5788, added by #679/#680); (c) the PR cursor (L5706/L5718) is a bare get/set with no RMW so it is fine; (d) the OUTBOX (L6725-6740) has NO serialization at all. Two concurrent `send()`s (SpendQueue exists precisely so concurrent sends are supported) both call `saveToOutbox` at L2047 — each reads the same array and writes back only its own entry, dropping the other. Severity is bounded only because the OUTBOX turns out to be WRITE-ONLY: `loadOutbox` has exactly three callers (L6726, L6732, and its own definition) and nothing in the repo ever reads it for recovery — th
- **Fix:** Delete the OUTBOX triple and its three call sites (it is provably write-only; the network-isolation tests only assert the KEY is scoped, which stays true via constants.ts). Then extract one `JsonJournal<T>` helper (key resolver + `read()` + `mutate(fn)` with a built-in per-key promise-chain mutex) and re-implement PENDING_V2_DELIVERIES (save/remove/update) and the settling journal on top of it, so there is ONE serialization mechanism instead of two. Keep the settling journal's identity-key guard

### Pump triples: three (timer field + inFlight promise + teardown) sets plus two more timers, all set up with the same `setInterval(pumpHealth.run(...), DELIVERY_POLL_INTERVAL_MS)` line

- **Kind:** shotgun-parallel · **Risk:** low · **Saves:** ~40 lines
- **Sites:** `modules/payments/PaymentsModule.ts:1385-1395`, `modules/payments/PaymentsModule.ts:1419-1422`, `modules/payments/PaymentsModule.ts:5450-5461`, `modules/payments/PaymentsModule.ts:5692-5697`, `modules/payments/PaymentsModule.ts:5540-5546`, `modules/payments/PaymentsModule.ts:5828-5836`
- **Divergence:** Five timer fields (deliveryPollTimer L1071, inventoryPollTimer L1077, prPollTimer L1085, loadRerunTimer L1133, syncDebounceTimer L1152), three interval setups, two identical single-flight wrappers, two teardown methods, and `loadRerunTimer` cleared in two places (L1326-1329 in initialize, L1724-1727 in destroy). The inventory pump is the odd one out: it has a timer and a teardown but NO dedicated inFlight — it piggybacks on `loadInFlight` via `loadWith`, and the wake/poll callers differ on `rerunOnCoalesce` (true at L5498, false at L1394). `initialize()`'s teardown prologue (L1291-1311) and `destroy()` (L1719-1745) are themselves a clone pair (the scan flagged 1298-1308|1735-1742) that differ only in the resolver rejection message ('Address switched' vs 'Module destroyed') and destroy()'s extra `tokens.clear()`.
- **Fix:** Add a tiny `PollingPump { start(name, fn, ms); stop(); run(): Promise<T> }` class in modules/payments/ that owns the timer + single-flight + pumpHealth wiring; instantiate three of them (delivery, inventory, payment-requests). Then `teardownDeliveryPump`/`teardownPaymentRequestPump` collapse to `pump.stop()` calls, and `initialize()`/`destroy()` share one `private teardownAll(reason: string)`.

### Persisted `{cursor, syncEpoch}` read/write is byte-identical in PaymentsModule and WalletApiMailboxProvider (third variant in WalletApiTokenStorageProvider)

- **Kind:** copy-paste · **Risk:** low · **Saves:** ~36 lines
- **Sites:** `modules/payments/PaymentsModule.ts:5706-5723`, `impl/shared/wallet-api/WalletApiMailboxProvider.ts:188-204`, `impl/shared/wallet-api/WalletApiTokenStorageProvider.ts:216-228`
- **Divergence:** PM's and the mailbox provider's copies are token-for-token identical (my exact-hash scanner matched them at window 6 with 4 overlapping windows — the only exact multi-line cross-file clone in the whole repo besides the type mirrors). The WalletApiTokenStorageProvider variant (L216-228) drifted: it stores cursor and syncEpoch under TWO separate keys instead of one JSON envelope, so its `handleSyncEpochChange` (L419-423) has to remove two keys and a crash between the two `set` calls at L226-227 leaves a cursor paired with the wrong epoch — the exact torn-write the single-envelope form makes impossible. PM's comment at L5700 already says 'mirrors the mailbox cursor', acknowledging the copy.
- **Fix:** Add `wallet-api/cursor-state.ts` exporting `readCursorState(store: KeyValueStore, key: string)` / `persistCursorState(store, key, cursor, syncEpoch)` over the same `{cursor: string, syncEpoch: string}` JSON envelope, and have all three call it. The `KeyValueStore` interface is already exported from `wallet-api/types.ts` and `StorageProvider` satisfies it structurally, so PaymentsModule can pass `this.deps!.storage` directly.

### `sendPaymentRequest` (transport) and `sendWalletApiPaymentRequest` — the OutgoingPaymentRequest construction and the no-throw try/catch tail are literal clones

- **Kind:** copy-paste · **Risk:** low · **Saves:** ~30 lines
- **Sites:** `modules/payments/PaymentsModule.ts:2870-2906`, `modules/payments/PaymentsModule.ts:2952-2987`
- **Divergence:** Identical shape; the only real differences are the id source (client UUID vs server wire id) and `createdAt` (Date.now() vs wire.createdAt). The structural scan flagged three overlapping 6-line windows here (2880-2885|2961-2966, 2887-2894|2968-2975, 2897-2904|2978-2985). No behavioural drift. Note the wallet-api path resolves the recipient to a CHAIN pubkey (L2925-2930) while the transport path resolves to a TRANSPORT pubkey via `resolveTransportPubkey` (L2857) — that difference is correct and must survive any unification.
- **Fix:** Extract `private trackOutgoingPaymentRequest(id, eventId, recipientPubkey, recipientRef, request, createdAt): PaymentRequestResult` and a `private asFailedResult(error, context): PaymentRequestResult`. Both methods keep only their transport-specific resolve + send.

### `parseTokenInfo`'s genesis.coinData and state.coinData branches are a 37-line literal clone

- **Kind:** copy-paste · **Risk:** low · **Saves:** ~28 lines
- **Sites:** `modules/payments/PaymentsModule.ts:346-382`, `modules/payments/PaymentsModule.ts:386-412`
- **Divergence:** Only the `tokenId` source differs (`genesis.tokenId` vs `defaultInfo.tokenId`). The similarity scan produced ~16 overlapping duplicated windows here — the densest clone region in the file. This is legacy v1 TXF display-only parsing (dead for money movement).
- **Fix:** Extract `function coinDataToInfo(coinData: unknown, tokenId?: string): ParsedTokenInfo | null` and call it twice: `coinDataToInfo(genesis.coinData, genesis.tokenId) ?? coinDataToInfo(data.state?.coinData, defaultInfo.tokenId)`.

### The 'is this sdkData a v2 engine blob?' predicate exists five times across five files

- **Kind:** copy-paste · **Risk:** low · **Saves:** ~25 lines
- **Sites:** `modules/payments/PaymentsModule.ts:440-442`, `serialization/txf-serializer.ts:248-257`, `modules/accounting/AccountingModule.ts:4128-4133`, `storage/whole-blob-inventory-adapter.ts:65-72`, `impl/shared/wallet-api/WalletApiTokenStorageProvider.ts:96-106`
- **Divergence:** Three of five (PaymentsModule, txf-serializer, AccountingModule) carry an extra `sdkData[0] !== '{'` clause; whole-blob-inventory-adapter and WalletApiTokenStorageProvider omit it. The clause is provably redundant — `/^[0-9a-f]+$/i` already rejects `{` — so the five predicates are behaviourally identical TODAY. The risk is the reverse direction: the two shorter copies are the ones that read persisted storage entries, so if anyone ever relaxes the regex (e.g. to tolerate a `0x` prefix or uppercase-with-separators) the guard that would have kept legacy TXF JSON out is present in three places and absent in the two that matter most.
- **Fix:** Export a single `isV2TokenBlobHex(sdkData: unknown): sdkData is string` from `token-engine/token-blob.ts` (it already owns encode/decodeTokenBlob and is browser/IPFS/Nostr-free, so the wallet-api backend's ./token-engine-only import closure stays clean) and have all five delegate. WalletApiTokenStorageProvider's `isV2BlobEntry` and whole-blob-inventory-adapter's `isV2TokenEntry` keep their extra `'genesis' in entry` structural test and just call the shared predicate for the string part.

### `resolveTransportPubkey` reimplements a lossy subset of `core/transport-resolver.ts`, which was written FOR PaymentsModule and is never used by it

- **Kind:** divergent-clone · **Risk:** medium · **Saves:** ~21 lines
- **Sites:** `modules/payments/PaymentsModule.ts:5252-5272`, `core/transport-resolver.ts:105-181`, `modules/communications/CommunicationsModule.ts:748-753`, `modules/communications/CommunicationsModule.ts:779-784`
- **Divergence:** Four divergences, all in PaymentsModule's favour of being wrong: (1) NO `.toLowerCase()` — the resolver normalises at both branches (L173, L178), PM returns the caller's casing verbatim; PM's own wallet-api PR path at PaymentsModule.ts:2924-2925 DOES `.toLowerCase()`, so the same module normalises on one path and not the other. (2) PM accepts ANY hex length >= 64 (a 70-char hex string is returned raw as a 'transport pubkey'); the resolver accepts only exactly 64 or 66. (3) PM handles no `@nametag`, `DIRECT://` or `PROXY://` form at all — those only work when `transport.resolve()` happened to pre-populate `peerInfo`. (4) No TTL cache / in-flight dedup, so every send re-hits the relay where a DM does not. core/transport-resolver.ts:6-8 states its purpose as 'Used by both CommunicationsModule (DMs) and PaymentsModule (token transfers) ... no code duplication' — that contract is unmet.
- **Fix:** Take the resolver as a dependency: `PaymentsModuleDependencies` already carries `transport`, so build one in `initialize()` (`this.transportResolver = createTransportAddressResolver(deps.transport)`) — or better, have Sphere pass `communications.getTransportResolver()` so DMs and transfers share ONE cache (that accessor at CommunicationsModule.ts:783 exists solely for this, per its own doc comment). Replace the body of `resolveTransportPubkey` with `peerInfo?.transportPubkey ?? (await resolver.r

### `validate()` repeats the mark-invalid tail; `deferDelivery`/`markDeliveryPoison`/`bumpDeliveryAttempts` repeat updatePendingV2Delivery+log+emit

- **Kind:** copy-paste · **Risk:** low · **Saves:** ~18 lines
- **Sites:** `modules/payments/PaymentsModule.ts:5198-5203`, `modules/payments/PaymentsModule.ts:5215-5220`, `modules/payments/PaymentsModule.ts:6883-6896`, `modules/payments/PaymentsModule.ts:6922-6931`, `modules/payments/PaymentsModule.ts:6933-6935`
- **Divergence:** No behavioural drift. The scan flagged 5198-5203|5215-5220 as an exact 6-line clone. Note `validate()`'s two branches also drift on failure posture — the engine branch skips a token on a transient error (L5205-5209, 'never invalidate funds on an outage') while the legacy-oracle branch has no such guard and will mark 'invalid' on any RPC failure. That asymmetry is documented but only one side is protected.
- **Fix:** In validate(): hoist `const markInvalid = (t: Token) => { t.status = 'invalid'; this.parsedTokenCache.delete(t.id); invalid.push(t); }`. In the delivery journal: extract `private async annotateDelivery(entry, mutate, level, message, event, payload)` — or accept these three as small enough and instead give the legacy-oracle validate branch the same transient-failure skip the engine branch has.

### Four 'pick a token storage provider' helpers with four different selection rules

- **Kind:** redundant-abstraction · **Risk:** low · **Saves:** ~18 lines
- **Sites:** `modules/payments/PaymentsModule.ts:975-988`, `modules/payments/PaymentsModule.ts:2643-2646`, `modules/payments/PaymentsModule.ts:4650-4660`, `modules/payments/PaymentsModule.ts:5122-5149`
- **Divergence:** `firstEnabledTokenStorage` (used only by the composition assertion, L1015) re-implements exactly what `getTokenStorageProviders()` + `getActiveTokenStorageProvider()` do, but as a free function over `deps` because it runs before `this.deps` is assigned. `getActiveTokenStorageProvider` ('the custody provider' — drives applyDelta, uploadOutputBlob, materializeSelectedSources) and `getLocalTokenStorageProvider` ('the history provider') pick DIFFERENTLY when a non-local provider sorts first, which is precisely the wallet-api composition. That is intentional but undocumented at the definition sites, and 'first' silently depends on Map insertion order.
- **Fix:** Consolidate into one `private selectProvider(role: 'active' | 'local'): TokenStorageProvider | null` on top of `getTokenStorageProviders()`, and make `firstEnabledTokenStorage` a thin static that shares the same normalize+filter code path (extract `normalizeProviders(map, single, disabled)` as a module-level pure function used by both).

### Handler-dispatch loops iterate the live Set; CommunicationsModule snapshots it and documents why, PaymentsModule/Sphere/GroupChat do not

- **Kind:** divergent-clone · **Risk:** low · **Saves:** ~18 lines
- **Sites:** `modules/payments/PaymentsModule.ts:3246-3252`, `modules/payments/PaymentsModule.ts:3407-3413`, `modules/payments/PaymentsModule.ts:6031-6037`, `modules/communications/CommunicationsModule.ts:633-642`, `modules/communications/CommunicationsModule.ts:663-670`, `modules/communications/CommunicationsModule.ts:687-694`, `core/Sphere.ts:4632-4638`, `modules/groupchat/GroupChatModule.ts:509-511`
- **Divergence:** CommunicationsModule fixed this deliberately at all three of its sites, with an explanatory comment at L634 and L663 ('snapshot Set to prevent mid-dispatch registration side-effects'). PaymentsModule's three sites, Sphere.ts:4632 and GroupChatModule.ts:509 never received the fix. All five iterate a live `Set` (PaymentsModule.ts:1049, 1053) whose unsubscribe closures (L2996, L3280) call `.delete` — so an SDK consumer whose `onPaymentRequest` handler unsubscribes a peer handler during dispatch skips that peer (JS Set iteration honours concurrent deletes), and one that registers a handler during dispatch has it invoked for the same event. Note the two PaymentsModule copies of the SAME dispatch also differ: L3246 (Nostr path) is unconditional, L6031 (wallet-api path) is gated on `status === 'pending'`.
- **Fix:** Extract `dispatchToHandlers<T>(handlers: ReadonlySet<(v: T) => void>, value: T, tag: string, label: string)` into `core/handler-dispatch.ts` implementing the snapshot form (`for (const h of Array.from(handlers))`) plus per-handler try/catch, and route all eight sites through it. Also collapses PaymentsModule.ts:3246-3252 and 6031-6037, which are the SAME dispatch for `paymentRequestHandlers` reached from the Nostr path and the wallet-api path.

### `receive()`'s two branches duplicate the 'diff the token map before/after and synthesize IncomingTransfer' loop

- **Kind:** copy-paste · **Risk:** low · **Saves:** ~15 lines
- **Sites:** `modules/payments/PaymentsModule.ts:3493-3508`, `modules/payments/PaymentsModule.ts:3532-3547`
- **Divergence:** The only difference is guard polarity (`if (before.has) continue` vs `if (!before.has) {...}`) — an inversion introduced when the branch was cloned. Both produce `senderPubkey: ''`, losing the sender identity the delivery envelope already carried (S6) — a shared shortcoming rather than a drift. The scan flagged four overlapping windows (3499-3508|3536-3547).
- **Fix:** Extract `private collectNewTokensAsTransfers(before: Set<string>, callback?): IncomingTransfer[]` and reduce both branches to `const before = new Set(this.tokens.keys()); await <fetch>; return { transfers: this.collectNewTokensAsTransfers(before, callback) };`.

### `syncDebounceTimer` shared by two cloned debouncers — an inventory-wake resync and a storage-remote-update sync cancel each other, and `unsubscribeStorageEvents()` silently kills a pending inventory resync

- **Kind:** shotgun-parallel · **Risk:** low · **Saves:** ~14 lines
- **Sites:** `modules/payments/PaymentsModule.ts:5094-5117`, `modules/payments/PaymentsModule.ts:5493-5501`, `modules/payments/PaymentsModule.ts:5078-5089`, `modules/payments/PaymentsModule.ts:1152`
- **Divergence:** The wake debouncer (L5493, §9) was cloned from the storage-event debouncer (L5094) but reused the single `syncDebounceTimer` field (L1152) instead of getting its own. Two consequences: (1) with both an IPFS provider (the only `onEvent` emitter — impl/shared/ipfs/ipfs-storage-provider.ts:761) and an injected delivery port composed, either debouncer cancels the other's pending work — the two do DIFFERENT things (`sync()` vs `resyncInventory(true)`), so the cancelled one is simply lost; (2) `unsubscribeStorageEvents()` (L5084-5088) unconditionally clears the field, and it is called from `initialize()` (L1303) and from `updateTokenStorageProviders()` → `subscribeToStorageEvents()` (L5058) at runtime — so adding/removing a provider (e.g. IPFS node started) silently drops an in-flight inventory-wake resync. The 30s `inventoryPollTimer` backstop converges it, so this delays rather than loses co
- **Fix:** Give the wake debouncer its own field (`inventoryDebounceTimer`), clear it in `teardownDeliveryPump()` (where the rest of the wake/poll teardown already lives) rather than in `unsubscribeStorageEvents()`, and extract a tiny `debounce(field, ms, fn)` helper so the two are one shape with two slots.

### Three handler-notify loops with identical try/catch/debug-swallow bodies

- **Kind:** copy-paste · **Risk:** low · **Saves:** ~14 lines
- **Sites:** `modules/payments/PaymentsModule.ts:3243-3252`, `modules/payments/PaymentsModule.ts:3404-3413`, `modules/payments/PaymentsModule.ts:6030-6037`
- **Divergence:** None functionally. `notifyTokenChange` (L1252-1262) is a FOURTH copy of the same idea with a silent `catch {}` and no log. The structural scan reported all three as a 3-site clone group (3243-3250 | 3404-3411 | 6030-6035).
- **Fix:** Add a module-level `function notifyAll<T>(handlers: Iterable<(v: T) => void>, value: T, label: string): void` next to the other module helpers (L102-1028) and call it from all four sites.

### Three `wallet-api-<x>:<kind>:<network>:<chainPubkey>` state-key builders, and PaymentsModule's silently falls back to the literal 'default' network

- **Kind:** copy-paste · **Risk:** high · **Saves:** ~14 lines
- **Sites:** `modules/payments/PaymentsModule.ts:5701-5704`, `modules/payments/PaymentsModule.ts:5727-5730`, `impl/shared/wallet-api/WalletApiMailboxProvider.ts:159-164`, `impl/shared/wallet-api/WalletApiTokenStorageProvider.ts:208-213`
- **Divergence:** Both providers read `this.client.network`, which is `readonly network: string` (wallet-api/client.ts:222) — non-optional, always present. PaymentsModule reads `PaymentsWalletApiPort.network`, declared `readonly network?: string` at PaymentsModule.ts:869 — OPTIONAL — and substitutes the literal `'default'` when absent. Since the composed port is structural, a custom or older `PaymentsWalletApiPort` that supplies the three payment-request endpoints but omits `network` makes every network share one key. That collapses BOTH the `?since=` cursor AND the #441 settling journal (prSettlingKey, L5727) across networks; the settling journal is the guard that holds a request non-payable while its transfer is in flight (its own doc at L5750-5757 says reverting a committed link 'would double-pay'), so a cross-network key collision there is a money-safety regression, not just a UI glitch. The `?? 'defa
- **Fix:** Export `walletApiStateKey(namespace: string, kind: string, network: string, chainPubkey: string)` from `wallet-api/types.ts` (or a small `wallet-api/state-keys.ts`) and have all four call it. Critically, give PaymentsModule the same missing-context behaviour the two providers already have: THROW when the network is unknown instead of substituting `'default'` — the pump is already `paymentRequestsApi()`-gated, so a port without a network is a composition error, not a runtime state to paper over.

### resumeIntent contains its OWN duplicated SENT-history tail (partial vs full completion) — two 11-line clones inside one method

- **Kind:** copy-paste · **Risk:** low · **Saves:** ~12 lines
- **Sites:** `modules/payments/PaymentsModule.ts:6598-6608`, `modules/payments/PaymentsModule.ts:6626-6636`
- **Divergence:** Only `amount` (delivered shortfall-adjusted vs full payload.amount) and `tokenId` (first DELIVERED genesisId vs first INTENT genesisId) differ. Both share dedupKey `SENT_transfer_<transferId>` (L120), so if a partial resume is followed by a later full resume of the same transferId the second REPLACES the first's delivered-amount record with the full amount — but that ordering cannot occur (the partial branch throws PartialSendConflictError). The structural scan flagged 6601-6606|6632-6637 and 6602-6607|6633-6638 as exact clones. The `tokenId` here is the `v2_`-prefixed form — see the first finding.
- **Fix:** Hoist a local `const writeSent = (amount: string, tokenId?: string) => this.addToHistory({ type:'SENT', amount, coinId: payload.coinId, symbol: this.getCoinSymbol(payload.coinId), timestamp: Date.now(), recipientPubkey: payload.recipient, memo: payload.memo, transferId, tokenId })` above the conflicted branch and call it from both.

### Provider-address-guard block duplicated between `loadWith` and `_doSync`

- **Kind:** copy-paste · **Risk:** low · **Saves:** ~12 lines
- **Sites:** `modules/payments/PaymentsModule.ts:1514-1524`, `modules/payments/PaymentsModule.ts:4938-4946`
- **Divergence:** Identical predicate; only the variable name, the data field (`result.data` vs `result.merged`) and the log prefix differ. The structural scan flagged 1509-1519|4935-4943 and 1515-1520|4939-4944. This is a money-safety guard (it stops another address's tokens entering the balance), so having it in two places is the exact shape that later drifts.
- **Fix:** Extract `private isForeignAddressData(data: TxfStorageDataBase | undefined): boolean` (or a module-level pure `isForeignAddressMeta(meta, currentChain)`) and call it from both, keeping the per-site log message at the call site.

### Dead local `fromHex` in PaymentsModule duplicating `core/crypto.hexToBytes`, which the same file already imports

- **Kind:** copy-paste · **Risk:** low · **Saves:** ~10 lines
- **Sites:** `modules/payments/PaymentsModule.ts:542-551`, `core/crypto.ts:322-330`, `modules/payments/PaymentsModule.ts:86`
- **Divergence:** Latent behavioural divergence, currently masked by the dead-ness: on ODD-length input `fromHex` computes `new Uint8Array(hex.length / 2)` with a fractional length and throws `RangeError: Invalid typed array length`, while `core/crypto.hexToBytes` silently truncates the trailing nibble. If anyone ever wires `fromHex` up (its name and doc comment invite it), untrusted `sdkData` handling changes from tolerant-truncate to throw.
- **Fix:** Delete PaymentsModule.ts:542-551 outright. `grep -n '\bfromHex\b' modules/payments/PaymentsModule.ts` returns exactly ONE line — the definition — so it has zero call sites, and `hexToBytes` is already in scope from the L86 import. Zero-risk delete; no test references it.

### The LOCAL tombstone state-hash derivation has two independent implementations, using two different crypto libraries, on opposite sides of the same key namespace

- **Kind:** divergent-clone · **Risk:** high · **Saves:** ~10 lines
- **Sites:** `modules/payments/PaymentsModule.ts:448-455`, `storage/whole-blob-inventory-adapter.ts:198-206`, `modules/payments/PaymentsModule.ts:429-436`, `modules/payments/PaymentsModule.ts:3832-3836`
- **Divergence:** PaymentsModule.ts:429-436 explicitly warns: 'Both writers and readers of these keys use THIS function; never mix the two derivations in one comparison.' That invariant is already violated in fact — `whole-blob-inventory-adapter.applyDelta` is a SECOND writer of exactly these `(tokenId, stateHash)` tombstones into the same `_tombstones` array that PaymentsModule loads at L1502 and matches against incoming tokens at L3832-3836, and it derives the hash with an entirely different implementation (@noble `sha256(Uint8Array)` vs CryptoJS `sha256(hexString, 'hex')`). I verified they produce the same digest today. Nothing enforces that: a change to `core/crypto.sha256`'s default input encoding, or a switch of either side to `bytesToHex` from a copy that lowercases differently, silently desynchronises them. Consequence in either direction is money-visible — a tombstone written by the adapter that 
- **Fix:** Export `localBlobStateHash(blob: TokenBlob): string` from `token-engine/token-blob.ts` (sibling to `deriveDeliveryKeys` in token-engine/blob-keys.ts, which owns the OTHER, protocol-true derivation) and have both `tryParseBlobKeys` and `applyDelta`'s tombstone path call it. Add a unit test that asserts the two previously-independent expressions agree, so the equality becomes enforced rather than incidental.

### Genesis-id derivation from a UI token id written five times in two spellings

- **Kind:** copy-paste · **Risk:** medium · **Saves:** ~8 lines
- **Sites:** `modules/payments/PaymentsModule.ts:1880-1881`, `modules/payments/PaymentsModule.ts:2203-2205`, `modules/payments/PaymentsModule.ts:2284-2287`, `modules/payments/PaymentsModule.ts:2698-2699`, `modules/payments/PaymentsModule.ts:2790-2792`
- **Divergence:** Three behaviours for one question. The `.slice(3)` spelling returns `null` for a non-`v2_` id; the `.replace(/^v2_/,'')` spelling returns the raw id unchanged (so a legacy TXF id is passed to `provider.getToken()` / `applyDelta()` as if it were a genesis hex). `materializeSelectedSources` (L2698) skips the sdkData attempt entirely and goes straight to the prefix strip. These feed the §7 `applyDelta` `spentStates`/removal list (L2340), so the difference is on the money path — currently masked because v2 ids are always `v2_<64hex>`.
- **Fix:** Add one module-level `export function genesisIdOf(token: Pick<Token,'id'|'sdkData'>): string | null` next to `extractTokenIdFromSdkData` (L509), decide the null-vs-passthrough policy once (recommend: return null and make callers fail loudly rather than send a non-hex id to applyDelta), and replace all five sites.

### `addToken` calls `notifyTokenChange(token)` twice for every added token

- **Kind:** redundant-abstraction · **Risk:** low · **Saves:** ~2 lines
- **Sites:** `modules/payments/PaymentsModule.ts:3902`, `modules/payments/PaymentsModule.ts:3910`
- **Divergence:** A merge artifact: the second call is separated from the first by an `await this.cacheEngineParsedToken(token)`, so subscribers fire twice on two different microtasks. `updateToken` (L3968) and every other mutation path call it exactly once. The current in-repo consumer (AccountingModule._handleTokenChange, AccountingModule.ts:4466) is idempotent via `tokenScanState` startIndex, so this is currently harmless — but `onTokenChange` (L1240) is a PUBLIC observer API, so any third-party subscriber that counts events or appends unconditionally double-counts every received/minted/change token.
- **Fix:** Delete the L3902 call (keep the later one so observers see the token after the parsed-cache is warm), or better: move the single notify to the very end of `addToken` alongside the existing final debug log.

</details>

---

## 4. Verified dead code (9 survived of 16)

Total removable: **~149 lines**

| Kind | Lines | Member | Evidence |
|---|---|---|---|
| dead-param | 18 | `send(request, internal?)` / `sendOnce(request, internal?)` second parameter — modules/payments/PaymentsModule | No caller anywhere passes a 2nd argument: `grep -rn 'existingReservationId|existingSplitPlan' --include=*.ts .` matches ONLY PaymentsModule.ts itself (lines 1768,1775,1787,1808,1822,1901,1914,1973,1974,1976). Its sole producer was `instantSplitSend()`, removed |
| vestigial-branch | 22 | `pendingTransfers` map + `getPendingTransfers()` + the PENDING_TRANSFERS restore block — modules/payments/Paym | Nothing anywhere WRITES STORAGE_KEYS_ADDRESS.PENDING_TRANSFERS — `grep -rn 'set(STORAGE_KEYS_ADDRESS.PENDING_TRANSFERS'` returns zero hits; the key is only declared (constants.ts:73,132), read (PaymentsModule.ts:1650) and asserted-null in tests/integration/wal |
| vestigial-branch | 25 | OUTBOX journal: `saveToOutbox` / `removeFromOutbox` / `loadOutbox` — modules/payments/PaymentsModule.ts:6725-6 | Write-only. `this.loadOutbox()` is called only from saveToOutbox (:6726) and removeFromOutbox (:6732) — nothing ever REPLAYS the outbox. The comment at :2527-2528 says so: 'The pre-send outbox snapshot can recover nothing (finished blobs are journaled in PENDI |
| unreachable-method | 14 | `waitForPendingOperations()` + `pendingBackgroundTasks` — modules/payments/PaymentsModule.ts:1036, 1910, 3565- | Zero callers in src, tests or docs (`grep -rn 'waitForPendingOperations' .` → only the definition, its own log lines, and core/Sphere.ts:2462 which is a comment saying 'No destroy, no waitForPendingOperations — old address keeps running.'). Since :3570 is the  |
| unreachable-method | 24 | `reloadNametagsFromStorage()` — modules/payments/PaymentsModule.ts:4738-4761 | Private with ZERO `this.reloadNametagsFromStorage(` call sites in the file (self-call count = 0). The only other repo hit is a test TITLE string at tests/unit/modules/PaymentsModule.test.ts:940 whose body actually drives `module.load()` (line 979) and never to |
| unreachable-method | 10 | `fromHex(hex)` — modules/payments/PaymentsModule.ts:542-551 | `grep -n 'fromHex' modules/payments/PaymentsModule.ts` → a single hit, the declaration at :545. The file imports and uses `hexToBytes` from core/crypto instead (:86). Not compiler-flagged because tsconfig.json sets `noUnusedLocals: false`. |
| unreachable-method | 18 | `createTombstoneFromToken(token)` — modules/payments/PaymentsModule.ts:571-588 | `grep -n 'createTombstoneFromToken' modules/payments/PaymentsModule.ts` → a single hit, the declaration at :574. Tombstone entries are constructed inline in removeToken/addToken instead. |
| unused-type | 17 | `export interface ProofPollingJob` — modules/payments/PaymentsModule.ts:708-724 (with its 'NOSTR-FIRST Proof P | Repo-wide `grep -rn 'ProofPollingJob' --include=*.ts .` returns exactly one line: the declaration. A v1 NOSTR-FIRST relic — the commitment/proof-polling machinery was deleted in the cutover. It leaks out via modules/payments/index.ts's `export *`, but the root |
| unused-type | 1 | unused import `type ParsedTokenPool` — modules/payments/PaymentsModule.ts:45 | `grep -n 'ParsedTokenPool' modules/payments/PaymentsModule.ts` → a single hit, the import at :45. `ParsedTokenEntry` from the same import statement IS used (:1177). |

---

## 5. Invariants that constrain every change

### Documented in code

**CERTIFIED-SPEND TERMINALITY — a source token whose spend was certified on-chain during a failed send becomes terminal 'spent' and is NEVER restored to 'confirmed'. Two independent evidence sources are OR'd: the in-scope **

- Enforced at: `modules/payments/PaymentsModule.ts:1913 (committedOnChainTokenIds declared)`, `modules/payments/PaymentsModule.ts:2186 + 2253 (.add() immediately after engine.transfer/split returns)`, `modules/payments/PaymentsModule.ts:2493-2519 (restore loop: spentOnChain → status='spent', else 'confirmed'+re-cache)`, `modules/payments/PaymentsModule.ts:2496-2498 (skip tokens already removeToken()'d — restoring would create phantoms)`, `modules/payments/PaymentsModule.ts:1608-1633 (load() crash reconcile of stuck 'transferring' → spent/confirmed via isSpent)`
- Break risk: committedOnChainTokenIds is a LOCAL of sendOnce shared across the try and the catch. Splitting sendOnce into an 'engine ops' unit and a 'failure disposition' unit hands the set across a boundary; if it is passed by value/copy, or if the extracted op-runner throws before the caller can observe its partial set, the restore loop sees an empty set. It then falls through to the isSpent probe — which is
- Test guard: tests/unit/modules/PaymentsModule.v2-send-recovery.test.ts:148 'transport failure AFTER engine.transfer (§3.1 #621): send resolves delivery-pending, source consumed, blob journaled'; :205 'pre-certification failure … source restored confirmed'; :240 "reconciles a persisted 'transferring' token: spent on-chain → terminal 'spent'"

**ProofUnconfirmedError (CERTIFICATION_UNCONFIRMED) and the three split-checkpoint errors KEEP THE INTENT OPEN — abortIntent must NOT be called even when committedOnChainTokenIds is empty (the throw beat the .add()).**

- Enforced at: `modules/payments/PaymentsModule.ts:2467-2472 (const keepOpen = ProofUnconfirmedError || CheckpointPersistFailedError || SplitCheckpointLostError || CheckpointTrustbaseMismatchError)`, `modules/payments/PaymentsModule.ts:2474-2483 (abort ONLY when TransferConflictError, or nothing certified AND !keepOpen)`, `modules/payments/PaymentsModule.ts:2581-2583 (error.transferId ??= result.id for possibly-committed outcomes — the #441 linkage)`, `modules/payments/PaymentsModule.ts:6486 (resumeIntent rethrows ProofUnconfirmedError from the split path before any conflict handling)`, `modules/payments/PaymentsModule.ts:3129-3175 (payPaymentRequestInner: isPossiblyCommittedSendOutcome → journal + 'settling', NEVER back to 'pending')`
- Break risk: The keepOpen predicate is computed from the caught error's CLASS. An extracted error-mapping layer that re-wraps engine errors (e.g. into a generic SphereError) erases `instanceof ProofUnconfirmedError`, so the naive path takes the `committedOnChainTokenIds.size === 0` branch and ABORTS the intent. The spend may already be on-chain; abort means resumeOpenIntents will never replay it, the recipient
- Test guard: tests/unit/modules/PaymentsModule.wallet-api-delivery.test.ts:1034 '#631: a proof-fetch failure AFTER certification keeps the intent OPEN (resume seed survives; no double-spend)'; :1072 '#631 regression: a clean pre-certification failure … still aborts + restores'; tests/unit/modules/PaymentsModule.payment-requests.test.ts:481 '(write site) a possibly-committed pay → status settling …'

**SAME-transferId RESUME with STABLE (transferId, opIndex) pairing — resume replays the identical realization seed so the engine rebuilds byte-identical transactions; the opIndex is the position in the persisted intent's `**

- Enforced at: `modules/payments/PaymentsModule.ts:2174 (send: { transferId: result.id, opIndex } from splitPlan.tokensToTransferDirectly.entries())`, `modules/payments/PaymentsModule.ts:2232-2234 (send split: opIndex = splitPlan.tokensToTransferDirectly.length)`, `modules/payments/PaymentsModule.ts:6417-6418 (resume: same { transferId, opIndex } replayed from payload.direct.entries())`, `modules/payments/PaymentsModule.ts:6435 (resume split: splitOpIndex = payload.direct.length)`, `modules/payments/PaymentsModule.ts:2717-2761 (buildIntentPayload — `direct` order IS the contract)`, `modules/payments/PaymentsModule.ts:6205 (resumeIntent called with the SERVER's transferId, never a fresh uuid)`
- Break risk: result.id is minted once at L1907 (`internal?.existingReservationId ?? randomUUID()`) and doubles as the reservation id, the intent id, the journal key, the applyDelta id and the history dedupKey. An extraction that gives the engine-op runner its own id, or that re-orders `splitPlan.tokensToTransferDirectly` between buildIntentPayload (L2755) and the op loop (L2168), silently re-pairs opIndexes. T
- Test guard: tests/unit/modules/PaymentsModule.wallet-api-delivery.test.ts:846 'an intent persisted before a crash resumes: deliver → apply → complete → history'; :1206 '#634: resume of a v:2 split re-runs the split THROUGH the checkpoint and recovers the change output'; tests/unit/token-engine/recoverable-engine.test.ts

**STATUS-AGNOSTIC RESUME — resume never keys off a submit status. A journaled blob for (transferId, opIndex) means that op ALREADY certified, so resume RE-DELIVERS the stored blob instead of re-running the engine; a Transf**

- Enforced at: `modules/payments/PaymentsModule.ts:6395-6396 + 6756-6763 (journaledByOp: byOp map keyed by opIndex ?? positional)`, `modules/payments/PaymentsModule.ts:6409-6412 (existing → deliverBlob, push to `spent`, engine NOT run)`, `modules/payments/PaymentsModule.ts:6423-6432 (conflict → conflicted=true, undeliveredAmount += balanceOf(source), NEVER pushed to `spent`)`, `modules/payments/PaymentsModule.ts:6520 (conflicted && spent.length === 0 → throw firstConflict — never applyDelta/complete an intent that delivered nothing)`, `modules/payments/PaymentsModule.ts:6539-6544 (applyDelta replays PERSISTED spentStates from the intent payload, not a live read)`
- Break risk: The journal (PENDING_V2_DELIVERIES) and the resume runner are in different clusters (tail/persist L6770-6947 vs resume L6099-6770) but share `withJournalLock`/`loadPendingV2Deliveries`. If an extraction gives resume its own journal reader that filters differently (e.g. skipping `undeliverable` or `deferredUntil` entries the way replayPendingV2Deliveries does at L6840-6842), journaledByOp returns E
- Test guard: tests/unit/modules/PaymentsModule.wallet-api-delivery.test.ts:1004 'audit#4: resume of a single source lost to a FOREIGN transfer ABORTS (conflicted) — never falsely completes'; :1093 (split twin); :1129 'audit#4 (Codex P1): MULTI-SOURCE partial — the delivered leg is retained (never double-paid)'; :1171 'legacy (v:1, no store) …'

**PENDING_V2_DELIVERIES CRASH REPLAY — a finished token blob is journaled BEFORE any delivery attempt and removed only after the delivery succeeds; load() replays the journal, so a crash or transport failure never loses th**

- Enforced at: `modules/payments/PaymentsModule.ts:2191-2198 (savePendingV2Delivery THEN tryDeliver, direct leg)`, `modules/payments/PaymentsModule.ts:2256-2263 + 2274 (split leg)`, `modules/payments/PaymentsModule.ts:6372-6389 (resume's deliverBlob journals first, too)`, `modules/payments/PaymentsModule.ts:6798-6812 (tryDeliver: never throws; removes the entry only on success; a cleanup failure must NOT flip the result to delivery-pending)`, `modules/payments/PaymentsModule.ts:1666-1668 (load() fire-and-forget replay)`, `modules/payments/PaymentsModule.ts:6764-6797 + 6938-6947 (withJournalLock wrapping save/remove/update)`
- Break risk: Two failure modes. (1) Ordering: an extracted 'delivery' collaborator that owns both journaling and sending is free to reorder them; deliver-then-journal loses the blob on a crash between the two. (2) Mutex scope: withJournalLock only serializes calls made through THIS instance's `journalMutation` field. Extracting the journal into a class instantiated per-call, or leaving replayPendingV2Deliverie
- Test guard: tests/unit/modules/PaymentsModule.v2-send-recovery.test.ts:169 'replayPendingV2Deliveries delivers the journaled blob and clears the journal'; tests/unit/modules/PaymentsModule.wallet-api-delivery.test.ts:523 'a deposit that failed after certification replays on load and lands in the mailbox'; :709 'two overlapping replay passes deliver each journaled entry ONCE'; :740 'concurrent journal mutations do NOT clobber each other — the journal lock serializes RMW'

**RESERVATION-LEDGER SYNCHRONOUS CRITICAL SECTION — free-amount read, split calculation and reservation write happen with NO await between them, so two concurrent sends can never reserve the same value.**

- Enforced at: `modules/payments/PaymentsModule.ts:1998-2001 (async pre-parse buildParsedPool deliberately BEFORE the section)`, `modules/payments/PaymentsModule.ts:2003-2010 (synchronous pendingChangeAmount scan of this.tokens)`, `modules/payments/PaymentsModule.ts:2012-2014 (spendPlanner.planSend — the whole critical section)`, `modules/payments/SpendQueue.ts:5-8 (documented invariant: planSend() and notifyChange() are FULLY SYNCHRONOUS)`, `modules/payments/PaymentsModule.ts:2398 (commit) / 2414 (cancel) / 4029 (cancelForToken)`
- Break risk: An extracted 'spend planning' service is the natural place to make planSend async (to fetch registry metadata, materialize a lazy blob, or await a storage read). One await between the free-amount read and the reservation write reopens the double-reserve race: both sends see the same free amount, both reserve, both spend the same source, the second gets TransferConflictError AFTER the first certifi
- Test guard: tests/unit/modules/PaymentsModule.concurrency.test.ts (whole file — esp. :150 'two sends both need split from same token → first reserves, second queued'; :538 'I-RL-2: free + reserved = tokenAmount'; :605 'two sends both need splits from same token'); tests/unit/modules/SpendQueue.test.ts; tests/unit/modules/SpendPlanner.test.ts

**PER-ADDRESS + PER-NETWORK STORAGE SCOPING — all payment operational state keys are network-scoped so a testnet2 journal can never drive a mainnet action; the token store is additionally address-guarded on read.**

- Enforced at: `constants.ts:131-147 (NETWORK_SCOPED_ADDRESS_KEYS includes PENDING_TRANSFERS, OUTBOX, TRANSACTION_HISTORY, PENDING_V5_TOKENS, PENDING_V2_DELIVERIES)`, `constants.ts:161-169 (isNetworkScopedAddressKey)`, `modules/payments/PaymentsModule.ts:5701-5704 (prCursorKey: `wallet-api-pr:cursor:${network}:${chainPubkey}` — hand-built, NOT via STORAGE_KEYS_ADDRESS)`, `modules/payments/PaymentsModule.ts:5733-5735 (prSettlingKey: `wallet-api-pr:settling:${network}:${chainPubkey}` — same)`, `modules/payments/PaymentsModule.ts:1512-1521 (load: reject provider data whose _meta.address != current chainPubkey)`, `modules/payments/PaymentsModule.ts:4938-4946 (_doSync: same address guard on merged data)`
- Break risk: The two wallet-api PR keys are built by hand from `paymentRequestsApi()?.network` and `deps.identity.chainPubkey` and are NOT in NETWORK_SCOPED_ADDRESS_KEYS — the scoping lives entirely in those two 3-line methods. An extraction that moves the settling journal or the cursor into a class taking a plain `storage` and a key STRING (rather than the key-builder closures) will hardcode or cache the key 
- Test guard: tests/integration/kv-network-isolation.test.ts, tests/integration/kv-network-isolation-extra.test.ts, tests/integration/token-storage-network.test.ts, tests/integration/file-storage-network-isolation.test.ts (storage layer). For the two hand-built PR keys the coverage is indirect: tests/unit/modules/PaymentsModule.payment-requests.test.ts:660 '(identity switch) a journal mutation queued under identity A does NOT pollute identity B' — NO test asserts the NETWORK segment of prCursorKey/prSettlingKey.

**IDENTITY-SWITCH POLLUTION GUARDS — six independent guards ensure work started under identity A can never write under identity B. (a) initialize() clears every per-address field; (b) loadWith serializes a different-owner **

- Enforced at: `modules/payments/PaymentsModule.ts:1290-1345 (initialize: unsubscribe, teardown pumps, reject resolvers, clear tokens/tombstones/archives/history/nametags, clearSdkDataCache L1314, hydrationEpoch++ L1324, null fieldEncryptionKey L1347 + checkpointStore L1348, reset settlingJournal L1415-1417)`, `modules/payments/PaymentsModule.ts:1486-1494 (loadWith owner coalesce/serialize)`, `modules/payments/PaymentsModule.ts:4499 + 4501 + 4544-4547 (hydrate owner + epoch capture and re-check)`, `modules/payments/PaymentsModule.ts:5739 + 5745 (ensureSettlingJournalLoaded keyAtLoad re-check)`, `modules/payments/PaymentsModule.ts:5776 + 5779 + 5786 (mutateSettlingJournal keyAtEnqueue double re-check)`, `modules/payments/PaymentsModule.ts:5952-5960 (surfaceIncomingPaymentRequest owner guard on wire.toPubkey)`
- Break risk: initialize() is a single 162-line reset that is the ONLY writer of most per-address fields. Extracting a cluster (history, PR pump, settling journal) without also extracting its reset line silently drops the field from the reset — e.g. leaving `historyHydratedFor`/`serverSeenHistoryKeys` set makes the new identity take the incremental fast path against the PREVIOUS owner's keyset and render anothe
- Test guard: tests/unit/modules/PaymentsModule.payment-requests.test.ts:660 '(identity switch, load-bearing) a journal mutation queued under identity A does NOT pollute identity B'; :684 '(identity switch during load) an in-flight load under A does NOT overwrite B journal'; tests/unit/modules/PaymentsModule.history-hydration.test.ts:168 'an owner switch re-initializes the fast path'; tests/unit/modules/PaymentsModule.load-coalescing.test.ts:203 'a different-owner call serializes behind the stale load and runs fresh'. NO test covers the same-owner epoch guard (L4544 hydrationEpoch !== epoch) in isolation.

**SINGLE-FLIGHT load() with exactly ONE trailing re-run — same-owner concurrent callers coalesce onto one load; a coalesced caller may request at most one trailing re-run, scheduled on a TRACKED macrotask that destroy()/in**

- Enforced at: `modules/payments/PaymentsModule.ts:1486-1494 (coalesce loop)`, `modules/payments/PaymentsModule.ts:1707-1717 (finally: null the flag, consume loadRerunRequested, schedule loadRerunTimer with resyncInventory(false))`, `modules/payments/PaymentsModule.ts:1460-1465 (loadFresh drains then runs fresh)`, `modules/payments/PaymentsModule.ts:1391-1394 + 5513 (inventory poll → resyncInventory(false))`, `modules/payments/PaymentsModule.ts:1722-1727 + 1325-1329 (destroy/initialize cancel the timer AND the flag)`, `modules/payments/PaymentsModule.ts:3543 (receive() uses loadFresh, not load)`
- Break risk: loadWith is 244 lines and the natural extraction target, but the single-flight state (loadInFlight / loadInFlightOwner / loadRerunRequested / loadRerunTimer) is read by loadFresh, written in a .finally, and cancelled from destroy() and initialize() — four clusters. Moving doLoad() out while leaving the guard behind (or vice-versa) most commonly loses the `rerunOnCoalesce=false` distinction, which 
- Test guard: tests/unit/modules/PaymentsModule.load-coalescing.test.ts:120 'coalesces concurrent same-owner calls onto one provider load'; :137 'the trailing re-run converges through resyncInventory'; :158 'the trailing re-run calls resyncInventory(false) so it cannot chain into back-to-back loads'; :227 'destroy() cancels a pending trailing re-run'; :242 'destroy() right after a completed load cancels the already-scheduled re-run'; tests/unit/modules/PaymentsModule.receive-fresh-pump.test.ts:232

**DEDUP IS (genesis tokenId, stateHash) — NEVER genesis id alone. A re-delivered IDENTICAL state is a duplicate; a NEW state of a token we already hold (self-send / A→B→A round-trip) MUST be accepted, but only after an on-**

- Enforced at: `modules/payments/PaymentsModule.ts:5337-5360 (handleV2Transfer: genesisId → id=`v2_${genesisId}`, incomingStateHash, held-state compare, isSpent gate at L5352)`, `modules/payments/PaymentsModule.ts:3835-3890 (addToken: tombstone check by exact (tokenId,stateHash), exact-duplicate check, CASE 1/2/3 older-state replacement)`, `modules/payments/PaymentsModule.ts:4009-4018 (removeToken tombstones the SPENT state, keyed `${genesisId}:${spentHash}`)`, `modules/payments/PaymentsModule.ts:4020-4027 (M2 keep-guard: live state != spent state → KEEP the reactivated token)`, `modules/payments/PaymentsModule.ts:119-127 (computeHistoryDedupKey: SENT keys on transferId; RECEIVED keys on tokenId+stateHash)`, `modules/payments/PaymentsModule.ts:436-500 (parseSdkDataCached — the ONE derivation of both keys; the LOCAL sha256 namespace, explicitly NOT the protocol imprint)`
- Break risk: There are TWO stateHash namespaces in this file: the LOCAL sha256 over token bytes (extractStateHashFromSdkData, L436-500) and the PROTOCOL imprint (engine.deliveryKeys(...).stateHash, used at L2325 and L2745 for spentStates.protocol and knownSpends). They are documented as never-mixable (L430-435). Extracting token-CRUD/dedup into one unit and the wallet-api apply into another makes it easy to pa
- Test guard: tests/unit/modules/PaymentsModule.tombstone.test.ts (whole file — :343 'add → remove → re-add same token → rejected'; :363 'add → remove → add with NEW stateHash → accepted'; :519-549 v2 blob cases); tests/unit/modules/PaymentsModule.token-keys.test.ts:49 'extractStateHashFromSdkData is the SHA-256 of the token bytes'; :63 'distinct token states yield distinct keys'; tests/unit/modules/PaymentsModule.v2-send-recovery.test.ts:257 'a tombstoned re-delivery emits NO transfer:incoming and writes NO history'

**#441 ORDERING — the settling journal PERSISTS before the in-memory status flip, so a crash between them leaves a durable link (reload re-applies 'settling') rather than a lost link (which would re-surface the request pay**

- Enforced at: `modules/payments/PaymentsModule.ts:3169-3171 (await journalSettling(...) THEN updatePaymentRequestStatus(requestId,'settling') — comment 'Order is load-bearing')`, `modules/payments/PaymentsModule.ts:5800-5806 (journalSettling with the `committed` flag)`, `modules/payments/PaymentsModule.ts:6288-6293 (reconcile: entry.committed → resolveSettledPaid unconditionally)`, `modules/payments/PaymentsModule.ts:6303-6315 (unaccounted id → lazy listIntents('aborted') authority; default is PAID — direction-of-error errs toward paid-never-re-payable)`, `modules/payments/PaymentsModule.ts:5964-5981 (reload re-apply: settling link + wire 'open' → status 'settling', suppressing the new-incoming notify)`, `modules/payments/PaymentsModule.ts:5867-5869 (journal loaded BEFORE the first surface call)`
- Break risk: surfaceIncomingPaymentRequest is SYNCHRONOUS and reads this.settlingJournal directly (L5967). Extracting the PR pump without the `await this.ensureSettlingJournalLoaded()` at L5869 (or making surface async and letting it load lazily) means the very first hydration after a reload surfaces the settling request as payable 'pending' and fires the incoming handler — the user taps pay and double-pays. L
- Test guard: tests/unit/modules/PaymentsModule.payment-requests.test.ts:521 '(RELOAD, load-bearing) a settling request is NOT re-surfaced as payable'; :548 '(resolution) when the linked transfer COMPLETES via resume → paid response sent exactly once'; :574 '(abort) → journal clears, request returns to payable'; :602 '(partial commit) a PartialSendConflictError whose anchor intent ABORTS stays PAID'; :756 '(concurrency RMW) two journalSettling for distinct requests racing from cold both survive'

**payPaymentRequest is PER-REQUEST SINGLE-FLIGHT — the status guard deliberately re-admits 'accepted' (for sequential retry), so only the payInFlight map prevents a concurrent double-tap from entering send() twice. The res**

- Enforced at: `modules/payments/PaymentsModule.ts:3097-3105 (payInFlight get/set/finally-delete)`, `modules/payments/PaymentsModule.ts:3115-3117 (guard admits 'pending' OR 'accepted')`, `modules/payments/PaymentsModule.ts:1166-1173 (field doc spelling out the double-pay mechanism)`
- Break risk: An extraction that splits payPaymentRequest (the guard) from payPaymentRequestInner (the work) across a module boundary, or that reconstructs the wrapper per call, loses the shared map and re-opens the audit#2 double-pay. Note also that the coalesced caller receives the FIRST caller's memo (documented at L3094-3096) — an extraction must not 'fix' this by keying on (requestId, memo).
- Test guard: tests/unit/modules/PaymentsModule.payment-requests.test.ts:403 'audit#2: two concurrent payPaymentRequest calls must NOT double-pay (payer spends the amount ONCE)'; :512 '(pay guard) a settling request is auto NON-payable'

**#676 LOCAL-ABORT AUTHORITY — resume honours a locally-aborted intent the server never learned about, and when the LOCAL disposition read FAILS it defers ALL open intents rather than resuming any (erring toward not double**

- Enforced at: `modules/payments/PaymentsModule.ts:6119-6132 (one batched getLocalIntentsMap read; localReadFailed on throw)`, `modules/payments/PaymentsModule.ts:6145-6152 (localReadFailed → classify every intent `failed`, continue)`, `modules/payments/PaymentsModule.ts:6153-6168 (local aborted/abortPending → re-abort, classify conflicted, never resume)`, `modules/payments/PaymentsModule.ts:6266 (reconcile also bails on localReadFailed — leave settling, retry next sign-in)`, `modules/payments/PaymentsModule.ts:2474-2483 (the abort that can leave the local copy abortPending)`
- Break risk: The 'defer everything' posture is expressed as a boolean flowing from the top of resumeOpenIntents into both the per-intent loop AND reconcileSettlingPaymentRequests (passed as an argument at L6231). An extracted resume runner that takes intents one at a time loses the batching (a perf regression the PR#681 review explicitly caught) and, more dangerously, tends to convert 'read failed' into 'no lo
- Test guard: tests/unit/modules/PaymentsModule.wallet-api-delivery.test.ts:883 '#676: a locally-aborted intent whose server abort never landed is NOT re-executed on resume (double-pay guard)'; :922 'a server-open intent with NO local copy (fresh device) still resumes'; :948 'the local intent dispositions are read ONCE (batched)'; :975 'a FAILING local-intent read does not abort resume and does NOT resume any intent'

**CRITICAL SAVE (#515 F2) — an unwritable ACTIVE custody provider must abort the send BEFORE anything is spent, and an unpersisted change token must fail the send rather than report success. save({critical:true}) throws on**

- Enforced at: `modules/payments/PaymentsModule.ts:2044 (await this.save({ critical: true }) right after marking sources 'transferring', before putIntent/engine)`, `modules/payments/PaymentsModule.ts:2266-2274 (non-server path: storeEngineToken(change, { criticalSave: true }) BEFORE the delivery attempt)`, `modules/payments/PaymentsModule.ts:6455 (resume: same criticalSave on the change output)`, `modules/payments/PaymentsModule.ts:6706-6720 (save(): activeId = providers.keys().next().value; only that one throws)`, `modules/payments/PaymentsModule.ts:1006 + 1289 (assertLegalCustodyComposition before any state is touched)`
- Break risk: `activeId` is positional — the FIRST entry of the Map returned by getTokenStorageProviders() (L5122-5152, which filters disabledProviderIds). getActiveTokenStorageProvider() (L2643) uses the same positional rule and is what applyDelta and getToken use. An extraction that rebuilds the provider map (e.g. sorts it, or filters in a different order) silently changes WHICH provider is 'active' — so appl
- Test guard: tests/unit/modules/PaymentsModule.fail-closed.test.ts:174-231 (#515 F1 composition matrix); :247 'mint reports FAILURE, not success, when the active provider cannot persist the blob'; :256 'a background save (public addToken) surfaces storage:degraded instead of silence'

**E.3 — the intent PUT is AWAITED BEFORE any engine submit; it is the only resume seed. A 422 VALIDATION rejection is deterministic and terminal (drop the local copy, skip the abort); transient failures rethrow and keep th**

- Enforced at: `modules/payments/PaymentsModule.ts:2093-2103 (await walletApi.putIntent BEFORE the op loop; requiresSeedClose set at intent-creation time for splits)`, `modules/payments/PaymentsModule.ts:2114-2131 (#670: WalletApiError VALIDATION && nothing certified → removeLocalIntent, intentRejected = true, typed SphereError)`, `modules/payments/PaymentsModule.ts:2474-2475 (intentRejected skips abortIntent)`, `modules/payments/PaymentsModule.ts:2717-2761 (buildIntentPayload is awaited INSIDE the putIntent call — its spentStates capture must happen pre-spend)`
- Break risk: buildIntentPayload calls engine.deliveryKeys per source (L2743) — it is async and inside the putIntent argument list. Any extraction that hoists it, memoizes it, or moves the putIntent after a 'prepare ops' step breaks the E.3 ordering: an engine submit before the intent is acked means a certified spend with NO resume seed, i.e. permanently lost value on a crash. `intentRejected` is a local boolea
- Test guard: tests/unit/modules/PaymentsModule.wallet-api-delivery.test.ts:354 'putIntent is awaited BEFORE the engine: an intent-endpoint outage fails the send with nothing spent'; tests/unit/modules/PaymentsModule.fail-closed.test.ts:272 '#516 dead backend at putIntent → send fails cleanly → resume executes NOTHING'; :346 '#670 deterministic putIntent VALIDATION rejection is terminal'

**REMOVETOKEN IS STATE-AWARE (M2/M7) — always tombstone the state we SPENT, but KEEP the map entry if it has advanced to a different state (a concurrent claim reactivated the token, e.g. a self-send round-trip). Legacy res**

- Enforced at: `modules/payments/PaymentsModule.ts:4000-4018 (spentHash = expectedStateHash ?? currentStateHash; tombstone the spent state)`, `modules/payments/PaymentsModule.ts:4020-4027 (keep-guard: currentStateHash !== expectedStateHash → save() and return, no delete)`, `modules/payments/PaymentsModule.ts:2205-2212 + 2286-2292 + 2439-2441 (send passes extractStateHashFromSdkData(sourceSdkData) — the blob AS HELD, never a live read)`, `modules/payments/PaymentsModule.ts:6552-6588 (resume: payload.spentStates[genesisId].local, else on-chain isSpent fail-closed)`, `modules/payments/PaymentsModule.ts:2154-2160 (consumedSources captures sourceSdkData pre-spend, explicitly so neither derivation is re-read from a claim-advanced view)`
- Break risk: The `sourceSdkData` capture is what makes the guard sound; materializeSelectedSources (L2684-2716) BACKFILLS sdkData onto both tw.uiToken and the live map entry (L2711-2714), so a naive extraction that reads state hashes from `this.tokens.get(id)` at removal time instead of from the captured blob will compare a state against itself and always delete — destroying a legitimately reactivated token (p
- Test guard: Partially: tests/unit/modules/PaymentsModule.tombstone.test.ts covers the tombstone side. NONE found that asserts the M2 keep-guard (live state != spent state → token KEPT) or the M7 legacy fail-closed branch at PaymentsModule.ts:6560-6588.

**validate() NEVER invalidates funds on a transient outage — an engine decode/verify/isSpent failure SKIPS the token; only a definitive negative verdict marks it 'invalid'.**

- Enforced at: `modules/payments/PaymentsModule.ts:5193-5210 (engine path: verdict.ok && !spent → valid; else invalid; catch → warn + skip)`, `modules/payments/PaymentsModule.ts:5214-5222 (legacy v1 TXF path via oracle.validateToken)`, `modules/payments/PaymentsModule.ts:5202 + 5219 (parsedTokenCache.delete on invalidation — keeps the spend queue consistent)`
- Break risk: The catch at L5205 is the only thing standing between an aggregator outage and the whole wallet being marked 'invalid'. An extracted validator that maps exceptions to a boolean verdict (a very natural refactor) turns 'network down' into 'token invalid' and zeroes the displayed balance. Note the two `parsedTokenCache.delete` calls must move WITH the invalidation or a queued send will spend a token 
- Test guard: tests/unit/modules/PaymentsModule.v2-validate.test.ts (file exists; verify it asserts the transient-skip branch — the skip path is the one that matters)

**loadFromStorageData PRESERVES in-flight 'transferring' tokens across the map clear — a load racing an active send must not drop the send's sources.**

- Enforced at: `modules/payments/PaymentsModule.ts:6976-6988 (preservedTransferring snapshot, tokens.clear(), re-set preserved, then skip parsed tokens whose id is preserved)`, `modules/payments/PaymentsModule.ts:4950 + 4961-4986 (_doSync's twin: savedTokens snapshot around loadFromStorageData, restore with genesis-id dedup + tombstone filter)`, `modules/payments/PaymentsModule.ts:1608-1633 (the counterpart: load() reconciles tokens LEFT 'transferring' by a crashed session)`
- Break risk: loadFromStorageData is a SYNCHRONOUS whole-map replace called from three places (loadWith L1524, _doSync L4956, and itself the tail cluster). It is the only writer that clears this.tokens outside initialize/destroy. Extracting a 'storage projection' unit that returns a fresh Map for the caller to assign loses the preserve-transferring step unless it is given the current map — and dropping a 'trans
- Test guard: NONE found that exercises a load()/sync() concurrent with an in-flight send and asserts the 'transferring' tokens survive. tests/unit/modules/PaymentsModule.v2-send-recovery.test.ts:221-255 covers the post-crash reconcile, not the concurrent-preserve.

**HISTORY DEDUPKEY IDEMPOTENCE — a resumed send writes the SAME dedupKey as the original attempt, so the §10 POST is a server-side no-op; RECEIVED is keyed per (tokenId, stateHash) so a re-acquired genesis token records ea**

- Enforced at: `modules/payments/PaymentsModule.ts:119-127 (computeHistoryDedupKey)`, `modules/payments/PaymentsModule.ts:4352 (addToHistory computes it)`, `modules/payments/PaymentsModule.ts:4366-4371 (upsert-by-dedupKey into _historyCache)`, `modules/payments/PaymentsModule.ts:6635-6644 (resume writes SENT with the same transferId)`, `modules/payments/PaymentsModule.ts:5394-5397 (RECEIVED carries stateHash)`
- Break risk: Low money risk, high UX risk. An extracted history unit that generates its own key (or drops `stateHash` from the RECEIVED entry) makes a self-send/round-trip receipt upsert onto the previous one — received history undercounts and stops netting against SENT.
- Test guard: tests/unit/modules/PaymentsModule.history.test.ts, PaymentsModule.history-sync.test.ts, PaymentsModule.history-integration.test.ts; tests/unit/modules/PaymentsModule.wallet-api-delivery.test.ts:1680 'J4: send → reload → the SENT record is hydrated … (no loss, no dupes)'; :1720 'J5: receive → reload …'

### ⚠ Undocumented — found only by the stress pass

These are the dangerous ones: real ordering/lifecycle invariants with no comment and, mostly, no test.

**PARSED-CACHE BEFORE QUEUE WAKE — cacheEngineParsedToken() must COMPLETE before spendQueue.notifyChange() for the same coin. The queue re-evaluates SYNCHRONOUSLY on notifyChange and reads parsedTokenCache directly (SpendQ**

- At: modules/payments/PaymentsModule.ts:3905-3907 (addToken: await cacheEngineParsedToken THEN notifyChange); :3953-3958 (updateToken, plus the `parsedTokenCache.has` precondition); :2507-2534 (sendOnce failure path — explicit comment 'Notify queue AFTER cache is rebuilt so queued entries see restored to
- Break risk: Four different clusters (token-store, send, provider-sync via rebuildParsedTokenCache:2630) wake one queue. Extract the token store behind an async port and the natural implementation fires the change event first and populates the cache after (or in parallel). UNTESTED at module level: tests/unit/modules/PaymentsModule.concurrency.test.ts hand-populates parsedTokenCache before calling queue.notify

**IN-FLIGHT SOURCE SURVIVES A WHOLESALE RELOAD — loadFromStorageData must preserve tokens with status 'transferring' across its tokens.clear().**

- At: modules/payments/PaymentsModule.ts:6976-6987 (snapshot preservedTransferring → clear → restore → `if (preservedTransferring.has(token.id)) continue`). Relied on by loadWith:1519 and by _doSync:4959, both of which can run (poll/wake/IPFS event) while a send is between planSend:2012 and its removeToke
- Break risk: save() serializes `Array.from(this.tokens.values())` (:6706-6712, via createStorageData:6951). If a concurrent load evicts the in-flight source, the next save persists a token set WITHOUT it, and sendOnce's restore loop then skips it permanently (`if (!this.tokens.has(token.id)) continue`, :2493-2495) — the source is gone from memory AND storage while its spend may not have certified. Any extracte

**MAP INSERTION ORDER == CUSTODY PRECEDENCE — the first non-disabled entry of getTokenStorageProviders() is the ACTIVE custody provider, and that identity must be the same in all four places that compute it.**

- At: modules/payments/PaymentsModule.ts:2643-2646 (getActiveTokenStorageProvider), :6706 (save: `activeId = providers.keys().next().value`, which gates the critical-save THROW at :6718 vs storage:degraded at :6721), :975-989 (firstEnabledTokenStorage, feeding assertLegalCustodyComposition:1006), :4650-46
- Break risk: Getting it wrong silently moves which provider's save failure is fatal (#515 F2) and which provider applyDelta/getToken talk to. tests/unit/modules/PaymentsModule.fail-closed.test.ts:232-268 composes exactly ONE provider, so a re-ordering refactor stays green. Compounded by updateTokenStorageProviders:5168-5176 mutating the map at runtime — the active provider can change BETWEEN materializeSelecte

**DESTROY IS A HARD STOP FOR WRITES — after destroy() clears the token map, nothing may call save().**

- At: NOWHERE. destroy():1719-1783 clears this.tokens (:1752) and parsedTokenCache (:1749) but does NOT null this.deps, does NOT reset this.loaded / this.loadedPromise (`this.loaded` is written only at :1658), and does not await in-flight work. ensureInitialized():7014-7018 only checks this.deps, so it st
- Break risk: A send in flight at destroy() reaches its failure handler and runs `await this.save()` at :2523 — persisting the now-EMPTY token map over the wallet's storage. Same for loadWith's saves at :1615/:1642. Sphere.destroy() calls payments.destroy() for every address module (core/Sphere.ts:3943, :3961) without draining. Any extraction that moves save() behind a repository must carry an explicit closed/d

**JOURNAL ARRAY ORDER IS THE LEGACY opIndex — the PENDING_V2_DELIVERIES array is append-ordered and journaledByOp falls back to array position when opIndex is absent.**

- At: modules/payments/PaymentsModule.ts:6756-6759 (`mine.forEach((e, i) => byOp.set(e.opIndex ?? i, e))`); writers append at :6774; the primary key for dedup/remove/update is the tokenBlob hex (:6772, :6782, :6941).
- Break risk: The obvious cleanup when extracting the journal is to store a Record keyed by tokenBlob (it already dedups on it). That destroys the positional pairing for pre-opIndex entries, so resume re-runs engine.transfer on an already-spent source, gets TransferConflictError, classifies it as a FOREIGN spend (:6421-6432) and drops the leg from `spent` — the recipient's certified value is neither recorded no

**STORE → EMIT → HISTORY in handleV2Transfer — the token must be persisted (and addToken's verdict checked) before transfer:incoming is emitted, and the event fires before the history write.**

- At: modules/payments/PaymentsModule.ts:5362-5391 (storeEngineToken → `if (!added) return 'storage-rejected'` with the explicit 'would announce a phantom payment' comment → emitEvent('transfer:incoming') → await addToHistory). The isSpent replay gate sits above it at :5348-5359.
- Break risk: Guarded on the storage side by v2-send-recovery.test.ts:257 ('a tombstoned re-delivery emits NO transfer:incoming and writes NO history'). NOT guarded on the emit→history side: an app handler that synchronously calls getHistory() on transfer:incoming sees no entry. An extracted ingest pipeline that emits first (or writes history first) passes every test.

**SURFACE BEFORE CURSOR — the incoming payment-request cursor is persisted only AFTER every wire on the page has been surfaced.**

- At: modules/payments/PaymentsModule.ts:5893-5896 (`for (const wire of page.requests) this.surfaceIncomingPaymentRequest(wire); await this.persistPrCursorState(page.cursor, page.syncEpoch);`), plus the syncEpoch re-pull at :5889-5891.
- Break risk: The surfaced list is in-memory only, so a cursor advanced past an unsurfaced page loses those requests for the rest of the session (only the once-per-session prBootstrapped since=0 scan at :5875-5885 heals it, and that flag is burned at :5884). An extracted cursor store that persists optimistically or batches is a silent request-loss.

**A SUCCESSFUL PAY MUST LEAVE A DURABLE 'PAID' RECORD — currently it does not.**

- At: NOWHERE for the happy path. payPaymentRequestInner:3131 flips 'paid' in memory only; :3133-3137 does a best-effort respondPaymentRequest whose failure is merely logged. journalSettling has exactly ONE call site (:3170) — the possibly-committed catch branch.
- Break risk: Successful send + failed respond + reload → surfaceIncomingPaymentRequest (:5966-5981) finds wire.status 'open' and NO settling entry → surfaces status 'pending' and re-fires the incoming handlers (:6031-6041). The user pays twice. The #441 tests (payment-requests.test.ts:521, :548, :574) all start from the possibly-committed branch, so this path is untested. Extracting settling-journal 'with pr-*

**OUTBOX RMW HAS NO LOCK — the one journal-shaped read-modify-write in the file that is NOT serialized.**

- At: NOWHERE. saveToOutbox:6725-6729 and removeFromOutbox:6731-6735 both do loadOutbox() → mutate → storage.set with no mutex, while the structurally identical PENDING_V2_DELIVERIES RMW is wrapped in withJournalLock (:6764-6768) and the settling journal in mutateSettlingJournal (:5767-5799).
- Break risk: Two concurrent sends (the SpendQueue explicitly allows them) clobber each other's outbox entry. Low money impact today (the outbox is a pre-send snapshot that 'can recover nothing' per :2527-2529), but an extraction that promotes the outbox to a real recovery seam inherits the race. It is also the natural place a refactor 'unifies the two journals' and accidentally gives them ONE lock — see the de

**`loaded` IS NEVER RESET — five barrier readers skip their await after an address switch.**

- At: modules/payments/PaymentsModule.ts:1658 is the ONLY writer of this.loaded; :1662 the only writer of loadedPromise. Neither initialize() (:1287-1448) nor destroy() (:1719-1783) touches them.
- Break risk: After initialize() clears this.tokens (:1313), `loaded===true` persists, so handleV2Transfer:5289, handleIncomingTransfer:5406, doPumpIncomingDeliveries:5569, doPumpPaymentRequests:5838 and resumeOpenIntents:6105 all skip `await this.loadedPromise` and run dedup against an EMPTY map (phantom duplicate receives / a resume with no local sources). The coupling doc flags this in its field matrix but t

**reconcileSettlingPaymentRequests SINGLE-FLIGHT is a check-then-await-then-set race.**

- At: modules/payments/PaymentsModule.ts:6263 (`if (this.reconcileInFlight) return;`) … :6264 (`await this.ensureSettlingJournalLoaded()`) … :6267 (`this.reconcileInFlight = true;`), cleared at :6322.
- Break risk: Two overlapping resumes both pass the check and both run the reconcile loop. Today the damage is bounded because resolveSettledPaid:6327-6345 swallows a 409 non-open conflict (:6335-6341), i.e. the respond is effectively idempotent. Extracting the settling journal into a service that does NOT preserve that 409 swallow turns the race into a double-respond error path that leaves the journal uncleare

---

## 6. Concurrency hazards

| Hazard | Sites | Constraint on extraction |
|---|---|---|
| Promise-chain mutex over the PENDING_V2_DELIVERIES journal (`journalMutation`). withJournalLock chains fn onto the tail and stores the tail back; every whole-blob read-modify-write (load → mutate arra | `modules/payments/PaymentsModule.ts:1201 (field)`, `modules/payments/PaymentsModule.ts:6764-6769 (withJournalLock)`, `modules/payments/PaymentsModule.ts:6771-6779 (savePendingV2Delivery)`, `modules/payments/PaymentsModule.ts:6780-6797 (removePendingV2Delivery)` | All four journal mutators plus their storage key MUST move as one unit and share ONE `journalMutation` instance. Two lock instances over the same key = the #517 clobber = a lost recipient token. Note loadPendingV2Deliveries is called OUTSIDE the lock by replayPendingV2Deliveries  |
| Promise-chain mutex over the #441 settling journal (`settlingJournalWrite`) COMBINED with a single-flight lazy load (`settlingJournalLoad`) and an identity key captured at ENQUEUE time. The mutation b | `modules/payments/PaymentsModule.ts:1110-1112 (fields)`, `modules/payments/PaymentsModule.ts:5737-5766 (ensureSettlingJournalLoaded — `??=` memo + keyAtLoad re-check at L5745)`, `modules/payments/PaymentsModule.ts:5767-5799 (mutateSettlingJournal — keyAtEnqueue at L5776, checks at L5779 and L5786)`, `modules/payments/PaymentsModule.ts:1415-1417 (initialize resets all three; explicitly does NOT cancel queued .then callbacks)` | The synchronous reader (L5967) is the constraint: the journal Map must be a plain in-memory field readable without awaiting, and every entry point that can reach surfaceIncomingPaymentRequest must have awaited ensureSettlingJournalLoaded first. An extracted 'SettlingJournal' clas |
| `reconcileInFlight` boolean guard is checked BEFORE two awaits but only SET after them — a genuine TOCTOU window. | `modules/payments/PaymentsModule.ts:6263 (if (this.reconcileInFlight) return)`, `modules/payments/PaymentsModule.ts:6264 (await ensureSettlingJournalLoaded)`, `modules/payments/PaymentsModule.ts:6265-6266 (two more early returns)`, `modules/payments/PaymentsModule.ts:6267 (this.reconcileInFlight = true)` | Two concurrent resumeOpenIntents can both pass L6263 and both enter the loop, issuing duplicate respondPaymentRequest calls (idempotent-ish: the 409 path at L6335-6341 swallows it) and duplicate clearSettling mutations (safe via the mutex). Do NOT 'fix' this by hoisting the set a |
| Read-modify-write on `this.tokens` across awaits inside sendOnce. | `modules/payments/PaymentsModule.ts:2003-2010 (sync scan for pendingChangeAmount)`, `modules/payments/PaymentsModule.ts:2039-2044 (set status='transferring' + parsedTokenCache.delete for each source, THEN await this.save({critical:true}))`, `modules/payments/PaymentsModule.ts:2495-2519 (restore loop: this.tokens.has → await engine.isSpent → this.tokens.set)`, `modules/payments/PaymentsModule.ts:2705-2714 (materializeSelectedSources backfills sdkData onto the LIVE map entry after an await)` | The send path assumes it is the only writer of a source token's status between L2041 and the restore loop — but the incoming pump (handleV2Transfer → addToken) and load() both write the same map concurrently. The current protection is the reservation (documented at L1602-1607) pl |
| `_doSync` snapshots the token map, calls loadFromStorageData (which CLEARS it), then restores — an unlocked RMW spanning provider I/O. | `modules/payments/PaymentsModule.ts:4950 (const savedTokens = new Map(this.tokens))`, `modules/payments/PaymentsModule.ts:4953 (this.loadFromStorageData(result.merged) → 6983 tokens.clear())`, `modules/payments/PaymentsModule.ts:4961-4986 (rebuild existingGenesisIds, restore with tombstone + genesis-id dedup)`, `modules/payments/PaymentsModule.ts:4989-4992 (restore nametags if sync wiped them)` | sync() and load() are coalesced independently (_syncInProgress vs loadInFlight) and can run CONCURRENTLY, both clearing and rebuilding this.tokens. Extraction must not add a third independent path into loadFromStorageData; if a shared 'token repository' is extracted, this clear-a |
| `addToken` iterates `this.tokens` while awaiting inside the loop body. | `modules/payments/PaymentsModule.ts:3841-3849 (duplicate scan)`, `modules/payments/PaymentsModule.ts:3853-3888 (older-state scan: `await this.archiveToken(existing)` at L3873/L3882 then `this.tokens.delete(existingId); break;`)`, `modules/payments/PaymentsModule.ts:3892 (tokens.set)`, `modules/payments/PaymentsModule.ts:3899 (await archiveToken(token))` | Between the archive await and the delete, another task can have replaced or removed that map entry; the delete then removes whatever is there now. The `break` bounds the damage today. An extraction that turns this into a full scan without the break, or that awaits the archive for |
| `handleV2Transfer` reads the held token, then awaits an on-chain isSpent probe, then writes via storeEngineToken → addToken. | `modules/payments/PaymentsModule.ts:5339 (const held = this.tokens.get(id))`, `modules/payments/PaymentsModule.ts:5352 (if (await engine.isSpent(token)) → reject)`, `modules/payments/PaymentsModule.ts:5362 (await this.storeEngineToken(...))`, `modules/payments/PaymentsModule.ts:5290-5292 (the loadedPromise barrier that must precede all of it)` | The pump drains entries SEQUENTIALLY (`for await` at L5586) so two entries never interleave here, but load()/sync() can clear the map during the isSpent await. Any extraction that parallelises the incoming drain (a natural 'performance' change) makes two deliveries of the same ge |
| ONE debounce timer field shared by TWO different debounced actions. | `modules/payments/PaymentsModule.ts:1152 (syncDebounceTimer)`, `modules/payments/PaymentsModule.ts:5094-5117 (debouncedSyncFromRemoteUpdate → this.sync())`, `modules/payments/PaymentsModule.ts:5493-5501 (debouncedInventorySyncFromWake → resyncInventory(true) → loadWith(true))`, `modules/payments/PaymentsModule.ts:5078-5093 (unsubscribeStorageEvents clears it)` | Each cancels the other's pending action. If the storage-event cluster and the wake/delivery cluster are extracted into different units they will each want their own timer — which CHANGES behaviour (both now fire). That may be the right fix, but it is a behaviour change that must  |
| Coalescing single-flights that a caller must sometimes DEFEAT: `loadInFlight` (defeated by loadFresh) and `pumpInFlight` (defeated by pumpIncomingDeliveriesFresh). | `modules/payments/PaymentsModule.ts:1460-1465 (loadFresh: while(loadInFlight) await .catch(); then loadWith(true))`, `modules/payments/PaymentsModule.ts:3543 (receive() → loadFresh)`, `modules/payments/PaymentsModule.ts:5555-5566 (pumpIncomingDeliveriesFresh: await the in-flight, swallow its failure, then start fresh)`, `modules/payments/PaymentsModule.ts:3495 (receive() → pumpIncomingDeliveriesFresh)` | There are two DISTINCT contracts per operation — 'converge eventually' (coalesce) and 'observe as of NOW' (fresh). An extracted service that exposes only the coalescing variant makes receive() return without the delivery that just landed (the exact bug PaymentsModule.receive-fres |
| `replayInFlight` is a DROP guard, not a queue — an overlapping replay pass is discarded, not queued. | `modules/payments/PaymentsModule.ts:1186-1193 (field doc)`, `modules/payments/PaymentsModule.ts:6835-6852 (set before the first await, cleared in finally)`, `modules/payments/PaymentsModule.ts:1666-1668 (load() kicks it fire-and-forget)`, `modules/payments/PaymentsModule.ts:3543 → 1666 (receive() → loadFresh → load → replay: the documented overlap source)` | Correctness depends on 'dropped entries stay journaled and replay on the next load()'. An extraction that converts this to a queue (so nothing is dropped) would re-introduce duplicate delivery attempts racing the per-entry `attempts` RMW; one that removes the guard entirely loses |
| `pendingBackgroundTasks` array is reset to [] after an awaited allSettled — trackers pushed during the await are lost. | `modules/payments/PaymentsModule.ts:1036 (field)`, `modules/payments/PaymentsModule.ts:1915-1918 (sendOnce pushes its tracker)`, `modules/payments/PaymentsModule.ts:2594-2596 (finally resolves it)`, `modules/payments/PaymentsModule.ts:3565-3573 (waitForPendingOperations: await allSettled(this.pendingBackgroundTasks) THEN this.pendingBackgroundTasks = [])` | switchToAddress relies on this to avoid a send save()ing into the wrong address's storage. Extracting send without keeping the push/resolve pair, or 'simplifying' the reset, silently weakens the address-switch barrier. Prefer splicing only the settled entries. |
| Long paginated await followed by a WHOLESALE cache replace, guarded only by an after-the-fact owner+epoch check. | `modules/payments/PaymentsModule.ts:4499 + 4501 (capture owner, epoch)`, `modules/payments/PaymentsModule.ts:4518-4541 (up to MAX_HISTORY_HYDRATION_PAGES awaited listHistory calls)`, `modules/payments/PaymentsModule.ts:4544-4547 (re-check; discard on mismatch)`, `modules/payments/PaymentsModule.ts:4552-4563 (merge-or-replace of _historyCache)` | The epoch counter is the ONLY thing that distinguishes 'same owner, re-inited mid-pull' from 'same owner, still valid'. Any extraction of the history cluster must carry hydrationEpoch AND keep initialize() as its incrementer — a history service that owns its own epoch but is not  |
| Two fire-and-forget promises started inside loadWith's run() that outlive the returned promise. | `modules/payments/PaymentsModule.ts:1666-1668 (void this.replayPendingV2Deliveries().catch(...))`, `modules/payments/PaymentsModule.ts:1670-1677 (pumpHealth.run('delivery'|'payment-requests') — not awaited)`, `modules/payments/PaymentsModule.ts:1708-1717 (the .finally that schedules loadRerunTimer)`, `modules/payments/PaymentsModule.ts:1719-1727 (destroy cancels only the timer, NOT the two in-flight pumps)` | load() resolving does NOT mean the replay or the pumps finished. Tests and callers that await load() and then assert on the journal are timing-dependent. An extraction that makes these awaited would change load()'s latency contract (and could deadlock: the pumps await loadedPromi |
| Module-global mutable cache shared by every PaymentsModule instance in the process. | `modules/payments/PaymentsModule.ts:436-437 (const sdkDataCache, SDK_DATA_CACHE_MAX)`, `modules/payments/PaymentsModule.ts:495-498 (clear-on-overflow then set)`, `modules/payments/PaymentsModule.ts:502-504 (clearSdkDataCache)`, `modules/payments/PaymentsModule.ts:1314 (the ONLY caller: initialize)` | Two Sphere instances (or two bundle contexts — the file already documents this hazard for the TokenRegistry singleton) share this cache; wallet A's initialize() clears wallet B's cache. Keyed by the sdkData STRING so entries are value-correct, hence no cross-wallet corruption tod |
| `this.tokens` is captured by CLOSURE into SpendQueue rather than passed per call, and SpendQueue is REASSIGNED on every initialize(). | `modules/payments/PaymentsModule.ts:1213-1218 (ctor: new SpendQueue(ledger, planner, () => this.tokens, parsedTokenCache))`, `modules/payments/PaymentsModule.ts:1332-1341 (initialize: ledger.clear, parsedTokenCache.clear, spendQueue.destroy(), NEW SpendQueue with the same closures)`, `modules/payments/PaymentsModule.ts:2013 (planSend receives this.reservationLedger and this.spendQueue explicitly)` | The queue reads the LIVE map and the LIVE parsed cache at wake time. If token state moves behind an extracted repository object, the closure must return that repository's live map — snapshotting it into the queue makes woken sends plan against stale inventory (SEND_QUEUE_TIMEOUT  |

---

## 7. Test safety net

| Cluster | Strength | Gap a refactor could slip through |
|---|---|---|
| send() / sendOnce() / spend planning / intent lifecycle / delivery journal (L1785-2837, L6099-6770) | **strong** | The money-safety invariants are genuinely pinned. Two blind spots: (a) `resumeIntent` (:6358, 288L) is never named directly — every assertion routes through `resumeOpenIntents()`, so an extraction that changes its internal contract (opIndex pairing, spentStates fallback, v:1-vs-v |
| Spend queue / reservation synchronous critical section (already-extracted siblings) | **strong** | PaymentsModule.concurrency.test.ts does NOT import PaymentsModule — its imports (lines 17-18) are TokenReservationLedger and SpendQueue only. So the no-await critical section is verified at the sibling level, never through sendOnce(). An extraction that moves the planSend() call  |
| Payment requests: incoming + outgoing + pay + response dispatch + settling journal (L2837-3485, L5679-6100, L6257-6358) | **strong** | Both port paths are covered and the settling journal is exercised through `journalSettling` / `ensureSettlingJournalLoaded` pokes. Untested: `acceptPaymentRequest`, `markPaymentRequestPaid`, `removePaymentRequest`, `removeOutgoingPaymentRequest`, `clearCompletedOutgoingPaymentReq |
| Transaction history: local cache, dedup keys, wallet-api hydration, field decryption (L4312-4650) | **strong** | `computeHistoryDedupKey`'s stateHash leg (:119-127 — the self-send / A→B→A round-trip fix) is only asserted indirectly via history-integration flows. `tryDecryptField` (:4606) and `historyEntryFromWire` (:4575) have no direct test, and FULL_HISTORY_REPULL_EVERY (:148, the every-2 |
| Incoming delivery pump / wake handling / handleV2Transfer (L5236-5680) | **strong** | Tests reach in through the PRIVATES `handleV2Transfer` and `handleIncomingTransfer` (4+ files poke the latter via `as any`), so renaming either breaks ~10 test files — treat both names as a de-facto public contract during extraction. Not directly asserted: the v1-payload drop bra |
| load() / loadWith() single-flight + crash reconciliation (L1449-1719) | **strong** | The trailing-re-run macrotask (:1704-1707) and its destroy()/re-init cancellation (:1723-1724) are covered. Uncovered: the `_placeholder` sweep (:1556-1571) and the `mergeLazyInventory` failure path (:1548-1554). |
| Token CRUD + tombstones (L3819-4150) | **strong** | `updateToken()` (:3926, 66L) has zero callers AND zero tests. `pruneTombstones()` (:4137) is untested. `removeToken`'s `expectedStateHash` keep-guard — the M7 state-aware path used by resumeIntent (:6556, :6575) — is exercised only through the resume tests, never directly. |
| Archived + forked TXF token stores (L4152-4301, archiveToken L6646, helpers L590-689) | **none** | NOT ONE test touches getArchivedTokens/getBestArchivedVersion/mergeArchivedTokens/pruneArchivedTokens/getForkedTokens/storeForkedToken/mergeForkedTokens/pruneForkedTokens/archiveToken, nor the four module helpers behind them (isIncrementalUpdate/countCommittedTxns/pruneMapByCount |
| sync() / _doSync() / storage-event subscription / token-storage-provider selection (L4886-5185) | **partial** | _doSync (:4904, 153L) is covered only on its history leg. `subscribeToStorageEvents` (:5057), `unsubscribeStorageEvents` (:5078), `debouncedSyncFromRemoteUpdate` (:5094, incl. the 500ms SYNC_DEBOUNCE_MS timer) and `updateTokenStorageProviders` (:5168) have no test — a refactor th |
| Price / assets / balance aggregation (L3557-3800) | **partial** | Only the no-PriceProvider path is asserted. Untested: getFiatBalance WITH a live provider, the price-fetch failure path (:3652), `isPriceDisabled()` (:5154 — including its `(this.priceProvider as Record)?.id` duck-type read), and `aggregateTokens`/`accumulateToken`/`newAssetAccum |
| Nametags on PaymentsModule (L4650-4770) | **thin** | Three of the four accessor cases (lines 268-286) are `expect(typeof module.X).toBe('function')` tautologies — existence, not behavior. Only the storage-recovery case at :940 drives real code (through load()). `currentNametagName()`'s getCurrentNametag-vs-nametags[0] precedence (: |
| Module-level token-key / parse helpers (L102-690) | **partial** | The v2 blob path plus one v1 TXF fallback are pinned. Untested: sdkDataCache eviction at SDK_DATA_CACHE_MAX (:495-497), `clearSdkDataCache()`'s address-switch contract (:502, called from initialize :1314 — a stale cache across an address switch is a cross-address key-collision ha |
| destroy() / teardown (L1719-1785, teardownDeliveryPump L5450, teardownPaymentRequestPump L5692) | **thin** | Only 'does not throw on a fresh module' and 'clears the token cache' are asserted. destroy() releases ~10 timers/subscriptions/resolvers; no test verifies that deliveryPollTimer, inventoryPollTimer, prPollTimer, syncDebounceTimer, loadRerunTimer, storageEventUnsubscribers and pen |
| WARNING — tests/unit/modules/PaymentsModule.test.ts overstates its coverage | **thin** | Roughly lines 80-573 (~495 of its 986) are TAUTOLOGICAL: they build local literals and assert on them without ever touching PaymentsModule. :81-93 re-implements 'format detection logic (same as in handleIncomingTransfer)' inline for the removed v1 sourceToken+transferTx wire; :49 |

---

## 8. Design selection

Two architectures were designed independently, then judged.

| Design | Safety | Cohesion | Shippability | Total |
|---|---|---|---|---|
| Architecture A — Collaborator Extraction, risk-first | 8 | 8 | 8 | **24** |
| Seam-First: one intent pipeline, two entry points | 7 | 7 | 6 | **20** |

**Winner:** Architecture A — Collaborator Extraction, risk-first (24 vs 20). A wins on ordering discipline, published-API safety, mechanical verifiability and per-stage standalone value, and it contains no change that actively corrupts behavior once its one conflict-policy hole is patched from B. B contains the single best idea in either document (the shared intent executor with conflict policy as a parameter) and by far the better verification instruments, but it ships two behavior/consumer breaks under 'straight deletion' labels and stakes the whole plan on three consecutive unreviewable high-risk stages. Execute A's stage ordering and public-API discipline; import B's send-pipeline design and its entire verification apparatus wholesale.

### Fatal flaws caught and repaired

- [B — CONSUMER BREAK] Stage 2 deletes ~10 PUBLIC methods that are DOCUMENTED in docs/API.md:513-543 (getBestArchivedVersion, mergeArchivedTokens, pruneArchivedTokens, getForkedTokens, storeForkedToken, mergeForkedTokens, pruneForkedTokens) plus pruneTombstones, from a class exported at index.ts:260 (`export { PaymentsModule, createPaymentsModule } from './modules/payments'`). B justifies this with a repo-internal grep and then asserts 'the package

- [B — MONEY-ADJACENT BEHAVIOR CHANGE MISLABELED AS DELETION] Stage 2 removes archiveToken's fork branch (PaymentsModule.ts:6659-6663) under the label 'straight deletion, no restructuring'. That branch decides, when an archived TXF is NOT an incremental update, whether archivedTokens keeps the OLD version (fork → stored separately) or is overwritten. archivedTokens is read by AccountingModule at :404, :1054, :1431 and :4057 and fed into _scanTokenF

- [A — DOUBLE-PAY RISK IF EXECUTED AS WRITTEN] intent-executor.ts is described as 'THE unification: the single (certify → journal → deliver → applyDelta → remove-source) primitive that sendOnce and resumeIntent are today two independent copies of' and its publicSurface (executeDirectOp / executeSplitOp / deliverAndJournal) contains no conflict parameter and no mention of TransferConflictError. The two loops are NOT copies on this axis: :2180-2189 r

- [A — SILENT SEMANTIC CHANGE IN A 'MECHANICAL' STAGE] load-orchestrator.ts is assigned `loaded` (:1118) and `loadedPromise` (:1117), and A's philosophy mandates `reset(owner)` on every collaborator. `this.loaded` is written at exactly ONE site (:1658) and is deliberately never reset by initialize (:1287-1448) or destroy (:1719-1783); five barrier readers short-circuit on it (:5289, :5406, :5569, :5838, :6105 — handleV2Transfer, handleIncomingTrans

- [A — ENCAPSULATION THAT CANNOT HOLD] provider-sync.ts is given _doSync (:4904-5056), but _doSync writes the token map DIRECTLY (`this.tokens.set(tokenId, token)` at :4986, deliberately BYPASSING addToken's dedup/state-replacement rules), calls loadFromStorageData (:4952) and rebuildParsedTokenCache (:4997) — all of which A places in token-store.ts. If TokenStore exposes only add()/update()/remove(), _doSync's restore loop is inexpressible; if it 

- [B — UNDER-SPECIFIED EXECUTOR CONTRACT] IntentExecutor's movedFrom claims 'sendOnce L2163-2215 (direct-transfer loop)', which INCLUDES the per-leg `await this.removeToken(tw.uiToken.id, result.id, extractStateHashFromSdkData(...))` at :2213 on the non-serverApply path. But the listed ExecContext is {engine, delivery, journal, identityChainPubkey, storeChangeToken, checkpointStore, currentNametag} — no token-map write access. Either the executor g

- [B — UNREVIEWABLE STAGE] Stage 6 relocates 560 lines (sendOnce ~702L + resumeIntent ~288L collapsed onto the pipeline) and depends on stages 4 and 5, which are themselves 420 and 290 moved lines at 'high' risk. B explicitly argues that 'fixing it inside a 560-line relocation makes the diff unreviewable' — the same argument condemns the relocation. None of stages 4/5/6 delivers value until 6 lands.

- [BOTH — UNSCHEDULED DOC BREAK] Both delete getPendingTransfers (documented at docs/API.md:634, referenced at docs/INTEGRATION.md:577) and waitForPendingOperations. Both deletions are correct — nothing repo-wide writes STORAGE_KEYS_ADDRESS.PENDING_TRANSFERS (only the read at :1650), and core/Sphere.ts:2462 is a COMMENT ('No destroy, no waitForPendingOperations — old address keeps running') — but neither plan schedules the docs/API.md + docs/INTEGR

- [BOTH — A REAL DOUBLE-PAY THAT SURVIVES BOTH REFACTORS] The happy path of payPaymentRequestInner flips status to 'paid' IN MEMORY ONLY (:3133) and then does a best-effort respond whose failure is merely logged (:3134-3138). journalSettling has exactly ONE call site — :3170, inside the possibly-committed catch. So: successful send + failed respond + reload → surfaceIncomingPaymentRequest (:5964-5981) finds wire.status 'open' and no settling entry,

### Key non-obvious findings

- **Biggest unblocker:** Not delivery-journal. The single extraction that unblocks the most others is the PERSISTENCE UNIT — createStorageData (:6948-6965) + loadFromStorageData (:6967-7008) + save (:6689-6723) — lifted into a `PaymentsRepository` that owns tokens + tombstones + tombstoneKeySet + archivedTokens + forkedTokens + nametags + _historyCache behind ONE commit API and ONE explicit reset(). Why it dominates: (1) it is the literal blob that pins four clusters into the class — repo-archives, nametags and history are serialized by createStorageData:6960-6964 and deserialized by loadFromStorageData:7004-7007, so none of them can leave until it does (the map's own step 6 says exactly this, yet ranks it AFTER ste

- **Biggest trap:** storage-providers. It is 76 lines, owns zero fields, is marked "clean / zero state / extractable as a standalone TokenStorageRegistry", and reads like a 20-minute mechanical lift with 8 happy consumers. It is not. It silently carries the custody-precedence invariant — "the first non-disabled entry IS the custody provider" — implemented four times with three different rules (getActiveTokenStorageProvider:2643-2646, save()'s `activeId = providers.keys().next().value`:6706, firstEnabledTokenStorage:975-989 feeding the #515 F1 composition refusal at :1006, getLocalTokenStorageProvider:4650-4659). save()'s activeId is what decides whether a failed write THROWS STORAGE_ERROR (:6718) or merely emit
