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
  assertOriginTagLocal,
  assertOriginTagReplicated,
  downgradeForReplication,
  ALL_ENTRY_TYPES,
} from './originated-tag.js';
export type { OriginTag, OpLogEntryType, UserActionType, SystemActionType } from './originated-tag.js';

// Phase C — external integrations
export { submitPointer } from './aggregator-submit.js';
export type { SubmitInput, SubmitOutcome } from './aggregator-submit.js';
export { probeVersion, classifyVersion, decodeVersionCid, isReachable } from './aggregator-probe.js';
export type {
  ProbeInput,
  ClassifyInput,
  DecodeVersionCidInput,
  DecodeVersionCidResult,
  ReachableInput,
  VersionClassification,
  CarFetchResult,
  CarFetcher,
  CidDecodeResult,
  CidDecoder,
} from './aggregator-probe.js';
export { classifyTrustBaseRotation, raiseForTrustBaseMismatch } from './trust-base-rotation.js';
export type { TrustBaseRotationResult } from './trust-base-rotation.js';
export { fetchCarFromGateway } from './ipfs-car-fetch.js';
export type { CarFetchOptions, CarFetchOutcome, CarFetchFailure } from './ipfs-car-fetch.js';
export {
  recordAttempt,
  getAttempts,
  clearAttempts,
  canInvokeAcceptCarLoss,
  assertAcceptCarLossEligible,
} from './car-loss-tracker.js';
export type { CarFetchAttempt, AcceptCarLossGate } from './car-loss-tracker.js';

// Phase D — integration layer
export { publishOnceAtVersion } from './publish-algorithm.js';
export type { PublishInput, PublishOutcome } from './publish-algorithm.js';
export { findLatestValidVersion, computeProbeFingerprint } from './discover-algorithm.js';
export type { DiscoverInput, DiscoverResult } from './discover-algorithm.js';
export { reconcileAndPublish } from './reconcile-algorithm.js';
export type { ReconcileInput, ReconcileOutcome, FetchAndJoinCallback } from './reconcile-algorithm.js';
export {
  assertConfigCapabilities,
  operatorOverridesAllowed,
  assertOperatorOverridesAllowed,
} from './config.js';
export type { PointerLayerConfig } from './config.js';
export { ProfilePointerLayer } from './ProfilePointerLayer.js';
export type {
  ProfilePointerLayerInit,
  PublishResult,
  ReconcileDownwardResult,
  RecoverResult,
} from './ProfilePointerLayer.js';

// Issue #310 — OpLog epoch-floor walkback primitive
export {
  normalizeEpoch,
  pickEpochFloor,
  shouldSkipForEpochFloor,
  computeEpochFloor,
} from './epoch-floor.js';

// RFC-251 Approach D — pointer-publish win-broadcast (issue #255 Problem B)
export {
  buildWinBroadcastHash,
  buildWinBroadcastTag,
  MAX_PAYLOAD_AGE_MS,
  signWinBroadcastPayload,
  verifyWinBroadcastPayload,
  WIN_BROADCAST_KIND_MARKER,
  WIN_BROADCAST_SCHEMA_VERSION,
  WIN_BROADCAST_TAG_PREFIX,
} from './win-broadcast.js';
export type {
  SignedWinBroadcastPayload,
  UnsignedWinBroadcastPayload,
} from './win-broadcast.js';
