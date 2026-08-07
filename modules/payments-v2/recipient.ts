// §5.6 recipient gate: the cross-network deposit trap — a deposit keys the
// recipient under the SENDER's network and the server 200s an entry the
// recipient never queries. TRANSITION (#734) — docs/PAYMENTS-V2-DESIGN.md §5.6.

import { SphereError } from '../../core/errors';

import type { RecipientInfo } from './compose';

export const ATTENTION_RECIPIENT_NETWORK_UNVERIFIED = 'recipient:network-unverified';

export interface RecipientGateDeps {
  resolveRecipient: (identifier: string) => Promise<RecipientInfo | null>;
  network: string;
  emit: (event: string, payload: unknown) => void;
}

export async function requireSameNetworkRecipient(
  deps: RecipientGateDeps,
  identifier: string
): Promise<RecipientInfo> {
  const recipient = await deps.resolveRecipient(identifier);
  if (recipient === null || recipient.chainPubkey === '') {
    throw new SphereError(`Recipient ${identifier} has no published chain pubkey`, 'INVALID_RECIPIENT');
  }
  if (recipient.network === null) {
    deps.emit('transfer:attention', {
      transferId: '', // the gate precedes plan allocation — no transferId exists yet
      code: ATTENTION_RECIPIENT_NETWORK_UNVERIFIED,
      detail: `could not verify the network of recipient ${identifier} — assuming this session's "${deps.network}"`,
    });
    return recipient;
  }
  // #734 owes this compare a canonical name (`testnet` aliases `testnet2`) — §5.6.
  if (recipient.network !== deps.network) {
    throw new SphereError(
      `Recipient ${identifier} is on network "${recipient.network}" but this session is on "${deps.network}" — a cross-network deposit is unrecoverable`,
      'INVALID_RECIPIENT'
    );
  }
  return recipient;
}
