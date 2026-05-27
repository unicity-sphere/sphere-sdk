/**
 * Profile Identity Attachment (SDK-private helper for Issue #292)
 *
 * Wires a {@link Sphere}'s internal {@link FullIdentity} into a pair of
 * Profile providers WITHOUT exposing the private key to the caller.
 * This file is the SDK-private bridge between the Sphere-bound Profile
 * factories (`createBrowserProfileProvidersFromSphere`,
 * `createNodeProfileProvidersFromSphere`) and the Sphere class's
 * `_withFullIdentityForProfileFactory` accessor.
 *
 * ## Architectural invariant (Issue #292 owner)
 *
 * > "Private key material should never leave Sphere SDK itself. However,
 * > it should be possible to perform all the relevant cryptographic
 * > operations within Sphere SDK over external materials by means of
 * > undisclosed respective private key."
 *
 * The helper accepts a `Sphere` instance and a pair of providers. It calls
 * back into the Sphere's `_withFullIdentityForProfileFactory` to obtain a
 * scoped `FullIdentity`, immediately invokes `setIdentity` on each
 * provider, and then drops the reference. The `privateKey` field never
 * leaves the function scope; consumers receive only the bound providers.
 *
 * Initialization of the token storage is also performed here so consumers
 * get ready-to-use providers — no separate `setIdentity` + `initialize`
 * dance is required at the consumer site.
 *
 * @module profile/attach-identity
 * @internal — NOT exported from `@unicitylabs/sphere-sdk/profile`.
 * @see https://github.com/unicity-sphere/sphere-sdk/issues/292
 */

import type { Sphere } from '../core/Sphere';
import type { FullIdentity } from '../types';
import type { ProfileStorageProvider } from './profile-storage-provider';
import type { ProfileTokenStorageProvider } from './profile-token-storage-provider';

/**
 * Attach a Sphere's internal identity to a pair of Profile providers and
 * initialize the token storage so the providers are ready for `get`/`set`/
 * `save`/`load` calls.
 *
 * @param sphere Live Sphere instance — MUST be initialized (an uninitialized
 *               Sphere triggers `SphereError('NOT_INITIALIZED')` inside the
 *               accessor; the caller surfaces that with a clear message).
 * @param providers Profile provider pair to receive the identity. Both
 *                  `storage.setIdentity` and `tokenStorage.setIdentity` are
 *                  invoked; `tokenStorage.initialize()` is awaited afterwards.
 * @internal
 */
export async function attachIdentityToProfileProviders(
  sphere: Sphere,
  providers: {
    readonly storage: ProfileStorageProvider;
    readonly tokenStorage: ProfileTokenStorageProvider;
  },
): Promise<void> {
  // The callback below receives the FullIdentity inside the Sphere's
  // closure; we never store it outside `setIdentity` invocations. The
  // Sphere helper drops the reference after this returns.
  sphere._withFullIdentityForProfileFactory((identity: FullIdentity): void => {
    // Storage provider FIRST so its derived encryption key is in place
    // when the token storage starts wiring up writers that depend on it.
    providers.storage.setIdentity(identity);
    providers.tokenStorage.setIdentity(identity);
  });

  // Connect the storage provider so its OrbitDB Phase-B attach runs.
  // Without this, downstream calls to `tokenStorage.save()` →
  // FlushScheduler → OrbitDB throw `PROFILE_NOT_INITIALIZED` ("OrbitDB
  // adapter is not connected. Call connect() first"). The factory
  // contract promises ready-to-use providers; standalone callers (the
  // migration probe, `migrateTokenStorage`, plain probe `load`s) do not
  // re-route through `Sphere.init`, so connect MUST happen here.
  //
  // connect() is idempotent: a later `Sphere.init`-driven connect re-
  // entry observes `dbStatus==='attached'` and `connectPromise` latch
  // and returns without a second attach.
  await providers.storage.connect();

  // Initialize the token storage so the consumer can immediately read
  // and write — mirrors the manual setIdentity + initialize sequence
  // documented in the existing migration example. Runs AFTER storage
  // connect so `lifecycleManager.initialize`'s `host.db.isConnected()`
  // check sees the attached OrbitDB and proceeds with the bundle-index
  // refresh + cold-start recovery path.
  await providers.tokenStorage.initialize();
}
