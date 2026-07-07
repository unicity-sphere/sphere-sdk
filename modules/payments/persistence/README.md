# modules/payments/persistence/ — Persistence Codec Submodule

Per uxfv2-refactor-design.md §2.1 and uxfv2-phase-5-payments-disposition.md.

**Concern:** TXF storage encode/decode (`createStorageData` +
`loadFromStorageData`), save gate + `_doSave` body, per-address storage
provider access, `archiveToken` write path, and the W11 originated-tag
KV writer helper.

**Public methods this submodule owns (Phase 5 wave-3):**

| Method | Was at | Landed at |
|---|---|---|
| `archiveToken` | PaymentsModule.ts:15330 | `codec.ts:archiveTokenImpl` |
| `save` | PaymentsModule.ts:15430 | (facade — single-flight wrapper stays) |
| `_doSave` | PaymentsModule.ts:15444 | `save.ts:runDoSave` |
| `createStorageData` | PaymentsModule.ts:15635 | `codec.ts:createStorageData` |
| `loadFromStorageData` | PaymentsModule.ts:15654 (347 lines) | `codec.ts:loadFromStorageData` |
| `setStorageEntry` | PaymentsModule.ts:15399 | `kv-writer-adapter.ts:writeKvEntry` |
| `getLocalTokenStorageProvider` | PaymentsModule.ts:10695 | `providers.ts:getLocalTokenStorageProvider` |

**Instance state ownership after Phase 5 wave-3:**

- `_saveChain` (Promise) — **stays on facade** — the coalescing wrapper
  around `_doSave` is what enforces single-flight. `runDoSave` is stateless.
- `_w11FallbackLogged` (was `PaymentsModule._w11FallbackLogged` static Set) —
  moved into `kv-writer-adapter.ts` as a module-scope Set. Behavior is
  unchanged (one log per provider class); the ESM-module-graph guarantees
  a single instance.
- `_lastPinnedOutboxJson` / `_lastPinnedOutboxRef` — **stays on facade**
  (referenced by extension OUTBOX ops per uxfv2-phase-5 §"Persistence codec"
  routing).

**Complexity note — `loadFromStorageData` invariants:**

The codec preserves three invariants verbatim from the pre-split routine.
Any change here MUST keep all three:

1. **Tombstone UNION-MERGE** (#143 FIX D). Never overwrite the in-memory
   tombstone set with a strictly-older snapshot. Loop1-S10 atomic
   assignment keeps `tombstones` and `tombstoneKeySet` from drifting
   mid-load — the codec builds fresh containers and the facade re-reads
   them from the returned `LoadFromStorageDataDiff` on completion.
2. **NEVER-WIPE preserved-in-memory restore** (2026-05-16). Storage
   snapshot wins for (tokenId, stateHash) matches; every other in-memory
   token is restored after the storage load. This is the "profile-multi-
   device-sync losing 4 of 7 faucet drops" regression's fix.
3. **JOIN-divergent double-spend detection** (OUTBOX-SEND-FOLLOWUPS Item
   #14 Phase 2 work item 5). When a preserved-in-memory `'transferring'`
   snapshot's genesisTokenId matches a DIFFERENT chain head from storage,
   drop it, tombstone the loser (Steelman H1 — durable paper trail even
   across a process restart between the drop and the event-consume),
   and emit `transfer:double-spend-detected`. The reactive submit-time
   surface (Phase 1) still fires — this surface is the JOIN-time
   companion. Both are documented in CLAUDE.md's event catalog.

The `transfer:double-spend-detected` emit routes through the facade's
`emitEvent` hook (host-shim closure); nothing else in the persistence
submodule touches the wallet event fanout.

**Behavior-preserving:** facade signatures preserved verbatim; the four
extracted algorithms are byte-identical to the pre-split bodies modulo
`this.*` → `host.*` field access; ESLint clean on the new files.

Phase 6.C: no changes to this submodule expected — the v1 STSDK swap
touches the finalization + submit paths, not the TXF codec.
