# sphere-sdk #455 — Single-coin faucet flakiness investigation

**Status:** Investigation closed — root cause identified (high confidence).
**Branch:** `investigate/issue-455-faucet-flakiness`
**Related:** sphere-sdk#444, PR #453 (cross-device durability split), sphere-cli PR #45 (operational workaround).

## Symptom

`manual-test-swap-roundtrip.sh` fails consistently at Section 2 (faucet + sync):

```
sphere faucet 100 UCT               # → "✓ Received 100 unicity"
sphere payments sync                # → [Nostr] [AT-LEAST-ONCE] TOKEN_TRANSFER … not durable
                                    #     — leaving 'since' at 0; cooldown 30000ms (attempt 1/3).
sphere payments receive --finalize  # → "No new transfers found."
sphere balance                      # → "No tokens found."
```

The faucet's HTTP API confirms delivery; the relay log shows the TOKEN_TRANSFER landed; the receiver's wallet never materializes the token.

## Soak-script audit — bulk vs single-coin claim confirmed

| Soak | Faucet command | Result |
|---|---|---|
| `manual-test-roundtrip-391.sh` (line 127) | `sphere faucet` | PASS |
| `manual-test-accounting-roundtrip.sh` (lines 154, 161) | `sphere faucet` | PASS |
| `manual-test-full-recovery.sh` (lines 683, 692) | `sphere faucet` | PASS |
| `manual-test-simple-send.sh` (line 82) | `sphere faucet` | PASS |
| **`manual-test-swap-roundtrip.sh` (lines 193, 200)** | **`sphere faucet 100 UCT` / `100 ETH`** | **FAIL** |

Confirmed: only swap-roundtrip uses single-coin faucet; all others use the bare bulk form.

## What "bulk vs single-coin" actually means at the CLI

Pre-PR-#45 sphere-cli (`src/legacy/legacy-cli.ts:3833-3920` at commit 4e28293^):

- Bulk path (`sphere faucet`): `Promise.all` over 7 entries in `DEFAULT_COINS`, fanning out **7 concurrent HTTP POST `/api/v1/faucet/request`** calls.
- Single-coin path (`sphere faucet 100 UCT`): 1 single HTTP POST.

Both paths hit the same endpoint with the same JSON shape `{ unicityId, coin, amount }`. The receiver code path is identical because the faucet service emits an identical Nostr event regardless of the request count (`FaucetService.processFaucetRequest` → `sharedNostrClient.sendTokenTransfer().join()` is per-request, `FaucetService.java:265`).

## Hypothesis verdicts

### H1 — Faucet HTTP API race (bulk returns before publish; single returns after)

**Status: REFUTED at the faucet layer.** The faucet's `processFaucetRequest` blocks on `sharedNostrClient.sendTokenTransfer(...).join()` (`FaucetService.java:265`) BEFORE returning HTTP 200. Bulk and single-coin paths use identical synchronization. There is no in-server publish race that could make the single-coin path race the receiver's subscription window.

### H2 — Asymmetric payload encoding (V6 COMBINED_TRANSFER vs V5)

**Status: REFUTED.** The faucet's `transferToProxyAddress` → `serializeToken` / `serializeTransaction` shape is the same per-request regardless of bulk/single (see `FaucetService.java:234-241`). The receiver's discrimination in `PaymentsModule.handleIncomingTransfer` (`modules/payments/PaymentsModule.ts:16329-16469`) covers all four legacy shapes via the same dispatch; the Sphere-wallet `{sourceToken, transferTx}` shape (which is what the faucet emits) routes identically in both cases. There is no V6 vs V5 split between bulk and single-coin requests.

### H3 — Empty-handler buffer race on outer NostrTransportProvider

**Status: CONFIRMED as a contributing factor for the warn line; partial root cause.**

Reading the flow with MUX active (the default Sphere config):

1. `Sphere.fetchPendingEvents()` (`core/Sphere.ts:2773`) calls `this._transport.fetchPendingEvents()`. `this._transport` is **always the OUTER `NostrTransportProvider`** — `_transport` is never reassigned to the mux/adapter (`core/Sphere.ts:940` is the only write).
2. Outer's `fetchPendingEvents` (`transport/NostrTransportProvider.ts:2724`) does NOT check `_subscriptionsSuppressed`. It unconditionally opens a one-shot subscription and dispatches every collected event through outer's `handleEvent` (`transport/NostrTransportProvider.ts:2814`).
3. The event reaches outer's `handleTokenTransfer` (`transport/NostrTransportProvider.ts:2304`). In MUX mode, **PaymentsModule registered its handler on the address ADAPTER, not on the outer** (`modules/payments/PaymentsModule.ts:2074` uses `deps.transport.onTokenTransfer`, and `deps.transport` is the adapter — `core/Sphere.ts:3851`).
4. Outer's `transferHandlers.size === 0` → event is pushed to `pendingTransfers` buffer (`transport/NostrTransportProvider.ts:2369-2376`) → **`return false`**.
5. Back in `handleEvent`, `recordDurabilityMiss(event.id)` arms the cooldown ledger and emits the exact warn line from the issue body: `[AT-LEAST-ONCE] TOKEN_TRANSFER … not durable — leaving 'since' at 0; cooldown 30000ms (attempt 1/3)`.

This is the source of the warn line. **It is a benign side effect on the outer subscriber** — the actual receive of the token happens later via `payments.receive()` → mux adapter's `fetchPendingEvents` → `mux.fetchPendingEvents()` → `mux.handleEvent` → `entry.adapter.dispatchTokenTransfer` → PaymentsModule's handler.

However, H3 in isolation does NOT explain the missing token. The mux's `dispatchTokenTransfer` (`transport/MultiAddressTransportMux.ts:2286-2298`) fires the handler. The token addToken should run.

### H3-Extension (NEW finding) — Mux dispatch is fire-and-forget

This was uncovered in the H3 trace and is the **most likely structural root cause of the missing-token symptom** (not the warn line).

In `MultiAddressTransportMux.handleEvent → handleTokenTransfer → adapter.dispatchTokenTransfer`:

```typescript
// transport/MultiAddressTransportMux.ts:2296-2298
for (const handler of this.transferHandlers) {
  try { handler(transfer); } catch (e) { logger.debug('MuxAdapter', 'Transfer handler error:', e); }
}
```

The handler is `PaymentsModule.handleIncomingTransfer` — an **async** function. `handler(transfer)` returns a Promise; the loop body does NOT `await` it. The mux's `handleTokenTransfer` returns immediately after dispatching; `fetchPendingEvents` then iterates the next event; `payments.receive()`'s `await this.deps!.transport.fetchPendingEvents()` resolves while the handlers are still in flight.

Compare with `NostrTransportProvider.handleTokenTransfer` (`transport/NostrTransportProvider.ts:2380-2389`) which does `await handler(transfer)` and aggregates the durability signal — the correct contract.

**Impact:** `payments.receive()`'s subsequent `await this.load()` (`modules/payments/PaymentsModule.ts:8192`) may read storage before any handler has finished writing. With 7 bulk events, the time budget per-event averages out and some handlers complete in time. With 1 single-coin event, the race is binary — either the handler beats `load()` or it doesn't.

This explains the bulk-vs-single asymmetry: bulk wins by sheer luck (more chances for SOMETHING to complete in time); single is a clean coin-flip every run.

### H4 — Relay event retention

**Status: REFUTED on the available evidence.** Two independent reasons:

1. `fetchPendingEvents` filters use `since = now - 86400 - 172800` (outer: `NostrTransportProvider.ts:2757`; mux: `MultiAddressTransportMux.ts:758`) — a 3-day lookback. Even an aggressive relay-side TTL would have to drop events within seconds for this to fire, which contradicts the steady operation of every other soak.
2. The issue's own log line shows the event ID makes it to the receiver (`TOKEN_TRANSFER ae59acc8f979 not durable`) — meaning the relay DID deliver the event. Retention can't be the cause when the event reaches the receiver's transport layer.

The H4 hypothesis appears to have been a misdirection from the warn message's wording ("leaving 'since' at …") — the cursor is left pinned because the durability gate fired, not because the relay dropped anything.

## Root cause (high confidence)

The dominant root cause of the single-coin faucet flakiness is **H3-Extension: `MuxAdapter.dispatchTokenTransfer` is fire-and-forget**, breaking the await chain between `payments.receive()`'s `fetchPendingEvents` and the receive handler's completion. The auxiliary H3 (outer's empty-handler buffer) produces the cosmetic `[AT-LEAST-ONCE] not durable` warn line but does not by itself cause token loss.

Why bulk masked this for ~2 years:

- Bulk fan-out (`Promise.all` over 7 coins) produced 7 separate Nostr events with staggered arrival.
- The mux's fire-and-forget dispatch runs all 7 handler Promises in parallel.
- Even if one handler races `load()`, the next round of `payments.receive()` (called from `balance`, `tokens`, `history`, etc., each of which does its own `ensureSync`) gets another shot.
- With multiple events in flight, the wall-clock load() landing is statistically more likely to capture AT LEAST ONE token write — and the soaks' assertions usually only check "did SOMETHING land", not "did EXACTLY ONE specific coin land".
- Single-coin requests fail in a binary way: the one Promise wins or loses against load().

## Why sphere-cli PR #45 (local mint) closes the issue procedurally

PR #45 replaced the HTTP-faucet path with `sphere.payments.mintFungibleToken()` — a synchronous, in-process L3 aggregator mint that returns AFTER addToken has run. No Nostr round trip, no mux dispatch race. The fix is correct as an operational workaround but does not address the underlying SDK defect.

## Suggested next steps (in priority order)

### 1. Fix `MuxAdapter.dispatchTokenTransfer` to await + collect durability

Change `transport/MultiAddressTransportMux.ts:2286-2299` to await the handler Promise and propagate its boolean return value back through the mux's `handleEvent` chain so the `since` cursor advance honours the existing at-least-once invariant. Concretely:

```typescript
// transport/MultiAddressTransportMux.ts
async dispatchTokenTransfer(transfer: IncomingTokenTransfer): Promise<boolean> {
  if (this.transferHandlers.size === 0) {
    this.pendingTransfers.push(transfer);
    return false; // not durable — replay on next reconnect
  }
  let allDurable = true;
  for (const handler of this.transferHandlers) {
    try {
      const result = await handler(transfer);
      if (result === false) allDurable = false;
    } catch (e) {
      logger.debug('MuxAdapter', 'Transfer handler error:', e);
      allDurable = false;
    }
  }
  return allDurable;
}
```

Then `MultiAddressTransportMux.handleTokenTransfer` (`MultiAddressTransportMux.ts:1331`) must await the new boolean and gate `updateLastEventTimestamp` accordingly — same pattern as `NostrTransportProvider.handleEvent` does for outer events.

This is a structural fix; it eliminates the bulk-vs-single asymmetry entirely and also makes `sphere payments sync` deterministic for ANY single inbound event (faucet, P2P send, swap deposit, etc.).

### 2. Suppress the outer's `fetchPendingEvents` when mux is active

Check `_subscriptionsSuppressed` at the top of `NostrTransportProvider.fetchPendingEvents` (`transport/NostrTransportProvider.ts:2724`) and short-circuit when mux owns dispatch. This eliminates the spurious `[AT-LEAST-ONCE] not durable` warn storm and prevents the outer's cooldown ledger from being polluted with event IDs it can't actually process.

The current code unconditionally subscribes; the implicit assumption that "outer handlers will eventually drain" is false in steady-state mux mode (the outer's handler set stays empty forever).

### 3. Add a unit test that exercises the mux dispatch race

A test that registers a slow async handler on the mux adapter, fires a single TOKEN_TRANSFER, and asserts that `mux.fetchPendingEvents()` returns ONLY AFTER the handler resolved would lock in the fix from step 1.

### 4. Document the fix as the resolution of #455 (re-open then close)

PR #45 is the operational workaround; the SDK-layer fix from (1)+(2)+(3) is the proper resolution. Worth a follow-up PR even though the faucet is no longer in the failure path.

## File / line index

- `transport/NostrTransportProvider.ts:2304-2390` — outer handleTokenTransfer, including buffer race and durability return
- `transport/NostrTransportProvider.ts:2724-2821` — outer fetchPendingEvents (unconditional subscribe)
- `transport/NostrTransportProvider.ts:1740-1830` — at-least-once cursor + cooldown ledger
- `transport/MultiAddressTransportMux.ts:734-815` — mux fetchPendingEvents
- `transport/MultiAddressTransportMux.ts:1078-1100` — mux handleEvent (dedup)
- `transport/MultiAddressTransportMux.ts:1331-1347` — mux handleTokenTransfer
- `transport/MultiAddressTransportMux.ts:2286-2299` — **mux dispatchTokenTransfer (fire-and-forget — THE BUG)**
- `modules/payments/PaymentsModule.ts:2074-2076` — PaymentsModule handler registration on adapter
- `modules/payments/PaymentsModule.ts:8153-8210` — `payments.receive()` flow (fetchPendingEvents → load race)
- `modules/payments/PaymentsModule.ts:16229-16567` — handleIncomingTransfer (the handler that gets fire-and-forgotten)
- `core/Sphere.ts:2773-2777` — Sphere.fetchPendingEvents (calls outer, not mux)
- `core/Sphere.ts:3842-3851` — MUX suppression + adapter wiring
- `tests/e2e/cross-process-nostr-delivery-223.test.ts:127-148` — `topUp` polls in a loop, MASKING the race in e2e tests
- `tests/e2e/helpers.ts:226-232` — `requestMultiCoinFaucet` uses 500 ms sequential stagger (different shape from CLI's `Promise.all`)
- `unicity-faucet/src/main/java/org/unicitylabs/faucet/FaucetService.java:125-286` — service-side `processFaucetRequest` (identical for bulk/single, refutes H1+H2)
- `unicity-faucet/src/main/java/org/unicitylabs/faucet/FaucetServer.java:108-217` — HTTP handler (returns AFTER Nostr publish)

## Caveats / what I could NOT verify in this pass

- I did NOT run the soak end-to-end to observe the race fire live with `DEBUG=Nostr`. The conclusion rests on code reading + log-line matching against the issue body.
- I did NOT verify whether the recently-merged PR #453 (split local-commit / remote-publish) interacts with the mux race in a way that changes the failure shape. PR #453 changes `awaitAllProvidersDurable` semantics, but only matters when the handler IS awaited — which the mux fire-and-forget bypasses.
- The proposed fix in "Suggested next steps (1)" is sketched, not implemented in this branch. The investigation deliverable per the issue scope is the diagnosis; the structural change to the mux dispatch contract is a non-trivial follow-up that wants its own PR + steelman + soak.
