/**
 * #839 across the engine/machine boundary: a leg whose proof matched but whose
 * realization failed is certified on chain. TransferMachine.run() must keep the
 * intent open (possibly-committed, no abort) so resume realizes the SAME transferId,
 * never fence it and report a clean failure that releases the source, makes a linked
 * request payable again, or (beside a conflicting leg) re-plans the full amount.
 *
 * The REAL engine over TestAggregatorClient; the wallet-api side is the machine
 * harness's FakeWalletApi. Its fake blob decoder cannot read real SDK bytes, so the
 * resume legs stub delivery, blob upload and the inventory apply (typed ports).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isPossiblyCommittedSendOutcome } from '../../../core/errors';
import { TransferConflictError } from '../../../token-engine/errors';
import { HexConverter, Token } from '../../../token-engine/sdk';
import type { SphereToken } from '../../../token-engine/types';
import type { SphereTokenEngine } from '../../../token-engine/SphereTokenEngine';
import type { DeliveryPort, StoragePort } from '../../../modules/payments-v2/ports';
import type { CoinIntentPayload } from '../../../modules/payments-v2/machine/types';
import {
  TransferMachine,
  buildOps,
  type MachineDeps,
  type MachinePlan,
} from '../../../modules/payments-v2/machine/TransferMachine';
import { createTestEngine, freshPubkey } from '../token-engine/test-engine';
import { sha256Hex } from './fakes/FakeWalletApi';
import { COIN, makeWorld, type World } from './machine-harness';

type Delta = Parameters<StoragePort['applyDelta']>[0];

interface Rig {
  w: World;
  real: SphereTokenEngine;
  deps: MachineDeps;
  recipient: Uint8Array;
  delivered: Uint8Array[];
  uploaded: Uint8Array[];
  deltas: Delta[];
}

/** The machine harness with the real engine, and recording delivery/storage stubs. */
function rig(): Rig {
  const w = makeWorld();
  const real = createTestEngine();
  const delivered: Uint8Array[] = [];
  const uploaded: Uint8Array[] = [];
  const deltas: Delta[] = [];
  const delivery: DeliveryPort = {
    ...w.deps.delivery,
    deliver: async (_recipient, blob) => {
      delivered.push(blob);
      return { deliveryId: sha256Hex(blob) };
    },
    deliverBatch: async (_recipient, blobs) => {
      delivered.push(...blobs);
      return blobs.map((blob) => ({ deliveryId: sha256Hex(blob) }));
    },
  };
  const storage: StoragePort = {
    ...w.deps.storage,
    uploadBlobs: async (blobs) => {
      uploaded.push(...blobs.map((b) => b.bytes));
      return new Map(blobs.map((b) => [b.sha256, `blob:${b.sha256}`]));
    },
    applyDelta: async (delta) => {
      deltas.push(delta);
      return { cursor: 0, syncEpoch: '1' };
    },
  };
  const deps: MachineDeps = { ...w.deps, engine: () => real, ownPubkey: real.getIdentity().chainPubkey, delivery, storage };
  return { w, real, deps, recipient: freshPubkey(), delivered, uploaded, deltas };
}

async function mintOwn(real: SphereTokenEngine, amount: bigint): Promise<SphereToken> {
  return real.mint({ recipientPubkey: real.getIdentity().chainPubkey, value: { assets: [{ coinId: COIN, amount }] } });
}

function planOf(
  recipient: Uint8Array,
  amount: string,
  direct: SphereToken[],
  split?: { token: SphereToken; splitAmount: string; remainderAmount: string },
): MachinePlan {
  const recipientHex = HexConverter.encode(recipient);
  const payload: CoinIntentPayload = {
    v: 2,
    kind: 'coin',
    recipient: recipientHex,
    coinId: COIN,
    amount,
    direct: direct.map((t) => t.blob.tokenId),
    ...(split !== undefined
      ? { split: { tokenId: split.token.blob.tokenId, splitAmount: split.splitAmount, remainderAmount: split.remainderAmount } }
      : {}),
    spentStates: {},
  };
  const all = [...direct, ...(split !== undefined ? [split.token] : [])];
  return {
    transferId: crypto.randomUUID(),
    recipientPubkey: recipientHex,
    payload,
    ops: buildOps(payload),
    sources: new Map(all.map((t) => [t.blob.tokenId, t])),
  };
}

/** Token.transfer rejects ONCE, and only for this source: no other leg can consume the fault. */
function failRealizationOnce(source: SphereToken): void {
  const original = Token.prototype.transfer;
  let armed = true;
  vi.spyOn(Token.prototype, 'transfer').mockImplementation(function (this: Token, ...args) {
    if (armed && this === source.sdkToken) {
      armed = false;
      return Promise.reject(new Error('verification context drift'));
    }
    return original.apply(this, args);
  });
}

async function expectOpenAndUnaborted(r: Rig, plan: MachinePlan): Promise<void> {
  expect(r.w.log).not.toContain('abortIntent');
  expect((await r.w.api.listIntents(r.w.caller, 'open')).map((i) => i.transferId)).toEqual([plan.transferId]);
  expect((await r.w.stores().backstop.list()).map((e) => [e.transferId, e.disposition])).toEqual([
    [plan.transferId, 'open'],
  ]);
}

const rejection = (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (err: unknown) => err);

describe('#839 TransferMachine: a post-proof realization failure keeps the intent open', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('(i) one direct leg: possibly-committed, never aborted; resume delivers one blob that verifies', async () => {
    const r = rig();
    const src = await mintOwn(r.real, 10n);
    const plan = planOf(r.recipient, '10', [src]);
    failRealizationOnce(src);

    const err = await rejection(new TransferMachine(r.deps).run(plan));

    expect(isPossiblyCommittedSendOutcome(err)).toBe(true);
    expect(await r.real.isSpent(src)).toBe(true);
    expect(r.delivered).toHaveLength(0);
    await expectOpenAndUnaborted(r, plan);

    vi.restoreAllMocks();
    const outcome = await new TransferMachine(r.deps).resumeIntent({
      transferId: plan.transferId,
      payload: plan.payload,
      sources: new Map([[src.blob.tokenId, src]]),
      journaled: new Map(),
    });
    expect(outcome.closed).toBe(true);
    expect(r.delivered).toHaveLength(1);
    const token = await r.real.decodeToken({ tokenId: src.blob.tokenId, token: r.delivered[0] });
    expect(await r.real.verify(token)).toEqual({ ok: true });
    expect(r.real.isOwnedBy(token, r.recipient)).toBe(true);
    expect(await r.w.api.listIntents(r.w.caller, 'open')).toHaveLength(0);
  }, 30_000);

  it('(ii) beside a stale-handle conflict: possibly-committed, not a clean TransferConflictError, nothing aborted', async () => {
    const r = rig();
    const stale = await mintOwn(r.real, 10n);
    const good = await mintOwn(r.real, 10n);
    // Another transferId spends `stale` first: the plan's handle now names a consumed state.
    await r.real.transfer({ token: stale, recipientPubkey: freshPubkey() }, { transferId: crypto.randomUUID() });
    const plan = planOf(r.recipient, '20', [stale, good]);
    failRealizationOnce(good);

    const err = await rejection(new TransferMachine(r.deps).run(plan));

    expect(err).not.toBeInstanceOf(TransferConflictError);
    expect(isPossiblyCommittedSendOutcome(err)).toBe(true);
    expect(await r.real.isSpent(good)).toBe(true);
    await expectOpenAndUnaborted(r, plan);
  }, 30_000);

  it('(iii) split: the burn failing after its proof stays open; resume closes, delivers, adds the change, signs the close', async () => {
    const r = rig();
    const src = await mintOwn(r.real, 10n);
    const plan = planOf(r.recipient, '4', [], { token: src, splitAmount: '4', remainderAmount: '6' });
    failRealizationOnce(src);

    const err = await rejection(new TransferMachine(r.deps).run(plan));

    expect(isPossiblyCommittedSendOutcome(err)).toBe(true);
    expect(await r.real.isSpent(src)).toBe(true);
    expect(r.delivered).toHaveLength(0);
    await expectOpenAndUnaborted(r, plan);

    vi.restoreAllMocks();
    const outcome = await new TransferMachine(r.deps).resumeIntent({
      transferId: plan.transferId,
      payload: plan.payload,
      sources: new Map([[src.blob.tokenId, src]]),
      journaled: new Map(),
    });
    expect(outcome).toMatchObject({ closed: true, partial: null });
    expect(r.delivered).toHaveLength(1);
    const sent = await r.real.decodeToken({ tokenId: '', token: r.delivered[0] });
    expect(await r.real.verify(sent)).toEqual({ ok: true });
    expect(r.real.isOwnedBy(sent, r.recipient)).toBe(true);
    expect(r.real.balanceOf(sent, COIN)).toBe(4n);
    expect(r.uploaded).toHaveLength(1);
    const change = await r.real.decodeToken({ tokenId: '', token: r.uploaded[0] });
    expect(r.real.isOwnedBy(change, r.real.getIdentity().chainPubkey)).toBe(true);
    expect(r.real.balanceOf(change, COIN)).toBe(6n);
    expect(r.deltas).toHaveLength(1);
    expect(r.deltas[0]).toMatchObject({ transferId: plan.transferId, spent: [src.blob.tokenId] });
    expect(r.deltas[0].added.map((a) => a.tokenId)).toEqual([r.real.tokenId(change)]);
    expect(r.w.signCalls).toEqual([plan.transferId]);
    expect(await r.w.api.listIntents(r.w.caller, 'open')).toHaveLength(0);
  }, 60_000);
});
