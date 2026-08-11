/**
 * #739: an inclusion-proof wait must ALWAYS terminate.
 *
 * The SDK's `waitInclusionProof` takes its deadline as an AbortSignal but attaches
 * the listener fresh inside every `sleep()` with no `aborted` pre-check. An
 * AbortSignal dispatches `abort` exactly once, so a deadline that elapses while a
 * `getInclusionProof` request is in flight is lost, and the loop polls forever:
 * the op never settles, never throws, and `PaymentsFacade.stop()` — which drains
 * `pendingOps` — wedges behind it.
 *
 * These cases pin the two properties the fix must hold, and they are written to
 * catch the ORIGINAL bug: the gateway here is slower than the poll interval, so
 * the deadline reliably lands mid-fetch rather than mid-sleep.
 */
import { describe, expect, it } from 'vitest';

import {
  type IAggregatorClient,
  type InclusionProofResponse,
  JsonRpcNetworkError,
  type StateId,
} from '../../../token-engine/sdk';
import { ProofUnconfirmedError } from '../../../token-engine/errors';
import { createTestEngine } from './test-engine';
import { TestAggregatorClient } from './support/TestAggregatorClient';

const COIN = 'ab'.repeat(32);

/** Answers submits normally, but every proof read is slower than the poll interval. */
class SlowProofClient implements IAggregatorClient {
  public proofCalls = 0;

  constructor(
    protected readonly inner: TestAggregatorClient,
    private readonly delayMs: () => number
  ) {}


  async submitCertificationRequest(
    certificationData: Parameters<IAggregatorClient['submitCertificationRequest']>[0]
  ): ReturnType<IAggregatorClient['submitCertificationRequest']> {
    return this.inner.submitCertificationRequest(certificationData);
  }

  /** The aggregator's genuine answer — used by cases that recover after a blip. */
  protected realProof(stateId: StateId): Promise<InclusionProofResponse> {
    return this.inner.getInclusionProof(stateId);
  }

  async getInclusionProof(_stateId: StateId): Promise<InclusionProofResponse> {
    this.proofCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, this.delayMs()));
    // The real gateway's pre-finalization answer, which the loop tolerates and
    // retries — so the wait keeps polling and the deadline is what must end it.
    throw new JsonRpcNetworkError(404, 'not found');
  }
}

function slowEngine(delayMs: () => number, proofTimeoutMs: number) {
  const aggregator = TestAggregatorClient.create();
  const wireClient = new SlowProofClient(aggregator, delayMs);
  const engine = createTestEngine({
    aggregator,
    wireClient,
    proofTimeoutMs,
    proofPollIntervalMs: 50,
  });
  return { engine, wireClient };
}

describe('#739 the inclusion-proof wait always terminates', () => {
  it('a deadline landing mid-fetch still ends the wait — 12/12 trials, none hang', async () => {
    // Fetch (60-160ms) outlives the 50ms poll interval, so the 120ms deadline
    // lands during a request far more often than during a sleep. Pre-fix this
    // is the unbounded-hang path and a fraction of these never settle.
    for (let trial = 0; trial < 12; trial += 1) {
      const { engine } = slowEngine(() => 60 + ((trial * 37) % 100), 120);
      const started = Date.now();
      const err = await engine
        .mint({
          recipientPubkey: engine.getIdentity().chainPubkey,
          value: { assets: [{ coinId: COIN, amount: 1000n }] },
        })
        .then(() => null)
        .catch((e: unknown) => e);

      // Keep-open is the correct posture: the spend may be on-chain.
      expect(err).toBeInstanceOf(ProofUnconfirmedError);
      // Bounded: the deadline plus one in-flight fetch, generously.
      expect(Date.now() - started).toBeLessThan(3_000);
    }
  }, 60_000);

  it('a fetch that NEVER settles still ends at the deadline — the loop never reaches a sleep', async () => {
    // The shim alone cannot help here: with no sleep to abort, only a deadline
    // we own can end the wait. A hung socket is exactly this shape.
    const aggregator = TestAggregatorClient.create();
    const engine = createTestEngine({
      aggregator,
      wireClient: new (class extends SlowProofClient {
        override async getInclusionProof(): Promise<never> {
          this.proofCalls += 1;
          return new Promise<never>(() => {
            /* never settles */
          });
        }
      })(aggregator, () => 0),
      proofTimeoutMs: 150,
      proofPollIntervalMs: 50,
    });

    const started = Date.now();
    const err = await engine
      .mint({
        recipientPubkey: engine.getIdentity().chainPubkey,
        value: { assets: [{ coinId: COIN, amount: 1000n }] },
      })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProofUnconfirmedError);
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 30_000);

  it('a non-positive deadline is refused at construction, not honoured as "no cap" or as zero', () => {
    // engine.ts once documented 0 as "no engine-side cap". Read literally that is
    // the #739 hang as a setting; read as a timeout it aborts every wait on the
    // next timer turn, reporting healthy sends as unconfirmed. Neither is a
    // behaviour worth having, so it is refused where it is configured.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createTestEngine({ proofTimeoutMs: bad })).toThrow(
        /proofTimeoutMs must be a positive number/i
      );
    }
    expect(() => createTestEngine({ proofTimeoutMs: 1 })).not.toThrow();
    expect(() => createTestEngine()).not.toThrow();
  });

  it('the abandoned loop STOPS polling — a lost deadline must not leak a permanent poller', async () => {
    const { engine, wireClient } = slowEngine(() => 60, 120);
    await engine
      .mint({
        recipientPubkey: engine.getIdentity().chainPubkey,
        value: { assets: [{ coinId: COIN, amount: 1000n }] },
      })
      .catch(() => undefined);

    const afterSettle = wireClient.proofCalls;
    await new Promise((resolve) => setTimeout(resolve, 600));
    // At most the one request already in flight when the deadline fired may land.
    expect(wireClient.proofCalls - afterSettle).toBeLessThanOrEqual(1);
  }, 30_000);

  it('#741: a transient gateway blip is retried, not treated as a failed certification', async () => {
    // Pre-#741 the loop tolerated only 404, so ONE 503 mid-poll turned a
    // certification that was about to land into an open intent.
    for (const status of [429, 502, 503]) {
      const aggregator = TestAggregatorClient.create();
      let polls = 0;
      const engine = createTestEngine({
        aggregator,
        wireClient: new (class extends SlowProofClient {
          override async getInclusionProof(
            stateId: Parameters<TestAggregatorClient['getInclusionProof']>[0]
          ): Promise<InclusionProofResponse> {
            polls += 1;
            if (polls <= 2) throw new JsonRpcNetworkError(status, 'blip');
            return this.realProof(stateId);
          }
        })(aggregator, () => 0),
        proofTimeoutMs: 5_000,
        proofPollIntervalMs: 20,
      });

      const token = await engine.mint({
        recipientPubkey: engine.getIdentity().chainPubkey,
        value: { assets: [{ coinId: COIN, amount: 1000n }] },
      });
      expect(engine.balanceOf(token, COIN)).toBe(1000n);
      expect(polls).toBeGreaterThan(2);
    }
  }, 60_000);

  it('#741: a NON-transient error still fails fast — tolerance must not swallow a real one', async () => {
    const aggregator = TestAggregatorClient.create();
    let polls = 0;
    const engine = createTestEngine({
      aggregator,
      wireClient: new (class extends SlowProofClient {
        override async getInclusionProof(): Promise<never> {
          polls += 1;
          throw new JsonRpcNetworkError(400, 'malformed');
        }
      })(aggregator, () => 0),
      proofTimeoutMs: 5_000,
      proofPollIntervalMs: 20,
    });

    const started = Date.now();
    await engine
      .mint({
        recipientPubkey: engine.getIdentity().chainPubkey,
        value: { assets: [{ coinId: COIN, amount: 1000n }] },
      })
      .catch(() => undefined);

    // Surfaced immediately, not retried to the 5s deadline.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(polls).toBe(1);
  }, 30_000);

  it('#741: a gateway transient FOREVER still ends at the deadline, never unbounded', async () => {
    const aggregator = TestAggregatorClient.create();
    const engine = createTestEngine({
      aggregator,
      wireClient: new (class extends SlowProofClient {
        override async getInclusionProof(): Promise<never> {
          throw new JsonRpcNetworkError(503, 'down');
        }
      })(aggregator, () => 0),
      proofTimeoutMs: 300,
      proofPollIntervalMs: 20,
    });

    const started = Date.now();
    const err = await engine
      .mint({
        recipientPubkey: engine.getIdentity().chainPubkey,
        value: { assets: [{ coinId: COIN, amount: 1000n }] },
      })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProofUnconfirmedError);
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 30_000);

  it('#746: a rate-limited SUBMIT is retried, not turned into a doomed 10s proof wait', async () => {
    // The 429 the gateway actually emits lands on submitCertificationRequest —
    // the metered call. Before #746 it was swallowed into submitError and the
    // code then polled for a proof of a request the gateway never accepted,
    // burning the entire deadline and leaving the intent open.
    const aggregator = TestAggregatorClient.create();
    let submits = 0;
    const engine = createTestEngine({
      aggregator,
      wireClient: new (class extends SlowProofClient {
        override async submitCertificationRequest(
          data: Parameters<TestAggregatorClient['submitCertificationRequest']>[0]
        ): ReturnType<TestAggregatorClient['submitCertificationRequest']> {
          submits += 1;
          if (submits <= 2) throw new JsonRpcNetworkError(429, 'slow down');
          return this.inner.submitCertificationRequest(data);
        }
        override async getInclusionProof(
          stateId: Parameters<TestAggregatorClient['getInclusionProof']>[0]
        ): Promise<InclusionProofResponse> {
          return this.realProof(stateId);
        }
      })(aggregator, () => 0),
      proofTimeoutMs: 5_000,
      proofPollIntervalMs: 20,
    });

    const started = Date.now();
    const token = await engine.mint({
      recipientPubkey: engine.getIdentity().chainPubkey,
      value: { assets: [{ coinId: COIN, amount: 1000n }] },
    });

    expect(engine.balanceOf(token, COIN)).toBe(1000n);
    expect(submits).toBe(3);
    // Retried in poll-interval time, nowhere near the 5s deadline it used to burn.
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 30_000);

  it('#746: a NON-transient submit rejection is not retried', async () => {
    const aggregator = TestAggregatorClient.create();
    let submits = 0;
    const engine = createTestEngine({
      aggregator,
      wireClient: new (class extends SlowProofClient {
        override async submitCertificationRequest(): Promise<never> {
          submits += 1;
          throw new JsonRpcNetworkError(400, 'malformed');
        }
      })(aggregator, () => 0),
      proofTimeoutMs: 400,
      proofPollIntervalMs: 20,
    });

    await engine
      .mint({
        recipientPubkey: engine.getIdentity().chainPubkey,
        value: { assets: [{ coinId: COIN, amount: 1000n }] },
      })
      .catch(() => undefined);

    expect(submits).toBe(1);
  }, 30_000);

  it('#746: submit retries and the proof share ONE deadline — the attempt stays bounded', async () => {
    const aggregator = TestAggregatorClient.create();
    const engine = createTestEngine({
      aggregator,
      wireClient: new (class extends SlowProofClient {
        override async submitCertificationRequest(): Promise<never> {
          throw new JsonRpcNetworkError(503, 'down');
        }
      })(aggregator, () => 0),
      proofTimeoutMs: 300,
      proofPollIntervalMs: 20,
    });

    const started = Date.now();
    const err = await engine
      .mint({
        recipientPubkey: engine.getIdentity().chainPubkey,
        value: { assets: [{ coinId: COIN, amount: 1000n }] },
      })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProofUnconfirmedError);
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 30_000);

  it('#747 review: a clean-reject on a RETRY cannot erase an earlier ambiguous submit', async () => {
    // The first POST fails ambiguously (503) — it may already have been
    // processed. A retry then answers with a clean-reject status. Reading that
    // as "provably never certified" would abort the intent and restore a source
    // whose spend may be on-chain; the outcome must stay keep-open.
    const aggregator = TestAggregatorClient.create();
    let submits = 0;
    const engine = createTestEngine({
      aggregator,
      wireClient: new (class extends SlowProofClient {
        override async submitCertificationRequest(): Promise<never> {
          submits += 1;
          if (submits === 1) throw new JsonRpcNetworkError(503, 'ambiguous');
          throw new JsonRpcNetworkError(400, 'clean reject after the fact');
        }
      })(aggregator, () => 0),
      proofTimeoutMs: 400,
      proofPollIntervalMs: 20,
    });

    const err = await engine
      .mint({
        recipientPubkey: engine.getIdentity().chainPubkey,
        value: { assets: [{ coinId: COIN, amount: 1000n }] },
      })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(submits).toBeGreaterThan(1);
    expect(err).toBeInstanceOf(ProofUnconfirmedError);
  }, 30_000);

  it('#747 review: no attempt is issued after the deadline has already fired', async () => {
    // `pause` resolves on abort as well as on elapse, so the loop must recheck
    // the signal BEFORE attempting again — otherwise one extra POST goes out
    // past the deadline, and a hanging one un-bounds the whole operation.
    const aggregator = TestAggregatorClient.create();
    let submits = 0;
    const engine = createTestEngine({
      aggregator,
      wireClient: new (class extends SlowProofClient {
        override async submitCertificationRequest(): Promise<never> {
          submits += 1;
          await new Promise((r) => setTimeout(r, 60));
          throw new JsonRpcNetworkError(503, 'down');
        }
      })(aggregator, () => 0),
      proofTimeoutMs: 200,
      proofPollIntervalMs: 40,
    });

    await engine
      .mint({
        recipientPubkey: engine.getIdentity().chainPubkey,
        value: { assets: [{ coinId: COIN, amount: 1000n }] },
      })
      .catch(() => undefined);

    const settled = submits;
    await new Promise((r) => setTimeout(r, 400));
    expect(submits).toBe(settled); // nothing issued after the deadline
  }, 30_000);
});
