/**
 * Issue #319 — `ProfilePointerLayer.clearBlockedIfTransient()`.
 *
 * Self-healing clear of the BLOCKED flag when its reason is a
 * transient-connectivity class. Invoked by the pointer-poll worker
 * after a successful `recoverLatest()` round-trip refutes the prior
 * "aggregator unreachable" reason.
 *
 * SPEC §10.2.4 — transient-only auto-clear; persistent classes still
 * require operator action.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  setBlocked,
  isBlocked,
  DURABLE_STORAGE,
  FlagStore,
  AggregatorPointerError,
  AggregatorPointerErrorCode,
} from '../../../../extensions/uxf/profile/aggregator-pointer/index.js';
import { ProfilePointerLayer } from '../../../../extensions/uxf/profile/aggregator-pointer/ProfilePointerLayer.js';
import type { BlockedReason } from '../../../../extensions/uxf/profile/aggregator-pointer/blocked-state.js';

function makeDurableStore() {
  const kv = new Map<string, string>();
  return {
    get: async (k: string) => kv.get(k) ?? null,
    set: async (k: string, v: string) => {
      kv.set(k, v);
    },
    remove: async (k: string) => {
      kv.delete(k);
    },
    has: async (k: string) => kv.has(k),
    keys: async () => [...kv.keys()],
    clear: async () => {
      kv.clear();
    },
    setIdentity: () => {},
    saveTrackedAddresses: async () => {},
    loadTrackedAddresses: async () => [],
    initialize: async () => {},
    shutdown: async () => {},
    name: 'test',
    [DURABLE_STORAGE]: true as const,
  };
}

const PUBKEY = '02' + 'ab'.repeat(32);

function makeLayer(flagStore: FlagStore): ProfilePointerLayer {
  // Minimal init — clearBlockedIfTransient only reaches into flagStore.
  // The other dependencies are stubbed to satisfy the constructor.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const init: any = {
    config: { allowOperatorOverrides: false },
    keyMaterial: {},
    signer: {},
    aggregatorClient: {},
    trustBase: {},
    flagStore,
    mutex: {},
    decodeCid: () => null,
    fetchCar: async () => null,
    fetchAndJoin: async () => ({}),
    readLocalVersion: async () => 0,
    persistLocalVersion: async () => {},
    resolveRemoteCid: async () => null,
  };
  return new ProfilePointerLayer(init);
}

describe('ProfilePointerLayer.clearBlockedIfTransient (issue #319)', () => {
  let store: ReturnType<typeof makeDurableStore>;
  let fs: FlagStore;
  let layer: ProfilePointerLayer;

  beforeEach(() => {
    store = makeDurableStore();
    fs = FlagStore.create(store as never, PUBKEY);
    layer = makeLayer(fs);
  });

  it('no-op when nothing is blocked', async () => {
    const result = await layer.clearBlockedIfTransient();
    expect(result.cleared).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it('clears retry_exhausted (primary repro from issue #319)', async () => {
    await setBlocked(fs, 'retry_exhausted');
    const result = await layer.clearBlockedIfTransient();
    expect(result.cleared).toBe(true);
    expect(result.reason).toBe('retry_exhausted');
    expect((await isBlocked(fs)).blocked).toBe(false);
  });

  it.each<BlockedReason>(['network_timeout', 'dns_failure', 'tls_failure'])(
    'clears transient connectivity reason: %s',
    async (reason) => {
      await setBlocked(fs, reason);
      const result = await layer.clearBlockedIfTransient();
      expect(result.cleared).toBe(true);
      expect(result.reason).toBe(reason);
      expect((await isBlocked(fs)).blocked).toBe(false);
    },
  );

  it.each<BlockedReason>([
    'aggregator_rejected',
    'protocol_error',
    'marker_corrupt',
    'rejected',
  ])(
    'leaves persistent reason untouched and reports it back: %s',
    async (reason) => {
      await setBlocked(fs, reason);
      const result = await layer.clearBlockedIfTransient();
      expect(result.cleared).toBe(false);
      expect(result.reason).toBe(reason);
      // Block flag survived — operator action still required.
      const state = await isBlocked(fs);
      expect(state.blocked).toBe(true);
      expect(state.reason).toBe(reason);
    },
  );

  it('does NOT consult allowOperatorOverrides — self-clear bypasses the operator gate', async () => {
    // The constructed layer has `allowOperatorOverrides: false`; this
    // should not block the transient-self-heal path. Operator-gated
    // `clearBlocked()` would reject in this config — that's the
    // intentional behavioral difference.
    await setBlocked(fs, 'retry_exhausted');
    const result = await layer.clearBlockedIfTransient();
    expect(result.cleared).toBe(true);
    expect((await isBlocked(fs)).blocked).toBe(false);
  });

  it('refuses to clear when the stored record is CORRUPT (fail-closed)', async () => {
    // Write a corrupt record directly — isBlocked() will throw CORRUPT.
    await (fs as unknown as { set(k: string, v: string): Promise<void> }).set(
      'blocked',
      'this-is-not-json',
    );
    const result = await layer.clearBlockedIfTransient();
    expect(result.cleared).toBe(false);
    expect(result.reason).toBeUndefined();
    // Corrupt record preserved — operator must investigate via the
    // existing CORRUPT surfacing paths.
    await expect(isBlocked(fs)).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.CORRUPT,
    });
  });

  it('refuses to clear when the stored record has an unrecognized reason (fail-closed)', async () => {
    // Forward-compat / attacker-injected reason. isBlocked throws CORRUPT.
    await (fs as unknown as { set(k: string, v: string): Promise<void> }).set(
      'blocked',
      JSON.stringify({ blocked: true, reason: 'future_reason', setAt: Date.now() }),
    );
    const result = await layer.clearBlockedIfTransient();
    expect(result.cleared).toBe(false);
    // Tampered record left in place — the existing operator-override
    // probe (`hasUnrecognizedBlockedReason`) and `clearBlocked` path
    // handle that case.
    await expect(isBlocked(fs)).rejects.toThrow(AggregatorPointerError);
  });

  it('is idempotent — second call after clear reports no-op', async () => {
    await setBlocked(fs, 'retry_exhausted');
    const first = await layer.clearBlockedIfTransient();
    expect(first.cleared).toBe(true);
    const second = await layer.clearBlockedIfTransient();
    expect(second.cleared).toBe(false);
    expect(second.reason).toBeUndefined();
  });

  it('refuses to clear when a concurrent writer flipped to a persistent reason between reads (TOCTOU)', async () => {
    // Steelman²³: between the initial readBlockedState and the
    // destructive clearBlockedFlag, a sibling process may write a
    // persistent reason. Simulate that race by patching the underlying
    // store so the SECOND read returns a persistent reason.
    await setBlocked(fs, 'retry_exhausted');

    // Patch FlagStore.get to return the persistent record on the
    // SECOND call only. The first call returns the real (transient)
    // record; the second call (our re-read) returns the simulated
    // sibling write.
    const realGet = (fs as unknown as { get: (k: string) => Promise<string | null> }).get.bind(fs);
    let callCount = 0;
    (fs as unknown as { get: (k: string) => Promise<string | null> }).get = async (k: string) => {
      callCount += 1;
      if (callCount === 2 && k === 'blocked') {
        // Sibling wrote a persistent reason between our reads.
        return JSON.stringify({
          blocked: true,
          reason: 'marker_corrupt',
          setAt: Date.now(),
        });
      }
      return realGet(k);
    };

    const result = await layer.clearBlockedIfTransient();
    expect(result.cleared).toBe(false);
    expect(result.reason).toBe('marker_corrupt');
    // Restore for the next assertion.
    (fs as unknown as { get: (k: string) => Promise<string | null> }).get = realGet;
    // The persistent reason is what's now persisted — the original
    // retry_exhausted record was logically superseded by the sibling
    // write (the test simulates that).
  });

  it('refuses to clear when the reason changed to a different transient reason between reads', async () => {
    // Steelman²³: edge case — sibling wrote a DIFFERENT transient
    // reason between our reads. We must report the current reason
    // (not the stale one we initially observed) so callers see the
    // up-to-date state.
    await setBlocked(fs, 'retry_exhausted');

    const realGet = (fs as unknown as { get: (k: string) => Promise<string | null> }).get.bind(fs);
    let callCount = 0;
    (fs as unknown as { get: (k: string) => Promise<string | null> }).get = async (k: string) => {
      callCount += 1;
      if (callCount === 2 && k === 'blocked') {
        return JSON.stringify({
          blocked: true,
          reason: 'network_timeout',
          setAt: Date.now(),
        });
      }
      return realGet(k);
    };

    const result = await layer.clearBlockedIfTransient();
    expect(result.cleared).toBe(false);
    expect(result.reason).toBe('network_timeout');
    (fs as unknown as { get: (k: string) => Promise<string | null> }).get = realGet;
  });

  it('handles concurrent clears gracefully — both calls converge on cleared state', async () => {
    // Both calls observe the same transient reason throughout (no
    // sibling-write race), so both clear without error. The final
    // state is unambiguously cleared. The mock store has no
    // compare-and-swap, so we don't assert which call "won"; the
    // correctness property is the absence of an incorrect persistent-
    // reason clobber, which is verified by the dedicated TOCTOU test
    // above.
    await setBlocked(fs, 'retry_exhausted');
    const results = await Promise.all([
      layer.clearBlockedIfTransient(),
      layer.clearBlockedIfTransient(),
    ]);
    // Both reads observed the same transient reason → both proceed
    // to clear. Neither throws.
    for (const r of results) {
      expect(r.cleared).toBe(true);
      expect(r.reason).toBe('retry_exhausted');
    }
    expect((await isBlocked(fs)).blocked).toBe(false);
  });
});
