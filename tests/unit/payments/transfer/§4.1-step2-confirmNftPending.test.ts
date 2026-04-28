/**
 * §4.1 step 2 — `confirmNftPending` rejection (T.2.B / W11).
 *
 * Mirrors §4.1 step 2's "NFT cascade asymmetry warning":
 *
 * > Coin cascades cost fungible value (replaceable from elsewhere); NFT
 * > cascades cost non-fungible identity (irrecoverable — no other peer
 * > can produce the same `tokenId`). … Defaults: `confirmNftPending: false`;
 * > sending pending NFTs without explicit acknowledgement →
 * > `NFT_PENDING_REQUIRES_CONFIRMATION` rejection.
 *
 * The validator (T.2.B) is the FIRST line of defense for W11. T.5.A
 * (instant-mode sender) re-runs the same validator at its entry point
 * for defense-in-depth — same rejection code, same predicate.
 *
 * Tests in this file:
 *  - Pending NFT source + `confirmNftPending: undefined` → reject (default false).
 *  - Pending NFT source + `confirmNftPending: false`     → reject.
 *  - Pending NFT source + `confirmNftPending: true`      → accept.
 *  - NON-pending NFT source                              → accept regardless of flag.
 *  - Pending NFT but only one of multiple is pending     → reject when ANY is pending.
 *  - confirmNftPending only matters for NFT targets, not coin targets.
 */

import { describe, expect, it } from 'vitest';

import { validateTargets } from '../../../../modules/payments/transfer/target-validator';
import type { TokenLike } from '../../../../modules/payments/transfer/classify-token';
import { isSphereError } from '../../../../core/errors';
import type { TransferRequest } from '../../../../types';

function nftToken(
  id: string,
  opts: { pending?: boolean } = {},
): TokenLike {
  return {
    id,
    coins: null,
    ...(opts.pending !== undefined ? { pending: opts.pending } : {}),
  };
}

function coinToken(
  id: string,
  entries: ReadonlyArray<readonly [string, bigint]>,
  opts: { pending?: boolean } = {},
): TokenLike {
  return {
    id,
    coins: entries.map(([coinId, amount]) => ({ coinId, amount })),
    ...(opts.pending !== undefined ? { pending: opts.pending } : {}),
  };
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    if (!isSphereError(err)) {
      throw new Error(
        `expected SphereError; got ${err instanceof Error ? err.constructor.name : typeof err}: ${String(err)}`,
      );
    }
    expect(err.code).toBe(code);
    return;
  }
  throw new Error(`expected fn to throw SphereError(${code}); but it returned`);
}

// =============================================================================
// W11 — pending NFT without confirmation.
// =============================================================================

describe('§4.1 step 2 — confirmNftPending rejection (W11)', () => {
  it('rejects pending NFT source when confirmNftPending is undefined (default)', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      additionalAssets: [{ kind: 'nft', tokenId: 'PENDING-NFT' }],
    };
    expectCode(
      () => validateTargets(req, [nftToken('PENDING-NFT', { pending: true })]),
      'NFT_PENDING_REQUIRES_CONFIRMATION',
    );
  });

  it('rejects pending NFT source when confirmNftPending is explicitly false', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      confirmNftPending: false,
      additionalAssets: [{ kind: 'nft', tokenId: 'PENDING-NFT' }],
    };
    expectCode(
      () => validateTargets(req, [nftToken('PENDING-NFT', { pending: true })]),
      'NFT_PENDING_REQUIRES_CONFIRMATION',
    );
  });

  it('PERMITS pending NFT source when confirmNftPending is true', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      confirmNftPending: true,
      additionalAssets: [{ kind: 'nft', tokenId: 'PENDING-NFT' }],
    };
    const out = validateTargets(req, [nftToken('PENDING-NFT', { pending: true })]);
    expect(out.targetList).toEqual([{ kind: 'nft', tokenId: 'PENDING-NFT' }]);
  });

  it('PERMITS non-pending NFT source regardless of confirmNftPending value', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      additionalAssets: [{ kind: 'nft', tokenId: 'GOOD-NFT' }],
    };
    // pending: false → no acknowledgement needed.
    expect(() => validateTargets(req, [nftToken('GOOD-NFT', { pending: false })])).not.toThrow();

    // pending omitted → treated as not pending.
    expect(() => validateTargets(req, [nftToken('GOOD-NFT')])).not.toThrow();
  });

  it('rejects when ANY of multiple NFT targets has a pending source (without confirmation)', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      additionalAssets: [
        { kind: 'nft', tokenId: 'GOOD-NFT' },
        { kind: 'nft', tokenId: 'PENDING-NFT' },
      ],
    };
    expectCode(
      () =>
        validateTargets(req, [
          nftToken('GOOD-NFT'),
          nftToken('PENDING-NFT', { pending: true }),
        ]),
      'NFT_PENDING_REQUIRES_CONFIRMATION',
    );
  });

  it('PERMITS multiple NFTs (some pending) when confirmNftPending: true', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      confirmNftPending: true,
      additionalAssets: [
        { kind: 'nft', tokenId: 'GOOD-NFT' },
        { kind: 'nft', tokenId: 'PENDING-NFT' },
      ],
    };
    const out = validateTargets(req, [
      nftToken('GOOD-NFT'),
      nftToken('PENDING-NFT', { pending: true }),
    ]);
    expect(out.nftTargets).toHaveLength(2);
  });

  it('confirmNftPending does NOT gate coin-only sends (irrelevant for coin class)', () => {
    // A pending coin source should NOT trigger the W11 rejection.
    // Coin cascades are recoverable per §4.1 step 2 prose.
    const req: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '30',
    };
    const out = validateTargets(req, [
      coinToken('A', [['UCT', 100n]], { pending: true }),
    ]);
    expect(out.coinTargets).toEqual([{ kind: 'coin', coinId: 'UCT', amount: '30' }]);
  });

  it('mixed coin + pending-NFT requires confirmNftPending only for the NFT half', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '30',
      additionalAssets: [{ kind: 'nft', tokenId: 'PENDING-NFT' }],
    };
    // Without confirmation → reject.
    expectCode(
      () =>
        validateTargets(req, [
          coinToken('A', [['UCT', 100n]]),
          nftToken('PENDING-NFT', { pending: true }),
        ]),
      'NFT_PENDING_REQUIRES_CONFIRMATION',
    );
    // With confirmation → accept.
    const reqOk: TransferRequest = { ...req, confirmNftPending: true };
    const out = validateTargets(reqOk, [
      coinToken('A', [['UCT', 100n]]),
      nftToken('PENDING-NFT', { pending: true }),
    ]);
    expect(out.coinTargets).toHaveLength(1);
    expect(out.nftTargets).toHaveLength(1);
  });
});
