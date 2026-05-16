/**
 * Tests for the WALKBACK_FLOOR retry helper in reconcile-algorithm.
 *
 * The retry wraps `findLatestValidVersion` inside reconcileAndPublish.
 * It catches `AGGREGATOR_POINTER_WALKBACK_FLOOR` — the discovery error
 * that fires when Phase 3 walkback would cross below a version this
 * wallet has already confirmed as its own. That condition is replication
 * lag: the aggregator confirmed v=N at publish time but a fresh discovery
 * query lands on a replica whose view hasn't caught up.
 *
 * Pre-fix, reconcile let WALKBACK_FLOOR propagate immediately, so a
 * single replica-lag window aborted the whole publish call with no
 * retry. On testnet this manifested as `profile-multi-device-sync`
 * Test 1 succeeding (tokens locally visible) but Tests 2/3 failing
 * (Device A's pointer never anchored, so Devices B/C recovered empty).
 *
 * Coverage:
 *   - First call throws WALKBACK_FLOOR, subsequent succeeds → result
 *     returned, no error propagated.
 *   - All retries throw WALKBACK_FLOOR → last error propagates.
 *   - Non-WALKBACK_FLOOR error → propagates immediately, no retry.
 *   - Caller-supplied AbortSignal short-circuits between retries.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  AggregatorPointerError,
  AggregatorPointerErrorCode,
} from '../../../../profile/aggregator-pointer/errors';
import { __internal as reconcileInternal } from '../../../../profile/aggregator-pointer/reconcile-algorithm';
import * as discoverModule from '../../../../profile/aggregator-pointer/discover-algorithm';

const SUCCESS_RESULT = {
  validV: 5 as const,
  includedV: 5 as const,
  probeVersions: [],
};

describe('WALKBACK_FLOOR retry helper', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries on WALKBACK_FLOOR and returns the result when discovery eventually succeeds', async () => {
    const findSpy = vi.spyOn(discoverModule, 'findLatestValidVersion');
    let calls = 0;
    findSpy.mockImplementation(async () => {
      calls++;
      if (calls < 3) {
        throw new AggregatorPointerError(
          AggregatorPointerErrorCode.WALKBACK_FLOOR,
          `attempt ${calls}: walkback below localVersion`,
        );
      }
      return SUCCESS_RESULT as unknown as discoverModule.DiscoverResult;
    });

    const promise = reconcileInternal.findLatestValidVersionWithWalkbackFloorRetry(
      // Args to findLatestValidVersion — content irrelevant because we
      // mock the underlying call. The shape must satisfy the type-checker.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      undefined,
    );
    // Drain the backoff sleeps so the retry loop runs through all attempts.
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe(SUCCESS_RESULT);
    expect(findSpy).toHaveBeenCalledTimes(3);
  });

  it('propagates the last WALKBACK_FLOOR after exhausting the retry budget', async () => {
    const findSpy = vi.spyOn(discoverModule, 'findLatestValidVersion');
    findSpy.mockImplementation(async () => {
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.WALKBACK_FLOOR,
        'sustained walkback',
      );
    });

    const promise = reconcileInternal.findLatestValidVersionWithWalkbackFloorRetry(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      undefined,
    );
    void vi.runAllTimersAsync();
    await expect(promise).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.WALKBACK_FLOOR,
    });
    expect(findSpy).toHaveBeenCalledTimes(reconcileInternal.WALKBACK_FLOOR_RETRY_BUDGET);
  });

  it('does NOT retry non-WALKBACK_FLOOR errors', async () => {
    const findSpy = vi.spyOn(discoverModule, 'findLatestValidVersion');
    findSpy.mockImplementation(async () => {
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.DISCOVERY_OVERFLOW,
        'discovery overflow — not a transient lag',
      );
    });

    await expect(
      reconcileInternal.findLatestValidVersionWithWalkbackFloorRetry(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {} as any,
        undefined,
      ),
    ).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.DISCOVERY_OVERFLOW,
    });
    expect(findSpy).toHaveBeenCalledTimes(1);
  });

  it('respects the caller AbortSignal between retries', async () => {
    const findSpy = vi.spyOn(discoverModule, 'findLatestValidVersion');
    let calls = 0;
    const abort = new AbortController();
    findSpy.mockImplementation(async () => {
      calls++;
      // After the first throw, abort the signal so the next iteration
      // bails before invoking findLatestValidVersion a second time.
      if (calls === 1) {
        abort.abort();
      }
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.WALKBACK_FLOOR,
        `attempt ${calls}: lag`,
      );
    });

    const promise = reconcileInternal.findLatestValidVersionWithWalkbackFloorRetry(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      abort.signal,
    );
    void vi.runAllTimersAsync();
    await expect(promise).rejects.toThrow(/aborted/);
    // Exactly one underlying call before the abort fires between iterations.
    expect(findSpy).toHaveBeenCalledTimes(1);
  });
});
