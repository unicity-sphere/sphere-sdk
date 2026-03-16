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

  it('UT-SWAP-ACCEPT-003: stores escrowPubkey on swap after resolution', async () => {
    // Remove escrowPubkey to force resolution
    swapRef.escrowPubkey = undefined as any;
    swapRef.escrowDirectAddress = undefined as any;

    await module.acceptSwap(swapRef.swapId);

    const updatedSwap = (module as any).swaps.get(swapRef.swapId) as SwapRef;
    expect(updatedSwap.escrowPubkey).toBe(DEFAULT_TEST_ESCROW_PUBKEY);
    expect(updatedSwap.escrowDirectAddress).toBe(DEFAULT_TEST_ESCROW_ADDRESS);
  });

  it('UT-SWAP-ACCEPT-004: transitions to accepted', async () => {
    await module.acceptSwap(swapRef.swapId);

    // Verify the swap:accepted event was emitted, confirming transition through 'accepted'
    const acceptedEvent = mocks.emitEvent._calls.find(
      ([type]) => type === 'swap:accepted',
    );
    expect(acceptedEvent).toBeDefined();
    expect(acceptedEvent![1]).toEqual(
      expect.objectContaining({ swapId: swapRef.swapId, role: 'acceptor' }),
    );
  });

  it('UT-SWAP-ACCEPT-005: emits swap:accepted event', async () => {
    await module.acceptSwap(swapRef.swapId);

    const acceptedEvents = mocks.emitEvent._calls.filter(
      ([type]) => type === 'swap:accepted',
    );
    expect(acceptedEvents.length).toBe(1);
    expect(acceptedEvents[0][1]).toEqual(
      expect.objectContaining({ swapId: swapRef.swapId }),
    );
  });

  it('UT-SWAP-ACCEPT-006: non-existent swap throws SWAP_NOT_FOUND', async () => {
    await expect(module.acceptSwap('nonexistent-id')).rejects.toThrow(SphereError);
    try {
      await module.acceptSwap('nonexistent-id');
    } catch (err) {
      expect((err as SphereError).code).toBe('SWAP_NOT_FOUND');
    }
  });

  it('UT-SWAP-ACCEPT-007: wrong state throws SWAP_WRONG_STATE', async () => {
    const depositingRef = createTestSwapRef({
      role: 'acceptor',
      progress: 'depositing',
      counterpartyPubkey: DEFAULT_TEST_PARTY_A_PUBKEY,
    });
    injectSwapRef(module, depositingRef);

    await expect(module.acceptSwap(depositingRef.swapId)).rejects.toThrow(SphereError);
    try {
      await module.acceptSwap(depositingRef.swapId);
    } catch (err) {
      expect((err as SphereError).code).toBe('SWAP_WRONG_STATE');
    }
  });

  it('UT-SWAP-ACCEPT-008: proposer cannot accept own swap throws SWAP_WRONG_STATE', async () => {
    const proposerRef = createTestSwapRef({
      role: 'proposer',
      progress: 'proposed',
      counterpartyPubkey: DEFAULT_TEST_PARTY_B_PUBKEY,
    });
    injectSwapRef(module, proposerRef);

    await expect(module.acceptSwap(proposerRef.swapId)).rejects.toThrow(SphereError);
    try {
      await module.acceptSwap(proposerRef.swapId);
    } catch (err) {
      expect((err as SphereError).code).toBe('SWAP_WRONG_STATE');
      expect((err as Error).message).toContain('proposer');
    }
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

    await expect(module.rejectSwap(announcedRef.swapId)).rejects.toThrow(SphereError);
    try {
      await module.rejectSwap(announcedRef.swapId);
    } catch (err) {
      expect((err as SphereError).code).toBe('SWAP_WRONG_STATE');
    }
  });

  it('UT-SWAP-REJECT-005: includes reason in rejection DM', async () => {
    await module.rejectSwap(swapRef.swapId, 'Price too high');

    const rejectionDM = findDMByType(mocks.communications._sentDMs, 'swap_rejection');
    expect(rejectionDM).toBeDefined();
    expect(rejectionDM!.parsed.reason).toBe('Price too high');
  });
});
