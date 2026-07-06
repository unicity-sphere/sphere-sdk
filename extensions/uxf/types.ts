/**
 * Extension type declarations for `@unicitylabs/sphere-sdk`
 *
 * These types are the wire between the composition root and each activated
 * extension. Wave-1 (Phase 3): pure type surface + a factory stub. Real
 * lifecycle wiring lands in Phases 5 (composition root) and 6/7 (host port).
 *
 * ESLint-enforced boundary rule (see `.eslintrc.*`):
 *   Any file OUTSIDE `extensions/` MUST NOT import from `extensions/*` — with
 *   the exception of the two whitelisted attach points listed there.
 */

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface UxfEventMap {
  // Wave-1: intentionally empty. The 33 uxf-only events (orphan-recovered,
  // retention-warning, sent-reconciliation-recovered, etc.) currently live
  // on the main `SphereEventMap` in `types/index.ts`; Phase 7 (API alignment)
  // will move them here so the main event map matches upstream main v0.11.4
  // byte-for-byte and extension consumers subscribe via `sphere.uxf.on(...)`.
}

/** An extension handle attached to a `Sphere` instance. */
export interface ExtensionHandle {
  readonly id: string;
  /** Stability posture — surfaced in the extension's own docs. */
  readonly stability: 'stable' | 'beta' | 'experimental';
  /** Called from `Sphere.destroy()` — implementations release resources. */
  destroy(): Promise<void>;
}

/** The UXF-flavour extension handle. */
export interface UxfHandle extends ExtensionHandle {
  readonly id: 'uxf';
  /**
   * Wave-1: no verbs exposed. Populated in Phase 9 with:
   *   - `bundle.assemble(...)`, `bundle.deconstruct(...)`   (bundle format)
   *   - `pipeline.send(...)`, `pipeline.receive(...)`       (crash-safe)
   *   - `profile.*`                                         (durable sync)
   *   - `on(event, handler)`                                 (`UxfEventMap` bus)
   */
}

/** Ports the composition root exposes to an extension's `install()`. */
export interface ExtensionHost {
  /**
   * Wave-1: shape is intentionally minimal so no core module has to change
   * to compile against it. Phase 5's composition root fleshes it out with:
   *   - `identity`, `storage`, `tokenStorage`, `transport` (with raw event tap),
   *     `oracle`, `events`, `hooks` (payments-side seam),
   *     `onAddressSwitch`, `onDestroy` lifecycle registration.
   */
}

/**
 * A `SphereExtension` is what `sphere.init({ extensions: [...] })` accepts.
 *
 * The factory returned by `uxfExtension(config)` implements this interface —
 * consumers never construct it directly.
 */
export interface SphereExtension<H extends ExtensionHandle = ExtensionHandle> {
  readonly id: string;
  install(host: ExtensionHost): Promise<H>;
}

/**
 * Configuration accepted by `uxfExtension(config)`.
 *
 * Wave-1: no options. Phase 8/9 introduces:
 *   - `bundle:  { formatVersion?: 'v1' | 'v2' }`         (Phase 9 bundle port)
 *   - `pipeline:{ workers?: Partial<UxfWorkerFlags> }`   (Phase 9 pipeline port)
 *   - `profile: { substrate?: 'lean' | 'legacy' }`       (Phase 4 substrate)
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface UxfExtensionConfig {}

/**
 * `storageRefs` shape for `uxfExtension.clear(storageRefs)`.
 *
 * `Sphere.clear()` calls this static so extensions participate in the wipe.
 * Wave-1 is a no-op; wave-2 (Phase 4 substrate) wires ProfileKv + tokenStorage.
 */
export interface UxfStorageRefs {
  readonly dataDir?: string;
  readonly databases?: ReadonlyArray<string>;
}
