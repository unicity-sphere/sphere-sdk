/**
 * UXF conservative-mode send dispatcher — Phase 5 [B] extraction from
 * PaymentsModule.ts (T.2.D.1).
 *
 * Reached only when `features.senderUxf === true` AND
 * `transferMode === 'conservative'`. Builds the {@link
 * ConservativeSenderDeps} surface from the module's existing private
 * state (oracle, transport, identity, spend planner, SDK helpers) and
 * delegates the §4.2 sender pipeline to {@link sendConservativeUxf}.
 *
 * See uxfv2-phase-5-payments-disposition.md §"UXF dispatch" for the
 * disposition entry. Extension-bound because the dispatcher composes
 * the UXF pipeline and its flag gate; the facade retains a private
 * one-liner delegator via the {@link DispatchConservativeHost} host
 * shim so the module's field layout stays decoupled from the pipeline.
 *
 * The host is built PER-CALL by the facade (like the other Phase 5
 * [B] extractions in `module-glue/`) so `this`-owned collaborators are
 * captured at the moment of dispatch. Do NOT cache the host object.
 */

import { Token as SdkToken } from 'stsdk-v1/lib/token/Token';
import { SigningService } from 'stsdk-v1/lib/sign/SigningService';
import type { StateTransitionClient } from 'stsdk-v1/lib/StateTransitionClient';
import { TransferCommitment } from 'stsdk-v1/lib/transaction/TransferCommitment';
import type { IAddress } from 'stsdk-v1/lib/address/IAddress';
import type { RootTrustBase } from 'stsdk-v1/lib/bft/RootTrustBase';
import { waitInclusionProof } from 'stsdk-v1/lib/util/InclusionProofUtils';

import { SphereError } from '../../../core/errors';
import { logger } from '../../../core/logger';
import type {
  FullIdentity,
  SphereEventMap,
  SphereEventType,
  Token,
  TransferRequest,
  TransferResult,
} from '../../../types';
import type { OracleProvider } from '../../../oracle';
import type { PeerInfo, TransportProvider } from '../../../transport';
import { parseInvoiceMemoForOnChain } from '../../../modules/accounting/memo.js';
import { TokenSplitExecutor } from '../../../modules/payments/legacy-v1/TokenSplitExecutor';
import type { ParsedTokenEntry, SpendPlanner, SpendQueue } from '../../../modules/payments/SpendQueue';
import type { SplitPlan } from '../../../modules/payments/legacy-v1/TokenSplitCalculator';
import type { TokenReservationLedger } from '../../../modules/payments/TokenReservationLedger';

import {
  requireLegacyCoinSlot,
  type LegacyCoinTransferRequest,
} from './transfer-mode-shims';
import {
  sendConservativeUxf,
  type ConservativeCommitResult,
  type ConservativeSenderDeps,
  type ConservativeSourceSelection,
  type OutboxCreateInput,
} from './conservative-sender';
import { finalizeSourceTokenChain } from './conservative-source-finalize';
import type { PublishToIpfsCallback } from './delivery-resolver';
import type { UxfTransferOutboxEntry } from '../types/uxf-outbox';
import type { OutboxWriter } from '../profile/outbox-writer';
import type { RecordUxfBundleSentHistoryArgs } from './module-glue/sent-history-recorder';

/**
 * Host shim for {@link dispatchUxfConservativeSendImpl}. Wraps every
 * facade collaborator the dispatcher reads or calls — the field layout
 * of `PaymentsModule` is entirely quarantined behind this interface.
 *
 * The facade builds a fresh host at each call site (like `assetsHost()`
 * in read-model/) so the mutable Map refs (`tokens`, `parsedTokenCache`,
 * `_senderOutboxMap`) are captured live at the moment of dispatch. The
 * `getOutboxWriter()` getter stays lazy because the two `outbox.create`
 * / `outbox.transition` callbacks inside {@link ConservativeSenderDeps}
 * re-read the writer on each invocation.
 */
export interface DispatchConservativeHost {
  /** Live in-memory Token map — Array.from + get + set. */
  readonly tokens: Map<string, Token>;
  /** Read-through parsed-token cache — .delete on writes, .set on rebuild. */
  readonly parsedTokenCache: Map<string, ParsedTokenEntry>;
  /** SpendPlanner instance — .buildParsedPool + .planSend. */
  readonly spendPlanner: SpendPlanner;
  /** SpendQueue instance — .waitForEntry + .notifyChange. */
  readonly spendQueue: SpendQueue;
  /** Reservation ledger — .commit + .cancel. */
  readonly reservationLedger: TokenReservationLedger;
  /** In-memory OUTBOX mirror — .set + .get + .delete. */
  readonly senderOutboxMap: Map<string, UxfTransferOutboxEntry>;

  /** `PaymentsModuleDependencies.transport`. */
  readonly transport: TransportProvider;
  /** `PaymentsModuleDependencies.oracle`. */
  readonly oracle: OracleProvider;
  /** `PaymentsModuleDependencies.identity`. */
  readonly identity: FullIdentity;
  /** `PaymentsModuleDependencies.publishToIpfs` (may be undefined). */
  readonly publishToIpfs: PublishToIpfsCallback | undefined;
  /** `PaymentsModuleDependencies.emitEvent`. */
  emitEvent<T extends SphereEventType>(type: T, data: SphereEventMap[T]): void;

  /**
   * Lazy accessor for the current `_outboxWriter`. The dispatcher
   * re-reads this inside the per-invocation `outbox.create` /
   * `outbox.transition` hooks; the getter mirrors the facade's field
   * lookup so late `installOutboxWriter()` calls still take effect on
   * the next dispatch invocation.
   */
  getOutboxWriter(): OutboxWriter | null;

  // ── Facade method delegators ─────────────────────────────────────────────
  resolveTransportPubkey(recipient: string, peerInfo?: PeerInfo | null): string;
  resolveRecipientAddress(
    recipient: string,
    addressMode: 'auto' | 'direct' | 'proxy' | undefined,
    peerInfo?: PeerInfo | null,
  ): Promise<IAddress>;
  resolveCoinIdSymbol(request: TransferRequest): TransferRequest;
  createSigningService(): Promise<SigningService>;
  createSdkCommitment(
    token: Token,
    recipientAddress: IAddress,
    signingService: SigningService,
    onChainMessage?: Uint8Array | null,
  ): Promise<TransferCommitment>;
  submitCommitmentClassified(
    stClient: StateTransitionClient,
    oracle: OracleProvider | undefined,
    commitment: TransferCommitment,
    classify: { readonly tokenId: string; readonly intendedRecipient: string },
  ): Promise<void>;
  assertNoDuplicateBundleMembership(
    candidateTokenIds: ReadonlyArray<string>,
    options: { readonly opLabel: string; readonly allowOverride: boolean },
  ): Promise<void>;
  save(): Promise<void>;
  addToken(token: Token): Promise<boolean>;
  removeToken(tokenId: string, excludeReservationId?: string): Promise<void>;
  saveToOutbox(transfer: TransferResult, recipient: string): Promise<void>;
  removeFromOutbox(transferId: string): Promise<void>;
  writeSentEntryFromOutbox(
    entry: OutboxCreateInput,
    opLabel: string,
  ): Promise<'success' | 'failed' | 'skipped'>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extractCoinAmountForCache(sdkToken: SdkToken<any>, coinIdHex: string): bigint;
  recordUxfBundleSentHistory(args: RecordUxfBundleSentHistoryArgs): Promise<void>;
  emitDoubleSpendDetectedIfApplicable(err: unknown): void;
  getCoinSymbol(coinId: string): string;
  getCoinName(coinId: string): string;
  getCoinDecimals(coinId: string): number;
  getCoinIconUrl(coinId: string): string | undefined;
}

/**
 * UXF conservative-mode send dispatcher (T.2.D.1, flag-gated).
 *
 * Reached only when `features.senderUxf === true` AND
 * `transferMode === 'conservative'`. Builds the {@link
 * ConservativeSenderDeps} surface from the module's existing private
 * state (oracle, transport, identity, spend planner, SDK helpers) and
 * delegates the §4.2 sender pipeline to {@link sendConservativeUxf}.
 *
 * **Stub outbox writer**: this dispatcher uses the existing legacy
 * `saveToOutbox`/`removeFromOutbox` chain so existing tests keep
 * their invariants. T.2.D.2 replaces this with the per-entry-key
 * UXF outbox writer.
 *
 * Restrictions inherited from T.1.B.1's `requireLegacyCoinSlot`:
 *  - The request MUST carry a primary `(coinId, amount)` slot. NFT-only
 *    and multi-asset shapes are accepted by the public type but
 *    rejected here until T.2.B's source-selection extension lands.
 */
export async function dispatchUxfConservativeSendImpl(
  host: DispatchConservativeHost,
  originalRequest: TransferRequest,
): Promise<TransferResult> {
  // ── Symbol → hex coinId resolution (must run BEFORE requireLegacyCoinSlot) ─
  const request: LegacyCoinTransferRequest = requireLegacyCoinSlot(
    host.resolveCoinIdSymbol(originalRequest),
  );

  // Resolve recipient + recipient address up front so the orchestrator
  // gets a fully-typed PeerInfo. This also serves the same identity-
  // binding/UI affordance the legacy arm provides.
  const peerInfo: PeerInfo | null =
    (await host.transport.resolve?.(request.recipient)) ?? null;
  const recipientPubkey = host.resolveTransportPubkey(request.recipient, peerInfo);
  const recipientAddress = await host.resolveRecipientAddress(
    request.recipient,
    request.addressMode,
    peerInfo,
  );

  // Synthesize a PeerInfo if `transport.resolve` returned null — the
  // orchestrator only needs `transportPubkey` and (optional) `nametag`.
  const recipient: PeerInfo = peerInfo ?? {
    transportPubkey: recipientPubkey,
    chainPubkey: '',
    directAddress: '',
    timestamp: Date.now(),
  };

  // Pre-build SDK helpers reused across all commitments. (Identical
  // to the legacy conservative arm — single signing service +
  // single state-transition client.)
  const signingService = await host.createSigningService();
  const stClient = host.oracle.getStateTransitionClient?.() as
    | StateTransitionClient
    | undefined;
  if (!stClient) {
    throw new SphereError(
      'State transition client not available. Oracle provider must implement getStateTransitionClient()',
      'AGGREGATOR_ERROR',
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const trustBase = (host.oracle as any).getTrustBase?.() as RootTrustBase | undefined;
  if (!trustBase) {
    throw new SphereError(
      'Trust base not available. Oracle provider must implement getTrustBase()',
      'AGGREGATOR_ERROR',
    );
  }

  const onChainMessage = parseInvoiceMemoForOnChain(
    request.memo,
    request.invoiceRefundAddress,
    request.invoiceContact,
  );

  const transferId = crypto.randomUUID();
  const committedOnChainTokenIds = new Set<string>();

  // Loop1-S9 — every token selectSources marked `transferring` is
  // pushed here so the outer catch can restore non-committed
  // sources back to `confirmed` on failure (mirrors the instant
  // dispatcher pattern).
  const dispatcherSelectedTokenIds: string[] = [];

  // Loop1-S7 + Loop2-W3 — track every reservation id (primary +
  // per-additional-asset queue id) so we can commit/cancel each
  // one at the end. Without this, multi-coin sends leak per-coin
  // ledger entries. Initialize empty — the conservative dispatcher
  // does NOT pass `transferId` itself to planSend (it uses
  // `${transferId}:${coinId}[:${i}]` keys); committing the bare
  // transferId was a silent no-op against ReservationLedger.
  const reservationIds: string[] = [];

  const deps: ConservativeSenderDeps = {
    aggregator: host.oracle,
    transport: host.transport,
    tokenStorage: null,
    identity: host.identity,
    senderTransportPubkey: host.identity.chainPubkey,
    emit: (type, data) => host.emitEvent(type, data),
    // Issue #200 Phase 1 wiring: when the host injected a
    // `publishToIpfs` callback into `PaymentsModuleDependencies`,
    // pass it through to the conservative sender so CID-bound
    // delivery branches (`force-cid`, over-cap `auto`) actually pin.
    // When absent, the sender falls back to inline delivery or
    // throws `IPFS_PUBLISHER_REQUIRED` per the resolver contract.
    // The callback MUST be obtained from `createUxfCarPublisher`
    // (see `./transfer/ipfs-publisher.ts`) — any other publisher
    // breaks the CID-correspondence contract.
    publishToIpfs: host.publishToIpfs,
    availableSources: () => Array.from(host.tokens.values()),
    transferId,
    selectSources: async ({ request: req }) => {
      // #142/#149 — return the structured ConservativeSourceSelection
      // shape with `splitSources` (array). Primary coin's split (if
      // needed) is the first entry; each additional-asset coin that
      // also needs splitting becomes its own entry. NFT additional
      // assets and direct-only sources go into `directSources`.
      const directSources: Token[] = [];
      const splitSources: Array<NonNullable<ConservativeSourceSelection['splitSources']>[number]> = [];

      // ── Primary coin ──────────────────────────────────────────────────────
      const parsedPool = await host.spendPlanner.buildParsedPool(
        Array.from(host.tokens.values()),
        request.coinId,
      );
      let pendingChangeAmount = 0n;
      for (const [, t] of host.tokens) {
        if (t.coinId === request.coinId && t.status === 'transferring') {
          pendingChangeAmount += BigInt(t.amount || '0');
        }
      }
      // Use a per-coin reservation id so additional-coin plans never
      // collide in SpendQueue.promises (which is keyed by entry id).
      const primaryQueueId = `${transferId}:${request.coinId}`;
      reservationIds.push(primaryQueueId);
      const planResult = host.spendPlanner.planSend(
        { amount: req.amount ?? '0', coinId: request.coinId },
        parsedPool,
        host.reservationLedger,
        host.spendQueue,
        primaryQueueId,
        pendingChangeAmount,
      );
      let splitPlan: SplitPlan;
      if (planResult === 'queued') {
        const queueResult = await host.spendQueue.waitForEntry(primaryQueueId);
        splitPlan = queueResult.splitPlan;
      } else {
        splitPlan = planResult.splitPlan;
      }
      directSources.push(...splitPlan.tokensToTransferDirectly.map((t) => t.uiToken));

      if (splitPlan.tokenToSplit) {
        // Loop1-S2 — defensive guard, mirrors the instant dispatcher.
        // A planner bug that returns tokenToSplit with null/zero
        // splitAmount would burn the source for nothing.
        if (
          splitPlan.splitAmount === null ||
          splitPlan.remainderAmount === null ||
          splitPlan.splitAmount <= 0n
        ) {
          throw new SphereError(
            `dispatchUxfConservativeSend: planner returned tokenToSplit with null/zero splitAmount=${String(splitPlan.splitAmount)} / remainderAmount=${String(splitPlan.remainderAmount)} for primary coinId=${request.coinId.slice(0, 16)}; refusing to burn source for zero-coin recipient`,
            'INVALID_CONFIG',
          );
        }
        splitSources.push({
          token: splitPlan.tokenToSplit.uiToken,
          splitAmount: splitPlan.splitAmount,
          remainderAmount: splitPlan.remainderAmount,
          coinIdHex: request.coinId,
        });
      }

      // ── Additional assets (coin entries only) ─────────────────────────────
      // #149 — each additional coin that needs splitting becomes its
      // own `splitSources` entry. Each is planned independently with
      // a unique queue id (${transferId}:${addCoinId}:${i}) to prevent
      // promise-map collisions when two entries queue for the same
      // SpendQueue.
      const additional = req.additionalAssets ?? [];
      for (let i = 0; i < additional.length; i++) {
        const asset = additional[i];
        if (asset.kind !== 'coin') continue; // NFT: whole-token, handled by commitSources
        const addCoinId = asset.coinId;
        // #149 invariant — duplicate coinIds (primary or earlier
        // additional) are a user-input bug. The send() validator
        // upstream should catch this, but defense-in-depth here
        // protects against the contract violation: orchestrator
        // would otherwise reject in its splitSources guard.
        if (addCoinId === request.coinId) {
          throw new SphereError(
            `dispatchUxfConservativeSend: additionalAssets[${i}].coinId duplicates primary coinId=${addCoinId.slice(0, 16)}; ` +
              'combine the amounts into the primary slot instead',
            'INVALID_CONFIG',
          );
        }
        const addParsedPool = await host.spendPlanner.buildParsedPool(
          Array.from(host.tokens.values()),
          addCoinId,
        );
        let addPendingChange = 0n;
        for (const [, t] of host.tokens) {
          if (t.coinId === addCoinId && t.status === 'transferring') {
            addPendingChange += BigInt(t.amount || '0');
          }
        }
        const addQueueId = `${transferId}:${addCoinId}:${i}`;
        reservationIds.push(addQueueId);
        const addPlanResult = host.spendPlanner.planSend(
          { amount: asset.amount, coinId: addCoinId },
          addParsedPool,
          host.reservationLedger,
          host.spendQueue,
          addQueueId,
          addPendingChange,
        );
        let addSplitPlan: SplitPlan;
        if (addPlanResult === 'queued') {
          const addQueueResult = await host.spendQueue.waitForEntry(addQueueId);
          addSplitPlan = addQueueResult.splitPlan;
        } else {
          addSplitPlan = addPlanResult.splitPlan;
        }
        directSources.push(...addSplitPlan.tokensToTransferDirectly.map((t) => t.uiToken));
        if (addSplitPlan.tokenToSplit) {
          // #149 — additional-asset split. Same defensive guard as
          // the primary coin path: null/zero splitAmount means a
          // planner bug; refuse to burn for zero-coin recipient.
          if (
            addSplitPlan.splitAmount === null ||
            addSplitPlan.remainderAmount === null ||
            addSplitPlan.splitAmount <= 0n
          ) {
            throw new SphereError(
              `dispatchUxfConservativeSend: planner returned tokenToSplit with null/zero splitAmount=${String(addSplitPlan.splitAmount)} / remainderAmount=${String(addSplitPlan.remainderAmount)} for additional coinId=${addCoinId.slice(0, 16)}; refusing to burn source for zero-coin recipient`,
              'INVALID_CONFIG',
            );
          }
          splitSources.push({
            token: addSplitPlan.tokenToSplit.uiToken,
            splitAmount: addSplitPlan.splitAmount,
            remainderAmount: addSplitPlan.remainderAmount,
            coinIdHex: addCoinId,
          });
        }
      }

      // [DIAG-UXF-SEND] all sources selected across primary + additionalAssets
      logger.debug('Payments', '[DIAG-UXF-SEND] selectSources result', {
        totalDirect: directSources.length,
        splitCount: splitSources.length,
        directIds: directSources.map((t) => `${t.id.slice(0, 12)}(${t.coinId.slice(0, 12)})`),
        splitIds: splitSources.map(
          (s) => `${s.token.id.slice(0, 12)}(${s.coinIdHex.slice(0, 12)}:${s.splitAmount.toString()})`,
        ),
        primaryCoinId: request.coinId.slice(0, 16),
        additionalCount: (req.additionalAssets ?? []).filter((a) => a.kind === 'coin').length,
      });

      // Issue #166 P2 #2 — duplicate-bundle guard. Refuse to mark
      // sources as transferring if any planned token id is already
      // referenced by a live OUTBOX entry or recorded in the SENT
      // ledger. The check is best-effort: read failures degrade to
      // a warn-log (the natural `'transferring'`-status filter in
      // SpendPlanner.buildParsedPool stays as the load-bearing
      // defense). Throws BEFORE the mark loop so a violation leaves
      // sources in their original status — no rollback needed.
      await host.assertNoDuplicateBundleMembership(
        [
          ...directSources.map((t) => t.id),
          ...splitSources.map((e) => e.token.id),
        ],
        {
          opLabel: 'dispatchUxfConservativeSend',
          allowOverride: req.allowDuplicateBundleMembership === true,
        },
      );

      // Issue #197 — finalize EVERY pending tx in EVERY selected
      // source's chain BEFORE marking them transferring and BEFORE
      // bundle construction. A local `status === 'confirmed'` is
      // INDEPENDENT of `sdkData.transactions[*].inclusionProof`
      // completeness — a token can be locally confirmed (e.g. via
      // the recipient dispositionWriter fallback flip from Issue #195,
      // or an instant-mode arrival whose deferred worker never ran)
      // and still carry a proofless tx in its embedded chain. The
      // recipient's `Token.verify(trustBase)` would then reject the
      // bundle (because it walks EVERY tx in the chain) and silently
      // wedge the token after `SdkToken.fromJSON` throws on the null
      // proof.
      //
      // `finalizeSourceTokenChain` is the SOLE SDK routine that walks
      // an SDK Token chain and attaches aggregator proofs. It is
      // idempotent (returns the input reference unchanged when the
      // chain is already fully finalized — no allocation) and throws
      // `SOURCE_CHAIN_HARD_FAIL` only on irrecoverable failures
      // (race-lost, sustained PATH_NOT_INCLUDED, etc.) — the
      // orchestrator's catch path emits `transfer:failed`.
      //
      // Run BEFORE marking as transferring so a hard-fail here leaves
      // no stale `'transferring'` state to clean up. The SpendQueue
      // reservation remains held; existing throw points (e.g.
      // commitSources) have the same property.
      for (let i = 0; i < directSources.length; i++) {
        const finalized = await finalizeSourceTokenChain(
          directSources[i],
          host.oracle,
        );
        if (finalized !== directSources[i]) {
          directSources[i] = finalized;
          host.tokens.set(finalized.id, finalized);
          host.parsedTokenCache.delete(finalized.id);
        }
      }
      for (let i = 0; i < splitSources.length; i++) {
        const finalized = await finalizeSourceTokenChain(
          splitSources[i].token,
          host.oracle,
        );
        if (finalized !== splitSources[i].token) {
          splitSources[i] = { ...splitSources[i], token: finalized };
          host.tokens.set(finalized.id, finalized);
          host.parsedTokenCache.delete(finalized.id);
        }
      }

      // Mark all selected sources as transferring + persist (matches legacy
      // semantics — prevents double-spend within the same session).
      for (const tok of directSources) {
        tok.status = 'transferring';
        host.tokens.set(tok.id, tok);
        host.parsedTokenCache.delete(tok.id);
        dispatcherSelectedTokenIds.push(tok.id);
      }
      for (const entry of splitSources) {
        entry.token.status = 'transferring';
        host.tokens.set(entry.token.id, entry.token);
        host.parsedTokenCache.delete(entry.token.id);
        dispatcherSelectedTokenIds.push(entry.token.id);
      }
      await host.save();
      return { directSources, splitSources };
    },
    preflightOptions: () => ({
      // Issue #197 — chain finalization happens earlier in
      // `selectSources` via the standard `finalizeSourceTokenChain`
      // helper, which returns NEW Token objects that the orchestrator
      // then passes to commitSources. Doing the work there (rather
      // than via the preflight callback hooks) avoids fighting the
      // `Token.sdkData` readonly contract and keeps a single SDK
      // routine — `finalizeSourceTokenChain` — as the sole place
      // that walks a chain and attaches aggregator proofs.
      //
      // Preflight is therefore a documented no-op here. If
      // `selectSources` ever regresses (or a future code path skips
      // it and routes through this orchestrator directly), the
      // recipient's `Token.verify(trustBase)` will reject the
      // bundle and the operator alert below catches it.
      resolveRequestId: () => {
        throw new SphereError(
          'preflight resolveRequestId invoked unexpectedly — ' +
            'selectSources should have already finalized all source chains via finalizeSourceTokenChain',
          'INVALID_CONFIG',
        );
      },
      extractPendingChain: () => [],
    }),
    commitSources: async ({ sources, splitSources }) => {
      // [DIAG-UXF-SEND] how many source tokens are being committed?
      logger.debug('Payments', '[DIAG-UXF-SEND] commitSources entry', {
        sourceCount: sources.length,
        sourceIds: sources.map((t) => `${t.id.slice(0, 12)}(${t.coinId.slice(0, 12)})`),
        splitCount: splitSources?.length ?? 0,
      });
      const out: ConservativeCommitResult[] = [];

      // #149 — build a tokenId → split entry lookup so the source-
      // iteration loop can branch in O(1). Orchestrator already
      // validated tokenId uniqueness.
      const splitEntryByTokenId = new Map<
        string,
        NonNullable<ConservativeSourceSelection['splitSources']>[number]
      >();
      for (const entry of splitSources ?? []) {
        splitEntryByTokenId.set(entry.token.id, entry);
      }

      for (const token of sources) {
        // #142/#149 — split path. The previous implementation
        // discarded the split intent and whole-token-transferred the
        // source. The fix routes EACH split source through
        // TokenSplitExecutor (one invocation per entry) which burns
        // the source, mints two new tokens (splitAmount for recipient,
        // remainderAmount for sender), and transfers the recipient
        // slice with full proofs (conservative semantics).
        const splitEntry = splitEntryByTokenId.get(token.id);
        if (splitEntry !== undefined) {
          if (!token.sdkData || typeof token.sdkData !== 'string') {
            throw new SphereError(
              `Split source token ${token.id} missing sdkData`,
              'TRANSFER_FAILED',
            );
          }
          const sdkSourceToken = await SdkToken.fromJSON(JSON.parse(token.sdkData));
          const splitExecutor = new TokenSplitExecutor({
            stateTransitionClient: stClient,
            trustBase,
            signingService,
          });

          // Loop2-C2 — burn-then-tombstone via try/finally. The
          // onBurnSubmitted callback fires from inside executeSplit
          // the moment the burn is durable on-chain (after submit
          // response, before proof wait). Any subsequent throw
          // (waitInclusionProof timeout, mint submit failure, etc.)
          // still leaves the source on-chain spent → must be
          // tombstoned locally regardless. The finally fires
          // removeToken if `burnDone` is true.
          let burnDone = false;
          try {
            const splitResult = await splitExecutor.executeSplit(
              sdkSourceToken,
              splitEntry.splitAmount,
              splitEntry.remainderAmount,
              splitEntry.coinIdHex,
              recipientAddress,
              onChainMessage,
              // CONTRACT (Loop3-W3): this callback MUST NOT THROW.
              // The executor swallows any throw, but a throw here
              // would desync `burnDone` from the on-chain reality
              // → phantom token. Keep this Set.add + primitive
              // assignment only.
              () => {
                burnDone = true;
                committedOnChainTokenIds.add(token.id);
              },
            );

            // Persist the change token (remainderAmount, sender-keyed).
            // #149 — use splitEntry.coinIdHex (NOT request.coinId)
            // because additional-asset splits change-mint into the
            // additional coin's class, not the primary coin's.
            const changeCoinId = splitEntry.coinIdHex;
            const changeTokenData = splitResult.tokenForSender.toJSON();
            const changeUiToken: Token = {
              id: crypto.randomUUID(),
              coinId: changeCoinId,
              symbol: host.getCoinSymbol(changeCoinId),
              name: host.getCoinName(changeCoinId),
              decimals: host.getCoinDecimals(changeCoinId),
              iconUrl: host.getCoinIconUrl(changeCoinId),
              amount: splitEntry.remainderAmount.toString(),
              status: 'confirmed',
              createdAt: Date.now(),
              updatedAt: Date.now(),
              sdkData: JSON.stringify(changeTokenData),
            };
            await host.addToken(changeUiToken);
            logger.debug(
              'Payments',
              `dispatchUxfConservativeSend: change token persisted (coin=${changeCoinId.slice(0, 16)} amount=${changeUiToken.amount})`,
            );

            // Assemble the recipient SDK Token JSON: mint genesis + the
            // mint-time state, plus the post-mint transfer transaction
            // (both with proofs because conservative).
            const recipientTokenJson = splitResult.tokenForRecipient.toJSON() as Record<string, unknown>;
            const transferTxJson = splitResult.recipientTransferTx.toJSON();
            const composedRecipientJson = {
              ...recipientTokenJson,
              transactions: [
                ...(((recipientTokenJson as { transactions?: unknown[] }).transactions) ?? []),
                transferTxJson,
              ],
            };

            // Loop1-S1 — capture requestIdHex from the SplitResult's
            // pre-computed field. TransferTransaction has NO requestId;
            // SplitResult.recipientTransferRequestIdHex is captured from
            // the underlying TransferCommitment BEFORE toTransaction().
            const transferRequestIdHex = splitResult.recipientTransferRequestIdHex;

            out.push({
              sourceTokenId: token.id,
              method: 'split',
              requestIdHex: transferRequestIdHex,
              recipientTokenJson: composedRecipientJson,
              splitGroupId: crypto.randomUUID(),
            });
          } finally {
            if (burnDone) {
              try {
                await host.removeToken(token.id, transferId);
              } catch (rmErr) {
                logger.warn(
                  'Payments',
                  `dispatchUxfConservativeSend: removeToken(${token.id}) failed after burn — manual cleanup may be needed: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`,
                );
              }
            }
          }
          continue;
        }

        // Direct (whole-token) path — Loop2-C2 try/finally so
        // removeToken always fires once the on-chain commit is
        // durable, even if waitInclusionProof times out / throws or
        // the JSON construction breaks.
        const commitment = await host.createSdkCommitment(
          token,
          recipientAddress,
          signingService,
          onChainMessage,
        );
        // Item #14 Phase 1 — route through the classified-submit
        // helper so a "state already spent by another commit"
        // outcome surfaces as `STATE_ALREADY_SPENT_BY_OTHER` (the
        // outer catch emits `transfer:double-spend-detected`)
        // rather than the legacy generic `TRANSFER_FAILED`.
        await host.submitCommitmentClassified(
          stClient,
          host.oracle,
          commitment,
          {
            tokenId: token.id,
            intendedRecipient: originalRequest.recipient,
          },
        );
        let consDirectCommitted = false;
        try {
          consDirectCommitted = true;
          committedOnChainTokenIds.add(token.id);
          const inclusionProof = await waitInclusionProof(trustBase, stClient, commitment);
          const transferTx = commitment.toTransaction(inclusionProof);
          // Reconstruct the recipient-token JSON shape (sourceToken +
          // post-transfer transition) for ingestion into the bundle.
          const tokenJson = token.sdkData
            ? (typeof token.sdkData === 'string' ? JSON.parse(token.sdkData) : token.sdkData)
            : null;
          if (!tokenJson || typeof tokenJson !== 'object') {
            throw new SphereError(
              `Token ${token.id} missing sdkData; cannot ingest into UXF bundle`,
              'TRANSFER_FAILED',
            );
          }
          const recipientTokenJson = {
            ...(tokenJson as Record<string, unknown>),
            transactions: [
              ...(((tokenJson as { transactions?: unknown[] }).transactions) ?? []),
              transferTx.toJSON(),
            ],
          };
          // Loop2-C3 — tighten requestIdHex extraction. RequestId
          // extends DataHash whose toJSON() returns a hex imprint.
          // Validate the shape; throw on SDK shape regression
          // instead of silently shipping garbage like
          // "[object Object]".
          const requestIdHexRaw = (commitment.requestId as { toJSON?: () => string })?.toJSON?.();
          if (typeof requestIdHexRaw !== 'string' || !/^[0-9a-f]+$/i.test(requestIdHexRaw)) {
            throw new SphereError(
              `dispatchUxfConservativeSend: commitment.requestId.toJSON() returned non-hex (${typeof requestIdHexRaw}); SDK shape regression?`,
              'TRANSFER_FAILED',
            );
          }
          const requestIdHex = requestIdHexRaw;
          out.push({
            sourceTokenId: token.id,
            method: 'direct',
            requestIdHex,
            recipientTokenJson,
          });
        } finally {
          if (consDirectCommitted) {
            try {
              await host.removeToken(token.id, transferId);
            } catch (rmErr) {
              logger.warn(
                'Payments',
                `dispatchUxfConservativeSend: removeToken(${token.id}) failed after on-chain commit — manual cleanup may be needed: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`,
              );
            }
          }
        }
      }
      return out;
    },
    outbox: {
      // T.2.D.2 + Issue #97 — orchestrator drives §7.0 via create/
      // transition. Production wiring threads a profile-resident
      // OutboxWriter via {@link installOutboxWriter}. When installed:
      //   - create:      writer.write(entry); _senderOutboxMap mirror
      //                  is set in lock-step; legacy saveToOutbox is
      //                  also called so consumers reading the legacy
      //                  snapshot still observe the entry.
      //   - transition:  writer.update(...) gates the arc via the
      //                  §7.0 validator; mirror updates in lock-step;
      //                  on `'delivered'` the legacy entry is dropped
      //                  via removeFromOutbox AND the profile entry
      //                  is tombstoned via writer.delete.
      // When the writer is NULL (legacy mode / tests without profile
      // wiring), the hooks fold onto the legacy KV chain alone — the
      // pre-#97 behaviour is preserved.
      create: async (entry) => {
        const writer = host.getOutboxWriter();
        if (writer !== null) {
          // Durable profile write first — the in-memory mirror is
          // hydrated from this on next restart.
          const written = await writer.write(entry);
          host.senderOutboxMap.set(entry.id, written);
        }
        const synthResult: TransferResult = {
          id: entry.id,
          status: 'submitted',
          tokens: [],
          tokenTransfers: [],
        };
        await host.saveToOutbox(synthResult, entry.recipientTransportPubkey);
      },
      transition: async (id, patch) => {
        const writer = host.getOutboxWriter();
        let updated: UxfTransferOutboxEntry | null = null;
        if (writer !== null) {
          // Route through the writer so the §7.0 validator gates the
          // arc. The mutator folds the patch onto the previous entry.
          updated = await writer.update(id, (prev) => ({
            ...prev,
            status: patch.status,
            ...(typeof patch.error === 'string' ? { error: patch.error } : {}),
            ...(typeof patch.submitRetryCount === 'number'
              ? { submitRetryCount: patch.submitRetryCount }
              : {}),
            // Issue #166 P2 #3 — persist the Nostr event id when the
            // dispatcher supplies it (sending → delivered arc).
            ...(typeof patch.nostrEventId === 'string' &&
            patch.nostrEventId.length > 0
              ? { nostrEventId: patch.nostrEventId }
              : {}),
            updatedAt: Date.now(),
          }));
          host.senderOutboxMap.set(id, updated);
        }
        if (patch.status === 'delivered') {
          // Issue #97 — write the permanent SENT record BEFORE
          // tombstoning the outbox entry. Order matters: if SENT
          // write fails we MUST NOT tombstone, otherwise the
          // delivery becomes invisible to all forensic paths
          // (`removeToken` has already cleared the source token's
          // `'transferring'` status earlier in the conservative
          // pipeline, so the orphan-spending sweeper cannot help).
          //
          // Source of truth for the SENT shape is the in-memory
          // mirror entry (which was just updated above).
          const mirror = host.senderOutboxMap.get(id) ?? updated;
          const sentResult: 'success' | 'failed' | 'skipped' =
            mirror !== null
              ? await host.writeSentEntryFromOutbox(
                  mirror,
                  'dispatchUxfConservativeSend',
                )
              : 'skipped';

          if (sentResult === 'failed') {
            // Steelman item 4 — keep the OUTBOX entry live at
            // status='delivered' as the forensic record so an
            // operator (or a future profile-level reconciliation
            // job) can re-attempt the SENT write. DO NOT tombstone
            // the profile entry. The legacy KV entry IS removed
            // (legacy outbox doesn't track 'delivered'), but the
            // profile entry persists — that's the load-bearing
            // signal.
            logger.warn(
              'Payments',
              `dispatchUxfConservativeSend: SENT write failed for ${id} — leaving profile OUTBOX entry live at status='delivered' for operator triage`,
            );
            try {
              await host.removeFromOutbox(id);
            } catch (legacyErr) {
              logger.warn(
                'Payments',
                `dispatchUxfConservativeSend: legacy removeFromOutbox(${id}) threw (non-fatal): ${legacyErr instanceof Error ? legacyErr.message : String(legacyErr)}`,
              );
            }
            // Intentionally NOT calling writer.delete here.
          } else {
            // 'success' OR 'skipped' (legacy mode) — proceed to
            // tombstone the profile entry AND drop the legacy KV
            // entry. The two drops are independently wrapped so a
            // throw in one doesn't skip the other.
            try {
              await host.removeFromOutbox(id);
            } catch (legacyErr) {
              logger.warn(
                'Payments',
                `dispatchUxfConservativeSend: legacy removeFromOutbox(${id}) threw (proceeding to profile tombstone): ${legacyErr instanceof Error ? legacyErr.message : String(legacyErr)}`,
              );
            }
            if (writer !== null) {
              try {
                await writer.delete(id);
                host.senderOutboxMap.delete(id);
              } catch (delErr) {
                logger.warn(
                  'Payments',
                  `dispatchUxfConservativeSend: outboxWriter.delete(${id}) failed (profile entry left live at status='delivered'; operator-recoverable): ${delErr instanceof Error ? delErr.message : String(delErr)}`,
                );
              }
            }
          }
        }
      },
    },
  };

  // Loop1-S7/S9 — wrap sendConservativeUxf with reservation
  // lifecycle + source restoration. The orchestrator does not roll
  // back source state on failure; the dispatcher owns the cleanup.
  let result: TransferResult;
  try {
    result = await sendConservativeUxf(originalRequest, recipient, deps);
    // Loop1-S7 + Loop3-W2 — commit every reservation id allocated
    // by selectSources (primary + per-additional-asset queue ids).
    // Wrap each in try/catch: ReservationLedger.commit is
    // currently non-throwing, but a future invariant assert
    // shouldn't leak the remaining commits.
    for (const rid of reservationIds) {
      try {
        host.reservationLedger.commit(rid);
      } catch (commitErr) {
        logger.warn(
          'Payments',
          `dispatchUxfConservativeSend: reservationLedger.commit(${rid}) threw (swallowed): ${commitErr instanceof Error ? commitErr.message : String(commitErr)}`,
        );
      }
    }
  } catch (err) {
    // Loop1-S7 + Loop3-W2 — cancel every reservation id on failure,
    // wrapped per-id so one throw doesn't leak the rest.
    for (const rid of reservationIds) {
      try {
        host.reservationLedger.cancel(rid);
      } catch (cancelErr) {
        logger.warn(
          'Payments',
          `dispatchUxfConservativeSend: reservationLedger.cancel(${rid}) threw (swallowed): ${cancelErr instanceof Error ? cancelErr.message : String(cancelErr)}`,
        );
      }
    }

    // Loop1-S9 + Loop2-W1 — restore non-committed selected sources
    // AND rebuild parsedTokenCache. Same semantics as the instant
    // dispatcher.
    const restoredCoinIds = new Set<string>();
    for (const tokId of dispatcherSelectedTokenIds) {
      if (committedOnChainTokenIds.has(tokId)) continue;
      const tok = host.tokens.get(tokId);
      if (tok !== undefined && tok.status === 'transferring') {
        tok.status = 'confirmed';
        tok.updatedAt = Date.now();
        host.tokens.set(tokId, tok);
        restoredCoinIds.add(tok.coinId);
        if (tok.sdkData) {
          try {
            const parsed = JSON.parse(tok.sdkData);
            const sdkToken = await SdkToken.fromJSON(parsed);
            const amount = host.extractCoinAmountForCache(sdkToken, tok.coinId);
            if (amount > 0n) {
              host.parsedTokenCache.set(tok.id, { token: tok, sdkToken, amount });
            }
          } catch {
            // Parse failure — skip cache rebuild.
          }
        }
      }
    }
    try {
      await host.save();
    } catch {
      // Non-fatal — in-memory state still reflects restoration.
    }
    // Loop2-W2 + Loop3-W1 — notify every coinId the send touched
    // (primary + every additional-asset coin), not just the ones
    // whose tokens we actually restored. Wrapped per coin.
    restoredCoinIds.add(request.coinId);
    for (const asset of originalRequest.additionalAssets ?? []) {
      if (asset.kind === 'coin') {
        restoredCoinIds.add(asset.coinId);
      }
    }
    for (const cid of restoredCoinIds) {
      try {
        host.spendQueue.notifyChange(cid);
      } catch (notifyErr) {
        logger.warn(
          'Payments',
          `dispatchUxfConservativeSend: spendQueue.notifyChange(${cid}) threw (swallowed): ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`,
        );
      }
    }

    // Item #14 Phase 1 — emit `transfer:double-spend-detected` when
    // the classified-submit helper raised
    // `STATE_ALREADY_SPENT_BY_OTHER`. The diagnostic payload
    // (`tokenId`, `sourceStateHash`, `ourIntendedRecipient`) was
    // stashed via `cause` at the throw site so operators / UIs can
    // route this case differently from `transfer:orphan-spending-detected`
    // (crash-window orphan vs. on-chain double-spend loss).
    host.emitDoubleSpendDetectedIfApplicable(err);

    throw err;
  }

  // #143 UXF + #149 multi-coin — record one SENT history entry per coin
  // shipped in the bundle (primary + each additionalAssets coin). The
  // helper pivots result.tokenTransfers by source coinId and emits an
  // entry per coin; each emission is wrapped in its own try/catch so a
  // history I/O hiccup never flips a successful send into a thrown error.
  await host.recordUxfBundleSentHistory({
    originalRequest,
    request,
    result,
    peerInfo,
    recipientPubkey,
    recipientAddress,
    diagLabel: 'dispatchUxfConservativeSend',
  });

  return result;
}
