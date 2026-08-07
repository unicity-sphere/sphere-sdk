// §5.2 of docs/PAYMENTS-V2-DESIGN.md — in-memory mirror of the server
// inventory (a view, never a store of record). Single writer of the mirror,
// the suspectedSpent overlay, the knownSpends set, the in-flight registry and
// the §6 inventory StreamCursor record. Display mapping lives in presentation.ts.

import type { Asset, Token } from '../../../types';
import { SerialChain, SingleFlight } from '../async';
import type { InventoryAsset, InventoryItem, InventoryPage, StoragePort } from '../ports';
import { STORE_KEYS, type ScopedKV, type StreamCursor } from '../stores';
import {
  aggregateAssets,
  toToken,
  withPrices,
  type PriceReader,
  type RegistryReader,
} from './presentation';

export type { PriceQuote, PriceReader, RegistryReader } from './presentation';

// F6: state-scoped by schema — a bare-tokenId spend record is unrepresentable.
export interface KnownSpend {
  readonly tokenId: string;
  readonly stateHash: string;
}

export interface PoolEntry {
  readonly tokenId: string;
  readonly amount: bigint;
}

export type ReAddResult = 'added' | 'evidenced-tombstone';

export interface RecoverOutcome {
  readonly recovered: readonly string[];
  readonly confirmedSpent: readonly KnownSpend[];
}

export interface InventoryViewDeps {
  readonly port: StoragePort;
  readonly kv: ScopedKV;
  readonly emit: (event: 'inventory:updated') => void;
  readonly now?: () => number;
}

interface MirrorEntry {
  stateHash: string;
  seq: number;
  status: 'active' | 'removed';
  assets: readonly InventoryAsset[];
  createdAt: number;
  updatedAt: number;
}

const SUSPECTED_KEY = STORE_KEYS.suspectedSpent;
const KNOWN_SPENDS_KEY = STORE_KEYS.knownSpends;
const CURSOR_KEY = STORE_KEYS.streamCursor('inventory');

function stateKey(tokenId: string, stateHash: string): string {
  return `${tokenId}:${stateHash}`;
}

export class InventoryView {
  private readonly mirror = new Map<string, MirrorEntry>();
  private readonly suspected = new Set<string>();
  private readonly knownSpends = new Set<string>();
  private readonly inFlight = new Set<string>();
  private firstPullOk = false;
  private hydrated: Promise<void> | null = null;
  private readonly chain = new SerialChain();
  private readonly overlayChain = new SerialChain();
  private readonly pullFlight = new SingleFlight<void>();

  constructor(private readonly deps: InventoryViewDeps) {}

  fullPull(): Promise<void> {
    return this.pullFlight.run(() => this.chain.enqueue(() => this.doFullPull(false)));
  }

  // §5.2/§6: incremental pull from the persisted (cursor, epoch) record; a
  // stale epoch (server restore) voids cursor continuity → full re-pull.
  delta(): Promise<void> {
    return this.chain.enqueue(async () => {
      await this.hydrate();
      const record = this.firstPullOk ? await this.deps.kv.get<StreamCursor>(CURSOR_KEY) : null;
      if (record === null) return this.doFullPull(false);
      const first = await this.deps.port.listInventory(Number(record.cursor));
      if (first.syncEpoch !== record.syncEpoch) return this.doFullPull(true);
      const flags = { changed: false };
      try {
        await this.consumePages(first, undefined, flags);
      } finally {
        if (flags.changed) this.deps.emit('inventory:updated');
      }
    });
  }

  // Epoch reset (§5.1): full re-pull with per-key replace; entries absent from
  // the restored server drop only AFTER the new snapshot is fully applied.
  onEpochReset(): Promise<void> {
    return this.chain.enqueue(() => this.doFullPull(true));
  }

  async demote(tokenId: string, stateHash: string): Promise<void> {
    if (tokenId === '' || stateHash === '') {
      throw new Error('demote requires both tokenId and stateHash');
    }
    const key = stateKey(tokenId, stateHash);
    if (this.suspected.has(key)) return;
    const added = await this.overlayChain.enqueue(async () => {
      await this.hydrate();
      if (this.suspected.has(key)) return false;
      await this.deps.kv.set(SUSPECTED_KEY, [...this.suspected, key]);
      this.suspected.add(key);
      return true;
    });
    if (added) this.deps.emit('inventory:updated');
  }

  recoverRemoved(
    getBlobs: (tokenIds: string[]) => Promise<Map<string, Uint8Array>>,
    isSpent: (tokenId: string, blob: Uint8Array) => Promise<boolean>,
    reAdd: (tokenId: string, blob: Uint8Array) => Promise<ReAddResult>
  ): Promise<RecoverOutcome> {
    return this.chain.enqueue(() => this.doRecover(getBlobs, isSpent, reAdd));
  }

  markInFlight(tokenId: string): void {
    if (this.inFlight.has(tokenId)) return;
    this.inFlight.add(tokenId);
    this.deps.emit('inventory:updated');
  }

  release(tokenId: string): void {
    if (this.inFlight.delete(tokenId)) this.deps.emit('inventory:updated');
  }

  pool(coinId: string): PoolEntry[] {
    const out: PoolEntry[] = [];
    for (const [tokenId, entry] of this.mirror) {
      if (entry.status !== 'active' || this.inFlight.has(tokenId)) continue;
      if (this.suspected.has(stateKey(tokenId, entry.stateHash))) continue;
      const asset = entry.assets.find((a) => a.coinId === coinId);
      if (asset) out.push({ tokenId, amount: BigInt(asset.amount) });
    }
    return out;
  }

  tokens(registry: RegistryReader, filter?: { coinId?: string }): Token[] {
    const out: Token[] = [];
    for (const [tokenId, entry] of this.mirror) {
      if (entry.status !== 'active') continue;
      const asset = entry.assets[0];
      if (!asset) continue;
      if (filter?.coinId !== undefined && asset.coinId !== filter.coinId) continue;
      out.push(
        toToken(tokenId, entry, asset, registry, {
          transferring: this.inFlight.has(tokenId),
          suspectedSpent: this.suspected.has(stateKey(tokenId, entry.stateHash)),
        })
      );
    }
    return out;
  }

  async assets(registry: RegistryReader, price?: PriceReader): Promise<Asset[]> {
    const raw = aggregateAssets(this.activeEntries(), (tokenId) => this.inFlight.has(tokenId), registry);
    if (!price || raw.length === 0) return raw;
    return withPrices(raw, registry, price);
  }

  private *activeEntries(): Iterable<[string, MirrorEntry]> {
    for (const [tokenId, entry] of this.mirror) {
      if (entry.status === 'active') yield [tokenId, entry];
    }
  }

  private hydrate(): Promise<void> {
    this.hydrated ??= this.loadDurable().catch((error: unknown) => {
      this.hydrated = null;
      throw error;
    });
    return this.hydrated;
  }

  private async loadDurable(): Promise<void> {
    const suspected = await this.deps.kv.get<string[]>(SUSPECTED_KEY);
    for (const key of suspected ?? []) this.suspected.add(key);
    const known = await this.deps.kv.get<string[]>(KNOWN_SPENDS_KEY);
    for (const key of known ?? []) this.knownSpends.add(key);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private async doFullPull(reconcileAbsent: boolean): Promise<void> {
    await this.hydrate();
    const seen = reconcileAbsent ? new Set<string>() : undefined;
    const flags = { changed: false };
    try {
      let page = await this.deps.port.listInventory();
      const firstCursor = page.cursor;
      if (this.applyItems(page.items, seen)) flags.changed = true;
      while (page.more) {
        page = await this.deps.port.listInventory(page.cursor);
        if (this.applyItems(page.items, seen)) flags.changed = true;
      }
      // One immediate since-delta from the page-1 cursor: pulls span snapshots,
      // its tombstones/upserts repair any inter-page flips.
      await this.consumePages(await this.deps.port.listInventory(firstCursor), seen, flags);
      if (seen && this.dropAbsent(seen)) flags.changed = true;
      this.firstPullOk = true;
    } finally {
      // A partially applied pull still emits — the view DID change.
      if (flags.changed) this.deps.emit('inventory:updated');
    }
  }

  /** Applies a since-page and its more-loop, then persists the ONE (cursor, epoch) record. */
  private async consumePages(
    first: InventoryPage,
    seen: Set<string> | undefined,
    flags: { changed: boolean }
  ): Promise<void> {
    let page = first;
    if (this.applyItems(page.items, seen)) flags.changed = true;
    while (page.more) {
      page = await this.deps.port.listInventory(page.cursor);
      if (this.applyItems(page.items, seen)) flags.changed = true;
    }
    const record: StreamCursor = { cursor: page.cursor, syncEpoch: page.syncEpoch };
    await this.deps.kv.set(CURSOR_KEY, record);
  }

  // Synchronous per-key application; the overlay prune runs in this same
  // synchronous step (F7) — never against a cleared or half-filled view.
  private applyItems(items: readonly InventoryItem[], seen?: Set<string>): boolean {
    const now = this.now();
    let changed = false;
    for (const item of items) {
      seen?.add(item.tokenId);
      if (this.applyOne(item, now)) changed = true;
    }
    const pruned = this.pruneOverlaySync(false);
    return changed || pruned;
  }

  private applyOne(item: InventoryItem, now: number): boolean {
    const prev = this.mirror.get(item.tokenId);
    if (prev && item.seq < prev.seq) return false;
    if (
      prev &&
      prev.seq === item.seq &&
      prev.status === item.status &&
      prev.stateHash === item.stateHash
    ) {
      return false;
    }
    this.mirror.set(item.tokenId, {
      stateHash: item.stateHash,
      seq: item.seq,
      status: item.status,
      assets: item.assets ?? prev?.assets ?? [],
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    });
    return true;
  }

  // Prunes only on positive evidence (state advance or tombstone). Absence is
  // evidence only when the caller holds a complete post-reset snapshot.
  private pruneOverlaySync(allowAbsent: boolean): boolean {
    let pruned = false;
    for (const key of this.suspected) {
      const cut = key.lastIndexOf(':');
      const entry = this.mirror.get(key.slice(0, cut));
      const live = entry !== undefined
        ? entry.status === 'active' && entry.stateHash === key.slice(cut + 1)
        : !allowAbsent;
      if (!live) {
        this.suspected.delete(key);
        pruned = true;
      }
    }
    if (pruned) this.schedulePersistSuspected();
    return pruned;
  }

  private schedulePersistSuspected(): void {
    void this.overlayChain
      .enqueue(() => this.deps.kv.set(SUSPECTED_KEY, [...this.suspected]))
      .catch(() => undefined);
  }

  private dropAbsent(seen: Set<string>): boolean {
    let changed = false;
    for (const tokenId of [...this.mirror.keys()]) {
      if (!seen.has(tokenId)) {
        this.mirror.delete(tokenId);
        changed = true;
      }
    }
    if (changed) this.pruneOverlaySync(true);
    return changed;
  }

  private async doRecover(
    getBlobs: (tokenIds: string[]) => Promise<Map<string, Uint8Array>>,
    isSpent: (tokenId: string, blob: Uint8Array) => Promise<boolean>,
    reAdd: (tokenId: string, blob: Uint8Array) => Promise<ReAddResult>
  ): Promise<RecoverOutcome> {
    await this.hydrate();
    const candidates = this.firstPullOk ? this.recoveryCandidates() : [];
    if (candidates.length === 0) return { recovered: [], confirmedSpent: [] };
    const blobs = await getBlobs(candidates.map((c) => c.tokenId));
    const recovered: string[] = [];
    const confirmedSpent: KnownSpend[] = [];
    try {
      for (const candidate of candidates) {
        const blob = blobs.get(candidate.tokenId);
        if (!blob) continue;
        const outcome = await this.recoverOne(candidate, blob, isSpent, reAdd);
        if (outcome === 'recovered') recovered.push(candidate.tokenId);
        if (outcome === 'spent') confirmedSpent.push(candidate);
      }
    } finally {
      if (recovered.length > 0) this.deps.emit('inventory:updated');
    }
    return { recovered, confirmedSpent };
  }

  private recoveryCandidates(): KnownSpend[] {
    const out: KnownSpend[] = [];
    for (const [tokenId, entry] of this.mirror) {
      if (entry.status !== 'removed') continue;
      if (this.knownSpends.has(stateKey(tokenId, entry.stateHash))) continue;
      out.push({ tokenId, stateHash: entry.stateHash });
    }
    return out;
  }

  private async recoverOne(
    candidate: KnownSpend,
    blob: Uint8Array,
    isSpent: (tokenId: string, blob: Uint8Array) => Promise<boolean>,
    reAdd: (tokenId: string, blob: Uint8Array) => Promise<ReAddResult>
  ): Promise<'recovered' | 'spent' | 'skipped'> {
    if (await isSpent(candidate.tokenId, blob)) {
      await this.recordKnownSpend(candidate);
      return 'spent';
    }
    if ((await reAdd(candidate.tokenId, blob)) === 'evidenced-tombstone') {
      await this.recordKnownSpend(candidate);
      return 'spent';
    }
    const current = this.mirror.get(candidate.tokenId);
    if (!current || current.status !== 'removed' || current.stateHash !== candidate.stateHash) {
      return 'skipped';
    }
    current.status = 'active';
    current.updatedAt = this.now();
    return 'recovered';
  }

  private async recordKnownSpend(spend: KnownSpend): Promise<void> {
    if (spend.tokenId === '' || spend.stateHash === '') {
      throw new Error('knownSpend requires both tokenId and stateHash');
    }
    this.knownSpends.add(stateKey(spend.tokenId, spend.stateHash));
    await this.deps.kv.set(KNOWN_SPENDS_KEY, [...this.knownSpends]);
  }
}
