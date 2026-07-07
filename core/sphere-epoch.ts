/**
 * Sphere Profile / Epoch — Wave 6-P2-8 extraction from `core/Sphere.ts`.
 *
 * Owns the Profile-mode epoch-reset ceremony:
 *   - `buildProfileHandle` — the public `sphere.profile` accessor.
 *   - `getEpochFloorImpl` — read the persisted local floor.
 *   - `resetEpochImpl` — the serialization guard around a single reset.
 *   - `resetEpochCore` — the read-modify-write cycle (Issue #310).
 *   - `armResetEpochPublishWaiter` — one-shot listener for
 *     `storage:pointer-published` (PR #316 F2 fix).
 *   - `discoverChainEpochFloor` — bounded discovery for the on-chain
 *     floor (PR #316 F1 fix).
 *
 * Behavior-preserving: every private method above is moved verbatim
 * behind an `EpochOpsHost` shim so the Sphere facade keeps thin
 * delegators. The private `_resetEpochInFlight` mutex lives on the
 * host (unchanged Sphere-instance-scoped state).
 */

import { logger } from './logger';
import { SphereError } from './errors';
import type {
  SphereProfileHandle,
  ResetEpochParams,
  ResetEpochResult,
} from '../extensions/uxf/profile/profile-handle';
import {
  LOCAL_EPOCH_FLOOR_KEY,
  LOCAL_EPOCH_RESET_FLUSH_TRIGGER_KEY,
  LOCAL_EPOCH_RESET_REASON_KEY,
} from '../extensions/uxf/profile/pointer-wiring';
import { EPOCH_RESET_REASON_MAX_BYTES } from '../extensions/uxf/profile/profile-lean-snapshot';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase } from '../storage';
import type { SphereEventType, SphereEventMap } from '../types';

/**
 * PR #316 F1 fix — default discovery timeout (ms). Extracted here
 * because the epoch ceremony is the only user; splitting the constant
 * to `Sphere.ts` no longer makes sense once the code moved.
 */
export const RESET_EPOCH_DISCOVERY_TIMEOUT_MS = 15_000;

/**
 * PR #316 F2 fix — default post-bump publish-await timeout (ms).
 */
export const RESET_EPOCH_PUBLISH_TIMEOUT_MS = 30_000;

/**
 * Host shim for the epoch ops. Exposes the Sphere-private state and
 * accessors that the moved methods reach for. The `_resetEpochInFlight`
 * mutex lives on the host (mutated by getters/setters below) — reads
 * and writes must be sync so the check-and-set inside `resetEpochImpl`
 * remains race-free.
 */
export interface EpochOpsHost {
  readonly _storage: StorageProvider;
  readonly _tokenStorageProviders: Map<string, TokenStorageProvider<TxfStorageDataBase>>;

  /** Mutex — SYNC read/write to preserve the race-free check-and-set. */
  _resetEpochInFlight: Promise<ResetEpochResult> | null;

  emitEvent<T extends SphereEventType>(type: T, data: SphereEventMap[T]): void;
}

/**
 * Return the `sphere.profile` public handle. The methods it exposes
 * (`resetEpoch`, `getEpochFloor`) delegate through the host so a
 * caller cannot hold onto a stale handle after `Sphere.destroy()`.
 */
export function buildProfileHandle(host: EpochOpsHost): SphereProfileHandle {
  return {
    resetEpoch: (params: ResetEpochParams) => resetEpochImpl(host, params),
    getEpochFloor: () => getEpochFloorImpl(host),
  };
}

/**
 * Issue #310 — read the wallet's persisted epoch floor. Returns 0
 * if the wallet has never observed a higher epoch on-chain AND has
 * never called `resetEpoch`.
 */
export async function getEpochFloorImpl(host: EpochOpsHost): Promise<number> {
  const raw = await host._storage.get(LOCAL_EPOCH_FLOOR_KEY);
  if (raw === null) return 0;
  const parsed = Number.parseInt(raw, 10);
  if (
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed) ||
    parsed < 0
  ) {
    return 0;
  }
  return parsed;
}

/**
 * Issue #310 — bump the wallet's OpLog epoch floor by +1, kick off a
 * republish, and emit `'profile:epoch-reset'`. See
 * `SphereProfileHandle.resetEpoch` for the full contract.
 *
 * Serializes concurrent invocations through `host._resetEpochInFlight`.
 */
export async function resetEpochImpl(
  host: EpochOpsHost,
  params: ResetEpochParams,
): Promise<ResetEpochResult> {
  const storage = host._storage as unknown as {
    getPointerLayer?: () => unknown | null;
  };
  if (typeof storage.getPointerLayer !== 'function') {
    throw new SphereError(
      'sphere.profile.resetEpoch requires Profile-mode storage (got non-Profile StorageProvider).',
      'NOT_PROFILE_MODE',
    );
  }

  if (typeof params.reason !== 'string' || params.reason.length === 0) {
    throw new SphereError(
      'sphere.profile.resetEpoch: reason must be a non-empty string.',
      'INVALID_CONFIG',
    );
  }
  const reasonBytes = new TextEncoder().encode(params.reason);
  if (reasonBytes.byteLength > EPOCH_RESET_REASON_MAX_BYTES) {
    throw new SphereError(
      `sphere.profile.resetEpoch: reason ${reasonBytes.byteLength} bytes exceeds cap ${EPOCH_RESET_REASON_MAX_BYTES}.`,
      'INVALID_CONFIG',
    );
  }

  // Serialize: if a reset is already mid-flight, chain this call
  // BEHIND it (not deduplicate — each call must produce a NEW epoch
  // per the idempotency-against-re-runs contract). The check + set
  // MUST be sync (no intermediate await) so two concurrent
  // invocations see distinct mid-flight states.
  const prior = host._resetEpochInFlight;
  const promise = (async (): Promise<ResetEpochResult> => {
    if (prior !== null) {
      try {
        await prior;
      } catch {
        // Previous call's error is irrelevant to this one; the
        // floor-read below picks up whatever was actually persisted.
      }
    }
    return resetEpochCore(host, params);
  })();
  host._resetEpochInFlight = promise;
  try {
    return await promise;
  } finally {
    if (host._resetEpochInFlight === promise) {
      host._resetEpochInFlight = null;
    }
  }
}

/**
 * Issue #310 — core read-modify-write cycle for a single resetEpoch
 * call. Wrapped by `resetEpochImpl` with the mutex.
 *
 * PR #316 F1 fix — the floor bump now consults the on-chain epoch
 * floor (`pointer.discoverLatestVersion().pickedEpoch`) before
 * computing `newEpoch = max(local, discovered) + 1`. This closes
 * the cross-device monotonicity gap: two devices that both observe
 * `localFloor=N` will each discover the same `chainFloor=N` (or
 * better) and both bump to N+1; whichever device's publish lands
 * first wins, and the loser's subsequent publish forces a re-
 * discovery (now seeing the winner's N+1) so its NEXT bump goes
 * to N+2.
 */
export async function resetEpochCore(
  host: EpochOpsHost,
  params: ResetEpochParams,
): Promise<ResetEpochResult> {
  const ts = Date.now();

  try {
    // 1a. Read local floor.
    const currentEpoch = await getEpochFloorImpl(host);

    // 1b. PR #316 F1 fix — consult the on-chain epoch floor with a
    //     bounded timeout. The walkback floor is the
    //     `pickedEpoch` from Phase-3 discovery — the `max(epoch)`
    //     observed across every Phase-3 candidate whose CAR the
    //     wallet successfully inspected. On RPC failure (network
    //     down, aggregator timeout, etc.) we fall back to the
    //     local floor alone and emit the
    //     `'profile:epoch-reset-discovery-skipped'` event so
    //     callers can surface the PROVISIONAL nature of the bump.
    const discoveryTimeoutMs =
      params.discoveryTimeoutMs ?? RESET_EPOCH_DISCOVERY_TIMEOUT_MS;
    let discoveredEpoch = 0;
    let discoveryConsulted = false;
    let discoveryError: string | null = null;
    if (discoveryTimeoutMs > 0) {
      try {
        discoveredEpoch = await discoverChainEpochFloor(
          host,
          discoveryTimeoutMs,
        );
        discoveryConsulted = true;
      } catch (err) {
        discoveryError = err instanceof Error ? err.message : String(err);
        logger.warn(
          'Sphere',
          `resetEpoch: discovery failed (continuing with local floor only — ` +
            `new epoch is PROVISIONAL): ${discoveryError}`,
        );
      }
    }

    // 1c. Compute new epoch from the higher of (local, discovered).
    const baseEpoch = Math.max(currentEpoch, discoveredEpoch);
    const newEpoch = baseEpoch + 1;

    // 2. Persist the new epoch floor + reason. Once these keys
    //    land, the wallet is committed to the bump — a crash
    //    between here and the flush still publishes the new epoch
    //    on the next `Sphere.load()`.
    await host._storage.set(LOCAL_EPOCH_FLOOR_KEY, String(newEpoch));
    await host._storage.set(LOCAL_EPOCH_RESET_REASON_KEY, params.reason);

    // 3. Write a flush-trigger sentinel so the snapshot builder has
    //    concrete state to flush even when no other writers have
    //    mutated since the epoch bump. Value = post-reset epoch;
    //    overwritten on every subsequent reset and never accumulates.
    //    Best-effort: a write failure does NOT abort the bump —
    //    the local floor IS already persisted.
    try {
      await host._storage.set(
        LOCAL_EPOCH_RESET_FLUSH_TRIGGER_KEY,
        String(newEpoch),
      );
    } catch (err) {
      logger.warn(
        'Sphere',
        `resetEpoch: flush-trigger sentinel write failed (epoch bump still persisted): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 4a. PR #316 F2 fix — arm a one-shot listener on every token-
    //     storage provider's `'storage:pointer-published'` event
    //     BEFORE the dirty-flush is triggered. The event fires
    //     unconditionally on any successful pointer publish (per
    //     the lifecycle-manager change in this PR). We collect the
    //     FIRST published version observed across all providers
    //     within the bounded timeout window.
    //
    //     `armResetEpochPublishWaiter` returns `null` when no
    //     token-storage providers expose `onEvent` — in that case
    //     there is no event surface to observe and skipping the
    //     wait is the honest behavior (we return
    //     `publishedVersion: 0` and DO NOT emit
    //     `'profile:epoch-reset-publish-pending'` — pending implies
    //     "we tried and timed out", not "no wiring").
    const publishTimeoutMs =
      params.publishTimeoutMs ?? RESET_EPOCH_PUBLISH_TIMEOUT_MS;
    const publishedVersionWaiter =
      publishTimeoutMs > 0
        ? armResetEpochPublishWaiter(host, publishTimeoutMs)
        : null;
    // Distinguish "skipped because no listeners" (publishedVersion
    // remains 0; no pending event) from "skipped because timeout
    // = 0" (same outcome, also no pending event) from "awaited and
    // timed out" (publishedVersion = 0 AND pending event emitted).
    const publishedVersionWaiterRanAndTimedOut: { value: boolean } = {
      value: false,
    };

    // 4b. Trigger a dirty-flush so the next aggregator pointer
    //    publish carries the new epoch (best-effort).
    try {
      for (const provider of host._tokenStorageProviders.values()) {
        const dirtyTrigger = (provider as unknown as {
          notifyProfileDirty?: () => void;
        }).notifyProfileDirty;
        if (typeof dirtyTrigger === 'function') {
          dirtyTrigger.call(provider);
        }
      }
    } catch (err) {
      logger.warn(
        'Sphere',
        `resetEpoch: notifyProfileDirty threw (epoch bump still persisted): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 4c. Await the publish (or timeout). Always cancel the
    //     waiter — leaking the listener could pin the provider's
    //     event-handler set across the next publish cycle.
    let publishedVersion = 0;
    if (publishedVersionWaiter !== null) {
      try {
        publishedVersion = await publishedVersionWaiter.promise;
      } catch {
        // Timeout → publishedVersion stays 0; emit the
        // pending event below.
        publishedVersionWaiterRanAndTimedOut.value = true;
      } finally {
        publishedVersionWaiter.cancel();
      }
    }

    // 5. Emit the event.
    host.emitEvent('profile:epoch-reset', {
      newEpoch,
      reason: params.reason,
      ts,
    });

    // 5b. PR #316 F1 fix — surface discovery-failure so callers know
    //     the bump is PROVISIONAL.
    if (!discoveryConsulted && discoveryError !== null) {
      host.emitEvent('profile:epoch-reset-discovery-skipped', {
        newEpoch,
        reason: params.reason,
        discoveryError,
        ts,
      });
    }

    // 5c. PR #316 F2 fix — surface publish-timeout so callers know
    //     to either retry / re-query or subscribe to
    //     `'storage:pointer-published'` for the eventual landing.
    //     Only emit when we actually awaited AND timed out — not
    //     when the waiter was skipped (timeoutMs=0) or returned
    //     null (no event surface).
    if (publishedVersionWaiterRanAndTimedOut.value) {
      host.emitEvent('profile:epoch-reset-publish-pending', {
        newEpoch,
        reason: params.reason,
        timeoutMs: publishTimeoutMs,
        ts,
      });
    }

    return {
      newEpoch,
      reason: params.reason,
      ts,
      publishedVersion,
      discoveryConsulted,
    };
  } catch (err) {
    if (err instanceof SphereError) throw err;
    throw new SphereError(
      `sphere.profile.resetEpoch failed: ${err instanceof Error ? err.message : String(err)}`,
      'PROFILE_RESET_FAILED',
      err,
    );
  }
}

/**
 * PR #316 F2 fix — arm a one-shot waiter on every token-storage
 * provider's `'storage:pointer-published'` event. Returns a
 * `{promise, cancel}` pair: the promise resolves with the FIRST
 * observed `version` across any provider, or rejects on timeout.
 * `cancel()` unsubscribes every listener and clears the timer
 * (safe to call multiple times). Callers MUST always call
 * `cancel()` in a `finally` so the listener set does not pin
 * across the next event cycle.
 *
 * The event fires unconditionally on every successful publish (per
 * the lifecycle-manager change in this PR), so the waiter does NOT
 * depend on the `enablePointerWinBroadcasts` capability flag.
 */
export function armResetEpochPublishWaiter(
  host: EpochOpsHost,
  timeoutMs: number,
): {
  promise: Promise<number>;
  cancel: () => void;
} | null {
  // Collect candidate providers with an `onEvent` accessor BEFORE
  // installing any listener. Without at least one such provider
  // the waiter has no way to ever settle on the success path —
  // letting it run would just stall for the full `timeoutMs`
  // window with a guaranteed publish-pending event. Returning
  // `null` is the honest answer: "I cannot observe the publish
  // here; skip the await". This is the production behavior when
  // no token storage providers are wired (e.g., pure read-only
  // unit-test harnesses) and the legitimate behavior on a real
  // wallet that has Profile storage as the kv-storage backend
  // but no token storage providers attached.
  const eligible: Array<{
    onEvent: (
      cb: (event: { type: string; data?: { version?: unknown } }) => void,
    ) => () => void;
    provider: unknown;
  }> = [];
  for (const provider of host._tokenStorageProviders.values()) {
    const onEvent = (provider as unknown as {
      onEvent?: (
        cb: (event: { type: string; data?: { version?: unknown } }) => void,
      ) => () => void;
    }).onEvent;
    if (typeof onEvent !== 'function') continue;
    eligible.push({ onEvent, provider });
  }
  if (eligible.length === 0) {
    return null;
  }

  const cleanups: Array<() => void> = [];
  let settled = false;
  // Holder for the timer handle. Filled below; `teardown` reads
  // through the holder so we can declare it before the
  // `setTimeout` call (avoids use-before-define).
  const timerHolder: { value: ReturnType<typeof setTimeout> | null } = {
    value: null,
  };

  let resolve!: (v: number) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<number>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const teardown = (): void => {
    if (timerHolder.value !== null) clearTimeout(timerHolder.value);
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
        /* listener-removal must never throw past resetEpoch */
      }
    }
  };

  const cancel = (): void => {
    if (settled) return;
    settled = true;
    teardown();
  };

  const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
    if (settled) return;
    settled = true;
    teardown();
    // Reject so the caller's `await` throws and the catch arm in
    // resetEpochCore drops `publishedVersion` to 0.
    reject(
      new Error(
        `resetEpoch: storage:pointer-published not observed within ${timeoutMs}ms`,
      ),
    );
  }, timeoutMs);
  timerHolder.value = timer;
  if (
    typeof (timer as unknown as { unref?: unknown }).unref === 'function'
  ) {
    (timer as unknown as { unref: () => void }).unref();
  }

  for (const { onEvent, provider } of eligible) {
    const unsub = onEvent.call(provider, (event) => {
      if (settled) return;
      if (event?.type !== 'storage:pointer-published') return;
      const version = event?.data?.version;
      if (
        typeof version !== 'number' ||
        !Number.isFinite(version) ||
        !Number.isInteger(version) ||
        version < 0
      ) {
        return;
      }
      settled = true;
      teardown();
      resolve(version);
    });
    if (typeof unsub === 'function') {
      cleanups.push(unsub);
    }
  }

  return { promise, cancel };
}

/**
 * PR #316 F1 fix — best-effort discovery of the on-chain epoch
 * floor. Runs `pointer.discoverLatestVersion()` with a
 * caller-supplied wall-clock budget and returns the
 * `pickedEpoch` value. Throws on any failure (RPC timeout,
 * aggregator down, pointer layer missing) — the caller logs the
 * error, emits the `'profile:epoch-reset-discovery-skipped'`
 * event, and falls back to the local floor alone.
 *
 * Returns 0 for a fresh wallet that has never observed an
 * on-chain epoch (the discovery returns `pickedEpoch: 0` in that
 * case, which is correct — `max(local=0, discovered=0) + 1 = 1`).
 */
export async function discoverChainEpochFloor(
  host: EpochOpsHost,
  timeoutMs: number,
): Promise<number> {
  const storageWithPointer = host._storage as unknown as {
    getPointerLayer?: () => {
      discoverLatestVersion?: (
        walkbackLimit?: number,
        opts?: { abortSignal?: AbortSignal },
      ) => Promise<{ pickedEpoch?: number }>;
    } | null;
  };
  const pointer = storageWithPointer.getPointerLayer?.() ?? null;
  if (
    pointer === null ||
    typeof pointer.discoverLatestVersion !== 'function'
  ) {
    throw new Error(
      'pointer layer unavailable (discoverLatestVersion missing)',
    );
  }
  const abortController = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    deadlineTimer = setTimeout(() => {
      try {
        abortController.abort();
      } catch {
        /* noop */
      }
    }, timeoutMs);
    // Some Node test runners support .unref() on timers; ignore otherwise.
    if (
      deadlineTimer !== undefined &&
      typeof (deadlineTimer as unknown as { unref?: unknown }).unref ===
        'function'
    ) {
      (deadlineTimer as unknown as { unref: () => void }).unref();
    }
    const result = await pointer.discoverLatestVersion(undefined, {
      abortSignal: abortController.signal,
    });
    const picked = result?.pickedEpoch;
    if (typeof picked !== 'number' || !Number.isFinite(picked) || picked < 0) {
      return 0;
    }
    return picked;
  } finally {
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer);
    }
  }
}
