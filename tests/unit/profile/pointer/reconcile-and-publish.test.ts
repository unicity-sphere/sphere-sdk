/**
 * Tests for `reconcileAndPublish` — issue #263 fast-path / slow-path
 * decoupling.
 *
 * The fast path (attempt 0) skips the discovery walkback and submits at
 * `currentLocalVersion + 1` directly. The slow path (attempt >= 1) runs
 * the standard SPEC §8.2 three-phase walk before submitting. The
 * fall-through trigger is a `conflict` outcome from
 * `publishOnceAtVersion`; any other outcome / throw propagates.
 *
 * We spy on `publishOnceAtVersion` and `findLatestValidVersion` so the
 * test doesn't need real aggregator / signer plumbing.
 *
 *  Coverage (closes issue #263 test plan):
 *    1. Fast-path success when no sibling broadcast received: no
 *       discovery call; submit at localVersion + 1.
 *    2. Fast-path success when sibling broadcast adopted: no discovery
 *       call; submit at siblingHighestV + 1.
 *    3. Fast-path conflict (REQUEST_ID_EXISTS) triggers fall-back to
 *       walkback: rediscovery + advance + slow-path discovery + retry
 *       submit.
 *    4. Cold-start (localVersion=0) with no sibling: fast-path tries
 *       v=1; on conflict falls back to walkback at the discovered v.
 *    5. Stale sibling broadcast (siblingHighestV < localVersion) is
 *       ignored — fast-path uses localVersion + 1.
 *    6. Non-conflict throw from publishOnceAtVersion propagates without
 *       fall-through (REJECTED / H8 v-burn must not enter the walkback).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  AggregatorPointerError,
  AggregatorPointerErrorCode,
} from '../../../../profile/aggregator-pointer/errors';
import { reconcileAndPublish } from '../../../../profile/aggregator-pointer/reconcile-algorithm';
import type { ReconcileInput } from '../../../../profile/aggregator-pointer/reconcile-algorithm';
import * as discoverModule from '../../../../profile/aggregator-pointer/discover-algorithm';
import * as publishModule from '../../../../profile/aggregator-pointer/publish-algorithm';
import type { PointerVersion } from '../../../../profile/aggregator-pointer/types';

// ---------------------------------------------------------------------------
// Test harness — minimal ReconcileInput
// ---------------------------------------------------------------------------

const FAKE_CID = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

function makeInput(overrides: Partial<ReconcileInput> = {}): ReconcileInput {
  // All sub-providers we don't exercise are typed as `any` — the spied
  // publishOnceAtVersion / findLatestValidVersion never read them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dontCare: any = {};
  return {
    cidProducer: vi.fn().mockResolvedValue(FAKE_CID),
    currentLocalVersion: 0 as PointerVersion,
    keyMaterial: dontCare,
    signer: dontCare,
    aggregatorClient: dontCare,
    trustBase: dontCare,
    flagStore: dontCare,
    mutex: dontCare,
    decodeCid: dontCare,
    fetchCar: dontCare,
    fetchAndJoin: vi.fn().mockResolvedValue(undefined),
    persistLocalVersion: vi.fn().mockResolvedValue(undefined),
    resolveRemoteCid: vi.fn().mockResolvedValue(new Uint8Array([0xca, 0xfe])),
    ...overrides,
  };
}

describe('reconcileAndPublish — issue #263 fast-path / slow-path decoupling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ─── 1. Fast-path success when no sibling broadcast received ──────────────

  it('fast-path success: no sibling — submits at localVersion+1 without discovery', async () => {
    const findSpy = vi.spyOn(discoverModule, 'findLatestValidVersion');
    const publishSpy = vi
      .spyOn(publishModule, 'publishOnceAtVersion')
      .mockResolvedValue({ kind: 'success', v: 6 as PointerVersion, idempotent: false });

    const input = makeInput({ currentLocalVersion: 5 as PointerVersion });

    const promise = reconcileAndPublish(input);
    await vi.runAllTimersAsync();
    const outcome = await promise;

    expect(outcome.kind).toBe('success');
    expect(outcome.v).toBe(6);
    expect(outcome.attemptsUsed).toBe(1);
    expect(outcome.probeHistory).toEqual([]); // no discovery called

    expect(findSpy).not.toHaveBeenCalled();
    expect(publishSpy).toHaveBeenCalledTimes(1);
    // candidateV must be localVersion + 1 = 6
    expect(publishSpy.mock.calls[0]![0]).toMatchObject({
      candidateV: 6,
      currentLocalVersion: 5,
    });
  });

  // ─── 2. Fast-path success when sibling broadcast adopted ──────────────────

  it('fast-path success: sibling broadcast > localVersion is adopted as floor', async () => {
    const findSpy = vi.spyOn(discoverModule, 'findLatestValidVersion');
    const publishSpy = vi
      .spyOn(publishModule, 'publishOnceAtVersion')
      .mockResolvedValue({ kind: 'success', v: 11 as PointerVersion, idempotent: false });

    const input = makeInput({
      currentLocalVersion: 5 as PointerVersion,
      siblingHighestV: 10 as PointerVersion, // sibling told us they landed v=10
    });

    const promise = reconcileAndPublish(input);
    await vi.runAllTimersAsync();
    const outcome = await promise;

    expect(outcome.kind).toBe('success');
    expect(outcome.v).toBe(11);
    expect(outcome.attemptsUsed).toBe(1);

    expect(findSpy).not.toHaveBeenCalled();
    expect(publishSpy).toHaveBeenCalledTimes(1);
    // candidateV must be siblingHighestV + 1 = 11; currentLocalVersion was
    // bumped to 10 in-memory before computing nextV.
    expect(publishSpy.mock.calls[0]![0]).toMatchObject({
      candidateV: 11,
      currentLocalVersion: 10,
    });
  });

  // ─── 3. REQUEST_ID_EXISTS / conflict triggers fall-back to walkback ───────

  it('fast-path conflict falls back to walkback discovery and retries', async () => {
    // Attempt 0 (fast path): conflict. Triggers rediscovery → validV=5
    // → fetchAndJoin advances currentLocalVersion to 5 → backoff.
    // Attempt 1 (slow path): discovery again → max(5,5)+1=6 → publish at
    // v=6 → success.
    const findSpy = vi.spyOn(discoverModule, 'findLatestValidVersion');
    findSpy.mockResolvedValue({
      validV: 5 as PointerVersion,
      includedV: 5 as PointerVersion,
      probeVersions: [1 as PointerVersion, 2 as PointerVersion, 4 as PointerVersion],
    });
    const publishSpy = vi.spyOn(publishModule, 'publishOnceAtVersion');
    publishSpy
      .mockResolvedValueOnce({ kind: 'conflict', v: 4 as PointerVersion })
      .mockResolvedValueOnce({ kind: 'success', v: 6 as PointerVersion, idempotent: false });

    const fetchAndJoin = vi.fn().mockResolvedValue(undefined);
    const resolveRemoteCid = vi.fn().mockResolvedValue(new Uint8Array([0x12]));
    const input = makeInput({
      currentLocalVersion: 3 as PointerVersion,
      fetchAndJoin,
      resolveRemoteCid,
    });

    const promise = reconcileAndPublish(input);
    await vi.runAllTimersAsync();
    const outcome = await promise;

    expect(outcome.kind).toBe('success');
    expect(outcome.v).toBe(6);
    expect(outcome.attemptsUsed).toBe(2);

    // findLatestValidVersion called TWICE:
    //   1. rediscovery after fast-path conflict
    //   2. attempt 1's Step B (slow-path) discovery
    expect(findSpy).toHaveBeenCalledTimes(2);
    // probeHistory accumulates probeVersions from BOTH discovery calls.
    expect(outcome.probeHistory).toEqual([1, 2, 4, 1, 2, 4]);

    // publishOnceAtVersion called TWICE: fast at v=4 (conflict), slow at v=6 (success).
    expect(publishSpy).toHaveBeenCalledTimes(2);
    expect(publishSpy.mock.calls[0]![0]).toMatchObject({ candidateV: 4 });
    expect(publishSpy.mock.calls[1]![0]).toMatchObject({ candidateV: 6 });

    // Conflict path ran fetchAndJoin to advance currentLocalVersion to validV=5.
    expect(resolveRemoteCid).toHaveBeenCalledWith(5);
    expect(fetchAndJoin).toHaveBeenCalledWith(expect.any(Uint8Array), 5);
  });

  // ─── 4. Cold-start (localVersion=0) ────────────────────────────────────────

  it('cold-start (localVersion=0): fast-path tries v=1 then falls back on conflict', async () => {
    const findSpy = vi.spyOn(discoverModule, 'findLatestValidVersion');
    findSpy.mockResolvedValue({
      validV: 5 as PointerVersion,
      includedV: 5 as PointerVersion,
      probeVersions: [],
    });
    const publishSpy = vi.spyOn(publishModule, 'publishOnceAtVersion');
    publishSpy
      .mockResolvedValueOnce({ kind: 'conflict', v: 1 as PointerVersion })
      .mockResolvedValueOnce({ kind: 'success', v: 6 as PointerVersion, idempotent: false });

    const input = makeInput({ currentLocalVersion: 0 as PointerVersion });

    const promise = reconcileAndPublish(input);
    await vi.runAllTimersAsync();
    const outcome = await promise;

    expect(outcome.kind).toBe('success');
    expect(outcome.v).toBe(6);
    expect(outcome.attemptsUsed).toBe(2);
    // Fast attempt at v=1 (0+1), then slow at v=6 (max(5,5)+1).
    expect(publishSpy.mock.calls[0]![0]).toMatchObject({ candidateV: 1 });
    expect(publishSpy.mock.calls[1]![0]).toMatchObject({ candidateV: 6 });
  });

  // ─── 5. Stale sibling broadcast is ignored ────────────────────────────────

  it('stale sibling broadcast (siblingHighestV <= localVersion) is ignored', async () => {
    const findSpy = vi.spyOn(discoverModule, 'findLatestValidVersion');
    const publishSpy = vi
      .spyOn(publishModule, 'publishOnceAtVersion')
      .mockResolvedValue({ kind: 'success', v: 11 as PointerVersion, idempotent: false });

    const input = makeInput({
      currentLocalVersion: 10 as PointerVersion,
      siblingHighestV: 3 as PointerVersion, // stale — far behind us
    });

    const promise = reconcileAndPublish(input);
    await vi.runAllTimersAsync();
    const outcome = await promise;

    expect(outcome.kind).toBe('success');
    expect(findSpy).not.toHaveBeenCalled();
    // candidateV is localVersion + 1 = 11, NOT 4 (stale + 1).
    expect(publishSpy.mock.calls[0]![0]).toMatchObject({
      candidateV: 11,
      currentLocalVersion: 10,
    });
  });

  it('equal sibling broadcast (siblingHighestV === localVersion) is also ignored', async () => {
    // Strict greater-than gate: a sibling broadcast at our own current
    // version conveys no new information; the floor stays at localVersion.
    const findSpy = vi.spyOn(discoverModule, 'findLatestValidVersion');
    const publishSpy = vi
      .spyOn(publishModule, 'publishOnceAtVersion')
      .mockResolvedValue({ kind: 'success', v: 8 as PointerVersion, idempotent: false });

    const input = makeInput({
      currentLocalVersion: 7 as PointerVersion,
      siblingHighestV: 7 as PointerVersion,
    });

    const promise = reconcileAndPublish(input);
    await vi.runAllTimersAsync();
    const outcome = await promise;

    expect(outcome.kind).toBe('success');
    expect(findSpy).not.toHaveBeenCalled();
    expect(publishSpy.mock.calls[0]![0]).toMatchObject({
      candidateV: 8,
      currentLocalVersion: 7,
    });
  });

  // ─── 6. Non-conflict throw propagates without fall-through ────────────────

  it('REJECTED (H8 v-burn) throw from fast-path propagates without walkback', async () => {
    // H8 v-burn is a REJECTED throw — the version is permanently consumed
    // and the wallet is now BLOCKED. Falling through to walkback would be
    // pointless (it would re-discover and try at the next v, but the
    // BLOCKED state in publish-algorithm rejects further publishes).
    // Reconcile MUST propagate the throw immediately.
    const findSpy = vi.spyOn(discoverModule, 'findLatestValidVersion');
    const publishSpy = vi.spyOn(publishModule, 'publishOnceAtVersion');
    publishSpy.mockRejectedValueOnce(
      new AggregatorPointerError(
        AggregatorPointerErrorCode.REJECTED,
        'publish at v=6: aggregator rejected side=A (proof failure). H8 v-burning.',
      ),
    );

    const input = makeInput({ currentLocalVersion: 5 as PointerVersion });

    const promise = reconcileAndPublish(input);
    void vi.runAllTimersAsync();
    await expect(promise).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.REJECTED,
    });

    // Only ONE publish attempt; no rediscovery or slow-path retry.
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(findSpy).not.toHaveBeenCalled();
  });

  it('AGGREGATOR_REJECTED throw propagates without walkback', async () => {
    const findSpy = vi.spyOn(discoverModule, 'findLatestValidVersion');
    const publishSpy = vi.spyOn(publishModule, 'publishOnceAtVersion');
    publishSpy.mockRejectedValueOnce(
      new AggregatorPointerError(
        AggregatorPointerErrorCode.AGGREGATOR_REJECTED,
        'permanent 4xx',
      ),
    );

    const input = makeInput({ currentLocalVersion: 5 as PointerVersion });

    const promise = reconcileAndPublish(input);
    void vi.runAllTimersAsync();
    await expect(promise).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.AGGREGATOR_REJECTED,
    });

    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(findSpy).not.toHaveBeenCalled();
  });

  // ─── Misc: probeHistory empty on fast-path success ────────────────────────

  it('probeHistory is empty when fast-path succeeds', async () => {
    vi.spyOn(publishModule, 'publishOnceAtVersion').mockResolvedValue({
      kind: 'success',
      v: 6 as PointerVersion,
      idempotent: false,
    });

    const input = makeInput({ currentLocalVersion: 5 as PointerVersion });
    const promise = reconcileAndPublish(input);
    await vi.runAllTimersAsync();
    const outcome = await promise;
    expect(outcome.probeHistory).toEqual([]);
  });
});
