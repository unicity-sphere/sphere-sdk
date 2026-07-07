/**
 * @internal Phase 5 [C] quarantine — Phase 6.C deletes this file wholesale.
 *
 * V6 combined-transfer bundle path — v1-STSDK receiver aggregation for
 * split+direct token bundles delivered via a single Nostr event.
 */

import type { Token } from '../../../types';
import type { CombinedTransferBundleV6 } from '../../../types/instant-split';
import { logger } from '../../../core/logger';
import { STORAGE_KEYS_ADDRESS } from '../../../constants';
import { TransferCommitment } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferCommitment';
import type { StateTransitionClient } from '@unicitylabs/state-transition-sdk/lib/StateTransitionClient';

export async function processCombinedTransferBundleImpl(
  this: any,
  bundle: CombinedTransferBundleV6,
  senderPubkey: string,
): Promise<void> {
    this.ensureInitialized();

    // Ensure load() has completed so dedup checks see all persisted tokens
    if (!this.loaded && this.loadedPromise) {
      await this.loadedPromise;
    }

    // Dedup by transferId
    if (this.processedCombinedTransferIds.has(bundle.transferId)) {
      logger.debug('Payments', `V6 combined transfer ${bundle.transferId.slice(0, 12)}... already processed, skipping`);
      return;
    }

    logger.debug(
      'Payments',
      `Processing V6 combined transfer ${bundle.transferId.slice(0, 12)}... ` +
      `(split=${!!bundle.splitBundle}, direct=${bundle.directTokens.length})`
    );

    const allTokens: Token[] = [];
    const tokenBreakdown: Array<{ id: string; amount: string; source: 'split' | 'direct' }> = [];

    // Pre-parse direct token commitment data once (reused for saving + aggregator submit)
    const parsedDirectEntries = bundle.directTokens.map((entry: any) => ({
      sourceToken: typeof entry.sourceToken === 'string' ? JSON.parse(entry.sourceToken) : entry.sourceToken,
      commitment: typeof entry.commitmentData === 'string' ? JSON.parse(entry.commitmentData) : entry.commitmentData,
    }));

    // 1. Process split bundle (if present) — deferred persistence
    if (bundle.splitBundle) {
      const splitToken = await this.saveUnconfirmedV5Token(bundle.splitBundle, senderPubkey, true);
      if (splitToken) {
        allTokens.push(splitToken);
        tokenBreakdown.push({ id: splitToken.id, amount: splitToken.amount, source: 'split' });
      } else {
        logger.warn('Payments', `V6: split token was deduped/failed — amount=${bundle.splitBundle.amount}`);
      }
    }

    // 2. Process direct tokens in parallel — deferred persistence
    const directResults = await Promise.all(
      parsedDirectEntries.map(({ sourceToken, commitment }: any) =>
        this.saveCommitmentOnlyToken(sourceToken, commitment, senderPubkey, true, true)
      )
    );
    for (let i = 0; i < directResults.length; i++) {
      const token = directResults[i];
      if (token) {
        allTokens.push(token);
        tokenBreakdown.push({ id: token.id, amount: token.amount, source: 'direct' });
      } else {
        const entry = bundle.directTokens[i];
        logger.warn(
          'Payments',
          `V6: direct token #${i} dropped (amount=${entry.amount}, ` +
          `tokenId=${entry.tokenId?.slice(0, 12) ?? 'N/A'})`
        );
      }
    }

    if (allTokens.length === 0) {
      logger.debug('Payments', 'V6 combined transfer: all tokens deduped, nothing to save');
      return;
    }

    // 3. Batched persistence + sender info resolution in parallel
    this.processedCombinedTransferIds.add(bundle.transferId);
    const [senderInfo] = await Promise.all([
      this.resolveSenderInfo(senderPubkey),
      this.save(),
      this.saveProcessedCombinedTransferIds(),
      ...(bundle.splitBundle ? [this.saveProcessedSplitGroupIds()] : []),
    ]);

    // 4. Submit direct token commitments to aggregator (fire-and-forget, reuse parsed data)
    const stClient = this.deps!.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined;
    if (stClient) {
      for (const { commitment } of parsedDirectEntries) {
        TransferCommitment.fromJSON(commitment).then((c: any) =>
          stClient.submitTransferCommitment(c)
        ).catch((err: unknown) =>
          logger.error('Payments', 'V6 background commitment submit failed:', err)
        );
      }
    }

    // 5. Emit event + history

    this.deps!.emitEvent('transfer:incoming', {
      id: bundle.transferId,
      senderPubkey,
      senderNametag: senderInfo.senderNametag,
      tokens: allTokens,
      memo: bundle.memo,
      receivedAt: Date.now(),
    });

    // Compute actual received amount from saved tokens (not bundle.totalAmount which is sender's request)
    const actualAmount = allTokens.reduce((sum, t) => sum + BigInt(t.amount || '0'), 0n).toString();

    await this.addToHistory({
      type: 'RECEIVED',
      amount: actualAmount,
      coinId: bundle.coinId,
      symbol: allTokens[0]?.symbol || bundle.coinId,
      timestamp: Date.now(),
      senderPubkey,
      ...senderInfo,
      memo: bundle.memo,
      transferId: bundle.transferId,
      tokenId: allTokens[0]?.id,
      tokenIds: tokenBreakdown,
    });

    // 6. Fire-and-forget: try to resolve V5 tokens immediately
    if (bundle.splitBundle) {
      this.resolveUnconfirmed().catch((err: unknown) => logger.debug('Payments', 'resolveUnconfirmed failed', err));
      this.scheduleResolveUnconfirmed();
    }
  }

/**
 * Persist processed combined transfer IDs to KV storage.
 */
export async function saveProcessedCombinedTransferIdsImpl(this: any): Promise<void> {
    const ids = Array.from(this.processedCombinedTransferIds);
    if (ids.length > 0) {
      // Dedup ledger — pure operational state, not a user action.
      await this.setStorageEntry(
        STORAGE_KEYS_ADDRESS.PROCESSED_COMBINED_TRANSFER_IDS,
        JSON.stringify(ids),
        'cache_index',
      );
    }
  }

/**
 * Load processed combined transfer IDs from KV storage.
 */
export async function loadProcessedCombinedTransferIdsImpl(this: any): Promise<void> {
    const data = await this.deps!.storage.get(STORAGE_KEYS_ADDRESS.PROCESSED_COMBINED_TRANSFER_IDS);
    if (!data) return;
    try {
      const ids = JSON.parse(data) as string[];
      for (const id of ids) {
        this.processedCombinedTransferIds.add(id);
      }
    } catch {
      // Ignore corrupt data
    }
  }
