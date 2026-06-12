/**
 * Signed monotonic Merkle root (§5.4) — anti-rollback accumulator.
 *
 * Each vault entry contributes a leaf `H('vault-leaf-v1' ‖ key ‖ u64be(version))`.
 * A TOMBSTONE (deleted) leaf sets the high bit of the 8-byte version field, so a
 * delete is a distinct, ordered state from any live version.
 *
 * The root is an ORDER-INDEPENDENT sparse accumulator: leaves are sorted by key
 * and hash-folded, so the same `{key -> {version, deleted}}` map yields the same
 * root regardless of insertion order. The wallet signs `(network, ownerId,
 * cursor, root)` with its spend key; the provider re-folds a `?since=` delta and
 * compares against the last signed root to detect a hostile rollback.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, signMessage, verifySignedMessage } from '../../core/crypto';
import { lengthDelim, u64be } from '../../vault-aead/derive';

/** Domain-separation prefix for a vault leaf. */
const LEAF_PREFIX = 'vault-leaf-v1';

/** High bit of the u64 version field — set for a tombstone (deleted) leaf. */
const TOMBSTONE_BIT = 1n << 63n;

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** State of a single vault key in the accumulator. */
export interface EntryState {
  version: number | bigint;
  deleted?: boolean;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Compute the leaf hash for `(key, version)`. A `deleted` leaf sets the high bit
 * of the 8-byte version field so a tombstone is distinct from any live version.
 */
export function leaf(key: string, version: number | bigint, deleted = false): Uint8Array {
  const v = deleted ? BigInt(version) | TOMBSTONE_BIT : BigInt(version);
  return sha256(concatBytes([utf8(LEAF_PREFIX), utf8(key), u64be(v)]));
}

/**
 * Order-independent root over a `{key -> EntryState}` map: sort keys, hash-fold
 * the leaves. Two maps with identical key->state pairs produce the same root
 * regardless of insertion order. Returns 64-hex (empty map -> sha256 of nothing).
 */
export function computeRoot(entries: Map<string, EntryState>): string {
  const keys = [...entries.keys()].sort();
  const leaves = keys.map((k) => {
    const e = entries.get(k)!;
    return leaf(k, e.version, !!e.deleted);
  });
  return bytesToHex(sha256(concatBytes(leaves)));
}

/**
 * Incremental fold of a `?since=` delta onto a prior accumulator state.
 *
 * The accumulator IS the sorted `key -> EntryState` map; folding a delta applies
 * each delta entry (last-write-wins per key) and recomputes the root. Returns the
 * new state and its root. `prevState` is not mutated.
 */
export function foldDelta(
  prevState: Map<string, EntryState>,
  deltaEntries: Map<string, EntryState>,
): { state: Map<string, EntryState>; root: string } {
  const state = new Map(prevState);
  for (const [k, v] of deltaEntries) {
    state.set(k, v);
  }
  return { state, root: computeRoot(state) };
}

/** Parameters that the signed root binds. */
export interface RootBinding {
  network: string;
  ownerId: string;
  cursor: number | bigint;
  root: string;
}

/**
 * Canonical signed-root message: hex of
 * `lengthDelim([network, ownerId, u64be(cursor), root])`. The length-prefix
 * framing binds each field unambiguously; the hex makes it a `signMessage`
 * string input.
 */
export function canonRoot(b: RootBinding): string {
  return bytesToHex(lengthDelim([b.network, b.ownerId, u64be(b.cursor), b.root]));
}

/** Sign the canonical root binding with the wallet spend key (130-hex). */
export function signRoot(walletPriv: string, b: RootBinding): string {
  return signMessage(walletPriv, canonRoot(b));
}

/** Verify a signed root binding against the wallet's compressed pubkey. */
export function verifyRoot(b: RootBinding, signature: string, pubkey: string): boolean {
  return verifySignedMessage(canonRoot(b), signature, pubkey);
}
