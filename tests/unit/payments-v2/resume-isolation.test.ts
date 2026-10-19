/**
 * #840: resume plans each intent inside that intent's own failure boundary. Validation
 * already refuses every payload JSON can express that buildOps cannot plan, so this file
 * makes buildOps itself fail — the next field it parses, before validation learns of it.
 * The mock applies only while resume.ts imports buildOps from './TransferMachine'.
 */

import { describe, expect, it, vi } from 'vitest';

import { resumeAll } from '../../../modules/payments-v2/machine/resume';
import type { IntentPayload } from '../../../modules/payments-v2/machine/types';
import { ProofUnconfirmedError } from '../../../token-engine/errors';
import { COIN, makeWorld } from './machine-harness';

const POISON = '00000000-0000-4000-8000-000000000840';

vi.mock('../../../modules/payments-v2/machine/TransferMachine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../modules/payments-v2/machine/TransferMachine')>();
  return {
    ...actual,
    buildOps: (payload: IntentPayload) => {
      if (payload.memo === POISON) throw new SyntaxError('cannot plan this intent');
      return actual.buildOps(payload);
    },
  };
});

describe('resume plans each intent apart (#840)', () => {
  it('an intent whose ops cannot be planned fails alone: the pass still resumes every other open intent', async () => {
    const w = makeWorld();
    const poisoned = await w.seed(1000n);
    const payload = { v: 2, kind: 'coin', recipient: w.recipientHex, coinId: COIN, amount: '1000', memo: POISON, direct: [poisoned.blob.tokenId] };
    await w.api.putIntent(w.caller, { transferId: POISON, payload: `enc:${JSON.stringify(payload)}`, requiresSeedClose: false });
    // A keep-open send: its leg's proof never confirmed, so its resume reads its source.
    const plan = await w.plan({ tokens: [await w.seed(1000n)], amount: '1000' });
    const unconfirmed = new ProofUnconfirmedError('proof fetch inconclusive');
    w.engine.afterOp = (key) => (key === `${plan.transferId}:0` ? unconfirmed : null);
    await expect(w.machine().run(plan)).rejects.toBe(unconfirmed);
    w.engine.afterOp = null;

    const report = await resumeAll(w.deps);

    expect(report).toEqual({ resumed: [plan.transferId], conflicted: [], failed: [POISON] });
    expect(w.engine.transferCalls.filter((call) => call.key.startsWith(POISON))).toHaveLength(0);
    expect(w.api.inspectIntent(w.caller, POISON)?.status).toBe('open');
  });
});
