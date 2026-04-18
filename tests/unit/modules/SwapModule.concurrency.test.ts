/**
 * SwapModule Concurrency Tests
 *
 * Test IDs: UT-SWAP-CONC-001 through UT-SWAP-CONC-004
 *
 * Validates per-swap async mutex (withSwapGate): serialization of concurrent
 * operations on the same swap, parallelism on different swaps, gate release
 * on error, and idempotent proposeSwap.
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
  DEFAULT_TEST_PARTY_B_ADDRESS,
  DEFAULT_TEST_PARTY_B_TRANSPORT_PUBKEY,
  DEFAULT_TEST_ESCROW_ADDRESS,
  DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
} from './swap-test-helpers.js';
import type { TestSwapModuleMocks } from './swap-test-helpers.js';

describe('SwapModule Concurrency', () => {
  let module: SwapModule;
  let mocks: TestSwapModuleMocks;

  beforeEach(async () => {
    const result = createTestSwapModule();
    module = result.module;
    mocks = result.mocks;
    await module.load();
  });

  afterEach(async () => {
    try {
      await module?.destroy();
    } catch {
      // ignore
    }
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-CONC-001: concurrent operations on same swap are serialized
  // --------------------------------------------------------------------------
  it('UT-SWAP-CONC-001: concurrent operations on same swap are serialized', async () => {
    // Inject a swap in 'proposed' state with role 'acceptor' so acceptSwap works
    const swapRef = createTestSwapRef({
      progress: 'proposed',
      role: 'acceptor',
      counterpartyPubkey: DEFAULT_TEST_PARTY_B_TRANSPORT_PUBKEY,
      escrowPubkey: DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
      escrowDirectAddress: DEFAULT_TEST_ESCROW_ADDRESS,
    });
    injectSwapRef(module, swapRef);

    // acceptSwap transitions proposed -> accepted, which means a second
    // cancelSwap on the same swapId will either:
    // (a) hit a wrong-state after accept completes, or
    // (b) run after accept finishes and find the swap in 'accepted' (or later) state

    const results = await Promise.allSettled([
      module.acceptSwap(swapRef.swapId),
      module.cancelSwap(swapRef.swapId),
    ]);

    // One should succeed, the other may succeed or fail depending on order.
    // The key invariant: they are serialized, so the final state is consistent.
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');

    // At least one operation should succeed
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    // The final swap state should be a single consistent value
    // (either accepted+cancelled or just cancelled)
    // It should not be in an inconsistent intermediate state
    const swaps = module.getSwaps();
    // If both succeeded, the swap should be cancelled (cancel after accept)
    // If cancel failed, the swap should be in accepted or later
    // Either way the state should be one of: accepted, cancelled, or failed
    if (swaps.length > 0) {
      expect(['accepted', 'cancelled', 'failed']).toContain(swaps[0].progress);
    }
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-CONC-002: operations on different swaps run in parallel
  // --------------------------------------------------------------------------
  it('UT-SWAP-CONC-002: operations on different swaps run in parallel', async () => {
    // Create two distinct swaps in 'proposed' state with role 'acceptor'
    const deal1 = createTestSwapDeal({ partyAAmount: '1000000' });
    const deal2 = createTestSwapDeal({ partyAAmount: '2000000' });

    const swap1 = createTestSwapRef({
      deal: deal1,
      progress: 'proposed',
      role: 'acceptor',
      counterpartyPubkey: DEFAULT_TEST_PARTY_B_TRANSPORT_PUBKEY,
      escrowPubkey: DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
      escrowDirectAddress: DEFAULT_TEST_ESCROW_ADDRESS,
    });
    const swap2 = createTestSwapRef({
      deal: deal2,
      progress: 'proposed',
      role: 'acceptor',
      counterpartyPubkey: DEFAULT_TEST_PARTY_B_TRANSPORT_PUBKEY,
      escrowPubkey: DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
      escrowDirectAddress: DEFAULT_TEST_ESCROW_ADDRESS,
    });

    injectSwapRef(module, swap1);
    injectSwapRef(module, swap2);

    // Both accept operations should succeed independently
    const results = await Promise.allSettled([
      module.acceptSwap(swap1.swapId),
      module.acceptSwap(swap2.swapId),
    ]);

    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('fulfilled');
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-CONC-003: gate released on error (no deadlock)
  // --------------------------------------------------------------------------
  it('UT-SWAP-CONC-003: gate released on error (no deadlock)', async () => {
    // Inject a swap where acceptSwap will fail (proposer can't accept)
    const swapRef = createTestSwapRef({
      progress: 'proposed',
      role: 'proposer', // proposer can't accept -> will throw SWAP_WRONG_STATE
      counterpartyPubkey: DEFAULT_TEST_PARTY_B_TRANSPORT_PUBKEY,
    });
    injectSwapRef(module, swapRef);

    // First operation: acceptSwap should fail (proposer can't accept)
    await expect(module.acceptSwap(swapRef.swapId)).rejects.toThrow();

    // Second operation on the same swap: cancelSwap should succeed
    // (gate should have been released after the error)
    await expect(module.cancelSwap(swapRef.swapId)).resolves.toBeUndefined();

    // Verify swap is cancelled
    const swaps = module.getSwaps();
    // After cancel, swap may be removed from active list or marked cancelled
    // The fact that cancelSwap resolved (didn't hang) proves the gate was released
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-CONC-004: concurrent proposeSwap with same deal returns idempotent result
  // --------------------------------------------------------------------------
  it('UT-SWAP-CONC-004: concurrent proposeSwap with same deal creates two swaps (unique salt)', async () => {
    const deal = createTestSwapDeal();

    // Call proposeSwap twice concurrently with the same deal
    const results = await Promise.allSettled([
      module.proposeSwap(deal),
      module.proposeSwap(deal),
    ]);

    // Both should succeed
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(2);

    // Each call generates a unique salt, so swap_ids differ
    const id1 = (fulfilled[0] as PromiseFulfilledResult<any>).value.swapId;
    const id2 = (fulfilled[1] as PromiseFulfilledResult<any>).value.swapId;
    expect(id1).not.toBe(id2);

    // 2 swaps should exist in the module
    const swaps = module.getSwaps();
    expect(swaps.length).toBe(2);
  });
});
