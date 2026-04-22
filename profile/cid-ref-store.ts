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

import {
  decryptProfileValue,
  encryptProfileValue,
} from './encryption.js';
import { ProfileError } from './errors.js';
import { fetchFromIpfs, pinToIpfs, verifyCidMatchesBytes } from './ipfs-client.js';

// ── CidRef envelope ───────────────────────────────────────────────────────

/** Schema version of the CidRef envelope. */
export const CID_REF_SCHEMA_VERSION = 1 as const;

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

  /** Convenience: JSON-stringify + UTF-8 encode + pin. */
  async pinJson(value: unknown, contentV?: number): Promise<CidRef> {
    const json = JSON.stringify(value);
    const bytes = new TextEncoder().encode(json);
    return this.pinBytes(bytes, contentV);
  }

  // ── Fetch primitives ────────────────────────────────────────────────────

  /**
   * Fetch encrypted blob by CID, verify content-address, decrypt, return plaintext.
   *
   * Content-verification: `verifyCidMatchesBytes` asserts that the fetched
   * bytes hash to the expected CID. Protects against a malicious / compromised
   * gateway substituting different content.
   */
  async fetchBytes(ref: CidRef): Promise<Uint8Array> {
    validateRef(ref);
    const encrypted = await fetchFromIpfs(
      [...this.#gateways],
      ref.cid,
      this.#fetchTimeoutMs,
      this.#maxFetchBytes,
    );
    // Belt-and-braces: fetchFromIpfs already verifies, but double-check here in
    // case a caller passes a gateway list that bypasses the shared path.
    verifyCidMatchesBytes(ref.cid, encrypted);
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
   * Intentionally strict: malformed refs or wrong schema versions return
   * null (read-path fallback) rather than throwing. Writers always produce
   * valid refs via `pinJson` / `pinBytes`.
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
    if (typeof r.size !== 'number' || !Number.isFinite(r.size) || r.size < 0) return null;
    if (typeof r.ts !== 'number' || !Number.isFinite(r.ts) || r.ts < 0) return null;
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
      'BUNDLE_NOT_FOUND',
      `CidRef has unknown schema version ${String(ref.v)} (expected ${CID_REF_SCHEMA_VERSION}).`,
    );
  }
  if (typeof ref.cid !== 'string' || ref.cid.length === 0) {
    throw new ProfileError('BUNDLE_NOT_FOUND', `CidRef has invalid cid "${String(ref.cid)}".`);
  }
  if (typeof ref.size !== 'number' || !Number.isFinite(ref.size) || ref.size < 0) {
    throw new ProfileError('BUNDLE_NOT_FOUND', `CidRef has invalid size ${String(ref.size)}.`);
  }
}
