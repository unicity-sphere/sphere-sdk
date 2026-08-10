// §5.4 SpendQueue — per-coin FIFO with skip-ahead; plan+reserve is one
// synchronous critical section (no await between free-view read and reserve).

import { SphereError } from '../../../core/errors';
import { selectCoins, type PoolEntry, type SelectionPlan } from './selector';
import type { ReservationLedger } from './ledger';

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

interface FreeView {
  readonly freeView: PoolEntry[];
  readonly freeTotal: bigint;
  /** Held by a reservation — an open intent's sources stay pinned until it converges. */
  readonly pinnedTotal: bigint;
  readonly pinnedBy: number;
}

/**
 * #737: the CODE is load-bearing (dApps key on it) but "insufficient balance" sent
 * a user auditing a treasury that was never short — every token was pinned by an
 * intent still converging. When something is pinned, the message says so.
 */
function insufficientBalance(view: FreeView, amount: bigint): SphereError {
  const message =
    view.pinnedTotal > 0n
      ? `Insufficient spendable balance: need ${amount.toString()}, ${view.freeTotal.toString()} free, ` +
        `${view.pinnedTotal.toString()} pinned by ${String(view.pinnedBy)} transfer(s) still converging — ` +
        'see payments.pendingTransfers(); do not re-send.'
      : 'Insufficient balance for this transaction';
  return new SphereError(message, 'SEND_INSUFFICIENT_BALANCE');
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
    // #738: the ledger says whether its held-set is proven. Unproven = refuse.
    const unproven = this.deps.ledger.unprovenReason();
    if (unproven !== null) throw new SphereError(unproven, 'SEND_INSUFFICIENT_BALANCE');
    const amount = parseAmount(request.amount);
    const view = this.freeView(request.coinId);
    const { freeView, freeTotal } = view;
    if (freeTotal + this.expectedChangeTotal(request.coinId) < amount) {
      throw insufficientBalance(view, amount);
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
    const view = this.freeView(entry.coinId);
    const { freeView, freeTotal } = view;
    if (freeTotal + this.expectedChangeTotal(entry.coinId) < entry.amount) {
      entry.reject(insufficientBalance(view, entry.amount));
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

  // Whole-token semantics: only fully-free tokens enter the selector pool. What
  // the reservations hold back is counted too — the refusal has to name it (#737).
  private freeView(coinId: string): FreeView {
    const freeView: PoolEntry[] = [];
    let freeTotal = 0n;
    let pinnedTotal = 0n;
    const holders = new Set<string>();
    for (const entry of this.deps.getPool(coinId)) {
      if (entry.amount <= 0n) continue;
      const holder = this.deps.ledger.holderOf(entry.tokenId);
      if (holder === undefined) {
        freeView.push(entry);
        freeTotal += entry.amount;
      } else {
        pinnedTotal += entry.amount;
        holders.add(holder);
      }
    }
    return { freeView, freeTotal, pinnedTotal, pinnedBy: holders.size };
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
    const pool = new Set(freeView.map((e) => e.tokenId));
    const tokenIds = [...plan.direct, ...(plan.split ? [plan.split.tokenId] : [])];
    for (const tokenId of tokenIds) {
      if (!pool.has(tokenId)) {
        throw new SphereError('Planned token missing from pool', 'VALIDATION_ERROR');
      }
    }
    this.deps.ledger.reserve(reservationId, tokenIds.map((tokenId) => ({ tokenId })));
  }

  private totalQueued(): number {
    let total = 0;
    for (const entries of this.queues.values()) total += entries.length;
    return total;
  }
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
