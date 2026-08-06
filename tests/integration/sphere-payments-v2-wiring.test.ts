/**
 * P9 Sphere wiring for the OPT-IN `paymentsV2` init flag
 * (docs/PAYMENTS-V2-DESIGN.md §4/§7/§11 + core/payments-v2-wiring.ts).
 *
 * Flag OFF (default): ZERO behavior change — `paymentsV2` is null and the
 * legacy vertical works exactly as before (the full untouched suite is the
 * broader guarantee; this file spot-checks the lifecycle).
 *
 * Flag ON: the legacy `payments` getter throws the typed error (a stale call
 * site must fail loudly, never drain the mailbox beside the v2 vertical); the
 * facade is composed per address from Sphere-held pieces over the REAL
 * wallet-api-v2 fakes (FakeWalletApi + FakeWalletApiV2Client, the same pair
 * facade.test.ts proves the ports against) injected through the documented
 * `paymentsV2Transport` seam on the `walletApi` object; an address switch is
 * stop-then-start with §7 quiescence; destroy() stops the vertical;
 * setOracleApiKey swaps the engine via facade.setEngine with the old engine
 * disposed; facade events reach `sphere.on` subscribers.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Sphere, type SphereWalletApiSession } from '../../core/Sphere';
import { SphereError } from '../../core/errors';
import { getPublicKey, hexToBytes } from '../../core/crypto';
import { FileStorageProvider } from '../../impl/nodejs/storage/FileStorageProvider';
import { TRUSTBASE_TESTNET2 } from '../../assets/trustbase';
import type { TransportProvider } from '../../transport';
import type { OracleProvider } from '../../oracle';
import type { ProviderStatus } from '../../types';
import type { ITokenEngine } from '../../token-engine';
import type { PaymentsFacade } from '../../modules/payments-v2/PaymentsFacade';
import type {
  PaymentsV2Transport,
  PaymentsV2TransportArgs,
  PaymentsV2WireClient,
} from '../../core/payments-v2-wiring';
import { RealizationEngine, fakeDecodeBlobFor } from '../unit/payments-v2/machine-harness';
import { FakeSession } from '../unit/payments-v2/support';
import { FakeWalletApi, sha256Hex, type FakeCaller } from '../unit/payments-v2/fakes/FakeWalletApi';
import { FakeWalletApiV2Client } from '../unit/payments-v2/fakes/fake-client';

const MNEMONIC = 'test test test test test test test test test test test junk';
const NET = 'testnet2';
const COIN = 'aa'.repeat(32);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function createMockTransport(): TransportProvider {
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
    sendTokenTransfer: vi.fn().mockResolvedValue('transfer-id'),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    sendPaymentRequest: vi.fn().mockResolvedValue('request-id'),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    sendPaymentRequestResponse: vi.fn().mockResolvedValue('response-id'),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    subscribeToBroadcast: vi.fn().mockReturnValue(() => {}),
    publishBroadcast: vi.fn().mockResolvedValue('broadcast-id'),
    onEvent: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn().mockResolvedValue(null),
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
  const walletApi = {
    network,
    setIdentity: () => undefined,
    signIn: async () => undefined,
    logout: async () => undefined,
    paymentsV2Transport: (args: PaymentsV2TransportArgs): PaymentsV2Transport => {
      const session = new FakeSession();
      const caller: FakeCaller = { chainPubkey: args.identity.chainPubkey, network: args.network };
      const client = new FakeWalletApiV2Client(api, caller, { decodeBlob });
      transports.push({ session, client, args });
      return { session, client: gatedClient(client, gates) };
    },
  };
  return {
    realization,
    api,
    transports,
    gates,
    walletApi: walletApi as unknown as SphereWalletApiSession,
  };
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

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup().catch(() => undefined);
  }
}, 30_000);

interface BuildOptions {
  paymentsV2?: boolean;
  walletApi?: SphereWalletApiSession;
  accounting?: boolean;
}

async function buildSphere(options: BuildOptions = {}): Promise<Sphere> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv2-wiring-'));
  const storage = new FileStorageProvider({ dataDir });
  const { sphere } = await Sphere.init({
    storage,
    transport: createMockTransport(),
    oracle: createEngineOracle(),
    mnemonic: MNEMONIC,
    // #728 single-network invariant: the Sphere network must equal walletApi.network.
    network: NET,
    ...(options.walletApi ? { walletApi: options.walletApi } : {}),
    ...(options.paymentsV2 !== undefined ? { paymentsV2: options.paymentsV2 } : {}),
    ...(options.accounting !== undefined ? { accounting: options.accounting } : {}),
  });
  cleanups.push(async () => {
    await sphere.destroy();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return sphere;
}

describe('Sphere paymentsV2 wiring — flag OFF (default)', () => {
  it('paymentsV2 is null and the legacy vertical works unchanged', async () => {
    const sphere = await buildSphere();

    expect(sphere.paymentsV2).toBeNull();
    // Legacy getter serves the (initialized) module — no throw, empty wallet.
    expect(sphere.payments.getBalance()).toEqual([]);
    expect(sphere.payments.getTokens()).toEqual([]);
    expect(sphere.payments.getHistory()).toEqual([]);
    const unsubscribe = sphere.on('transfer:incoming', () => undefined);
    unsubscribe();

    await sphere.destroy();
    expect(sphere.paymentsV2).toBeNull();
  }, 20_000);

  it('a flag explicitly false behaves identically to absent', async () => {
    const world = makeWorld();
    const sphere = await buildSphere({ paymentsV2: false, walletApi: world.walletApi });
    expect(sphere.paymentsV2).toBeNull();
    expect(world.transports).toHaveLength(0); // the v2 seam was never consulted
    expect(() => sphere.payments).not.toThrow();
  }, 20_000);
});

describe('Sphere paymentsV2 wiring — flag ON', () => {
  it('fail-closed at init: no walletApi / accounting+swap combos throw INVALID_CONFIG before any write', async () => {
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

    await expect(Sphere.init({ ...base, paymentsV2: true })).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
    await expect(
      Sphere.init({ ...base, paymentsV2: true, walletApi: makeWorld().walletApi, accounting: true })
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });

    // Both rejections happened BEFORE the wallet record was created.
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
        paymentsV2: true,
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
        paymentsV2: true,
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

  it('payments getter throws the typed error; paymentsV2 is composed, started, and serves the record', async () => {
    const world = makeWorld();
    const sphere = await buildSphere({ paymentsV2: true, walletApi: world.walletApi });

    let caught: unknown;
    try {
      void sphere.payments;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SphereError);
    expect((caught as SphereError).code).toBe('INVALID_CONFIG');
    expect((caught as SphereError).message).toBe(
      'payments (v1) is disabled by paymentsV2 — use sphere.paymentsV2'
    );

    expect(sphere.paymentsV2).not.toBeNull();
    expect(world.transports).toHaveLength(1);
    expect(world.transports[0]!.session.startCalls).toBe(1);
    // The vertical authenticates as the wallet's identity on the wallet-api network.
    expect(world.transports[0]!.args.identity.chainPubkey).toBe(sphere.identity!.chainPubkey);
    expect(world.transports[0]!.args.network).toBe(NET);

    // Server-side inventory reaches tokens() through the wake → delta path.
    const seeded = await seedInventory(world, world.transports[0]!, 40n);
    world.transports[0]!.session.fire('inventory');
    await vi.waitFor(() => {
      expect(sphere.paymentsV2!.tokens().map((t) => t.id)).toContain(seeded.blob.tokenId);
    });
    const assets = await sphere.paymentsV2!.assets(COIN);
    expect(assets[0]?.totalAmount).toBe('40');
  }, 20_000);

  it('facade events reach sphere.on subscribers (the bus is the emit seam)', async () => {
    const world = makeWorld();
    const sphere = await buildSphere({ paymentsV2: true, walletApi: world.walletApi });

    const statuses: unknown[] = [];
    const inventoryPings: unknown[] = [];
    sphere.on('connection:status', (payload) => statuses.push(payload));
    sphere.on('inventory:updated', (payload) => inventoryPings.push(payload));

    // connection:status rides the emitStatus plumbing wired into the session.
    world.transports[0]!.args.emitStatus('degraded');
    expect(statuses).toEqual([{ status: 'degraded' }]);

    // inventory:updated fires when the view applies a server delta.
    await seedInventory(world, world.transports[0]!, 15n);
    world.transports[0]!.session.fire('inventory');
    await vi.waitFor(() => {
      expect(inventoryPings.length).toBeGreaterThan(0);
    });
  }, 20_000);

  it('address switch: the old vertical stops with quiescence (in-flight op settles first), then a FRESH one starts', async () => {
    const world = makeWorld();
    const sphere = await buildSphere({ paymentsV2: true, walletApi: world.walletApi });
    const facade0 = sphere.paymentsV2!;

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
    expect(sphere.paymentsV2).not.toBeNull();
    expect(sphere.paymentsV2).not.toBe(facade0);
    expect(world.transports[1]!.args.identity.chainPubkey).toBe(sphere.identity!.chainPubkey);

    // Switching back composes a THIRD vertical (stop-then-start, never a restart).
    await sphere.switchToAddress(0);
    expect(world.transports).toHaveLength(3);
    expect(world.transports[1]!.session.stopCalls).toBe(1);
    expect(world.transports[2]!.args.identity.chainPubkey).toBe(sphere.identity!.chainPubkey);
    expect(sphere.paymentsV2).not.toBe(facade0);
  }, 30_000);

  it('OVERLAPPING switches serialize: never two running verticals, no orphan left draining', async () => {
    const world = makeWorld();
    const sphere = await buildSphere({ paymentsV2: true, walletApi: world.walletApi });

    // Hold the boot vertical's stop at quiescence while a second switch lands.
    let release!: () => void;
    const opened = new Promise<void>((resolve) => (release = resolve));
    world.gates.listMailbox = async () => opened;
    const receiving = sphere.paymentsV2!.receive();
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
    expect(sphere.paymentsV2).not.toBeNull();
  }, 30_000);

  it('destroy() stops the running vertical and nulls the getter', async () => {
    const world = makeWorld();
    const sphere = await buildSphere({ paymentsV2: true, walletApi: world.walletApi });
    expect(sphere.paymentsV2).not.toBeNull();

    await sphere.destroy();

    expect(world.transports[0]!.session.stopCalls).toBe(1);
    expect(sphere.paymentsV2).toBeNull();
  }, 20_000);

  it('setOracleApiKey rebuilds the engine and swaps it via facade.setEngine; the replaced engine is disposed', async () => {
    const world = makeWorld();
    const sphere = await buildSphere({ paymentsV2: true, walletApi: world.walletApi });
    const facade = sphere.paymentsV2 as PaymentsFacade;
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
