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

export type OpLogEntrySchemaVersion = typeof OPLOG_ENTRY_SCHEMA_VERSION;

// ── Types ─────────────────────────────────────────────────────────────────

export interface OpLogEntryEnvelope {
  /** Schema version. Unknown versions fail-closed on decode. */
  readonly v: OpLogEntrySchemaVersion;
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
  // `@ipld/dag-cbor` encode produces deterministic output (sorted keys,
  // canonical integer encoding), matching PROFILE-OPLOG-SCHEMA.md §2.2.
  // We cast to a plain object to avoid re-encoding any accidentally
  // non-serializable getters on the input (defensive against Proxy inputs).
  const plain: Record<string, unknown> = {
    v: entry.v,
    type: entry.type,
    originated: entry.originated,
    ts: entry.ts,
    payload: entry.payload,
  };
  return cborEncode(plain);
}

// ── Decoding ──────────────────────────────────────────────────────────────

/**
 * Decode an envelope from CBOR bytes, with legacy fallback (§7).
 *
 * - If bytes are a valid envelope CBOR → return it.
 * - If bytes fail CBOR decode OR decode to something other than a
 *   versioned envelope → wrap as LEGACY entry (synthetic envelope).
 * - If bytes decode to a SHAPED envelope with v !== 1 → fail-closed
 *   with OpLogEntryCorrupt (forward-compat gate).
 */
export function decodeEntry(bytes: Uint8Array): OpLogEntryEnvelope {
  let decoded: unknown;
  try {
    decoded = cborDecode(bytes);
  } catch {
    // Not valid CBOR → legacy opaque bytes.
    return wrapLegacyEntry(bytes);
  }

  // Legacy heuristic: not an object, or missing `v` → legacy.
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    return wrapLegacyEntry(bytes);
  }
  const candidate = decoded as Record<string, unknown>;
  if (!('v' in candidate)) {
    return wrapLegacyEntry(bytes);
  }

  // Known shape — validate strictly. Forward-compat: unknown v fails closed.
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
 * Legacy entries are read-only: they are NEVER written back in this
 * form. On any subsequent write, the caller produces a fresh envelope
 * with the correct type/origin/ts.
 */
function wrapLegacyEntry(bytes: Uint8Array): OpLogEntryEnvelope {
  return {
    v: OPLOG_ENTRY_SCHEMA_VERSION,
    type: 'cache_index', // conservative default for unknown legacy
    originated: 'system',
    ts: 0,
    payload: bytes,
  };
}

// ── Validation ────────────────────────────────────────────────────────────

/**
 * Assert that a freshly-constructed envelope object has the right shape.
 * Called at encode-time to catch programmer errors at the write site.
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
  if (typeof entry.ts !== 'number' || !Number.isFinite(entry.ts) || entry.ts < 0) {
    throw new OpLogEntryCorrupt(`encodeEntry: ts must be non-negative finite number; got ${String(entry.ts)}`, {
      ts: entry.ts,
    });
  }
  if (!(entry.payload instanceof Uint8Array)) {
    throw new OpLogEntryCorrupt(`encodeEntry: payload must be Uint8Array`, {
      payloadType: typeof entry.payload,
    });
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
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts < 0) {
    throw new OpLogEntryCorrupt(`decodeEntry: invalid ts ${String(ts)}`, { ts });
  }
  const payload = rec.payload;
  if (!(payload instanceof Uint8Array)) {
    throw new OpLogEntryCorrupt(`decodeEntry: payload must be Uint8Array`, {
      payloadType: typeof payload,
    });
  }
  return {
    v: OPLOG_ENTRY_SCHEMA_VERSION,
    type: t as OpLogEntryType,
    originated: o,
    ts,
    payload,
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
  // Apply the originated-tag downgrade via the existing helper. We cast
  // through a generic Record<string, unknown> because the helper's type
  // is generic (it preserves unknown extra fields), but our envelope is
  // a closed struct — safe to re-extract the fields we know exist.
  const downgraded = downgradeForReplication(candidate as unknown as Record<string, unknown>);
  assertOriginTagReplicated(String(downgraded.type), downgraded.originated);
  return {
    v: OPLOG_ENTRY_SCHEMA_VERSION,
    type: candidate.type,
    originated: 'replicated',
    ts: candidate.ts,
    payload: candidate.payload,
  };
}

// ── Read-time introspection ───────────────────────────────────────────────

/** True if a stored value's CBOR decode suggests it is a legacy opaque entry. */
export function isLegacyEntry(entry: OpLogEntryEnvelope): boolean {
  // Synthetic legacy envelopes carry ts=0. Real envelopes have a non-zero
  // ts unless they were deliberately stamped with 0 (which callers never do).
  return entry.ts === 0;
}
