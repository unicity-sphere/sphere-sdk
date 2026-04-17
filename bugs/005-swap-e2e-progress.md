# Swap E2E Progress — 2026-03-20

## SDK Fixes (all applied, tested)

1. **`_doLoad()` proposal timeout** — `SwapModule.ts:274`: uses `Math.max(proposalTimeoutMs, deal.timeout * 1000)` so proposals survive long e2e runs.

2. **CLI `swap-deposit` handles 'proposed' state** — `cli/index.ts:4549`: waits 120s for acceptance + announce, not just 60s from 'accepted'.

3. **NIP-17 stale timestamp checks removed** — `SwapModule.ts` lines 2312, 2464, 2936, 3027: acceptance/rejection/cancel/error DMs were silently rejected because NIP-17 randomizes `created_at` ±2 days. The swapId uniqueness is sufficient.

4. **MultiAddressTransportMux NIP-17 window** — `MultiAddressTransportMux.ts:383,579`: gift-wrap subscription and fetch filters now subtract `NIP17_TIMESTAMP_RANDOMIZATION` (172800s).

5. **Mux subscription recovery** — `MultiAddressTransportMux.ts`: `onError` handlers for wallet/chat subscriptions now call `scheduleResubscribe()` with 2s debounce, recovering from relay-initiated subscription closures.

## Escrow Fixes (applied)

1. **Durable state store** — `InMemorySwapStateStore` → `DurableSwapStateStore` (WAL with CRC32 + fsync)
2. **Durable NpubRoleMap** — WAL-backed with 3 indexes
3. **messageSender wired** — `sendDM()` via role map, not stubs
4. **Graceful shutdown** — compacts WAL before exit
5. **Cancel DM command** — parties can cancel swaps
6. **Address resolver** — calls `sphere.resolve()` for nametags
7. **maxPendingSwaps enforced**
8. **Party resolution from manifest** — resolves party transport pubkeys from `party_a_address`/`party_b_address` DIRECT addresses, NOT from DM senders
9. **DM dedup via `isRead`** — leverages SDK's `markAsRead()` persistence
10. **DM processing queue** — bounded queue with drain, not drop-on-overflow
11. **L1 disabled** — escrow doesn't need ALPHA blockchain
12. **New wallet identity** — `@test-escrow-swap2` with fresh keypair

## Current E2E Test Status

Steps 0-8 PASS:
- ✅ Wallet creation + nametag registration
- ✅ Faucet topups (BTC for Alice, ETH for Bob)
- ✅ Swap proposal (Alice → Bob)
- ✅ Swap acceptance (Bob, attempt 1)
- ✅ Bob deposit (10 ETH → escrow)
- ✅ Alice deposit (1 BTC → escrow)
- Both in `depositing` state

Step 9 BLOCKED:
- Escrow detects first deposit ("First valid deposit received")
- Escrow does NOT detect second deposit
- Swap stuck at `PARTIAL_DEPOSIT`

## Remaining Issue: Second Deposit Not Detected

The escrow's `payments.receive()` loop runs every 10s but only detects one of two deposits. The `AccountingModule` fires `invoice:payment` for the first deposit and transitions to `PARTIAL_DEPOSIT`, but the second deposit's `invoice:payment` never fires.

Likely causes:
- The deposit invoice has 2 assets (one per party's currency). Both deposits target the same invoice via memo `INV:{invoiceId}:F`. The AccountingModule should attribute them to different asset slots. If both are attributed to the same slot, the second is ignored.
- The `payments.receive()` → `load()` cycle might lose the second deposit token (same race as the invoice token issue)
- The second deposit's token transfer might not be received by the escrow's transport

Next step: add logging to the escrow's `_onInvoicePayment` handler in `swap-orchestrator.ts` to trace which deposits are being attributed and to which asset slots.
