/**
 * OpLog envelope read/write helpers for ProfileDatabase-backed adapters.
 *
 * Issue #247 — multiple writers in the Profile layer historically wrote
 * raw AES-GCM ciphertext via `db.put(key, ciphertext)` while the lean-
 * snapshot reader pipeline (`ProfileLeanSnapshot.readAllKvEntries` →
 * `storage.getEncryptedRaw(key)` → `db.getEntry(key)` → `decodeEntry()`)
 * expected CBOR-encoded OpLog envelopes. Random IV-prefixed ciphertext
 * looks like garbage CBOR, producing varied per-write decode errors
 * (every write of the same key produces a different signature because
 * of the random IV).
 *
 * The decode failures were tolerated by the lean snapshot with a
 * `— skipping` warn, so the immediate failure was silent — but the
 * resulting snapshot was missing those keys → cross-device profile
 * sync was incomplete.
 *
 * This module centralises the canonical pattern used by
 * `ProfileStorageProvider.writeEnvelope` / `readEnvelopePayload`:
 *
 *   - Write: `putEntry` with a CBOR envelope wrapping the ciphertext.
 *     Fallback to raw `put` for adapters that don't implement
 *     `putEntry` (legacy stubs).
 *   - Read: `getEntry` with `trustLocalClaim: true`. If the entry is
 *     legacy (`v === 0` synthetic envelope), unwrap its payload.
 *     Backwards-compat fallback: when `getEntry` itself throws decode
 *     failure (raw bytes that aren't CBOR-encoded envelopes), fall back
 *     to `db.get(key)` for the raw ciphertext.
 *
 * Adapters use `cache_index` as the entry type — that's the canonical
 * system classification for internal book-keeping records (the only
 * three system entry types are `session_receipt`, `cache_index`, and
 * `last_opened_ts`; `cache_index` is the catch-all per the existing
 * pattern in `ProfileStorageProvider.writeEnvelope` /
 * `consolidation.addBundle`).
 *
 * @module profile/oplog-envelope-io
 */

import type { ProfileDatabase } from './types.js';
import {
  buildLocalEntry,
  decodeEntry,
  type OpLogEntryEnvelope,
} from './oplog-entry.js';

/**
 * Write encrypted ciphertext at `key`, wrapping in an OpLog envelope
 * when the adapter supports `putEntry`. Falls back to raw `put` for
 * legacy adapters that lack the structured-entry API (mirrors the
 * `writeEnvelope` capability probe in ProfileStorageProvider).
 *
 * The `originated` tag is always `'system'` for the adapter book-keeping
 * payloads this helper serves (OUTBOX/SENT/finalization queue/
 * disposition/consolidation/prefix-sync). System types require
 * `originated === 'system'` per the originated-tag discipline.
 */
export async function putEnvelopePayload(
  db: ProfileDatabase,
  key: string,
  encryptedPayload: Uint8Array,
): Promise<void> {
  if (typeof db.putEntry === 'function') {
    const envelope = buildLocalEntry({
      type: 'cache_index',
      originated: 'system',
      payload: encryptedPayload,
    });
    await db.putEntry(key, envelope);
    return;
  }
  // Legacy adapter without structured-entry support — write raw bytes.
  await db.put(key, encryptedPayload);
  // Mark locally-authored where the adapter supports the hook so a
  // subsequent `getEntry` (during the migration window) doesn't
  // downgrade the trust tag.
  const markHook = (db as { markLocallyAuthored?: (k: string) => void })
    .markLocallyAuthored;
  if (typeof markHook === 'function') {
    markHook.call(db, key);
  }
}

/**
 * Best-effort unwrap of raw bytes returned by `db.all()` to the
 * encrypted ciphertext payload. Mirrors the dual-format logic of
 * {@link getEnvelopePayload} but operates on bytes already in hand
 * (skips the round trip through `db.getEntry`).
 *
 * Tries to CBOR-decode as an OpLog envelope; on success returns
 * `envelope.payload` (works for both v=1 native envelopes and v=0
 * synthetic legacy wrappers around valid CBOR byte-strings).
 *
 * On decode failure — pre-#247 wallets wrote AES-GCM ciphertext
 * directly, which is not valid CBOR — returns the bytes unchanged
 * so the legacy decrypt path still works.
 *
 * NOTE: importing `decodeEntry` from `./oplog-entry` is the
 * canonical decoder used by `db.getEntry` internally, so this stays
 * in sync with whatever envelope shape `putEntry` produces.
 */
export function unwrapEnvelopeBytes(bytes: Uint8Array): Uint8Array {
  try {
    const envelope = decodeEntry(bytes);
    return envelope.payload;
  } catch {
    // Not a valid envelope — assume legacy raw ciphertext bytes.
    return bytes;
  }
}

/**
 * Optional observability hook for {@link getEnvelopePayload}. Invoked
 * exactly once per call when the envelope path threw and the function
 * fell back to the raw-bytes `db.get(key)` path.
 *
 * Issue #280 — the silent fall-through was load-bearing for backward
 * compatibility with pre-#247 raw-ciphertext entries, but it also
 * masked LIVE corruption (e.g. an OUTBOX/SENT/etc. entry whose
 * envelope CBOR is unreadable on the local OrbitDB store, fed by
 * a peer-replicated write or a partial-write race). Without a
 * signal, operators only saw the downstream symptom — missing
 * snapshot entries → phantom recovered balances. With the hook,
 * the corruption surfaces as a typed event/metric the caller can
 * route through their own diagnostics pipeline.
 *
 * Implementations MUST NOT throw — `getEnvelopePayload` swallows
 * any exception escaping the hook so the read path is not gated on
 * observability quality of service. The hook is best-effort.
 */
export type GetEnvelopePayloadFallbackHook = (info: {
  readonly key: string;
  readonly errorMessage: string;
}) => void;

/**
 * Read the encrypted ciphertext at `key`.
 *
 * Dual-format reader for backwards compatibility:
 *
 *   1. New format (envelope): wallets written after Issue #247 carry
 *      a CBOR envelope wrapping the ciphertext. `getEntry` decodes it
 *      and we return the envelope's payload.
 *   2. Legacy format (raw bytes from pre-#247 writes): `getEntry`
 *      either auto-wraps the bytes via its legacy fallback (§7.1) when
 *      they happen to be valid CBOR byte-strings, OR throws an
 *      `OpLogEntryCorrupt` decode error when they are random AES-GCM
 *      ciphertext. Either way we recover by reading the raw bytes via
 *      `db.get(key)`.
 *
 * Returns `null` when the key is absent. Throws ProfileError when the
 * adapter is disconnected (propagated unchanged from `db.get`).
 *
 * NOTE: callers are responsible for decrypting the returned bytes
 * using their own encryption key.
 *
 * @param db   The Profile database adapter (OrbitDb-backed in prod).
 * @param key  The dot-notation profile key to read.
 * @param onFallback  Optional observability hook fired ONCE when the
 *                    envelope decode threw and the function fell back
 *                    to the raw-bytes path. See
 *                    {@link GetEnvelopePayloadFallbackHook}.
 */
export async function getEnvelopePayload(
  db: ProfileDatabase,
  key: string,
  onFallback?: GetEnvelopePayloadFallbackHook,
): Promise<Uint8Array | null> {
  if (typeof db.getEntry === 'function') {
    try {
      const envelope = (await db.getEntry(key, {
        trustLocalClaim: true,
      })) as OpLogEntryEnvelope | null;
      if (envelope !== null) {
        // Envelope returned (v === 1 for new writes; v === 0 for the
        // synthetic legacy wrapper around valid CBOR byte-strings).
        // Either way the payload IS the ciphertext we care about.
        return envelope.payload;
      }
      return null;
    } catch (err) {
      // Fall through to raw-bytes path. Pre-#247 wallets wrote AES-GCM
      // ciphertext directly via `db.put` — the resulting bytes do NOT
      // decode as CBOR envelopes (the `getEntry` legacy fallback only
      // catches valid CBOR byte-strings) so we land here. Reading the
      // same key via `db.get` returns the raw ciphertext unchanged.
      //
      // Issue #280 — fire the optional observability hook so callers
      // can detect live corruption (the silent path also masked
      // genuine envelope-write damage, not just legacy bytes).
      if (onFallback !== undefined) {
        try {
          onFallback({
            key,
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        } catch {
          // Best-effort signal — never propagate hook errors into the
          // read path. A misbehaving observer cannot break reads.
        }
      }
    }
  }
  // Legacy adapter without structured-entry support OR getEntry decode
  // failure on pre-#247 raw-bytes entries. Either way the raw bytes
  // are what the caller wants.
  return db.get(key);
}
