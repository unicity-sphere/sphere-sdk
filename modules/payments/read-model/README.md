# modules/payments/read-model/ — Read Model Submodule

Per uxfv2-refactor-design.md §2.1 and uxfv2-phase-5-payments-disposition.md.

**Concern:** Balance / asset aggregation, fiat valuation, price-provider
seam, token views, transaction history cache + dedup + hydration.

**Phase 5 [A] survive-bound extraction — landed.** Facade `PaymentsModule`
retains the public method signatures (`getAssets`, `getBalance`,
`getFiatBalance`, `getTokens`, `getToken`, `getHistory`, `addToHistory`,
`loadHistory`) as one-line delegations to the pure functions here.

**Public methods this submodule owns:**

| Method | Facade delegation | Target file |
|---|---|---|
| `getAssets` | one-liner in PaymentsModule.ts | `assets.ts` (`getAssets`) |
| `getBalance` | one-liner in PaymentsModule.ts | `assets.ts` (`getBalance`) |
| `getFiatBalance` | one-liner in PaymentsModule.ts | `assets.ts` (`getFiatBalance`) |
| `aggregateTokens` | private helper — one-liner in PaymentsModule.ts | `assets.ts` (`aggregateTokens`) |
| `getTokens` | one-liner in PaymentsModule.ts | `tokens-view.ts` (`getTokens`) |
| `getToken` | one-liner in PaymentsModule.ts | `tokens-view.ts` (`getToken`) |
| `getHistory` | one-liner in PaymentsModule.ts | `history.ts` (`getHistoryDescending`) |
| `resolveSenderInfo` | private helper — one-liner in PaymentsModule.ts | `history.ts` (`resolveSenderInfo`) |
| `addToHistory` | one-liner in PaymentsModule.ts | `history.ts` (`addHistoryEntry`) |
| `loadHistory` | one-liner in PaymentsModule.ts | `history.ts` (`loadHistoryEntries`) |
| `importRemoteHistoryEntries` | private helper — one-liner in PaymentsModule.ts | `history.ts` (`importRemoteHistoryEntriesInto`) |

**Module-scope helpers:**

| Symbol | Facade re-export | Target file |
|---|---|---|
| `computeHistoryDedupKey` | `import { computeHistoryDedupKey } from './read-model'` | `history.ts` |
| `MAX_SYNCED_HISTORY_ENTRIES` | `import { MAX_SYNCED_HISTORY_ENTRIES } from './read-model'` | `history.ts` |

**Public types this submodule owns:**

| Type | Origin (pre-Phase-5) | Target file |
|---|---|---|
| `TransactionHistoryEntry` | PaymentsModule.ts:319 (alias of `HistoryRecord`) | `history.ts` |

**Extraction shape:** all exported functions are pure — no `this` bindings.
Each mutating helper accepts an explicit host shim (`AssetsHost`,
`TokensViewHost`, `AddHistoryEntryHost`, `LoadHistoryHost`,
`ImportRemoteHistoryEntriesHost`) plus the mutable state it touches
(`_historyCache` array). State ownership stays on the facade — this
submodule is purely a set of behavior-preserving pure moves.

**PriceProvider seam:** the `priceProvider: PriceProvider | null` field
and the `isPriceDisabled()` gate stay on the facade (per the ledger —
`setPriceProvider` and `isPriceDisabled` are facade methods). The
read-model reads them read-only via `AssetsHost`.
