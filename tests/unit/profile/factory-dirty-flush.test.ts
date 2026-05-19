/**
 * Tests for Item #15 Phase C.3 — the dirty-flush closure that
 * `profile/factory.ts` wires into `ProfileTokenStorageProvider` via
 * the `onProfileDirtyFlush` option.
 *
 * The closure body is exposed as `runProfileDirtyFlush(deps)` for
 * isolated testing. Production wiring constructs `deps` from the
 * live providers; here we stub every I/O surface so the test
 * focuses on the closure's bail / sequence / propagation semantics:
 *
 *   1. Bails (no I/O) when no chainPubkey is bound.
 *   2. Bails when network is null/undefined.
 *   3. Bails when the pointer layer is not yet ready.
 *   4. On the happy path: builds → pins → publishes, in order, once.
 *   5. Publishes the snapshot's rootCid (NOT the bundle CID).
 *   6. Build failure → propagates (caller surfaces via storage:error).
 *   7. Pin failure → propagates.
 *   8. Publish failure → propagates.
 *
 * @see profile/factory.ts — runProfileDirtyFlush + createProfileProviders
 * @see docs/uxf/OUTBOX-SEND-FOLLOWUPS.md — Item #15 Phase C.3
 */

import { describe, expect, it, vi } from 'vitest';
import {
  runProfileDirtyFlush,
  type ProfileDirtyFlushDeps,
} from '../../../profile/factory.js';
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

function makePointer(
  publish = vi.fn(async () => ({}) as unknown as ReturnType<ProfilePointerLayer['publish']>),
): { pointer: ProfilePointerLayer; publish: typeof publish } {
  const pointer = { publish } as unknown as ProfilePointerLayer;
  return { pointer, publish };
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
    const publish = vi.fn();
    const pointer = { publish } as unknown as ProfilePointerLayer;
    await runProfileDirtyFlush(
      makeDeps({
        getChainPubkey: () => null,
        buildSnapshot: build,
        pin,
        getPointerLayer: () => pointer,
      }),
    );
    expect(build).not.toHaveBeenCalled();
    expect(pin).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('bails silently when network is null', async () => {
    const build = vi.fn();
    const pin = vi.fn();
    const publish = vi.fn();
    const pointer = { publish } as unknown as ProfilePointerLayer;
    await runProfileDirtyFlush(
      makeDeps({
        getNetwork: () => null,
        buildSnapshot: build,
        pin,
        getPointerLayer: () => pointer,
      }),
    );
    expect(build).not.toHaveBeenCalled();
    expect(pin).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('bails silently when the pointer layer is not ready', async () => {
    const build = vi.fn();
    const pin = vi.fn();
    await runProfileDirtyFlush(
      makeDeps({
        getPointerLayer: () => null,
        buildSnapshot: build,
        pin,
      }),
    );
    expect(build).not.toHaveBeenCalled();
    expect(pin).not.toHaveBeenCalled();
  });

  it('bails silently when chainPubkey is empty string', async () => {
    const build = vi.fn();
    const pin = vi.fn();
    await runProfileDirtyFlush(
      makeDeps({
        getChainPubkey: () => '',
        buildSnapshot: build,
        pin,
      }),
    );
    expect(build).not.toHaveBeenCalled();
    expect(pin).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('runProfileDirtyFlush — happy path', () => {
  it('builds → pins → publishes in order, exactly once', async () => {
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
    const { pointer, publish } = makePointer(
      vi.fn(async (producer) => {
        const cidBytes = await producer();
        // Confirm what we publish IS the snapshot's rootCid.
        expect(cidBytes).toBeInstanceOf(Uint8Array);
        order.push('publish');
        return {} as unknown as ReturnType<ProfilePointerLayer['publish']>;
      }) as ProfilePointerLayer['publish'],
    );

    await runProfileDirtyFlush(
      makeDeps({
        getPointerLayer: () => pointer,
        buildSnapshot,
        pin,
      }),
    );

    expect(order).toEqual(['build', 'pin', 'publish']);
    expect(buildSnapshot).toHaveBeenCalledTimes(1);
    expect(pin).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('publishes the snapshot rootCid (not arbitrary bytes)', async () => {
    // Use a known CID and inspect what the publish producer hands back.
    const { CID } = await import('multiformats/cid');
    const expectedBytes = CID.parse(FAKE_CID).bytes;
    let observedBytes: Uint8Array | null = null;
    const { pointer } = makePointer(
      vi.fn(async (producer) => {
        observedBytes = await producer();
        return {} as unknown as ReturnType<ProfilePointerLayer['publish']>;
      }) as ProfilePointerLayer['publish'],
    );

    await runProfileDirtyFlush(
      makeDeps({
        getPointerLayer: () => pointer,
        buildSnapshot: async () => buildResult(FAKE_CID),
      }),
    );

    expect(observedBytes).not.toBeNull();
    expect(Buffer.from(observedBytes!).equals(Buffer.from(expectedBytes))).toBe(true);
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
    const publish = vi.fn();
    const pointer = { publish } as unknown as ProfilePointerLayer;
    await expect(
      runProfileDirtyFlush(
        makeDeps({ buildSnapshot, pin, getPointerLayer: () => pointer }),
      ),
    ).rejects.toThrow('build failed');
    expect(pin).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('propagates pin errors up to the caller', async () => {
    const pin = vi.fn(async () => {
      throw new Error('pin failed');
    });
    const publish = vi.fn();
    const pointer = { publish } as unknown as ProfilePointerLayer;
    await expect(
      runProfileDirtyFlush(
        makeDeps({ pin, getPointerLayer: () => pointer }),
      ),
    ).rejects.toThrow('pin failed');
    expect(publish).not.toHaveBeenCalled();
  });

  it('propagates publish errors up to the caller', async () => {
    const { pointer } = makePointer(
      vi.fn(async () => {
        throw new Error('publish failed');
      }) as ProfilePointerLayer['publish'],
    );
    await expect(
      runProfileDirtyFlush(makeDeps({ getPointerLayer: () => pointer })),
    ).rejects.toThrow('publish failed');
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
    const deps: ProfileDirtyFlushDeps = {
      getChainPubkey: () => chainPubkey,
      getNetwork: () => network,
      getPointerLayer: () => pointer,
      buildSnapshot,
      pin,
    };

    // Call 1 — no identity bound; bail.
    await runProfileDirtyFlush(deps);
    expect(buildSnapshot).not.toHaveBeenCalled();

    // Call 2 — identity bound, but no pointer; still bail.
    chainPubkey = '02' + 'aa'.repeat(32);
    network = 'testnet';
    await runProfileDirtyFlush(deps);
    expect(buildSnapshot).not.toHaveBeenCalled();

    // Call 3 — everything wired; fire.
    const publish = vi.fn(async () => ({}) as unknown as ReturnType<ProfilePointerLayer['publish']>);
    pointer = { publish } as unknown as ProfilePointerLayer;
    await runProfileDirtyFlush(deps);
    expect(buildSnapshot).toHaveBeenCalledTimes(1);
    expect(pin).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
