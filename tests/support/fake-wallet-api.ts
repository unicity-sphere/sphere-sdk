/**
 * tests/support/fake-wallet-api.ts — in-process fake of the wallet-api
 * backend (the §16 subset used by S1/S2).
 *
 * EVERY behavior cites its ARCHITECTURE.md section in a comment — this fake is
 * contract documentation; drift between it and the spec is a bug. Where the
 * fake deliberately simplifies (no real SDK `token.verify`, no mailbox yet —
 * that arrives with S3), the simplification is called out inline as
 * "APPROXIMATION".
 *
 * Implemented surface:
 *   - auth: challenge/verify/refresh/logout (§4) — challenge prefix, refresh
 *     rotation wire form `v1.<sessionId>.<secretHex>`, rotation-reuse
 *     revocation;
 *   - inventory: tombstones/seq/PAGE_LIMIT/more/syncEpoch (§5.1, §16);
 *   - blob-urls / upload-urls + signed GET/PUT serving from memory (§5.2);
 *   - inventory/apply: idempotency, added-blob validation, lineage,
 *     evidence-marked tombstones (§5.3);
 *   - intents: write-once / abort / complete semantics (§16);
 *   - mailbox (§6/§16): deposit validation + content-derived entry_id
 *     idempotency (recipient/key mismatch 409), unclaimed + per-pair caps
 *     (429), claim ownership handoff with alreadyClaimed dispositions /
 *     intoInventory variants / the asymmetric false→true upgrade / the
 *     defensive failed bucket, reject-stays-claimable, read pointer,
 *     blobCollected retention signalling (`collectMailboxBlob()` test hook);
 *   - history (§10/§16): client-asserted, dedupKey-idempotent POST + keyset
 *     GET (the server never writes history rows);
 *   - payment requests (§10/§16 — backend M4): create with per-payer gap-free
 *     seq + payer auto-provisioning + the §5.5 open cap (429 QUOTA_EXCEEDED),
 *     the incoming ?since= stream / outgoing ?before= keyset backfill (role ×
 *     cursor mixing → 422), addressee-only respond (403/404/409/422 exactly
 *     as wallet-api src/payments/*), `expireDuePaymentRequests()` test hook
 *     for the server-owned expiry sweep;
 *   - ws-ticket + WS wake nudges (§9);
 *   - `bumpSyncEpoch()` test hook (§5.4 restore semantics).
 */

import * as http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { recoverPubkeyFromSignature } from '../../core/crypto';
import { decodeTokenBlob } from '../../token-engine/token-blob';
import { AUTH_CHALLENGE_PREFIX } from '../../wallet-api/challenge';
import { assertFieldEnvelopeShape } from '../../core/field-encryption';

// =============================================================================
// Types
// =============================================================================

export interface FakeAsset {
  coinId: string;
  amount: bigint;
}

interface InventoryRow {
  tokenId: string;
  status: 'active' | 'removed';
  s3Key: string;
  /** hex(SHA-256(inner token bytes)) — the per-state hash convention. */
  stateHash: string;
  /** Asset rows exist only while active — balances drop at the spend (§5.3 step 4). */
  assets: FakeAsset[] | null;
  seq: bigint;
  /** §5.3 step 3 evidence verdict for tombstones. */
  removal?: 'evidenced' | 'unevidenced' | 'external';
}

/** One mailbox entry (§6): append-only per recipient, content-derived id. */
interface MailboxEntryRow {
  /** `hex(SHA-256(tokenId bytes ‖ stateHash bytes))` (§6). */
  entryId: string;
  /** Per-recipient monotonic, gap-free seq (§6/§9). */
  seq: bigint;
  status: 'unclaimed' | 'claimed' | 'rejected';
  recipientPubkey: string;
  senderPubkey: string;
  transferId: string;
  tokenId: string;
  stateHash: string;
  /** Content-addressed blob key (§5.2) — claim takes `state_hash`/assets from the entry. */
  s3Key: string;
  assets: FakeAsset[];
  /** S6 `enc1.` envelope, stored verbatim (§8.3) — the server never sees plaintext. */
  memo?: string;
  createdAt: string;
  /** Stored claim disposition — reported in alreadyClaimed (§6). */
  claimedIntoInventory?: boolean;
  /** §5.4/§6: blob garbage-collected after the post-resolution retention window. */
  blobCollected: boolean;
}

/** One payment request (§10/§11), stored under the PAYER (to_owner) like the table's seq index. */
interface PaymentRequestRow {
  id: string;
  fromPubkey: string;
  toPubkey: string;
  /** Per-payer gap-free, commit-ordered seq (§9/§10) — assigned from the payer's counter. */
  seq: bigint;
  assets: FakeAsset[];
  /** S6 `enc1.` envelope, stored verbatim (§8.3) — the server never sees plaintext. */
  memo?: string;
  status: 'open' | 'paid' | 'declined' | 'expired';
  /** The fulfilling send's transferId once paid (§16). */
  transferId: string | null;
  createdAt: string;
  /** Server-owned expiry (§10): an already-past value is legal — the sweep flips it. */
  expiresAt: string | null;
}

interface OwnerState {
  cursor: bigint; // gap-free, commit-ordered per-owner counter (§9)
  rows: Map<string, InventoryRow>; // one row per (owner, token) (§5.1)
  appliedTransfers: Map<string, bigint>; // §5.3 step 1 idempotency record
  intents: Map<string, { payload: string; status: 'open' | 'completed' | 'aborted'; createdAt: string }>;
  /** Mailbox entries ADDRESSED TO this owner (§6), keyed by entry_id. */
  mailbox: Map<string, MailboxEntryRow>;
  /** Per-recipient monotonic mailbox seq counter (§6) — separate from `cursor`. */
  mailboxSeq: bigint;
  /** Highest contiguous resolved (claimed|rejected) seq — the discovery cursor (§6). */
  readPointer: bigint;
  /** Client-asserted history records by dedupKey (§10) in arrival order. */
  history: Map<string, Record<string, unknown>>;
  /** Payment requests ADDRESSED TO this owner (§10), keyed by id. */
  paymentRequests: Map<string, PaymentRequestRow>;
  /** The payer's gap-free payment-request seq counter (next_pr_seq — §9/§11). */
  prSeq: bigint;
}

interface Session {
  sessionId: string;
  pubkey: string;
  deviceId: string;
  jwt: string;
  jwtExpiresAt: number;
  refreshHash: string; // SHA-256 of the current secret — never the secret (§4)
  refreshExpiresAt: number;
  revoked: boolean;
  /** Rotated-away hashes — presenting one is theft (reuse detection, §4). */
  staleRefreshHashes: Set<string>;
}

interface SignedUrl {
  key: string;
  method: 'GET' | 'PUT';
  expiresAt: number;
  /** PUT only: the pinned checksum + length (§5.2). */
  sha256?: string;
  size?: number;
}

export interface FakeWalletApiOptions {
  network?: string;
  /** PAGE_LIMIT (§14): cap on ?since= list responses. */
  pageLimit?: number;
  jwtTtlMs?: number; // JWT_TTL (§14), default 15 min
  nonceTtlMs?: number; // NONCE_TTL (§14), default 5 min
  wsTicketTtlMs?: number; // WS_TICKET_TTL (§14), default 30 s
  maxBlobBytes?: number; // MAX_BLOB_BYTES (§14), default 16 MiB
  intentMaxBytes?: number; // intent payload cap (§7), default 4 KiB
  /** Per-recipient unclaimed+rejected cap (§5.5), default 10000 (MAX_RECIPIENT_ENTRIES). */
  mailboxUnclaimedCap?: number;
  /** Per-(sender, recipient) sub-cap (§5.5), default 500 (MAX_SENDER_RECIPIENT_ENTRIES). */
  mailboxPerPairCap?: number;
  /** Per-payer OPEN payment-request cap (§5.5/§10), default 1000 (MAX_PAYER_OPEN_REQUESTS). */
  maxPayerOpenRequests?: number;
  /**
   * APPROXIMATION of §8.2 steps 3–6: the real backend CBOR-decodes the v2
   * token, runs `token.verify` against the pinned trustbase and decodes the
   * value with the SpherePaymentData codec. This fake cannot run the SDK
   * pipeline, so the inner-token decode is an injected port; the default
   * reads a JSON `{ assets: [{ coinId, amount }] }` payload (the synthetic
   * token format used by the contract tests). Returning null = validation
   * failure (422).
   */
  decodeAssets?: (tokenBytes: Uint8Array) => FakeAsset[] | null;
  /**
   * §8.2 step-4 stand-in for RAW wire bytes: the wallet-api wire carries the
   * INNER token bytes (§5.2 — never the 39051 envelope), so the fake needs an
   * injected way to read the genesis-stable tokenId out of them (the real
   * server decodes the v2 token). The default reads the synthetic JSON
   * `{ tokenId }` payload; envelope bytes (legacy seeds) keep working via the
   * envelope's own field. Returning null = validation failure (422).
   */
  decodeTokenId?: (tokenBytes: Uint8Array) => string | null;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hexStr: string): Uint8Array {
  const out = new Uint8Array(hexStr.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hexStr.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function defaultDecodeAssets(tokenBytes: Uint8Array): FakeAsset[] | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(tokenBytes)) as {
      assets?: { coinId?: unknown; amount?: unknown }[];
    };
    if (!Array.isArray(parsed.assets)) return null;
    const assets: FakeAsset[] = [];
    for (const a of parsed.assets) {
      if (typeof a.coinId !== 'string' || typeof a.amount !== 'string' || !/^[0-9]+$/.test(a.amount)) {
        return null;
      }
      assets.push({ coinId: a.coinId, amount: BigInt(a.amount) });
    }
    return assets;
  } catch {
    return null;
  }
}

/** Default raw-bytes tokenId reader: the synthetic JSON `{ tokenId }` payload. */
function defaultDecodeTokenId(tokenBytes: Uint8Array): string | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(tokenBytes)) as { tokenId?: unknown };
    return typeof parsed.tokenId === 'string' ? parsed.tokenId : null;
  } catch {
    return null;
  }
}

/** Route-level uuid validation (payment-request ids + transferIds — §16). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

// =============================================================================
// The fake server
// =============================================================================

export class FakeWalletApi {
  readonly network: string;
  private readonly pageLimit: number;
  private readonly jwtTtlMs: number;
  private readonly nonceTtlMs: number;
  private readonly wsTicketTtlMs: number;
  private readonly maxBlobBytes: number;
  private readonly intentMaxBytes: number;
  private readonly mailboxUnclaimedCap: number;
  private readonly mailboxPerPairCap: number;
  private readonly maxPayerOpenRequests: number;
  private readonly decodeAssets: (tokenBytes: Uint8Array) => FakeAsset[] | null;
  private readonly decodeTokenId: (tokenBytes: Uint8Array) => string | null;

  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private baseUrl = '';

  /** Server-wide sync epoch — bumped ONLY by a restore (§5.4). */
  private syncEpoch = 1n;
  private readonly owners = new Map<string, OwnerState>(); // by pubkey
  /** Content-addressed blob store: key = `<network>/t/<sha256>` (§5.2). */
  readonly blobStore = new Map<string, Uint8Array>();
  private readonly nonces = new Map<string, { pubkey: string; challenge: string; expiresAt: number }>();
  private readonly sessions = new Map<string, Session>(); // by sessionId
  private readonly signedUrls = new Map<string, SignedUrl>(); // by sig token
  private readonly wsTickets = new Map<string, { pubkey: string; sessionId: string; expiresAt: number }>();
  private readonly socketsByOwner = new Map<string, Set<WebSocket>>();

  // ── test hooks / counters ────────────────────────────────────────────────────
  challengeRequests = 0;
  verifyRequests = 0;
  refreshRequests = 0;
  /**
   * Every `GET /v1/inventory` `since` param in arrival order (`null` = a
   * since-less full-pull page). Lets tests pin the full-pull/delta sequence
   * (#521: first sync of a session is a full pull, deltas resume after).
   */
  readonly inventoryGetLog: (string | null)[] = [];
  private tamperChallenge: ((challenge: string) => string) | null = null;
  private failInventory = false;
  private failIntents = false;

  constructor(options: FakeWalletApiOptions = {}) {
    this.network = options.network ?? 'testnet2';
    this.pageLimit = options.pageLimit ?? 1000; // PAGE_LIMIT default (§14)
    this.jwtTtlMs = options.jwtTtlMs ?? 15 * 60 * 1000; // JWT_TTL (§14)
    this.nonceTtlMs = options.nonceTtlMs ?? 5 * 60 * 1000; // NONCE_TTL (§14)
    this.wsTicketTtlMs = options.wsTicketTtlMs ?? 30 * 1000; // WS_TICKET_TTL (§14)
    this.maxBlobBytes = options.maxBlobBytes ?? 16 * 1024 * 1024; // MAX_BLOB_BYTES (§14)
    this.intentMaxBytes = options.intentMaxBytes ?? 4096; // intent payload ≤ 4 KiB (§7)
    this.mailboxUnclaimedCap = options.mailboxUnclaimedCap ?? 10000; // per-recipient unclaimed cap (§5.5)
    this.mailboxPerPairCap = options.mailboxPerPairCap ?? 500; // per-sender-pair sub-cap (§5.5 MAX_SENDER_RECIPIENT_ENTRIES)
    this.maxPayerOpenRequests = options.maxPayerOpenRequests ?? 1000; // MAX_PAYER_OPEN_REQUESTS (§14)
    this.decodeAssets = options.decodeAssets ?? defaultDecodeAssets;
    this.decodeTokenId = options.decodeTokenId ?? defaultDecodeTokenId;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address() as { port: number };
    // Loopback plain HTTP is the sanctioned test-harness exception to the
    // TLS-only transport rule (§4: REQUIRE_TLS=false only for local dev/§18 harnesses).
    this.baseUrl = `http://127.0.0.1:${addr.port}`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    for (const sockets of this.socketsByOwner.values()) {
      for (const ws of sockets) ws.close();
    }
    this.wss?.close();
    await new Promise<void>((resolve, reject) =>
      this.server ? this.server.close((err) => (err ? reject(err) : resolve())) : resolve()
    );
    this.server = null;
  }

  // ── test hooks ───────────────────────────────────────────────────────────────

  /**
   * §5.4 restore semantics: a restore rewinds per-owner counters, so the
   * restore procedure MUST bump the server-wide sync epoch; clients that see
   * it change discard cursors, full-pull, and re-PUT locally-held open
   * intents — intents are the one table not re-derivable from blobs, which is
   * why `dropIntents` simulates losing them in the restore.
   */
  bumpSyncEpoch(opts: { dropIntents?: boolean } = {}): void {
    this.syncEpoch += 1n;
    if (opts.dropIntents) {
      for (const owner of this.owners.values()) owner.intents.clear();
    }
  }

  /** Make the next auth challenge malformed — the client MUST refuse to sign it. */
  tamperNextChallenge(fn: (challenge: string) => string): void {
    this.tamperChallenge = fn;
  }

  /** Simulate an inventory outage (a failed load — §5.1 client-guard tests). */
  setInventoryFailure(fail: boolean): void {
    this.failInventory = fail;
  }

  /** Simulate an intent-endpoint outage (E.3 local-backstop tests). */
  setIntentFailure(fail: boolean): void {
    this.failIntents = fail;
  }

  /** Force-expire all access tokens (drives the 401 → refresh path). */
  expireAccessTokens(): void {
    for (const s of this.sessions.values()) s.jwtExpiresAt = 0;
  }

  /** Direct row insertion for client-level tests (bypasses §8.2 — test seam only). */
  seedInventory(pubkey: string, tokens: { tokenId: string; assets: FakeAsset[]; blob?: Uint8Array }[]): void {
    const owner = this.owner(pubkey);
    for (const t of tokens) {
      const blobBytes = t.blob ?? new Uint8Array();
      const key = `${this.network}/t/${hex(sha256(blobBytes))}`;
      if (t.blob) this.blobStore.set(key, t.blob);
      owner.cursor += 1n;
      owner.rows.set(t.tokenId, {
        tokenId: t.tokenId,
        status: 'active',
        s3Key: key,
        stateHash: t.blob ? hex(sha256(this.resolveBlob(t.blob).inner)) : '',
        assets: t.assets,
        seq: owner.cursor,
      });
    }
  }

  /**
   * Tolerant §8.2 step-3 stand-in: wire bytes are the INNER token bytes
   * (§5.2); envelope bytes (older seeds/uploads) unwrap. Returns the decoded
   * tokenId (envelope field, else the injected raw decoder) and the inner
   * bytes the value/state-hash derivations run over.
   */
  private resolveBlob(bytes: Uint8Array): { tokenId: string | null; inner: Uint8Array } {
    try {
      const blob = decodeTokenBlob(bytes);
      return { tokenId: blob.tokenId, inner: blob.token };
    } catch {
      return { tokenId: this.decodeTokenId(bytes), inner: bytes };
    }
  }

  getRow(pubkey: string, tokenId: string): { status: string; removal?: string } | null {
    const row = this.owner(pubkey).rows.get(tokenId);
    return row ? { status: row.status, removal: row.removal } : null;
  }

  /** Number of live wake sockets subscribed to this owner (§9 — test seam). */
  socketCount(pubkey: string): number {
    return this.socketsByOwner.get(pubkey)?.size ?? 0;
  }

  getIntent(pubkey: string, transferId: string): { payload: string; status: string } | null {
    const intent = this.owner(pubkey).intents.get(transferId);
    return intent ? { payload: intent.payload, status: intent.status } : null;
  }

  /** All mailbox entries addressed to a recipient (test inspection). */
  listMailboxEntries(
    recipientPubkey: string
  ): { entryId: string; status: string; transferId: string; tokenId: string; senderPubkey: string }[] {
    return [...this.owner(recipientPubkey).mailbox.values()].map((e) => ({
      entryId: e.entryId,
      status: e.status,
      transferId: e.transferId,
      tokenId: e.tokenId,
      senderPubkey: e.senderPubkey,
    }));
  }

  /** Mailbox entry inspection for tests (status + stored claim disposition). */
  getMailboxEntry(
    recipientPubkey: string,
    entryId: string
  ): { status: string; intoInventory?: boolean; transferId: string; memo?: string } | null {
    const entry = this.owner(recipientPubkey).mailbox.get(entryId);
    if (!entry) return null;
    return {
      status: entry.status,
      ...(entry.claimedIntoInventory !== undefined ? { intoInventory: entry.claimedIntoInventory } : {}),
      transferId: entry.transferId,
      ...(entry.memo !== undefined ? { memo: entry.memo } : {}),
    };
  }

  /**
   * §5.4/§6 retention test hook: simulate the post-resolution GC collecting a
   * resolved entry's blob — the list then serves `blobCollected: true` instead
   * of a `getUrl`. (The blob store itself is content-addressed and may still
   * back inventory rows; only the ENTRY's availability flag flips.)
   */
  collectMailboxBlob(recipientPubkey: string, entryId: string): void {
    const entry = this.owner(recipientPubkey).mailbox.get(entryId);
    if (entry) entry.blobCollected = true;
  }

  /**
   * HOSTILE-BACKEND test hook (no §-citation — this is deliberately
   * contract-violating behavior): flip a resolved entry back to `pending`,
   * simulating a restored/buggy/malicious backend replaying an
   * already-resolved delivery. The S7 port contract requires the CLIENT's
   * persistent (tokenId, stateHash) seen-set to reject it — the recipient
   * never trusts the backend (ARCHITECTURE §8.2).
   */
  tamperMailboxEntryToPending(recipientPubkey: string, entryId: string): void {
    const recipient = this.owner(recipientPubkey);
    const entry = recipient.mailbox.get(entryId);
    if (entry) {
      entry.status = 'unclaimed';
      entry.claimedIntoInventory = undefined;
      recipient.readPointer = 0n;
    }
  }

  /**
   * Test hook for the §6 dedup-mismatch path: rewrite a stored entry's s3 key,
   * simulating an original deposit whose BYTES differed from what a later
   * re-deliver of the same (tokenId, stateHash) carries. The real-world cause
   * is proof-bytes instability across fetches (st-sdk#126: the aggregator
   * recomputes inclusion proofs, so a resume's rebuilt blob keys differently)
   * — the server then answers 409 CONFLICT, which the S7 deliver contract
   * absorbs as idempotent success (found by the S5 live e2e, 2026-06-12).
   */
  tamperMailboxEntryKey(recipientPubkey: string, entryId: string): void {
    const entry = this.owner(recipientPubkey).mailbox.get(entryId);
    if (entry) entry.s3Key = `${entry.s3Key}-proof-variant`;
  }

  /** Server-side history inspection for tests (§10). */
  getHistoryRecords(pubkey: string): Record<string, unknown>[] {
    return [...this.owner(pubkey).history.values()];
  }

  /** Payment-request row inspection for tests (§10) — looked up across all payers. */
  getPaymentRequest(
    id: string
  ): { status: string; transferId: string | null; seq: number; memo?: string; fromPubkey: string; toPubkey: string } | null {
    const row = this.findPaymentRequest(id);
    if (!row) return null;
    return {
      status: row.status,
      transferId: row.transferId,
      seq: Number(row.seq),
      ...(row.memo !== undefined ? { memo: row.memo } : {}),
      fromPubkey: row.fromPubkey,
      toPubkey: row.toPubkey,
    };
  }

  /**
   * §10 server-owned expiry test hook (mirrors workers/pr-expiry.ts): flip
   * every overdue OPEN request to 'expired' atomically and nudge both
   * parties on the payment_requests stream. Expiry is never client-inferred.
   */
  expireDuePaymentRequests(now: number = Date.now()): number {
    let flipped = 0;
    for (const state of this.owners.values()) {
      for (const row of state.paymentRequests.values()) {
        if (row.status !== 'open' || row.expiresAt === null || Date.parse(row.expiresAt) > now) continue;
        row.status = 'expired';
        // §16: re-stamp seq so the expired row re-surfaces in the payer's incoming ?since= delta
        state.prSeq += 1n;
        row.seq = state.prSeq;
        this.wakeOwner(row.toPubkey, 'payment_requests');
        this.wakeOwner(row.fromPubkey, 'payment_requests');
        flipped++;
      }
    }
    return flipped;
  }

  isSessionRevoked(pubkey: string, deviceId: string): boolean {
    for (const s of this.sessions.values()) {
      if (s.pubkey === pubkey && s.deviceId === deviceId) return s.revoked;
    }
    return false;
  }

  // ── owner state ──────────────────────────────────────────────────────────────

  /** Accounts are auto-provisioned on first touch (§4/§9). */
  private owner(pubkey: string): OwnerState {
    let state = this.owners.get(pubkey);
    if (!state) {
      state = {
        cursor: 0n,
        rows: new Map(),
        appliedTransfers: new Map(),
        intents: new Map(),
        mailbox: new Map(),
        mailboxSeq: 0n,
        readPointer: 0n,
        history: new Map(),
        paymentRequests: new Map(),
        prSeq: 0n,
      };
      this.owners.set(pubkey, state);
    }
    return state;
  }

  // ── HTTP plumbing ────────────────────────────────────────────────────────────

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      await this.route(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        // Error wire shape: { error: { code, message } } (§16).
        this.json(res, err.status, { error: { code: err.code, message: err.message } });
      } else {
        this.json(res, 500, { error: { code: 'INTERNAL', message: String(err) } });
      }
    }
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body === null ? '' : JSON.stringify(body));
  }

  private async readBody(req: http.IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  private async readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const raw = (await this.readBody(req)).toString('utf8');
    try {
      const parsed: unknown = raw === '' ? {} : JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
      return parsed as Record<string, unknown>;
    } catch {
      throw new HttpError(422, 'VALIDATION', 'request body is not a JSON object');
    }
  }

  /** Bearer-JWT auth on every endpoint except challenge/verify (§16). */
  private authenticate(req: http.IncomingMessage): Session {
    const header = req.headers['authorization'];
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new HttpError(401, 'UNAUTHORIZED', 'missing bearer token');
    for (const session of this.sessions.values()) {
      if (session.jwt === token) {
        if (session.revoked) throw new HttpError(401, 'UNAUTHORIZED', 'session revoked'); // §4 revocation
        if (session.jwtExpiresAt <= Date.now()) throw new HttpError(401, 'UNAUTHORIZED', 'token expired'); // JWT_TTL (§4)
        return session;
      }
    }
    throw new HttpError(401, 'UNAUTHORIZED', 'unknown token');
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.baseUrl);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // Signed blob URLs — the URL itself is the credential (§5.2), no JWT.
    if (path.startsWith('/v1/_blob/')) return this.handleSignedBlob(req, res, url);

    if (method === 'POST' && path === '/v1/auth/challenge') return this.handleChallenge(req, res);
    if (method === 'POST' && path === '/v1/auth/verify') return this.handleVerify(req, res);
    if (method === 'POST' && path === '/v1/auth/refresh') return this.handleRefresh(req, res);
    if (method === 'POST' && path === '/v1/auth/logout') return this.handleLogout(req, res);

    if (method === 'GET' && path === '/v1/inventory') return this.handleInventory(req, res, url);
    if (method === 'GET' && path === '/v1/balances') return this.handleBalances(req, res);
    if (method === 'POST' && path === '/v1/tokens/blob-urls') return this.handleBlobUrls(req, res);
    if (method === 'POST' && path === '/v1/tokens/upload-urls') return this.handleUploadUrls(req, res);
    if (method === 'POST' && path === '/v1/inventory/apply') return this.handleApply(req, res);

    if (method === 'POST' && path === '/v1/mailbox') return this.handleMailboxDeposit(req, res);
    if (method === 'GET' && path === '/v1/mailbox') return this.handleMailboxList(req, res, url);
    if (method === 'POST' && path === '/v1/mailbox/claim') return this.handleMailboxClaim(req, res);
    if (method === 'POST' && path === '/v1/mailbox/reject') return this.handleMailboxReject(req, res);

    if (method === 'POST' && path === '/v1/history') return this.handleHistoryPost(req, res);
    if (method === 'GET' && path === '/v1/history') return this.handleHistoryGet(req, res, url);

    if (method === 'POST' && path === '/v1/payment-requests') return this.handlePaymentRequestCreate(req, res);
    if (method === 'GET' && path === '/v1/payment-requests') return this.handlePaymentRequestList(req, res, url);
    const respondMatch = path.match(/^\/v1\/payment-requests\/([^/]+)\/respond$/);
    if (method === 'POST' && respondMatch) return this.handlePaymentRequestRespond(req, res, respondMatch[1]);

    const intentMatch = path.match(/^\/v1\/intents\/([^/]+)(\/(abort|complete))?$/);
    if (intentMatch) return this.handleIntent(req, res, intentMatch[1], intentMatch[3]);
    if (method === 'GET' && path === '/v1/intents') return this.handleListIntents(req, res, url);

    if (method === 'POST' && path === '/v1/ws-ticket') return this.handleWsTicket(req, res);

    throw new HttpError(404, 'NOT_FOUND', `no route for ${method} ${path}`);
  }

  // ── auth (§4) ────────────────────────────────────────────────────────────────

  private async handleChallenge(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.challengeRequests++;
    const body = await this.readJsonBody(req);
    const pubkey = body.pubkey;
    if (typeof pubkey !== 'string' || !/^0[23][0-9a-f]{64}$/i.test(pubkey)) {
      throw new HttpError(422, 'VALIDATION', 'pubkey must be a 33-byte compressed secp256k1 key (hex)');
    }
    const now = Date.now();
    const nonce = hex(randomBytes(16));
    const expiresAt = now + this.nonceTtlMs; // NONCE_TTL (§14)
    // §4 step 1: a human-readable challenge beginning with the fixed
    // domain-separation prefix and embedding { network, pubkey, nonce,
    // issuedAt, expiresAt } — the spend key never signs unprefixed text.
    // §4: prefix + single-line JSON — byte-for-byte the real backend's grammar
    // (wallet-api src/auth/service.ts issueChallenge).
    let challenge =
      AUTH_CHALLENGE_PREFIX +
      JSON.stringify({
        network: this.network,
        pubkey,
        nonce,
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
      });
    if (this.tamperChallenge) {
      challenge = this.tamperChallenge(challenge);
      this.tamperChallenge = null;
    }
    this.nonces.set(nonce, { pubkey, challenge, expiresAt }); // nonce stored server-side, 5-min TTL (§4)
    this.json(res, 200, { nonce, challenge, expiresAt: new Date(expiresAt).toISOString() });
  }

  private async handleVerify(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.verifyRequests++;
    const body = await this.readJsonBody(req);
    const { nonce, signature, deviceId } = body as { nonce?: string; signature?: string; deviceId?: string };
    if (typeof nonce !== 'string' || typeof signature !== 'string' || typeof deviceId !== 'string') {
      throw new HttpError(422, 'VALIDATION', 'nonce, signature and deviceId are required');
    }
    const stored = this.nonces.get(nonce);
    if (!stored || stored.expiresAt <= Date.now()) {
      throw new HttpError(401, 'UNAUTHORIZED', 'unknown or expired nonce');
    }
    // §4 step 3: recover the pubkey from the signature (sphere-sdk signMessage
    // scheme — 130-hex v‖r‖s over the double-SHA256 prefixed digest) and check
    // it matches the challenged pubkey; consume the nonce.
    let recovered: string;
    try {
      recovered = recoverPubkeyFromSignature(stored.challenge, signature);
    } catch {
      throw new HttpError(401, 'UNAUTHORIZED', 'signature does not parse');
    }
    if (recovered.toLowerCase() !== stored.pubkey.toLowerCase()) {
      throw new HttpError(401, 'UNAUTHORIZED', 'signature does not match the challenged pubkey');
    }
    this.nonces.delete(nonce);
    // One row per (owner, device); re-auth on the same device replaces it (§4).
    for (const [id, s] of this.sessions) {
      if (s.pubkey === recovered && s.deviceId === deviceId) this.sessions.delete(id);
    }
    const session = this.createSession(recovered, deviceId);
    this.owner(recovered); // accounts auto-provisioned on first touch (§4)
    this.json(res, 200, { jwt: session.jwt, refreshToken: this.issueRefreshToken(session) });
  }

  private createSession(pubkey: string, deviceId: string): Session {
    const session: Session = {
      sessionId: hex(randomBytes(16)),
      pubkey,
      deviceId,
      jwt: `jwt.${hex(randomBytes(24))}`,
      jwtExpiresAt: Date.now() + this.jwtTtlMs,
      refreshHash: '',
      refreshExpiresAt: 0,
      revoked: false,
      staleRefreshHashes: new Set(),
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  /**
   * Refresh wire form `v1.<sessionId>.<secretHex>` (§4): the secret is 32
   * random bytes (hex) returned once; only its SHA-256 is stored server-side.
   */
  private issueRefreshToken(session: Session): string {
    const secret = hex(randomBytes(32));
    if (session.refreshHash) session.staleRefreshHashes.add(session.refreshHash);
    session.refreshHash = hex(sha256(new TextEncoder().encode(secret)));
    session.refreshExpiresAt = Date.now() + 30 * 24 * 3600 * 1000; // REFRESH_TTL (§14)
    return `v1.${session.sessionId}.${secret}`;
  }

  private async handleRefresh(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.refreshRequests++;
    const body = await this.readJsonBody(req);
    const token = body.refreshToken;
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length !== 3 || parts[0] !== 'v1') {
      throw new HttpError(401, 'UNAUTHORIZED', 'malformed refresh token');
    }
    const session = this.sessions.get(parts[1]);
    if (!session || session.revoked || session.refreshExpiresAt <= Date.now()) {
      throw new HttpError(401, 'UNAUTHORIZED', 'refresh failed'); // revoked sessions cannot refresh (§4)
    }
    const presentedHash = hex(sha256(new TextEncoder().encode(parts[2])));
    if (presentedHash === session.refreshHash) {
      // §4 rotation: new access JWT + new refresh token; old hash invalidated.
      session.jwt = `jwt.${hex(randomBytes(24))}`;
      session.jwtExpiresAt = Date.now() + this.jwtTtlMs;
      this.json(res, 200, { jwt: session.jwt, refreshToken: this.issueRefreshToken(session) });
      return;
    }
    if (session.staleRefreshHashes.has(presentedHash)) {
      // §4 reuse detection: presenting a previously-rotated token is treated
      // as theft — the whole session is revoked.
      session.revoked = true;
      this.closeOwnerSockets(session); // socket closed on logout/revocation (§9)
      throw new HttpError(401, 'UNAUTHORIZED', 'stale refresh token reuse — session revoked');
    }
    throw new HttpError(401, 'UNAUTHORIZED', 'unknown refresh token');
  }

  private async handleLogout(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const session = this.authenticate(req);
    session.revoked = true; // durable revocation on the session row (§4)
    this.closeOwnerSockets(session); // the socket is closed on logout (§9)
    this.json(res, 204, null);
  }

  private closeOwnerSockets(session: Session): void {
    const sockets = this.socketsByOwner.get(session.pubkey);
    if (sockets) {
      for (const ws of sockets) ws.close();
      sockets.clear();
    }
  }

  // ── inventory (§5.1, §16) ────────────────────────────────────────────────────

  private rowToWire(row: InventoryRow): Record<string, unknown> {
    return {
      tokenId: row.tokenId,
      status: row.status,
      // Amounts are decimal strings in every JSON body (§11); asset rows are
      // deleted at the spend, so tombstones carry no assets (§5.3 step 4).
      ...(row.status === 'active' && row.assets
        ? { assets: row.assets.map((a) => ({ coinId: a.coinId, amount: a.amount.toString() })) }
        : {}),
      // bigint counters travel as decimal strings (pg bigint wire form — §11).
      seq: row.seq.toString(),
    };
  }

  private handleInventory(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const session = this.authenticate(req);
    if (this.failInventory) throw new HttpError(500, 'INTERNAL', 'simulated inventory outage');
    const owner = this.owner(session.pubkey);
    const sinceRaw = url.searchParams.get('since');
    this.inventoryGetLog.push(sinceRaw);
    const since = sinceRaw !== null ? BigInt(sinceRaw) : null;

    // §5.1: a full pull (no since) returns ACTIVE rows only; a delta returns
    // every row — active and removed — with seq > cursor, so a stale device
    // learns about spends/handoffs (tombstones ARE the removals channel).
    const rows = [...owner.rows.values()]
      .filter((r) => (since === null ? r.status === 'active' : r.seq > since))
      .sort((a, b) => (a.seq < b.seq ? -1 : 1)); // seq-ordered (§16)

    // §16: responses are capped at PAGE_LIMIT rows; a truncated response sets
    // more:true with cursor reflecting the last returned row.
    const page = rows.slice(0, this.pageLimit);
    const more = rows.length > page.length;
    const cursor = more ? page[page.length - 1].seq : owner.cursor;

    this.json(res, 200, {
      cursor: cursor.toString(),
      syncEpoch: this.syncEpoch.toString(), // every cursor-bearing response carries syncEpoch (§9)
      more,
      items: page.map((r) => this.rowToWire(r)),
    });
  }

  private handleBalances(req: http.IncomingMessage, res: http.ServerResponse): void {
    const session = this.authenticate(req);
    const owner = this.owner(session.pubkey);
    // §16: balances aggregate ACTIVE rows only (asset rows exist only while active).
    const totals = new Map<string, { total: bigint; tokenCount: number }>();
    for (const row of owner.rows.values()) {
      if (row.status !== 'active' || !row.assets) continue;
      for (const asset of row.assets) {
        const entry = totals.get(asset.coinId) ?? { total: 0n, tokenCount: 0 };
        entry.total += asset.amount;
        entry.tokenCount += 1;
        totals.set(asset.coinId, entry);
      }
    }
    this.json(res, 200, {
      balances: [...totals.entries()].map(([coinId, t]) => ({
        coinId,
        total: t.total.toString(), // decimal strings (§11)
        tokenCount: t.tokenCount,
      })),
    });
  }

  // ── blobs (§5.2) ─────────────────────────────────────────────────────────────

  private signUrl(entry: SignedUrl): string {
    const sig = hex(randomBytes(16));
    this.signedUrls.set(sig, entry);
    return `${this.baseUrl}/v1/_blob/${encodeURIComponent(entry.key)}?sig=${sig}`;
  }

  private async handleBlobUrls(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const session = this.authenticate(req);
    const body = await this.readJsonBody(req);
    if (!Array.isArray(body.tokenIds)) throw new HttpError(422, 'VALIDATION', 'tokenIds must be an array');
    const owner = this.owner(session.pubkey);
    const urls: { tokenId: string; getUrl: string }[] = [];
    for (const tokenId of body.tokenIds as unknown[]) {
      if (typeof tokenId !== 'string') throw new HttpError(422, 'VALIDATION', 'tokenIds must be strings');
      // §16: owner-checked — the caller's active *or tombstoned* rows qualify
      // (tombstoned blobs are retained and fetchable: the recovery path, §5.3).
      const row = owner.rows.get(tokenId);
      if (!row || !this.blobStore.has(row.s3Key)) continue;
      urls.push({
        tokenId,
        // Short-lived signed GET (GET_URL_TTL, §14).
        getUrl: this.signUrl({ key: row.s3Key, method: 'GET', expiresAt: Date.now() + 5 * 60 * 1000 }),
      });
    }
    this.json(res, 200, { urls });
  }

  private async handleUploadUrls(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.authenticate(req);
    const body = await this.readJsonBody(req);
    if (!Array.isArray(body.blobs)) throw new HttpError(422, 'VALIDATION', 'blobs must be an array');
    const urls: { sha256: string; key: string; putUrl: string }[] = [];
    for (const blob of body.blobs as { sha256?: unknown; size?: unknown }[]) {
      if (typeof blob.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(blob.sha256)) {
        throw new HttpError(422, 'VALIDATION', 'sha256 must be 64-hex');
      }
      if (typeof blob.size !== 'number' || !Number.isSafeInteger(blob.size) || blob.size <= 0) {
        throw new HttpError(422, 'VALIDATION', 'size must be a positive integer');
      }
      if (blob.size > this.maxBlobBytes) {
        throw new HttpError(413, 'TOO_LARGE', `blob exceeds MAX_BLOB_BYTES (${this.maxBlobBytes})`); // §5.5
      }
      // §5.2: key = <network>/t/<hex(sha256(blob bytes))> — content addressing,
      // nothing derived from claimed metadata.
      const key = `${this.network}/t/${blob.sha256}`;
      urls.push({
        sha256: blob.sha256,
        key,
        // §5.2: the presigned PUT pins the checksum and exact length
        // (PUT_URL_TTL, §14).
        putUrl: this.signUrl({
          key,
          method: 'PUT',
          expiresAt: Date.now() + 15 * 60 * 1000,
          sha256: blob.sha256,
          size: blob.size,
        }),
      });
    }
    this.json(res, 200, { urls });
  }

  private async handleSignedBlob(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const sig = url.searchParams.get('sig') ?? '';
    const entry = this.signedUrls.get(sig);
    if (!entry || entry.expiresAt <= Date.now()) {
      throw new HttpError(403, 'FORBIDDEN', 'signed URL invalid or expired');
    }
    if (req.method === 'GET' && entry.method === 'GET') {
      const bytes = this.blobStore.get(entry.key);
      if (!bytes) throw new HttpError(404, 'NOT_FOUND', 'blob not found');
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.from(bytes));
      return;
    }
    if (req.method === 'PUT' && entry.method === 'PUT') {
      // §5.2 / SigV4: the presign binds `x-amz-checksum-sha256` and
      // `if-none-match` as SIGNED HEADERS — a real S3 endpoint rejects the
      // signature when they are absent or differ. Enforced here because the
      // phase-2 harness caught exactly this drift on first contact with real
      // MinIO (the fake had validated only the body, never the headers).
      const expectedChecksum = Buffer.from(entry.sha256, 'hex').toString('base64');
      if (req.headers['x-amz-checksum-sha256'] !== expectedChecksum) {
        throw new HttpError(403, 'FORBIDDEN', 'x-amz-checksum-sha256 signed header missing or mismatched');
      }
      if (req.headers['if-none-match'] !== '*') {
        throw new HttpError(403, 'FORBIDDEN', 'if-none-match signed header missing (the presign binds it)');
      }
      const bytes = await this.readBody(req);
      // §5.2: the URL pins the exact Content-Length…
      if (bytes.length !== entry.size) {
        throw new HttpError(403, 'FORBIDDEN', 'Content-Length does not match the presigned size');
      }
      // …and the checksum (x-amz-checksum-sha256 equivalent): S3 rejects
      // content that does not match the key.
      if (hex(sha256(bytes)) !== entry.sha256) {
        throw new HttpError(403, 'FORBIDDEN', 'content checksum does not match the presigned sha256');
      }
      // §5.2 If-None-Match:* — an existing object is never overwritten; 412
      // means the identical blob already exists and the client treats the
      // upload as already done (content addressing).
      if (this.blobStore.has(entry.key)) {
        throw new HttpError(412, 'PRECONDITION_FAILED', 'object already exists');
      }
      this.blobStore.set(entry.key, new Uint8Array(bytes));
      this.json(res, 200, {});
      return;
    }
    throw new HttpError(403, 'FORBIDDEN', 'method does not match the signed URL');
  }

  // ── apply-delta (§5.3) ──────────────────────────────────────────────────────

  private async handleApply(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const session = this.authenticate(req);
    const owner = this.owner(session.pubkey);
    const body = await this.readJsonBody(req);
    const transferId = body.transferId;
    const spent = body.spent;
    const added = body.added;
    const externalDelivery = body.externalDelivery === true;
    if (typeof transferId !== 'string' || transferId === '') {
      throw new HttpError(422, 'VALIDATION', 'transferId is required');
    }
    if (!Array.isArray(spent) || !spent.every((s): s is string => typeof s === 'string')) {
      throw new HttpError(422, 'VALIDATION', 'spent must be a string array');
    }
    if (!Array.isArray(added)) throw new HttpError(422, 'VALIDATION', 'added must be an array');
    const addedEntries = added.map((a: unknown) => {
      const rec = a as { tokenId?: unknown; key?: unknown };
      if (typeof rec.tokenId !== 'string' || typeof rec.key !== 'string') {
        throw new HttpError(422, 'VALIDATION', 'added entries must be { tokenId, key }');
      }
      return { tokenId: rec.tokenId, key: rec.key };
    });

    // §5.3: a tokenId may not appear in both spent and added of one apply —
    // a self-send routes through the mailbox.
    for (const tokenId of spent) {
      if (addedEntries.some((a) => a.tokenId === tokenId)) {
        throw new HttpError(422, 'VALIDATION', `token ${tokenId} appears in both spent and added`);
      }
    }

    // §5.3 step 1 — idempotency: a replayed transferId returns the recorded
    // result, a strict no-op (this record is what makes replay safe).
    const recorded = owner.appliedTransfers.get(transferId);
    if (recorded !== undefined) {
      this.json(res, 200, { cursor: recorded.toString() });
      return;
    }

    // §5.3 step 2 — validate every added blob through the §8.2 pipeline
    // (hash↔key, decode, tokenId match, value decode; nothing invalid stored).
    const validated = addedEntries.map((entry) => this.validateAddedBlob(entry, session.pubkey));

    // §5.3 lineage precedence: the cross-owner check runs first.
    for (const v of validated) this.checkLineage(v, session.pubkey);

    // §5.3 step 3 — evidence-check every spent token. The evidence is a
    // validated output blob on this backend whose history consumes the spent
    // state: the MAILBOX DEPOSIT of the same transferId (a whole-token
    // transfer keeps its genesis tokenId — §6 evidence lookup uses the
    // entry's STORED transfer_id) or the split change in `added`.
    // APPROXIMATION: the real rule verifies the output blob's transition
    // chain actually consumes the spent state; this fake matches on
    // (transferId, tokenId) for deposits and on added-present for the split
    // leg. externalDelivery declares removals 'external' (§5.3: same
    // never-collected retention as unevidenced, separate metric).
    const depositEvidence = (tokenId: string): boolean => {
      for (const state of this.owners.values()) {
        for (const entry of state.mailbox.values()) {
          if (entry.transferId === transferId && entry.tokenId === tokenId) return true;
        }
      }
      return false;
    };
    const removalFor = (tokenId: string): 'evidenced' | 'unevidenced' | 'external' => {
      if (externalDelivery) return 'external';
      if (validated.length > 0 || depositEvidence(tokenId)) return 'evidenced';
      return 'unevidenced';
    };

    // §5.3 step 4 — one transaction: tombstone spent (drop asset rows), insert
    // or reactivate added, record applied_transfers, bump the owner cursor —
    // each changed row gets its own seq (§9).
    for (const tokenId of spent) {
      const row = owner.rows.get(tokenId);
      // A spent token whose row is already removed (or never recorded here)
      // is success, not an error (§5.3 step 4).
      if (!row || row.status === 'removed') continue;
      owner.cursor += 1n;
      row.status = 'removed';
      row.assets = null; // balances drop at the spend, not later (§5.3 step 4)
      row.seq = owner.cursor;
      row.removal = removalFor(tokenId);
    }
    for (const v of validated) {
      owner.cursor += 1n;
      const existing = owner.rows.get(v.tokenId);
      if (existing) {
        // §5.3: any acceptance over the owner's own prior row is a
        // reactivating UPDATE (status, s3_key, state_hash, seq, assets) —
        // never a second insert.
        existing.status = 'active';
        existing.s3Key = v.key;
        existing.stateHash = v.stateHash;
        existing.assets = v.assets;
        existing.seq = owner.cursor;
        existing.removal = undefined;
      } else {
        owner.rows.set(v.tokenId, {
          tokenId: v.tokenId,
          status: 'active',
          s3Key: v.key,
          stateHash: v.stateHash,
          assets: v.assets,
          seq: owner.cursor,
        });
      }
    }
    owner.appliedTransfers.set(transferId, owner.cursor);

    // §16: inventory/apply marks the intent completed in the same transaction;
    // completion wins over a concurrent abort (aborted → completed is legal).
    const intent = owner.intents.get(transferId);
    if (intent) intent.status = 'completed';

    this.wakeOwner(session.pubkey, 'inventory'); // §9 wake nudge
    this.json(res, 200, { cursor: owner.cursor.toString() });
  }

  private validateAddedBlob(
    entry: { tokenId: string; key: string },
    _ownerPubkey: string
  ): { tokenId: string; key: string; stateHash: string; assets: FakeAsset[] } {
    // §8.2 step 1: fetch the blob by key; enforce the size cap.
    const bytes = this.blobStore.get(entry.key);
    if (!bytes) throw new HttpError(422, 'VALIDATION', `no blob stored at key ${entry.key}`);
    if (bytes.length > this.maxBlobBytes) throw new HttpError(413, 'TOO_LARGE', 'blob exceeds MAX_BLOB_BYTES');
    // §8.2 step 2: recompute SHA-256 over the bytes — it MUST equal the
    // content-addressed key (§5.2): key, bytes and index can never disagree.
    if (`${this.network}/t/${hex(sha256(bytes))}` !== entry.key) {
      throw new HttpError(422, 'VALIDATION', 'blob bytes do not match the content-addressed key');
    }
    // §8.2 step 3 — APPROXIMATION: the real server CBOR-decodes the v2 token
    // (RAW wire bytes — §5.2) and runs the SDK's three-service token.verify
    // against the pinned trustbase. This fake reads the tokenId via the
    // injected decoder (envelope bytes from older seeds still unwrap).
    const resolved = this.resolveBlob(bytes);
    // §8.2 step 4: the decoded tokenId MUST match the claimed tokenId.
    if (resolved.tokenId === null) {
      throw new HttpError(422, 'VALIDATION', 'blob does not decode to a token id');
    }
    if (resolved.tokenId !== entry.tokenId) {
      throw new HttpError(422, 'VALIDATION', 'decoded tokenId does not match the claimed tokenId');
    }
    // §8.2 step 5 (ownership = self) is NOT modeled — the fake has no
    // predicate decoding. APPROXIMATION, noted.
    // §8.2 step 6: decode the value to populate the index (injected decoder
    // standing in for SpherePaymentData — see FakeWalletApiOptions).
    const assets = this.decodeAssets(resolved.inner);
    if (assets === null) throw new HttpError(422, 'VALIDATION', 'token value does not decode');
    // The per-state hash convention: hex(SHA-256(inner token bytes)).
    return { tokenId: entry.tokenId, key: entry.key, stateHash: hex(sha256(resolved.inner)), assets };
  }

  /**
   * §5.3 lineage for `added`. APPROXIMATION: the real rule walks the
   * transition chain ("the recorded state_hash appears strictly earlier in
   * the incoming blob's chain"); this fake cannot decode v2 transition
   * history, so "different state hash" stands in for strict extension and
   * "equal state hash" for equal state. The evidenced/unevidenced tombstone
   * distinction — the part S2's recovery contract depends on — is exact.
   */
  private checkLineage(
    v: { tokenId: string; stateHash: string },
    ownerPubkey: string
  ): void {
    // Cross-owner precedence (§5.3): if any OTHER owner holds a row whose
    // recorded state the incoming blob does not strictly extend (equal state),
    // the add is 409 regardless of the reactivation disjunct.
    for (const [pubkey, state] of this.owners) {
      if (pubkey === ownerPubkey) continue;
      const other = state.rows.get(v.tokenId);
      if (other && other.stateHash === v.stateHash && other.status === 'active') {
        throw new HttpError(409, 'CONFLICT', 'another owner holds this token at this state');
      }
    }
    const own = this.owner(ownerPubkey).rows.get(v.tokenId);
    if (!own) return; // first contact — acceptance (§5.3)
    if (own.status === 'active' && own.stateHash === v.stateHash) {
      // Equal state over the owner's own ACTIVE row is not an extension and
      // not a reactivation — rejected ("anything else", §5.3).
      throw new HttpError(409, 'CONFLICT', 'row already active at this state');
    }
    if (own.status === 'removed' && own.stateHash === v.stateHash && own.removal === 'evidenced') {
      // §5.3: an EVIDENCED tombstone is a proven spend and never reactivates
      // at equal state — a wiped-view recovery cannot resurrect a spent
      // source as phantom balance. The client treats this 409 as "actually
      // spent" and keeps the tombstone.
      throw new HttpError(409, 'CONFLICT', 'evidenced tombstone never reactivates at equal state');
    }
    // Remaining cases: unevidenced/external tombstone at equal state
    // (reactivation — the undo path, §5.3) or a different state hash (strict
    // extension, APPROXIMATION above) — acceptance.
  }

  // ── mailbox (§6, §16) ────────────────────────────────────────────────────────

  /** entry_id = SHA-256(token_id bytes ‖ final state_hash bytes) (§6). */
  private entryIdFor(tokenIdHex: string, stateHashHex: string): string {
    const tokenId = hexToBytes(tokenIdHex);
    const stateHash = hexToBytes(stateHashHex);
    const joined = new Uint8Array(tokenId.length + stateHash.length);
    joined.set(tokenId, 0);
    joined.set(stateHash, tokenId.length);
    return hex(sha256(joined));
  }

  /** Locate an entry by id across ALL recipients (entry_id is content-global). */
  private findMailboxEntry(entryId: string): MailboxEntryRow | null {
    for (const state of this.owners.values()) {
      const entry = state.mailbox.get(entryId);
      if (entry) return entry;
    }
    return null;
  }

  /**
   * §6 read pointer: the highest CONTIGUOUS seq whose entry is claimed *or*
   * rejected — a discovery cursor, recomputed server-side inside the
   * claim/reject transaction. Decoupled from claim idempotency (by entry_id),
   * so out-of-order claims never corrupt it.
   */
  private recomputeReadPointer(recipient: OwnerState): void {
    const bySeq = new Map<string, MailboxEntryRow>();
    for (const e of recipient.mailbox.values()) bySeq.set(e.seq.toString(), e);
    let pointer = recipient.readPointer;
    for (;;) {
      const next = bySeq.get((pointer + 1n).toString());
      if (!next || next.status === 'unclaimed') break;
      pointer += 1n;
    }
    recipient.readPointer = pointer;
  }

  private async handleMailboxDeposit(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const session = this.authenticate(req);
    const body = await this.readJsonBody(req);
    const { recipientPubkey, key, transferId, stateHash, tokenId, memo } = body as {
      recipientPubkey?: unknown; key?: unknown; transferId?: unknown;
      stateHash?: unknown; tokenId?: unknown; memo?: unknown;
    };
    if (typeof recipientPubkey !== 'string' || !/^0[23][0-9a-f]{64}$/i.test(recipientPubkey)) {
      throw new HttpError(422, 'VALIDATION', 'recipientPubkey must be a 33-byte compressed secp256k1 key (hex)');
    }
    if (typeof key !== 'string' || key === '') throw new HttpError(422, 'VALIDATION', 'key is required');
    if (typeof transferId !== 'string' || transferId === '') {
      throw new HttpError(422, 'VALIDATION', 'transferId is required');
    }
    if (typeof tokenId !== 'string' || !/^[0-9a-f]{64}$/.test(tokenId)) {
      throw new HttpError(422, 'VALIDATION', 'tokenId must be 64-hex');
    }
    if (typeof stateHash !== 'string' || !/^[0-9a-f]{64}$/.test(stateHash)) {
      throw new HttpError(422, 'VALIDATION', 'stateHash must be 64-hex');
    }
    if (memo !== undefined) {
      // §8.3 wire mapping: the memo is an `enc1.` envelope, validated for
      // shape + size cap ONLY and stored verbatim — never plaintext.
      try {
        assertFieldEnvelopeShape(memo);
      } catch (err) {
        throw new HttpError(422, 'VALIDATION', err instanceof Error ? err.message : 'bad memo envelope');
      }
    }

    // §6: deposit is idempotent by entry_id — an entry in ANY status returns
    // 200 with the existing entryId and changes nothing, PROVIDED the
    // request's recipient and key match the stored entry; a mismatch is 409,
    // never a false success.
    const entryId = this.entryIdFor(tokenId, stateHash);
    const existing = this.findMailboxEntry(entryId);
    if (existing) {
      if (existing.recipientPubkey !== recipientPubkey || existing.s3Key !== key) {
        throw new HttpError(409, 'CONFLICT', 'entry exists with a different recipient or key');
      }
      this.json(res, 200, { entryId });
      return;
    }

    // §6/§5.5 caps — what bounds abuse is validation plus quotas, not token
    // cost: the per-recipient unclaimed cap and the per-sender-pair sub-cap
    // (so a third party cannot fill the whole inbox). A 429 after
    // certification is not a loss — the blob is regenerable and the sender's
    // resume keeps retrying.
    const recipient = this.owner(recipientPubkey); // accounts auto-provisioned on first touch (§4/§9)
    let unclaimed = 0;
    let unclaimedFromSender = 0;
    for (const e of recipient.mailbox.values()) {
      if (e.status !== 'unclaimed') continue;
      unclaimed++;
      if (e.senderPubkey === session.pubkey) unclaimedFromSender++;
    }
    if (unclaimed >= this.mailboxUnclaimedCap) {
      throw new HttpError(429, 'RATE_LIMITED', 'recipient unclaimed-entry cap reached (§5.5)');
    }
    if (unclaimedFromSender >= this.mailboxPerPairCap) {
      throw new HttpError(429, 'RATE_LIMITED', 'per-sender-pair unclaimed sub-cap reached (§6)');
    }

    // §8.2 deposit validation pipeline (nothing invalid is stored):
    // step 1 — fetch the blob by key; size cap.
    const bytes = this.blobStore.get(key);
    if (!bytes) throw new HttpError(422, 'VALIDATION', `no blob stored at key ${key}`);
    if (bytes.length > this.maxBlobBytes) throw new HttpError(413, 'TOO_LARGE', 'blob exceeds MAX_BLOB_BYTES');
    // step 2 — recompute SHA-256; it MUST equal the content-addressed key (§5.2).
    if (`${this.network}/t/${hex(sha256(bytes))}` !== key) {
      throw new HttpError(422, 'VALIDATION', 'blob bytes do not match the content-addressed key');
    }
    // step 3 — APPROXIMATION: the real server runs the SDK's three-service
    // token.verify against the pinned trustbase over the RAW wire bytes
    // (§5.2); this fake reads the tokenId via the injected decoder (envelope
    // bytes from older seeds still unwrap).
    const resolved = this.resolveBlob(bytes);
    // step 4 — decoded tokenId MUST match the claim, and (deposits claim one)
    // the decoded final state_hash MUST match the claimed stateHash.
    if (resolved.tokenId === null) {
      throw new HttpError(422, 'VALIDATION', 'blob does not decode to a token id');
    }
    if (resolved.tokenId !== tokenId) {
      throw new HttpError(422, 'VALIDATION', 'decoded tokenId does not match the claimed tokenId');
    }
    if (hex(sha256(resolved.inner)) !== stateHash) {
      throw new HttpError(422, 'VALIDATION', 'decoded state hash does not match the claimed stateHash');
    }
    // step 5 — APPROXIMATION: recipient-ownership (predicate decode) is not
    // modeled; the fake cannot read predicates. The REAL backend rejects a
    // deposit whose current owner is not the addressed recipient.
    // step 6 — decode the value to populate the entry (injected decoder).
    const assets = this.decodeAssets(resolved.inner);
    if (assets === null) throw new HttpError(422, 'VALIDATION', 'token value does not decode');
    // step 7 (lineage) applies to inventory writes; the mailbox append itself
    // is replay-guarded by the content-derived entry_id above.

    // §6: assign a per-recipient monotonic seq and append; notify.
    recipient.mailboxSeq += 1n;
    recipient.mailbox.set(entryId, {
      entryId,
      seq: recipient.mailboxSeq,
      status: 'unclaimed',
      recipientPubkey,
      senderPubkey: session.pubkey,
      transferId,
      tokenId,
      stateHash,
      s3Key: key,
      assets,
      ...(memo !== undefined ? { memo: memo as string } : {}),
      createdAt: new Date().toISOString(),
      blobCollected: false,
    });
    this.wakeOwner(recipientPubkey, 'mailbox'); // §9 wake nudge
    this.json(res, 200, { entryId });
  }

  private mailboxEntryToWire(entry: MailboxEntryRow): Record<string, unknown> {
    // §6: a resolved entry keeps a working getUrl while its blob is within
    // BLOB_RETENTION; `blobCollected: true` replaces it afterwards. A pending
    // entry's blob is always retained (it may be someone's only copy).
    const blobAvailable = !entry.blobCollected && this.blobStore.has(entry.s3Key);
    return {
      entryId: entry.entryId,
      seq: entry.seq.toString(), // bigint counters travel as decimal strings (§11)
      status: entry.status,
      transferId: entry.transferId,
      tokenId: entry.tokenId,
      assets: entry.assets.map((a) => ({ coinId: a.coinId, amount: a.amount.toString() })),
      senderPubkey: entry.senderPubkey,
      ...(entry.memo !== undefined ? { memo: entry.memo } : {}), // verbatim envelope (§8.3)
      createdAt: entry.createdAt,
      ...(blobAvailable
        ? { getUrl: this.signUrl({ key: entry.s3Key, method: 'GET', expiresAt: Date.now() + 5 * 60 * 1000 }) }
        : { blobCollected: true }),
    };
  }

  private handleMailboxList(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const session = this.authenticate(req);
    const recipient = this.owner(session.pubkey);
    const sinceRaw = url.searchParams.get('since');
    const since = sinceRaw !== null ? BigInt(sinceRaw) : 0n;

    // §16: entries of EVERY status are listable for any client-chosen since
    // (delivery-only recipients re-fetch resolved entries within retention).
    const entries = [...recipient.mailbox.values()]
      .filter((e) => e.seq > since)
      .sort((a, b) => (a.seq < b.seq ? -1 : 1)); // seq-ordered (§16)

    // §16: PAGE_LIMIT + more (clients loop until more:false).
    const page = entries.slice(0, this.pageLimit);
    const more = entries.length > page.length;

    this.json(res, 200, {
      readPointer: recipient.readPointer.toString(),
      syncEpoch: this.syncEpoch.toString(), // cursor-bearing responses carry syncEpoch (§9)
      more,
      entries: page.map((e) => this.mailboxEntryToWire(e)),
    });
  }

  /**
   * §6 claim — an ownership handoff, idempotent by entry_id, one transaction
   * per entry: addressee check; alreadyClaimed with stored disposition (plus
   * the asymmetric false→true upgrade); handoff (flip the holder's active row
   * to an EVIDENCED tombstone — the claimed blob itself is the evidence);
   * insert/reactivate the recipient's row (state_hash from the entry, assets
   * from the entry's decoded value; self-send collapses to one in-place
   * UPDATE); mark claimed; recompute the read pointer.
   */
  private async handleMailboxClaim(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const session = this.authenticate(req);
    const body = await this.readJsonBody(req);
    const entryIds = body.entryIds;
    // §16 default: intoInventory is true (the full ownership handoff).
    const intoInventory = body.intoInventory !== false;
    if (!Array.isArray(entryIds) || !entryIds.every((e): e is string => typeof e === 'string')) {
      throw new HttpError(422, 'VALIDATION', 'entryIds must be a string array');
    }
    const recipient = this.owner(session.pubkey);

    const claimed: string[] = [];
    const alreadyClaimed: { entryId: string; intoInventory: boolean }[] = [];
    const failed: { entryId: string; code: string }[] = [];

    for (const entryId of entryIds) {
      const entry = recipient.mailbox.get(entryId);
      // §6 step 1: addressee check (else 403) — claiming someone else's entry
      // (or an unknown id) is a hard authorization failure, not a batch item.
      if (!entry) throw new HttpError(403, 'FORBIDDEN', `not the addressee of entry ${entryId}`);

      if (entry.status === 'claimed') {
        // §6: the one asymmetric upgrade — intoInventory:true against an entry
        // previously claimed false performs the missing §5.3-checked insert
        // (idempotent); a later false NEVER removes rows.
        if (intoInventory && entry.claimedIntoInventory === false) {
          const verdict = this.performClaimHandoff(entry, recipient, session.pubkey);
          if (verdict !== null) {
            failed.push({ entryId, code: verdict });
            continue;
          }
          entry.claimedIntoInventory = true;
        }
        // Already-claimed entries report their STORED disposition (§6).
        alreadyClaimed.push({ entryId, intoInventory: entry.claimedIntoInventory === true });
        continue;
      }

      // 'unclaimed' or 'rejected' — a rejected entry REMAINS claimable (§6:
      // reject is terminal for discovery, not for the asset).
      if (intoInventory) {
        const verdict = this.performClaimHandoff(entry, recipient, session.pubkey);
        if (verdict !== null) {
          // §16: `failed` is the defensive bucket for an entry that would now
          // violate lineage (§5.3) — never an HTTP error for the batch.
          failed.push({ entryId, code: verdict });
          continue;
        }
      }
      // §6 delivery-only claim (covenant §3.1-6): with intoInventory:false the
      // entry flips and the pointer advances — NO inventory rows are touched.
      entry.status = 'claimed';
      entry.claimedIntoInventory = intoInventory;
      this.recomputeReadPointer(recipient);
      claimed.push(entryId);
    }

    this.wakeOwner(session.pubkey, 'inventory'); // §9 wake nudge
    this.json(res, 200, { claimed, alreadyClaimed, failed });
  }

  /**
   * §6 claim steps 2–3 (the inventory writes). Returns null on success, or a
   * failure code for the defensive `failed` bucket (lineage violation).
   */
  private performClaimHandoff(
    entry: MailboxEntryRow,
    recipient: OwnerState,
    recipientPubkey: string
  ): string | null {
    // Defensive lineage check (§5.3): if ANY owner already holds an ACTIVE row
    // for this token at the entry's FINAL state, this exact state was already
    // indexed — claiming it again would duplicate value. Unreachable in normal
    // flows (the holder's row is at the PRE-transfer state).
    for (const [pubkey, state] of this.owners) {
      const row = state.rows.get(entry.tokenId);
      if (row && row.status === 'active' && row.stateHash === entry.stateHash) {
        // The recipient's own row at the final state = an idempotent replay of
        // a claim whose insert already happened — success, not failure.
        if (pubkey === recipientPubkey) return null;
        return 'CONFLICT';
      }
    }

    // §6 step 2: flip the active row under ANY owner — the sender (the normal
    // race: notify fires at deposit, so the recipient may claim before the
    // sender applies) or the recipient themself (a self-send) — to an
    // EVIDENCED removal (the claimed blob itself is the evidence), delete its
    // asset rows, bump that owner's cursor. The sender's later apply finds the
    // row already removed and treats it as success (§5.3 step 4).
    for (const [pubkey, state] of this.owners) {
      if (pubkey === recipientPubkey) continue; // self-send handled below (steps 2+3 collapse)
      const row = state.rows.get(entry.tokenId);
      if (row && row.status === 'active') {
        state.cursor += 1n;
        row.status = 'removed';
        row.assets = null;
        row.seq = state.cursor;
        row.removal = 'evidenced';
        this.wakeOwner(pubkey, 'inventory');
      }
    }

    // §6 step 3: insert the recipient's active row — or, if ANY prior row for
    // this token exists under the recipient (a tombstone, or their own active
    // row in a self-send), perform the §5.3 reactivating UPDATE in place
    // (s3_key/state_hash/seq advance; for a self-send the row simply stays
    // active). state_hash comes from the ENTRY, assets from the entry's
    // decoded value.
    recipient.cursor += 1n;
    const own = recipient.rows.get(entry.tokenId);
    if (own) {
      own.status = 'active';
      own.s3Key = entry.s3Key;
      own.stateHash = entry.stateHash;
      own.assets = entry.assets.map((a) => ({ ...a }));
      own.seq = recipient.cursor;
      own.removal = undefined;
    } else {
      recipient.rows.set(entry.tokenId, {
        tokenId: entry.tokenId,
        status: 'active',
        s3Key: entry.s3Key,
        stateHash: entry.stateHash,
        assets: entry.assets.map((a) => ({ ...a })),
        seq: recipient.cursor,
      });
    }
    return null;
  }

  /**
   * §6 reject — addressee-only, terminal FOR DISCOVERY ONLY: the entry counts
   * toward read-pointer contiguity (one bad entry can never wedge discovery),
   * is no longer surfaced by default, but REMAINS claimable and its blob is
   * retained exactly like an unclaimed delivery — reject must never be a
   * destruction path (a stolen JWT could otherwise mass-reject the inbox).
   */
  private async handleMailboxReject(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const session = this.authenticate(req);
    const body = await this.readJsonBody(req);
    const entryIds = body.entryIds;
    if (!Array.isArray(entryIds) || !entryIds.every((e): e is string => typeof e === 'string')) {
      throw new HttpError(422, 'VALIDATION', 'entryIds must be a string array');
    }
    const recipient = this.owner(session.pubkey);
    const rejected: string[] = [];
    for (const entryId of entryIds) {
      const entry = recipient.mailbox.get(entryId);
      if (!entry) throw new HttpError(403, 'FORBIDDEN', `not the addressee of entry ${entryId}`); // addressee-only (§16)
      if (entry.status === 'unclaimed') {
        entry.status = 'rejected';
        this.recomputeReadPointer(recipient);
        rejected.push(entryId);
      } else if (entry.status === 'rejected') {
        rejected.push(entryId); // idempotent replay
      }
      // A claimed entry stays claimed — reject never reverts a resolution.
    }
    this.json(res, 200, { rejected });
  }

  // ── history (§10, §16) ───────────────────────────────────────────────────────

  /**
   * §10: history is an append-only, per-owner, deduped (by dedupKey) log
   * WRITTEN BY THE CLIENT when a send or claim completes — the server never
   * writes history rows; it is client-asserted, untrusted display data.
   */
  private async handleHistoryPost(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const session = this.authenticate(req);
    const owner = this.owner(session.pubkey);
    const body = await this.readJsonBody(req);
    if (!Array.isArray(body.records)) throw new HttpError(422, 'VALIDATION', 'records must be an array');
    for (const raw of body.records as unknown[]) {
      if (typeof raw !== 'object' || raw === null) {
        throw new HttpError(422, 'VALIDATION', 'records must be objects');
      }
      const rec = raw as Record<string, unknown>;
      if (typeof rec.dedupKey !== 'string' || rec.dedupKey === '') {
        throw new HttpError(422, 'VALIDATION', 'record.dedupKey is required');
      }
      // §16 strict record shape (mirrors the REAL backend's zod schema —
      // caught drifting by the phase-2 harness): id uuid + ts ISO datetime,
      // never `timestamp`; type is the §16 enum; hex-shaped tokenId/pubkey.
      if (typeof rec.id !== 'string' || !UUID_RE.test(rec.id)) {
        throw new HttpError(422, 'VALIDATION', 'record.id must be a uuid');
      }
      if (typeof rec.type !== 'string' || !['SENT', 'RECEIVED', 'MINT'].includes(rec.type)) {
        throw new HttpError(422, 'VALIDATION', "record.type must be 'SENT' | 'RECEIVED' | 'MINT'");
      }
      if (typeof rec.ts !== 'string' || Number.isNaN(Date.parse(rec.ts))) {
        throw new HttpError(422, 'VALIDATION', 'record.ts must be an ISO-8601 datetime');
      }
      if ('timestamp' in rec) {
        throw new HttpError(422, 'VALIDATION', "Unrecognized key(s) in object: 'timestamp'");
      }
      if (rec.tokenId !== undefined && (typeof rec.tokenId !== 'string' || !/^(?:[0-9a-f]{2}){1,64}$/.test(rec.tokenId))) {
        throw new HttpError(422, 'VALIDATION', 'record.tokenId must be a lowercase-hex token id');
      }
      if (
        rec.counterpartyPubkey !== undefined &&
        (typeof rec.counterpartyPubkey !== 'string' || !/^0[23][0-9a-f]{64}$/.test(rec.counterpartyPubkey))
      ) {
        throw new HttpError(422, 'VALIDATION', 'record.counterpartyPubkey must be a 33-byte compressed pubkey');
      }
      if (!Array.isArray(rec.assets)) throw new HttpError(422, 'VALIDATION', 'record.assets must be an array');
      for (const a of rec.assets as { coinId?: unknown; amount?: unknown }[]) {
        // Amounts are decimal strings in every JSON body (§11).
        if (typeof a.coinId !== 'string' || typeof a.amount !== 'string' || !/^[0-9]+$/.test(a.amount)) {
          throw new HttpError(422, 'VALIDATION', 'record.assets entries must be { coinId, amount: decimal string }');
        }
      }
      // §8.3: memo + counterparty_nametag are S6 envelopes — shape + size cap
      // validated, stored verbatim, never plaintext.
      for (const field of ['memo', 'counterpartyNametag'] as const) {
        if (rec[field] !== undefined) {
          try {
            assertFieldEnvelopeShape(rec[field]);
          } catch (err) {
            throw new HttpError(422, 'VALIDATION', err instanceof Error ? err.message : `bad ${field} envelope`);
          }
        }
      }
      // §10: dedup by dedupKey — a replayed record is a no-op (append-only log).
      if (!owner.history.has(rec.dedupKey)) {
        owner.history.set(rec.dedupKey, rec);
      }
    }
    this.json(res, 200, {});
  }

  /** §10/§16: newest-first, opaque keyset cursor over (ts, dedupKey); the §16 page shape. */
  private handleHistoryGet(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const session = this.authenticate(req);
    const owner = this.owner(session.pubkey);
    const before = url.searchParams.get('before');
    const limitRaw = url.searchParams.get('limit');
    const limit = limitRaw !== null ? Math.max(1, Math.min(Number(limitRaw), this.pageLimit)) : this.pageLimit;

    const keyOf = (rec: Record<string, unknown>): string => `${rec.ts as string}:${rec.dedupKey as string}`;
    const sorted = [...owner.history.values()].sort((a, b) => (keyOf(a) < keyOf(b) ? 1 : -1));
    const filtered = before !== null ? sorted.filter((rec) => keyOf(rec) < before) : sorted;
    const page = filtered.slice(0, limit);
    const hasMore = filtered.length > page.length;
    // §16 page shape (mirrors the real backend): records + more + cursor
    // (string | null) + syncEpoch — `nextBefore` never existed on the wire
    // (caught by the phase-2 harness).
    this.json(res, 200, {
      records: page,
      more: hasMore,
      cursor: hasMore && page.length > 0 ? keyOf(page[page.length - 1]) : null,
      syncEpoch: this.syncEpoch.toString(),
    });
  }

  // ── payment requests (§10, §16 — backend M4) ─────────────────────────────────
  //
  // Wire fidelity note: unlike the rest of this fake (which serializes bigint
  // counters as decimal strings — the pg wire form), the REAL payments service
  // serializes seq / cursor / syncEpoch as JSON NUMBERS
  // (wallet-api src/payments/service.ts toWire / repository.ts), so this
  // section does too. Error codes are the real backend's
  // (VALIDATION_FAILED / QUOTA_EXCEEDED / FORBIDDEN / NOT_FOUND / CONFLICT).

  /** Mirrors service.ts toWire exactly: memo verbatim, expiresAt omitted when null. */
  private paymentRequestToWire(row: PaymentRequestRow): Record<string, unknown> {
    return {
      id: row.id,
      seq: Number(row.seq),
      fromPubkey: row.fromPubkey,
      toPubkey: row.toPubkey,
      assets: row.assets.map((a) => ({ coinId: a.coinId, amount: a.amount.toString() })), // §11 decimal strings
      ...(row.memo !== undefined ? { memo: row.memo } : {}), // verbatim envelope (§8.3)
      status: row.status,
      transferId: row.transferId,
      createdAt: row.createdAt,
      ...(row.expiresAt !== null ? { expiresAt: row.expiresAt } : {}),
    };
  }

  /** Locate a request by id across ALL payers (the table's primary key is global). */
  private findPaymentRequest(id: string): PaymentRequestRow | null {
    for (const state of this.owners.values()) {
      const row = state.paymentRequests.get(id);
      if (row) return row;
    }
    return null;
  }

  /** §16 create-body assets: 1–100 entries of { coinId, amount: decimal string }. */
  private parsePaymentRequestAssets(value: unknown): FakeAsset[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
      throw new HttpError(422, 'VALIDATION_FAILED', 'assets must be an array of 1–100 entries');
    }
    return value.map((raw: unknown) => {
      const rec = raw as { coinId?: unknown; amount?: unknown };
      if (typeof rec.coinId !== 'string' || rec.coinId.length < 1 || rec.coinId.length > 128) {
        throw new HttpError(422, 'VALIDATION_FAILED', 'asset coinId must be a 1–128 char string');
      }
      if (typeof rec.amount !== 'string' || !/^[0-9]+$/.test(rec.amount)) {
        throw new HttpError(422, 'VALIDATION_FAILED', 'expected a decimal-string amount'); // §11
      }
      return { coinId: rec.coinId, amount: BigInt(rec.amount) };
    });
  }

  private async handlePaymentRequestCreate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const session = this.authenticate(req);
    const body = await this.readJsonBody(req);
    // zod .strict(): unknown fields are rejected, not ignored (§16).
    for (const key of Object.keys(body)) {
      if (!['toPubkey', 'assets', 'memo', 'expiresAt'].includes(key)) {
        throw new HttpError(422, 'VALIDATION_FAILED', `unrecognized body key: ${key}`);
      }
    }
    const { toPubkey, memo, expiresAt } = body as { toPubkey?: unknown; memo?: unknown; expiresAt?: unknown };
    // The real route requires LOWERCASE hex (routes.ts createBody).
    if (typeof toPubkey !== 'string' || !/^0[23][0-9a-f]{64}$/.test(toPubkey)) {
      throw new HttpError(
        422,
        'VALIDATION_FAILED',
        'expected a 33-byte compressed secp256k1 pubkey in lowercase hex'
      );
    }
    const assets = this.parsePaymentRequestAssets(body.assets);
    if (memo !== undefined) {
      // §8.3: an `enc1.` envelope ≤ 4096 bytes (PR_MEMO_MAX_BYTES), shape +
      // cap validated only, stored verbatim — never plaintext.
      try {
        assertFieldEnvelopeShape(memo, 4096);
      } catch (err) {
        throw new HttpError(422, 'VALIDATION_FAILED', err instanceof Error ? err.message : 'bad memo envelope');
      }
    }
    let expiresAtIso: string | null = null;
    if (expiresAt !== undefined) {
      if (typeof expiresAt !== 'string' || !expiresAt.includes('T') || Number.isNaN(Date.parse(expiresAt))) {
        throw new HttpError(422, 'VALIDATION_FAILED', 'expiresAt must be an ISO-8601 datetime');
      }
      // §10: an already-past expiresAt is LEGAL — the sweep owns the flip.
      expiresAtIso = new Date(expiresAt).toISOString();
    }

    // §4/§9: the payer may have never authenticated — auto-provisioned on first touch.
    const payer = this.owner(toPubkey);
    // §5.5: only OPEN requests count toward the per-payer cap (responding frees capacity).
    let open = 0;
    for (const r of payer.paymentRequests.values()) if (r.status === 'open') open++;
    if (open >= this.maxPayerOpenRequests) {
      throw new HttpError(
        429,
        'QUOTA_EXCEEDED',
        `open payment requests per payer exceed ${this.maxPayerOpenRequests} (§5.5)`
      );
    }

    // §9: the per-payer seq is gap-free and commit-ordered — bumped with the
    // insert; a cap bounce above burned nothing.
    payer.prSeq += 1n;
    const row: PaymentRequestRow = {
      id: crypto.randomUUID(),
      fromPubkey: session.pubkey,
      toPubkey,
      seq: payer.prSeq,
      assets,
      ...(memo !== undefined ? { memo: memo as string } : {}),
      status: 'open',
      transferId: null,
      createdAt: new Date().toISOString(),
      expiresAt: expiresAtIso,
    };
    payer.paymentRequests.set(row.id, row);
    this.wakeOwner(toPubkey, 'payment_requests'); // §9: nudge the payer's devices
    this.json(res, 200, this.paymentRequestToWire(row));
  }

  private handlePaymentRequestList(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const session = this.authenticate(req);
    const params = url.searchParams;
    for (const key of params.keys()) {
      if (!['role', 'status', 'since', 'before'].includes(key)) {
        throw new HttpError(422, 'VALIDATION_FAILED', `unrecognized query key: ${key}`); // zod .strict()
      }
    }
    const role = params.get('role');
    if (role !== 'incoming' && role !== 'outgoing') {
      throw new HttpError(422, 'VALIDATION_FAILED', 'role must be incoming or outgoing');
    }
    const status = params.get('status');
    if (status !== null && !['open', 'paid', 'declined', 'expired'].includes(status)) {
      throw new HttpError(422, 'VALIDATION_FAILED', 'status must be open|paid|declined|expired');
    }
    if (role === 'incoming') {
      this.servePaymentRequestsIncoming(res, session.pubkey, status, params);
      return;
    }
    this.servePaymentRequestsOutgoing(res, session.pubkey, status, params);
  }

  /** §16 incoming: the payer's seq-ordered, gap-free ?since= stream. */
  private servePaymentRequestsIncoming(
    res: http.ServerResponse,
    payerPubkey: string,
    status: string | null,
    params: URLSearchParams
  ): void {
    // §16: the role × cursor families never mix — a mismatch is rejected, not ignored.
    if (params.get('before') !== null) {
      throw new HttpError(422, 'VALIDATION_FAILED', 'incoming is a ?since= stream — before is rejected (§16)');
    }
    const sinceRaw = params.get('since');
    if (sinceRaw !== null && !/^[0-9]+$/.test(sinceRaw)) {
      throw new HttpError(422, 'VALIDATION_FAILED', 'since must be a non-negative integer');
    }
    const since = sinceRaw !== null ? BigInt(sinceRaw) : 0n;
    const payer = this.owner(payerPubkey);
    const rows = [...payer.paymentRequests.values()]
      .filter((r) => r.seq > since && (status === null || r.status === status))
      .sort((a, b) => (a.seq < b.seq ? -1 : 1)); // seq-ordered (§16)
    const page = rows.slice(0, this.pageLimit);
    const more = rows.length > page.length;
    const last = page[page.length - 1];
    // The standard §16 ?since= contract: a truncated page's cursor reflects
    // the last returned row; otherwise the payer's seq counter (next_pr_seq).
    const cursor = more && last !== undefined ? Number(last.seq) : Number(payer.prSeq);
    this.json(res, 200, {
      requests: page.map((r) => this.paymentRequestToWire(r)),
      more,
      cursor,
      syncEpoch: Number(this.syncEpoch),
    });
  }

  /** §16 outgoing: created_at-descending keyset backfill (id ASC tiebreak), opaque before cursor. */
  private servePaymentRequestsOutgoing(
    res: http.ServerResponse,
    requesterPubkey: string,
    status: string | null,
    params: URLSearchParams
  ): void {
    if (params.get('since') !== null) {
      throw new HttpError(422, 'VALIDATION_FAILED', 'outgoing is a ?before= backfill view — since is rejected (§16)');
    }
    const beforeRaw = params.get('before');
    let before: { ts: string; id: string } | null = null;
    if (beforeRaw !== null) before = this.decodePaymentRequestKeyset(beforeRaw);

    const rows: PaymentRequestRow[] = [];
    for (const state of this.owners.values()) {
      for (const r of state.paymentRequests.values()) {
        if (r.fromPubkey === requesterPubkey && (status === null || r.status === status)) rows.push(r);
      }
    }
    rows.sort((a, b) =>
      a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? 1 : -1
    );
    const filtered =
      before === null
        ? rows
        : rows.filter((r) => r.createdAt < before.ts || (r.createdAt === before.ts && r.id > before.id));
    const page = filtered.slice(0, this.pageLimit);
    const more = filtered.length > page.length;
    const last = page[page.length - 1];
    this.json(res, 200, {
      requests: page.map((r) => this.paymentRequestToWire(r)),
      more,
      // Opaque keyset of the last returned row; null on the final page (§16).
      cursor:
        more && last !== undefined
          ? Buffer.from(JSON.stringify({ ts: last.createdAt, id: last.id }), 'utf8').toString('base64url')
          : null,
      syncEpoch: Number(this.syncEpoch),
    });
  }

  /** Mirrors lib/keyset.ts decodeKeyset: a malformed cursor is a 422, never a 500. */
  private decodePaymentRequestKeyset(cursor: string): { ts: string; id: string } {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
        ts?: unknown;
        id?: unknown;
      };
      if (
        typeof parsed.ts === 'string' &&
        typeof parsed.id === 'string' &&
        !Number.isNaN(Date.parse(parsed.ts)) &&
        UUID_RE.test(parsed.id)
      ) {
        return { ts: parsed.ts, id: parsed.id };
      }
    } catch {
      // fall through to the 422
    }
    throw new HttpError(422, 'VALIDATION_FAILED', 'malformed keyset cursor — pass the cursor from a prior response verbatim (§16)');
  }

  private async handlePaymentRequestRespond(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    id: string
  ): Promise<void> {
    const session = this.authenticate(req);
    if (!UUID_RE.test(id)) throw new HttpError(422, 'VALIDATION_FAILED', 'id must be a uuid'); // route param zod
    const body = await this.readJsonBody(req);
    for (const key of Object.keys(body)) {
      if (!['action', 'transferId'].includes(key)) {
        throw new HttpError(422, 'VALIDATION_FAILED', `unrecognized body key: ${key}`); // zod .strict()
      }
    }
    const { action, transferId } = body as { action?: unknown; transferId?: unknown };
    if (action !== 'paid' && action !== 'declined') {
      throw new HttpError(422, 'VALIDATION_FAILED', 'action must be paid or declined');
    }
    if (transferId !== undefined && (typeof transferId !== 'string' || !UUID_RE.test(transferId))) {
      throw new HttpError(422, 'VALIDATION_FAILED', 'transferId must be a uuid');
    }
    // §16 pairing — checked BEFORE the lookup (service.ts assertTransferIdShape).
    if (action === 'paid' && transferId === undefined) {
      throw new HttpError(422, 'VALIDATION_FAILED', 'paid links the fulfilling transfer — transferId is required (§16)');
    }
    if (action === 'declined' && transferId !== undefined) {
      throw new HttpError(422, 'VALIDATION_FAILED', 'declined carries no transfer — transferId is rejected (§16)');
    }

    const row = this.findPaymentRequest(id);
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'unknown payment request');
    // §10: addressee-only — neither the requester nor a stranger may respond.
    if (row.toPubkey !== session.pubkey) {
      throw new HttpError(403, 'FORBIDDEN', 'only the addressee (the payer) may respond to a payment request (§10)');
    }
    // §16: respond is open-only — paid/declined/expired are terminal.
    if (row.status !== 'open') {
      throw new HttpError(409, 'CONFLICT', `only an open request may be responded to (status: ${row.status}) (§16)`);
    }
    row.status = action;
    row.transferId = action === 'paid' ? (transferId as string) : null;
    // §16: re-stamp seq (under the payer's counter) so the resolved row re-surfaces in the
    // payer's incoming ?since= delta — mirrors wallet-api src/payments/{service,repository}.ts.
    const payer = this.owner(row.toPubkey);
    payer.prSeq += 1n;
    row.seq = payer.prSeq;
    // §9: nudge BOTH parties — the requester AND the payer's own other sessions
    this.wakeOwner(row.fromPubkey, 'payment_requests');
    this.wakeOwner(row.toPubkey, 'payment_requests');
    this.json(res, 200, this.paymentRequestToWire(row));
  }

  // ── intents (§7, §16) ────────────────────────────────────────────────────────

  private async handleIntent(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    transferId: string,
    action?: string
  ): Promise<void> {
    const session = this.authenticate(req);
    if (this.failIntents) throw new HttpError(500, 'INTERNAL', 'simulated intent outage');
    const owner = this.owner(session.pubkey);
    const method = req.method ?? 'GET';

    if (method === 'PUT' && !action) {
      const body = await this.readJsonBody(req);
      // §8.3 wire mapping: the body carries the `enc1.` envelope string
      // verbatim; the server validates ONLY prefix + base64 + size cap
      // (≤ 4 KiB — §7) and never sees plaintext.
      try {
        assertFieldEnvelopeShape(body.payload, this.intentMaxBytes);
      } catch (err) {
        throw new HttpError(422, 'VALIDATION', err instanceof Error ? err.message : 'bad intent payload');
      }
      const payload = body.payload as string;
      const existing = owner.intents.get(transferId);
      if (!existing) {
        owner.intents.set(transferId, { payload, status: 'open', createdAt: new Date().toISOString() });
        this.json(res, 204, null);
        return;
      }
      // §16: write-once while open or completed — a PUT against an existing
      // open/completed intent is a no-op 204 (a stolen JWT must not be able
      // to corrupt the resume seed).
      if (existing.status === 'open' || existing.status === 'completed') {
        this.json(res, 204, null);
        return;
      }
      // §16: a PUT against an ABORTED intent re-opens it iff the payload
      // equals the stored one (abort is soft and recoverable), else 409.
      if (existing.payload === payload) {
        existing.status = 'open';
        this.json(res, 204, null);
        return;
      }
      throw new HttpError(409, 'CONFLICT', 'aborted intent payload mismatch');
    }

    if (method === 'POST' && action === 'abort') {
      const intent = owner.intents.get(transferId);
      if (!intent) throw new HttpError(404, 'NOT_FOUND', 'unknown intent');
      // §16: abort is SOFT — flips status only; the row and payload remain;
      // completed never reverts (completion wins).
      if (intent.status !== 'completed') intent.status = 'aborted';
      this.json(res, 204, null);
      return;
    }

    if (method === 'POST' && action === 'complete') {
      const intent = owner.intents.get(transferId);
      if (!intent) throw new HttpError(404, 'NOT_FOUND', 'unknown intent');
      // §16: idempotent; aborted → completed is legal (completion wins);
      // completed never reverts. This is the uniform client-side close —
      // storage-opt-out senders depend on it.
      intent.status = 'completed';
      this.json(res, 204, null);
      return;
    }

    throw new HttpError(404, 'NOT_FOUND', 'no such intent route');
  }

  private handleListIntents(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const session = this.authenticate(req);
    const owner = this.owner(session.pubkey);
    const status = url.searchParams.get('status');
    // §16: GET /v1/intents?status=open|aborted — aborted intents stay
    // listable with their payload (abort is soft and recoverable).
    if (status !== 'open' && status !== 'aborted') {
      throw new HttpError(422, 'VALIDATION', 'status must be open or aborted');
    }
    const intents = [...owner.intents.entries()]
      .filter(([, i]) => i.status === status)
      .map(([transferId, i]) => ({ transferId, payload: i.payload, status: i.status, createdAt: i.createdAt }));
    this.json(res, 200, { intents });
  }

  // ── realtime (§9) ────────────────────────────────────────────────────────────

  private handleWsTicket(req: http.IncomingMessage, res: http.ServerResponse): void {
    const session = this.authenticate(req);
    // §9: a single-use ticket (random, 30 s TTL) — the JWT never appears in a
    // URL (URLs are logged by intermediaries; browsers cannot set WS headers).
    const ticket = hex(randomBytes(16));
    this.wsTickets.set(ticket, {
      pubkey: session.pubkey,
      sessionId: session.sessionId,
      expiresAt: Date.now() + this.wsTicketTtlMs,
    });
    this.json(res, 200, { ticket });
  }

  private handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', this.baseUrl);
    const ticket = url.searchParams.get('ticket') ?? '';
    const entry = this.wsTickets.get(ticket);
    // §9: single-use — consumed on first upgrade attempt; expired/reused
    // tickets are refused.
    this.wsTickets.delete(ticket);
    if (url.pathname !== '/v1/ws' || !entry || entry.expiresAt <= Date.now()) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    this.wss!.handleUpgrade(req, socket, head, (ws) => {
      // On connect the device subscribes to its owner (§9).
      let sockets = this.socketsByOwner.get(entry.pubkey);
      if (!sockets) {
        sockets = new Set();
        this.socketsByOwner.set(entry.pubkey, sockets);
      }
      sockets.add(ws);
      ws.on('close', () => sockets!.delete(ws));
    });
  }

  /** §9: any change publishes a `{ type:'wake', stream }` nudge with syncEpoch. */
  wakeOwner(pubkey: string, stream: 'inventory' | 'mailbox' | 'payment_requests'): void {
    const sockets = this.socketsByOwner.get(pubkey);
    if (!sockets) return;
    const frame = JSON.stringify({ type: 'wake', stream, syncEpoch: this.syncEpoch.toString() });
    for (const ws of sockets) ws.send(frame);
  }
}
