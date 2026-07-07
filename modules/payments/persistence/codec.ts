/**
 * TXF persistence codec — encode/decode the TXF storage data shape.
 *
 * Extracted from PaymentsModule during Phase 5 per
 * uxfv2-phase-5-payments-disposition.md §"Persistence codec":
 * - `archiveToken`         → {@link archiveTokenImpl}
 * - `createStorageData`    → {@link createStorageData}
 * - `loadFromStorageData`  → {@link loadFromStorageData}
 *
 * Behavior-preserving pure functions. The facade retains its private
 * `archiveToken(token)` / `createStorageData()` / `loadFromStorageData(data)`
 * signatures unchanged and delegates to these functions. State ownership
 * stays on the facade — this module receives references (Maps / arrays)
 * that it mutates in place (or replaces via the returned diff for the
 * few cases where the facade must re-assign a field slot atomically).
 *
 * IMPORTANT — `loadFromStorageData` contains three invariants that MUST
 * be preserved verbatim (see the inline docstrings below):
 *
 *   1. Tombstone UNION-MERGE (#143 FIX D) — never overwrite the
 *      in-memory tombstone set with a strictly-older snapshot.
 *   2. NEVER-WIPE (2026-05-16) — restore preserved-in-memory tokens
 *      that the storage snapshot did NOT surface (in-flight, or
 *      flush-stalled).
 *   3. JOIN-divergent double-spend detection (OUTBOX-SEND-FOLLOWUPS
 *      Item #14 Phase 2 work item 5) — when a preserved-in-memory
 *      `'transferring'` snapshot's genesisTokenId matches a
 *      DIFFERENT chain head from storage, drop it and emit
 *      `transfer:double-spend-detected` with a tombstone paper trail.
 */

import type { Token, SphereEventType, SphereEventMap, FullIdentity } from '../../../types';
import type { TxfToken, TombstoneEntry, NametagData } from '../../../types/txf';
import type { TxfStorageDataBase } from '../../../storage';
import {
  tokenToTxf,
  getCurrentStateHash,
  buildTxfStorageData,
  parseTxfStorageData,
} from '../../../serialization/txf-serializer';
import { logger } from '../../../core/logger';
import {
  extractTokenIdFromSdkData,
  extractStateHashFromSdkData,
  createTokenStateKey,
  hasSameGenesisTokenId,
  isIncrementalUpdate,
  createTombstoneFromToken,
} from '../tokens';
import { MAX_SYNCED_HISTORY_ENTRIES, type TransactionHistoryEntry } from '../read-model';

/**
 * Facade slice consumed by {@link archiveTokenImpl}.
 *
 * The facade owns `archivedTokens` (Map) and delegates the fork branch
 * to its {@link storeForkedToken} helper. The archive move is a simple
 * incremental-vs-fork decision — see PR #144 / FIX E.
 */
export interface ArchiveTokenHost {
  readonly archivedTokens: Map<string, TxfToken>;
  storeForkedToken(tokenId: string, stateHash: string, txf: TxfToken): Promise<void>;
}

/**
 * Archive a Token — move an incremental update into `archivedTokens`
 * or route a divergent state into the fork map.
 *
 * Behavior preserved verbatim from the pre-split `archiveToken(token)`
 * (PaymentsModule.ts line 15330). The facade retains the private
 * `archiveToken()` method as a one-line delegation.
 */
export async function archiveTokenImpl(host: ArchiveTokenHost, token: Token): Promise<void> {
  const txf = tokenToTxf(token);
  if (!txf) return;

  const tokenId = txf.genesis?.data?.tokenId;
  if (!tokenId) return;

  const existingArchive = host.archivedTokens.get(tokenId);

  if (existingArchive) {
    if (isIncrementalUpdate(existingArchive, txf)) {
      host.archivedTokens.set(tokenId, txf);
      logger.debug('Payments', `Updated archived token ${tokenId.slice(0, 8)}...`);
    } else {
      // Fork
      const stateHash = getCurrentStateHash(txf) || '';
      await host.storeForkedToken(tokenId, stateHash, txf);
      logger.debug('Payments', `Archived token ${tokenId.slice(0, 8)}... is a fork`);
    }
  } else {
    host.archivedTokens.set(tokenId, txf);
    logger.debug('Payments', `Archived token ${tokenId.slice(0, 8)}...`);
  }
}

/**
 * Snapshot slice consumed by {@link createStorageData}. All fields are
 * read-only references — the caller owns the underlying storage.
 */
export interface CreateStorageDataSnapshot {
  readonly identity: FullIdentity;
  readonly tokens: ReadonlyMap<string, Token>;
  readonly nametags: readonly NametagData[];
  readonly tombstones: readonly TombstoneEntry[];
  readonly archivedTokens: ReadonlyMap<string, TxfToken>;
  readonly forkedTokens: ReadonlyMap<string, TxfToken>;
  readonly historyCache: readonly TransactionHistoryEntry[];
}

/**
 * Serialize the current in-memory state into TXF wire format.
 *
 * Behavior preserved verbatim from the pre-split `createStorageData()`
 * (PaymentsModule.ts line 15635). The facade retains the private
 * `createStorageData()` method as a one-line delegation.
 */
export async function createStorageData(
  snap: CreateStorageDataSnapshot,
): Promise<TxfStorageDataBase> {
  const sorted = [...snap.historyCache].sort((a, b) => b.timestamp - a.timestamp);
  return (await buildTxfStorageData(
    Array.from(snap.tokens.values()),
    {
      version: 1,
      address: snap.identity.chainPubkey,
      ipnsName: snap.identity.ipnsName ?? '',
    },
    {
      nametags: snap.nametags as NametagData[],
      tombstones: snap.tombstones as TombstoneEntry[],
      archivedTokens: snap.archivedTokens as Map<string, TxfToken>,
      forkedTokens: snap.forkedTokens as Map<string, TxfToken>,
      historyEntries: sorted.slice(0, MAX_SYNCED_HISTORY_ENTRIES),
    },
  )) as unknown as TxfStorageDataBase;
}

/**
 * Facade slice consumed by {@link loadFromStorageData}.
 *
 * The facade owns the state maps + arrays and passes them in for
 * in-place mutation. Two specific slots (`tombstones`,
 * `tombstoneKeySet`) are re-assigned atomically at the end of the
 * routine — the facade re-reads them from the returned diff via
 * `applyDiff`.
 *
 * Two hooks call back to facade logic that stays in place:
 *   - `latestStatePredicateMatchesWallet(token)` — PR #146 balance-model
 *     invariant used to decide archive-or-active.
 *   - `hasFinalizationPlan(token)` — #143's mutual-exclusivity refinement.
 *   - `isStateTombstoned(tokenId, stateHash)` — O(1) tombstone lookup.
 *   - `applyV6RecoverPermanentInvalidStatus()` — persistent-verdict overlay
 *     applied to the freshly-loaded tokens (Issue #387).
 */
export interface LoadFromStorageDataHost {
  readonly tokens: Map<string, Token>;
  tombstones: TombstoneEntry[];
  tombstoneKeySet: Set<string>;
  archivedTokens: Map<string, TxfToken>;
  forkedTokens: Map<string, TxfToken>;
  nametags: NametagData[];
  emitEvent<T extends SphereEventType>(type: T, data: SphereEventMap[T]): void;
  latestStatePredicateMatchesWallet(token: Token): boolean;
  hasFinalizationPlan(token: Token): boolean;
  isStateTombstoned(tokenId: string, stateHash: string): boolean;
  applyV6RecoverPermanentInvalidStatus(): void;
}

/**
 * The write-back diff produced by {@link loadFromStorageData}. Facade-
 * owned slots that the codec re-assigns must be re-read here — the
 * codec builds fresh containers for atomicity (mid-load exceptions
 * cannot leave the paired stores divergent) and for capturing the
 * snapshot's `archivedTokens` / `forkedTokens` Maps from `parseTxf
 * StorageData` output.
 *
 * The facade re-assigns each of these to its own field after
 * `loadFromStorageData` returns.
 */
export interface LoadFromStorageDataDiff {
  readonly tombstones: TombstoneEntry[];
  readonly tombstoneKeySet: Set<string>;
  readonly nametags: NametagData[];
  readonly archivedTokens: Map<string, TxfToken>;
  readonly forkedTokens: Map<string, TxfToken>;
}

/**
 * Apply merged TXF data from a provider, replacing in-memory maps.
 *
 * Behavior preserved verbatim from the pre-split `loadFromStorageData(data)`
 * (PaymentsModule.ts line 15654). The facade retains the private
 * `loadFromStorageData(data)` method as a delegation that also
 * re-assigns the two atomic fields from the returned diff.
 *
 * Three invariants MUST NOT drift (see the top-of-file docstring):
 *   1. Tombstone UNION-MERGE (#143 FIX D).
 *   2. NEVER-WIPE preserved-in-memory restore (2026-05-16).
 *   3. JOIN-divergent double-spend detection (Item #14 Phase 2 #5).
 */
export function loadFromStorageData(
  host: LoadFromStorageDataHost,
  data: TxfStorageDataBase,
): LoadFromStorageDataDiff {
  const parsed = parseTxfStorageData(data);
  logger.debug(
    'Payments',
    `loadFromStorageData: parsed ${parsed.tokens.length} tokens, ${parsed.tombstones.length} tombstones, errors=[${parsed.validationErrors.join('; ')}]`,
  );

  // #143 FIX D — UNION-MERGE tombstones (do NOT replace).
  //
  // Wholesale replacement is unsafe: when a remote/sync snapshot is older
  // than the local set (e.g. an in-flight send tombstoned a source AFTER
  // the snapshot was captured), `this.tombstones = parsed.tombstones`
  // drops the local tombstone. The just-spent source token then re-loads
  // from the snapshot, status='confirmed', and the spend planner sees a
  // phantom balance — the failure mode reported in #143.
  //
  // Union semantics mirror {@link mergeTombstones} (line ~6806). Local
  // tombstones survive sync; remote tombstones are added if not already
  // present. The keySet provides O(1) dedup.
  //
  // Loop1-S10 — build the merged ARRAY in a local first, then assign
  // both `this.tombstones` AND `this.tombstoneKeySet` atomically at
  // the end. The previous revision mutated `this.tombstones` in-place
  // during the loop while reassigning the keySet only AFTER the loop
  // exited; an exception mid-iteration (malformed snapshot, etc.)
  // would leave the two stores divergent until the next
  // `rebuildTombstoneKeySet`. Atomic assignment closes that hazard.
  const mergedKeySet = new Set(host.tombstoneKeySet);
  const mergedArray = [...host.tombstones];
  for (const t of parsed.tombstones) {
    // Defensive: skip malformed entries. A snapshot with a missing
    // tokenId or stateHash would create a "undefined:undefined" key
    // that matches any future token whose extract* returns undefined
    // — silent over-tombstoning.
    if (
      t === null ||
      typeof t !== 'object' ||
      typeof (t as { tokenId?: unknown }).tokenId !== 'string' ||
      typeof (t as { stateHash?: unknown }).stateHash !== 'string'
    ) {
      continue;
    }
    const k = `${t.tokenId}:${t.stateHash}`;
    if (!mergedKeySet.has(k)) {
      mergedArray.push(t);
      mergedKeySet.add(k);
    }
  }
  host.tombstones = mergedArray;
  host.tombstoneKeySet = mergedKeySet;
  // Load tokens, filtering out tombstoned ones.
  //
  // INVARIANT (2026-05-16): load() MUST NEVER drop tokens that exist
  // only in memory. Storage can lag (debounced flush, transient
  // pointer publish failures holding the at-least-once gate closed)
  // while addToken has already committed to `this.tokens`. A
  // wholesale `tokens.clear()` followed by "rebuild from storage"
  // silently wipes any token whose flush hasn't durably completed —
  // even though PaymentsModule originally accepted it. That is the
  // exact failure mode that caused profile-multi-device-sync to lose
  // 4 of 7 faucet drops when transient AGGREGATOR_POINTER_WALKBACK_FLOOR
  // errors held the publish gate closed.
  //
  // Policy:
  //   - Snapshot every in-memory token before clearing.
  //   - Storage data wins for tokens whose (tokenId, stateHash)
  //     identity matches a storage entry. The storage version is
  //     the most-recently-loaded definitive shape (proofs, etc.).
  //   - For every snapshot token that has NO matching storage
  //     entry: re-insert it after the storage load. These are
  //     tokens still in flight from in-memory to storage; dropping
  //     them would lose user state.
  //   - Tombstoned tokens (matching the tombstone set after the
  //     UNION-MERGE above) are dropped from the snapshot —
  //     consistent with the storage-side filter below.
  //
  // The pre-existing 'transferring' preservation guard is now
  // redundant (covered by the broader policy) but kept for clarity
  // at the call site. The newer `preservedFromMemory` map covers
  // every other status — confirmed, unconfirmed, pending, etc.
  const preservedFromMemory = new Map<string, Token>(host.tokens);

  host.tokens.clear();

  // Load other data EARLY so archive-move (below) can write into the
  // up-to-date archive map. Note: `this.nametags` is set further down
  // via the preservation guard so a sync provider that strips _nametags
  // doesn't transiently empty the in-memory nametag set (#136 / PR #140).
  host.archivedTokens = parsed.archivedTokens;
  host.forkedTokens = parsed.forkedTokens;

  let archiveMoved = 0;
  for (const token of parsed.tokens) {
    // Don't overwrite in-flight 'transferring' tokens from the
    // pre-clear snapshot. The broader NEVER-WIPE restore loop
    // below handles every OTHER status, but at the in-loop set
    // stage we still skip storage entries that would clobber a
    // 'transferring' in-flight send (the original guard).
    const existingTransferring = preservedFromMemory.get(token.id);
    if (existingTransferring?.status === 'transferring') continue;

    const sdkTokenId = extractTokenIdFromSdkData(token.sdkData);
    const stateHash = extractStateHashFromSdkData(token.sdkData);

    // Only filter if we have exact state match
    if (sdkTokenId && stateHash && host.isStateTombstoned(sdkTokenId, stateHash)) {
      logger.debug(
        'Payments',
        `Skipping tombstoned token ${sdkTokenId.slice(0, 8)}... during load (exact state match)`,
      );
      continue;
    }

    // #144 L3 — balance-model invariant: if the latest state's
    // predicate isn't ours AND no finalization plan exists, the token
    // has no place in the active map per #143's mutual-exclusivity
    // refinement. Move it to archive. Bob's stranded V6-direct receive
    // (the #144 reproduction case) is preserved because
    // `isReceivedLegacyPending → hasFinalizationPlan: true`.
    if (
      !host.latestStatePredicateMatchesWallet(token) &&
      !host.hasFinalizationPlan(token)
    ) {
      const txf = tokenToTxf(token);
      if (txf?.genesis?.data?.tokenId) {
        const archiveTokenId = txf.genesis.data.tokenId;
        // Steelman FIX E (#144): the archive map can already contain a
        // record for this tokenId — either from prior archiving (legit
        // history) or from a FORK (different state of same tokenId).
        // Pre-FIX-E we silently overwrote, destroying fork-detection
        // evidence. Now: if archive already has it, skip — the prior
        // record wins. The active-map removal still happens (we don't
        // re-add the token to `this.tokens`). Fork resolution should
        // happen via the explicit `archiveToken()`/`storeForkedToken`
        // flow, not via load-time invariant enforcement.
        if (host.archivedTokens.has(archiveTokenId)) {
          logger.debug(
            'Payments',
            `[BALANCE-INVARIANT] Token ${token.id.slice(0, 12)} ` +
              `already in archive — leaving existing record intact ` +
              `(possible fork or prior archive). Dropping active copy.`,
          );
        } else {
          host.archivedTokens.set(archiveTokenId, txf);
          logger.debug(
            'Payments',
            `[BALANCE-INVARIANT] Moved token ${token.id.slice(0, 12)} to archive — ` +
              `latest state predicate not ours, no finalization plan`,
          );
        }
        archiveMoved++;
        continue;
      }
      // Couldn't convert to TXF — keep in active to avoid data loss.
    }

    host.tokens.set(token.id, token);
  }
  if (archiveMoved > 0) {
    logger.debug(
      'Payments',
      `[BALANCE-INVARIANT] loadFromStorageData moved ${archiveMoved} token(s) to archive`,
    );
  }

  // NEVER-WIPE INVARIANT (2026-05-16): re-insert any token from the
  // pre-clear snapshot that storage did NOT supersede. Storage wins
  // when the same (tokenId, stateHash) identity already loaded —
  // those tokens are NOT restored from the snapshot (the storage
  // version is the canonical one). All other snapshot tokens (those
  // still in flight to storage, or those whose flush failed for any
  // reason) are restored. Tombstoned (tokenId, stateHash) pairs are
  // dropped to stay consistent with the storage-side filter.
  //
  // Build a set of the (tokenId, stateHash) identities now in
  // `this.tokens` from the storage load so the restore loop can
  // dedup cheaply. `Token.id` is internal and can differ between
  // a snapshot entry and a storage entry that represent the SAME
  // logical state — so the comparison MUST go through the SDK-data
  // extractors.
  const loadedStateKeys = new Set<string>();
  for (const t of host.tokens.values()) {
    const tid = extractTokenIdFromSdkData(t.sdkData);
    const sh = extractStateHashFromSdkData(t.sdkData);
    if (tid && sh) loadedStateKeys.add(createTokenStateKey(tid, sh));
  }

  let restoredFromMemory = 0;
  for (const [snapshotId, snapshotToken] of preservedFromMemory) {
    // Skip if storage already loaded a token at this id slot.
    if (host.tokens.has(snapshotId)) continue;

    const snapTokenId = extractTokenIdFromSdkData(snapshotToken.sdkData);
    const snapStateHash = extractStateHashFromSdkData(snapshotToken.sdkData);

    // Tombstoned (tokenId, stateHash) pair → drop (storage tombstone wins).
    if (
      snapTokenId &&
      snapStateHash &&
      host.isStateTombstoned(snapTokenId, snapStateHash)
    ) {
      continue;
    }

    // Storage already has this exact state under a different id slot
    // (rare — happens when storage's internal id differs from the
    // in-memory id for the same logical token). Storage wins.
    if (
      snapTokenId &&
      snapStateHash &&
      loadedStateKeys.has(createTokenStateKey(snapTokenId, snapStateHash))
    ) {
      continue;
    }

    // Snapshot has a NEWER state than what storage loaded for the
    // same tokenId. The newer state was added to memory after the
    // last successful flush and storage hasn't caught up. Archive
    // the older state in `this.tokens` (if present) and restore
    // the newer snapshot — matches addToken's CASE 2 semantics.
    if (snapTokenId) {
      let supersededOlder = false;
      // OUTBOX-SEND-FOLLOWUPS Item #14 Phase 2 work item 5 — JOIN-
      // divergent loser detection. When the preserved-from-memory
      // snapshot token is at status='transferring' (an in-flight
      // send) AND the storage load surfaced a DIFFERENT chain head
      // for the same genesisTokenId, the L3 aggregator has already
      // arbitrated against the local in-flight send (multi-device
      // double-spend race). The storage token is the winner; the
      // snapshot is a stale loser. We drop it (don't restore) and
      // emit `transfer:double-spend-detected` for operator visibility.
      //
      // For non-'transferring' snapshot statuses (e.g. 'confirmed')
      // we preserve the legacy dual-state restore — the spent-state
      // rescan worker (Item #16, default-ON post-soak) catches the
      // off-record spend on its next 5-min probe via
      // `oracle.isSpent` and routes through `defaultSpentStateTransition`.
      let supersededByJoinDivergence = false;
      let winnerStateHash: string | null = null;
      for (const [existingId, existingToken] of host.tokens) {
        if (!hasSameGenesisTokenId(existingToken, snapshotToken)) continue;
        const existingStateHash = extractStateHashFromSdkData(existingToken.sdkData);
        if (
          snapStateHash &&
          existingStateHash &&
          snapStateHash === existingStateHash
        ) {
          // Same exact state — storage's record wins (it was just loaded).
          supersededOlder = true;
          break;
        }
        // Different state. Branch on the snapshot token's status:
        if (snapshotToken.status === 'transferring') {
          // JOIN-divergent loser — drop the snapshot.
          supersededByJoinDivergence = true;
          winnerStateHash = existingStateHash ?? null;
          void existingId; // silence unused-var on the non-debug path
        }
        // Either branch ends the per-token loop — we've found the
        // same-genesisTokenId match.
        break;
      }
      if (supersededOlder) continue;
      if (supersededByJoinDivergence) {
        // Don't restore. The token's value is gone (aggregator
        // anchored the winner's commit; our submit failed at
        // `STATE_ALREADY_SPENT_BY_OTHER` per Item #14 Phase 1).
        //
        // Steelman H1 (PR #182 review): create a tombstone for the
        // dropped loser's (tokenId, stateHash) BEFORE the event
        // emit so a process restart between drop and event-consume
        // leaves a durable audit trail. The tombstone also blocks
        // a stale storage source from re-syncing the dead state
        // back into the active pool on a future load. Same
        // pattern as `removeToken` at line ~9512 — see
        // `createTombstoneFromToken` (line 878).
        const tombstone = createTombstoneFromToken(snapshotToken);
        if (tombstone) {
          const tombKey = `${tombstone.tokenId}:${tombstone.stateHash}`;
          if (!host.tombstoneKeySet.has(tombKey)) {
            host.tombstones.push(tombstone);
            host.tombstoneKeySet.add(tombKey);
          }
        }

        // The recipient field on the loser's bundle is the local
        // intended recipient; we don't have authoritative info on
        // the winning recipient. Emit with empty `ourIntendedRecipient`
        // and `winnerStateHash` so an operator can correlate to
        // the relevant SENT entry / OUTBOX archive if needed.
        //
        // The event matches the Item #14 Phase 1 reactive surface
        // (`transfer:double-spend-detected`) — the reactive surface
        // fires at submit-time, this surface fires at JOIN-time.
        // Operators expect to see the event from EITHER source.
        try {
          host.emitEvent('transfer:double-spend-detected', {
            tokenId: snapTokenId ?? '',
            sourceStateHash: snapStateHash ?? '',
            ourIntendedRecipient: '',
            detectedAt: Date.now(),
          });
        } catch (emitErr) {
          logger.warn(
            'Payments',
            `loadFromStorageData: emit transfer:double-spend-detected failed for token ${snapshotId.slice(0, 12)}…: ${emitErr instanceof Error ? emitErr.message : String(emitErr)}`,
          );
        }
        logger.debug(
          'Payments',
          `loadFromStorageData: JOIN-divergent loser dropped (tokenId=${snapTokenId?.slice(0, 16)}…, ` +
            `loser-stateHash=${snapStateHash?.slice(0, 16)}…, winner-stateHash=${winnerStateHash?.slice(0, 16) ?? '?'}…, ` +
            `snapshotId=${snapshotId.slice(0, 12)}…, tombstoned=${tombstone !== null}). Item #14 Phase 2 work item 5 — multi-device double-spend race.`,
        );
        continue;
      }
    }

    host.tokens.set(snapshotId, snapshotToken);
    restoredFromMemory++;
  }
  if (restoredFromMemory > 0) {
    logger.debug(
      'Payments',
      `[NEVER-WIPE] loadFromStorageData restored ${restoredFromMemory} in-memory ` +
        `token(s) not present in storage (likely in-flight or flush-stalled)`,
    );
  }

  // Nametag preservation guard (#136). Some sync providers strip
  // `_nametags` from merged data — overriding would transiently empty
  // `this.nametags` and any concurrent `finalizeTransferToken` would
  // throw "no Unicity ID token". Only override when the incoming data
  // actually carries nametag information. An explicit `_nametags: []`
  // (or legacy `_nametag`) from a different device still clears, as
  // expected.
  const rawData = data as unknown as Record<string, unknown>;
  const incomingHasNametags =
    Array.isArray(rawData._nametags) || rawData._nametag != null;
  if (incomingHasNametags || host.nametags.length === 0) {
    host.nametags = parsed.nametags;
  }

  // Issue #387 — every TXF round-trip through `parseTxfStorageData →
  // txfToToken → determineTokenStatus` rewrites token status from
  // {transactions, inclusionProof} only; the application-level
  // `'invalid'` verdict (set by `finalizeStrandedReceivedToken` after
  // a V6-RECOVER permanent-fail) is lost. Re-apply the persistent
  // `v6RecoverPermanent` ledger to the freshly-loaded tokens so the
  // verdict survives initial load AND every subsequent `sync()`
  // (which calls back into `loadFromStorageData`). No-op when the
  // ledger is empty.
  host.applyV6RecoverPermanentInvalidStatus();

  return {
    tombstones: host.tombstones,
    tombstoneKeySet: host.tombstoneKeySet,
    nametags: host.nametags,
    archivedTokens: host.archivedTokens,
    forkedTokens: host.forkedTokens,
  };
}
