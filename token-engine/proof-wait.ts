// One inclusion-proof wait: bounded by a deadline we own, and tolerant of a
// gateway that blips (#739, #741). state-transition-sdk >= 2.0.3 terminates its
// own poll loop on abort; proof-deadline.test.ts is the guard that it still does.

import {
  type InclusionProof,
  JsonRpcNetworkError,
  type PredicateVerifierService,
  type RootTrustBase,
  type StateTransitionClient,
  waitInclusionProof,
} from './sdk';
import { SphereError } from '../core/errors';

export const DEFAULT_PROOF_TIMEOUT_MS = 10_000;

/** Always bounded: an uncapped wait is the #739 hang, so there is no "no cap"
 *  value — non-positive is refused, never read as forever or as zero delay. */
export function resolveProofTimeoutMs(configured: number | undefined): number {
  if (configured === undefined) return DEFAULT_PROOF_TIMEOUT_MS;
  if (!Number.isFinite(configured) || configured <= 0) {
    throw new SphereError(
      `proofTimeoutMs must be a positive number of milliseconds (got ${String(configured)}); ` +
        'an unbounded inclusion-proof wait is not supported',
      'INVALID_CONFIG'
    );
  }
  return configured;
}

/** "Ask again", not "this certification failed" — the loop itself tolerates only
 *  404, so without this one blip strands a certification that would land (#741). */
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function isTransientGatewayError(err: unknown): boolean {
  return err instanceof JsonRpcNetworkError && TRANSIENT_HTTP_STATUSES.has(err.status);
}

/** Resolves on elapse OR abort; the caller re-checks the signal. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

/**
 * Runs `attempt` until it succeeds, a non-transient error surfaces, or the
 * signal ends it. The metered call is the SUBMIT, so this policy has to be
 * reusable by both — a copy per call site is how the two drift.
 */
export async function retryTransient<T>(
  attempt: () => Promise<T>,
  signal: AbortSignal,
  intervalMs: number
): Promise<{ value: T; retried: boolean }> {
  let retried = false;
  for (;;) {
    // `pause` resolves on abort too, so recheck before attempting (#747 review).
    if (signal.aborted) throw signal.reason as Error;
    try {
      return { value: await attempt(), retried };
    } catch (err) {
      // The deadline (or the caller) ended it: that outcome is final.
      if (signal.aborted) throw err;
      if (!isTransientGatewayError(err)) throw err;
      retried = true;
      await pause(intervalMs, signal);
    }
  }
}

/** A deadline for ONE certification attempt: submit retries and proof share it. */
export function certificationDeadline(
  timeoutMs: number,
  external: AbortSignal | undefined,
  label: string
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const relayAbort = (): void => {
    controller.abort(external?.reason);
  };
  if (external !== undefined) {
    if (external.aborted) relayAbort();
    else external.addEventListener('abort', relayAbort, { once: true });
  }
  const timer = setTimeout(() => {
    controller.abort(new SphereError(`${label} within ${String(timeoutMs)} ms`, 'AGGREGATOR_ERROR'));
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', relayAbort);
    },
  };
}

export interface ProofWaitDeps {
  readonly client: StateTransitionClient;
  readonly trustBase: RootTrustBase;
  readonly predicateVerifier: PredicateVerifierService;
  readonly intervalMs: number;
}

/** Await one inclusion proof, always terminating; a deadline hit throws and the
 *  caller maps it to ProofUnconfirmedError (keep-open — the spend may be on-chain). */
export async function awaitProofBounded(
  deps: ProofWaitDeps,
  transaction: Parameters<typeof waitInclusionProof>[3],
  signal: AbortSignal
): Promise<InclusionProof> {
  const { value } = await retryTransient(
    () =>
      waitInclusionProof(
        deps.client,
        deps.trustBase,
        deps.predicateVerifier,
        transaction,
        signal,
        deps.intervalMs
      ),
    signal,
    deps.intervalMs
  );
  return value;
}
