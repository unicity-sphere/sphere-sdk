/**
 * Profile Aggregator Pointer Layer — Phase A barrel.
 *
 * Public exports for Phase A (foundations). Downstream phases extend
 * this barrel as their APIs land.
 */

export * from './constants.js';
export * from './errors.js';
export * from './types.js';
export {
  createMasterPrivateKey,
  isAuthorizedMasterKey,
  assertAuthorizedMasterKey,
} from './master-key.js';
export type { MasterPrivateKey } from './master-key.js';
export { SecretKey } from './secret-key.js';
export {
  derivePointerKeyMaterial,
  deriveStateHashDigest,
  deriveXorKey,
  derivePaddingBytes,
  be32,
} from './key-derivation.js';
export type { PointerKeyMaterial } from './key-derivation.js';
export { buildPointerSigner, bytesToHex } from './signing.js';
export type { PointerSigner } from './signing.js';
export { deriveHealthCheckRequestId } from './health-check.js';
