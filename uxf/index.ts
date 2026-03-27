/**
 * UXF (Universal eXchange Format) Module
 *
 * Content-addressed DAG packaging format for Unicity tokens.
 * Import via `@unicitylabs/sphere-sdk/uxf`.
 *
 * @packageDocumentation
 */

// =============================================================================
// Types
// =============================================================================

export {
  // Branded type constructor
  contentHash,
  // Constants
  STRATEGY_LATEST,
  STRATEGY_ORIGINAL,
  ELEMENT_TYPE_IDS,
} from './types.js';

export type {
  ContentHash,
  UxfElementHeader,
  UxfElementType,
  UxfInstanceKind,
  UxfElement,
  UxfElementContent,
  // Typed element content interfaces
  TokenRootContent,
  TokenRootChildren,
  GenesisContent,
  GenesisChildren,
  GenesisDataContent,
  TransactionContent,
  TransactionChildren,
  TransactionDataContent,
  InclusionProofContent,
  InclusionProofChildren,
  AuthenticatorContent,
  SmtPathContent,
  UnicityCertificateContent,
  PredicateContent,
  StateContent,
  TokenCoinDataContent,
  // Package types
  UxfManifest,
  UxfEnvelope,
  UxfPackageData,
  UxfIndexes,
  // Instance chain types
  InstanceChainEntry,
  InstanceChainIndex,
  InstanceSelectionStrategy,
  // Storage adapter interface
  UxfStorageAdapter,
  // Verification types
  UxfVerificationResult,
  UxfVerificationIssue,
  // Diff types
  UxfDelta,
} from './types.js';

// =============================================================================
// Errors
// =============================================================================

export { UxfError } from './errors.js';
export type { UxfErrorCode } from './errors.js';

// =============================================================================
// Hashing
// =============================================================================

export {
  computeElementHash,
  prepareContentForHashing,
  prepareChildrenForHashing,
  hexToBytes,
} from './hash.js';

// =============================================================================
// Element Pool
// =============================================================================

export { ElementPool, collectGarbage, walkReachable } from './element-pool.js';

// =============================================================================
// Instance Chains
// =============================================================================

export {
  addInstance,
  selectInstance,
  resolveElement,
  mergeInstanceChains,
  rebuildInstanceChainIndex,
  createInstanceChainIndex,
  pruneInstanceChains,
} from './instance-chain.js';

export type { MutableInstanceChainIndex } from './instance-chain.js';

// =============================================================================
// Deconstruction (Token -> DAG)
// =============================================================================

export { deconstructToken } from './deconstruct.js';

// =============================================================================
// Assembly (DAG -> Token)
// =============================================================================

export {
  assembleToken,
  assembleTokenFromRoot,
  assembleTokenAtState,
} from './assemble.js';

// =============================================================================
// Verification
// =============================================================================

export { verify } from './verify.js';

// =============================================================================
// Diff / Delta
// =============================================================================

export { diff, applyDelta } from './diff.js';

// =============================================================================
// JSON Serialization
// =============================================================================

export { packageToJson, packageFromJson } from './json.js';

// =============================================================================
// IPLD / CAR Serialization
// =============================================================================

export {
  computeCid,
  elementToIpldBlock,
  exportToCar,
  importFromCar,
  contentHashToCid,
  cidToContentHash,
} from './ipld.js';

// =============================================================================
// UxfPackage (high-level class API)
// =============================================================================

export { UxfPackage } from './UxfPackage.js';

// Package-level free functions (functional API operating on UxfPackageData)
export {
  ingest,
  ingestAll,
  removeToken,
  merge,
  consolidateProofs,
} from './UxfPackage.js';

// =============================================================================
// Storage Adapters
// =============================================================================

export { InMemoryUxfStorage, KvUxfStorageAdapter } from './storage-adapters.js';
