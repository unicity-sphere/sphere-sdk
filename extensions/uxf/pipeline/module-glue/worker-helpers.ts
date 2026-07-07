/**
 * Worker helpers — Phase 5 [B] extraction from PaymentsModule.ts.
 *
 * Small worker-adjacent helpers that plug into the UXF pipeline:
 *
 *  - `writeSentEntryFromOutbox` — the SENT ledger write body called
 *    by the dispatchers + the SentReconciliationWorker.
 *  - `assertNoDuplicateBundleMembership` — Issue #166 P2 #2
 *    duplicate-bundle guard (source-side).
 *  - `detectOrphanSpendingTokens` — Issue #97 crash-window orphan
 *    sweeper wrapper.
 *  - `defaultOrphanRecovery` — Issue #166 P2 #1 recovery hook body
 *    (with the aggregator cross-check per OUTBOX-SEND-FOLLOWUPS
 *    item #1).
 *
 * See uxfv2-phase-5-payments-disposition.md §"install* worker seams"
 * for the disposition entries these functions satisfy. The install*
 * methods themselves remain one-liner private setters on the facade;
 * only the substantive helper bodies migrate here.
 */

import type { OrphanSweepResult, OrphanSpendingFinding } from '../orphan-spending-sweeper';
import { sweepOrphanSpendingTokens } from '../orphan-spending-sweeper';
import type { OutboxWriter } from '../../profile/outbox-writer';
import type { SentLedgerWriter } from '../../profile/sent-ledger-writer';
import type { UxfTransferOutboxEntry } from '../../types/uxf-outbox';
import type { OutboxCreateInput } from '../conservative-sender';
import type { OracleProvider } from '../../../../oracle';
import type { SphereEventType, SphereEventMap, Token } from '../../../../types';
import { SphereError } from '../../../../core/errors';
import { logger } from '../../../../core/logger';
import { extractStateHashFromSdkData } from '../../../../modules/payments/tokens/identity';
import { extractCurrentStatePublicKeyHexFromSdkData } from '../../../../modules/payments/legacy-v1/extract-state-publickey';

// -----------------------------------------------------------------
// writeSentEntryFromOutbox
// -----------------------------------------------------------------

/**
 * Host shim for {@link writeSentEntryFromOutbox}: exposes the
 * SentLedgerWriter reference (null when the extension hasn't
 * installed one — legacy wallets, tests, etc.).
 */
export interface SentWriterHost {
  readonly sentLedgerWriter: SentLedgerWriter | null;
}

/**
 * Write a SENT-ledger entry from an OUTBOX entry (either a live
 * `UxfTransferOutboxEntry` or the `OutboxCreateInput` seed the
 * instant-send orchestrator hands to its `write` hook).
 *
 * Returns:
 *   - `'success'` — SENT write succeeded;
 *   - `'skipped'` — no SENT ledger writer installed (Phase 6.C-shipped
 *     wallets always install one; legacy paths route here for the
 *     legacy synthetic-entry chain that the reconciliation worker
 *     watches);
 *   - `'failed'` — SENT write threw; the OUTBOX entry is kept live at
 *     `status='delivered'` per PR #97 commit `fcf1d53` so the
 *     `SentReconciliationWorker` retries on next tick.
 */
export async function writeSentEntryFromOutbox(
  host: SentWriterHost,
  entry: OutboxCreateInput,
  opLabel: string,
): Promise<'success' | 'failed' | 'skipped'> {
  if (host.sentLedgerWriter === null) return 'skipped';
  try {
    await host.sentLedgerWriter.write({
      id: entry.id,
      tokenIds: entry.tokenIds,
      bundleCid: entry.bundleCid,
      recipientTransportPubkey: entry.recipientTransportPubkey,
      recipient: entry.recipient,
      ...(typeof entry.recipientNametag === 'string'
        ? { recipientNametag: entry.recipientNametag }
        : {}),
      deliveryMethod: entry.deliveryMethod,
      mode: entry.mode,
      sentAt: Date.now(),
      // Issue #166 P2 #3 — propagate nostrEventId from OUTBOX to
      // SENT so the NostrPersistenceVerifier worker can re-query
      // the relay by event id later. Omitted when the OUTBOX entry
      // lacks the field (pre-P2 #3 entries or paths that haven't
      // wired the capture yet) so the SENT type guard's
      // "undefined OR non-empty string" rule holds.
      ...(typeof entry.nostrEventId === 'string' && entry.nostrEventId.length > 0
        ? { nostrEventId: entry.nostrEventId }
        : {}),
    });
    return 'success';
  } catch (sentErr) {
    logger.error(
      'Payments',
      `${opLabel}: SENT ledger write failed for outbox id ${entry.id} ` +
        `(bundle is already on the wire; OUTBOX entry kept live at status='delivered' as forensic record; ` +
        `operator triage required): ` +
        `${sentErr instanceof Error ? sentErr.message : String(sentErr)}`,
    );
    return 'failed';
  }
}

// -----------------------------------------------------------------
// assertNoDuplicateBundleMembership
// -----------------------------------------------------------------

/**
 * Host shim for the duplicate-bundle guard. Exposes only the
 * `OutboxWriter` — the guard is a pure predicate over its
 * `readAllNew()` output plus the candidate token-id set.
 */
export interface DuplicateBundleGuardHost {
  readonly outboxWriter: OutboxWriter | null;
}

/**
 * Issue #166 P2 #2 — duplicate-bundle guard.
 *
 * Verify that none of `candidateTokenIds` (= source tokens the new
 * bundle is about to commit-spend) is already referenced as a
 * SOURCE by a live OUTBOX entry. Throws `DUPLICATE_BUNDLE_MEMBERSHIP`
 * on the first overlap found.
 *
 * Issue #391 fixed the invariant this guard defends: compare against
 * `entry.sourceTokenIds`, NOT `entry.tokenIds` (which carries the
 * RECIPIENT mint-output ids). See the ledger commentary on the source
 * function in PaymentsModule.ts for the full failure-mode analysis.
 *
 * Self-skips when `allowOverride` is set, when the writer is null
 * (legacy path or bootstrap-not-yet), or when the candidate set is
 * empty. Read failures degrade to a `warn`-log + skip: the
 * load-bearing `'transferring'`-status filter in
 * `SpendPlanner.buildParsedPool` remains as the primary defense.
 */
export async function assertNoDuplicateBundleMembership(
  host: DuplicateBundleGuardHost,
  candidateTokenIds: ReadonlyArray<string>,
  options: { readonly opLabel: string; readonly allowOverride: boolean },
): Promise<void> {
  if (options.allowOverride) return;
  if (host.outboxWriter === null) return;
  if (candidateTokenIds.length === 0) return;

  const candidates = new Set<string>(candidateTokenIds);

  // ── OUTBOX check ────────────────────────────────────────────────────
  // Compare candidates against each entry's SOURCE set
  // (`sourceTokenIds`), which is the only field that can express the
  // "don't burn the same source twice" invariant this guard defends.
  // See issue #391 in the docstring above.
  let outboxEntries: ReadonlyArray<UxfTransferOutboxEntry>;
  try {
    outboxEntries = await host.outboxWriter.readAllNew();
  } catch (err) {
    logger.warn(
      'Payments',
      `${options.opLabel}: duplicate-bundle guard could not read OUTBOX (proceeding without check): ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  for (const entry of outboxEntries) {
    const sources = entry.sourceTokenIds;
    if (sources === undefined) continue; // pre-H5 entry — silently skip
    for (const tid of sources) {
      if (candidates.has(tid)) {
        throw new SphereError(
          `${options.opLabel}: refusing to include token ${tid} in this bundle — it is already in flight as a source of OUTBOX entry ${entry.id} (status=${entry.status}). Set TransferRequest.allowDuplicateBundleMembership=true to bypass this guard if the re-include is intentional.`,
          'DUPLICATE_BUNDLE_MEMBERSHIP',
        );
      }
    }
  }
}

// -----------------------------------------------------------------
// detectOrphanSpendingTokens + defaultOrphanRecovery
// -----------------------------------------------------------------

/**
 * Host shim for orphan detection + recovery. Exposes the four
 * writer/state references the sweeper reads plus the per-call
 * dispatcher-in-flight counter and the auto-recovery closure gate.
 */
export interface OrphanDetectionHost {
  readonly tokens: ReadonlyMap<string, Token>;
  readonly outboxWriter: OutboxWriter | null;
  readonly sentLedgerWriter: SentLedgerWriter | null;
  readonly oracle: OracleProvider;
  readonly identityChainPubkey: string;
  readonly dispatcherInFlightCount: number;
  readonly orphanAutoRecoveryEnabled: boolean;
  emitEvent<T extends SphereEventType>(type: T, data: SphereEventMap[T]): void;
  /** Mutate a token's status + `updatedAt` in-place, then re-set on the map. */
  setTokenStatus(id: string, next: 'confirmed'): void;
  /** Invalidate the parsed-token cache entry after a status change. */
  clearParsedCache(id: string): void;
  /** Persist the current in-memory state (facade's `save()`). */
  save(): Promise<void>;
}

/**
 * Issue #97 — Run the orphan-spending-tx sweeper once. Detects
 * tokens with an in-flight spending transaction (status
 * `'transferring'`) that are NOT referenced by any live OUTBOX
 * entry AND NOT recorded in the SENT ledger. Such tokens indicate
 * a crash between commit (Step 1) and outbox-persist (Step 2) of
 * the canonical send flow.
 *
 * Phase 1 (this release) — detection + diagnostic event only.
 * Auto-recovery gate is opt-in via `orphanAutoRecoveryEnabled`.
 */
export async function detectOrphanSpendingTokens(
  host: OrphanDetectionHost,
): Promise<OrphanSweepResult> {
  return sweepOrphanSpendingTokens({
    tokens: host.tokens.values(),
    outboxWriter: host.outboxWriter,
    sentLedgerWriter: host.sentLedgerWriter,
    emit: host.emitEvent,
    dispatcherInFlightCount: host.dispatcherInFlightCount,
    ...(host.orphanAutoRecoveryEnabled
      ? { attemptRecovery: (finding: OrphanSpendingFinding) => defaultOrphanRecovery(host, finding) }
      : {}),
  });
}

/**
 * Issue #166 P2 #1 — default orphan-spending recovery strategy.
 *
 * Restores an orphan token's status from `'transferring'` to
 * `'confirmed'` and persists the change. Before flipping status,
 * cross-check the aggregator (OUTBOX-SEND-FOLLOWUPS.md item #1) via
 * `oracle.isSpent(ownerPubkey, sourceStateHash)`.
 *
 * Throw safety: never throws — defense-in-depth converts every
 * thrown path (oracle RPC failure, `save()` rejection) to `'manual'`.
 */
export async function defaultOrphanRecovery(
  host: OrphanDetectionHost,
  finding: OrphanSpendingFinding,
): Promise<'recovered' | 'manual'> {
  const token = host.tokens.get(finding.tokenId);
  if (token === undefined) return 'manual';
  if (token.status !== 'transferring') return 'manual';

  const sourceStateHash = extractStateHashFromSdkData(token.sdkData);
  if (sourceStateHash === '') {
    logger.warn(
      'Payments',
      `defaultOrphanRecovery: token ${token.id} has no parseable stateHash on sdkData — ` +
        `cannot cross-check aggregator; escalating to manual triage.`,
    );
    return 'manual';
  }
  let aggregatorRecordsSpent: boolean;
  try {
    // Issue #243 / #245 #1 — pass owner pubkey alongside stateHash.
    // Prefer the publicKey embedded in the token's CURRENT state
    // predicate (canonical aggregator requestId basis). Fall back
    // to `chainPubkey` when the predicate cannot be parsed —
    // matches the legacy assumption that orphan recovery only fires
    // for our own locally-stranded tokens.
    const ownerPubkey =
      (await extractCurrentStatePublicKeyHexFromSdkData(token.sdkData)) ??
      host.identityChainPubkey;
    aggregatorRecordsSpent = await host.oracle.isSpent(ownerPubkey, sourceStateHash);
  } catch (oracleErr) {
    // Per OracleProvider.isSpent contract, an RPC failure throws
    // (never fail-open). Treat the throw as ambiguous: we cannot
    // rule out the spent case, so escalate.
    logger.warn(
      'Payments',
      `defaultOrphanRecovery: oracle.isSpent threw for token ${token.id} ` +
        `(stateHash=${sourceStateHash}) — fail-closed to manual triage: ` +
        `${oracleErr instanceof Error ? oracleErr.message : String(oracleErr)}`,
    );
    return 'manual';
  }
  if (aggregatorRecordsSpent) {
    logger.error(
      'Payments',
      `defaultOrphanRecovery: aggregator records source state spent for token ${token.id} ` +
        `(stateHash=${sourceStateHash}) — spending commit landed on-chain, local restore ` +
        `would diverge; escalating to manual triage. Operator action: re-package the bundle ` +
        `from the post-spend recipient context, or accept the value as already-sent.`,
    );
    return 'manual';
  }

  // Apply the in-memory restoration + parsed-cache eviction via the
  // host shim. Same mutation pattern the dispatcher uses at Loop1-S9.
  host.setTokenStatus(token.id, 'confirmed');
  host.clearParsedCache(token.id);

  // Persist. If save() throws, the in-memory restoration sticks
  // but durability is lost — degrade to 'manual' so the operator
  // sees the detected event.
  try {
    await host.save();
  } catch (saveErr) {
    logger.warn(
      'Payments',
      `defaultOrphanRecovery: save() failed for token ${token.id} (in-memory restoration applied but not persisted): ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`,
    );
    return 'manual';
  }
  return 'recovered';
}
