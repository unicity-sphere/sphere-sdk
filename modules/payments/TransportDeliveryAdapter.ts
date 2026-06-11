/**
 * TransportDeliveryAdapter — the legacy-transport seam adapter (sdk-changes S3).
 *
 * S3 made the send path a refactor ONTO the `DeliveryProvider` port; this
 * adapter is what the port resolves to when no delivery provider is composed
 * (the pre-wallet-api default: assets ride the Nostr relay as `V2_TRANSFER`
 * payloads). It exists so `PaymentsModule` has exactly ONE delivery seam —
 * swapping in `WalletApiMailboxProvider` (or any future transport) requires
 * no change in the module (covenant §3.1-6).
 *
 * Scope notes (deliberate, documented asymmetries with the full port):
 * - `deliver()` addresses the recipient by CHAIN pubkey (the port semantic)
 *   and resolves it to the peer's published transport pubkey via
 *   `transport.resolve` (falling back to the x-only form — the single
 *   identity model derives the transport key from the same secp256k1 pair).
 * - Relay delivery is not server-side idempotent the way the mailbox is; the
 *   (token, state) idempotency the port requires is provided by the
 *   RECEIVER's genesis-stable-tokenId dedup in `handleV2Transfer`, which has
 *   always been the relay path's replay guard.
 * - `incoming()` yields nothing and `ack()` is a no-op: with no injected
 *   delivery provider, incoming assets keep flowing through the transport's
 *   push subscription (`onTokenTransfer`) exactly as before — this adapter is
 *   the SEND seam, not a full mailbox. The S7 contract suite runs against
 *   real implementations, not this adapter.
 */

import type {
  DeliverOptions,
  DeliveryProvider,
  DeliveryReceipt,
  IncomingDelivery,
} from '../../transport/delivery-provider';
import { composeDeliveryKeys } from '../../transport/delivery-provider';
import type { TokenTransferPayload, TransportProvider } from '../../transport';
import { bytesToHex } from '../../core/crypto';

export class TransportDeliveryAdapter implements DeliveryProvider {
  /** No server inventory exists on this rail — custody is always the app's. */
  readonly custody = 'external' as const;

  constructor(
    private readonly transport: TransportProvider,
    /** `ITokenEngine.deliveryKeys`, bound — the backend-true derivation. */
    private readonly deliveryKeys: (blobBytes: Uint8Array) => Promise<{ tokenId: string; stateHash: string }>,
  ) {}

  async deliver(recipientPubkey: string, blob: Uint8Array, options: DeliverOptions): Promise<DeliveryReceipt> {
    const keys = composeDeliveryKeys(await this.deliveryKeys(blob));
    const target = await this.resolveTransportTarget(recipientPubkey);
    await this.transport.sendTokenTransfer(target, {
      type: 'V2_TRANSFER',
      version: '2.0',
      tokenBlob: bytesToHex(blob),
      memo: options.memo,
    } as unknown as TokenTransferPayload);
    return { deliveryId: keys.deliveryId };
  }

  /** Chain pubkey → the peer's published transport pubkey (binding-first). */
  private async resolveTransportTarget(recipientPubkey: string): Promise<string> {
    try {
      const peer = await this.transport.resolve?.(recipientPubkey);
      if (peer?.transportPubkey) return peer.transportPubkey;
    } catch {
      // fall through to the structural derivation below
    }
    // 33-byte compressed chain pubkey → x-only transport pubkey (single
    // identity model: both keys come from the same secp256k1 pair).
    if (recipientPubkey.length === 66 && /^0[23]/i.test(recipientPubkey)) {
      return recipientPubkey.slice(2);
    }
    return recipientPubkey;
  }

  // eslint-disable-next-line require-yield
  async *incoming(): AsyncIterable<IncomingDelivery> {
    // Incoming stays on the transport's push subscription (see module doc).
    return;
  }

  async ack(): Promise<void> {
    // No claim/reject exists on the relay rail.
  }
}
