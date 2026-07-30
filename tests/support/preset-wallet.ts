/**
 * tests/support/preset-wallet.ts — build a `PaymentsModule` over the REAL
 * wallet-api composition, against the in-process {@link FakeWalletApi}.
 *
 * Why this exists: every shipped preset in
 * `impl/shared/wallet-api/composition.ts` returns `delivery` AND `walletApi`
 * TOGETHER, so a real wallet always has both. Unit suites that wired a memory
 * delivery double with no client were composing a wallet that cannot exist in
 * production (and `assertLegalCustodyComposition` refuses it for the
 * inventory-custody shape). This helper reproduces `createWalletApiProviders`
 * (the FULL preset: thin server-custody storage + mailbox delivery with custody
 * `'inventory'` + the client) with the test seams the suites need.
 *
 * Three traps this helper closes by construction:
 *  1. AUTH — wallet-api signs a challenge, so the identity must be a real
 *     keypair. Pass {@link testIdentity} output, never a fabricated pair.
 *  2. CLIENT IDENTITY — `core/Sphere.ts` calls `walletApi.setIdentity()`;
 *     `PaymentsModule` does not. The helper binds it explicitly.
 *  3. ENGINE/WALLET PUBKEY AGREEMENT — `engine.isOwnedBy` checks fail if the
 *     engine's pubkey differs from the module identity's, so the engine factory
 *     is handed a config already bound to the wallet's pubkey.
 */

import { vi } from 'vitest';
import {
  createPaymentsModule,
  type PaymentsModule,
  type PaymentsModuleDependencies,
} from '../../modules/payments/PaymentsModule';
import type { FullIdentity } from '../../types';
import type { PeerInfo, TransportProvider } from '../../transport';
import type { OracleProvider } from '../../oracle';
import type { StorageProvider } from '../../storage';
import { FakeTokenEngine, decodeFakeTokenAssets, decodeFakeTokenId, type FakeEngineConfig } from '../unit/token-engine/FakeTokenEngine';
import { FakeWalletApi } from './fake-wallet-api';
import { MemoryKeyValueStore } from './wallet-api-test-helpers';
import { WalletApiClient } from '../../wallet-api';
import { WalletApiMailboxProvider, WalletApiTokenStorageProvider } from '../../impl/shared/wallet-api';
import { encodeTokenBlob } from '../../token-engine/token-blob';
import { hexToBytes } from '../../core/crypto';

/** A real secp256k1 pair — build with `testIdentity(n)`. */
export interface TestKeypair {
  readonly privateKey: string;
  readonly chainPubkey: string;
}

/** Expand a test keypair into the module's `FullIdentity`. */
export function fullIdentity(who: TestKeypair): FullIdentity {
  return {
    chainPubkey: who.chainPubkey,
    privateKey: who.privateKey,
    directAddress: `DIRECT://${who.chainPubkey.slice(0, 12)}`,
  };
}

/**
 * What a transport `resolve()` would return for `who`. Distinct from
 * {@link fullIdentity} on purpose: an Identity has no `transportPubkey` — that
 * belongs to a PEER description, and conflating them is how a test ends up
 * asserting on a field the wallet never had.
 */
export function peerInfoOf(who: TestKeypair, nametag?: string): PeerInfo {
  return {
    chainPubkey: who.chainPubkey,
    transportPubkey: who.chainPubkey.slice(2),
    directAddress: `DIRECT://${who.chainPubkey.slice(0, 12)}`,
    timestamp: 0,
    ...(nametag !== undefined ? { nametag } : {}),
  };
}

/** In-memory `StorageProvider` (the module's KV seam) plus its backing map. */
export function memoryStorage(): { provider: StorageProvider; map: Map<string, string> } {
  const s = new Map<string, string>();
  const provider = {
    id: 's', name: 's', type: 'local', connect: vi.fn(), disconnect: vi.fn(),
    isConnected: () => true, getStatus: () => 'connected', setIdentity: vi.fn(),
    get: vi.fn(async (k: string) => s.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { s.set(k, v); }),
    remove: vi.fn(async (k: string) => { s.delete(k); }),
    has: vi.fn(async (k: string) => s.has(k)),
    keys: vi.fn(async () => [...s.keys()]),
    clear: vi.fn(async () => { s.clear(); }),
  } as unknown as StorageProvider;
  return { provider, map: s };
}

/** Post-cutover oracle surface: network config only (no v1 client accessors). */
export function memoryOracle(): OracleProvider {
  return {
    id: 'o', name: 'o', type: 'aggregator',
    connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(),
    isConnected: () => true, getStatus: () => 'connected',
    initialize: vi.fn().mockResolvedValue(undefined),
    validateToken: vi.fn().mockResolvedValue({ valid: true, spent: false }),
    getTrustBaseJson: () => null,
    getAggregatorUrl: () => 'https://aggregator.test',
    getApiKey: () => undefined,
    isDevMode: () => false,
    onEvent: vi.fn().mockReturnValue(() => {}),
  } as unknown as OracleProvider;
}

/** Start the in-process fake backend wired to the FakeTokenEngine decoders. */
export async function startFakeWalletApi(): Promise<{
  fake: FakeWalletApi;
  baseUrl: string;
  stop: () => Promise<void>;
}> {
  const fake = new FakeWalletApi({ decodeAssets: decodeFakeTokenAssets, decodeTokenId: decodeFakeTokenId });
  const baseUrl = await fake.start();
  return { fake, baseUrl, stop: () => fake.stop() };
}

export interface PresetWalletOptions {
  readonly baseUrl: string;
  readonly network: string;
  /** MUST be a real keypair (`testIdentity(n)`) — the backend verifies signatures. */
  readonly who: TestKeypair;
  /** Stable per-device label (one session row per (owner, device)). */
  readonly deviceId: string;
  /** Peer resolution / messaging rail. Defaults to a transport that resolves nothing. */
  readonly transport?: TransportProvider;
  readonly oracle?: OracleProvider;
  /**
   * Engine factory, handed a config already bound to `who.chainPubkey`.
   * Pass `null` to wire NO engine at all (the "engine unavailable" case).
   */
  readonly engine?: ((config: FakeEngineConfig) => FakeTokenEngine) | null;
  /** Share persisted client/provider state across "reloads" of the same wallet. */
  readonly kv?: MemoryKeyValueStore;
}

export interface PresetWallet {
  readonly module: PaymentsModule;
  /** `null` only when `options.engine === null`. */
  readonly engine: FakeTokenEngine | null;
  readonly client: WalletApiClient;
  readonly delivery: WalletApiMailboxProvider;
  readonly tokenStorage: WalletApiTokenStorageProvider;
  readonly identity: FullIdentity;
  readonly emitEvent: ReturnType<typeof vi.fn>;
  readonly storage: { provider: StorageProvider; map: Map<string, string> };
  readonly deps: PaymentsModuleDependencies;
  readonly destroy: () => Promise<void>;
}

function bareTransport(): TransportProvider {
  return {
    sendTokenTransfer: vi.fn().mockResolvedValue(undefined),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn().mockResolvedValue(null),
    resolveTransportPubkeyInfo: vi.fn().mockResolvedValue(null),
    connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(), isConnected: () => true,
  } as unknown as TransportProvider;
}

/**
 * The FULL wallet-api preset (`createWalletApiProviders`): thin storage with
 * server inventory custody + mailbox delivery custody `'inventory'` + the
 * client, all sharing one `KeyValueStore` — exactly what ships.
 */
export function makeFullPresetWallet(options: PresetWalletOptions): PresetWallet {
  const identity = fullIdentity(options.who);
  const kv = options.kv ?? new MemoryKeyValueStore();
  const client = new WalletApiClient({
    baseUrl: options.baseUrl,
    network: options.network,
    deviceId: options.deviceId,
    storage: kv,
  });
  // Trap 2: PaymentsModule never calls walletApi.setIdentity() (Sphere does).
  client.setIdentity({ privateKey: identity.privateKey, chainPubkey: identity.chainPubkey });

  const tokenStorage = new WalletApiTokenStorageProvider({ client, stateStore: kv });
  tokenStorage.setIdentity(identity);
  const delivery = new WalletApiMailboxProvider({ client, custody: 'inventory', stateStore: kv });

  // Trap 3: the engine's pubkey MUST be the wallet's own.
  const engineConfig: FakeEngineConfig = { chainPubkey: hexToBytes(identity.chainPubkey) };
  const engine =
    options.engine === null ? null : (options.engine ?? ((c) => new FakeTokenEngine(c)))(engineConfig);

  const storage = memoryStorage();
  const emitEvent = vi.fn();
  const deps: PaymentsModuleDependencies = {
    identity,
    storage: storage.provider,
    tokenStorageProviders: new Map([[tokenStorage.id, tokenStorage]]),
    transport: options.transport ?? bareTransport(),
    oracle: options.oracle ?? memoryOracle(),
    emitEvent,
    delivery,
    walletApi: client,
    ...(engine ? { tokenEngine: engine } : {}),
  };
  const module = createPaymentsModule({ debug: false });
  module.initialize(deps);

  return {
    module, engine, client, delivery, tokenStorage, identity, emitEvent, storage, deps,
    destroy: async () => { await module.destroy(); },
  };
}

/** Mint on the wallet's engine and seed the blob into its SERVER inventory. */
export async function seedServerToken(
  fake: FakeWalletApi,
  wallet: PresetWallet,
  coinId: string,
  amount: bigint
): Promise<string> {
  if (!wallet.engine) throw new Error('seedServerToken: wallet has no engine');
  const minted = await wallet.engine.mint({
    recipientPubkey: wallet.engine.getIdentity().chainPubkey,
    value: { assets: [{ coinId, amount }] },
  });
  const bytes = encodeTokenBlob(wallet.engine.encodeToken(minted));
  const tokenId = wallet.engine.tokenId(minted);
  fake.seedInventory(wallet.identity.chainPubkey, [{ tokenId, assets: [{ coinId, amount }], blob: bytes }]);
  return tokenId;
}
