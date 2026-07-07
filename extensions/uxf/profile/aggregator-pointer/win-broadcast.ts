/**
 * Pointer-publish win-broadcast — RFC-251 Approach D (Issue #255 Problem B).
 *
 * After a wallet's pointer layer successfully publishes V=N to the aggregator
 * (i.e. wins the at-most-one-writer race for slot V=N), it emits an
 * authenticated Nostr broadcast announcing the win to sibling devices that
 * share the same wallet identity. Siblings — which would otherwise wait
 * 30–60 s for the aggregator's read replica to surface V=N — can:
 *
 *   1. Verify the broadcast was signed by their own pointer signing key
 *      (same identity ⇒ same key; siblings authenticate trivially).
 *   2. Trigger an early reconcile (`recoverLatest()` + the existing
 *      `reconcileLocalVersionDownward` path) without waiting for the
 *      WALKBACK_FLOOR throttle's 60 s cooldown.
 *
 * The aggregator itself is not touched — this is purely a client-side
 * optimistic-notification layer. If the broadcast is dropped (relay
 * partition, sibling offline) the system degrades cleanly to the existing
 * WALKBACK_FLOOR + reconcile path: strictly no worse than today.
 *
 * Threat model:
 *   - Authenticity: the payload signature is verified against the receiving
 *     wallet's own signingPubKey. A foreign-key signature → reject.
 *   - Replay: the payload carries `ts` (wall-clock ms); receivers reject
 *     events older than `MAX_PAYLOAD_AGE_MS` (5 min) to bound replay
 *     attempts. Dedup by (signingPubKey, version) on the receiver bounds
 *     within-window replays.
 *   - Spoof: a third party who doesn't hold the wallet's signing key
 *     cannot produce a valid sig. Broadcasts that don't verify against
 *     the receiver's own pubkey are silently dropped.
 *
 * Schema versioning: `v: 1` is the only valid payload version. Future
 * extensions MUST bump `v` so receivers can fail closed on unknown
 * shapes rather than silently ignoring new fields. Receivers MUST
 * reject any `v !== 1`.
 */

import { DataHasher } from 'stsdk-v1/lib/hash/DataHasher.js';
import { HashAlgorithm } from 'stsdk-v1/lib/hash/HashAlgorithm.js';
import { Signature } from 'stsdk-v1/lib/sign/Signature.js';
import { SigningService } from 'stsdk-v1/lib/sign/SigningService.js';
import type { PointerSigner } from './signing.js';

/**
 * Receivers MUST reject broadcasts older than this. Combined with the
 * dedup cache, this bounds replay attempts to a 5-minute window per
 * (signingPubKey, version) tuple — short enough that even an
 * adversarial relay that hoards an event can't replay it indefinitely.
 */
export const MAX_PAYLOAD_AGE_MS = 5 * 60 * 1000;

/** Tag prefix used to scope a Nostr broadcast subscription per wallet. */
export const WIN_BROADCAST_TAG_PREFIX = 'pointer-win:';

/** Content-discriminator embedded in the broadcast JSON. */
export const WIN_BROADCAST_KIND_MARKER = 'pointer-win-broadcast';

/** Schema version. Receivers MUST reject anything but 1. */
export const WIN_BROADCAST_SCHEMA_VERSION = 1 as const;

/**
 * Payload sent over Nostr after a successful pointer publish, before the
 * signature is attached.
 *
 * All fields are required.  Field order is significant for the canonical
 * hash (see {@link buildWinBroadcastHash}).
 */
export interface UnsignedWinBroadcastPayload {
  readonly _kind: typeof WIN_BROADCAST_KIND_MARKER;
  readonly v: typeof WIN_BROADCAST_SCHEMA_VERSION;
  /** Pointer version that was successfully committed to the aggregator. */
  readonly version: number;
  /** Bundle CID (canonical string form — same as published to aggregator). */
  readonly cid: string;
  /** 33-byte compressed secp256k1, hex-encoded (66 chars). */
  readonly signingPubKey: string;
  /** Sender wall-clock at broadcast time, ms since epoch. */
  readonly ts: number;
}

/**
 * Signed payload. The signature is a secp256k1 ECDSA sig (Signature.toJSON
 * format) over the canonical hash of the unsigned payload.
 */
export interface SignedWinBroadcastPayload extends UnsignedWinBroadcastPayload {
  /** `Signature.toJSON()` — hex string of 65-byte recoverable sig. */
  readonly sig: string;
}

/**
 * Build the per-wallet broadcast tag.  Both publisher and subscriber use
 * the same tag so a sibling's Nostr filter (`#t=pointer-win:<hex>`) finds
 * only this wallet's win-broadcasts.
 */
export function buildWinBroadcastTag(signingPubKeyHex: string): string {
  if (typeof signingPubKeyHex !== 'string' || signingPubKeyHex.length === 0) {
    throw new Error('buildWinBroadcastTag: signingPubKeyHex must be a non-empty string');
  }
  return `${WIN_BROADCAST_TAG_PREFIX}${signingPubKeyHex.toLowerCase()}`;
}

/**
 * Canonical hash of the unsigned payload — what gets signed and verified.
 *
 * Byte layout (concatenated, then SHA-256):
 *   1 byte   v (schema version, currently 1)
 *   4 bytes  version (uint32 big-endian)
 *   8 bytes  ts (uint64 big-endian — JS Number max-safe-int suffices for
 *            timestamps until 285616-05-17)
 *   33 bytes signingPubKey (decoded from hex)
 *   N bytes  cid (utf-8 of the canonical string form)
 *
 * Determinism is critical — both ends must produce the exact same hash
 * for verification to succeed. The fixed-width prefix prevents
 * collision via padding tricks (e.g. encoding `version=1, cid="0..."` vs
 * `version=10, cid=""`).
 */
export async function buildWinBroadcastHash(
  payload: UnsignedWinBroadcastPayload,
): Promise<import('stsdk-v1/lib/hash/DataHash.js').DataHash> {
  if (payload.v !== WIN_BROADCAST_SCHEMA_VERSION) {
    throw new Error(`buildWinBroadcastHash: unsupported schema version ${payload.v}`);
  }
  if (!Number.isInteger(payload.version) || payload.version < 0 || payload.version > 0xffffffff) {
    throw new Error(`buildWinBroadcastHash: version must be uint32, got ${payload.version}`);
  }
  if (!Number.isInteger(payload.ts) || payload.ts < 0 || !Number.isSafeInteger(payload.ts)) {
    throw new Error(`buildWinBroadcastHash: ts must be a safe integer >= 0, got ${payload.ts}`);
  }
  const pubKeyBytes = hexToBytes(payload.signingPubKey);
  if (pubKeyBytes.length !== 33) {
    throw new Error(
      `buildWinBroadcastHash: signingPubKey must decode to 33 bytes, got ${pubKeyBytes.length}`,
    );
  }
  const cidBytes = new TextEncoder().encode(payload.cid);

  const buf = new Uint8Array(1 + 4 + 8 + 33 + cidBytes.length);
  let offset = 0;
  buf[offset] = payload.v;
  offset += 1;
  // version uint32 BE
  buf[offset]     = (payload.version >>> 24) & 0xff;
  buf[offset + 1] = (payload.version >>> 16) & 0xff;
  buf[offset + 2] = (payload.version >>> 8)  & 0xff;
  buf[offset + 3] = (payload.version)        & 0xff;
  offset += 4;
  // ts uint64 BE — JS bit-ops are 32-bit, so split into high/low.
  const tsHi = Math.floor(payload.ts / 0x100000000);
  const tsLo = payload.ts >>> 0;
  buf[offset]     = (tsHi >>> 24) & 0xff;
  buf[offset + 1] = (tsHi >>> 16) & 0xff;
  buf[offset + 2] = (tsHi >>> 8)  & 0xff;
  buf[offset + 3] = (tsHi)        & 0xff;
  buf[offset + 4] = (tsLo >>> 24) & 0xff;
  buf[offset + 5] = (tsLo >>> 16) & 0xff;
  buf[offset + 6] = (tsLo >>> 8)  & 0xff;
  buf[offset + 7] = (tsLo)        & 0xff;
  offset += 8;
  buf.set(pubKeyBytes, offset);
  offset += 33;
  buf.set(cidBytes, offset);

  return new DataHasher(HashAlgorithm.SHA256).update(buf).digest();
}

/**
 * Sign a win-broadcast payload using the wallet's pointer signing service.
 *
 * @throws if the supplied `signer.signingPubKeyHex` doesn't match
 *         `unsigned.signingPubKey` — defends against accidentally signing
 *         a payload that claims a different identity.
 */
export async function signWinBroadcastPayload(
  signer: PointerSigner,
  unsigned: UnsignedWinBroadcastPayload,
): Promise<SignedWinBroadcastPayload> {
  if (signer.signingPubKeyHex.toLowerCase() !== unsigned.signingPubKey.toLowerCase()) {
    throw new Error(
      `signWinBroadcastPayload: signer pubkey ${signer.signingPubKeyHex} ` +
      `does not match payload signingPubKey ${unsigned.signingPubKey}`,
    );
  }
  const hash = await buildWinBroadcastHash(unsigned);
  const sig = await signer.service.sign(hash);
  return { ...unsigned, sig: sig.toJSON() };
}

/**
 * Verify a signed win-broadcast payload against an expected signing pubkey.
 *
 * Returns false (does NOT throw) on any verification failure: schema
 * mismatch, age out of window, pubkey-field mismatch, sig parse error,
 * cryptographic mismatch. The caller decides what to do with the
 * rejection (log + drop is the usual response).
 *
 * @param payload          The payload received over the wire.
 * @param expectedSigningPubKeyHex
 *                         The receiver's own wallet pointer signingPubKey,
 *                         hex-encoded. Used as the trust anchor — only
 *                         payloads signed by THIS key are accepted, which
 *                         is appropriate for same-identity sibling
 *                         coordination.
 * @param nowMs            Optional clock for testing; defaults to
 *                         `Date.now()`. The payload is rejected if
 *                         `|nowMs - payload.ts| > MAX_PAYLOAD_AGE_MS`.
 */
export async function verifyWinBroadcastPayload(
  payload: SignedWinBroadcastPayload,
  expectedSigningPubKeyHex: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  try {
    if (payload._kind !== WIN_BROADCAST_KIND_MARKER) return false;
    if (payload.v !== WIN_BROADCAST_SCHEMA_VERSION) return false;
    if (typeof payload.signingPubKey !== 'string') return false;
    if (typeof payload.cid !== 'string' || payload.cid.length === 0) return false;
    if (typeof payload.sig !== 'string' || payload.sig.length === 0) return false;
    if (!Number.isInteger(payload.version) || payload.version < 0) return false;
    if (!Number.isInteger(payload.ts) || payload.ts < 0) return false;

    if (payload.signingPubKey.toLowerCase() !== expectedSigningPubKeyHex.toLowerCase()) {
      return false;
    }
    if (Math.abs(nowMs - payload.ts) > MAX_PAYLOAD_AGE_MS) {
      return false;
    }

    const hash = await buildWinBroadcastHash(payload);
    const sigBytes = parseSignatureHex(payload.sig);
    if (sigBytes === null) return false;
    const pubKeyBytes = hexToBytes(expectedSigningPubKeyHex);
    if (pubKeyBytes.length !== 33) return false;

    return await SigningService.verifyWithPublicKey(hash, sigBytes, pubKeyBytes);
  } catch {
    // Defensive: any unexpected error (e.g. malformed CBOR in Signature
    // parsing, hex with odd length) is treated as a verification failure.
    return false;
  }
}

/**
 * `Signature.toJSON()` produces the recoverable-sig hex (65 bytes).
 * `SigningService.verifyWithPublicKey` accepts the raw bytes directly.
 * This helper parses the hex back to bytes; returns null on malformed
 * input.
 */
function parseSignatureHex(sigHex: string): Uint8Array | null {
  try {
    // Round-trip via the SDK to guarantee shape compatibility with the
    // sender's `Signature.toJSON()`. Returns a Signature instance.
    const sig = Signature.decode(hexToBytes(sigHex));
    return sig.bytes;
  } catch {
    // Fall back to raw hex-bytes parse — older or non-CBOR signature
    // representations.
    try {
      return hexToBytes(sigHex);
    } catch {
      return null;
    }
  }
}

function hexToBytes(hex: string): Uint8Array {
  if (typeof hex !== 'string') {
    throw new Error('hexToBytes: input must be string');
  }
  const normalized = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (normalized.length % 2 !== 0) {
    throw new Error(`hexToBytes: odd length (${normalized.length})`);
  }
  const out = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(normalized.substr(i * 2, 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`hexToBytes: non-hex char at offset ${i * 2}`);
    }
    out[i] = byte;
  }
  return out;
}
