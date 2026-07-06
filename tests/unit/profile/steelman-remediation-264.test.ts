/**
 * Issue #264 — steelman remediation tests.
 *
 * Pins the observability fixes from the remediation rounds. EVERY
 * test in this file MUST exercise production code, not re-implement
 * the predicate it claims to pin (the round-3 steelman caught the
 * prior version doing exactly that).
 *
 *   1. `ProfilePointerLayer.#discoverLatestVersionInner` — only
 *      overwrite `#lastProbeVersions` when `result.probeVersions`
 *      is non-empty. Drives the real `discoverLatestVersion` public
 *      method with a mocked `findLatestValidVersion` so the
 *      production conditional at ProfilePointerLayer.ts:541 is on
 *      the call stack.
 *
 *   2. `core/Sphere.bridgeProviderEvents` — the
 *      `storage:monotonicity-recovered` event from the provider is
 *      forwarded to a Sphere-level event with `providerId` attached.
 *      Drives the real `subscribeToProviderEvents` bridge code by
 *      registering a provider on a real Sphere instance and emitting
 *      the synthetic provider event.
 *
 *   3. `core/Sphere.maybeInstallPointerWinSubscription` — symmetric
 *      stub guards. Invokes the REAL private method (via cast) with
 *      stub pointers and asserts no throw + no subscription installed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.mock MUST be hoisted above the import that uses the module —
// vitest hoists vi.mock automatically, but the mocked module's exports
// must be accessible to the test (we capture the mock instance via the
// factory's closure variable).
const discoverMockState: {
  nextResult: {
    validV: number;
    includedV: number;
    probeVersions: ReadonlyArray<number>;
  };
} = {
  nextResult: { validV: 0, includedV: 0, probeVersions: [] },
};

vi.mock('../../../extensions/uxf/profile/aggregator-pointer/discover-algorithm.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../extensions/uxf/profile/aggregator-pointer/discover-algorithm.js')
  >('../../../extensions/uxf/profile/aggregator-pointer/discover-algorithm.js');
  return {
    ...actual,
    findLatestValidVersion: vi.fn(async () => {
      const r = discoverMockState.nextResult;
      return {
        validV: r.validV as unknown as never,
        includedV: r.includedV as unknown as never,
        probeVersions: r.probeVersions as unknown as never,
      };
    }),
    // Keep computeProbeFingerprint real so the test can assert
    // fingerprint-equality semantics end-to-end.
    computeProbeFingerprint: actual.computeProbeFingerprint,
  };
});

import {
  ProfilePointerLayer,
  buildPointerSigner,
  createMasterPrivateKey,
  derivePointerKeyMaterial,
  type PointerSigner,
} from '../../../extensions/uxf/profile/aggregator-pointer';
import { Sphere } from '../../../core/Sphere';
import type { ProfileDatabase, OrbitDbConfig } from '../../../extensions/uxf/profile/types';
import type { StorageProvider, TokenStorageProvider } from '../../../types';
import { ProfileTokenStorageProvider } from '../../../extensions/uxf/profile/profile-token-storage-provider';

async function buildRealSigner(): Promise<PointerSigner> {
  const seed = new Uint8Array(32).fill(0x42);
  const masterKey = createMasterPrivateKey(seed);
  const keyMaterial = derivePointerKeyMaterial(masterKey);
  return buildPointerSigner(keyMaterial.signingSeed);
}

async function buildLayer(): Promise<ProfilePointerLayer> {
  const signer = await buildRealSigner();
  return new ProfilePointerLayer({
    keyMaterial: { signingSeed: new Uint8Array(32), xorSeed: new Uint8Array(32) } as never,
    signer,
    aggregatorClient: {} as never,
    trustBase: {} as never,
    flagStore: {} as never,
    mutex: {} as never,
    decodeCid: (() => ({ bytes: new Uint8Array(0) })) as never,
    fetchCar: (async () => ({ bytes: new Uint8Array(0) })) as never,
    fetchAndJoin: async () => {},
    readLocalVersion: async () => 0 as never,
    persistLocalVersion: async () => {},
    resolveRemoteCid: async () => new Uint8Array(0),
  });
}

// ---------------------------------------------------------------------------
// Fix #4: probeHistory preservation across empty-probe discovery
// ---------------------------------------------------------------------------
//
// Drives the REAL `ProfilePointerLayer.discoverLatestVersion()` public
// method, which calls into `#discoverLatestVersionInner` (where the
// production guard lives at ProfilePointerLayer.ts:541). The mock for
// `findLatestValidVersion` controls what `result.probeVersions` looks
// like; the production conditional decides whether to overwrite
// `#lastProbeVersions`. We observe via the public `getProbeFingerprint()`.
// If the production guard were reverted to an unconditional assignment,
// fp2 would change to the empty-fingerprint output → test fails.

describe('ProfilePointerLayer — probeHistory preservation (#264)', () => {
  beforeEach(() => {
    discoverMockState.nextResult = { validV: 0, includedV: 0, probeVersions: [] };
  });
  afterEach(() => { vi.useRealTimers(); });

  it('discoverLatestVersion with empty probeVersions does NOT clobber a prior fingerprint', async () => {
    const layer = await buildLayer();
    // Round 1: drive discovery with a non-empty probe set → seeds
    // the real #lastProbeVersions through the production code path.
    discoverMockState.nextResult = { validV: 7, includedV: 5, probeVersions: [3, 4, 5] };
    await layer.discoverLatestVersion();
    const fp1 = await layer.getProbeFingerprint();
    expect(fp1.length).toBeGreaterThan(0); // sanity: real fingerprint computed

    // Round 2: drive discovery with EMPTY probeVersions (fast-path /
    // single-probe scenario). Production conditional MUST skip the
    // assignment → fingerprint unchanged.
    discoverMockState.nextResult = { validV: 7, includedV: 5, probeVersions: [] };
    await layer.discoverLatestVersion();
    const fp2 = await layer.getProbeFingerprint();
    expect(fp2).toBe(fp1);
  });

  it('discoverLatestVersion with a non-empty probeVersions OVERWRITES the prior fingerprint (sanity for the conditional)', async () => {
    const layer = await buildLayer();
    discoverMockState.nextResult = { validV: 7, includedV: 5, probeVersions: [3, 4, 5] };
    await layer.discoverLatestVersion();
    const fp1 = await layer.getProbeFingerprint();

    discoverMockState.nextResult = { validV: 11, includedV: 9, probeVersions: [8, 9, 10, 11] };
    await layer.discoverLatestVersion();
    const fp2 = await layer.getProbeFingerprint();
    expect(fp2).not.toBe(fp1);
  });

  it('cold-start fingerprint is empty; survives an empty-probe discovery; flips to non-empty on first real probe (#264)', async () => {
    const layer = await buildLayer();
    const fp0 = await layer.getProbeFingerprint();
    expect(fp0).toBe('');
    // Empty-probe discovery preserves the empty fingerprint.
    discoverMockState.nextResult = { validV: 0, includedV: 0, probeVersions: [] };
    await layer.discoverLatestVersion();
    const fp1 = await layer.getProbeFingerprint();
    expect(fp1).toBe('');
    // Tightening (round-4 steelman): a follow-on non-empty discovery
    // MUST actually flip the fingerprint to non-empty. Without this
    // assertion the "empty stays empty" test passes under a buggy
    // variant `if (length === 0) assign` because in that variant
    // empty preserves empty too — but a real probe-set wouldn't
    // produce a fingerprint.
    discoverMockState.nextResult = { validV: 7, includedV: 5, probeVersions: [3, 4, 5] };
    await layer.discoverLatestVersion();
    const fp2 = await layer.getProbeFingerprint();
    // `fp2.length > 0` is equivalent to `fp2 !== fp0` here (fp0 ===
    // ''), so we only assert the stronger condition.
    expect(fp2.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Fix #3: symmetric subscriber guard
// (Sphere.maybeInstallPointerWinSubscription)
// ---------------------------------------------------------------------------
//
// Drives the REAL private method via cast. The test stub pointer is
// returned from a mocked storage provider's `getPointerLayer()`; the
// method's guard must early-return cleanly without throwing and
// without registering a transport subscription.

function createMinimalSphereForGuardTest(opts: {
  pointer: unknown;
  subscribeToBroadcast?: (
    tags: string[],
    cb: (msg: { content: string }) => void,
  ) => () => void;
}): Sphere {
  // Build the most minimal Sphere we can inject our stub into, by
  // constructing via prototype and assigning only the fields the
  // private method touches:
  //   - this._storage.getPointerLayer()
  //   - this._transport.subscribeToBroadcast
  //   - this._pointerWinInstallInFlight
  //   - this._pointerWinSubscriptions
  //   - this._pointerWinSeen
  //
  // Object.create on the Sphere prototype is the canonical pattern used
  // elsewhere in this repo's test suite (search for `Object.create(Sphere`
  // — see Sphere.destroy-flush.test.ts) to test private methods without
  // running the full init pipeline.
  const sphere = Object.create(Sphere.prototype) as Sphere;
  const subscribeStub = opts.subscribeToBroadcast ?? (() => () => {});
  Object.assign(sphere, {
    _storage: { getPointerLayer: () => opts.pointer },
    _transport: { subscribeToBroadcast: subscribeStub },
    _pointerWinInstallInFlight: false,
    _pointerWinSubscriptions: new Map<string, () => void>(),
    _pointerWinSeen: new Set<string>(),
  });
  return sphere;
}

describe('Sphere.maybeInstallPointerWinSubscription — symmetric guard (#264)', () => {
  it('pointer stub WITHOUT winBroadcastsEnabled → early-return, no subscription, no throw', async () => {
    let subscribeCalls = 0;
    const sphere = createMinimalSphereForGuardTest({
      pointer: {
        getSignerForWinBroadcast: () => ({ signer: {}, signingPubKeyHex: 'abc' }),
      },
      subscribeToBroadcast: () => {
        subscribeCalls++;
        return () => {};
      },
    });
    // Invoke the REAL private method via cast.
    await expect(
      (sphere as unknown as {
        maybeInstallPointerWinSubscription: () => Promise<void>;
      }).maybeInstallPointerWinSubscription(),
    ).resolves.toBeUndefined();
    expect(subscribeCalls).toBe(0);
    const subs = (sphere as unknown as { _pointerWinSubscriptions: Map<string, unknown> })._pointerWinSubscriptions;
    expect(subs.size).toBe(0);
  });

  it('pointer with winBroadcastsEnabled() === false → early-return, no subscription, no throw', async () => {
    let subscribeCalls = 0;
    const sphere = createMinimalSphereForGuardTest({
      pointer: {
        winBroadcastsEnabled: () => false,
        getSignerForWinBroadcast: () => ({ signer: {}, signingPubKeyHex: 'abc' }),
      },
      subscribeToBroadcast: () => {
        subscribeCalls++;
        return () => {};
      },
    });
    await (sphere as unknown as {
      maybeInstallPointerWinSubscription: () => Promise<void>;
    }).maybeInstallPointerWinSubscription();
    expect(subscribeCalls).toBe(0);
  });

  it('pointer with winBroadcastsEnabled() returning truthy non-boolean (1) → fail-closed, no subscription (strict === true)', async () => {
    let subscribeCalls = 0;
    const sphere = createMinimalSphereForGuardTest({
      pointer: {
        winBroadcastsEnabled: () => 1 as unknown as boolean,
        getSignerForWinBroadcast: () => ({ signer: {}, signingPubKeyHex: 'abc' }),
      },
      subscribeToBroadcast: () => {
        subscribeCalls++;
        return () => {};
      },
    });
    await (sphere as unknown as {
      maybeInstallPointerWinSubscription: () => Promise<void>;
    }).maybeInstallPointerWinSubscription();
    // Strict-`=== true` policy: truthy non-boolean treated as flag=false.
    expect(subscribeCalls).toBe(0);
  });

  it('pointer with winBroadcastsEnabled() that THROWS → fail-closed via defensive try/catch (NOT outer broad catch) (R5)', async () => {
    // Steelman R5/R6: a misbehaving stub that violates the
    // "MUST NOT throw" accessor contract must be handled by the
    // INNER defensive try/catch, NOT the outer broad catch.
    // Distinguish the two paths by spying on the logger:
    //   - INNER (R5) path → `logger.debug('Sphere', 'pointer-win
    //     subscription: winBroadcastsEnabled() threw (accessor
    //     contract violation, treating as flag=false): ...')`
    //   - OUTER (R4) path → `logger.warn('Sphere', 'pointer-win
    //     subscription install failed (will retry on next event)
    //     ...')`
    //
    // Assert the SPECIFIC debug line + assert no warn was emitted,
    // so a regression that removes the inner try/catch would route
    // the throw to the outer catch and trip both assertions.
    const { logger } = await import('../../../core/logger');
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      let subscribeCalls = 0;
      const sphere = createMinimalSphereForGuardTest({
        pointer: {
          winBroadcastsEnabled: () => {
            throw new Error('synthetic accessor failure');
          },
          getSignerForWinBroadcast: () => ({ signer: {}, signingPubKeyHex: 'abc' }),
        },
        subscribeToBroadcast: () => {
          subscribeCalls++;
          return () => {};
        },
      });
      await expect(
        (sphere as unknown as {
          maybeInstallPointerWinSubscription: () => Promise<void>;
        }).maybeInstallPointerWinSubscription(),
      ).resolves.toBeUndefined();
      expect(subscribeCalls).toBe(0);
      const inFlight = (sphere as unknown as {
        _pointerWinInstallInFlight: boolean;
      })._pointerWinInstallInFlight;
      expect(inFlight).toBe(false);

      // INNER defensive path fired: specific debug line emitted.
      const debugCalls = debugSpy.mock.calls;
      const accessorViolationLog = debugCalls.find(
        (call) =>
          call[0] === 'Sphere' &&
          typeof call[1] === 'string' &&
          call[1].includes('accessor contract violation'),
      );
      expect(accessorViolationLog).toBeDefined();

      // OUTER broad catch did NOT fire: no "subscription install
      // failed" warn. A regression that removes the inner try/catch
      // would route the throw to the outer catch → this would fail.
      const installFailedWarn = warnSpy.mock.calls.find(
        (call) =>
          call[0] === 'Sphere' &&
          typeof call[1] === 'string' &&
          call[1].includes('subscription install failed'),
      );
      expect(installFailedWarn).toBeUndefined();
    } finally {
      debugSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('pointer with winBroadcastsEnabled() === true BUT missing getSignerForWinBroadcast → fail-closed, no subscription, no throw', async () => {
    let subscribeCalls = 0;
    const sphere = createMinimalSphereForGuardTest({
      pointer: {
        winBroadcastsEnabled: () => true,
        // No getSignerForWinBroadcast.
      },
      subscribeToBroadcast: () => {
        subscribeCalls++;
        return () => {};
      },
    });
    await (sphere as unknown as {
      maybeInstallPointerWinSubscription: () => Promise<void>;
    }).maybeInstallPointerWinSubscription();
    expect(subscribeCalls).toBe(0);
    // _pointerWinInstallInFlight reset in finally.
    const inFlight = (sphere as unknown as { _pointerWinInstallInFlight: boolean })._pointerWinInstallInFlight;
    expect(inFlight).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fix #6: Sphere bridge for storage:monotonicity-recovered
// ---------------------------------------------------------------------------
//
// Drives the REAL bridge code in core/Sphere.ts:subscribeToProviderEvents.
// We construct a minimal Sphere whose `_tokenStorageProviders` contains
// one provider with `onEvent`, then directly invoke
// `subscribeToProviderEvents` (via cast), emit a provider event, and
// assert the bridged Sphere event fires with the providerId-augmented
// payload.

interface FakeProvider {
  id: string;
  listeners: Array<(event: { type: string; timestamp: number; data?: unknown }) => void>;
  onEvent(cb: (event: { type: string; timestamp: number; data?: unknown }) => void): () => void;
  emit(event: { type: string; timestamp: number; data?: unknown }): void;
  isConnected(): boolean;
  getStatus(): 'connected' | 'disconnected' | 'error';
}

function createFakeProvider(id: string): FakeProvider {
  const listeners: FakeProvider['listeners'] = [];
  return {
    id,
    listeners,
    onEvent(cb) {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    emit(event) {
      for (const cb of [...listeners]) cb(event);
    },
    isConnected() { return true; },
    getStatus() { return 'connected'; },
  };
}

describe('Sphere — storage:monotonicity-recovered bridge (#264)', () => {
  it('forwards the provider event to a Sphere-level event with providerId attached, applying defaults for missing fields', async () => {
    const sphere = Object.create(Sphere.prototype) as Sphere;
    const fake = createFakeProvider('fake-provider-A');
    Object.assign(sphere, {
      _oracle: {},
      _transport: { /* no onEvent method → bridge skips the transport branch */ },
      _tokenStorageProviders: new Map([[fake.id, fake]]),
      _providerEventCleanups: [] as Array<() => void>,
      _lastProviderConnected: new Map<string, boolean>(),
      _disabledProviders: new Set<string>(),
      // Sphere routes emitEvent through this.eventHandlers (Map of
      // event type → Set<handler>). Initialize the Map so the real
      // emitEvent path can dispatch.
      eventHandlers: new Map<string, Set<(payload: unknown) => void>>(),
    });
    // Drive the REAL private bridge wiring.
    (sphere as unknown as {
      subscribeToProviderEvents: () => void;
    }).subscribeToProviderEvents();

    // Register a real handler via this.eventHandlers (the same Map
    // Sphere's public `on()` method uses). The bridge will call
    // `this.emitEvent(...)` which dispatches through this Map.
    const observed: unknown[] = [];
    const handlers = (sphere as unknown as {
      eventHandlers: Map<string, Set<(payload: unknown) => void>>;
    }).eventHandlers;
    handlers.set(
      'storage:monotonicity-recovered',
      new Set([(payload: unknown) => observed.push(payload)]),
    );

    // Provider emits the storage:monotonicity-recovered event.
    fake.emit({
      type: 'storage:monotonicity-recovered',
      timestamp: Date.now(),
      data: {
        recoveredTokenIds: ['_TA'],
        recoveredTokenCount: 1,
        // mergedUnknownBundleCids intentionally omitted → defaults to [].
        residualUnknownBundleCids: ['cidB'],
        residualUnknownBundleCount: 1,
        // residualTokenMissingIds / Count omitted → defaults.
        recoveredOutboxIdsDroppedAsSent: ['transfer-1'],
        recoveredOutboxIdsDroppedAsSentCount: 1,
        truncated: false,
      },
    });

    expect(observed).toHaveLength(1);
    const payload = observed[0] as {
      providerId: string;
      recoveredTokenIds: string[];
      recoveredTokenCount: number;
      mergedUnknownBundleCids: string[];
      mergedUnknownBundleCount: number;
      residualUnknownBundleCids: string[];
      residualUnknownBundleCount: number;
      residualTokenMissingIds: string[];
      residualTokenMissingCount: number;
      recoveredOutboxIdsDroppedAsSent: string[];
      recoveredOutboxIdsDroppedAsSentCount: number;
      truncated: boolean;
    };

    // providerId attached for fan-out attribution.
    expect(payload.providerId).toBe('fake-provider-A');
    // Passed-through fields.
    expect(payload.recoveredTokenIds).toEqual(['_TA']);
    expect(payload.recoveredTokenCount).toBe(1);
    expect(payload.residualUnknownBundleCids).toEqual(['cidB']);
    expect(payload.residualUnknownBundleCount).toBe(1);
    expect(payload.recoveredOutboxIdsDroppedAsSent).toEqual(['transfer-1']);
    expect(payload.truncated).toBe(false);
    // Defaults applied for missing fields.
    expect(payload.mergedUnknownBundleCids).toEqual([]);
    expect(payload.mergedUnknownBundleCount).toBe(0);
    expect(payload.residualTokenMissingIds).toEqual([]);
    expect(payload.residualTokenMissingCount).toBe(0);
  });

  it('does NOT forward unrelated storage events as storage:monotonicity-recovered', async () => {
    const sphere = Object.create(Sphere.prototype) as Sphere;
    const fake = createFakeProvider('fake-provider-B');
    Object.assign(sphere, {
      _oracle: {},
      _transport: { /* no onEvent method → bridge skips the transport branch */ },
      _tokenStorageProviders: new Map([[fake.id, fake]]),
      _providerEventCleanups: [] as Array<() => void>,
      _lastProviderConnected: new Map<string, boolean>(),
      _disabledProviders: new Set<string>(),
      // Sphere routes emitEvent through this.eventHandlers (Map of
      // event type → Set<handler>). Initialize the Map so the real
      // emitEvent path can dispatch.
      eventHandlers: new Map<string, Set<(payload: unknown) => void>>(),
    });
    (sphere as unknown as { subscribeToProviderEvents: () => void }).subscribeToProviderEvents();
    const observed: unknown[] = [];
    const handlers = (sphere as unknown as {
      eventHandlers: Map<string, Set<(payload: unknown) => void>>;
    }).eventHandlers;
    handlers.set(
      'storage:monotonicity-recovered',
      new Set([(payload: unknown) => observed.push(payload)]),
    );
    // Emit a different storage event — bridge MUST ignore.
    fake.emit({
      type: 'storage:saved',
      timestamp: Date.now(),
      data: { cid: 'bafy', tokenCount: 1 },
    });
    expect(observed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Defensive: silence unused-import warnings if TS complains.
// ---------------------------------------------------------------------------
void ProfileTokenStorageProvider;
type _t = StorageProvider | TokenStorageProvider | OrbitDbConfig | ProfileDatabase;
void (null as unknown as _t);
