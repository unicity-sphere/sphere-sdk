// The plan → intent-payload codec (§5.5): what a send attempt PUTs as its
// durable server intent. Extracted from PaymentsFacade (pure, no state).

import type { SendRequest } from '../api';
import type { PlannedSpend } from '../select/queue';
import type { CoinIntentPayload, WholeIntentPayload } from './types';

export function buildPayload(
  recipientPubkey: string,
  request: SendRequest,
  spend: PlannedSpend,
  spentStates: Record<string, { local: string; protocol: string }>
): CoinIntentPayload {
  return {
    v: 2,
    kind: 'coin',
    recipient: recipientPubkey,
    coinId: request.coinId,
    amount: request.amount,
    ...(request.memo !== undefined ? { memo: request.memo } : {}),
    direct: [...spend.plan.direct],
    ...(spend.plan.split !== undefined
      ? {
          split: {
            tokenId: spend.plan.split.tokenId,
            splitAmount: spend.plan.split.splitAmount.toString(),
            remainderAmount: spend.plan.split.remainderAmount.toString(),
          },
        }
      : {}),
    spentStates,
  };
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A token-addressed spend (#777). Takes no PlannedSpend because nothing was
 * selected: the source is named, so there is no amount, no split and no change.
 */
export function buildWholePayload(
  recipientPubkey: string,
  request: { tokenId: string; memo?: string },
  spentStates: Record<string, { local: string; protocol: string }>
): WholeIntentPayload {
  return {
    v: 2,
    kind: 'whole',
    recipient: recipientPubkey,
    ...(request.memo !== undefined ? { memo: request.memo } : {}),
    direct: [request.tokenId],
    spentStates,
  };
}
