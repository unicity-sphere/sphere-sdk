/**
 * `@unicitylabs/sphere-sdk/uxf` — UXF extension entry.
 *
 * Public consumer surface for the UXF opt-in extension. Composed via
 * `Sphere.init({ extensions: [uxfExtension(...)] })`; the `sphere.uxf`
 * handle then becomes non-undefined and exposes UXF-flavour APIs.
 *
 * Wave-1 (Phase 3): factory returns a stub handle. Real wiring
 * (bundle format v2, crash-safe pipeline, pointer layer, profile
 * substrate) lands in Phases 6 (STSDK v2 swap) and 9 (extension port).
 *
 * Consumers of upstream sphere-sdk main v0.11.4 who never import from
 * this subpath and never pass `extensions:` to `Sphere.init` observe
 * ZERO behavioral change vs. running upstream main. This is the
 * "invisible to main-only consumers" invariant.
 */

export {
  UXF_ERROR_CODES,
  type UxfErrorCode,
} from './errors';

export type {
  ExtensionHandle,
  ExtensionHost,
  SphereExtension,
  UxfEventMap,
  UxfExtensionConfig,
  UxfHandle,
  UxfStorageRefs,
} from './types';

import type {
  ExtensionHost,
  SphereExtension,
  UxfExtensionConfig,
  UxfHandle,
  UxfStorageRefs,
} from './types';

/**
 * The public extension-attachment shape. Consumers write:
 *
 *   ```ts
 *   import { uxfExtension } from '@unicitylabs/sphere-sdk/uxf';
 *   const { sphere } = await Sphere.init({
 *     ...providers,
 *     extensions: [uxfExtension()],
 *   });
 *   ```
 *
 * Wave-1 factory returns a `SphereExtension` whose `install()` produces
 * a `UxfHandle` stub. The handle is inert; its purpose in Phase 3 is
 * to prove the composition wiring compiles and the conformance harness
 * still sees zero core-surface drift when the extension is absent.
 */
export function uxfExtension(_config?: UxfExtensionConfig): SphereExtension<UxfHandle> {
  return {
    id: 'uxf',
    async install(_host: ExtensionHost): Promise<UxfHandle> {
      return {
        id: 'uxf',
        stability: 'experimental',
        async destroy(): Promise<void> {
          // Wave-1: no resources acquired. Phase 9 wires this to release
          // pipeline workers, profile substrate handles, and bundle CAS refs.
        },
      };
    },
  };
}

/**
 * Static participant in `Sphere.clear()`.
 *
 * Wave-1: no-op. Phase 4 (substrate swap) implements ProfileKv wipe;
 * Phase 9 (pipeline port) adds OUTBOX/SENT tombstone GC.
 */
uxfExtension.clear = async function clear(_storageRefs: UxfStorageRefs): Promise<void> {
  // Wave-1: no persistent state to clear from the extension.
};
