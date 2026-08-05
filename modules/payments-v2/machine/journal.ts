// §5.6/§6 durable machine stores over ScopedKV: content-idempotent saves keyed
// by (transferId, opIndex), one serialized RMW tail-chain per (kv, store key),
// and the bounded delivery replay (#621) with 429 deferrals outside the poison
// budget (#517).

import { hexToBytes } from '../../../core/crypto';
import { SerialChain, SingleFlight } from '../async';
import type { DeliveryPort } from '../ports';
import {
  STORE_KEYS,
  type DeliveryJournalEntry,
  type IntentBackstopEntry,
  type MintJournalEntry,
  type ScopedKV,
  type ShortfallEntry,
} from '../stores';

export const MAX_DELIVERY_ATTEMPTS = 6;
export const RATE_LIMIT_DEFER_MS = 30_000;

export const ATTENTION_DELIVERY_DEFERRED = 'delivery:deferred';
export const ATTENTION_DELIVERY_UNDELIVERABLE = 'delivery:undeliverable';
export const ATTENTION_CHECKPOINT_STUCK = 'split:checkpoint-stuck';
export const ATTENTION_SYNC_PENDING = 'sync:pending';

export type AttentionEmitter = (transferId: string, code: string, detail?: string) => void;

interface WireErrorShape {
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
}

function wireShape(err: unknown): WireErrorShape | null {
  return err !== null && typeof err === 'object' ? (err as WireErrorShape) : null;
}

export function isRateLimited(err: unknown): boolean {
  const e = wireShape(err);
  if (e === null) return false;
  return e.status === 429 || e.statusCode === 429 || e.code === 'QUOTA_EXCEEDED' || e.code === 'RATE_LIMITED';
}

export function isValidationReject(err: unknown): boolean {
  const e = wireShape(err);
  if (e === null) return false;
  return e.status === 422 || e.statusCode === 422 || e.code === 'VALIDATION' || e.code === 'VALIDATION_FAILED';
}

/**
 * Duck-typed `WalletApiHttpError.retryAfter` (milliseconds) — modules never
 * import from impl/, so the heartbeat honors the header structurally.
 */
export function retryAfterMsOf(err: unknown): number | null {
  const retryAfter =
    err !== null && typeof err === 'object' ? (err as { retryAfter?: unknown }).retryAfter : undefined;
  return typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : null;
}

// Registered per (kv, store key) so EVERY store instance over the same
// ScopedKV serializes its read-modify-writes with every other instance.
const chainRegistry = new WeakMap<ScopedKV, Map<string, SerialChain>>();
const replayRegistry = new WeakMap<ScopedKV, Map<string, SingleFlight<ReplayStats>>>();

function registryFor<T>(
  registry: WeakMap<ScopedKV, Map<string, T>>,
  kv: ScopedKV,
  storeKey: string,
  make: () => T
): T {
  let perKv = registry.get(kv);
  if (perKv === undefined) {
    perKv = new Map();
    registry.set(kv, perKv);
  }
  let entry = perKv.get(storeKey);
  if (entry === undefined) {
    entry = make();
    perKv.set(storeKey, entry);
  }
  return entry;
}

export class ListStore<T> {
  constructor(
    protected readonly kv: ScopedKV,
    protected readonly storeKey: string,
    protected readonly keyOf: (entry: T) => string
  ) {}

  list(): Promise<T[]> {
    return this.chained(() => this.read());
  }

  getByKey(key: string): Promise<T | undefined> {
    return this.chained(async () => (await this.read()).find((e) => this.keyOf(e) === key));
  }

  /** Upsert; a byte-identical re-save is a no-op (content-idempotent). */
  upsert(entry: T): Promise<void> {
    return this.mutate((list) => {
      const key = this.keyOf(entry);
      const at = list.findIndex((e) => this.keyOf(e) === key);
      if (at >= 0 && JSON.stringify(list[at]) === JSON.stringify(entry)) return { result: undefined };
      const next = [...list];
      if (at >= 0) next[at] = entry;
      else next.push(entry);
      return { list: next, result: undefined };
    });
  }

  removeByKey(key: string): Promise<void> {
    return this.mutate((list) => {
      const next = list.filter((e) => this.keyOf(e) !== key);
      return next.length === list.length ? { result: undefined } : { list: next, result: undefined };
    });
  }

  patch(key: string, fn: (entry: T) => T): Promise<T | undefined> {
    return this.mutate((list) => {
      const at = list.findIndex((e) => this.keyOf(e) === key);
      if (at < 0) return { result: undefined };
      const next = [...list];
      next[at] = fn(next[at]);
      return { list: next, result: next[at] };
    });
  }

  protected mutate<R>(fn: (list: T[]) => { list?: T[]; result: R }): Promise<R> {
    return this.chained(async () => {
      const { list, result } = fn(await this.read());
      if (list !== undefined) await this.kv.set(this.storeKey, list);
      return result;
    });
  }

  protected chained<R>(run: () => Promise<R>): Promise<R> {
    return registryFor(chainRegistry, this.kv, this.storeKey, () => new SerialChain()).enqueue(run);
  }

  private async read(): Promise<T[]> {
    return (await this.kv.get<T[]>(this.storeKey)) ?? [];
  }
}

export interface ReplayStats {
  delivered: number;
  deferred: number;
  failed: number;
  poisoned: number;
}

export interface ReplayDeps {
  readonly delivery: DeliveryPort;
  readonly now: () => number;
  readonly attention: AttentionEmitter;
}

export class DeliveryJournal extends ListStore<DeliveryJournalEntry> {
  constructor(kv: ScopedKV) {
    super(kv, STORE_KEYS.deliveryJournal, (e) => `${e.transferId}:${String(e.opIndex)}`);
  }

  async byTransfer(transferId: string): Promise<Map<number, DeliveryJournalEntry>> {
    const mine = (await this.list()).filter((e) => e.transferId === transferId);
    return new Map(mine.map((e) => [e.opIndex, e]));
  }

  remove(transferId: string, opIndex: number): Promise<void> {
    return this.removeByKey(`${transferId}:${String(opIndex)}`);
  }

  /** 429 deferral: pushes deferredUntil out WITHOUT touching the poison budget. */
  async defer(transferId: string, opIndex: number, until: number): Promise<void> {
    await this.patch(`${transferId}:${String(opIndex)}`, (e) => ({ ...e, deferredUntil: until }));
  }

  /** Genuine failure: attempts++, poisoning (undeliverable) at the budget. */
  async recordFailure(transferId: string, opIndex: number, attention: AttentionEmitter): Promise<boolean> {
    const updated = await this.patch(`${transferId}:${String(opIndex)}`, (e) => {
      if (e.undeliverable === true) return e;
      const attempts = e.attempts + 1;
      return attempts >= MAX_DELIVERY_ATTEMPTS ? { ...e, attempts, undeliverable: true } : { ...e, attempts };
    });
    const poisoned = updated?.undeliverable === true;
    if (poisoned && updated.attempts === MAX_DELIVERY_ATTEMPTS) {
      attention(transferId, ATTENTION_DELIVERY_UNDELIVERABLE, `op ${String(opIndex)} after ${String(updated.attempts)} attempts`);
    }
    return poisoned;
  }

  /** Single-flight per (kv, store); concurrent calls coalesce onto one pass. */
  replay(deps: ReplayDeps): Promise<ReplayStats> {
    return registryFor(replayRegistry, this.kv, this.storeKey, () => new SingleFlight<ReplayStats>()).run(
      () => this.replayOnce(deps)
    );
  }

  private async replayOnce(deps: ReplayDeps): Promise<ReplayStats> {
    const stats: ReplayStats = { delivered: 0, deferred: 0, failed: 0, poisoned: 0 };
    for (const entry of await this.list()) {
      if (entry.undeliverable === true) continue;
      if (entry.deferredUntil !== undefined && entry.deferredUntil > deps.now()) {
        stats.deferred += 1;
        continue;
      }
      await this.replayEntry(entry, deps, stats);
    }
    return stats;
  }

  private async replayEntry(entry: DeliveryJournalEntry, deps: ReplayDeps, stats: ReplayStats): Promise<void> {
    try {
      await deps.delivery.deliver(entry.recipientPubkey, hexToBytes(entry.blobHex), {
        transferId: entry.transferId,
        ...(entry.memo !== undefined ? { memo: entry.memo } : {}),
      });
      await this.remove(entry.transferId, entry.opIndex);
      stats.delivered += 1;
    } catch (err) {
      if (isRateLimited(err)) {
        await this.defer(entry.transferId, entry.opIndex, deps.now() + RATE_LIMIT_DEFER_MS);
        deps.attention(entry.transferId, ATTENTION_DELIVERY_DEFERRED);
        stats.deferred += 1;
      } else if (await this.recordFailure(entry.transferId, entry.opIndex, deps.attention)) {
        stats.poisoned += 1;
      } else {
        stats.failed += 1;
      }
    }
  }
}

export interface MachineStores {
  readonly backstop: ListStore<IntentBackstopEntry>;
  readonly deliveryJournal: DeliveryJournal;
  readonly mintJournal: ListStore<MintJournalEntry>;
  readonly shortfalls: ListStore<ShortfallEntry>;
}

export function createMachineStores(kv: ScopedKV): MachineStores {
  return {
    backstop: new ListStore<IntentBackstopEntry>(kv, STORE_KEYS.intentBackstop, (e) => e.transferId),
    deliveryJournal: new DeliveryJournal(kv),
    mintJournal: new ListStore<MintJournalEntry>(kv, STORE_KEYS.mintJournal, (e) => e.mintId),
    shortfalls: new ListStore<ShortfallEntry>(kv, STORE_KEYS.shortfalls, (e) => e.transferId),
  };
}
