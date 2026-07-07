/**
 * Save-chain executor — the free-function body of `PaymentsModule._doSave()`.
 *
 * Extracted from PaymentsModule during Phase 5 per
 * uxfv2-phase-5-payments-disposition.md §"Persistence codec". The single-
 * flight coalescing wrapper (`save()`, `_saveChain`) stays on the facade —
 * matches the pattern the sync submodule uses for `sync()` / `_syncInProgress`.
 * Only the inner `_doSave` body ("iterate providers, call `provider.save()`,
 * then flush the pending-V5 KV ledger") is moved here.
 *
 * Behavior-preserving: the facade's `save()` still returns a promise chained
 * through `_saveChain`; each save still waits for the previous save's
 * completion (or failure isolation) before entering this body. The
 * TXF-provider fan-out semantics + pending-V5 flush ordering are unchanged.
 */

import type { Token } from '../../../types';
import type { TokenStorageProvider, TxfStorageDataBase } from '../../../storage';
import { tokenToTxf } from '../../../serialization/txf-serializer';
import { logger } from '../../../core/logger';

/**
 * Facade slice consumed by {@link runDoSave}.
 */
export interface RunDoSaveHost {
  /** Current token map — snapshot debug and TXF fan-out use this. */
  readonly tokens: ReadonlyMap<string, Token>;
  /** Active token-storage provider map (already resolved by facade). */
  getTokenStorageProviders(): Map<string, TokenStorageProvider<TxfStorageDataBase>>;
  /** Serialize the current inventory into TXF wire format. */
  createStorageData(): Promise<TxfStorageDataBase>;
  /**
   * Flush the pending-V5 KV ledger (separate from the TXF providers).
   * V5 pending tokens can't be serialized to TXF, so they use KV regardless
   * of whether TXF providers exist — the flush runs on every _doSave.
   */
  savePendingV5Tokens(): Promise<void>;
}

/**
 * Body of `_doSave()` — fan-out to every configured TXF token-storage
 * provider, then flush the pending-V5 KV ledger.
 *
 * Provider errors are LOGGED but not propagated: a single failing
 * provider MUST NOT block the others (matches pre-split semantics —
 * cross-provider durability is the goal, not atomicity).
 */
export async function runDoSave(host: RunDoSaveHost): Promise<void> {
  // Save to TokenStorageProviders (IndexedDB/files)
  const providers = host.getTokenStorageProviders();
  // Debug: log token serialization status
  const tokenStats = Array.from(host.tokens.values()).map((t) => {
    const txf = tokenToTxf(t);
    return `${t.id.slice(0, 12)}(${t.status},txf=${!!txf})`;
  });
  logger.debug(
    'Payments',
    `save(): providers=${providers.size}, tokens=[${tokenStats.join(', ')}]`,
  );

  if (providers.size > 0) {
    const data = await host.createStorageData();
    const dataKeys = Object.keys(data).filter((k) => k.startsWith('token-'));
    logger.debug(
      'Payments',
      `save(): TXF keys=${dataKeys.length} (${dataKeys.join(', ')})`,
    );
    for (const [id, provider] of providers) {
      try {
        await provider.save(data);
      } catch (err) {
        logger.error('Payments', `Failed to save to provider ${id}:`, err);
      }
    }
  } else {
    logger.debug('Payments', 'save(): No token storage providers - TXF not persisted');
  }

  // Always save pending V5 tokens to KV storage (separate from TXF providers).
  // V5 pending tokens can't be serialized to TXF, so they use KV regardless
  // of whether TXF providers exist.
  await host.savePendingV5Tokens();
}
