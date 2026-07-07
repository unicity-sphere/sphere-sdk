# modules/payments/payment-request/ — Payment Request Submodule

Per uxfv2-refactor-design.md §2.1 and uxfv2-phase-5-payments-disposition.md.

**Concern:** Inbound payment request store + accept/reject/pay verbs. Outbound
payment requests + response waiters. Post-Phase-7 also holds the wallet-api
REST payment-request cursors.

## Status — Phase 5 wave-2 landed

All rows below have moved from `PaymentsModule.ts` into this submodule. The
facade retains public method signatures and owns the underlying state (list,
maps, sets, resolver map, unsubscribe slots); each public method delegates to
the corresponding helper here via a small `IncomingRequestHost` /
`OutgoingRequestHost` shim built per-call.

## Files

| File | Contents |
|---|---|
| `types.ts` | Host-shim types (`IncomingRequestHost`, `OutgoingRequestHost`, `SendPaymentRequestHost`, `PendingResponseResolver`, `EmitEventFn`, `SendFn`). |
| `incoming.ts` | Incoming-side helpers — handler registration, list getters, status update, transport-request handling, `sendResponse` (private), accept/reject/pay verbs. |
| `outgoing.ts` | Outgoing-side helpers — response handler registration, list/cancel/remove/clear verbs, `waitForResponse`, `handleResponse`, `sendPaymentRequestImpl`. |
| `init-subscription.ts` | `subscribeToTransportPaymentRequests(...)` — attaches to `transport.onPaymentRequest` / `onPaymentRequestResponse` and returns the unsubscribe pair (both slots may be `null` for older transports). |
| `index.ts` | Barrel re-exports. |

## Public methods delegated by the facade

Inbound (`incoming.ts`):

| Facade method | Delegate helper |
|---|---|
| `onPaymentRequest` | `registerIncomingHandler(handlers, handler)` |
| `getPaymentRequests` | `listIncomingRequests(requests, filter?)` |
| `getPendingPaymentRequestsCount` | `countPendingIncomingRequests(requests)` |
| `acceptPaymentRequest` | `acceptRequest(host, id)` |
| `rejectPaymentRequest` | `rejectRequest(host, id)` |
| `markPaymentRequestPaid` | `updateRequestStatus(requests, id, 'paid', emitEvent)` |
| `clearProcessedPaymentRequests` | `filterProcessedIncomingRequests(requests)` |
| `removePaymentRequest` | `removeIncomingRequestById(requests, id)` |
| `payPaymentRequest` | `payRequest(host, id, memo?, sendFn)` |

Outbound (`outgoing.ts`):

| Facade method | Delegate helper |
|---|---|
| `sendPaymentRequest` | `sendPaymentRequestImpl(host, map, recipient, request)` |
| `getOutgoingPaymentRequests` | `listOutgoingRequests(map, filter?)` |
| `onPaymentRequestResponse` | `registerResponseHandler(handlers, handler)` |
| `waitForPaymentResponse` | `waitForResponse(host, id, timeoutMs)` |
| `cancelWaitForPaymentResponse` | `cancelWaitForResponse(resolvers, id)` |
| `removeOutgoingPaymentRequest` | `removeOutgoingRequest(host, id)` |
| `clearCompletedOutgoingPaymentRequests` | `clearCompletedOutgoingRequests(map)` |

## Private methods folded into the submodule

The following facade privates were **removed** — their bodies now live only
in the submodule and callers route through the public verbs above:

- `updatePaymentRequestStatus` → `incoming.updateRequestStatus`
- `handleIncomingPaymentRequest` → `incoming.handleIncomingPaymentRequest`
- `handlePaymentRequestResponse` → `outgoing.handleResponse`
- `sendPaymentRequestResponse` → `incoming.sendResponse`

## Init-time subscription

`subscribeToTransportPaymentRequests(transport, onIncoming, onResponse)` is
called from `PaymentsModule.initialize()`. It returns
`{ unsubscribeRequests, unsubscribeResponses }` (either may be `null` when
the transport doesn't advertise the corresponding event seam), which the
facade stores on its own `unsubscribePaymentRequests` /
`unsubscribePaymentRequestResponses` fields for teardown.

## Instance state (retained on facade)

The extraction uses a **host-shim** pattern (matching the wave-1 nametag /
import-export split): state stays on the facade so `initialize()`,
`destroy()`, and per-address reset paths continue to observe it directly.

- `paymentRequests: IncomingPaymentRequest[]`
- `paymentRequestHandlers: Set<PaymentRequestHandler>`
- `outgoingPaymentRequests: Map<string, OutgoingPaymentRequest>`
- `paymentRequestResponseHandlers: Set<PaymentRequestResponseHandler>`
- `pendingResponseResolvers: Map<string, PendingResponseResolver>`
- `unsubscribePaymentRequests: (() => void) | null`
- `unsubscribePaymentRequestResponses: (() => void) | null`
