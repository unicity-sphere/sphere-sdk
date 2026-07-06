/**
 * §4.1 step 1 — empty-transfer rejection (T.2.B / W22).
 *
 * Mirrors §4.1 step 1's "If `targetList.length === 0` → `EMPTY_TRANSFER`
 * rejection" + the §11.2 case "Empty transfer (no primary AND
 * empty/missing additionalAssets) → EMPTY_TRANSFER".
 *
 * Tests in this file:
 *  - `payments.send({})` shape (only `recipient`) → EMPTY_TRANSFER.
 *  - `additionalAssets: []` with no primary → EMPTY_TRANSFER (§4.1
 *     "additionalAssets === undefined and === [] are semantically identical").
 *  - `additionalAssets: undefined` with no primary → EMPTY_TRANSFER.
 *  - POSITIVE: primary alone (no additionalAssets) → NOT empty.
 *  - POSITIVE: primary + additionalAssets: [] → NOT empty.
 *  - POSITIVE: additionalAssets: [{kind: 'nft', ...}] alone (no primary) → NOT empty.
 */

import { describe, expect, it } from 'vitest';

import { validateTargets } from '../../../../extensions/uxf/pipeline/target-validator';
import type { TokenLike } from '../../../../extensions/uxf/pipeline/classify-token';
import { isSphereError } from '../../../../core/errors';
import type { TransferRequest } from '../../../../types';

function coinToken(
  id: string,
  entries: ReadonlyArray<readonly [string, bigint]>,
): TokenLike {
  return {
    id,
    coins: entries.map(([coinId, amount]) => ({ coinId, amount })),
  };
}

function nftToken(id: string): TokenLike {
  return { id, coins: null };
}

function expectEmpty(req: TransferRequest, sources: ReadonlyArray<TokenLike>): void {
  try {
    validateTargets(req, sources);
  } catch (err) {
    if (!isSphereError(err)) {
      throw new Error(
        `expected SphereError; got ${err instanceof Error ? err.constructor.name : typeof err}: ${String(err)}`,
      );
    }
    expect(err.code).toBe('EMPTY_TRANSFER');
    return;
  }
  throw new Error(`expected validateTargets to throw EMPTY_TRANSFER`);
}

// =============================================================================
// W22 — EMPTY_TRANSFER negative cases.
// =============================================================================

describe('§4.1 step 1 — EMPTY_TRANSFER (W22)', () => {
  it('rejects request with only `recipient` (payments.send({}) shape)', () => {
    const req = { recipient: '@bob' } as TransferRequest;
    expectEmpty(req, []);
  });

  it('rejects request with empty additionalAssets and no primary slot', () => {
    const req: TransferRequest = { recipient: '@bob', additionalAssets: [] };
    expectEmpty(req, []);
  });

  it('rejects request with explicit `additionalAssets: undefined`', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      additionalAssets: undefined,
    };
    expectEmpty(req, []);
  });

  it('rejects request with memo / transferMode set but no targets', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      memo: 'note',
      transferMode: 'conservative',
    };
    expectEmpty(req, []);
  });

  it('rejects empty request even when source pool is non-empty', () => {
    const req: TransferRequest = { recipient: '@bob', additionalAssets: [] };
    // Sources are irrelevant — the request itself has nothing to send.
    expectEmpty(req, [coinToken('A', [['UCT', 100n]]), nftToken('NFT-id')]);
  });
});

// =============================================================================
// W22 — POSITIVE cases proving empty-additionalAssets is not "empty transfer".
// =============================================================================

describe('§4.1 step 1 — non-empty positive cases', () => {
  it('primary alone (no additionalAssets) is NOT empty', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '30',
    };
    const sources = [coinToken('A', [['UCT', 100n]])];
    const out = validateTargets(req, sources);
    expect(out.targetList).toHaveLength(1);
  });

  it('primary + empty additionalAssets array is NOT empty (only the primary counts)', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '30',
      additionalAssets: [],
    };
    const sources = [coinToken('A', [['UCT', 100n]])];
    const out = validateTargets(req, sources);
    expect(out.targetList).toHaveLength(1);
  });

  it('additionalAssets with one nft entry (NO primary) is NOT empty', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      additionalAssets: [{ kind: 'nft', tokenId: 'T1' }],
    };
    const sources = [nftToken('T1')];
    const out = validateTargets(req, sources);
    expect(out.targetList).toHaveLength(1);
  });

  it('additionalAssets with one coin entry (NO primary) is NOT empty', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      additionalAssets: [{ kind: 'coin', coinId: 'UCT', amount: '30' }],
    };
    const sources = [coinToken('A', [['UCT', 100n]])];
    const out = validateTargets(req, sources);
    expect(out.targetList).toHaveLength(1);
  });
});
