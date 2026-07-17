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
  HistoryPage,
  HistoryWireRecord,
  IntentRecord,
  InventoryPage,
  MailboxClaimResult,
  MailboxEntry,
  MailboxPage,
  PaymentRequestRecord,
  PaymentRequestsPage,
  ProgressRecord,
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
    // Additive (wallet-api inventory state_hash exposure): the row's current protocol
    // state hash. Optional so a pre-exposure server (no field) parses fine and the
    // client degrades to prune-primary rather than mis-firing state-aware removals.
    ...(rec.stateHash === undefined ? {} : { stateHash: asString(rec.stateHash, `${what}.stateHash`) }),
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

function parseProgressEntry(raw: unknown, where: string): ProgressRecord {
  const it = asRecord(raw, where);
  const opIndex = Number(it.opIndex);
  if (!Number.isInteger(opIndex) || opIndex < 0) throw protocolError(`${where}.opIndex is not a non-negative integer`);
  const createdAt = Date.parse(asString(it.createdAt, `${where}.createdAt`));
  if (Number.isNaN(createdAt)) throw protocolError(`${where}.createdAt is not a timestamp`);
  return { opIndex, payload: asString(it.payload, `${where}.payload`), createdAt };
}

/** `POST /v1/intents/{id}/progress` → the stored record (§16/E.4; 201 created or 200 first-write-wins). */
export function parseProgressRecord(body: unknown): ProgressRecord {
  const rec = asRecord(body, 'progress response');
  return parseProgressEntry(rec.record, 'progress response .record');
}

/** `GET /v1/intents/{id}/progress` → the stored records, ascending opIndex (§16/E.4). */
export function parseProgressRecords(body: unknown): ProgressRecord[] {
  const rec = asRecord(body, 'progress list response');
  return asArray(rec.records, 'progress list response .records').map((raw, i) =>
    parseProgressEntry(raw, `progress records[${i}]`)
  );
}

// ── mailbox (§6/§16) ──────────────────────────────────────────────────────────

/** `POST /v1/mailbox` → entryId (§16). */
export function parseDepositResult(body: unknown): string {
  const rec = asRecord(body, 'mailbox deposit response');
  return asString(rec.entryId, 'mailbox deposit response .entryId');
}

function parseMailboxEntry(raw: unknown, what: string): MailboxEntry {
  const rec = asRecord(raw, what);
  const status = asString(rec.status, `${what}.status`);
  if (status !== 'unclaimed' && status !== 'claimed' && status !== 'rejected') {
    throw protocolError(`${what}.status is not a known mailbox entry status`);
  }
  const createdAt = Date.parse(asString(rec.createdAt, `${what}.createdAt`));
  if (Number.isNaN(createdAt)) throw protocolError(`${what}.createdAt is not a timestamp`);
  return {
    entryId: asString(rec.entryId, `${what}.entryId`),
    seq: parseCounter(rec.seq, `${what}.seq`),
    status,
    transferId: asString(rec.transferId, `${what}.transferId`),
    tokenId: asString(rec.tokenId, `${what}.tokenId`),
    assets: (parseAssets(rec.assets, `${what}.assets`) ?? []).map((a) => ({ ...a })),
    senderPubkey: asString(rec.senderPubkey, `${what}.senderPubkey`),
    ...(rec.memo !== undefined && rec.memo !== null
      ? { memo: asString(rec.memo, `${what}.memo`) }
      : {}),
    createdAt,
    ...(rec.getUrl !== undefined && rec.getUrl !== null
      ? { getUrl: asString(rec.getUrl, `${what}.getUrl`) }
      : {}),
    ...(rec.blobCollected === true ? { blobCollected: true } : {}),
  };
}

/** `GET /v1/mailbox?since=` → {@link MailboxPage} (§16). */
export function parseMailboxPage(body: unknown): MailboxPage {
  const rec = asRecord(body, 'mailbox response');
  if (typeof rec.more !== 'boolean') throw protocolError('mailbox response .more is not a boolean');
  return {
    readPointer: parseCounter(rec.readPointer, 'mailbox response .readPointer'),
    syncEpoch: parseCounter(rec.syncEpoch, 'mailbox response .syncEpoch'),
    more: rec.more,
    entries: asArray(rec.entries, 'mailbox response .entries').map((raw, i) =>
      parseMailboxEntry(raw, `entries[${i}]`)
    ),
  };
}

/** `POST /v1/mailbox/claim` → {@link MailboxClaimResult} (§16). */
export function parseClaimResult(body: unknown): MailboxClaimResult {
  const rec = asRecord(body, 'mailbox claim response');
  return {
    claimed: asArray(rec.claimed, 'claim response .claimed').map((raw, i) =>
      asString(raw, `claimed[${i}]`)
    ),
    alreadyClaimed: asArray(rec.alreadyClaimed, 'claim response .alreadyClaimed').map((raw, i) => {
      const a = asRecord(raw, `alreadyClaimed[${i}]`);
      if (typeof a.intoInventory !== 'boolean') {
        throw protocolError(`alreadyClaimed[${i}].intoInventory is not a boolean`);
      }
      return { entryId: asString(a.entryId, `alreadyClaimed[${i}].entryId`), intoInventory: a.intoInventory };
    }),
    failed: asArray(rec.failed, 'claim response .failed').map((raw, i) => {
      const f = asRecord(raw, `failed[${i}]`);
      return { entryId: asString(f.entryId, `failed[${i}].entryId`), code: asString(f.code, `failed[${i}].code`) };
    }),
  };
}

/** `POST /v1/mailbox/reject` → rejected entry ids (§16). */
export function parseRejectResult(body: unknown): string[] {
  const rec = asRecord(body, 'mailbox reject response');
  return asArray(rec.rejected, 'reject response .rejected').map((raw, i) => asString(raw, `rejected[${i}]`));
}

// ── payment requests (§10/§16) ────────────────────────────────────────────────

/** One §16 payment request → {@link PaymentRequestRecord} (create/respond/list). */
export function parsePaymentRequestRecord(raw: unknown, what: string): PaymentRequestRecord {
  const rec = asRecord(raw, what);
  const status = asString(rec.status, `${what}.status`);
  if (status !== 'open' && status !== 'paid' && status !== 'declined' && status !== 'expired') {
    throw protocolError(`${what}.status is not a known payment-request status`);
  }
  const createdAt = Date.parse(asString(rec.createdAt, `${what}.createdAt`));
  if (Number.isNaN(createdAt)) throw protocolError(`${what}.createdAt is not a timestamp`);
  let expiresAt: number | undefined;
  if (rec.expiresAt !== undefined && rec.expiresAt !== null) {
    expiresAt = Date.parse(asString(rec.expiresAt, `${what}.expiresAt`));
    if (Number.isNaN(expiresAt)) throw protocolError(`${what}.expiresAt is not a timestamp`);
  }
  if (rec.transferId !== null && typeof rec.transferId !== 'string') {
    throw protocolError(`${what}.transferId is neither a string nor null`);
  }
  return {
    id: asString(rec.id, `${what}.id`),
    seq: parseCounter(rec.seq, `${what}.seq`),
    fromPubkey: asString(rec.fromPubkey, `${what}.fromPubkey`),
    toPubkey: asString(rec.toPubkey, `${what}.toPubkey`),
    assets: (parseAssets(rec.assets, `${what}.assets`) ?? []).map((a) => ({ ...a })),
    ...(rec.memo !== undefined && rec.memo !== null
      ? { memo: asString(rec.memo, `${what}.memo`) }
      : {}),
    status,
    transferId: rec.transferId,
    createdAt,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

/**
 * `GET /v1/payment-requests?role=` → {@link PaymentRequestsPage} (§16). The
 * cursor family is role-bound: incoming pages carry the `?since=` seq counter,
 * outgoing pages an opaque keyset string (null once drained) — a page whose
 * cursor does not match its role is a protocol violation.
 */
export function parsePaymentRequestsPage(
  body: unknown,
  role: 'incoming' | 'outgoing'
): PaymentRequestsPage {
  const rec = asRecord(body, 'payment-requests response');
  if (typeof rec.more !== 'boolean') throw protocolError('payment-requests response .more is not a boolean');
  const requests = asArray(rec.requests, 'payment-requests response .requests').map((raw, i) =>
    parsePaymentRequestRecord(raw, `requests[${i}]`)
  );
  const syncEpoch = parseCounter(rec.syncEpoch, 'payment-requests response .syncEpoch');
  if (role === 'incoming') {
    return {
      role,
      requests,
      more: rec.more,
      cursor: parseCounter(rec.cursor, 'payment-requests response .cursor'),
      syncEpoch,
    };
  }
  if (rec.cursor !== null && typeof rec.cursor !== 'string') {
    throw protocolError('payment-requests response .cursor is neither a keyset string nor null');
  }
  return { role, requests, more: rec.more, cursor: rec.cursor, syncEpoch };
}

// ── history (§10/§16) ─────────────────────────────────────────────────────────

function parseHistoryRecord(raw: unknown, what: string): HistoryWireRecord {
  const rec = asRecord(raw, what);
  return {
    dedupKey: asString(rec.dedupKey, `${what}.dedupKey`),
    id: asString(rec.id, `${what}.id`),
    type: asString(rec.type, `${what}.type`),
    ts: asString(rec.ts, `${what}.ts`),
    assets: asArray(rec.assets, `${what}.assets`).map((a, i) => {
      const asset = asRecord(a, `${what}.assets[${i}]`);
      // Amounts stay decimal strings on this surface — display data (§10).
      parseAmount(asset.amount, `${what}.assets[${i}].amount`);
      return {
        coinId: asString(asset.coinId, `${what}.assets[${i}].coinId`),
        amount: asString(asset.amount, `${what}.assets[${i}].amount`),
      };
    }),
    ...(typeof rec.transferId === 'string' ? { transferId: rec.transferId } : {}),
    ...(typeof rec.tokenId === 'string' ? { tokenId: rec.tokenId } : {}),
    ...(typeof rec.counterpartyPubkey === 'string' ? { counterpartyPubkey: rec.counterpartyPubkey } : {}),
    ...(typeof rec.memo === 'string' ? { memo: rec.memo } : {}),
    ...(typeof rec.counterpartyNametag === 'string' ? { counterpartyNametag: rec.counterpartyNametag } : {}),
  };
}

/** `GET /v1/history` → {@link HistoryPage} (§16). */
export function parseHistoryPage(body: unknown): HistoryPage {
  const rec = asRecord(body, 'history response');
  if (typeof rec.more !== 'boolean') throw protocolError('history response .more is not a boolean');
  if (rec.cursor !== null && typeof rec.cursor !== 'string') {
    throw protocolError('history response .cursor is not a string or null');
  }
  return {
    records: asArray(rec.records, 'history response .records').map((raw, i) =>
      parseHistoryRecord(raw, `records[${i}]`)
    ),
    more: rec.more,
    cursor: rec.cursor,
    syncEpoch: parseCounter(rec.syncEpoch, 'history response .syncEpoch'),
  };
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
