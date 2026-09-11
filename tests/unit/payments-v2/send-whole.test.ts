/**
 * #777: the BLOB is the authority on what a source carries.
 *
 * `spendableToken` reads the MIRROR, which is the server's index. If the two
 * ever disagree — a stale row, a backend that indexed a payload it could not read,
 * a reclassification — the mirror saying "coinless" while the blob carries coins is
 * exactly the case where a valued token would move with its coins unaccounted for.
 * The facade-level tests are killed by the mirror gate first, so this exercises the
 * re-check directly.
 */

import { describe, expect, it, vi } from 'vitest';

import { SphereError } from '../../../core/errors';
import type { ITokenEngine } from '../../../token-engine/engine';
import type { SphereToken } from '../../../token-engine/types';
import { materializeWholeSpend } from '../../../modules/payments-v2/send-whole';

const TOKEN_ID = 'aa'.repeat(32);
const RECIPIENT = '02'.repeat(16) + '03';

function engineWith(
  value: SphereToken['value'],
  valueEnvelope: SphereToken['valueEnvelope'] = value === null ? 'none_other' : 'sphere'
): ITokenEngine {
  return {
    decodeToken: vi.fn(
      async () => ({ value, valueEnvelope, blob: { tokenId: TOKEN_ID } }) as unknown as SphereToken
    ),
    deliveryKeys: vi.fn(async () => ({ tokenId: TOKEN_ID, stateHash: 'S1' })),
  } as unknown as ITokenEngine;
}

const storagePort = {
  getBlobs: vi.fn(async () => new Map([[TOKEN_ID, new Uint8Array([1, 2, 3])]])),
};

const input = {
  transferId: 'a1111111-1111-4111-8111-111111111111',
  recipientPubkey: RECIPIENT,
  request: { recipient: '@peer', tokenId: TOKEN_ID },
  sourceIds: [TOKEN_ID],
  requireCoinless: false,
};

describe('materializeWholeSpend', () => {
  it('MOVES a valued token whole — coins travel with it, no split', async () => {
    const deps = { engine: engineWith({ assets: [{ coinId: 'bb'.repeat(32), amount: 5n }] }), storagePort };
    const ctx = await materializeWholeSpend(deps, input);
    expect(ctx.plan.ops).toHaveLength(1);
    expect(ctx.plan.ops[0]?.kind).toBe('direct');
  });

  it('plans exactly ONE direct op for a genuinely coinless source — never a split', async () => {
    const deps = { engine: engineWith(null), storagePort };
    const ctx = await materializeWholeSpend(deps, input);
    expect(ctx.plan.ops).toHaveLength(1);
    expect(ctx.plan.ops[0]?.kind).toBe('direct');
    expect(ctx.plan.payload.kind).toBe('whole');
    expect(ctx.plan.payload.direct).toEqual([TOKEN_ID]);
  });

  it('reports no coin and no in-flight coin rows: a coinless spend has no amount to show', async () => {
    const deps = { engine: engineWith(null), storagePort };
    const ctx = await materializeWholeSpend(deps, input);
    expect(ctx.coinId).toBe('');
    expect(ctx.sourceTokens).toEqual([]);
  });

  it('refuses when the blob is missing rather than planning a spend of nothing', async () => {
    const deps = { engine: engineWith(null), storagePort: { getBlobs: vi.fn(async () => new Map()) } };
    await expect(materializeWholeSpend(deps, input)).rejects.toThrow(/no blob in storage/);
  });
});

describe('materializeWholeSpend — the one envelope it refuses', () => {
  it('REFUSES a bare_collection source: its coins are real but UNACCOUNTABLE here', async () => {
    // A whole spend moves the token as-is, so a valued source is fine. This one is
    // not: the coins are real but this SDK cannot decode them, so the move would
    // happen while the history row could only say `assets: []` — value gone,
    // nothing accounted. The BLOB decides, never the mirror.
    const deps = { engine: engineWith(null, 'bare_collection'), storagePort };
    await expect(materializeWholeSpend(deps, input)).rejects.toThrow(/cannot be accounted for/);
  });

  it.each(['none_absent', 'none_tag', 'none_other', 'sphere'] as const)(
    'allows a %s envelope — coinless or valued, both move whole',
    async (envelope) => {
      const value = envelope === 'sphere' ? { assets: [{ coinId: 'bb'.repeat(32), amount: 1n }] } : null;
      const deps = { engine: engineWith(value, envelope), storagePort };
      await expect(materializeWholeSpend(deps, input)).resolves.toBeDefined();
    }
  );
});

describe('the NFT-scoped entry point keeps its permission boundary (#783 review)', () => {
  it('REFUSES a valued token when requireCoinless is set', async () => {
    // Connect's `send_nft` carries `nft:transfer`, which deliberately does NOT
    // authorise coin transfers. Routing it at the general verb would let a dApp
    // holding only that scope move a valued token's coins.
    const deps = { engine: engineWith({ assets: [{ coinId: 'bb'.repeat(32), amount: 5n }] }), storagePort };
    await expect(
      materializeWholeSpend(deps, { ...input, requireCoinless: true })
    ).rejects.toThrow(/cannot be sent with sendCoinless/);
  });

  it('still allows a coinless token through the NFT-scoped path', async () => {
    const deps = { engine: engineWith(null, 'none_other'), storagePort };
    await expect(
      materializeWholeSpend(deps, { ...input, requireCoinless: true })
    ).resolves.toBeDefined();
  });
});
