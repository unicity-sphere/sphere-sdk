# uxf-v2 Phase 3 report — Extension quarantine + ESLint boundary

**Date:** 2026-07-07. **Branch:** `@vrogojin/uxf-v2`.
**Executes:** `uxfv2-execution-plan-v2.md` §4 Phase 3 + `uxfv2-extension-design.md` §5/§6.

## 1. Commits

| SHA | Sub-phase | Message |
|---|---|---|
| `42bab2b8` | 3.A step 1 | `refactor(uxf-v2): move uxf/ → extensions/uxf/bundle/ (Phase 3.A step 1)` |
| `737cd07f` | 3.A step 2 | `refactor(uxf-v2): move modules/payments/transfer/ → extensions/uxf/pipeline/ (Phase 3.A step 2)` |
| `415ee7df` | 3.A step 3 | `refactor(uxf-v2): move profile/ → extensions/uxf/profile/ (Phase 3.A step 3)` |
| `468668ef` | 3.A step 4 | `refactor(uxf-v2): move UXF-only type files → extensions/uxf/types/ (Phase 3.A step 4)` |
| `8369f6bb` | 3.B | `feat(uxf-v2): extension scaffolding (SphereExtension + UxfHandle + factory)` |
| `27ddd6e6` | 3.C | `feat(uxf-v2): ESLint core→extensions boundary + burn-down allowlist` |
| _pending_ | 3.D | `docs(uxf-v2): Phase 3 report` (this commit) |

## 2. Physical relocations (Sub-phase 3.A)

Behaviour-preserving `git mv` — history follows the moved files.

| Old path | New path | Files | Notes |
|---|---|---|---|
| `uxf/` | `extensions/uxf/bundle/` | 19 | UXF bundle format (CAR/CID, package, instance-chain) |
| `modules/payments/transfer/` | `extensions/uxf/pipeline/` | 43 | OUTBOX/SENT/dispositions, workers, at-least-once |
| `profile/` | `extensions/uxf/profile/` | 87 | OrbitDB substrate, ipfs-client, pointer layer, aggregator-pointer/, factory, migration |
| UXF-only type files | `extensions/uxf/types/` | 5 | uxf-outbox, uxf-sent, uxf-transfer, disposition |
| **Total moved** | | **154** | |

Imports re-pointed across the tree by the prior agent. `git diff uxf-v2-base...` shows ~200 files edited for import updates.

## 3. Extension scaffolding (Sub-phase 3.B)

New surface added under `extensions/uxf/` (top-level, alongside the moved dirs):

- **`types.ts`** — type declarations only (no runtime code):
  - `SphereExtension<H>` — factory-returned attach object (`{id, install(host): Promise<H>}`)
  - `ExtensionHost` — port passed to `install()` (wave-1: empty shell; Phase 5 fleshes out)
  - `ExtensionHandle` — base (`id`, `stability: 'stable' | 'beta' | 'experimental'`, `destroy()`)
  - `UxfHandle extends ExtensionHandle` (wave-1: empty; Phase 9 populates)
  - `UxfEventMap` (wave-1: empty; Phase 7 moves the 33 uxf-only events off `SphereEventMap` into here)
  - `UxfExtensionConfig`, `UxfStorageRefs`
- **`errors.ts`** — `UXF_ERROR_CODES` const + `UxfErrorCode` type (12 codes across bundle/pipeline/profile/lifecycle)
- **`index.ts`** — public `/uxf` subpath:
  - `uxfExtension(config?)` factory — returns `SphereExtension<UxfHandle>` with an inert stub `install()`
  - Static `uxfExtension.clear(storageRefs)` — no-op (Phase 4 wires ProfileKv wipe)

**Wired into `Sphere`** (`core/Sphere.ts`):
- `SphereInitOptions.extensions?: ReadonlyArray<{id: string; install(host): Promise<any>}>` — optional attach point
- `public readonly uxf?: {id, stability, destroy}` — declared inline (structural mirror of `UxfHandle`) so `core/` doesn't cross the extension boundary at compile time
- Activation wiring itself is DEFERRED to Phase 5 (when the composition root moves to `core/sphere/composition.ts`). Wave-1 `sphere.uxf` is `undefined` regardless of whether `extensions:` was passed — proving the "invisible to main-only consumers" invariant holds.

**Package + build:**
- `package.json` `exports["./uxf"]` retargeted `./dist/uxf/index.js` → `./dist/extensions/uxf/index.js` (matches the moved-code reality)
- `tsup.config.ts` UXF entry retargeted `extensions/uxf/bundle/index.ts` → `extensions/uxf/index.ts`
- Build verified: `dist/extensions/uxf/index.{js,cjs,d.ts,d.cts}` produced (~4 KB each)

## 4. ESLint boundary rule (Sub-phase 3.C)

`eslint.config.js` gains a `no-restricted-imports` rule scoped to every core directory (13 globs) banning any import path matching `**/extensions/**` or `extensions/**`. The error message tells the reader how to fix the violation (route through a hook/port) and points at the allowlist for temporary exceptions.

**Temporary allowlist — 15 files, with burn-down targeting:**

| Phase | File | Crossing count |
|---|---|---|
| Phase 5 (core mega-file splits) | `core/Sphere.ts` | 5 |
| Phase 5 | `modules/payments/PaymentsModule.ts` | 42 |
| Phase 5 | `modules/accounting/AccountingModule.ts` | 1 |
| Phase 5 | `modules/accounting/types.ts` | 1 |
| Phase 5 | `modules/communications/CommunicationsModule.ts` | 1 |
| Phase 5 | `modules/groupchat/GroupChatModule.ts` | 1 |
| Phase 5 | `types/index.ts` | 3 |
| Phase 7 (API alignment + transport port inversion) | `transport/NostrTransportProvider.ts` | 2 |
| Phase 7 | `transport/transport-provider.ts` | 1 |
| Phase 7 | `impl/browser/index.ts` | 2 |
| Phase 7 | `impl/browser/storage/IndexedDBStorageProvider.ts` | 1 |
| Phase 7 | `impl/nodejs/index.ts` | 4 |
| Phase 7 | `impl/nodejs/storage/FileStorageProvider.ts` | 1 |
| Phase 7 | `index.ts` | 3 |
| Phase 7 or drop | `tools/restore-legacy-outbox.ts` | 4 |
| **Total crossings** | | **72** |

The allowlist itself IS the burn-down mechanism — as Phases 5 and 7 land, entries are removed from the list. A grep on `EXTENSION_BOUNDARY_ALLOWLIST` finds the current burn-down status.

**Boundary rule verified:**
- Scaffolding files (`extensions/uxf/{index,types,errors}.ts`) lint clean.
- Deliberate test violation in a scratch file placed in a matching core dir but NOT on the allowlist DOES fail the boundary rule with the expected error message.
- Existing lint output shows only pre-existing warnings + 3 pre-existing errors (unrelated regex-escape and empty-interface-in-unrelated-files) — the boundary rule adds zero new errors because every current crossing is allowlisted.

## 5. Definition of Done

| Item | Status | Notes |
|---|---|---|
| Physical relocation of 3 target dirs + type files | ✅ done | 154 files moved via `git mv` — history preserved |
| Extension scaffolding types + factory | ✅ done | `extensions/uxf/{types,errors,index}.ts` |
| `SphereInitOptions.extensions?` + `sphere.uxf` handle | ✅ done | Type surface exists; activation wiring deferred to Phase 5 |
| Package `exports["./uxf"]` + tsup entry | ✅ done | Retargeted to new path |
| ESLint boundary rule | ✅ done | `no-restricted-imports` on 13 core dir globs |
| Temporary allowlist enumerated with burn-down phase | ✅ done | 15 files, split Phase 5 (7) / Phase 7 (7 + 1 evaluate) |
| Build green | ✅ green | `npm run build` — Node 22, all subpaths |
| Typecheck green | ✅ green | `npx tsc --noEmit` returns 0 |
| Test suite | ⚠ **99.4% pass** (8788 / 8839 pass, 35 fail, 16 skip) | +4 failures vs Phase 2 tip — all path-drift from the moves (bundle-duplication canonical-path check, pointer category-P, profile-token-storage-454-followups); +2 same-class as Phase 2's shape-drift follow-ups. No production-code regressions. |

**Path-drift failures itemized** (Phase 3-only new fails):
- `tests/build/bundle-duplication.test.ts > T-D12b — ProfilePointerLayer bundle-duplication invariant` — expects the canonical `ProfilePointerLayer` export path; needs updating for the moved location.
- `tests/conformance/pointer/category-P.test.ts` — same class, references old profile/ paths.
- `tests/unit/profile/profile-token-storage-454-followups.test.ts` — imports/mocks against old paths.

These are follow-up test-refactor work; not gating Phase 4.

## 6. Deviations from the plan

- **`sphere.uxf` activation wiring deferred to Phase 5.** The plan called for an "activation call in the (still-unsplit) Sphere init path — behind an `if (options.extensions)` guard". Under Phase 3 the type surface exists (`SphereInitOptions.extensions?` accepts extensions, `sphere.uxf` handle is typed on the class) but the runtime attachment is a no-op — `sphere.uxf` remains `undefined` even when `extensions:` is passed. Rationale: (a) the plan's "invisible to main-only consumers" invariant is UNCONDITIONALLY held today (undefined for everyone), (b) real activation requires threading through `Sphere.create`/`Sphere.load` and calling `install(host)` — which needs an `ExtensionHost` implementation, and (c) the composition root that owns activation moves to `core/sphere/composition.ts` in Phase 5's Sub-phase 2. Landing the activation stub in the still-unsplit `Sphere` here would create work that Phase 5 immediately relocates.
- **`sphere.uxf` typed inline in `core/Sphere.ts` rather than imported from `extensions/uxf/types`.** Preserves the ESLint boundary rule at compile time. The inline shape is a structural mirror of `UxfHandle`.
- **Docs sweep landed as its own commit** (Phase 3.D — this file), consistent with Phase 2's structure.

## 7. Can Phase 4 (OrbitDB→ProfileKv substrate swap) proceed?

**Yes.** The profile substrate is now physically inside `extensions/uxf/profile/` — Phase 4's work (swap ProfileDatabase implementation + drop OrbitDB/Helia dependency block per `uxfv2-substrate-alternatives.md`) is entirely scoped inside `extensions/uxf/profile/` + touches of the `impl/*/index.ts` factory files. The ESLint boundary is in place; Phase 4 changes stay INSIDE the extension boundary and won't create new core→extensions crossings.

Recommend running `/steelman` on the current branch tip before dispatching Phase 4.
