# modules/payments/sync/ — Sync Engine Submodule

Per uxfv2-refactor-design.md §2.1 and uxfv2-phase-5-payments-disposition.md.

**Concern:** `sync`/`_doSync` engine, storage-event subscription with
debounce, provider map management, aggregator validation.

**Public methods this submodule owns:**

| Method | Currently at | Target file |
|---|---|---|
| `sync` | PaymentsModule.ts:12141 | `engine.ts` |
| `_doSync` | PaymentsModule.ts:12160 | `engine.ts` |
| `subscribeToStorageEvents` | PaymentsModule.ts:12396 | `storage-events.ts` |
| `unsubscribeStorageEvents` | PaymentsModule.ts:12417 | `storage-events.ts` |
| `debouncedSyncFromRemoteUpdate` | PaymentsModule.ts:12433 | `storage-events.ts` |
| `getTokenStorageProviders` | PaymentsModule.ts:12461 | `engine.ts` |
| `updateTokenStorageProviders` | PaymentsModule.ts:12507 | `engine.ts` |
| `validate` | PaymentsModule.ts:12522 | `engine.ts` |

**Public types:**

| Type | Currently at | Target file |
|---|---|---|
| `SyncOptions` | PaymentsModule.ts:462 | `types.ts` |
| `SyncResult` | PaymentsModule.ts:485 | `types.ts` |

**Instance state:**

- `_syncInProgress` (boolean) → `engine.ts`
- `syncDebounceTimer` (timer) → `storage-events.ts`
- `SYNC_DEBOUNCE_MS` (constant) → `storage-events.ts`
- `storageEventUnsubscribers` (Array) → `storage-events.ts`
