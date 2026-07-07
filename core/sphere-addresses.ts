/**
 * Sphere HD address management — Wave 6-P2-8c extraction from
 * `core/Sphere.ts`.
 *
 * Owns the multi-address surface of the wallet: HD derivation, tracked-
 * address registry persistence, address-scoped nametag caches, the
 * `switchToAddress` orchestration, and the post-switch background
 * transport/nametag reconciliation. The Sphere facade retains thin
 * public delegators so `sphere.switchToAddress(...)`,
 * `sphere.getActiveAddresses()`, `sphere.deriveAddress(...)`, etc.
 * keep working unchanged.
 *
 * The heavy per-address module bootstrap (`initializeAddressModules`,
 * `wireProfilePersistedSendStorage`, `buildCidRefStoreOrNull`,
 * `ensureTransportMux`, `ensureTokenEngine`) stays on the Sphere class
 * — those helpers reach across accounting / swap / groupchat / market
 * / OrbitDb / trust-base surfaces and are not in scope for this wave.
 * They're exposed to the extracted flows via the {@link AddressHost}
 * shim below.
 *
 * Behavior-preserving: bodies moved verbatim behind the
 * {@link AddressHost} shim. Every JSDoc + inline comment on the moved
 * methods is preserved. The private helpers become internal free
 * functions in this file; the Sphere facade delegates through them.
 */

import { logger } from './logger';
import { SphereError } from './errors';
import {
  deriveKeyAtPath,
  deriveAddressInfo,
  getPublicKey,
  sha256,
  publicKeyToAddress,
  generateAddressFromMasterKey,
  type MasterKey,
  type AddressInfo,
} from './crypto';
import { discoverAddressesImpl } from './discover';
import type {
  DiscoverAddressesOptions,
  DiscoverAddressesResult,
} from './discover';
import {
  STORAGE_KEYS_GLOBAL,
  getAddressId,
} from '../constants';
import type {
  StorageProvider,
  TokenStorageProvider,
  TxfStorageDataBase,
} from '../storage';
import type { TransportProvider } from '../transport';
import type {
  MultiAddressTransportMux,
  AddressTransportAdapter,
} from '../transport/MultiAddressTransportMux';
import type { OracleProvider } from '../oracle';
import type { PriceProvider } from '../price';
import type {
  FullIdentity,
  TrackedAddress,
  TrackedAddressEntry,
  DerivationMode,
  SphereEventType,
  SphereEventMap,
} from '../types';
import type { PaymentsModule, MintNametagResult } from '../modules/payments';
import type { CommunicationsModule } from '../modules/communications';
import type { GroupChatModule } from '../modules/groupchat';
import type { MarketModule } from '../modules/market';
import type { PublishToIpfsCallback } from '../extensions/uxf/pipeline/delivery-resolver';
import { deriveL3PredicateAddress, isValidNametag, type AddressModuleSet } from './Sphere';
import type { ITokenEngine } from '../token-engine';

/** Mutable version of FullIdentity — matches Sphere's internal alias. */
export type MutableFullIdentity = {
  -readonly [K in keyof FullIdentity]: FullIdentity[K];
};

/**
 * Host shim for HD address management. Mirrors the Sphere fields and
 * helpers that the moved methods reach for. Many fields are mutable
 * because `switchToAddress` rotates the wallet's active identity,
 * active module references, and cached transport bindings; the
 * tracked-address registry and address-nametag cache are also
 * mutated when new addresses get activated.
 */
export interface AddressHost {
  // Wallet key material (read-only) — derivation depends on the master key.
  readonly _masterKey: MasterKey | null;
  readonly _derivationMode: DerivationMode;
  readonly _basePath: string;

  // Active-address pointer and per-address state maps (mutable).
  _currentAddressIndex: number;
  readonly _trackedAddresses: Map<number, TrackedAddress>;
  readonly _addressIdToIndex: Map<string, number>;
  readonly _addressNametags: Map<string, Map<number, string>>;

  // Identity + active-module pointers rotated by switchToAddress.
  _identity: MutableFullIdentity | null;
  _payments: PaymentsModule;
  _communications: CommunicationsModule;
  _groupChat: GroupChatModule | null;
  _market: MarketModule | null;

  // Providers + shared state.
  readonly _storage: StorageProvider;
  readonly _transport: TransportProvider;
  readonly _oracle: OracleProvider;
  readonly _priceProvider: PriceProvider | null;
  _transportMux: MultiAddressTransportMux | null;
  readonly _tokenStorageProviders: Map<string, TokenStorageProvider<TxfStorageDataBase>>;
  readonly _addressModules: Map<number, AddressModuleSet>;
  readonly _tokenEngine: ITokenEngine | null;
  readonly _publishToIpfs: PublishToIpfsCallback | null;
  readonly _cidFetchGateways: ReadonlyArray<string> | null;
  readonly _dmSince: number | null;

  ensureReady(): void;
  emitEvent<T extends SphereEventType>(type: T, data: SphereEventMap[T]): void;
  cleanNametag(raw: string): string;
  mintNametag(nametag: string): Promise<MintNametagResult>;
  syncIdentityWithTransport(): Promise<void>;
  _updateCachedProxyAddress(): Promise<void>;
  ensureTransportMux(index: number, identity: FullIdentity): Promise<AddressTransportAdapter | null>;
  ensureTokenEngine(): Promise<ITokenEngine | null>;
  initializeAddressModules(
    index: number,
    identity: FullIdentity,
    tokenStorageProviders: Map<string, TokenStorageProvider<TxfStorageDataBase>>,
  ): Promise<AddressModuleSet>;
  buildCidRefStoreOrNull(): import('../extensions/uxf/profile/cid-ref-store').CidRefStore | null;
}

// =============================================================================
// Simple getters
// =============================================================================

/**
 * Get the current active address index
 */
export function getCurrentAddressIndexImpl(host: AddressHost): number {
  return host._currentAddressIndex;
}

/**
 * Get primary nametag for a specific address
 *
 * @param addressId - Address identifier (DIRECT://xxx), defaults to current address
 * @returns Primary nametag (index 0) or undefined if not registered
 */
export function getNametagForAddressImpl(
  host: AddressHost,
  addressId?: string,
): string | undefined {
  const id = addressId ?? host._trackedAddresses.get(host._currentAddressIndex)?.addressId;
  if (!id) return undefined;
  return host._addressNametags.get(id)?.get(0);
}

/**
 * Get all nametags for a specific address
 *
 * @param addressId - Address identifier (DIRECT://xxx), defaults to current address
 * @returns Map of nametagIndex to nametag, or undefined if no nametags
 */
export function getNametagsForAddressImpl(
  host: AddressHost,
  addressId?: string,
): Map<number, string> | undefined {
  const id = addressId ?? host._trackedAddresses.get(host._currentAddressIndex)?.addressId;
  if (!id) return undefined;
  const nametags = host._addressNametags.get(id);
  return nametags && nametags.size > 0 ? new Map(nametags) : undefined;
}

/**
 * Get all registered address nametags
 * @deprecated Use getActiveAddresses() or getAllTrackedAddresses() instead
 * @returns Map of addressId to (nametagIndex -> nametag)
 */
export function getAllAddressNametagsImpl(host: AddressHost): Map<string, Map<number, string>> {
  const result = new Map<string, Map<number, string>>();
  for (const [addressId, nametags] of host._addressNametags.entries()) {
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
export function getActiveAddressesImpl(host: AddressHost): TrackedAddress[] {
  host.ensureReady();
  const result: TrackedAddress[] = [];
  for (const entry of host._trackedAddresses.values()) {
    if (!entry.hidden) {
      const nametag = host._addressNametags.get(entry.addressId)?.get(0);
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
export function getAllTrackedAddressesImpl(host: AddressHost): TrackedAddress[] {
  host.ensureReady();
  const result: TrackedAddress[] = [];
  for (const entry of host._trackedAddresses.values()) {
    const nametag = host._addressNametags.get(entry.addressId)?.get(0);
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
export function getTrackedAddressImpl(
  host: AddressHost,
  index: number,
): TrackedAddress | undefined {
  host.ensureReady();
  const entry = host._trackedAddresses.get(index);
  if (!entry) return undefined;
  const nametag = host._addressNametags.get(entry.addressId)?.get(0);
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
export async function setAddressHiddenImpl(
  host: AddressHost,
  index: number,
  hidden: boolean,
): Promise<void> {
  host.ensureReady();
  const entry = host._trackedAddresses.get(index);
  if (!entry) {
    throw new SphereError(`Address at index ${index} is not tracked. Switch to it first.`, 'INVALID_CONFIG');
  }
  if (entry.hidden === hidden) return;

  (entry as { hidden: boolean }).hidden = hidden;
  await persistTrackedAddressesImpl(host);

  const eventType = hidden ? 'address:hidden' : 'address:unhidden';
  host.emitEvent(eventType, { index, addressId: entry.addressId });
}

/**
 * Get per-address modules for any address index (creates lazily if needed).
 * This allows accessing any address's modules without switching.
 */
export function getAddressPaymentsImpl(
  host: AddressHost,
  index: number,
): PaymentsModule | undefined {
  return host._addressModules.get(index)?.payments;
}

// =============================================================================
// switchToAddress + postSwitchSync
// =============================================================================

/**
 * Switch to a different address by index
 * This changes the active identity to the derived address at the specified index.
 *
 * @param index - Address index to switch to (0, 1, 2, ...)
 */
export async function switchToAddressImpl(
  host: AddressHost,
  index: number,
  options?: { nametag?: string },
): Promise<void> {
  host.ensureReady();

  if (!host._masterKey) {
    throw new SphereError('HD derivation requires master key with chain code. Cannot switch addresses.', 'INVALID_CONFIG');
  }

  if (index < 0) {
    throw new SphereError('Address index must be non-negative', 'INVALID_CONFIG');
  }

  // If nametag requested, normalize and validate format early
  const newNametag = options?.nametag ? host.cleanNametag(options.nametag) : undefined;
  if (newNametag && !isValidNametag(newNametag)) {
    throw new SphereError('Invalid Unicity ID format. Use lowercase alphanumeric, underscore, or hyphen (3-20 chars), or a valid phone number.', 'VALIDATION_ERROR');
  }

  // Derive the address at the given index
  const addressInfo = deriveAddressPublicImpl(host, index, false);

  // Generate IPNS name from public key hash
  const ipnsHash = sha256(addressInfo.publicKey, 'hex').slice(0, 40);

  // Derive L3 predicate address (DIRECT://...)
  const predicateAddress = await deriveL3PredicateAddress(addressInfo.privateKey);

  // Ensure address is tracked in the registry
  await ensureAddressTrackedImpl(host, index);
  const addressId = getAddressId(predicateAddress);

  // If nametag requested, check availability and store it BEFORE building identity
  if (newNametag) {
    const existing = await host._transport.resolveNametag?.(newNametag);
    if (existing) {
      throw new SphereError(`Unicity ID @${newNametag} is already taken`, 'VALIDATION_ERROR');
    }

    // Pre-populate nametag cache so identity is built WITH nametag
    let nametags = host._addressNametags.get(addressId);
    if (!nametags) {
      nametags = new Map();
      host._addressNametags.set(addressId, nametags);
    }
    nametags.set(0, newNametag);
  }

  const nametag = host._addressNametags.get(addressId)?.get(0);

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
  // No destroy, no waitForPendingOperations — old address keeps running.
  // =========================================================================

  if (!host._addressModules.has(index)) {
    // First time switching to this address — create independent modules
    logger.debug('Sphere', `switchToAddress(${index}): creating per-address modules (lazy init)`);

    // CRITICAL: Update shared storage identity BEFORE loading per-address modules.
    // IndexedDBStorageProvider.getFullKey() uses this.identity to build per-address
    // storage keys.  Without this, modules would load the previous address's data.
    host._storage.setIdentity(newIdentity);

    // Create per-address token storage providers (each address needs its own instances)
    const addressTokenProviders = new Map<string, TokenStorageProvider<TxfStorageDataBase>>();
    for (const [providerId, provider] of host._tokenStorageProviders.entries()) {
      if (provider.createForAddress) {
        const newProvider = provider.createForAddress();
        newProvider.setIdentity(newIdentity);
        await newProvider.initialize();
        addressTokenProviders.set(providerId, newProvider);
      } else {
        // Fallback: reuse existing provider (legacy behavior for providers
        // that don't support createForAddress)
        logger.warn('Sphere', `Token storage provider ${providerId} does not support createForAddress, reusing shared instance`);
        addressTokenProviders.set(providerId, provider);
      }
    }

    await host.initializeAddressModules(index, newIdentity, addressTokenProviders);
  } else {
    // Modules already exist — update identity if nametag changed
    const moduleSet = host._addressModules.get(index)!;
    if (nametag !== moduleSet.identity.nametag) {
      moduleSet.identity = newIdentity;
      // Use per-address transport if available
      const addressTransport: TransportProvider = moduleSet.transportAdapter ?? host._transport;
      // Phase 6 — ensure v2 token engine is available for the deps object.
      await host.ensureTokenEngine();
      // Re-initialize with updated identity (nametag change)
      moduleSet.payments.initialize({
        identity: newIdentity,
        storage: host._storage,
        tokenStorageProviders: moduleSet.tokenStorageProviders,
        transport: addressTransport,
        oracle: host._oracle,
        tokenEngine: host._tokenEngine ?? undefined,
        emitEvent: host.emitEvent.bind(host),
            price: host._priceProvider ?? undefined,
        // Issue #200 Phase 1 wiring — keep CID-by-reference publisher
        // wired across nametag-driven re-initialization.
        publishToIpfs: host._publishToIpfs ?? undefined,
        cidFetchGateways: host._cidFetchGateways ?? undefined,
        // Issue #285 — preserve the CidRefStore across nametag re-init.
        // The wallet's encryption key has not changed (only the nametag
        // moved), so the cached store is still valid; we rebuild for
        // safety because `Sphere.buildCidRefStoreOrNull()` is cheap
        // (one constructor call). Without this line, the re-init would
        // drop the deps.cidRefStore field back to undefined and the
        // PaymentsModule would silently fall back to inline JSON for
        // pending V5 token persistence.
        cidRefStore: host.buildCidRefStoreOrNull() ?? undefined,
        // Issue #255 Problem A — re-thread HD-index recovery hooks on
        // nametag-driven re-init so per-address PaymentsModule
        // instances keep the recovery surface alive after identity
        // updates.
        ...(host._masterKey
          ? {
              deriveAddressInfo: (idx: number) =>
                deriveAddressInternalImpl(host, idx, false),
              getActiveAddresses: () => getActiveAddressesInternalImpl(host),
            }
          : {}),
      });
    }
  }

  // Switch the active pointer — instant, no destroy
  host._identity = newIdentity;
  host._currentAddressIndex = index;
  await host._updateCachedProxyAddress();

  // Update active module references for backward compatibility
  const activeModules = host._addressModules.get(index)!;
  host._payments = activeModules.payments;
  host._communications = activeModules.communications;
  host._groupChat = activeModules.groupChat;
  host._market = activeModules.market;

  // Persist current index
  await host._storage.set(STORAGE_KEYS_GLOBAL.CURRENT_ADDRESS_INDEX, index.toString());

  // Update storage identity for per-address key scoping
  host._storage.setIdentity(host._identity);

  // Provide fallback 'since' for first-time Nostr subscriptions
  if (host._transport.setFallbackSince) {
    const fallbackTs = Math.floor(Date.now() / 1000) - 86400;
    host._transport.setFallbackSince(fallbackTs);
  }

  await host._transport.setIdentity(host._identity);

  // The transport recreates its NostrClient on identity change (the
  // SDK's client doesn't support runtime key swaps). When the Mux is
  // sharing that client (#123), it must rebind to the new instance
  // and re-establish its wallet/chat subscriptions on the new socket.
  if (host._transportMux && typeof (host._transportMux as { rebindToSharedClient?: () => Promise<void> }).rebindToSharedClient === 'function') {
    await (host._transportMux as { rebindToSharedClient: () => Promise<void> }).rebindToSharedClient();
  }

  host.emitEvent('identity:changed', {
    directAddress: host._identity.directAddress,
    chainPubkey: host._identity.chainPubkey,
    nametag: host._identity.nametag,
    addressIndex: index,
  });

  logger.debug('Sphere', `Switched to address ${index}:`, host._identity.directAddress);

  // Run transport sync and nametag operations in background
  postSwitchSyncImpl(host, index, newNametag).catch(err => {
    logger.warn('Sphere', `Post-switch sync failed for address ${index}:`, err);
  });
}

/**
 * Background transport sync and nametag operations after address switch.
 * Runs after switchToAddress returns so L1/L3 queries can start immediately.
 */
export async function postSwitchSyncImpl(
  host: AddressHost,
  index: number,
  newNametag?: string,
): Promise<void> {
  // Sync identity with transport — recovers nametag from existing Nostr bindings
  if (!newNametag) {
    await host.syncIdentityWithTransport();
  }

  // If new nametag was registered, persist cache and mint token
  if (newNametag) {
    await persistAddressNametagsImpl(host);

    if (!host._payments.hasNametag()) {
      logger.debug('Sphere', `Minting nametag token for @${newNametag}...`);
      try {
        const result = await host.mintNametag(newNametag);
        if (result.success) {
          logger.debug('Sphere', `Nametag token minted successfully`);
        } else {
          logger.warn('Sphere', `Could not mint nametag token: ${result.error}`);
        }
      } catch (err) {
        logger.warn('Sphere', `Nametag token mint failed:`, err);
      }
    }

    host.emitEvent('nametag:registered', {
      nametag: newNametag,
      addressIndex: index,
    });
  } else if (host._identity?.nametag && !host._payments.hasNametag()) {
    // Existing address with nametag but missing token — mint it
    logger.debug('Sphere', `Unicity ID @${host._identity.nametag} has no token after switch, minting...`);
    try {
      const result = await host.mintNametag(host._identity.nametag);
      if (result.success) {
        logger.debug('Sphere', `Nametag token minted successfully after switch`);
      } else {
        logger.warn('Sphere', `Could not mint nametag token after switch: ${result.error}`);
      }
    } catch (err) {
      logger.warn('Sphere', `Nametag token mint failed after switch:`, err);
    }
  }
}

// =============================================================================
// Derivation
// =============================================================================

/**
 * Derive address at a specific index (public path, `ensureReady`-gated).
 *
 * @param index - Address index (0, 1, 2, ...)
 * @param isChange - Whether this is a change address (default: false)
 * @returns Address info with privateKey, publicKey, address, path, index
 */
export function deriveAddressPublicImpl(
  host: AddressHost,
  index: number,
  isChange: boolean = false,
): AddressInfo {
  host.ensureReady();
  return deriveAddressInternalImpl(host, index, isChange);
}

/**
 * Internal getActiveAddresses without ensureReady() check.
 * IMPORTANT: This method skips ensureReady() because it's called during initialization
 * before _initialized is set. It REQUIRES that loadTrackedAddresses() has already completed.
 */
export function getActiveAddressesInternalImpl(host: AddressHost): TrackedAddress[] {
  const result: TrackedAddress[] = [];
  for (const entry of host._trackedAddresses.values()) {
    if (!entry.hidden) {
      const nametag = host._addressNametags.get(entry.addressId)?.get(0);
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
export function deriveAddressInternalImpl(
  host: AddressHost,
  index: number,
  isChange: boolean = false,
): AddressInfo {
  if (!host._masterKey) {
    throw new SphereError('HD derivation requires master key with chain code', 'INVALID_CONFIG');
  }

  // WIF/HMAC mode: legacy HMAC-SHA512 derivation (no chain code, no change addresses)
  if (host._derivationMode === 'wif_hmac') {
    return generateAddressFromMasterKey(host._masterKey.privateKey, index);
  }

  const info = deriveAddressInfo(
    host._masterKey,
    host._basePath,
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
 */
export function deriveAddressAtPathImpl(host: AddressHost, path: string): AddressInfo {
  host.ensureReady();

  if (!host._masterKey) {
    throw new SphereError('HD derivation requires master key with chain code', 'INVALID_CONFIG');
  }

  // Parse path to extract index
  const match = path.match(/\/(\d+)$/);
  const index = match ? parseInt(match[1], 10) : 0;

  const derived = deriveKeyAtPath(
    host._masterKey.privateKey,
    host._masterKey.chainCode,
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
 */
export function deriveAddressesImpl(
  host: AddressHost,
  count: number,
  includeChange: boolean = false,
): AddressInfo[] {
  const addresses: AddressInfo[] = [];

  for (let i = 0; i < count; i++) {
    addresses.push(deriveAddressPublicImpl(host, i, false));
  }

  if (includeChange) {
    for (let i = 0; i < count; i++) {
      addresses.push(deriveAddressPublicImpl(host, i, true));
    }
  }

  return addresses;
}

// =============================================================================
// Tracked-address registry persistence
// =============================================================================

/**
 * Persist tracked addresses to storage (only minimal fields via StorageProvider)
 */
export async function persistTrackedAddressesImpl(host: AddressHost): Promise<void> {
  const entries: TrackedAddressEntry[] = [];
  for (const entry of host._trackedAddresses.values()) {
    entries.push({
      index: entry.index,
      hidden: entry.hidden,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    });
  }
  await host._storage.saveTrackedAddresses(entries);
}

/**
 * Load tracked addresses from storage.
 * Falls back to migrating from old ADDRESS_NAMETAGS format.
 */
export async function loadTrackedAddressesImpl(host: AddressHost): Promise<void> {
  host._trackedAddresses.clear();
  host._addressIdToIndex.clear();

  try {
    // Load minimal entries from storage
    const entries = await host._storage.loadTrackedAddresses();
    if (entries.length > 0) {
      for (const stored of entries) {
        // Derive address fields from index (internal: no ensureReady check)
        const addrInfo = deriveAddressInternalImpl(host, stored.index, false);
        const directAddress = await deriveL3PredicateAddress(addrInfo.privateKey);
        const addressId = getAddressId(directAddress);

        const entry: TrackedAddress = {
          ...stored,
          addressId,
            directAddress,
          chainPubkey: addrInfo.publicKey,
        };
        host._trackedAddresses.set(entry.index, entry);
        host._addressIdToIndex.set(addressId, entry.index);
      }
      return;
    }

    // Fall back to old ADDRESS_NAMETAGS format and migrate
    const oldData = await host._storage.get(STORAGE_KEYS_GLOBAL.ADDRESS_NAMETAGS);
    if (oldData) {
      const parsed = JSON.parse(oldData) as Record<string, unknown>;
      await migrateFromOldNametagFormatImpl(host, parsed);
      await persistTrackedAddressesImpl(host);
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
export async function migrateFromOldNametagFormatImpl(
  host: AddressHost,
  parsed: Record<string, unknown>,
): Promise<void> {
  const addressIdToNametags = new Map<string, Record<string, string>>();
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'object' && value !== null) {
      addressIdToNametags.set(key, value as Record<string, string>);
    }
  }

  if (addressIdToNametags.size === 0 || !host._masterKey) return;

  const SCAN_LIMIT = 20;
  for (let i = 0; i < SCAN_LIMIT && addressIdToNametags.size > 0; i++) {
    try {
      const addrInfo = deriveAddressInternalImpl(host, i, false);
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
          host._addressNametags.set(addressId, nametagMap);
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

        host._trackedAddresses.set(i, entry);
        host._addressIdToIndex.set(addressId, i);
        addressIdToNametags.delete(addressId);
      }
    } catch {
      // Skip indices that fail to derive
    }
  }

  // Persist nametag cache separately
  await persistAddressNametagsImpl(host);
}

/**
 * Ensure an address is tracked in the registry.
 * If not yet tracked, derives full info and creates the entry.
 */
export async function ensureAddressTrackedImpl(
  host: AddressHost,
  index: number,
): Promise<TrackedAddress> {
  const existing = host._trackedAddresses.get(index);
  if (existing) return existing;

  const addrInfo = deriveAddressInternalImpl(host, index, false);
  const directAddress = await deriveL3PredicateAddress(addrInfo.privateKey);
  const addressId = getAddressId(directAddress);

  const now = Date.now();
  const nametag = host._addressNametags.get(addressId)?.get(0);
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

  host._trackedAddresses.set(index, entry);
  host._addressIdToIndex.set(addressId, index);
  await persistTrackedAddressesImpl(host);

  host.emitEvent('address:activated', { address: { ...entry } });
  return entry;
}

// =============================================================================
// Address-nametag cache persistence
// =============================================================================

/**
 * Persist nametag cache to storage.
 * Format: { addressId: { "0": "alice", "1": "alice2" } }
 */
export async function persistAddressNametagsImpl(host: AddressHost): Promise<void> {
  const result: Record<string, Record<string, string>> = {};
  for (const [addressId, nametags] of host._addressNametags.entries()) {
    const obj: Record<string, string> = {};
    for (const [idx, tag] of nametags.entries()) {
      obj[idx.toString()] = tag;
    }
    result[addressId] = obj;
  }
  await host._storage.set(STORAGE_KEYS_GLOBAL.ADDRESS_NAMETAGS, JSON.stringify(result));
}

/**
 * Load nametag cache from storage.
 */
export async function loadAddressNametagsImpl(host: AddressHost): Promise<void> {
  host._addressNametags.clear();
  try {
    const data = await host._storage.get(STORAGE_KEYS_GLOBAL.ADDRESS_NAMETAGS);
    if (!data) return;
    const parsed = JSON.parse(data) as Record<string, Record<string, string>>;
    for (const [addressId, nametags] of Object.entries(parsed)) {
      const map = new Map<number, string>();
      for (const [idx, tag] of Object.entries(nametags)) {
        map.set(parseInt(idx, 10), tag);
      }
      host._addressNametags.set(addressId, map);
    }
  } catch {
    // Ignore parse errors
  }
}

// =============================================================================
// Discovery + bulk-track
// =============================================================================

/**
 * Bulk-track scanned addresses with visibility and nametag data.
 * Selected addresses get `hidden: false`, unselected get `hidden: true`.
 * Performs only 2 storage writes total (tracked addresses + nametags).
 */
export async function trackScannedAddressesImpl(
  host: AddressHost,
  entries: Array<{ index: number; hidden: boolean; nametag?: string }>,
): Promise<void> {
  host.ensureReady();

  for (const { index, hidden, nametag } of entries) {
    const tracked = await ensureAddressTrackedImpl(host, index);

    if (nametag) {
      let nametags = host._addressNametags.get(tracked.addressId);
      if (!nametags) {
        nametags = new Map();
        host._addressNametags.set(tracked.addressId, nametags);
      }
      if (!nametags.has(0)) nametags.set(0, nametag);
    }

    if (tracked.hidden !== hidden) {
      (tracked as { hidden: boolean }).hidden = hidden;
    }
  }

  await persistTrackedAddressesImpl(host);
  await persistAddressNametagsImpl(host);
}

/**
 * Discover previously used HD addresses.
 *
 * Primary: queries Nostr relay for identity binding events (fast, single batch query).
 * Secondary: runs L1 balance scan to find legacy addresses with no binding event.
 */
export async function discoverAddressesImplWrapped(
  host: AddressHost,
  options: DiscoverAddressesOptions = {},
): Promise<DiscoverAddressesResult> {
  host.ensureReady();

  if (!host._masterKey) {
    throw new SphereError('Address discovery requires HD master key', 'INVALID_CONFIG');
  }

  if (!host._transport.discoverAddresses) {
    throw new SphereError('Transport provider does not support address discovery', 'INVALID_CONFIG');
  }

  // Phase 1: Transport (Nostr) binding event scan
  const transportResult = await discoverAddressesImpl(
    (index: number) => {
      const addrInfo = deriveAddressInternalImpl(host, index, false);
      return {
        transportPubkey: addrInfo.publicKey.slice(2), // x-only 32 bytes
        chainPubkey: addrInfo.publicKey,
        directAddress: '', // not needed for discovery query
      };
    },
    (pubkeys: string[]) => host._transport.discoverAddresses!(pubkeys),
    options,
  );

  // Auto-track if requested
  if (options.autoTrack && transportResult.addresses.length > 0) {
    await trackScannedAddressesImpl(
      host,
      transportResult.addresses.map(a => ({
        index: a.index,
        // Preserve existing hidden state; default to false for newly discovered
        hidden: host._trackedAddresses.get(a.index)?.hidden ?? false,
        nametag: a.nametag,
      })),
    );
  }

  return transportResult;
}
