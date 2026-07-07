/**
 * @internal Phase 5 [C] quarantine — Phase 6.C deletes this file wholesale.
 *
 * V4/V5 instant-split bundle processing (receiver-side).
 */

import type { Token } from '../../../types';
import type {
  InstantSplitBundle,
  InstantSplitProcessResult,
} from '../../../types/instant-split';
import { logger } from '../../../core/logger';
import { SphereError } from '../../../core/errors';
import { isInstantSplitBundle as isInstantSplitBundleImpl_, isInstantSplitBundleV5 } from '../../../types/instant-split';
import { InstantSplitProcessor } from '../InstantSplitProcessor';
import { Token as SdkToken } from '@unicitylabs/state-transition-sdk/lib/token/Token';
import type { StateTransitionClient } from '@unicitylabs/state-transition-sdk/lib/StateTransitionClient';
import { extractTokenIdFromSdkData } from '../tokens';

/**
 * Process a received INSTANT_SPLIT bundle.
 */
export async function processInstantSplitBundleImpl(
  this: any,
  bundle: InstantSplitBundle,
  senderPubkey: string,
  memo?: string,
): Promise<InstantSplitProcessResult> {
    this.ensureInitialized();

    // Ensure load() has completed so the dedup check below sees all
    // persisted tokens.  Transport may deliver events before load finishes.
    if (!this.loaded && this.loadedPromise) {
      await this.loadedPromise;
    }

    if (!isInstantSplitBundleV5(bundle)) {
      // V4 (dev mode) still processes synchronously
      return this.processInstantSplitBundleSync(bundle, senderPubkey, memo);
    }

    // V5: save immediately as unconfirmed, resolve proofs lazily
    try {
      const uiToken = await this.saveUnconfirmedV5Token(bundle, senderPubkey);
      if (!uiToken) {
        return { success: true, durationMs: 0 };
      }

      // Record in history (once per token — resolveV5Token will NOT add another)
      const senderInfo = await this.resolveSenderInfo(senderPubkey);
      await this.addToHistory({
        type: 'RECEIVED',
        amount: bundle.amount,
        coinId: bundle.coinId,
        symbol: uiToken.symbol,
        timestamp: Date.now(),
        senderPubkey,
        ...senderInfo,
        memo,
        tokenId: uiToken.id,
      });

      // Emit incoming transfer event
      this.deps!.emitEvent('transfer:incoming', {
        id: bundle.splitGroupId,
        senderPubkey,
        senderNametag: senderInfo.senderNametag,
        tokens: [uiToken],
        memo,
        receivedAt: Date.now(),
      });

      await this.save();

      // Fire-and-forget: try to resolve immediately, then start periodic retry
      this.resolveUnconfirmed().catch((err: unknown) => logger.debug('Payments', 'resolveUnconfirmed failed', err));
      this.scheduleResolveUnconfirmed();

      return { success: true, durationMs: 0 };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: errorMessage,
        durationMs: 0,
      };
    }
  }

/**
 * Synchronous V4 bundle processing (dev mode only).
 */
export async function processInstantSplitBundleSyncImpl(
  this: any,
  bundle: InstantSplitBundle,
  senderPubkey: string,
  memo?: string,
): Promise<InstantSplitProcessResult> {
    try {
      const signingService = await this.createSigningService();

      const stClient = this.deps!.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined;
      if (!stClient) {
        throw new SphereError('State transition client not available', 'AGGREGATOR_ERROR');
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const trustBase = (this.deps!.oracle as any).getTrustBase?.();
      if (!trustBase) {
        throw new SphereError('Trust base not available', 'AGGREGATOR_ERROR');
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const devMode = (this.deps!.oracle as any).isDevMode?.() ?? false;

      const processor = new InstantSplitProcessor({
        stateTransitionClient: stClient,
        trustBase,
        devMode,
      });

      const result = await processor.processReceivedBundle(
        bundle,
        signingService,
        senderPubkey,
        {
          findNametagToken: async (proxyAddress: string) => {
            const currentNametag = this.getNametag();
            if (currentNametag?.token) {
              try {
                const nametagToken = await SdkToken.fromJSON(currentNametag.token);
                const { ProxyAddress } = await import('@unicitylabs/state-transition-sdk/lib/address/ProxyAddress');
                const proxy = await ProxyAddress.fromTokenId(nametagToken.id);
                if (proxy.address === proxyAddress) {
                  return nametagToken;
                }
                logger.debug('Payments', `Unicity ID PROXY address mismatch: ${proxy.address} !== ${proxyAddress}`);
                return null;
              } catch (err) {
                logger.debug('Payments', 'Failed to parse nametag token:', err);
                return null;
              }
            }
            return null;
          },
        }
      );

      if (result.success && result.token) {
        const tokenData = result.token.toJSON();
        const info = await this.__parseTokenInfo(tokenData);

        const uiToken: Token = {
          id: crypto.randomUUID(),
          coinId: info.coinId,
          symbol: info.symbol,
          name: info.name,
          decimals: info.decimals,
          iconUrl: info.iconUrl,
          amount: bundle.amount,
          status: 'confirmed',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          sdkData: JSON.stringify(tokenData),
        };

        await this.addToken(uiToken);

        const receivedTokenId = extractTokenIdFromSdkData(uiToken.sdkData);
        const senderInfo = await this.resolveSenderInfo(senderPubkey);
        await this.addToHistory({
          type: 'RECEIVED',
          amount: bundle.amount,
          coinId: info.coinId,
          symbol: info.symbol,
          timestamp: Date.now(),
          senderPubkey,
          ...senderInfo,
          memo,
          tokenId: receivedTokenId || uiToken.id,
        });

        await this.save();

        this.deps!.emitEvent('transfer:incoming', {
          id: bundle.splitGroupId,
          senderPubkey,
          senderNametag: senderInfo.senderNametag,
          tokens: [uiToken],
          memo,
          receivedAt: Date.now(),
        });
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: errorMessage,
        durationMs: 0,
      };
    }
  }

/**
 * Type-guard: check whether a payload is a valid {@link InstantSplitBundle} (V4 or V5).
 */
export function isInstantSplitBundleImpl(this: any, payload: unknown): payload is InstantSplitBundle {
    return isInstantSplitBundleImpl_(payload);
  }
