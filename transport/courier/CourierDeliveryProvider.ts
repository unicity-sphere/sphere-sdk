/**
 * CourierDeliveryProvider — the reference {@link TokenDeliveryTransport} over the
 * Token-Vault v2 courier endpoints (DESIGN §3, §6).
 *
 * It seals each transfer into a courier envelope (ECDH-derived key, AAD-bound
 * entryId) and exchanges it via deposit / receive / ack / sent. Resolution
 * (nametag→pubkey via Nostr) is a SEPARATE concern handled before delivery — the
 * courier addresses purely by `recipientChainPubkey`.
 *
 * The provider talks to the courier through an injected {@link CourierHttpClient}
 * (the swap seam): the Phase 5 tests inject the in-process fake server; Phase 8.3
 * injects a real fetch+JWT client against `vaultUrl`. The incoming path feeds the
 * EXISTING `handleV2Transfer` (verify + isOwnedBy + dedup) unchanged via an
 * injected {@link V2TransferSink}.
 */

import type { FullIdentity } from '../../types';
import type { V2TransferPayload } from '../../types/v2-transfer';
import { isV2TransferPayload } from '../../types/v2-transfer';
import { signMessage, verifySignedMessage } from '../../core/crypto';
import { sealCourierEnvelope, openCourierEnvelope } from '../../vault-aead/courier';
import { normalizeVaultNetwork } from '../../storage/remote/normalize-network';
import { courierEntryId } from './entryId';
import { courierAckTemplate } from './ack-template';
import type {
  CourierHttpClient,
  CourierInboxItem,
  DeliveryHandle,
  SignedReceipt,
  TokenDeliveryCapabilities,
  TokenDeliveryTransport,
  TokenEnvelope,
} from './types';

/** Default base backoff (ms) for the redelivery loop; doubles per attempt. */
const DEFAULT_BACKOFF_BASE_MS = 1000;
/** Default backoff cap (ms) — 5 minutes. */
const DEFAULT_BACKOFF_MAX_MS = 5 * 60_000;
/** Default max redelivery attempts before an entry surfaces `delivery_unconfirmed`. */
const DEFAULT_MAX_REDELIVERY_ATTEMPTS = 10;
/** Default max envelope bytes the courier accepts (DESIGN §6.6). */
const DEFAULT_MAX_ENVELOPE_BYTES = 16 * 1024 * 1024;

/** The highest `seq` across a page of rows, falling back to `fallback` when empty. */
function highestSeq(items: ReadonlyArray<{ seq: number }>, fallback: number): number {
  let max = fallback;
  for (const item of items) if (item.seq > max) max = item.seq;
  return max;
}

/** The highest `sentSeq` across a /sent page, falling back to `fallback` when empty. */
function highestSentSeq(items: ReadonlyArray<{ sentSeq: number }>, fallback: number): number {
  let max = fallback;
  for (const item of items) if (item.sentSeq > max) max = item.sentSeq;
  return max;
}

/**
 * Sink for a decoded incoming transfer — bound by PaymentsModule to its existing
 * `handleV2Transfer(payload, senderPubkey)` so the receive path is unchanged.
 */
export type V2TransferSink = (payload: V2TransferPayload, senderPubkey: string) => Promise<void>;

/** One ACK-PENDING journal entry (re-fired until the server shows `claimed`). */
interface AckPendingEntry {
  senderPubkey: string;
}

/** Per-entry sender-side delivery state for the redelivery/backoff loop. */
type SenderDeliveryState = 'pending' | 'delivered' | 'delivery_unconfirmed';

interface SentPendingEntry {
  recipientPubkey: string;
  attempts: number;
  state: SenderDeliveryState;
  /**
   * The server-assigned per-sender watermark for this entry (from the deposit
   * response). Lets `pollSent()` advance the persisted sent watermark by sentSeq —
   * present on entries deposited after the watermark fix; absent (undefined) on
   * rows journaled by an older build (watermark still advances via the /sent row).
   */
  sentSeq?: number;
  /**
   * Wall-clock ms of the LAST counted redelivery attempt (the backoff anchor,
   * finding courier-redelivery-backoff-not-enforced). `reconcileSentItem` only
   * counts a new attempt once `backoffMs(attempts)` has elapsed since this, so a
   * burst of polls during a short recipient-offline window does not exhaust the
   * attempt budget. Absent (undefined) until the first attempt is counted, and on
   * rows journaled by an older build (treated as "window elapsed" → first poll counts).
   */
  lastAttemptAt?: number;
}

/** Minimal persistent KV the journal needs (matches PaymentsModule storage). */
export interface CourierJournalStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface CourierDeliveryConfig {
  /** Vault/courier base URL — `NETWORKS[network].vaultUrl`. */
  vaultUrl: string;
  /** Canonical network name (DESIGN §7.1 — `testnet2` / `mainnet`). */
  network: string;
  /** Swap seam: build a courier client scoped to the authenticated caller. */
  httpClientFactory: (ownerId: string) => CourierHttpClient;
  /** Durable journal (ACK-PENDING, read pointer, sent watermark). */
  journal: CourierJournalStore;
  /** Feeds decoded incoming transfers into the existing handleV2Transfer path. */
  onV2Transfer: V2TransferSink;
  /**
   * Called when a delivery is CONFIRMED by a VALID recipient ackSig — the only
   * thing that licenses removing `PENDING_V2_DELIVERIES` + GC (DESIGN §6.5).
   * A forged/absent sig never triggers this (the sender keeps redelivering).
   */
  onDelivered?: (entryId: string) => Promise<void>;
  /** Max envelope bytes the courier accepts (DESIGN §6.6 default 16 MiB). */
  maxBytes?: number;
  /** Max redelivery attempts before the entry is surfaced `delivery_unconfirmed`. */
  maxRedeliveryAttempts?: number;
  /** Base backoff (ms) for the redelivery loop; doubles per attempt up to a cap. */
  backoffBaseMs?: number;
  /** Backoff cap (ms). */
  backoffMaxMs?: number;
  /** Wall-clock source (ms) for the redelivery backoff gate; injectable for tests. */
  now?: () => number;
}

export class CourierDeliveryProvider implements TokenDeliveryTransport {
  readonly id = 'courier-delivery';
  readonly name = 'Courier Delivery (Vault v2)';
  readonly type = 'network' as const;

  readonly capabilities: TokenDeliveryCapabilities;

  private readonly config: CourierDeliveryConfig;
  /**
   * The CANONICAL vault network literal (`normalizeVaultNetwork(config.network)`).
   * Used for the courier envelope AAD and the signed ack template, so a sender on
   * the `'testnet'` alias and a recipient on `'testnet2'` derive the same envelope
   * key/AAD and agree on the ack message. Storage SCOPING (read pointer, ack/sent
   * journals) stays on the LITERAL `config.network` (migration-v2 trap).
   */
  private readonly vaultNetwork: string;
  private identity: FullIdentity | null = null;

  constructor(config: CourierDeliveryConfig) {
    this.config = config;
    this.vaultNetwork = normalizeVaultNetwork(config.network);
    this.capabilities = {
      async: true,
      ack: true,
      addressing: 'pubkey',
      maxBytes: config.maxBytes ?? DEFAULT_MAX_ENVELOPE_BYTES,
    };
  }

  setIdentity(identity: FullIdentity): void {
    this.identity = identity;
  }

  // ===========================================================================
  // Deposit (Task 5.1)
  // ===========================================================================

  /**
   * Seal the envelope to the recipient (ECDH key, AAD-bound entryId), pack the
   * `base64(nonce24‖ct)` ciphertext, and POST `/v1/courier/deposit`. The caller
   * (sender) is `this.identity.chainPubkey`; the server keys dedup on
   * `(recipientPubkey, entryId)`.
   */
  async deposit(envelope: TokenEnvelope): Promise<DeliveryHandle> {
    const me = this.requireIdentity();
    const entryId = courierEntryId(me.privateKey, envelope.recipientChainPubkey, envelope.tokenBlobHex);
    const ciphertext = this.sealEnvelope(me, envelope, entryId);
    const client = this.config.httpClientFactory(me.chainPubkey);
    const res = await client.deposit({
      recipientPubkey: envelope.recipientChainPubkey,
      entryId,
      transferId: envelope.transferId,
      ciphertext,
      // hint stays undefined here — a single base64 SCALAR when present (never an object).
    });
    // Track the entry sender-side so pollSent() can gate "delivered" on a valid
    // recipient ackSig before removing PENDING_V2_DELIVERIES (DESIGN §6.5). The
    // sentSeq is captured so pollSent() can advance the persisted sent watermark.
    await this.journalSentPending(entryId, envelope.recipientChainPubkey, res.sentSeq);
    return {
      entryId: res.entryId,
      transferId: envelope.transferId,
      recipientChainPubkey: envelope.recipientChainPubkey,
      sentSeq: res.sentSeq,
    };
  }

  /**
   * Seal the V2_TRANSFER payload as a courier envelope; returns the packed
   * `base64(nonce24‖ct)` on-wire `ciphertext`.
   */
  private sealEnvelope(me: FullIdentity, envelope: TokenEnvelope, entryId: string): string {
    const payload: V2TransferPayload = {
      type: 'V2_TRANSFER',
      version: '2.0',
      tokenBlob: envelope.tokenBlobHex,
      memo: envelope.memo,
    };
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    return sealCourierEnvelope({
      network: this.vaultNetwork,
      senderPriv: me.privateKey,
      senderPubkey: me.chainPubkey,
      recipientPubkey: envelope.recipientChainPubkey,
      entryId,
      plaintext,
    });
  }

  // ===========================================================================
  // Receive (Task 5.2)
  // ===========================================================================

  /**
   * Pull the inbox since the persisted read pointer, open each envelope, decode it
   * to a {@link TokenEnvelope}, map it to a {@link V2TransferPayload}, and feed
   * the EXISTING `handleV2Transfer` path (via {@link V2TransferSink}) UNCHANGED.
   *
   * PAGINATION (finding courier-readpointer-and-watermark-never-persisted): loop
   * `/inbox?since=` while `more` so a delivery on page 2+ is NEVER dropped (a lost
   * transfer). After processing, PERSIST the advanced read pointer — the highest
   * CONTIGUOUSLY-processed seq — so the next `receive()` resumes from there and not
   * from `since=0`. The fetch cursor advances by the highest seq seen per page even
   * if an item failed mid-page (it is re-pulled next time from the persisted, lower
   * pointer; re-receiving is harmless — the sink dedups by `v2_${tokenId}`).
   */
  async receive(): Promise<void> {
    const me = this.requireIdentity();
    const client = this.config.httpClientFactory(me.chainPubkey);
    const start = await this.readPointer();
    let watermark = start;
    try {
      let cursor = start;
      for (;;) {
        const res = await client.inbox(cursor);
        watermark = await this.processInboxPage(me, res.items, watermark);
        const next = highestSeq(res.items, cursor);
        // No more pages, or `more` set but the page did not advance (defensive).
        if (!res.more || next <= cursor) break;
        cursor = next;
      }
    } finally {
      // Persist whatever contiguous progress we made — even if a later item threw,
      // the prefix we fully processed must not be re-pulled from since=0 next time.
      if (watermark > start) {
        await this.config.journal.set(this.readPointerKey(), String(watermark));
      }
    }
  }

  /**
   * Process one inbox page IN SEQ ORDER, advancing the contiguous read-pointer
   * watermark. An item counts as processed when it is already `claimed` (skip) or
   * `receiveItem` completes without throwing; the FIRST item that throws breaks
   * contiguity AND propagates (the Phase-5 crash-recovery contract), so the
   * watermark never advances past an item we did not fully process.
   */
  private async processInboxPage(
    me: FullIdentity,
    items: ReadonlyArray<CourierInboxItem>,
    watermark: number,
  ): Promise<number> {
    let advanced = watermark;
    for (const item of items) {
      if (item.status !== 'claimed') {
        await this.receiveItem(me, item); // throws → propagates, watermark frozen here
      }
      advanced = Math.max(advanced, item.seq);
    }
    return advanced;
  }

  /** Open one inbox item and feed it to handleV2Transfer; then arm the ack. */
  private async receiveItem(
    me: FullIdentity,
    item: { entryId: string; senderPubkey: string; ciphertext: string },
  ): Promise<void> {
    let payload: V2TransferPayload;
    try {
      payload = this.openItem(me, item);
    } catch {
      // A tampered / undecryptable envelope is dropped (the tag failure is the
      // operator-blind integrity check); discovery is not wedged by one bad row.
      return;
    }
    // Custody commit: hand the verified-by-engine payload to handleV2Transfer.
    // The sender is addressed by chainPubkey; nametag enrichment no-ops over the
    // courier (Nostr-keyed), so the RECEIVED history records the chainPubkey only.
    await this.config.onV2Transfer(payload, item.senderPubkey);
    // INVARIANT custody-commit ≺ ack-journal ≺ ack-POST: journal ACK-PENDING
    // AFTER the custody commit, BEFORE the ack POST. A crash between the journal
    // and the POST is recovered by replayAckPending() on the next load.
    await this.journalAckPending(item.entryId, item.senderPubkey);
    await this.ackEntry(item.entryId, item.senderPubkey);
  }

  /**
   * `unpackCourier` slices the first 24 bytes as the nonce; `openCourierEnvelope`
   * rebuilds the AAD and verifies the tag, then we decode the JSON V2_TRANSFER.
   */
  private openItem(
    me: FullIdentity,
    item: { entryId: string; senderPubkey: string; ciphertext: string },
  ): V2TransferPayload {
    const pt = openCourierEnvelope({
      network: this.vaultNetwork,
      recipientPriv: me.privateKey,
      senderPubkey: item.senderPubkey,
      recipientPubkey: me.chainPubkey,
      entryId: item.entryId,
      ciphertext: item.ciphertext,
    });
    const decoded = JSON.parse(new TextDecoder().decode(pt)) as unknown;
    if (!isV2TransferPayload(decoded)) {
      throw new Error('courier: decoded envelope is not a V2_TRANSFER payload');
    }
    return decoded;
  }

  // ===========================================================================
  // Journal (read pointer + ACK-PENDING)
  // ===========================================================================

  private readPointerKey(): string {
    return `courier_read_pointer:${this.config.network}:${this.requireIdentity().chainPubkey}`;
  }

  private async readPointer(): Promise<number> {
    const raw = await this.config.journal.get(this.readPointerKey());
    return raw ? Number(raw) : 0;
  }

  private ackPendingKey(): string {
    return `courier_ack_pending:${this.config.network}:${this.requireIdentity().chainPubkey}`;
  }

  private async loadAckPending(): Promise<Record<string, AckPendingEntry>> {
    const raw = await this.config.journal.get(this.ackPendingKey());
    return raw ? (JSON.parse(raw) as Record<string, AckPendingEntry>) : {};
  }

  /**
   * Journal an ACK-PENDING entry keyed by entryId, written AFTER the custody
   * commit and BEFORE the ack POST (invariant: custody-commit ≺ ack-journal ≺
   * ack-POST). Re-fired from the journal until the server shows `claimed`.
   */
  private async journalAckPending(entryId: string, senderPubkey: string): Promise<void> {
    const pending = await this.loadAckPending();
    if (!pending[entryId]) {
      pending[entryId] = { senderPubkey };
      await this.config.journal.set(this.ackPendingKey(), JSON.stringify(pending));
    }
  }

  private async removeAckPending(entryId: string): Promise<void> {
    const pending = await this.loadAckPending();
    if (pending[entryId]) {
      delete pending[entryId];
      await this.config.journal.set(this.ackPendingKey(), JSON.stringify(pending));
    }
  }

  // ===========================================================================
  // Ack — signed durable-copy claim (Task 5.3)
  // ===========================================================================

  /**
   * Send the signed ack for one entry: fetch a fresh server nonce, sign the bound
   * template with the recipient spend key, and POST `{entryId, ackSig}`. On
   * `claimed`/`alreadyClaimed` the ACK-PENDING journal row is cleared. Failure
   * keeps the row so the next `replayAckPending()` re-fires it.
   */
  async ackEntry(entryId: string, senderPubkey: string): Promise<'claimed' | 'alreadyClaimed' | 'failed'> {
    const me = this.requireIdentity();
    const client = this.config.httpClientFactory(me.chainPubkey);
    const { serverNonce } = await client.ackNonce(entryId);
    const tmpl = courierAckTemplate(this.vaultNetwork, senderPubkey, entryId, serverNonce);
    const ackSig = signMessage(me.privateKey, tmpl);
    const { result } = await client.ack({ entryId, ackSig });
    if (result === 'claimed' || result === 'alreadyClaimed') {
      await this.removeAckPending(entryId);
    }
    return result;
  }

  /**
   * Re-fire every journaled ACK-PENDING entry (called on `load()`). A crash
   * between the ack-journal and the ack-POST is recovered here: the row survives,
   * so the ack is retried until the server shows `claimed`/`alreadyClaimed`.
   */
  async replayAckPending(): Promise<void> {
    const pending = await this.loadAckPending();
    for (const [entryId, entry] of Object.entries(pending)) {
      try {
        await this.ackEntry(entryId, entry.senderPubkey);
      } catch {
        // Network failure — keep the row for the next load.
      }
    }
  }

  // ===========================================================================
  // Sender-side delivery confirmation (Task 5.4)
  // ===========================================================================

  private sentWatermarkKey(): string {
    return `courier_sent_watermark:${this.config.network}:${this.requireIdentity().chainPubkey}`;
  }

  private sentPendingKey(): string {
    return `courier_sent_pending:${this.config.network}:${this.requireIdentity().chainPubkey}`;
  }

  private async loadSentPending(): Promise<Record<string, SentPendingEntry>> {
    const raw = await this.config.journal.get(this.sentPendingKey());
    return raw ? (JSON.parse(raw) as Record<string, SentPendingEntry>) : {};
  }

  private async saveSentPending(pending: Record<string, SentPendingEntry>): Promise<void> {
    await this.config.journal.set(this.sentPendingKey(), JSON.stringify(pending));
  }

  private async journalSentPending(entryId: string, recipientPubkey: string, sentSeq?: number): Promise<void> {
    const pending = await this.loadSentPending();
    if (!pending[entryId]) {
      pending[entryId] = { recipientPubkey, attempts: 0, state: 'pending', sentSeq };
      await this.saveSentPending(pending);
    }
  }

  /**
   * The SENDER's delivery gate (DESIGN §6.5). Poll `/sent` since the per-sender
   * watermark; for each row that the server marks `claimed`, the sender — NOT the
   * server — verifies the recipient `ackSig` over the bound template. ONLY a valid
   * signature licenses `onDelivered` (which removes `PENDING_V2_DELIVERIES` + GC).
   * A forged flag without a valid sig is rejected → the entry stays pending and is
   * redelivered (bounded by attempt count → `delivery_unconfirmed`).
   *
   * PAGINATION + WATERMARK (finding courier-readpointer-and-watermark-never-persisted):
   * loop `/sent?since=` while `more` so a delivery confirmation on page 2+ is NEVER
   * dropped, then PERSIST the advanced sent watermark — the highest CONTIGUOUSLY-
   * delivered sentSeq — so the next poll resumes past the confirmed prefix and not
   * from `since=0`. A still-pending entry holds the watermark back (it must keep
   * being polled), so we never advance past an unconfirmed delivery.
   */
  async pollSent(): Promise<void> {
    const me = this.requireIdentity();
    const client = this.config.httpClientFactory(me.chainPubkey);
    const start = await this.sentWatermark();
    const pending = await this.loadSentPending();
    let cursor = start;
    for (;;) {
      const res = await client.sent(cursor);
      for (const item of res.items) {
        await this.reconcileSentItem(me, pending, item);
      }
      const next = highestSentSeq(res.items, cursor);
      if (!res.more || next <= cursor) break;
      cursor = next;
    }
    await this.saveSentPending(pending);
    await this.advanceSentWatermark(start, pending);
  }

  /**
   * Persist the sent watermark to the highest CONTIGUOUSLY-delivered sentSeq.
   * Entries are walked in sentSeq order; the first non-`delivered` entry (pending /
   * delivery_unconfirmed) breaks contiguity so the watermark never advances past a
   * delivery that still needs confirming. Entries without a known sentSeq (older
   * journal rows) are conservatively treated as a contiguity break.
   */
  private async advanceSentWatermark(start: number, pending: Record<string, SentPendingEntry>): Promise<void> {
    const rows = Object.values(pending)
      .filter((e): e is SentPendingEntry & { sentSeq: number } => typeof e.sentSeq === 'number')
      .sort((a, b) => a.sentSeq - b.sentSeq);
    let watermark = start;
    for (const row of rows) {
      if (row.sentSeq <= start) continue; // already past the watermark
      if (row.state !== 'delivered') break; // contiguity break — do not advance further
      watermark = row.sentSeq;
    }
    if (watermark > start) {
      await this.config.journal.set(this.sentWatermarkKey(), String(watermark));
    }
  }

  /** Verify one /sent row's ackSig and advance its sender-side state. */
  private async reconcileSentItem(
    me: FullIdentity,
    pending: Record<string, SentPendingEntry>,
    item: { entryId: string; recipientPubkey: string; ackSig: string | null; ackNonce: string | null },
  ): Promise<void> {
    const entry = pending[item.entryId];
    if (!entry || entry.state === 'delivered') return;
    // A valid recipient ackSig ALWAYS delivers — confirmation is never throttled by
    // the backoff gate (a poll inside the window still confirms a genuine delivery).
    if (this.isValidReceipt(me, item)) {
      entry.state = 'delivered';
      await this.config.onDelivered?.(item.entryId);
      return;
    }
    // Not yet validly claimed (still unclaimed, or a FORGED ackSig that fails
    // verification). ENFORCE the backoff (finding courier-redelivery-backoff-not-
    // enforced): only COUNT an attempt once `backoffMs(attempts)` has elapsed since
    // the last counted one, so a burst of polls during a brief recipient-offline
    // window does not prematurely exhaust the budget and flip to delivery_unconfirmed.
    if (!this.backoffElapsed(entry)) return;
    entry.attempts += 1;
    entry.lastAttemptAt = this.now();
    if (entry.attempts >= this.maxAttempts()) entry.state = 'delivery_unconfirmed';
  }

  /**
   * True once the redelivery backoff window for `entry` has elapsed — i.e. the
   * NEXT attempt may be counted. The window is `backoffMs(entry.attempts)` (the
   * delay before the next attempt, scaled by attempts already made). The first
   * attempt (no `lastAttemptAt`) always counts; older journal rows without a
   * timestamp are treated as "window elapsed" so they are never wedged.
   */
  private backoffElapsed(entry: SentPendingEntry): boolean {
    if (entry.lastAttemptAt === undefined) return true;
    return this.now() - entry.lastAttemptAt >= this.backoffMs(entry.attempts);
  }

  /** Wall-clock source (ms) — injectable for the backoff gate's tests. */
  private now(): number {
    return (this.config.now ?? Date.now)();
  }

  /** True only for a recipient ackSig that verifies over the bound template. */
  private isValidReceipt(
    me: FullIdentity,
    item: { entryId: string; recipientPubkey: string; ackSig: string | null; ackNonce: string | null },
  ): boolean {
    if (!item.ackSig || !item.ackNonce) return false;
    const tmpl = courierAckTemplate(this.vaultNetwork, me.chainPubkey, item.entryId, item.ackNonce);
    return verifySignedMessage(tmpl, item.ackSig, item.recipientPubkey);
  }

  /**
   * Verify a delivery handle's signed receipt (DESIGN §3 port method). Returns the
   * {@link SignedReceipt} only when the recipient's ackSig validly claims it.
   *
   * PAGINATION (finding confirmReceipt-non-paginated-sent(0)): a `/sent` page is
   * bounded, so a plain `sent(0).find()` returns a false `null` for any handle whose
   * row sits on page 2+. We ANCHOR the query on the handle's own `sentSeq` — the row
   * is the FIRST one of `sent(sentSeq - 1)` (rows with `sentSeq > since`) regardless
   * of how many other deliveries precede it, so a single cheap page always contains
   * it. Handles minted by an older build (no `sentSeq`) fall back to `sent(0)`.
   */
  async confirmReceipt(handle: DeliveryHandle): Promise<SignedReceipt | null> {
    const me = this.requireIdentity();
    const client = this.config.httpClientFactory(me.chainPubkey);
    const since = handle.sentSeq !== undefined ? handle.sentSeq - 1 : 0;
    const res = await client.sent(since);
    const row = res.items.find((i) => i.entryId === handle.entryId);
    if (!row || !this.isValidReceipt(me, row)) return null;
    return { entryId: row.entryId, ackSig: row.ackSig!, recipientChainPubkey: row.recipientPubkey };
  }

  private maxAttempts(): number {
    return this.config.maxRedeliveryAttempts ?? DEFAULT_MAX_REDELIVERY_ATTEMPTS;
  }

  /** Exponential backoff for the redelivery loop, capped (DESIGN §6.5). */
  backoffMs(attempts: number): number {
    const base = this.config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    const cap = this.config.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    return Math.min(cap, base * 2 ** attempts);
  }

  /** Current sender-side state for an entry (for the UI: pending/delivered/unconfirmed). */
  async sentState(entryId: string): Promise<SenderDeliveryState | null> {
    const pending = await this.loadSentPending();
    return pending[entryId]?.state ?? null;
  }

  private async sentWatermark(): Promise<number> {
    const raw = await this.config.journal.get(this.sentWatermarkKey());
    return raw ? Number(raw) : 0;
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  private requireIdentity(): FullIdentity {
    if (!this.identity) {
      throw new Error('CourierDeliveryProvider: setIdentity() must be called before use');
    }
    return this.identity;
  }
}
