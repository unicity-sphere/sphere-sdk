/**
 * Tests for the mux dispatch await-gap fix (#464).
 *
 * Issue #464 — `MuxAdapter.dispatchTokenTransfer` (and siblings) discarded
 * the async handler's returned Promise, so any caller that awaited
 * dispatch saw it resolve BEFORE `handleIncomingTransfer` (an async
 * function in PaymentsModule) finished writing the token to storage.
 * The next caller step (`PaymentsModule.load()`) then raced against
 * the in-flight `addToken` write and roughly half the time observed
 * empty storage. Single-coin faucet flakiness (#455 root cause).
 *
 * The fix:
 *  - `dispatch*` methods are now `async` and `await Promise.allSettled(...)`
 *    over every handler invocation. Per-handler fault isolation is
 *    preserved (one rejection does not block the others).
 *  - Late drain inside `on*(handler)` is tracked via `inFlightDrains`
 *    and exposed through `flushPendingDrains()`. The mux's
 *    `fetchPendingEvents` flushes drains across all adapters before
 *    returning.
 *
 * These tests prove the await-gap is closed by constructing a controllable
 * async handler (gated by an external promise) and asserting that dispatch
 * does NOT resolve until the handler resolves.
 */

import { describe, it, expect } from 'vitest';
import { AddressTransportAdapter, MultiAddressTransportMux } from '../../../transport/MultiAddressTransportMux';
import type {
  IncomingTokenTransfer,
  IncomingPaymentRequest,
  IncomingPaymentRequestResponse,
  IncomingMessage,
} from '../../../transport/transport-provider';
import type { FullIdentity } from '../../../types';

const STUB_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'ab'.repeat(32),
  directAddress: 'DIRECT://stub',
  transportPubkey: 'cc'.repeat(32),
  privateKey: 'dd'.repeat(32),
};

function newAdapter(): AddressTransportAdapter {
  const muxStub = {} as unknown as MultiAddressTransportMux;
  return new AddressTransportAdapter(muxStub, 0, STUB_IDENTITY, null);
}

function makeTransfer(id: string): IncomingTokenTransfer {
  return {
    id,
    senderTransportPubkey: 'ee'.repeat(32),
    payload: { kind: 'token-transfer' } as unknown as IncomingTokenTransfer['payload'],
    timestamp: 1779443013_000,
  };
}

function makePaymentRequest(id: string): IncomingPaymentRequest {
  return {
    id,
    senderTransportPubkey: 'ee'.repeat(32),
    request: { requestId: id, amount: '1000000', coinId: 'UCT' },
    timestamp: 1779443013_000,
  };
}

function makePaymentResponse(id: string): IncomingPaymentRequestResponse {
  return {
    id,
    responderTransportPubkey: 'ee'.repeat(32),
    response: { requestId: id, responseType: 'accepted' },
    timestamp: 1779443013_000,
  };
}

function makeMessage(id: string): IncomingMessage {
  return {
    id,
    senderTransportPubkey: 'ee'.repeat(32),
    content: 'hello',
    timestamp: 1779443013_000,
    encrypted: false,
  };
}

/**
 * Build a controllable gate: a promise that resolves only when the
 * `release` function is called. Used to pause an async handler in
 * mid-flight so the test can assert that callers awaiting the dispatch
 * are still pending.
 */
function gate(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

/**
 * Helper: race `promise` against a microtask-boundary check. Returns
 * `true` if `promise` is still pending after the microtask queue
 * drains, `false` if it resolved.
 *
 * `await new Promise(setImmediate)` / `setTimeout(0)` would also work
 * but `queueMicrotask` is the closest deterministic boundary in
 * Vitest.
 */
async function isStillPending(p: Promise<unknown>): Promise<boolean> {
  const sentinel = Symbol('pending');
  const result = await Promise.race([
    p.then(() => 'resolved' as const),
    new Promise<typeof sentinel>((resolve) => setImmediate(() => resolve(sentinel))),
  ]);
  return result === sentinel;
}

describe('AddressTransportAdapter — dispatch await-gap (#464)', () => {
  // ===========================================================================
  // dispatchTokenTransfer — the critical async-handler site
  // ===========================================================================

  it('dispatchTokenTransfer awaits an async handler before resolving', async () => {
    const adapter = newAdapter();
    const recorded: string[] = [];
    const handlerGate = gate();

    adapter.onTokenTransfer(async (transfer) => {
      await handlerGate.wait;
      recorded.push(transfer.id);
    });

    const dispatchPromise = adapter.dispatchTokenTransfer(makeTransfer('event-1'));

    // The dispatch must STILL be pending while the handler is mid-flight.
    expect(await isStillPending(dispatchPromise)).toBe(true);
    expect(recorded).toEqual([]);

    // Release the handler; dispatch should now resolve.
    handlerGate.release();
    await dispatchPromise;
    expect(recorded).toEqual(['event-1']);
  });

  it('dispatchTokenTransfer surfaces handler completion to the upstream awaiter (the #464 bug shape)', async () => {
    // This mirrors the call shape in `MultiAddressTransportMux.handleTokenTransfer`:
    // an `await entry.adapter.dispatchTokenTransfer(transfer)` followed by
    // a state read that must observe the handler's side-effects.
    const adapter = newAdapter();
    const storage: string[] = [];

    adapter.onTokenTransfer(async (transfer) => {
      // Simulate the storage write that `PaymentsModule.handleIncomingTransfer`
      // performs (async, microtask-yielding).
      await Promise.resolve();
      await Promise.resolve();
      storage.push(transfer.id);
    });

    // Simulate the buggy pre-fix call shape that DID NOT await:
    //   `entry.adapter.dispatchTokenTransfer(transfer);` (fire-and-forget)
    // ↓
    //   `read storage immediately` → race
    //
    // With the #464 fix, the upstream caller can simply `await` the
    // dispatch and observe a consistent state.
    await adapter.dispatchTokenTransfer(makeTransfer('event-1'));
    expect(storage).toEqual(['event-1']);
  });

  it('dispatchTokenTransfer with Promise.allSettled isolates handler exceptions', async () => {
    const adapter = newAdapter();
    const recorded: string[] = [];

    // Throwing handler (sync throw)
    adapter.onTokenTransfer(() => { throw new Error('boom-sync'); });

    // Rejecting handler (async rejection — this is the case the pre-#464
    // try/catch could NOT catch).
    adapter.onTokenTransfer(async () => {
      throw new Error('boom-async');
    });

    // Healthy handler — must still run despite the two failures above.
    adapter.onTokenTransfer((transfer) => { recorded.push(transfer.id); });

    // No throw, no rejection — `Promise.allSettled` swallows both
    // rejections internally; the dispatcher logs and proceeds.
    await expect(adapter.dispatchTokenTransfer(makeTransfer('event-1'))).resolves.toBeUndefined();
    expect(recorded).toEqual(['event-1']);
  });

  // ===========================================================================
  // Sibling dispatchers — same await contract for forward compat.
  // ===========================================================================

  it('dispatchMessage awaits async message handlers', async () => {
    const adapter = newAdapter();
    const recorded: string[] = [];
    const handlerGate = gate();

    adapter.onMessage(async (msg) => {
      await handlerGate.wait;
      recorded.push(msg.id);
    });

    const dispatchPromise = adapter.dispatchMessage(makeMessage('msg-1'));
    expect(await isStillPending(dispatchPromise)).toBe(true);
    handlerGate.release();
    await dispatchPromise;
    expect(recorded).toEqual(['msg-1']);
  });

  it('dispatchPaymentRequest awaits async handlers', async () => {
    const adapter = newAdapter();
    const recorded: string[] = [];
    const handlerGate = gate();

    adapter.onPaymentRequest(async (req) => {
      await handlerGate.wait;
      recorded.push(req.id);
    });

    const dispatchPromise = adapter.dispatchPaymentRequest(makePaymentRequest('req-1'));
    expect(await isStillPending(dispatchPromise)).toBe(true);
    handlerGate.release();
    await dispatchPromise;
    expect(recorded).toEqual(['req-1']);
  });

  it('dispatchPaymentRequestResponse awaits async handlers', async () => {
    const adapter = newAdapter();
    const recorded: string[] = [];
    const handlerGate = gate();

    adapter.onPaymentRequestResponse(async (rsp) => {
      await handlerGate.wait;
      recorded.push(rsp.id);
    });

    const dispatchPromise = adapter.dispatchPaymentRequestResponse(makePaymentResponse('rsp-1'));
    expect(await isStillPending(dispatchPromise)).toBe(true);
    handlerGate.release();
    await dispatchPromise;
    expect(recorded).toEqual(['rsp-1']);
  });

  // ===========================================================================
  // Late drain — `onTokenTransfer` registration triggers drain of buffered
  // events. `flushPendingDrains()` exposes the drain promise so callers can
  // await it. This is the second arm of the #464 fix (mux's
  // `fetchPendingEvents` calls it).
  // ===========================================================================

  it('flushPendingDrains awaits the late-drain promise (drain triggered by handler registration)', async () => {
    const adapter = newAdapter();
    const recorded: string[] = [];
    const handlerGate = gate();

    // Two events buffered with no handler attached.
    await adapter.dispatchTokenTransfer(makeTransfer('event-1'));
    await adapter.dispatchTokenTransfer(makeTransfer('event-2'));

    // Register an async handler — drain starts as a tracked promise.
    adapter.onTokenTransfer(async (transfer) => {
      await handlerGate.wait;
      recorded.push(transfer.id);
    });

    const flushPromise = adapter.flushPendingDrains();

    // Drain handler is gated — flush must still be pending.
    expect(await isStillPending(flushPromise)).toBe(true);
    expect(recorded).toEqual([]);

    handlerGate.release();
    await flushPromise;
    // Drain processes buffered events in arrival order.
    expect(recorded).toEqual(['event-1', 'event-2']);
  });

  it('flushPendingDrains is a no-op when no drains are in flight', async () => {
    const adapter = newAdapter();
    await expect(adapter.flushPendingDrains()).resolves.toBeUndefined();

    // Register handler with no buffered events — no drain promise is tracked.
    adapter.onTokenTransfer(() => { /* no-op */ });
    await expect(adapter.flushPendingDrains()).resolves.toBeUndefined();
  });
});
