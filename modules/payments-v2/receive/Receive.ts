// §5.7 of docs/PAYMENTS-V2-DESIGN.md — the single-flighted receive drain.
// Entry order is money-load-bearing: the view store precedes the claimed ack (#724).

import { logger } from '../../../core/logger';
import type { EngineVerifyResult, ITokenEngine, SphereToken } from '../../../token-engine';
import { isCoinlessEnvelope } from '../../../token-engine/value-envelope';
import type { IncomingTransfer, Token, Unverified } from '../../../types';
import { SingleFlight } from '../async';
import type { RegistryReader } from '../inventory/InventoryView';
import { unverifiedOnArrival, type ClaimReader } from '../inventory/verdicts';
import type { AttentionEmitter } from '../machine/journal';
import { isRetryableAckError } from '../ports';
import type { AckOutcome, AckRequest, DeliveryPort, IncomingDelivery } from '../ports';
import { STORE_KEYS, type ScopedKV, type StreamCursor } from '../stores';

export type ReceiveEngine = Pick<
  ITokenEngine,
  'getIdentity' | 'decodeToken' | 'verify' | 'isOwnedBy' | 'isSpent' | 'tokenId' | 'deliveryKeys'
>;

export interface IncomingAssetAmount {
  readonly coinId: string;
  readonly amount: string;
}

export interface StoredIncoming {
  readonly tokenId: string;
  readonly stateHash: string;
  readonly assets: readonly IncomingAssetAmount[];
  /** Genesis type of an arrival that names no coin (#777) — its only display handle. */
  readonly tokenType?: string;
  /** Claimed coins this arrival carries that do not count yet: of another type (`refused`), or not verifiable here (`pending`). */
  readonly unverified?: { readonly coinIds: readonly string[]; readonly standing: Unverified };
}

// Per-key seam over the inventory view (adapted by the facade in P9).
export interface ReceiveView {
  heldState(tokenId: string): string | null;
  store(entry: StoredIncoming): Promise<void>;
}

export interface ReceivedRecord {
  readonly dedupKey: string;
  readonly tokenId: string;
  readonly stateHash: string;
  readonly assets: readonly IncomingAssetAmount[];
  readonly tokenType?: string;
  readonly senderPubkey?: string;
  readonly senderNametag?: string;
  readonly memo?: string;
  readonly receivedAt: number;
}

export interface ReceiveDeps {
  readonly delivery: DeliveryPort;
  /** Snapshot taken once per drain (§7 collaborator-snapshot rule). */
  readonly engine: () => ReceiveEngine;
  readonly claims?: ClaimReader;
  readonly accepted?: (token: SphereToken) => Promise<void>;
  readonly view: ReceiveView;
  readonly kv: ScopedKV;
  readonly registry: RegistryReader;
  readonly recordReceived: (record: ReceivedRecord) => Promise<void>;
  readonly emit: (event: 'transfer:incoming', transfer: IncomingTransfer) => void;
  /** Refresh the inventory mirror mid-drain; fire-and-forget. Receive throttles the calls. */
  readonly refreshView?: () => void;
  readonly attention: AttentionEmitter;
  readonly syncEpoch: () => string;
  readonly track?: (op: Promise<unknown>) => void;
  readonly now?: () => number;
}

export const ACK_BATCH_SIZE = 200;
/**
 * Mid-drain mirror refresh cadence. Coarse because a refresh flushes acks and
 * costs an inventory round trip, both on the drain's critical path. It shipped
 * at 750 ms first, which is SHORTER than the ~1 s a token takes, so the throttle
 * never throttled: every token paid for one and a 54-token receive stretched to
 * ~58 s. Any value below the per-token cost has that effect.
 */
export const REFRESH_INTERVAL_MS = 2500;
export const POLL_INTERVAL_MS = 30_000;
/** An entry whose mint reason is not verifiable yet is rechecked after this, doubling up to RECHECK_MAX_MS. */
export const RECHECK_BASE_MS = POLL_INTERVAL_MS;
export const RECHECK_MAX_MS = 60 * 60 * 1000;
/** Each recheck is a listing page, a blob fetch and a verify inside the drain; this bounds what one drain spends on them. */
export const RECHECKS_PER_DRAIN = 20;
export const ATTENTION_CLAIM_CONFLICT = 'claim:conflict';
/** Raised once per entry whose mint reason this wallet cannot verify yet; the detail is the delivery id, a space, then the reason. */
export const ATTENTION_UNVERIFIABLE = 'receive:unverifiable';

export function receivedDedupKey(tokenId: string, stateHash: string): string {
  // Lowercased like History's keys — a case-variant would defeat server dedup.
  return `RECEIVED:${tokenId.toLowerCase()}:${stateHash.toLowerCase()}`;
}

/** A deferred entry settles like an ack for the cursor's sake, with no call to the server. */
interface PendingAck {
  readonly deliveryId: string;
  readonly disposition: 'claimed' | 'rejected' | 'deferred';
  readonly reason?: 'invalid' | 'not-owned' | 'other';
  readonly cursor: string;
  readonly transferId?: string;
}

type Screened =
  | { kind: 'ack'; ack: PendingAck }
  | { kind: 'accept'; record: StoredIncoming; token: SphereToken }
  | { kind: 'defer'; reason: string };

/** An entry parked until its mint reason can be judged; `since` lists it again on its own. */
export interface DeferredDelivery {
  readonly deliveryId: string;
  readonly since: string | null;
  readonly syncEpoch: string;
  readonly attempts: number;
  readonly dueAtMs: number;
}

/** The parked entries of one drain, written back before any cursor write that would pass a new one. */
class ParkedSet {
  private readonly records: Map<string, DeferredDelivery>;
  private persisted: string;

  constructor(
    private readonly deps: ReceiveDeps,
    stored: readonly DeferredDelivery[]
  ) {
    // Records from another sync epoch are dropped: their positions no longer
    // mean anything, and the full re-listing finds the entries again.
    const current = stored.filter((r) => r.syncEpoch === deps.syncEpoch());
    this.records = new Map(current.map((r) => [r.deliveryId, r]));
    this.persisted = JSON.stringify(stored);
  }

  get(deliveryId: string): DeferredDelivery | undefined {
    return this.records.get(deliveryId);
  }

  set(record: DeferredDelivery): void {
    this.records.set(record.deliveryId, record);
  }

  delete(deliveryId: string): void {
    this.records.delete(deliveryId);
  }

  due(now: number): DeferredDelivery[] {
    return [...this.records.values()].filter((r) => now >= r.dueAtMs);
  }

  /** False when the store refused the write; the caller then treats the new entries as not yet parked. */
  async save(): Promise<boolean> {
    const next = JSON.stringify([...this.records.values()]);
    if (next === this.persisted) return true;
    try {
      await this.deps.kv.set(STORE_KEYS.deferred('mailbox'), [...this.records.values()]);
    } catch (err) {
      logger.warn('PaymentsV2', 'receive: parked entries could not be saved — the cursor holds before them:', err);
      return false;
    }
    this.persisted = next;
    return true;
  }
}

/** The mutable state one listing pass threads through (max-params ≤ 5). */
interface DrainPass {
  readonly deps: ReceiveDeps;
  readonly engine: ReceiveEngine;
  readonly pending: PendingAck[];
  readonly stored: IncomingTransfer[];
  readonly pageEpoch: () => string;
  /** Entries this drain made claimable — stored, or a held-state claim retry. */
  readonly claimable: { n: number };
  readonly parked: ParkedSet;
  /** The cursor the current listing would resume from to see the entry in hand first. */
  readonly previousCursor: { value: string | null };
}

function isClaimConflict(err: unknown): boolean {
  const e = err !== null && typeof err === 'object' ? (err as { code?: unknown; failureCode?: unknown }) : null;
  return e !== null && e.code === 'MAILBOX_CLAIM_FAILED' && e.failureCode === 'CONFLICT';
}

export class Receive {
  private readonly drainFlight = new SingleFlight<IncomingTransfer[]>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeWake: (() => void) | null = null;
  private lastRefreshAt = 0;

  constructor(private readonly deps: ReceiveDeps) {}

  drainOnce(): Promise<IncomingTransfer[]> {
    return this.drainFlight.run(() => this.doDrain());
  }

  start(pollIntervalMs: number = POLL_INTERVAL_MS): void {
    this.unsubscribeWake ??= this.deps.delivery.onWake?.(() => this.spawnDrain()) ?? null;
    this.pollTimer ??= setInterval(() => this.spawnDrain(), pollIntervalMs);
  }

  private spawnDrain(): void {
    const op = this.drainOnce();
    if (this.deps.track !== undefined) this.deps.track(op);
    else void op;
  }

  stop(): void {
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.unsubscribeWake?.();
    this.unsubscribeWake = null;
  }

  /** The arrivals this wallet could not verify yet, for a listener that attached after their attention event. */
  async parked(): Promise<readonly DeferredDelivery[]> {
    return (await this.deps.kv.get<DeferredDelivery[]>(STORE_KEYS.deferred('mailbox'))) ?? [];
  }

  /**
   * Flush what has been accepted, then ask for a mirror refresh — at most once
   * per REFRESH_INTERVAL_MS.
   *
   * The flush is not incidental. A `claimed` ack is what materializes a token
   * into SERVER inventory, and acks otherwise sit queued until ACK_BATCH_SIZE
   * (200) — so for any ordinary drain, including the 54-token case this exists
   * for, refreshing before the flush would query an inventory holding none of
   * the tokens just accepted, and the balance would still only move at the end.
   * Ordering is preserved: store() still precedes the ack (§5.7).
   */
  private async maybeRefresh(ctx: DrainPass): Promise<void> {
    const { deps } = ctx;
    if (deps.refreshView === undefined) return;
    const now = deps.now?.() ?? Date.now();
    if (now - this.lastRefreshAt < REFRESH_INTERVAL_MS) return;
    this.lastRefreshAt = now;
    // A blocked flush materialized nothing, so the delta would show today's balance.
    if ((await flushAcks(ctx)).progressed) deps.refreshView();
  }

  /** One listing pass: process each entry, flushing and refreshing as it goes. */
  private async drainPages(ctx: DrainPass, basis: StreamCursor | null): Promise<void> {
    const { deps, pending, claimable } = ctx;
    ctx.previousCursor.value = basis === null ? null : String(basis.cursor);
    for await (const entry of deps.delivery.incoming(basis === null ? undefined : String(basis.cursor))) {
      const claimableBefore = claimable.n;
      await this.processEntry(ctx, entry);
      ctx.previousCursor.value = entry.cursor;
      if (pending.length >= ACK_BATCH_SIZE) {
        // Nothing settled = the head is blocked; continuing re-flushes it once per
        // remaining entry, amplifying one failure into hundreds.
        if (!(await flushAcks(ctx)).progressed) return;
      }
      // Only when THIS entry entered the balance: a rejected one changes nothing.
      // Keyed on claimable, not stored — a held-state RETRY claims without storing,
      // and a long retry drain is the frozen balance this PR exists to fix.
      if (claimable.n > claimableBefore) await this.maybeRefresh(ctx);
    }
    await flushAcks(ctx);
  }

  private async doDrain(): Promise<IncomingTransfer[]> {
    const deps = this.deps;
    // Clock starts at the drain: one finishing inside an interval refreshes once,
    // at the end, exactly as before. Only a slow drain pays for mid-flight ones.
    this.lastRefreshAt = deps.now?.() ?? Date.now();
    const engine = deps.engine();
    const stored: IncomingTransfer[] = [];
    const pending: PendingAck[] = [];
    // The port's page epoch is the honest source for the persisted record.
    const pageEpoch = (): string => deps.delivery.incomingEpoch() ?? deps.syncEpoch();
    // Every exit refreshes (automatic drains never call receive(), and the §5.7
    // wake is best-effort), counted where the entry becomes claimable — every
    // downstream proxy had a path that destroyed it.
    const claimable = { n: 0 };
    const parked = new ParkedSet(deps, (await deps.kv.get<DeferredDelivery[]>(STORE_KEYS.deferred('mailbox'))) ?? []);
    const ctx: DrainPass = { deps, engine, pending, stored, pageEpoch, claimable, parked, previousCursor: { value: null } };
    const finish = async (): Promise<IncomingTransfer[]> => {
      await parked.save();
      if (claimable.n > 0) deps.refreshView?.();
      return stored;
    };
    try {
      const record = await deps.kv.get<StreamCursor>(STORE_KEYS.streamCursor('mailbox'));
      // Cursor continuity holds only within one syncEpoch (§6); the session
      // latch gates the resume decision.
      let basis = record !== null && record.syncEpoch === deps.syncEpoch() ? record : null;
      for (let pass = 0; pass < 2; pass++) {
        await this.drainPages(ctx, basis);
        const served = deps.delivery.incomingEpoch();
        if (basis === null || served === null || served === basis.syncEpoch) break;
        // §5.7 restore self-detection: the page reports a different epoch than
        // the cursor record's — post-restore seqs restart, so the resumed
        // listing may have SKIPPED entries. Void the continuity record and
        // re-list from the start (dedup: seen-set + (tokenId, stateHash)).
        await deps.kv.remove(STORE_KEYS.streamCursor('mailbox'));
        basis = null;
      }
      await this.recheckParked(ctx);
    } catch (err) {
      // Infra failure (engine/blob/view/ack): the failed entry stays UNACKED and
      // re-lists next drain; the fully-processed prefix still flushes below.
      logger.warn('PaymentsV2', 'receive drain interrupted — unacked entries retry next drain:', err);
      // Retryable = the wall is still up; re-flushing spends another slot. Exits
      // via finish() because ackBatch kept its committed chunks, which never re-list.
      if (isRetryableAckError(err)) return finish();
      await flushAcks(ctx).catch((flushErr: unknown) => {
        logger.warn('PaymentsV2', 'receive ack flush failed — cursor holds at the acked prefix:', flushErr);
        return { progressed: false };
      });
    }
    return finish();
  }

  private async processEntry(ctx: DrainPass, entry: IncomingDelivery): Promise<void> {
    const { deps, engine, stored, claimable } = ctx;
    const parked = ctx.parked.get(entry.deliveryId);
    if (parked !== undefined && this.now() < parked.dueAtMs) {
      queueAck(ctx, deferredAck(entry));
      return;
    }
    const screened = await screen(deps, engine, entry);
    if (screened.kind === 'defer') {
      this.park(ctx, entry, parked, screened.reason);
      queueAck(ctx, deferredAck(entry));
      return;
    }
    if (screened.kind === 'ack') {
      queueAck(ctx, screened.ack);
      // A held-state re-list is the retry after a failed ack: nothing to store,
      // but it still materializes server-side.
      if (screened.ack.disposition === 'claimed') claimable.n += 1;
      return;
    }
    await deps.accepted?.(screened.token);
    await deps.view.store(screened.record);
    queueAck(ctx, claimAck(entry));
    claimable.n += 1;
    const transfer = await announce(deps, entry, screened.record);
    stored.push(transfer);
    deps.emit('transfer:incoming', transfer);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private park(ctx: DrainPass, entry: IncomingDelivery, previous: DeferredDelivery | undefined, reason: string): void {
    const attempts = (previous?.attempts ?? 0) + 1;
    ctx.parked.set({
      deliveryId: entry.deliveryId,
      since: ctx.previousCursor.value,
      syncEpoch: ctx.pageEpoch(),
      attempts,
      dueAtMs: this.now() + backoff(attempts),
    });
    if (previous !== undefined) return;
    logger.warn('PaymentsV2', `receive: ${entry.deliveryId} parked, its mint reason cannot be verified here yet: ${reason}`);
    ctx.deps.attention(entry.transferId ?? '', ATTENTION_UNVERIFIABLE, `${entry.deliveryId} ${reason}`);
  }

  /** Each parked entry that is due is listed again from just before its position, on its own. */
  private async recheckParked(ctx: DrainPass): Promise<void> {
    for (const record of ctx.parked.due(this.now()).slice(0, RECHECKS_PER_DRAIN)) {
      const pass: DrainPass = { ...ctx, pending: [], previousCursor: { value: record.since } };
      try {
        await this.recheckOne(pass, record);
        await settleOffPath(pass);
      } catch (err) {
        // A wall on the ack side (429, outage) is not the entry's fault: it is due
        // again at once and the other rechecks wait for the next drain. Anything
        // else (listing, blob, verify) costs only this record its turn.
        if (isRetryableAckError(err)) {
          ctx.parked.set({ ...record, dueAtMs: this.now() });
          return;
        }
        logger.warn('PaymentsV2', `receive: recheck of ${record.deliveryId} failed, backing it off:`, err);
        ctx.parked.set({ ...record, attempts: record.attempts + 1, dueAtMs: this.now() + backoff(record.attempts + 1) });
      }
    }
  }

  private async recheckOne(ctx: DrainPass, record: DeferredDelivery): Promise<void> {
    for await (const entry of ctx.deps.delivery.incoming(record.since ?? undefined)) {
      if (entry.deliveryId === record.deliveryId) {
        await this.processEntry(ctx, entry);
        return;
      }
      break;
    }
    logger.warn('PaymentsV2', `receive: parked ${record.deliveryId} is no longer listed, forgetting it`);
    ctx.parked.delete(record.deliveryId);
  }
}

function backoff(attempts: number): number {
  return Math.min(RECHECK_BASE_MS * 2 ** (attempts - 1), RECHECK_MAX_MS);
}

async function screen(deps: ReceiveDeps, engine: ReceiveEngine, entry: IncomingDelivery): Promise<Screened> {
  const blobBytes = await entry.fetchBlob();
  let token: SphereToken;
  try {
    token = await engine.decodeToken({ tokenId: '', token: blobBytes });
  } catch (err) {
    logger.warn('PaymentsV2', `receive: undecodable blob rejected — ${String(err)}`);
    return { kind: 'ack', ack: rejectAck(entry, 'invalid') };
  }
  const verdict = await verdictOf(engine, token);
  if (typeof verdict === 'string') return { kind: 'defer', reason: verdict };
  if (!verdict.ok) return { kind: 'ack', ack: rejectAck(entry, 'invalid') };
  if (!engine.isOwnedBy(token, engine.getIdentity().chainPubkey)) {
    return { kind: 'ack', ack: rejectAck(entry, 'not-owned') };
  }
  const keys = await engine.deliveryKeys(blobBytes);
  const held = deps.view.heldState(keys.tokenId);
  if (held === keys.stateHash) return { kind: 'ack', ack: claimAck(entry) };
  if (held !== null && (await engine.isSpent(token))) {
    // #687 gate: a replayed OLDER, already-spent state never displaces the live one.
    return { kind: 'ack', ack: rejectAck(entry, 'invalid') };
  }
  const unverified = deps.claims === undefined ? null : unverifiedOnArrival(deps.claims, token);
  return {
    kind: 'accept',
    token,
    record: {
      tokenId: keys.tokenId,
      stateHash: keys.stateHash,
      assets: toAssetAmounts(token),
      ...(isCoinlessEnvelope(token.valueEnvelope) ? { tokenType: token.tokenType } : {}),
      ...(unverified !== null ? { unverified } : {}),
    },
  };
}

/** A string = the mint reason is not verifiable yet, and why: leave the entry unacked, never reject a token that may be valid. */
async function verdictOf(engine: ReceiveEngine, token: SphereToken): Promise<EngineVerifyResult | string> {
  try {
    return await engine.verify(token);
  } catch (err) {
    if (isUnverifiable(err)) return err.message;
    throw err;
  }
}

/** Read structurally, as a facade and an engine from separate bundles do not share an error class. */
function isUnverifiable(err: unknown): err is { code: 'MINT_REASON_UNVERIFIABLE'; message: string } {
  return err !== null && typeof err === 'object' && (err as { code?: unknown }).code === 'MINT_REASON_UNVERIFIABLE';
}

async function announce(
  deps: ReceiveDeps,
  entry: IncomingDelivery,
  record: StoredIncoming
): Promise<IncomingTransfer> {
  const receivedAt = (deps.now ?? Date.now)();
  await recordArrival(deps, entry, record, receivedAt);
  const unverified = record.unverified;
  const held = record.assets.filter((asset) => unverified?.coinIds.includes(asset.coinId));
  const counted = record.assets.filter((asset) => !held.includes(asset));
  return {
    id: record.tokenId,
    senderPubkey: entry.senderPubkey ?? '',
    ...(entry.senderNametag !== undefined ? { senderNametag: entry.senderNametag } : {}),
    tokens: counted.map((asset) => toUiToken(record.tokenId, asset, deps.registry, receivedAt)),
    ...(unverified !== undefined && held.length > 0
      ? { unverifiedTokens: held.map((asset) => ({ ...toUiToken(record.tokenId, asset, deps.registry, receivedAt), unverified: unverified.standing })) }
      : {}),
    // #777: named here rather than mapped from assets, which announced an EMPTY list.
    ...(record.tokenType !== undefined
      ? {
          coinless: [
            {
              tokenId: record.tokenId,
              tokenType: record.tokenType,
              stateHash: record.stateHash,
              transferring: false,
              createdAt: receivedAt,
              updatedAt: receivedAt,
            },
          ],
        }
      : {}),
    ...(entry.memo !== undefined ? { memo: entry.memo } : {}),
    receivedAt,
  };
}

async function recordArrival(
  deps: ReceiveDeps,
  entry: IncomingDelivery,
  record: StoredIncoming,
  receivedAt: number
): Promise<void> {
  const assets = record.assets.filter((asset) => !record.unverified?.coinIds.includes(asset.coinId));
  if (assets.length === 0 && record.unverified !== undefined) return;
  try {
    await deps.recordReceived({
      dedupKey: receivedDedupKey(record.tokenId, record.stateHash),
      tokenId: record.tokenId,
      stateHash: record.stateHash,
      assets,
      ...(record.tokenType !== undefined ? { tokenType: record.tokenType } : {}),
      ...(entry.senderPubkey !== undefined ? { senderPubkey: entry.senderPubkey } : {}),
      ...(entry.senderNametag !== undefined ? { senderNametag: entry.senderNametag } : {}),
      ...(entry.memo !== undefined ? { memo: entry.memo } : {}),
      receivedAt,
    });
  } catch (err) {
    // §5.9: the history hook never fails the money path.
    logger.debug('PaymentsV2', 'RECEIVED history hook failed (money path unaffected):', err);
  }
}

/** Cursor reaches only the last CONSECUTIVE success. progressed=false means nothing settled. */
async function flushAcks(ctx: DrainPass): Promise<{ progressed: boolean }> {
  const { deps, pending, pageEpoch } = ctx;
  if (pending.length === 0) return { progressed: true };
  const before = pending.length;
  let lastAcked: string | null = null;
  try {
    const settled = await settleAcks(ctx);
    let i = 0;
    while (i < pending.length && settled.has(pending[i].deliveryId)) {
      lastAcked = pending[i].cursor;
      i += 1;
    }
    dropSettled(ctx, settled);
  } finally {
    if (lastAcked !== null) {
      const record: StreamCursor = { cursor: lastAcked, syncEpoch: pageEpoch() };
      await deps.kv.set(STORE_KEYS.streamCursor('mailbox'), record);
    }
  }
  return { progressed: pending.length < before };
}

/**
 * Drop every settled entry, not just the prefix: a later flush must never re-ack
 * one that already settled. A parked entry leaves the set only with its settled
 * ack; one whose ack did not settle is due again at once.
 */
function dropSettled(ctx: DrainPass, settled: ReadonlySet<string>): void {
  const { pending, parked } = ctx;
  for (const p of pending) {
    if (p.disposition === 'deferred') continue;
    const record = parked.get(p.deliveryId);
    if (record === undefined) continue;
    if (settled.has(p.deliveryId)) parked.delete(p.deliveryId);
    else parked.set({ ...record, dueAtMs: ctx.deps.now?.() ?? Date.now() });
  }
  const stuck = pending.filter((p) => !settled.has(p.deliveryId));
  pending.length = 0;
  pending.push(...stuck);
}

/** Acks from a recheck listing settle without touching the cursor, which already lies past them. */
async function settleOffPath(ctx: DrainPass): Promise<void> {
  if (ctx.pending.length === 0) return;
  dropSettled(ctx, await settleAcks(ctx));
}

/**
 * Batched when the port offers it, one at a time otherwise; never reorders `pending`.
 * A deferred entry settles only once its parked record is saved, or the cursor
 * would pass an entry nothing remembers.
 */
async function settleAcks(ctx: DrainPass): Promise<Set<string>> {
  const { deps, pending } = ctx;
  const deferredSettle = await ctx.parked.save();
  const toSend = pending.filter((p) => p.disposition !== 'deferred');
  const batch = deps.delivery.ackBatch?.bind(deps.delivery);
  if (batch === undefined) return settleOneByOne(deps, pending, deferredSettle);
  const settled = new Set(deferredSettle ? pending.filter((p) => p.disposition === 'deferred').map((p) => p.deliveryId) : []);
  if (toSend.length === 0) return settled;
  let outcomes: readonly AckOutcome[];
  try {
    outcomes = await batch(toSend.map(toAckRequest));
  } catch (err) {
    // A wall a per-entry retry would hit too (429, outage): falling back turns
    // one transient failure into N of them.
    if (isRetryableAckError(err)) throw err;
    logger.warn('PaymentsV2', 'batched mailbox ack failed — settling one at a time:', err);
    return settleOneByOne(deps, pending, deferredSettle);
  }
  for (const o of outcomes) if (o.status === 'settled') settled.add(o.deliveryId);
  const conflicts = outcomes.filter((o) => o.status === 'conflict').map((o) => o.deliveryId);
  if (conflicts.length > 0) await resolveConflicts(deps, toSend, conflicts, settled);
  return settled;
}

/** Settled only once its reject succeeded, so a failed reject holds the cursor. */
async function resolveConflicts(
  deps: ReceiveDeps,
  pending: readonly PendingAck[],
  conflicts: readonly string[],
  settled: Set<string>
): Promise<void> {
  for (const deliveryId of conflicts) {
    const entry = pending.find((p) => p.deliveryId === deliveryId);
    try {
      await rejectStaleClaim(deps, deliveryId, entry?.transferId);
    } catch (err) {
      logger.warn('PaymentsV2', `stale-reject failed for ${deliveryId} — cursor holds here:`, err);
      continue;
    }
    settled.add(deliveryId);
  }
}

/** §5.7: a stale claim is terminal for discovery, or the entry re-processes forever. */
async function rejectStaleClaim(deps: ReceiveDeps, deliveryId: string, transferId?: string): Promise<void> {
  logger.warn('PaymentsV2', `mailbox claim CONFLICT for ${deliveryId} — rejected('other') as stale`);
  await deps.delivery.ack(deliveryId, 'rejected', 'other');
  deps.attention(transferId ?? '', ATTENTION_CLAIM_CONFLICT, deliveryId);
}

/** Today's loop, in seq order, stopping at the first failure. */
async function settleOneByOne(
  deps: ReceiveDeps,
  pending: readonly PendingAck[],
  deferredSettle: boolean
): Promise<Set<string>> {
  const settled = new Set<string>();
  for (const ack of pending) {
    if (ack.disposition === 'deferred') {
      if (deferredSettle) settled.add(ack.deliveryId);
      continue;
    }
    try {
      await ackOne(deps, ack);
    } catch (err) {
      logger.warn('PaymentsV2', `mailbox ack failed for ${ack.deliveryId} — cursor holds here:`, err);
      break;
    }
    settled.add(ack.deliveryId);
  }
  return settled;
}

function toAckRequest(ack: PendingAck): AckRequest {
  return {
    deliveryId: ack.deliveryId,
    disposition: ack.disposition === 'claimed' ? 'claimed' : 'rejected',
    ...(ack.reason !== undefined ? { reason: ack.reason } : {}),
  };
}

async function ackOne(deps: ReceiveDeps, ack: PendingAck): Promise<void> {
  try {
    await deps.delivery.ack(ack.deliveryId, ack.disposition === 'claimed' ? 'claimed' : 'rejected', ack.reason);
  } catch (err) {
    if (ack.disposition !== 'claimed' || !isClaimConflict(err)) throw err;
    await rejectStaleClaim(deps, ack.deliveryId, ack.transferId);
  }
}

function queueAck(ctx: DrainPass, ack: PendingAck): void {
  ctx.pending.push(ack);
}

function deferredAck(entry: IncomingDelivery): PendingAck {
  return { deliveryId: entry.deliveryId, disposition: 'deferred', cursor: entry.cursor };
}

function claimAck(entry: IncomingDelivery): PendingAck {
  return {
    deliveryId: entry.deliveryId,
    disposition: 'claimed',
    cursor: entry.cursor,
    ...(entry.transferId !== undefined ? { transferId: entry.transferId } : {}),
  };
}

function rejectAck(entry: IncomingDelivery, reason: 'invalid' | 'not-owned'): PendingAck {
  return { deliveryId: entry.deliveryId, disposition: 'rejected', reason, cursor: entry.cursor };
}


function toAssetAmounts(token: SphereToken): IncomingAssetAmount[] {
  return (token.value?.assets ?? []).map((asset) => ({
    coinId: asset.coinId,
    amount: asset.amount.toString(),
  }));
}

function toUiToken(
  tokenId: string,
  asset: IncomingAssetAmount,
  registry: RegistryReader,
  receivedAt: number
): Token {
  const iconUrl = registry.getIconUrl(asset.coinId);
  return {
    id: tokenId,
    coinId: asset.coinId,
    symbol: registry.getSymbol(asset.coinId),
    name: registry.getName(asset.coinId),
    decimals: registry.getDecimals(asset.coinId),
    ...(iconUrl !== null ? { iconUrl } : {}),
    amount: asset.amount,
    status: 'confirmed',
    createdAt: receivedAt,
    updatedAt: receivedAt,
    lazy: true,
  };
}
