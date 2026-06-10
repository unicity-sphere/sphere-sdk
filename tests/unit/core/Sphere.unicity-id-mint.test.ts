/**
 * registerNametag mints + stores the self-issued v2 UnicityIdToken (best-effort).
 *
 * The Nostr binding remains the registration act and the uniqueness guard (D5);
 * the on-chain claim is ADDITIONALLY minted via token-engine/unicity-id and
 * stored as NametagData { format: 'v2-cbor', token: <hex CBOR> } — unused at
 * runtime, kept for the future. A mint failure must never fail registration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { ProviderStatus } from '../../../types';
import { TEST_NETWORK } from '../../test-network';

const mintUnicityIdToken = vi.fn();

vi.mock('../../../token-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../token-engine')>();
  return {
    ...actual,
    createUnicityIdMinter: vi.fn(() => ({ mintUnicityIdToken })),
  };
});

// Import AFTER the mock so Sphere picks up the mocked factory.
import { Sphere } from '../../../core/Sphere';
import { createUnicityIdMinter } from '../../../token-engine';
import { FileStorageProvider } from '../../../impl/nodejs/storage/FileStorageProvider';
import { FileTokenStorageProvider } from '../../../impl/nodejs/storage/FileTokenStorageProvider';
import type { TransportProvider, OracleProvider } from '../../../index';

const TEST_DIR = path.join(__dirname, '.test-unicity-id-mint');
const DATA_DIR = path.join(TEST_DIR, 'data');
const TOKENS_DIR = path.join(TEST_DIR, 'tokens');

const FAKE_CBOR_HEX = 'd9988b8401aa';
const FAKE_TOKEN_ID = 'ab'.repeat(32);

function createMockTransport(): TransportProvider {
  return {
    id: 'mock-transport', name: 'Mock Transport', type: 'p2p' as const, description: 'Mock',
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
    resolveNametag: vi.fn().mockResolvedValue(null),
    publishIdentityBinding: vi.fn().mockResolvedValue(true),
    recoverNametag: vi.fn().mockResolvedValue(null),
  } as TransportProvider;
}

/** Oracle WITH the v2 config surface — the minter prerequisites. */
function createV2Oracle(): OracleProvider {
  return {
    id: 'mock-oracle', name: 'Mock Oracle', type: 'aggregator' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as ProviderStatus),
    initialize: vi.fn().mockResolvedValue(undefined),
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
    getTrustBaseJson: vi.fn().mockReturnValue({ networkId: 2 }),
    getAggregatorUrl: vi.fn().mockReturnValue('https://gateway.example'),
    getApiKey: vi.fn().mockReturnValue(undefined),
  } as unknown as OracleProvider;
}

function cleanTestDir(): void {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

async function initSphere() {
  const storage = new FileStorageProvider({ dataDir: DATA_DIR });
  const tokenStorage = new FileTokenStorageProvider({ tokensDir: TOKENS_DIR });
  const { sphere } = await Sphere.init({
    storage,
    transport: createMockTransport(),
    oracle: createV2Oracle(),
    tokenStorage,
    network: TEST_NETWORK,
    autoGenerate: true,
  });
  return sphere;
}

describe('Sphere — Unicity ID token mint at registration (v2, best-effort)', () => {
  beforeEach(() => {
    cleanTestDir();
    if (Sphere.getInstance()) {
      (Sphere as unknown as { instance: null }).instance = null;
    }
    vi.mocked(createUnicityIdMinter).mockClear();
    mintUnicityIdToken.mockReset();
    mintUnicityIdToken.mockResolvedValue({ tokenCborHex: FAKE_CBOR_HEX, tokenId: FAKE_TOKEN_ID });
  });

  afterEach(() => {
    (Sphere as unknown as { instance: null }).instance = null;
    cleanTestDir();
  });

  it('registerNametag mints and stores a v2-cbor NametagData entry', async () => {
    const sphere = await initSphere();

    await sphere.registerNametag('alice');

    await vi.waitFor(() => {
      const entry = sphere.payments.getNametags().find((n) => n.name === 'alice');
      expect(entry).toBeDefined();
      expect(entry!.format).toBe('v2-cbor');
      expect(entry!.token).toBe(FAKE_CBOR_HEX);
      expect(entry!.version).toBe('2.0');
    });
    expect(mintUnicityIdToken).toHaveBeenCalledWith('alice');
    // Registration itself stayed binding-first.
    expect(sphere.identity!.nametag).toBe('alice');

    await sphere.destroy();
  });

  it('a mint failure does NOT fail registration (best-effort)', async () => {
    mintUnicityIdToken.mockRejectedValue(new Error('gateway down'));
    const sphere = await initSphere();

    await expect(sphere.registerNametag('bob')).resolves.toBeUndefined();
    expect(sphere.identity!.nametag).toBe('bob');

    await vi.waitFor(() => expect(mintUnicityIdToken).toHaveBeenCalled());
    expect(sphere.payments.getNametags().find((n) => n.name === 'bob')).toBeUndefined();

    await sphere.destroy();
  });

  it('is idempotent — a stored v2-cbor entry is not re-minted', async () => {
    const sphere = await initSphere();
    await sphere.registerNametag('carol');
    await vi.waitFor(() => {
      expect(sphere.payments.getNametags().find((n) => n.name === 'carol')).toBeDefined();
    });
    mintUnicityIdToken.mockClear();

    // Re-run the best-effort hook directly (as load()/postSwitchSync do).
    (sphere as unknown as { ensureUnicityIdTokenStored(): void }).ensureUnicityIdTokenStored();
    await new Promise((r) => setTimeout(r, 50));

    expect(mintUnicityIdToken).not.toHaveBeenCalled();

    await sphere.destroy();
  });

  it('legacy v1 object entries are left untouched (no re-mint storm, new entry added)', async () => {
    const sphere = await initSphere();
    await sphere.registerNametag('dave');
    await vi.waitFor(() => {
      expect(sphere.payments.getNametags().find((n) => n.name === 'dave')).toBeDefined();
    });

    // A legacy v1 entry (object token) must survive verbatim next to the v2 entry.
    const legacy = { name: 'old', token: { genesis: {} }, timestamp: 1, format: 'txf', version: '2.0' };
    await sphere.payments.setNametag(legacy);
    const all = sphere.payments.getNametags();
    expect(all.find((n) => n.name === 'old')?.token).toEqual({ genesis: {} });
    expect(all.find((n) => n.name === 'dave')?.format).toBe('v2-cbor');

    await sphere.destroy();
  });
});
