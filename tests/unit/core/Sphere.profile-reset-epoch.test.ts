/**
 * Issue #310 — `sphere.profile.resetEpoch()` unit tests.
 *
 * The public surface is gated on Profile mode (the storage provider
 * MUST expose `getPointerLayer`). These tests use the same minimal
 * harness pattern as the sibling `Sphere.profile-wiring.test.ts`:
 * we construct an `Object.create(Sphere.prototype)` partial instance
 * with just the fields read by the resetEpoch path, then invoke the
 * private method via reflection.
 *
 * Coverage:
 *   - `sphere.profile === null` for non-Profile (legacy) storage
 *   - `sphere.profile` returns a handle for Profile-mode storage
 *   - `resetEpoch({reason})` bumps the local floor by +1
 *   - `resetEpoch` is idempotent (second call lands a NEW +1)
 *   - `resetEpoch` emits `profile:epoch-reset` with the right payload
 *   - `resetEpoch` writes the reason into local storage
 *   - `getEpochFloor()` returns the persisted floor
 *   - non-empty reason cap enforcement
 *   - OrbitDB adapter's `resetCorruptedLog` is invoked when available
 *   - OrbitDB adapter failure is non-fatal (epoch bump still happens)
 */

import { describe, it, expect, vi } from 'vitest';

import { Sphere } from '../../../core/Sphere';
import { SphereError } from '../../../core/errors';
import {
  LOCAL_EPOCH_FLOOR_KEY,
  LOCAL_EPOCH_RESET_REASON_KEY,
} from '../../../profile/pointer-wiring';
import { EPOCH_RESET_REASON_MAX_BYTES } from '../../../profile/profile-lean-snapshot';
import type { SphereEventMap } from '../../../types';

// =============================================================================
// Minimal storage stubs
// =============================================================================

interface InMemoryKv {
  readonly store: Map<string, string>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

function makeKv(): InMemoryKv {
  const store = new Map<string, string>();
  return {
    store,
    async get(k) {
      return store.get(k) ?? null;
    },
    async set(k, v) {
      store.set(k, v);
    },
  };
}

interface LegacyStorageStub extends InMemoryKv {}
interface ProfileStorageStub extends InMemoryKv {
  getPointerLayer(): unknown | null;
  getOrbitDbAdapter?(): {
    resetCorruptedLog?: (reason: {
      lostHeadCid?: string;
      context: string;
    }) => Promise<void>;
  } | null;
}

function makeLegacyStorage(): LegacyStorageStub {
  return makeKv();
}

function makeProfileStorage(opts: {
  withAdapter?: boolean;
  resetThrows?: boolean;
  resetCalls?: Array<{ context: string }>;
} = {}): ProfileStorageStub {
  const kv = makeKv();
  const result: ProfileStorageStub = {
    ...kv,
    getPointerLayer: () => ({}), // any truthy value is enough; the
                                 // Sphere code only checks the method's
                                 // presence
  };
  if (opts.withAdapter) {
    result.getOrbitDbAdapter = () => ({
      resetCorruptedLog: async (reason) => {
        opts.resetCalls?.push({ context: reason.context });
        if (opts.resetThrows) {
          throw new Error('synthetic adapter failure');
        }
      },
    });
  }
  return result;
}

// =============================================================================
// Sphere harness
// =============================================================================

interface SphereLike {
  _storage: unknown;
  _tokenStorageProviders: Map<string, unknown>;
  eventHandlers: Map<string, Set<(data: unknown) => void>>;
  profile: ReturnType<Sphere['profile']['valueOf']> extends never
    ? unknown
    : Sphere['profile'];
}

function buildSphereLike(storage: unknown): {
  sphere: Sphere;
  events: Array<{ type: string; payload: unknown }>;
} {
  // Object.create(Sphere.prototype) keeps the prototype chain so the
  // `get profile()` accessor + the private `resetEpochImpl` are
  // reachable. We only populate the fields actually read by the
  // resetEpoch code path.
  const sphereLike = Object.create(Sphere.prototype) as SphereLike;
  sphereLike._storage = storage;
  sphereLike._tokenStorageProviders = new Map();
  sphereLike.eventHandlers = new Map();

  const events: Array<{ type: string; payload: unknown }> = [];
  // Subscribe via the public `on()` method to test the emit path.
  (sphereLike as unknown as Sphere).on(
    'profile:epoch-reset',
    (payload: SphereEventMap['profile:epoch-reset']) => {
      events.push({ type: 'profile:epoch-reset', payload });
    },
  );

  return { sphere: sphereLike as unknown as Sphere, events };
}

// =============================================================================
// Tests
// =============================================================================

describe('Sphere.profile — legacy storage', () => {
  it('returns null when storage has no getPointerLayer', () => {
    const { sphere } = buildSphereLike(makeLegacyStorage());
    expect(sphere.profile).toBeNull();
  });
});

describe('Sphere.profile — Profile-mode storage', () => {
  it('returns a non-null handle when storage exposes getPointerLayer', () => {
    const { sphere } = buildSphereLike(makeProfileStorage());
    const handle = sphere.profile;
    expect(handle).not.toBeNull();
    expect(typeof handle!.resetEpoch).toBe('function');
    expect(typeof handle!.getEpochFloor).toBe('function');
  });

  it('getEpochFloor() returns 0 for a fresh wallet', async () => {
    const { sphere } = buildSphereLike(makeProfileStorage());
    const floor = await sphere.profile!.getEpochFloor();
    expect(floor).toBe(0);
  });
});

describe('Sphere.profile.resetEpoch()', () => {
  it('throws NOT_PROFILE_MODE when called via reflection on legacy storage', async () => {
    // Defensive: the public `Sphere.profile` returns null for legacy
    // storage, so this path should be unreachable from a properly-
    // typed caller. Test the defensive throw anyway.
    const storage = makeLegacyStorage();
    const { sphere } = buildSphereLike(storage);
    const resetEpochImpl = (sphere as unknown as {
      resetEpochImpl: (params: { reason: string }) => Promise<unknown>;
    }).resetEpochImpl.bind(sphere);

    await expect(
      resetEpochImpl({ reason: 'test' }),
    ).rejects.toThrowError(SphereError);
    await expect(
      resetEpochImpl({ reason: 'test' }),
    ).rejects.toMatchObject({ code: 'NOT_PROFILE_MODE' });
  });

  it('rejects empty reason', async () => {
    const { sphere } = buildSphereLike(makeProfileStorage());
    await expect(
      sphere.profile!.resetEpoch({ reason: '' }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('rejects oversized reason', async () => {
    const { sphere } = buildSphereLike(makeProfileStorage());
    const bigReason = 'a'.repeat(EPOCH_RESET_REASON_MAX_BYTES + 1);
    await expect(
      sphere.profile!.resetEpoch({ reason: bigReason }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('persists epoch=1 on a fresh wallet (no prior reset)', async () => {
    const storage = makeProfileStorage();
    const { sphere, events } = buildSphereLike(storage);

    const result = await sphere.profile!.resetEpoch({
      reason: 'oplog-corruption-recovery',
    });

    expect(result.newEpoch).toBe(1);
    expect(result.reason).toBe('oplog-corruption-recovery');
    expect(typeof result.ts).toBe('number');

    // Local floor + reason persisted.
    expect(await storage.get(LOCAL_EPOCH_FLOOR_KEY)).toBe('1');
    expect(await storage.get(LOCAL_EPOCH_RESET_REASON_KEY)).toBe(
      'oplog-corruption-recovery',
    );

    // Event emitted.
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('profile:epoch-reset');
    expect(events[0].payload).toMatchObject({
      newEpoch: 1,
      reason: 'oplog-corruption-recovery',
    });
  });

  it('is idempotent — second call lands a NEW epoch+1 (does NOT skip)', async () => {
    const storage = makeProfileStorage();
    const { sphere, events } = buildSphereLike(storage);

    const first = await sphere.profile!.resetEpoch({ reason: 'first' });
    expect(first.newEpoch).toBe(1);

    const second = await sphere.profile!.resetEpoch({ reason: 'second' });
    expect(second.newEpoch).toBe(2);

    const third = await sphere.profile!.resetEpoch({ reason: 'third' });
    expect(third.newEpoch).toBe(3);

    // Local floor reflects the LATEST reset's epoch.
    expect(await storage.get(LOCAL_EPOCH_FLOOR_KEY)).toBe('3');
    expect(await storage.get(LOCAL_EPOCH_RESET_REASON_KEY)).toBe('third');

    // Three distinct events emitted.
    expect(events).toHaveLength(3);
    expect((events[0].payload as { newEpoch: number }).newEpoch).toBe(1);
    expect((events[1].payload as { newEpoch: number }).newEpoch).toBe(2);
    expect((events[2].payload as { newEpoch: number }).newEpoch).toBe(3);
  });

  it('getEpochFloor reflects the persisted post-reset value', async () => {
    const storage = makeProfileStorage();
    const { sphere } = buildSphereLike(storage);

    await sphere.profile!.resetEpoch({ reason: 'first' });
    expect(await sphere.profile!.getEpochFloor()).toBe(1);

    await sphere.profile!.resetEpoch({ reason: 'second' });
    expect(await sphere.profile!.getEpochFloor()).toBe(2);
  });

  it('invokes OrbitDbAdapter.resetCorruptedLog when available', async () => {
    const resetCalls: Array<{ context: string }> = [];
    const storage = makeProfileStorage({
      withAdapter: true,
      resetCalls,
    });
    const { sphere } = buildSphereLike(storage);

    await sphere.profile!.resetEpoch({ reason: 'corrupt-block' });

    expect(resetCalls).toHaveLength(1);
    expect(resetCalls[0].context).toContain('corrupt-block');
  });

  it('continues with the epoch bump even when resetCorruptedLog throws', async () => {
    const storage = makeProfileStorage({
      withAdapter: true,
      resetThrows: true,
    });
    const { sphere, events } = buildSphereLike(storage);

    // Should NOT throw — the adapter failure is logged + swallowed.
    const result = await sphere.profile!.resetEpoch({ reason: 'recovery' });
    expect(result.newEpoch).toBe(1);

    // Floor is still persisted.
    expect(await storage.get(LOCAL_EPOCH_FLOOR_KEY)).toBe('1');

    // Event still fired.
    expect(events).toHaveLength(1);
  });

  it('treats a corrupted floor value as 0 (fail-closed)', async () => {
    const storage = makeProfileStorage();
    await storage.set(LOCAL_EPOCH_FLOOR_KEY, 'not-a-number');

    const { sphere } = buildSphereLike(storage);
    // Read returns 0 for garbage.
    expect(await sphere.profile!.getEpochFloor()).toBe(0);

    // Reset bumps from 0 → 1.
    const result = await sphere.profile!.resetEpoch({ reason: 'cleanup' });
    expect(result.newEpoch).toBe(1);
  });

  it('serializes concurrent resetEpoch calls — each lands its own +1 (NOT deduplicated)', async () => {
    // Two concurrent invocations should produce TWO distinct epoch
    // bumps. Without the per-instance mutex, both calls could observe
    // floor=0 in parallel and both write floor=1, silently merging
    // the second invocation's intent into the first.
    const storage = makeProfileStorage();
    const { sphere, events } = buildSphereLike(storage);

    const [a, b] = await Promise.all([
      sphere.profile!.resetEpoch({ reason: 'concurrent-a' }),
      sphere.profile!.resetEpoch({ reason: 'concurrent-b' }),
    ]);

    // Both calls succeeded with distinct epochs.
    const epochs = [a.newEpoch, b.newEpoch].sort();
    expect(epochs).toEqual([1, 2]);

    // Persisted floor reflects the LATEST bump.
    expect(await storage.get(LOCAL_EPOCH_FLOOR_KEY)).toBe('2');

    // Two distinct events emitted.
    expect(events).toHaveLength(2);
    const eventEpochs = events
      .map((e) => (e.payload as { newEpoch: number }).newEpoch)
      .sort();
    expect(eventEpochs).toEqual([1, 2]);
  });
});

// =============================================================================
// Second-device convergence simulation
// =============================================================================
//
// This is a thin integration check that the persisted epoch floor on
// device A would have caused device B's walkback (via the
// `initialEpochFloor` primer + the inspector callback) to skip a stale
// pre-reset version. The full walkback algorithm has its own integration
// coverage in `tests/unit/profile/pointer/discover-algorithm-epoch.test.ts`;
// this case pins the EXPECTED HAND-OFF SHAPE between resetEpoch's
// local-cache writes and the wiring layer's `readEpochFloor` callback.

describe('resetEpoch → discover-algorithm hand-off', () => {
  it('persists the floor in a key the pointer-wiring reader can consume', async () => {
    const storage = makeProfileStorage();
    const { sphere } = buildSphereLike(storage);

    await sphere.profile!.resetEpoch({ reason: 'corruption' });

    // The pointer-wiring layer reads from this exact key — the
    // module-level export pins the namespace contract.
    expect(LOCAL_EPOCH_FLOOR_KEY).toBe('profile.pointer.epoch_floor');
    expect(LOCAL_EPOCH_RESET_REASON_KEY).toBe(
      'profile.pointer.epoch_reset_reason',
    );

    const rawFloor = await storage.get(LOCAL_EPOCH_FLOOR_KEY);
    expect(rawFloor).toBe('1');

    // Simulate the wiring layer's read closure.
    const readEpochFloor = async (): Promise<number> => {
      const raw = await storage.get(LOCAL_EPOCH_FLOOR_KEY);
      if (raw === null) return 0;
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
        return 0;
      }
      return parsed;
    };
    expect(await readEpochFloor()).toBe(1);
  });
});
