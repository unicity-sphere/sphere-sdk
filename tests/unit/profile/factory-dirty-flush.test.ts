/**
 * Tests for Item #15 Phase C.3 (extended by D.1a) — the dirty-flush
 * closure that `profile/factory.ts` wires into
 * `ProfileTokenStorageProvider` via the `onProfileDirtyFlush` option.
 *
 * The closure body is exposed as `runProfileDirtyFlush(deps)` for
 * isolated testing. Production wiring constructs `deps` from the live
 * providers; here we stub every I/O surface so the test focuses on
 * the closure's bail / sequence / propagation semantics:
 *
 *   1. Bails (no I/O) when no chainPubkey is bound.
 *   2. Bails when network is null/undefined.
 *   3. Bails when the pointer layer is not yet ready.
 *   4. On the happy path: builds → pins → publishCid, in order, once.
 *   5. Publishes the snapshot's rootCid (NOT the bundle CID).
 *   6. Build failure → propagates (caller surfaces via storage:error).
 *   7. Pin failure → propagates.
 *   8. publishCid throw → propagates.
 *   9. publishCid transient → throws so the dispatcher emits the
 *      `storage:error` event.
 *  10. publishCid permanent (ok:false, transient:false) → swallows
 *      (the lifecycle layer already emitted its own storage:error).
 *
 * @see profile/factory.ts — runProfileDirtyFlush + createProfileProviders
 * @see docs/uxf/OUTBOX-SEND-FOLLOWUPS.md — Item #15 Phase C.3 / D.1a
 */

import { describe, expect, it, vi } from 'vitest';
import {
  runProfileDirtyFlush,
  type ProfileDirtyFlushDeps,
} from '../../../profile/factory.js';
import type { ProfileSnapshotPublishResult } from '../../../profile/types.js';
import type { BuildLeanProfileSnapshotResult } from '../../../profile/profile-lean-snapshot.js';
import type { ProfilePointerLayer } from '../../../profile/aggregator-pointer/index.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

// A real CIDv1 (raw codec) so `CID.parse` succeeds.
const FAKE_CID = 'bafkreigh2akiscaildc5xwhtwkkkjwxowwxuvvdzc6lkrymccq6n2lvzee';

function buildResult(
  rootCid: string = FAKE_CID,
  carBytes: Uint8Array = new Uint8Array([1, 2, 3]),
): BuildLeanProfileSnapshotResult {
  return {
    carBytes,
    entryCount: 0,
    bundleCount: 0,
    rootCid,
  };
}

function makePointer(): { pointer: ProfilePointerLayer } {
  // Phase D.1a — `runProfileDirtyFlush` no longer calls
  // `pointer.publish` directly; the pointer reference is used only as
  // a readiness probe. A bare object stub is enough.
  const pointer = {} as unknown as ProfilePointerLayer;
  return { pointer };
}

function makeDeps(
  overrides: Partial<ProfileDirtyFlushDeps> = {},
): ProfileDirtyFlushDeps {
  return {
    getChainPubkey: () => '02' + 'aa'.repeat(32),
    getNetwork: () => 'testnet',
    getPointerLayer: () => makePointer().pointer,
    buildSnapshot: vi.fn(async () => buildResult()),
    pin: vi.fn(async () => FAKE_CID),
    publishCid: vi.fn(async () => ({ ok: true, transient: false })),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Bail paths
// ---------------------------------------------------------------------------

describe('runProfileDirtyFlush — bail paths', () => {
  it('bails silently when chainPubkey is null', async () => {
    const build = vi.fn();
    const pin = vi.fn();
    const publishCid = vi.fn(async () => ({ ok: true, transient: false }));
    const result = await runProfileDirtyFlush(
      makeDeps({
        getChainPubkey: () => null,
        buildSnapshot: build,
        pin,
        publishCid,
      }),
    );
    expect(build).not.toHaveBeenCalled();
    expect(pin).not.toHaveBeenCalled();
    expect(publishCid).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      transient: false,
      code: 'NOT_READY_IDENTITY',
    });
  });

  it('bails silently when network is null', async () => {
    const build = vi.fn();
    const pin = vi.fn();
    const publishCid = vi.fn(async () => ({ ok: true, transient: false }));
    const result = await runProfileDirtyFlush(
      makeDeps({
        getNetwork: () => null,
        buildSnapshot: build,
        pin,
        publishCid,
      }),
    );
    expect(build).not.toHaveBeenCalled();
    expect(pin).not.toHaveBeenCalled();
    expect(publishCid).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      transient: false,
      code: 'NOT_READY_NETWORK',
    });
  });

  it('bails silently when the pointer layer is not ready', async () => {
    const build = vi.fn();
    const pin = vi.fn();
    const publishCid = vi.fn(async () => ({ ok: true, transient: false }));
    const result = await runProfileDirtyFlush(
      makeDeps({
        getPointerLayer: () => null,
        buildSnapshot: build,
        pin,
        publishCid,
      }),
    );
    expect(build).not.toHaveBeenCalled();
    expect(pin).not.toHaveBeenCalled();
    expect(publishCid).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      transient: false,
      code: 'NOT_READY_POINTER',
    });
  });

  it('bails silently when chainPubkey is empty string', async () => {
    const build = vi.fn();
    const pin = vi.fn();
    const publishCid = vi.fn(async () => ({ ok: true, transient: false }));
    const result = await runProfileDirtyFlush(
      makeDeps({
        getChainPubkey: () => '',
        buildSnapshot: build,
        pin,
        publishCid,
      }),
    );
    expect(build).not.toHaveBeenCalled();
    expect(pin).not.toHaveBeenCalled();
    expect(publishCid).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      transient: false,
      code: 'NOT_READY_IDENTITY',
    });
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('runProfileDirtyFlush — happy path', () => {
  it('builds → pins → publishCid in order, exactly once', async () => {
    const order: string[] = [];
    const carBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const buildSnapshot = vi.fn(async (chainPubkey, network) => {
      expect(chainPubkey).toBe('02' + 'aa'.repeat(32));
      expect(network).toBe('testnet');
      order.push('build');
      return buildResult(FAKE_CID, carBytes);
    });
    const pin = vi.fn(async (bytes) => {
      expect(bytes).toBe(carBytes);
      order.push('pin');
      return FAKE_CID;
    });
    const publishCid = vi.fn(async (cidString: string) => {
      // Confirm we publish the snapshot rootCid (not a bundle CID).
      expect(cidString).toBe(FAKE_CID);
      order.push('publish');
      return { ok: true, transient: false };
    });

    const result = await runProfileDirtyFlush(
      makeDeps({ buildSnapshot, pin, publishCid }),
    );

    expect(order).toEqual(['build', 'pin', 'publish']);
    expect(buildSnapshot).toHaveBeenCalledTimes(1);
    expect(pin).toHaveBeenCalledTimes(1);
    expect(publishCid).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, transient: false });
  });

  it('publishes the snapshot rootCid (not arbitrary bytes)', async () => {
    let observedCid: string | null = null;
    const publishCid = vi.fn(async (cidString: string) => {
      observedCid = cidString;
      return { ok: true, transient: false };
    });

    await runProfileDirtyFlush(
      makeDeps({
        buildSnapshot: async () => buildResult(FAKE_CID),
        publishCid,
      }),
    );

    expect(observedCid).toBe(FAKE_CID);
  });
});

// ---------------------------------------------------------------------------
// Error propagation
// ---------------------------------------------------------------------------

describe('runProfileDirtyFlush — error propagation', () => {
  it('propagates build errors up to the caller', async () => {
    const buildSnapshot = vi.fn(async () => {
      throw new Error('build failed');
    });
    const pin = vi.fn();
    const publishCid = vi.fn();
    await expect(
      runProfileDirtyFlush(makeDeps({ buildSnapshot, pin, publishCid })),
    ).rejects.toThrow('build failed');
    expect(pin).not.toHaveBeenCalled();
    expect(publishCid).not.toHaveBeenCalled();
  });

  it('propagates pin errors up to the caller', async () => {
    const pin = vi.fn(async () => {
      throw new Error('pin failed');
    });
    const publishCid = vi.fn();
    await expect(
      runProfileDirtyFlush(makeDeps({ pin, publishCid })),
    ).rejects.toThrow('pin failed');
    expect(publishCid).not.toHaveBeenCalled();
  });

  it('propagates publishCid throw up to the caller', async () => {
    const publishCid = vi.fn(async () => {
      throw new Error('publish failed');
    }) as unknown as () => Promise<ProfileSnapshotPublishResult>;
    await expect(
      runProfileDirtyFlush(makeDeps({ publishCid })),
    ).rejects.toThrow('publish failed');
  });

  it('throws on transient publishCid failure so the dispatcher surfaces it', async () => {
    const publishCid = vi.fn(async () => ({
      ok: false,
      transient: true,
      code: 'NETWORK_ERROR',
    }));
    await expect(
      runProfileDirtyFlush(makeDeps({ publishCid })),
    ).rejects.toThrow(/transient failure.*NETWORK_ERROR/);
  });

  it('returns permanent publishCid failure without throwing (lifecycle already alerted)', async () => {
    const publishCid = vi.fn(async () => ({
      ok: false,
      transient: false,
      code: 'AGGREGATOR_POINTER_REJECTED',
    }));
    const result = await runProfileDirtyFlush(makeDeps({ publishCid }));
    expect(result).toEqual({
      ok: false,
      transient: false,
      code: 'AGGREGATOR_POINTER_REJECTED',
    });
  });
});

// ---------------------------------------------------------------------------
// Each call evaluates deps fresh (no cached state)
// ---------------------------------------------------------------------------

describe('runProfileDirtyFlush — fresh evaluation', () => {
  it('re-reads chainPubkey / network / pointer on every invocation', async () => {
    let chainPubkey: string | null = null;
    let network: string | null = null;
    let pointer: ProfilePointerLayer | null = null;
    const buildSnapshot = vi.fn(async () => buildResult());
    const pin = vi.fn(async () => FAKE_CID);
    const publishCid = vi.fn(async () => ({ ok: true, transient: false }));
    const deps: ProfileDirtyFlushDeps = {
      getChainPubkey: () => chainPubkey,
      getNetwork: () => network,
      getPointerLayer: () => pointer,
      buildSnapshot,
      pin,
      publishCid,
    };

    // Call 1 — no identity bound; bail.
    await runProfileDirtyFlush(deps);
    expect(buildSnapshot).not.toHaveBeenCalled();
    expect(publishCid).not.toHaveBeenCalled();

    // Call 2 — identity bound, but no pointer; still bail.
    chainPubkey = '02' + 'aa'.repeat(32);
    network = 'testnet';
    await runProfileDirtyFlush(deps);
    expect(buildSnapshot).not.toHaveBeenCalled();
    expect(publishCid).not.toHaveBeenCalled();

    // Call 3 — everything wired; fire.
    pointer = {} as unknown as ProfilePointerLayer;
    await runProfileDirtyFlush(deps);
    expect(buildSnapshot).toHaveBeenCalledTimes(1);
    expect(pin).toHaveBeenCalledTimes(1);
    expect(publishCid).toHaveBeenCalledTimes(1);
  });
});
