/**
 * createVaultTokenStorage — the SDK-internal factory that builds a wired
 * {@link RemoteTokenStorageProvider} for the wallet (vault wallet wiring, concern 2).
 *
 * WHY A FACTORY (the key constraint): the provider needs the raw spend key at
 * construction (`config.privateKey`; `setIdentity` asserts the identity pubkey ===
 * `getPublicKey(privateKey)` and throws otherwise). But `Sphere.identity` exposes
 * only the PUBLIC identity — never the privateKey. So construction MUST happen inside
 * the SDK, where a `FullIdentity` (with `privateKey`) is in scope. The app flips a
 * flag; the SDK runs this factory.
 *
 * It resolves the per-network vault URL + server signing key from `NETWORKS`, builds
 * the real fetch auth client, wires a lazy data-client factory that shares the
 * provider's OWN JWT/refresh session (`authTokenSource()`), and persists the
 * anti-rollback baseline DURABLY via {@link StorageBaselineStore} (namespaced by
 * network + owner) so the signed-root gate survives reloads.
 */

import { NETWORKS } from '../../constants';
import type { NetworkType } from '../../constants';
import type { FullIdentity } from '../../types';
import type { StorageProvider } from '../storage-provider';
import { RemoteTokenStorageProvider } from './RemoteTokenStorageProvider';
import { StorageBaselineStore } from './local-baseline-store';
import { createVaultAuthClient, createVaultHttpClients } from './http/index';
import type { FetchLike } from './http/index';
import type { VaultSessionStore } from './VaultApiClient';

/** Storage key prefix for the persisted vault auth session (per network + owner). */
const SESSION_KEY_PREFIX = 'sphere_vault_session';

/**
 * A durable {@link VaultSessionStore} over the wallet's KV storage so the JWT +
 * refresh token survive a page reload (the sphere-api pattern) — without it every
 * reload re-authenticates and flashes `Unauthorized`. Scoped by network + owner so
 * two wallets/networks never share a session row. A corrupt/blank value reads as
 * `null` (→ a clean re-authenticate), so a bad token never wedges the client.
 */
function createSessionStore(
  storage: Pick<StorageProvider, 'get' | 'set'>,
  network: string,
  chainPubkey: string,
): VaultSessionStore {
  const key = `${SESSION_KEY_PREFIX}:${network}:${chainPubkey}`;
  return {
    async load() {
      const raw = await storage.get(key);
      if (!raw) return null;
      try {
        const p = JSON.parse(raw) as { jwt?: string; refreshToken?: string };
        return p.jwt && p.refreshToken ? { jwt: p.jwt, refreshToken: p.refreshToken } : null;
      } catch {
        return null;
      }
    },
    async save(tokens) {
      await storage.set(key, JSON.stringify(tokens));
    },
    async clear() {
      await storage.set(key, '');
    },
  };
}

/** Inputs for {@link createVaultTokenStorage} — only the identity carries the key. */
export interface CreateVaultTokenStorageConfig {
  /** The full identity for THIS address — its `privateKey` is bound at construction. */
  identity: FullIdentity;
  /** Network whose `NETWORKS[network]` provides the vault URL + server signing key. */
  network: NetworkType;
  /** The wallet's key-value storage — backs the durable anti-rollback baseline. */
  storage: Pick<StorageProvider, 'get' | 'set'>;
  /** Override the vault base URL (defaults to `NETWORKS[network].vaultUrl`). */
  vaultUrl?: string;
  /** Stable device id stamped into the auth session. */
  deviceId?: string;
  /** Injectable `fetch` (tests/custom agents); defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
}

/**
 * Build a fully-wired {@link RemoteTokenStorageProvider} from a {@link FullIdentity}.
 * The caller registers it via `Sphere.addTokenStorageProvider`, which runs the
 * standard `setIdentity` + `initialize` + sync path.
 */
export function createVaultTokenStorage(
  config: CreateVaultTokenStorageConfig,
): RemoteTokenStorageProvider {
  const { identity, network, storage, deviceId, fetchImpl } = config;
  const vaultUrl = config.vaultUrl ?? NETWORKS[network].vaultUrl;
  const vaultServerKey = NETWORKS[network].vaultServerKey;

  const authClient = createVaultAuthClient(vaultUrl, fetchImpl);
  const localBaseline = new StorageBaselineStore(storage, network, identity.chainPubkey);
  const sessionStore = createSessionStore(storage, network, identity.chainPubkey);

  // The data client must share the provider's OWN auth session (`authTokenSource()`),
  // but the provider does not exist yet — capture a mutable ref and resolve it LAZILY
  // at the first http call (which only happens during/after `initialize()`).
  const ref: { provider: RemoteTokenStorageProvider | null } = { provider: null };
  const httpClientFactory = (): ReturnType<typeof createVaultHttpClients>['vault'] =>
    createVaultHttpClients({
      vaultUrl,
      auth: ref.provider!.authTokenSource(),
      fetchImpl,
    }).vault;

  const provider = new RemoteTokenStorageProvider({
    network,
    vaultUrl,
    privateKey: identity.privateKey,
    authClient,
    httpClientFactory,
    vaultServerKey,
    deviceId,
    localBaseline,
    sessionStore,
  });
  ref.provider = provider;
  return provider;
}
