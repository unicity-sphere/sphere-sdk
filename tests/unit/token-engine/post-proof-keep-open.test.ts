/**
 * #839: once an op's inclusion proof match-verifies OK, the op IS certified under its
 * transferId. Every failure after that point (building the certified transaction,
 * applying it to the token, wrapping the result, encoding the split checkpoint) must
 * be keep-open, never an untyped error a caller could read as "nothing happened".
 *
 * Each case injects the failure after the proof and asserts `isSpent(source)`, which
 * proves the spend really is on chain when the error surfaces. The vi.mock of
 * split-checkpoint stays in this file only, so it cannot leak into other suites.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CheckpointPersistFailedError, ProofUnconfirmedError, SplitCheckpointLostError } from '../../../token-engine/errors';
import type { SplitCheckpointStore } from '../../../token-engine/engine';
import { Token, TransferTransaction } from '../../../token-engine/sdk';
import type { SphereToken } from '../../../token-engine/types';
import * as checkpoint from '../../../token-engine/split-checkpoint';
import type { SphereTokenEngine } from '../../../token-engine/SphereTokenEngine';
import { AdversarialResubmitClient } from './support/AdversarialResubmitClient';
import { TestAggregatorClient } from './support/TestAggregatorClient';
import { createTestEngine, freshPubkey } from './test-engine';

vi.mock('../../../token-engine/split-checkpoint', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../token-engine/split-checkpoint')>();
  return { ...mod, encodeCheckpoint: vi.fn(mod.encodeCheckpoint) };
});

const COIN = 'aa'.repeat(32);

/** First-write-wins, durable on resolve: the SplitCheckpointStore contract, in memory. */
class MemStore implements SplitCheckpointStore {
  puts = 0;
  /** Runs once the slot is written: a fault armed here hits only what follows the durable ack. */
  afterPut: () => void = () => {};
  private readonly slots = new Map<string, Uint8Array>();
  async put(transferId: string, opIndex: number, bytes: Uint8Array): Promise<Uint8Array> {
    this.puts++;
    try {
      return this.write(`${transferId}:${opIndex}`, bytes);
    } finally {
      this.afterPut();
    }
  }
  private write(key: string, bytes: Uint8Array): Uint8Array {
    const have = this.slots.get(key);
    if (have !== undefined) return have;
    this.slots.set(key, bytes);
    return bytes;
  }
  async get(transferId: string, opIndex: number): Promise<Uint8Array | null> {
    return this.slots.get(`${transferId}:${opIndex}`) ?? null;
  }
}

interface Rig {
  engine: SphereTokenEngine;
  wire: AdversarialResubmitClient;
  source: SphereToken;
}

async function rig(amount = 10n): Promise<Rig> {
  const aggregator = TestAggregatorClient.create();
  const wire = new AdversarialResubmitClient(aggregator);
  const engine = createTestEngine({ aggregator, wireClient: wire });
  const source = await engine.mint({
    recipientPubkey: engine.getIdentity().chainPubkey,
    value: { assets: [{ coinId: COIN, amount }] },
  });
  return { engine, wire, source };
}

function splitOutputs(engine: SphereTokenEngine, recipient: Uint8Array) {
  return [
    { recipientPubkey: recipient, coinId: COIN, amount: 4n },
    { recipientPubkey: engine.getIdentity().chainPubkey, coinId: COIN, amount: 6n },
  ];
}

const rejection = (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (err: unknown) => err);

describe('#839 a failure after a matching proof is keep-open', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('(a) transfer: Token.transfer failing after the proof is ProofUnconfirmedError with the cause; the same transferId realizes it', async () => {
    const { engine, source } = await rig();
    const recipient = freshPubkey();
    const transferId = crypto.randomUUID();
    const cause = new Error('verification context drift');
    vi.spyOn(Token.prototype, 'transfer').mockRejectedValueOnce(cause);

    const err = await rejection(engine.transfer({ token: source, recipientPubkey: recipient }, { transferId }));

    expect(err).toBeInstanceOf(ProofUnconfirmedError);
    expect((err as ProofUnconfirmedError).code).toBe('CERTIFICATION_UNCONFIRMED');
    expect((err as ProofUnconfirmedError).cause).toBe(cause);
    expect(await engine.isSpent(source)).toBe(true);
    vi.restoreAllMocks();
    const out = await engine.transfer({ token: source, recipientPubkey: recipient }, { transferId });
    expect(await engine.verify(out)).toEqual({ ok: true });
    expect(engine.isOwnedBy(out, recipient)).toBe(true);
  }, 30_000);

  it('(b) transfer: toCertifiedTransaction failing after the proof is ProofUnconfirmedError; the same transferId realizes it', async () => {
    const { engine, source } = await rig();
    const recipient = freshPubkey();
    const transferId = crypto.randomUUID();
    const cause = new Error('certify drift');
    vi.spyOn(TransferTransaction.prototype, 'toCertifiedTransaction').mockRejectedValueOnce(cause);

    const err = await rejection(engine.transfer({ token: source, recipientPubkey: recipient }, { transferId }));

    expect(err).toBeInstanceOf(ProofUnconfirmedError);
    expect((err as ProofUnconfirmedError).cause).toBe(cause);
    expect(await engine.isSpent(source)).toBe(true);
    vi.restoreAllMocks();
    const out = await engine.transfer({ token: source, recipientPubkey: recipient }, { transferId });
    expect(await engine.verify(out)).toEqual({ ok: true });
    expect(engine.isOwnedBy(out, recipient)).toBe(true);
  }, 30_000);

  it('(c) burn: toCertifiedTransaction failing after the proof is ProofUnconfirmedError; the same transferId realizes it', async () => {
    const { engine, wire, source } = await rig();
    const reasonBytes = new Uint8Array([1]);
    const transferId = crypto.randomUUID();
    vi.spyOn(TransferTransaction.prototype, 'toCertifiedTransaction').mockRejectedValueOnce(new Error('certify drift'));

    const err = await rejection(engine.burn({ token: source, reasonBytes }, { transferId }));

    expect(err).toBeInstanceOf(ProofUnconfirmedError);
    expect((err as Error).message).not.toMatch(/intent/);
    expect(await engine.isSpent(source)).toBe(true);
    vi.restoreAllMocks();
    const submitted = wire.submits.length;
    const burned = await engine.burn({ token: source, reasonBytes }, { transferId });
    expect(await engine.verify(burned)).toEqual({ ok: true });
    expect(wire.submits.length - submitted, 'the re-call re-submits the identical burn once').toBe(1);
  }, 30_000);

  it('(d) split with a store: the burn failing after its proof is keep-open, stores nothing, submits no mint; the same transferId completes', async () => {
    const { engine, wire, source } = await rig();
    const store = new MemStore();
    const recipient = freshPubkey();
    const transferId = crypto.randomUUID();
    const submitsBefore = wire.submits.length;
    vi.spyOn(Token.prototype, 'transfer').mockRejectedValueOnce(new Error('burn verify drift'));

    const err = await rejection(
      engine.split({ token: source, outputs: splitOutputs(engine, recipient) }, { transferId, checkpointStore: store }),
    );

    expect(err).toBeInstanceOf(ProofUnconfirmedError);
    expect(store.puts).toBe(0);
    expect(wire.submits.length - submitsBefore, 'the burn alone was submitted: no mint leg').toBe(1);
    expect(await engine.isSpent(source)).toBe(true);
    vi.restoreAllMocks();
    const { outputs } = await engine.split(
      { token: source, outputs: splitOutputs(engine, recipient) },
      { transferId, checkpointStore: store },
    );
    expect(outputs.map((o) => engine.balanceOf(o, COIN))).toEqual([4n, 6n]);
    expect(await Promise.all(outputs.map((o) => engine.verify(o)))).toEqual([{ ok: true }, { ok: true }]);
    expect(engine.isOwnedBy(outputs[0], recipient)).toBe(true);
  }, 60_000);

  it('(e) split without a store: the burn failing after its proof is keep-open; the same transferId completes', async () => {
    const { engine, wire, source } = await rig();
    const recipient = freshPubkey();
    const transferId = crypto.randomUUID();
    const submitsBefore = wire.submits.length;
    vi.spyOn(Token.prototype, 'transfer').mockRejectedValueOnce(new Error('burn verify drift'));

    const err = await rejection(engine.split({ token: source, outputs: splitOutputs(engine, recipient) }, { transferId }));

    expect(err).toBeInstanceOf(ProofUnconfirmedError);
    expect(wire.submits.length - submitsBefore).toBe(1);
    expect(await engine.isSpent(source)).toBe(true);
    vi.restoreAllMocks();
    const { outputs } = await engine.split({ token: source, outputs: splitOutputs(engine, recipient) }, { transferId });
    expect(outputs.map((o) => engine.balanceOf(o, COIN))).toEqual([4n, 6n]);
    expect(await Promise.all(outputs.map((o) => engine.verify(o)))).toEqual([{ ok: true }, { ok: true }]);
    expect(engine.isOwnedBy(outputs[0], recipient)).toBe(true);
  }, 60_000);

  it('(f) split: a checkpoint encode failure is CheckpointPersistFailedError, nothing stored; the same transferId completes', async () => {
    const { engine, wire, source } = await rig();
    const store = new MemStore();
    const recipient = freshPubkey();
    const transferId = crypto.randomUUID();
    const submitsBefore = wire.submits.length;
    const cause = new Error('encode failed');
    vi.mocked(checkpoint.encodeCheckpoint).mockRejectedValueOnce(cause);

    const err = await rejection(
      engine.split({ token: source, outputs: splitOutputs(engine, recipient) }, { transferId, checkpointStore: store }),
    );

    expect(err).toBeInstanceOf(CheckpointPersistFailedError);
    expect((err as CheckpointPersistFailedError).cause).toBe(cause);
    expect(store.puts).toBe(0);
    expect(wire.submits.length - submitsBefore).toBe(1);
    expect(await engine.isSpent(source)).toBe(true);
    const { outputs } = await engine.split(
      { token: source, outputs: splitOutputs(engine, recipient) },
      { transferId, checkpointStore: store },
    );
    expect(outputs.map((o) => engine.balanceOf(o, COIN))).toEqual([4n, 6n]);
    expect(await Promise.all(outputs.map((o) => engine.verify(o)))).toEqual([{ ok: true }, { ok: true }]);
  }, 60_000);

  it('(g) split with a store: the burn\'s toCertifiedTransaction failing after its proof is keep-open, stores nothing, submits no mint; the same transferId completes', async () => {
    const { engine, wire, source } = await rig();
    const store = new MemStore();
    const recipient = freshPubkey();
    const transferId = crypto.randomUUID();
    const submitsBefore = wire.submits.length;
    const cause = new Error('burn certify drift');
    vi.spyOn(TransferTransaction.prototype, 'toCertifiedTransaction').mockRejectedValueOnce(cause);

    const err = await rejection(
      engine.split({ token: source, outputs: splitOutputs(engine, recipient) }, { transferId, checkpointStore: store }),
    );

    expect(err).toBeInstanceOf(ProofUnconfirmedError);
    expect((err as ProofUnconfirmedError).cause).toBe(cause);
    expect(store.puts).toBe(0);
    expect(wire.submits.length - submitsBefore, 'the burn alone was submitted: no mint leg').toBe(1);
    expect(await engine.isSpent(source)).toBe(true);
    vi.restoreAllMocks();
    const { outputs } = await engine.split(
      { token: source, outputs: splitOutputs(engine, recipient) },
      { transferId, checkpointStore: store },
    );
    expect(outputs.map((o) => engine.balanceOf(o, COIN))).toEqual([4n, 6n]);
    expect(await Promise.all(outputs.map((o) => engine.verify(o)))).toEqual([{ ok: true }, { ok: true }]);
  }, 60_000);

  it.each([
    ['the burnt token', () => vi.spyOn(Token.prototype, 'toCBOR')],
    ['the re-derived burn tx', () => vi.spyOn(TransferTransaction.prototype, 'toCBOR')],
  ])('(h) split with a store: re-encoding %s after the checkpoint is stored is SplitCheckpointLostError; the same transferId completes', async (_what, spy) => {
    const { engine, wire, source } = await rig();
    const store = new MemStore();
    const recipient = freshPubkey();
    const transferId = crypto.randomUUID();
    const submitsBefore = wire.submits.length;
    const cause = new Error('re-encode failed');
    store.afterPut = () => {
      spy().mockImplementationOnce(() => {
        throw cause;
      });
      store.afterPut = () => {};
    };

    const err = await rejection(
      engine.split({ token: source, outputs: splitOutputs(engine, recipient) }, { transferId, checkpointStore: store }),
    );

    expect(err).toBeInstanceOf(SplitCheckpointLostError);
    expect((err as SplitCheckpointLostError).cause).toBe(cause);
    expect(store.puts).toBe(1);
    expect(wire.submits.length - submitsBefore, 'the burn alone was submitted: no mint leg').toBe(1);
    expect(await engine.isSpent(source)).toBe(true);
    vi.restoreAllMocks();
    const { outputs } = await engine.split(
      { token: source, outputs: splitOutputs(engine, recipient) },
      { transferId, checkpointStore: store },
    );
    expect(outputs.map((o) => engine.balanceOf(o, COIN))).toEqual([4n, 6n]);
    expect(await Promise.all(outputs.map((o) => engine.verify(o)))).toEqual([{ ok: true }, { ok: true }]);
  }, 60_000);
});
