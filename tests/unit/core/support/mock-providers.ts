/**
 * Reusable mock provider factory for Sphere core unit tests.
 *
 * The concrete mock bodies (storage / transport / oracle / token storage) are
 * copied verbatim from tests/unit/core/Sphere.status.test.ts so behavior matches
 * the long-standing harness those tests rely on. The only addition is the
 * `walletExists` knob, which seeds the exact storage key Sphere.exists() reads
 * (STORAGE_KEYS_GLOBAL.MNEMONIC) so a test can drive Sphere.init()'s
 * create-vs-load branch.
 */

import { vi } from 'vitest';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase } from '../../../../storage';
import type { TransportProvider } from '../../../../transport';
import type { OracleProvider } from '../../../../oracle';
import type { ProviderStatus } from '../../../../types';
import { STORAGE_KEYS_GLOBAL } from '../../../../constants';

/**
 * A valid BIP39 test mnemonic (well-known abandon×11 + about vector). Stored as
 * plaintext under STORAGE_KEYS_GLOBAL.MNEMONIC so Sphere.exists() returns true
 * and Sphere.load() can decrypt it (decrypt() passes through valid BIP39 when no
 * password is set).
 */
export const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// =============================================================================
// Mock Factories (copied verbatim from Sphere.status.test.ts)
// =============================================================================

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
    // Expose the backing map so callers can seed wallet-existence keys.
    _data: data,
  } as unknown as StorageProvider & { _data: Map<string, string> };
}

function createMockTransport(): TransportProvider {
  const eventCallbacks = new Set<(event: unknown) => void>();
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
    onEvent: vi.fn((callback: (event: unknown) => void) => {
      eventCallbacks.add(callback);
      return () => eventCallbacks.delete(callback);
    }),
    // Expose for testing: simulate transport events
    _simulateEvent: (event: unknown) => {
      for (const cb of eventCallbacks) cb(event);
    },
    // Relay methods for metadata
    getRelays: vi.fn(() => ['wss://relay1.test', 'wss://relay2.test']),
    getConnectedRelays: vi.fn(() => ['wss://relay1.test']),
  } as unknown as TransportProvider & { _simulateEvent: (e: unknown) => void };
}

function createMockOracle(): OracleProvider {
  const eventCallbacks = new Set<(event: unknown) => void>();
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
    onEvent: vi.fn((callback: (event: unknown) => void) => {
      eventCallbacks.add(callback);
      return () => eventCallbacks.delete(callback);
    }),
    _simulateEvent: (event: unknown) => {
      for (const cb of eventCallbacks) cb(event);
    },
  } as unknown as OracleProvider & { _simulateEvent: (e: unknown) => void };
}

function createMockTokenStorage(id: string, name: string): TokenStorageProvider<TxfStorageDataBase> {
  return {
    id,
    name,
    type: 'cloud' as const,
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
      success: true,
      merged: localData,
      added: 0,
      removed: 0,
      conflicts: 0,
    })),
    onEvent: vi.fn().mockReturnValue(() => {}),
  };
}

// =============================================================================
// Combined factory
// =============================================================================

export interface MockProviders {
  storage: StorageProvider & { _data: Map<string, string> };
  transport: TransportProvider & { _simulateEvent: (e: unknown) => void };
  oracle: OracleProvider & { _simulateEvent: (e: unknown) => void };
  tokenStorage: TokenStorageProvider<TxfStorageDataBase>;
}

export interface MakeMockProvidersOptions {
  /**
   * When true, seeds storage so Sphere.exists() returns true — Sphere.init()
   * takes the load branch. When false (default), storage is empty so init()
   * takes the create branch.
   */
  walletExists?: boolean;
}

/**
 * Build a fresh set of mock providers for a Sphere core test.
 *
 * @param options.walletExists - Seed the wallet-existence storage key so
 *   Sphere.init() loads instead of creates. Sphere.exists() checks
 *   STORAGE_KEYS_GLOBAL.MNEMONIC (then MASTER_KEY); we seed MNEMONIC with a
 *   valid plaintext BIP39 mnemonic so both exists() and load()'s decrypt pass.
 */
export function makeMockProviders(options: MakeMockProvidersOptions = {}): MockProviders {
  const storage = createMockStorage() as StorageProvider & { _data: Map<string, string> };

  if (options.walletExists) {
    storage._data.set(STORAGE_KEYS_GLOBAL.MNEMONIC, TEST_MNEMONIC);
  }

  return {
    storage,
    transport: createMockTransport() as TransportProvider & { _simulateEvent: (e: unknown) => void },
    oracle: createMockOracle() as OracleProvider & { _simulateEvent: (e: unknown) => void },
    tokenStorage: createMockTokenStorage('indexeddb-tokens', 'IndexedDB'),
  };
}
