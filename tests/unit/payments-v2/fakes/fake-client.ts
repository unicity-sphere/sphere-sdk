/**
 * fake-client.ts — a WalletApiV2Client-surface adapter backed directly by a
 * FakeWalletApi instance (typed method calls, no HTTP), so the P3b providers
 * are exercised against the adversarial fake. FakeApiError is translated to
 * WalletApiHttpError, matching the real client's error surface. Presigned URLs
 * are emulated as `fake://blob/<key>` (GET) and `fake://put/<sha>` (PUT); the
 * adapter keeps a tokenId→key index (fed by uploads, applies, and mailbox
 * listings) to serve `blobUrls`. Auth endpoints are not modeled by the fake.
 */
import { WalletApiHttpError } from '../../../../impl/wallet-api-v2/http';
import type {
  ApplyDeltaWire,
  AuthChallengeWire,
  AuthTokensWire,
  BalanceWire,
  BlobUrlWire,
  ClaimResultWire,
  HistoryPageWire,
  HistoryRecordWire,
  IntentWire,
  InventoryPageWire,
  ListPaymentRequestsParams,
  MailboxDepositEntry,
  MailboxPageWire,
  MailboxRejectReason,
  PaymentRequestWire as ClientPaymentRequestWire,
  PaymentRequestsPageWire,
  ProgressRecordWire,
  RespondPaymentRequestInput,
  UploadUrlWire,
} from '../../../../impl/wallet-api-v2/client';
import {
  FakeApiError,
  FakeWalletApi,
  decodeFakeBlob,
  type FakeBlobMeta,
  type FakeCaller,
  type PaymentRequestWire as FakePaymentRequestWire,
} from './FakeWalletApi';

const GET_URL_PREFIX = 'fake://blob/';
const PUT_URL_PREFIX = 'fake://put/';

function toHttpError(err: unknown): unknown {
  if (err instanceof FakeApiError) {
    return new WalletApiHttpError(err.statusCode, err.code, err.message);
  }
  return err;
}

function toRequestWire(row: FakePaymentRequestWire): ClientPaymentRequestWire {
  return {
    id: row.id,
    seq: row.seq,
    fromPubkey: row.fromPubkey,
    toPubkey: row.toPubkey,
    assets: [...row.assets],
    ...(row.memo !== undefined ? { memo: row.memo } : {}),
    status: row.status,
    transferId: row.transferId,
    createdAt: row.createdAt,
    ...(row.expiresAt !== undefined ? { expiresAt: row.expiresAt } : {}),
  };
}

export interface FakeClientOptions {
  /** Must match the fake's injected blob codec; defaults to the fake JSON codec. */
  decodeBlob?: (bytes: Uint8Array) => FakeBlobMeta;
}

export class FakeWalletApiV2Client {
  private readonly decode: (bytes: Uint8Array) => FakeBlobMeta;
  private readonly keyByTokenId = new Map<string, string>();

  constructor(
    private readonly fake: FakeWalletApi,
    private readonly caller: FakeCaller,
    options: FakeClientOptions = {}
  ) {
    this.decode = options.decodeBlob ?? decodeFakeBlob;
  }

  get baseUrl(): string {
    return 'https://fake-wallet-api.test';
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw toHttpError(err);
    }
  }

  /** Seed the tokenId→key index for blobs stored outside this adapter. */
  indexBlobKey(tokenId: string, key: string): void {
    this.keyByTokenId.set(tokenId, key);
  }

  // ── auth (not modeled by FakeWalletApi) ──────────────────────────────────

  authChallenge(_pubkey: string): Promise<AuthChallengeWire> {
    return Promise.reject(new WalletApiHttpError(501, 'NOT_MODELED', 'auth is not modeled by FakeWalletApi'));
  }

  authVerify(_input: { nonce: string; signature: string; deviceId: string }): Promise<AuthTokensWire> {
    return Promise.reject(new WalletApiHttpError(501, 'NOT_MODELED', 'auth is not modeled by FakeWalletApi'));
  }

  authRefresh(_refreshToken: string): Promise<AuthTokensWire> {
    return Promise.reject(new WalletApiHttpError(501, 'NOT_MODELED', 'auth is not modeled by FakeWalletApi'));
  }

  authLogout(): Promise<void> {
    return Promise.reject(new WalletApiHttpError(501, 'NOT_MODELED', 'auth is not modeled by FakeWalletApi'));
  }

  wsTicket(): Promise<string> {
    return Promise.reject(new WalletApiHttpError(501, 'NOT_MODELED', 'ws tickets are not modeled by FakeWalletApi'));
  }

  // ── inventory / blobs ────────────────────────────────────────────────────

  async listInventory(since?: number): Promise<InventoryPageWire> {
    const page = await this.run(() => this.fake.listInventory(this.caller, since));
    return {
      cursor: page.cursor,
      syncEpoch: page.syncEpoch,
      more: page.more,
      items: page.items.map((item) => ({
        tokenId: item.tokenId,
        status: item.status,
        seq: item.seq,
        stateHash: item.stateHash,
        ...(item.assets !== undefined ? { assets: [...item.assets] } : {}),
      })),
    };
  }

  async balances(): Promise<BalanceWire[]> {
    return this.run(() => this.fake.balances(this.caller));
  }

  async blobUrls(tokenIds: string[]): Promise<BlobUrlWire[]> {
    const urls: BlobUrlWire[] = [];
    for (const tokenId of tokenIds) {
      const key = this.keyByTokenId.get(tokenId);
      if (key !== undefined) urls.push({ tokenId, getUrl: `${GET_URL_PREFIX}${key}` });
    }
    return Promise.resolve(urls);
  }

  async uploadUrls(blobs: { sha256: string; size: number }[]): Promise<UploadUrlWire[]> {
    return Promise.resolve(
      blobs.map((blob) => ({ sha256: blob.sha256, key: blob.sha256, putUrl: `${PUT_URL_PREFIX}${blob.sha256}` }))
    );
  }

  async uploadBlob(putUrl: string, bytes: Uint8Array): Promise<void> {
    if (!putUrl.startsWith(PUT_URL_PREFIX)) {
      throw new WalletApiHttpError(400, 'BLOB_UPLOAD', `not a fake put url: ${putUrl}`);
    }
    const sha = putUrl.slice(PUT_URL_PREFIX.length);
    const { key } = await this.run(() => this.fake.putBlob(sha, bytes));
    try {
      this.keyByTokenId.set(this.decode(bytes).tokenId, key);
    } catch {
      // undecodable bytes stay unindexed — blobUrls simply won't serve them
    }
  }

  async fetchBlob(getUrl: string): Promise<Uint8Array> {
    if (!getUrl.startsWith(GET_URL_PREFIX)) {
      throw new WalletApiHttpError(400, 'BLOB_DOWNLOAD', `not a fake get url: ${getUrl}`);
    }
    const bytes = await this.fake.getBlob(getUrl.slice(GET_URL_PREFIX.length));
    if (bytes === undefined) {
      throw new WalletApiHttpError(404, 'BLOB_DOWNLOAD', 'blob download failed with status 404');
    }
    return bytes;
  }

  async apply(delta: {
    transferId: string;
    spent: string[];
    added: { tokenId: string; key: string }[];
  }): Promise<ApplyDeltaWire> {
    const result = await this.run(() => this.fake.apply(this.caller, delta));
    for (const added of delta.added) this.keyByTokenId.set(added.tokenId, added.key);
    return result;
  }

  // ── intents ──────────────────────────────────────────────────────────────

  async putIntent(transferId: string, payloadEnvelope: string, requiresSeedClose = false): Promise<void> {
    await this.run(() => this.fake.putIntent(this.caller, { transferId, payload: payloadEnvelope, requiresSeedClose }));
  }

  async listIntents(status: 'open' | 'aborted' = 'open'): Promise<IntentWire[]> {
    const intents = await this.run(() => this.fake.listIntents(this.caller, status));
    return intents.map((intent) => ({ ...intent }));
  }

  async abortIntent(transferId: string): Promise<void> {
    await this.run(() => this.fake.abortIntent(this.caller, transferId));
  }

  async completeIntent(transferId: string, signature?: string): Promise<void> {
    await this.run(() =>
      this.fake.completeIntent(this.caller, {
        transferId,
        ...(signature !== undefined ? { signature } : {}),
      })
    );
  }

  async postProgress(
    transferId: string,
    opIndex: number,
    payloadEnvelope: string,
    signature: string
  ): Promise<ProgressRecordWire> {
    const result = await this.run(() =>
      this.fake.appendProgress(this.caller, { transferId, opIndex, payload: payloadEnvelope, signature })
    );
    return { ...result.record };
  }

  async getProgress(transferId: string): Promise<ProgressRecordWire[]> {
    const records = await this.run(() => this.fake.listProgress(this.caller, transferId));
    return records.map((record) => ({ ...record }));
  }

  // ── mailbox ──────────────────────────────────────────────────────────────

  async deposit(entry: MailboxDepositEntry): Promise<string> {
    const result = await this.run(() => this.fake.deposit(this.caller, entry));
    this.keyByTokenId.set(entry.tokenId, entry.key);
    return result.entryId;
  }

  async depositBatch(entries: MailboxDepositEntry[]): Promise<{ entryId: string; seq: number }[]> {
    const result = await this.run(() => this.fake.depositBatch(this.caller, entries));
    for (const entry of entries) this.keyByTokenId.set(entry.tokenId, entry.key);
    return result.entries.map((entry) => ({ ...entry }));
  }

  async listMailbox(since?: number): Promise<MailboxPageWire> {
    const page = await this.run(() => this.fake.listMailbox(this.caller, since ?? 0));
    for (const entry of page.entries) this.keyByTokenId.set(entry.tokenId, entry.key);
    return {
      readPointer: page.readPointer,
      cursor: page.cursor,
      syncEpoch: page.syncEpoch,
      more: page.more,
      entries: page.entries.map((entry) => ({
        entryId: entry.entryId,
        seq: entry.seq,
        status: entry.status,
        transferId: entry.transferId ?? '',
        tokenId: entry.tokenId,
        assets: [...entry.assets],
        senderPubkey: entry.senderPubkey ?? '',
        ...(entry.memo !== undefined ? { memo: entry.memo } : {}),
        createdAt: entry.createdAt,
        getUrl: `${GET_URL_PREFIX}${entry.key}`,
        blobCollected: false,
      })),
    };
  }

  async claim(entryIds: string[], intoInventory: boolean): Promise<ClaimResultWire> {
    return this.run(() => this.fake.claim(this.caller, { entryIds, intoInventory }));
  }

  async reject(entryIds: string[], reason?: MailboxRejectReason, detail?: string): Promise<string[]> {
    const result = await this.run(() =>
      this.fake.reject(this.caller, {
        entryIds,
        ...(reason !== undefined ? { reason } : {}),
        ...(detail !== undefined ? { detail } : {}),
      })
    );
    return result.rejected;
  }

  // ── history ──────────────────────────────────────────────────────────────

  async postHistory(records: HistoryRecordWire[]): Promise<{ inserted: number; deduped: number }> {
    return this.run(() => this.fake.appendHistory(this.caller, records));
  }

  async listHistory(options: { before?: string; limit?: number } = {}): Promise<HistoryPageWire> {
    const page = await this.run(() => this.fake.listHistory(this.caller, options));
    return {
      records: page.records.map((record) => ({ ...record, assets: [...record.assets] })),
      more: page.more,
      cursor: page.cursor,
      syncEpoch: page.syncEpoch,
    };
  }

  // ── payment requests ─────────────────────────────────────────────────────

  async createPaymentRequest(input: {
    toPubkey: string;
    assets: { coinId: string; amount: string }[];
    memo?: string;
    expiresAt?: string;
  }): Promise<ClientPaymentRequestWire> {
    const row = await this.run(() => this.fake.createRequest(this.caller, input));
    return toRequestWire(row);
  }

  async listPaymentRequests(params: ListPaymentRequestsParams): Promise<PaymentRequestsPageWire> {
    const result = await this.run(() =>
      this.fake.listRequests(this.caller, {
        role: params.role,
        ...(params.status !== undefined ? { status: params.status } : {}),
        ...(params.role === 'incoming' && params.since !== undefined ? { since: params.since } : {}),
        ...(params.role === 'outgoing' && params.before !== undefined ? { before: params.before } : {}),
      })
    );
    return {
      requests: result.requests.map(toRequestWire),
      more: result.more,
      cursor: result.cursor,
      syncEpoch: result.syncEpoch,
    };
  }

  async respondPaymentRequest(id: string, response: RespondPaymentRequestInput): Promise<ClientPaymentRequestWire> {
    const row = await this.run(() =>
      this.fake.respondRequest(this.caller, id, {
        action: response.action,
        ...(response.action === 'paid' ? { transferId: response.transferId } : {}),
      })
    );
    return toRequestWire(row);
  }
}
