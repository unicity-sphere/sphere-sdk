/**
 * `core/sphere-connectivity.ts` — build the per-wallet {@link ConnectivityManager}.
 *
 * Extracted from `core/Sphere.ts` in wave 6-P2-8e (final micro-wave of the
 * Sphere.ts slim series). Sphere.ts's `buildConnectivityManager` delegator
 * calls `buildConnectivityManagerImpl(host)` — same public shape as before,
 * behavior verbatim.
 *
 * Pattern reference: see the wave 6-P2-8 sibling extractions
 * (`sphere-wallet-io.ts`, `sphere-modules-init.ts`) — host-shim interface
 * + free-function impl + facade delegator via `this as unknown as Host`.
 */

import {
  AggregatorPinger,
  ConnectivityManager,
  IpfsPinger,
  NostrPinger,
  type Pinger,
} from './connectivity';
import type { OracleProvider } from '../oracle/oracle-provider';
import type { TransportProvider } from '../transport/transport-provider';
import type { SphereEventMap, SphereEventType } from '../types';

/**
 * The Sphere-owned fields + emit method the connectivity builder reads.
 * All fields are `readonly` — the builder does not mutate host state.
 */
export interface ConnectivityBuilderHost {
  readonly _oracle: OracleProvider;
  readonly _transport: TransportProvider;
  readonly _cidFetchGateways: ReadonlyArray<string> | null;
  emitEvent<T extends SphereEventType>(type: T, data: SphereEventMap[T]): void;
}

/**
 * Issue #312 — build the per-wallet ConnectivityManager.
 *
 * Pingers wired:
 *   - `aggregator`: probes `oracle.getCurrentRound()` (cheap JSON-RPC).
 *   - `ipfs`: HEAD-probes the configured gateways (skipped when no
 *      gateways are wired — wallet stays "fully online" w.r.t. IPFS).
 *   - `nostr`: reads `transport.isConnected()` (the transport owns its
 *      reconnect loop; we don't open a parallel subscription).
 *
 * Returns a freshly-built manager; the caller is responsible for
 * `.start()` and `.stop()`.
 */
export function buildConnectivityManagerImpl(
  host: ConnectivityBuilderHost,
): ConnectivityManager {
  const emitEvent = host.emitEvent.bind(host);

  const aggregatorPinger = new AggregatorPinger({
    provider: {
      getCurrentRound: () => host._oracle.getCurrentRound(),
    },
  });

  // IPFS gateways are wired only when the host app's provider factory
  // populated `_cidFetchGateways` (the wallet has IPFS sync configured).
  // Without gateways we skip the IPFS pinger entirely so the
  // "no-IPFS" wallet is not stuck in permanent offline-degraded.
  const ipfsGateways = host._cidFetchGateways ?? [];
  const pingers: Pinger[] = [aggregatorPinger];
  if (ipfsGateways.length > 0) {
    pingers.push(new IpfsPinger(ipfsGateways));
  }
  pingers.push(
    new NostrPinger(() => {
      try {
        return host._transport.isConnected();
      } catch {
        return false;
      }
    }),
  );

  return new ConnectivityManager(pingers, {
    emitEvent: (type, payload) => {
      // Forward to the Sphere event bus — types narrow correctly via
      // SphereEventMap.
      emitEvent(
        type as SphereEventType,
        payload as SphereEventMap[SphereEventType],
      );
    },
  });
}
