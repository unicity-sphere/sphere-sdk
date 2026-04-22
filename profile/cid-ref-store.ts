/**
 * CidRefStore — per-wallet CID-reference primitive (PROFILE-CID-REFERENCES.md §2).
 *
 * Enables OpLog values to reference IPFS-pinned content instead of inlining
 * fat data. All encryption, content-addressing, and verification is handled
 * here; callers provide plaintext bytes on pin, and receive plaintext bytes
 * on fetch.
 *
 * Serialization pattern (embedded in OpLog via ProfileStorageProvider.set):
 *   `storage.set(key, CidRefStore.stringifyRef(ref))`
 *
 * Read-side migration pattern (distinguish legacy inline from new ref):
 *   const value = await storage.get(key);
 *   const ref = CidRefStore.tryParseRef(value);
 *   if (ref) {
 *     // New path: fetch from IPFS.
 *     const data = await cidRefStore.fetchJson<T>(ref);
 *   } else {
 *     // Legacy path: inline JSON.
 *     const data = JSON.parse(value);
 *   }
 *
 * @module profile/cid-ref-store
 */

import { CID } from 'multiformats/cid';
import {
  decryptProfileValue,
  encryptProfileValue,
} from './encryption.js';
import { ProfileError } from './errors.js';
import { fetchFromIpfs, pinToIpfs } from './ipfs-client.js';

// ── CidRef envelope ───────────────────────────────────────────────────────

/** Schema version of the CidRef envelope. */
export const CID_REF_SCHEMA_VERSION = 1 as const;

/**
 * AES-256-GCM overhead: 12-byte IV + 16-byte auth tag = 28 bytes per
 * encrypted blob. `encrypted.byteLength` always equals
 * `plaintext.byteLength + 28`. Used for plaintext-size budget derivation.
 */
export const AES_GCM_OVERHEAD_BYTES = 28;

/**
 * Fetch-path tolerance around the declared `ref.size`. In the current
 * AES-GCM primitive the ciphertext length is deterministic so we could
 * match exactly, but a small tolerance accommodates future primitive
 * changes (AES-GCM-SIV, header format bump) without a schema bump.
 */
export const FETCH_SIZE_TOLERANCE_BYTES = 128;

/**
 * Reference envelope written inline in an OpLog value. Small (~100-150 bytes
 * serialized) so the OpLog entry itself remains thin.
 *
 * @see PROFILE-CID-REFERENCES.md §2
 */
export interface CidRef {
  /** Schema version — must equal CID_REF_SCHEMA_VERSION. */
  readonly v: typeof CID_REF_SCHEMA_VERSION;
  /** IPFS CID of the encrypted content. sha2-256 multihash expected. */
  readonly cid: string;
  /** Size in bytes of the encrypted blob pinned to IPFS. Used for telemetry + size-budget checks. */
  readonly size: number;
  /** Wall-clock timestamp (ms since epoch) when this ref was created. */
  readonly ts: number;
  /** Caller-supplied content-version tag for layered schema evolution. */
  readonly contentV?: number;
}

// ── Config / deps ─────────────────────────────────────────────────────────

export interface CidRefStoreOptions {
  /** IPFS gateway URLs. Same list used by ProfileTokenStorageProvider. */
  readonly gateways: string[];
  /**
   * AES-256 encryption key derived from the wallet master key. Required
   * — content stored at IPFS is always encrypted so public CIDs do not
   * leak plaintext.
   */
  readonly encryptionKey: Uint8Array;
  /**
   * Pin timeout (ms). Defaults to 60_000 — consistent with ipfs-client
   * DEFAULT_PIN_TIMEOUT_MS.
   */
  readonly pinTimeoutMs?: number;
  /**
   * Fetch timeout (ms). Defaults to 30_000 — consistent with ipfs-client
   * DEFAULT_FETCH_TIMEOUT_MS.
   */
  readonly fetchTimeoutMs?: number;
  /**
   * Maximum accepted encrypted size for a single fetched blob. Defaults
   * to 50 MiB, matching ipfs-client's default. Callers with smaller
   * domain limits can override.
   */
  readonly maxFetchBytes?: number;
  /**
   * Debug logger. When absent, errors propagate as thrown but successes
   * are silent.
   */
  readonly log?: (msg: string) => void;
}

// ── CidRefStore ───────────────────────────────────────────────────────────

export class CidRefStore {
  readonly #gateways: readonly string[];
  readonly #encryptionKey: Uint8Array;
  readonly #pinTimeoutMs: number;
  readonly #fetchTimeoutMs: number;
  readonly #maxFetchBytes: number;
  readonly #log?: (msg: string) => void;

  constructor(opts: CidRefStoreOptions) {
    if (!opts.gateways || opts.gateways.length === 0) {
      throw new ProfileError('PROFILE_NOT_INITIALIZED', 'CidRefStore: at least one IPFS gateway is required.');
    }
    if (!opts.encryptionKey || opts.encryptionKey.byteLength !== 32) {
      throw new ProfileError(
        'PROFILE_NOT_INITIALIZED',
        `CidRefStore: encryptionKey must be 32 bytes, got ${opts.encryptionKey?.byteLength ?? 0}.`,
      );
    }
    this.#gateways = [...opts.gateways];
    this.#encryptionKey = opts.encryptionKey;
    this.#pinTimeoutMs = opts.pinTimeoutMs ?? 60_000;
    this.#fetchTimeoutMs = opts.fetchTimeoutMs ?? 30_000;
    this.#maxFetchBytes = opts.maxFetchBytes ?? 50 * 1024 * 1024;
    this.#log = opts.log;
  }

  // ── Pin primitives ──────────────────────────────────────────────────────

  /**
   * Encrypt `plaintextBytes` with the wallet key, pin to IPFS, return a
   * CidRef. The CID is content-addressed over the ciphertext — the
   * plaintext never leaves the wallet.
   */
  async pinBytes(plaintextBytes: Uint8Array, contentV?: number): Promise<CidRef> {
    const encrypted = await encryptProfileValue(this.#encryptionKey, plaintextBytes);
    const cid = await pinToIpfs([...this.#gateways], encrypted, this.#pinTimeoutMs);
    const ref: CidRef = {
      v: CID_REF_SCHEMA_VERSION,
      cid,
      size: encrypted.byteLength,
      ts: Date.now(),
      ...(contentV !== undefined ? { contentV } : {}),
    };
    this.#log?.(
      `CidRefStore.pinBytes: pinned ${encrypted.byteLength} bytes to ${cid} (plaintext ${plaintextBytes.byteLength} bytes)`,
    );
    return ref;
  }

  /**
   * Convenience: JSON-stringify + UTF-8 encode + pin. Wraps the synchronous
   * JSON.stringify throw path (circular refs, BigInt) so callers see a
   * typed ProfileError at the async boundary.
   */
  async pinJson(value: unknown, contentV?: number): Promise<CidRef> {
    let json: string;
    try {
      json = JSON.stringify(value);
    } catch (err) {
      throw new ProfileError(
        'ENCRYPTION_FAILED',
        `CidRefStore.pinJson: JSON.stringify failed — value has circular ref or unserializable type (${err instanceof Error ? err.message : String(err)}).`,
        err,
      );
    }
    if (json === undefined) {
      // e.g. `undefined`, a function, or a symbol was passed at the top level.
      throw new ProfileError(
        'ENCRYPTION_FAILED',
        `CidRefStore.pinJson: value is not JSON-serializable (got undefined after stringify).`,
      );
    }
    const bytes = new TextEncoder().encode(json);
    return this.pinBytes(bytes, contentV);
  }

  // ── Fetch primitives ────────────────────────────────────────────────────

  /**
   * Fetch encrypted blob by CID, verify content-address, decrypt, return plaintext.
   *
   * Size-bounding (steelman fix): the fetch cap is `ref.size +
   * FETCH_SIZE_TOLERANCE_BYTES`, NOT the instance-wide `#maxFetchBytes`.
   * This prevents a hostile peer (via OrbitDB LWW) from crafting a
   * poisoned ref with small `size` but pointing to a huge blob — the
   * fetch aborts before 50 MiB are allocated.
   *
   * Post-fetch the exact size is asserted — an attacker who matches the
   * cap but pads the blob internally still triggers CID_REF_SIZE_MISMATCH.
   *
   * Content-verification is handled by fetchFromIpfs's internal
   * verifyCidMatchesBytes; we rely on that invariant (redundant call
   * removed per steelman — it masks regressions rather than catching them).
   */
  async fetchBytes(ref: CidRef): Promise<Uint8Array> {
    validateRef(ref);

    // Per-ref byte cap — tighter than instance-wide #maxFetchBytes.
    const perRefCap = Math.min(
      ref.size + FETCH_SIZE_TOLERANCE_BYTES,
      this.#maxFetchBytes,
    );

    // If fetchFromIpfs's internal cap aborts because content exceeds our
    // per-ref cap, translate the error code to CID_REF_SIZE_MISMATCH so
    // callers see the authentic semantic (not generic "bundle not found").
    let encrypted: Uint8Array;
    try {
      encrypted = await fetchFromIpfs(
        [...this.#gateways],
        ref.cid,
        this.#fetchTimeoutMs,
        perRefCap,
      );
    } catch (err) {
      if (
        err instanceof ProfileError &&
        err.code === 'BUNDLE_NOT_FOUND' &&
        /size limit|exceeded|\d+ bytes/i.test(err.message)
      ) {
        // fetchFromIpfs's size-limit abort. Relabel as size mismatch.
        throw new ProfileError(
          'CID_REF_SIZE_MISMATCH',
          `CidRef size cap (${perRefCap} bytes from declared ${ref.size}) exceeded ` +
            `during fetch of cid=${ref.cid}. Possible poisoned ref from LWW replication. ` +
            `Original: ${err.message}`,
          err,
        );
      }
      throw err;
    }

    // Hard size check: the declared ref.size MUST match the actual fetched
    // size within our tolerance. A mismatch means either replication
    // corruption or a poisoned ref (content equal to or smaller than cap
    // but deliberately not matching ref.size). Fail BEFORE decrypt.
    const sizeDelta = Math.abs(encrypted.byteLength - ref.size);
    if (sizeDelta > FETCH_SIZE_TOLERANCE_BYTES) {
      throw new ProfileError(
        'CID_REF_SIZE_MISMATCH',
        `CidRef declared size ${ref.size} but fetched ${encrypted.byteLength} bytes ` +
          `(delta ${sizeDelta} > tolerance ${FETCH_SIZE_TOLERANCE_BYTES}). ` +
          `Possible replication corruption or poisoned ref at cid=${ref.cid}.`,
      );
    }

    const plaintext = await decryptProfileValue(this.#encryptionKey, encrypted);
    this.#log?.(
      `CidRefStore.fetchBytes: fetched ${encrypted.byteLength} bytes from ${ref.cid} (plaintext ${plaintext.byteLength} bytes)`,
    );
    return plaintext;
  }

  /** Convenience: fetchBytes + UTF-8 decode + JSON.parse. */
  async fetchJson<T = unknown>(ref: CidRef): Promise<T> {
    const bytes = await this.fetchBytes(ref);
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json) as T;
  }

  // ── Serialization (for embedding in OpLog values) ──────────────────────

  /** JSON-stringify a ref for embedding via `StorageProvider.set(key, stringifyRef(ref))`. */
  static stringifyRef(ref: CidRef): string {
    validateRef(ref);
    return JSON.stringify(ref);
  }

  /**
   * Try to parse a stored OpLog value as a CidRef. Returns null when the
   * input is NOT a CidRef — callers use that signal to fall back to the
   * legacy inline-JSON read path (PROFILE-CID-REFERENCES.md §6).
   *
   * Intentionally strict (hardened per steelman):
   *   - `v === 1` (unknown versions fail-closed)
   *   - `cid` must parse via multiformats CID.parse (rejects arbitrary
   *     strings, legacy values that happen to have a `cid`-named field)
   *   - `size` must be finite non-negative integer
   *   - `ts` must be a plausible wall-clock value (> 0 — rejects legacy
   *     values carrying `ts: 0` as an absence marker)
   *   - `contentV` if present must be finite number
   *
   * Writers always produce valid refs via `pinJson` / `pinBytes` / `stringifyRef`.
   */
  static tryParseRef(value: string | null | undefined): CidRef | null {
    if (value == null || value === '') return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const r = parsed as Partial<CidRef>;
    if (r.v !== CID_REF_SCHEMA_VERSION) return null;
    if (typeof r.cid !== 'string' || r.cid.length === 0) return null;
    // Strict CID validation — a legacy JSON field named 'cid' with a random
    // string won't match; a real CID string will. Catches legacy false-positives.
    try {
      CID.parse(r.cid);
    } catch {
      return null;
    }
    if (typeof r.size !== 'number' || !Number.isFinite(r.size) || r.size < 0 || !Number.isInteger(r.size)) {
      return null;
    }
    // ts MUST be > 0 — real refs always carry Date.now() (>0). Legacy
    // values could happen to have a ts:0 field, so the strict positivity
    // check reduces discriminator false-positives.
    if (typeof r.ts !== 'number' || !Number.isFinite(r.ts) || r.ts <= 0 || !Number.isInteger(r.ts)) {
      return null;
    }
    if (r.contentV !== undefined && (typeof r.contentV !== 'number' || !Number.isFinite(r.contentV))) {
      return null;
    }
    return {
      v: CID_REF_SCHEMA_VERSION,
      cid: r.cid,
      size: r.size,
      ts: r.ts,
      ...(r.contentV !== undefined ? { contentV: r.contentV } : {}),
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function validateRef(ref: CidRef): void {
  if (ref.v !== CID_REF_SCHEMA_VERSION) {
    throw new ProfileError(
      'CID_REF_CORRUPT',
      `CidRef has unknown schema version ${String(ref.v)} (expected ${CID_REF_SCHEMA_VERSION}).`,
    );
  }
  if (typeof ref.cid !== 'string' || ref.cid.length === 0) {
    throw new ProfileError('CID_REF_CORRUPT', `CidRef has invalid cid "${String(ref.cid)}".`);
  }
  try {
    CID.parse(ref.cid);
  } catch (err) {
    throw new ProfileError(
      'CID_REF_CORRUPT',
      `CidRef has unparseable cid "${ref.cid}": ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  if (typeof ref.size !== 'number' || !Number.isFinite(ref.size) || ref.size < 0) {
    throw new ProfileError('CID_REF_CORRUPT', `CidRef has invalid size ${String(ref.size)}.`);
  }
}
