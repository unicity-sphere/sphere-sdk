/**
 * wallet-api/codec.ts — runtime wire ⇄ domain conversion for §16 responses.
 *
 * Hand-rolled validators (repo convention — no zod dependency). The hard rule
 * (ARCHITECTURE §11): asset amounts are decimal strings on the wire and
 * `bigint` in domain types — never a JS `number` (they exceed 2^53). Cursors,
 * seqs and the syncEpoch are parsed the same way; the codec tolerates either
 * a decimal string (the Postgres `bigint`-over-`pg` wire form) or a safe
 * integer number for those counters, but amounts MUST be strings.
 */

import type { InventoryItem } from '../storage/storage-provider';
import { WalletApiError } from './errors';
import type {
  BlobUrlEntry,
  CoinBalance,
  IntentRecord,
  InventoryPage,
  UploadUrlEntry,
} from './types';

function protocolError(message: string): WalletApiError {
  return new WalletApiError(message, 'PROTOCOL');
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw protocolError(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw protocolError(`${what} is not an array`);
  return value;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw protocolError(`${what} is not a string`);
  return value;
}

/** Counter (cursor/seq/syncEpoch): decimal string or safe integer → bigint. */
export function parseCounter(value: unknown, what: string): bigint {
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw protocolError(`${what} is not a non-negative integer counter`);
}

/** Amount: decimal string ONLY (§11) → bigint. */
export function parseAmount(value: unknown, what: string): bigint {
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return BigInt(value);
  throw protocolError(`${what} is not a decimal-string amount`);
}

function parseAssets(value: unknown, what: string): InventoryItem['assets'] {
  if (value === undefined || value === null) return undefined;
  return asArray(value, what).map((raw, i) => {
    const rec = asRecord(raw, `${what}[${i}]`);
    return {
      coinId: asString(rec.coinId, `${what}[${i}].coinId`),
      amount: parseAmount(rec.amount, `${what}[${i}].amount`),
    };
  });
}

function parseInventoryItem(raw: unknown, what: string): InventoryItem {
  const rec = asRecord(raw, what);
  const status = asString(rec.status, `${what}.status`);
  if (status !== 'active' && status !== 'removed') {
    throw protocolError(`${what}.status is neither 'active' nor 'removed'`);
  }
  return {
    tokenId: asString(rec.tokenId, `${what}.tokenId`),
    status,
    assets: parseAssets(rec.assets, `${what}.assets`),
    seq: parseCounter(rec.seq, `${what}.seq`),
  };
}

/** `GET /v1/inventory` → {@link InventoryPage} (§16). */
export function parseInventoryPage(body: unknown): InventoryPage {
  const rec = asRecord(body, 'inventory response');
  if (typeof rec.more !== 'boolean') throw protocolError('inventory response .more is not a boolean');
  return {
    cursor: parseCounter(rec.cursor, 'inventory response .cursor'),
    syncEpoch: parseCounter(rec.syncEpoch, 'inventory response .syncEpoch'),
    more: rec.more,
    items: asArray(rec.items, 'inventory response .items').map((raw, i) =>
      parseInventoryItem(raw, `items[${i}]`)
    ),
  };
}

/** `GET /v1/balances` → {@link CoinBalance}[] (§16). */
export function parseBalances(body: unknown): CoinBalance[] {
  const rec = asRecord(body, 'balances response');
  return asArray(rec.balances, 'balances response .balances').map((raw, i) => {
    const b = asRecord(raw, `balances[${i}]`);
    const tokenCount = b.tokenCount;
    if (typeof tokenCount !== 'number' || !Number.isSafeInteger(tokenCount) || tokenCount < 0) {
      throw protocolError(`balances[${i}].tokenCount is not a non-negative integer`);
    }
    return {
      coinId: asString(b.coinId, `balances[${i}].coinId`),
      total: parseAmount(b.total, `balances[${i}].total`),
      tokenCount,
    };
  });
}

/** `POST /v1/tokens/blob-urls` → {@link BlobUrlEntry}[] (§16). */
export function parseBlobUrls(body: unknown): BlobUrlEntry[] {
  const rec = asRecord(body, 'blob-urls response');
  return asArray(rec.urls, 'blob-urls response .urls').map((raw, i) => {
    const u = asRecord(raw, `urls[${i}]`);
    return {
      tokenId: asString(u.tokenId, `urls[${i}].tokenId`),
      getUrl: asString(u.getUrl, `urls[${i}].getUrl`),
    };
  });
}

/** `POST /v1/tokens/upload-urls` → {@link UploadUrlEntry}[] (§16). */
export function parseUploadUrls(body: unknown): UploadUrlEntry[] {
  const rec = asRecord(body, 'upload-urls response');
  return asArray(rec.urls, 'upload-urls response .urls').map((raw, i) => {
    const u = asRecord(raw, `urls[${i}]`);
    return {
      sha256: asString(u.sha256, `urls[${i}].sha256`),
      key: asString(u.key, `urls[${i}].key`),
      putUrl: asString(u.putUrl, `urls[${i}].putUrl`),
    };
  });
}

/** `POST /v1/inventory/apply` → cursor (§16). */
export function parseApplyResult(body: unknown): bigint {
  const rec = asRecord(body, 'apply response');
  return parseCounter(rec.cursor, 'apply response .cursor');
}

/** `GET /v1/intents` → {@link IntentRecord}[] (§16). */
export function parseIntents(body: unknown): IntentRecord[] {
  const rec = asRecord(body, 'intents response');
  return asArray(rec.intents, 'intents response .intents').map((raw, i) => {
    const it = asRecord(raw, `intents[${i}]`);
    const status = asString(it.status, `intents[${i}].status`);
    if (status !== 'open' && status !== 'completed' && status !== 'aborted') {
      throw protocolError(`intents[${i}].status is not a known intent status`);
    }
    const createdAt = Date.parse(asString(it.createdAt, `intents[${i}].createdAt`));
    if (Number.isNaN(createdAt)) throw protocolError(`intents[${i}].createdAt is not a timestamp`);
    return {
      transferId: asString(it.transferId, `intents[${i}].transferId`),
      payload: asString(it.payload, `intents[${i}].payload`),
      status,
      createdAt,
    };
  });
}

/** Auth responses (§4). */
export function parseAuthChallenge(body: unknown): { nonce: string; challenge: string } {
  const rec = asRecord(body, 'auth/challenge response');
  return {
    nonce: asString(rec.nonce, 'auth/challenge response .nonce'),
    challenge: asString(rec.challenge, 'auth/challenge response .challenge'),
  };
}

export function parseAuthTokens(body: unknown): { jwt: string; refreshToken: string } {
  const rec = asRecord(body, 'auth token response');
  return {
    jwt: asString(rec.jwt, 'auth token response .jwt'),
    refreshToken: asString(rec.refreshToken, 'auth token response .refreshToken'),
  };
}

/** `POST /v1/ws-ticket` (§9). */
export function parseWsTicket(body: unknown): string {
  const rec = asRecord(body, 'ws-ticket response');
  return asString(rec.ticket, 'ws-ticket response .ticket');
}

/** WS wake frame (§9): `{ type:'wake', stream, syncEpoch }`. */
export function parseWakeFrame(raw: string): { stream: 'inventory' | 'mailbox' | 'payment_requests'; syncEpoch: bigint } | null {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  const rec = body as Record<string, unknown>;
  if (rec.type !== 'wake') return null;
  const stream = rec.stream;
  if (stream !== 'inventory' && stream !== 'mailbox' && stream !== 'payment_requests') return null;
  try {
    return { stream, syncEpoch: parseCounter(rec.syncEpoch, 'wake .syncEpoch') };
  } catch {
    return null;
  }
}
