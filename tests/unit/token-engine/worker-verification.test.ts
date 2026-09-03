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
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { createSphereTokenEngine, createWorkerTokenVerifier } from '../../../token-engine/factory';
import type { SphereToken, VerificationWorker } from '../../../token-engine';
import {
  MintJustificationVerifierService,
  PredicateVerifierService,
  RootTrustBase,
  Secp256k1SignatureVerifier,
  SigningService,
  SplitMintJustificationVerifier,
  TokenIssuanceVerifierService,
  UnicityCertificateVerifier,
  UnicitySealQuorumSignaturesVerificationRule,
  VerificationContext,
  VerificationStatus,
  VerifiedSealCache,
  WorkerTokenVerifier,
} from '../../../token-engine/sdk';
import { decodeSpherePaymentData } from '../../../token-engine/SpherePaymentData';
import { TestAggregatorClient } from './support/TestAggregatorClient';
import { createTestEngine, freshPubkey } from './test-engine';

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

/**
 * #770 item 4 — `dispose()` must SETTLE the in-flight verification batch.
 *
 * The SDK's `WorkerPool.dispose()` (3.0.1) calls `worker.terminate()` on every
 * worker and nothing else. A dispatched batch resolves ONLY from
 * `worker.onmessage`, which a terminated worker never posts, and queued batches
 * are never drained — so `WorkerTokenVerifier.verify`, which awaits
 * `Promise.all(pool.run(...))`, hangs FOREVER. `pool` is `private readonly`
 * upstream, so the settle lives in our subclass (`token-engine/factory.ts`).
 *
 * Production trigger: `Sphere.setOracleApiKey` → `PaymentsFacade.setEngine`
 * disposes the engine it replaced, and a receive drain may be mid-`verify()`.
 *
 * These tests use a REAL certified token (in-memory aggregator) because the pool
 * is only reached after the genesis verifies on the calling thread — a fake token
 * never gets that far, so it could not observe the hang at all.
 */
describe('dispose() during an in-flight verification (#770 item 4)', () => {
  const COIN = 'a'.repeat(64);

  /** Accepts a batch and NEVER answers — exactly what a terminated worker does. */
  class SilentWorker implements VerificationWorker {
    onerror: ((event: { message: string }) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    terminated = false;
    posted = 0;
    /** Runs inside `WorkerPool.dispatch()`, before it acquires the NEXT worker. */
    onPost: (() => void) | null = null;

    postMessage(): void {
      this.posted += 1;
      this.onPost?.();
    }

    terminate(): void {
      this.terminated = true;
    }
  }

  type Settled =
    | { state: 'fulfilled'; value: unknown }
    | { state: 'rejected'; reason: unknown }
    | { state: 'pending' };

  /** Never waits unboundedly: a hang reports as `pending` instead of a suite timeout. */
  async function settleWithin(promise: Promise<unknown>, ms: number): Promise<Settled> {
    return Promise.race<Settled>([
      promise.then(
        (value): Settled => ({ state: 'fulfilled', value }),
        (reason): Settled => ({ state: 'rejected', reason })
      ),
      new Promise<Settled>((resolve) => setTimeout(() => resolve({ state: 'pending' }), ms)),
    ]);
  }

  async function until(predicate: () => boolean, what: string, ms = 5000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  /** One real chain: a token with 1 transfer, one with 2, and the trust base that certified them. */
  let trustBaseJson: unknown;
  let mintedOnly: SphereToken;
  let oneTransfer: SphereToken;
  let twoTransfers: SphereToken;

  beforeAll(async () => {
    const aggregator = TestAggregatorClient.create();
    const alice = createTestEngine({ aggregator });
    const bob = createTestEngine({ aggregator });
    mintedOnly = await alice.mint({
      recipientPubkey: alice.getIdentity().chainPubkey,
      value: { assets: [{ coinId: COIN, amount: 100n }] },
    });
    oneTransfer = await alice.transfer({ token: mintedOnly, recipientPubkey: bob.getIdentity().chainPubkey });
    twoTransfers = await bob.transfer({ token: oneTransfer, recipientPubkey: freshPubkey() });
    trustBaseJson = aggregator.rootTrustBase.toJSON();
  }, 30000);

  const buildEngine = async (
    createWorker: () => VerificationWorker,
    poolSize?: number
  ): ReturnType<typeof createSphereTokenEngine> =>
    createSphereTokenEngine({
      aggregatorUrl: 'http://localhost:3000',
      privateKey: SigningService.generatePrivateKey(),
      trustBaseJson,
      verification: { createWorker, ...(poolSize !== undefined ? { poolSize } : {}) },
    });

  it('settles the in-flight verification instead of hanging forever', async () => {
    const spawned: SilentWorker[] = [];
    const engine = await buildEngine(() => {
      const worker = new SilentWorker();
      spawned.push(worker);
      return worker;
    });

    const verifying = engine.verify(oneTransfer);
    await until(() => spawned.some((w) => w.posted > 0), 'the pool to dispatch a batch');

    engine.dispose?.();

    // Without the cancellation this never settles: the batch's only resolver is
    // the onmessage of a worker that was just terminated.
    const outcome = await settleWithin(verifying, 3000);
    expect(outcome.state).not.toBe('pending');
  }, 30000);

  it('REJECTS the cancelled verification — never resolves { ok: false }', async () => {
    const spawned: SilentWorker[] = [];
    const engine = await buildEngine(() => {
      const worker = new SilentWorker();
      spawned.push(worker);
      return worker;
    });

    const verifying = engine.verify(oneTransfer);
    await until(() => spawned.some((w) => w.posted > 0), 'the pool to dispatch a batch');
    engine.dispose?.();

    const outcome = await settleWithin(verifying, 3000);
    // THE money pin. The only engine.verify caller in the vertical is
    // modules/payments-v2/receive/Receive.ts `screen()`:
    //
    //   const verdict = await engine.verify(token);
    //   if (!verdict.ok) return { kind: 'ack', ack: rejectAck(entry, 'invalid') };
    //
    // A cancellation that RESOLVED `{ ok: false }` would PERMANENTLY reject a
    // valid incoming token at the mailbox, just because an api-key change landed
    // mid-drain. Rejecting instead reaches the drain's catch, which leaves the
    // entry unacked so it re-lists on the next drain.
    expect(outcome.state).toBe('rejected');
    expect(outcome).not.toMatchObject({ state: 'fulfilled' });
    expect(outcome).toMatchObject({ reason: { code: 'MODULE_DESTROYED' } });
  }, 30000);

  it('terminates every spawned worker, and a later verify() rejects without spawning one', async () => {
    const spawned: SilentWorker[] = [];
    const createWorker = vi.fn(() => {
      const worker = new SilentWorker();
      spawned.push(worker);
      return worker;
    });
    const engine = await buildEngine(createWorker);

    const verifying = engine.verify(oneTransfer);
    await until(() => spawned.some((w) => w.posted > 0), 'the pool to dispatch a batch');
    engine.dispose?.();
    await settleWithin(verifying, 3000);

    expect(spawned.length).toBeGreaterThan(0);
    expect(spawned.every((w) => w.terminated)).toBe(true);

    const spawnsBeforeSecondVerify = createWorker.mock.calls.length;
    const afterDispose = await settleWithin(engine.verify(oneTransfer), 3000);
    expect(afterDispose.state).toBe('rejected');
    expect(afterDispose).toMatchObject({ reason: { code: 'MODULE_DESTROYED' } });
    // The SDK's dispose() leaves its `workers` array populated but its `idle` list
    // holding TERMINATED workers, so a post-dispose task would happily call
    // createWorker() and resurrect the pool it just tore down.
    expect(createWorker).toHaveBeenCalledTimes(spawnsBeforeSecondVerify);
  }, 30000);

  it('rejects a post-dispose verify even for a token that needs no worker at all', async () => {
    const createWorker = vi.fn(() => new SilentWorker());
    const engine = await buildEngine(createWorker);
    engine.dispose?.();

    // A 0-transfer token never reaches the pool, so no other guard can notice the
    // teardown: without the `disposed` gate on verify(), a torn-down engine keeps
    // handing out verdicts as if it were live.
    const outcome = await settleWithin(engine.verify(mintedOnly), 3000);
    expect(outcome.state).toBe('rejected');
    expect(outcome).toMatchObject({ reason: { code: 'MODULE_DESTROYED' } });
    expect(createWorker).not.toHaveBeenCalled();
  }, 30000);

  /**
   * The same context the factory builds — the verifier needs a REAL one: it
   * verifies the genesis on the calling thread and only fans the transfers out.
   */
  const verificationContext = (): VerificationContext => {
    const trustBase = RootTrustBase.fromJSON(trustBaseJson);
    const mintJustificationVerifier = new MintJustificationVerifierService();
    mintJustificationVerifier.register(new SplitMintJustificationVerifier(decodeSpherePaymentData));
    return new VerificationContext(
      trustBase,
      PredicateVerifierService.create(),
      new UnicityCertificateVerifier(
        new UnicitySealQuorumSignaturesVerificationRule(new Secp256k1SignatureVerifier(), new VerifiedSealCache(256))
      ),
      mintJustificationVerifier,
      new TokenIssuanceVerifierService(false)
    );
  };

  /**
   * The cancellation `dispose()` fires must not be paid for by every verification
   * that ever SUCCEEDED. One shared never-settling promise raced against every
   * call would be: `Promise.race` subscribes to every input and never detaches
   * when another input wins, so a finished verification leaves its reaction
   * pinned to that promise until dispose() — unbounded retention in a wallet that
   * verifies a token on every receive, mint and resync.
   *
   * `pendingCancellations` is that retention made observable (no heap assertions:
   * they would be flaky and prove nothing about the structure).
   */
  describe('cancellation retention tracks concurrency, not history', () => {
    it('counts the verifications IN FLIGHT — up while they run, back to 0 when they settle', async () => {
      const verifier = createWorkerTokenVerifier({ createWorker: () => new FakeWorker(), poolSize: 3 });
      const context = verificationContext();
      expect(verifier.pendingCancellations).toBe(0);

      // Registered synchronously by verify(), so this reads the true in-flight set.
      // Without this half the leak guard below would pass on a counter stuck at 0.
      const inFlight = [
        verifier.verify(oneTransfer.sdkToken, context),
        verifier.verify(oneTransfer.sdkToken, context),
        verifier.verify(oneTransfer.sdkToken, context),
      ];
      expect(verifier.pendingCancellations).toBe(3);

      const results = await Promise.all(inFlight);
      expect(results.map((r) => r.status)).toEqual([
        VerificationStatus.OK,
        VerificationStatus.OK,
        VerificationStatus.OK,
      ]);
      expect(verifier.pendingCancellations).toBe(0);
      verifier.dispose();
    }, 30000);

    it('retains nothing per completed verification — 300 sequential verifies leave 0', async () => {
      const verifier = createWorkerTokenVerifier({ createWorker: () => new FakeWorker() });
      const context = verificationContext();

      let peak = 0;
      for (let i = 0; i < 300; i++) {
        const verifying = verifier.verify(oneTransfer.sdkToken, context);
        peak = Math.max(peak, verifier.pendingCancellations);
        expect((await verifying).status).toBe(VerificationStatus.OK);
      }

      // Sequential calls: at most ONE cancellation is ever live, and none survives
      // the call that created it. A shape that only clears on dispose() reads 300.
      expect(peak).toBe(1);
      expect(verifier.pendingCancellations).toBe(0);
      verifier.dispose();
    }, 60000);
  });

  it('a batch dispatched AFTER dispose() cannot resurrect the pool', async () => {
    // Deterministic ordering, no timing guess: two transfers + poolSize 2 means
    // WorkerPool.dispatch() loops twice. The FIRST worker calls dispose() from
    // inside postMessage — i.e. mid-loop, before acquire() runs for the second
    // batch. Without the createWorker() guard, that acquire spawns a live worker
    // that dispose() has already walked past, leaking a thread per api-key change.
    const spawned: SilentWorker[] = [];
    let engineRef: { dispose?: () => void } | null = null;
    const createWorker = vi.fn(() => {
      const worker = new SilentWorker();
      if (spawned.length === 0) worker.onPost = (): void => engineRef?.dispose?.();
      spawned.push(worker);
      return worker;
    });

    const engine = await buildEngine(createWorker, 2);
    engineRef = engine;

    const outcome = await settleWithin(engine.verify(twoTransfers), 5000);
    expect(outcome.state).toBe('rejected');
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].terminated).toBe(true);
  }, 30000);
});
