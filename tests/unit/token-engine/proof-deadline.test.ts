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
    private readonly inner: TestAggregatorClient,
    private readonly delayMs: () => number
  ) {}


  async submitCertificationRequest(
    ...args: Parameters<IAggregatorClient['submitCertificationRequest']>
  ): ReturnType<IAggregatorClient['submitCertificationRequest']> {
    return this.inner.submitCertificationRequest(...args);
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
});
