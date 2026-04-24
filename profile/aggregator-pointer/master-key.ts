/**
 * MasterPrivateKey — branded newtype + runtime WeakSet registry (T-A5b).
 *
 * Prevents accidental substitution of a BIP32 child key for the wallet
 * master key in pointer-key-derivation call sites. Because raw 32-byte
 * secp256k1 scalars are indistinguishable between master and child
 * keys at the byte level, compile-time branding alone is defeatable
 * via `as unknown as MasterPrivateKey` casts. The WeakSet enforces
 * at runtime that only instances produced by the authorized
 * construction path are accepted.
 *
 * Authorized constructors: Sphere.init / load / create / import.
 * Any downstream consumer that receives a MasterPrivateKey MUST NOT
 * create one themselves.
 */

import { AggregatorPointerError, AggregatorPointerErrorCode } from './errors.js';

declare const _brand: unique symbol;

export interface MasterPrivateKey {
  readonly [_brand]: 'MasterPrivateKey';
  readonly bytes: Uint8Array;
  /**
   * Wipe the underlying byte buffer via `.fill(0)` and evict the
   * instance from the authorized registry. After `zeroize()`:
   *   - `isAuthorizedMasterKey()` returns false
   *   - `assertAuthorizedMasterKey()` throws PROTOCOL_ERROR
   *   - `derivePointerKeyMaterial()` — or any consumer that
   *     calls the assert — fails closed
   *
   * Narrows the SPEC §11.11 residual-risk window: master-key
   * bytes live in heap no longer than the HKDF derivation path
   * that needs them. Idempotent; safe to call repeatedly.
   */
  zeroize(): void;
}

const registry = new WeakSet<MasterPrivateKey>();

/**
 * Construct a MasterPrivateKey from raw wallet-root bytes.
 *
 * ONLY Sphere.init/load/create/import may call this. The instance is
 * added to the authorized registry; consumers downstream verify via
 * isAuthorizedMasterKey().
 *
 * Lifetime: the caller SHOULD call `instance.zeroize()` in a finally
 * block as soon as the HKDF derivation completes. See
 * profile/pointer-wiring.ts for the canonical pattern.
 */
export function createMasterPrivateKey(bytes: Uint8Array): MasterPrivateKey {
  if (bytes.length !== 32) {
    throw new RangeError(
      `MasterPrivateKey must be exactly 32 bytes, got ${bytes.length}`,
    );
  }
  // The [_brand] field is compile-time only — TypeScript erases it and
  // `declare const _brand` has no runtime value. Object.freeze here
  // provides shallow object immutability; the underlying Uint8Array
  // is referenced via a closure so `zeroize()` can wipe it in place
  // while `bytes` (the frozen property) continues to point at the
  // now-zeroed buffer. The WeakSet registry is the load-bearing
  // runtime guard (see assertAuthorizedMasterKey).
  const internalBytes = new Uint8Array(bytes);
  const instance = {
    bytes: internalBytes,
    zeroize(): void {
      internalBytes.fill(0);
      registry.delete(instance as MasterPrivateKey);
    },
  } as unknown as MasterPrivateKey;
  Object.freeze(instance);
  registry.add(instance);
  return instance;
}

/**
 * True iff the instance was produced by createMasterPrivateKey() AND
 * has not been zeroize()'d since. Post-zeroize returns false — that
 * is by design: a zeroed master key carries no secret material and
 * must not be reused.
 */
export function isAuthorizedMasterKey(candidate: MasterPrivateKey): boolean {
  return registry.has(candidate);
}

/**
 * Guard helper: throws PROTOCOL_ERROR if the supplied master key was
 * not constructed through the authorized path OR has been
 * zeroize()'d. Called at the top of every pointer-key-derivation
 * function that consumes a MasterPrivateKey.
 *
 * PROTOCOL_ERROR is intentional for both cases:
 *   - unauthorized (never in registry) — caller bypassed the Sphere
 *     init path
 *   - zeroized (was in registry, now evicted) — caller retained a
 *     reference past its intended lifetime
 * Both are protocol-level misuse; fail closed.
 */
export function assertAuthorizedMasterKey(candidate: MasterPrivateKey): void {
  if (!registry.has(candidate)) {
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.PROTOCOL_ERROR,
      'MasterPrivateKey was not produced by createMasterPrivateKey() or has been zeroized; ' +
        'raw, cast, or post-lifetime instances are rejected to prevent child-key substitution or secret-material reuse.',
    );
  }
}
