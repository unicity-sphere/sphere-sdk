/**
 * P11 Sphere wiring — the payments vertical is DEFAULT AND ONLY
 * (docs/PAYMENTS-V2-DESIGN.md §4/§7/§11 + core/payments-v2-wiring.ts).
 *
 * Defaults: `sphere.payments` IS the §4 facade; `sphere.payments` is the
 * deprecated alias serving the SAME facade; init is fail-closed without a
 * `walletApi` transport config; the retired `accounting`/`swap` options throw
 * typed INVALID_CONFIG (the one sanctioned refusal fossil); `paymentsV2` is a
 * tolerated no-op for one release. The facade is composed per address from
 * Sphere-held pieces over the REAL wallet-api-v2 fakes injected through the
 * documented `paymentsV2Transport` seam; an address switch is stop-then-start
 * with §7 quiescence; destroy() stops the vertical; setOracleApiKey swaps the
 * engine via facade.setEngine with the old engine disposed; facade events
 * reach `sphere.on` subscribers.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Sphere } from '../../core/Sphere';
import { SphereError } from '../../core/errors';
import { getPublicKey, hexToBytes } from '../../core/crypto';
import { decryptDeliveryBundle, deriveDeliveryEncryptionKey } from '../../core/delivery-envelope';
import { FileStorageProvider } from '../../impl/nodejs/storage/FileStorageProvider';
import { TRUSTBASE_TESTNET2 } from '../../assets/trustbase';
import { STORAGE_KEYS_GLOBAL } from '../../constants';
import { TokenRegistry } from '../../registry';
import type { PeerInfo, TransportProvider } from '../../transport';
import type { OracleProvider } from '../../oracle';
import type { ProviderStatus } from '../../types';
import type { ITokenEngine } from '../../token-engine';
import type { PaymentsFacade } from '../../modules/payments-v2/PaymentsFacade';
import type {
  PaymentsV2Transport,
  PaymentsV2TransportArgs,
  PaymentsV2WireClient,
  WalletApiTransportConfig,
} from '../../core/payments-v2-wiring';
import { RealizationEngine, fakeDecodeBlobFor } from '../unit/payments-v2/machine-harness';
import { FakeSession } from '../unit/payments-v2/support';
import { FakeWalletApi, sha256Hex, type FakeCaller } from '../unit/payments-v2/fakes/FakeWalletApi';
import { FakeWalletApiV2Client } from '../unit/payments-v2/fakes/fake-client';

const MNEMONIC = 'test test test test test test test test test test test junk';
const NET = 'testnet2' as const;
const COIN = 'aa'.repeat(32);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function createMockTransport(peers: Record<string, PeerInfo> = {}): TransportProvider {
  return {
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p' as const,
    description: 'Mock transport',
    setIdentity: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as ProviderStatus),
    sendMessage: vi.fn().mockResolvedValue('event-id'),
    onMessage: vi.fn().mockReturnValue(() => {}),
    subscribeToBroadcast: vi.fn().mockReturnValue(() => {}),
    publishBroadcast: vi.fn().mockResolvedValue('broadcast-id'),
    onEvent: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn(async (identifier: string) => peers[identifier] ?? null),
    resolveNametag: vi.fn().mockResolvedValue(null),
    publishIdentityBinding: vi.fn().mockResolvedValue(true),
    recoverNametag: vi.fn().mockResolvedValue(null),
  } as unknown as TransportProvider;
}

/** Oracle stub with a REAL testnet2 trust base so Sphere builds a REAL engine offline. */
function createEngineOracle(): OracleProvider {
  let apiKey = 'key-1';
  return {
    id: 'mock-oracle',
    name: 'Mock Oracle',
    type: 'aggregator' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as ProviderStatus),
    initialize: vi.fn().mockResolvedValue(undefined),
    getTrustBaseJson: () => TRUSTBASE_TESTNET2,
    getAggregatorUrl: () => 'https://gateway.testnet2.unicity.network',
    getApiKey: () => apiKey,
    setApiKey: (key: string) => {
      apiKey = key;
    },
  } as unknown as OracleProvider;
}

interface Gates {
  listMailbox?: () => Promise<void>;
}

function gatedClient(inner: FakeWalletApiV2Client, gates: Gates): PaymentsV2WireClient {
  return {
    listInventory: (since) => inner.listInventory(since),
    blobUrls: (ids) => inner.blobUrls(ids),
    uploadUrls: (blobs) => inner.uploadUrls(blobs),
    apply: (delta) => inner.apply(delta),
    fetchBlob: (url) => inner.fetchBlob(url),
    uploadBlob: (url, bytes) => inner.uploadBlob(url, bytes),
    putIntent: (t, p, r) => inner.putIntent(t, p, r),
    listIntents: (status) => inner.listIntents(status),
    abortIntent: (t) => inner.abortIntent(t),
    completeIntent: (t, s) => inner.completeIntent(t, s),
    postProgress: (t, o, p, s) => inner.postProgress(t, o, p, s),
    getProgress: (t) => inner.getProgress(t),
    deposit: (entry) => inner.deposit(entry),
    depositBatch: (entries) => inner.depositBatch(entries),
    listMailbox: async (since) => {
      if (gates.listMailbox) await gates.listMailbox();
      return inner.listMailbox(since);
    },
    claim: (ids, into) => inner.claim(ids, into),
    reject: (ids, reason, detail) => inner.reject(ids, reason, detail),
    postHistory: (records) => inner.postHistory(records),
    listHistory: (options) => inner.listHistory(options),
    createPaymentRequest: (input) => inner.createPaymentRequest(input),
    listPaymentRequests: (params) => inner.listPaymentRequests(params),
    respondPaymentRequest: (id, response) => inner.respondPaymentRequest(id, response),
  };
}

interface TransportRecord {
  session: FakeSession;
  client: FakeWalletApiV2Client;
  args: PaymentsV2TransportArgs;
}

/** One in-process wallet-api world + the documented `paymentsV2Transport` seam. */
function makeWorld(network: string = NET) {
  const realization = new RealizationEngine({ chainPubkey: hexToBytes(getPublicKey('11'.repeat(32))) });
  const decodeBlob = fakeDecodeBlobFor(realization);
  const api = new FakeWalletApi({ decodeBlob });
  const transports: TransportRecord[] = [];
  const gates: Gates = {};
  const walletApi: WalletApiTransportConfig = {
    network,
    paymentsV2Transport: (args: PaymentsV2TransportArgs): PaymentsV2Transport => {
      const session = new FakeSession();
      // As WalletApiSession does: ONE transition writes the status cell and feeds the bus.
      session.emitStatus = args.emitStatus;
      const caller: FakeCaller = { chainPubkey: args.identity.chainPubkey, network: args.network };
      const client = new FakeWalletApiV2Client(api, caller, { decodeBlob });
      transports.push({ session, client, args });
      return { session, client: gatedClient(client, gates) };
    },
  };
  return { realization, api, transports, gates, walletApi };
}

type World = ReturnType<typeof makeWorld>;

async function seedInventory(world: World, record: TransportRecord, amount: bigint) {
  const token = await world.realization.mint({
    recipientPubkey: hexToBytes(record.args.identity.chainPubkey),
    value: { assets: [{ coinId: COIN, amount }] },
  });
  const bytes = token.blob.token;
  const sha = sha256Hex(bytes);
  await record.client.uploadBlob(`fake://put/${sha}`, bytes);
  await record.client.apply({
    transferId: `seed-${token.blob.tokenId}`,
    spent: [],
    added: [{ tokenId: token.blob.tokenId, key: sha }],
  });
  return token;
}

const PEER_PRIV = '22'.repeat(32);
const PEER_PUB = getPublicKey(PEER_PRIV);

/** A resolved Nostr identity binding; `network` omitted = the binding declares none. */
function peerBinding(overrides: Partial<PeerInfo> = {}): PeerInfo {
  return {
    transportPubkey: PEER_PUB.slice(2),
    chainPubkey: PEER_PUB,
    directAddress: 'DIRECT://peer',
    timestamp: 0,
    ...overrides,
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup().catch(() => undefined);
  }
}, 30_000);

interface BuildOptions {
  walletApi: WalletApiTransportConfig;
  peers?: Record<string, PeerInfo>;
  nametag?: string;
}

async function buildSphere(options: BuildOptions): Promise<Sphere> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv2-wiring-'));
  const storage = new FileStorageProvider({ dataDir });
  const { sphere } = await Sphere.init({
    storage,
    transport: createMockTransport(options.peers),
    oracle: createEngineOracle(),
    mnemonic: MNEMONIC,
    // #728 single-network invariant: the Sphere network must equal walletApi.network.
    network: NET,
    walletApi: options.walletApi,
    ...(options.nametag !== undefined ? { nametag: options.nametag } : {}),
  });
  cleanups.push(async () => {
    await sphere.destroy();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return sphere;
}

describe('Sphere payments wiring — the token registry is OWNED, not the process global', () => {
  // #766: the global's configure() is repointed by every other Sphere's init, which is how
  // a mainnet init silently flipped a live testnet2 wallet's decimals to 0. A Sphere must
  // build and hold its own, and must stop it on destroy — nothing in registry/ calls
  // unref(), so a surviving interval outlives the wallet and keeps Node's loop alive.
  it('builds its own registry on init and disposes it on destroy', async () => {
    const create = vi.spyOn(TokenRegistry, 'create');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv2-registry-'));
    const storage = new FileStorageProvider({ dataDir });
    try {
      const { sphere } = await Sphere.init({
        storage,
        transport: createMockTransport(),
        oracle: createEngineOracle(),
        mnemonic: MNEMONIC,
        network: NET,
        walletApi: makeWorld().walletApi,
      });

      expect(create).toHaveBeenCalledTimes(1);
      const owned = create.mock.results[0]!.value as TokenRegistry;
      // It is a real instance, and NOT the process global.
      expect(owned).not.toBe(TokenRegistry.getInstance());
      expect(owned.isDisposed).toBe(false);

      await sphere.destroy();
      expect(owned.isDisposed).toBe(true);
      // The global is deliberately left running — other code still reads it.
      expect(TokenRegistry.getInstance().isDisposed).toBe(false);
    } finally {
      create.mockRestore();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('never builds a registry when init rejects BEFORE provider bring-up', async () => {
    const create = vi.spyOn(TokenRegistry, 'create');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv2-registry-early-'));
    const storage = new FileStorageProvider({ dataDir });
    try {
      await expect(
        Sphere.import({
          storage,
          transport: createMockTransport(),
          oracle: createEngineOracle(),
          mnemonic: 'clearly not a valid bip39 mnemonic phrase at all',
          network: NET,
          walletApi: makeWorld().walletApi,
        })
      ).rejects.toMatchObject({ code: 'INVALID_IDENTITY' });

      // Built late, so a rejection this early never creates one at all.
      expect(create).not.toHaveBeenCalled();
    } finally {
      create.mockRestore();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('disposes the registry when provider bring-up itself rejects', async () => {
    // The case the previous test CANNOT reach: the registry is built, and then init
    // fails. Without cleanup it is stranded — the caller never receives a Sphere, so
    // nothing can ever destroy it, and its hourly fetch runs for the life of the process.
    const create = vi.spyOn(TokenRegistry, 'create');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv2-registry-late-'));
    const storage = new FileStorageProvider({ dataDir });
    const transport = createMockTransport();
    (transport as unknown as { connect: ReturnType<typeof vi.fn> }).connect = vi
      .fn()
      .mockRejectedValue(new Error('transport refused to connect'));
    (transport as unknown as { isConnected: ReturnType<typeof vi.fn> }).isConnected = vi
      .fn()
      .mockReturnValue(false);
    try {
      await expect(
        Sphere.init({
          storage,
          transport,
          oracle: createEngineOracle(),
          mnemonic: MNEMONIC,
          network: NET,
          walletApi: makeWorld().walletApi,
        })
      ).rejects.toThrow();

      expect(create).toHaveBeenCalledTimes(1);
      const stranded = create.mock.results[0]!.value as TokenRegistry;
      expect(stranded.isDisposed).toBe(true);
    } finally {
      create.mockRestore();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('disposes the registry when MODULE bring-up rejects, not just provider bring-up', async () => {
    // Guarding only initializeProviders was not enough: initializeModules runs after it and
    // is fallible too. An oracle that connects but exposes no trust base makes
    // buildTokenEngine return undefined, and startPaymentsV2Inner then throws INVALID_CONFIG
    // — past the provider guard, with the registry already built.
    const create = vi.spyOn(TokenRegistry, 'create');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv2-registry-modules-'));
    const storage = new FileStorageProvider({ dataDir });
    const oracle = createEngineOracle();
    (oracle as unknown as { getTrustBaseJson: () => unknown }).getTrustBaseJson = () => null;
    try {
      await expect(
        Sphere.init({
          storage,
          transport: createMockTransport(),
          oracle,
          mnemonic: MNEMONIC,
          network: NET,
          walletApi: makeWorld().walletApi,
        })
      ).rejects.toThrow();

      expect(create).toHaveBeenCalledTimes(1);
      expect((create.mock.results[0]!.value as TokenRegistry).isDisposed).toBe(true);
    } finally {
      create.mockRestore();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('disposes the registry when a step AFTER module bring-up rejects', async () => {
    // The guard now covers everything up to publication, not a named subset of steps.
    // Twice I widened it one step and the next step along was still unguarded; this pins
    // the far end — a failure at 'finalizing', after providers AND modules are up, still
    // happens before the Sphere is published, so the caller gets nothing to destroy.
    const create = vi.spyOn(TokenRegistry, 'create');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv2-registry-late2-'));
    const storage = new FileStorageProvider({ dataDir });
    try {
      await expect(
        Sphere.init({
          storage,
          transport: createMockTransport(),
          oracle: createEngineOracle(),
          mnemonic: MNEMONIC,
          network: NET,
          walletApi: makeWorld().walletApi,
          onProgress: (p: { step: string }) => {
            if (p.step === 'finalizing') throw new Error('progress callback exploded');
          },
        })
      ).rejects.toThrow();

      expect(create).toHaveBeenCalledTimes(1);
      expect((create.mock.results[0]!.value as TokenRegistry).isDisposed).toBe(true);
    } finally {
      create.mockRestore();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('disposes the registry when the LAST init step rejects, after publication would have been', async () => {
    // Publication used to happen mid-init, and the guard ended there on the premise that a
    // published Sphere is still recoverable by the caller. It is not: publication only
    // records the Sphere in the private per-storage registry clear()/import() tear down
    // (#766) — there is no lookup API at all — so the guard runs to the end and publication
    // is the last thing before the return. 'complete' is the final progress step in
    // create(), so a throw here is past every other fallible operation.
    const create = vi.spyOn(TokenRegistry, 'create');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv2-registry-last-'));
    const storage = new FileStorageProvider({ dataDir });
    const transport = createMockTransport();
    try {
      await expect(
        Sphere.init({
          storage,
          transport,
          oracle: createEngineOracle(),
          mnemonic: MNEMONIC,
          network: NET,
          walletApi: makeWorld().walletApi,
          onProgress: (p: { step: string }) => {
            if (p.step === 'complete') throw new Error('progress callback exploded at the end');
          },
        })
      ).rejects.toThrow();

      expect(create).toHaveBeenCalledTimes(1);
      expect((create.mock.results[0]!.value as TokenRegistry).isDisposed).toBe(true);
      // The failed init published nothing, so no half-built Sphere is reachable by anyone.
      // Precisely because nothing is reachable, the failure path must tear the whole
      // Sphere down itself — providers are connected and the vertical is running by now,
      // and disposing only the registry would strand all of it with no owner.
      expect(transport.disconnect).toHaveBeenCalled();
      expect(storage.isConnected()).toBe(false);
    } finally {
      create.mockRestore();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('destroy() keeps disconnecting after one teardown step rejects', async () => {
    // The steps are independent resources. A transport disconnect that rejects must not
    // skip storage and oracle — that is how a partial teardown failure leaves connections
    // open, which is exactly the state the failed-init path calls destroy() in.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv2-teardown-partial-'));
    const storage = new FileStorageProvider({ dataDir });
    const transport = createMockTransport();
    const oracle = createEngineOracle();
    try {
      const { sphere } = await Sphere.init({
        storage,
        transport,
        oracle,
        mnemonic: MNEMONIC,
        network: NET,
        walletApi: makeWorld().walletApi,
      });

      vi.spyOn(transport, 'disconnect').mockRejectedValue(new Error('transport refused'));
      const oracleDisconnect = vi.spyOn(oracle, 'disconnect');

      await sphere.destroy().catch(() => undefined);

      // The two steps AFTER the failing one still ran.
      expect(storage.isConnected()).toBe(false);
      expect(oracleDisconnect).toHaveBeenCalled();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('destroy() disposes the registry even when teardown throws', async () => {
    const create = vi.spyOn(TokenRegistry, 'create');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv2-registry-throw-'));
    const storage = new FileStorageProvider({ dataDir });
    const transport = createMockTransport();
    try {
      const { sphere } = await Sphere.init({
        storage,
        transport,
        oracle: createEngineOracle(),
        mnemonic: MNEMONIC,
        network: NET,
        walletApi: makeWorld().walletApi,
      });
      const owned = create.mock.results[0]!.value as TokenRegistry;

      // Teardown below the disposal point propagates (the transport mux disconnect has
      // no catch), so disposal must not sit behind it.
      vi.spyOn(transport, 'disconnect').mockRejectedValue(new Error('teardown exploded'));

      await sphere.destroy().catch(() => undefined);
      expect(owned.isDisposed).toBe(true);
    } finally {
      create.mockRestore();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('Sphere payments wiring — defaults (P11 flip: the vertical is default and only)', () => {
  it('composing the vertical sweeps the superseded pv2: state left by a 2.x wallet', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv2-sweep-'));
    const storage = new FileStorageProvider({ dataDir });
    // What a wallet upgraded across the wire break still has on disk. The epoch
    // latch is the dangerous one: surviving, it makes a backend reset look like a
    // server restore and re-PUTs these dead intents into the fresh backend.
    await storage.set(`pv2:${NET}:stale-pubkey:intents`, '["a 2.x open intent"]');
    await storage.set(`pv2:${NET}:stale-pubkey:epoch-latch`, '"epoch-7"');

    const { sphere } = await Sphere.init({
      storage,
      transport: createMockTransport(),
      oracle: createEngineOracle(),
      mnemonic: MNEMONIC,
      network: NET,
      walletApi: makeWorld().walletApi,
    });
    cleanups.push(async () => {
      await sphere.destroy();
      fs.rmSync(dataDir, { recursive: true, force: true });
    });

    await vi.waitFor(async () => {
      expect(await storage.get(`pv2:${NET}:stale-pubkey:intents`)).toBeNull();
      expect(await storage.get(`pv2:${NET}:stale-pubkey:epoch-latch`)).toBeNull();
    });
    // The wallet itself survives the sweep — this is not Sphere.clear().
    expect(sphere.identity!.chainPubkey).toBeTruthy();
  });

  it('fail-closed at init: missing walletApi / retired accounting / retired swap throw INVALID_CONFIG before any write', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv2-failclosed-'));
    cleanups.push(async () => fs.rmSync(dataDir, { recursive: true, force: true }));
    const storage = new FileStorageProvider({ dataDir });
    const base = {
      storage,
      transport: createMockTransport(),
      oracle: createEngineOracle(),
      mnemonic: MNEMONIC,
      network: NET,
    };

    await expect(Sphere.init({ ...base })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    // The ONE sanctioned refusal fossil: retired module flags refuse loudly.
    await expect(
      Sphere.init({ ...base, walletApi: makeWorld().walletApi, accounting: true })
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(
      Sphere.init({ ...base, walletApi: makeWorld().walletApi, swap: true })
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });

    // All rejections happened BEFORE the wallet record was created.
    expect(await Sphere.exists(storage)).toBe(false);
  }, 20_000);

  it('#728 single-network: walletApi.network ≠ Sphere network → INVALID_CONFIG naming both, before any wallet write or transport construction', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv2-xnet-'));
    cleanups.push(async () => fs.rmSync(dataDir, { recursive: true, force: true }));
    const storage = new FileStorageProvider({ dataDir });
    const world = makeWorld('testnet'); // wallet-api on testnet, Sphere on testnet2

    let caught: unknown;
    try {
      await Sphere.init({
        storage,
        transport: createMockTransport(),
        oracle: createEngineOracle(),
        mnemonic: MNEMONIC,
        network: NET,
        walletApi: world.walletApi,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SphereError);
    expect((caught as SphereError).code).toBe('INVALID_CONFIG');
    // The error names BOTH networks.
    expect((caught as SphereError).message).toContain('"testnet"');
    expect((caught as SphereError).message).toContain('"testnet2"');
    // Rejected BEFORE any wallet write and BEFORE any session/KV/provider was built.
    expect(await Sphere.exists(storage)).toBe(false);
    expect(world.transports).toHaveLength(0);
  }, 20_000);

  it('#728 single-network: an unknown walletApi.network string → INVALID_CONFIG, zero fake-server construction', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv2-unknownnet-'));
    cleanups.push(async () => fs.rmSync(dataDir, { recursive: true, force: true }));
    const storage = new FileStorageProvider({ dataDir });
    const world = makeWorld('betanet');

    let caught: unknown;
    try {
      await Sphere.init({
        storage,
        transport: createMockTransport(),
        oracle: createEngineOracle(),
        mnemonic: MNEMONIC,
        network: NET,
        walletApi: world.walletApi,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SphereError);
    expect((caught as SphereError).code).toBe('INVALID_CONFIG');
    expect((caught as SphereError).message).toContain('"betanet"');
    expect(await Sphere.exists(storage)).toBe(false);
    expect(world.transports).toHaveLength(0);
  }, 20_000);

  it('sphere.payments IS the facade; sphere.payments is the deprecated alias to the SAME facade', async () => {
    const world = makeWorld();
    const sphere = await buildSphere({ walletApi: world.walletApi });

    expect(sphere.payments).toBeDefined();
    expect(sphere.payments).toBe(sphere.payments);
    expect(world.transports).toHaveLength(1);
    expect(world.transports[0]!.session.startCalls).toBe(1);
    // The vertical authenticates as the wallet's identity on the wallet-api network.
    expect(world.transports[0]!.args.identity.chainPubkey).toBe(sphere.identity!.chainPubkey);
    expect(world.transports[0]!.args.network).toBe(NET);

    // Server-side inventory reaches tokens() through the wake → delta path.
    const seeded = await seedInventory(world, world.transports[0]!, 40n);
    world.transports[0]!.session.fire('inventory');
    await vi.waitFor(() => {
      expect(sphere.payments.tokens().map((t) => t.id)).toContain(seeded.blob.tokenId);
    });
    const assets = await sphere.payments.assets(COIN);
    expect(assets[0]?.totalAmount).toBe('40');
  }, 20_000);

  // #733: proves composePaymentsV2 wires the resolver that reports the PEER's
  // network — a session stamp anywhere on this path makes the §5.6 guard dead.
  it('#733 cross-network guard on the composed path: a peer declaring another network is refused, one declaring none is signalled', async () => {
    const world = makeWorld();
    const sphere = await buildSphere({
      walletApi: world.walletApi,
      peers: { '@mars': peerBinding({ network: 'mars' }), '@ghost': peerBinding() },
    });
    await seedInventory(world, world.transports[0]!, 40n);
    world.transports[0]!.session.fire('inventory');
    await vi.waitFor(() => {
      expect(sphere.payments.tokens()).toHaveLength(1);
    });
    const attention: unknown[] = [];
    sphere.on('transfer:attention', (payload) => attention.push(payload));

    await expect(
      sphere.payments.send({ recipient: '@mars', amount: '10', coinId: COIN })
    ).rejects.toMatchObject({ code: 'INVALID_RECIPIENT' });
    expect(attention).toEqual([]);

    // A binding declaring nothing is every wallet in the fleet today: signalled, not
    // refused — the send gets PAST the guard (and then dies materializing this world's
    // fake-minted blob against the REAL engine, which is not the guard's business).
    const outcome = await sphere.payments
      .send({ recipient: '@ghost', amount: '10', coinId: COIN })
      .catch((err: unknown) => err);
    expect((outcome as SphereError).code).not.toBe('INVALID_RECIPIENT');
    expect(attention).toEqual([
      {
        transferId: '',
        code: 'recipient:network-unverified',
        detail: expect.stringContaining('@ghost') as unknown,
      },
    ]);
  }, 20_000);

  // sphere#487: the whole chain Sphere → PaymentsV2Host.nametag → composePaymentsV2
  // → facade was unguarded — deleting any link restores "Someone" on the
  // recipient's screen with every unit suite still green (they all inject their
  // own getter). Asserted on the request rail because it needs no chain op, but
  // it is the SAME `ownNametag` seam the delivery envelope now rides.
  it('#487 the wallet Unicity ID reaches the composed vertical and rides the S6 envelope', async () => {
    const world = makeWorld();
    const sphere = await buildSphere({
      walletApi: world.walletApi,
      peers: { '@peer': peerBinding({ network: NET }) },
      nametag: 'alice',
    });
    expect(sphere.identity?.nametag).toBe('alice');

    const created = await sphere.payments.requests.create('@peer', {
      coinId: COIN,
      amount: '10',
      memo: 'pay me',
    });
    expect(created.success).toBe(true);

    const peerCaller: FakeCaller = { chainPubkey: PEER_PUB, network: NET };
    const [wire] = (await world.api.listRequests(peerCaller, { role: 'incoming' })).requests;
    const bundle = decryptDeliveryBundle(
      deriveDeliveryEncryptionKey(PEER_PRIV, sphere.identity!.chainPubkey),
      wire?.memo ?? ''
    );
    expect(bundle).toEqual({ senderNametag: 'alice', memo: 'pay me' });
  }, 20_000);

  it('the retired `paymentsV2` alias and init flag are gone from the public surface', async () => {
    const world = makeWorld();
    const sphere = await buildSphere({ walletApi: world.walletApi });
    expect('paymentsV2' in sphere).toBe(false);
    // The flag is no longer declared, so a stale caller reaches init through a cast.
    // It must stay INERT — unlike accounting/swap it never meant anything.
    const stale = makeWorld();
    const withFlag = await buildSphere({
      walletApi: stale.walletApi,
      ...({ paymentsV2: true } as Record<string, unknown>),
    });
    expect(withFlag.payments).toBeTruthy();
    expect(stale.transports).toHaveLength(1);
  }, 30_000);

  it('facade events reach sphere.on subscribers (the bus is the emit seam)', async () => {
    const world = makeWorld();
    const sphere = await buildSphere({ walletApi: world.walletApi });

    const statuses: unknown[] = [];
    const inventoryPings: unknown[] = [];
    sphere.on('connection:status', (payload) => statuses.push(payload));
    sphere.on('inventory:updated', (payload) => inventoryPings.push(payload));

    // connection:status rides the emitStatus plumbing wired into the session,
    // and sphere.payments.connectionStatus() reads that same value (sphere#473).
    world.transports[0]!.session.setStatus('degraded');
    expect(statuses).toEqual([{ status: 'degraded' }]);
    expect(sphere.payments.connectionStatus()).toBe('degraded');

    // inventory:updated fires when the view applies a server delta.
    await seedInventory(world, world.transports[0]!, 15n);
    world.transports[0]!.session.fire('inventory');
    await vi.waitFor(() => {
      expect(inventoryPings.length).toBeGreaterThan(0);
    });
  }, 20_000);

  it('address switch: the old vertical stops with quiescence (in-flight op settles first), then a FRESH one starts', async () => {
    const world = makeWorld();
    const sphere = await buildSphere({ walletApi: world.walletApi });
    const facade0 = sphere.payments;

    // Hold an in-flight drain open across the switch.
    let gateEntered = false;
    let release!: () => void;
    const opened = new Promise<void>((resolve) => (release = resolve));
    world.gates.listMailbox = async () => {
      gateEntered = true;
      await opened;
    };
    const order: string[] = [];
    const receiving = facade0.receive().then((r) => {
      order.push('receive-settled');
      return r;
    });
    await vi.waitFor(() => {
      expect(gateEntered).toBe(true);
    });

    const switching = sphere.switchToAddress(1).then(() => order.push('switched'));
    await sleep(200);
    // The switch is HELD at stop() quiescence: no second vertical composed yet.
    expect(order).toEqual([]);
    expect(world.transports).toHaveLength(1);

    delete world.gates.listMailbox;
    release();
    const { transfers } = await receiving;
    expect(transfers).toEqual([]);
    await switching;
    expect(order).toEqual(['receive-settled', 'switched']);

    // Fresh vertical for address 1; the old one is stopped and discarded.
    expect(world.transports).toHaveLength(2);
    expect(world.transports[0]!.session.stopCalls).toBe(1);
    expect(world.transports[1]!.session.startCalls).toBe(1);
    expect(sphere.payments).not.toBe(facade0);
    expect(world.transports[1]!.args.identity.chainPubkey).toBe(sphere.identity!.chainPubkey);

    // Switching back composes a THIRD vertical (stop-then-start, never a restart).
    await sphere.switchToAddress(0);
    expect(world.transports).toHaveLength(3);
    expect(world.transports[1]!.session.stopCalls).toBe(1);
    expect(world.transports[2]!.args.identity.chainPubkey).toBe(sphere.identity!.chainPubkey);
    expect(sphere.payments).not.toBe(facade0);
  }, 30_000);

  it('OVERLAPPING switches serialize: never two running verticals, no orphan left draining', async () => {
    const world = makeWorld();
    const sphere = await buildSphere({ walletApi: world.walletApi });

    // Hold the boot vertical's stop at quiescence while a second switch lands.
    let release!: () => void;
    const opened = new Promise<void>((resolve) => (release = resolve));
    world.gates.listMailbox = async () => opened;
    const receiving = sphere.payments.receive();
    const first = sphere.switchToAddress(1);
    const second = sphere.switchToAddress(2);
    await sleep(300);
    delete world.gates.listMailbox;
    release();
    await receiving;
    await Promise.all([first, second]);

    // §7 invariant under overlap: exactly ONE vertical is left running.
    expect(world.transports).toHaveLength(3);
    const running = world.transports.filter(
      (t) => t.session.startCalls === 1 && t.session.stopCalls === 0
    );
    expect(running).toHaveLength(1);
    expect(world.transports.filter((t) => t.session.stopCalls === 1)).toHaveLength(2);
    expect(sphere.payments).not.toBeNull();
  }, 30_000);

  it('destroy() stops the running vertical and payments then refuses with NOT_INITIALIZED', async () => {
    const world = makeWorld();
    const sphere = await buildSphere({ walletApi: world.walletApi });
    expect(sphere.payments).toBeTruthy();

    await sphere.destroy();

    expect(world.transports[0]!.session.stopCalls).toBe(1);
    // Refusing beats the alias's old `null`: a caller cannot accidentally treat a
    // destroyed wallet as merely empty.
    let caught: unknown;
    try {
      void sphere.payments;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SphereError);
    expect((caught as SphereError).code).toBe('NOT_INITIALIZED');
  }, 20_000);

  it('destroy() racing an unawaited switchToAddress leaves nothing running', async () => {
    // #770: switchToAddress calls ensureReady() ONCE at entry and then awaits ~8 times, and
    // `_initialized` is cleared LAST by destroy() — so every one of those hops is a window in
    // which a concurrent teardown is invisible. The switch's stop/start pair is queued on the
    // §7 mutex, so destroy()'s own stop is ordered AFTER it: without a destroyed latch the
    // pair's start composes a whole new vertical (wallet-api session, wake socket, stream
    // pulls, receive poll) for an owner whose destroy() has already RESOLVED, and nothing is
    // left that could ever stop it.
    const world = makeWorld();
    const sphere = await buildSphere({ walletApi: world.walletApi });
    const transport = (sphere as unknown as { _transport: TransportProvider })._transport;
    const setIdentity = transport.setIdentity as unknown as ReturnType<typeof vi.fn>;

    // Hold the boot vertical's stop at quiescence so the switch parks INSIDE its stop/start
    // pair — the exact window destroy() has to land in.
    let release!: () => void;
    const opened = new Promise<void>((resolve) => (release = resolve));
    world.gates.listMailbox = async () => opened;
    const receiving = sphere.payments.receive();

    // UNAWAITED: the caller's switch is still in flight when the owner tears the wallet down.
    const switching = sphere.switchToAddress(1).then(
      () => 'resolved' as const,
      (err: unknown) => err
    );
    await sleep(200);
    expect(world.transports).toHaveLength(1);

    const identityCallsBeforeDestroy = setIdentity.mock.calls.length;
    const storage = (sphere as unknown as { _storage: FileStorageProvider })._storage;
    const indexBeforeDestroy = await storage.get(STORAGE_KEYS_GLOBAL.CURRENT_ADDRESS_INDEX);
    const destroying = sphere.destroy();
    await sleep(50);
    delete world.gates.listMailbox;
    release();
    await receiving.catch(() => undefined);
    await destroying;
    const outcome = await switching;
    // Give anything the switch might still have queued a chance to actually run.
    await sleep(200);

    // The invariant: after destroy() resolves, NO vertical is left started-but-not-stopped.
    expect(
      world.transports.filter((t) => t.session.startCalls === 1 && t.session.stopCalls === 0)
    ).toHaveLength(0);
    // Stronger: the switch never composed a second vertical at all.
    expect(world.transports).toHaveLength(1);
    expect(world.transports[0]!.session.stopCalls).toBe(1);

    // The switch refused instead of re-arming the transport (the vector the §7 mutex cannot
    // cover — it is not a lifecycle op).
    expect(outcome).toBeInstanceOf(SphereError);
    expect((outcome as SphereError).code).toBe('NOT_INITIALIZED');
    expect(setIdentity.mock.calls.length).toBe(identityCallsBeforeDestroy);
    expect((sphere as unknown as { _transportMux: unknown })._transportMux).toBeNull();
    // A refused switch must not leave its index on disk: persisting it would send the NEXT
    // boot to an address the user never finished moving to.
    expect(await storage.get(STORAGE_KEYS_GLOBAL.CURRENT_ADDRESS_INDEX)).toBe(indexBeforeDestroy);

    let caught: unknown;
    try {
      void sphere.payments;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SphereError);
    expect((caught as SphereError).code).toBe('NOT_INITIALIZED');
  }, 30_000);

  it('destroy() racing a switch parked BEFORE module bring-up never rebuilds the module set', async () => {
    // The other half of #770, and the one the §7 mutex provably cannot reach: a switch parked
    // on an await that is NOT a lifecycle op. initializeAddressModules → ensureTransportMux
    // BUILDS and connect()s a fresh MultiAddressTransportMux whenever `_transportMux` is null
    // — which is exactly the state destroy() leaves behind — so an unguarded resume opens new
    // sockets and refills the per-address module map that destroy() just cleared.
    const world = makeWorld();
    const sphere = await buildSphere({ walletApi: world.walletApi });
    const transport = (sphere as unknown as { _transport: TransportProvider })._transport;
    const modules = (sphere as unknown as { _addressModules: Map<number, unknown> })._addressModules;

    // Park at the nametag availability probe — the hop immediately BEFORE module bring-up.
    let release!: () => void;
    const opened = new Promise<void>((resolve) => (release = resolve));
    (transport as unknown as { resolveNametag: () => Promise<null> }).resolveNametag = async () => {
      await opened;
      return null;
    };

    // The bring-up must not be ENTERED, not merely undone. The guard after it discards
    // whatever it built, so asserting only the end state cannot tell the two apart —
    // and that is precisely what let this guard's mutation probe survive a full run.
    const internals = sphere as unknown as {
      buildTokenEngine: (identity: unknown) => Promise<ITokenEngine>;
    };
    const realBuild = internals.buildTokenEngine.bind(sphere);
    const buildSpy = vi.fn(realBuild);
    internals.buildTokenEngine = buildSpy;

    const switching = sphere.switchToAddress(1, { nametag: 'zed' }).then(
      () => 'resolved' as const,
      (err: unknown) => err
    );
    await sleep(200);

    await sphere.destroy();
    expect(modules.size).toBe(0);

    release();
    const outcome = await switching;
    await sleep(200);

    // THE invariant: after destroy() resolved, nothing is left started-but-not-stopped. This
    // ordering is the one that leaves a PERMANENT orphan when unguarded — destroy()'s stop
    // has already run, so the switch's start has no stop behind it, ever.
    expect(
      world.transports.filter((t) => t.session.startCalls === 1 && t.session.stopCalls === 0)
    ).toHaveLength(0);
    expect(world.transports).toHaveLength(1);
    // Nothing rebuilt: no module set, no mux — and nothing was built to be undone.
    expect(modules.size).toBe(0);
    expect(buildSpy).not.toHaveBeenCalled();
    expect((sphere as unknown as { _transportMux: unknown })._transportMux).toBeNull();
    expect(outcome).toBeInstanceOf(SphereError);
    expect((outcome as SphereError).code).toBe('NOT_INITIALIZED');
  }, 30_000);

  it('destroy() landing INSIDE module bring-up discards what the bring-up built', async () => {
    // The guards in switchToAddress are checks BEFORE an await. This is the gap they
    // cannot close on their own: destroy() lands while initializeAddressModules is
    // itself awaiting, its teardown loop empties _addressModules, and the continuation
    // then registers a fully-built set — its own token engine, and so its own worker
    // pool — on a Sphere whose destroy() has already returned. Nothing would ever
    // dispose it, and nothing holds a reference through which it could be found.
    const world = makeWorld();
    const sphere = await buildSphere({ walletApi: world.walletApi });
    const modules = (sphere as unknown as { _addressModules: Map<number, unknown> })._addressModules;

    // Park INSIDE the bring-up, on the engine build — past ensureTransportMux, before
    // the module set is registered.
    let release!: () => void;
    const opened = new Promise<void>((resolve) => (release = resolve));
    const internals = sphere as unknown as {
      buildTokenEngine: (identity: unknown) => Promise<ITokenEngine>;
    };
    const realBuild = internals.buildTokenEngine.bind(sphere);
    const built: ITokenEngine[] = [];
    internals.buildTokenEngine = async (identity: unknown): Promise<ITokenEngine> => {
      await opened;
      const engine = await realBuild(identity);
      engine.dispose = vi.fn();
      built.push(engine);
      return engine;
    };

    const switching = sphere.switchToAddress(1).then(
      () => 'resolved' as const,
      (err: unknown) => err
    );
    await sleep(200);

    await sphere.destroy();
    expect(modules.size).toBe(0);

    release();
    const outcome = await switching;
    await sleep(200);

    // The set the continuation built is gone again, and its engine — the one destroy()
    // could not have disposed, because it did not exist yet — was disposed here.
    expect(modules.size).toBe(0);
    expect(built).toHaveLength(1);
    expect(built[0]!.dispose).toHaveBeenCalledTimes(1);
    expect((sphere as unknown as { _transportMux: unknown })._transportMux).toBeNull();
    expect(outcome).toBeInstanceOf(SphereError);
    expect((outcome as SphereError).code).toBe('NOT_INITIALIZED');
  }, 30_000);

  it('setOracleApiKey rebuilds the engine and swaps it via facade.setEngine; the replaced engine is disposed', async () => {
    const world = makeWorld();
    const sphere = await buildSphere({ walletApi: world.walletApi });
    const facade = sphere.payments as PaymentsFacade;
    const setEngineSpy = vi.spyOn(facade, 'setEngine');

    const before = (sphere as unknown as { _tokenEngine?: ITokenEngine })._tokenEngine;
    expect(before).toBeDefined();
    const disposed = vi.fn();
    before!.dispose = disposed;

    await sphere.setOracleApiKey('key-2');

    const after = (sphere as unknown as { _tokenEngine?: ITokenEngine })._tokenEngine;
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    expect(setEngineSpy).toHaveBeenCalledTimes(1);
    expect(setEngineSpy).toHaveBeenCalledWith(after);
    expect(disposed).toHaveBeenCalledTimes(1);
  }, 20_000);
});
