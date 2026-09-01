/* TEMPORARY INVESTIGATION PROBE — delete after running. Not a repo test. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { Sphere } from '../../core/Sphere';
import { SphereError } from '../../core/errors';
import { TokenRegistry } from '../../registry';
import { NETWORKS } from '../../constants';
import { TRUSTBASE_TESTNET2, TRUSTBASE_MAINNET } from '../../assets/trustbase';
import { FileStorageProvider } from '../../impl/nodejs/storage/FileStorageProvider';
import type { TransportProvider } from '../../transport';
import type { OracleProvider } from '../../oracle';
import type { ProviderStatus } from '../../types';
import { makePv2World, seedPv2Inventory, type Pv2World } from '../support/pv2-world';

const M1 = 'test test test test test test test test test test test junk';
const M2 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const COIN_T = 'aa'.repeat(32);
const COIN_M = 'cc'.repeat(32);

const log = (...a: unknown[]): void => { console.log('[PROBE]', ...a); };

function mockTransport(): TransportProvider {
  return {
    id: 'mock-transport', name: 'Mock Transport', type: 'p2p' as const, description: 'm',
    setIdentity: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as ProviderStatus),
    sendMessage: vi.fn().mockResolvedValue('event-id'),
    onMessage: vi.fn().mockReturnValue(() => {}),
    onEvent: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn().mockResolvedValue(null),
    resolveNametag: vi.fn().mockResolvedValue(null),
    publishIdentityBinding: vi.fn().mockResolvedValue(true),
    recoverNametag: vi.fn().mockResolvedValue(null),
  } as unknown as TransportProvider;
}

function mockOracle(net: 'testnet2' | 'mainnet'): OracleProvider {
  return {
    id: `mock-oracle-${net}`, name: 'Mock Oracle', type: 'aggregator' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as ProviderStatus),
    initialize: vi.fn().mockResolvedValue(undefined),
    getTrustBaseJson: () => (net === 'mainnet' ? TRUSTBASE_MAINNET : TRUSTBASE_TESTNET2),
    getAggregatorUrl: () => NETWORKS[net].aggregatorUrl,
    getApiKey: () => 'key',
  } as unknown as OracleProvider;
}

/** fetch spy returning a DIFFERENT one-coin registry per network URL. */
function stubRegistryFetch(): string[] {
  const seen: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input);
    seen.push(url);
    let body: unknown[] = [];
    if (url === NETWORKS.testnet2.tokenRegistryUrl) {
      body = [{ network: 'unicity:testnet2', assetKind: 'fungible', name: 'TestnetCoin',
                symbol: 'TCOIN', decimals: 8, description: 'd', id: COIN_T }];
    } else if (url === NETWORKS.mainnet.tokenRegistryUrl) {
      body = [{ network: 'unicity:mainnet', assetKind: 'fungible', name: 'MainnetCoin',
                symbol: 'MCOIN', decimals: 6, description: 'd', id: COIN_M }];
    }
    return { ok: true, status: 200, statusText: 'OK', json: async () => body,
             text: async () => JSON.stringify(body) } as unknown as Response;
  }));
  return seen;
}

interface Built { sphere: Sphere; world: Pv2World; dir: string; storage: FileStorageProvider; }

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => undefined);
  (Sphere as unknown as { instance: Sphere | null }).instance = null;
  TokenRegistry.destroy();
  vi.unstubAllGlobals();
}, 60_000);

async function build(opts: {
  net: 'testnet2' | 'mainnet'; mnemonic: string; storage?: FileStorageProvider; dir?: string;
}): Promise<Built> {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
  const storage = opts.storage ?? new FileStorageProvider({ dataDir: dir });
  const world = makePv2World(opts.net);
  const { sphere } = await Sphere.init({
    storage, transport: mockTransport(), oracle: mockOracle(opts.net),
    mnemonic: opts.mnemonic, network: opts.net, walletApi: world.walletApi,
  });
  cleanups.push(async () => {
    try { await sphere.destroy(); } catch { /* ignore */ }
    if (!opts.dir) fs.rmSync(dir, { recursive: true, force: true });
  });
  return { sphere, world, dir, storage };
}

function probe<T>(label: string, fn: () => T): void {
  try {
    const v = fn();
    log(`${label} => OK:`, typeof v === 'object' && v !== null ? JSON.stringify(v).slice(0, 240) : String(v));
  } catch (e) {
    const err = e as SphereError;
    log(`${label} => THREW: ${err?.constructor?.name} code=${(err as SphereError).code} msg=${err?.message}`);
  }
}

async function probeA<T>(label: string, fn: () => Promise<T>): Promise<void> {
  try {
    const v = await fn();
    log(`${label} => OK:`, JSON.stringify(v)?.slice(0, 400));
  } catch (e) {
    const err = e as SphereError;
    log(`${label} => THREW: ${err?.constructor?.name} code=${(err as SphereError).code} msg=${err?.message}`);
  }
}

describe('PROBE: two Sphere.init() in one process', () => {

  it('S1+S3+S4+S5: different network, DIFFERENT storage', async () => {
    const fetched = stubRegistryFetch();

    const a = await build({ net: 'testnet2', mnemonic: M1 });
    log('after init#1: Sphere.getInstance()===a.sphere ?', Sphere.getInstance() === a.sphere);
    log('a.identity.chainPubkey', a.sphere.identity?.chainPubkey);
    log('a.networkId', a.sphere.networkId);
    log('a.world.transports.length', a.world.transports.length);

    // Seed testnet inventory so assets() has something to present.
    const seeded = await seedPv2Inventory(a.world, a.world.transports[0]!, COIN_T, 40n);
    a.world.transports[0]!.session.fire('inventory');
    await vi.waitFor(() => {
      expect(a.sphere.payments.tokens().map((t) => t.id)).toContain(seeded.tokenId);
    }, { timeout: 8000 });
    await TokenRegistry.waitForReady(8000);
    const before = await a.sphere.payments.assets(COIN_T);
    log('BEFORE 2nd init — a.assets(COIN_T):', JSON.stringify(before));
    log('BEFORE — registry remoteUrl fetches so far:', JSON.stringify(fetched.filter(u => u.includes('unicity-ids'))));

    // ---- SECOND init, mainnet, DIFFERENT storage ----
    const b = await build({ net: 'mainnet', mnemonic: M2 });
    log('after init#2: Sphere.getInstance()===b.sphere ?', Sphere.getInstance() === b.sphere);
    log('after init#2: Sphere.getInstance()===a.sphere ?', Sphere.getInstance() === a.sphere);
    log('b.identity.chainPubkey', b.sphere.identity?.chainPubkey);
    log('b.networkId', b.sphere.networkId);

    // --- is instance #1 still usable? ---
    probe('a.isReady', () => a.sphere.isReady);
    probe('a.identity', () => a.sphere.identity?.chainPubkey);
    probe('a.payments (getter)', () => (a.sphere.payments ? 'facade present' : 'null'));
    probe('a.payments.tokens()', () => a.sphere.payments.tokens().map((t) => t.id));
    await probeA('a.payments.assets(COIN_T) AFTER 2nd init', () => a.sphere.payments.assets(COIN_T));
    await probeA('a.payments.assets() all AFTER 2nd init', () => a.sphere.payments.assets());
    await probeA('a.payments.history()', () => a.sphere.payments.history({ limit: 5 }));

    // --- S3: registry global state ---
    await TokenRegistry.waitForReady(8000);
    const reg = TokenRegistry.getInstance();
    log('registry.getSymbol(COIN_T) [testnet coin]', reg.getSymbol(COIN_T));
    log('registry.getDecimals(COIN_T)', reg.getDecimals(COIN_T));
    log('registry.getSymbol(COIN_M) [mainnet coin]', reg.getSymbol(COIN_M));
    log('registry.getDecimals(COIN_M)', reg.getDecimals(COIN_M));
    log('registry fetch log:', JSON.stringify(fetched.filter(u => u.includes('unicity-ids'))));

    // --- S5: is instance #1's facade still live? ---
    const seeded2 = await seedPv2Inventory(a.world, a.world.transports[0]!, COIN_T, 7n);
    a.world.transports[0]!.session.fire('inventory');
    let landed = false;
    try {
      await vi.waitFor(() => {
        expect(a.sphere.payments.tokens().map((t) => t.id)).toContain(seeded2.tokenId);
      }, { timeout: 5000 });
      landed = true;
    } catch { landed = false; }
    log('S5: new token reached instance #1 facade after 2nd init?', landed);
    await probeA('a.payments.assets(COIN_T) after 2nd seed', () => a.sphere.payments.assets(COIN_T));

    // --- S4: destroy the SECOND instance ---
    await b.sphere.destroy();
    log('after b.destroy(): Sphere.getInstance() ===', Sphere.getInstance() === null ? 'null' :
        (Sphere.getInstance() === a.sphere ? 'a.sphere' : 'b.sphere'));
    probe('a.isReady after b.destroy', () => a.sphere.isReady);
    probe('a.identity after b.destroy', () => a.sphere.identity?.chainPubkey);
    probe('a.payments.tokens() after b.destroy', () => a.sphere.payments.tokens().length);
    log('a.storage.isConnected()', a.storage.isConnected());
    log('b.storage.isConnected()', b.storage.isConnected());
    await probeA('a.payments.assets() after b.destroy', () => a.sphere.payments.assets());
  }, 90_000);

  it('S2: SHARED storage provider, different network + different mnemonic', async () => {
    stubRegistryFetch();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-shared-'));
    const storage = new FileStorageProvider({ dataDir: dir });

    const a = await build({ net: 'testnet2', mnemonic: M1, storage, dir });
    const pkA = a.sphere.identity!.chainPubkey;
    log('shared: a.chainPubkey', pkA);
    const keysAfter1 = (await storage.keys()).sort();
    log('shared: storage keys after init#1', JSON.stringify(keysAfter1));

    // Second init on the SAME storage, mainnet, DIFFERENT mnemonic M2.
    let b: Built | null = null;
    try {
      b = await build({ net: 'mainnet', mnemonic: M2, storage, dir });
    } catch (e) {
      const err = e as SphereError;
      log(`shared: 2nd init THREW ${err?.constructor?.name} code=${(err as SphereError).code} msg=${err?.message}`);
    }
    if (b) {
      const pkB = b.sphere.identity!.chainPubkey;
      log('shared: b.chainPubkey', pkB);
      log('shared: SAME identity as #1 (i.e. M2 was IGNORED, wallet was LOADED)?', pkA === pkB);
      log('shared: b === a (object identity)?', (b.sphere as unknown) === (a.sphere as unknown));
      log('shared: Sphere.getInstance()===b.sphere ?', Sphere.getInstance() === b.sphere);
      log('shared: b.networkId', b.sphere.networkId);
      const keysAfter2 = (await storage.keys()).sort();
      log('shared: storage keys after init#2', JSON.stringify(keysAfter2));
      log('shared: keys ADDED by init#2', JSON.stringify(keysAfter2.filter(k => !keysAfter1.includes(k))));
      log('shared: keys REMOVED by init#2', JSON.stringify(keysAfter1.filter(k => !keysAfter2.includes(k))));
      probe('shared: a.isReady', () => a.sphere.isReady);
      probe('shared: a.identity', () => a.sphere.identity?.chainPubkey);
      probe('shared: a.payments.tokens()', () => a.sphere.payments.tokens().length);
      log('shared: a.world.transports.length', a.world.transports.length,
          'b.world.transports.length', b.world.transports.length);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }, 90_000);

  it('S6: Sphere.import() on a SECOND storage while instance #1 is live', async () => {
    stubRegistryFetch();
    const a = await build({ net: 'testnet2', mnemonic: M1 });
    const pkA = a.sphere.identity!.chainPubkey;
    const keysA1 = (await a.storage.keys()).sort();
    log('import: a.chainPubkey', pkA, 'a keys count', keysA1.length);
    log('import: Sphere.getInstance()===a.sphere ?', Sphere.getInstance() === a.sphere);

    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-imp-'));
    const storageB = new FileStorageProvider({ dataDir: dirB });
    const worldB = makePv2World('mainnet');
    let imported: Sphere | null = null;
    try {
      imported = await Sphere.import({
        storage: storageB, transport: mockTransport(), oracle: mockOracle('mainnet'),
        mnemonic: M2, network: 'mainnet', walletApi: worldB.walletApi,
      });
      log('import: OK, imported.chainPubkey', imported.identity?.chainPubkey);
    } catch (e) {
      const err = e as SphereError;
      log(`import: THREW ${err?.constructor?.name} code=${(err as SphereError).code} msg=${err?.message}`);
    }
    probe('import: a.isReady AFTER Sphere.import(storageB)', () => a.sphere.isReady);
    probe('import: a.identity AFTER', () => a.sphere.identity?.chainPubkey);
    probe('import: a.payments AFTER', () => a.sphere.payments.tokens().length);
    log('import: a.storage.isConnected()', a.storage.isConnected());
    let keysA2: string[] = [];
    try { keysA2 = (await a.storage.keys()).sort(); } catch (e) { log('import: a.storage.keys() threw', String(e)); }
    log('import: a storage keys AFTER import on OTHER storage:', keysA2.length, JSON.stringify(keysA2).slice(0, 300));
    log('import: a mnemonic file still on disk?', fs.existsSync(a.dir) ? fs.readdirSync(a.dir).join(',') : 'DIR GONE');
    if (imported) { try { await imported.destroy(); } catch { /* ignore */ } }
    fs.rmSync(dirB, { recursive: true, force: true });
  }, 90_000);
});
