import { DIRECT_RECIPIENT_REFUSED_MESSAGE, isDirectAddressRecipient } from '../../modules/payments-v2/recipient';
import { INTENT_ACTIONS } from '../protocol';

/** #847: the intents whose `to` names a payment recipient. `dm` is not one. */
const PAYMENT_RECIPIENT_INTENTS: ReadonlySet<string> = new Set<string>([
  INTENT_ACTIONS.SEND,
  INTENT_ACTIONS.PAYMENT_REQUEST,
  INTENT_ACTIONS.SEND_NFT,
]);

/** The refusal message for a `DIRECT://` payment recipient, or null when the intent may proceed. */
export function directRecipientRefusal(action: string, params: unknown): string | null {
  if (!PAYMENT_RECIPIENT_INTENTS.has(action)) return null;
  const to = typeof params === 'object' && params !== null ? (params as { to?: unknown }).to : undefined;
  return isDirectAddressRecipient(to) ? DIRECT_RECIPIENT_REFUSED_MESSAGE : null;
}
