/**
 * vault-aead — authenticated-encryption primitives for the Token-Vault v2 client.
 *
 * Public surface (filled across Phase 1):
 *  - aead.ts    : seal / open over XChaCha20-Poly1305 (24-byte nonce, AAD)
 *  - derive.ts  : lengthDelim AAD builder, u64be, HKDF key derivations
 *  - ecdh.ts    : on-curve guard + ECDH-x shared secret
 *  - entry.ts   : AAD-bound vault-entry seal/open ({nonce,ct} payload)
 *  - courier.ts : courier envelope seal/open + base64(nonce‖ct) framing
 *
 * Re-exported here so consumers import the whole module from one path.
 */

export { seal, open } from './aead';
export { lengthDelim, u64be, u32be, deriveVaultKey, deriveCourierKey } from './derive';
export { assertOnCurve, ecdhX } from './ecdh';
export { sealVaultEntry, openVaultEntry } from './entry';
export type { VaultEntryPayload, SealVaultEntryParams, OpenVaultEntryParams } from './entry';
export {
  sealCourierEnvelope,
  openCourierEnvelope,
  packCourier,
  unpackCourier,
} from './courier';
export type {
  SealCourierParams,
  OpenCourierParams,
  PackedCourier,
} from './courier';
