/**
 * PaymentsModule address-guard tests.
 *
 * Verifies that `PaymentsModule.load()` correctly accepts or rejects stored
 * data based on the `_meta.address` field written by different storage
 * backends. Three accepted representations:
 *   - L1 bech32 (legacy FileTokenStorageProvider)
 *   - chain pubkey (some providers)
 *   - Profile short ID `DIRECT_{first6}_{last6}` (ProfileTokenStorageProvider)
 *
 * Regression guard for commit 5f1fc85 which extended the guard to accept
 * the Profile short ID. Without coverage, a future refactor reordering the
 * three comparisons or removing the short-ID branch would silently break
 * Profile-mode data loading with no CI signal (the `init --profile` E2E
 * path is gated behind E2E_NETWORK=1 and not run in CI).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createPaymentsModule,
  type PaymentsModuleDependencies,
} from '../../../modules/payments/PaymentsModule';
import type { FullIdentity } from '../../../types';
import type {
  StorageProvider,
  TokenStorageProvider,
  TxfStorageDataBase,
} from '../../../storage';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import { computeAddressId } from '../../../profile/types';
import { logger } from '../../../core/logger';

// ---------------------------------------------------------------------------
// Minimal SDK mocks (match dual-mode test)
// ---------------------------------------------------------------------------

vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token', () => ({
  Token: {
    fromJSON: vi.fn().mockResolvedValue({ id: { toString: () => 'mock-id' }, coins: null, state: {} }),
  },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/token/fungible/CoinId', () => ({
  CoinId: class { toJSON() { return 'UCT_HEX'; } },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/TransferCommitment', () => ({
  TransferCommitment: { fromJSON: vi.fn() },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction', () => ({
  TransferTransaction: class {},
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/sign/SigningService', () => ({
  SigningService: class {},
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/address/AddressScheme', () => ({
  AddressScheme: class {},
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate', () => ({
  UnmaskedPredicate: class {},
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenState', () => ({
  TokenState: class {},
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm', () => ({
  HashAlgorithm: { SHA256: 'sha256' },
}));
vi.mock('../../../l1/network', () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  isWebSocketConnected: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../registry', () => ({
  TokenRegistry: {
    getInstance: () => ({
      getDefinition: () => null,
      getIconUrl: () => null,
    }),
    waitForReady: vi.fn().mockResolvedValue(undefined),
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHAIN_PUBKEY = '02' + 'aa'.repeat(32);
const L1_ADDRESS = 'alpha1qtest';
const DIRECT_ADDRESS = 'DIRECT://AABBCC112233445566778899DDEEFF';
const PROFILE_SHORT_ID = computeAddressId(DIRECT_ADDRESS);
// Sanity: PROFILE_SHORT_ID should look like DIRECT_aabbcc_ddeeff
// (first 6 hex of the body, last 6 hex, lowercase).

function createProviderWithData(meta: { address: string } | null): TokenStorageProvider<TxfStorageDataBase> {
  const data: TxfStorageDataBase = meta
    ? {
        _meta: {
          version: 1,
          address: meta.address,
          formatVersion: '1.0.0',
          updatedAt: Date.now(),
        },
      }
    : ({ _meta: undefined } as unknown as TxfStorageDataBase);
  return {
    id: 'test-provider',
    name: 'Test Provider',
    type: 'local',
    async connect() {},
    async disconnect() {},
    isConnected() { return true; },
    getStatus() { return 'connected'; },
    setIdentity() {},
    async initialize() { return true; },
    async shutdown() {},
    async save() { return { success: true, timestamp: Date.now() }; },
    async load() {
      return {
        success: true,
        data,
        source: 'local',
        timestamp: Date.now(),
      };
    },
    async sync() {
      return { success: true, added: 0, removed: 0, conflicts: 0 };
    },
  };
}

function createDeps(
  provider: TokenStorageProvider<TxfStorageDataBase>,
  identity: FullIdentity,
): PaymentsModuleDependencies {
  const mockStorage: StorageProvider = {
    id: 'mock-storage',
    name: 'Mock Storage',
    type: 'local',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    has: vi.fn().mockResolvedValue(false),
    keys: vi.fn().mockResolvedValue([]),
    clear: vi.fn().mockResolvedValue(undefined),
  };

  const tokenStorageProviders = new Map<string, TokenStorageProvider<TxfStorageDataBase>>();
  tokenStorageProviders.set('main', provider);

  const mockTransport = {
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
  } as unknown as TransportProvider;

  const mockOracle = {
    id: 'mock-oracle',
    name: 'Mock Oracle',
    type: 'network' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    initialize: vi.fn().mockResolvedValue(undefined),
  } as unknown as OracleProvider;

  return {
    identity,
    storage: mockStorage,
    tokenStorageProviders,
    transport: mockTransport,
    oracle: mockOracle,
    emitEvent: vi.fn(),
  };
}

const IDENTITY: FullIdentity = {
  chainPubkey: CHAIN_PUBKEY,
  l1Address: L1_ADDRESS,
  directAddress: DIRECT_ADDRESS,
  privateKey: '00' + '11'.repeat(31),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PaymentsModule address guard', () => {
  // Structural log capture: install a custom logger handler so tests don't
  // depend on the default handler routing to console.warn. Previously this
  // used `vi.spyOn(console, 'warn')`, which (a) is fragile if the default
  // handler is reconfigured elsewhere in the suite, and (b) silently passes
  // "warned=false" if the warning message is reworded.
  const capturedWarnings: Array<{ tag: string; message: string; args: unknown[] }> = [];
  let originalHandler: unknown = null;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedWarnings.length = 0;
    originalHandler = (globalThis as any).__sphere_sdk_logger__?.handler ?? null;
    logger.configure({
      handler: (level, tag, message, ...args) => {
        if (level === 'warn') capturedWarnings.push({ tag, message, args });
      },
    });
  });

  afterEach(() => {
    logger.configure({ handler: originalHandler as any });
  });

  async function loadWithMeta(address: string | null): Promise<{ warned: boolean; warnMessage: string | null }> {
    const provider = createProviderWithData(address !== null ? { address } : null);
    const module = createPaymentsModule({ debug: false, autoSync: false });
    module.initialize(createDeps(provider, IDENTITY));
    await module.load();
    const mismatch = capturedWarnings.find(
      (w) => w.tag === 'Payments' && w.message.includes('address mismatch'),
    );
    return {
      warned: mismatch !== undefined,
      warnMessage: mismatch?.message ?? null,
    };
  }

  it('accepts data whose _meta.address is the L1 bech32 (legacy writer)', async () => {
    const { warned } = await loadWithMeta(L1_ADDRESS);
    expect(warned).toBe(false);
  });

  it('accepts data whose _meta.address is the chain pubkey', async () => {
    const { warned } = await loadWithMeta(CHAIN_PUBKEY);
    expect(warned).toBe(false);
  });

  it('accepts data whose _meta.address is the Profile short ID (DIRECT_xxx_yyy)', async () => {
    // This is the branch added in commit 5f1fc85. Without it,
    // ProfileTokenStorageProvider-written data was silently rejected.
    const { warned } = await loadWithMeta(PROFILE_SHORT_ID);
    expect(warned).toBe(false);
  });

  it('rejects data whose _meta.address is an unrelated short ID', async () => {
    // Address belonging to a different wallet — guard must fire.
    const foreign = 'DIRECT_ffffff_eeeeee';
    const { warned, warnMessage } = await loadWithMeta(foreign);
    expect(warned).toBe(true);
    // Warning should show all three accepted forms, not just L1.
    expect(warnMessage).toContain('profile=');
    expect(warnMessage).toContain('L1=');
    expect(warnMessage).toContain('chain=');
  });

  it('rejects data whose _meta.address is an unrelated L1 bech32', async () => {
    const foreignL1 = 'alpha1qother';
    const { warned } = await loadWithMeta(foreignL1);
    expect(warned).toBe(true);
  });

  it('does not warn when _meta is absent', async () => {
    const { warned } = await loadWithMeta(null);
    expect(warned).toBe(false);
  });
});
