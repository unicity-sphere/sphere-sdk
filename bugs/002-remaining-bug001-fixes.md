# BUG-002: Remaining BUG-001 Fixes Not Yet Implemented

**Date:** 2026-03-13
**Severity:** P0 (Fix 2), P1 (Fixes 3–4)
**Status:** Fixed (2026-03-13)
**Related:** BUG-001 (concurrent send race condition)

## Context

BUG-001 identified 5 fixes needed for the concurrent send race condition. All 5 fixes are now implemented:
- Fix 1 (SpendQueue): Implemented previously
- Fix 2 (Provisional reservation in payInvoice): **Fixed** — gate now held across balance computation + send + provisional write
- Fix 3 (Per-send timeout in _executeTerminationReturns): **Fixed** — Promise.race with 60s timeout per send
- Fix 4 (Deferred event emission inside gates): **Fixed** — queueMicrotask for all 5 emission sites
- Fix 5 (autoReturn flag ordering): Implemented previously

## Fix 2 (P0): Provisional Reservation in `payInvoice()`

**File:** `modules/accounting/AccountingModule.ts`, lines 2172–2343

**Problem:** `payInvoice()` releases the per-invoice gate before calling `send()`. Two concurrent `payInvoice()` calls on the same invoice both compute `remaining = R` and both send `R`, resulting in a double-payment.

**Current flow:**
1. Acquire gate → check invoice not terminal → release gate
2. Compute `sendAmount = requestedAmount - netCoveredAmount` (outside gate)
3. Call `deps.payments.send(sendAmount)` (outside gate)

**Missing:** No provisional reservation is written to `this.invoiceLedger` inside the gate. Compare with `returnInvoicePayment()` (lines 2558–2575) which correctly writes a provisional entry inside its gate.

**Impact:** Two concurrent `payInvoice()` calls for the same invoice can both succeed, sending 2× the required amount. The SpendQueue prevents token double-selection but not amount double-computation.

**Fix:** Mirror the `returnInvoicePayment()` pattern — write a provisional ledger entry inside the gate before releasing it. The provisional entry reserves the computed `sendAmount` so concurrent calls see an updated `netCoveredAmount`.

## Fix 3 (P1): Per-Send Timeout in `_executeTerminationReturns()`

**File:** `modules/accounting/AccountingModule.ts`, lines 3560–3645

**Problem:** Each `deps.payments.send()` call at line 3615 has no timeout wrapper. If a send hangs at the transport layer, all subsequent returns in the batch are blocked. Since `_executeTerminationReturns` runs inside `withInvoiceGate`, a hung send holds the gate indefinitely.

**Comparison:** `returnInvoicePayment()` correctly wraps `send()` in a `Promise.race` against a 60-second timeout.

**Impact:** One unreachable recipient during invoice close/cancel blocks all other returns and all gate-serialized operations on that invoice.

**Fix:** Wrap each `deps.payments.send()` call in `_executeTerminationReturns` with `Promise.race` against a per-send deadline (e.g., 60 seconds), matching the pattern in `returnInvoicePayment()`.

## Fix 4 (P1): Deferred Event Emission Inside Gates

**File:** `modules/accounting/AccountingModule.ts`

**Problem:** `invoice:closed` events are emitted inside `withInvoiceGate` (line 2032 in `closeInvoice`, line 3375 in `_terminateInvoice`). Event handlers that call back into the AccountingModule create re-entrancy through the gate queue.

**Impact:** Event handlers reacting to `invoice:closed` that synchronously call `payInvoice`, `returnInvoicePayment`, or `setAutoReturn` will queue behind the gate. While not a deadlock (JavaScript is single-threaded), it creates unexpected ordering: the re-entrant call sees the invoice as closed but with `_executeTerminationReturns` not yet having run.

**Note:** `invoice:covered` events are correctly fired outside the gate.

**Fix:** Use `queueMicrotask(() => deps.emitEvent('invoice:closed', ...))` to defer the event emission until after the gate is released, or move the `emitEvent` call to after the `withInvoiceGate` callback returns.

## Escrow Service Implications

The escrow service is currently **not vulnerable** to Fix 2 because:
- Payouts are called sequentially (`payInvoice(payoutA)` → `payInvoice(payoutB)`)
- The escrow never calls `payInvoice` concurrently on the same invoice

The escrow **cannot use `closeInvoice({ autoReturn: true })`** until Fix 3 is resolved, because a hung surplus return would block the entire conclusion flow. The escrow uses manual `_returnSurplus()` with its own error handling instead.
