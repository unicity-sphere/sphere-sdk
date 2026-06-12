/**
 * impl/shared/wallet-api/composition.ts — port composition (sdk-changes S4/S7,
 * covenant §3.1-6).
 *
 * The Sphere frontend is a VIEW: all I/O sits behind three independently
 * swappable ports — storage (`TokenStorageProvider`), delivery
 * (`DeliveryProvider`) and the engine/aggregator config (`OracleProvider`) —
 * selected at composition time. wallet-api ships as ONE implementation of each
 * port, not as the port:
 *
 * - {@link createSphereProviders} — the composition root: take any platform
 *   base bundle (`createBrowserProviders` / `createNodeProviders`) and select
 *   each port independently.
 * - {@link createWalletApiProviders} — the FULL wallet-api preset: thin
 *   storage (server inventory custody) + mailbox delivery with custody
 *   `'inventory'`.
 * - {@link createOwnStorageWalletApiProviders} — the delivery-only preset:
 *   the app's own (local) storage keeps custody; the mailbox provider is
 *   constructed with custody `'external'`, so every ack sends
 *   `intoInventory: false` — zero server inventory writes by construction
 *   (ARCHITECTURE §6 delivery-only claim; never a per-call flag).
 *
 * Asset-transport routing (S4): composing a delivery port moves ASSETS to it;
 * messaging, group chat and nametag bindings stay on the Nostr transport in
 * the base bundle. Payment requests ride wallet-api whenever the `walletApi`
 * client these presets return is passed to `Sphere.init` — `PaymentsModule`
 * detects the §16 payment-request capability on it and does not install the
 * Nostr payment-request channel (sdk-changes S4).
 */

import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase } from '../../../storage';
import type { TransportProvider } from '../../../transport';
import type { DeliveryProvider } from '../../../transport/delivery-provider';
import type { OracleProvider } from '../../../oracle';
import type { TokenBlob } from '../../../token-engine/types';
import { WalletApiClient } from '../../../wallet-api';
import type { FetchLike, KeyValueStore, WebSocketFactoryLike } from '../../../wallet-api';
import { WalletApiTokenStorageProvider } from './WalletApiTokenStorageProvider';
import { WalletApiMailboxProvider } from './WalletApiMailboxProvider';

// =============================================================================
// Composition root
// =============================================================================

/** The minimum any platform base bundle provides (browser/node factories do). */
export interface SphereBaseProviders {
  storage: StorageProvider;
  transport: TransportProvider;
  oracle: OracleProvider;
  tokenStorage: TokenStorageProvider<TxfStorageDataBase>;
}

/** Independent port selection (sdk-changes S7): any combination is legal. */
export interface SphereProviderPorts {
  /** Storage port override (token inventory + blob custody). */
  storage?: TokenStorageProvider<TxfStorageDataBase>;
  /** Delivery port (assets move to it; messaging stays on the base transport). */
  delivery?: DeliveryProvider;
  /** Engine/aggregator config port override. */
  engine?: OracleProvider;
}

/**
 * Compose a Sphere provider bundle with each port selected independently
 * (covenant §3.1-6). Unselected ports keep the base bundle's implementation.
 */
export function createSphereProviders<B extends SphereBaseProviders>(
  base: B,
  ports: SphereProviderPorts = {}
): B & { delivery?: DeliveryProvider } {
  return {
    ...base,
    ...(ports.storage ? { tokenStorage: ports.storage } : {}),
    ...(ports.engine ? { oracle: ports.engine } : {}),
    ...(ports.delivery ? { delivery: ports.delivery } : {}),
  };
}

// =============================================================================
// wallet-api presets (S4)
// =============================================================================

export interface WalletApiCompositionConfig {
  /** Backend base URL — https off-loopback (ARCHITECTURE §4, client-enforced). */
  baseUrl: string;
  /** Network name (e.g. 'testnet2') — required end-to-end (ARCHITECTURE §14). */
  network: string;
  /**
   * Stable per-device label (ARCHITECTURE §4 — one session row per (owner,
   * device); the refresh token is stored under it). Pass a persisted value;
   * when omitted a fresh random label is generated per construction, which
   * still works but starts every run with a challenge sign-in.
   */
  deviceId?: string;
  /** Reuse an existing client (tests / advanced wiring). */
  client?: WalletApiClient;
  /** Refresh-token / cursor / seen-set persistence; defaults to `base.storage`. */
  stateStore?: KeyValueStore;
  /** Injectable fetch (defaults to `globalThis.fetch`). */
  fetchFn?: FetchLike;
  /** Injectable WebSocket factory (defaults to `globalThis.WebSocket`). */
  webSocketFactory?: WebSocketFactoryLike;
  /** Local token verification for `recoverRemoved()` (wire the engine here). */
  verifyToken?: (blob: TokenBlob) => Promise<boolean>;
}

/** What the wallet-api presets add to the base bundle. */
export interface WalletApiProviderExtras {
  delivery: DeliveryProvider;
  /** The S1 client — pass to `Sphere.init({ walletApi })` for the S4 auth lifecycle. */
  walletApi: WalletApiClient;
}

function buildClient(base: SphereBaseProviders, config: WalletApiCompositionConfig): {
  client: WalletApiClient;
  stateStore: KeyValueStore;
} {
  // StorageProvider satisfies KeyValueStore structurally (get/set/remove);
  // all client/provider keys are self-namespaced per network + pubkey.
  const stateStore: KeyValueStore = config.stateStore ?? base.storage;
  const client =
    config.client ??
    new WalletApiClient({
      baseUrl: config.baseUrl,
      network: config.network,
      deviceId: config.deviceId ?? `sphere-${crypto.randomUUID()}`,
      storage: stateStore,
      fetchFn: config.fetchFn,
      webSocketFactory: config.webSocketFactory,
    });
  return { client, stateStore };
}

/**
 * The FULL wallet-api preset (S4): wallet-api keeps inventory custody —
 * thin/lazy storage over the server's value index + mailbox delivery with
 * custody `'inventory'` (claims perform the §6 ownership handoff).
 */
export function createWalletApiProviders<B extends SphereBaseProviders>(
  base: B,
  config: WalletApiCompositionConfig
): B & WalletApiProviderExtras {
  const { client, stateStore } = buildClient(base, config);
  const tokenStorage = new WalletApiTokenStorageProvider({
    client,
    stateStore,
    verifyToken: config.verifyToken,
  });
  const delivery = new WalletApiMailboxProvider({ client, custody: 'inventory', stateStore });
  return { ...base, tokenStorage, delivery, walletApi: client };
}

/**
 * The OWN-STORAGE preset (S7: own storage + wallet-api delivery — a
 * supported, tested composition): the base bundle's local storage keeps
 * custody; wallet-api is purely the delivery rail. Custody `'external'` is
 * baked in at construction — every ack sends `intoInventory: false`, so a
 * recipient's claim performs ZERO inventory writes even when `ack` is called
 * with no thought given to options (sdk-changes S7). Senders never call
 * apply; their sends close via `intents/{id}/complete` alone (ARCHITECTURE
 * §6 storage-opt-out senders), which the wallet-api client (passed as
 * `walletApi`) provides.
 */
export function createOwnStorageWalletApiProviders<B extends SphereBaseProviders>(
  base: B,
  config: WalletApiCompositionConfig
): B & WalletApiProviderExtras {
  const { client, stateStore } = buildClient(base, config);
  const delivery = new WalletApiMailboxProvider({ client, custody: 'external', stateStore });
  return { ...base, delivery, walletApi: client };
}
