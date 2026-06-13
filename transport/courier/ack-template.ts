/**
 * Courier ack canonical template (DESIGN §6.4 / §8.2).
 *
 *   ackSig = signMessage(recipientPriv,
 *     'unicity:courier:ack:v1\n' + network + '\n' + senderPubkey + '\n' + entryId + '\n' + serverNonce)
 *
 * The signature is the fund-critical attestation: bound to `(network, sender,
 * entryId, serverNonce)` so it is NOT replayable across senders, deposits, or
 * deployments. Both the SDK (signs) and token-api (verifies) build this EXACT
 * literal.
 *
 * The literal is now DEFINED ONCE in `vault/contracts.ts`; this file re-exports it
 * so existing call sites keep their import path.
 */

export { COURIER_ACK_PREFIX, courierAckTemplate } from '../../vault/contracts';
