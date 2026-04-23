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
  /** IPFS CID of the pinned content. sha2-256 multihash expected. */
  readonly cid: string;
  /** Size in bytes of the blob pinned to IPFS. Used for telemetry + size-budget checks. */
  readonly size: number;
  /** Wall-clock timestamp (ms since epoch) when this ref was created. */
  readonly ts: number;
  /** Caller-supplied content-version tag for layered schema evolution. */
  readonly contentV?: number;
  /**
   * When false, the pinned bytes are plaintext (unencrypted). When absent
   * or true, the pinned bytes are AES-GCM ciphertext using the wallet's
   * encryption key — the default, matches every pre-existing CidRef.
   *
   * Rationale for the plaintext mode: for content whose transit privacy
   * is already bounded by another layer (e.g., NIP-29 group-chat messages
   * flow through a relay as plaintext — see PROFILE-CID-REFERENCES.md §8.5
   * and the module-level discussion in GroupChatModule), encryption per
   * wallet defeats IPFS content-addressed dedup without adding any
   * realistic privacy. Setting `enc: false` makes the CID a global
   * dedup key across all wallets that store the same content.
   *
   * The field is self-describing — fetch decrypts iff `enc !== false`,
   * so a caller that switches modes between write and read can't
   * silently corrupt.
   */
  readonly enc?: boolean;
}

/**
 * Options bag for pin operations. Supersedes the prior
 * `pinBytes(bytes, contentV?)` positional signature (no in-tree caller
 * passed contentV positionally as of commit 5cdeae6).
 */
export interface PinOptions {
  /** Caller-supplied content-version tag for schema evolution. */
  readonly contentV?: number;
  /**
   * Default true (AES-GCM encrypt before pinning). Set false to pin
   * plaintext bytes — enables IPFS content-dedup across wallets. ONLY
   * use for content whose transit privacy is already public (e.g.,
   * NIP-29 group-chat messages). See the `CidRef.enc` doc for rationale.
   */
  readonly encrypted?: boolean;
}

/**
 * Options bag for fetch operations. Callers with strict encryption
 * policies (every in-tree caller except group-chat-messages) should
 * set `requireEncrypted: true` so a hostile ref claiming `enc: false`
 * cannot trick the fetch path into returning attacker-controlled
 * plaintext as if it were the legitimate ciphertext payload.
 */
export interface FetchOptions {
  /**
   * When true, reject refs whose `enc === false` with CID_REF_CORRUPT.
   * Defense-in-depth: OrbitDB origin-tag validation at a higher layer
   * is the primary defense, but a caller who KNOWS their protocol
   * produces only encrypted refs should enforce that at every fetch
   * boundary. Default false (honor whatever the ref says).
   *
   * Symmetric opposite (`requirePlaintext`) is intentionally not
   * provided — a ref's `enc` field is a declaration, not a request,
   * and rejecting encrypted content serves no real threat model.
   */
  readonly requireEncrypted?: boolean;
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
   * Pin `plaintextBytes` to IPFS. By default the bytes are AES-GCM
   * encrypted first — the CID is content-addressed over the ciphertext
   * and the plaintext never leaves the wallet.
   *
   * Pass `{ encrypted: false }` to pin the plaintext directly. The CID
   * then becomes a global dedup key across wallets. Use ONLY for content
   * whose transit privacy is already public (see `CidRef.enc`).
   */
  async pinBytes(plaintextBytes: Uint8Array, opts?: PinOptions): Promise<CidRef> {
    const encryptedMode = opts?.encrypted ?? true;
    const bytesToPin = encryptedMode
      ? await encryptProfileValue(this.#encryptionKey, plaintextBytes)
      : plaintextBytes;
    const cid = await pinToIpfs([...this.#gateways], bytesToPin, this.#pinTimeoutMs);
    const ref: CidRef = {
      v: CID_REF_SCHEMA_VERSION,
      cid,
      size: bytesToPin.byteLength,
      ts: Date.now(),
      ...(opts?.contentV !== undefined ? { contentV: opts.contentV } : {}),
      // Only serialize `enc` when it's NON-default (false). Keeps every
      // pre-existing ref envelope byte-identical — the flag's absence
      // means "encrypted" per backward-compat rule.
      ...(!encryptedMode ? { enc: false as const } : {}),
    };
    this.#log?.(
      `CidRefStore.pinBytes: pinned ${bytesToPin.byteLength} bytes to ${cid} ` +
        `(plaintext ${plaintextBytes.byteLength} bytes, encrypted=${encryptedMode})`,
    );
    return ref;
  }

  /**
   * Convenience: JSON-stringify + UTF-8 encode + pin. Wraps the synchronous
   * JSON.stringify throw path (circular refs, BigInt) so callers see a
   * typed ProfileError at the async boundary.
   *
   * Options are forwarded to `pinBytes` — pass `{ encrypted: false }` for
   * plaintext pins (see CidRef.enc).
   */
  async pinJson(value: unknown, opts?: PinOptions): Promise<CidRef> {
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
    return this.pinBytes(bytes, opts);
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
  async fetchBytes(ref: CidRef, opts?: FetchOptions): Promise<Uint8Array> {
    validateRef(ref);

    // Defense-in-depth: callers whose protocol produces only encrypted
    // refs should demand that at fetch time. A hostile peer who smuggles
    // an `enc:false` ref past origin-tag validation would otherwise get
    // attacker-controlled plaintext treated as legitimate content.
    if (opts?.requireEncrypted && ref.enc === false) {
      throw new ProfileError(
        'CID_REF_CORRUPT',
        `CidRef declares enc=false but caller required encrypted mode — ` +
          `possible poisoned ref at cid=${ref.cid}. Refusing to fetch.`,
      );
    }

    // Per-ref byte cap — tighter than instance-wide #maxFetchBytes.
    const perRefCap = Math.min(
      ref.size + FETCH_SIZE_TOLERANCE_BYTES,
      this.#maxFetchBytes,
    );

    // If fetchFromIpfs's internal cap aborts because content exceeds our
    // per-ref cap, translate the error code to CID_REF_SIZE_MISMATCH so
    // callers see the authentic semantic (not generic "bundle not found").
    let fetched: Uint8Array;
    try {
      fetched = await fetchFromIpfs(
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
    const sizeDelta = Math.abs(fetched.byteLength - ref.size);
    if (sizeDelta > FETCH_SIZE_TOLERANCE_BYTES) {
      throw new ProfileError(
        'CID_REF_SIZE_MISMATCH',
        `CidRef declared size ${ref.size} but fetched ${fetched.byteLength} bytes ` +
          `(delta ${sizeDelta} > tolerance ${FETCH_SIZE_TOLERANCE_BYTES}). ` +
          `Possible replication corruption or poisoned ref at cid=${ref.cid}.`,
      );
    }

    // Self-describing encryption: `ref.enc === false` means the pinned
    // content is plaintext; absent or true → AES-GCM ciphertext. Backward
    // compat: all pre-#98b refs have no `enc` field and are encrypted.
    const isEncrypted = ref.enc !== false;
    if (!isEncrypted) {
      this.#log?.(
        `CidRefStore.fetchBytes: fetched ${fetched.byteLength} plaintext bytes from ${ref.cid} (enc=false)`,
      );
      return fetched;
    }

    const plaintext = await decryptProfileValue(this.#encryptionKey, fetched);
    this.#log?.(
      `CidRefStore.fetchBytes: fetched ${fetched.byteLength} bytes from ${ref.cid} (plaintext ${plaintext.byteLength} bytes)`,
    );
    return plaintext;
  }

  /** Convenience: fetchBytes + UTF-8 decode + JSON.parse. */
  async fetchJson<T = unknown>(ref: CidRef, opts?: FetchOptions): Promise<T> {
    const bytes = await this.fetchBytes(ref, opts);
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
    // `enc` is optional; when present must be a boolean. Any other shape
    // is either corruption or a legacy collision — fail-closed.
    if (r.enc !== undefined && typeof r.enc !== 'boolean') {
      return null;
    }
    return {
      v: CID_REF_SCHEMA_VERSION,
      cid: r.cid,
      size: r.size,
      ts: r.ts,
      ...(r.contentV !== undefined ? { contentV: r.contentV } : {}),
      ...(r.enc !== undefined ? { enc: r.enc } : {}),
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
