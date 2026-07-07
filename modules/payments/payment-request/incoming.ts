/**
 * Incoming payment-request helpers.
 *
 * Extracted from PaymentsModule.ts during Phase 5 (uxfv2-refactor-design.md
 * §2.1 and uxfv2-phase-5-payments-disposition.md §"Payment requests"). Each
 * function operates on an explicit facade-owned list / handler set so state
 * stays on the facade — matching the wave-1 nametag/import-export pattern.
 *
 * Behavior-preserving: pre-check order, message strings, event fan-out
 * ordering, and error-swallowing semantics all match the pre-split methods.
 */

import type { IncomingPaymentRequest as TransportPaymentRequest } from '../../../transport';
import type {
  IncomingPaymentRequest,
  PaymentRequestHandler,
  PaymentRequestStatus,
  TransferResult,
} from '../../../types';
import { logger } from '../../../core/logger';
import { SphereError } from '../../../core/errors';
import { TokenRegistry } from '../../../registry';
import type {
  EmitEventFn,
  IncomingRequestHost,
  PaymentRequestResponsePayload,
  SendFn,
} from './types';

/**
 * Register a handler for incoming payment requests. Returns an unsubscribe
 * function that removes the handler when invoked.
 */
export function registerIncomingHandler(
  handlers: Set<PaymentRequestHandler>,
  handler: PaymentRequestHandler,
): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/**
 * Return the incoming payment request list (optionally filtered by status).
 * Always returns a shallow copy — callers must not observe internal mutations
 * through the returned array. Matches `PaymentsModule.getPaymentRequests`.
 */
export function listIncomingRequests(
  requests: readonly IncomingPaymentRequest[],
  filter?: { status?: PaymentRequestStatus },
): IncomingPaymentRequest[] {
  if (filter?.status) {
    return requests.filter((r) => r.status === filter.status);
  }
  return [...requests];
}

/**
 * Count incoming requests currently in `'pending'` status.
 */
export function countPendingIncomingRequests(
  requests: readonly IncomingPaymentRequest[],
): number {
  return requests.filter((r) => r.status === 'pending').length;
}

/**
 * Remove all non-pending entries from the incoming list. Returns a new array
 * so callers can atomically swap their state reference.
 */
export function filterProcessedIncomingRequests(
  requests: readonly IncomingPaymentRequest[],
): IncomingPaymentRequest[] {
  return requests.filter((r) => r.status === 'pending');
}

/**
 * Remove one incoming request by id. Returns a new array so callers can
 * atomically swap their state reference.
 */
export function removeIncomingRequestById(
  requests: readonly IncomingPaymentRequest[],
  requestId: string,
): IncomingPaymentRequest[] {
  return requests.filter((r) => r.id !== requestId);
}

/**
 * Update a request's local status and emit the corresponding `payment_request:*`
 * event (`accepted` / `rejected` / `paid`). Missing ids are silently ignored
 * to match the pre-extraction facade contract.
 */
export function updateRequestStatus(
  requests: IncomingPaymentRequest[],
  requestId: string,
  status: PaymentRequestStatus,
  emitEvent: EmitEventFn | undefined,
): void {
  const request = requests.find((r) => r.id === requestId);
  if (request) {
    request.status = status;

    // Emit event
    const eventType = `payment_request:${status}` as const;
    if (
      eventType === 'payment_request:accepted' ||
      eventType === 'payment_request:rejected' ||
      eventType === 'payment_request:paid'
    ) {
      emitEvent?.(eventType, request);
    }
  }
}

/**
 * Handle a transport-layer incoming payment request:
 * - Dedup on `id`.
 * - Enrich with registry-resolved symbol.
 * - Prepend to the request list (newest first).
 * - Emit `payment_request:incoming`.
 * - Fan out to registered handlers, swallowing per-handler errors so a
 *   misbehaving subscriber can't wedge the module.
 */
export function handleIncomingPaymentRequest(
  host: IncomingRequestHost,
  transportRequest: TransportPaymentRequest,
): void {
  // Check for duplicates
  if (host.requests.find((r) => r.id === transportRequest.id)) {
    return;
  }

  // Convert transport request to IncomingPaymentRequest
  const coinId = transportRequest.request.coinId;
  const registry = TokenRegistry.getInstance();
  const coinDef = registry.getDefinition(coinId);

  const request: IncomingPaymentRequest = {
    id: transportRequest.id,
    senderPubkey: transportRequest.senderTransportPubkey,
    senderNametag: transportRequest.senderNametag,
    amount: transportRequest.request.amount,
    coinId,
    symbol: coinDef?.symbol || coinId.slice(0, 8),
    message: transportRequest.request.message,
    recipientNametag: transportRequest.request.recipientNametag,
    requestId: transportRequest.request.requestId,
    timestamp: transportRequest.timestamp,
    status: 'pending',
    metadata: transportRequest.request.metadata,
  };

  // Add to list (newest first)
  host.requests.unshift(request);

  // Emit event
  host.emitEvent?.('payment_request:incoming', request);

  // Notify handlers
  for (const handler of host.handlers) {
    try {
      handler(request);
    } catch (error) {
      logger.debug('Payments', 'Payment request handler error:', error);
    }
  }

  logger.debug(
    'Payments',
    `Incoming payment request: ${request.id} for ${request.amount} ${request.symbol}`,
  );
}

/**
 * Send a payment-request response back to the requester.
 *
 * Silently no-ops when the transport does not support the verb (older
 * transports without `sendPaymentRequestResponse`) or when the request id
 * is not found. Errors are logged and swallowed — response-send is
 * best-effort and must not fail the caller's accept/reject/pay flow.
 */
export async function sendResponse(
  host: IncomingRequestHost,
  requestId: string,
  responseType: 'accepted' | 'rejected' | 'paid',
  transferId?: string,
): Promise<void> {
  const request = host.requests.find((r) => r.id === requestId);
  if (!request) return;

  if (!host.transport?.sendPaymentRequestResponse) {
    logger.debug('Payments', 'Transport does not support sendPaymentRequestResponse');
    return;
  }

  try {
    const payload: PaymentRequestResponsePayload = {
      requestId: request.requestId, // Original request ID from sender
      responseType,
      transferId,
    };

    await host.transport.sendPaymentRequestResponse(request.senderPubkey, payload);
    logger.debug(
      'Payments',
      `Sent payment request response: ${responseType} for ${requestId}`,
    );
  } catch (error) {
    logger.debug('Payments', 'Failed to send payment request response:', error);
  }
}

/**
 * Accept a payment request and notify the requester.
 *
 * Marks the request as `'accepted'` and dispatches a response over transport.
 * The caller is responsible for the follow-up `send()` that actually pays.
 */
export async function acceptRequest(
  host: IncomingRequestHost,
  requestId: string,
): Promise<void> {
  updateRequestStatus(host.requests, requestId, 'accepted', host.emitEvent);
  await sendResponse(host, requestId, 'accepted');
}

/**
 * Reject a payment request and notify the requester.
 */
export async function rejectRequest(
  host: IncomingRequestHost,
  requestId: string,
): Promise<void> {
  updateRequestStatus(host.requests, requestId, 'rejected', host.emitEvent);
  await sendResponse(host, requestId, 'rejected');
}

/**
 * Convenience wrapper: mark accepted, invoke `sendFn`, mark paid + fire
 * response with the transfer id. On failure the status is reverted to
 * `'pending'` so the caller can retry. Errors are re-thrown after the revert.
 *
 * Preserves the pre-split contract exactly:
 * - `SphereError` when the request id is unknown or the request status is
 *   neither `'pending'` nor `'accepted'`.
 * - `transferMode: 'instant'` hard-coded on the recursive send (T.7.C —
 *   the public `payPaymentRequest` API does not expose a transferMode knob).
 * - Response send fires with `'paid'` + `result.id` after `send` resolves.
 */
export async function payRequest(
  host: IncomingRequestHost,
  requestId: string,
  memo: string | undefined,
  sendFn: SendFn,
): Promise<TransferResult> {
  const request = host.requests.find((r) => r.id === requestId);
  if (!request) {
    throw new SphereError(`Payment request not found: ${requestId}`, 'VALIDATION_ERROR');
  }

  if (request.status !== 'pending' && request.status !== 'accepted') {
    throw new SphereError(
      `Payment request is not pending or accepted: ${request.status}`,
      'VALIDATION_ERROR',
    );
  }

  // Mark as accepted (don't send response yet, wait for payment)
  updateRequestStatus(host.requests, requestId, 'accepted', host.emitEvent);

  try {
    // Send the payment
    // T.7.C — explicit `transferMode: 'instant'` per §10.1 (production call-site
    // migration). This recursive call into `send()` is the
    // PaymentsModule-internal recursion site listed in the T.7.C task spec
    // (along with the AccountingModule + CLI sites). The outer
    // `payPaymentRequest()` API does not currently expose a transferMode knob
    // to callers, so the wire shape is fixed at `'instant'` (the default for
    // unflagged production today). If `payPaymentRequest()` ever gains a
    // mode parameter, plumb it through here.
    const result = await sendFn({
      coinId: request.coinId,
      amount: request.amount,
      recipient: request.senderPubkey,
      memo: memo || request.message,
      transferMode: 'instant',
    });

    // Mark as paid and send response with transfer ID
    updateRequestStatus(host.requests, requestId, 'paid', host.emitEvent);
    await sendResponse(host, requestId, 'paid', result.id);

    return result;
  } catch (error) {
    // Revert to pending on failure
    updateRequestStatus(host.requests, requestId, 'pending', host.emitEvent);
    throw error;
  }
}
