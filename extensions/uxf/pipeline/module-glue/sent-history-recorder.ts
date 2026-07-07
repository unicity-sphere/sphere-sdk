/**
 * SENT history recorder — Phase 5 [B] extraction from PaymentsModule.ts.
 *
 * Emits one SENT-typed `TransactionHistoryEntry` per coin involved in
 * a UXF bundle (#149 multi-coin follow-up). Extension-bound because
 * the per-coin fan-out here is a UXF-pipeline concern — the legacy
 * v1 dispatcher wrote a single primary-coin entry.
 *
 * See uxfv2-phase-5-payments-disposition.md §"UXF dispatch" for the
 * disposition entry. Note the ambiguity in the ledger §3:
 * `recordUxfBundleSentHistory` is currently [B] but if Phase 7 wants
 * per-coin history entries to become canonical across senders, the
 * disposition may drift to [A]. Kept [B] for now — the entry shape is
 * unchanged, only the emission cadence differs from the v1 path.
 */

import type { TransferRequest, TransferResult } from '../../../../types';
import type { PeerInfo } from '../../../../transport';
import { logger } from '../../../../core/logger';
import type { LegacyCoinTransferRequest } from '../transfer-mode-shims';
import type { TransactionHistoryEntry } from '../../../../modules/payments/read-model/history';

/**
 * Host shim exposing the two facade methods the recorder calls:
 *   - `addToHistory` — the read-model history writer (survives on
 *     the facade per the ledger);
 *   - `getCoinSymbol` — token-metadata lookup helper (survives on
 *     the facade → `modules/payments/tokens/coin-metadata.ts`).
 */
export interface SentHistoryRecorderHost {
  addToHistory(entry: Omit<TransactionHistoryEntry, 'id' | 'dedupKey'>): Promise<void>;
  getCoinSymbol(coinId: string): string;
}

/** Argument bundle for {@link recordUxfBundleSentHistory}. */
export interface RecordUxfBundleSentHistoryArgs {
  originalRequest: TransferRequest;
  request: LegacyCoinTransferRequest;
  result: TransferResult;
  peerInfo: PeerInfo | null;
  recipientPubkey: string;
  recipientAddress: { toString(): string };
  diagLabel: string;
}

/**
 * Record SENT history entries for a UXF bundle, one per coin involved.
 *
 * #149 multi-coin follow-up: pre-fix, the UXF dispatchers wrote a single
 * SENT history entry tagged with the primary coin only — any additional
 * coins shipped in the same bundle silently disappeared from history.
 * This helper emits one entry per coin (primary + each additionalAssets
 * coin), each tagged with that coin's id/symbol/amount and the
 * per-coin tokenIds breakdown.
 *
 * `result.tokens` carries the consumed source tokens (with their
 * pre-burn `coinId`); `result.tokenTransfers` enumerates per-source
 * commits (`split` or `direct`). We pivot tokenTransfers by source
 * coinId to populate each entry's `tokenIds` array.
 *
 * NFT additional assets are intentionally skipped — they're whole-token
 * transfers (no fungible amount) and need separate history schema work;
 * tracked as a follow-up.
 *
 * Failure handling: storage I/O hiccup must not turn a successful send
 * into a thrown error. Each entry is wrapped in its own try/catch so
 * one bad write can't drop the rest.
 */
export async function recordUxfBundleSentHistory(
  host: SentHistoryRecorderHost,
  args: RecordUxfBundleSentHistoryArgs,
): Promise<void> {
  const {
    originalRequest,
    request,
    result,
    peerInfo,
    recipientPubkey,
    recipientAddress,
    diagLabel,
  } = args;

  const recipientNametag =
    peerInfo?.nametag ??
    (originalRequest.recipient.startsWith('@')
      ? originalRequest.recipient.slice(1)
      : undefined);

  // Pivot tokenTransfers by source coinId. result.tokens carries the
  // consumed source tokens (post-removal from in-memory map, but still
  // present on the result). For each source, look up its pre-burn
  // coinId and amount.
  const tokenMap = new Map(result.tokens.map((t) => [t.id, t]));
  const perCoinTokenIds = new Map<
    string,
    Array<{ id: string; amount: string; source: 'split' | 'direct' }>
  >();
  for (const tt of result.tokenTransfers) {
    const tok = tokenMap.get(tt.sourceTokenId);
    if (!tok) continue;
    const list = perCoinTokenIds.get(tok.coinId) ?? [];
    list.push({
      id: tt.sourceTokenId,
      amount: tok.amount,
      source: tt.method === 'split' ? 'split' : 'direct',
    });
    perCoinTokenIds.set(tok.coinId, list);
  }

  // Build the per-coin summary list. Primary slot first; then each
  // additionalAssets coin entry preserving caller order. NFT
  // additionals are excluded (whole-token, no amount slot).
  type CoinSummary = { coinId: string; amount: string };
  const summaries: CoinSummary[] = [
    { coinId: request.coinId, amount: request.amount },
  ];
  for (const asset of originalRequest.additionalAssets ?? []) {
    if (asset.kind !== 'coin') continue;
    summaries.push({ coinId: asset.coinId, amount: asset.amount });
  }

  const recipientAddressStr =
    peerInfo?.directAddress ?? recipientAddress.toString() ?? recipientPubkey;

  const baseTimestamp = Date.now();
  for (const summary of summaries) {
    const tokenIds = perCoinTokenIds.get(summary.coinId) ?? [];
    const firstTokenId = tokenIds[0]?.id;
    try {
      await host.addToHistory({
        type: 'SENT',
        amount: summary.amount,
        coinId: summary.coinId,
        symbol: host.getCoinSymbol(summary.coinId),
        timestamp: baseTimestamp,
        recipientPubkey,
        ...(recipientNametag !== undefined ? { recipientNametag } : {}),
        recipientAddress: recipientAddressStr,
        ...(request.memo !== undefined ? { memo: request.memo } : {}),
        transferId: result.id,
        ...(firstTokenId !== undefined ? { tokenId: firstTokenId } : {}),
        ...(tokenIds.length > 0 ? { tokenIds } : {}),
      });
    } catch (err) {
      logger.warn(
        'Payments',
        `${diagLabel}: failed to record SENT history for coin=${summary.coinId.slice(
          0,
          16,
        )} (send already succeeded): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
