/**
 * AAD framing (lengthDelim, u32be, u64be) + HKDF key derivations.
 * Filled in Task 1.2.
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

export function u32be(_n: number): Uint8Array {
  throw new Error('not implemented');
}

export function u64be(_n: number | bigint): Uint8Array {
  throw new Error('not implemented');
}

export function lengthDelim(_parts: (string | Uint8Array)[]): Uint8Array {
  throw new Error('not implemented');
}

export function deriveVaultKey(_walletPriv: string, _network: string): Uint8Array {
  throw new Error('not implemented');
}

export function deriveCourierKey(_ecdhX: Uint8Array, _info: string): Uint8Array {
  throw new Error('not implemented');
}
