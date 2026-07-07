/**
 * Durability gate — Phase 5 [B] extraction from PaymentsModule.ts.
 *
 * The at-least-once invariant's local-flush gate for TOKEN_TRANSFER
 * acks. Iterates every registered TokenStorageProvider and awaits its
 * local-only flush (or legacy full flush) so the caller can advance
 * the Nostr cursor only when every provider has confirmed local
 * durability.
 *
 * See uxfv2-phase-5-payments-disposition.md §"handleIncomingTransfer"
 * for the disposition entry.
 */

import type { TokenStorageProvider, TxfStorageDataBase } from '../../../../storage';
import { logger } from '../../../../core/logger';

/**
 * Host shim exposing the storage-provider registry. `getProviders`
 * mirrors PaymentsModule's private `getTokenStorageProviders()`.
 */
export interface DurabilityGateHost {
  getProviders(): Map<string, TokenStorageProvider<TxfStorageDataBase>>;
}

/**
 * Wait for every configured TokenStorageProvider to confirm local
 * durability of the most recent write.
 *
 * Fires the Nostr-cursor gate for at-least-once TOKEN_TRANSFER
 * ingest per PR #444 and Issue #454 finding #9:
 *
 *   - Providers that support `awaitNextLocalFlush` (the Profile
 *     provider) stamp `pendingPublishCid` + call
 *     `notifyProfileDirty()` from the flush body so the aggregator
 *     publish happens via the dirty-flush debouncer, the periodic
 *     pointer-poll's `retryPendingPublishIfAny`, or the
 *     graceful-shutdown `awaitRemoteDurability` gate — coalescing
 *     every TOKEN_TRANSFER received during the debounce window into
 *     ONE pointer update at the aggregator.
 *   - Providers without a local-only variant fall back to
 *     `awaitNextFlush` (filesystem / IndexedDB stores have no
 *     cross-device publish step, so the two semantics are equivalent
 *     on those providers).
 *
 * The return value is the at-least-once gate signal for the Nostr
 * cursor: `true` ⇒ local state is durable on every provider, advance
 * the cursor; `false` ⇒ at least one provider's local-write failed,
 * keep the cursor pinned so the event replays on next reconnect.
 *
 * Cross-device propagation failures (publish blip, HEAD-verify
 * timeout) DO NOT reach this function post-#444 — they are handled
 * in the deferred publish path.
 */
export async function awaitAllProvidersDurable(
  host: DurabilityGateHost,
  timeoutMs = 60_000,
): Promise<boolean> {
  const providers = host.getProviders();
  if (providers.size === 0) return true;
  // Issue #274: dominant §C.2 latency consumer per perf forensics. Span emits
  // one debug line on exit with per-provider durations + final durable flag.
  const __span = logger.time('payments:durability', 'awaitAllProvidersDurable', {
    providers: providers.size,
    timeoutMs,
  });
  let allDurable = true;
  for (const [providerId, provider] of providers) {
    // Issue #444 — prefer the local-only flush primitive when the
    // provider supports it. Falls back to legacy full flush when
    // absent (the two are equivalent on local-only providers).
    //
    // Issue #454 finding #9 — use the typed optional declarations on
    // the TokenStorageProvider interface (`awaitNextLocalFlush?` and
    // `awaitNextFlush?`) instead of a structural-name cast. The cast
    // let any provider exposing a method NAME silently win — even a
    // no-op stub that mocks `awaitNextLocalFlush` would advance the
    // Nostr cursor without actually persisting anything, defeating the
    // at-least-once invariant. The typed access narrows to the
    // declared `(timeoutMs?: number) => Promise<void>` contract so
    // misshaped providers fail at compile time rather than silently
    // breaking the gate at runtime.
    const flusher = provider.awaitNextLocalFlush ?? provider.awaitNextFlush;
    if (typeof flusher !== 'function') continue;
    const __t0 = Date.now();
    try {
      await flusher.call(provider, timeoutMs);
      __span.mark(`provider:${providerId}`, { durationMs: Date.now() - __t0, ok: true });
    } catch (err) {
      __span.mark(`provider:${providerId}`, {
        durationMs: Date.now() - __t0,
        ok: false,
        err: err instanceof Error ? err.message : String(err),
      });
      logger.warn(
        'Payments',
        `[AT-LEAST-ONCE] provider ${providerId} local flush failed — Nostr event will NOT be acked, replayed on next reconnect:`,
        err instanceof Error ? err.message : err,
      );
      allDurable = false;
    }
  }
  __span.end({ allDurable });
  return allDurable;
}
