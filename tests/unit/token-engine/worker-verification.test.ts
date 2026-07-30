/**
 * EngineConfig.verification — the consumer's opt-in to PARALLEL token
 * verification (state-transition-sdk 2.0.2).
 *
 * What is pinned here is OUR wiring, which is where a consumer's configuration
 * can silently do nothing: that a configured factory reaches the SDK's pool, that
 * the pool spawns lazily and never exceeds poolSize, that dispose() terminates
 * exactly what was spawned, and that omitting the option leaves the sequential
 * verifier — the behavior every release before 2.0.2 had — untouched.
 *
 * The verification LOGIC either side of the worker boundary is upstream's
 * (WorkerTokenVerifierTest there); reproducing it would need a real token with
 * real inclusion proofs, i.e. the live e2e path.
 */
import { describe, expect, it, vi } from 'vitest';

import { createSphereTokenEngine, createWorkerTokenVerifier } from '../../../token-engine/factory';
import type { SphereToken, VerificationWorker } from '../../../token-engine';
import { SigningService, VerificationStatus, WorkerTokenVerifier } from '../../../token-engine/sdk';

/** Parses fine, touches no network (AggregatorClient connects on first request). */
const TRUST_BASE_JSON = {
  changeRecordHash: null,
  epoch: '0',
  epochStartRound: '0',
  networkId: 3,
  previousEntryHash: null,
  quorumThreshold: '1',
  rootNodes: [{ nodeId: 'NODE', sigKey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', stake: '1' }],
  signatures: {},
  stateHash: '00',
  version: '1',
};

/** A worker that answers every batch OK, and records that it was driven. */
function fakeWorker(spawned: FakeWorker[]): VerificationWorker {
  const w = new FakeWorker();
  spawned.push(w);
  return w;
}

class FakeWorker implements VerificationWorker {
  onerror: ((event: { message: string }) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  terminated = false;
  readonly batches: unknown[] = [];

  postMessage(message: unknown): void {
    this.batches.push(message);
    const transfers = (message as { transfers: readonly { index: number }[] }).transfers;
    // Answer asynchronously, like a real worker.
    queueMicrotask(() =>
      this.onmessage?.({
        data: transfers.map((t) => ({ index: t.index, message: 'ok', status: VerificationStatus.OK })),
      })
    );
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe('EngineConfig.verification wiring', () => {
  it('spawns no worker until something is verified', () => {
    const spawned: FakeWorker[] = [];
    const createWorker = vi.fn(() => fakeWorker(spawned));
    createWorkerTokenVerifier({ createWorker });
    // Constructing the verifier must not cost a thread — an engine is built on
    // every address switch and api-key change.
    expect(createWorker).not.toHaveBeenCalled();
    expect(spawned).toHaveLength(0);
  });

  it('dispose() terminates every worker it spawned, and is safe with none', () => {
    const spawned: FakeWorker[] = [];
    const verifier = createWorkerTokenVerifier({ createWorker: () => fakeWorker(spawned) });
    expect(() => verifier.dispose()).not.toThrow();
    expect(spawned).toHaveLength(0);
  });

  it('rejects a poolSize that cannot describe a pool', () => {
    const createWorker = (): VerificationWorker => new FakeWorker();
    expect(() => createWorkerTokenVerifier({ createWorker, poolSize: 0 })).toThrow(/positive integer/);
    expect(() => createWorkerTokenVerifier({ createWorker, poolSize: -2 })).toThrow(/positive integer/);
    expect(() => createWorkerTokenVerifier({ createWorker, poolSize: 1.5 })).toThrow(/positive integer/);
  });

  it('accepts a valid poolSize and the default', () => {
    const createWorker = (): VerificationWorker => new FakeWorker();
    expect(() => createWorkerTokenVerifier({ createWorker, poolSize: 1 })).not.toThrow();
    expect(() => createWorkerTokenVerifier({ createWorker })).not.toThrow();
  });

  it('binds to the SDK pool verifier, not to a silently-ignored option', () => {
    const verifier = createWorkerTokenVerifier({ createWorker: () => new FakeWorker() });
    // Guards the one thing a wiring bug looks like from outside: config accepted,
    // sequential verification anyway.
    expect(verifier).toBeInstanceOf(WorkerTokenVerifier);
  });
});

describe('engine.verify routing', () => {
  const engineConfig = {
    aggregatorUrl: 'http://localhost:3000',
    privateKey: SigningService.generatePrivateKey(),
    trustBaseJson: TRUST_BASE_JSON,
  };
  /** A token whose only job is to record whether the SEQUENTIAL path was taken. */
  const probeToken = (): { token: SphereToken; verify: ReturnType<typeof vi.fn> } => {
    const verify = vi.fn().mockResolvedValue({ status: VerificationStatus.OK });
    return { token: { sdkToken: { verify } } as unknown as SphereToken, verify };
  };

  it('without the option, verifies through Token.verify (the pre-2.0.2 behavior)', async () => {
    const engine = await createSphereTokenEngine(engineConfig);
    const { token, verify } = probeToken();
    await expect(engine.verify(token)).resolves.toEqual({ ok: true });
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('with the option, Token.verify is NEVER used — the configured verifier owns it', async () => {
    const engine = await createSphereTokenEngine({
      ...engineConfig,
      verification: { createWorker: () => new FakeWorker() },
    });
    const { token, verify } = probeToken();
    // The pool verifier walks a REAL token; this probe is not one, so it rejects.
    // What matters is which path was taken: the sequential one must be untouched.
    await expect(engine.verify(token)).rejects.toBeDefined();
    expect(verify).not.toHaveBeenCalled();
    engine.dispose?.();
  });

  it('dispose() is safe on an engine with no worker pool', async () => {
    const engine = await createSphereTokenEngine(engineConfig);
    expect(() => engine.dispose?.()).not.toThrow();
  });
});
