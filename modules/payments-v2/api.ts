// §4 of docs/PAYMENTS-V2-DESIGN.md

import type { Asset, IncomingTransfer, Token, TransferResult } from '../../types';

export interface SendRequest {
  recipient: string;
  amount: string;
  coinId: string;
  memo?: string;
}

export interface MintResult {
  success: boolean;
  tokenId?: string;
  error?: string;
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
  history(page?: { before?: string; limit?: number }): Promise<HistoryPage>;

  send(req: SendRequest): Promise<TransferResult>;
  mint(coinId: string, amount: bigint): Promise<MintResult>;
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
