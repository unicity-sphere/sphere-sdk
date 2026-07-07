# modules/payments/import-export/ — Import/Export Submodule

Per uxfv2-refactor-design.md §2.1 and uxfv2-phase-5-payments-disposition.md.

**Concern:** `importTokens` + added/skipped/rejected taxonomy;
`exportTokens`.

**Phase 5 [A] survive-bound extraction — landed.** Facade `PaymentsModule`
retains the public method signatures (`exportTokens`, `importTokens`) as
one-line delegations to the pure functions here. The result-type taxonomy
(`ImportAdded`, `ImportSkipped`, `ImportRejected`, `ImportTokensResult`,
plus the string-literal `*Code` unions) is re-exported through
`PaymentsModule.ts` so external consumer imports keep working unchanged.

**Public methods this submodule owns:**

| Method | Facade delegation | Target file |
|---|---|---|
| `exportTokens` | one-liner in PaymentsModule.ts | `export.ts` (`exportTokensFromMap`) |
| `importTokens` | one-liner in PaymentsModule.ts | `import.ts` (`importTokensInto`) |

**Public types this submodule owns:**

| Type | Origin (pre-Phase-5) | Target file |
|---|---|---|
| `ImportAddedCode` | PaymentsModule.ts:327 | `types.ts` |
| `ImportSkipCode` | PaymentsModule.ts:346 | `types.ts` |
| `ImportRejectCode` | PaymentsModule.ts:359 | `types.ts` |
| `ImportAdded` | PaymentsModule.ts:370 | `types.ts` |
| `ImportSkipped` | PaymentsModule.ts:382 | `types.ts` |
| `ImportRejected` | PaymentsModule.ts:387 | `types.ts` |
| `ImportTokensResult` | PaymentsModule.ts:392 | `types.ts` |

**Extraction shape:** the two exported functions are pure — no `this`
bindings. `importTokensInto` accepts an `ImportHost` shim
(`tokens`, `isStateTombstoned`, `addToken`) so it stays decoupled from
`PaymentsModule` internals. The facade wires its instance methods into
the shim at each call. `exportTokensFromMap` takes a `ReadonlyMap`
snapshot of the wallet's tokens.
