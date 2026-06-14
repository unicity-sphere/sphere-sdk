/**
 * Universal delivery layer types (DESIGN §3) + the courier wire seam.
 *
 * `TokenEnvelope` is the universal unit — the finished v2 token blob (already
 * locked to the recipient) plus its addressing metadata and the AEAD envelope.
 * `TokenDeliveryTransport` is the narrow post-certification byte-push port: it
 * carries `journal → deliver → unjournal` and NOTHING else (no resolution — that
 * stays a separate Nostr step `send()` calls first).
 *
 * `CourierHttpClient` is the swap seam: the provider talks to the courier through
 * this typed interface, never raw `fetch`. The in-process fake server (Phase 5
 * tests) and the real token-api HTTP client (Phase 8.3) both implement it, so the
 * provider's logic is exercised identically against the fake and the real server.
 */

// =============================================================================
// Universal delivery unit (DESIGN §3)
// =============================================================================

/**
 * The universal delivery unit: a finished v2 token blob (already locked to the
 * recipient) + addressing metadata + the sealed AEAD envelope. "The file."
 */
export interface TokenEnvelope {
  /** Recipient compressed chain pubkey (66-hex) — the courier address. */
  recipientChainPubkey: string;
  /** Sender compressed chain pubkey (66-hex). */
  senderChainPubkey: string;
  /** Transfer id grouping one (possibly multi-output) payment. */
  transferId: string;
  /** Hex of CBOR(TokenBlob) — the finished v2 token (the V2_TRANSFER payload). */
  tokenBlobHex: string;
  /** Optional opaque memo, sealed inside the envelope. */
  memo?: string;
}

/** Transport-opaque handle returned by a deposit; identifies the delivery. */
export interface DeliveryHandle {
  entryId: string;
  transferId: string;
  recipientChainPubkey: string;
  /** Server-assigned monotonic sender watermark, used to poll `/sent`. */
  sentSeq?: number;
}

/** A verified signed receipt — the recipient's ack over the bound template. */
export interface SignedReceipt {
  entryId: string;
  ackSig: string;
  recipientChainPubkey: string;
}

/** Capabilities advertised by a {@link TokenDeliveryTransport}. */
export interface TokenDeliveryCapabilities {
  /** Delivery is async (store-and-forward), not a live handshake. */
  async: boolean;
  /** The channel returns a verifiable claim receipt. */
  ack: boolean;
  /** How the channel is addressed. */
  addressing: 'pubkey' | 'outOfBand';
  /** Max envelope bytes the channel accepts, if bounded. */
  maxBytes?: number;
}

/**
 * Narrow post-certification byte-push port (DESIGN §3). It addresses by
 * `recipientChainPubkey`; it does NOT resolve nametags and is NOT the fat Nostr
 * `TransportProvider`.
 */
export interface TokenDeliveryTransport {
  readonly capabilities: TokenDeliveryCapabilities;
  /** Seal + push an envelope; addresses by `recipientChainPubkey`. */
  deposit(envelope: TokenEnvelope): Promise<DeliveryHandle>;
  /** Pull pending envelopes (store-and-forward channels). */
  receive?(): Promise<void>;
  /** Verify + return the signed receipt for a delivery, if claimed. */
  confirmReceipt?(handle: DeliveryHandle): Promise<SignedReceipt | null>;
  /**
   * Bind the consumer's sinks AFTER construction (the SDK factory leaves them as
   * no-ops). `onV2Transfer` feeds each decoded incoming transfer into the consumer's
   * existing receive path; `onDelivered(entryId)` fires ONLY on a verified delivery
   * receipt — it is what licenses the consumer to GC its pending-delivery journal.
   */
  setSinks?(sinks: {
    onV2Transfer?: (payload: import('../../types/v2-transfer').V2TransferPayload, senderPubkey: string) => Promise<void>;
    onDelivered?: (entryId: string) => Promise<void>;
  }): void;
  /** Poll for sender-side delivery confirmations (fires `onDelivered` on a valid ack). */
  pollSent?(): Promise<void>;
  /** Re-fire any journaled, unacked received deliveries (crash recovery). */
  replayAckPending?(): Promise<void>;
}

// =============================================================================
// Courier wire seam (mirrors token-api `/v1/courier/*` — DESIGN §6)
// =============================================================================

/** `POST /v1/courier/deposit` request body (DESIGN §6.3). `hint` is a base64 SCALAR. */
export interface CourierDepositRequest {
  recipientPubkey: string;
  entryId: string;
  transferId: string;
  /** base64(nonce24‖ct) packed string. */
  ciphertext: string;
  /** Single base64 scalar hint string (NEVER a {nonce,ct} object). */
  hint?: string;
}

/** `POST /v1/courier/deposit` response. */
export interface CourierDepositResponse {
  entryId: string;
  seq: number;
  sentSeq: number;
  status: CourierDeliveryStatus;
}

export type CourierDeliveryStatus = 'unclaimed' | 'claimed' | 'rejected';

/** One recipient-facing inbox row (DESIGN §6.5). */
export interface CourierInboxItem {
  entryId: string;
  seq: number;
  status: CourierDeliveryStatus;
  senderPubkey: string;
  ciphertext: string;
  transferId: string;
  hint: string | null;
  ackSig: string | null;
}

/** `GET /v1/courier/inbox?since=` response. */
export interface CourierInboxResponse {
  readPointer: number;
  syncEpoch: number;
  more: boolean;
  items: CourierInboxItem[];
}

/** One sender-facing `/sent` row — `ackSig` is null until the recipient claims. */
export interface CourierSentItem {
  entryId: string;
  recipientPubkey: string;
  status: CourierDeliveryStatus;
  /**
   * The server-assigned per-sender monotonic watermark for this row (same space as
   * the deposit `sentSeq`). Lets the sender persist a `/sent` watermark and paginate
   * `?since=` across pages, so a delivery confirmation on page 2 is never dropped.
   */
  sentSeq: number;
  ackSig: string | null;
  /**
   * The server nonce the recipient's claim consumed — surfaced so the SENDER can
   * rebuild the bound ack template and run `verifySignedMessage` itself. Null
   * until claimed. (Part A coordination: the real `/sent` row must carry this so
   * the sender's delivery gate can verify the recipient signature, §6.5.)
   */
  ackNonce: string | null;
}

/** `GET /v1/courier/sent?since=` response. */
export interface CourierSentResponse {
  more: boolean;
  items: CourierSentItem[];
}

/** `GET /v1/courier/ack-nonce?entryId=` response. */
export interface CourierAckNonceResponse {
  serverNonce: string;
}

/** `POST /v1/courier/ack` request — FROZEN single-entry shape (DESIGN §8.2). */
export interface CourierAckRequest {
  entryId: string;
  ackSig: string;
}

/** `POST /v1/courier/ack` response — the single frozen outcome (never a batch). */
export interface CourierAckResponse {
  result: 'claimed' | 'alreadyClaimed' | 'failed';
}

/**
 * The swap seam between the provider and the courier endpoints. The provider
 * calls only these typed methods; the fake server and the real token-api HTTP
 * client both implement it. Each method corresponds 1:1 to a `/v1/courier/*`
 * endpoint and carries the AUTHENTICATED caller (`ownerId = chainPubkey`) — the
 * fake server takes it as `senderId`; the real client supplies it via the JWT.
 */
export interface CourierHttpClient {
  /** `POST /v1/courier/deposit` — the caller is the sender. */
  deposit(req: CourierDepositRequest): Promise<CourierDepositResponse>;
  /** `GET /v1/courier/inbox?since=` — the caller is the recipient. */
  inbox(since: number): Promise<CourierInboxResponse>;
  /** `GET /v1/courier/ack-nonce?entryId=` — the caller is the recipient. */
  ackNonce(entryId: string): Promise<CourierAckNonceResponse>;
  /** `POST /v1/courier/ack` — the caller is the recipient. */
  ack(req: CourierAckRequest): Promise<CourierAckResponse>;
  /** `GET /v1/courier/sent?since=` — the caller is the sender. */
  sent(since: number): Promise<CourierSentResponse>;
}
