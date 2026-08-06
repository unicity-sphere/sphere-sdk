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
  // The one authoritative spend write; runs after the deposit ATTEMPT (§5.5).
  // Rejects with DeltaConflictError (code 'DELTA_CONFLICT', lineage 409) or
  // DeltaValidationError (code 'DELTA_VALIDATION', 422) — defined by the impl
  // (impl/wallet-api-v2/storage.ts); consumers match on `code`, never instanceof.
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
  onWake?(cb: () => void): () => void;
}
