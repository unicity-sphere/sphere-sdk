/**
 * token-engine/retrying-aggregator-client.ts (Wave 6-P2-20)
 *
 * Thin wrapper around v2's `AggregatorClient` that retries
 * `submitCertificationRequest` on transient errors (HTTP 5xx, network,
 * abort). Everything else — `getInclusionProof`, `getLatestBlockNumber`
 * — is a passthrough (those already have per-caller retry loops or
 * bounded polling semantics that would compound if we double-retried).
 *
 * Motivation: testnet2's `gateway.testnet2.unicity.network` returns
 * intermittent 503 during load. Trader-roundtrip on v2 hit `Fatal
 * startup error: Failed to mint nametag token: Submit failed:
 * {"status":503,...}` because the tenant's `Sphere.init` had no retry
 * around the nametag mint call. Wrapping at the SDK client boundary
 * means EVERY mint / transfer / split gets the same recovery.
 *
 * Not SHA-pinned — this is our anti-corruption layer, not vendored code.
 */

import { logger } from '../core/logger';
import type { AggregatorClient, CertificationData, CertificationResponse } from './sdk';

/**
 * Backoff schedule for successive retry attempts in ms. Total spend on
 * exhausted budget: 500 + 1500 + 3500 + 7500 = ~13s. Kept small enough
 * to not stall interactive CLI flows on a genuinely-down gateway.
 */
const DEFAULT_BACKOFFS_MS: ReadonlyArray<number> = [500, 1500, 3500, 7500];

/**
 * Return true iff `err` is a transient aggregator error that should be
 * retried. Mirrors the classifier at `core/connectivity.ts` (kept as a
 * dedicated copy to avoid pulling connectivity.ts into the token-engine
 * bundle; the two classifiers must stay in sync).
 */
function isTransientAggregatorError(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  const msg = err.message;

  // v2 SDK JsonRpc errors surface `Submit failed: {"status":503,...}`.
  // Parse the embedded JSON if present.
  const jsonMatch = /"status":\s*(\d{3})/.exec(msg);
  if (jsonMatch !== null) {
    const status = Number.parseInt(jsonMatch[1]!, 10);
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
    if (status >= 400 && status < 500) return false;
  }

  // Legacy `HTTP 5xx` marker from URL-mode transports.
  const httpMatch = /\bHTTP (\d{3})\b/.exec(msg);
  if (httpMatch !== null) {
    const status = Number.parseInt(httpMatch[1]!, 10);
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
    if (status >= 400 && status < 500) return false;
  }

  const lower = msg.toLowerCase();
  if (
    lower.includes('fetch failed') ||
    lower.includes('network') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ENOTFOUND') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('EAI_AGAIN') ||
    msg.includes('JsonRpcNetworkError') ||
    err.name === 'AbortError' ||
    err.name === 'TimeoutError'
  ) {
    return true;
  }

  // Unknown shape → be lenient. Bounded retry budget caps damage.
  return true;
}

/**
 * Duck-typed proxy that wraps an `AggregatorClient` and retries
 * `submitCertificationRequest` on transient errors.
 *
 * Duck typed rather than `implements IAggregatorClient` because the v2
 * SDK's exported class is what the engine constructor accepts, and
 * TypeScript's structural typing accepts any object with the same
 * method signatures.
 */
export function createRetryingAggregatorClient(
  inner: AggregatorClient,
  opts: { attempts?: number; backoffsMs?: ReadonlyArray<number> } = {},
): AggregatorClient {
  const attempts = opts.attempts ?? DEFAULT_BACKOFFS_MS.length + 1;
  const backoffs = opts.backoffsMs ?? DEFAULT_BACKOFFS_MS;

  const submitCertificationRequest = async (
    certificationData: CertificationData,
  ): Promise<CertificationResponse> => {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await inner.submitCertificationRequest(certificationData);
      } catch (err) {
        lastErr = err;
        if (!isTransientAggregatorError(err)) throw err;
        if (i === attempts - 1) break;
        const delay = backoffs[Math.min(i, backoffs.length - 1)]!;
        logger.warn(
          'TokenEngine',
          `submitCertificationRequest transient error (attempt ${i + 1}/${attempts}); retrying in ${delay}ms: ${
            err instanceof Error ? err.message.slice(0, 200) : String(err)
          }`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastErr;
  };

  // Return a proxy with our wrapped submit + passthroughs for the
  // remaining methods. The v2 SDK's AggregatorClient interface is
  // `submitCertificationRequest`, `getInclusionProof`,
  // `getLatestBlockNumber` — keep the shape identical.
  const wrapped = Object.create(Object.getPrototypeOf(inner)) as AggregatorClient;
  Object.assign(wrapped, inner);
  wrapped.submitCertificationRequest = submitCertificationRequest;
  return wrapped;
}
