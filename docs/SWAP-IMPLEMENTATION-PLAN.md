# SwapModule Implementation Plan

> **Status:** Implementation plan — approved after Phase 1-3 review cycle
> **Branch:** `feat/swap-module-spec`
> **Source specs:** SWAP-ARCHITECTURE.md, SWAP-SPEC.md, SWAP-TEST-SPEC.md

---

## Pre-Implementation: Unicity Expert Findings to Address

These findings from the Unicity L3 review MUST be incorporated into the implementation:

1. **CRITICAL — coinId max length:** Align to 20 chars in SWAP-SPEC §17.1 manifest validation (matches AccountingModule limit). Do NOT use escrow's 68-char limit. **ADDRESSED** in spec update.
2. **WARNING — Local timeout base:** Use `announcedAt` (not `createdAt`) for local timeout calculation. Add `announcedAt?: number` to `SwapRef`. **ADDRESSED** in spec update.
3. **WARNING — Deposit invoice target verification:** Add escrow address check to §17.4 — verify `terms.targets[0].address === resolvedEscrowAddress`. **ADDRESSED** in spec update.
4. **WARNING — Payout verification:** Add `sphere.payments.validate()` call + escrow creator identity check (`terms.creator === escrowChainPubkey`). **ADDRESSED** in spec update.
5. **WARNING — Transfer mode:** Use default `'instant'` for deposits (escrow finalizes on receive). Document this explicitly. **ADDRESSED** in T2.3 description — default transfer mode is used (no explicit `transferMode` override needed).
6. **WARNING — Memo auto-generation:** Document that `payInvoice()` handles INV: memo automatically. **ADDRESSED** in T2.3 description — `payInvoice()` auto-generates the `INV:{invoiceId}` memo; no manual memo construction required.

---

## Dependency Graph

```
LEVEL 0 (all parallel — no dependencies)
  ├── T0.1: modules/swap/types.ts
  ├── T0.2: modules/swap/state-machine.ts
  ├── T0.3: modules/swap/manifest.ts + npm install canonicalize
  ├── T0.4: modules/swap/dm-protocol.ts
  ├── T0.5: core/errors.ts (add SWAP_* error codes)
  ├── T0.6: types/index.ts (add swap events to SphereEventMap)
  ├── T0.7: constants.ts (add swap storage keys)
  └── T0.8: core/async-gate.ts (shared per-key async mutex)

LEVEL 1 (depends on Level 0)
  ├── T1.1: modules/swap/SwapModule.ts (skeleton + lifecycle)
  └── T1.2: modules/swap/escrow-client.ts

LEVEL 2 (depends on Level 1 — all parallelizable)
  ├── T2.1: proposeSwap() implementation
  ├── T2.2: acceptSwap() + rejectSwap()
  ├── T2.3: deposit() + verifyPayout()
  ├── T2.4: getSwapStatus() + getSwaps() + cancelSwap()
  ├── T2.5: DM processing handlers (all message types)
  ├── T2.6: Invoice event subscriptions
  └── T2.7: Local timeout management

LEVEL 3 (depends on Level 2)
  ├── T3.1: modules/swap/index.ts (barrel exports)
  ├── T3.2: core/Sphere.ts (integrate SwapModule)
  ├── T3.3: cli/index.ts (5 swap commands)
  ├── T3.4: CLAUDE.md (add SwapModule documentation)
  ├── T3.5: index.ts (re-export public swap types)
  └── T3.6: Connect protocol (DEFERRED)

TEST LEVEL 0 (depends on T3.1)
  └── TT0: tests/unit/modules/swap-test-helpers.ts

TEST LEVEL 1 (depends on TT0 — all 16 files parallelizable)
  ├── TT1:  SwapModule.lifecycle.test.ts (11 tests)
  ├── TT2:  SwapModule.proposeSwap.test.ts (19 tests)
  ├── TT3:  SwapModule.acceptReject.test.ts (15 tests)
  ├── TT4:  SwapModule.deposit.test.ts (8 tests)
  ├── TT5:  SwapModule.status.test.ts (8 tests)
  ├── TT6:  SwapModule.verify.test.ts (9 tests)
  ├── TT7:  SwapModule.cancel.test.ts (7 tests)
  ├── TT8:  SwapModule.dmProcessing.test.ts (12 tests)
  ├── TT9:  SwapModule.invoiceEvents.test.ts (6 tests)
  ├── TT10: SwapModule.concurrency.test.ts (4 tests)
  ├── TT11: SwapModule.storage.test.ts (5 tests)
  ├── TT12: SwapModule.manifest.test.ts (7 tests)
  ├── TT13: SwapModule.stateMachine.test.ts (28 tests)
  ├── TT14: SwapModule.validation.test.ts (20 tests)
  ├── TT15: SwapModule.errors.test.ts (15 tests)
  └── TT16: SwapModule.cli.test.ts (33 tests)

TEST LEVEL 2 (depends on all unit tests green)
  └── TT17: tests/integration/swap-lifecycle.test.ts (6 tests)

TEST LEVEL 3 (future — depends on escrow deployment)
  └── TT18: tests/scripts/test-e2e-swap.ts (2 tests)
```

---

## LEVEL 0: Types and Constants (all parallel)

### T0.1: `modules/swap/types.ts` (~350 lines)

All type definitions from SWAP-SPEC §2:
- `SwapDeal` (flat fields: partyA, partyB, partyACurrency, partyAAmount, partyBCurrency, partyBAmount, timeout, escrowAddress?)
- `SwapManifest` (wire format matching escrow exactly)
- `ManifestFields` (fields without swap_id, used for hashing)
- `SwapProgress` type (9 states)
- `SwapRole` type ('proposer' | 'acceptor')
- `SwapRef` (persistent record — includes `announcedAt?: number` per Unicity finding #2)
- `SwapProposalResult`, `ProposeSwapOptions`, `GetSwapStatusOptions`, `GetSwapsFilter`
- `SwapModuleConfig` (debug, defaultEscrowAddress, proposalTimeoutMs, maxPendingSwaps, announceTimeoutMs, terminalPurgeTtlMs)
- `SwapModuleDependencies` interface (includes `payments` for L3 token validation during payout verification)
- `SwapStorageData` (versioned wrapper for persistence)
- All DM message type interfaces (P2P + escrow)
- All event payload interfaces (SwapEventMap)

**Dependencies:** None
**Complexity:** M

### T0.2: `modules/swap/state-machine.ts` (~100 lines)

- `VALID_PROGRESS_TRANSITIONS` constant
- `TERMINAL_PROGRESS` set (completed, cancelled, failed)
- `isTerminalProgress(p)`, `isValidTransition(from, to)`, `assertTransition(from, to)`
- `mapEscrowStateToProgress(escrowState)` mapping function

NOTE: The architecture defines 11 states (including PROPOSAL_RECEIVED and REJECTED).
The spec defines 9 states. This implementation follows the SPEC's 9-state machine:
- Acceptors use `progress: 'proposed'` with `role: 'acceptor'` (no PROPOSAL_RECEIVED state)
- Rejections transition to `cancelled` (no REJECTED state)
- The `swap:rejected` event is emitted alongside `swap:cancelled` for rejection clarity

**Dependencies:** None
**Complexity:** S

### T0.3: `modules/swap/manifest.ts` (~140 lines)

- `computeSwapId(fields: ManifestFields): string` — JCS + SHA-256
- `buildManifest(deal, resolvedA, resolvedB): SwapManifest`
- `validateManifest(manifest): { valid: boolean; errors: string[] }`
- `verifyManifestIntegrity(manifest): boolean`
- **coinId validation uses max 20 chars** (per Unicity finding #1)

**Dependencies:** Requires `npm install canonicalize`. Uses `@noble/hashes/sha256` (existing).
**Complexity:** M

### T0.4: `modules/swap/dm-protocol.ts` (~350 lines)

P2P message builders/parsers:
- `buildProposalDM(manifest, escrow, message?): string`
- `buildAcceptanceDM(swapId): string`
- `buildRejectionDM(swapId, reason?): string`

Escrow message builders:
- `buildAnnounceDM(manifest): string`
- `buildStatusQueryDM(swapId): string`
- `buildRequestInvoiceDM(swapId, invoiceType: 'deposit' | 'payout'): string`

Universal parser:
- `parseSwapDM(content: string): ParsedSwapDM | null`
- `isSwapDM(content: string): boolean`

DM prefix constants.

**Dependencies:** None
**Complexity:** M

### T0.5: `core/errors.ts` modification (~15 lines)

Add 17 SWAP_* error codes to `SphereErrorCode` union.

**Dependencies:** None
**Complexity:** S

### T0.6: `types/index.ts` modification (~60 lines)

Add 15 swap event types to `SphereEventType` union.
Add event payloads to `SphereEventMap` interface.

**Dependencies:** None
**Complexity:** S

### T0.7: `constants.ts` modification (~5 lines)

Add per-swap storage keys to `STORAGE_KEYS_ADDRESS`:
- `SWAP_RECORD_PREFIX: 'swap:'` — per-swap key prefix (each swap stored at `swap:{swapId}`)
- `SWAP_INDEX: 'swap_index'` — lightweight index array for listing swap IDs

**Dependencies:** None
**Complexity:** S

### T0.8: `core/async-gate.ts` (~40 lines)

Extract the per-key async mutex pattern from AccountingModule.withInvoiceGate into a shared utility:

```typescript
class AsyncGateMap {
  async withGate<T>(key: string, fn: () => Promise<T>, destroyed?: () => boolean): Promise<T>
  async drainAll(): Promise<void>
}
```

Both AccountingModule and SwapModule use `AsyncGateMap`. AccountingModule is refactored to use it (replacing inline `withInvoiceGate`). Existing AccountingModule tests validate the extraction.

**Dependencies:** None
**Complexity:** S
**Can be parallelized with:** T0.1-T0.7

---

## LEVEL 1: Core Module (depends on Level 0)

### T1.1: `modules/swap/SwapModule.ts` skeleton (~600 lines)

Class structure:
- Private fields: `swaps`, `_gateMap: AsyncGateMap`, `localTimers`, `invoiceToSwapIndex`, `destroyed`, `loaded`, `_loading`, `_loadingDeferred`, `deps`, `config`, `unsubscribes`
- `constructor(config)`, `initialize(deps)`, `load()`, `destroy()`
- Uses `AsyncGateMap` from `core/async-gate.ts` (T0.8) instead of copy-pasting the gate pattern
- `persist(swap)`: write `swap:{swapId}` key + update `swap_index` array. Per-swap keys eliminate the lost-update race between concurrent gate operations on different swaps.
- `loadFromStorage()`: read `swap_index`, then load each non-terminal swap from `swap:{swapId}`. Purges terminal swap records older than `config.terminalPurgeTtlMs` (default 7 days) from both per-swap keys and the swap index. After loading, performs per-state recovery actions:
  - `accepted`: re-send announce DM to escrow (idempotent)
  - `announced`/`depositing`: send `status` DM to escrow, send `request_invoice` if deposit invoice missing
  - `awaiting_counter`: send `status` DM to escrow
  - `concluding`: send `status` DM, send `request_invoice` for payout if missing
- `transitionProgress(swap, newProgress, updates?)` — validated transition + persist
- Guard helpers: `ensureInitialized()`, `ensureNotDestroyed()`
- Include `_loading` flag + `_loadingDeferred` deferred promise pattern from AccountingModule (lines 296-300). This prevents race conditions during `switchToAddress()` which calls destroy->initialize->load in sequence.
- Stub methods for all 8 public API methods

**Dependencies:** T0.1, T0.2, T0.3, T0.4, T0.5, T0.8
**Complexity:** L

### T1.2: `modules/swap/escrow-client.ts` (~250 lines)

Helper functions (not a class — stateless):
- `resolveEscrowAddress(deal, config, resolve)` — resolve escrow from deal or config default
- `sendAnnounce(communications, escrowPubkey, manifest)`
- `sendStatusQuery(communications, escrowPubkey, swapId)`
- `sendRequestInvoice(communications, escrowPubkey, swapId, invoiceType)` — request missing invoice token
- `verifyEscrowSender(dm, expectedPubkey)` — authenticate escrow DMs
- `withRetry<T>(fn: () => Promise<T>, maxRetries: number, label: string): Promise<T>` — exponential backoff with jitter (2s base, 16s max, 5 retries). All escrow DM sends (`sendAnnounce`, `sendStatusQuery`, `sendRequestInvoice`) are wrapped in `withRetry`.

**Dependencies:** T0.1, T0.4
**Complexity:** S

---

## LEVEL 2: Method Implementations (all parallel, depend on Level 1)

**NOTE:** All Level 2 tasks modify `SwapModule.ts`. Since methods are self-contained, agents develop them in isolation. Integration is sequential merge of non-overlapping method bodies.

### Merge Strategy for SwapModule.ts

Level 2 tasks all modify SwapModule.ts. To avoid merge conflicts:

1. T1.1 (skeleton) produces the COMPLETE file structure with:
   - All imports (frozen -- Level 2 agents do NOT add imports)
   - All private fields
   - All helper methods (withSwapGate, persist, transitionProgress, etc.)
   - Method stubs with `// T2.X: IMPLEMENTATION START` and `// T2.X: IMPLEMENTATION END` markers

2. Each Level 2 agent receives the skeleton and ONLY fills in its marked section.
   Agents must NOT modify anything outside their markers.

3. Integration is sequential paste of method bodies into the skeleton.
   Order: T2.4 (simplest) -> T2.7 -> T2.6 -> T2.2 -> T2.3 -> T2.1 -> T2.5 (most complex, last)

### T2.1: `proposeSwap()` (~200 lines)

Per SWAP-SPEC §4: validate deal, resolve addresses, determine role, check limit, build manifest, check idempotency, create SwapRef, persist, send DM, start proposal timer, emit event.

### T2.2: `acceptSwap()` + `rejectSwap()` (~150 lines)

Per SWAP-SPEC §5-6: validate state/role, send DM, transition, announce to escrow (for accept), emit events.

### T2.3: `deposit()` + `verifyPayout()` (~250 lines)

Per SWAP-SPEC §7, §10:
- deposit: determine assetIndex from role, call `accounting.payInvoice()`, transition, emit. Uses the default transfer mode (no explicit `transferMode` override) — escrow finalizes on receive (Unicity finding #5). `payInvoice()` auto-generates the `INV:{invoiceId}` memo; no manual memo construction required (Unicity finding #6).
- verifyPayout: check invoice status, verify terms match manifest, **verify escrow creator identity** (Unicity finding #4), **call validate()** for L3 proof check, transition to completed

### T2.4: `getSwapStatus()` + `getSwaps()` + `cancelSwap()` (~200 lines)

Per SWAP-SPEC §8-9, §11: status lookup with optional escrow query, filter/sort, cancel with local cleanup.

### T2.5: DM processing handlers (~300 lines)

Per SWAP-SPEC §12: handle all 11 DM message types (3 P2P + 8 escrow). **Verify deposit invoice target matches escrow address** (Unicity finding #3). All errors catch-and-log, never propagate.

DM ORDERING NOTE: The `invoice_delivery` handler must handle the case where
`announce_result` hasn't arrived yet. If a swap in `accepted` state receives
an `invoice_delivery` for a deposit invoice, the handler should:
1. Match by swap_id from the invoice memo
2. Set depositInvoiceId AND transition to `announced` in one step
3. Skip the announce_result handler for this swap (it becomes a no-op duplicate)

DM SENDER VERIFICATION: Escrow JSON DMs are only claimed when `dm.senderPubkey` matches a known escrow pubkey from the swap's deal.escrowAddress resolution. Generic JSON DMs from unknown senders are ignored by the swap handler.

### T2.6: Invoice event subscriptions (~150 lines)

Per SWAP-SPEC §13: subscribe to invoice:payment, invoice:covered, invoice:return_received. Maintain invoiceId → swapId reverse index. Emit swap events.

### T2.7: Local timeout management (~100 lines)

Per SWAP-SPEC §16: **Use `announcedAt` as timeout base** (Unicity finding #2). Start/clear/resume timers. 30s grace period over escrow timeout.

---

## LEVEL 3: Integration (depends on Level 2)

### T3.1: `modules/swap/index.ts` (~20 lines)

Barrel exports: types, SwapModule, createSwapModule, computeSwapId, buildManifest.

### T3.2: `core/Sphere.ts` modifications (~80 lines)

- Add `_swap: SwapModule | null` field
- Add `get swap()` public getter
- Add `swap?: SwapModuleConfig | boolean` to init/create/load options
- Wire initialize + load in `_setupAddress()` (AFTER accounting). `payments` must be injected into `SwapModuleDependencies` for L3 token validation during payout verification.
- Wire destroy (BEFORE accounting)
- Add `_resolveSwapConfig()` helper

### T3.3: `cli/index.ts` modifications (~300 lines)

5 new commands: swap-propose, swap-list, swap-accept, swap-status, swap-deposit.
Follow existing invoice-* command pattern exactly.

### T3.4: `CLAUDE.md` update (~50 lines)

Add SwapModule to the SDK documentation:
- API methods table (proposeSwap, acceptSwap, deposit, verifyPayout, getSwapStatus, getSwaps, cancelSwap, rejectSwap)
- Swap events in the events table
- SWAP_* error codes reference
- CLI swap commands
- Test file listing

**Dependencies:** T3.1
**Complexity:** S

### T3.5: `index.ts` (main barrel) update (~10 lines)

Re-export public swap types from the main SDK entry point:
- `SwapDeal`, `SwapProgress`, `SwapRef`, `SwapProposalResult`, `GetSwapsFilter`

**Dependencies:** T3.1
**Complexity:** S

### T3.6: Connect protocol (DEFERRED)

Connect protocol support for swap operations is deferred to a future PR. The SwapModule is accessed only through the Sphere instance, not via Connect RPC. No implementation work required in this PR.

---

## Critical Path

```
T0.1 (types) → T1.1 (skeleton) → T2.1+T2.5 (propose+DM handlers) → T3.1 (barrel) → T3.2 (Sphere.ts) → T3.3 (CLI)
```

6 sequential levels. The bottleneck is T1.1 (SwapModule skeleton) which blocks all Level 2 work.

---

## Execution Strategy

### Wave 1: Foundation (8 parallel agents)
T0.1, T0.2, T0.3, T0.4, T0.5, T0.6, T0.7, T0.8

### Gate Check: After Wave 1, Before Wave 2
Run ALL AccountingModule tests to verify AsyncGateMap extraction didn't break anything:
`npx vitest run tests/unit/modules/AccountingModule`
All 377+ tests must pass before proceeding to Wave 2.

### Wave 2: Core + Helpers (2 parallel agents)
T1.1, T1.2

### Wave 3: Methods (7 parallel agents, then sequential merge into SwapModule.ts)
T2.1, T2.2, T2.3, T2.4, T2.5, T2.6, T2.7

### Wave 4: Integration (5 parallel agents)
T3.1, T3.2, T3.3, T3.4, T3.5

### Wave 5: Test Helpers (1 agent)
TT0: swap-test-helpers.ts

### Wave 6: Unit Tests (16 parallel agents)
TT1-TT16

### Wave 7: Integration Tests (1 agent)
TT17

---

## New Files Summary

| File | Lines (est.) | Layer |
|------|-------------|-------|
| `modules/swap/types.ts` | 350 | 0 |
| `modules/swap/state-machine.ts` | 100 | 0 |
| `modules/swap/manifest.ts` | 140 | 0 |
| `modules/swap/dm-protocol.ts` | 350 | 0 |
| `core/async-gate.ts` | 40 | 0 |
| `modules/swap/escrow-client.ts` | 250 | 1 |
| `modules/swap/SwapModule.ts` | 2500-3000 | 1-2 |
| `modules/swap/index.ts` | 20 | 3 |
| **Total new source** | **~3740-4240** | |

## Modified Files

| File | Changes | Layer |
|------|---------|-------|
| `core/errors.ts` | +17 error codes | 0 |
| `types/index.ts` | +15 events, +60 lines | 0 |
| `constants.ts` | +5 lines | 0 |
| `modules/accounting/AccountingModule.ts` | Refactor to use AsyncGateMap | 0 |
| `core/Sphere.ts` | +80 lines (6 locations) | 3 |
| `cli/index.ts` | +300 lines (5 commands) | 3 |
| `CLAUDE.md` | +50 lines (SwapModule docs) | 3 |
| `index.ts` | +10 lines (re-export swap types) | 3 |
| `package.json` | +canonicalize dep | 0 |

## New Dependency

```bash
npm install canonicalize
```

RFC 8785 JCS serialization for deterministic swap_id computation. Must match escrow's implementation byte-for-byte.
