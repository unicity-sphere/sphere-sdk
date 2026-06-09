/**
 * Regression pin (sphere-sdk#448): `Sphere.initializeModules` MUST call
 * `mux.armSubscriptions()` AFTER the `Promise.allSettled([...module.load()])`
 * resolves — NEVER inline during `ensureTransportMux()` and NEVER before
 * the await.
 *
 * Background (#442/#443):
 *   - `ensureTransportMux()` calls `suppressSubscriptions()` BEFORE
 *     `mux.connect()`, so the relay subscription is gated closed during
 *     module load.
 *   - `Sphere.initializeModules` then runs every non-critical module's
 *     `load()` inside `Promise.allSettled`. Late-registering DM consumers
 *     (SwapModule fan-out, AccountingModule listeners) attach their
 *     `communications.onDirectMessage(...)` subscribers from inside `load()`.
 *   - Only AFTER `Promise.allSettled` resolves does Sphere call
 *     `mux.armSubscriptions()` (Sphere.ts:7769-7778), opening the relay
 *     subscription with every late handler already wired.
 *
 * The 8 unit tests in `MultiAddressTransportMux.subscribeGate442.test.ts`
 * pin the gate semantics at the mux level. They do NOT observe the
 * Sphere bootstrap ordering — if a future PR accidentally calls
 * `armSubscriptions` inline during `ensureTransportMux`, or moves the
 * post-`allSettled` arm above the await, every mux-level gate test still
 * passes and every existing Sphere init test still passes, because none
 * of them observe gate state DURING module load.
 *
 * This test wires a spy onto `CommunicationsModule.prototype.load` that
 * records `mux.isSubscriptionsArmed()` at entry, after a microtask, and
 * just before returning. All three samples MUST be `false`. After
 * `Sphere.init` resolves, the gate MUST be `true`.
 *
 * A second variant flips the spied `load()` into a thrower to confirm
 * the `Promise.allSettled` swallow path does not bypass the post-await
 * arm — even when a non-critical module rejects, the gate still arms
 * exactly once after the allSettled resolution.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock NostrClient — same pattern as
// `tests/unit/transport/MultiAddressTransportMux.subscribeGate442.test.ts`.
// The mux's connect() will instantiate this and immediately report
// `isConnected() === true`. `subscribe`/`unsubscribe` are tracked so we can
// assert relay traffic if needed; no real socket is opened.
// ---------------------------------------------------------------------------
const mockSubscribe = vi.fn().mockReturnValue('mock-sub-id');
const mockUnsubscribe = vi.fn();
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn();
const mockIsConnected = vi.fn().mockReturnValue(true);
const mockGetConnectedRelays = vi.fn().mockReturnValue(new Set(['wss://relay1.test']));
const mockAddConnectionListener = vi.fn();
const mockRemoveConnectionListener = vi.fn();
const mockPublishEvent = vi.fn().mockResolvedValue('mock-event-id');

const NostrClientCtor = vi.fn().mockImplementation(() => ({
  connect: mockConnect,
  disconnect: mockDisconnect,
  isConnected: mockIsConnected,
  getConnectedRelays: mockGetConnectedRelays,
  subscribe: mockSubscribe,
  unsubscribe: mockUnsubscribe,
  publishEvent: mockPublishEvent,
  addConnectionListener: mockAddConnectionListener,
  removeConnectionListener: mockRemoveConnectionListener,
}));

vi.mock('@unicitylabs/nostr-js-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@unicitylabs/nostr-js-sdk')>();
  return {
    ...actual,
    NostrClient: NostrClientCtor,
  };
});

// Mock L1 network so the default-enabled L1 module doesn't open a real
// Fulcrum WebSocket. Same pattern as the other Sphere init tests
// (e.g. `Sphere.status.test.ts`, `Sphere.subscribe-before-init.test.ts`).
vi.mock('../../../l1/network', () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  isWebSocketConnected: vi.fn().mockReturnValue(false),
}));

import type { OracleProvider } from '../../../oracle';
import type { StorageProvider } from '../../../storage';
import type { TransportProvider, WebSocketFactory } from '../../../transport';
import type { ProviderStatus } from '../../../types';

// Dynamic imports — must come AFTER `vi.mock` so the mocked NostrClient
// is in place when `core/Sphere` / `transport/MultiAddressTransportMux`
// load. Static imports would be hoisted ABOVE the mock and bind the
// real `NostrClient` symbol.
const { Sphere } = await import('../../../core/Sphere');
const { CommunicationsModule } = await import('../../../modules/communications/CommunicationsModule');
type Sphere = InstanceType<typeof Sphere>;
type CommunicationsModule = InstanceType<typeof CommunicationsModule>;

// ---------------------------------------------------------------------------
// Provider stubs
// ---------------------------------------------------------------------------

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
 * Build a mux-capable transport stub.
 *
 * Sphere.ensureTransportMux does a duck-type check for `getWebSocketFactory`
 * and `getConfiguredRelays` — present, mux is built; absent, mux path is
 * skipped. We need the mux path active so the gate is observable, so this
 * stub exposes both. The underlying NostrClient is the `vi.mock` above —
 * no real socket opens.
 *
 * The stub also exposes `suppressSubscriptions` so the outer-provider
 * suppression call in `ensureTransportMux` (Sphere.ts:4366-4368) does not
 * fail the typeof check and silently skip. (Failing the check is benign
 * for the mux-arm test, but matches the real Nostr provider shape.)
 */
function createMuxCapableTransport(): TransportProvider {
  const wsFactory: WebSocketFactory = (() => ({
    addEventListener: () => {},
    removeEventListener: () => {},
    send: () => {},
    close: () => {},
    readyState: 1,
  })) as unknown as WebSocketFactory;

  return {
    id: 'mux-capable-transport',
    name: 'Mux-Capable Transport',
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
    getRelays: vi.fn(() => ['wss://relay1.test']),
    getConnectedRelays: vi.fn(() => ['wss://relay1.test']),
    // Duck-typed mux-capable surface — triggers `ensureTransportMux()`.
    getWebSocketFactory: vi.fn(() => wsFactory),
    getConfiguredRelays: vi.fn(() => ['wss://relay1.test']),
    getStorageAdapter: vi.fn(() => null),
    getNostrClient: vi.fn(() => null),
    // Outer-provider suppression hook — mirrors NostrTransportProvider.
    suppressSubscriptions: vi.fn(),
    armSubscriptions: vi.fn().mockResolvedValue(undefined),
  } as unknown as TransportProvider;
}

// ---------------------------------------------------------------------------
// Helpers: read the mux's gate state from two vantage points.
//
//   1. `readGateViaModule(this)` — reads via the module's own
//      `deps.transport`, which is the `AddressTransportAdapter` returned
//      by `mux.addAddress(...)`. The adapter exposes
//      `isSubscriptionsArmed()` as a delegate to the underlying mux. This
//      is the module-eye view of the gate during `load()`. Available
//      from inside the patched `load()` because Sphere wires `deps`
//      synchronously in `initialize()` BEFORE invoking `load()`.
//
//   2. `getMux(sphere)` — reads the mux directly off the Sphere instance
//      after `Sphere.init` has returned (sphere ref only available then).
//      Used for the post-init assertion that arming actually happened.
// ---------------------------------------------------------------------------

interface AdapterWithGate {
  isSubscriptionsArmed?: () => boolean;
}

interface CommsDeps {
  deps: { transport: AdapterWithGate } | null;
}

function readGateViaModule(mod: CommunicationsModule): boolean | 'no-adapter' | 'no-gate' {
  const deps = (mod as unknown as CommsDeps).deps;
  if (!deps) return 'no-adapter';
  const t = deps.transport;
  if (typeof t.isSubscriptionsArmed !== 'function') return 'no-gate';
  return t.isSubscriptionsArmed();
}

interface SphereWithMux {
  _transportMux: {
    isSubscriptionsArmed(): boolean;
  } | null;
}

function getMux(sphere: Sphere): SphereWithMux['_transportMux'] {
  return (sphere as unknown as SphereWithMux)._transportMux;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Sphere.initializeModules — mux subscription-gate arm order (#448)', () => {
  let storage: StorageProvider;
  let transport: TransportProvider;
  let oracle: OracleProvider;
  let originalCommsLoad: typeof CommunicationsModule.prototype.load;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsConnected.mockReturnValue(true);
    mockGetConnectedRelays.mockReturnValue(new Set(['wss://relay1.test']));
    mockSubscribe.mockReturnValue('mock-sub-id');

    if (Sphere.getInstance()) {
      (Sphere as unknown as { instance: null }).instance = null;
    }
    storage = createMockStorage();
    transport = createMuxCapableTransport();
    oracle = createMockOracle();

    // Stash the original load() so we can restore it after each test.
    originalCommsLoad = CommunicationsModule.prototype.load;
  });

  afterEach(async () => {
    CommunicationsModule.prototype.load = originalCommsLoad;
    if (Sphere.getInstance()) {
      try { await Sphere.getInstance()!.destroy(); } catch { /* ignore */ }
    }
    (Sphere as unknown as { instance: null }).instance = null;
  });

  it('gate stays CLOSED during module load() and OPENS only after Promise.allSettled resolves', async () => {
    // Snapshots of `isSubscriptionsArmed()` collected at three points
    // inside CommunicationsModule.load(): entry, after a microtask hop,
    // and immediately before return. Read via `this.deps.transport`
    // (the AddressTransportAdapter returned by `mux.addAddress`) which
    // delegates to the underlying mux. Every entry must be `false` —
    // arming MUST happen strictly after Promise.allSettled resolves.
    const snapshots: Array<{
      phase: 'entry' | 'microtask' | 'exit';
      armed: boolean | 'no-adapter' | 'no-gate';
    }> = [];

    CommunicationsModule.prototype.load = async function patchedLoad(this: CommunicationsModule) {
      snapshots.push({ phase: 'entry', armed: readGateViaModule(this) });
      // Yield to the event loop so a regression that arms via a
      // microtask-chained .then() inside ensureTransportMux still gets
      // caught — between entry and exit the gate MUST remain closed.
      await Promise.resolve();
      snapshots.push({ phase: 'microtask', armed: readGateViaModule(this) });
      const result = await originalCommsLoad.call(this);
      snapshots.push({ phase: 'exit', armed: readGateViaModule(this) });
      return result;
    };

    const result = await Sphere.init({
      storage,
      transport,
      oracle,
      autoGenerate: true,
    });

    // Sanity: mux was built — this test would be a no-op otherwise.
    const finalMux = getMux(result.sphere);
    expect(finalMux, 'mux must be built (verifies the transport stub triggers the mux path)').not.toBeNull();

    // All three load-time samples must be CLOSED.
    expect(snapshots).toHaveLength(3);
    for (const s of snapshots) {
      expect(
        s.armed,
        `gate must be closed at ${s.phase} (regression: arming happened inline / before allSettled)`,
      ).toBe(false);
    }

    // After Sphere.init resolves: gate MUST be open.
    expect(finalMux!.isSubscriptionsArmed()).toBe(true);
  });

  it('gate stays CLOSED during a load() that throws, then OPENS after Promise.allSettled swallows the rejection', async () => {
    // `Promise.allSettled` semantics: a rejected non-critical module load
    // MUST NOT prevent the post-allSettled arm. Sphere logs a warning and
    // continues. The gate must still flip to armed exactly once.
    const snapshots: Array<{
      phase: 'entry' | 'microtask';
      armed: boolean | 'no-adapter' | 'no-gate';
    }> = [];

    CommunicationsModule.prototype.load = async function patchedThrowingLoad(this: CommunicationsModule) {
      snapshots.push({ phase: 'entry', armed: readGateViaModule(this) });
      await Promise.resolve();
      snapshots.push({ phase: 'microtask', armed: readGateViaModule(this) });
      throw new Error('synthetic: CommunicationsModule.load() rejected');
    };

    // Sphere.init must NOT throw — Promise.allSettled swallows the rejection.
    const result = await Sphere.init({
      storage,
      transport,
      oracle,
      autoGenerate: true,
    });

    // Both load-time samples must be CLOSED.
    expect(snapshots).toHaveLength(2);
    for (const s of snapshots) {
      expect(
        s.armed,
        `gate must be closed at ${s.phase} (rejection path must not bypass the gate)`,
      ).toBe(false);
    }

    // After init resolves: gate MUST be armed — even though one module
    // load rejected, allSettled does not short-circuit the arm step.
    const finalMux = getMux(result.sphere);
    expect(finalMux).not.toBeNull();
    expect(finalMux!.isSubscriptionsArmed()).toBe(true);
  });
});
