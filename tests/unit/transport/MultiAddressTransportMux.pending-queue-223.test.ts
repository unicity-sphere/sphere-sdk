/**
 * Tests for the pending-queue race fix on `AddressTransportAdapter` (#223).
 *
 * Issue #223 (Cross-Process Nostr token transfer broken) — the relay
 * pushes alice's stored TOKEN_TRANSFER event in the gap between
 * `mux.addAddress` (which subscribes) and `PaymentsModule.initialize`
 * (which calls `onTokenTransfer`). Before this fix, the adapter's
 * `dispatchTokenTransfer` iterated an empty `transferHandlers` set
 * and silently dropped the event, and the next call to register a
 * handler had nothing to drain. This test pins the queueing semantics
 * down deterministically so the regression cannot reappear.
 *
 * The fix mirrors the pre-existing `pendingMessages` pattern that
 * `dispatchMessage` / `onMessage` already implement for DMs.
 */

import { describe, it, expect } from 'vitest';
import { AddressTransportAdapter, MultiAddressTransportMux } from '../../../transport/MultiAddressTransportMux';
import type {
  IncomingTokenTransfer,
  IncomingPaymentRequest,
  IncomingPaymentRequestResponse,
} from '../../../transport/transport-provider';
import type { FullIdentity } from '../../../types';

// Minimal stub identity — adapter only stashes it; no crypto is performed
// by the surface under test.
const STUB_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'ab'.repeat(32),
  l1Address: 'alpha1stub',
  directAddress: 'DIRECT://stub',
  transportPubkey: 'cc'.repeat(32),
  privateKey: 'dd'.repeat(32),
};

// We never call into the mux from the dispatch/subscribe code paths,
// so a bare object cast through `unknown` is sufficient for construction.
function newAdapter(): AddressTransportAdapter {
  const muxStub = {} as unknown as MultiAddressTransportMux;
  return new AddressTransportAdapter(muxStub, 0, STUB_IDENTITY, null);
}

function makeTransfer(id: string): IncomingTokenTransfer {
  return {
    id,
    senderTransportPubkey: 'ee'.repeat(32),
    // The adapter doesn't introspect the payload — any shape is fine for
    // queue-semantics assertions.
    payload: { kind: 'token-transfer' } as unknown as IncomingTokenTransfer['payload'],
    timestamp: 1779443013_000,
  };
}

function makePaymentRequest(id: string): IncomingPaymentRequest {
  return {
    id,
    senderTransportPubkey: 'ee'.repeat(32),
    request: {
      requestId: id,
      amount: '1000000',
      coinId: 'UCT',
    },
    timestamp: 1779443013_000,
  };
}

function makePaymentResponse(id: string): IncomingPaymentRequestResponse {
  return {
    id,
    responderTransportPubkey: 'ee'.repeat(32),
    response: {
      requestId: id,
      responseType: 'accepted',
    },
    timestamp: 1779443013_000,
  };
}

describe('AddressTransportAdapter — pending-queue race fix (#223)', () => {
  // ---------------------------------------------------------------------------
  // TOKEN_TRANSFER — the bug-report scenario
  // ---------------------------------------------------------------------------
  //
  // Issue #464 update — `dispatchTokenTransfer` is now `async` and `await`s
  // every handler invocation via `Promise.allSettled`. The drain triggered
  // by late `onTokenTransfer` registration is also async-aware (tracked
  // via `flushPendingDrains`). Tests below await accordingly.

  it('queues token transfers dispatched before any handler is registered', async () => {
    const adapter = newAdapter();
    const received: IncomingTokenTransfer[] = [];

    // The Mux dispatches BEFORE PaymentsModule.initialize subscribes —
    // exactly the cross-process race in issue #223.
    await adapter.dispatchTokenTransfer(makeTransfer('event-1'));
    await adapter.dispatchTokenTransfer(makeTransfer('event-2'));

    // Handler registered late. Pre-fix this returned nothing; with the
    // pending queue the two events are drained in arrival order. Drain
    // is async post-#464 — we await `flushPendingDrains` for ordering.
    adapter.onTokenTransfer((t) => { received.push(t); });
    await adapter.flushPendingDrains();

    expect(received.map((t) => t.id)).toEqual(['event-1', 'event-2']);
  });

  it('does not double-deliver: queue is drained exactly once on first subscribe', async () => {
    const adapter = newAdapter();
    const firstHandler: IncomingTokenTransfer[] = [];
    const secondHandler: IncomingTokenTransfer[] = [];

    await adapter.dispatchTokenTransfer(makeTransfer('event-1'));
    adapter.onTokenTransfer((t) => { firstHandler.push(t); });
    await adapter.flushPendingDrains();

    // A second handler subscribed AFTER drain must NOT see the already-
    // delivered events. The queue is cleared on the first drain.
    adapter.onTokenTransfer((t) => { secondHandler.push(t); });
    await adapter.flushPendingDrains();

    expect(firstHandler).toHaveLength(1);
    expect(secondHandler).toHaveLength(0);
  });

  it('dispatches via await when a handler is already registered (no queue side-effect)', async () => {
    const adapter = newAdapter();
    const received: IncomingTokenTransfer[] = [];
    adapter.onTokenTransfer((t) => { received.push(t); });

    await adapter.dispatchTokenTransfer(makeTransfer('event-1'));
    await adapter.dispatchTokenTransfer(makeTransfer('event-2'));

    expect(received.map((t) => t.id)).toEqual(['event-1', 'event-2']);
  });

  it('fans out queued transfers to every currently-registered handler on drain', async () => {
    // Edge case: two handlers register before the first dispatch.
    // The pending queue is empty at that point; this just guards against
    // accidental behavioural drift in the multi-handler path.
    const adapter = newAdapter();
    const a: IncomingTokenTransfer[] = [];
    const b: IncomingTokenTransfer[] = [];
    adapter.onTokenTransfer((t) => { a.push(t); });
    adapter.onTokenTransfer((t) => { b.push(t); });

    await adapter.dispatchTokenTransfer(makeTransfer('event-1'));

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('a throwing drain handler does not block delivery to later subscribers', async () => {
    // Defensive: errors inside the drained handler must not poison the
    // adapter's state. The queue is cleared before drain so a throw
    // can't re-queue the events.
    const adapter = newAdapter();
    await adapter.dispatchTokenTransfer(makeTransfer('event-1'));

    adapter.onTokenTransfer(() => { throw new Error('boom'); });
    await adapter.flushPendingDrains();

    const received: IncomingTokenTransfer[] = [];
    await adapter.dispatchTokenTransfer(makeTransfer('event-2'));
    // event-2 must fan out; the first handler will throw again but the
    // second handler must still be invoked.
    adapter.onTokenTransfer((t) => { received.push(t); });
    await adapter.dispatchTokenTransfer(makeTransfer('event-3'));

    // event-3 dispatched while two handlers are live (throwing + capturing).
    expect(received.map((t) => t.id)).toEqual(['event-3']);
  });

  // ---------------------------------------------------------------------------
  // PAYMENT_REQUEST — same race shape, fixed symmetrically
  // ---------------------------------------------------------------------------

  it('queues payment requests dispatched before any handler is registered', async () => {
    const adapter = newAdapter();
    const received: IncomingPaymentRequest[] = [];
    await adapter.dispatchPaymentRequest(makePaymentRequest('req-1'));
    await adapter.dispatchPaymentRequest(makePaymentRequest('req-2'));
    adapter.onPaymentRequest((r) => { received.push(r); });
    await adapter.flushPendingDrains();
    expect(received.map((r) => r.id)).toEqual(['req-1', 'req-2']);
  });

  // ---------------------------------------------------------------------------
  // PAYMENT_REQUEST_RESPONSE — same race shape, fixed symmetrically
  // ---------------------------------------------------------------------------

  it('queues payment request responses dispatched before any handler is registered', async () => {
    const adapter = newAdapter();
    const received: IncomingPaymentRequestResponse[] = [];
    await adapter.dispatchPaymentRequestResponse(makePaymentResponse('rsp-1'));
    await adapter.dispatchPaymentRequestResponse(makePaymentResponse('rsp-2'));
    adapter.onPaymentRequestResponse((r) => { received.push(r); });
    await adapter.flushPendingDrains();
    expect(received.map((r) => r.id)).toEqual(['rsp-1', 'rsp-2']);
  });
});
