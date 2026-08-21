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
import type { DeliveryPort, IncomingDelivery } from '../ports';
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
 * How often a drain refreshes the inventory mirror mid-flight. A 54-token
 * receive drains for ~10 s, and the mirror is what assets()/tokens() read — a
 * single refresh at the end leaves the wallet showing a stale balance for the
 * whole drain while the per-token transfer:incoming events stream past.
 */
export const REFRESH_INTERVAL_MS = 750;
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
        for await (const entry of deps.delivery.incoming(basis === null ? undefined : String(basis.cursor))) {
          const storedBefore = stored.length;
          await this.processEntry(deps, engine, entry, pending, stored);
          if (pending.length >= ACK_BATCH_SIZE) await flushAcks(deps, pending, pageEpoch);
          // Only when THIS entry entered the balance: a rejected one changes
          // nothing to show, and refreshing for it is a wasted round trip.
          if (stored.length > storedBefore) await this.maybeRefresh(deps, pending, pageEpoch);
        }
        await flushAcks(deps, pending, pageEpoch);
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
      await flushAcks(deps, pending, pageEpoch).catch((flushErr: unknown) => {
        logger.warn('PaymentsV2', 'receive ack flush failed — cursor holds at the acked prefix:', flushErr);
      });
    }
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

async function flushAcks(deps: ReceiveDeps, pending: PendingAck[], epochOf: () => string): Promise<void> {
  let lastAcked: string | null = null;
  try {
    while (pending.length > 0) {
      const next = pending[0];
      await ackOne(deps, next);
      lastAcked = next.cursor;
      pending.shift();
    }
  } finally {
    if (lastAcked !== null) {
      const record: StreamCursor = { cursor: lastAcked, syncEpoch: epochOf() };
      await deps.kv.set(STORE_KEYS.streamCursor('mailbox'), record);
    }
  }
}

async function ackOne(deps: ReceiveDeps, ack: PendingAck): Promise<void> {
  try {
    await deps.delivery.ack(ack.deliveryId, ack.disposition, ack.reason);
  } catch (err) {
    if (ack.disposition !== 'claimed' || !isClaimConflict(err)) throw err;
    // §5.7: a lineage CONFLICT on claim is stale by construction (another owner
    // holds equal-or-newer state) and reject is non-destructive server-side —
    // terminal for discovery immediately, or this entry re-processes forever.
    logger.warn('PaymentsV2', `mailbox claim CONFLICT for ${ack.deliveryId} — rejected('other') as stale`);
    await deps.delivery.ack(ack.deliveryId, 'rejected', 'other');
    deps.attention(ack.transferId ?? '', ATTENTION_CLAIM_CONFLICT, ack.deliveryId);
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
