/**
 * wallet-api/intent-signing.ts — the E.4/#87 seed-holder message formats (sphere-sdk#501).
 *
 * These EXACT strings are the cross-repo contract: the client signs them with the wallet chain
 * key, and the wallet-api backend recovers the pubkey and verifies it (ARCHITECTURE §16). A drift
 * between the two repos wedges checkpointing (loudly, pre-mint) — so both sides pin the same
 * literal vectors (sphere-sdk here + `tests/integration/intents.test.ts` M2.11/M2.12 in wallet-api).
 */

import { sha256 } from '../core/crypto';

/** The §16 progress-append message: signed over the EXACT stored-envelope bytes (E.4). */
export function progressSignMessage(transferId: string, opIndex: number, payloadEnvelope: string): string {
  return `wallet-api.progress.v1:${transferId}:${opIndex}:${sha256(payloadEnvelope, 'utf8')}`;
}

/** The §16/#87 terminal-close message for a checkpoint-bearing intent. */
export function completeSignMessage(transferId: string): string {
  return `wallet-api.complete.v1:${transferId}`;
}
