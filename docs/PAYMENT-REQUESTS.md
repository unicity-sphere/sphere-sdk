# Payment requests

Ask another user to pay you, and track whether they did. A payment request is a message, not a charge — the other side chooses to accept, pay, or reject it.

## Sending a request

```typescript
const result = await sphere.payments.sendPaymentRequest('@bob', {
  amount: '1000000',
  coinId: 'UCT',
  message: 'Payment for order #1234',
});

// Wait for a response (2-minute timeout here)
if (result.success) {
  const response = await sphere.payments.waitForPaymentResponse(result.requestId!, 120000);
  if (response.responseType === 'paid') {
    console.log('Payment received! Transfer:', response.transferId);
  }
}

// Or subscribe to responses instead of waiting
sphere.payments.onPaymentRequestResponse((response) => {
  console.log(`Response: ${response.responseType}`);
});
```

## Handling incoming requests

```typescript
sphere.payments.onPaymentRequest(async (request) => {
  console.log(`${request.senderNametag} requests ${request.amount} ${request.symbol}`);

  // Accept and pay
  await sphere.payments.payPaymentRequest(request.id);

  // …or reject
  await sphere.payments.rejectPaymentRequest(request.id);
});
```

A response's `responseType` is one of `accepted`, `paid`, or `rejected`. When paid, `transferId` links to the resulting transfer.
