/**
 * Courier ack canonical template (DESIGN §6.4 / §8.2).
 *
 *   ackSig = signMessage(recipientPriv,
 *     'unicity:courier:ack:v1\n' + network + '\n' + senderPubkey + '\n' + entryId + '\n' + serverNonce)
 *
 * The signature is the fund-critical attestation: bound to `(network, sender,
 * entryId, serverNonce)` so it is NOT replayable across senders, deposits, or
 * deployments. Both the SDK (signs) and token-api (verifies) build this EXACT
 * literal — pinned by the integration tests so a divergence is caught.
 */

/** Canonical prefix for the courier ack attestation. */
export const COURIER_ACK_PREFIX = 'unicity:courier:ack:v1';

/** Build the exact ack message bound to `(network, senderPubkey, entryId, serverNonce)`. */
export function courierAckTemplate(
  network: string,
  senderPubkey: string,
  entryId: string,
  serverNonce: string,
): string {
  return `${COURIER_ACK_PREFIX}\n${network}\n${senderPubkey}\n${entryId}\n${serverNonce}`;
}
