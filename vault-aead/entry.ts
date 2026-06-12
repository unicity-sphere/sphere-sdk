/**
 * AAD-bound vault-entry seal/open. The on-wire vault entry payload is a
 * `{nonce, ct}` object (both base64). Filled in Task 1.4.
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

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

export function sealVaultEntry(_params: SealVaultEntryParams): VaultEntryPayload {
  throw new Error('not implemented');
}

export function openVaultEntry(_params: OpenVaultEntryParams): Uint8Array {
  throw new Error('not implemented');
}
