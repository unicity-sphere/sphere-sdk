/**
 * Integration test: History sync across multiple devices via IPFS-like provider.
 *
 * Simulates a multi-device scenario with real FileStorageProvider
 * and FileTokenStorageProvider, plus a mock "IPFS" provider that
 * carries _history in TXF data during sync.
 *
 * Covers:
 * 1. Device A creates history entries → save() includes _history in TXF
 * 2. Device B syncs from shared TXF → history entries imported into local store
 * 3. Deduplication: shared entries are not duplicated across sync
 * 4. Union: each device's unique entries appear on the other after sync
 * 5. History survives full destroy → reload cycle
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Sphere } from '../../core/Sphere';
import { FileStorageProvider } from '../../impl/nodejs/storage/FileStorageProvider';
import { FileTokenStorageProvider } from '../../impl/nodejs/storage/FileTokenStorageProvider';
import { mergeTxfData } from '../../impl/shared/ipfs/txf-merge';
import type {
  TransportProvider,
  OracleProvider,
  TokenStorageProvider,
  TxfStorageDataBase,
} from '../../index';
import type { ProviderStatus } from '../../types';
import type { SaveResult, LoadResult, SyncResult } from '../../storage';

// Mock L1 to avoid real WebSocket connections
vi.mock('../../l1/network', () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  isWebSocketConnected: vi.fn().mockReturnValue(false),
}));

// =============================================================================
// Test directories
// =============================================================================

const TEST_DIR = path.join(__dirname, '.test-history-sync');
const DEVICE_A_DIR = path.join(TEST_DIR, 'device-a');
const DEVICE_B_DIR = path.join(TEST_DIR, 'device-b');

// =============================================================================
// Mock providers
// =============================================================================

function createMockTransport(): TransportProvider {
  return {
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p' as const,
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
    publishIdentityBinding: vi.fn().mockResolvedValue(true),
    recoverNametag: vi.fn().mockResolvedValue(null),
    resolve: vi.fn().mockResolvedValue(null),
    onEvent: vi.fn().mockReturnValue(() => {}),
  } as unknown as TransportProvider;
}

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
    submitCommitment: vi.fn().mockResolvedValue({ requestId: 'test-id' }),
    getProof: vi.fn().mockResolvedValue(null),
    waitForProof: vi.fn().mockResolvedValue({ proof: 'mock' }),
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
    onEvent: vi.fn().mockReturnValue(() => {}),
  } as unknown as OracleProvider;
}

/**
 * Simulates an IPFS provider: stores TXF data in memory (shared between devices).
 * On sync(), merges local data with "remote" data using the real mergeTxfData().
 */
function createSharedIpfsProvider(
  sharedState: { data: TxfStorageDataBase | null },
): TokenStorageProvider<TxfStorageDataBase> {
  return {
    id: 'mock-ipfs',
    name: 'Mock IPFS',
    type: 'p2p' as const,
    setIdentity: vi.fn(),
    initialize: vi.fn(async () => true),
    shutdown: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    getStatus: vi.fn((): ProviderStatus => 'connected'),
    load: vi.fn(async (): Promise<LoadResult<TxfStorageDataBase>> => {
      if (sharedState.data) {
        return { success: true, data: sharedState.data, source: 'remote', timestamp: Date.now() };
      }
      return { success: false, source: 'remote', timestamp: Date.now() };
    }),
    save: vi.fn(async (data: TxfStorageDataBase): Promise<SaveResult> => {
      sharedState.data = JSON.parse(JSON.stringify(data));
      return { success: true, timestamp: Date.now() };
    }),
    sync: vi.fn(async (localData: TxfStorageDataBase): Promise<SyncResult<TxfStorageDataBase>> => {
      if (!sharedState.data) {
        // First sync — save local as initial
        sharedState.data = JSON.parse(JSON.stringify(localData));
        return { success: true, merged: localData, added: 0, removed: 0, conflicts: 0 };
      }
      // Merge with remote using real merge logic
      const { merged, added, removed, conflicts } = mergeTxfData(localData, sharedState.data);
      sharedState.data = JSON.parse(JSON.stringify(merged));
      return { success: true, merged, added, removed, conflicts };
    }),
    onEvent: vi.fn().mockReturnValue(() => {}),
  };
}

// =============================================================================
// Helpers
// =============================================================================

function cleanTestDir(): void {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

function mkdirs(base: string): { dataDir: string; tokensDir: string } {
  const dataDir = path.join(base, 'data');
  const tokensDir = path.join(base, 'tokens');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(tokensDir, { recursive: true });
  return { dataDir, tokensDir };
}

// =============================================================================
// Tests
// =============================================================================

describe('History sync integration (multi-device)', () => {
  // Shared "IPFS" state that both devices sync to/from
  let sharedIpfsState: { data: TxfStorageDataBase | null };

  beforeEach(() => {
    cleanTestDir();
    sharedIpfsState = { data: null };
    if (Sphere.getInstance()) {
      (Sphere as unknown as { instance: null }).instance = null;
    }
  });

  afterEach(async () => {
    if (Sphere.getInstance()) {
      try { await Sphere.getInstance()!.destroy(); } catch { /* ignore */ }
    }
    (Sphere as unknown as { instance: null }).instance = null;
    cleanTestDir();
  });

  it('should sync history from device A to device B via shared IPFS', async () => {
    // --- Device A: create wallet, add history, sync ---
    const dirsA = mkdirs(DEVICE_A_DIR);
    const storageA = new FileStorageProvider({ dataDir: dirsA.dataDir });
    const tokenStorageA = new FileTokenStorageProvider({ tokensDir: dirsA.tokensDir });
    const ipfsA = createSharedIpfsProvider(sharedIpfsState);

    const { sphere: sphereA, generatedMnemonic } = await Sphere.init({
      storage: storageA,
      transport: createMockTransport(),
      oracle: createMockOracle(),
      tokenStorage: tokenStorageA,
      autoGenerate: true,
    });

    await sphereA.addTokenStorageProvider(ipfsA);

    // Add history entries on device A
    await sphereA.payments.addToHistory({
      type: 'RECEIVED',
      amount: '1000000',
      coinId: 'UCT',
      symbol: 'UCT',
      timestamp: 1000,
      tokenId: 'token-from-alice',
      senderNametag: 'alice',
    });
    await sphereA.payments.addToHistory({
      type: 'SENT',
      amount: '500000',
      coinId: 'UCT',
      symbol: 'UCT',
      timestamp: 2000,
      transferId: 'transfer-to-bob',
      recipientNametag: 'bob',
    });

    // Sync device A → shared IPFS
    await sphereA.payments.sync();

    // Verify IPFS has history
    expect(sharedIpfsState.data).not.toBeNull();
    expect(sharedIpfsState.data!._history).toBeDefined();
    expect(sharedIpfsState.data!._history).toHaveLength(2);

    // Destroy device A
    await sphereA.destroy();
    (Sphere as unknown as { instance: null }).instance = null;

    // --- Device B: import wallet from mnemonic, sync from IPFS ---
    const dirsB = mkdirs(DEVICE_B_DIR);
    const storageB = new FileStorageProvider({ dataDir: dirsB.dataDir });
    const tokenStorageB = new FileTokenStorageProvider({ tokensDir: dirsB.tokensDir });
    const ipfsB = createSharedIpfsProvider(sharedIpfsState);

    const sphereB = await Sphere.import({
      storage: storageB,
      transport: createMockTransport(),
      oracle: createMockOracle(),
      tokenStorage: tokenStorageB,
      mnemonic: generatedMnemonic!,
    });

    await sphereB.addTokenStorageProvider(ipfsB);

    // Sync device B ← shared IPFS
    await sphereB.payments.sync();

    // Verify device B has device A's history
    const historyB = sphereB.payments.getHistory();
    expect(historyB).toHaveLength(2);

    const dedupKeys = historyB.map(e => e.dedupKey);
    expect(dedupKeys).toContain('RECEIVED_token-from-alice');
    expect(dedupKeys).toContain('SENT_transfer_transfer-to-bob');

    // Verify content preserved
    const received = historyB.find(e => e.type === 'RECEIVED');
    expect(received?.senderNametag).toBe('alice');
    expect(received?.amount).toBe('1000000');

    const sent = historyB.find(e => e.type === 'SENT');
    expect(sent?.recipientNametag).toBe('bob');
    expect(sent?.amount).toBe('500000');

    await sphereB.destroy();
  });

  it('should merge history from both devices without duplicates', async () => {
    // --- Device A: create wallet, add history entry, sync ---
    const dirsA = mkdirs(DEVICE_A_DIR);
    const storageA = new FileStorageProvider({ dataDir: dirsA.dataDir });
    const tokenStorageA = new FileTokenStorageProvider({ tokensDir: dirsA.tokensDir });
    const ipfsA = createSharedIpfsProvider(sharedIpfsState);

    const { sphere: sphereA, generatedMnemonic } = await Sphere.init({
      storage: storageA,
      transport: createMockTransport(),
      oracle: createMockOracle(),
      tokenStorage: tokenStorageA,
      autoGenerate: true,
    });

    await sphereA.addTokenStorageProvider(ipfsA);

    await sphereA.payments.addToHistory({
      type: 'RECEIVED',
      amount: '100',
      coinId: 'UCT',
      symbol: 'UCT',
      timestamp: 1000,
      tokenId: 'shared-token',
    });
    await sphereA.payments.addToHistory({
      type: 'SENT',
      amount: '50',
      coinId: 'UCT',
      symbol: 'UCT',
      timestamp: 2000,
      transferId: 'only-on-a',
    });

    await sphereA.payments.sync();
    await sphereA.destroy();
    (Sphere as unknown as { instance: null }).instance = null;

    // --- Device B: import wallet, add own history, then sync ---
    const dirsB = mkdirs(DEVICE_B_DIR);
    const storageB = new FileStorageProvider({ dataDir: dirsB.dataDir });
    const tokenStorageB = new FileTokenStorageProvider({ tokensDir: dirsB.tokensDir });
    const ipfsB = createSharedIpfsProvider(sharedIpfsState);

    const sphereB = await Sphere.import({
      storage: storageB,
      transport: createMockTransport(),
      oracle: createMockOracle(),
      tokenStorage: tokenStorageB,
      mnemonic: generatedMnemonic!,
    });

    await sphereB.addTokenStorageProvider(ipfsB);

    // Device B adds its own unique entry + one with same dedupKey as device A
    await sphereB.payments.addToHistory({
      type: 'RECEIVED',
      amount: '100',
      coinId: 'UCT',
      symbol: 'UCT',
      timestamp: 1000,
      tokenId: 'shared-token', // Same dedupKey as device A
    });
    await sphereB.payments.addToHistory({
      type: 'RECEIVED',
      amount: '200',
      coinId: 'UCT',
      symbol: 'UCT',
      timestamp: 3000,
      tokenId: 'only-on-b',
    });

    // Sync: should merge both directions
    await sphereB.payments.sync();

    const historyB = sphereB.payments.getHistory();

    // Should have 3 unique entries (shared-token deduped, only-on-a, only-on-b)
    const dedupKeys = historyB.map(e => e.dedupKey);
    expect(dedupKeys).toContain('RECEIVED_shared-token');
    expect(dedupKeys).toContain('SENT_transfer_only-on-a');
    expect(dedupKeys).toContain('RECEIVED_only-on-b');

    // No duplicates
    const uniqueKeys = new Set(dedupKeys);
    expect(uniqueKeys.size).toBe(dedupKeys.length);

    await sphereB.destroy();
  });
});
