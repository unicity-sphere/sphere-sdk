# modules/payments/payment-request/ — Payment Request Submodule

Per uxfv2-refactor-design.md §2.1 and uxfv2-phase-5-payments-disposition.md.

**Concern:** Inbound payment request store + accept/reject/pay verbs.
Outbound payment requests + response waiters. Post-Phase-7 also holds the
wallet-api REST payment-request cursors.

**Public methods this submodule owns:**

Inbound (`incoming.ts`):

| Method | Currently at |
|---|---|
| `onPaymentRequest` | PaymentsModule.ts:7680 |
| `getPaymentRequests` | PaymentsModule.ts:7689 |
| `getPendingPaymentRequestsCount` | PaymentsModule.ts:7701 |
| `acceptPaymentRequest` | PaymentsModule.ts:7713 |
| `rejectPaymentRequest` | PaymentsModule.ts:7723 |
| `markPaymentRequestPaid` | PaymentsModule.ts:7736 |
| `clearProcessedPaymentRequests` | PaymentsModule.ts:7745 |
| `removePaymentRequest` | PaymentsModule.ts:7754 |
| `payPaymentRequest` | PaymentsModule.ts:7762 |
| `updatePaymentRequestStatus` | PaymentsModule.ts:7805 |
| `handleIncomingPaymentRequest` | PaymentsModule.ts:7820 |

Outbound (`outgoing.ts`):

| Method | Currently at |
|---|---|
| `sendPaymentRequest` | PaymentsModule.ts:7611 |
| `getOutgoingPaymentRequests` | PaymentsModule.ts:7872 |
| `onPaymentRequestResponse` | PaymentsModule.ts:7885 |
| `waitForPaymentResponse` | PaymentsModule.ts:7896 |
| `cancelWaitForPaymentResponse` | PaymentsModule.ts:7930 |
| `removeOutgoingPaymentRequest` | PaymentsModule.ts:7944 |
| `clearCompletedOutgoingPaymentRequests` | PaymentsModule.ts:7952 |
| `handlePaymentRequestResponse` | PaymentsModule.ts:7960 |
| `sendPaymentRequestResponse` | PaymentsModule.ts:8020 |

Init-time subscription (`init-subscription.ts`):

| Sub-block | Currently at |
|---|---|
| `transport.onPaymentRequest` subscription | PaymentsModule.ts:1998–2025 |
| `transport.onPaymentRequestResponse` subscription | PaymentsModule.ts:2025–2225 |

**Instance state this submodule owns:**

- `paymentRequests` (Map) → `incoming.ts`
- `paymentRequestHandlers` (Set) → `incoming.ts`
- `outgoingPaymentRequests` (Map) → `outgoing.ts`
- `paymentRequestResponseHandlers` (Set) → `outgoing.ts`
- `pendingResponseResolvers` (Map with timeouts) → `outgoing.ts`
- `unsubscribePaymentRequests` (function) → `init-subscription.ts`
- `unsubscribePaymentRequestResponses` (function) → `init-subscription.ts`
