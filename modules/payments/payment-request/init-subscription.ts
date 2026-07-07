/**
 * Payment-request init-time transport subscription helper.
 *
 * Extracted from PaymentsModule.ts:1692–1704 during Phase 5 (uxfv2-refactor-
 * design.md §2.1 and uxfv2-phase-5-payments-disposition.md §"initialize(deps)"
 * — the two `transport.onPaymentRequest*` subscription blocks).
 *
 * Both `onPaymentRequest` and `onPaymentRequestResponse` are OPTIONAL on the
 * transport interface (older transports don't advertise them). The helper
 * returns `null` in the corresponding unsubscribe slot when the transport
 * doesn't support the event, matching the pre-split behaviour.
 *
 * Behavior-preserving: same subscription order, same optional-chain guards,
 * same fire-and-forget delivery to caller-supplied handlers.
 */

import type {
  IncomingPaymentRequest as TransportPaymentRequest,
  IncomingPaymentRequestResponse as TransportPaymentRequestResponse,
  TransportProvider,
} from '../../../transport';

/**
 * Return value of {@link subscribeToTransportPaymentRequests} — the caller
 * (facade) stores these unsubscribe references so `initialize()` re-run and
 * `destroy()` can tear them down.
 */
export interface PaymentRequestSubscriptions {
  /** Unsubscribe from incoming payment requests. `null` when unsupported. */
  readonly unsubscribeRequests: (() => void) | null;
  /** Unsubscribe from payment-request responses. `null` when unsupported. */
  readonly unsubscribeResponses: (() => void) | null;
}

/**
 * Wire the facade's incoming/outgoing handlers onto the transport's
 * `onPaymentRequest*` seams. Returns the unsubscribe pair for the facade
 * to persist and later invoke on teardown.
 */
export function subscribeToTransportPaymentRequests(
  transport: TransportProvider,
  onIncoming: (request: TransportPaymentRequest) => void,
  onResponse: (response: TransportPaymentRequestResponse) => void,
): PaymentRequestSubscriptions {
  let unsubscribeRequests: (() => void) | null = null;
  let unsubscribeResponses: (() => void) | null = null;

  // Subscribe to incoming payment requests (if supported)
  if (transport.onPaymentRequest) {
    unsubscribeRequests = transport.onPaymentRequest((request) => {
      onIncoming(request);
    });
  }

  // Subscribe to payment request responses (if supported)
  if (transport.onPaymentRequestResponse) {
    unsubscribeResponses = transport.onPaymentRequestResponse((response) => {
      onResponse(response);
    });
  }

  return { unsubscribeRequests, unsubscribeResponses };
}
