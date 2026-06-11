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
