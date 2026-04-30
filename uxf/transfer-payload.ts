/**
 * UXF Inter-Wallet Transfer — wire-format encode/decode helpers (T.1.D).
 *
 * Bridges between in-memory {@link UxfTransferPayload} values (from
 * `types/uxf-transfer.ts`) and the JSON byte string published as Nostr
 * `TOKEN_TRANSFER` event content. The encoder is byte-deterministic so
 * tooling can hash/cache envelopes; the decoder is paranoid against any
 * malformed input shape.
 *
 * Spec references:
 *  - §3.1   Envelope JSON shape (kind/version/mode/bundleCid/...).
 *  - §3.2   `kind: 'uxf-car'` — inline CAR via base64.
 *  - §3.3   `kind: 'uxf-cid'` — CID-by-reference.
 *  - §3.3.1 Per-call delivery overrides (clamp behavior in `limits.ts`).
 *  - §3.4   Legacy wire shapes (TXF, V6, V5/V4, SDK) — pass-through.
 *  - §5.0   Concurrency — decoders MUST NOT block; throw or return.
 *
 * **Boundary with `pkg.verify()` (T.3.A)**: the encoder DOES NOT compute
 * a CAR-root-CID match check (`bundleCid === extractCarRootCid(carBytes)`)
 * because (a) the encoder accepts a pre-built `UxfTransferPayload` value
 * whose authoring layer is responsible for that consistency, and (b)
 * cryptographic verification of CAR contents is uniformly delegated to
 * `pkg.verify()`. Callers that need the consistency check explicitly
 * MUST run `extractCarRootCid` themselves and cross-reference.
 *
 * @packageDocumentation
 */

import { CarReader } from '@ipld/car';
import { Buffer } from 'buffer';

import { SphereError } from '../core/errors.js';
import {
  isUxfTransferPayload,
  isUxfTransferPayloadCar,
  isUxfTransferPayloadCid,
  type LegacyTokenTransferPayload,
  type UxfTransferPayload,
  type UxfTransferPayloadCar,
  type UxfTransferPayloadCid,
} from '../types/uxf-transfer.js';

// =============================================================================
// 1. Public API — encodeTransferPayload
// =============================================================================

/**
 * Serialize a {@link UxfTransferPayload} to its canonical Nostr-content
 * JSON form (§3.1).
 *
 * **Determinism**. Object keys are emitted in a fixed canonical order —
 * not alphabetical, but the order specified by §3.1 (kind, version, mode,
 * bundleCid, tokenIds, memo, sender, then kind-specific fields). This
 * matches the spec's example, makes the on-the-wire diff readable, and
 * gives byte-equal output for byte-equal inputs across runs and across
 * Node engines.
 *
 * Legacy payloads are pass-through: the function recognizes them
 * structurally via the absence of `kind` and serializes them with a
 * recursive deterministic re-keying so two equivalent legacy payloads
 * produce the same wire bytes.
 *
 * @param payload The fully-formed payload to serialize. The caller is
 *                responsible for upstream consistency (e.g.,
 *                `bundleCid === extractCarRootCid(carBytes)`).
 * @returns Canonical JSON string ready for transport.
 *
 * @throws {SphereError} `BUNDLE_REJECTED_MALFORMED_ENVELOPE` if the input
 *         fails {@link isUxfTransferPayload} — the encoder refuses to
 *         emit a structurally-invalid envelope (defense-in-depth against
 *         a bug upstream).
 */
export function encodeTransferPayload(payload: UxfTransferPayload): string {
  if (!isUxfTransferPayload(payload)) {
    throw new SphereError(
      'encodeTransferPayload: payload failed structural validation',
      'BUNDLE_REJECTED_MALFORMED_ENVELOPE',
    );
  }
  const ordered = orderForSerialization(payload);
  return JSON.stringify(ordered);
}

// =============================================================================
// 2. Public API — decodeTransferPayload
// =============================================================================

/**
 * Parse a Nostr `TOKEN_TRANSFER` content string into a typed
 * {@link UxfTransferPayload}.
 *
 * The input MUST be the JSON document AFTER the transport layer has
 * stripped the legacy `token_transfer:` content prefix (NIP-04 / nostr-
 * js-sdk compat — handled by `NostrTransportProvider.stripContentPrefix`).
 * This function does NOT strip prefixes itself; see
 * {@link decodeNostrEventContent} for the prefix-aware variant.
 *
 * **Validation**. Every failure mode collapses to a single error code
 * (`BUNDLE_REJECTED_MALFORMED_ENVELOPE`) so callers don't have to
 * disambiguate parse-error from shape-error from missing-field. The
 * structural guard {@link isUxfTransferPayload} is the source of truth.
 *
 * @param content The decrypted Nostr-event content string.
 * @returns A typed {@link UxfTransferPayload}.
 *
 * @throws {SphereError} `BUNDLE_REJECTED_MALFORMED_ENVELOPE` on any
 *         failure mode (non-JSON, wrong type, missing fields, unknown
 *         kind, wrong version literal, ...).
 */
/**
 * Hard upper bound on the post-decrypt Nostr event content length before
 * `JSON.parse` runs. Defends against a hostile relay sending a 64 MiB
 * "valid JSON" event whose JSON parsing would allocate the full string
 * AND the parsed AST before any size-aware downstream check could fire.
 *
 * Sized at 8 MiB = `RELAY_SAFE_CAP_BYTES (96 KiB)` × generous slack for
 * future protocol growth. Larger than the inline-CAR cap (16 KiB) by
 * orders of magnitude, so legitimate inline payloads are unaffected.
 * CID-mode payloads are tiny (<1 KiB) so trivially under cap.
 */
const MAX_DECODE_CONTENT_BYTES = 8 * 1024 * 1024;

export function decodeTransferPayload(content: string): UxfTransferPayload {
  // Steelman fix: bound input size BEFORE JSON.parse to prevent a hostile
  // relay from triggering OOM via oversized event content. JS string
  // length is UTF-16 code units, but the byte cost of JSON.parse +
  // resulting AST is at least linear in length — so a length-based cap
  // suffices.
  if (content.length > MAX_DECODE_CONTENT_BYTES) {
    throw new SphereError(
      `decodeTransferPayload: content length ${content.length} exceeds MAX_DECODE_CONTENT_BYTES=${MAX_DECODE_CONTENT_BYTES}`,
      'BUNDLE_REJECTED_MALFORMED_ENVELOPE',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (cause) {
    throw new SphereError(
      'decodeTransferPayload: input is not valid JSON',
      'BUNDLE_REJECTED_MALFORMED_ENVELOPE',
      cause,
    );
  }
  if (!isUxfTransferPayload(parsed)) {
    throw new SphereError(
      'decodeTransferPayload: payload failed structural validation',
      'BUNDLE_REJECTED_MALFORMED_ENVELOPE',
    );
  }
  return parsed;
}

/**
 * Convenience wrapper around {@link decodeTransferPayload} for callers
 * that hold a raw Nostr event content string. Currently a thin alias —
 * `NostrTransportProvider.decryptContent()` already strips the
 * `token_transfer:` content prefix BEFORE handing the payload to
 * downstream code, so by the time decoder code runs, the input is plain
 * JSON. This wrapper exists so future revisions can introduce an outer
 * envelope (signed wrapper, NIP-44 metadata, ...) without touching every
 * call site — only this function's body changes.
 *
 * @see decodeTransferPayload
 */
export function decodeNostrEventContent(eventContent: string): UxfTransferPayload {
  return decodeTransferPayload(eventContent);
}

// =============================================================================
// 3. Public API — extractCarRootCid
// =============================================================================

/**
 * Parse `carBytes` as a CARv1 file and return its single root CID as a
 * CIDv1 base32 string (multibase prefix `b`).
 *
 * **Hard rule**: single-root only. Multi-root CARs are explicitly
 * rejected per Wave G.5 / §5.2 #1. Empty-roots CARs are also rejected
 * (the protocol is strict about the canonical bundle identity binding
 * to exactly one root).
 *
 * @param carBytes Raw CARv1 bytes (header + at least one block).
 * @returns The root CID as a CIDv1 base32 string (e.g.,
 *          `bafy2bzace...`).
 *
 * @throws {SphereError} `BUNDLE_REJECTED_INVALID_CAR` if the bytes don't
 *         parse as a CAR (truncated, malformed varints, unknown framing).
 * @throws {SphereError} `BUNDLE_REJECTED_MULTI_ROOT` if the CAR has zero
 *         or more than one root.
 */
export async function extractCarRootCid(
  carBytes: Uint8Array,
): Promise<string> {
  let reader: CarReader;
  try {
    reader = await CarReader.fromBytes(carBytes);
  } catch (cause) {
    throw new SphereError(
      'extractCarRootCid: CAR bytes did not parse',
      'BUNDLE_REJECTED_INVALID_CAR',
      cause,
    );
  }
  // `getRoots()` is technically synchronous in the current `@ipld/car`
  // implementation but is exposed as a Promise-returning API; await for
  // forward-compat.
  const roots = await reader.getRoots();
  if (roots.length !== 1) {
    throw new SphereError(
      `extractCarRootCid: expected single-root CAR, found ${roots.length}`,
      'BUNDLE_REJECTED_MULTI_ROOT',
    );
  }
  // Steelman fix: protocol §3.1 mandates CIDv1 base32 (`b...`). Reject
  // CIDv0 (`Qm...` base58) explicitly — a hostile sender that publishes
  // a v0-rooted CAR with `payload.bundleCid: "Qm..."` would otherwise
  // pass the equality check downstream. Forward-compat: also reject any
  // future CID version we don't yet recognize as v1.
  const root = roots[0];
  if (root.version !== 1) {
    throw new SphereError(
      `extractCarRootCid: CAR root must be CIDv1; got CIDv${root.version}`,
      'BUNDLE_REJECTED_INVALID_CAR',
    );
  }
  // `CID#toString()` defaults to multibase base32 for CIDv1 — exactly the
  // wire form the protocol mandates. Verify the prefix as defense-in-depth.
  const cidStr = root.toString();
  if (!cidStr.startsWith('b')) {
    throw new SphereError(
      `extractCarRootCid: expected base32 multibase prefix 'b'; got '${cidStr.slice(0, 1)}'`,
      'BUNDLE_REJECTED_INVALID_CAR',
    );
  }
  return cidStr;
}

// =============================================================================
// 4. Internal — deterministic key ordering
// =============================================================================

/**
 * Reorder fields of a payload for byte-deterministic JSON output. The
 * order matches the §3.1 example: discriminator first, version second,
 * mode third, then identity-bearing fields (bundleCid, tokenIds), then
 * optional metadata (memo, sender), then kind-specific fields.
 *
 * For legacy payloads (no `kind`), we recursively sort keys
 * alphabetically — the legacy shapes have no spec-mandated order, and
 * alphabetical is the most-predictable convention.
 *
 * @internal
 */
function orderForSerialization(payload: UxfTransferPayload): unknown {
  // We use the runtime guards (rather than `'kind' in payload`) because the
  // legacy shapes carry an index-signature `[k: string]: unknown`, which
  // makes `'kind' in payload` non-narrowing for TS.
  if (isUxfTransferPayloadCar(payload)) {
    return orderUxfCar(payload);
  }
  if (isUxfTransferPayloadCid(payload)) {
    return orderUxfCid(payload);
  }
  // Legacy passthrough — recursively sort.
  return sortKeysRecursive(payload as LegacyTokenTransferPayload);
}

/**
 * Order fields of a `uxf-car` payload per §3.1.
 *
 * @internal
 */
function orderUxfCar(payload: UxfTransferPayloadCar): Record<string, unknown> {
  const out: Record<string, unknown> = {
    kind: payload.kind,
    version: payload.version,
    mode: payload.mode,
    bundleCid: payload.bundleCid,
    tokenIds: [...payload.tokenIds],
  };
  if (payload.memo !== undefined) out.memo = payload.memo;
  if (payload.sender !== undefined) {
    out.sender = orderSender(payload.sender);
  }
  out.carBase64 = payload.carBase64;
  return out;
}

/**
 * Order fields of a `uxf-cid` payload per §3.1.
 *
 * @internal
 */
function orderUxfCid(payload: UxfTransferPayloadCid): Record<string, unknown> {
  const out: Record<string, unknown> = {
    kind: payload.kind,
    version: payload.version,
    mode: payload.mode,
    bundleCid: payload.bundleCid,
    tokenIds: [...payload.tokenIds],
  };
  if (payload.memo !== undefined) out.memo = payload.memo;
  if (payload.sender !== undefined) {
    out.sender = orderSender(payload.sender);
  }
  if (payload.senderGateways !== undefined) {
    out.senderGateways = [...payload.senderGateways];
  }
  return out;
}

/**
 * Order fields of the optional `sender` sub-object: pubkey first,
 * nametag second.
 *
 * @internal
 */
function orderSender(sender: {
  readonly transportPubkey: string;
  readonly nametag?: string;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    transportPubkey: sender.transportPubkey,
  };
  if (sender.nametag !== undefined) out.nametag = sender.nametag;
  return out;
}

/**
 * Recursive deep-sort of object keys (alphabetical). Arrays are walked
 * element-wise without re-sorting. Used for legacy passthrough where
 * the spec doesn't pin a canonical key order.
 *
 * @internal
 */
function sortKeysRecursive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => sortKeysRecursive(v));
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      out[k] = sortKeysRecursive(v);
    }
    return out;
  }
  return value;
}

// =============================================================================
// 5. Convenience — base64 helpers (re-exported for callers that need to
//    construct a `uxf-car` payload from CAR bytes)
// =============================================================================

/**
 * Encode raw CAR bytes as the `carBase64` string used in `uxf-car`
 * payloads. Uses `Buffer.toString('base64')` for cross-platform
 * consistency (the SDK already polyfills `Buffer` in browser builds).
 */
export function carBytesToBase64(carBytes: Uint8Array): string {
  // Wrap in Buffer.from to handle subarrays / shared underlying ArrayBuffers
  // — `Buffer.from(uint8array)` copies just the byteLength view, not the
  // entire backing buffer.
  return Buffer.from(carBytes.buffer, carBytes.byteOffset, carBytes.byteLength).toString('base64');
}

/**
 * Decode the `carBase64` field of a `uxf-car` payload back into raw
 * bytes. Strict-mode base64: rejects non-base64 characters.
 *
 * @throws {SphereError} `BUNDLE_REJECTED_MALFORMED_ENVELOPE` if the
 *         input contains characters outside the base64 alphabet, or if
 *         decoding to bytes fails for any other reason.
 */
export function carBase64ToBytes(carBase64: string): Uint8Array {
  // Buffer.from('xxx', 'base64') is permissive — it silently drops
  // non-alphabet characters. We pre-validate the alphabet so callers
  // get a hard error on garbage input rather than silently-truncated
  // bytes (which would later fail CAR parsing with a more confusing
  // `BUNDLE_REJECTED_INVALID_CAR`).
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(carBase64)) {
    throw new SphereError(
      'carBase64ToBytes: input is not valid base64',
      'BUNDLE_REJECTED_MALFORMED_ENVELOPE',
    );
  }
  // The Uint8Array view is independent of the backing Buffer — copy out
  // so callers can't mutate the internal pool.
  const buf = Buffer.from(carBase64, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
