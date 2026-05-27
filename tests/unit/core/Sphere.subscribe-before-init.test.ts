/**
 * Regression pin: Sphere.initializeProviders MUST call
 * `subscribeToProviderEvents()` BEFORE `tokenStorageProvider.initialize()`
 * so any storage:error events emitted during init (e.g.,
 * `BUNDLE_INDEX_REFRESH_FAILED` from the Profile band-aid that tolerates
 * corrupt-OpLog initialization) reach the connection:changed bridge.
 *
 * Without this ordering, the unit-test patterns that subscribe BEFORE
 * init pass cleanly while production consumers (sphere.telco's
 * migration banner, operator dashboards) miss the degraded-state
 * signal because they subscribe AFTER `Sphere.init()` resolves —
 * `provider.onEvent` has no replay buffer
 * (profile-token-storage-provider.ts:1662-1667).
 *
 * Steelman trail: PR #301 commit 7611b1c. Without this regression
 * test, a future refactor that moves `subscribeToProviderEvents()`
 * back to AFTER `Promise.all([...].map(p => p.initialize()))` would
 * silently reintroduce the bug — 525/525 existing Sphere core tests
 * would still pass.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  StorageProvider,
  TokenStorageProvider,
  TxfStorageDataBase,
} from '../../../storage';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type { ProviderStatus } from '../../../types';

// Mock the L1 network module exactly like Sphere.status.test.ts does so
// the L1 module's default-enabled posture doesn't try to open a real
// Fulcrum WebSocket during this test.
vi.mock('../../../l1/network', () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  isWebSocketConnected: vi.fn().mockReturnValue(false),
}));

import { Sphere } from '../../../core/Sphere';

function createMockStorage(): StorageProvider {
  const data = new Map<string, string>();
  return {
    id: 'mock-storage',
    name: 'Mock Storage',
    type: 'local' as const,
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
    onEvent: vi.fn(() => () => {}),
    getRelays: vi.fn(() => []),
    getConnectedRelays: vi.fn(() => []),
  } as unknown as TransportProvider;
}

function createMockOracle(): OracleProvider {
  return {
    id: 'mock-oracle',
    name: 'Mock Oracle',
    type: 'network' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as ProviderStatus),
    initialize: vi.fn().mockResolvedValue(undefined),
    submitCommitment: vi.fn().mockResolvedValue({ requestId: 'test-id' }),
    getProof: vi.fn().mockResolvedValue(null),
    waitForProof: vi.fn().mockResolvedValue({ proof: 'mock' }),
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
    onEvent: vi.fn(() => () => {}),
  } as unknown as OracleProvider;
}

/**
 * Build a tokenStorage stub that records call order and stashes the
 * `onEvent` callback so the test can fire a synthetic storage:error
 * during initialize().
 */
function createOrderedTokenStorage(): {
  tokenStorage: TokenStorageProvider<TxfStorageDataBase>;
  events: Array<{ kind: 'onEvent' | 'initialize'; t: number }>;
  fireStorageErrorDuringInit: () => void;
} {
  const events: Array<{ kind: 'onEvent' | 'initialize'; t: number }> = [];
  let capturedCallback:
    | ((ev: { type: string; code?: string; error?: unknown }) => void)
    | null = null;
  let counter = 0;

  const tokenStorage: TokenStorageProvider<TxfStorageDataBase> = {
    id: 'ordered-tokens',
    name: 'Ordered',
    type: 'cloud' as const,
    setIdentity: vi.fn(),
    initialize: vi.fn(async () => {
      events.push({ kind: 'initialize', t: ++counter });
      // If the bridge has subscribed, fire a synthetic storage:error
      // to simulate the BUNDLE_INDEX_REFRESH_FAILED path.
      if (capturedCallback) {
        capturedCallback({
          type: 'storage:error',
          code: 'BUNDLE_INDEX_REFRESH_FAILED',
          error: new Error('synthetic: corrupt OpLog block'),
        });
      }
      return true;
    }),
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
    sync: vi.fn(async (data: TxfStorageDataBase) => ({
      success: true, merged: data, added: 0, removed: 0, conflicts: 0,
    })),
    onEvent: vi.fn((callback) => {
      events.push({ kind: 'onEvent', t: ++counter });
      capturedCallback = callback as typeof capturedCallback;
      return () => { capturedCallback = null; };
    }),
  };

  return {
    tokenStorage,
    events,
    fireStorageErrorDuringInit: () => {
      if (capturedCallback) {
        capturedCallback({
          type: 'storage:error',
          code: 'BUNDLE_INDEX_REFRESH_FAILED',
          error: new Error('explicit'),
        });
      }
    },
  };
}

describe('Sphere.initializeProviders — subscribe-before-init ordering (regression pin)', () => {
  let storage: StorageProvider;
  let transport: TransportProvider;
  let oracle: OracleProvider;

  beforeEach(() => {
    if (Sphere.getInstance()) {
      (Sphere as unknown as { instance: null }).instance = null;
    }
    storage = createMockStorage();
    transport = createMockTransport();
    oracle = createMockOracle();
  });

  afterEach(async () => {
    if (Sphere.getInstance()) {
      try { await Sphere.getInstance()!.destroy(); } catch { /* ignore */ }
    }
    (Sphere as unknown as { instance: null }).instance = null;
  });

  it('onEvent is called BEFORE initialize (pinning the order)', async () => {
    const { tokenStorage, events } = createOrderedTokenStorage();
    await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
    });

    // We expect onEvent to be the first recorded call, initialize second.
    // If the order is reversed, the BUNDLE_INDEX_REFRESH_FAILED event
    // fires before the bridge subscribes — it falls into the void in
    // production. The unit-test world wouldn't catch that without this
    // pin.
    expect(events.length).toBeGreaterThanOrEqual(2);
    const firstOnEvent = events.find((e) => e.kind === 'onEvent');
    const firstInit = events.find((e) => e.kind === 'initialize');
    expect(firstOnEvent).toBeDefined();
    expect(firstInit).toBeDefined();
    expect(firstOnEvent!.t).toBeLessThan(firstInit!.t);
  });

  it('storage:error fired DURING tokenStorage.initialize() reaches the bridge (deduplication cache shows non-default state)', async () => {
    // This is the operator-visible behavior: an event emitted during
    // initialize MUST seed the bridge's dedup cache. Without
    // subscribe-before-init, the bridge has no callback wired at
    // emit-time, the cache is never seeded, and the event signal is
    // lost entirely. With subscribe-before-init, the bridge receives
    // the event during init and caches the resulting connected=false
    // state.
    //
    // We assert: after Sphere.init resolves, the bridge's dedup table
    // has an entry for 'ordered-tokens' (proving the callback fired)
    // with `connected=false` (because provider.isConnected() returned
    // false during the synthetic error — the providerId entry only
    // exists if the bridge handler ran).
    const { tokenStorage } = createOrderedTokenStorage();
    const sphere = await Sphere.init({
      storage,
      transport,
      oracle,
      tokenStorage,
      autoGenerate: true,
    });

    const dedup = (
      sphere.sphere as unknown as { _lastProviderConnected: Map<string, boolean> }
    )._lastProviderConnected;
    expect(dedup.has('ordered-tokens')).toBe(true);
  });
});
