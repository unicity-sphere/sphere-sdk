/**
 * Tests for the PaymentsModule nametag store — additions made by the
 * nametag-mint/Nostr-binding consistency fix:
 *
 *   - `getNametag()` prefers the entry matching `deps.identity.nametag`
 *     over `nametags[0]`. This is the read-side defensive fix for the
 *     alice-vs-alice-t1 bug class: a wallet that ended up with multiple
 *     nametag entries (e.g. from a buggy legacy `registerNametag` flow)
 *     would have returned `[0]` regardless of which one matches the
 *     current Nostr binding — so PROXY-mode finalize would derive the
 *     expected recipient address from the WRONG token.
 *
 *   - `getNametagByName(name)` / `hasNametagNamed(name)` are the
 *     name-specific store probes used by the new `registerNametag`
 *     consistency guard (idempotent re-mint detection + conflict
 *     rejection).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPaymentsModule, type PaymentsModuleDependencies } from '../../../modules/payments/PaymentsModule';
import type { FullIdentity } from '../../../types';

// Local mutable view of FullIdentity for tests that need to flip the
// `nametag` claim at runtime (FullIdentity.nametag is readonly). The SDK
// internally uses a similar `MutableFullIdentity` shape in core/Sphere.ts
// — kept as a private alias there, so we redeclare here.
type MutableFullIdentity = {
  -readonly [K in keyof FullIdentity]: FullIdentity[K];
};
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase } from '../../../storage';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type { NametagData } from '../../../types/txf';

// =============================================================================
// SDK static-import mocks (minimal — nametag store doesn't touch the SDK)
// =============================================================================

vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token', () => ({
  Token: { fromJSON: vi.fn() },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/token/fungible/CoinId', () => ({
  CoinId: class MockCoinId { toJSON() { return 'UCT_HEX'; } },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/TransferCommitment', () => ({
  TransferCommitment: { fromJSON: vi.fn() },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction', () => ({
  TransferTransaction: class MockTransferTransaction {},
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/sign/SigningService', () => ({
  SigningService: class MockSigningService {},
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/address/AddressScheme', () => ({
  AddressScheme: class MockAddressScheme {},
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate', () => ({
  UnmaskedPredicate: class MockUnmaskedPredicate {},
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenState', () => ({
  TokenState: class MockTokenState {},
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
      getSymbol: (id: string) => id,
      getName: (id: string) => id,
      getDecimals: () => 8,
    }),
    waitForReady: vi.fn().mockResolvedValue(undefined),
  },
}));

// =============================================================================
// Harness
// =============================================================================

function makeNametagData(name: string): NametagData {
  return {
    name,
    token: { id: `${name}-mock-token-id` },
    timestamp: Date.now(),
    format: 'txf',
    version: '2.0',
  };
}

function createDeps(): { deps: PaymentsModuleDependencies; identity: MutableFullIdentity } {
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
    saveTrackedAddresses: vi.fn().mockResolvedValue(undefined),
    loadTrackedAddresses: vi.fn().mockResolvedValue([]),
  };

  const tokenStorageProviders = new Map<string, TokenStorageProvider<TxfStorageDataBase>>();

  const mockTransport = {
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p' as const,
    setIdentity: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as const),
    sendMessage: vi.fn(),
    onMessage: vi.fn().mockReturnValue(() => {}),
    sendTokenTransfer: vi.fn(),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
  } as unknown as TransportProvider;

  const mockOracle = {
    id: 'mock-oracle',
    name: 'Mock Oracle',
    type: 'aggregator' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as const),
    initialize: vi.fn().mockResolvedValue(undefined),
  } as unknown as OracleProvider;

  const identity: MutableFullIdentity = {
    chainPubkey: '02' + 'a'.repeat(64),
    l1Address: 'alpha1testaddress',
    directAddress: 'DIRECT://testaddress',
    privateKey: '0x' + 'b'.repeat(64),
  };

  return {
    deps: {
      identity: identity as FullIdentity,
      storage: mockStorage,
      tokenStorageProviders,
      transport: mockTransport,
      oracle: mockOracle,
      emitEvent: vi.fn(),
    } as PaymentsModuleDependencies,
    identity,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('PaymentsModule nametag store', () => {
  let module: ReturnType<typeof createPaymentsModule>;
  let identity: MutableFullIdentity;

  beforeEach(() => {
    module = createPaymentsModule();
    const setup = createDeps();
    identity = setup.identity;
    module.initialize(setup.deps);
  });

  describe('hasNametagNamed / getNametagByName', () => {
    it('returns false / null when no nametag is stored', () => {
      expect(module.hasNametagNamed('alice')).toBe(false);
      expect(module.getNametagByName('alice')).toBeNull();
    });

    it('matches by exact name', async () => {
      await module.setNametag(makeNametagData('alice'));
      expect(module.hasNametagNamed('alice')).toBe(true);
      expect(module.getNametagByName('alice')?.name).toBe('alice');

      // No partial / substring matching
      expect(module.hasNametagNamed('ali')).toBe(false);
      expect(module.hasNametagNamed('alice-t1')).toBe(false);
      expect(module.getNametagByName('alice-t1')).toBeNull();
    });

    it('finds the right entry when multiple nametags are stored', async () => {
      await module.setNametag(makeNametagData('alice'));
      await module.setNametag(makeNametagData('alice-t1'));
      await module.setNametag(makeNametagData('bob'));

      expect(module.hasNametagNamed('alice-t1')).toBe(true);
      expect(module.getNametagByName('alice-t1')?.name).toBe('alice-t1');
      expect(module.getNametagByName('bob')?.name).toBe('bob');
    });
  });

  describe('getNametag() prefers the identity claim', () => {
    it('falls back to nametags[0] when identity.nametag is unset', async () => {
      await module.setNametag(makeNametagData('alice'));
      await module.setNametag(makeNametagData('alice-t1'));

      // identity.nametag was never set
      expect(identity.nametag).toBeUndefined();
      expect(module.getNametag()?.name).toBe('alice');   // = nametags[0]
    });

    it('returns the entry matching identity.nametag when set', async () => {
      // Order matters: seed `alice` FIRST so it ends up at nametags[0].
      // Without the identity-claim preference, getNametag() would always
      // return alice — but identity.nametag claims alice-t1.
      await module.setNametag(makeNametagData('alice'));
      await module.setNametag(makeNametagData('alice-t1'));

      identity.nametag = 'alice-t1';

      const active = module.getNametag();
      expect(active?.name).toBe('alice-t1');   // <- the claimed one, not [0]
    });

    it('falls back to [0] when identity claim has no matching entry', async () => {
      await module.setNametag(makeNametagData('alice'));

      // identity claims a name not in the local store
      identity.nametag = 'someone-else';

      expect(module.getNametag()?.name).toBe('alice');   // fallback
    });

    it('returns null when nametags is empty regardless of identity claim', () => {
      identity.nametag = 'alice-t1';
      expect(module.getNametag()).toBeNull();
    });
  });
});
