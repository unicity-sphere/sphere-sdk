/**
 * Tests for the shared OVER_TRANSFER_GUARD helper (Loop1-S5/S6).
 *
 * Locks down the fail-CLOSED contract on malformed coinData, the
 * multi-coin budget aggregation, and the NFT/empty-coinData skip
 * semantics. The guard is invoked from BOTH sendInstantUxf and
 * sendConservativeUxf — this test exercises the helper directly so a
 * regression in either orchestrator's call site won't slip past.
 */

import { describe, expect, it } from 'vitest';

import { enforceOverTransferGuard, type GuardCommitResult } from '../../../../modules/payments/transfer/over-transfer-guard';
import { isSphereError } from '../../../../core/errors';
import type { TransferRequest } from '../../../../types';

function req(overrides: Partial<TransferRequest> = {}): TransferRequest {
  return {
    recipient: '@bob',
    coinId: 'UCT',
    amount: '1000000',
    transferMode: 'instant',
    ...overrides,
  };
}

function coinResult(
  sourceTokenId: string,
  coinData: ReadonlyArray<readonly [string, string]>,
): GuardCommitResult {
  return {
    sourceTokenId,
    tokenClass: 'coin',
    recipientTokenJson: {
      genesis: {
        data: {
          coinData,
        },
      },
    },
  };
}

function nftResult(sourceTokenId: string): GuardCommitResult {
  return {
    sourceTokenId,
    tokenClass: 'nft',
    recipientTokenJson: {
      genesis: {
        data: {
          coinData: [],
        },
      },
    },
  };
}

describe('enforceOverTransferGuard — single-coin', () => {
  it('passes when shipped equals request budget', () => {
    expect(() =>
      enforceOverTransferGuard(req({ amount: '1000' }), [coinResult('t1', [['UCT', '1000']])]),
    ).not.toThrow();
  });

  it('passes when shipped is below request budget', () => {
    expect(() =>
      enforceOverTransferGuard(req({ amount: '5000' }), [coinResult('t1', [['UCT', '1000']])]),
    ).not.toThrow();
  });

  it('throws OVER_TRANSFER_GUARD when shipped exceeds budget', () => {
    let caught: unknown;
    try {
      enforceOverTransferGuard(req({ amount: '500' }), [coinResult('t1', [['UCT', '1000']])]);
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('OVER_TRANSFER_GUARD');
    expect(caught.message).toContain('1000');
    expect(caught.message).toContain('500');
    expect(caught.message).toContain('UCT');
  });

  it('throws when shipped > 0 but budget is zero (malformed budget)', () => {
    // Malformed primary amount → treated as zero budget. Any shipped
    // amount > 0 trips the guard — fail-closed.
    let caught: unknown;
    try {
      enforceOverTransferGuard(req({ amount: 'not-a-number' }), [coinResult('t1', [['UCT', '1']])]);
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('OVER_TRANSFER_GUARD');
  });
});

describe('enforceOverTransferGuard — multi-coin (additionalAssets)', () => {
  it('passes when each coin is at-or-below its budget', () => {
    expect(() =>
      enforceOverTransferGuard(
        req({
          amount: '1000',
          coinId: 'UCT',
          additionalAssets: [{ kind: 'coin', coinId: 'USDU', amount: '500' }],
        }),
        [
          coinResult('t1', [['UCT', '1000']]),
          coinResult('t2', [['USDU', '500']]),
        ],
      ),
    ).not.toThrow();
  });

  it('throws when USDU over-sends even if UCT is correct', () => {
    let caught: unknown;
    try {
      enforceOverTransferGuard(
        req({
          amount: '1000',
          coinId: 'UCT',
          additionalAssets: [{ kind: 'coin', coinId: 'USDU', amount: '500' }],
        }),
        [
          coinResult('t1', [['UCT', '1000']]),
          coinResult('t2', [['USDU', '600']]),
        ],
      );
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('OVER_TRANSFER_GUARD');
    expect(caught.message).toContain('USDU');
  });

  it('sums duplicate additional-asset coin entries into one budget', () => {
    // Two USDU entries totaling 800 — shipping 800 must pass.
    expect(() =>
      enforceOverTransferGuard(
        req({
          amount: '0',
          coinId: 'UCT',
          additionalAssets: [
            { kind: 'coin', coinId: 'USDU', amount: '500' },
            { kind: 'coin', coinId: 'USDU', amount: '300' },
          ],
        }),
        [coinResult('t1', [['USDU', '800']])],
      ),
    ).not.toThrow();
  });
});

describe('enforceOverTransferGuard — fail-CLOSED on malformed amounts', () => {
  it('throws on non-numeric shipped amount (regression — earlier silent skip)', () => {
    // The pre-Loop1-S5 implementation silently skipped this entry,
    // shipping=0n, budget=anything, guard passes → fail-OPEN. The
    // fix: throw OVER_TRANSFER_GUARD so the structural violation is
    // surfaced.
    let caught: unknown;
    try {
      enforceOverTransferGuard(req({ amount: '1000' }), [
        coinResult('t1', [['UCT', 'abc']]),
      ]);
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('OVER_TRANSFER_GUARD');
    expect(caught.message).toContain('not a valid BigInt');
  });

  it('throws on non-tuple coinData entry', () => {
    const malformed: GuardCommitResult = {
      sourceTokenId: 't1',
      tokenClass: 'coin',
      recipientTokenJson: {
        genesis: {
          data: {
            coinData: [['UCT'] as unknown as readonly [string, string]],
          },
        },
      },
    };
    let caught: unknown;
    try {
      enforceOverTransferGuard(req(), [malformed]);
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('OVER_TRANSFER_GUARD');
    expect(caught.message).toContain('2-tuple');
  });

  it('throws on non-string entries in coinData tuple', () => {
    const malformed: GuardCommitResult = {
      sourceTokenId: 't1',
      tokenClass: 'coin',
      recipientTokenJson: {
        genesis: {
          data: {
            coinData: [[42 as unknown as string, '1000']],
          },
        },
      },
    };
    let caught: unknown;
    try {
      enforceOverTransferGuard(req(), [malformed]);
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('OVER_TRANSFER_GUARD');
  });
});

describe('enforceOverTransferGuard — skip semantics', () => {
  it('skips NFT-class entries even if they would over-send by amount', () => {
    // NFTs do not have fungible amount; the guard must not interpret
    // them as coin transfers regardless of coinData shape.
    expect(() =>
      enforceOverTransferGuard(req({ amount: '0', coinId: 'UCT' }), [nftResult('t1')]),
    ).not.toThrow();
  });

  it('skips coin-class entry with EMPTY coinData (NFT-shape)', () => {
    // A coin commit-result with empty coinData is treated as NFT-shape
    // for the guard's purposes (the downstream verifier handles class
    // discrimination; the guard's job is only the over-send arithmetic).
    expect(() =>
      enforceOverTransferGuard(req({ amount: '0', coinId: 'UCT' }), [
        coinResult('t1', []),
      ]),
    ).not.toThrow();
  });

  it('skips commit results without genesis.data.coinData', () => {
    const noCoinData: GuardCommitResult = {
      sourceTokenId: 't1',
      tokenClass: 'coin',
      recipientTokenJson: {
        genesis: {
          data: {},
        },
      },
    };
    expect(() =>
      enforceOverTransferGuard(req({ amount: '0', coinId: 'UCT' }), [noCoinData]),
    ).not.toThrow();
  });

  it('empty commit results array passes', () => {
    expect(() => enforceOverTransferGuard(req(), [])).not.toThrow();
  });
});

describe('enforceOverTransferGuard — Loop2-C4 negative amount rejection', () => {
  it('throws on NEGATIVE shipped amount (regression — earlier silent fail-OPEN)', () => {
    // Pre-Loop2-C4: BigInt('-100')=-100n; shipped=-100n is always
    // <= any positive budget → guard PASSED. A buggy commitSources
    // producing `coinData: [['UCT', '-100']]` evaded the guard.
    // Fix: throw on negative shipped.
    let caught: unknown;
    try {
      enforceOverTransferGuard(req({ amount: '1000' }), [
        coinResult('t1', [['UCT', '-100']]),
      ]);
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('OVER_TRANSFER_GUARD');
    expect(caught.message).toContain('negative');
  });

  it('clamps NEGATIVE request budget to 0n (no false-positive throws)', () => {
    // A negative request budget would otherwise cause shipped=0n
    // checks to fail: 0n > -100n is true → false-positive throw.
    // Loop2-C4 clamps negative budgets to 0n so the arithmetic is
    // monotonic. Shipping exactly 0 should not trip the guard.
    expect(() =>
      enforceOverTransferGuard(req({ amount: '-100' }), [
        coinResult('t1', []),
      ]),
    ).not.toThrow();
  });

  it('clamped budget still trips on positive shipped (fail-closed)', () => {
    // Negative budget clamped to 0n; any shipped > 0 must trip.
    let caught: unknown;
    try {
      enforceOverTransferGuard(req({ amount: '-100' }), [
        coinResult('t1', [['UCT', '50']]),
      ]);
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('OVER_TRANSFER_GUARD');
  });
});

describe('enforceOverTransferGuard — multiple sources contributing to one coin', () => {
  it('sums shipped amounts across sources before comparing to budget', () => {
    // Two coin sources each shipping 600 UCT → total 1200 UCT.
    // Budget 1000 → throws.
    let caught: unknown;
    try {
      enforceOverTransferGuard(req({ amount: '1000' }), [
        coinResult('t1', [['UCT', '600']]),
        coinResult('t2', [['UCT', '600']]),
      ]);
    } catch (err) {
      caught = err;
    }
    if (!isSphereError(caught)) throw new Error('expected SphereError');
    expect(caught.code).toBe('OVER_TRANSFER_GUARD');
    expect(caught.message).toContain('1200');
  });

  it('passes when summed shipped equals budget exactly', () => {
    expect(() =>
      enforceOverTransferGuard(req({ amount: '1000' }), [
        coinResult('t1', [['UCT', '300']]),
        coinResult('t2', [['UCT', '700']]),
      ]),
    ).not.toThrow();
  });
});
