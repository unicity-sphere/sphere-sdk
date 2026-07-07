# modules/payments/persistence/ — Persistence Codec Submodule

Per uxfv2-refactor-design.md §2.1 and uxfv2-phase-5-payments-disposition.md.

**Concern:** TXF storage encode/decode (`createStorageData` +
`loadFromStorageData`), save gate + `_doSave`, per-address storage
provider access, `archiveToken` write path.

**Public methods this submodule owns:**

| Method | Currently at | Target file |
|---|---|---|
| `archiveToken` | PaymentsModule.ts:16728 | `codec.ts` |
| `save` | PaymentsModule.ts:16828 | `save.ts` |
| `_doSave` | PaymentsModule.ts:16842 | `save.ts` |
| `createStorageData` | PaymentsModule.ts:17033 | `codec.ts` |
| `loadFromStorageData` | PaymentsModule.ts:17052 (347 lines) | `codec.ts` |
| `setStorageEntry` | PaymentsModule.ts:16797 | `kv-writer-adapter.ts` (delegates to `lib/storage/kv-writer.ts`) |
| `getLocalTokenStorageProvider` | PaymentsModule.ts:11690 | `providers.ts` |

**Instance state:**

- `_saveChain` (Promise) → `save.ts`
- `_w11FallbackLogged` (static Set) → moved into `lib/storage/kv-writer.ts` in Phase 5
- `_lastPinnedOutboxJson` / `_lastPinnedOutboxRef` (last-pin memoization) → stays on facade (referenced by extension OUTBOX ops)

**Complexity note:** `loadFromStorageData` is 347 lines and contains the
snapshot-loser double-spend detection (from PR #182 / Item #14 Phase 2).
The `_audit` route emission MUST route through the extension's
DispositionWriter (see `extensions/uxf/pipeline/module-glue/outbox-ops.ts`);
the persistence codec IS survive-bound but its `_audit` interaction is a
hook onto the extension.

Phase 5 splits carefully preserve that hook via `hooks.ts`. See
uxfv2-phase-5-payments-disposition.md.
