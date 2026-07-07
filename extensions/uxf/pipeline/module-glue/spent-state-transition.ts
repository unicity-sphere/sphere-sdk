/**
 * `defaultSpentStateTransition` — Phase 5 [B] extraction from
 * PaymentsModule.ts. Default `transitionToAudit` route for the
 * spent-state rescan worker (Issue #174, UXF-TRANSFER-PROTOCOL
 * §12.3.2).
 *
 * See uxfv2-phase-5-payments-disposition.md §"install* worker seams"
 * for the disposition entry.
 */

import type { FullIdentity, Token } from '../../../../types';
import type { DispositionWriter } from '../../profile/disposition-writer';
import type { DispositionRecord } from '../../types/disposition';
import { extractTokenIdFromSdkData } from '../../../../modules/payments/tokens/identity';
import { computeAddressId } from '../../profile/types.js';
import { logger } from '../../../../core/logger';
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * Host shim for `defaultSpentStateTransition`. Wraps the four facade
 * collaborators the transition reads / calls:
 *   - `tokens` — in-memory map, read to detect concurrent removal /
 *     status drift.
 *   - `spentStateAuditWriter` — nullable DispositionWriter (Issue #174
 *     PR #B, lazy per Steelman H3).
 *   - `identity` — for the durable record's `senderTransportPubkey`
 *     field and address computation.
 *   - `removeToken` — the facade method that archives + tombstones +
 *     removes + persists.
 */
export interface SpentStateTransitionHost {
  readonly tokens: ReadonlyMap<string, Token>;
  readonly spentStateAuditWriter: DispositionWriter | null;
  readonly identity: FullIdentity | undefined;
  removeToken(id: string): Promise<void>;
}

/**
 * Issue #174 — default `transitionToAudit` route for the spent-state
 * rescan worker (UXF-TRANSFER-PROTOCOL §12.3.2).
 *
 * Strategy: the off-record spend is FINAL (the L3 aggregator confirmed
 * the source state is spent), so the local token's value is gone from
 * THIS wallet's perspective regardless of who spent it. Apply the same
 * local-side cleanup that a successful local send applies:
 *
 *   1. Archive the token to history.
 *   2. Write a tombstone for `(tokenId, stateHash)` so a subsequent
 *      sync (Item #15 profile-pointer rescan, manual restore, etc.)
 *      cannot resurrect the token.
 *   3. Remove from the active in-memory map.
 *   4. Persist via `save()`.
 *
 * This is `removeToken()`'s exact contract — we delegate to it. The
 * archived record + tombstone preserves forensic context (the event
 * already fired with `tokenId / coinId / amount / suspectedSibling
 * Instance`, so operators can correlate after the fact).
 *
 * **Defensive guards**:
 *  - Token concurrent-removal: `tokens.get(token.id)` may return
 *    `undefined` — no-op.
 *  - Status drift: if the token's status is no longer `'confirmed'`,
 *    defer to whichever path owns the transition.
 *  - `removeToken` throw: surface in a warn-log; the durable AUDIT
 *    record write is skipped so the wallet isn't left in a hybrid
 *    state.
 *
 * Never throws — defense-in-depth converts every error path to a
 * warn-log so the worker's outer `try/catch` in `probeOne` sees the
 * call as a "best-effort completion" rather than a failure.
 */
export async function defaultSpentStateTransition(
  host: SpentStateTransitionHost,
  params: {
    readonly token: Token;
    readonly currentStateHash: string;
    readonly suspectedSiblingInstance: boolean;
    readonly detectedAt: number;
  },
): Promise<void> {
  const live = host.tokens.get(params.token.id);
  if (live === undefined) {
    logger.debug(
      'Payments',
      `defaultSpentStateTransition: token ${params.token.id.slice(0, 12)}… already removed; no-op`,
    );
    return;
  }
  if (live.status !== 'confirmed') {
    logger.debug(
      'Payments',
      `defaultSpentStateTransition: token ${params.token.id.slice(0, 12)}… is now ${live.status} (not 'confirmed'); ` +
        `deferring to whatever path owns that transition`,
    );
    return;
  }
  try {
    // `removeToken` archives, tombstones, removes from the active map,
    // and persists via `save()`. All four are required for a clean
    // off-record-spend cleanup — partial application would either
    // leak forensic context (no archive) or risk re-sync resurrection
    // (no tombstone) or leave the in-memory map inconsistent.
    await host.removeToken(params.token.id);
    logger.debug(
      'Payments',
      `defaultSpentStateTransition: token ${params.token.id.slice(0, 12)}… ` +
        `(coin=${params.token.coinId.slice(0, 12)}, amount=${params.token.amount}, ` +
        `suspectedSibling=${params.suspectedSiblingInstance}) removed after off-record-spend ` +
        `(stateHash=${params.currentStateHash.slice(0, 16)}…, detectedAt=${params.detectedAt})`,
    );
  } catch (removeErr) {
    logger.warn(
      'Payments',
      `defaultSpentStateTransition: removeToken failed for ${params.token.id.slice(0, 12)}… ` +
        `(transfer:off-record-spent event already fired; operator triage recommended): ` +
        `${removeErr instanceof Error ? removeErr.message : String(removeErr)}`,
    );
    // Return early — without successful local cleanup, writing the
    // durable AUDIT record below could leave the wallet in a hybrid
    // state (active-pool token + `_audit` record for the same
    // tokenId). The next rescan cycle will retry both paths once
    // the underlying issue clears.
    return;
  }
  // Issue #174 (PR #B) — durable AUDIT record. Lazy field read
  // per Steelman H3: the writer lookup happens at probe time, not
  // at closure-bind time, so bootstrap ordering doesn't matter.
  const writer = host.spentStateAuditWriter;
  if (writer === null) return;
  const identity = host.identity;
  if (identity === undefined) {
    logger.warn(
      'Payments',
      `defaultSpentStateTransition: identity missing — skipping AUDIT record for ${params.token.id.slice(0, 12)}…`,
    );
    return;
  }
  const directAddr =
    typeof identity.directAddress === 'string' && identity.directAddress.length > 0
      ? identity.directAddress
      : null;
  const addr = directAddr !== null ? computeAddressId(directAddr) : identity.chainPubkey;
  try {
    const sdkTokenId = extractTokenIdFromSdkData(params.token.sdkData) ?? '';
    const sdkDataBytes = new TextEncoder().encode(params.token.sdkData ?? '');
    const digest = sha256(sdkDataBytes);
    let observedTokenContentHash = '';
    for (const b of digest) observedTokenContentHash += b.toString(16).padStart(2, '0');
    const auditRecord: DispositionRecord = {
      disposition: 'AUDIT',
      tokenId: sdkTokenId,
      observedTokenContentHash: observedTokenContentHash as DispositionRecord['observedTokenContentHash'],
      // Steelman H1 (PR #179 review): include the local token id so
      // two distinct tokens probed in the SAME millisecond produce
      // distinct synthetic markers in their respective
      // `bundleCidsObserved` lists.
      bundleCid: `local-rescan-${addr}-${params.token.id.slice(0, 12)}-${params.detectedAt}`,
      senderTransportPubkey: identity.chainPubkey,
      auditStatus: 'audit-off-record-spend',
      reason: 'off-record-spend',
    };
    await writer.write(addr, auditRecord);
    logger.debug(
      'Payments',
      `defaultSpentStateTransition: AUDIT record written for ${params.token.id.slice(0, 12)}… ` +
        `(addr=${addr.slice(0, 16)}…, tokenId=${sdkTokenId.slice(0, 16)}…, ` +
        `observedTokenContentHash=${observedTokenContentHash.slice(0, 16)}…)`,
    );
  } catch (writerErr) {
    logger.warn(
      'Payments',
      `defaultSpentStateTransition: AUDIT record write failed for ${params.token.id.slice(0, 12)}… ` +
        `(local cleanup already applied; durable record absent until next rescan or operator replay): ` +
        `${writerErr instanceof Error ? writerErr.message : String(writerErr)}`,
    );
  }
}
