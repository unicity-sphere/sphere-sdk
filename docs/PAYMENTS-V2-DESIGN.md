# Payments v2 — the wallet-api money vertical

> **Status: DRAFT — §4 (public API) awaits owner sign-off; everything else reflects decisions
> locked 2026-07-31.** This document is both the design and the build tracker: the progress table
> below is updated as phases land (docs-only commits). Design inputs were a seven-way deep read of
> the wallet-api server contract, `sdk-changes.md` (E.1–E.4, S1–S7), the current module's 36 money
> invariants, the actually-consumed API surface, the latency work (#683/#684/#698/#699/#700 and
> open #713/#716/#717), the coin-selection implementation, and the defect ledger (#692, #724, #694,
> #725 + every recent review P1). The essentials are carried in the appendices — this file is
> self-contained.

## Progress

| Phase | Scope | Status |
|---|---|---|
| P0 | Spec edits (wallet-api PR): S7 own-storage rescind, contract pins, topology fix | 🔄 wallet-api#119 open |
| P1 | Skeleton, interfaces, adversarial fakes, contract-test harness | ✅ contracts + FakeWalletApi (61 pins) + FakeGateway; `test:mutation` runner in δ |
| P2 | `WalletApiSession` — auth cell, wake socket, syncEpoch latch | ✅ F8/F12/F14 mutation-verified + **5/5 live staging e2e** |
| P3 | `InventoryView` + wallet-api port implementations + S7 contract suites | ✅ F6/F7 closed by schema/construction; providers mutation-verified |
| P4 | `CoinSelector` + `Reservations` + queue | ✅ work-budget search; fragmented-wallet cliff is a named RED case |
| P5 | `TransferMachine` — send path | ✅ 5/5 mutation probes; apply-gating amendment (§5.5) found here |
| P6 | `TransferMachine` — resume = same machine | ✅ #676/#631/#634/audit#4/#690 pinned; 29 tests total with P5 |
| P7 | `Receive` drain + seen-set + claim + RECEIVED history | ✅ 20 tests; store-before-ack crash window pinned |
| P8 | `Requests` (streams + settling journal); `Mint` (+ engine F13 fix) | ✅ requests 19 tests; journal-first mint; F13 fixed + fake de-lied (124/124 engine) |
| P9 | `History` read-through; events; facade assembly | ✅ facade 16 tests over real ports; `test:mutation` standing (16/16 KILLED). Connect adapter → P11. **2026-08:** §4 gained `pendingTransfers()`/`resumeNow()` + the §7 in-session heartbeat (owner UX add; 9 heartbeat tests, 19/19 probes) |
| P10 | Live-staging e2e parity + soak + request-count budgets | 🔄 **6/6 money matrix live-green on testnet2** (mint / whole-token / split w/ signed seed-close / self-send / A→B→A / crash-resume paid-once) + 5/5 session e2e + **cross-version interop live-green** (old-module ↔ v2 vertical both directions incl. splits + payment request, 4/4). Still owed: exact-combination + E.4-stage interruption cells, soak, request-count budgets |
| P11 | Flip PR: wire Sphere + Connect adapter, delete old vertical, frontend migration, re-pin | ⬜ owner-gated |

---

## 1. Why a rewrite

The current module is 8,231 lines across 12 files with ~100 instance fields, of which only three
are money state. Every review cycle finds a new P1, and they are not random: the defect ledger
groups two months of findings into **nine recurring classes** (§9), most stemming from two
structural facts: (a) "may I touch shared state?" is answered by sampling flags rather than by
ownership, and (b) `sendOnce` and `IntentResume` are two hand-written implementations of the same
E.2/E.3 protocol that drift apart. Local fixes add guards, guards add state, state breeds the next
bug. The fix is structural: **wallet-api is the record; the client holds only what the server
documents it will not guarantee; send and resume are one machine.**

**Goals:** money safety by construction; wallet-api-only money paths; minimal durable client
state; the modal send at ~2 s; code a reviewer can hold in their head.
**Non-goals:** no new features; no redesign of the E.1–E.4/S1–S7 contracts (we implement the spec,
not reinvent it); no data migration (testnet reset is allowed).

## 2. Trust boundary

Keys and chain interaction live exclusively in the SDK. wallet-api never signs, never contacts the
aggregator, and is cryptographically distrusted by both sides — it stores, indexes, relays, and
remembers. A send: plan from `listInventory` **metadata** → pull only the **selected** blobs
(presigned S3 GET) → the token engine signs and submits **directly to the gateway**, polls and
match-verifies the inclusion proof → upload outputs (presigned PUT) → mailbox deposit →
`applyDelta`. The server's own documented non-guarantees (unspentness, validity-for-recipient,
wake delivery, exactly-once, intent durability across DB restore) each map to exactly one piece of
client state (§6).

## 3. What is deleted

- **`modules/accounting/` (~268 KB) and `modules/swap/` (~169 KB)** — zero consumers on the sphere
  frontend `refactor` branch (verified 2026-07-31; the 26-repo consumer gate re-runs at the
  removal PR). Connect loses `sphere_getInvoices`, `sphere_getInvoiceStatus` (owner-confirmed
  unused), the 9 invoice/accounting intents, and the `invoice:read`/`invoice:write` scopes.
- **Own-storage custody** — S7's "own-storage + wallet-api-delivery is supported" covenant is
  **rescinded in the spec** (P0). Interfaces stay swappable and contract-tested; no own-storage
  implementation ships. This deletes `recordLocalSpend`, the `serverApply=false` legs, custody
  branching, and makes #724's permanent-loss arm inexpressible.
- **The client-authoritative token map** and everything downstream of it: whole-map `save()`, the
  TXF storage codec on money paths, load-vs-drain exclusion, the 16 coordination fields, the
  local tombstone store (its job passes to the mailbox seen-set + the `isSpent` gate, §5.7 — the
  relay delivery rail that tombstones defended against is out of scope).
- **The local history ledger** — history is a server read-through plus client POSTs (§5.9).
- **The Nostr leg of payment requests**, v1 TXF relic handling, the multi-provider storage
  fan-out, the local nametag store (the `getCurrentNametag` injection stays), and the 25
  declared-public members with zero consumers.
- **The `PROXY://` leftovers** in `core/transport-resolver.ts` and the Nostr transport (the
  untracked Codex P2 from #722) — the v2 recipient resolution rides these paths, so the branches
  are deleted in P11 at the latest.
- **`FileTokenStorageProvider` / `IndexedDBTokenStorageProvider`** (money storage only —
  `StorageProvider` for keys/identity/journals stays platform-local; identity is not money).

## 4. Public API — ⚠ PENDING OWNER SIGN-OFF

Membership rule: a member exists only if the Sphere frontend or Connect needs it. Reads are views
over wallet-api. No client-store lifecycle (`sync`/`validate`) in the API.

```ts
interface Payments {
  // reads — views over the wallet-api record
  assets(coinId?: string): Promise<Asset[]>;       // inventory-mirror aggregation + registry metadata + fiat
  tokens(filter?: { coinId?: string }): Token[];   // sync read of the inventory view
  history(page?: { before?: string; limit?: number }): Promise<HistoryPage>;

  // money movement
  send(req: { recipient: string; amount: string; coinId: string; memo?: string }): Promise<TransferResult>;
  mint(coinId: string, amount: bigint): Promise<MintResult>;
  receive(): Promise<{ transfers: IncomingTransfer[] }>;

  // convergence (§7 heartbeat surface; owner UX add 2026-08)
  pendingTransfers(): Promise<PendingTransfer[]>; // on-read view over the intent backstop + delivery journal (+ #690 shortfalls, surfaced distinctly) — never a cached mirror
  resumeNow(): Promise<void>;                     // immediate resume pass; coalesces with a running one and reschedules the heartbeat from its outcome   // explicit drain-now

  // payment requests (wallet-api S4 streams only)
  requests: {
    create(to: string, terms: { coinId: string; amount: string; memo?: string }): Promise<PaymentRequest>;
    list(): PaymentRequest[];
    pay(id: string): Promise<TransferResult>;
    decline(id: string): Promise<void>;
    dismissProcessed(): void;
  };
}
```

**Retry rule:** a UI retry button calls `resumeNow()`, **NEVER** `send()` — a re-issued send is a
fresh `transferId` over different sources and double-pays the recipient (#631/#676); `resumeNow()`
replays the SAME intent. The heartbeat emits no tick events: the UI polls `pendingTransfers()` or
refreshes on `transfer:updated` / `connection:status`.

**Events (8):** `transfer:incoming` (kept verbatim — most-consumed, dApp-visible),
`transfer:updated` (replaces `:confirmed`/`:delivery_pending`/`:failed`/`send:partial-remainder`),
`transfer:attention` `{transferId, code, detail?}` (replaces `split:checkpoint-stuck`,
`delivery:undeliverable`, `delivery:deferred`), `inventory:updated`, `history:updated`,
`payment_request:incoming`, `payment_request:updated`, `connection:status`
(`connected|degraded|offline`; replaces `realtime:status` + `storage:degraded` — the server IS
storage).

**Kept verbatim (consumed contracts, not legacy):** the typed error family and exact codes —
`CERTIFICATION_UNCONFIRMED`, `SEND_SYNC_PENDING`, `CHECKPOINT_PERSIST_FAILED`,
`SPLIT_CHECKPOINT_LOST`, `CHECKPOINT_TRUSTBASE_MISMATCH`, `SEND_PARTIALLY_COMPLETED`,
`SEND_INSUFFICIENT_BALANCE`, plus `isPossiblyCommittedSendOutcome()`; **the
`ProofUnconfirmedError.cause` chain** (the frontend duck-types `cause` as
`JsonRpcNetworkError{name,status}` for 429/401 disambiguation — the submit-probe primitive must
never re-wrap it; test-pinned); **`TransferResult`'s consumed fields** — `id`, `status`, `tokens`,
`tokenTransfers`, and `deliveryPending` (Connect's send-intent forwards it with `?? false`, so
dropping the field silently reports "delivered" on every send; the §5.5 resolution point sets
`deliveryPending: true` whenever the deposit is not yet confirmed); and the requests durability
ordering (#441): the settling-journal write is durable **before** any possibly-committed throw
surfaces.

**Compatibility:** the Connect *wire* contract is adapted inside `ConnectHost`, not in payments —
`sphere_getBalance`/`sphere_getFiatBalance` served from `assets()`; `sphere_getHistory` serves the
flat entry array from `history()` (client-facing entries keep the consumed shape: **`timestamp`**
— mapped from the server wire's `ts` — plus `symbol` and `tokenIds[].{id,amount}`, enriched from
the record's assets + registry). **Every old event name a dApp can `sphere_subscribe` to is
re-emitted by the adapter** — `transfer:confirmed`/`transfer:delivery_pending` from
`transfer:updated`; `payment_request:paid`/`:rejected`/`:expired` from `payment_request:updated`;
`split:checkpoint-stuck`/`delivery:undeliverable`/`delivery:deferred` from `transfer:attention`
(by code); `realtime:status`/`storage:degraded` from `connection:status`;
`sync:completed`/`sync:remote-update` from `inventory:updated` — nothing a dApp subscribes to
silently stops firing. Lifecycle (`initialize`/`load`/`destroy`/`resumeOpenIntents`) collapses to
internal `start(deps)`/`stop()` owned by `Sphere`, with intent resume inside `start` — plus one
explicit seam the frontend's subscription flow requires: **`setEngine(next)`** (the api-key hot
swap must not tear down the socket/session; operations snapshot the engine at entry, so a swap
changes what *future* operations use while in-flight sends finish on the old one).

## 5. Architecture

Layout during build (renamed to `modules/payments/` + `impl/wallet-api/` in the flip PR):

```
modules/payments-v2/
  PaymentsFacade.ts      # the §4 surface; wiring only
  session/               # 5.1
  inventory/             # 5.2
  select/                # 5.3, 5.4
  transfer/              # 5.5 machine + 5.6 delivery
  receive/               # 5.7
  requests/              # 5.8
  history/               # 5.9
impl/wallet-api-v2/      # client + providers implementing the two ports
```

Every component follows three rules: **it is the single writer of the state it owns; every
operation snapshots its collaborators (session, provider, engine) at entry and never re-resolves
a "current" global mid-flight; no member exists without a caller.**

### 5.1 `WalletApiSession`

Owns auth + realtime. **The JWT lives in a generation-owning cell**: every mutation is a
compare-and-swap on the generation *inside the setter* — a continuation returning from an await
cannot clobber a newer session (kills #692 F8/F14 by construction, not by call-site discipline).
Refresh is single-flight (concurrent refresh of one session **revokes it** server-side — rotation
is CAS on the stored hash). Challenge template is verified before signing
(`unicity:wallet-api:auth:v1\n` + own pubkey + **own network** + nonce echo + plausible
timestamps — a wrong-network challenge would bind the JWT to a foreign namespace) — the spend key
never signs arbitrary server text. Wake socket: ticket flow, reconnect with backoff, close-code
4401 → refresh + re-ticket; on every (re)connect fire one synthetic nudge per stream
(`inventory`, `mailbox`, `payment_requests`) — and because wakes are lossy even on a healthy
socket, **all three streams keep a periodic cursor pull** (30 s class) as the correctness
backstop, not just the mailbox. Epoch layout, stated once: per-stream `(cursor, syncEpoch)`
persisted as one atomic record each, plus **one global epoch latch** (atomic CAS — kills F12)
that gates the restore protocol: on an epoch change, discard cursors, full-pull, **re-PUT locally
held open intents and re-POST progress envelopes (byte-identical) before any stream resumes**.
Emits `connection:status`.

### 5.2 `InventoryView`

Owns the in-memory mirror of the server inventory — a *view*, never a store of record. Pull
protocol: paginated full pull finished with an immediate `?since=<page-1 cursor>` delta (pulls
span snapshots); `?since=` deltas include tombstones and the view applies them; `more`-loops
always run to completion. The cursor is live: `delta()` pulls incrementally from the persisted §6
`(cursor, syncEpoch)` inventory record — one atomic record, advanced after every completed pull; a
stale epoch voids continuity and falls back to a reconciling full re-pull. Mutations to the mirror
are per-key; **there is no clear-and-repopulate, so the #724 shape cannot be written.** The
`suspectedSpent` overlay is durable and its
prune/apply runs inside the same critical section as the view mutation it reads (kills F7).
`recoverRemoved()`: knownSpends are **state-scoped `(tokenId, stateHash)` by schema** — a bare
tokenId record is unrepresentable (kills F6); an evidenced-tombstone 409 on re-add means "actually
spent", keep the tombstone. Empty-import protection: never push a removal before the first
successful inventory read; a token is removed only against a confirmed on-chain spend. Serves
`assets()` (aggregated from the mirror, with registry + price — the server `/v1/balances`
endpoint has no client consumer and the StoragePort exposes no balances member), `tokens()`
(elements enriched from the registry; status set is `'confirmed' | 'transferring'`), and the
selector's metadata pool. **In-flight exclusion
(#517/#32, re-homed):** sources reserved by an open transfer — including keep-open intents whose
spend may be on-chain — are excluded from the selector pool AND reported outside the spendable
total (`transferring*` fields, never `totalAmount`) until their machine settles or resume adopts
them. Emits `inventory:updated`.

### 5.3 `CoinSelector` (pure)

A pure function `(pool metadata, target) → SelectionPlan` — no I/O, no engine, no blobs.
Keeps the proven three-strategy shape: exact single token → exact combination → greedy
smallest-first with at most one split (`splitAmount` to recipient, remainder to self). Fixes over
today: the exact-combination search is bounded by a **work budget** (combinations examined), not
disabled above 20 candidates — fragmented wallets are precisely who needs it; candidate window =
nearest-by-amount. Queue-coverage math uses the in-flight sends' **declared expected change**
(each TransferMachine knows its own remainder), not the full amount of `'transferring'` sources —
fail-fast returns instead of 30 s queue deaths.

### 5.4 `Reservations` + queue

Ported nearly as-is — the synchronous ledger and FIFO-per-coin queue are the healthiest components
in the old module. The double-spend gate is unchanged: plan + reserve run in one synchronous
critical section (no `await` between free-view read and `reserve`); whole-token reservations; a
send queues when total coverage (free + expected change) suffices but the free view doesn't;
skip-ahead; 30 s timeout; 100-entry cap. Dropped: the four zero-caller members
(`getReservation`, `hasActiveReservation`, `getSize`, external `getTotalReserved`).

### 5.5 `TransferMachine` — one machine for send AND resume

The core of the rewrite. A transfer is an explicit state machine whose **persisted state is the
server intent record + the E.4 checkpoint + the delivery journal** — nothing else. `send()`
creates a machine from a fresh plan; `resume` rehydrates one from an open intent and **continues
from the first incomplete op**. There is no second resume implementation to drift.

```
PLANNED ──putIntent──▶ INTENT_OPEN ──certify ops──▶ CERTIFYING ─┬─▶ per-op: JOURNALED
                                                                 └─(all settled)─▶ DELIVERING
DELIVERING ──batch deposit──▶ APPLYING ──applyDelta──▶ CLOSING ──complete──▶ DONE
```

Normative behaviors bound into the transitions (not call sites):

- **E.1 determinism:** every random value is HKDF-derived from `(privKey, transferId, index,
  field)`; `opIndex` is **plan-derived** — the op's position in the intent's `direct[]` array,
  split = `direct.length`; output-scoped fields (`salt`, `tokenType`) use the output ordinal.
  Resume iterates `direct[]` in stored order — a different order manufactures a false conflict.
- **E.3:** the intent PUT is awaited **before any engine submit** and doubles as the pre-spend
  liveness gate (stated and test-covered — it replaces the old `save({critical})` probe). Local
  backstop copy kept for syncEpoch re-seed. The #670 rule is **scoped to the pre-submit PUT
  only**: a deterministic 422 there means nothing is on-chain and no server row exists — drop the
  backstop, never abort. A rejection of a *re-seed* re-PUT (after a server restore) is the
  opposite case — the backstop may be the only copy of a possibly-certified intent: **keep it**
  and raise `transfer:attention`. `requiresSeedClose: true` set at PUT time for splits, before
  the burn; every finish ends with idempotent `complete` (signed for seed-gated intents).
- **E.2 four-outcome match-verify**, the machine's error transition table: proof `OK` → apply
  (resume completes the transfer); `TRANSACTION_HASH_MISMATCH` on a transfer/burn leg →
  `TransferConflictError` (never apply, never retry; abort only if **nothing** certified, else
  keep open and converge); mismatch on a **mint leg** → `SplitCheckpointLostError` (keep open,
  loud); no proof after failed submit → surface the submit error (only a **known**
  validation-reject is a clean reject — an unknown status is possibly-certified → keep open);
  inconclusive proof fetch → `ProofUnconfirmedError` keep-open, same-`transferId` resume is the
  only exit.
- **E.4 (the most loss-prone flow — every step is a machine transition, test-pinned):** no mint
  submit before its checkpoint is durably server-acked **and read back** — a `put()` rejection
  raises `CheckpointPersistFailedError` with **zero** mint submits (keep-open; burn certified,
  funds in-flight, not lost). Encrypt **once**; persist the ciphertext locally **before the first
  POST**; every retry/re-seed re-POSTs byte-identical bytes (re-encryption forbidden — the AEAD
  nonce would break content idempotency). Adopt the slot winner's bytes (insert-once,
  first-write-wins; the loser builds every mint leg from the stored envelope). The progress
  append is signature-gated — `wallet-api.progress.v1:{transferId}:{opIndex}:{sha256(envelope)}`
  signed with the chain key; canonical formats pinned by shared cross-repo test vectors.
  Checkpoint-present resume: stored burn-tx bytes must be **byte-equal** to the freshly
  re-derived tx (inequality → `SplitCheckpointLostError` naming the recorded `sdkVersion` —
  never mint); rebuild `burntToken` **only from the decode of the stored bytes** — never a
  pre-store in-memory object, never a refetched proof; require round-trip re-encode equality
  against the stored hash; authentic-but-trustbase-failing → `CheckpointTrustbaseMismatchError`,
  never a silent re-burn. Checkpoint-absent: all-leg preflight probe — any certified mint leaf →
  `SplitCheckpointLostError` **before any re-burn**. On `SplitCheckpointLostError`: keep open,
  alert loudly, never complete, never abort, never record the source as foreign-spent.
- **Partial outcomes:** committed accounting derives from **settled** outcomes only; error
  precedence keep-open > conflict > other; after ≥1 delivered leg only the remainder re-plans,
  under a **new** transferId (`PartialSendConflictError`, deliberately not a
  `TransferConflictError` subclass); a conflicted resume leg delivered nothing — never recorded
  spent. Certified-during-failure sources are terminal `'spent'`, never restored.
- **Fan-out:** certify at width 8, fail-fast **between** batches (in-flight siblings always
  settle); the burn certifies + checkpoints before any mint; mint legs parallel (width 8).
- `applyDelta` targets the provider snapshot the sources were read from (#715) and runs after the
  deposit **attempt** of the same `transferId` — delivered, deferred (429), or failed-and-journaled
  alike; a deferred deposit must not leave spent sources listed active on every device (the S3
  rule). Post-commit mirror failure is `SEND_SYNC_PENDING`, never `transfer:failed` (#665).
  **Amendment (found during P5 build, test-pinned):** apply is *skipped* — deferred to resume —
  exactly when a keep-open or unjournaled-committed leg exists in the same intent: the server
  completes an unflagged intent on ANY apply, which would close the only exit (same-`transferId`
  resume) for the indeterminate leg. Balances converge at resume; the alternative strands funds.
  Likewise the #690 shortfall record is durable **before** `complete` (the reverse order has a
  lost-shortfall window while the intent is already unlistable).
- **Resolution point (latency):** the awaited path of `send()` ends after **APPLYING** — spend
  committed, delivery journaled/attempted, `applyDelta` applied (its failure is the thrown
  `SEND_SYNC_PENDING`, which therefore can surface). `TransferResult.deliveryPending` is `true`
  whenever the deposit is not yet confirmed. The fire-and-forget tail (#717) is `complete` + the
  history POST only. `complete` is an **idempotent backstop, not the close**: on every shipped
  path the evidenced apply already completed the intent server-side (whole-token applies complete
  unflagged intents unconditionally; a split's change blob in `added` is seed evidence) — the
  explicit call converges the rare unevidenced edge via resume, so fire-and-forget is safe.

### 5.6 `Delivery`

The journal is the one client-side artifact that exists because of a real gap the server cannot
see: between on-chain certification and the mailbox deposit, the client is the only holder of the
recipient's token. Journal **before** any deposit attempt, keyed content-idempotently with the
`(transferId, opIndex)` pairing carried for resume; remove only after successful deposit; replay
on session start; replay and journal RMW are single-flight/serialized. Deposit is one batch
(upload-urls → S3 PUTs at width 8 → `mailbox/batch`); batch 409 → per-entry fallback; the §6
key-variant 409 (resume rebuilt different proof bytes) absorbs as idempotent success. Recipient
429 = **deferred** (never counts toward the poison budget); genuine 5xx/network follows the
bounded replay → poison path (`transfer:attention`/`delivery:undeliverable`). `deliveryId` is
content-derived `hex(SHA-256(tokenId ‖ stateHash))` via the engine's `deliveryKeys`, late-bound;
never a server row id or seq. Two more Delivery-owned rules: **cross-network misdirection is the
sender's to prevent** — a deposit keys the recipient under the *sender's* network, the server
does not remap, and it returns 200 for an entry the recipient will never query; so the
recipient's network is pinned at resolve time and a recipient not verifiably on the session
network is refused **before certification** (deposit 200 ≠ reachability — otherwise the journal
entry is removed while the recipient never sees the entry). And **memo encryption is owned
here**: the delivery memo is the recipient-ECDH `sphere-deliveryenc-v1` bundle
(`core/delivery-envelope.ts`, shared with Requests); the server rejects non-`enc1.` envelopes.

### 5.7 `Receive`

A single-flighted drain loop; there is no competing "load" — the view updates per-key. Per entry:
`fetchBlob` → `engine.verify` (full trust base) + `engine.isOwnedBy` → dedup by
**`(tokenId, stateHash)`** against the persistent seen-set, with the on-chain `isSpent` gate when
replacing an already-held state (a replayed older state must never displace the live one) → claim
via the **`custody:'inventory'`-constructed provider** (custody stays a composition-time
property, never a call-site option — the port contract's rule) → RECEIVED history POST →
`transfer:incoming`. The seen-set **stays owned by the delivery implementation, per the S7 port
contract** (the contract suite asserts it); it records an entry **only after its ack succeeded**
— a crash mid-drain leaves entries unacked and re-listed. Verification failure →
`mailbox/reject` (terminal for discovery, not for the asset — never wedges the read pointer). A
claim that lands in the server's `failed[]` bucket (`CONFLICT`) is `mailbox/reject`ed
(`reason:'other'`) immediately and the drain continues: a lineage CONFLICT is not transient by
construction — another owner holds equal-or-newer state, the delivery is stale — and reject is
non-destructive server-side (terminal for discovery only; blob retained; never downgrades a
claim), so no retry counter exists (zero client state); `transfer:attention`
`{code:'claim:conflict'}` makes it operator-visible. The emitted `transfer:incoming` payload
keeps its consumed shape: sender
nametag resolved via transport, token display fields (`symbol`, `decimals`, `iconUrl`) enriched
from the registry, memo decrypted from the ECDH bundle. Wake-driven with the 30 s poll as the
correctness backstop. **Restore self-detection (S7 port shape):** the mailbox page response
carries `syncEpoch`, and the DeliveryPort surfaces it — `incomingEpoch(): string | null`, the
epoch of the most recent `incoming()` page, updated per page — so Receive persists its
`(cursor, epoch)` record from the page-honest epoch and, when a listed page reports an epoch
different from the record's, voids the record and re-lists from the start (post-restore seqs
restart, so a resumed listing may have skipped entries) even when the wake socket missed the
server restore. Pinned by the S7 delivery-port contract suite; wallet-api#119's S7 text carries
the same sentence.

### 5.8 `Requests`

wallet-api streams only. Incoming = gap-free `?since=` upsert-by-id stream (reconcile by id, a
status change re-surfaces at higher seq); outgoing = backfill view, no tailing. `pay()` is
per-request single-flight; the #441 settling journal is kept verbatim: durable request→transferId
link **before** any possibly-committed throw; reconcile by the linked transfer's outcome; direction
of error is always paid-never-re-payable. **The settlement invariant (one code path):** a settling
link is removed ONLY by a CONFIRMED paid respond (2xx, or the 409 already-resolved absorb) or by a
proven clean pre-commit failure — never by a network error, a 5xx, or a reload; a clean-success
send whose respond fails keeps the link (status `settling`) and the next reconcile's
committed-link override retries the respond. The 409 swallow-and-clear applies **only to the
paid-respond leg** (the payment already succeeded — 409 means already resolved); `decline()`
**propagates** 403/409 to the caller, as the frontend contract requires (a refused decline must
never look like success). Requests memo encryption is the recipient-ECDH bundle shared with
Delivery (`core/delivery-envelope.ts`). Expiry is server-owned.

### 5.9 `History` + `Mint`

History: server read-through (`GET /v1/history` keyset pages) + client POSTs with the dedup keys —
SENT by `transferId` (resume re-POST is a server no-op), RECEIVED by `(type, tokenId, stateHash)`,
**MINT by `('MINT', tokenId)`** (a resumed mint must not double-POST); a failed POST never fails
the money path; server wire shape pinned (`ts` ISO+offset; genesis-stable lowercase `tokenId`),
client-facing entries keep the consumed `timestamp` name via the read-through mapping. History
`memo`/`counterparty_nametag` are **self-scoped encrypted** (`sphere-fieldenc-v1`), owned here.
Mint: engine self-mint routed through the **same idempotent submit-then-probe primitive as
transfer/split** — the #692 F13 fix lands in `token-engine` (P8); the fake aggregator models
duplicate-submit adversarially so the contract test stops lying. **Mint durability:** the
submit-probe primitive fixes idempotency within a process, not crash durability — so mint gets a
**durable pre-submit journal record** (seed: coinId, amount, mintId; tokenId recorded once the
mint returns), replayed at `start()` exactly like the delivery journal, closing the
certification→`applyDelta` window; removed only after the mint is applied to inventory. Without
it, a crash there mints a token on-chain with zero client record — the mint-path twin of #621.
Replay converges by an idempotent `mint` re-call under the same journaled `(transferId, opIndex)`
seed (F13 recovers the existing certification); pre-derivation of the tokenId is dropped.

## 6. Durable client state — the complete inventory

Everything below is a small keyed store with a single writer; **nothing else the client persists
can lose money.** Each row exists because of a documented server non-guarantee.

| Store | Justifying non-guarantee | Writer |
|---|---|---|
| Intent backstop (open intents, encrypted payloads) | intents not rebuildable after server DB restore — re-PUT on `syncEpoch` change | TransferMachine |
| E.4 checkpoint ciphertext (encrypt-once bytes) | same, re-POST byte-identical | TransferMachine |
| Delivery journal (`(transferId, opIndex)` → blob) | certification→deposit window is client-only | Delivery |
| Mint journal (pre-submit seed: coinId, amount, mintId) | mint certification→`applyDelta` window is client-only (mint has no intent row) | Mint |
| Partial-shortfall record (`remainingAmount` + delivered set) | the delivered legs' intent completes — resume cannot recover a shortfall the app never saw (#690/#692); written before the partial surfaces, cleared on re-plan/ack | TransferMachine |
| Seen-set `(tokenId, stateHash)` | mailbox is at-least-once; claimed entries stay listable | delivery impl (S7 port contract) |
| `suspectedSpent` overlay | server never checks unspentness | InventoryView |
| Settling journal (request → transferId) | #441 — a possibly-committed pay must survive reload | Requests |
| Stream cursors + syncEpoch (atomic `(cursor, epoch)` record per stream + one global epoch latch) | wakes are lossy; epoch guards restores | Session/owners |

All keyed per-network **and** per-address (the old `isNetworkScopedAddressKey` discipline
carries over: a testnet journal must never act on another network).

## 7. Concurrency model

- **Ownership, not flags.** Each store above has exactly one writer component; cross-component
  access is a method call into the owner, never a shared map. No sampled `*InFlight` booleans.
- **The serialization points that stay serialized** (each carries a test): plan+reserve
  synchronous; journal-before-deliver; all certifications settle before delivery and before
  failure accounting; burn before mints; one sequential apply phase; drain single-flight and
  sequential per entry; **resume single-flight** (owned by `start()` and the epoch re-seed —
  never two concurrent resume passes; closes #692 F9's first head, and its second head dies with
  the pool rule: open-intent sources never enter the selector pool, so no resume-time
  reservation-cancel can free a live send's source); keep-open errors survive unwrapped; change
  recorded after the server apply; resume iterates `direct[]` in stored order.
- **Collaborator snapshots** (defect class 5): an operation captures session/provider/engine at
  entry and threads them as parameters (`setEngine` changes what future operations snapshot).
  Disposable resources (worker pools) are owned by per-address records; teardown iterates
  records.
- **`start()` posture (latency constraint):** intent resume and journal replays launch off the
  critical path — `start()` never awaits them (the old `load()` contract; awaiting can deadlock
  and regresses startup) — and resume batches its cross-intent reads rather than going
  per-intent-serial. Pinned by a startup request-count test.
- **In-session convergence heartbeat:** between `start()` and `stop()`, while open intents exist
  or the delivery/mint journals are non-empty, the facade re-runs the SAME single-flighted resume
  pass on an exponential backoff — seed 5 s, ×2, cap 120 s; reset on progress (any leg converging)
  and on `connection:status` recovery; a surfaced wallet-api `Retry-After` floors the next pass;
  the pass never adopts an intent whose machine is still running in-process (facade ownership).
  State is an in-memory timer handle + backoff value only — the pending set is re-read from the
  §6 stores at every tick, and `stop()` clears the timer (quiescence unchanged).
- **Address switch** = stop the vertical, start a new one. **`stop()` awaits quiescence** —
  in-flight machines and the drain complete or park before `start()` for the same address may
  run, because both instances would otherwise write the same per-address durable stores (this is
  the #724 residual, closed structurally). No cross-address state survives except the
  per-address durable stores.

## 8. Latency — fast by construction

Rules (each enforced by a request-count regression test, not a duration): the intent PUT is the
single pre-spend liveness gate; `applyDelta` is the only authoritative write in a send — there is
no `save()` to storm (#713 has no substrate); selected source blobs fetch bounded-parallel (#716);
certify width 8 + one batched deposit (kept from #698/#700); `send()` resolves before the
fire-and-forget tail (#717). Budget for the modal single-source send: ~1 certification round
(~1.0–1.5 s at the 300 ms proof poll) + ~150–300 ms delivery + 1 `applyDelta` round trip
(APPLYING is inside the awaited path — §5.5) ≈ **≤ 2 s**. Receive: wake → drain immediately (no
500 ms debounce into a full reload — the per-key view kills that path), one blob GET + sequential
verify per entry, batched acks.

## 9. Defect classes → structural properties

| # | Class (evidence) | Property making it inexpressible |
|---|---|---|
| 1 | Sampled-flag guards (#724, F9, F12) | single-writer ownership; single-flight by construction; no client map to guard |
| 2 | Whole-blob RMW last-writer-wins (F7, F10, F11) | per-key deltas; correlated keys persist as one record; RMW inside owner's critical section |
| 3 | Stale-generation writes (F8, F14) | generation CAS inside the setter (session cell) |
| 4 | TOCTOU on second stale read (F6, #719 P1) | decision+apply in one critical section; state-scoped spend records unrepresentable otherwise |
| 5 | Re-resolved collaborator mid-op (#715, #720) | snapshot-at-entry parameter threading; per-address resource records |
| 6 | Best-effort on hot path (#713/#716/#717) | resolution point defined in the machine; tails fire-and-forget |
| 7 | Hollow tests (#714, F13, #694) | `test:mutation` standing command; gated fakes witness overlap; adversarial fakes |
| 8 | Silently-defaulted join keys (#694) | dies with accounting; the schema rule (total keys or loud failure) applies to new stores |
| 9 | "Certified?" inferred from errors (#631, F13) | one idempotent submit→probe primitive for every certification incl. mints |

## 10. Testing

- **Ported invariant tests** (verified-RED pedigree): the gated-engine contention trio; the
  wallet-api-delivery suite's load-bearing tests (#621 re-deliver-never-re-certify; #631
  keep-open pair; audit#4 false-paid guards; #676 double-pay guards; #634 checkpoint resume +
  v:1 refusal; #677 remainder family; the delivery-journal lifecycle; putIntent-before-engine;
  #715 provider pinning; the #724 test ported as its **outcome** — "a claimed/acked incoming
  token is never subsequently absent from the view + server inventory", asserted under a
  concurrent drain and delta-pull, since v2 has no load/mutex for a "never overlap" phrasing to
  attach to); terminal-`'spent'` disposition; engine lifecycle per address; the DIRECT:// golden
  test.
- **Mutation probes as `npm run test:mutation` from day one (#725):** reservation-gate,
  delivery-journal-ignored, conflicted-leg-as-spent, restore-certified-to-confirmed,
  skip-putIntent, removeToken-arg-swap, plus one per new machine transition.
- **Contract tests** for the storage and delivery interfaces keep "swappable" enforceable with
  wallet-api as sole shipped implementation; the delivery contract pins `incomingEpoch()` — the
  per-page syncEpoch surface Receive's restore self-detection keys on (§5.7).
- **Adversarial fakes:** the fake gateway returns `SUCCESS` for duplicates AND conflicts (the
  observed M7 reality — status carries no signal); unknown statuses on re-submit; the fake
  wallet-api enforces wire shapes, evidenced-tombstone 409s, first-write-wins checkpoint slots,
  mailbox at-least-once re-listing.
- **Transfer-shape matrix (standing rule):** the invariant suite AND the staging e2e cover every
  shape combination, because each exercises distinct machine transitions and server semantics:
  - **Shapes:** exact single token (1 direct); exact combination (k direct, 2–5); greedy
    m direct + 1 split; split-only (0 direct + 1 split); greedy exact-sum (all-direct, no split);
    whole-balance send.
  - **Recipients:** third party (@nametag, DIRECT://, raw pubkey); **self-send** (spend and claim
    commute server-side; same tokenId in `spent`+`added` is a 422 — the self-output rides the
    mailbox); **roundtrip A→B→A** (re-acquired genesis at a new state — the `(tokenId, stateHash)`
    dedup must accept it, RECEIVED history per state, server handoff tombstones + reactivation).
  - **Cross-products that have bitten before:** split where change and recipient outputs land in
    the same wallet (self-split); m direct + split in one transfer resumed mid-way (non-prefix
    certified subset); concurrent sends of the same coin (one queues for change); send while the
    same wallet is receiving.
  - **Interruptions per shape (P6):** kill after certify before deposit (journal replay); kill
    after burn before checkpoint / after checkpoint before mints / between mints (E.4 states);
    resume from a second device (AC-E5); duplicate resume (idempotent close).
- **Staging e2e at every step (standing rule):** fakes prove invariants; **staging proves
  reality**. Every phase from P2 onward merges only with a live e2e against
  `https://wallet-api.staging.unicity.network` (+ the testnet2 gateway wherever money moves)
  exercising that phase's surface — P2 auth/socket/epoch, P3 inventory pulls + recovery, P5/P6
  real sends and kill-resume, P7 real receive, P8 requests + mint. The e2e suite grows with each
  phase; P10 is the *full* parity pass over the accumulated suite, not the first contact.
- **P10 gate:** live-staging e2e parity (send incl. split, receive, resume-after-kill,
  cross-device resume, requests round-trip), request-count budgets, and a soak.

## 11. Implementation plan

Each phase = one issue + 1–3 PRs to `main`, squash-merged green; spec changes land in the same PR
as the code they change (covenant). "Done when" is the merge gate **and, from P2 onward, always
includes the phase's live staging e2e (see §10 standing rule)**. Phases P2–P4 are independent of
each other; P5+ are sequential.

- **P0 — spec (wallet-api PR):** rescind S7 own-storage custody (inventory custody is the only
  supported custody; ports stay contract-tested); pin the two contracts the spec leaves
  ambiguous — the canonical intent payload field list and `PartialSendConflictError` semantics;
  update the stale process docs (`development-workflow.md` branch-topology table + sphere-sdk
  CLAUDE.md program note) to record `main` as both repos' PR target, matching actual practice
  since #698. *Done when: merged with owner review.*
- **P1 — harness:** `modules/payments-v2/` + `impl/wallet-api-v2/` skeletons; the two port
  interfaces; adversarial fakes; contract-test suites; `test:mutation` runner wired into CI.
  *Done when: CI runs the (empty-implementation) contract suites + probe harness.*
- **P2 — session:** auth cell (CAS generations), single-flight refresh, ticket socket,
  reconnect + synthetic nudges, atomic epoch latch + re-seed hook. *Done when: F8/F12/F14
  reproducer tests are green here and RED against the old client (proof the class is closed).*
- **P3 — inventory:** pull protocol (full-pull + delta finish, tombstones, more-loops), per-key
  mirror, overlay, `recoverRemoved` with state-scoped knownSpends, `assets()`/`tokens()`.
  *Done when: F6/F7 reproducers green; empty-import protection probe red-verified.*
- **P4 — selection:** pure selector + ported ledger/queue; property tests (never over-select,
  split minimality, work-budget bound); expected-change coverage math. *Done when: selector
  property suite + ported contention trio green.*
- **P5 — machine, forward path:** PLANNED→DONE happy path incl. journal + batch deposit + apply +
  fire-and-forget tail; request-count tests; first probe set. *Done when: single- and
  multi-source sends pass against fakes with pinned request counts; putIntent/journal probes red-verified.*
- **P6 — machine, recovery:** rehydration from open intents; E.2 four-outcome table; E.4
  checkpoint flow; partial/remainder handling incl. the **durable shortfall record** (#690 —
  crash between the partial's `complete` and the app seeing it must not lose the remainder);
  the full keep-open family. *Done when: every ported resume/conflict/keep-open test green;
  shortfall-survives-reload test green; kill-and-resume e2e (mock gateway) passes AC-E2.*
- **P7 — receive:** drain, seen-set, isSpent gate, claim, RECEIVED history, reject path.
  *Done when: ported receive invariants + at-least-once replay tests green.*
- **P8 — requests + mint:** streams, settling journal (ordering probes), pay single-flight
  (decline 403/409 propagates — only the paid-respond leg swallows 409); engine F13 fix
  (idempotent mint) + de-lying contract test; the mint journal + `('MINT', tokenId)` history
  key. *Done when: #441 ordering probe red-verified; mint kill-and-replay test recovers the
  token; mint resume test passes against the adversarial fake.*
- **P9 — assembly:** facade, events, Connect adapter (old wire names from new events),
  `Sphere.start` wiring behind a flag. *Done when: Connect conformance tests pass unchanged.*
- **P10 — parity:** live staging e2e set, soak, latency/request budgets recorded. *Done when:
  parity checklist signed off; budgets in CI.*
- **P11 — flip:** point `sphere.payments` at v2; `git mv` to final names; delete old module,
  accounting, swap, Connect invoice surface, own-storage providers, dead events; sphere frontend
  migration PR (call sites + event names); re-pin; the 26-repo consumer gate run recorded in the
  PR. *Done when: sphere staging runs on v2 with old code gone.*

## Appendix A — invariant register (must hold in v2; each carries a test)

Send: intent-before-engine; journal-before-deliver; delivery failure never fails a certified
send; bounded replay + 429 deferral outside the poison budget; certified-spend terminal;
settled-only accounting with keep-open > conflict > other; keep-open family never aborted;
same-transferId resume, foreign proof never applied; re-deliver never re-certify; conflicted leg
never recorded spent; locally-aborted intents never resumed, unknown local disposition defers
all; unsupported payloads refused; reservation gate + synchronous critical section; per-request
pay single-flight; settling journal durable-before-throw; post-commit mirror failure ≠ failure;
pre-submit 422 intent rejection drops backstop (re-seed rejection keeps it), never aborts;
suspectedSpent demotion durable + re-plan bounded; remainder-only re-plan under new transferId +
durable shortfall record; provider pinning; fail-closed composition; recipient network pinned at
resolve (deposit 200 ≠ reachability); mint journaled pre-submit, replayed at start.
E.4 checkpoint: no mint submit before the checkpoint is server-acked and read back
(`CheckpointPersistFailedError` with zero mints otherwise); encrypt once — ciphertext persisted
locally before the first POST, retries byte-identical; adopt the slot winner's bytes; stored
burn-tx byte-equality or `SplitCheckpointLostError` (never mint); rebuild burntToken only from
stored-byte decode; round-trip re-encode equality vs the stored hash; trustbase-only failure is
its own keep-open error, never a silent re-burn; absent checkpoint + any certified leaf →
`SplitCheckpointLostError` before any re-burn; progress append signature-gated with shared
cross-repo vectors; on `SplitCheckpointLostError` never complete/abort/record-foreign-spent.
Receive: verify + isOwnedBy before balance; `(tokenId, stateHash)` dedup + isSpent gate;
claim-CONFLICT terminally rejected('other') — cursor advances, never re-processed; state-gated
removal (never destroy an advanced state); seen-set only after successful ack; drain
single-flight. Cross-cutting: owner/address guards on every
hydration surface; network+address-scoped keys; history dedup keys (SENT/transferId,
RECEIVED/(type,tokenId,stateHash), MINT/(MINT,tokenId)); amounts as decimal strings/BigInt
end-to-end; challenge-template verification incl. network; no concurrent refresh; resume
single-flight; `stop()` quiescence before same-address restart; memo/field encryption per S6
(self-scoped for history + intent payload, recipient-ECDH for delivery + request memos).

## Appendix B — server facts the design leans on (verified against wallet-api source)

`inventory/apply` is transferId-idempotent (replay returns recorded cursor, mutates nothing);
apply completes the intent in-transaction (evidence-gated for seed-close intents); intent PUT is
write-once-while-open, abort is soft and byte-equal-re-openable, completion wins over abort;
`completed` is not listable — absence-from-open means closed; progress slots are insert-once
first-write-wins returning the stored record; mailbox deposit is entry_id-idempotent with the
key-variant 409; claim is per-entry transactional (partial success normal) and may precede the
sender's apply (handoff commutes); reject never downgrades a claim and never blocks the asset;
wakes are post-commit best-effort lossy; reads are un-throttled but page-capped; `syncEpoch`
changes only on DB restore; blob wire format is raw `Token.toCBOR()` (the sphere `TokenBlob`
envelope 422s); presigned PUTs pin signed headers (`x-amz-checksum-sha256`, `If-None-Match: *`);
S3 412 on upload = blob exists = success.
