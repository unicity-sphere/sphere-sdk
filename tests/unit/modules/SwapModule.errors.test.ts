/**
 * SwapModule Error Code Tests
 *
 * UT-SWAP-ERR-001 through UT-SWAP-ERR-015
 *
 * Tests that each error code is thrown with the correct SphereError.code.
 *
 * @see docs/SWAP-TEST-SPEC.md section 3.15
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSwapModule, type SwapModule } from '../../../modules/swap/index.js';
import {
  createTestSwapModule,
  createTestSwapDeal,
  createTestSwapRef,
  injectSwapRef,
  SphereError,
  DEFAULT_TEST_PARTY_A_PUBKEY,
  DEFAULT_TEST_PARTY_A_ADDRESS,
  DEFAULT_TEST_PARTY_B_PUBKEY,
  DEFAULT_TEST_PARTY_B_ADDRESS,
  DEFAULT_TEST_ESCROW_PUBKEY,
  DEFAULT_TEST_ESCROW_ADDRESS,
  type TestSwapModuleMocks,
} from './swap-test-helpers.js';

describe('SwapModule.errors', () => {
  let module: SwapModule;
  let mocks: TestSwapModuleMocks;

  beforeEach(async () => {
    const result = createTestSwapModule();
    module = result.module;
    mocks = result.mocks;
    await module.load();
  });

  afterEach(async () => {
    await module.destroy();
  });

  // =========================================================================
  // UT-SWAP-ERR-001: SWAP_NOT_FOUND — getSwapStatus with nonexistent ID
  // =========================================================================

  it('UT-SWAP-ERR-001: SWAP_NOT_FOUND on getSwapStatus', async () => {
    const err = await module.getSwapStatus('nonexistent_' + 'f'.repeat(52)).catch(e => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('SWAP_NOT_FOUND');
  });

  // =========================================================================
  // UT-SWAP-ERR-002: SWAP_INVALID_DEAL — proposeSwap with empty partyA
  // =========================================================================

  it('UT-SWAP-ERR-002: SWAP_INVALID_DEAL on proposeSwap with empty partyA', async () => {
    const badDeal = createTestSwapDeal({ partyA: '' });
    const err = await module.proposeSwap(badDeal).catch(e => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('SWAP_INVALID_DEAL');
  });

  // =========================================================================
  // UT-SWAP-ERR-003: SWAP_WRONG_STATE — deposit on 'proposed' swap
  // =========================================================================

  it('UT-SWAP-ERR-003: SWAP_WRONG_STATE on deposit for proposed swap', async () => {
    const ref = createTestSwapRef({
      role: 'acceptor',
      progress: 'proposed',
      counterpartyPubkey: DEFAULT_TEST_PARTY_B_PUBKEY,
    });
    injectSwapRef(module, ref);

    const err = await module.deposit(ref.swapId).catch(e => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('SWAP_WRONG_STATE');
  });

  // =========================================================================
  // UT-SWAP-ERR-004: SWAP_WRONG_STATE — acceptSwap on proposer's swap
  // =========================================================================

  it('UT-SWAP-ERR-004: SWAP_WRONG_STATE on acceptSwap for proposer role', async () => {
    const ref = createTestSwapRef({
      role: 'proposer',
      progress: 'proposed',
      counterpartyPubkey: DEFAULT_TEST_PARTY_B_PUBKEY,
    });
    injectSwapRef(module, ref);

    const err = await module.acceptSwap(ref.swapId).catch(e => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('SWAP_WRONG_STATE');
  });

  // =========================================================================
  // UT-SWAP-ERR-005: SWAP_RESOLVE_FAILED — nametag resolution returns null
  // =========================================================================

  it('UT-SWAP-ERR-005: SWAP_RESOLVE_FAILED when escrow address cannot be resolved', async () => {
    // Use a deal with an escrow address that cannot be resolved
    const deal = createTestSwapDeal({
      escrowAddress: '@unknown_escrow_that_does_not_exist',
    });

    // Mock resolve to return null for the unknown escrow
    mocks.resolve._peers.delete('@unknown_escrow_that_does_not_exist');

    const err = await module.proposeSwap(deal).catch(e => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('SWAP_RESOLVE_FAILED');
  });

  // =========================================================================
  // UT-SWAP-ERR-006: SWAP_DM_SEND_FAILED — sendDM rejects
  // =========================================================================

  it('UT-SWAP-ERR-006: SWAP_DM_SEND_FAILED when sendDM rejects', async () => {
    // Make sendDM reject
    mocks.communications.sendDM.mockRejectedValueOnce(new Error('Network failure'));

    const deal = createTestSwapDeal();
    const err = await module.proposeSwap(deal).catch(e => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('SWAP_DM_SEND_FAILED');
  });

  // =========================================================================
  // UT-SWAP-ERR-007: SWAP_DEPOSIT_FAILED — payInvoice rejects
  // =========================================================================

  it('UT-SWAP-ERR-007: SWAP_DEPOSIT_FAILED when payInvoice rejects', async () => {
    const ref = createTestSwapRef({
      role: 'proposer',
      progress: 'announced',
      counterpartyPubkey: DEFAULT_TEST_PARTY_B_PUBKEY,
      escrowPubkey: DEFAULT_TEST_ESCROW_PUBKEY,
      escrowDirectAddress: DEFAULT_TEST_ESCROW_ADDRESS,
      depositInvoiceId: 'test-deposit-invoice-err007',
    });
    injectSwapRef(module, ref);

    // Make payInvoice reject
    mocks.accounting.payInvoice.mockRejectedValueOnce(new Error('Insufficient balance'));

    const err = await module.deposit(ref.swapId).catch(e => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('SWAP_DEPOSIT_FAILED');
  });

  // =========================================================================
  // UT-SWAP-ERR-008: SWAP_NOT_FOUND — acceptSwap with nonexistent ID
  // =========================================================================

  it('UT-SWAP-ERR-008: SWAP_NOT_FOUND on acceptSwap with nonexistent ID', async () => {
    const err = await module.acceptSwap('f'.repeat(64)).catch(e => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('SWAP_NOT_FOUND');
  });

  // =========================================================================
  // UT-SWAP-ERR-009: SWAP_NOT_FOUND — rejectSwap with nonexistent ID
  // =========================================================================

  it('UT-SWAP-ERR-009: SWAP_NOT_FOUND on rejectSwap with nonexistent ID', async () => {
    const err = await module.rejectSwap('f'.repeat(64)).catch(e => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('SWAP_NOT_FOUND');
  });

  // =========================================================================
  // UT-SWAP-ERR-010: SWAP_ALREADY_COMPLETED — cancelSwap on completed swap
  // =========================================================================

  it('UT-SWAP-ERR-010: SWAP_ALREADY_COMPLETED on cancelSwap for completed swap', async () => {
    const ref = createTestSwapRef({
      role: 'proposer',
      progress: 'completed',
      counterpartyPubkey: DEFAULT_TEST_PARTY_B_PUBKEY,
    });
    injectSwapRef(module, ref);

    const err = await module.cancelSwap(ref.swapId).catch(e => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('SWAP_ALREADY_COMPLETED');
  });

  // =========================================================================
  // UT-SWAP-ERR-011: SWAP_ALREADY_CANCELLED — cancelSwap on cancelled swap
  // =========================================================================

  it('UT-SWAP-ERR-011: SWAP_ALREADY_CANCELLED on cancelSwap for cancelled swap', async () => {
    const ref = createTestSwapRef({
      role: 'proposer',
      progress: 'cancelled',
      counterpartyPubkey: DEFAULT_TEST_PARTY_B_PUBKEY,
    });
    injectSwapRef(module, ref);

    const err = await module.cancelSwap(ref.swapId).catch(e => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('SWAP_ALREADY_CANCELLED');
  });

  // =========================================================================
  // UT-SWAP-ERR-012: SWAP_LIMIT_EXCEEDED — exceed maxPendingSwaps
  // =========================================================================

  it('UT-SWAP-ERR-012: SWAP_LIMIT_EXCEEDED when max pending swaps reached', async () => {
    // Destroy the current module and create one with maxPendingSwaps=1
    await module.destroy();
    const result = createTestSwapModule({ maxPendingSwaps: 1 });
    module = result.module;
    mocks = result.mocks;
    await module.load();

    // Inject one active swap to fill the limit
    const existingRef = createTestSwapRef({
      role: 'proposer',
      progress: 'announced',
      counterpartyPubkey: DEFAULT_TEST_PARTY_B_PUBKEY,
    });
    injectSwapRef(module, existingRef);

    // Now try to propose another swap
    const deal = createTestSwapDeal({
      partyAAmount: '999999', // different amounts to get a different swap_id
      partyBAmount: '888888',
    });
    const err = await module.proposeSwap(deal).catch(e => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('SWAP_LIMIT_EXCEEDED');
  });

  // =========================================================================
  // UT-SWAP-ERR-013: SWAP_NOT_INITIALIZED — operation before load()
  // =========================================================================

  it('UT-SWAP-ERR-013: SWAP_NOT_INITIALIZED on operation before load', async () => {
    // Destroy current module and create a fresh one (initialized but not loaded)
    await module.destroy();

    const freshResult = createTestSwapModule();
    module = freshResult.module;
    mocks = freshResult.mocks;
    // Intentionally do NOT call module.load()

    const err = await module.getSwapStatus('any-id').catch(e => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('SWAP_NOT_INITIALIZED');
  });

  // =========================================================================
  // UT-SWAP-ERR-014: SWAP_MODULE_DESTROYED — operation after destroy()
  // =========================================================================

  it('UT-SWAP-ERR-014: SWAP_MODULE_DESTROYED on operation after destroy', async () => {
    await module.destroy();

    const err = await module.getSwapStatus('any-id').catch(e => e);
    expect(err).toBeInstanceOf(SphereError);
    expect(err.code).toBe('SWAP_MODULE_DESTROYED');
  });

  // =========================================================================
  // UT-SWAP-ERR-015: SWAP_NOT_INITIALIZED — operation before initialize()
  // =========================================================================

  it('UT-SWAP-ERR-015: SWAP_NOT_INITIALIZED on operation before initialize', async () => {
    // Create a raw module with no initialize() call
    await module.destroy();

    const rawModule = createSwapModule({ debug: false });
    // Do NOT call rawModule.initialize(deps)

    try {
      await rawModule.load();
      expect.fail('Expected SphereError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SphereError);
      expect((err as SphereError).code).toBe('SWAP_NOT_INITIALIZED');
    }
  });
});
