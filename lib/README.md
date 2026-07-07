# lib/ — Internal Shared Utilities

Cross-cutting utilities used by more than one module. **Not exported** from
the package root — nothing under `lib/` is part of the public API surface.

Introduced in Phase 5 of the uxf-v2 refactor to de-duplicate patterns copy-
pasted across `modules/payments/`, `modules/accounting/`, `modules/swap/`,
`modules/communications/`, and the pipeline extension. Callers under
`modules/*` and `extensions/*` may import from `lib/`; nothing may re-export
`lib/*` at the package root.

## Layout

| Sub-tree | Purpose | Replaces |
|---|---|---|
| `lib/storage/kv-writer.ts` | W11-originated-tag KV write helper | 4 copy-pasted `setStorageEntry` implementations |
| `lib/concurrency/keyed-mutex.ts` | Per-key serialization primitive | Ad-hoc per-token / per-invoice / per-swap gates |
| `lib/module/lifecycle.ts` | Module load/destroy gate | 6 modules' hand-rolled `_loadPromise`/`ensureInitialized` patterns |
| `lib/dedup/persistent-set.ts` | Bounded persistent dedup set | processedSplit/processedCombined/auto-return dedup ledgers |
| `lib/time/backoff.ts` | Exponential backoff with jitter + abort | v6RecoverPermSaveRetry + swap timers + polling-policy hand-roll |
| `lib/time/interval.ts` | Abortable periodic runner | Scattered setInterval start/stop pairs |

## Consumption plan (Phase 5 → Phase 7)

Landing the primitives in Phase 5 is the foundation. Individual call-site
migrations follow in later phases so the refactor stays reviewable:

- **Phase 5 splits** may adopt lib/ primitives inside newly-created
  submodule files (greenfield consumers).
- **Phase 7 API alignment** performs the final call-site migration of the
  pre-existing modules (drop the four copy-pasted `setStorageEntry` bodies,
  route through `writeKvEntry`; drop the six `loadedPromise`+`ensureInitialized`
  patterns, use `ModuleLifecycle`).

## Testing

Each utility ships with a unit test alongside (`tests/unit/lib/**`).
Utility tests are cheap and pay off outsized because a broken primitive
takes 5+ modules down at once.
