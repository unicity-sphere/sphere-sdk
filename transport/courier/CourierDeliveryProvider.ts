/**
 * CourierDeliveryProvider — the reference token-delivery transport over the
 * Token-Vault v2 courier endpoints (§3, §6).
 *
 * Seals each transfer into a courier envelope (ECDH-derived key, AAD-bound
 * entryId) and exchanges it via deposit / receive / ack / sent. The real
 * bodies land in Phase 5; this is the typed skeleton from Task 0.1.
 */

import type { FullIdentity } from '../../types';

export interface CourierDeliveryConfig {
  /** Vault/courier base URL — `NETWORKS[network].vaultUrl`. */
  vaultUrl: string;
  /** Canonical network name. */
  network: string;
}

/** A sealed transfer ready to hand to the courier `deposit` endpoint. */
export interface CourierEnvelope {
  recipientPubkey: string;
  entryId: string;
  transferId: string;
  /** base64(nonce24‖ct) packed string. */
  ciphertext: string;
  /** Single base64 scalar hint string (NOT a {nonce,ct} object). */
  hint?: string;
}

/** Result of a courier deposit. */
export interface CourierDepositResult {
  entryId: string;
}

/** A received courier delivery, pre-decrypt. */
export interface CourierDelivery {
  entryId: string;
  senderPubkey: string;
  transferId: string;
  ciphertext: string;
  hint?: string;
}

export class CourierDeliveryProvider {
  readonly id = 'courier-delivery';
  readonly name = 'Courier Delivery (Vault v2)';
  readonly type = 'network' as const;

  constructor(_config: CourierDeliveryConfig) {
    // Phase 5
  }

  setIdentity(_identity: FullIdentity): void {
    throw new Error('not implemented');
  }

  /** Seal + POST a transfer to `/v1/courier/deposit`. */
  deposit(_envelope: CourierEnvelope): Promise<CourierDepositResult> {
    throw new Error('not implemented');
  }

  /** Pull-since read of pending deliveries; feeds `handleV2Transfer`. */
  receive(): Promise<void> {
    throw new Error('not implemented');
  }

  /** Signed durable-copy ack for a claimed entry. */
  confirmReceipt(_entryId: string): Promise<void> {
    throw new Error('not implemented');
  }

  /** Sender-side poll of `/v1/courier/sent` to gate delivery confirmation. */
  pollSent(): Promise<void> {
    throw new Error('not implemented');
  }
}
