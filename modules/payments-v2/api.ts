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

export interface PaymentsV2 {
  assets(coinId?: string): Promise<Asset[]>;
  tokens(filter?: { coinId?: string }): Token[];
  history(page?: { before?: string; limit?: number }): Promise<HistoryPage>;

  send(req: SendRequest): Promise<TransferResult>;
  mint(coinId: string, amount: bigint): Promise<MintResult>;
  receive(): Promise<{ transfers: IncomingTransfer[] }>;

  readonly requests: PaymentsRequestsApi;
}

// The 8 bus events; ConnectHost adapts old wire names from these (§4).
export interface PaymentsV2Events {
  'transfer:incoming': IncomingTransfer;
  'transfer:updated': TransferResult;
  'transfer:attention': { transferId: string; code: string; detail?: string };
  'inventory:updated': Record<string, never>;
  'history:updated': Record<string, never>;
  'payment_request:incoming': PaymentRequestView;
  'payment_request:updated': { id: string; status: PaymentRequestStatus };
  'connection:status': { status: 'connected' | 'degraded' | 'offline' };
}
