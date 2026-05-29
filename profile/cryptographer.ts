/**
 * SphereCryptographer — Foundation for SDK-bound cryptographic delegation (Issue #292)
 *
 * ## Architectural invariant (from project owner)
 *
 * > "Private key material should never leave Sphere SDK itself. However, it
 * > should be possible to perform all the relevant cryptographic operations
 * > within Sphere SDK over external materials by means of undisclosed
 * > respective private key (like generating digital signature, etc.)."
 *
 * Consumers (and even sibling SDK modules outside `core/Sphere.ts`) MUST NEVER
 * receive raw `privateKey` material. They get back signatures, ciphertexts, or
 * opaque purpose-derived key bytes — never the seed.
 *
 * ## Scope of THIS file
 *
 * This module sketches the long-term `SphereCryptographer` interface, but
 * Issue #292's tactical scope only requires ONE of its operations:
 * `derivePurposeKey('profile-cache')`. The Profile providers
 * (`ProfileStorageProvider.setIdentity`,
 * `ProfileTokenStorageProvider.setIdentity`) call `hexToBytes(privateKey)`
 * synchronously inside their bodies to derive the cache-layer encryption
 * key. Consumers building Profile providers without a live wallet (probe,
 * migration) could not supply a real `privateKey`, so they passed `''` and
 * crashed inside `hexToBytes`.
 *
 * The Sphere-bound Profile factories in `profile/browser.ts` and
 * `profile/node.ts` route through `Sphere`'s internal identity to perform
 * the same derivation INSIDE the SDK boundary. The cryptographer interface
 * is what they conceptually invoke; for now the implementation just calls
 * `Sphere`'s existing private accessor.
 *
 * ## Future surface (NOT implemented in this PR — follow-up tracked)
 *
 * The interface below lists the methods a future, fully-extracted
 * `SphereCryptographer` would expose so external modules and consumers can
 * delegate ALL key operations without ever holding the raw key:
 *
 *   - `signMessage(bytes)` — secp256k1 ECDSA signing
 *   - `signMessageHex(hex)` — convenience hex wrapper
 *   - `encryptForRecipient(pubkey, plaintext)` — NIP-04 / NIP-17 envelope encrypt
 *   - `decryptFromSender(pubkey, ciphertext)` — counterpart decrypt
 *   - `derivePurposeKey(purpose)` — HKDF-derived per-purpose key bytes; the
 *     returned bytes ARE secret-equivalent (any holder can decrypt that
 *     purpose's data) but do not let the holder reconstruct the privateKey
 *     or perform other key operations. Suitable for handing to a Profile
 *     provider that needs ONE encryption key for ONE cache.
 *   - `identity` — public Identity (mirrors `Sphere.identity`)
 *
 * The existing private signing / encryption surfaces inside Sphere,
 * `PaymentsModule`, and `CommunicationsModule` would all be migrated to
 * consume this interface in a future PR (so the boundary becomes a single
 * implementation rather than scattered private methods).
 *
 * @module profile/cryptographer
 * @see https://github.com/unicity-sphere/sphere-sdk/issues/292
 */

import type { Identity } from '../types';

/**
 * Purpose tag for `derivePurposeKey`. Used as the HKDF info string so two
 * purposes derive distinct keys even from the same root secret. Extend the
 * union as new purposes are added; the string value is the canonical
 * HKDF info parameter and MUST NOT be renamed once shipped (would break
 * forward compatibility with previously-encrypted caches).
 */
export type SphereCryptographerPurpose =
  /**
   * Encryption key for the Profile-mode local cache (used by
   * `ProfileStorageProvider` and `ProfileTokenStorageProvider`).
   * Stable since v0.6.x — Issue #292.
   */
  | 'profile-cache'
  // Future: 'orbitdb-id', 'nostr-nip17-symmetric', ...
  | string;

/**
 * The cryptographer delegate. Exposed via `Sphere.cryptographer`. Consumers
 * pass this to internal SDK modules that need to perform crypto operations
 * under the wallet key — modules MUST NEVER touch the raw `privateKey`.
 *
 * **Status (Issue #292 tactical):** Only `derivePurposeKey` is wired through
 * Profile factories today. The remaining methods are sketched here so the
 * shape is stable from the first release; a follow-up issue tracks the full
 * migration of `Sphere.signMessage`, `PaymentsModule` signing, and
 * `CommunicationsModule` encryption to consume this interface.
 */
export interface SphereCryptographer {
  /**
   * The wallet's PUBLIC identity. Same shape as `Sphere.identity`.
   * Returned by reference; callers MUST treat it as read-only.
   */
  readonly identity: Identity;

  /**
   * Derive a deterministic per-purpose key as opaque bytes. The bytes are
   * suitable for handing to a downstream module that needs a single
   * symmetric key for ONE purpose (e.g. a Profile cache's HKDF subkey).
   *
   * **Security note**: the returned bytes ARE secret-equivalent FOR THIS
   * PURPOSE. They do NOT let the holder reconstruct the wallet's
   * privateKey or derive keys for OTHER purposes (HKDF-Expand is
   * one-way). But anyone with these bytes CAN decrypt this purpose's
   * persisted data. Treat the returned `Uint8Array` like a session key:
   * keep it in memory only, do not log it, do not persist it outside
   * the consumer's own encrypted store.
   *
   * Pure function of (wallet privateKey, purpose). Two calls with the
   * same purpose return identical bytes; this is what makes the
   * Profile cache decryptable across process restarts.
   *
   * @param purpose Stable purpose tag (see {@link SphereCryptographerPurpose}).
   *                The string is the HKDF `info` parameter, so it MUST NOT
   *                be renamed once shipped — would invalidate every cache
   *                derived under the old name.
   * @returns 32-byte derived key (AES-256-ready).
   */
  derivePurposeKey(purpose: SphereCryptographerPurpose): Promise<Uint8Array>;

  // ---------------------------------------------------------------------------
  // FUTURE SURFACE — sketched here, NOT yet wired through Sphere modules.
  // See the module docstring for the migration story. Throwing `not
  // implemented` is acceptable for these methods in v0.6.x.
  // ---------------------------------------------------------------------------

  /**
   * secp256k1 ECDSA signature over the SHA-256 digest of `message`.
   *
   * @future Wired through `Sphere.signMessage` in a follow-up PR.
   */
  signMessage?(message: Uint8Array): Promise<Uint8Array>;

  /**
   * Hex-convenience wrapper for {@link signMessage}. Returns the signature
   * as `v(2) + r(64) + s(64)` hex — the format `Sphere.signMessage` already
   * returns today.
   *
   * @future Wired through `Sphere.signMessage` in a follow-up PR.
   */
  signMessageHex?(messageHex: string): Promise<string>;

  /**
   * NIP-04 / NIP-17 envelope encrypt for an arbitrary recipient pubkey.
   *
   * @future Wired through `CommunicationsModule` in a follow-up PR.
   */
  encryptForRecipient?(
    recipientPubkey: string,
    plaintext: Uint8Array,
  ): Promise<Uint8Array>;

  /**
   * Counterpart to {@link encryptForRecipient}.
   *
   * @future Wired through `CommunicationsModule` in a follow-up PR.
   */
  decryptFromSender?(
    senderPubkey: string,
    ciphertext: Uint8Array,
  ): Promise<Uint8Array>;
}

/**
 * The HKDF info string for the `profile-cache` purpose. Mirrors
 * `PROFILE_HKDF_INFO` in `profile/encryption.ts` (kept in sync — bumping
 * this here without bumping there is a silent data-loss bug). Re-exported
 * for tests that want to verify the binding.
 *
 * @internal
 */
export const PROFILE_CACHE_PURPOSE: SphereCryptographerPurpose = 'profile-cache';
