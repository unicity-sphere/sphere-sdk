/**
 * Engine lifecycle across addresses — who owns which engine, and who terminates it.
 *
 * Every tracked address builds its OWN engine (bound to that address's signing
 * key), and an engine may own OS resources: with
 * `SphereInitOptions.verification` it holds a pool of verification worker
 * threads. So "which engine did we just replace" and "did we terminate all of
 * them" stop being bookkeeping questions and become leak questions — a wallet
 * that has visited three addresses must not leave three thread pools behind.
 *
 * Two failures this pins, both found in review of the 2.0.2 bump:
 *  - `_tokenEngine` did not follow the ACTIVE address (a re-visit does not
 *    re-run initializeAddressModules), so it named a DIFFERENT address's engine
 *    — and `setOracleApiKey` then terminated the wrong wallet's pool while
 *    leaking the active one's;
 *  - `destroy()` disposed only that one pointer, so every non-active address's
 *    engine survived the wallet.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, afterEach, vi } from 'vitest';

import { Sphere } from '../../core/Sphere';
import { FileStorageProvider } from '../../impl/nodejs/storage/FileStorageProvider';
import { createWalletApiProviders, type SphereBaseProviders } from '../../impl/shared/wallet-api';
import { FakeWalletApi } from '../support/fake-wallet-api';
import { wsLikeWithPing } from '../support/wallet-api-test-helpers';
import type { ITokenEngine, VerificationWorker } from '../../token-engine';
import type { TransportProvider, OracleProvider } from '../../index';
import type { ProviderStatus } from '../../types';
import type { TokenStorageProvider, TxfStorageDataBase } from '../../storage';

const MNEMONIC = 'test test test test test test test test test test test junk';

function mockTransport(): TransportProvider {
  return {
    id: 'mock-transport', name: 'Mock Transport', type: 'p2p' as const, description: 'Mock transport',
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

/** Minimal single-node trust base: parses, and no network is touched. */
const TRUST_BASE_JSON = {
  changeRecordHash: null,
  epoch: '0',
  epochStartRound: '0',
  networkId: 4,
  previousEntryHash: null,
  quorumThreshold: '1',
  rootNodes: [{ nodeId: 'NODE', sigKey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', stake: '1' }],
  signatures: {},
  stateHash: '00',
  version: '1',
};

/** Supplies the three config accessors buildTokenEngine needs, so engines really get built. */
function mockOracle(): OracleProvider {
  let apiKey: string | undefined;
  return {
    id: 'mock-oracle', name: 'Mock Oracle', type: 'aggregator' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as ProviderStatus),
    initialize: vi.fn().mockResolvedValue(undefined),
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
    getTrustBaseJson: () => TRUST_BASE_JSON,
    // https: the SDK's AggregatorClient refuses an API key over plaintext http,
    // and the api-key test rotates one. Never dialled — nothing here submits.
    getAggregatorUrl: () => 'https://127.0.0.1:1/never-called',
    getApiKey: () => apiKey,
    setApiKey: (key: string) => { apiKey = key; },
  } as unknown as OracleProvider;
}

/** Never driven — nothing in this file verifies a token. */
function neverSpawnedWorker(): VerificationWorker {
  return {
    onerror: null,
    onmessage: null,
    postMessage: () => { throw new Error('unreachable: no verification happens here'); },
    terminate: () => {},
  };
}

interface Built {
  sphere: Sphere;
  fake: FakeWalletApi;
  dataDir: string;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function buildSphere(): Promise<Built> {
  const fake = new FakeWalletApi();
  const baseUrl = await fake.start();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-lifecycle-'));
  const storage = new FileStorageProvider({ dataDir });
  const base: SphereBaseProviders = {
    storage,
    transport: mockTransport(),
    oracle: mockOracle(),
    tokenStorage: null as unknown as TokenStorageProvider<TxfStorageDataBase>,
  };
  const providers = createWalletApiProviders(base, {
    baseUrl,
    network: fake.network,
    deviceId: 'engine-lifecycle-device',
    webSocketFactory: (url: string) => wsLikeWithPing(url),
  });
  const { sphere } = await Sphere.init({
    storage,
    transport: providers.transport,
    oracle: providers.oracle,
    tokenStorage: providers.tokenStorage,
    delivery: providers.delivery,
    walletApi: providers.walletApi,
    network: 'testnet2',
    mnemonic: MNEMONIC,
    // The option under test: every per-address engine gets a pool config.
    verification: { createWorker: neverSpawnedWorker },
  });
  cleanups.push(async () => {
    await sphere.destroy().catch(() => {});
    await fake.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { sphere, fake, dataDir };
}

/** The per-address engines, by address index (reads Sphere's private map on purpose). */
function enginesByAddress(sphere: Sphere): Map<number, ITokenEngine | undefined> {
  const sets = (sphere as unknown as { _addressModules: Map<number, { tokenEngine?: ITokenEngine }> })._addressModules;
  return new Map([...sets.entries()].map(([i, set]) => [i, set.tokenEngine]));
}

function activeEngine(sphere: Sphere): ITokenEngine | undefined {
  return (sphere as unknown as { _tokenEngine?: ITokenEngine })._tokenEngine;
}

describe('per-address engine lifecycle', () => {
  it('the active engine pointer follows the active address, across a re-visit', async () => {
    const { sphere } = await buildSphere();
    const boot = enginesByAddress(sphere).get(0);
    expect(boot).toBeDefined();
    expect(activeEngine(sphere)).toBe(boot);

    await sphere.switchToAddress(1);
    const one = enginesByAddress(sphere).get(1);
    expect(one).toBeDefined();
    expect(one).not.toBe(boot);
    expect(activeEngine(sphere)).toBe(one);

    // The re-visit path does NOT re-run initializeAddressModules, which is where
    // the pointer used to be left behind.
    await sphere.switchToAddress(0);
    expect(activeEngine(sphere)).toBe(boot);
  }, 60_000);

  it('an api-key change re-keys the ACTIVE address, leaving other addresses alone', async () => {
    const { sphere } = await buildSphere();
    const boot = enginesByAddress(sphere).get(0)!;
    await sphere.switchToAddress(1);
    const oldActive = enginesByAddress(sphere).get(1)!;

    const bootDispose = vi.spyOn(boot, 'dispose');
    const oldActiveDispose = vi.spyOn(oldActive, 'dispose');

    await sphere.setOracleApiKey('sk_rotated');

    // The replaced engine is the ACTIVE one — and the background address that is
    // still running keeps its own pool.
    expect(oldActiveDispose).toHaveBeenCalledTimes(1);
    expect(bootDispose).not.toHaveBeenCalled();
    // Its module set must name the NEW engine: a stale entry would hand address 1
    // a disposed engine on the next switch back.
    const rebuilt = enginesByAddress(sphere).get(1);
    expect(rebuilt).toBeDefined();
    expect(rebuilt).not.toBe(oldActive);
    expect(activeEngine(sphere)).toBe(rebuilt);
  }, 60_000);

  it('destroy() disposes EVERY address\'s engine, not just the active one', async () => {
    const { sphere } = await buildSphere();
    await sphere.switchToAddress(1);
    await sphere.switchToAddress(2);

    const spies = [...enginesByAddress(sphere).values()]
      .filter((e): e is ITokenEngine => e !== undefined)
      .map((engine) => vi.spyOn(engine, 'dispose'));
    expect(spies.length).toBeGreaterThanOrEqual(3);

    await sphere.destroy();

    // A visited address whose pool outlives the wallet keeps a Node process alive.
    for (const spy of spies) expect(spy).toHaveBeenCalled();
  }, 60_000);
});
