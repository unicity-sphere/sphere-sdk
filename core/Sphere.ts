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

import { logger } from './logger';
import { hexToBytes as strictHexToBytes } from './hex';
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
} from '../types';
import { SphereError } from './errors';
import {
  ConnectivityManager,
  AggregatorPinger,
  IpfsPinger,
  NostrPinger,
  type ConnectivityManagerHandle,
} from './connectivity';
import type {
  SphereProfileHandle,
  ResetEpochParams,
  ResetEpochResult,
} from '../extensions/uxf/profile/profile-handle';
// Epoch-key + reason-cap imports moved to `core/sphere-epoch.ts` (Wave 6-P2-8).
import { beginGlobalClear, endGlobalClear } from '../extensions/uxf/profile/global-clear-gate';
import type {
  ShutdownOptions,
  StorageProvider,
  TokenStorageProvider,
  TxfStorageDataBase,
} from '../storage';
import type { TransportProvider, PeerInfo } from '../transport';
import { MultiAddressTransportMux, AddressTransportAdapter } from '../transport/MultiAddressTransportMux';
import type { OracleProvider } from '../oracle';
import type { PriceProvider } from '../price';
import { PaymentsModule, createPaymentsModule } from '../modules/payments';
import type { SyncOptions, SyncResult } from '../modules/payments';
import type { PublishToIpfsCallback } from '../extensions/uxf/pipeline/delivery-resolver';
import { CommunicationsModule, createCommunicationsModule } from '../modules/communications';
import type { CommunicationsModuleConfig } from '../modules/communications';
import { GroupChatModule, createGroupChatModule } from '../modules/groupchat';
import type { GroupChatModuleConfig } from '../modules/groupchat';
import { MarketModule, createMarketModule } from '../modules/market';
import type { MarketModuleConfig } from '../modules/market';
import { AccountingModule, createAccountingModule } from '../modules/accounting';
import type { AccountingModuleConfig } from '../modules/accounting';
import { SwapModule, createSwapModule } from '../modules/swap/index.js';
import type { SwapModuleConfig } from '../modules/swap/types.js';
import {
  STORAGE_KEYS_GLOBAL,
  DEFAULT_BASE_PATH,
  DEFAULT_ENCRYPTION_KEY,
  DEFAULT_ESCROW_ADDRESS,
  NETWORKS,
  type NetworkType,
} from '../constants';
import { TokenRegistry } from '../registry';
import {
  generateMnemonic as generateBip39Mnemonic,
  validateMnemonic as validateBip39Mnemonic,
  publicKeyToAddress,
  signMessage as signMessageCrypto,
  type MasterKey,
  type AddressInfo,
} from './crypto';
import { encryptSimple, decryptSimple } from './encryption';
import type { DiscoverAddressesOptions, DiscoverAddressesResult } from './discover';
import {
  exportToJSON as walletIoExportToJSON,
  exportToTxt as walletIoExportToTxt,
  importFromJSON as walletIoImportFromJSON,
  importFromLegacyFile as walletIoImportFromLegacyFile,
  detectLegacyFileType as walletIoDetectLegacyFileType,
  isLegacyFileEncrypted as walletIoIsLegacyFileEncrypted,
  type WalletIoInstanceHost,
  type WalletIoSphereRef,
} from './sphere-wallet-io';
import {
  buildProfileHandle as epochBuildProfileHandle,
  getEpochFloorImpl as epochGetEpochFloor,
  resetEpochImpl as epochResetEpochImpl,
  type EpochOpsHost,
} from './sphere-epoch';
import {
  syncIdentityWithTransport as nametagSyncSyncIdentity,
  recoverNametagFromTransport as nametagSyncRecoverNametag,
  cleanNametag as nametagSyncCleanNametag,
  type NametagSyncHost,
} from './sphere-nametag-sync';
import {
  registerNametagImpl as nametagRegisterNametag,
  mintNametagImpl as nametagMintNametag,
  isNametagAvailableImpl as nametagIsNametagAvailable,
  getNametagImpl as nametagGetNametag,
  hasNametagImpl as nametagHasNametag,
  updateCachedProxyAddress as nametagUpdateCachedProxyAddress,
  type NametagCeremonyHost,
} from './sphere-nametag';
import {
  storeMnemonicImpl as identityStoreMnemonic,
  storeMasterKeyImpl as identityStoreMasterKey,
  finalizeWalletCreationImpl as identityFinalizeWalletCreation,
  loadIdentityFromStorageImpl as identityLoadFromStorage,
  initializeIdentityFromMnemonicImpl as identityInitializeFromMnemonic,
  initializeIdentityFromMasterKeyImpl as identityInitializeFromMasterKey,
  type IdentityStorageHost,
} from './sphere-identity-storage';
import {
  reconnectImpl as providersReconnect,
  disableProviderImpl as providersDisableProvider,
  enableProviderImpl as providersEnableProvider,
  isProviderEnabledImpl as providersIsProviderEnabled,
  getDisabledProviderIdsImpl as providersGetDisabledProviderIds,
  findProviderByIdImpl as providersFindProviderById,
  subscribeToProviderEventsImpl as providersSubscribeToProviderEvents,
  forwardPointerPublishedToNostrImpl as providersForwardPointerPublishedToNostr,
  maybeInstallPointerWinSubscriptionImpl as providersMaybeInstallPointerWinSubscription,
  handleIncomingPointerWinBroadcastImpl as providersHandleIncomingPointerWinBroadcast,
  emitConnectionChangedImpl as providersEmitConnectionChanged,
  cleanupProviderEventSubscriptionsImpl as providersCleanupProviderEventSubscriptions,
  type ProvidersHost,
} from './sphere-providers';
import {
  getCurrentAddressIndexImpl as addrGetCurrentAddressIndex,
  getNametagForAddressImpl as addrGetNametagForAddress,
  getNametagsForAddressImpl as addrGetNametagsForAddress,
  getAllAddressNametagsImpl as addrGetAllAddressNametags,
  getActiveAddressesImpl as addrGetActiveAddresses,
  getAllTrackedAddressesImpl as addrGetAllTrackedAddresses,
  getTrackedAddressImpl as addrGetTrackedAddress,
  setAddressHiddenImpl as addrSetAddressHidden,
  getAddressPaymentsImpl as addrGetAddressPayments,
  switchToAddressImpl as addrSwitchToAddress,
  deriveAddressPublicImpl as addrDeriveAddressPublic,
  getActiveAddressesInternalImpl as addrGetActiveAddressesInternal,
  deriveAddressInternalImpl as addrDeriveAddressInternal,
  deriveAddressAtPathImpl as addrDeriveAddressAtPath,
  deriveAddressesImpl as addrDeriveAddresses,
  persistTrackedAddressesImpl as addrPersistTrackedAddresses,
  loadTrackedAddressesImpl as addrLoadTrackedAddresses,
  ensureAddressTrackedImpl as addrEnsureAddressTracked,
  persistAddressNametagsImpl as addrPersistAddressNametags,
  loadAddressNametagsImpl as addrLoadAddressNametags,
  trackScannedAddressesImpl as addrTrackScannedAddresses,
  discoverAddressesImplWrapped as addrDiscoverAddresses,
  type AddressHost,
} from './sphere-addresses';
import {
  initializeModulesImpl as modulesInitInitializeModules,
  initializeAddressModulesImpl as modulesInitInitializeAddressModules,
  wireProfilePersistedSendStorageImpl as modulesInitWireProfilePersistedSendStorage,
  buildCidRefStoreOrNullImpl as modulesInitBuildCidRefStoreOrNull,
  ensureTransportMuxImpl as modulesInitEnsureTransportMux,
  type ModulesInitHost,
} from './sphere-modules-init';
// Phase 6-P2-4d: SigningService import routed through token-engine anti-corruption
// barrel; the v1 predicate primitives (`TokenType`, `HashAlgorithm`,
// `UnmaskedPredicateReference`) that used to compose the DIRECT address by hand
// are replaced by the vendored, byte-identical `deriveDirectAddress` helper
// (token-engine/identity.ts). See `deriveL3PredicateAddress` below.
import { SigningService } from '../token-engine/sdk';
import {
  deriveDirectAddress,
  createSphereTokenEngine,
  type ITokenEngine,
} from '../token-engine';
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
  /** Accounting module configuration. `true` for defaults, object for custom config, `false`/`undefined` to disable. */
  accounting?: AccountingModuleConfig | boolean;
  /** Swap module configuration. `true` for defaults, object for custom config, `false`/`undefined` to disable. */
  swap?: SwapModuleConfig | boolean;
  /** Communications module configuration. */
  communications?: CommunicationsModuleConfig;
  /** Optional password to encrypt the wallet. If omitted, mnemonic is stored as plaintext. */
  password?: string;
  /**
   * Auto-discover previously used HD addresses after creation.
   * - true: discover with defaults (Nostr + L1 scan, autoTrack: true)
   * - DiscoverAddressesOptions: custom config
   * - false/undefined: no auto-discovery (default)
   */
  discoverAddresses?: boolean | DiscoverAddressesOptions;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /** Optional callback to report initialization progress steps */
  onProgress?: InitProgressCallback;
  /**
   * Optional UXF bundle-CAR publisher for the `uxf-cid` delivery branch
   * (Issue #200 Phase 1 wiring). When omitted, CID-bound delivery falls
   * back to inline (under cap) or throws `IPFS_PUBLISHER_REQUIRED`
   * (force-cid, over-cap auto). The provider factories
   * (`createBrowserProviders` / `createNodeProviders`) construct this
   * with `createUxfCarPublisher(gateways)` from `tokenSync.ipfs` and
   * expose it on their returned object — propagate it here.
   */
  publishToIpfs?: PublishToIpfsCallback;
  /**
   * Issue #223 — recipient-side gateway list used to stream-fetch
   * CARs for incoming `kind: 'uxf-cid'` bundles. Same gateways the
   * `publishToIpfs` callback targets. Without this list the
   * auto-installed {@link IngestWorkerPool} silently drops every
   * `uxf-cid` arrival — see PaymentsModule.cidFetchGateways doc.
   * The provider factories populate this from `tokenSync.ipfs` —
   * propagate it here.
   */
  cidFetchGateways?: ReadonlyArray<string>;
  /**
   * Phase 6 — v2 token engine configuration. When the target `network` has
   * a `trustBaseUrl` on `NETWORKS[network]` (currently: `testnet2`), Sphere
   * fetches the trust base and constructs a {@link ITokenEngine} accessible
   * via `sphere.tokenEngine`. Passes it into `PaymentsModule` /
   * `AccountingModule` deps.
   *
   * Omit to fall back to `NETWORKS[network]` defaults (testnet2 embeds its
   * non-secret gateway apiKey; mainnet requires explicit apiKey injection).
   */
  tokenEngine?: {
    readonly apiKey?: string;
    readonly trustBaseUrl?: string;
    readonly aggregatorUrl?: string;
  };
}

/** Options for loading existing wallet */
export interface SphereLoadOptions {
  /** Storage provider instance */
  storage: StorageProvider;
  /**
   * Optional read-only fallback storage. See
   * {@link SphereInitOptions.fallbackStorage} for semantics.
   */
  fallbackStorage?: StorageProvider;
  /** Optional token storage provider (for IPFS sync) */
  tokenStorage?: TokenStorageProvider<TxfStorageDataBase>;
  /**
   * Issue #330 — Optional read-only fallback TOKEN storage consulted by
   * Profile-mode token reads when the primary (OrbitDB-backed) read
   * returns nothing or fails (e.g. `CRITICAL-BLOCK-EVICTED`). Intended
   * for Profile-mode boots where a previously-working legacy
   * `IndexedDBTokenStorageProvider` still holds tokens from before the
   * migration to Profile. Token-side analogue of `fallbackStorage`.
   * Never written to.
   *
   * Use `migrateLegacyToProfileBrowser` / `migrateLegacyToProfile` to
   * write a "migrated" marker so legacy is preserved as read-only
   * fallback (the post-#330 default) rather than wiped (pre-#330).
   */
  fallbackTokenStorage?: TokenStorageProvider<TxfStorageDataBase>;
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
  /** Accounting module configuration. `true` for defaults, object for custom config, `false`/`undefined` to disable. */
  accounting?: AccountingModuleConfig | boolean;
  /** Swap module configuration. `true` for defaults, object for custom config, `false`/`undefined` to disable. */
  swap?: SwapModuleConfig | boolean;
  /** Communications module configuration. */
  communications?: CommunicationsModuleConfig;
  /** Optional password to decrypt the wallet. Must match the password used during creation. */
  password?: string;
  /**
   * Auto-discover previously used HD addresses on load.
   * - true: discover with defaults (Nostr + L1 scan, autoTrack: true)
   * - DiscoverAddressesOptions: custom config
   * - false/undefined: no auto-discovery (default)
   */
  discoverAddresses?: boolean | DiscoverAddressesOptions;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /** Optional callback to report initialization progress steps */
  onProgress?: InitProgressCallback;
  /**
   * Optional UXF bundle-CAR publisher for the `uxf-cid` delivery branch
   * (Issue #200 Phase 1 wiring). See {@link SphereCreateOptions.publishToIpfs}.
   */
  publishToIpfs?: PublishToIpfsCallback;
  /**
   * Issue #223 — recipient-side gateway list used to stream-fetch
   * CARs for incoming `kind: 'uxf-cid'` bundles. Same gateways the
   * `publishToIpfs` callback targets. Without this list the
   * auto-installed {@link IngestWorkerPool} silently drops every
   * `uxf-cid` arrival — see PaymentsModule.cidFetchGateways doc.
   * The provider factories populate this from `tokenSync.ipfs` —
   * propagate it here.
   */
  cidFetchGateways?: ReadonlyArray<string>;
  /**
   * Phase 6 — v2 token engine configuration. When the target `network` has
   * a `trustBaseUrl` on `NETWORKS[network]` (currently: `testnet2`), Sphere
   * fetches the trust base and constructs a {@link ITokenEngine} accessible
   * via `sphere.tokenEngine`. Passes it into `PaymentsModule` /
   * `AccountingModule` deps.
   *
   * Omit to fall back to `NETWORKS[network]` defaults (testnet2 embeds its
   * non-secret gateway apiKey; mainnet requires explicit apiKey injection).
   */
  tokenEngine?: {
    readonly apiKey?: string;
    readonly trustBaseUrl?: string;
    readonly aggregatorUrl?: string;
  };
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
  /** Optional price provider for fiat conversion */
  price?: PriceProvider;
  /**
   * Network type (mainnet, testnet, testnet2, dev) — informational only for
   * lookups on {@link NETWORKS} (used by Phase-6 token engine construction).
   * Actual network configuration comes from provider URLs.
   */
  network?: NetworkType;
  /** Group chat configuration (NIP-29). Omit to disable groupchat. */
  groupChat?: GroupChatModuleConfig | boolean;
  /** Market module configuration. true = enable with defaults, object = custom config. */
  market?: MarketModuleConfig | boolean;
  /** Accounting module configuration. `true` for defaults, object for custom config, `false`/`undefined` to disable. */
  accounting?: AccountingModuleConfig | boolean;
  /** Swap module configuration. `true` for defaults, object for custom config, `false`/`undefined` to disable. */
  swap?: SwapModuleConfig | boolean;
  /** Communications module configuration. */
  communications?: CommunicationsModuleConfig;
  /** Optional password to encrypt the wallet. If omitted, mnemonic/key is stored as plaintext. */
  password?: string;
  /**
   * Auto-discover previously used HD addresses after import.
   * - true: discover with defaults (Nostr + L1 scan, autoTrack: true)
   * - DiscoverAddressesOptions: custom config
   * - false/undefined: no auto-discovery (default)
   */
  discoverAddresses?: boolean | DiscoverAddressesOptions;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /** Optional callback to report initialization progress steps */
  onProgress?: InitProgressCallback;
  /**
   * Optional UXF bundle-CAR publisher for the `uxf-cid` delivery branch
   * (Issue #200 Phase 1 wiring). See {@link SphereCreateOptions.publishToIpfs}.
   */
  publishToIpfs?: PublishToIpfsCallback;
  /**
   * Issue #223 — recipient-side gateway list used to stream-fetch
   * CARs for incoming `kind: 'uxf-cid'` bundles. Same gateways the
   * `publishToIpfs` callback targets. Without this list the
   * auto-installed {@link IngestWorkerPool} silently drops every
   * `uxf-cid` arrival — see PaymentsModule.cidFetchGateways doc.
   * The provider factories populate this from `tokenSync.ipfs` —
   * propagate it here.
   */
  cidFetchGateways?: ReadonlyArray<string>;
  /**
   * Phase 6 — v2 token engine configuration. When the target `network` has
   * a `trustBaseUrl` on `NETWORKS[network]` (currently: `testnet2`), Sphere
   * fetches the trust base and constructs a {@link ITokenEngine} accessible
   * via `sphere.tokenEngine`. Passes it into `PaymentsModule` /
   * `AccountingModule` deps.
   *
   * Omit to fall back to `NETWORKS[network]` defaults (testnet2 embeds its
   * non-secret gateway apiKey; mainnet requires explicit apiKey injection).
   */
  tokenEngine?: {
    readonly apiKey?: string;
    readonly trustBaseUrl?: string;
    readonly aggregatorUrl?: string;
  };
}

/** L1 (ALPHA blockchain) configuration */


/** Options for unified init (auto-create or load) */
export interface SphereInitOptions {
  /** Storage provider instance */
  storage: StorageProvider;
  /**
   * Optional read-only fallback storage consulted when the primary
   * storage returns null or throws a recoverable error (e.g.
   * `LoadBlockFailedError` for a missing OrbitDB content block) while
   * `loadIdentityFromStorage` is reading wallet keys. Intended for
   * Profile-mode boots where a previously-working legacy
   * `IndexedDBStorageProvider` still holds the encrypted-with-password
   * identity material at the same key shape — supplying it lets the
   * wallet boot from cached local state even if Profile/OrbitDB
   * has lost the block. Never written to.
   *
   * NOT applicable to `Sphere.create()` / `Sphere.import()` — those
   * flows write a fresh identity to the primary storage; a fallback
   * read makes no sense there. Intentionally omitted from those
   * option types.
   */
  fallbackStorage?: StorageProvider;
  /**
   * Issue #330 — Optional read-only fallback TOKEN storage. See
   * {@link SphereLoadOptions.fallbackTokenStorage} for semantics.
   */
  fallbackTokenStorage?: TokenStorageProvider<TxfStorageDataBase>;
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
  /** Accounting module configuration. `true` for defaults, object for custom config, `false`/`undefined` to disable. */
  accounting?: AccountingModuleConfig | boolean;
  /** Swap module configuration. `true` for defaults, object for custom config, `false`/`undefined` to disable. */
  swap?: SwapModuleConfig | boolean;
  /** Optional password to encrypt/decrypt the wallet. If omitted, mnemonic is stored as plaintext. */
  password?: string;
  /**
   * Auto-discover previously used HD addresses when creating from mnemonic.
   * Only applies when wallet is newly created (not on load of existing wallet).
   * - true: discover with defaults (Nostr + L1 scan, autoTrack: true)
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
   * Optional UXF bundle-CAR publisher for the `uxf-cid` delivery branch
   * (Issue #200 Phase 1 wiring). See {@link SphereCreateOptions.publishToIpfs}.
   */
  publishToIpfs?: PublishToIpfsCallback;
  /**
   * Issue #223 — recipient-side gateway list used to stream-fetch
   * CARs for incoming `kind: 'uxf-cid'` bundles. Same gateways the
   * `publishToIpfs` callback targets. Without this list the
   * auto-installed {@link IngestWorkerPool} silently drops every
   * `uxf-cid` arrival — see PaymentsModule.cidFetchGateways doc.
   * The provider factories populate this from `tokenSync.ipfs` —
   * propagate it here.
   */
  cidFetchGateways?: ReadonlyArray<string>;
  /**
   * Phase 6 — v2 token engine configuration. When the target `network` has
   * a `trustBaseUrl` on `NETWORKS[network]` (currently: `testnet2`), Sphere
   * fetches the trust base and constructs a {@link ITokenEngine} accessible
   * via `sphere.tokenEngine`. Passes it into `PaymentsModule` /
   * `AccountingModule` deps.
   *
   * Omit to fall back to `NETWORKS[network]` defaults (testnet2 embeds its
   * non-secret gateway apiKey; mainnet requires explicit apiKey injection).
   */
  tokenEngine?: {
    readonly apiKey?: string;
    readonly trustBaseUrl?: string;
    readonly aggregatorUrl?: string;
  };
  /**
   * Phase-3 wave-1 extension attach point.
   *
   * Optional array of extensions activated during `Sphere.init()`.
   * When omitted (or empty), the returned `Sphere` behaves identically
   * to running against upstream sphere-sdk main — the whole `extensions/`
   * subtree is inert. When populated, each extension's `install(host)`
   * runs during composition; the resulting handle is exposed on
   * `sphere.<id>` (e.g. `sphere.uxf` for the UXF extension).
   *
   * eslint-disable-next-line no-restricted-imports (allowlisted attach point)
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extensions?: ReadonlyArray<{ readonly id: string; install(host: any): Promise<any> }>;
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

// RESET_EPOCH_{DISCOVERY,PUBLISH}_TIMEOUT_MS moved to `core/sphere-epoch.ts`.
// DetachedPublishContext moved to `core/sphere-nametag.ts` alongside the
// register-nametag ceremony.

/**
 * Derive L3 predicate address (DIRECT://...) from private key.
 *
 * Phase 6-P2-4d: uses `token-engine/identity.deriveDirectAddress`, which
 * reproduces the v1 `UnmaskedPredicateReference → DirectAddress` recipe
 * byte-identically via v2 primitives (CborSerializer, DataHasher). Quest XP
 * is keyed on this address, so the derivation MUST stay stable across the
 * v1→v2 cut-over — token-engine's golden test locks the vector.
 */
export async function deriveL3PredicateAddress(privateKey: string): Promise<string> {
  // Steelman³³ warning: strict hex decode — Buffer.from(_, 'hex') silently
  // truncates odd-length and stops at first non-hex char.
  const secret = strictHexToBytes(privateKey);
  const signingService = new SigningService(secret);
  return deriveDirectAddress(signingService.publicKey);
}

// =============================================================================
// Issue #174 — spent-state-rescan AUDIT DispositionWriter factory
// =============================================================================
//
// Extracted to `core/sphere-modules-init.ts` (wave 6-P2-8d) — its only two
// call-sites (the primary + per-address `configureOperatorEscapeHatchStorage`
// wire hops) live in that module now.

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
 */
export interface AddressModuleSet {
  index: number;
  identity: FullIdentity;
  payments: PaymentsModule;
  communications: CommunicationsModule;
  groupChat: GroupChatModule | null;
  market: MarketModule | null;
  transportAdapter: AddressTransportAdapter | null;
  tokenStorageProviders: Map<string, TokenStorageProvider<TxfStorageDataBase>>;
  initialized: boolean;
}

/**
 * Issue #239 — options accepted by {@link Sphere.destroy}.
 *
 * The default contract is "normal mode": destroy() must not return
 * until any in-flight flush is drained AND the most-recent pin +
 * pointer publish are verifiably durable on remote infrastructure
 * (HEAD-readable bundle CID + aggregator `recoverLatest` returns the
 * just-published snapshot CID). The verification deadline is
 * configurable via {@link DestroyOptions.verificationDeadlineMs} and
 * defaults to 30 000 ms.
 *
 * `force: true` switches to "fast-exit": the remote-durability gate is
 * skipped and any unconfirmed publish is stamped as a
 * `pendingPublishCid` retry marker. Cold-start on next boot replays
 * the unverified publish via the existing retry machinery
 * (`LifecycleManager.retryPendingPublishIfAny`). Use for E2E tests
 * that simulate ungraceful crash, or for operator-triggered fast
 * exits where waiting for gateway propagation is not acceptable.
 */
/**
 * Wallet-layer destroy options. Extends `ShutdownOptions` with
 * wallet-only knobs the storage layer doesn't see.
 *
 * Issue #255 (2026-05-25) — `skipFlush` + `flushTimeoutMs` added so
 * `Sphere.destroy()` can drive a synchronous pre-shutdown
 * `awaitNextFlush()` on every TokenStorageProvider. Without that,
 * fire-and-exit CLI commands (`sphere init`, `sphere faucet`,
 * `sphere invoice pay`, etc.) trigger `notifyProfileDirty()` but
 * exit before the debounced flush timer fires — their state
 * mutations never reach IPFS / the aggregator pointer, leaving
 * sibling devices unable to discover what just happened. The
 * default behavior is now "flush then shutdown" so CLI mutations
 * are durably published before the process exits.
 *
 * Use `skipFlush: true` for ungraceful-shutdown simulation in tests
 * or any caller that explicitly wants the legacy fast-exit
 * semantics (state stamps `pendingPublishCid` and replays on next
 * boot).
 */
export interface DestroyOptions extends ShutdownOptions {
  /**
   * If `true`, skip the pre-shutdown
   * `provider.awaitNextFlush(flushTimeoutMs)` call. Default `false`
   * — destroy waits for any pending debounced flush to complete
   * (pin + OrbitDB ref + aggregator pointer publish) before
   * shutting providers down. Set to `true` for fast-exit
   * scenarios where the cold-start `pendingPublishCid` retry path
   * is an acceptable recovery surface.
   */
  readonly skipFlush?: boolean;
  /**
   * Per-provider timeout for the pre-shutdown
   * `awaitNextFlush(timeoutMs)` call. Default 30 000 ms (matches
   * `awaitNextFlush`'s own default, and the `flushVerificationDeadlineMs`
   * the factory wires by default). On TIMEOUT the provider's
   * `pendingPublishCid` retry marker is left stamped — destroy()
   * proceeds to shutdown anyway so the caller doesn't hang
   * indefinitely on a misbehaving gateway.
   */
  readonly flushTimeoutMs?: number;
}

// =============================================================================
// Sphere Class
// =============================================================================

export class Sphere {
  // Singleton
  private static instance: Sphere | null = null;

  // Phase-3 wave-1 extension handles — see SphereInitOptions.extensions.
  // The UXF handle is `undefined` unless `uxfExtension()` was passed to
  // `Sphere.init({ extensions: [...] })`. Structural shape mirrors
  // `extensions/uxf/types.ts::UxfHandle` — declared inline here so
  // `core/` does not cross the extension boundary at compile time
  // (the ESLint boundary rule enforces this).
  public readonly uxf?: {
    readonly id: 'uxf';
    readonly stability: 'stable' | 'beta' | 'experimental';
    destroy(): Promise<void>;
  };

  // State
  private _initialized = false;
  private _trackedAddressesLoaded = false;
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
  /**
   * Read-only fallback storage consulted by `loadIdentityFromStorage`
   * when the primary returns null or throws a recoverable error for an
   * identity-key read. See {@link SphereInitOptions.fallbackStorage}.
   * Set once at construction by the static factories; never mutated
   * after wallet load. `null` when no fallback was supplied.
   */
  private _fallbackStorage: StorageProvider | null = null;
  /**
   * Issue #309 review — set when `fallbackStorage.connect()` failed
   * during load/init. The fallback is demoted to `null` so the rest of
   * the boot proceeds; this field preserves the original error for
   * forensics. `null` when there's no fallback or the connect succeeded.
   */
  private _fallbackStorageError: Error | null = null;
  /**
   * Issue #330 — read-only fallback TOKEN storage consulted by the
   * primary token-storage provider on read miss or eviction. Set once
   * at construction by the static factories. `null` when no fallback
   * was supplied. Token-side analogue of `_fallbackStorage`.
   *
   * Wired into ProfileTokenStorageProvider via the
   * `fallbackTokenStorage` option so the provider can consult the
   * legacy `IndexedDBTokenStorageProvider` when a Profile block read
   * fails (e.g. `[CRITICAL-BLOCK-EVICTED]`). Never written to.
   */
  private _fallbackTokenStorage: TokenStorageProvider<TxfStorageDataBase> | null = null;
  private _tokenStorageProviders: Map<string, TokenStorageProvider<TxfStorageDataBase>> = new Map();
  private _transport: TransportProvider;
  private _oracle: OracleProvider;
  private _priceProvider: PriceProvider | null;
  /**
   * Phase 6 — v2 token engine (anti-corruption port). Constructed lazily by
   * {@link Sphere.ensureTokenEngine} when the target network has a trust
   * base URL AND the wallet identity is loaded. `null` when the network is
   * v1-only (mainnet / testnet / dev today) OR before identity is available.
   *
   * The slim `PaymentsModule` / `AccountingModule` (waves 6-P2-4b/c) route
   * ALL token operations through this — mint, transfer, split, verify,
   * isSpent, isOwnedBy, encode/decode. Callers that need direct engine
   * access (e.g. issuing tokens, running a smoke test) use `sphere.tokenEngine`.
   */
  private _tokenEngine: ITokenEngine | null = null;
  /**
   * Phase 6 — v2 token engine config overrides + network name. Filled from
   * `SphereInitOptions.tokenEngine` (and Load/Create/Import equivalents) at
   * construction time, then consulted by {@link Sphere.ensureTokenEngine}
   * when the identity becomes available.
   */
  private _tokenEngineConfig: {
    readonly network: NetworkType;
    readonly apiKey?: string;
    readonly trustBaseUrl?: string;
    readonly aggregatorUrl?: string;
  } | null = null;
  /** Cached parsed trust base JSON; fetched once per engine construction. */
  private _cachedTrustBaseJson: unknown | null = null;
  /**
   * Optional UXF bundle-CAR publisher for the `uxf-cid` delivery branch
   * (Issue #200 Phase 1 wiring). Forwarded into every PaymentsModule
   * instance — including those created per-address by
   * `initializeAddressModules` — so CID-bound delivery branches actually
   * pin. When null, CID-bound delivery falls back to inline (under cap)
   * or throws `IPFS_PUBLISHER_REQUIRED` (force-cid, over-cap auto).
   *
   * Set by the caller via `SphereCreateOptions.publishToIpfs` /
   * `SphereLoadOptions.publishToIpfs` / `SphereInitOptions.publishToIpfs`
   * / `SphereImportOptions.publishToIpfs`. The provider factories
   * (`createBrowserProviders`, `createNodeProviders`) build this with
   * `createUxfCarPublisher(gateways)` when `tokenSync.ipfs` is configured.
   */
  private _publishToIpfs: PublishToIpfsCallback | null = null;

  /**
   * Issue #223 — gateway list forwarded to every per-address
   * PaymentsModule's auto-installed IngestWorkerPool so incoming
   * `kind: 'uxf-cid'` bundles can be stream-fetched. Same value as
   * the gateways the `publishToIpfs` callback targets — the provider
   * factories populate both from `tokenSync.ipfs.gateways`. Null /
   * empty preserves legacy drop-silent behaviour for `uxf-cid` events.
   */
  private _cidFetchGateways: ReadonlyArray<string> | null = null;

  // Modules (single-instance — backward compat, delegates to active address)
  private _payments: PaymentsModule;
  private _communications: CommunicationsModule;
  private _groupChat: GroupChatModule | null = null;
  private _market: MarketModule | null = null;
  private _accounting: AccountingModule | null = null;
  private _swap: SwapModule | null = null;

  /**
   * Issue #312 — unified connectivity surface. Construction is deferred to
   * `initializeModules()` so the manager binds to the same OracleProvider /
   * TransportProvider / IPFS gateways already wired into payments. The
   * manager's initial state is `'unknown'` for all backends; the first
   * probe fires async, so `sphere.connectivity.status()` is usable
   * immediately after `Sphere.init()` returns but reports `'unknown'`
   * until the first probes land.
   *
   * Null in two cases:
   *   - The Sphere is mid-construction (before `initializeModules()` ran).
   *   - The wallet was created with no connectivity-eligible backends
   *     (currently impossible in practice — every wallet has at least an
   *     oracle and a transport).
   *
   * Accessed via {@link Sphere.connectivity}.
   */
  private _connectivity: ConnectivityManager | null = null;

  // Per-address module instances (Phase 2: independent parallel operation)
  private _addressModules: Map<number, AddressModuleSet> = new Map();
  private _transportMux: MultiAddressTransportMux | null = null;
  /** Fallback DM since timestamp from init options, forwarded to mux on creation. */
  private _dmSince: number | null = null;

  // Stored configs for creating per-address modules
  private _groupChatConfig: GroupChatModuleConfig | undefined;
  private _marketConfig: MarketModuleConfig | undefined;
  private _communicationsConfig: CommunicationsModuleConfig | undefined;

  // Events
  private eventHandlers: Map<SphereEventType, Set<SphereEventHandler<SphereEventType>>> = new Map();

  // Provider management
  private _disabledProviders: Set<string> = new Set();
  private _providerEventCleanups: (() => void)[] = [];
  private _lastProviderConnected: Map<string, boolean> = new Map();

  // RFC-251 Approach D / issue #255 Problem B — pointer-publish win-broadcast.
  // Tracks whether the per-wallet Nostr subscription for sibling
  // pointer-win broadcasts has been installed (one per pointer-signing
  // pubkey ever seen during this Sphere lifetime). Cleared on destroy().
  private _pointerWinSubscriptions = new Map<string, () => void>();
  // Bounded dedup of (signingPubKey + version) tuples observed via
  // sibling broadcasts — bounds within-replay-window duplicate
  // processing. LRU-evicted at MAX_SIZE entries.
  private _pointerWinSeen = new Set<string>();
  // Sentinel: when the pointer layer is built async after OrbitDB attach,
  // we poll for it once and install the subscription. This flag prevents
  // multiple parallel install attempts when several pointer events fire
  // close together.
  private _pointerWinInstallInFlight = false;

  // ===========================================================================
  // Constructor (private)
  // ===========================================================================

  private constructor(
    storage: StorageProvider,
    transport: TransportProvider,
    oracle: OracleProvider,
    tokenStorage?: TokenStorageProvider<TxfStorageDataBase>,
    priceProvider?: PriceProvider,
    groupChatConfig?: GroupChatModuleConfig,
    marketConfig?: MarketModuleConfig,
    accountingConfig?: AccountingModuleConfig,
    swapConfig?: SwapModuleConfig,
    communicationsConfig?: CommunicationsModuleConfig,
  ) {
    this._storage = storage;
    this._transport = transport;
    this._oracle = oracle;
    this._priceProvider = priceProvider ?? null;

    // Initialize token storage providers map
    if (tokenStorage) {
      this._tokenStorageProviders.set(tokenStorage.id, tokenStorage);
    }

    // Store configs for creating per-address modules
    this._groupChatConfig = groupChatConfig;
    this._marketConfig = marketConfig;
    this._communicationsConfig = communicationsConfig;

    this._payments = createPaymentsModule({});
    this._communications = createCommunicationsModule(communicationsConfig);
    this._groupChat = groupChatConfig ? createGroupChatModule(groupChatConfig) : null;
    this._market = marketConfig ? createMarketModule(marketConfig) : null;
    this._accounting = accountingConfig ? createAccountingModule(accountingConfig) : null;
    this._swap = swapConfig ? createSwapModule(swapConfig) : null;
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
    if (options.debug) logger.configure({ debug: true });

    // Issue #274 — lifecycle span. The init/load path is the slowest cold-start
    // surface and the entry point operators reach for when debugging "wallet
    // takes minutes to come up". `created` field tells fresh-vs-existing apart.
    const __span = logger.time('sphere:lifecycle', 'init', {
      network: options.network,
      hasNametag: !!options.nametag,
      autoGenerate: !!options.autoGenerate,
      hasMnemonic: !!options.mnemonic,
    });

    // Configure TokenRegistry in the main bundle context.
    // Factory functions (createBrowserProviders/createNodeProviders) are built as
    // separate bundles by tsup, so their TokenRegistry.configure() call configures
    // a different singleton copy. We must configure the main bundle's copy here.
    Sphere.configureTokenRegistry(options.storage, options.network);

    // Resolve groupChat config: true → use network-default relays
    const groupChat = Sphere.resolveGroupChatConfig(options.groupChat, options.network);
    const market = Sphere.resolveMarketConfig(options.market);
    const accounting = Sphere.resolveAccountingConfig(options.accounting);
    const swap = Sphere.resolveSwapConfig(options.swap);

    const walletExists = await Sphere.exists(options.storage);

    if (walletExists) {
      // Load existing wallet
      const sphere = await Sphere.load({
        storage: options.storage,
        fallbackStorage: options.fallbackStorage,
        fallbackTokenStorage: options.fallbackTokenStorage,
        transport: options.transport,
        oracle: options.oracle,
        tokenStorage: options.tokenStorage,
        price: options.price,
        network: options.network,
        groupChat,
        market,
        accounting,
        swap,
        password: options.password,
        discoverAddresses: options.discoverAddresses,
        onProgress: options.onProgress,
        publishToIpfs: options.publishToIpfs,
        cidFetchGateways: options.cidFetchGateways,
        tokenEngine: options.tokenEngine,
      });
      // Store dmSince for forwarding to transport/mux when subscriptions are set up
      if (options.dmSince != null) {
        sphere._dmSince = options.dmSince;
      }

      // Honor `options.nametag` on the loaded-wallet path. Prior behavior:
      // `Sphere.load` silently ignored it, so `sphere init --nametag X` on
      // an existing profile printed "Wallet initialized successfully!"
      // without actually registering X — a silent failure that left the
      // wallet in whatever nametag state it had before.
      if (options.nametag) {
        const stripped = options.nametag.startsWith('@')
          ? options.nametag.slice(1)
          : options.nametag;
        const requested = normalizeNametag(stripped);
        const current = sphere._identity?.nametag;
        if (!current) {
          // No active claim on the loaded wallet — register the requested
          // nametag now. May throw (NAMETAG_CONFLICT / NAMETAG_TAKEN /
          // AGGREGATOR_ERROR) per the same invariants as a fresh-create
          // `registerNametag` call.
          await sphere.registerNametag(options.nametag);
        } else if (current !== requested) {
          // Refuse to silently switch the active nametag of an already-
          // claimed wallet. (Multi-nametag selection is a deliberate
          // future feature — for now, force the operator to clear or
          // switchToAddress explicitly.)
          throw new SphereError(
            `Wallet already claims Unicity ID "@${current}" — cannot re-init ` +
            `with "@${requested}". Use sphere.clear() and re-init to switch ` +
            `nametags, or switchToAddress to register a different name on ` +
            `another HD address.`,
            'ALREADY_INITIALIZED',
          );
        }
        // else: current === requested — no-op, idempotent re-init
      }

      __span.end({ created: false });
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
      storage: options.storage,
      transport: options.transport,
      oracle: options.oracle,
      tokenStorage: options.tokenStorage,
      derivationPath: options.derivationPath,
      nametag: options.nametag,
      price: options.price,
      network: options.network,
      groupChat,
      market,
      accounting,
      swap,
      password: options.password,
      discoverAddresses: options.discoverAddresses,
      onProgress: options.onProgress,
      publishToIpfs: options.publishToIpfs,
      cidFetchGateways: options.cidFetchGateways,
      tokenEngine: options.tokenEngine,
    });

    if (options.dmSince != null) {
      sphere._dmSince = options.dmSince;
    }
    __span.end({ created: true, autoGenerated: !!generatedMnemonic });
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
   * Resolve accounting module config from Sphere.init() options.
   * - `true` → enable with defaults
   * - `AccountingModuleConfig` → pass through
   * - `false`/`undefined` → no accounting module
   */
  private static resolveAccountingConfig(
    config: AccountingModuleConfig | boolean | undefined,
  ): AccountingModuleConfig | undefined {
    if (config === false || config === undefined) return undefined;
    if (config === true) return {};
    return config;
  }

  /**
   * Resolve swap module config from Sphere.init() options.
   * - `true` → enable with defaults (uses hardcoded `DEFAULT_ESCROW_ADDRESS`)
   * - `SwapModuleConfig` → pass through, defaulting `defaultEscrowAddress`
   *   to `DEFAULT_ESCROW_ADDRESS` if the caller did not set one
   * - `false`/`undefined` → no swap module
   *
   * The hardcoded `DEFAULT_ESCROW_ADDRESS` (see `constants.ts`) means a wallet
   * initialised with `swap: true` and no explicit escrow override can still
   * propose / accept swaps against the canonical escrow nametag without any
   * per-call wiring (sphere-sdk#456).
   */
  private static resolveSwapConfig(
    config: SwapModuleConfig | boolean | undefined,
  ): SwapModuleConfig | undefined {
    if (config === false || config === undefined) return undefined;
    if (config === true) return { defaultEscrowAddress: DEFAULT_ESCROW_ADDRESS };
    return {
      ...config,
      defaultEscrowAddress: config.defaultEscrowAddress ?? DEFAULT_ESCROW_ADDRESS,
    };
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
    if (options.debug) logger.configure({ debug: true });

    // Validate mnemonic
    if (!options.mnemonic || !Sphere.validateMnemonic(options.mnemonic)) {
      throw new SphereError('Invalid mnemonic', 'INVALID_IDENTITY');
    }

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
    const accountingConfig = Sphere.resolveAccountingConfig(options.accounting);
    const swapConfig = Sphere.resolveSwapConfig(options.swap);

    const sphere = new Sphere(
      options.storage,
      options.transport,
      options.oracle,
      options.tokenStorage,
      options.price,
      groupChatConfig,
      marketConfig,
      accountingConfig,
      swapConfig,
      options.communications,
    );
    sphere._password = options.password ?? null;
    // Issue #200 Phase 1 wiring — capture optional UXF CAR publisher
    // before `initializeModules()` runs (which threads it into the
    // primary PaymentsModule).
    sphere._publishToIpfs = options.publishToIpfs ?? null;
    sphere._cidFetchGateways = options.cidFetchGateways ?? null;
    // Phase 6 — capture v2 token engine config so `ensureTokenEngine()`
    // can materialize the engine once identity lands.
    sphere._tokenEngineConfig = {
      network: options.network ?? 'mainnet',
      apiKey: options.tokenEngine?.apiKey,
      trustBaseUrl: options.tokenEngine?.trustBaseUrl,
      aggregatorUrl: options.tokenEngine?.aggregatorUrl,
    };

    // Store mnemonic (encrypted if password provided, plaintext otherwise)
    progress?.({ step: 'storing_keys', message: 'Storing wallet keys...' });
    await sphere.storeMnemonic(options.mnemonic, options.derivationPath);

    // Initialize identity from mnemonic
    await sphere.initializeIdentityFromMnemonic(options.mnemonic, options.derivationPath);

    // Initialize everything
    progress?.({ step: 'initializing', message: 'Initializing wallet...' });
    await sphere.initializeProviders();
    await sphere.initializeModules();

    // Mark wallet as created only after successful initialization
    // This prevents "Wallet already exists" errors if init fails partway through
    progress?.({ step: 'finalizing', message: 'Finalizing wallet...' });
    await sphere.finalizeWalletCreation();

    sphere._initialized = true;
    Sphere.instance = sphere;

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
    return sphere;
  }

  /**
   * Load existing wallet from storage
   */
  static async load(options: SphereLoadOptions): Promise<Sphere> {
    if (options.debug) logger.configure({ debug: true });

    // Check if wallet exists
    if (!(await Sphere.exists(options.storage))) {
      throw new SphereError('No wallet found. Use Sphere.create() to create a new wallet.', 'NOT_INITIALIZED');
    }

    const progress = options.onProgress;

    // Configure TokenRegistry in main bundle context (see init() for details)
    Sphere.configureTokenRegistry(options.storage, options.network);

    const groupChatConfig = Sphere.resolveGroupChatConfig(options.groupChat, options.network);
    const marketConfig = Sphere.resolveMarketConfig(options.market);
    const accountingConfig = Sphere.resolveAccountingConfig(options.accounting);
    const swapConfig = Sphere.resolveSwapConfig(options.swap);

    const sphere = new Sphere(
      options.storage,
      options.transport,
      options.oracle,
      options.tokenStorage,
      options.price,
      groupChatConfig,
      marketConfig,
      accountingConfig,
      swapConfig,
      options.communications,
    );
    sphere._password = options.password ?? null;
    // Issue #200 Phase 1 wiring — capture optional UXF CAR publisher
    // before `initializeModules()` threads it into PaymentsModule.
    sphere._publishToIpfs = options.publishToIpfs ?? null;
    sphere._cidFetchGateways = options.cidFetchGateways ?? null;
    // Phase 6 — capture v2 token engine config so `ensureTokenEngine()`
    // can materialize the engine once identity lands.
    sphere._tokenEngineConfig = {
      network: options.network ?? 'mainnet',
      apiKey: options.tokenEngine?.apiKey,
      trustBaseUrl: options.tokenEngine?.trustBaseUrl,
      aggregatorUrl: options.tokenEngine?.aggregatorUrl,
    };
    // Issue #309 — read-only fallback storage for identity-key reads.
    // Consulted by loadIdentityFromStorage() when the primary returns
    // null or throws a recoverable LoadBlockFailedError. Used in
    // Profile-mode boots where the legacy IndexedDB still holds the
    // encrypted-with-password identity material.
    sphere._fallbackStorage = options.fallbackStorage ?? null;
    // Issue #330 — read-only fallback TOKEN storage for Profile-mode
    // token reads. Consulted on miss/eviction. See
    // {@link SphereLoadOptions.fallbackTokenStorage} and the wiring at
    // `getTokenStorage().setFallbackTokenStorage(...)` further below.
    sphere._fallbackTokenStorage = options.fallbackTokenStorage ?? null;

    // Issue #330 — warn loudly when the underlying storage carries the
    // legacy-migration marker but no `fallbackTokenStorage` was wired.
    // This catches consumer apps that updated their SDK but did not
    // migrate to the auto-wiring factory (`createBrowserProfileProvidersAuto`
    // / equivalent). Without a fallback, pre-migration tokens are
    // unrecoverable if the Profile blockstore loses them — exactly
    // the symptom #330 sought to fix. Best-effort: any error during
    // the probe is swallowed (the storage may not yet be connected,
    // or the legacy KV may not implement `get`).
    if (sphere._fallbackTokenStorage === null) {
      try {
        if (
          typeof options.storage.isConnected === 'function' &&
          options.storage.isConnected() &&
          typeof options.storage.get === 'function'
        ) {
          const markerValue = await options.storage.get('migration.migratedAt');
          if (typeof markerValue === 'string' && markerValue.length > 0) {
            logger.warn(
              'Sphere',
              'Issue #330: legacy-migration marker detected on storage but no `fallbackTokenStorage` ' +
                'was provided to Sphere.init/load. Tokens that were durable in the legacy IndexedDB ' +
                'before Profile migration are NOT recoverable from this session. Use ' +
                '`createBrowserProfileProvidersAuto` (or wire a legacy `IndexedDBTokenStorageProvider` ' +
                'as `fallbackTokenStorage` manually) to close this gap.',
            );
          }
        }
      } catch {
        // Probe is best-effort. Continue without warning.
      }
    }

    // Issue #330 — propagate the fallback into any token storage
    // provider that supports it (Profile-mode providers expose
    // `setFallbackTokenStorage`). Done here, before initialize() runs,
    // so the first `load()` call sees the fallback. Other providers
    // (legacy IndexedDB) silently ignore — duck-type check.
    if (sphere._fallbackTokenStorage !== null) {
      for (const provider of sphere._tokenStorageProviders.values()) {
        const setter = (provider as {
          setFallbackTokenStorage?: (
            fb: TokenStorageProvider<TxfStorageDataBase>,
          ) => void;
        }).setFallbackTokenStorage;
        if (typeof setter === 'function') {
          setter.call(provider, sphere._fallbackTokenStorage);
        }
      }
    }

    // exists() restores original (disconnected) state — reconnect for reads
    if (!options.storage.isConnected()) {
      await options.storage.connect();
    }
    // Same for fallback if supplied — it must be connected before the
    // identity-load helper consults it.
    //
    // Review fix #2 — Demote fallback to `null` on connect failure with
    // ERROR level (not warn) plus a structured Sphere event. If the
    // caller went to the trouble of supplying a fallback, a silent
    // demotion can turn a recoverable boot into a fatal one downstream
    // with only a buried log line. The event lets consumers (UI banners,
    // operator dashboards) observe the demotion.
    if (sphere._fallbackStorage && !sphere._fallbackStorage.isConnected()) {
      try {
        await sphere._fallbackStorage.connect();
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        logger.error(
          'Sphere',
          `fallbackStorage.connect failed; proceeding WITHOUT fallback ` +
            `(identity recovery will not be attempted from legacy storage): ${errMessage}`,
        );
        sphere._fallbackStorage = null;
        sphere._fallbackStorageError = err instanceof Error ? err : new Error(errMessage);
        // Best-effort event so consumers can surface the demotion in UI
        // / monitoring. Fires synchronously inside `emitEvent`; handler
        // throws are swallowed by the bus.
        sphere.emitEvent('storage:fallback-demoted', {
          reason: 'connect-failed',
          error: errMessage,
          at: Date.now(),
        });
      }
    }

    // Load identity from storage
    progress?.({ step: 'storing_keys', message: 'Loading wallet keys...' });
    await sphere.loadIdentityFromStorage();

    // Initialize everything
    progress?.({ step: 'initializing', message: 'Initializing wallet...' });
    await sphere.initializeProviders();
    await sphere.initializeModules();

    // Publish identity binding via transport
    progress?.({ step: 'syncing_identity', message: 'Publishing identity...' });
    await sphere.syncIdentityWithTransport();

    sphere._initialized = true;
    Sphere.instance = sphere;

    // If nametag name exists but token is missing, try to mint it.
    // This handles the case where the token was lost from IndexedDB.
    if (sphere._identity?.nametag && !sphere._payments.hasNametag()) {
      progress?.({ step: 'registering_nametag', message: 'Restoring nametag token...' });
      logger.debug('Sphere', `Unicity ID @${sphere._identity.nametag} has no token, attempting to mint...`);
      try {
        const result = await sphere.mintNametag(sphere._identity.nametag);
        if (result.success) {
          logger.debug('Sphere', `Nametag token minted successfully on load`);
        } else {
          logger.warn('Sphere', `Could not mint nametag token: ${result.error}`);
        }
      } catch (err) {
        logger.warn('Sphere', `Nametag token mint failed:`, err);
      }
    }

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
    return sphere;
  }

  /**
   * Import wallet from mnemonic or master key
   */
  static async import(options: SphereImportOptions): Promise<Sphere> {
    if (options.debug) logger.configure({ debug: true });

    if (!options.mnemonic && !options.masterKey) {
      throw new SphereError('Either mnemonic or masterKey is required', 'INVALID_CONFIG');
    }

    const progress = options.onProgress;

    logger.debug('Sphere', 'Starting import...');

    // Clear existing wallet if any (including token data).
    // Skip if no active instance and wallet doesn't exist — avoids redundant
    // tokenStorage.clear() which deletes/reopens IndexedDB and can race with
    // a subsequent initialize().
    const needsClear = Sphere.instance !== null || await Sphere.exists(options.storage);
    if (needsClear) {
      progress?.({ step: 'clearing', message: 'Clearing previous wallet data...' });
      logger.debug('Sphere', 'Clearing existing wallet data...');
      await Sphere.clear({ storage: options.storage, tokenStorage: options.tokenStorage });
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

    const groupChatConfig = Sphere.resolveGroupChatConfig(options.groupChat);
    const marketConfig = Sphere.resolveMarketConfig(options.market);
    const accountingConfig = Sphere.resolveAccountingConfig(options.accounting);
    const swapConfig = Sphere.resolveSwapConfig(options.swap);

    const sphere = new Sphere(
      options.storage,
      options.transport,
      options.oracle,
      options.tokenStorage,
      options.price,
      groupChatConfig,
      marketConfig,
      accountingConfig,
      swapConfig,
      options.communications,
    );
    sphere._password = options.password ?? null;
    // Issue #200 Phase 1 wiring — capture optional UXF CAR publisher
    // before `initializeModules()` threads it into PaymentsModule.
    sphere._publishToIpfs = options.publishToIpfs ?? null;
    sphere._cidFetchGateways = options.cidFetchGateways ?? null;
    // Phase 6 — capture v2 token engine config so `ensureTokenEngine()`
    // can materialize the engine once identity lands.
    sphere._tokenEngineConfig = {
      network: options.network ?? 'mainnet',
      apiKey: options.tokenEngine?.apiKey,
      trustBaseUrl: options.tokenEngine?.trustBaseUrl,
      aggregatorUrl: options.tokenEngine?.aggregatorUrl,
    };

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
    await sphere.initializeProviders();
    logger.debug('Sphere', 'Providers initialized. Initializing modules...');
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
    progress?.({ step: 'finalizing', message: 'Finalizing wallet...' });
    logger.debug('Sphere', 'Finalizing wallet creation...');
    await sphere.finalizeWalletCreation();

    sphere._initialized = true;
    Sphere.instance = sphere;

    // Track address 0 in the registry
    logger.debug('Sphere', 'Tracking address 0...');
    await sphere.ensureAddressTracked(0);

    // Register nametag if provided (this overrides any recovered nametag)
    if (options.nametag) {
      progress?.({ step: 'registering_nametag', message: 'Registering nametag...' });
      logger.debug('Sphere', 'Registering Unicity ID...');
      await sphere.registerNametag(options.nametag);
    }

    // Auto-sync with token storage providers (e.g., IPFS) to recover tokens
    if (sphere._tokenStorageProviders.size > 0) {
      progress?.({ step: 'syncing_tokens', message: 'Syncing tokens...' });
      try {
        const syncResult = await sphere._payments.sync();
        logger.debug('Sphere', `Auto-sync: +${syncResult.added} -${syncResult.removed}`);
      } catch (err) {
        logger.warn('Sphere', 'Auto-sync failed (non-fatal):', err);
      }
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
    return sphere;
  }

  /**
   * Clear all SDK-owned wallet data from storage.
   *
   * Removes wallet keys, per-address data, and optionally token storage.
   * Does NOT affect application-level data stored outside the SDK.
   *
   * **W46 — per-entry-key collections coverage (T.1.E):**
   * Per-entry-key collections (outbox, mintOutbox, audit, invalid,
   * finalizationQueue) live under composite keys of the form
   * `${addr}.<collection>.${id}` (and, for multi-rep collections,
   * further composite ids `${tokenId}.${observedTokenContentHash}`).
   * `clear()` reaches them via the parent `StorageProvider.clear()`
   * call below — a full prefix-scan-and-delete on the underlying
   * KV — NOT via `PROFILE_KEY_MAPPING` lookup. This is intentional:
   * adding a new per-entry-key collection requires zero changes to
   * `Sphere.clear()`. The mapping table declares the LOGICAL schema;
   * runtime keys are always reached by prefix wipe. See
   * `profile/types.ts` PROFILE_KEY_MAPPING contract block.
   *
   * @param storageOrOptions - StorageProvider (backward compatible) or options object
   *
   * @example
   * // New usage (recommended) - clears wallet keys AND token data
   * await Sphere.clear({
   *   storage: providers.storage,
   *   tokenStorage: providers.tokenStorage,
   *   // Issue #330 — pass the legacy fallback if the wallet was
   *   // migrated, so the resurrection footgun is closed.
   *   fallbackTokenStorage: providers.fallbackTokenStorage,
   * });
   *
   * @example
   * // Legacy usage - clears only wallet keys
   * await Sphere.clear(storage);
   */
  static async clear(
    storageOrOptions:
      | StorageProvider
      | {
          storage: StorageProvider;
          tokenStorage?: TokenStorageProvider<TxfStorageDataBase>;
          /**
           * Issue #330 — read-only fallback token storage that was
           * passed to `Sphere.init`/`load`. If supplied, `clear()`
           * wipes it too. Without this, a user calling `clear()` and
           * then re-running `init()` with the same mnemonic would see
           * pre-clear tokens resurrected from the legacy IDB.
           */
          fallbackTokenStorage?: TokenStorageProvider<TxfStorageDataBase>;
        },
  ): Promise<void> {
    const storage = 'get' in storageOrOptions ? storageOrOptions as StorageProvider : storageOrOptions.storage;
    const tokenStorage = 'get' in storageOrOptions ? undefined : storageOrOptions.tokenStorage;
    const fallbackTokenStorage =
      'get' in storageOrOptions ? undefined : storageOrOptions.fallbackTokenStorage;

    // Issue #368 — bracket the destructive body with the process-wide
    // global-clear gate. While the bracket is held, every
    // `ProfileTokenStorageProvider._applySnapshotIfWiredImpl` call in
    // this process early-returns and bumps
    // `profile.applySnapshot.suppressedDuringGlobalClear`. Closes the
    // multi-wallet gap left by the per-instance `isClearing` latch:
    // sibling wallets' periodic pointer-polls must not seed snapshot
    // state mid-batch while another wallet's `clear()` is in flight.
    //
    // The bracket nests safely (reference-counted), so an orchestrator
    // wrapping its own sequence of `Sphere.clear()` calls in a higher-
    // level bracket sees both layers compose. `endGlobalClear()` is
    // no-op-safe at depth 0, so a stray double-end is harmless.
    beginGlobalClear();
    try {
      // 1. Destroy Sphere instance — flushes pending IPFS writes (saves good
      //    state), then closes all connections. Awaited so IPFS completes
      //    before we delete databases.
      if (Sphere.instance) {
        logger.debug('Sphere', 'Destroying Sphere instance...');
        await Sphere.instance.destroy();
        logger.debug('Sphere', 'Sphere instance destroyed');
      }

      // 2. Yield to let IndexedDB finalize pending transactions after close().
      //    db.close() is synchronous but the connection isn't fully released
      //    until all in-flight transactions complete.
      logger.debug('Sphere', 'Yielding 50ms for IDB transaction settlement...');
      await new Promise((r) => setTimeout(r, 50));

      // 4. Delete token databases (sphere-token-storage-*)
      if (tokenStorage?.clear) {
        logger.debug('Sphere', 'Clearing token storage...');
        try {
          await tokenStorage.clear();
          logger.debug('Sphere', 'Token storage cleared');
        } catch (err) {
          logger.warn('Sphere', 'Token storage clear failed:', err);
        }
      } else {
        logger.debug('Sphere', 'No token storage provider to clear');
      }

      // 4b. Issue #330 — also wipe the read-only fallback token storage
      // (legacy IndexedDB from before Profile migration). Without this,
      // a user who calls `clear()` to start over with the same mnemonic
      // would see pre-clear tokens resurrected via the fallback wiring.
      // This violates the "clear means clear" invariant and is a real
      // data-integrity hazard, not just UX confusion.
      //
      // Idempotent and best-effort: a missing `clear` method (older
      // legacy providers) or an exception is logged but does not block
      // the rest of the cleanup. The fallback was never written to by
      // this SDK; the bytes here are pre-migration legacy data.
      if (fallbackTokenStorage?.clear) {
        logger.debug('Sphere', 'Clearing fallback (legacy) token storage...');
        try {
          if (
            typeof fallbackTokenStorage.isConnected === 'function' &&
            !fallbackTokenStorage.isConnected() &&
            typeof fallbackTokenStorage.connect === 'function'
          ) {
            await fallbackTokenStorage.connect();
          }
          await fallbackTokenStorage.clear();
          logger.debug('Sphere', 'Fallback token storage cleared');
        } catch (err) {
          logger.warn('Sphere', 'Fallback token storage clear failed:', err);
        }
      }

      // 5. Delete KV database (sphere-storage)
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
      logger.debug('Sphere', 'Done');
    } finally {
      // Issue #368 — release the global-clear bracket. Reached even on
      // a destructive failure inside the try body so a partial clear
      // never leaves the gate stuck closed (which would silently
      // disable applySnapshot dispatch for the rest of the process
      // lifetime).
      endGlobalClear();
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

  /** Group chat module (NIP-29). Null if not configured. */
  get groupChat(): GroupChatModule | null {
    return this._groupChat;
  }

  /** Market module (intent bulletin board). Null if not configured. */
  get market(): MarketModule | null {
    return this._market;
  }

  /** Accounting module (invoicing). Null if not configured. */
  get accounting(): AccountingModule | null {
    return this._accounting;
  }

  /** Swap module (atomic token swaps). Null if not configured. */
  get swap(): SwapModule | null {
    return this._swap;
  }

  /**
   * Issue #310 — Profile-mode public API surface.
   *
   * Returns a {@link SphereProfileHandle} when the wallet's
   * StorageProvider is a Profile-backed adapter (duck-typed via the
   * presence of `getPointerLayer`). Returns `null` for legacy
   * (IndexedDB / File) storage — callers MUST null-check.
   *
   * The handle's primary method is `resetEpoch({ reason })`, which
   * bumps the wallet's permanent OpLog epoch floor by +1 and triggers
   * a republish so all clients refuse to walk back to any prior epoch.
   * See `profile/profile-handle.ts` for the full contract.
   */
  get profile(): SphereProfileHandle | null {
    const storage = this._storage as unknown as {
      getPointerLayer?: () => unknown | null;
    };
    if (typeof storage.getPointerLayer !== 'function') {
      return null;
    }
    return this.buildProfileHandle();
  }

  /**
   * Lazily-constructed (per-call) handle so it picks up identity /
   * storage rebinds across `Sphere.load()` reattach cycles. The handle
   * is a thin lambda that closes over `this` — no state lives inside
   * it.
   */
  /**
   * Issue #312 — public entry to the Profile / epoch handle.
   * Body extracted to core/sphere-epoch.ts (Wave 6-P2-8).
   */
  private buildProfileHandle(): SphereProfileHandle {
    return epochBuildProfileHandle(this as unknown as EpochOpsHost);
  }

  /**
   * Issue #310 — read the persisted local epoch floor.
   * Delegates to `sphere-epoch.ts` — see there for semantics.
   */
  private async getEpochFloorImpl(): Promise<number> {
    return epochGetEpochFloor(this as unknown as EpochOpsHost);
  }

  /**
   * Issue #310 — serialization guard for concurrent `resetEpoch` calls.
   * Held by the extracted `resetEpochImpl` in `sphere-epoch.ts` via the
   * `EpochOpsHost` shim; still declared here so the Sphere instance owns
   * the per-instance mutex state.
   */
  _resetEpochInFlight: Promise<ResetEpochResult> | null = null;

  /**
   * Issue #310 — bump the wallet's OpLog epoch floor by +1.
   * See `SphereProfileHandle.resetEpoch` and `core/sphere-epoch.ts`.
   */
  private async resetEpochImpl(
    params: ResetEpochParams,
  ): Promise<ResetEpochResult> {
    return epochResetEpochImpl(this as unknown as EpochOpsHost, params);
  }

  /**
   * Issue #312 — unified connectivity surface for the
   * `aggregator | ipfs | nostr` backends. The handle exposes:
   *
   *   - `status()`   — sync snapshot of per-backend reachability.
   *   - `subscribe(fn)` — per-transition callback (returns unsubscribe).
   *   - `ping(which)` — force-probe one or all backends.
   *
   * The wallet fires `'connectivity:changed'`, `'connectivity:online'`, and
   * `'connectivity:offline-degraded'` on the Sphere event bus on every
   * transition — bind via `sphere.on(...)` for the UI banner.
   *
   * Advisory only: `payments.send()` reads this status once at entry and
   * logs a warning if `status().aggregator === 'down'`, but DOES NOT
   * refuse the send. The state-transition-sdk transport is the
   * authoritative health signal — it surfaces `JsonRpcNetworkError` on
   * real transport failures, and ST-SDK exposes no health/ping API,
   * so any preflight refuse is a Sphere-SDK invention that risks
   * blocking sends a recovered aggregator would have accepted.
   *
   * Returns a no-op stub if accessed before `initializeModules()` ran —
   * production callers go through `Sphere.init()`, which calls
   * `initializeModules()` before resolving, so this stub is only visible
   * in degenerate test setups.
   */
  get connectivity(): ConnectivityManagerHandle {
    if (this._connectivity) return this._connectivity;
    return Sphere.UNINITIALIZED_CONNECTIVITY;
  }

  /**
   * Singleton "uninitialized" connectivity handle. See {@link connectivity}
   * for rationale.
   */
  private static readonly UNINITIALIZED_CONNECTIVITY: ConnectivityManagerHandle = {
    status: () => ({
      aggregator: 'unknown',
      ipfs: 'unknown',
      nostr: 'unknown',
      lastOnlineAt: null,
      lastChangedAt: 0,
    }),
    subscribe: () => () => undefined,
    ping: async () => undefined,
  };

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

  /**
   * Phase 6 — v2 token engine (anti-corruption port).
   *
   * `null` until {@link ensureTokenEngine} has run — which happens
   * automatically during {@link init}/{@link load}/{@link create}/{@link import}
   * when the target network has a `trustBaseUrl` configured
   * (currently: `testnet2`). For v1-only networks (`mainnet`, `testnet`,
   * `dev`) this stays `null` — the slim PaymentsModule/AccountingModule then
   * throw a clear "engine not configured" error on any call that requires it.
   *
   * Direct callers (test scripts, custom flows) can drive
   * `sphere.tokenEngine.mint(...)` / `.transfer(...)` themselves without going
   * through the facade.
   */
  get tokenEngine(): ITokenEngine | null {
    return this._tokenEngine;
  }

  /**
   * Phase 6 — construct the v2 SphereTokenEngine if the network + identity
   * make it possible. Idempotent: subsequent calls short-circuit on the
   * cached engine. Called at every place the identity becomes available
   * (init, load, create, import, address switch, nametag registration).
   *
   * Silently returns `null` when the target network has no `trustBaseUrl`
   * (v1-only networks: mainnet/testnet/dev). Throws if fetching the trust
   * base or constructing the engine fails — a hard failure is preferable
   * to running with a broken engine (subsequent send/receive would fail
   * mysteriously downstream).
   */
  async ensureTokenEngine(): Promise<ITokenEngine | null> {
    if (this._tokenEngine !== null) return this._tokenEngine;
    if (!this._identity?.privateKey) return null;
    const cfg = this._tokenEngineConfig;
    if (cfg === null) return null;

    const network = NETWORKS[cfg.network] as
      | { aggregatorUrl?: string; trustBaseUrl?: string; aggregatorApiKey?: string }
      | undefined;
    const aggregatorUrl = cfg.aggregatorUrl ?? network?.aggregatorUrl;
    const trustBaseUrl = cfg.trustBaseUrl ?? network?.trustBaseUrl;
    const apiKey = cfg.apiKey ?? network?.aggregatorApiKey;
    if (!aggregatorUrl || !trustBaseUrl) {
      // Network doesn't declare a v2 trust base — engine intentionally left null.
      return null;
    }

    if (this._cachedTrustBaseJson === null) {
      logger.debug('Sphere', `Fetching trust base from ${trustBaseUrl}`);
      const resp = await fetch(trustBaseUrl);
      if (!resp.ok) {
        throw new SphereError(
          `Trust base fetch failed (${resp.status} ${resp.statusText}): ${trustBaseUrl}`,
          'INVALID_CONFIG',
        );
      }
      this._cachedTrustBaseJson = await resp.json();
    }

    const privateKey = strictHexToBytes(this._identity.privateKey);
    this._tokenEngine = await createSphereTokenEngine({
      aggregatorUrl,
      apiKey,
      privateKey,
      trustBaseJson: this._cachedTrustBaseJson,
    });
    logger.debug(
      'Sphere',
      `SphereTokenEngine constructed for network=${cfg.network} gateway=${aggregatorUrl}`,
    );
    return this._tokenEngine;
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
  // Internal — Issue #292 (SDK-private; do not call from consumer code)
  // ===========================================================================

  /**
   * Attach this Sphere's internal {@link FullIdentity} (with privateKey) to
   * a pair of identity-consuming providers WITHOUT exposing the private key
   * to the caller. Used exclusively by the Sphere-bound Profile factories
   * in `profile/browser.ts` / `profile/node.ts` and the
   * `migrateLegacyToProfile({ sphere, ... })` overload in
   * `profile/token-storage-migration.ts`.
   *
   * The `privateKey` field is read from `this._identity` (a private field),
   * passed directly into `setIdentity` on each provider, and never escapes
   * the closure. The callback shape is intentionally narrow — only
   * `setIdentity(FullIdentity): void` is invoked — so the helper cannot
   * be subverted into leaking the identity through some other provider
   * method.
   *
   * Honors the architectural invariant from the issue #292 owner comment:
   *
   * > "Private key material should never leave Sphere SDK itself. However,
   * > it should be possible to perform all the relevant cryptographic
   * > operations within Sphere SDK over external materials by means of
   * > undisclosed respective private key."
   *
   * @param applySetIdentity Synchronous callback that receives the live
   *        `FullIdentity` and calls `setIdentity` on each provider. The
   *        identity reference MUST NOT be stored, logged, or returned by
   *        the callback. The helper invokes it once and discards.
   * @throws {SphereError} `NOT_INITIALIZED` when no identity is bound
   *        (call this AFTER `Sphere.init` / `Sphere.create` / `Sphere.load`
   *        resolves). Distinct from the `hexToBytes: empty hex string`
   *        crash that would have fired inside `Profile*.setIdentity`
   *        without this guard.
   *
   * @internal — sphere-sdk private. Not part of the public API surface.
   *           Consumers should use `createBrowserProfileProvidersFromSphere`
   *           or `migrateLegacyToProfile({ sphere, ... })` instead.
   */
  _withFullIdentityForProfileFactory(
    applySetIdentity: (identity: FullIdentity) => void,
  ): void {
    if (!this._identity?.privateKey) {
      throw new SphereError(
        'Wallet not initialized — call Sphere.init/create/load before constructing Sphere-bound Profile providers',
        'NOT_INITIALIZED',
      );
    }
    // Snapshot the identity into a local const so a concurrent
    // `setIdentity` / re-derive on Sphere can't mutate `_identity`
    // mid-callback. The snapshot is a fresh plain object that the
    // callback may pass into provider `setIdentity` methods — those
    // providers retain the reference for their lifetime (they read
    // `identity.privateKey` lazily inside `connect()`'s Phase B; see
    // `profile/profile-storage-provider.ts` `identityAtStart`).
    //
    // We intentionally do NOT scrub the snapshot's `privateKey` after
    // the callback: the providers store the snapshot reference and
    // continue to read `privateKey` during their own connect()
    // lifecycle, so a scrub would null out their authoritative source
    // mid-flight (the original sin caught in steelman round 1 of this
    // PR — see docs/PROFILE-FROM-SPHERE.md "Security review"). The
    // provider's encryption-key copy is the long-lived secret; the
    // wallet's `_identity.privateKey` is the canonical source. Both
    // live for the wallet's lifetime regardless.
    const snapshot: FullIdentity = {
      chainPubkey: this._identity.chainPubkey,
      directAddress: this._identity.directAddress,
      ipnsName: this._identity.ipnsName,
      nametag: this._identity.nametag,
      privateKey: this._identity.privateKey,
    };
    applySetIdentity(snapshot);
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
      throw new SphereError(`Token storage provider '${provider.id}' already exists`, 'INVALID_CONFIG');
    }

    // Issue #330 — apply the fallback before initialize() so the first
    // load() call on the newly-added provider can fall through to the
    // legacy IDB if the Profile path returns empty/fails. Duck-typed:
    // providers that don't expose `setFallbackTokenStorage` are
    // silently skipped (legacy `IndexedDBTokenStorageProvider`).
    if (this._fallbackTokenStorage !== null) {
      const setter = (provider as {
        setFallbackTokenStorage?: (
          fb: TokenStorageProvider<TxfStorageDataBase>,
        ) => void;
      }).setFallbackTokenStorage;
      if (typeof setter === 'function') {
        setter.call(provider, this._fallbackTokenStorage);
      }
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
        // Consistency with the masterKey branch (which returns the alpha1-form
        // bech32 encoding of the pubkey hash) — encode the identity's
        // chainPubkey the same way so `address0` has a stable shape across
        // both wallet-load paths. The `alpha` prefix is a historical label
        // for the SDK's canonical HD-address bech32 encoding; it is no
        // longer an L1 concept post-Phase-2.
        address0 = publicKeyToAddress(this._identity.chainPubkey, 'alpha');
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
    return walletIoExportToJSON(this as unknown as WalletIoInstanceHost, options);
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
    return walletIoExportToTxt(this as unknown as WalletIoInstanceHost, options);
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
  static async importFromJSON(options: Omit<SphereImportOptions, 'mnemonic' | 'masterKey' | 'chainCode' | 'derivationPath' | 'basePath' | 'derivationMode'> & {
    jsonContent: string;
    password?: string;
  }): Promise<{ success: boolean; mnemonic?: string; error?: string }> {
    return walletIoImportFromJSON(Sphere as unknown as WalletIoSphereRef<Sphere>, options);
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
  static async importFromLegacyFile(options: Omit<SphereImportOptions, 'mnemonic' | 'masterKey' | 'chainCode' | 'derivationPath' | 'basePath' | 'derivationMode'> & {
    /** File content - Uint8Array for .dat, string for .txt */
    fileContent: string | Uint8Array;
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
    return walletIoImportFromLegacyFile(
      Sphere as unknown as WalletIoSphereRef<Sphere>,
      options,
    );
  }

  /**
   * Detect legacy file type from filename and content
   */
  static detectLegacyFileType(fileName: string, content: string | Uint8Array): LegacyFileType {
    return walletIoDetectLegacyFileType(fileName, content);
  }

  /**
   * Check if a legacy file is encrypted
   */
  static isLegacyFileEncrypted(fileName: string, content: string | Uint8Array): boolean {
    return walletIoIsLegacyFileEncrypted(fileName, content);
  }

  /**
   * Get the current active address index
   * Extracted to `core/sphere-addresses.ts` — see there for detail.
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
    return addrGetCurrentAddressIndex(this as unknown as AddressHost);
  }

  /**
   * Get primary nametag for a specific address
   * Extracted to `core/sphere-addresses.ts` — see there for detail.
   *
   * @param addressId - Address identifier (DIRECT://xxx), defaults to current address
   * @returns Primary nametag (index 0) or undefined if not registered
   */
  getNametagForAddress(addressId?: string): string | undefined {
    return addrGetNametagForAddress(this as unknown as AddressHost, addressId);
  }

  /**
   * Get all nametags for a specific address
   * Extracted to `core/sphere-addresses.ts` — see there for detail.
   *
   * @param addressId - Address identifier (DIRECT://xxx), defaults to current address
   * @returns Map of nametagIndex to nametag, or undefined if no nametags
   */
  getNametagsForAddress(addressId?: string): Map<number, string> | undefined {
    return addrGetNametagsForAddress(this as unknown as AddressHost, addressId);
  }

  /**
   * Get all registered address nametags
   * Extracted to `core/sphere-addresses.ts` — see there for detail.
   * @deprecated Use getActiveAddresses() or getAllTrackedAddresses() instead
   * @returns Map of addressId to (nametagIndex -> nametag)
   */
  getAllAddressNametags(): Map<string, Map<number, string>> {
    return addrGetAllAddressNametags(this as unknown as AddressHost);
  }

  /**
   * Get all active (non-hidden) tracked addresses.
   * Extracted to `core/sphere-addresses.ts` — see there for detail.
   *
   * @returns Array of TrackedAddress entries sorted by index, excluding hidden ones
   */
  getActiveAddresses(): TrackedAddress[] {
    return addrGetActiveAddresses(this as unknown as AddressHost);
  }

  /**
   * Get all tracked addresses, including hidden ones.
   * Extracted to `core/sphere-addresses.ts` — see there for detail.
   *
   * @returns Array of all TrackedAddress entries sorted by index
   */
  getAllTrackedAddresses(): TrackedAddress[] {
    return addrGetAllTrackedAddresses(this as unknown as AddressHost);
  }

  /**
   * Get tracked address info by index.
   * Extracted to `core/sphere-addresses.ts` — see there for detail.
   *
   * @param index - Address index
   * @returns TrackedAddress or undefined if not tracked
   */
  getTrackedAddress(index: number): TrackedAddress | undefined {
    return addrGetTrackedAddress(this as unknown as AddressHost, index);
  }

  /**
   * Set visibility of a tracked address.
   * Extracted to `core/sphere-addresses.ts` — see there for detail.
   *
   * @param index - Address index to hide/unhide
   * @param hidden - true to hide, false to show
   * @throws Error if address index is not tracked
   */
  async setAddressHidden(index: number, hidden: boolean): Promise<void> {
    return addrSetAddressHidden(this as unknown as AddressHost, index, hidden);
  }

  /**
   * Switch to a different address by index
   * Extracted to `core/sphere-addresses.ts` — see there for detail.
   *
   * Delegator is intentionally NOT `async`: `switchToAddress` schedules a
   * detached `postSwitchSync` at the end of its body (via `.catch(...)`);
   * wrapping the impl's returned promise in an extra `async` microtask
   * would let that background work observe state that the caller expects
   * to reflect the synchronous switch. Match the sibling extractions'
   * pattern (see `registerNametag` — sphere-nametag.ts) and return the
   * impl promise directly.
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
  switchToAddress(index: number, options?: { nametag?: string }): Promise<void> {
    return addrSwitchToAddress(this as unknown as AddressHost, index, options);
  }

  /**
   * Create a new set of per-address modules for the given index.
   * Each address gets its own PaymentsModule, CommunicationsModule, etc.
   * Modules are fully independent — they have their own token storage,
   * and can sync/finalize/split in background regardless of active address.
   *
   * @param index - HD address index
   * @param identity - Full identity for this address
   * @param tokenStorageProviders - Token storage providers for this address
   */
  private initializeAddressModules(
    index: number,
    identity: FullIdentity,
    tokenStorageProviders: Map<string, TokenStorageProvider<TxfStorageDataBase>>,
  ): Promise<AddressModuleSet> {
    return modulesInitInitializeAddressModules(
      this as unknown as ModulesInitHost,
      index,
      identity,
      tokenStorageProviders,
    );
  }

  /**
   * Issue #97 — Wire the profile-resident OutboxWriter + SentLedgerWriter
   * onto a PaymentsModule. Used by BOTH `initializeModules` (primary
   * address bootstrap) and `initializeAddressModules` (per-address
   * bootstrap on `switchToAddress`).
   *
   * **Atomicity (steelman C5 partial fix):** the OutboxWriter and
   * SentLedgerWriter MUST be installed together. PaymentsModule's
   * dispatcher hooks dual-write through both — installing OutboxWriter
   * alone would tombstone outbox entries on `delivered` with no
   * permanent SENT backup. To enforce this:
   *   - If either build returns null, install NEITHER. Falls back to
   *     legacy KV outbox.
   *   - Pre-check both before either install fires.
   *
   * **Best-effort:** when the storage provider is not a
   * `ProfileStorageProvider` (e.g. legacy IndexedDB), this is a no-op.
   *
   * @param payments  The PaymentsModule instance to wire.
   * @param identity  The full identity carrying the directAddress (used
   *                  to derive the addressId scope for both writers).
   */
  private wireProfilePersistedSendStorage(
    payments: PaymentsModule,
    identity: FullIdentity | null,
  ): void {
    return modulesInitWireProfilePersistedSendStorage(
      this as unknown as ModulesInitHost,
      payments,
      identity,
    );
  }

  /**
   * Issue #285 — Construct a {@link CidRefStore} via the storage
   * provider's `buildCidRefStore()` helper when available.
   *
   * The four fat-data OpLog write sites
   * (`CommunicationsModule._doSave`, `GroupChatModule.persistMembers`,
   * `GroupChatModule.persistProcessedEvents`,
   * `GroupChatModule.persistMessages`) — plus `PaymentsModule` pending
   * V5 tokens and `AccountingModule` invoice ledger — accept an
   * optional CidRefStore via their `initialize()` deps. Without one,
   * each falls through to inline JSON storage which routinely exceeds
   * the 128 KiB Profile OpLog cap (3.98 MB observed for the
   * `announcements` group's `groupChatMembers` blob).
   *
   * Best-effort: when the storage provider is not a
   * `ProfileStorageProvider`, when encryption is disabled, when the
   * identity has not been set yet, or when no IPFS gateways are
   * configured, this returns `null` and the modules retain their
   * legacy inline behaviour (still bounded by the 128 KiB cap; the
   * existing PAYLOAD-SIZE soft-warn will fire on offending writes).
   *
   * The returned store is cached per-Sphere-instance. Identity
   * rotation (`load()` switching to a different address) MUST
   * `_cidRefStore = null` to force a rebuild — the captured
   * encryption key is the one at construction time.
   */
  private buildCidRefStoreOrNull(): import('../extensions/uxf/profile/cid-ref-store').CidRefStore | null {
    return modulesInitBuildCidRefStoreOrNull(this as unknown as ModulesInitHost);
  }

  /**
   * Ensure the transport multiplexer exists and register an address.
   * Creates the mux on first call. Returns an AddressTransportAdapter
   * that routes events for this address independently.
   * @returns AddressTransportAdapter or null if transport is not Nostr-based
   */
  private ensureTransportMux(index: number, identity: FullIdentity): Promise<AddressTransportAdapter | null> {
    return modulesInitEnsureTransportMux(this as unknown as ModulesInitHost, index, identity);
  }

  /**
   * Get per-address modules for any address index (creates lazily if needed).
   * Extracted to `core/sphere-addresses.ts` — see there for detail.
   */
  getAddressPayments(index: number): PaymentsModule | undefined {
    return addrGetAddressPayments(this as unknown as AddressHost, index);
  }

  /**
   * Derive address at a specific index
   * Extracted to `core/sphere-addresses.ts` — see there for detail.
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
    return addrDeriveAddressPublic(this as unknown as AddressHost, index, isChange);
  }

  /**
   * Internal getActiveAddresses without ensureReady() check.
   * Extracted to `core/sphere-addresses.ts` — see there for detail.
   */
  private _getActiveAddressesInternal(): TrackedAddress[] {
    return addrGetActiveAddressesInternal(this as unknown as AddressHost);
  }

  /**
   * Internal address derivation without ensureReady() check.
   * Extracted to `core/sphere-addresses.ts` — see there for detail.
   */
  private _deriveAddressInternal(index: number, isChange: boolean = false): AddressInfo {
    return addrDeriveAddressInternal(this as unknown as AddressHost, index, isChange);
  }

  /**
   * Derive address at a full BIP32 path
   * Extracted to `core/sphere-addresses.ts` — see there for detail.
   *
   * @param path - Full BIP32 path like "m/44'/0'/0'/0/5"
   * @returns Address info
   */
  deriveAddressAtPath(path: string): AddressInfo {
    return addrDeriveAddressAtPath(this as unknown as AddressHost, path);
  }

  /**
   * Derive multiple addresses starting from index 0
   * Extracted to `core/sphere-addresses.ts` — see there for detail.
   *
   * @param count - Number of addresses to derive
   * @param includeChange - Include change addresses (default: false)
   * @returns Array of address info
   */
  deriveAddresses(count: number, includeChange: boolean = false): AddressInfo[] {
    return addrDeriveAddresses(this as unknown as AddressHost, count, includeChange);
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
  /**
   * Bulk-track scanned addresses with visibility and nametag data.
   * Extracted to `core/sphere-addresses.ts` — see there for detail.
   */
  async trackScannedAddresses(
    entries: Array<{ index: number; hidden: boolean; nametag?: string }>,
  ): Promise<void> {
    return addrTrackScannedAddresses(this as unknown as AddressHost, entries);
  }

  /**
   * Discover previously used HD addresses.
   * Extracted to `core/sphere-addresses.ts` — see there for detail.
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
    return addrDiscoverAddresses(this as unknown as AddressHost, options);
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
      tokenStorage: Array.from(this._tokenStorageProviders.values()).map(
        (p) => mkInfo(p, 'token-storage'),
      ),
      transport: [mkInfo(this._transport, 'transport', transportMeta)],
      oracle: [mkInfo(this._oracle, 'oracle')],
      price: priceProviders,
    };
  }

  async reconnect(): Promise<void> {
    return providersReconnect(this as unknown as ProvidersHost);
  }

  // ===========================================================================
  // Public Methods - Provider Management
  // ===========================================================================

  /**
   * Disable a provider at runtime. The provider stays registered but is disconnected
   * and skipped during operations (e.g., sync).
   *
   * Main storage provider cannot be disabled.
   * Extracted to `core/sphere-providers.ts` — see there for detail.
   *
   * @returns true if successfully disabled, false if provider not found
   */
  async disableProvider(providerId: string): Promise<boolean> {
    return providersDisableProvider(this as unknown as ProvidersHost, providerId);
  }

  /**
   * Re-enable a previously disabled provider. Reconnects and resumes operations.
   * Extracted to `core/sphere-providers.ts` — see there for detail.
   *
   * @returns true if successfully enabled, false if provider not found
   */
  async enableProvider(providerId: string): Promise<boolean> {
    return providersEnableProvider(this as unknown as ProvidersHost, providerId);
  }

  /**
   * Check if a provider is currently enabled
   */
  isProviderEnabled(providerId: string): boolean {
    return providersIsProviderEnabled(this as unknown as ProvidersHost, providerId);
  }

  /**
   * Get the set of disabled provider IDs (for passing to modules)
   */
  getDisabledProviderIds(): ReadonlySet<string> {
    return providersGetDisabledProviderIds(this as unknown as ProvidersHost);
  }

  /** Get the price provider's ID (implementation detail — not on PriceProvider interface) */
  private get _priceProviderId(): string {
    if (!this._priceProvider) return 'price';
    const p = this._priceProvider as unknown as Record<string, unknown>;
    return typeof p.id === 'string' ? p.id : 'price';
  }

  /**
   * Find a provider by ID across all provider collections
   * Extracted to `core/sphere-providers.ts` — see there for detail.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private findProviderById(providerId: string): Record<string, any> | null {
    return providersFindProviderById(this as unknown as ProvidersHost, providerId);
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

  async sync(options?: SyncOptions): Promise<SyncResult> {
    this.ensureReady();
    return this._payments.sync(options);
  }

  // ===========================================================================
  // Public Methods - Nametag
  // ===========================================================================

  /**
   * Get current nametag (if registered)
   * Extracted to `core/sphere-nametag.ts` — see there for detail.
   */
  getNametag(): string | undefined {
    return nametagGetNametag(this as unknown as NametagCeremonyHost);
  }

  /**
   * Check if nametag is registered
   * Extracted to `core/sphere-nametag.ts` — see there for detail.
   */
  hasNametag(): boolean {
    return nametagHasNametag(this as unknown as NametagCeremonyHost);
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

  /**
   * Pre-resolve a Unicity address for DM delivery.
   *
   * Warms the CommunicationsModule's internal resolution cache so that
   * subsequent sendDM() calls to this address avoid the network round-trip.
   * Useful before a batch of DM operations (e.g., sending hello_ack to
   * multiple tenants, or broadcasting to a list of agents).
   *
   * @param address - Any valid Unicity address (@nametag, DIRECT://, PROXY://, hex pubkey)
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
   * PROXY address caching — retired in Phase 6 (v2 is DIRECT-only).
   * Extracted to `core/sphere-nametag.ts` — see there for detail.
   */
  private async _updateCachedProxyAddress(): Promise<void> {
    return nametagUpdateCachedProxyAddress(this as unknown as NametagCeremonyHost);
  }

  /**
   * Register a nametag for the current active address.
   * Extracted to `core/sphere-nametag.ts` — see there for detail.
   *
   * Delegator is intentionally NOT `async`: the detached publish handler
   * timing is observable via the `'nametag:publish-failed'` event, and
   * wrapping the returned promise in an extra `async` microtask would let
   * the fire-and-forget rollback settle before the caller resumes — see
   * `tests/integration/wallet-clear.test.ts` "should reject same nametag
   * from a different wallet after clear" for the specific timing this
   * preserves.
   */
  registerNametag(
    nametag: string,
    options?: { publishMode?: 'await' | 'background' },
  ): Promise<void> {
    return nametagRegisterNametag(this as unknown as NametagCeremonyHost, nametag, options);
  }

  /**
   * Persist tracked addresses to storage (only minimal fields via StorageProvider)
   * Extracted to `core/sphere-addresses.ts` — see there for detail.
   */
  private async persistTrackedAddresses(): Promise<void> {
    return addrPersistTrackedAddresses(this as unknown as AddressHost);
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
    return nametagMintNametag(this as unknown as NametagCeremonyHost, nametag);
  }

  /**
   * Check if a nametag is available for minting.
   * Extracted to `core/sphere-nametag.ts` — see there for detail.
   */
  async isNametagAvailable(nametag: string): Promise<boolean> {
    return nametagIsNametagAvailable(this as unknown as NametagCeremonyHost, nametag);
  }

  /**
   * Load tracked addresses from storage.
   * Extracted to `core/sphere-addresses.ts` — see there for detail.
   */
  private async loadTrackedAddresses(): Promise<void> {
    return addrLoadTrackedAddresses(this as unknown as AddressHost);
  }

  /**
   * Ensure an address is tracked in the registry.
   * Extracted to `core/sphere-addresses.ts` — see there for detail.
   */
  private async ensureAddressTracked(index: number): Promise<TrackedAddress> {
    return addrEnsureAddressTracked(this as unknown as AddressHost, index);
  }

  /**
   * Persist nametag cache to storage.
   * Extracted to `core/sphere-addresses.ts` — see there for detail.
   */
  private async persistAddressNametags(): Promise<void> {
    return addrPersistAddressNametags(this as unknown as AddressHost);
  }

  /**
   * Load nametag cache from storage.
   * Extracted to `core/sphere-addresses.ts` — see there for detail.
   */
  private async loadAddressNametags(): Promise<void> {
    return addrLoadAddressNametags(this as unknown as AddressHost);
  }

  /**
   * Publish identity binding via transport (Nostr).
   * Extracted to `core/sphere-nametag-sync.ts` — see there for detail.
   */
  private async syncIdentityWithTransport(): Promise<void> {
    return nametagSyncSyncIdentity(this as unknown as NametagSyncHost);
  }

  /**
   * Recover nametag from transport after wallet import.
   * Extracted to `core/sphere-nametag-sync.ts` — see there for detail.
   */
  private async recoverNametagFromTransport(): Promise<void> {
    return nametagSyncRecoverNametag(this as unknown as NametagSyncHost);
  }

  /** Strip @ prefix and normalize a nametag. */
  private cleanNametag(raw: string): string {
    return nametagSyncCleanNametag(raw);
  }

  // ===========================================================================
  // Public Methods - Lifecycle
  // ===========================================================================

  /**
   * Issue #255 (2026-05-25) — synchronously drain every pending
   * debounced flush across all per-address ProfileTokenStorage
   * providers (pin + OrbitDB ref + aggregator pointer publish +
   * per-flush remote-durability verification per #239).
   *
   * Use this when a CLI command wants to confirm its state mutation
   * is durably published BEFORE returning a success exit, without
   * actually tearing the wallet down. Equivalent to the implicit
   * pre-shutdown sweep `destroy()` now does, but re-callable.
   *
   * Returns when all providers report no pending data OR the
   * `timeoutMs` budget is exhausted (in which case the affected
   * provider's `pendingPublishCid` retry marker remains stamped for
   * cold-start recovery and this method resolves normally — never
   * throws). Errors during individual provider flushes are logged
   * and swallowed; the caller cannot distinguish per-provider
   * failures via this API. For that, call
   * `(provider as { awaitNextFlush?: ... }).awaitNextFlush(timeoutMs)`
   * directly on the specific provider you care about.
   *
   * @param timeoutMs Per-provider deadline. Default 30 000 ms.
   */
  async flushPending(timeoutMs: number = 30_000): Promise<void> {
    if (!this._initialized) return;
    const allProviders: TokenStorageProvider<TxfStorageDataBase>[] = [];
    for (const moduleSet of this._addressModules.values()) {
      for (const provider of moduleSet.tokenStorageProviders.values()) {
        allProviders.push(provider);
      }
    }
    for (const provider of this._tokenStorageProviders.values()) {
      if (!allProviders.includes(provider)) {
        allProviders.push(provider);
      }
    }
    for (const provider of allProviders) {
      try {
        await (provider as TokenStorageProvider<TxfStorageDataBase> & {
          awaitNextFlush?: (timeoutMs?: number) => Promise<void>;
        }).awaitNextFlush?.(timeoutMs);
      } catch (err) {
        logger.warn(
          'Sphere',
          `flushPending: provider ${provider.id ?? '<unknown>'} flush failed ` +
          `(continuing; pendingPublishCid retry will handle): ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  async destroy(options?: DestroyOptions): Promise<void> {
    // Issue #239 — the shutdown durability gate is OPT-IN at the
    // wallet layer. Rationale: the per-flush verification gate
    // (`flushVerificationDeadlineMs` on `ProfileTokenStorageProviderOptions`,
    // wired ON by `createProfileProviders` with a 30 s deadline)
    // already enforces remote-pin durability for every profile update
    // BEFORE the flush returns. By the time `destroy()` is called,
    // the most-recent CIDs have already been HEAD-verified on the
    // IPFS gateways; the shutdown gate's pin-verify leg short-circuits
    // via the verified-watermark optimisation. The remaining shutdown
    // leg — aggregator `recoverLatest()` read-back — is purely a
    // cross-device-recovery quality-of-service check (it verifies
    // read replicas have caught up). For single-machine cross-process
    // CLI flows the local OrbitDB write is the recovery path, not
    // the aggregator read, so the read-back is redundant overhead.
    //
    // Operators who explicitly need cross-device read-replica catch-up
    // before exit MUST pass `verificationDeadlineMs: N` to opt in
    // (typical N = 30 000). E2E tests that want to simulate an
    // ungraceful crash continue to use `force: true`.
    const effectiveOptions = options;
    // Issue #255 (2026-05-25) — opt-out flag for the new pre-shutdown
    // flush sweep; default false ⇒ flush before shutting down.
    const skipFlush = options?.skipFlush === true;
    const flushTimeoutMs = options?.flushTimeoutMs ?? 30_000;

    this.cleanupProviderEventSubscriptions();

    // Issue #312 — stop the connectivity manager FIRST so its scheduled
    // probes (which dereference `this._oracle` and `this._transport`)
    // cannot race with provider teardown below. `stop()` aborts in-flight
    // probes, clears subscribers, and resolves once every probe has
    // settled — safe to await; bounded by `pingTimeoutMs`.
    if (this._connectivity) {
      try {
        await this._connectivity.stop();
      } catch (err) {
        logger.warn('Sphere', 'ConnectivityManager stop failed:', err);
      }
      this._connectivity = null;
    }

    // Destroy swap FIRST — it depends on accounting (which depends on payments)
    try {
      await this._swap?.destroy();
    } catch (err) {
      logger.warn('Sphere', 'Swap module destroy failed:', err);
    }

    // Destroy accounting — it may have in-flight operations using payments.send()
    // Draining accounting gates before destroying payments prevents spurious pending entries
    try {
      await this._accounting?.destroy();
    } catch (err) {
      logger.warn('Sphere', 'Accounting module destroy failed:', err);
    }

    // Issue #255 (2026-05-25) — synchronous pre-shutdown flush sweep.
    //
    // Fire-and-exit CLI commands (`sphere init`, `sphere faucet`,
    // `sphere invoice pay`, etc.) call into PaymentsModule which
    // writes to the per-address ProfileTokenStorage. Those writes
    // call `notifyProfileDirty()`, which arms a debounced flush
    // timer (default `flushDebounceMs = 2000`). If the CLI process
    // exits before the timer fires, the dirty data never gets
    // pinned to IPFS and never gets a pointer publish — sibling
    // devices have no way to discover the mutation until some
    // long-running daemon happens to retry via the
    // `pendingPublishCid` cold-start path.
    //
    // The fix: before shutting providers down, call each
    // provider's `awaitNextFlush(timeoutMs)`. That cancels the
    // debounce timer, forces a serialized flush, and waits for
    // pin + OrbitDB ref + aggregator pointer publish + per-flush
    // remote-durability verification (per #239) to complete. On
    // TIMEOUT the `pendingPublishCid` retry marker is left
    // stamped; destroy() proceeds with shutdown so the caller
    // doesn't hang on a misbehaving gateway.
    //
    // `options.skipFlush = true` opts out for fast-exit / E2E
    // crash-simulation paths. Swap + accounting destroy run
    // BEFORE this sweep so their in-flight operations have
    // already committed to token-storage by flush time.
    //
    // Providers that don't implement `awaitNextFlush` (File /
    // IndexedDB / IPFS-legacy) silently skip via optional chaining
    // — they don't have a debounced flush surface to drain.
    if (!skipFlush) {
      const allProviders: TokenStorageProvider<TxfStorageDataBase>[] = [];
      for (const moduleSet of this._addressModules.values()) {
        for (const provider of moduleSet.tokenStorageProviders.values()) {
          allProviders.push(provider);
        }
      }
      for (const provider of this._tokenStorageProviders.values()) {
        // De-dupe: per-address modules' providers may also be in the
        // top-level map (the active-address modules reference is a
        // pointer to the same Map entry). Identity-compare to avoid
        // double-flushing.
        if (!allProviders.includes(provider)) {
          allProviders.push(provider);
        }
      }
      for (const provider of allProviders) {
        try {
          await (provider as TokenStorageProvider<TxfStorageDataBase> & {
            awaitNextFlush?: (timeoutMs?: number) => Promise<void>;
          }).awaitNextFlush?.(flushTimeoutMs);
        } catch (err) {
          // Don't hang destroy() on a flush failure. The provider's
          // own `pendingPublishCid` retry marker covers the next-boot
          // recovery path. Log so the operator sees it.
          logger.warn(
            'Sphere',
            `pre-shutdown awaitNextFlush failed on provider ${provider.id ?? '<unknown>'} ` +
            `(continuing with shutdown; pendingPublishCid retry will handle): ` +
            `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    // Issue #97 (steelman C6) — null out per-address profile writers
    // BEFORE the storage provider disconnects. The writers hold a
    // reference to the underlying ProfileDatabase; in-flight fire-
    // and-forget hydration Promises (kicked off by installOutboxWriter)
    // would otherwise dispatch reads against a closing/closed DB and
    // log spurious errors on the way out.
    for (const moduleSet of this._addressModules.values()) {
      try {
        moduleSet.payments.installOutboxWriter(null);
        moduleSet.payments.installSentLedgerWriter(null);
      } catch {
        // Non-fatal — installer is a 1-line setter, but defensive
        // wrap protects future-stricter contracts.
      }
    }
    try {
      this._payments.installOutboxWriter(null);
      this._payments.installSentLedgerWriter(null);
    } catch {
      // Non-fatal.
    }

    // Destroy all per-address module sets
    for (const [idx, moduleSet] of this._addressModules.entries()) {
      try {
        moduleSet.payments.destroy();
        moduleSet.communications.destroy();
        moduleSet.groupChat?.destroy();
        moduleSet.market?.destroy();
        // Shutdown per-address token storage providers.
        // Issue #239 — propagate destroy options (force / reason /
        // verificationDeadlineMs) so the per-address token storage
        // providers run (or skip) the remote-durability gate consistent
        // with the caller's intent.
        for (const provider of moduleSet.tokenStorageProviders.values()) {
          try { await provider.shutdown(effectiveOptions); } catch { /* non-fatal */ }
        }
        moduleSet.tokenStorageProviders.clear();
        logger.debug('Sphere', `Destroyed modules for address ${idx}`);
      } catch (err) {
        logger.warn('Sphere', `Error destroying modules for address ${idx}:`, err);
      }
    }
    this._addressModules.clear();

    // Also destroy the active module references (they may be the same as
    // address 0 modules, but destroy() is idempotent)
    this._payments.destroy();
    this._communications.destroy();
    this._groupChat?.destroy();
    this._market?.destroy();

    // Disconnect transport mux if present
    if (this._transportMux) {
      await this._transportMux.disconnect();
      this._transportMux = null;
    }

    await this._transport.disconnect();

    // Issue #234 (shutdown ordering): shutdown token storage providers
    // BEFORE disconnecting the KV storage. ProfileTokenStorageProvider
    // shares its OrbitDbAdapter instance with ProfileStorageProvider
    // (see profile/factory.ts:427); the token provider's shutdown-time
    // flush writes the bundle CID via bundleIndex.addBundle ->
    // db.putEntry on that shared adapter. If _storage.disconnect()
    // runs first, the put throws PROFILE_NOT_INITIALIZED, the flush
    // throws, the aggregator pointer publish is skipped, and the
    // just-pinned CAR is orphaned. Note: this races a SECOND failure
    // mode tracked under #234 — IPFS gateway propagation lag, where
    // even a successful flush leaves the next process's load() unable
    // to fetch the CAR until the gateways catch up. This reorder is
    // necessary but NOT sufficient to fix the manual-test failure;
    // the IPFS propagation fix (e.g., persist CAR blocks to the local
    // Helia blockstore) is recommended as a follow-up.
    for (const provider of this._tokenStorageProviders.values()) {
      try {
        // Issue #239 — propagate destroy options (force / reason /
        // verificationDeadlineMs). The Profile provider's
        // LifecycleManager.shutdown reads these to gate (or skip) the
        // remote-durability verification round-trips before returning.
        // Providers without a remote-durability boundary (File /
        // IndexedDB / IPFS legacy) silently ignore the parameter.
        await provider.shutdown(effectiveOptions);
      } catch {
        // Non-fatal — provider may already be closed
      }
    }
    this._tokenStorageProviders.clear();

    await this._storage.disconnect();
    await this._oracle.disconnect();

    this._initialized = false;
    this._trackedAddressesLoaded = false;
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
    return identityStoreMnemonic(this as unknown as IdentityStorageHost, mnemonic, derivationPath, basePath);
  }

  private async storeMasterKey(
    masterKey: string,
    chainCode?: string,
    derivationPath?: string,
    basePath?: string,
    derivationMode?: DerivationMode
  ): Promise<void> {
    return identityStoreMasterKey(this as unknown as IdentityStorageHost, masterKey, chainCode, derivationPath, basePath, derivationMode);
  }

  /**
   * Mark wallet as fully created (after successful initialization)
   * This is called at the end of create()/import() to ensure wallet is only
   * marked as existing after all initialization steps succeed.
   */
  private async finalizeWalletCreation(): Promise<void> {
    return identityFinalizeWalletCreation(this as unknown as IdentityStorageHost);
  }

  // ===========================================================================
  // Private: Identity Initialization
  // ===========================================================================

  private async loadIdentityFromStorage(): Promise<void> {
    return identityLoadFromStorage(this as unknown as IdentityStorageHost);
  }

  private async initializeIdentityFromMnemonic(
    mnemonic: string,
    derivationPath?: string
  ): Promise<void> {
    return identityInitializeFromMnemonic(this as unknown as IdentityStorageHost, mnemonic, derivationPath);
  }

  private async initializeIdentityFromMasterKey(
    masterKey: string,
    chainCode?: string,
    _derivationPath?: string
  ): Promise<void> {
    return identityInitializeFromMasterKey(this as unknown as IdentityStorageHost, masterKey, chainCode, _derivationPath);
  }

  // ===========================================================================
  // Private: Provider & Module Initialization
  // ===========================================================================

  private async initializeProviders(): Promise<void> {
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

    // Set identity on all token storage providers
    for (const provider of this._tokenStorageProviders.values()) {
      provider.setIdentity(this._identity!);
    }

    // Connect providers. Ordering matters:
    //
    //   1. Oracle first — `oracle.initialize()` loads the embedded
    //      RootTrustBase and constructs the AggregatorClient. This
    //      is load-bearing for the Profile aggregator pointer layer:
    //      ProfileStorageProvider.doConnect() Phase C calls
    //      `oracle.getAggregatorClient()` / `getRootTrustBase()` to
    //      build ProfilePointerLayer. If storage connects before
    //      oracle, Phase C exits early with
    //      `aggregator_client_unavailable` and the pointer channel
    //      stays dark until a later explicit retry.
    //   2. Storage second — Phase A (local cache) + Phase B
    //      (OrbitDB attach) + Phase C (pointer layer construction,
    //      reads oracle state).
    //   3. Transport third — Nostr connection, independent.
    await this._oracle.initialize();
    // ALWAYS call connect() after oracle.initialize(), regardless of
    // current `isConnected()` state. Consumers may have pre-connected
    // the storage provider (e.g., the Sphere-bound Profile factory
    // `attachIdentityToProfileProviders` connects so the standalone
    // migration call sites can use the providers immediately). When
    // pre-connect happened BEFORE oracle.initialize, Phase C exited
    // with a retryable `aggregator_client_unavailable` skip reason
    // and `pointerLayer` is still null. `connect()` is idempotent:
    // Phase A is gated on `status !== 'connected'`, Phase B on
    // `dbStatus !== 'attached'`, and Phase C re-attempts when
    // `pointerLayer === null && !isPointerSkipSticky()`. So a second
    // call here cheaply finishes Phase C with the now-initialized
    // oracle and the pointer channel is live for the rest of the
    // session — instead of staying dark (issue #239 regression risk).
    await this._storage.connect();
    if (!this._transport.isConnected()) {
      await this._transport.connect();
    }

    // Subscribe to provider events BEFORE token-storage initialize so
    // any `storage:error` events emitted during initialize (e.g.,
    // `BUNDLE_INDEX_REFRESH_FAILED` from the Profile band-aid that
    // tolerates corrupt-OpLog initialization) reach the
    // `connection:changed` bridge. `provider.onEvent` is a synchronous
    // listener registry (`ProfileTokenStorageProvider.onEvent` lines
    // 1662-1667) with no replay buffer — subscribers added after
    // emission do NOT receive past events. Subscribing first ensures
    // production consumers see the degraded-state signal that unit
    // tests already pin.
    //
    // Safe to wire pre-initialize: `_tokenStorageProviders` Map is
    // populated by the constructor / setup phase well before
    // `initializeProviders` runs, and `onEvent` just appends to the
    // provider's local Set. No initialization order side effects.
    this.subscribeToProviderEvents();

    // Initialize all token storage providers in parallel
    await Promise.all(
      [...this._tokenStorageProviders.values()].map(p => p.initialize())
    );
  }

  /**
   * Subscribe to provider-level events and bridge them to Sphere connection:changed events.
   * Extracted to `core/sphere-providers.ts` — see there for detail.
   */
  private subscribeToProviderEvents(): void {
    return providersSubscribeToProviderEvents(this as unknown as ProvidersHost);
  }

  /**
   * RFC-251 Approach D — pointer-published Nostr forwarder.
   * Extracted to `core/sphere-providers.ts` — see there for detail.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async forwardPointerPublishedToNostr(event: any): Promise<void> {
    return providersForwardPointerPublishedToNostr(this as unknown as ProvidersHost, event);
  }

  /**
   * RFC-251 Approach D — sibling pointer-win subscription install.
   * Extracted to `core/sphere-providers.ts` — see there for detail.
   */
  private async maybeInstallPointerWinSubscription(): Promise<void> {
    return providersMaybeInstallPointerWinSubscription(this as unknown as ProvidersHost);
  }

  /**
   * Handle an incoming pointer-win broadcast from a sibling device.
   * Extracted to `core/sphere-providers.ts` — see there for detail.
   */
  private async handleIncomingPointerWinBroadcast(
    contentJson: string,
    ownSigningPubKeyHex: string,
    pointer: import('../extensions/uxf/profile/aggregator-pointer/ProfilePointerLayer').ProfilePointerLayer,
    verify: (
      payload: import('../extensions/uxf/profile/aggregator-pointer/win-broadcast').SignedWinBroadcastPayload,
      expectedSigningPubKeyHex: string,
    ) => Promise<boolean>,
  ): Promise<void> {
    return providersHandleIncomingPointerWinBroadcast(
      this as unknown as ProvidersHost,
      contentJson,
      ownSigningPubKeyHex,
      pointer,
      verify,
    );
  }

  /**
   * Emit connection:changed with deduplication — only emits if status actually changed.
   * Extracted to `core/sphere-providers.ts` — see there for detail.
   */
  private emitConnectionChanged(
    providerId: string,
    connected: boolean,
    status: ProviderStatus,
    error?: string,
  ): void {
    return providersEmitConnectionChanged(this as unknown as ProvidersHost, providerId, connected, status, error);
  }

  private cleanupProviderEventSubscriptions(): void {
    return providersCleanupProviderEventSubscriptions(this as unknown as ProvidersHost);
  }

  private initializeModules(): Promise<void> {
    return modulesInitInitializeModules(this as unknown as ModulesInitHost);
  }

  /**
   * Issue #312 — build the per-wallet ConnectivityManager.
   *
   * Pingers wired:
   *   - `aggregator`: probes `oracle.getCurrentRound()` (cheap JSON-RPC).
   *   - `ipfs`: HEAD-probes the configured gateways (skipped when no
   *      gateways are wired — wallet stays "fully online" w.r.t. IPFS).
   *   - `nostr`: reads `transport.isConnected()` (the transport owns its
   *      reconnect loop; we don't open a parallel subscription).
   *
   * Returns a freshly-built manager; the caller is responsible for
   * `.start()` and `.stop()`.
   */
  private buildConnectivityManager(): ConnectivityManager {
    const emitEvent = this.emitEvent.bind(this);

    const aggregatorPinger = new AggregatorPinger({
      provider: {
        getCurrentRound: () => this._oracle.getCurrentRound(),
      },
    });

    // IPFS gateways are wired only when the host app's provider factory
    // populated `_cidFetchGateways` (the wallet has IPFS sync configured).
    // Without gateways we skip the IPFS pinger entirely so the
    // "no-IPFS" wallet is not stuck in permanent offline-degraded.
    const ipfsGateways = this._cidFetchGateways ?? [];
    const pingers: import('./connectivity').Pinger[] = [aggregatorPinger];
    if (ipfsGateways.length > 0) {
      pingers.push(new IpfsPinger(ipfsGateways));
    }
    pingers.push(
      new NostrPinger(() => {
        try {
          return this._transport.isConnected();
        } catch {
          return false;
        }
      }),
    );

    return new ConnectivityManager(pingers, {
      emitEvent: (type, payload) => {
        // Forward to the Sphere event bus — types narrow correctly via
        // SphereEventMap.
        emitEvent(type as SphereEventType, payload as SphereEventMap[SphereEventType]);
      },
    });
  }

  // ===========================================================================
  // Private: Helpers
  // ===========================================================================

  private ensureReady(): void {
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
