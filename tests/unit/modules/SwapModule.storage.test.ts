/**
 * SwapModule Storage Tests
 *
 * Test IDs: UT-SWAP-STORE-001 through UT-SWAP-STORE-005
 *
 * Validates persistence: state transitions trigger storage writes,
 * load() restores persisted swaps, destroy() flushes dirty state,
 * storage corruption is handled gracefully, and terminal swaps
 * are purged after TTL.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SwapModule } from '../../../modules/swap/index.js';
import {
  createTestSwapModule,
  createTestSwapRef,
  createTestSwapDeal,
  injectSwapRef,
  SphereError,
  DEFAULT_TEST_PARTY_A_ADDRESS,
  DEFAULT_TEST_PARTY_B_TRANSPORT_PUBKEY,
  DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
  DEFAULT_TEST_ESCROW_ADDRESS,
} from './swap-test-helpers.js';
import type { TestSwapModuleMocks } from './swap-test-helpers.js';
import { STORAGE_KEYS_ADDRESS, getAddressStorageKey } from '../../../constants.js';

/** Helper: build the storage key for a swap record. */
function swapRecordKey(addressId: string, swapId: string): string {
  return getAddressStorageKey(addressId, `${STORAGE_KEYS_ADDRESS.SWAP_RECORD_PREFIX}${swapId}`);
}

/** Helper: build the storage key for the swap index. */
function swapIndexKey(addressId: string): string {
  return getAddressStorageKey(addressId, STORAGE_KEYS_ADDRESS.SWAP_INDEX);
}

describe('SwapModule Storage', () => {
  let module: SwapModule;
  let mocks: TestSwapModuleMocks;

  const addressId = DEFAULT_TEST_PARTY_A_ADDRESS;

  afterEach(async () => {
    try {
      await module?.destroy();
    } catch {
      // ignore
    }
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-STORE-001: swap record persisted on state transition
  // --------------------------------------------------------------------------
  it('UT-SWAP-STORE-001: swap record persisted on state transition', async () => {
    const result = createTestSwapModule();
    module = result.module;
    mocks = result.mocks;
    await module.load();

    // Inject a swap in 'proposed' state with role 'acceptor' so we can accept it
    const swapRef = createTestSwapRef({
      progress: 'proposed',
      role: 'acceptor',
      counterpartyPubkey: DEFAULT_TEST_PARTY_B_TRANSPORT_PUBKEY,
      escrowPubkey: DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
      escrowDirectAddress: DEFAULT_TEST_ESCROW_ADDRESS,
    });
    injectSwapRef(module, swapRef);

    // Clear storage mocks so we can track new writes
    mocks.storage.set.mockClear();

    // acceptSwap transitions proposed -> accepted, which triggers persistSwap
    await module.acceptSwap(swapRef.swapId);

    // Verify storage.set was called with the swap record key
    const setCallKeys = mocks.storage.set.mock.calls.map((c: any[]) => c[0] as string);
    const expectedKey = swapRecordKey(addressId, swapRef.swapId);
    expect(setCallKeys).toContain(expectedKey);

    // Verify the stored JSON contains the updated progress
    const swapRecordCall = mocks.storage.set.mock.calls.find(
      (c: any[]) => (c[0] as string) === expectedKey,
    );
    expect(swapRecordCall).toBeDefined();
    const storedData = JSON.parse(swapRecordCall![1] as string);
    expect(storedData.version).toBe(1);
    expect(storedData.swap.progress).toBe('accepted');
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-STORE-002: load() restores persisted swaps
  // --------------------------------------------------------------------------
  it('UT-SWAP-STORE-002: load() restores persisted swaps', async () => {
    const result = createTestSwapModule();
    module = result.module;
    mocks = result.mocks;

    // Create two non-terminal swap records
    const swap1 = createTestSwapRef({
      progress: 'announced',
      deal: createTestSwapDeal({ partyAAmount: '1000000' }),
    });
    const swap2 = createTestSwapRef({
      progress: 'depositing',
      deal: createTestSwapDeal({ partyAAmount: '2000000' }),
    });

    // Pre-populate storage with index and swap records
    const indexEntries = [
      { swapId: swap1.swapId, progress: swap1.progress, role: swap1.role, createdAt: swap1.createdAt },
      { swapId: swap2.swapId, progress: swap2.progress, role: swap2.role, createdAt: swap2.createdAt },
    ];

    await mocks.storage.set(swapIndexKey(addressId), JSON.stringify(indexEntries));
    await mocks.storage.set(swapRecordKey(addressId, swap1.swapId), JSON.stringify({ version: 1, swap: swap1 }));
    await mocks.storage.set(swapRecordKey(addressId, swap2.swapId), JSON.stringify({ version: 1, swap: swap2 }));

    await module.load();

    const swaps = module.getSwaps();
    expect(swaps.length).toBe(2);

    const ids = swaps.map(s => s.swapId);
    expect(ids).toContain(swap1.swapId);
    expect(ids).toContain(swap2.swapId);

    // Verify states match
    const loaded1 = swaps.find(s => s.swapId === swap1.swapId);
    expect(loaded1?.progress).toBe('announced');
    const loaded2 = swaps.find(s => s.swapId === swap2.swapId);
    expect(loaded2?.progress).toBe('depositing');
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-STORE-003: destroy() persists dirty records
  // --------------------------------------------------------------------------
  it('UT-SWAP-STORE-003: destroy() persists dirty records', async () => {
    const result = createTestSwapModule();
    module = result.module;
    mocks = result.mocks;
    await module.load();

    // Inject a swap that simulates dirty state
    const swapRef = createTestSwapRef({ progress: 'announced' });
    injectSwapRef(module, swapRef);

    // Clear storage calls from inject/load
    mocks.storage.set.mockClear();

    await module.destroy();

    // destroy() should call persistIndex() which writes the index
    expect(mocks.storage.set).toHaveBeenCalled();

    const indexKey = swapIndexKey(addressId);
    const indexCall = mocks.storage.set.mock.calls.find(
      (c: any[]) => (c[0] as string) === indexKey,
    );
    expect(indexCall).toBeDefined();

    // Parse the persisted index and verify the swap is in it
    const persistedIndex = JSON.parse(indexCall![1] as string);
    expect(Array.isArray(persistedIndex)).toBe(true);
    const entry = persistedIndex.find((e: any) => e.swapId === swapRef.swapId);
    expect(entry).toBeDefined();
    expect(entry.progress).toBe('announced');
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-STORE-004: storage corruption handled gracefully
  // --------------------------------------------------------------------------
  it('UT-SWAP-STORE-004: storage corruption handled gracefully', async () => {
    const result = createTestSwapModule();
    module = result.module;
    mocks = result.mocks;

    // Create one valid and one corrupted swap record
    const validSwap = createTestSwapRef({ progress: 'announced' });
    const corruptedSwapId = 'deadbeef'.repeat(8);

    const indexEntries = [
      { swapId: validSwap.swapId, progress: 'announced', role: 'proposer', createdAt: validSwap.createdAt },
      { swapId: corruptedSwapId, progress: 'depositing', role: 'acceptor', createdAt: Date.now() },
    ];

    await mocks.storage.set(swapIndexKey(addressId), JSON.stringify(indexEntries));
    await mocks.storage.set(
      swapRecordKey(addressId, validSwap.swapId),
      JSON.stringify({ version: 1, swap: validSwap }),
    );
    // Store invalid JSON for the corrupted swap
    await mocks.storage.set(
      swapRecordKey(addressId, corruptedSwapId),
      '{not valid json!!!',
    );

    // load() should not throw
    await expect(module.load()).resolves.toBeUndefined();

    // Only the valid swap should be loaded
    const swaps = module.getSwaps();
    expect(swaps.length).toBe(1);
    expect(swaps[0].swapId).toBe(validSwap.swapId);
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-STORE-005: terminal swaps purged after TTL
  // --------------------------------------------------------------------------
  it('UT-SWAP-STORE-005: terminal swaps purged after TTL', async () => {
    // Use a very short TTL so our old swap expires
    const result = createTestSwapModule({ terminalPurgeTtlMs: 1000 });
    module = result.module;
    mocks = result.mocks;

    // Create a completed swap that was created 10 seconds ago (well past 1s TTL)
    const oldCreatedAt = Date.now() - 10_000;
    const completedSwapId = 'completed' + 'a'.repeat(55);

    const indexEntries = [
      { swapId: completedSwapId, progress: 'completed', role: 'proposer', createdAt: oldCreatedAt },
    ];

    await mocks.storage.set(swapIndexKey(addressId), JSON.stringify(indexEntries));
    await mocks.storage.set(
      swapRecordKey(addressId, completedSwapId),
      JSON.stringify({
        version: 1,
        swap: createTestSwapRef({
          swapId: completedSwapId,
          progress: 'completed',
          createdAt: oldCreatedAt,
        }),
      }),
    );

    // Clear remove calls
    mocks.storage.remove.mockClear();

    await module.load();

    // The expired terminal swap should not be loaded
    const swaps = module.getSwaps();
    expect(swaps.length).toBe(0);

    // storage.remove should have been called for the purged swap's record key
    const removeCallKeys = mocks.storage.remove.mock.calls.map((c: any[]) => c[0] as string);
    const expectedPurgeKey = swapRecordKey(addressId, completedSwapId);
    expect(removeCallKeys).toContain(expectedPurgeKey);
  });
});
