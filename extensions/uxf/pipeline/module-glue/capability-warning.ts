/**
 * Capability warning — Phase 5 [B] extraction from PaymentsModule.ts.
 *
 * Emits `transfer:capability-warning` when the resolved peer's
 * `assetKinds` / `wireProtocols` advertisement disagrees with what
 * this send is about to put on the wire. Extension-bound because the
 * capability hint set is a UXF v1.0-and-later concern (older peers
 * pre-date NFTs and multi-wire-protocol negotiation).
 *
 * See uxfv2-phase-5-payments-disposition.md §"Recipient/transport
 * resolution + capability warnings" for the disposition entry.
 */

import type { SphereEventType, SphereEventMap, TransferRequest } from '../../../../types';
import type { PeerInfo, TransportProvider } from '../../../../transport';
import { DEFAULT_ASSET_KINDS_WHEN_ABSENT } from '../../../../transport/transport-provider';

/**
 * Host shim for the capability-warning emitter. Owns:
 *   - `transport` — nullable; the check is skipped when absent or when
 *     the transport does not implement `resolve`;
 *   - `emitEvent` — the facade's SphereEvent bus fan-out;
 *   - `computeOutboundAssetKinds` / `resolveOutboundWireProtocol` —
 *     private helpers that survive on the facade
 *     (`modules/payments/send/asset-kind.ts` per the ledger).
 */
export interface CapabilityWarningHost {
  readonly transport: TransportProvider | undefined;
  emitEvent<T extends SphereEventType>(type: T, data: SphereEventMap[T]): void;
  computeOutboundAssetKinds(request: TransferRequest): ReadonlyArray<string>;
  resolveOutboundWireProtocol(mode: 'instant' | 'conservative' | 'txf'): string;
}

/**
 * Emit `transfer:capability-warning` when the resolved peer's
 * capability hints disagree with what we're about to put on the wire.
 *
 * Failure modes (all silent — capability hints are best-effort):
 *  - Resolve returns null (unknown peer): skip the check entirely.
 *  - Both `wireProtocols` and `assetKinds` absent: skip emission unless
 *    an outbound asset kind is OUTSIDE the W20 default `['coin']`.
 *  - Resolve throws: caller logs and continues (see `send()`).
 */
export async function maybeEmitCapabilityWarning(
  host: CapabilityWarningHost,
  request: TransferRequest,
  mode: 'instant' | 'conservative' | 'txf',
): Promise<void> {
  const transport = host.transport;
  if (!transport?.resolve) return;

  let peerInfo: PeerInfo | null;
  try {
    peerInfo = (await transport.resolve(request.recipient)) ?? null;
  } catch {
    // Resolve failures aren't capability concerns — let the dispatcher
    // surface its own typed error.
    return;
  }
  if (!peerInfo) return;

  const outboundAssetKinds = host.computeOutboundAssetKinds(request);
  const outboundWireProtocol = host.resolveOutboundWireProtocol(mode);

  // W20: assetKinds absent on the wire ⇒ assume ['coin']. We preserve
  // the empty-array case (peer present but explicitly empty) as-is so
  // diagnostics distinguish "older peer" from "explicitly empty".
  const recipientAssetKinds: ReadonlyArray<string> = peerInfo.assetKinds
    ?? DEFAULT_ASSET_KINDS_WHEN_ABSENT;
  const recipientWireProtocols = peerInfo.wireProtocols;

  const advertisedKinds = new Set(recipientAssetKinds);
  const mismatchedAssetKinds = outboundAssetKinds.filter((k) => !advertisedKinds.has(k));

  // wireProtocolMismatch fires only when hints were PRESENT and the
  // outbound protocol is not in the set. Absent hints make NO claim.
  let wireProtocolMismatch = false;
  if (recipientWireProtocols !== undefined) {
    const advertisedWP = new Set(recipientWireProtocols);
    wireProtocolMismatch = !advertisedWP.has(outboundWireProtocol);
  }

  if (mismatchedAssetKinds.length === 0 && !wireProtocolMismatch) {
    return; // Everything advertised — nothing to warn about.
  }

  host.emitEvent('transfer:capability-warning', {
    recipientTransportPubkey: peerInfo.transportPubkey,
    recipientAssetKinds,
    recipientWireProtocols,
    outboundAssetKinds,
    outboundWireProtocol,
    mismatchedAssetKinds,
    wireProtocolMismatch,
  });
}
