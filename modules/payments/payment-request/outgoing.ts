/**
 * Outgoing payment-request helpers.
 *
 * Extracted from PaymentsModule.ts during Phase 5 (uxfv2-refactor-design.md
 * §2.1 and uxfv2-phase-5-payments-disposition.md §"Payment requests"). Each
 * function operates on an explicit host shim that bundles the facade-owned
 * outgoing map + response handler set + pending-response resolver map. The
 * facade retains ownership of the underlying state and simply delegates the
 * logic here.
 *
 * Behavior-preserving: crypto.randomUUID id generation, transport gating,
 * timeout handling, response matching (by eventId OR requestId), status
 * mapping, event fan-out, and error swallow rules all match the pre-split
 * methods verbatim.
 */

import type {
  IncomingPaymentRequestResponse as TransportPaymentRequestResponse,
} from '../../../transport';
import type {
  OutgoingPaymentRequest,
  PaymentRequest,
  PaymentRequestResponse,
  PaymentRequestResponseHandler,
  PaymentRequestResult,
  PaymentRequestStatus,
} from '../../../types';
import { logger } from '../../../core/logger';
import type {
  OutgoingRequestHost,
  PaymentRequestPayload,
  SendPaymentRequestHost,
} from './types';

/**
 * Register a handler for outgoing-response events. Returns an unsubscribe
 * function that removes the handler when invoked.
 */
export function registerResponseHandler(
  handlers: Set<PaymentRequestResponseHandler>,
  handler: PaymentRequestResponseHandler,
): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/**
 * Return outgoing requests as an array (optionally filtered by status).
 * Matches `PaymentsModule.getOutgoingPaymentRequests`.
 */
export function listOutgoingRequests(
  requests: ReadonlyMap<string, OutgoingPaymentRequest>,
  filter?: { status?: PaymentRequestStatus },
): OutgoingPaymentRequest[] {
  const arr = Array.from(requests.values());
  if (filter?.status) {
    return arr.filter((r) => r.status === filter.status);
  }
  return arr;
}

/**
 * Cancel any pending `waitForPaymentResponse` promise for the given request
 * id. The pending promise is rejected with `'Cancelled'`. Silently no-ops
 * when no resolver is registered.
 */
export function cancelWaitForResponse(
  resolvers: Map<
    string,
    {
      resolve: (response: PaymentRequestResponse) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >,
  requestId: string,
): void {
  const resolver = resolvers.get(requestId);
  if (resolver) {
    clearTimeout(resolver.timeout);
    resolver.reject(new Error('Cancelled'));
    resolvers.delete(requestId);
  }
}

/**
 * Remove an outgoing request and cancel any pending wait resolver.
 */
export function removeOutgoingRequest(
  host: OutgoingRequestHost,
  requestId: string,
): void {
  host.requests.delete(requestId);
  cancelWaitForResponse(host.resolvers, requestId);
}

/**
 * Remove all outgoing requests whose status is terminal
 * (`'paid'`, `'rejected'`, or `'expired'`). Mutates the map in-place — the
 * facade holds a stable reference so callers won't observe stale entries.
 */
export function clearCompletedOutgoingRequests(
  requests: Map<string, OutgoingPaymentRequest>,
): void {
  for (const [id, request] of requests) {
    if (
      request.status === 'paid' ||
      request.status === 'rejected' ||
      request.status === 'expired'
    ) {
      requests.delete(id);
    }
  }
}

/**
 * Build a Promise that resolves when a response for `requestId` arrives (or
 * rejects on timeout). If the outgoing request already has a `response`
 * attached (racy delivery), returns the stored response immediately.
 *
 * Timeout behavior:
 * - Clears the resolver from the map.
 * - Flips the outgoing request's status to `'expired'` (only if still
 *   `'pending'` — preserves any status set by an in-flight response arrival).
 * - Rejects with a `Timeout` error.
 */
export function waitForResponse(
  host: OutgoingRequestHost,
  requestId: string,
  timeoutMs: number,
): Promise<PaymentRequestResponse> {
  const outgoing = host.requests.get(requestId);
  if (!outgoing) {
    return Promise.reject(new Error(`Outgoing payment request not found: ${requestId}`));
  }

  // If already has a response, return it
  if (outgoing.response) {
    return Promise.resolve(outgoing.response);
  }

  // Create a promise that resolves when response arrives or times out
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      host.resolvers.delete(requestId);
      // Update status to expired
      const request = host.requests.get(requestId);
      if (request && request.status === 'pending') {
        request.status = 'expired';
      }
      reject(new Error(`Payment request response timeout: ${requestId}`));
    }, timeoutMs);

    host.resolvers.set(requestId, { resolve, reject, timeout });
  });
}

/**
 * Handle a transport-layer payment-request response:
 * - Find the outgoing entry whose `eventId` OR `id` matches the response's
 *   `requestId` (the sender-side `eventId` is what the recipient echoed).
 * - Build the SDK-level `PaymentRequestResponse`.
 * - Update the outgoing entry's status + attach the response.
 * - Resolve any live `waitForPaymentResponse` promise.
 * - Emit `payment_request:response`.
 * - Fan out to registered handlers, swallowing per-handler errors.
 *
 * Unmatched responses still fire the event and handlers (matches the
 * pre-split behaviour — subscribers may want to observe orphan responses).
 */
export function handleResponse(
  host: OutgoingRequestHost,
  transportResponse: TransportPaymentRequestResponse,
): void {
  // Find the outgoing request by matching requestId
  let outgoingRequest: OutgoingPaymentRequest | undefined;
  let outgoingRequestId: string | undefined;

  for (const [id, request] of host.requests) {
    // Match by eventId or requestId from the response
    if (
      request.eventId === transportResponse.response.requestId ||
      request.id === transportResponse.response.requestId
    ) {
      outgoingRequest = request;
      outgoingRequestId = id;
      break;
    }
  }

  // Convert transport response to PaymentRequestResponse
  const response: PaymentRequestResponse = {
    id: transportResponse.id,
    responderPubkey: transportResponse.responderTransportPubkey,
    requestId: transportResponse.response.requestId,
    responseType: transportResponse.response.responseType,
    message: transportResponse.response.message,
    transferId: transportResponse.response.transferId,
    timestamp: transportResponse.timestamp,
  };

  // Update outgoing request if found
  if (outgoingRequest && outgoingRequestId) {
    outgoingRequest.status =
      response.responseType === 'paid'
        ? 'paid'
        : response.responseType === 'accepted'
          ? 'accepted'
          : 'rejected';
    outgoingRequest.response = response;

    // Resolve pending promise if any
    const resolver = host.resolvers.get(outgoingRequestId);
    if (resolver) {
      clearTimeout(resolver.timeout);
      resolver.resolve(response);
      host.resolvers.delete(outgoingRequestId);
    }
  }

  // Emit event
  host.emitEvent?.('payment_request:response', response);

  // Notify handlers
  for (const handler of host.handlers) {
    try {
      handler(response);
    } catch (error) {
      logger.debug('Payments', 'Payment request response handler error:', error);
    }
  }

  logger.debug(
    'Payments',
    `Received payment request response: ${response.id} type: ${response.responseType}`,
  );
}

/**
 * Send a payment request to the given recipient and record an outgoing entry.
 *
 * Behavior:
 * - Resolves the recipient (nametag / DIRECT / raw pubkey) via the host's
 *   resolver.
 * - Delegates the transport `sendPaymentRequest` call; the caller has
 *   already gated on transport support.
 * - Mints a local UUID for the outgoing entry so callers can wait on it via
 *   `waitForPaymentResponse(requestId)` without depending on the transport's
 *   `eventId` shape.
 * - Preserves the pre-split return contract: `{ success: false, error }` on
 *   failure rather than throwing.
 *
 * Caller responsibility: return `{ success: false, error: 'Transport ...' }`
 * WHEN `transport.sendPaymentRequest` is undefined — this helper assumes the
 * gate has already been checked so the transport signature stays narrow.
 */
export async function sendPaymentRequestImpl(
  host: SendPaymentRequestHost,
  outgoingRequests: Map<string, OutgoingPaymentRequest>,
  recipientPubkeyOrNametag: string,
  request: Omit<PaymentRequest, 'id' | 'createdAt'>,
): Promise<PaymentRequestResult> {
  try {
    // Resolve recipient
    const peerInfo = (await host.transport.resolve?.(recipientPubkeyOrNametag)) ?? null;
    const recipientPubkey = host.resolveTransportPubkey(recipientPubkeyOrNametag, peerInfo);

    // Build payload
    const payload: PaymentRequestPayload = {
      amount: request.amount,
      coinId: request.coinId,
      message: request.message,
      recipientNametag: request.recipientNametag,
      metadata: request.metadata,
    };

    // Send via transport
    // Non-null assertion here: caller has gated on transport support.
    const eventId = await host.transport.sendPaymentRequest!(recipientPubkey, payload);
    const requestId = crypto.randomUUID();

    // Track outgoing request
    const outgoingRequest: OutgoingPaymentRequest = {
      id: requestId,
      eventId,
      recipientPubkey,
      recipientNametag: recipientPubkeyOrNametag.startsWith('@')
        ? recipientPubkeyOrNametag.slice(1)
        : undefined,
      amount: request.amount,
      coinId: request.coinId,
      message: request.message,
      createdAt: Date.now(),
      status: 'pending',
    };
    outgoingRequests.set(requestId, outgoingRequest);

    logger.debug('Payments', `Payment request sent: ${eventId}`);

    return {
      success: true,
      requestId,
      eventId,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.debug('Payments', `Failed to send payment request: ${errorMsg}`);
    return {
      success: false,
      error: errorMsg,
    };
  }
}
