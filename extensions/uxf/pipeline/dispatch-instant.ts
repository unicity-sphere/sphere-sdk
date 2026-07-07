/**
 * UXF instant-mode dispatcher — Phase 5 [B] extraction from PaymentsModule.ts.
 *
 * This file hosts the verbatim body of `dispatchUxfInstantSend`, previously
 * a private method on {@link
 * import('../../../modules/payments/PaymentsModule').PaymentsModule}. The
 * facade now retains a one-liner delegator + a per-call
 * `dispatchInstantHost()` builder that captures every dependency the body
 * previously reached through `this` — following the host-shim pattern
 * established by wave-3 extractions
 * (`extensions/uxf/pipeline/module-glue/outbox-ops.ts`,
 * `sent-history-recorder.ts`, etc.).
 *
 * Behavior-preserving move: log strings, error messages, control flow,
 * and every subtle try/finally window are identical to the pre-extraction
 * source. See uxfv2-phase-5-payments-disposition.md §"UXF dispatch" for
 * the disposition entry this file satisfies.
 *
 * Entry point: {@link dispatchUxfInstantSendImpl}.
 */

import type { Token, TransferRequest, TransferResult, AddressMode } from '../../../types';
import type { PeerInfo } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import { logger } from '../../../core/logger';
import { SphereError } from '../../../core/errors';
import { computeAddressId } from '../profile/types.js';
import { classifyToken as classifyTokenLike } from './classify-token';
import {
  requireLegacyCoinSlot,
  type LegacyCoinTransferRequest,
} from './transfer-mode-shims';
import {
  sendInstantUxf,
  type InstantCommitResult,
  type InstantSenderDeps,
  type InstantSourceSelection,
} from './instant-sender';
import type { OutboxCreateInput } from './conservative-sender';
import type { RecordUxfBundleSentHistoryArgs } from './module-glue/sent-history-recorder';
import type { OutboxWriter } from '../profile/outbox-writer';
import type { UxfTransferOutboxEntry } from '../types/uxf-outbox';
import type {
  FinalizationWorkerSender,
  RequestContext,
} from './finalization-worker-sender';
import type { PaymentsModuleDependencies } from '../../../modules/payments/PaymentsModule';
import type {
  SpendPlanner,
  SpendQueue,
  ParsedTokenEntry,
} from '../../../modules/payments/SpendQueue';
import { type SplitPlan } from '../../../modules/payments/TokenSplitCalculator';
import type { TokenReservationLedger } from '../../../modules/payments/TokenReservationLedger';
import { InstantSplitExecutor } from '../../../modules/payments/InstantSplitExecutor';
import { parseInvoiceMemoForOnChain } from '../../../modules/accounting/memo.js';

// SDK imports for token parsing and transfers — extension code parked on v1
// uses the `stsdk-v1` npm alias (see eslint.config.js STSDK_PATTERN).
import { Token as SdkToken } from 'stsdk-v1/lib/token/Token';
import { TransferCommitment } from 'stsdk-v1/lib/transaction/TransferCommitment';
import { SigningService } from 'stsdk-v1/lib/sign/SigningService';
import type { IAddress } from 'stsdk-v1/lib/address/IAddress';
import type { StateTransitionClient } from 'stsdk-v1/lib/StateTransitionClient';

/**
 * Host shim capturing every dependency previously reached by the private
 * `dispatchUxfInstantSend` method through `this.*`. The facade rebuilds
 * this per call from its live private state; mutable containers
 * (`Map`, `Array`) are exposed as direct references so the extension's
 * in-place mutations still land on the facade.
 *
 * Design mirrors {@link
 * import('./module-glue/outbox-ops').OutboxOpsHost}: the facade produces
 * a fresh host on each dispatch, callback fields close over `this` via
 * arrow wrappers, and nullable install slots (outboxWriter,
 * finalizationWorkerSender) are snapshotted at call-time — install
 * methods do not fire mid-send, so this preserves semantics.
 */
export interface DispatchInstantHost {
  /** Non-null facade deps (caller guarantees `this.deps !== null`). */
  readonly deps: PaymentsModuleDependencies;

  // ---------------------------------------------------------------------------
  // Method callbacks — bound at host-build time via arrow wrappers.
  // ---------------------------------------------------------------------------
  resolveCoinIdSymbol(request: TransferRequest): TransferRequest;
  resolveTransportPubkey(recipient: string, peerInfo: PeerInfo | null): string;
  resolveRecipientAddress(
    recipient: string,
    addressMode?: AddressMode,
    peerInfo?: PeerInfo | null,
  ): Promise<IAddress>;
  createSigningService(): Promise<SigningService>;
  assertNoDuplicateBundleMembership(
    candidateTokenIds: ReadonlyArray<string>,
    options: { readonly opLabel: string; readonly allowOverride: boolean },
  ): Promise<void>;
  save(): Promise<void>;
  addToken(token: Token): Promise<boolean>;
  getCoinSymbol(coinId: string): string;
  getCoinName(coinId: string): string;
  getCoinDecimals(coinId: string): number;
  getCoinIconUrl(coinId: string): string | undefined;
  removeToken(tokenId: string, excludeReservationId?: string): Promise<void>;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extractCoinAmountForCache(sdkToken: SdkToken<any>, coinIdHex: string): bigint;
  emitDoubleSpendDetectedIfApplicable(err: unknown): void;
  writeSentEntryFromOutbox(
    entry: OutboxCreateInput,
    opLabel: string,
  ): Promise<'success' | 'failed' | 'skipped'>;
  recordUxfBundleSentHistory(args: RecordUxfBundleSentHistoryArgs): Promise<void>;

  // ---------------------------------------------------------------------------
  // Mutable state — exposed by reference so in-place edits reach the facade.
  // ---------------------------------------------------------------------------
  readonly tokens: Map<string, Token>;
  readonly parsedTokenCache: Map<string, ParsedTokenEntry>;
  readonly spendPlanner: SpendPlanner;
  readonly reservationLedger: TokenReservationLedger;
  readonly spendQueue: SpendQueue;
  readonly senderRequestContextMap: Map<string, RequestContext>;
  readonly senderOutboxMap: Map<string, UxfTransferOutboxEntry>;
  readonly pendingBackgroundTasks: Promise<void>[];

  // ---------------------------------------------------------------------------
  // Snapshot fields for optional install slots (install* methods do not fire
  // mid-send, so freeze-at-call-time is semantically identical to the
  // original `this._foo` reads).
  // ---------------------------------------------------------------------------
  readonly outboxWriter: OutboxWriter | null;
  readonly finalizationWorkerSender: FinalizationWorkerSender | null;
}

/**
 * UXF instant-mode send dispatcher (T.2.D.1 sibling, flag-gated).
 *
 * Verbatim body relocation from PaymentsModule.ts — every `this.foo`
 * access is swapped for `host.foo`, but log strings, error messages,
 * control flow, and the subtle try/finally + on-chain committed-token
 * bookkeeping are byte-identical to the pre-extraction source.
 *
 * Reached only when `features.senderUxf === true` AND
 * `transferMode === 'instant'`. Sibling to
 * `dispatchUxfConservativeSend`; delegates the §7.0 sender pipeline to
 * {@link sendInstantUxf}.
 */
export async function dispatchUxfInstantSendImpl(
  host: DispatchInstantHost,
  originalRequest: TransferRequest,
): Promise<TransferResult> {
    // ── Symbol → hex coinId resolution (must run BEFORE requireLegacyCoinSlot) ─
    const request: LegacyCoinTransferRequest = requireLegacyCoinSlot(
      host.resolveCoinIdSymbol(originalRequest),
    );

    const peerInfo: PeerInfo | null =
      (await host.deps.transport.resolve?.(request.recipient)) ?? null;
    const recipientPubkey = host.resolveTransportPubkey(request.recipient, peerInfo);
    const recipientAddress = await host.resolveRecipientAddress(
      request.recipient,
      request.addressMode,
      peerInfo,
    );

    const recipient: PeerInfo = peerInfo ?? {
      transportPubkey: recipientPubkey,
      chainPubkey: '',
      directAddress: '',
      timestamp: Date.now(),
    };

    const signingService = await host.createSigningService();
    const stClient = host.deps.oracle.getStateTransitionClient?.() as
      | StateTransitionClient
      | undefined;
    if (!stClient) {
      throw new SphereError(
        'State transition client not available. Oracle provider must implement getStateTransitionClient()',
        'AGGREGATOR_ERROR',
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trustBase = (host.deps.oracle as any).getTrustBase?.();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const devMode = (host.deps.oracle as any).isDevMode?.() ?? false;

    const onChainMessage = parseInvoiceMemoForOnChain(
      request.memo,
      request.invoiceRefundAddress,
      request.invoiceContact,
    );

    const transferId = crypto.randomUUID();

    // Derive the address-scoped outbox key prefix per
    // PROFILE-ARCHITECTURE §10.12. Falls back to the chainPubkey itself
    // when the wallet has no DIRECT address (test paths).
    const directForId = host.deps.identity.directAddress;
    const addressId =
      typeof directForId === 'string' && directForId.length > 0
        ? computeAddressId(directForId)
        : host.deps.identity.chainPubkey;

    // #142 — closure-captured queue of fire-and-forget post-transport
    // tasks. Currently only used by the split path to invoke
    // `awaitChangeTokenWithProofs()` after the bundle has shipped
    // (mirrors the legacy V6 path's `startBackground()` call at
    // PaymentsModule.ts:3772-3775). Failure inside any callback is
    // logged but never propagated — the publish has already succeeded.
    const postTransportBackgroundTasks: Array<() => Promise<void>> = [];

    // Loop1-S9 — every token selectSources marked `transferring` is
    // pushed here so the outer catch can restore non-committed
    // sources back to `confirmed` on failure. Without this, a
    // multi-source send that throws mid-commitSources leaves
    // already-marked-but-not-yet-committed tokens stuck `transferring`
    // forever (the spend planner skips them).
    const dispatcherSelectedTokenIds: string[] = [];

    // Loop1-S4 — tracks tokens whose ON-CHAIN commitment has been
    // submitted (split: burn proof landed; direct: transfer commit
    // accepted). The outer catch MUST NOT restore these to `confirmed`
    // — they're irrecoverable on-chain. Mirrors the legacy `send()`
    // arm's `committedOnChainTokenIds` (PaymentsModule.ts:3886).
    const dispatcherCommittedOnChainTokenIds = new Set<string>();

    // #149 — per-coin reservation ids. Mirrors the conservative
    // dispatcher's `reservationIds` array pattern (line ~8400). With
    // multi-asset planSend calls in `selectSources` below, each coin
    // gets its own `${transferId}:${coinId}[:${i}]` queue id so
    // promise-map collisions can't happen.
    const reservationIds: string[] = [];

    const deps: InstantSenderDeps = {
      aggregator: host.deps.oracle,
      transport: host.deps.transport,
      tokenStorage: null,
      identity: host.deps.identity,
      addressId,
      senderTransportPubkey: host.deps.identity.chainPubkey,
      emit: (type, data) => host.deps.emitEvent(type, data),
      // Issue #200 Phase 1 wiring: when the host injected a
      // `publishToIpfs` callback into `PaymentsModuleDependencies`,
      // pass it through to the instant sender so CID-bound delivery
      // branches actually pin. Absent → inline fallback (under cap) or
      // `IPFS_PUBLISHER_REQUIRED` throw (force-cid / over-cap auto).
      // MUST come from `createUxfCarPublisher` (see
      // `./transfer/ipfs-publisher.ts`).
      publishToIpfs: host.deps.publishToIpfs,
      availableSources: () => Array.from(host.tokens.values()),
      transferId,
      selectSources: async ({ request: req }) => {
        // #142/#149 — return the STRUCTURED selection shape with
        // `splitSources` (array). One entry per coin that needs
        // splitting (primary + each additional-asset coin). Direct
        // (whole-token) sources go into directSources.
        const directSources: Token[] = [];
        const splitSources: Array<NonNullable<InstantSourceSelection['splitSources']>[number]> = [];

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
        // Per-coin reservation id (mirrors conservative dispatcher).
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
          // Loop1-S2 — defensive guard. If the planner emits
          // `tokenToSplit` but `splitAmount` / `remainderAmount` is
          // null/zero, the previous code silently called BigInt(0) and
          // buildSplitBundle would burn the source for nothing
          // (zero-coin recipient, irrecoverable). Surface as an
          // INVALID_CONFIG throw — this is a planner bug, not user
          // input. Source stays `transferring`; outer catch restores
          // it via Loop1-S9 wiring (below in dispatcher).
          if (
            splitPlan.splitAmount === null ||
            splitPlan.remainderAmount === null ||
            splitPlan.splitAmount <= 0n
          ) {
            throw new SphereError(
              `dispatchUxfInstantSend: planner returned tokenToSplit with null/zero splitAmount=${String(splitPlan.splitAmount)} / remainderAmount=${String(splitPlan.remainderAmount)} for primary coinId=${request.coinId.slice(0, 16)}; refusing to burn source for zero-coin recipient`,
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
        // #149 — mirror conservative dispatcher; loop additionalAssets
        // and plan each independently. NFT entries are whole-token
        // (handled by commitSources, no plan needed).
        const additional = req.additionalAssets ?? [];
        for (let i = 0; i < additional.length; i++) {
          const asset = additional[i];
          if (asset.kind !== 'coin') continue;
          const addCoinId = asset.coinId;
          if (addCoinId === request.coinId) {
            throw new SphereError(
              `dispatchUxfInstantSend: additionalAssets[${i}].coinId duplicates primary coinId=${addCoinId.slice(0, 16)}; ` +
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
            if (
              addSplitPlan.splitAmount === null ||
              addSplitPlan.remainderAmount === null ||
              addSplitPlan.splitAmount <= 0n
            ) {
              throw new SphereError(
                `dispatchUxfInstantSend: planner returned tokenToSplit with null/zero splitAmount=${String(addSplitPlan.splitAmount)} / remainderAmount=${String(addSplitPlan.remainderAmount)} for additional coinId=${addCoinId.slice(0, 16)}; refusing to burn source for zero-coin recipient`,
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

        // Issue #166 P2 #2 — duplicate-bundle guard. Same contract as
        // the conservative dispatcher above; see that site for the
        // rationale + best-effort semantics.
        await host.assertNoDuplicateBundleMembership(
          [
            ...directSources.map((t) => t.id),
            ...splitSources.map((e) => e.token.id),
          ],
          {
            opLabel: 'dispatchUxfInstantSend',
            allowOverride: req.allowDuplicateBundleMembership === true,
          },
        );

        // Mark every selected source `transferring` + persist.
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
      commitSources: async ({ sources, splitSources }) => {
        const out: InstantCommitResult[] = [];
        // #149 — tokenId → splitEntry lookup for O(1) routing.
        // Orchestrator already validated tokenId uniqueness.
        const splitEntryByTokenId = new Map<
          string,
          NonNullable<InstantSourceSelection['splitSources']>[number]
        >();
        for (const entry of splitSources ?? []) {
          splitEntryByTokenId.set(entry.token.id, entry);
        }
        for (const token of sources) {
          // #142/#149 — split path. The legacy implementation discarded
          // the split intent and whole-token-transferred the source.
          // The fix routes each split source through InstantSplitExecutor
          // which burns the source and mints two new tokens: a
          // `splitAmount` slice for the recipient (transferred to
          // recipientAddress) and a `remainderAmount` change token
          // (kept by the sender). Coin sources are split via mint —
          // recipient and change get fresh tokenIds. Multiple split
          // entries (one per coin) run independent buildSplitBundle
          // invocations.
          const splitEntry = splitEntryByTokenId.get(token.id);
          if (splitEntry !== undefined) {
            if (trustBase === undefined) {
              throw new SphereError(
                'Trust base not available. Oracle provider must implement getTrustBase() for partial-amount sends.',
                'AGGREGATOR_ERROR',
              );
            }
            if (!token.sdkData || typeof token.sdkData !== 'string') {
              throw new SphereError(
                `Split source token ${token.id} missing sdkData`,
                'TRANSFER_FAILED',
              );
            }
            const sdkSourceToken = await SdkToken.fromJSON(JSON.parse(token.sdkData));
            const executor = new InstantSplitExecutor({
              stateTransitionClient: stClient,
              trustBase,
              signingService,
              devMode,
            });

            // Loop1-S4 + Loop2-C2 — burn-then-removeToken via
            // try/finally with `onBurnSubmitted` callback. The
            // executor invokes `onBurnSubmitted` AFTER its step-1
            // burn submit response is SUCCESS (durable on-chain) and
            // BEFORE the step-2 proof wait. From that moment on, any
            // throw — proof wait timeout, mint submit failure,
            // anything — leaves the source on-chain spent, so the
            // local source MUST be tombstoned. Pre-Loop2-C2 only
            // tracked `burnDone=true` AFTER buildSplitBundle returned
            // (= proof received) — proof-wait throws left the source
            // on-chain spent but not tombstoned.
            let burnDone = false;
            try {
              // #149 — capture coinId in a local for the change-token
              // callback closure. Using `splitEntry.coinIdHex` directly
              // works (the entry is loop-scoped), but a named local is
              // clearer and matches the conservative dispatcher's
              // pattern.
              const changeCoinId = splitEntry.coinIdHex;
              const splitResult = await executor.buildSplitBundle(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                sdkSourceToken as any,
                splitEntry.splitAmount,
                splitEntry.remainderAmount,
                splitEntry.coinIdHex,
                recipientAddress,
                {
                  message: onChainMessage,
                  // UXF dispatcher drives commitment submission via
                  // submitCommitmentsImmediate; suppress the legacy
                  // background path so commitments aren't double-submitted.
                  skipBackground: true,
                  // CONTRACT (Loop3-W3): this callback MUST NOT
                  // THROW. The executor catches and swallows any
                  // throw, but a throw here would leave `burnDone`
                  // false while the burn IS on-chain spent —
                  // recreating the phantom-token regression
                  // Loop2-C2 was designed to close. Keep this
                  // callback simple: `Set.add` + primitive
                  // assignment ONLY. Do NOT add any async / I/O /
                  // throwing operation here.
                  onBurnSubmitted: () => {
                    burnDone = true;
                    dispatcherCommittedOnChainTokenIds.add(token.id);
                  },
                  onChangeTokenCreated: async (changeToken) => {
                    // Persist the change token via the standard addToken
                    // pipeline. Fires after awaitChangeTokenWithProofs
                    // gets the sender's mint proof (~2s post-transport).
                    // #149 — use splitEntry.coinIdHex (NOT request.coinId)
                    // because additional-asset splits change-mint into
                    // their own coin class.
                    const changeTokenData = changeToken.toJSON();
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
                      `dispatchUxfInstantSend: change token persisted (coin=${changeCoinId.slice(0, 16)} amount=${changeUiToken.amount})`,
                    );
                  },
                  onStorageSync: async () => {
                    await host.save();
                    return true;
                  },
                },
              );
              // Loop2-C2 — `burnDone` is set by the onBurnSubmitted
              // callback inside buildSplitBundle, which fires AFTER the
              // burn submit response is SUCCESS and BEFORE the proof
              // wait. The callback already added `token.id` to
              // `dispatcherCommittedOnChainTokenIds`; nothing more to
              // do here. The contract is single-path:
              //
              //   callback fires ⇔ burn is on-chain ⇔ source tombstoned
              //
              // If buildSplitBundle returns without invoking the
              // callback (which would require an executor regression),
              // burnDone stays false and the source is restored by the
              // outer catch.

              // Loop1-S4 — queue awaitChangeTokenWithProofs BEFORE
              // submitCommitmentsImmediate so a partial-failure path
              // (sender mint succeeds, recipient mint or transfer
              // fails) still runs the change-token recovery. The bg
              // task is fired in BOTH success and failure paths of
              // the outer dispatcher catch.
              if (splitResult.awaitChangeTokenWithProofs !== undefined) {
                const bgTask = splitResult.awaitChangeTokenWithProofs;
                postTransportBackgroundTasks.push(async () => {
                  await bgTask();
                });
              }

              // Submit the three commitments (sender mint → recipient
              // mint → transfer; serial per Loop1-S3) to the aggregator
              // AND wait for the recipient mint inclusion proof (Loop4
              // e2e fix — UXF format requires genesis.inclusionProof
              // to be non-null). Fails on any non-SUCCESS — but the
              // burn is already anchored, so the source is gone
              // regardless.
              if (splitResult.submitCommitmentsImmediate === undefined) {
                throw new SphereError(
                  'InstantSplitExecutor.buildSplitBundle did not expose submitCommitmentsImmediate ' +
                    '— UXF dispatcher requires the #142 wiring',
                  'INVALID_CONFIG',
                );
              }
              const {
                recipientMintProvenGenesisJson,
                transferTransactionHashHex,
                transferAuthenticatorJsonStr,
              } = await splitResult.submitCommitmentsImmediate();

              // Loop4-S2 — populate per-requestId context for the
              // sender-side §6.1 finalization worker. Mirrors the
              // direct-path block at line ~9435 (Task #152 wiring).
              // Without this, the worker's resolver returns null on
              // the split-path requestId, hard-fails 'structural',
              // and `transfer:confirmed` never fires — the outbox
              // entry stays stuck at `delivered-instant` forever.
              if (
                host.finalizationWorkerSender !== null &&
                splitResult.transferRequestIdHex !== undefined &&
                splitResult.transferRequestIdHex.length > 0
              ) {
                host.senderRequestContextMap.set(splitResult.transferRequestIdHex, {
                  transactionHash: transferTransactionHashHex,
                  authenticator: transferAuthenticatorJsonStr,
                  nextEntryRest: { status: 'valid' as const },
                });
              }

              // Assemble recipient SDK Token JSON. The genesis is the
              // proven recipient mint transaction (with inclusionProof)
              // — required by the UXF format. The transfer transaction
              // ships with `inclusionProof: null`; the recipient's
              // chain-walker resolves it against the aggregator after
              // the transfer commit's proof lands.
              //
              // `recipientMintProvenGenesisJson` is already the
              // `{data, inclusionProof}` shape from
              // `TransferTransaction.toJSON()` — splatted directly into
              // the genesis slot.
              const recipientTokenJson = {
                version: '2.0',
                genesis: recipientMintProvenGenesisJson,
                state: splitResult.recipientMintedStateJson,
                transactions: [
                  {
                    data: splitResult.transferTxDataJson,
                    inclusionProof: null,
                  },
                ],
                nametags: [] as ReadonlyArray<unknown>,
              };

              out.push({
                sourceTokenId: token.id,
                method: 'split',
                requestIdHex: splitResult.transferRequestIdHex ?? '',
                recipientTokenJson,
                tokenClass: 'coin',
                splitParentTokenId: token.id,
                splitGroupId: splitResult.splitGroupId,
              });
            } finally {
              if (burnDone) {
                try {
                  // #143 UXF — source token is spent on-chain (burn
                  // submitted by buildSplitBundle step 1). Tombstone
                  // here in finally so even if submitCommitments or
                  // any later step threw, the source is removed and
                  // does not return as `confirmed` on the next load.
                  await host.removeToken(token.id, transferId);
                } catch (rmErr) {
                  logger.warn(
                    'Payments',
                    `dispatchUxfInstantSend: removeToken(${token.id}) failed after burn — manual cleanup may be needed: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`,
                  );
                }
              }
            }
            continue;
          }

          // Direct (whole-token) path — unchanged from pre-#142
          // behaviour for sources that the spend planner picked WITHOUT
          // a split. Submits the transfer commitment without awaiting
          // the inclusion proof; recipient's chain-walker resolves it
          // when the aggregator returns it.
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
            host.deps?.oracle,
            commitment,
            {
              tokenId: token.id,
              intendedRecipient: originalRequest.recipient,
            },
          );
          // Loop2-C1 — commit is on-chain from this point. Track AND
          // wrap the entire post-submit block in try/finally so
          // removeToken always fires, even if any of the JSON
          // construction / hash / classification steps throws.
          // Previous Loop1-S4 placement (add outside the try, try only
          // around the out.push) left a wide window where a throw
          // would leave the source committed-but-not-removed → zombie
          // `transferring` row after outer catch skipped restoration.
          let directCommitted = false;
          try {
            directCommitted = true;
            dispatcherCommittedOnChainTokenIds.add(token.id);
          // The transfer transaction goes on the bundle WITHOUT a
          // proof — the recipient's reader walks the chain when
          // proofs land.
          //
          // Use commitment.toJSON().transactionData (NOT commitment.toJSON())
          // because TransferCommitment.toJSON() returns
          // { authenticator, requestId, transactionData } — a Commitment
          // envelope — whereas the UXF deconstruct code expects `tx.data`
          // to be the flat TransferTransactionData shape
          // { sourceState, recipient, salt, recipientDataHash, message, nametags }.
          // Passing the commitment envelope causes every scalar field to be
          // `undefined`, which @ipld/dag-cbor rejects at encode time with
          // "undefined is not supported by the IPLD Data Model".
          //
          // Wave 6 — DO NOT embed `data.authenticator`. The Wave 5 attempt
          // to add `authenticator` under `data` was dead code in production:
          // the bundle is handed to `pkg.ingestAll(...)` which calls
          // `deconstructTransferData` (uxf/deconstruct.ts:486-512). That
          // function only deconstructs the explicit fields {recipient, salt,
          // recipientDataHash, message, nametagRefs} — `authenticator` is
          // silently dropped from the IPLD pool. On the recipient side,
          // `pkg.assemble(tokenId)` calls `assembleTransactionData`
          // (uxf/assemble.ts:361-398) which returns ONLY {sourceState,
          // recipient, salt, recipientDataHash, message, nametags}, so
          // `lastTxJson.data.authenticator` is undefined for EVERY round-
          // tripped bundle.
          //
          // The Wave 5 byte-pattern + synthetic test passed because it
          // never round-tripped through `pkg.ingestAll → pkg.toCar →
          // UxfPackage.fromCar → pkg.assemble`. We degrade gracefully
          // instead of extending the IPLD wire format: §6.1 race-lost
          // only depends on `transactionHash` (load-bearing), and §6.3
          // most-recent-proof compare uses the AGGREGATOR-returned
          // authenticator on both sides — the queue entry's authenticator
          // is metadata only. The recipient sets `authenticator = null`
          // and `canonicalAuthenticatorEquals` degrades to
          // transactionHash-only binding (the load-bearing check).
          const commitmentJson = commitment.toJSON();
          const transferTxJson = {
            data: commitmentJson.transactionData,
            inclusionProof: null,
          };
          const tokenJson = token.sdkData
            ? typeof token.sdkData === 'string'
              ? JSON.parse(token.sdkData)
              : token.sdkData
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
              transferTxJson,
            ],
          };
          // Loop2-C3 — tighten requestIdHex extraction. RequestId
          // extends DataHash whose toJSON() returns a hex imprint.
          // The previous fallback `String(requestIdBytes)` would ship
          // `"[object Object]"` if the SDK shape ever changed. Validate
          // explicitly and throw on SDK shape regression.
          const requestIdHexRawDirect = (commitment.requestId as { toJSON?: () => string })?.toJSON?.();
          if (typeof requestIdHexRawDirect !== 'string' || !/^[0-9a-f]+$/i.test(requestIdHexRawDirect)) {
            throw new SphereError(
              `dispatchUxfInstantSend: commitment.requestId.toJSON() returned non-hex (${typeof requestIdHexRawDirect}); SDK shape regression?`,
              'TRANSFER_FAILED',
            );
          }
          const requestIdHex = requestIdHexRawDirect;

          // Task #152 — store per-requestId context for the finalization
          // worker resolver. The §6.1 race-lost detection compares the LOCAL
          // `transactionHash` against the proof's `transactionHash` byte-for-
          // byte; both sides MUST be the actual SDK-encoded DataHash imprint
          // hex of the transaction-data hash (NOT the requestId).
          //
          //   - `transactionHash`: derived from `commitment.transactionData
          //     .calculateHash()` — same value the aggregator returns in
          //     `proof.transactionHash` once the commitment lands on chain.
          //   - `authenticator`: the canonical JSON serialization of the
          //     commitment's authenticator (publicKey + algorithm + signature
          //     + stateHash). Stored as a stable string so §6.3 byte-equality
          //     compares against the aggregator-returned authenticator JSON.
          //
          // Race-lost detection (finalization-worker-base.ts §6.1) compares
          // `pollOutcome.proof.transactionHash !== ctxResolved.transactionHash`.
          // Before this fix both sides used the requestId, making the compare
          // trivially equal and the detector silently dead in production.
          if (host.finalizationWorkerSender !== null) {
            // Compute the actual transactionHash imprint hex. `calculateHash`
            // returns a DataHash; `.toJSON()` returns the imprint hex.
            let txHashImprintHex: string;
            try {
              const txDataHash = await commitment.transactionData.calculateHash();
              txHashImprintHex = txDataHash.toJSON();
            } catch (err) {
              // Hard failure here would mean we cannot detect race-lost for
              // this commitment. Surface a clear runtime warning rather than
              // silently fall back to the requestId (which would re-introduce
              // the bug). Use the requestId hex as a non-fatal degraded value
              // and log so operators see the diagnostic.
              logger.warn(
                'Payments',
                `Task #152: failed to derive transactionHash for requestId ${requestIdHex.slice(0, 16)} — race-lost detection degraded (falling back to requestId). err=${err instanceof Error ? err.message : String(err)}`,
              );
              txHashImprintHex = requestIdHex;
            }
            // Stable canonical JSON of the authenticator. The aggregator-
            // returned proof carries the same shape (IAuthenticatorJson) in
            // `proof.proof.authenticator`; the adapter at line ~9026 strings
            // its copy with the same JSON.stringify() so byte-equality holds
            // for §6.3 same-value vs different-value resolution.
            const commitJson = (commitment as { toJSON?: () => { authenticator?: unknown } }).toJSON?.();
            const authenticatorJsonStr =
              commitJson?.authenticator !== undefined && commitJson.authenticator !== null
                ? JSON.stringify(commitJson.authenticator)
                : '';
            host.senderRequestContextMap.set(requestIdHex, {
              transactionHash: txHashImprintHex,
              authenticator: authenticatorJsonStr,
              nextEntryRest: { status: 'valid' as const },
            });
          }

          // Class discrimination per C11. Read sdkData's coinData to
          // route NFTs (whole-token transfer; no splitParent) vs
          // coins (splitParent set on the child).
          const sourceTokenLike = {
            id: token.id,
            coins: (() => {
              try {
                const parsed = JSON.parse(
                  typeof token.sdkData === 'string'
                    ? token.sdkData
                    : JSON.stringify(token.sdkData ?? {}),
                ) as {
                  genesis?: {
                    data?: {
                      coinData?: ReadonlyArray<readonly [string, string]> | null;
                    };
                  };
                };
                const cd = parsed?.genesis?.data?.coinData;
                if (!Array.isArray(cd) || cd.length === 0) return null;
                const coins = cd
                  .filter(
                    (e): e is readonly [string, string] =>
                      Array.isArray(e) && e.length === 2 &&
                      typeof e[0] === 'string' && typeof e[1] === 'string',
                  )
                  .map(([cid, amt]) => ({ coinId: cid, amount: BigInt(amt) }))
                  .filter((c) => c.amount > 0n);
                return coins.length > 0 ? coins : null;
              } catch {
                return [{ coinId: token.coinId, amount: BigInt(token.amount || '0') }];
              }
            })(),
          };
          const tokenClass = classifyTokenLike(sourceTokenLike);

            if (tokenClass === 'coin') {
              out.push({
                sourceTokenId: token.id,
                method: 'direct',
                requestIdHex,
                recipientTokenJson,
                tokenClass: 'coin',
                splitParentTokenId: token.id,
              });
            } else {
              out.push({
                sourceTokenId: token.id,
                method: 'direct',
                requestIdHex,
                recipientTokenJson,
                tokenClass: 'nft',
              });
            }
          } finally {
            // Loop2-C1 — removeToken always fires when the on-chain
            // commit is durable, regardless of any throw in the
            // post-submit JSON construction or classification path.
            // The try block starts immediately after submit-success
            // so this finally catches the widest possible window.
            if (directCommitted) {
              try {
                await host.removeToken(token.id, transferId);
              } catch (rmErr) {
                logger.warn(
                  'Payments',
                  `dispatchUxfInstantSend: removeToken(${token.id}) failed after on-chain commit — manual cleanup may be needed: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`,
                );
              }
            }
          }
        }
        return out;
      },
      // markSourcePending — production wiring would mark sources
      // 'pending' here. The existing legacy path's spendPlanner
      // already sets `status='transferring'`; T.5.B will pivot the
      // status to the canonical 'pending' enum once the worker lands.
      markSourcePending: async () => {
        // No-op for T.5.A — selectSources above already marks sources
        // `transferring` in the local cache.
      },
      // Phase 9.6.D + Issue #97 — wire the outbox-write hook so the
      // instant-sender persists every `packaging`/`pinned`/`sending`/
      // `delivered-instant` entry. The hook fires whenever EITHER:
      //  - a profile-resident OutboxWriter is installed (#97 crash
      //    safety — survives total local profile loss), OR
      //  - a finalization worker is installed (Phase 9.6.D — worker
      //    reads the in-memory map via FinalizationOutboxWriter).
      // When neither is wired, the hook is undefined (original T.5.A
      // behaviour — bare orchestrator path used by some unit tests).
      outbox: (host.outboxWriter !== null || host.finalizationWorkerSender !== null)
        ? {
            write: async (entry) => {
              const writer = host.outboxWriter;
              if (writer !== null) {
                // Durable profile write first — _senderOutboxMap is
                // mirrored from the returned stamped value so the
                // Lamport matches the writer's CRDT bump rule (§7.1).
                const written = await writer.write(entry);
                host.senderOutboxMap.set(entry.id, written);
              } else {
                // Legacy in-memory path — finalization worker only.
                const existing = host.senderOutboxMap.get(entry.id);
                host.senderOutboxMap.set(entry.id, {
                  ...entry,
                  _schemaVersion: 'uxf-1' as const,
                  lamport: (existing?.lamport ?? 0) + 1,
                });
              }

              // Issue #97 — write the SENT ledger entry on first
              // entry into the terminal-success status. In instant
              // mode the outbox entry stays live (the finalization
              // worker continues writing through it), so SENT and
              // OUTBOX coexist until the worker reaches `'finalized'`.
              // The `_schemaVersion: 'uxf-1'` discriminator on SENT
              // entries keeps them disjoint from the outbox keyspace.
              //
              // Idempotency: SentLedgerWriter.write is second-write-
              // wins. Repeated transitions into `delivered-instant`
              // (e.g. the recovery worker re-entering the same status
              // after a republish) re-stamp the SENT entry with a
              // fresh lamport but produce no duplicate record.
              //
              // SENT-write failure: error is logged at ERROR; the
              // bundle is already on the wire. No automatic recovery
              // — operator triage required (the sweeper cannot help
              // here because the source token is already cleared).
              if (entry.status === 'delivered-instant') {
                // OUTBOX-SEND-FOLLOWUPS item #7 — the helper's
                // parameter type is `OutboxCreateInput`, exactly the
                // shape the orchestrator passes here. No synthetic
                // `_schemaVersion`/`lamport: 0` placeholder needed:
                // neither field is read by the SENT-write path.
                await host.writeSentEntryFromOutbox(
                  entry,
                  'dispatchUxfInstantSend',
                );
              }
            },
          }
        : undefined,
      // Phase 9.6.D — trigger finalization after `delivered-instant`.
      // Fire-and-forget: any throw from processOne is logged, not
      // propagated — the publish has already completed and the outbox
      // entry holds the canonical state.
      onTriggerFinalization: host.finalizationWorkerSender !== null
        ? async ({ outboxId }) => {
            const entry = host.senderOutboxMap.get(outboxId);
            if (entry !== undefined && host.finalizationWorkerSender !== null) {
              void host.finalizationWorkerSender.processOne(entry).catch((err) => {
                logger.debug(
                  'Payments',
                  `FinalizationWorkerSender.processOne error for outbox ${outboxId}: ${err}`,
                );
              });
            }
          }
        : undefined,
    };

    // Loop1-S4/S7/S9 — wrap sendInstantUxf with reservation lifecycle
    // + source restoration + background-task firing in BOTH success
    // and failure paths. The orchestrator does not roll back source
    // state on failure; the dispatcher owns the cleanup.
    let result: TransferResult;
    try {
      result = await sendInstantUxf(originalRequest, recipient, deps);
      // Loop1-S7 + Loop3-W2 + #149 — commit every reservation id on
      // success (primary + per-additional-asset queue ids). Wrap each
      // in try/catch: ReservationLedger.commit is currently non-
      // throwing, but a future invariant assert shouldn't leak the
      // remaining commits. Mirrors the conservative dispatcher's
      // pattern (line ~8815).
      for (const rid of reservationIds) {
        try {
          host.reservationLedger.commit(rid);
        } catch (commitErr) {
          logger.warn(
            'Payments',
            `dispatchUxfInstantSend: reservationLedger.commit(${rid}) threw (swallowed): ${commitErr instanceof Error ? commitErr.message : String(commitErr)}`,
          );
        }
      }
    } catch (err) {
      // Loop1-S7 + Loop3-W2 + #149 — cancel every reservation id on
      // failure, wrapped per-id so one throw doesn't leak the rest.
      for (const rid of reservationIds) {
        try {
          host.reservationLedger.cancel(rid);
        } catch (cancelErr) {
          logger.warn(
            'Payments',
            `dispatchUxfInstantSend: reservationLedger.cancel(${rid}) threw (swallowed): ${cancelErr instanceof Error ? cancelErr.message : String(cancelErr)}`,
          );
        }
      }

      // Loop1-S9 + Loop2-W1 — restore any selected source NOT yet
      // on-chain committed. Without this, a multi-source send that
      // throws mid-commitSources (e.g. source-2's submit fails after
      // source-1 succeeded) leaves the still-`transferring` sources
      // stuck forever — the spend planner ignores them.
      //
      // Loop2-W1 — rebuild parsedTokenCache for the restored token so
      // the spend planner sees it again. Mirrors the legacy send()
      // catch path (PaymentsModule.ts:3900-3908). Without this, the
      // restored token is in `this.tokens` as `confirmed` but
      // invisible to spend planning until the next save/sync
      // rebuilds the cache.
      const restoredCoinIds = new Set<string>();
      for (const tokId of dispatcherSelectedTokenIds) {
        if (dispatcherCommittedOnChainTokenIds.has(tokId)) continue;
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
              // Parse failure — skip cache rebuild. Token still
              // marked confirmed; planner will re-parse on next
              // buildParsedPool.
            }
          }
        }
      }
      try {
        await host.save();
      } catch {
        // save() failure here is non-fatal; the in-memory restoration
        // applies for the rest of this session and the next load will
        // see the persistent state.
      }
      // Loop2-W2 + Loop3-W1 — notify the spend queue for EVERY
      // coinId the send touched, not just the ones whose tokens we
      // actually restored. A planSend failure on coin USDU before
      // ANY USDU token got marked `transferring` would otherwise
      // leave USDU's queue waiters parked indefinitely. Wrap each
      // notify in try/catch so a listener error doesn't mask the
      // original throw.
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
            `dispatchUxfInstantSend: spendQueue.notifyChange(${cid}) threw (swallowed): ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`,
          );
        }
      }

      // Loop1-S4 — fire post-transport bg tasks on failure too. The
      // change-token recovery task (awaitChangeTokenWithProofs) is
      // queued BEFORE submitCommitmentsImmediate in the split branch
      // (see Loop1-S4 in commitSources). If submit threw, the sender
      // mint may STILL have anchored (it's the first submission), in
      // which case the change-token recovery is needed even though
      // the dispatch failed.
      for (const task of postTransportBackgroundTasks) {
        const tracked: Promise<void> = task().catch((bgErr) => {
          logger.debug(
            'Payments',
            `dispatchUxfInstantSend: background task threw (post-failure): ${bgErr instanceof Error ? bgErr.message : String(bgErr)}`,
          );
        });
        // Push to module-level pending list so waitForPendingOperations()
        // drains them and tests can `await sphere.waitForPendingOperations()`.
        host.pendingBackgroundTasks.push(tracked);
      }

      // Item #14 Phase 1 — emit `transfer:double-spend-detected` if
      // the classified-submit helper raised
      // `STATE_ALREADY_SPENT_BY_OTHER`. Mirrors the conservative
      // dispatcher's emit; see that catch for the rationale.
      host.emitDoubleSpendDetectedIfApplicable(err);

      throw err;
    }

    // SUCCESS PATH: fire post-transport bg tasks.
    // #142 — each task is `awaitChangeTokenWithProofs()` for a split
    // source; it waits for the sender's mint proof (~2s) and persists
    // the change token via the closure-captured `onChangeTokenCreated`
    // callback. Failure is logged inside `awaitChangeTokenWithProofs`
    // (never re-thrown), so a `.catch` here is defense-in-depth only.
    for (const task of postTransportBackgroundTasks) {
      const tracked: Promise<void> = task().catch((err) => {
        logger.debug(
          'Payments',
          `dispatchUxfInstantSend: background task threw (post-transport): ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      // Loop1-S8 — track at module level so waitForPendingOperations()
      // can drain them.
      host.pendingBackgroundTasks.push(tracked);
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
      diagLabel: 'dispatchUxfInstantSend',
    });

    return result;
}
