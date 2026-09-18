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
 * import { Sphere, TokenRegistry, getCoinIdBySymbol } from '@unicitylabs/sphere-sdk';
 * import { createNodeProviders, createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
 *
 * // One network literal in all three places: base providers, walletApi and Sphere.init.
 * const providers = createWalletApiProviders(createNodeProviders({ network: 'testnet2' }), {
 *   baseUrl: 'https://wallet-api.unicity.network',
 *   network: 'testnet2',
 * });
 * const { sphere } = await Sphere.init({ ...providers, network: 'testnet2', autoGenerate: true });
 *
 * // Payments: coinId is the 64-hex coin id, not a symbol
 * await TokenRegistry.waitForReady();
 * const coinId = getCoinIdBySymbol('UCT');
 * if (coinId) await sphere.payments.send({ coinId, amount: '1000000', recipient: '@alice' });
 *
 * // Communications
 * await sphere.communications.sendDM('@bob', 'Hello!');
 *
 * // Events: handlers receive the payload itself
 * sphere.on('transfer:incoming', (transfer) => console.log(transfer.senderPubkey));
 *
 * // Cleanup (TokenRegistry.destroy() stops the process-wide registry timer so Node can exit)
 * await sphere.destroy();
 * TokenRegistry.destroy();
 * ```
 *
 * @packageDocumentation
 */

// =============================================================================
// Core
// =============================================================================

export { Sphere, createSphere, loadSphere, initSphere, sphereExists, checkNetworkHealth, logger, SphereError, PartialSendConflictError, isSphereError, isPossiblyCommittedSendOutcome, NO_PAYMENTS } from './core';
export { signMessage, verifySignedMessage, hashSignMessage, recoverPubkeyFromSignature, SIGN_MESSAGE_PREFIX } from './core/crypto';
export type {
  SphereCreateOptions,
  SphereLoadOptions,
  SphereInitOptions,
  SphereInitResult,
  SphereImportOptions,
  WalletApiTransportConfig,
  WalletApiOption,
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

// NFT metadata (#785; normative spec docs/NFT-METADATA.md): the shapes
// `payments.mintNft()` / `nft()` / `nfts()` take and return, and the codec a
// viewer needs to render a payload or check a linked file.
export type { MintNftRequest, NftView } from './modules/payments-v2/api';
export type {
  NftAttribute,
  NftContent,
  NftLink,
  NftMedia,
  NftMediaRef,
  NftMetadata,
  NftSignatureContext,
  NftSignatureStatus,
} from './token-engine/nft-payload';
export {
  NFT_DOCUMENT_MEDIA_TYPE,
  NFT_LINK_TAG,
  NFT_MEDIA_TAG,
  NFT_METADATA_TAG,
  NFT_SIGNED_TAG,
  encodeNftContent,
  isNftDocumentLink,
  parseNftDocument,
  parseNftPayload,
  verifyNftLinkContent,
} from './token-engine/nft-payload';
export { NFT_MAX_PAYLOAD_BYTES } from './modules/payments-v2/mint-nft';

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

// Encryption: CryptoJS AES-256-CBC. encrypt()/decrypt() derive the key with PBKDF2-SHA256
// (100,000 iterations); encryptSimple()/encryptMnemonic() use CryptoJS passphrase mode
// (OpenSSL EVP_BytesToKey: MD5, one iteration), which is what the stored seed uses.
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
