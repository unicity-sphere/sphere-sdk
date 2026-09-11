/**
 * #777: the BLOB is the authority on what a source carries.
 *
 * `spendableCoinless` reads the MIRROR, which is the server's index. If the two
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
import { materializeCoinlessSpend } from '../../../modules/payments-v2/send-coinless';

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
};

describe('materializeCoinlessSpend', () => {
  it('REFUSES a source whose blob carries coin value, even when the mirror called it coinless', async () => {
    const deps = { engine: engineWith({ assets: [{ coinId: 'bb'.repeat(32), amount: 5n }] }), storagePort };
    await expect(materializeCoinlessSpend(deps, input)).rejects.toThrow(/carries coin value/);
  });

  it('names send() in the refusal, so the caller knows which verb moves it', async () => {
    const deps = { engine: engineWith({ assets: [{ coinId: 'bb'.repeat(32), amount: 5n }] }), storagePort };
    const err = await materializeCoinlessSpend(deps, input).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SphereError);
    expect((err as SphereError).message).toMatch(/use send\(\)/);
  });

  it('plans exactly ONE direct op for a genuinely coinless source — never a split', async () => {
    const deps = { engine: engineWith(null), storagePort };
    const ctx = await materializeCoinlessSpend(deps, input);
    expect(ctx.plan.ops).toHaveLength(1);
    expect(ctx.plan.ops[0]?.kind).toBe('direct');
    expect(ctx.plan.payload.kind).toBe('coinless');
    expect(ctx.plan.payload.direct).toEqual([TOKEN_ID]);
  });

  it('reports no coin and no in-flight coin rows: a coinless spend has no amount to show', async () => {
    const deps = { engine: engineWith(null), storagePort };
    const ctx = await materializeCoinlessSpend(deps, input);
    expect(ctx.coinId).toBe('');
    expect(ctx.sourceTokens).toEqual([]);
  });

  it('refuses when the blob is missing rather than planning a spend of nothing', async () => {
    const deps = { engine: engineWith(null), storagePort: { getBlobs: vi.fn(async () => new Map()) } };
    await expect(materializeCoinlessSpend(deps, input)).rejects.toThrow(/no blob in storage/);
  });
});

describe('materializeCoinlessSpend — an unreadable envelope is not coinless', () => {
  it('REFUSES a bare_collection source: null value, but REAL coins this SDK cannot decode', async () => {
    // The bridged dialect decodes to `value: null` exactly like a coinless token.
    // Checking the value rather than the ENVELOPE would move a valued token and
    // record `assets: []` for it — coins gone, nothing accounted.
    const deps = { engine: engineWith(null, 'bare_collection'), storagePort };
    await expect(materializeCoinlessSpend(deps, input)).rejects.toThrow(/carries coin value/);
  });

  it.each(['none_absent', 'none_tag', 'none_other'] as const)(
    'still allows a genuinely coinless %s envelope',
    async (envelope) => {
      const deps = { engine: engineWith(null, envelope), storagePort };
      await expect(materializeCoinlessSpend(deps, input)).resolves.toBeDefined();
    }
  );
});
