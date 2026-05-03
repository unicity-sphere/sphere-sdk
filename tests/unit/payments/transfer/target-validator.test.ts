/**
 * Tests for `modules/payments/transfer/target-validator.ts` —
 * the multi-asset target validator (T.2.B).
 *
 * Spec references: §4.1 step 1 + 2, §11.2 validation rejection cases.
 *
 * These tests cover every error code path on the public surface:
 *  - `EMPTY_TRANSFER`                       (also exhaustively in §4.1-empty-transfer.test.ts)
 *  - `INVALID_REQUEST`                      — duplicate coin / NFT / partial primary slot
 *  - `INVALID_AMOUNT`                       — zero / negative / non-numeric / fractional
 *  - `UNKNOWN_ASSET_KIND`                   — forward-compat reject
 *  - `INSUFFICIENT_BALANCE`                 — coin coverage shortfall
 *  - `INSUFFICIENT_BALANCE` reason='nft-not-owned'
 *                                           — NFT not in pool
 *                                           — NFT not bound to sender
 *                                           — NFT target source is a coin token (class mismatch)
 *  - `NFT_PENDING_REQUIRES_CONFIRMATION`    (also in §4.1-step2-confirmNftPending.test.ts)
 *
 * The 14 §11.2 validation cases are mapped to specific `it(...)` names
 * in this file (see comment headers). Positive cases (multi-coin send,
 * mixed coin+NFT, NFT-only) round out the coverage.
 */

import { describe, expect, it } from 'vitest';

import { validateTargets } from '../../../../modules/payments/transfer/target-validator';
import type { TokenLike } from '../../../../modules/payments/transfer/classify-token';
import {
  classifyToken,
  normalizeCoinData,
} from '../../../../modules/payments/transfer/classify-token';
import { isSphereError } from '../../../../core/errors';
import type { TransferRequest } from '../../../../types';

// =============================================================================
// Test fixture helpers — small builder functions for readability.
// =============================================================================

function coinToken(
  id: string,
  entries: ReadonlyArray<readonly [string, bigint]>,
  opts: { pending?: boolean; ownedBySender?: boolean } = {},
): TokenLike {
  return {
    id,
    coins: entries.map(([coinId, amount]) => ({ coinId, amount })),
    ...(opts.pending !== undefined ? { pending: opts.pending } : {}),
    ...(opts.ownedBySender !== undefined
      ? { ownedBySender: opts.ownedBySender }
      : {}),
  };
}

function nftToken(
  id: string,
  opts: { pending?: boolean; ownedBySender?: boolean } = {},
): TokenLike {
  return {
    id,
    coins: null,
    ...(opts.pending !== undefined ? { pending: opts.pending } : {}),
    ...(opts.ownedBySender !== undefined
      ? { ownedBySender: opts.ownedBySender }
      : {}),
  };
}

function expectSphereCode(fn: () => unknown, code: string): Error {
  try {
    fn();
  } catch (err) {
    if (!isSphereError(err)) {
      throw new Error(
        `expected SphereError; got ${err instanceof Error ? err.constructor.name : typeof err}: ${String(err)}`,
      );
    }
    expect(err.code).toBe(code);
    return err;
  }
  throw new Error(`expected fn to throw SphereError(${code}); but it returned`);
}

// =============================================================================
// Module sanity — classifyToken + normalizeCoinData primitives.
// =============================================================================

describe('classifyToken — single source of truth (C11)', () => {
  it('returns "nft" for null coinData', () => {
    expect(classifyToken({ id: 'T', coins: null })).toBe('nft');
  });

  it('returns "nft" for empty coinData array', () => {
    expect(classifyToken({ id: 'T', coins: [] })).toBe('nft');
  });

  it('returns "coin" for non-empty coinData', () => {
    expect(
      classifyToken({ id: 'T', coins: [{ coinId: 'UCT', amount: 1n }] }),
    ).toBe('coin');
  });

  it('returns "coin" even for amount-1 entry (NFT-as-balance-of-1 pattern is a coin per §4.1)', () => {
    expect(
      classifyToken({ id: 'T', coins: [{ coinId: 'NFT-id', amount: 1n }] }),
    ).toBe('coin');
  });
});

describe('normalizeCoinData — prune zero-amount entries (§4.1 ingest rule)', () => {
  it('passes through null coinData', () => {
    const t: TokenLike = { id: 'T', coins: null };
    expect(normalizeCoinData(t)).toBe(t);
  });

  it('passes through positive-only coinData (no allocation)', () => {
    const t: TokenLike = {
      id: 'T',
      coins: [{ coinId: 'UCT', amount: 100n }],
    };
    expect(normalizeCoinData(t)).toBe(t);
  });

  it('drops zero-amount entries; keeps positive entries', () => {
    const t: TokenLike = {
      id: 'T',
      coins: [
        { coinId: 'UCT', amount: 0n },
        { coinId: 'USDU', amount: 50n },
      ],
    };
    const out = normalizeCoinData(t);
    expect(out.coins).toEqual([{ coinId: 'USDU', amount: 50n }]);
  });

  it('reduces all-zero coinData to null (NFT classification preserved)', () => {
    const t: TokenLike = {
      id: 'T',
      coins: [{ coinId: 'UCT', amount: 0n }],
    };
    const out = normalizeCoinData(t);
    expect(out.coins).toBe(null);
    expect(classifyToken(out)).toBe('nft');
  });

  it('does not mutate the input', () => {
    const original: TokenLike = {
      id: 'T',
      coins: [
        { coinId: 'UCT', amount: 0n },
        { coinId: 'USDU', amount: 50n },
      ],
    };
    const snapshot = JSON.parse(
      JSON.stringify(original, (_k, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      ),
    );
    normalizeCoinData(original);
    const after = JSON.parse(
      JSON.stringify(original, (_k, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      ),
    );
    expect(after).toEqual(snapshot);
  });
});

// =============================================================================
// §11.2 case 9 — empty transfer (W22 / EMPTY_TRANSFER).
// =============================================================================

describe('validateTargets — empty transfer rejection (§11.2 case 9 / W22)', () => {
  it('rejects request with no primary AND no additionalAssets → EMPTY_TRANSFER', () => {
    const req: TransferRequest = { recipient: '@bob' };
    expectSphereCode(() => validateTargets(req, []), 'EMPTY_TRANSFER');
  });

  it('rejects request with empty additionalAssets and no primary → EMPTY_TRANSFER', () => {
    const req: TransferRequest = { recipient: '@bob', additionalAssets: [] };
    expectSphereCode(() => validateTargets(req, []), 'EMPTY_TRANSFER');
  });
});

// =============================================================================
// §11.2 case 1 — duplicate coinId across primary + additionalAssets.
// =============================================================================

describe('validateTargets — duplicate coinId rejection (§11.2 case 1)', () => {
  it('rejects duplicate coinId in additionalAssets vs primary → INVALID_REQUEST', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '30',
      additionalAssets: [{ kind: 'coin', coinId: 'UCT', amount: '10' }],
    };
    const sources = [coinToken('A', [['UCT', 100n]])];
    expectSphereCode(() => validateTargets(req, sources), 'INVALID_REQUEST');
  });

  it('rejects duplicate coinId across two additionalAssets entries (no primary) → INVALID_REQUEST', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      additionalAssets: [
        { kind: 'coin', coinId: 'UCT', amount: '10' },
        { kind: 'coin', coinId: 'UCT', amount: '20' },
      ],
    };
    expectSphereCode(
      () => validateTargets(req, [coinToken('A', [['UCT', 100n]])]),
      'INVALID_REQUEST',
    );
  });
});

// =============================================================================
// §11.2 case 2 — duplicate NFT tokenId.
// =============================================================================

describe('validateTargets — duplicate NFT tokenId rejection (§11.2 case 2)', () => {
  it('rejects duplicate NFT tokenId in additionalAssets → INVALID_REQUEST', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '1',
      additionalAssets: [
        { kind: 'nft', tokenId: '0xabc' },
        { kind: 'nft', tokenId: '0xabc' },
      ],
    };
    const sources = [
      coinToken('A', [['UCT', 100n]]),
      nftToken('0xabc'),
    ];
    expectSphereCode(() => validateTargets(req, sources), 'INVALID_REQUEST');
  });
});

// =============================================================================
// §11.2 case 3 — coin amount '0' / non-positive.
// =============================================================================

describe('validateTargets — non-positive amount rejection (§11.2 case 3)', () => {
  it('rejects additionalAssets coin entry with amount "0" → INVALID_AMOUNT', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '30',
      additionalAssets: [{ kind: 'coin', coinId: 'USDU', amount: '0' }],
    };
    const sources = [
      coinToken('A', [
        ['UCT', 100n],
        ['USDU', 100n],
      ]),
    ];
    expectSphereCode(() => validateTargets(req, sources), 'INVALID_AMOUNT');
  });

  it('rejects primary slot with amount "0" → INVALID_AMOUNT', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '0',
    };
    expectSphereCode(
      () => validateTargets(req, [coinToken('A', [['UCT', 100n]])]),
      'INVALID_AMOUNT',
    );
  });

  it('rejects negative amount → INVALID_AMOUNT', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '-5',
    };
    expectSphereCode(
      () => validateTargets(req, [coinToken('A', [['UCT', 100n]])]),
      'INVALID_AMOUNT',
    );
  });

  it('rejects fractional amount → INVALID_AMOUNT', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '1.5',
    };
    expectSphereCode(
      () => validateTargets(req, [coinToken('A', [['UCT', 100n]])]),
      'INVALID_AMOUNT',
    );
  });

  it('rejects non-numeric amount → INVALID_AMOUNT', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: 'abc',
    };
    expectSphereCode(
      () => validateTargets(req, [coinToken('A', [['UCT', 100n]])]),
      'INVALID_AMOUNT',
    );
  });

  it('rejects empty-string amount → INVALID_AMOUNT (paired with coinId set)', () => {
    // partial primary slot: coinId set, amount === '' → INVALID_REQUEST
    // because primary extraction sees that as "amount unset". That's
    // an INVALID_REQUEST, not INVALID_AMOUNT. Tested in the partial-primary case.
    const req: TransferRequest = {
      recipient: '@bob',
      additionalAssets: [{ kind: 'coin', coinId: 'UCT', amount: '' }],
    };
    expectSphereCode(
      () => validateTargets(req, [coinToken('A', [['UCT', 100n]])]),
      'INVALID_AMOUNT',
    );
  });
});

// =============================================================================
// §11.2 case 4 — unrecognized `kind`.
// =============================================================================

describe('validateTargets — UNKNOWN_ASSET_KIND (§11.2 case 4 / forward-compat)', () => {
  it('rejects additionalAssets entry with future kind "voucher" → UNKNOWN_ASSET_KIND', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '30',
      // Use `as` to simulate a future protocol version. The test
      // verifies the receiver-side reject rule per §10.4.
      additionalAssets: [
        { kind: 'voucher', tokenId: '0xv0' } as unknown as TransferRequest['additionalAssets'] extends ReadonlyArray<infer A> ? A : never,
      ],
    };
    expectSphereCode(
      () => validateTargets(req, [coinToken('A', [['UCT', 100n]])]),
      'UNKNOWN_ASSET_KIND',
    );
  });

  it('rejects additionalAssets entry with empty kind → UNKNOWN_ASSET_KIND', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '30',
      additionalAssets: [
        { kind: '', tokenId: '0xv0' } as unknown as TransferRequest['additionalAssets'] extends ReadonlyArray<infer A> ? A : never,
      ],
    };
    expectSphereCode(
      () => validateTargets(req, [coinToken('A', [['UCT', 100n]])]),
      'UNKNOWN_ASSET_KIND',
    );
  });
});

// =============================================================================
// §11.2 case 5 — INSUFFICIENT_BALANCE for coin coverage shortfall.
// =============================================================================

describe('validateTargets — INSUFFICIENT_BALANCE coin coverage (§11.2 case 5)', () => {
  it('rejects when sender lacks enough coin balance → INSUFFICIENT_BALANCE', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '1000',
    };
    const sources = [coinToken('A', [['UCT', 100n]])];
    expectSphereCode(
      () => validateTargets(req, sources),
      'INSUFFICIENT_BALANCE',
    );
  });

  it('aggregates balance across multiple coin sources before deciding', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '150',
    };
    const sources = [
      coinToken('A', [['UCT', 100n]]),
      coinToken('B', [['UCT', 60n]]),
    ];
    expect(() => validateTargets(req, sources)).not.toThrow();
  });
});

// =============================================================================
// §11.2 cases 6, 7, 8 — NFT not owned (three sub-cases).
// =============================================================================

describe('validateTargets — INSUFFICIENT_BALANCE reason="nft-not-owned"', () => {
  // §11.2 case 6 — NFT not in sender's pool.
  it('rejects when NFT tokenId is absent from sender pool (§11.2 case 6)', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '1',
      additionalAssets: [{ kind: 'nft', tokenId: '0xMISSING' }],
    };
    const sources = [coinToken('A', [['UCT', 100n]])];
    const err = expectSphereCode(
      () => validateTargets(req, sources),
      'INSUFFICIENT_BALANCE',
    );
    // Verify the structured cause carries the spec's reason marker.
    const cause = (err as Error & { cause?: { reason?: string } }).cause;
    expect(cause?.reason).toBe('nft-not-owned');
  });

  // §11.2 case 7 — NFT exists but predicate doesn't bind to sender.
  it('rejects when NFT exists but ownedBySender=false (§11.2 case 7)', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '1',
      additionalAssets: [{ kind: 'nft', tokenId: '0xabc' }],
    };
    const sources = [
      coinToken('A', [['UCT', 100n]]),
      nftToken('0xabc', { ownedBySender: false }),
    ];
    const err = expectSphereCode(
      () => validateTargets(req, sources),
      'INSUFFICIENT_BALANCE',
    );
    const cause = (err as Error & { cause?: { reason?: string; cause?: string } })
      .cause;
    expect(cause?.reason).toBe('nft-not-owned');
  });

  // Wave 3 steelman fix #170 issue 4 — the 'not-bound' disambiguation
  // branch in `findNftSource` was dead code before the fix because
  // `partitionSources` dropped tokens with `ownedBySender === false`
  // BEFORE the candidate walk. Passing the unfiltered availableSources
  // list to `findNftSource` lets the branch fire — users who attempt
  // to send a token they own a different copy of now see the correct
  // `cause: 'not-bound'` disambiguator instead of `'not-found'`.
  it('surfaces cause="not-bound" disambiguator when NFT exists with ownedBySender=false (#170 issue 4)', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '1',
      additionalAssets: [{ kind: 'nft', tokenId: '0xabc' }],
    };
    // The token exists in the pool but the current-state predicate
    // does NOT bind to sender (ownedBySender=false).
    const sources = [
      coinToken('A', [['UCT', 100n]]),
      nftToken('0xabc', { ownedBySender: false }),
    ];
    const err = expectSphereCode(
      () => validateTargets(req, sources),
      'INSUFFICIENT_BALANCE',
    );
    const cause = (err as Error & {
      cause?: { reason?: string; cause?: string };
    }).cause;
    expect(cause?.reason).toBe('nft-not-owned');
    // Post-fix: the disambiguator MUST be 'not-bound' (not 'not-found')
    // — the token is in the pool, just not bound to sender.
    expect(cause?.cause).toBe('not-bound');
  });

  it('still surfaces cause="not-found" when NFT really is absent (#170 issue 4 — regression)', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '1',
      additionalAssets: [{ kind: 'nft', tokenId: '0xMISSING' }],
    };
    const sources = [coinToken('A', [['UCT', 100n]])];
    const err = expectSphereCode(
      () => validateTargets(req, sources),
      'INSUFFICIENT_BALANCE',
    );
    const cause = (err as Error & {
      cause?: { reason?: string; cause?: string };
    }).cause;
    expect(cause?.reason).toBe('nft-not-owned');
    expect(cause?.cause).toBe('not-found');
  });

  // §11.2 case 8 — NFT target's source is a coin token.
  it('rejects when matching tokenId is a coin token, not NFT (§11.2 case 8 — class disjointness)', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '1',
      additionalAssets: [{ kind: 'nft', tokenId: 'A' }],
    };
    // Token `A` has non-empty coinData → coin class. The validator
    // must reject regardless of tokenId match.
    const sources = [coinToken('A', [['UCT', 100n]])];
    const err = expectSphereCode(
      () => validateTargets(req, sources),
      'INSUFFICIENT_BALANCE',
    );
    const cause = (err as Error & { cause?: { reason?: string } }).cause;
    expect(cause?.reason).toBe('nft-not-owned');
  });
});

// =============================================================================
// §11.2 case 10 — pending NFT without confirmation (W11).
// (Detailed test in §4.1-step2-confirmNftPending.test.ts; this is the
//  shape-level smoke test.)
// =============================================================================

describe('validateTargets — NFT_PENDING_REQUIRES_CONFIRMATION (§11.2 case 10 / W11)', () => {
  it('rejects pending NFT source when confirmNftPending is undefined → NFT_PENDING_REQUIRES_CONFIRMATION', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      additionalAssets: [{ kind: 'nft', tokenId: '0xabc' }],
    };
    const sources = [nftToken('0xabc', { pending: true })];
    expectSphereCode(
      () => validateTargets(req, sources),
      'NFT_PENDING_REQUIRES_CONFIRMATION',
    );
  });
});

// =============================================================================
// Partial primary slot — INVALID_REQUEST (additional structural guard).
// =============================================================================

describe('validateTargets — partial primary slot rejection', () => {
  it('rejects when only coinId is set (amount missing) → INVALID_REQUEST', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      // amount omitted
    };
    expectSphereCode(() => validateTargets(req, []), 'INVALID_REQUEST');
  });

  it('rejects when only amount is set (coinId missing) → INVALID_REQUEST', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      amount: '30',
    };
    expectSphereCode(() => validateTargets(req, []), 'INVALID_REQUEST');
  });
});

// =============================================================================
// §11.2 — Positive cases (multi-coin, mixed, NFT-only).
// =============================================================================

describe('validateTargets — multi-asset positive cases (§11.2)', () => {
  // §11.2 — Multi-coin send (additionalAssets, all coin entries).
  it('multi-coin send (single source covers all coins) — returns canonical targetList', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '30',
      additionalAssets: [
        { kind: 'coin', coinId: 'USDU', amount: '20' },
      ],
    };
    const sources = [
      coinToken('A', [
        ['UCT', 100n],
        ['USDU', 50n],
        ['ALPHA', 1000n],
      ]),
    ];
    const out = validateTargets(req, sources);
    expect(out.targetList).toEqual([
      { kind: 'coin', coinId: 'UCT', amount: '30' },
      { kind: 'coin', coinId: 'USDU', amount: '20' },
    ]);
    expect(out.coinTargets).toHaveLength(2);
    expect(out.nftTargets).toHaveLength(0);
  });

  it('multi-coin send (multiple sources) — coverage aggregates across pool', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '30',
      additionalAssets: [{ kind: 'coin', coinId: 'USDU', amount: '20' }],
    };
    const sources = [
      coinToken('A', [['UCT', 100n]]),
      coinToken('B', [['USDU', 50n]]),
    ];
    const out = validateTargets(req, sources);
    expect(out.coinTargets).toHaveLength(2);
  });

  // §11.2 — NFT-only send.
  it('NFT-only send (omit primary; additionalAssets has only nft entries)', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      additionalAssets: [{ kind: 'nft', tokenId: '0xabc' }],
    };
    const sources = [nftToken('0xabc')];
    const out = validateTargets(req, sources);
    expect(out.targetList).toEqual([{ kind: 'nft', tokenId: '0xabc' }]);
    expect(out.nftTargets).toHaveLength(1);
    expect(out.coinTargets).toHaveLength(0);
  });

  it('NFT-only send with multiple distinct NFT targets', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      additionalAssets: [
        { kind: 'nft', tokenId: 'T1' },
        { kind: 'nft', tokenId: 'T2' },
      ],
    };
    const sources = [nftToken('T1'), nftToken('T2')];
    const out = validateTargets(req, sources);
    expect(out.nftTargets).toHaveLength(2);
  });

  // §11.2 — Mixed coin + NFT send.
  it('mixed coin + NFT send (separate sources only) — both targets in canonical list', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '30',
      additionalAssets: [{ kind: 'nft', tokenId: 'NFT-id' }],
    };
    const sources = [
      coinToken('A', [['UCT', 100n]]),
      nftToken('NFT-id'),
    ];
    const out = validateTargets(req, sources);
    expect(out.targetList).toEqual([
      { kind: 'coin', coinId: 'UCT', amount: '30' },
      { kind: 'nft', tokenId: 'NFT-id' },
    ]);
    expect(out.coinTargets).toHaveLength(1);
    expect(out.nftTargets).toHaveLength(1);
  });

  it('single-coin (legacy) send — primary only, no additionalAssets, equivalent to v1', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '30',
    };
    const sources = [coinToken('A', [['UCT', 100n]])];
    const out = validateTargets(req, sources);
    expect(out.targetList).toEqual([
      { kind: 'coin', coinId: 'UCT', amount: '30' },
    ]);
  });

  it('single-coin send with empty additionalAssets array — semantically identical to undefined', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '30',
      additionalAssets: [],
    };
    const sources = [coinToken('A', [['UCT', 100n]])];
    const out = validateTargets(req, sources);
    expect(out.targetList).toEqual([
      { kind: 'coin', coinId: 'UCT', amount: '30' },
    ]);
  });
});

// =============================================================================
// Purity — ensure no input mutation.
// =============================================================================

describe('validateTargets — purity invariant', () => {
  it('does not mutate the request', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '30',
      additionalAssets: [{ kind: 'coin', coinId: 'USDU', amount: '20' }],
    };
    const before = JSON.stringify(req);
    validateTargets(req, [
      coinToken('A', [
        ['UCT', 100n],
        ['USDU', 50n],
      ]),
    ]);
    expect(JSON.stringify(req)).toBe(before);
  });

  it('does not mutate the sources array or its elements', () => {
    const sources = [
      coinToken('A', [
        ['UCT', 100n],
        ['UCT2', 0n],
      ]),
    ];
    const snapshot = sources.map((s) =>
      JSON.parse(
        JSON.stringify(s, (_k, v) =>
          typeof v === 'bigint' ? v.toString() : v,
        ),
      ),
    );
    const req: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '30',
    };
    validateTargets(req, sources);
    const after = sources.map((s) =>
      JSON.parse(
        JSON.stringify(s, (_k, v) =>
          typeof v === 'bigint' ? v.toString() : v,
        ),
      ),
    );
    expect(after).toEqual(snapshot);
  });

  it('returns a frozen result', () => {
    const req: TransferRequest = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '30',
    };
    const out = validateTargets(req, [coinToken('A', [['UCT', 100n]])]);
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out.targetList)).toBe(true);
    expect(Object.isFrozen(out.coinTargets)).toBe(true);
    expect(Object.isFrozen(out.nftTargets)).toBe(true);
  });
});
