/**
 * Profile Aggregator Pointer Layer — Phase A + B barrel.
 *
 * Public exports for Phase A (foundations) and Phase B (state-machine core).
 * Downstream phases extend this barrel as their APIs land.
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

// Phase B — state-machine core
export { FlagStore, DURABLE_STORAGE, isDurableProvider } from './flag-store.js';
export type { DurableStorageProvider } from './flag-store.js';
export {
  readMarker,
  writeMarker,
  clearMarker,
  computeCidHash,
  resolvePublishVersion,
} from './marker.js';
export type { MarkerResolution } from './marker.js';
export { isBlocked, setBlocked, clearBlocked, maybeSetBlocked, classifyBlockedReason } from './blocked-state.js';
export type { BlockedReason } from './blocked-state.js';
export { createPointerMutex } from './mutex-lock.js';
export type { PointerMutex, MutexHandle, MutexAcquireOptions, MutexFactoryOptions, NodeLockPrimitives } from './mutex-lock.js';
export {
  stampOriginated,
  assertOriginTag,
  downgradeForReplication,
  ALL_ENTRY_TYPES,
} from './originated-tag.js';
export type { OriginTag, OpLogEntryType, UserActionType, SystemActionType } from './originated-tag.js';
