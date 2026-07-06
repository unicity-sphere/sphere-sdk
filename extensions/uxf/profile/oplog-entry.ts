/**
 * OpLog entry envelope (PROFILE-OPLOG-SCHEMA.md §2).
 *
 * Every value written to OrbitDB's keyvalue store is a CBOR-encoded
 * `OpLogEntryEnvelope`. The envelope carries:
 *
 *   - schema version (`v`)
 *   - entry type (user action or system type — see originated-tag.ts)
 *   - originated tag (who wrote it: user | system | replicated)
 *   - wall-clock timestamp
 *   - application payload (opaque bytes, may itself be encrypted)
 *
 * The envelope metadata is plaintext; only `payload` is encrypted. This
 * lets replication-edge validation + type-filtered indexing run without
 * key access. See PROFILE-OPLOG-SCHEMA.md §3 for the threat model.
 *
 * Legacy compatibility: wallets created before this schema shipped have
 * raw `Uint8Array` values (not CBOR envelopes). `decodeEntry` detects
 * these and wraps them in a synthetic envelope (§7). Legacy entries are
 * never written back — the OpLog migrates through normal write activity.
 */

import { decode as cborDecode, encode as cborEncode } from '@ipld/dag-cbor';

import type {
  OpLogEntryType,
  OriginTag,
} from './aggregator-pointer/originated-tag.js';
import {
  ALL_ENTRY_TYPES,
  assertOriginTagLocal,
  assertOriginTagReplicated,
  downgradeForReplication,
} from './aggregator-pointer/originated-tag.js';

// ── Schema version ────────────────────────────────────────────────────────

/** Current envelope schema version. Bumped on breaking changes. */
export const OPLOG_ENTRY_SCHEMA_VERSION = 1 as const;

/**
 * Sentinel version for synthetic envelopes wrapping pre-schema legacy
 * opaque bytes. Never written to durable storage by encodeEntry; used
 * only to distinguish "this envelope was synthesized at read time from
 * raw legacy bytes" from "this envelope was authentically written in v1".
 */
export const OPLOG_ENTRY_LEGACY_VERSION = 0 as const;

export type OpLogEntrySchemaVersion = typeof OPLOG_ENTRY_SCHEMA_VERSION;

// ── Input guards ──────────────────────────────────────────────────────────

/**
 * Hard cap on total envelope bytes accepted from untrusted sources
 * (replication ingress, legacy storage read). Envelopes carry metadata
 * + one encrypted payload; there is no legitimate MB-scale case. A
 * hostile peer who writes a 4 GB-declared byte-string would otherwise
 * trigger a decoder allocation that crashes the process (remote DoS).
 */
export const MAX_ENVELOPE_BYTES = 256 * 1024; // 256 KiB

/**
 * Hard cap on the payload field after decode. Complements the envelope
 * cap: a smaller envelope could still declare a plausibly-large payload.
 */
export const MAX_PAYLOAD_BYTES = 128 * 1024; // 128 KiB

/** Known envelope field set (strict — extra fields rejected on decode). */
const KNOWN_ENVELOPE_FIELDS = new Set(['v', 'type', 'originated', 'ts', 'payload']);

/**
 * Minimum plausible ts value — 2020-01-01 UTC in ms. Anything below is
 * treated as a programmer bug or legacy indicator (the legacy wrapper
 * uses ts=0; real wallets started writing in 2024+).
 */
const MIN_PLAUSIBLE_TS = 1577836800000;

// ── Types ─────────────────────────────────────────────────────────────────

export interface OpLogEntryEnvelope {
  /**
   * Schema version.
   *   1 = current format (produced by encodeEntry).
   *   0 = synthetic legacy wrapper (produced only by wrapLegacyEntry on read).
   *   Unknown = fail-closed on decode.
   */
  readonly v: OpLogEntrySchemaVersion | typeof OPLOG_ENTRY_LEGACY_VERSION;
  /** Entry classification (user action or system type). */
  readonly type: OpLogEntryType;
  /** Origin: 'user' | 'system' | 'replicated'. */
  readonly originated: OriginTag;
  /** Wall-clock timestamp of the ORIGINATING write (ms since epoch). */
  readonly ts: number;
  /** Opaque application payload (may itself be encrypted). */
  readonly payload: Uint8Array;
}

// ── Errors ────────────────────────────────────────────────────────────────

/**
 * Error thrown when a stored value cannot be parsed as a valid OpLog
 * entry envelope. Distinct from originated-tag errors so callers can
 * distinguish "bad wire format" from "bad origin claim".
 */
export class OpLogEntryCorrupt extends Error {
  public readonly name = 'OpLogEntryCorrupt';
  public readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.details = details;
  }
}

// ── Encoding ──────────────────────────────────────────────────────────────

/**
 * Encode an envelope to deterministic CBOR bytes.
 *
 * The envelope is validated before encoding — missing/invalid fields
 * throw OpLogEntryCorrupt so the caller catches malformed constructs
 * at the write site rather than on replay.
 */
export function encodeEntry(entry: OpLogEntryEnvelope): Uint8Array {
  validateEnvelopeShape(entry);
  // Never persist the legacy sentinel v=0 — that shape is only synthesized
  // at read time for pre-schema bytes.
  if (entry.v !== OPLOG_ENTRY_SCHEMA_VERSION) {
    throw new OpLogEntryCorrupt(
      `encodeEntry: refusing to encode synthetic legacy envelope (v=${entry.v}).`,
      { v: entry.v },
    );
  }
  // `@ipld/dag-cbor` encode produces deterministic output (sorted keys,
  // canonical integer encoding), matching PROFILE-OPLOG-SCHEMA.md §2.2.
  // Defensive copy of payload prevents aliasing: if the caller mutates
  // the source Uint8Array after encodeEntry returns, encoded bytes are
  // already serialized (CBOR encode copies), but the envelope object
  // reference could be held by test code — copy to isolate.
  const plain: Record<string, unknown> = {
    v: entry.v,
    type: entry.type,
    originated: entry.originated,
    ts: entry.ts,
    payload: new Uint8Array(entry.payload),
  };
  const bytes = cborEncode(plain);
  // Guard against the (pathological but possible) case where a huge
  // payload produces an envelope exceeding our own read-side cap.
  if (bytes.byteLength > MAX_ENVELOPE_BYTES) {
    throw new OpLogEntryCorrupt(
      `encodeEntry: encoded envelope ${bytes.byteLength} bytes exceeds MAX_ENVELOPE_BYTES=${MAX_ENVELOPE_BYTES}`,
      { envelopeBytes: bytes.byteLength },
    );
  }
  return bytes;
}

// ── Decoding ──────────────────────────────────────────────────────────────

/**
 * Decode an envelope from CBOR bytes, with STRICT legacy fallback (§7).
 *
 * Legacy detection is narrow to prevent peer-crafted forgery:
 *   - Bytes exceed MAX_ENVELOPE_BYTES → fail-closed (DoS guard).
 *   - CBOR decode throws → fail-closed, NOT legacy fallback.
 *     Pre-schema OrbitDB always produced valid CBOR (raw bytes were
 *     stored as CBOR byte-strings). A CBOR decode failure is either
 *     corruption or hostile input, not legacy.
 *   - Decode yields a Uint8Array (CBOR byte-string) → legacy wrap.
 *     This is the ONE authentic pre-schema signature.
 *   - Decode yields an object with the expected envelope shape → validate.
 *   - Anything else → fail-closed.
 *
 * Forward-compat: unknown `v` fails closed.
 */
export function decodeEntry(bytes: Uint8Array): OpLogEntryEnvelope {
  // DoS guard: refuse outsized inputs before decoder allocation.
  if (bytes.byteLength > MAX_ENVELOPE_BYTES) {
    throw new OpLogEntryCorrupt(
      `OpLog entry input ${bytes.byteLength} bytes exceeds MAX_ENVELOPE_BYTES=${MAX_ENVELOPE_BYTES}.`,
      { inputBytes: bytes.byteLength },
    );
  }

  let decoded: unknown;
  try {
    decoded = cborDecode(bytes);
  } catch (err) {
    // Fail-closed: a hostile peer could produce arbitrary non-CBOR bytes
    // and be promoted to an "authentic system entry" if we fell back to
    // legacy wrap here. The legacy path accepts ONLY valid CBOR
    // byte-strings (the actual pre-schema wire format).
    throw new OpLogEntryCorrupt(
      `OpLog entry CBOR decode failed: ${err instanceof Error ? err.message : String(err)}`,
      { cborError: true },
    );
  }

  // Authentic legacy: pre-schema OrbitDB keyvalue stored a raw Uint8Array
  // which IPLD-CBOR-encodes to a byte-string type. Decoded shape = Uint8Array.
  if (decoded instanceof Uint8Array) {
    return wrapLegacyEntry(decoded);
  }

  // Everything else requires a fully-shaped envelope object.
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new OpLogEntryCorrupt(
      `OpLog entry decoded to unexpected shape ${Array.isArray(decoded) ? 'array' : typeof decoded}.`,
      { decodedKind: Array.isArray(decoded) ? 'array' : typeof decoded },
    );
  }
  const candidate = decoded as Record<string, unknown>;

  // Reject extra fields (strict shape) — limits attack surface for future
  // additions and prevents smuggling of unknown metadata.
  for (const key of Object.keys(candidate)) {
    if (!KNOWN_ENVELOPE_FIELDS.has(key)) {
      throw new OpLogEntryCorrupt(
        `OpLog entry has unexpected field "${key}"; envelope must carry only ${Array.from(KNOWN_ENVELOPE_FIELDS).join(', ')}.`,
        { unexpectedField: key },
      );
    }
  }

  // Forward-compat: unknown v fails closed.
  if (candidate.v !== OPLOG_ENTRY_SCHEMA_VERSION) {
    throw new OpLogEntryCorrupt(
      `OpLog entry has unknown schema version ${String(candidate.v)} (expected ${OPLOG_ENTRY_SCHEMA_VERSION}).`,
      { v: candidate.v },
    );
  }

  return validateDecodedEnvelope(candidate);
}

/**
 * Wrap legacy opaque bytes in a synthetic envelope (§7.1).
 *
 * STRICT detection (§7.2 v2): legacy entries carry the sentinel version
 * `OPLOG_ENTRY_LEGACY_VERSION = 0`. This distinguishes synthetic wrappers
 * from authentic v1 writes. Any code path that needs to reject legacy
 * entries (e.g., replication ingress post-migration) can gate on `v === 0`.
 *
 * Legacy entries are read-only: they are NEVER written back in this
 * form. `encodeEntry` refuses `v === 0`. On any subsequent write, the
 * caller produces a fresh envelope with the correct type/origin/ts.
 */
function wrapLegacyEntry(bytes: Uint8Array): OpLogEntryEnvelope {
  return {
    v: OPLOG_ENTRY_LEGACY_VERSION,
    type: 'cache_index', // nominal classification; `v === 0` is the actual legacy marker
    originated: 'system',
    ts: 0,
    // Defensive copy so callers cannot mutate the OrbitDB-decoded buffer.
    payload: new Uint8Array(bytes),
  };
}

// ── Validation ────────────────────────────────────────────────────────────

/**
 * Assert that a freshly-constructed envelope object has the right shape.
 * Called at encode-time to catch programmer errors at the write site.
 *
 * Strict ts check: real wallets write ts >= MIN_PLAUSIBLE_TS (2020-01-01).
 * ts=0 is the legacy sentinel and rejected here; encodeEntry then
 * additionally refuses v !== 1 to prevent writing synthetic wrappers.
 */
function validateEnvelopeShape(entry: OpLogEntryEnvelope): void {
  if (entry.v !== OPLOG_ENTRY_SCHEMA_VERSION) {
    throw new OpLogEntryCorrupt(
      `encodeEntry: envelope must have v=${OPLOG_ENTRY_SCHEMA_VERSION}; got ${String(entry.v)}`,
      { v: entry.v },
    );
  }
  if (typeof entry.type !== 'string' || !ALL_ENTRY_TYPES.includes(entry.type as OpLogEntryType)) {
    throw new OpLogEntryCorrupt(`encodeEntry: invalid type "${String(entry.type)}"`, { type: entry.type });
  }
  if (entry.originated !== 'user' && entry.originated !== 'system' && entry.originated !== 'replicated') {
    throw new OpLogEntryCorrupt(
      `encodeEntry: invalid originated "${String(entry.originated)}"`,
      { originated: entry.originated },
    );
  }
  if (
    typeof entry.ts !== 'number' ||
    !Number.isFinite(entry.ts) ||
    !Number.isInteger(entry.ts) ||
    entry.ts < MIN_PLAUSIBLE_TS
  ) {
    throw new OpLogEntryCorrupt(
      `encodeEntry: ts must be integer >= ${MIN_PLAUSIBLE_TS} (2020-01-01); got ${String(entry.ts)}`,
      { ts: entry.ts, minPlausible: MIN_PLAUSIBLE_TS },
    );
  }
  if (!(entry.payload instanceof Uint8Array)) {
    throw new OpLogEntryCorrupt(`encodeEntry: payload must be Uint8Array`, {
      payloadType: typeof entry.payload,
    });
  }
  if (entry.payload.byteLength > MAX_PAYLOAD_BYTES) {
    throw new OpLogEntryCorrupt(
      `encodeEntry: payload ${entry.payload.byteLength} bytes exceeds MAX_PAYLOAD_BYTES=${MAX_PAYLOAD_BYTES}`,
      { payloadBytes: entry.payload.byteLength },
    );
  }
}

/**
 * Validate a freshly-decoded candidate envelope (structure came from CBOR,
 * fields need runtime type-checks). Throws OpLogEntryCorrupt on any shape
 * violation.
 */
function validateDecodedEnvelope(rec: Record<string, unknown>): OpLogEntryEnvelope {
  const t = rec.type;
  if (typeof t !== 'string' || !ALL_ENTRY_TYPES.includes(t as OpLogEntryType)) {
    throw new OpLogEntryCorrupt(`decodeEntry: invalid type "${String(t)}"`, { type: t });
  }
  const o = rec.originated;
  if (o !== 'user' && o !== 'system' && o !== 'replicated') {
    throw new OpLogEntryCorrupt(`decodeEntry: invalid originated "${String(o)}"`, { originated: o });
  }
  const ts = rec.ts;
  // Real envelopes carry ts >= MIN_PLAUSIBLE_TS. ts <= 0 is reserved for
  // the legacy sentinel (handled via v=0 path, not reached here). A real
  // entry with ts < MIN_PLAUSIBLE_TS is a programmer bug or tamper.
  if (
    typeof ts !== 'number' ||
    !Number.isFinite(ts) ||
    !Number.isInteger(ts) ||
    ts < MIN_PLAUSIBLE_TS
  ) {
    throw new OpLogEntryCorrupt(`decodeEntry: invalid ts ${String(ts)} (must be integer >= ${MIN_PLAUSIBLE_TS})`, { ts });
  }
  const payload = rec.payload;
  if (!(payload instanceof Uint8Array)) {
    throw new OpLogEntryCorrupt(`decodeEntry: payload must be Uint8Array`, {
      payloadType: typeof payload,
    });
  }
  if (payload.byteLength > MAX_PAYLOAD_BYTES) {
    throw new OpLogEntryCorrupt(
      `decodeEntry: payload ${payload.byteLength} bytes exceeds MAX_PAYLOAD_BYTES=${MAX_PAYLOAD_BYTES}`,
      { payloadBytes: payload.byteLength },
    );
  }
  return {
    v: OPLOG_ENTRY_SCHEMA_VERSION,
    type: t as OpLogEntryType,
    originated: o,
    ts,
    // Defensive copy: `@ipld/dag-cbor` may return a Uint8Array that
    // aliases the input buffer. Caller-side mutation (e.g., zeroization
    // after decryption) would otherwise corrupt OrbitDB's internal state.
    payload: new Uint8Array(payload),
  };
}

// ── Write-side helpers ────────────────────────────────────────────────────

/**
 * Construct an envelope for a LOCAL write (originated = 'user' or 'system').
 *
 * Validates that the (type, originated) pair is coherent per §10.2.3 D5
 * (user types require 'user', system types require 'system'). Throws
 * SECURITY_ORIGIN_MISMATCH from `assertOriginTagLocal` on violation.
 */
export function buildLocalEntry(params: {
  type: OpLogEntryType;
  originated: 'user' | 'system';
  payload: Uint8Array;
  ts?: number;
}): OpLogEntryEnvelope {
  assertOriginTagLocal(params.type, params.originated);
  return {
    v: OPLOG_ENTRY_SCHEMA_VERSION,
    type: params.type,
    originated: params.originated,
    ts: params.ts ?? Date.now(),
    payload: params.payload,
  };
}

// ── Replication-ingress helpers ───────────────────────────────────────────

/**
 * Decode a replicated entry and downgrade its `originated` tag to
 * 'replicated' (§5.2). Validates post-downgrade via
 * `assertOriginTagReplicated`. Throws SECURITY_ORIGIN_MISMATCH on any
 * forgery attempt or unknown type.
 *
 * This is the authenticated choke point for all incoming replicated data.
 * Peer claims of `originated: 'user'` are OVERWRITTEN — the local client
 * only treats writes authored by ITS OWN local code as 'user'.
 */
export function decodeAndDowngradeReplicated(bytes: Uint8Array): OpLogEntryEnvelope {
  const candidate = decodeEntry(bytes);

  // Legacy entries arriving at the replication edge are a protocol
  // violation: legacy format is strictly local (synthesized from pre-
  // schema bytes stored on THIS device). A peer should never be able
  // to deliver bytes that decode to v=0. Reject.
  if (candidate.v === OPLOG_ENTRY_LEGACY_VERSION) {
    throw new OpLogEntryCorrupt(
      `Replication ingress rejected legacy-shaped envelope (v=0); peers cannot deliver pre-schema bytes.`,
      { v: candidate.v },
    );
  }

  // Apply the originated-tag downgrade via the existing helper. Build
  // from the downgraded struct (not the original candidate) so future
  // downgrade side-effects beyond `originated` propagate correctly.
  const downgraded = downgradeForReplication(candidate as unknown as Record<string, unknown>);
  assertOriginTagReplicated(String(downgraded.type), downgraded.originated);
  return {
    v: OPLOG_ENTRY_SCHEMA_VERSION,
    type: (downgraded.type ?? candidate.type) as OpLogEntryType,
    originated: 'replicated',
    ts: typeof downgraded.ts === 'number' ? (downgraded.ts as number) : candidate.ts,
    payload: (downgraded.payload instanceof Uint8Array
      ? downgraded.payload
      : candidate.payload) as Uint8Array,
  };
}

// ── Read-time introspection ───────────────────────────────────────────────

/**
 * True iff this envelope was synthesized by `wrapLegacyEntry` at read time
 * for pre-schema raw bytes. Discriminator: the `v === 0` sentinel version.
 * Unlike the prior ts-based heuristic, this is attacker-resistant — a peer
 * cannot forge v=0 (encodeEntry refuses it) and a legitimate entry cannot
 * accidentally match (validateEnvelopeShape requires v=1).
 */
export function isLegacyEntry(entry: OpLogEntryEnvelope): boolean {
  return entry.v === OPLOG_ENTRY_LEGACY_VERSION;
}
