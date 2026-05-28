/**
 * Shared corrupt-OpLog auto-reset primitive.
 *
 * Issue #305 added auto-reset on the WRITE path
 * (`FlushScheduler.addBundleWithOplogAutoReset`): when an OrbitDB
 * operation throws the "Failed to load block for <CID>" signature, the
 * corrupt log is reset via `OrbitDbAdapter.resetCorruptedLog`, a
 * `ProfileRecoveryMarker` is written, and the operation is retried once.
 *
 * Issue #308 — the same corruption also surfaces from the READ path
 * (`LifecycleManager.initialize()` → `BundleIndex.refreshKnownBundles()`
 * → `db.all('tokens.bundle.')`). That path previously only swallowed the
 * error and proceeded with an empty bundle set, never invoking the
 * reset. On a wallet that performs no bundle writes for a long time, the
 * write-path reset never fires, so the unreachable head block is re-read
 * — and the degraded-state warning re-emitted — on every boot.
 *
 * This helper factors the detect → reset → marker → retry → emit
 * sequence out so the read path reuses the exact recovery contract the
 * write path already has. It NEVER throws for control flow: it reports
 * the outcome and lets the caller decide whether to fall back (read
 * path) or re-throw (write path).
 *
 * @module profile/profile-token-storage/oplog-auto-reset
 */

import { extractLostHeadCid } from '../orbitdb-adapter.js';
import type { OrbitDbAdapter } from '../orbitdb-adapter.js';
import type { ProfileDatabase, ProfileRecoveryMarker } from '../types.js';
import type { ProfileTokenStorageHost } from './host.js';

/** The subset of the host the auto-reset primitive depends on. */
export type OplogAutoResetHost = Pick<
  ProfileTokenStorageHost,
  'db' | 'log' | 'emitEvent' | 'writeRecoveryMarker'
>;

export interface OplogAutoResetOutcome {
  /** The error carried the "Failed to load block for <CID>" signature. */
  readonly matchedSignature: boolean;
  /** `db.resetCorruptedLog` ran and resolved successfully. */
  readonly reset: boolean;
  /** The post-reset `retry()` resolved successfully. */
  readonly retrySucceeded: boolean;
  /** The unreachable head CID, when the signature matched (else null). */
  readonly lostHeadCid: string | null;
}

/**
 * Attempt to recover from a corrupt-OpLog read/write error by resetting
 * the corrupted OrbitDB log and retrying the operation once.
 *
 * Mirrors `FlushScheduler.addBundleWithOplogAutoReset` so both the read
 * and write paths emit the same `profile:oplog-auto-resetting` /
 * `profile:recovered` events and write the same `ProfileRecoveryMarker`.
 *
 * @param host    Host seam exposing `db`, `log`, `emitEvent`, `writeRecoveryMarker`.
 * @param err     The error thrown by the OrbitDB operation.
 * @param context Stable label for the call site; recorded on the marker
 *                and events, e.g. `lifecycle-manager.bundle-index-refresh`.
 * @param retry   The operation to re-run ONCE after a successful reset.
 */
export async function tryAutoResetCorruptedOplog(
  host: OplogAutoResetHost,
  err: unknown,
  context: string,
  retry: () => Promise<void>,
): Promise<OplogAutoResetOutcome> {
  const lostHeadCid = extractLostHeadCid(err);
  // Not the unreachable-block signature — nothing this primitive can do.
  if (lostHeadCid === null) {
    return {
      matchedSignature: false,
      reset: false,
      retrySucceeded: false,
      lostHeadCid: null,
    };
  }

  // `resetCorruptedLog` lives on the concrete `OrbitDbAdapter`, not on the
  // `ProfileDatabase` interface. Production wiring always uses the adapter;
  // legacy in-memory stubs / test doubles may omit it, in which case we
  // cannot recover and the caller keeps its pre-existing behavior.
  const dbWithReset = host.db as ProfileDatabase & {
    resetCorruptedLog?: typeof OrbitDbAdapter.prototype.resetCorruptedLog;
  };
  if (typeof dbWithReset.resetCorruptedLog !== 'function') {
    return {
      matchedSignature: true,
      reset: false,
      retrySucceeded: false,
      lostHeadCid,
    };
  }

  host.log(
    `OpLog head unreachable (lostHeadCid=${lostHeadCid}; context=${context}); ` +
      `auto-resetting Profile DB. Prior OpLog history is permanently ` +
      `inaccessible. Token data on local IndexedDB is preserved.`,
  );

  // Emit BEFORE the reset so operators see the trigger even if the reset
  // itself fails.
  host.emitEvent({
    type: 'profile:oplog-auto-resetting',
    timestamp: Date.now(),
    data: { lostHeadCid, context },
  });

  let resetResult: {
    recovered: true;
    lostHeadCid?: string;
    recoveredAt: number;
  };
  try {
    resetResult = await dbWithReset.resetCorruptedLog({ lostHeadCid, context });
  } catch (resetErr) {
    host.emitEvent({
      type: 'profile:recovered',
      timestamp: Date.now(),
      data: {
        lostHeadCid,
        recoveredAt: Date.now(),
        context,
        retrySucceeded: false,
        resetFailed: true,
      },
      error: resetErr instanceof Error ? resetErr.message : String(resetErr),
      cause: resetErr,
    });
    return {
      matchedSignature: true,
      reset: false,
      retrySucceeded: false,
      lostHeadCid,
    };
  }

  // Best-effort persistent recovery marker. A marker-write failure does
  // not block the retry — the in-memory recovery still applies for this
  // session.
  const marker: ProfileRecoveryMarker = {
    version: 1,
    recoveredAt: resetResult.recoveredAt,
    lostHeadCid: resetResult.lostHeadCid ?? lostHeadCid,
    context,
    walkBackClosed: true,
    note:
      'Profile OpLog auto-reset: an OrbitDB head block was unreachable ' +
      'and could not be served by any known store (Helia blockstore, ' +
      'operator gateways). Walk-back past this point is permanently ' +
      'closed; some operational metadata (outbox/sent/history not yet ' +
      'pinned in a UXF bundle) may have been lost. Token data on ' +
      'local IndexedDB token storage is preserved.',
  };
  try {
    await host.writeRecoveryMarker(marker);
  } catch (markerErr) {
    host.log(
      `Recovery marker write failed (continuing): ` +
        `${markerErr instanceof Error ? markerErr.message : String(markerErr)}`,
    );
  }

  // Retry the operation ONCE against the fresh log.
  try {
    await retry();
  } catch (retryErr) {
    host.emitEvent({
      type: 'profile:recovered',
      timestamp: Date.now(),
      data: {
        lostHeadCid,
        recoveredAt: resetResult.recoveredAt,
        context,
        retrySucceeded: false,
      },
      error: retryErr instanceof Error ? retryErr.message : String(retryErr),
      cause: retryErr,
    });
    return {
      matchedSignature: true,
      reset: true,
      retrySucceeded: false,
      lostHeadCid,
    };
  }

  host.emitEvent({
    type: 'profile:recovered',
    timestamp: Date.now(),
    data: {
      lostHeadCid,
      recoveredAt: resetResult.recoveredAt,
      context,
      retrySucceeded: true,
    },
  });
  return {
    matchedSignature: true,
    reset: true,
    retrySucceeded: true,
    lostHeadCid,
  };
}
