/**
 * Sphere - Main SDK Entry Point
 *
 * Handles wallet existence checking, creation, and loading.
 *
 * @example
 * ```ts
 * import { Sphere } from '@unicitylabs/sphere-sdk';
 * import { createLocalStorageProvider, createNostrTransportProvider, createUnicityAggregatorProvider } from '@unicitylabs/sphere-sdk/impl/browser';
 *
 * const storage = createLocalStorageProvider();
 * const transport = createNostrTransportProvider();
 * const oracle = createUnicityAggregatorProvider({ url: '/rpc' });
 *
 * // Option 1: Unified init (recommended)
 * const { sphere, created, generatedMnemonic } = await Sphere.init({
 *   storage,
 *   transport,
 *   oracle,
 *   mnemonic: 'your twelve words...', // optional - will load if wallet exists
 *   autoGenerate: true, // generate new mnemonic if needed
 * });
 *
 * if (created && generatedMnemonic) {
 *   console.log('Save this mnemonic:', generatedMnemonic);
 * }
 *
 * // Option 2: Manual create/load
 * if (await Sphere.exists(storage)) {
 *   const sphere = await Sphere.load({ storage, transport, oracle });
 * } else {
 *   const sphere = await Sphere.create({ mnemonic, storage, transport, oracle });
 * }
 *
 * // Use the wallet
 * await sphere.payments.send({ coinId: 'ALPHA', amount: '1000', recipient: '@alice' });
 * ```
 */

import type {
  Identity,
  FullIdentity,
  ProviderStatus,
  ProviderStatusInfo,
  SphereStatus,
  SphereEventType,
  SphereEventMap,
  SphereEventHandler,
  DerivationMode,
  WalletSource,
  WalletInfo,
  WalletJSON,
  WalletJSONExportOptions,
  TrackedAddress,
  TrackedAddressEntry,
} from '../types';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase } from '../storage';
import type { TransportProvider, PeerInfo } from '../transport';
import type { OracleProvider } from '../oracle';
import type { PriceProvider } from '../price';
import { PaymentsModule, createPaymentsModule } from '../modules/payments';
import { CommunicationsModule, createCommunicationsModule } from '../modules/communications';
import { GroupChatModule, createGroupChatModule } from '../modules/groupchat';
import type { GroupChatModuleConfig } from '../modules/groupchat';
import { MarketModule, createMarketModule } from '../modules/market';
import type { MarketModuleConfig } from '../modules/market';
import {
  STORAGE_KEYS_GLOBAL,
  getAddressId,
  DEFAULT_BASE_PATH,
  DEFAULT_ENCRYPTION_KEY,
  NETWORKS,
  type NetworkType,
} from '../constants';
import { TokenRegistry } from '../registry';
import {
  generateMnemonic as generateBip39Mnemonic,
  validateMnemonic as validateBip39Mnemonic,
  identityFromMnemonicSync,
  deriveKeyAtPath,
  deriveAddressInfo,
  getPublicKey,
  sha256,
  publicKeyToAddress,
  type MasterKey,
  type AddressInfo,
} from './crypto';
import { encryptSimple, decryptSimple, decryptWithSalt } from './encryption';
import { scanAddressesImpl } from './scan';
import type { ScanAddressesOptions, ScanAddressesResult } from './scan';
import { vestingClassifier } from '../l1/vesting';
import { generateAddressFromMasterKey } from '../l1/address';
import { isWebSocketConnected } from '../l1/network';
import {
  parseWalletText,
  parseAndDecryptWalletText,
  isWalletTextFormat,
  isTextWalletEncrypted,
  serializeWalletToText,
  serializeEncryptedWalletToText,
  encryptForTextFormat,
} from '../serialization/wallet-text';
import {
  parseWalletDat,
  parseAndDecryptWalletDat,
  isSQLiteDatabase,
  isWalletDatEncrypted,
} from '../serialization/wallet-dat';
import { SigningService } from '@unicitylabs/state-transition-sdk/lib/sign/SigningService';
import { TokenType } from '@unicitylabs/state-transition-sdk/lib/token/TokenType';
import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm';
import { UnmaskedPredicateReference } from '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicateReference';
import { normalizeNametag, isPhoneNumber } from '@unicitylabs/nostr-js-sdk';

export function isValidNametag(nametag: string): boolean {
  if (isPhoneNumber(nametag)) return true;
  return /^[a-z0-9_-]{3,20}$/.test(nametag);
}

import type {
  LegacyFileType,
  DecryptionProgressCallback,
} from '../serialization/types';

// =============================================================================
// Options Types
// =============================================================================

/** Options for creating a new wallet */
export interface SphereCreateOptions {
  /** BIP39 mnemonic (12 or 24 words) */
  mnemonic: string;
  /** Custom derivation path (default: m/44'/0'/0') */
  derivationPath?: string;
  /** Optional nametag to register for this wallet (e.g., 'alice' for @alice). Token is auto-minted. */
  nametag?: string;
  /** Storage provider instance */
  storage: StorageProvider;
  /** Optional token storage provider (for IPFS sync) */
  tokenStorage?: TokenStorageProvider<TxfStorageDataBase>;
  /** Transport provider instance */
  transport: TransportProvider;
  /** Oracle provider instance */
  oracle: OracleProvider;
  /** L1 (ALPHA blockchain) configuration */
  l1?: L1Config;
  /** Optional price provider for fiat conversion */
  price?: PriceProvider;
  /**
   * Network type (mainnet, testnet, dev) - informational only.
   * Actual network configuration comes from provider URLs.
   * Use createBrowserProviders({ network: 'testnet' }) to set up testnet providers.
   */
  network?: NetworkType;
  /** Group chat configuration (NIP-29). Omit to disable groupchat. */
  groupChat?: GroupChatModuleConfig | boolean;
  /** Market module configuration. true = enable with defaults, object = custom config. */
  market?: MarketModuleConfig | boolean;
  /** Optional password to encrypt the wallet. If omitted, mnemonic is stored as plaintext. */
  password?: string;
}

/** Options for loading existing wallet */
export interface SphereLoadOptions {
  /** Storage provider instance */
  storage: StorageProvider;
  /** Optional token storage provider (for IPFS sync) */
  tokenStorage?: TokenStorageProvider<TxfStorageDataBase>;
  /** Transport provider instance */
  transport: TransportProvider;
  /** Oracle provider instance */
  oracle: OracleProvider;
  /** L1 (ALPHA blockchain) configuration */
  l1?: L1Config;
  /** Optional price provider for fiat conversion */
  price?: PriceProvider;
  /**
   * Network type (mainnet, testnet, dev) - informational only.
   * Actual network configuration comes from provider URLs.
   * Use createBrowserProviders({ network: 'testnet' }) to set up testnet providers.
   */
  network?: NetworkType;
  /** Group chat configuration (NIP-29). Omit to disable groupchat. */
  groupChat?: GroupChatModuleConfig | boolean;
  /** Market module configuration. true = enable with defaults, object = custom config. */
  market?: MarketModuleConfig | boolean;
  /** Optional password to decrypt the wallet. Must match the password used during creation. */
  password?: string;
}

/** Options for importing a wallet */
export interface SphereImportOptions {
  /** BIP39 mnemonic to import */
  mnemonic?: string;
  /** Or master private key (hex) */
  masterKey?: string;
  /** Chain code for BIP32 (optional) */
  chainCode?: string;
  /** Custom derivation path */
  derivationPath?: string;
  /** Base path for BIP32 derivation (e.g., "m/84'/1'/0'" from wallet.dat) */
  basePath?: string;
  /** Derivation mode: bip32, wif_hmac, legacy_hmac */
  derivationMode?: DerivationMode;
  /** Optional nametag to register for this wallet (e.g., 'alice' for @alice). Token is auto-minted. */
  nametag?: string;
  /** Storage provider instance */
  storage: StorageProvider;
  /** Optional token storage provider */
  tokenStorage?: TokenStorageProvider<TxfStorageDataBase>;
  /** Transport provider instance */
  transport: TransportProvider;
  /** Oracle provider instance */
  oracle: OracleProvider;
  /** L1 (ALPHA blockchain) configuration */
  l1?: L1Config;
  /** Optional price provider for fiat conversion */
  price?: PriceProvider;
  /** Group chat configuration (NIP-29). Omit to disable groupchat. */
  groupChat?: GroupChatModuleConfig | boolean;
  /** Market module configuration. true = enable with defaults, object = custom config. */
  market?: MarketModuleConfig | boolean;
  /** Optional password to encrypt the wallet. If omitted, mnemonic/key is stored as plaintext. */
  password?: string;
}

/** L1 (ALPHA blockchain) configuration */
export interface L1Config {
  /** Fulcrum WebSocket URL (default: wss://fulcrum.alpha.unicity.network:50004) */
  electrumUrl?: string;
  /** Default fee rate in sat/byte (default: 10) */
  defaultFeeRate?: number;
  /** Enable vesting classification (default: true) */
  enableVesting?: boolean;
}

/** Options for unified init (auto-create or load) */
export interface SphereInitOptions {
  /** Storage provider instance */
  storage: StorageProvider;
  /** Transport provider instance */
  transport: TransportProvider;
  /** Oracle provider instance */
  oracle: OracleProvider;
  /** Optional token storage provider (for IPFS sync) */
  tokenStorage?: TokenStorageProvider<TxfStorageDataBase>;
  /** BIP39 mnemonic - if wallet doesn't exist, use this to create */
  mnemonic?: string;
  /** Auto-generate mnemonic if wallet doesn't exist and no mnemonic provided */
  autoGenerate?: boolean;
  /** Custom derivation path (default: m/44'/0'/0') */
  derivationPath?: string;
  /** Optional nametag to register (only on create). Token is auto-minted. */
  nametag?: string;
  /** L1 (ALPHA blockchain) configuration */
  l1?: L1Config;
  /** Optional price provider for fiat conversion */
  price?: PriceProvider;
  /**
   * Network type (mainnet, testnet, dev) - informational only.
   * Actual network configuration comes from provider URLs.
   * Use createBrowserProviders({ network: 'testnet' }) to set up testnet providers.
   */
  network?: NetworkType;
  /**
   * Group chat configuration (NIP-29).
   * - `true`: Enable with network-default relays
   * - `GroupChatModuleConfig`: Enable with custom config
   * - Omit/undefined: No groupchat module
   */
  groupChat?: GroupChatModuleConfig | boolean;
  /** Market module configuration. true = enable with defaults, object = custom config. */
  market?: MarketModuleConfig | boolean;
  /** Optional password to encrypt/decrypt the wallet. If omitted, mnemonic is stored as plaintext. */
  password?: string;
}

/** Result of init operation */
export interface SphereInitResult {
  /** The initialized Sphere instance */
  sphere: Sphere;
  /** Whether wallet was newly created */
  created: boolean;
  /** Generated mnemonic (only if autoGenerate was used) */
  generatedMnemonic?: string;
}

// =============================================================================
// L3 Predicate Address Derivation
// =============================================================================

/** Token type for Unicity network (used for L3 predicate address derivation) */
const UNICITY_TOKEN_TYPE_HEX = 'f8aa13834268d29355ff12183066f0cb902003629bbc5eb9ef0efbe397867509';

/**
 * Derive L3 predicate address (DIRECT://...) from private key
 * Uses UnmaskedPredicateReference for stable wallet address
 */
async function deriveL3PredicateAddress(privateKey: string): Promise<string> {
  const secret = Buffer.from(privateKey, 'hex');
  const signingService = await SigningService.createFromSecret(secret);

  const tokenTypeBytes = Buffer.from(UNICITY_TOKEN_TYPE_HEX, 'hex');
  const tokenType = new TokenType(tokenTypeBytes);

  const predicateRef = UnmaskedPredicateReference.create(
    tokenType,
    signingService.algorithm,
    signingService.publicKey,
    HashAlgorithm.SHA256
  );

  return (await (await predicateRef).toAddress()).toString();
}

// =============================================================================
// Mutable Identity (internal use only)
// =============================================================================

/** Mutable version of FullIdentity for internal state management */
type MutableFullIdentity = {
  -readonly [K in keyof FullIdentity]: FullIdentity[K];
};

// =============================================================================
// Sphere Class
// =============================================================================

export class Sphere {
  // Singleton
  private static instance: Sphere | null = null;

  // State
  private _initialized = false;
  private _identity: MutableFullIdentity | null = null;
  private _masterKey: MasterKey | null = null;
  private _mnemonic: string | null = null;
  private _password: string | null = null;
  private _source: WalletSource = 'unknown';
  private _derivationMode: DerivationMode = 'bip32';
  private _basePath: string = DEFAULT_BASE_PATH;
  private _currentAddressIndex: number = 0;
  /** Registry of all tracked (activated) addresses, keyed by HD index */
  private _trackedAddresses: Map<number, TrackedAddress> = new Map();
  /** Reverse lookup: addressId -> HD index */
  private _addressIdToIndex: Map<string, number> = new Map();
  /** Nametag cache: addressId -> (nametagIndex -> nametag). Separate from tracked addresses. */
  private _addressNametags: Map<string, Map<number, string>> = new Map();
  /** Cached PROXY address (computed once when nametag is set) */
  private _cachedProxyAddress: string | undefined = undefined;

  // Providers
  private _storage: StorageProvider;
  private _tokenStorageProviders: Map<string, TokenStorageProvider<TxfStorageDataBase>> = new Map();
  private _transport: TransportProvider;
  private _oracle: OracleProvider;
  private _priceProvider: PriceProvider | null;

  // Modules
  private _payments: PaymentsModule;
  private _communications: CommunicationsModule;
  private _groupChat: GroupChatModule | null = null;
  private _market: MarketModule | null = null;

  // Events
  private eventHandlers: Map<SphereEventType, Set<SphereEventHandler<SphereEventType>>> = new Map();

  // Provider management
  private _disabledProviders: Set<string> = new Set();
  private _providerEventCleanups: (() => void)[] = [];
  private _lastProviderConnected: Map<string, boolean> = new Map();

  // ===========================================================================
  // Constructor (private)
  // ===========================================================================

  private constructor(
    storage: StorageProvider,
    transport: TransportProvider,
    oracle: OracleProvider,
    tokenStorage?: TokenStorageProvider<TxfStorageDataBase>,
    l1Config?: L1Config,
    priceProvider?: PriceProvider,
    groupChatConfig?: GroupChatModuleConfig,
    marketConfig?: MarketModuleConfig,
  ) {
    this._storage = storage;
    this._transport = transport;
    this._oracle = oracle;
    this._priceProvider = priceProvider ?? null;

    // Initialize token storage providers map
    if (tokenStorage) {
      this._tokenStorageProviders.set(tokenStorage.id, tokenStorage);
    }

    this._payments = createPaymentsModule({ l1: l1Config });
    this._communications = createCommunicationsModule();
    this._groupChat = groupChatConfig ? createGroupChatModule(groupChatConfig) : null;
    this._market = marketConfig ? createMarketModule(marketConfig) : null;
  }

  // ===========================================================================
  // Static Methods - Wallet Management
  // ===========================================================================

  /**
   * Check if wallet exists in storage
   */
  static async exists(storage: StorageProvider): Promise<boolean> {
    try {
      const wasConnected = storage.isConnected();
      if (!wasConnected) {
        await storage.connect();
      }

      try {
        // Check for mnemonic or master_key directly
        // These are saved with 'default' address before identity is set
        const mnemonic = await storage.get(STORAGE_KEYS_GLOBAL.MNEMONIC);
        if (mnemonic) return true;

        const masterKey = await storage.get(STORAGE_KEYS_GLOBAL.MASTER_KEY);
        if (masterKey) return true;

        return false;
      } finally {
        // Always restore original connection state — callers (create, load,
        // import) are responsible for connecting storage when they need it.
        if (!wasConnected) {
          await storage.disconnect();
        }
      }
    } catch {
      return false;
    }
  }

  /**
   * Initialize wallet - auto-loads existing or creates new
   *
   * @example
   * ```ts
   * // Load existing or create with provided mnemonic
   * const { sphere, created } = await Sphere.init({
   *   storage,
   *   transport,
   *   oracle,
   *   mnemonic: 'your twelve words...',
   * });
   *
   * // Load existing or auto-generate new mnemonic
   * const { sphere, created, generatedMnemonic } = await Sphere.init({
   *   storage,
   *   transport,
   *   oracle,
   *   autoGenerate: true,
   * });
   * if (generatedMnemonic) {
   *   console.log('Save this mnemonic:', generatedMnemonic);
   * }
   * ```
   */
  static async init(options: SphereInitOptions): Promise<SphereInitResult> {
    // Configure TokenRegistry in the main bundle context.
    // Factory functions (createBrowserProviders/createNodeProviders) are built as
    // separate bundles by tsup, so their TokenRegistry.configure() call configures
    // a different singleton copy. We must configure the main bundle's copy here.
    Sphere.configureTokenRegistry(options.storage, options.network);

    // Resolve groupChat config: true → use network-default relays
    const groupChat = Sphere.resolveGroupChatConfig(options.groupChat, options.network);
    const market = Sphere.resolveMarketConfig(options.market);

    const walletExists = await Sphere.exists(options.storage);

    if (walletExists) {
      // Load existing wallet
      const sphere = await Sphere.load({
        storage: options.storage,
        transport: options.transport,
        oracle: options.oracle,
        tokenStorage: options.tokenStorage,
        l1: options.l1,
        price: options.price,
        groupChat,
        market,
        password: options.password,
      });
      return { sphere, created: false };
    }

    // Need to create new wallet
    let mnemonic = options.mnemonic;
    let generatedMnemonic: string | undefined;

    if (!mnemonic) {
      if (options.autoGenerate) {
        // Auto-generate mnemonic
        mnemonic = Sphere.generateMnemonic();
        generatedMnemonic = mnemonic;
      } else {
        throw new Error(
          'No wallet exists and no mnemonic provided. ' +
          'Provide a mnemonic or set autoGenerate: true.'
        );
      }
    }

    const sphere = await Sphere.create({
      mnemonic,
      storage: options.storage,
      transport: options.transport,
      oracle: options.oracle,
      tokenStorage: options.tokenStorage,
      derivationPath: options.derivationPath,
      nametag: options.nametag,
      l1: options.l1,
      price: options.price,
      groupChat,
      market,
      password: options.password,
    });

    return { sphere, created: true, generatedMnemonic };
  }

  /**
   * Resolve groupChat config from init/create/load options.
   * - `true` → use network-default relays
   * - `GroupChatModuleConfig` → pass through
   * - `undefined` → no groupchat
   */
  /**
   * Resolve GroupChat config from Sphere.init() options.
   * Note: impl/shared/resolvers.ts has a similar resolver for provider-level config
   * (different input shape: { enabled?, relays? }). Both fill relay URLs from network defaults.
   */
  private static resolveGroupChatConfig(
    config: GroupChatModuleConfig | boolean | undefined,
    network?: NetworkType,
  ): GroupChatModuleConfig | undefined {
    if (!config) return undefined;
    if (config === true) {
      const netConfig = network ? NETWORKS[network] : NETWORKS.mainnet;
      return { relays: [...netConfig.groupRelays] };
    }
    // If relays not specified, fill from network defaults
    if (!config.relays || config.relays.length === 0) {
      const netConfig = network ? NETWORKS[network] : NETWORKS.mainnet;
      return { ...config, relays: [...netConfig.groupRelays] };
    }
    return config;
  }

  /**
   * Resolve market module config from Sphere.init() options.
   * - `true` → enable with default API URL
   * - `MarketModuleConfig` → pass through
   * - `undefined` → no market module
   */
  private static resolveMarketConfig(
    config: MarketModuleConfig | boolean | undefined,
  ): MarketModuleConfig | undefined {
    if (!config) return undefined;
    if (config === true) return {};
    return config;
  }

  /**
   * Configure TokenRegistry in the main bundle context.
   *
   * The provider factory functions (createBrowserProviders / createNodeProviders)
   * are compiled into separate bundles by tsup, each with their own inlined copy
   * of TokenRegistry. Their TokenRegistry.configure() call configures a different
   * singleton than the one used by PaymentsModule (which lives in the main bundle).
   * This method ensures the main bundle's TokenRegistry is properly configured.
   */
  private static configureTokenRegistry(storage: StorageProvider, network?: NetworkType): void {
    const netConfig = network ? NETWORKS[network] : NETWORKS.testnet;
    TokenRegistry.configure({ remoteUrl: netConfig.tokenRegistryUrl, storage });
  }

  /**
   * Create new wallet with mnemonic
   */
  static async create(options: SphereCreateOptions): Promise<Sphere> {
    // Validate mnemonic
    if (!options.mnemonic || !Sphere.validateMnemonic(options.mnemonic)) {
      throw new Error('Invalid mnemonic');
    }

    // Check if wallet already exists
    if (await Sphere.exists(options.storage)) {
      throw new Error('Wallet already exists. Use Sphere.load() or Sphere.clear() first.');
    }

    // exists() restores original (disconnected) state — reconnect for writes
    if (!options.storage.isConnected()) {
      await options.storage.connect();
    }

    // Configure TokenRegistry in main bundle context (see init() for details)
    Sphere.configureTokenRegistry(options.storage, options.network);

    const groupChatConfig = Sphere.resolveGroupChatConfig(options.groupChat, options.network);
    const marketConfig = Sphere.resolveMarketConfig(options.market);

    const sphere = new Sphere(
      options.storage,
      options.transport,
      options.oracle,
      options.tokenStorage,
      options.l1,
      options.price,
      groupChatConfig,
      marketConfig,
    );
    sphere._password = options.password ?? null;

    // Store mnemonic (encrypted if password provided, plaintext otherwise)
    await sphere.storeMnemonic(options.mnemonic, options.derivationPath);

    // Initialize identity from mnemonic
    await sphere.initializeIdentityFromMnemonic(options.mnemonic, options.derivationPath);

    // Initialize everything
    await sphere.initializeProviders();
    await sphere.initializeModules();

    // Mark wallet as created only after successful initialization
    // This prevents "Wallet already exists" errors if init fails partway through
    await sphere.finalizeWalletCreation();

    sphere._initialized = true;
    Sphere.instance = sphere;

    // Track address 0 in the registry
    await sphere.ensureAddressTracked(0);

    // Register nametag if provided, otherwise try recovery then publish
    if (options.nametag) {
      // registerNametag publishes identity binding WITH nametag atomically
      // (calling syncIdentityWithTransport before this would race — both replaceable
      // events get the same created_at second and relay keeps the one without nametag)
      await sphere.registerNametag(options.nametag);
    } else {
      // Try to recover nametag BEFORE publishing — publishIdentityBinding uses
      // kind 30078 (replaceable event), so a bare binding would overwrite the
      // existing one that contains encrypted_nametag, making recovery impossible.
      await sphere.recoverNametagFromTransport();
      // Now publish identity binding (with recovered nametag if found)
      await sphere.syncIdentityWithTransport();
    }

    return sphere;
  }

  /**
   * Load existing wallet from storage
   */
  static async load(options: SphereLoadOptions): Promise<Sphere> {
    // Check if wallet exists
    if (!(await Sphere.exists(options.storage))) {
      throw new Error('No wallet found. Use Sphere.create() to create a new wallet.');
    }

    // Configure TokenRegistry in main bundle context (see init() for details)
    Sphere.configureTokenRegistry(options.storage, options.network);

    const groupChatConfig = Sphere.resolveGroupChatConfig(options.groupChat, options.network);
    const marketConfig = Sphere.resolveMarketConfig(options.market);

    const sphere = new Sphere(
      options.storage,
      options.transport,
      options.oracle,
      options.tokenStorage,
      options.l1,
      options.price,
      groupChatConfig,
      marketConfig,
    );
    sphere._password = options.password ?? null;

    // exists() restores original (disconnected) state — reconnect for reads
    if (!options.storage.isConnected()) {
      await options.storage.connect();
    }

    // Load identity from storage
    await sphere.loadIdentityFromStorage();

    // Initialize everything
    await sphere.initializeProviders();
    await sphere.initializeModules();

    // Publish identity binding via transport
    await sphere.syncIdentityWithTransport();

    sphere._initialized = true;
    Sphere.instance = sphere;

    // If nametag name exists but token is missing, try to mint it.
    // This handles the case where the token was lost from IndexedDB.
    if (sphere._identity?.nametag && !sphere._payments.hasNametag()) {
      console.log(`[Sphere] Nametag @${sphere._identity.nametag} has no token, attempting to mint...`);
      try {
        const result = await sphere.mintNametag(sphere._identity.nametag);
        if (result.success) {
          console.log(`[Sphere] Nametag token minted successfully on load`);
        } else {
          console.warn(`[Sphere] Could not mint nametag token: ${result.error}`);
        }
      } catch (err) {
        console.warn(`[Sphere] Nametag token mint failed:`, err);
      }
    }

    return sphere;
  }

  /**
   * Import wallet from mnemonic or master key
   */
  static async import(options: SphereImportOptions): Promise<Sphere> {
    if (!options.mnemonic && !options.masterKey) {
      throw new Error('Either mnemonic or masterKey is required');
    }

    console.log('[Sphere.import] Starting import...');

    // Clear existing wallet if any (including token data).
    // Skip if no active instance and wallet doesn't exist — avoids redundant
    // tokenStorage.clear() which deletes/reopens IndexedDB and can race with
    // a subsequent initialize().
    const needsClear = Sphere.instance !== null || await Sphere.exists(options.storage);
    if (needsClear) {
      console.log('[Sphere.import] Clearing existing wallet data...');
      await Sphere.clear({ storage: options.storage, tokenStorage: options.tokenStorage });
      console.log('[Sphere.import] Clear done');
    } else {
      console.log('[Sphere.import] No existing wallet — skipping clear');
    }

    // Ensure storage is connected (clear may have called destroy() on the
    // previous instance which disconnects the shared storage provider)
    if (!options.storage.isConnected()) {
      console.log('[Sphere.import] Reconnecting storage...');
      await options.storage.connect();
      console.log('[Sphere.import] Storage reconnected');
    }

    const groupChatConfig = Sphere.resolveGroupChatConfig(options.groupChat);
    const marketConfig = Sphere.resolveMarketConfig(options.market);

    const sphere = new Sphere(
      options.storage,
      options.transport,
      options.oracle,
      options.tokenStorage,
      options.l1,
      options.price,
      groupChatConfig,
      marketConfig,
    );
    sphere._password = options.password ?? null;

    if (options.mnemonic) {
      // Validate and store mnemonic
      if (!Sphere.validateMnemonic(options.mnemonic)) {
        throw new Error('Invalid mnemonic');
      }
      console.log('[Sphere.import] Storing mnemonic...');
      await sphere.storeMnemonic(options.mnemonic, options.derivationPath, options.basePath);
      console.log('[Sphere.import] Initializing identity from mnemonic...');
      await sphere.initializeIdentityFromMnemonic(options.mnemonic, options.derivationPath);
    } else if (options.masterKey) {
      // Store master key directly
      console.log('[Sphere.import] Storing master key...');
      await sphere.storeMasterKey(
        options.masterKey,
        options.chainCode,
        options.derivationPath,
        options.basePath,
        options.derivationMode
      );
      console.log('[Sphere.import] Initializing identity from master key...');
      await sphere.initializeIdentityFromMasterKey(
        options.masterKey,
        options.chainCode,
        options.derivationPath
      );
    }

    // Initialize everything
    console.log('[Sphere.import] Initializing providers...');
    await sphere.initializeProviders();
    console.log('[Sphere.import] Providers initialized. Initializing modules...');
    await sphere.initializeModules();
    console.log('[Sphere.import] Modules initialized');

    // Try to recover nametag from transport (if no nametag provided and wallet previously had one)
    if (!options.nametag) {
      console.log('[Sphere.import] Recovering nametag from transport...');
      await sphere.recoverNametagFromTransport();
      console.log('[Sphere.import] Nametag recovery done');
      // Publish identity binding (with recovered nametag if found)
      await sphere.syncIdentityWithTransport();
    }

    // Mark wallet as created only after successful initialization
    console.log('[Sphere.import] Finalizing wallet creation...');
    await sphere.finalizeWalletCreation();

    sphere._initialized = true;
    Sphere.instance = sphere;

    // Track address 0 in the registry
    console.log('[Sphere.import] Tracking address 0...');
    await sphere.ensureAddressTracked(0);

    // Register nametag if provided (this overrides any recovered nametag)
    if (options.nametag) {
      console.log('[Sphere.import] Registering nametag...');
      await sphere.registerNametag(options.nametag);
    }

    // Auto-sync with token storage providers (e.g., IPFS) to recover tokens
    if (sphere._tokenStorageProviders.size > 0) {
      try {
        const syncResult = await sphere._payments.sync();
        console.log(`[Sphere.import] Auto-sync: +${syncResult.added} -${syncResult.removed}`);
      } catch (err) {
        console.warn('[Sphere.import] Auto-sync failed (non-fatal):', err);
      }
    }

    console.log('[Sphere.import] Import complete');
    return sphere;
  }

  /**
   * Clear all SDK-owned wallet data from storage.
   *
   * Removes wallet keys, per-address data, and optionally token storage.
   * Does NOT affect application-level data stored outside the SDK.
   *
   * @param storageOrOptions - StorageProvider (backward compatible) or options object
   *
   * @example
   * // New usage (recommended) - clears wallet keys AND token data
   * await Sphere.clear({
   *   storage: providers.storage,
   *   tokenStorage: providers.tokenStorage,
   * });
   *
   * @example
   * // Legacy usage - clears only wallet keys
   * await Sphere.clear(storage);
   */
  static async clear(
    storageOrOptions: StorageProvider | { storage: StorageProvider; tokenStorage?: TokenStorageProvider<TxfStorageDataBase> },
  ): Promise<void> {
    const storage = 'get' in storageOrOptions ? storageOrOptions as StorageProvider : storageOrOptions.storage;
    const tokenStorage = 'get' in storageOrOptions ? undefined : storageOrOptions.tokenStorage;

    // 1. Destroy Sphere instance — flushes pending IPFS writes (saves good
    //    state), then closes all connections. Awaited so IPFS completes
    //    before we delete databases.
    if (Sphere.instance) {
      console.log('[Sphere.clear] Destroying Sphere instance...');
      await Sphere.instance.destroy();
      console.log('[Sphere.clear] Sphere instance destroyed');
    }

    // 2. Clear L1 vesting cache
    console.log('[Sphere.clear] Clearing L1 vesting cache...');
    await vestingClassifier.destroy();

    // 3. Yield to let IndexedDB finalize pending transactions after close().
    //    db.close() is synchronous but the connection isn't fully released
    //    until all in-flight transactions complete. Without this yield,
    //    deleteDatabase() fires onblocked.
    console.log('[Sphere.clear] Yielding 50ms for IDB transaction settlement...');
    await new Promise((r) => setTimeout(r, 50));

    // 4. Delete token databases (sphere-token-storage-*)
    if (tokenStorage?.clear) {
      console.log('[Sphere.clear] Clearing token storage...');
      try {
        await tokenStorage.clear();
        console.log('[Sphere.clear] Token storage cleared');
      } catch (err) {
        console.warn('[Sphere.clear] Token storage clear failed:', err);
      }
    } else {
      console.log('[Sphere.clear] No token storage provider to clear');
    }

    // 5. Delete KV database (sphere-storage)
    console.log('[Sphere.clear] Clearing KV storage...');
    if (!storage.isConnected()) {
      try {
        await storage.connect();
      } catch {
        // May fail if database was already deleted — that's fine
      }
    }
    if (storage.isConnected()) {
      await storage.clear();
      console.log('[Sphere.clear] KV storage cleared');
    } else {
      console.log('[Sphere.clear] KV storage not connected, skipping');
    }
    console.log('[Sphere.clear] Done');
  }

  /**
   * Get current instance
   */
  static getInstance(): Sphere | null {
    return Sphere.instance;
  }

  /**
   * Check if initialized
   */
  static isInitialized(): boolean {
    return Sphere.instance?._initialized ?? false;
  }

  /**
   * Validate mnemonic using BIP39
   */
  static validateMnemonic(mnemonic: string): boolean {
    return validateBip39Mnemonic(mnemonic);
  }

  /**
   * Generate new BIP39 mnemonic
   * @param strength - 128 for 12 words, 256 for 24 words
   */
  static generateMnemonic(strength: 128 | 256 = 128): string {
    return generateBip39Mnemonic(strength);
  }

  // ===========================================================================
  // Public Properties - Modules
  // ===========================================================================

  /** Payments module (L3 + L1) */
  get payments(): PaymentsModule {
    this.ensureReady();
    return this._payments;
  }

  /** Communications module */
  get communications(): CommunicationsModule {
    this.ensureReady();
    return this._communications;
  }

  /** Group chat module (NIP-29). Null if not configured. */
  get groupChat(): GroupChatModule | null {
    return this._groupChat;
  }

  /** Market module (intent bulletin board). Null if not configured. */
  get market(): MarketModule | null {
    return this._market;
  }

  // ===========================================================================
  // Public Properties - State
  // ===========================================================================

  /** Current identity (public info only) */
  get identity(): Identity | null {
    if (!this._identity) return null;
    return {
      chainPubkey: this._identity.chainPubkey,
      l1Address: this._identity.l1Address,
      directAddress: this._identity.directAddress,
      ipnsName: this._identity.ipnsName,
      nametag: this._identity.nametag,
    };
  }

  /** Is ready */
  get isReady(): boolean {
    return this._initialized;
  }

  // ===========================================================================
  // Public Methods - Providers Access
  // ===========================================================================

  getStorage(): StorageProvider {
    return this._storage;
  }

  /**
   * Get first token storage provider (for backward compatibility)
   * @deprecated Use getTokenStorageProviders() for multiple providers
   */
  getTokenStorage(): TokenStorageProvider<TxfStorageDataBase> | undefined {
    const providers = Array.from(this._tokenStorageProviders.values());
    return providers.length > 0 ? providers[0] : undefined;
  }

  /**
   * Get all token storage providers
   */
  getTokenStorageProviders(): Map<string, TokenStorageProvider<TxfStorageDataBase>> {
    return new Map(this._tokenStorageProviders);
  }

  /**
   * Add a token storage provider dynamically (e.g., from UI)
   * Provider will be initialized and connected automatically
   */
  async addTokenStorageProvider(provider: TokenStorageProvider<TxfStorageDataBase>): Promise<void> {
    if (this._tokenStorageProviders.has(provider.id)) {
      throw new Error(`Token storage provider '${provider.id}' already exists`);
    }

    // Set identity if wallet is initialized
    if (this._identity) {
      provider.setIdentity(this._identity);
      await provider.initialize();
    }

    this._tokenStorageProviders.set(provider.id, provider);

    // Update payments module with new providers
    if (this._initialized) {
      this._payments.updateTokenStorageProviders(this._tokenStorageProviders);
    }
  }

  /**
   * Remove a token storage provider dynamically
   */
  async removeTokenStorageProvider(providerId: string): Promise<boolean> {
    const provider = this._tokenStorageProviders.get(providerId);
    if (!provider) {
      return false;
    }

    // Shutdown provider gracefully
    await provider.shutdown();

    this._tokenStorageProviders.delete(providerId);

    // Update payments module
    if (this._initialized) {
      this._payments.updateTokenStorageProviders(this._tokenStorageProviders);
    }

    return true;
  }

  /**
   * Check if a token storage provider is registered
   */
  hasTokenStorageProvider(providerId: string): boolean {
    return this._tokenStorageProviders.has(providerId);
  }

  /**
   * Set or update the price provider after initialization
   */
  setPriceProvider(provider: PriceProvider): void {
    this._priceProvider = provider;
    this._payments.setPriceProvider(provider);
  }

  getTransport(): TransportProvider {
    return this._transport;
  }

  getAggregator(): OracleProvider {
    return this._oracle;
  }

  /**
   * Check if wallet has BIP32 master key for HD derivation
   */
  hasMasterKey(): boolean {
    return this._masterKey !== null;
  }

  // ===========================================================================
  // Public Methods - Multi-Address Derivation
  // ===========================================================================

  /**
   * Get the base derivation path used by this wallet (e.g., "m/44'/0'/0'")
   */
  getBasePath(): string {
    return this._basePath;
  }

  /**
   * Get the default address path (first external address)
   * Returns path like "m/44'/0'/0'/0/0"
   */
  getDefaultAddressPath(): string {
    return `${this._basePath}/0/0`;
  }

  /**
   * Get current derivation mode
   */
  getDerivationMode(): DerivationMode {
    return this._derivationMode;
  }

  /**
   * Get the mnemonic phrase (for backup purposes)
   * Returns null if wallet was imported from file (masterKey only)
   */
  getMnemonic(): string | null {
    return this._mnemonic;
  }

  /**
   * Get wallet info for backup/export purposes
   */
  getWalletInfo(): WalletInfo {
    let address0: string | null = null;
    try {
      if (this._masterKey) {
        address0 = this.deriveAddress(0).address;
      } else if (this._identity) {
        address0 = this._identity.l1Address;
      }
    } catch {
      // Ignore errors
    }

    return {
      source: this._source,
      hasMnemonic: this._mnemonic !== null,
      hasChainCode: !!this._masterKey?.chainCode,
      derivationMode: this._derivationMode,
      basePath: this._basePath,
      address0,
    };
  }

  /**
   * Export wallet to JSON format for backup
   *
   * @example
   * ```ts
   * // Export with mnemonic (if available)
   * const json = sphere.exportToJSON();
   *
   * // Export with encryption
   * const encrypted = sphere.exportToJSON({ password: 'secret' });
   *
   * // Export multiple addresses
   * const multi = sphere.exportToJSON({ addressCount: 5 });
   * ```
   */
  exportToJSON(options: WalletJSONExportOptions = {}): WalletJSON {
    this.ensureReady();

    if (!this._masterKey && !this._identity) {
      throw new Error('Wallet not initialized');
    }

    // Build addresses array
    const addressCount = options.addressCount || 1;
    const addresses: Array<{
      address: string;
      publicKey: string;
      path: string;
      index: number;
    }> = [];

    for (let i = 0; i < addressCount; i++) {
      try {
        const addr = this.deriveAddress(i, false);
        addresses.push({
          address: addr.address,
          publicKey: addr.publicKey,
          path: addr.path,
          index: addr.index,
        });
      } catch {
        // Stop if we can't derive more addresses (e.g., no masterKey)
        if (i === 0 && this._identity) {
          addresses.push({
            address: this._identity.l1Address,
            publicKey: this._identity.chainPubkey,
            path: this.getDefaultAddressPath(),
            index: 0,
          });
        }
        break;
      }
    }

    // Build wallet data
    let masterPrivateKey: string | undefined;
    let chainCode: string | undefined;

    if (this._masterKey) {
      masterPrivateKey = this._masterKey.privateKey;
      chainCode = this._masterKey.chainCode || undefined;
    }

    // Prepare mnemonic (optionally encrypt)
    let mnemonic: string | undefined;
    let encrypted = false;

    if (this._mnemonic && options.includeMnemonic !== false) {
      if (options.password) {
        mnemonic = encryptSimple(this._mnemonic, options.password);
        encrypted = true;
      } else {
        mnemonic = this._mnemonic;
      }
    }

    // Encrypt master key if password provided
    if (masterPrivateKey && options.password) {
      masterPrivateKey = encryptSimple(masterPrivateKey, options.password);
      encrypted = true;
    }

    return {
      version: '1.0',
      type: 'sphere-wallet',
      createdAt: new Date().toISOString(),
      wallet: {
        masterPrivateKey,
        chainCode,
        addresses,
        isBIP32: this._derivationMode === 'bip32',
        descriptorPath: this._basePath.replace(/^m\//, ''),
      },
      mnemonic,
      encrypted,
      source: this._source,
      derivationMode: this._derivationMode,
    };
  }

  /**
   * Export wallet to text format for backup
   *
   * @example
   * ```ts
   * // Export unencrypted
   * const text = sphere.exportToTxt();
   *
   * // Export with encryption
   * const encrypted = sphere.exportToTxt({ password: 'secret' });
   *
   * // Export multiple addresses
   * const multi = sphere.exportToTxt({ addressCount: 5 });
   * ```
   */
  exportToTxt(options: { password?: string; addressCount?: number } = {}): string {
    this.ensureReady();

    if (!this._masterKey && !this._identity) {
      throw new Error('Wallet not initialized');
    }

    // Build addresses array
    const addressCount = options.addressCount || 1;
    const addresses: Array<{
      index: number;
      address: string;
      path: string;
      isChange: boolean;
    }> = [];

    for (let i = 0; i < addressCount; i++) {
      try {
        const addr = this.deriveAddress(i, false);
        addresses.push({
          address: addr.address,
          path: addr.path,
          index: addr.index,
          isChange: false,
        });
      } catch {
        // Stop if we can't derive more addresses
        if (i === 0 && this._identity) {
          addresses.push({
            address: this._identity.l1Address,
            path: this.getDefaultAddressPath(),
            index: 0,
            isChange: false,
          });
        }
        break;
      }
    }

    const masterPrivateKey = this._masterKey?.privateKey || '';
    const chainCode = this._masterKey?.chainCode || undefined;
    const isBIP32 = this._derivationMode === 'bip32';
    const descriptorPath = this._basePath.replace(/^m\//, '');

    // If password provided, encrypt
    if (options.password) {
      const encryptedMasterKey = encryptForTextFormat(masterPrivateKey, options.password);
      return serializeEncryptedWalletToText({
        encryptedMasterKey,
        chainCode,
        descriptorPath,
        isBIP32,
        addresses,
      });
    }

    // Unencrypted export
    return serializeWalletToText({
      masterPrivateKey,
      chainCode,
      descriptorPath,
      isBIP32,
      addresses,
    });
  }

  /**
   * Import wallet from JSON backup
   *
   * @returns Object with success status and optionally recovered mnemonic
   *
   * @example
   * ```ts
   * const json = '{"version":"1.0",...}';
   * const { success, mnemonic } = await Sphere.importFromJSON({
   *   jsonContent: json,
   *   password: 'secret', // if encrypted
   *   storage, transport, oracle,
   * });
   * ```
   */
  static async importFromJSON(options: {
    jsonContent: string;
    password?: string;
    storage: StorageProvider;
    transport: TransportProvider;
    oracle: OracleProvider;
    tokenStorage?: TokenStorageProvider<TxfStorageDataBase>;
    l1?: L1Config;
  }): Promise<{ success: boolean; mnemonic?: string; error?: string }> {
    try {
      const data = JSON.parse(options.jsonContent) as WalletJSON;

      if (data.version !== '1.0' || data.type !== 'sphere-wallet') {
        return { success: false, error: 'Invalid wallet format' };
      }

      // Decrypt if needed
      let mnemonic = data.mnemonic;
      let masterKey = data.wallet.masterPrivateKey;

      if (data.encrypted && options.password) {
        if (mnemonic) {
          const decrypted = decryptSimple(mnemonic, options.password);
          if (!decrypted) {
            return { success: false, error: 'Failed to decrypt mnemonic - wrong password?' };
          }
          mnemonic = decrypted;
        }
        if (masterKey) {
          const decrypted = decryptSimple(masterKey, options.password);
          if (!decrypted) {
            return { success: false, error: 'Failed to decrypt master key - wrong password?' };
          }
          masterKey = decrypted;
        }
      } else if (data.encrypted && !options.password) {
        return { success: false, error: 'Password required for encrypted wallet' };
      }

      // Determine base path
      const basePath = data.wallet.descriptorPath
        ? `m/${data.wallet.descriptorPath}`
        : DEFAULT_BASE_PATH;

      // Import using mnemonic if available (preferred)
      if (mnemonic) {
        await Sphere.import({
          mnemonic,
          basePath,
          storage: options.storage,
          transport: options.transport,
          oracle: options.oracle,
          tokenStorage: options.tokenStorage,
          l1: options.l1,
        });
        return { success: true, mnemonic };
      }

      // Otherwise import using master key
      if (masterKey) {
        await Sphere.import({
          masterKey,
          chainCode: data.wallet.chainCode,
          basePath,
          derivationMode: data.derivationMode || (data.wallet.isBIP32 ? 'bip32' : 'wif_hmac'),
          storage: options.storage,
          transport: options.transport,
          oracle: options.oracle,
          tokenStorage: options.tokenStorage,
          l1: options.l1,
        });
        return { success: true };
      }

      return { success: false, error: 'No mnemonic or master key in wallet data' };
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : 'Failed to parse wallet JSON',
      };
    }
  }

  /**
   * Import wallet from legacy file (.dat, .txt, or mnemonic text)
   *
   * Supports:
   * - Bitcoin Core wallet.dat files (SQLite format, encrypted or unencrypted)
   * - Text backup files (UNICITY WALLET DETAILS format)
   * - Plain mnemonic text (12 or 24 words)
   *
   * @returns Object with success status, created Sphere instance, and optionally recovered mnemonic
   *
   * @example
   * ```ts
   * // Import from .dat file
   * const fileBuffer = await file.arrayBuffer();
   * const result = await Sphere.importFromLegacyFile({
   *   fileContent: new Uint8Array(fileBuffer),
   *   fileName: 'wallet.dat',
   *   password: 'wallet-password', // if encrypted
   *   storage, transport, oracle,
   * });
   *
   * // Import from .txt file
   * const textContent = await file.text();
   * const result = await Sphere.importFromLegacyFile({
   *   fileContent: textContent,
   *   fileName: 'backup.txt',
   *   storage, transport, oracle,
   * });
   * ```
   */
  static async importFromLegacyFile(options: {
    /** File content - Uint8Array for .dat, string for .txt */
    fileContent: string | Uint8Array;
    /** File name (used for type detection) */
    fileName: string;
    /** Password for encrypted files */
    password?: string;
    /** Progress callback for long decryption operations */
    onDecryptProgress?: DecryptionProgressCallback;
    /** Storage provider instance */
    storage: StorageProvider;
    /** Transport provider instance */
    transport: TransportProvider;
    /** Oracle provider instance */
    oracle: OracleProvider;
    /** Optional token storage provider */
    tokenStorage?: TokenStorageProvider<TxfStorageDataBase>;
    /** Optional nametag to register */
    nametag?: string;
    /** L1 (ALPHA blockchain) configuration */
    l1?: L1Config;
  }): Promise<{
    success: boolean;
    sphere?: Sphere;
    mnemonic?: string;
    needsPassword?: boolean;
    error?: string;
  }> {
    const { fileContent, fileName, password, onDecryptProgress } = options;

    // Detect file type
    const fileType = Sphere.detectLegacyFileType(fileName, fileContent);

    if (fileType === 'unknown') {
      return { success: false, error: 'Unknown file format' };
    }

    // Handle mnemonic text
    if (fileType === 'mnemonic') {
      const mnemonic = (fileContent as string).trim().toLowerCase().split(/\s+/).join(' ');
      if (!Sphere.validateMnemonic(mnemonic)) {
        return { success: false, error: 'Invalid mnemonic phrase' };
      }

      const sphere = await Sphere.import({
        mnemonic,
        storage: options.storage,
        transport: options.transport,
        oracle: options.oracle,
        tokenStorage: options.tokenStorage,
        nametag: options.nametag,
        l1: options.l1,
      });

      return { success: true, sphere, mnemonic };
    }

    // Handle .dat file
    if (fileType === 'dat') {
      const data = fileContent instanceof Uint8Array
        ? fileContent
        : new TextEncoder().encode(fileContent);

      let parseResult;

      if (password) {
        parseResult = await parseAndDecryptWalletDat(data, password, onDecryptProgress);
      } else {
        parseResult = parseWalletDat(data);
      }

      if (parseResult.needsPassword && !password) {
        return { success: false, needsPassword: true, error: 'Password required for encrypted wallet' };
      }

      if (!parseResult.success || !parseResult.data) {
        return { success: false, error: parseResult.error };
      }

      const { masterKey, chainCode, descriptorPath, derivationMode } = parseResult.data;

      // Build base path from descriptor path
      const basePath = descriptorPath ? `m/${descriptorPath}` : DEFAULT_BASE_PATH;

      const sphere = await Sphere.import({
        masterKey,
        chainCode,
        basePath,
        derivationMode: derivationMode || (chainCode ? 'bip32' : 'wif_hmac'),
        storage: options.storage,
        transport: options.transport,
        oracle: options.oracle,
        tokenStorage: options.tokenStorage,
        nametag: options.nametag,
        l1: options.l1,
      });

      return { success: true, sphere };
    }

    // Handle .txt file
    if (fileType === 'txt') {
      const content = typeof fileContent === 'string'
        ? fileContent
        : new TextDecoder().decode(fileContent);

      let parseResult;

      if (password) {
        parseResult = parseAndDecryptWalletText(content, password);
      } else if (isTextWalletEncrypted(content)) {
        return { success: false, needsPassword: true, error: 'Password required for encrypted wallet' };
      } else {
        parseResult = parseWalletText(content);
      }

      if (parseResult.needsPassword && !password) {
        return { success: false, needsPassword: true, error: 'Password required for encrypted wallet' };
      }

      if (!parseResult.success || !parseResult.data) {
        return { success: false, error: parseResult.error };
      }

      const { masterKey, chainCode, descriptorPath, derivationMode } = parseResult.data;

      const basePath = descriptorPath ? `m/${descriptorPath}` : DEFAULT_BASE_PATH;

      const sphere = await Sphere.import({
        masterKey,
        chainCode,
        basePath,
        derivationMode: derivationMode || (chainCode ? 'bip32' : 'wif_hmac'),
        storage: options.storage,
        transport: options.transport,
        oracle: options.oracle,
        tokenStorage: options.tokenStorage,
        nametag: options.nametag,
        l1: options.l1,
      });

      return { success: true, sphere };
    }

    // Handle JSON
    if (fileType === 'json') {
      const content = typeof fileContent === 'string'
        ? fileContent
        : new TextDecoder().decode(fileContent);

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(content);
      } catch {
        return { success: false, error: 'Invalid JSON file' };
      }

      // sphere-wallet format — delegate to importFromJSON
      if (parsed.type === 'sphere-wallet') {
        const result = await Sphere.importFromJSON({
          jsonContent: content,
          password,
          storage: options.storage,
          transport: options.transport,
          oracle: options.oracle,
          tokenStorage: options.tokenStorage,
          l1: options.l1,
        });

        if (result.success) {
          const sphere = Sphere.getInstance();
          return { success: true, sphere: sphere!, mnemonic: result.mnemonic };
        }

        if (!password && result.error?.includes('Password required')) {
          return { success: false, needsPassword: true, error: result.error };
        }

        return { success: false, error: result.error };
      }

      // Legacy flat JSON format (webwallet export)
      let masterKey: string | undefined;
      let mnemonic: string | undefined;

      if (parsed.encrypted && typeof parsed.encrypted === 'object') {
        // Encrypted legacy JSON — needs password + salt-based PBKDF2 decryption
        if (!password) {
          return { success: false, needsPassword: true, error: 'Password required for encrypted wallet' };
        }
        const enc = parsed.encrypted as { masterPrivateKey?: string; mnemonic?: string; salt?: string };
        if (!enc.salt || !enc.masterPrivateKey) {
          return { success: false, error: 'Invalid encrypted wallet format' };
        }
        const decryptedKey = decryptWithSalt(enc.masterPrivateKey, password, enc.salt);
        if (!decryptedKey) {
          return { success: false, error: 'Failed to decrypt - incorrect password?' };
        }
        masterKey = decryptedKey;
        if (enc.mnemonic) {
          mnemonic = decryptWithSalt(enc.mnemonic, password, enc.salt) ?? undefined;
        }
      } else {
        // Unencrypted legacy JSON
        masterKey = parsed.masterPrivateKey as string | undefined;
        mnemonic = parsed.mnemonic as string | undefined;
      }

      if (!masterKey) {
        return { success: false, error: 'No master key found in wallet JSON' };
      }

      const chainCode = parsed.chainCode as string | undefined;
      const descriptorPath = parsed.descriptorPath as string | undefined;
      const derivationMode = (parsed.derivationMode as string | undefined);
      const isBIP32 = derivationMode === 'bip32' || !!chainCode;
      const basePath = descriptorPath
        ? `m/${descriptorPath}`
        : (isBIP32 ? "m/84'/1'/0'" : DEFAULT_BASE_PATH);

      if (mnemonic) {
        const sphere = await Sphere.import({
          mnemonic,
          basePath,
          storage: options.storage,
          transport: options.transport,
          oracle: options.oracle,
          tokenStorage: options.tokenStorage,
          nametag: options.nametag,
          l1: options.l1,
        });
        return { success: true, sphere, mnemonic };
      }

      const sphere = await Sphere.import({
        masterKey,
        chainCode,
        basePath,
        derivationMode: (derivationMode as DerivationMode) || (chainCode ? 'bip32' : 'wif_hmac'),
        storage: options.storage,
        transport: options.transport,
        oracle: options.oracle,
        tokenStorage: options.tokenStorage,
        nametag: options.nametag,
        l1: options.l1,
      });
      return { success: true, sphere };
    }

    return { success: false, error: 'Unsupported file type' };
  }

  /**
   * Detect legacy file type from filename and content
   */
  static detectLegacyFileType(fileName: string, content: string | Uint8Array): LegacyFileType {
    // .dat files are binary
    if (fileName.endsWith('.dat')) {
      return 'dat';
    }

    // Check content for type detection
    const textContent = typeof content === 'string'
      ? content
      : (content.length < 1000 ? new TextDecoder().decode(content) : '');

    // Check for JSON
    if (fileName.endsWith('.json')) {
      return 'json';
    }

    try {
      const trimmed = textContent.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        JSON.parse(trimmed);
        return 'json';
      }
    } catch {
      // Not JSON
    }

    // Check for mnemonic (12 or 24 words)
    const words = textContent.trim().split(/\s+/);
    if (
      (words.length === 12 || words.length === 24) &&
      words.every((w) => /^[a-z]+$/.test(w.toLowerCase()))
    ) {
      return 'mnemonic';
    }

    // Check for text wallet format
    if (isWalletTextFormat(textContent)) {
      return 'txt';
    }

    // Check for SQLite (binary .dat)
    if (content instanceof Uint8Array && isSQLiteDatabase(content)) {
      return 'dat';
    }

    return 'unknown';
  }

  /**
   * Check if a legacy file is encrypted
   */
  static isLegacyFileEncrypted(fileName: string, content: string | Uint8Array): boolean {
    const fileType = Sphere.detectLegacyFileType(fileName, content);

    if (fileType === 'dat' && content instanceof Uint8Array) {
      return isWalletDatEncrypted(content);
    }

    if (fileType === 'txt') {
      const textContent = typeof content === 'string'
        ? content
        : new TextDecoder().decode(content);
      return isTextWalletEncrypted(textContent);
    }

    if (fileType === 'json') {
      try {
        const textContent = typeof content === 'string'
          ? content
          : new TextDecoder().decode(content);
        const data = JSON.parse(textContent);
        return !!data.encrypted;
      } catch {
        return false;
      }
    }

    return false;
  }

  /**
   * Get the current active address index
   *
   * @example
   * ```ts
   * const currentIndex = sphere.getCurrentAddressIndex();
   * console.log(currentIndex); // 0
   *
   * await sphere.switchToAddress(2);
   * console.log(sphere.getCurrentAddressIndex()); // 2
   * ```
   */
  getCurrentAddressIndex(): number {
    return this._currentAddressIndex;
  }

  /**
   * Get primary nametag for a specific address
   *
   * @param addressId - Address identifier (DIRECT://xxx), defaults to current address
   * @returns Primary nametag (index 0) or undefined if not registered
   */
  getNametagForAddress(addressId?: string): string | undefined {
    const id = addressId ?? this._trackedAddresses.get(this._currentAddressIndex)?.addressId;
    if (!id) return undefined;
    return this._addressNametags.get(id)?.get(0);
  }

  /**
   * Get all nametags for a specific address
   *
   * @param addressId - Address identifier (DIRECT://xxx), defaults to current address
   * @returns Map of nametagIndex to nametag, or undefined if no nametags
   */
  getNametagsForAddress(addressId?: string): Map<number, string> | undefined {
    const id = addressId ?? this._trackedAddresses.get(this._currentAddressIndex)?.addressId;
    if (!id) return undefined;
    const nametags = this._addressNametags.get(id);
    return nametags && nametags.size > 0 ? new Map(nametags) : undefined;
  }

  /**
   * Get all registered address nametags
   * @deprecated Use getActiveAddresses() or getAllTrackedAddresses() instead
   * @returns Map of addressId to (nametagIndex -> nametag)
   */
  getAllAddressNametags(): Map<string, Map<number, string>> {
    const result = new Map<string, Map<number, string>>();
    for (const [addressId, nametags] of this._addressNametags.entries()) {
      if (nametags.size > 0) {
        result.set(addressId, new Map(nametags));
      }
    }
    return result;
  }

  /**
   * Get all active (non-hidden) tracked addresses.
   * Returns addresses that have been activated through create, switchToAddress,
   * registerNametag, or nametag recovery.
   *
   * @returns Array of TrackedAddress entries sorted by index, excluding hidden ones
   */
  getActiveAddresses(): TrackedAddress[] {
    this.ensureReady();
    const result: TrackedAddress[] = [];
    for (const entry of this._trackedAddresses.values()) {
      if (!entry.hidden) {
        const nametag = this._addressNametags.get(entry.addressId)?.get(0);
        result.push({ ...entry, nametag });
      }
    }
    return result.sort((a, b) => a.index - b.index);
  }

  /**
   * Get all tracked addresses, including hidden ones.
   *
   * @returns Array of all TrackedAddress entries sorted by index
   */
  getAllTrackedAddresses(): TrackedAddress[] {
    this.ensureReady();
    const result: TrackedAddress[] = [];
    for (const entry of this._trackedAddresses.values()) {
      const nametag = this._addressNametags.get(entry.addressId)?.get(0);
      result.push({ ...entry, nametag });
    }
    return result.sort((a, b) => a.index - b.index);
  }

  /**
   * Get tracked address info by index.
   *
   * @param index - Address index
   * @returns TrackedAddress or undefined if not tracked
   */
  getTrackedAddress(index: number): TrackedAddress | undefined {
    this.ensureReady();
    const entry = this._trackedAddresses.get(index);
    if (!entry) return undefined;
    const nametag = this._addressNametags.get(entry.addressId)?.get(0);
    return { ...entry, nametag };
  }

  /**
   * Set visibility of a tracked address.
   * Hidden addresses are not returned by getActiveAddresses() but remain tracked.
   *
   * @param index - Address index to hide/unhide
   * @param hidden - true to hide, false to show
   * @throws Error if address index is not tracked
   */
  async setAddressHidden(index: number, hidden: boolean): Promise<void> {
    this.ensureReady();
    const entry = this._trackedAddresses.get(index);
    if (!entry) {
      throw new Error(`Address at index ${index} is not tracked. Switch to it first.`);
    }
    if (entry.hidden === hidden) return;

    (entry as { hidden: boolean }).hidden = hidden;
    await this.persistTrackedAddresses();

    const eventType = hidden ? 'address:hidden' : 'address:unhidden';
    this.emitEvent(eventType, { index, addressId: entry.addressId });
  }

  /**
   * Switch to a different address by index
   * This changes the active identity to the derived address at the specified index.
   *
   * @param index - Address index to switch to (0, 1, 2, ...)
   *
   * @example
   * ```ts
   * // Switch to second address
   * await sphere.switchToAddress(1);
   * console.log(sphere.identity?.address); // alpha1... (address at index 1)
   *
   * // Register nametag for this address
   * await sphere.registerNametag('bob');
   *
   * // Switch back to first address
   * await sphere.switchToAddress(0);
   * ```
   */
  async switchToAddress(index: number, options?: { nametag?: string }): Promise<void> {
    this.ensureReady();

    if (!this._masterKey) {
      throw new Error('HD derivation requires master key with chain code. Cannot switch addresses.');
    }

    if (index < 0) {
      throw new Error('Address index must be non-negative');
    }

    // If nametag requested, normalize and validate format early
    const newNametag = options?.nametag ? this.cleanNametag(options.nametag) : undefined;
    if (newNametag && !isValidNametag(newNametag)) {
      throw new Error('Invalid nametag format. Use lowercase alphanumeric, underscore, or hyphen (3-20 chars), or a valid phone number.');
    }

    // Derive the address at the given index
    const addressInfo = this.deriveAddress(index, false);

    // Generate IPNS name from public key hash
    const ipnsHash = sha256(addressInfo.publicKey, 'hex').slice(0, 40);

    // Derive L3 predicate address (DIRECT://...)
    const predicateAddress = await deriveL3PredicateAddress(addressInfo.privateKey);

    // Ensure address is tracked in the registry
    await this.ensureAddressTracked(index);
    const addressId = getAddressId(predicateAddress);

    // If nametag requested, check availability and store it BEFORE building identity
    if (newNametag) {
      const existing = await this._transport.resolveNametag?.(newNametag);
      if (existing) {
        throw new Error(`Nametag @${newNametag} is already taken`);
      }

      // Pre-populate nametag cache so identity is built WITH nametag
      let nametags = this._addressNametags.get(addressId);
      if (!nametags) {
        nametags = new Map();
        this._addressNametags.set(addressId, nametags);
      }
      nametags.set(0, newNametag);
    }

    const nametag = this._addressNametags.get(addressId)?.get(0);

    // Update identity
    this._identity = {
      privateKey: addressInfo.privateKey,
      chainPubkey: addressInfo.publicKey,
      l1Address: addressInfo.address,
      directAddress: predicateAddress,
      ipnsName: '12D3KooW' + ipnsHash,
      nametag,
    };

    // Update current index
    this._currentAddressIndex = index;
    await this._updateCachedProxyAddress();

    // Persist current index
    await this._storage.set(STORAGE_KEYS_GLOBAL.CURRENT_ADDRESS_INDEX, index.toString());

    // Re-initialize providers with new identity
    this._storage.setIdentity(this._identity);
    await this._transport.setIdentity(this._identity);

    // Close current token storage connections, then re-open for new address.
    // Shutdown first prevents leaked IDB connections that block deleteDatabase.
    console.log(`[Sphere] switchToAddress(${index}): re-initializing ${this._tokenStorageProviders.size} token storage provider(s)`);
    for (const [providerId, provider] of this._tokenStorageProviders.entries()) {
      console.log(`[Sphere] switchToAddress(${index}): shutdown provider=${providerId}`);
      await provider.shutdown();
      provider.setIdentity(this._identity);
      console.log(`[Sphere] switchToAddress(${index}): initialize provider=${providerId}`);
      await provider.initialize();
    }

    // Re-initialize modules with new identity
    await this.reinitializeModulesForNewAddress();

    // Sync identity with transport — also recovers nametag from existing Nostr bindings
    // via transport.resolve(directAddress). Skipped when registering a new nametag
    // (that flow handles publishing separately below).
    if (!newNametag) {
      await this.syncIdentityWithTransport();
    }

    // If new nametag was registered, persist cache and mint token
    if (newNametag) {
      await this.persistAddressNametags();

      if (!this._payments.hasNametag()) {
        console.log(`[Sphere] Minting nametag token for @${newNametag}...`);
        try {
          const result = await this.mintNametag(newNametag);
          if (result.success) {
            console.log(`[Sphere] Nametag token minted successfully`);
          } else {
            console.warn(`[Sphere] Could not mint nametag token: ${result.error}`);
          }
        } catch (err) {
          console.warn(`[Sphere] Nametag token mint failed:`, err);
        }
      }

      this.emitEvent('nametag:registered', {
        nametag: newNametag,
        addressIndex: index,
      });
    } else if (this._identity.nametag && !this._payments.hasNametag()) {
      // Existing address with nametag but missing token — mint it
      console.log(`[Sphere] Nametag @${this._identity.nametag} has no token after switch, minting...`);
      try {
        const result = await this.mintNametag(this._identity.nametag);
        if (result.success) {
          console.log(`[Sphere] Nametag token minted successfully after switch`);
        } else {
          console.warn(`[Sphere] Could not mint nametag token after switch: ${result.error}`);
        }
      } catch (err) {
        console.warn(`[Sphere] Nametag token mint failed after switch:`, err);
      }
    }

    this.emitEvent('identity:changed', {
      l1Address: this._identity.l1Address,
      directAddress: this._identity.directAddress,
      chainPubkey: this._identity.chainPubkey,
      nametag: this._identity.nametag,
      addressIndex: index,
    });

    console.log(`[Sphere] Switched to address ${index}:`, this._identity.l1Address);
  }

  /**
   * Re-initialize modules after address switch
   */
  private async reinitializeModulesForNewAddress(): Promise<void> {
    const emitEvent = this.emitEvent.bind(this);

    this._payments.initialize({
      identity: this._identity!,
      storage: this._storage,
      tokenStorageProviders: this._tokenStorageProviders,
      transport: this._transport,
      oracle: this._oracle,
      emitEvent,
      chainCode: this._masterKey?.chainCode || undefined,
      price: this._priceProvider ?? undefined,
    });

    this._communications.initialize({
      identity: this._identity!,
      storage: this._storage,
      transport: this._transport,
      emitEvent,
    });

    this._groupChat?.initialize({
      identity: this._identity!,
      storage: this._storage,
      emitEvent,
    });

    this._market?.initialize({
      identity: this._identity!,
      emitEvent,
    });

    await this._payments.load();
    await this._communications.load();
    await this._groupChat?.load();
    await this._market?.load();

    // After loading from local storage, sync with remote (IPFS) to restore
    // tokens that exist remotely but not locally (e.g. after address switch
    // where the local IndexedDB is empty but IPFS has the data).
    this._payments.sync().catch((err) => {
      console.warn('[Sphere] Post-switch sync failed:', err);
    });
  }

  /**
   * Derive address at a specific index
   *
   * @param index - Address index (0, 1, 2, ...)
   * @param isChange - Whether this is a change address (default: false)
   * @returns Address info with privateKey, publicKey, address, path, index
   *
   * @example
   * ```ts
   * // Derive first receiving address
   * const addr0 = sphere.deriveAddress(0);
   * console.log(addr0.address); // alpha1...
   *
   * // Derive second receiving address
   * const addr1 = sphere.deriveAddress(1);
   *
   * // Derive change address
   * const change = sphere.deriveAddress(0, true);
   * ```
   */
  deriveAddress(index: number, isChange: boolean = false): AddressInfo {
    this.ensureReady();
    return this._deriveAddressInternal(index, isChange);
  }

  /**
   * Internal address derivation without ensureReady() check.
   * Used during initialization (loadTrackedAddresses, ensureAddressTracked)
   * when _initialized is still false.
   */
  private _deriveAddressInternal(index: number, isChange: boolean = false): AddressInfo {
    if (!this._masterKey) {
      throw new Error('HD derivation requires master key with chain code');
    }

    // WIF/HMAC mode: legacy HMAC-SHA512 derivation (no chain code, no change addresses)
    if (this._derivationMode === 'wif_hmac') {
      return generateAddressFromMasterKey(this._masterKey.privateKey, index);
    }

    const info = deriveAddressInfo(
      this._masterKey,
      this._basePath,
      index,
      isChange
    );

    // Convert to proper bech32 address format
    return {
      ...info,
      address: publicKeyToAddress(info.publicKey, 'alpha'),
    };
  }

  /**
   * Derive address at a full BIP32 path
   *
   * @param path - Full BIP32 path like "m/44'/0'/0'/0/5"
   * @returns Address info
   *
   * @example
   * ```ts
   * const addr = sphere.deriveAddressAtPath("m/44'/0'/0'/0/5");
   * ```
   */
  deriveAddressAtPath(path: string): AddressInfo {
    this.ensureReady();

    if (!this._masterKey) {
      throw new Error('HD derivation requires master key with chain code');
    }

    // Parse path to extract index
    const match = path.match(/\/(\d+)$/);
    const index = match ? parseInt(match[1], 10) : 0;

    const derived = deriveKeyAtPath(
      this._masterKey.privateKey,
      this._masterKey.chainCode,
      path
    );

    const publicKey = getPublicKey(derived.privateKey);

    return {
      privateKey: derived.privateKey,
      publicKey,
      address: publicKeyToAddress(publicKey, 'alpha'),
      path,
      index,
    };
  }

  /**
   * Derive multiple addresses starting from index 0
   *
   * @param count - Number of addresses to derive
   * @param includeChange - Include change addresses (default: false)
   * @returns Array of address info
   *
   * @example
   * ```ts
   * // Get first 5 receiving addresses
   * const addresses = sphere.deriveAddresses(5);
   *
   * // Get 5 receiving + 5 change addresses
   * const allAddresses = sphere.deriveAddresses(5, true);
   * ```
   */
  deriveAddresses(count: number, includeChange: boolean = false): AddressInfo[] {
    const addresses: AddressInfo[] = [];

    for (let i = 0; i < count; i++) {
      addresses.push(this.deriveAddress(i, false));
    }

    if (includeChange) {
      for (let i = 0; i < count; i++) {
        addresses.push(this.deriveAddress(i, true));
      }
    }

    return addresses;
  }

  /**
   * Scan blockchain addresses to discover used addresses with balances.
   * Derives addresses sequentially and checks L1 balance via Fulcrum.
   * Uses gap limit to stop after N consecutive empty addresses.
   *
   * @param options - Scanning options
   * @returns Scan results with found addresses and total balance
   *
   * @example
   * ```ts
   * const result = await sphere.scanAddresses({
   *   maxAddresses: 100,
   *   gapLimit: 20,
   *   onProgress: (p) => console.log(`Scanned ${p.scanned}/${p.total}, found ${p.foundCount}`),
   * });
   * console.log(`Found ${result.addresses.length} addresses, total: ${result.totalBalance} ALPHA`);
   * ```
   */
  async scanAddresses(options: ScanAddressesOptions = {}): Promise<ScanAddressesResult> {
    this.ensureReady();

    if (!this._masterKey) {
      throw new Error('Address scanning requires HD master key');
    }

    // Auto-provide nametag resolver from transport if caller didn't supply one
    const resolveNametag = options.resolveNametag ?? (
      this._transport.resolveAddressInfo
        ? async (l1Address: string): Promise<string | null> => {
            try {
              const info = await this._transport.resolveAddressInfo!(l1Address);
              return info?.nametag ?? null;
            } catch { return null; }
          }
        : undefined
    );

    return scanAddressesImpl(
      (index, isChange) => this._deriveAddressInternal(index, isChange),
      { ...options, resolveNametag },
    );
  }

  /**
   * Bulk-track scanned addresses with visibility and nametag data.
   * Selected addresses get `hidden: false`, unselected get `hidden: true`.
   * Performs only 2 storage writes total (tracked addresses + nametags).
   */
  async trackScannedAddresses(
    entries: Array<{ index: number; hidden: boolean; nametag?: string }>,
  ): Promise<void> {
    this.ensureReady();

    for (const { index, hidden, nametag } of entries) {
      const tracked = await this.ensureAddressTracked(index);

      if (nametag) {
        let nametags = this._addressNametags.get(tracked.addressId);
        if (!nametags) {
          nametags = new Map();
          this._addressNametags.set(tracked.addressId, nametags);
        }
        if (!nametags.has(0)) nametags.set(0, nametag);
      }

      if (tracked.hidden !== hidden) {
        (tracked as { hidden: boolean }).hidden = hidden;
      }
    }

    await this.persistTrackedAddresses();
    await this.persistAddressNametags();
  }

  // ===========================================================================
  // Public Methods - Status
  // ===========================================================================

  /**
   * Get aggregated status of all providers, grouped by role.
   *
   * @example
   * ```ts
   * const status = sphere.getStatus();
   * // status.transport[0].connected  // true/false
   * // status.transport[0].metadata?.relays  // { total: 3, connected: 2 }
   * // status.tokenStorage  // all registered token storage providers
   * ```
   */
  getStatus(): SphereStatus {
    const mkInfo = (
      provider: { id: string; name: string; type: string; isConnected(): boolean; getStatus(): ProviderStatus },
      role: ProviderStatusInfo['role'],
      metadata?: Record<string, unknown>,
    ): ProviderStatusInfo => ({
      id: provider.id,
      name: provider.name,
      role,
      status: provider.getStatus(),
      connected: provider.isConnected(),
      enabled: !this._disabledProviders.has(provider.id),
      ...(metadata ? { metadata } : {}),
    });

    // Transport metadata: relay details
    let transportMeta: Record<string, unknown> | undefined;
    const transport = this._transport as unknown as Record<string, unknown>;
    if (typeof transport.getRelays === 'function') {
      const total = (transport.getRelays as () => string[])().length;
      const connected = typeof transport.getConnectedRelays === 'function'
        ? (transport.getConnectedRelays as () => string[])().length
        : 0;
      transportMeta = { relays: { total, connected } };
    }

    // L1 status
    const l1Module = this._payments.l1;
    const l1Providers: ProviderStatusInfo[] = [];
    if (l1Module) {
      const wsConnected = isWebSocketConnected();
      l1Providers.push({
        id: 'l1-alpha',
        name: 'ALPHA L1',
        role: 'l1',
        status: wsConnected ? 'connected' : 'disconnected',
        connected: wsConnected,
        enabled: !this._disabledProviders.has('l1-alpha'),
      });
    }

    // Price
    const priceProviders: ProviderStatusInfo[] = [];
    if (this._priceProvider) {
      priceProviders.push({
        id: this._priceProviderId,
        name: this._priceProvider.platform ?? 'Price',
        role: 'price',
        status: 'connected',
        connected: true,
        enabled: !this._disabledProviders.has(this._priceProviderId),
      });
    }

    return {
      storage: [mkInfo(this._storage, 'storage')],
      tokenStorage: Array.from(this._tokenStorageProviders.values()).map(
        (p) => mkInfo(p, 'token-storage'),
      ),
      transport: [mkInfo(this._transport, 'transport', transportMeta)],
      oracle: [mkInfo(this._oracle, 'oracle')],
      l1: l1Providers,
      price: priceProviders,
    };
  }

  async reconnect(): Promise<void> {
    await this._transport.disconnect();
    await this._transport.connect();
    // connection:changed is emitted automatically by provider event bridge
  }

  // ===========================================================================
  // Public Methods - Provider Management
  // ===========================================================================

  /**
   * Disable a provider at runtime. The provider stays registered but is disconnected
   * and skipped during operations (e.g., sync).
   *
   * Main storage provider cannot be disabled.
   *
   * @returns true if successfully disabled, false if provider not found
   */
  async disableProvider(providerId: string): Promise<boolean> {
    if (providerId === this._storage.id) {
      throw new Error('Cannot disable the main storage provider');
    }

    const provider = this.findProviderById(providerId);
    if (!provider) return false;

    this._disabledProviders.add(providerId);

    try {
      if ('disable' in provider && typeof provider.disable === 'function') {
        // L1PaymentsModule — dedicated disable that disconnects + blocks operations
        provider.disable();
      } else if ('shutdown' in provider && typeof provider.shutdown === 'function') {
        await provider.shutdown();
      } else if ('disconnect' in provider && typeof provider.disconnect === 'function') {
        await provider.disconnect();
      } else if ('clearCache' in provider && typeof provider.clearCache === 'function') {
        // Stateless providers (e.g. PriceProvider) — just clear cache
        provider.clearCache();
      }
    } catch {
      // Provider disconnect may fail — still mark as disabled
    }

    this.emitEvent('connection:changed', {
      provider: providerId,
      connected: false,
      status: 'disconnected',
      enabled: false,
    });

    return true;
  }

  /**
   * Re-enable a previously disabled provider. Reconnects and resumes operations.
   *
   * @returns true if successfully enabled, false if provider not found
   */
  async enableProvider(providerId: string): Promise<boolean> {
    const provider = this.findProviderById(providerId);
    if (!provider) return false;

    this._disabledProviders.delete(providerId);

    // L1 — dedicated enable(), reconnects lazily on next operation
    if ('enable' in provider && typeof provider.enable === 'function') {
      provider.enable();
      this.emitEvent('connection:changed', {
        provider: providerId,
        connected: false,
        status: 'disconnected',
        enabled: true,
      });
      return true;
    }

    // Stateless providers (PriceProvider) — no connect needed
    const hasLifecycle = ('connect' in provider && typeof provider.connect === 'function')
      || ('initialize' in provider && typeof provider.initialize === 'function');

    if (hasLifecycle) {
      try {
        if ('connect' in provider && typeof provider.connect === 'function') {
          await provider.connect();
        } else if ('initialize' in provider && typeof provider.initialize === 'function') {
          await provider.initialize();
        }
      } catch (err) {
        this.emitEvent('connection:changed', {
          provider: providerId,
          connected: false,
          status: 'error',
          enabled: true,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    }

    this.emitEvent('connection:changed', {
      provider: providerId,
      connected: true,
      status: 'connected',
      enabled: true,
    });

    return true;
  }

  /**
   * Check if a provider is currently enabled
   */
  isProviderEnabled(providerId: string): boolean {
    return !this._disabledProviders.has(providerId);
  }

  /**
   * Get the set of disabled provider IDs (for passing to modules)
   */
  getDisabledProviderIds(): ReadonlySet<string> {
    return this._disabledProviders;
  }

  /** Get the price provider's ID (implementation detail — not on PriceProvider interface) */
  private get _priceProviderId(): string {
    if (!this._priceProvider) return 'price';
    const p = this._priceProvider as unknown as Record<string, unknown>;
    return typeof p.id === 'string' ? p.id : 'price';
  }

  /**
   * Find a provider by ID across all provider collections
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private findProviderById(providerId: string): Record<string, any> | null {
    if (this._storage.id === providerId) return this._storage;
    if (this._transport.id === providerId) return this._transport;
    if (this._oracle.id === providerId) return this._oracle;
    if (this._tokenStorageProviders.has(providerId)) {
      return this._tokenStorageProviders.get(providerId)!;
    }
    if (this._priceProvider && this._priceProviderId === providerId) {
      return this._priceProvider;
    }
    if (providerId === 'l1-alpha' && this._payments.l1) {
      return this._payments.l1;
    }
    return null;
  }

  // ===========================================================================
  // Public Methods - Events
  // ===========================================================================

  on<T extends SphereEventType>(type: T, handler: SphereEventHandler<T>): () => void {
    if (!this.eventHandlers.has(type)) {
      this.eventHandlers.set(type, new Set());
    }
    this.eventHandlers.get(type)!.add(handler as SphereEventHandler<SphereEventType>);

    return () => {
      this.eventHandlers.get(type)?.delete(handler as SphereEventHandler<SphereEventType>);
    };
  }

  off<T extends SphereEventType>(type: T, handler: SphereEventHandler<T>): void {
    this.eventHandlers.get(type)?.delete(handler as SphereEventHandler<SphereEventType>);
  }

  // ===========================================================================
  // Public Methods - Sync
  // ===========================================================================

  async sync(): Promise<void> {
    this.ensureReady();
    await this._payments.sync();
  }

  // ===========================================================================
  // Public Methods - Nametag
  // ===========================================================================

  /**
   * Get current nametag (if registered)
   */
  getNametag(): string | undefined {
    return this._identity?.nametag;
  }

  /**
   * Check if nametag is registered
   */
  hasNametag(): boolean {
    return !!this._identity?.nametag;
  }

  /**
   * Get the PROXY address for the current nametag
   * PROXY addresses are derived from the nametag hash and require
   * the nametag token to claim funds sent to them
   * @returns PROXY address string or undefined if no nametag
   */
  getProxyAddress(): string | undefined {
    return this._cachedProxyAddress;
  }

  /**
   * Resolve any identifier to full peer information.
   * Accepts @nametag, bare nametag, DIRECT://, PROXY://, L1 address, or transport pubkey.
   *
   * @example
   * ```ts
   * const peer = await sphere.resolve('@alice');
   * const peer = await sphere.resolve('DIRECT://...');
   * const peer = await sphere.resolve('alpha1...');
   * const peer = await sphere.resolve('ab12cd...'); // 64-char hex transport pubkey
   * ```
   */
  async resolve(identifier: string): Promise<PeerInfo | null> {
    this.ensureReady();
    return this._transport.resolve?.(identifier) ?? null;
  }

  /** Compute and cache the PROXY address from the current nametag */
  private async _updateCachedProxyAddress(): Promise<void> {
    const nametag = this._identity?.nametag;
    if (!nametag) {
      this._cachedProxyAddress = undefined;
      return;
    }
    const { ProxyAddress } = await import('@unicitylabs/state-transition-sdk/lib/address/ProxyAddress');
    const proxyAddr = await ProxyAddress.fromNameTag(nametag);
    this._cachedProxyAddress = proxyAddr.toString();
  }

  /**
   * Register a nametag for the current active address
   * Each address can have its own independent nametag
   *
   * @example
   * ```ts
   * // Register nametag for first address (index 0)
   * await sphere.registerNametag('alice');
   *
   * // Switch to second address and register different nametag
   * await sphere.switchToAddress(1);
   * await sphere.registerNametag('bob');
   *
   * // Now:
   * // - Address 0 has nametag @alice
   * // - Address 1 has nametag @bob
   * ```
   */
  async registerNametag(nametag: string): Promise<void> {
    this.ensureReady();

    // Normalize and validate nametag format
    const cleanNametag = this.cleanNametag(nametag);
    if (!isValidNametag(cleanNametag)) {
      throw new Error('Invalid nametag format. Use lowercase alphanumeric, underscore, or hyphen (3-20 chars), or a valid phone number.');
    }

    // Check if current address already has a nametag
    if (this._identity?.nametag) {
      throw new Error(`Nametag already registered for address ${this._currentAddressIndex}: @${this._identity.nametag}`);
    }

    // Publish identity binding with nametag (updates existing binding event)
    if (this._transport.publishIdentityBinding) {
      const success = await this._transport.publishIdentityBinding(
        this._identity!.chainPubkey,
        this._identity!.l1Address,
        this._identity!.directAddress || '',
        cleanNametag,
      );
      if (!success) {
        throw new Error('Failed to register nametag. It may already be taken.');
      }
    }

    // Update identity
    this._identity!.nametag = cleanNametag;
    await this._updateCachedProxyAddress();

    // Update nametag cache
    const currentAddressId = this._trackedAddresses.get(this._currentAddressIndex)?.addressId;
    if (currentAddressId) {
      let nametags = this._addressNametags.get(currentAddressId);
      if (!nametags) {
        nametags = new Map();
        this._addressNametags.set(currentAddressId, nametags);
      }
      nametags.set(0, cleanNametag);
    }

    // Persist nametag cache
    await this.persistAddressNametags();

    // Mint nametag token on-chain if not already minted
    // Required for receiving tokens via @nametag (PROXY address finalization)
    if (!this._payments.hasNametag()) {
      console.log(`[Sphere] Minting nametag token for @${cleanNametag}...`);
      const result = await this.mintNametag(cleanNametag);
      if (!result.success) {
        console.warn(`[Sphere] Failed to mint nametag token: ${result.error}`);
        // Don't throw - nametag is published via transport, token can be minted later
      } else {
        console.log(`[Sphere] Nametag token minted successfully`);
      }
    }

    this.emitEvent('nametag:registered', {
      nametag: cleanNametag,
      addressIndex: this._currentAddressIndex,
    });
    console.log(`[Sphere] Nametag registered for address ${this._currentAddressIndex}:`, cleanNametag);
  }

  /**
   * Persist tracked addresses to storage (only minimal fields via StorageProvider)
   */
  private async persistTrackedAddresses(): Promise<void> {
    const entries: TrackedAddressEntry[] = [];
    for (const entry of this._trackedAddresses.values()) {
      entries.push({
        index: entry.index,
        hidden: entry.hidden,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      });
    }
    await this._storage.saveTrackedAddresses(entries);
  }

  /**
   * Mint a nametag token on-chain (like Sphere wallet and lottery)
   * This creates the nametag token required for receiving tokens via PROXY addresses (@nametag)
   *
   * @param nametag - The nametag to mint (e.g., "alice" or "@alice")
   * @returns MintNametagResult with success status and token if successful
   *
   * @example
   * ```typescript
   * // Mint nametag token for receiving via @alice
   * const result = await sphere.mintNametag('alice');
   * if (result.success) {
   *   console.log('Nametag minted:', result.nametagData?.name);
   * } else {
   *   console.error('Mint failed:', result.error);
   * }
   * ```
   */
  async mintNametag(nametag: string): Promise<import('../modules/payments').MintNametagResult> {
    this.ensureReady();
    return this._payments.mintNametag(nametag);
  }

  /**
   * Check if a nametag is available for minting
   * @param nametag - The nametag to check (e.g., "alice" or "@alice")
   * @returns true if available, false if taken or error
   */
  async isNametagAvailable(nametag: string): Promise<boolean> {
    this.ensureReady();
    return this._payments.isNametagAvailable(nametag);
  }

  /**
   * Load tracked addresses from storage.
   * Falls back to migrating from old ADDRESS_NAMETAGS format.
   */
  private async loadTrackedAddresses(): Promise<void> {
    this._trackedAddresses.clear();
    this._addressIdToIndex.clear();

    try {
      // Load minimal entries from storage
      const entries = await this._storage.loadTrackedAddresses();
      if (entries.length > 0) {
        for (const stored of entries) {
          // Derive address fields from index (internal: no ensureReady check)
          const addrInfo = this._deriveAddressInternal(stored.index, false);
          const directAddress = await deriveL3PredicateAddress(addrInfo.privateKey);
          const addressId = getAddressId(directAddress);

          const entry: TrackedAddress = {
            ...stored,
            addressId,
            l1Address: addrInfo.address,
            directAddress,
            chainPubkey: addrInfo.publicKey,
          };
          this._trackedAddresses.set(entry.index, entry);
          this._addressIdToIndex.set(addressId, entry.index);
        }
        return;
      }

      // Fall back to old ADDRESS_NAMETAGS format and migrate
      const oldData = await this._storage.get(STORAGE_KEYS_GLOBAL.ADDRESS_NAMETAGS);
      if (oldData) {
        const parsed = JSON.parse(oldData) as Record<string, unknown>;
        await this.migrateFromOldNametagFormat(parsed);
        await this.persistTrackedAddresses();
      }
    } catch {
      // Ignore parse errors - start fresh
    }
  }

  /**
   * Migrate from old ADDRESS_NAMETAGS format to tracked addresses.
   * Scans HD indices 0..19 to match addressIds from the old format.
   * Populates both _trackedAddresses and _addressNametags.
   */
  private async migrateFromOldNametagFormat(
    parsed: Record<string, unknown>
  ): Promise<void> {
    const addressIdToNametags = new Map<string, Record<string, string>>();
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'object' && value !== null) {
        addressIdToNametags.set(key, value as Record<string, string>);
      }
    }

    if (addressIdToNametags.size === 0 || !this._masterKey) return;

    const SCAN_LIMIT = 20;
    for (let i = 0; i < SCAN_LIMIT && addressIdToNametags.size > 0; i++) {
      try {
        const addrInfo = this._deriveAddressInternal(i, false);
        const directAddress = await deriveL3PredicateAddress(addrInfo.privateKey);
        const addressId = getAddressId(directAddress);

        if (addressIdToNametags.has(addressId)) {
          const nametagsObj = addressIdToNametags.get(addressId)!;

          // Populate nametag cache
          const nametagMap = new Map<number, string>();
          for (const [idx, tag] of Object.entries(nametagsObj)) {
            nametagMap.set(parseInt(idx, 10), tag);
          }
          if (nametagMap.size > 0) {
            this._addressNametags.set(addressId, nametagMap);
          }

          // Create tracked address entry
          const now = Date.now();
          const entry: TrackedAddress = {
            index: i,
            addressId,
            l1Address: addrInfo.address,
            directAddress,
            chainPubkey: addrInfo.publicKey,
            nametag: nametagMap.get(0),
            hidden: false,
            createdAt: now,
            updatedAt: now,
          };

          this._trackedAddresses.set(i, entry);
          this._addressIdToIndex.set(addressId, i);
          addressIdToNametags.delete(addressId);
        }
      } catch {
        // Skip indices that fail to derive
      }
    }

    // Persist nametag cache separately
    await this.persistAddressNametags();
  }

  /**
   * Ensure an address is tracked in the registry.
   * If not yet tracked, derives full info and creates the entry.
   */
  private async ensureAddressTracked(index: number): Promise<TrackedAddress> {
    const existing = this._trackedAddresses.get(index);
    if (existing) return existing;

    const addrInfo = this._deriveAddressInternal(index, false);
    const directAddress = await deriveL3PredicateAddress(addrInfo.privateKey);
    const addressId = getAddressId(directAddress);

    const now = Date.now();
    const nametag = this._addressNametags.get(addressId)?.get(0);
    const entry: TrackedAddress = {
      index,
      addressId,
      l1Address: addrInfo.address,
      directAddress,
      chainPubkey: addrInfo.publicKey,
      nametag,
      hidden: false,
      createdAt: now,
      updatedAt: now,
    };

    this._trackedAddresses.set(index, entry);
    this._addressIdToIndex.set(addressId, index);
    await this.persistTrackedAddresses();

    this.emitEvent('address:activated', { address: { ...entry } });
    return entry;
  }

  /**
   * Persist nametag cache to storage.
   * Format: { addressId: { "0": "alice", "1": "alice2" } }
   */
  private async persistAddressNametags(): Promise<void> {
    const result: Record<string, Record<string, string>> = {};
    for (const [addressId, nametags] of this._addressNametags.entries()) {
      const obj: Record<string, string> = {};
      for (const [idx, tag] of nametags.entries()) {
        obj[idx.toString()] = tag;
      }
      result[addressId] = obj;
    }
    await this._storage.set(STORAGE_KEYS_GLOBAL.ADDRESS_NAMETAGS, JSON.stringify(result));
  }

  /**
   * Load nametag cache from storage.
   */
  private async loadAddressNametags(): Promise<void> {
    this._addressNametags.clear();
    try {
      const data = await this._storage.get(STORAGE_KEYS_GLOBAL.ADDRESS_NAMETAGS);
      if (!data) return;
      const parsed = JSON.parse(data) as Record<string, Record<string, string>>;
      for (const [addressId, nametags] of Object.entries(parsed)) {
        const map = new Map<number, string>();
        for (const [idx, tag] of Object.entries(nametags)) {
          map.set(parseInt(idx, 10), tag);
        }
        this._addressNametags.set(addressId, map);
      }
    } catch {
      // Ignore parse errors
    }
  }

  /**
   * Publish identity binding via transport.
   * Always publishes base identity (chainPubkey, l1Address, directAddress).
   * If nametag is set, also publishes nametag hash, proxy address, encrypted nametag.
   */
  private async syncIdentityWithTransport(): Promise<void> {
    if (!this._transport.publishIdentityBinding) {
      return; // Transport doesn't support identity binding
    }

    try {
      // Check if a binding already exists by querying the relay by transport pubkey
      // (= x-only pubkey = chainPubkey without the 02/03 prefix).
      // This finds events in ANY format (old d=hashedNametag and new d=hash(identity:pubkey))
      // because resolve(64-hex) searches by event author, not by tag.
      const transportPubkey = this._identity?.chainPubkey?.slice(2);
      if (transportPubkey && this._transport.resolve) {
        try {
          const existing = await this._transport.resolve(transportPubkey);
          if (existing) {
            // If existing binding has nametag but local state doesn't — recover it
            let recoveredNametag = existing.nametag;
            let fromLegacy = false;

            // Old-format events don't have content.nametag (only encrypted_nametag).
            // Fall back to recoverNametag() which decrypts encrypted_nametag from any event.
            if (!recoveredNametag && !this._identity?.nametag && this._transport.recoverNametag) {
              try {
                recoveredNametag = await this._transport.recoverNametag() ?? undefined;
                if (recoveredNametag) fromLegacy = true;
              } catch {
                // Decryption failed — continue without nametag
              }
            }

            if (recoveredNametag && !this._identity?.nametag) {
              (this._identity as MutableFullIdentity).nametag = recoveredNametag;
              await this._updateCachedProxyAddress();

              const entry = await this.ensureAddressTracked(this._currentAddressIndex);
              let nametags = this._addressNametags.get(entry.addressId);
              if (!nametags) {
                nametags = new Map();
                this._addressNametags.set(entry.addressId, nametags);
              }
              if (!nametags.has(0)) {
                nametags.set(0, recoveredNametag);
                await this.persistAddressNametags();
              }

              this.emitEvent('nametag:recovered', { nametag: recoveredNametag });

              // Re-publish in new format only when migrating from legacy event
              if (fromLegacy) {
                await this._transport.publishIdentityBinding!(
                  this._identity!.chainPubkey,
                  this._identity!.l1Address,
                  this._identity!.directAddress || '',
                  recoveredNametag,
                );
                console.log(`[Sphere] Migrated legacy binding with nametag @${recoveredNametag}`);
                return;
              }
            }

            console.log('[Sphere] Existing binding found, skipping re-publish');
            return;
          }
        } catch (e) {
          // resolve failed — do NOT fall through to publish, as it could
          // overwrite an existing binding (with nametag) with one without.
          // Next reload will retry.
          console.warn('[Sphere] resolve() failed, skipping publish to avoid overwrite', e);
          return;
        }
      }

      // No existing binding — publish for the first time
      const nametag = this._identity?.nametag;
      const success = await this._transport.publishIdentityBinding(
        this._identity!.chainPubkey,
        this._identity!.l1Address,
        this._identity!.directAddress || '',
        nametag || undefined,
      );
      if (success) {
        console.log(`[Sphere] Identity binding published${nametag ? ` with nametag @${nametag}` : ''}`);
      } else if (nametag) {
        console.warn(`[Sphere] Nametag @${nametag} is taken by another pubkey`);
      }
    } catch (error) {
      // Don't fail wallet load on identity sync errors
      console.warn(`[Sphere] Identity binding sync failed:`, error);
    }
  }

  /**
   * Recover nametag from transport after wallet import.
   * Searches for encrypted nametag events authored by this wallet's pubkey
   * and decrypts them to restore the nametag association.
   */
  private async recoverNametagFromTransport(): Promise<void> {
    // Skip if already has a nametag
    if (this._identity?.nametag) {
      return;
    }

    let recoveredNametag: string | null = null;

    // Strategy 1: Decrypt nametag from own Nostr binding events (private-key based)
    if (this._transport.recoverNametag) {
      try {
        recoveredNametag = await this._transport.recoverNametag();
      } catch {
        // Non-fatal — try fallback
      }
    }

    // Strategy 2: Forward lookup by L1 address hash (public, same as scanAddresses).
    // Covers edge cases where the encrypted binding event was lost from relay.
    if (!recoveredNametag && this._transport.resolveAddressInfo && this._identity?.l1Address) {
      try {
        const info = await this._transport.resolveAddressInfo(this._identity.l1Address);
        if (info?.nametag) {
          recoveredNametag = info.nametag;
        }
      } catch {
        // Non-fatal
      }
    }

    if (!recoveredNametag) {
      return;
    }

    try {
      // Update identity with recovered nametag
      if (this._identity) {
        (this._identity as MutableFullIdentity).nametag = recoveredNametag;
        await this._updateCachedProxyAddress();
      }

      // Update nametag cache
      const entry = await this.ensureAddressTracked(this._currentAddressIndex);
      let nametags = this._addressNametags.get(entry.addressId);
      if (!nametags) {
        nametags = new Map();
        this._addressNametags.set(entry.addressId, nametags);
      }
      const nextIndex = nametags.size;
      nametags.set(nextIndex, recoveredNametag);
      await this.persistAddressNametags();

      // Note: no need to re-publish here — callers follow up with
      // syncIdentityWithTransport() which will publish WITH the recovered nametag.

      this.emitEvent('nametag:recovered', { nametag: recoveredNametag });
    } catch {
      // Don't fail wallet import on nametag recovery errors
    }
  }

  /**
   * Strip @ prefix and normalize a nametag (lowercase, phone E.164, strip @unicity suffix).
   */
  private cleanNametag(raw: string): string {
    const stripped = raw.startsWith('@') ? raw.slice(1) : raw;
    return normalizeNametag(stripped);
  }

  // ===========================================================================
  // Public Methods - Lifecycle
  // ===========================================================================

  async destroy(): Promise<void> {
    this.cleanupProviderEventSubscriptions();

    this._payments.destroy();
    this._communications.destroy();
    this._groupChat?.destroy();
    this._market?.destroy();

    await this._transport.disconnect();
    await this._storage.disconnect();
    await this._oracle.disconnect();

    // Shutdown token storage providers (close IndexedDB connections etc.)
    for (const provider of this._tokenStorageProviders.values()) {
      try {
        await provider.shutdown();
      } catch {
        // Non-fatal — provider may already be closed
      }
    }
    this._tokenStorageProviders.clear();

    this._initialized = false;
    this._identity = null;
    this._trackedAddresses.clear();
    this._addressIdToIndex.clear();
    this._addressNametags.clear();
    this._disabledProviders.clear();
    this.eventHandlers.clear();

    if (Sphere.instance === this) {
      Sphere.instance = null;
    }
  }

  // ===========================================================================
  // Private: Storage
  // ===========================================================================

  private async storeMnemonic(mnemonic: string, derivationPath?: string, basePath?: string): Promise<void> {
    // TODO: Encrypt with user password/PIN
    const encrypted = this.encrypt(mnemonic);
    await this._storage.set(STORAGE_KEYS_GLOBAL.MNEMONIC, encrypted);

    // Store mnemonic in memory for getMnemonic()
    this._mnemonic = mnemonic;
    this._source = 'mnemonic';
    this._derivationMode = 'bip32';

    if (derivationPath) {
      await this._storage.set(STORAGE_KEYS_GLOBAL.DERIVATION_PATH, derivationPath);
    }

    const effectiveBasePath = basePath ?? DEFAULT_BASE_PATH;
    this._basePath = effectiveBasePath;
    await this._storage.set(STORAGE_KEYS_GLOBAL.BASE_PATH, effectiveBasePath);
    await this._storage.set(STORAGE_KEYS_GLOBAL.DERIVATION_MODE, this._derivationMode);
    await this._storage.set(STORAGE_KEYS_GLOBAL.WALLET_SOURCE, this._source);
    // Note: WALLET_EXISTS is set in finalizeWalletCreation() after successful initialization
  }

  private async storeMasterKey(
    masterKey: string,
    chainCode?: string,
    derivationPath?: string,
    basePath?: string,
    derivationMode?: DerivationMode
  ): Promise<void> {
    const encrypted = this.encrypt(masterKey);
    await this._storage.set(STORAGE_KEYS_GLOBAL.MASTER_KEY, encrypted);

    // Set source and derivation mode
    this._source = 'file';
    this._mnemonic = null;

    // Determine derivation mode from chain code if not specified
    if (derivationMode) {
      this._derivationMode = derivationMode;
    } else {
      this._derivationMode = chainCode ? 'bip32' : 'wif_hmac';
    }

    if (chainCode) {
      await this._storage.set(STORAGE_KEYS_GLOBAL.CHAIN_CODE, chainCode);
    }

    if (derivationPath) {
      await this._storage.set(STORAGE_KEYS_GLOBAL.DERIVATION_PATH, derivationPath);
    }

    const effectiveBasePath = basePath ?? DEFAULT_BASE_PATH;
    this._basePath = effectiveBasePath;
    await this._storage.set(STORAGE_KEYS_GLOBAL.BASE_PATH, effectiveBasePath);
    await this._storage.set(STORAGE_KEYS_GLOBAL.DERIVATION_MODE, this._derivationMode);
    await this._storage.set(STORAGE_KEYS_GLOBAL.WALLET_SOURCE, this._source);
    // Note: WALLET_EXISTS is set in finalizeWalletCreation() after successful initialization
  }

  /**
   * Mark wallet as fully created (after successful initialization)
   * This is called at the end of create()/import() to ensure wallet is only
   * marked as existing after all initialization steps succeed.
   */
  private async finalizeWalletCreation(): Promise<void> {
    await this._storage.set(STORAGE_KEYS_GLOBAL.WALLET_EXISTS, 'true');
  }

  // ===========================================================================
  // Private: Identity Initialization
  // ===========================================================================

  private async loadIdentityFromStorage(): Promise<void> {
    // Load keys that are saved with 'default' address (before identity is set)
    const encryptedMnemonic = await this._storage.get(STORAGE_KEYS_GLOBAL.MNEMONIC);
    const encryptedMasterKey = await this._storage.get(STORAGE_KEYS_GLOBAL.MASTER_KEY);
    const chainCode = await this._storage.get(STORAGE_KEYS_GLOBAL.CHAIN_CODE);
    const derivationPath = await this._storage.get(STORAGE_KEYS_GLOBAL.DERIVATION_PATH);
    const savedBasePath = await this._storage.get(STORAGE_KEYS_GLOBAL.BASE_PATH);
    const savedDerivationMode = await this._storage.get(STORAGE_KEYS_GLOBAL.DERIVATION_MODE);
    const savedSource = await this._storage.get(STORAGE_KEYS_GLOBAL.WALLET_SOURCE);
    const savedAddressIndex = await this._storage.get(STORAGE_KEYS_GLOBAL.CURRENT_ADDRESS_INDEX);

    // Restore wallet metadata
    this._basePath = savedBasePath ?? DEFAULT_BASE_PATH;
    this._derivationMode = (savedDerivationMode as DerivationMode) ?? 'bip32';
    this._source = (savedSource as WalletSource) ?? 'unknown';
    this._currentAddressIndex = savedAddressIndex ? parseInt(savedAddressIndex, 10) : 0;

    if (encryptedMnemonic) {
      const mnemonic = this.decrypt(encryptedMnemonic);
      if (!mnemonic) {
        throw new Error('Failed to decrypt mnemonic');
      }
      this._mnemonic = mnemonic;
      this._source = 'mnemonic';
      await this.initializeIdentityFromMnemonic(mnemonic, derivationPath ?? undefined);
    } else if (encryptedMasterKey) {
      const masterKey = this.decrypt(encryptedMasterKey);
      if (!masterKey) {
        throw new Error('Failed to decrypt master key');
      }
      this._mnemonic = null;
      if (this._source === 'unknown') {
        this._source = 'file';
      }
      await this.initializeIdentityFromMasterKey(
        masterKey,
        chainCode ?? undefined,
        derivationPath ?? undefined
      );
    } else {
      throw new Error('No wallet data found in storage');
    }

    // Now that identity is restored, set it on storage so subsequent reads use correct address
    if (this._identity) {
      this._storage.setIdentity(this._identity);
    }

    // Load tracked addresses registry (with migration from old format)
    await this.loadTrackedAddresses();
    // Load nametag cache
    await this.loadAddressNametags();

    // Ensure current address is tracked
    const trackedEntry = await this.ensureAddressTracked(this._currentAddressIndex);
    const nametag = this._addressNametags.get(trackedEntry.addressId)?.get(0);

    // If we have a saved address index > 0 and master key, re-derive identity
    if (this._currentAddressIndex > 0 && this._masterKey) {
      const addressInfo = this._deriveAddressInternal(this._currentAddressIndex, false);
      const ipnsHash = sha256(addressInfo.publicKey, 'hex').slice(0, 40);
      const predicateAddress = await deriveL3PredicateAddress(addressInfo.privateKey);

      this._identity = {
        privateKey: addressInfo.privateKey,
        chainPubkey: addressInfo.publicKey,
        l1Address: addressInfo.address,
        directAddress: predicateAddress,
        ipnsName: '12D3KooW' + ipnsHash,
        nametag,
      };
      this._storage.setIdentity(this._identity);
      console.log(`[Sphere] Restored to address ${this._currentAddressIndex}:`, this._identity.l1Address);
    } else if (this._identity && nametag) {
      // Restore nametag from cache
      this._identity.nametag = nametag;
    }
    await this._updateCachedProxyAddress();
  }

  private async initializeIdentityFromMnemonic(
    mnemonic: string,
    derivationPath?: string
  ): Promise<void> {
    // Use base path (e.g., m/44'/0'/0') and append chain/index
    const basePath = derivationPath ?? DEFAULT_BASE_PATH;
    const fullPath = `${basePath}/0/0`;

    // Generate master key from mnemonic using BIP39/BIP32
    const masterKey = identityFromMnemonicSync(mnemonic);

    // Derive key at full path (e.g., m/44'/0'/0'/0/0)
    const derivedKey = deriveKeyAtPath(
      masterKey.privateKey,
      masterKey.chainCode,
      fullPath
    );

    // Get public key from derived private key
    const publicKey = getPublicKey(derivedKey.privateKey);

    // Generate proper bech32 address
    const address = publicKeyToAddress(publicKey, 'alpha');

    // Generate IPNS name from public key hash
    const ipnsHash = sha256(publicKey, 'hex').slice(0, 40);

    // Derive L3 predicate address (DIRECT://...)
    const predicateAddress = await deriveL3PredicateAddress(derivedKey.privateKey);

    this._identity = {
      privateKey: derivedKey.privateKey,
      chainPubkey: publicKey,
      l1Address: address,
      directAddress: predicateAddress,
      ipnsName: '12D3KooW' + ipnsHash,
    };

    // Store master key info for future derivations
    this._masterKey = masterKey;
  }

  private async initializeIdentityFromMasterKey(
    masterKey: string,
    chainCode?: string,
    _derivationPath?: string
  ): Promise<void> {
    // Use _basePath (already set by storeMasterKey) for consistency with deriveAddress/scan.
    // Previously used derivationPath param which was undefined for file imports,
    // causing identity to derive at DEFAULT_BASE_PATH instead of the wallet's actual path.
    const basePath = this._basePath;
    const fullPath = `${basePath}/0/0`;

    let privateKey: string;

    if (chainCode) {
      // Full BIP32 derivation with chain code
      const derivedKey = deriveKeyAtPath(masterKey, chainCode, fullPath);
      privateKey = derivedKey.privateKey;

      this._masterKey = {
        privateKey: masterKey,
        chainCode,
      };
    } else {
      // WIF/HMAC derivation without chain code
      // Uses HMAC-SHA512(masterKey, path) to derive child keys (legacy webwallet format)
      const addr0 = generateAddressFromMasterKey(masterKey, 0);
      privateKey = addr0.privateKey;

      // Store masterKey for future deriveAddress() calls (chainCode unused in wif_hmac mode)
      this._masterKey = {
        privateKey: masterKey,
        chainCode: '',
      };
    }

    const publicKey = getPublicKey(privateKey);
    const address = publicKeyToAddress(publicKey, 'alpha');
    const ipnsHash = sha256(publicKey, 'hex').slice(0, 40);

    // Derive L3 predicate address (DIRECT://...)
    const predicateAddress = await deriveL3PredicateAddress(privateKey);

    this._identity = {
      privateKey,
      chainPubkey: publicKey,
      l1Address: address,
      directAddress: predicateAddress,
      ipnsName: '12D3KooW' + ipnsHash,
    };
  }

  // ===========================================================================
  // Private: Provider & Module Initialization
  // ===========================================================================

  private async initializeProviders(): Promise<void> {
    // Set identity on providers
    this._storage.setIdentity(this._identity!);
    await this._transport.setIdentity(this._identity!);

    // Set identity on all token storage providers
    for (const provider of this._tokenStorageProviders.values()) {
      provider.setIdentity(this._identity!);
    }

    // Connect providers (skip if already connected, e.g. after setIdentity reconnect)
    if (!this._storage.isConnected()) {
      await this._storage.connect();
    }
    if (!this._transport.isConnected()) {
      await this._transport.connect();
    }
    await this._oracle.initialize();

    // Initialize all token storage providers
    for (const provider of this._tokenStorageProviders.values()) {
      await provider.initialize();
    }

    // Subscribe to provider events and bridge to connection:changed
    this.subscribeToProviderEvents();
  }

  /**
   * Subscribe to provider-level events and bridge them to Sphere connection:changed events.
   * Uses deduplication to avoid emitting duplicate events.
   */
  private subscribeToProviderEvents(): void {
    this.cleanupProviderEventSubscriptions();

    // Bridge transport events
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transportAny = this._transport as any;
    if (typeof transportAny.onEvent === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const unsub = transportAny.onEvent((event: any) => {
        const type = event?.type as string;
        if (type === 'transport:connected') {
          this.emitConnectionChanged(this._transport.id, true, 'connected');
        } else if (type === 'transport:disconnected') {
          this.emitConnectionChanged(this._transport.id, false, 'disconnected');
        } else if (type === 'transport:reconnecting') {
          this.emitConnectionChanged(this._transport.id, false, 'connecting');
        } else if (type === 'transport:error') {
          this.emitConnectionChanged(this._transport.id, false, 'error', event?.error);
        }
      });
      if (unsub) this._providerEventCleanups.push(unsub);
    }

    // Bridge oracle events
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oracleAny = this._oracle as any;
    if (typeof oracleAny.onEvent === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const unsub = oracleAny.onEvent((event: any) => {
        const type = event?.type as string;
        if (type === 'oracle:connected') {
          this.emitConnectionChanged(this._oracle.id, true, 'connected');
        } else if (type === 'oracle:disconnected') {
          this.emitConnectionChanged(this._oracle.id, false, 'disconnected');
        } else if (type === 'oracle:error') {
          this.emitConnectionChanged(this._oracle.id, false, 'error', event?.error);
        }
      });
      if (unsub) this._providerEventCleanups.push(unsub);
    }

    // Bridge token storage events
    for (const [providerId, provider] of this._tokenStorageProviders) {
      if (typeof provider.onEvent === 'function') {
        const unsub = provider.onEvent((event) => {
          if (event.type === 'storage:error' || event.type === 'sync:error') {
            this.emitConnectionChanged(providerId, provider.isConnected(), provider.getStatus(), event.error);
          }
        });
        if (unsub) this._providerEventCleanups.push(unsub);
      }
    }
  }

  /**
   * Emit connection:changed with deduplication — only emits if status actually changed.
   */
  private emitConnectionChanged(
    providerId: string,
    connected: boolean,
    status: ProviderStatus,
    error?: string,
  ): void {
    const lastConnected = this._lastProviderConnected.get(providerId);
    if (lastConnected === connected) return; // No change — skip

    this._lastProviderConnected.set(providerId, connected);

    this.emitEvent('connection:changed', {
      provider: providerId,
      connected,
      status,
      enabled: !this._disabledProviders.has(providerId),
      ...(error ? { error } : {}),
    });
  }

  private cleanupProviderEventSubscriptions(): void {
    for (const cleanup of this._providerEventCleanups) {
      try { cleanup(); } catch { /* ignore */ }
    }
    this._providerEventCleanups = [];
    this._lastProviderConnected.clear();
  }

  private async initializeModules(): Promise<void> {
    const emitEvent = this.emitEvent.bind(this);

    this._payments.initialize({
      identity: this._identity!,
      storage: this._storage,
      tokenStorageProviders: this._tokenStorageProviders,
      transport: this._transport,
      oracle: this._oracle,
      emitEvent,
      // Pass chain code for L1 HD derivation
      chainCode: this._masterKey?.chainCode || undefined,
      price: this._priceProvider ?? undefined,
      disabledProviderIds: this._disabledProviders,
    });

    this._communications.initialize({
      identity: this._identity!,
      storage: this._storage,
      transport: this._transport,
      emitEvent,
    });

    this._groupChat?.initialize({
      identity: this._identity!,
      storage: this._storage,
      emitEvent,
    });

    this._market?.initialize({
      identity: this._identity!,
      emitEvent,
    });

    await this._payments.load();
    await this._communications.load();
    await this._groupChat?.load();
    await this._market?.load();
  }

  // ===========================================================================
  // Private: Helpers
  // ===========================================================================

  private ensureReady(): void {
    if (!this._initialized) {
      throw new Error('Sphere not initialized');
    }
  }

  private emitEvent<T extends SphereEventType>(type: T, data: SphereEventMap[T]): void {
    const handlers = this.eventHandlers.get(type);
    if (!handlers) return;

    for (const handler of handlers) {
      try {
        (handler as SphereEventHandler<T>)(data);
      } catch (error) {
        console.error('[Sphere] Event handler error:', error);
      }
    }
  }

  // ===========================================================================
  // Private: Encryption
  // ===========================================================================

  private encrypt(data: string): string {
    if (!this._password) return data; // No password — store as plaintext
    return encryptSimple(data, this._password);
  }

  private decrypt(encrypted: string): string | null {
    // Password provided — decrypt with it
    if (this._password) {
      try {
        return decryptSimple(encrypted, this._password);
      } catch {
        return null;
      }
    }
    // No password — check if it's already plaintext (valid BIP39 mnemonic or hex key)
    if (validateBip39Mnemonic(encrypted) || /^[0-9a-f]{64}$/i.test(encrypted)) {
      return encrypted;
    }
    // Backwards compat: try old hardcoded default key
    try {
      return decryptSimple(encrypted, DEFAULT_ENCRYPTION_KEY);
    } catch {
      return null;
    }
  }
}

// =============================================================================
// Convenience Exports
// =============================================================================

export const createSphere = Sphere.create.bind(Sphere);
export const loadSphere = Sphere.load.bind(Sphere);
export const importSphere = Sphere.import.bind(Sphere);
export const initSphere = Sphere.init.bind(Sphere);
export const getSphere = Sphere.getInstance.bind(Sphere);
export const sphereExists = Sphere.exists.bind(Sphere);
