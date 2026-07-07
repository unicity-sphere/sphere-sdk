/**
 * Sync options + result — public type surface for `PaymentsModule.sync()`.
 *
 * Extracted from PaymentsModule.ts:410–445 during Phase 5 (uxfv2-refactor-
 * design.md §2.1 and uxfv2-phase-5-payments-disposition.md §"Sync"). Behavior-
 * preserving: same shapes as before. Re-exported through PaymentsModule.ts so
 * external consumer imports (`import { SyncOptions, SyncResult } from
 * '@unicitylabs/sphere-sdk'`) keep working unchanged.
 */

export interface SyncOptions {
  /** When true (default), drain pending V5 finalizations before flushing to
   *  token-storage providers. Without draining, any token whose `sdkData`
   *  still carries `_pendingFinalization` round-trips through `tokenToTxf`
   *  as null and is silently dropped from the published CAR — a remote
   *  device joining via `recoverLatest()` then sees a partial inventory.
   *  Set false to preserve the legacy "publish whatever's confirmed"
   *  semantics. */
  drainPending?: boolean;
  /** Max time in ms to wait for pending V5 tokens to finalize before
   *  giving up (default: 30000). When `forceFlushOnDrainTimeout` is
   *  false (default) AND tokens remain pending after this budget, the
   *  flush is skipped and `drainTimedOut: true` is returned — the caller
   *  can retry once tokens have confirmed. */
  drainTimeoutMs?: number;
  /** Poll interval in ms while draining (default: 2000). */
  drainPollIntervalMs?: number;
  /** When true, publish whatever's confirmed even if pending tokens
   *  remain after `drainTimeoutMs`. Restores legacy behavior — pending
   *  tokens are silently dropped from the CAR. Default false. */
  forceFlushOnDrainTimeout?: boolean;
}

export interface SyncResult {
  /** Tokens added to local state from remote-merged data. */
  added: number;
  /** Tokens removed from local state via remote tombstones. */
  removed: number;
  /** Number of V5-pending tokens still unresolved when the flush ran.
   *  Non-zero only when `drainPending: false` was requested OR
   *  `forceFlushOnDrainTimeout: true` overrode a timed-out drain. */
  pendingAtFlush?: number;
  /** True iff `drainPending` was on, the drain timed out, and the flush
   *  was skipped (no partial CAR published). */
  drainTimedOut?: boolean;
}
