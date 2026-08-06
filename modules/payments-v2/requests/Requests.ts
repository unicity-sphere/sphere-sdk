// §5.8 of docs/PAYMENTS-V2-DESIGN.md — the incoming payment-request mirror
// over the wallet-api `?since=` stream, plus the #441 settling journal
// (verbatim semantics: durable link BEFORE any possibly-committed throw
// surfaces; direction of error is always PAID-NEVER-RE-PAYABLE).

import { logger } from '../../../core/logger';
import {
  SphereError,
  PartialSendConflictError,
  isPossiblyCommittedSendOutcome,
} from '../../../core/errors';
import type { TransferResult } from '../../../types';
import type {
  PaymentRequestStatus,
  PaymentRequestView,
  PaymentsRequestsApi,
  PaymentsV2Events,
  SendRequest,
} from '../api';
import { SerialChain, SingleFlight } from '../async';
import { STORE_KEYS, type ScopedKV, type SettlingLink, type StreamCursor } from '../stores';

export type RequestWireStatus = 'open' | 'paid' | 'declined' | 'expired';

export interface RequestWire {
  readonly id: string;
  readonly seq: number;
  readonly fromPubkey: string;
  readonly toPubkey: string;
  readonly assets: readonly { readonly coinId: string; readonly amount: string }[];
  readonly memo?: string;
  readonly status: RequestWireStatus;
  readonly transferId: string | null;
  readonly createdAt: string;
  readonly expiresAt?: string;
}

export interface RequestsPageWire {
  readonly requests: readonly RequestWire[];
  readonly more: boolean;
  readonly cursor: number | string | null;
  readonly syncEpoch: number;
}

// Structural subset of WalletApiV2Client — the real client is assignable.
export interface RequestsWireClient {
  createPaymentRequest(input: {
    toPubkey: string;
    assets: { coinId: string; amount: string }[];
    memo?: string;
    expiresAt?: string;
  }): Promise<RequestWire>;
  listPaymentRequests(params: { role: 'incoming'; since?: number }): Promise<RequestsPageWire>;
  respondPaymentRequest(
    id: string,
    response: { action: 'paid'; transferId: string } | { action: 'declined' }
  ): Promise<RequestWire>;
}

// Recipient-ECDH bundle codec (core/delivery-envelope.ts, shared with Delivery).
export interface RequestMemoCodec {
  encrypt(peerPubkey: string, bundle: { memo?: string; senderNametag?: string }): string | undefined;
  decrypt(peerPubkey: string, envelope: string): { memo?: string; senderNametag?: string };
}

export type RequestsEmit = <K extends 'payment_request:incoming' | 'payment_request:updated'>(
  event: K,
  payload: PaymentsV2Events[K]
) => void;

export interface RequestsDeps {
  readonly client: RequestsWireClient;
  readonly kv: ScopedKV;
  readonly ownPubkey: string;
  readonly send: (request: SendRequest) => Promise<TransferResult>;
  readonly resolvePubkey: (identifier: string) => Promise<string | null>;
  // Server `listIntents('aborted')` authority for unaccounted settling links.
  readonly listAbortedTransferIds: () => Promise<string[]>;
  readonly emit: RequestsEmit;
  readonly memo: RequestMemoCodec;
  readonly ownNametag?: () => string | undefined;
  readonly now?: () => number;
}

// Resume outcomes keyed by transferId (§5.8 reconcile).
export interface ResumeOutcomes {
  readonly resumed: readonly string[];
  readonly conflicted: readonly string[];
  readonly open: readonly string[];
}

const WIRE_STATUS: Record<RequestWireStatus, PaymentRequestStatus> = {
  open: 'pending',
  paid: 'paid',
  declined: 'rejected',
  expired: 'expired',
};

const TERMINAL: ReadonlySet<PaymentRequestStatus> = new Set(['paid', 'rejected', 'expired']);

const MAX_HYDRATION_PAGES = 100;
const CHAIN_PUBKEY_RE = /^0[23][0-9a-fA-F]{64}$/;
const CURSOR_KEY = STORE_KEYS.streamCursor('payment_requests');

function isConflict409(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { status?: unknown; statusCode?: unknown; code?: unknown };
  return e.status === 409 || e.statusCode === 409 || e.code === 'CONFLICT';
}

export class Requests implements PaymentsRequestsApi {
  private readonly mirror = new Map<string, PaymentRequestView>();
  private hydrated = false;
  private readonly drainFlight = new SingleFlight<void>();

  private journal: Map<string, SettlingLink> | null = null;
  private journalLoad: Promise<void> | null = null;
  private readonly journalChain = new SerialChain();

  private readonly payInFlight = new Map<string, Promise<TransferResult>>();
  private readonly reconcileFlight = new SingleFlight<void>();

  constructor(private readonly deps: RequestsDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  // ── settling journal (#441; single-flight load, serialized RMW) ──────────

  private ensureJournalLoaded(): Promise<void> {
    return (this.journalLoad ??= (async () => {
      let entries: [string, SettlingLink][] = [];
      try {
        const raw = await this.deps.kv.get<Record<string, SettlingLink>>(STORE_KEYS.settlingLinks);
        if (raw !== null && typeof raw === 'object') entries = Object.entries(raw);
      } catch (err) {
        // Corrupt blob: fail OPEN to empty (never wedge the pump/resume).
        logger.error('PaymentsV2', 'Settling journal unreadable — failing open to empty:', err);
      }
      this.journal = new Map(entries);
    })());
  }

  private mutateJournal(fn: (m: Map<string, SettlingLink>) => boolean): Promise<void> {
    return this.journalChain.enqueue(async () => {
      await this.ensureJournalLoaded();
      if (fn(this.journal!)) {
        await this.deps.kv.set(STORE_KEYS.settlingLinks, Object.fromEntries(this.journal!));
      }
    });
  }

  /** Idempotent for a same-transferId re-write: committed only ratchets up, createdAt kept. */
  private writeLink(requestId: string, transferId: string, committed: boolean): Promise<void> {
    return this.mutateJournal((m) => {
      const prev = m.get(requestId);
      const same = prev !== undefined && prev.transferId === transferId;
      const next: SettlingLink = {
        requestId,
        transferId,
        committed: committed || (same && prev.committed),
        createdAt: same ? prev.createdAt : this.now(),
      };
      if (same && prev.committed === next.committed) return false;
      m.set(requestId, next);
      return true;
    });
  }

  private clearLink(requestId: string): Promise<void> {
    return this.mutateJournal((m) => m.delete(requestId));
  }

  // ── incoming stream (gap-free ?since= upsert-by-id) ──────────────────────

  drainIncoming(): Promise<void> {
    return this.drainFlight.run(() => this.doDrain());
  }

  private async doDrain(): Promise<void> {
    // Journal must be in memory BEFORE any wire surfaces (settling hold).
    await this.ensureJournalLoaded();
    const persisted = await this.deps.kv.get<StreamCursor>(CURSOR_KEY);

    if (!this.hydrated) {
      // Fresh instance: the mirror is memory-only, rebuild ALL current state
      // from since=0 (open AND resolved), bounded pages; id-dedup absorbs replays.
      let page = await this.deps.client.listPaymentRequests({ role: 'incoming', since: 0 });
      for (let i = 0; i < MAX_HYDRATION_PAGES; i++) {
        for (const wire of page.requests) this.surface(wire);
        if (!page.more || typeof page.cursor !== 'number') break;
        page = await this.deps.client.listPaymentRequests({ role: 'incoming', since: page.cursor });
      }
      this.hydrated = true;
    }

    let since = typeof persisted?.cursor === 'number' ? persisted.cursor : 0;
    let page = await this.deps.client.listPaymentRequests({ role: 'incoming', since });
    if (persisted !== null && String(page.syncEpoch) !== persisted.syncEpoch) {
      since = 0; // epoch changed (server restore) — cursor continuity is void
      page = await this.deps.client.listPaymentRequests({ role: 'incoming', since: 0 });
    }
    for (;;) {
      for (const wire of page.requests) this.surface(wire);
      const record: StreamCursor = {
        cursor: typeof page.cursor === 'number' ? page.cursor : since,
        syncEpoch: String(page.syncEpoch),
      };
      await this.deps.kv.set(CURSOR_KEY, record);
      if (!page.more || typeof page.cursor !== 'number') break;
      since = page.cursor;
      page = await this.deps.client.listPaymentRequests({ role: 'incoming', since });
    }
  }

  private surface(wire: RequestWire): void {
    if (wire.toPubkey !== this.deps.ownPubkey) {
      logger.warn('PaymentsV2', `payment request ${wire.id.slice(0, 12)}… addressed to a different owner — dropped`);
      return;
    }

    let status = WIRE_STATUS[wire.status];
    const link = this.journal?.get(wire.id);
    if (link !== undefined) {
      if (wire.status === 'open') {
        status = 'settling'; // live link holds the request non-payable
      } else {
        // Server already resolved — the deferred tell landed elsewhere; drop the stale link.
        void this.clearLink(wire.id).catch((err) =>
          logger.warn('PaymentsV2', `failed to clear stale settling link for ${wire.id}:`, err)
        );
      }
    }

    const existing = this.mirror.get(wire.id);
    if (existing !== undefined) {
      // Upsert: advance INTO a terminal state, never out of one; never re-notify.
      if (TERMINAL.has(status) && !TERMINAL.has(existing.status)) this.setStatus(wire.id, status);
      return;
    }

    const bundle = this.decryptMemo(wire);
    const view: PaymentRequestView = {
      id: wire.id,
      requestId: wire.id,
      senderPubkey: wire.fromPubkey,
      ...(bundle.senderNametag !== undefined ? { senderNametag: bundle.senderNametag } : {}),
      amount: wire.assets[0]?.amount ?? '0',
      coinId: wire.assets[0]?.coinId ?? '',
      ...(bundle.memo !== undefined ? { message: bundle.memo } : {}),
      timestamp: Date.parse(wire.createdAt),
      status,
    };
    this.mirror.set(wire.id, view);
    if (status === 'pending') this.deps.emit('payment_request:incoming', { ...view });
  }

  private decryptMemo(wire: RequestWire): { memo?: string; senderNametag?: string } {
    if (wire.memo === undefined) return {};
    try {
      return this.deps.memo.decrypt(wire.fromPubkey, wire.memo);
    } catch {
      logger.debug('PaymentsV2', `payment request ${wire.id.slice(0, 12)}… memo not decryptable here`);
      return {};
    }
  }

  private setStatus(id: string, status: PaymentRequestStatus): void {
    const entry = this.mirror.get(id);
    if (entry === undefined || entry.status === status) return;
    entry.status = status;
    this.deps.emit('payment_request:updated', { id, status });
  }

  // ── public surface (PaymentsRequestsApi) ─────────────────────────────────

  list(): PaymentRequestView[] {
    const views = [...this.mirror.values()].map((entry) => ({
      ...entry,
      // A live settling link is NEVER payable, whatever the mirror says.
      status:
        entry.status === 'pending' && this.journal?.has(entry.id) ? ('settling' as const) : entry.status,
    }));
    return views.sort((a, b) => b.timestamp - a.timestamp || (a.id < b.id ? -1 : 1));
  }

  async create(
    to: string,
    terms: { coinId: string; amount: string; memo?: string }
  ): Promise<{ success: boolean; requestId?: string; error?: string }> {
    try {
      const toPubkey = CHAIN_PUBKEY_RE.test(to) ? to.toLowerCase() : await this.deps.resolvePubkey(to);
      if (toPubkey === null || toPubkey === undefined) {
        return { success: false, error: `Recipient ${to} has no published chain pubkey` };
      }
      const amount = BigInt(terms.amount);
      if (amount <= 0n) return { success: false, error: 'Amount must be a positive base-unit decimal string' };
      const senderNametag = this.deps.ownNametag?.();
      const envelope = this.deps.memo.encrypt(toPubkey, {
        ...(terms.memo !== undefined ? { memo: terms.memo } : {}),
        ...(senderNametag !== undefined ? { senderNametag } : {}),
      });
      const wire = await this.deps.client.createPaymentRequest({
        toPubkey,
        assets: [{ coinId: terms.coinId, amount: amount.toString() }],
        ...(envelope !== undefined ? { memo: envelope } : {}),
      });
      return { success: true, requestId: wire.id };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  pay(id: string): Promise<TransferResult> {
    // Per-request single-flight: a double-tap coalesces onto ONE send.
    const inFlight = this.payInFlight.get(id);
    if (inFlight !== undefined) return inFlight;
    const run = this.payInner(id).finally(() => {
      this.payInFlight.delete(id);
    });
    this.payInFlight.set(id, run);
    return run;
  }

  private async payInner(id: string): Promise<TransferResult> {
    await this.ensureJournalLoaded();
    const entry = this.mirror.get(id);
    if (entry === undefined) throw new SphereError(`Payment request not found: ${id}`, 'VALIDATION_ERROR');
    if (entry.status !== 'pending' || this.journal!.has(id)) {
      throw new SphereError(`Payment request is not payable: ${entry.status}`, 'VALIDATION_ERROR');
    }

    let result: TransferResult;
    try {
      result = await this.deps.send({
        recipient: entry.senderPubkey,
        amount: entry.amount,
        coinId: entry.coinId,
        ...(entry.message !== undefined ? { memo: entry.message } : {}),
      });
    } catch (error) {
      if (isPossiblyCommittedSendOutcome(error)) {
        const transferId =
          error instanceof SphereError && error.transferId !== undefined ? error.transferId : undefined;
        if (transferId !== undefined) {
          // Outcome unknown — link + 'settling', respond deferred to reconcile.
          const committed = error instanceof PartialSendConflictError;
          await this.settle(id, transferId, { committed, respond: false });
        } else {
          logger.error('PaymentsV2', `possibly-committed send for ${id} carried no transferId — paid (fail-closed)`);
          this.setStatus(id, 'paid');
        }
      } else {
        // Proven clean pre-commit failure — removal cause (b): payable, no link.
        await this.revertPayable(id);
      }
      throw error;
    }

    await this.settle(id, result.id, { committed: true, respond: true });
    return result;
  }

  /**
   * THE settlement invariant (#441 + the failed-respond P1): a settling link is
   * removed ONLY by (a) a CONFIRMED paid respond — a 2xx, or the 409
   * already-resolved absorb — or (b) a proven clean pre-commit failure
   * (revertPayable). Nothing else removes one: not a network error, not a 5xx,
   * not a reload. Every path that binds a request to a transfer outcome funnels
   * through here — pay()'s clean success (respond now), pay()'s
   * possibly-committed throw (respond deferred), and reconcile's deferred arms
   * — so a failed respond always leaves the link + 'settling' and the next
   * reconcile pass (the committed-link override) retries the respond.
   */
  private async settle(
    requestId: string,
    transferId: string,
    opts: { committed: boolean; respond: boolean }
  ): Promise<void> {
    // #441 — order is load-bearing: durable link BEFORE any flip, respond, or
    // rethrow. A crash in between leaves the link, so reload re-applies
    // 'settling', never re-payable.
    await this.writeLink(requestId, transferId, opts.committed);
    if (!(opts.respond && (await this.respondPaid(requestId, transferId)))) {
      this.setStatus(requestId, 'settling');
      return;
    }
    await this.clearLink(requestId);
    this.setStatus(requestId, 'paid');
  }

  /** 'paid' respond leg: 409 = already resolved = idempotent success; other errors defer. */
  private async respondPaid(id: string, transferId: string): Promise<boolean> {
    try {
      await this.deps.client.respondPaymentRequest(id, { action: 'paid', transferId });
      return true;
    } catch (err) {
      if (isConflict409(err)) return true;
      logger.warn('PaymentsV2', `paid respond failed for ${id} (deferred):`, err);
      return false;
    }
  }

  async decline(id: string): Promise<void> {
    const entry = this.mirror.get(id);
    if (entry === undefined) throw new SphereError(`Payment request not found: ${id}`, 'VALIDATION_ERROR');
    // A refused decline must never look like success — server 403/409 PROPAGATE.
    await this.deps.client.respondPaymentRequest(id, { action: 'declined' });
    this.setStatus(id, 'rejected');
  }

  dismissProcessed(): void {
    for (const [id, entry] of this.mirror) {
      if (TERMINAL.has(entry.status)) this.mirror.delete(id);
    }
  }

  // ── reconcile (#441, fed by resume outcomes) ─────────────────────────────

  reconcile(outcomes: ResumeOutcomes): Promise<void> {
    // Single-flight (§7: no sampled *InFlight booleans) — a concurrent call
    // coalesces onto the running pass instead of racing the journal.
    return this.reconcileFlight.run(() => this.doReconcile(outcomes));
  }

  private async doReconcile(outcomes: ResumeOutcomes): Promise<void> {
    await this.ensureJournalLoaded();
    if (this.journal!.size === 0) return;
    const resumed = new Set(outcomes.resumed);
    const conflicted = new Set(outcomes.conflicted);
    const open = new Set(outcomes.open);
    let aborted: Set<string> | null = null;

    for (const [requestId, link] of [...this.journal!]) {
      if (link.committed || resumed.has(link.transferId)) {
        // Value left the wallet (or the transfer completed) → deferred paid.
        await this.resolvePaid(requestId, link);
      } else if (conflicted.has(link.transferId)) {
        await this.revertPayable(requestId);
      } else if (open.has(link.transferId)) {
        // Still settling — keep the link, retry next session.
      } else {
        aborted = await this.reconcileUnaccounted(requestId, link, aborted);
      }
    }
  }

  // Unaccounted link: consult the server aborted authority (lazy, memoized);
  // a probe failure defers the link to the next session.
  private async reconcileUnaccounted(
    requestId: string,
    link: SettlingLink,
    aborted: Set<string> | null
  ): Promise<Set<string> | null> {
    try {
      aborted ??= new Set(await this.deps.listAbortedTransferIds());
      if (aborted.has(link.transferId)) await this.revertPayable(requestId);
      else await this.resolvePaid(requestId, link); // PAID-NEVER-RE-PAYABLE
    } catch (err) {
      logger.warn('PaymentsV2', `aborted-intent probe failed — ${requestId} deferred:`, err);
    }
    return aborted;
  }

  /** Deferred paid: the ONE settlement path again — a failed respond keeps the link. */
  private resolvePaid(requestId: string, link: SettlingLink): Promise<void> {
    return this.settle(requestId, link.transferId, { committed: link.committed, respond: true });
  }

  /** Removal cause (b): a PROVEN clean outcome (pre-commit failure / server-aborted). */
  private async revertPayable(requestId: string): Promise<void> {
    await this.clearLink(requestId);
    this.setStatus(requestId, 'pending');
  }
}
