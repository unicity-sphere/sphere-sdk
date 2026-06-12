/**
 * tests/harness/support/harness-wallet.ts — a REAL wallet composition for the
 * phase-2 harness (no vitest imports: the child-process runner uses this too).
 *
 * Unlike the unit-level model suite (PaymentsModule.wallet-api-delivery.test.ts,
 * which runs FakeTokenEngine against the in-process fake backend), every layer
 * that talks to the outside world here is REAL:
 *
 * - the S4 presets (`createWalletApiProviders` / `createOwnStorageWalletApiProviders`)
 *   compose the real `WalletApiClient` + providers against the real backend
 *   over real HTTP;
 * - the engine is the real `createSphereTokenEngine` (recoverable, Part E)
 *   over the stack's mock aggregator via the SDK's REAL JSON-RPC wire client,
 *   verifying against the same LOCAL trustbase the backend pinned (§8.2);
 * - storage/transport/oracle stubs cover only the surfaces these flows never
 *   exercise (messaging stays on Nostr per S4; oracle validation rides
 *   engine.verify + the backend's §8.2 pipeline) — mirroring the model suite's
 *   composition pattern.
 */

import type { FullIdentity } from '../../../types';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type {
  HistoryRecord,
  StorageProvider,
  TokenStorageProvider,
  TxfStorageDataBase,
} from '../../../storage';
import type { ITokenEngine, TokenBlob } from '../../../token-engine';
import { createSphereTokenEngine } from '../../../token-engine';
import {
  createOwnStorageWalletApiProviders,
  createWalletApiProviders,
  type SphereBaseProviders,
} from '../../../impl/shared/wallet-api';
import { WalletApiClient } from '../../../wallet-api';
import type { FetchLike, KeyValueStore } from '../../../wallet-api';
import {
  createPaymentsModule,
  type PaymentsModule,
  type PaymentsModuleDependencies,
} from '../../../modules/payments/PaymentsModule';
import { fetchTrustbaseJson, type HarnessStack } from './stack';

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function fullIdentity(id: { privateKey: string; chainPubkey: string }): FullIdentity {
  return {
    chainPubkey: id.chainPubkey,
    privateKey: id.privateKey,
    l1Address: `alpha1${id.chainPubkey.slice(0, 8)}`,
    directAddress: `DIRECT://${id.chainPubkey.slice(0, 12)}`,
  };
}

/** In-memory module storage (outbox, delivery journal, PR cursor, client state). */
function memoryStorage(): { provider: StorageProvider; kv: KeyValueStore; map: Map<string, string> } {
  const map = new Map<string, string>();
  const surface = {
    id: 'harness-storage',
    name: 'harness-storage',
    type: 'local',
    connect: async (): Promise<void> => {},
    disconnect: (): void => {},
    isConnected: (): boolean => true,
    getStatus: (): string => 'connected',
    setIdentity: (): void => {},
    get: async (k: string): Promise<string | null> => map.get(k) ?? null,
    set: async (k: string, v: string): Promise<void> => {
      map.set(k, v);
    },
    remove: async (k: string): Promise<void> => {
      map.delete(k);
    },
    has: async (k: string): Promise<boolean> => map.has(k),
    keys: async (): Promise<string[]> => [...map.keys()],
    clear: async (): Promise<void> => {
      map.clear();
    },
  };
  const provider = surface as unknown as StorageProvider;
  return { provider, kv: surface, map };
}

/** Local whole-blob custody for the own-storage (delivery-only) composition. */
function localTokenStorage(): TokenStorageProvider<TxfStorageDataBase> {
  let lastSaved: TxfStorageDataBase | null = null;
  const history = new Map<string, HistoryRecord>();
  const surface = {
    id: 'local',
    name: 'local',
    type: 'local',
    connect: async (): Promise<void> => {},
    disconnect: async (): Promise<void> => {},
    isConnected: (): boolean => true,
    getStatus: (): string => 'connected',
    setIdentity: (): void => {},
    initialize: async (): Promise<boolean> => true,
    shutdown: async (): Promise<void> => {},
    save: async (data: TxfStorageDataBase): Promise<{ success: boolean; timestamp: number }> => {
      lastSaved = data;
      return { success: true, timestamp: Date.now() };
    },
    load: async (): Promise<unknown> =>
      lastSaved
        ? { success: true, source: 'local', timestamp: 0, data: lastSaved }
        : { success: false, source: 'local', timestamp: 0 },
    sync: async (): Promise<unknown> => ({ success: true, added: 0, removed: 0, conflicts: 0 }),
    addHistoryEntry: async (e: HistoryRecord): Promise<void> => {
      history.set(e.dedupKey, e);
    },
    getHistoryEntries: async (): Promise<HistoryRecord[]> => [...history.values()],
    hasHistoryEntry: async (k: string): Promise<boolean> => history.has(k),
    clearHistory: async (): Promise<void> => history.clear(),
    importHistoryEntries: async (): Promise<number> => 0,
  };
  return surface as unknown as TokenStorageProvider<TxfStorageDataBase>;
}

/**
 * Recipients are addressed by raw chain pubkey (the canonical identity);
 * messaging/nametags stay out of scope (S4: assets leave Nostr).
 */
function stubTransport(): TransportProvider {
  const surface = {
    resolve: async (recipient: string): Promise<unknown> =>
      /^0[23][0-9a-f]{64}$/i.test(recipient)
        ? {
            chainPubkey: recipient.toLowerCase(),
            transportPubkey: recipient.slice(2).toLowerCase(),
            directAddress: `DIRECT://${recipient.slice(0, 12)}`,
          }
        : null,
    resolveTransportPubkeyInfo: async (): Promise<null> => null,
    sendTokenTransfer: async (): Promise<void> => {
      throw new Error('harness: assets ride the wallet-api delivery port, never the transport (S4)');
    },
    onTokenTransfer: (): (() => void) => () => {},
    onPaymentRequest: (): (() => void) => () => {},
    onPaymentRequestResponse: (): (() => void) => () => {},
    connect: async (): Promise<void> => {},
    disconnect: (): void => {},
    isConnected: (): boolean => true,
  };
  return surface as unknown as TransportProvider;
}

/**
 * Oracle stub: in these flows token validity is enforced by the REAL engine
 * (`engine.verify` against the shared trustbase) and the backend's REAL §8.2
 * pipeline — the oracle port's validateToken is not the property under test.
 */
function stubOracle(): OracleProvider {
  const surface = {
    validateToken: async (): Promise<{ valid: boolean }> => ({ valid: true }),
    isDevMode: (): boolean => false,
  };
  return surface as unknown as OracleProvider;
}

/**
 * A standalone, pump-less wallet-api client bound to an identity — for raw
 * wire assertions that must NOT race the module's background pumps (the real
 * backend pushes §9 wakes; a full wallet auto-claims discovered deliveries).
 */
export function createRawClient(
  stack: HarnessStack,
  identity: { privateKey: string; chainPubkey: string },
  deviceId: string
): WalletApiClient {
  const map = new Map<string, string>();
  const client = new WalletApiClient({
    baseUrl: stack.baseUrl,
    network: stack.network,
    deviceId,
    storage: {
      get: async (k: string) => map.get(k) ?? null,
      set: async (k: string, v: string) => {
        map.set(k, v);
      },
      remove: async (k: string) => {
        map.delete(k);
      },
    },
  });
  client.setIdentity({ privateKey: identity.privateKey, chainPubkey: identity.chainPubkey });
  return client;
}

export interface HarnessWalletOptions {
  readonly stack: HarnessStack;
  readonly identity: { privateKey: string; chainPubkey: string };
  readonly deviceId: string;
  /** 'inventory' = full S4 preset; 'external' = own-storage (delivery-only). */
  readonly custody: 'inventory' | 'external';
  /** Injectable fetch for the wallet-api client (the crash drill's kill hook). */
  readonly fetchFn?: FetchLike;
}

export interface HarnessWallet {
  readonly module: PaymentsModule;
  readonly client: WalletApiClient;
  readonly engine: ITokenEngine;
  readonly identity: FullIdentity;
  readonly events: { type: string; data: unknown }[];
  destroy(): void;
}

export async function createHarnessWallet(opts: HarnessWalletOptions): Promise<HarnessWallet> {
  const identity = fullIdentity(opts.identity);
  const trustBaseJson = await fetchTrustbaseJson(opts.stack);
  // The REAL engine over the stack's aggregator via the SDK's real wire client;
  // networkId comes from the trustbase (LOCAL = 3; live testnet2 = 4). In live
  // mode the gateway API key rides along (held by the engine, never logged).
  const engine = await createSphereTokenEngine({
    aggregatorUrl: opts.stack.aggregatorUrl,
    trustBaseJson,
    privateKey: hexToBytes(opts.identity.privateKey),
    ...(opts.stack.aggregatorApiKey ? { apiKey: opts.stack.aggregatorApiKey } : {}),
  });

  const storage = memoryStorage();
  const base: SphereBaseProviders = {
    storage: storage.provider,
    transport: stubTransport(),
    oracle: stubOracle(),
    tokenStorage: localTokenStorage(),
  };
  const config = {
    baseUrl: opts.stack.baseUrl,
    network: opts.stack.network,
    deviceId: opts.deviceId,
    stateStore: storage.kv,
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    verifyToken: async (blob: TokenBlob): Promise<boolean> =>
      (await engine.verify(await engine.decodeToken(blob))).ok,
  };
  const providers =
    opts.custody === 'inventory'
      ? createWalletApiProviders(base, config)
      : createOwnStorageWalletApiProviders(base, config);
  providers.tokenStorage.setIdentity(identity);

  const events: { type: string; data: unknown }[] = [];
  const deps: PaymentsModuleDependencies = {
    identity,
    storage: storage.provider,
    tokenStorageProviders: new Map([[providers.tokenStorage.id, providers.tokenStorage]]),
    transport: base.transport,
    oracle: base.oracle,
    emitEvent: (type, data) => {
      events.push({ type, data });
    },
    tokenEngine: engine,
    delivery: providers.delivery,
    walletApi: providers.walletApi,
  };
  const module = createPaymentsModule({ l1: null });
  module.initialize(deps);

  return {
    module,
    client: providers.walletApi,
    engine,
    identity,
    events,
    destroy: () => {
      module.destroy();
    },
  };
}
