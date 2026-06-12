/**
 * AAD-bound vault-entry seal/open (finding #10).
 *
 * Each entry's AEAD binds `(network, ownerId, key, version)` as AAD via
 * `lengthDelim`, so a ciphertext sealed for one slot cannot be replayed into a
 * different owner / key / version: `openVaultEntry` rebuilds the SAME AAD from
 * the slot it is loading into, and the Poly1305 tag fails on any mismatch.
 *
 * The on-wire vault entry payload is a `{nonce, ct}` object (both base64) —
 * PINNED. A fresh random 24-byte nonce is drawn per seal.
 */

import { randomBytes } from '@noble/hashes/utils.js';
import { seal, open } from './aead';
import { lengthDelim, u64be } from './derive';

/** On-wire vault entry payload — both fields base64. */
export interface VaultEntryPayload {
  nonce: string;
  ct: string;
}

export interface SealVaultEntryParams {
  network: string;
  ownerId: string;
  key: string;
  version: number | bigint;
  plaintext: Uint8Array;
  key32: Uint8Array;
}

export interface OpenVaultEntryParams {
  network: string;
  ownerId: string;
  key: string;
  version: number | bigint;
  payload: VaultEntryPayload;
  key32: Uint8Array;
}

const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
const fromB64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));

/** Build the AAD that binds a vault slot: `lengthDelim([network, ownerId, key, u64be(version)])`. */
function entryAad(network: string, ownerId: string, key: string, version: number | bigint): Uint8Array {
  return lengthDelim([network, ownerId, key, u64be(version)]);
}

/** Seal a vault entry; returns the `{nonce, ct}` base64 payload. */
export function sealVaultEntry(params: SealVaultEntryParams): VaultEntryPayload {
  const { network, ownerId, key, version, plaintext, key32 } = params;
  const nonce = randomBytes(24);
  const aad = entryAad(network, ownerId, key, version);
  const ct = seal(key32, nonce, plaintext, aad);
  return { nonce: b64(nonce), ct: b64(ct) };
}

/** Open a vault entry, rebuilding the AAD from the target slot. Throws on mismatch. */
export function openVaultEntry(params: OpenVaultEntryParams): Uint8Array {
  const { network, ownerId, key, version, payload, key32 } = params;
  const aad = entryAad(network, ownerId, key, version);
  return open(key32, fromB64(payload.nonce), fromB64(payload.ct), aad);
}
