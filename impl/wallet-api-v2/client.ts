// §16 typed endpoints over http.ts. Amounts are decimal STRINGS end-to-end.

import { sha256 } from '@noble/hashes/sha2.js';

import { WalletApiHttpError, type WalletApiHttp } from './http';

export interface AuthChallengeWire {
  nonce: string;
  challenge: string;
  expiresAt: string;
}

export interface AuthTokensWire {
  jwt: string;
  refreshToken: string;
}

export interface AssetWire {
  coinId: string;
  amount: string;
}

export interface InventoryItemWire {
  tokenId: string;
  status: 'active' | 'removed';
  seq: number;
  stateHash: string;
  assets?: AssetWire[];
}

export interface InventoryPageWire {
  cursor: number;
  syncEpoch: number;
  more: boolean;
  items: InventoryItemWire[];
}

export interface BalanceWire {
  coinId: string;
  total: string;
  tokenCount: number;
}

export interface BlobUrlWire {
  tokenId: string;
  getUrl: string;
}

export interface UploadUrlWire {
  sha256: string;
  key: string;
  putUrl: string;
}

export interface ApplyDeltaWire {
  cursor: number;
  syncEpoch: number;
}

export interface IntentWire {
  transferId: string;
  payload: string;
  status: 'open' | 'aborted';
  createdAt: string;
}

export interface ProgressRecordWire {
  opIndex: number;
  payload: string;
  createdAt: string;
}

export interface MailboxDepositEntry {
  recipientPubkey: string;
  key: string;
  transferId: string;
  tokenId: string;
  stateHash: string;
  memo?: string;
}

export interface MailboxEntryWire {
  entryId: string;
  seq: number;
  status: string;
  transferId: string;
  tokenId: string;
  assets: AssetWire[];
  senderPubkey: string;
  memo?: string;
  createdAt: string;
  getUrl?: string;
  blobCollected?: boolean;
}

export interface MailboxPageWire {
  readPointer: number;
  cursor: number;
  syncEpoch: number;
  more: boolean;
  entries: MailboxEntryWire[];
}

export interface ClaimResultWire {
  claimed: string[];
  alreadyClaimed: { entryId: string; intoInventory: boolean }[];
  failed: { entryId: string; code: string }[];
}

export type MailboxRejectReason = 'invalid' | 'not-owned' | 'storage-rejected' | 'other';

export interface HistoryRecordWire {
  dedupKey: string;
  id: string;
  type: 'SENT' | 'RECEIVED' | 'MINT';
  assets: AssetWire[];
  ts: string;
  transferId?: string;
  tokenId?: string;
  counterpartyPubkey?: string;
  counterpartyNametag?: string;
  memo?: string;
}

export interface HistoryPageWire {
  records: HistoryRecordWire[];
  more: boolean;
  cursor: string | null;
  syncEpoch: number;
}

export type PaymentRequestWireStatus = 'open' | 'paid' | 'declined' | 'expired';

export interface PaymentRequestWire {
  id: string;
  seq: number;
  fromPubkey: string;
  toPubkey: string;
  assets: AssetWire[];
  memo?: string;
  status: PaymentRequestWireStatus;
  transferId: string | null;
  createdAt: string;
  expiresAt?: string;
}

export interface PaymentRequestsPageWire {
  requests: PaymentRequestWire[];
  more: boolean;
  cursor: number | string | null;
  syncEpoch: number;
}

export type ListPaymentRequestsParams =
  | { role: 'incoming'; status?: PaymentRequestWireStatus; since?: number }
  | { role: 'outgoing'; status?: PaymentRequestWireStatus; before?: string };

export type RespondPaymentRequestInput =
  | { action: 'paid'; transferId: string }
  | { action: 'declined' };

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export class WalletApiV2Client {
  constructor(private readonly http: WalletApiHttp) {}

  get baseUrl(): string {
    return this.http.baseUrl;
  }

  // ── auth ─────────────────────────────────────────────────────────────────

  authChallenge(pubkey: string): Promise<AuthChallengeWire> {
    return this.http.request('POST', '/v1/auth/challenge', { pubkey }, { auth: false }) as Promise<AuthChallengeWire>;
  }

  authVerify(input: { nonce: string; signature: string; deviceId: string }): Promise<AuthTokensWire> {
    return this.http.request('POST', '/v1/auth/verify', input, { auth: false }) as Promise<AuthTokensWire>;
  }

  authRefresh(refreshToken: string): Promise<AuthTokensWire> {
    return this.http.request('POST', '/v1/auth/refresh', { refreshToken }, { auth: false }) as Promise<AuthTokensWire>;
  }

  async authLogout(): Promise<void> {
    await this.http.request('POST', '/v1/auth/logout', {});
  }

  // ── inventory / blobs ────────────────────────────────────────────────────

  listInventory(since?: number): Promise<InventoryPageWire> {
    const query = since !== undefined ? `?since=${since}` : '';
    return this.http.request('GET', `/v1/inventory${query}`) as Promise<InventoryPageWire>;
  }

  async balances(): Promise<BalanceWire[]> {
    const body = (await this.http.request('GET', '/v1/balances')) as { balances: BalanceWire[] };
    return body.balances;
  }

  async blobUrls(tokenIds: string[]): Promise<BlobUrlWire[]> {
    const body = (await this.http.request('POST', '/v1/tokens/blob-urls', { tokenIds })) as {
      urls: BlobUrlWire[];
    };
    return body.urls;
  }

  async uploadUrls(blobs: { sha256: string; size: number }[]): Promise<UploadUrlWire[]> {
    const body = (await this.http.request('POST', '/v1/tokens/upload-urls', { blobs })) as {
      urls: UploadUrlWire[];
    };
    return body.urls;
  }

  apply(delta: {
    transferId: string;
    spent: string[];
    added: { tokenId: string; key: string }[];
  }): Promise<ApplyDeltaWire> {
    return this.http.request('POST', '/v1/inventory/apply', delta) as Promise<ApplyDeltaWire>;
  }

  async fetchBlob(getUrl: string): Promise<Uint8Array> {
    const res = await this.http.fetchRaw(getUrl, { method: 'GET' });
    if (!res.ok) {
      throw new WalletApiHttpError(res.status, 'BLOB_DOWNLOAD', `blob download failed with status ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * PUT to a presigned S3 URL. `x-amz-checksum-sha256` (base64) and
   * `If-None-Match: *` are SIGNED headers — sent verbatim. S3 412 = the
   * identical blob already exists = success.
   */
  async uploadBlob(putUrl: string, bytes: Uint8Array): Promise<void> {
    const res = await this.http.fetchRaw(putUrl, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'x-amz-checksum-sha256': bytesToBase64(sha256(bytes)),
        'if-none-match': '*',
      },
      body: bytes,
    });
    if (res.ok || res.status === 412) return;
    throw new WalletApiHttpError(res.status, 'BLOB_UPLOAD', `blob upload failed with status ${res.status}`);
  }

  // ── intents ──────────────────────────────────────────────────────────────

  async putIntent(transferId: string, payloadEnvelope: string, requiresSeedClose = false): Promise<void> {
    const body = requiresSeedClose
      ? { payload: payloadEnvelope, requiresSeedClose: true }
      : { payload: payloadEnvelope };
    await this.http.request('PUT', `/v1/intents/${transferId}`, body);
  }

  async listIntents(status: 'open' | 'aborted' = 'open'): Promise<IntentWire[]> {
    const body = (await this.http.request('GET', `/v1/intents?status=${status}`)) as {
      intents: IntentWire[];
    };
    return body.intents;
  }

  async abortIntent(transferId: string): Promise<void> {
    await this.http.request('POST', `/v1/intents/${transferId}/abort`);
  }

  async completeIntent(transferId: string, signature?: string): Promise<void> {
    await this.http.request(
      'POST',
      `/v1/intents/${transferId}/complete`,
      signature !== undefined ? { signature } : undefined
    );
  }

  async postProgress(
    transferId: string,
    opIndex: number,
    payloadEnvelope: string,
    signature: string
  ): Promise<ProgressRecordWire> {
    const body = (await this.http.request('POST', `/v1/intents/${transferId}/progress`, {
      opIndex,
      payload: payloadEnvelope,
      signature,
    })) as { record: ProgressRecordWire };
    return body.record;
  }

  async getProgress(transferId: string): Promise<ProgressRecordWire[]> {
    const body = (await this.http.request('GET', `/v1/intents/${transferId}/progress`)) as {
      records: ProgressRecordWire[];
    };
    return body.records;
  }

  // ── mailbox ──────────────────────────────────────────────────────────────

  async deposit(entry: MailboxDepositEntry): Promise<string> {
    const body = (await this.http.request('POST', '/v1/mailbox', entry)) as { entryId: string };
    return body.entryId;
  }

  async depositBatch(entries: MailboxDepositEntry[]): Promise<{ entryId: string; seq: number }[]> {
    const body = (await this.http.request('POST', '/v1/mailbox/batch', { entries })) as {
      entries: { entryId: string; seq: number }[];
    };
    return body.entries;
  }

  listMailbox(since?: number): Promise<MailboxPageWire> {
    const query = since !== undefined ? `?since=${since}` : '';
    return this.http.request('GET', `/v1/mailbox${query}`) as Promise<MailboxPageWire>;
  }

  claim(entryIds: string[], intoInventory: boolean): Promise<ClaimResultWire> {
    return this.http.request('POST', '/v1/mailbox/claim', { entryIds, intoInventory }) as Promise<ClaimResultWire>;
  }

  async reject(entryIds: string[], reason?: MailboxRejectReason, detail?: string): Promise<string[]> {
    const body = (await this.http.request('POST', '/v1/mailbox/reject', {
      entryIds,
      ...(reason !== undefined ? { reason } : {}),
      ...(detail !== undefined ? { detail } : {}),
    })) as { rejected: string[] };
    return body.rejected;
  }

  // ── history ──────────────────────────────────────────────────────────────

  async postHistory(records: HistoryRecordWire[]): Promise<{ inserted: number; deduped: number }> {
    return (await this.http.request('POST', '/v1/history', { records })) as {
      inserted: number;
      deduped: number;
    };
  }

  listHistory(options: { before?: string; limit?: number } = {}): Promise<HistoryPageWire> {
    const params = new URLSearchParams();
    if (options.before !== undefined) params.set('before', options.before);
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    const qs = params.toString();
    return this.http.request('GET', `/v1/history${qs ? `?${qs}` : ''}`) as Promise<HistoryPageWire>;
  }

  // ── payment requests ─────────────────────────────────────────────────────

  createPaymentRequest(input: {
    toPubkey: string;
    assets: AssetWire[];
    memo?: string;
    expiresAt?: string;
  }): Promise<PaymentRequestWire> {
    return this.http.request('POST', '/v1/payment-requests', input) as Promise<PaymentRequestWire>;
  }

  listPaymentRequests(params: ListPaymentRequestsParams): Promise<PaymentRequestsPageWire> {
    const query = new URLSearchParams();
    query.set('role', params.role);
    if (params.status !== undefined) query.set('status', params.status);
    if (params.role === 'incoming') {
      if (params.since !== undefined) query.set('since', String(params.since));
    } else if (params.before !== undefined) {
      query.set('before', params.before);
    }
    return this.http.request('GET', `/v1/payment-requests?${query.toString()}`) as Promise<PaymentRequestsPageWire>;
  }

  respondPaymentRequest(id: string, response: RespondPaymentRequestInput): Promise<PaymentRequestWire> {
    return this.http.request('POST', `/v1/payment-requests/${id}/respond`, response) as Promise<PaymentRequestWire>;
  }

  // ── realtime ─────────────────────────────────────────────────────────────

  async wsTicket(): Promise<string> {
    const body = (await this.http.request('POST', '/v1/ws-ticket')) as { ticket: string };
    return body.ticket;
  }
}
