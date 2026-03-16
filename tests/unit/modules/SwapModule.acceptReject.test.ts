/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for SwapModule.acceptSwap() and rejectSwap()
 *
 * 15 tests total:
 *   UT-SWAP-ACCEPT-001 through UT-SWAP-ACCEPT-010 (10 accept tests)
 *   UT-SWAP-REJECT-001 through UT-SWAP-REJECT-005 (5 reject tests)
 *
 * @see docs/SWAP-TEST-SPEC.md §3.3
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestSwapModule,
  createTestSwapRef,
  injectSwapRef,
  DEFAULT_TEST_PARTY_A_PUBKEY,
  DEFAULT_TEST_PARTY_B_PUBKEY,
  DEFAULT_TEST_ESCROW_PUBKEY,
  DEFAULT_TEST_ESCROW_ADDRESS,
  SphereError,
} from './swap-test-helpers.js';
import type { SwapModule } from '../../../modules/swap/index.js';
import type { TestSwapModuleMocks } from './swap-test-helpers.js';
import type { SwapRef } from '../../../modules/swap/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a DM that may have a prefix like `swap_acceptance:{...}` */
function parseDMContent(content: string): any {
  // Try direct JSON first
  try {
    return JSON.parse(content);
  } catch {
    // Strip prefix: everything before the first `{`
    const idx = content.indexOf('{');
    if (idx >= 0) {
      return JSON.parse(content.slice(idx));
    }
    return null;
  }
}

/** Find a sent DM by parsed type field */
function findDMByType(
  sentDMs: Array<{ recipient: string; content: string }>,
  type: string,
): { recipient: string; content: string; parsed: any } | undefined {
  for (const dm of sentDMs) {
    const parsed = parseDMContent(dm.content);
    if (parsed && parsed.type === type) {
      return { ...dm, parsed };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let module: SwapModule;
let mocks: TestSwapModuleMocks;
let swapRef: SwapRef;

function setupAcceptorProposed(): SwapRef {
  const ref = createTestSwapRef({
    role: 'acceptor',
    progress: 'proposed',
    counterpartyPubkey: DEFAULT_TEST_PARTY_A_PUBKEY,
  });
  injectSwapRef(module, ref);
  return ref;
}

// ---------------------------------------------------------------------------
// acceptSwap()
// ---------------------------------------------------------------------------

describe('SwapModule.acceptSwap()', () => {
  beforeEach(async () => {
    const result = createTestSwapModule();
    module = result.module;
    mocks = result.mocks;
    await module.load();
    swapRef = setupAcceptorProposed();
  });

  it('UT-SWAP-ACCEPT-001: sends swap_acceptance DM to counterparty', async () => {
    await module.acceptSwap(swapRef.swapId);

    expect(mocks.communications.sendDM).toHaveBeenCalled();
    const acceptanceDM = findDMByType(mocks.communications._sentDMs, 'swap_acceptance');
    expect(acceptanceDM).toBeDefined();
    expect(acceptanceDM!.recipient).toBe(DEFAULT_TEST_PARTY_A_PUBKEY);
    expect(acceptanceDM!.parsed.swap_id).toBe(swapRef.swapId);
  });

  it('UT-SWAP-ACCEPT-002: resolves escrow and announces manifest via DM', async () => {
    await module.acceptSwap(swapRef.swapId);

    const announceDM = findDMByType(mocks.communications._sentDMs, 'announce');
    expect(announceDM).toBeDefined();
    expect(announceDM!.recipient).toBe(DEFAULT_TEST_ESCROW_PUBKEY);
    expect(announceDM!.parsed.manifest).toBeDefined();
    expect(announceDM!.parsed.manifest.swap_id).toBe(swapRef.swapId);
  });

  it('UT-SWAP-ACCEPT-003: resolves and stores escrowPubkey, then DM handler calls importInvoice on invoice_delivery', async () => {
    // Remove escrowPubkey to force resolution
    swapRef.escrowPubkey = undefined as any;
    swapRef.escrowDirectAddress = undefined as any;

    await module.acceptSwap(swapRef.swapId);

    // Verify escrow resolution was stored
    const updatedSwap = (module as any).swaps.get(swapRef.swapId) as SwapRef;
    expect(updatedSwap.escrowPubkey).toBe(DEFAULT_TEST_ESCROW_PUBKEY);
    expect(updatedSwap.escrowDirectAddress).toBe(DEFAULT_TEST_ESCROW_ADDRESS);

    // Simulate an invoice_delivery DM from the escrow — the DM handler should call importInvoice
    const invoiceDeliveryDM = JSON.stringify({
      type: 'invoice_delivery',
      swap_id: swapRef.swapId,
      invoice_type: 'deposit',
      invoice_id: 'test-deposit-invoice-003',
      invoice_token: { version: '2.0', genesis: { data: {} }, state: {}, transactions: [] },
      payment_instructions: {
        your_currency: 'UCT',
        your_amount: '1000000',
        memo: `swap:${swapRef.swapId}`,
      },
    });

    mocks.communications._simulateIncomingDM(invoiceDeliveryDM, DEFAULT_TEST_ESCROW_PUBKEY);

    // Allow async processing to complete
    await new Promise(r => setTimeout(r, 100));

    expect(mocks.accounting.importInvoice).toHaveBeenCalled();
  });

  it('UT-SWAP-ACCEPT-004: transitions to accepted state', async () => {
    await module.acceptSwap(swapRef.swapId);

    // Verify the swap:accepted event was emitted, confirming transition through 'accepted'
    const acceptedEvent = mocks.emitEvent._calls.find(
      ([type]) => type === 'swap:accepted',
    );
    expect(acceptedEvent).toBeDefined();
    expect(acceptedEvent![1]).toEqual(
      expect.objectContaining({ swapId: swapRef.swapId, role: 'acceptor' }),
    );

    // Verify the swap reached 'accepted' (or beyond, since announce may advance it further).
    // acceptSwap transitions proposed -> accepted. If announce succeeds but no announce_result
    // DM arrives yet, the swap stays in 'accepted'. If announce fails, it goes to 'failed'.
    const updatedSwap = (module as any).swaps.get(swapRef.swapId) as SwapRef;
    // The swap should be in 'accepted' (announce succeeded but no DM response yet to advance)
    // or 'failed' (if announce failed). It should NOT still be 'proposed'.
    expect(updatedSwap.progress).not.toBe('proposed');
    // Since mocks succeed by default, it should be 'accepted'
    expect(updatedSwap.progress).toBe('accepted');
  });

  it('UT-SWAP-ACCEPT-005: emits swap:accepted event with complete payload', async () => {
    await module.acceptSwap(swapRef.swapId);

    const acceptedEvents = mocks.emitEvent._calls.filter(
      ([type]) => type === 'swap:accepted',
    );
    expect(acceptedEvents.length).toBe(1);

    const payload = acceptedEvents[0][1] as { swapId: string; role: string };
    // Verify all required fields per SwapEventMap['swap:accepted']
    expect(payload.swapId).toBe(swapRef.swapId);
    expect(payload.role).toBe('acceptor');
    // Ensure no unexpected undefined fields
    expect(typeof payload.swapId).toBe('string');
    expect(typeof payload.role).toBe('string');
  });

  it('UT-SWAP-ACCEPT-006: non-existent swap throws SWAP_NOT_FOUND', async () => {
    await expect(module.acceptSwap('nonexistent-id')).rejects.toMatchObject({ code: 'SWAP_NOT_FOUND' });
  });

  it('UT-SWAP-ACCEPT-007: wrong state throws SWAP_WRONG_STATE', async () => {
    const depositingRef = createTestSwapRef({
      role: 'acceptor',
      progress: 'depositing',
      counterpartyPubkey: DEFAULT_TEST_PARTY_A_PUBKEY,
    });
    injectSwapRef(module, depositingRef);

    await expect(module.acceptSwap(depositingRef.swapId)).rejects.toMatchObject({ code: 'SWAP_WRONG_STATE' });
  });

  it('UT-SWAP-ACCEPT-008: proposer cannot accept own swap throws SWAP_WRONG_STATE', async () => {
    const proposerRef = createTestSwapRef({
      role: 'proposer',
      progress: 'proposed',
      counterpartyPubkey: DEFAULT_TEST_PARTY_B_PUBKEY,
    });
    injectSwapRef(module, proposerRef);

    await expect(module.acceptSwap(proposerRef.swapId)).rejects.toMatchObject({ code: 'SWAP_WRONG_STATE' });
  });

  it('UT-SWAP-ACCEPT-009: escrow rejection transitions swap to failed', async () => {
    // Use fake timers to avoid retry delays
    vi.useFakeTimers();

    // Make sendDM fail only for escrow announce messages (pure JSON with type=announce)
    mocks.communications.sendDM.mockImplementation(
      async (recipient: string, content: string) => {
        const parsed = parseDMContent(content);
        if (parsed && parsed.type === 'announce') {
          throw new Error('Escrow rejected: INVALID_MANIFEST');
        }
        mocks.communications._sentDMs.push({ recipient, content });
        return { eventId: 'mock-event-id' };
      },
    );

    const acceptPromise = module.acceptSwap(swapRef.swapId);

    // Advance through all retry delays (6 attempts with exponential backoff)
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(20000);
    }

    await acceptPromise;

    vi.useRealTimers();

    const updatedSwap = (module as any).swaps.get(swapRef.swapId) as SwapRef;
    expect(updatedSwap.progress).toBe('failed');

    const failedEvent = mocks.emitEvent._calls.find(
      ([type]) => type === 'swap:failed',
    );
    expect(failedEvent).toBeDefined();
  });

  it('UT-SWAP-ACCEPT-010: DM timeout (announce failure) transitions to failed', async () => {
    // Use fake timers to avoid retry delays
    vi.useFakeTimers();

    mocks.communications.sendDM.mockImplementation(
      async (recipient: string, content: string) => {
        const parsed = parseDMContent(content);
        if (parsed && parsed.type === 'announce') {
          throw new Error('Timeout waiting for escrow response');
        }
        mocks.communications._sentDMs.push({ recipient, content });
        return { eventId: 'mock-event-id' };
      },
    );

    const acceptPromise = module.acceptSwap(swapRef.swapId);

    // Advance through all retry delays
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(20000);
    }

    await acceptPromise;

    vi.useRealTimers();

    const updatedSwap = (module as any).swaps.get(swapRef.swapId) as SwapRef;
    expect(updatedSwap.progress).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// rejectSwap()
// ---------------------------------------------------------------------------

describe('SwapModule.rejectSwap()', () => {
  beforeEach(async () => {
    const result = createTestSwapModule();
    module = result.module;
    mocks = result.mocks;
    await module.load();
    swapRef = setupAcceptorProposed();
  });

  it('UT-SWAP-REJECT-001: sends swap_rejection DM to counterparty', async () => {
    await module.rejectSwap(swapRef.swapId);

    const rejectionDM = findDMByType(mocks.communications._sentDMs, 'swap_rejection');
    expect(rejectionDM).toBeDefined();
    expect(rejectionDM!.recipient).toBe(DEFAULT_TEST_PARTY_A_PUBKEY);
    expect(rejectionDM!.parsed.swap_id).toBe(swapRef.swapId);
  });

  it('UT-SWAP-REJECT-002: transitions to cancelled', async () => {
    await module.rejectSwap(swapRef.swapId);

    const updatedSwap = (module as any).swaps.get(swapRef.swapId) as SwapRef;
    expect(updatedSwap.progress).toBe('cancelled');
  });

  it('UT-SWAP-REJECT-003: emits swap:rejected event', async () => {
    await module.rejectSwap(swapRef.swapId);

    const rejectedEvent = mocks.emitEvent._calls.find(
      ([type]) => type === 'swap:rejected',
    );
    expect(rejectedEvent).toBeDefined();
    expect(rejectedEvent![1]).toEqual(
      expect.objectContaining({ swapId: swapRef.swapId }),
    );
  });

  it('UT-SWAP-REJECT-004: wrong state throws SWAP_WRONG_STATE', async () => {
    const announcedRef = createTestSwapRef({
      role: 'acceptor',
      progress: 'announced',
      counterpartyPubkey: DEFAULT_TEST_PARTY_A_PUBKEY,
    });
    injectSwapRef(module, announcedRef);

    await expect(module.rejectSwap(announcedRef.swapId)).rejects.toMatchObject({ code: 'SWAP_WRONG_STATE' });
  });

  it('UT-SWAP-REJECT-005: includes reason in rejection DM', async () => {
    await module.rejectSwap(swapRef.swapId, 'Price too high');

    const rejectionDM = findDMByType(mocks.communications._sentDMs, 'swap_rejection');
    expect(rejectionDM).toBeDefined();
    expect(rejectionDM!.parsed.reason).toBe('Price too high');
  });
});
