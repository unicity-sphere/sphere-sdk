/**
 * Sync engine — free-function form of `PaymentsModule.sync()` / `_doSync` /
 * `validate` / `getTokenStorageProviders` / `updateTokenStorageProviders`.
 *
 * Extracted from PaymentsModule.ts:11513–11936 during Phase 5 (uxfv2-refactor-
 * design.md §2.1 and uxfv2-phase-5-payments-disposition.md §"Sync"). Behavior-
 * preserving: the facade retains its public method signatures and delegates
 * here so external callers (public API on `PaymentsModule`) are unaffected.
 *
 * Phase 6.C will rewire onto v2 semantics (e.g. drop `drainPendingFinalizations`
 * once tokens arrive finished). For Phase 5, the STSDK v1 flow is preserved
 * verbatim.
 */

import type { Token, SphereEventType, SphereEventMap } from '../../../types';
import type { OracleProvider } from '../../../oracle';
import type {
  TokenStorageProvider,
  TxfStorageDataBase,
  HistoryRecord,
} from '../../../storage';
import type { FullIdentity } from '../../../types';
import { logger } from '../../../core/logger';
import { computeAddressId } from '../../../extensions/uxf/profile/types.js';
import { extractTokenIdFromSdkData, extractStateHashFromSdkData } from '../tokens';
import type { SyncOptions, SyncResult } from './types';

/**
 * Payments-facade slice consumed by {@link runSync}.
 *
 * The facade (PaymentsModule) passes itself in via this Deps interface so the
 * free function has selective access to the private/public members `_doSync`
 * historically reached through `this`. Keeps the surviving submodule
 * behavior-identical to the pre-split class method.
 */
export interface RunSyncDeps {
  /** Current wallet identity — used for the per-provider address guard. */
  readonly identity: FullIdentity;
  /** Set of provider IDs currently disabled by the wallet. */
  readonly disabledProviderIds: ReadonlySet<string> | undefined;
  /** Primary provider map (multi-provider). */
  readonly tokenStorageProviders: Map<string, TokenStorageProvider<TxfStorageDataBase>> | undefined;
  /** Deprecated single provider — used as a fallback. */
  readonly tokenStorage: TokenStorageProvider<TxfStorageDataBase> | undefined;
  /** Current token map (mutated in place — matches the pre-split semantics). */
  readonly tokens: Map<string, Token>;
  /** Emit a wallet event. Delegates to Sphere.emit. */
  emitEvent<T extends SphereEventType>(type: T, data: SphereEventMap[T]): void;
  /** Drain pending V5 finalizations before flushing. */
  drainPendingFinalizations(opts: {
    timeoutMs: number;
    pollIntervalMs: number;
  }): Promise<{
    durationMs: number;
    timedOut: boolean;
    skipped: boolean;
  }>;
  /** Persist local state to primary kv storage. */
  save(): Promise<void>;
  /** Serialize the current token/nametag inventory into TXF wire format. */
  createStorageData(): Promise<TxfStorageDataBase>;
  /** Apply merged TXF data from a provider, replacing in-memory maps. */
  loadFromStorageData(data: TxfStorageDataBase): void;
  /** Check whether a (tokenId, stateHash) pair has been tombstoned. */
  isStateTombstoned(tokenId: string, stateHash: string): boolean;
  /** Rebuild the spend-queue's parsedTokenCache after loadFromStorageData. */
  rebuildParsedTokenCache(): Promise<void>;
  /** Import merged history entries into the local history log. */
  importRemoteHistoryEntries(entries: HistoryRecord[]): Promise<number>;
}

/**
 * Payments-facade slice consumed by {@link validateTokensAgainstOracle}.
 *
 * See {@link RunSyncDeps} for rationale. Kept narrow so `validate` doesn't
 * pull in the drain / storage-data machinery it never touches.
 */
export interface ValidateTokensDeps {
  readonly tokens: Map<string, Token>;
  readonly oracle: OracleProvider;
  /** Spend-queue cache — cleared for invalidated tokens. */
  readonly parsedTokenCache: Map<string, unknown>;
  /** Persistent-verdict predicate: short-circuits ledgered tokens. */
  isV6RecoverPermanentToken(token: Token): boolean;
  save(): Promise<void>;
}

/**
 * Return the active (non-disabled) token-storage provider map.
 *
 * Prefers the multi-provider map when populated; falls back to the deprecated
 * single-provider slot. Providers whose IDs appear in `disabledProviderIds`
 * are filtered out.
 */
export function getActiveTokenStorageProviders(deps: {
  readonly disabledProviderIds: ReadonlySet<string> | undefined;
  readonly tokenStorageProviders: Map<string, TokenStorageProvider<TxfStorageDataBase>> | undefined;
  readonly tokenStorage: TokenStorageProvider<TxfStorageDataBase> | undefined;
}): Map<string, TokenStorageProvider<TxfStorageDataBase>> {
  let providers: Map<string, TokenStorageProvider<TxfStorageDataBase>>;

  // Prefer new multi-provider map
  if (deps.tokenStorageProviders && deps.tokenStorageProviders.size > 0) {
    providers = deps.tokenStorageProviders;
  } else if (deps.tokenStorage) {
    // Fallback to deprecated single provider
    providers = new Map<string, TokenStorageProvider<TxfStorageDataBase>>();
    providers.set(deps.tokenStorage.id, deps.tokenStorage);
  } else {
    return new Map();
  }

  // Filter out disabled providers
  const disabled = deps.disabledProviderIds;
  if (disabled && disabled.size > 0) {
    const filtered = new Map<string, TokenStorageProvider<TxfStorageDataBase>>();
    for (const [id, provider] of providers) {
      if (!disabled.has(id)) {
        filtered.set(id, provider);
      }
    }
    return filtered;
  }

  return providers;
}

/**
 * Core sync engine — the extracted body of `PaymentsModule._doSync`.
 *
 * Preserves the full behavior of the pre-split method: drain semantics,
 * per-provider address guard, snapshot-restore of tokens lost by
 * loadFromStorageData, `_history` import, `sync:*` event emission, and
 * pending-flush accounting.
 */
export async function runSync(
  options: SyncOptions | undefined,
  deps: RunSyncDeps,
): Promise<SyncResult> {
  deps.emitEvent('sync:started', { source: 'payments' });

  try {
    // Get all token storage providers
    const providers = getActiveTokenStorageProviders(deps);

    if (providers.size === 0) {
      // No providers - just save locally. No draining: save() goes to
      // the kv StorageProvider which preserves _pendingFinalization
      // shape, so dropping pending tokens is not an issue here.
      await deps.save();
      deps.emitEvent('sync:completed', {
        source: 'payments',
        count: deps.tokens.size,
      });
      return { added: 0, removed: 0 };
    }

    // Drain pending V5 finalizations BEFORE serializing localData via
    // tokenToTxf. Default-on; opt out via `drainPending: false`.
    const drainPending = options?.drainPending ?? true;
    if (drainPending) {
      const drain = await deps.drainPendingFinalizations({
        timeoutMs: options?.drainTimeoutMs ?? 30_000,
        pollIntervalMs: options?.drainPollIntervalMs ?? 2_000,
      });
      if (drain.timedOut && !drain.skipped) {
        // Drain ran but didn't finish in time. Count residual pending.
        const pendingAtFlush = Array.from(deps.tokens.values()).filter(
          (t) => t.status === 'submitted' || t.status === 'pending',
        ).length;
        // DEFAULT-FLUSH (per user requirement): we MUST publish
        // unconfirmed tokens to IPFS so that on profile loss,
        // recovery picks them up and the load-time
        // `tryLocalFinalizeUnconfirmed` flow attempts re-finalization.
        // Previously this defaulted to "skip flush to avoid partial
        // CAR" — but that left unfinalized tokens un-recoverable
        // (Nostr-only delivery, so a wipe + re-import after the
        // sender's outbox aged out lost the funds entirely).
        //
        // Opt OUT explicitly via `forceFlushOnDrainTimeout: false`
        // when the caller wants the pre-existing skip-flush
        // behaviour (e.g. test scenarios that depend on
        // determinism). The default is to publish — tokens that
        // are still pending land in the CAR with their current
        // sdkData (sender's state.predicate). The recipient device
        // (or a recovered profile) then runs
        // `tryLocalFinalizeUnconfirmed` to apply the transition
        // locally using the on-disk proof, flipping state.predicate
        // to its own signing key.
        const forceFlush = options?.forceFlushOnDrainTimeout ?? true;
        if (!forceFlush) {
          logger.warn(
            'Payments',
            `sync: drain timed out with ${pendingAtFlush} token(s) still pending V5 finalization — skipping flush (forceFlushOnDrainTimeout=false) to avoid partial CAR. Retry sync() once finalization completes.`,
          );
          deps.emitEvent('sync:completed', {
            source: 'payments',
            count: deps.tokens.size,
          });
          return { added: 0, removed: 0, drainTimedOut: true, pendingAtFlush };
        }
        logger.warn(
          'Payments',
          `sync: drain timed out with ${pendingAtFlush} token(s) still pending V5 finalization — flushing anyway (default: publish unfinalized state for recovery). The recipient/recovered profile will re-attempt local finalization on load.`,
        );
      }
    }

    // Create local data once
    const localData = await deps.createStorageData();

    let totalAdded = 0;
    let totalRemoved = 0;

    // Sync with each provider. Nametag preservation when merged data
    // omits `_nametags` is handled inside `loadFromStorageData` (#136).
    for (const [providerId, provider] of providers) {
      try {
        const result = await provider.sync(localData);

        if (result.success && result.merged) {
          // Address guard: reject data from a different address.
          // Stale IPFS records may contain tokens from a previously active
          // address if a write-behind flush raced with an address switch.
          //
          // Accept two representations (one per writer):
          //   - chain pubkey — canonical post-L1-removal `_meta.address`
          //     shape (see storage rekey in c09dfd9d)
          //   - Profile short ID (`DIRECT_{first6}_{last6}`) — written by
          //     ProfileTokenStorageProvider via `computeAddressId`
          //
          // Legacy `alpha1...` bech32 addresses in `_meta.address` are
          // tolerated on READ — mirrors the tolerance in `load()` above.
          // A resave from this Phase-2 code rewrites the field to
          // chainPubkey. Rejecting alpha1 here would silently drop merged
          // payloads from cross-version peers still writing the legacy form.
          const mergedMeta = (result.merged as TxfStorageDataBase)?._meta;
          const currentChain = deps.identity.chainPubkey;
          const currentDirect = deps.identity.directAddress;
          const currentProfileShortId = currentDirect ? computeAddressId(currentDirect) : null;
          const isLegacyAlpha = mergedMeta?.address?.startsWith('alpha1') ?? false;
          if (
            mergedMeta?.address &&
            !isLegacyAlpha &&
            mergedMeta.address !== currentChain &&
            mergedMeta.address !== currentProfileShortId
          ) {
            const accepted = [
              currentChain ? `chain=${currentChain.slice(0, 16)}…` : null,
              currentProfileShortId ? `profile=${currentProfileShortId}` : null,
              `legacy alpha1 (migration tolerance)`,
            ].filter(Boolean).join(', ');
            logger.warn(
              'Payments',
              `Sync: rejecting data from provider ${providerId} — address mismatch (got=${mergedMeta.address.slice(0, 24)} accepted=[${accepted}])`,
            );
            continue;
          }

          // Snapshot tokens that can't survive TXF round-trip (V5 pending)
          // AND tokens that were added after the localData snapshot.
          // Sync can race with resolveUnconfirmed() or incoming transfers.
          const savedTokens = new Map(deps.tokens);

          // Apply merged data from each provider
          deps.loadFromStorageData(result.merged);

          // Restore tokens lost by loadFromStorageData()'s tokens.clear().
          // Only restore if no token with the same genesis tokenId already
          // exists (avoids duplicating tokens whose ID changed from v5split
          // to real genesis ID during TXF round-trip).
          // Build index of existing genesis tokenIds for O(1) lookup instead of O(n²).
          const existingGenesisIds = new Set<string>();
          for (const existing of deps.tokens.values()) {
            const gid = extractTokenIdFromSdkData(existing.sdkData);
            if (gid) existingGenesisIds.add(gid);
          }

          let restoredCount = 0;
          for (const [tokenId, token] of savedTokens) {
            if (deps.tokens.has(tokenId)) continue;

            // Check tombstones
            const sdkTokenId = extractTokenIdFromSdkData(token.sdkData);
            const stateHash = extractStateHashFromSdkData(token.sdkData);
            if (sdkTokenId && stateHash && deps.isStateTombstoned(sdkTokenId, stateHash)) {
              continue;
            }

            // Skip if an equivalent token (same genesis tokenId) already
            // exists under a different ID — avoids balance doubling.
            if (sdkTokenId && existingGenesisIds.has(sdkTokenId)) {
              continue;
            }

            deps.tokens.set(tokenId, token);
            if (sdkTokenId) existingGenesisIds.add(sdkTokenId);
            restoredCount++;
          }
          if (restoredCount > 0) {
            logger.debug('Payments', `Sync: restored ${restoredCount} token(s) lost by loadFromStorageData`);
          }

          // Rebuild parsedTokenCache for spend queue (loadFromStorageData bypasses addToken)
          await deps.rebuildParsedTokenCache();

          // Import merged history from IPFS sync into local store
          const txfData = result.merged as TxfStorageDataBase;
          if (txfData._history && txfData._history.length > 0) {
            const imported = await deps.importRemoteHistoryEntries(txfData._history as HistoryRecord[]);
            if (imported > 0) {
              logger.debug('Payments', `Imported ${imported} history entries from IPFS sync`);
            }
          }

          totalAdded += result.added;
          totalRemoved += result.removed;
        }

        deps.emitEvent('sync:provider', {
          providerId,
          success: result.success,
          added: result.added,
          removed: result.removed,
        });
      } catch (providerError) {
        // Log error but continue with other providers
        logger.warn('Payments', `Sync failed for provider ${providerId}:`, providerError);
        deps.emitEvent('sync:provider', {
          providerId,
          success: false,
          error: providerError instanceof Error ? providerError.message : String(providerError),
        });
      }
    }

    // Persist merged state to primary storage so it survives process restarts
    if (totalAdded > 0 || totalRemoved > 0) {
      await deps.save();
    }

    deps.emitEvent('sync:completed', {
      source: 'payments',
      count: deps.tokens.size,
    });

    // Surface any tokens that rode through the flush in pending-V5 state
    // so callers can detect partial-CAR risk (relevant when drain was
    // skipped due to no oracle, OR forceFlushOnDrainTimeout overrode a
    // timed-out drain). Successful drain → pendingAtFlush = 0 → omit
    // from the result.
    const pendingAtFlush = Array.from(deps.tokens.values()).filter(
      (t) => t.status === 'submitted' || t.status === 'pending',
    ).length;
    const result: SyncResult = { added: totalAdded, removed: totalRemoved };
    if (pendingAtFlush > 0) result.pendingAtFlush = pendingAtFlush;
    return result;
  } catch (error) {
    deps.emitEvent('sync:error', {
      source: 'payments',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Aggregator validation — extracted body of `PaymentsModule.validate()`.
 *
 * Walks every in-memory token; short-circuits V6-RECOVER permanent-verdict
 * ledgered tokens straight to `invalid`; asks the oracle for the rest.
 * Failing tokens have `status` set to `'invalid'`, their parsedTokenCache
 * entry evicted, and (if any invalidations) a save() is issued.
 */
export async function validateTokensAgainstOracle(
  deps: ValidateTokensDeps,
): Promise<{ valid: Token[]; invalid: Token[] }> {
  const valid: Token[] = [];
  const invalid: Token[] = [];

  for (const token of deps.tokens.values()) {
    // Issue #389 finding #7 — short-circuit ledgered tokens. The
    // V6-RECOVER permanent-verdict ledger is authoritative: the
    // wallet has decided structurally / by-recipient-mismatch that
    // it cannot finalize this token. Re-asking the aggregator about
    // it is wasted round-trips (and, worse, can return `valid=true`
    // for a token the wallet permanently rejected — a
    // `validate()` caller would then see a "valid" entry in the
    // returned array that the rest of the SDK would refuse to
    // spend). Route ledgered tokens straight to `invalid` so the
    // returned partition reflects on-wallet reality.
    if (deps.isV6RecoverPermanentToken(token)) {
      if (token.status !== 'invalid') {
        token.status = 'invalid';
      }
      deps.parsedTokenCache.delete(token.id);
      invalid.push(token);
      continue;
    }

    const result = await deps.oracle.validateToken(token.sdkData);

    if (result.valid && !result.spent) {
      valid.push(token);
    } else {
      token.status = 'invalid';
      deps.parsedTokenCache.delete(token.id);
      invalid.push(token);
    }
  }

  if (invalid.length > 0) {
    await deps.save();
  }

  return { valid, invalid };
}
