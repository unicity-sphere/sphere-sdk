/**
 * Storage-event subscription helpers — free-function form of the push-based
 * sync wiring on `PaymentsModule`.
 *
 * Extracted from PaymentsModule.ts:11768–11828 during Phase 5 (uxfv2-refactor-
 * design.md §2.1 and uxfv2-phase-5-payments-disposition.md §"Sync"). Behavior-
 * preserving: same subscription pattern + same 500ms debounce as the
 * pre-split facade method. The facade retains ownership of the
 * `storageEventUnsubscribers` array + debounce-timer holder and delegates
 * the actual subscription/tear-down/schedule logic here.
 */

import type { TokenStorageProvider, TxfStorageDataBase } from '../../../storage';
import type { SphereEventType, SphereEventMap } from '../../../types';
import { logger } from '../../../core/logger';
import type { SyncResult } from './types';

/**
 * Default debounce window (ms) for coalescing rapid remote-update bursts.
 * Matches the pre-split `PaymentsModule.SYNC_DEBOUNCE_MS`.
 */
export const SYNC_DEBOUNCE_MS = 500;

/**
 * Mutable holder for the debounce timer — the facade owns the timer field
 * on itself, but the pure helpers below need read/write access to it. Using
 * a small `{ timer }` container keeps the delegation shape trivial without
 * exposing PaymentsModule's private fields.
 */
export interface DebounceTimerRef {
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Subscribe to `storage:remote-updated` events on every provider that
 * exposes `onEvent`. Appends an unsubscribe callback to `unsubscribers` for
 * each successful subscription so the facade can tear them down later.
 *
 * @returns the number of subscriptions attached.
 */
export function subscribeToStorageEventsHelper(
  providers: ReadonlyMap<string, TokenStorageProvider<TxfStorageDataBase>>,
  unsubscribers: Array<() => void>,
  onRemoteUpdate: (providerId: string, eventData: unknown) => void,
): number {
  let attached = 0;
  for (const [providerId, provider] of providers) {
    if (provider.onEvent) {
      const unsub = provider.onEvent((event) => {
        if (event.type === 'storage:remote-updated') {
          logger.debug('Payments', 'Remote update detected from provider', providerId, event.data);
          onRemoteUpdate(providerId, event.data);
        }
      });
      unsubscribers.push(unsub);
      attached++;
    }
  }
  return attached;
}

/**
 * Tear down all provider subscriptions and clear the pending debounce timer.
 * Empties `unsubscribers` in place — matches the pre-split
 * `PaymentsModule.unsubscribeStorageEvents` semantics.
 */
export function unsubscribeStorageEventsHelper(
  unsubscribers: Array<() => void>,
  timerRef: DebounceTimerRef,
): void {
  for (const unsub of unsubscribers) {
    unsub();
  }
  unsubscribers.length = 0;

  if (timerRef.timer) {
    clearTimeout(timerRef.timer);
    timerRef.timer = null;
  }
}

/**
 * Schedule a debounced sync invocation triggered by a `storage:remote-updated`
 * event. Cancels any pending timer first, then arms a fresh one that will
 * call `runSync()` after `debounceMs`. Emits `sync:remote-update` on
 * success; swallows errors via `logger.debug` (auto-sync failures are
 * non-fatal — the caller retries by explicit `sync()`).
 *
 * @param timerRef - shared timer holder — mutated in place.
 * @param providerId - provider that produced the remote-update event.
 * @param eventData - opaque `storage:remote-updated` payload.
 * @param runSync - callback that performs an actual sync (facade delegates to
 *   its coalescing wrapper so overlapping invocations share the same
 *   in-flight promise).
 * @param emitEvent - event fan-out (facade owns the Sphere emitter).
 * @param debounceMs - debounce window in ms. Defaults to
 *   {@link SYNC_DEBOUNCE_MS} (500ms).
 */
export function debouncedSyncFromRemoteUpdateHelper(
  timerRef: DebounceTimerRef,
  providerId: string,
  eventData: unknown,
  runSync: () => Promise<SyncResult>,
  emitEvent: <T extends SphereEventType>(type: T, data: SphereEventMap[T]) => void,
  debounceMs: number = SYNC_DEBOUNCE_MS,
): void {
  if (timerRef.timer) {
    clearTimeout(timerRef.timer);
  }

  timerRef.timer = setTimeout(() => {
    timerRef.timer = null;
    runSync()
      .then((result) => {
        const data = eventData as { name?: string; sequence?: number; cid?: string } | undefined;
        emitEvent('sync:remote-update', {
          providerId,
          name: data?.name ?? '',
          sequence: data?.sequence ?? 0,
          cid: data?.cid ?? '',
          added: result.added,
          removed: result.removed,
        });
      })
      .catch((err) => {
        logger.debug('Payments', 'Auto-sync from remote update failed:', err);
      });
  }, debounceMs);
}
