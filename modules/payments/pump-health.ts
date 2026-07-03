/**
 * pump-health.ts — quiet-then-escalate logging for the background wallet-api
 * pumps (#630).
 *
 * The mailbox, payment-request, and inventory pumps poll the wallet-api every
 * 30 s (plus wake nudges). During a transient DNS/connection blip each pump
 * would otherwise dump a full `WalletApiError` stack every tick — loud console
 * spam even though nothing is actually broken (the client already retried the
 * GET, and the next tick self-heals). Instead:
 *
 * - a transient `NETWORK` failure is counted and logged as ONE `debug` line
 *   (message only, no stack), escalating to a single `warn` only after
 *   `degradeAfter` consecutive failures — and one `warn` recovery line when a
 *   later run succeeds;
 * - any OTHER failure (auth/protocol/validation/conflict/server) is a real
 *   defect — surfaced immediately at `warn`, message-only, never counted.
 *
 * State is per-pump and shared across a stream's triggers (poll, wake, load), so
 * any successful run clears that stream's counter.
 */

import { logger } from '../../core/logger';
import { WalletApiError } from '../../wallet-api';

/** The three background pumps that poll the wallet-api on a timer (§9). */
export type PumpKey = 'delivery' | 'inventory' | 'payment-requests';

/** Consecutive transient-network failures before a pump escalates from `debug` to one `warn`. */
export const PUMP_DEGRADE_AFTER = 4;

const TAG = 'Payments';

export class PumpHealth {
  private readonly failures = new Map<PumpKey, number>();
  private readonly degraded = new Set<PumpKey>();

  constructor(private readonly degradeAfter: number = PUMP_DEGRADE_AFTER) {}

  /** Run a pump and record its outcome (success resets; failure classifies + counts). */
  run(key: PumpKey, run: () => Promise<unknown>): void {
    // `Promise.resolve().then(run)` so a SYNCHRONOUS throw in `run` is classified
    // too, not left as an unhandled rejection.
    void Promise.resolve()
      .then(run)
      .then(
        () => this.success(key),
        (err) => this.failure(key, err),
      );
  }

  failure(key: PumpKey, err: unknown): void {
    if (!(err instanceof WalletApiError) || err.code !== 'NETWORK') {
      const detail =
        err instanceof WalletApiError
          ? `${err.code} ${err.status ?? ''} ${err.message}`.replace(/\s+/g, ' ').trim()
          : String(err);
      logger.warn(TAG, `${key} pump failed:`, detail);
      return;
    }
    const n = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, n);
    logger.debug(TAG, `${key} pump: transient network failure #${n} (${err.message})`);
    if (n === this.degradeAfter && !this.degraded.has(key)) {
      this.degraded.add(key);
      logger.warn(TAG, `${key} pump degraded — ${n} consecutive network failures; still retrying`);
    }
  }

  success(key: PumpKey): void {
    if (this.degraded.delete(key)) {
      logger.warn(TAG, `${key} pump recovered`);
    }
    this.failures.set(key, 0);
  }
}
