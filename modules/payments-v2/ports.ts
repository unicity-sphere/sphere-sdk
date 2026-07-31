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
  balances(): Promise<{ coinId: string; total: string; tokenCount: number }[]>;
  getBlobs(tokenIds: string[]): Promise<Map<string, Uint8Array>>;
  uploadBlobs(blobs: { sha256: string; bytes: Uint8Array }[]): Promise<Map<string, string>>;
  // The one authoritative spend write; runs after the deposit ATTEMPT (§5.5).
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
  ack(
    deliveryId: string,
    disposition: 'claimed' | 'rejected',
    reason?: 'invalid' | 'not-owned' | 'storage-rejected' | 'other'
  ): Promise<void>;
  onWake?(cb: () => void): () => void;
}
