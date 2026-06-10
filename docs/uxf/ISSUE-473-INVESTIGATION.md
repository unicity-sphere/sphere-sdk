# Issue #473 — Cross-process Nostr DM flakiness: root cause + defensive fix

**Status:** Investigation report. No source files were modified; no fix has been applied.

**Scope:** Hard dependency for #474 (trader-roundtrip soak). Controller-CLI ↔ tenant DM hops are cross-process; a single missed swap-proposal DM breaks the whole soak.

---

## TL;DR

The Mux's chat-side `since` cursor advances to **wall-clock-now at unwrap time**, BEFORE the async DM handler (SwapModule's `handleIncomingDM`) has run to completion — and BEFORE the storage write is flushed. The chat filter's `-NIP17_TIMESTAMP_RANDOMIZATION` (172800s) buffer compensates for ±2-day NIP-17 timestamp randomization, but NOT for the residual case where the receiver's CLI exits (or crashes, or is killed in the soak loop's 3 s budget) between the cursor advance and the handler's swap-persistence. The next CLI boot then re-subscribes with `since = lastDmTs - 172800` — and because `lastDmTs` was advanced past alice's *publish* time while alice's *randomized* `created_at` can be up to 172800 s earlier than that, alice's gift-wrap is filtered out by the relay for the rest of the soak. **Single smallest fix: in `MultiAddressTransportMux.routeGiftWrap`, move the `updateLastDmEventTimestamp` call from line 1173 to AFTER `await entry.adapter.dispatchMessage(...)` — and widen the look-back buffer used at subscription time from `NIP17_TIMESTAMP_RANDOMIZATION` to `2 * NIP17_TIMESTAMP_RANDOMIZATION` to belt-and-brace against the worst-case wall-clock-vs-randomization window.**

---

## Mechanism rankings

### M1: `since` cursor advances past the DM's `created_at` — **BLOCKING**

This is the root cause. The Mux advances the persisted chat-side `since` cursor (`lastDmEventTs`) using **wall-clock time at unwrap**, NOT the event's `created_at`. The reason given in the code comment (line 1171-1172) is that NIP-17 randomization can place `created_at` in the future, but the side effect is that `lastDmTs` is **always strictly greater than the actual publish time** of the event that advanced it. A subsequent subscription opens with `since = lastDmTs - NIP17_TIMESTAMP_RANDOMIZATION`. Worst-case math:

- Alice publishes gift-wrap at `T_pub`. NIP-17 randomization (`TIMESTAMP_RANDOMIZATION = 172800 s`, line 110 in `NostrTransportProvider.ts`; alias `NIP17_TIMESTAMP_RANDOMIZATION` line 79 in the Mux) places `event.created_at` uniformly in `[T_pub - 172800, T_pub + 172800]`. Worst-case low: `event.created_at = T_pub - 172800`.
- Bob's wallet processes (unwraps) the event at `T_proc`. `T_proc > T_pub` (causality). The cursor advances to `lastDmTs = T_proc` (wall-clock).
- Next subscription opens with `since = T_proc - 172800`.
- The relay returns `event.created_at >= since`. For alice's worst-case event: `T_pub - 172800 >= T_proc - 172800` ⇔ `T_pub >= T_proc`. **False** (T_proc > T_pub by construction).
- Alice's event is filtered out by the relay for every subsequent boot.

The buffer only catches the **publish-time-to-cursor-advance gap** of 172800 s. If the cursor was advanced *before the handler completed* and the handler then failed to persist the swap (CLI exited, process killed, handler threw), the event is **permanently invisible** to bob until alice republishes — which the soak never does.

#### Evidence

`transport/MultiAddressTransportMux.ts` lines 1162-1310 (`routeGiftWrap`):

```typescript
private async routeGiftWrap(event: NostrEvent): Promise<void> {
  for (const entry of this.addresses.values()) {
    try {
      const pm = NIP17.unwrap(event as any, entry.keyManager);

      // Successfully decrypted — route to this address.
      // Persist DM timestamp after successful unwrap so failed decryptions
      // do not advance the since filter and permanently skip events.
      // Use real wall-clock time, NOT event.created_at — NIP-17 gift wraps
      // randomize created_at by ±2 days for privacy, so it can be in the future.
      this.updateLastDmEventTimestamp(entry, Math.floor(Date.now() / 1000));  // <-- LINE 1173
      // ... long async chain follows: dispatch read receipts, composing
      //     indicators, handler calls (entry.adapter.dispatchMessage), etc.
      //     All `await`s, but the cursor is already advanced.
```

`transport/MultiAddressTransportMux.ts` lines 1706-1716:

```typescript
private updateLastDmEventTimestamp(entry: AddressEntry, createdAt: number): void {
  if (!this.storage) return;
  if (createdAt <= entry.lastDmEventTs) return;

  entry.lastDmEventTs = createdAt;
  const storageKey = `${STORAGE_KEYS_GLOBAL.LAST_DM_EVENT_TS}_${entry.nostrPubkey.slice(0, 16)}`;

  this.storage.set(storageKey, createdAt.toString()).catch(err => {
    logger.debug('Mux', 'Failed to save last DM event timestamp:', err);
  });
}
```

`transport/MultiAddressTransportMux.ts` lines 983-990 (`updateSubscriptions` chat filter):

```typescript
const chatFilter = new Filter();
chatFilter.kinds = [EventKinds.GIFT_WRAP];
chatFilter['#p'] = allPubkeys;
// NIP-17 gift wraps have created_at randomized ±2 days for privacy.
// Without this offset, ~50% of messages are silently dropped by the relay
// because their randomized timestamp lands before the `since` filter.
// Math.max(0, ...) prevents negative timestamps when globalDmSince is small.
chatFilter.since = Math.max(0, globalDmSince - NIP17_TIMESTAMP_RANDOMIZATION);
```

`transport/MultiAddressTransportMux.ts` lines 1718-1750 (`getAddressDmSince` — reads stored cursor on boot):

```typescript
private async getAddressDmSince(entry: AddressEntry): Promise<number> {
  if (this.storage) {
    const storageKey = `${STORAGE_KEYS_GLOBAL.LAST_DM_EVENT_TS}_${entry.nostrPubkey.slice(0, 16)}`;
    try {
      const stored = await this.storage.get(storageKey);
      const parsed = stored ? parseInt(stored, 10) : NaN;
      if (Number.isFinite(parsed)) {
        entry.lastDmEventTs = parsed;
        entry.fallbackDmSince = null;
        return parsed;
      }
      // ... fallthrough to fallback or wall-clock now
```

The chat handler chain after line 1173 includes (per `routeGiftWrap` body):
- NIP-17 unwrap of `pm.content` (CPU only).
- `entry.adapter.dispatchMessage(message)` — **awaits** SwapModule's `handleIncomingDM`, which itself awaits **multiple `deps.resolve(counterpartyAddress)` calls** (see `modules/swap/SwapModule.ts` lines 2789, 2847, 2888). Each `resolve` issues a `queryEvents` against the relay for nametag binding events; the default query timeout is **60 seconds** (`NostrTransportProvider.DEFAULT_QUERY_TIMEOUT_MS = 60000`, line 2831).

`modules/swap/SwapModule.ts` line 2789:

```typescript
const counterpartyAddress = isPartyA ? manifest.party_b_address : manifest.party_a_address;
try {
  const counterpartyPeer = await deps.resolve(counterpartyAddress);
  if (counterpartyPeer) {
    if (!counterpartyPeer.transportPubkey || counterpartyPeer.transportPubkey !== dm.senderPubkey) {
      // ... reject silently
      return;
    }
  }
```

The CLI flow in `sphere-cli-work/sphere-cli/src/legacy/legacy-cli.ts` line 885-927 (`ensureSync`):

```typescript
async function ensureSync(sphere: Sphere, mode: 'nostr' | 'full'): Promise<void> {
  console.log('Syncing...');
  try {
    await sphere.fetchPendingEvents();
    // Allow async DM handlers (swap proposal processing, invoice import, etc.)
    // to complete before reading in-memory state.
    await new Promise(resolve => setTimeout(resolve, 500));
  } catch { /* ... */ }
  // ...
}
```

The CLI grants async handlers **only 500 ms** of grace. With nametag-resolve queries taking 200 ms - 7 s on a healthy relay (the same window cited in `NostrTransportProvider.ts` comments line 442 and in `DEFAULT_QUERY_TIMEOUT_MS`'s 60s setting), 500 ms is **insufficient** for the handler chain to persist the swap before `swap list` reads `swapModule.getSwaps()`. So in any iteration where the soak's 3 s loop kills the CLI before the handler completes, **the cursor is already advanced but the swap is never persisted**.

#### Verdict: BLOCKING

The cursor-advance-before-handler-completes ordering plus worst-case NIP-17 randomization is sufficient to permanently lose alice's event after any handler-incomplete iteration. The 172800 s buffer is exactly cancelled by the worst-case `created_at = T_pub - 172800` shift, leaving zero net safety margin.

---

### M2: NIP-17 ±2-day randomization for wallet events — **UNLIKELY**

The Mux subscribes with `chatFilter.kinds = [GIFT_WRAP]` for NIP-17 wraps (with the `-NIP17_TIMESTAMP_RANDOMIZATION` compensation) and with a separate `walletFilter.kinds = [DIRECT_MESSAGE, TOKEN_TRANSFER, PAYMENT_REQUEST, PAYMENT_REQUEST_RESPONSE]` for non-NIP-17 events (with NO compensation). The non-NIP-17 wallet events use the real publish time as `created_at`, so no buffer is needed.

#### Evidence

`transport/MultiAddressTransportMux.ts` lines 949-958:

```typescript
const walletFilter = new Filter();
walletFilter.kinds = [
  EVENT_KINDS.DIRECT_MESSAGE,
  EVENT_KINDS.TOKEN_TRANSFER,
  EVENT_KINDS.PAYMENT_REQUEST,
  EVENT_KINDS.PAYMENT_REQUEST_RESPONSE,
];
walletFilter['#p'] = allPubkeys;
walletFilter.since = globalSince;   // <-- no -RANDOMIZATION offset
```

Swap proposals are routed through `CommunicationsModule.sendDM` → `transport.sendMessage` → `NIP17.createGiftWrap` (see `transport/NostrTransportProvider.ts` lines 789-820), which **always** writes kind 1059 GIFT_WRAP — so they flow through the chat filter, not the wallet filter. The wallet-filter asymmetry is appropriate for its intended kinds.

#### Verdict: UNLIKELY

The asymmetry exists but is correct: DIRECT_MESSAGE (kind 4) is documented as deprecated for DMs (see `transport/MultiAddressTransportMux.ts` line 1321 and `NostrTransportProvider.ts` line 2142), and TOKEN_TRANSFER / PAYMENT_REQUEST events are plain (non-randomized). M2 is the hypothesis in #473's body that I was specifically asked to walk; it does not apply to the swap-proposal path.

---

### M3: Subscription armed AFTER `now`, race-window event lost — **UNLIKELY**

The Mux opens its persistent subscription with `since = lastDmTs - 172800` (or `now - 172800` for a fresh wallet), NOT with `since = now`. The relay returns all stored events with `created_at >= since`, including those published in the window `[since, now_at_sub_open]`. As long as the relay persists the event durably (which #473 confirms — "same soak retried within the next minute passes cleanly" — the event IS on the relay), the open subscription's `since` filter will return it on the next REQ.

#### Evidence

`transport/MultiAddressTransportMux.ts` lines 887-1029 (`updateSubscriptions`). The `since` value is computed from persisted state, not from `Date.now()` at subscription open. The only race that M3 could describe is a missed event between `mux.connect()` (which DOES `updateSubscriptions` if the gate isn't suppressed) and a later `armSubscriptions()` call. But Sphere bootstrap explicitly **suppresses subscriptions before connect** (`Sphere.ts` line 4369) and **arms after modules load** (`Sphere.ts` line 7781), so the gate ensures the live subscription is open by the time the CLI calls `fetchPendingEvents`.

The auto-arm in the `onMessage` registration path (line 832 in `NostrTransportProvider.ts`) handles backward-compat with consumers that don't call `armSubscriptions` explicitly.

#### Verdict: UNLIKELY

The relay's stored-event replay model means a subscription opened at time T sees events with `created_at >= since` regardless of when T is. The persistence of the event (confirmed by #473's "same soak retried passes cleanly") rules out lost events from this mechanism.

---

### M4: EOSE delivered before relay finishes streaming backlog — **UNLIKELY in isolation**

The Nostr protocol guarantees the relay sends all stored matching events BEFORE the `EOSE` notice. The SDK's one-shot fetch path (`NostrTransportProvider.fetchPendingEvents` line 2724, Mux `fetchPendingEvents` line 734) collects events into an array and only iterates after `settle()` fires on EOSE. So a "premature EOSE" would have to be a relay protocol violation.

However, M4 has a **derivative** flavor that DOES contribute: **the LIVE chat subscription's `onEvent` callbacks are fire-and-forget from the NostrClient's perspective** — the Mux's `handleEvent` is `async`, but the client just calls it and continues. So when the *one-shot* subscription's EOSE fires (which is what `fetchPendingEvents` waits for), the *live* chat subscription may have already received the backlog event but its async `handleEvent` chain (NIP-17 unwrap → `routeGiftWrap` → `dispatchMessage` → SwapModule's network resolves) is **still running**. The CLI's 500 ms grace (`ensureSync` line 897) is far less than the worst-case handler chain time.

This isn't strictly M4 — it's a **handler-completion race**. EOSE is not a handler-completion barrier. The fix in PR #465 made `dispatchMessage` await async handlers per the at-least-once invariant, but that only helps callers that **await `handleEvent` themselves** (which the one-shot `fetchPendingEvents` path does because it iterates events sequentially and awaits each `handleEvent`). The live subscription doesn't await its own callbacks.

#### Evidence

`transport/MultiAddressTransportMux.ts` line 962-981 (live wallet subscription `onEvent` is a plain callback wrapping `this.handleEvent(event)` — the Promise is discarded):

```typescript
this.walletSubscriptionId = this.nostrClient.subscribe(walletFilter, {
  onEvent: (event) => {
    this.handleEvent({  // <-- async, NOT awaited by the client
      id: event.id, ...
    });
  },
  // ...
});
```

Same pattern at line 992-1017 for the chat subscription.

#### Verdict: UNLIKELY in pure-EOSE form; **contributes** in handler-completion form

Combined with M1, the handler-completion race is what makes the "intermittent" character match: when alice's randomization happens to land low AND the receiver's CLI exits before the handler completes, the cursor moves but the swap doesn't.

---

### M5: Relay state divergence between writes and reads — **INCONCLUSIVE**

A Nostr relay can in principle accept an event on one connection but fail to serve it on another — quorum issues, transient indexing lag, replication delay. #473 reports that "same soak retried within the next minute passes cleanly," which suggests the relay DOES store the event durably (consistent with M1, where the event is on-relay but the *filter* excludes it). But this doesn't fully rule out relay-side issues — a brief indexing gap immediately after publish could cause the receiver's first subscription to miss the event, and the cursor-advance from any unrelated DM in that window would then permanently exclude it.

#### Evidence

No code-level evidence available. Would need relay-side logs to confirm or deny.

#### Verdict: INCONCLUSIVE

Cannot rule out from the SDK side; the M1-shaped fix below is robust against this case too, because the widened look-back buffer covers transient indexing lag.

---

## Recommended fix (THE LOAD-BEARING SECTION)

The single smallest fix that closes the #473 symptom is **two surgical changes inside `transport/MultiAddressTransportMux.ts`**, no API changes, no impact on other call sites.

### Change 1: defer the chat cursor advance until after the handler completes

**File:** `transport/MultiAddressTransportMux.ts`
**Function:** `routeGiftWrap`
**Lines:** 1162-1310 (the relevant edits cluster around line 1173 and at every `return` / fall-through point in the function body)

**Current code (line 1162-1175):**

```typescript
  private async routeGiftWrap(event: NostrEvent): Promise<void> {
    for (const entry of this.addresses.values()) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pm = NIP17.unwrap(event as any, entry.keyManager);

        // Successfully decrypted — route to this address.
        // Persist DM timestamp after successful unwrap so failed decryptions
        // do not advance the since filter and permanently skip events.
        // Use real wall-clock time, NOT event.created_at — NIP-17 gift wraps
        // randomize created_at by ±2 days for privacy, so it can be in the future.
        this.updateLastDmEventTimestamp(entry, Math.floor(Date.now() / 1000));
        logger.debug('Mux', `Gift wrap decrypted by address ${entry.index}, sender: ${pm.senderPubkey?.slice(0, 16)}`);
```

**Proposed diff (conceptual — capture the timestamp once but defer the persist):**

```diff
@@ transport/MultiAddressTransportMux.ts:1162-1175 @@
   private async routeGiftWrap(event: NostrEvent): Promise<void> {
     for (const entry of this.addresses.values()) {
       try {
         // eslint-disable-next-line @typescript-eslint/no-explicit-any
         const pm = NIP17.unwrap(event as any, entry.keyManager);

-        // Successfully decrypted — route to this address.
-        // Persist DM timestamp after successful unwrap so failed decryptions
-        // do not advance the since filter and permanently skip events.
-        // Use real wall-clock time, NOT event.created_at — NIP-17 gift wraps
-        // randomize created_at by ±2 days for privacy, so it can be in the future.
-        this.updateLastDmEventTimestamp(entry, Math.floor(Date.now() / 1000));
+        // Issue #473 — capture the cursor candidate but DO NOT persist yet.
+        // We must not advance `lastDmEventTs` past `event.created_at`'s
+        // worst-case randomization shift (-172800 s) until the handler has
+        // observed the event, otherwise CLI processes that exit between
+        // unwrap and handler-completion permanently lose the event on the
+        // next boot's `since = lastDmTs - 172800` subscription filter.
+        const cursorCandidate = Math.floor(Date.now() / 1000);
+        // Track whether dispatch completed so we can advance the cursor in
+        // a single place at the end of the unwrap-success branch.
+        let dispatched = false;
         logger.debug('Mux', `Gift wrap decrypted by address ${entry.index}, sender: ${pm.senderPubkey?.slice(0, 16)}`);
```

Then at the END of the unwrap-success branch — after `await entry.adapter.dispatchMessage(...)` (lines ~1211, ~1284, ~1304) — and before each `return`, add:

```diff
         await entry.adapter.dispatchMessage(message);
+        dispatched = true;
         return; // Successfully routed, stop trying other addresses
```

Finally, at the bottom of the per-entry `try` block (just before the `} catch { continue; }` at line 1306-1309), centralize the cursor-advance:

```diff
         await entry.adapter.dispatchMessage(message);
+        dispatched = true;
         return; // Successfully routed, stop trying other addresses
       } catch {
         // Decryption failed for this address — try next
         continue;
+      } finally {
+        // Issue #473 — only advance the cursor if the dispatch completed.
+        // If the handler threw or the process is in shutdown, we leave
+        // `lastDmTs` unchanged so the next boot's chat subscription's
+        // `since` filter still includes alice's event.
+        if (dispatched) {
+          this.updateLastDmEventTimestamp(entry, cursorCandidate);
+        }
       }
     }
```

Note: a `try/finally` inside the `for (entry of …)` loop is the cleanest way to ensure the cursor-advance runs exactly once per successful dispatch. Alternative: hoist `let dispatched` outside the loop and move the advance after the loop. Either is acceptable; the diff above keeps per-entry locality.

**Caveat:** "dispatched" here means `await dispatchMessage` returned without throwing. Per the at-least-once invariant work in PR #465, `dispatchMessage` already awaits all registered handlers. If a handler throws inside its own async body, `Promise.allSettled` (used by the adapter's dispatch chain) means the dispatch itself does NOT throw — so `dispatched = true` would still fire. That's the right semantics: we have done our best to deliver, and replaying the same event on next boot is wasteful (Mux dedup short-circuits). The real escape hatch is the next change.

### Change 2: widen the chat-filter look-back buffer

**File:** `transport/MultiAddressTransportMux.ts`
**Line:** 990

**Current code:**

```typescript
chatFilter.since = Math.max(0, globalDmSince - NIP17_TIMESTAMP_RANDOMIZATION);
```

**Proposed diff:**

```diff
@@ transport/MultiAddressTransportMux.ts:983-990 @@
     const chatFilter = new Filter();
     chatFilter.kinds = [EventKinds.GIFT_WRAP];
     chatFilter['#p'] = allPubkeys;
     // NIP-17 gift wraps have created_at randomized ±2 days for privacy.
     // Without this offset, ~50% of messages are silently dropped by the relay
     // because their randomized timestamp lands before the `since` filter.
     // Math.max(0, ...) prevents negative timestamps when globalDmSince is small.
-    chatFilter.since = Math.max(0, globalDmSince - NIP17_TIMESTAMP_RANDOMIZATION);
+    // Issue #473 — DOUBLE the buffer (4 days instead of 2). Two-day buffer
+    // exactly cancels the worst-case NIP-17 randomization (created_at can be
+    // T_pub - 172800), leaving zero net margin when `lastDmTs` was advanced
+    // by a sibling DM that landed AFTER alice's publish but BEFORE alice's
+    // event was observed. Doubling the buffer gives the receiver up to 2 d
+    // of slack between the wall-clock cursor and the worst-case publish
+    // time — enough to cover (a) `lastDmTs` advancing past `T_pub` due to
+    // unrelated DMs, (b) CLI handler-exit-before-completion (the half-bug
+    // Change 1 closes belt-and-brace style), and (c) brief relay indexing
+    // lag (M5). Bounded re-delivery is absorbed by `processedEventIds`
+    // dedup (issue #275 — persistent dedup across process restarts).
+    chatFilter.since = Math.max(0, globalDmSince - 2 * NIP17_TIMESTAMP_RANDOMIZATION);
```

### Change 2b (mirror): apply the same widening to NostrTransportProvider

**File:** `transport/NostrTransportProvider.ts`
**Line:** 3148

The original (non-mux) provider has the same buffer pattern in `subscribeToEvents`. To keep the fix internally consistent (tests cover this path), mirror Change 2:

```diff
@@ transport/NostrTransportProvider.ts:3141-3148 @@
     const chatFilter = new Filter();
     chatFilter.kinds = [EventKinds.GIFT_WRAP];
     chatFilter['#p'] = [nostrPubkey];
     // NIP-17 gift wraps have created_at randomized ±2 days for privacy.
-    // Without this offset, ~50% of messages are silently dropped by the relay
-    // because their randomized timestamp lands before the `since` filter.
-    // Math.max(0, ...) prevents negative timestamps when dmSince is small.
-    chatFilter.since = Math.max(0, dmSince - TIMESTAMP_RANDOMIZATION);
+    // Issue #473 — see MultiAddressTransportMux:990 for full rationale.
+    chatFilter.since = Math.max(0, dmSince - 2 * TIMESTAMP_RANDOMIZATION);
```

### New constant? Not necessary.

Both `NIP17_TIMESTAMP_RANDOMIZATION` (line 79 in the Mux) and `TIMESTAMP_RANDOMIZATION` (line 110 in NostrTransportProvider) are already named constants. Doubling them inline with a comment is more readable than introducing `CHAT_SINCE_BUFFER_MS`. The 2× factor is justified by the worst-case math in M1 (see "Why this matches" below).

If a follow-up wants a tunable knob, the cleanest addition is:

```typescript
// transport/MultiAddressTransportMux.ts (near line 79)
/** Multiplier applied to NIP-17 randomization when computing chat-filter
 *  `since`. Larger than 1 covers the worst-case window where the persisted
 *  cursor was advanced past the event's randomized `created_at` (issue #473).
 *  1.0 → no extra margin (pre-#473 behavior).
 *  2.0 → 2-day safety margin (current).
 *  Each step doubles the relay backlog returned on subscription open; dedup
 *  short-circuits the cost downstream. */
const CHAT_SINCE_BUFFER_MULTIPLIER = 2;
```

Then `chatFilter.since = Math.max(0, globalDmSince - CHAT_SINCE_BUFFER_MULTIPLIER * NIP17_TIMESTAMP_RANDOMIZATION)`. Optional.

### Tests to add

#### Test 1 — `routeGiftWrap` does not advance the cursor when dispatch throws

**File:** `tests/unit/transport/MultiAddressTransportMux.dispatch-await.test.ts` (extend existing) **or** new file `MultiAddressTransportMux.cursor-defer-473.test.ts`.

```typescript
it('[#473] should NOT advance lastDmEventTs when the dispatch handler throws', async () => {
  // Setup: mux with one address, a registered handler that rejects.
  const persistedTimestamps: number[] = [];
  const mockStorage = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockImplementation((key: string, value: string) => {
      if (key.startsWith(STORAGE_KEYS_GLOBAL.LAST_DM_EVENT_TS)) {
        persistedTimestamps.push(parseInt(value, 10));
      }
      return Promise.resolve();
    }),
  };
  const mux = createMuxWithStorage(mockStorage);
  await mux.addAddress(0, identity, null);
  await mux.armSubscriptions();

  const adapter = mux.getAdapter(0);
  adapter.onMessage(() => { throw new Error('handler failed'); });

  // Simulate a gift wrap arriving via the live subscription's onEvent callback.
  await mux.__test_dispatchGiftWrap(craftGiftWrap({ recipient: identity.transportPubkey }));

  // Cursor should NOT be persisted: handler threw before dispatch completed.
  expect(persistedTimestamps).toEqual([]);
});
```

#### Test 2 — `routeGiftWrap` advances the cursor after successful dispatch

```typescript
it('[#473] should advance lastDmEventTs AFTER dispatchMessage resolves', async () => {
  const handlerCompleted = new Deferred<void>();
  const mockStorage = makeMockStorageWithPersistTracking();
  const mux = createMuxWithStorage(mockStorage);
  await mux.addAddress(0, identity, null);
  await mux.armSubscriptions();

  const adapter = mux.getAdapter(0);
  adapter.onMessage(async () => {
    // Simulate a slow handler (e.g., SwapModule's resolve calls).
    await new Promise((r) => setTimeout(r, 100));
    handlerCompleted.resolve();
  });

  const beforeDispatch = Math.floor(Date.now() / 1000);
  await mux.__test_dispatchGiftWrap(craftGiftWrap(...));
  await handlerCompleted.promise;

  expect(mockStorage.lastDmTimestamps).toHaveLength(1);
  expect(mockStorage.lastDmTimestamps[0]).toBeGreaterThanOrEqual(beforeDispatch);
});
```

#### Test 3 — chat-filter `since` uses 2 × randomization

**File:** `tests/unit/transport/NostrTransportProvider.test.ts` (extend the existing test at line 724-749).

```typescript
it('[#473] should apply 2× NIP-17 randomization buffer to chat since filter', async () => {
  const mockStorage = {
    get: vi.fn().mockImplementation((key: string) => {
      if (key.startsWith('last_wallet_event_ts_')) return Promise.resolve('1700000000');
      if (key.startsWith('last_dm_event_ts_')) return Promise.resolve('1699999000');
      return Promise.resolve(null);
    }),
    set: vi.fn().mockResolvedValue(undefined),
  };
  const provider = createProviderWithStorage(mockStorage);
  setIdentity(provider);
  await provider.connect();
  await provider.armSubscriptions();
  await new Promise(resolve => setTimeout(resolve, 50));

  expect(mockSubscribe).toHaveBeenCalledTimes(2);
  const [chatFilterArg] = mockSubscribe.mock.calls[1];
  const chatFilter = chatFilterArg.toJSON();
  expect(chatFilter.kinds).toContain(1059);

  const TWO_DAYS = 2 * 24 * 60 * 60;
  // Pre-#473: chatFilter.since === 1699999000 - TWO_DAYS.
  // Post-#473: chatFilter.since === 1699999000 - 2 * TWO_DAYS.
  expect(chatFilter.since).toBe(Math.max(0, 1699999000 - 2 * TWO_DAYS));
});
```

#### Test 4 — end-to-end cross-process simulation (regression for the soak)

This is the trickiest test because it must simulate two CLI processes. Easiest path: use the existing `tests/integration/` shape and orchestrate two `Sphere` instances in the same Node process, but separate them temporally by tearing down the receiver between alice's publish and bob's check. Sketch:

```typescript
it('[#473] receiver booted after sender exits sees the swap proposal on first poll', async () => {
  // 1. Alice creates a Sphere, sends a swap proposal DM.
  const alice = await Sphere.init({ ... });
  const proposal = await alice.swap.proposeSwap(deal, ...);
  await alice.destroy();

  // 2. Force alice's gift-wrap created_at to the worst-case low to maximize
  //    the chance of catching M1. (Requires test hook on NIP17.createGiftWrap.)

  // 3. Boot bob, expect to find the proposal on FIRST swap list call (no retry).
  const bob = await Sphere.init({ ... });
  await ensureSyncForTest(bob, 'nostr');
  const swaps = bob.swap.getSwaps({ role: 'acceptor' });
  expect(swaps.map((s) => s.swapId)).toContain(proposal.swapId);
  await bob.destroy();
});
```

#### Test 5 — pre-existing tests need a 2× update

The existing test at line 748 hardcodes `chatFilter.since === Math.max(0, 1699999000 - TWO_DAYS)`. After the fix, this becomes `Math.max(0, 1699999000 - 2 * TWO_DAYS)`. Either update the existing assertion or add a separate "buffer doubled per #473" test (Test 3 above) and delete the obsolete assertion.

### Regression risk

- Change 1 (defer cursor advance) makes the chat-side cursor follow the same at-least-once invariant the TOKEN_TRANSFER path already follows (see `NostrTransportProvider.ts` lines 1782-1841): cursor advances only after the handler reports it has the event. The persistent dedup at line 1092 (`if (this.processedEventIds.has(event.id)) return`) short-circuits duplicates, so the worst case of re-replay on next boot is a no-op skip. No previously-working flow regresses, because previously the cursor was advanced eagerly; now it advances late, which is strictly safer.
- Change 2 (2× buffer) increases the backlog returned on subscription open by at most a 2 d wider window. Dedup absorbs the cost. The widened window includes more events but does NOT change which events get processed — it only changes which events get *filtered server-side*. No semantic change.

---

## Operator workaround (until the fix lands)

For #474 trader-roundtrip and any cross-process flow that depends on a DM the sender published in a prior process:

1. **Always run `sphere payments sync` before any DM-dependent query.** `sync` calls `ensureSync(sphere, 'nostr')` which calls `sphere.fetchPendingEvents()` — at minimum this re-fetches the relay backlog through the OG `NostrTransportProvider.fetchPendingEvents` path (line 2754: `walletFilter.since = now - 86400 - 172800` — uses the wider 3-day window). If the live Mux subscription happens to miss the event due to M1, the one-shot fetch may catch it via its wider window. (But note: this one-shot dispatches handlers on the OG provider, NOT on the Mux adapter — see "What this does NOT address" below.)

2. **Replace the soak's `swap list` with `payments sync` + `swap list` + retry-with-longer-gap.** Today the soak does `sphere payments sync` → `sphere swap list --role acceptor` → sleep 3 s. Change the retry budget to **at least 30 s gap with up to 5 retries** rather than 3 s with 30 retries. This lets the live subscription's worst-case 5 s EOSE timeout plus handler completion (up to 7 s on a degraded relay per `NostrTransportProvider.ts:442`) settle before the next poll. Per-iteration budget should be `~15 s`, not 3 s.

3. **Add an explicit `sphere swap wait <swapId>` step on bob's side** if the CLI exposes it for the `proposed` state. (The current CLI uses `sphere swap wait --state completed`; if a `--state proposed` mode exists or can be added, it's the right primitive here.)

4. **Disambiguate dead iterations from successful-but-incomplete iterations.** Today the soak treats `swap list` returning empty as "no proposal" — but the proposal may be IN the Mux's `handleEvent` chain and not yet persisted. Add a `sleep 2` after `payments sync` (instead of 0) before reading the swap list, to give the handler chain time to land.

5. **Pre-warm bob's wallet** in the soak setup phase by sending bob a benign DM from a third party (e.g., the orchestrator). This advances bob's `lastDmTs` only to the orchestrator-DM's processing time, and the chat filter's existing 2-day buffer is enough as long as that prewarming happens BEFORE alice publishes. (This works around M1's worst-case window: as long as no DM advances `lastDmTs` between alice's publish and the soak's first bob-iteration, the existing buffer suffices.)

6. **Avoid relay congestion windows.** The bug is intermittent because alice's NIP-17 randomization is uniform — most of the time the randomized `created_at` lands within a 1-day window of `T_pub`, in which case the existing 2-day buffer is enough. The failure rate is roughly the probability that the randomization lands in the **last 172800 s of its range** AND bob's cursor advanced past `T_pub`. Empirically rare but non-zero. Increasing the soak iteration count to absorb the flake is not a real fix.

---

## Why this matches the #473 symptom

The proposed Change 1 (defer cursor advance) directly closes M1 by enforcing the at-least-once invariant for chat events: the cursor only advances after the handler has been given a fair chance to persist the swap. When bob's CLI exits between unwrap and handler-completion, `lastDmTs` remains at its prior value — so the next boot's `since` filter still includes alice's event, and bob's NEXT iteration catches it.

Change 2 (2× buffer) is the belt-and-brace defense. Even if some future code path advances `lastDmTs` early (e.g., a self-wrap replay path that we want to count for cursor purposes), the doubled buffer covers the entire worst-case randomization range. Specifically:

- Without buffer-doubling, an event is visible iff `event.created_at >= lastDmTs - 172800`, i.e., `T_pub - 172800 >= lastDmTs - 172800` (worst-case randomization), i.e., `T_pub >= lastDmTs`. **Zero margin** when `lastDmTs` was set by ANY event processed after `T_pub`.
- With 2× buffer, an event is visible iff `event.created_at >= lastDmTs - 345600`, i.e., `T_pub - 172800 >= lastDmTs - 345600`, i.e., `T_pub + 172800 >= lastDmTs`. **2-day margin** for `lastDmTs` to advance past `T_pub` before alice's event is filtered out.

In the soak scenario, the gap between alice's publish and bob's processing of any unrelated DM is on the order of seconds to minutes — well inside the 2-day margin. So Change 2 alone would close the symptom for typical traffic, and Change 1 alone would close it for the specific "handler interrupted" case. Both together leave no residual gap from M1 and M5.

---

## What this does NOT address

- **The Sphere.fetchPendingEvents → OG transport architectural mismatch.** When Sphere is in multi-address mode (always, per `Sphere.ts:7277`), modules register their handlers on the **Mux adapter** but `sphere.fetchPendingEvents()` (`Sphere.ts:2783`) calls **OG `NostrTransportProvider.fetchPendingEvents()`** which dispatches to OG's handlers, not the Mux adapter's. The OG transport buffers messages it can't deliver (`pendingMessages`, line 2287), so for backward-compat the events aren't permanently lost — but they don't reach SwapModule via this path. SwapModule depends entirely on the LIVE Mux subscription. This is a separate fix worth investigating in its own right (PR for #473 should NOT touch it; it's out of scope and would broaden the diff considerably). Track separately as a follow-up.

- **The 500 ms grace in `ensureSync` (CLI line 897) is still too short.** Even after the SDK-side fix, the CLI can call `getSwaps` before the handler chain has persisted. The fix above ensures the event is **NOT permanently lost** — but bob may still need a retry. The soak's 3 s loop is sufficient post-fix, but a 1 s grace (instead of 500 ms) would further reduce the per-iteration miss probability. This is a sphere-cli change, not a sphere-sdk change.

- **M5 (relay-level state divergence).** If the relay accepts an event but fails to serve it on subsequent reads, no SDK-side fix helps. Quorum-of-N relay reads would address it but that's a much larger architectural change. Tracked as residual.

- **In-process delivery to non-handler-registered modules.** PR #465 (sphere-sdk#464) already fixed the `dispatchMessage` → `Promise.allSettled` await chain. This investigation does NOT propose changes there; PR #465's fix remains correct and complementary.

- **NostrTransportProvider's own `handleGiftWrap` path at line 2148-2192.** The OG provider has the same "advance cursor before dispatch" pattern as the Mux (line 2162: `this.updateLastDmEventTimestamp(Math.floor(Date.now() / 1000))` runs BEFORE `messageHandlers` are called). For full safety, the same Change-1-style fix should be applied to NostrTransportProvider.handleGiftWrap too — but per the architectural mismatch above, the OG path mostly isn't reached for swap DMs in production today. Apply if the same incident surfaces from a non-mux consumer; otherwise defer.

---

## Test plan

Before claiming closure on #473, the author of the fix should run:

- [ ] `npm run typecheck` clean.
- [ ] `npm run lint` clean.
- [ ] `npx vitest run tests/unit/transport/MultiAddressTransportMux.dispatch-await.test.ts` (existing) passes unchanged.
- [ ] `npx vitest run tests/unit/transport/NostrTransportProvider.test.ts` passes after updating the `chatFilter.since` assertion at line 748 to `2 * TWO_DAYS`.
- [ ] New tests (1, 2, 3, and ideally 4 above) pass.
- [ ] `npm run test:run` passes (full suite — 2539 tests at last count).
- [ ] Soak: run `manual-test-swap-roundtrip.sh` 20 times back-to-back against `dev` network. Expected: 0 `proposal-ingest-timeout` failures. (Pre-fix baseline: 1-3 timeouts per 20 runs.)
- [ ] Soak: run `manual-test-swap-roundtrip.sh` 20 times back-to-back against `testnet` network. Same expectation.
- [ ] Trader-roundtrip #474 G2 soak: run end-to-end at least 10 times against `testnet`. Expected: 0 hop failures attributable to controller-CLI ↔ tenant DM gap.

Note: the soak script reports `bob-swap-list-A.log` per iteration. Pre-fix, when failure happens, the log shows "No swaps found." for ALL 30 iterations. Post-fix, even in the worst case, bob should see the proposal within 2-3 iterations (the iteration grace + the relay's subscription replay latency).

---

## Cross-references

- **Issue #473** — Cross-process Nostr DM flakiness (the bug under investigation).
- **PR #465** (sphere-sdk#464) — `MuxAdapter dispatch await async handler completion`. In-process handler-completion fix; complementary to #473's cross-process fix, NOT a substitute.
- **PR #461** (sphere-sdk#447) — `include terminal swaps in resolveSwapId/getSwaps`. Unrelated to this investigation; mentioned only as recent-history context.
- **PR #459** (sphere-sdk#457) — `fail fast when counterparty transport pubkey missing`. SwapModule sender-side fix; unrelated to receiver-side cursor.
- **PR #423** — Handler-readiness gate (NostrTransportProvider `armSubscriptions`). Already in place; this investigation does NOT change the arm semantics.
- **PR #442** — Subscription gate (Mux `suppressSubscriptions` / `armSubscriptions`). Already in place; this investigation does NOT change the arm semantics.
- **Issue #275** — Persistent dedup via `processedEventIds`. Already in place; the proposed fix relies on this to absorb harmless re-delivery from the widened buffer.
- **Issue #166 / #97** — OUTBOX/SENT crash-safety follow-ups, including the at-least-once invariant for TOKEN_TRANSFER. This investigation extends the same invariant to the chat path.
- **Issue #474** — Trader-roundtrip G2 soak. Hard dependency on #473 closure.
- **Memory entry `project_cross_process_nostr_gap.md`** (2026-05-22): "CLI sender→exit→receiver flow loses Nostr-delivered tokens despite event being on relay; e2e tests use same-process so don't catch it." Same shape as #473 but for TOKEN_TRANSFER events on the wallet filter. Worth checking whether the wallet-filter side has a sibling of M1 (in-process processing-time-vs-publish-time gap). If TOKEN_TRANSFER also uses NIP-17 wrap on some path, the buffer fix here should be ported.
- **`manual-test-swap-roundtrip.sh`** lines 280-298 — the soak loop that surfaces #473.
- **`CLAUDE.md`** — see "Event Timestamp Persistence" and "Transport vs Chain Pubkeys" sections for background.
