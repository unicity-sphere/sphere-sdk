// S2/S7 interfaces (amended 2026-07-31). Blob bytes = RAW v2 Token.toCBOR().

export interface InventoryAsset {
  coinId: string;
  amount: string;
}

export interface InventoryItem {
  tokenId: string;
  status: 'active' | 'removed';
  seq: number;
  stateHash: string;
  assets?: InventoryAsset[];
}

export interface InventoryPage {
  cursor: number;
  syncEpoch: string;
  more: boolean;
  items: InventoryItem[];
}

export interface ApplyDeltaResult {
  cursor: number;
  syncEpoch: string;
}

export interface StoragePort {
  listInventory(since?: number): Promise<InventoryPage>;
  getBlobs(tokenIds: string[]): Promise<Map<string, Uint8Array>>;
  uploadBlobs(blobs: { sha256: string; bytes: Uint8Array }[]): Promise<Map<string, string>>;
  // The one authoritative spend write, after the deposit ATTEMPT (§5.5). Rejects DeltaConflictError('DELTA_CONFLICT',409) / DeltaValidationError('DELTA_VALIDATION',422) — impl/wallet-api-v2/storage.ts; match on `code`.
  applyDelta(delta: {
    transferId: string;
    spent: string[];
    added: { tokenId: string; key: string }[];
  }): Promise<ApplyDeltaResult>;
}

export interface DeliveryReceipt {
  // hex(SHA-256(tokenId ‖ stateHash)) — content-derived, never a row id/seq.
  deliveryId: string;
}

export interface IncomingDelivery {
  deliveryId: string;
  transferId?: string;
  senderPubkey?: string;
  senderNametag?: string;
  memo?: string;
  fetchBlob(): Promise<Uint8Array>;
  cursor: string;
}

export interface DeliverOptions {
  transferId: string;
  memo?: string;
  senderNametag?: string;
}

export interface DeliveryPort {
  bindDeliveryKeys(
    derive: (blob: Uint8Array) => Promise<{ tokenId: string; stateHash: string }>
  ): void;
  // Idempotent per (token, state), bytes MAY differ — absorb the key-variant 409.
  deliver(
    recipientPubkey: string,
    blob: Uint8Array,
    options: DeliverOptions
  ): Promise<DeliveryReceipt>;
  deliverBatch?(
    recipientPubkey: string,
    blobs: Uint8Array[],
    options: DeliverOptions
  ): Promise<DeliveryReceipt[]>;
  // At-least-once; the impl owns the persistent seen-set (S7).
  incoming(sinceCursor?: string): AsyncIterable<IncomingDelivery>;
  /**
   * The syncEpoch of the most recent incoming() page — updated per page, null
   * before the first. §5.7 restore self-detection: the mailbox page is the
   * honest epoch source, so Receive voids its (cursor, epoch) continuity on a
   * mismatch even when the wake socket missed a server restore. (Pinned by the
   * S7 contract suite; wallet-api#119's S7 text carries the same sentence.)
   */
  incomingEpoch(): string | null;
  ack(
    deliveryId: string,
    disposition: 'claimed' | 'rejected',
    reason?: 'invalid' | 'not-owned' | 'storage-rejected' | 'other'
  ): Promise<void>;
  /** Settle many acks at once (#757). Contract pinned by the delivery-port contract suite. */
  ackBatch?(acks: readonly AckRequest[]): Promise<readonly AckOutcome[]>;
  onWake?(cb: () => void): () => void;
}

export interface AckRequest {
  readonly deliveryId: string;
  readonly disposition: 'claimed' | 'rejected';
  readonly reason?: 'invalid' | 'not-owned' | 'storage-rejected' | 'other';
}

export type AckOutcome =
  | { readonly deliveryId: string; readonly status: 'settled' }
  | { readonly deliveryId: string; readonly status: 'conflict' };

/** ackBatch failed in a way a per-entry retry would hit too — do not fall back. */
export interface RetryableAckError extends Error {
  readonly retryable: true;
}

export function isRetryableAckError(err: unknown): err is RetryableAckError {
  return err !== null && typeof err === 'object' && (err as { retryable?: unknown }).retryable === true;
}
