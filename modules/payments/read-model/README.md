# modules/payments/read-model/ — Read Model Submodule

Per uxfv2-refactor-design.md §2.1 and uxfv2-phase-5-payments-disposition.md.

**Concern:** Balance / asset aggregation, fiat valuation, price-provider
seam, transaction history cache + dedup + hydration.

**Public methods this submodule owns** (routed from the PaymentsModule
facade):

| Method | Currently at | Target file |
|---|---|---|
| `getAssets` | PaymentsModule.ts:8368 | `assets.ts` |
| `getBalance` | PaymentsModule.ts:8360 | `assets.ts` |
| `getFiatBalance` | PaymentsModule.ts:8327 | `assets.ts` |
| `setPriceProvider` | PaymentsModule.ts:8305 | (facade delegates via field) |
| `aggregateTokens` | PaymentsModule.ts:8449 | `assets.ts` |
| `getHistory` | PaymentsModule.ts:11515 | `history.ts` |
| `resolveSenderInfo` | PaymentsModule.ts:11553 | `history.ts` |
| `addToHistory` | PaymentsModule.ts:11577 | `history.ts` |
| `loadHistory` | PaymentsModule.ts:11614 | `history.ts` |
| `importRemoteHistoryEntries` | PaymentsModule.ts:11661 | `history.ts` |

**Module-scope helpers:**

| Symbol | Currently at | Target file |
|---|---|---|
| `computeHistoryDedupKey` | PaymentsModule.ts:412 | `history.ts` |
| `MAX_SYNCED_HISTORY_ENTRIES` | PaymentsModule.ts:428 | `history.ts` |
