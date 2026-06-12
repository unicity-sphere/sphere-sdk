/**
 * Reserved meta-address entry codec (§5.5) — closes the XP invariant (§11).
 *
 * The vault stores ONE reserved entry at a fixed well-known wire key
 * (`wireKey(walletPriv, network, '_vaultmeta_addr')`) whose plaintext is the
 * JSON `{ directAddress, chainPubkey, formatVersion }`. On load the provider
 * restores `_meta.address` from it, so the DIRECT:// address (which external
 * systems key XP on) survives a fresh import without re-deriving from tokens.
 *
 * The AEAD key comes from `deriveVaultKey(walletPriv, network)` — derived from
 * the SEED, not from the stored address, so there is **no decrypt-needs-address
 * cycle**. The entry reuses `vault-aead/entry.ts`, binding
 * `(network, ownerId=chainPubkey, key=reservedWireKey, version)` as AAD.
 */

import { sealVaultEntry, openVaultEntry } from '../../vault-aead/entry';
import type { VaultEntryPayload } from '../../vault-aead/entry';
import { deriveVaultKey } from '../../vault-aead/derive';
import { wireKey } from './wire-key';

/** Plaintext shape of the reserved meta-address entry. */
export interface ReservedAddress {
  directAddress: string;
  chainPubkey: string;
  formatVersion: number;
}

/** Plaintext label for the reserved meta-address slot. */
export const RESERVED_ADDRESS_PLAIN_KEY = '_vaultmeta_addr';

/** Format version stamped into the reserved meta-address plaintext (DIRECT:// v1). */
export const RESERVED_ADDRESS_FORMAT_VERSION = 1;

/** Fixed version of the reserved slot (singleton — never bumped). */
const RESERVED_ADDRESS_VERSION = 0;

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

/** The reserved entry's opaque wire key for `(walletPriv, network)`. */
export function reservedAddressKey(walletPriv: string, network: string): string {
  return wireKey(walletPriv, network, RESERVED_ADDRESS_PLAIN_KEY);
}

/**
 * Seal the reserved meta-address entry into a `{nonce, ct}` payload, AAD-bound
 * to `(network, chainPubkey, reservedWireKey, version)`.
 */
export function sealReservedAddress(
  meta: ReservedAddress,
  walletPriv: string,
  network: string,
): VaultEntryPayload {
  const key = reservedAddressKey(walletPriv, network);
  return sealVaultEntry({
    network,
    ownerId: meta.chainPubkey,
    key,
    version: RESERVED_ADDRESS_VERSION,
    plaintext: enc(JSON.stringify(meta)),
    key32: deriveVaultKey(walletPriv, network),
  });
}

/**
 * Open the reserved meta-address entry, rebuilding the same AAD. Throws on any
 * mismatch (wrong owner / key / version / network).
 */
export function openReservedAddress(
  payload: VaultEntryPayload,
  chainPubkey: string,
  walletPriv: string,
  network: string,
): ReservedAddress {
  const key = reservedAddressKey(walletPriv, network);
  const plaintext = openVaultEntry({
    network,
    ownerId: chainPubkey,
    key,
    version: RESERVED_ADDRESS_VERSION,
    payload,
    key32: deriveVaultKey(walletPriv, network),
  });
  return JSON.parse(dec(plaintext)) as ReservedAddress;
}
