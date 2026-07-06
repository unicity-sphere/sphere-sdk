/**
 * profile/http-block-broker.ts — issue #266
 *
 * A custom Helia `BlockBroker` that fetches missing blocks from an
 * operator-controlled Kubo gateway over plain HTTP. Used in
 * `httpOnlyIpfs: true` mode so the client wallet does NOT have to
 * join the global IPFS DHT, dial 80+ libp2p peers on port 4001, or
 * walk public trustless gateways like `trustless-gateway.link` that
 * do not host our wallet data.
 *
 * Recovery contract:
 *   1. Local memory blockstore (Helia's MemoryBlockstore default, or
 *      FsBlockstore if a `directory` is set) is the first read.
 *   2. On miss, Helia consults its `blockBrokers`. The HTTP broker
 *      below issues a `POST /api/v0/block/get?arg=<cid>` against each
 *      configured gateway (in race order) and returns the first
 *      successful response.
 *   3. The fetched bytes are then cached back into the local
 *      blockstore by Helia's `NetworkedStorage`, so subsequent reads
 *      in the same process hit the local store.
 *
 * Pushing blocks the OTHER way (write → operator Kubo) is the
 * flush-scheduler's job (`profile/ipfs-client.ts: pinCarBlocksToIpfs`).
 * The broker's `announce` is intentionally a no-op — the SDK's pin
 * path already handles durable pinning with retries.
 *
 * Security note: this broker trusts the operator Kubo to return
 * correct bytes for a CID. Helia's `NetworkedStorage` re-hashes the
 * response and rejects bytes whose hash doesn't match the requested
 * CID, so a misbehaving / compromised gateway can DoS but cannot
 * forge data — same security model as the `profile/ipfs-client.ts`
 * fetch path.
 */

import type { BlockBroker } from '@helia/interface';
import type { CID } from 'multiformats/cid';

/**
 * Configuration for the HTTP block broker.
 */
export interface HttpBlockBrokerConfig {
  /**
   * Ordered list of Kubo HTTP gateway base URLs (e.g.
   * `https://ipfs-gateway.unicity.network`). The broker races them
   * via `Promise.any` so the fastest responsive gateway wins.
   */
  readonly gateways: ReadonlyArray<string>;
  /**
   * Per-request timeout in milliseconds. Each gateway gets its own
   * AbortController set to this deadline. Default: 10s — short
   * enough to fail fast on dead operator Kubo nodes, long enough to
   * cover a healthy fetch.
   */
  readonly fetchTimeoutMs?: number;
}

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/**
 * Strip a trailing slash from a base URL so concatenation with
 * `/api/v0/...` does not produce `//` paths that some reverse
 * proxies reject.
 */
function normalizeGateway(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Build a Helia `BlockBroker` that fetches blocks via Kubo's HTTP
 * `/api/v0/block/get` endpoint.
 *
 * Returns a factory function compatible with Helia's `blockBrokers`
 * init option (each broker entry is a `(components) => BlockBroker`).
 * The factory ignores the `components` argument — the HTTP broker
 * has no libp2p / blockstore dependencies.
 */
export function createHttpBlockBroker(
  config: HttpBlockBrokerConfig,
): () => BlockBroker {
  const fetchTimeoutMs = config.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const gateways = config.gateways.map(normalizeGateway);

  return (): BlockBroker => ({
    name: 'sphere-http-kubo-broker',

    async retrieve(cid: CID, options?: { signal?: AbortSignal }): Promise<Uint8Array> {
      if (gateways.length === 0) {
        // Defensive — orbitdb-adapter only installs this broker when
        // gateways.length > 0, but a future caller might use it raw.
        throw new Error('sphere-http-kubo-broker: no gateways configured');
      }

      const cidString = cid.toString();

      // Race all gateways via Promise.any — first success wins, all
      // failures aggregate into a single AggregateError that Helia
      // surfaces back to the calling blockstore. Each request honors
      // both the per-broker timeout and the caller's abort signal
      // (e.g. when the outer get() is cancelled by a session close).
      const attempts = gateways.map(async (gateway): Promise<Uint8Array> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);

        // Chain the caller's signal to ours so the operator can
        // abort the whole NetworkedStorage.get() and we cancel the
        // in-flight fetch immediately rather than waiting for the
        // 10s timeout to fire.
        const onCallerAbort = (): void => controller.abort();
        if (options?.signal) {
          if (options.signal.aborted) controller.abort();
          else options.signal.addEventListener('abort', onCallerAbort);
        }

        try {
          const url = `${gateway}/api/v0/block/get?arg=${encodeURIComponent(cidString)}`;
          const response = await fetch(url, { method: 'POST', signal: controller.signal });
          if (!response.ok) {
            throw new Error(
              `HTTP ${response.status} ${response.statusText} from ${gateway} for CID ${cidString}`,
            );
          }
          const arrayBuf = await response.arrayBuffer();
          return new Uint8Array(arrayBuf);
        } finally {
          clearTimeout(timer);
          if (options?.signal) options.signal.removeEventListener('abort', onCallerAbort);
        }
      });

      return await Promise.any(attempts);
    },

    // `announce` is a no-op — pin durability is handled separately
    // by the flush-scheduler in profile/ipfs-client.ts.
  });
}
