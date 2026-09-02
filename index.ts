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

export { Sphere, createSphere, loadSphere, initSphere, sphereExists, checkNetworkHealth, logger, SphereError, PartialSendConflictError, isSphereError, isPossiblyCommittedSendOutcome } from './core';
export { signMessage, verifySignedMessage, hashSignMessage, recoverPubkeyFromSignature, SIGN_MESSAGE_PREFIX } from './core/crypto';
export type {
  SphereCreateOptions,
  SphereLoadOptions,
  SphereInitOptions,
  SphereInitResult,
  SphereImportOptions,
  WalletApiTransportConfig,
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
  HistoryRecord,
} from './storage';

// =============================================================================
// Wallet-api cross-repo protocol strings (§4 auth challenge) & field encryption (S6)
// =============================================================================

export {
  ChallengeTemplateError,
  AUTH_CHALLENGE_PREFIX,
  verifyChallengeTemplate,
} from './core/wallet-api-protocol';

export {
  deriveFieldEncryptionKey,
  encryptField,
  decryptField,
  encryptFieldBytes,
  decryptFieldBytes,
  assertFieldEnvelopeShape,
  FIELD_ENCRYPTION_HKDF_INFO,
  FIELD_ENVELOPE_PREFIX,
  FIELD_ENVELOPE_NONCE_BYTES,
  FIELD_ENVELOPE_MAX_BYTES,
} from './core';

export type {
  // Transport
  TransportProvider,
  PeerInfo,
  MessageHandler,
  BroadcastHandler,
  IncomingMessage,
  IncomingBroadcast,
  TransportEvent,
  TransportEventType,
  TransportEventCallback,
} from './transport';

export type {
  // Oracle (Aggregator) — v2: network-config provider for the token engine
  OracleProvider,
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

// The payments surface (`sphere.payments`) is the §4 facade — its types ship
// on the `@unicitylabs/sphere-sdk/payments-v2` subpath. `TransactionHistoryEntry`
// keeps its name as an alias of the storage HistoryRecord it always was.
export type { HistoryRecord as TransactionHistoryEntry } from './storage';

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
  // Nostr
  DEFAULT_NOSTR_RELAYS,
  TEST_NOSTR_RELAYS,
  NOSTR_EVENT_KINDS,
  NIP29_KINDS,
  DEFAULT_GROUP_RELAYS,
  // Aggregator
  DEFAULT_AGGREGATOR_TIMEOUT,
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
// Serialization (Text Wallet Backup Parsing)
// =============================================================================

export {
  // Text format
  parseWalletText,
  parseAndDecryptWalletText,
  isWalletTextFormat,
  isTextWalletEncrypted,
  decryptTextFormatKey,
} from './serialization';

export type {
  LegacyFileParsedData,
  LegacyFileParseResult,
  LegacyFileType,
  DecryptionProgressCallback,
} from './serialization';

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
