/**
 * SwapModule Lifecycle Tests
 *
 * Test IDs: UT-SWAP-LIFE-001 through UT-SWAP-LIFE-011
 *
 * Covers constructor defaults, initialize/load/destroy lifecycle,
 * DM handler and invoice event subscriptions, and guard errors.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSwapModule } from '../../../modules/swap/index.js';
import type { SwapModule } from '../../../modules/swap/index.js';
import {
  createTestSwapModule,
  createTestSwapRef,
  injectSwapRef,
  createMockStorageProvider,
  SphereError,
  DEFAULT_TEST_PARTY_A_ADDRESS,
} from './swap-test-helpers.js';
import type { TestSwapModuleMocks } from './swap-test-helpers.js';
import { STORAGE_KEYS_ADDRESS, getAddressStorageKey } from '../../../constants.js';

describe('SwapModule Lifecycle', () => {
  let module: SwapModule;
  let mocks: TestSwapModuleMocks;

  afterEach(async () => {
    try {
      await module?.destroy();
    } catch {
      // ignore — may already be destroyed
    }
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-LIFE-001: constructor accepts config, sets defaults
  // --------------------------------------------------------------------------
  it('UT-SWAP-LIFE-001: constructor accepts config with defaults', () => {
    const mod = createSwapModule({ maxPendingSwaps: 5 });

    // Access internal config via bracket notation
    const cfg = (mod as any).config;
    expect(cfg.maxPendingSwaps).toBe(5);
    // Defaults applied
    expect(cfg.announceTimeoutMs).toBe(120_000);
    expect(cfg.terminalPurgeTtlMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(cfg.proposalTimeoutMs).toBe(300_000);
    expect(cfg.debug).toBe(false);

    module = mod; // for afterEach cleanup
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-LIFE-002: initialize() stores deps reference
  // --------------------------------------------------------------------------
  it('UT-SWAP-LIFE-002: initialize() stores deps reference', () => {
    const result = createTestSwapModule();
    module = result.module;
    mocks = result.mocks;

    // After createTestSwapModule, initialize() has been called.
    // The deps should be stored (module.deps !== null).
    const internalDeps = (module as any).deps;
    expect(internalDeps).not.toBeNull();
    expect(internalDeps.storage).toBe(mocks.storage);
    expect(internalDeps.accounting).toBe(mocks.accounting);
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-LIFE-003: load() loads persisted swap records from storage
  // --------------------------------------------------------------------------
  it('UT-SWAP-LIFE-003: load() loads persisted swap records from storage', async () => {
    const result = createTestSwapModule();
    module = result.module;
    mocks = result.mocks;

    const addressId = DEFAULT_TEST_PARTY_A_ADDRESS;

    // Pre-populate storage with an index and one active swap record
    const activeSwapRef = createTestSwapRef({ progress: 'announced' });
    const indexKey = getAddressStorageKey(addressId, STORAGE_KEYS_ADDRESS.SWAP_INDEX);
    const swapKey = getAddressStorageKey(
      addressId,
      `${STORAGE_KEYS_ADDRESS.SWAP_RECORD_PREFIX}${activeSwapRef.swapId}`,
    );

    const indexData = JSON.stringify([
      { swapId: activeSwapRef.swapId, progress: 'announced', role: 'proposer', createdAt: activeSwapRef.createdAt },
    ]);
    const swapData = JSON.stringify({ version: 1, swap: activeSwapRef });

    await mocks.storage.set(indexKey, indexData);
    await mocks.storage.set(swapKey, swapData);

    await module.load();

    const swaps = module.getSwaps();
    expect(swaps.length).toBe(1);
    expect(swaps[0].swapId).toBe(activeSwapRef.swapId);
    expect(swaps[0].progress).toBe('announced');
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-LIFE-004: load() registers DM handler for swap messages
  // --------------------------------------------------------------------------
  it('UT-SWAP-LIFE-004: load() registers DM handler', async () => {
    const result = createTestSwapModule();
    module = result.module;
    mocks = result.mocks;

    await module.load();

    expect(mocks.communications.onDirectMessage).toHaveBeenCalledOnce();
    expect(mocks.communications.onDirectMessage).toHaveBeenCalledWith(expect.any(Function));
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-LIFE-005: load() subscribes to invoice events
  // --------------------------------------------------------------------------
  it('UT-SWAP-LIFE-005: load() subscribes to invoice events', async () => {
    const result = createTestSwapModule();
    module = result.module;
    mocks = result.mocks;

    await module.load();

    // accounting.on() should be called for invoice:payment, invoice:covered,
    // and invoice:return_received
    const calledEvents = mocks.accounting.on.mock.calls.map((call: any[]) => call[0]);
    expect(calledEvents).toContain('invoice:payment');
    expect(calledEvents).toContain('invoice:covered');
    expect(calledEvents).toContain('invoice:return_received');
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-LIFE-006: destroy() unsubscribes all handlers
  // --------------------------------------------------------------------------
  it('UT-SWAP-LIFE-006: destroy() unsubscribes all handlers', async () => {
    const result = createTestSwapModule();
    module = result.module;
    mocks = result.mocks;

    await module.load();

    // Capture the unsubscribe functions that were returned by on/onDirectMessage
    const dmUnsub = mocks.communications.onDirectMessage.mock.results[0].value;
    // After load, accounting.on returns unsub functions
    const accountingUnsubs = mocks.accounting.on.mock.results.map((r: any) => r.value);

    // Before destroy, the DM handler should be active
    expect(mocks.communications._dmHandlers.length).toBeGreaterThan(0);

    await module.destroy();

    // The DM handlers should have been unsubscribed (array empty)
    expect(mocks.communications._dmHandlers.length).toBe(0);

    // Accounting handlers should also be unsubscribed
    // (their unsub functions were called during destroy)
    // We verify by checking that the handlers map is empty
    for (const [event, handlers] of mocks.accounting._handlers) {
      expect(handlers.length).toBe(0);
    }
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-LIFE-007: destroy() persists dirty swap records
  // --------------------------------------------------------------------------
  it('UT-SWAP-LIFE-007: destroy() persists dirty state', async () => {
    const result = createTestSwapModule();
    module = result.module;
    mocks = result.mocks;

    await module.load();

    // Inject a swap to simulate an active swap in memory
    const swapRef = createTestSwapRef({ progress: 'announced' });
    injectSwapRef(module, swapRef);

    // Clear storage set calls so far
    mocks.storage.set.mockClear();

    await module.destroy();

    // destroy() should call persistIndex which calls storage.set
    expect(mocks.storage.set).toHaveBeenCalled();

    // Verify that the index was persisted
    const setCalls = mocks.storage.set.mock.calls;
    const indexCallFound = setCalls.some((call: any[]) => {
      const key = call[0] as string;
      return key.includes(STORAGE_KEYS_ADDRESS.SWAP_INDEX);
    });
    expect(indexCallFound).toBe(true);
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-LIFE-008: destroy() clears local timers
  // --------------------------------------------------------------------------
  it('UT-SWAP-LIFE-008: destroy() clears local timers', async () => {
    const result = createTestSwapModule();
    module = result.module;
    mocks = result.mocks;

    await module.load();

    // Inject a swap and set up a timer manually to verify cleanup
    const swapRef = createTestSwapRef({ progress: 'proposed', role: 'proposer' });
    injectSwapRef(module, swapRef);

    // Access internal localTimers
    const localTimers = (module as any).localTimers as Map<string, ReturnType<typeof setTimeout>>;

    // Manually add a timer
    const timer = setTimeout(() => {}, 999_999);
    localTimers.set(swapRef.swapId, timer);

    await module.destroy();

    // After destroy, localTimers should be empty
    expect(localTimers.size).toBe(0);
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-LIFE-009: double initialize replaces deps (no throw in current impl)
  // --------------------------------------------------------------------------
  it('UT-SWAP-LIFE-009: double initialize replaces deps without throwing', () => {
    // The current implementation allows re-initialization (for switchToAddress flow).
    // It resets the destroyed flag and replaces deps.
    const result = createTestSwapModule();
    module = result.module;
    mocks = result.mocks;

    // Second initialize should not throw
    const deps2 = (module as any).deps;
    expect(() => {
      module.initialize(deps2);
    }).not.toThrow();

    // deps should still be set
    expect((module as any).deps).not.toBeNull();
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-LIFE-010: operations before load throw SWAP_NOT_INITIALIZED
  // --------------------------------------------------------------------------
  it('UT-SWAP-LIFE-010: operations before load throw SWAP_NOT_INITIALIZED', async () => {
    // Create a module that is initialized but NOT loaded
    const result = createTestSwapModule();
    module = result.module;
    mocks = result.mocks;
    // Note: createTestSwapModule calls initialize() but NOT load()

    const deal = {
      partyA: DEFAULT_TEST_PARTY_A_ADDRESS,
      partyB: 'DIRECT://party_b_bbb222',
      partyACurrency: 'UCT',
      partyAAmount: '1000000',
      partyBCurrency: 'USDU',
      partyBAmount: '500000',
      timeout: 300,
      escrowAddress: 'DIRECT://escrow_eee333',
    };

    // proposeSwap requires loaded state (ensureReady)
    await expect(module.proposeSwap(deal)).rejects.toThrow(SphereError);

    // getSwaps is synchronous, so it throws directly
    expect(() => module.getSwaps()).toThrow(SphereError);

    // acceptSwap
    await expect(module.acceptSwap('fake-id')).rejects.toThrow(SphereError);

    // rejectSwap
    await expect(module.rejectSwap('fake-id')).rejects.toThrow(SphereError);

    // cancelSwap
    await expect(module.cancelSwap('fake-id')).rejects.toThrow(SphereError);

    // deposit
    await expect(module.deposit('fake-id')).rejects.toThrow(SphereError);

    // getSwapStatus
    await expect(module.getSwapStatus('fake-id')).rejects.toThrow(SphereError);

    // verifyPayout
    await expect(module.verifyPayout('fake-id')).rejects.toThrow(SphereError);
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-LIFE-011: operations after destroy throw SWAP_MODULE_DESTROYED
  // --------------------------------------------------------------------------
  it('UT-SWAP-LIFE-011: operations after destroy throw SWAP_MODULE_DESTROYED', async () => {
    const result = createTestSwapModule();
    module = result.module;
    mocks = result.mocks;

    await module.load();
    await module.destroy();

    const deal = {
      partyA: DEFAULT_TEST_PARTY_A_ADDRESS,
      partyB: 'DIRECT://party_b_bbb222',
      partyACurrency: 'UCT',
      partyAAmount: '1000000',
      partyBCurrency: 'USDU',
      partyBAmount: '500000',
      timeout: 300,
      escrowAddress: 'DIRECT://escrow_eee333',
    };

    // All public methods should throw SWAP_MODULE_DESTROYED
    await expect(module.proposeSwap(deal)).rejects.toMatchObject({ code: 'SWAP_MODULE_DESTROYED' });
    expect(() => module.getSwaps()).toThrow(expect.objectContaining({ code: 'SWAP_MODULE_DESTROYED' }));
    await expect(module.acceptSwap('fake-id')).rejects.toMatchObject({ code: 'SWAP_MODULE_DESTROYED' });
    await expect(module.rejectSwap('fake-id')).rejects.toMatchObject({ code: 'SWAP_MODULE_DESTROYED' });
    await expect(module.cancelSwap('fake-id')).rejects.toMatchObject({ code: 'SWAP_MODULE_DESTROYED' });
    await expect(module.deposit('fake-id')).rejects.toMatchObject({ code: 'SWAP_MODULE_DESTROYED' });
    await expect(module.getSwapStatus('fake-id')).rejects.toMatchObject({ code: 'SWAP_MODULE_DESTROYED' });
    await expect(module.verifyPayout('fake-id')).rejects.toMatchObject({ code: 'SWAP_MODULE_DESTROYED' });
  });
});
