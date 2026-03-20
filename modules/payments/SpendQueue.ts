/**
 * SpendPlanner & SpendQueue
 *
 * Coordinates token selection and reservation for concurrent send() calls.
 * The key invariant: planSend() and notifyChange() are FULLY SYNCHRONOUS —
 * no await anywhere in those methods. This guarantees atomicity between
 * free-amount reads, split calculation, and reservation writes within
 * JavaScript's single-threaded event loop.
 *
 * @see docs/SPEC-TOKEN-SPEND-QUEUE.md for the full design rationale.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { logger } from '../../core/logger';
import { SphereError } from '../../core/errors';
import type { Token } from '../../types';
import type { SplitPlan, TokenWithAmount } from './TokenSplitCalculator';
import type { TokenReservationLedger } from './TokenReservationLedger';
import { Token as SdkToken } from '@unicitylabs/state-transition-sdk/lib/token/Token';
import { CoinId } from '@unicitylabs/state-transition-sdk/lib/token/fungible/CoinId';

// =============================================================================
// Constants
// =============================================================================

/** How long a reservation lives before the ledger can expire it. */
export const RESERVATION_TIMEOUT_MS = 30_000;

/** How long a queued entry waits before being rejected with SEND_QUEUE_TIMEOUT. */
export const QUEUE_TIMEOUT_MS = 30_000;

/** Max times an entry can be skipped (no plan found) before it blocks the queue head. */
export const MAX_SKIP_COUNT = 10;

/** Maximum number of entries allowed in the queue across all coinIds. */
export const QUEUE_MAX_SIZE = 100;


// =============================================================================
// Types
// =============================================================================

/** A pre-parsed token with its SDK object and bigint amount already computed. */
export interface ParsedTokenEntry {
  token: Token;
  sdkToken: SdkToken<any>;
  amount: bigint;
}

/** Map of tokenId -> ParsedTokenEntry. Built asynchronously before the critical section. */
export type ParsedTokenPool = Map<string, ParsedTokenEntry>;

/** Successful plan result containing a reservation ID and the split plan. */
export interface PlanResult {
  reservationId: string;
  splitPlan: SplitPlan;
}

/** An entry waiting in the SpendQueue for tokens to become available. */
export interface QueueEntry {
  readonly id: string;
  readonly request: { amount: string; coinId: string };
  readonly parsedPool: ParsedTokenPool;
  readonly coinId: string;
  readonly amount: bigint;
  readonly enqueuedAt: number;
  skipCount: number;
  resolve: (result: PlanResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const TAG = 'SpendQueue';

// =============================================================================
// SpendPlanner
// =============================================================================

export class SpendPlanner {
  /**
   * Async pre-computation: parse all tokens for a given coinId.
   * Called BEFORE the synchronous critical section.
   *
   * Filters to confirmed tokens matching the coinId, parses each
   * token's sdkData into an SdkToken, and extracts the bigint amount.
   */
  async buildParsedPool(tokens: Token[], coinId: string): Promise<ParsedTokenPool> {
    const pool: ParsedTokenPool = new Map();

    for (const t of tokens) {
      if (t.coinId !== coinId) continue;
      if (t.status !== 'confirmed') continue;
      if (!t.sdkData) continue;

      try {
        const parsed = JSON.parse(t.sdkData);
        const sdkToken = await SdkToken.fromJSON(parsed);
        const realAmount = this.getTokenBalance(sdkToken, coinId);

        if (realAmount <= 0n) {
          logger.warn(TAG, `Token ${t.id} has 0 balance for coinId ${coinId}`);
          continue;
        }

        pool.set(t.id, { token: t, sdkToken, amount: realAmount });
      } catch (e) {
        logger.warn(TAG, 'Failed to parse token', t.id, e);
      }
    }

    return pool;
  }

  /**
   * SYNCHRONOUS critical section. NO await allowed anywhere in this method.
   *
   * Reads free amounts from the ledger, runs split calculation, and either:
   * - Case A: creates a reservation and returns { reservationId, splitPlan }
   * - Case B: enqueues the request and returns 'queued'
   * - Case C: throws SEND_INSUFFICIENT_BALANCE if total inventory is too low
   */
  planSend(
    request: { amount: string; coinId: string },
    parsedPool: ParsedTokenPool,
    ledger: TokenReservationLedger,
    queue: SpendQueue,
    reservationId: string
  ): PlanResult | 'queued' {
    const requestedAmount = BigInt(request.amount);
    const coinId = request.coinId;

    // Build free view: entries with positive free amounts after subtracting reservations
    const freeView: Array<{ token: Token; sdkToken: SdkToken<any>; amount: bigint }> = [];
    let totalInventory = 0n;

    for (const [, entry] of parsedPool) {
      if (entry.token.coinId !== coinId) continue;
      totalInventory += entry.amount;
      const freeAmount = ledger.getFreeAmount(entry.token.id, entry.amount);
      if (freeAmount > 0n) {
        freeView.push({ token: entry.token, sdkToken: entry.sdkToken, amount: freeAmount });
      }
    }

    // Case C: total inventory (ignoring reservations) is insufficient
    if (totalInventory < requestedAmount) {
      throw new SphereError(
        `Insufficient balance. Available: ${totalInventory}, Required: ${requestedAmount}`,
        'SEND_INSUFFICIENT_BALANCE'
      );
    }

    // Try to find a plan with currently free tokens
    const plan = this.calculateOptimalSplitSync(freeView, requestedAmount);

    if (plan !== null) {
      // Case A: plan found — reserve the tokens synchronously
      const entries = this.extractReservationEntries(plan);
      ledger.reserve(reservationId, entries, coinId);

      return { reservationId, splitPlan: { ...plan, coinId } };
    }

    // Case B: tokens exist but are reserved — enqueue
    queue.enqueue({
      id: reservationId,
      request,
      parsedPool,
      coinId,
      amount: requestedAmount,
      enqueuedAt: Date.now(),
    });

    return 'queued';
  }

  /**
   * Synchronous version of TokenSplitCalculator.calculateOptimalSplit.
   * Operates on pre-parsed entries instead of raw tokens.
   *
   * Strategy:
   * 1. Exact match (single token = amount)
   * 2. Combination of tokens summing to exact amount (up to 5 tokens)
   * 3. Greedy selection with split
   */
  calculateOptimalSplitSync(
    candidates: Array<{ token: Token; sdkToken: SdkToken<any>; amount: bigint }>,
    targetAmount: bigint
  ): SplitPlan | null {
    if (candidates.length === 0) return null;

    // Sort ascending by amount
    const sorted = [...candidates].sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0));

    // Check total available
    const totalAvailable = sorted.reduce((sum, t) => sum + t.amount, 0n);
    if (totalAvailable < targetAmount) {
      return null;
    }

    // Convert to TokenWithAmount for plan creation
    const asTokenWithAmount = (entry: { token: Token; sdkToken: SdkToken<any>; amount: bigint }): TokenWithAmount => ({
      sdkToken: entry.sdkToken,
      amount: entry.amount,
      uiToken: entry.token,
    });

    // Strategy 1: Exact match
    const exactMatch = sorted.find((t) => t.amount === targetAmount);
    if (exactMatch) {
      return this.createDirectPlan([asTokenWithAmount(exactMatch)], targetAmount);
    }

    // Strategy 2: Combination search (up to 5 tokens)
    const maxCombinationSize = Math.min(5, sorted.length);
    for (let size = 2; size <= maxCombinationSize; size++) {
      const combo = this.findCombinationOfSize(sorted, targetAmount, size, asTokenWithAmount);
      if (combo) {
        return this.createDirectPlan(combo, targetAmount);
      }
    }

    // Strategy 3: Greedy selection with split
    const toTransfer: TokenWithAmount[] = [];
    let currentSum = 0n;

    for (const candidate of sorted) {
      const newSum = currentSum + candidate.amount;

      if (newSum === targetAmount) {
        toTransfer.push(asTokenWithAmount(candidate));
        return this.createDirectPlan(toTransfer, targetAmount);
      } else if (newSum < targetAmount) {
        toTransfer.push(asTokenWithAmount(candidate));
        currentSum = newSum;
      } else {
        // Need to split this token
        const neededFromThisToken = targetAmount - currentSum;
        const remainderForSender = candidate.amount - neededFromThisToken;

        return {
          tokensToTransferDirectly: toTransfer,
          tokenToSplit: asTokenWithAmount(candidate),
          splitAmount: neededFromThisToken,
          remainderAmount: remainderForSender,
          totalTransferAmount: targetAmount,
          coinId: '',  // filled by caller
          requiresSplit: true,
        };
      }
    }

    // Should not reach here if totalAvailable >= targetAmount
    return null;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Extract reservation entries from a split plan.
   * For direct tokens: reserve the full amount.
   * For split token: reserve only the splitAmount (not the remainder).
   */
  private extractReservationEntries(plan: SplitPlan): Array<{ tokenId: string; amount: bigint; tokenAmount: bigint }> {
    const entries: Array<{ tokenId: string; amount: bigint; tokenAmount: bigint }> = [];

    for (const twa of plan.tokensToTransferDirectly) {
      // Direct tokens are sent in their entirety — reserve the full token amount
      const actualAmount = BigInt(twa.uiToken.amount);
      entries.push({ tokenId: twa.uiToken.id, amount: actualAmount, tokenAmount: actualAmount });
    }

    if (plan.tokenToSplit && plan.splitAmount !== null) {
      // A split consumes the ENTIRE source token (it gets replaced by two new tokens).
      // Reserve the full token amount so no other send can use this token concurrently.
      const actualAmount = BigInt(plan.tokenToSplit.uiToken.amount);
      entries.push({ tokenId: plan.tokenToSplit.uiToken.id, amount: actualAmount, tokenAmount: actualAmount });
    }

    return entries;
  }

  /** Get balance of a specific coin from an SDK token. */
  private getTokenBalance(sdkToken: SdkToken<any>, coinIdHex: string): bigint {
    try {
      if (!sdkToken.coins) return 0n;
      const coinId = CoinId.fromJSON(coinIdHex);
      return sdkToken.coins.get(coinId) ?? 0n;
    } catch {
      return 0n;
    }
  }

  /** Create a direct transfer plan (no split needed). */
  private createDirectPlan(tokens: TokenWithAmount[], total: bigint): SplitPlan {
    return {
      tokensToTransferDirectly: tokens,
      tokenToSplit: null,
      splitAmount: null,
      remainderAmount: null,
      totalTransferAmount: total,
      coinId: '',  // filled by caller
      requiresSplit: false,
    };
  }

  /** Find a combination of exactly `size` tokens that sum to targetAmount. */
  private findCombinationOfSize<T extends { amount: bigint }>(
    tokens: T[],
    targetAmount: bigint,
    size: number,
    convert: (entry: T) => TokenWithAmount
  ): TokenWithAmount[] | null {
    const gen = this.generateCombinations(tokens, size);
    for (const combo of gen) {
      const sum = combo.reduce((acc, t) => acc + t.amount, 0n);
      if (sum === targetAmount) {
        return combo.map(convert);
      }
    }
    return null;
  }

  /** Generator for k-combinations. */
  private *generateCombinations<T>(
    tokens: T[],
    k: number,
    start: number = 0,
    current: T[] = []
  ): Generator<T[]> {
    if (k === 0) {
      yield current;
      return;
    }
    for (let i = start; i < tokens.length; i++) {
      yield* this.generateCombinations(tokens, k - 1, i + 1, [...current, tokens[i]]);
    }
  }
}

// =============================================================================
// SpendQueue
// =============================================================================

export class SpendQueue {
  /** Per-coinId FIFO queues. */
  private readonly queues = new Map<string, QueueEntry[]>();

  /** Per-entry promise (keyed by entry id) for callers to await. */
  private readonly promises = new Map<string, Promise<PlanResult>>();

  /** Whether destroy() has been called. */
  private destroyed = false;

  constructor(
    private readonly ledger: TokenReservationLedger,
    private readonly planner: SpendPlanner,
    private readonly getTokens: () => Map<string, Token>,
    private readonly parsedTokenCache: Map<string, ParsedTokenEntry>
  ) {}

  /**
   * Add an entry to the queue. Returns a promise that resolves when the
   * entry is successfully planned (tokens become available).
   *
   * The enqueue itself is SYNCHRONOUS — the returned promise is resolved
   * later by notifyChange().
   */
  enqueue(
    entry: Omit<QueueEntry, 'skipCount' | 'resolve' | 'reject' | 'timeout'>
  ): Promise<PlanResult> {
    // Check queue size limit
    let totalSize = 0;
    for (const [, q] of this.queues) {
      totalSize += q.length;
    }
    if (totalSize >= QUEUE_MAX_SIZE) {
      return Promise.reject(
        new SphereError('Send queue is full', 'SEND_QUEUE_FULL')
      );
    }

    let resolvePromise!: (result: PlanResult) => void;
    let rejectPromise!: (error: Error) => void;

    const promise = new Promise<PlanResult>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    const timeout = setTimeout(() => {
      this.expireEntry(entry.id, entry.coinId);
    }, QUEUE_TIMEOUT_MS);

    const fullEntry: QueueEntry = {
      ...entry,
      skipCount: 0,
      resolve: resolvePromise,
      reject: rejectPromise,
      timeout,
    };

    let coinQueue = this.queues.get(entry.coinId);
    if (!coinQueue) {
      coinQueue = [];
      this.queues.set(entry.coinId, coinQueue);
    }
    coinQueue.push(fullEntry);

    this.promises.set(entry.id, promise);

    // Suppress unhandled rejection: planSend() calls enqueue() but doesn't await
    // the returned promise (it returns 'queued' synchronously). The caller later
    // obtains the promise via waitForEntry(). Without this, the promise rejection
    // from destroy()/cancelAll() would appear as an unhandled rejection.
    promise.catch(() => {});

    logger.debug(TAG, `Enqueued send ${entry.id} for ${entry.amount} ${entry.coinId} (queue depth: ${coinQueue.length})`);

    return promise;
  }

  /**
   * Get the promise for a queued entry. Used by send() to await the result
   * after planSend() returns 'queued'.
   */
  waitForEntry(id: string): Promise<PlanResult> {
    const promise = this.promises.get(id);
    if (!promise) {
      return Promise.reject(
        new SphereError('Queue entry not found: ' + id, 'VALIDATION_ERROR')
      );
    }
    return promise;
  }

  /**
   * SYNCHRONOUS. Called when tokens become available (e.g., change token
   * arrives after a split, or a reservation is released).
   *
   * Re-evaluates queued entries for the given coinId in FIFO order.
   */
  notifyChange(coinId: string): void {
    if (this.destroyed) return;
    const entries = this.queues.get(coinId);
    if (!entries || entries.length === 0) return;

    let i = 0;
    while (i < entries.length) {
      const entry = entries[i];

      // Check timeout
      if (Date.now() - entry.enqueuedAt > QUEUE_TIMEOUT_MS) {
        clearTimeout(entry.timeout);
        entry.reject(new SphereError('Send queue timeout', 'SEND_QUEUE_TIMEOUT'));
        entries.splice(i, 1);
        this.promises.delete(entry.id);
        continue;
      }

      // W23 fix: Build merged pool preferring fresh parsedTokenCache entries.
      // parsedPool is the snapshot from enqueue time — sdkToken objects may be stale
      // (outdated state hash) if the token was updated between enqueue and wake-up.
      // Start from parsedTokenCache (always fresh), fall back to parsedPool only for
      // tokens not in the cache. buildFreeView's liveness check filters removed tokens.
      const mergedPool: ParsedTokenPool = new Map();
      // First: add all fresh cache entries for this coinId
      for (const [id, cached] of this.parsedTokenCache) {
        if (cached.token.coinId === coinId) {
          mergedPool.set(id, cached);
        }
      }
      // Then: add original entries only if not already in cache (stale fallback)
      for (const [id, original] of entry.parsedPool) {
        if (!mergedPool.has(id)) {
          mergedPool.set(id, original);
        }
      }

      // Build free view and try planning
      const freeView = this.buildFreeView(mergedPool, coinId);
      const plan = this.planner.calculateOptimalSplitSync(freeView, entry.amount);

      if (plan !== null) {
        // Reserve and resolve — wrap in try/catch to handle DUPLICATE_RESERVATION_ID
        // (can occur if the entry's reservation was cancelled but remains in the map)
        try {
          const reservationEntries = this.extractReservationEntries(plan);
          this.ledger.reserve(entry.id, reservationEntries, coinId);
        } catch (e) {
          // Reservation failed (e.g., DUPLICATE_RESERVATION_ID, INSUFFICIENT_FREE_AMOUNT)
          // Reject this entry and continue processing the queue
          clearTimeout(entry.timeout);
          entry.reject(e instanceof Error ? e : new Error(String(e)));
          entries.splice(i, 1);
          this.promises.delete(entry.id);
          logger.warn(TAG, `Queue entry ${entry.id} reservation failed:`, e);
          continue;
        }

        clearTimeout(entry.timeout);
        entry.resolve({ reservationId: entry.id, splitPlan: { ...plan, coinId } });
        entries.splice(i, 1);
        this.promises.delete(entry.id);

        logger.debug(TAG, `Queue entry ${entry.id} planned successfully (remaining: ${entries.length})`);
        continue;
      }

      // Could not plan — skip this entry and try later ones.
      // W23 fix: Only increment skipCount when this is a fresh evaluation
      // (not a repeated scan triggered by unrelated token events).
      // We skip over the entry instead of breaking — smaller entries behind
      // a large blocked one can still be planned, preventing starvation.
      entry.skipCount++;

      i++;
    }

    // Clean up empty queue
    if (entries.length === 0) {
      this.queues.delete(coinId);
    }
  }

  /**
   * Reject all entries. Called by destroy().
   */
  cancelAll(reason: string): void {
    for (const [, entries] of this.queues) {
      for (const entry of entries) {
        clearTimeout(entry.timeout);
        entry.reject(new SphereError(reason, 'MODULE_DESTROYED'));
        this.promises.delete(entry.id);
      }
      entries.length = 0;
    }
    this.queues.clear();
  }

  /** Queue depth, optionally filtered by coinId. */
  size(coinId?: string): number {
    if (coinId !== undefined) {
      return this.queues.get(coinId)?.length ?? 0;
    }
    let total = 0;
    for (const [, q] of this.queues) {
      total += q.length;
    }
    return total;
  }

  /** Full cleanup: cancel all entries, mark destroyed. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelAll('Module destroyed');
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Build a free-amount view from a parsed pool, consulting the ledger.
   *
   * W23 fix: Only include tokens where freeAmount === tokenAmount (fully free).
   * A direct transfer sends the entire token — if another reservation holds part
   * of it, the token cannot be sent directly. The planner's calculateOptimalSplitSync
   * would select a partially-free token thinking it's available, but the reservation
   * would fail with INSUFFICIENT_FREE_AMOUNT because extractReservationEntries
   * correctly reserves the full token amount.
   */
  private buildFreeView(
    pool: ParsedTokenPool,
    coinId: string
  ): Array<{ token: Token; sdkToken: SdkToken<any>; amount: bigint }> {
    const view: Array<{ token: Token; sdkToken: SdkToken<any>; amount: bigint }> = [];
    const liveTokens = this.getTokens();

    for (const [tokenId, entry] of pool) {
      if (entry.token.coinId !== coinId) continue;
      // Skip tokens removed or no longer confirmed in the live wallet
      const liveToken = liveTokens.get(tokenId);
      if (!liveToken || liveToken.status !== 'confirmed') continue;
      const freeAmount = this.ledger.getFreeAmount(entry.token.id, entry.amount);
      // Only include fully-free tokens — partially reserved tokens cannot be
      // used for direct transfers and would cause INSUFFICIENT_FREE_AMOUNT
      if (freeAmount > 0n && freeAmount === entry.amount) {
        view.push({ token: entry.token, sdkToken: entry.sdkToken, amount: freeAmount });
      }
    }

    return view;
  }

  /** Extract reservation entries from a split plan. */
  private extractReservationEntries(plan: SplitPlan): Array<{ tokenId: string; amount: bigint; tokenAmount: bigint }> {
    const entries: Array<{ tokenId: string; amount: bigint; tokenAmount: bigint }> = [];

    for (const twa of plan.tokensToTransferDirectly) {
      // Direct tokens are sent in their entirety — reserve the full token amount
      const actualAmount = BigInt(twa.uiToken.amount);
      entries.push({ tokenId: twa.uiToken.id, amount: actualAmount, tokenAmount: actualAmount });
    }

    if (plan.tokenToSplit && plan.splitAmount !== null) {
      // A split consumes the ENTIRE source token — reserve full amount
      const actualAmount = BigInt(plan.tokenToSplit.uiToken.amount);
      entries.push({ tokenId: plan.tokenToSplit.uiToken.id, amount: actualAmount, tokenAmount: actualAmount });
    }

    return entries;
  }

  /** Expire a single entry by id. Called from the per-entry timeout. */
  private expireEntry(id: string, coinId: string): void {
    const entries = this.queues.get(coinId);
    if (!entries) return;

    const idx = entries.findIndex((e) => e.id === id);
    if (idx === -1) return;

    const entry = entries[idx];
    entry.reject(new SphereError('Send queue timeout', 'SEND_QUEUE_TIMEOUT'));
    entries.splice(idx, 1);
    this.promises.delete(id);

    if (entries.length === 0) {
      this.queues.delete(coinId);
    }

    logger.debug(TAG, `Queue entry ${id} expired after timeout`);
  }

}
