// §5.4 SpendQueue — per-coin FIFO with skip-ahead; plan+reserve is one
// synchronous critical section (no await between free-view read and reserve).

import { SphereError } from '../../../core/errors';
import { selectCoins, type PoolEntry, type SelectionPlan } from './selector';
import type { ReservationLedger, ReservationRequest } from './ledger';

export const QUEUE_TIMEOUT_MS = 30_000;
export const QUEUE_MAX_SIZE = 100;

export interface PlannedSpend {
  readonly reservationId: string;
  readonly plan: SelectionPlan;
}

export type PlanOutcome =
  | { readonly kind: 'planned'; readonly spend: PlannedSpend }
  | { readonly kind: 'queued'; readonly settled: Promise<PlannedSpend> };

export interface SpendQueueDeps {
  readonly ledger: ReservationLedger;
  readonly getPool: (coinId: string) => readonly PoolEntry[];
  readonly workBudget?: number;
}

interface QueueEntry {
  readonly id: string;
  readonly coinId: string;
  readonly amount: bigint;
  readonly enqueuedAt: number;
  readonly resolve: (spend: PlannedSpend) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface ExpectedChange {
  readonly coinId: string;
  readonly amount: bigint;
}

export class SpendQueue {
  private readonly queues = new Map<string, QueueEntry[]>();
  private readonly expectedChange = new Map<string, ExpectedChange>();
  private destroyed = false;

  constructor(private readonly deps: SpendQueueDeps) {}

  plan(reservationId: string, request: { coinId: string; amount: string }): PlanOutcome {
    if (this.destroyed) {
      throw new SphereError('Module has been destroyed', 'MODULE_DESTROYED');
    }
    const amount = parseAmount(request.amount);
    const { freeView, freeTotal } = this.freeView(request.coinId);
    if (freeTotal + this.expectedChangeTotal(request.coinId) < amount) {
      throw new SphereError(
        'Insufficient balance for this transaction',
        'SEND_INSUFFICIENT_BALANCE'
      );
    }
    const plan = selectCoins(freeView, amount, { workBudget: this.deps.workBudget });
    if (plan !== null) {
      this.reservePlan(reservationId, plan, freeView);
      return { kind: 'planned', spend: { reservationId, plan } };
    }
    return { kind: 'queued', settled: this.enqueue(reservationId, request.coinId, amount) };
  }

  // Coverage math: free + Σ declared expected change of in-flight sends —
  // never the full amount of in-flight sources (§5.3).
  declareExpectedChange(transferId: string, coinId: string, amount: bigint): void {
    this.expectedChange.set(transferId, { coinId, amount });
  }

  clearExpectedChange(transferId: string): void {
    this.expectedChange.delete(transferId);
  }

  notifyChange(coinId: string): void {
    if (this.destroyed) return;
    const entries = this.queues.get(coinId);
    if (!entries) return;
    let i = 0;
    while (i < entries.length) {
      const entry = entries[i];
      if (this.tryServe(entry) === 'blocked') {
        i += 1;
        continue;
      }
      clearTimeout(entry.timer);
      entries.splice(i, 1);
    }
    if (entries.length === 0) this.queues.delete(coinId);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const entries of this.queues.values()) {
      for (const entry of entries) {
        clearTimeout(entry.timer);
        entry.reject(new SphereError('Module destroyed', 'MODULE_DESTROYED'));
      }
    }
    this.queues.clear();
    this.expectedChange.clear();
  }

  private tryServe(entry: QueueEntry): 'served' | 'rejected' | 'blocked' {
    if (Date.now() - entry.enqueuedAt > QUEUE_TIMEOUT_MS) {
      entry.reject(new SphereError('Send queue timeout', 'SEND_QUEUE_TIMEOUT'));
      return 'rejected';
    }
    const { freeView, freeTotal } = this.freeView(entry.coinId);
    if (freeTotal + this.expectedChangeTotal(entry.coinId) < entry.amount) {
      entry.reject(
        new SphereError('Insufficient balance for this transaction', 'SEND_INSUFFICIENT_BALANCE')
      );
      return 'rejected';
    }
    const plan = selectCoins(freeView, entry.amount, { workBudget: this.deps.workBudget });
    if (plan === null) return 'blocked';
    try {
      this.reservePlan(entry.id, plan, freeView);
    } catch (e) {
      entry.reject(e instanceof Error ? e : new Error(String(e)));
      return 'rejected';
    }
    entry.resolve({ reservationId: entry.id, plan });
    return 'served';
  }

  private enqueue(id: string, coinId: string, amount: bigint): Promise<PlannedSpend> {
    if (this.totalQueued() >= QUEUE_MAX_SIZE) {
      throw new SphereError('Send queue is full', 'SEND_QUEUE_FULL');
    }
    let resolve!: (spend: PlannedSpend) => void;
    let reject!: (error: Error) => void;
    const settled = new Promise<PlannedSpend>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    settled.catch(() => {});
    const timer = setTimeout(() => this.expire(id, coinId), QUEUE_TIMEOUT_MS);
    const entry: QueueEntry = { id, coinId, amount, enqueuedAt: Date.now(), resolve, reject, timer };
    let queue = this.queues.get(coinId);
    if (!queue) {
      queue = [];
      this.queues.set(coinId, queue);
    }
    queue.push(entry);
    return settled;
  }

  private expire(id: string, coinId: string): void {
    const entries = this.queues.get(coinId);
    if (!entries) return;
    const index = entries.findIndex((e) => e.id === id);
    if (index === -1) return;
    const [entry] = entries.splice(index, 1);
    entry.reject(new SphereError('Send queue timeout', 'SEND_QUEUE_TIMEOUT'));
    if (entries.length === 0) this.queues.delete(coinId);
  }

  // Whole-token semantics: only fully-free tokens enter the selector pool.
  private freeView(coinId: string): { freeView: PoolEntry[]; freeTotal: bigint } {
    const freeView: PoolEntry[] = [];
    let freeTotal = 0n;
    for (const entry of this.deps.getPool(coinId)) {
      if (entry.amount <= 0n) continue;
      if (this.deps.ledger.getFreeAmount(entry.tokenId, entry.amount) === entry.amount) {
        freeView.push(entry);
        freeTotal += entry.amount;
      }
    }
    return { freeView, freeTotal };
  }

  private expectedChangeTotal(coinId: string): bigint {
    let total = 0n;
    for (const change of this.expectedChange.values()) {
      if (change.coinId === coinId) total += change.amount;
    }
    return total;
  }

  private reservePlan(
    reservationId: string,
    plan: SelectionPlan,
    freeView: readonly PoolEntry[]
  ): void {
    const amounts = new Map(freeView.map((e) => [e.tokenId, e.amount]));
    const requests = plan.direct.map((tokenId) => wholeToken(tokenId, amounts));
    if (plan.split) requests.push(wholeToken(plan.split.tokenId, amounts));
    this.deps.ledger.reserve(reservationId, requests);
  }

  private totalQueued(): number {
    let total = 0;
    for (const entries of this.queues.values()) total += entries.length;
    return total;
  }
}

function wholeToken(tokenId: string, amounts: ReadonlyMap<string, bigint>): ReservationRequest {
  const amount = amounts.get(tokenId);
  if (amount === undefined) {
    throw new SphereError('Planned token missing from pool', 'VALIDATION_ERROR');
  }
  return { tokenId, amount, tokenAmount: amount };
}

function parseAmount(raw: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new SphereError('Invalid send amount', 'VALIDATION_ERROR');
  }
  const amount = BigInt(raw);
  if (amount <= 0n) {
    throw new SphereError('Send amount must be positive', 'VALIDATION_ERROR');
  }
  return amount;
}
