/**
 * createCourierDeliveryTransport — the SDK-internal factory that builds a wired
 * {@link CourierDeliveryProvider} for the wallet (wallet-courier wiring, concern 2).
 *
 * WHY A FACTORY (same constraint as the vault's `createVaultTokenStorage`): the
 * provider reads the raw spend key (`me.privateKey`) on deposit/receive/ack, but
 * `Sphere.identity` exposes only the PUBLIC identity. Construction MUST happen inside
 * the SDK, where a `FullIdentity` (with `privateKey`) is in scope. The app flips a
 * flag; the SDK runs this factory.
 *
 * AUTH session — TWO modes (DESIGN: one JWT for vault + courier when both are on):
 *  - SHARED: when the vault is enabled, pass the vault provider's `authTokenSource()`
 *    so the courier reuses the SAME `VaultApiClient` session (one challenge/verify,
 *    one refresh chain). No second login.
 *  - OWN: when the vault is off, build the courier's OWN `VaultApiClient` over
 *    `createVaultAuthClient(vaultUrl)`, wrapped in a {@link LazyAuthTokenSource} that
 *    runs the handshake on first use (the courier has no `initialize()` step).
 *
 * The PaymentsModule sinks (`onV2Transfer` / `onDelivered`) are bound AFTER
 * construction via `provider.setSinks(...)` — the module exists only once its deps
 * are ready, after this factory has run. Here they are no-op placeholders.
 */

import { NETWORKS } from '../../constants';
import type { NetworkType } from '../../constants';
import type { FullIdentity } from '../../types';
import type { StorageProvider } from '../../storage/storage-provider';
import { VaultApiClient } from '../../storage/remote/VaultApiClient';
import { normalizeVaultNetwork } from '../../storage/remote/normalize-network';
import { createVaultAuthClient, createVaultHttpClients } from '../../storage/remote/http/index';
import type { FetchLike, VaultTokenSource } from '../../storage/remote/http/index';
import { CourierDeliveryProvider } from './CourierDeliveryProvider';
import { StorageCourierJournalStore } from './courier-journal-store';

/** Device id stamped into the courier's OWN auth session (when the vault is off). */
const COURIER_DEVICE_ID = 'sphere-courier';

/** Inputs for {@link createCourierDeliveryTransport} — only the identity carries the key. */
export interface CreateCourierDeliveryConfig {
  /** The full identity for THIS address — its `privateKey` drives courier crypto. */
  identity: FullIdentity;
  /** Network whose `NETWORKS[network]` provides the vault/courier URL. */
  network: NetworkType;
  /** The wallet's key-value storage — backs the durable courier journal. */
  storage: Pick<StorageProvider, 'get' | 'set'>;
  /** Override the vault base URL (defaults to `NETWORKS[network].vaultUrl`). */
  vaultUrl?: string;
  /**
   * Share an EXISTING auth session (the vault provider's `authTokenSource()`) so the
   * courier and vault use ONE JWT. Omit to build the courier's own session.
   */
  authTokenSource?: VaultTokenSource;
  /** Injectable `fetch` (tests/custom agents); defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
}

/**
 * A {@link VaultTokenSource} that lazily runs the challenge/verify handshake on first
 * read. The courier has no `initialize()` hook (unlike the vault provider), so the
 * own-auth path must authenticate on demand. `refresh()` delegates to the underlying
 * client (which serializes concurrent refreshes itself).
 */
class LazyAuthTokenSource implements VaultTokenSource {
  private authenticating: Promise<string> | null = null;

  constructor(private readonly client: VaultApiClient) {}

  get token(): string | null {
    return this.client.token;
  }

  /**
   * On the FIRST call (no JWT yet) run the full handshake once (collapsing concurrent
   * callers onto one in-flight promise); afterwards delegate to the client's own
   * serialized refresh.
   */
  refresh(): Promise<string> {
    if (this.client.token !== null) return this.client.refresh();
    if (!this.authenticating) {
      this.authenticating = this.client.authenticate().finally(() => {
        this.authenticating = null;
      });
    }
    return this.authenticating;
  }
}

/** Build the courier's OWN auth session (used when the vault is disabled). */
function ownAuthSource(
  identity: FullIdentity,
  network: string,
  vaultUrl: string,
  fetchImpl?: FetchLike,
): VaultTokenSource {
  const client = new VaultApiClient({
    network: normalizeVaultNetwork(network),
    chainPubkey: identity.chainPubkey,
    privateKey: identity.privateKey,
    deviceId: COURIER_DEVICE_ID,
    authClient: createVaultAuthClient(vaultUrl, fetchImpl),
  });
  return new LazyAuthTokenSource(client);
}

/**
 * Build a fully-wired {@link CourierDeliveryProvider} from a {@link FullIdentity}.
 * The caller binds the PaymentsModule sinks via `provider.setSinks(...)` once the
 * module is initialized and passes the provider as `deliveryTransport`.
 */
export function createCourierDeliveryTransport(
  config: CreateCourierDeliveryConfig,
): CourierDeliveryProvider {
  const { identity, network, storage, authTokenSource, fetchImpl } = config;
  const vaultUrl = config.vaultUrl ?? NETWORKS[network].vaultUrl;
  // Share the vault's session when given; otherwise build the courier's own.
  const auth = authTokenSource ?? ownAuthSource(identity, network, vaultUrl, fetchImpl);
  const journal = new StorageCourierJournalStore(storage, network, identity.chainPubkey);

  const provider = new CourierDeliveryProvider({
    vaultUrl,
    network,
    httpClientFactory: () => createVaultHttpClients({ vaultUrl, auth, fetchImpl }).courier,
    journal,
    // PaymentsModule binds the real sinks via setSinks() after it initializes.
    onV2Transfer: async () => {},
  });
  provider.setIdentity(identity);
  return provider;
}
