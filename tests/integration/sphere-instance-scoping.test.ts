/**
 * #766 — Sphere lifecycle statics are storage-scoped.
 *
 * `Sphere.clear()` and `Sphere.import()` tear down the live Spheres registered against
 * the StorageProvider they were HANDED, and nothing else. The process-global
 * `Sphere.instance` they used to consult held whichever Sphere was constructed LAST, so
 * clearing wallet B silently destroyed a live, unrelated wallet A: its payments vertical
 * stopped, its providers disconnected and every `sphere.on()` handler was dropped, with
 * no event and no error for the owner of A to observe.
 *
 * Construction order is load-bearing in these tests: B's Sphere is built FIRST and A's
 * LAST, so A is exactly the instance the old static pointed at. Both directions are
 * pinned — clearing an unrelated storage must NOT destroy A (tests 1 and 2), and
 * clearing A's OWN storage still MUST (test 3). Scoping that forgot the second half
 * would leave a Sphere alive on a KV that was just emptied under it.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Sphere } from '../../core/Sphere';
import { FileStorageProvider } from '../../impl/nodejs/storage/FileStorageProvider';
import type { TransportProvider } from '../../transport';
import type { OracleProvider } from '../../oracle';
import type { ProviderStatus } from '../../types';
import { makePv2World, createEngineOracle, type Pv2World } from '../support/pv2-world';

const NET = 'testnet2' as const;

const MNEMONIC_A = 'test test test test test test test test test test test junk';
const MNEMONIC_B =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const MNEMONIC_C =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

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
    subscribeToBroadcast: vi.fn().mockReturnValue(() => {}),
    publishBroadcast: vi.fn().mockResolvedValue('broadcast-id'),
    onEvent: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn().mockResolvedValue(null),
    resolveNametag: vi.fn().mockResolvedValue(null),
    publishIdentityBinding: vi.fn().mockResolvedValue(true),
    recoverNametag: vi.fn().mockResolvedValue(null),
  } as unknown as TransportProvider;
}

/** One wallet's worth of independent providers — its own dataDir, storage, transport. */
interface Wallet {
  dataDir: string;
  storage: FileStorageProvider;
  transport: TransportProvider;
  oracle: OracleProvider;
  world: Pv2World;
  sphere?: Sphere;
}

const wallets: Wallet[] = [];

function makeWallet(label: string): Wallet {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `sphere-scope-${label}-`));
  const wallet: Wallet = {
    dataDir,
    storage: new FileStorageProvider({ dataDir }),
    transport: createMockTransport(),
    oracle: createEngineOracle(),
    world: makePv2World(NET),
  };
  wallets.push(wallet);
  return wallet;
}

async function initWallet(wallet: Wallet, mnemonic: string): Promise<Sphere> {
  const { sphere } = await Sphere.init({
    storage: wallet.storage,
    transport: wallet.transport,
    oracle: wallet.oracle,
    walletApi: wallet.world.walletApi,
    network: NET,
    mnemonic,
  });
  wallet.sphere = sphere;
  return sphere;
}

describe('Sphere lifecycle statics are scoped to the storage they are handed (#766)', () => {
  beforeEach(() => {
    // The registry's remote refresh must not reach the network from an integration test.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => [],
        text: async () => '[]',
      } as unknown as Response)),
    );
  });

  afterEach(async () => {
    for (const wallet of wallets.splice(0)) {
      try {
        await wallet.sphere?.destroy();
      } catch { /* already torn down by the test */ }
      fs.rmSync(wallet.dataDir, { recursive: true, force: true });
    }
    vi.unstubAllGlobals();
  });

  it('clear() on another storage leaves a live Sphere on a different one fully alive', async () => {
    // B first, A last: A is the instance the deleted process-global static held.
    const b = makeWallet('b');
    await initWallet(b, MNEMONIC_B);
    const a = makeWallet('a');
    const sphereA = await initWallet(a, MNEMONIC_A);

    const chainPubkeyBefore = sphereA.identity!.chainPubkey;
    // Registered BEFORE the clear — destroy() drops every handler, so a handler that
    // still fires afterwards is proof A's event bus was never torn down.
    const activated: unknown[] = [];
    sphereA.on('address:activated', (data) => activated.push(data));

    await Sphere.clear({ storage: b.storage });

    // A is untouched: still initialized, still holding its identity...
    expect(sphereA.isReady).toBe(true);
    expect(sphereA.identity).not.toBeNull();
    expect(sphereA.identity!.chainPubkey).toBe(chainPubkeyBefore);
    // ...still able to hand out the payments vertical (the getter THROWS once stopped)...
    expect(() => sphereA.payments).not.toThrow();
    expect(a.transport.disconnect).not.toHaveBeenCalled();
    expect(a.storage.isConnected()).toBe(true);

    // ...and its handlers still fire.
    await sphereA.switchToAddress(1);
    expect(activated).toHaveLength(1);
    expect((activated[0] as { address: { index: number } }).address.index).toBe(1);

    // Sanity, so "A survived" can never be read as "clear() did nothing": B is the
    // wallet that WAS cleared, and its Sphere is gone.
    expect(b.sphere!.isReady).toBe(false);
  });

  it('import() onto another storage leaves a live Sphere on a different one fully alive', async () => {
    // Same ordering: A is built last, so the old static pointed at it.
    const b = makeWallet('b');
    await initWallet(b, MNEMONIC_B);
    const a = makeWallet('a');
    const sphereA = await initWallet(a, MNEMONIC_A);

    const chainPubkeyBefore = sphereA.identity!.chainPubkey;
    const activated: unknown[] = [];
    sphereA.on('address:activated', (data) => activated.push(data));

    // import() clears storage B first — via the same storage-scoped teardown.
    const imported = await Sphere.import({
      storage: b.storage,
      transport: b.transport,
      oracle: b.oracle,
      walletApi: b.world.walletApi,
      network: NET,
      mnemonic: MNEMONIC_C,
    });
    b.sphere = imported;

    // Sanity: the import really happened and really replaced B's wallet.
    expect(imported.isReady).toBe(true);
    expect(imported.identity!.chainPubkey).not.toBe(chainPubkeyBefore);

    expect(sphereA.isReady).toBe(true);
    expect(sphereA.identity).not.toBeNull();
    expect(sphereA.identity!.chainPubkey).toBe(chainPubkeyBefore);
    expect(() => sphereA.payments).not.toThrow();
    expect(a.transport.disconnect).not.toHaveBeenCalled();
    expect(a.storage.isConnected()).toBe(true);

    await sphereA.switchToAddress(1);
    expect(activated).toHaveLength(1);
  });

  it('clear() on a Sphere OWN storage still destroys it — scoped, not abandoned', async () => {
    const b = makeWallet('b');
    await initWallet(b, MNEMONIC_B);
    const a = makeWallet('a');
    const sphereA = await initWallet(a, MNEMONIC_A);

    await Sphere.clear({ storage: a.storage });

    // A owned that KV, so leaving it running over emptied storage is not an option.
    expect(sphereA.isReady).toBe(false);
    expect(sphereA.identity).toBeNull();
    expect(() => sphereA.payments).toThrow();
    expect(a.transport.disconnect).toHaveBeenCalled();

    // ...and B, which was NOT cleared, is still alive.
    expect(b.sphere!.isReady).toBe(true);
    expect(() => b.sphere!.payments).not.toThrow();
  });
});
