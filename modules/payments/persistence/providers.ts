/**
 * Storage-provider selectors used by the persistence codec + history
 * write path.
 *
 * Extracted from `PaymentsModule.getLocalTokenStorageProvider` during
 * Phase 5 per uxfv2-phase-5-payments-disposition.md
 * §"Persistence codec". Behavior-preserving pure function: the facade
 * retains its private `getLocalTokenStorageProvider()` method as a
 * one-line delegation and the (already-extracted) sync engine's
 * `getActiveTokenStorageProviders` still returns the resolved provider
 * map.
 */

import type { TokenStorageProvider, TxfStorageDataBase } from '../../../storage';

/**
 * Return the first `type === 'local'` provider from the resolved provider
 * map, falling back to the first provider of any type. Returns `null` when
 * no providers are configured.
 *
 * The persistence + history submodules use the returned provider as the
 * canonical write target for KV history entries (`HistoryRecord` list
 * mutations) — remote / IPFS providers do not carry the append-only
 * history log and MUST NOT be written to directly.
 */
export function getLocalTokenStorageProvider(
  providers: ReadonlyMap<string, TokenStorageProvider<TxfStorageDataBase>>,
): TokenStorageProvider<TxfStorageDataBase> | null {
  for (const [, provider] of providers) {
    if (provider.type === 'local') return provider;
  }
  // Fallback: first provider of any type. Preserves the pre-split
  // behavior when no `type === 'local'` provider is configured — the
  // remote provider is used as the fallback write target.
  for (const [, provider] of providers) {
    return provider;
  }
  return null;
}
