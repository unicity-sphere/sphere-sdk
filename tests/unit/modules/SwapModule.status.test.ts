/**
 * SwapModule.status.test.ts
 *
 * UT-SWAP-STATUS-001 through UT-SWAP-STATUS-008
 * Tests for getSwapStatus() and getSwaps() methods.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createTestSwapModule,
  createTestSwapRef,
  injectSwapRef,
  SphereError,
  DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
  DEFAULT_TEST_ESCROW_ADDRESS,
  type TestSwapModuleMocks,
} from './swap-test-helpers.js';
import type { SwapModule } from '../../../modules/swap/index.js';

describe('SwapModule — getSwapStatus / getSwaps', () => {
  let module: SwapModule;
  let mocks: TestSwapModuleMocks;

  beforeEach(async () => {
    const ctx = createTestSwapModule();
    module = ctx.module;
    mocks = ctx.mocks;
    await module.load();
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-STATUS-001: getSwapStatus returns SwapRef copy
  // --------------------------------------------------------------------------
  it('UT-SWAP-STATUS-001: getSwapStatus returns local SwapRef with all expected fields', async () => {
    const ref = createTestSwapRef({ progress: 'announced' });
    injectSwapRef(module, ref);

    const result = await module.getSwapStatus(ref.swapId);

    expect(result.swapId).toBe(ref.swapId);
    expect(result.progress).toBe('announced');
    expect(result.role).toBe(ref.role);
    expect(result.deal).toEqual(ref.deal);
    expect(result.manifest).toEqual(ref.manifest);
    expect(result.createdAt).toBe(ref.createdAt);
    expect(result.updatedAt).toBe(ref.updatedAt);

    // Verify it is a copy, not the same reference
    expect(result).not.toBe(ref);
    expect(result.deal).not.toBe(ref.deal);
    expect(result.manifest).not.toBe(ref.manifest);
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-STATUS-002: getSwapStatus optionally queries escrow via DM
  // --------------------------------------------------------------------------
  it('UT-SWAP-STATUS-002: getSwapStatus sends status DM to escrow when queryEscrow is true', async () => {
    const ref = createTestSwapRef({ progress: 'awaiting_counter' });
    injectSwapRef(module, ref);

    await module.getSwapStatus(ref.swapId, { queryEscrow: true });

    // Wait for the fire-and-forget DM to be sent
    await vi.waitFor(() => {
      expect(mocks.communications.sendDM).toHaveBeenCalledWith(
        DEFAULT_TEST_ESCROW_TRANSPORT_PUBKEY,
        expect.stringContaining('status'),
      );
    });

    // resolve() should have been called with the escrow address
    expect(mocks.resolve).toHaveBeenCalledWith(DEFAULT_TEST_ESCROW_ADDRESS);
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-STATUS-003: getSwapStatus on non-existent swap throws SWAP_NOT_FOUND
  // --------------------------------------------------------------------------
  it('UT-SWAP-STATUS-003: getSwapStatus on non-existent swap throws SWAP_NOT_FOUND', async () => {
    await expect(module.getSwapStatus('nonexistent_id_' + '0'.repeat(48))).rejects.toMatchObject({ code: 'SWAP_NOT_FOUND' });
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-STATUS-004: getSwaps returns all tracked swaps
  // --------------------------------------------------------------------------
  it('UT-SWAP-STATUS-004: getSwaps returns all tracked swaps', async () => {
    const ref1 = createTestSwapRef({
      progress: 'proposed',
      deal: {
        partyA: 'DIRECT://party_a_aaa111',
        partyB: 'DIRECT://party_b_bbb222',
        partyACurrency: 'UCT',
        partyAAmount: '1000000',
        partyBCurrency: 'USDU',
        partyBAmount: '500000',
        timeout: 300,
        escrowAddress: DEFAULT_TEST_ESCROW_ADDRESS,
      },
    });

    const ref2 = createTestSwapRef({
      progress: 'awaiting_counter',
      deal: {
        partyA: 'DIRECT://party_a_aaa111',
        partyB: 'DIRECT://party_b_bbb222',
        partyACurrency: 'ALPHA',
        partyAAmount: '2000000',
        partyBCurrency: 'USDU',
        partyBAmount: '1000000',
        timeout: 600,
        escrowAddress: DEFAULT_TEST_ESCROW_ADDRESS,
      },
    });

    const ref3 = createTestSwapRef({
      progress: 'completed',
      deal: {
        partyA: 'DIRECT://party_a_aaa111',
        partyB: 'DIRECT://party_b_bbb222',
        partyACurrency: 'BTC',
        partyAAmount: '100000',
        partyBCurrency: 'UCT',
        partyBAmount: '5000000',
        timeout: 120,
        escrowAddress: DEFAULT_TEST_ESCROW_ADDRESS,
      },
    });

    injectSwapRef(module, ref1);
    injectSwapRef(module, ref2);
    injectSwapRef(module, ref3);

    const results = module.getSwaps();
    expect(results).toHaveLength(3);
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-STATUS-005: getSwaps with progress filter
  // --------------------------------------------------------------------------
  it('UT-SWAP-STATUS-005: getSwaps with progress filter returns matching swaps only', async () => {
    const ref1 = createTestSwapRef({ progress: 'proposed' });
    const ref2 = createTestSwapRef({
      progress: 'awaiting_counter',
      deal: {
        partyA: 'DIRECT://party_a_aaa111',
        partyB: 'DIRECT://party_b_bbb222',
        partyACurrency: 'ALPHA',
        partyAAmount: '2000000',
        partyBCurrency: 'USDU',
        partyBAmount: '1000000',
        timeout: 600,
        escrowAddress: DEFAULT_TEST_ESCROW_ADDRESS,
      },
    });
    const ref3 = createTestSwapRef({
      progress: 'completed',
      deal: {
        partyA: 'DIRECT://party_a_aaa111',
        partyB: 'DIRECT://party_b_bbb222',
        partyACurrency: 'BTC',
        partyAAmount: '100000',
        partyBCurrency: 'UCT',
        partyBAmount: '5000000',
        timeout: 120,
        escrowAddress: DEFAULT_TEST_ESCROW_ADDRESS,
      },
    });

    injectSwapRef(module, ref1);
    injectSwapRef(module, ref2);
    injectSwapRef(module, ref3);

    const results = module.getSwaps({ progress: 'proposed' });
    expect(results).toHaveLength(1);
    expect(results[0].progress).toBe('proposed');
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-STATUS-006: getSwaps with role filter
  // --------------------------------------------------------------------------
  it('UT-SWAP-STATUS-006: getSwaps with role filter returns matching role only', async () => {
    const ref1 = createTestSwapRef({ role: 'proposer', progress: 'proposed' });
    const ref2 = createTestSwapRef({
      role: 'acceptor',
      progress: 'proposed',
      deal: {
        partyA: 'DIRECT://party_a_aaa111',
        partyB: 'DIRECT://party_b_bbb222',
        partyACurrency: 'ALPHA',
        partyAAmount: '2000000',
        partyBCurrency: 'USDU',
        partyBAmount: '1000000',
        timeout: 600,
        escrowAddress: DEFAULT_TEST_ESCROW_ADDRESS,
      },
    });

    injectSwapRef(module, ref1);
    injectSwapRef(module, ref2);

    const results = module.getSwaps({ role: 'acceptor' });
    expect(results).toHaveLength(1);
    expect(results[0].role).toBe('acceptor');
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-STATUS-007: getSwaps excludeTerminal (default behavior)
  // --------------------------------------------------------------------------
  it('UT-SWAP-STATUS-007: getSwaps with excludeTerminal filters out terminal states', async () => {
    const ref1 = createTestSwapRef({ progress: 'proposed' });
    const ref2 = createTestSwapRef({
      progress: 'completed',
      deal: {
        partyA: 'DIRECT://party_a_aaa111',
        partyB: 'DIRECT://party_b_bbb222',
        partyACurrency: 'ALPHA',
        partyAAmount: '2000000',
        partyBCurrency: 'USDU',
        partyBAmount: '1000000',
        timeout: 600,
        escrowAddress: DEFAULT_TEST_ESCROW_ADDRESS,
      },
    });
    const ref3 = createTestSwapRef({
      progress: 'cancelled',
      deal: {
        partyA: 'DIRECT://party_a_aaa111',
        partyB: 'DIRECT://party_b_bbb222',
        partyACurrency: 'BTC',
        partyAAmount: '100000',
        partyBCurrency: 'UCT',
        partyBAmount: '5000000',
        timeout: 120,
        escrowAddress: DEFAULT_TEST_ESCROW_ADDRESS,
      },
    });

    injectSwapRef(module, ref1);
    injectSwapRef(module, ref2);
    injectSwapRef(module, ref3);

    const results = module.getSwaps({ excludeTerminal: true });
    expect(results).toHaveLength(1);
    expect(results[0].progress).toBe('proposed');
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-STATUS-008: getSwaps empty returns empty array
  // --------------------------------------------------------------------------
  it('UT-SWAP-STATUS-008: getSwaps returns empty array when no swaps exist', () => {
    const results = module.getSwaps();
    expect(results).toEqual([]);
    expect(results).toHaveLength(0);
  });
});
