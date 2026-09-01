/* TEMPORARY INVESTIGATION PROBE #2 — delete after running. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { Sphere } from '../../core/Sphere';
import type { SphereError } from '../../core/errors';
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
const log = (...a: unknown[]): void => { console.log('[PROBE2]', ...a); };

function mockTransport(): TransportProvider {
  return {
    id: 'mt', name: 'Mock Transport', type: 'p2p' as const, description: 'm',
    setIdentity: vi.fn(), connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined), isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as ProviderStatus),
    sendMessage: vi.fn().mockResolvedValue('e'), onMessage: vi.fn().mockReturnValue(() => {}),
    onEvent: vi.fn().mockReturnValue(() => {}), resolve: vi.fn().mockResolvedValue(null),
    resolveNametag: vi.fn().mockResolvedValue(null),
    publishIdentityBinding: vi.fn().mockResolvedValue(true),
    recoverNametag: vi.fn().mockResolvedValue(null),
  } as unknown as TransportProvider;
}
function mockOracle(net: 'testnet2' | 'mainnet'): OracleProvider {
  return {
    id: `mo-${net}`, name: 'Mock Oracle', type: 'aggregator' as const,
    connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as ProviderStatus),
    initialize: vi.fn().mockResolvedValue(undefined),
    getTrustBaseJson: () => (net === 'mainnet' ? TRUSTBASE_MAINNET : TRUSTBASE_TESTNET2),
    getAggregatorUrl: () => NETWORKS[net].aggregatorUrl,
    getApiKey: () => 'key', setApiKey: vi.fn(),
  } as unknown as OracleProvider;
}
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

async function build(o: { net: 'testnet2' | 'mainnet'; mnemonic: string; storage?: FileStorageProvider; dir?: string }): Promise<Built> {
  const dir = o.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'p2-'));
  const storage = o.storage ?? new FileStorageProvider({ dataDir: dir });
  const world = makePv2World(o.net);
  const { sphere } = await Sphere.init({
    storage, transport: mockTransport(), oracle: mockOracle(o.net),
    mnemonic: o.mnemonic, network: o.net, walletApi: world.walletApi,
  });
  cleanups.push(async () => {
    try { await sphere.destroy(); } catch { /* ignore */ }
    if (!o.dir) fs.rmSync(dir, { recursive: true, force: true });
  });
  return { sphere, world, dir, storage };
}
function probe<T>(label: string, fn: () => T): void {
  try { const v = fn(); log(`${label} => OK:`, typeof v === 'object' && v !== null ? JSON.stringify(v).slice(0, 260) : String(v)); }
  catch (e) { const err = e as SphereError; log(`${label} => THREW ${err?.constructor?.name} code=${err?.code} msg=${err?.message}`); }
}
async function probeA<T>(label: string, fn: () => Promise<T>): Promise<void> {
  try { const v = await fn(); log(`${label} => OK:`, JSON.stringify(v)?.slice(0, 300)); }
  catch (e) { const err = e as SphereError; log(`${label} => THREW ${err?.constructor?.name} code=${err?.code} msg=${err?.message}`); }
}
const symDec = (label: string): void => {
  const r = TokenRegistry.getInstance();
  log(`${label}: COIN_T -> ${r.getSymbol(COIN_T)}/${r.getDecimals(COIN_T)}   COIN_M -> ${r.getSymbol(COIN_M)}/${r.getDecimals(COIN_M)}`);
};

describe('PROBE2', () => {

  it('S7: Sphere.clear({storage: B}) while instance A is live on storage A', async () => {
    stubRegistryFetch();
    const a = await build({ net: 'testnet2', mnemonic: M1 });
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-clearB-'));
    const storageB = new FileStorageProvider({ dataDir: dirB });
    log('S7: before clear — a.isReady', a.sphere.isReady, 'instance===a?', Sphere.getInstance() === a.sphere);
    await Sphere.clear({ storage: storageB });
    probe('S7: a.isReady AFTER Sphere.clear(storageB)', () => a.sphere.isReady);
    probe('S7: a.identity AFTER', () => a.sphere.identity);
    probe('S7: a.payments AFTER', () => a.sphere.payments.tokens().length);
    log('S7: a.storage.isConnected()', a.storage.isConnected());
    log('S7: Sphere.getInstance() after clear ===', Sphere.getInstance() === null ? 'null' : 'something');
    log('S7: storage A files on disk', fs.readdirSync(a.dir).join(','));
    fs.rmSync(dirB, { recursive: true, force: true });
  }, 60_000);

  it('S8: does ANYTHING on instance A restore its registry? (switchToAddress / setOracleApiKey / a 3rd init)', async () => {
    stubRegistryFetch();
    const a = await build({ net: 'testnet2', mnemonic: M1 });
    await TokenRegistry.waitForReady(8000);
    symDec('S8 after init#1');
    const b = await build({ net: 'mainnet', mnemonic: M2 });
    await TokenRegistry.waitForReady(8000);
    symDec('S8 after init#2 (mainnet)');

    await a.sphere.switchToAddress(1);
    await new Promise((r) => setTimeout(r, 150));
    symDec('S8 after a.switchToAddress(1)');
    await a.sphere.setOracleApiKey('key-2');
    await new Promise((r) => setTimeout(r, 150));
    symDec('S8 after a.setOracleApiKey()');

    // Only an explicit re-configure flips it back — and that breaks B symmetrically.
    TokenRegistry.configure({ remoteUrl: NETWORKS.testnet2.tokenRegistryUrl, storage: a.storage });
    await TokenRegistry.waitForReady(8000);
    symDec('S8 after manual re-configure(testnet2)');
    await probeA('S8: b.payments.assets() with registry flipped back to testnet2', () => b.sphere.payments.assets());
  }, 90_000);

  it('S9: SHARED storage — two live instances and the non-network-scoped keys', async () => {
    stubRegistryFetch();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-shared-'));
    const storage = new FileStorageProvider({ dataDir: dir });
    const a = await build({ net: 'testnet2', mnemonic: M1, storage, dir });
    const b = await build({ net: 'mainnet', mnemonic: M2, storage, dir });
    log('S9: a.addr', a.sphere.identity?.chainPubkey?.slice(0, 12), 'b.addr', b.sphere.identity?.chainPubkey?.slice(0, 12));
    log('S9: a tracked', JSON.stringify(a.sphere.getActiveAddresses().map((t) => t.index)));
    log('S9: b tracked', JSON.stringify(b.sphere.getActiveAddresses().map((t) => t.index)));

    await a.sphere.switchToAddress(1);
    await new Promise((r) => setTimeout(r, 200));
    log('S9: after a.switchToAddress(1) — a index', a.sphere.getActiveAddresses().map((t) => t.index),
        'a identity', a.sphere.identity?.chainPubkey?.slice(0, 12));
    log('S9: b index (in-memory, unchanged?)', b.sphere.getActiveAddresses().map((t) => t.index),
        'b identity', b.sphere.identity?.chainPubkey?.slice(0, 12));
    const raw = await storage.get('tracked_addresses');
    log('S9: tracked_addresses ON DISK (shared key):', String(raw).slice(0, 400));

    // Now B writes its own view of tracked addresses.
    await b.sphere.switchToAddress(2);
    await new Promise((r) => setTimeout(r, 200));
    const raw2 = await storage.get('tracked_addresses');
    log('S9: tracked_addresses ON DISK after b.switchToAddress(2):', String(raw2).slice(0, 400));
    log('S9: a in-memory index after B wrote:', a.sphere.getActiveAddresses().map((t) => t.index));

    // Do the two verticals see each other's KV?
    const keys = (await storage.keys()).filter((k) => k.startsWith('pv2g2:')).sort();
    log('S9: pv2g2 keys:', JSON.stringify(keys));
    fs.rmSync(dir, { recursive: true, force: true });
  }, 90_000);

  it('S10: CONCURRENT Promise.all([init(testnet2), init(mainnet)]) — which registry wins?', async () => {
    const fetched = stubRegistryFetch();
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-cA-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-cB-'));
    const sA = new FileStorageProvider({ dataDir: dirA });
    const sB = new FileStorageProvider({ dataDir: dirB });
    const wA = makePv2World('testnet2');
    const wB = makePv2World('mainnet');
    const [ra, rb] = await Promise.all([
      Sphere.init({ storage: sA, transport: mockTransport(), oracle: mockOracle('testnet2'),
        mnemonic: M1, network: 'testnet2', walletApi: wA.walletApi }),
      Sphere.init({ storage: sB, transport: mockTransport(), oracle: mockOracle('mainnet'),
        mnemonic: M2, network: 'mainnet', walletApi: wB.walletApi }),
    ]);
    log('S10: A networkId', ra.sphere.networkId, 'B networkId', rb.sphere.networkId);
    log('S10: Sphere.getInstance() is', Sphere.getInstance() === ra.sphere ? 'A' : Sphere.getInstance() === rb.sphere ? 'B' : 'other/null');
    await TokenRegistry.waitForReady(8000);
    symDec('S10 registry after concurrent init');
    log('S10: fetch order', JSON.stringify(fetched.filter((u) => u.includes('unicity-ids'))));
    const cached = await sA.get(`token_registry_cache:${NETWORKS.testnet2.tokenRegistryUrl}`);
    log('S10: testnet2 cache present in storage A?', cached !== null,
        'in storage B?', (await sB.get(`token_registry_cache:${NETWORKS.testnet2.tokenRegistryUrl}`)) !== null);
    const cachedM = await sA.get(`token_registry_cache:${NETWORKS.mainnet.tokenRegistryUrl}`);
    log('S10: mainnet cache present in storage A?', cachedM !== null,
        'in storage B?', (await sB.get(`token_registry_cache:${NETWORKS.mainnet.tokenRegistryUrl}`)) !== null);
    try { await ra.sphere.destroy(); } catch { /* ignore */ }
    try { await rb.sphere.destroy(); } catch { /* ignore */ }
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }, 90_000);

  it('S11: cross-instance token cross-talk — does A hold B tokens / does the engine leak?', async () => {
    stubRegistryFetch();
    const a = await build({ net: 'testnet2', mnemonic: M1 });
    const b = await build({ net: 'mainnet', mnemonic: M2 });
    const sa = await seedPv2Inventory(a.world, a.world.transports[0]!, COIN_T, 40n);
    const sb = await seedPv2Inventory(b.world, b.world.transports[0]!, COIN_M, 11n);
    a.world.transports[0]!.session.fire('inventory');
    b.world.transports[0]!.session.fire('inventory');
    await vi.waitFor(() => {
      expect(a.sphere.payments.tokens().length).toBeGreaterThan(0);
      expect(b.sphere.payments.tokens().length).toBeGreaterThan(0);
    }, { timeout: 8000 });
    log('S11: a tokens', JSON.stringify(a.sphere.payments.tokens().map((t) => t.id)), 'seeded', sa.tokenId);
    log('S11: b tokens', JSON.stringify(b.sphere.payments.tokens().map((t) => t.id)), 'seeded', sb.tokenId);
    await probeA('S11: a.assets()', () => a.sphere.payments.assets());
    await probeA('S11: b.assets()', () => b.sphere.payments.assets());
    log('S11: a.networkId', a.sphere.networkId, 'b.networkId', b.sphere.networkId);
    log('S11: same engine object?', (a.sphere as unknown as { _tokenEngine: unknown })._tokenEngine ===
        (b.sphere as unknown as { _tokenEngine: unknown })._tokenEngine);
  }, 90_000);
});
