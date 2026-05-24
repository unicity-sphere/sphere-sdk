/**
 * Issue #247 — `ProfilePointerLayer.reconcileLocalVersionDownward` unit tests.
 *
 * The reconcile-downward primitive is invoked by the lifecycle-manager's
 * WALKBACK_FLOOR catch arm to break a same-identity cross-device race:
 * two devices sharing one wallet identity each push localVersion ahead
 * of the aggregator's currently-visible value; both then hit W7
 * WALKBACK_FLOOR (per SPEC, deterministic-given-state) and the inner
 * retry budget exhausts without convergence.
 *
 * The primitive itself is intentionally narrow — it does NOT discover,
 * does NOT verify (the candidate must already have been authenticated
 * by `recoverLatest()` via XOR-decode under the wallet's signing
 * identity), and does NOT touch OrbitDB. It only:
 *
 *   1. Reads the current localVersion.
 *   2. If `candidate.version < localVersion`, persists the lower value.
 *   3. Returns a result describing what happened.
 *
 * Coverage:
 *   - Strictly-lower candidate → reconciled=true, persistLocalVersion called.
 *   - Equal-version candidate → reconciled=false, persist NOT called.
 *   - Higher-version candidate → reconciled=false, persist NOT called.
 *   - shutdown()-in-progress → rejects with PUBLISH_BUSY.
 *
 * The same-author-only safety invariant is enforced by recoverLatest's
 * XOR-decode pipeline (see method docstring) — a foreign-author
 * candidate never reaches `reconcileLocalVersionDownward` as a non-null
 * RecoverResult. We assert that downstream property via an integration-
 * style test in lifecycle-manager-reconcile-downward.test.ts; here we
 * cover the primitive's mechanics in isolation.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  AggregatorPointerErrorCode,
} from '../../../../profile/aggregator-pointer/errors';
import { ProfilePointerLayer, type RecoverResult } from '../../../../profile/aggregator-pointer/ProfilePointerLayer';
import type { PointerVersion } from '../../../../profile/aggregator-pointer/types';

// ── Fixtures ───────────────────────────────────────────────────────────────

/**
 * Build a minimal ProfilePointerLayer with `readLocalVersion` /
 * `persistLocalVersion` controllable via the returned handles. All
 * other deps are stubs — `reconcileLocalVersionDownward` does not
 * invoke any of them. Cast to `any` so the test does not have to
 * model every field's type; we exercise behavior, not shape.
 */
function buildLayer(initialLocalVersion: number): {
  layer: ProfilePointerLayer;
  persistSpy: ReturnType<typeof vi.fn>;
  currentLocalVersion(): number;
} {
  let storedVersion = initialLocalVersion;
  const persistSpy = vi.fn(async (v: number) => {
    storedVersion = v;
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const init: any = {
    keyMaterial: {},
    signer: {},
    aggregatorClient: {},
    trustBase: {},
    flagStore: {},
    mutex: {},
    decodeCid: () => null,
    fetchCar: async () => null,
    fetchAndJoin: async () => undefined,
    readLocalVersion: async () => storedVersion as PointerVersion,
    persistLocalVersion: persistSpy,
    resolveRemoteCid: async () => new Uint8Array(0),
  };
  const layer = new ProfilePointerLayer(init);
  return {
    layer,
    persistSpy,
    currentLocalVersion: () => storedVersion,
  };
}

function recoverResult(version: number): RecoverResult {
  return {
    cid: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    version: version as PointerVersion,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ProfilePointerLayer.reconcileLocalVersionDownward', () => {
  it('reconciles when candidate.version < localVersion', async () => {
    const { layer, persistSpy, currentLocalVersion } = buildLayer(10);
    const result = await layer.reconcileLocalVersionDownward(recoverResult(7));
    expect(result).toEqual({
      reconciled: true,
      fromVersion: 10,
      toVersion: 7,
    });
    expect(persistSpy).toHaveBeenCalledOnce();
    expect(persistSpy).toHaveBeenCalledWith(7);
    expect(currentLocalVersion()).toBe(7);
  });

  it('does NOT reconcile when candidate.version === localVersion', async () => {
    const { layer, persistSpy, currentLocalVersion } = buildLayer(10);
    const result = await layer.reconcileLocalVersionDownward(recoverResult(10));
    expect(result).toEqual({
      reconciled: false,
      fromVersion: 10,
      toVersion: 10,
    });
    expect(persistSpy).not.toHaveBeenCalled();
    expect(currentLocalVersion()).toBe(10);
  });

  it('does NOT reconcile when candidate.version > localVersion', async () => {
    const { layer, persistSpy, currentLocalVersion } = buildLayer(10);
    const result = await layer.reconcileLocalVersionDownward(recoverResult(15));
    expect(result).toEqual({
      reconciled: false,
      fromVersion: 10,
      toVersion: 10,
    });
    expect(persistSpy).not.toHaveBeenCalled();
    expect(currentLocalVersion()).toBe(10);
  });

  it('handles localVersion = 0 (pristine wallet, no downgrade possible)', async () => {
    const { layer, persistSpy } = buildLayer(0);
    const result = await layer.reconcileLocalVersionDownward(recoverResult(5));
    expect(result.reconciled).toBe(false);
    expect(persistSpy).not.toHaveBeenCalled();
  });

  it('rejects after shutdown() has started', async () => {
    const { layer, persistSpy } = buildLayer(10);
    // Begin shutdown in the background. With no in-flight ops, it
    // resolves immediately; the layer's #shuttingDown flag stays true.
    await layer.shutdown();
    await expect(
      layer.reconcileLocalVersionDownward(recoverResult(5)),
    ).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.PUBLISH_BUSY,
    });
    expect(persistSpy).not.toHaveBeenCalled();
  });
});
