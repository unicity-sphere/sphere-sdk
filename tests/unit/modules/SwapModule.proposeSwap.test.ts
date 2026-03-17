/**
 * SwapModule.proposeSwap() unit tests.
 *
 * Test IDs: UT-SWAP-PROP-001 through UT-SWAP-PROP-019
 * @see docs/SWAP-TEST-SPEC.md section 3.2
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  createTestSwapModule,
  createTestSwapDeal,
  createTestSwapRef,
  injectSwapRef,
  DEFAULT_TEST_PARTY_A_ADDRESS,
  DEFAULT_TEST_PARTY_B_ADDRESS,
  DEFAULT_TEST_PARTY_B_TRANSPORT_PUBKEY,
  DEFAULT_TEST_ESCROW_ADDRESS,
  SphereError,
} from './swap-test-helpers.js';
import { computeSwapId } from '../../../modules/swap/manifest.js';
import type { SwapModule } from '../../../modules/swap/index.js';
import type { TestSwapModuleMocks } from './swap-test-helpers.js';

describe('SwapModule.proposeSwap()', () => {
  let module: SwapModule;
  let mocks: TestSwapModuleMocks;

  beforeEach(async () => {
    const ctx = createTestSwapModule();
    module = ctx.module;
    mocks = ctx.mocks;
    await module.load();
  });

  afterEach(async () => {
    try {
      await module.destroy();
    } catch {
      // ignore if already destroyed
    }
  });

  // =========================================================================
  // Happy path
  // =========================================================================

  it('UT-SWAP-PROP-001: valid deal creates SwapProposal with correct swap_id', async () => {
    const deal = createTestSwapDeal();
    const result = await module.proposeSwap(deal);

    // swap_id is 64-char lowercase hex
    expect(result.swapId).toMatch(/^[0-9a-f]{64}$/);

    // SwapRef is accessible via getSwaps
    const swaps = module.getSwaps();
    expect(swaps).toHaveLength(1);
    expect(swaps[0].swapId).toBe(result.swapId);
    expect(swaps[0].progress).toBe('proposed');
    expect(swaps[0].role).toBe('proposer');
  });

  it('UT-SWAP-PROP-002: swap_id is deterministic (same deal produces same ID)', () => {
    const fields1 = {
      party_a_address: DEFAULT_TEST_PARTY_A_ADDRESS,
      party_b_address: DEFAULT_TEST_PARTY_B_ADDRESS,
      party_a_currency_to_change: 'UCT',
      party_a_value_to_change: '1000000',
      party_b_currency_to_change: 'USDU',
      party_b_value_to_change: '500000',
      timeout: 300,
    };
    const fields2 = { ...fields1 };

    const id1 = computeSwapId(fields1);
    const id2 = computeSwapId(fields2);

    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('UT-SWAP-PROP-003: resolves @nametag addresses via deps.resolve()', async () => {
    const deal = createTestSwapDeal({
      partyA: '@alice',
      partyB: '@bob',
    });
    await module.proposeSwap(deal);

    // resolve called with @alice and @bob (plus escrow)
    const resolveArgs = mocks.resolve.mock.calls.map((c: unknown[]) => c[0]);
    expect(resolveArgs).toContain('@alice');
    expect(resolveArgs).toContain('@bob');
  });

  it('UT-SWAP-PROP-004: sends swap_proposal DM to counterparty', async () => {
    const deal = createTestSwapDeal();
    await module.proposeSwap(deal);

    // sendDM called with counterparty pubkey
    expect(mocks.communications.sendDM).toHaveBeenCalled();
    const [recipient, content] = mocks.communications.sendDM.mock.calls[0];
    expect(recipient).toBe(DEFAULT_TEST_PARTY_B_TRANSPORT_PUBKEY);

    // content is prefixed with 'swap_proposal:' followed by JSON
    expect(content).toMatch(/^swap_proposal:/);
    const jsonPart = content.replace(/^swap_proposal:/, '');
    const parsed = JSON.parse(jsonPart);
    expect(parsed.type).toBe('swap_proposal');
    expect(parsed.manifest).toBeDefined();
    expect(parsed.manifest.swap_id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('UT-SWAP-PROP-005: emits swap:proposed event', async () => {
    const deal = createTestSwapDeal();
    const result = await module.proposeSwap(deal);

    const proposedEvents = mocks.emitEvent._calls.filter(([type]) => type === 'swap:proposed');
    expect(proposedEvents).toHaveLength(1);

    const [, payload] = proposedEvents[0];
    expect((payload as { swapId: string }).swapId).toBe(result.swapId);
    expect((payload as { deal: unknown }).deal).toBeDefined();
    expect((payload as { recipientPubkey: string }).recipientPubkey).toBe(DEFAULT_TEST_PARTY_B_TRANSPORT_PUBKEY);
  });

  it('UT-SWAP-PROP-006: persists SwapRef with progress=proposed, role=proposer', async () => {
    const deal = createTestSwapDeal();
    const result = await module.proposeSwap(deal);

    // storage.set should have been called with the swap key
    expect(mocks.storage.set).toHaveBeenCalled();

    // Find the persisted swap data
    const storageKeys = Array.from(mocks.storage._data.keys());
    const swapKey = storageKeys.find((k) => k.includes(result.swapId));
    expect(swapKey).toBeDefined();

    const wrapper = JSON.parse(mocks.storage._data.get(swapKey!)!);
    // Storage wraps in { version: 1, swap: SwapRef }
    const persisted = wrapper.swap ?? wrapper;
    expect(persisted.swapId).toBe(result.swapId);
    expect(persisted.progress).toBe('proposed');
    expect(persisted.role).toBe('proposer');
    expect(persisted.createdAt).toBeTypeOf('number');
  });

  // =========================================================================
  // Validation: empty / invalid addresses
  // =========================================================================

  it('UT-SWAP-PROP-007: rejects empty partyA address (SWAP_INVALID_DEAL)', async () => {
    const deal = createTestSwapDeal({ partyA: '' });
    await expect(module.proposeSwap(deal)).rejects.toMatchObject({ code: 'SWAP_INVALID_DEAL' });
  });

  it('UT-SWAP-PROP-008: rejects empty partyB address', async () => {
    const deal = createTestSwapDeal({ partyB: '' });
    await expect(module.proposeSwap(deal)).rejects.toMatchObject({ code: 'SWAP_INVALID_DEAL' });
  });

  it('UT-SWAP-PROP-009: rejects same partyA and partyB address (self-swap)', async () => {
    // Both resolve to the same DIRECT address which is also our identity
    // Use a third-party address for both so the resolve returns the same directAddress
    const sameAddr = DEFAULT_TEST_PARTY_A_ADDRESS;
    const deal = createTestSwapDeal({ partyA: sameAddr, partyB: sameAddr });
    await expect(module.proposeSwap(deal)).rejects.toMatchObject({ code: 'SWAP_INVALID_DEAL' });
  });

  // =========================================================================
  // Validation: amounts
  // =========================================================================

  it('UT-SWAP-PROP-010: rejects non-positive amount (partyA)', async () => {
    const deal = createTestSwapDeal({ partyAAmount: '-100' });
    await expect(module.proposeSwap(deal)).rejects.toMatchObject({ code: 'SWAP_INVALID_DEAL' });
  });

  it('UT-SWAP-PROP-011: rejects zero amount (partyB)', async () => {
    const deal = createTestSwapDeal({ partyBAmount: '0' });
    await expect(module.proposeSwap(deal)).rejects.toMatchObject({ code: 'SWAP_INVALID_DEAL' });
  });

  // =========================================================================
  // Validation: currencies and timeout
  // =========================================================================

  it('UT-SWAP-PROP-012: rejects same currency for both parties', async () => {
    const deal = createTestSwapDeal({ partyACurrency: 'UCT', partyBCurrency: 'UCT' });
    await expect(module.proposeSwap(deal)).rejects.toMatchObject({ code: 'SWAP_INVALID_DEAL' });
  });

  it('UT-SWAP-PROP-013: rejects timeout less than 60 seconds', async () => {
    const deal = createTestSwapDeal({ timeout: 59 });
    await expect(module.proposeSwap(deal)).rejects.toMatchObject({ code: 'SWAP_INVALID_DEAL' });
  });

  it('UT-SWAP-PROP-014: rejects timeout greater than 86400 seconds', async () => {
    const deal = createTestSwapDeal({ timeout: 86401 });
    await expect(module.proposeSwap(deal)).rejects.toMatchObject({ code: 'SWAP_INVALID_DEAL' });
  });

  // =========================================================================
  // Validation: escrow address
  // =========================================================================

  it('UT-SWAP-PROP-015: rejects empty escrowAddress when no default configured', async () => {
    // Create module without defaultEscrowAddress
    const ctx = createTestSwapModule({ defaultEscrowAddress: undefined });
    await ctx.module.load();

    const deal = createTestSwapDeal({ escrowAddress: '' });
    // Empty string passes the typeof check but the resolve should fail or the fallback is empty
    // Actually, the deal has escrowAddress: '' which is falsy, so it falls back to config.defaultEscrowAddress
    // which is undefined, so it throws SWAP_INVALID_DEAL
    await expect(ctx.module.proposeSwap(deal)).rejects.toMatchObject({ code: 'SWAP_INVALID_DEAL' });
    await ctx.module.destroy();
  });

  // =========================================================================
  // Limit exceeded
  // =========================================================================

  it('UT-SWAP-PROP-016: rejects if maxPendingSwaps exceeded (SWAP_LIMIT_EXCEEDED)', async () => {
    const ctx = createTestSwapModule({ maxPendingSwaps: 2 });
    await ctx.module.load();

    // Inject 2 active swaps
    const ref1 = createTestSwapRef({
      deal: createTestSwapDeal({ partyAAmount: '111' }),
      progress: 'proposed',
    });
    const ref2 = createTestSwapRef({
      deal: createTestSwapDeal({ partyAAmount: '222' }),
      progress: 'proposed',
    });
    injectSwapRef(ctx.module, ref1);
    injectSwapRef(ctx.module, ref2);

    const newDeal = createTestSwapDeal({ partyAAmount: '333' });
    await expect(ctx.module.proposeSwap(newDeal)).rejects.toMatchObject({ code: 'SWAP_LIMIT_EXCEEDED' });
    await ctx.module.destroy();
  });

  // =========================================================================
  // Resolution failures
  // =========================================================================

  it('UT-SWAP-PROP-017: address resolution failure throws SWAP_RESOLVE_FAILED', async () => {
    // Make resolve return null for an unknown nametag
    const deal = createTestSwapDeal({ partyB: '@unknown_user' });
    await expect(module.proposeSwap(deal)).rejects.toMatchObject({ code: 'SWAP_RESOLVE_FAILED' });
  });

  // =========================================================================
  // DM send failure
  // =========================================================================

  it('UT-SWAP-PROP-018: DM send failure throws SWAP_DM_SEND_FAILED', async () => {
    mocks.communications.sendDM.mockRejectedValueOnce(new Error('network error'));

    const deal = createTestSwapDeal();
    await expect(module.proposeSwap(deal)).rejects.toMatchObject({ code: 'SWAP_DM_SEND_FAILED' });
  });

  // =========================================================================
  // Idempotency
  // =========================================================================

  it('UT-SWAP-PROP-019: duplicate swap_id is idempotent (returns existing, no extra DM)', async () => {
    const deal = createTestSwapDeal();

    const result1 = await module.proposeSwap(deal);
    const sendCallsBefore = mocks.communications.sendDM.mock.calls.length;

    const result2 = await module.proposeSwap(deal);

    // Same swap_id returned
    expect(result2.swapId).toBe(result1.swapId);

    // No additional DM sent
    expect(mocks.communications.sendDM.mock.calls.length).toBe(sendCallsBefore);

    // Still only 1 swap in the module
    expect(module.getSwaps()).toHaveLength(1);
  });
});
