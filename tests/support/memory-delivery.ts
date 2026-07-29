/**
 * Minimal in-memory DeliveryProvider for tests that only need send() to have a
 * rail — the Nostr fallback that used to stand in for one is gone.
 *
 * Records what was delivered so a test can assert the wire payload, and serves
 * nothing incoming. Tests that exercise the incoming feed should use a provider
 * that models the mailbox (see PaymentsModule.receive-fresh-pump.test.ts) or the
 * wallet-api provider itself.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type {
  DeliverOptions,
  DeliveryCustody,
  DeliveryDisposition,
  DeliveryProvider,
  DeliveryReceipt,
  IncomingDelivery,
} from '../../transport/delivery-provider';

export interface RecordedDelivery {
  readonly recipientPubkey: string;
  readonly blob: Uint8Array;
  readonly options: DeliverOptions;
}

export class MemoryDeliveryProvider implements DeliveryProvider {
  readonly delivered: RecordedDelivery[] = [];
  readonly acked: Array<{ deliveryId: string; disposition: DeliveryDisposition }> = [];
  private failures: Error[] = [];

  constructor(readonly custody: DeliveryCustody = 'external') {}

  /** Fail the next `deliver()` call — models a rail outage after certification. */
  failNext(error: Error = new Error('delivery rail down')): this {
    this.failures.push(error);
    return this;
  }

  /** Hex of the most recently delivered blob, for wire assertions. */
  lastBlobHex(): string | undefined {
    const last = this.delivered.at(-1);
    return last && bytesToHex(last.blob);
  }

  setIdentity(): void {}
  bindDeliveryKeys(): void {}

  async deliver(
    recipientPubkey: string,
    blob: Uint8Array,
    options: DeliverOptions,
  ): Promise<DeliveryReceipt> {
    const failure = this.failures.shift();
    if (failure) throw failure;
    this.delivered.push({ recipientPubkey, blob, options });
    return { deliveryId: bytesToHex(sha256(blob)) };
  }

  async ack(deliveryId: string, disposition: DeliveryDisposition): Promise<void> {
    this.acked.push({ deliveryId, disposition });
  }

  async *incoming(): AsyncGenerator<IncomingDelivery> {
    // no incoming feed
  }
}

export function createMemoryDelivery(custody: DeliveryCustody = 'external'): MemoryDeliveryProvider {
  return new MemoryDeliveryProvider(custody);
}
