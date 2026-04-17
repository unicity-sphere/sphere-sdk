# BUG-001: Critical Race Condition in Concurrent Token Sends

**Severity:** Critical (fund safety — mitigated by L3 aggregator, but causes operational failures)
**Component:** `PaymentsModule.send()`, `AccountingModule.payInvoice()`
**Discovered:** 2026-03-12
**Discovered by:** Adversarial review of escrow service → traced to SDK root cause
**Status:** Fixed (2026-03-13) — All 5 fixes implemented

---

## Executive Summary

The `PaymentsModule.send()` method has no concurrency protection. Two concurrent `send()` calls — whether from parallel `payInvoice()`, `returnInvoicePayment()`, or `autoReturn` — can select the **same tokens** from the shared `this.tokens` Map due to a TOCTOU (Time-of-Check-Time-of-Use) window across multiple `await` points. In instant transfer mode, this produces **dead bundles** (token data sent to recipients via Nostr that can never be claimed) and wallet state confusion.

The Unicity L3 aggregator prevents actual double-spends (`requestId` uniqueness enforcement), so no funds are created or destroyed. However, the client-side race causes transfers to silently fail, invoices to be underpaid, and tokens to become temporarily "lost" from the sender's perspective.

Additionally, `payInvoice()` deliberately releases the per-invoice gate before calling `send()`, creating a same-invoice double-payment window that compounds the cross-invoice token-pool race.

---

## Root Cause Analysis

### Root Cause 1: No Serialization in `PaymentsModule.send()`

**File:** `modules/payments/PaymentsModule.ts`, lines 978–1034

The `send()` method executes this sequence:

```
Step 1 (line 1011): tokens = Array.from(this.tokens.values())     ← snapshot
Step 2 (line 1012): result = await calculateOptimalSplit(tokens)   ← YIELDS TO EVENT LOOP
Step 3 (line 1030): token.status = 'transferring'                  ← mark selected
Step 4 (line 1045): await sendViaNostr(...)                        ← irreversible in instant mode
Step 5 (line 1317): removeToken(token.id)                          ← remove from pool
```

Between Step 1 and Step 3, there are **four `await` points** (lines 991, 993, 996, 1012). Each `await` yields to the Node.js event loop, allowing a concurrent `send()` call to execute Step 1 and read the same token pool before Step 3 marks the tokens as `'transferring'`.

There is no mutex, lock, queue, semaphore, or any serialization primitive in `PaymentsModule.send()`.

The `TokenSplitCalculator.calculateOptimalSplit()` (line 62 of `TokenSplitCalculator.ts`) filters tokens by `status !== 'confirmed'`, but both concurrent calls read their snapshot before either modifies the status. Both select the same tokens. Both proceed to sign and broadcast.

### Root Cause 2: `payInvoice()` Releases Gate Before `send()`

**File:** `modules/accounting/AccountingModule.ts`, lines 2175–2327

```typescript
// Gate acquired — only checks terminal state
await this.withInvoiceGate(invoiceId, async () => {
  if (closedInvoices.has(invoiceId)) throw INVOICE_TERMINATED;
  if (cancelledInvoices.has(invoiceId)) throw INVOICE_TERMINATED;
});
// GATE RELEASED HERE — comment at line 2174: "to avoid blocking other operations"

// ... remaining amount computed from stale ledger snapshot ...
const remaining = requestedAmount - netCoveredAmount;  // line 2282
// ... send() called OUTSIDE the gate ...
return deps.payments.send({ amount: remaining, ... });  // line 2320
```

Two concurrent `payInvoice()` calls for the **same invoice** both pass the terminal check inside the gate (sequentially), then both exit the gate. Both read the same ledger state. Both compute `remaining = R`. Both call `send(R)`. The invoice receives `2R`.

**Contrast:** `returnInvoicePayment()` (line 2376) correctly holds the gate across the entire balance-check → provisional-ledger-write → send → ledger-update sequence. The `payInvoice` method does not follow this pattern.

---

## Affected Methods

| Method | Concurrency Protection | Risk |
|---|---|---|
| `PaymentsModule.send()` | **None** | All callers affected — token pool TOCTOU |
| `AccountingModule.payInvoice()` | Gate released before send | Same-invoice double-payment + cross-invoice token race |
| `AccountingModule.returnInvoicePayment()` | Gate held across send | Protected for same-invoice, but cross-invoice token race via `send()` |
| `AccountingModule._executeTerminationReturns()` | Gate held, sequential sends | Protected within one invoice, but cross-invoice token race via `send()` |
| `AccountingModule._executeEventAutoReturn()` | Gate for Phase 1 only, send outside gate | Dedup protects same-transfer, but token race via `send()` |

---

## Reproduction Scenarios

### Scenario 1: Cross-Invoice Double-Spend (Two Different Invoices)

```typescript
// Wallet has one token worth 1000 USD
// Invoice A requests 500 USD, Invoice B requests 500 USD

const [resultA, resultB] = await Promise.all([
  accounting.payInvoice(invoiceA, { targetIndex: 0, assetIndex: 0 }),
  accounting.payInvoice(invoiceB, { targetIndex: 0, assetIndex: 0 }),
]);

// EXPECTED: Both succeed (wallet has 1000, each needs 500)
// ACTUAL: Both calls select the same 1000 USD token for splitting.
//         One succeeds at aggregator, one gets REQUEST_ID_EXISTS.
//         One invoice is paid, one is not.
//         In instant mode: one recipient gets a dead bundle.
```

### Scenario 2: Same-Invoice Double-Payment

```typescript
// Invoice requests 500 USD, wallet has 1000 USD

const [pay1, pay2] = await Promise.all([
  accounting.payInvoice(invoiceId, { targetIndex: 0, assetIndex: 0 }),
  accounting.payInvoice(invoiceId, { targetIndex: 0, assetIndex: 0 }),
]);

// EXPECTED: First pays 500, second throws INVOICE_INVALID_AMOUNT (remaining = 0)
// ACTUAL: Both read remaining = 500, both send 500.
//         One succeeds, one fails at token layer.
//         Invoice receives 500 (correct), but sender loses track of tokens.
```

### Scenario 3: payInvoice Racing with autoReturn

```typescript
// Deposit invoice is being closed with autoReturn
// Simultaneously, payout invoice is being paid

await Promise.all([
  accounting.cancelInvoice(depositInvoiceId, { autoReturn: true }),
  accounting.payInvoice(payoutInvoiceId, { targetIndex: 0, assetIndex: 0 }),
]);

// Different invoice gates — both reach PaymentsModule.send() concurrently.
// autoReturn's send and payInvoice's send race for the same tokens.
```

### Scenario 4: Escrow Service — Surplus Return + Payout Race

```typescript
// In swap-orchestrator.ts _concludeSwap():
// 1. payInvoice(payoutA) — sequential, OK
// 2. payInvoice(payoutB) — sequential, OK
// 3. _returnSurplus() calls returnInvoicePayment(depositInvoiceId, ...)
//    This targets a DIFFERENT invoice than the payouts.
//    If payout B's send is still settling in the background (instant mode),
//    and surplus return's send starts, both may select overlapping tokens.
```

---

## Impact Analysis

### What the L3 Aggregator Prevents

The Unicity aggregator enforces `requestId = SHA256(ownerPublicKey || sourceStateHash)` uniqueness. Each token state can produce exactly one accepted commitment. The second concurrent commitment gets `REQUEST_ID_EXISTS`. **No actual double-spend is possible at the protocol level.**

### What the L3 Aggregator Does NOT Prevent

| Impact | Description |
|---|---|
| **Dead bundles** | In instant mode, the Nostr message is sent BEFORE the aggregator commitment. The failed transfer produces token data the recipient can never finalize. |
| **Underpaid invoices** | When two invoices race for the same token, one payment fails silently. The invoice remains underpaid with no automatic retry. |
| **Wallet state confusion** | The sender's `this.tokens` Map has the token removed (line 1317) after the Nostr send, even though the aggregator may reject the commitment. The token is "lost" from the sender's local perspective. |
| **Silent failures in instant mode** | `submitTransferCommitment` is fire-and-forget in instant mode (line 1288: `.catch(...)` swallows the error). The sender has no indication the transfer failed. |
| **Stale change tokens** | If token splitting races, Call A creates a change token from the split. Call B's split references the original token's stateHash, which is now superseded. Call B's commitment is rejected, but Call B may have already calculated a change token that references invalid state. |

### Escrow Service Specific Impact

The escrow service mitigates the worst cases by calling payouts sequentially (`await payInvoice(A)` then `await payInvoice(B)`). However:

1. Surplus return (`returnInvoicePayment` on deposit invoice) races with any still-settling instant-mode payout
2. If the escrow ever moves to parallel payouts for performance, the race becomes critical
3. The `autoReturn` path on `cancelInvoice()` can race with concurrent operations on other invoices

---

## Detailed Code References

### PaymentsModule.send() — The TOCTOU Window

```
File: modules/payments/PaymentsModule.ts

Line  978: async send(request: TransferRequest): Promise<TransferResult> {
Line 1011:   const availableTokens = Array.from(this.tokens.values());  // ← READ
Line 1012:   const splitResult = await calculator.calculateOptimalSplit(  // ← AWAIT #1 (yields)
               availableTokens, targetAmount, coinId
             );
             // ... between here, another send() can read the same tokens ...
Line 1030:   for (const token of tokensToSend) {
Line 1031:     token.status = 'transferring';                            // ← WRITE (too late)
Line 1032:     this.tokens.set(token.id, token);
Line 1033:   }
Line 1034:   await this.save();                                          // ← AWAIT #2
```

### payInvoice() — Gate Released Before Send

```
File: modules/accounting/AccountingModule.ts

Line 2174: // Comment: "Gate is released before send() to avoid blocking"
Line 2175: await this.withInvoiceGate(invoiceId, async () => {
Line 2177:   if (this.closedInvoices.has(invoiceId)) throw ...;
Line 2183: });  // ← GATE RELEASED
           // ... no protection from here ...
Line 2282: const remaining = requestedAmount - netCoveredAmount;         // ← stale read
Line 2320: return deps.payments.send({ amount: remaining, ... });        // ← unprotected send
```

### returnInvoicePayment() — Correctly Serialized (For Reference)

```
File: modules/accounting/AccountingModule.ts

Line 2376: return this.withInvoiceGate(invoiceId, async () => {
             // Balance check INSIDE gate
Line 2487:   const cap = senderNet;
Line 2521:   const sendPromise = deps.payments.send(...);
             // Provisional entry INSIDE gate
Line 2543:   invoiceLedger.set(`provisional:${result.id}`, ...);
Line 2569: });  // ← GATE RELEASED AFTER send completes
```

### TokenSplitCalculator — The Filter That Fails

```
File: modules/payments/TokenSplitCalculator.ts

Line  62: if (t.status !== 'confirmed') continue;  // ← both concurrent calls
          // see 'confirmed' because neither has marked 'transferring' yet
```

### _executeTerminationReturns — Sequential But Gate-Holding

```
File: modules/accounting/AccountingModule.ts

Line 3542: private async _executeTerminationReturns(...) {
             // Called INSIDE the gate from closeInvoice/cancelInvoice
Line 3594:   await deps.payments.send(...);  // ← sequential per sender, but holds
             // gate for entire duration (minutes for many senders)
```

---

## Recommended Fixes

### Fix 1 (Critical — Addresses Root Cause): Add Send Mutex to PaymentsModule

Add a promise-chain queue to `PaymentsModule.send()` using the same pattern as `withInvoiceGate`:

```typescript
// In PaymentsModule
private sendQueue: Promise<void> = Promise.resolve();

async send(request: TransferRequest): Promise<TransferResult> {
  return new Promise<TransferResult>((resolve, reject) => {
    this.sendQueue = this.sendQueue.then(
      () => this._sendInternal(request).then(resolve, reject),
      () => this._sendInternal(request).then(resolve, reject),
    );
  });
}

private async _sendInternal(request: TransferRequest): Promise<TransferResult> {
  // ... existing send() body ...
}
```

This serializes ALL token-spending operations globally, making the token-snapshot → mark-transferring → send sequence atomic with respect to the event loop.

**Performance consideration:** This serializes ALL sends, even for different coin types. A more granular approach would use per-coinId queues:

```typescript
private sendQueues = new Map<string, Promise<void>>();

async send(request: TransferRequest): Promise<TransferResult> {
  const coinId = request.coinId;
  const queue = this.sendQueues.get(coinId) ?? Promise.resolve();
  return new Promise<TransferResult>((resolve, reject) => {
    const newQueue = queue.then(
      () => this._sendInternal(request).then(resolve, reject),
      () => this._sendInternal(request).then(resolve, reject),
    );
    this.sendQueues.set(coinId, newQueue);
  });
}
```

This allows concurrent sends for different coin types while serializing sends for the same coin type.

### Fix 2 (Critical — Addresses payInvoice Double-Pay): Add Provisional Reservation

Before releasing the invoice gate in `payInvoice()`, write a provisional reservation entry to the invoice ledger — the same pattern already used in `returnInvoicePayment()`:

```typescript
await this.withInvoiceGate(invoiceId, async () => {
  if (this.closedInvoices.has(invoiceId)) throw INVOICE_TERMINATED;
  if (this.cancelledInvoices.has(invoiceId)) throw INVOICE_TERMINATED;

  // Compute remaining amount INSIDE the gate
  const remaining = requestedAmount - netCoveredAmount;
  if (remaining <= 0n) throw INVOICE_INVALID_AMOUNT;

  // Write provisional reservation INSIDE the gate
  const reservationId = `reservation:${invoiceId}:${Date.now()}`;
  invoiceLedger.set(reservationId, { amount: remaining, ... });
  // Balance computation will now see this reservation
});

// send() outside gate — but second caller's gate entry sees the reservation
// and computes remaining = 0, throwing INVOICE_INVALID_AMOUNT
try {
  const result = await deps.payments.send({ amount: remaining, ... });
  // Update provisional → confirmed in ledger
} catch (err) {
  // Remove provisional reservation on failure
}
```

### Fix 3 (Warning — Liveness): Add Per-Send Timeout in _executeTerminationReturns

Match the 60-second timeout pattern from `returnInvoicePayment`:

```typescript
// In _executeTerminationReturns, for each send:
const sendPromise = deps.payments.send(sendRequest);
const timeoutPromise = new Promise((_, reject) =>
  setTimeout(() => reject(new Error('Auto-return send timeout')), 60_000)
);
const result = await Promise.race([sendPromise, timeoutPromise]);
```

### Fix 4 (Warning — Re-Entrancy): Defer Event Emission Inside Gates

Replace synchronous `emitEvent` calls inside gate closures with deferred emission:

```typescript
// Instead of:
deps.emitEvent('invoice:payment', payload);

// Use:
queueMicrotask(() => deps.emitEvent('invoice:payment', payload));
```

This prevents event handlers from calling back into the SDK while the gate is held, eliminating re-entrancy surprises.

### Fix 5 (Warning — autoReturn Race): Set autoReturn Flag After Termination Returns

In `closeInvoice` and `cancelInvoice`, move the `autoReturnPerInvoice.set()` call to after `_executeTerminationReturns` completes:

```typescript
// Current (line 2029):
this.autoReturnPerInvoice.set(invoiceId, true);  // before returns
await this._persistAutoReturnSettings();
await this._executeTerminationReturns(...);

// Fixed:
await this._executeTerminationReturns(...);
this.autoReturnPerInvoice.set(invoiceId, true);  // after returns
await this._persistAutoReturnSettings();
```

This prevents concurrent event-triggered auto-returns from racing with the frozen-balance termination returns.

---

## Fix Priority

| Priority | Fix | Effort | Impact |
|---|---|---|---|
| **P0** | Fix 1: Send mutex in PaymentsModule | Small — proven pattern exists in codebase | Eliminates all cross-invoice token races |
| **P0** | Fix 2: Provisional reservation in payInvoice | Medium — mirror returnInvoicePayment pattern | Eliminates same-invoice double-payment |
| **P1** | Fix 3: Per-send timeout in termination returns | Small — copy existing pattern | Prevents gate starvation |
| **P1** | Fix 4: Defer event emission | Small — mechanical replacement | Eliminates re-entrancy confusion |
| **P2** | Fix 5: autoReturn flag ordering | Small — move 2 lines | Prevents minor auto-return race |

---

## Testing Strategy

### Unit Tests

1. **Concurrent `send()` for same coinId** — verify only one proceeds, other queues
2. **Concurrent `payInvoice()` for same invoice** — verify second gets `INVOICE_INVALID_AMOUNT`
3. **Concurrent `payInvoice()` for different invoices, same coinId** — verify serialization
4. **`payInvoice()` + `returnInvoicePayment()` concurrently** — verify no token overlap
5. **`cancelInvoice({ autoReturn })` + `payInvoice()` concurrently** — verify proper ordering

### Integration Tests

1. **Escrow payout + surplus return** — verify surplus return doesn't race with payouts
2. **Multi-sender auto-return** — verify all senders receive correct amounts
3. **Instant mode dead bundle detection** — verify failed transfers are detected and recovered

### Stress Tests

1. **100 concurrent `payInvoice()` calls** — verify exactly one succeeds per invoice
2. **10 invoices paid simultaneously** — verify all complete without token conflicts
3. **Rapid close + pay interleaving** — verify terminal state guards hold

---

## Related Issues

- Escrow service `_returnSurplus` was computing surplus incorrectly (fixed in escrow commit `7cbb273`) — this was an escrow-side bug, not SDK
- Escrow service calls payouts sequentially, accidentally avoiding the worst race scenarios
- The `autoReturnManager` dedup ledger (`auto-return.ts`) has a `markCompleted` storage failure mode where entries get stuck as `pending` permanently (line 273: `critical = false`)

---

## Appendix: Why the Unicity Protocol Prevents Actual Fund Loss

Each token transfer produces a `TransferCommitment` with:
```
requestId = SHA256(ownerPublicKey || sourceStateHash)
```

The `sourceStateHash` is deterministic for the token's current state. Two concurrent transfers of the same token produce identical `requestId` values. The L3 aggregator's Sparse Merkle Tree accepts exactly one leaf per `requestId`. The second submission receives `REQUEST_ID_EXISTS`.

This is structurally equivalent to UTXO: each (tokenId, stateHash) pair can be spent exactly once. The aggregator enforces this globally with no gaps. Client-side races are an operational problem (failed transfers, dead bundles), not a fund safety problem.
