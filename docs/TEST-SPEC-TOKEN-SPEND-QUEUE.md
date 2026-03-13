# Comprehensive Test Suite Specification: Token Spend Queue

## Overview

This document specifies a complete test suite for the Token Spend Queue feature in Sphere SDK. The test suite covers:

- **TokenReservationLedger**: Core reservation tracking with partial reservations and lifecycle management
- **SpendPlanner**: Token selection logic with skip-ahead queue integration
- **SpendQueue**: Queue lifecycle, timeouts, and concurrency coordination
- **PaymentsModule Concurrency**: End-to-end race condition scenarios
- **Send-Queue Integration**: Complete wallet state consistency
- **Starvation Protection**: Fairness guarantees with skip-ahead logic

**Total Estimated Test Cases: 240+**

---

## FILE 1: `tests/unit/modules/TokenReservationLedger.test.ts`

**Purpose**: Verify exact reservation tracking with composite key semantics and invariant preservation.

**Test Type Tags**: `[UNIT]` — synchronous, no async I/O, no state machines.

---

### Describe Block: Basic Operations

#### It: "reserve() creates a reservation with correct amounts" `[UNIT]`
- **Setup**: Ledger with one token (id: `tok-1`, amount: `1000000` satoshis)
- **Action**: `reserve({ tokens: [{ tokenId: 'tok-1', amount: '500000' }] })`
- **Expected**: 
  - Returns reservationId string (UUID format)
  - `getFreeAmount('tok-1')` returns `500000` (1000000 - 500000)
  - `getTotalReserved('tok-1')` returns `500000`

#### It: "reserve() for multiple tokens in one reservation" `[UNIT]`
- **Setup**: Ledger with 3 tokens: `tok-1` (1000000), `tok-2` (2000000), `tok-3` (500000)
- **Action**: `reserve({ tokens: [{ tokenId: 'tok-1', amount: '400000' }, { tokenId: 'tok-2', amount: '1000000' }] })`
- **Expected**:
  - Single reservationId returned
  - `getFreeAmount('tok-1')` = `600000`
  - `getFreeAmount('tok-2')` = `1000000`
  - `getFreeAmount('tok-3')` = `500000` (unchanged)
  - `getTotalReserved('tok-1')` = `400000`
  - `getTotalReserved('tok-2')` = `1000000`

#### It: "commit() marks reservation as committed" `[UNIT]`
- **Setup**: Ledger with token `tok-1` (1000000), reservation made for 500000
- **Action**: Get reservationId from reserve(), call `commit(reservationId)`
- **Expected**:
  - `getFreeAmount('tok-1')` still returns `500000` (free amount unchanged)
  - Reservation is in committed state (internal flag set)
  - Can no longer `cancel()` this reservationId (throws or no-op)

#### It: "cancel() releases reservation amounts" `[UNIT]`
- **Setup**: Ledger with token `tok-1` (1000000), reservation made for 500000
- **Action**: Get reservationId, call `cancel(reservationId)`
- **Expected**:
  - `getFreeAmount('tok-1')` returns `1000000` (fully released)
  - `getTotalReserved('tok-1')` returns `0`
  - Calling `cancel()` again is no-op (idempotent)

#### It: "getFreeAmount() returns token amount minus all active reservations" `[UNIT]`
- **Setup**: Ledger with token `tok-1` (1000000), two reservations: res-1 for 300000, res-2 for 400000
- **Action**: Call `getFreeAmount('tok-1')`
- **Expected**: Returns `300000` (1000000 - 300000 - 400000)

#### It: "getTotalReserved() sums across all active reservations for a token" `[UNIT]`
- **Setup**: Same as above (two reservations)
- **Action**: Call `getTotalReserved('tok-1')`
- **Expected**: Returns `700000` (sum of both)

#### It: "getActiveCoinReservations() returns all reserved amounts for a coinId" `[UNIT]`
- **Setup**: Ledger with 2 tokens of same coin (UCT): `tok-1` (1000000), `tok-2` (2000000). Three reservations: tok-1→300000, tok-2→500000, tok-1→100000
- **Action**: Call `getActiveCoinReservations('UCT')`
- **Expected**:
  - Returns map: `{ 'tok-1': '400000', 'tok-2': '500000' }`
  - Order doesn't matter (set semantics)

---

### Describe Block: Partial Reservation (Multiple sends from same token)

#### It: "Two reservations on same token, each claiming part of the amount" `[UNIT]`
- **Setup**: Token `tok-1` (1000000)
- **Action**: 
  1. res-1 = `reserve({ tokens: [{ tokenId: 'tok-1', amount: '300000' }] })`
  2. res-2 = `reserve({ tokens: [{ tokenId: 'tok-1', amount: '400000' }] })`
- **Expected**: Both succeed, no throw

#### It: "getFreeAmount after two partial reservations is correct" `[UNIT]`
- **Setup**: Same as above
- **Action**: Call `getFreeAmount('tok-1')`
- **Expected**: Returns `300000` (1000000 - 300000 - 400000)

#### It: "cancel one partial reservation → other remains, free amount updates" `[UNIT]`
- **Setup**: Same as above with res-1 and res-2
- **Action**: Call `cancel(res-1)`
- **Expected**:
  - `getFreeAmount('tok-1')` = `600000` (1000000 - 400000 from res-2 only)
  - `getTotalReserved('tok-1')` = `400000`

#### It: "commit one, cancel other → free amount reflects only cancelled release" `[UNIT]`
- **Setup**: Same as above with res-1 and res-2
- **Action**: 
  1. `commit(res-1)`
  2. `cancel(res-2)`
- **Expected**:
  - `getFreeAmount('tok-1')` = `700000` (1000000 - 300000 from committed res-1)
  - Note: committed and active both count against free

---

### Describe Block: Validation & Error Cases

#### It: "reserve() with amount exceeding free amount → throws" `[UNIT]`
- **Setup**: Token `tok-1` (1000000), existing reservation for 700000
- **Action**: Try `reserve({ tokens: [{ tokenId: 'tok-1', amount: '500000' }] })`
- **Expected**: Throws `Error` with message matching "insufficient.*free.*amount" or similar

#### It: "reserve() for token not in pool → throws" `[UNIT]`
- **Setup**: Ledger with token `tok-1` (1000000)
- **Action**: Try `reserve({ tokens: [{ tokenId: 'nonexistent', amount: '100' }] })`
- **Expected**: Throws `Error` with message matching "token.*not.*found" or "unknown.*token"

#### It: "reserve() with zero amount → accepted or rejected consistently" `[UNIT]`
- **Setup**: Token `tok-1` (1000000)
- **Action**: Try `reserve({ tokens: [{ tokenId: 'tok-1', amount: '0' }] })`
- **Expected**: Either returns valid reservationId or throws with clear message. **Document the design decision.**

#### It: "reserve() with negative amount → throws" `[UNIT]`
- **Setup**: Token `tok-1` (1000000)
- **Action**: Try `reserve({ tokens: [{ tokenId: 'tok-1', amount: '-100' }] })`
- **Expected**: Throws `Error`

#### It: "cancel() for unknown reservationId → no-op or safe" `[UNIT]`
- **Setup**: Ledger with token `tok-1` (1000000)
- **Action**: Call `cancel('unknown-id-12345')`
- **Expected**: No-op (idempotent), no throw, free amount unchanged

#### It: "cancel() for already-cancelled reservation → no-op" `[UNIT]`
- **Setup**: Token `tok-1` (1000000), reservation res-1
- **Action**: 
  1. `cancel(res-1)`
  2. `cancel(res-1)` again
- **Expected**: Second call is no-op, no throw

#### It: "commit() for already-committed reservation → no-op" `[UNIT]`
- **Setup**: Token `tok-1` (1000000), reservation res-1
- **Action**: 
  1. `commit(res-1)`
  2. `commit(res-1)` again
- **Expected**: Second call is no-op, no throw

#### It: "commit() for already-cancelled reservation → throws or no-op" `[UNIT]`
- **Setup**: Token `tok-1` (1000000), reservation res-1
- **Action**: 
  1. `cancel(res-1)`
  2. `commit(res-1)`
- **Expected**: Throws `Error` or is no-op. **Document which behavior is chosen.**

#### It: "cancel() for already-committed reservation → throws" `[UNIT]`
- **Setup**: Token `tok-1` (1000000), reservation res-1
- **Action**: 
  1. `commit(res-1)`
  2. `cancel(res-1)`
- **Expected**: Throws `Error` with message matching "cannot.*cancel.*committed"

---

### Describe Block: Token Removal

#### It: "cancelForToken() cancels ALL reservations containing that token" `[UNIT]`
- **Setup**: Token `tok-1` (1000000), three reservations:
  - res-1: [tok-1: 200000]
  - res-2: [tok-1: 300000, tok-2: 100000]
  - res-3: [tok-2: 400000]
- **Action**: Call `cancelForToken('tok-1')`
- **Expected**:
  - res-1 cancelled
  - res-2 cancelled (even though it has tok-2 too)
  - res-3 NOT cancelled (no tok-1)
  - `getFreeAmount('tok-1')` = `1000000`
  - `getFreeAmount('tok-2')` = `1500000` (2000000 - 500000 from res-2 only, res-3 untouched)

#### It: "cancelForToken() for token with no reservations → no-op" `[UNIT]`
- **Setup**: Token `tok-1` (1000000), token `tok-2` (2000000), reservation res-1 on tok-1 only
- **Action**: Call `cancelForToken('tok-2')`
- **Expected**: No-op, free amounts unchanged

#### It: "cancelForToken() returns list of affected reservationIds" `[UNIT]`
- **Setup**: Same as first test in this block
- **Action**: Call `cancelForToken('tok-1')`
- **Expected**: Returns array `['res-1', 'res-2']` (or equivalent IDs in any order)

#### It: "After cancelForToken(), getFreeAmount returns full token amount" `[UNIT]`
- **Setup**: Token `tok-1` (1000000) with reservation for 700000
- **Action**: Call `cancelForToken('tok-1')`
- **Expected**: `getFreeAmount('tok-1')` = `1000000`

---

### Describe Block: Cleanup

#### It: "cleanup(maxAgeMs) removes reservations older than threshold" `[UNIT]`
- **Setup**: Ledger with two reservations:
  - res-1 created at time 100, active
  - res-2 created at time 200, active
  - Token `tok-1` (1000000) with both reservations claiming 300000 total
- **Action**: Mock Date.now() to return 400, call `cleanup(150)` (remove anything older than 400-150=250)
- **Expected**:
  - res-1 removed (100 < 250)
  - res-2 kept (200 > 250)
  - Returns array containing res-1
  - `getFreeAmount('tok-1')` = `700000` (1000000 - only res-2's claim)

#### It: "cleanup returns IDs of removed reservations" `[UNIT]`
- **Setup**: Three reservations: res-1 (old), res-2 (old), res-3 (new)
- **Action**: Call `cleanup(oldThreshold)`
- **Expected**: Returns `['res-1', 'res-2']`

#### It: "cleanup only removes 'active' reservations (not committed)" `[UNIT]`
- **Setup**: Two reservations on `tok-1` (1000000):
  - res-1: active, old
  - res-2: committed, old
  - res-1 claims 300000, res-2 claims 400000
- **Action**: Call `cleanup(threshold)` where both are older than threshold
- **Expected**:
  - res-1 removed
  - res-2 NOT removed (committed)
  - Returns `['res-1']` only
  - `getFreeAmount('tok-1')` = `600000` (1000000 - res-2's committed 400000)

#### It: "cleanup doesn't remove reservations within threshold" `[UNIT]`
- **Setup**: Reservation res-1, created at now - 50ms, maxAgeMs = 100
- **Action**: Call `cleanup(100)`
- **Expected**: res-1 NOT removed (50 < 100), returns empty array

---

### Describe Block: Invariant Checks

#### It: "After any sequence of reserve/cancel/commit: getFreeAmount + getTotalReserved === token.amount" `[UNIT]`
- **Setup**: Token `tok-1` (1000000)
- **Action**: Perform sequence:
  1. res-1 = `reserve({ tokens: [{ tokenId: 'tok-1', amount: '300000' }] })`
  2. res-2 = `reserve({ tokens: [{ tokenId: 'tok-1', amount: '200000' }] })`
  3. `commit(res-1)`
  4. `cancel(res-2)`
- **Expected**: At each step, verify: `getFreeAmount('tok-1') + getTotalReserved('tok-1') == 1000000`

#### It: "Fuzz test: random sequence of 100 operations → invariant holds after each" `[UNIT]`
- **Setup**: Ledger with 5 tokens (varying amounts 500k–2M)
- **Action**: Generate 100 random operations: reserve, cancel, commit, cleanup, cancelForToken. Track all reservationIds and verify invariant after each.
- **Expected**: 
  - All 100 operations complete without error
  - Invariant holds after every single operation: `∑(getFreeAmount(tok)) + ∑(getTotalReserved(tok)) == ∑(token.amount)` for all tokens
  - No crashes, no silent corruption

---

### Shared Fixtures

- **TokenPool**: Factory function returning `{ 'tok-1': { tokenId: 'tok-1', amount: '1000000', coinId: 'UCT' }, ... }`
- **createLedger(tokenPool)**: Returns TokenReservationLedger instance
- **UUID validation**: Helper to verify reservationId format

**Estimated Test Count: 35 tests**

---

## FILE 2: `tests/unit/modules/SpendPlanner.test.ts`

**Purpose**: Verify token selection logic, split detection, and queue interaction with skip-ahead.

**Test Type Tags**: `[UNIT]` for basic operations, `[INTEGRATION]` for queue interaction.

---

### Describe Block: Immediate Planning (tokens available)

#### It: "Single send, single token covers amount → immediate reservation + splitPlan" `[UNIT]`
- **Setup**: Token pool with `tok-1` (1000000, confirmed). Request for 500000.
- **Action**: Call `SpendPlanner.planSend({ amount: '500000', coinId: 'UCT' }, tokenPool, ledger)`
- **Expected**:
  - Result status: `'immediate'`
  - reservationId is set (non-null)
  - splitPlan: `{ mainTokenId: 'tok-1', mainAmount: '500000', changeTokenId: null }`
  - Reservation created in ledger for 500000 from tok-1

#### It: "Single send requiring multiple tokens → immediate reservation on all" `[UNIT]`
- **Setup**: Token pool: `tok-1` (300000), `tok-2` (400000), both confirmed. Request for 600000.
- **Action**: Call `SpendPlanner.planSend({ amount: '600000', coinId: 'UCT' }, tokenPool, ledger)`
- **Expected**:
  - Result status: `'immediate'`
  - reservationId is set
  - splitPlan: `{ mainTokenId: 'tok-1', mainAmount: '300000', changeTokenId: 'tok-2', changeAmount: '300000' }`
  - Both tokens reserved (tok-1: 300000, tok-2: 300000)

#### It: "Single send requiring split → reservation includes split token with correct amounts" `[UNIT]`
- **Setup**: Token pool with `tok-1` (1000000, confirmed). Request for 600000.
- **Action**: Call `SpendPlanner.planSend({ amount: '600000', coinId: 'UCT' }, tokenPool, ledger)`
- **Expected**:
  - Result status: `'immediate'`
  - splitPlan: `{ mainTokenId: 'tok-1', mainAmount: '600000', changeTokenId: 'tok-1-split', changeAmount: '400000' }`
  - Reservation for 1000000 (full token, will be split server-side)

#### It: "Send for exact token amount → no split needed" `[UNIT]`
- **Setup**: Token pool with `tok-1` (500000, confirmed). Request for 500000.
- **Action**: Call `SpendPlanner.planSend({ amount: '500000', coinId: 'UCT' }, tokenPool, ledger)`
- **Expected**:
  - Result status: `'immediate'`
  - splitPlan: `{ mainTokenId: 'tok-1', mainAmount: '500000', changeTokenId: null }`

#### It: "Send for less than smallest token → split needed" `[UNIT]`
- **Setup**: Token pool with `tok-1` (1000000, confirmed). Request for 100.
- **Action**: Call `SpendPlanner.planSend({ amount: '100', coinId: 'UCT' }, tokenPool, ledger)`
- **Expected**:
  - Result status: `'immediate'`
  - splitPlan indicates split (changeTokenId is non-null)

---

### Describe Block: Queued Planning (insufficient free tokens)

#### It: "All tokens reserved by prior send, but total covers both → queued" `[UNIT]`
- **Setup**: 
  - Token pool: `tok-1` (1000000), `tok-2` (1000000)
  - Existing reservation: res-1 on tok-1 for 1000000 (full)
  - New request: 1500000
- **Action**: Call `SpendPlanner.planSend({ amount: '1500000', coinId: 'UCT' }, tokenPool, ledger)`
- **Expected**:
  - Result status: `'queued'`
  - No reservationId set yet
  - queueRequest returned with minimal state
  - Request waiting for change token or token arrival

#### It: "Queued request resolves when change token arrives (notifyChange)" `[INTEGRATION]`
- **Setup**: Token pool and queueRequest from previous test, SpendQueue initialized
- **Action**:
  1. Call `spendQueue.enqueue(queueRequest)`
  2. Add token `tok-3` (500000) to pool
  3. Call `spendQueue.notifyChange('UCT')`
- **Expected**:
  - queueRequest is resolved from queue
  - reservationId is now set
  - Reservation created in ledger

#### It: "Queued request resolves with correct splitPlan" `[INTEGRATION]`
- **Setup**: Token pool: `tok-1` (1000000), all reserved. New request for 600000. Another token `tok-2` (500000) available.
- **Action**: 
  1. Add to queue, enqueue
  2. Add token `tok-3` (200000) to pool
  3. notifyChange
- **Expected**:
  - Plan resolves using available tokens
  - splitPlan shows correct combination (e.g., tok-2 + part of tok-3)

---

### Describe Block: Rejection

#### It: "Not enough tokens even counting all reservations → immediate rejection with SEND_INSUFFICIENT_BALANCE" `[UNIT]`
- **Setup**: Token pool total: 1000000 (spread across multiple tokens). Request for 2000000.
- **Action**: Call `SpendPlanner.planSend({ amount: '2000000', coinId: 'UCT' }, tokenPool, ledger)`
- **Expected**:
  - Result status: `'rejected'`
  - Result error: `SEND_INSUFFICIENT_BALANCE` or `INSUFFICIENT_BALANCE`
  - No reservation created
  - No queue entry created

#### It: "Token pool completely empty → immediate rejection" `[UNIT]`
- **Setup**: Token pool: empty or all tokens non-confirmed
- **Action**: Call `SpendPlanner.planSend({ amount: '1', coinId: 'UCT' }, tokenPool, ledger)`
- **Expected**:
  - Result status: `'rejected'`
  - Result error: `SEND_INSUFFICIENT_BALANCE`

---

### Describe Block: Skip-Ahead Logic

#### It: "Queue: [large_request, small_request]. Change token covers small but not large → small served first" `[INTEGRATION]`
- **Setup**: 
  - Token pool: `tok-1` (2000000, reserved for large_request)
  - Queue: [{ id: 'large', amount: 1500000 }, { id: 'small', amount: 500000 }]
  - Change token arrives: tok-2 (500000)
- **Action**:
  1. Add both to queue
  2. Call `notifyChange('UCT')`
- **Expected**:
  - small_request is planned and removed from queue first (skip-ahead)
  - large_request remains queued
  - skipCount for small_request is NOT incremented (it was served)

#### It: "Skip count incremented for skipped entry" `[INTEGRATION]`
- **Setup**: Queue with [large_req, small_req]. Change token covers only small.
- **Action**: Call `notifyChange('UCT')`
- **Expected**:
  - large_req is skipped
  - large_req.skipCount incremented from 0 to 1
  - small_req served and removed

#### It: "After MAX_SKIP_COUNT (10) skips, large request blocks small ones (starvation protection)" `[INTEGRATION]`
- **Setup**: Queue with [large_req (skipCount: 10), small_req (skipCount: 0)]. Change token covers only small.
- **Action**: Call `notifyChange('UCT')`
- **Expected**:
  - Both remain queued
  - large_req is served first (starvation limit reached)
  - skipCount resets to 0 for remaining entries

#### It: "Multiple small requests skip ahead of one large request (up to limit)" `[INTEGRATION]`
- **Setup**: Queue with [large_req, small-1, small-2, small-3]. Change covers small-1 only.
- **Action**: Call `notifyChange('UCT')`
- **Expected**:
  - small-1 served and removed
  - skipCount for large_req incremented
  - small-2, small-3 remain queued

---

### Describe Block: Pre-computation

#### It: "buildParsedPool correctly parses all confirmed tokens" `[UNIT]`
- **Setup**: Token pool:
  - `tok-1` (1000000, status: 'confirmed')
  - `tok-2` (2000000, status: 'confirmed')
  - `tok-3` (500000, status: 'unconfirmed')
- **Action**: Call `SpendPlanner.buildParsedPool(tokenPool)`
- **Expected**:
  - Parsed pool contains tok-1 and tok-2
  - Total amount: 3000000
  - tok-3 excluded

#### It: "buildParsedPool skips non-confirmed tokens" `[UNIT]`
- **Setup**: Token pool with mix: confirmed, transferring, spent, invalid, unconfirmed
- **Action**: Call `buildParsedPool(tokenPool)`
- **Expected**: Only 'confirmed' tokens in parsed pool

#### It: "buildParsedPool skips placeholder tokens (_placeholder: true in sdkData)" `[UNIT]`
- **Setup**: Token pool:
  - `tok-1` (1000000, confirmed, sdkData: { _placeholder: false })
  - `tok-2` (500000, confirmed, sdkData: { _placeholder: true })
- **Action**: Call `buildParsedPool(tokenPool)`
- **Expected**: Parsed pool contains only tok-1, total: 1000000

#### It: "Pool snapshot is consistent (no partial updates from concurrent addToken)" `[UNIT]`
- **Setup**: Token pool object with 10 confirmed tokens
- **Action**: 
  1. Capture snapshot via `buildParsedPool(tokenPool)`
  2. Modify tokenPool object (add/remove token)
  3. Compare snapshot to modified tokenPool
- **Expected**: Snapshot is unchanged (defensive copy or snapshot semantics)

---

### Shared Fixtures

- **TokenPoolBuilder**: Factory for test token pools with varying statuses and amounts
- **RequestBuilder**: Helper to create send requests with amount/coinId
- **createPlanner(ledger, queue)**: Returns SpendPlanner instance

**Estimated Test Count: 30 tests**

---

## FILE 3: `tests/unit/modules/SpendQueue.test.ts`

**Purpose**: Verify queue lifecycle, timeout semantics, and notifyChange coordination.

**Test Type Tags**: `[UNIT]` for most, `[INTEGRATION]` for timer-based tests.

---

### Describe Block: Basic Queue Operations

#### It: "enqueue adds entry to queue" `[UNIT]`
- **Setup**: SpendQueue instance, request object
- **Action**: Call `spendQueue.enqueue(request)`
- **Expected**:
  - Request added to queue
  - `spendQueue.size()` increments by 1

#### It: "notifyChange(coinId) triggers re-evaluation" `[UNIT]`
- **Setup**: Queue with one queued request. Planner mock that returns 'immediate' on second call.
- **Action**: 
  1. Enqueue request for 'UCT'
  2. Call `notifyChange('UCT')`
- **Expected**:
  - Planner is called for the queued request
  - If plan is 'immediate', request is dequeued and callback is invoked

#### It: "cancelAll(reason) rejects all entries with reason" `[UNIT]`
- **Setup**: Queue with 5 requests, mocked callbacks
- **Action**: Call `cancelAll('TEST_REASON')`
- **Expected**:
  - All 5 callbacks are invoked with error code `SEND_QUEUE_CANCELLED`
  - Queue size is 0
  - Each callback receives error object with reason field

#### It: "size() returns correct count" `[UNIT]`
- **Setup**: Empty queue
- **Action**: Enqueue 3 requests, check `size()`
- **Expected**: Returns 3

#### It: "size(coinId) returns count for specific coin" `[UNIT]`
- **Setup**: Queue with:
  - 2 requests for 'UCT'
  - 3 requests for 'USDC'
  - 1 request for 'USDT'
- **Action**: Call `size('UCT')` and `size('USDC')`
- **Expected**: Returns 2 and 3 respectively

---

### Describe Block: Timeout

#### It: "Entry that exceeds 30s timeout is rejected with SEND_QUEUE_TIMEOUT" `[INTEGRATION]`
- **Setup**: Queue entry, mocked callback. Mock Date.now().
- **Action**:
  1. Enqueue request at time 0
  2. Advance mock time to 31000ms
  3. Call `notifyChange` or trigger internal timeout check
- **Expected**:
  - Callback invoked with error `SEND_QUEUE_TIMEOUT`
  - Entry removed from queue

#### It: "Timeout checked on notifyChange" `[INTEGRATION]`
- **Setup**: Queue entry at time 0, current time 31000ms, planner returns 'queued' (stays in queue)
- **Action**: Call `notifyChange(coinId)`
- **Expected**:
  - Timeout is evaluated
  - Timed-out entry is rejected before re-planning newer entries

#### It: "Timeout checked by periodic timer (1s interval)" `[INTEGRATION]`
- **Setup**: Queue entry at time 0, periodic timer with 1s interval
- **Action**:
  1. Enqueue request
  2. Advance mock time by 31000ms
  3. Wait for timer tick
- **Expected**: Callback invoked with timeout error, entry removed

#### It: "Reservation cancelled when entry times out" `[UNIT]`
- **Setup**: Queue entry with reservationId, timeout triggers
- **Action**: Timeout fires
- **Expected**:
  - `ledger.cancel(reservationId)` is called
  - Free amount in ledger is released

---

### Describe Block: Queue Capacity

#### It: "Enqueue when queue is at QUEUE_MAX_SIZE (100) → reject immediately" `[UNIT]`
- **Setup**: Queue with 100 entries (at QUEUE_MAX_SIZE limit)
- **Action**: Try to enqueue one more request
- **Expected**:
  - Request rejected immediately with error `SEND_QUEUE_FULL` or `QUEUE_CAPACITY_EXCEEDED`
  - Callback invoked with error
  - Queue size remains 100

#### It: "After removal, new entries can be enqueued" `[UNIT]`
- **Setup**: Queue with 100 entries
- **Action**:
  1. Enqueue 101st → rejected
  2. Remove one entry (via timeout or planning success)
  3. Enqueue 101st again
- **Expected**: 101st is accepted, queue size 100

---

### Describe Block: notifyChange Behavior

#### It: "notifyChange for unrelated coinId → no effect on queued entries" `[UNIT]`
- **Setup**: Queue with requests for 'UCT' and 'USDC'. Planner returns 'queued' for both.
- **Action**: Call `notifyChange('USDT')` (unrelated coin)
- **Expected**: No planner calls, no queue changes, size unchanged

#### It: "notifyChange triggers planning attempt for matching coinId entries" `[UNIT]`
- **Setup**: Queue with 2 requests for 'UCT', 1 for 'USDC'. Planner mock tracks calls.
- **Action**: Call `notifyChange('UCT')`
- **Expected**:
  - Planner called exactly twice (once per UCT request)
  - USDC request untouched

#### It: "Multiple rapid notifyChange calls are coalesced (queueMicrotask batching)" `[UNIT]`
- **Setup**: Queue with request, planner mock tracks call count
- **Action**:
  1. Call `notifyChange('UCT')` 3 times synchronously
  2. Await microtask queue drain
- **Expected**:
  - Planner is called only once (batched)
  - Not three times (coalesced)

---

### Describe Block: Destroy Integration

#### It: "cancelAll called during destroy rejects all pending entries" `[UNIT]`
- **Setup**: Queue with 5 requests, mocked callbacks
- **Action**: Call `destroy()`
- **Expected**:
  - All 5 callbacks invoked with error
  - Queue is empty
  - destroy() idempotent (calling again is no-op)

#### It: "No new entries accepted after destroy" `[UNIT]`
- **Setup**: Queue, call `destroy()`
- **Action**: Try `enqueue(request)` after destroy
- **Expected**: Throws or rejects immediately with error (e.g., `MODULE_DESTROYED`)

---

### Shared Fixtures

- **createQueue(ledger, planner)**: Returns SpendQueue instance with mocked timers
- **RequestEntry**: Builder for queue requests with amount, coinId, callback
- **MockPlanner**: Returns configurable 'immediate' | 'queued' | 'rejected' results

**Estimated Test Count: 25 tests**

---

## FILE 4: `tests/unit/modules/PaymentsModule.concurrency.test.ts`

**Purpose**: Verify that concurrent `send()` calls properly reserve tokens, handle splits, and coordinate via queue.

**Test Type Tags**: `[INTEGRATION]` for all — involves PaymentsModule, ledger, queue, transport, and oracle.

---

### Describe Block: Basic Concurrency — Two Sends, Same CoinId

#### It: "Two concurrent sends for different amounts, pool has enough → both succeed with different tokens" `[INTEGRATION]`
- **Setup**: 
  - Token pool: `tok-1` (1000000), `tok-2` (1000000)
  - Mock oracle/transport
  - PaymentsModule initialized
- **Action**:
  1. Call `sphere.payments.send({ recipient: '@alice', amount: '300000', coinId: 'UCT' })`
  2. Call `sphere.payments.send({ recipient: '@bob', amount: '400000', coinId: 'UCT' })` (no await between)
- **Expected**:
  - Both complete successfully (both eventually resolve)
  - send-1 uses tok-1 (300000)
  - send-2 uses tok-2 (400000)
  - No reservation conflict
  - Both TransferResult.status: 'completed' or 'delivered'

#### It: "Two concurrent sends for same amount, only one token → first succeeds, second queues and gets change token" `[INTEGRATION]`
- **Setup**: Token pool: `tok-1` (1000000), oracle/transport mocked
- **Action**:
  1. Send-1: 500000 (no await)
  2. Send-2: 500000 (no await)
- **Expected**:
  - Send-1 completes using tok-1
  - Send-2 queues
  - Change token from send-1's split arrives
  - Send-2 completes using change token
  - Both eventually status: 'completed'

#### It: "Two concurrent sends, pool covers both but needs split → first splits, second waits for change" `[INTEGRATION]`
- **Setup**: Token pool: `tok-1` (1500000)
- **Action**: Send-1 (600000), Send-2 (400000) concurrently
- **Expected**:
  - Send-1 selected tok-1, reserves 1500000 (will split)
  - Send-2 queued (all confirmed tokens reserved)
  - Send-1 splits, change token (500000) arrives
  - Send-2 completes with change token
  - Both succeed

---

### Describe Block: Three or More Concurrent Sends

#### It: "Three sends, pool has 3 tokens → all proceed in parallel" `[INTEGRATION]`
- **Setup**: Token pool: `tok-1` (1000000), `tok-2` (1000000), `tok-3` (1000000)
- **Action**: Send-1 (500000), Send-2 (600000), Send-3 (400000) concurrently
- **Expected**:
  - All three reserved immediately (enough tokens)
  - All complete in parallel
  - No queue involvement
  - All status: 'completed'

#### It: "Three sends, pool has 2 tokens → two proceed, third queues" `[INTEGRATION]`
- **Setup**: Token pool: `tok-1` (1000000), `tok-2` (1000000)
- **Action**: Send-1 (500000), Send-2 (600000), Send-3 (400000) concurrently
- **Expected**:
  - Send-1, Send-2 proceed immediately (reserved)
  - Send-3 queued
  - Change tokens from Send-1/Send-2 arrive (or one of them)
  - Send-3 completes
  - All eventually succeed

#### It: "Five sends, pool has 1 large token → first sends, rest queue for change tokens (waterfall)" `[INTEGRATION]`
- **Setup**: Token pool: `tok-1` (5000000)
- **Action**: Send-1 (1000000), Send-2 (800000), Send-3 (600000), Send-4 (400000), Send-5 (200000) concurrently
- **Expected**:
  - Send-1 proceeds, reserves tok-1 (will split to 4000000 change)
  - Send-2, Send-3, Send-4, Send-5 queued
  - Send-1 completes, change arrives
  - Send-2 proceeds (if change covers it)
  - Cascade continues until all complete
  - All eventually succeed
  - No starvation (all are served within 30s timeout)

---

### Describe Block: Token Exhaustion & Change-Back

#### It: "Send 500 from a 1000 token → change token 500 arrives → queued send for 300 gets the change token" `[INTEGRATION]`
- **Setup**: Token pool: `tok-1` (1000000), oracle/transport mocked to produce change immediately
- **Action**:
  1. Send-1: 500000 (proceeds)
  2. Send-2: 300000 (queued, insufficient free tokens)
  3. Send-1 completes, change token (500000) arrives
  4. spendQueue.notifyChange('UCT')
- **Expected**:
  - Send-2 dequeued and planned with change token
  - Send-2 completes

#### It: "Queued send amount is larger than change token → stays queued" `[INTEGRATION]`
- **Setup**: Token pool: `tok-1` (1000000)
- **Action**:
  1. Send-1: 700000 (proceeds)
  2. Send-2: 500000 (queued)
  3. Change token (300000) arrives
  4. notifyChange('UCT')
- **Expected**:
  - Send-2 still insufficient (300000 < 500000)
  - Send-2 remains queued
  - When more tokens arrive, Send-2 can proceed

#### It: "Multiple queued sends fulfilled by a single change token split cascade" `[INTEGRATION]`
- **Setup**: Token pool: `tok-1` (3000000)
- **Action**:
  1. Send-1: 1000000 (proceeds, will split to 2000000 change)
  2. Send-2: 800000 (queued)
  3. Send-3: 600000 (queued)
  4. Change-1 (2000000) arrives
  5. notifyChange
- **Expected**:
  - Send-2 plans with change-1, proceeds, reserves 800000 (will split to 1200000)
  - Send-2 completes, change-2 (1200000) arrives
  - notifyChange
  - Send-3 plans with change-2, proceeds (600000 < 1200000)
  - Send-3 completes
  - Cascade works correctly

---

### Describe Block: Cross-CoinId Independence

#### It: "Concurrent sends for different coinIds → fully parallel, no blocking" `[INTEGRATION]`
- **Setup**: Token pools for both 'UCT' and 'USDC' with limited tokens
- **Action**:
  1. Send-UCT (500000 UCT) and Send-USDC (500000 USDC) concurrently
  2. Both need their single token
- **Expected**:
  - No queue blocking between coinIds
  - Both proceed and complete in parallel
  - No artificial serialization

#### It: "Queue for coinId A doesn't affect sends for coinId B" `[INTEGRATION]`
- **Setup**: 
  - UCT pool: 1 token (500000)
  - USDC pool: 3 tokens (1000000 each)
- **Action**:
  1. Send-UCT-1 (500000) + Send-UCT-2 (400000) concurrently
  2. Send-USDC-1 (600000) concurrently
- **Expected**:
  - Send-UCT-1 proceeds, Send-UCT-2 queues (UCT pool exhausted)
  - Send-USDC-1 proceeds immediately (USDC pool has tokens)
  - USDC send latency is not affected by UCT queue

---

### Describe Block: Send Failure → Reservation Release

#### It: "First send reserves token, fails at aggregator → reservation cancelled → second send proceeds" `[INTEGRATION]`
- **Setup**: Token pool: `tok-1` (1000000), oracle mocked to return error
- **Action**:
  1. Send-1: 500000 (reserves tok-1, but oracle fails)
  2. Send-2: 300000 (queued, waiting for reservation release)
  3. Send-1 error handler calls `ledger.cancel(res-1)`
  4. notifyChange('UCT')
- **Expected**:
  - Send-1 fails (TransferResult.error set, status: 'failed')
  - Send-2 dequeued, now sees tok-1 fully free (300000)
  - Send-2 proceeds and completes

#### It: "First send reserves token, Nostr send fails → reservation cancelled → second send proceeds" `[INTEGRATION]`
- **Setup**: Token pool: `tok-1` (1000000), transport mocked to reject
- **Action**:
  1. Send-1: 500000 (reserved, Nostr send fails)
  2. Send-2: 300000 (queued)
  3. Send-1 error → reservation cancelled
  4. notifyChange fires
- **Expected**:
  - Send-1 fails
  - Send-2 resumes and completes

#### It: "Verify notifyChange is called after failure → queued request wakes up" `[INTEGRATION]`
- **Setup**: Queue mock to track notifyChange calls
- **Action**: Send fails after reservation, queue listening
- **Expected**: notifyChange('UCT') is called, queue re-evaluates

---

### Describe Block: Integration with AccountingModule

#### It: "Concurrent payInvoice() for different invoices → both proceed (different tokens) or one queues" `[INTEGRATION]`
- **Setup**: 
  - AccountingModule with 2 invoices: inv-1, inv-2
  - Token pool: 1 token (1000000)
- **Action**: `sphere.accounting.payInvoice(inv-1, { amount: '600000' })` and `payInvoice(inv-2, { amount: '300000' })` concurrently
- **Expected**:
  - Both calls eventually succeed (one queues)
  - Payments properly attributed to respective invoices
  - No memo collision or invoice confusion

#### It: "Concurrent payInvoice() for same invoice → second gets INVOICE_INVALID_AMOUNT (from gate, not from queue)" `[INTEGRATION]`
- **Setup**: AccountingModule with invoice, per-invoice async gate
- **Action**: `payInvoice(inv-1, { amount: '500000' })` called twice concurrently
- **Expected**:
  - First call proceeds
  - Second call rejected with per-invoice gate error (not queue error)
  - Both calls finish cleanly

#### It: "payInvoice() + returnInvoicePayment() concurrent → no token overlap" `[INTEGRATION]`
- **Setup**: Invoice with payment, token pool with limited tokens
- **Action**: `payInvoice(inv-1, amount)` and `returnInvoicePayment(...)` concurrently
- **Expected**:
  - Return uses separate transaction path (or queues properly)
  - No reservation conflict
  - Both complete successfully

#### It: "cancelInvoice(autoReturn) + payInvoice() concurrent → no dead bundles" `[INTEGRATION]`
- **Setup**: Invoice with autoReturn enabled, token pool
- **Action**: `cancelInvoice(invoiceId)` triggers autoReturn send, concurrent `payInvoice()` call
- **Expected**:
  - autoReturn send and payInvoice properly serialized via queue/gate
  - Return doesn't create dead bundle with payment

#### It: "autoReturn send + regular send concurrent → properly serialized via queue" `[INTEGRATION]`
- **Setup**: Invoice with autoReturn pending, user initiates send concurrently
- **Action**: Both requests compete for tokens
- **Expected**:
  - Both properly queued/reserved
  - Both eventually succeed or one fails cleanly
  - No payment loss

---

### Describe Block: Split Race Conditions

#### It: "Two sends both need splits from same token → only first gets the split, second queues" `[INTEGRATION]`
- **Setup**: Token pool: `tok-1` (1000000), oracle mocked to support splits
- **Action**: Send-1 (600000), Send-2 (300000) concurrently
- **Expected**:
  - Send-1 reserves tok-1, will split to 400000 change
  - Send-2 queued
  - Split succeeds, change token arrives
  - Send-2 proceeds with change

#### It: "Split change token arrives while second send is being planned → properly detected" `[INTEGRATION]`
- **Setup**: Send-1 reserved tok-1, Send-2 in queue, split in-flight
- **Action**: 
  1. Change token arrives
  2. notifyChange fires
  3. Send-2 re-plans
- **Expected**: Send-2 sees change token as available (not reserved), can use it

#### It: "Split fails midway (aggregator down) → reservation cancelled, queued sends re-evaluated" `[INTEGRATION]`
- **Setup**: Oracle mocked to fail during split
- **Action**:
  1. Send-1 attempts split, fails
  2. Reservation cancelled
  3. notifyChange fires
  4. Send-2 resumes from queue
- **Expected**:
  - Send-1 fails cleanly
  - Send-2 re-planned with main token (still free)
  - Send-2 proceeds

---

### Describe Block: Placeholder Token Safety

#### It: "Placeholder token (status: 'transferring', sdkData: _placeholder) NOT selected by planner" `[INTEGRATION]`
- **Setup**: Token pool with `tok-1` (transferring, _placeholder: true, amount: 1000000) and `tok-2` (confirmed, 1000000)
- **Action**: Send 600000
- **Expected**:
  - tok-1 skipped (placeholder, not confirmed)
  - tok-2 selected
  - No reservation on tok-1

#### It: "Real change token replaces placeholder → notifyChange fires → queued send proceeds" `[INTEGRATION]`
- **Setup**: Token pool with placeholder from Send-1. Send-2 queued awaiting change.
- **Action**:
  1. Send-1 completes, placeholder removed
  2. Real change token (confirmed, _placeholder: false) added
  3. notifyChange('UCT')
- **Expected**:
  - Real token detected as available (different from placeholder)
  - Send-2 proceeds with real token
  - No resurrection of placeholder

---

### Describe Block: Token Arrival During Queue Wait

#### It: "External token received via Nostr while send is queued → notifyChange wakes queue" `[INTEGRATION]`
- **Setup**: Send queued, transport listener receives new token
- **Action**:
  1. New token event from Nostr
  2. Token added to pool
  3. notifyChange triggered by transport
- **Expected**:
  - Queued send re-planned with new token
  - Proceeds if amount covered

#### It: "IPFS sync adds tokens while send is queued → notifyChange wakes queue" `[INTEGRATION]`
- **Setup**: Send queued, IPFS sync runs
- **Action**:
  1. sync() completes, new tokens added
  2. notifyChange called
- **Expected**:
  - Queue re-evaluated
  - Queued send proceeds if amount covered

---

### Describe Block: Timeout Scenarios

#### It: "Queued send times out after 30s → proper error, reservation cleaned up" `[INTEGRATION]`
- **Setup**: Send queued, no tokens available, 30s passes
- **Action**: Timeout fires on queue entry
- **Expected**:
  - Callback invoked with error `SEND_QUEUE_TIMEOUT`
  - Reservation cancelled in ledger
  - Free amount restored
  - TransferResult.status: 'failed', error: 'SEND_QUEUE_TIMEOUT'

#### It: "Queued send fulfilled just before timeout → succeeds (no race with timeout)" `[INTEGRATION]`
- **Setup**: Send queued at time 0, token arrives at time 29s, timeout at 30s
- **Action**:
  1. Token arrives, notifyChange at 29s
  2. Send planned and proceeds
  3. Timeout check at 30s (or 31s)
- **Expected**:
  - Send completes before timeout
  - No timeout error
  - TransferResult.status: 'completed'

#### It: "Multiple queued sends, some timeout, some succeed → proper cleanup" `[INTEGRATION]`
- **Setup**: 5 queued sends, token pool slowly refilled over 25s
- **Action**:
  1. First 3 sends succeed over 20s
  2. 4th send at time 25s
  3. 5th send times out at 31s
- **Expected**:
  - Sends 1-4 succeed
  - Send 5 fails with timeout
  - Ledger clean (no orphaned reservations)

---

### Describe Block: Destroy During Active Sends

#### It: "destroy() called while send is in-flight → send completes, reservation committed" `[INTEGRATION]`
- **Setup**: Send in-flight (reserved, Nostr sent, awaiting proof)
- **Action**: Call `sphere.destroy()` while send pending
- **Expected**:
  - Send allowed to complete (no immediate cancellation)
  - Reservation committed
  - Module destroyed cleanly
  - State saved to storage

#### It: "destroy() called while send is queued → queued send rejected with MODULE_DESTROYED" `[INTEGRATION]`
- **Setup**: Send queued
- **Action**: Call `sphere.destroy()`
- **Expected**:
  - Queued send rejected with error code `MODULE_DESTROYED`
  - Queue cleared
  - Module destroyed

#### It: "destroy() called while split is in background → background completes, change token ignored" `[INTEGRATION]`
- **Setup**: Send with split in-flight (background promise), destroy called during split
- **Action**: Split completes after destroy
- **Expected**:
  - Change token not added to pool (module destroyed)
  - No error, graceful shutdown
  - Split promise settled (no unhandled rejection)

---

### Describe Block: Stress Tests

#### It: "10 concurrent sends, 5 tokens → all eventually complete or timeout" `[INTEGRATION]`
- **Setup**: Token pool: 5 tokens (1000000 each), 10 concurrent sends (300000 each)
- **Action**: Fire all 10 sends concurrently, wait for all to settle
- **Expected**:
  - All 10 complete (should be within 30s timeout)
  - No dropped transfers
  - All TransferResult.status: 'completed' or at least not 'failed'
  - Ledger clean after (no orphaned reservations)

#### It: "50 concurrent sends, same coinId → no duplicate token usage, all reservations consistent" `[INTEGRATION]`
- **Setup**: Token pool: 20 tokens (300000 each), 50 sends (150000 each)
- **Action**: Fire all 50 concurrently
- **Expected**:
  - No token used twice (reservation conflict)
  - All eventually complete (may queue and waterfall through change tokens)
  - Ledger invariant holds: ∑ free + ∑ reserved == ∑ token.amount
  - No crashes, no silent failures

#### It: "Rapid send-cancel-send pattern → reservations properly cleaned up" `[INTEGRATION]`
- **Setup**: Send with timeout + immediate follow-up send
- **Action**:
  1. Send-1 (reserve, queued)
  2. User cancels (or timeout)
  3. Send-2 immediately after
- **Expected**:
  - Reservation from Send-1 cleaned up
  - Send-2 sees fresh ledger (no orphaned res from Send-1)
  - Send-2 proceeds correctly

#### It: "100 sends with 1 token → first succeeds, rest queue, cascade through change tokens" `[INTEGRATION]`
- **Setup**: Token pool: `tok-1` (1000000), 100 concurrent sends (100000 each)
- **Action**: Fire all concurrently, observe cascade
- **Expected**:
  - First send proceeds, splits, change token (900000)
  - Second send proceeds, splits, change (800000)
  - ... cascade continues
  - At least 90% of sends complete within timeout
  - No starvation (skip-ahead prevents last sends from starving)

---

### Shared Fixtures

- **SphereTestHarness**: Returns Sphere instance with mocked oracle, transport, storage
- **TokenPoolBuilder**: Creates token pool with varying amounts, statuses, coins
- **ConcurrentSendHelper**: Helper to fire multiple send() calls and await all
- **TimerMocks**: For timeout testing
- **LedgerSnapshot**: Utility to verify ledger invariants

**Estimated Test Count: 60 tests**

---

## FILE 5: `tests/unit/modules/PaymentsModule.send-queue-integration.test.ts`

**Purpose**: End-to-end scenarios with full mocked environment, verifying state consistency.

**Test Type Tags**: `[INTEGRATION]` for all.

---

### Describe Block: End-to-End Scenarios (with mocked transport/oracle)

#### It: "Escrow: deposit → two payouts → surplus return (original bug scenario from issue)" `[INTEGRATION]`
- **Setup**:
  - Invoice created by merchant: targets = [{ address: merchant, assets: [{ coinId: 'UCT', amount: '1000000' }] }]
  - Invoice token sent to payer
  - Payer receives token, imports invoice
  - Token pool: `tok-1` (1500000)
- **Action**:
  1. payer.accounting.payInvoice(invId, { amount: '1500000' }) — overpayment
  2. Concurrent: merchant awaits payment, payer awaits return
  3. Merchant receives payment, auto-return kicks in for surplus (500000)
  4. Payer receives return
- **Expected**:
  - Payment transfer completes (1500000)
  - invoice:payment event fires
  - invoice:overpayment event fires (surplus: 500000)
  - Auto-return transfer sent (500000 back to payer)
  - Payer receives return transfer
  - Merchant's balance shows 1000000, payer's net spend is 1000000
  - invoice:auto_returned event fires
  - No double-spending, no lost tokens

#### It: "Multi-invoice payment: pay 3 invoices concurrently from same wallet" `[INTEGRATION]`
- **Setup**:
  - 3 invoices: inv-1 (1000000 UCT), inv-2 (500000 UCT), inv-3 (300000 UCT)
  - Token pool: `tok-1` (2000000), `tok-2` (1000000)
- **Action**:
  1. payInvoice(inv-1, 1000000), payInvoice(inv-2, 500000), payInvoice(inv-3, 300000) concurrently
- **Expected**:
  - inv-1 uses tok-1 (1000000)
  - inv-2 uses tok-2 (500000) or tok-1 change
  - inv-3 uses remaining tokens
  - All 3 invoices marked COVERED
  - All 3 transfer events fire correctly
  - Memo tags correctly attribute transfers to invoices

#### It: "Payment + receive: send tokens while receiving tokens on Nostr" `[INTEGRATION]`
- **Setup**: 
  - Wallet balance: `tok-1` (1000000)
  - Concurrent: send 300000 AND receive 500000 from peer
- **Action**:
  1. Send-1: 300000 to @bob (reserved, in-flight)
  2. Nostr event: @alice sends 500000 (token added to pool)
  3. Both complete
- **Expected**:
  - Send-1 completes using tok-1 (still available)
  - Received token added to pool
  - Final balance: tok-1 change (700000) + received token (500000) = 1200000 effective
  - No conflict, parallel operation

#### It: "Rapid fire: user clicks send 3 times fast (debounce at UI, but SDK must handle)" `[INTEGRATION]`
- **Setup**: Token pool: `tok-1` (1000000), `tok-2` (1000000)
- **Action**:
  1. Send-1 (400000)
  2. Send-2 (400000) — 10ms later
  3. Send-3 (400000) — 20ms later
  - All fire without waiting for previous to complete
- **Expected**:
  - Send-1 uses tok-1, reserves 400000
  - Send-2 uses tok-2, reserves 400000
  - Send-3 queued
  - Send-3 fulfilled by change token or external token arrival
  - All complete successfully

---

### Describe Block: State Consistency After Concurrent Sends

#### It: "After all concurrent sends complete: tokens map is consistent" `[INTEGRATION]`
- **Setup**: 10 concurrent sends from mixed pool
- **Action**: Wait for all to settle, inspect `sphere.payments.getTokens()`
- **Expected**:
  - No duplicates in tokens map
  - No self-contradictory entries (e.g., token both 'confirmed' and 'spent')
  - Token IDs are unique
  - All amounts are valid bigints

#### It: "After all concurrent sends complete: no orphaned reservations" `[INTEGRATION]`
- **Setup**: 10 concurrent sends, some queue, some complete, some timeout
- **Action**: Inspect ledger after all settle
- **Expected**:
  - Ledger size: 0 (all reservations either committed or cancelled)
  - getFreeAmount + getTotalReserved == token.amount for each token

#### It: "After all concurrent sends complete: tombstones correct" `[INTEGRATION]`
- **Setup**: Send tokens (some spent, some returned)
- **Action**: Inspect `_tombstones` in storage
- **Expected**:
  - Each spent token has a (tokenId, stateHash) entry
  - No duplicate tombstones
  - Spent tokens not re-added

#### It: "After all concurrent sends complete: archived tokens correct" `[INTEGRATION]`
- **Setup**: Send tokens, some spent
- **Action**: Inspect `archivedTokens` in storage
- **Expected**:
  - Each spent token moved to archived
  - Original token file deleted
  - Archived file correctly formatted

#### It: "After all concurrent sends complete: save() reflects final state" `[INTEGRATION]`
- **Setup**: Multiple sends, await all, call `sphere.destroy()`
- **Action**: Re-load sphere from storage
- **Expected**:
  - Tokens reloaded are consistent with final state (no loss)
  - No double-loads of archived tokens
  - Ledger state empty (reserved → committed or cancelled)

---

### Describe Block: Recovery Scenarios

#### It: "Send partially completes (Nostr sent, aggregator pending) → reservation committed even if proof slow" `[INTEGRATION]`
- **Setup**: Oracle mocked to delay proof by 5s, Nostr mocked to send immediately
- **Action**:
  1. Send fires
  2. Nostr send succeeds
  3. Oracle proof pending
  4. Concurrent: Send-2 fires (queued if proof delayed)
  5. Proof arrives
- **Expected**:
  - Send-1 marked 'submitted' (Nostr sent)
  - Reservation committed in ledger
  - Send-2 doesn't resurrect Send-1's tokens (committed)
  - Proof arrival transitions Send-1 to 'completed'

#### It: "Queue entry fulfilled by token that is then invalidated → re-plan or fail gracefully" `[INTEGRATION]`
- **Setup**: Send queued, token from oracle arrives but oracle later rejects it
- **Action**:
  1. Token added to pool
  2. notifyChange, queued send planned with token
  3. Before send completes, token invalidated (oracle says 'invalid')
  4. Re-validate
- **Expected**:
  - Planner detects invalid token (buildParsedPool skips it)
  - Send re-planned with remaining valid tokens, or fails with INSUFFICIENT_BALANCE
  - No crash, graceful fallback

#### It: "Storage save fails during send → reservation still in memory, consistency on retry" `[INTEGRATION]`
- **Setup**: Storage mocked to fail on save during send
- **Action**:
  1. Send fires, completes in-memory
  2. Storage save fails
  3. Retry send from same wallet (fresh load)
- **Expected**:
  - First send may throw (storage error surfaced)
  - On fresh load, wallet state reloaded (may have partial token state)
  - Retry succeeds without double-spend
  - Tombstone check prevents re-adding spent tokens

---

### Shared Fixtures

- **FullSphereHarness**: Sphere instance with transport, oracle, storage, accounting, all mocked
- **InvoiceBuilder**: Creates test invoices with configurable targets
- **PaymentScenarioHelper**: Utilities for multi-invoice payment tests

**Estimated Test Count: 15 tests**

---

## FILE 6: `tests/unit/modules/SpendQueue.starvation.test.ts`

**Purpose**: Deep dive into starvation protection and skip-ahead fairness.

**Test Type Tags**: `[UNIT]` for skip-ahead logic, `[INTEGRATION]` for queue behavior.

---

### Describe Block: Starvation Protection Deep Dive

#### It: "FIFO order respected when all requests are same size" `[UNIT]`
- **Setup**: Queue with 5 requests all for 500000 UCT. Change tokens arrive in order.
- **Action**:
  1. Enqueue all 5
  2. notifyChange fires multiple times (change token covers each)
- **Expected**:
  - Requests served in enqueue order: req-1, req-2, req-3, req-4, req-5
  - No skip-ahead (all same size, no reason to skip)
  - skipCount for all remains 0

#### It: "Skip-ahead activates: small request jumps large one → skipCount incremented" `[UNIT]`
- **Setup**: Queue with [large: 1000000, small: 100000]. Change token covers only small (100000).
- **Action**: notifyChange('UCT')
- **Expected**:
  - small served first (skip-ahead activated)
  - small removed from queue
  - large.skipCount incremented from 0 to 1
  - large remains queued

#### It: "skipCount reaches MAX_SKIP_COUNT (10) → large request blocks small ones (starvation protection)" `[UNIT]`
- **Setup**: Queue with [large (skipCount: 10), small-1, small-2]. Change covers only small-1.
- **Action**: notifyChange('UCT')
- **Expected**:
  - large served first (starvation limit enforced)
  - large removed from queue
  - small-1, small-2 remain
  - skipCount resets for both (they weren't skipped)

#### It: "After large request is served → skipCounts reset for remaining entries" `[UNIT]`
- **Setup**: Queue with [large (skipCount: 8), small-1, small-2]. Change covers all.
- **Action**: notifyChange('UCT') — large served, removed
- **Expected**:
  - large removed
  - skipCount for small-1, small-2 reset to 0 (not incremented)
  - Fairness resets

#### It: "Mixed sizes: verify fairness over many rounds" `[INTEGRATION]`
- **Setup**: Queue with mix: [tiny (50k), large (500k), small (100k), large (400k), tiny (50k)]. Change tokens simulated to arrive each round covering all sizes.
- **Action**: 
  1. Create 20 rounds of notifyChange
  2. Track which request served in each round
  3. Calculate "fairness index" — how many rounds until each served
- **Expected**:
  - tinys served faster (not starved)
  - larges served eventually
  - Max fairness gap < 15 rounds (no one waits excessively)
  - No request served more than twice out of order

#### It: "Pathological: one request can never be served (amount > total pool) → timeout after 30s, doesn't starve others" `[INTEGRATION]`
- **Setup**: Queue with [impossible: 1000000, possible-1: 100000, possible-2: 100000]. Pool only ever has 200000 available.
- **Action**:
  1. Enqueue all 3
  2. Simulate 30s passing with periodic notifyChange
  3. Each notifyChange shows impossible still insufficient
- **Expected**:
  - possible-1, possible-2 served and removed (skip-ahead works)
  - impossible times out at 30s (not served, cannot be served)
  - Timeout doesn't wait for impossible to fail
  - No deadlock (possible requests complete while impossible pending)

#### It: "Edge: skipCount reaches limit on same notifyChange as another entry would be served → correct ordering" `[UNIT]`
- **Setup**: Queue with [large (skipCount: 9), small, tiny]. Change covers tiny only.
- **Action**: notifyChange('UCT')
- **Expected**:
  - tiny served first (skip-ahead still active, skipCount < 10)
  - large.skipCount incremented to 10
  - small.skipCount incremented to 1
  - On next notifyChange, if change covers large, large served (starvation limit)

#### It: "Concurrent notifyChange calls don't corrupt skipCount" `[UNIT]`
- **Setup**: Queue with [large (skipCount: 5), small-1, small-2]. Multiple notifyChange calls fire before first completes.
- **Action**:
  1. Fire notifyChange('UCT') 3 times synchronously
  2. Await microtask batch
- **Expected**:
  - skipCount increment is atomic (no race, no double-increment)
  - large.skipCount == 6 (exactly +1), not 7 or 8
  - Ordering deterministic

---

### Shared Fixtures

- **RequestQueue with metrics**: Queue that tracks skipCount per entry and request order
- **SkipAheadAnalyzer**: Helper to analyze and verify fairness properties
- **ProbabilisticChangeSimulator**: Simulates random token arrival patterns for stress testing

**Estimated Test Count: 20 tests**

---

## Summary by File

| File | Purpose | Test Count | Type Mix |
|------|---------|-----------|----------|
| **TokenReservationLedger.test.ts** | Core reservation tracking | 35 | 100% UNIT |
| **SpendPlanner.test.ts** | Token selection + queue | 30 | 80% UNIT, 20% INTEGRATION |
| **SpendQueue.test.ts** | Queue lifecycle + timeout | 25 | 80% UNIT, 20% INTEGRATION |
| **PaymentsModule.concurrency.test.ts** | Race condition scenarios | 60 | 100% INTEGRATION |
| **PaymentsModule.send-queue-integration.test.ts** | End-to-end state consistency | 15 | 100% INTEGRATION |
| **SpendQueue.starvation.test.ts** | Fairness + skip-ahead | 20 | 75% UNIT, 25% INTEGRATION |

**Total Estimated Tests: 185 tests**

---

## Testing Infrastructure Needed

### Mocking & Fixtures

1. **TokenPoolBuilder** — Create token pools with configurable status distribution, amounts, coinIds
2. **MockOracle** — Return configurable results: immediate success, delayed proof, split tokens, error scenarios
3. **MockTransport** — Simulate Nostr delivery: immediate, delayed, failed
4. **MockStorage** — In-memory storage, optionally fail on save
5. **SphereTestHarness** — Full Sphere instance with all mocks wired together
6. **LedgerInvariantValidator** — Helper to assert ledger consistency after each operation
7. **ConcurrentTestHelper** — Fire N concurrent operations and collect results

### Timing & Concurrency

- **Mock Date.now()** for timeout testing
- **queueMicrotask coalescing** tests require synchronous execution tracing
- **Promise.all()** with controlled delay injection for race condition testing
- **Timer stubs** via `vi.useFakeTimers()` (Vitest built-in)

### Assertion Helpers

```typescript
// Example helpers (not exhaustive)
expectLedgerInvariant(ledger, tokenPool)  // assert free + reserved == total
expectNoOrphanedReservations(ledger)      // assert size == 0 after cleanup
expectNoDuplicateTokens(tokenPool)        // assert all tokenIds unique
expectQueueFairness(sequence)              // analyze skip-ahead fairness
```

---

## Key Testing Patterns

1. **Invariant assertion on every mutation** — After reserve/cancel/commit, verify ledger math
2. **Async coordination verification** — Confirm notifyChange fires at expected times
3. **State machine transitions** — Track queue entry states (pending → active → resolved/rejected)
4. **Concurrency explosion** — Test N × M combinations of concurrent operations
5. **Time-based edge cases** — Timeout boundaries, TTL expiry, race with cleanup
6. **Cascade testing** — Waterfall sends through change tokens, verify no starvation

---

## Coverage Goals

- **Line coverage**: ≥95% for TokenReservationLedger, SpendPlanner, SpendQueue (core algorithms)
- **Branch coverage**: 100% for error paths and timeout conditions
- **Concurrency coverage**: Every race condition scenario explicitly tested
- **Integration coverage**: Full wallet state consistency verified across all tests

---

## Notes

- All tests are **synchronous-first** where possible (no artificial delays unless testing timeouts)
- Mock timers used sparingly — only for timeout/30s threshold testing
- Fuzz tests use seeded random (deterministic results for reproducibility)
- Stress tests should be marked with `@slow` tag and skipped in CI rapid feedback loop (run only nightly)
- Ledger invariant checks are free — always include them