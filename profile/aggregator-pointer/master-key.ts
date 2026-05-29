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

// Steelman¹⁹/²⁰/²⁵/²⁶: cache prototype methods AND globals at module load
// — defends against late prototype-pollution turning every wipe / type-tag
// check / numeric validation into a no-op or a leak. All security-critical
// operations resolve through these captured references rather than going
// through (potentially polluted or attacker-overridden) prototype lookups
// or `globalThis` reads.
//
// IMPORTANT: this defense is contingent on this module loading BEFORE any
// untrusted code modifies these prototypes/globals. Bundle this module
// early in the import graph; downstream poisoning is then defeated.
const TYPED_ARRAY_FILL = Uint8Array.prototype.fill;
const OBJECT_TO_STRING = Object.prototype.toString;
// Steelman²⁵ critical: capture ArrayBuffer.prototype.slice for use as the
// authoritative copy mechanism. Calling this captured slice via .call()
// requires the receiver to have the [[ArrayBufferData]] internal slot —
// fake objects with a forged [Symbol.toStringTag]='ArrayBuffer' and a
// custom .slice() property cannot pass through it (TypeError on missing
// internal slot). This is the bedrock check that defeats hostile
// TypedArray subclasses regardless of which surface property they spoof.
const ARRAY_BUFFER_SLICE = ArrayBuffer.prototype.slice;
// Steelman²⁶ warning: numeric validation should use captured references
// for consistency with the captured-method discipline above. Late
// pollution `Number.isInteger = () => true` would otherwise nullify
// every range check.
const NUMBER_IS_INTEGER = Number.isInteger;
const NUMBER_MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
// Steelman²⁶ warning: capture Uint8Array constructor so a late
// `globalThis.Uint8Array = HostileSubclass` cannot inject an
// attacker-controlled wrapper around the just-sliced bytes.
const UINT8_ARRAY_CTOR = Uint8Array;
function safeWipe(buf: Uint8Array | null | undefined): void {
  if (!buf) return;
  try {
    TYPED_ARRAY_FILL.call(buf, 0);
  } catch { /* best-effort wipe; never throw out of cleanup */ }
}

/**
 * Cross-realm safe SharedArrayBuffer detection.
 *
 * `instanceof SharedArrayBuffer` checks only the local realm. A SAB
 * originating from another realm (iframe, Worker, vm.runInContext,
 * MessageChannel) is not `instanceof` the local SharedArrayBuffer and
 * would bypass the gate. `Object.prototype.toString` returns the
 * `[Symbol.toStringTag]` value which is `'SharedArrayBuffer'` for any
 * SAB regardless of originating realm (per ECMAScript spec). The
 * captured OBJECT_TO_STRING reference defeats late prototype-pollution
 * attempts that replace `Object.prototype.toString` after module load.
 */
function isSharedArrayBufferLike(buffer: ArrayBufferLike | undefined | null): boolean {
  if (buffer === undefined || buffer === null) return false;
  // Fast path: same-realm instanceof.
  if (typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer) {
    return true;
  }
  // Cross-realm fallback: toStringTag check via captured prototype method.
  return OBJECT_TO_STRING.call(buffer) === '[object SharedArrayBuffer]';
}

/**
 * Steelman²⁵ critical: authoritative ArrayBuffer detection via captured
 * ArrayBuffer.prototype.slice.
 *
 * `Object.prototype.toString.call(b) === '[object ArrayBuffer]'` is
 * forgeable — any object with `[Symbol.toStringTag] = 'ArrayBuffer'`
 * passes. The robust check is to invoke the captured
 * ArrayBuffer.prototype.slice on the candidate: the engine requires
 * the receiver to have the [[ArrayBufferData]] internal slot (only
 * real ArrayBuffer instances have it, regardless of realm). A fake
 * object throws TypeError; a real ArrayBuffer (across realms) returns
 * a slice. We use this as a *primitive* in copyArrayBufferRange below.
 *
 * The toStringTag check is retained as a fast-path heuristic and for
 * better error messages, but the captured-slice call is the
 * load-bearing security check.
 */
function copyArrayBufferRange(
  buffer: unknown,
  start: number,
  end: number,
): ArrayBuffer {
  // Try the captured slice. If `buffer` lacks [[ArrayBufferData]],
  // ARRAY_BUFFER_SLICE throws TypeError; we re-throw as PROTOCOL_ERROR.
  try {
    // ARRAY_BUFFER_SLICE.call(realArrayBuffer, start, end) returns a
    // new ArrayBuffer per the spec.
    return ARRAY_BUFFER_SLICE.call(buffer as ArrayBuffer, start, end);
  } catch (err) {
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.PROTOCOL_ERROR,
      'MasterPrivateKey input.buffer is not a real ArrayBuffer (no [[ArrayBufferData]] internal slot). ' +
        'Hostile TypedArray subclass with a forged .buffer is the most likely cause.',
      undefined,
      { cause: err },
    );
  }
}

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

/**
 * Steelman⁴⁶ WARNING: `Object.freeze()` on the OUTER array prevents
 * reassigning slots, but does NOT freeze the inner `Uint8Array`
 * contents — typed arrays' indexed `[i]` writes are not affected by
 * frozen-object semantics in any spec-compliant JS engine. A hostile
 * module loaded between this module and `createMasterPrivateKey`
 * invocation could mutate `WEAK_KEY_DENYLIST_BYTES[0][0] = 0xff` and
 * silently neutralize the all-zero rejection.
 *
 * The defense: at module load, snapshot the expected denylist contents
 * as a hex fingerprint string (immutable JS primitive). Before every
 * `isStructurallyInvalid` call, recompute the fingerprint of the live
 * denylist and assert equality with the snapshot. If a hostile module
 * mutated the typed-array contents, the assertion fires and we refuse
 * to construct any master key.
 *
 * Note: this still does not defeat SAB-cross-realm attacks where the
 * underlying buffer is observably mutated mid-comparison. Combined
 * with the existing TYPED_ARRAY_FILL / OBJECT_TO_STRING captures, the
 * surface is now: any mutation of denylist contents AT ALL trips the
 * fingerprint check.
 */
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

// Steelman⁴⁷: declared as `const` arrow (immutable binding), not
// `function` (which is a writable module-scope binding). Matches the
// captured-prototype discipline elsewhere in this file. Renamed from
// `bytesToHexInternal` to `denylistFingerprintHex` to make the
// intended use site obvious — this helper MUST NOT be called on
// secret material, since it materializes a heap-resident hex string
// that defeats the steelman² rationale for not using `bytes.toString
// (CryptoJS.enc.Hex)` on master-key bytes.
const denylistFingerprintHex: (b: Uint8Array) => string = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    const v = b[i] ?? 0;
    s += (v < 0x10 ? '0' : '') + v.toString(16);
  }
  return s;
};
const WEAK_KEY_DENYLIST_FINGERPRINT: ReadonlyArray<string> = Object.freeze(
  WEAK_KEY_DENYLIST_BYTES.map((b) => denylistFingerprintHex(b)),
);

const assertDenylistIntact: () => void = (): void => {
  for (let i = 0; i < WEAK_KEY_DENYLIST_BYTES.length; i++) {
    const live = WEAK_KEY_DENYLIST_BYTES[i];
    if (!live || live.length !== 32) {
      throw new Error('master-key: WEAK_KEY_DENYLIST integrity violation (length)');
    }
    if (denylistFingerprintHex(live) !== WEAK_KEY_DENYLIST_FINGERPRINT[i]) {
      throw new Error('master-key: WEAK_KEY_DENYLIST integrity violation (mutated bytes)');
    }
  }
};

/**
 * Steelman⁴⁶ NOTE: previously short-circuited on first byte mismatch,
 * leaking "first matching byte index" as a (very weak) timing channel
 * over public denylist comparisons. XOR-accumulate over all 32 bytes
 * is constant-time. Comparison is over PUBLIC denylist values, so the
 * timing channel was low-impact, but constant-time costs nothing.
 */
function bytesEqual32(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== 32 || b.length !== 32) return false;
  let diff = 0;
  for (let i = 0; i < 32; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

function isStructurallyInvalid(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  // Steelman⁴⁶: trip-wire on denylist tampering BEFORE comparison.
  assertDenylistIntact();
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
  // Steelman²² critical: snapshot ALL view properties (buffer, byteOffset,
  // length) at the very top, BEFORE any further reads. A hostile
  // TypedArray subclass can override these as getters that return one
  // value on the first read and another on subsequent reads.
  //
  // Steelman²³ critical: VALIDATE the snapshotted offset+length BEFORE
  // slicing. ArrayBuffer.prototype.slice clamps negative start/end via
  // `max(byteLength + neg, 0)` — so a hostile subclass returning
  // byteOffset=-64 on a 64-byte underlying buffer with length=32 produces
  // slice(-64, -32) → slice(0, 32), reading the FIRST 32 bytes of the
  // buffer (an attacker-controlled region) — length 32 passes the
  // post-slice check. Pre-validate offset and length as non-negative
  // safe integers AND that offset + length is within the buffer to
  // foreclose this attack.
  const sourceBuffer = bytes.buffer;
  const sourceOffset = bytes.byteOffset;
  const sourceLen = bytes.length;
  if (
    !NUMBER_IS_INTEGER(sourceOffset) ||
    sourceOffset < 0 ||
    sourceOffset > NUMBER_MAX_SAFE_INTEGER
  ) {
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.PROTOCOL_ERROR,
      `MasterPrivateKey input has invalid byteOffset=${String(sourceOffset)} (must be a non-negative safe integer).`,
    );
  }
  if (
    !NUMBER_IS_INTEGER(sourceLen) ||
    sourceLen !== 32
  ) {
    throw new RangeError(
      `MasterPrivateKey must be exactly 32 bytes, got ${String(sourceLen)}`,
    );
  }
  if (
    typeof sourceBuffer !== 'object' ||
    sourceBuffer === null ||
    typeof (sourceBuffer as ArrayBufferLike).byteLength !== 'number' ||
    sourceOffset + sourceLen > (sourceBuffer as ArrayBufferLike).byteLength
  ) {
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.PROTOCOL_ERROR,
      `MasterPrivateKey input range [${sourceOffset}, ${sourceOffset + sourceLen}) exceeds underlying buffer byteLength.`,
    );
  }
  // Reject SharedArrayBuffer: a SAB-backed Uint8Array can be mutated from a
  // Worker between the denylist check and the internal copy (TOCTOU).  An
  // attacker could pass a benign value through the denylist gate and then
  // swap in a weak scalar (all-zero, N, …) before the copy executes.
  //
  // Steelman¹⁹ critical: use cross-realm-safe detection. `instanceof` is
  // realm-scoped — a SAB from an iframe / Worker / vm context is NOT
  // `instanceof` the local SharedArrayBuffer and would slip through.
  if (isSharedArrayBufferLike(sourceBuffer)) {
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.PROTOCOL_ERROR,
      'MasterPrivateKey input must not be backed by SharedArrayBuffer — ' +
        'concurrent mutation between denylist check and internal copy is a TOCTOU risk.',
    );
  }
  // Steelman²⁵ critical: the load-bearing ArrayBuffer check happens at
  // the slice site below (copyArrayBufferRange uses captured
  // ArrayBuffer.prototype.slice which requires the [[ArrayBufferData]]
  // internal slot). A toStringTag check would be forgeable and is
  // omitted as redundant.
  // Steelman²¹/²²/²⁵: copy via captured ArrayBuffer.prototype.slice.call
  // on the snapshotted buffer / offset / length. `sourceBuffer.slice()`
  // would go through prototype lookup and could be hijacked by a hostile
  // subclass; the captured slice (copyArrayBufferRange) demands the
  // [[ArrayBufferData]] internal slot and throws on fakes.
  //
  // Steelman remediation: the `bytes` property is a GETTER that returns a
  // defensive copy of the internal buffer. Exposing the raw Uint8Array
  // directly was defeatable via `masterKey.bytes.set(attackerKey, 0)` even
  // after Object.freeze(instance) — freeze only makes the property slot
  // immutable, not the TypedArray's backing buffer. Each .bytes read
  // therefore allocates a fresh 32-byte copy; callers feeding HKDF should
  // wipe the returned copy when done. `zeroize()` wipes the SOURCE buffer,
  // after which all future .bytes reads return zeros.
  const internalBytes = new UINT8_ARRAY_CTOR(
    copyArrayBufferRange(sourceBuffer, sourceOffset, sourceOffset + sourceLen),
  );
  // Steelman²² critical defense-in-depth: re-assert the copy length.
  // ArrayBuffer.slice clamps end to byteLength; if sourceOffset + sourceLen
  // exceeds the underlying buffer, the slice is shorter. Any length
  // mismatch here means the snapshot lied — fail closed.
  if (internalBytes.length !== 32) {
    safeWipe(internalBytes);
    throw new AggregatorPointerError(
      AggregatorPointerErrorCode.PROTOCOL_ERROR,
      `MasterPrivateKey internal copy length mismatch: expected 32, got ${internalBytes.length}. ` +
        'Hostile TypedArray subclass with shifting offset/length getters is the most likely cause.',
    );
  }
  // Evaluate denylist BEFORE capturing isKat so both checks run on the
  // same `internalBytes` snapshot.  Zero the copy on rejection so the
  // buffer does not linger on the heap.
  const denied = isDenylistedMasterKey(internalBytes, network);
  const isKat = isCanonicalKatVector(internalBytes);
  if (denied) {
    safeWipe(internalBytes);
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
      // Steelman²⁷: use captured Uint8Array constructor so a late
      // `globalThis.Uint8Array = HostileSubclass` cannot inject an
      // attacker-controlled wrapper around the master key on the
      // hot path to HKDF (key-derivation.ts:89 reads masterKey.bytes).
      return new UINT8_ARRAY_CTOR(internalBytes);
    },
    enumerable: true,
    configurable: false,
  });
  Object.defineProperty(instance, 'zeroize', {
    value: function zeroize(): void {
      safeWipe(internalBytes);
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
