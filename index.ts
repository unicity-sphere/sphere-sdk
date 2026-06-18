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
 *   coinId: 'UCT',
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

export { Sphere, createSphere, loadSphere, initSphere, getSphere, sphereExists, checkNetworkHealth, logger, SphereError, isSphereError } from './core';
export { signMessage, verifySignedMessage, hashSignMessage, recoverPubkeyFromSignature, SIGN_MESSAGE_PREFIX } from './core/crypto';
export type {
  SphereCreateOptions,
  SphereLoadOptions,
  SphereInitOptions,
  SphereInitResult,
  SphereImportOptions,
  SphereWalletApiSession,
  InitProgressStep,
  InitProgress,
  InitProgressCallback,
  DiscoverAddressProgress,
  DiscoveredAddress,
  DiscoverAddressesOptions,
  DiscoverAddressesResult,
  CheckNetworkHealthOptions,
  LogLevel,
  LogHandler,
  LoggerConfig,
  SphereErrorCode,
} from './core';

// =============================================================================
// Constants & Address Utilities
// =============================================================================

export {
  getAddressId,
  getAddressStorageKey,
  STORAGE_KEYS_ADDRESS,
  STORAGE_KEYS_GLOBAL,
} from './constants';

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
  parseTokenAmount,
  safeParseTokenAmount,
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
  // Lazy inventory port (sdk-changes S2)
  InventoryAsset,
  InventoryItem,
  InventoryView,
  ApplyDeltaAdded,
  ApplyDeltaOptions,
  RecoverRemovedResult,
  WholeBlobStore,
} from './storage';

// Default lazy-port adapter for whole-blob providers (sdk-changes S2)
export { WholeBlobInventoryAdapter } from './storage';

// =============================================================================
// Wallet-api client (sdk-changes S1) & field encryption (S6)
// =============================================================================

export {
  WalletApiClient,
  WalletApiError,
  ChallengeTemplateError,
  AUTH_CHALLENGE_PREFIX,
  verifyChallengeTemplate,
} from './wallet-api';
export type {
  WalletApiErrorCode,
  WalletApiClientConfig,
  WalletApiIdentity,
  KeyValueStore,
  InventoryPage,
  CoinBalance,
  BlobUrlEntry,
  UploadUrlRequest,
  UploadUrlEntry,
  ApplyDeltaRequest,
  IntentRecord,
  WakeEvent,
  WakeCallback,
  WakeSocketHandle,
} from './wallet-api';

export {
  deriveFieldEncryptionKey,
  encryptField,
  decryptField,
  assertFieldEnvelopeShape,
  FIELD_ENCRYPTION_HKDF_INFO,
  FIELD_ENVELOPE_PREFIX,
  FIELD_ENVELOPE_NONCE_BYTES,
  FIELD_ENVELOPE_MAX_BYTES,
} from './core';

// Delivery port (sdk-changes S7) — the swappable seam for handing finished
// token blobs to recipients (covenant §3.1-6); wallet-api's mailbox provider
// (impl/shared/wallet-api) is the reference implementation.
export { computeDeliveryId, composeDeliveryKeys } from './transport';
export type {
  DeliveryProvider,
  DeliveryReceipt,
  DeliverOptions,
  IncomingDelivery,
  DeliveryDisposition,
  DeliveryCustody,
  DeliveryBlobKeys,
} from './transport';

export type {
  // Transport
  TransportProvider,
  PeerInfo,
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
  // Oracle (Aggregator) — v2: network-config provider for the token engine
  OracleProvider,
  ValidationResult,
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
  PaymentsWalletApiPort,
  ReceiveOptions,
  ReceiveResult,
  TransactionHistoryEntry,
} from './modules/payments';

export {
  CommunicationsModule,
  createCommunicationsModule,
} from './modules/communications';
export type {
  CommunicationsModuleConfig,
  CommunicationsModuleDependencies,
  ConversationPage,
  GetConversationPageOptions,
} from './modules/communications';

export {
  GroupChatModule,
  createGroupChatModule,
  GroupRole,
  GroupVisibility,
} from './modules/groupchat';
export type {
  GroupChatModuleConfig,
  GroupChatModuleDependencies,
  GroupData,
  GroupMessageData,
  GroupMemberData,
  CreateGroupOptions,
} from './modules/groupchat';

export {
  MarketModule,
  createMarketModule,
  DEFAULT_MARKET_API_URL,
} from './modules/market';
export type {
  MarketModuleConfig,
  MarketModuleDependencies,
  PostIntentRequest,
  PostIntentResult,
  MarketIntent,
  SearchIntentResult,
  SearchFilters,
  SearchOptions,
  SearchResult,
  IntentType,
  IntentStatus,
} from './modules/market';

// =============================================================================
// Constants
// =============================================================================

export {
  // Storage
  STORAGE_PREFIX,
  STORAGE_KEYS,
  // Nostr
  DEFAULT_NOSTR_RELAYS,
  TEST_NOSTR_RELAYS,
  NOSTR_EVENT_KINDS,
  NIP29_KINDS,
  DEFAULT_GROUP_RELAYS,
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
} from './validation';

// =============================================================================
// Token Registry
// =============================================================================

export {
  TokenRegistry,
  getTokenDefinition,
  getTokenSymbol,
  getTokenName,
  getTokenDecimals,
  getTokenIconUrl,
  isKnownToken,
  getCoinIdBySymbol,
  getCoinIdByName,
  normalizeCoinId,
  coinIdsMatch,
} from './registry';

export type {
  TokenDefinition,
  TokenIcon,
  RegistryNetwork,
} from './registry';

// =============================================================================
// Nametag Utilities (re-exported from @unicitylabs/nostr-js-sdk)
// =============================================================================

export {
  normalizeNametag,
  isPhoneNumber,
  hashNametag,
  hashAddressForTag,
  areSameNametag,
  encryptNametag,
  decryptNametag,
} from '@unicitylabs/nostr-js-sdk';

export type {
  IdentityBindingParams,
  BindingInfo,
} from '@unicitylabs/nostr-js-sdk';

export { isValidNametag } from './core/Sphere';

// =============================================================================
// Nostr Client (re-exported from @unicitylabs/nostr-js-sdk)
// =============================================================================

export { NostrClient, NostrKeyManager } from '@unicitylabs/nostr-js-sdk';
export type {
  NostrClientOptions,
  ConnectionEventListener,
} from '@unicitylabs/nostr-js-sdk';

// =============================================================================
// Price Provider
// =============================================================================

export type {
  PriceProvider,
  PriceProviderConfig,
  PricePlatform,
  TokenPrice,
} from './price';

export {
  CoinGeckoPriceProvider,
  createPriceProvider,
} from './price';

// Swap module
export { SwapModule, createSwapModule } from './modules/swap/index';
export { computeSwapId, buildManifest, validateManifest, verifyManifestIntegrity, signSwapManifest, verifySwapSignature, createNametagBinding, verifyNametagBinding } from './modules/swap/manifest';
export type {
  SwapDeal,
  SwapManifest,
  ManifestFields,
  ManifestSignatures,
  NametagBindingProof,
  ManifestAuxiliary,
  SwapProgress,
  SwapRole,
  SwapRef,
  SwapProposalResult,
  GetSwapsFilter,
  SwapModuleConfig,
} from './modules/swap/types';

// Address parsing
export { parseAddress, isValidAddress, isValidDirectAddress, normalizeAddress, addressesMatch } from './core/address';
export type { AddressType, ParsedAddress } from './core/address';

// =============================================================================
// Exports added for @unicity-sphere/cli consumption (phase 2 extraction).
// These were previously only reachable via relative paths from sphere-sdk/cli/.
// Added to public surface so the external CLI can import them without depending
// on internal layout. Safe to export — they are all existing stable utilities.
// =============================================================================

// Encryption (strong Argon2 + ChaCha20 flow)
export {
  encrypt,
  decrypt,
  decryptJson,
  encryptSimple,
  decryptSimple,
  decryptWithSalt,
  encryptMnemonic,
  decryptMnemonic,
} from './core/encryption';
export type { EncryptedData } from './core/encryption';

// Legacy wallet derivation helper (dual-use: derives chainPubkey in wif_hmac mode)
export { generateAddressFromMasterKey } from './core/crypto';

// Accounting module types
export type {
  CreateInvoiceRequest,
  InvoiceRequestedAsset,
  GetInvoicesOptions,
  PayInvoiceParams,
  ReturnPaymentParams,
} from './modules/accounting/types';

// TxfToken type for serialization workflows
export type { TxfToken } from './types/txf';

// Master-key provider status re-export (already re-exported via ./types barrel,
// but keeping explicit here for consumers that want to import direct types).
