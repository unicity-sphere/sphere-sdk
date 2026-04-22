/**
 * CAR-loss tracker (T-C5) — persistent retry ledger.
 *
 * Covers:
 *   - recordAttempt persists across process restart (FlagStore durability)
 *   - getAttempts returns chronological order
 *   - clearAttempts removes ledger
 *   - canInvokeAcceptCarLoss gate satisfied only when BOTH count and
 *     wall-clock conditions are met
 *   - assertAcceptCarLossEligible throws UNREACHABLE_RECOVERY_BLOCKED when
 *     the gate is unsatisfied
 *   - corrupt ledger JSON treated as empty (non-fatal)
 *   - entry cap prevents unbounded growth
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordAttempt,
  getAttempts,
  clearAttempts,
  canInvokeAcceptCarLoss,
  assertAcceptCarLossEligible,
  FlagStore,
  DURABLE_STORAGE,
  AggregatorPointerErrorCode,
  CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS,
  CAR_FETCH_PERSISTENT_TOTAL_DURATION_MS,
} from '../../../../profile/aggregator-pointer/index.js';

const PUBKEY = 'ab'.repeat(33);

function makeDurableStore() {
  const kv = new Map<string, string>();
  return {
    get: async (k: string) => kv.get(k) ?? null,
    set: async (k: string, v: string) => { kv.set(k, v); },
    remove: async (k: string) => { kv.delete(k); },
    has: async (k: string) => kv.has(k),
    keys: async () => [...kv.keys()],
    clear: async () => { kv.clear(); },
    setIdentity: () => {},
    saveTrackedAddresses: async () => {},
    loadTrackedAddresses: async () => [],
    initialize: async () => {},
    shutdown: async () => {},
    name: 'test',
    [DURABLE_STORAGE]: true as const,
  };
}

function makeFlagStore() {
  return FlagStore.create(makeDurableStore() as never, PUBKEY);
}

describe('recordAttempt + getAttempts (T-C5)', () => {
  let fs: FlagStore;
  beforeEach(() => { fs = makeFlagStore(); });

  it('starts empty', async () => {
    expect(await getAttempts(fs, 5)).toEqual([]);
  });

  it('records attempts with timestamp and gateway', async () => {
    await recordAttempt(fs, 5, 'https://ipfs.example.com', 1000);
    await recordAttempt(fs, 5, 'https://gateway2.example.com', 2000);

    const attempts = await getAttempts(fs, 5);
    expect(attempts.length).toBe(2);
    expect(attempts[0]).toEqual({ ts: 1000, gateway: 'https://ipfs.example.com' });
    expect(attempts[1]).toEqual({ ts: 2000, gateway: 'https://gateway2.example.com' });
  });

  it('attempts for different versions are independent', async () => {
    await recordAttempt(fs, 5, 'g1', 1000);
    await recordAttempt(fs, 6, 'g2', 2000);

    expect(await getAttempts(fs, 5)).toEqual([{ ts: 1000, gateway: 'g1' }]);
    expect(await getAttempts(fs, 6)).toEqual([{ ts: 2000, gateway: 'g2' }]);
  });

  it('clearAttempts removes all attempts for version', async () => {
    await recordAttempt(fs, 5, 'g1', 1000);
    await clearAttempts(fs, 5);
    expect(await getAttempts(fs, 5)).toEqual([]);
  });

  it('bounded ledger prunes oldest past MAX_ATTEMPTS_RETAINED', async () => {
    const cap = CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS * 4; // 48
    // Record cap + 5 attempts.
    for (let i = 0; i < cap + 5; i++) {
      await recordAttempt(fs, 5, `g${i}`, i * 1000);
    }
    const attempts = await getAttempts(fs, 5);
    expect(attempts.length).toBe(cap);
    // Oldest entries pruned: first retained should be at index 5.
    expect(attempts[0]!.ts).toBe(5 * 1000);
  });

  it('corrupt ledger JSON treated as empty (non-fatal)', async () => {
    // Inject malformed JSON directly.
    await (fs as unknown as { set(k: string, v: string): Promise<void> }).set(
      'car_loss_attempts_5',
      'not-valid-json{{',
    );
    expect(await getAttempts(fs, 5)).toEqual([]);
  });

  it('persists across FlagStore instances (durable)', async () => {
    const sharedStorage = makeDurableStore();
    const fsA = FlagStore.create(sharedStorage as never, PUBKEY);
    await recordAttempt(fsA, 5, 'g1', 1000);

    const fsB = FlagStore.create(sharedStorage as never, PUBKEY);
    expect(await getAttempts(fsB, 5)).toEqual([{ ts: 1000, gateway: 'g1' }]);
  });
});

// ── canInvokeAcceptCarLoss (H7 gate) ───────────────────────────────────────

describe('canInvokeAcceptCarLoss (H7 gate)', () => {
  let fs: FlagStore;
  beforeEach(() => { fs = makeFlagStore(); });

  it('returns ineligible when no attempts recorded', async () => {
    const gate = await canInvokeAcceptCarLoss(fs, 5, 0);
    expect(gate.eligible).toBe(false);
    expect(gate.attemptCount).toBe(0);
    expect(gate.attemptsRemaining).toBe(CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS);
  });

  it('returns ineligible with fewer than required attempts', async () => {
    for (let i = 0; i < CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS - 1; i++) {
      await recordAttempt(fs, 5, 'g', i * 1000);
    }
    const gate = await canInvokeAcceptCarLoss(fs, 5, 0);
    expect(gate.eligible).toBe(false);
    expect(gate.attemptsRemaining).toBe(1);
  });

  it('returns ineligible when count satisfied but wall-clock insufficient', async () => {
    // 12 attempts within 1 hour
    for (let i = 0; i < CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS; i++) {
      await recordAttempt(fs, 5, 'g', i * 60_000); // every 1 min for 12 attempts → 11 min span
    }
    const gate = await canInvokeAcceptCarLoss(fs, 5, CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS * 60_000);
    expect(gate.eligible).toBe(false);
    expect(gate.attemptsRemaining).toBe(0);
    expect(gate.msRemaining).toBeGreaterThan(0);
  });

  it('returns eligible when both count and wall-clock satisfied', async () => {
    for (let i = 0; i < CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS; i++) {
      // First attempt at t=0, last at t=24h
      await recordAttempt(fs, 5, 'g', i === 0 ? 0 : CAR_FETCH_PERSISTENT_TOTAL_DURATION_MS);
    }
    const gate = await canInvokeAcceptCarLoss(fs, 5, CAR_FETCH_PERSISTENT_TOTAL_DURATION_MS);
    expect(gate.eligible).toBe(true);
    expect(gate.attemptsRemaining).toBe(0);
    expect(gate.msRemaining).toBe(0);
  });

  it('reports elapsed wall-clock span (max - min)', async () => {
    await recordAttempt(fs, 5, 'g', 1000);
    await recordAttempt(fs, 5, 'g', 100_000);
    const gate = await canInvokeAcceptCarLoss(fs, 5, 200_000);
    expect(gate.elapsedMs).toBeGreaterThanOrEqual(99_000);
  });
});

// ── assertAcceptCarLossEligible ────────────────────────────────────────────

describe('assertAcceptCarLossEligible', () => {
  let fs: FlagStore;
  beforeEach(() => { fs = makeFlagStore(); });

  it('throws UNREACHABLE_RECOVERY_BLOCKED when gate not satisfied', async () => {
    await expect(assertAcceptCarLossEligible(fs, 5)).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.UNREACHABLE_RECOVERY_BLOCKED,
    });
  });

  it('does not throw when gate is satisfied', async () => {
    for (let i = 0; i < CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS; i++) {
      await recordAttempt(fs, 5, 'g', i === 0 ? 0 : CAR_FETCH_PERSISTENT_TOTAL_DURATION_MS);
    }
    await expect(
      assertAcceptCarLossEligible(fs, 5, CAR_FETCH_PERSISTENT_TOTAL_DURATION_MS),
    ).resolves.toBeUndefined();
  });
});
