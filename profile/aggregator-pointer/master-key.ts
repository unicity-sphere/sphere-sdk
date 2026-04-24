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
   * Zero the underlying 32-byte buffer and revoke the instance from
   * the authorized registry (SPEC §11.11, R-11 residual-risk narrowing).
   *
   * After calling zeroize():
   *   - The `bytes` buffer is filled with 0x00 (same reference, zeroed in place).
   *   - isAuthorizedMasterKey() returns false.
   *   - assertAuthorizedMasterKey() throws PROTOCOL_ERROR.
   *   - derivePointerKeyMaterial() / any other registry-gated consumer
   *     throws PROTOCOL_ERROR rather than operating on zeroed bytes.
   *
   * Idempotent: calling zeroize() more than once is safe.
   *
   * Callers MUST invoke this in a `finally` block as soon as the key
   * material is no longer needed (typically immediately after HKDF
   * derivation produces the downstream SecretKey wrappers).
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
 * The caller SHOULD zero its own copy of the input bytes after this
 * function returns — createMasterPrivateKey copies into an internal
 * buffer and no longer references the caller's array.
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
  // remains mutable in place — that is a documented limitation: we
  // trust the Sphere init call sites not to hand out MasterPrivateKey
  // references to untrusted code. The WeakSet registry is the
  // load-bearing runtime guard (see assertAuthorizedMasterKey).
  const internalBytes = new Uint8Array(bytes);
  const instance = Object.freeze({
    bytes: internalBytes,
    zeroize(): void {
      // Wipe the underlying buffer in place. Callers that retain a
      // reference to `bytes` see it zeroed — that is intentional and
      // documented. Remove from the registry so downstream guards
      // fail fast rather than silently processing zeros.
      internalBytes.fill(0);
      registry.delete(instance);
    },
  }) as unknown as MasterPrivateKey;
  registry.add(instance);
  return instance;
}

/**
 * True iff the instance was produced by createMasterPrivateKey() and
 * has not been zeroized. Returns false once zeroize() has been called.
 */
export function isAuthorizedMasterKey(candidate: MasterPrivateKey): boolean {
  return registry.has(candidate);
}

/**
 * Guard helper: throws PROTOCOL_ERROR if the supplied master key was
 * not constructed through the authorized path or has already been
 * zeroized. Called at the top of every pointer-key-derivation function
 * that consumes a MasterPrivateKey.
 *
 * PROTOCOL_ERROR is intentional: an unauthorized or post-zeroize
 * master key reaching a derivation function is a protocol-level misuse
 * (caller bypassed the Sphere init path or used the key after its
 * lifetime ended), not a type error. Fail closed.
 */
export function assertAuthorizedMasterKey(candidate: MasterPrivateKey): void {
  if (!registry.has(candidate)) {
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.PROTOCOL_ERROR,
      'MasterPrivateKey was not produced by createMasterPrivateKey(); ' +
        'raw, cast, or zeroized instances are rejected to prevent ' +
        'child-key substitution and use-after-wipe.',
    );
  }
}
