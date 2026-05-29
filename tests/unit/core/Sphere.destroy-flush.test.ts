/**
 * Tests for the Issue #255 (2026-05-25) pre-shutdown flush sweep in
 * `Sphere.destroy()`.
 *
 * Default behavior: `destroy()` now calls `provider.awaitNextFlush(timeoutMs)`
 * on every TokenStorageProvider BEFORE `provider.shutdown(opts)`. This
 * makes fire-and-exit CLI commands publish their pending pointer +
 * pin durably before the process returns, fixing the publish-lost
 * race that left peer2 unable to discover what peer1 just did.
 *
 * Opt-out: `destroy({ skipFlush: true })` preserves the legacy
 * fast-exit semantics for E2E crash-simulation paths.
 *
 * Same Object.create(Sphere.prototype) harness pattern as
 * `Sphere.destroy-teardown.test.ts` — populates only the fields
 * destroy() reads.
 */

import { describe, it, expect, vi } from 'vitest';

import { Sphere } from '../../../core/Sphere';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase } from '../../../storage';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';

// ---------------------------------------------------------------------------
// Minimal spies
// ---------------------------------------------------------------------------

function makeSpyStorage(): StorageProvider {
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
    saveTrackedAddresses: vi.fn().mockResolvedValue(undefined),
    loadTrackedAddresses: vi.fn().mockResolvedValue([]),
  } as unknown as StorageProvider;
}

function makeSpyTransport(): TransportProvider {
  return {
    id: 'spy-transport',
    name: 'Spy Transport',
    type: 'p2p',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
  } as unknown as TransportProvider;
}

function makeSpyOracle(): OracleProvider {
  return {
    id: 'spy-oracle',
    name: 'Spy Oracle',
    type: 'network',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
  } as unknown as OracleProvider;
}

interface SpyTokenProviderWithFlush {
  id: string;
  awaitNextFlush: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
  setIdentity: ReturnType<typeof vi.fn>;
  initialize: ReturnType<typeof vi.fn>;
  isConnected: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function makeSpyTokenProvider(
  id: string,
  opts?: { flushThrows?: boolean; flushImpl?: () => Promise<void> },
): SpyTokenProviderWithFlush {
  const flushImpl = opts?.flushImpl
    ?? (opts?.flushThrows
      ? async () => { throw new Error('simulated flush failure'); }
      : async () => { /* succeed */ });
  return {
    id,
    awaitNextFlush: vi.fn(flushImpl),
    shutdown: vi.fn().mockResolvedValue(undefined),
    setIdentity: vi.fn(),
    initialize: vi.fn().mockResolvedValue(true),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

function createHarness(opts?: { providersWithFlush?: SpyTokenProviderWithFlush[] }): {
  sphere: Sphere;
  providers: SpyTokenProviderWithFlush[];
} {
  const sphere = Object.create(Sphere.prototype) as Sphere;
  const sphereAny = sphere as unknown as Record<string, unknown>;

  const providers = opts?.providersWithFlush ?? [makeSpyTokenProvider('p1')];

  sphereAny._providerEventCleanups = [];
  sphereAny._lastProviderConnected = new Map();
  sphereAny._swap = null;
  sphereAny._accounting = null;
  sphereAny._addressModules = new Map();
  sphereAny._payments = { destroy: vi.fn(), installOutboxWriter: vi.fn(), installSentLedgerWriter: vi.fn() };
  sphereAny._communications = { destroy: vi.fn() };
  sphereAny._groupChat = null;
  sphereAny._market = null;
  sphereAny._transportMux = null;
  sphereAny._transport = makeSpyTransport();
  sphereAny._storage = makeSpyStorage();
  sphereAny._oracle = makeSpyOracle();

  const tokenStorageProviders = new Map<string, unknown>();
  for (const p of providers) {
    tokenStorageProviders.set(p.id, p);
  }
  sphereAny._tokenStorageProviders = tokenStorageProviders;

  sphereAny._initialized = true;
  sphereAny._trackedAddressesLoaded = true;
  sphereAny._identity = null;
  sphereAny._trackedAddresses = new Map();
  sphereAny._addressIdToIndex = new Map();
  sphereAny._addressNametags = new Map();
  sphereAny._disabledProviders = new Set();
  sphereAny.eventHandlers = new Map();

  return { sphere, providers };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Sphere.destroy() — pre-shutdown awaitNextFlush sweep (#255 CLI flush fix)', () => {
  it('calls awaitNextFlush on each TokenStorageProvider before shutdown', async () => {
    const p1 = makeSpyTokenProvider('p1');
    const p2 = makeSpyTokenProvider('p2');
    const { sphere } = createHarness({ providersWithFlush: [p1, p2] });

    await sphere.destroy();

    expect(p1.awaitNextFlush).toHaveBeenCalledTimes(1);
    expect(p2.awaitNextFlush).toHaveBeenCalledTimes(1);
    // shutdown still runs after flush.
    expect(p1.shutdown).toHaveBeenCalledTimes(1);
    expect(p2.shutdown).toHaveBeenCalledTimes(1);
    // Ordering: flush BEFORE shutdown for each provider.
    const p1FlushOrder = p1.awaitNextFlush.mock.invocationCallOrder[0];
    const p1ShutdownOrder = p1.shutdown.mock.invocationCallOrder[0];
    expect(p1FlushOrder).toBeLessThan(p1ShutdownOrder);
  });

  it('honors the default 30 000 ms timeout when no flushTimeoutMs is supplied', async () => {
    const p1 = makeSpyTokenProvider('p1');
    const { sphere } = createHarness({ providersWithFlush: [p1] });

    await sphere.destroy();

    expect(p1.awaitNextFlush).toHaveBeenCalledWith(30_000);
  });

  it('passes flushTimeoutMs through when caller supplies it', async () => {
    const p1 = makeSpyTokenProvider('p1');
    const { sphere } = createHarness({ providersWithFlush: [p1] });

    await sphere.destroy({ flushTimeoutMs: 5_000 });

    expect(p1.awaitNextFlush).toHaveBeenCalledWith(5_000);
  });

  it('skipFlush: true bypasses awaitNextFlush entirely (fast-exit path)', async () => {
    const p1 = makeSpyTokenProvider('p1');
    const { sphere } = createHarness({ providersWithFlush: [p1] });

    await sphere.destroy({ skipFlush: true });

    expect(p1.awaitNextFlush).not.toHaveBeenCalled();
    // Shutdown still runs — fast-exit only skips the flush gate.
    expect(p1.shutdown).toHaveBeenCalledTimes(1);
  });

  it('does NOT hang destroy() if a provider flush throws — logs + continues', async () => {
    const failing = makeSpyTokenProvider('failing', { flushThrows: true });
    const ok = makeSpyTokenProvider('ok');
    const { sphere } = createHarness({ providersWithFlush: [failing, ok] });

    // Must resolve — destroy() catches per-provider flush errors.
    await expect(sphere.destroy()).resolves.toBeUndefined();

    // BOTH providers shut down even though one's flush threw.
    expect(failing.shutdown).toHaveBeenCalledTimes(1);
    expect(ok.shutdown).toHaveBeenCalledTimes(1);
  });

  it('tolerates providers without awaitNextFlush (e.g. file/IndexedDB providers)', async () => {
    // A provider missing the optional awaitNextFlush method (typical of
    // FileTokenStorageProvider, IndexedDBTokenStorageProvider).
    const minimal = {
      id: 'minimal',
      shutdown: vi.fn().mockResolvedValue(undefined),
      setIdentity: vi.fn(),
      initialize: vi.fn().mockResolvedValue(true),
      isConnected: vi.fn().mockReturnValue(true),
      getStatus: vi.fn().mockReturnValue('connected'),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      // NO awaitNextFlush.
    } as unknown as TokenStorageProvider<TxfStorageDataBase>;
    const { sphere } = createHarness({
      providersWithFlush: [minimal as unknown as SpyTokenProviderWithFlush],
    });

    await expect(sphere.destroy()).resolves.toBeUndefined();
    expect(minimal.shutdown).toHaveBeenCalledTimes(1);
  });
});

describe('Sphere.flushPending() — explicit public API', () => {
  it('calls awaitNextFlush on each provider with the supplied timeout', async () => {
    const p1 = makeSpyTokenProvider('p1');
    const p2 = makeSpyTokenProvider('p2');
    const { sphere } = createHarness({ providersWithFlush: [p1, p2] });

    await sphere.flushPending(15_000);

    expect(p1.awaitNextFlush).toHaveBeenCalledWith(15_000);
    expect(p2.awaitNextFlush).toHaveBeenCalledWith(15_000);
  });

  it('defaults to 30 000 ms', async () => {
    const p1 = makeSpyTokenProvider('p1');
    const { sphere } = createHarness({ providersWithFlush: [p1] });
    await sphere.flushPending();
    expect(p1.awaitNextFlush).toHaveBeenCalledWith(30_000);
  });

  it('returns normally even when one provider throws', async () => {
    const failing = makeSpyTokenProvider('failing', { flushThrows: true });
    const ok = makeSpyTokenProvider('ok');
    const { sphere } = createHarness({ providersWithFlush: [failing, ok] });

    await expect(sphere.flushPending()).resolves.toBeUndefined();
    expect(ok.awaitNextFlush).toHaveBeenCalled();
  });

  it('no-ops when sphere is not initialized', async () => {
    const p1 = makeSpyTokenProvider('p1');
    const { sphere } = createHarness({ providersWithFlush: [p1] });
    (sphere as unknown as { _initialized: boolean })._initialized = false;
    await sphere.flushPending();
    expect(p1.awaitNextFlush).not.toHaveBeenCalled();
  });
});
