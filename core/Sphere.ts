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
  SphereEventType,
  SphereEventMap,
  SphereEventHandler,
  DerivationMode,
  WalletSource,
  WalletInfo,
  WalletJSON,
  WalletJSONExportOptions,
} from '../types';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase } from '../storage';
import type { TransportProvider } from '../transport';
import type { OracleProvider } from '../oracle';
import { PaymentsModule, createPaymentsModule } from '../modules/payments';
import { CommunicationsModule, createCommunicationsModule } from '../modules/communications';
import { STORAGE_KEYS, DEFAULT_BASE_PATH, LIMITS, DEFAULT_ENCRYPTION_KEY, type NetworkType } from '../constants';
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
import { encryptSimple, decryptSimple } from './encryption';
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
  /**
   * Network type (mainnet, testnet, dev) - informational only.
   * Actual network configuration comes from provider URLs.
   * Use createBrowserProviders({ network: 'testnet' }) to set up testnet providers.
   */
  network?: NetworkType;
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
  /**
   * Network type (mainnet, testnet, dev) - informational only.
   * Actual network configuration comes from provider URLs.
   * Use createBrowserProviders({ network: 'testnet' }) to set up testnet providers.
   */
  network?: NetworkType;
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
  /**
   * Network type (mainnet, testnet, dev) - informational only.
   * Actual network configuration comes from provider URLs.
   * Use createBrowserProviders({ network: 'testnet' }) to set up testnet providers.
   */
  network?: NetworkType;
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
  private _source: WalletSource = 'unknown';
  private _derivationMode: DerivationMode = 'bip32';
  private _basePath: string = DEFAULT_BASE_PATH;
  private _currentAddressIndex: number = 0;
  private _addressNametags: Map<number, string> = new Map();

  // Providers
  private _storage: StorageProvider;
  private _tokenStorageProviders: Map<string, TokenStorageProvider<TxfStorageDataBase>> = new Map();
  private _transport: TransportProvider;
  private _oracle: OracleProvider;

  // Modules
  private _payments: PaymentsModule;
  private _communications: CommunicationsModule;

  // Events
  private eventHandlers: Map<SphereEventType, Set<SphereEventHandler<SphereEventType>>> = new Map();

  // ===========================================================================
  // Constructor (private)
  // ===========================================================================

  private constructor(
    storage: StorageProvider,
    transport: TransportProvider,
    oracle: OracleProvider,
    tokenStorage?: TokenStorageProvider<TxfStorageDataBase>,
    l1Config?: L1Config
  ) {
    this._storage = storage;
    this._transport = transport;
    this._oracle = oracle;

    // Initialize token storage providers map
    if (tokenStorage) {
      this._tokenStorageProviders.set(tokenStorage.id, tokenStorage);
    }

    this._payments = createPaymentsModule({ l1: l1Config });
    this._communications = createCommunicationsModule();
  }

  // ===========================================================================
  // Static Methods - Wallet Management
  // ===========================================================================

  /**
   * Check if wallet exists in storage
   */
  static async exists(storage: StorageProvider): Promise<boolean> {
    try {
      // Ensure storage is connected before checking
      if (!storage.isConnected()) {
        await storage.connect();
      }

      // Check for mnemonic or master_key directly
      // These are saved with 'default' address before identity is set
      const mnemonic = await storage.get(STORAGE_KEYS.MNEMONIC);
      if (mnemonic) return true;

      const masterKey = await storage.get(STORAGE_KEYS.MASTER_KEY);
      if (masterKey) return true;

      return false;
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
    const walletExists = await Sphere.exists(options.storage);

    if (walletExists) {
      // Load existing wallet
      const sphere = await Sphere.load({
        storage: options.storage,
        transport: options.transport,
        oracle: options.oracle,
        tokenStorage: options.tokenStorage,
        l1: options.l1,
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
    });

    return { sphere, created: true, generatedMnemonic };
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

    const sphere = new Sphere(
      options.storage,
      options.transport,
      options.oracle,
      options.tokenStorage,
      options.l1
    );

    // Store encrypted mnemonic
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

    // Register nametag if provided, otherwise try to recover from Nostr
    if (options.nametag) {
      await sphere.registerNametag(options.nametag);
    } else {
      // Try to recover nametag from Nostr (for wallet import scenarios)
      await sphere.recoverNametagFromNostr();
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

    const sphere = new Sphere(
      options.storage,
      options.transport,
      options.oracle,
      options.tokenStorage,
      options.l1
    );

    // Load identity from storage
    await sphere.loadIdentityFromStorage();

    // Initialize everything
    await sphere.initializeProviders();
    await sphere.initializeModules();

    // Sync nametag with Nostr (re-register if missing)
    await sphere.syncNametagWithNostr();

    sphere._initialized = true;
    Sphere.instance = sphere;

    return sphere;
  }

  /**
   * Import wallet from mnemonic or master key
   */
  static async import(options: SphereImportOptions): Promise<Sphere> {
    if (!options.mnemonic && !options.masterKey) {
      throw new Error('Either mnemonic or masterKey is required');
    }

    // Clear existing wallet if any
    await Sphere.clear(options.storage);

    const sphere = new Sphere(
      options.storage,
      options.transport,
      options.oracle,
      options.tokenStorage,
      options.l1
    );

    if (options.mnemonic) {
      // Validate and store mnemonic
      if (!Sphere.validateMnemonic(options.mnemonic)) {
        throw new Error('Invalid mnemonic');
      }
      await sphere.storeMnemonic(options.mnemonic, options.derivationPath, options.basePath);
      await sphere.initializeIdentityFromMnemonic(options.mnemonic, options.derivationPath);
    } else if (options.masterKey) {
      // Store master key directly
      await sphere.storeMasterKey(
        options.masterKey,
        options.chainCode,
        options.derivationPath,
        options.basePath,
        options.derivationMode
      );
      await sphere.initializeIdentityFromMasterKey(
        options.masterKey,
        options.chainCode,
        options.derivationPath
      );
    }

    // Initialize everything
    await sphere.initializeProviders();
    await sphere.initializeModules();

    // Try to recover nametag from transport (if no nametag provided and wallet previously had one)
    if (!options.nametag) {
      await sphere.recoverNametagFromNostr();
    }

    // Mark wallet as created only after successful initialization
    await sphere.finalizeWalletCreation();

    sphere._initialized = true;
    Sphere.instance = sphere;

    // Register nametag if provided (this overrides any recovered nametag)
    if (options.nametag) {
      await sphere.registerNametag(options.nametag);
    }

    return sphere;
  }

  /**
   * Clear wallet data from storage
   */
  static async clear(storage: StorageProvider): Promise<void> {
    // Clear all wallet data
    await storage.remove(STORAGE_KEYS.MNEMONIC);
    await storage.remove(STORAGE_KEYS.MASTER_KEY);
    await storage.remove(STORAGE_KEYS.CHAIN_CODE);
    await storage.remove(STORAGE_KEYS.DERIVATION_PATH);
    await storage.remove(STORAGE_KEYS.BASE_PATH);
    await storage.remove(STORAGE_KEYS.DERIVATION_MODE);
    await storage.remove(STORAGE_KEYS.WALLET_SOURCE);
    await storage.remove(STORAGE_KEYS.WALLET_EXISTS);
    await storage.remove(STORAGE_KEYS.NAMETAG);
    await storage.remove(STORAGE_KEYS.TOKENS);
    await storage.remove(STORAGE_KEYS.PENDING_TRANSFERS);
    await storage.remove(STORAGE_KEYS.OUTBOX);

    if (Sphere.instance) {
      await Sphere.instance.destroy();
    }
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
      hasChainCode: this._masterKey?.chainCode !== undefined,
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
      chainCode = this._masterKey.chainCode;
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
    const chainCode = this._masterKey?.chainCode;
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
      });

      return { success: true, sphere };
    }

    // Handle JSON (redirect to importFromJSON)
    if (fileType === 'json') {
      const content = typeof fileContent === 'string'
        ? fileContent
        : new TextDecoder().decode(fileContent);

      const result = await Sphere.importFromJSON({
        jsonContent: content,
        password,
        storage: options.storage,
        transport: options.transport,
        oracle: options.oracle,
        tokenStorage: options.tokenStorage,
      });

      if (result.success) {
        const sphere = Sphere.getInstance();
        return { success: true, sphere: sphere!, mnemonic: result.mnemonic };
      }

      return result;
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
   * Get nametag for a specific address index
   *
   * @param index - Address index (default: current address)
   * @returns Nametag or undefined if not registered
   */
  getNametagForAddress(index?: number): string | undefined {
    const addressIndex = index ?? this._currentAddressIndex;
    return this._addressNametags.get(addressIndex);
  }

  /**
   * Get all registered address nametags
   *
   * @returns Map of address index to nametag
   */
  getAllAddressNametags(): Map<number, string> {
    return new Map(this._addressNametags);
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
  async switchToAddress(index: number): Promise<void> {
    this.ensureReady();

    if (!this._masterKey) {
      throw new Error('HD derivation requires master key with chain code. Cannot switch addresses.');
    }

    if (index < 0) {
      throw new Error('Address index must be non-negative');
    }

    // Derive the address at the given index
    const addressInfo = this.deriveAddress(index, false);

    // Generate IPNS name from public key hash
    const ipnsHash = sha256(addressInfo.publicKey, 'hex').slice(0, 40);

    // Derive L3 predicate address (DIRECT://...)
    const predicateAddress = await deriveL3PredicateAddress(addressInfo.privateKey);

    // Get nametag for this address (if registered)
    const nametag = this._addressNametags.get(index);

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

    // Persist current index
    await this._storage.set(STORAGE_KEYS.CURRENT_ADDRESS_INDEX, index.toString());

    // Re-initialize providers with new identity
    this._storage.setIdentity(this._identity);
    this._transport.setIdentity(this._identity);

    // Update token storage providers
    for (const provider of this._tokenStorageProviders.values()) {
      provider.setIdentity(this._identity);
    }

    // Re-initialize modules with new identity
    await this.reinitializeModulesForNewAddress();

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
      chainCode: this._masterKey?.chainCode,
    });

    this._communications.initialize({
      identity: this._identity!,
      storage: this._storage,
      transport: this._transport,
      emitEvent,
    });

    await this._payments.load();
    await this._communications.load();
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

    if (!this._masterKey) {
      throw new Error('HD derivation requires master key with chain code');
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

  // ===========================================================================
  // Public Methods - Status
  // ===========================================================================

  getStatus(): {
    storage: { connected: boolean };
    transport: { connected: boolean };
    oracle: { connected: boolean };
  } {
    return {
      storage: { connected: this._storage.isConnected() },
      transport: { connected: this._transport.isConnected() },
      oracle: { connected: this._oracle.isConnected() },
    };
  }

  async reconnect(): Promise<void> {
    await this._transport.disconnect();
    await this._transport.connect();

    this.emitEvent('connection:changed', {
      provider: 'transport',
      connected: true,
    });
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
    const nametag = this._identity?.nametag;
    if (!nametag) return undefined;

    // Hash nametag using same algorithm as nostr-js-sdk hashNametag:
    // 1. Normalize: lowercase, remove @unicity suffix
    // 2. Add salt prefix: 'unicity:nametag:'
    // 3. SHA256 hash
    const NAMETAG_SALT = 'unicity:nametag:';
    let normalized = nametag.trim().toLowerCase();
    if (normalized.endsWith('@unicity')) {
      normalized = normalized.slice(0, -8);
    }
    const hashedNametag = sha256(NAMETAG_SALT + normalized, 'utf8');
    return `PROXY:${hashedNametag}`;
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

    // Validate nametag format
    const cleanNametag = nametag.startsWith('@') ? nametag.slice(1) : nametag;
    if (!this.validateNametag(cleanNametag)) {
      throw new Error('Invalid nametag format. Use alphanumeric characters, 3-20 chars.');
    }

    // Check if current address already has a nametag
    if (this._identity?.nametag) {
      throw new Error(`Nametag already registered for address ${this._currentAddressIndex}: @${this._identity.nametag}`);
    }

    // Register with transport provider (Nostr)
    if (this._transport.registerNametag) {
      const success = await this._transport.registerNametag(
        cleanNametag,
        this._identity!.chainPubkey,
        this._identity!.directAddress || ''
      );
      if (!success) {
        throw new Error('Failed to register nametag. It may already be taken.');
      }
    }

    // Update identity
    this._identity!.nametag = cleanNametag;

    // Store in address nametags map
    this._addressNametags.set(this._currentAddressIndex, cleanNametag);

    // Persist to storage (both legacy and new format)
    await this._storage.set(STORAGE_KEYS.NAMETAG, cleanNametag);
    await this.persistAddressNametags();

    // Mint nametag token on-chain if not already minted
    // Required for receiving tokens via @nametag (PROXY address finalization)
    if (!this._payments.hasNametag()) {
      console.log(`[Sphere] Minting nametag token for @${cleanNametag}...`);
      const result = await this.mintNametag(cleanNametag);
      if (!result.success) {
        console.warn(`[Sphere] Failed to mint nametag token: ${result.error}`);
        // Don't throw - nametag is registered on Nostr, token can be minted later
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
   * Persist address nametags to storage
   */
  private async persistAddressNametags(): Promise<void> {
    const nametagsObj: Record<string, string> = {};
    this._addressNametags.forEach((nametag, index) => {
      nametagsObj[index.toString()] = nametag;
    });
    await this._storage.set(STORAGE_KEYS.ADDRESS_NAMETAGS, JSON.stringify(nametagsObj));
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
   * Load address nametags from storage
   */
  private async loadAddressNametags(): Promise<void> {
    try {
      const saved = await this._storage.get(STORAGE_KEYS.ADDRESS_NAMETAGS);
      if (saved) {
        const nametagsObj = JSON.parse(saved) as Record<string, string>;
        this._addressNametags.clear();
        for (const [indexStr, nametag] of Object.entries(nametagsObj)) {
          this._addressNametags.set(parseInt(indexStr, 10), nametag);
        }
      }
    } catch {
      // Ignore parse errors - start fresh
    }
  }

  /**
   * Sync nametag with Nostr on wallet load
   * If local nametag exists but not registered on Nostr, re-register it
   */
  private async syncNametagWithNostr(): Promise<void> {
    const nametag = this._identity?.nametag;
    if (!nametag) {
      return; // No nametag to sync
    }

    if (!this._transport.resolveNametag || !this._transport.registerNametag) {
      return; // Transport doesn't support nametag operations
    }

    try {
      // Register nametag (will check if already registered and re-publish if needed)
      const success = await this._transport.registerNametag(
        nametag,
        this._identity!.chainPubkey,
        this._identity!.directAddress || ''
      );
      if (success) {
        console.log(`[Sphere] Nametag @${nametag} synced with Nostr`);
      } else {
        console.warn(`[Sphere] Nametag @${nametag} is taken by another pubkey`);
      }
    } catch (error) {
      // Don't fail wallet load on nametag sync errors
      console.warn(`[Sphere] Nametag sync failed:`, error);
    }
  }

  /**
   * Recover nametag from Nostr after wallet import
   * Searches for encrypted nametag events authored by this wallet's pubkey
   * and decrypts them to restore the nametag association
   */
  private async recoverNametagFromNostr(): Promise<void> {
    // Skip if already has a nametag
    if (this._identity?.nametag) {
      return;
    }

    // Check if transport supports nametag recovery
    if (!this._transport.recoverNametag) {
      return;
    }

    try {
      const recoveredNametag = await this._transport.recoverNametag();

      if (recoveredNametag) {

        // Update identity with recovered nametag
        if (this._identity) {
          (this._identity as MutableFullIdentity).nametag = recoveredNametag;
        }

        // Store nametag locally
        this._addressNametags.set(this._currentAddressIndex, recoveredNametag);
        await this._storage.set(STORAGE_KEYS.NAMETAG, recoveredNametag);

        // Re-register to ensure event has latest format with all fields
        if (this._transport.registerNametag) {
          await this._transport.registerNametag(
            recoveredNametag,
            this._identity!.chainPubkey,
            this._identity!.directAddress || ''
          );
        }

        this.emitEvent('nametag:recovered', { nametag: recoveredNametag });
      }
    } catch {
      // Don't fail wallet import on nametag recovery errors
    }
  }

  /**
   * Validate nametag format
   */
  private validateNametag(nametag: string): boolean {
    // Alphanumeric characters, underscores and hyphens allowed
    const pattern = new RegExp(
      `^[a-zA-Z0-9_-]{${LIMITS.NAMETAG_MIN_LENGTH},${LIMITS.NAMETAG_MAX_LENGTH}}$`
    );
    return pattern.test(nametag);
  }

  // ===========================================================================
  // Public Methods - Lifecycle
  // ===========================================================================

  async destroy(): Promise<void> {
    this._payments.destroy();
    this._communications.destroy();

    await this._transport.disconnect();
    await this._storage.disconnect();
    await this._oracle.disconnect();

    this._initialized = false;
    this._identity = null;
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
    await this._storage.set(STORAGE_KEYS.MNEMONIC, encrypted);

    // Store mnemonic in memory for getMnemonic()
    this._mnemonic = mnemonic;
    this._source = 'mnemonic';
    this._derivationMode = 'bip32';

    if (derivationPath) {
      await this._storage.set(STORAGE_KEYS.DERIVATION_PATH, derivationPath);
    }

    const effectiveBasePath = basePath ?? DEFAULT_BASE_PATH;
    this._basePath = effectiveBasePath;
    await this._storage.set(STORAGE_KEYS.BASE_PATH, effectiveBasePath);
    await this._storage.set(STORAGE_KEYS.DERIVATION_MODE, this._derivationMode);
    await this._storage.set(STORAGE_KEYS.WALLET_SOURCE, this._source);
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
    await this._storage.set(STORAGE_KEYS.MASTER_KEY, encrypted);

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
      await this._storage.set(STORAGE_KEYS.CHAIN_CODE, chainCode);
    }

    if (derivationPath) {
      await this._storage.set(STORAGE_KEYS.DERIVATION_PATH, derivationPath);
    }

    const effectiveBasePath = basePath ?? DEFAULT_BASE_PATH;
    this._basePath = effectiveBasePath;
    await this._storage.set(STORAGE_KEYS.BASE_PATH, effectiveBasePath);
    await this._storage.set(STORAGE_KEYS.DERIVATION_MODE, this._derivationMode);
    await this._storage.set(STORAGE_KEYS.WALLET_SOURCE, this._source);
    // Note: WALLET_EXISTS is set in finalizeWalletCreation() after successful initialization
  }

  /**
   * Mark wallet as fully created (after successful initialization)
   * This is called at the end of create()/import() to ensure wallet is only
   * marked as existing after all initialization steps succeed.
   */
  private async finalizeWalletCreation(): Promise<void> {
    await this._storage.set(STORAGE_KEYS.WALLET_EXISTS, 'true');
  }

  // ===========================================================================
  // Private: Identity Initialization
  // ===========================================================================

  private async loadIdentityFromStorage(): Promise<void> {
    // Load keys that are saved with 'default' address (before identity is set)
    const encryptedMnemonic = await this._storage.get(STORAGE_KEYS.MNEMONIC);
    const encryptedMasterKey = await this._storage.get(STORAGE_KEYS.MASTER_KEY);
    const chainCode = await this._storage.get(STORAGE_KEYS.CHAIN_CODE);
    const derivationPath = await this._storage.get(STORAGE_KEYS.DERIVATION_PATH);
    const savedBasePath = await this._storage.get(STORAGE_KEYS.BASE_PATH);
    const savedDerivationMode = await this._storage.get(STORAGE_KEYS.DERIVATION_MODE);
    const savedSource = await this._storage.get(STORAGE_KEYS.WALLET_SOURCE);
    const savedAddressIndex = await this._storage.get(STORAGE_KEYS.CURRENT_ADDRESS_INDEX);

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

    // Load address-scoped data (saved with actual address, not 'default')
    await this.loadAddressNametags();
    const savedNametag = await this._storage.get(STORAGE_KEYS.NAMETAG);

    // If we have a saved address index > 0 and master key, switch to that address
    if (this._currentAddressIndex > 0 && this._masterKey) {
      // Re-derive identity for the saved address index
      const addressInfo = this.deriveAddress(this._currentAddressIndex, false);
      const ipnsHash = sha256(addressInfo.publicKey, 'hex').slice(0, 40);
      const predicateAddress = await deriveL3PredicateAddress(addressInfo.privateKey);
      const nametag = this._addressNametags.get(this._currentAddressIndex);

      this._identity = {
        privateKey: addressInfo.privateKey,
        chainPubkey: addressInfo.publicKey,
        l1Address: addressInfo.address,
        directAddress: predicateAddress,
        ipnsName: '12D3KooW' + ipnsHash,
        nametag,
      };
      // Update storage identity for correct address
      this._storage.setIdentity(this._identity);
      console.log(`[Sphere] Restored to address ${this._currentAddressIndex}:`, this._identity.l1Address);
    } else {
      // Restore saved nametag for address 0 (legacy support)
      if (savedNametag && this._identity) {
        // Handle both plain string and legacy JSON format {"0":"nametag"}
        let nametag = savedNametag;
        if (savedNametag.startsWith('{')) {
          try {
            const parsed = JSON.parse(savedNametag);
            nametag = parsed['0'] || parsed[0] || Object.values(parsed)[0] as string;
          } catch {
            // Keep original value if parsing fails
          }
        }
        this._identity.nametag = nametag;
        // Also add to address nametags map if not already there
        if (!this._addressNametags.has(0)) {
          this._addressNametags.set(0, nametag);
        }
      } else if (this._identity) {
        // Check if we have a nametag in the map for address 0
        const nametag = this._addressNametags.get(0);
        if (nametag) {
          this._identity.nametag = nametag;
        }
      }
    }
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
    derivationPath?: string
  ): Promise<void> {
    // Use base path (e.g., m/44'/0'/0') and append chain/index
    const basePath = derivationPath ?? DEFAULT_BASE_PATH;
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
      // Direct master key usage (legacy wallets)
      privateKey = masterKey;
      this._masterKey = null;
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
    this._transport.setIdentity(this._identity!);

    // Set identity on all token storage providers
    for (const provider of this._tokenStorageProviders.values()) {
      provider.setIdentity(this._identity!);
    }

    // Connect providers
    await this._storage.connect();
    await this._transport.connect();
    await this._oracle.initialize();

    // Initialize all token storage providers
    for (const provider of this._tokenStorageProviders.values()) {
      await provider.initialize();
    }
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
      chainCode: this._masterKey?.chainCode,
    });

    this._communications.initialize({
      identity: this._identity!,
      storage: this._storage,
      transport: this._transport,
      emitEvent,
    });

    await this._payments.load();
    await this._communications.load();
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
    // Use AES-256 encryption with default key
    // TODO: Add password parameter to create/load for user-provided encryption
    return encryptSimple(data, DEFAULT_ENCRYPTION_KEY);
  }

  private decrypt(encrypted: string): string | null {
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
