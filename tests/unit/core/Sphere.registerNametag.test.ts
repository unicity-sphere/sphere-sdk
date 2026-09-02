/**
 * registerNametag is Nostr-binding only (D5): registering a nametag publishes the
 * identity binding (name ↔ chainPubkey); there is NO on-chain nametag token mint.
 * Receive is always SignaturePredicate(chainPubkey). The publish first-seen-wins
 * failure path is the uniqueness guard.
 *
 * (Replaces the obsolete Sphere.mint-before-publish suite, whose mint-then-publish
 * ordering no longer exists.)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { ITokenEngine } from '../../../token-engine';
import { Sphere } from '../../../core/Sphere';
import { FileStorageProvider } from '../../../impl/nodejs/storage/FileStorageProvider';
import type { TransportProvider, OracleProvider } from '../../../index';
import type { ProviderStatus } from '../../../types';
import { TEST_NETWORK } from '../../test-network';
import { makePv2World } from '../../support/pv2-world';

const TEST_DIR = path.join(__dirname, '.test-register-nametag');
const DATA_DIR = path.join(TEST_DIR, 'data');

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
    resolveNametag: vi.fn().mockResolvedValue(null),
    publishIdentityBinding: vi.fn().mockResolvedValue(true),
    recoverNametag: vi.fn().mockResolvedValue(null),
  } as TransportProvider;
}

/** Minimal single-node trust base: parses, dials nothing. */
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

function createMockOracle(): OracleProvider {
  return {
    id: 'mock-oracle',
    name: 'Mock Oracle',
    type: 'aggregator' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as ProviderStatus),
    initialize: vi.fn().mockResolvedValue(undefined),
    // The three config accessors ARE the post-cutover oracle surface, and they
    // are what lets Sphere build a token engine here — without one, the
    // "never mints" guard below would have nothing to watch.
    getTrustBaseJson: () => TRUST_BASE_JSON,
    getAggregatorUrl: () => 'https://127.0.0.1:1/never-called',
    getApiKey: () => undefined,
  } as unknown as OracleProvider;
}

function cleanTestDir(): void {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

describe('Sphere.registerNametag() — Nostr-binding only (D5, no on-chain mint)', () => {
  let storage: FileStorageProvider;

  beforeEach(() => {
    cleanTestDir();
    storage = new FileStorageProvider({ dataDir: DATA_DIR });
  });

  afterEach(() => {
    cleanTestDir();
  });

  it('registers by publishing the Nostr identity binding, with no on-chain mint', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      walletApi: makePv2World().walletApi,
      network: TEST_NETWORK,
      autoGenerate: true,
    });

    (transport.publishIdentityBinding as ReturnType<typeof vi.fn>).mockClear();

    // Watch the ONLY surface a nametag mint could go through today. The old
    // guard watched `oracle.submitCommitment`, which the v1 cutover deleted from
    // OracleProvider — nothing could call it, so the assertion could not fail.
    const engine = (sphere as unknown as { _tokenEngine?: ITokenEngine })._tokenEngine;
    expect(engine).toBeDefined();
    const mint = vi.spyOn(engine!, 'mint');
    const mintDataToken = vi.spyOn(engine!, 'mintDataToken');

    await sphere.registerNametag('alice');

    // Published the binding with the nametag…
    expect(transport.publishIdentityBinding).toHaveBeenCalledWith(
      sphere.identity!.chainPubkey,
      expect.any(String),
      'alice',
    );
    // …updated local state…
    expect(sphere.identity!.nametag).toBe('alice');
    // …and performed NO on-chain mint: registration is a Nostr binding, nothing more.
    expect(mint).not.toHaveBeenCalled();
    expect(mintDataToken).not.toHaveBeenCalled();

    await sphere.destroy();
  });

  it('throws when the binding is already taken (publish returns false)', async () => {
    const transport = createMockTransport();
    const oracle = createMockOracle();
    (transport.publishIdentityBinding as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const { sphere } = await Sphere.init({
      storage,
      transport,
      oracle,
      walletApi: makePv2World().walletApi,
      network: TEST_NETWORK,
      autoGenerate: true,
    });

    await expect(sphere.registerNametag('taken')).rejects.toThrow('may already be taken');
    expect(sphere.identity!.nametag).toBeUndefined();

    await sphere.destroy();
  });
});
