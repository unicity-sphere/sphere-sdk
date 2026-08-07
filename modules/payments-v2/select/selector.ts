// §5.3 CoinSelector — pure function, no I/O, no engine, no blobs.

export interface PoolEntry {
  readonly tokenId: string;
  readonly amount: bigint;
}

export interface SplitSpec {
  readonly tokenId: string;
  readonly splitAmount: bigint;
  readonly remainderAmount: bigint;
}

export interface SelectionPlan {
  readonly direct: readonly string[];
  readonly split?: SplitSpec;
}

export interface SelectorStats {
  combinationsExamined: number;
}

export interface SelectorOptions {
  readonly workBudget?: number;
  /** Instrumentation out-param: pins the tested work-budget invariant (select.test.ts). */
  readonly stats?: SelectorStats;
}

export const DEFAULT_WORK_BUDGET = 20_000;
export const MAX_COMBINATION_SIZE = 5;

interface ComboSearch {
  examined: number;
  readonly budget: number;
}

export function selectCoins(
  pool: readonly PoolEntry[],
  target: bigint,
  options: SelectorOptions = {}
): SelectionPlan | null {
  if (target <= 0n) return null;
  const candidates = pool.filter((e) => e.amount > 0n).sort(byAmountAscending);
  let total = 0n;
  for (const c of candidates) total += c.amount;
  if (total < target) return null;

  const single = candidates.find((c) => c.amount === target);
  if (single) return { direct: [single.tokenId] };

  const search: ComboSearch = {
    examined: 0,
    budget: options.workBudget ?? DEFAULT_WORK_BUDGET,
  };
  const combo = findExactCombination(candidates, target, search);
  if (options.stats) options.stats.combinationsExamined = search.examined;
  if (combo) return { direct: combo.map((c) => c.tokenId) };

  return greedyWithSplit(candidates, target);
}

function byAmountAscending(a: PoolEntry, b: PoolEntry): number {
  if (a.amount !== b.amount) return a.amount < b.amount ? -1 : 1;
  return a.tokenId < b.tokenId ? -1 : a.tokenId > b.tokenId ? 1 : 0;
}

function greedyWithSplit(
  sortedAscending: readonly PoolEntry[],
  target: bigint
): SelectionPlan | null {
  const direct: string[] = [];
  let sum = 0n;
  for (const candidate of sortedAscending) {
    const next = sum + candidate.amount;
    if (next < target) {
      direct.push(candidate.tokenId);
      sum = next;
    } else if (next === target) {
      direct.push(candidate.tokenId);
      return { direct };
    } else {
      const splitAmount = target - sum;
      return {
        direct,
        split: {
          tokenId: candidate.tokenId,
          splitAmount,
          remainderAmount: candidate.amount - splitAmount,
        },
      };
    }
  }
  return null;
}

function findExactCombination(
  sortedAscending: readonly PoolEntry[],
  target: bigint,
  search: ComboSearch
): readonly PoolEntry[] | null {
  const maxSize = Math.min(MAX_COMBINATION_SIZE, sortedAscending.length);
  for (let size = 2; size <= maxSize; size++) {
    if (search.examined >= search.budget) return null;
    const window = orderNearestTo(sortedAscending, target / BigInt(size));
    const found = searchCombinationsOfSize(window, size, target, search);
    if (found) return found;
  }
  return null;
}

// Window ordering: candidates nearest target/size are tried first, so the
// budget spends its work where exact sums are most likely.
function orderNearestTo(entries: readonly PoolEntry[], pivot: bigint): PoolEntry[] {
  const distance = (e: PoolEntry): bigint =>
    e.amount >= pivot ? e.amount - pivot : pivot - e.amount;
  return [...entries].sort((a, b) => {
    const da = distance(a);
    const db = distance(b);
    if (da !== db) return da < db ? -1 : 1;
    return byAmountAscending(a, b);
  });
}

function searchCombinationsOfSize(
  window: readonly PoolEntry[],
  size: number,
  target: bigint,
  search: ComboSearch
): readonly PoolEntry[] | null {
  const chosen: PoolEntry[] = [];
  const recurse = (start: number, sum: bigint): readonly PoolEntry[] | null => {
    if (chosen.length === size) {
      search.examined += 1;
      return sum === target ? [...chosen] : null;
    }
    for (let i = start; i < window.length; i++) {
      if (search.examined >= search.budget) return null;
      chosen.push(window[i]);
      const found = recurse(i + 1, sum + window[i].amount);
      chosen.pop();
      if (found) return found;
    }
    return null;
  };
  return recurse(0, 0n);
}
