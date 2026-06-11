/**
 * wallet-api/types.ts — sphere-domain types for the wallet-api client (S1).
 *
 * Wire rule (ARCHITECTURE §11/§16): asset amounts are arbitrary-precision
 * integers carried as decimal strings (`/^[0-9]+$/`) in every JSON body and
 * response — they exceed 2^53, so they are NEVER a JS `number`. In these types
 * they are `bigint`; the codec (./codec.ts) converts at the boundary. Cursors
 * and seqs are `bigint` for the same reason.
 */

import type { InventoryItem } from '../storage/storage-provider';

// ── collaborator ports (DI — no singletons) ──────────────────────────────────

/**
 * The narrow slice of `StorageProvider` the client needs: the refresh token
 * (credential hygiene — most-protected storage the platform offers, never a
 * URL, never logs) and the normative LOCAL copy of open intents (E.3).
 */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Minimal fetch signature (injectable; defaults to `globalThis.fetch`). */
export type FetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}) => Promise<FetchResponseLike>;

export interface FetchResponseLike {
  status: number;
  ok: boolean;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Minimal WebSocket surface (browser WebSocket and the `ws` package both satisfy it). */
export interface WebSocketLike {
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  close(): void;
}

export type WebSocketFactoryLike = (url: string) => WebSocketLike;

// ── client config / identity ─────────────────────────────────────────────────

export interface WalletApiClientConfig {
  /**
   * Backend base URL. Non-loopback URLs MUST be `https:` (ARCHITECTURE §4
   * transport rule, enforced client-side at construction) — bearer JWTs,
   * refresh tokens and signed URLs never transit plaintext off-loopback.
   */
  baseUrl: string;
  /** Network name, e.g. 'testnet2' — required end-to-end (ARCHITECTURE §14). */
  network: string;
  /** Client-chosen device label (never a key on its own — ARCHITECTURE §4). */
  deviceId: string;
  /** Refresh-token + local-intent persistence (see {@link KeyValueStore}). */
  storage: KeyValueStore;
  /** Injectable fetch (defaults to `globalThis.fetch`). */
  fetchFn?: FetchLike;
  /** Injectable WebSocket factory (defaults to `globalThis.WebSocket`). */
  webSocketFactory?: WebSocketFactoryLike;
  /** Injectable clock (ms since epoch) for challenge plausibility checks. */
  now?: () => number;
}

/** The wallet identity the client authenticates as. */
export interface WalletApiIdentity {
  /** secp256k1 private key, hex — signs auth challenges; never leaves the client. */
  privateKey: string;
  /** 33-byte compressed secp256k1 public key, hex. */
  chainPubkey: string;
}

// ── REST result shapes (§16) ──────────────────────────────────────────────────

/** `GET /v1/inventory` page (§16). */
export interface InventoryPage {
  cursor: bigint;
  syncEpoch: bigint;
  more: boolean;
  items: InventoryItem[];
}

/** `GET /v1/balances` entry (§16) — active rows only. */
export interface CoinBalance {
  coinId: string;
  total: bigint;
  tokenCount: number;
}

/** `POST /v1/tokens/blob-urls` entry (§16): short-lived signed GET. */
export interface BlobUrlEntry {
  tokenId: string;
  getUrl: string;
}

/** `POST /v1/tokens/upload-urls` request entry (§5.2): client-side sha256 + size. */
export interface UploadUrlRequest {
  /** Lowercase hex SHA-256 of the exact blob bytes. */
  sha256: string;
  size: number;
}

/** `POST /v1/tokens/upload-urls` response entry (§16). */
export interface UploadUrlEntry {
  sha256: string;
  /** The derived content-addressed key `<network>/t/<sha256>` (§5.2). */
  key: string;
  putUrl: string;
}

/** `POST /v1/inventory/apply` request (§5.3/§16). */
export interface ApplyDeltaRequest {
  transferId: string;
  spent: string[];
  added: { tokenId: string; key: string }[];
  externalDelivery?: boolean;
}

/** Intent row (§16). `payload` is the S6 `enc1.` envelope string, verbatim. */
export interface IntentRecord {
  transferId: string;
  payload: string;
  status: 'open' | 'completed' | 'aborted';
  createdAt: number;
}

// ── mailbox (§6/§16) ──────────────────────────────────────────────────────────

/** `POST /v1/mailbox` request (§16). `memo` is the S6 `enc1.` envelope, verbatim. */
export interface MailboxDepositRequest {
  /** Recipient's 33-byte compressed chain pubkey (hex) — §6 addressing. */
  recipientPubkey: string;
  /** Content-addressed blob-store key of the already-uploaded blob (§5.2). */
  key: string;
  /** The send's transferId — §5.3 evidence lookup uses the STORED value. */
  transferId: string;
  /** Claimed final state hash — `hex(SHA-256(inner token bytes))`. */
  stateHash: string;
  /** Claimed genesis-stable token id. */
  tokenId: string;
  /** Optional S6-encrypted memo envelope. */
  memo?: string;
}

export type MailboxEntryStatus = 'unclaimed' | 'claimed' | 'rejected'; // §11/§16 wire values

/** One `GET /v1/mailbox` entry (§16). */
export interface MailboxEntry {
  /** Content-derived entry id — `hex(SHA-256(tokenId ‖ stateHash))` (§6). */
  entryId: string;
  /** Per-recipient gap-free, commit-ordered seq (§9). */
  seq: bigint;
  status: MailboxEntryStatus;
  transferId: string;
  tokenId: string;
  /** Decoded value of the deposited blob (per §8.2 step 6). */
  assets: { coinId: string; amount: bigint }[];
  senderPubkey: string;
  /** S6 `enc1.` envelope, verbatim (the server never sees plaintext). */
  memo?: string;
  createdAt: number;
  /** Signed GET for the blob — present while the blob is retained (§6). */
  getUrl?: string;
  /** True once the blob was garbage-collected after resolution (§6). */
  blobCollected?: boolean;
}

/** `GET /v1/mailbox?since=` page (§16). */
export interface MailboxPage {
  /** Highest contiguous resolved seq — the discovery cursor (§6). */
  readPointer: bigint;
  syncEpoch: bigint;
  more: boolean;
  entries: MailboxEntry[];
}

/** `POST /v1/mailbox/claim` result (§16). */
export interface MailboxClaimResult {
  claimed: string[];
  /** Already-claimed entries with their STORED disposition (§6). */
  alreadyClaimed: { entryId: string; intoInventory: boolean }[];
  /** Defensive bucket — an entry that would now violate lineage (§5.3). */
  failed: { entryId: string; code: string }[];
}

// ── history (§10/§16) ─────────────────────────────────────────────────────────

/**
 * One client-asserted history record (§10 — the server never writes history).
 * `memo` and `counterpartyNametag` are S6 `enc1.` envelopes, verbatim (§8.3).
 */
export interface HistoryWireRecord {
  /** Client dedup key — POST is idempotent by it. */
  dedupKey: string;
  type: string;
  timestamp: number;
  /** Decimal-string amounts (§11). */
  assets: { coinId: string; amount: string }[];
  transferId?: string;
  tokenId?: string;
  counterpartyPubkey?: string;
  /** S6 envelope. */
  memo?: string;
  /** S6 envelope. */
  counterpartyNametag?: string;
}

/** `GET /v1/history` page (§16): newest-first, opaque keyset cursor. */
export interface HistoryPage {
  records: HistoryWireRecord[];
  /** Pass as `before` to fetch the next (older) page; absent when drained. */
  nextBefore?: string;
}

/** WS wake nudge (§9): pull that stream's cursor; never a correctness dependency. */
export interface WakeEvent {
  stream: 'inventory' | 'mailbox' | 'payment_requests';
  syncEpoch: bigint;
}

export type WakeCallback = (wake: WakeEvent) => void;

/** Handle returned by the wake-socket connect. */
export interface WakeSocketHandle {
  close(): void;
}
