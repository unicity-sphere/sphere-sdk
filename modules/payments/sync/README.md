# modules/payments/sync/ — Sync Engine Submodule

Per uxfv2-refactor-design.md §2.1 and uxfv2-phase-5-payments-disposition.md
§"Sync".

**Concern:** `sync` / `_doSync` engine, storage-event subscription with
debounce, provider map management, aggregator validation.

**Files landed (Phase 5 wave-2):**

| File | Extracted from | Responsibility |
|---|---|---|
| `types.ts` | PaymentsModule.ts:410–445 | `SyncOptions`, `SyncResult` public shapes |
| `engine.ts` | PaymentsModule.ts:11513–11936 | `runSync` (`_doSync` body), `getActiveTokenStorageProviders`, `validateTokensAgainstOracle` |
| `storage-events.ts` | PaymentsModule.ts:11768–11828 | `subscribeToStorageEventsHelper`, `unsubscribeStorageEventsHelper`, `debouncedSyncFromRemoteUpdateHelper`, `SYNC_DEBOUNCE_MS` |
| `index.ts` | — | Barrel export |

**Facade delegation (behavior-preserving pure moves):**

| Facade method | Delegates to |
|---|---|
| `sync()` (coalescing wrapper) | retained on facade — owns `_syncInProgress` promise, delegates body to `_doSync` |
| `_doSync()` | `runSync` |
| `subscribeToStorageEvents()` | `subscribeToStorageEventsHelper` |
| `unsubscribeStorageEvents()` | `unsubscribeStorageEventsHelper` |
| `debouncedSyncFromRemoteUpdate()` | `debouncedSyncFromRemoteUpdateHelper` |
| `getTokenStorageProviders()` | `getActiveTokenStorageProviders` |
| `updateTokenStorageProviders()` | retained on facade — a two-liner that assigns to `deps.tokenStorageProviders` and re-subscribes; the assignment + re-subscribe pair is idiomatic on the facade |
| `validate()` | `validateTokensAgainstOracle` |
| `isPriceDisabled()` | retained on facade (ledger says stays on facade) |

**Instance state (retained on facade):**

- `_syncInProgress: Promise<SyncResult> | null` — the coalescing wrapper's
  in-flight promise. Facade retains ownership because the wrapper is
  itself on the facade.
- `storageEventUnsubscribers: Array<() => void>` — passed by reference to
  the helpers so they mutate in place.
- `syncDebounceTimerRef: DebounceTimerRef` — small `{ timer }` container
  passed by reference to the helpers so they mutate `.timer` in place.
  Replaces the pre-split `syncDebounceTimer` field.

**Out of scope (other agents / other waves):**

- `drainPendingFinalizations` → `legacy-v1/drain-pending.ts` (v1 pending
  finalization; Phase 6.C removes).
- V6-RECOVER permanent-verdict predicate (`isV6RecoverPermanentToken`) →
  `legacy-v1/proof-polling/*.ts` (v1 finalization; Phase 6.C removes).

`sync/engine.ts` added to `EXTENSION_BOUNDARY_ALLOWLIST` in
`eslint.config.js` — it still calls `computeAddressId` from
`extensions/uxf/profile/types` for the per-provider address guard, matching
the parent facade's crossing. Burns down in Phase 7 when the extensions
layer inverts control.
