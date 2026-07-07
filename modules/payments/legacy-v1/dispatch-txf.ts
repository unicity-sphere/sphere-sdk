/**
 * @internal Phase 5 [C] quarantine — Phase 6.C deletes this file wholesale.
 * Legacy TXF wire dispatch path.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Token, TransferRequest, TransferResult } from '../../../types';
import type { PeerInfo } from '../../../transport';
import { logger } from '../../../core/logger';
import { SphereError } from '../../../core/errors';
import { extractTokenIdFromSdkData } from '../tokens';
import { Token as SdkToken } from '@unicitylabs/state-transition-sdk/lib/token/Token';
import { TransferCommitment } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferCommitment';
import { TransferTransactionData } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferTransactionData';
import { SigningService } from '@unicitylabs/state-transition-sdk/lib/sign/SigningService';
import { waitInclusionProof } from '@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils';
import type { StateTransitionClient } from '@unicitylabs/state-transition-sdk/lib/StateTransitionClient';
import {
  requireLegacyCoinSlot,
  type LegacyCoinTransferRequest,
} from '../../../extensions/uxf/pipeline/transfer-mode-shims';
import {
  sendTxfUxf,
  type TxfCommitResult,
  type TxfFinalization,
  type TxfSenderDeps,
} from '../../../extensions/uxf/pipeline/txf-sender';
import { classifyToken as classifyTokenLike } from '../../../extensions/uxf/pipeline/classify-token';
import { parseInvoiceMemoForOnChain } from '../../accounting/memo.js';
import { computeAddressId } from '../../../extensions/uxf/profile/types.js';
import type { SplitPlan } from '../TokenSplitCalculator';

export async function dispatchTxfSendImpl(this: any, 
    originalRequest: TransferRequest,
    txfFinalization: TxfFinalization,
  ): Promise<TransferResult> {
    // ── Symbol → hex coinId resolution (must run BEFORE requireLegacyCoinSlot) ─
    const request: LegacyCoinTransferRequest = requireLegacyCoinSlot(
      this.resolveCoinIdSymbol(originalRequest),
    );

    // Resolve recipient up front so the orchestrator gets a fully-typed
    // PeerInfo. Identical pattern to the UXF dispatchers.
    const peerInfo: PeerInfo | null =
      (await this.deps!.transport.resolve?.(request.recipient)) ?? null;
    const recipientPubkey = this.resolveTransportPubkey(request.recipient, peerInfo);
    const recipientAddress = await this.resolveRecipientAddress(
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

    const signingService = await this.createSigningService();
    const stClient = this.deps!.oracle.getStateTransitionClient?.() as
      | StateTransitionClient
      | undefined;
    if (!stClient) {
      throw new SphereError(
        'State transition client not available. Oracle provider must implement getStateTransitionClient()',
        'AGGREGATOR_ERROR',
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trustBase = (this.deps!.oracle as any).getTrustBase?.();
    if (!trustBase && txfFinalization === 'conservative') {
      // Trust base is only required for conservative (await proof) —
      // instant variant skips waitInclusionProof entirely.
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

    // Address id derivation — same rule as the instant dispatcher.
    const directForId = this.deps!.identity.directAddress;
    const addressId =
      typeof directForId === 'string' && directForId.length > 0
        ? computeAddressId(directForId)
        : this.deps!.identity.chainPubkey;

    const deps: TxfSenderDeps = {
      aggregator: this.deps!.oracle,
      transport: this.deps!.transport,
      tokenStorage: null,
      identity: this.deps!.identity,
      addressId,
      senderTransportPubkey: this.deps!.identity.chainPubkey,
      emit: (type, data) => this.deps!.emitEvent(type, data),
      availableSources: () => Array.from(this.tokens.values()),
      transferId,
      selectSources: async ({ request: req }) => {
        const parsedPool = await this.spendPlanner.buildParsedPool(
          Array.from(this.tokens.values()),
          request.coinId,
        );
        let pendingChangeAmount = 0n;
        for (const [, t] of this.tokens) {
          if (t.coinId === request.coinId && t.status === 'transferring') {
            pendingChangeAmount += BigInt(t.amount || '0');
          }
        }
        const planResult = this.spendPlanner.planSend(
          { amount: req.amount ?? '0', coinId: request.coinId },
          parsedPool,
          this.reservationLedger,
          this.spendQueue,
          transferId,
          pendingChangeAmount,
        );
        let splitPlan: SplitPlan;
        if (planResult === 'queued') {
          const queueResult = await this.spendQueue.waitForEntry(transferId);
          splitPlan = queueResult.splitPlan;
        } else {
          splitPlan = planResult.splitPlan;
        }
        const out: Token[] = splitPlan.tokensToTransferDirectly.map(
          (t) => t.uiToken,
        );
        if (splitPlan.tokenToSplit) out.push(splitPlan.tokenToSplit.uiToken);
        // Issue #166 P2 #2 — duplicate-bundle guard for the legacy TXF
        // path. Same contract as the UXF dispatchers above; guard
        // throws BEFORE the mark loop so source statuses are
        // preserved on rejection.
        await this.assertNoDuplicateBundleMembership(
          out.map((t) => t.id),
          {
            opLabel: 'dispatchUxfTxfLegacySend',
            allowOverride: req.allowDuplicateBundleMembership === true,
          },
        );
        for (const tok of out) {
          tok.status = 'transferring';
          this.tokens.set(tok.id, tok);
          this.parsedTokenCache.delete(tok.id);
        }
        await this.save();
        return out;
      },
      commitSources: async ({ sources }) => {
        const out: TxfCommitResult[] = [];
        for (const token of sources) {
          // Build commitment. Same SDK call for both finalization
          // variants — the difference is whether we await the
          // inclusion proof inline (conservative) or attach `null`
          // and let the worker poll later (instant).
          const commitment = await this.createSdkCommitment(
            token,
            recipientAddress,
            signingService,
            onChainMessage,
          );
          const submitResponse = await stClient.submitTransferCommitment(commitment);
          if (
            submitResponse.status !== 'SUCCESS' &&
            submitResponse.status !== 'REQUEST_ID_EXISTS'
          ) {
            throw new SphereError(
              `Transfer commitment failed: ${submitResponse.status}`,
              'TRANSFER_FAILED',
            );
          }

          const sourceTokenJson = token.sdkData
            ? typeof token.sdkData === 'string'
              ? token.sdkData
              : JSON.stringify(token.sdkData)
            : null;
          if (sourceTokenJson === null) {
            throw new SphereError(
              `Token ${token.id} missing sdkData; cannot ship via TXF`,
              'TRANSFER_FAILED',
            );
          }

          let transferTxJson: string;
          if (txfFinalization === 'conservative') {
            // Await the inclusion proof and attach to the transferTx.
            const inclusionProof = await waitInclusionProof(trustBase, stClient, commitment);
            const transferTx = commitment.toTransaction(inclusionProof);
            transferTxJson = JSON.stringify(transferTx.toJSON());
          } else {
            // Instant: ship the commitment with `inclusionProof: null`.
            transferTxJson = JSON.stringify({
              data: commitment.toJSON(),
              inclusionProof: null,
            });
          }

          const requestIdBytes = commitment.requestId;
          const requestIdHex =
            requestIdBytes instanceof Uint8Array
              ? Array.from(requestIdBytes)
                  .map((b) => b.toString(16).padStart(2, '0'))
                  .join('')
              : (typeof (requestIdBytes as { toJSON?: () => string }).toJSON === "function" ? (requestIdBytes as { toJSON: () => string }).toJSON() : String(requestIdBytes));

          // Class discrimination per C11 — read sdkData's coinData.
          const sourceTokenLike = {
            id: token.id,
            coins: (() => {
              try {
                const parsed = JSON.parse(sourceTokenJson) as {
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

          out.push({
            sourceTokenId: token.id,
            method: 'direct',
            requestIdHex,
            sourceTokenJson,
            transferTxJson,
            tokenClass,
          });

          // Conservative: archive the source immediately (proof is
          // attached, the recipient can finalize on their own).
          // Instant: leave the source as `transferring` — T.5.B's
          // worker handles the source-side bookkeeping after proof.
          if (txfFinalization === 'conservative') {
            await this.removeToken(token.id, transferId);
          }
        }
        return out;
      },
      // markSourcePending — instant variant: spendPlanner already
      // marked sources `transferring`. Production wiring will pivot
      // these to the canonical 'pending' enum in T.5.B.
      markSourcePending: async () => {
        // No-op — selectSources marks sources `transferring`.
      },
      // outbox — T.7.A leaves the writer unwired in the dispatcher.
      // The legacy synthetic-entry chain (saveToOutbox /
      // removeFromOutbox) is preserved by way of the spend planner /
      // remove-token paths above; the per-entry-key OutboxWriter
      // integration ships in a follow-up wave. Tests inject a recorder.
      outbox: undefined,
      // onTriggerFinalization — instant-TXF only; conservative skips.
      // Production wiring would register the per-token outbox entry
      // with the worker registry; T.5.B's worker picks up orphan
      // delivered-instant entries on boot regardless.
      onTriggerFinalization: undefined,
    };

    return sendTxfUxf(originalRequest, recipient, deps, txfFinalization);
}
