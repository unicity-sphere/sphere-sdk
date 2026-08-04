// §5.7 of docs/PAYMENTS-V2-DESIGN.md — the single-flighted receive drain.
// Entry order is money-load-bearing: the view store precedes the claimed ack,
// so a claimed/acked token can never be absent from the view (#724 outcome).

import type { ITokenEngine, SphereToken } from '../../../token-engine';
import { TOKEN_BLOB_VERSION } from '../../../token-engine/token-blob';
import type { IncomingTransfer, Token } from '../../../types';
import type { RegistryReader } from '../inventory/InventoryView';
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
  store(entry: StoredIncoming): Promise<'stored' | 'rejected'>;
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
  readonly engine: ReceiveEngine;
  readonly view: ReceiveView;
  readonly kv: ScopedKV;
  readonly registry: RegistryReader;
  readonly recordReceived: (record: ReceivedRecord) => Promise<void>;
  readonly emit: (event: 'transfer:incoming', transfer: IncomingTransfer) => void;
  readonly syncEpoch: () => string;
  readonly now?: () => number;
}

export const ACK_BATCH_SIZE = 200;
export const POLL_INTERVAL_MS = 30_000;

export function receivedDedupKey(tokenId: string, stateHash: string): string {
  // Lowercased like History's keys — a case-variant would defeat server dedup.
  return `RECEIVED:${tokenId.toLowerCase()}:${stateHash.toLowerCase()}`;
}

interface PendingAck {
  readonly deliveryId: string;
  readonly disposition: 'claimed' | 'rejected';
  readonly reason?: 'invalid' | 'not-owned' | 'storage-rejected' | 'other';
  readonly cursor: string;
}

type Screened = { kind: 'ack'; ack: PendingAck } | { kind: 'accept'; record: StoredIncoming };

export class Receive {
  private inFlight: Promise<IncomingTransfer[]> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeWake: (() => void) | null = null;

  constructor(private readonly deps: ReceiveDeps) {}

  drainOnce(): Promise<IncomingTransfer[]> {
    if (this.inFlight) return this.inFlight;
    const run = this.doDrain().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
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

  private async doDrain(): Promise<IncomingTransfer[]> {
    const deps = this.deps;
    const stored: IncomingTransfer[] = [];
    const pending: PendingAck[] = [];
    let epoch = '';
    try {
      epoch = deps.syncEpoch();
      const record = await deps.kv.get<StreamCursor>(STORE_KEYS.streamCursor('mailbox'));
      const since = record !== null && record.syncEpoch === epoch ? String(record.cursor) : undefined;
      for await (const entry of deps.delivery.incoming(since)) {
        await this.processEntry(deps, entry, pending, stored);
        if (pending.length >= ACK_BATCH_SIZE) await flushAcks(deps, pending, epoch);
      }
      await flushAcks(deps, pending, epoch);
    } catch {
      // Infra failure (engine/blob/view/ack): the failed entry stays UNACKED and
      // re-lists next drain; the fully-processed prefix still flushes below.
      await flushAcks(deps, pending, epoch).catch(() => undefined);
    }
    return stored;
  }

  private async processEntry(
    deps: ReceiveDeps,
    entry: IncomingDelivery,
    pending: PendingAck[],
    stored: IncomingTransfer[]
  ): Promise<void> {
    const screened = await screen(deps, entry);
    if (screened.kind === 'ack') {
      pending.push(screened.ack);
      return;
    }
    const outcome = await deps.view.store(screened.record);
    if (outcome === 'rejected') {
      pending.push(rejectAck(entry, 'storage-rejected'));
      return;
    }
    pending.push(claimAck(entry));
    const transfer = await announce(deps, entry, screened.record);
    stored.push(transfer);
    deps.emit('transfer:incoming', transfer);
  }
}

async function screen(deps: ReceiveDeps, entry: IncomingDelivery): Promise<Screened> {
  const blobBytes = await entry.fetchBlob();
  let token: SphereToken;
  try {
    token = await deps.engine.decodeToken({
      v: TOKEN_BLOB_VERSION,
      network: 0,
      tokenId: '',
      token: blobBytes,
    });
  } catch {
    return { kind: 'ack', ack: rejectAck(entry, 'invalid') };
  }
  const verdict = await deps.engine.verify(token);
  if (!verdict.ok) return { kind: 'ack', ack: rejectAck(entry, 'invalid') };
  if (!deps.engine.isOwnedBy(token, deps.engine.getIdentity().chainPubkey)) {
    return { kind: 'ack', ack: rejectAck(entry, 'not-owned') };
  }
  const keys = await deps.engine.deliveryKeys(blobBytes);
  const held = deps.view.heldState(keys.tokenId);
  if (held === keys.stateHash) return { kind: 'ack', ack: claimAck(entry) };
  if (held !== null && (await deps.engine.isSpent(token))) {
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
  } catch {
    // The history hook never fails the money path (§5.9).
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

async function flushAcks(deps: ReceiveDeps, pending: PendingAck[], epoch: string): Promise<void> {
  let lastAcked: string | null = null;
  try {
    while (pending.length > 0) {
      const next = pending[0];
      await deps.delivery.ack(next.deliveryId, next.disposition, next.reason);
      lastAcked = next.cursor;
      pending.shift();
    }
  } finally {
    if (lastAcked !== null) {
      const record: StreamCursor = { cursor: lastAcked, syncEpoch: epoch };
      await deps.kv.set(STORE_KEYS.streamCursor('mailbox'), record);
    }
  }
}

function claimAck(entry: IncomingDelivery): PendingAck {
  return { deliveryId: entry.deliveryId, disposition: 'claimed', cursor: entry.cursor };
}

function rejectAck(
  entry: IncomingDelivery,
  reason: 'invalid' | 'not-owned' | 'storage-rejected'
): PendingAck {
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
