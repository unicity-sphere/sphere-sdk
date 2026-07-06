/**
 * Issue #166 P1 #3 — DoS bounds-defense constants.
 *
 * Profile-resident OUTBOX and SENT entries are encrypted blobs
 * replicated via OrbitDB across peers. Without bounds at the type-guard
 * gate, a hostile peer could replicate a 100MB entry that
 * `readAll`/`contains` materializes into memory before the guard could
 * reject it. The cost of decryption + JSON.parse + scan would land
 * BEFORE any application-level rejection — DoS by replication.
 *
 * **Why these specific numbers.** Each cap is sized to be:
 *  - Comfortably above the largest legitimate entry we expect today
 *    (typical OUTBOX entry is 1-4 tokenIds, short bundleCid, short
 *    nametag — well under every cap below).
 *  - Small enough that a malicious entry hitting the cap is rejected
 *    BEFORE any expensive operation.
 *  - Easy to revise upward without breaking on-disk data (caps are
 *    enforced at READ time via type guards; existing entries that
 *    were valid under a higher cap still validate).
 *
 * **Pre-decrypt cap** ({@link MAX_ENTRY_BYTES_RAW}). Enforced by
 * `readDecoded()` BEFORE the decrypt step. A hostile 100MB blob is
 * rejected at the network/storage boundary without consuming RAM for
 * decryption. Sized at 1 MiB — comfortably above any legitimate UXF
 * outbox entry (including future fields and conservative-mode
 * outstanding requestId arrays).
 *
 * @module types/uxf-bounds
 */

/**
 * Maximum number of tokenIds in a single OUTBOX or SENT entry.
 *
 * 4096 is well above any legitimate single-bundle delivery (typical
 * bundles ship 1-10 tokens; the max sane manual bundle is ~100). A
 * hostile entry with 1M tokenIds would have caused a `for` loop to
 * spend seconds in a security-critical code path.
 */
export const MAX_TOKEN_IDS_PER_ENTRY = 4096;

/**
 * Maximum byte length of a single tokenId string. Token ids are hex
 * digests (SDK-defined), typically 64-128 chars. 256 covers any
 * conceivable future hash widening without permitting a single
 * tokenId to grow into a denial-of-service payload.
 */
export const MAX_TOKEN_ID_LENGTH = 256;

/**
 * Maximum byte length of the `recipient` field on OUTBOX/SENT
 * entries. Recipients are `@nametag`, `DIRECT://...`, or chain
 * pubkeys — all well under 1024 chars in legitimate use.
 */
export const MAX_RECIPIENT_LENGTH = 1024;

/**
 * Maximum byte length of an optional `recipientNametag` field.
 * Nametags are short human-readable handles; 256 is generous.
 */
export const MAX_NAMETAG_LENGTH = 256;

/**
 * Maximum byte length of a `bundleCid` field. IPFS CIDs are
 * fixed-width (~50-100 chars depending on hash function); 256
 * accommodates v0, v1, and future hash-function changes.
 */
export const MAX_BUNDLE_CID_LENGTH = 256;

/**
 * Maximum byte length of an optional `memo` field. Memos are
 * sender-supplied free text shipped on the wire. 8 KiB matches the
 * order-of-magnitude limit a Nostr relay would accept for a TOKEN_TRANSFER
 * event's content before fragmenting; values much above this would
 * not survive transport anyway.
 */
export const MAX_MEMO_LENGTH = 8192;

/**
 * Maximum byte length of a `nostrEventId` field. Nostr event ids are
 * 64-char hex sha256 digests; 128 leaves room for any future format
 * change without permitting unbounded strings.
 */
export const MAX_NOSTR_EVENT_ID_LENGTH = 128;

/**
 * Maximum byte length of the `recipientTransportPubkey` field.
 * Transport pubkeys are 64-char hex secp256k1 keys; 128 is generous.
 */
export const MAX_TRANSPORT_PUBKEY_LENGTH = 128;

/**
 * Maximum byte length of the `error` field on OUTBOX entries. Stores
 * truncated forensic strings (W40 redactCause output); large blobs
 * could be a vector for log-injection / storage exhaustion.
 */
export const MAX_ERROR_LENGTH = 4096;

/**
 * Maximum raw (encrypted) entry size, in bytes, accepted by
 * `readDecoded()` BEFORE the decrypt step. A hostile entry exceeding
 * this is rejected without consuming RAM for decryption.
 *
 * 1 MiB is well above any legitimate UXF outbox entry. The largest
 * legitimate entry today is a conservative-mode delivered entry with
 * a few hundred outstandingRequestIds (each ~64-char hex). At
 * ~4096 tokenIds × 256 bytes = 1 MiB worst-case legitimate; the
 * encrypted blob's AES-GCM overhead (IV + tag = 28 bytes) is
 * negligible at that scale.
 */
export const MAX_ENTRY_BYTES_RAW = 1024 * 1024;

// =============================================================================
// Helper: validate string bounds at the type-guard gate
// =============================================================================

/**
 * Helper used by type guards to verify an optional string field's
 * length when present. Treats absent / undefined as valid (the field
 * is optional). Returns `false` for any string longer than `max` so
 * the guard can reject the entry.
 *
 * @internal
 */
export function isWithinOptionalStringLength(
  v: unknown,
  max: number,
): boolean {
  if (v === undefined) return true;
  if (typeof v !== 'string') return false;
  return v.length <= max;
}
