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

/**
 * Minimal response-header accessor — native `fetch` `Response.headers` satisfies
 * it. `get` MUST be case-insensitive, as native `Headers` is: the client looks
 * `Retry-After` up in lowercase, so a case-sensitive test double would silently
 * miss it.
 */
export interface HeadersLike {
  get(name: string): string | null;
}

export interface FetchResponseLike {
  status: number;
  ok: boolean;
  /**
   * Optional response headers. Native `fetch` supplies them; test doubles may
   * omit. Read to honor `Retry-After` on a `429`/`503` (ARCHITECTURE §16) — when
   * absent, the client falls back to its own computed backoff.
   */
  headers?: HeadersLike;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Minimal WebSocket surface (browser WebSocket and the `ws` package both satisfy it). */
export interface WebSocketLike {
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onclose: ((ev?: { code?: number; reason?: string }) => void) | null;
  /**
   * Protocol-level ping/pong observers (the `ws` package fires `'ping'`/`'pong'`
   * events; browsers auto-pong silently and surface neither). Optional — the
   * liveness watchdog (§9) treats any of ping/pong/message as a sign of life and
   * never depends on these being present. Assigned via the optional setters
   * below so the minimal browser surface still satisfies the type.
   */
  onPing?: ((ev?: unknown) => void) | null;
  onPong?: ((ev?: unknown) => void) | null;
  close(code?: number, reason?: string): void;
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
  /**
   * Transient-failure retry policy for the §16 REST path (default-on). Pass
   * `false` to disable (a single attempt). See {@link WalletApiRetryConfig}.
   */
  retry?: WalletApiRetryConfig | false;
}

/**
 * Retry policy for transient REST failures (S1). Every field defaults when
 * omitted; the classes of retry differ by safety:
 * - a transient `NETWORK` failure (dropped/reset connection, DNS blip) is
 *   retried on **idempotent GETs only** — a lost-response retry of a write could
 *   double-apply;
 * - an HTTP **429** is retried on **any** method — a 429 is rejected *before*
 *   execution (the write never ran), so re-issuing is safe — honoring the
 *   server's `Retry-After`;
 * - an HTTP **503** is retried on **GETs only** (a write may have started).
 */
export interface WalletApiRetryConfig {
  /** Total attempts including the first (default 3). */
  maxAttempts?: number;
  /** Base delay in ms for the exponential schedule (default 200). */
  baseMs?: number;
  /** Backoff ceiling in ms (default 10_000). */
  capMs?: number;
  /** Full jitter (default) spreads retries across clients; `'none'` is deterministic. */
  jitter?: 'full' | 'none';
  /** Honor a server `Retry-After` on 429/503 (default true). */
  honorRetryAfter?: boolean;
  /** Ceiling in ms for an honored `Retry-After` (default 60_000). */
  maxRetryAfterMs?: number;
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
  /** Client-generated record id (UUID — §16). */
  id: string;
  /** §16 enum: 'SENT' | 'RECEIVED' | 'MINT'. */
  type: string;
  /** ISO-8601 timestamp with offset (§16 `ts`). */
  ts: string;
  /** Decimal-string amounts (§11). */
  assets: { coinId: string; amount: string }[];
  transferId?: string;
  /** Genesis-stable token id, lowercase hex (§16 — never a `v2_…` UI id). */
  tokenId?: string;
  /** 33-byte compressed secp256k1 pubkey, lowercase hex (§16). */
  counterpartyPubkey?: string;
  /** S6 envelope. */
  memo?: string;
  /** S6 envelope. */
  counterpartyNametag?: string;
}

/** `GET /v1/history` page (§16): newest-first, opaque keyset cursor. */
export interface HistoryPage {
  records: HistoryWireRecord[];
  more: boolean;
  /** Pass as `before` for the next (older) page; null on the last page (§16). */
  cursor: string | null;
  syncEpoch: bigint;
}

// ── payment requests (§10/§16) ────────────────────────────────────────────────

export type PaymentRequestWireStatus = 'open' | 'paid' | 'declined' | 'expired'; // §11/§16 wire values

/**
 * One §16 payment request. `memo` is the S6 `enc1.` envelope, verbatim — it
 * decrypts only under the REQUESTER's wallet key (S6 keys are wallet-scoped),
 * so the payer surfaces it as absent, never as ciphertext.
 */
export interface PaymentRequestRecord {
  id: string;
  /** Per-payer gap-free, commit-ordered seq (§9/§10) — the incoming cursor unit. */
  seq: bigint;
  fromPubkey: string;
  toPubkey: string;
  assets: { coinId: string; amount: bigint }[];
  /** S6 `enc1.` envelope, verbatim (the server never sees plaintext — §8.3). */
  memo?: string;
  status: PaymentRequestWireStatus;
  /** The fulfilling send's transferId once paid; null otherwise (§16). */
  transferId: string | null;
  createdAt: number;
  /** Server-owned expiry (§10) — the sweep flips overdue requests, never the client. */
  expiresAt?: number;
}

/** `POST /v1/payment-requests` request (§16). */
export interface CreatePaymentRequestInput {
  /** The payer's 33-byte compressed chain pubkey (lowercase hex) — §10 addressing. */
  toPubkey: string;
  assets: { coinId: string; amount: bigint }[];
  /** S6 `enc1.` envelope — encrypt client-side BEFORE calling (§8.3). */
  memo?: string;
  /** ms since epoch — sent as ISO-8601 (§16). */
  expiresAt?: number;
}

/**
 * `GET /v1/payment-requests` query (§16). The two role views carry DIFFERENT
 * cursor families that never mix (the server 422s a mismatch): incoming is
 * the payer's gap-free `?since=<seq>` stream; outgoing is the requester's
 * newest-first `?before=<opaque keyset>` backfill.
 */
export type ListPaymentRequestsParams =
  | { role: 'incoming'; status?: PaymentRequestWireStatus; since?: bigint }
  | { role: 'outgoing'; status?: PaymentRequestWireStatus; before?: string };

/** `GET /v1/payment-requests` page (§16), discriminated by the requested role. */
export type PaymentRequestsPage =
  | {
      role: 'incoming';
      requests: PaymentRequestRecord[];
      more: boolean;
      /** The §16 `?since=` seq cursor (gap-free — §9). */
      cursor: bigint;
      syncEpoch: bigint;
    }
  | {
      role: 'outgoing';
      requests: PaymentRequestRecord[];
      more: boolean;
      /** Opaque keyset for the next (older) page; null when drained (§16). */
      cursor: string | null;
      syncEpoch: bigint;
    };

/**
 * `POST /v1/payment-requests/{id}/respond` body (§16): `paid` REQUIRES the
 * fulfilling send's transferId, `declined` forbids it — the pairing is in the
 * type, mirroring the server's validation.
 */
export type RespondPaymentRequestInput =
  | { action: 'paid'; transferId: string }
  | { action: 'declined' };

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

/**
 * True liveness of the supervised wake socket (§9), decoupled from sign-in
 * session state: `connected` — a socket is open and receiving; `reconnecting`
 * — the socket dropped and the supervisor is backing off to re-establish it
 * (the poll backstop carries correctness meanwhile); `closed` — torn down
 * intentionally (`destroy`/logout), no further reconnects.
 */
export type WakeSocketStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed';

/**
 * Options for {@link WalletApiClient.superviseWakeSocket} — the self-healing
 * wake channel (§9). The socket re-mints a fresh ticket and reconnects with
 * bounded backoff + jitter on every drop, and a client-side liveness watchdog
 * forces a reconnect on a half-open socket (no pings/frames for 2× the server
 * heartbeat). Wakes missed while the socket was dead are NOT replayed by the
 * server (best-effort Redis pub/sub) — so `onReconnect` runs a full catch-up
 * pull of every stream on each (re)connect: that pull is what guarantees
 * convergence (correctness is the pull; the wake is only a nudge).
 */
export interface SuperviseWakeOptions {
  /** A wake nudge arrived — pull that stream's cursor. */
  onWake: WakeCallback;
  /**
   * Run once on every (re)connect: a full catch-up pull of ALL streams, since
   * wakes missed during the dead window are gone. The supervisor awaits
   * nothing — failures here are the caller's to log; the poll backstop covers
   * a failed catch-up.
   */
  onReconnect?: () => void;
  /** True socket liveness changed — surface it to the frontend (§9). */
  onStatus?: (status: WakeSocketStatus) => void;
}

/** Handle returned by {@link WalletApiClient.superviseWakeSocket}. */
export interface SupervisedWakeSocketHandle {
  /** Tear down: stop the watchdog, cancel any pending reconnect, close the live socket. Idempotent. */
  close(): void;
  /** Current true liveness (§9). */
  readonly status: WakeSocketStatus;
}
