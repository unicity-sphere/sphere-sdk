/**
 * fake-courier-server — an in-memory, faithful re-implementation of the
 * token-api courier wire endpoints (DESIGN §6), for the Phase 5 integration
 * tests. The REAL token-api is only exercised in Phase 8.3; this fake lets the
 * provider's logic run identically against a swappable in-process server.
 *
 * Faithful to Part A's wire contract:
 *  - deposit: idempotent on `(recipientId, entryId)`; allocates gap-free
 *    per-recipient `seq` and per-sender `sentSeq`; `{ entryId, seq, sentSeq, status }`.
 *  - inbox?since=: rows with `seq > since`, sorted; carries `ciphertext` /
 *    `senderPubkey` / `ackSig`.
 *  - ack-nonce?entryId=: single-use server nonce.
 *  - ack {entryId, ackSig}: addressee-only; nonce consumed AFTER the addressee
 *    check; verifies `ackSig` over the bound template via `verifySignedMessage`;
 *    flips unclaimed→claimed; returns the single frozen `{ result }`.
 *  - sent?since=: rows with `sentSeq > since`; carries `ackSig`.
 *
 * Swap seam: the provider talks to a {@link CourierHttpClient}. `clientFor(ownerId)`
 * returns one scoped to a caller (the authenticated `chainPubkey`). Phase 8.3
 * swaps in a real HTTP client (fetch + JWT against `vaultUrl`) implementing the
 * same interface — no provider changes.
 */

import { verifySignedMessage } from '../../core/crypto';
import { courierAckTemplate } from '../../transport/courier/ack-template';
import type {
  CourierAckNonceResponse,
  CourierAckRequest,
  CourierAckResponse,
  CourierDeliveryStatus,
  CourierDepositRequest,
  CourierDepositResponse,
  CourierHttpClient,
  CourierInboxResponse,
  CourierSentResponse,
} from '../../transport/courier/types';

interface DeliveryRow {
  recipientId: string;
  senderId: string;
  entryId: string;
  transferId: string;
  ciphertext: string;
  hint: string | null;
  status: CourierDeliveryStatus;
  seq: number;
  sentSeq: number;
  ackSig: string | null;
  /** The server nonce the claim consumed (surfaced to the sender via /sent). */
  ackNonce: string | null;
}

let randomCounter = 0;
const nextNonce = (): string => `nonce-${++randomCounter}-${Math.random().toString(36).slice(2)}`;

export interface FakeCourierServerOptions {
  network?: string;
  /** Max rows returned per `/inbox` or `/sent` page; the rest set `more:true`. */
  pageLimit?: number;
}

/**
 * The in-memory courier server. Hold ONE instance per test; obtain a
 * caller-scoped {@link CourierHttpClient} via {@link FakeCourierServer.clientFor}.
 */
export class FakeCourierServer {
  /** Canonical network literal baked into the ack template (DESIGN §6.4). */
  readonly network: string;
  /** Page size for `/inbox` + `/sent` (mirrors token-api `config.PAGE_LIMIT`). */
  private readonly pageLimit: number;

  private readonly deliveries: DeliveryRow[] = [];
  private readonly recipientSeq = new Map<string, number>();
  private readonly senderSeq = new Map<string, number>();
  private readonly readPointers = new Map<string, number>();
  /** Live ack-nonces by entryId (single-use). */
  private readonly ackNonces = new Map<string, string>();
  private syncEpoch = 1;

  /** Per-endpoint call log — tests assert request bodies and call counts. */
  readonly calls: {
    deposit: CourierDepositRequest[];
    ack: CourierAckRequest[];
    ackNonce: string[];
    inbox: number[];
    sent: number[];
  } = { deposit: [], ack: [], ackNonce: [], inbox: [], sent: [] };

  constructor(opts: FakeCourierServerOptions | string = {}) {
    const o = typeof opts === 'string' ? { network: opts } : opts;
    this.network = o.network ?? 'testnet2';
    this.pageLimit = o.pageLimit ?? 1000;
  }

  /** A {@link CourierHttpClient} bound to a caller (the authenticated chainPubkey). */
  clientFor(ownerId: string): CourierHttpClient {
    return {
      deposit: (req) => this.deposit(ownerId, req),
      inbox: (since) => this.inbox(ownerId, since),
      ackNonce: (entryId) => this.ackNonce(entryId),
      ack: (req) => this.ack(ownerId, req),
      sent: (since) => this.sent(ownerId, since),
    };
  }

  // --- endpoints ------------------------------------------------------------

  private deposit(senderId: string, req: CourierDepositRequest): CourierDepositResponse {
    this.calls.deposit.push(req);
    const recipientId = req.recipientPubkey;
    // Idempotent on (recipientId, entryId) — the ciphertext bytes never affect dedup.
    const existing = this.deliveries.find(
      (d) => d.recipientId === recipientId && d.entryId === req.entryId,
    );
    if (existing) {
      return { entryId: existing.entryId, seq: existing.seq, sentSeq: existing.sentSeq, status: existing.status };
    }
    const seq = this.alloc(this.recipientSeq, recipientId);
    const sentSeq = this.alloc(this.senderSeq, senderId);
    this.deliveries.push({
      recipientId,
      senderId,
      entryId: req.entryId,
      transferId: req.transferId,
      ciphertext: req.ciphertext,
      hint: req.hint ?? null,
      status: 'unclaimed',
      seq,
      sentSeq,
      ackSig: null,
      ackNonce: null,
    });
    return { entryId: req.entryId, seq, sentSeq, status: 'unclaimed' };
  }

  private inbox(recipientId: string, since: number): CourierInboxResponse {
    this.calls.inbox.push(since);
    const rows = this.deliveries
      .filter((d) => d.recipientId === recipientId && d.seq > since)
      .sort((a, b) => a.seq - b.seq);
    // Page-limited (mirrors token-api: fetch limit+1, `more` when overshot).
    const more = rows.length > this.pageLimit;
    const page = more ? rows.slice(0, this.pageLimit) : rows;
    const items = page.map((d) => ({
      entryId: d.entryId,
      seq: d.seq,
      status: d.status,
      senderPubkey: d.senderId,
      ciphertext: d.ciphertext,
      transferId: d.transferId,
      hint: d.hint,
      ackSig: d.ackSig,
    }));
    return {
      readPointer: this.readPointers.get(recipientId) ?? 0,
      syncEpoch: this.syncEpoch,
      more,
      items,
    };
  }

  private ackNonce(entryId: string): CourierAckNonceResponse {
    this.calls.ackNonce.push(entryId);
    const serverNonce = nextNonce();
    this.ackNonces.set(entryId, serverNonce);
    return { serverNonce };
  }

  private ack(recipientId: string, req: CourierAckRequest): CourierAckResponse {
    this.calls.ack.push(req);
    const d = this.deliveries.find((x) => x.entryId === req.entryId);
    // Addressee-only: a non-addressee (or unknown entry) fails BEFORE the nonce
    // is consumed (so a non-addressee can't burn it).
    if (!d || d.recipientId !== recipientId) return { result: 'failed' };
    if (d.status === 'claimed') return { result: 'alreadyClaimed' };
    const nonce = this.ackNonces.get(req.entryId);
    if (!nonce) return { result: 'failed' };
    this.ackNonces.delete(req.entryId); // single-use
    const tmpl = courierAckTemplate(this.network, d.senderId, req.entryId, nonce);
    if (!verifySignedMessage(tmpl, req.ackSig, recipientId)) return { result: 'failed' };
    d.status = 'claimed';
    d.ackSig = req.ackSig;
    d.ackNonce = nonce;
    this.advanceReadPointer(recipientId);
    return { result: 'claimed' };
  }

  private sent(senderId: string, since: number): CourierSentResponse {
    this.calls.sent.push(since);
    const rows = this.deliveries
      .filter((d) => d.senderId === senderId && d.sentSeq > since)
      .sort((a, b) => a.sentSeq - b.sentSeq);
    const more = rows.length > this.pageLimit;
    const page = more ? rows.slice(0, this.pageLimit) : rows;
    const items = page.map((d) => ({
      entryId: d.entryId,
      recipientPubkey: d.recipientId,
      status: d.status,
      sentSeq: d.sentSeq,
      ackSig: d.ackSig,
      ackNonce: d.ackNonce,
    }));
    return { more, items };
  }

  // --- test affordances -----------------------------------------------------

  /**
   * Inject a FORGED `ackSig` onto a sent row WITHOUT the addressee check — a
   * hostile/broken server that flips the flag without a valid signature. Used to
   * prove the sender's verify-gate keeps redelivering (§6.5 negative path).
   */
  forgeSentAckSig(entryId: string, ackSig: string, ackNonce = 'forged-nonce'): void {
    const d = this.deliveries.find((x) => x.entryId === entryId);
    if (d) {
      d.ackSig = ackSig;
      d.ackNonce = ackNonce;
      d.status = 'claimed';
    }
  }

  /** Number of stored deliveries (for assertions). */
  get deliveryCount(): number {
    return this.deliveries.length;
  }

  // --- internals ------------------------------------------------------------

  private alloc(counter: Map<string, number>, id: string): number {
    const next = (counter.get(id) ?? 0) + 1;
    counter.set(id, next);
    return next;
  }

  /** Read pointer = highest contiguous claimed/rejected seq (DESIGN §6.5). */
  private advanceReadPointer(recipientId: string): void {
    const rows = this.deliveries
      .filter((d) => d.recipientId === recipientId)
      .sort((a, b) => a.seq - b.seq);
    let rp = 0;
    for (const d of rows) {
      if (d.status !== 'claimed' && d.status !== 'rejected') break;
      rp = d.seq;
    }
    this.readPointers.set(recipientId, rp);
  }
}
