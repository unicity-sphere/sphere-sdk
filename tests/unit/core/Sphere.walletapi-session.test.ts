/**
 * #515 F3 — the wallet-api session state is RECORDED and SURFACED, never
 * log-only: a failed sign-in keeps boot non-blocking but flips
 * `walletApiSessionStatus` to 'offline' and emits `walletapi:session`;
 * a later successful sign-in flips it back to 'online'.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase } from '../../../storage';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type { ProviderStatus, SphereEventMap } from '../../../types';

import { Sphere, type SphereWalletApiSession } from '../../../core/Sphere';
import type { PaymentsModule } from '../../../modules/payments';
import { TEST_NETWORK } from '../../test-network';

function createMockStorage(): StorageProvider {
  const data = new Map<string, string>();
  return {
    id: 'mock-storage', name: 'Mock Storage', type: 'local' as const,
    setIdentity: vi.fn(),
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { data.set(key, value); }),
    remove: vi.fn(async (key: string) => { data.delete(key); }),
    has: vi.fn(async (key: string) => data.has(key)),
    keys: vi.fn(async () => Array.from(data.keys())),
    clear: vi.fn(async () => { data.clear(); }),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    getStatus: vi.fn((): ProviderStatus => 'connected'),
    saveTrackedAddresses: vi.fn(async () => {}),
    loadTrackedAddresses: vi.fn(async () => []),
  };
}

function createMockTransport(): TransportProvider {
  return {
    id: 'mock-transport', name: 'Mock Transport', type: 'p2p' as const,
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
    id: 'mock-oracle', name: 'Mock Oracle', type: 'network' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as ProviderStatus),
    initialize: vi.fn().mockResolvedValue(undefined),
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
    onEvent: vi.fn().mockReturnValue(() => {}),
  } as unknown as OracleProvider;
}

function createMockTokenStorage(): TokenStorageProvider<TxfStorageDataBase> {
  return {
    id: 'mock-tokens', name: 'Mock Tokens', type: 'local' as const,
    setIdentity: vi.fn(),
    initialize: vi.fn(async () => true),
    shutdown: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    getStatus: vi.fn((): ProviderStatus => 'connected'),
    load: vi.fn(async () => ({
      success: true,
      data: { _meta: { version: 1, address: '', formatVersion: '2.0', updatedAt: Date.now() } },
      source: 'local' as const,
      timestamp: Date.now(),
    })),
    save: vi.fn(async () => ({ success: true, timestamp: Date.now() })),
    sync: vi.fn(async (localData: TxfStorageDataBase) => ({
      success: true, merged: localData, added: 0, removed: 0, conflicts: 0,
    })),
    onEvent: vi.fn().mockReturnValue(() => {}),
  };
}

/** Structural SphereWalletApiSession double whose signIn outcome is toggleable. */
function createMockWalletApi(state: { fail: boolean }): SphereWalletApiSession {
  return {
    setIdentity: vi.fn(),
    signIn: vi.fn(async () => {
      if (state.fail) throw new Error('connect ECONNREFUSED 127.0.0.1:443');
    }),
    logout: vi.fn(async () => {}),
    putIntent: vi.fn(async () => {}),
    completeIntent: vi.fn(async () => {}),
    abortIntent: vi.fn(async () => {}),
    listIntents: vi.fn(async () => []),
    getUploadUrls: vi.fn(async () => []),
    uploadBlob: vi.fn(async () => {}),
    postHistoryRecords: vi.fn(async () => {}),
  } as unknown as SphereWalletApiSession;
}

/** Re-run the S4 session lifecycle (the same path init/address-switch uses). */
async function rerunSession(sphere: Sphere): Promise<void> {
  const internals = sphere as unknown as {
    startWalletApiSession(payments: PaymentsModule): Promise<void>;
    _payments: PaymentsModule;
  };
  await internals.startWalletApiSession(internals._payments);
}

describe('#515 F3 — surfaced wallet-api session state', () => {
  beforeEach(() => {
    (Sphere as unknown as { instance: null }).instance = null;
  });

  afterEach(async () => {
    if (Sphere.getInstance()) {
      try { await Sphere.getInstance()!.destroy(); } catch { /* ignore */ }
    }
    (Sphere as unknown as { instance: null }).instance = null;
  });

  async function initSphere(walletApi?: SphereWalletApiSession): Promise<Sphere> {
    const { sphere } = await Sphere.init({
      storage: createMockStorage(),
      transport: createMockTransport(),
      oracle: createMockOracle(),
      tokenStorage: createMockTokenStorage(),
      network: TEST_NETWORK,
      autoGenerate: true,
      ...(walletApi ? { walletApi } : {}),
    } as Parameters<typeof Sphere.init>[0]);
    return sphere;
  }

  it('is null when no wallet-api session is composed', async () => {
    const sphere = await initSphere();
    expect(sphere.walletApiSessionStatus).toBeNull();
  });

  it('a dead client at init records OFFLINE (boot stays non-blocking) and the state is readable', async () => {
    const state = { fail: true };
    const sphere = await initSphere(createMockWalletApi(state));
    // Boot completed despite the failed sign-in — and the failure is STATE,
    // not a log line (#515 D3a).
    expect(sphere.walletApiSessionStatus).toBe('offline');
  });

  it('flips to ONLINE on a later successful sign-in, emitting walletapi:session', async () => {
    const state = { fail: true };
    const sphere = await initSphere(createMockWalletApi(state));
    expect(sphere.walletApiSessionStatus).toBe('offline');

    const events: SphereEventMap['walletapi:session'][] = [];
    sphere.on('walletapi:session', (e) => events.push(e));

    state.fail = false;
    await rerunSession(sphere);
    expect(sphere.walletApiSessionStatus).toBe('online');
    expect(events).toEqual([{ status: 'online' }]);
  });

  it('a later failure flips back to OFFLINE with the error surfaced', async () => {
    const state = { fail: false };
    const sphere = await initSphere(createMockWalletApi(state));
    expect(sphere.walletApiSessionStatus).toBe('online');

    const events: SphereEventMap['walletapi:session'][] = [];
    sphere.on('walletapi:session', (e) => events.push(e));

    state.fail = true;
    await rerunSession(sphere);
    expect(sphere.walletApiSessionStatus).toBe('offline');
    expect(events).toEqual([
      { status: 'offline', error: expect.stringContaining('ECONNREFUSED') },
    ]);
  });

  it('does not re-emit when the state is unchanged (offline stays offline)', async () => {
    const state = { fail: true };
    const sphere = await initSphere(createMockWalletApi(state));
    const events: SphereEventMap['walletapi:session'][] = [];
    sphere.on('walletapi:session', (e) => events.push(e));

    await rerunSession(sphere); // fails again — same state
    expect(sphere.walletApiSessionStatus).toBe('offline');
    expect(events).toEqual([]);
  });
});
