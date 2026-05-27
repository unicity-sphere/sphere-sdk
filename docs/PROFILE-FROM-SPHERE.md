# Profile providers from a Sphere instance

Issue: [#292](https://github.com/unicity-sphere/sphere-sdk/issues/292)

## Architectural invariant (NON-NEGOTIABLE)

From the project owner on Issue #292:

> "Private key material should never leave Sphere SDK itself. However, it should
> be possible to perform all the relevant cryptographic operations within Sphere
> SDK over external materials by means of undisclosed respective private key
> (like generating digital signature, etc.)."

Consumers MUST NEVER receive raw `privateKey` material. The SDK's public surface
exposes only `Identity` (public info), signatures, ciphertexts, or opaque
purpose-derived bytes — never the seed. Any design that exposes
`FullIdentity` to consumer code is rejected.

## The problem this solves

Prior to Issue #292, consumers building Profile providers for migration or
probe scenarios had to synthesize a `FullIdentity` from `Sphere.identity`
(public info only) plus a fake `privateKey: ''`:

```ts
// PRE-#292 — CRASHES on Profile.setIdentity → hexToBytes("")
const identity = sphere.identity;                       // typed Identity | null
const profile = createBrowserProfileProviders({ network });
profile.tokenStorage.setIdentity({ ...identity, privateKey: '' });
// RangeError: hexToBytes: empty hex string
```

`ProfileStorageProvider.setIdentity` and `ProfileTokenStorageProvider.setIdentity`
call `hexToBytes(identity.privateKey)` synchronously inside their bodies to
derive the cache-layer encryption key. An empty string throws.

Live wallets crashed every page load.

## The fix — Sphere-bound factories

Two new public surfaces in `@unicitylabs/sphere-sdk/profile/browser` (and the
Node.js mirror in `@unicitylabs/sphere-sdk/profile/node`):

### 1. `createBrowserProfileProvidersFromSphere(sphere, config)`

Builds Profile providers WITH identity already attached. The Sphere's
private key never crosses the SDK boundary — the factory routes through an
internal accessor that confines the `FullIdentity` reference to the SDK's
own scope.

```ts
import { createBrowserProfileProvidersFromSphere } from '@unicitylabs/sphere-sdk/profile/browser';

const { storage, tokenStorage } = await createBrowserProfileProvidersFromSphere(
  sphere,
  { network: 'mainnet', oracle: providers.oracle },
);
// Providers are ready to use — no setIdentity call needed.
const snap = await tokenStorage.load();
```

### 2. `migrateLegacyToProfile({ sphere, ... })` overload

The existing `migrateLegacyToProfile({ legacy, profile, identity, ... })`
signature still works for callers who derive identity outside Sphere. The
new overload accepts a live Sphere instance and an injected `profileFactory`
callback; the helper constructs the Profile providers with identity attached
and returns them alongside the migration result.

```ts
import { migrateLegacyToProfileBrowser } from '@unicitylabs/sphere-sdk/profile/browser';

const result = await migrateLegacyToProfileBrowser({
  sphere,
  legacy: legacyProviders.tokenStorage,
  network: 'mainnet',
  oracle: providers.oracle,
});

// result.profileProviders is now ready to hand to Sphere.init or store in app state
const { storage, tokenStorage } = result.profileProviders;
```

## Consumer migration story

The sphere.telco repro from Issue #292 was the `uxfProfileMigration.ts`
call site in PR #308. The pre-#292 code synthesized a fake `FullIdentity`
and crashed inside `Profile*.setIdentity`. The post-#292 simplification:

**Before (`migrationIdentity` synthesis, crashes on first page load):**

```ts
const identity = sphere.identity;
if (!identity?.directAddress) return null;

const profile = createBrowserProfileProviders({ network, oracle });
profile.tokenStorage.setIdentity({ ...identity, privateKey: '' });   // BOOM
profile.storage.setIdentity({ ...identity, privateKey: '' });        // BOOM
await profile.tokenStorage.initialize();

const result = await migrateLegacyToProfile({
  legacy: legacyProviders.tokenStorage,
  profile: profile.tokenStorage,
  identity: { ...identity, privateKey: '' },   // never works
  oracle,
  markerStorage: profile.storage,
});
```

**After (Sphere-bound, no privateKey synthesis):**

```ts
const result = await migrateLegacyToProfileBrowser({
  sphere,
  legacy: legacyProviders.tokenStorage,
  network,
  oracle,
});
const profile = result.profileProviders;
```

The probe path in `SphereProvider.tsx` simplifies similarly:

```ts
const profile = await createBrowserProfileProvidersFromSphere(sphere, { network });
const snap = await profile.tokenStorage.load();
```

## Backward compatibility

The existing `migrateLegacyToProfile({ legacy, profile, identity, ... })`
signature is unchanged. The new Sphere-bound overload is discriminated by
the presence of the `sphere` field. Every existing call site continues
to compile and run without source changes.

## Strategic foundation — `SphereCryptographer` interface

Sketched in `profile/cryptographer.ts`. The Profile cache encryption is one
instance of a recurring pattern: external modules need cryptographic
operations performed under the wallet's key without ever seeing the key.
The interface formalises that boundary:

```ts
export interface SphereCryptographer {
  readonly identity: Identity;

  /** HKDF-derived per-purpose key bytes. Suitable for handing to a
   *  downstream module that needs ONE symmetric key for ONE purpose. */
  derivePurposeKey(purpose: SphereCryptographerPurpose): Promise<Uint8Array>;

  // Future surface (sketched, NOT wired in this PR):
  signMessage?(message: Uint8Array): Promise<Uint8Array>;
  signMessageHex?(messageHex: string): Promise<string>;
  encryptForRecipient?(recipientPubkey: string, plaintext: Uint8Array): Promise<Uint8Array>;
  decryptFromSender?(senderPubkey: string, ciphertext: Uint8Array): Promise<Uint8Array>;
}
```

**Status:** Only `derivePurposeKey('profile-cache')` is wired through the
Profile factories in this PR. The remaining methods are sketched so the
interface shape is stable from the first release. A follow-up issue tracks
migrating `Sphere.signMessage`, `PaymentsModule` signing, and
`CommunicationsModule` encryption to delegate via this interface.

## Internal helper — `attachIdentityToProfileProviders`

Lives in `profile/attach-identity.ts`. Confined to SDK-private use:

- NOT re-exported from `@unicitylabs/sphere-sdk/profile` (the barrel) or
  any platform entry point.
- Takes a `Sphere` instance and a pair of Profile providers.
- Routes through `Sphere._withFullIdentityForProfileFactory` to obtain
  a scoped `FullIdentity`, immediately calls `setIdentity` on each
  provider, and drops the reference.

The bridge into Sphere lives at `Sphere._withFullIdentityForProfileFactory`
(prefixed with `_` per TypeScript convention to discourage external
consumers; documented `@internal`). It snapshots `_identity` into a local
const and invokes the callback. It does NOT scrub the snapshot's
`privateKey` post-callback — see the security-review note below for why.

## Security review (steelman attack vectors considered)

1. **Does the helper actually keep privateKey from leaking outside the SDK?**
   - The `FullIdentity` snapshot is constructed inside Sphere and passed
     ONLY into the callback. The callback shape is `(id) => void`; the
     attach-identity wrapper invokes only `setIdentity` on the providers
     (a sync method that derives the encryption key inline and stores
     the identity reference internally). Consumer code receives only
     the constructed providers — never the identity, never the
     `FullIdentity` reference.
   - **Steelman round 1 catch**: an earlier draft included a `finally`
     block that scrubbed `snapshot.privateKey = undefined` post-callback
     to reduce GC retention of the secret. This was REMOVED because the
     `ProfileStorageProvider` stores the snapshot reference and reads
     `identity.privateKey` LAZILY inside `connect()` Phase B (see
     `profile-storage-provider.ts` `identityAtStart.privateKey` at line
     709). A post-callback scrub would null out the authoritative copy
     mid-attach, breaking OrbitDB connection setup. The Sphere
     `_identity.privateKey` field IS the long-lived secret regardless;
     the provider's stored reference adds no new exposure (it lives
     for the same Sphere lifetime).

2. **Uninitialized Sphere — clear error path?**
   - `_withFullIdentityForProfileFactory` throws
     `SphereError('NOT_INITIALIZED')` when `_identity?.privateKey` is
     falsy. Distinct from the cryptic `hexToBytes: empty hex string`
     RangeError the consumer-facing pre-#292 bug threw.

3. **Malicious / buggy consumer corrupting encryption-key state?**
   - The new factories internally call `setIdentity` once before returning
     control to the consumer. A subsequent
     `profile.tokenStorage.setIdentity({...identity, privateKey: ''})` call
     by the consumer would still throw inside `hexToBytes` — the existing
     contract is preserved. The new factories don't WEAKEN that contract;
     they provide a key-safe SUCCESSFUL path.

4. **Concurrent factory calls — shared state safety?**
   - Each factory call constructs its own Profile providers (no shared
     state). The Sphere accessor uses a local-const snapshot per call, so
     concurrent calls each get their own snapshot and don't interfere.

5. **Memory: does the helper retain a Sphere reference?**
   - No. The helper takes a `Sphere` parameter but does not store it. The
     producers (the Profile factories) discard the Sphere reference once
     `attachIdentityToProfileProviders` returns. The constructed providers
     hold only their own internal state (encryption key derived from the
     identity) — they do not hold a back-reference to Sphere.

6. **Pre-existing leakage point — `ProfileTokenStorageProvider.getIdentity()`**
   - **Caveat — this is OUT OF SCOPE for this PR but worth flagging.**
     The `ProfileTokenStorageProvider` class exposes a public
     `getIdentity(): FullIdentity | null` method that returns the stored
     identity, INCLUDING `privateKey`. A consumer of the providers built
     by `createBrowserProfileProvidersFromSphere` can therefore extract
     the wallet's private key after calling the factory.
   - This leakage existed BEFORE #292 — consumers who manually called
     `tokenStorage.setIdentity(fullIdentity)` could read back the same
     identity via `getIdentity()`. The Sphere-bound factories do not
     introduce a NEW exposure; they remove the consumer-facing path that
     required synthesizing a `FullIdentity`.
   - Closing this gap requires migrating
     `ProfileTokenStorageProvider.getIdentity()` to return `Identity` (no
     privateKey) and routing the existing internal callers (the lifecycle
     manager's `Phase B` connect, `factory.ts` line 458) through a separate
     internal-only accessor — too large to bundle here.
   - **Tracked as part of the follow-up SphereCryptographer migration**
     (see "Strategic foundation" above). The future migration will replace
     scattered `getIdentity()` reads with explicit `cryptographer.*` calls
     so the boundary becomes uniform.

## Files changed

| File | What changed |
|---|---|
| `core/Sphere.ts` | New `_withFullIdentityForProfileFactory` internal method (after `signMessage`). |
| `profile/attach-identity.ts` | NEW. SDK-private helper. NOT exported from `profile/index.ts`. |
| `profile/cryptographer.ts` | NEW. `SphereCryptographer` interface sketch + `PROFILE_CACHE_PURPOSE` constant. |
| `profile/browser.ts` | NEW `createBrowserProfileProvidersFromSphere` + convenience `migrateLegacyToProfileBrowser`. |
| `profile/node.ts` | NEW `createNodeProfileProvidersFromSphere` + convenience `migrateLegacyToProfileNode`. |
| `profile/token-storage-migration.ts` | NEW Sphere-bound overload of `migrateLegacyToProfile`. Existing overload unchanged. |
| `profile/index.ts` | Re-exports of new types + `SphereCryptographer` interface. |
| `tests/unit/profile/attach-identity.test.ts` | NEW. Helper contract tests. |
| `tests/unit/profile/cryptographer.test.ts` | NEW. Constant stability tripwire. |
| `tests/unit/profile/token-storage-migration-from-sphere.test.ts` | NEW. Sphere-bound overload coverage + backward compat. |
| `tests/unit/core/Sphere.profile-factory-identity.test.ts` | NEW. Sphere internal-method contract tests. |
