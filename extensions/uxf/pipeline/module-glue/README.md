# extensions/uxf/pipeline/module-glue/ — Phase 5 [B] extraction landing site

Phase 5 wave-3 lands here. Per
`docs/uxf/uxfv2-phase-5-payments-disposition.md`, everything in the
`[B] extension-bound` disposition that used to live inside
`modules/payments/PaymentsModule.ts` is extracted into per-concern
files here.

## Purpose

The core `PaymentsModule` facade retains its public API surface (send /
receive / assets / history / …) and the private class fields that own
persistent state. What moves here is the **behavior** that belongs
in the UXF extension:

- **OUTBOX ops** — CID-ref-backed outbox writer, load/save/enqueue chain.
- **UXF dispatch** — `dispatchUxfConservativeSend`, `dispatchUxfInstantSend`,
  `publishUxfBundle`.
- **install\* worker seams** — DI setters for the UXF pipeline workers
  (recovery, reconciliation, verifier, rescan, finalization, …).
- **buildDefault\* factories** — module-scope factories that build the
  default worker implementations wired to in-memory adapters.
- **UXF-specific glue** — `recordUxfBundleSentHistory`,
  `maybeEmitCapabilityWarning`, `validateSourceOwnership`,
  `awaitAllProvidersDurable`, `writeSentEntryFromOutbox`,
  `assertNoDuplicateBundleMembership`, `detectOrphanSpendingTokens`,
  `defaultOrphanRecovery`, `defaultSpentStateTransition`.
- **UXF branches of `handleIncomingTransfer` and `initialize()`** — the
  UXF-shape inbound router and the UXF-worker wiring blocks.

## Extraction shape

Each file exports a set of pure functions plus a matching `Host`
interface. The facade builds the host by capturing its own private
methods / fields as callbacks and passes it into the pure functions.
Facade class methods become one-liner delegators.

State ownership stays on the facade — this dir is purely a set of
behavior-preserving pure moves, matching the wave-1/wave-2 pattern.

## Post-Phase-6.C

Once the facade's `install*` methods retire behind the typed
`PaymentsHooksHost` port (see `modules/payments/hooks.ts`), the
extension attaches its `PipelineHooksHost` implementation and this
dir is what registers with it. At that point the facade only imports
`hooks.ts` — no `extensions/*` crossings remain in `modules/payments/`
except the sanctioned hook attach point.
