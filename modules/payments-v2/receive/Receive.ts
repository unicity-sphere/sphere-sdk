// §5.7 of docs/PAYMENTS-V2-DESIGN.md — the single-flighted receive drain.
// Entry order is money-load-bearing: the view store precedes the claimed ack,
// so a claimed/acked token can never be absent from the view (#724 outcome).

import { logger } from '../../../core/logger';
import type { ITokenEngine, SphereToken } from '../../../token-engine';
import { TOKEN_BLOB_VERSION } from '../../../token-engine/token-blob';
import type { IncomingTransfer, Token } from '../../../types';
import { SingleFlight } from '../async';
import type { RegistryReader } from '../inventory/InventoryView';
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
  readonly senderPubkey?: string;
  readonly senderNametag?: string;
  readonly memo?: string;
  readonly receivedAt: number;
}

export interface ReceiveDeps {
  readonly delivery: DeliveryPort;
  /** Snapshot taken once per drain (§7 collaborator-snapshot rule). */
  readonly engine: () => ReceiveEngine;
  readonly view: ReceiveView;
  readonly kv: ScopedKV;
  readonly registry: RegistryReader;
  readonly recordReceived: (record: ReceivedRecord) => Promise<void>;
  readonly emit: (event: 'transfer:incoming', transfer: IncomingTransfer) => void;
  /** Refresh the inventory mirror mid-drain; fire-and-forget. Receive throttles the calls. */
  readonly refreshView?: () => void;
  readonly attention: AttentionEmitter;
  readonly syncEpoch: () => string;
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
export const ATTENTION_CLAIM_CONFLICT = 'claim:conflict';

export function receivedDedupKey(tokenId: string, stateHash: string): string {
  // Lowercased like History's keys — a case-variant would defeat server dedup.
  return `RECEIVED:${tokenId.toLowerCase()}:${stateHash.toLowerCase()}`;
}

interface PendingAck {
  readonly deliveryId: string;
  readonly disposition: 'claimed' | 'rejected';
  readonly reason?: 'invalid' | 'not-owned' | 'other';
  readonly cursor: string;
  readonly transferId?: string;
}

type Screened = { kind: 'ack'; ack: PendingAck } | { kind: 'accept'; record: StoredIncoming };

/** The mutable state one listing pass threads through (max-params ≤ 5). */
interface DrainPass {
  readonly deps: ReceiveDeps;
  readonly engine: ReceiveEngine;
  readonly pending: PendingAck[];
  readonly stored: IncomingTransfer[];
  readonly pageEpoch: () => string;
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
    this.unsubscribeWake ??=
      this.deps.delivery.onWake?.(() => {
        void this.drainOnce();
      }) ?? null;
    this.pollTimer ??= setInterval(() => {
      void this.drainOnce();
    }, pollIntervalMs);
  }

  stop(): void {
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.unsubscribeWake?.();
    this.unsubscribeWake = null;
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
  private async maybeRefresh(deps: ReceiveDeps, pending: PendingAck[], epochOf: () => string): Promise<void> {
    if (deps.refreshView === undefined) return;
    const now = deps.now?.() ?? Date.now();
    if (now - this.lastRefreshAt < REFRESH_INTERVAL_MS) return;
    this.lastRefreshAt = now;
    await flushAcks(deps, pending, epochOf);
    deps.refreshView();
  }

  /** One listing pass: process each entry, flushing and refreshing as it goes. */
  private async drainPages(ctx: DrainPass, basis: StreamCursor | null): Promise<void> {
    const { deps, engine, pending, stored, pageEpoch } = ctx;
    for await (const entry of deps.delivery.incoming(basis === null ? undefined : String(basis.cursor))) {
      const storedBefore = stored.length;
      await this.processEntry(deps, engine, entry, pending, stored);
      if (pending.length >= ACK_BATCH_SIZE) await flushAcks(deps, pending, pageEpoch);
      // Only when THIS entry entered the balance: a rejected one changes nothing
      // to show, and refreshing for it is a wasted round trip.
      if (stored.length > storedBefore) await this.maybeRefresh(deps, pending, pageEpoch);
    }
    await flushAcks(deps, pending, pageEpoch);
  }

  private async doDrain(): Promise<IncomingTransfer[]> {
    const deps = this.deps;
    // Start the clock at the drain, so a drain that finishes inside one interval
    // behaves exactly as before — acks batch at ACK_BATCH_SIZE and the mirror is
    // refreshed once, at the end. Only a drain slow enough for the user to sit
    // watching a stale balance pays for mid-flight refreshes.
    this.lastRefreshAt = deps.now?.() ?? Date.now();
    const engine = deps.engine();
    const stored: IncomingTransfer[] = [];
    const pending: PendingAck[] = [];
    // The port's page epoch is the honest source for the persisted record.
    const pageEpoch = (): string => deps.delivery.incomingEpoch() ?? deps.syncEpoch();
    try {
      const record = await deps.kv.get<StreamCursor>(STORE_KEYS.streamCursor('mailbox'));
      // Cursor continuity holds only within one syncEpoch (§6); the session
      // latch gates the resume decision.
      let basis = record !== null && record.syncEpoch === deps.syncEpoch() ? record : null;
      for (let pass = 0; pass < 2; pass++) {
        await this.drainPages({ deps, engine, pending, stored, pageEpoch }, basis);
        const served = deps.delivery.incomingEpoch();
        if (basis === null || served === null || served === basis.syncEpoch) break;
        // §5.7 restore self-detection: the page reports a different epoch than
        // the cursor record's — post-restore seqs restart, so the resumed
        // listing may have SKIPPED entries. Void the continuity record and
        // re-list from the start (dedup: seen-set + (tokenId, stateHash)).
        await deps.kv.remove(STORE_KEYS.streamCursor('mailbox'));
        basis = null;
      }
    } catch (err) {
      // Infra failure (engine/blob/view/ack): the failed entry stays UNACKED and
      // re-lists next drain; the fully-processed prefix still flushes below.
      logger.warn('PaymentsV2', 'receive drain interrupted — unacked entries retry next drain:', err);
      // A retryable ack failure means the wall is still up; re-flushing here just
      // spends another rate-limit slot on it. The entries re-list next drain.
      if (isRetryableAckError(err)) return stored;
      await flushAcks(deps, pending, pageEpoch).catch((flushErr: unknown) => {
        logger.warn('PaymentsV2', 'receive ack flush failed — cursor holds at the acked prefix:', flushErr);
      });
    }
    // Automatic drains (§9 mailbox wake, 30 s poll) never call receive(), and a
    // drain shorter than REFRESH_INTERVAL_MS takes no mid-drain refresh — so
    // without this their only refresh is the inventory wake, which §5.7 declares
    // best-effort. Coalesced, so it costs at most one delta.
    if (stored.length > 0) deps.refreshView?.();
    return stored;
  }

  private async processEntry(
    deps: ReceiveDeps,
    engine: ReceiveEngine,
    entry: IncomingDelivery,
    pending: PendingAck[],
    stored: IncomingTransfer[]
  ): Promise<void> {
    const screened = await screen(deps, engine, entry);
    if (screened.kind === 'ack') {
      pending.push(screened.ack);
      return;
    }
    await deps.view.store(screened.record);
    pending.push(claimAck(entry));
    const transfer = await announce(deps, entry, screened.record);
    stored.push(transfer);
    deps.emit('transfer:incoming', transfer);
  }
}

async function screen(deps: ReceiveDeps, engine: ReceiveEngine, entry: IncomingDelivery): Promise<Screened> {
  const blobBytes = await entry.fetchBlob();
  let token: SphereToken;
  try {
    token = await engine.decodeToken({
      v: TOKEN_BLOB_VERSION,
      network: 0,
      tokenId: '',
      token: blobBytes,
    });
  } catch {
    return { kind: 'ack', ack: rejectAck(entry, 'invalid') };
  }
  const verdict = await engine.verify(token);
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
  return {
    kind: 'accept',
    record: { tokenId: keys.tokenId, stateHash: keys.stateHash, assets: toAssetAmounts(token) },
  };
}

async function announce(
  deps: ReceiveDeps,
  entry: IncomingDelivery,
  record: StoredIncoming
): Promise<IncomingTransfer> {
  const receivedAt = (deps.now ?? Date.now)();
  try {
    await deps.recordReceived({
      dedupKey: receivedDedupKey(record.tokenId, record.stateHash),
      tokenId: record.tokenId,
      stateHash: record.stateHash,
      assets: record.assets,
      ...(entry.senderPubkey !== undefined ? { senderPubkey: entry.senderPubkey } : {}),
      ...(entry.senderNametag !== undefined ? { senderNametag: entry.senderNametag } : {}),
      ...(entry.memo !== undefined ? { memo: entry.memo } : {}),
      receivedAt,
    });
  } catch (err) {
    // §5.9: the history hook never fails the money path.
    logger.debug('PaymentsV2', 'RECEIVED history hook failed (money path unaffected):', err);
  }
  return {
    id: record.tokenId,
    senderPubkey: entry.senderPubkey ?? '',
    ...(entry.senderNametag !== undefined ? { senderNametag: entry.senderNametag } : {}),
    tokens: record.assets.map((asset) => toUiToken(record.tokenId, asset, deps.registry, receivedAt)),
    ...(entry.memo !== undefined ? { memo: entry.memo } : {}),
    receivedAt,
  };
}

/** The cursor may only reach the last CONSECUTIVE success — a gap skips entries forever. */
async function flushAcks(deps: ReceiveDeps, pending: PendingAck[], epochOf: () => string): Promise<void> {
  if (pending.length === 0) return;
  let lastAcked: string | null = null;
  try {
    const settled = await settleAcks(deps, pending);
    let i = 0;
    while (i < pending.length && settled.has(pending[i].deliveryId)) {
      lastAcked = pending[i].cursor;
      i += 1;
    }
    // Drop every settled entry, not just the prefix: a later flush must never
    // re-ack one that already settled.
    const stuck = pending.filter((p) => !settled.has(p.deliveryId));
    pending.length = 0;
    pending.push(...stuck);
  } finally {
    if (lastAcked !== null) {
      const record: StreamCursor = { cursor: lastAcked, syncEpoch: epochOf() };
      await deps.kv.set(STORE_KEYS.streamCursor('mailbox'), record);
    }
  }
}

/** Batched when the port offers it, one at a time otherwise; never reorders `pending`. */
async function settleAcks(deps: ReceiveDeps, pending: readonly PendingAck[]): Promise<Set<string>> {
  const batch = deps.delivery.ackBatch?.bind(deps.delivery);
  if (batch === undefined) return settleOneByOne(deps, pending);
  let outcomes: readonly AckOutcome[];
  try {
    outcomes = await batch(pending.map(toAckRequest));
  } catch (err) {
    // A wall a per-entry retry would hit too (429, outage): falling back turns
    // one transient failure into N of them.
    if (isRetryableAckError(err)) throw err;
    logger.warn('PaymentsV2', 'batched mailbox ack failed — settling one at a time:', err);
    return settleOneByOne(deps, pending);
  }
  const settled = new Set(outcomes.filter((o) => o.status === 'settled').map((o) => o.deliveryId));
  const conflicts = outcomes.filter((o) => o.status === 'conflict').map((o) => o.deliveryId);
  if (conflicts.length > 0) await resolveConflicts(deps, pending, conflicts, settled);
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
async function settleOneByOne(deps: ReceiveDeps, pending: readonly PendingAck[]): Promise<Set<string>> {
  const settled = new Set<string>();
  for (const ack of pending) {
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
    disposition: ack.disposition,
    ...(ack.reason !== undefined ? { reason: ack.reason } : {}),
  };
}

async function ackOne(deps: ReceiveDeps, ack: PendingAck): Promise<void> {
  try {
    await deps.delivery.ack(ack.deliveryId, ack.disposition, ack.reason);
  } catch (err) {
    if (ack.disposition !== 'claimed' || !isClaimConflict(err)) throw err;
    await rejectStaleClaim(deps, ack.deliveryId, ack.transferId);
  }
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
