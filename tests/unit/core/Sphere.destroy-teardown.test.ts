/**
 * Tests for `Sphere.destroy()` writer-teardown ordering (Issue #166
 * P3 #7; steelman C6 in #97 round 1).
 *
 * The ordering invariant at Sphere.ts:4271-4291:
 * `installOutboxWriter(null)` + `installSentLedgerWriter(null)` MUST
 * fire BEFORE `storage.disconnect()`. The rationale (from the source
 * comment): the writers hold a reference to the underlying
 * ProfileDatabase. In-flight fire-and-forget hydration Promises
 * (kicked off by `installOutboxWriter`) would otherwise dispatch
 * reads against a closing/closed DB and log spurious errors.
 *
 * Cross-reference: the writer-identity guard
 * (`tests/unit/modules/payments/install-outbox-writer-guard.test.ts`)
 * pins the BEHAVIORAL outcome (no map repopulation post-uninstall).
 * This file pins the literal ORDER so a future refactor that moves
 * `storage.disconnect()` earlier (e.g., consolidating provider
 * teardown into one loop) is caught.
 *
 * We use a partial Sphere harness (Object.create + minimal field
 * population) to avoid the heavyweight `Sphere.init/load` path. The
 * destroy() code path under test reads only a small subset of fields.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { Sphere } from '../../../core/Sphere';
import type { OracleProvider } from '../../../oracle';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase } from '../../../storage';
import type { TransportProvider } from '../../../transport';

// ---------------------------------------------------------------------------
// SDK mocks (kept minimal — destroy() does not touch the SDK heavily)
// ---------------------------------------------------------------------------

vi.mock('../../../l1/network', () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  isWebSocketConnected: vi.fn().mockReturnValue(false),
}));

// ---------------------------------------------------------------------------
// Spy stubs
// ---------------------------------------------------------------------------

interface SpyPayments {
  installOutboxWriter: ReturnType<typeof vi.fn>;
  installSentLedgerWriter: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

function makeSpyPayments(): SpyPayments {
  return {
    installOutboxWriter: vi.fn(),
    installSentLedgerWriter: vi.fn(),
    destroy: vi.fn(),
  };
}

function makeSpyCommunications(): { destroy: ReturnType<typeof vi.fn> } {
  return { destroy: vi.fn() };
}

interface SpyStorage extends StorageProvider {
  disconnect: ReturnType<typeof vi.fn>;
}

function makeSpyStorage(): SpyStorage {
  return {
    id: 'spy-storage',
    name: 'Spy Storage',
    type: 'local',
    setIdentity: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    has: vi.fn().mockResolvedValue(false),
    keys: vi.fn().mockResolvedValue([]),
    clear: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
  } as unknown as SpyStorage;
}

interface SpyTransport extends TransportProvider {
  disconnect: ReturnType<typeof vi.fn>;
}

function makeSpyTransport(): SpyTransport {
  return {
    id: 'spy-transport',
    name: 'Spy Transport',
    type: 'p2p',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
  } as unknown as SpyTransport;
}

interface SpyOracle extends OracleProvider {
  disconnect: ReturnType<typeof vi.fn>;
}

function makeSpyOracle(): SpyOracle {
  return {
    id: 'spy-oracle',
    name: 'Spy Oracle',
    type: 'network',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
  } as unknown as SpyOracle;
}

// ---------------------------------------------------------------------------
// Sphere harness — populate only what destroy() reads
// ---------------------------------------------------------------------------

interface HarnessSpies {
  payments: SpyPayments;
  storage: SpyStorage;
  transport: SpyTransport;
  oracle: SpyOracle;
  communications: { destroy: ReturnType<typeof vi.fn> };
}

interface SphereHarness {
  sphere: Sphere;
  spies: HarnessSpies;
}

function createHarness(): SphereHarness {
  const sphere = Object.create(Sphere.prototype) as Sphere;
  const sphereAny = sphere as unknown as Record<string, unknown>;

  const payments = makeSpyPayments();
  const storage = makeSpyStorage();
  const transport = makeSpyTransport();
  const oracle = makeSpyOracle();
  const communications = makeSpyCommunications();

  // Fields used by destroy()
  sphereAny._providerEventCleanups = [];
  sphereAny._lastProviderConnected = new Map();
  sphereAny._swap = null;
  sphereAny._accounting = null;
  sphereAny._addressModules = new Map();
  sphereAny._payments = payments;
  sphereAny._communications = communications;
  sphereAny._groupChat = null;
  sphereAny._market = null;
  sphereAny._transportMux = null;
  sphereAny._transport = transport;
  sphereAny._storage = storage;
  sphereAny._oracle = oracle;
  sphereAny._tokenStorageProviders = new Map<
    string,
    TokenStorageProvider<TxfStorageDataBase>
  >();

  // Fields reset at the end of destroy()
  sphereAny._initialized = true;
  sphereAny._trackedAddressesLoaded = true;
  sphereAny._identity = null;
  sphereAny._trackedAddresses = new Map();
  sphereAny._addressIdToIndex = new Map();
  sphereAny._addressNametags = new Map();
  sphereAny._disabledProviders = new Set();
  sphereAny.eventHandlers = new Map();

  return {
    sphere,
    spies: { payments, storage, transport, oracle, communications },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Sphere.destroy() writer teardown order (Issue #166 — P3 #7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls installOutboxWriter(null) BEFORE storage.disconnect()', async () => {
    const { sphere, spies } = createHarness();
    await sphere.destroy();

    const installOrder =
      spies.payments.installOutboxWriter.mock.invocationCallOrder[0];
    const disconnectOrder = spies.storage.disconnect.mock.invocationCallOrder[0];
    expect(installOrder).toBeDefined();
    expect(disconnectOrder).toBeDefined();
    expect(installOrder).toBeLessThan(disconnectOrder);
    // The installer is invoked with null (uninstall).
    expect(spies.payments.installOutboxWriter).toHaveBeenCalledWith(null);
  });

  it('calls installSentLedgerWriter(null) BEFORE storage.disconnect()', async () => {
    const { sphere, spies } = createHarness();
    await sphere.destroy();

    const installOrder =
      spies.payments.installSentLedgerWriter.mock.invocationCallOrder[0];
    const disconnectOrder = spies.storage.disconnect.mock.invocationCallOrder[0];
    expect(installOrder).toBeLessThan(disconnectOrder);
    expect(spies.payments.installSentLedgerWriter).toHaveBeenCalledWith(null);
  });

  it('calls payments.installOutboxWriter(null) BEFORE payments.destroy() (consistency check)', async () => {
    // The payments destroy() call comes AFTER the writer teardown.
    // This ordering ensures no in-flight worker tries to run a scan
    // mid-teardown against a half-disconnected storage.
    const { sphere, spies } = createHarness();
    await sphere.destroy();

    const installOrder =
      spies.payments.installOutboxWriter.mock.invocationCallOrder[0];
    const destroyOrder = spies.payments.destroy.mock.invocationCallOrder[0];
    expect(installOrder).toBeLessThan(destroyOrder);
  });

  it('idempotency: installer throws are swallowed (defensive wrap protects future contracts)', async () => {
    const { sphere, spies } = createHarness();
    spies.payments.installOutboxWriter.mockImplementation(() => {
      throw new Error('1-line setter should never throw, but...');
    });

    // MUST NOT propagate — the destroy() body wraps both installer
    // calls in a single try/catch at Sphere.ts:4286-4291 ("Non-fatal").
    // Contract: a throw exits the try block; the subsequent
    // installSentLedgerWriter call in the same try is skipped, BUT
    // destroy() must continue to storage.disconnect(). This is the
    // load-bearing assertion — destroy() never deadlocks on a bad
    // writer.
    await expect(sphere.destroy()).resolves.not.toThrow();
    expect(spies.storage.disconnect).toHaveBeenCalledTimes(1);
  });

  it('iterates _addressModules to install(null) on per-address payments BEFORE storage.disconnect()', async () => {
    // Each per-address ModuleSet has its own payments + writers. The
    // destroy() loop at lines 4277-4285 calls install(null) on every
    // ModuleSet before reaching the active payments at line 4287-4288.
    // ALL of those install(null) calls precede storage.disconnect().
    const { sphere, spies } = createHarness();
    const perAddressPayments = makeSpyPayments();
    const sphereAny = sphere as unknown as { _addressModules: Map<number, unknown> };
    sphereAny._addressModules.set(0, {
      payments: perAddressPayments,
      communications: { destroy: vi.fn() },
      groupChat: null,
      market: null,
      tokenStorageProviders: new Map(),
    });

    await sphere.destroy();

    const perAddressInstall =
      perAddressPayments.installOutboxWriter.mock.invocationCallOrder[0];
    const disconnect = spies.storage.disconnect.mock.invocationCallOrder[0];
    expect(perAddressInstall).toBeLessThan(disconnect);
    expect(perAddressPayments.installSentLedgerWriter).toHaveBeenCalledWith(null);
  });
});
