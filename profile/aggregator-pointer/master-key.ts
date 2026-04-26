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
  /**
   * Returns a DEFENSIVE COPY of the 32-byte master-key buffer. The
   * internal buffer is never exposed — steelman remediation for the
   * WeakSet bypass: a holder of a MasterPrivateKey could previously
   * call `masterKey.bytes.set(attackerKey, 0)` and the registry would
   * still report "authorized" because the object identity is unchanged.
   *
   * Callers that feed this buffer into HKDF etc. SHOULD `.fill(0)` the
   * returned copy once finished to narrow heap residue.
   */
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
 * SPEC §14.1 denylist — well-known weak/canonical/test private keys that
 * must never be accepted as wallet master keys. Rejection at
 * createMasterPrivateKey time fails closed before HKDF can derive a
 * deterministic, attacker-known pointer secret that would collide
 * across wallets sharing the same weak seed.
 *
 * Steelman² remediation: the denylist is stored as BYTES, not as a
 * hex Set. The previous hex-Set approach computed
 * `bytesToLowerHex(masterKeyBytes)` on every construction — building a
 * 64-character immutable string of the master key on the heap. JS
 * strings are immutable; `.fill(0)` does not exist for strings. That
 * inadvertently leaked every master key as a heap-resident hex string
 * via the very guard intended to protect it.
 *
 * Byte comparison is straightforward (denylist values are PUBLIC; only
 * the test "is this MY key denylisted?" can hit them). No hex string
 * is ever materialized for legitimate keys.
 */
/** Canonical KAT vector — accepted only when network='test-vectors' (SPEC §14.1). */
const KAT_CANONICAL_VECTOR = new Uint8Array(32).fill(0x01);

const WEAK_KEY_DENYLIST_BYTES: ReadonlyArray<Uint8Array> = Object.freeze([
  // All-zero — structurally invalid secp256k1 scalar.
  new Uint8Array(32),
  // All-FF.
  new Uint8Array(32).fill(0xff),
  // secp256k1 curve order N.
  new Uint8Array([
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b,
    0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
  ]),
  // N-1.
  new Uint8Array([
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b,
    0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x40,
  ]),
  // N+1.
  new Uint8Array([
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b,
    0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x42,
  ]),
]);

function bytesEqual32(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== 32 || b.length !== 32) return false;
  for (let i = 0; i < 32; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function isStructurallyInvalid(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  for (const candidate of WEAK_KEY_DENYLIST_BYTES) {
    if (bytesEqual32(bytes, candidate)) return true;
  }
  return false;
}

function isCanonicalKatVector(bytes: Uint8Array): boolean {
  return bytesEqual32(bytes, KAT_CANONICAL_VECTOR);
}

/**
 * SPEC §14.1 / §11.12 denylist trigger: returns true iff the bytes
 * MUST be rejected at construction. Structurally invalid scalars
 * (all-zero, all-FF, N, N±1) are ALWAYS rejected. The canonical KAT
 * vector (0x01×32) is rejected unless `network === 'test-vectors'`.
 */
function isDenylistedMasterKey(bytes: Uint8Array, network: string | undefined): boolean {
  if (isStructurallyInvalid(bytes)) return true;
  if (isCanonicalKatVector(bytes) && network !== 'test-vectors') return true;
  return false;
}

/**
 * Construct a MasterPrivateKey from raw wallet-root bytes.
 *
 * ONLY Sphere.init/load/create/import may call this. The instance is
 * added to the authorized registry; consumers downstream verify via
 * isAuthorizedMasterKey().
 *
 * SPEC §14.1 / §11.12 denylist enforcement: the canonical KAT vector
 * (0x01×32) and structurally-invalid scalars (all-zero, all-FF, N,
 * N±1) are rejected with PROTOCOL_ERROR. The KAT vector is accepted
 * only when `network === 'test-vectors'` — required by the pointer-
 * layer KAT fixture suite.
 *
 * @param bytes - 32 raw wallet-root bytes
 * @param network - Optional network identifier; pass 'test-vectors' to
 *   accept the canonical 0x01×32 KAT vector. All other values (including
 *   undefined / 'mainnet' / 'testnet' / 'dev') reject it.
 *
 * Lifetime: the caller SHOULD call `instance.zeroize()` in a finally
 * block as soon as the HKDF derivation completes. See
 * profile/pointer-wiring.ts for the canonical pattern.
 */
export function createMasterPrivateKey(
  bytes: Uint8Array,
  network?: string,
): MasterPrivateKey {
  if (bytes.length !== 32) {
    throw new RangeError(
      `MasterPrivateKey must be exactly 32 bytes, got ${bytes.length}`,
    );
  }
  // Reject SharedArrayBuffer: a SAB-backed Uint8Array can be mutated from a
  // Worker between the denylist check and the internal copy (TOCTOU).  An
  // attacker could pass a benign value through the denylist gate and then
  // swap in a weak scalar (all-zero, N, …) before the copy executes.
  if (bytes.buffer instanceof SharedArrayBuffer) {
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.PROTOCOL_ERROR,
      'MasterPrivateKey input must not be backed by SharedArrayBuffer — ' +
        'concurrent mutation between denylist check and internal copy is a TOCTOU risk.',
    );
  }
  // Copy FIRST, then validate the copy — not the caller-controlled buffer.
  // Previous order (validate bytes → copy bytes) was susceptible to
  // TOCTOU if `bytes` was mutated between the two operations.
  // The [_brand] field is compile-time only — TypeScript erases it and
  // `declare const _brand` has no runtime value.
  //
  // Steelman remediation: the `bytes` property is a GETTER that returns a
  // defensive copy of the internal buffer. Exposing the raw Uint8Array
  // directly was defeatable via `masterKey.bytes.set(attackerKey, 0)` even
  // after Object.freeze(instance) — freeze only makes the property slot
  // immutable, not the TypedArray's backing buffer. Each .bytes read
  // therefore allocates a fresh 32-byte copy; callers feeding HKDF should
  // wipe the returned copy when done. `zeroize()` wipes the SOURCE buffer,
  // after which all future .bytes reads return zeros.
  const internalBytes = new Uint8Array(bytes);
  // Evaluate denylist BEFORE capturing isKat so both checks run on the
  // same `internalBytes` snapshot.  Zero the copy on rejection so the
  // buffer does not linger on the heap.
  const denied = isDenylistedMasterKey(internalBytes, network);
  const isKat = isCanonicalKatVector(internalBytes);
  if (denied) {
    internalBytes.fill(0);
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.PROTOCOL_ERROR,
      isKat
        ? 'MasterPrivateKey denylist hit (SPEC §14.1): canonical 0x01×32 KAT vector ' +
          'is reserved for test fixtures. Pass network="test-vectors" to accept it.'
        : 'MasterPrivateKey denylist hit (SPEC §14.1): refusing all-zero / all-FF / ' +
          'curve-order-N scalar. These derive deterministic, ' +
          'cross-wallet-colliding pointer-layer keys.',
    );
  }
  const instance = Object.create(null) as MasterPrivateKey;
  Object.defineProperty(instance, 'bytes', {
    get(): Uint8Array {
      return new Uint8Array(internalBytes);
    },
    enumerable: true,
    configurable: false,
  });
  Object.defineProperty(instance, 'zeroize', {
    value: function zeroize(): void {
      internalBytes.fill(0);
      registry.delete(instance);
    },
    enumerable: true,
    configurable: false,
    writable: false,
  });
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
