// §4 of docs/PAYMENTS-V2-DESIGN.md

import type { IMintJustificationVerifier } from '../../token-engine';
import type { NftContent } from '../../token-engine/nft-payload';
import type { NftReading } from '../../token-engine/types';
import type { Asset, CoinlessToken, IncomingTransfer, Token, TransferResult } from '../../types';

export interface SendRequest {
  recipient: string;
  amount: string;
  coinId: string;
  memo?: string;
}

/** 0.17.0's name for {@link SendWholeTokenRequest}. Kept so published imports compile. */
export type SendCoinlessRequest = SendWholeTokenRequest;

export interface SendWholeTokenRequest {
  recipient: string;
  tokenId: string;
  memo?: string;
}

export interface MintResult {
  success: boolean;
  tokenId?: string;
  error?: string;
}

/** Custom-genesis mint (a TokenPlugin's token), always to this wallet; `assets` = what the payload declares. */
export interface MintCustomRequest {
  readonly tokenType: Uint8Array;
  readonly salt: Uint8Array;
  readonly data: Uint8Array;
  readonly justification?: Uint8Array;
  readonly assets: readonly { coinId: string; amount: bigint }[];
  readonly mintJustificationVerifiers?: readonly IMintJustificationVerifier[];
}

/** Burn a held token to `BurnPredicate(sha256(reasonBytes))` with the bytes as aux data. */
export interface BurnRequest {
  readonly tokenId: string;
  readonly reasonBytes: Uint8Array;
}

export interface BurnResult {
  success: boolean;
  burnId: string;
  tokenId: string;
  /** The burned blob, the proof of the burn: persist it, then `acknowledgeBurn(burnId)`. */
  burnedToken?: Uint8Array;
  error?: string;
}

/** A burn not yet acknowledged: in flight (`burnedToken` null), certified, or settled. */
export interface PendingBurn {
  readonly burnId: string;
  readonly tokenId: string;
  readonly reasonBytes: Uint8Array;
  readonly burnedToken: Uint8Array | null;
  readonly settled: boolean;
  readonly createdAt: number;
}

/** #785: `content` uses ERC-721 field names; `sign` (default true) signs as creator with this wallet's chain key. */
export interface MintNftRequest {
  readonly content: NftContent;
  readonly sign?: boolean;
}

export interface NftView extends NftReading {
  readonly tokenId: string;
}

// Consumed field names: `timestamp`, not the wire's `ts`.
export interface HistoryEntry {
  id: string;
  type: 'SENT' | 'RECEIVED' | 'MINT';
  coinId: string;
  amount: string;
  symbol?: string;
  timestamp: number;
  memo?: string;
  transferId?: string;
  tokenId?: string;
  senderPubkey?: string;
  senderNametag?: string;
  recipientPubkey?: string;
  recipientNametag?: string;
  tokenIds?: { id: string; amount: string }[];
}

export interface HistoryPage {
  entries: HistoryEntry[];
  more: boolean;
  cursor: string | null;
}

export type PaymentRequestStatus =
  | 'pending'
  | 'settling'
  | 'paid'
  | 'rejected'
  | 'expired';

export interface PaymentRequestView {
  id: string;
  requestId: string;
  senderPubkey: string;
  senderNametag?: string;
  amount: string;
  coinId: string;
  symbol?: string;
  message?: string;
  timestamp: number;
  status: PaymentRequestStatus;
}

export interface PaymentsRequestsApi {
  create(
    to: string,
    terms: { coinId: string; amount: string; memo?: string }
  ): Promise<{ success: boolean; requestId?: string; error?: string }>;
  list(): PaymentRequestView[];
  // #441: durably 'settling' before any possibly-committed throw surfaces.
  pay(id: string): Promise<TransferResult>;
  // decline() propagates server 403/409 — a refused decline is not success.
  decline(id: string): Promise<void>;
  dismissProcessed(): void;
}

/**
 * A pending-transfers row, derived ON READ from the §6 stores (intent backstop
 * + delivery journal + shortfalls) — never a cached mirror. kind 'shortfall' =
 * a completed partial (#690) whose `amount` is the remainder still owed;
 * legs.certified counts journaled legs (certified, delivery still owed).
 */
export interface PendingTransfer {
  transferId: string;
  kind: 'open' | 'shortfall';
  recipient: string;
  coinId: string;
  amount: string;
  /** Set instead of coinId/amount when the intent is a token-addressed spend. */
  tokenId?: string;
  legs: { certified: number; total: number };
  deliveryPending: boolean;
  createdAt: number;
}

export type ConnectionStatus = 'connected' | 'degraded' | 'offline';

export interface PaymentsV2 {
  prewarmSend(request: SendRequest): Promise<void>;
  discardPrewarm(): void;
  assets(coinId?: string): Promise<Asset[]>;
  tokens(filter?: { coinId?: string }): Token[];
  coinless(): CoinlessToken[];
  tokenData(tokenId: string): Promise<Uint8Array | null>;
  /** One held token read as an NFT; null = its payload is not a recognised NFT. `creator` is only CLAIMED unless `signature` is 'valid'. Throws VALIDATION_ERROR when not held, STORAGE_ERROR when its blob is missing (same contract as tokenData). */
  nft(tokenId: string): Promise<NftView | null>;
  /** Batch read for list views. Ids not held, blobs missing or undecodable, and non-NFT payloads are simply absent from the map. Throws only on a transport failure. */
  nfts(tokenIds: readonly string[]): Promise<ReadonlyMap<string, NftView>>;
  history(page?: { before?: string; limit?: number }): Promise<HistoryPage>;

  send(req: SendRequest): Promise<TransferResult>;
  sendWholeToken(req: SendWholeTokenRequest): Promise<TransferResult>;
  /** NFT-scoped twin: refuses a valued source. Connect's `send_nft` routes here. */
  sendCoinless(req: SendWholeTokenRequest): Promise<TransferResult>;
  mint(coinId: string, amount: bigint): Promise<MintResult>;
  mintNft(request: MintNftRequest): Promise<MintResult>;
  mintCustom(request: MintCustomRequest): Promise<MintResult>;
  burn(request: BurnRequest): Promise<BurnResult>;
  pendingBurns(): Promise<PendingBurn[]>;
  acknowledgeBurn(burnId: string): Promise<void>;
  receive(): Promise<{ transfers: IncomingTransfer[] }>;

  // §7 convergence surface. A retry button calls resumeNow() — NEVER send():
  // a re-issued send double-pays (#631/#676). Coalesces with a running pass.
  pendingTransfers(): Promise<PendingTransfer[]>;
  resumeNow(): Promise<void>;

  // Readable at ANY time (a late-mounting indicator seeds it, sphere#473);
  // `connection:status` is only the change notification. 'offline' unstarted.
  connectionStatus(): ConnectionStatus;

  readonly requests: PaymentsRequestsApi;
}

// The 8 bus events; ConnectHost adapts old wire names from these (§4).
export interface PaymentsV2Events {
  'transfer:incoming': IncomingTransfer;
  'transfer:updated': TransferResult;
  'transfer:attention': { transferId: string; code: string; detail?: string };
  'inventory:updated': Record<string, never>;
  /** The just-recorded entry, client-shaped (the same mapping history() serves). */
  'history:updated': HistoryEntry;
  'payment_request:incoming': PaymentRequestView;
  'payment_request:updated': { id: string; status: PaymentRequestStatus };
  'connection:status': { status: ConnectionStatus };
}

export type { CoinlessToken };
export type {
  NftAttribute,
  NftContent,
  NftLink,
  NftMedia,
  NftMediaRef,
  NftMetadata,
  NftSignatureStatus,
} from '../../token-engine/nft-payload';
