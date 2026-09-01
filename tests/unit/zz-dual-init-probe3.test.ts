/* TEMPORARY INVESTIGATION PROBE #3 — delete after running. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { Sphere } from '../../core/Sphere';
import { TokenRegistry } from '../../registry';
import { NETWORKS } from '../../constants';
import { TRUSTBASE_TESTNET2, TRUSTBASE_MAINNET } from '../../assets/trustbase';
import { FileStorageProvider } from '../../impl/nodejs/storage/FileStorageProvider';
import type { TransportProvider } from '../../transport';
import type { OracleProvider } from '../../oracle';
import type { ProviderStatus } from '../../types';
import { makePv2World, seedPv2Inventory, type Pv2World } from '../support/pv2-world';

const M1 = 'test test test test test test test test test test test junk';
const COIN_T = 'aa'.repeat(32);
const COIN_M = 'cc'.repeat(32);
const log = (...a: unknown[]): void => { console.log('[PROBE3]', ...a); };

function mockTransport(): TransportProvider {
  return { id: 'mt', name: 'MT', type: 'p2p' as const, description: 'm',
    setIdentity: vi.fn(), connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined), isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as ProviderStatus),
    sendMessage: vi.fn().mockResolvedValue('e'), onMessage: vi.fn().mockReturnValue(() => {}),
    onEvent: vi.fn().mockReturnValue(() => {}), resolve: vi.fn().mockResolvedValue(null),
    resolveNametag: vi.fn().mockResolvedValue(null),
    publishIdentityBinding: vi.fn().mockResolvedValue(true),
    recoverNametag: vi.fn().mockResolvedValue(null) } as unknown as TransportProvider;
}
function mockOracle(net: 'testnet2' | 'mainnet'): OracleProvider {
  return { id: `mo-${net}`, name: 'MO', type: 'aggregator' as const,
    connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as ProviderStatus),
    initialize: vi.fn().mockResolvedValue(undefined),
    getTrustBaseJson: () => (net === 'mainnet' ? TRUSTBASE_MAINNET : TRUSTBASE_TESTNET2),
    getAggregatorUrl: () => NETWORKS[net].aggregatorUrl,
    getApiKey: () => 'key', setApiKey: vi.fn() } as unknown as OracleProvider;
}
function stubRegistryFetch(): string[] {
  const seen: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input);
    seen.push(url);
    let body: unknown[] = [];
    if (url === NETWORKS.testnet2.tokenRegistryUrl)
      body = [{ network: 'unicity:testnet2', assetKind: 'fungible', name: 'TestnetCoin', symbol: 'TCOIN', decimals: 8, description: 'd', id: COIN_T }];
    else if (url === NETWORKS.mainnet.tokenRegistryUrl)
      body = [{ network: 'unicity:mainnet', assetKind: 'fungible', name: 'MainnetCoin', symbol: 'MCOIN', decimals: 6, description: 'd', id: COIN_M }];
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
  }));
  return seen;
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => undefined);
  (Sphere as unknown as { instance: Sphere | null }).instance = null;
  TokenRegistry.destroy();
  vi.unstubAllGlobals();
}, 60_000);

async function init(net: 'testnet2' | 'mainnet', storage: FileStorageProvider, world: Pv2World): Promise<Sphere> {
  const { sphere } = await Sphere.init({
    storage, transport: mockTransport(), oracle: mockOracle(net),
    mnemonic: M1, network: net, walletApi: world.walletApi });
  cleanups.push(async () => { try { await sphere.destroy(); } catch { /* ignore */ } });
  return sphere;
}

describe('PROBE3', () => {
  it('S12: sequential, DIFFERENT storage — which storage holds which registry cache?', async () => {
    stubRegistryFetch();
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-A-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-B-'));
    const sA = new FileStorageProvider({ dataDir: dirA });
    const sB = new FileStorageProvider({ dataDir: dirB });
    await init('testnet2', sA, makePv2World('testnet2'));
    await TokenRegistry.waitForReady(8000);
    await init('mainnet', sB, makePv2World('mainnet'));
    await TokenRegistry.waitForReady(8000);
    const kA = (await sA.keys()).filter((k) => k.startsWith('token_registry_cache:')).sort();
    const kB = (await sB.keys()).filter((k) => k.startsWith('token_registry_cache:')).sort();
    log('S12: registry cache keys in storage A:', JSON.stringify(kA.map((k) => k.split('unicity-ids.')[1])));
    log('S12: registry cache keys in storage B:', JSON.stringify(kB.map((k) => k.split('unicity-ids.')[1])));
    fs.rmSync(dirA, { recursive: true, force: true }); fs.rmSync(dirB, { recursive: true, force: true });
  }, 60_000);

  it('S13: TWO inits, SAME network, SAME storage — two facades over ONE pv2g2 KV', async () => {
    stubRegistryFetch();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-same-'));
    const s = new FileStorageProvider({ dataDir: dir });
    const wA = makePv2World('testnet2');
    const a = await init('testnet2', s, wA);
    const wB = makePv2World('testnet2');
    const b = await init('testnet2', s, wB);
    log('S13: same pubkey?', a.identity?.chainPubkey === b.identity?.chainPubkey);
    log('S13: distinct objects?', (a as unknown) !== (b as unknown));

    const ta = await seedPv2Inventory(wA, wA.transports[0]!, COIN_T, 40n);
    const tb = await seedPv2Inventory(wB, wB.transports[0]!, COIN_T, 5n);
    wA.transports[0]!.session.fire('inventory');
    wB.transports[0]!.session.fire('inventory');
    await new Promise((r) => setTimeout(r, 600));
    log('S13: a.tokens', JSON.stringify(a.payments.tokens().map((t) => t.id)), 'seededA', ta.tokenId.slice(0, 8));
    log('S13: b.tokens', JSON.stringify(b.payments.tokens().map((t) => t.id)), 'seededB', tb.tokenId.slice(0, 8));
    log('S13: a.assets', JSON.stringify((await a.payments.assets()).map((x) => [x.coinId.slice(0, 4), x.totalAmount])));
    log('S13: b.assets', JSON.stringify((await b.payments.assets()).map((x) => [x.coinId.slice(0, 4), x.totalAmount])));
    const pk = a.identity!.chainPubkey;
    const all = (await s.keys()).filter((k) => k.startsWith('pv2g2:')).sort();
    log('S13: shared pv2g2 keys (ONE set for TWO facades):', JSON.stringify(all));
    log('S13: cursor:inventory value:', String(await s.get(`pv2g2:testnet2:${pk}:cursor:inventory`)));
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('S14: does the FIRST facade keep receiving mailbox/inventory after a SECOND init on a different network?', async () => {
    stubRegistryFetch();
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-liveA-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-liveB-'));
    const sA = new FileStorageProvider({ dataDir: dirA });
    const sB = new FileStorageProvider({ dataDir: dirB });
    const wA = makePv2World('testnet2');
    const a = await init('testnet2', sA, wA);
    const events: string[] = [];
    a.on('inventory:updated', () => events.push('inventory:updated'));
    a.on('connection:status', (s: unknown) => events.push(`connection:${JSON.stringify(s)}`));
    await init('mainnet', sB, makePv2World('mainnet'));
    const t = await seedPv2Inventory(wA, wA.transports[0]!, COIN_T, 3n);
    wA.transports[0]!.session.fire('inventory');
    let ok = false;
    try {
      await vi.waitFor(() => { expect(a.payments.tokens().map((x) => x.id)).toContain(t.tokenId); }, { timeout: 5000 });
      ok = true;
    } catch { ok = false; }
    log('S14: instance A still ingests inventory after B init?', ok);
    log('S14: events seen on A:', JSON.stringify(events));
    log('S14: A session startCalls', wA.transports[0]!.session.startCalls,
        'stopCalls', (wA.transports[0]!.session as unknown as { stopCalls?: number }).stopCalls);
    fs.rmSync(dirA, { recursive: true, force: true }); fs.rmSync(dirB, { recursive: true, force: true });
  }, 60_000);
});
