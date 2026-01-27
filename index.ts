/**
 * Sphere SDK
 *
 * A modular TypeScript SDK for the Unicity network with proper abstraction layers.
 *
 * Architecture:
 * - Core types and interfaces are platform-independent
 * - Platform-specific implementations live in ./impl/{platform}/
 * - Modules (payments, communications) use provider interfaces
 *
 * @example
 * ```ts
 * import { Sphere } from '@unicitylabs/sphere-sdk';
 * import {
 *   createLocalStorageProvider,
 *   createNostrTransportProvider,
 *   createUnicityAggregatorProvider,
 * } from '@unicitylabs/sphere-sdk/impl/browser';
 *
 * const sphere = await Sphere.create({
 *   identity: { mnemonic: 'your twelve words...' },
 *   storage: createLocalStorageProvider(),
 *   transport: createNostrTransportProvider(),
 *   oracle: createUnicityAggregatorProvider({ url: '/rpc' }),
 * });
 *
 * // Payments
 * await sphere.payments.send({
 *   coinId: 'ALPHA',
 *   amount: '1000000',
 *   recipient: '@alice',
 * });
 *
 * // Communications
 * await sphere.communications.sendDM('@bob', 'Hello!');
 *
 * // Events
 * sphere.on('transfer:incoming', (data) => console.log(data));
 *
 * // Cleanup
 * await sphere.destroy();
 * ```
 *
 * @packageDocumentation
 */

// =============================================================================
// Core
// =============================================================================

export { Sphere, createSphere, loadSphere, initSphere, getSphere, sphereExists } from './core';
export type {
  SphereCreateOptions,
  SphereLoadOptions,
  SphereInitOptions,
  SphereInitResult,
} from './core';

// =============================================================================
// Core Utilities
// =============================================================================

export {
  // Crypto
  bytesToHex,
  hexToBytes,
  generateMnemonic,
  validateMnemonic,
  mnemonicToSeedSync,
  generateMasterKey,
  deriveChildKey,
  deriveKeyAtPath,
  getPublicKey,
  createKeyPair,
  sha256,
  ripemd160,
  hash160,
  doubleSha256,
  randomBytes,
  identityFromMnemonicSync,
  deriveAddressInfo,
  // Currency
  toSmallestUnit,
  toHumanReadable,
  formatAmount,
  // Bech32
  encodeBech32,
  decodeBech32,
  createAddress,
  isValidBech32,
  getAddressHrp,
  // Utils
  isValidPrivateKey,
  base58Encode,
  base58Decode,
  findPattern,
  extractFromText,
  sleep,
  randomHex,
  randomUUID,
} from './core';

// =============================================================================
// Types
// =============================================================================

export * from './types';

// =============================================================================
// Provider Interfaces (platform-independent)
// =============================================================================

export type {
  // Storage
  StorageProvider,
  TokenStorageProvider,
  SaveResult,
  LoadResult,
  SyncResult,
  StorageEvent,
  StorageEventType,
  StorageEventCallback,
  TxfStorageDataBase,
  TxfMeta,
  TxfTombstone,
  TxfOutboxEntry,
  TxfSentEntry,
  TxfInvalidEntry,
} from './storage';

export type {
  // Transport
  TransportProvider,
  MessageHandler,
  TokenTransferHandler,
  BroadcastHandler,
  IncomingMessage,
  IncomingTokenTransfer,
  IncomingBroadcast,
  TokenTransferPayload,
  TransportEvent,
  TransportEventType,
  TransportEventCallback,
} from './transport';

export type {
  // Oracle (Aggregator)
  OracleProvider,
  TransferCommitment,
  SubmitResult,
  InclusionProof,
  WaitOptions,
  ValidationResult,
  TokenState,
  MintParams,
  MintResult,
  OracleEvent,
  OracleEventType,
  OracleEventCallback,
  // Backward compatibility
  AggregatorProvider,
  AggregatorEvent,
  AggregatorEventType,
  AggregatorEventCallback,
} from './oracle';

// =============================================================================
// Modules
// =============================================================================

export {
  PaymentsModule,
  createPaymentsModule,
} from './modules/payments';
export type {
  PaymentsModuleConfig,
  PaymentsModuleDependencies,
} from './modules/payments';

export {
  CommunicationsModule,
  createCommunicationsModule,
} from './modules/communications';
export type {
  CommunicationsModuleConfig,
  CommunicationsModuleDependencies,
} from './modules/communications';

// =============================================================================
// Constants
// =============================================================================

export {
  // Storage
  STORAGE_PREFIX,
  STORAGE_KEYS,
  // Nostr
  DEFAULT_NOSTR_RELAYS,
  NOSTR_EVENT_KINDS,
  // Aggregator
  DEFAULT_AGGREGATOR_URL,
  DEV_AGGREGATOR_URL,
  TEST_AGGREGATOR_URL,
  DEFAULT_AGGREGATOR_TIMEOUT,
  // IPFS
  DEFAULT_IPFS_GATEWAYS,
  DEFAULT_IPFS_BOOTSTRAP_PEERS,
  // Wallet
  DEFAULT_DERIVATION_PATH,
  COIN_TYPES,
  // Networks
  NETWORKS,
  // Timeouts & Limits
  TIMEOUTS,
  LIMITS,
} from './constants';
export type { NetworkType } from './constants';

// =============================================================================
// Browser Implementations
// =============================================================================
// NOTE: Browser-specific implementations are NOT re-exported from main entry
// to allow this package to work in pure Node.js environments without helia.
//
// Import browser implementations explicitly:
//   import { createLocalStorageProvider, createBrowserProviders } from '@unicitylabs/sphere-sdk/impl/browser';
//
// Or use the /core entry for Node.js projects that don't need browser features:
//   import { Sphere } from '@unicitylabs/sphere-sdk/core';

// =============================================================================
// Serialization (Legacy File Parsing)
// =============================================================================

export {
  // Text format
  parseWalletText,
  parseAndDecryptWalletText,
  isWalletTextFormat,
  isTextWalletEncrypted,
  decryptTextFormatKey,
  // Dat format
  parseWalletDat,
  parseAndDecryptWalletDat,
  isSQLiteDatabase,
  isWalletDatEncrypted,
  decryptCMasterKey,
  decryptPrivateKey,
} from './serialization';

export type {
  LegacyFileType,
  LegacyFileInfo,
  LegacyFileParsedData,
  LegacyFileParseResult,
  LegacyFileImportOptions,
  DecryptionProgressCallback,
  CMasterKeyData,
  WalletDatInfo,
} from './serialization';

// =============================================================================
// TXF Serialization
// =============================================================================

export {
  // Token → TXF conversion
  tokenToTxf,
  objectToTxf,
  txfToToken,
  // Storage data
  buildTxfStorageData,
  parseTxfStorageData,
  // Utilities
  normalizeSdkTokenToStorage,
  getTokenId,
  getCurrentStateHash,
  hasValidTxfData,
  hasUncommittedTransactions,
  hasMissingNewStateHash,
  countCommittedTransactions,
} from './serialization/txf-serializer';

export type { ParsedStorageData } from './serialization/txf-serializer';

// =============================================================================
// Validation
// =============================================================================

export {
  TokenValidator,
  createTokenValidator,
} from './validation';

export type {
  ValidationAction,
  ExtendedValidationResult,
  SpentTokenInfo,
  SpentTokenResult,
  ValidationResult as TokenValidationResult,
  AggregatorClient,
  TrustBaseLoader,
} from './validation';

// =============================================================================
// L1 SDK (ALPHA Blockchain)
// =============================================================================

export {
  // L1 Payments Module
  L1PaymentsModule,
  createL1PaymentsModule,
} from './modules/payments';

export type {
  L1PaymentsModuleConfig,
  L1PaymentsModuleDependencies,
  L1SendRequest,
  L1SendResult,
  L1Balance,
  L1Utxo,
  L1Transaction,
} from './modules/payments';

// L1 Low-level SDK
export * as L1 from './l1';
