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
 * const oracle = createUnicityAggregatorProvider({ url: '/rpc', network: 'testnet2' });
 * // Money rides the wallet-api vertical — the transport config is REQUIRED:
 * const walletApi = { network: 'testnet2', baseUrl: 'https://wallet-api...', deviceId: 'my-device' };
 *
 * // Option 1: Unified init (recommended)
 * const { sphere, created, generatedMnemonic } = await Sphere.init({
 *   storage,
 *   transport,
 *   oracle,
 *   walletApi,
 *   network: 'testnet2', // required: selects registry/trustbase/aggregator
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
 *   const sphere = await Sphere.load({ storage, transport, oracle, walletApi, network: 'testnet2' });
 * } else {
 *   const sphere = await Sphere.create({ mnemonic, storage, transport, oracle, walletApi, network: 'testnet2' });
 * }
 *
 * // Use the wallet
 * await sphere.payments.send({ coinId: 'UCT', amount: '1000', recipient: '@alice' });
 * ```
 */

import { logger } from './logger';
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
import { SphereError } from './errors';
import type { StorageProvider } from '../storage';
import { isDerivableIndex } from '../storage/tracked-addresses';
import type { TransportProvider, PeerInfo } from '../transport';
import { MultiAddressTransportMux, AddressTransportAdapter } from '../transport/MultiAddressTransportMux';
import type { OracleProvider } from '../oracle';
import type { PriceProvider } from '../price';
import { CommunicationsModule, createCommunicationsModule } from '../modules/communications';
import type { CommunicationsModuleConfig } from '../modules/communications';
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
  hexToBytes,
  generateAddressFromMasterKey,
  signMessage as signMessageCrypto,
  type MasterKey,
  type AddressInfo,
} from './crypto';
import { encryptSimple, decryptSimple } from './encryption';
import { discoverAddressesImpl } from './discover';
import type { DiscoverAddressesOptions, DiscoverAddressesResult } from './discover';
import {
  serializeWalletToText,
  serializeEncryptedWalletToText,
  encryptForTextFormat,
} from '../serialization/wallet-text';
import {
  createSphereTokenEngine,
  deriveDirectAddress,
  type ITokenEngine,
  type VerificationWorkerConfig,
} from '../token-engine';
import {
  composePaymentsV2,
  resolvePaymentsV2Composition,
  type PaymentsV2Composition,
  type WalletApiTransportConfig,
} from './payments-v2-wiring';
import type { PaymentsV2 } from '../modules/payments-v2/api';
import type { PaymentsFacade } from '../modules/payments-v2/PaymentsFacade';

export type { WalletApiTransportConfig } from './payments-v2-wiring';
import {
  isTextWalletEncrypted,
  isWalletTextFormat,
  parseAndDecryptWalletText,
  parseWalletText,
} from '../serialization/wallet-text';
import type { DecryptionProgressCallback, LegacyFileType } from '../serialization/types';
import { decryptWithSalt } from './encryption';
import { normalizeNametag, isPhoneNumber } from '@unicitylabs/nostr-js-sdk';

export function isValidNametag(nametag: string): boolean {
  if (isPhoneNumber(nametag)) return true;
  return /^[a-z0-9_-]{3,20}$/.test(nametag);
}

// =============================================================================
// Progress Callback
// =============================================================================

/** Steps reported by the onProgress callback during wallet init/create/load/import */
export type InitProgressStep =
  | 'clearing'
  | 'storing_keys'
  | 'initializing'
  | 'recovering_nametag'
  | 'registering_nametag'
  | 'syncing_identity'
  | 'syncing_tokens'
  | 'discovering_addresses'
  | 'finalizing'
  | 'complete';

/** Progress info passed to onProgress callback */
export interface InitProgress {
  /** Current step identifier */
  readonly step: InitProgressStep;
  /** Human-readable description of what's happening */
  readonly message: string;
}

/** Callback for tracking wallet initialization progress */
export type InitProgressCallback = (progress: InitProgress) => void;

// =============================================================================
// Options Types
// =============================================================================

/**
 * The wallet-api transport config every wallet needs (money moves only through
 * the wallet-api vertical): `{ network, baseUrl, deviceId?, ... }` —
 * `createWalletApiProviders` (impl/shared/wallet-api) builds it. Shared by all
 * four init-option shapes below.
 */
interface SphereWalletApiOptions {
  /** Wallet-api transport config — REQUIRED (init throws INVALID_CONFIG without it). */
  walletApi?: WalletApiTransportConfig;
  /** @deprecated REMOVED with the P11 flip — any truthy value throws INVALID_CONFIG (invoicing no longer exists in the SDK). */
  accounting?: unknown;
  /** @deprecated REMOVED with the P11 flip — any truthy value throws INVALID_CONFIG (swaps no longer exist in the SDK). */
  swap?: unknown;
}

export interface SphereCreateOptions extends SphereWalletApiOptions {
  /** BIP39 mnemonic (12 or 24 words) */
  mnemonic: string;
  /** Custom derivation path (default: m/44'/0'/0') */
  derivationPath?: string;
  /** Optional nametag to register for this wallet (e.g., 'alice' for @alice). Token is auto-minted. */
  nametag?: string;
  /** Storage provider instance */
  storage: StorageProvider;
  /** Transport provider instance */
  transport: TransportProvider;
  /** Oracle provider instance */
  oracle: OracleProvider;
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
  /** Communications module configuration. */
  communications?: CommunicationsModuleConfig;
  /** Optional password to encrypt the wallet. If omitted, mnemonic is stored as plaintext. */
  password?: string;
  /**
   * Auto-discover previously used HD addresses after creation.
   * - true: discover with defaults (Nostr binding-event scan, autoTrack: true)
   * - DiscoverAddressesOptions: custom config
   * - false/undefined: no auto-discovery (default)
   */
  discoverAddresses?: boolean | DiscoverAddressesOptions;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /** Optional callback to report initialization progress steps */
  onProgress?: InitProgressCallback;
  /**
   * Opt in to PARALLEL token verification — see
   * {@link SphereInitOptions.verification}. Omit for the sequential verifier.
   */
  verification?: VerificationWorkerConfig;
}

/** Options for loading existing wallet */
export interface SphereLoadOptions extends SphereWalletApiOptions {
  /** Storage provider instance */
  storage: StorageProvider;
  /** Transport provider instance */
  transport: TransportProvider;
  /** Oracle provider instance */
  oracle: OracleProvider;
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
  /** Communications module configuration. */
  communications?: CommunicationsModuleConfig;
  /** Optional password to decrypt the wallet. Must match the password used during creation. */
  password?: string;
  /**
   * Auto-discover previously used HD addresses on load.
   * - true: discover with defaults (Nostr binding-event scan, autoTrack: true)
   * - DiscoverAddressesOptions: custom config
   * - false/undefined: no auto-discovery (default)
   */
  discoverAddresses?: boolean | DiscoverAddressesOptions;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /** Optional callback to report initialization progress steps */
  onProgress?: InitProgressCallback;
  /**
   * Opt in to PARALLEL token verification — see
   * {@link SphereInitOptions.verification}. Omit for the sequential verifier.
   */
  verification?: VerificationWorkerConfig;
}

/** Options for importing a wallet */
export interface SphereImportOptions extends SphereWalletApiOptions {
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
  /** Network this wallet runs on — drives TokenRegistry config. Without it, import
   *  falls back to NETWORKS.testnet and a non-testnet wallet loads the wrong registry
   *  (symbols resolve via baked values but icons/metadata don't) until a reload. */
  network?: NetworkType;
  /** Storage provider instance */
  storage: StorageProvider;
  /** Transport provider instance */
  transport: TransportProvider;
  /** Oracle provider instance */
  oracle: OracleProvider;
  /** Optional price provider for fiat conversion */
  price?: PriceProvider;
  /** Group chat configuration (NIP-29). Omit to disable groupchat. */
  groupChat?: GroupChatModuleConfig | boolean;
  /** Market module configuration. true = enable with defaults, object = custom config. */
  market?: MarketModuleConfig | boolean;
  /** Communications module configuration. */
  communications?: CommunicationsModuleConfig;
  /** Optional password to encrypt the wallet. If omitted, mnemonic/key is stored as plaintext. */
  password?: string;
  /**
   * Auto-discover previously used HD addresses after import.
   * - true: discover with defaults (Nostr binding-event scan, autoTrack: true)
   * - DiscoverAddressesOptions: custom config
   * - false/undefined: no auto-discovery (default)
   */
  discoverAddresses?: boolean | DiscoverAddressesOptions;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /** Optional callback to report initialization progress steps */
  onProgress?: InitProgressCallback;
  /**
   * Opt in to PARALLEL token verification — see
   * {@link SphereInitOptions.verification}. Omit for the sequential verifier.
   */
  verification?: VerificationWorkerConfig;
}

/** Options for unified init (auto-create or load) */
export interface SphereInitOptions extends SphereWalletApiOptions {
  /** Storage provider instance */
  storage: StorageProvider;
  /** Transport provider instance */
  transport: TransportProvider;
  /** Oracle provider instance */
  oracle: OracleProvider;
  /** BIP39 mnemonic - if wallet doesn't exist, use this to create */
  mnemonic?: string;
  /** Auto-generate mnemonic if wallet doesn't exist and no mnemonic provided */
  autoGenerate?: boolean;
  /** Custom derivation path (default: m/44'/0'/0') */
  derivationPath?: string;
  /** Optional nametag to register (only on create). Token is auto-minted. */
  nametag?: string;
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
  /**
   * Auto-discover previously used HD addresses when creating from mnemonic.
   * Only applies when wallet is newly created (not on load of existing wallet).
   * - true: discover with defaults (Nostr binding-event scan, autoTrack: true)
   * - DiscoverAddressesOptions: custom config
   * - false/undefined: no auto-discovery (default)
   */
  discoverAddresses?: boolean | DiscoverAddressesOptions;
  /**
   * Fallback 'since' timestamp (unix seconds) for the DM (gift-wrap) subscription.
   * Used when no persisted DM timestamp exists in storage (e.g. first connect).
   * Without this, a fresh wallet starts from "now" and misses older DMs.
   */
  dmSince?: number;
  /** Communications module configuration. */
  communications?: CommunicationsModuleConfig;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /** Optional callback to report initialization progress steps */
  onProgress?: InitProgressCallback;
  /**
   * Opt in to PARALLEL token verification: the engine fans each token's
   * per-transfer verification out to a pool of workers instead of walking it on
   * the calling thread. Omit for the sequential verifier — the behavior of every
   * release before this one.
   *
   * The worker entry script is yours to author and bundle (see
   * {@link VerificationWorkerConfig}); `sphere.destroy()` terminates the pool.
   */
  verification?: VerificationWorkerConfig;
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

/**
 * Derive the wallet's legacy L3 identity address (DIRECT://...) from a private key.
 *
 * Delegates to the shared, golden-locked `deriveDirectAddress` helper (token-engine,
 * A6) so the engine and the wallet derive byte-identical addresses from ONE recipe.
 *
 * XP-CRITICAL (Path A / D10): Quest XP and Unicity IDs are keyed on this address, so it
 * MUST stay byte-identical across the v1→v2 migration. The legacy v1 derivation ran the
 * secret through `SigningService.createFromSecret`, which SHA-256-hashes the secret before
 * using it as the signing scalar — so the address is a function of
 * `getPublicKey(SHA256(privateKey))`, NOT of the raw `chainPubkey`. That pre-hash is
 * reproduced here and locked by tests/unit/core/Sphere.l3-identity-address.golden.test.ts.
 */
async function deriveL3PredicateAddress(privateKey: string): Promise<string> {
  const prehashedPublicKey = getPublicKey(sha256(privateKey, 'hex'));
  return deriveDirectAddress(hexToBytes(prehashedPublicKey));
}

// =============================================================================
// Mutable Identity (internal use only)
// =============================================================================

/** Mutable version of FullIdentity for internal state management */
type MutableFullIdentity = {
  -readonly [K in keyof FullIdentity]: FullIdentity[K];
};

// =============================================================================
// Per-Address Module Set
// =============================================================================

/**
 * Holds all per-address module instances.
 * Each HD address gets its own set so modules can run independently in background.
 * The payments vertical is NOT per-set: exactly one facade runs at a time
 * (§7 stop-then-start on address switch) — see `_paymentsV2Active`.
 */
export interface AddressModuleSet {
  index: number;
  identity: FullIdentity;
  communications: CommunicationsModule;
  groupChat: GroupChatModule | null;
  market: MarketModule | null;
  transportAdapter: AddressTransportAdapter | null;
  /** v2 token engine for THIS address (bound to its signing key). */
  tokenEngine: ITokenEngine | undefined;
  initialized: boolean;
}

// =============================================================================
// Sphere Class
// =============================================================================

export class Sphere {
  // Live Spheres, keyed by the BACKING STORE their provider addresses. NOT a liveness
  // API: it exists only so clear()/import() tear down the instances whose data they
  // really erase. Object identity was too narrow — two providers over one dataDir/DB
  // are different objects but the same file, so clearing through one left the other's
  // Sphere live over an emptied KV (#766).
  private static readonly _liveByStorage = new Map<string, Set<Sphere>>();

  /** Fallback keys for providers that declare no `backingStoreId` — one per object. */
  private static readonly _objectStoreKeys = new WeakMap<StorageProvider, string>();
  private static _objectStoreSeq = 0;

  /**
   * How many times each backing store has been cleared. An init is invisible to `clear()`
   * until it PUBLISHES (#767), so a clear cannot destroy one in flight and would wipe the
   * store under it. Every init records this number before its first storage work and
   * publication refuses if it moved (#772). Only cleared stores get an entry, so the
   * strongly-held keys are bounded by the stores a process actually clears.
   */
  private static readonly _clearGenerations = new Map<string, number>();

  // One-time best-effort cleanup of the orphaned vesting cache (prior versions).
  private static _orphanCacheCleaned = false;

  // State
  private _initialized = false;
  /**
   * Destroyed latch (#770). Distinct from `_initialized`, which destroy() clears LAST — after
   * every teardown step — so it cannot mark "teardown has begun". This is set as destroy()'s
   * very FIRST statement, so the WHOLE teardown window is guarded, not just the instant after
   * it. Read by ensureAlive() and by the §7 lifecycle mutex.
   */
  private _destroyed = false;
  private _trackedAddressesLoaded = false;
  private _identity: MutableFullIdentity | null = null;
  private _masterKey: MasterKey | null = null;
  private _mnemonic: string | null = null;
  private _password: string | null = null;
  /** True when the wallet was created/loaded/imported WITH a password. Distinguishes
   *  "no password by design" (encrypt passes through) from "the password is gone" (encrypt
   *  must throw rather than silently write plaintext over an encrypted record). */
  private _passwordProtected = false;
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

  // Providers
  private _storage: StorageProvider;
  private _transport: TransportProvider;
  private _oracle: OracleProvider;
  private _priceProvider: PriceProvider | null;
  /** v2 token engine (built per active address from the oracle); injected into modules. */
  private _tokenEngine: ITokenEngine | undefined;

  // Modules (single-instance — backward compat, delegates to active address)
  private _communications: CommunicationsModule;
  private _groupChat: GroupChatModule | null = null;
  private _market: MarketModule | null = null;

  // The payments vertical (the ONLY money path since the P11 flip)
  /** The ACTIVE address's running vertical — §7: exactly one at a time, ever. */
  private _paymentsV2Active: { index: number; facade: PaymentsFacade } | null = null;
  /** Resolved wallet-api transport composition (network + per-address factory); set at init, fail-closed. */
  private _paymentsV2Composition: PaymentsV2Composition | null = null;
  /**
   * §7 lifecycle mutex: every stop/start pair runs strictly serialized, so
   * overlapping switch/destroy calls can never observe a half-stopped vertical
   * and start a second one (an orphan would double-drain its kv on the next
   * switch-back). The chain never stays rejected.
   */
  private _paymentsV2Lifecycle: Promise<void> = Promise.resolve();

  // Per-address module instances (Phase 2: independent parallel operation)
  private _addressModules: Map<number, AddressModuleSet> = new Map();
  private _transportMux: MultiAddressTransportMux | null = null;
  /** Fallback DM since timestamp from init options, forwarded to mux on creation. */
  private _dmSince: number | null = null;

  // Stored configs for creating per-address modules
  private _groupChatConfig: GroupChatModuleConfig | undefined;
  private _marketConfig: MarketModuleConfig | undefined;
  private _communicationsConfig: CommunicationsModuleConfig | undefined;
  /**
   * Opt-in parallel verification (SphereInitOptions.verification). Read by
   * buildTokenEngine for EVERY engine it builds, so the per-address engines and
   * the rebuild after an api-key change share one pool configuration.
   */
  private _verification: VerificationWorkerConfig | undefined;
  /** This Sphere's OWN token registry. Disposed by destroy(); never the process global. */
  private _registry: TokenRegistry | null = null;

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
    priceProvider?: PriceProvider,
    groupChatConfig?: GroupChatModuleConfig,
    marketConfig?: MarketModuleConfig,
    communicationsConfig?: CommunicationsModuleConfig,
  ) {
    this._storage = storage;
    this._transport = transport;
    this._oracle = oracle;
    this._priceProvider = priceProvider ?? null;

    // Store configs for creating per-address modules
    this._groupChatConfig = groupChatConfig;
    this._marketConfig = marketConfig;
    this._communicationsConfig = communicationsConfig;

    this._communications = createCommunicationsModule(communicationsConfig);
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
    // Configure debug logging (also needed in main bundle context, same as TokenRegistry)
    // `undefined` leaves whatever the provider factory or consumer set; an explicit
    // `false` MUST turn debug off. A truthy-only check made this process-global flag
    // one-way — no second init could ever quieten it (#766).
    if (options.debug !== undefined) logger.configure({ debug: options.debug });

    // Fail-closed BEFORE any work: retired module options + the required
    // wallet-api composition (create/load re-check for direct callers).
    Sphere.refuseRetiredModuleOptions(options);
    resolvePaymentsV2Composition(options.walletApi, options.network);

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
        network: options.network, // forward network so load's configureTokenRegistry uses it (not the testnet default)
        storage: options.storage,
        transport: options.transport,
        oracle: options.oracle,
        walletApi: options.walletApi,
        price: options.price,
        groupChat,
        market,
        communications: options.communications,
        password: options.password,
        verification: options.verification,
        discoverAddresses: options.discoverAddresses,
        onProgress: options.onProgress,
      });
      // Store dmSince for forwarding to transport/mux when subscriptions are set up
      if (options.dmSince != null) {
        sphere._dmSince = options.dmSince;
      }
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
        throw new SphereError(
          'No wallet exists and no mnemonic provided. Provide a mnemonic or set autoGenerate: true.',
          'INVALID_CONFIG'
        );
      }
    }

    const sphere = await Sphere.create({
      mnemonic,
      network: options.network, // forward network so create's configureTokenRegistry uses it (not the testnet default)
      storage: options.storage,
      transport: options.transport,
      oracle: options.oracle,
      walletApi: options.walletApi,
      derivationPath: options.derivationPath,
      nametag: options.nametag,
      price: options.price,
      groupChat,
      market,
      communications: options.communications,
      password: options.password,
      verification: options.verification,
      discoverAddresses: options.discoverAddresses,
      onProgress: options.onProgress,
    });

    if (options.dmSince != null) {
      sphere._dmSince = options.dmSince;
    }
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
    // Fail loud: relays differ per network — never silently default to mainnet.
    if (!network) {
      throw new SphereError('network is required to resolve group chat relays.', 'INVALID_CONFIG');
    }
    if (config === true) {
      return { relays: [...NETWORKS[network].groupRelays] };
    }
    // If relays not specified, fill from network defaults
    if (!config.relays || config.relays.length === 0) {
      return { ...config, relays: [...NETWORKS[network].groupRelays] };
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
   * The ONE sanctioned refusal fossil of the P11 flip: `accounting`/`swap` were
   * public init flags — silently ignoring them would hide that invoices/swaps no
   * longer exist in the SDK. Kept through 0.15.0, where consumers re-integrate
   * across the wire break and a silent no-op would be worst.
   */
  private static refuseRetiredModuleOptions(options: SphereWalletApiOptions): void {
    if (options.accounting) {
      throw new SphereError(
        'The accounting/invoicing module was removed with the P11 flip — drop `accounting` from Sphere.init (invoices no longer exist in the SDK).',
        'INVALID_CONFIG'
      );
    }
    if (options.swap) {
      throw new SphereError(
        'The swap module was removed with the P11 flip — drop `swap` from Sphere.init (swaps no longer exist in the SDK).',
        'INVALID_CONFIG'
      );
    }
  }

  /**
   * Configure TokenRegistry in the main bundle context.
   *
   * The provider factory functions (createBrowserProviders / createNodeProviders)
   * are compiled into separate bundles by tsup, each with their own inlined copy
   * of TokenRegistry. Their TokenRegistry.configure() call configures a different
   * singleton than the one the payments facade uses (which lives in the main
   * bundle). This method ensures the main bundle's TokenRegistry is configured.
   */
  private static configureTokenRegistry(storage: StorageProvider, network?: NetworkType): void {
    // Fail loud: a dropped/missing network would silently load the wrong-network
    // registry (testnet vs mainnet). Every Sphere entry point must forward options.network.
    if (!network) {
      throw new SphereError(
        'network is required to configure the TokenRegistry. Every Sphere entry point must forward options.network.',
        'INVALID_CONFIG',
      );
    }
    TokenRegistry.configure({ remoteUrl: NETWORKS[network].tokenRegistryUrl, storage });
  }

  /**
   * Build the registry THIS Sphere owns, so its metadata cannot be repointed by another
   * Sphere's init. The global is still configured above for consumers that read it
   * directly; this instance is what the payments facade presents from.
   */
  /**
   * Own a registry for the duration of `bringUp`, disposing it if any of that rejects.
   *
   * `bringUp` must cover EVERY fallible step from here until the Sphere is returned to
   * its caller — until then nobody holds anything they could destroy, so a
   * registry left behind is unreachable and its hourly fetch runs for the life of the
   * process. Guarding a named subset of the steps is what failed twice: the guarded region
   * and the fallible region were separate things, and drifted. Publication is the LAST
   * guarded step for the same reason: it can refuse, and a refusal must tear down.
   */
  private static async withOwnedRegistry(
    sphere: Sphere,
    storage: StorageProvider,
    network: NetworkType | undefined,
    clearGeneration: number,
    bringUp: () => Promise<void>,
  ): Promise<void> {
    sphere._registry = Sphere.createOwnedRegistry(storage, network);
    try {
      await bringUp();
      Sphere.publishLive(sphere, clearGeneration);
    } catch (err) {
      // Tear down the WHOLE half-built Sphere, not just its registry. By this point
      // providers may be connected and the payments vertical running, and publication
      // happens AFTER this guard — so the caller receives nothing that could destroy
      // them. destroy() disposes the registry as its first act, so this subsumes it.
      await sphere.destroy().catch((teardownErr) => {
        logger.warn('Sphere', 'teardown after failed initialization also failed:', teardownErr);
      });
      throw err;
    }
  }

  private static createOwnedRegistry(storage: StorageProvider, network?: NetworkType): TokenRegistry {
    if (!network) {
      throw new SphereError(
        'network is required to build the token registry. Every Sphere entry point must forward options.network.',
        'INVALID_CONFIG',
      );
    }
    return TokenRegistry.create({ remoteUrl: NETWORKS[network].tokenRegistryUrl, storage });
  }

  /**
   * Create new wallet with mnemonic
   */
  static async create(options: SphereCreateOptions): Promise<Sphere> {
    // `undefined` leaves whatever the provider factory or consumer set; an explicit
    // `false` MUST turn debug off. A truthy-only check made this process-global flag
    // one-way — no second init could ever quieten it (#766).
    if (options.debug !== undefined) logger.configure({ debug: options.debug });

    // Fail-closed BEFORE any storage write: retired module options + the
    // required wallet-api composition.
    Sphere.refuseRetiredModuleOptions(options);
    const composition = resolvePaymentsV2Composition(options.walletApi, options.network);

    // Validate mnemonic
    if (!options.mnemonic || !Sphere.validateMnemonic(options.mnemonic)) {
      throw new SphereError('Invalid mnemonic', 'INVALID_IDENTITY');
    }

    // #772: recorded BEFORE the first storage read/write and re-checked at publication —
    // a clear() cannot see this init to destroy it, so it would otherwise wipe the keys
    // written below out from under a Sphere that goes on to report itself ready.
    const clearGeneration = Sphere.clearGenerationOf(options.storage);

    // Check if wallet already exists
    if (await Sphere.exists(options.storage)) {
      throw new SphereError('Wallet already exists. Use Sphere.load() or Sphere.clear() first.', 'ALREADY_INITIALIZED');
    }

    const progress = options.onProgress;

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
      options.price,
      groupChatConfig,
      marketConfig,
      options.communications,
    );
    sphere._verification = options.verification;
    sphere._paymentsV2Composition = composition;
    sphere._password = options.password ?? null;
    sphere._passwordProtected = sphere._password !== null;

    // Store mnemonic (encrypted if password provided, plaintext otherwise)
    progress?.({ step: 'storing_keys', message: 'Storing wallet keys...' });
    await sphere.storeMnemonic(options.mnemonic, options.derivationPath);

    // Initialize identity from mnemonic
    await sphere.initializeIdentityFromMnemonic(options.mnemonic, options.derivationPath);

    // Initialize everything
    progress?.({ step: 'initializing', message: 'Initializing wallet...' });
    await Sphere.withOwnedRegistry(sphere, options.storage, options.network, clearGeneration, async () => {
      await sphere.initializeProviders();
      await sphere.initializeModules();

      // Mark wallet as created only after successful initialization
      // This prevents "Wallet already exists" errors if init fails partway through
      progress?.({ step: 'finalizing', message: 'Finalizing wallet...' });
      await sphere.finalizeWalletCreation();

      sphere._initialized = true;

      // Track address 0 in the registry
      await sphere.ensureAddressTracked(0);

      // Register nametag if provided, otherwise try recovery then publish
      if (options.nametag) {
        progress?.({ step: 'registering_nametag', message: 'Registering nametag...' });
        // registerNametag publishes identity binding WITH nametag atomically
        // (calling syncIdentityWithTransport before this would race — both replaceable
        // events get the same created_at second and relay keeps the one without nametag)
        await sphere.registerNametag(options.nametag);
      } else {
        // Try to recover nametag BEFORE publishing — publishIdentityBinding uses
        // kind 30078 (replaceable event), so a bare binding would overwrite the
        // existing one that contains encrypted_nametag, making recovery impossible.
        progress?.({ step: 'recovering_nametag', message: 'Recovering nametag...' });
        await sphere.recoverNametagFromTransport();
        // Now publish identity binding (with recovered nametag if found)
        progress?.({ step: 'syncing_identity', message: 'Publishing identity...' });
        await sphere.syncIdentityWithTransport();
      }

      // Auto-discover previously used HD addresses
      if (options.discoverAddresses !== false && sphere._transport.discoverAddresses) {
        progress?.({ step: 'discovering_addresses', message: 'Discovering addresses...' });
        try {
          const discoverOpts: DiscoverAddressesOptions =
            typeof options.discoverAddresses === 'object'
              ? { ...options.discoverAddresses, autoTrack: options.discoverAddresses.autoTrack ?? true }
              : { autoTrack: true };
          const result = await sphere.discoverAddresses(discoverOpts);
          if (result.addresses.length > 0) {
            logger.debug('Sphere', `Address discovery: found ${result.addresses.length} address(es)`);
          }
        } catch (err) {
          logger.warn('Sphere', 'Address discovery failed (non-fatal):', err);
        }
      }

      progress?.({ step: 'complete', message: 'Wallet created' });
    });

    return sphere;
  }

  /**
   * Load existing wallet from storage
   */
  static async load(options: SphereLoadOptions): Promise<Sphere> {
    // `undefined` leaves whatever the provider factory or consumer set; an explicit
    // `false` MUST turn debug off. A truthy-only check made this process-global flag
    // one-way — no second init could ever quieten it (#766).
    if (options.debug !== undefined) logger.configure({ debug: options.debug });

    // Fail-closed first: retired module options + the required wallet-api composition.
    Sphere.refuseRetiredModuleOptions(options);
    const composition = resolvePaymentsV2Composition(options.walletApi, options.network);

    // #772: see create() — recorded before the first storage read, refused at publication.
    const clearGeneration = Sphere.clearGenerationOf(options.storage);

    // Check if wallet exists
    if (!(await Sphere.exists(options.storage))) {
      throw new SphereError('No wallet found. Use Sphere.create() to create a new wallet.', 'NOT_INITIALIZED');
    }

    const progress = options.onProgress;

    // Configure TokenRegistry in main bundle context (see init() for details)
    Sphere.configureTokenRegistry(options.storage, options.network);

    const groupChatConfig = Sphere.resolveGroupChatConfig(options.groupChat, options.network);
    const marketConfig = Sphere.resolveMarketConfig(options.market);

    const sphere = new Sphere(
      options.storage,
      options.transport,
      options.oracle,
      options.price,
      groupChatConfig,
      marketConfig,
      options.communications,
    );
    sphere._verification = options.verification;
    sphere._paymentsV2Composition = composition;
    sphere._password = options.password ?? null;
    sphere._passwordProtected = sphere._password !== null;

    // exists() restores original (disconnected) state — reconnect for reads
    if (!options.storage.isConnected()) {
      await options.storage.connect();
    }

    // Load identity from storage
    progress?.({ step: 'storing_keys', message: 'Loading wallet keys...' });
    await sphere.loadIdentityFromStorage();

    // Initialize everything
    progress?.({ step: 'initializing', message: 'Initializing wallet...' });
    await Sphere.withOwnedRegistry(sphere, options.storage, options.network, clearGeneration, async () => {
      await sphere.initializeProviders();
      await sphere.initializeModules();

      // Publish identity binding via transport
      progress?.({ step: 'syncing_identity', message: 'Publishing identity...' });
      await sphere.syncIdentityWithTransport();

      sphere._initialized = true;

      // Auto-discover previously used HD addresses
      if (options.discoverAddresses !== false && sphere._transport.discoverAddresses && sphere._masterKey) {
        progress?.({ step: 'discovering_addresses', message: 'Discovering addresses...' });
        try {
          const discoverOpts: DiscoverAddressesOptions =
            typeof options.discoverAddresses === 'object'
              ? { ...options.discoverAddresses, autoTrack: options.discoverAddresses.autoTrack ?? true }
              : { autoTrack: true };
          const result = await sphere.discoverAddresses(discoverOpts);
          if (result.addresses.length > 0) {
            logger.debug('Sphere', `Address discovery: found ${result.addresses.length} address(es)`);
          }
        } catch (err) {
          logger.warn('Sphere', 'Address discovery failed (non-fatal):', err);
        }
      }

      progress?.({ step: 'complete', message: 'Wallet loaded' });
    });

    return sphere;
  }

  /**
   * Import wallet from mnemonic or master key
   */
  static async import(options: SphereImportOptions): Promise<Sphere> {
    // `undefined` leaves whatever the provider factory or consumer set; an explicit
    // `false` MUST turn debug off. A truthy-only check made this process-global flag
    // one-way — no second init could ever quieten it (#766).
    if (options.debug !== undefined) logger.configure({ debug: options.debug });

    // Fail-closed BEFORE the destructive clear below: retired module options +
    // the required wallet-api composition.
    Sphere.refuseRetiredModuleOptions(options);
    const composition = resolvePaymentsV2Composition(options.walletApi, options.network);

    if (!options.mnemonic && !options.masterKey) {
      throw new SphereError('Either mnemonic or masterKey is required', 'INVALID_CONFIG');
    }

    const progress = options.onProgress;

    logger.debug('Sphere', 'Starting import...');

    // Clear existing wallet if any. Skip if no active instance and wallet
    // doesn't exist — avoids a redundant IndexedDB delete/reopen that can race
    // with a subsequent initialize().
    const needsClear = Sphere.liveOn(options.storage).length > 0 || (await Sphere.exists(options.storage));
    if (needsClear) {
      progress?.({ step: 'clearing', message: 'Clearing previous wallet data...' });
      logger.debug('Sphere', 'Clearing existing wallet data...');
      await Sphere.clear({ storage: options.storage });
      logger.debug('Sphere', 'Clear done');
    } else {
      logger.debug('Sphere', 'No existing wallet — skipping clear');
    }

    // Ensure storage is connected (clear may have called destroy() on the
    // previous instance which disconnects the shared storage provider)
    if (!options.storage.isConnected()) {
      logger.debug('Sphere', 'Reconnecting storage...');
      await options.storage.connect();
      logger.debug('Sphere', 'Storage reconnected');
    }

    // #772: recorded AFTER import's OWN clear above, which bumps the generation. Recording
    // it earlier would make every import refuse its own publication.
    const clearGeneration = Sphere.clearGenerationOf(options.storage);

    // Configure TokenRegistry for THIS network in the main bundle context.
    // import() previously omitted this (unlike init/create/load), leaving the
    // registry on a stale/default network — so imported wallets resolved tokens
    // against the wrong-network registry (no icons) until a reload.
    Sphere.configureTokenRegistry(options.storage, options.network);

    const groupChatConfig = Sphere.resolveGroupChatConfig(options.groupChat, options.network);
    const marketConfig = Sphere.resolveMarketConfig(options.market);

    const sphere = new Sphere(
      options.storage,
      options.transport,
      options.oracle,
      options.price,
      groupChatConfig,
      marketConfig,
      options.communications,
    );
    sphere._verification = options.verification;
    sphere._paymentsV2Composition = composition;
    sphere._password = options.password ?? null;
    sphere._passwordProtected = sphere._password !== null;

    progress?.({ step: 'storing_keys', message: 'Storing wallet keys...' });

    if (options.mnemonic) {
      // Validate and store mnemonic
      if (!Sphere.validateMnemonic(options.mnemonic)) {
        throw new SphereError('Invalid mnemonic', 'INVALID_IDENTITY');
      }
      logger.debug('Sphere', 'Storing mnemonic...');
      await sphere.storeMnemonic(options.mnemonic, options.derivationPath, options.basePath);
      logger.debug('Sphere', 'Initializing identity from mnemonic...');
      await sphere.initializeIdentityFromMnemonic(options.mnemonic, options.derivationPath);
    } else if (options.masterKey) {
      // Store master key directly
      logger.debug('Sphere', 'Storing master key...');
      await sphere.storeMasterKey(
        options.masterKey,
        options.chainCode,
        options.derivationPath,
        options.basePath,
        options.derivationMode
      );
      logger.debug('Sphere', 'Initializing identity from master key...');
      await sphere.initializeIdentityFromMasterKey(
        options.masterKey,
        options.chainCode,
        options.derivationPath
      );
    }

    // Initialize everything
    progress?.({ step: 'initializing', message: 'Initializing wallet...' });
    logger.debug('Sphere', 'Initializing providers...');
    await Sphere.withOwnedRegistry(sphere, options.storage, options.network, clearGeneration, async () => {
      await sphere.initializeProviders();
      await sphere.initializeModules();
      logger.debug('Sphere', 'Modules initialized');

      // Try to recover nametag from transport (if no nametag provided and wallet previously had one)
      if (!options.nametag) {
        progress?.({ step: 'recovering_nametag', message: 'Recovering nametag...' });
        logger.debug('Sphere', 'Recovering Unicity ID from transport...');
        await sphere.recoverNametagFromTransport();
        logger.debug('Sphere', 'Unicity ID recovery done');
        // Publish identity binding (with recovered nametag if found)
        progress?.({ step: 'syncing_identity', message: 'Publishing identity...' });
        await sphere.syncIdentityWithTransport();
      }

      // Mark wallet as created only after successful initialization
      progress?.({ step: 'finalizing', message: 'Finalizing wallet creation...' });
      logger.debug('Sphere', 'Finalizing wallet creation...');
      await sphere.finalizeWalletCreation();

      sphere._initialized = true;

      // Track address 0 in the registry
      logger.debug('Sphere', 'Tracking address 0...');
      await sphere.ensureAddressTracked(0);

      // Register nametag if provided (this overrides any recovered nametag)
      if (options.nametag) {
        progress?.({ step: 'registering_nametag', message: 'Registering nametag...' });
        logger.debug('Sphere', 'Registering Unicity ID...');
        await sphere.registerNametag(options.nametag);
      }

      // Auto-discover previously used HD addresses
      if (options.discoverAddresses !== false && sphere._transport.discoverAddresses) {
        progress?.({ step: 'discovering_addresses', message: 'Discovering addresses...' });
        try {
          const discoverOpts: DiscoverAddressesOptions =
            typeof options.discoverAddresses === 'object'
              ? { ...options.discoverAddresses, autoTrack: options.discoverAddresses.autoTrack ?? true }
              : { autoTrack: true };
          const result = await sphere.discoverAddresses(discoverOpts);
          if (result.addresses.length > 0) {
            logger.debug('Sphere', `Address discovery: found ${result.addresses.length} address(es)`);
          }
        } catch (err) {
          logger.warn('Sphere', 'Address discovery failed (non-fatal):', err);
        }
      }

      progress?.({ step: 'complete', message: 'Import complete' });
      logger.debug('Sphere', 'Import complete');
    });

    return sphere;
  }

  /**
   * Clear all SDK-owned wallet data from storage: wallet keys, per-address
   * data, and the payments vertical's `pv2g2:{network}:{pubkey}:*` scoped KV
   * (refresh token, cursors, journals — all live in the plain StorageProvider,
   * so the full KV wipe below removes them). Tokens are server-custody; the
   * only local token artifacts are orphaned `sphere-token-storage-*` IndexedDB
   * databases left by pre-flip versions, swept here as hygiene.
   *
   * Does NOT affect application-level data stored outside the SDK.
   *
   * @example
   * await Sphere.clear({ storage: providers.storage });
   */
  static async clear(options: { storage: StorageProvider }): Promise<void> {
    const storage = options.storage;
    // Bumped on ENTRY and again on exit, so an init that publishes anywhere in this
    // window is refused too — not only one that publishes after the wipe (#772). The
    // snapshot below is taken before the wipe, so a Sphere that registers between the
    // two is neither destroyed here nor able to keep its data.
    Sphere.bumpClearGeneration(storage);
    try {
      await Sphere.clearStore(storage);
    } finally {
      Sphere.bumpClearGeneration(storage);
    }
  }

  private static async clearStore(storage: StorageProvider): Promise<void> {
    // 1. Destroy Sphere instance — stops the payments vertical (quiescence),
    //    then closes all connections.
    // Scoped on purpose: destroying whichever Sphere was constructed last silently
    // killed a live wallet on an unrelated provider, dropping every sphere.on() handler
    // with no event and no error (#766). A Sphere on other storage is not our business.
    for (const live of Sphere.liveOn(storage)) {
      logger.debug('Sphere', 'Destroying Sphere instance on this storage...');
      await live.destroy();
      logger.debug('Sphere', 'Sphere instance destroyed');
    }

    // 2. Yield to let IndexedDB finalize pending transactions after close().
    //    db.close() is synchronous but the connection isn't fully released
    //    until all in-flight transactions complete.
    logger.debug('Sphere', 'Yielding 50ms for IDB transaction settlement...');
    await new Promise((r) => setTimeout(r, 50));

    // 3. Sweep orphaned pre-flip token databases (sphere-token-storage-*).
    await Sphere.sweepOrphanedTokenDatabases();

    // 4. Delete KV database (sphere-storage) — includes the pv2 scoped KV.
    logger.debug('Sphere', 'Clearing KV storage...');
    if (!storage.isConnected()) {
      try {
        await storage.connect();
      } catch {
        // May fail if database was already deleted — that's fine
      }
    }
    if (storage.isConnected()) {
      await storage.clear();
      logger.debug('Sphere', 'KV storage cleared');
    } else {
      logger.debug('Sphere', 'KV storage not connected, skipping');
    }

    // 5. Best-effort: drop the orphaned vesting cache from prior versions.
    Sphere.cleanupOrphanedVestingCache(false);

    logger.debug('Sphere', 'Done');
  }

  /**
   * Raw `indexedDB.deleteDatabase` sweep of `sphere-token-storage-*` databases
   * left by pre-flip versions (tokens are server-custody now). Browser-only,
   * best-effort; loud log per deleted database.
   */
  private static async sweepOrphanedTokenDatabases(): Promise<void> {
    try {
      if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') return;
      const dbs = await indexedDB.databases();
      for (const db of dbs) {
        if (db.name && db.name.startsWith('sphere-token-storage')) {
          logger.warn('Sphere', `Deleting orphaned pre-flip token database: ${db.name}`);
          indexedDB.deleteDatabase(db.name);
        }
      }
    } catch (err) {
      logger.warn('Sphere', 'Orphaned token-database sweep failed (non-fatal):', err);
    }
  }

  /**
   * Best-effort delete of the orphaned `SphereVestingCacheV5` IndexedDB left by
   * prior versions. Browser-only; never throws.
   * @param once When true, runs at most once per process (load/init path); when
   *             false, always runs (explicit clear()).
   */
  private static cleanupOrphanedVestingCache(once: boolean): void {
    if (once) {
      if (Sphere._orphanCacheCleaned) return;
      Sphere._orphanCacheCleaned = true;
    }
    try {
      if (typeof indexedDB !== 'undefined') {
        indexedDB.deleteDatabase('SphereVestingCacheV5');
      }
    } catch { /* ignore — cleanup is best-effort */ }
  }

  /**
   * The key a provider registers under: the store it addresses, so every provider
   * over one dataDir/DB shares an entry. A provider that declares no store keeps a
   * private key, leaving custom implementations scoped by object identity.
   */
  private static storeKeyOf(storage: StorageProvider): string {
    const declared = storage.backingStoreId;
    if (declared) return `store:${declared}`;
    let key = Sphere._objectStoreKeys.get(storage);
    if (!key) {
      key = `object:${++Sphere._objectStoreSeq}`;
      Sphere._objectStoreKeys.set(storage, key);
    }
    return key;
  }

  /** The clears this store has seen. Absent means none — `clear()` creates the entry. */
  private static clearGenerationOf(storage: StorageProvider): number {
    return Sphere._clearGenerations.get(Sphere.storeKeyOf(storage)) ?? 0;
  }

  private static bumpClearGeneration(storage: StorageProvider): void {
    const key = Sphere.storeKeyOf(storage);
    Sphere._clearGenerations.set(key, (Sphere._clearGenerations.get(key) ?? 0) + 1);
  }

  /**
   * Make a fully-built Sphere reachable — or refuse, if `clear()` emptied the store
   * under it while it was building. Check and registration are one SYNCHRONOUS step on
   * purpose: split by an await, a clear could land between them and wipe a store whose
   * Sphere is already published. The refusal throws inside `withOwnedRegistry`, whose
   * teardown then destroys the half-built Sphere the caller never received.
   */
  private static publishLive(sphere: Sphere, clearGeneration: number): void {
    if (Sphere.clearGenerationOf(sphere._storage) !== clearGeneration) {
      throw new SphereError(
        'The wallet store was cleared while this wallet was initializing, so the keys and journals this init wrote are gone. Nothing was published; re-run Sphere.init() once the clear has settled.',
        'STORAGE_ERROR',
      );
    }
    Sphere.registerLive(sphere);
  }

  /** Record a fully-built Sphere against the storage it owns. See `_liveByStorage`. */
  private static registerLive(sphere: Sphere): void {
    const key = Sphere.storeKeyOf(sphere._storage);
    let live = Sphere._liveByStorage.get(key);
    if (!live) {
      live = new Set();
      Sphere._liveByStorage.set(key, live);
    }
    live.add(sphere);
  }

  private static unregisterLive(sphere: Sphere): void {
    const key = Sphere.storeKeyOf(sphere._storage);
    const live = Sphere._liveByStorage.get(key);
    if (!live) return;
    live.delete(sphere);
    // String keys mean the map holds them strongly: an emptied Set must go, or every
    // store ever opened is retained for the life of the process.
    if (live.size === 0) Sphere._liveByStorage.delete(key);
  }

  /** Snapshot — callers iterate this while destroy() mutates the underlying Set. */
  private static liveOn(storage: StorageProvider): Sphere[] {
    return Array.from(Sphere._liveByStorage.get(Sphere.storeKeyOf(storage)) ?? []);
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

  /** Payments (the §4 facade — the active address's running vertical). */
  get payments(): PaymentsV2 {
    const facade = this._paymentsV2Active?.facade;
    if (!facade) {
      // Not started yet (init in flight), mid address-switch, or destroyed.
      throw new SphereError('Sphere not initialized', 'NOT_INITIALIZED');
    }
    return facade;
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
      directAddress: this._identity.directAddress,
      ipnsName: this._identity.ipnsName,
      nametag: this._identity.nametag,
    };
  }

  /** Is ready */
  get isReady(): boolean {
    return this._initialized;
  }

  /** The active network id, from the oracle's root trust base (RootTrustBase.networkId,
   *  e.g. testnet2 = 4). Undefined if the oracle has no trust base. Used by ConnectHost
   *  to gate cross-network dApp connections. */
  get networkId(): number | undefined {
    const tb = this._oracle.getTrustBaseJson();
    if (tb && typeof tb === 'object') {
      const id = (tb as Record<string, unknown>).networkId;
      if (typeof id === 'number') return id;
    }
    return undefined;
  }

  // ===========================================================================
  // Public Methods - Signing
  // ===========================================================================

  /**
   * Sign a plaintext message with the wallet's secp256k1 private key.
   *
   * Returns a 130-character hex string: v (2) + r (64) + s (64).
   * The private key never leaves the SDK boundary.
   *
   * @throws SphereError if the wallet is not initialized or identity is missing
   */
  signMessage(message: string): string {
    if (!this._identity?.privateKey) {
      throw new SphereError('Wallet not initialized — cannot sign', 'NOT_INITIALIZED');
    }
    return signMessageCrypto(this._identity.privateKey, message);
  }

  // ===========================================================================
  // Public Methods - Providers Access
  // ===========================================================================

  getStorage(): StorageProvider {
    return this._storage;
  }

  /**
   * Set or update the price provider. Price is a composition-time property of
   * the payments vertical — verticals composed after this call (the next
   * address switch) pick it up.
   */
  setPriceProvider(provider: PriceProvider): void {
    this._priceProvider = provider;
  }

  getTransport(): TransportProvider {
    return this._transport;
  }

  /**
   * Fetch pending events from Nostr relay and process them through the
   * multi-address transport mux. This ensures DMs (invoice receipts,
   * escrow messages, transfer notifications) are delivered to module
   * handlers before reading in-memory state.
   *
   * Tolerates failures — returns silently if transport is not connected.
   */
  async fetchPendingEvents(): Promise<void> {
    if (this._transport.isConnected() && this._transport.fetchPendingEvents) {
      await this._transport.fetchPendingEvents();
    }
  }

  getAggregator(): OracleProvider {
    return this._oracle;
  }

  /**
   * Apply a new gateway API key to the LIVE oracle + token engine WITHOUT a full
   * Sphere rebuild (transport / realtime socket / discovery stay up). Use this to
   * inject a per-wallet subscription key provisioned AFTER init, or a per-address
   * key on an address switch, so the next money operation authenticates with it.
   *
   * Money-safety: the facade reads the engine through `engineRef()` and each
   * machine operation snapshots it at op start, so an in-flight send/mint
   * completes on the OLD key (submit + proof stay paired on one client) and
   * only operations started AFTER this call use the new key.
   * Only the ACTIVE address's engine is rebuilt — other tracked addresses re-key
   * on their next switch/build. No-op-safe if the engine can't be built (money
   * operations keep failing loudly until a working key arrives, same as init).
   */
  async setOracleApiKey(apiKey: string): Promise<void> {
    this._oracle.setApiKey?.(apiKey);
    // Rebuild ONLY the token engine (buildTokenEngine reads getApiKey() fresh)
    // and swap it into the live facade — no transport/socket/storage teardown,
    // unlike a full re-init.
    const active = this._addressModules.get(this._currentAddressIndex);
    const replaced = active?.tokenEngine ?? this._tokenEngine;
    this._tokenEngine = await this.buildTokenEngine();
    // Keep the active address's OWN record in step — it is what a later switch
    // back reads, and a stale entry would hand that address a disposed engine.
    if (active) active.tokenEngine = this._tokenEngine;
    // The facade snapshots its engine per operation — swap what FUTURE operations use. An
    // in-flight op keeps the OLD handle, which is NOT the same as finishing on it: disposal
    // cancels in-flight verification deterministically (the verify REJECTS), so an op that is
    // mid-verify when the key changes fails instead of completing. `verify` is a receive-path
    // read, never a spend — no money moves either way, but the caller sees an error.
    if (this._paymentsV2Active && this._tokenEngine) {
      this._paymentsV2Active.facade.setEngine(this._tokenEngine);
    }
    // Only now terminate what it replaced: the engine may own a verification
    // worker pool, and every api-key change would otherwise leak one.
    if (replaced && replaced !== this._tokenEngine) replaced.dispose?.();
  }

  /**
   * Import a wallet from a backup file: a `UNICITY WALLET DETAILS` text backup
   * (the format `exportToTxt` writes, optionally password-encrypted), a legacy
   * flat-JSON webwallet export, or a bare mnemonic in a text file.
   *
   * @example
   * const result = await Sphere.importFromLegacyFile({
   *   fileContent: await file.text(),
   *   fileName: file.name,
   *   password,          // when the backup is encrypted
   *   ...providers,
   * });
   */
  static async importFromLegacyFile(options: Omit<SphereImportOptions, 'mnemonic' | 'masterKey' | 'chainCode' | 'derivationPath' | 'basePath' | 'derivationMode'> & {
    /** The backup file's text. */
    fileContent: string;
    /** File name (used for type detection) */
    fileName: string;
    /** Password for encrypted files */
    password?: string;
    /** Progress callback for long decryption operations */
    onDecryptProgress?: DecryptionProgressCallback;
  }): Promise<{
    success: boolean;
    sphere?: Sphere;
    mnemonic?: string;
    needsPassword?: boolean;
    error?: string;
  }> {
    const { fileContent, fileName, password, onDecryptProgress: _onDecryptProgress, ...baseOptions } = options;

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

      const sphere = await Sphere.import({ ...baseOptions, mnemonic });
      return { success: true, sphere, mnemonic };
    }

    // Handle .txt file
    if (fileType === 'txt') {
      const content = fileContent;

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
        ...baseOptions,
        masterKey,
        chainCode,
        basePath,
        derivationMode: derivationMode || (chainCode ? 'bip32' : 'wif_hmac'),
      });

      return { success: true, sphere };
    }

    // Handle JSON
    if (fileType === 'json') {
      const content = fileContent;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(content);
      } catch {
        return { success: false, error: 'Invalid JSON file' };
      }

      // sphere-wallet format — delegate to importFromJSON
      if (parsed.type === 'sphere-wallet') {
        const result = await Sphere.importFromJSON({
          ...baseOptions,
          jsonContent: content,
          password,
        });

        if (result.success) {
          return { success: true, sphere: result.sphere, mnemonic: result.mnemonic };
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
        const sphere = await Sphere.import({ ...baseOptions, mnemonic, basePath });
        return { success: true, sphere, mnemonic };
      }

      const sphere = await Sphere.import({
        ...baseOptions,
        masterKey,
        chainCode,
        basePath,
        derivationMode: (derivationMode as DerivationMode) || (chainCode ? 'bip32' : 'wif_hmac'),
      });
      return { success: true, sphere };
    }

    return { success: false, error: 'Unsupported file type' };
  }

  /**
   * Detect legacy file type from filename and content
   */
  static detectLegacyFileType(fileName: string, content: string): LegacyFileType {

    // Check for JSON
    if (fileName.endsWith('.json')) {
      return 'json';
    }

    try {
      const trimmed = content.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        JSON.parse(trimmed);
        return 'json';
      }
    } catch {
      // Not JSON
    }

    // Check for mnemonic (12 or 24 words)
    const words = content.trim().split(/\s+/);
    if (
      (words.length === 12 || words.length === 24) &&
      words.every((w) => /^[a-z]+$/.test(w.toLowerCase()))
    ) {
      return 'mnemonic';
    }

    // Check for text wallet format
    if (isWalletTextFormat(content)) {
      return 'txt';
    }

    return 'unknown';
  }

  /**
   * Check if a legacy file is encrypted
   */
  static isLegacyFileEncrypted(fileName: string, content: string): boolean {
    const fileType = Sphere.detectLegacyFileType(fileName, content);

    if (fileType === 'txt') {
      return isTextWalletEncrypted(content);
    }

    if (fileType === 'json') {
      try {
        const data = JSON.parse(content);
        return !!data.encrypted;
      } catch {
        return false;
      }
    }

    return false;
  }

  /**
   * Check if wallet has BIP32 master key for HD derivation
   */
  hasMasterKey(): boolean {
    this.ensureReady();
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
    this.ensureReady();
    return this._mnemonic;
  }

  /**
   * Get wallet info for backup/export purposes
   */
  getWalletInfo(): WalletInfo {
    this.ensureReady();
    let address0: string | null = null;
    try {
      if (this._identity) {
        address0 = this._identity.chainPubkey;
      } else if (this._masterKey) {
        address0 = this.deriveAddress(0).publicKey;
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
      throw new SphereError('Wallet not initialized', 'NOT_INITIALIZED');
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
          address: addr.publicKey,
          publicKey: addr.publicKey,
          path: addr.path,
          index: addr.index,
        });
      } catch {
        // Stop if we can't derive more addresses (e.g., no masterKey)
        if (i === 0 && this._identity) {
          addresses.push({
            address: this._identity.chainPubkey,
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
      throw new SphereError('Wallet not initialized', 'NOT_INITIALIZED');
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
          address: addr.publicKey,
          path: addr.path,
          index: addr.index,
          isChange: false,
        });
      } catch {
        // Stop if we can't derive more addresses
        if (i === 0 && this._identity) {
          addresses.push({
            address: this._identity.chainPubkey,
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
   * @returns `{ success, sphere?, mnemonic?, error? }`. `sphere` is the instance built
   *   on the SUPPLIED storage — hold it, there is no global to look it up from (#766).
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
  static async importFromJSON(options: Omit<SphereImportOptions, 'mnemonic' | 'masterKey' | 'chainCode' | 'derivationPath' | 'basePath' | 'derivationMode'> & {
    jsonContent: string;
    password?: string;
  }): Promise<{ success: boolean; sphere?: Sphere; mnemonic?: string; error?: string }> {
    const { jsonContent, password, ...baseOptions } = options;

    try {
      const data = JSON.parse(jsonContent) as WalletJSON;

      if (data.version !== '1.0' || data.type !== 'sphere-wallet') {
        return { success: false, error: 'Invalid wallet format' };
      }

      // Decrypt if needed
      let mnemonic = data.mnemonic;
      let masterKey = data.wallet.masterPrivateKey;

      if (data.encrypted && password) {
        if (mnemonic) {
          const decrypted = decryptSimple(mnemonic, password);
          if (!decrypted) {
            return { success: false, error: 'Failed to decrypt mnemonic - wrong password?' };
          }
          mnemonic = decrypted;
        }
        if (masterKey) {
          const decrypted = decryptSimple(masterKey, password);
          if (!decrypted) {
            return { success: false, error: 'Failed to decrypt master key - wrong password?' };
          }
          masterKey = decrypted;
        }
      } else if (data.encrypted && !password) {
        return { success: false, error: 'Password required for encrypted wallet' };
      }

      // Determine base path
      const basePath = data.wallet.descriptorPath
        ? `m/${data.wallet.descriptorPath}`
        : DEFAULT_BASE_PATH;

      // Import using mnemonic if available (preferred)
      if (mnemonic) {
        const sphere = await Sphere.import({ ...baseOptions, mnemonic, basePath });
        return { success: true, sphere, mnemonic };
      }

      // Otherwise import using master key
      if (masterKey) {
        const sphere = await Sphere.import({
          ...baseOptions,
          masterKey,
          chainCode: data.wallet.chainCode,
          basePath,
          derivationMode: data.derivationMode || (data.wallet.isBIP32 ? 'bip32' : 'wif_hmac'),
        });
        return { success: true, sphere };
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
      throw new SphereError(`Address at index ${index} is not tracked. Switch to it first.`, 'INVALID_CONFIG');
    }
    if (entry.hidden === hidden) return;

    // `updatedAt` moves with `hidden`: the registry merge (#766 item 5) resolves a
    // conflicting entry by the greater `updatedAt`, so a stale flag left with its old
    // timestamp would let another Sphere's snapshot win and silently undo this change.
    (entry as { hidden: boolean; updatedAt: number }).hidden = hidden;
    (entry as { hidden: boolean; updatedAt: number }).updatedAt = Date.now();
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
   * console.log(sphere.identity?.directAddress); // DIRECT://... (address at index 1)
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
      throw new SphereError('HD derivation requires master key with chain code. Cannot switch addresses.', 'INVALID_CONFIG');
    }

    // If nametag requested, normalize and validate format early
    const newNametag = options?.nametag ? this.cleanNametag(options.nametag) : undefined;
    if (newNametag && !isValidNametag(newNametag)) {
      throw new SphereError('Invalid Unicity ID format. Use lowercase alphanumeric, underscore, or hyphen (3-20 chars), or a valid phone number.', 'VALIDATION_ERROR');
    }

    // No-op switch: already active on this index with no nametag change. Skip the
    // logout / re-bind / re-sign-in / re-sync cycle — it would otherwise reset the
    // wallet-api JWT, clear caches, and cause needless network traffic + inventory
    // flicker for a call that changes nothing (Copilot review on #581).
    if (index === this._currentAddressIndex && newNametag === undefined) {
      return;
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
        throw new SphereError(`Unicity ID @${newNametag} is already taken`, 'VALIDATION_ERROR');
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

    // Build identity for new address
    const newIdentity: MutableFullIdentity = {
      privateKey: addressInfo.privateKey,
      chainPubkey: addressInfo.publicKey,
      directAddress: predicateAddress,
      ipnsName: '12D3KooW' + ipnsHash,
      nametag,
    };

    // =========================================================================
    // Per-Address Module Architecture: Lazy Init + Pointer Switch
    // No destroy and no drain — the old address keeps running.
    // =========================================================================

    const firstVisit = !this._addressModules.has(index);

    if (firstVisit) {
      // First time switching to this address — create independent modules
      logger.debug('Sphere', `switchToAddress(${index}): creating per-address modules (lazy init)`);

      // CRITICAL: Update shared storage identity BEFORE loading per-address modules.
      // IndexedDBStorageProvider.getFullKey() uses this.identity to build per-address
      // storage keys.  Without this, modules would load the previous address's data.
      this._storage.setIdentity(newIdentity);

      // #770: every await below re-checks liveness. switchToAddress calls ensureReady() ONCE
      // at entry and then awaits ~8 times; destroy() can land in any of those gaps. This step
      // is the transport vector: initializeAddressModules → ensureTransportMux BUILDS and
      // connect()s a fresh mux whenever `_transportMux` is null — exactly what destroy()
      // leaves behind — so an unguarded switch opens new sockets after teardown returned.
      this.ensureAlive();
      await this.initializeAddressModules({ index, identity: newIdentity });
    } else if (nametag !== this._addressModules.get(index)!.identity.nametag) {
      // Modules already exist — only the nametag label changed.
      this._addressModules.get(index)!.identity = newIdentity;
    }

    // Switch the active pointer — instant, no destroy
    this._identity = newIdentity;
    this._currentAddressIndex = index;

    // Update active module references for backward compatibility
    const activeModules = this._addressModules.get(index)!;
    // The engine pointer MUST follow the active address: a re-visit does not
    // re-run initializeAddressModules, so leaving it behind means `_tokenEngine`
    // names a DIFFERENT address's engine — and anything acting on it
    // (setOracleApiKey's rebuild, destroy's dispose) hits the wrong wallet.
    this._tokenEngine = activeModules.tokenEngine;
    this._communications = activeModules.communications;
    this._groupChat = activeModules.groupChat;
    this._market = activeModules.market;

    // §7: an address switch is stop-then-start — the previous vertical fully
    // stops (quiescence: its in-flight ops settle) BEFORE the new one starts,
    // so two verticals never write one per-address KV; the lifecycle mutex
    // serializes overlapping switches. Re-visits compose a FRESH vertical
    // (durable state lives in the scoped KV; a stopped session can't restart).
    this.ensureAlive();
    await this.stopThenStartPaymentsV2(index, newIdentity);

    // #770: a refused switch must not leave its index on disk. Without this guard a switch
    // that destroy() overtook still persisted the address it never finished moving to, so the
    // NEXT boot loaded a different wallet address than the one the user was last on — and the
    // write can race destroy()'s provider disconnect besides.
    this.ensureAlive();
    // Persist current index
    await this._storage.set(STORAGE_KEYS_GLOBAL.CURRENT_ADDRESS_INDEX, index.toString());

    // Update storage identity for per-address key scoping
    this._storage.setIdentity(this._identity);

    // Provide fallback 'since' for first-time Nostr subscriptions
    if (this._transport.setFallbackSince) {
      const fallbackTs = Math.floor(Date.now() / 1000) - 86400;
      this._transport.setFallbackSince(fallbackTs);
    }

    // Defence in depth, and NOT individually falsifiable: the index-persist guard above
    // throws first on every path that reaches here, so deleting this one changes no
    // observable behaviour. It stays for the await between them (#770).
    this.ensureAlive();
    await this._transport.setIdentity(this._identity);

    // The transport recreates its NostrClient on identity change (the
    // SDK's client doesn't support runtime key swaps). When the Mux is
    // sharing that client (#123), it must rebind to the new instance
    // and re-establish its wallet/chat subscriptions on the new socket.
    this.ensureAlive();
    if (this._transportMux && typeof (this._transportMux as { rebindToSharedClient?: () => Promise<void> }).rebindToSharedClient === 'function') {
      await (this._transportMux as { rebindToSharedClient: () => Promise<void> }).rebindToSharedClient();
    }

    this.emitEvent('identity:changed', {
      directAddress: this._identity.directAddress,
      chainPubkey: this._identity.chainPubkey,
      nametag: this._identity.nametag,
      addressIndex: index,
    });

    logger.debug('Sphere', `Switched to address ${index}:`, this._identity.chainPubkey);

    // Run transport sync and nametag operations in background
    this.postSwitchSync(index, newNametag).catch(err => {
      logger.warn('Sphere', `Post-switch sync failed for address ${index}:`, err);
    });
  }

  /**
   * Background transport sync and nametag operations after address switch.
   * Runs after switchToAddress returns so L3 queries can start immediately.
   */
  private async postSwitchSync(index: number, newNametag?: string): Promise<void> {
    // Fire-and-forget from switchToAddress, so this is the one switch step that can outlive
    // its caller (#770). Defensive only: it guards ENTRY, and the ensureAlive() before
    // setIdentity already refuses earlier on this path — it stays so that a future reordering
    // of switchToAddress cannot silently restart nametag registration / transport rebinding.
    this.ensureAlive();

    // Sync identity with transport — recovers nametag from existing Nostr bindings
    if (!newNametag) {
      await this.syncIdentityWithTransport();
    }

    // If a new nametag was registered on switch, persist the cache and emit. The Nostr
    // binding stays the registration record (D5); the on-chain UnicityIdToken claim is
    // additionally minted + stored below, best-effort.
    if (newNametag) {
      await this.persistAddressNametags();

      this.emitEvent('nametag:registered', {
        nametag: newNametag,
        addressIndex: index,
      });
    }
  }

  /**
   * Create a new set of per-address modules for the given index.
   * Each address gets its own CommunicationsModule etc. and can run
   * independently in background. The payments vertical is NOT created here —
   * the caller starts it via stopThenStartPaymentsV2 (§7 single vertical).
   */
  private async initializeAddressModules(
    spec: { index: number; identity: FullIdentity },
  ): Promise<AddressModuleSet> {
    const { index, identity } = spec;

    const emitEvent = this.emitEvent.bind(this);

    // Ensure transport mux exists for non-primary addresses
    const adapter = await this.ensureTransportMux(index, identity);

    // Use the adapter for transport-dependent modules (address-specific event routing)
    // Resolve operations are delegated to the original transport
    const addressTransport: TransportProvider = adapter ?? this._transport;

    // Forward dmSince to the raw transport when no mux is used
    if (!adapter && this._dmSince != null && addressTransport.setFallbackDmSince) {
      addressTransport.setFallbackDmSince(this._dmSince);
    }

    // Create fresh module instances for this address
    const communications = createCommunicationsModule(this._communicationsConfig);
    const groupChat = this._groupChatConfig ? createGroupChatModule(this._groupChatConfig) : null;
    const market = this._marketConfig ? createMarketModule(this._marketConfig) : null;

    // v2 token engine for THIS address (bound to its signing key).
    const tokenEngine = await this.buildTokenEngine(identity);

    communications.initialize({
      identity,
      storage: this._storage,
      transport: addressTransport,
      emitEvent,
    });

    groupChat?.initialize({
      identity,
      storage: this._storage,
      emitEvent,
    });

    market?.initialize({
      identity,
      emitEvent,
    });

    // Non-critical modules load in parallel — failures are non-fatal
    const results = await Promise.allSettled([
      communications.load(),
      groupChat?.load(),
      market?.load(),
    ]);
    for (const r of results) {
      if (r.status === 'rejected') {
        logger.warn('Sphere', 'Module load failed:', r.reason);
      }
    }

    const moduleSet: AddressModuleSet = {
      index,
      identity,
      communications,
      groupChat,
      market,
      transportAdapter: adapter,
      tokenEngine,
      initialized: true,
    };

    this._addressModules.set(index, moduleSet);
    logger.debug('Sphere', `Initialized per-address modules for address ${index} (transport: ${adapter ? 'mux adapter' : 'primary'})`);

    return moduleSet;
  }

  /**
   * Ensure the transport multiplexer exists and register an address.
   * Creates the mux on first call. Returns an AddressTransportAdapter
   * that routes events for this address independently.
   * @returns AddressTransportAdapter or null if transport is not Nostr-based
   */
  private async ensureTransportMux(index: number, identity: FullIdentity): Promise<AddressTransportAdapter | null> {
    // Duck-type check for Nostr transport (instanceof won't work across tsup bundles)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transport = this._transport as any;
    if (typeof transport.getWebSocketFactory !== 'function' ||
        typeof transport.getConfiguredRelays !== 'function') {
      logger.debug('Sphere', 'Transport does not support mux interface, skipping');
      return null;
    }

    const nostrTransport = transport;

    // Create mux on first call
    if (!this._transportMux) {
      this._transportMux = new MultiAddressTransportMux({
        relays: nostrTransport.getConfiguredRelays(),
        createWebSocket: nostrTransport.getWebSocketFactory(),
        storage: nostrTransport.getStorageAdapter() ?? undefined,
        // #123: share the original transport's NostrClient instead of
        // opening a second WebSocket per relay. Pass a getter so the
        // Mux resolves it at connect-time (after the transport finishes
        // its own connect()).
        sharedNostrClient: typeof nostrTransport.getNostrClient === 'function'
          ? () => nostrTransport.getNostrClient()
          : undefined,
      });

      // Connect the mux
      await this._transportMux.connect();

      // Suppress original transport's subscriptions to avoid duplicate event handling.
      // Original transport stays connected for resolve/identity-binding operations.
      if (typeof nostrTransport.suppressSubscriptions === 'function') {
        nostrTransport.suppressSubscriptions();
      }

      logger.debug('Sphere', 'Transport mux created and connected');
    }

    // Forward dmSince fallback to the mux for this address
    if (this._dmSince != null) {
      this._transportMux.setFallbackDmSince(index, this._dmSince);
    }

    // Register address in the mux (resolve delegated to original transport)
    const adapter = await this._transportMux.addAddress(index, identity, this._transport);
    return adapter;
  }

  /** A BIP32 child number: an integer in 0…0xffffffff. Anything else aliases an address. */
  private static assertDerivableIndex(index: number): void {
    if (isDerivableIndex(index)) return;
    throw new SphereError(
      `Address index ${String(index)} is not a BIP32 child number: it must be an integer in 0…0xffffffff.`,
      'INVALID_CONFIG',
    );
  }

  /**
   * Derive address at a specific index
   *
   * @param index - Address index (0, 1, 2, ...)
   * @param isChange - Whether this is a change address (default: false)
   * @returns Address info with privateKey, publicKey, path, index
   *
   * @example
   * ```ts
   * // Derive first receiving address
   * const addr0 = sphere.deriveAddress(0);
   * console.log(addr0.publicKey); // 02... (compressed chain pubkey)
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
   * Internal getActiveAddresses without ensureReady() check.
   * IMPORTANT: This method skips ensureReady() because it's called during initialization
   * before _initialized is set. It REQUIRES that loadTrackedAddresses() has already completed.
   */
  private _getActiveAddressesInternal(): TrackedAddress[] {
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
   * Internal address derivation without ensureReady() check.
   * Used during initialization (loadTrackedAddresses, ensureAddressTracked)
   * when _initialized is still false.
   */
  private _deriveAddressInternal(index: number, isChange: boolean = false): AddressInfo {
    // The path segment is parseInt()ed downstream, so 1.5 silently derives index 1's keys,
    // and a child number past 0xffffffff pads to more than 8 hex digits and derives
    // off-standard. Refused at the one point every index reaches derivation through —
    // deriveAddress, ensureAddressTracked, discovery and switchToAddress alike.
    Sphere.assertDerivableIndex(index);

    if (!this._masterKey) {
      throw new SphereError('HD derivation requires master key with chain code', 'INVALID_CONFIG');
    }

    // WIF/HMAC mode: legacy HMAC-SHA512 derivation (no chain code, no change addresses)
    if (this._derivationMode === 'wif_hmac') {
      return generateAddressFromMasterKey(this._masterKey.privateKey, index);
    }

    return deriveAddressInfo(
      this._masterKey,
      this._basePath,
      index,
      isChange
    );
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
      throw new SphereError('HD derivation requires master key with chain code', 'INVALID_CONFIG');
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
        // Bump `updatedAt` with `hidden` — the registry merge (#766 item 5) breaks a
        // conflict by the greater `updatedAt`, so an unbumped flag can be overwritten
        // by another Sphere's older snapshot.
        (tracked as { hidden: boolean; updatedAt: number }).hidden = hidden;
        (tracked as { hidden: boolean; updatedAt: number }).updatedAt = Date.now();
      }
    }

    await this.persistTrackedAddresses();
    await this.persistAddressNametags();
  }

  /**
   * Discover previously used HD addresses.
   *
   * Queries Nostr relay for identity binding events (fast, single batch query).
   *
   * @example
   * ```ts
   * const result = await sphere.discoverAddresses();
   * console.log(`Found ${result.addresses.length} addresses`);
   *
   * // With auto-tracking
   * await sphere.discoverAddresses({ autoTrack: true });
   * ```
   */
  async discoverAddresses(
    options: DiscoverAddressesOptions = {},
  ): Promise<DiscoverAddressesResult> {
    this.ensureReady();

    if (!this._masterKey) {
      throw new SphereError('Address discovery requires HD master key', 'INVALID_CONFIG');
    }

    if (!this._transport.discoverAddresses) {
      throw new SphereError('Transport provider does not support address discovery', 'INVALID_CONFIG');
    }

    // Phase 1: Transport (Nostr) binding event scan
    const transportResult = await discoverAddressesImpl(
      (index: number) => {
        const addrInfo = this._deriveAddressInternal(index, false);
        return {
          transportPubkey: addrInfo.publicKey.slice(2), // x-only 32 bytes
          chainPubkey: addrInfo.publicKey,
          directAddress: '', // not needed for discovery query
        };
      },
      (pubkeys: string[]) => this._transport.discoverAddresses!(pubkeys),
      options,
    );

    // Phase 2: Auto-track if requested
    if (options.autoTrack && transportResult.addresses.length > 0) {
      await this.trackScannedAddresses(
        transportResult.addresses.map(a => ({
          index: a.index,
          // Preserve existing hidden state; default to false for newly discovered
          hidden: this._trackedAddresses.get(a.index)?.hidden ?? false,
          nametag: a.nametag,
        })),
      );
    }

    return transportResult;
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
      // Token custody is server-side (wallet-api) — no local token-storage providers.
      tokenStorage: [],
      transport: [mkInfo(this._transport, 'transport', transportMeta)],
      oracle: [mkInfo(this._oracle, 'oracle')],
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
      throw new SphereError('Cannot disable the main storage provider', 'INVALID_CONFIG');
    }

    const provider = this.findProviderById(providerId);
    if (!provider) return false;

    this._disabledProviders.add(providerId);

    try {
      if ('disable' in provider && typeof provider.disable === 'function') {
        // Provider with a dedicated disable() that disconnects + blocks operations
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

    // Provider with a dedicated enable() that reconnects lazily on next operation
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
    if (this._priceProvider && this._priceProviderId === providerId) {
      return this._priceProvider;
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
   * Resolve any identifier to full peer information.
   * Accepts @nametag, bare nametag, DIRECT://, chain pubkey, or transport pubkey.
   *
   * @example
   * ```ts
   * const peer = await sphere.resolve('@alice');
   * const peer = await sphere.resolve('DIRECT://...');
   * const peer = await sphere.resolve('02ab12...'); // 33-byte compressed chain pubkey
   * const peer = await sphere.resolve('ab12cd...'); // 64-char hex transport pubkey
   * ```
   */
  async resolve(identifier: string): Promise<PeerInfo | null> {
    this.ensureReady();
    return this._transport.resolve?.(identifier) ?? null;
  }

  /**
   * Pre-resolve a Unicity address for DM delivery.
   *
   * Warms the CommunicationsModule's internal resolution cache so that
   * subsequent sendDM() calls to this address avoid the network round-trip.
   * Useful before a batch of DM operations (e.g., sending hello_ack to
   * multiple tenants, or broadcasting to a list of agents).
   *
   * @param address - Any valid Unicity address (@nametag, DIRECT://, hex pubkey)
   * @throws SphereError if the address cannot be resolved
   */
  async preResolveDM(address: string): Promise<void> {
    this.ensureReady();
    // Pre-resolve via transport for DM delivery
    const peerInfo = await this._transport.resolve?.(address);
    if (!peerInfo) {
      throw new SphereError(`Cannot resolve address: ${address.slice(0, 30)}`, 'INVALID_RECIPIENT');
    }
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
      throw new SphereError('Invalid Unicity ID format. Use lowercase alphanumeric, underscore, or hyphen (3-20 chars), or a valid phone number.', 'VALIDATION_ERROR');
    }

    // Check if current address already has a nametag
    if (this._identity?.nametag) {
      throw new SphereError(`Unicity ID already registered for address ${this._currentAddressIndex}: @${this._identity.nametag}`, 'ALREADY_INITIALIZED');
    }

    // Register the nametag by publishing the Nostr identity binding (name ↔ chainPubkey).
    // D5: nametags are Nostr bindings only — there is no on-chain nametag token. Receive is
    // always SignaturePredicate(chainPubkey); the binding is the sole registration act. The
    // binding carries the UNIP-01 marker, so the relay enforces single ownership — a publish
    // for a name already owned by another key is rejected (the failure path below).
    if (this._transport.publishIdentityBinding) {
      const success = await this._transport.publishIdentityBinding(
        this._identity!.chainPubkey,
        this._identity!.directAddress || '',
        cleanNametag,
      );
      if (!success) {
        throw new SphereError('Failed to register Unicity ID. It may already be taken.', 'VALIDATION_ERROR');
      }
    }

    // Update local state.
    this._identity!.nametag = cleanNametag;

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

    this.emitEvent('nametag:registered', {
      nametag: cleanNametag,
      addressIndex: this._currentAddressIndex,
    });
    logger.debug('Sphere', `Unicity ID registered for address ${this._currentAddressIndex}:`, cleanNametag);
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
   * Check whether a nametag is available to register.
   *
   * D5: nametags are Nostr bindings (name ↔ chainPubkey), not on-chain tokens. Availability is
   * determined by UNIP-01 resolution — a name is available iff no binding resolves for it.
   *
   * @param nametag - The nametag to check (e.g., "alice" or "@alice")
   * @returns true if available, false if already taken
   */
  async isNametagAvailable(nametag: string): Promise<boolean> {
    this.ensureReady();
    if (!this._transport.resolveNametag) return true;
    const bound = await this._transport.resolveNametag(this.cleanNametag(nametag));
    return bound == null;
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
   * Always publishes base identity (chainPubkey, directAddress).
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
                  this._identity!.directAddress || '',
                  recoveredNametag,
                );
                logger.debug('Sphere', `Migrated legacy binding with Unicity ID @${recoveredNametag}`);
                return;
              }
            }

            // Check if existing binding is missing critical fields — re-publish if so
            const needsUpdate =
              !existing.directAddress ||
              !existing.chainPubkey ||
              (this._identity?.nametag && !existing.nametag);

            if (needsUpdate) {
              logger.debug('Sphere', 'Existing binding incomplete, re-publishing with full data');
              await this._transport.publishIdentityBinding!(
                this._identity!.chainPubkey,
                this._identity!.directAddress || '',
                this._identity?.nametag || existing.nametag || undefined,
              );
              return;
            }

            logger.debug('Sphere', 'Existing binding found, skipping re-publish');
            return;
          }
        } catch (e) {
          // resolve failed — do NOT fall through to publish, as it could
          // overwrite an existing binding (with nametag) with one without.
          // Next reload will retry.
          logger.warn('Sphere', 'resolve() failed, skipping publish to avoid overwrite', e);
          return;
        }
      }

      // No existing binding — publish for the first time
      const nametag = this._identity?.nametag;
      const success = await this._transport.publishIdentityBinding(
        this._identity!.chainPubkey,
        this._identity!.directAddress || '',
        nametag || undefined,
      );
      if (success) {
        logger.debug('Sphere', `Identity binding published${nametag ? ` with Unicity ID @${nametag}` : ''}`);
      } else if (nametag) {
        logger.warn('Sphere', `Unicity ID @${nametag} is taken by another pubkey`);
      }
    } catch (error) {
      // Don't fail wallet load on identity sync errors
      logger.warn('Sphere', `Identity binding sync failed:`, error);
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

    // Decrypt nametag from own Nostr binding events (private-key based)
    if (this._transport.recoverNametag) {
      try {
        recoveredNametag = await this._transport.recoverNametag();
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

  /**
   * Disconnect transport, storage and oracle, attempting each even if an earlier one
   * rejects. They are separate resources, and one failure must not skip the rest — that
   * is how a partial teardown leaves connections open, which is exactly the state the
   * failed-initialization path calls destroy() in.
   */
  private async disconnectProvidersIndependently(): Promise<void> {
    const steps: ReadonlyArray<readonly [string, () => Promise<void>]> = [
      ['transport', () => this._transport.disconnect()],
      ['storage', () => this._storage.disconnect()],
      ['oracle', () => this._oracle.disconnect()],
    ];
    for (const [what, disconnect] of steps) {
      await Sphere.safeDisconnect(what, disconnect);
    }
  }

  /** Run one teardown step, logging rather than propagating so the next one still runs. */
  private static async safeDisconnect(what: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      logger.warn('Sphere', `${what} disconnect failed during destroy:`, err);
    }
  }

  /**
   * Tear this Sphere down: stop the vertical, destroy the modules, disconnect the providers
   * and zero the key material. Idempotent by construction (every step is null-guarded) and
   * deliberately WITHOUT an early return on re-entry, which would change what a double call
   * means.
   *
   * #770: the FIRST statement flips `_destroyed` — before any await, and before this queues
   * its own stop on the §7 lifecycle mutex. That position is load-bearing. Every guard reads
   * the flag, so from that instant any switchToAddress step not yet begun refuses; and
   * because it flips SYNCHRONOUSLY at entry, a stop/start pair the mutex runs after this call
   * sees `true` and skips its start. Set it beside `_initialized` at the bottom instead and a
   * concurrent switch re-arms a wallet whose owner already had destroy() return: fresh
   * sockets, a fresh wallet-api session, a whole fresh vertical nothing will ever stop.
   */
  async destroy(): Promise<void> {
    // #770 — MUST stay the first statement; see the note above.
    this._destroyed = true;

    // FIRST, before anything that can throw. Module teardown and
    // MultiAddressTransportMux.disconnect() propagate, so any later placement would let a
    // single failure leave this Sphere's registry fetching forever. Nothing below needs it.
    this._registry?.dispose();
    this._registry = null;

    this.cleanupProviderEventSubscriptions();

    // Stop the payments vertical FIRST — stop() awaits quiescence, so
    // in-flight facade ops settle before their engine is disposed below (and
    // the mutex orders this after any in-flight switch's stop/start pair).
    try {
      await this.queuePaymentsV2Op(() => this.stopPaymentsV2Inner());
    } catch (err) {
      logger.warn('Sphere', 'payments vertical stop failed during destroy:', err);
    }

    // Destroy all per-address module sets
    for (const [idx, moduleSet] of this._addressModules.entries()) {
      try {
        moduleSet.communications.destroy();
        moduleSet.groupChat?.destroy();
        moduleSet.market?.destroy();
        // Each address has its OWN engine, so each may own its own worker pool.
        moduleSet.tokenEngine?.dispose?.();
        logger.debug('Sphere', `Destroyed modules for address ${idx}`);
      } catch (err) {
        logger.warn('Sphere', `Error destroying modules for address ${idx}:`, err);
      }
    }
    this._addressModules.clear();

    // Also destroy the active module references (they may be the same as
    // address 0 modules, but destroy() is idempotent)
    this._communications.destroy();
    this._groupChat?.destroy();
    this._market?.destroy();

    // Disconnect transport mux if present
    if (this._transportMux) {
      const mux = this._transportMux;
      await Sphere.safeDisconnect('transport mux', () => mux.disconnect());
      this._transportMux = null;
    }

    // The active engine, when it is not one of the per-address engines disposed
    // above (dispose is idempotent, so an overlap is harmless).
    this._tokenEngine?.dispose?.();

    await this.disconnectProvidersIndependently();

    this._initialized = false;
    this._trackedAddressesLoaded = false;
    this._identity = null;
    // Zero the decrypted key material too. Clearing _identity alone made the wallet's own
    // "keys leave memory — a real lock, not just a UI gate" comment false, and the
    // graceful-lock design keeps the Connect host alive for the WHOLE lock window rather
    // than milliseconds — so the window in which these survive is now user-scale.
    this._mnemonic = null;
    this._masterKey = null;
    this._password = null;
    this._trackedAddresses.clear();
    this._addressIdToIndex.clear();
    this._addressNametags.clear();
    this._disabledProviders.clear();
    this.eventHandlers.clear();

    Sphere.unregisterLive(this);
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
      // A wrong password can decrypt to non-empty GARBAGE: `decryptSimple` uses
      // unauthenticated AES-CBC, so ~1/256 of wrong keys produce byte-valid PKCS#7
      // padding and a non-null result instead of throwing. A wallet is only ever
      // persisted with a VALID BIP39 phrase, so a decrypted value that fails BIP39
      // validation deterministically means wrong-password / corruption — surface
      // the SAME "Failed to decrypt mnemonic" instead of leaking a misleading
      // "Invalid mnemonic phrase" from downstream identity init.
      if (!mnemonic || !validateBip39Mnemonic(mnemonic)) {
        throw new SphereError('Failed to decrypt mnemonic', 'STORAGE_ERROR');
      }
      this._mnemonic = mnemonic;
      this._source = 'mnemonic';
      await this.initializeIdentityFromMnemonic(mnemonic, derivationPath ?? undefined);
    } else if (encryptedMasterKey) {
      const masterKey = this.decrypt(encryptedMasterKey);
      if (!masterKey) {
        throw new SphereError('Failed to decrypt master key', 'STORAGE_ERROR');
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
      throw new SphereError('No wallet data found in storage', 'NOT_INITIALIZED');
    }

    // Now that identity is restored, set it on storage so subsequent reads use correct address
    if (this._identity) {
      this._storage.setIdentity(this._identity);
    }

    // Load tracked addresses registry (with migration from old format)
    await this.loadTrackedAddresses();
    this._trackedAddressesLoaded = true;
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
        directAddress: predicateAddress,
        ipnsName: '12D3KooW' + ipnsHash,
        nametag,
      };
      this._storage.setIdentity(this._identity);
      logger.debug('Sphere', `Restored to address ${this._currentAddressIndex}:`, this._identity.chainPubkey);
    } else if (this._identity && nametag) {
      // Restore nametag from cache
      this._identity.nametag = nametag;
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

    // Generate IPNS name from public key hash
    const ipnsHash = sha256(publicKey, 'hex').slice(0, 40);

    // Derive L3 predicate address (DIRECT://...)
    const predicateAddress = await deriveL3PredicateAddress(derivedKey.privateKey);

    this._identity = {
      privateKey: derivedKey.privateKey,
      chainPubkey: publicKey,
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
    const ipnsHash = sha256(publicKey, 'hex').slice(0, 40);

    // Derive L3 predicate address (DIRECT://...)
    const predicateAddress = await deriveL3PredicateAddress(privateKey);

    this._identity = {
      privateKey,
      chainPubkey: publicKey,
      directAddress: predicateAddress,
      ipnsName: '12D3KooW' + ipnsHash,
    };
  }

  // ===========================================================================
  // Private: Provider & Module Initialization
  // ===========================================================================

  private async initializeProviders(): Promise<void> {
    // Best-effort one-time: drop the orphaned vesting cache from prior versions.
    Sphere.cleanupOrphanedVestingCache(true);

    // Set identity on providers
    this._storage.setIdentity(this._identity!);

    // Provide fallback 'since' for existing wallets so Nostr subscriptions
    // pick up events sent while this address was inactive.
    // 24h lookback — safe because Nostr filter is pubkey-specific (#p=[pubkey]).
    // Stored timestamp takes priority if available.
    if (this._transport.setFallbackSince) {
      this._transport.setFallbackSince(Math.floor(Date.now() / 1000) - 86400);
    }

    await this._transport.setIdentity(this._identity!);

    // Connect providers (skip if already connected, e.g. after setIdentity reconnect)
    if (!this._storage.isConnected()) {
      await this._storage.connect();
    }
    if (!this._transport.isConnected()) {
      await this._transport.connect();
    }
    await this._oracle.initialize();

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

  /**
   * Construct the v2 token engine for a given address identity (defaults to the
   * active one) from the oracle's gateway URL + trust base and that address's
   * signing key. The engine is per-address — each address signs with its own key.
   * The trust base is the single source of truth for the network id (so any id
   * works — e.g. testnet2 = 4 — with no enum entry). Returns undefined (money
   * operations fail loudly until an engine exists) when the oracle can't supply
   * a trust base / url, or construction fails — a misconfigured oracle never
   * breaks initialization.
   */
  private async buildTokenEngine(identity?: FullIdentity): Promise<ITokenEngine | undefined> {
    const oracle = this._oracle as {
      getTrustBaseJson?: () => unknown;
      getAggregatorUrl?: () => string;
      getApiKey?: () => string | undefined;
    };
    const privateKey = (identity ?? this._identity)?.privateKey;
    const trustBaseJson = oracle.getTrustBaseJson?.() ?? null;
    const aggregatorUrl = oracle.getAggregatorUrl?.();
    if (!trustBaseJson || !aggregatorUrl || !privateKey) {
      logger.warn('Sphere', 'v2 token engine not constructed (oracle has no trust base / url, or no identity) — money operations will fail until one exists');
      return undefined;
    }
    try {
      return await createSphereTokenEngine({
        aggregatorUrl,
        apiKey: oracle.getApiKey?.(),
        privateKey: hexToBytes(privateKey),
        trustBaseJson,
        ...(this._verification ? { verification: this._verification } : {}),
      });
    } catch (err) {
      logger.warn(
        'Sphere',
        `Failed to construct v2 token engine — money operations will fail until one exists: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  private async initializeModules(): Promise<void> {
    const emitEvent = this.emitEvent.bind(this);

    // Create transport mux for address 0 so all addresses use per-address routing
    // from the start. The original transport stays connected for resolve operations.
    const adapter = await this.ensureTransportMux(this._currentAddressIndex, this._identity!);
    const moduleTransport: TransportProvider = adapter ?? this._transport;

    // Build the v2 token engine for this active address (from the oracle's gateway +
    // trust base + this address's key). Injected into the caller modules below.
    const previousEngine = this._tokenEngine;
    this._tokenEngine = await this.buildTokenEngine();
    if (previousEngine && previousEngine !== this._tokenEngine) previousEngine.dispose?.();

    this._communications.initialize({
      identity: this._identity!,
      storage: this._storage,
      transport: moduleTransport,
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

    // Load modules in parallel — they are independent of each other.
    // allSettled so one failing module doesn't block the rest.
    const results = await Promise.allSettled([
      this._communications.load(),
      this._groupChat?.load(),
      this._market?.load(),
    ]);
    for (const r of results) {
      if (r.status === 'rejected') {
        logger.warn('Sphere', 'Module load failed:', r.reason);
      }
    }

    // Register in per-address module map.
    this._addressModules.set(this._currentAddressIndex, {
      index: this._currentAddressIndex,
      identity: this._identity!,
      communications: this._communications,
      groupChat: this._groupChat,
      market: this._market,
      transportAdapter: adapter,
      tokenEngine: this._tokenEngine,
      initialized: true,
    });

    // Boot: start the payments vertical for the boot address (address
    // switches stop/start it in switchToAddress — §7 single active vertical).
    await this.stopThenStartPaymentsV2(this._currentAddressIndex, this._identity!);
  }

  // ===========================================================================
  // Private: Helpers
  // ===========================================================================

  /** §7 mutex: run one stop/start lifecycle op after all queued ones settle. */
  private queuePaymentsV2Op<T>(op: () => Promise<T>): Promise<T> {
    const run = this._paymentsV2Lifecycle.then(op);
    this._paymentsV2Lifecycle = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * Switch/boot: stop whatever runs, then start `index`'s vertical — atomically vs other
   * lifecycle ops.
   *
   * #770: the destroyed check between the two halves settles the FACADE vector on its own.
   * `_destroyed` flips synchronously at destroy() entry, so any closure that BEGINS executing
   * after destroy() was called sees `true`, and any closure already past the check has
   * facade.start() in flight — which destroy()'s own queued stop is necessarily ordered
   * after. The TRANSPORT vector is not on this mutex at all; the ensureAlive() calls in
   * switchToAddress are what cover it.
   */
  private stopThenStartPaymentsV2(index: number, identity: FullIdentity): Promise<void> {
    return this.queuePaymentsV2Op(async () => {
      await this.stopPaymentsV2Inner();
      // #770: destroy() may have run — or merely begun — while this pair waited its turn on
      // the mutex. Starting now would attach a LIVE vertical (wallet-api session, wake
      // socket, stream pulls, receive poll) to an owner whose destroy() already returned,
      // and nothing would ever stop it again.
      if (this._destroyed) return;
      await this.startPaymentsV2Inner(index, identity);
    });
  }

  /**
   * Compose + start the payments vertical for ONE address (the §7 rule:
   * exactly one running vertical; callers stop the previous one first). The
   * facade REUSES this address's engine record — `engineRef` re-reads it so a
   * setOracleApiKey rebuild is what future operations snapshot.
   */
  private async startPaymentsV2Inner(index: number, identity: FullIdentity): Promise<void> {
    if (!this._paymentsV2Composition) {
      // Unreachable through init/create/load/import (all fail-closed on it).
      throw new SphereError('wallet-api composition required for money', 'INVALID_CONFIG');
    }
    if (!this._addressModules.get(index)?.tokenEngine) {
      throw new SphereError(
        'payments requires the v2 token engine — the oracle must supply a trust base + gateway URL (and API key where required).',
        'INVALID_CONFIG'
      );
    }
    const facadeAddressId =
      identity.directAddress === undefined ? undefined : getAddressId(identity.directAddress);
    const facade = composePaymentsV2({
      identity,
      composition: this._paymentsV2Composition,
      engineRef: () => {
        const engine = this._addressModules.get(index)?.tokenEngine;
        if (!engine) throw new SphereError('paymentsV2: token engine unavailable', 'AGGREGATOR_ERROR');
        return engine;
      },
      host: {
        storage: this._storage,
        price: this._priceProvider,
        registry: this._registry ?? TokenRegistry.getInstance(),
        emit: (event, payload) =>
          this.emitEvent(event as SphereEventType, payload as SphereEventMap[SphereEventType]),
        resolvePeer: (identifier) => this._transport.resolve?.(identifier) ?? Promise.resolve(null),
        // Scoped to THIS facade's address, never "whichever is active":
        // switchToAddress moves _currentAddressIndex BEFORE stopping this
        // vertical, so the argument-less getter would hand an in-flight
        // deliver the NEXT address's Unicity ID — a name the sending key does
        // not own (sphere#487 review).
        nametag: () => this.getNametagForAddress(facadeAddressId),
      },
    });
    this._paymentsV2Active = { index, facade };
    await facade.start();
  }

  /** P9 §7: stop the active vertical and await quiescence (in-flight ops settle). */
  private async stopPaymentsV2Inner(): Promise<void> {
    const active = this._paymentsV2Active;
    if (!active) return;
    this._paymentsV2Active = null;
    await active.facade.stop();
  }

  /**
   * Refuse once destroy() has STARTED (#770). `_initialized` cannot carry this: destroy()
   * clears it last, so every teardown step is a window in which a concurrent call still reads
   * a ready Sphere and re-arms it.
   */
  private ensureAlive(): void {
    if (this._destroyed) {
      throw new SphereError('Sphere destroyed', 'NOT_INITIALIZED');
    }
  }

  private ensureReady(): void {
    // Every existing ensureReady() caller inherits the destroyed check.
    this.ensureAlive();
    if (!this._initialized) {
      throw new SphereError('Sphere not initialized', 'NOT_INITIALIZED');
    }
  }

  private emitEvent<T extends SphereEventType>(type: T, data: SphereEventMap[T]): void {
    const handlers = this.eventHandlers.get(type);
    if (!handlers) return;

    for (const handler of handlers) {
      try {
        (handler as SphereEventHandler<T>)(data);
      } catch (error) {
        logger.error('Sphere', 'Event handler error:', error);
      }
    }
  }

  // ===========================================================================
  // Private: Encryption
  // ===========================================================================

  private encrypt(data: string): string {
    if (!this._password) {
      if (this._passwordProtected) {
        // Fail CLOSED. Failing open here silently rewrites an encrypted record as
        // plaintext — reachable now that destroy() zeroes _password while the Connect host
        // stays alive for the whole lock window.
        throw new SphereError('Wallet password is not available', 'NOT_INITIALIZED');
      }
      return data; // No password by design — store as plaintext
    }
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
export const sphereExists = Sphere.exists.bind(Sphere);
