# modules/payments/import-export/ — Import/Export Submodule

Per uxfv2-refactor-design.md §2.1 and uxfv2-phase-5-payments-disposition.md.

**Concern:** `importTokens` + added/skipped/rejected taxonomy;
`exportTokens`.

**Public methods this submodule owns:**

| Method | Currently at | Target file |
|---|---|---|
| `importTokens` | PaymentsModule.ts:8712 | `import.ts` |
| `exportTokens` | PaymentsModule.ts:8643 | `export.ts` |

**Public types this submodule owns:**

| Type | Currently at | Target file |
|---|---|---|
| `ImportAddedCode` | PaymentsModule.ts:327 | `types.ts` |
| `ImportSkipCode` | PaymentsModule.ts:346 | `types.ts` |
| `ImportRejectCode` | PaymentsModule.ts:359 | `types.ts` |
| `ImportAdded` | PaymentsModule.ts:370 | `types.ts` |
| `ImportSkipped` | PaymentsModule.ts:382 | `types.ts` |
| `ImportRejected` | PaymentsModule.ts:387 | `types.ts` |
| `ImportTokensResult` | PaymentsModule.ts:392 | `types.ts` |
