// #739: one inclusion-proof wait, with the deadline OWNED here — the SDK's own
// deadline is lost when it fires mid-fetch, and the loop then polls forever.

import {
  type InclusionProof,
  type PredicateVerifierService,
  type RootTrustBase,
  type StateTransitionClient,
  waitInclusionProof,
} from './sdk';
import { SphereError } from '../core/errors';

export const DEFAULT_PROOF_TIMEOUT_MS = 10_000;

/** Delivers `abort` to a listener attached after the fact — what lets the SDK's
 *  per-sleep listener still fire, so its loop exits instead of polling forever. */
function lateDeliveringSignal(signal: AbortSignal): AbortSignal {
  return new Proxy(signal, {
    get(target, prop): unknown {
      if (prop === 'addEventListener') {
        return (
          type: string,
          listener: EventListener,
          options?: AddEventListenerOptions | boolean
        ): void => {
          if (type === 'abort' && target.aborted) {
            queueMicrotask(() => {
              listener.call(target, new Event('abort'));
            });
            return;
          }
          target.addEventListener(type, listener, options);
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/** Rejects as soon as the signal aborts — bounds our wait even if the fetch never settles. */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        reject(signal.reason as Error);
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
  const wait = waitInclusionProof(
    deps.client,
    deps.trustBase,
    deps.predicateVerifier,
    transaction,
    lateDeliveringSignal(controller.signal),
    deps.intervalMs
  );
  // The race may settle first; keep a late rejection from going unhandled.
  wait.catch(() => undefined);
  try {
    return await Promise.race([wait, rejectOnAbort(controller.signal)]);
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', relayAbort);
  }
}
