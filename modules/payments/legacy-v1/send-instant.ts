/**
 * @internal Phase 5 [C] quarantine — Phase 6.C deletes this file wholesale.
 *
 * Legacy v1 `sendInstant` — v1 instant-split send path. Uses v1 STSDK
 * commitment machinery + InstantSplitExecutor. The facade
 * (PaymentsModule.sendInstant) delegates here via `.call(this, ...)` so
 * `this.foo` references still work despite `this: any`.
 */

import type { Token, TransferRequest } from '../../../types';
import type {
  InstantSplitOptions,
  InstantSplitResult,
} from '../../../types/instant-split';
import type { PeerInfo } from '../../../transport';
import { InstantSplitExecutor } from './InstantSplitExecutor';
import { logger } from '../../../core/logger';
import { SphereError } from '../../../core/errors';
import { Token as SdkToken } from '@unicitylabs/state-transition-sdk/lib/token/Token';
import type { StateTransitionClient } from '@unicitylabs/state-transition-sdk/lib/StateTransitionClient';
import {
  requireLegacyCoinSlot,
  type LegacyCoinTransferRequest,
} from '../../../extensions/uxf/pipeline/transfer-mode-shims';
import { extractTokenIdFromSdkData } from '../tokens';

export async function sendInstantImpl(
  this: any,
  originalRequest: TransferRequest,
  options?: InstantSplitOptions
): Promise<InstantSplitResult> {
    this.ensureInitialized();

    // T.1.B.1 — narrow the optional-on-public-API `coinId` / `amount` to a
    // required-string `LegacyCoinTransferRequest`. NFT-only and
    // multi-asset shapes are accepted by the public type but not yet
    // routable on this entry point (awaits T.2.B). The narrow runs
    // BEFORE any state mutation. Mode narrowing is skipped here because
    // `sendInstant()` is itself a routing target of `'instant'` mode and
    // the public-mode → internal-mode shim has run upstream.
    let request: LegacyCoinTransferRequest = requireLegacyCoinSlot(originalRequest);

    const startTime = performance.now();

    let reservationId: string | undefined;
    let tokenToSplitRef: Token | undefined;

    try {
      // Resolve recipient
      const peerInfo: PeerInfo | null = await this.deps!.transport.resolve?.(request.recipient) ?? null;
      const recipientPubkey = this.resolveTransportPubkey(request.recipient, peerInfo);
      const recipientAddress = await this.resolveRecipientAddress(request.recipient, request.addressMode, peerInfo);

      // Create signing service
      const signingService = await this.createSigningService();

      // Get state transition client and trust base
      const stClient = this.deps!.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined;
      if (!stClient) {
        throw new SphereError('State transition client not available', 'AGGREGATOR_ERROR');
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const trustBase = (this.deps!.oracle as any).getTrustBase?.();
      if (!trustBase) {
        throw new SphereError('Trust base not available', 'AGGREGATOR_ERROR');
      }

      // ── Spend Queue: reserve tokens (same path as send()) ──
      reservationId = crypto.randomUUID();
      // Symbol → coinId resolution — delegate to shared helper.
      request = requireLegacyCoinSlot(this.resolveCoinIdSymbol(request));
      const parsedPool = await this.spendPlanner.buildParsedPool(
        Array.from(this.tokens.values()),
        request.coinId
      );

      let pendingChangeAmount2 = 0n;
      for (const [, t] of this.tokens) {
        if (t.coinId === request.coinId && t.status === 'transferring') {
          pendingChangeAmount2 += BigInt(t.amount || '0');
        }
      }
      const planResult = this.spendPlanner.planSend(
        request, parsedPool, this.reservationLedger, this.spendQueue, reservationId, pendingChangeAmount2
      );

      let splitPlan;
      if (planResult === 'queued') {
        const queueResult = await this.spendQueue.waitForEntry(reservationId);
        splitPlan = queueResult.splitPlan;
      } else {
        splitPlan = planResult.splitPlan;
      }

      if (!splitPlan) {
        throw new SphereError('Insufficient balance', 'SEND_INSUFFICIENT_BALANCE');
      }

      if (!splitPlan.requiresSplit || !splitPlan.tokenToSplit) {
        // W23 fix: For direct transfers without split, fall back to standard send()
        // but pass the existing reservation ID so send() can reuse it instead of
        // creating a new one. This closes the race window where freed tokens could
        // be grabbed by a concurrent queued entry between cancel and re-reserve.
        logger.debug('Payments', 'No split required, falling back to standard send()');
        try {
          const result = await this.send(request, { existingReservationId: reservationId, existingSplitPlan: splitPlan });
          return {
            success: result.status === 'completed',
            criticalPathDurationMs: performance.now() - startTime,
            error: result.error,
          };
        } finally {
          this.spendQueue.notifyChange(request.coinId);
        }
      }

      logger.debug('Payments', `InstantSplit: amount=${splitPlan.splitAmount}, remainder=${splitPlan.remainderAmount}`);

      // Mark token as transferring
      const tokenToSplit = splitPlan.tokenToSplit.uiToken;
      tokenToSplitRef = tokenToSplit;
      tokenToSplit.status = 'transferring';
      this.tokens.set(tokenToSplit.id, tokenToSplit);
      this.parsedTokenCache.delete(tokenToSplit.id);

      // Check if dev mode
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const devMode = options?.devMode ?? (this.deps!.oracle as any).isDevMode?.() ?? false;

      const onChainMessage: Uint8Array | null = null;

      // Create instant split executor
      const executor = new InstantSplitExecutor({
        stateTransitionClient: stClient,
        trustBase,
        signingService,
        devMode,
      });

      // Execute instant split
      const result = await executor.executeSplitInstant(
        splitPlan.tokenToSplit.sdkToken,
        splitPlan.splitAmount!,
        splitPlan.remainderAmount!,
        splitPlan.coinId,
        recipientAddress,
        this.deps!.transport,
        recipientPubkey,
        {
          ...options,
          memo: request.memo,
          message: onChainMessage,
          onChangeTokenCreated: async (changeToken) => {
            // Save change token when background completes
            const changeTokenData = changeToken.toJSON();
            const uiToken: Token = {
              id: crypto.randomUUID(),
              coinId: request.coinId,
              symbol: this.getCoinSymbol(request.coinId),
              name: this.getCoinName(request.coinId),
              decimals: this.getCoinDecimals(request.coinId),
              iconUrl: this.getCoinIconUrl(request.coinId),
              amount: splitPlan.remainderAmount!.toString(),
              status: 'confirmed',
              createdAt: Date.now(),
              updatedAt: Date.now(),
              sdkData: JSON.stringify(changeTokenData),
            };
            await this.addToken(uiToken);
            logger.debug('Payments', `Change token saved via background: ${uiToken.id}`);
          },
          onStorageSync: async () => {
            await this.save();
            return true;
          },
        }
      );

      if (result.success) {
        // Track background task for change token creation
        if (result.backgroundPromise) {
          this.pendingBackgroundTasks.push(result.backgroundPromise);
        }

        // Commit reservation AFTER transfer — removing token passes excludeReservationId
        // to prevent cancelForToken() from cancelling our own in-flight reservation.
        this.reservationLedger.commit(reservationId);

        // Remove the original token
        await this.removeToken(tokenToSplit.id, reservationId);

        // Add to transaction history (single entry for the actual sent amount)
        const recipientNametag = peerInfo?.nametag
          || (request.recipient.startsWith('@') ? request.recipient.slice(1) : undefined);
        const splitTokenId = extractTokenIdFromSdkData(tokenToSplit.sdkData);
        await this.addToHistory({
          type: 'SENT',
          amount: request.amount,
          coinId: request.coinId,
          symbol: this.getCoinSymbol(request.coinId),
          timestamp: Date.now(),
          recipientPubkey,
          recipientNametag,
          recipientAddress: peerInfo?.directAddress || recipientAddress?.toString() || recipientPubkey,
          memo: request.memo,
          tokenId: splitTokenId || undefined,
        });

        await this.save();
      } else {
        // Cancel reservation — free reserved amounts for other sends
        this.reservationLedger.cancel(reservationId);
        // Restore token on failure and re-add to cache
        tokenToSplit.status = 'confirmed';
        this.tokens.set(tokenToSplit.id, tokenToSplit);
        if (tokenToSplit.sdkData) {
          try {
            const parsed = JSON.parse(tokenToSplit.sdkData);
            const sdkToken = await SdkToken.fromJSON(parsed);
            const amount = this.extractCoinAmountForCache(sdkToken, tokenToSplit.coinId);
            if (amount > 0n) {
              this.parsedTokenCache.set(tokenToSplit.id, { token: tokenToSplit, sdkToken, amount });
            }
          } catch { /* parse failure — skip */ }
        }
        this.spendQueue.notifyChange(request.coinId);
      }

      return result;
    } catch (error) {
      // Cancel reservation on exception (only if one was created)
      if (reservationId) {
        this.reservationLedger.cancel(reservationId);
      }

      // Restore token from 'transferring' back to 'confirmed' if it was marked
      if (tokenToSplitRef && tokenToSplitRef.status === 'transferring') {
        tokenToSplitRef.status = 'confirmed';
        this.tokens.set(tokenToSplitRef.id, tokenToSplitRef);
        if (tokenToSplitRef.sdkData) {
          try {
            const parsed = JSON.parse(tokenToSplitRef.sdkData);
            const sdkToken = await SdkToken.fromJSON(parsed);
            const amount = this.extractCoinAmountForCache(sdkToken, tokenToSplitRef.coinId);
            if (amount > 0n) {
              this.parsedTokenCache.set(tokenToSplitRef.id, { token: tokenToSplitRef, sdkToken, amount });
            }
          } catch { /* parse failure — skip */ }
        }
      }

      // Notify queue after all restoration is complete
      if (reservationId) {
        this.spendQueue.notifyChange(request.coinId);
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        criticalPathDurationMs: performance.now() - startTime,
        error: errorMessage,
      };
    }
  }
