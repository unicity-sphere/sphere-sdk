/**
 * Tests for `Sphere.wireProfilePersistedSendStorage` atomic-or-nothing
 * install (Issue #166 P3 #4).
 *
 * The atomicity invariant (round-1 steelman fix in `cbf97d2`):
 * if the storage provider returns a non-null OutboxWriter but a null
 * SentLedgerWriter (or vice versa), **neither is installed**. Without
 * this guard, an outbox-only install would cause `transition('delivered')`
 * to silently tombstone OUTBOX entries while no SENT-write ever
 * happens — a silent data-loss path on every successful send.
 *
 * The method is private; we exercise it via type-erased access on a
 * partial Sphere harness that constructs `this._storage` and calls
 * `wireProfilePersistedSendStorage(payments, identity)` directly. The
 * harness side-steps the full `Sphere.init/load` machinery (transport
 * mux, nametag minter, identity binding events, etc.) while preserving
 * the wiring logic under test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { Sphere } from '../../../core/Sphere';
import {
  createPaymentsModule,
  type PaymentsModule,
} from '../../../modules/payments/PaymentsModule';
import {
  createStubOracle,
  createStubStorageProvider,
  createStubTokenStorageProvider,
  createStubTransport,
  createTestIdentity,
  createWriterPair,
} from '../modules/payments/__fixtures__/payments-module-fixture';
import { Lamport } from '../../../profile/lamport';
import { OutboxWriter } from '../../../profile/outbox-writer';
import { SentLedgerWriter } from '../../../profile/sent-ledger-writer';
import type { FullIdentity } from '../../../types';
import type { StorageProvider } from '../../../storage';

// ---------------------------------------------------------------------------
// SDK mocks (same set used by other PaymentsModule wiring tests)
// ---------------------------------------------------------------------------

vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token', () => ({
  Token: {
    fromJSON: vi
      .fn()
      .mockResolvedValue({ id: { toString: () => 'mock-id' }, coins: null, state: {} }),
  },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/token/fungible/CoinId', () => ({
  CoinId: class {
    toJSON(): string {
      return 'UCT_HEX';
    }
  },
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
vi.mock(
  '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate',
  () => ({ UnmaskedPredicate: class {} }),
);
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
    waitForReady: vi.fn().mockResolvedValue(undefined),
    getInstance: () => ({
      getDefinition: () => null,
      getIconUrl: () => null,
    }),
  },
}));

// ---------------------------------------------------------------------------
// Storage provider with profile-writer builders
// ---------------------------------------------------------------------------

interface ProfileLikeStorage extends StorageProvider {
  buildOutboxWriter: (addressId: string) => OutboxWriter | null;
  buildSentLedgerWriter: (addressId: string) => SentLedgerWriter | null;
}

interface BuilderOptions {
  outbox?: () => OutboxWriter | null;
  sent?: () => SentLedgerWriter | null;
}

function createProfileLikeStorage(options: BuilderOptions = {}): ProfileLikeStorage {
  const base = createStubStorageProvider() as ProfileLikeStorage;
  base.buildOutboxWriter = vi.fn((_addressId: string) =>
    options.outbox ? options.outbox() : null,
  );
  base.buildSentLedgerWriter = vi.fn((_addressId: string) =>
    options.sent ? options.sent() : null,
  );
  return base;
}

// ---------------------------------------------------------------------------
// Sphere test harness
// ---------------------------------------------------------------------------

interface SphereHarness {
  /** Object.create(Sphere.prototype) — only the fields used by
   *  wireProfilePersistedSendStorage are populated. */
  sphereLike: {
    _storage: StorageProvider;
    wireProfilePersistedSendStorage: (
      payments: PaymentsModule,
      identity: FullIdentity | null,
    ) => void;
  };
  payments: PaymentsModule;
  identity: FullIdentity;
}

function createHarness(storage: ProfileLikeStorage): SphereHarness {
  // Partial Sphere instance — only _storage is read by the wiring
  // method. Object.create(Sphere.prototype) keeps the prototype chain
  // so the private method is callable from outside the class.
  const sphereLike = Object.create(Sphere.prototype) as SphereHarness['sphereLike'];
  sphereLike._storage = storage;

  const payments = createPaymentsModule({
    debug: false,
    autoSync: false,
    features: { recoveryWorker: false, finalizationWorker: false },
  });
  const providers = new Map<string, ReturnType<typeof createStubTokenStorageProvider>>();
  providers.set('main', createStubTokenStorageProvider());
  payments.initialize({
    identity: createTestIdentity(),
    storage: createStubStorageProvider(),
    tokenStorageProviders: providers,
    transport: createStubTransport(),
    oracle: createStubOracle(),
    emitEvent: vi.fn(),
  });

  return { sphereLike, payments, identity: createTestIdentity() };
}

interface PaymentsInternals {
  _outboxWriter: OutboxWriter | null;
  _sentLedgerWriter: SentLedgerWriter | null;
}

function inspect(payments: PaymentsModule): PaymentsInternals {
  return payments as unknown as PaymentsInternals;
}

function makeRealWriterPair(): {
  outboxWriter: OutboxWriter;
  sentLedgerWriter: SentLedgerWriter;
} {
  const { outboxWriter, sentLedgerWriter } = createWriterPair();
  return { outboxWriter, sentLedgerWriter };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Sphere.wireProfilePersistedSendStorage (Issue #166 — P3 #4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('installs BOTH writers when both builders return non-null', () => {
    const real = makeRealWriterPair();
    const storage = createProfileLikeStorage({
      outbox: () => real.outboxWriter,
      sent: () => real.sentLedgerWriter,
    });
    const { sphereLike, payments, identity } = createHarness(storage);

    sphereLike.wireProfilePersistedSendStorage(payments, identity);

    expect(inspect(payments)._outboxWriter).toBe(real.outboxWriter);
    expect(inspect(payments)._sentLedgerWriter).toBe(real.sentLedgerWriter);
    expect(storage.buildOutboxWriter).toHaveBeenCalledTimes(1);
    expect(storage.buildSentLedgerWriter).toHaveBeenCalledTimes(1);
  });

  it('installs NEITHER when buildOutboxWriter returns null (refuse partial)', () => {
    const real = makeRealWriterPair();
    const storage = createProfileLikeStorage({
      outbox: () => null,
      sent: () => real.sentLedgerWriter, // non-null
    });
    const { sphereLike, payments, identity } = createHarness(storage);

    sphereLike.wireProfilePersistedSendStorage(payments, identity);

    expect(inspect(payments)._outboxWriter).toBeNull();
    expect(inspect(payments)._sentLedgerWriter).toBeNull();
  });

  it('installs NEITHER when buildSentLedgerWriter returns null (refuse partial)', () => {
    const real = makeRealWriterPair();
    const storage = createProfileLikeStorage({
      outbox: () => real.outboxWriter, // non-null
      sent: () => null,
    });
    const { sphereLike, payments, identity } = createHarness(storage);

    sphereLike.wireProfilePersistedSendStorage(payments, identity);

    expect(inspect(payments)._outboxWriter).toBeNull();
    expect(inspect(payments)._sentLedgerWriter).toBeNull();
  });

  it('installs NEITHER when both builders return null (legacy mode, no warn)', () => {
    const storage = createProfileLikeStorage({
      outbox: () => null,
      sent: () => null,
    });
    const { sphereLike, payments, identity } = createHarness(storage);

    sphereLike.wireProfilePersistedSendStorage(payments, identity);

    expect(inspect(payments)._outboxWriter).toBeNull();
    expect(inspect(payments)._sentLedgerWriter).toBeNull();
  });

  it('no-ops when identity is null (early return)', () => {
    const real = makeRealWriterPair();
    const storage = createProfileLikeStorage({
      outbox: () => real.outboxWriter,
      sent: () => real.sentLedgerWriter,
    });
    const { sphereLike, payments } = createHarness(storage);

    sphereLike.wireProfilePersistedSendStorage(payments, null);

    expect(inspect(payments)._outboxWriter).toBeNull();
    expect(inspect(payments)._sentLedgerWriter).toBeNull();
    // The builders MUST NOT be called when identity is null.
    expect(storage.buildOutboxWriter).not.toHaveBeenCalled();
    expect(storage.buildSentLedgerWriter).not.toHaveBeenCalled();
  });

  it('no-ops when the storage provider lacks buildOutboxWriter / buildSentLedgerWriter (legacy IndexedDB)', () => {
    // Legacy storage providers (IndexedDBStorageProvider,
    // FileStorageProvider) do NOT implement the profile-writer
    // builders. The wiring method must duck-type these as missing
    // and silently return without installing anything.
    const storage = createStubStorageProvider() as StorageProvider; // no builders
    const sphereLike = Object.create(Sphere.prototype) as {
      _storage: StorageProvider;
      wireProfilePersistedSendStorage: (
        payments: PaymentsModule,
        identity: FullIdentity | null,
      ) => void;
    };
    sphereLike._storage = storage;
    const payments = createPaymentsModule({
      debug: false,
      autoSync: false,
      features: { recoveryWorker: false, finalizationWorker: false },
    });
    const providers = new Map<string, ReturnType<typeof createStubTokenStorageProvider>>();
    providers.set('main', createStubTokenStorageProvider());
    payments.initialize({
      identity: createTestIdentity(),
      storage,
      tokenStorageProviders: providers,
      transport: createStubTransport(),
      oracle: createStubOracle(),
      emitEvent: vi.fn(),
    });

    expect(() =>
      sphereLike.wireProfilePersistedSendStorage(payments, createTestIdentity()),
    ).not.toThrow();
    expect(inspect(payments)._outboxWriter).toBeNull();
    expect(inspect(payments)._sentLedgerWriter).toBeNull();
  });

  it('no-ops when identity lacks directAddress (early return BEFORE invoking builders)', () => {
    const real = makeRealWriterPair();
    const storage = createProfileLikeStorage({
      outbox: () => real.outboxWriter,
      sent: () => real.sentLedgerWriter,
    });
    const { sphereLike, payments } = createHarness(storage);

    const noDirect: FullIdentity = {
      chainPubkey: '02' + 'aa'.repeat(32),
      l1Address: 'alpha1test',
      privateKey: '00' + '11'.repeat(31),
      // no directAddress
    };
    sphereLike.wireProfilePersistedSendStorage(payments, noDirect);

    expect(inspect(payments)._outboxWriter).toBeNull();
    expect(inspect(payments)._sentLedgerWriter).toBeNull();
    expect(storage.buildOutboxWriter).not.toHaveBeenCalled();
    expect(storage.buildSentLedgerWriter).not.toHaveBeenCalled();
  });

  it('swallows builder exceptions and leaves PaymentsModule on legacy KV path', () => {
    const storage = createProfileLikeStorage({
      outbox: () => {
        throw new Error('builder-blew-up');
      },
      sent: () =>
        new SentLedgerWriter({
          db: createWriterPair().db,
          encryptionKey: null,
          addressId: 'DIRECT_aabbcc_ddeeff',
          lamport: new Lamport(),
        }),
    });
    const { sphereLike, payments, identity } = createHarness(storage);

    // MUST NOT throw — the catch at line 2871-2876 swallows builder
    // errors and logs a warning. This is the "best-effort wiring"
    // contract; the alternative (throw) would brick Sphere.init for
    // every wallet on a buggy storage provider.
    expect(() =>
      sphereLike.wireProfilePersistedSendStorage(payments, identity),
    ).not.toThrow();
    expect(inspect(payments)._outboxWriter).toBeNull();
    expect(inspect(payments)._sentLedgerWriter).toBeNull();
  });
});
