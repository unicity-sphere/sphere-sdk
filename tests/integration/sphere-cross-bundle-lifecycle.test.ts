/**
 * #766, one boundary further out: the lifecycle registry must be PROCESS-wide.
 *
 * `Sphere._liveByStorage` and `Sphere._clearGenerations` decide who `clear()` may
 * destroy and which init is standing on a store that was emptied under it. tsup builds
 * every subpath export as its own bundle with `splitting: false` (tsup.shared.js), so
 * a static on the class is per-BUNDLE: a Sphere created through `@unicitylabs/sphere-sdk`
 * was invisible to a `clear()` called through `@unicitylabs/sphere-sdk/core`, which then
 * wiped the KV and left that Sphere `isReady` over nothing — the exact bug the scoped
 * registry fixed, resurrected across the entry points. The ESM and CJS outputs duplicate
 * the same way.
 *
 * `vi.resetModules()` + two dynamic imports gives a genuinely separate module instance
 * (asserted below) sharing one globalThis, which is exactly the two-bundle shape. It is
 * NOT a second REALM: an iframe or a worker has its own globalThis and cannot be joined
 * by any in-process mechanism, and nothing here claims to cover that.
 *
 * The object-key half is load-bearing for the same reason and cannot be split off: with
 * a shared registry and a per-copy counter, the first `backingStoreId`-less provider of
 * EACH copy is `object:1`, so two unrelated wallets land in one bucket and one wallet's
 * clear() destroys the other's Sphere. The last test is that case.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileStorageProvider } from '../../impl/nodejs/storage/FileStorageProvider';
import type { StorageProvider } from '../../storage';
import type { TransportProvider } from '../../transport';
import type { FullIdentity, ProviderStatus, TrackedAddressEntry } from '../../types';
import { makePv2World, createEngineOracle } from '../support/pv2-world';

type SphereModule = typeof import('../../core/Sphere');
type SphereInstance = Awaited<ReturnType<SphereModule['Sphere']['init']>>['sphere'];

const NET = 'testnet2' as const;
const MNEMONIC_A = 'test test test test test test test test test test test junk';
const MNEMONIC_B =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

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

/** A provider that declares no `backingStoreId`, so liveness falls back to object keys. */
class MemoryStorage implements StorageProvider {
  readonly id = 'memory';
  readonly name = 'Memory Storage';
  readonly type = 'local' as const;
  private connected = false;

  private identity: FullIdentity | null = null;

  constructor(private readonly cells: Map<string, string>) {}

  setIdentity(identity: FullIdentity): void { this.identity = identity; }
  getIdentity(): FullIdentity | null { return this.identity; }
  async connect(): Promise<void> { this.connected = true; }
  async disconnect(): Promise<void> { this.connected = false; }
  isConnected(): boolean { return this.connected; }
  getStatus(): ProviderStatus { return this.connected ? 'connected' : 'disconnected'; }
  async get(key: string): Promise<string | null> { return this.cells.get(key) ?? null; }
  async set(key: string, value: string): Promise<void> { this.cells.set(key, value); }
  async remove(key: string): Promise<void> { this.cells.delete(key); }
  async has(key: string): Promise<boolean> { return this.cells.has(key); }
  async keys(): Promise<string[]> { return Array.from(this.cells.keys()); }
  async clear(): Promise<void> { this.cells.clear(); }
  async saveTrackedAddresses(entries: TrackedAddressEntry[]): Promise<void> {
    this.cells.set('__tracked_addresses', JSON.stringify(entries));
  }
  async loadTrackedAddresses(): Promise<TrackedAddressEntry[]> {
    const raw = this.cells.get('__tracked_addresses');
    return raw ? (JSON.parse(raw) as TrackedAddressEntry[]) : [];
  }
}

const dataDirs: string[] = [];
const spheres: SphereInstance[] = [];

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sphere-xbundle-${label}-`));
  dataDirs.push(dir);
  return dir;
}

interface InitArgs {
  storage: StorageProvider;
  transport?: TransportProvider;
  mnemonic?: string;
}

async function initThrough(mod: SphereModule, args: InitArgs): Promise<SphereInstance> {
  const { sphere } = await mod.Sphere.init({
    storage: args.storage,
    transport: args.transport ?? createMockTransport(),
    oracle: createEngineOracle(),
    walletApi: makePv2World(NET).walletApi,
    network: NET,
    mnemonic: args.mnemonic,
  });
  spheres.push(sphere);
  return sphere;
}

/** A second module instance of core/Sphere — one bundle's copy, not one shared class. */
async function freshCopy(): Promise<SphereModule> {
  vi.resetModules();
  return import('../../core/Sphere');
}

describe('the Sphere lifecycle registry spans entry points (#766)', () => {
  let copyA: SphereModule;
  let copyB: SphereModule;

  beforeEach(async () => {
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
    copyA = await freshCopy();
    copyB = await freshCopy();
    expect(copyA.Sphere, 'two genuinely separate module instances').not.toBe(copyB.Sphere);
  });

  afterEach(async () => {
    for (const sphere of spheres.splice(0)) {
      try { await sphere.destroy(); } catch { /* the test already tore it down */ }
    }
    for (const dir of dataDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('destroys a Sphere built through one copy when the OTHER copy clears its store', async () => {
    const dataDir = tempDir('cleared');
    const sphere = await initThrough(copyA, { storage: new FileStorageProvider({ dataDir }), mnemonic: MNEMONIC_A });
    expect(sphere.isReady).toBe(true);

    // The consumer's second entry point: its own provider object over the same wallet.json.
    await copyB.Sphere.clear({ storage: new FileStorageProvider({ dataDir }) });

    expect(sphere.isReady, 'left ready over a KV that no longer exists').toBe(false);
    expect(() => sphere.payments, 'a stopped vertical must throw, not serve').toThrow();
  });

  it('leaves a Sphere on an unrelated store alone when the other copy clears', async () => {
    const kept = tempDir('kept');
    const wiped = tempDir('wiped');
    const sphere = await initThrough(copyA, { storage: new FileStorageProvider({ dataDir: kept }), mnemonic: MNEMONIC_A });

    await copyB.Sphere.clear({ storage: new FileStorageProvider({ dataDir: wiped }) });

    expect(sphere.isReady, 'scoping must survive the merge, not collapse into one bucket').toBe(true);
    expect(() => sphere.payments).not.toThrow();
  });

  it('refuses a publication from one copy over a store the other copy cleared', async () => {
    const dataDir = tempDir('generation');
    const transport = createMockTransport();
    // Park the init inside its bring-up: keys on disk, nothing published yet, so the
    // clear cannot see it to destroy it and the generation is the only signal left.
    let release!: () => void;
    const parked = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const atGate = new Promise<void>((resolve) => { reached = resolve; });
    (transport.publishIdentityBinding as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => { reached(); await parked; return true; },
    );

    const init = initThrough(copyA, { storage: new FileStorageProvider({ dataDir }), transport, mnemonic: MNEMONIC_A });
    await atGate;

    await copyB.Sphere.clear({ storage: new FileStorageProvider({ dataDir }) });
    release();

    await expect(init).rejects.toThrow(/cleared while this wallet was initializing/);
    expect(transport.disconnect, 'the refused Sphere is torn down, not leaked').toHaveBeenCalled();
  });

  it('does not collide two undeclared stores on one object key across copies', async () => {
    // No `backingStoreId`, so each provider gets a minted key. Per-copy minting hands
    // BOTH of these `object:1`, and the shared registry then files two unrelated
    // wallets in one bucket — one clear() destroying a wallet it never touched.
    const kept: StorageProvider = new MemoryStorage(new Map());
    const wiped: StorageProvider = new MemoryStorage(new Map());
    expect(kept.backingStoreId).toBeUndefined();

    const sphere = await initThrough(copyA, { storage: kept, mnemonic: MNEMONIC_A });
    await initThrough(copyB, { storage: wiped, mnemonic: MNEMONIC_B });

    await copyB.Sphere.clear({ storage: wiped });

    expect(sphere.isReady, 'a different store, a different wallet, untouched').toBe(true);
    expect(() => sphere.payments).not.toThrow();
  });
});
