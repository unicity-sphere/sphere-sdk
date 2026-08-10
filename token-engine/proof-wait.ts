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

export interface ProofWaitDeps {
  readonly client: StateTransitionClient;
  readonly trustBase: RootTrustBase;
  readonly predicateVerifier: PredicateVerifierService;
  readonly timeoutMs: number;
  readonly intervalMs: number;
}

/** Await one inclusion proof, always terminating; a deadline hit throws and the
 *  caller maps it to ProofUnconfirmedError (keep-open — the spend may be on-chain). */
export async function awaitProofBounded(
  deps: ProofWaitDeps,
  transaction: Parameters<typeof waitInclusionProof>[3],
  external: AbortSignal | undefined
): Promise<InclusionProof> {
  const controller = new AbortController();
  const relayAbort = (): void => {
    controller.abort(external?.reason);
  };
  if (external !== undefined) {
    if (external.aborted) relayAbort();
    else external.addEventListener('abort', relayAbort, { once: true });
  }
  const timer = setTimeout(() => {
    controller.abort(
      new SphereError(
        `inclusion proof not confirmed within ${String(deps.timeoutMs)} ms`,
        'AGGREGATOR_ERROR'
      )
    );
  }, deps.timeoutMs);

  try {
    for (;;) {
      try {
        return await waitInclusionProof(
          deps.client,
          deps.trustBase,
          deps.predicateVerifier,
          transaction,
          controller.signal,
          deps.intervalMs
        );
      } catch (err) {
        // The deadline (or the caller) ended it: that outcome is final.
        if (controller.signal.aborted) throw err;
        if (!isTransientGatewayError(err)) throw err;
        await pause(deps.intervalMs, controller.signal);
      }
    }
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', relayAbort);
  }
}
