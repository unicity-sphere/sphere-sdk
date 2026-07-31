// P3b: WalletApiStoragePort — thin StoragePort over the §16 client
// (InventoryView owns the mirror; this file owns wire mapping + fan-out only).

import type { ApplyDeltaResult, InventoryPage, StoragePort } from '../../modules/payments-v2/ports';
import { isWalletApiHttpError } from './http';
import type { WalletApiV2Client } from './client';

export const WALLET_API_V2_FANOUT_WIDTH = 8;

export type StoragePortClient = Pick<
  WalletApiV2Client,
  'listInventory' | 'balances' | 'blobUrls' | 'uploadUrls' | 'apply' | 'fetchBlob' | 'uploadBlob'
>;

/** 409 on applyDelta: the server refused the delta on lineage grounds. */
export class DeltaConflictError extends Error {
  readonly code = 'DELTA_CONFLICT';
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'DeltaConflictError';
  }
}

/** 422 on applyDelta: the delta itself is invalid (bad blob, unknown spend, …). */
export class DeltaValidationError extends Error {
  readonly code = 'DELTA_VALIDATION';
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'DeltaValidationError';
  }
}

export class StoragePortProtocolError extends Error {
  readonly code = 'PROTOCOL';
  constructor(message: string) {
    super(message);
    this.name = 'StoragePortProtocolError';
  }
}

/** Bounded-parallel map: at most `width` in flight; stops claiming new work after a failure. */
export async function mapBounded<T, R>(
  items: readonly T[],
  width: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (failed) return;
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        out[index] = await fn(items[index] as T, index);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(width, items.length)) }, worker);
  await Promise.all(workers);
  return out;
}

export class WalletApiStoragePort implements StoragePort {
  constructor(private readonly client: StoragePortClient) {}

  async listInventory(since?: number): Promise<InventoryPage> {
    const page = await this.client.listInventory(since);
    return {
      cursor: page.cursor,
      syncEpoch: String(page.syncEpoch),
      more: page.more,
      items: page.items,
    };
  }

  balances(): Promise<{ coinId: string; total: string; tokenCount: number }[]> {
    return this.client.balances();
  }

  async getBlobs(tokenIds: string[]): Promise<Map<string, Uint8Array>> {
    if (tokenIds.length === 0) return new Map();
    const urls = await this.client.blobUrls(tokenIds);
    const bytes = await mapBounded(urls, WALLET_API_V2_FANOUT_WIDTH, (u) => this.client.fetchBlob(u.getUrl));
    const result = new Map<string, Uint8Array>();
    for (const [i, url] of urls.entries()) {
      const blob = bytes[i];
      if (blob !== undefined) result.set(url.tokenId, blob);
    }
    return result;
  }

  async uploadBlobs(blobs: { sha256: string; bytes: Uint8Array }[]): Promise<Map<string, string>> {
    if (blobs.length === 0) return new Map();
    const urls = await this.client.uploadUrls(blobs.map((b) => ({ sha256: b.sha256, size: b.bytes.length })));
    const urlBySha = new Map(urls.map((u) => [u.sha256, u]));
    const uploads = blobs.map((blob) => {
      const url = urlBySha.get(blob.sha256);
      if (url === undefined) {
        throw new StoragePortProtocolError(`upload-urls response missing sha256 ${blob.sha256}`);
      }
      return { blob, url };
    });
    await mapBounded(uploads, WALLET_API_V2_FANOUT_WIDTH, ({ blob, url }) =>
      this.client.uploadBlob(url.putUrl, blob.bytes)
    );
    return new Map(uploads.map(({ blob, url }) => [blob.sha256, url.key]));
  }

  async applyDelta(delta: {
    transferId: string;
    spent: string[];
    added: { tokenId: string; key: string }[];
  }): Promise<ApplyDeltaResult> {
    try {
      const result = await this.client.apply(delta);
      return { cursor: result.cursor, syncEpoch: String(result.syncEpoch) };
    } catch (err) {
      if (isWalletApiHttpError(err, 409)) throw new DeltaConflictError(err.message, err);
      if (isWalletApiHttpError(err, 422)) throw new DeltaValidationError(err.message, err);
      throw err;
    }
  }
}
